/**
 * MINDVORA — SERVER-SIDE PRICE CATALOG  ·  lib/catalog.js
 *
 * The server is the only place that decides what something costs and what a
 * payment unlocks. The browser sends a *purpose* + *params*; the price is
 * looked up here, never taken from the client.
 *
 * Keep these numbers in sync with the prices shown in index.html / script.js.
 */
'use strict';

const NGN_PER_USD   = Number(process.env.NGN_PER_USD || 1600);   // must match usdToNGNKobo() in script.js
// Owner rule: Mindvora keeps a flat 20% of every user earning (tips, gifts, sales, subscriptions…).
// Fixed in code on purpose — an old CREATOR_SHARE env var on Render must not change it. Referral rewards are NOT earnings here.
const PLATFORM_FEE = 0.20;
const CREATOR_SHARE = 1 - PLATFORM_FEE;  // creator keeps 80%

const PLANS = {
  basic:   { usd: 5,  name: 'Mindvora Basic'   },
  pro:     { usd: 10, name: 'Mindvora Pro'     },
  creator: { usd: 15, name: 'Mindvora Creator' },
};

const BADGE_USD = 25;

const GIFTS = {
  Rose:    { usd: 1,  emoji: '🌸' },
  Pizza:   { usd: 2,  emoji: '🍕' },
  Diamond: { usd: 5,  emoji: '💎' },
  Rocket:  { usd: 10, emoji: '🚀' },
  Crown:   { usd: 20, emoji: '👑' },
  Trophy:  { usd: 50, emoji: '🏆' },
};

// size label (as shown on the data cards) -> USD price
const DATA_BUNDLES = {
  '500MB': 0.10, '1GB': 0.20, '2GB': 0.35, '5GB': 0.65,
  '10GB': 1.30, '20GB': 2.25, '50GB': 4.50, 'Unlimited': 9.99,
};

const TIP_MIN_USD = 1, TIP_MAX_USD = 1000;
const AIRTIME_MIN_USD = 1, AIRTIME_MAX_USD = 100;

const NETWORK_ALIASES = {
  'mtn nigeria': 'mtn', mtn: 'mtn',
  'airtel nigeria': 'airtel', airtel: 'airtel', air: 'airtel',
  'glo nigeria': 'glo', glo: 'glo',
  '9mobile nigeria': '9mobile', '9mobile': '9mobile', etisalat: '9mobile', eti: '9mobile',
};

function normNetwork(n) {
  return NETWORK_ALIASES[String(n || '').toLowerCase().trim()] || null;
}

function usdToKobo(usd) {
  return Math.round(Number(usd) * NGN_PER_USD * 100);
}

/**
 * Price an order. Returns { ok:true, usd, description, params } with the
 * params normalised, or { ok:false, message }.
 */
const AD_PACKAGES = { 5: 500, 10: 1200, 25: 3500, 50: 8000, 100: 20000, 250: 60000 };

function priceOrder(purpose, rawParams, uid) {
  const p = rawParams && typeof rawParams === 'object' ? rawParams : {};
  switch (purpose) {
    case 'premium': {
      const plan = PLANS[p.plan];
      if (!plan) return { ok: false, message: 'Unknown plan.' };
      return { ok: true, usd: plan.usd, description: `${plan.name} Monthly Subscription`, params: { plan: p.plan } };
    }
    case 'badge':
      return { ok: true, usd: BADGE_USD, description: 'Mindvora Verified Badge', params: {} };
    case 'tip': {
      const usd = Math.floor(Number(p.amountUSD));
      if (!p.recipientId || typeof p.recipientId !== 'string') return { ok: false, message: 'Missing tip recipient.' };
      if (p.recipientId === uid) return { ok: false, message: 'You cannot tip yourself.' };
      if (!(usd >= TIP_MIN_USD && usd <= TIP_MAX_USD)) return { ok: false, message: `Tip must be $${TIP_MIN_USD}–$${TIP_MAX_USD}.` };
      return { ok: true, usd, description: 'Mindvora creator tip', params: { recipientId: p.recipientId, amountUSD: usd } };
    }
    case 'gift': {
      const g = GIFTS[p.gift];
      if (!g) return { ok: false, message: 'Unknown gift.' };
      if (!p.recipientId || typeof p.recipientId !== 'string') return { ok: false, message: 'Missing gift recipient.' };
      if (p.recipientId === uid) return { ok: false, message: 'You cannot send a gift to yourself.' };
      return { ok: true, usd: g.usd, description: `${p.gift} gift on Mindvora`,
        params: { recipientId: p.recipientId, gift: p.gift, liveId: typeof p.liveId === 'string' ? p.liveId.slice(0, 128) : '' } };
    }
    case 'airtime': {
      const usd = Math.floor(Number(p.amountUSD));
      const network = normNetwork(p.network);
      if (!network) return { ok: false, message: 'Airtime is only available for Nigerian networks.' };
      if (!(usd >= AIRTIME_MIN_USD && usd <= AIRTIME_MAX_USD)) return { ok: false, message: `Airtime must be $${AIRTIME_MIN_USD}–$${AIRTIME_MAX_USD}.` };
      if (!p.phone) return { ok: false, message: 'Missing phone number.' };
      return { ok: true, usd, description: `Airtime ${network.toUpperCase()}`,
        params: { network, phone: String(p.phone), amountUSD: usd, amountNGN: Math.round(usd * NGN_PER_USD) } };
    }
    case 'data': {
      const usd = DATA_BUNDLES[p.bundle];
      const network = normNetwork(p.network);
      if (!network) return { ok: false, message: 'Data is only available for Nigerian networks.' };
      if (usd === undefined) return { ok: false, message: 'Unknown data bundle.' };
      if (!p.phone) return { ok: false, message: 'Missing phone number.' };
      return { ok: true, usd, description: `Data ${p.bundle} ${network.toUpperCase()}`,
        params: { network, phone: String(p.phone), bundle: p.bundle } };
    }
    case 'ad': {   // paid advert — price comes from the package, never from the browser
      const budget = Number(p.budget); const views = AD_PACKAGES[budget];
      if (!views) return { ok: false, message: 'Unknown ad package.' };
      if (!p.adId || typeof p.adId !== 'string') return { ok: false, message: 'Missing ad.' };
      return { ok: true, usd: budget, description: `Mindvora ad — ${views} views`, params: { adId: p.adId.slice(0, 64), budget, views } };
    }
    default:
      return { ok: false, message: 'Unknown payment purpose.' };
  }
}

module.exports = {
  NGN_PER_USD, CREATOR_SHARE, PLATFORM_FEE, PLANS, BADGE_USD, GIFTS, DATA_BUNDLES,
  priceOrder, usdToKobo, normNetwork,
};
