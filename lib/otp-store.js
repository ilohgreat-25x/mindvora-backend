/**
 * MINDVORA — EMAIL OTP STORE  ·  lib/otp-store.js
 *
 * Server generates the 6-digit code, stores only a SHA-256 hash, verifies later.
 *
 * FIX: codes used to live only in process memory. Render free services go to
 * sleep after ~15 min idle and restart on every deploy — every pending code
 * was lost and users got "No code was sent to this email" even though the
 * email arrived. When Firebase Admin is configured, codes are now stored in
 * Firestore (collection `email_otps`, which clients cannot read — no rule
 * matches it, so it is deny-by-default). Memory is only the fallback.
 *
 * FIX: the resend cooldown and hourly send counter were charged BEFORE the
 * email was sent, so 3 failed sends (e.g. SMTP blocked) locked the address out
 * for an hour. issueEmailOtp() now returns rollback(), called if sending fails.
 */
'use strict';

const crypto = require('crypto');
const { db, firebaseAdminConfigured } = require('./firebase-admin');

const OTP_TTL_MS               = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS         = 5;
const OTP_COOLDOWN_MS          = 60 * 1000;
const OTP_WINDOW_MS            = 60 * 60 * 1000;
const OTP_MAX_SENDS_PER_WINDOW = 5;

const mem = new Map();
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const keyFor = (email) => sha256('otp|' + email);

function useFirestore() { return firebaseAdminConfigured(); }

async function getRec(email) {
  if (useFirestore()) {
    try {
      const snap = await db().collection('email_otps').doc(keyFor(email)).get();
      return snap.exists ? snap.data() : null;
    } catch (e) { console.error('[OTP] Firestore read failed, using memory:', e.message); }
  }
  return mem.get(email) || null;
}

async function setRec(email, rec) {
  mem.set(email, rec);
  if (useFirestore()) {
    try { await db().collection('email_otps').doc(keyFor(email)).set(rec); }
    catch (e) { console.error('[OTP] Firestore write failed (memory copy kept):', e.message); }
  }
}

async function delRec(email) {
  mem.delete(email);
  if (useFirestore()) {
    try { await db().collection('email_otps').doc(keyFor(email)).delete(); } catch (_) {}
  }
}

async function issueEmailOtp(email) {
  const now = Date.now();
  const prev = await getRec(email);

  if (prev && prev.lastSentAt && now - prev.lastSentAt < OTP_COOLDOWN_MS) {
    return { cooldown: true, retryAfter: Math.ceil((OTP_COOLDOWN_MS - (now - prev.lastSentAt)) / 1000) };
  }
  const inWindow = prev && prev.firstSentAt && now - prev.firstSentAt < OTP_WINDOW_MS;
  if (inWindow && (prev.sentCount || 0) >= OTP_MAX_SENDS_PER_WINDOW) {
    return { rateLimited: true };
  }

  const code = crypto.randomInt(0, 1000000).toString().padStart(6, '0');
  await setRec(email, {
    hash: sha256(email + '|' + code),
    expiresAt: now + OTP_TTL_MS,
    attempts: 0,
    lastSentAt: now,
    sentCount: (inWindow ? (prev.sentCount || 0) : 0) + 1,
    firstSentAt: inWindow ? prev.firstSentAt : now,
  });

  return {
    code,
    rollback: async () => { if (prev) await setRec(email, prev); else await delRec(email); },
  };
}

async function checkEmailOtp(email, code) {
  const rec = await getRec(email);
  if (!rec || !rec.hash) return { status: 'not_found', message: 'No active code for this email. Tap "Resend Code".' };
  if (Date.now() > rec.expiresAt) {
    await delRec(email);
    return { status: 'expired', message: 'Code expired. Tap "Resend Code" to get a new one.' };
  }
  if ((rec.attempts || 0) >= OTP_MAX_ATTEMPTS) {
    await delRec(email);
    return { status: 'too_many', message: 'Too many wrong attempts. Tap "Resend Code".' };
  }
  rec.attempts = (rec.attempts || 0) + 1;
  if (sha256(email + '|' + String(code).trim()) !== rec.hash) {
    await setRec(email, rec);
    return { status: 'invalid', message: `Incorrect code. ${OTP_MAX_ATTEMPTS - rec.attempts} attempts left.` };
  }
  // Keep the send counters (for rate limiting) but invalidate the code.
  await setRec(email, { ...rec, hash: null, expiresAt: 0 });
  return { status: 'ok', message: 'Email verified.' };
}

setInterval(() => {
  const now = Date.now();
  for (const [email, rec] of mem.entries()) {
    if (rec.expiresAt <= now && now - rec.firstSentAt > OTP_WINDOW_MS) mem.delete(email);
  }
}, 30 * 60 * 1000).unref();

module.exports = { issueEmailOtp, checkEmailOtp, OTP_TTL_MS, storage: () => (useFirestore() ? 'firestore' : 'memory') };
