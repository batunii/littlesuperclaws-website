/* ============================================================
   Little Super Claws — world-lighting.js
   Estimates a Marble world's lighting from its equirect pano —
   the only lighting evidence the World Labs API provides.

   Pipeline (single pass over a 512×256 downsample, ~15 ms):
     1. linearize + luminance, solid-angle weighted (cos latitude)
     2. dominant light = brightest connected cluster above the
        P99 weighted-luminance threshold (flood fill, x-wrap for
        the equirect seam) → direction, colour, angular size
     3. LDR-clip boost: if the cluster is blown out (≥254), the
        real source was far brighter than the PNG can store —
        scale intensity by the clipped fraction (the single-image
        version of LightHarmony3D's underexposure-fusion idea)
     4. SH-L2 (9 RGB coeffs) of everything OUTSIDE the cluster →
        ambient colour/intensity + the "shadow floor" tint
        (≈ ambient/(sun+ambient): sunny → dark shadows,
        overcast → faint ones, automatically)
     5. low confidence (no peaky cluster) → diffuse mode: softer,
        fainter, higher sun

   Direction convention: azimuth around +Y (0 → +Z), elevation up.
   PANO_CALIBRATION maps pano-frame directions into site world
   space; the yaw is settled once with the debug arrow overlay
   (window.__lscViewer._lightDebug) and holds for all Marble worlds.
   ============================================================ */
import * as THREE from 'three';

/* One calibration for all Marble panos → site world space.
   yaw is validated/tuned with the debug overlay; flipX covers the
   possibility that panos are authored in the pre-flip splat frame
   (the site rotates world meshes by π around X). */
export const PANO_CALIBRATION = { yaw: -Math.PI / 2, flipX: false };

export function panoDirToWorld(d, out = new THREE.Vector3()) {
  out.copy(d);
  if (PANO_CALIBRATION.flipX) { out.y = -out.y; out.z = -out.z; }
  const c = Math.cos(PANO_CALIBRATION.yaw), s = Math.sin(PANO_CALIBRATION.yaw);
  const x = out.x * c + out.z * s;
  const z = -out.x * s + out.z * c;
  out.x = x; out.z = z;
  return out;
}

/* scene.environmentRotation / backgroundRotation consistent with
   panoDirToWorld, so the estimated arrow and the visible pano agree. */
export function panoEnvRotation() {
  return new THREE.Euler(PANO_CALIBRATION.flipX ? Math.PI : 0, PANO_CALIBRATION.yaw, 0, 'XYZ');
}

export function azElToDir(azimuth, elevation, out = new THREE.Vector3()) {
  const ce = Math.cos(elevation);
  return out.set(ce * Math.sin(azimuth), Math.sin(elevation), ce * Math.cos(azimuth));
}

export function dirToAzEl(dir) {
  return {
    azimuth: Math.atan2(dir.x, dir.z),
    elevation: Math.asin(Math.max(-1, Math.min(1, dir.y))),
  };
}

/* ---- pano texture for scene.environment / debug background ---- */
const texCache = new Map();
export function loadPanoTexture(url) {
  if (!texCache.has(url)) {
    const p = new Promise((resolve, reject) => {
      new THREE.TextureLoader().load(url, (t) => {
        t.mapping = THREE.EquirectangularReflectionMapping;
        t.colorSpace = THREE.SRGBColorSpace;
        resolve(t);
      }, undefined, reject);
    });
    p.catch(() => texCache.delete(url));
    texCache.set(url, p);
  }
  return texCache.get(url);
}

/* ---- estimation ---- */
const estimateCache = new Map(); // cacheKey -> Promise<estimate|null>

export function estimateWorldLighting(panoUrl, cacheKey = panoUrl) {
  if (!panoUrl) return Promise.resolve(null);
  if (!estimateCache.has(cacheKey)) {
    const p = _estimate(panoUrl).catch((err) => {
      console.warn('[LSC] world lighting estimation failed:', err?.message || err);
      return null;
    });
    estimateCache.set(cacheKey, p);
  }
  return estimateCache.get(cacheKey);
}

const W = 512, H = 256;
const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) SRGB_TO_LINEAR[i] = Math.pow(i / 255, 2.2);

async function _estimate(panoUrl) {
  const img = await new Promise((resolve, reject) => {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('pano image failed to load'));
    im.src = panoUrl;
  });

  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, W, H);
  let data;
  try {
    data = ctx.getImageData(0, 0, W, H).data;
  } catch (e) {
    // CORS-tainted canvas: CDN didn't send image CORS headers.
    console.warn('[LSC] pano canvas read blocked (CORS) — keeping default lighting');
    return null;
  }

  const N = W * H;
  const lum = new Float32Array(N);
  const weight = new Float32Array(N);   // cos(latitude): equirect solid-angle factor
  const texelSA = (2 * Math.PI / W) * (Math.PI / H); // × cosφ = solid angle per texel

  for (let py = 0; py < H; py++) {
    const phi = Math.PI * (0.5 - (py + 0.5) / H); // +π/2 top (up)
    const w = Math.max(0, Math.cos(phi));
    for (let px = 0; px < W; px++) {
      const i = py * W + px;
      const o = i * 4;
      const r = SRGB_TO_LINEAR[data[o]], g = SRGB_TO_LINEAR[data[o + 1]], b = SRGB_TO_LINEAR[data[o + 2]];
      lum[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      weight[i] = w;
    }
  }

  // weighted luminance histogram → P99 threshold + median
  const BINS = 1024;
  const hist = new Float32Array(BINS);
  let totalW = 0;
  for (let i = 0; i < N; i++) {
    const bin = Math.min(BINS - 1, (lum[i] * (BINS - 1)) | 0);
    hist[bin] += weight[i];
    totalW += weight[i];
  }
  const pct = (p) => {
    let acc = 0;
    for (let b2 = 0; b2 < BINS; b2++) {
      acc += hist[b2];
      if (acc >= totalW * p) return b2 / (BINS - 1);
    }
    return 1;
  };
  const threshold = Math.max(pct(0.99), 0.04);
  const median = Math.max(pct(0.5), 1e-4);

  // flood-fill clusters above threshold (4-connected, x wraps at the seam)
  const label = new Int32Array(N); // 0 = none
  const clusters = [];
  const stack = new Int32Array(N);
  for (let seed = 0; seed < N; seed++) {
    if (label[seed] || lum[seed] < threshold) continue;
    const id = clusters.length + 1;
    const cl = {
      energy: 0, sa: 0, count: 0, clipped: 0,
      dir: new THREE.Vector3(), r: 0, g: 0, b: 0, maxLum: 0,
    };
    let top = 0;
    stack[top++] = seed;
    label[seed] = id;
    while (top > 0) {
      const i = stack[--top];
      const py = (i / W) | 0, px = i - py * W;
      const phi = Math.PI * (0.5 - (py + 0.5) / H);
      const theta = ((px + 0.5) / W - 0.5) * 2 * Math.PI;
      const cphi = Math.cos(phi);
      const e = lum[i] * weight[i] * texelSA; // luminance × solid angle
      cl.energy += e;
      cl.sa += weight[i] * texelSA;
      cl.count++;
      cl.maxLum = Math.max(cl.maxLum, lum[i]);
      cl.dir.x += cphi * Math.cos(theta) * e;
      cl.dir.y += Math.sin(phi) * e;
      cl.dir.z += cphi * Math.sin(theta) * e;
      const o = i * 4;
      if (data[o] >= 254 || data[o + 1] >= 254 || data[o + 2] >= 254) cl.clipped++;
      cl.r += SRGB_TO_LINEAR[data[o]] * e;
      cl.g += SRGB_TO_LINEAR[data[o + 1]] * e;
      cl.b += SRGB_TO_LINEAR[data[o + 2]] * e;
      // neighbours: left/right wrap, up/down clamp
      const nb = [
        py * W + ((px + 1) % W),
        py * W + ((px - 1 + W) % W),
        py > 0 ? i - W : -1,
        py < H - 1 ? i + W : -1,
      ];
      for (const n of nb) {
        if (n >= 0 && !label[n] && lum[n] >= threshold) { label[n] = id; stack[top++] = n; }
      }
    }
    clusters.push(cl);
  }

  // total energy + SH-L2 ambient over everything OUTSIDE the dominant cluster
  let best = null;
  for (const cl of clusters) if (!best || cl.energy > best.energy) best = cl;
  const bestId = best ? clusters.indexOf(best) + 1 : 0;

  const sh = new Float32Array(27); // 9 coeffs × RGB
  let ambientEnergy = 0, sunEnergy = 0;
  let ar = 0, ag = 0, ab = 0;
  for (let py = 0; py < H; py++) {
    const phi = Math.PI * (0.5 - (py + 0.5) / H);
    const cphi = Math.cos(phi), y = Math.sin(phi);
    for (let px = 0; px < W; px++) {
      const i = py * W + px;
      const dOmega = weight[i] * texelSA;
      const e = lum[i] * dOmega;
      if (label[i] === bestId && bestId) { sunEnergy += e; continue; }
      ambientEnergy += e;
      const theta = ((px + 0.5) / W - 0.5) * 2 * Math.PI;
      const x = cphi * Math.cos(theta), z = cphi * Math.sin(theta);
      const o = i * 4;
      const r = SRGB_TO_LINEAR[data[o]], g = SRGB_TO_LINEAR[data[o + 1]], b = SRGB_TO_LINEAR[data[o + 2]];
      ar += r * dOmega; ag += g * dOmega; ab += b * dOmega;
      const basis = [
        0.282095,
        0.488603 * y, 0.488603 * z, 0.488603 * x,
        1.092548 * x * y, 1.092548 * y * z,
        0.315392 * (3 * z * z - 1),
        1.092548 * x * z, 0.546274 * (x * x - y * y),
      ];
      for (let k = 0; k < 9; k++) {
        const bw = basis[k] * dOmega;
        sh[k * 3] += r * bw; sh[k * 3 + 1] += g * bw; sh[k * 3 + 2] += b * bw;
      }
    }
  }

  if (!best || best.energy <= 0) return null;

  const dirPano = best.dir.clone().normalize();
  const sunDirWorld = panoDirToWorld(dirPano);
  let { azimuth, elevation } = dirToAzEl(sunDirWorld);

  // colours (chromaticity, max channel = 1)
  const chroma = (r, g, b) => {
    const m = Math.max(r, g, b, 1e-6);
    return new THREE.Color(r / m, g / m, b / m);
  };
  const sunColor = chroma(best.r, best.g, best.b);
  const ambientColor = chroma(ar, ag, ab);

  // intensity: base from cluster luminance, boosted when clipped
  const clippedFraction = best.count ? best.clipped / best.count : 0;
  let sunIntensity = 1.2 + 0.9 * Math.min(1, best.maxLum);
  if (clippedFraction >= 0.3) sunIntensity *= 1 + 1.2 * clippedFraction;
  sunIntensity = Math.min(3.2, sunIntensity);

  const sunFraction = sunEnergy / Math.max(1e-6, sunEnergy + ambientEnergy);
  const confidence = (best.energy / Math.max(1e-6, best.sa)) / median; // peakiness vs scene
  let diffuse = confidence < 4 || sunFraction < 0.02;

  // shadow floor = ambient fraction, tinted by ambient chroma. Physically an
  // overcast sky gives near-invisible shadows; clamp the floor darker than
  // physical (max 0.45) so characters always ground visibly on this site.
  const floorLum = Math.max(0.12, Math.min(0.45, 1 - sunFraction * 1.15));
  const tintLum = 0.2126 * ambientColor.r + 0.7152 * ambientColor.g + 0.0722 * ambientColor.b;
  const shadowTint = new THREE.Vector3(
    ambientColor.r, ambientColor.g, ambientColor.b,
  ).multiplyScalar(floorLum / Math.max(0.2, tintLum));
  shadowTint.set(
    Math.min(0.6, shadowTint.x), Math.min(0.6, shadowTint.y), Math.min(0.6, shadowTint.z));

  let shadowStrength = Math.max(0.45, Math.min(0.92, 0.5 + 0.5 * sunFraction + 0.15 * Math.min(1, confidence / 8)));
  const angularRadius = Math.sqrt(best.sa / Math.PI); // radians
  let penumbraTexels = 0.8 + Math.min(3, angularRadius * 18);

  if (diffuse) {
    shadowStrength *= 0.75;
    penumbraTexels = Math.max(penumbraTexels, 2.5);
    elevation = Math.max(elevation, 0.6);
    azElToDir(azimuth, elevation, sunDirWorld);
  }
  elevation = Math.max(0.08, elevation); // never light from below the floor
  azElToDir(azimuth, elevation, sunDirWorld);

  const ambientIntensity = Math.max(0.2, Math.min(1.2, ambientEnergy / (2 * Math.PI) * 3.5));

  return {
    corsOk: true,
    sunDirWorld, azimuth, elevation,
    sunColor, sunIntensity,
    ambientColor, ambientIntensity,
    shadowStrength, shadowTint, penumbraTexels,
    angularRadius, confidence, diffuse, sunFraction, clippedFraction,
    sh,
  };
}
