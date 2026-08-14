# Mirage / SunshineFM — Coachella Valley AI Social

## What this app does
Mirage was a 30-day AI-powered social media experiment for Coachella Valley festival season (Apr 1–May 1, 2026). It ran, built an audience, then intentionally shut down. The app now serves a farewell page at `/`, the Season 1 archive at `/season1.html`, and a 18-slide conference presentation deck at `/presentation.html`.

## Stack
Node.js + Express + Neon PostgreSQL, served on Render. Static assets in `/public`.

## Directory map
- `server.js` — Express entry point, all routes, middleware, API handlers (~2,600 lines, legacy god file)
- `public/` — Static HTML pages: `index.html` (farewell), `season1.html` (archive), `presentation.html` (18-slide deck), `app.html`, `admin.html`
- `migrations/` — node-pg-migrate SQL migration files (custom runner in `migrate.js`)
- `scripts/` — One-off utility scripts
- `debug/` — Debug snapshots and session data
- `shell-snapshots/` — Agent shell history snapshots

## Database
- `posts` — Feed posts captured during Season 1 (text, source, feed type)
- `reactions` — User emoji reactions on posts
- `sessions` — Express session store
- `flags` — Feature flags (key/value)
- `analytics_events` — Page view and interaction tracking
- `notes` — Admin content notes
- `moderation` — Moderation records
- `utm_tracking` — UTM attribution data

## External integrations
- Neon PostgreSQL — `DATABASE_URL` env var
- Render — hosting, ephemeral filesystem, `/health` endpoint
- ~~Google Fonts~~ — Righteous, Bebas Neue, DM Sans, **vendored 2026-08-14** to `public/vendor/fonts/` (12 woff2 + per-page CSS). No longer fetched at runtime.
- ~~cdnjs / jsDelivr~~ — Reveal.js 5.1.0, qrcodejs 1.0.0, **vendored 2026-08-14** to `public/vendor/`. No longer fetched at runtime.
- qrserver.com — not used (switched to qrcodejs for self-contained QR)

- ~~R2 public bucket~~ — `Coachella Bound.mp3` (hero player on the archive page), **vendored 2026-08-14** to `public/vendor/audio/coachella-bound.mp3`. No longer fetched at runtime.

As of 2026-08-14 the archive has **zero third-party runtime dependencies and collects
nothing**. Three separate trackers were removed that day, each found a different way:

- Meta Pixel on `farewell.html` (`fbq` init + PageView) — found by grepping for tracker hosts.
- A same-origin beacon on `season1.html` and `farewell.html` that minted a persistent
  `mirage_session` UUID into localStorage and POSTed it with UTM params to
  `/api/analytics/pageview`. That Express route is gone, so it 405'd on every load. It was
  invisible to host greps (same-origin) and only surfaced as a failed request in a browser.
- The KESQ press thumbnail, hotlinked from `kesq.b-cdn.net`, replaced by the text citation
  that was already in the callout.

`build-archive.sh` guards both properties on every build. The only remaining external
requests are the YouTube embeds on the archive page and ordinary outbound links.

## Recent changes
- 2026-07-29: Shipped /series — Coachella Valley Vertical Video Series sponsor-pitch landing with /api/series/lead intake (series_leads table) wired to Polsia email proxy
- 2026-05-08: Added QR code (qrcodejs, links to /season1.html) to slide 18 of /presentation.html; confirmed 18/18 speaker notes, 18/18 sections, 9 YouTube links intact
- 2026-04-30: R15.4 — Slides 11–18 added (The Meaning arc), readability pass (40px+ big numbers, 24px+ tiles)
- 2026-04-30: Season 1 archive deployed at /season1.html
- 2026-05-01: Shutdown — farewell page served at /, post-shutdown archive state active
- 2026-05-04: Background cron jobs disabled post-shutdown (~95% overhead reduction)
