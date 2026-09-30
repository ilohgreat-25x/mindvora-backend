/**
 * MINDVORA — HUSMODATA VTU CLIENT  ·  lib/husmo.js
 *
 * API facts (from Husmodata's own client library, henryejemuta/laravel-husmodata):
 *   base URL  https://www.husmodata.com/api/        auth header  Authorization: Token <key>
 *   network   INTEGER id: MTN=1, GLO=2, 9MOBILE=3, AIRTEL=4
 *   airtime   POST topup/ { network, amount, mobile_number, Ported_number, airtime_type:'VTU' }
 *   data      POST data/  { network, plan: <PLAN ID>, mobile_number, Ported_number }
 *   account   GET  user/  (includes your balance and, on these panels, the data plans + ids)
 *
 * `plan` is a PLAN ID from your Husmodata account, NOT a label like "1GB".
 * Plan ids are resolved in this order:
 *   1. HUSMO_PLAN_MAP env var (JSON), e.g. {"mtn":{"1GB":"7","2GB":"8"},"glo":{"1GB":"41"}}
 *   2. config/husmo-plans.json (same shape)
 *   3. auto-lookup from GET user/ (matches size + network, picks the cheapest)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const BASE = (process.env.HUSMODATA_BASE_URL || 'https://www.husmodata.com/api').replace(/\/+$/, '');
const NETWORK_IDS = { mtn: 1, glo: 2, '9mobile': 3, airtel: 4 };
const NETWORK_NAMES = { mtn: 'MTN', glo: 'GLO', '9mobile': '9MOBILE', airtel: 'AIRTEL' };

const doFetch = (...a) => (globalThis.fetch ? globalThis.fetch(...a) : import('node-fetch').then((m) => m.default(...a)));

function configured() { return !!process.env.HUSMODATA_API_KEY; }

function headers() {
  return { Authorization: `Token ${process.env.HUSMODATA_API_KEY}`, 'Content-Type': 'application/json' };
}

async function call(method, endpoint, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 45000);
  try {
    const resp = await doFetch(`${BASE}/${endpoint}`, {
      method, headers: headers(), body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal,
    });
    const text = await resp.text();
    let data; try { data = JSON.parse(text); } catch (_) { data = { raw: text.slice(0, 500) }; }
    return { ok: resp.ok, status: resp.status, data };
  } finally { clearTimeout(t); }
}

/** 0803..., 234803..., +234803..., 803... -> 0803xxxxxxx (11 digits) or null */
function normalizePhone(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.startsWith('234') && d.length === 13) d = '0' + d.slice(3);
  if (d.length === 10 && !d.startsWith('0')) d = '0' + d;
  return /^0\d{10}$/.test(d) ? d : null;
}

function normSize(s) {
  const m = String(s || '').toUpperCase().replace(/\s+/g, '').match(/^(\d+(?:\.\d+)?)(MB|GB|TB)/);
  if (!m) return String(s || '').toUpperCase().replace(/\s+/g, '');
  let n = Number(m[1]), u = m[2];
  if (u === 'MB' && n >= 1000 && n % 1000 === 0) { n = n / 1000; u = 'GB'; }
  return `${n}${u}`;
}

function staticPlanMap() {
  try { if (process.env.HUSMO_PLAN_MAP) return JSON.parse(process.env.HUSMO_PLAN_MAP); }
  catch (e) { console.error('[HUSMO] HUSMO_PLAN_MAP is not valid JSON:', e.message); }
  try {
    const f = path.join(__dirname, '..', 'config', 'husmo-plans.json');
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) { console.error('[HUSMO] config/husmo-plans.json is not valid JSON:', e.message); }
  return {};
}

let planCache = { at: 0, plans: [] };

/** Walk the GET user/ response and collect every object that looks like a data plan. */
function collectPlans(node, out) {
  if (Array.isArray(node)) { node.forEach((n) => collectPlans(n, out)); return out; }
  if (node && typeof node === 'object') {
    const id = node.dataplan_id ?? node.plan_id ?? (node.plan && node.plan_network ? node.id : undefined);
    if (id !== undefined && node.plan !== undefined) {
      out.push({
        id: String(id),
        size: normSize(node.plan),
        label: String(node.plan),
        network: String(node.plan_network || node.network || '').toUpperCase(),
        amount: Number(String(node.plan_amount || node.amount || '').replace(/[^\d.]/g, '')) || null,
        validity: node.month_validate || node.validity || '',
        type: node.plan_type || '',
      });
    }
    Object.values(node).forEach((v) => { if (v && typeof v === 'object') collectPlans(v, out); });
  }
  return out;
}

async function accountPlans(force) {
  if (!force && planCache.plans.length && Date.now() - planCache.at < 60 * 60 * 1000) return planCache.plans;
  const r = await call('GET', 'user/');
  if (!r.ok) throw new Error(`Husmodata user/ returned ${r.status}`);
  const plans = collectPlans(r.data, []);
  planCache = { at: Date.now(), plans };
  return plans;
}

async function resolvePlanId(network, bundle) {
  const map = staticPlanMap();
  const fromMap = map[network] && (map[network][bundle] ?? map[network][normSize(bundle)]);
  if (fromMap !== undefined && fromMap !== null && fromMap !== '') return { planId: String(fromMap), source: 'map' };
  try {
    const want = normSize(bundle);
    const netName = NETWORK_NAMES[network];
    const matches = (await accountPlans()).filter((p) => p.size === want && p.network.includes(netName));
    if (matches.length) {
      matches.sort((a, b) => (a.amount ?? 1e12) - (b.amount ?? 1e12));
      return { planId: matches[0].id, source: 'account', plan: matches[0] };
    }
  } catch (e) {
    console.error('[HUSMO] Plan auto-lookup failed:', e.message);
  }
  return { planId: null, source: 'none' };
}

function outcome(r) {
  const s = String((r.data && (r.data.Status || r.data.status)) || '').toLowerCase();
  if (r.ok && (s === 'successful' || s === 'success')) return 'completed';
  if (r.ok && (s === 'processing' || s === 'pending')) return 'processing';
  return 'failed';
}

async function buyAirtime({ network, phone, amountNGN }) {
  const r = await call('POST', 'topup/', {
    network: NETWORK_IDS[network], amount: Math.round(amountNGN), mobile_number: phone,
    Ported_number: true, airtime_type: 'VTU',
  });
  return { status: outcome(r), http: r.status, provider: r.data };
}

async function buyData({ network, phone, planId }) {
  const r = await call('POST', 'data/', {
    network: NETWORK_IDS[network], plan: /^\d+$/.test(planId) ? Number(planId) : planId,
    mobile_number: phone, Ported_number: true,
  });
  return { status: outcome(r), http: r.status, provider: r.data };
}

async function balance() { return call('GET', 'user/'); }

module.exports = {
  configured, normalizePhone, normSize, resolvePlanId, accountPlans, buyAirtime, buyData, balance,
  NETWORK_IDS, BASE,
};
