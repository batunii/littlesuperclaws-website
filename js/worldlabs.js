/* ============================================================
   Little Super Claws — worldlabs.js
   World Labs (Marble) client. Classic script, no deps.
   All calls go through the proxy Worker (see proxy/), which holds the
   API key server-side — no credential is ever present in this file.

   Resolution order for a location query:
     1. pregenerated manifest (worlds-manifest.js → window.LSC_WORLDS)
     2. localStorage cache of previously live-generated worlds
     3. live generation via POST /worlds:generate (~5 min), then cached

   Asset delivery, in order:
     a. worlds-local.js → same-origin files in worlds/, no key needed
     b. the proxy Worker, which re-signs expiring URLs per view

   With (a) alone the site is fully static and public; (b) is only needed
   for worlds that were never vendored, and for live generation.
   ============================================================ */
(function () {
  'use strict';
  const CFG = () => (window.LSC_CONFIG && window.LSC_CONFIG.worldLabs) || {};
  const CACHE_KEY = 'lsc-world-cache-v1';

  const norm = (s) => (s || '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  function readCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; }
    catch { return {}; }
  }
  function writeCache(c) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch {}
  }

  /* Find a pregenerated or cached world ID for a free-typed location. */
  function resolveWorldId(query) {
    const q = norm(query);
    if (!q) return null;
    const manifest = window.LSC_WORLDS || {};
    for (const slug of Object.keys(manifest)) {
      const w = manifest[slug];
      const names = [norm(w.name), ...(w.aliases || []).map(norm)];
      if (names.some(n => n && (q === n || q.includes(n) || n.includes(q)))) {
        return { worldId: w.worldId, pregenerated: true, name: w.name };
      }
    }
    const cached = readCache()[q];
    if (cached) return { worldId: cached.worldId, pregenerated: false, name: cached.name };
    return null;
  }

  async function api(path, body) {
    const { base } = CFG();
    const res = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      const err = new Error(`World Labs API ${res.status}: ${txt.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  /* ---- locally vendored worlds (tools/vendor_worlds.py) ----
     If a world's assets sit in worlds/, we synthesise the same object shape
     the API returns and never touch the network. This is what makes the
     pregenerated worlds work on a plain static host with no API key. */

  function localRecord(worldId) {
    const local = window.LSC_WORLDS_LOCAL || {};
    const manifest = window.LSC_WORLDS || {};
    for (const slug of Object.keys(local)) {
      const m = manifest[slug];
      if (m && m.worldId === worldId) return local[slug];
    }
    return null;
  }

  /* Same shape as GET /worlds/{id}, so every consumer is unchanged. */
  function synthWorld(worldId, rec) {
    return {
      id: worldId,
      local: true,
      assets: {
        splats: { spz_urls: rec.spz_urls || {} },
        mesh: rec.collider_mesh_url ? { collider_mesh_url: rec.collider_mesh_url } : {},
        imagery: rec.pano_url ? { pano_url: rec.pano_url } : {},
        thumbnail_url: rec.thumbnail_url || null,
      },
    };
  }

  const hasProxy = () => {
    const b = CFG().base;
    return !!b && !/YOUR-SUBDOMAIN/.test(b);
  };

  async function getWorld(worldId) {
    const rec = localRecord(worldId);
    if (rec) return synthWorld(worldId, rec);
    if (!hasProxy()) {
      throw new Error(
        'This world is not vendored locally and no proxy is configured. ' +
        'Run tools/vendor_worlds.py, or set worldLabs.base in js/config.js.');
    }
    return api(`/worlds/${worldId}`);
  }

  /* Live-generate a world for a location. onStatus(phase, detail) gets:
       'submitted' | 'progress' | 'done'   */
  async function generateWorld(loc, onStatus) {
    if (!hasProxy()) {
      throw new Error(
        'Live world generation needs the proxy Worker (see proxy/README.md). ' +
        'Only the pregenerated Dublin worlds are available on this deployment.');
    }
    const r = await api('/worlds:generate', { location: loc });
    onStatus && onStatus('submitted', r.operation_id);

    const started = Date.now();
    for (;;) {
      await new Promise(t => setTimeout(t, 10000));
      let op;
      try { op = await api(`/operations/${r.operation_id}`); }
      catch (e) { onStatus && onStatus('progress', 'retrying…'); continue; }
      if (op.done) {
        if (op.error) throw new Error('Generation failed: ' + JSON.stringify(op.error).slice(0, 150));
        const world = op.response || op.result;
        const worldId = (world && world.id) || (op.metadata && op.metadata.world_id);
        const cache = readCache();
        cache[norm(loc)] = { worldId, name: loc, at: Date.now() };
        writeCache(cache);
        onStatus && onStatus('done', worldId);
        return world && world.assets ? world : getWorld(worldId);
      }
      const mins = Math.round((Date.now() - started) / 6000) / 10;
      const desc = (op.metadata && op.metadata.progress && op.metadata.progress.description) || 'World generation in progress';
      onStatus && onStatus('progress', `${desc} · ${mins} min elapsed`);
    }
  }

  /* Pick the best splat URL for this device from a world's assets. */
  function pickSplatUrl(world) {
    const spz = world && world.assets && world.assets.splats && world.assets.splats.spz_urls;
    if (!spz) return null;
    const small = matchMedia('(pointer: coarse)').matches || (navigator.deviceMemory && navigator.deviceMemory <= 4);
    return small ? (spz['100k'] || spz['500k'] || spz.full_res)
                 : (spz['500k'] || spz.full_res || spz['100k']);
  }

  const colliderUrl = (world) =>
    (world && world.assets && world.assets.mesh && world.assets.mesh.collider_mesh_url) || null;

  /* Equirect pano — the world's only lighting evidence (used for
     light estimation + character IBL by splatviewer/world-lighting). */
  const panoUrl = (world) =>
    (world && world.assets && world.assets.imagery && world.assets.imagery.pano_url) || null;

  window.LSC_WL = { resolveWorldId, getWorld, generateWorld, pickSplatUrl, colliderUrl, panoUrl, norm };
})();
