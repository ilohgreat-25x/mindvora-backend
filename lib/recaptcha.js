/**
 * MINDVORA — GOOGLE reCAPTCHA v3 VERIFICATION  ·  lib/recaptcha.js
 *
 * Env:
 *   RECAPTCHA_SECRET_KEY  the SECRET key paired with the SITE key in index.html
 *                         (Google Cloud console: reCAPTCHA → your key → "Use legacy key"
 *                          / "Integrate with a third party" shows the legacy secret)
 *   RECAPTCHA_MIN_SCORE   optional, default 0.5
 *
 * Every failure now returns a machine-readable `reason` + a plain-English
 * `hint`, logged on the server, so you can see in Render logs exactly why.
 */
'use strict';

const MIN_SCORE = () => Number(process.env.RECAPTCHA_MIN_SCORE || 0.5);

const HINTS = {
  'missing-input-secret':   'RECAPTCHA_SECRET_KEY is empty on the server.',
  'invalid-input-secret':   'RECAPTCHA_SECRET_KEY is wrong — it must be the SECRET key that belongs to the same key as the site key in index.html.',
  'missing-input-response': 'Browser sent no token.',
  'invalid-input-response': 'Token is malformed or was made with a DIFFERENT site key than the secret on the server.',
  'timeout-or-duplicate':   'Token was older than 2 minutes or was used twice.',
  'browser-error':          'Google could not run in the visitor\'s browser.',
  'bad-request':            'Malformed request to Google.',
};

async function verifyRecaptcha(token, fetchImpl, expectedAction) {
  const secret = process.env.RECAPTCHA_SECRET_KEY || '';
  if (!secret) {
    console.warn('[reCAPTCHA] Not configured — RECAPTCHA_SECRET_KEY missing.');
    return { ok: false, configured: false, reason: 'not-configured', hint: HINTS['missing-input-secret'] };
  }
  if (!token) {
    console.warn('[reCAPTCHA] No token from browser. Most common cause: the site is on a domain that is NOT in the key\'s domain list, or an ad-blocker blocked google.com/recaptcha.');
    return { ok: false, configured: true, reason: 'no-token',
      hint: 'No token from the browser — add this website\'s domain to the reCAPTCHA key, or the visitor\'s browser blocked Google.' };
  }
  try {
    const doFetch = fetchImpl || globalThis.fetch;
    const resp = await doFetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token }).toString(),
    });
    const data = await resp.json();
    const codes = (data && data['error-codes']) || [];
    if (!data || !data.success) {
      const code = codes[0] || 'unknown';
      console.warn('[reCAPTCHA] FAILED:', code, '—', HINTS[code] || '', '| raw:', JSON.stringify(data));
      return { ok: false, configured: true, reason: code, hint: HINTS[code] || 'Google rejected the token.' };
    }
    if (data.score !== undefined && data.score < MIN_SCORE()) {
      console.warn(`[reCAPTCHA] Low score ${data.score} (< ${MIN_SCORE()}) host=${data.hostname}`);
      return { ok: false, configured: true, reason: 'low-score', score: data.score, hint: 'Google thinks this visitor may be a bot.' };
    }
    if (expectedAction && data.action && data.action !== expectedAction) {
      console.warn(`[reCAPTCHA] Action mismatch: got "${data.action}", expected "${expectedAction}"`);
      return { ok: false, configured: true, reason: 'action-mismatch', hint: 'Token was generated for a different action.' };
    }
    console.log('[reCAPTCHA] OK score:', data.score, 'host:', data.hostname, 'action:', data.action);
    return { ok: true, configured: true, score: data.score, hostname: data.hostname };
  } catch (err) {
    console.error('[reCAPTCHA] siteverify request threw:', err.message);
    return { ok: false, configured: true, reason: 'network', hint: 'Server could not reach Google.' };
  }
}

module.exports = { verifyRecaptcha };
