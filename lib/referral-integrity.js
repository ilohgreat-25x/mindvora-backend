/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  MINDVORA — REFERRAL INTEGRITY  ·  lib/referral-integrity.js         ║
 * ║                                                                      ║
 * ║  Two jobs, run on a timer:                                           ║
 * ║                                                                      ║
 * ║  1. PAY QUALIFIED REFERRALS                                          ║
 * ║     A referral only pays out once the new user proves they're real   ║
 * ║     by doing at least ONE of:                                        ║
 * ║       • posted something (sparks collection)                        ║
 * ║       • sent a gift (gifts.senderId)                                 ║
 * ║       • received a gift (gifts.hostId)                               ║
 * ║       • successfully referred someone else themselves                ║
 * ║     The moment any of these happens, the referrer is credited $1     ║
 * ║     and the referral record is marked paid — no waiting period.      ║
 * ║                                                                      ║
 * ║  2. DISABLE STALE ACCOUNTS                                           ║
 * ║     Any account 30+ days old that has done NONE of the above is      ║
 * ║     disabled both in Firestore (profile flag) and in Firebase Auth   ║
 * ║     (so they can't just log back in). Since payout is qualification- ║
 * ║     gated, a stale account was, by definition, never paid out on —   ║
 * ║     there's nothing to claw back.                                    ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

'use strict';

const { db, auth, firebaseAdminConfigured } = require('./firebase-admin');
const { admin } = require('./firebase-admin');

const STALE_DAYS = 30;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours

/** Has this user done at least one qualifying action? */
async function hasQualifyingActivity(uid) {
  const f = db();

  const posted = await f.collection('sparks').where('uid', '==', uid).limit(1).get();
  if (!posted.empty) return true;

  const sentGift = await f.collection('gifts').where('senderId', '==', uid).limit(1).get();
  if (!sentGift.empty) return true;

  const receivedGift = await f.collection('gifts').where('hostId', '==', uid).limit(1).get();
  if (!receivedGift.empty) return true;

  const referredSomeone = await f.collection('referrals').where('referrerId', '==', uid).limit(1).get();
  if (!referredSomeone.empty) return true;

  return false;
}

/** Job 1: find unpaid referrals whose new user has now qualified, and pay them. */
async function payQualifiedReferrals() {
  const f = db();
  const pending = await f.collection('referrals').where('paid', '==', false).get();
  if (pending.empty) return { checked: 0, paid: 0 };

  let paidCount = 0;
  for (const doc of pending.docs) {
    const { referrerId, newUserId } = doc.data();
    if (!referrerId || !newUserId) continue;

    try {
      const qualifies = await hasQualifyingActivity(newUserId);
      if (!qualifies) continue;

      const referrerRef = f.collection('users').doc(referrerId);
      const referrerSnap = await referrerRef.get();
      if (!referrerSnap.exists) {
        await doc.ref.update({ paid: true, paidAt: admin.firestore.FieldValue.serverTimestamp(), skippedReason: 'referrer_not_found' });
        continue;
      }

      await referrerRef.update({
        earnings: admin.firestore.FieldValue.increment(1),
        referralCount: admin.firestore.FieldValue.increment(1),
      });
      await doc.ref.update({ paid: true, paidAt: admin.firestore.FieldValue.serverTimestamp() });
      await f.collection('notifications').add({
        uid: referrerId,
        type: 'referral',
        text: '🎉 Your referral is active! You earned $1.00',
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      paidCount++;
    } catch (err) {
      console.error('[referral-integrity] failed to process referral', doc.id, err.message);
    }
  }
  return { checked: pending.size, paid: paidCount };
}

/** Job 2: disable accounts that are 30+ days old with zero qualifying activity ever. */
async function disableStaleAccounts() {
  const f = db();
  const cutoff = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000);

  // NOTE: intentionally only one range/inequality filter here (createdAt).
  // Combining it with `.where('disabled', '!=', true)` would require a
  // composite index that doesn't exist in this project and would throw
  // FAILED_PRECONDITION on every run — so we filter `disabled` in code instead.
  const snap = await f.collection('users')
    .where('createdAt', '<=', cutoff)
    .get();

  const candidates = snap.docs.filter(doc => doc.data().disabled !== true);
  if (candidates.length === 0) return { checked: 0, disabled: 0 };

  let disabledCount = 0;
  for (const doc of candidates) {
    const uid = doc.id;
    try {
      const qualifies = await hasQualifyingActivity(uid);
      if (qualifies) continue; // real user — leave alone

      await doc.ref.update({
        disabled: true,
        disabledAt: admin.firestore.FieldValue.serverTimestamp(),
        disabledReason: `Inactive for ${STALE_DAYS}+ days after signup, no activity`,
      });

      try {
        await auth().updateUser(uid, { disabled: true });
      } catch (authErr) {
        console.error('[referral-integrity] could not disable auth for', uid, authErr.message);
      }

      disabledCount++;
    } catch (err) {
      console.error('[referral-integrity] failed to check account', uid, err.message);
    }
  }
  return { checked: candidates.length, disabled: disabledCount };
}

async function runIntegrityCheck() {
  if (!firebaseAdminConfigured()) {
    console.log('[referral-integrity] skipped — Firebase Admin not configured yet');
    return null;
  }
  const payouts = await payQualifiedReferrals();
  const disables = await disableStaleAccounts();
  console.log(`[referral-integrity] payouts: ${payouts.paid}/${payouts.checked} · disabled: ${disables.disabled}/${disables.checked}`);
  return { payouts, disables };
}

function startReferralIntegrityJob() {
  // Run once shortly after boot, then on a fixed interval.
  setTimeout(() => runIntegrityCheck().catch(err => console.error('[referral-integrity]', err.message)), 60 * 1000);
  setInterval(() => runIntegrityCheck().catch(err => console.error('[referral-integrity]', err.message)), CHECK_INTERVAL_MS);
}

module.exports = { runIntegrityCheck, startReferralIntegrityJob };
