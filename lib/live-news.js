/**
 * MINDVORA — STREAM LIVE NEWS  ·  lib/live-news.js
 * GET /api/news/live            → the 10 live news channels with their CURRENT official live stream
 * GET /api/news/live/:id        → one channel (fresh lookup if the cached one is old)
 *
 * Every stream is the broadcaster's OWN official 24/7 live stream on its verified YouTube channel,
 * played with YouTube's official embed player. Mindvora hosts no video.
 * Live video IDs change whenever a broadcaster restarts its stream, so the server looks up the
 * current one (cached 15 min). If a lookup fails, the app falls back to YouTube's
 * "live_stream?channel=" embed, which always points at whatever the channel has live.
 * 8 international + 2 Nigerian sources.
 */
'use strict';

const CHANNELS = [
  // ── International (8) ──
  { id: 'aljazeera', vid: 'gCNeDWCI0vo', name: 'Al Jazeera English', country: 'Qatar', region: 'world', yt: 'UCNye-wNBqNL5ZzHSJj3l8Bg', site: 'https://www.aljazeera.com/live/' },
  { id: 'bbc', vid: '-NabWfv-VdA', name: 'BBC News', country: 'United Kingdom', region: 'world', yt: 'UC16niRr50-MSBwiO3YDb3RA', site: 'https://www.bbc.com/news' },
  { id: 'sky', vid: 'umLWFz4izTM', name: 'Sky News', country: 'United Kingdom', region: 'world', yt: 'UCoMdktPbSTixAyNGwb-UYkQ', site: 'https://news.sky.com/watch-live' },
  { id: 'dw', vid: 'LuKwFajn37U', name: 'DW News', country: 'Germany', region: 'world', yt: 'UCknLrEdhRCp1aegoMqRaCZg', site: 'https://www.dw.com/en/live-tv/channel-english' },
  { id: 'france24', vid: 'HvZt-nh9sGg', name: 'FRANCE 24 English', country: 'France', region: 'world', yt: 'UCQfwfsi5VrQ8yKZ-UWmAEFg', site: 'https://www.france24.com/en/live' },
  { id: 'euronews', vid: 'pykpO5kQJ98', name: 'Euronews English', country: 'Europe', region: 'world', yt: 'UCSrZ3UV4jOidv8ppoVuvW9Q', site: 'https://www.euronews.com/live' },
  { id: 'cna', vid: '-PWMxjBgr0k', name: 'CNA', country: 'Singapore', region: 'world', yt: 'UC83jt4dlz1Gjl58fzQrrKZg', site: 'https://www.channelnewsasia.com/watch' },
  { id: 'abcau', vid: 'vOTiJkg1voo', name: 'ABC News Australia', country: 'Australia', region: 'world', yt: 'UCVgO39Bk5sMo66-6o6Spn6Q', site: 'https://www.abc.net.au/news/live' },
  // ── Nigeria (2) ──
  { id: 'arise', vid: 'wqAwGhKnkjc', name: 'Arise News', country: 'Nigeria', region: 'nigeria', yt: 'UCyEJX-kSj0kOOCS7Qlq2G7g', site: 'https://www.arise.tv/' },
  { id: 'channels', vid: 'd4zDorDl5UE', name: 'Channels Television', country: 'Nigeria', region: 'nigeria', yt: 'UCEXGDNclvmg6RW0vipJYsTQ', site: 'https://www.channelstv.com/channels-live/' },
];

const TTL = 15 * 60 * 1000;
const cache = new Map(); // id -> { at, videoId, title, live }
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const HDRS = { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'CONSENT=YES+1; SOCS=CAI' };

async function lookup(ch) {
  // 1) The channel's /live page (gives title + live flag).
  try {
    const r = await fetch('https://www.youtube.com/channel/' + ch.yt + '/live', { headers: HDRS, redirect: 'follow', signal: AbortSignal.timeout(9000) });
    if (r.ok) {
      const h = await r.text();
      const can = (h.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/) || [])[1];
      const live = /"isLiveContent":true/.test(h) && /"lengthSeconds":"0"/.test(h);
      const title = ((h.match(/"title":"([^"]{1,140})","lengthSeconds"/) || [])[1] || '').replace(/\\u0026/g, '&');
      if (can && live) return { videoId: can, live: true, title };
    }
  } catch (e) { console.warn('[live-news] /live', ch.name, e.message); }
  // 2) Fallback: YouTube's embed page for the channel's live stream names the current video ID.
  //    (Data-centre IPs often get a consent/bot page for step 1 but not for this one.)
  try {
    const r = await fetch('https://www.youtube.com/embed/live_stream?channel=' + ch.yt, {
      headers: { ...HDRS, Referer: 'https://mindvora-own8.vercel.app/' }, signal: AbortSignal.timeout(9000) });
    if (r.ok) {
      const h = await r.text();
      const id = (h.match(/\\?"videoId\\?":\\?"([\w-]{11})/) || [])[1];
      if (id && id !== 'live_stream') return { videoId: id, live: true, title: '' };
    }
  } catch (e) { console.warn('[live-news] embed', ch.name, e.message); }
  throw new Error(ch.name + ': could not find the current live video');
}

async function resolve(ch, force) {
  const hit = cache.get(ch.id);
  if (!force && hit && Date.now() - hit.at < TTL) return hit;
  try {
    const v = await lookup(ch);
    const out = { at: Date.now(), ...v };
    if (!out.title && hit && hit.videoId === out.videoId) out.title = hit.title || '';
    cache.set(ch.id, out);
    return out;
  } catch (e) {
    console.warn('[live-news]', e.message);
    return hit || { at: 0, videoId: null, live: false, title: '' };
  }
}

function view(ch, v) {
  // Never hand out the bare "live_stream?channel=" embed when we know a real video ID — that link is what
  // shows "Video unavailable" in many browsers. Order: fresh lookup → channel's known 24/7 stream ID.
  const vid = (v.videoId && v.live) ? v.videoId : ch.vid;
  if (!v.videoId && ch.vid) v = { ...v, videoId: ch.vid, live: true };
  const embed = vid
    ? 'https://www.youtube.com/embed/' + vid + '?autoplay=1&playsinline=1&rel=0'
    : 'https://www.youtube.com/embed/live_stream?channel=' + ch.yt + '&autoplay=1&playsinline=1&rel=0';
  return {
    id: ch.id, name: ch.name, country: ch.country, region: ch.region,
    live: !!v.live, title: v.title || '', embed,
    watch: v.videoId ? 'https://www.youtube.com/watch?v=' + v.videoId : 'https://www.youtube.com/channel/' + ch.yt + '/live',
    site: ch.site,
    thumb: v.videoId ? 'https://i.ytimg.com/vi/' + v.videoId + '/hqdefault_live.jpg' : '',
  };
}

function mount(app) {
  app.get('/api/news/live', async (_req, res) => {
    try {
      const list = await Promise.all(CHANNELS.map(async (ch) => view(ch, await resolve(ch))));
      res.set('Cache-Control', 'public, max-age=120');
      res.json({ status: true, fetchedAt: new Date().toISOString(), channels: list });
    } catch (e) {
      res.status(500).json({ status: false, message: 'Live news is unavailable right now' });
    }
  });
  app.get('/api/news/live/:id', async (req, res) => {
    const ch = CHANNELS.find((c) => c.id === String(req.params.id));
    if (!ch) return res.status(404).json({ status: false, message: 'Unknown channel' });
    const hit = cache.get(ch.id);
    const v = await resolve(ch, !hit || Date.now() - hit.at > 5 * 60 * 1000);
    res.json({ status: true, channel: view(ch, v) });
  });
}

module.exports = { mount, CHANNELS };
