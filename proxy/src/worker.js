/* ============================================================
   Little Super Claws — World Labs proxy (Cloudflare Worker)

   The browser never sees the Marble API key. It calls this Worker,
   the Worker adds `WLT-Api-Key` from its secret store and relays to
   api.worldlabs.ai.

   Only three endpoints are reachable, and /worlds:generate takes a
   bare location string — the prompt is built here, server-side, so a
   stranger with the proxy URL cannot use your quota as a
   general-purpose world generator.
   ============================================================ */

const UPSTREAM = 'https://api.worldlabs.ai/marble/v1';
const PREFIX = '/marble/v1';
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/* ---------- request classification ---------- */

function classify(pathname, method) {
  const p = pathname.startsWith(PREFIX) ? pathname.slice(PREFIX.length) : pathname;

  if (p === '/worlds:generate') {
    return method === 'POST' ? { kind: 'generate' } : null;
  }
  let m = p.match(/^\/worlds\/([^/]+)$/);
  if (m && ID.test(m[1]) && method === 'GET') {
    return { kind: 'read', path: `/worlds/${m[1]}` };
  }
  m = p.match(/^\/operations\/([^/]+)$/);
  if (m && ID.test(m[1]) && method === 'GET') {
    return { kind: 'read', path: `/operations/${m[1]}` };
  }
  return null;
}

/* ---------- CORS ---------- */

function allowedOrigins(env) {
  return (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function corsHeaders(origin, env) {
  const h = {
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
  if (origin && allowedOrigins(env).includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
  }
  return h;
}

function json(body, status, origin, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin, env) },
  });
}

/* ---------- prompt construction (server-side on purpose) ---------- */

function buildPrompt(location) {
  return `Photorealistic street-level view of ${location}, Dublin, Ireland: ` +
    `authentic Dublin architecture and atmosphere, cobblestones or paving, warm window light, ` +
    `moody Irish sky, golden hour, rich detail in every direction.`;
}

/* A location is a short, plain place name — not a prompt. Anything that
   looks like smuggled prompt text (newlines, control chars, a sentence's
   worth of words) is refused rather than trimmed. */
function cleanLocation(raw) {
  if (typeof raw !== 'string') return null;
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null; // incl. newlines
  const s = raw.replace(/ {2,}/g, ' ').trim();
  if (s.length < 2 || s.length > 60) return null;
  if (!/^[\p{L}\p{N} '&.,\-]+$/u.test(s)) return null;
  if (s.split(' ').length > 6) return null; // "St Stephen's Green", not a sentence
  return s;
}

/* ---------- rate limiting ---------- */

async function overLimit(limiter, key) {
  if (!limiter) return false; // binding not configured — fail open, see README
  const { success } = await limiter.limit({ key });
  return !success;
}

/* ---------- handler ---------- */

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
    }

    // Browser calls must come from an allowlisted origin. Requests with no
    // Origin at all (curl, server-side) are refused too — this proxy exists
    // only to serve the site.
    const allow = allowedOrigins(env);
    if (!origin || !allow.includes(origin)) {
      return json({ error: 'origin_not_allowed' }, 403, origin, env);
    }

    const route = classify(url.pathname, request.method);
    if (!route) {
      return json({ error: 'not_found' }, 404, origin, env);
    }

    if (!env.WORLDLABS_API_KEY) {
      return json({ error: 'proxy_misconfigured' }, 500, origin, env);
    }

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

    let upstreamPath, upstreamBody = null;

    if (route.kind === 'generate') {
      if (String(env.ALLOW_GENERATE) !== 'true') {
        return json({ error: 'generation_disabled' }, 403, origin, env);
      }
      if (await overLimit(env.GENERATE_LIMITER, ip)) {
        return json({ error: 'rate_limited' }, 429, origin, env);
      }

      let payload;
      try { payload = await request.json(); }
      catch { return json({ error: 'invalid_json' }, 400, origin, env); }

      const location = cleanLocation(payload && payload.location);
      if (!location) {
        return json({ error: 'invalid_location' }, 400, origin, env);
      }

      upstreamPath = '/worlds:generate';
      upstreamBody = {
        display_name: `LSC - ${location}`,
        model: env.MARBLE_MODEL || 'marble-1.1',
        world_prompt: { type: 'text', text_prompt: buildPrompt(location) },
      };
    } else {
      if (await overLimit(env.READ_LIMITER, ip)) {
        return json({ error: 'rate_limited' }, 429, origin, env);
      }
      upstreamPath = route.path;
    }

    let upstream;
    try {
      upstream = await fetch(UPSTREAM + upstreamPath, {
        method: upstreamBody ? 'POST' : 'GET',
        headers: {
          'WLT-Api-Key': env.WORLDLABS_API_KEY,
          'Content-Type': 'application/json',
        },
        body: upstreamBody ? JSON.stringify(upstreamBody) : undefined,
      });
    } catch {
      return json({ error: 'upstream_unreachable' }, 502, origin, env);
    }

    // Relay status + body, but only our own headers go back to the browser.
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...corsHeaders(origin, env),
      },
    });
  },
};
