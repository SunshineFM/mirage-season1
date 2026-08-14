// Mirage Service Worker — offline resilience for Coachella
// Cache version — bump to force refresh on deploy
const CACHE_VERSION = 'mirage-v12';

const STATIC_CACHE = `${CACHE_VERSION}-static`;
const FONT_CACHE   = `${CACHE_VERSION}-fonts`;

// Critical shell assets to pre-cache on install
const PRECACHE_URLS = [
  '/',
  '/app',
  '/manifest.json',
];

// Google Fonts to cache
const GOOGLE_FONT_URLS = [
  'https://fonts.googleapis.com/css2?family=Righteous&family=Bebas+Neue&family=DM+Sans:ital,wght@0,400;0,500;0,600;0,700;1,400&display=swap',
];

// ---- Message: allow page to trigger immediate activation ----
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ---- Install: pre-cache shell ----
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => {
      return cache.addAll(PRECACHE_URLS).catch((err) => {
        console.warn('[SW] Pre-cache failed for some URLs:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

// ---- Activate: clean old caches ----
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter(key => key.startsWith('mirage-') && key !== STATIC_CACHE && key !== FONT_CACHE)
          .map(key => {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
          })
      );
    }).then(() => self.clients.claim())
  );
});

// ---- Fetch: routing strategy ----
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests and chrome-extension requests
  if (request.method !== 'GET') return;
  if (!url.protocol.startsWith('http')) return;

  // API calls: network-first, no caching
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(request, false));
    return;
  }

  // Google Fonts: cache-first (they rarely change)
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(cacheFirstWithNetwork(request, FONT_CACHE));
    return;
  }

  // Navigation requests (HTML pages): network-first so new deploys are immediately reflected.
  // Falls back to cached shell only when offline.
  if (request.mode === 'navigate' || request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(networkFirstHTML(request));
    return;
  }

  // Other static assets (images, manifest): cache-first with network fallback
  event.respondWith(cacheFirstWithOfflineFallback(request));
});

// ---- Strategy: Network-first for HTML (ensures deploys are immediately visible) ----
// Fetches fresh HTML from network; falls back to cached shell only when offline.
async function networkFirstHTML(request) {
  const cache = await caches.open(STATIC_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    // Offline: serve cached shell
    const cached = await cache.match(request)
      || await cache.match('/app')
      || await cache.match('/');
    if (cached) {
      const html = await cached.text();
      return new Response(injectOfflineBanner(html), {
        headers: { 'Content-Type': 'text/html', 'X-Mirage-Offline': '1' }
      });
    }
    return new Response('Offline — open mirage first with a connection', { status: 503 });
  }
}

// ---- Strategy: Network-first ----
async function networkFirst(request, shouldCache = true) {
  try {
    const networkResponse = await fetch(request);
    if (shouldCache && networkResponse.ok) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    // Return offline error for API calls
    return new Response(
      JSON.stringify({ error: 'offline', message: 'No signal. Post will be queued.' }),
      {
        status: 503,
        headers: { 'Content-Type': 'application/json', 'X-Mirage-Offline': '1' }
      }
    );
  }
}

// ---- Strategy: Cache-first with network update ----
async function cacheFirstWithNetwork(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) {
    // Update in background
    fetch(request).then(response => {
      if (response.ok) cache.put(request, response);
    }).catch(() => {});
    return cached;
  }
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    return new Response('Font unavailable offline', { status: 503 });
  }
}

// ---- Strategy: Cache-first with offline app shell fallback ----
async function cacheFirstWithOfflineFallback(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    // If it's a navigation (HTML page request), return cached /app shell
    if (request.mode === 'navigate' || request.headers.get('accept')?.includes('text/html')) {
      const appShell = await cache.match('/app') || await cache.match('/');
      if (appShell) {
        // Inject offline banner via a modified response
        const html = await appShell.text();
        const offlineHtml = injectOfflineBanner(html);
        return new Response(offlineHtml, {
          headers: { 'Content-Type': 'text/html', 'X-Mirage-Offline': '1' }
        });
      }
    }
    return new Response('Offline — open mirage first with a connection', { status: 503 });
  }
}

// Inject a minimal offline banner into the HTML shell
function injectOfflineBanner(html) {
  const banner = `
<div id="sw-offline-banner" style="
  position:fixed;top:0;left:0;right:0;z-index:9999;
  background:#D97706;color:white;
  text-align:center;padding:0.6rem 1rem;
  font-family:'DM Sans',sans-serif;font-size:0.9rem;font-weight:700;
  letter-spacing:0.02em;
">
  📡 Waiting for signal… posts will queue automatically.
</div>`;
  return html.replace('<body>', `<body>${banner}`);
}
