'use strict';
const crypto = require('crypto');
const { admin, db, firebaseAdminConfigured } = require('./firebase-admin');
const MB = 1024 * 1024;
const DEFAULTS = Object.freeze({ freeMB: 250, creatorGB: 5, proGB: 20, maxFileMB: 100, maxDailyUploads: 20 });
const SWEEP_LIMIT = 100;
const GRACE_MS = 24 * 60 * 60 * 1000;

function numberEnv(name, fallback) { const n = Number(process.env[name]); return Number.isFinite(n) && n >= 0 ? n : fallback; }
function config() { return { freeMB: numberEnv('MINDVORA_FREE_MEDIA_QUOTA_MB', DEFAULTS.freeMB), creatorGB: numberEnv('MINDVORA_CREATOR_MEDIA_QUOTA_GB', DEFAULTS.creatorGB), proGB: numberEnv('MINDVORA_PRO_MEDIA_QUOTA_GB', DEFAULTS.proGB), maxFileMB: numberEnv('MINDVORA_MAX_MEDIA_FILE_MB', DEFAULTS.maxFileMB), maxDailyUploads: numberEnv('MINDVORA_MAX_DAILY_UPLOADS', DEFAULTS.maxDailyUploads) }; }
function bytesForQuota(user) { const c = config(); const ent = user && user.mediaStorageEntitlement; if (ent === 'creator5gb') return c.creatorGB * 1024 ** 3; if (ent === 'creator20gb') return c.proGB * 1024 ** 3; if (user && user.plan === 'pro') return c.proGB * 1024 ** 3; return c.freeMB * MB; }
function quotaMath({ quotaBytes, usedBytes = 0, reservedBytes = 0, requestBytes = 0 }) { const available = Math.max(0, quotaBytes - usedBytes - reservedBytes); return { availableBytes: available, allowed: requestBytes > 0 && requestBytes <= available }; }
function cloudinaryConfigured() { return !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET); }
function safeType(t) { return ['image', 'video', 'raw'].includes(t) ? t : 'image'; }
function userDoc(uid) { return db().collection('users').doc(uid); }
function quotaView(uid, user) { const c = config(); const data = user || {}; const quotaBytes = bytesForQuota(data); return { uid, quotaBytes, usedBytes: Number(data.mediaUsageBytes || 0), reservedBytes: Number(data.mediaReservedBytes || 0), dailyUploads: Number(data.mediaDailyUploads || 0), dailyUploadsDate: data.mediaDailyUploadsDate || null, maxFileBytes: c.maxFileMB * MB, maxDailyUploads: c.maxDailyUploads, entitlement: data.mediaStorageEntitlement || 'free', configured: cloudinaryConfigured(), ...quotaMath({ quotaBytes, usedBytes: Number(data.mediaUsageBytes || 0), reservedBytes: Number(data.mediaReservedBytes || 0) }) }; }
async function getQuota(uid) { if (!firebaseAdminConfigured()) throw Object.assign(new Error('Firebase Admin is not configured'), { code: 'FIREBASE_ADMIN_NOT_CONFIGURED' }); const s = await userDoc(uid).get(); return quotaView(uid, s.exists ? s.data() : {}); }

function cloudinarySignature(params) { const canonical = Object.keys(params).filter(k => params[k] !== undefined && k !== 'api_key').sort().map(k => `${k}=${params[k]}`).join('&'); return crypto.createHash('sha1').update(canonical + process.env.CLOUDINARY_API_SECRET).digest('hex'); }
async function destroyAsset(publicId, resourceType = 'image') {
  if (!publicId || !cloudinaryConfigured()) return false;
  const type = safeType(resourceType); const timestamp = Math.floor(Date.now() / 1000);
  const params = { public_id: String(publicId).slice(0, 300), timestamp: String(timestamp), api_key: process.env.CLOUDINARY_API_KEY };
  params.signature = cloudinarySignature(params);
  const body = new URLSearchParams(params);
  const response = await fetch(`https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/${type}/destroy`, { method: 'POST', body });
  if (!response.ok) return false;
  let result = null; try { result = await response.json(); } catch (_) {}
  return !result || result.result === 'ok' || result.result === 'not found';
}

async function authorize({ uid, bytes, resourceType, fileName }) {
  if (!firebaseAdminConfigured()) throw Object.assign(new Error('Firebase Admin is not configured'), { code: 'FIREBASE_ADMIN_NOT_CONFIGURED' });
  if (!cloudinaryConfigured()) throw Object.assign(new Error('Cloudinary media signing is not configured'), { code: 'CLOUDINARY_NOT_CONFIGURED' });
  const n = Math.floor(Number(bytes)); const c = config(); if (!(n > 0)) throw Object.assign(new Error('A positive file size is required'), { code: 'INVALID_MEDIA_SIZE' }); if (n > c.maxFileMB * MB) throw Object.assign(new Error(`Media exceeds the ${c.maxFileMB} MB limit`), { code: 'MEDIA_FILE_TOO_LARGE' });
  const type = safeType(resourceType); const ref = userDoc(uid), reservation = db().collection('media_reservations').doc(); const now = admin.firestore.Timestamp.now();
  const result = await db().runTransaction(async tx => { const us = await tx.get(ref); const d = us.exists ? us.data() : {}; const day = new Date().toISOString().slice(0, 10); const daily = d.mediaDailyUploadsDate === day ? Number(d.mediaDailyUploads || 0) : 0; const quotaBytes = bytesForQuota(d); const check = quotaMath({ quotaBytes, usedBytes: Number(d.mediaUsageBytes || 0), reservedBytes: Number(d.mediaReservedBytes || 0), requestBytes: n }); if (!check.allowed) throw Object.assign(new Error('You have reached your up your media allowance, kindly delete older media to continue posting.'), { code: 'MEDIA_QUOTA_EXCEEDED' }); if (daily >= c.maxDailyUploads) throw Object.assign(new Error('Daily media upload limit reached.'), { code: 'DAILY_MEDIA_LIMIT' }); tx.set(ref, { mediaReservedBytes: admin.firestore.FieldValue.increment(n), mediaDailyUploads: daily + 1, mediaDailyUploadsDate: day }, { merge: true }); tx.set(reservation, { uid, bytes: n, resourceType: type, fileName: String(fileName || '').slice(0, 160), status: 'reserved', createdAt: now, expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + 30 * 60 * 1000) }); return { reservationId: reservation.id, quotaBytes, dailyUploads: daily + 1 }; });
  const ts = Math.floor(Date.now() / 1000); const publicId = `mindvora/${uid}/${result.reservationId}`; const params = { api_key: process.env.CLOUDINARY_API_KEY, timestamp: String(ts), public_id: publicId, folder: 'mindvora', context: `owner_uid=${uid}|reservation_id=${result.reservationId}`, transformation: type === 'image' ? 'q_auto,f_auto,c_limit,w_2400' : undefined }; Object.keys(params).forEach(k => params[k] === undefined && delete params[k]); params.signature = cloudinarySignature(params); return { reservationId: result.reservationId, uploadUrl: `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/${type}/upload`, params, quota: await getQuota(uid) };
}

async function closeReservation(uid, id, status, actualBytes, publicId, resourceType) {
  const ref = db().collection('media_reservations').doc(String(id)); let asset = null;
  const out = await db().runTransaction(async tx => { const s = await tx.get(ref); if (!s.exists) return { idempotent: true, status: 'missing' }; const r = s.data(); if (r.uid !== uid) throw Object.assign(new Error('Reservation owner mismatch'), { code: 'FORBIDDEN' }); if (r.status === status || ['released', 'finalized'].includes(r.status)) return { idempotent: true, status: r.status }; const bytes = Math.min(Number(actualBytes) || Number(r.bytes), Number(r.bytes)); const uref = userDoc(uid); tx.set(uref, { mediaReservedBytes: admin.firestore.FieldValue.increment(-Number(r.bytes)), ...(status === 'finalized' ? { mediaUsageBytes: admin.firestore.FieldValue.increment(bytes) } : {}) }, { merge: true }); const now = admin.firestore.Timestamp.now(); tx.update(ref, { status, actualBytes: bytes, ...(publicId ? { publicId: String(publicId).slice(0, 300) } : {}), closedAt: now }); if (status === 'finalized') { asset = { publicId: String(publicId || ''), resourceType: safeType(resourceType || r.resourceType) }; tx.set(db().collection('media_uploads').doc(), { uid, ownerUid: uid, bytes, publicId: asset.publicId, resourceType: asset.resourceType, reservationId: String(id), status: 'active', createdAt: now }); } return { idempotent: false, status }; });
  if (status === 'released' && publicId) await destroyAsset(publicId, resourceType);
  return out;
}
async function release(uid, id, publicId, resourceType) { const out = await closeReservation(uid, id, 'released', undefined, publicId, resourceType); if (publicId && out.status === 'finalized') await deleteOwnedAsset(uid, publicId, resourceType); return out; }
async function finalize(uid, id, actualBytes, publicId, resourceType) { return closeReservation(uid, id, 'finalized', actualBytes, publicId, resourceType); }

async function markUploadDeleted(uploadRef) {
  return db().runTransaction(async tx => { const snap = await tx.get(uploadRef); if (!snap.exists) return { idempotent: true, status: 'missing' }; const d = snap.data(); if (d.status === 'deleted') return { idempotent: true, status: 'deleted' }; if (d.status !== 'active') return { idempotent: true, status: d.status || 'unknown' }; tx.update(uploadRef, { status: 'deleted', deletedAt: admin.firestore.Timestamp.now() }); tx.set(userDoc(d.uid || d.ownerUid), { mediaUsageBytes: admin.firestore.FieldValue.increment(-Math.max(0, Number(d.bytes) || 0)) }, { merge: true }); return { idempotent: false, status: 'deleted', bytes: Math.max(0, Number(d.bytes) || 0) }; });
}
async function deleteOwnedAsset(uid, publicId, resourceType) {
  if (!firebaseAdminConfigured() || !publicId) return { idempotent: true, status: 'missing' };
  const snap = await db().collection('media_uploads').where('uid', '==', uid).where('publicId', '==', String(publicId)).limit(5).get();
  if (snap.empty) return { idempotent: true, status: 'not_found' };
  let deleted = 0; for (const doc of snap.docs) { const d = doc.data(); if (d.status === 'deleted') continue; if (!await destroyAsset(d.publicId, d.resourceType || resourceType)) continue; await markUploadDeleted(doc.ref); deleted++; }
  return { status: deleted ? 'deleted' : 'not_deleted', deleted };
}
async function deleteTrackedAsset(publicId, resourceType) {
  if (!firebaseAdminConfigured() || !publicId) return { idempotent: true, status: 'missing' };
  const snap = await db().collection('media_uploads').where('publicId', '==', String(publicId)).limit(5).get();
  let deleted = 0;
  for (const doc of snap.docs) { const d = doc.data(); if (d.status === 'deleted') continue; if (!await destroyAsset(d.publicId, d.resourceType || resourceType)) continue; await markUploadDeleted(doc.ref); deleted++; }
  return { status: deleted ? 'deleted' : 'not_deleted', deleted };
}

async function isReferenced(publicId) {
  const collections = ['sparks', 'stories', 'comments'];
  const sparks = await db().collection('sparks').limit(300).get();
  for (const doc of sparks.docs) { if (containsReference(doc.data(), publicId, 'sparks')) return true; const comments = await doc.ref.collection('comments').limit(100).get(); for (const comment of comments.docs) if (containsReference(comment.data(), publicId, 'comments')) return true; }
  for (const name of collections.slice(1)) { const snap = await db().collection(name).limit(300).get(); for (const doc of snap.docs) if (containsReference(doc.data(), publicId, name)) return true; }
  return false;
}
function containsReference(value, publicId, collection) {
  if (!value || typeof value !== 'object') return false;
  for (const [key, child] of Object.entries(value)) { if ((key === 'mediaPublicId' || key === 'voicePublicId' || (collection === 'stories' && key === 'publicId')) && child === publicId) return true; if ((key === 'mediaUrl' || key === 'voiceUrl') && typeof child === 'string' && child.includes(publicId)) return true; if (containsReference(child, publicId, collection)) return true; }
  return false;
}
async function cleanup() {
  if (!firebaseAdminConfigured()) return { skipped: true };
  const now = admin.firestore.Timestamp.now(); const expired = await db().collection('media_reservations').where('expiresAt', '<', now).where('status', '==', 'reserved').limit(SWEEP_LIMIT).get(); let released = 0, reconciled = 0, skipped = 0;
  for (const d of expired.docs) { try { await release(d.data().uid, d.id, d.data().publicId, d.data().resourceType); released++; } catch (_) {} }
  const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - GRACE_MS); const active = await db().collection('media_uploads').where('status', '==', 'active').limit(SWEEP_LIMIT).get();
  for (const doc of active.docs) { const d = doc.data(); const created = d.createdAt && typeof d.createdAt.toMillis === 'function' ? d.createdAt.toMillis() : 0; if (!created || created >= cutoff.toMillis() || !d.publicId || !d.resourceType) { skipped++; continue; } try { if (await isReferenced(d.publicId)) { skipped++; continue; } if (await destroyAsset(d.publicId, d.resourceType)) { await markUploadDeleted(doc.ref); reconciled++; } } catch (_) {} }
  return { released, reconciled, skipped };
}
function startCleanup() { const run = () => cleanup().catch(e => console.warn('[media-quota] cleanup failed:', e.message)); setTimeout(run, 60000).unref(); setInterval(run, 30 * 60 * 1000).unref(); }
module.exports = { DEFAULTS, config, bytesForQuota, quotaMath, cloudinaryConfigured, getQuota, authorize, release, finalize, destroyAsset, deleteOwnedAsset, deleteTrackedAsset, markUploadDeleted, cleanup, startCleanup };
