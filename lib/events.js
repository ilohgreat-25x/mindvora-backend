/**
 * MINDVORA — PAID EVENTS (slide-out "Paid Events")  ·  lib/events.js
 *
 * Before: events could not be created at all (rules deny client writes), the
 * "ticket" was granted by the browser after the popup with a 10% cut, and the
 * meeting link was readable by every signed-in user.
 *
 * Now (server only):
 *  - organiser creates an event with price ($0 = free) and capacity;
 *  - paid tickets: price comes from the event doc, Paystack verified on the server,
 *    fulfilled once per reference (lib/payments.js processed_payments);
 *  - ticket issued in paid_events/{id}/tickets/{uid}; capacity enforced in a
 *    transaction; a payment that lands after sell-out is auto-refunded;
 *  - organiser earns price − 20% (owner ledger via payments.recordEarning);
 *  - meeting link kept in paid_events/{id}/private/details (no client access) and
 *    handed out only to the organiser and ticket holders by /api/events/:id/access;
 *  - buyer + organiser get in-app/push notifications, owner gets admin_events
 *    (+ ADMIN_EVENT on the existing WebSocket).
 */
'use strict';

const { admin, db } = require('./firebase-admin');

const doFetch = (...a) => (globalThis.fetch ? globalThis.fetch(...a) : import('node-fetch').then((m) => m.default(...a)));
const FV = () => admin.firestore.FieldValue;
const round2 = (n) => Math.round(n * 100) / 100;
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'ilohgreat25@gmail.com').toLowerCase();
const MAX_PRICE = 1000, MAX_CAPACITY = 100000;
let deps = { emit: () => 0, push: null };
let adminUidCache = null;

const col = () => db().collection('paid_events');
function clean(v, n) { return String(v || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n); }

async function adminUid() {
  if (adminUidCache) return adminUidCache;
  try { adminUidCache = (await admin.auth().getUserByEmail(ADMIN_EMAIL)).uid; } catch (_) {}
  return adminUidCache;
}
async function ownerEvent(kind, text, extra) {
  await db().collection('admin_events').add({ kind, text, ...(extra || {}), read: false, createdAt: FV().serverTimestamp() })
    .catch((e) => console.error('[EVENTS] admin_events', e.message));
  const a = await adminUid();
  if (a) {
    try { deps.emit(a, { type: 'ADMIN_EVENT', kind, text, eventId: (extra && extra.eventId) || '' }); } catch (_) {}
    if (deps.push && /ticket_sold|refund/.test(kind)) deps.push.sendToUser(a, { title: 'Mindvora Admin', body: text, type: 'admin', tag: kind + '-' + Date.now(), url: '/?action=admin' }).catch(() => {});
  }
  console.log('[EVENTS]', text);
}
async function notify(toUid, type, text, extra) {
  await db().collection('notifications').add({ toUid, type, text, read: false, createdAt: FV().serverTimestamp(), ...(extra || {}) })
    .catch(() => {});   // the push watcher turns this into a phone notification
  try { deps.emit(toUid, { type: 'RT_NOTIF', ntype: type, text, ...(extra || {}) }); } catch (_) {}
}
async function nameOf(uid) {
  try { const s = await db().collection('users').doc(uid).get(); return (s.exists && s.data().name) || 'Someone'; } catch (_) { return 'Someone'; }
}

/** Price a ticket from the event document (never from the browser). Used by payments.priceAny. */
async function priceTicket(params, uid) {
  const id = params && typeof params.eventId === 'string' ? params.eventId.slice(0, 64) : '';
  if (!id) return { ok: false, message: 'Missing event.' };
  const s = await col().doc(id).get();
  if (!s.exists) return { ok: false, message: 'Event not found.' };
  const ev = s.data();
  if (ev.status === 'cancelled') return { ok: false, message: 'This event was cancelled.' };
  if (ev.hostId === uid) return { ok: false, message: 'You are the organiser of this event.' };
  const price = Number(ev.price) || 0;
  if (price <= 0) return { ok: false, message: 'This event is free — just join it.' };
  if (ev.capacity && (ev.ticketsSold || 0) >= ev.capacity) return { ok: false, message: 'Sold out.' };
  return { ok: true, usd: price, description: `Ticket: ${clean(ev.title, 60)}`, params: { eventId: id } };
}

// Atomically issue a ticket. Returns { issued, already, soldOut, ev }.
async function issue(eventId, uid, extra) {
  const evRef = col().doc(eventId), tRef = evRef.collection('tickets').doc(uid);
  return db().runTransaction(async (tx) => {
    const [es, ts] = await Promise.all([tx.get(evRef), tx.get(tRef)]);
    if (!es.exists) return { missing: true };
    const ev = es.data();
    if (ts.exists && ts.data().status === 'valid') return { already: true, ev };
    if (ev.capacity && (ev.ticketsSold || 0) >= ev.capacity) return { soldOut: true, ev };
    tx.set(tRef, { uid, status: 'valid', ...extra, createdAt: FV().serverTimestamp() });
    tx.update(evRef, { attendees: FV().arrayUnion(uid), ticketsSold: FV().increment(1),
      ...(extra.net ? { revenue: FV().increment(extra.net), grossSales: FV().increment(extra.usd) } : {}) });
    return { issued: true, ev };
  });
}

async function refundPaystack(reference, note) {
  const r = await doFetch('https://api.paystack.co/refund', { method: 'POST',
    headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ transaction: reference, merchant_note: note, customer_note: note }) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body.status) {
    if (/already\s+(been\s+)?(fully\s+)?refunded/i.test(body.message || '')) return { ok: true, already: true };
    throw new Error(body.message || ('Paystack refund ' + r.status));
  }
  return { ok: true, id: (body.data && body.data.id) || '' };
}

/** Called by lib/payments.js (inside the once-per-reference claim) when a ticket payment is confirmed. */
async function onTicketPaid({ uid, params, reference, usd, provider }) {
  const payments = require('./payments');
  const eventId = params.eventId;
  const fee = round2(usd * 0.20), net = round2(usd - fee);
  const out = await issue(eventId, uid, { usd, fee, net, reference, provider });
  const buyer = await nameOf(uid);
  if (out.missing || out.soldOut) {
    const why = out.missing ? 'the event no longer exists' : 'the event sold out before your payment arrived';
    try {
      await refundPaystack(reference, `Mindvora event ticket refund: ${why}`);
      await notify(uid, 'event_ticket', `↩️ Your ticket payment was refunded because ${why}.`, { eventId });
      await ownerEvent('event_refund', `↩️ Ticket refunded to ${buyer} ($${usd}) — ${why}`, { eventId, reference });
      return { granted: 'event_ticket', refunded: true, reason: why };
    } catch (e) {
      await ownerEvent('event_refund_failed', `⚠️ TICKET REFUND FAILED for ${buyer} ($${usd}, ref ${reference}) — ${e.message}. Refund manually in Paystack.`, { eventId, reference });
      await notify(uid, 'event_ticket', `Your ticket could not be issued (${why}). Mindvora support will refund you.`, { eventId });
      return { granted: 'event_ticket', refunded: false, reason: why };
    }
  }
  const ev = out.ev;
  if (out.already) return { granted: 'event_ticket', already: true, eventId };
  await db().collection('users').doc(ev.hostId).update({ earnings: FV().increment(net) });
  await payments.recordEarning({ earnerUid: ev.hostId, payerUid: uid, kind: 'event_ticket', gross: usd, reference, provider });
  await notify(uid, 'event_ticket', `🎟 Your ticket for "${ev.title}" is confirmed. Open Paid Events to get the event link.`, { eventId });
  await notify(ev.hostId, 'event_ticket', `🎟 ${buyer} bought a ticket for "${ev.title}" — $${usd}. You receive $${net} (20% Mindvora fee: $${fee}).`,
    { eventId, fromUid: uid, fromName: buyer, gross: usd, fee, net });
  await ownerEvent('ticket_sold', `🎟 Ticket sold: "${ev.title}" — $${usd} (Mindvora fee $${fee})`, { eventId, reference, fee });
  if (ev.capacity && (ev.ticketsSold || 0) + 1 >= ev.capacity) await notify(ev.hostId, 'event_ticket', `🎉 "${ev.title}" is sold out!`, { eventId });
  return { granted: 'event_ticket', eventId, credited: net };
}

function mount(app, { requireUser, emit, push }) {
  deps = { emit: emit || deps.emit, push: push || null };
  const ads = require('./ads');

  // Create an event (organiser). $0 = free event.
  app.post('/api/events', requireUser, async (req, res) => {
    try {
      const b = req.body || {};
      const title = clean(b.title, 100), description = clean(b.description, 1000), link = clean(b.meetingLink, 500);
      const price = Math.round((Number(b.price) || 0) * 100) / 100, capacity = Math.floor(Number(b.capacity) || 0);
      const when = new Date(b.eventDate);
      if (!title) return res.status(400).json({ ok: false, message: 'Enter a title.' });
      if (isNaN(when.getTime())) return res.status(400).json({ ok: false, message: 'Enter the event date and time.' });
      if (when.getTime() < Date.now() - 3600e3) return res.status(400).json({ ok: false, message: 'The event date is in the past.' });
      if (!(price === 0 || (price >= 1 && price <= MAX_PRICE))) return res.status(400).json({ ok: false, message: `Price must be $0 (free) or $1–$${MAX_PRICE}.` });
      if (capacity < 0 || capacity > MAX_CAPACITY) return res.status(400).json({ ok: false, message: 'Capacity must be 0 (unlimited) or up to 100,000.' });
      if (link && !/^https:\/\//i.test(link)) return res.status(400).json({ ok: false, message: 'The event link must start with https://' });
      const why = await ads.moderate({ title, description, cta: '', url: link }, { deep: false });
      if (why) return res.status(400).json({ ok: false, message: `This event can't be published: ${why}.` });
      const ps = await db().collection('users').doc(req.user.uid).get(); const p = ps.exists ? ps.data() : {};
      const ref = col().doc();
      await ref.set({ title, description, eventDate: when, price, capacity, isFree: price === 0, status: 'active',
        hostId: req.user.uid, hostName: p.name || 'Mindvora user', hostHandle: p.handle || 'user',
        attendees: [], ticketsSold: 0, revenue: 0, grossSales: 0, hasLink: !!link, createdAt: FV().serverTimestamp() });
      await ref.collection('private').doc('details').set({ meetingLink: link, updatedAt: FV().serverTimestamp() });
      await ownerEvent('event_created', `🎟 New ${price ? '$' + price : 'free'} event by ${p.name || 'a user'}: "${title}"`, { eventId: ref.id });
      res.json({ ok: true, eventId: ref.id });
    } catch (e) { console.error('[EVENTS] create', e); res.status(500).json({ ok: false, message: 'Could not create the event. Try again.' }); }
  });

  // Free events: join without paying.
  app.post('/api/events/:id/join', requireUser, async (req, res) => {
    try {
      const id = clean(req.params.id, 64); const s = await col().doc(id).get();
      if (!s.exists) return res.status(404).json({ ok: false, message: 'Event not found.' });
      const ev = s.data();
      if ((Number(ev.price) || 0) > 0) return res.status(402).json({ ok: false, message: 'This event needs a ticket.' });
      if (ev.hostId === req.user.uid) return res.json({ ok: true, already: true });
      const out = await issue(id, req.user.uid, { usd: 0 });
      if (out.soldOut) return res.status(409).json({ ok: false, soldOut: true, message: 'This event is full.' });
      if (out.issued) {
        const n = await nameOf(req.user.uid);
        await notify(ev.hostId, 'event_ticket', `🎟 ${n} joined your free event "${ev.title}".`, { eventId: id, fromUid: req.user.uid, fromName: n });
        await notify(req.user.uid, 'event_ticket', `🎟 You're in! "${ev.title}" — open Paid Events for the link.`, { eventId: id });
      }
      res.json({ ok: true, already: !!out.already });
    } catch (e) { console.error('[EVENTS] join', e); res.status(500).json({ ok: false, message: 'Could not join. Try again.' }); }
  });

  // Event link: organiser and ticket holders only.
  app.get('/api/events/:id/access', requireUser, async (req, res) => {
    try {
      const id = clean(req.params.id, 64); const ref = col().doc(id);
      const [s, t, d] = await Promise.all([ref.get(), ref.collection('tickets').doc(req.user.uid).get(), ref.collection('private').doc('details').get()]);
      if (!s.exists) return res.status(404).json({ ok: false, message: 'Event not found.' });
      const host = s.data().hostId === req.user.uid;
      if (!host && !(t.exists && t.data().status === 'valid')) return res.status(403).json({ ok: false, message: 'Get a ticket to see the event link.' });
      res.json({ ok: true, meetingLink: (d.exists && d.data().meetingLink) || '', host });
    } catch (e) { console.error('[EVENTS] access', e); res.status(500).json({ ok: false, message: 'Could not load the event link.' }); }
  });

  // Which events do I hold a ticket for? (the list view marks them)
  app.get('/api/events/mine', requireUser, async (req, res) => {
    try {
      const snap = await db().collectionGroup('tickets').where('uid', '==', req.user.uid).limit(200).get();
      res.json({ ok: true, eventIds: snap.docs.filter((d) => d.data().status === 'valid').map((d) => d.ref.parent.parent.id) });
    } catch (e) { res.json({ ok: true, eventIds: [], note: 'fallback' }); }
  });
}

module.exports = { mount, priceTicket, onTicketPaid };
