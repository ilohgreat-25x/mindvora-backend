/**
 * MINDVORA — 1-to-1 VOICE & VIDEO CALL SIGNALLING  ·  lib/calls.js
 *
 * Runs on the same WebSocket as live streaming (/ws). The media itself goes
 * phone-to-phone (WebRTC) or through TURN; this server only passes the short
 * "offer / answer / ICE" messages, so it adds almost no delay.
 *
 * Client → server
 *   AUTH          { token }                       Firebase ID token (required first)
 *   CALL_INVITE   { callId, to, media, name }     media = 'audio' | 'video'
 *   CALL_ACCEPT   { callId }
 *   CALL_DECLINE  { callId }                      also used for "busy"
 *   CALL_END      { callId }
 *   CALL_SIGNAL   { callId, data }                SDP / ICE, relayed untouched
 * Server → client
 *   AUTH_OK, CALL_INCOMING, CALL_RINGING, CALL_ACCEPTED, CALL_DECLINED,
 *   CALL_ENDED, CALL_SIGNAL, CALL_MISSED, CALL_ERROR, CALL_TAKEN (answered on another device)
 *
 * If the person being called is offline, they get a push notification and
 * the invite is held for RING_MS so it's delivered when the app opens.
 */
'use strict';

const RING_MS = 40000;
const MAX_CALLS_PER_MIN = 6;

const online = new Map();   // uid → Set<ws>
const calls  = new Map();   // callId → call

let verifyToken = async () => null;           // set by init()
let pushToUser  = async () => ({ sent: 0 });
let saveNotif   = async () => {};

function send(ws, payload) {
  if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(payload)); } catch (_) {} }
}
function sendUser(uid, payload, exceptWs) {
  const set = online.get(uid);
  if (!set) return 0;
  let n = 0;
  set.forEach((ws) => { if (ws !== exceptWs) { send(ws, payload); n++; } });
  return n;
}
function clean(v, max) { return String(v == null ? '' : v).replace(/[\r\n\0<>]/g, '').slice(0, max || 100); }

function activeCallOf(uid) {
  for (const c of calls.values()) if ((c.from === uid || c.to === uid) && c.state !== 'ended') return c;
  return null;
}

function endCall(c, reason, byUid) {
  if (!c || c.state === 'ended') return;
  const wasRinging = c.state === 'ringing';
  c.state = 'ended';
  clearTimeout(c.timer);
  const msg = { type: 'CALL_ENDED', callId: c.id, reason };
  if (c.fromWs) send(c.fromWs, msg); else sendUser(c.from, msg);
  if (c.toWs) send(c.toWs, msg); else sendUser(c.to, msg);
  if (wasRinging && reason !== 'declined') {
    saveNotif(c.to, 'missed_call', `Missed ${c.media} call from ${c.fromName}`, { fromUid: c.from }).catch(() => {});
  }
  setTimeout(() => calls.delete(c.id), 5000);
  console.log(`[CALL] ${c.id} ended (${reason}${byUid ? ' by ' + byUid : ''})`);
}

function otherWs(c, ws) { return ws === c.fromWs ? c.toWs : c.fromWs; }
// Send to the call's socket for that person, or to all their sockets if it dropped.
function toSide(c, uid, payload) {
  const w = uid === c.from ? c.fromWs : c.toWs;
  if (w && w.readyState === 1) send(w, payload); else sendUser(uid, payload);
}
/** A call the server still holds but nobody is really in (phone killed, app crashed, lost END). */
function isStale(c, now) {
  if (!c || c.state === 'ended') return true;
  if (c.state === 'ringing') return now - c.startedAt > RING_MS + 5000;
  // Up-to-date apps send CALL_ALIVE every 15s; an active call silent for 150s is dead
  // (only judged for sides that send it; generous because phones slow timers in the background).
  if (c.alive) return Object.keys(c.alive).some((u) => now - c.alive[u] > 150000);
  return false;
}

/** Deliver pending invites to someone who just came online (e.g. tapped the push). */
function deliverPending(uid, ws) {
  for (const c of calls.values()) {
    if (c.to === uid && c.state === 'ringing') {
      send(ws, { type: 'CALL_INCOMING', callId: c.id, from: c.from, fromName: c.fromName, media: c.media });
    }
  }
}

async function handle(ws, msg) {
  switch (msg.type) {
    case 'AUTH': {
      const user = await verifyToken(String(msg.token || ''), msg);
      if (!user || !user.uid) { send(ws, { type: 'CALL_ERROR', code: 'AUTH_FAILED', message: 'Please log in again to make calls.' }); return true; }
      if (ws._authUid && ws._authUid !== user.uid) {
        const old = online.get(ws._authUid); if (old) old.delete(ws);
      }
      ws._authUid = user.uid;
      if (!online.has(user.uid)) online.set(user.uid, new Set());
      online.get(user.uid).add(ws);
      send(ws, { type: 'AUTH_OK', uid: user.uid });
      // Caller's phone reconnected while its call was still ringing → keep the call on the new socket.
      for (const c of calls.values()) if (c.state === 'ringing' && c.from === user.uid && !c.fromWs) { c.fromWs = ws; clearTimeout(c.dropTimer); }
      deliverPending(user.uid, ws);
      return true;
    }

    case 'CALL_INVITE': {
      const me = ws._authUid;
      if (!me) { send(ws, { type: 'CALL_ERROR', code: 'NOT_AUTHED', message: 'Connecting… try again in a second.' }); return true; }
      const to = clean(msg.to, 128), callId = clean(msg.callId, 64);
      const media = msg.media === 'video' ? 'video' : 'audio';
      if (!to || !callId || to === me) { send(ws, { type: 'CALL_ERROR', callId, code: 'BAD_REQUEST', message: 'Invalid call.' }); return true; }
      const now = Date.now();
      ws._callTimes = (ws._callTimes || []).filter((t) => now - t < 60000);
      if (ws._callTimes.length >= MAX_CALLS_PER_MIN) { send(ws, { type: 'CALL_ERROR', callId, code: 'RATE_LIMIT', message: 'Too many calls. Wait a minute.' }); return true; }
      ws._callTimes.push(now);
      const busyCall = activeCallOf(to);
      if (busyCall && isStale(busyCall, now)) endCall(busyCall, 'stale');
      if (activeCallOf(to)) {
        send(ws, { type: 'CALL_DECLINED', callId, reason: 'busy' });
        saveNotif(to, 'missed_call', `Missed ${media} call from ${clean(msg.name, 60) || 'someone'} (you were on another call)`, { fromUid: me }).catch(() => {});
        return true;
      }
      const prev = activeCallOf(me); if (prev) endCall(prev, 'replaced', me);

      const c = { id: callId, from: me, to, media, fromName: clean(msg.name, 60) || 'Someone',
        fromWs: ws, toWs: null, state: 'ringing', startedAt: now };
      calls.set(callId, c);
      const delivered = sendUser(to, { type: 'CALL_INCOMING', callId, from: me, fromName: c.fromName, media });
      pushToUser(to, {
        title: media === 'video' ? '📹 Incoming video call' : '📞 Incoming voice call',
        body: `${c.fromName} is calling you`, type: 'call', tag: 'call-' + callId, urgent: true,
        url: `/?call=${encodeURIComponent(callId)}`, data: { callId, fromUid: me, media }, // FIX: 'from' is a reserved FCM key — it made every call push fail
      }).catch(() => {});
      send(ws, { type: 'CALL_RINGING', callId, calleeOnline: delivered > 0 });
      c.timer = setTimeout(() => endCall(c, 'no-answer'), RING_MS);
      return true;
    }

    case 'CALL_ACCEPT': {
      const c = calls.get(clean(msg.callId, 64));
      if (!c || c.state !== 'ringing' || c.to !== ws._authUid) { send(ws, { type: 'CALL_ENDED', callId: msg.callId, reason: 'gone' }); return true; }
      c.state = 'active'; c.toWs = ws; c.acceptedAt = Date.now(); clearTimeout(c.timer);
      sendUser(c.to, { type: 'CALL_TAKEN', callId: c.id }, ws);    // stop ringing on the other devices
      toSide(c, c.from, { type: 'CALL_ACCEPTED', callId: c.id });
      return true;
    }

    case 'CALL_DECLINE': {
      const c = calls.get(clean(msg.callId, 64));
      if (!c || c.to !== ws._authUid || c.state !== 'ringing') return true;
      c.state = 'ended'; clearTimeout(c.timer);
      toSide(c, c.from, { type: 'CALL_DECLINED', callId: c.id, reason: msg.reason === 'busy' ? 'busy' : 'declined' });
      sendUser(c.to, { type: 'CALL_TAKEN', callId: c.id }, ws);
      setTimeout(() => calls.delete(c.id), 5000);
      return true;
    }

    case 'CALL_END': {
      const c = calls.get(clean(msg.callId, 64));
      if (c && (c.from === ws._authUid || c.to === ws._authUid)) endCall(c, c.state === 'ringing' && c.from === ws._authUid ? 'cancelled' : 'hangup', ws._authUid);
      return true;
    }

    case 'CALL_ALIVE': {
      const c = calls.get(clean(msg.callId, 64));
      if (c && c.state !== 'ended' && (c.from === ws._authUid || c.to === ws._authUid)) (c.alive = c.alive || {})[ws._authUid] = Date.now();
      return true;
    }

    case 'CALL_SIGNAL': {
      const c = calls.get(clean(msg.callId, 64));
      if (!c || c.state === 'ended') return true;
      // Accept the signal from ANY socket of the two people in the call (a phone that
      // reconnected gets a new socket) and move the call onto that socket.
      if (ws !== c.fromWs && ws !== c.toWs) {
        if (ws._authUid && ws._authUid === c.from) c.fromWs = ws;
        else if (ws._authUid && ws._authUid === c.to && c.state === 'active') c.toWs = ws;
        else return true;
        clearTimeout(c.dropTimer);
      }
      const raw = JSON.stringify(msg.data || null);
      if (raw.length > 60000) return true;
      send(otherWs(c, ws), { type: 'CALL_SIGNAL', callId: c.id, data: msg.data });
      return true;
    }
  }
  return false;
}

function onClose(ws) {
  const uid = ws._authUid;
  if (!uid) return;
  const set = online.get(uid);
  if (set) { set.delete(ws); if (!set.size) online.delete(uid); }
  for (const c of calls.values()) {
    if (c.state === 'ended') continue;
    if (c.fromWs === ws || c.toWs === ws) {
      // Give a dropped phone 15s to reconnect before hanging up the other side.
      if (c.state === 'active') {
        if (c.fromWs === ws) c.fromWs = null; else c.toWs = null;
        clearTimeout(c.dropTimer);
        c.dropTimer = setTimeout(() => { if (!c.fromWs || !c.toWs) endCall(c, 'connection-lost'); }, 15000);
      } else if (c.fromWs === ws) {
        // Caller's socket dropped while ringing: give it 10s to come back before cancelling.
        c.fromWs = null; clearTimeout(c.dropTimer);
        c.dropTimer = setTimeout(() => { if (c.state === 'ringing' && !c.fromWs) endCall(c, 'cancelled'); }, 10000);
      }
    }
  }
}

/** A reconnecting device re-attaches to its active call. */
function reattach(ws, callId) {
  const c = calls.get(clean(callId, 64));
  if (!c || (c.state !== 'active' && !(c.state === 'ringing' && c.from === ws._authUid)) || !ws._authUid) return false;
  if (c.from === ws._authUid) c.fromWs = ws;
  else if (c.to === ws._authUid) c.toWs = ws;
  else return false;
  clearTimeout(c.dropTimer);
  return true;
}

// Sweep: expire stale sessions so nobody stays "busy" because of a call that is already gone.
setInterval(() => {
  const now = Date.now();
  for (const c of calls.values()) {
    if (c.state === 'ended') { if (now - c.startedAt > 3600000) calls.delete(c.id); continue; }
    if (isStale(c, now)) endCall(c, c.state === 'ringing' ? 'no-answer' : 'connection-lost');
  }
}, 15000).unref();

function init(opts) {
  if (opts.verifyToken) verifyToken = opts.verifyToken;
  if (opts.pushToUser) pushToUser = opts.pushToUser;
  if (opts.saveNotif) saveNotif = opts.saveNotif;
}

function stats() {
  let active = 0, ringing = 0;
  calls.forEach((c) => { if (c.state === 'active') active++; else if (c.state === 'ringing') ringing++; });
  return { usersOnline: online.size, activeCalls: active, ringing };
}

async function handleMessage(ws, msg) {
  if (msg.type === 'CALL_REATTACH') { send(ws, { type: 'CALL_REATTACHED', callId: msg.callId, ok: reattach(ws, msg.callId) }); return true; }
  return handle(ws, msg);
}

module.exports = { init, handleMessage, onClose, stats, sendUser, isOnline: (uid) => online.has(uid) };
