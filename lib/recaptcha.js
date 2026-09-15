/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  MINDVORA — GOOGLE reCAPTCHA v3 VERIFICATION  ·  lib/recaptcha.js    ║
 * ║                                                                      ║
 * ║  Configure via env var: RECAPTCHA_SECRET_KEY                         ║
 * ║  (get it from https://www.google.com/recaptcha/admin — v3 site)      ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

'use strict';

const RECAPTCHA_SECRET_KEY   = process.env.RECAPTCHA_SECRET_KEY || '';
const RECAPTCHA_MIN_SCORE    = Number(process.env.RECAPTCHA_MIN_SCORE || 0.5);

/**
 * Verify a reCAPTCHA v3 token against Google's siteverify endpoint.
 * @param {string} token - the token the client got from grecaptcha.execute()
 * @param {Function} fetchImpl - the app's already-resolved fetch (node-fetch)
 * @returns {Promise<{ ok: boolean, configured: boolean, score?: number }>}
 */
async function verifyRecaptcha(token, fetchImpl) {
  if (!RECAPTCHA_SECRET_KEY) {
    console.warn('[reCAPTCHA] Not configured — RECAPTCHA_SECRET_KEY missing.');
    return { ok: false, configured: false };
  }
  if (!token) {
    console.warn('[reCAPTCHA] No token received from client — grecaptcha likely failed to load or execute in the browser.');
    return { ok: false, configured: true };
  }
  try {
    const doFetch = fetchImpl || fetch;
    const resp = await doFetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: RECAPTCHA_SECRET_KEY, response: token }).toString(),
    });
    const data = await resp.json();
    const ok = !!(data && data.success && (data.score === undefined || data.score >= RECAPTCHA_MIN_SCORE));
    if (!ok) {
      console.warn('[reCAPTCHA] Verification failed. Google response:', JSON.stringify(data));
    } else {
      console.log('[reCAPTCHA] Verified OK. score:', data.score, 'hostname:', data.hostname);
    }
    return { ok, configured: true, score: data && data.score };
  } catch (err) {
    console.error('[reCAPTCHA] Request to Google siteverify threw an error:', err.message);
    return { ok: false, configured: true };
  }
}

module.exports = { verifyRecaptcha };
