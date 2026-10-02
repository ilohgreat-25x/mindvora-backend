# Backend bug fixes

## Round 5
1. Live news: GET /api/news?cat=world|nigeria|africa|business|tech|sport (lib/live-content.js). The server reads RSS from BBC, Al Jazeera, The Guardian, Punch, Premium Times and Channels TV. No key needed. Cached for 10 minutes; if every source is down, the last good copy is served. Tested live: 40 stories per category, with images.
2. Live trivia: GET /api/trivia?amount&category. Open Trivia DB (session token, obeys its 1-request-per-5-seconds limit, text decoded, answers shuffled), with The Trivia API as backup. Each question is served once. Tested live.

## Round 4
1. ARIA AI Assistant was keyword-only (canned answers, could not answer anything outside the app). New POST /api/aria/chat (lib/aria.js) answers app questions from a built-in Mindvora guide AND general questions via Google Gemini (GEMINI_API_KEY, free tier) or Groq (GROQ_API_KEY). Key stays in Render. 30 questions/hour per user (ARIA_HOURLY_LIMIT). /api/health shows ariaAI.

## Round 3
1. Voice & video call signalling (lib/calls.js) on /ws: AUTH with Firebase ID token, invite/ring/accept/decline/busy/hang-up, 40s ring timeout, missed-call notification, pending invite delivered when the callee opens the app, 15s reconnect grace, 6 calls/min limit.
2. WebSocket tuned for latency: perMessageDeflate off, TCP no-delay, 256 KB max message.
3. GET /api/rtc/ice-servers — STUN + TURN (Metered, Cloudflare or your own) so calls connect on mobile data.
4. Push notifications (lib/push.js): every new `notifications` document is pushed to the user's phones/browsers via FCM, even when the app is closed; calls ring as high-priority push; dead tokens removed. POST /api/admin/test-push.
5. Firebase key can now be a Render Secret File or raw JSON (no base64 needed).
6. Test-mode Paystack payments no longer send real airtime/data (override: HUSMO_ALLOW_IN_TEST=true).
7. POST /api/admin/husmo-test — dry-run or real Husmodata test.
8. GET /api/public-config (Paystack public key from PAYSTACK_PUBLIC_KEY, VAPID key) and GET /api/app/version (forced-update check, config/app-version.json).
9. /api/health also reports paystackMode, TURN relay, call stats, creatorShare.
New env (optional): PAYSTACK_PUBLIC_KEY, METERED_DOMAIN, METERED_API_KEY (or CF_TURN_KEY_ID/CF_TURN_API_TOKEN or TURN_URLS/TURN_USERNAME/TURN_CREDENTIAL), FCM_VAPID_KEY, APP_<PLATFORM>_MIN_SUPPORTED/LATEST/STORE_URL, HUSMO_ALLOW_IN_TEST.

## Round 2
### Email verification code (OTP)
1. ROOT CAUSE: Render FREE services block outbound SMTP (ports 25/465/587) since 26 Sept 2025, so Nodemailer just timed out. New lib/mailer.js sends over HTTPS via Brevo (BREVO_API_KEY) or Resend (RESEND_API_KEY); SMTP stays as a last fallback, now with 10–30s timeouts.
2. Codes were kept only in memory and were lost every time Render slept/restarted ("No code was sent to this email"). Now stored hashed in Firestore (email_otps) when Firebase Admin is set.
3. A failed send still used up the 60s cooldown and the hourly quota, so 3 failures locked the email out for 1 hour. The counters are now rolled back when sending fails.
4. Codes are single-use; clear error codes returned (COOLDOWN, EMAIL_NOT_CONFIGURED, CAPTCHA_NO_TOKEN…).
5. verify-email now marks the account emailVerified server-side when the user is logged in.

### reCAPTCHA
6. Every failure now logs the exact Google reason + a plain-English hint (wrong secret, token from a different key, expired, low score, wrong action).
7. A MISSING token (browser/domain problem) no longer counts as an attack strike, so real users don't lock out their whole network.
8. Client IP on Render uses the first X-Forwarded-For entry (Render's convention); before, everyone could share one edge IP and one bad user could lock out all.

### Payments (server-side now)
9. Premium, Verified badge, tips, gifts, airtime and data are granted by the SERVER only after it confirms the payment: POST /api/pay/paystack/verify, Paystack webhook /api/paystack/webhook, NOWPayments IPN /api/crypto/webhook. Prices come from lib/catalog.js; each payment is applied exactly once (processed_payments).
10. Tips and gifts now credit the recipient (90%, CREATOR_SHARE) with Firebase Admin; gifts are recorded and posted to live chat by the server.
11. Crypto: 'partially_paid' no longer unlocks features; invoice price is set by the server; orders are stored in Firestore (crypto_orders), not memory.
12. /api/husmo-airtime and /api/husmo-data were PUBLIC — anyone could spend your Husmodata wallet. Now admin-only; normal delivery happens only after payment.
13. /api/paystack/initialize now requires login and sets the amount server-side.

### Husmodata
14. Network ids were wrong. Correct: MTN=1, GLO=2, 9MOBILE=3, AIRTEL=4 (from Husmodata's own client library). Airtime sent "MTN" as text; it now sends the number.
15. Data sent "1GB" as `plan`; Husmodata needs a PLAN ID. Resolved from HUSMO_PLAN_MAP / config/husmo-plans.json, or looked up automatically from your account. GET /api/admin/husmo-plans shows the mapping.
16. Base URL is now https://www.husmodata.com/api; phones are normalised to 11-digit 0xxxxxxxxxx.

### Other
17. CORS also allows www.mindvora.app, any mindvora*/zync-social* .vercel.app URL, and EXTRA_ORIGINS.
18. Self keep-alive ping now works on Render (RENDER_EXTERNAL_URL).
19. GET /api/health shows what is configured (true/false only). POST /api/admin/test-email sends a test email.

## Round 1
1. CRLF/defense.evi: global regexes with .test() alternated true/false — split into test/replace patterns.
2. Spoofable IP headers bypassed rate limits (refined in round 2, #8).
3. Body CRLF/SQLi checks ran before JSON parsing — now after (bodyGuard).
4. CORS rejections returned 500; admin DELETE + X-Admin-Secret header allowed.
5. Public default ADMIN_SECRET removed; admin routes are off until it is set.
6. Crypto status polled an invoice id as a payment id — now driven by the signed IPN.
7. Referral notification used `uid` instead of `toUid`.

## Environment variables (Render → Environment)
Required: FIREBASE_SERVICE_ACCOUNT_B64, ADMIN_SECRET, RECAPTCHA_SECRET_KEY, BREVO_API_KEY, EMAIL_FROM,
PAYSTACK_SECRET_KEY, NOWPAYMENTS_API_KEY, NOWPAYMENTS_IPN_SECRET, HUSMODATA_API_KEY
Optional: HUSMO_PLAN_MAP, EMAIL_FROM_NAME, RESEND_API_KEY, NGN_PER_USD (default 1600 — must match script.js),
CREATOR_SHARE (0.9), RECAPTCHA_MIN_SCORE (0.5), RECAPTCHA_ENFORCE, EXTRA_ORIGINS, IPN_URL, APP_URL

## Round 6 — calls & push
1. Calls hung up with "answer failed": CRLF/ws-server.evi ran sanitizeDeep on every WebSocket message, which stripped the line breaks out of the WebRTC offer/answer (SDP). The other phone could not read it. CALL_SIGNAL data is now relayed untouched.
2. Call notifications never arrived: the call push carried a data key named `from`, which FCM reserves, so Google rejected it. Renamed to `fromUid`; reserved keys are now filtered out.
3. lib/push.js treated `messaging/invalid-argument` as a dead token and deleted it, so after the first failed call push the user had no tokens and got NO notifications at all. Removed; push failures are now logged.
