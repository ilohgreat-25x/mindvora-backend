/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  MINDVORA — EMAIL OTP STORE  ·  lib/otp-store.js                     ║
 * ║                                                                      ║
 * ║  Server generates the code, hashes + stores it in memory, and        ║
 * ║  verifies it later. This ONLY works safely because server.js runs   ║
 * ║  as a single long-lived process (unlike Vercel serverless functions, ║
 * ║  where each route is its own isolated instance and can't share       ║
 * ║  in-memory state with a different route).                            ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

'use strict';

const crypto = require('crypto');

const OTP_TTL_MS                = 10 * 60 * 1000;   // code valid for 10 min
const OTP_MAX_ATTEMPTS          = 5;                 // wrong guesses allowed
const OTP_COOLDOWN_MS           = 60 * 1000;         // 60s between resends
const OTP_COOLDOWN_PER_EMAIL_MS = 60 * 60 * 1000;    // 1 hour window
const OTP_MAX_SENDS_PER_WINDOW  = 3;                 // max sends per hour/email

const otpStore = new Map(); // email -> { hash, expiresAt, attempts, lastSentAt, sentCount, firstSentAt }

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

/**
 * Generate + store a new 6-digit code for this email.
 * Returns { code } on success, or { cooldown: true, retryAfter } /
 * { rateLimited: true } if the caller should be throttled.
 */
function issueEmailOtp(email) {
  const now = Date.now();
  const rec = otpStore.get(email);

  if (rec && rec.lastSentAt && now - rec.lastSentAt < OTP_COOLDOWN_MS) {
    return { cooldown: true, retryAfter: Math.ceil((OTP_COOLDOWN_MS - (now - rec.lastSentAt)) / 1000) };
  }
  if (rec && rec.sentCount) {
    const firstWindow = rec.firstSentAt || now;
    if (now - firstWindow < OTP_COOLDOWN_PER_EMAIL_MS && rec.sentCount >= OTP_MAX_SENDS_PER_WINDOW) {
      return { rateLimited: true };
    }
  }

  const code = crypto.randomInt(0, 1000000).toString().padStart(6, '0');
  otpStore.set(email, {
    hash: sha256(email + '|' + code),
    expiresAt: now + OTP_TTL_MS,
    attempts: 0,
    lastSentAt: now,
    sentCount: (rec && rec.sentCount || 0) + 1,
    firstSentAt: (rec && rec.firstSentAt) || now,
  });

  return { code };
}

/**
 * Verify a submitted code against the stored hash.
 * Returns { status: 'ok' | 'not_found' | 'expired' | 'too_many' | 'invalid', message }
 */
function checkEmailOtp(email, code) {
  const rec = otpStore.get(email);
  if (!rec) {
    return { status: 'not_found', message: 'No code was sent to this email. Request a new one.' };
  }
  if (Date.now() > rec.expiresAt) {
    otpStore.delete(email);
    return { status: 'expired', message: 'Code expired. Request a new one.' };
  }
  if (rec.attempts >= OTP_MAX_ATTEMPTS) {
    otpStore.delete(email);
    return { status: 'too_many', message: 'Too many attempts. Request a new code.' };
  }
  rec.attempts += 1;
  if (sha256(email + '|' + String(code).trim()) !== rec.hash) {
    return { status: 'invalid', message: `Incorrect code. ${OTP_MAX_ATTEMPTS - rec.attempts} attempts left.` };
  }
  otpStore.delete(email);
  return { status: 'ok', message: 'Email verified.' };
}

// ── Periodic cleanup of expired entries ────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [email, rec] of otpStore.entries()) {
    if (rec.expiresAt <= now && now - rec.firstSentAt > OTP_COOLDOWN_PER_EMAIL_MS) {
      otpStore.delete(email);
    }
  }
}, 30 * 60 * 1000);

module.exports = { issueEmailOtp, checkEmailOtp, OTP_TTL_MS };
