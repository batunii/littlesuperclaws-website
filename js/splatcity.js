/* ============================================================
   Little Super Claws — splatcity.js
   A live WebGL "splatted Dublin": an interactive point-cloud
   city with glowing 3D portals, themed by time of day.
   Stand-in for the Gaussian-splat world the agents generate.
   ============================================================ */
import * as THREE from 'three';

const canvas = document.getElementById('cityCanvas');
const portalsLayer = document.getElementById('worldPortals');
const fallback = document.getElementById('worldFallback');
if (!canvas) { /* nothing to do */ }

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---- Mode palettes (linear-ish sRGB hexes) ---- */
const PALETTES = {
  day:     { fog:0xf3e7d2, ground:0xb9a589, b1:0xd8c3a0, b2:0xc98f63, win:0xfff3cf, winAmt:0.06, glow:0xf2b23e, sky:0.0,  dust:0xfff1d6, portal:[0x7c5ce0,0xe87fb6,0xf2b23e] },
  evening: { fog:0x4a3576, ground:0x5b4a85, b1:0x8160a8, b2:0xc56a3e, win:0xffd27a, winAmt:0.20, glow:0xff9a4d, sky:0.0,  dust:0xffcaa0, portal:[0xb98cff,0xff8fc4,0xffb44d] },
  night:   { fog:0x1d1a4d, ground:0x352f78, b1:0x483e9a, b2:0x3b3486, win:0xffe6a3, winAmt:0.34, glow:0x9a7bff, sky:0.0,  dust:0xc4b4ff, portal:[0x9a7bff,0xff7fb6,0xffd05a] },
  rain:    { fog:0x20304f, ground:0x2f4868, b1:0x3d5a86, b2:0x365586, win:0xbfe0ff, winAmt:0.22, glow:0x6fd0ff, sky:0.0,  dust:0x9fc4ff, portal:[0x6fa8ff,0x8fd0ff,0xb0e0ff] },
};

const PORTAL_NAMES = ['Temple Bar', "Ha'penny Bridge", 'The Spire'];

let renderer, scene, camera, cityPts, glowPts, portals = [], dustGeo;
let cityMeta, glowMeta;        // {type, t, base} arrays for recolour
let running = false, raf = 0;
let mode = document.documentElement.getAttribute('data-mode') || 'day';

/* ---- round soft sprite for points ---- */
function discTexture() {
  const s = 64, c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(s/2, s/2, 0, s/2, s/2, s/2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.45, 'rgba(255,255,255,0.85)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* deterministic-ish rng so the city is stable across reloads */
let seed = 20260607;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

function buildCity() {
  const sprite = discTexture();

  // ---- structural points (ground + buildings) ----
  const pos = [], type = [], rfac = [];
  const W = 26, D = 60;            // city extent
  const RIVER = 2.2;              // half-width of the central street/river gap

  // ground / cobbles / river
  for (let i = 0; i < 9000; i++) {
    const x = (rnd() * 2 - 1) * W;
    const z = -rnd() * D + 8;
    const nearRiver = Math.abs(x) < RIVER;
    const y = nearRiver ? -0.05 + rnd() * 0.05 : rnd() * 0.12;
    pos.push(x, y, z);
    type.push(nearRiver ? 3 : 0);   // 3 = river
    rfac.push(rnd());
  }

  // buildings down both sides of the street
  const place = (bx, bz, sx, sz, h, landmark) => {
    const vol = sx * sz * h;
    const n = Math.min(1200, Math.floor(vol * 34));
    for (let i = 0; i < n; i++) {
      // bias points toward shell/edges for a "scanned" look
      const edge = rnd() < 0.72;
      const ex = edge && rnd() < 0.5 ? (rnd() < 0.5 ? -0.5 : 0.5) : rnd() - 0.5;
      const ez = edge && rnd() >= 0.5 ? (rnd() < 0.5 ? -0.5 : 0.5) : rnd() - 0.5;
      const px = bx + ex * sx;
      const pz = bz + ez * sz;
      const py = Math.pow(rnd(), 0.85) * h;
      pos.push(px, py, pz);
      // window lights: small fraction, more in upper portion
      const isWin = rnd() < 0.16 && py > 0.5;
      type.push(isWin ? 2 : (landmark ? 4 : 1)); // 4 = landmark stone
      rfac.push(rnd());
    }
  };

  let z = 7;
  while (z > -D) {
    const gap = 1.8 + rnd() * 1.6;
    const depth = 1.5 + rnd() * 1.7;
    // left side — front row hugs the street, taller for drama
    const lh = 3 + rnd() * 8;
    place(-(RIVER + 0.9 + rnd() * 1.4), z, 1.4 + rnd() * 1.2, depth, lh, false);
    place(-(RIVER + 3.0 + rnd() * 3.0), z + rnd(), 1.4 + rnd() * 1.3, depth, 2 + rnd() * 6, false);
    // right side
    const rh = 3 + rnd() * 8;
    place(RIVER + 0.9 + rnd() * 1.4, z, 1.4 + rnd() * 1.2, depth, rh, false);
    place(RIVER + 3.0 + rnd() * 3.0, z + rnd(), 1.4 + rnd() * 1.3, depth, 2 + rnd() * 6, false);
    z -= depth + gap;
  }
  // a couple of taller landmarks (spire-ish)
  place(-5.5, -16, 1.0, 1.0, 13, true);
  place(6.0, -30, 1.2, 1.2, 11, true);
  place(0.0, -46, 0.5, 0.5, 16, true); // distant spire on the axis

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(pos.length), 3));
  cityMeta = { type, rfac, count: type.length };

  const m = new THREE.PointsMaterial({
    size: 0.11, map: sprite, vertexColors: true, transparent: true,
    alphaTest: 0.04, depthWrite: true, sizeAttenuation: true,
  });
  cityPts = new THREE.Points(g, m);
  scene.add(cityPts);

  // ---- glow layer (window lights + drifting dust) — additive ----
  const gp = [], gtype = [], grf = [];
  // pull window lights out of city set into glow set as well (duplicate for bloom-y look)
  for (let i = 0; i < type.length; i++) {
    if (type[i] === 2) {
      gp.push(pos[i*3], pos[i*3+1], pos[i*3+2]); gtype.push(2); grf.push(rnd());
    }
  }
  // ambient floating dust / fireflies
  for (let i = 0; i < 700; i++) {
    gp.push((rnd()*2-1)*W, rnd()*10, -rnd()*D + 6);
    gtype.push(5); grf.push(rnd());
  }
  const gg = new THREE.BufferGeometry();
  gg.setAttribute('position', new THREE.Float32BufferAttribute(gp, 3));
  gg.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(gp.length), 3));
  glowMeta = { type: gtype, rfac: grf, count: gtype.length, basePos: gp.slice() };
  const gm = new THREE.PointsMaterial({
    size: 0.16, map: sprite, vertexColors: true, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true, opacity: 0.95,
  });
  glowPts = new THREE.Points(gg, gm);
  scene.add(glowPts);

  // ---- portals (glowing 3D rings) ----
  const ringGeo = new THREE.TorusGeometry(1.15, 0.085, 16, 64);
  const portalZ = [1.5, -9, -20];
  portalZ.forEach((pz, i) => {
    const mat = new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.95 });
    const ring = new THREE.Mesh(ringGeo, mat);
    const side = i % 2 === 0 ? -1 : 1;
    ring.position.set(side * 1.4, 1.5 + i * 0.2, pz);
    ring.rotation.y = side * 0.5;
    // soft inner glow disc
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(1.05, 48),
      new THREE.MeshBasicMaterial({ map: sprite, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.5 })
    );
    ring.add(disc);
    scene.add(ring);
    // HTML label
    const label = document.createElement('button');
    label.className = 'world-portal-label';
    label.type = 'button';
    label.innerHTML = `<span>📍</span> ${PORTAL_NAMES[i]}`;
    label.addEventListener('click', () => window.__lscGenerate && window.__lscGenerate(PORTAL_NAMES[i]));
    portalsLayer.appendChild(label);
    portals.push({ ring, disc, label, name: PORTAL_NAMES[i], phase: i * 1.7 });
  });

  colorize(mode);
}

const _c = new THREE.Color();
function lerpHex(a, b, t) { return _c.setHex(a).lerp(new THREE.Color(b), t).getHex(); }

function colorize(m) {
  const P = PALETTES[m] || PALETTES.day;
  // city colours
  const col = cityPts.geometry.attributes.color.array;
  const { type, rfac } = cityMeta;
  const cGround = new THREE.Color(P.ground), cB1 = new THREE.Color(P.b1),
        cB2 = new THREE.Color(P.b2), cWin = new THREE.Color(P.win),
        cRiver = new THREE.Color(P.glow), cStone = new THREE.Color(P.b1).lerp(new THREE.Color(0xffffff), 0.12);
  for (let i = 0; i < type.length; i++) {
    let c;
    switch (type[i]) {
      case 0: c = cGround; break;
      case 3: c = cRiver; break;               // river reflections
      case 2: c = cWin; break;                  // window
      case 4: c = cStone; break;                // landmark
      default: c = rfac[i] > 0.5 ? cB1 : cB2;   // building body
    }
    const j = i * 3;
    // slight per-point brightness variation
    const v = 0.78 + rfac[i] * 0.32;
    col[j] = c.r * v; col[j+1] = c.g * v; col[j+2] = c.b * v;
  }
  cityPts.geometry.attributes.color.needsUpdate = true;

  // glow colours
  const gcol = glowPts.geometry.attributes.color.array;
  const gWin = new THREE.Color(P.win), gDust = new THREE.Color(P.dust);
  const winBoost = 0.5 + P.winAmt * 3; // brighter windows at night
  for (let i = 0; i < glowMeta.type.length; i++) {
    const isWin = glowMeta.type[i] === 2;
    const c = isWin ? gWin : gDust;
    const v = isWin ? winBoost : 0.5 + glowMeta.rfac[i] * 0.5;
    const j = i * 3;
    gcol[j] = c.r * v; gcol[j+1] = c.g * v; gcol[j+2] = c.b * v;
  }
  glowPts.geometry.attributes.color.needsUpdate = true;
  glowPts.material.opacity = 0.55 + P.winAmt * 1.3;

  // portals
  portals.forEach((p, i) => {
    const col = P.portal[i % P.portal.length];
    p.ring.material.color.setHex(col);
    p.disc.material.color.setHex(col);
  });

  // fog + dust feel
  scene.fog.color.setHex(P.fog);
}

/* ---- camera control: drift + parallax + drag ---- */
const target = new THREE.Vector3(0, 1.8, -6);
let yaw = 0, pitch = 0, dragYaw = 0, dragPitch = 0;
let dragging = false, lastX = 0, lastY = 0, mouseX = 0, mouseY = 0;

function bindControls() {
  const onMove = (x, y) => {
    const r = canvas.getBoundingClientRect();
    mouseX = ((x - r.left) / r.width) * 2 - 1;
    mouseY = ((y - r.top) / r.height) * 2 - 1;
  };
  canvas.addEventListener('pointermove', e => {
    onMove(e.clientX, e.clientY);
    if (dragging) {
      dragYaw   += (e.clientX - lastX) * 0.0024;
      dragPitch += (e.clientY - lastY) * 0.0018;
      dragPitch = Math.max(-0.35, Math.min(0.45, dragPitch));
      lastX = e.clientX; lastY = e.clientY;
    }
  });
  canvas.addEventListener('pointerdown', e => {
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
    document.getElementById('worldHint')?.classList.add('hide');
  });
  const end = () => { dragging = false; };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
}

const _v = new THREE.Vector3();
function projectLabels() {
  const r = canvas.getBoundingClientRect();
  portals.forEach(p => {
    _v.copy(p.ring.position); _v.project(camera);
    const behind = _v.z > 1;
    const x = (_v.x * 0.5 + 0.5) * r.width;
    const y = (-_v.y * 0.5 + 0.5) * r.height - 34;
    if (behind || x < -40 || x > r.width + 40 || y < -40 || y > r.height + 40) {
      p.label.style.opacity = '0'; p.label.style.pointerEvents = 'none';
    } else {
      p.label.style.opacity = '1'; p.label.style.pointerEvents = 'auto';
      p.label.style.transform = `translate(-50%,-50%) translate(${x}px, ${y}px)`;
    }
  });
}

let t = 0;
function tick() {
  raf = requestAnimationFrame(tick);
  t += reduceMotion ? 0 : 0.006;

  // camera: gentle dolly into the city + parallax + drag
  yaw   += ((mouseX * 0.22 + dragYaw) - yaw) * 0.05;
  pitch += ((mouseY * 0.12 + dragPitch) - pitch) * 0.05;
  const dolly = reduceMotion ? 0 : Math.sin(t * 0.5) * 0.7;
  camera.position.x = Math.sin(yaw) * 3.2;
  camera.position.y = 1.7 - pitch * 2.6;
  camera.position.z = 12 + dolly;
  target.set(Math.sin(yaw) * 1.2, 2.4 + pitch * 1.5, -10);
  camera.lookAt(target);

  // twinkle the glow layer
  if (!reduceMotion) {
    glowPts.material.size = 0.15 + Math.sin(t * 3) * 0.03;
    // drift dust upward & wrap
    const gp = glowPts.geometry.attributes.position.array;
    const base = glowMeta.basePos;
    for (let i = 0; i < glowMeta.type.length; i++) {
      if (glowMeta.type[i] === 5) {
        const j = i * 3 + 1;
        gp[j] += 0.01 + glowMeta.rfac[i] * 0.012;
        if (gp[j] > 11) gp[j] = 0;
        gp[i*3] = base[i*3] + Math.sin(t + glowMeta.rfac[i] * 6) * 0.4;
      }
    }
    glowPts.geometry.attributes.position.needsUpdate = true;

    // portals pulse + spin
    portals.forEach((p, i) => {
      const s = 1 + Math.sin(t * 1.6 + p.phase) * 0.08;
      p.ring.scale.set(s, s, s);
      p.ring.rotation.z = t * 0.4 * (i % 2 ? 1 : -1);
      p.disc.material.opacity = 0.35 + (Math.sin(t * 1.6 + p.phase) * 0.5 + 0.5) * 0.35;
    });
  }

  projectLabels();
  renderer.render(scene, camera);
}

function resize() {
  const r = canvas.getBoundingClientRect();
  if (!r.width || !r.height) return;
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / r.height;
  camera.updateProjectionMatrix();
}

let inited = false;
function init() {
  if (inited) return;
  inited = true;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch (e) {
    if (fallback) fallback.hidden = false;
    canvas.style.display = 'none';
    return;
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.6));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x14123a, 0.028);
  camera = new THREE.PerspectiveCamera(62, 1, 0.1, 200);
  camera.position.set(0, 2.4, 13);

  buildCity();
  bindControls();
  resize();
  new ResizeObserver(resize).observe(canvas);

  // expose mode hook + sync to current site mode
  window.__lscSetWorldMode = (m) => { mode = m; if (cityPts) colorize(m); };
  if (window.__lscSetMode) window.__lscSetMode(mode); // re-apply so palettes match nav

  // pause when off-screen
  const io = new IntersectionObserver((ents) => {
    ents.forEach(en => {
      if (en.isIntersecting && !running) { running = true; tick(); }
      else if (!en.isIntersecting && running) { running = false; cancelAnimationFrame(raf); }
    });
  }, { threshold: 0.02 });
  io.observe(canvas);
}

// When a pregenerated Marble world exists, splatviewer.js owns the explore
// canvas and renders the real Gaussian-splat Dublin; the point-cloud city
// stays available as its fallback via this hook.
window.__lscStartPointCity = init;
if (canvas && !window.LSC_EXPLORE_WORLD) {
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', init);
  else init();
}
