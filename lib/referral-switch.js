/**
 * MINDVORA — REFERRAL ON/OFF SWITCH (OWNER ONLY) + "REFERRALS ARE LIVE" BROADCAST  ·  lib/referral-switch.js
 *
 * GET  /api/referral/status   → { enabled }                      (public)
 * POST /api/admin/referral    → body { enabled: true|false }      (owner's Firebase login only)
 *
 * Why this exists: firestore.rules lock app_settings (allow write: if false), so the old in-browser
 * toggle could never actually save. The switch now goes through the server (Firebase Admin).
 *
 * Turning referrals ON (from OFF) notifies EVERY Mindvora user:
 *   - one `notifications` doc per user (type 'referral') → shows in the in-app list, and the existing
 *     push watcher (lib/push.js) turns each one into a phone/desktop push + live in-app alert.
 *   Tapping it opens Earn (/?action=earn) where their referral link is.
 * The broadcast happens once per switch-on (re-saving ON while already ON does not spam users).
 * Payouts are unchanged: $1 to the direct referrer once the new user is active (lib/referral-integrity.js).
 */
'use strict';
const { admin, db, firebaseAdminConfigured } = require('./firebase-admin');

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'ilohgreat25@gmail.com').toLowerCase();
const DOC = () => db().collection('app_settings').doc('referral');
const TEXT = '🎉 Referrals are now LIVE on Mindvora! Share your referral link from Earn and get $1.00 for every friend who joins and gets active. No limit — start earning now!';

let broadcasting = false;

async function broadcast(switchId) {
  if (broadcasting) return { skipped: 'already_running' };
  broadcasting = true;
  try {
    const f = db();
    const users = await f.collection('users').select().get();
    let written = 0;
    let batch = f.batch(), n = 0;
    for (const u of users.docs) {
      batch.set(f.collection('notifications').doc(), {
        toUid: u.id, type: 'referral', text: TEXT, read: false, broadcast: 'referral_on', switchId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      if (++n === 400) { await batch.commit(); written += n; batch = f.batch(); n = 0; }
    }
    if (n) { await batch.commit(); written += n; }
    await DOC().set({ announcedSwitchId: switchId, announcedAt: admin.firestore.FieldValue.serverTimestamp(), announcedUsers: written }, { merge: true });
    console.log(`[REFERRAL] switched ON — notified ${written} users`);
    return { notified: written };
  } finally { broadcasting = false; }
}

function mount(app, { requireUser }) {
  app.get('/api/referral/status', async (_req, res) => {
    if (!firebaseAdminConfigured()) return res.json({ status: true, enabled: true, unknown: true });
    try {
      const d = await DOC().get();
      res.json({ status: true, enabled: !d.exists || d.data().enabled !== false });
    } catch (e) { res.status(500).json({ status: false, message: e.message }); }
  });

  app.post('/api/admin/referral', requireUser, async (req, res) => {
    if (String(req.user.email || '').toLowerCase() !== ADMIN_EMAIL) {
      return res.status(403).json({ status: false, message: 'Only the Mindvora owner can change the referral system.' });
    }
    if (typeof (req.body || {}).enabled !== 'boolean') return res.status(400).json({ status: false, message: 'enabled must be true or false' });
    const enabled = req.body.enabled;
    try {
      const prev = await DOC().get();
      const wasOn = prev.exists && prev.data().enabled === true && prev.data().announcedSwitchId === prev.data().switchId;
      const switchId = enabled && !wasOn ? 'on-' + Date.now() : (prev.exists && prev.data().switchId) || null;
      await DOC().set({
        enabled, switchId, updatedBy: req.user.email,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      if (!enabled || wasOn) return res.json({ status: true, enabled, notifying: 0 });
      // Guard against an accidental OFF→ON double tap re-notifying everyone within the hour.
      const lastAt = prev.exists && prev.data().announcedAt && prev.data().announcedAt.toMillis ? prev.data().announcedAt.toMillis() : 0;
      if (Date.now() - lastAt < 60 * 60 * 1000) {
        await DOC().set({ announcedSwitchId: switchId }, { merge: true });
        return res.json({ status: true, enabled, notifying: 0, note: 'Users were already notified less than an hour ago.' });
      }

      // Reply right away; the fan-out keeps running on the server.
      const count = (await db().collection('users').count().get()).data().count;
      res.json({ status: true, enabled, notifying: count });
      broadcast(switchId).catch((e) => console.error('[REFERRAL] broadcast failed:', e.message));
    } catch (e) {
      console.error('[REFERRAL] switch failed:', e.message);
      if (!res.headersSent) res.status(500).json({ status: false, message: e.message });
    }
  });
}

module.exports = { mount, broadcast };
