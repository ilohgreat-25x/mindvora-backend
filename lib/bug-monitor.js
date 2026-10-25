'use strict';

const crypto = require('crypto');
const { admin, db, firebaseAdminConfigured } = require('./firebase-admin');
const { userFromRequest } = require('./auth-user');
const aria = require('./aria');
const mailer = require('./mailer');

const OWNER_EMAIL = 'ilohgreat25@gmail.com';
const WINDOW_MS = 10 * 60 * 1000;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 12;
const MAX = { message: 3000, stack: 12000, source: 300, route: 500, fingerprint: 200 };
const ipRates = new Map();
const recentByFingerprint = new Map();
const memoryReports = new Map();
const memoryJobs = new Map();

function text(value, max) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/(bearer\s+|authorization\s*[:=]\s*|api[_-]?key\s*[:=]\s*|token\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:access_token|refresh_token|id_token|api_key|secret|password)=)[^&#\s]+/gi, '$1[REDACTED]')
    .slice(0, max);
}

function safeContext(value, depth = 0) {
  if (depth > 2 || value == null) return depth ? undefined : {};
  if (typeof value === 'string') return text(value, 1000);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => safeContext(v, depth + 1));
  if (typeof value !== 'object') return undefined;
  const out = {};
  for (const [key, val] of Object.entries(value).slice(0, 30)) {
    if (/token|secret|password|authorization|cookie|credential|private.?key|api.?key/i.test(key)) continue;
    const v = safeContext(val, depth + 1);
    if (v !== undefined) out[text(key, 80)] = v;
  }
  return out;
}

function sanitise(body) {
  const message = text(body && body.message, MAX.message) || 'Unknown frontend error';
  const stack = text(body && body.stack, MAX.stack);
  const source = text(body && body.source, MAX.source);
  const route = text(body && body.route, MAX.route);
  const supplied = text(body && body.fingerprint, MAX.fingerprint);
  const basis = supplied || [message, stack, source, route].join('|');
  const fingerprint = crypto.createHash('sha256').update(basis).digest('hex');
  return { message, stack, source, route, context: safeContext(body && body.context), fingerprint };
}

function fallback(report) {
  const s = `${report.message} ${report.stack}`;
  let likelyCause = 'An unexpected frontend exception; inspect the stack trace and route-specific state.';
  if (/network|fetch|xhr|timeout|offline|504|500/i.test(s)) likelyCause = 'A failed or timed-out network request, possibly caused by an unavailable backend or connectivity issue.';
  else if (/undefined|null|cannot read|not a function|is not defined/i.test(s)) likelyCause = 'A frontend state or data-shape mismatch caused code to access a missing value.';
  else if (/permission|auth|login|token|unauthor/i.test(s)) likelyCause = 'An authentication or authorization state became invalid while the frontend was handling the request.';
  else if (/chunk|module|syntax|import/i.test(s)) likelyCause = 'A frontend bundle or module loading problem may have left code unavailable.';
  return { aiSummary: `Frontend error reported on ${report.route || 'an unspecified route'}: ${report.message.slice(0, 240)}`, likelyCause };
}

function parseAi(textValue, report) {
  try {
    const parsed = JSON.parse(String(textValue).replace(/^```(?:json)?\s*|\s*```$/gi, '').trim());
    if (parsed && typeof parsed === 'object') {
      const aiSummary = text(parsed.aiSummary || parsed.summary, 700);
      const likelyCause = text(parsed.likelyCause || parsed.cause, 700);
      if (aiSummary && likelyCause) return { aiSummary, likelyCause };
    }
  } catch (_) {}
  return fallback(report);
}

async function analyse(report) {
  const base = fallback(report);
  if (typeof aria.provider !== 'function' || !aria.provider()) return base;
  try {
    const out = await Promise.race([
      aria.generate([
        { role: 'system', content: 'You triage sanitized frontend errors. Reply ONLY as JSON with exactly two short string fields: aiSummary and likelyCause. Do not mention secrets or invent evidence.' },
        { role: 'user', content: JSON.stringify({ message: report.message, stack: report.stack, source: report.source, route: report.route, context: report.context }) },
      ]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('ARIA timeout')), 8000)),
    ]);
    return parseAi(out.text, report);
  } catch (err) {
    console.warn('[bug-monitor] ARIA analysis skipped:', String(err.message || 'error').slice(0, 120));
    return base;
  }
}

function owner(req) {
  return userFromRequest(req).then((user) => {
    if (!user) return null;
    if (String(user.email || '').toLowerCase() !== OWNER_EMAIL || user.email_verified !== true) return null;
    return user;
  });
}

function serialize(data, id) {
  const out = { id, ...data };
  for (const key of ['createdAt', 'updatedAt', 'decidedAt']) {
    if (out[key] && typeof out[key].toDate === 'function') out[key] = out[key].toDate().toISOString();
  }
  return out;
}

function rateLimited(ip) {
  const now = Date.now();
  const item = ipRates.get(ip) || { start: now, count: 0 };
  if (now - item.start >= RATE_WINDOW_MS) { item.start = now; item.count = 0; }
  item.count += 1; ipRates.set(ip, item);
  return item.count > RATE_MAX;
}

function clientIp(req) { return String(req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim().slice(0, 100); }
function firestoreReady() { return firebaseAdminConfigured(); }
function now() { return admin.firestore.Timestamp.now(); }

async function persistReport(report, analysis) {
  const stamp = Date.now();
  const recent = recentByFingerprint.get(report.fingerprint);
  if (recent && stamp - recent.at < WINDOW_MS) {
    recent.at = stamp;
    if (recent.ref) {
      await recent.ref.update({ occurrenceCount: admin.firestore.FieldValue.increment(1), updatedAt: now() });
      return { id: recent.ref.id, duplicate: true, report: recent.report };
    }
    recent.report.occurrenceCount += 1;
    return { id: recent.id, duplicate: true, report: recent.report };
  }
  const base = { ...report, ...analysis, status: 'pending', createdAt: now(), occurrenceCount: 1, updatedAt: now() };
  if (!firestoreReady()) {
    const id = crypto.randomUUID();
    const item = { ...base, createdAt: new Date(), updatedAt: new Date() };
    memoryReports.set(id, item);
    recentByFingerprint.set(report.fingerprint, { at: stamp, id, report: item });
    return { id, duplicate: false, report: item };
  }
  const ref = db().collection('bug_reports').doc();
  await ref.set(base);
  recentByFingerprint.set(report.fingerprint, { at: stamp, ref, id: ref.id, report: base });
  return { id: ref.id, duplicate: false, report: base };
}

function htmlEscape(v) { return String(v || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
async function notify(report, id) {
  if (!mailer.provider()) return;
  const evidence = `Message: ${report.message}\nRoute: ${report.route || 'n/a'}\nSource: ${report.source || 'n/a'}\nStack: ${report.stack || 'n/a'}`;
  const textBody = `A new Mindvora frontend bug is pending.\n\nLikely cause: ${report.likelyCause}\nAI summary: ${report.aiSummary}\n\nEvidence:\n${evidence}\n\nAccept: POST /api/admin/bugs/${id}/decision with JSON {"decision":"accept"} and your Firebase Bearer token.\nDecline: POST /api/admin/bugs/${id}/decision with JSON {"decision":"decline"} and your Firebase Bearer token.`;
  const html = `<p>A new Mindvora frontend bug is pending.</p><p><b>Likely cause:</b> ${htmlEscape(report.likelyCause)}<br><b>AI summary:</b> ${htmlEscape(report.aiSummary)}</p><pre>${htmlEscape(evidence)}</pre><p><b>Accept:</b> POST <code>/api/admin/bugs/${htmlEscape(id)}/decision</code> with <code>{"decision":"accept"}</code> and your Firebase Bearer token.<br><b>Decline:</b> use the same endpoint with <code>{"decision":"decline"}</code>.</p>`;
  try { await mailer.sendMail({ to: OWNER_EMAIL, subject: `Mindvora bug pending: ${report.message.slice(0, 80)}`, html, text: textBody }); }
  catch (err) { console.warn('[bug-monitor] owner email failed:', String(err.message || 'error').slice(0, 160)); }
}

function mount(app) {
  app.post('/api/bugs/report', async (req, res) => {
    if (rateLimited(clientIp(req))) return res.status(429).json({ status: false, code: 'RATE_LIMITED', message: 'Too many bug reports. Try again later.' });
    const report = sanitise(req.body || {});
    const recent = recentByFingerprint.get(report.fingerprint);
    if (recent && Date.now() - recent.at < WINDOW_MS) {
      const saved = await persistReport(report, fallback(report));
      return res.status(202).json({ status: true, id: saved.id, duplicate: true });
    }
    const analysis = await analyse(report);
    const saved = await persistReport(report, analysis);
    if (!saved.duplicate) await notify({ ...report, ...analysis }, saved.id);
    return res.status(202).json({ status: true, id: saved.id, duplicate: false });
  });

  app.get('/api/admin/bugs', async (req, res) => {
    if (!(await owner(req))) return res.status(401).json({ status: false, code: 'OWNER_AUTH_REQUIRED' });
    if (!firestoreReady()) return res.status(503).json({ status: false, code: 'FIREBASE_ADMIN_NOT_CONFIGURED' });
    try {
      const [reports, jobs] = await Promise.all([
        db().collection('bug_reports').limit(200).get(),
        db().collection('repair_jobs').limit(200).get(),
      ]);
      return res.json({ status: true, reports: reports.docs.map((d) => serialize(d.data(), d.id)), repairJobs: jobs.docs.map((d) => serialize(d.data(), d.id)) });
    } catch (err) { return res.status(500).json({ status: false, code: 'BUGS_READ_FAILED', message: 'Unable to read bug reports.' }); }
  });

  app.post('/api/admin/bugs/:id/decision', async (req, res) => {
    const user = await owner(req);
    if (!user) return res.status(401).json({ status: false, code: 'OWNER_AUTH_REQUIRED' });
    const decision = String(req.body && req.body.decision || '').toLowerCase();
    if (!['accept', 'decline'].includes(decision)) return res.status(400).json({ status: false, code: 'INVALID_DECISION' });
    if (!firestoreReady()) return res.status(503).json({ status: false, code: 'FIREBASE_ADMIN_NOT_CONFIGURED' });
    try {
      const ref = db().collection('bug_reports').doc(String(req.params.id).replace(/[^\w-]/g, '').slice(0, 120));
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ status: false, code: 'BUG_NOT_FOUND' });
      const report = snap.data();
      if (report.status !== 'pending') return res.status(409).json({ status: false, code: 'BUG_ALREADY_DECIDED' });
      const stamp = now();
      const decisionMeta = { decision, by: OWNER_EMAIL, decidedAt: stamp };
      const update = { status: decision === 'accept' ? 'accepted' : 'declined', decision: decisionMeta, decisions: admin.firestore.FieldValue.arrayUnion(decisionMeta), updatedAt: stamp };
      if (decision === 'accept') {
        const jobRef = db().collection('repair_jobs').doc();
        await db().runTransaction(async (tx) => { tx.update(ref, update); tx.set(jobRef, { bugReportId: ref.id, status: 'queued', createdAt: stamp, updatedAt: stamp, source: 'owner_bug_decision', message: text(report.message, 3000), route: text(report.route, 500), aiSummary: text(report.aiSummary, 700), likelyCause: text(report.likelyCause, 700), decision: decisionMeta }); });
        return res.json({ status: true, decision, repairJobId: jobRef.id });
      }
      await ref.update(update);
      return res.json({ status: true, decision });
    } catch (err) { return res.status(500).json({ status: false, code: 'BUG_DECISION_FAILED', message: 'Unable to save the bug decision.' }); }
  });
}

module.exports = { mount };
