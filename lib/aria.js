/**
 * MINDVORA — ARIA AI ASSISTANT  ·  lib/aria.js
 * POST /api/aria/chat  { messages: [{role:'user'|'assistant', content}], appHint? }
 * Answers questions about Mindvora (built-in app guide below) AND general
 * questions, using Google Gemini (free tier) or Groq. The key lives only in
 * Render (GEMINI_API_KEY or GROQ_API_KEY) — never in the website code.
 */
'use strict';

const APP_GUIDE = `
Mindvora is a social app. Features and how to use them:
- Sparks: posts (text, photos, video). Tap the + / "Spark" button, write, attach media, post.
- Stories: disappear after 24–48 hours. Add one from the stories bar at the top of the feed.
- Reels: short videos in the Reels tab. Live streaming: go live from the Live option.
- Messages (DMs): open Messages, pick a chat. Voice call = 📞 button, video call = 🎥 button in the chat header.
- Groups and communities, games, marketplace (sell/buy items with listings).
- Premium plans (Basic/Pro/Creator) and verified badge are paid with Paystack card or crypto; granted after the server confirms payment.
- Earnings: creators receive tips and gifts (creator share set by the owner, default 90%), referral rewards; withdraw from the Earnings screen to a bank account or crypto.
- Airtime and data top-up for MTN, Airtel, Glo, 9mobile, paid by card.
- Analytics shows views, reach and engagement. Ads/boost lets users promote posts.
- Account: sign up with email + verification code sent to your email; reCAPTCHA check. Edit profile in Settings.
- Notifications work even when the app is closed once you tap "Turn on" (iPhone: add Mindvora to Home Screen first).
- Safety: report/block users from their profile or a post menu. Never share your password or verification code.
- Support: use Help / Settings in the app.
`;

const SYSTEM = `You are ARIA, the friendly assistant inside the Mindvora social app.
You help with two kinds of questions:
1) Questions about Mindvora — answer from the app guide below. If the guide doesn't cover it, say you're not sure and suggest checking Settings or Help. Never invent Mindvora features, prices or policies.
2) Any general question (news-free knowledge, writing captions, advice, school work, coding, etc.) — answer helpfully from your general knowledge. Say so if something may be out of date.
Keep answers short, clear and warm. Use simple English; Nigerian Pidgin is fine if the user writes in it.
Refuse requests for harmful, hateful or sexual content involving minors, and never ask for passwords, codes or card details.
APP GUIDE:${APP_GUIDE}`;

const MAX_TURNS = 12;
const MAX_CHARS = 2000;
const hits = new Map(); // key -> [timestamps]

function provider() {
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.GROQ_API_KEY) return 'groq';
  return null;
}

function rateLimited(key) {
  const now = Date.now(), win = 60 * 60 * 1000;
  const limit = Number(process.env.ARIA_HOURLY_LIMIT || 30);
  const arr = (hits.get(key) || []).filter((t) => now - t < win);
  if (arr.length >= limit) { hits.set(key, arr); return true; }
  arr.push(now); hits.set(key, arr);
  if (hits.size > 5000) hits.clear();
  return false;
}

function cleanMessages(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(-MAX_TURNS).map((m) => ({
    role: m && m.role === 'assistant' ? 'assistant' : 'user',
    content: String((m && m.content) || '').slice(0, MAX_CHARS),
  })).filter((m) => m.content.trim());
}

async function callGemini(messages, system) {
  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const r = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30000),
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      generationConfig: { maxOutputTokens: 700, temperature: 0.6 },
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Gemini ' + r.status + ': ' + ((d.error && d.error.message) || 'error'));
  const parts = d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts;
  const text = (parts || []).map((p) => p.text || '').join('').trim();
  if (!text) throw new Error('Gemini returned no text');
  return text;
}

async function callGroq(messages, system) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST', signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.GROQ_API_KEY },
    body: JSON.stringify({
      model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
      max_tokens: 700, temperature: 0.6,
      messages: [{ role: 'system', content: system }, ...messages],
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Groq ' + r.status + ': ' + ((d.error && d.error.message) || 'error'));
  const text = d.choices && d.choices[0] && d.choices[0].message && String(d.choices[0].message.content || '').trim();
  if (!text) throw new Error('Groq returned no text');
  return text;
}

function mount(app, { userFromRequest }) {
  app.post('/api/aria/chat', async (req, res) => {
    const p = provider();
    if (!p) return res.status(503).json({ status: false, code: 'ARIA_NOT_CONFIGURED', message: 'AI key not set on the server.' });
    const user = userFromRequest ? await userFromRequest(req).catch(() => null) : null;
    const key = user ? 'u:' + user.uid : 'ip:' + req.ip;
    if (rateLimited(key)) return res.status(429).json({ status: false, code: 'ARIA_LIMIT', message: 'You have asked a lot this hour. Please try again a bit later.' });
    const messages = cleanMessages(req.body && req.body.messages);
    if (!messages.length || messages[messages.length - 1].role !== 'user') {
      return res.status(400).json({ status: false, code: 'BAD_REQUEST', message: 'No question received.' });
    }
    let system = SYSTEM;
    const hint = String((req.body && req.body.appHint) || '').slice(0, 1500);
    if (hint) system += '\nExtra app info that may be relevant:\n' + hint;
    try {
      const reply = p === 'gemini' ? await callGemini(messages, system) : await callGroq(messages, system);
      res.json({ status: true, reply, provider: p });
    } catch (e) {
      console.error('[aria]', e.message);
      res.status(502).json({ status: false, code: 'ARIA_UPSTREAM', message: 'The AI is busy right now.' });
    }
  });
}

module.exports = { mount, provider, _test: { cleanMessages, rateLimited, SYSTEM } };
