/**
 * MINDVORA — SERVER-SIDE PAYMENT FULFILMENT  ·  lib/payments.js
 *
 * FIX: premium, verified badge, tips, gifts, airtime and data used to be
 * granted by the BROWSER after the payment popup said "success" — anyone could
 * call those Firestore updates (or the Husmodata endpoints) without paying,
 * and tips/gifts never reached the creator because the rules correctly block
 * writing another user's earnings.
 *
 * Now: the server confirms the payment with Paystack / NOWPayments itself,
 * checks the amount against lib/catalog.js, and applies the effect with
 * Firebase Admin. Each payment reference is fulfilled exactly once
 * (collection `processed_payments`, deny-by-default for clients).
 */
'use strict';

const { admin, db } = require('./firebase-admin');
const catalog = require('./catalog');
const husmo = require('./husmo');

const doFetch = (...a) => (globalThis.fetch ? globalThis.fetch(...a) : import('node-fetch').then((m) => m.default(...a)));
const FV = () => admin.firestore.FieldValue;
const round2 = (n) => Math.round(n * 100) / 100;

async function verifyPaystack(reference) {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) throw Object.assign(new Error('PAYSTACK_SECRET_KEY missing'), { code: 'PAYSTACK_NOT_CONFIGURED' });
  const resp = await doFetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok || !body.status || !body.data) {
    throw Object.assign(new Error(body.message || `Paystack verify ${resp.status}`), { code: 'PAYSTACK_VERIFY_FAILED' });
  }
  return body.data;
}

function parseMeta(m) {
  if (typeof m === 'string') { try { return JSON.parse(m); } catch (_) { return {}; } }
  return m && typeof m === 'object' ? m : {};
}

async function nameOf(uid) {
  try { const s = await db().collection('users').doc(uid).get(); return (s.exists && s.data().name) || 'Someone'; }
  catch (_) { return 'Someone'; }
}

async function notify(toUid, type, text, extra) {
  await db().collection('notifications').add({
    toUid, type, text, read: false, createdAt: FV().serverTimestamp(), ...(extra || {}),
  });
}

// 20% platform commission: one ledger row per earning (owner's revenue) + the earner's lastEarnedAt
// (drives the Earners leaderboard). Gross / fee / net are kept so the user can see the breakdown.
async function recordEarning({ earnerUid, payerUid, kind, gross, reference, provider }) {
  const fee = round2(gross * catalog.PLATFORM_FEE), net = round2(gross - fee);
  await db().collection('platform_ledger').add({ kind, earnerUid, payerUid: payerUid || '', gross: round2(gross), fee, net,
    reference: reference || '', provider: provider || '', createdAt: FV().serverTimestamp() });
  await db().collection('users').doc(earnerUid).set({ lastEarnedAt: FV().serverTimestamp(), grossEarnings: FV().increment(round2(gross)),
    feesPaid: FV().increment(fee) }, { merge: true });
  await db().collection('platform').doc('revenue').set({ commissionTotal: FV().increment(fee), updatedAt: FV().serverTimestamp() }, { merge: true });
  return { fee, net };
}

async function applyEffect({ uid, purpose, params, usd, provider, reference }) {
  const users = db().collection('users');
  const share = round2(usd * catalog.CREATOR_SHARE);

  switch (purpose) {
    case 'premium':
      await users.doc(uid).set({
        isPremium: true, plan: params.plan, premiumRef: reference, premiumProvider: provider,
        premiumSince: FV().serverTimestamp(),
      }, { merge: true });
      await notify(uid, 'premium', `💎 ${catalog.PLANS[params.plan].name} is now active. Thank you!`);
      return { granted: 'premium', plan: params.plan };

    case 'badge':
      await users.doc(uid).set({ isVerified: true, verifiedSince: FV().serverTimestamp(), verifiedRef: reference }, { merge: true });
      await notify(uid, 'verified', '✅ Your Mindvora Verified Badge has been activated!');
      return { granted: 'badge' };

    case 'tip': {
      const rid = params.recipientId;
      if (!(await users.doc(rid).get()).exists) throw new Error('Tip recipient not found');
      await users.doc(rid).update({ tips: FV().increment(share), earnings: FV().increment(share) });
      await recordEarning({ earnerUid: rid, payerUid: uid, kind: 'tip', gross: usd, reference, provider });
      const from = await nameOf(uid);
      await notify(rid, 'tip', `${from} sent you a $${usd} tip! 💰 You receive $${share} (20% Mindvora fee: $${round2(usd - share)})`, { fromUid: uid, fromName: from, gross: usd, fee: round2(usd - share), net: share });
      return { granted: 'tip', recipientId: rid, credited: share };
    }

    case 'gift': {
      const rid = params.recipientId;
      const g = catalog.GIFTS[params.gift];
      if (!(await users.doc(rid).get()).exists) throw new Error('Gift recipient not found');
      const from = await nameOf(uid);
      await users.doc(rid).update({ earnings: FV().increment(share) });
      await recordEarning({ earnerUid: rid, payerUid: uid, kind: 'gift', gross: usd, reference, provider });
      await db().collection('gifts').add({
        senderId: uid, senderName: from, hostId: rid, liveId: params.liveId || '',
        gift: params.gift, emoji: g.emoji, amount: usd, provider, reference, createdAt: FV().serverTimestamp(),
      });
      await notify(rid, 'gift', `${g.emoji} ${from} sent you a ${params.gift} ($${usd})! You receive $${share} after the 20% Mindvora fee.`, { fromUid: uid, fromName: from, gross: usd, fee: round2(usd - share), net: share });
      if (params.liveId) {
        await db().collection('live_streams').doc(params.liveId).collection('chat').add({
          uid, name: from, text: `${g.emoji} sent a ${params.gift}!`, isGift: true, createdAt: FV().serverTimestamp(),
        }).catch(() => {});
      }
      return { granted: 'gift', recipientId: rid, credited: share };
    }

    case 'airtime':
    case 'data': {
      const phone = husmo.normalizePhone(params.phone);
      const topRef = db().collection('topups').doc();
      const base = {
        uid, type: purpose, network: params.network, phone: phone || params.phone, ref: reference,
        provider, amountUSD: usd, createdAt: FV().serverTimestamp(),
      };
      if (!phone) {
        await topRef.set({ ...base, status: 'needs_refund', error: 'Invalid Nigerian phone number' });
        return { granted: purpose, delivery: 'failed', message: 'Invalid phone number — contact support for a refund.' };
      }
      // Test-mode Paystack payments are fake money — don't spend the real Husmodata wallet on them.
      if (provider === 'paystack' && /^sk_test_/.test(process.env.PAYSTACK_SECRET_KEY || '') &&
          process.env.HUSMO_ALLOW_IN_TEST !== 'true') {
        await topRef.set({ ...base, status: 'test_skipped', note: 'Paystack test mode — no real top-up sent' });
        return { granted: purpose, delivery: 'completed', test: true, message: 'Test payment OK (no real top-up is sent in test mode).' };
      }
      if (!husmo.configured()) {
        await topRef.set({ ...base, status: 'pending_manual', error: 'HUSMODATA_API_KEY missing' });
        return { granted: purpose, delivery: 'pending', message: 'Payment received. Delivery will be completed manually.' };
      }
      let res;
      if (purpose === 'airtime') {
        res = await husmo.buyAirtime({ network: params.network, phone, amountNGN: params.amountNGN });
        base.amountNGN = params.amountNGN;
      } else {
        const plan = await husmo.resolvePlanId(params.network, params.bundle);
        base.bundle = params.bundle;
        if (!plan.planId) {
          await topRef.set({ ...base, status: 'pending_manual', error: `No Husmodata plan id for ${params.network} ${params.bundle}` });
          console.error(`[HUSMO] No plan id for ${params.network} ${params.bundle}. Add it to HUSMO_PLAN_MAP.`);
          return { granted: purpose, delivery: 'pending', message: 'Payment received. Data will be delivered shortly.' };
        }
        base.planId = plan.planId;
        res = await husmo.buyData({ network: params.network, phone, planId: plan.planId });
      }
      await topRef.set({ ...base, status: res.status, husmo: JSON.parse(JSON.stringify(res.provider || {})) });
      return { granted: purpose, delivery: res.status };
    }
    default:
      throw new Error('Unknown purpose ' + purpose);
  }
}

/**
 * Fulfil a confirmed payment exactly once.
 * @returns {Promise<{already:boolean, result:object}>}
 */
async function fulfil({ provider, reference, uid, purpose, params, usd }) {
  const id = `${provider}_${String(reference).replace(/[^\w-]/g, '_')}`.slice(0, 200);
  const ref = db().collection('processed_payments').doc(id);

  const claimed = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) return { already: true, data: snap.data() };
    tx.set(ref, { provider, reference: String(reference), uid, purpose, params, usd, status: 'processing', createdAt: FV().serverTimestamp() });
    return { already: false };
  });
  if (claimed.already) return { already: true, result: claimed.data.result || { status: claimed.data.status } };

  try {
    const result = await applyEffect({ uid, purpose, params, usd, provider, reference });
    await ref.update({ status: 'fulfilled', result, fulfilledAt: FV().serverTimestamp() });
    console.log(`[PAY] Fulfilled ${provider} ${reference} ${purpose} for ${uid}`);
    return { already: false, result };
  } catch (err) {
    console.error(`[PAY] Fulfilment FAILED ${provider} ${reference}:`, err.message);
    await ref.update({ status: 'error', error: err.message }).catch(() => {});
    throw err;
  }
}

/** Confirm a Paystack reference and fulfil it. `expectUid` = logged-in user (or null for webhook). */
async function confirmPaystack(reference, expectUid) {
  const tx = await verifyPaystack(reference);
  if (tx.status !== 'success') return { ok: false, code: 'NOT_PAID', message: `Payment status is "${tx.status}".` };
  const meta = parseMeta(tx.metadata);
  const uid = meta.uid;
  if (!uid) return { ok: false, code: 'NO_METADATA', message: 'Payment has no Mindvora order attached.' };
  if (expectUid && uid !== expectUid) return { ok: false, code: 'WRONG_USER', message: 'This payment belongs to another account.' };
  const priced = catalog.priceOrder(meta.purpose, meta.params, uid);
  if (!priced.ok) return { ok: false, code: 'BAD_ORDER', message: priced.message };
  const expected = catalog.usdToKobo(priced.usd);
  if (String(tx.currency).toUpperCase() !== 'NGN' || Number(tx.amount) < expected - 100) {
    console.error(`[PAY] Amount mismatch on ${reference}: paid ${tx.amount} ${tx.currency}, expected ${expected} NGN kobo`);
    return { ok: false, code: 'AMOUNT_MISMATCH', message: 'Amount paid does not match the price.' };
  }
  const out = await fulfil({ provider: 'paystack', reference: tx.reference, uid, purpose: meta.purpose, params: priced.params, usd: priced.usd });
  return { ok: true, purpose: meta.purpose, ...out };
}

module.exports = { fulfil, confirmPaystack, verifyPaystack, parseMeta };
