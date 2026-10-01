/**
 * MINDVORA — FIREBASE LOGIN-TOKEN CHECK (no keys needed)  ·  lib/firebase-token.js
 * Verifies a Firebase ID token with Google's PUBLIC certificates.
 * Needs no API key and no service account — only the project id.
 */
'use strict';
const crypto = require('crypto');

const PROJECT_ID = () => process.env.FIREBASE_PROJECT_ID || 'zync-social';
const CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
let certs = null, certsUntil = 0;

async function getCerts() {
  if (certs && Date.now() < certsUntil) return certs;
  const r = await fetch(CERTS_URL, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('Google certs HTTP ' + r.status);
  const m = String(r.headers.get('cache-control') || '').match(/max-age=(\d+)/);
  certs = await r.json();
  certsUntil = Date.now() + (m ? Number(m[1]) * 1000 : 3600 * 1000);
  return certs;
}
const b64 = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/** Returns { uid, email, ... } or { error: 'reason' }. */
async function verifyFirebaseToken(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return { error: 'not-a-jwt' };
    const header = JSON.parse(b64(parts[0]).toString('utf8'));
    const p = JSON.parse(b64(parts[1]).toString('utf8'));
    if (header.alg !== 'RS256') return { error: 'bad-alg' };
    const all = await getCerts();
    let pem = all[header.kid];
    if (!pem) { certsUntil = 0; pem = (await getCerts())[header.kid]; }
    if (!pem) return { error: 'unknown-key-id' };
    const ok = crypto.createVerify('RSA-SHA256').update(parts[0] + '.' + parts[1]).verify(pem, b64(parts[2]));
    if (!ok) return { error: 'bad-signature' };
    const now = Math.floor(Date.now() / 1000);
    const pid = PROJECT_ID();
    if (p.aud !== pid) return { error: 'wrong-project (token is for "' + p.aud + '", server expects "' + pid + '")' };
    if (p.iss !== 'https://securetoken.google.com/' + pid) return { error: 'wrong-issuer' };
    if (!p.sub) return { error: 'no-user' };
    if (p.exp < now - 60) return { error: 'expired' };
    if (p.iat > now + 300) return { error: 'issued-in-future' };
    return { uid: p.sub, user_id: p.sub, email: p.email || '', email_verified: !!p.email_verified, firebase: p.firebase };
  } catch (e) {
    return { error: 'check-failed: ' + e.message };
  }
}
module.exports = { verifyFirebaseToken };
