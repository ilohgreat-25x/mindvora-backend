/**
 * MINDVORA — GO LIVE ALERTS TO EVERY USER  ·  lib/live-notify.js
 * When anyone starts a live stream (a new live_streams doc with live:true), every other user gets:
 *   - an instant in-app alert over the existing WebSocket (RT_NOTIF, ntype 'live_now'), and
 *   - a phone/desktop push (works with Mindvora closed) via the existing FCM pipeline.
 * Tapping either opens /?action=live&id=<liveId> → straight into watching that stream.
 * Fan-out is server-side (no per-user Firestore docs). Blocks are respected both ways.
 * One alert per host per 10 minutes, so ending and restarting doesn't spam everyone.
 */
'use strict';
const { admin, db, firebaseAdminConfigured } = require('./firebase-admin');

const COOLDOWN_MS = 10 * 60 * 1000;
const lastAlert = new Map();   // hostUid → ms
const seen = new Set();        // liveId already announced

function start({ push, emit }) {
  if (!firebaseAdminConfigured()) return;
  const since = admin.firestore.Timestamp.fromMillis(Date.now() - 5000);
  db().collection('live_streams').where('createdAt', '>', since).onSnapshot((snap) => {
    snap.docChanges().forEach((ch) => {
      if (ch.type !== 'added') return;
      const s = ch.doc.data() || {};
      if (!s.live || seen.has(ch.doc.id)) return;
      seen.add(ch.doc.id);
      announce(ch.doc.id, s, { push, emit }).catch((e) => console.error('[LIVE-NOTIFY]', e.message));
    });
  }, (err) => { console.error('[LIVE-NOTIFY] watcher stopped:', err.message); setTimeout(() => start({ push, emit }), 30000); });
  console.log('🔴 Go Live alert watcher active');
}

async function announce(liveId, s, { push, emit }) {
  const host = s.hostId || s.hostUid || s.uid;
  if (!host) return;
  const now = Date.now();
  if (now - (lastAlert.get(host) || 0) < COOLDOWN_MS) return;
  lastAlert.set(host, now);

  const hostDoc = await db().collection('users').doc(host).get();
  const hostBlocked = (hostDoc.exists && hostDoc.data().blockedUsers) || [];
  const name = s.hostName || (hostDoc.exists && hostDoc.data().name) || 'Someone';
  const title = s.title ? `: "${String(s.title).slice(0, 60)}"` : '';
  const text = `${name} is LIVE now${title} — tap to watch`;
  const url = '/?action=live&id=' + encodeURIComponent(liveId);

  const users = await db().collection('users').select('blockedUsers').get();
  let pushed = 0, live = 0;
  const targets = users.docs.filter((u) => u.id !== host && !hostBlocked.includes(u.id)
    && !((u.data().blockedUsers || []).includes(host)));
  for (let i = 0; i < targets.length; i += 25) {
    await Promise.all(targets.slice(i, i + 25).map(async (u) => {
      try { live += emit(u.id, { type: 'RT_NOTIF', ntype: 'live_now', text, liveId, hostUid: host, hostName: name, url }) ? 1 : 0; } catch (_) {}
      try { const r = await push.sendToUser(u.id, { title: '🔴 Live now', body: text, type: 'live', tag: 'live-' + liveId, url, data: { liveId } }); pushed += r.sent || 0; } catch (_) {}
    }));
  }
  await db().collection('live_streams').doc(liveId).set({ alertedAt: admin.firestore.FieldValue.serverTimestamp(), alertedUsers: targets.length }, { merge: true }).catch(() => {});
  console.log(`[LIVE-NOTIFY] ${name} live ${liveId}: ${targets.length} users, ${live} in-app, ${pushed} pushes`);
}

module.exports = { start, announce };
