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

// Accepts the service-account key in any of three ways (first one found wins):
//  1. Render "Secret File" named firebase-service-account.json  (easiest — no encoding)
//  2. FIREBASE_SERVICE_ACCOUNT_JSON  = the raw JSON text pasted as-is
//  3. FIREBASE_SERVICE_ACCOUNT_B64   = the JSON encoded as base64
function readServiceAccount() {
  const fs = require('fs');
  const path = require('path');
  const names = ['firebase-service-account.json', 'serviceAccountKey.json', 'service-account.json', 'firebase-adminsdk.json'];
  const dirs = ['/etc/secrets', process.cwd(), path.join(__dirname, '..')];
  const files = [process.env.FIREBASE_SERVICE_ACCOUNT_FILE,
    /^\s*\{/.test(process.env.GOOGLE_APPLICATION_CREDENTIALS || '') ? null : process.env.GOOGLE_APPLICATION_CREDENTIALS];
  for (const d of dirs) for (const n of names) files.push(path.join(d, n));
  // Any other .json Secret File that looks like a service account (wrong filename, e.g. "zync-social-firebase-adminsdk-xxxx.json").
  try { fs.readdirSync('/etc/secrets').forEach((n) => { if (/\.json$/i.test(n) || !/\./.test(n)) files.push(path.join('/etc/secrets', n)); }); } catch (_) {}
  for (const f of files.filter(Boolean)) {
    try {
      if (!fs.existsSync(f) || !fs.statSync(f).isFile()) continue;
      const txt = fs.readFileSync(f, 'utf8');
      if (/"private_key"/.test(txt) && /"client_email"/.test(txt)) return { src: 'secret file ' + f, json: txt };
    } catch (_) {}
  }
  if (/^\s*\{/.test(process.env.GOOGLE_APPLICATION_CREDENTIALS || '')) return { src: 'GOOGLE_APPLICATION_CREDENTIALS', json: process.env.GOOGLE_APPLICATION_CREDENTIALS };
  for (const k of ['FIREBASE_SERVICE_ACCOUNT_JSON', 'FIREBASE_SERVICE_ACCOUNT']) {
    const v = (process.env[k] || '').trim();
    if (v.startsWith('{')) return { src: k, json: v };
    if (v) return { src: k + ' (base64)', json: Buffer.from(v, 'base64').toString('utf8') };
  }
  if (process.env.FIREBASE_SERVICE_ACCOUNT_B64) {
    return { src: 'FIREBASE_SERVICE_ACCOUNT_B64', json: (process.env.FIREBASE_SERVICE_ACCOUNT_B64.trim().startsWith('{') ? process.env.FIREBASE_SERVICE_ACCOUNT_B64.trim() : Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64.trim(), 'base64').toString('utf8')) };
  }
  return null;
}

function init() {
  if (app || initError) return;
  const found = readServiceAccount();
  if (!found) {
    initError = 'No Firebase service account (secret file, FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_SERVICE_ACCOUNT_B64)';
    return;
  }
  try {
    let txt = found.json.trim().replace(/^\uFEFF/, '');
    if (!txt.startsWith('{')) throw new Error('the value does not start with { — paste the WHOLE .json file, or its base64');
    if (!txt.endsWith('}')) throw new Error('the value is cut off (does not end with }) — paste the whole file again');
    const serviceAccount = JSON.parse(txt);
    if (!serviceAccount.private_key || !serviceAccount.client_email) throw new Error('this JSON is not a service-account key (no private_key/client_email). Use Project settings → Service accounts → Generate new private key');
    if (serviceAccount.private_key) serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    app = admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log('🔥 Firebase Admin initialized from ' + found.src + ' (project ' + serviceAccount.project_id + ')');
  } catch (err) {
    initError = 'Failed to read the Firebase key from ' + found.src + ': ' + err.message;
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

function firebaseAdminError() { return initError; }
module.exports = { admin, db, auth, firebaseAdminConfigured, firebaseAdminError };
