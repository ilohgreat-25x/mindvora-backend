/**
 * MINDVORA — STORY EXPIRY SWEEP  ·  lib/story-cleanup.js
 * Stories live 48 h (expiresAt). Every 30 min this deletes expired story docs and, when Cloudinary admin
 * credentials are set (CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET), their photos.
 * No-op without Firebase Admin. Safe across Render restarts (state is in Firestore, not memory).
 */
'use strict';
const crypto = require('crypto');
const { admin, db, firebaseAdminConfigured } = require('./firebase-admin');

async function destroyPhoto(publicId) {
  const cloud = process.env.CLOUDINARY_CLOUD_NAME, key = process.env.CLOUDINARY_API_KEY, secret = process.env.CLOUDINARY_API_SECRET;
  if (!publicId || !cloud || !key || !secret) return false;
  const ts = Math.floor(Date.now() / 1000);
  const signature = crypto.createHash('sha1').update(`public_id=${publicId}&timestamp=${ts}${secret}`).digest('hex');
  const body = new URLSearchParams({ public_id: publicId, timestamp: String(ts), api_key: key, signature });
  const r = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/image/destroy`, { method: 'POST', body });
  return r.ok;
}

async function sweep() {
  if (!firebaseAdminConfigured()) return { skipped: true };
  const snap = await db().collection('stories').where('expiresAt', '<', admin.firestore.Timestamp.now()).limit(200).get();
  let deleted = 0, photos = 0;
  for (const d of snap.docs) {
    const m = d.data().media;
    try { if (m && m.publicId && await destroyPhoto(m.publicId)) photos++; } catch (e) { console.warn('[stories] photo delete failed', e.message); }
    await d.ref.delete(); deleted++;
  }
  if (deleted) console.log(`[stories] expired: ${deleted} deleted, ${photos} photos removed`);
  return { deleted, photos };
}

function start() {
  const run = () => sweep().catch((e) => console.error('[stories] sweep failed:', e.message));
  setTimeout(run, 60 * 1000).unref();
  setInterval(run, 30 * 60 * 1000).unref();
}
module.exports = { start, sweep };
