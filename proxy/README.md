# World Labs proxy

Keeps the Marble API key off the client. The browser talks to this Worker;
the Worker adds `WLT-Api-Key` and relays to `api.worldlabs.ai`.

```
browser ──► Worker (holds key) ──► api.worldlabs.ai
        ◄── JSON, incl. pre-signed asset URLs
browser ──────────────────────────► worldlabs CDN   (splats/pano/collider,
                                                     pre-signed, no key)
```

Only three routes exist. Everything else is a 404:

| Route | Notes |
|---|---|
| `GET /marble/v1/worlds/{id}` | refreshes expiring signed asset URLs |
| `GET /marble/v1/operations/{id}` | generation polling |
| `POST /marble/v1/worlds:generate` | body is `{"location": "Temple Bar"}` |

## Why generate takes a location, not a prompt

The proxy URL is public — anyone who views source can find it. If it relayed
arbitrary request bodies, a stranger could bill ~5-minute world generations to
your account with any prompt they liked. Instead the Worker accepts a short
place name, validates it, and builds the prompt itself (`buildPrompt` in
`src/worker.js`). The same template lives in `js/worldlabs.js`'s history; the
richer per-location prompts stay in `tools/pregen.py`, which runs locally with
the real key.

`ALLOW_GENERATE` is `"false"` by default, so out of the box the public site
serves only the pregenerated worlds in `js/worlds-manifest.js` and the
expensive path is unreachable.

## Storing the key with Infisical

Add it once:

```sh
infisical secrets set WORLDLABS_API_KEY=<new-key> --env=prod
```

Push it into the Worker's secret store (Cloudflare encrypts it at rest; it is
never in `wrangler.toml`, never in git, never sent to the browser):

```sh
infisical run --env=prod -- sh -c \
  'echo -n "$WORLDLABS_API_KEY" | npx wrangler secret put WORLDLABS_API_KEY'
```

Local development reads the same secret without writing it to disk:

```sh
infisical run --env=prod -- npx wrangler dev
```

`wrangler dev` also accepts a `.dev.vars` file, but that puts the key back on
your filesystem — `infisical run` is the reason not to.

## Deploy

```sh
npx wrangler deploy
```

Then set `ALLOWED_ORIGINS` in `wrangler.toml` to your real origins and put the
deployed URL into `js/config.js` as `worldLabs.base`.

## Rate limits

`READ_LIMITER` (120/min/IP) and `GENERATE_LIMITER` (2/min/IP) use Cloudflare's
rate-limiting binding. Note the `[[unsafe.bindings]]` block in
`wrangler.toml` — the API is still marked unstable by Cloudflare. If a binding
is absent, `overLimit()` in `src/worker.js` **fails open** (allows the request)
rather than breaking the site; with `ALLOW_GENERATE=false` that is a safe
default, but if you turn generation on, confirm the binding is live —
`wrangler tail` will show `rate_limited` responses once it is.

For a stronger gate on generation, put Cloudflare Turnstile in front of the
`POST` route so only a real visitor can trigger a build.

## Rotate first

The previous key was committed in `3205c46` and served in `js/config.js`.
Treat it as public: rotate at World Labs before deploying. No proxy can
retract a key that is already in git history.
