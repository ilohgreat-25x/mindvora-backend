/**
 * MINDVORA — FIREBASE ID-TOKEN AUTH  ·  lib/auth-user.js
 * The browser sends `Authorization: Bearer <idToken>` (from
 * firebase.auth().currentUser.getIdToken()). We verify it with Firebase Admin
 * so the server knows WHICH user is paying — never trusting a uid in the body.
 */
'use strict';

const { auth, firebaseAdminConfigured } = require('./firebase-admin');

// Firebase's public web API key (same one the website uses). Only used to ask
// Google "is this sign-in token real?" when Firebase Admin isn't set up yet.
// Set FIREBASE_WEB_API_KEY on Render (never hardcode keys in this repo).
const WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY || '';
if (!WEB_API_KEY) console.warn('[auth] FIREBASE_WEB_API_KEY not set — calls need it unless Firebase Admin is configured.');

/** Verify a Firebase ID token. Uses Firebase Admin when configured, otherwise
 *  asks Google's Identity Toolkit (Google itself rejects fake/expired tokens). */
async function verifyIdTokenAny(token) {
  if (!token) return null;
  if (firebaseAdminConfigured()) {
    try { return await auth().verifyIdToken(token); } catch (_) { return null; }
  }
  if (!WEB_API_KEY) return null;
  try {
    const r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + WEB_API_KEY, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: token }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const d = await r.json();
    const u = d && d.users && d.users[0];
    return u && u.localId ? { uid: u.localId, email: u.email || '', email_verified: !!u.emailVerified, viaRest: true } : null;
  } catch (_) { return null; }
}

async function userFromRequest(req) {
  if (!firebaseAdminConfigured()) return null;
  const m = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  try { return await auth().verifyIdToken(m[1]); } catch (_) { return null; }
}

async function requireUser(req, res, next) {
  if (!firebaseAdminConfigured()) {
    return res.status(503).json({ status: false, code: 'FIREBASE_ADMIN_NOT_CONFIGURED',
      message: 'Payments are not configured on the server yet (FIREBASE_SERVICE_ACCOUNT_B64 missing).' });
  }
  const user = await userFromRequest(req);
  if (!user) return res.status(401).json({ status: false, code: 'AUTH_REQUIRED', message: 'Please log in again.' });
  req.user = user;
  next();
}

module.exports = { requireUser, userFromRequest, verifyIdTokenAny };
