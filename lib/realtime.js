/**
 * MINDVORA — REAL-TIME EVENTS  ·  lib/realtime.js
 * Runs on the SAME WebSocket as calls (/ws). The client logs in once (AUTH), then:
 *   RT_DM        → message lands on the other person's screen at once (Firestore still stores it)
 *   RT_TYPING    → "<name> is typing…"
 *   RT_PRESENCE  → is this person online right now?
 * Server → client: RT_NOTIF for every new notification (likes, follows, comments, tips…),
 * and emit()/emitAll() so any REST handler can push live updates.
 */
'use strict';

const calls = require('./calls');

function clean(v, max) { return String(v == null ? '' : v).replace(/[\r\n\0<>]/g, '').slice(0, max || 100); }
function send(ws, p) { if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(p)); } catch (_) {} } }
function inDm(dmId, a, b) { const p = String(dmId || '').split('_'); return p.includes(a) && p.includes(b); }

function allowed(ws) {               // max 40 real-time packets per 10 s per connection
  const now = Date.now();
  ws._rtTimes = (ws._rtTimes || []).filter((t) => now - t < 10000);
  if (ws._rtTimes.length >= 40) return false;
  ws._rtTimes.push(now); return true;
}

function handle(ws, msg) {
  const me = ws._authUid;
  if (!me) { send(ws, { type: 'RT_ERROR', code: 'NOT_AUTHED' }); return true; }
  if (!allowed(ws)) return true;
  switch (msg.type) {
    case 'RT_DM': {
      const to = clean(msg.to, 128), dmId = clean(msg.dmId, 300);
      if (!to || !inDm(dmId, me, to)) return true;
      const out = { type: 'RT_DM', dmId, from: me, name: clean(msg.name, 60), color: clean(msg.color, 24),
        text: String(msg.text || '').replace(/\0/g, '').slice(0, 4000), at: Date.now() };
      const n = calls.sendUser(to, out);
      calls.sendUser(me, out, ws);                       // the sender's other devices
      send(ws, { type: 'RT_DM_ACK', dmId, delivered: n > 0 });
      return true;
    }
    case 'RT_TYPING': {
      const to = clean(msg.to, 128), dmId = clean(msg.dmId, 300);
      if (!to || !inDm(dmId, me, to)) return true;
      calls.sendUser(to, { type: 'RT_TYPING', dmId, from: me, name: clean(msg.name, 60), stop: !!msg.stop });
      return true;
    }
    case 'RT_PRESENCE': {
      const uids = (Array.isArray(msg.uids) ? msg.uids : []).slice(0, 50).map((u) => clean(u, 128));
      const online = {}; uids.forEach((u) => { online[u] = calls.isOnline(u); });
      send(ws, { type: 'RT_PRESENCE', online, dmId: clean(msg.dmId, 300) || undefined });
      return true;
    }
    case 'RT_ARIA':                                      // Aria answer, streamed back on this socket
    case 'RT_ARIA_CANCEL': {
      require('./aria').handleWs(ws, msg).catch((e) => console.error('[aria] ws:', e.message));
      return true;
    }
    default: return true;
  }
}

/** Push a live event to one user (all their open devices). */
function emit(uid, payload) { return uid ? calls.sendUser(uid, payload) : 0; }

module.exports = { handle, emit };
