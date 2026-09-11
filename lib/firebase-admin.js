/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  MINDVORA — FIREBASE ADMIN  ·  lib/firebase-admin.js                 ║
 * ║                                                                      ║
 * ║  Gives the backend privileged access to Firestore/Auth that          ║
 * ║  BYPASSES your security rules — this is intentional and required:    ║
 * ║  it's the only way to credit balances and disable accounts, since    ║
 * ║  your rules correctly forbid clients from doing either themselves.   ║
 * ║                                                                      ║
 * ║  Configure via ONE environment variable:                             ║
 * ║    FIREBASE_SERVICE_ACCOUNT_B64  base64-encoded service account JSON ║
 * ║      (base64, not raw JSON, so the private key's newlines survive    ║
 * ║       being pasted into Render's env var UI without corruption)      ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

'use strict';

const admin = require('firebase-admin');

let app = null;
let initError = null;

function init() {
  if (app || initError) return;
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64 || '';
  if (!b64) {
    initError = 'FIREBASE_SERVICE_ACCOUNT_B64 is not set';
    return;
  }
  try {
    const json = Buffer.from(b64, 'base64').toString('utf8');
    const serviceAccount = JSON.parse(json);
    app = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log('🔥 Firebase Admin initialized');
  } catch (err) {
    initError = 'Failed to parse FIREBASE_SERVICE_ACCOUNT_B64: ' + err.message;
    console.error('[firebase-admin]', initError);
  }
}

init();

function firebaseAdminConfigured() {
  return !!app;
}

function db() {
  if (!app) throw new Error(initError || 'Firebase Admin not initialized');
  return admin.firestore();
}

function auth() {
  if (!app) throw new Error(initError || 'Firebase Admin not initialized');
  return admin.auth();
}

module.exports = { admin, db, auth, firebaseAdminConfigured };
