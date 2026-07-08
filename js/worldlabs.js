/* ============================================================
   Little Super Claws — worldlabs.js
   Real World Labs (Marble) API client. Classic script, no deps.

   Resolution order for a location query:
     1. pregenerated manifest (worlds-manifest.js → window.LSC_WORLDS)
     2. localStorage cache of previously live-generated worlds
     3. live generation via POST /worlds:generate (~5 min), then cached

   Signed asset URLs expire, so we always re-fetch world details by
   world ID right before viewing.
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
    const { base, apiKey } = CFG();
    const res = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'WLT-Api-Key': apiKey, 'Content-Type': 'application/json' },
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

  const getWorld = (worldId) => api(`/worlds/${worldId}`);

  function buildPrompt(loc) {
    return `Photorealistic street-level view of ${loc}, Dublin, Ireland: ` +
      `authentic Dublin architecture and atmosphere, cobblestones or paving, warm window light, ` +
      `moody Irish sky, golden hour, rich detail in every direction.`;
  }

  /* Live-generate a world for a location. onStatus(phase, detail) gets:
       'submitted' | 'progress' | 'done'   */
  async function generateWorld(loc, onStatus) {
    const { model } = CFG();
    const r = await api('/worlds:generate', {
      display_name: `LSC - ${loc}`,
      model: model || 'marble-1.1',
      world_prompt: { type: 'text', text_prompt: buildPrompt(loc) },
    });
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
