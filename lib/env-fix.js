/**
 * MINDVORA — FORGIVING SETTINGS READER  ·  lib/env-fix.js
 * Runs first. Fixes common copy-paste mistakes in Render environment
 * variables so they still work, and remembers what it fixed (names only,
 * never values) so /api/health can tell the owner.
 */
'use strict';

const fixes = [];

// Accepted alternative spellings → the name the code uses.
const ALIASES = {
  FIREBASE_SERVICE_ACCOUNT_JSON: ['FIREBASE_SERVICE_ACCOUNT_KEY', 'FIREBASE_ADMIN_JSON', 'SERVICE_ACCOUNT_JSON', 'FIREBASE_CREDENTIALS'],
  NOWPAYMENTS_IPN_SECRET: ['NOWPAYMENTS_IPN_KEY', 'NOWPAYMENTS_IPN_SECRET_KEY', 'NOWPAYMENT_IPN_SECRET', 'NOW_PAYMENTS_IPN_SECRET', 'IPN_SECRET'],
  NOWPAYMENTS_API_KEY: ['NOWPAYMENT_API_KEY', 'NOW_PAYMENTS_API_KEY'],
  PAYSTACK_PUBLIC_KEY: ['PAYSTACK_PUBLIC', 'PAYSTACK_PK', 'PAYSTACK_PUBLISHABLE_KEY'],
  GEMINI_API_KEY: ['GOOGLE_GEMINI_API_KEY', 'GEMINI_KEY', 'GOOGLE_AI_API_KEY'],
  FCM_VAPID_KEY: ['VAPID_KEY', 'FIREBASE_VAPID_KEY', 'VAPID_PUBLIC_KEY'],
  METERED_API_KEY: ['METERED_KEY', 'METERED_TURN_API_KEY'],
  METERED_DOMAIN: ['METERED_APP_DOMAIN', 'METERED_URL'],
  TURN_URLS: ['TURN_URL', 'TURN_SERVER', 'TURN_SERVERS'],
  TURN_USERNAME: ['TURN_USER'],
  TURN_CREDENTIAL: ['TURN_PASSWORD', 'TURN_CRED'],
  ADMIN_SECRET: ['ADMIN_KEY', 'ADMIN_PASSWORD'],
};

function cleanValue(v) {
  let s = String(v);
  const t = s.trim();
  if (t !== s) s = t;
  // Strip one pair of wrapping quotes:  "abc"  or  'abc'
  if (s.length >= 2 && ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'"))) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

function run() {
  // 1) Names with spaces / lowercase (e.g. "NOWPAYMENTS_IPN_SECRET " or "gemini_api_key").
  for (const key of Object.keys(process.env)) {
    const norm = key.trim().toUpperCase().replace(/[\s-]+/g, '_');
    if (norm !== key && !process.env[norm] && /^[A-Z0-9_]+$/.test(norm) && norm.length > 3) {
      process.env[norm] = process.env[key];
      fixes.push(`name "${key}" read as ${norm}`);
    }
  }
  // 2) Alternative names.
  for (const [main, alts] of Object.entries(ALIASES)) {
    if (process.env[main]) continue;
    const hit = alts.find((a) => process.env[a]);
    if (hit) { process.env[main] = process.env[hit]; fixes.push(`${hit} read as ${main}`); }
  }
  // 3) Values with extra spaces or wrapping quotes.
  const watch = ['FIREBASE_SERVICE_ACCOUNT_JSON', 'FIREBASE_SERVICE_ACCOUNT', 'FIREBASE_SERVICE_ACCOUNT_B64', ...Object.keys(ALIASES),
    'RECAPTCHA_V2_SITE_KEY', 'RECAPTCHA_V2_SECRET_KEY', 'RECAPTCHA_SECRET_KEY', 'PAYSTACK_SECRET_KEY', 'GROQ_API_KEY',
    'BREVO_API_KEY', 'CF_TURN_KEY_ID', 'CF_TURN_API_TOKEN', 'FIREBASE_PROJECT_ID'];
  for (const k of watch) {
    if (process.env[k] == null) continue;
    const c = cleanValue(process.env[k]);
    if (c !== process.env[k]) { process.env[k] = c; fixes.push(`${k}: removed extra spaces/quotes`); }
    if (!c) delete process.env[k];
  }
  if (fixes.length) console.log('[settings] auto-fixed:', fixes.join('; '));
}
run();

/** Which settings the server can see (true/false only — never the values). */
function seen() {
  const names = ['FIREBASE_SERVICE_ACCOUNT_JSON', 'FIREBASE_SERVICE_ACCOUNT', 'FIREBASE_SERVICE_ACCOUNT_B64',
    'NOWPAYMENTS_API_KEY', 'NOWPAYMENTS_IPN_SECRET', 'PAYSTACK_SECRET_KEY', 'PAYSTACK_PUBLIC_KEY',
    'RECAPTCHA_V2_SITE_KEY', 'RECAPTCHA_V2_SECRET_KEY', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'FCM_VAPID_KEY',
    'ADMIN_SECRET', 'METERED_DOMAIN', 'METERED_API_KEY', 'TURN_URLS', 'TURN_USERNAME', 'TURN_CREDENTIAL'];
  const out = {};
  for (const n of names) out[n] = !!process.env[n];
  return out;
}
/** Secret File NAMES Render has mounted (names only, contents never read here). */
function secretFileNames() {
  try { return require('fs').readdirSync('/etc/secrets'); } catch (_) { return []; }
}
module.exports = { fixes, seen, secretFileNames };
