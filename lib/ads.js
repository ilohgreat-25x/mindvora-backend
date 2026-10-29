/**
 * MINDVORA — ADS ENGINE  ·  lib/ads.js
 * Before: firestore.rules (correctly) block every client write to `ads`, so free ads could not be
 * submitted, paid ads charged the advertiser but never saved, and views/clicks were never counted.
 * Now everything runs on the server:
 *   - Free $0 ads: checked by auto-moderation, then go live straight away (owner can remove any time).
 *   - Paid ads: saved as "awaiting payment"; they serve ONLY after Paystack confirms the payment on the
 *     server (purpose 'ad' in lib/payments.js), and stop automatically at the exact purchased views.
 *     Views are unique real impressions: one per user per ad, advertiser's own views excluded.
 *   - Harmful content (scam/phishing/malware links, adult, violent, hate) is auto-rejected. A paid ad that
 *     is rejected is automatically refunded in full via the Paystack Refund API — exactly once.
 *   - Owner gets every ad event in real time: admin_events (admin panel) + WebSocket + push.
 */
'use strict';
const crypto = require('crypto');
const { admin, db } = require('./firebase-admin');

const doFetch = (...a) => (globalThis.fetch ? globalThis.fetch(...a) : import('node-fetch').then((m) => m.default(...a)));
const FV = () => admin.firestore.FieldValue;
const PACKAGES = { 5: 500, 10: 1200, 25: 3500, 50: 8000, 100: 20000, 250: 60000 };   // $ → views (same as the app)
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'ilohgreat25@gmail.com').toLowerCase();
let deps = { emit: () => 0, push: null };

// ── Moderation ────────────────────────────────────────────────────────────────────────────────
const BAD = [
  [/\b(porn|xxx|nude|nudes|onlyfans|escort|hookup|sex\s?(video|chat|cam)|camgirl|nsfw)\b/i, 'adult content'],
  [/\b(kill|murder|bomb|terror|shoot(ing)?\s+(up|them)|behead|massacre|gore)\b/i, 'violent content'],
  [/\b(nigger|faggot|kike|chink|tribalist|exterminate\s+\w+|hate\s+(all|every))\b/i, 'hate speech'],
  [/\b(double\s+your\s+(money|btc|crypto)|guaranteed\s+(profit|returns?)|ponzi|pyramid\s+scheme|investment\s+doubl|send\s+\w*\s*(btc|usdt)\s+(and|to)\s+get|giveaway.*(wallet|seed)|recovery\s+phrase|seed\s+phrase|bvn\s+update|verify\s+your\s+(bank|atm|bvn)|loan\s+without\s+(bvn|collateral)\s+instantly|hack(ed)?\s+(account|whatsapp)|fake\s+(id|documents?)|yahoo\s+boy|carding|cvv\s+shop)\b/i, 'scam / fraud'],
  [/\b(cocaine|heroin|meth|weed\s+for\s+sale|buy\s+guns?|firearms?\s+for\s+sale|ammo\s+for\s+sale)\b/i, 'illegal goods'],
  [/\b(free\s+download.*(crack|keygen)|apk\s+mod\s+premium|password\s+stealer|rat\s+tool|malware|ransomware)\b/i, 'malware'],
];
const SHORTENERS = /^(bit\.ly|tinyurl\.com|t\.co|goo\.gl|is\.gd|cutt\.ly|rb\.gy|ow\.ly|shorturl\.at|tiny\.cc|s\.id|rebrand\.ly|bl\.ink|buff\.ly|t\.ly|v\.gd|qr\.ae)$/i;
const BAD_TLD = /\.(zip|mov|xyz|top|click|gq|ml|cf|tk|ga|work|rest|cam|loan|kim|country|stream|download|racing|win|bid)$/i;
const PHISH = /(paypa1|app1e|faceb00k|g00gle|micros0ft|whatsap+-|-login|login-|verify-account|account-verify|secure-update|wallet-connect|walletconnect-|metamask-|binance-|opay-?verify|palmpay-?verify|gtbank-|firstbank-|zenith-?bank-|accessbank-|uba-)/i;

function checkUrl(raw) {
  if (!raw) return null;
  let u; try { u = new URL(raw); } catch (_) { return 'invalid link'; }
  if (u.protocol !== 'https:') return 'link is not secure (https required)';
  const h = u.hostname.toLowerCase();
  if (u.username || u.password || raw.includes('@')) return 'deceptive link';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(':')) return 'link points to a raw IP address';
  if (h.startsWith('xn--') || h.includes('.xn--')) return 'disguised (punycode) link';
  if (SHORTENERS.test(h)) return 'link shortener hides the real destination';
  if (BAD_TLD.test(h)) return 'high-risk website domain';
  if (PHISH.test(h) || PHISH.test(u.pathname)) return 'looks like a phishing / fake-login link';
  if (/\.(apk|exe|scr|bat|msi|dmg|jar|vbs|ps1)(\?|$)/i.test(u.pathname)) return 'link downloads an app/file directly';
  return null;
}
async function urlReachable(raw) {   // a phishing/malware page that doesn't even resolve is suspicious
  if (!raw) return null;
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 7000);
    const r = await doFetch(raw, { method: 'GET', redirect: 'follow', signal: ctl.signal, headers: { 'User-Agent': 'MindvoraAdCheck/1.0' } });
    clearTimeout(t);
    if (r.url && r.url !== raw) { const again = checkUrl(r.url); if (again) return 'link redirects to a ' + again.replace(/^link /, ''); }
    return null;
  } catch (_) { return null; }   // unreachable ≠ malicious; don't punish slow sites
}
async function aiCheck(text) {
  try {
    const aria = require('./aria');
    const out = await Promise.race([
      aria.generate([{ role: 'system', content: 'You are an ad safety reviewer. Reply ONLY with JSON {"safe":true|false,"reason":"short reason"}. Unsafe = scam/fraud, phishing, malware, adult/sexual, violent, hateful, illegal goods or drugs. Normal business ads are safe.' },
        { role: 'user', content: text.slice(0, 1500) }]),
      new Promise((r) => setTimeout(() => r(null), 9000)),
    ]);
    const s = typeof out === 'string' ? out : (out && (out.text || out.content)) || '';
    const m = s.match(/\{[\s\S]*\}/); if (!m) return null;
    const j = JSON.parse(m[0]);
    return j && j.safe === false ? (String(j.reason || 'unsafe content').slice(0, 120)) : null;
  } catch (_) { return null; }
}
async function moderate(ad, { deep = true } = {}) {
  const text = [ad.title, ad.description, ad.cta, ad.url].join(' ');
  for (const [re, why] of BAD) if (re.test(text)) return why;
  const u = checkUrl(ad.url); if (u) return u;
  if (!deep) return null;
  return (await urlReachable(ad.url)) || (await aiCheck(`Title: ${ad.title}\nText: ${ad.description}\nButton: ${ad.cta}\nLink: ${ad.url || 'none'}`));
}

// ── Owner + advertiser notifications ─────────────────────────────────────────────────────────
let adminUidCache = null;
async function adminUid() {
  if (adminUidCache) return adminUidCache;
  try { const u = await admin.auth().getUserByEmail(ADMIN_EMAIL); adminUidCache = u.uid; } catch (_) {}
  return adminUidCache;
}
async function ownerEvent(kind, ad, extra) {
  const text = {
    submitted: `📣 New ${ad.type} ad submitted by ${ad.advertiserName}: "${ad.title}"`,
    paid: `💳 Payment confirmed for "${ad.title}" — $${ad.budget} (${ad.impressionsTarget} views)`,
    approved: `✅ Ad approved and live: "${ad.title}"`,
    rejected: `⛔ Ad auto-rejected: "${ad.title}" — ${extra && extra.reason}`,
    refunded: `↩️ Refund issued for "${ad.title}" — $${ad.budget} back to ${ad.advertiserName}`,
    refund_failed: `⚠️ REFUND FAILED for "${ad.title}" ($${ad.budget}, ref ${ad.ref}) — ${extra && extra.error}. Refund manually in Paystack.`,
    completed: `🏁 Ad finished: "${ad.title}" reached all ${ad.impressionsTarget} views`,
    removed: `🗑️ Ad removed by admin: "${ad.title}"`,
  }[kind] || kind;
  await db().collection('admin_events').add({ kind, text, adId: ad.id || '', advertiserId: ad.advertiserId || '', ...(extra || {}),
    read: false, createdAt: FV().serverTimestamp() }).catch((e) => console.error('[ADS] admin_events', e.message));
  const a = await adminUid();
  if (a) {
    try { deps.emit(a, { type: 'ADMIN_EVENT', kind, text, adId: ad.id || '' }); } catch (_) {}
    if (deps.push && /rejected|refund|paid|submitted/.test(kind)) deps.push.sendToUser(a, { title: 'Mindvora Admin', body: text, type: 'admin', tag: 'ad-' + (ad.id || ''), url: '/?action=admin' }).catch(() => {});
  }
  console.log('[ADS]', text);
}
async function tellAdvertiser(ad, text) {
  await db().collection('notifications').add({ toUid: ad.advertiserId, type: 'ad_status', text, adId: ad.id || '', read: false,
    createdAt: FV().serverTimestamp() }).catch(() => {});   // push watcher turns this into a phone notification
  try { deps.emit(ad.advertiserId, { type: 'RT_NOTIF', ntype: 'ad_status', text, adId: ad.id }); } catch (_) {}
}

// ── Refund (idempotent: claimed inside a transaction, never twice) ───────────────────────────
async function refund(adId, reason) {
  const ref = db().collection('ads').doc(adId);
  const claim = await db().runTransaction(async (tx) => {
    const s = await tx.get(ref); if (!s.exists) return null;
    const a = s.data();
    if (a.type !== 'paid' || !a.ref || !a.paid) return null;
    if (a.refund && ['processing', 'done'].includes(a.refund.status)) return null;
    tx.update(ref, { refund: { status: 'processing', reason, startedAt: Date.now() } });
    return { id: adId, ...a };
  });
  if (!claim) return { skipped: true };
  try {
    const r = await doFetch('https://api.paystack.co/refund', { method: 'POST',
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ transaction: claim.ref, merchant_note: 'Mindvora ad auto-rejected: ' + reason, customer_note: 'Your Mindvora ad was not approved: ' + reason }) });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || !body.status) throw new Error(body.message || ('Paystack refund ' + r.status));
    await ref.update({ refund: { status: 'done', reason, paystackRefundId: (body.data && body.data.id) || '', refundStatus: (body.data && body.data.status) || '', at: FV().serverTimestamp() } });
    await ownerEvent('refunded', claim);
    await tellAdvertiser(claim, `↩️ Your ad "${claim.title}" was not approved (${reason}). Your $${claim.budget} has been refunded to your card/bank — it can take a few business days to show.`);
    return { ok: true };
  } catch (e) {
    const already = /already\s+(been\s+)?(fully\s+)?refunded/i.test(e.message);
    await ref.update({ refund: { status: already ? 'done' : 'failed', reason, error: e.message, at: FV().serverTimestamp() } });
    if (!already) { await ownerEvent('refund_failed', claim, { error: e.message }); await tellAdvertiser(claim, `Your ad "${claim.title}" was not approved (${reason}). Your refund is being processed by Mindvora support.`); }
    return { ok: already, error: e.message };
  }
}

async function refundCharge(reference, reason, ad) {
  const paymentRef = String(reference || '').trim();
  if (!paymentRef) return { ok: false, manual: true, error: 'Missing Paystack transaction reference.' };
  const marker = db().collection('ad_charge_refunds').doc(crypto.createHash('sha256').update(paymentRef).digest('hex'));
  const claim = await db().runTransaction(async (tx) => {
    const snap = await tx.get(marker);
    if (snap.exists && snap.data().status === 'done') return { already: true };
    if (snap.exists && snap.data().status === 'processing') return { busy: true };
    tx.set(marker, { reference: paymentRef, status: 'processing', reason: String(reason || '').slice(0, 160), updatedAt: FV().serverTimestamp() }, { merge: true });
    return { claimed: true };
  });
  if (claim.already) return { ok: true, already: true };
  if (claim.busy) return { ok: false, inProgress: true };
  try {
    const response = await doFetch('https://api.paystack.co/refund', { method: 'POST',
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ transaction: paymentRef, merchant_note: 'Mindvora ad charge reconciliation: ' + String(reason || '').slice(0, 140), customer_note: 'Your Mindvora ad charge is being refunded because the campaign could not run.' }) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.status) throw new Error(result.message || ('Paystack refund ' + response.status));
    await marker.set({ status: 'done', paystackRefundId: (result.data && result.data.id) || '', completedAt: FV().serverTimestamp() }, { merge: true });
    if (ad) {
      await db().collection('ads').doc(ad.id).set({ lastAdChargeRefund: { reference: paymentRef, status: 'done', at: FV().serverTimestamp() } }, { merge: true }).catch(() => {});
      await tellAdvertiser(ad, `A Mindvora ad charge was refunded because the campaign could not run. It may take a few business days to appear.`);
    }
    return { ok: true };
  } catch (error) {
    await marker.set({ status: 'failed', error: String(error.message || error).slice(0, 240), updatedAt: FV().serverTimestamp() }, { merge: true }).catch(() => {});
    const report = ad || { id: '', advertiserId: '' };
    await ownerEvent('refund_failed', report, { error: error.message || 'Recurring ad refund failed.', reference: paymentRef });
    if (ad) await tellAdvertiser(ad, 'A Mindvora ad charge could not be refunded automatically. Our team has been alerted to review it.');
    return { ok: false, error: error.message || 'Refund failed.' };
  }
}

// ── Called by lib/payments.js once Paystack confirms the payment for purpose 'ad' ────────────
async function onPaid({ uid, params, reference, usd }) {
  const ref = db().collection('ads').doc(params.adId);
  const s = await ref.get();
  if (!s.exists || s.data().advertiserId !== uid) throw new Error('Ad not found for this payment');
  const ad = { id: s.id, ...s.data() };
  await ref.update({ paid: true, paidUSD: usd, ref: reference, paidAt: FV().serverTimestamp(), status: 'reviewing' });
  Object.assign(ad, { paid: true, ref: reference });
  await ownerEvent('paid', ad);
  const why = await moderate(ad);
  if (why) {
    await ref.update({ status: 'rejected', rejectReason: why, rejectedBy: 'auto', rejectedAt: FV().serverTimestamp() });
    await ownerEvent('rejected', ad, { reason: why });
    const r = await refund(ad.id, why);
    return { granted: 'ad', adId: ad.id, status: 'rejected', reason: why, refund: r.ok ? 'issued' : 'pending' };
  }
  await ref.update({ status: 'active', approvedBy: 'auto', approvedAt: FV().serverTimestamp() });
  await ownerEvent('approved', ad);
  await tellAdvertiser(ad, `🚀 Your ad "${ad.title}" is live! It will be shown to ${ad.impressionsTarget.toLocaleString()} unique people.`);
  return { granted: 'ad', adId: ad.id, status: 'active', views: ad.impressionsTarget };
}

async function onRecurringPaid({ uid, params, reference, usd }) {
  const adId = String(params && params.adId || '');
  const ref = db().collection('ads').doc(adId), snap = await ref.get();
  if (!snap.exists || snap.data().advertiserId !== uid) {
    const refunded = await refundCharge(reference, 'ad campaign is missing or belongs to another account', null);
    return { rejected: true, refund: refunded.ok ? 'issued' : 'manual_review' };
  }
  const ad = { id: snap.id, ...snap.data() };
  const eligible = ad.autoRenewConsent === true && ad.status === 'awaiting_payment' && !ad.paid && Number(ad.budget) === Number(params.budget);
  if (!eligible) {
    const reason = 'ad campaign is no longer eligible for its initial recurring charge';
    if (!ad.paid) await ref.update({ paid: true, paidUSD: usd, ref: reference, paidAt: FV().serverTimestamp() });
    const latest = (await ref.get()).data() || {};
    const refunded = latest.ref === reference ? await refund(ad.id, reason) : await refundCharge(reference, reason, ad);
    const billing = require('./subscriptions');
    if (refunded.ok || (latest.refund && latest.refund.status === 'done')) await billing.markAdSubscriptionRefunded(ad.id).catch(() => {});
    const cancellation = await billing.disableAdSubscription(ad.id).catch(() => ({ ok: false }));
    await ref.set({ recurringCancellationFailed: !cancellation.ok }, { merge: true }).catch(() => {});
    return { rejected: true, refund: refunded.ok ? 'issued' : 'manual_review', cancellationPending: !cancellation.ok };
  }
  await ref.update({ paid: true, paidUSD: usd, ref: reference, paidAt: FV().serverTimestamp(), status: 'reviewing', recurring: true });
  const why = await moderate(ad);
  if (why) {
    await ref.update({ status: 'rejected', rejectReason: why, rejectedBy: 'auto', rejectedAt: FV().serverTimestamp() });
    const refundResult = await refund(ad.id, why);
    const billing = require('./subscriptions');
    if (refundResult.ok) await billing.markAdSubscriptionRefunded(ad.id).catch(() => {});
    const cancellation = await billing.disableAdSubscription(ad.id).catch(() => ({ ok: false }));
    if (!cancellation.ok) await ref.set({ recurringCancellationFailed: true }, { merge: true }).catch(() => {});
    return { rejected: true, refund: refundResult.ok ? 'issued' : 'pending', cancellationPending: !cancellation.ok };
  }
  await ref.update({ status: 'active', approvedBy: 'auto', approvedAt: FV().serverTimestamp() });
  await ownerEvent('paid', ad); await tellAdvertiser(ad, `Your ad "${ad.title}" is now live.`);
  return { granted: 'ad_subscription', adId: ad.id, views: ad.impressionsTarget };
}

async function onRecurringInvoice({ record, data }) {
  const transaction = data && data.transaction || {};
  const periodValue = data.period_start || data.periodStart || data.period_end || data.periodEnd || data.next_payment_date || record.currentPeriodEnd;
  const numericPeriod = typeof periodValue === 'number' || (typeof periodValue === 'string' && /^\d+(?:\.\d+)?$/.test(periodValue))
    ? Number(periodValue) : NaN;
  const normalizedPeriod = Number.isFinite(numericPeriod) ? (numericPeriod < 1e12 ? numericPeriod * 1000 : numericPeriod) : periodValue;
  const periodDate = normalizedPeriod && typeof normalizedPeriod.toDate === 'function' ? normalizedPeriod.toDate() : new Date(normalizedPeriod);
  const periodMs = periodDate && Number.isFinite(periodDate.getTime()) ? periodDate.getTime() : NaN;
  const views = Number(record.views);
  const rawRef = data.invoice_code || data.transaction_reference || transaction.reference || data.reference;
  const invoiceRef = String(rawRef || (Number.isFinite(periodMs) ? 'period-' + record.subscriptionCode + '-' + periodMs : ''));
  if (!invoiceRef || !Number.isFinite(periodMs) || !Number.isSafeInteger(views) || views <= 0) throw new Error('Recurring ad invoice is missing a verifiable billing period or view tier.');
  const id = 'ad_invoice_' + crypto.createHash('sha256').update(invoiceRef).digest('hex');
  const marker = db().collection('processed_payments').doc(id);
  return db().runTransaction(async (tx) => {
    const adRef = record.adId ? db().collection('ads').doc(String(record.adId)) : null;
    const [markerSnap, adSnap] = await Promise.all([tx.get(marker), adRef ? tx.get(adRef) : Promise.resolve(null)]);
    if (markerSnap.exists) {
      const previous = markerSnap.data() || {};
      if (previous.status === 'pending_resolution') return { eligible: false, needsResolution: true, invoiceRef, reason: previous.reason || 'campaign_not_eligible' };
      return { eligible: true, duplicate: true, invoiceRef };
    }
    const ad = adSnap && adSnap.exists ? adSnap.data() || {} : {};
    const eligible = !!(adSnap && adSnap.exists) && ad.advertiserId === record.uid && ad.type === 'paid' && ad.recurring === true
      && ['active', 'completed'].includes(ad.status) && !(ad.refund && ['processing', 'done'].includes(ad.refund.status));
    if (!eligible) {
      const reason = 'campaign_not_eligible';
      tx.set(marker, { provider: 'paystack', reference: invoiceRef, uid: record.uid, purpose: 'ad_subscription_invoice', periodStartMs: periodMs, status: 'pending_resolution', reason, createdAt: FV().serverTimestamp() });
      return { eligible: false, needsResolution: true, invoiceRef, reason };
    }
    const lastPeriod = Number(ad.lastRecurringInvoicePeriodStartMs || 0);
    if (periodMs <= lastPeriod) {
      tx.set(marker, { provider: 'paystack', reference: invoiceRef, uid: record.uid, purpose: 'ad_subscription_invoice', periodStartMs: periodMs, status: 'skipped', reason: 'out_of_order_invoice', createdAt: FV().serverTimestamp() });
      return { eligible: true, duplicate: true, invoiceRef, ignored: true };
    }
    const paymentReference = String(data.transaction_reference || transaction.reference || '').trim();
    tx.update(adSnap.ref, { impressionsTarget: FV().increment(views), lastRecurringInvoiceRef: invoiceRef,
      lastRecurringInvoicePeriodStartMs: periodMs, ...(paymentReference ? { lastRecurringPaymentRef: paymentReference } : {}),
      ...(ad.status === 'completed' ? { status: 'active', reactivatedAt: FV().serverTimestamp() } : {}) });
    tx.set(marker, { provider: 'paystack', reference: invoiceRef, uid: record.uid, purpose: 'ad_subscription_invoice', periodStartMs: periodMs, status: 'fulfilled', createdAt: FV().serverTimestamp() });
    return { eligible: true, duplicate: false, invoiceRef, addedViews: views };
  });
}

async function refundRecurringInvoice({ record, data, reason }) {
  const transaction = data && data.transaction || {};
  const reference = String(data.transaction_reference || transaction.reference || data.reference || '').trim();
  const adSnap = record.adId ? await db().collection('ads').doc(String(record.adId)).get() : null;
  const ad = adSnap && adSnap.exists ? { id: adSnap.id, ...adSnap.data() } : null;
  if (!reference) {
    await ownerEvent('refund_failed', ad || { id: record.adId || '', advertiserId: record.uid }, { error: 'A paid ad invoice was ineligible, but Paystack supplied no transaction reference for automatic refund.', subscriptionCode: record.subscriptionCode });
    if (ad) await tellAdvertiser(ad, 'An ad renewal was charged after the campaign became unavailable. Our team has been alerted to review the payment.');
    return { ok: false, manual: true };
  }
  return refundCharge(reference, reason || 'ad campaign is no longer eligible', ad);
}

async function finishRecurringInvoiceResolution(invoiceRef, details) {
  const id = 'ad_invoice_' + crypto.createHash('sha256').update(String(invoiceRef)).digest('hex');
  await db().collection('processed_payments').doc(id).set({ status: 'resolved', resolution: details || {}, resolvedAt: FV().serverTimestamp() }, { merge: true });
}
function clean(v, n) { return String(v || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n); }
function readAd(b) { return { title: clean(b.title, 80), description: clean(b.description, 300), cta: clean(b.cta, 30), url: clean(b.url, 500), emoji: clean(b.emoji, 8) }; }

function mount(app, { requireUser, emit, push }) {
  deps = { emit: emit || deps.emit, push: push || null };
  const isOwner = (req) => req.user && req.user.email_verified === true && String(req.user.email || '').trim().toLowerCase() === ADMIN_EMAIL;
  async function profile(uid) { const s = await db().collection('users').doc(uid).get(); return s.exists ? s.data() : {}; }

  app.post('/api/ads/free', requireUser, async (req, res) => {
    try {
      const f = readAd(req.body || {});
      if (!f.title || !f.description || !f.cta) return res.status(400).json({ ok: false, message: 'Title, description and button text are required.' });
      const p = await profile(req.user.uid);
      const ad = { type: 'free', ...f, emoji: f.emoji || '📣', advertiserId: req.user.uid, advertiserName: p.name || 'Mindvora user', advertiserHandle: p.handle || 'user',
        views: 0, clicks: 0, budget: 0, impressionsTarget: 0, createdAt: FV().serverTimestamp() };
      const why = await moderate(ad);
      ad.status = why ? 'rejected' : 'active';
      if (why) Object.assign(ad, { rejectReason: why, rejectedBy: 'auto' }); else ad.approvedBy = 'auto';
      const doc = await db().collection('ads').add(ad); ad.id = doc.id;
      await ownerEvent('submitted', ad);
      await ownerEvent(why ? 'rejected' : 'approved', ad, why ? { reason: why } : undefined);
      res.json(why ? { ok: false, status: 'rejected', message: `Your ad was rejected: ${why}.` } : { ok: true, status: 'active', adId: doc.id });
    } catch (e) { console.error('[ADS] free', e); res.status(500).json({ ok: false, message: 'Could not submit the ad. Try again.' }); }
  });

  // Step 1 of a paid ad: save the ad (not served) and quick-check it BEFORE charging,
  // so obviously harmful ads are refused without taking money (Paystack keeps its fee on refunds).
  app.post('/api/ads/paid/draft', requireUser, async (req, res) => {
    try {
      const f = readAd(req.body || {}); const budget = Number(req.body && req.body.budget);
      if (!PACKAGES[budget]) return res.status(400).json({ ok: false, message: 'Pick an ad package.' });
      if (!f.title || !f.description || !f.cta) return res.status(400).json({ ok: false, message: 'Title, description and button text are required.' });
      const why = await moderate(f, { deep: false });
      if (why) return res.status(400).json({ ok: false, status: 'rejected', message: `This ad can't run: ${why}. You have not been charged.` });
      const p = await profile(req.user.uid);
      const ad = { type: 'paid', autoRenewConsent: req.body && req.body.autoRenewConsent === true, ...f, emoji: f.emoji || '⚡', advertiserId: req.user.uid, advertiserName: p.name || 'Mindvora user', advertiserHandle: p.handle || 'user',
        status: 'awaiting_payment', paid: false, views: 0, clicks: 0, budget, impressionsTarget: PACKAGES[budget], createdAt: FV().serverTimestamp() };
      const doc = await db().collection('ads').add(ad); ad.id = doc.id;
      await ownerEvent('submitted', ad);
      res.json({ ok: true, adId: doc.id, budget, views: PACKAGES[budget] });
    } catch (e) { console.error('[ADS] draft', e); res.status(500).json({ ok: false, message: 'Could not create the ad. Try again.' }); }
  });

  // One real, unique impression per user per ad. Paid ads stop exactly at their purchased views.
  app.post('/api/ads/impression', requireUser, async (req, res) => {
    const adId = clean(req.body && req.body.adId, 64); const uid = req.user.uid;
    if (!adId) return res.status(400).json({ ok: false });
    try {
      const ref = db().collection('ads').doc(adId), vref = ref.collection('viewers').doc(uid);
      const out = await db().runTransaction(async (tx) => {
        const [s, v] = await Promise.all([tx.get(ref), tx.get(vref)]);
        if (!s.exists) return { counted: false, reason: 'gone' };
        const a = s.data();
        if (a.status !== 'active') return { counted: false, reason: a.status };
        if (a.advertiserId === uid || v.exists) return { counted: false, reason: 'not-unique' };
        const views = (a.views || 0) + 1;
        tx.set(vref, { at: FV().serverTimestamp() });
        const upd = { views };
        const done = a.type === 'paid' && a.impressionsTarget && views >= a.impressionsTarget;
        if (done) Object.assign(upd, { status: 'completed', completedAt: FV().serverTimestamp() });
        tx.update(ref, upd);
        return { counted: true, views, done, ad: { id: adId, ...a } };
      });
      if (out.done) { await ownerEvent('completed', out.ad); await tellAdvertiser(out.ad, `🏁 Your ad "${out.ad.title}" reached all ${out.ad.impressionsTarget.toLocaleString()} views and has finished.`); }
      res.json({ ok: true, counted: out.counted, stop: out.done || ['completed', 'rejected', 'gone', 'removed'].includes(out.reason) });
    } catch (e) { res.status(500).json({ ok: false }); }
  });

  app.post('/api/ads/click', requireUser, async (req, res) => {
    const adId = clean(req.body && req.body.adId, 64);
    try {
      const ref = db().collection('ads').doc(adId), cref = ref.collection('clickers').doc(req.user.uid);
      await db().runTransaction(async (tx) => {
        const [s, c] = await Promise.all([tx.get(ref), tx.get(cref)]);
        if (!s.exists || c.exists || s.data().advertiserId === req.user.uid) return;
        tx.set(cref, { at: FV().serverTimestamp() }); tx.update(ref, { clicks: FV().increment(1) });
      });
      res.json({ ok: true });
    } catch (_) { res.json({ ok: false }); }
  });

  // Owner actions from the admin panel (the old client writes were blocked by the rules).
  app.post('/api/admin/ads/:id/:action', requireUser, async (req, res) => {
    if (!isOwner(req)) return res.status(403).json({ ok: false, message: 'Admin only' });
    const ref = db().collection('ads').doc(req.params.id); const s = await ref.get();
    if (!s.exists) return res.status(404).json({ ok: false, message: 'Ad not found' });
    const ad = { id: s.id, ...s.data() };
    if (req.params.action === 'approve') {
      if (ad.type === 'paid' && !ad.paid) return res.status(400).json({ ok: false, message: 'This paid ad has not been paid for.' });
      await ref.update({ status: 'active', approvedBy: ADMIN_EMAIL, approvedAt: FV().serverTimestamp() });
      await tellAdvertiser(ad, `✅ Your ad "${ad.title}" is now live!`);
      return res.json({ ok: true });
    }
    if (req.params.action === 'reject') {
      const reason = clean(req.body && req.body.reason, 140) || 'did not meet Mindvora ad guidelines';
      await ref.update({ status: 'rejected', rejectReason: reason, rejectedBy: ADMIN_EMAIL, rejectedAt: FV().serverTimestamp() });
      await ownerEvent('removed', ad);
      const cancellation = ad.recurring || ad.subscriptionCode ? await require('./subscriptions').disableAdSubscription(ad.id).catch(() => ({ ok: false })) : { ok: true };
      if (ad.type === 'paid' && ad.paid) {
        const r = ad.recurring && ad.lastRecurringPaymentRef
          ? await refundCharge(ad.lastRecurringPaymentRef, reason, ad)
          : await refund(ad.id, reason);
        if (r.ok && (ad.recurring || ad.subscriptionCode)) await require('./subscriptions').markAdSubscriptionRefunded(ad.id).catch(() => {});
        return res.json({ ok: true, refund: r.ok ? 'issued' : (r.skipped ? 'already' : 'failed'), cancellationPending: !cancellation.ok });
      }
      await tellAdvertiser(ad, `Your ad "${ad.title}" was not approved: ${reason}.`);
      return res.json({ ok: true, cancellationPending: !cancellation.ok });
    }
    if (req.params.action === 'refund') { const r = await refund(ad.id, clean(req.body && req.body.reason, 140) || 'refund by admin'); return res.json({ ok: !!r.ok, ...r }); }
    res.status(400).json({ ok: false });
  });
  console.log('📣 Ads engine mounted (server-verified payments, unique views, auto-moderation, auto-refund)');
}

module.exports = { mount, onPaid, onRecurringPaid, onRecurringInvoice, refundRecurringInvoice, finishRecurringInvoiceResolution, refund, moderate, checkUrl, PACKAGES };
