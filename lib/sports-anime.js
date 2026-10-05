/**
 * MINDVORA — LIVE FOOTBALL + ANIME CATALOGUE  ·  lib/sports-anime.js
 *
 * GET /api/football/matches?date=YYYY-MM-DD   today's / live matches (football-data.org v4)
 * GET /api/football/match/:id                 one match (score, status, goals/bookings when the plan includes them)
 * GET /api/anime/movies?sort=trending|popular|top&q=&page=   AniList GraphQL, Jikan (MyAnimeList) fallback
 * GET /api/anime/:id                          detail + OFFICIAL streaming links only
 *
 * Security / legality
 *  - The football key is read ONLY from process.env.FOOTBALL_DATA_API_KEY on the server. It is never sent to the browser.
 *  - No video is scraped or embedded. Football links point to official competition / rights-holder sites;
 *    anime links come from AniList "STREAMING" links (Crunchyroll, Netflix, HIDIVE, …) filtered by an allow-list.
 *
 * Rate limits (free tier = 10 req/min): every upstream call goes through a shared cache + token bucket
 * (8/min, leaving headroom). Concurrent identical requests share one upstream fetch. If the bucket is empty
 * the last good data is served with `stale: true` instead of failing.
 */
'use strict';

const FD_BASE = 'https://api.football-data.org/v4';
const UA = 'Mindvora/1.0 (+https://mindvora-own8.vercel.app)';

// ── small shared cache with in-flight de-duplication ─────────────────
const cache = new Map();   // key -> { at, ttl, data }
const inflight = new Map(); // key -> Promise
function cached(key, ttl, loader) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return Promise.resolve({ ...hit.data, cached: true });
  if (inflight.has(key)) return inflight.get(key);
  const p = loader()
    .then((data) => { cache.set(key, { at: Date.now(), data }); if (cache.size > 300) cache.delete(cache.keys().next().value); return data; })
    .catch((e) => { if (hit) return { ...hit.data, stale: true }; throw e; })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// ── football-data.org token bucket (8 calls / 60 s) ──────────────────
const FD_PER_MIN = 8;
let fdCalls = [];
function fdAllowed() { const now = Date.now(); fdCalls = fdCalls.filter((t) => now - t < 60000); if (fdCalls.length >= FD_PER_MIN) return false; fdCalls.push(now); return true; }

async function fd(path) {
  const key = process.env.FOOTBALL_DATA_API_KEY;
  if (!key) { const e = new Error('Football is not configured (FOOTBALL_DATA_API_KEY missing).'); e.status = 503; throw e; }
  if (!fdAllowed()) { const e = new Error('Football data is busy — try again in a minute.'); e.status = 429; throw e; }
  const r = await fetch(FD_BASE + path, { headers: { 'X-Auth-Token': key, 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
  if (r.status === 429) { fdCalls = Array(FD_PER_MIN).fill(Date.now()); const e = new Error('Football data rate limit reached.'); e.status = 429; throw e; }
  if (!r.ok) { const e = new Error('Football data HTTP ' + r.status); e.status = r.status === 403 ? 403 : 502; throw e; }
  return r.json();
}

// Official places to follow / watch. No streams are embedded; these are rights holders or the competition itself.
const OFFICIAL = {
  PL:  [{ name: 'Premier League (official)', url: 'https://www.premierleague.com/' }, { name: 'SuperSport / Showmax (Nigeria)', url: 'https://supersport.com/football/' }],
  CL:  [{ name: 'UEFA Champions League (official)', url: 'https://www.uefa.com/uefachampionsleague/' }],
  PD:  [{ name: 'LaLiga (official)', url: 'https://www.laliga.com/en-GB' }],
  SA:  [{ name: 'Serie A (official)', url: 'https://www.legaseriea.it/en' }],
  BL1: [{ name: 'Bundesliga (official)', url: 'https://www.bundesliga.com/en/bundesliga' }],
  FL1: [{ name: 'Ligue 1 (official)', url: 'https://ligue1.com/' }],
  WC:  [{ name: 'FIFA+ (official)', url: 'https://www.plus.fifa.com/' }],
  EC:  [{ name: 'UEFA EURO (official)', url: 'https://www.uefa.com/euro/' }],
};
const DEFAULT_OFFICIAL = [{ name: 'SuperSport (official broadcaster, Africa)', url: 'https://supersport.com/football/' }];

function slimMatch(m) {
  const code = m.competition && m.competition.code;
  const s = m.score || {};
  return {
    id: m.id, utcDate: m.utcDate, status: m.status, minute: m.minute || null, matchday: m.matchday || null,
    stage: m.stage || null, lastUpdated: m.lastUpdated || null,
    competition: m.competition ? { code, name: m.competition.name, emblem: m.competition.emblem || '' } : null,
    area: m.area ? { name: m.area.name, flag: m.area.flag || '' } : null,
    home: m.homeTeam ? { id: m.homeTeam.id, name: m.homeTeam.shortName || m.homeTeam.name, crest: m.homeTeam.crest || '' } : null,
    away: m.awayTeam ? { id: m.awayTeam.id, name: m.awayTeam.shortName || m.awayTeam.name, crest: m.awayTeam.crest || '' } : null,
    score: { winner: s.winner || null, fullTime: s.fullTime || {}, halfTime: s.halfTime || {} },
    // Present only when the account's plan includes them (free tier usually omits them).
    goals: Array.isArray(m.goals) ? m.goals.map((g) => ({ minute: g.minute, team: g.team && g.team.name, scorer: g.scorer && g.scorer.name, type: g.type })) : undefined,
    bookings: Array.isArray(m.bookings) ? m.bookings.map((b) => ({ minute: b.minute, team: b.team && b.team.name, player: b.player && b.player.name, card: b.card })) : undefined,
    substitutions: Array.isArray(m.substitutions) ? m.substitutions.length : undefined,
    watch: OFFICIAL[code] || DEFAULT_OFFICIAL,
  };
}
const LIVE = new Set(['IN_PLAY', 'PAUSED', 'LIVE']);
function isoDate(d) { return d.toISOString().slice(0, 10); }

async function getMatches(date) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : isoDate(new Date());
  const next = isoDate(new Date(Date.parse(day + 'T00:00:00Z') + 86400000));
  // live data changes fast → 45 s; other days 10 min
  const ttl = day === isoDate(new Date()) ? 45000 : 600000;
  return cached('fd:matches:' + day, ttl, async () => {
    const j = await fd(`/matches?dateFrom=${day}&dateTo=${next}`);
    const matches = (j.matches || []).filter((m) => (m.utcDate || '').slice(0, 10) === day || LIVE.has(m.status)).map(slimMatch);
    matches.sort((a, b) => (LIVE.has(b.status) - LIVE.has(a.status)) || String(a.utcDate).localeCompare(String(b.utcDate)));
    return { date: day, fetchedAt: new Date().toISOString(), live: matches.filter((m) => LIVE.has(m.status)).length, matches };
  });
}
async function getMatch(id) {
  return cached('fd:match:' + id, 30000, async () => ({ fetchedAt: new Date().toISOString(), match: slimMatch(await fd('/matches/' + id)) }));
}

// ── Anime: AniList (primary) + Jikan (fallback) ──────────────────────
const LEGIT = /(^|\.)(crunchyroll\.com|netflix\.com|hidive\.com|primevideo\.com|amazon\.[a-z.]+|disneyplus\.com|hulu\.com|max\.com|hbomax\.com|bilibili\.tv|youtube\.com|tubitv\.com|retrocrush\.tv|funimation\.com|ani-one\.|muse\.|apple\.com|tv\.apple\.com|peacocktv\.com|adultswim\.com|vrv\.co|animelab\.com|wakanim\.tv|iq\.com|viz\.com)$/i;
function legitLink(url) { try { const h = new URL(url).hostname; return LEGIT.test(h) && /^https:/.test(url); } catch (_) { return false; } }

const ANILIST_FIELDS = `id idMal title{romaji english} format status seasonYear averageScore popularity genres duration
  coverImage{large extraLarge color} bannerImage siteUrl description(asHtml:false)
  externalLinks{site url type language} streamingEpisodes{title url site}`;
const SORTS = { trending: 'TRENDING_DESC', popular: 'POPULARITY_DESC', top: 'SCORE_DESC', new: 'START_DATE_DESC' };

async function anilist(query, variables) {
  const r = await fetch('https://graphql.anilist.co', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error('AniList HTTP ' + r.status);
  const j = await r.json();
  if (j.errors) throw new Error('AniList: ' + (j.errors[0] && j.errors[0].message));
  return j.data;
}
function stripDesc(s) { return String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 600); }
function aniWatch(m) {
  const links = (m.externalLinks || []).filter((l) => l.type === 'STREAMING' && legitLink(l.url)).map((l) => ({ site: l.site, url: l.url }));
  (m.streamingEpisodes || []).forEach((e) => { if (legitLink(e.url) && !links.some((l) => l.site === e.site)) links.push({ site: e.site, url: e.url }); });
  return links;
}
function slimAni(m) {
  return {
    id: 'al:' + m.id, source: 'AniList', title: (m.title && (m.title.english || m.title.romaji)) || 'Untitled',
    year: m.seasonYear || null, format: m.format, status: m.status, score: m.averageScore || null, genres: m.genres || [],
    durationMin: m.duration || null, cover: (m.coverImage && (m.coverImage.extraLarge || m.coverImage.large)) || '',
    banner: m.bannerImage || '', color: (m.coverImage && m.coverImage.color) || '', info: m.siteUrl,
    description: stripDesc(m.description), watch: aniWatch(m),
  };
}
async function jikan(path) {
  const r = await fetch('https://api.jikan.moe/v4' + path, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('Jikan HTTP ' + r.status);
  return r.json();
}
function slimJikan(a) {
  return {
    id: 'mal:' + a.mal_id, source: 'MyAnimeList (Jikan)', title: a.title_english || a.title, year: a.year || (a.aired && a.aired.prop && a.aired.prop.from && a.aired.prop.from.year) || null,
    format: a.type, status: a.status, score: a.score ? Math.round(a.score * 10) : null, genres: (a.genres || []).map((g) => g.name),
    durationMin: null, cover: (a.images && a.images.jpg && (a.images.jpg.large_image_url || a.images.jpg.image_url)) || '', banner: '', color: '',
    info: a.url, description: stripDesc(a.synopsis), watch: (a.streaming || []).filter((s) => legitLink(s.url)).map((s) => ({ site: s.name, url: s.url })),
  };
}

async function getAnimeMovies({ sort = 'trending', q = '', page = 1 }) {
  const s = SORTS[sort] ? sort : 'trending'; const p = Math.max(1, Math.min(20, parseInt(page, 10) || 1));
  const search = String(q || '').replace(/[^\p{L}\p{N} :'!?.-]/gu, '').trim().slice(0, 80);
  return cached(`anime:${s}:${search}:${p}`, 30 * 60 * 1000, async () => {
    try {
      const d = await anilist(`query($page:Int,$sort:[MediaSort],$search:String){Page(page:$page,perPage:24){pageInfo{hasNextPage}
        media(type:ANIME,format:MOVIE,isAdult:false,sort:$sort,search:$search){${ANILIST_FIELDS}}}}`,
        { page: p, sort: [search ? 'SEARCH_MATCH' : SORTS[s]], search: search || undefined });
      return { source: 'AniList', page: p, hasNext: !!d.Page.pageInfo.hasNextPage, items: d.Page.media.map(slimAni) };
    } catch (e) {
      console.warn('[anime] AniList failed, using Jikan:', e.message);
      const order = s === 'top' ? 'score' : s === 'new' ? 'start_date' : 'popularity';
      const j = await jikan(`/anime?type=movie&sfw=true&page=${p}&limit=24&order_by=${order}&sort=${order === 'popularity' ? 'asc' : 'desc'}` + (search ? '&q=' + encodeURIComponent(search) : ''));
      return { source: 'Jikan', page: p, hasNext: !!(j.pagination && j.pagination.has_next_page), items: (j.data || []).map(slimJikan) };
    }
  });
}
async function getAnime(id) {
  const m = /^(al|mal):(\d{1,9})$/.exec(String(id)); if (!m) { const e = new Error('Bad id'); e.status = 400; throw e; }
  return cached('anime:item:' + id, 6 * 60 * 60 * 1000, async () => {
    if (m[1] === 'al') { const d = await anilist(`query($id:Int){Media(id:$id,type:ANIME){${ANILIST_FIELDS}}}`, { id: +m[2] }); return { item: slimAni(d.Media) }; }
    const [a, st] = await Promise.all([jikan('/anime/' + m[2]), jikan('/anime/' + m[2] + '/streaming').catch(() => ({ data: [] }))]);
    const item = slimJikan({ ...a.data, streaming: st.data || [] });
    return { item };
  });
}

function sendErr(res, tag, e) {
  console.error(tag, e.message);
  res.status(e.status || 502).json({ status: false, message: e.status && e.status < 500 || e.status === 503 ? e.message : 'Unavailable right now — try again shortly.' });
}

function mount(app) {
  app.get('/api/football/matches', async (req, res) => {
    try { const d = await getMatches(String(req.query.date || '')); res.set('Cache-Control', 'public, max-age=30'); res.json({ status: true, provider: 'football-data.org', ...d }); }
    catch (e) { sendErr(res, '[football]', e); }
  });
  app.get('/api/football/match/:id', async (req, res) => {
    if (!/^\d{1,10}$/.test(req.params.id)) return res.status(400).json({ status: false, message: 'Bad match id' });
    try { const d = await getMatch(req.params.id); res.set('Cache-Control', 'public, max-age=20'); res.json({ status: true, provider: 'football-data.org', ...d }); }
    catch (e) { sendErr(res, '[football]', e); }
  });
  app.get('/api/anime/movies', async (req, res) => {
    try { const d = await getAnimeMovies(req.query); res.set('Cache-Control', 'public, max-age=900'); res.json({ status: true, ...d }); }
    catch (e) { sendErr(res, '[anime]', e); }
  });
  app.get('/api/anime/:id', async (req, res) => {
    try { const d = await getAnime(req.params.id); res.set('Cache-Control', 'public, max-age=3600'); res.json({ status: true, ...d }); }
    catch (e) { sendErr(res, '[anime]', e); }
  });
}

module.exports = { mount, _test: { getMatches, getMatch, getAnimeMovies, getAnime, legitLink } };
