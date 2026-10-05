# Mindvora — Round 6 (verified fixes, this pass)

## Calls
- frontend/calls.js: `var why` inside the socket handler was hoisted and shadowed the `why(e)` helper, so every
  offer / answer / set-answer failure threw a TypeError instead of hanging up. Result: half-open calls stuck on
  "Connecting…" and the user left marked busy on the server (next call rejected as "busy"). Renamed.

## Go Live (security)
- backend/CRLF/ws-server.evi: LIVE_START / JOIN_ROOM trusted the uid sent by the client, and SIGNAL trusted a
  client-sent fromUid — anyone could broadcast as another user or inject signalling. Now uses the socket's verified
  Firebase uid (AUTH). LIVE_ALLOW_UNAUTHED=true restores old behaviour for local testing only.

## Stories
- script.js: "＋" was bound to the original postStory before story-music.js loaded → music never attached on normal
  stories. Now resolved at click time. Plain stories lacked `uid`, which firestore.rules require → creates rejected.
- story-music.js rewritten: composer with text + photo (Cloudinary, type/size validated) + music; durationMs from
  content (5–15 s); music trimmed to that duration, looped if shorter, fades out, stops on close/next/tab hide;
  tap left/right to navigate; mute button. Removed 3 hotlinked third-party tracks.
- firestore.rules: viewers may only add themselves to seenBy; expiresAt capped at 48 h.
- backend/lib/story-cleanup.js: deletes expired stories every 30 min (+ photos if CLOUDINARY_API_KEY/SECRET set).

## Deploy
- Frontend (Vercel): redeploy; publish firestore.rules (`firebase deploy --only firestore:rules`).
- Backend (Render): redeploy. Optional env: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET.

## Round 7 — Live Football + Anime Movies
- backend/lib/sports-anime.js (mounted in server.js):
  - GET /api/football/matches?date=YYYY-MM-DD, GET /api/football/match/:id — football-data.org v4, key from
    FOOTBALL_DATA_API_KEY only. Shared cache (45 s today / 10 min other days) + 8 req/min token bucket + in-flight
    de-dup; serves last good data (stale:true) instead of failing when limited. Goals/bookings are passed through
    only if the plan returns them (free tier: scores + status only).
  - GET /api/anime/movies?sort=trending|popular|top|new&q=, GET /api/anime/:id — AniList GraphQL, Jikan fallback.
    Only STREAMING links on an allow-list of official services (Crunchyroll, Netflix, HIDIVE, Prime Video, Max…).
- frontend/live-hub.js + two slide-out menu entries: "Stream Live Football Matches" (Yesterday/Today/Tomorrow,
  auto-refresh every 60 s while open, official broadcaster links) and "Stream Live Anime Movies" (search, sort,
  detail with "Watch on <service>" links). All text is HTML-escaped; only https links are rendered.
- Render env: FOOTBALL_DATA_API_KEY (required for football).
