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

// ── Core dependencies ─────────────────────────────────────────────────────
const http       = require('http');
const https      = require('https');
const express    = require('express');
const cors       = require('cors');
const compression = require('compression');
const { WebSocketServer } = require('ws');

// ── Local security modules ────────────────────────────────────────────────
const { crlfGuard, secureErrorHandler, getBanList, unbanIP } = require('./CRLF/defense.evi');
const { handleConnection, startHeartbeat, getLiveRooms }     = require('./CRLF/ws-server.evi');

// ── Pre-resolve fetch ONCE at startup with HTTP connection pooling ────────
// Connection pooling with keepAlive reduces overhead of establishing new connections
let fetch;
const httpAgent = new http.Agent({ 
  keepAlive: true, 
  maxSockets: 50, 
  maxFreeSockets: 10, 
  timeout: 60000, 
  keepAliveMsecs: 30000 
});
const httpsAgent = new https.Agent({ 
  keepAlive: true, 
  maxSockets: 50, 
  maxFreeSockets: 10, 
  timeout: 60000, 
  keepAliveMsecs: 30000 
});
(async () => { fetch = (await import('node-fetch')).default; })();

// ── App setup ─────────────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;

// ── Remove Express fingerprint immediately ────────────────────────────────
app.disable('x-powered-by');
app.set('trust proxy', 1);

// ── CORS — strict allowlist ───────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://mindvora.app',
  'https://mindvora-own8.vercel.app',
  'https://zync-social-vf8e.vercel.app',
  'http://localhost:3000',
  'http://localhost:5173',
];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, server-to-server)
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
    callback(new Error('CORS: Origin not allowed'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  exposedHeaders: [],
  maxAge: 86400,
}));

// ── Gzip compression — reduces payload size before sending ───────────────
app.use(compression());

// ── ⚔️  CRLF DEFENSE — must be first real middleware ─────────────────────
app.use(crlfGuard);

// ── Body parsing (after CRLF guard for body sanitization hook) ────────────
// 512kb is plenty for any route; 10mb was creating unnecessary large buffers.
app.use(express.json({ limit: '512kb' }));
app.use(express.urlencoded({ extended: false, limit: '512kb' }));

// ── Admin secret for sensitive endpoints ──────────────────────────────────
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'mindvora-admin-change-me';

function requireAdmin(req, res, next) {
  const secret = req.headers['x-admin-secret'] || req.query._adm;
  if (secret !== ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized', code: 'ADMIN_AUTH_FAILED' });
  }
  next();
}

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

app.post('/api/crypto/create-invoice', async (req, res) => {
  const { amountUSD, description, orderId, userEmail } = req.body;

  if (!amountUSD || !description) {
    return res.status(400).json({ status: false, message: 'Missing required fields.' });
  }
  if (isNaN(Number(amountUSD)) || Number(amountUSD) <= 0) {
    return res.status(400).json({ status: false, message: 'Invalid amount.' });
  }

  try {
    const response = await fetch('https://api.nowpayments.io/v1/invoice', {
      method: 'POST',
      agent: httpsAgent,
      headers: {
        'x-api-key':    process.env.NOWPAYMENTS_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        price_amount:      Number(amountUSD),
        price_currency:    'usd',
        pay_currency:      'usdtbsc',
        order_id:          orderId || (`MV-${Date.now()}`),
        order_description: description,
        ipn_callback_url:  process.env.IPN_URL || `https://${req.get('host')}/api/crypto/webhook`,
        success_url:       process.env.APP_URL  || 'https://mindvora.app',
        cancel_url:        process.env.APP_URL  || 'https://mindvora.app',
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ status: false, message: 'Payment provider error.' });
    }
    res.json(data);
  } catch (_) {
    res.status(500).json({ status: false, message: 'Unable to create invoice. Please try again.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ──  NOWPAYMENTS — Check Status  ────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

app.get('/api/crypto/status/:invoiceId', async (req, res) => {
  const { invoiceId } = req.params;
  // Validate format — prevent injection via param
  if (!/^[\w-]{1,100}$/.test(invoiceId)) {
    return res.status(400).json({ status: false, message: 'Invalid invoice ID.' });
  }
  try {
    const response = await fetch(`https://api.nowpayments.io/v1/invoice/${invoiceId}`, {
      agent: httpsAgent,
      headers: { 'x-api-key': process.env.NOWPAYMENTS_API_KEY },
    });
    if (!response.ok) {
      return res.status(response.status).json({ status: false, message: 'Could not fetch invoice status.' });
    }
    const data = await response.json();
    res.json(data);
  } catch (_) {
    res.status(500).json({ status: false, message: 'Unable to fetch status. Please try again.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ──  PAYSTACK — Airtime  ────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

app.post('/api/deliver-airtime', async (req, res) => {
  const { email, amount, phone, network, ref } = req.body;
  if (!email || !amount || !phone || !network) {
    return res.status(400).json({ status: false, message: 'Missing required fields.' });
  }
  try {
    const response = await fetch('https://api.paystack.co/charge', {
      method: 'POST',
      agent: httpsAgent,
      headers: {
        'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        email,
        amount,
        mobile_money: { phone, provider: network },
        metadata: { type: 'airtime', phone, network, reference: ref },
      }),
    });
    if (!response.ok) return res.status(response.status).json({ status: false, message: 'Payment provider error.' });
    const data = await response.json();
    res.json(data);
  } catch (_) {
    res.status(500).json({ status: false, message: 'Unable to process airtime. Please try again.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ──  PAYSTACK — Data Bundle  ────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

app.post('/api/deliver-data', async (req, res) => {
  const { email, amount, phone, network, bundle, ref } = req.body;
  if (!email || !amount || !phone || !network) {
    return res.status(400).json({ status: false, message: 'Missing required fields.' });
  }
  try {
    const response = await fetch('https://api.paystack.co/charge', {
      method: 'POST',
      agent: httpsAgent,
      agent: httpsAgent,
      headers: {
        'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        email,
        amount,
        mobile_money: { phone, provider: network },
        metadata: { type: 'data', phone, network, bundle, reference: ref },
      }),
    });
    if (!response.ok) return res.status(response.status).json({ status: false, message: 'Payment provider error.' });
    const data = await response.json();
    res.json(data);
  } catch (_) {
    res.status(500).json({ status: false, message: 'Unable to process data bundle. Please try again.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ──  NOWPAYMENTS — IPN Webhook  ─────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

app.post('/api/crypto/webhook', async (req, res) => {
  // Webhook is server-to-server — log internally only
  const payload = req.body;
  if (payload.payment_status === 'finished' || payload.payment_status === 'confirmed') {
    // Internal audit log only — never exposed to clients
    console.log(`[WEBHOOK] Crypto payment confirmed | order: ${payload.order_id} | amount: $${payload.price_amount}`);
  }
  res.status(200).send('OK');
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
    const response = await fetch(`https://api.exchangerate-api.com/v4/latest/${from}`, {
      agent: httpsAgent,
    });
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

const HUSMO_BASE = 'https://husmodata.com/api';

app.post('/api/husmo-airtime', async (req, res) => {
  const { phone, network, amount, ref } = req.body;
  if (!phone || !network || !amount) {
    return res.status(400).json({ status: false, message: 'Missing required fields.' });
  }
  try {
    const response = await fetch(`${HUSMO_BASE}/topup/`, {
      method: 'POST',
      agent: httpsAgent,
      headers: {
        'Authorization': `Token ${process.env.HUSMODATA_API_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        mobile_number: phone,
        network:       network.toUpperCase(),
        amount,
        Ported_number: true,
        airtime_type:  'VTU',
      }),
    });
    if (!response.ok) return res.status(response.status).json({ status: false, message: 'VTU provider error.' });
    const data = await response.json();
    res.json(data);
  } catch (_) {
    res.status(500).json({ status: false, message: 'Unable to process airtime. Please try again.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ──  HUSMODATA VTU — Data Bundle  ────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

app.post('/api/husmo-data', async (req, res) => {
  const { phone, network, bundle } = req.body;
  if (!phone || !network || !bundle) {
    return res.status(400).json({ status: false, message: 'Missing required fields.' });
  }
  const networkMap = { mtn: 1, airtel: 2, glo: 3, '9mobile': 4, etisalat: 4 };
  const networkId  = networkMap[network.toLowerCase()] || 1;
  try {
    const response = await fetch(`${HUSMO_BASE}/data/`, {
      method: 'POST',
      agent: httpsAgent,
      headers: {
        'Authorization': `Token ${process.env.HUSMODATA_API_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        network:       networkId,
        mobile_number: phone,
        plan:          bundle,
        Ported_number: true,
      }),
    });
    if (!response.ok) return res.status(response.status).json({ status: false, message: 'VTU provider error.' });
    const data = await response.json();
    res.json(data);
  } catch (_) {
    res.status(500).json({ status: false, message: 'Unable to process data bundle. Please try again.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ──  HUSMODATA — Balance  ────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

app.get('/api/husmo-balance', requireAdmin, async (_req, res) => {
  try {
    const response = await fetch(`${HUSMO_BASE}/balance/`, {
      agent: httpsAgent,
      headers: { 'Authorization': `Token ${process.env.HUSMODATA_API_KEY}` },
    });
    if (!response.ok) return res.status(response.status).json({ status: false, message: 'Balance check failed.' });
    const data = await response.json();
    res.json(data);
  } catch (_) {
    res.status(500).json({ status: false, message: 'Unable to fetch balance.' });
  }
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
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  handleConnection(ws, req);
});

// Heartbeat to detect stale connections
startHeartbeat(wss);

server.listen(PORT, () => {
  console.log(`🚀 Mindvora Backend running on port ${PORT}`);
  console.log(`🔌 WebSocket server active on /ws`);
  console.log(`🛡️  CRLF Defense System active`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);

  // ── Self-ping every 14 min to prevent Railway cold starts ────────────────
  // Railway spins down idle free-tier servers after ~15 min of inactivity.
  // This keeps the server warm so the first real user request is instant.
  const SELF_URL = process.env.RAILWAY_STATIC_URL
    ? `https://${process.env.RAILWAY_STATIC_URL}/api/crypto/status/ping`
    : null;

  if (SELF_URL && process.env.NODE_ENV === 'production') {
    setInterval(async () => {
      try {
        if (fetch) await fetch(SELF_URL, { method: 'GET', agent: httpsAgent });
      } catch (_) { /* silent — just a keep-alive ping */ }
    }, 14 * 60 * 1000); // every 14 minutes
    console.log(`🏓 Self-ping active → ${SELF_URL}`);
  }
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
