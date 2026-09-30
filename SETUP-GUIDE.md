---
type: markdown
title: Mindvora — step-by-step setup guide
---

# Mindvora setup guide

Almost every step below happens on one page: **Render → your backend service → Environment**. To get there, go to dashboard.render.com, click your backend service (its web address is `zync-backend-ickl.onrender.com`), then click **Environment** in the left menu. To add a setting, click **+ Add Environment Variable** and type a **Key** (the name) and a **Value**. When you've finished, click **Save Changes** (or **Save, rebuild, and deploy**). Render restarts the server, which takes about 2 minutes.

> **Never paste secret keys into a chat, into GitHub, or into the website code.** They belong only in Render.

---

## 1–2. reCAPTCHA while you're still testing (no custom domain yet)

You don't need a domain you own. reCAPTCHA only needs the exact web addresses your site runs on.

1. Go to **google.com/recaptcha/admin** and sign in with the Google account that created the key.
2. Open the site whose key starts with **6LdAlK8t…**, then click the **gear icon (Settings)**.
3. Under **Domains**, add each of these on its own line (no `https://` and no `/`):
   - `mindvora-own8.vercel.app`
   - `mindvora-vf8e.vercel.app`
   - `zync-social-vf8e.vercel.app`
   - `localhost` (only if you test on your own computer)
   - Any other address you use. To check, open **vercel.com → your project → Settings → Domains**.
4. Click **Save**. The change can take up to 30 minutes to work.
5. On the same Settings page, open **reCAPTCHA keys** and click **Copy secret key**.
6. In Render, add the Key `RECAPTCHA_SECRET_KEY` and paste that secret key as the Value.

**When you launch:** go back to the same Domains box, add `yourdomain.com` and `www.yourdomain.com`, and click Save. You keep the same key, so there's nothing to change in the code.

**Common mistake:** Vercel "preview" links (long ones like `mindvora-git-main-xyz.vercel.app`) are different addresses. Either add them too, or always test on the main address.

---

## 3. Brevo (sends the verification-code emails)

**A. Verify your sender email**
1. Log in to **app.brevo.com**.
2. Click your name (top right) → **Senders, Domains & Dedicated IPs** → **Senders** → **Add a sender**.
3. From Name: `Mindvora`. From Email: the email you want codes to come from. Click **Save**.
4. Brevo emails a code to that address. Enter it, and the sender shows **Verified**.

**B. Create an API key**
1. Click your name (top right) → **SMTP & API** → **API Keys** tab → **Generate a new API key**.
2. Name it `Render` and click **Generate**. Copy the key (it starts with `xkeysib-`). Brevo only shows it once.

**C. Put both into Render** (Environment page)

| Key | Value |
|---|---|
| `BREVO_API_KEY` | the `xkeysib-…` key |
| `EMAIL_FROM` | the exact email you verified in step A |
| `EMAIL_FROM_NAME` | `Mindvora` |

Click **Save Changes**, wait 2 minutes, then sign up with a test email.

Tip: emails sent "from" a Gmail address through Brevo sometimes land in **Spam**. Once you have your own domain, verify it in Brevo (Senders, Domains → Domains) and send from `no-reply@yourdomain.com`.

---

## 4. Firebase service account key

**What it's for.** It's the server's master key to your Firebase. Your security rules stop users from giving themselves premium or money. With this key, the **server** can do those things safely after a real payment. It also lets the server save verification codes so they survive restarts, and send push notifications. Without it, payments, saved codes and push notifications all stop working.

**Easiest way (no encoding needed): a Render "Secret File".** I updated the server so it can read the key this way.
1. Find the `.json` file you downloaded from Firebase and open it with Notepad (Windows) or TextEdit (Mac).
2. Select all the text and copy it.
3. In Render, open your service → **Environment** → scroll to **Secret Files** → **+ Add Secret File**.
4. Filename: `firebase-service-account.json`. Contents: paste the text. Click **Save Changes**.

**Other way (base64), only if you prefer it:**
- **Windows:** open **PowerShell** and run the line below (change the path to where your file is). It copies the result to your clipboard.
  `[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\Users\YOU\Downloads\key.json")) | Set-Clipboard`
- **Mac:** open **Terminal** and run `base64 -i ~/Downloads/key.json | pbcopy`
- Then in Render, add the Key `FIREBASE_SERVICE_ACCOUNT_B64` and paste the result as the Value.
- Don't use online "base64 converter" websites. They would see your master key.

**If the key ever leaks** (for example, you pasted it somewhere public): go to Google Cloud Console → IAM & Admin → Service Accounts → your account → **Keys** → delete it, then generate a new one in Firebase.

---

## 5. Paystack says "Your business is in test mode"

**What it means:** Paystack hasn't approved your business for real money yet. Uploading documents isn't enough; every section must be filled in and submitted.

1. In the Paystack dashboard, click the **Activate business / Compliance** prompt.
2. Each section shows a tick or a warning: **Business profile, Contact, Owner/Director details (BVN + ID), Settlement bank account, Service agreement**. Complete every section that doesn't have a tick.
3. Click **Submit / Request activation** at the end. Review usually takes a few business days. Paystack emails you if they need anything else. You can also ask support@paystack.com what's still missing.

**Meanwhile, test everything with test keys.** Go to Paystack → **Settings → API Keys & Webhooks** (keep the switch on **Test**):

| Render Key | Value |
|---|---|
| `PAYSTACK_SECRET_KEY` | **Test Secret Key** (`sk_test_…`) |
| `PAYSTACK_PUBLIC_KEY` | **Test Public Key** (`pk_test_…`). The app now picks it up automatically. |

Then fill **Test Webhook URL** with `https://zync-backend-ickl.onrender.com/api/paystack/webhook` and click **Save**.

To pay in the app while testing, use Paystack's test card: `4084 0840 8408 4081`, CVV `408`, any future expiry date, PIN `0000`, OTP `123456`.

In test mode, premium, badges, tips and gifts all work for real inside the app. **Airtime and data are NOT actually sent**, so fake payments can't spend your Husmodata wallet.

**Once you're approved:** switch Paystack to **Live**, then in Render replace the two keys with `sk_live_…` and `pk_live_…`. Also fill the **Live Webhook URL** with the same address as above.

---

## 6–7. Checking the server (no terminal needed)

**Health check (7).** Open this link in your browser: **https://zync-backend-ickl.onrender.com/api/health**. If it's slow the first time, wait about 60 seconds (the free server wakes up) and refresh.
- You want to see `"firebaseAdmin": true`, `"recaptchaSecret": true`, `"emailProvider": "brevo"`, `"emailFromSet": true`, `"paystackMode": "test"` (later `"live"`), `"adminSecret": true` and `"nowpaymentsIpnSecret": true`.
- Anything showing `false` means that setting is still missing in Render.

**Husmodata plan check (6).** For this you use **Hoppscotch**, a free website for sending requests to your server.
1. First make sure Render has `HUSMODATA_API_KEY` and `ADMIN_SECRET` set. `ADMIN_SECRET` is any long password you invent.
2. Go to **hoppscotch.io**.
3. Leave the method as **GET** and paste `https://zync-backend-ickl.onrender.com/api/admin/husmo-plans` as the URL.
4. Open the **Headers** tab and add one header: Key `X-Admin-Secret`, Value = your `ADMIN_SECRET`.
5. Click **Send**.
6. The answer has a `mapping` section, for example `"mtn": { "500MB": "36", "1GB": null, ... }`. A number means that bundle is ready. `null` means the server couldn't find its plan ID.

**Filling in any `null`:** open your Husmodata dashboard's data pricing or API documentation page, where each plan has an ID number. In Render, add the Key `HUSMO_PLAN_MAP` with a one-line Value like this (these are the Mindvora bundle names: 500MB, 1GB, 2GB, 5GB, 10GB, 20GB, 50GB, Unlimited):

`{"mtn":{"1GB":"37","2GB":"38"},"airtel":{"1GB":"45"}}`

You only need to list the missing ones. Save, then press **Send** in Hoppscotch again to confirm they're filled.

---

## 8. Creator share for tips and gifts (`CREATOR_SHARE`)

**Where to set it:** in Render, add the Key `CREATOR_SHARE` with the Value `1` (creator gets 100%) or `0.9` (creator gets 90%). If you don't add it, it stays at 90%.

**What 90% means:** a fan tips $5, the creator's earnings go up by $4.50, and $0.50 stays with Mindvora.

**What 100% means:** the creator gets the full $5, but Paystack still charges you a fee on every payment. For local cards that's about 1.5% plus ₦100 (the ₦100 is waived under ₦2,500). With 100%, you pay that fee out of your own pocket on every tip, plus any refunds or fraud.

**My recommendation: 90%.** It covers payment fees and chargebacks, and helps pay for servers, TURN relays for calls, and email. It's still generous to creators. Choose 100% only if you want it as a short launch promotion. You can change it anytime in Render, and the change only affects new tips.

---

## 9. Testing Husmodata live (real top-ups)

I added an admin test tool to the server. Use Hoppscotch as in step 6, but set the method to **POST** and the URL to `https://zync-backend-ickl.onrender.com/api/admin/husmo-test`. Keep the `X-Admin-Secret` header. Put the JSON in the **Body** tab and set the content type to `application/json`.

1. **Dry run (free, nothing is bought):**
   `{"network":"mtn","phone":"080XXXXXXXX","bundle":"500MB"}`
   The reply shows the exact plan ID and network ID it would send.
2. **Real ₦50 airtime to your own number:**
   `{"network":"mtn","phone":"080XXXXXXXX","airtimeNGN":50,"send":true}`
   Check your phone and the Husmodata transaction history.
3. **Real smallest data bundle:**
   `{"network":"mtn","phone":"080XXXXXXXX","bundle":"500MB","send":true}`
4. **Full app test:** once Paystack is live, buy ₦50 airtime inside the app with your own card. Before then, you can add `HUSMO_ALLOW_IN_TEST=true` in Render to let test-card payments deliver real top-ups. That costs real Husmodata money, so remove it right after testing.

---

## New settings for calls and notifications

| Render Key | What it's for | Where to get it |
|---|---|---|
| `METERED_DOMAIN` and `METERED_API_KEY` | TURN relay, so calls connect on MTN/Airtel mobile data | Sign up at **metered.ca** → TURN Server → copy your app domain (e.g. `mindvora.metered.live`) and API key |
| `FCM_VAPID_KEY` | Browser push notifications (optional; the app already has one built in) | Firebase → Project settings → **Cloud Messaging** → Web Push certificates → **Generate key pair** → copy it |

**Test a push notification:** in Hoppscotch, send **POST** to `https://zync-backend-ickl.onrender.com/api/admin/test-push`, with the `X-Admin-Secret` header and the body `{"uid":"YOUR_USER_ID"}`. You can find your user ID in Firebase → Authentication.

**iPhone users:** web push only works on iOS 16.4 or newer, and only after they tap Share → **Add to Home Screen**, open Mindvora from that icon, and tap **Turn on** on the notification banner. The App Store version (see the mobile project) doesn't have this limit.

---

## Firestore rules (still needed once)

On your computer, in the frontend folder, run `firebase deploy --only firestore:rules`.

Or, with no computer tools: Firebase Console → Firestore Database → **Rules** tab → paste the contents of `firestore.rules` → **Publish**.
