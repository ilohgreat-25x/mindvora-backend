/**
 * MINDVORA — ICE SERVERS FOR CALLS  ·  lib/rtc.js
 *
 * STUN tells each phone its public address. That works on most home Wi-Fi,
 * but on many mobile networks (MTN/Airtel CGNAT, office Wi-Fi) the two phones
 * can't reach each other directly, and the call connects with no audio or
 * video. A TURN server relays the media in that case. Without TURN, expect
 * roughly 1 in 5 calls on Nigerian mobile data to fail.
 *
 * Configure ONE of these (checked in this order):
 *   A) Metered.ca (free tier)  METERED_DOMAIN=yourapp.metered.live
 *                              METERED_API_KEY=...
 *   B) Cloudflare Calls TURN   CF_TURN_KEY_ID=...  CF_TURN_API_TOKEN=...
 *   C) Any TURN server         TURN_URLS=turn:host:3478,turns:host:5349
 *                              TURN_USERNAME=...  TURN_CREDENTIAL=...
 */
'use strict';

const STUN = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];

let cache = { at: 0, servers: null, source: 'stun-only' };
const CACHE_MS = 30 * 60 * 1000;

async function fetchJson(url, opts) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

function turnSource() {
  if (process.env.METERED_DOMAIN && process.env.METERED_API_KEY) return 'metered';
  if (process.env.CF_TURN_KEY_ID && process.env.CF_TURN_API_TOKEN) return 'cloudflare';
  if (process.env.TURN_URLS && process.env.TURN_USERNAME) return 'static';
  return 'stun-only';
}

async function iceServers() {
  if (cache.servers && Date.now() - cache.at < CACHE_MS) return cache;
  const source = turnSource();
  let turn = [];
  try {
    if (source === 'metered') {
      const d = await fetchJson(`https://${process.env.METERED_DOMAIN}/api/v1/turn/credentials?apiKey=${encodeURIComponent(process.env.METERED_API_KEY)}`);
      turn = Array.isArray(d) ? d.filter((s) => !/^stun:/.test(String(s.urls))) : [];
    } else if (source === 'cloudflare') {
      const d = await fetchJson(`https://rtc.live.cloudflare.com/v1/turn/keys/${process.env.CF_TURN_KEY_ID}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + process.env.CF_TURN_API_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: 86400 }),
      });
      const list = Array.isArray(d.iceServers) ? d.iceServers : (d.iceServers ? [d.iceServers] : []);
      turn = list.map((s) => ({ ...s, urls: [].concat(s.urls).filter((u) => /^turns?:/.test(u)) })).filter((s) => s.urls.length);
    } else if (source === 'static') {
      turn = [{ urls: process.env.TURN_URLS.split(',').map((u) => u.trim()).filter(Boolean),
        username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL || '' }];
    }
  } catch (e) {
    console.error(`[RTC] Could not get TURN credentials from ${source}: ${e.message} — calls fall back to STUN only.`);
    turn = [];
  }
  cache = { at: Date.now(), servers: [...STUN, ...turn], source: turn.length ? source : 'stun-only' };
  return cache;
}

module.exports = { iceServers, turnSource, STUN };
