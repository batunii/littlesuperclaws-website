/* ============================================================
   Little Super Claws — splat-shadows.js
   Real-time character shadows cast ONTO the Gaussian-splat world.

   Two GPU paths (auto-selected, override with ?lscShadowMode=):
   • 'fragment' (default) — PIXEL-SHARP shadows. Spark's display
     fragment shader is patched: each pixel's world position is
     reconstructed from the interpolated NDC varying (vNdc) and
     tested against the character depth map. Shadow edges slice
     straight through large splats, and because these are plain
     material uniforms there is NO splat regeneration, no version
     bumps, and no one-frame lag — updates are free every frame.
   • 'splat' — per-splat fallback via a dyno worldModifier in the
     generate pipeline (one shadow test per splat centre). Kept
     for drivers/Spark versions where the display patch anchors
     are missing; also useful for A/B comparison.

   Shared by both: a depth map of the crew (and only the crew — a
   dedicated layer) rendered from the sun through a tightly fitted,
   texel-snapped ortho frustum (~2 mm/texel), sampled with
   hardware-PCF sampler2DShadow + a Poisson-disk penumbra, darkening
   toward an ambient "shadow floor" tint in linear light.

   Exports:
     CHARACTER_SHADOW_LAYER          — layer crew casters must enable
     pickShadowTier() / pickShadowMode()
     ShadowRig                       — owns depth pass + shader hookup
   ============================================================ */
import * as THREE from 'three';
import { dyno } from '@sparkjsdev/spark';

const {
  dyno: rawDyno, dynoBlock, Gsplat, splitGsplat, combineGsplat,
  dynoMat4, dynoVec3, dynoVec4, DynoUniform, unindentLines, unindent,
} = dyno;

/* Crew objects enable this layer so the light camera sees only them. */
export const CHARACTER_SHADOW_LAYER = 3;

/* ---- device tier: mirrors pickSplatUrl()'s heuristic ---- */
export function pickShadowTier() {
  let forced = null;
  try { forced = new URLSearchParams(location.search).get('lscShadowTier'); } catch {}
  if (forced === 'off') return { mapSize: 0, taps: 0, label: 'off' };
  if (forced === 'mobile') return { mapSize: 1024, taps: 5, label: 'mobile' };
  if (forced === 'desktop') return { mapSize: 2048, taps: 9, label: 'desktop' };
  if (navigator.deviceMemory && navigator.deviceMemory <= 2) {
    return { mapSize: 0, taps: 0, label: 'off' }; // contact-AO only
  }
  const small = matchMedia('(pointer: coarse)').matches ||
    (navigator.deviceMemory && navigator.deviceMemory <= 4);
  return small
    ? { mapSize: 1024, taps: 5, label: 'mobile' }
    : { mapSize: 2048, taps: 9, label: 'desktop' };
}

export function pickShadowMode() {
  let forced = null;
  try { forced = new URLSearchParams(location.search).get('lscShadowMode'); } catch {}
  return forced === 'splat' ? 'splat' : 'fragment';
}

/* ---- PCF: centre tap + up-to-8 Poisson taps (compile-time count) ---- */
function pcfFunctionGlsl(taps) {
  const extra = Math.max(0, Math.min(8, (taps | 0) - 1));
  return unindent(`
    const vec2 lscPoisson[8] = vec2[8](
      vec2(-0.7071,  0.7071), vec2( 0.0,    -0.875),
      vec2( 0.5303,  0.5303), vec2(-0.625,   0.0),
      vec2( 0.3536, -0.3536), vec2( 0.0,     0.375),
      vec2(-0.1768, -0.1768), vec2( 0.125,   0.0));
    float lscShadowSample(sampler2DShadow map, vec3 uvz, float radius) {
      float lit = texture(map, uvz);
      for (int i = 0; i < ${extra}; ++i) {
        lit += texture(map, vec3(uvz.xy + lscPoisson[i] * radius, uvz.z));
      }
      return lit / ${(extra + 1).toFixed(1)};
    }
  `);
}

/* ---- 'fragment' mode: patch Spark's display fragment shader ----
   Anchors verified against Spark 2.1.0's splatFragment source. Returns
   the uniform refs on success, or null if the anchors are missing
   (→ caller falls back to 'splat' mode). */
function patchSparkDisplayShader(spark, depthTexture, taps) {
  const mat = spark.material;
  if (!mat || mat.userData.lscShadowPatched) return mat?.userData.lscShadowUniforms ?? null;
  const frag = mat.fragmentShader;
  const declAnchor = 'out vec4 fragColor;';
  const applyAnchor = '#ifdef PREMULTIPLIED_ALPHA';
  if (!frag || !frag.includes(declAnchor) || !frag.includes(applyAnchor) ||
      !frag.includes('in vec3 vNdc;') || !frag.includes('uniform bool encodeLinear;')) {
    return null;
  }

  const decls = unindent(`
    precision highp sampler2DShadow;
    uniform sampler2DShadow lscShadowMap;
    uniform mat4 lscClipToWorld;   // inverse(mainProj * mainView)
    uniform mat4 lscLightMatrix;   // light ortho viewProj
    uniform vec4 lscShadowParams;  // strength, pcfRadiusUV, depthBias, enable
    uniform vec3 lscShadowTint;    // linear shadow-floor colour
  `) + '\n' + pcfFunctionGlsl(taps) + '\n' + declAnchor;

  // vNdc interpolates the pixel's NDC xy at the splat's depth → unproject
  // to world, test against the crew depth map, darken toward the floor.
  const apply = unindent(`
    if (lscShadowParams.w > 0.5) {
        vec4 lsc_world = lscClipToWorld * vec4(vNdc, 1.0);
        vec3 lsc_uvz = (lscLightMatrix * vec4(lsc_world.xyz / lsc_world.w, 1.0)).xyz * 0.5 + 0.5;
        if (all(greaterThan(lsc_uvz, vec3(0.0))) && all(lessThan(lsc_uvz, vec3(1.0)))) {
            float lsc_lit = lscShadowSample(lscShadowMap,
                vec3(lsc_uvz.xy, lsc_uvz.z - lscShadowParams.z), lscShadowParams.y);
            vec2 lsc_e = min(lsc_uvz.xy, 1.0 - lsc_uvz.xy);
            lsc_lit = mix(1.0, lsc_lit, smoothstep(0.0, 0.08, min(lsc_e.x, lsc_e.y)));
            float lsc_f = mix(1.0, lsc_lit, lscShadowParams.x);
            vec3 lsc_factor = mix(lscShadowTint, vec3(1.0), lsc_f);
            // rgba.rgb is linear here iff encodeLinear (srgbToLinear ran above)
            rgba.rgb *= encodeLinear ? lsc_factor : pow(lsc_factor, vec3(1.0 / 2.2));
        }
    }
    `) + '\n    ' + applyAnchor;

  const uniforms = {
    lscShadowMap: { value: depthTexture },
    lscClipToWorld: { value: new THREE.Matrix4() },
    lscLightMatrix: { value: new THREE.Matrix4() },
    lscShadowParams: { value: new THREE.Vector4(0.75, 0, 0.002, 0) },
    lscShadowTint: { value: new THREE.Vector3(0.24, 0.26, 0.32) },
  };
  mat.fragmentShader = frag.replace(declAnchor, decls).replace(applyAnchor, apply);
  Object.assign(mat.uniforms, uniforms);
  mat.needsUpdate = true;
  mat.userData.lscShadowPatched = true;
  mat.userData.lscShadowUniforms = uniforms;
  return uniforms;
}

/* ---- 'splat' mode: dyno worldModifier (per-splat, generate stage) ---- */
function makeSplatShadowModifier(u, taps) {
  const globals = pcfFunctionGlsl(taps);
  return dynoBlock({ gsplat: Gsplat }, { gsplat: Gsplat }, ({ gsplat }) => {
    if (!gsplat) throw new Error('No gsplat input');
    const parts = splitGsplat(gsplat).outputs;
    const shaded = rawDyno({
      inTypes: {
        center: 'vec3', rgb: 'vec3', shadowMap: 'sampler2DShadow',
        lightMatrix: 'mat4', params: 'vec4', tint: 'vec3',
      },
      outTypes: { rgb: 'vec3' },
      inputs: {
        center: parts.center, rgb: parts.rgb, shadowMap: u.shadowMap,
        lightMatrix: u.lightMatrix, params: u.params, tint: u.tint,
      },
      globals: () => [globals],
      statements: ({ inputs, outputs }) => {
        if (!outputs.rgb) return [];
        return unindentLines(`
          {
            vec3 lsc_uvz = ((${inputs.lightMatrix}) * vec4(${inputs.center}, 1.0)).xyz * 0.5 + 0.5;
            float lsc_lit = 1.0;
            if (${inputs.params}.w > 0.5
                && all(greaterThan(lsc_uvz, vec3(0.0)))
                && all(lessThan(lsc_uvz, vec3(1.0)))) {
              lsc_lit = lscShadowSample(${inputs.shadowMap},
                                        vec3(lsc_uvz.xy, lsc_uvz.z - ${inputs.params}.z),
                                        ${inputs.params}.y);
              vec2 lsc_e = min(lsc_uvz.xy, 1.0 - lsc_uvz.xy);
              lsc_lit = mix(1.0, lsc_lit, smoothstep(0.0, 0.08, min(lsc_e.x, lsc_e.y)));
            }
            float lsc_f = mix(1.0, lsc_lit, ${inputs.params}.x);
            vec3 lsc_factor = mix(${inputs.tint}, vec3(1.0), lsc_f);
            ${outputs.rgb} = ${inputs.rgb} * pow(lsc_factor, vec3(1.0 / 2.2));
          }
        `);
      },
    });
    return { gsplat: combineGsplat({ gsplat, rgb: shaded.outputs.rgb }) };
  });
}

/* ============================================================
   ShadowRig — one per SplatScene. Owns the light camera, the
   depth target and the shader hookup for the chosen mode.
   Call attachDisplay(spark) once after the SparkRenderer exists
   (fragment mode), attach(worldMesh) after each world load
   (splat mode; harmless in fragment mode), frame(crew, camera)
   once per tick before the main render.
   ============================================================ */
export class ShadowRig {
  constructor(renderer, scene, tier = pickShadowTier(), mode = pickShadowMode()) {
    this.renderer = renderer;
    this.scene = scene;
    this.tier = tier;
    this.mode = mode;
    this.worldMesh = null;

    // look params (frame() folds these into the gating key)
    this.sunDir = new THREE.Vector3(3, 6, 2).normalize(); // matches the site's default light
    this.strength = 0.75;        // 0..1 shadow opacity
    this.penumbraTexels = 1.2;   // PCF radius, in shadow-map texels
    // linear "shadow floor": what a fully shadowed splat is multiplied by
    // (≈ ambient/(sun+ambient), ambient-tinted — never pure black)
    this.tint = new THREE.Vector3(0.24, 0.26, 0.32);
    this.biasWorld = 0.015;      // metres; casters/receivers are disjoint so constant bias suffices
    this.enabled = tier.mapSize > 0;

    const size = Math.max(2, tier.mapSize || 2);
    const depthTexture = new THREE.DepthTexture(size, size);
    depthTexture.type = THREE.UnsignedIntType;
    depthTexture.compareFunction = THREE.LessEqualCompare; // → sampler2DShadow + hardware PCF
    depthTexture.minFilter = THREE.LinearFilter;
    depthTexture.magFilter = THREE.LinearFilter;
    this.rt = new THREE.WebGLRenderTarget(size, size, {
      format: THREE.RedFormat,       // throwaway colour attachment, keep it 1 byte/px
      type: THREE.UnsignedByteType,
      depthBuffer: true,
      depthTexture,
    });

    this.depthMaterial = new THREE.MeshDepthMaterial();
    this.lightCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.05, 20);
    this.lightCam.layers.set(CHARACTER_SHADOW_LAYER);

    // display-shader uniform refs ('fragment' mode; set by attachDisplay)
    this.disp = null;

    // dyno uniforms + modifier ('splat' mode; built lazily on first attach)
    this.uLightMatrix = null;
    this.uParams = null;
    this.uTint = null;
    this.uShadowMap = null;
    this.modifier = null;

    this._helper = null;
    this._wasActive = false;
    this._lastKey = '';
    // scratch objects (avoid per-frame GC)
    this._box = new THREE.Box3();
    this._b = new THREE.Box3();
    this._center = new THREE.Vector3();
    this._sizeV = new THREE.Vector3();
    this._local = new THREE.Vector3();
    this._snapped = new THREE.Vector3();
  }

  /* 'fragment' mode hookup: patch the SparkRenderer's display material.
     Falls back to 'splat' mode if the shader anchors are missing. */
  attachDisplay(spark) {
    if (this.mode !== 'fragment') return this.mode;
    this.disp = patchSparkDisplayShader(spark, this.rt.depthTexture, this.tier.taps || 1);
    if (!this.disp) {
      console.warn('[LSC] Spark display-shader anchors missing — falling back to per-splat shadows');
      this.mode = 'splat';
    }
    return this.mode;
  }

  _buildSplatModifier() {
    if (this.modifier) return;
    this.uLightMatrix = dynoMat4(new THREE.Matrix4(), 'lscLightMatrix');
    this.uParams = dynoVec4(new THREE.Vector4(this.strength, 0, 0.002, 0), 'lscShadowParams');
    this.uTint = dynoVec3(this.tint.clone(), 'lscShadowTint');
    // GLSL ES 3.0 gives sampler2DShadow NO default precision; DynoUniform
    // emits custom globals right before its own declaration.
    this.uShadowMap = new DynoUniform({
      key: 'lscShadowMap',
      type: 'sampler2DShadow',
      value: this.rt.depthTexture,
      globals: () => ['precision highp sampler2DShadow;'],
    });
    this.modifier = makeSplatShadowModifier({
      shadowMap: this.uShadowMap,
      lightMatrix: this.uLightMatrix,
      params: this.uParams,
      tint: this.uTint,
    }, this.tier.taps || 1);
  }

  attach(worldMesh) {
    this.worldMesh = worldMesh;
    if (this.mode === 'splat') {
      this._buildSplatModifier();
      worldMesh.worldModifier = this.modifier;
      worldMesh.updateGenerator();
    }
    this._lastKey = '';
    this._wasActive = false;
  }

  detach() {
    if (this.worldMesh && this.mode === 'splat') {
      try {
        this.worldMesh.worldModifier = void 0;
        this.worldMesh.updateGenerator();
      } catch { /* mesh may already be disposed */ }
    }
    this.worldMesh = null;
  }

  setSunDir(dir) { this.sunDir.copy(dir).normalize(); }
  setStrength(v) { this.strength = Math.max(0, Math.min(1, v)); }
  setPenumbraTexels(v) { this.penumbraTexels = Math.max(0, v); }
  setTint(r, g, b) {
    if (r && r.isVector3) this.tint.copy(r);
    else if (r && r.isColor) this.tint.set(r.r, r.g, r.b);
    else this.tint.set(r, g, b);
  }
  setEnabled(on) { this.enabled = !!on && this.tier.mapSize > 0; }

  _setEnableUniform(on) {
    if (this.mode === 'fragment') {
      if (this.disp) this.disp.lscShadowParams.value.w = on ? 1 : 0;
    } else if (this.uParams) {
      this.uParams.value.w = on ? 1 : 0;
      this.worldMesh?.updateVersion();
    }
  }

  /* Once per tick, before the main render. */
  frame(crewObjs, camera) {
    const hooked = this.mode === 'fragment' ? !!this.disp : !!this.worldMesh;
    if (!hooked) return;

    // fragment mode reconstructs world position from the main camera's NDC —
    // its inverse view-projection must track the camera EVERY frame (cheap:
    // one material uniform, no splat regeneration).
    if (this.mode === 'fragment' && camera) {
      camera.updateMatrixWorld();
      this.disp.lscClipToWorld.value
        .copy(camera.matrixWorld)
        .multiply(camera.projectionMatrixInverse);
    }

    const active = this.enabled && crewObjs && crewObjs.length > 0;
    if (!active) {
      if (this._wasActive) {
        this._setEnableUniform(false);
        this._wasActive = false;
        this._lastKey = '';
      }
      return;
    }

    // union world-space bbox of the crew (cached local boxes × matrixWorld)
    const box = this._box.makeEmpty();
    for (const obj of crewObjs) {
      obj.updateWorldMatrix(true, false);
      if (!obj.userData.lscBox) {
        this._b.setFromObject(obj);
        obj.userData.lscBox = this._b.clone().applyMatrix4(
          obj.matrixWorld.clone().invert());
      }
      this._b.copy(obj.userData.lscBox).applyMatrix4(obj.matrixWorld);
      box.union(this._b);
    }
    if (box.isEmpty()) return;

    // gating: skip the depth render unless something moved > 5 mm (or the
    // sun/params changed). Idle bob costs ~10-17 Hz, not 60.
    const q = (v) => Math.round(v / 0.005);
    const d = this.sunDir;
    const key = `${q(box.min.x)},${q(box.min.y)},${q(box.min.z)},${q(box.max.x)},${q(box.max.y)},${q(box.max.z)}|` +
      `${d.x.toFixed(3)},${d.y.toFixed(3)},${d.z.toFixed(3)}|` +
      `${this.strength.toFixed(3)},${this.penumbraTexels.toFixed(2)},${this.biasWorld}|` +
      `${this.tint.x.toFixed(3)},${this.tint.y.toFixed(3)},${this.tint.z.toFixed(3)}`;
    if (key === this._lastKey) {
      if (this._helper) this._helper.update();
      return;
    }
    this._lastKey = key;

    // fit the ortho frustum around the crew
    const center = box.getCenter(this._center);
    const radius = box.getSize(this._sizeV).length() * 0.5 + 0.35;
    const halfExtent = Math.ceil(radius / 0.25) * 0.25; // quantized → stable texel density
    const camDist = radius + 3;
    const far = radius * 2 + 6;
    const cam = this.lightCam;
    cam.up.set(0, Math.abs(d.y) > 0.95 ? 0 : 1, Math.abs(d.y) > 0.95 ? 1 : 0);
    cam.position.copy(center).addScaledVector(d, camDist);
    cam.lookAt(center);
    cam.updateMatrixWorld(true);

    // snap the frustum centre to shadow texels (kills edge swimming)
    const size = this.tier.mapSize;
    const worldPerTexel = (2 * halfExtent) / size;
    const local = this._local.copy(center);
    cam.worldToLocal(local);
    local.x = Math.round(local.x / worldPerTexel) * worldPerTexel;
    local.y = Math.round(local.y / worldPerTexel) * worldPerTexel;
    const snapped = cam.localToWorld(this._snapped.copy(local));
    cam.position.add(snapped).sub(center); // translate; view basis unchanged
    cam.left = -halfExtent; cam.right = halfExtent;
    cam.top = halfExtent; cam.bottom = -halfExtent;
    cam.near = 0.05; cam.far = far;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);

    // crew-only depth render (Spark does zero work here: the splat
    // objects live on layer 0 and fail the light camera's layer test)
    const renderer = this.renderer;
    const scene = this.scene;
    const prevRT = renderer.getRenderTarget();
    const prevOverride = scene.overrideMaterial;
    const prevAutoClear = renderer.autoClear;
    const prevBackground = scene.background;
    scene.overrideMaterial = this.depthMaterial;
    scene.background = null;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.rt);
    renderer.clear(true, true, false);
    renderer.render(scene, cam);
    renderer.setRenderTarget(prevRT);
    renderer.autoClear = prevAutoClear;
    scene.overrideMaterial = prevOverride;
    scene.background = prevBackground;

    // push light-space uniforms for the active mode
    const biasN = this.biasWorld / (far - 0.05);
    const radiusUV = this.penumbraTexels / size;
    if (this.mode === 'fragment') {
      this.disp.lscLightMatrix.value.copy(cam.projectionMatrix).multiply(cam.matrixWorldInverse);
      this.disp.lscShadowParams.value.set(this.strength, radiusUV, biasN, 1);
      this.disp.lscShadowTint.value.copy(this.tint);
    } else {
      this.uLightMatrix.value.copy(cam.projectionMatrix).multiply(cam.matrixWorldInverse);
      this.uParams.value.set(this.strength, radiusUV, biasN, 1);
      this.uTint.value.copy(this.tint);
      this.worldMesh.updateVersion(); // generate-stage refresh (one-frame lag)
    }
    this._wasActive = true;
    if (this._helper) this._helper.update();
  }

  /* Debug: visualize the fitted light frustum. */
  showFrustumHelper(on) {
    if (on && !this._helper) {
      this._helper = new THREE.CameraHelper(this.lightCam);
      this.scene.add(this._helper);
    } else if (!on && this._helper) {
      this.scene.remove(this._helper);
      this._helper.dispose();
      this._helper = null;
    }
  }

  dispose() {
    this.detach();
    this.showFrustumHelper(false);
    this.rt.depthTexture?.dispose();
    this.rt.dispose();
    this.depthMaterial.dispose();
  }
}
