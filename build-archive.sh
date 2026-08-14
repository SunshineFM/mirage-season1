#!/bin/bash
# Build the static Mirage Season 1 archive into .deploy/ for Cloudflare Pages.
#
#   ./build-archive.sh
#   npx wrangler pages deploy .deploy --project-name=mirage-season1 --commit-dirty=true
#
# Mirage originally ran on Express (server.js), which served several paths from a
# single file. Pages is static, so those aliases are reproduced here as real files.
# season1.html declares <link rel="canonical"> pointing at /case-study, so that path
# MUST exist or the deployed archive advertises a canonical URL that 404s. The
# slide-18 QR code in presentation.html encodes the same URL.
#
# Express route            -> static file staged here
#   /                      -> index.html            (archive at root)
#   /season1.html          -> season1.html
#   /case-study            -> case-study.html       (CANONICAL — see above)
#   /mirage                -> mirage.html           (brand-path alias)
#   /archive/internal      -> archive/internal.html
#   /archive/behind-the-scenes -> archive/behind-the-scenes.html
#
# Deliberately NOT staged: app.html, admin.html (the live app and its dashboard).
#
# All third-party runtime dependencies were vendored into public/vendor/ on
# 2026-08-14 (Reveal.js 5.1.0, qrcodejs 1.0.0, Google Fonts, the hero MP3).
# The archive makes zero external requests; keep it that way.
set -euo pipefail
cd "$(dirname "$0")"
STAGE=.deploy

rm -rf "$STAGE" && mkdir -p "$STAGE/archive"

# season1.html is the archive; Express served it at four different paths.
cp public/season1.html          "$STAGE/season1.html"
cp public/season1.html          "$STAGE/index.html"
cp public/season1.html          "$STAGE/case-study.html"
cp public/season1.html          "$STAGE/mirage.html"

cp public/presentation.html     "$STAGE/"
cp public/farewell.html         "$STAGE/"

# internal.html carries its own noindex,nofollow; Express served it at two paths.
cp public/archive/internal.html "$STAGE/archive/internal.html"
cp public/archive/internal.html "$STAGE/archive/behind-the-scenes.html"

cp -R public/archive/screenshots "$STAGE/archive/"
cp -R public/vendor              "$STAGE/vendor"
cp public/favicon.svg public/icon-192.svg public/icon-512.svg public/apple-touch-icon.svg "$STAGE/" 2>/dev/null || true
printf 'User-agent: *\nAllow: /\n' > "$STAGE/robots.txt"

# Guard: the live app and admin dashboard must never reach the public archive.
leaked=$(find "$STAGE" \( -name "app.html" -o -name "admin*.html" -o -name "eat.html" \
                        -o -name "series.html" -o -name "sponsors.html" \) -print)
[ -z "$leaked" ] || { echo "FATAL: app/admin leaked into staging:"; echo "$leaked"; exit 1; }

# Guard: the archive must stay sealed — no third-party runtime fetches.
# Matches scheme-qualified URLs only, so the explanatory comments that NAME these
# hosts ("it hotlinked kesq.b-cdn.net") don't trip the guard they document.
unsealed=$(grep -rlE "https?://(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|connect\.facebook\.net|www\.facebook\.com/tr|[a-z0-9.-]*r2\.dev|kesq\.b-cdn\.net)" \
             "$STAGE" --include="*.html" || true)
[ -z "$unsealed" ] || { echo "FATAL: third-party runtime dependency reintroduced in:"; echo "$unsealed"; exit 1; }

# Guard: no visitor tracking. The archive collects nothing — no beacons to the dead
# Express API, no persistent device id, no third-party pixel. Grep for the CALL, not
# the word, so the comments recording each removal stay legible.
tracking=$(grep -rlE "fetch\('/api/analytics|fbq\(|localStorage\.setItem\('mirage_session" \
             "$STAGE" --include="*.html" || true)
[ -z "$tracking" ] || { echo "FATAL: visitor tracking reintroduced in:"; echo "$tracking"; exit 1; }

echo "staged $(find "$STAGE" -type f | wc -l | tr -d ' ') files, $(du -sh "$STAGE" | cut -f1) — sealed, no app/admin"
