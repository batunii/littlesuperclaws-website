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
import {
  SparkRenderer, SplatMesh,
  SplatEdit, SplatEditSdf, SplatEditSdfType, SplatEditRgbaBlendMode,
} from '@sparkjsdev/spark';
import { ShadowRig, pickShadowTier, CHARACTER_SHADOW_LAYER } from './splat-shadows.js';
import { estimateWorldLighting, loadPanoTexture, panoEnvRotation, azElToDir } from './world-lighting.js';
import { createSunControl } from './sun-control.js';

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* Default sun ≈ the site's original fixed light at (3, 6, 2). */
const DEFAULT_SUN = {
  azimuth: Math.atan2(3, 2),          // ~0.983
  elevation: Math.asin(6 / 7),        // ~1.030
  intensity: 1.6,
  color: 0xffe2b8,
};

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
  constructor(canvas, { autoDrift = false, sunPadHost = null } = {}) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.6));
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.05, 600);
    this.camera.position.set(0, 0, 0);

    // shadow rig first: 'fragment' mode patches the SparkRenderer's display
    // shader at startup for pixel-sharp shadows (see splat-shadows.js)
    this.shadowTier = pickShadowTier();
    this.shadowRig = this.shadowTier.mapSize > 0
      ? new ShadowRig(this.renderer, this.scene, this.shadowTier)
      : null;

    this.spark = new SparkRenderer({ renderer: this.renderer });
    this.scene.add(this.spark);
    this.shadowRig?.attachDisplay(this.spark);

    // lights for the GLB figures (splats are unlit; the shadow rig +
    // world-lighting estimate drive these so crew shading matches the world)
    this.ambient = new THREE.AmbientLight(0xfff2e0, 1.1);
    this.scene.add(this.ambient);
    this.sunLight = new THREE.DirectionalLight(DEFAULT_SUN.color, DEFAULT_SUN.intensity);
    this.sunLight.position.set(3, 6, 2);
    this.scene.add(this.sunLight);

    // movable sun + real-time splat shadows (see splat-shadows.js)
    this.sunState = {
      azimuth: DEFAULT_SUN.azimuth,
      elevation: DEFAULT_SUN.elevation,
      intensity: DEFAULT_SUN.intensity,
      color: new THREE.Color(DEFAULT_SUN.color),
      source: 'default', // 'default' | 'estimated' | 'user'
    };
    this.aoEdit = null;         // SplatEdit holding per-character contact-AO SDFs
    this.worldLighting = null;  // last estimate from world-lighting.js
    this.stylePreset = 'world'; // 'world' (match estimate) | 'clay' (soft stop-motion)
    this.panoUrl = null;
    this.sunPad = sunPadHost
      ? createSunControl(sunPadHost, {
          get: () => this.sunState,
          set: (az, el) => this.setSun(az, el, 'user'),
          reset: () => this.resetSunToWorld(),
        })
      : null;

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

    // real-time splat shadows: crew depth pass → per-pixel darkening
    // ('fragment' mode is already patched in; attach() also wires the
    // per-splat fallback mode's worldModifier when active)
    this.shadowRig?.attach(mesh);
    // Prime the crew shadow map so the patched splat display shader always
    // samples a COMPLETE sampler2DShadow. WebGL2 validates every bound
    // sampler at draw time even when the shader branch that reads it is
    // skipped (shadows off / no crew yet) — an unrendered depth target is
    // incomplete → GL_INVALID_OPERATION → the whole splat draw is dropped
    // → completely black world. The depth pass in frame() only runs once
    // crew exist, so without this the world stays black until then. One
    // bare clear allocates + completes the depth texture.
    this._primeShadowMap();
    this._ensureAoEdit();
    this._applySun();
    this.sunPad?.show(true);
    this.sunPad?.sync();

    // estimate the world's lighting from its pano (async, never blocks
    // the reveal; guarded so a stale estimate can't touch a newer world)
    this.panoUrl = wl.panoUrl ? wl.panoUrl(world) : null;
    if (this.panoUrl) {
      const wid = this.worldId;
      const pUrl = this.panoUrl;
      const kick = () => {
        estimateWorldLighting(pUrl, wid || pUrl).then((est) => {
          if (!est || this.disposed || this.worldId !== wid) return;
          this.worldLighting = est;
          this._applyWorldLighting(est);
          return loadPanoTexture(pUrl).then((tex) => {
            if (this.disposed || this.worldId !== wid) return;
            this.scene.environment = tex;
            this.scene.environmentRotation.copy(panoEnvRotation());
            this.scene.environmentIntensity = 1.1;
          });
        }).catch(() => {});
      };
      if ('requestIdleCallback' in window) requestIdleCallback(kick, { timeout: 2000 });
      else setTimeout(kick, 50);
    }
    return mesh;
  }

  /* ---- sun + world-lighting plumbing (shadows live in splat-shadows.js) ---- */

  _applySun() {
    const s = this.sunState;
    const dir = azElToDir(s.azimuth, s.elevation);
    this.sunLight.position.copy(dir).multiplyScalar(8);
    this.sunLight.color.copy(s.color);
    this.sunLight.intensity = s.intensity;
    this.shadowRig?.setSunDir(dir);
    this._lightArrow?.setDirection(dir);
  }

  setSun(azimuth, elevation, source = 'user') {
    this.sunState.azimuth = azimuth;
    this.sunState.elevation = elevation;
    if (source) this.sunState.source = source;
    this._applySun();
    this.sunPad?.sync();
  }

  resetSunToWorld() {
    this.sunState.source = 'default';
    if (this.worldLighting) this._applyWorldLighting(this.worldLighting, true);
    else {
      this.sunState.azimuth = DEFAULT_SUN.azimuth;
      this.sunState.elevation = DEFAULT_SUN.elevation;
      this.sunState.intensity = DEFAULT_SUN.intensity;
      this.sunState.color.set(DEFAULT_SUN.color);
      this._applySun();
    }
    this.sunPad?.sync();
  }

  _applyWorldLighting(est, force = false) {
    if (!est) return;
    if (!force && this.sunState.source === 'user') return; // never fight the user
    const s = this.sunState;
    s.azimuth = est.azimuth;
    s.elevation = est.elevation;
    s.intensity = est.sunIntensity;
    s.color.copy(est.sunColor);
    s.source = 'estimated';
    this.ambient.color.copy(est.ambientColor);
    this.ambient.intensity = 0.35; // env map carries most of the fill
    if (this.shadowRig && this.stylePreset === 'world') {
      this.shadowRig.setStrength(est.shadowStrength);
      this.shadowRig.setPenumbraTexels(est.penumbraTexels);
      this.shadowRig.setTint(est.shadowTint);
    }
    this._applySun();
    this.sunPad?.sync();
  }

  /* 'world' = match the estimated lighting; 'clay' = soft warm
     stop-motion-studio shadows; 'crisp' = hard game-style sun. */
  setStylePreset(name) {
    this.stylePreset = name;
    if (!this.shadowRig) return;
    if (name === 'clay') {
      this.shadowRig.setStrength(0.6);
      this.shadowRig.setPenumbraTexels(3);
      this.shadowRig.setTint(0.45, 0.38, 0.33);
    } else if (name === 'crisp') {
      this.shadowRig.setStrength(0.9);
      this.shadowRig.setPenumbraTexels(0.6);
      this.shadowRig.setTint(0.15, 0.16, 0.2);
    } else if (this.worldLighting) {
      this.shadowRig.setStrength(this.worldLighting.shadowStrength);
      this.shadowRig.setPenumbraTexels(this.worldLighting.penumbraTexels);
      this.shadowRig.setTint(this.worldLighting.shadowTint);
    } else {
      this.shadowRig.setStrength(0.75);
      this.shadowRig.setPenumbraTexels(1.2);
      this.shadowRig.setTint(0.24, 0.26, 0.32);
    }
  }

  /* One-time init of the crew depth target so its DepthTexture is a
     complete sampler2DShadow before the patched splat shader ever samples
     it (see the call site in loadWorld). A bare clear is enough; the depth
     pass in frame() takes over once crew exist. No-op when the rig/RT is
     absent (shadow tier 'off' → shader isn't patched, so no sampler to
     complete). */
  _primeShadowMap() {
    const rt = this.shadowRig?.rt;
    if (!rt) return;
    const r = this.renderer;
    const prevRT = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    r.setRenderTarget(rt);
    r.clear(true, true, false);
    r.setRenderTarget(prevRT);
    r.autoClear = prevAutoClear;
  }

  /* ---- contact-AO: soft SplatEdit blobs planted under each figure ---- */

  _ensureAoEdit() {
    if (this.aoEdit) return;
    this.aoEdit = new SplatEdit({
      name: 'lsc-contact-ao',
      rgbaBlendMode: SplatEditRgbaBlendMode.MULTIPLY,
      softEdge: 0.12,
      sdfSmooth: 0,
    });
    this.scene.add(this.aoEdit);
  }

  _addCrewAo(entry) {
    if (!this.aoEdit) return;
    const footR = 0.30 * (entry.height || 0.75);
    const sdf = new SplatEditSdf({
      type: SplatEditSdfType.ELLIPSOID,
      color: new THREE.Color(0.45, 0.44, 0.48),
      opacity: 1,
      radius: 0.02,
    });
    sdf.scale.set(footR * 1.1, 0.10, footR * 1.1);
    // planted at the GROUND point (not the bobbing model) so the blob
    // stays put and Spark doesn't re-apply edits every frame
    sdf.position.set(entry.obj.position.x, entry.baseY + 0.02, entry.obj.position.z);
    this.aoEdit.add(sdf);
    entry.aoSdf = sdf;
  }

  _removeCrewAo(entry) {
    if (entry.aoSdf) {
      this.aoEdit?.remove(entry.aoSdf);
      entry.aoSdf = null;
    }
  }

  /* Debug: show the pano as the background + an arrow along the
     estimated sun direction — used once to calibrate PANO_CALIBRATION. */
  async lightDebug(on = true) {
    if (on) {
      if (this.panoUrl) {
        try {
          const tex = await loadPanoTexture(this.panoUrl);
          this.scene.background = tex;
          this.scene.backgroundRotation.copy(panoEnvRotation());
        } catch { /* keep splat background */ }
      }
      if (!this._lightArrow) {
        this._lightArrow = new THREE.ArrowHelper(
          azElToDir(this.sunState.azimuth, this.sunState.elevation),
          new THREE.Vector3(0, -0.6, -1.5), 1.4, 0xf2b23e, 0.25, 0.12);
        this.scene.add(this._lightArrow);
      }
      this._lightArrow.setDirection(azElToDir(this.sunState.azimuth, this.sunState.elevation));
      this.shadowRig?.showFrustumHelper(true);
    } else {
      this.scene.background = null;
      if (this._lightArrow) {
        this.scene.remove(this._lightArrow);
        this._lightArrow.dispose();
        this._lightArrow = null;
      }
      this.shadowRig?.showFrustumHelper(false);
    }
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
        obj.userData.lscBox = box.clone(); // raw local bounds for the shadow rig
        const size = box.getSize(new THREE.Vector3());
        const s = cm.height / Math.max(size.y, 1e-5);
        obj.scale.setScalar(s);
        obj.userData.targetScale = s;
        box.setFromObject(obj);
        const y = this._floorAt(x, z) - box.min.y;
        obj.position.set(x, y, z);
        obj.lookAt(0, obj.position.y, stepBack); // face the camera
        obj.userData.spawn = this.t;
        obj.traverse(o => o.layers.enable(CHARACTER_SHADOW_LAYER));
        this.scene.add(obj);
        const entry = { obj, baseY: y, phase: i * 1.3, height: cm.height };
        this.crew.push(entry);
        this._addCrewAo(entry);
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
    this.shadowRig?.detach();
    if (this.world) { this.scene.remove(this.world); this.world.dispose?.(); this.world = null; }
    if (this.collider) { this.scene.remove(this.collider); this.collider = null; }
    this.crew.forEach(c => { this._removeCrewAo(c); this.scene.remove(c.obj); });
    this.crew = [];
    this.worldLighting = null;
    this.panoUrl = null;
    this.scene.environment = null;
    this.scene.background = null;
    this.ambient.color.set(0xfff2e0);
    this.ambient.intensity = 1.1;
    this.sunState.source = 'default';
    this.resetSunToWorld();
    this.sunPad?.show(false);
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

      // crew depth pass from the sun + shadow uniforms (depth render is
      // gated internally: only re-runs when crew/sun/params actually moved;
      // the camera matrix uniform updates every frame for free)
      this.shadowRig?.frame(this.crew.map(c => c.obj), this.camera);

      this.renderer.render(this.scene, this.camera);
    };
    tick();
  }

  /* Re-place the crew in front of wherever the camera currently is.
     Called when the user presses the "Place crew here" button. */
  respawnCrew() {
    if (!this.world) return;
    this.crew.forEach(c => { this._removeCrewAo(c); this.scene.remove(c.obj); });
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
        obj.userData.lscBox = box.clone(); // raw local bounds for the shadow rig
        const size = box.getSize(new THREE.Vector3());
        const s    = cm.height / Math.max(size.y, 1e-5);
        obj.scale.setScalar(s);
        obj.userData.targetScale = s;
        box.setFromObject(obj);
        const y = this._floorAt(x, z) - box.min.y;
        obj.position.set(x, y, z);
        obj.lookAt(camPos.x, obj.position.y, camPos.z); // face the camera
        obj.userData.spawn = this.t;
        obj.traverse(o => o.layers.enable(CHARACTER_SHADOW_LAYER));
        this.scene.add(obj);
        const entry = { obj, baseY: y, phase: i * 1.3, height: cm.height };
        this.crew.push(entry);
        this._addCrewAo(entry);
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
  dispose() {
    this.stop();
    this.clearWorld();
    this.disposed = true;
    this.shadowRig?.dispose();
    this.shadowRig = null;
    if (this.aoEdit) { this.scene.remove(this.aoEdit); this.aoEdit = null; }
    this.sunPad?.dispose();
    this.sunPad = null;
    this.renderer.dispose();
  }
}

/* ============================================================
   Scene-modal viewer
   ============================================================ */
let modalScene = null;

async function openWorld(world, locationName, onProgress) {
  const canvas = document.getElementById('smCanvas');
  if (!canvas) throw new Error('modal canvas missing');
  if (!modalScene) {
    modalScene = new SplatScene(canvas, {
      autoDrift: true,
      sunPadHost: document.getElementById('smStage') || undefined,
    });
  }
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

window.__lscViewer = {
  openWorld, closeModal, showInExplore, openLocationInExplore, spawnCrewHere,
  _debug: () => modalScene,
  _explore: () => exploreView,
  _shadows: () => ({
    modal: modalScene?.shadowRig ?? null,
    explore: exploreView?.shadowRig ?? null,
  }),
  _lighting: () => ({
    modal: modalScene?.worldLighting ?? null,
    explore: exploreView?.worldLighting ?? null,
  }),
  /* calibration overlay: pano background + sun arrow + light frustum */
  _lightDebug: (on = true, which = 'explore') =>
    (which === 'modal' ? modalScene : exploreView)?.lightDebug(on),
  _preset: (name = 'clay', which = 'explore') =>
    (which === 'modal' ? modalScene : exploreView)?.setStylePreset(name),
};

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
    view = new SplatScene(canvas, {
      autoDrift: true,
      sunPadHost: document.getElementById('explore') || undefined,
    });
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
