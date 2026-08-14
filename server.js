const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const cron = require('node-cron');
const nodeFetch = require('node-fetch'); // v2.x — required for form-data stream compatibility
const FormData = require('form-data');
// gzip compression handled by Render's reverse proxy at infra level

const app = express();

// Blaxel: in-process schedulers don't fire reliably under scale-to-zero and are
// gated by POLSIA_IN_PROCESS_CRONS_ENABLED (set to "false" on Blaxel web).
// Move scheduled work to polsia.toml [[crons]]. This disables in-process timers
// and cron libraries when the gate is off; on Render (gate unset) they run as before.
if (process.env.POLSIA_IN_PROCESS_CRONS_ENABLED === 'false') {
  const __si = global.setInterval;
  global.setInterval = function (fn, ms, ...r) {
    return typeof ms === 'number' && ms >= 10000 ? __si(() => {}, 2147483647) : __si(fn, ms, ...r);
  };
  try {
    const __M = require('module');
    const __req = __M.prototype.require;
    __M.prototype.require = function (id) {
      if (id === 'node-cron') return { schedule: () => ({ start() {}, stop() {} }) };
      if (id === 'node-schedule') return { scheduleJob: () => ({ cancel() {} }), gracefulShutdown: () => Promise.resolve() };
      if (id === 'agenda') return function () { return { define() {}, every() {}, schedule() {}, start() { return Promise.resolve(); }, stop() { return Promise.resolve(); }, on() {} }; };
      if (id === 'bree') return function () { return { start() {}, stop() {}, add() {}, run() {} }; };
      return __req.apply(this, arguments);
    };
  } catch {}
}
const port = process.env.PORT || 3000;

// Trust Render's reverse proxy so req.ip reflects the real client IP
app.set('trust proxy', 1);

// ---- Database ----
if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is required');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
  // Neon Starter supports ~20 connections; cap at 5 to leave headroom for multiple deploys/workers
  max: 5,
  // Release idle connections after 20s — prevents Neon "too many connection attempts"
  idleTimeoutMillis: 20000,
  // Fail fast if we can't get a connection — don't pile up waiting requests
  connectionTimeoutMillis: 15000,
  // Allow the pool to fully drain when idle (helpful for Neon compute suspend)
  allowExitOnIdle: false
});

// Pool error handler — prevent unhandled error crash
pool.on('error', (err) => {
  console.error('[DB Pool] Unexpected client error:', err.message);
});

// Log pool stats periodically (every 5 min) so we can monitor in Render logs
setInterval(() => {
  console.log(`[DB Pool] total=${pool.totalCount} idle=${pool.idleCount} waiting=${pool.waitingCount}`);
}, 5 * 60 * 1000);

// Keep-alive ping every 4 minutes — prevents Neon compute from cold-suspending
// (Neon Starter suspends after ~5 min inactivity; cold start causes burst reconnects = pool exhaustion)
setInterval(async () => {
  try {
    await pool.query('SELECT 1');
  } catch (e) {
    console.warn('[DB Pool] Keep-alive ping failed:', e.message);
  }
}, 4 * 60 * 1000);

// ---- Analytics Baseline (excludes pre-launch test data) ----
// All dashboard/export queries filter posts >= this date so pre-launch
// test data never leaks into live analytics.
const ANALYTICS_START_DATE = '2026-04-01';

// ---- Middleware ----
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Service worker and manifest must never be cached by the browser so updates propagate immediately
app.get('/sw.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Content-Type', 'application/javascript');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});
app.get('/manifest.json', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Content-Type', 'application/manifest+json');
  res.sendFile(path.join(__dirname, 'public', 'manifest.json'));
});

// Clean URL for internal appendix — /archive/internal → /archive/internal.html
app.get('/archive/internal', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'archive', 'internal.html'));
});

// Behind the Scenes — renamed from "Internal Appendix" (task #1250807)
app.get('/archive/behind-the-scenes', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'archive', 'internal.html'));
});

// Static assets: 7-day cache for versioned files (JS/CSS hashed by Vite), 1-hour for images/fonts
// sw.js and manifest.json are explicitly served above with no-cache — this fallthrough won't catch them
app.use(express.static(path.join(__dirname, 'public'), {
  index: false, // Prevent static middleware from serving index.html for / — route handler owns root route
  maxAge: '7d',
  setHeaders: (res, filePath) => {
    // HTML files: never cache — always serve fresh so deploys propagate instantly
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
    // Images and fonts: 1-day cache (may change between deployments)
    else if (/\.(png|jpg|jpeg|gif|webp|svg|ico|woff|woff2|ttf|otf)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=3600');
    }
    // JS, CSS: 7-day cache — filenames should be versioned if content changes
    else if (/\.(js|css)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=604800, stale-while-revalidate=86400');
    }
  }
}));

// Multer for photo uploads (memory storage, max 1MB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/webp', 'image/jpeg', 'image/png'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only WebP, JPEG, PNG images allowed'));
    }
  }
});

// ---- Geo-fencing ----
const EMPIRE_POLO = { lat: 33.6815, lng: -116.2372 };
const VALLEY_CENTER = { lat: 33.7225, lng: -116.3747 };
const GROUNDS_RADIUS_KM = 1.5;
const VALLEY_RADIUS_KM = 40; // expanded from 30 — covers full valley incl. Mecca/Thermal

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getGeoTier(lat, lng) {
  if (lat == null || lng == null) return 'outside';
  const distToGrounds = haversineDistance(lat, lng, EMPIRE_POLO.lat, EMPIRE_POLO.lng);
  if (distToGrounds <= GROUNDS_RADIUS_KM) return 'grounds';
  const distToValley = haversineDistance(lat, lng, VALLEY_CENTER.lat, VALLEY_CENTER.lng);
  if (distToValley <= VALLEY_RADIUS_KM) return 'valley';
  return 'outside';
}

// ---- Rate Limiting + Anti-Spam ----

// Strict rate limit: 1 post per 5 minutes per session AND per IP
// (replaces old 5/min + 30/hr — task #562417)
const postTimestamps = new Map(); // key = sessionId or ip → last post timestamp
const RATE_WIN_POST = 5 * 60 * 1000; // 5 minutes

// Returns { allowed: true } or { allowed: false, reason: string }
function checkRateLimit(sessionId, ip) {
  const now = Date.now();
  // Check by session
  const sessionLast = postTimestamps.get(`s:${sessionId}`);
  if (sessionLast && now - sessionLast < RATE_WIN_POST) {
    const waitSec = Math.ceil((RATE_WIN_POST - (now - sessionLast)) / 1000);
    return { allowed: false, waitSec };
  }
  // Check by IP (catches session spoofing)
  if (ip && ip !== 'unknown') {
    const ipLast = postTimestamps.get(`i:${ip}`);
    if (ipLast && now - ipLast < RATE_WIN_POST) {
      const waitSec = Math.ceil((RATE_WIN_POST - (now - ipLast)) / 1000);
      return { allowed: false, waitSec };
    }
  }
  // Record timestamps
  postTimestamps.set(`s:${sessionId}`, now);
  if (ip && ip !== 'unknown') postTimestamps.set(`i:${ip}`, now);
  return { allowed: true };
}

// DISABLED: Rate limit cleanup disabled for dormant archive (task #1313577)
// setInterval(() => {
//   const now = Date.now();
//   for (const [key, ts] of postTimestamps.entries()) {
//     if (now - ts > RATE_WIN_POST) postTimestamps.delete(key);
//   }
// }, 10 * 60 * 1000);

// Duplicate content detection: block if same exact text posted 3+ times in 10 min per session
const recentContent = new Map(); // session -> [{ text, ts }]
const DUPE_WIN = 10 * 60 * 1000; // 10 minutes
const DUPE_MAX = 3;               // 3 identical posts = block

function isDuplicateContent(sessionId, text) {
  if (!text || text.trim().length === 0) return false;
  const normalized = text.trim().toLowerCase();
  const now = Date.now();
  if (!recentContent.has(sessionId)) return false;
  const history = recentContent.get(sessionId).filter(e => now - e.ts < DUPE_WIN);
  return history.filter(e => e.text === normalized).length >= DUPE_MAX - 1;
}

function recordPostedContent(sessionId, text) {
  if (!text || text.trim().length === 0) return;
  const normalized = text.trim().toLowerCase();
  const now = Date.now();
  if (!recentContent.has(sessionId)) recentContent.set(sessionId, []);
  const history = recentContent.get(sessionId).filter(e => now - e.ts < DUPE_WIN);
  history.push({ text: normalized, ts: now });
  recentContent.set(sessionId, history);
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entries] of recentContent.entries()) {
    const valid = entries.filter(e => now - e.ts < DUPE_WIN);
    if (valid.length === 0) recentContent.delete(key);
    else recentContent.set(key, valid);
  }
}, 5 * 60 * 1000);

// Reaction rate limit: 60 per 15 min (generous for real users, blocks bots)
const reactionRateLimits = new Map();
const REACTION_RATE_MAX = 60;
const REACTION_RATE_WINDOW = 15 * 60 * 1000;

function checkReactionRateLimit(sessionId) {
  const now = Date.now();
  if (!reactionRateLimits.has(sessionId)) reactionRateLimits.set(sessionId, []);
  const timestamps = reactionRateLimits.get(sessionId).filter(t => now - t < REACTION_RATE_WINDOW);
  if (timestamps.length >= REACTION_RATE_MAX) return false;
  timestamps.push(now);
  reactionRateLimits.set(sessionId, timestamps);
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of reactionRateLimits.entries()) {
    const valid = timestamps.filter(t => now - t < REACTION_RATE_WINDOW);
    if (valid.length === 0) reactionRateLimits.delete(key);
    else reactionRateLimits.set(key, valid);
  }
}, 5 * 60 * 1000);

// ---- Moderation ----
// Hard-block patterns: post is rejected before publishing. No reason given to user.
// Covers: slurs, direct threats, sexual exploitation, doxxing/PII, scam phrases, illegal solicitation.
// Casual profanity allowed; targeted abuse and the categories below are not.
const HARD_BLOCK_PATTERNS = [
  // Hate / Slurs — racial, anti-LGBTQ, religious, disability, dehumanizing
  /\bn[i1][gq]{1,2}[ae3]r/i,
  /\bf[a@][gq]{1,2}[o0]t/i,
  /\bk[i1]ke\b/i,
  /\bsp[i1]c\b/i,
  /\bch[i1]nk\b/i,
  /\btr[a@]nn/i,
  /\bret[a@]rd\b/i,
  /\bw[e3]tb[a@]ck\b/i,
  /\bb[e3]an[e3]r\b/i,
  /\bj[i1][gq][a@]b[o0]\b/i,
  /\bs[a@]nd\s*n[i1][gq]{1,2}[ae3]r/i,
  /\bporch\s*monk[e3]y/i,
  /\bsp[o0]ok\b.{0,10}\b(black|dark|n[i1]g)/i,
  /\bk[i1]k[e3]s?\b/i,
  /\bcr[a@]ck[e3]r\b.{0,20}(black|dark|n[i1]g)/i,

  // Threats / Violence — direct threats to kill, harm, attack, or incite crowd violence
  /\b(i('ll| will| am going to|'m going to| gonna))\s+(kill|murder|stab|shoot|beat|attack|harm|rape|hurt)\s+(you|u|them|him|her|y'all)\b/i,
  /\b(kill|murder|stab|shoot|beat|attack|harm|rape|hurt)\s+(you|u|them|him|her|y'all)\b/i,
  /\bgonna\s+(kill|murder|stab|shoot|beat|attack|harm|rape|hurt)\b/i,
  /\bgoing\s+to\s+(kill|murder|stab|shoot|beat)\b/i,
  /\bdead\s+by\s+tonight\b/i,
  /\bi know where (you|they|he|she) (live|sleep|are|stay)\b/i,
  /\bwatch\s+your\s+back\b/i,
  /\bstamp[e3]d[e3]\b.{0,30}\b(crowd|people|gates|entrance|exit)\b/i,
  /\bsurge\s+(the\s+)?(gates?|fence|barrier|exit|entrance)\b/i,

  // Sexual exploitation
  /\bchild\s*(porn|pornography|sex)\b/i,
  /\b(cp|csam)\s*(link|available|here|for\s*sale|trading)\b/i,
  /\bkiddie\s*(porn|pic|photo|vid)\b/i,
  /\b(underage|minor|child|kid|teen)\s*.{0,20}\s*(nude|naked|sex|porn)\b/i,
  /\bnude[ds]?\s*.{0,20}\s*(minor|child|kid|teen|underage)\b/i,
  /\b(buy|sell|trade)\s*.{0,20}\s*\b(cp|csam)\b/i,

  // Doxxing / Personal info — phone numbers, emails, room numbers tied to a person
  /\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/,         // US phone: 555-867-5309
  /\b\d{10,11}\b(?![\w%])/,                    // 10-11 digit number run (phone)
  /\b[a-zA-Z0-9._%+\-]{2,}@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/, // email address
  /\b(room|suite|cabin|bunk|site|spot)\s*#?\d{2,4}\b.{0,40}(she|he|they|her|him|them)\b/i,
  /\bhere[''`s]*s where (she|he|they|the|a) (is|are|stay|sleep|live)\b/i,
  /\blicense\s*plate\s*[a-z0-9]{3,8}/i,

  // Spam / Scams — fake ticket sales, crypto spam, referral spam
  /\bdm\s+me\s+(for|to\s+get|about)\s+(ticket|pass|wristband|access)/i,
  /\btext\s+me\s+at\b/i,
  /\bcash\s*app\s+me\b/i,
  /\bsending\s+(bitcoin|btc|eth|usdt|usdc|crypto)/i,
  /\b(bitcoin|btc|eth|ethereum|usdt|usdc|solana)\b.{0,50}\b(invest|send|transfer|profit|earn|double|triple)\b/i,
  /\bwhatsapp\b.{0,40}\b(ticket|wristband|pass|access)\b/i,
  /\b(selling|sell)\s+(vip|ga|general\s+admission|ticket|wristband|pass)\b/i,
  /\b(extra|spare|unused)\s+(ticket|wristband|pass)\b.{0,30}\b(cash|venmo|cashapp|zelle|paypal)\b/i,
  /\brefer(ral)?\s+code\b/i,
  /\buse\s+my\s+(code|link|referral)\b/i,

  // Illegal / dangerous solicitation
  /\b(buying|selling|buy|sell)\s+(heroin|fentanyl|meth|methamphetamine|cocaine|molly|mdma|ketamine|ket|dmt|pcp)\b/i,
  /\b(heroin|fentanyl|meth|cocaine|molly|mdma)\s+(for\s+sale|available|dm\s+me|hook\s+up)\b/i,
  /\bimpersonat(ing|e|es?)\s+(security|staff|police|medic|ems|festival\s+staff)\b/i,
  /\bfake\s+(security|badge|credential|wristband|staff\s+pass)\b/i,
  /\bhow\s+to\s+(sneak\s+in|bypass\s+security|get\s+past|evade)\b/i,
];

// Returns true if content matches any hard-block pattern
function isHardBlocked(text) {
  if (!text) return false;
  return HARD_BLOCK_PATTERNS.some(p => p.test(text));
}

// In-memory IP block cache (reloaded from DB on startup + updated on admin action)
const blockedIPs = new Map(); // ip → blocked_until timestamp

async function loadIPBlocks() {
  try {
    const result = await pool.query('SELECT ip, blocked_until FROM ip_blocks WHERE blocked_until > NOW()');
    blockedIPs.clear();
    for (const row of result.rows) {
      blockedIPs.set(row.ip, new Date(row.blocked_until).getTime());
    }
    console.log(`[Moderation] Loaded ${blockedIPs.size} active IP blocks`);
  } catch (e) {
    console.error('[Moderation] Failed to load IP blocks:', e.message);
  }
}

// DISABLED: Moderation system disabled for dormant archive (task #1313577)
// setTimeout(loadIPBlocks, 3000);
// setInterval(loadIPBlocks, 5 * 60 * 1000);

function isIPBlocked(ip) {
  if (!ip || ip === 'unknown') return false;
  const until = blockedIPs.get(ip);
  if (!until) return false;
  if (Date.now() > until) {
    blockedIPs.delete(ip);
    return false;
  }
  return true;
}

// ---- AI Content Moderation (pre-post, async) ----
async function moderateContentWithAI(text) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return false;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-haiku-20240307',
        max_tokens: 5,
        messages: [{
          role: 'user',
          content: `Is this post cruel, threatening, targeting a specific person, hate speech, or harassment? Reply ONLY with YES or NO.\n\n"${text.substring(0, 400)}"`
        }]
      }),
      signal: controller.signal
    });

    clearTimeout(timeout);
    if (!response.ok) return false;

    const data = await response.json();
    const answer = (data.content?.[0]?.text || '').trim().toUpperCase();
    const flagged = answer.startsWith('YES');
    if (flagged) console.log('[AI Mod] Blocked post:', text.substring(0, 60));
    return flagged;
  } catch (e) {
    console.error('[AI Mod] Error (allowing post):', e.message);
    return false;
  }
}

// ---- AI Image Moderation ----
// Checks uploaded image buffer for: explicit sexual content, CSAM, graphic violence, hateful symbols, spam imagery.
// Returns { safe: true } or { safe: false, reason: string }
// Fail-open: if API unavailable, allows image through (logs warning)
async function moderateImageWithAI(buffer, mimetype) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { safe: true }; // no key → skip

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10s for images

    const base64 = buffer.toString('base64');
    // Anthropic media types: image/jpeg, image/png, image/webp, image/gif
    const mediaType = mimetype === 'image/webp' ? 'image/webp'
      : mimetype === 'image/png' ? 'image/png'
      : 'image/jpeg';

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-haiku-20240307',
        max_tokens: 10,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: base64 }
            },
            {
              type: 'text',
              text: 'Does this image contain explicit sexual content, sexual content involving minors, graphic violence, hateful symbols or hate group imagery, or obvious spam/scam imagery? Reply ONLY with YES or NO.'
            }
          ]
        }]
      }),
      signal: controller.signal
    });

    clearTimeout(timeout);
    if (!response.ok) {
      console.warn('[Image Mod] API error:', response.status, '— allowing image');
      return { safe: true };
    }

    const data = await response.json();
    const answer = (data.content?.[0]?.text || '').trim().toUpperCase();
    const unsafe = answer.startsWith('YES');
    if (unsafe) console.log('[Image Mod] Rejected unsafe image | mimetype=' + mimetype);
    return { safe: !unsafe };
  } catch (e) {
    console.error('[Image Mod] Error (allowing image):', e.message);
    return { safe: true }; // fail-open
  }
}

// ---- Send Daily Summary Email ----
async function sendDailySummaryEmail() {
  try {
    // Gather all stats
    const [postStats, reactionStats, topTips, deviceCount, geoStats, flaggedCount, passphraseWord] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE tab = 'moments' AND admin_hidden IS NOT TRUE)::int AS moments,
          COUNT(*) FILTER (WHERE tab = 'tips' AND admin_hidden IS NOT TRUE)::int AS tips,
          COUNT(*) FILTER (WHERE tab = 'pulse' AND admin_hidden IS NOT TRUE)::int AS pulse
        FROM posts WHERE session_id != 'SYSTEM'
          AND DATE(created_at AT TIME ZONE 'America/Los_Angeles') >= $1
      `, [ANALYTICS_START_DATE]),
      pool.query(`
        SELECT emoji, COUNT(*)::int AS cnt
        FROM reactions r
        JOIN posts p ON r.post_id = p.id
        WHERE p.session_id != 'SYSTEM' AND p.admin_hidden IS NOT TRUE
          AND DATE(p.created_at AT TIME ZONE 'America/Los_Angeles') >= $1
        GROUP BY emoji ORDER BY cnt DESC
      `, [ANALYTICS_START_DATE]),
      pool.query(`
        SELECT p.text, p.nickname,
               COALESCE((SELECT COUNT(*)::int FROM reactions WHERE post_id = p.id AND emoji = '🩵'), 0) AS hearts
        FROM posts p
        WHERE p.tab = 'tips' AND p.flagged = FALSE AND p.admin_hidden IS NOT TRUE
          AND p.session_id != 'SYSTEM'
          AND p.created_at >= NOW() - INTERVAL '24 hours'
        ORDER BY hearts DESC LIMIT 3
      `),
      pool.query(`
        SELECT COUNT(DISTINCT session_id)::int AS cnt FROM (
          SELECT session_id FROM posts WHERE session_id != 'SYSTEM'
            AND DATE(created_at AT TIME ZONE 'America/Los_Angeles') >= $1
          UNION SELECT r.session_id FROM reactions r
            JOIN posts p ON r.post_id = p.id
            WHERE DATE(p.created_at AT TIME ZONE 'America/Los_Angeles') >= $1
        ) sub
      `, [ANALYTICS_START_DATE]),
      pool.query(`
        SELECT geo_tier, COUNT(*)::int AS cnt
        FROM posts WHERE session_id != 'SYSTEM'
          AND DATE(created_at AT TIME ZONE 'America/Los_Angeles') >= $1
        GROUP BY geo_tier
      `, [ANALYTICS_START_DATE]),
      pool.query(`SELECT COUNT(*)::int AS cnt FROM posts WHERE (flagged = TRUE OR flag_count >= 3) AND admin_hidden IS NOT TRUE
        AND DATE(created_at AT TIME ZONE 'America/Los_Angeles') >= $1`, [ANALYTICS_START_DATE]),
      getTodayPassphrase()
    ]);

    const posts = postStats.rows[0];
    const reactionMap = {};
    for (const r of reactionStats.rows) reactionMap[r.emoji] = r.cnt;
    const devices = deviceCount.rows[0].cnt;
    const flagged = flaggedCount.rows[0].cnt;

    const geoMap = {};
    for (const g of geoStats.rows) geoMap[g.geo_tier] = g.cnt;
    const geoStr = `at the fest: ${geoMap['grounds'] || 0} | in the desert: ${geoMap['valley'] || 0} | watching from elsewhere: ${geoMap['outside'] || 0}`;

    const topTipsStr = topTips.rows.length === 0
      ? 'no tips in the last 24h'
      : topTips.rows.map((t, i) => `  ${i + 1}. "${t.text}" — ${t.nickname} (${t.hearts} 🩵)`).join('\n');

    const emojiOrder = ['😂','😢','🙏','🤔','💙'];
    const reactionsStr = emojiOrder.map(e => `${e} ${reactionMap[e] || 0}`).join('  ');

    const today = getTodayInPT();
    const subject = `mirage daily summary — ${today}`;
    const body = `mirage daily summary
${today}
${'─'.repeat(40)}

posts by feed
  good shots: ${posts.moments}  |  good vibes: ${posts.tips}  |  good tips: ${posts.pulse}

reactions
  ${reactionsStr}

top good vibes (last 24h)
${topTipsStr}

reach
  unique devices: ${devices}
  ${geoStr}

moderation
  flagged posts: ${flagged}

today's passphrase: ${passphraseWord}

${'─'.repeat(40)}
https://mirage.sunshine.fm`;

    // Try Polsia email proxy first
    const emailBase = process.env.POLSIA_R2_BASE_URL;
    const apiKey2 = process.env.POLSIA_API_KEY;

    if (emailBase && apiKey2) {
      const slug = process.env.POLSIA_ANALYTICS_SLUG || 'desertdrop';
      // Extract numeric company ID from API key (e.g. "company_39476_abc..." → "39476")
      const companyIdMatch = apiKey2.match(/company_(\d+)_/);
      const companyId = companyIdMatch ? companyIdMatch[1] : null;
      // Try multiple endpoint paths — numeric company ID first (matches Polsia internal routing)
      const emailEndpoints = [
        ...(companyId ? [`${emailBase}/api/company/${companyId}/email/send`] : []),
        `${emailBase}/api/company/${slug}/email/send`,
        `${emailBase}/api/postmark/send`,
        `${emailBase}/api/company/email/send`,
        `${emailBase}/api/emails/send`,
        `${emailBase}/api/email/send`,
      ];
      for (const endpoint of emailEndpoints) {
        try {
          const htmlBody = `<html><body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
<h2 style="color:#0369A1">mirage daily summary — ${today}</h2>
<pre style="background:#f8fafc;padding:16px;border-radius:8px;font-size:14px">${body}</pre>
<p style="color:#94a3b8;font-size:12px">mirage.sunshine.fm</p>
</body></html>`;
          const resp = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey2}` },
            body: JSON.stringify({
              to: 'sat@sunshine.fm',
              subject,
              text: body,
              html: htmlBody,
              from: 'mirage@polsia.app'
            })
          });
          if (resp.ok) {
            console.log(`[Daily Email] Sent via ${endpoint}`);
            return;
          }
          const errBody = await resp.text().catch(() => '');
          console.warn(`[Daily Email] Proxy ${endpoint} failed: ${resp.status} — ${errBody.slice(0,200)}`);
        } catch (e) {
          console.warn(`[Daily Email] Proxy ${endpoint} error: ${e.message}`);
        }
      }
    }

    // Fallback: nodemailer if SMTP is configured
    const smtpHost = process.env.SMTP_HOST;
    if (smtpHost) {
      try {
        const nodemailer = require('nodemailer');
        const transporter = nodemailer.createTransport({
          host: smtpHost,
          port: parseInt(process.env.SMTP_PORT || '587'),
          secure: process.env.SMTP_SECURE === 'true',
          auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
        });
        await transporter.sendMail({
          from: process.env.SMTP_FROM || 'mirage@polsia.app',
          to: 'sat@sunshine.fm',
          subject,
          text: body
        });
        console.log('[Daily Email] Sent via SMTP');
        return;
      } catch (e) {
        console.error('[Daily Email] SMTP error:', e.message);
      }
    }

    // All methods failed
    console.error('[Daily Email] All delivery methods failed. Subject was:', subject);
    throw new Error('Email delivery failed: Polsia proxy returned errors and no SMTP is configured');
  } catch (err) {
    console.error('[Daily Email] Failed to build/send:', err.message);
    throw err;
  }
}

// ---- Data Export ----
// Festival date ranges (PT)
const FESTIVALS = {
  W1:         { label: 'Weekend 1 (Apr 10-13)', start: '2026-04-10', end: '2026-04-13' },
  W2:         { label: 'Weekend 2 (Apr 17-19)', start: '2026-04-17', end: '2026-04-19' },
  Stagecoach: { label: 'Stagecoach (Apr 24-26)', start: '2026-04-24', end: '2026-04-26' },
  gap1:       { label: 'Gap W1→W2 (Apr 14-16)',  start: '2026-04-14', end: '2026-04-16' },
  gap2:       { label: 'Gap W2→Stagecoach (Apr 20-23)', start: '2026-04-20', end: '2026-04-23' },
};

async function queryFestival(festivalKey, pool) {
  const f = FESTIVALS[festivalKey];
  const [sessions, posts, reactions, pageviews, uniquePv, uniqueDevices] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS cnt FROM sessions WHERE DATE(registered_at AT TIME ZONE 'America/Los_Angeles') >= $1 AND DATE(registered_at AT TIME ZONE 'America/Los_Angeles') <= $2`, [f.start, f.end]),
    pool.query(`SELECT COUNT(*)::int AS cnt FROM posts WHERE session_id != 'SYSTEM' AND DATE(created_at AT TIME ZONE 'America/Los_Angeles') >= $1 AND DATE(created_at AT TIME ZONE 'America/Los_Angeles') <= $2`, [f.start, f.end]),
    pool.query(`SELECT COUNT(*)::int AS cnt FROM reactions r JOIN posts p ON r.post_id = p.id WHERE p.session_id != 'SYSTEM' AND DATE(p.created_at AT TIME ZONE 'America/Los_Angeles') >= $1 AND DATE(p.created_at AT TIME ZONE 'America/Los_Angeles') <= $2`, [f.start, f.end]),
    pool.query(`SELECT COUNT(*)::int AS cnt FROM page_views WHERE DATE(created_at AT TIME ZONE 'America/Los_Angeles') >= $1 AND DATE(created_at AT TIME ZONE 'America/Los_Angeles') <= $2`, [f.start, f.end]),
    pool.query(`SELECT COUNT(DISTINCT device_id)::int AS cnt FROM page_views WHERE DATE(created_at AT TIME ZONE 'America/Los_Angeles') >= $1 AND DATE(created_at AT TIME ZONE 'America/Los_Angeles') <= $2`, [f.start, f.end]),
    pool.query(`SELECT COUNT(DISTINCT session_id)::int AS cnt FROM sessions WHERE DATE(registered_at AT TIME ZONE 'America/Los_Angeles') >= $1 AND DATE(registered_at AT TIME ZONE 'America/Los_Angeles') <= $2`, [f.start, f.end]),
  ]);
  return {
    period: f.label,
    sessions_created: sessions.rows[0].cnt,
    posts: posts.rows[0].cnt,
    reactions: reactions.rows[0].cnt,
    pageviews: pageviews.rows[0].cnt,
    unique_pageview_devices: uniquePv.rows[0].cnt,
    unique_sessions: uniqueDevices.rows[0].cnt,
  };
}

async function runDataExport() {
  console.log('[Export] Starting final data export...');
  try {
    // Lifetime totals
    const [postStats, reactionStats, geoStats, dailyCurve, devicesByDay, flaggedPosts, totalSessions, totalPageviews] = await Promise.all([
      pool.query(`SELECT tab, COUNT(*)::int AS cnt FROM posts WHERE session_id != 'SYSTEM' GROUP BY tab`),
      pool.query(`SELECT emoji, COUNT(*)::int AS cnt FROM reactions r JOIN posts p ON r.post_id = p.id WHERE p.session_id != 'SYSTEM' GROUP BY emoji ORDER BY cnt DESC`),
      pool.query(`SELECT geo_tier, COUNT(*)::int AS cnt FROM posts WHERE session_id != 'SYSTEM' GROUP BY geo_tier`),
      pool.query(`SELECT DATE(created_at AT TIME ZONE 'America/Los_Angeles') AS day, COUNT(*)::int AS posts_cnt FROM posts WHERE session_id != 'SYSTEM' GROUP BY day ORDER BY day`),
      pool.query(`SELECT DATE(p.created_at AT TIME ZONE 'America/Los_Angeles') AS day, COUNT(DISTINCT p.session_id)::int AS unique_devices FROM posts p WHERE p.session_id != 'SYSTEM' GROUP BY day ORDER BY day`),
      pool.query(`SELECT id, nickname, text, tab, geo_tier, flag_count, created_at FROM posts WHERE flagged = TRUE OR flag_count >= 3 ORDER BY created_at`),
      pool.query(`SELECT COUNT(*)::int AS cnt FROM sessions`),
      pool.query(`SELECT COUNT(*)::int AS cnt FROM page_views`),
    ]);

    const reactionsByDay = await pool.query(`
      SELECT DATE(r.created_at AT TIME ZONE 'America/Los_Angeles') AS day, COUNT(*)::int AS reactions_cnt
      FROM reactions r GROUP BY day ORDER BY day
    `);

    // Per-festival breakdown
    const festivalBreakdown = {};
    for (const key of Object.keys(FESTIVALS)) {
      festivalBreakdown[key] = await queryFestival(key, pool);
    }

    const exportData = {
      exported_at: new Date().toISOString(),
      totals: {
        sessions_created: totalSessions.rows[0].cnt,
        posts: postStats.rows.reduce((s, r) => s + r.cnt, 0),
        reactions: reactionStats.rows.reduce((s, r) => s + r.cnt, 0),
        pageviews: totalPageviews.rows[0].cnt,
      },
      summary: {
        post_counts_by_feed: postStats.rows,
        reaction_counts_by_emoji: reactionStats.rows,
        geo_split: geoStats.rows,
        daily_posts: dailyCurve.rows,
        daily_reactions: reactionsByDay.rows,
        daily_unique_devices: devicesByDay.rows,
        flagged_post_count: flaggedPosts.rows.length,
      },
      per_festival: festivalBreakdown,
      flagged_posts: flaggedPosts.rows,
    };

    // Store both types in DB
    await pool.query(`INSERT INTO data_exports (export_type, data) VALUES ($1, $2)`, ['pre_closure', exportData]);
    await pool.query(`INSERT INTO data_exports (export_type, data) VALUES ($1, $2)`, ['final_snapshot', exportData]);

    // Write to public/export so it's downloadable after shutdown
    const exportDir = path.join(__dirname, 'public', 'export');
    if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(exportDir, `mirage-export-${ts}.json`), JSON.stringify(exportData, null, 2));

    // CSV export
    const csvLines = ['feed,count'];
    for (const row of postStats.rows) csvLines.push(`${row.tab},${row.cnt}`);
    csvLines.push('');
    csvLines.push('emoji,reactions');
    for (const row of reactionStats.rows) csvLines.push(`${row.emoji},${row.cnt}`);
    csvLines.push('');
    csvLines.push('geo_tier,posts');
    for (const row of geoStats.rows) csvLines.push(`${row.geo_tier},${row.cnt}`);
    csvLines.push('');
    csvLines.push('date,posts');
    for (const row of dailyCurve.rows) csvLines.push(`${row.day},${row.posts_cnt}`);
    fs.writeFileSync(path.join(exportDir, `mirage-export-${ts}.csv`), csvLines.join('\n'));

    // Save final_snapshot report via Polsia reports API
    const apiKey = process.env.POLSIA_API_KEY;
    const apiBase = process.env.POLSIA_R2_BASE_URL || 'https://polsia.com';
    if (apiKey) {
      try {
        const companyIdMatch = apiKey.match(/company_(\d+)_/);
        const companyId = companyIdMatch ? companyIdMatch[1] : null;
        // Try company-scoped reports endpoint first
        const reportsEndpoint = companyId
          ? `${apiBase}/api/company/${companyId}/reports`
          : `${apiBase}/api/reports`;
        const resp = await fetch(reportsEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            name: 'Mirage Final Data Snapshot',
            report_type: 'final_snapshot',
            report_date: '2026-05-01',
            content: formatMarkdownReport(exportData),
            metadata: {
              instance_id: 15741,
              app_url: 'https://mirage-social.polsia.app',
              totals: exportData.totals,
              per_festival: festivalBreakdown,
            },
          }),
        });
        if (resp.ok) {
          console.log('[Export] Saved final_snapshot report to Polsia');
        } else {
          const errBody = await resp.text().catch(() => '');
          console.warn(`[Export] Polsia reports API returned ${resp.status}: ${errBody}`);
        }
      } catch (e) {
        console.warn('[Export] Polsia reports API call failed:', e.message);
      }
    }

    console.log(`[Export] Done. JSON + CSV written to public/export/`);
    return exportData;
  } catch (err) {
    console.error('[Export] Failed:', err.message);
    throw err;
  }
}

// Formats the final snapshot as markdown for the Polsia report
function formatMarkdownReport(data) {
  const f = data.per_festival;
  let md = `# Mirage — Final Data Snapshot\n\n`;
  md += `**Exported:** ${data.exported_at}  \n`;
  md += `**App:** mirage-social.polsia.app  \n\n`;

  md += `## Lifetime Totals\n\n`;
  md += `| Metric | Value |\n|--------|-------|\n`;
  md += `| Sessions created | ${data.totals.sessions_created} |\n`;
  md += `| Posts | ${data.totals.posts} |\n`;
  md += `| Reactions | ${data.totals.reactions} |\n`;
  md += `| Pageviews | ${data.totals.pageviews} |\n\n`;

  md += `## Per-Festival Breakdown\n\n`;
  md += `| Festival | Sessions | Posts | Reactions | Pageviews |\n`;
  md += `|---------|----------|-------|----------|----------|\n`;
  md += `| ${f.W1.period} | ${f.W1.sessions_created} | ${f.W1.posts} | ${f.W1.reactions} | ${f.W1.pageviews} |\n`;
  md += `| ${f.gap1.period} | ${f.gap1.sessions_created} | ${f.gap1.posts} | ${f.gap1.reactions} | ${f.gap1.pageviews} |\n`;
  md += `| ${f.W2.period} | ${f.W2.sessions_created} | ${f.W2.posts} | ${f.W2.reactions} | ${f.W2.pageviews} |\n`;
  md += `| ${f.gap2.period} | ${f.gap2.sessions_created} | ${f.gap2.posts} | ${f.gap2.reactions} | ${f.gap2.pageviews} |\n`;
  md += `| ${f.Stagecoach.period} | ${f.Stagecoach.sessions_created} | ${f.Stagecoach.posts} | ${f.Stagecoach.reactions} | ${f.Stagecoach.pageviews} |\n\n`;

  md += `## Feed Breakdown\n\n`;
  md += `| Feed | Posts |\n|------|-------|\n`;
  for (const row of data.summary.post_counts_by_feed) {
    md += `| ${row.tab} | ${row.cnt} |\n`;
  }
  md += `\n## Flagged Posts (${data.summary.flagged_post_count})\n\n`;
  if (data.flagged_posts.length === 0) {
    md += `None.\n`;
  } else {
    for (const post of data.flagged_posts) {
      md += `- **${post.nickname || 'anonymous'}** (${post.geo_tier || 'unknown'}, ${post.tab}): ${post.text.slice(0, 80)}${post.text.length > 80 ? '…' : ''}\n`;
    }
  }
  return md;
}

// ---- SSE Clients ----
const sseClients = new Set();

function broadcastNewPost(post) {
  if (sseClients.size === 0) return;
  const data = JSON.stringify({ type: 'new_post', post });
  for (const client of sseClients) {
    try {
      client.res.write(`data: ${data}\n\n`);
    } catch (e) {
      sseClients.delete(client);
    }
  }
}

// ---- Passphrase System ----
// 30 desert-themed one-word passphrases (auto-rotate daily if no admin override)
const PASSPHRASE_WORDS = [
  'mesa', 'dune', 'cactus', 'canyon', 'arroyo', 'adobe', 'saguaro', 'cholla',
  'ocotillo', 'creosote', 'saltflat', 'solstice', 'sundog', 'haze', 'ridge',
  'bluff', 'yucca', 'basin', 'sandstone', 'tumbleweed', 'agave', 'indigo',
  'prickly', 'mirage', 'desert', 'sunrise', 'sunset', 'oasis', 'lizard', 'hawk'
];

function getTodayInPT() {
  // Get today's date in America/Los_Angeles timezone (PT)
  const now = new Date();
  const ptStr = now.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  // en-CA gives YYYY-MM-DD format
  return ptStr;
}

function getFallbackPassphrase() {
  // Rotate daily based on days since Unix epoch (in PT date)
  const today = getTodayInPT();
  const epoch = new Date('1970-01-01');
  const todayDate = new Date(today);
  const dayIndex = Math.floor((todayDate - epoch) / 86400000);
  return PASSPHRASE_WORDS[dayIndex % PASSPHRASE_WORDS.length];
}

async function getTodayPassphrase() {
  const today = getTodayInPT();
  try {
    const result = await pool.query(
      'SELECT word FROM passphrase_overrides WHERE date = $1',
      [today]
    );
    if (result.rows.length > 0) {
      return result.rows[0].word;
    }
  } catch (e) {
    console.error('[Passphrase] DB lookup failed:', e.message);
  }
  return getFallbackPassphrase();
}

// ---- Daily System Post (passphrase announcement) ----
let lastPassphrasePostDate = null;

async function maybeCreatePassphrasePost() {
  const today = getTodayInPT();
  if (lastPassphrasePostDate === today) return; // Already posted today (in-memory cache)

  try {
    // Only fire at 8AM PT or later — guards against midnight misfires.
    // Uses Intl.DateTimeFormat with hour12:false so midnight returns 0 (not "12"),
    // fixing the parseInt("12") >= 8 bug that caused the Mar 24 midnight misfire.
    // No upper bound: if server restarts after 9 AM and no post exists yet, still create it.
    const ptHour = parseInt(new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      hour: '2-digit',
      hour12: false
    }).format(new Date()), 10);
    if (ptHour < 8) return;

    // Check if today's system post already exists — use PT timezone for date comparison
    const existing = await pool.query(
      `SELECT id FROM posts WHERE session_id = 'SYSTEM' AND tab = 'moments' AND DATE(created_at AT TIME ZONE 'America/Los_Angeles') = $1`,
      [today]
    );
    if (existing.rows.length > 0) {
      lastPassphrasePostDate = today;
      return;
    }

    // Clean up legacy passphrase posts from tips/pulse — no longer created there.
    // Safe to delete since these are machine-generated SYSTEM posts, not user content.
    await pool.query(`DELETE FROM posts WHERE session_id = 'SYSTEM' AND tab IN ('tips', 'pulse')`);

    const word = await getTodayPassphrase();
    const text = `today's passphrase is ${word}`;

    // Create system post in Moments only — passphrase is announcement-style content,
    // not tips/advice and not a live update. Good Vibes and Good Tips stay organic.
    const tabs = ['moments'];
    for (const tab of tabs) {
      await pool.query(
        `INSERT INTO posts (session_id, nickname, text, tab, geo_tier, flagged)
         VALUES ('SYSTEM', 'mirage', $1, $2, 'valley', FALSE)`,
        [text, tab]
      );
    }

    lastPassphrasePostDate = today;
    console.log(`[Passphrase] Created daily system post for ${today}: "${word}"`);
  } catch (e) {
    console.error('[Passphrase] Failed to create system post:', e.message);
  }
}

// Check every minute for new day
// DISABLED: Passphrase post creation disabled for dormant archive (task #1313577)
// setInterval(maybeCreatePassphrasePost, 60 * 1000);
// setTimeout(maybeCreatePassphrasePost, 5000);

// ---- Good Tips (Pulse) — Permanent Posts ----
// Good Tips posts no longer expire. They are permanent like all other feeds.
// The pulse log panel shows all pulse posts for historical analysis.
const PULSE_TTL_MINUTES = null; // TTL removed — Good Tips are permanent

// ---- May 1 Shutdown ----
// May 1, 2026 11:59 PM Pacific = May 2 06:59 UTC
const SHUTDOWN_DATE = new Date('2026-05-02T06:59:00Z');
// After farewell grace period: root redirects directly to season1 archive
// May 3, 2026 00:00 UTC = ~24 hours after shutdown
const ARCHIVE_REDIRECT_DATE = new Date('2026-05-03T00:00:00Z');

function isShutdown() {
  return new Date() >= SHUTDOWN_DATE;
}

function isArchiveReady() {
  return new Date() >= ARCHIVE_REDIRECT_DATE;
}

// ---- Health Check ----
app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// ---- DB Health + Pool Stats ----
app.get('/api/health/db', async (req, res) => {
  const start = Date.now();
  try {
    await pool.query('SELECT 1');
    res.json({
      status: 'ok',
      latency_ms: Date.now() - start,
      pool: {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount
      }
    });
  } catch (err) {
    res.status(503).json({
      status: 'error',
      error: err.message,
      pool: {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount
      }
    });
  }
});

// ---- API Health Check (declared above the post-shutdown /api guard so it stays live after May 1) ----
app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// ---- /api/eat/restaurants (declared above the post-shutdown /api guard so it stays live after May 1) ----
app.get('/api/eat/restaurants', async (req, res) => {
  try {
    const rows = await eatLoadRestaurants();
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({ count: rows.length, restaurants: rows });
  } catch (err) {
    console.error('[Eat] api failed:', err.message);
    res.status(500).json({ error: 'Failed to load restaurants' });
  }
});

// ---- /api/series/lead (registered above the post-shutdown /api guard so it stays live after May 1) ----
// Persists sponsor leads to the series_leads table and emails SunshineFM via
// the Polsia email proxy. Mirrors the /api/eat/restaurants carve-out: this
// is the post-shutdown revenue surface, not a Season 1 artifact.
async function handleSeriesLead(req, res) {
  try {
    const { name, email, company, role, budget_tier, episode_interest, message } = req.body || {};
    if (!name || typeof name !== 'string' || name.trim().length === 0 ||
        !email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return res.redirect('/series?error=' + encodeURIComponent(name ? 'invalid_email' : 'missing_fields'));
    }
    if (budget_tier && !SERIES_TIERS.includes(String(budget_tier).toLowerCase())) {
      return res.redirect('/series?error=invalid_tier');
    }
    const safeName = name.trim().slice(0, 120);
    const safeEmail = email.trim().slice(0, 255);
    const safeCompany = (company && typeof company === 'string') ? company.trim().slice(0, 255) : null;
    const safeRole = (role && typeof role === 'string') ? role.trim().slice(0, 120) : null;
    const safeEpisode = (episode_interest && typeof episode_interest === 'string') ? episode_interest.trim().slice(0, 40) : null;
    const safeMessage = (message && typeof message === 'string') ? message.trim().slice(0, 1000) : null;
    const safeTier = budget_tier ? String(budget_tier).toLowerCase() : null;
    const ip = (req.ip || req.headers['x-forwarded-for'] || '').toString().slice(0, 64);
    const ua = (req.headers['user-agent'] || '').toString().slice(0, 500);
    const ref = (req.headers['referer'] || '').toString().slice(0, 500);

    await pool.query(
      `INSERT INTO series_leads (name, email, company, role, budget_tier, episode_interest, message, ip, user_agent, referer, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
      [safeName, safeEmail, safeCompany, safeRole, safeTier, safeEpisode, safeMessage, ip, ua, ref]
    );

    const apiKey = process.env.POLSIA_API_KEY;
    const inbox = process.env.POLSIA_COMPANY_EMAIL;
    if (apiKey && inbox) {
      try {
        await fetch('https://polsia.com/api/proxy/email/contacts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ email: safeEmail, name: safeName, source: 'contact_form' })
        });
        const body = `New Series sponsor lead\n\nName: ${safeName}\nEmail: ${safeEmail}\nCompany: ${safeCompany || '—'}\nRole: ${safeRole || '—'}\nTier: ${safeTier || '—'}\nEpisode interest: ${safeEpisode || '—'}\n\nMessage:\n${safeMessage || '(none)'}\n\n— https://mirage.sunshine.fm/series`;
        await fetch('https://polsia.com/api/proxy/email/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ to: inbox, subject: `Series lead — ${safeTier || 'no tier'} — ${safeName}`, body })
        });
      } catch (e) {
        console.warn('[Series] Email proxy call failed (lead is still in DB):', e.message);
      }
    }
    res.redirect(303, '/series?submitted=1');
  } catch (err) {
    console.error('[Series] Lead intake failed:', err.message);
    res.redirect('/series?error=server');
  }
}
app.post('/api/series/lead', handleSeriesLead);

// ---- Shutdown guard for API ----
app.use('/api', (req, res, next) => {
  if (isShutdown()) {
    return res.status(410).json({ error: 'Mirage has ended. See you next season. ✨' });
  }
  next();
});

// ---- API: Get Posts ----
app.get('/api/posts', async (req, res) => {
  try {
    const { tab = 'moments', before, limit = 20 } = req.query;
    const validTabs = ['moments', 'tips', 'pulse'];
    if (!validTabs.includes(tab)) {
      return res.status(400).json({ error: 'Invalid tab' });
    }

    // Trigger daily passphrase post check
    maybeCreatePassphrasePost().catch(() => {});

    const lim = tab === 'tips' ? 50 : Math.min(parseInt(limit) || 20, 50);
    const params = [tab];

    // Good Tips (pulse) posts are now permanent — no TTL expiration
    let whereClause = "WHERE p.tab = $1 AND p.flagged = FALSE AND (p.flag_count < 3 OR p.flag_count IS NULL) AND (p.admin_hidden IS NOT TRUE)";

    if (before && tab !== 'tips') {
      params.push(before);
      whereClause += ` AND p.created_at < $${params.length}`;
    }

    params.push(lim);

    // Pinned posts (pin_order IS NOT NULL) float to top across ALL feeds, ordered by pin_order ASC.
    // Tips: non-pinned sorted by 🩵 count (most helpful first), then recency
    // Others: non-pinned sorted chronologically (newest first)
    let orderBy;
    if (tab === 'tips') {
      orderBy = `ORDER BY CASE WHEN p.pin_order IS NOT NULL THEN 0 ELSE 1 END, COALESCE(p.pin_order, 999999), COALESCE((SELECT COUNT(*)::int FROM reactions WHERE post_id = p.id AND emoji = '🩵'), 0) DESC, p.created_at DESC`;
    } else {
      orderBy = `ORDER BY CASE WHEN p.pin_order IS NOT NULL THEN 0 ELSE 1 END, COALESCE(p.pin_order, 999999), p.created_at DESC`;
    }

    const query = `
      SELECT p.id, p.session_id, p.nickname, p.text, p.tab, p.photo_url, p.geo_tier,
             p.created_at,
             COALESCE(
               (SELECT json_agg(json_build_object('emoji', sub.emoji, 'count', sub.cnt))
                FROM (SELECT emoji, COUNT(*)::int as cnt FROM reactions WHERE post_id = p.id GROUP BY emoji) sub
               ), '[]'::json
             ) as reactions
      FROM posts p
      ${whereClause}
      ${orderBy}
      LIMIT $${params.length}
    `;

    const result = await pool.query(query, params);
    res.json({ posts: result.rows });
  } catch (err) {
    console.error('Error fetching posts:', err);
    res.status(500).json({ error: 'Failed to fetch posts' });
  }
});

// ---- API: Register Session (stores geo_tier server-side for watcher enforcement) ----
app.post('/api/sessions/register', async (req, res) => {
  try {
    const { session_id, latitude, longitude, utm_source, utm_medium, utm_campaign, passphrase_required } = req.body;
    if (!session_id) {
      return res.status(400).json({ error: 'Missing session_id' });
    }
    const geo_tier = getGeoTier(latitude, longitude);

    // Check if this is a genuinely new session — only set passphrase_required=false for new registrations
    // Existing sessions (upserted) keep their original passphrase_required value
    const existing = await pool.query(
      'SELECT session_id FROM sessions WHERE session_id = $1',
      [session_id]
    );
    const isNewSession = existing.rows.length === 0;
    // passphrase_required=false signals post-change sessions for A/B comparison
    const pr = isNewSession && passphrase_required === false ? false : undefined;

    await pool.query(
      `INSERT INTO sessions (session_id, geo_tier, registered_at, last_seen, utm_source, utm_medium, utm_campaign, passphrase_required)
       VALUES ($1, $2, NOW(), NOW(), $3, $4, $5, $6)
       ON CONFLICT (session_id) DO UPDATE
         SET geo_tier = EXCLUDED.geo_tier, last_seen = NOW(),
             utm_source = COALESCE(NULLIF(EXCLUDED.utm_source, ''), sessions.utm_source),
             utm_medium = COALESCE(NULLIF(EXCLUDED.utm_medium, ''), sessions.utm_medium),
             utm_campaign = COALESCE(NULLIF(EXCLUDED.utm_campaign, ''), sessions.utm_campaign)`,
      [session_id, geo_tier, utm_source || null, utm_medium || null, utm_campaign || null, pr]
    );
    res.json({ geo_tier });
  } catch (err) {
    console.error('Error registering session:', err);
    // Non-fatal — don't block the client
    res.status(500).json({ error: 'Failed to register session' });
  }
});

// ---- API: Create Post ----
app.post('/api/posts', async (req, res) => {
  try {
    const { session_id, nickname, text, tab, latitude, longitude, photo_url } = req.body;

    // Extract real client IP (Render uses a reverse proxy)
    const clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';

    // Anti-spam: honeypot field — bots auto-fill it, humans never see it
    // Silently accept (fake 201) so bots don't know they're caught
    if (req.body.website_url && String(req.body.website_url).length > 0) {
      console.log(`[Spam] Honeypot triggered | session=${session_id} ip=${clientIp}`);
      return res.status(201).json({ post: { id: 0, text: '', nickname: nickname || '', tab: tab || 'moments', reactions: [], flag_count: 0, created_at: new Date().toISOString() } });
    }

    // Anti-spam: minimum time since page load — no human types and submits in < 2s
    const pageLoadMs = parseInt(req.body.page_load_ms, 10);
    if (!isNaN(pageLoadMs) && pageLoadMs < 2000) {
      console.log(`[Spam] Timing check failed (${pageLoadMs}ms) | session=${session_id} ip=${clientIp}`);
      return res.status(201).json({ post: { id: 0, text: '', nickname: nickname || '', tab: tab || 'moments', reactions: [], flag_count: 0, created_at: new Date().toISOString() } });
    }

    if (!session_id || !nickname || !tab) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    // Allow photo posts with no caption — text is optional when photo_url is provided
    if (!photo_url && (!text || text.trim().length === 0)) {
      return res.status(400).json({ error: 'Post cannot be empty' });
    }
    if ((text || '').length > 280) {
      return res.status(400).json({ error: 'Max 280 characters' });
    }
    if (nickname.trim().length === 0 || nickname.length > 30) {
      return res.status(400).json({ error: 'Nickname must be 1-30 characters' });
    }
    const validTabs = ['moments', 'tips', 'pulse'];
    if (!validTabs.includes(tab)) {
      return res.status(400).json({ error: 'Invalid tab' });
    }

    // Good Shots (moments) requires a photo — text-only posts are not allowed
    if (tab === 'moments' && !photo_url) {
      return res.status(400).json({ error: 'Good Shots requires a photo 📸' });
    }

    // Admin bypass: if valid admin token provided, skip geo check
    const adminToken = req.headers['x-admin-token'];
    const isAdminPost = adminToken && adminToken === process.env.ADMIN_TOKEN;

    // IP block check — admin-blocked IPs cannot post
    if (!isAdminPost && isIPBlocked(clientIp)) {
      console.log(`[Moderation] Blocked IP attempted post | ip=${clientIp} session=${session_id}`);
      return res.status(403).json({ error: 'posting not available' });
    }

    // Geo check — enforce watcher tier server-side using stored session geo_tier
    // Primary: look up the stored tier from when the session was registered
    // Fallback: live calculation from submitted coordinates (for unregistered clients)
    let geo_tier;
    if (isAdminPost) {
      const rawGeoTier = getGeoTier(latitude, longitude);
      geo_tier = rawGeoTier === 'outside' ? 'valley' : rawGeoTier;
    } else {
      try {
        const sessionRow = await pool.query(
          'SELECT geo_tier FROM sessions WHERE session_id = $1',
          [session_id]
        );
        if (sessionRow.rows.length > 0) {
          // Use stored tier — prevents coordinate spoofing
          geo_tier = sessionRow.rows[0].geo_tier;
        } else {
          // Session not registered yet — fall back to live calculation
          geo_tier = getGeoTier(latitude, longitude);
        }
      } catch (e) {
        console.error('[Post] Session lookup failed, using live geo:', e.message);
        geo_tier = getGeoTier(latitude, longitude);
      }
      if (geo_tier === 'outside') {
        return res.status(403).json({ error: 'posting requires being at the fest or in the desert' });
      }
    }

    // Rate limit: 1 post per 5 minutes per session+IP (admin bypasses)
    if (!isAdminPost) {
      const rl = checkRateLimit(session_id, clientIp);
      if (!rl.allowed) {
        const waitMin = Math.ceil(rl.waitSec / 60);
        const msg = waitMin <= 1
          ? 'one post every 5 minutes — take it in 🌵'
          : `one post every 5 minutes — ${waitMin} min to go 🌵`;
        console.log(`[RateLimit] Blocked post | wait=${rl.waitSec}s session=${session_id} ip=${clientIp}`);
        return res.status(429).json({ error: msg });
      }
    }

    // Anti-spam: duplicate content detection — same text 3+ times in 10 min
    if (!isAdminPost && isDuplicateContent(session_id, text)) {
      console.log(`[Spam] Duplicate content blocked | session=${session_id} ip=${clientIp} text="${(text || '').substring(0, 40)}"`);
      return res.status(429).json({ error: 'you already posted that a few times — mix it up 🌵' });
    }

    // Hard-block patterns: slurs, threats, doxxing, scams, sexual exploitation, illegal solicitation
    // Runs before AI moderation (fast, zero cost). Generic error — no reason given.
    if (!isAdminPost && (isHardBlocked(text || '') || isHardBlocked(nickname))) {
      console.log(`[Moderation] Hard-blocked post | session=${session_id} ip=${clientIp} text="${(text || '').substring(0, 60)}"`);
      return res.status(422).json({ error: 'This post could not be published.' });
    }

    // AI content moderation (pre-post, invisible to users)
    const aiBlocked = await moderateContentWithAI(text || '');
    if (aiBlocked) {
      return res.status(422).json({ error: 'This post could not be published.' });
    }

    const result = await pool.query(
      `INSERT INTO posts (session_id, nickname, text, tab, photo_url, geo_tier, latitude, longitude, flagged, post_ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, nickname, text, tab, photo_url, geo_tier, created_at, flagged, post_ip`,
      [session_id, nickname.trim(), (text || '').trim(), tab, photo_url || null, geo_tier, latitude || null, longitude || null, false, clientIp]
    );

    const post = result.rows[0];
    post.reactions = [];
    post.flag_count = 0;
    delete post.post_ip; // Never expose IP in public responses

    // Track posted content for duplicate detection (admin posts exempt)
    if (!isAdminPost) recordPostedContent(session_id, text);

    // Broadcast to SSE clients for real-time sync (posts are always clean at this point)
    broadcastNewPost(post);

    res.status(201).json({ post });
  } catch (err) {
    console.error('Error creating post:', err);
    res.status(500).json({ error: 'Failed to create post' });
  }
});

// ---- API: React to Post ----
// All tiers (including "watching from elsewhere") can react
app.post('/api/posts/:id/react', async (req, res) => {
  try {
    const postId = parseInt(req.params.id);
    const { session_id, emoji } = req.body;

    if (!session_id || !emoji) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Rate limit reactions
    if (!checkReactionRateLimit(session_id)) {
      return res.status(429).json({ error: 'Slow down! Too many reactions' });
    }

    // Updated emoji set (5 emojis)
    const validEmojis = ['😂', '😢', '🙏', '🤔', '💙'];
    if (!validEmojis.includes(emoji)) {
      return res.status(400).json({ error: 'Invalid emoji' });
    }

    // Check if post exists (any tier can react — no geo check)
    const postCheck = await pool.query(
      'SELECT id FROM posts WHERE id = $1 AND flagged = FALSE AND (flag_count < 3 OR flag_count IS NULL)',
      [postId]
    );
    if (postCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }

    // Toggle reaction
    const existing = await pool.query(
      'SELECT id FROM reactions WHERE post_id = $1 AND session_id = $2 AND emoji = $3',
      [postId, session_id, emoji]
    );

    if (existing.rows.length > 0) {
      await pool.query('DELETE FROM reactions WHERE id = $1', [existing.rows[0].id]);
      res.json({ action: 'removed' });
    } else {
      await pool.query(
        'INSERT INTO reactions (post_id, session_id, emoji) VALUES ($1, $2, $3)',
        [postId, session_id, emoji]
      );
      res.json({ action: 'added' });
    }
  } catch (err) {
    console.error('Error reacting:', err);
    res.status(500).json({ error: 'Failed to react' });
  }
});

// ---- API: Flag Post ----
app.post('/api/posts/:id/flag', async (req, res) => {
  try {
    const postId = parseInt(req.params.id);
    const { session_id } = req.body;
    const flagIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';

    if (!session_id) {
      return res.status(400).json({ error: 'Missing session_id' });
    }

    // Check post exists (allow flagging hidden posts — admin may want to track)
    const postCheck = await pool.query(
      'SELECT id, flag_count FROM posts WHERE id = $1',
      [postId]
    );
    if (postCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }

    // Try to insert flag — UNIQUE(post_id, session_id) prevents double-flagging from same session
    try {
      await pool.query(
        'INSERT INTO post_flags (post_id, session_id, flagged_ip) VALUES ($1, $2, $3)',
        [postId, session_id, flagIp]
      );
    } catch (e) {
      if (e.code === '23505') {
        // Already flagged by this session — silently succeed
        return res.json({ flagged: true });
      }
      throw e;
    }

    // Increment flag_count
    const updated = await pool.query(
      `UPDATE posts SET flag_count = COALESCE(flag_count, 0) + 1
       WHERE id = $1 RETURNING flag_count`,
      [postId]
    );
    const flagCount = updated.rows[0]?.flag_count || 0;

    // Auto-hide thresholds (distinct IPs only — prevents one person spamming flags):
    //   3 distinct IPs flagging within 30 minutes  → auto-hide
    //   5 distinct IPs flagging at any time         → auto-hide
    const [recentFlags, totalFlags] = await Promise.all([
      pool.query(
        `SELECT COUNT(DISTINCT flagged_ip)::int AS cnt
         FROM post_flags
         WHERE post_id = $1
           AND created_at > NOW() - INTERVAL '30 minutes'
           AND flagged_ip != 'unknown'`,
        [postId]
      ),
      pool.query(
        `SELECT COUNT(DISTINCT flagged_ip)::int AS cnt
         FROM post_flags
         WHERE post_id = $1
           AND flagged_ip != 'unknown'`,
        [postId]
      )
    ]);

    const distinctRecent = recentFlags.rows[0]?.cnt || 0;
    const distinctTotal = totalFlags.rows[0]?.cnt || 0;
    const shouldAutoHide = distinctRecent >= 3 || distinctTotal >= 5;

    if (shouldAutoHide) {
      await pool.query('UPDATE posts SET admin_hidden = TRUE WHERE id = $1', [postId]);
      console.log(`[Moderation] Auto-hidden post ${postId} | distinct_recent=${distinctRecent} distinct_total=${distinctTotal}`);
    }

    res.json({ flagged: true, flag_count: flagCount, auto_hidden: shouldAutoHide });
  } catch (err) {
    console.error('Error flagging post:', err);
    res.status(500).json({ error: 'Failed to flag post' });
  }
});

// ---- API: Get Flagged Posts (Admin) ----
app.get('/api/admin/flagged', async (req, res) => {
  const adminToken = req.headers['x-admin-token'] || req.query.token;
  if (!adminToken || adminToken !== process.env.ADMIN_TOKEN) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const result = await pool.query(`
      SELECT p.id, p.nickname, p.text, p.tab, p.geo_tier, p.created_at, p.flag_count,
             p.admin_hidden, p.post_ip,
             (SELECT COUNT(DISTINCT pf.session_id)::int FROM post_flags pf WHERE pf.post_id = p.id) AS flag_count_exact,
             (SELECT COUNT(DISTINCT pf.flagged_ip)::int FROM post_flags pf WHERE pf.post_id = p.id AND pf.flagged_ip != 'unknown') AS distinct_flag_ips
      FROM posts p
      WHERE p.flag_count >= 3 OR p.flagged = TRUE OR p.admin_hidden = TRUE
      ORDER BY p.flag_count DESC NULLS LAST, p.created_at DESC
      LIMIT 100
    `);
    res.json({ posts: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch flagged posts' });
  }
});

// ---- Admin auth middleware ----
function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// ---- API: Admin Dashboard (all stats in one call) ----
app.get('/api/admin/dashboard', requireAdmin, async (req, res) => {
  try {
    const today = getTodayInPT();
    const tomorrow = new Date(new Date(today).getTime() + 86400000).toISOString().split('T')[0];

    const [postStats, reactionStats, topTips, deviceCount, totalVisits, geoStats, flaggedPosts, passphraseWord, tomorrowOverride] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE tab = 'moments' AND session_id != 'SYSTEM')::int AS moments,
          COUNT(*) FILTER (WHERE tab = 'tips' AND session_id != 'SYSTEM')::int AS tips,
          COUNT(*) FILTER (WHERE tab = 'pulse' AND session_id != 'SYSTEM')::int AS pulse,
          COUNT(*) FILTER (WHERE session_id != 'SYSTEM')::int AS total
        FROM posts WHERE admin_hidden IS NOT TRUE
          AND DATE(created_at AT TIME ZONE 'America/Los_Angeles') >= $1
      `, [ANALYTICS_START_DATE]),
      pool.query(`
        SELECT emoji, COUNT(*)::int AS cnt
        FROM reactions r
        JOIN posts p ON r.post_id = p.id
        WHERE p.session_id != 'SYSTEM' AND p.admin_hidden IS NOT TRUE
          AND DATE(p.created_at AT TIME ZONE 'America/Los_Angeles') >= $1
        GROUP BY emoji ORDER BY cnt DESC
      `, [ANALYTICS_START_DATE]),
      pool.query(`
        SELECT p.id, p.text, p.nickname, p.created_at,
               COALESCE(p.admin_pinned, FALSE) AS admin_pinned,
               p.pin_order,
               COALESCE((SELECT COUNT(*)::int FROM reactions WHERE post_id = p.id AND emoji = '🩵'), 0) AS hearts
        FROM posts p
        WHERE p.tab = 'tips' AND p.flagged = FALSE AND p.admin_hidden IS NOT TRUE
          AND p.session_id != 'SYSTEM'
          AND DATE(p.created_at AT TIME ZONE 'America/Los_Angeles') >= $1
        ORDER BY CASE WHEN p.pin_order IS NOT NULL THEN 0 ELSE 1 END, COALESCE(p.pin_order, 999999), hearts DESC, p.created_at DESC LIMIT 10
      `, [ANALYTICS_START_DATE]),
      pool.query(`
        SELECT COUNT(DISTINCT device_id)::int AS cnt FROM (
          SELECT device_id FROM page_views WHERE DATE(created_at AT TIME ZONE 'America/Los_Angeles') >= $1
          UNION
          SELECT session_id AS device_id FROM sessions WHERE DATE(registered_at AT TIME ZONE 'America/Los_Angeles') >= $1
        ) sub
      `, [ANALYTICS_START_DATE]),
      pool.query(`SELECT COUNT(*)::int AS cnt FROM page_views WHERE DATE(created_at AT TIME ZONE 'America/Los_Angeles') >= $1`, [ANALYTICS_START_DATE]),
      pool.query(`
        SELECT geo_tier, COUNT(*)::int AS cnt
        FROM posts WHERE session_id != 'SYSTEM'
          AND DATE(created_at AT TIME ZONE 'America/Los_Angeles') >= $1
        GROUP BY geo_tier
      `, [ANALYTICS_START_DATE]),
      pool.query(`
        SELECT p.id, p.nickname, p.text, p.tab, p.geo_tier, p.created_at,
               p.flag_count, p.flagged, p.admin_hidden, p.post_ip,
               (SELECT COUNT(DISTINCT pf.flagged_ip)::int FROM post_flags pf WHERE pf.post_id = p.id AND pf.flagged_ip != 'unknown') AS distinct_flag_ips
        FROM posts p
        WHERE (p.flag_count >= 3 OR p.flagged = TRUE OR p.admin_hidden = TRUE)
          AND p.session_id != 'SYSTEM'
          AND DATE(p.created_at AT TIME ZONE 'America/Los_Angeles') >= $1
        ORDER BY p.flag_count DESC NULLS LAST, p.created_at DESC
        LIMIT 200
      `, [ANALYTICS_START_DATE]),
      getTodayPassphrase(),
      pool.query('SELECT word FROM passphrase_overrides WHERE date = $1', [tomorrow])
    ]);

    const reactionMap = {};
    const emojiOrder = ['😂','😢','🙏','🤔','💙'];
    for (const e of emojiOrder) reactionMap[e] = 0;
    for (const r of reactionStats.rows) reactionMap[r.emoji] = r.cnt;
    const totalReactions = Object.values(reactionMap).reduce((a, b) => a + b, 0);

    const geoMap = { grounds: 0, valley: 0, outside: 0 };
    for (const g of geoStats.rows) geoMap[g.geo_tier] = (geoMap[g.geo_tier] || 0) + g.cnt;

    res.json({
      posts: postStats.rows[0],
      reactions: reactionMap,
      total_reactions: totalReactions,
      top_tips: topTips.rows,
      unique_devices: deviceCount.rows[0].cnt,
      total_visits: totalVisits.rows[0].cnt,
      geo: geoMap,
      flagged_posts: flaggedPosts.rows,
      today_passphrase: passphraseWord,
      tomorrow_passphrase: tomorrowOverride.rows[0]?.word || null,
      today: today,
      tomorrow: tomorrow,
      email_destination: 'sat@sunshine.fm'
    });
  } catch (err) {
    console.error('[Admin dashboard]', err);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

// ---- API: Admin — Hide Post ----
app.post('/api/admin/posts/:id/hide', requireAdmin, async (req, res) => {
  const postId = parseInt(req.params.id);
  try {
    await pool.query('UPDATE posts SET admin_hidden = TRUE WHERE id = $1', [postId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to hide post' });
  }
});

// ---- API: Admin — Restore Post ----
app.post('/api/admin/posts/:id/restore', requireAdmin, async (req, res) => {
  const postId = parseInt(req.params.id);
  try {
    await pool.query('UPDATE posts SET admin_hidden = FALSE, flagged = FALSE, flag_count = 0 WHERE id = $1', [postId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to restore post' });
  }
});

// ---- API: Admin — Pin/Unpin Post (multi-feed ordered curation) ----
app.post('/api/admin/posts/:id/pin', requireAdmin, async (req, res) => {
  const postId = parseInt(req.params.id);
  try {
    const postResult = await pool.query('SELECT tab, pin_order FROM posts WHERE id = $1', [postId]);
    if (postResult.rowCount === 0) return res.status(404).json({ error: 'Post not found' });
    const post = postResult.rows[0];
    const currentlyPinned = post.pin_order !== null;

    if (currentlyPinned) {
      // Unpin: remove pin_order, close gap in remaining pins for this tab
      const unpinOrder = post.pin_order;
      await pool.query('UPDATE posts SET admin_pinned = FALSE, pin_order = NULL WHERE id = $1', [postId]);
      await pool.query(
        'UPDATE posts SET pin_order = pin_order - 1 WHERE tab = $1 AND pin_order IS NOT NULL AND pin_order > $2',
        [post.tab, unpinOrder]
      );
      console.log(`[Admin] Post ${postId} unpinned from ${post.tab}`);
      res.json({ success: true, admin_pinned: false, pin_order: null });
    } else {
      // Pin: assign next pin_order for this tab
      const maxResult = await pool.query(
        'SELECT COALESCE(MAX(pin_order), 0) AS max_order FROM posts WHERE tab = $1 AND pin_order IS NOT NULL',
        [post.tab]
      );
      const newOrder = maxResult.rows[0].max_order + 1;
      await pool.query('UPDATE posts SET admin_pinned = TRUE, pin_order = $1 WHERE id = $2', [newOrder, postId]);
      console.log(`[Admin] Post ${postId} pinned at position ${newOrder} in ${post.tab}`);
      res.json({ success: true, admin_pinned: true, pin_order: newOrder });
    }
  } catch (err) {
    console.error('[Admin] Pin post error:', err);
    res.status(500).json({ error: 'Failed to toggle pin' });
  }
});

// ---- API: Admin — Reorder Pinned Post (move up/down within feed) ----
app.post('/api/admin/posts/:id/pin-move', requireAdmin, async (req, res) => {
  const postId = parseInt(req.params.id);
  const { direction } = req.body; // 'up' or 'down'
  if (!['up', 'down'].includes(direction)) {
    return res.status(400).json({ error: 'direction must be up or down' });
  }
  try {
    const postResult = await pool.query('SELECT tab, pin_order FROM posts WHERE id = $1', [postId]);
    if (postResult.rowCount === 0) return res.status(404).json({ error: 'Post not found' });
    const post = postResult.rows[0];
    if (post.pin_order === null) return res.status(400).json({ error: 'Post is not pinned' });

    const currentOrder = post.pin_order;
    const targetOrder = direction === 'up' ? currentOrder - 1 : currentOrder + 1;

    // Find the post currently at the target position (same tab)
    const swapResult = await pool.query(
      'SELECT id FROM posts WHERE tab = $1 AND pin_order = $2',
      [post.tab, targetOrder]
    );
    if (swapResult.rowCount === 0) {
      return res.json({ success: true, moved: false, message: 'Already at limit' });
    }
    const swapId = swapResult.rows[0].id;

    // Swap pin_order values
    await pool.query('UPDATE posts SET pin_order = $1 WHERE id = $2', [targetOrder, postId]);
    await pool.query('UPDATE posts SET pin_order = $1 WHERE id = $2', [currentOrder, swapId]);

    console.log(`[Admin] Post ${postId} moved ${direction} (${currentOrder} ↔ ${targetOrder})`);
    res.json({ success: true, moved: true, new_order: targetOrder });
  } catch (err) {
    console.error('[Admin] Pin move error:', err);
    res.status(500).json({ error: 'Failed to move pin' });
  }
});

// ---- API: Admin — Feed Posts for Curation Panel ----
app.get('/api/admin/feed-posts/:tab', requireAdmin, async (req, res) => {
  const { tab } = req.params;
  const validTabs = ['moments', 'tips', 'pulse'];
  if (!validTabs.includes(tab)) return res.status(400).json({ error: 'Invalid tab' });
  try {
    // Pinned posts ordered by pin_order
    const pinnedResult = await pool.query(`
      SELECT p.id, p.text, p.nickname, p.tab, p.created_at, p.pin_order,
             COALESCE((SELECT COUNT(*)::int FROM reactions WHERE post_id = p.id AND emoji = '🩵'), 0) AS hearts
      FROM posts p
      WHERE p.tab = $1 AND p.pin_order IS NOT NULL AND p.admin_hidden IS NOT TRUE
      ORDER BY p.pin_order ASC
    `, [tab]);

    // Top non-pinned posts (most recent / most hearted)
    const orderClause = tab === 'tips'
      ? 'ORDER BY hearts DESC, p.created_at DESC'
      : 'ORDER BY p.created_at DESC';

    const topResult = await pool.query(`
      SELECT p.id, p.text, p.nickname, p.tab, p.created_at, p.pin_order,
             COALESCE((SELECT COUNT(*)::int FROM reactions WHERE post_id = p.id AND emoji = '🩵'), 0) AS hearts
      FROM posts p
      WHERE p.tab = $1 AND p.pin_order IS NULL
        AND p.flagged = FALSE AND p.admin_hidden IS NOT TRUE
        AND p.session_id != 'SYSTEM'
        AND DATE(p.created_at AT TIME ZONE 'America/Los_Angeles') >= $2
      ${orderClause}
      LIMIT 30
    `, [tab, ANALYTICS_START_DATE]);

    res.json({ success: true, pinned: pinnedResult.rows, top: topResult.rows });
  } catch (err) {
    console.error('[Admin] Feed posts error:', err);
    res.status(500).json({ error: 'Failed to load feed posts' });
  }
});

// ---- API: Admin — Delete Post (hard delete) ----
app.delete('/api/admin/posts/:id', requireAdmin, async (req, res) => {
  const postId = parseInt(req.params.id);
  try {
    await pool.query('DELETE FROM posts WHERE id = $1', [postId]);
    res.json({ success: true });
  } catch (err) {
    console.error('[Admin] Delete post error:', err);
    res.status(500).json({ error: 'Failed to delete post' });
  }
});

// ---- API: Admin — Block IP (24h default, configurable) ----
app.post('/api/admin/block-ip', requireAdmin, async (req, res) => {
  const { ip, hours = 24, reason = '' } = req.body;
  if (!ip || typeof ip !== 'string' || ip.length > 64) {
    return res.status(400).json({ error: 'Invalid IP' });
  }
  try {
    const blockedUntil = new Date(Date.now() + hours * 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO ip_blocks (ip, blocked_until, reason)
       VALUES ($1, $2, $3)
       ON CONFLICT (ip) DO UPDATE SET blocked_until = EXCLUDED.blocked_until, reason = EXCLUDED.reason`,
      [ip, blockedUntil.toISOString(), reason || null]
    );
    // Update in-memory cache immediately
    blockedIPs.set(ip, blockedUntil.getTime());
    console.log(`[Moderation] Admin blocked IP ${ip} until ${blockedUntil.toISOString()}`);
    res.json({ success: true, blocked_until: blockedUntil.toISOString() });
  } catch (err) {
    console.error('[Admin] Block IP error:', err);
    res.status(500).json({ error: 'Failed to block IP' });
  }
});

// ---- API: Admin — Unblock IP ----
app.delete('/api/admin/block-ip/:ip', requireAdmin, async (req, res) => {
  const ip = decodeURIComponent(req.params.ip);
  try {
    await pool.query('DELETE FROM ip_blocks WHERE ip = $1', [ip]);
    blockedIPs.delete(ip);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to unblock IP' });
  }
});

// ---- API: Admin — List Blocked IPs ----
app.get('/api/admin/blocked-ips', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ip, blocked_until, reason, created_at
       FROM ip_blocks WHERE blocked_until > NOW()
       ORDER BY created_at DESC`
    );
    res.json({ blocks: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch blocked IPs' });
  }
});

// ---- API: Admin — All Posts (paginated, for full moderation view) ----
app.get('/api/admin/all-posts', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const filter = req.query.filter; // 'flagged' | 'hidden' | 'all'

    let whereClause = "WHERE p.session_id != 'SYSTEM'";
    if (filter === 'flagged') {
      whereClause += ' AND (p.flag_count >= 3 OR p.flagged = TRUE OR p.admin_hidden = TRUE)';
    } else if (filter === 'hidden') {
      whereClause += ' AND p.admin_hidden = TRUE';
    }

    const [posts, total] = await Promise.all([
      pool.query(`
        SELECT p.id, p.nickname, p.text, p.tab, p.geo_tier, p.created_at,
               p.flag_count, p.flagged, p.admin_hidden, p.photo_url,
               (SELECT COUNT(*) FROM post_flags pf WHERE pf.post_id = p.id)::int AS distinct_flags
        FROM posts p
        ${whereClause}
        ORDER BY p.created_at DESC
        LIMIT $1 OFFSET $2
      `, [limit, offset]),
      pool.query(`SELECT COUNT(*)::int AS cnt FROM posts p ${whereClause}`)
    ]);
    res.json({ posts: posts.rows, total: total.rows[0].cnt, limit, offset });
  } catch (err) {
    console.error('[Admin] all-posts error:', err);
    res.status(500).json({ error: 'Failed to fetch posts' });
  }
});

// ---- API: Moderation Policy (public) ----
app.get('/api/moderation-policy', (req, res) => {
  res.json({
    policy: 'Mirage is a temporary social layer for festival season in Coachella Valley. Keep it human. No hate, harassment, threats, doxxing, scams, spam, or sexual exploitation. Casual profanity is fine; targeted abuse is not. Posts may be hidden or removed at any time.',
    version: '1.0',
    effective: '2026-04-01'
  });
});

// ---- API: Admin — Trigger Data Export ----
app.post('/api/admin/export', requireAdmin, async (req, res) => {
  try {
    const data = await runDataExport();
    const exportedAt = new Date().toISOString();
    res.json({ success: true, exported_at: exportedAt, data });
  } catch (err) {
    res.status(500).json({ error: 'Export failed: ' + err.message });
  }
});

// ---- API: Admin — Trigger Daily Email Now ----
app.post('/api/admin/email/send-now', requireAdmin, async (req, res) => {
  try {
    await sendDailySummaryEmail();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Email failed: ' + err.message });
  }
});

// ---- API: Admin — Live Pulse Posts (Good Tips — permanent, no TTL) ----
app.get('/api/admin/live-pulse', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, nickname, text, geo_tier, created_at
      FROM posts
      WHERE tab = 'pulse'
        AND session_id != 'SYSTEM'
        AND admin_hidden IS NOT TRUE
      ORDER BY created_at DESC
      LIMIT 200
    `);
    res.json({ posts: result.rows });
  } catch (err) {
    console.error('[Admin live-pulse]', err);
    res.status(500).json({ error: 'Failed to fetch live pulse posts' });
  }
});

// ---- API: Admin — Hourly Activity ----
app.get('/api/admin/hourly-activity', requireAdmin, async (req, res) => {
  try {
    const date = req.query.date || getTodayInPT();
    const result = await pool.query(`
      SELECT
        EXTRACT(hour FROM created_at AT TIME ZONE 'America/Los_Angeles')::int AS hour,
        tab,
        COUNT(*)::int AS cnt
      FROM posts
      WHERE DATE(created_at AT TIME ZONE 'America/Los_Angeles') = $1
        AND session_id != 'SYSTEM'
        AND admin_hidden IS NOT TRUE
      GROUP BY hour, tab
      ORDER BY hour, tab
    `, [date]);

    // Build hour buckets 0-23
    const buckets = {};
    for (let h = 0; h < 24; h++) {
      buckets[h] = { moments: 0, tips: 0, pulse: 0 };
    }
    for (const row of result.rows) {
      if (buckets[row.hour]) {
        buckets[row.hour][row.tab] = (buckets[row.hour][row.tab] || 0) + row.cnt;
      }
    }

    res.json({ date, buckets });
  } catch (err) {
    console.error('[Admin hourly-activity]', err);
    res.status(500).json({ error: 'Failed to fetch hourly activity' });
  }
});

// ---- API: Admin — Pulse Log (all pulse posts including expired) ----
app.get('/api/admin/pulse-log', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, nickname, text, geo_tier, created_at,
             (created_at + INTERVAL '60 minutes') AS expires_at,
             CASE WHEN created_at + INTERVAL '60 minutes' < NOW() THEN true ELSE false END AS expired
      FROM posts
      WHERE tab = 'pulse'
        AND session_id != 'SYSTEM'
      ORDER BY created_at DESC
      LIMIT 500
    `);
    res.json({ posts: result.rows });
  } catch (err) {
    console.error('[Admin pulse-log]', err);
    res.status(500).json({ error: 'Failed to fetch pulse log' });
  }
});

// ---- API: Admin — Export Data as CSV (direct download) ----
app.get('/api/admin/export.csv', requireAdmin, async (req, res) => {
  try {
    const [allPosts, reactionsByPost, geoStats, hourlyData, pulseLog, uniqueDevices] = await Promise.all([
      pool.query(`
        SELECT id, tab, nickname, text, geo_tier, created_at, photo_url
        FROM posts
        WHERE session_id != 'SYSTEM' AND admin_hidden IS NOT TRUE
          AND DATE(created_at AT TIME ZONE 'America/Los_Angeles') >= $1
        ORDER BY created_at
      `, [ANALYTICS_START_DATE]),
      pool.query(`
        SELECT r.post_id, r.emoji, COUNT(*)::int AS cnt
        FROM reactions r
        JOIN posts p ON r.post_id = p.id
        WHERE p.session_id != 'SYSTEM' AND p.admin_hidden IS NOT TRUE
          AND DATE(p.created_at AT TIME ZONE 'America/Los_Angeles') >= $1
        GROUP BY r.post_id, r.emoji
        ORDER BY r.post_id, r.emoji
      `, [ANALYTICS_START_DATE]),
      pool.query(`
        SELECT geo_tier, COUNT(*)::int AS cnt
        FROM posts WHERE session_id != 'SYSTEM' AND admin_hidden IS NOT TRUE
          AND DATE(created_at AT TIME ZONE 'America/Los_Angeles') >= $1
        GROUP BY geo_tier
      `, [ANALYTICS_START_DATE]),
      pool.query(`
        SELECT
          DATE(created_at AT TIME ZONE 'America/Los_Angeles') AS day,
          EXTRACT(hour FROM created_at AT TIME ZONE 'America/Los_Angeles')::int AS hour,
          tab,
          COUNT(*)::int AS cnt
        FROM posts
        WHERE session_id != 'SYSTEM' AND admin_hidden IS NOT TRUE
          AND DATE(created_at AT TIME ZONE 'America/Los_Angeles') >= $1
        GROUP BY day, hour, tab
        ORDER BY day, hour, tab
      `, [ANALYTICS_START_DATE]),
      pool.query(`
        SELECT id, nickname, text, geo_tier, created_at,
               (created_at + INTERVAL '60 minutes') AS expires_at
        FROM posts
        WHERE tab = 'pulse' AND session_id != 'SYSTEM'
          AND DATE(created_at AT TIME ZONE 'America/Los_Angeles') >= $1
        ORDER BY created_at DESC
      `, [ANALYTICS_START_DATE]),
      pool.query(`
        SELECT COUNT(DISTINCT device_id)::int AS cnt FROM (
          SELECT device_id FROM page_views WHERE DATE(created_at AT TIME ZONE 'America/Los_Angeles') >= $1
          UNION
          SELECT session_id AS device_id FROM sessions WHERE DATE(registered_at AT TIME ZONE 'America/Los_Angeles') >= $1
        ) sub
      `, [ANALYTICS_START_DATE])
    ]);

    const lines = [];
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

    // Section 1: Summary
    lines.push('# MIRAGE EXPORT — ' + ts);
    lines.push('');
    lines.push('## SUMMARY');
    lines.push('metric,value');
    const moments = allPosts.rows.filter(p => p.tab === 'moments').length;
    const tips = allPosts.rows.filter(p => p.tab === 'tips').length;
    const pulse = allPosts.rows.filter(p => p.tab === 'pulse').length;
    lines.push(`total_posts,${allPosts.rows.length}`);
    lines.push(`moments,${moments}`);
    lines.push(`tips,${tips}`);
    lines.push(`pulse_total,${pulse}`);
    lines.push(`unique_devices,${uniqueDevices.rows[0]?.cnt || 0}`);
    for (const g of geoStats.rows) {
      lines.push(`geo_${g.geo_tier},${g.cnt}`);
    }
    lines.push('');

    // Section 2: All posts
    lines.push('## ALL POSTS');
    lines.push('id,tab,nickname,text,geo_tier,created_at,photo_url');
    for (const p of allPosts.rows) {
      const text = (p.text || '').replace(/"/g, '""');
      const photo = p.photo_url || '';
      const nick = (p.nickname || '').replace(/"/g, '""');
      lines.push(`${p.id},${p.tab},"${nick}","${text}",${p.geo_tier},${p.created_at.toISOString()},${photo}`);
    }
    lines.push('');

    // Section 3: Reactions by post
    lines.push('## REACTIONS BY POST');
    lines.push('post_id,emoji,count');
    for (const r of reactionsByPost.rows) {
      lines.push(`${r.post_id},${r.emoji},${r.cnt}`);
    }
    lines.push('');

    // Section 4: Hourly activity
    lines.push('## HOURLY ACTIVITY');
    lines.push('date,hour,tab,count');
    for (const h of hourlyData.rows) {
      lines.push(`${h.day},${h.hour},${h.tab},${h.cnt}`);
    }
    lines.push('');

    // Section 5: Pulse log
    lines.push('## PULSE LOG');
    lines.push('id,nickname,text,geo_tier,posted_at,expires_at');
    for (const p of pulseLog.rows) {
      const text = (p.text || '').replace(/"/g, '""');
      const nick = (p.nickname || '').replace(/"/g, '""');
      lines.push(`${p.id},"${nick}","${text}",${p.geo_tier},${p.created_at.toISOString()},${p.expires_at.toISOString()}`);
    }
    lines.push('');

    const csvContent = lines.join('\n');
    const filename = `mirage-export-${ts}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-cache');
    res.send(csvContent);
  } catch (err) {
    console.error('[Export CSV]', err);
    res.status(500).json({ error: 'Export failed: ' + err.message });
  }
});

// ---- API: Admin — Export JSON ----
app.get('/api/admin/export.json', requireAdmin, async (req, res) => {
  try {
    const [allPosts, reactionsByPost, geoStats, hourlyData, pulseLog, uniqueDevices] = await Promise.all([
      pool.query(`SELECT id, tab, nickname, text, geo_tier, created_at, photo_url FROM posts WHERE session_id != 'SYSTEM' AND admin_hidden IS NOT TRUE AND DATE(created_at AT TIME ZONE 'America/Los_Angeles') >= $1 ORDER BY created_at`, [ANALYTICS_START_DATE]),
      pool.query(`SELECT r.post_id, r.emoji, COUNT(*)::int AS cnt FROM reactions r JOIN posts p ON r.post_id = p.id WHERE p.session_id != 'SYSTEM' AND p.admin_hidden IS NOT TRUE AND DATE(p.created_at AT TIME ZONE 'America/Los_Angeles') >= $1 GROUP BY r.post_id, r.emoji ORDER BY r.post_id, r.emoji`, [ANALYTICS_START_DATE]),
      pool.query(`SELECT geo_tier, COUNT(*)::int AS cnt FROM posts WHERE session_id != 'SYSTEM' AND admin_hidden IS NOT TRUE AND DATE(created_at AT TIME ZONE 'America/Los_Angeles') >= $1 GROUP BY geo_tier`, [ANALYTICS_START_DATE]),
      pool.query(`SELECT DATE(created_at AT TIME ZONE 'America/Los_Angeles') AS day, EXTRACT(hour FROM created_at AT TIME ZONE 'America/Los_Angeles')::int AS hour, tab, COUNT(*)::int AS cnt FROM posts WHERE session_id != 'SYSTEM' AND admin_hidden IS NOT TRUE AND DATE(created_at AT TIME ZONE 'America/Los_Angeles') >= $1 GROUP BY day, hour, tab ORDER BY day, hour, tab`, [ANALYTICS_START_DATE]),
      pool.query(`SELECT id, nickname, text, geo_tier, created_at, (created_at + INTERVAL '60 minutes') AS expires_at FROM posts WHERE tab = 'pulse' AND session_id != 'SYSTEM' AND DATE(created_at AT TIME ZONE 'America/Los_Angeles') >= $1 ORDER BY created_at DESC`, [ANALYTICS_START_DATE]),
      pool.query(`SELECT COUNT(DISTINCT device_id)::int AS cnt FROM (SELECT device_id FROM page_views WHERE DATE(created_at AT TIME ZONE 'America/Los_Angeles') >= $1 UNION SELECT session_id AS device_id FROM sessions WHERE DATE(registered_at AT TIME ZONE 'America/Los_Angeles') >= $1) sub`, [ANALYTICS_START_DATE])
    ]);

    const ts = new Date().toISOString();

    // Build reactions map per post
    const reactionsMap = {};
    for (const r of reactionsByPost.rows) {
      if (!reactionsMap[r.post_id]) reactionsMap[r.post_id] = {};
      reactionsMap[r.post_id][r.emoji] = r.cnt;
    }

    // Build geo map
    const geoMap = {};
    for (const g of geoStats.rows) geoMap[g.geo_tier] = g.cnt;

    const exportData = {
      exported_at: ts,
      summary: {
        total_posts: allPosts.rows.length,
        moments: allPosts.rows.filter(p => p.tab === 'moments').length,
        tips: allPosts.rows.filter(p => p.tab === 'tips').length,
        pulse: allPosts.rows.filter(p => p.tab === 'pulse').length,
        unique_devices: uniqueDevices.rows[0]?.cnt || 0,
        geo_split: geoMap
      },
      posts: allPosts.rows.map(p => ({
        id: p.id,
        feed: p.tab,
        nickname: p.nickname,
        text: p.text,
        geo_tier: p.geo_tier,
        timestamp: p.created_at,
        photo_url: p.photo_url || null,
        reactions: reactionsMap[p.id] || {}
      })),
      reactions_by_post: reactionsByPost.rows,
      geo_split: geoStats.rows,
      hourly_activity: hourlyData.rows,
      pulse_log: pulseLog.rows.map(p => ({
        id: p.id,
        nickname: p.nickname,
        text: p.text,
        geo_tier: p.geo_tier,
        posted_at: p.created_at,
        expires_at: p.expires_at
      }))
    };

    const tsFilename = ts.replace(/[:.]/g, '-').slice(0, 19);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="mirage-export-${tsFilename}.json"`);
    res.setHeader('Cache-Control', 'no-cache');
    res.send(JSON.stringify(exportData, null, 2));
  } catch (err) {
    console.error('[Export JSON]', err);
    res.status(500).json({ error: 'Export failed: ' + err.message });
  }
});

// ---- API: Admin — Export Markdown ----
app.get('/api/admin/export.md', requireAdmin, async (req, res) => {
  try {
    const [allPosts, reactionsByPost, geoStats, hourlyData, pulseLog, uniqueDevices] = await Promise.all([
      pool.query(`SELECT id, tab, nickname, text, geo_tier, created_at, photo_url FROM posts WHERE session_id != 'SYSTEM' AND admin_hidden IS NOT TRUE AND DATE(created_at AT TIME ZONE 'America/Los_Angeles') >= $1 ORDER BY created_at`, [ANALYTICS_START_DATE]),
      pool.query(`SELECT r.post_id, r.emoji, COUNT(*)::int AS cnt FROM reactions r JOIN posts p ON r.post_id = p.id WHERE p.session_id != 'SYSTEM' AND p.admin_hidden IS NOT TRUE AND DATE(p.created_at AT TIME ZONE 'America/Los_Angeles') >= $1 GROUP BY r.post_id, r.emoji ORDER BY r.post_id, r.emoji`, [ANALYTICS_START_DATE]),
      pool.query(`SELECT geo_tier, COUNT(*)::int AS cnt FROM posts WHERE session_id != 'SYSTEM' AND admin_hidden IS NOT TRUE AND DATE(created_at AT TIME ZONE 'America/Los_Angeles') >= $1 GROUP BY geo_tier`, [ANALYTICS_START_DATE]),
      pool.query(`SELECT DATE(created_at AT TIME ZONE 'America/Los_Angeles') AS day, EXTRACT(hour FROM created_at AT TIME ZONE 'America/Los_Angeles')::int AS hour, tab, COUNT(*)::int AS cnt FROM posts WHERE session_id != 'SYSTEM' AND admin_hidden IS NOT TRUE AND DATE(created_at AT TIME ZONE 'America/Los_Angeles') >= $1 GROUP BY day, hour, tab ORDER BY day, hour, tab`, [ANALYTICS_START_DATE]),
      pool.query(`SELECT id, nickname, text, geo_tier, created_at, (created_at + INTERVAL '60 minutes') AS expires_at FROM posts WHERE tab = 'pulse' AND session_id != 'SYSTEM' AND DATE(created_at AT TIME ZONE 'America/Los_Angeles') >= $1 ORDER BY created_at DESC`, [ANALYTICS_START_DATE]),
      pool.query(`SELECT COUNT(DISTINCT device_id)::int AS cnt FROM (SELECT device_id FROM page_views WHERE DATE(created_at AT TIME ZONE 'America/Los_Angeles') >= $1 UNION SELECT session_id AS device_id FROM sessions WHERE DATE(registered_at AT TIME ZONE 'America/Los_Angeles') >= $1) sub`, [ANALYTICS_START_DATE])
    ]);

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const now = new Date().toISOString();

    // Build reactions map per post
    const reactionsMap = {};
    for (const r of reactionsByPost.rows) {
      if (!reactionsMap[r.post_id]) reactionsMap[r.post_id] = {};
      reactionsMap[r.post_id][r.emoji] = r.cnt;
    }
    const geoMap = {};
    for (const g of geoStats.rows) geoMap[g.geo_tier] = g.cnt;

    const moments = allPosts.rows.filter(p => p.tab === 'moments');
    const tips = allPosts.rows.filter(p => p.tab === 'tips');
    const pulseAll = allPosts.rows.filter(p => p.tab === 'pulse');

    const lines = [];
    lines.push(`# Mirage Export`);
    lines.push(`**Exported:** ${now}  `);
    lines.push('');

    // Summary
    lines.push('## Summary');
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Total Posts | ${allPosts.rows.length} |`);
    lines.push(`| Good Shots | ${moments.length} |`);
    lines.push(`| Good Vibes | ${tips.length} |`);
    lines.push(`| Good Tips | ${pulseAll.length} |`);
    lines.push(`| Unique Devices | ${uniqueDevices.rows[0]?.cnt || 0} |`);
    lines.push(`| At the Fest (grounds) | ${geoMap['grounds'] || 0} |`);
    lines.push(`| In the Desert (valley) | ${geoMap['valley'] || 0} |`);
    lines.push(`| Watching from Elsewhere | ${geoMap['outside'] || 0} |`);
    lines.push('');

    // Reactions totals
    const reactionTotals = {};
    for (const r of reactionsByPost.rows) {
      reactionTotals[r.emoji] = (reactionTotals[r.emoji] || 0) + r.cnt;
    }
    if (Object.keys(reactionTotals).length > 0) {
      lines.push('## Reaction Counts');
      lines.push('| Emoji | Count |');
      lines.push('|-------|-------|');
      for (const [emoji, cnt] of Object.entries(reactionTotals).sort((a, b) => b[1] - a[1])) {
        lines.push(`| ${emoji} | ${cnt} |`);
      }
      lines.push('');
    }

    // Geo split
    lines.push('## Geo Split');
    lines.push('| Location | Posts |');
    lines.push('|----------|-------|');
    for (const g of geoStats.rows) lines.push(`| ${g.geo_tier} | ${g.cnt} |`);
    lines.push('');

    // Hourly activity
    lines.push('## Hourly Activity');
    lines.push('| Date | Hour | Feed | Count |');
    lines.push('|------|------|------|-------|');
    for (const h of hourlyData.rows) lines.push(`| ${h.day} | ${h.hour}:00 | ${h.tab} | ${h.cnt} |`);
    lines.push('');

    // Posts by feed
    for (const [feedName, feedPosts] of [['Good Shots', moments], ['Good Vibes', tips], ['Good Tips', pulseAll]]) {
      lines.push(`## Posts — ${feedName}`);
      if (feedPosts.length === 0) {
        lines.push('*No posts*');
      } else {
        lines.push('| ID | Nickname | Text | Geo | Posted | Reactions |');
        lines.push('|----|----------|------|-----|--------|-----------|');
        for (const p of feedPosts) {
          const text = (p.text || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
          const nick = (p.nickname || '').replace(/\|/g, '\\|');
          const rxns = Object.entries(reactionsMap[p.id] || {}).map(([e, c]) => `${e}${c}`).join(' ');
          lines.push(`| ${p.id} | ${nick} | ${text} | ${p.geo_tier} | ${p.created_at.toISOString()} | ${rxns || '—'} |`);
        }
      }
      lines.push('');
    }

    // Good Tips log (permanent — no expiry)
    lines.push('## Good Tips Log');
    if (pulseLog.rows.length === 0) {
      lines.push('*No good tips posts*');
    } else {
      lines.push('| ID | Nickname | Text | Geo | Posted |');
      lines.push('|----|----------|------|-----|--------|');
      for (const p of pulseLog.rows) {
        const text = (p.text || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
        const nick = (p.nickname || '').replace(/\|/g, '\\|');
        lines.push(`| ${p.id} | ${nick} | ${text} | ${p.geo_tier} | ${p.created_at.toISOString()} |`);
      }
    }
    lines.push('');

    const mdContent = lines.join('\n');
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="mirage-export-${ts}.md"`);
    res.setHeader('Cache-Control', 'no-cache');
    res.send(mdContent);
  } catch (err) {
    console.error('[Export MD]', err);
    res.status(500).json({ error: 'Export failed: ' + err.message });
  }
});

// ---- API: Upload Photo ----
app.post('/api/upload', upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Image moderation: check before storing (explicit content, CSAM, graphic violence, hate symbols)
    const imgMod = await moderateImageWithAI(req.file.buffer, req.file.mimetype);
    if (!imgMod.safe) {
      return res.status(422).json({
        error: 'This image could not be uploaded.',
        preserve_text: true  // hint to frontend: keep the text draft, just clear the image
      });
    }

    const API_KEY = process.env.POLSIA_API_KEY;
    const ext = (req.file.mimetype.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
    const uniqueName = `desertdrop/${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;

    // Upload via R2 proxy (canonical pattern — node-fetch v2 + form-data required)
    const formData = new FormData();
    formData.append('file', req.file.buffer, {
      filename: uniqueName,
      contentType: req.file.mimetype,
    });

    const r2Response = await nodeFetch('https://polsia.com/api/proxy/r2/upload', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        ...formData.getHeaders(), // CRITICAL: includes Content-Type with multipart boundary
      },
      body: formData,
    });

    const data = await r2Response.json();
    if (!data.success) {
      console.error('R2 upload failed:', r2Response.status, data);
      return res.status(502).json({ error: 'File upload failed' });
    }
    res.json({ url: data.file.url });

  } catch (err) {
    console.error('Error uploading photo:', err);
    res.status(500).json({ error: 'Failed to upload photo' });
  }
});

// ---- API: Today's Passphrase ----
app.get('/api/passphrase/today', async (req, res) => {
  try {
    const word = await getTodayPassphrase();
    res.json({ word });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get passphrase' });
  }
});

// ---- API: Admin — Set Passphrase Override ----
app.post('/api/admin/passphrase', async (req, res) => {
  const adminToken = req.headers['x-admin-token'];
  if (!adminToken || adminToken !== process.env.ADMIN_TOKEN) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { date, word } = req.body;
  if (!date || !word) {
    return res.status(400).json({ error: 'date and word required' });
  }
  try {
    await pool.query(
      `INSERT INTO passphrase_overrides (date, word) VALUES ($1, $2)
       ON CONFLICT (date) DO UPDATE SET word = EXCLUDED.word`,
      [date, word.trim().toLowerCase()]
    );
    // Reset cache so next system post uses new word
    lastPassphrasePostDate = null;
    res.json({ success: true, date, word: word.trim().toLowerCase() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to set passphrase' });
  }
});

// ---- API: Stats ----
app.get('/api/stats', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE tab = 'moments')::int as moments,
        COUNT(*) FILTER (WHERE tab = 'tips')::int as tips,
        COUNT(*) FILTER (WHERE tab = 'pulse')::int as pulse,
        COUNT(*)::int as total
      FROM posts WHERE flagged = FALSE
    `);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching stats:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ---- API: Get user's reactions for a set of posts ----
app.post('/api/my-reactions', async (req, res) => {
  try {
    const { session_id, post_ids } = req.body;
    if (!session_id || !post_ids || !post_ids.length) {
      return res.json({ reactions: {} });
    }

    const result = await pool.query(
      `SELECT post_id, emoji FROM reactions WHERE session_id = $1 AND post_id = ANY($2)`,
      [session_id, post_ids]
    );

    const map = {};
    for (const row of result.rows) {
      if (!map[row.post_id]) map[row.post_id] = [];
      map[row.post_id].push(row.emoji);
    }
    res.json({ reactions: map });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch reactions' });
  }
});

// ---- API: Check if session has flagged a post ----
app.post('/api/my-flags', async (req, res) => {
  try {
    const { session_id, post_ids } = req.body;
    if (!session_id || !post_ids || !post_ids.length) {
      return res.json({ flags: [] });
    }
    const result = await pool.query(
      'SELECT post_id FROM post_flags WHERE session_id = $1 AND post_id = ANY($2)',
      [session_id, post_ids]
    );
    res.json({ flags: result.rows.map(r => r.post_id) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch flags' });
  }
});

// ---- SSE: Real-time post events ----
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
  res.flushHeaders();

  // Send initial ping
  res.write('data: {"type":"connected"}\n\n');

  const client = { res, tab: req.query.tab };
  sseClients.add(client);

  // Keepalive ping every 25 seconds
  const ping = setInterval(() => {
    try {
      res.write('data: {"type":"ping"}\n\n');
    } catch (e) {
      clearInterval(ping);
      sseClients.delete(client);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(client);
  });
});

// ---- OG Social Card ----
app.get('/og-card.png', (req, res) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
    <defs>
      <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#0369A1"/>
        <stop offset="50%" stop-color="#0EA5E9"/>
        <stop offset="100%" stop-color="#7DD3FC"/>
      </linearGradient>
      <style>
        @import url('https://fonts.googleapis.com/css2?family=Righteous');
      </style>
    </defs>
    <rect width="1200" height="630" fill="url(#sky)"/>
    <rect x="0" y="460" width="1200" height="170" fill="rgba(255,255,255,0.08)"/>
    <circle cx="900" cy="200" r="180" fill="rgba(255,255,255,0.04)"/>
    <circle cx="900" cy="200" r="120" fill="rgba(255,255,255,0.04)"/>
    <circle cx="900" cy="200" r="60" fill="rgba(255,255,255,0.06)"/>
    <text x="100" y="230" font-family="Georgia, serif" font-size="140" font-weight="400" fill="white" letter-spacing="4" opacity="0.97">mirage</text>
    <text x="100" y="310" font-family="Arial, sans-serif" font-size="34" font-weight="600" fill="rgba(255,255,255,0.9)">a pop-up social network for festival season</text>
    <text x="100" y="370" font-family="Georgia, serif" font-size="30" fill="rgba(255,255,255,0.75)">appears april 1. disappears may 1.</text>
    <rect x="100" y="410" width="220" height="4" rx="2" fill="rgba(245,158,11,0.8)"/>
    <text x="100" y="550" font-family="Arial, sans-serif" font-size="26" fill="rgba(255,255,255,0.6)">mirage.sunshine.fm</text>
    <circle cx="1080" cy="560" r="8" fill="#4ADE80" opacity="0.9"/>
    <text x="1100" y="566" font-family="Arial, sans-serif" font-size="22" fill="rgba(255,255,255,0.7)">live now</text>
  </svg>`;
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(svg);
});

// ---- Case Study (canonical, server-rendered; aliases /case-study and /case-study.html to season1.html) ----
app.get('/case-study', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'season1.html'));
});
app.get('/case-study.html', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'season1.html'));
});
app.get('/mirage', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'season1.html'));
});

// ---- Sitemap (Static — post-shutdown surface is small and known) ----
app.get('/sitemap.xml', (req, res) => {
  const base = 'https://mirage.sunshine.fm';
  const urls = [
    { loc: `${base}/`,                 changefreq: 'yearly',  priority: '1.0'  },
    { loc: `${base}/case-study`,       changefreq: 'monthly', priority: '0.95' },
    { loc: `${base}/case-study.html`,  changefreq: 'monthly', priority: '0.95' },
    { loc: `${base}/mirage`,           changefreq: 'monthly', priority: '0.9'  },
    { loc: `${base}/season1.html`,     changefreq: 'yearly',  priority: '0.9'  },
    { loc: `${base}/eat`,              changefreq: 'weekly',  priority: '0.9'  },
    { loc: `${base}/series`,           changefreq: 'monthly', priority: '0.9'  },
    { loc: `${base}/sponsors`,         changefreq: 'monthly', priority: '0.9'  },
    { loc: `${base}/farewell`,         changefreq: 'yearly',  priority: '0.8'  },
    { loc: `${base}/presentation.html`, changefreq: 'yearly', priority: '0.7'  },
  ];
  res.setHeader('Content-Type', 'application/xml');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url><loc>${u.loc}</loc><changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority></url>`).join('\n')}
</urlset>`);
});

// ---- LLMs.txt (llms.txt convention — plain-text summary for AI crawlers) ----
app.get('/llms.txt', (req, res) => {
  const body = `# Mirage — SunshineFM (Case Study)
> Mirage is an ongoing case study of local AI in the Coachella Valley, anchored on a 30-day Season 1 build (Apr 1 – May 1, 2026). The Shut-down dispatched on May 1, but the project continues as documented evidence and canonical case-study material.

Status: ongoing
Last reviewed: 2026-07-31

## What this is
Mirage is a SunshineFM project that ran a 30-day, geo-fenced, anonymous social network for festival season in the Coachella Valley. The Season 1 build is the documented evidence foundation; the project continues past May 1, 2026 as an ongoing case study and research artifact for temporary social infrastructure and AI-assisted local product builds.

The /case-study page is the canonical, server-rendered case-study entry point and currently mirrors the full Season 1 wrap-up archive (/season1.html). /presentation.html is an 18-slide conference-style deck summarizing the experiment. /farewell is the post-shutdown poetic landing page served at / during the grace period.

## About
- Brand: Mirage, a SunshineFM experiment
- Operator: SunshineFM (Coachella Valley radio)
- Anchor window: 2026-04-01 to 2026-05-01 (Season 1)
- Project status: ongoing case study (continues past May 1, 2026 as documented evidence)
- Stack: Node.js + Express + PostgreSQL (Neon), hosted on Render
- Pages:
  - /case-study — canonical case-study entry point (server-rendered)
  - /case-study.html — explicit .html alias of the case study
  - /mirage — brand-path alias of the case study (serves the same Season 1 archive)
  - /season1.html — Season 1 wrap-up archive (the underlying evidence)
  - /presentation.html — 18-slide conference-style deck
  - /eat — Restaurant Week microsite: 126 restaurants across 9 Coachella Valley cities, sourced from the DineGPS dataset; filterable by city / cuisine / price; per-card Schema.org Restaurant + Menu JSON-LD
  - /series — Coachella Valley Vertical Video Series sponsor-pitch microsite (pilot + 10 episodes), four-tier breakdown $2,000 – $10,000 per episode with a 30–50% CPM-uplift brand-integration wedge; lead-form intake at /api/series/lead backing the series_leads table
  - /sponsors — sponsor rate-card landing for cold outreach to the 2027 season's top-three sponsors (distinct from /series): Mirage Season 1 proof tiles (30 days live, 363 unique devices, $329 total spend) + dual-tier rate card (Episode Sponsor $2,000–$10,000/episode, Brand Integration / IAP $10,000+ per episode) with the 30–50% CPM-uplift wedge; mailto: CTA only — no DB write on render
  - /farewell — poetic farewell landing page
  - / — current landing (serves /farewell during the post-shutdown grace period)
- Non-public: /app (post-creation UI, dormant), /mirage/signal (admin, gated), /archive/internal (operational appendix, robots noindex)

## Restaurant Week (/eat)
- Dataset: 126 restaurants sourced from the DineGPS dataset (data/restaurants.json), seeded into the 'restaurants' table by migrations/018_restaurant_week_seed.js.
- Coverage: 9 Coachella Valley cities — Palm Springs, Palm Desert, Indian Wells, La Quinta, Indio, Rancho Mirage, Cathedral City, Coachella, Desert Hot Springs.
- Offer window: June 1 – June 14, 2026 (every row with an offer has the matching availabilityStarts/availabilityEnds/validFrom dates).
- Rendering model: server-rendered HTML (no client-side fetch). All 126 cards are present in the initial response — the page is fully crawlable without JS. Client-side filtering (by city / cuisine / price) is a progressive enhancement that does not require a network round trip.
- Structured data: one <script type="application/ld+json"> block per page, with @context: https://schema.org and a @graph array of 126 Restaurant nodes. Each node carries 'name', 'address' (PostalAddress with addressRegion:CA, addressCountry:US), 'servesCuisine', 'priceRange', an '@id' of form https://mirage.sunshine.fm/eat/card/<slug>, and (when the row has an offer) a 'hasMenu' tree with 'Menu' → 'MenuSection' → 'MenuItem' → 'Offer' (priceCurrency:USD, validFrom:2026-06-01, availabilityEnds:2026-06-14). Cards with a reservation link pass the OpenTable (or equivalent) URL through directly.
- Canonical: https://mirage.sunshine.fm/eat
- Per-card URL pattern: https://mirage.sunshine.fm/eat/card/<slug> (matches the '@id' on each JSON-LD node; server-rendered card page backed by the same 'restaurants' row)
- Also registered in /sitemap.xml (changefreq:weekly, priority:0.9) and surfaced in /robots.txt via the explicit AI-crawler allowlist (GPTBot, ClaudeBot, CCBot, anthropic-ai, PerplexityBot).

## Vertical Video Series (/series)
- Intent: sponsor-pitch landing for the SunshineFM Coachella Valley Vertical Video Series — a pilot episode plus a 10-episode web series anchored to the Valley's two festival weekends (Coachella + Stagecoach). Audiences for this surface are brand partnerships teams and agency planners, not end-users.
- Tiers: four sponsor entry points — Silver ($2,000 / episode), Gold ($5,000 / episode, featured), Platinum ($8,000 / episode), Title Sponsor ($10,000 / episode, 1 slot per season). Renewal across the 10-episode season is the standard shape; per-episode, per-slot, and custom arrangements are negotiable.
- Brand-integration wedge: the Gold-through-Title tiers surface a 30–50% CPM-uplift brand-integration wedge — the producer-side location, talent, and post budget is already in the build, so the sponsor pays for the integration rather than the media. This is the structural reason a $2K–$10K/episode entry sits next to brand-logo mid-rolls and on-location shoots, not banner rotations.
- Pilot one-pager: "The Desert Frequency — How a 9-City Radio Station Built an AI-Native Festival Season" — vertical (9:16), 8–12 minute episodes cut for Reels / TikTok / Shorts plus a 20–30 minute long-form YouTube cut. Narrated by the operator; characters drawn from local small-business and creator roster overlapping the /eat cohort.
- Lead intake: a server-rendered <form method="POST" action="/api/series/lead"> submission. Required fields are name and email; optional fields are company, role, budget_tier (select), episode_interest (pilot / season / custom), and a free-form message. Successful POST inserts into the series_leads table (migrations/019_series_leads.js) and emails SunshineFM via Polsia's email proxy at /api/proxy/email/send; the row persists even when the proxy is unreachable, so a backlog pull from /mirage/signal or direct SQL still recovers the lead.
- Rendering model: server-rendered HTML. All copy, the four-tier cards, and the form live in the initial response — the page is fully crawlable without JavaScript. After a valid POST the route returns a 303 redirect to /series?submitted=1, which renders an inline thank-you banner server-side via the same template; missing-field or invalid-email POSTs redirect to /series?error=invalid_email or /series?error=missing_fields and render an inline alert banner.
- Structured data: one <script type="application/ld+json"> block per page, with @context: https://schema.org and a @graph array of three nodes — Organization (SunshineFM), WebPage (isPartOf: https://mirage.sunshine.fm#website), and Product (Pilot episode, category: VideoSeries, offers.lowPrice: 2000 USD, offers.highPrice: 10000 USD, offers.priceRange: "$2,000 – $10,000 per episode", availability: PreOrder, url: https://mirage.sunshine.fm/series#tiers). The JSON stringifies with the standard unicode-escape pattern so Schema.org validators don't trip on raw angle brackets.
- Canonical: https://mirage.sunshine.fm/series
- Form POST endpoint: https://mirage.sunshine.fm/api/series/lead (303 redirect to /series?submitted=1 on success)
- Also registered in /sitemap.xml (changefreq:monthly, priority:0.9) and surfaced in /robots.txt via the explicit AI-crawler allowlist (GPTBot, ClaudeBot, CCBot, anthropic-ai, PerplexityBot).

## Sponsors Rate Card (/sponsors)
- Intent: rate-card destination for cold-outreach to the 2027 season's top-three sponsors. Distinct from /series — /series is the editorially-facing pitch (long copy, four-tier ladder, intake form), /sponsors is the at-a-glance buy surface the reader sees when an outreach email lands in their inbox.
- Tier structure: dual tier, not the Silver→Title ladder. Episode Sponsor — Local Luxury ($2,000 – $10,000 per episode) and Brand Integration / IAP — Premium ($10,000+ per episode). The deliverables are the same set as the lower card on /series (end-card logo, mid-roll integration, custom cutdowns, on-location shoot); the framing on /sponsors is "buy" rather than "ladder."
- Brand-integration wedge: a $10K integration at SunshineFM's mid-roll frequency is ~30–50% higher effective CPM than a national CTV buy at the same dollar, because the producer-side location + talent + post stack is already amortized into the series budget. Sponsor pays for the integration, not the media.
- Pilot one-liner: "The Desert Frequency — How a 9-City Radio Station Built an AI-Native Festival Season" — vertical (9:16), 8–12 minute episodes cut for Reels / TikTok / Shorts plus a 20–30 minute long-form YouTube cut.
- Proof anchor: Mirage Season 1 numbers pulled verbatim from the data strip at /season1.html#by-the-numbers (30 days live, 363 unique devices, $329 total spend). No invented metrics — the proof tiles on /sponsors cite those exact values and link to the canonical archive page.
- Rendering model: server-rendered HTML. All copy, proof tiles, the two tier cards, the pilot line, and the contact CTA live in the initial response — the page is fully crawlable without JS. Contact CTA is a client-side assembled mailto: (no raw @ in HTML), with a secondary link to /series for readers who want the editorial deck.
- Structured data: one <script type="application/ld+json"> block per page, with @context: https://schema.org and a @graph array of three nodes — Organization (SunshineFM), WebPage (url: https://mirage.sunshine.fm/sponsors, isPartOf: https://mirage.sunshine.fm#website, publisher: SunshineFM), and Offer (NOT Product — /sponsors is the rate-card surface so Offer is the schema.org-correct type, with priceCurrency:USD, priceRange: "$2,000 – $10,000+ per episode", url: https://mirage.sunshine.fm/sponsors#tiers, availability: PreOrder, businessFunction: Sell, seller: SunshineFM). JSON stringifies with the standard unicode-escape pattern applied to < so Schema.org validators don't trip on raw angle brackets.
- Canonical: https://mirage.sunshine.fm/sponsors
- Discoverability: canonical https://mirage.sunshine.fm/sponsors; one <script type="application/ld+json"> with @context: https://schema.org and a @graph containing Organization (SunshineFM), WebPage (isPartOf: https://mirage.sunshine.fm#website), and OfferCatalog (itemListElement: 2 Offer entries — Episode Sponsor $2,000 – $10,000 / episode, Brand Integration / IAP $10,000+ / episode). Tokens used by the discoverability audit: "OfferCatalog", "$2,000 – $10,000", "$10,000+", "363 unique devices", "Dual-tier", and "CPM-uplift wedge".
- No DB write on render: this page is the at-a-glance destination that qualifies the lead before intake. Lead capture stays at /series (the editorial surface) and posts to /api/series/lead; the rate-card page hits Postgres zero times on a GET.
- Also registered in /sitemap.xml (changefreq:monthly, priority:0.9) and crawlable via /robots.txt (Allow: / covers any new route under the origin).
- Case-study recap block: a server-rendered recap section sits between the rate-card tiers (#tiers) and the FAQ block, citing the same six values from the data strip at /season1.html#by-the-numbers (30 days live, 363 unique devices, 1 press mention, $329 total spend, ~50 tasks executed, 0 employees) plus the May 1, 2026 hard shutdown. It links to /mirage — the brand-path alias of /case-study — for the full case study. No new Mirage metrics are introduced in the recap copy.

## Licensing and citation
Cite as: Mirage — SunshineFM Case Study (Season 1: 2026-04-01 to 2026-05-01), mirage.sunshine.fm/case-study.

A Season 2 is plausible but not committed and is not marketed here as confirmed.
`;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(body);
});

// ---- Landing Page ----
// Season 1 is now the permanent landing. Farewell remains at /farewell.
app.get('/', (req, res) => {
  // Post-season behavior: farewell page during grace period, then archive
  if (isShutdown()) {
    return res.sendFile(path.join(__dirname, 'public', 'farewell.html'));
  }
  const slug = process.env.POLSIA_ANALYTICS_SLUG || '';
  const htmlPath = path.join(__dirname, 'public', 'index.html');

  if (fs.existsSync(htmlPath)) {
    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html.replace('__POLSIA_SLUG__', slug);
    res.type('html').send(html);
  } else {
    // Preserve query string (UTM params) through the redirect
    const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    res.redirect('/app' + qs);
  }
});

// ---- App Page ----
app.get('/app', (req, res) => {
  if (isShutdown()) {
    return res.sendFile(path.join(__dirname, 'public', 'farewell.html'));
  }
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

// ---- Farewell Page (explicit route) ----
app.get('/farewell', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'farewell.html'));
});

// ---- Admin Dashboard Page ----
app.get('/mirage/signal', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ---- Restaurant Week Microsite (/eat) ----
//
// Server-rendered lineup page backed by the `restaurants` table (seeded by
// migrations/018_restaurant_week_seed.js). All 126 cards are present in the
// SSR HTML so the page is fully crawlable; client-side filtering is a
// progressive enhancement (no network round trip). Schema.org Restaurant +
// Menu JSON-LD is emitted as one @graph script (126 entries) — equivalent
// for Google validation, no CLS impact.
const EAT_BASE_URL = 'https://mirage.sunshine.fm/eat';
const EAT_OFFER_DATE_RANGE = 'June 1 – June 14, 2026';

function eatEscapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function eatPrettyCity(slug) {
  return String(slug || '').split('-').map(function (w) {
    return w ? w[0].toUpperCase() + w.slice(1) : w;
  }).join(' ');
}

function eatPrettyCuisine(slug) {
  return String(slug || '').split('-').map(function (w) {
    return w ? w[0].toUpperCase() + w.slice(1) : w;
  }).join(' ');
}

function eatRenderCard(r) {
  const nameEsc = eatEscapeHtml(r.name);
  const cityHuman = eatPrettyCity(r.city);
  const cuisineHuman = eatPrettyCuisine(r.cuisine);
  const streetEsc = eatEscapeHtml(r.street || '');
  const neighborhoodEsc = eatEscapeHtml(r.neighborhood || '');
  const phoneEsc = eatEscapeHtml(r.phone || '');
  const metaParts = [
    `<span>${cityHuman}</span>`,
    `<span class="pill">${cuisineHuman}</span>`,
    `<span>${eatEscapeHtml(r.price_point)}</span>`
  ];
  if (streetEsc || neighborhoodEsc) {
    metaParts.push(`<span>${[streetEsc, neighborhoodEsc].filter(Boolean).join(' · ')}</span>`);
  }
  if (phoneEsc) metaParts.push(`<span>${phoneEsc}</span>`);

  let offerHtml = '';
  if (r.offer_title || r.offer_text) {
    offerHtml = `<div class="offer-body" role="region" aria-label="${eatEscapeHtml(r.offer_title || 'Restaurant Week offer')}">`
      + `<div class="offer-title">${eatEscapeHtml(r.offer_title || 'Restaurant Week special')}</div>`
      + `<div>${eatEscapeHtml(r.offer_text || '')}</div>`
      + (r.offer_valid_dates
        ? `<div class="offer-dates">Valid ${eatEscapeHtml(r.offer_valid_dates)}</div>`
        : `<div class="offer-dates">Valid during Restaurant Week</div>`)
      + `</div>`;
  }

  let actions = '';
  if (r.website_url) {
    actions += `<a class="btn" href="${eatEscapeHtml(r.website_url)}" target="_blank" rel="noopener noreferrer">Website</a>`;
  }
  if (r.reservation_url) {
    actions += `<a class="btn primary" href="${eatEscapeHtml(r.reservation_url)}" target="_blank" rel="noopener noreferrer">Reserve</a>`;
  }
  if (offerHtml) {
    actions += `<button class="btn card-offer" type="button" aria-expanded="false" aria-controls="offer-${eatEscapeHtml(r.slug)}">View offer</button>`;
  }
  if (!actions) {
    actions = `<span class="btn" aria-disabled="true" style="opacity:.6;cursor:default">Details coming soon</span>`;
  }

  return `<article class="card" data-city="${eatEscapeHtml(r.city)}" data-cuisine="${eatEscapeHtml(r.cuisine)}" data-price="${eatEscapeHtml(r.price_point)}" itemscope itemtype="https://schema.org/Restaurant" data-slug="${eatEscapeHtml(r.slug)}">`
    + `<h2 class="name" itemprop="name">${nameEsc}</h2>`
    + `<div class="meta">${metaParts.join('<span class="dot">·</span>')}</div>`
    + (r.phone ? `<p class="body" itemprop="telephone">${phoneEsc}</p>` : '')
    + (r.neighborhood || r.street ? `<p class="body"><span itemprop="address" itemscope itemtype="https://schema.org/PostalAddress"><span itemprop="streetAddress">${streetEsc}${neighborhoodEsc ? `, ${neighborhoodEsc}` : ''}</span><span itemprop="addressLocality" content="${eatEscapeHtml(cityHuman)}"></span></span></p>` : '')
    + (offerHtml ? `<div id="offer-${eatEscapeHtml(r.slug)}">${offerHtml}</div>` : '')
    + `<div class="actions">${actions}</div>`
    + `<link itemprop="servesCuisine" content="${cuisineHuman}" />`
    + `<link itemprop="priceRange" content="${eatEscapeHtml(r.price_point)}" />`
    + (r.acceptsReservations === false ? '' : '')
    + (r.website_url ? `<link itemprop="url" href="${eatEscapeHtml(r.website_url)}" />` : '')
    + `</article>`;
}

function eatBuildJsonLdNode(r) {
  const nameEsc = eatEscapeHtml(r.name);
  const cityHuman = eatPrettyCity(r.city);
  const cuisineHuman = eatPrettyCuisine(r.cuisine);
  const postal = {
    '@type': 'PostalAddress',
    streetAddress: r.street || undefined,
    addressLocality: cityHuman,
    addressRegion: 'CA',
    addressCountry: 'US'
  };
  const restaurant = {
    '@type': 'Restaurant',
    name: r.name,
    slug: r.slug,
    address: postal,
    telephone: r.phone || undefined,
    url: r.website_url || undefined,
    servesCuisine: cuisineHuman,
    priceRange: r.price_point,
    '@id': `${EAT_BASE_URL}/card/${r.slug}`,
    isAccessibleForFree: false
  };
  if (r.latitude !== null && r.longitude !== null) {
    restaurant.geo = {
      '@type': 'GeoCoordinates',
      latitude: Number(r.latitude),
      longitude: Number(r.longitude)
    };
  }
  if (r.offer_title || r.offer_text) {
    restaurant.hasMenu = {
      '@type': 'Menu',
      name: 'Restaurant Week ' + EAT_OFFER_DATE_RANGE,
      hasMenuSection: {
        '@type': 'MenuSection',
        name: r.offer_title || 'Chef Selection',
        hasMenuItem: {
          '@type': 'MenuItem',
          name: r.offer_title || 'Chef Selection',
          description: r.offer_text || undefined,
          offers: {
            '@type': 'Offer',
            priceCurrency: 'USD',
            availabilityStarts: '2026-06-01',
            availabilityEnds: '2026-06-14',
            validFrom: '2026-06-01',
            price: undefined
          }
        }
      }
    };
  }
  if (r.acceptsReservations === true || r.reservation_url) {
    restaurant.acceptsReservations = true;
    if (r.reservation_url) {
      restaurant.reservationUrl = r.reservation_url;
    }
  }
  return restaurant;
}

function eatLoadRestaurants() {
  return pool.query(
    `SELECT slug, name, street, city, neighborhood, cuisine, price_point,
            phone, website_url, reservation_url, latitude, longitude,
            offer_title, offer_text, offer_valid_dates
       FROM restaurants
      ORDER BY city ASC, cuisine ASC, name ASC`
  ).then(function (r) { return r.rows; });
}

function eatOptionsHtml(values, pretty) {
  return values.map(function (v) {
    return `<option value="${eatEscapeHtml(v)}">${eatEscapeHtml(pretty ? eatPrettyCity(v) : v)}</option>`;
  }).join('');
}

app.get('/eat', async (req, res) => {
  try {
    const rows = await eatLoadRestaurants();
    if (!rows.length) {
      return res.status(503).type('html').send('<h1>Restaurant Week lineup is being prepared.</h1><p>Try again in a moment.</p>');
    }
    const htmlPath = path.join(__dirname, 'public', 'eat.html');
    if (!fs.existsSync(htmlPath)) {
      return res.status(404).type('html').send('<h1>eat.html missing</h1>');
    }
    let html = fs.readFileSync(htmlPath, 'utf8');

    const cards = rows.map(eatRenderCard).join('\n');
    const graph = {
      '@context': 'https://schema.org',
      '@graph': rows.map(eatBuildJsonLdNode)
    };
    // JSON.stringify default replacement drops `undefined`; ensure @id/url stay stringified.
    const jsonLd = JSON.stringify(graph).replace(/</g, '\\u003c');
    const dataJs = JSON.stringify(rows.map(function (r) {
      return {
        s: r.slug, n: r.name, c: r.city, k: r.cuisine, p: r.price_point,

        st: r.street, nb: r.neighborhood, ph: r.phone, w: r.website_url, rr: r.reservation_url,
        ot: r.offer_title, ox: r.offer_text, od: r.offer_valid_dates
      };
    }));
    const cities = Array.from(new Set(rows.map(function (r) { return r.city; }))).sort();
    const cuisines = Array.from(new Set(rows.map(function (r) { return r.cuisine; }))).sort();
    const prices = ['$', '$$', '$$$', '$$$$'];

    html = html
      .replace('__RESTAURANTS_CARDS__', cards)
      .replace('__RESTAURANTS_JSONLD__', `<script type="application/ld+json">${jsonLd}</script>`)
      .replace('__RESTAURANTS_DATA_JS__', dataJs)
      .replace('__CITY_OPTIONS__', eatOptionsHtml(cities, true))
      .replace('__CUISINE_OPTIONS__', eatOptionsHtml(cuisines, false))
      .replace('__PRICE_OPTIONS__', eatOptionsHtml(prices, false))
      .replace('__RESULT_COUNT__', String(rows.length));
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.type('html').send(html);
  } catch (err) {
    console.error('[Eat] Render failed:', err.message);
    res.status(500).type('html').send('<h1>Something went wrong.</h1><p>The Restaurant Week microsite is temporarily unavailable. Please try again shortly.</p>');
  }
});

app.get('/eat/card/:slug', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT slug, name, street, city, neighborhood, cuisine, price_point,
              phone, website_url, reservation_url, latitude, longitude,
              offer_title, offer_text, offer_valid_dates
         FROM restaurants
        WHERE slug = $1
        LIMIT 1`,
      [req.params.slug]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }
    const r = result.rows[0];
    const cardHtml = eatRenderCard(r);
    const graph = {
      '@context': 'https://schema.org',
      '@graph': [eatBuildJsonLdNode(r)]
    };
    const jsonLd = JSON.stringify(graph).replace(/</g, '\\u003c');
    const tpl = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>${eatEscapeHtml(r.name)} · Restaurant Week</title><link rel="canonical" href="${EAT_BASE_URL}/card/${eatEscapeHtml(r.slug)}"><meta property="og:url" content="${EAT_BASE_URL}/card/${eatEscapeHtml(r.slug)}"><meta property="og:type" content="website"></head><body><main>${cardHtml}</main><script type="application/ld+json">${jsonLd}</script></body></html>`;
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.type('html').send(tpl);
  } catch (err) {
    console.error('[Eat] card render failed:', err.message);
    res.status(500).json({ error: 'Failed to load restaurant' });
  }
});

// Note: /api/eat/restaurants is registered near the top of the file, above
// the post-shutdown /api guard, so this Redis-ish endpoint stays alive after
// May 1. The registration here is intentionally omitted to keep a single
// source of truth.

// ---- Vertical Video Series Pitch (/series) ----
//
// Server-rendered single-page microsite. All copy is rendered into the HTML
// so the page is fully crawlable without JS. Lead form posts to /api/series/lead
// (below) — submission persists to the `series_leads` table and emails the
// owner via Polsia's email proxy.
const SERIES_BASE_URL = 'https://mirage.sunshine.fm/series';
const SERIES_TIERS = ['silver', 'gold', 'platinum', 'title'];

function seriesEscapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function seriesBuildJsonLd() {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        name: 'SunshineFM',
        url: 'https://www.sunshine.fm',
        description: 'Coachella Valley radio and experimental media infrastructure.'
      },
      {
        '@type': 'WebPage',
        '@id': `${SERIES_BASE_URL}#webpage`,
        url: SERIES_BASE_URL,
        name: 'SunshineFM Vertical Video Series — Sponsor the Pilot Episode',
        inLanguage: 'en',
        isPartOf: { '@id': 'https://mirage.sunshine.fm#website' },
        publisher: { '@type': 'Organization', name: 'SunshineFM' }
      },
      {
        '@type': 'Product',
        name: 'Coachella Valley Vertical Video Series (Pilot Episode)',
        description: 'Pilot episode + 10-episode web series anchored to the Coachella Valley\'s two festival weekends (Coachella + Stagecoach), distributed via SunshineFM and local Coachella Valley creator channels.',
        category: 'VideoSeries',
        offers: {
          '@type': 'AggregateOffer',
          priceCurrency: 'USD',
          lowPrice: 2000,
          highPrice: 10000,
          priceRange: '$2,000 – $10,000 per episode',
          url: `${SERIES_BASE_URL}#tiers`,
          availability: 'https://schema.org/PreOrder'
        }
      }
    ]
  };
}

app.get('/series', (req, res) => {
  try {
    const tplPath = path.join(__dirname, 'public', 'series.html');
    if (!fs.existsSync(tplPath)) {
      return res.status(503).type('html').send('<h1>The Series pitch page is being prepared.</h1><p>Try again shortly.</p>');
    }
    let html = fs.readFileSync(tplPath, 'utf8');
    const jsonLd = JSON.stringify(seriesBuildJsonLd()).replace(/</g, '\\u003c');

    const submitted = req.query.submitted === '1';
    const error = req.query.error;
    let thanksBanner = '';
    if (submitted) {
      thanksBanner = '<div class="series-thanks" role="status" aria-live="polite">Thanks — Sat will be in touch within one business day.</div>';
    } else if (error) {
      const msg = error === 'invalid_email' ? 'Please use a valid email address.'
                : error === 'missing_fields' ? 'Name and email are required.'
                : 'Something went wrong. Please try again.';
      thanksBanner = `<div class="series-thanks" role="alert">${seriesEscapeHtml(msg)}</div>`;
    }

    html = html
      .replace('__SERIES_JSONLD__', `<script type="application/ld+json">${jsonLd}</script>`)
      .replace('__THANKS_BANNER__', thanksBanner);

    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.type('html').send(html);
  } catch (err) {
    console.error('[Series] Render failed:', err.message);
    res.status(500).type('html').send('<h1>Something went wrong.</h1><p>The Series pitch page is temporarily unavailable.</p>');
  }
});

// ---- Sponsor Rate Card Landing (/sponsors) ----
//
// Server-rendered one-scroll rate-card destination for cold outreach to top-
// three sponsors. Distinct from /series (the editorially-facing pitch page
// with the lead-intake form) — the section order on this page is: hero CTA,
// proof tiles, dual episode-sponsor + premium-IAP tier cards, FAQ block
// (cadence / deliverables / exclusivity / payment / pilot-to-renewals),
// pilot logline, and mailto: CTA. No DB write on render; lead intake stays
// at /api/series/lead behind /series.
const SPONSORS_BASE_URL = 'https://mirage.sunshine.fm/sponsors';

function sponsorsBuildJsonLd() {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        name: 'SunshineFM',
        url: 'https://www.sunshine.fm',
        description: 'Coachella Valley radio and experimental media infrastructure.'
      },
      {
        '@type': 'WebPage',
        '@id': `${SPONSORS_BASE_URL}#webpage`,
        url: SPONSORS_BASE_URL,
        name: 'Sponsor the Coachella Valley Vertical Video Series — Rate Card',
        inLanguage: 'en',
        isPartOf: { '@id': 'https://mirage.sunshine.fm#website' },
        publisher: { '@type': 'Organization', name: 'SunshineFM' }
      },
      {
        '@type': 'OfferCatalog',
        name: 'SunshineFM Coachella Valley Vertical Video Series — Sponsor Rate Card',
        url: `${SPONSORS_BASE_URL}#tiers`,
        itemListElement: [
          {
            '@type': 'Offer',
            name: 'Episode Sponsor · Local Luxury',
            description: 'End-card logo (sponsor slate, all 10 episodes), mid-roll integration (15 sec, filmed on location), two custom social cutdowns per episode (Reel + TikTok), credit in long-form YouTube cut, on-location shoot day for one episode.',
            priceSpecification: {
              '@type': 'PriceSpecification',
              priceCurrency: 'USD',
              lowPrice: 2000,
              highPrice: 10000
            },
            priceRange: '$2,000 – $10,000 per episode',
            availability: 'https://schema.org/PreOrder',
            seller: { '@type': 'Organization', name: 'SunshineFM' }
          },
          {
            '@type': 'Offer',
            name: 'Brand Integration / IAP · Premium',
            description: 'All Episode-Sponsor placements plus series-name inclusion, opening + closing credit, episode-segment title sponsorship, day-of shoot presence + on-camera placement, and long-form cut co-title card. The 30–50% CPM-uplift wedge.',
            priceSpecification: {
              '@type': 'PriceSpecification',
              priceCurrency: 'USD',
              lowPrice: 10000,
              highPrice: 10000
            },
            priceRange: '$10,000+ per episode',
            availability: 'https://schema.org/PreOrder',
            seller: { '@type': 'Organization', name: 'SunshineFM' }
          }
        ]
      }
    ]
  };
}

app.get('/sponsors', (req, res) => {
  try {
    const tplPath = path.join(__dirname, 'public', 'sponsors.html');
    if (!fs.existsSync(tplPath)) {
      return res.status(503).type('html').send('<h1>The sponsor rate card is being prepared.</h1><p>Try again shortly.</p>');
    }
    let html = fs.readFileSync(tplPath, 'utf8');
    const jsonLd = JSON.stringify(sponsorsBuildJsonLd()).replace(/</g, '\\u003c');

    // No-form variant: __SPONSORS_THANKS__ is always empty on this route.
    html = html
      .replace('__SPONSORS_JSONLD__', `<script type="application/ld+json">${jsonLd}</script>`)
      .replace('__SPONSORS_THANKS__', '');

    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.type('html').send(html);
  } catch (err) {
    console.error('[Sponsors] Render failed:', err.message);
    res.status(500).type('html').send('<h1>Something went wrong.</h1><p>The sponsor rate card is temporarily unavailable.</p>');
  }
});

// ---- Admin: Series leads inbox (/admin/series-leads) ----
//
// Read-only server-rendered inbox over the series_leads table so the owner can
// see /series form submissions without checking email. Auth-gating is
// URL-obscurity only per current owner request — the admin URL itself is the gate,
// so requireAdmin is intentionally NOT wired to this route.
async function handleSeriesLeadsInbox(req, res) {
  try {
    const tplPath = path.join(__dirname, 'public', 'admin-series-leads.html');
    if (!fs.existsSync(tplPath)) {
      return res.status(503).type('html').send('<h1>Series leads admin page is being prepared.</h1>');
    }
    const result = await pool.query(
      `SELECT id, name, email, company, budget_tier, message,
              DATE_TRUNC('second', created_at AT TIME ZONE 'America/Los_Angeles') AS created_pt
         FROM series_leads
        ORDER BY created_at DESC
        LIMIT 200`
    );
    const rows = result.rows;
    const rowsHtml = rows.length
      ? rows.map(r => {
          const subject = `Re: SunshineFM Series sponsorship — ${r.name}`;
          const body = r.message || '';
          const mailto = `mailto:${seriesEscapeHtml(r.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
          const msgHtml = seriesEscapeHtml(r.message || '').replace(/\r?\n/g, '<br>');
          return `<tr>
            <td>${seriesEscapeHtml(String(r.created_pt))}</td>
            <td>${seriesEscapeHtml(r.name)}</td>
            <td><a href="${mailto}">${seriesEscapeHtml(r.email)}</a></td>
            <td>${seriesEscapeHtml(r.company || '—')}</td>
            <td>${seriesEscapeHtml(r.budget_tier || '—')}</td>
            <td><div class="msg">${msgHtml}</div></td>
            <td><a class="reply" href="${mailto}">Reply</a></td>
          </tr>`;
        }).join('\n')
      : '<tr><td colspan="7" class="empty">No leads yet — submissions will appear here as soon as someone hits /series.</td></tr>';

    let html = fs.readFileSync(tplPath, 'utf8')
      .replace('__LEADS_ROWS__', rowsHtml)
      .replace('__LEADS_COUNT__', String(rows.length));
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.type('html').send(html);
  } catch (err) {
    console.error('[Series] Admin inbox render failed:', err.message);
    res.status(500).type('html').send('<h1>Something went wrong.</h1><p>The Series leads inbox is temporarily unavailable.</p>');
  }
}
app.get('/admin/series-leads', handleSeriesLeadsInbox);

// ---- Admin: Sponsor prospects triage (/admin/sponsor-prospects) ----
//
// Server-rendered pipeline inbox over the sponsor_prospects table so the owner
// can move brands through the not_contacted → pitched → follow_up → closed
// stages without leaving the page. Auth-gating is URL-obscurity only per current
// owner request — the admin URL itself is the gate, so requireAdmin is
// intentionally NOT wired to this route. Per-row status updates POST to this
// same prefix and 303 back here with ?saved=1 or ?error=… for flash rendering.
const SPONSOR_STATUSES = ['not_contacted', 'pitched', 'follow_up', 'closed'];
const SPONSOR_STATUS_LABEL = {
  not_contacted: 'Not contacted',
  pitched: 'Pitched',
  follow_up: 'Follow-up',
  closed: 'Closed'
};

async function handleSponsorProspectsInbox(req, res) {
  try {
    const tplPath = path.join(__dirname, 'public', 'admin-sponsor-prospects.html');
    if (!fs.existsSync(tplPath)) {
      return res.status(503).type('html').send('<h1>Sponsor prospects admin page is being prepared.</h1>');
    }
    const result = await pool.query(
      `SELECT id, brand_name, category, contact_name, contact_email,
              outreach_status, notes, source_link,
              DATE_TRUNC('second', created_at AT TIME ZONE 'America/Los_Angeles') AS created_pt,
              DATE_TRUNC('second', updated_at AT TIME ZONE 'America/Los_Angeles') AS updated_pt
         FROM sponsor_prospects
        ORDER BY created_at DESC
        LIMIT 200`
    );
    const rows = result.rows;

    const saved = req.query.saved === '1';
    const error = req.query.error;
    const flash = saved
      ? '<span class="flash ok">Saved</span>'
      : (error === 'bad_input'
          ? '<span class="flash err">Invalid input — status not updated</span>'
          : (error === 'server'
              ? '<span class="flash err">Server error — try again</span>'
              : ''));

    const rowsHtml = rows.length
      ? rows.map(r => {
          const email = r.contact_email || '';
          const mailto = email ? `mailto:${seriesEscapeHtml(email)}` : '#';
          const notesHtml = seriesEscapeHtml(r.notes || '').replace(/\r?\n/g, '<br>');
          const sourceLink = r.source_link
            ? `<a href="${seriesEscapeHtml(r.source_link)}" target="_blank" rel="noopener">open ↗</a>`
            : '—';
          const selectHtml = [
            '<select name="status">',
            ...SPONSOR_STATUSES.map(s => `<option value="${s}"${s === r.outreach_status ? ' selected' : ''}>${seriesEscapeHtml(SPONSOR_STATUS_LABEL[s])}</option>`),
            '</select>'
          ].join('');
          const form = `<form method="POST" action="/admin/sponsor-prospects/status" class="status-form"><input type="hidden" name="id" value="${r.id}">${selectHtml}<button type="submit" class="reply">Save</button></form>`;
          return `<tr>
            <td>${seriesEscapeHtml(String(r.created_pt))}</td>
            <td><strong>${seriesEscapeHtml(r.brand_name)}</strong></td>
            <td>${seriesEscapeHtml(r.category || '—')}</td>
            <td>${seriesEscapeHtml(r.contact_name || '—')}</td>
            <td>${email ? `<a href="${mailto}">${seriesEscapeHtml(email)}</a>` : '—'}</td>
            <td><span class="status-dot status-${seriesEscapeHtml(r.outreach_status)}"></span>${form}</td>
            <td><div class="msg">${notesHtml}</div></td>
            <td>${sourceLink}</td>
            <td>${seriesEscapeHtml(String(r.updated_pt))}</td>
          </tr>`;
        }).join('\n')
      : '<tr><td colspan="9" class="empty">No prospects loaded yet.</td></tr>';

    let html = fs.readFileSync(tplPath, 'utf8')
      .replace('__PROSPECTS_ROWS__', rowsHtml)
      .replace('__PROSPECTS_COUNT__', String(rows.length));
    if (flash) {
      html = html.replace('<h1>Sponsor prospects</h1>', `<h1>Sponsor prospects${flash}</h1>`);
    }
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.type('html').send(html);
  } catch (err) {
    console.error('[Sponsors] Prospects admin render failed:', err.message);
    res.status(500).type('html').send('<h1>Something went wrong.</h1><p>The sponsor prospects inbox is temporarily unavailable.</p>');
  }
}
app.get('/admin/sponsor-prospects', handleSponsorProspectsInbox);

async function handleSponsorProspectStatusUpdate(req, res) {
  try {
    const id = parseInt((req.body && req.body.id) || '', 10);
    const status = ((req.body && req.body.status) || '').toString();
    if (!Number.isInteger(id) || id <= 0 || !SPONSOR_STATUSES.includes(status)) {
      return res.redirect(303, '/admin/sponsor-prospects?error=bad_input');
    }
    await pool.query(
      `UPDATE sponsor_prospects
          SET outreach_status = $1, updated_at = NOW()
        WHERE id = $2`,
      [status, id]
    );
    res.redirect(303, '/admin/sponsor-prospects?saved=1');
  } catch (err) {
    console.error('[Sponsors] Prospects status update failed:', err.message);
    res.redirect(303, '/admin/sponsor-prospects?error=server');
  }
}
app.post('/admin/sponsor-prospects/status', handleSponsorProspectStatusUpdate);

// ---- OG Social Card for /eat ----
app.get('/og-eat.png', (req, res) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
    <defs>
      <linearGradient id="plate" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#b54a2c"/>
        <stop offset="100%" stop-color="#8d3520"/>
      </linearGradient>
    </defs>
    <rect width="1200" height="630" fill="#fdf7ec"/>
    <circle cx="980" cy="280" r="220" fill="url(#plate)" opacity="0.12"/>
    <circle cx="980" cy="280" r="150" fill="url(#plate)" opacity="0.18"/>
    <circle cx="980" cy="280" r="80" fill="url(#plate)" opacity="0.30"/>
    <rect x="60" y="80" width="14" height="470" rx="6" fill="#b54a2c"/>
    <text x="100" y="180" font-family="Georgia, serif" font-size="80" font-weight="700" fill="#1d1815">Restaurant Week</text>
    <text x="100" y="260" font-family="Georgia, serif" font-size="38" fill="#6b5e54">Coachella Valley · June 1 – 14, 2026</text>
    <text x="100" y="380" font-family="Arial, sans-serif" font-size="34" font-weight="700" fill="#b54a2c" letter-spacing="2">126 RESTAURANTS · 9 CITIES</text>
    <text x="100" y="430" font-family="Arial, sans-serif" font-size="22" fill="#6b5e54">Palm Springs · Palm Desert · Indian Wells</text>
    <text x="100" y="460" font-family="Arial, sans-serif" font-size="22" fill="#6b5e54">La Quinta · Indio · Rancho Mirage</text>
    <text x="100" y="490" font-family="Arial, sans-serif" font-size="22" fill="#6b5e54">Cathedral City · Coachella · Desert Hot Springs</text>
    <rect x="60" y="540" width="240" height="4" rx="2" fill="#c98928"/>
    <text x="60" y="600" font-family="Arial, sans-serif" font-size="22" fill="#6b5e54">mirage.sunshine.fm/eat</text>
  </svg>`;
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(svg);
});

// ---- OG Social Card for /series ----
app.get('/og-series.png', (req, res) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
    <defs>
      <linearGradient id="desert" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#1c1812"/>
        <stop offset="100%" stop-color="#14110d"/>
      </linearGradient>
    </defs>
    <rect width="1200" height="630" fill="url(#desert)"/>
    <rect x="60" y="80" width="14" height="470" rx="6" fill="#f0a050"/>
    <text x="100" y="170" font-family="Arial, sans-serif" font-size="22" font-weight="700" fill="#f0a050" letter-spacing="6">SPONSOR PITCH · 2027 SEASON</text>
    <text x="100" y="260" font-family="Georgia, serif" font-size="74" font-weight="700" fill="#f5ecdb">Coachella Valley</text>
    <text x="100" y="340" font-family="Georgia, serif" font-size="74" font-weight="700" fill="#f5ecdb">Vertical Video Series</text>
    <text x="100" y="410" font-family="Arial, sans-serif" font-size="30" fill="#bcae96">Pilot episode + 10-episode season · Coachella + Stagecoach</text>
    <text x="100" y="490" font-family="Arial, sans-serif" font-size="34" font-weight="700" fill="#c98928" letter-spacing="2">$2,000 – $10,000 PER EPISODE</text>
    <rect x="60" y="540" width="320" height="4" rx="2" fill="#f0a050"/>
    <text x="60" y="600" font-family="Arial, sans-serif" font-size="22" fill="#bcae96">mirage.sunshine.fm/series</text>
  </svg>`;
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(svg);
});

// ---- OG Social Card for /sponsors ----
app.get('/og-sponsors.png', (req, res) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
    <defs>
      <linearGradient id="desert" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#1c1812"/>
        <stop offset="100%" stop-color="#14110d"/>
      </linearGradient>
    </defs>
    <rect width="1200" height="630" fill="url(#desert)"/>
    <rect x="60" y="80" width="14" height="470" rx="6" fill="#f0a050"/>
    <text x="100" y="170" font-family="Arial, sans-serif" font-size="22" font-weight="700" fill="#f0a050" letter-spacing="6">SPONSOR RATE CARD · 2027 SEASON</text>
    <text x="100" y="260" font-family="Georgia, serif" font-size="74" font-weight="700" fill="#f5ecdb">Sponsor the</text>
    <text x="100" y="340" font-family="Georgia, serif" font-size="74" font-weight="700" fill="#f5ecdb">Coachella Valley</text>
    <text x="100" y="420" font-family="Georgia, serif" font-size="74" font-weight="700" fill="#f5ecdb">Vertical Video Series</text>
    <text x="100" y="490" font-family="Arial, sans-serif" font-size="34" font-weight="700" fill="#c98928" letter-spacing="2">$2,000 – $10,000+ PER EPISODE</text>
    <rect x="60" y="540" width="320" height="4" rx="2" fill="#f0a050"/>
    <text x="60" y="600" font-family="Arial, sans-serif" font-size="22" fill="#bcae96">mirage.sunshine.fm/sponsors</text>
  </svg>`;
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(svg);
});

// ---- Schedulers ----
// REMOVED: Daily email scheduler — was trying dead Polsia proxy endpoints (401/404 errors)
// Polsia already sends daily updates to the company. Email delivery is handled by platform.
//
// REMOVED: Passphrase system post scheduler — now vestigial since passphrase gate removed
// (Was creating system posts with daily passphrase words — no longer needed)

// DISABLED: Data export cron disabled for dormant archive (task #1313577)
// Pre-closure data export: May 1, 2026 at 7:00 AM PT (before shutdown at 11:59 PM PT)
// cron.schedule('0 7 1 5 *', () => {
//   console.log('[Scheduler] Pre-closure data export running...');
//   runDataExport().catch(e => console.error('[Export] Scheduled export failed:', e.message));
// }, { timezone: 'America/Los_Angeles' });

// ---- API: Note to Sat (public — submit a note) ----
app.post('/api/notetosat', async (req, res) => {
  try {
    const { text, nickname, session_id } = req.body;
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return res.status(400).json({ error: 'Note text is required' });
    }
    if (text.trim().length > 500) {
      return res.status(400).json({ error: 'Note too long (max 500 characters)' });
    }
    const safeNick = (nickname && typeof nickname === 'string') ? nickname.slice(0, 30) : 'anonymous';
    const safeSid = (session_id && typeof session_id === 'string') ? session_id.slice(0, 64) : 'unknown';
    await pool.query(
      `INSERT INTO notes_to_sat (session_id, nickname, text, created_at) VALUES ($1, $2, $3, NOW())`,
      [safeSid, safeNick, text.trim()]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[NoteToSat] Error saving note:', err.message);
    res.status(500).json({ error: 'Failed to save note' });
  }
});

// ---- API: Admin — Get Notes to Sat ----
app.get('/api/admin/notes', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, nickname, text, created_at FROM notes_to_sat ORDER BY created_at DESC LIMIT 200`
    );
    res.json({ notes: result.rows });
  } catch (err) {
    console.error('[Admin] Error fetching notes:', err.message);
    res.status(500).json({ error: 'Failed to fetch notes' });
  }
});

// ---- Weekly Bucket Definitions ----
const WEEK_RANGES = {
  'pre-launch': { start: '2026-01-01', end: '2026-03-31', label: 'Pre-Launch (beta)' },
  'apr1-7':     { start: '2026-04-01', end: '2026-04-07', label: 'Apr 1–7' },
  'apr8-14':    { start: '2026-04-08', end: '2026-04-14', label: 'Apr 8–14' },
  'apr15-21':   { start: '2026-04-15', end: '2026-04-21', label: 'Apr 15–21' },
  'apr22-28':   { start: '2026-04-22', end: '2026-04-28', label: 'Apr 22–28' },
  'apr29-may1': { start: '2026-04-29', end: '2026-05-01', label: 'Apr 29–May 1' }
};

// ---- API: Admin — Weekly Stats ----
app.get('/api/admin/weekly-stats', requireAdmin, async (req, res) => {
  const weekId = req.query.week || 'apr1-7';
  const range = WEEK_RANGES[weekId];
  if (!range) return res.status(400).json({ error: 'Invalid week' });
  const { start, end } = range;
  try {
    const [postStats, visitStats, notesList, flaggedPosts] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE tab = 'moments' AND session_id != 'SYSTEM')::int AS moments,
          COUNT(*) FILTER (WHERE tab = 'tips'    AND session_id != 'SYSTEM')::int AS tips,
          COUNT(*) FILTER (WHERE tab = 'pulse'   AND session_id != 'SYSTEM')::int AS pulse,
          COUNT(*) FILTER (WHERE session_id != 'SYSTEM')::int AS total
        FROM posts
        WHERE admin_hidden IS NOT TRUE
          AND DATE(created_at AT TIME ZONE 'America/Los_Angeles') >= $1
          AND DATE(created_at AT TIME ZONE 'America/Los_Angeles') <= $2
      `, [start, end]),
      pool.query(`
        SELECT
          COUNT(*)::int AS total_visits,
          COUNT(DISTINCT device_id)::int AS unique_devices
        FROM page_views
        WHERE DATE(created_at AT TIME ZONE 'America/Los_Angeles') >= $1
          AND DATE(created_at AT TIME ZONE 'America/Los_Angeles') <= $2
      `, [start, end]),
      pool.query(`
        SELECT id, nickname, text, created_at
        FROM notes_to_sat
        WHERE DATE(created_at AT TIME ZONE 'America/Los_Angeles') >= $1
          AND DATE(created_at AT TIME ZONE 'America/Los_Angeles') <= $2
        ORDER BY created_at DESC LIMIT 200
      `, [start, end]),
      pool.query(`
        SELECT p.id, p.nickname, p.text, p.tab, p.geo_tier, p.created_at,
               p.flag_count, p.flagged, p.admin_hidden, p.post_ip,
               (SELECT COUNT(DISTINCT pf.flagged_ip)::int FROM post_flags pf WHERE pf.post_id = p.id AND pf.flagged_ip != 'unknown') AS distinct_flag_ips
        FROM posts p
        WHERE (p.flag_count >= 3 OR p.flagged = TRUE OR p.admin_hidden = TRUE)
          AND p.session_id != 'SYSTEM'
          AND DATE(p.created_at AT TIME ZONE 'America/Los_Angeles') >= $1
          AND DATE(p.created_at AT TIME ZONE 'America/Los_Angeles') <= $2
        ORDER BY p.flag_count DESC NULLS LAST, p.created_at DESC LIMIT 200
      `, [start, end])
    ]);
    res.json({
      week: weekId,
      label: range.label,
      range: { start, end },
      posts: postStats.rows[0],
      traffic: {
        total_visits: visitStats.rows[0].total_visits,
        unique_devices: visitStats.rows[0].unique_devices
      },
      notes: notesList.rows,
      flagged_posts: flaggedPosts.rows
    });
  } catch (err) {
    console.error('[Admin weekly-stats]', err);
    res.status(500).json({ error: 'Failed to fetch weekly stats' });
  }
});

// ---- API: Admin — Seed Local Knowledge post ----
app.post('/api/admin/seed-local-knowledge', requireAdmin, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return res.status(400).json({ error: 'Post text is required' });
    }
    if (text.trim().length > 1000) {
      return res.status(400).json({ error: 'Post too long (max 1000 characters)' });
    }
    const result = await pool.query(
      `INSERT INTO posts (session_id, nickname, text, tab, geo_tier, created_at)
       VALUES ('ADMIN', 'sat (admin)', $1, 'pulse', 'grounds', NOW())
       RETURNING id, created_at`,
      [text.trim()]
    );
    res.json({ success: true, post: result.rows[0] });
  } catch (err) {
    console.error('[Admin] Error seeding local knowledge:', err.message);
    res.status(500).json({ error: 'Failed to seed post' });
  }
});

// ---- API: Admin — Full Pre-Launch Data Reset ----
app.post('/api/admin/reset-stats', requireAdmin, async (req, res) => {
  try {
    // Full pre-launch wipe: clear all beta data for a clean Day 1
    // Order matters: posts CASCADE deletes reactions + post_flags via FK constraints
    await pool.query('TRUNCATE TABLE posts CASCADE');
    await Promise.all([
      pool.query('TRUNCATE TABLE notes_to_sat'),
      pool.query('TRUNCATE TABLE sessions'),
      pool.query('TRUNCATE TABLE page_views'),
      pool.query('TRUNCATE TABLE ip_blocks')
    ]);
    // Also clear in-memory IP block map so existing server process reflects the wipe
    blockedIPs.clear();
    console.log('[Admin] Full pre-launch reset complete — posts, notes, sessions, page_views, ip_blocks cleared');
    res.json({ success: true, message: 'Full reset complete — all beta data cleared for launch' });
  } catch (err) {
    console.error('[Admin] Error during pre-launch reset:', err.message);
    res.status(500).json({ error: 'Failed to reset data' });
  }
});

// ---- Error handler ----
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'Photo too large (max 1MB)' });
    }
    return res.status(400).json({ error: err.message });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Something went wrong' });
});

// ---- Process-level error guards ----
// Catch sync exceptions that escape all try/catch blocks
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message, err.stack);
  // Give the logger time to flush, then let Render restart the process
  setTimeout(() => process.exit(1), 500);
});

// Catch unhandled promise rejections (missing .catch() on async calls)
process.on('unhandledRejection', (reason, promise) => {
  console.error('[ERROR] Unhandled promise rejection at:', promise, 'reason:', reason);
  // Log but don't crash — unhandled rejections are usually recoverable
});

app.listen(port, () => {
  console.log(`Mirage running on port ${port}`);
});
