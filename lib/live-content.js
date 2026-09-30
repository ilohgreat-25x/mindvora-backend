/**
 * MINDVORA — LIVE NEWS + LIVE TRIVIA  ·  lib/live-content.js
 * GET /api/news?cat=world|nigeria|africa|business|tech|sport   (RSS, no keys)
 * GET /api/trivia?amount=10&category=science|...|all           (Open Trivia DB, then The Trivia API)
 * Everything is fetched by the server (no CORS problems, no public proxies)
 * and cached so free sources are never hammered.
 */
'use strict';

const UA = 'Mozilla/5.0 (compatible; MindvoraNews/1.0; +https://mindvora-own8.vercel.app)';

const FEEDS = {
  world: [
    { name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
    { name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml' },
    { name: 'The Guardian', url: 'https://www.theguardian.com/world/rss' },
  ],
  nigeria: [
    { name: 'Punch', url: 'https://punchng.com/feed/' },
    { name: 'Premium Times', url: 'https://www.premiumtimesng.com/feed' },
    { name: 'Channels TV', url: 'https://www.channelstv.com/feed/' },
  ],
  africa: [{ name: 'BBC Africa', url: 'https://feeds.bbci.co.uk/news/world/africa/rss.xml' }],
  business: [{ name: 'BBC Business', url: 'https://feeds.bbci.co.uk/news/business/rss.xml' }],
  tech: [{ name: 'BBC Technology', url: 'https://feeds.bbci.co.uk/news/technology/rss.xml' }],
  sport: [{ name: 'BBC Sport', url: 'https://feeds.bbci.co.uk/sport/rss.xml' }],
};
const NEWS_TTL = 10 * 60 * 1000;
const newsCache = new Map(); // cat -> {at, items}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', ndash: '–', mdash: '—',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', eacute: 'é', ouml: 'ö', uuml: 'ü', aacute: 'á', iacute: 'í', ntilde: 'ñ', deg: '°', pi: 'π' };
function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => (n.toLowerCase() in ENTITIES ? ENTITIES[n.toLowerCase()] : m));
}
function tag(block, name) {
  const m = block.match(new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'i'));
  if (!m) return '';
  return m[1].replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').trim();
}
function stripHtml(s) { return decodeEntities(String(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(); }
function imageOf(block) {
  const m = block.match(/<media:(?:thumbnail|content)[^>]*url="([^"]+)"/i)
    || block.match(/<enclosure[^>]*url="([^"]+)"[^>]*type="image/i)
    || block.match(/<img[^>]*src="([^"]+)"/i);
  return m ? decodeEntities(m[1]) : '';
}

function parseRss(xml, source) {
  const out = [];
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  for (const it of items.slice(0, 25)) {
    const title = stripHtml(tag(it, 'title'));
    let link = stripHtml(tag(it, 'link')) || stripHtml(tag(it, 'guid'));
    if (!/^https?:\/\//i.test(link)) continue;
    const pub = stripHtml(tag(it, 'pubDate'));
    const ts = Date.parse(pub) || 0;
    const desc = stripHtml(tag(it, 'description')).slice(0, 220);
    if (title.length > 5) out.push({ title, link, desc, pub, ts, source, img: imageOf(it) });
  }
  return out;
}

async function fetchFeed(feed) {
  const r = await fetch(feed.url, { headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml' },
    redirect: 'follow', signal: AbortSignal.timeout(9000) });
  if (!r.ok) throw new Error(feed.name + ' HTTP ' + r.status);
  return parseRss(await r.text(), feed.name);
}

async function getNews(cat) {
  if (!FEEDS[cat]) cat = 'world';
  const hit = newsCache.get(cat);
  if (hit && Date.now() - hit.at < NEWS_TTL) return { items: hit.items, cached: true, stale: false };
  const results = await Promise.allSettled(FEEDS[cat].map(fetchFeed));
  const seen = new Set();
  const items = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
    .filter((i) => { const k = i.title.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => b.ts - a.ts).slice(0, 40);
  results.forEach((r, i) => { if (r.status === 'rejected') console.warn('[news]', FEEDS[cat][i].name, r.reason && r.reason.message); });
  if (items.length) { newsCache.set(cat, { at: Date.now(), items }); return { items, cached: false, stale: false }; }
  if (hit) return { items: hit.items, cached: true, stale: true }; // sources down: serve last good copy
  return { items: [], cached: false, stale: false };
}

// ── TRIVIA ──────────────────────────────────────────────────────────────────
const OTDB_CATS = { general: 9, entertainment: 11, science: 17, tech: 18, sports: 21, geography: 22, history: 23 };
const TAPI_CATS = { general: 'general_knowledge', entertainment: 'film_and_tv,music', science: 'science',
  tech: 'science', sports: 'sport_and_leisure', geography: 'geography', history: 'history' };
let otdbToken = null;
let otdbNextAt = 0; // Open Trivia DB allows 1 request per 5 seconds per IP
const triviaPool = new Map(); // category -> [questions] refilled from upstream

function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function makeQ(q, wrongs, correct, cat, difficulty, src) {
  const opts = shuffle([...wrongs, correct]);
  return { q, opts, ans: opts.indexOf(correct), cat, difficulty, src };
}

async function fromOpenTdb(category, amount) {
  if (Date.now() < otdbNextAt) throw new Error('otdb cooldown');
  otdbNextAt = Date.now() + 5200;
  if (!otdbToken) {
    const t = await fetch('https://opentdb.com/api_token.php?command=request', { signal: AbortSignal.timeout(6000) }).then((r) => r.json()).catch(() => null);
    if (t && t.token) otdbToken = t.token;
  }
  const params = new URLSearchParams({ amount: String(amount), type: 'multiple', encode: 'url3986' });
  if (OTDB_CATS[category]) params.set('category', String(OTDB_CATS[category]));
  if (otdbToken) params.set('token', otdbToken);
  const d = await fetch('https://opentdb.com/api.php?' + params, { signal: AbortSignal.timeout(8000) }).then((r) => r.json());
  if (d.response_code === 3 || d.response_code === 4) { otdbToken = null; } // token expired / used up all questions
  if (d.response_code === 5) throw new Error('otdb rate limited');
  if (d.response_code !== 0 || !Array.isArray(d.results) || !d.results.length) throw new Error('otdb code ' + d.response_code);
  const dec = (s) => decodeURIComponent(s);
  return d.results.map((q) => makeQ(dec(q.question), q.incorrect_answers.map(dec), dec(q.correct_answer), dec(q.category), q.difficulty, 'Open Trivia DB'));
}

async function fromTriviaApi(category, amount) {
  const params = new URLSearchParams({ limit: String(Math.min(amount, 50)) });
  if (TAPI_CATS[category]) params.set('categories', TAPI_CATS[category]);
  const r = await fetch('https://the-trivia-api.com/v2/questions?' + params, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('trivia-api HTTP ' + r.status);
  const d = await r.json();
  if (!Array.isArray(d) || !d.length) throw new Error('trivia-api empty');
  return d.map((q) => makeQ(q.question && q.question.text, q.incorrectAnswers, q.correctAnswer,
    String(q.category || '').replace(/_/g, ' '), q.difficulty, 'The Trivia API'));
}

async function getTrivia(category, amount) {
  if (!OTDB_CATS[category]) category = 'all';
  amount = Math.max(1, Math.min(Number(amount) || 10, 30));
  const pool = triviaPool.get(category) || [];
  if (pool.length < amount) {
    for (const src of [fromOpenTdb, fromTriviaApi]) {
      try { pool.push(...await src(category, Math.max(amount, 20))); break; }
      catch (e) { console.warn('[trivia]', e.message); }
    }
    triviaPool.set(category, pool);
  }
  if (!pool.length) return [];
  return pool.splice(0, amount); // each question is served once, then fresh ones are fetched
}

function mount(app) {
  app.get('/api/news', async (req, res) => {
    try {
      const cat = String(req.query.cat || 'world').toLowerCase();
      const r = await getNews(cat);
      res.set('Cache-Control', 'public, max-age=300');
      res.json({ status: r.items.length > 0, cat: FEEDS[cat] ? cat : 'world', categories: Object.keys(FEEDS), ...r });
    } catch (e) {
      console.error('[news]', e.message);
      res.status(502).json({ status: false, items: [], message: 'News is unavailable right now.' });
    }
  });
  app.get('/api/trivia', async (req, res) => {
    try {
      const qs = await getTrivia(String(req.query.category || 'all').toLowerCase(), req.query.amount);
      if (!qs.length) return res.status(503).json({ status: false, questions: [], message: 'Live questions unavailable.' });
      res.set('Cache-Control', 'no-store');
      res.json({ status: true, questions: qs, source: qs[0].src });
    } catch (e) {
      console.error('[trivia]', e.message);
      res.status(502).json({ status: false, questions: [] });
    }
  });
}

module.exports = { mount, _test: { parseRss, decodeEntities, getNews, getTrivia } };
