'use strict';
const { admin, db, firebaseAdminConfigured } = require('./firebase-admin');
const mediaQuota = require('./media-quota');

async function sweep() {
  if (!firebaseAdminConfigured()) return { skipped: true };
  const snap = await db().collection('stories').where('expiresAt', '<', admin.firestore.Timestamp.now()).limit(200).get();
  let deleted = 0, photos = 0;
  for (const d of snap.docs) {
    const m = d.data().media;
    // Remove the story first; mediaQuota's transaction makes quota release idempotent.
    await d.ref.delete(); deleted++;
    if (m && m.publicId) {
      try {
        const result = await mediaQuota.deleteTrackedAsset(m.publicId, 'image');
        if (result.deleted) photos += result.deleted;
      } catch (e) { console.warn('[stories] media quota release failed', e.message); }
    }
  }
  if (deleted) console.log(`[stories] expired: ${deleted} deleted, ${photos} media records released`);
  return { deleted, photos };
}

function start() {
  const run = () => sweep().catch((e) => console.error('[stories] sweep failed:', e.message));
  setTimeout(run, 60 * 1000).unref();
  setInterval(run, 30 * 60 * 1000).unref();
}
module.exports = { start, sweep };
