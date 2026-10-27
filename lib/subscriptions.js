'use strict';

const crypto = require('crypto');
const catalog = require('./catalog');
const { admin, db, firebaseAdminConfigured } = require('./firebase-admin');

const doFetch = (...args) => globalThis.fetch
  ? globalThis.fetch(...args)
  : import('node-fetch').then((m) => m.default(...args));
const DAY_MS = 24 * 60 * 60 * 1000;
const PLAN_CACHE = new Map();

function fv() { return admin.firestore.FieldValue; }
function secret() { return process.env.PAYSTACK_SECRET_KEY || ''; }
function asDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value.toDate === 'function') return value.toDate();
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}
function normalizeEmail(value) { return String(value || '').trim().toLowerCase(); }
function isEmail(value) { return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }
function emailHash(value) { return crypto.createHash('sha256').update(normalizeEmail(value)).digest('hex'); }
function userRef(uid) { return db().collection('users').doc(uid); }
function planRef(planId) { return db().collection('billing_plan_codes').doc(planId); }
function intentRef(uid) { return db().collection('billing_subscription_intents').doc(uid); }
function checkoutRef(reference) { return db().collection('billing_subscription_checkout_refs').doc(reference); }
function subscriptionRef(code) { return db().collection('billing_subscriptions').doc(code); }
function billingEmailLockRef(email) { return db().collection('billing_subscription_email_locks').doc(emailHash(email)); }
function paystackCustomerRef(customerCode) {
  return db().collection('billing_paystack_customers').doc(emailHash(String(customerCode || '')));
}

async function paystackRequest(path, method, body) {
  if (!secret()) throw Object.assign(new Error('Paystack recurring billing is not configured.'), { status: 503 });
  const response = await doFetch('https://api.paystack.co' + path, {
    method: method || 'GET',
    headers: { Authorization: 'Bearer ' + secret(), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.status) {
    throw Object.assign(new Error(result.message || 'Paystack request failed.'), { status: response.status || 502 });
  }
  return result.data;
}

async function createOrGetPlan(planId) {
  const plan = catalog.PLANS[planId];
  if (!plan) throw Object.assign(new Error('Choose a valid Premium plan.'), { status: 400 });
  const amountKobo = catalog.usdToKobo(plan.usd);
  const cached = PLAN_CACHE.get(planId);
  if (cached) return cached;
  const pending = (async function () {
    const ref = planRef(planId);
    const snap = await ref.get();
    const saved = snap.exists ? snap.data() : {};
    if (saved.planCode && Number(saved.amountKobo) === amountKobo && saved.interval === 'monthly' && saved.currency === 'NGN') return saved.planCode;
    const created = await paystackRequest('/plan', 'POST', {
      name: 'Mindvora ' + plan.name + ' - Monthly Auto-renew',
      amount: amountKobo,
      currency: 'NGN',
      interval: 'monthly',
      send_invoices: true
    });
    if (!created || !created.plan_code) throw new Error('Paystack did not return a monthly plan code.');
    await ref.set({ planCode: created.plan_code, amountKobo, currency: 'NGN', interval: 'monthly', updatedAt: fv().serverTimestamp() });
    return created.plan_code;
  }());
  PLAN_CACHE.set(planId, pending);
  try {
    const code = await pending;
    PLAN_CACHE.set(planId, code);
    return code;
  } catch (error) {
    PLAN_CACHE.delete(planId);
    throw error;
  }
}

async function recordsForUser(uid) {
  const snap = await db().collection('billing_subscriptions').where('uid', '==', uid).get();
  return snap.docs.map((doc) => Object.assign({ subscriptionCode: doc.id }, doc.data()));
}
function recordEndMs(record) {
  const date = asDate(record && (record.currentPeriodEnd || record.nextPaymentDate));
  return date ? date.getTime() : 0;
}
function isManageable(record, now) {
  const status = String(record && record.status || '').toLowerCase();
  return ['active', 'attention', 'non-renewing', 'non_renewing'].includes(status)
    && (!recordEndMs(record) || recordEndMs(record) > now);
}
async function latestManageableSubscription(uid) {
  const records = await recordsForUser(uid);
  const now = Date.now();
  return records.filter((r) => isManageable(r, now)).sort((a, b) => recordEndMs(b) - recordEndMs(a))[0] || null;
}

async function reconcilePremiumExpiry(uid) {
  const ref = userRef(uid);
  const snap = await ref.get();
  const profile = snap.exists ? snap.data() || {} : {};
  const end = asDate(profile.premiumExpiresAt);
  if (profile.isPremium === true && end && end.getTime() <= Date.now()) {
    await ref.set({ isPremium: false, plan: 'free', premiumExpiredAt: fv().serverTimestamp() }, { merge: true });
    return Object.assign({}, profile, { isPremium: false, plan: 'free' });
  }
  return profile;
}

function publicSubscription(record) {
  if (!record) return null;
  const plan = catalog.PLANS[record.planId] || {};
  const end = asDate(record.currentPeriodEnd || record.nextPaymentDate);
  return {
    planId: record.planId || '',
    planName: plan.name || 'Mindvora Premium',
    status: record.status || 'pending',
    autoRenew: record.autoRenew === true,
    amountKobo: Number(record.amountKobo) || 0,
    currency: record.currency || 'NGN',
    currentPeriodEnd: end ? end.toISOString() : null,
    lastPaymentStatus: record.lastPaymentStatus || 'unknown',
    canManage: !!(record.subscriptionCode && record.emailToken
      && ['active', 'attention', 'non-renewing', 'non_renewing'].includes(String(record.status || '').toLowerCase())
      && (!end || end.getTime() > Date.now()))
  };
}

async function getStatus(uid) {
  const profile = await reconcilePremiumExpiry(uid);
  const records = await recordsForUser(uid);
  const now = Date.now();
  const manageable = records.filter((r) => isManageable(r, now)).sort((a, b) => recordEndMs(b) - recordEndMs(a));
  const latest = manageable[0] || records.sort((a, b) => recordEndMs(b) - recordEndMs(a))[0] || null;
  const intentSnap = await intentRef(uid).get();
  const intent = intentSnap.exists ? intentSnap.data() : null;
  const pending = !!(intent && ['initializing', 'pending', 'charge_confirmed'].includes(intent.status)
    && Date.now() - Number(intent.createdAtMs || 0) < DAY_MS);
  return {
    status: true,
    subscription: publicSubscription(latest),
    pending: pending ? { planId: intent.planId, status: intent.status } : null,
    premium: {
      isActive: profile.isPremium === true,
      plan: profile.plan || 'free',
      expiresAt: asDate(profile.premiumExpiresAt) ? asDate(profile.premiumExpiresAt).toISOString() : null
    }
  };
}

function callbackUrlFor(req) {
  const origin = String(req.headers.origin || 'https://mindvora-own8.vercel.app');
  let url;
  try { url = new URL(origin); } catch (_) { throw Object.assign(new Error('Invalid app origin.'), { status: 400 }); }
  const allowed = new Set(['mindvora.app', 'www.mindvora.app', 'mindvora-own8.vercel.app', 'mindvora-vf8e.vercel.app', 'zync-social-vf8e.vercel.app']);
  const extras = String(process.env.EXTRA_ORIGINS || '').split(',').map((item) => { try { return new URL(item.trim()).hostname; } catch (_) { return ''; } });
  if (!allowed.has(url.hostname) && extras.indexOf(url.hostname) < 0) throw Object.assign(new Error('This app domain is not allowed for Paystack checkout.'), { status: 400 });
  return url.origin + '/';
}

async function initialize(req, res) {
  if (!firebaseAdminConfigured()) return res.status(503).json({ status: false, message: 'Billing service is temporarily unavailable.' });
  const uid = req.user && req.user.uid;
  const body = req.body || {};
  const planId = String(body.plan || '').toLowerCase();
  const plan = catalog.PLANS[planId];
  if (!uid || !plan) return res.status(400).json({ status: false, message: 'Choose a valid Premium plan.' });
  const profile = await reconcilePremiumExpiry(uid);
  const expiry = asDate(profile.premiumExpiresAt);
  if (profile.isPremium === true && (!expiry || expiry.getTime() > Date.now())) {
    return res.status(409).json({ status: false, message: 'Premium is already active on this account. To avoid a duplicate charge, auto-renew cannot start until current access ends.' });
  }
  const active = await latestManageableSubscription(uid);
  if (active) return res.status(409).json({ status: false, message: 'A Paystack Premium subscription is already active or paid through. Manage it in Settings before starting another.' });
  const billingEmail = normalizeEmail(body.billingEmail || (req.user && req.user.email));
  if (!isEmail(billingEmail)) return res.status(400).json({ status: false, message: 'Enter a valid billing email for Paystack receipts and subscription management.' });
  if (!secret()) return res.status(503).json({ status: false, message: 'Paystack is not configured for recurring billing.' });

  const intent = intentRef(uid);
  const oldIntentSnap = await intent.get();
  const oldIntent = oldIntentSnap.exists ? oldIntentSnap.data() : null;
  if (oldIntent && ['initializing', 'pending', 'charge_confirmed'].includes(oldIntent.status)
      && Date.now() - Number(oldIntent.createdAtMs || 0) < DAY_MS) {
    if (oldIntent.status === 'pending' && oldIntent.planId === planId && oldIntent.email === billingEmail && oldIntent.authorizationUrl) {
      return res.json({ status: true, authorization_url: oldIntent.authorizationUrl, reference: oldIntent.reference, amountKobo: oldIntent.amountKobo, currency: 'NGN', resumed: true });
    }
    return res.status(409).json({ status: false, message: 'A recurring checkout is already pending. Resume it with the same plan and billing email or finish/close it before starting another.' });
  }

  const amountKobo = catalog.usdToKobo(plan.usd);
  let planCode;
  try { planCode = await createOrGetPlan(planId); }
  catch (error) { return res.status(error.status || 502).json({ status: false, message: error.message || 'Could not prepare monthly billing.' }); }

  const reference = 'MV-SUB-' + planId.toUpperCase() + '-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
  const intentData = { uid, email: billingEmail, planId, planCode, amountKobo, currency: 'NGN', reference, status: 'initializing', createdAtMs: Date.now() };
  const emailLock = billingEmailLockRef(billingEmail);
  const referenceDoc = checkoutRef(reference);
  try {
    await db().runTransaction(async (transaction) => {
      const [userIntentSnap, emailLockSnap] = await Promise.all([transaction.get(intent), transaction.get(emailLock)]);
      const now = Date.now();
      const oldIntent = userIntentSnap.exists ? userIntentSnap.data() : null;
      if (oldIntent && ['initializing', 'pending', 'charge_confirmed'].includes(oldIntent.status)
          && now - Number(oldIntent.createdAtMs || 0) < DAY_MS) {
        throw Object.assign(new Error('A recurring checkout is already pending. Finish or close it before starting another.'), { status: 409 });
      }
      const oldLock = emailLockSnap.exists ? emailLockSnap.data() : null;
      if (oldLock && oldLock.uid !== uid) {
        const lockEnd = asDate(oldLock.currentPeriodEnd);
        const pending = ['initializing', 'pending', 'charge_confirmed'].includes(oldLock.status) && now - Number(oldLock.createdAtMs || 0) < DAY_MS;
        const active = ['active', 'attention', 'non-renewing', 'non_renewing', 'disabled'].includes(String(oldLock.status || '').toLowerCase()) && (!lockEnd || lockEnd.getTime() > now);
        if (pending || active) throw Object.assign(new Error('That billing email already has a pending or active Mindvora subscription.'), { status: 409 });
      }
      transaction.set(intent, intentData);
      transaction.set(emailLock, intentData);
      transaction.set(referenceDoc, intentData);
    });
  } catch (error) {
    return res.status(error.status || 500).json({ status: false, message: error.message || 'Could not reserve recurring checkout.' });
  }
  try {
    const data = await paystackRequest('/transaction/initialize', 'POST', {
      email: billingEmail,
      amount: amountKobo,
      currency: 'NGN',
      reference,
      plan: planCode,
      callback_url: callbackUrlFor(req),
      metadata: { uid, purpose: 'premium', params: { plan: planId }, autoRenew: true }
    });
    const actualReference = data.reference || reference;
    if (!data.authorization_url) throw new Error('Paystack did not return a checkout URL.');
    const pendingData = Object.assign({}, intentData, { status: 'pending', reference: actualReference, authorizationUrl: data.authorization_url, updatedAt: fv().serverTimestamp() });
    const batch = db().batch();
    batch.set(intent, pendingData);
    batch.set(emailLock, pendingData, { merge: true });
    batch.set(checkoutRef(actualReference), pendingData, { merge: true });
    if (actualReference !== reference) batch.set(referenceDoc, { status: 'superseded', updatedAt: fv().serverTimestamp() }, { merge: true });
    await batch.commit();
    return res.json({ status: true, authorization_url: data.authorization_url, reference: actualReference, amountKobo, currency: 'NGN' });
  } catch (error) {
    await intent.set(Object.assign({}, intentData, { status: 'failed', failedAt: fv().serverTimestamp() })).catch(() => {});
    await emailLock.set(Object.assign({}, intentData, { status: 'failed', failedAt: fv().serverTimestamp() }), { merge: true }).catch(() => {});
    await referenceDoc.set(Object.assign({}, intentData, { status: 'failed', failedAt: fv().serverTimestamp() }), { merge: true }).catch(() => {});
    return res.status(error.status || 502).json({ status: false, message: error.message || 'Could not start Paystack recurring checkout.' });
  }
}

async function statusRoute(req, res) {
  if (!firebaseAdminConfigured()) return res.status(503).json({ status: false, message: 'Billing service is temporarily unavailable.' });
  try { return res.json(await getStatus(req.user.uid)); }
  catch (_) { return res.status(503).json({ status: false, message: 'Could not load subscription status.' }); }
}

async function setRenewal(req, res) {
  if (!firebaseAdminConfigured()) return res.status(503).json({ status: false, message: 'Billing service is temporarily unavailable.' });
  const enabled = req.body && req.body.enabled;
  if (typeof enabled !== 'boolean') return res.status(400).json({ status: false, message: 'Choose whether auto-renew should be on or off.' });
  try {
    const record = await latestManageableSubscription(req.user.uid);
    if (!record) return res.status(404).json({ status: false, message: 'No active Paystack auto-renewing subscription was found.' });
    if (record.autoRenew === enabled) return res.json(await getStatus(req.user.uid));
    if (!record.emailToken) return res.status(409).json({ status: false, message: 'Paystack has not supplied a subscription management token yet. Try again shortly.' });
    const path = enabled ? '/subscription/enable' : '/subscription/disable';
    await paystackRequest(path, 'POST', { code: record.subscriptionCode, token: record.emailToken });
    const nextStatus = enabled ? 'active' : 'non-renewing';
    await subscriptionRef(record.subscriptionCode).set({ autoRenew: enabled, status: nextStatus, updatedAt: fv().serverTimestamp() }, { merge: true });
    if (record.email) await billingEmailLockRef(record.email).set({ uid: req.user.uid, email: record.email, status: nextStatus, currentPeriodEnd: record.currentPeriodEnd, updatedAt: fv().serverTimestamp() }, { merge: true });
    if (!enabled) {
      await intentRef(req.user.uid).set({ status: 'non-renewing', updatedAt: fv().serverTimestamp() }, { merge: true }).catch(() => {});
    } else {
      await intentRef(req.user.uid).set({ status: 'active', updatedAt: fv().serverTimestamp() }, { merge: true }).catch(() => {});
    }
    return res.json(await getStatus(req.user.uid));
  } catch (error) {
    return res.status(error.status || 502).json({ status: false, message: error.message || 'Paystack could not update auto-renew. Your current setting is unchanged.' });
  }
}

function eventSubscription(data) { return data && (data.subscription || data); }
function subscriptionCodeFrom(data) {
  const sub = eventSubscription(data) || {};
  return String(sub.subscription_code || data.subscription_code || '');
}
function planCodeFrom(data) {
  const sub = eventSubscription(data) || {};
  return String((sub.plan && sub.plan.plan_code) || (data.plan && data.plan.plan_code) || sub.plan_code || data.plan_code || '');
}
function customerEmailFrom(data) {
  const sub = eventSubscription(data) || {};
  return normalizeEmail((sub.customer && sub.customer.email) || (data.customer && data.customer.email) || '');
}

async function markInitialCharge({ uid, reference, tx, planId }) {
  if (!firebaseAdminConfigured()) return false;
  const ref = checkoutRef(reference);
  const snap = await ref.get();
  if (!snap.exists) return false;
  const intent = snap.data();
  if (intent.uid !== uid || intent.reference !== reference || intent.planId !== planId || !['initializing', 'pending', 'charge_confirmed', 'active'].includes(intent.status)) return false;
  const customerCode = tx && tx.customer && tx.customer.customer_code;
  const update = { status: intent.status === 'active' ? 'active' : 'charge_confirmed', chargeConfirmedAt: fv().serverTimestamp(), updatedAt: fv().serverTimestamp() };
  if (customerCode) update.customerCode = String(customerCode);
  await ref.set(update, { merge: true });
  const latestUserIntent = await intentRef(uid).get();
  if (latestUserIntent.exists && latestUserIntent.data().reference === reference) await intentRef(uid).set(update, { merge: true });
  if (customerCode) await paystackCustomerRef(customerCode).set({ uid, updatedAt: fv().serverTimestamp() }, { merge: true });
  return true;
}

async function onSubscriptionCreated(data) {
  const code = subscriptionCodeFrom(data);
  const sub = eventSubscription(data) || {};
  const token = String(sub.email_token || data.email_token || '');
  const email = customerEmailFrom(data);
  const planCode = planCodeFrom(data);
  if (!code || !token || !email || !planCode) {
    console.warn('[SUBSCRIPTION] Paystack subscription.create missing required identifiers.');
    return false;
  }
  let intentDocs = await db().collection('billing_subscription_checkout_refs').where('email', '==', email).get();
  let intentDoc = intentDocs.docs.filter((doc) => {
    const value = doc.data();
    return value.planCode === planCode
      && ['pending', 'charge_confirmed', 'active'].includes(value.status)
      && Date.now() - Number(value.createdAtMs || 0) < DAY_MS;
  }).sort((a, b) => Number(b.data().createdAtMs || 0) - Number(a.data().createdAtMs || 0))[0] || null;
  if (!intentDoc) {
    const customerCode = String((sub.customer && sub.customer.customer_code) || (data.customer && data.customer.customer_code) || '');
    if (customerCode) {
      const customerSnap = await paystackCustomerRef(customerCode).get();
      const customer = customerSnap.exists ? customerSnap.data() : null;
      if (customer && customer.uid) {
        const snap = await intentRef(customer.uid).get();
        if (snap.exists && snap.data().planCode === planCode && Date.now() - Number(snap.data().createdAtMs || 0) < DAY_MS) intentDoc = snap;
      }
    }
  }
  if (!intentDoc) {
    console.warn('[SUBSCRIPTION] No matching user-initiated renewal intent for Paystack subscription.create.');
    return false;
  }
  const intent = intentDoc.data();
  const nextDate = asDate(sub.next_payment_date || data.next_payment_date) || new Date(Date.now() + 30 * DAY_MS);
  const amountKobo = Number(sub.amount || data.amount || intent.amountKobo) || intent.amountKobo;
  const status = String(sub.status || data.status || 'active').toLowerCase();
  const record = {
    uid: intent.uid,
    email: intent.email,
    provider: 'paystack',
    subscriptionCode: code,
    emailToken: token,
    planId: intent.planId,
    planCode,
    amountKobo,
    currency: 'NGN',
    status,
    autoRenew: status === 'active' || status === 'attention',
    currentPeriodEnd: nextDate,
    nextPaymentDate: nextDate,
    lastPaymentStatus: 'paid',
    createdAtMs: Number(intent.createdAtMs) || Date.now(),
    updatedAt: fv().serverTimestamp()
  };
  await subscriptionRef(code).set(record, { merge: true });
  await billingEmailLockRef(intent.email).set({ uid: intent.uid, email: intent.email, status: record.autoRenew ? 'active' : status, currentPeriodEnd: nextDate, subscriptionCode: code, updatedAt: fv().serverTimestamp() }, { merge: true });
  await checkoutRef(intent.reference).set({ status: record.autoRenew ? 'active' : status, subscriptionCode: code, currentPeriodEnd: nextDate, updatedAt: fv().serverTimestamp() }, { merge: true });
  const latestUserIntent = await intentRef(intent.uid).get();
  if (latestUserIntent.exists && latestUserIntent.data().reference === intent.reference) await intentRef(intent.uid).set({ status: record.autoRenew ? 'active' : status, subscriptionCode: code, currentPeriodEnd: nextDate, updatedAt: fv().serverTimestamp() }, { merge: true });
  await userRef(intent.uid).set({ isPremium: true, plan: intent.planId, premiumExpiresAt: nextDate, premiumProvider: 'paystack' }, { merge: true });
  return true;
}

async function findSubscriptionByEvent(data) {
  const code = subscriptionCodeFrom(data);
  if (code) {
    const snap = await subscriptionRef(code).get();
    if (snap.exists) return { code, ref: subscriptionRef(code), record: snap.data() };
  }
  const customerCode = String((data && data.customer && data.customer.customer_code) || '');
  if (customerCode) {
    const customerSnap = await paystackCustomerRef(customerCode).get();
    if (customerSnap.exists && customerSnap.data().uid) {
      const record = await latestManageableSubscription(customerSnap.data().uid);
      if (record) return { code: record.subscriptionCode, ref: subscriptionRef(record.subscriptionCode), record };
    }
  }
  return null;
}

async function onInvoicePaid(data) {
  const found = await findSubscriptionByEvent(data);
  if (!found) return false;
  const sub = eventSubscription(data) || {};
  const end = asDate(sub.next_payment_date || data.next_payment_date || data.period_end);
  const currentEnd = asDate(found.record.currentPeriodEnd);
  const periodEnd = end || currentEnd || new Date(Date.now() + 30 * DAY_MS);
  const paid = data.paid === true || data.paid === 1 || String(data.paid || '').toLowerCase() === 'true'
    || String(data.status || '').toLowerCase() === 'success' || String(data.status || '').toLowerCase() === 'paid';
  if (!paid) return false;
  await found.ref.set({ status: found.record.autoRenew ? 'active' : (found.record.status || 'non-renewing'), lastPaymentStatus: 'paid', lastPaidAt: fv().serverTimestamp(), currentPeriodEnd: periodEnd, nextPaymentDate: periodEnd, updatedAt: fv().serverTimestamp() }, { merge: true });
  if (found.record.email) await billingEmailLockRef(found.record.email).set({ uid: found.record.uid, email: found.record.email, status: found.record.autoRenew ? 'active' : (found.record.status || 'non-renewing'), currentPeriodEnd: periodEnd, subscriptionCode: found.code, updatedAt: fv().serverTimestamp() }, { merge: true });
  await userRef(found.record.uid).set({ isPremium: true, plan: found.record.planId, premiumExpiresAt: periodEnd, premiumProvider: 'paystack' }, { merge: true });
  return true;
}

async function handleWebhookEvent(event) {
  if (!firebaseAdminConfigured() || !event || !event.data) return false;
  const data = event.data;
  switch (event.event) {
    case 'subscription.create':
      return onSubscriptionCreated(data);
    case 'subscription.not_renew': {
      const found = await findSubscriptionByEvent(data);
      if (!found) return false;
      await found.ref.set({ status: 'non-renewing', autoRenew: false, updatedAt: fv().serverTimestamp() }, { merge: true });
      if (found.record.email) await billingEmailLockRef(found.record.email).set({ uid: found.record.uid, email: found.record.email, status: 'non-renewing', currentPeriodEnd: found.record.currentPeriodEnd, subscriptionCode: found.code, updatedAt: fv().serverTimestamp() }, { merge: true });
      await intentRef(found.record.uid).set({ status: 'non-renewing', updatedAt: fv().serverTimestamp() }, { merge: true }).catch(() => {});
      return true;
    }
    case 'subscription.disable': {
      const found = await findSubscriptionByEvent(data);
      if (!found) return false;
      const status = String((eventSubscription(data) || {}).status || data.status || 'disabled').toLowerCase();
      await found.ref.set({ status, autoRenew: false, disabledAt: fv().serverTimestamp(), updatedAt: fv().serverTimestamp() }, { merge: true });
      if (found.record.email) await billingEmailLockRef(found.record.email).set({ uid: found.record.uid, email: found.record.email, status, currentPeriodEnd: found.record.currentPeriodEnd, subscriptionCode: found.code, updatedAt: fv().serverTimestamp() }, { merge: true });
      await intentRef(found.record.uid).set({ status, updatedAt: fv().serverTimestamp() }, { merge: true }).catch(() => {});
      await reconcilePremiumExpiry(found.record.uid);
      return true;
    }
    case 'invoice.payment_failed': {
      const found = await findSubscriptionByEvent(data);
      if (!found) return false;
      await found.ref.set({ status: 'attention', lastPaymentStatus: 'failed', lastPaymentFailedAt: fv().serverTimestamp(), updatedAt: fv().serverTimestamp() }, { merge: true });
      if (found.record.email) await billingEmailLockRef(found.record.email).set({ uid: found.record.uid, email: found.record.email, status: 'attention', currentPeriodEnd: found.record.currentPeriodEnd, subscriptionCode: found.code, updatedAt: fv().serverTimestamp() }, { merge: true });
      return true;
    }
    case 'invoice.update':
      return onInvoicePaid(data);
    default:
      return false;
  }
}

function mount(app, { requireUser }) {
  app.post('/api/pay/subscription/initialize', requireUser, async (req, res) => {
    try { await initialize(req, res); }
    catch (error) { res.status(error.status || 500).json({ status: false, message: error.message || 'Could not start recurring checkout.' }); }
  });
  app.get('/api/pay/subscription/status', requireUser, statusRoute);
  app.post('/api/pay/subscription/renewal', requireUser, setRenewal);
}

module.exports = { mount, handleWebhookEvent, markInitialCharge, getStatus, reconcilePremiumExpiry };
