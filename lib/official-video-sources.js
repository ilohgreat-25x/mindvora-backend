'use strict';

// Separate from lib/live-news.js by design. This module only resolves official sports
// YouTube channels that were verified against their governing body, league, or promotion.
const SOURCES = [
  { id: 'fifa', category: 'soccer', name: 'FIFA', yt: 'UCpcTrCXblq78GZrTUTLWeBw', site: 'https://www.fifa.com/' },
  { id: 'jleague', category: 'soccer', name: 'J.LEAGUE International', yt: 'UCmQp6ZaAejJKKkXc_Y_lh1A', site: 'https://www.jleague.co/' },
  { id: 'ofc', category: 'soccer', name: 'OFC Football', yt: 'UC5_ARWRWjWNIAyHBAG3eiFQ', site: 'https://www.oceaniafootball.com/' },
  { id: 'ifaf', category: 'american-football', name: 'IFAF Media', yt: 'UC2dq9LJBUvKglwtP1ndqUBQ', site: 'https://www.americanfootball.sport/' },
  { id: 'fiba', category: 'basketball', name: 'FIBA Basketball', yt: 'UCtInrnU3QbWqFGsdKT1GZtg', site: 'https://www.fiba.basketball/' },
  { id: 'fiba3x3', category: 'basketball', name: 'FIBA 3x3', yt: 'UC7LpyJP5fupiJu2CdzRQheg', site: 'https://fiba3x3.com/' },
  { id: 'bal', category: 'basketball', name: 'The BAL', yt: 'UCSpFKCdUyrn45S5k1Mz7TNA', site: 'https://bal.nba.com/' },
  { id: 'bcl', category: 'basketball', name: 'Basketball Champions League', yt: 'UCZUkv6tSC5OfX54gLgjV9aw', site: 'https://www.championsleague.basketball/' },
  { id: 'wbsc', category: 'baseball', name: 'WBSC', yt: 'UC-UXjExO348UiOCxazH69hA', site: 'https://www.wbsc.org/' },
  { id: 'gametime', category: 'baseball', name: 'GameTime Sport', yt: 'UCS4QfIPY2WljopP0dYQhJJQ', site: 'https://gametime.sport/' },
  { id: 'iihf', category: 'hockey', name: 'IIHF', yt: 'UCtmgna7qB0oQF2oOcVgndbw', site: 'https://www.iihf.com/' },
  { id: 'whl', category: 'hockey', name: 'WHL', yt: 'UCk6xCoaVuR0OGalXE2SpGrg', site: 'https://chl.ca/whl/' },
  { id: 'atp-challenger', category: 'tennis', name: 'ATP Challenger', yt: 'UCT12ocLoA-sqRfs12yQM2Bg', site: 'https://www.atptour.com/' },
  { id: 'itf', category: 'tennis', name: 'World Tennis (ITF)', yt: 'UCsyvlpbK0BTEc3jec6nhPyQ', site: 'https://www.itftennis.com/' },
  { id: 'randa', category: 'golf', name: 'The R&A', yt: 'UCZ5fOnOmQunH18xZGhu9f_Q', site: 'https://www.randa.org/' },
  { id: 'lpga', category: 'golf', name: 'LPGA', yt: 'UCJd73FoI70yaZdSC173HcVw', site: 'https://www.lpga.com/' },
  { id: 'fia-wec', category: 'motorsport', name: 'FIA WEC', yt: 'UCwU7U7PiarcJKLjDJTnANjw', site: 'https://www.fiawec.com/' },
  { id: 'formula-e', category: 'motorsport', name: 'Formula E', yt: 'UC-DuRqsBQOEk_5o1q4Ze-Fg', site: 'https://www.fiaformulae.com/' },
  { id: 'icc', category: 'cricket', name: 'ICC', yt: 'UCt2JXOLNxqry7B_4rRZME3Q', site: 'https://www.icc-cricket.com/' },
  { id: 'world-rugby', category: 'rugby', name: 'World Rugby', yt: 'UCE28rwYoaV7jvU6GVzdu_GQ', site: 'https://www.world.rugby/' },
  { id: 'one', category: 'mma', name: 'ONE Championship', yt: 'UCiormkBf3jm6mfb7k0yPbKA', site: 'https://www.onefc.com/' },
  { id: 'ijf', category: 'judo', name: 'International Judo Federation', yt: 'UCeYa3QaP2n7I8SpGSqD-kUQ', site: 'https://www.ijf.org/' },
  { id: 'wkf', category: 'karate', name: 'World Karate Federation', yt: 'UCbcNH3k6L3wG9VWD5t05M1g', site: 'https://www.wkf.net/' },
  { id: 'fie', category: 'fencing', name: 'FIE Fencing', yt: 'UCJEy8aBnqDymMIcJCh72gMw', site: 'https://www.fie.org/' },
  { id: 'iba', category: 'boxing', name: 'IBA Boxing', yt: 'UCBdXQS3czTQsr_f_F5TZpww', site: 'https://www.iba.sport/' },
  { id: 'ufc', category: 'mma', name: 'UFC', yt: 'UCZ4TjGPIE4aD8yT7x7xT4xQ', site: 'https://www.ufc.com/' },
];

const TTL = 10 * 60 * 1000;
const cache = new Map();
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36';
const HDRS = { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'CONSENT=YES+1; SOCS=CAI' };

async function lookup(source) {
  try {
    const r = await fetch('https://www.youtube.com/channel/' + source.yt + '/live', { headers: HDRS, redirect: 'follow', signal: AbortSignal.timeout(9000) });
    if (r.ok) {
      const h = await r.text();
      const id = (h.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/) || [])[1];
      const live = /"isLiveContent":true/.test(h) && /"lengthSeconds":"0"/.test(h);
      const title = ((h.match(/"title":"([^"]{1,160})","lengthSeconds"/) || [])[1] || '').replace(/\\u0026/g, '&');
      if (id && live) return { videoId: id, live: true, title };
    }
  } catch (e) { console.warn('[official-video] /live', source.name, e.message); }
  try {
    const r = await fetch('https://www.youtube.com/embed/live_stream?channel=' + source.yt, { headers: { ...HDRS, Referer: 'https://mindvora-own8.vercel.app/' }, signal: AbortSignal.timeout(9000) });
    if (r.ok) {
      const h = await r.text();
      const id = (h.match(/\\?"videoId\\?":\\?"([\w-]{11})/) || [])[1];
      if (id && id !== 'live_stream') return { videoId: id, live: true, title: '' };
    }
  } catch (e) { console.warn('[official-video] embed', source.name, e.message); }
  return { videoId: null, live: false, title: '' };
}

async function resolve(source) {
  const hit = cache.get(source.id);
  if (hit && Date.now() - hit.at < TTL) return hit;
  const v = await lookup(source);
  const out = { at: Date.now(), ...v };
  cache.set(source.id, out);
  return out;
}

function view(source, v) {
  return {
    id: source.id, category: source.category, name: source.name, site: source.site,
    live: !!v.live, title: v.title || '',
    embed: v.videoId && v.live ? 'https://www.youtube.com/embed/' + v.videoId + '?autoplay=1&playsinline=1&rel=0' : null,
    watch: v.videoId ? 'https://www.youtube.com/watch?v=' + v.videoId : 'https://www.youtube.com/channel/' + source.yt + '/live',
    channel: 'https://www.youtube.com/channel/' + source.yt,
  };
}

function mount(app) {
  app.get('/api/sports/live-sources', async (req, res) => {
    const category = String(req.query.category || '').trim();
    const selected = category ? SOURCES.filter((s) => s.category === category) : SOURCES;
    const sources = await Promise.all(selected.map(async (s) => view(s, await resolve(s))));
    res.set('Cache-Control', 'public, max-age=120');
    res.json({ status: true, fetchedAt: new Date().toISOString(), sources });
  });
}

module.exports = { mount, SOURCES };
