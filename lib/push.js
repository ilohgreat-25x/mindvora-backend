/**
 * MINDVORA — PUSH NOTIFICATIONS  ·  lib/push.js
 * Sends phone/desktop notifications through Firebase Cloud Messaging, so they
 * show up even when the app is closed.
 *
 *  - Web tokens (browser / installed PWA) live in users/{uid}.fcmTokens and get
 *    DATA-ONLY messages; the service worker (sw.js) decides how to display them.
 *  - Native tokens (Android/iOS app built with Capacitor) live in
 *    users/{uid}.fcmNativeTokens and get a notification + data message, because
 *    a closed native app only shows notification messages.
 *  - Tokens that Google reports as dead are removed automatically.
 *
 * The notification watcher turns every new document in the `notifications`
 * collection (DMs, likes, follows, tips, calls…) into a push, so the app code
 * doesn't need a separate "send push" call anywhere.
 */
'use strict';

const { admin, db, firebaseAdminConfigured } = require('./firebase-admin');

const TITLES = {
  dm: '💬 New message', like: '❤️ New like', comment: '💬 New comment', follow: '➕ New follower',
  tip: '💝 You got a tip', gift: '🎁 You got a gift', repost: '🔁 Repost', mention: '📣 You were mentioned',
  referral: '🎉 Referral', live: '🔴 Live now', call: '📞 Incoming call', missed_call: '📵 Missed call',
};

// FIX: 'messaging/invalid-argument' was in this list. That error means "bad message",
// not "dead phone" — so one bad payload deleted the user's working tokens and after
// that NO notification (DMs, likes, calls…) could reach them.
const DEAD = new Set([
  'messaging/registration-token-not-registered', 'messaging/invalid-registration-token',
]);

// FCM rejects these data keys (reserved words).
const RESERVED = /^(from|notification|message_type|collapse_key)$|^(google|gcm)/i;

function asStrings(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) if (v !== undefined && v !== null && !RESERVED.test(k)) out[k] = String(v);
  return out;
}

async function tokensFor(uid) {
  const snap = await db().collection('users').doc(uid).get();
  if (!snap.exists) return { web: [], native: [] };
  const d = snap.data() || {};
  if (d.pushEnabled === false) return { web: [], native: [] };
  const web = new Set(Array.isArray(d.fcmTokens) ? d.fcmTokens : []);
  if (d.fcmToken) web.add(d.fcmToken);
  const native = new Set(Array.isArray(d.fcmNativeTokens) ? d.fcmNativeTokens : []);
  return { web: [...web].slice(-10), native: [...native].slice(-10) };
}

/**
 * @param {string} uid
 * @param {{title:string, body:string, type?:string, url?:string, tag?:string, data?:object, urgent?:boolean}} msg
 */
async function sendToUser(uid, msg) {
  if (!firebaseAdminConfigured() || !uid) return { sent: 0, skipped: 'not-configured' };
  const { web, native } = await tokensFor(uid);
  if (!web.length && !native.length) return { sent: 0, skipped: 'no-tokens' };

  const type = msg.type || 'general';
  const data = asStrings({
    title: msg.title, body: msg.body, type, url: msg.url || '/', tag: msg.tag || type, ...msg.data,
  });
  const ttl = msg.urgent ? 45 : 24 * 3600; // a call is useless after 45s
  const dead = { web: [], native: [] };
  let sent = 0;

  if (web.length) {
    const r = await admin.messaging().sendEachForMulticast({
      tokens: web, data,
      webpush: { headers: { Urgency: msg.urgent ? 'high' : 'normal', TTL: String(ttl) } },
    });
    sent += r.successCount;
    r.responses.forEach((x, i) => { if (!x.success && x.error) { if (DEAD.has(x.error.code)) dead.web.push(web[i]); else console.error('[PUSH] web send failed:', x.error.code, x.error.message); } });
  }
  if (native.length) {
    const r = await admin.messaging().sendEachForMulticast({
      tokens: native, data,
      notification: { title: msg.title, body: msg.body },
      android: { priority: 'high', ttl: ttl * 1000,
        // Voice and video calls use their own Android channels so each rings with its own sound
        // (channels + sound files live in the mobile app; older app installs fall back to 'calls').
        notification: type === 'call'
          ? { channelId: data.media === 'video' ? 'calls_video' : 'calls_voice', tag: data.tag, sound: data.media === 'video' ? 'video_ring' : 'voice_ring',
              priority: 'max', visibility: 'public', defaultVibrateTimings: true }   // pop up on screen, show on lock screen
          : { channelId: 'default', tag: data.tag, sound: 'default', priority: 'high', visibility: 'public' } },
      apns: { headers: { 'apns-priority': '10', 'apns-expiration': String(Math.floor(Date.now() / 1000) + ttl) },
        payload: { aps: { sound: 'default', 'thread-id': data.tag } } },
    });
    sent += r.successCount;
    r.responses.forEach((x, i) => { if (!x.success && x.error) { if (DEAD.has(x.error.code)) dead.native.push(native[i]); else console.error('[PUSH] native send failed:', x.error.code, x.error.message); } });
  }

  if (dead.web.length || dead.native.length) {
    const FV = admin.firestore.FieldValue;
    const upd = {};
    if (dead.web.length) upd.fcmTokens = FV.arrayRemove(...dead.web);
    if (dead.native.length) upd.fcmNativeTokens = FV.arrayRemove(...dead.native);
    db().collection('users').doc(uid).update(upd).catch(() => {});
  }
  return { sent, removed: dead.web.length + dead.native.length };
}

/** Push every NEW notification document (created after the server started). */
// Some app code addresses a notification with `to` or `uid` instead of `toUid`. Those were never pushed
// AND never showed in the in-app list (it reads `toUid`). Accept all three and write `toUid` back.
const UID_RE = /^[A-Za-z0-9_-]{20,40}$/;          // Firebase uids; skips e-mail / admin placeholder ids
function recipientOf(n) {
  for (const v of [n.toUid, n.to, n.uid]) if (typeof v === 'string' && UID_RE.test(v) && !/_admin$/.test(v)) return v;
  return null;
}
Object.assign(TITLES, {
  tag: '🏷️ You were tagged', voice_reply: '🎙 Voice reply', live_started: '🔴 Live now', collab: '🤝 Collab post',
  subscription: '💎 New subscriber', sale: '💰 New sale', newsletter: '📰 Newsletter', ad_approved: '✅ Ad approved',
  ad_rejected: '❌ Ad not approved', birthday: '🎂 Happy birthday', security: '🛡️ Security', security_alert: '🛡️ Security alert',
  premium: '💎 Premium', verified: '✅ Verified', reply: '↩️ New reply', story_reaction: '💬 Story reaction',
  friend_request: '👋 Friend request', withdrawal: '💸 Withdrawal', subscription_new: '💎 New subscriber',
});
// Where a tap should land inside the app.
function urlFor(type, n) {
  const spark = n.sparkId || n.postId;
  if (type === 'dm') return '/?action=dm';
  if (type === 'call') return n.callId ? '/?call=' + encodeURIComponent(n.callId) : '/?action=notifications';
  if (['like', 'comment', 'reply', 'tag', 'voice_reply', 'repost', 'mention'].includes(type) && spark) return '/?action=spark&id=' + encodeURIComponent(spark);
  if (type === 'follow' && n.fromUid) return '/?action=profile&uid=' + encodeURIComponent(n.fromUid);
  if (['live', 'live_started'].includes(type)) return '/?action=live' + (n.hostUid ? '&host=' + encodeURIComponent(n.hostUid) : '');
  if (['tip', 'gift', 'sale', 'subscription', 'referral', 'withdrawal'].includes(type)) return '/?action=earn';
  return '/?action=notifications';
}
// Same-kind notifications on the same post replace each other on the phone instead of stacking up.
function tagFor(type, n) {
  if (type === 'dm') return 'dm-' + (n.fromUid || n.fromName || '');
  if (['like', 'comment', 'repost'].includes(type) && (n.sparkId || n.postId)) return type + '-' + (n.sparkId || n.postId);
  if (type === 'call') return 'call-' + (n.callId || '');
  return type + '-' + Date.now();
}
async function shouldSkip(to, n, type) {
  if (n.fromUid && n.fromUid === to) return 'self';
  if (!n.fromUid && !(type === 'dm' && n.dmId)) return null;
  try {
    const u = await db().collection('users').doc(to).get();
    if (n.fromUid && u.exists && (u.data().blockedUsers || []).includes(n.fromUid)) return 'blocked';
    if (type === 'dm' && n.dmId) {
      const dm = await db().collection('dms').doc(n.dmId).get();
      if (dm.exists && dm.data()['muted_' + to]) return 'muted';
    }
  } catch (_) {}
  return null;   // fail open: a failed lookup never hides a notification
}

let watcherStarted = false;
let onNew = null;   // live socket hook (set by server.js) — shows the notification instantly in an open app
function onNotification(fn) { onNew = fn; }
function startNotificationWatcher() {
  if (watcherStarted || !firebaseAdminConfigured()) return;
  watcherStarted = true;
  const since = admin.firestore.Timestamp.fromMillis(Date.now() - 5000);
  db().collection('notifications').where('createdAt', '>', since).onSnapshot((snap) => {
    snap.docChanges().forEach((ch) => {
      if (ch.type !== 'added') return;
      const n = ch.doc.data() || {};
      const to = recipientOf(n);
      if (!to) return;
      if (n.toUid !== to) ch.doc.ref.update({ toUid: to }).catch(() => {});   // makes it appear in the in-app list too
      if (onNew) { try { onNew(to, { type: 'RT_NOTIF', id: ch.doc.id, ntype: n.type || 'general', text: n.text || '', fromName: n.fromName || '' }); } catch (_) {} }
      if (n.pushedAt || n.noPush) return;
      const type = n.type || 'general';
      shouldSkip(to, n, type).then((why) => {
        if (why) return ch.doc.ref.update({ pushSkipped: why }).catch(() => {});
        return sendToUser(to, {
          title: TITLES[type] || 'Mindvora',
          body: String(n.text || 'You have a new notification').slice(0, 180),
          type, tag: tagFor(type, n), url: urlFor(type, n), urgent: type === 'call',
          data: n.callId ? { callId: n.callId, media: n.callType || '' } : undefined,
        }).then(() => ch.doc.ref.update({ pushedAt: admin.firestore.FieldValue.serverTimestamp() }).catch(() => {}));
      }).catch((e) => console.error('[PUSH]', e.message));
    });
  }, (err) => {
    console.error('[PUSH] Notification watcher stopped:', err.message);
    watcherStarted = false;
    setTimeout(startNotificationWatcher, 30000);
  });
  console.log('🔔 Push notification watcher active');
}

module.exports = { sendToUser, startNotificationWatcher, onNotification, TITLES, recipientOf, urlFor, tagFor, shouldSkip };
