// ╔══════════════════════════════════════════════════════════════════════════╗
// ║           MINDVORA SECURE BACKEND  —  server.js                         ║
// ║                                                                          ║
// ║  Security layers:                                                        ║
// ║   • CRLF injection defense (auto-ban after 5 strikes)                   ║
// ║   • Rate limiting (150 req/min per IP, sliding window)                  ║
// ║   • All security headers (HSTS, CSP, X-Frame, etc.)                     ║
// ║   • Zero stack-trace leaks in production                                ║
// ║   • WebSocket server for real-time messaging & WebRTC signaling         ║
// ║   • Live streaming room management                                       ║
// ║                                                                          ║
// ║  Deployment: Railway.com / Render.com                                   ║
// ╚══════════════════════════════════════════════════════════════════════════╝

'use strict';
const envFix = require('./lib/env-fix');   // must run before anything reads settings
const SERVER_STARTED = new Date().toISOString();

// ── Core dependencies ─────────────────────────────────────────────────────
const http       = require('http');
const express    = require('express');
const cors       = require('cors');
const compression = require('compression');
const { WebSocketServer } = require('ws');

// ── Local security modules ────────────────────────────────────────────────
const {
  crlfGuard, bodyGuard, secureErrorHandler, getBanList, unbanIP,
  isAuthLocked, recordAuthFailure, clearAuthFailures, getClientIP,
} = require('./CRLF/defense.evi');
const { handleConnection, startHeartbeat, getLiveRooms } = require('./CRLF/ws-server.evi');
const { issueEmailOtp, checkEmailOtp, storage: otpStorage } = require('./lib/otp-store');
const mailer   = require('./lib/mailer');
const husmo    = require('./lib/husmo');
const catalog  = require('./lib/catalog');
const payments = require('./lib/payments');
const { requireUser, userFromRequest, verifyIdTokenAny } = require('./lib/auth-user');
const { admin: fbAdmin, db: fdb, auth: fauth, firebaseAdminConfigured, firebaseAdminError } = require('./lib/firebase-admin');
const { verifyRecaptcha }                                 = require('./lib/recaptcha');
const { startReferralIntegrityJob, runIntegrityCheck }    = require('./lib/referral-integrity');
const crypto = require('crypto');
const calls  = require('./lib/calls');
const realtime = require('./lib/realtime');
const push   = require('./lib/push');
const rtc    = require('./lib/rtc');

// ── Pre-resolve fetch ONCE at startup (not per-request) ──────────────────
// Dynamic import on every call added 50-100ms latency per API request.
// FIX: this used to be fire-and-forget, so a request arriving before the
// import resolved (very plausible right after a Render cold start) got
// `fetch === undefined`, silently breaking reCAPTCHA/NOWPayments/Paystack
// calls with an uncaught exception the client never saw a response for.
// We now block server.listen() on this promise so fetch is guaranteed to
// be ready before the server accepts its first connection.
let fetch;
const fetchReady = (async () => { fetch = (await import('node-fetch')).default; })();

// ── App setup ─────────────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;

// ── Remove Express fingerprint immediately ────────────────────────────────
app.disable('x-powered-by');
app.set('trust proxy', 1);

// ── CORS — strict allowlist ───────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://mindvora.app',
  'https://mindvora-vf8e.vercel.app',
  'https://mindvora-own8.vercel.app',
  'https://zync-social-vf8e.vercel.app',
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:8080',
  'https://www.mindvora.app',
  ...String(process.env.EXTRA_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean),
];
// FIX: any of your own Vercel deployments (production + preview URLs) is allowed,
// so a new Vercel URL no longer silently breaks OTP/payments with a CORS error.
const VERCEL_ORIGIN = /^https:\/\/(mindvora|zync-social)[a-z0-9-]*\.vercel\.app$/;

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, server-to-server)
    if (!origin || ALLOWED_ORIGINS.includes(origin) || VERCEL_ORIGIN.test(origin)) {
      return callback(null, true);
    }
    // FIX: passing an Error here turned every disallowed-origin request into
    // a 500 via the error handler. Just omit the CORS headers instead.
    callback(null, false);
  },
  credentials: true,
  // FIX: DELETE /api/admin/bans/:ip and the X-Admin-Secret header were not allowed.
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Admin-Secret'],
  exposedHeaders: [],
  maxAge: 86400,
}));

// ── Gzip compression — reduces payload size before sending ───────────────
app.use(compression());

// ── ⚔️  CRLF DEFENSE — must be first real middleware ─────────────────────
app.use(crlfGuard);

// ── Body parsing (after CRLF guard for body sanitization hook) ────────────
// 512kb is plenty for any route; 10mb was creating unnecessary large buffers.
// rawBody is kept for webhook signature checks (Paystack / NOWPayments sign the exact bytes).
app.use(express.json({ limit: '512kb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: false, limit: '512kb' }));
// FIX: body CRLF/SQLi checks must run AFTER parsing (they never ran before).
const WEBHOOK_PATHS = new Set(['/api/crypto/webhook', '/api/paystack/webhook']);
// Aria's chat text (code, SQL examples, HTML) is only ever sent to the AI model — never into headers, HTML or the
// database — so the SQL/CRLF body filter must not reject it or count it as a ban strike. lib/aria.js caps its size,
// validates roles and rate-limits it.
const GUARD_EXEMPT = new Set(['/api/aria/chat']);
app.use((req, res, next) => ((WEBHOOK_PATHS.has(req.path) || GUARD_EXEMPT.has(req.path)) ? next() : bodyGuard(req, res, next)));

// ── Admin secret for sensitive endpoints ──────────────────────────────────
// FIX: the old fallback 'mindvora-admin-change-me' meant anyone could run the
// account-disabling sweep if ADMIN_SECRET was not set. Admin routes are now
// closed until ADMIN_SECRET is configured, and the compare is timing-safe.
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';

function safeEqual(a, b) {
  const ab = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function requireAdmin(req, res, next) {
  if (!ADMIN_SECRET) {
    return res.status(503).json({ error: 'Admin API disabled (ADMIN_SECRET not set).', code: 'ADMIN_NOT_CONFIGURED' });
  }
  const secret = req.headers['x-admin-secret'] || req.query._adm;
  if (!safeEqual(secret, ADMIN_SECRET)) {
    return res.status(401).json({ error: 'Unauthorized', code: 'ADMIN_AUTH_FAILED' });
  }
  next();
}

/** POST /api/admin/run-referral-check — manually trigger the referral payout
 *  + stale-account disable sweep, instead of waiting for the 6-hour timer. */
app.post('/api/admin/run-referral-check', requireAdmin, async (_req, res) => {
  try {
    const result = await runIntegrityCheck();
    if (!result) {
      return res.status(500).json({ status: false, message: 'Firebase Admin is not configured yet (add the Firebase service account on Render).' });
    }
    res.json({ status: true, ...result });
  } catch (err) {
    res.status(500).json({ status: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ──  HEALTH & WARMUP  ──────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

app.get('/', (_req, res) => {
  res.json({ status: 'Mindvora Backend ✅', time: new Date().toISOString() });
});

app.get('/api/crypto/status/ping',   (_req, res) => res.json({ status: 'awake',  time: new Date().toISOString() }));
app.get('/api/crypto/status/warmup', (_req, res) => res.json({ status: 'warm',   time: new Date().toISOString() }));

// ═══════════════════════════════════════════════════════════════════════════
// ──  ADMIN ENDPOINTS (protected)  ──────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

/** GET /api/admin/bans — list all currently banned IPs */
app.get('/api/admin/bans', requireAdmin, (_req, res) => {
  res.json({ bans: getBanList() });
});

/** DELETE /api/admin/bans/:ip — unban an IP */
app.delete('/api/admin/bans/:ip', requireAdmin, (req, res) => {
  unbanIP(req.params.ip);
  res.json({ success: true, message: `IP ${req.params.ip} unbanned.` });
});

/** GET /api/admin/lives — list all active live streams */
app.get('/api/admin/lives', requireAdmin, (_req, res) => {
  res.json({ lives: getLiveRooms() });
});

// ═══════════════════════════════════════════════════════════════════════════
// ──  LIVE STREAMING REST API  ──────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

/** GET /api/lives — public list of active streams */
app.get('/api/lives', (_req, res) => {
  res.json({ lives: getLiveRooms() });
});

// ═══════════════════════════════════════════════════════════════════════════
// ──  NOWPAYMENTS — Crypto Invoice  ─────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

app.post('/api/crypto/create-invoice', requireUser, async (req, res) => {
  // FIX: the price is now computed on the server from { purpose, params } —
  // the browser can no longer decide how much it pays or what it unlocks.
  const { purpose, params } = req.body || {};
  const priced = catalog.priceOrder(purpose, params, req.user.uid);
  if (!priced.ok) return res.status(400).json({ status: false, message: priced.message });
  if (!process.env.NOWPAYMENTS_API_KEY) {
    return res.status(503).json({ status: false, message: 'Crypto payments are not configured (NOWPAYMENTS_API_KEY missing).' });
  }
  const orderId = `MV-${req.user.uid}-${Date.now()}`;
  try {
    const response = await fetch('https://api.nowpayments.io/v1/invoice', {
      method: 'POST',
      headers: { 'x-api-key': process.env.NOWPAYMENTS_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        price_amount:      priced.usd,
        price_currency:    'usd',
        order_id:          orderId,
        order_description: priced.description,
        ipn_callback_url:  process.env.IPN_URL || `https://${req.get('host')}/api/crypto/webhook`,
        success_url:       process.env.APP_URL || req.get('origin') || 'https://mindvora.app',
        cancel_url:        process.env.APP_URL || req.get('origin') || 'https://mindvora.app',
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.id || !data.invoice_url) {
      console.error('[CRYPTO] create-invoice failed:', response.status, JSON.stringify(data).slice(0, 300));
      return res.status(502).json({ status: false, message: 'Payment provider error.' });
    }
    await fdb().collection('crypto_orders').doc(String(data.id)).set({
      uid: req.user.uid, purpose, params: priced.params, usd: priced.usd, orderId,
      payment_status: 'waiting', fulfilled: false, createdAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
    });
    res.json({ status: true, id: String(data.id), invoice_url: data.invoice_url, amountUSD: priced.usd });
  } catch (err) {
    console.error('[CRYPTO] create-invoice error:', err.message);
    res.status(500).json({ status: false, message: 'Unable to create invoice. Please try again.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ──  NOWPAYMENTS — Status + IPN webhook  ────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

function sortKeysDeep(v) {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === 'object') {
    return Object.keys(v).sort().reduce((o, k) => { o[k] = sortKeysDeep(v[k]); return o; }, {});
  }
  return v;
}

// NOWPayments signs HMAC-SHA512(JSON with keys sorted, IPN secret) in x-nowpayments-sig.
function verifyNowpaymentsSig(req) {
  const secret = process.env.NOWPAYMENTS_IPN_SECRET;
  if (!secret) return false;
  let payload;
  try { payload = JSON.parse(req.rawBody ? req.rawBody.toString('utf8') : '{}'); } catch (_) { return false; }
  const sig = String(req.headers['x-nowpayments-sig'] || '');
  const expected = crypto.createHmac('sha512', secret).update(JSON.stringify(sortKeysDeep(payload))).digest('hex');
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

app.get('/api/crypto/status/:invoiceId', requireUser, async (req, res) => {
  const { invoiceId } = req.params;
  if (!/^[\w-]{1,100}$/.test(invoiceId)) return res.status(400).json({ status: false, message: 'Invalid invoice ID.' });
  try {
    const snap = await fdb().collection('crypto_orders').doc(invoiceId).get();
    if (!snap.exists || snap.data().uid !== req.user.uid) return res.status(404).json({ status: false, message: 'Order not found.' });
    const o = snap.data();
    res.json({ status: true, invoice_id: invoiceId, payment_status: o.payment_status, fulfilled: !!o.fulfilled,
      purpose: o.purpose, result: o.result || null, pay_currency: o.pay_currency || null });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Unable to fetch status. Please try again.' });
  }
});

app.post('/api/crypto/webhook', async (req, res) => {
  if (!verifyNowpaymentsSig(req)) {
    console.warn('[WEBHOOK] Rejected NOWPayments IPN — bad/missing signature or NOWPAYMENTS_IPN_SECRET not set.');
    return res.status(401).send('Invalid signature');
  }
  const payload = JSON.parse(req.rawBody.toString('utf8'));
  const invId = payload.invoice_id != null ? String(payload.invoice_id) : null;
  if (!invId || !firebaseAdminConfigured()) return res.status(200).send('OK');
  try {
    const ref = fdb().collection('crypto_orders').doc(invId);
    const snap = await ref.get();
    if (!snap.exists) { console.warn('[WEBHOOK] IPN for unknown invoice', invId); return res.status(200).send('OK'); }
    const order = snap.data();
    await ref.update({ payment_status: payload.payment_status, pay_currency: payload.pay_currency || null,
      pay_amount: payload.pay_amount || null, payment_id: payload.payment_id || null });
    // FIX: 'partially_paid' used to unlock features. Only finished/confirmed count now.
    const paid = payload.payment_status === 'finished' || payload.payment_status === 'confirmed';
    if (paid && !order.fulfilled) {
      if (Number(payload.price_amount) + 0.01 < Number(order.usd)) {
        console.error(`[WEBHOOK] Invoice ${invId} price ${payload.price_amount} < order ${order.usd}`);
      } else {
        const out = await payments.fulfil({ provider: 'nowpayments', reference: invId, uid: order.uid,
          purpose: order.purpose, params: order.params, usd: order.usd });
        await ref.update({ fulfilled: true, result: out.result || null });
      }
    }
    res.status(200).send('OK');
  } catch (err) {
    console.error('[WEBHOOK] NOWPayments processing error:', err.message);
    res.status(500).send('Retry'); // NOWPayments retries on non-200
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ──  EXCHANGE RATE PROXY  ────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

// In-memory rate cache — avoids hammering the external API on every request
const rateCache = new Map(); // key: 'FROM_TO' → { rate, expiresAt }
const RATE_TTL_MS = 60 * 1000; // cache for 60 seconds

app.get('/api/rate/:from/:to', async (req, res) => {
  const { from, to } = req.params;
  if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) {
    return res.status(400).json({ error: 'Invalid currency codes.' });
  }

  // Serve from cache if fresh
  const cacheKey = `${from}_${to}`;
  const cached   = rateCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    res.set('X-Rate-Cache', 'HIT');
    return res.json({ from, to, rate: cached.rate });
  }

  try {
    const response = await fetch(`https://api.exchangerate-api.com/v4/latest/${from}`);
    if (!response.ok) return res.json({ from, to, rate: 1 });
    const data = await response.json();
    const rate = data.rates?.[to] || 1;
    rateCache.set(cacheKey, { rate, expiresAt: Date.now() + RATE_TTL_MS });
    res.set('X-Rate-Cache', 'MISS');
    res.json({ from, to, rate });
  } catch (_) {
    res.json({ from, to, rate: 1 });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ──  HUSMODATA VTU — Airtime  ────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

// FIX: /api/husmo-airtime and /api/husmo-data used to be PUBLIC — anyone could
// call them and spend your Husmodata wallet without paying. Delivery now happens
// only inside lib/payments.js after a payment is confirmed. These routes remain
// for ADMIN manual retries only.
app.post('/api/husmo-airtime', requireAdmin, async (req, res) => {
  const { phone, network, amountNGN } = req.body || {};
  const net = catalog.normNetwork(network); const ph = husmo.normalizePhone(phone);
  if (!net || !ph || !(Number(amountNGN) >= 50)) return res.status(400).json({ status: false, message: 'Need network, 11-digit phone, amountNGN >= 50.' });
  try { res.json(await husmo.buyAirtime({ network: net, phone: ph, amountNGN: Number(amountNGN) })); }
  catch (e) { res.status(500).json({ status: false, message: e.message }); }
});

app.post('/api/husmo-data', requireAdmin, async (req, res) => {
  const { phone, network, bundle, planId } = req.body || {};
  const net = catalog.normNetwork(network); const ph = husmo.normalizePhone(phone);
  if (!net || !ph) return res.status(400).json({ status: false, message: 'Need network and 11-digit phone.' });
  const plan = planId ? { planId: String(planId) } : await husmo.resolvePlanId(net, bundle);
  if (!plan.planId) return res.status(400).json({ status: false, message: `No plan id for ${net} ${bundle}.` });
  try { res.json({ planId: plan.planId, ...(await husmo.buyData({ network: net, phone: ph, planId: plan.planId })) }); }
  catch (e) { res.status(500).json({ status: false, message: e.message }); }
});

app.get('/api/husmo-balance', requireAdmin, async (_req, res) => {
  try {
    const r = await husmo.balance();
    if (!r.ok) return res.status(r.status).json({ status: false, message: 'Balance check failed.' });
    const d = r.data || {};
    res.json({ status: true, balance: d.user ? d.user.wallet_balance ?? d.user.Account_Balance : d.wallet_balance ?? d.balance ?? null });
  } catch (_) { res.status(500).json({ status: false, message: 'Unable to fetch balance.' }); }
});

// Shows which Husmodata plan id each Mindvora bundle maps to — use this to fill HUSMO_PLAN_MAP.
app.get('/api/admin/husmo-plans', requireAdmin, async (_req, res) => {
  try {
    const plans = await husmo.accountPlans(true);
    const mapping = {};
    for (const net of ['mtn', 'glo', 'airtel', '9mobile']) {
      mapping[net] = {};
      for (const b of Object.keys(catalog.DATA_BUNDLES)) mapping[net][b] = (await husmo.resolvePlanId(net, b)).planId;
    }
    res.json({ status: true, mapping, plansFoundOnAccount: plans.length, plans });
  } catch (e) { res.status(500).json({ status: false, message: e.message }); }
});


// ═══════════════════════════════════════════════════════════════════════════
// ──  CALLS, PUSH, APP VERSION, PUBLIC CONFIG  ─────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

// STUN/TURN servers for voice & video calls (TURN credentials never live in the browser code).
app.get('/api/rtc/ice-servers', async (req, res) => {
  const user = await userFromRequest(req);
  if (!user && firebaseAdminConfigured()) return res.status(401).json({ status: false, code: 'AUTH_REQUIRED', message: 'Please log in again.' });
  const r = await rtc.iceServers();
  res.set('Cache-Control', 'private, max-age=600');
  res.json({ status: true, iceServers: r.servers, relay: r.source !== 'stun-only', relaySource: r.source });
});

// Values the browser needs that may change between test and live mode.
app.get('/api/public-config', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    status: true,
    paystackPublicKey: process.env.PAYSTACK_PUBLIC_KEY || null,
    paystackTestMode: /^sk_test_/.test(process.env.PAYSTACK_SECRET_KEY || ''),
    recaptchaSiteKey: process.env.RECAPTCHA_SITE_KEY || null,
    vapidKey: process.env.FCM_VAPID_KEY || null,
  });
});

// Forced-update check used by the web app and the Android/iOS app.
const APP_VERSION_FILE = require('./config/app-version.json');
function cmpVer(a, b) {
  const x = String(a || '0').split('.').map(Number), y = String(b || '0').split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
}
function featuresFor(platform, version) {
  const out = {};
  Object.entries(APP_VERSION_FILE.features || {}).forEach(([name, f]) => {
    if (!f || f.enabled !== true) return;                                   // owner flips this when ready
    if (Array.isArray(f.platforms) && !f.platforms.includes(platform)) return;
    if (f.minVersion && cmpVer(version || '0.0.0', f.minVersion) < 0) return; // older app: hidden until updated
    out[name] = true;
  });
  return out;
}
app.get('/api/app/version', (req, res) => {
  const platform = ['android', 'ios', 'web'].includes(req.query.platform) ? req.query.platform : 'web';
  const base = APP_VERSION_FILE[platform] || {};
  const env = (k) => process.env[`APP_${platform.toUpperCase()}_${k}`];
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    status: true, platform,
    latest: env('LATEST') || base.latest,
    minSupported: env('MIN_SUPPORTED') || base.minSupported,
    minOs: env('MIN_OS') || base.minOs || null,
    storeUrl: env('STORE_URL') || base.storeUrl || null,
    message: base.message || 'A new version of Mindvora is available.',
    features: featuresFor(platform, String(req.query.version || '')),
  });
});

// Admin: send yourself a test push notification.  POST { uid, title?, body? }
app.post('/api/admin/test-push', requireAdmin, async (req, res) => {
  try {
    const uid = String((req.body && req.body.uid) || '');
    if (!uid) return res.status(400).json({ status: false, message: 'Send { "uid": "<your user id>" }' });
    const r = await push.sendToUser(uid, { title: (req.body.title || 'Mindvora test'), body: (req.body.body || 'Push notifications are working 🎉'), type: 'general' });
    res.json({ status: r.sent > 0, ...r });
  } catch (e) { res.status(500).json({ status: false, message: e.message }); }
});

// Admin: Husmodata live test. Dry run by default (shows exactly what WOULD be sent).
// POST { network:"mtn", phone:"0803…", bundle:"500MB" }            → dry run
// POST { network:"mtn", phone:"0803…", airtimeNGN:50, send:true }   → real ₦50 airtime
// POST { network:"mtn", phone:"0803…", bundle:"500MB", send:true }  → real data purchase
app.post('/api/admin/husmo-test', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const network = String(b.network || '').toLowerCase();
    const phone = husmo.normalizePhone(b.phone);
    if (!husmo.NETWORK_IDS[network] || !phone) return res.status(400).json({ status: false, message: 'Need network (mtn/glo/airtel/9mobile) and a valid Nigerian phone.' });
    if (!husmo.configured()) return res.status(503).json({ status: false, message: 'HUSMODATA_API_KEY is not set on Render.' });
    const out = { network, networkId: husmo.NETWORK_IDS[network], phone };
    if (b.airtimeNGN) {
      out.kind = 'airtime'; out.amountNGN = Math.max(50, Math.min(500, Math.round(Number(b.airtimeNGN) || 0)));
    } else {
      out.kind = 'data'; out.bundle = String(b.bundle || '');
      const plan = await husmo.resolvePlanId(network, out.bundle);
      out.planId = plan.planId; out.planSource = plan.source;
      if (!plan.planId) return res.json({ status: false, ...out, message: 'No plan id found for this bundle. Add it to HUSMO_PLAN_MAP (see /api/admin/husmo-plans).' });
    }
    if (b.send !== true) return res.json({ status: true, dryRun: true, ...out, message: 'Dry run only — nothing was bought. Add "send": true to buy for real.' });
    const r = out.kind === 'airtime'
      ? await husmo.buyAirtime({ network, phone, amountNGN: out.amountNGN })
      : await husmo.buyData({ network, phone, planId: out.planId });
    res.json({ status: r.status !== 'failed', dryRun: false, ...out, result: r.status, husmoReply: r.provider });
  } catch (e) { res.status(500).json({ status: false, message: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// ──  NODEMAILER — Email OTP Delivery  ────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
//
// Email is sent through lib/mailer.js (Brevo / Resend over HTTPS, or SMTP).
// FIX: Render FREE services block SMTP ports 25/465/587 since 26 Sept 2025,
// which is why verification emails timed out — use BREVO_API_KEY.

const OTP_EMAIL_HTML = (code) =>
  '<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:auto;background:#0d2118;border:1px solid #166534;border-radius:16px;padding:28px">' +
    '<div style="text-align:center;color:#ffffff;font-size:22px;font-weight:700;margin-bottom:4px">🌿 Mindvora</div>' +
    '<div style="text-align:center;color:#00C896;font-size:11px;letter-spacing:2px;margin-bottom:24px">WHERE MINDS CONNECT</div>' +
    '<div style="color:#e2e8f0;font-size:14px;line-height:1.7;margin-bottom:16px">Hello! Your Mindvora verification code is:</div>' +
    '<div style="text-align:center;font-size:32px;font-weight:700;letter-spacing:10px;color:#00C896;background:#0a1a0f;border:1px solid #166534;border-radius:12px;padding:16px;margin-bottom:16px">' + code + '</div>' +
    '<div style="color:#94a3b8;font-size:12px;line-height:1.6">This code expires in 10 minutes. If you did not request this, you can safely ignore this email.</div>' +
  '</div>';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** POST /api/auth/password-reset { email, continueUrl }
 *  Sends the Firebase reset link through Brevo (reliable inbox delivery).
 *  Needs Firebase Admin; without it answers 503 so the website falls back
 *  to Firebase's own reset email. Always answers the same for unknown emails. */
const _resetHits = new Map();
app.post('/api/auth/password-reset', async (req, res) => {
  const email = String((req.body && req.body.email) || '').toLowerCase().trim();
  if (!EMAIL_RE.test(email)) return res.status(400).json({ status: false, code: 'BAD_EMAIL', message: 'Please enter a valid email address.' });
  const ip = req.ip || 'x'; const now = Date.now();
  const hits = (_resetHits.get(ip) || []).filter((t) => now - t < 15 * 60 * 1000);
  if (hits.length >= 5) return res.status(429).json({ status: false, code: 'RATE_LIMIT', message: 'Too many reset requests. Wait 15 minutes and try again.' });
  hits.push(now); _resetHits.set(ip, hits);
  if (!firebaseAdminConfigured() || !mailer.provider()) {
    return res.status(503).json({ status: false, code: 'RESET_NOT_CONFIGURED', message: 'Server reset email not set up; use Firebase fallback.' });
  }
  let continueUrl = String((req.body && req.body.continueUrl) || '');
  if (!/^https:\/\/[a-z0-9.-]+(\/.*)?$/i.test(continueUrl)) continueUrl = process.env.FRONTEND_URL || 'https://mindvora-own8.vercel.app';
  try {
    let link;
    try { link = await fauth().generatePasswordResetLink(email, { url: continueUrl }); }
    catch (e) {
      if (e && e.code === 'auth/user-not-found') { console.log('[reset] no account for', email); return res.json({ status: true }); }
      if (e && /continue|unauthorized|domain/i.test(String(e.code || e.message))) link = await fauth().generatePasswordResetLink(email);
      else throw e;
    }
    await mailer.sendMail({ to: email, subject: 'Reset your Mindvora password',
      text: 'Tap this link to choose a new Mindvora password: ' + link + '\n\nIf you did not ask for this, ignore this email.',
      html: '<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;background:#0a1a0f;color:#e2e8f0;border-radius:14px">' +
        '<h2 style="color:#22c55e;margin-top:0">Reset your password</h2><p>Tap the button to choose a new Mindvora password.</p>' +
        '<p style="text-align:center;margin:24px 0"><a href="' + link + '" style="background:#22c55e;color:#04110a;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:700">Choose new password</a></p>' +
        '<p style="font-size:12px;color:#94a3b8">This link expires in 1 hour. If you did not ask for this, ignore this email.</p></div>' });
    console.log('[reset] link sent via', mailer.provider(), 'to', email);
    return res.json({ status: true });
  } catch (err) {
    console.error('[reset] failed:', err && (err.code || ''), err && err.message);
    return res.status(502).json({ status: false, code: 'RESET_FAILED', message: 'Could not send the reset email right now. Please try again.' });
  }
});

/** GET /api/recaptcha-config — which reCAPTCHA the website should show (public info only). */
app.get('/api/recaptcha-config', (_req, res) => res.json(require('./lib/recaptcha').recaptchaPublicConfig()));

/** POST /api/otp/send-email { email, recaptcha } */
app.post('/api/otp/send-email', async (req, res) => {
  const ip = getClientIP(req);
  if (isAuthLocked(ip, 'otp-send-email')) {
    return res.status(429).json({ status: false, code: 'LOCKED', message: 'Too many failed attempts from your network. Try again in 15 minutes.' });
  }
  const { email, recaptcha } = req.body || {};
  if (!email || !EMAIL_RE.test(String(email))) {
    return res.status(400).json({ status: false, code: 'BAD_EMAIL', message: 'Invalid email address.' });
  }
  const normalized = String(email).toLowerCase().trim();

  const captcha = await verifyRecaptcha(recaptcha, fetch, 'send_email_otp');
  const enforced = process.env.RECAPTCHA_ENFORCE !== 'false';
  if (!captcha.ok) {
    if (!captcha.configured && enforced) {
      return res.status(503).json({ status: false, code: 'CAPTCHA_NOT_CONFIGURED', message: 'Verification is not set up on the server yet (RECAPTCHA_SECRET_KEY missing).' });
    }
    if (enforced) {
      // A MISSING token is the visitor's browser/domain problem, not an attack — don't count it as a strike.
      if (captcha.reason !== 'no-token') recordAuthFailure(ip, 'otp-send-email');
      return res.status(403).json({ status: false, code: captcha.reason === 'no-token' ? 'CAPTCHA_NO_TOKEN' : 'CAPTCHA_FAILED',
        message: captcha.reason === 'no-token'
          ? 'Security check could not load in your browser. Disable ad-blockers / tracking protection for this site and try again.'
          : 'Could not verify you are human. Please refresh the page and try again.' });
    }
    console.warn(`[reCAPTCHA] ${captcha.reason} but RECAPTCHA_ENFORCE=false — sending anyway to ${normalized}.`);
  }

  if (!mailer.provider()) {
    console.error('[OTP] No email provider configured. Set BREVO_API_KEY + EMAIL_FROM on Render.');
    return res.status(503).json({ status: false, code: 'EMAIL_NOT_CONFIGURED', message: 'Email service is not configured on the server yet.' });
  }

  const issued = await issueEmailOtp(normalized);
  if (issued.cooldown) {
    return res.status(429).json({ status: false, code: 'COOLDOWN', retryAfter: issued.retryAfter, message: `Please wait ${issued.retryAfter}s before requesting another code.` });
  }
  if (issued.rateLimited) {
    return res.status(429).json({ status: false, code: 'RATE_LIMITED', message: 'Too many codes sent to this email. Try again in an hour.' });
  }

  try {
    const sent = await mailer.sendMail({
      to: normalized,
      subject: 'Mindvora — Your verification code',
      html: OTP_EMAIL_HTML(issued.code),
      text: `Your Mindvora verification code is ${issued.code}. It expires in 10 minutes.`,
    });
    console.log(`[OTP] Email sent to ${normalized} via ${sent.provider} (store: ${otpStorage()}).`);
    res.json({ status: true, message: 'Verification code sent. Check your inbox and spam folder.' });
  } catch (err) {
    await issued.rollback(); // FIX: a failed send no longer burns the cooldown / hourly quota
    console.error('[OTP] Email send failed:', err.message);
    res.status(502).json({ status: false, code: err.code || 'EMAIL_SEND_FAILED', message: 'Could not send the email right now. Please try again in a minute.' });
  }
});

/** POST /api/otp/verify-email { email, code }  (+ optional Authorization: Bearer <idToken>) */
app.post('/api/otp/verify-email', async (req, res) => {
  const ip = getClientIP(req);
  if (isAuthLocked(ip, 'otp-verify-email')) {
    return res.status(429).json({ status: false, code: 'LOCKED', message: 'Too many failed attempts. Try again in 15 minutes.' });
  }
  const { email, code } = req.body || {};
  if (!email || !EMAIL_RE.test(String(email))) {
    return res.status(400).json({ status: false, code: 'BAD_EMAIL', message: 'Invalid email address.' });
  }
  if (!/^\d{6}$/.test(String(code || '').trim())) {
    return res.status(400).json({ status: false, code: 'BAD_CODE', message: 'Enter the 6-digit code you received.' });
  }
  const normalized = String(email).toLowerCase().trim();
  const result = await checkEmailOtp(normalized, String(code).trim());
  if (result.status !== 'ok') {
    if (result.status === 'invalid') recordAuthFailure(ip, 'otp-verify-email');
    return res.status(400).json({ status: false, code: result.status.toUpperCase(), message: result.message });
  }
  clearAuthFailures(ip, 'otp-verify-email');

  // If the caller is logged in as this email, mark the account verified server-side too.
  let profileUpdated = false;
  const user = await userFromRequest(req);
  if (user && String(user.email || '').toLowerCase() === normalized) {
    try {
      await fdb().collection('users').doc(user.uid).set({ emailVerified: true, verifiedAt: fbAdmin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      await fauth().updateUser(user.uid, { emailVerified: true });
      profileUpdated = true;
    } catch (e) { console.error('[OTP] Could not mark user verified:', e.message); }
  }
  return res.json({ status: true, message: 'Email verified.', profileUpdated });
});

// ═══════════════════════════════════════════════════════════════════════════
// ──  PAYSTACK — Redirect Checkout (fallback for Popup)  ─────────────────────
// ═══════════════════════════════════════════════════════════════════════════
//
// Server decides the amount from { purpose, params }; metadata carries uid +
// order so /verify and the webhook can fulfil it.

app.post('/api/paystack/initialize', requireUser, async (req, res) => {
  const { purpose, params, callbackUrl } = req.body || {};
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) return res.status(503).json({ status: false, message: 'Paystack is not configured yet (PAYSTACK_SECRET_KEY missing).' });
  const priced = catalog.priceOrder(purpose, params, req.user.uid);
  if (!priced.ok) return res.status(400).json({ status: false, message: priced.message });
  try {
    const resp = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: req.user.email, amount: catalog.usdToKobo(priced.usd), currency: 'NGN',
        reference: `MV-${purpose}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
        metadata: { uid: req.user.uid, purpose, params: priced.params },
        callback_url: typeof callbackUrl === 'string' && /^https?:\/\//.test(callbackUrl) ? callbackUrl : undefined,
      }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.status) return res.status(502).json({ status: false, message: data.message || 'Paystack error.' });
    res.json({ status: true, authorization_url: data.data.authorization_url, reference: data.data.reference });
  } catch (_) {
    res.status(500).json({ status: false, message: 'Could not initialize payment. Please try again.' });
  }
});

/** POST /api/pay/paystack/verify { reference } — called by the browser after the popup succeeds. */
app.post('/api/pay/paystack/verify', requireUser, async (req, res) => {
  const reference = String((req.body && req.body.reference) || '');
  if (!/^[\w.=-]{3,100}$/.test(reference)) return res.status(400).json({ status: false, message: 'Invalid reference.' });
  try {
    const out = await payments.confirmPaystack(reference, req.user.uid);
    if (!out.ok) return res.status(400).json({ status: false, code: out.code, message: out.message });
    res.json({ status: true, purpose: out.purpose, already: out.already, result: out.result });
  } catch (err) {
    console.error('[PAYSTACK] verify error:', err.message);
    res.status(502).json({ status: false, code: err.code || 'VERIFY_ERROR', message: 'Could not confirm the payment yet. If you were charged, it will be applied automatically.' });
  }
});

/** Paystack webhook — backup path so a payment is applied even if the user closes the tab. */
app.post('/api/paystack/webhook', async (req, res) => {
  const secret = process.env.PAYSTACK_SECRET_KEY || '';
  const sig = String(req.headers['x-paystack-signature'] || '');
  const expected = secret && req.rawBody ? crypto.createHmac('sha512', secret).update(req.rawBody).digest('hex') : '';
  if (!expected || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return res.status(401).send('Invalid signature');
  }
  res.status(200).send('OK'); // acknowledge fast, process after
  try {
    const evt = JSON.parse(req.rawBody.toString('utf8'));
    if (evt.event === 'charge.success' && evt.data && evt.data.reference && firebaseAdminConfigured()) {
      const out = await payments.confirmPaystack(evt.data.reference, null);
      if (!out.ok) console.warn('[PAYSTACK] webhook not fulfilled:', out.code, out.message);
    }
  } catch (err) { console.error('[PAYSTACK] webhook processing error:', err.message); }
});

// ═══════════════════════════════════════════════════════════════════════════
// ──  HEALTH / DIAGNOSTICS  ───────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
// Public: only true/false flags, no secrets. Open it in a browser to see what is missing.
require('./lib/aria').mount(app, { userFromRequest });
require('./lib/live-content').mount(app);

app.get('/api/health', (_req, res) => {
  const email = mailer.describe();
  res.json({
    status: 'ok',
    serverStartedAt: SERVER_STARTED,
    deployedCommit: (process.env.RENDER_GIT_COMMIT || '').slice(0, 7) || null,
    codeVersion: 'v14-auth-fix',
    firebaseAdmin: firebaseAdminConfigured(),
    recaptchaSecret: !!(process.env.RECAPTCHA_SECRET_KEY || process.env.RECAPTCHA_V2_SECRET_KEY),
    recaptchaVersion: (process.env.RECAPTCHA_V2_SECRET_KEY && process.env.RECAPTCHA_V2_SITE_KEY) ? 'v2-checkbox' : (process.env.RECAPTCHA_V2_SECRET_KEY ? 'v2-SITE-KEY-MISSING' : 'v3-invisible'),
    firebaseAdminProblem: firebaseAdminConfigured() ? null : (firebaseAdminError() || null),
    recaptchaEnforced: process.env.RECAPTCHA_ENFORCE !== 'false',
    emailProvider: email.provider,
    emailFromSet: !!email.from,
    emailWarnings: email.warnings,
    otpStorage: otpStorage(),
    paystack: !!process.env.PAYSTACK_SECRET_KEY,
    paystackMode: /^sk_test_/.test(process.env.PAYSTACK_SECRET_KEY || '') ? 'test' : (process.env.PAYSTACK_SECRET_KEY ? 'live' : 'not-set'),
    paystackPublicKeySet: !!process.env.PAYSTACK_PUBLIC_KEY,
    callsTurnRelay: rtc.turnSource() === 'stun-only' ? 'public-fallback (add METERED_DOMAIN + METERED_API_KEY for reliable calls)' : rtc.turnSource(),
    calls: calls.stats(),
    pushVapidKeySet: !!process.env.FCM_VAPID_KEY,
    creatorShare: Number(process.env.CREATOR_SHARE || 0.9),
    nowpayments: !!process.env.NOWPAYMENTS_API_KEY,
    nowpaymentsIpnSecret: !!process.env.NOWPAYMENTS_IPN_SECRET,
    paymentsReady: firebaseAdminConfigured(),
    husmodata: husmo.configured(),
    adminSecret: !!process.env.ADMIN_SECRET,
    ariaAI: require('./lib/aria').provider() || false,
    callsLoginCheck: firebaseAdminConfigured() ? 'firebase-admin' : 'google-public-certs',
    settingsSeen: envFix.seen(),
    secretFiles: envFix.secretFileNames(),
    settingsAutoFixed: envFix.fixes,
    passwordResetEmail: (firebaseAdminConfigured() && !!mailer.provider()) ? 'brevo' : 'firebase-default',
  });
});

// Admin: send a test email to check the provider end-to-end.
app.post('/api/admin/test-email', requireAdmin, async (req, res) => {
  const to = String((req.body && req.body.to) || '');
  if (!EMAIL_RE.test(to)) return res.status(400).json({ status: false, message: 'Provide { "to": "you@example.com" }' });
  try {
    const r = await mailer.sendMail({ to, subject: 'Mindvora test email', html: '<p>It works ✅</p>', text: 'It works' });
    res.json({ status: true, provider: r.provider });
  } catch (e) { res.status(502).json({ status: false, code: e.code, message: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// ──  404 CATCH-ALL  ──────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found.', code: 'NOT_FOUND' });
});

// ── Secure error handler (must be LAST) ───────────────────────────────────
app.use(secureErrorHandler);

// ═══════════════════════════════════════════════════════════════════════════
// ──  HTTP + WEBSOCKET SERVER  ────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

const server = http.createServer(app);

// Attach WebSocket server to the same HTTP port (no extra port needed)
// perMessageDeflate off: compressing tiny call/chat packets costs more time than it saves.
const wss = new WebSocketServer({ server, path: '/ws', perMessageDeflate: false, maxPayload: 256 * 1024 });

calls.init({
  verifyToken: async (token) => {
    if (process.env.WS_DEV_AUTH === 'true' && /^dev:/.test(token)) return { uid: token.slice(4) }; // local testing only
    // Works with OR without Firebase Admin (falls back to Google's token check).
    return verifyIdTokenAny(token);
  },
  pushToUser: (uid, msg) => push.sendToUser(uid, msg),
  saveNotif: async (toUid, type, text, extra) => {
    if (!firebaseAdminConfigured()) return;
    await fdb().collection('notifications').add({ toUid, type, text, read: false, ...(extra || {}),
      createdAt: fbAdmin.firestore.FieldValue.serverTimestamp() });
  },
});
const WS_EXTRA = {
  // One socket for everything: login, calls, messages, typing, presence, live notifications.
  handles: (t) => t === 'AUTH' || /^CALL_/.test(t) || /^RT_/.test(t),
  handle: (ws, msg) => (/^RT_/.test(msg.type) ? realtime.handle(ws, msg) : calls.handleMessage(ws, msg)),
  onClose: (ws) => calls.onClose(ws),
};

wss.on('connection', (ws, req) => {
  handleConnection(ws, req, WS_EXTRA);
});

// Heartbeat to detect stale connections
startHeartbeat(wss);

// Referral fraud prevention: pay qualified referrals, disable stale accounts.
// No-ops gracefully if FIREBASE_SERVICE_ACCOUNT_B64 isn't set yet.
startReferralIntegrityJob();

// Turn new notification documents into phone/desktop push notifications.
push.onNotification((uid, payload) => realtime.emit(uid, payload));
push.startNotificationWatcher();

fetchReady.then(() => {
  server.listen(PORT, () => {
    console.log(`🚀 Mindvora Backend running on port ${PORT}`);
    console.log(`🔌 WebSocket server active on /ws`);
    console.log(`🛡️  CRLF Defense System active`);
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
    const em = mailer.describe();
    console.log(`📧 Email provider: ${em.provider || 'NONE'} | OTP store: ${otpStorage()} | Firebase Admin: ${firebaseAdminConfigured()}`);
    em.warnings.forEach((w) => console.warn('⚠️  ' + w));

    // ── Self-ping every 14 min to prevent Railway cold starts ────────────────
    // Railway spins down idle free-tier servers after ~15 min of inactivity.
    // This keeps the server warm so the first real user request is instant.
    // FIX: only Railway was handled; Render sets RENDER_EXTERNAL_URL.
    const SELF_URL = process.env.RENDER_EXTERNAL_URL
      ? `${process.env.RENDER_EXTERNAL_URL}/api/crypto/status/ping`
      : process.env.RAILWAY_STATIC_URL
        ? `https://${process.env.RAILWAY_STATIC_URL}/api/crypto/status/ping`
        : null;

    if (SELF_URL && process.env.NODE_ENV === 'production') {
      setInterval(async () => {
        try {
          if (fetch) await fetch(SELF_URL, { method: 'GET' });
        } catch (_) { /* silent — just a keep-alive ping */ }
      }, 14 * 60 * 1000); // every 14 minutes
      console.log(`🏓 Self-ping active → ${SELF_URL}`);
    }
  });
});

// ── Graceful shutdown ─────────────────────────────────────────────────────
process.on('SIGTERM', () => {
  console.log('[MINDVORA] SIGTERM received — shutting down gracefully');
  wss.close(() => {
    server.close(() => {
      console.log('[MINDVORA] Server closed.');
      process.exit(0);
    });
  });
});

process.on('uncaughtException', (err) => {
  console.error('[MINDVORA CRITICAL] Uncaught exception:', err.message);
  // Don't exit — log and continue
});

process.on('unhandledRejection', (reason) => {
  console.error('[MINDVORA CRITICAL] Unhandled rejection:', reason);
});
