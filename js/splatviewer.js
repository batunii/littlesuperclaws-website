/* ============================================================
   Little Super Claws — splatviewer.js
   Renders real World Labs (Marble) Gaussian-splat worlds with
   Spark (Three.js/WebGL2) and places the crew's GLB characters
   inside them — pipeline: Marble world (.spz) + GLB figures.

   Exposes:
     window.__lscViewer.openWorld(world, locationName)  — scene modal
     window.__lscViewer.closeModal()
   And, if a pregenerated explore world exists (LSC_EXPLORE_WORLD),
   takes over the #explore canvas from the point-cloud city.
   ============================================================ */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---- The canon crew: GLB figures placed in every world ---- */
const CREW_MODELS = [
  { file: 'models/clawd.glb', name: 'Clawd',   height: 0.85 },
  { file: 'models/decklan.glb',   name: 'Decklan', height: 0.75 },
  { file: 'models/deirdre.glb',   name: 'Deirdre', height: 0.78 },
  { file: 'models/gerald.glb',    name: 'Gerald',  height: 0.72 },
  { file: 'models/nessa.glb',     name: 'Nessa',   height: 0.75 },
];

const gltfLoader = new GLTFLoader();
const gltfCache = new Map(); // file -> Promise<THREE.Group>

function loadCrewModel(file) {
  if (!gltfCache.has(file)) {
    const p = new Promise((resolve, reject) =>
      gltfLoader.load(file, g => resolve(g.scene), undefined, reject));
    // don't let a transient failure poison the cache permanently
    p.catch(() => gltfCache.delete(file));
    gltfCache.set(file, p);
  }
  return gltfCache.get(file);
}


/* ============================================================
   SplatScene — one renderer+scene that can show a Marble world
   with the crew standing in it. Used by the modal and #explore.
   ============================================================ */
class SplatScene {
  constructor(canvas, { autoDrift = false } = {}) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.6));
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.05, 600);
    this.camera.position.set(0, 0, 0);
    this.spark = new SparkRenderer({ renderer: this.renderer });
    this.scene.add(this.spark);

    // lights for the GLB figures (splats are unlit)
    this.scene.add(new THREE.AmbientLight(0xfff2e0, 1.1));
    const sun = new THREE.DirectionalLight(0xffe2b8, 1.6);
    sun.position.set(3, 6, 2);
    this.scene.add(sun);

    this.world = null;          // SplatMesh
    this.collider = null;       // invisible mesh for floor raycasts
    this.crew = [];             // { obj, baseY, phase }
    this.autoDrift = autoDrift;
    this.running = false;
    this.t = 0;

    // first-person look + move
    this.yaw = 0; this.pitch = 0;
    this.targetYaw = 0; this.targetPitch = 0;
    this.pos = new THREE.Vector3(0, 0, 0);
    this.keys = {};
    this._bindControls();
    this._resize = this._resize.bind(this);
    new ResizeObserver(this._resize).observe(canvas);
    this._resize();
  }

  _bindControls() {
    const c = this.canvas;
    let dragging = false, lx = 0, ly = 0;
    c.addEventListener('pointerdown', e => {
      dragging = true; lx = e.clientX; ly = e.clientY;
      c.setPointerCapture(e.pointerId);
      c.dispatchEvent(new CustomEvent('lsc-interact', { bubbles: true }));
    });
    c.addEventListener('pointermove', e => {
      if (!dragging) return;
      this.targetYaw   -= (e.clientX - lx) * 0.0032;
      this.targetPitch -= (e.clientY - ly) * 0.0026;
      this.targetPitch = Math.max(-1.1, Math.min(1.1, this.targetPitch));
      lx = e.clientX; ly = e.clientY;
    });
    const end = () => { dragging = false; };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('wheel', e => {
      e.preventDefault();
      const dir = new THREE.Vector3();
      this.camera.getWorldDirection(dir);
      this.pos.addScaledVector(dir, e.deltaY * -0.004);
    }, { passive: false });
    c.tabIndex = 0;
    c.addEventListener('keydown', e => { this.keys[e.key.toLowerCase()] = true; });
    c.addEventListener('keyup',   e => { this.keys[e.key.toLowerCase()] = false; });
  }

  _resize() {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.renderer.setSize(r.width, r.height, false);
    this.camera.aspect = r.width / r.height;
    this.camera.updateProjectionMatrix();
  }

  /* Load a Marble world (SplatMesh + collider) and stand the crew in it. */
  async loadWorld(world, { onProgress } = {}) {
    this.clearWorld();
    this.worldId = world.id || null;
    const wl = window.LSC_WL;
    const splatUrl = wl.pickSplatUrl(world);
    if (!splatUrl) throw new Error('World has no splat assets');

    const mesh = new SplatMesh({
      url: splatUrl,
      onProgress: ev => {
        if (onProgress && ev.lengthComputable) onProgress(ev.loaded / ev.total);
      },
    });
    // Gaussian splat convention (y-down, z-forward) → three.js y-up
    mesh.rotation.x = Math.PI;
    this.scene.add(mesh);
    this.world = mesh;
    await mesh.initialized;
    onProgress && onProgress(1);

    // collider mesh (invisible) lets us drop the crew onto the real floor
    const colUrl = wl.colliderUrl(world);
    if (colUrl) {
      try {
        const col = await new Promise((res, rej) => gltfLoader.load(colUrl, g => res(g.scene), undefined, rej));
        col.visible = false;
        col.rotation.x = Math.PI;
        this.scene.add(col);
        this.collider = col;
      } catch { /* floor fallback below */ }
    }
    return mesh;
  }

  _floorAt(x, z) {
    if (this.collider) {
      const ray = new THREE.Raycaster(new THREE.Vector3(x, 2.5, z), new THREE.Vector3(0, -1, 0), 0, 12);
      const hits = ray.intersectObject(this.collider, true);
      // ignore rooftop/wall-top hits (way above eye-level floor) and chasms
      const hit = hits.find(h => h.point.y < 0.4 && h.point.y > -4);
      if (hit) return hit.point.y;
    }
    return -1.45; // typical Marble eye-height floor
  }

  async _placeCrew() {
    const N = CREW_MODELS.length;
    // Crew spawn exactly at the world's origin (camera spawn point).
    // Camera steps back 1.5 units so the crew is right in front of it.
    const stepBack = 1.5;
    const xGap     = 0.80; // metres between figures in a row

    const floorY = this._floorAt(0, 0);
    // move camera back and tilt down to look at the crew
    this.pos.set(0, 0, stepBack);
    this.yaw = this.targetYaw = 0;
    this.pitch = this.targetPitch = Math.max(-0.55, Math.min(0,
      Math.atan2(floorY + 0.4, stepBack)));

    const promises = CREW_MODELS.map((cm, i) => {
      const x = (i - (N - 1) / 2) * xGap;
      const z = 0; // right at origin
      return loadCrewModel(cm.file).then(src => {
        if (this.disposed || !this.world) return null;
        const obj = src.clone();
        const box = new THREE.Box3().setFromObject(obj);
        const size = box.getSize(new THREE.Vector3());
        const s = cm.height / Math.max(size.y, 1e-5);
        obj.scale.setScalar(s);
        obj.userData.targetScale = s;
        box.setFromObject(obj);
        const y = this._floorAt(x, z) - box.min.y;
        obj.position.set(x, y, z);
        obj.lookAt(0, obj.position.y, stepBack); // face the camera
        obj.userData.spawn = this.t;
        this.scene.add(obj);
        this.crew.push({ obj, baseY: y, phase: i * 1.3, height: cm.height });
        return obj;
      }).catch(() => null);
    });

    // Once GLBs land, refine pitch to the actual floor height of placed crew
    Promise.all(promises).then(placed => {
      if (this.disposed) return;
      const objs = placed.filter(Boolean);
      if (!objs.length) return;
      const avg = new THREE.Vector3();
      objs.forEach(o => avg.add(o.position));
      avg.divideScalar(objs.length);
      const dy = (avg.y + 0.4) - this.pos.y;
      const dz = avg.z - this.pos.z;
      this.targetPitch = Math.max(-0.65, Math.min(0.2,
        Math.atan2(dy, Math.abs(dz))));
    });
  }

  clearWorld() {
    this.worldId = null;
    if (this.world) { this.scene.remove(this.world); this.world.dispose?.(); this.world = null; }
    if (this.collider) { this.scene.remove(this.collider); this.collider = null; }
    this.crew.forEach(c => this.scene.remove(c.obj));
    this.crew = [];
    this.pos.set(0, 0, 0);
    this.yaw = this.pitch = this.targetYaw = this.targetPitch = 0;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const tick = () => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(tick);
      this.t += reduceMotion ? 0 : 0.016;

      // smooth look
      this.yaw += (this.targetYaw - this.yaw) * 0.12;
      this.pitch += (this.targetPitch - this.pitch) * 0.12;
      if (this.autoDrift && !reduceMotion) this.targetYaw += 0.0006;

      // WASD / arrows walk
      const speed = 0.045;
      const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
      if (this.keys.w || this.keys.arrowup) this.pos.addScaledVector(fwd, speed);
      if (this.keys.s || this.keys.arrowdown) this.pos.addScaledVector(fwd, -speed);
      if (this.keys.a || this.keys.arrowleft) this.pos.addScaledVector(right, -speed);
      if (this.keys.d || this.keys.arrowright) this.pos.addScaledVector(right, speed);

      this.camera.position.copy(this.pos);
      this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');

      // crew idle: bob + sway + spawn pop-in
      this.crew.forEach(c => {
        if (reduceMotion) {
          // prefers-reduced-motion: skip animation entirely, show at full scale
          c.obj.scale.setScalar(c.obj.userData.targetScale);
          return;
        }
        const age = Math.min(1, (this.t - c.obj.userData.spawn) / 0.6);
        const pop = 1 - Math.pow(1 - age, 3);
        c.obj.scale.setScalar(c.obj.userData.targetScale * (0.001 + 0.999 * pop));
        c.obj.position.y = c.baseY + Math.sin(this.t * 1.8 + c.phase) * 0.025;
        c.obj.rotation.y += Math.sin(this.t * 0.9 + c.phase) * 0.0012;
      });

      this.renderer.render(this.scene, this.camera);
    };
    tick();
  }

  /* Re-place the crew in front of wherever the camera currently is.
     Called when the user presses the "Place crew here" button. */
  respawnCrew() {
    if (!this.world) return;
    this.crew.forEach(c => this.scene.remove(c.obj));
    this.crew = [];

    const N        = CREW_MODELS.length;
    const dist     = 1.5;   // metres ahead of camera
    const xGap     = 0.80;  // metres between figures
    const camPos   = this.pos.clone();   // snapshot so async callbacks stay consistent
    const camYaw   = this.yaw;

    // forward and right vectors from current yaw
    const fwdX  = -Math.sin(camYaw), fwdZ  = -Math.cos(camYaw);
    const rightX = -fwdZ,            rightZ =  fwdX;

    // crew cluster centre: dist metres ahead of camera
    const cx = camPos.x + fwdX * dist;
    const cz = camPos.z + fwdZ * dist;

    // tilt camera down toward where the crew will stand
    const floorSample = this._floorAt(cx, cz);
    this.targetPitch = Math.max(-0.55, Math.min(0,
      Math.atan2(floorSample + 0.4 - camPos.y, dist)));

    const promises = CREW_MODELS.map((cm, i) => {
      const x = cx + rightX * (i - (N - 1) / 2) * xGap;
      const z = cz + rightZ * (i - (N - 1) / 2) * xGap;
      return loadCrewModel(cm.file).then(src => {
        if (this.disposed || !this.world) return null;
        const obj = src.clone();
        const box  = new THREE.Box3().setFromObject(obj);
        const size = box.getSize(new THREE.Vector3());
        const s    = cm.height / Math.max(size.y, 1e-5);
        obj.scale.setScalar(s);
        obj.userData.targetScale = s;
        box.setFromObject(obj);
        const y = this._floorAt(x, z) - box.min.y;
        obj.position.set(x, y, z);
        obj.lookAt(camPos.x, obj.position.y, camPos.z); // face the camera
        obj.userData.spawn = this.t;
        this.scene.add(obj);
        this.crew.push({ obj, baseY: y, phase: i * 1.3, height: cm.height });
        return obj;
      }).catch(() => null);
    });

    // after all GLBs land, refine pitch to actual placed positions
    Promise.all(promises).then(placed => {
      if (this.disposed) return;
      const objs = placed.filter(Boolean);
      if (!objs.length) return;
      const avg = new THREE.Vector3();
      objs.forEach(o => avg.add(o.position));
      avg.divideScalar(objs.length);
      const dx = avg.x - this.pos.x, dz = avg.z - this.pos.z;
      const dy = (avg.y + 0.4) - this.pos.y;
      this.targetYaw   = Math.atan2(-dx, -dz);
      this.targetPitch = Math.max(-0.65, Math.min(0.2,
        Math.atan2(dy, Math.hypot(dx, dz))));
    });
  }

  stop() { this.running = false; cancelAnimationFrame(this.raf); }
  dispose() { this.stop(); this.clearWorld(); this.disposed = true; this.renderer.dispose(); }
}

/* ============================================================
   Scene-modal viewer
   ============================================================ */
let modalScene = null;

async function openWorld(world, locationName, onProgress) {
  const canvas = document.getElementById('smCanvas');
  if (!canvas) throw new Error('modal canvas missing');
  if (!modalScene) modalScene = new SplatScene(canvas, { autoDrift: true });
  modalScene.stop();
  await modalScene.loadWorld(world, { onProgress });
  canvas.classList.add('splat-ready');
  document.getElementById('smHud')?.removeAttribute('hidden');
  modalScene.start();
}

function closeModal() {
  modalScene?.stop();
  modalScene?.clearWorld();
  document.getElementById('smCanvas')?.classList.remove('splat-ready');
  document.getElementById('smHud')?.setAttribute('hidden', '');
}

/* Swap the big #explore section over to a world (used after the modal
   opens one, so the whole hero shows the visitor's chosen location). */
let exploreView = null;
async function showInExplore(world, name) {
  if (!exploreView || exploreView.disposed) return false;          // point-city fallback active
  if (world.id && exploreView.worldId === world.id) return true;   // already showing it
  try {
    await exploreView.loadWorld(world);
    if (name) {
      const kicker = document.querySelector('#explore .world-copy .kicker');
      if (kicker) kicker.textContent = `Now exploring: ${name} · live in your browser`;
    }
    return true;
  } catch (e) {
    console.warn('[LSC] explore swap failed:', e);
    return false;
  }
}

/* Load a named location directly into the explore section — used by portal
   pins so clicking them swaps the explore world without opening the modal. */
async function openLocationInExplore(name) {
  if (!exploreView || exploreView.disposed) {
    // explore not running (WebGL2 fallback), open in modal instead
    window.__lscGenerate && window.__lscGenerate(name);
    return;
  }
  const wl = window.LSC_WL;
  if (!wl) return;
  const kicker = document.querySelector('#explore .world-copy .kicker');
  if (kicker) kicker.textContent = `Loading ${name}…`;
  try {
    const resolved = wl.resolveWorldId(name);
    const world = resolved
      ? await wl.getWorld(resolved.worldId)
      : await wl.generateWorld(name, () => {});
    await showInExplore(world, name);
  } catch (e) {
    console.warn('[LSC] portal load failed:', e);
    if (kicker) kicker.textContent = 'Explore a splatted Dublin · live in your browser';
    window.__lscGenerate && window.__lscGenerate(name);
  }
}

function spawnCrewHere() {
  if (exploreView && !exploreView.disposed) exploreView.respawnCrew();
}

window.__lscViewer = { openWorld, closeModal, showInExplore, openLocationInExplore, spawnCrewHere, _debug: () => modalScene };

/* ============================================================
   #explore — replace the procedural point cloud with the real
   pregenerated Marble world (Liffey Quays) when available.
   ============================================================ */
const PORTALS = [
  { name: 'Temple Bar',       pos: [-2.6, 0.2, -5.5] },
  { name: "Ha'penny Bridge",  pos: [ 2.8, 0.3, -7.0] },
  { name: 'The Spire',        pos: [ 0.2, 0.6, -10.5] },
];

async function mountExplore() {
  const worldId = window.LSC_EXPLORE_WORLD;
  const canvas = document.getElementById('cityCanvas');
  const wl = window.LSC_WL;
  if (!worldId || !canvas || !wl) return false;

  let view;
  try {
    const world = await wl.getWorld(worldId);
    view = new SplatScene(canvas, { autoDrift: true });
    await view.loadWorld(world);
  } catch (e) {
    console.warn('[LSC] explore world failed, keeping point city:', e);
    view?.dispose();
    return false;
  }
  exploreView = view;

  // glowing portal rings inside the splat world (labels are HTML, projected per-frame)
  const portalsLayer = document.getElementById('worldPortals');
  const ringGeo = new THREE.TorusGeometry(0.55, 0.045, 16, 64);
  const portals = PORTALS.map((p, i) => {
    const mat = new THREE.MeshBasicMaterial({ color: 0x9a7bff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.95 });
    const ring = new THREE.Mesh(ringGeo, mat);
    ring.position.set(...p.pos);
    view.scene.add(ring);
    const label = document.createElement('button');
    label.className = 'world-portal-label';
    label.type = 'button';
    label.innerHTML = `<span>📍</span> ${p.name}`;
    label.addEventListener('click', () => openLocationInExplore(p.name));
    portalsLayer.appendChild(label);
    return { ring, label, phase: i * 1.7 };
  });

  const v = new THREE.Vector3();
  const origTick = view.start.bind(view);
  // piggyback portal animation + label projection on the render loop
  const animatePortals = () => {
    if (view.disposed) return;
    requestAnimationFrame(animatePortals);
    const r = canvas.getBoundingClientRect();
    portals.forEach(p => {
      const s = 1 + Math.sin(view.t * 1.6 + p.phase) * 0.08;
      p.ring.scale.setScalar(s);
      p.ring.lookAt(view.camera.position);
      v.copy(p.ring.position).project(view.camera);
      const behind = v.z > 1;
      const x = (v.x * 0.5 + 0.5) * r.width;
      const y = (-v.y * 0.5 + 0.5) * r.height - 30;
      if (behind || x < -40 || x > r.width + 40 || y < -40 || y > r.height + 40) {
        p.label.style.opacity = '0'; p.label.style.pointerEvents = 'none';
      } else {
        p.label.style.opacity = '1'; p.label.style.pointerEvents = 'auto';
        p.label.style.transform = `translate(-50%,-50%) translate(${x}px, ${y}px)`;
      }
    });
  };

  // time-of-day modes: grade the splat canvas (splats are baked, so use a filter)
  const FILTERS = {
    day: 'none',
    evening: 'sepia(0.18) saturate(1.12) brightness(0.95)',
    night: 'brightness(0.82) saturate(0.88) hue-rotate(10deg) contrast(1.06)',
    rain: 'brightness(0.85) saturate(0.72) hue-rotate(-14deg) contrast(1.04)',
  };
  window.__lscSetWorldMode = m => { canvas.style.filter = FILTERS[m] || 'none'; };
  const current = document.documentElement.getAttribute('data-mode') || 'day';
  window.__lscSetWorldMode(current);

  // pause off-screen
  const io = new IntersectionObserver(ents => ents.forEach(en => {
    if (en.isIntersecting) origTick(); else view.stop();
  }), { threshold: 0.02 });
  io.observe(canvas);

  origTick();
  animatePortals();
  document.getElementById('worldHint')?.classList.remove('hide');
  return true;
}

async function boot() {
  const ok = await mountExplore().catch(() => false);
  if (!ok && window.__lscStartPointCity) window.__lscStartPointCity();
}
if (document.readyState === 'loading') addEventListener('DOMContentLoaded', boot);
else boot();
