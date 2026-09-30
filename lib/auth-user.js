/**
 * MINDVORA — FIREBASE ID-TOKEN AUTH  ·  lib/auth-user.js
 * The browser sends `Authorization: Bearer <idToken>` (from
 * firebase.auth().currentUser.getIdToken()). We verify it with Firebase Admin
 * so the server knows WHICH user is paying — never trusting a uid in the body.
 */
'use strict';

const { auth, firebaseAdminConfigured } = require('./firebase-admin');

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

module.exports = { requireUser, userFromRequest };
