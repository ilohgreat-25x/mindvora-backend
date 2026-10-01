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

const { verifyFirebaseToken } = require('./firebase-token');

/** Verify a Firebase ID token. 1) Firebase Admin if set up, 2) Google's public
 *  certificates (no key needed — the main path), 3) Identity Toolkit REST. */
async function verifyIdTokenAny(token) {
  if (!token) { console.warn('[auth] no login token sent'); return null; }
  if (firebaseAdminConfigured()) {
    try { return await auth().verifyIdToken(token); } catch (e) { console.warn('[auth] Admin rejected token:', e.code || e.message); }
  }
  const local = await verifyFirebaseToken(token);
  if (local && local.uid) return local;
  console.warn('[auth] login token rejected:', local && local.error);
  if (!WEB_API_KEY) return null;
  try {
    const r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + WEB_API_KEY, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: token }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) { console.warn('[auth] Identity Toolkit HTTP', r.status); return null; }
    const d = await r.json();
    const u = d && d.users && d.users[0];
    return u && u.localId ? { uid: u.localId, email: u.email || '', email_verified: !!u.emailVerified, viaRest: true } : null;
  } catch (_) { return null; }
}

async function userFromRequest(req) {
  const m = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  return verifyIdTokenAny(m[1]);
}

async function requireUser(req, res, next) {
  if (!firebaseAdminConfigured()) {
    return res.status(503).json({ status: false, code: 'FIREBASE_ADMIN_NOT_CONFIGURED',
      message: 'Payments are being set up. Please try again later.' });
    // Owner: add the Firebase service account on Render (secret file firebase-service-account.json,
    // FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_SERVICE_ACCOUNT_B64). Payments must write premium status.
  }
  const user = await userFromRequest(req);
  if (!user) return res.status(401).json({ status: false, code: 'AUTH_REQUIRED', message: 'Please log in again.' });
  req.user = user;
  next();
}

module.exports = { requireUser, userFromRequest, verifyIdTokenAny };
