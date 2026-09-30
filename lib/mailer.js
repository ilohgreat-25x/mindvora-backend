/**
 * MINDVORA — EMAIL DELIVERY  ·  lib/mailer.js
 *
 * WHY THIS EXISTS: since 26 Sept 2025, Render FREE web services block all
 * outbound traffic on SMTP ports 25, 465 and 587. Nodemailer/SMTP from a free
 * Render service simply hangs and times out — the code is fine, the port is
 * blocked. HTTP email APIs use port 443, which is NOT blocked.
 *
 * Provider is picked automatically, first match wins:
 *   1. BREVO_API_KEY   (Brevo, free 300 emails/day, can send from a verified Gmail address)
 *   2. RESEND_API_KEY  (Resend — needs your own verified domain to email other people)
 *   3. SMTP_HOST/SMTP_USER/SMTP_PASS  (only works on a PAID Render plan or another host)
 *
 * Sender: EMAIL_FROM (falls back to SMTP_FROM, then SMTP_USER). EMAIL_FROM_NAME defaults to "Mindvora".
 */
'use strict';

const nodemailer = require('nodemailer');

const doFetch = (...a) => (globalThis.fetch ? globalThis.fetch(...a) : import('node-fetch').then((m) => m.default(...a)));

function cfg() {
  return {
    brevoKey:  process.env.BREVO_API_KEY || '',
    resendKey: process.env.RESEND_API_KEY || '',
    smtpHost:  process.env.SMTP_HOST || '',
    smtpPort:  Number(process.env.SMTP_PORT || 465),
    smtpSecure: String(process.env.SMTP_SECURE || (Number(process.env.SMTP_PORT || 465) === 465 ? 'true' : 'false')) === 'true',
    smtpUser:  process.env.SMTP_USER || '',
    smtpPass:  process.env.SMTP_PASS || '',
    from:      process.env.EMAIL_FROM || process.env.SMTP_FROM || process.env.SMTP_USER || '',
    fromName:  process.env.EMAIL_FROM_NAME || 'Mindvora',
  };
}

function provider() {
  const c = cfg();
  if (c.brevoKey) return 'brevo';
  if (c.resendKey) return 'resend';
  if (c.smtpHost && c.smtpUser && c.smtpPass) return 'smtp';
  return null;
}

function describe() {
  const c = cfg();
  const p = provider();
  const warnings = [];
  if (!p) warnings.push('No email provider configured. Set BREVO_API_KEY (recommended) or RESEND_API_KEY.');
  if (p && !c.from) warnings.push('EMAIL_FROM is empty — set it to the sender address you verified with your provider.');
  if (p === 'smtp' && process.env.RENDER) warnings.push('SMTP on Render: free services block ports 25/465/587. Use BREVO_API_KEY or RESEND_API_KEY instead.');
  return { provider: p, from: c.from ? c.from.replace(/^(.).*(@.*)$/, '$1***$2') : '', warnings };
}

async function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} timed out after ${ms / 1000}s`)), ms); });
  try { return await Promise.race([promise, timeout]); } finally { clearTimeout(t); }
}

async function sendMail({ to, subject, html, text }) {
  const c = cfg();
  const p = provider();
  if (!p) throw Object.assign(new Error('No email provider configured'), { code: 'EMAIL_NOT_CONFIGURED' });
  if (!c.from) throw Object.assign(new Error('EMAIL_FROM is not set'), { code: 'EMAIL_NOT_CONFIGURED' });

  if (p === 'brevo') {
    const resp = await withTimeout(doFetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': c.brevoKey, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sender: { name: c.fromName, email: c.from }, to: [{ email: to }], subject, htmlContent: html, textContent: text }),
    }), 20000, 'Brevo');
    if (!resp.ok) {
      const body = await resp.text();
      throw Object.assign(new Error(`Brevo ${resp.status}: ${body.slice(0, 300)}`), { code: 'EMAIL_SEND_FAILED' });
    }
    return { provider: p };
  }

  if (p === 'resend') {
    const resp = await withTimeout(doFetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: `${c.fromName} <${c.from}>`, to: [to], subject, html, text }),
    }), 20000, 'Resend');
    if (!resp.ok) {
      const body = await resp.text();
      throw Object.assign(new Error(`Resend ${resp.status}: ${body.slice(0, 300)}`), { code: 'EMAIL_SEND_FAILED' });
    }
    return { provider: p };
  }

  const transporter = nodemailer.createTransport({
    host: c.smtpHost, port: c.smtpPort, secure: c.smtpSecure,
    auth: { user: c.smtpUser, pass: c.smtpPass },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
  });
  try {
    await withTimeout(transporter.sendMail({ from: `${c.fromName} <${c.from}>`, to, subject, html, text }), 30000, 'SMTP');
  } catch (err) {
    const hint = /timed? ?out|ETIMEDOUT|ECONNREFUSED|ESOCKET/i.test(err.message) && process.env.RENDER
      ? ' (Render free plan blocks SMTP ports — switch to BREVO_API_KEY)' : '';
    throw Object.assign(new Error(err.message + hint), { code: 'EMAIL_SEND_FAILED' });
  }
  return { provider: p };
}

module.exports = { sendMail, provider, describe };
