/**
 * Cloudflare Worker — CORS proxy for HQ Dashboard.
 *
 * Deployment:
 *   1. Go to https://dash.cloudflare.com → Workers & Pages → Create
 *   2. Click "Create Worker", paste this code, deploy
 *   3. Note the URL (e.g. https://hq-proxy.<you>.workers.dev)
 *   4. In index.html, set PROXY_URL to that URL + '/?url='
 *
 * Features:
 *   - Whitelisted API domains only
 *   - Cloudflare Cache API (60s) to avoid upstream rate-limits
 *   - Realistic User-Agent for Yahoo Finance compatibility
 */

/* Exact origins + localhost/127.0.0.1 with any port are allowed */
const EXACT_ORIGINS = new Set([
  'https://arthurschonbach.github.io',
]);

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (EXACT_ORIGINS.has(origin)) return true;
  // Allow any localhost / 127.0.0.1 origin (with or without port)
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

const ALLOWED_API_HOSTS = [
  'query1.finance.yahoo.com',
  'query2.finance.yahoo.com',
  'gamma-api.polymarket.com',
  'clob.polymarket.com',
];

/* Cache TTL per host (seconds) */
const CACHE_TTL = {
  'query1.finance.yahoo.com': 120,   // 2 min — market data doesn't change every second
  'query2.finance.yahoo.com': 120,
  'gamma-api.polymarket.com': 60,
  'clob.polymarket.com': 60,
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return handlePreflight(request);
    }

    const url = new URL(request.url);
    const target = url.searchParams.get('url');

    if (!target) {
      return corsResponse(JSON.stringify({ error: 'Missing ?url= parameter' }), 400, request);
    }

    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch {
      return corsResponse(JSON.stringify({ error: 'Invalid URL' }), 400, request);
    }

    if (!ALLOWED_API_HOSTS.includes(targetUrl.hostname)) {
      return corsResponse(JSON.stringify({ error: 'Host not allowed' }), 403, request);
    }

    /* ── Check Cloudflare Cache first ── */
    const cacheKey = new Request(request.url, request);
    const cache = caches.default;
    let cached = await cache.match(cacheKey);
    if (cached) {
      /* Re-stamp CORS headers (cache strips them) */
      const resp = new Response(cached.body, cached);
      setCorsHeaders(resp.headers, request);
      return resp;
    }

    /* ── Fetch upstream ── */
    try {
      const ttl = CACHE_TTL[targetUrl.hostname] || 60;

      const apiResponse = await fetch(target, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': 'application/json,text/plain,*/*',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        cf: { cacheTtl: ttl },
      });

      const body = await apiResponse.text();

      const resp = new Response(body, {
        status: apiResponse.status,
        headers: {
          'Content-Type': apiResponse.headers.get('Content-Type') || 'application/json',
          'Cache-Control': `public, max-age=${ttl}`,
        },
      });
      setCorsHeaders(resp.headers, request);

      /* Store in CF cache (non-blocking) */
      if (apiResponse.ok) {
        const cacheResp = resp.clone();
        request.ctx?.waitUntil?.(cache.put(cacheKey, cacheResp));
      }

      return resp;
    } catch (err) {
      return corsResponse(
        JSON.stringify({ error: 'Upstream fetch failed', detail: err.message }),
        502, request
      );
    }
  },
};

function getAllowedOrigin(request) {
  const origin = request.headers.get('Origin') || '';
  /* Return the exact origin the browser sent — required for CORS to work */
  return isAllowedOrigin(origin) ? origin : 'https://arthurschonbach.github.io';
}

function setCorsHeaders(headers, request) {
  headers.set('Access-Control-Allow-Origin', getAllowedOrigin(request));
  headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
}

function corsResponse(body, status, request) {
  const resp = new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
  setCorsHeaders(resp.headers, request);
  return resp;
}

function handlePreflight(request) {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': getAllowedOrigin(request),
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}
