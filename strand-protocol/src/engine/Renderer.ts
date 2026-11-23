/**
 * STRAND // PROTOCOL — Rendering core (§6.2, §9.2).
 *
 *  WebGL2 · ACESFilmic (exposure 1.15) · PMREM procedural environment (cube 256)
 *  EffectComposer on a 4× MSAA HalfFloat target:
 *    Pass 1  RenderPass        — main 3D scene
 *    Pass 2  ViewModelPass     — clearDepth() then first-person scene with dedicated FOV 68°
 *            HdrSanitize       — NaN → 0, Inf/fireflies capped (protects the bloom chain)
 *    Pass 3  UnrealBloomPass   — threshold 0.92 / strength 0.65 (SSS 0.95) / radius 0.48
 *    Pass 4  KineticPostFX     — RGB aberration · BT colour shift · speed lines · raindrop
 *                                 vignette · critical/damage vignette · overdrive border · glitch
 *    Pass 5  OutputPass        — ACES tone mapping + sRGB
 *  Lights: 1 DirectionalLight (moon, no shadows) + 1 HemisphereLight + 4 pooled PointLights.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import {
  CAMERA,
  COLORS,
  LIMITS,
  QUALITY_PRESETS,
  RENDER,
  type QualityPreset,
  DEG2RAD,
  clamp,
} from '../config/constants';
import type { ScreenFilterId } from '../config/skills';

/** 10A-1 pure helper: effective DPR obeying HIGH ≤ 1.25 and total pixel budget ≤ 2.2M px. */
export function computeEffectiveDpr(
  width: number,
  height: number,
  devicePixelRatio: number,
  preset: QualityPreset,
  lowLatency: boolean,
): number {
  if (lowLatency || preset !== 'HIGH') return 1.0;
  const pxCapDpr = Math.sqrt(RENDER.MAX_RENDER_PIXELS / Math.max(1, width * height));
  return Math.min(Math.max(devicePixelRatio || 1, 1), QUALITY_PRESETS.HIGH.dpr, RENDER.DPR_CAP, pxCapDpr);
}

/** 10A-4 grade parameters executed inside KineticPostFX (+0 extra draw calls). */
interface FilterGrade {
  readonly active: number;
  readonly shadow: readonly [number, number, number];
  readonly high: readonly [number, number, number];
  readonly tint: readonly [number, number, number];
  readonly sat: number;
  readonly curve: number;
  readonly black: number;
  readonly vig: number;
  readonly warmKeep: number;
  readonly grain: number;
}

const FILTER_GRADES: Readonly<Record<ScreenFilterId, FilterGrade>> = {
  CYBER_NOIR: {
    active: 1,
    shadow: [-0.014, 0.006, 0.022],
    high: [0.016, 0.008, 0.004],
    tint: [0.97, 1.0, 1.03],
    sat: 1.06,
    curve: 0.16,
    black: -0.012,
    vig: 0.18,
    warmKeep: 0,
    grain: RENDER.FILM_GRAIN,
  },
  NEON_OVERDRIVE: {
    active: 1,
    shadow: [-0.01, -0.006, 0.032],
    high: [0.024, 0.004, 0.026],
    tint: [1.03, 0.98, 1.06],
    sat: 1.22,
    curve: 0.18,
    black: -0.01,
    vig: 0.16,
    warmKeep: 0,
    grain: RENDER.FILM_GRAIN,
  },
  COLD_STEEL: {
    active: 1,
    shadow: [-0.014, 0.006, 0.024],
    high: [-0.006, 0.01, 0.02],
    tint: [0.91, 0.98, 1.06],
    sat: 0.72,
    curve: 0.15,
    black: -0.008,
    vig: 0.18,
    warmKeep: 0.85,
    grain: RENDER.FILM_GRAIN,
  },
  AMBER_DUST: {
    active: 1,
    shadow: [0.014, 0.004, -0.016],
    high: [0.042, 0.02, -0.024],
    tint: [1.08, 0.98, 0.85],
    sat: 0.94,
    curve: 0.15,
    black: -0.008,
    vig: 0.2,
    warmKeep: 0,
    grain: RENDER.FILM_GRAIN * 1.15,
  },
  RAW: {
    active: 0,
    shadow: [0, 0, 0],
    high: [0, 0, 0],
    tint: [1, 1, 1],
    sat: 1.0,
    curve: 0,
    black: 0,
    vig: 0,
    warmKeep: 0,
    grain: 0,
  },
};

// ---------------------------------------------------------------------------
// Pass 2: first-person view-model pass (depth cleared so weapons never clip into walls)
// ---------------------------------------------------------------------------
class ViewModelPass extends Pass {
  constructor(private readonly vmScene: THREE.Scene, private readonly vmCamera: THREE.Camera) {
    super();
    this.needsSwap = false;
    this.clear = false;
  }

  override render(
    renderer: THREE.WebGLRenderer,
    _writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    renderer.clearDepth();
    renderer.render(this.vmScene, this.vmCamera);
    renderer.autoClear = oldAutoClear;
  }
}

// ---------------------------------------------------------------------------
// HDR sanitize (runs between Pass 2 and Pass 3): on real GPUs an extreme specular highlight can
// exceed the HalfFloat range (65504) and be stored as Inf, or a shader can emit NaN. UnrealBloom's
// blur chain then smears that single pixel into large black squares. NaN → 0, Inf/fireflies → cap.
// ---------------------------------------------------------------------------
const HDR_SANITIZE_MAX = 64.0;
const HdrSanitizeShader = {
  name: 'HdrSanitize',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    float sanitize(float x) {
      // isnan + self-inequality: belt and braces against drivers that fold one of them away.
      if (isnan(x) || x != x) return 0.0;
      return clamp(x, 0.0, ${HDR_SANITIZE_MAX.toFixed(1)});
    }
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      gl_FragColor = vec4(sanitize(c.r), sanitize(c.g), sanitize(c.b), 1.0);
    }
  `,
};

// ---------------------------------------------------------------------------
// Pass 4: KineticPostFX (single fragment shader to save draw calls)
// ---------------------------------------------------------------------------
const DEF_GRADE = FILTER_GRADES.CYBER_NOIR;

const KineticPostFXShader = {
  name: 'KineticPostFX',
  defines: {} as Record<string, string | number>,
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
    uChroma: { value: RENDER.CHROMA_BASE },
    uBulletTime: { value: 0 },
    uBtSaturation: { value: RENDER.BT_SATURATION },
    uBtTint: { value: new THREE.Color(COLORS.BT_TINT) },
    uSpeedLines: { value: 0 },
    uSpeedLineDensity: { value: 0.5 },
    uSpeedLineInner: { value: RENDER.SPEEDLINE_INNER_RADIUS },
    uCritical: { value: 0 },
    uCriticalColor: { value: new THREE.Color(COLORS.CRITICAL_VIGNETTE) },
    uHeartbeatHz: { value: 128 / 60 },
    uDamageFlash: { value: 0 },
    uZoom: { value: 0 },
    uRainDrops: { value: 0.6 },
    uOverdrive: { value: 0 },
    uOverdriveColor: { value: new THREE.Color(COLORS.WALLRUN_CYAN) },
    uFrameFlash: { value: 0 },
    uFlashColor: { value: new THREE.Color(1, 1, 1) },
    uGlitch: { value: 0 },
    uFade: { value: 0 },
    uFadeColor: { value: new THREE.Color(0x000000) },
    /** 10A-4 selectable screen filter uniforms (default CYBER_NOIR). */
    uGradeActive: { value: DEF_GRADE.active },
    uGradeShadow: { value: new THREE.Vector3(...DEF_GRADE.shadow) },
    uGradeHigh: { value: new THREE.Vector3(...DEF_GRADE.high) },
    uGradeTint: { value: new THREE.Vector3(...DEF_GRADE.tint) },
    uGradeSat: { value: DEF_GRADE.sat },
    uGradeCurve: { value: DEF_GRADE.curve },
    uGradeBlack: { value: DEF_GRADE.black },
    uGradeVig: { value: DEF_GRADE.vig },
    uGradeWarmKeep: { value: DEF_GRADE.warmKeep },
    /** 7B-2 film grain strength (display-referred). */
    uGrain: { value: DEF_GRADE.grain },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uResolution;
    uniform float uTime;
    uniform float uChroma;
    uniform float uBulletTime;
    uniform float uBtSaturation;
    uniform vec3 uBtTint;
    uniform float uSpeedLines;
    uniform float uSpeedLineDensity;
    uniform float uSpeedLineInner;
    uniform float uCritical;
    uniform vec3 uCriticalColor;
    uniform float uZoom;
    uniform float uHeartbeatHz;
    uniform float uDamageFlash;
    uniform float uRainDrops;
    uniform float uOverdrive;
    uniform vec3 uOverdriveColor;
    uniform float uFrameFlash;
    uniform vec3 uFlashColor;
    uniform float uGlitch;
    uniform float uFade;
    uniform vec3 uFadeColor;
    uniform float uGradeActive;
    uniform vec3 uGradeShadow;
    uniform vec3 uGradeHigh;
    uniform vec3 uGradeTint;
    uniform float uGradeSat;
    uniform float uGradeCurve;
    uniform float uGradeBlack;
    uniform float uGradeVig;
    uniform float uGradeWarmKeep;
    uniform float uGrain;
    varying vec2 vUv;

    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }
    float vnoise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      float a = hash12(i);
      float b = hash12(i + vec2(1.0, 0.0));
      float c = hash12(i + vec2(0.0, 1.0));
      float d = hash12(i + vec2(1.0, 1.0));
      return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
    }

    // Raindrops beading on the visor: returns (refraction offset xy, coverage)
    vec3 dropLayer(vec2 uv, float t, float scale, float seed) {
      vec2 aspect = vec2(uResolution.x / uResolution.y, 1.0);
      vec2 st = uv * aspect * scale;
      vec2 id = floor(st);
      vec2 f = fract(st) - 0.5;
      float n = hash12(id + seed);
      float life = fract(t * (0.12 + n * 0.1) + n);
      float alive = smoothstep(0.0, 0.08, life) * (1.0 - smoothstep(0.55, 1.0, life));
      vec2 c = vec2(hash12(id * 1.7 + seed) - 0.5, hash12(id * 2.3 + seed) - 0.5) * 0.6;
      c.y -= life * 0.22 * step(0.7, n); // heavier drops slide down
      vec2 d = f - c;
      float r = 0.08 + 0.14 * hash12(id * 3.1 + seed);
      float len = length(d);
      float m = smoothstep(r, r * 0.35, len) * alive * step(0.35, n);
      return vec3(d * m * 0.9 / scale, m);
    }

    void main() {
      vec2 uv = vUv;
      float aspect = uResolution.x / uResolution.y;
      vec2 centered = (uv - 0.5) * 2.0;
      float rad = length(centered);
      float radAspect = length(centered * vec2(aspect, 1.0)) / aspect;

      // --- Death glitch: tearing horizontal bands -----------------------------------
      if (uGlitch > 0.0) {
        float frame = floor(uTime * 30.0);
        float band = floor(uv.y * 42.0);
        float g = step(1.0 - uGlitch * 0.7, hash12(vec2(band, frame)));
        uv.x += (hash12(vec2(frame, band * 1.3)) - 0.5) * 0.14 * uGlitch * g;
      }

      // --- Raindrop vignette (refraction strongest toward the edges) -----------------
      float dropCoverage = 0.0;
      #ifndef LITE
      if (uRainDrops > 0.0) {
        float edgeMask = smoothstep(0.35, 1.15, radAspect);
        vec3 d1 = dropLayer(uv, uTime, 9.0, 1.0);
        vec3 d2 = dropLayer(uv, uTime * 1.3, 15.0, 7.0);
        vec2 off = (d1.xy + d2.xy) * uRainDrops * edgeMask;
        uv += off;
        dropCoverage = clamp((d1.z + d2.z) * uRainDrops * edgeMask, 0.0, 1.0);
      }
      #endif

      // --- RGB chromatic aberration (radial) --------------------------------------------
      vec2 caOff = (uv - 0.5) * uChroma * 2.0;
      vec4 base = texture2D(tDiffuse, uv);
      vec3 col;
      col.r = texture2D(tDiffuse, uv + caOff).r;
      col.g = base.g;
      col.b = texture2D(tDiffuse, uv - caOff).b;

      // Drops slightly brighten & blur-tint what's behind them.
      col *= 1.0 + dropCoverage * 0.18;

      // --- Bullet-time colour shift --------------------------------------------------------
      if (uBulletTime > 0.0) {
        float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
        vec3 desat = mix(vec3(lum), col, uBtSaturation);
        vec3 tintDir = uBtTint / max(max(uBtTint.r, uBtTint.g), max(uBtTint.b, 1e-4));
        vec3 tinted = desat * mix(vec3(1.0), 0.35 + tintDir * 0.85, 0.6) + uBtTint * 0.25;
        // Preserve & boost red emissive (enemies, telegraph lines).
        float redness = (col.r - max(col.g, col.b)) / (col.r + 1e-3);
        float redMask = smoothstep(0.25, 0.7, redness) * smoothstep(0.25, 1.1, col.r);
        vec3 btCol = mix(tinted, col * 1.35, redMask);
        col = mix(col, btCol, uBulletTime);
      }

      // --- Radial speed lines (outside inner radius) ---------------------------------------
      if (uSpeedLines > 0.0) {
        float ang = atan(centered.y, centered.x * aspect);
        float ringMask = smoothstep(uSpeedLineInner, uSpeedLineInner + 0.35, rad);
        #ifdef LITE
        float lines = pow(abs(sin(ang * 90.0 + floor(uTime * 24.0) * 1.7)), 40.0);
        #else
        float freq = mix(70.0, 160.0, uSpeedLineDensity);
        float n1 = vnoise(vec2(ang * freq, uTime * 6.0 - rad * 3.0));
        float n2 = vnoise(vec2(ang * freq * 0.5 + 13.0, uTime * 9.0));
        float threshold = mix(0.82, 0.6, uSpeedLineDensity);
        float lines = smoothstep(threshold, 1.0, n1) * (0.6 + 0.4 * n2);
        #endif
        col = mix(col, col * 0.82, ringMask * uSpeedLines * 0.5);
        col += vec3(0.65, 0.92, 1.0) * lines * ringMask * uSpeedLines * 0.9;
      }

      // --- Critical HP crimson vignette (pulses at heartbeat BPM) + scanline noise -------
      float vig = smoothstep(0.45, 1.35, radAspect);
      // --- Tactical zoom: faint dark edge vignette (strength 0.18 at full zoom, 5A-1) ----------
      col *= 1.0 - uZoom * 0.18 * vig;
      if (uCritical > 0.0) {
        float beat = fract(uTime * uHeartbeatHz);
        float pulse = 0.55 + 0.45 * (exp(-beat * 9.0) + 0.6 * exp(-max(beat - 0.18, 0.0) * 11.0) * step(0.18, beat));
        float scan = 0.88 + 0.12 * sin(vUv.y * uResolution.y * 1.4 + uTime * 38.0);
        float grain = hash12(vUv * uResolution + fract(uTime) * 100.0);
        float cornerNoise = vig * (0.75 + 0.25 * grain) * scan;
        col = mix(col, uCriticalColor * 1.4, clamp(cornerNoise * pulse * uCritical, 0.0, 0.92));
      }
      // --- Damage flash -----------------------------------------------------------------------
      if (uDamageFlash > 0.0) {
        col = mix(col, uCriticalColor * 2.0, clamp(uDamageFlash * (0.25 + vig * 0.75), 0.0, 1.0));
      }

      // --- OVERDRIVE cyan electric border (FLOW SSS) ---------------------------------------
      if (uOverdrive > 0.0) {
        float edge = min(min(vUv.x, 1.0 - vUv.x) * aspect, min(vUv.y, 1.0 - vUv.y));
        float along = (vUv.x + vUv.y) * 60.0;
        #ifdef LITE
        float n = 0.5 + 0.5 * sin(along + uTime * 30.0);
        #else
        float n = vnoise(vec2(along, uTime * 22.0)) * 0.7 + vnoise(vec2(along * 3.1, uTime * 41.0)) * 0.3;
        #endif
        float arc = smoothstep(0.006, 0.0, abs(edge - 0.008 - n * 0.018));
        float glow = smoothstep(0.06, 0.0, edge) * 0.35;
        col += uOverdriveColor * (arc * 3.5 + glow) * uOverdrive;
      }

      // --- Kill frame flash -------------------------------------------------------------------
      col += uFlashColor * uFrameFlash;

      // --- Death blackout / red-white glitch tint ---------------------------------------------
      if (uGlitch > 0.0) {
        float frame = floor(uTime * 30.0);
        float band = floor(vUv.y * 42.0);
        float hit = step(1.0 - uGlitch * 0.5, hash12(vec2(band * 2.1, frame + 3.0)));
        vec3 gcol = mix(vec3(1.6, 0.08, 0.15), vec3(1.6), step(0.5, hash12(vec2(band, frame * 1.7))));
        col = mix(col, gcol, hit * 0.85);
      }
      // --- 10A-4 selectable screen filter grade + film grain (before ACES OutputPass) ---------
      if (uGradeActive > 0.5) {
        vec3 s = pow(max(col, vec3(0.0)), vec3(1.0 / 2.2));
        float l = dot(s, vec3(0.2126, 0.7152, 0.0722));
        vec3 graded = mix(vec3(l), s, uGradeSat);
        if (uGradeWarmKeep > 0.0) {
          float warmChroma = clamp((s.r - s.b) * 1.6, 0.0, 1.0) * smoothstep(0.18, 0.72, s.r);
          graded = mix(graded, s * vec3(1.12, 1.03, 0.96), warmChroma * uGradeWarmKeep);
        }
        s = graded * uGradeTint;
        s += uGradeShadow * (1.0 - smoothstep(0.0, 0.30, l)) + uGradeHigh * smoothstep(0.55, 1.0, l);
        s += vec3(uGradeBlack) * (1.0 - smoothstep(0.0, 0.28, l));
        vec3 sc = clamp(s, 0.0, 1.0);
        s = mix(s, sc * sc * (3.0 - 2.0 * sc), uGradeCurve * step(s, vec3(1.0)));
        s *= 1.0 - uGradeVig * vig;
        #ifndef LITE
        // Temporal interleaved-gradient grain (blue-noise-like): kills 8-bit banding in the night sky / fog.
        vec2 gp = gl_FragCoord.xy + vec2(47.0, 17.0) * floor(uTime * 60.0);
        float ign = fract(52.9829189 * fract(dot(gp, vec2(0.06711056, 0.00583715))));
        s += (ign - 0.5) * 2.0 * uGrain;
        #endif
        col = pow(max(s, vec3(0.0)), vec3(2.2));
      }
      col = mix(col, uFadeColor, clamp(uFade, 0.0, 1.0));

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

/** Values written by gameplay systems every frame; applied to the KineticPostFX uniforms. */
export interface PostFxState {
  /** Current speed (m/s) used for chromatic aberration ramp. */
  speed: number;
  /** 0..1 bullet-time colour blend. */
  bulletTime: number;
  /** 0..1 speed-line intensity (gating by FLOW rank is decided by the caller). */
  speedLines: number;
  /** 0..1 speed-line density (SSS = 1). */
  speedLineDensity: number;
  /** 0..1 critical-HP vignette strength. */
  critical: number;
  /** 0..1 damage flash (decays automatically). */
  damageFlash: number;
  /** 0..1 tactical-zoom blend (dark edge vignette). */
  zoom: number;
  /** 0..1 raindrop vignette strength. */
  rainDrops: number;
  /** 0..1 OVERDRIVE border. */
  overdrive: number;
  /** 0..1 kill frame flash (decays automatically). */
  frameFlash: number;
  /** 0..1 death glitch. */
  glitch: number;
  /** 0..1 fade to black. */
  fade: number;
}

interface PooledLight {
  light: THREE.PointLight;
  life: number;
  duration: number;
  peak: number;
}

export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly viewModelScene: THREE.Scene;
  readonly viewModelCamera: THREE.PerspectiveCamera;
  readonly composer: EffectComposer;
  readonly bloomPass: UnrealBloomPass;
  readonly postFxPass: ShaderPass;
  readonly moonLight: THREE.DirectionalLight;
  readonly hemiLight: THREE.HemisphereLight;
  readonly postFx: PostFxState = {
    speed: 0,
    bulletTime: 0,
    speedLines: 0,
    speedLineDensity: 0.5,
    critical: 0,
    damageFlash: 0,
    zoom: 0,
    rainDrops: 0.6,
    overdrive: 0,
    frameFlash: 0,
    glitch: 0,
    fade: 0,
  };

  private envTarget: THREE.WebGLRenderTarget | null = null;
  private readonly lights: PooledLight[] = [];
  private quality: QualityPreset = 'HIGH';
  private lowLatency = false;
  private shadowsEnabled = false;
  private filter: ScreenFilterId = 'CYBER_NOIR';
  private chromaSpike = 0;
  private chromaSpikeDecayPerS = 0;
  private time = 0;
  private width = 1;
  private height = 1;
  private readonly moonDir = new THREE.Vector3(-0.45, 0.62, -0.64).normalize();
  private readonly moonRight = new THREE.Vector3();
  private readonly moonUp = new THREE.Vector3();
  private readonly shadowTarget = new THREE.Vector3();

  constructor(container: HTMLElement) {
    const renderer = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
      alpha: false,
    });
    if (!renderer.capabilities.isWebGL2) throw new Error('WebGL2 is required');
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = RENDER.TONE_MAPPING_EXPOSURE;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = false;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setClearColor(COLORS.SKY_ZENITH, 1);
    renderer.info.autoReset = false;
    container.appendChild(renderer.domElement);
    renderer.domElement.id = 'game-canvas';
    this.renderer = renderer;

    // --- Scenes & cameras ------------------------------------------------------------------
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(COLORS.FOG_ABYSS, RENDER.FOG_DENSITY);
    this.camera = new THREE.PerspectiveCamera(CAMERA.BASE_FOV, 1, CAMERA.NEAR, CAMERA.FAR);
    this.camera.rotation.order = 'YXZ';

    this.viewModelScene = new THREE.Scene();
    this.viewModelCamera = new THREE.PerspectiveCamera(CAMERA.VIEWMODEL_FOV, 1, 0.01, 10);

    // --- Lights ------------------------------------------------------------------------------
    // 7A-4: moon 0.55 → 0.72, hemisphere 0.35 → 0.50 (sky 0x2b4070 / ground bounce 0x16223a) — no crushed blacks.
    this.moonLight = new THREE.DirectionalLight(COLORS.MOON, 0.72);
    this.moonLight.position.copy(this.moonDir).multiplyScalar(120);
    this.moonLight.castShadow = false;
    // 10A-1 optional lightweight player-centered shadow map (1024×1024, ±36 m texel-snapped frustum).
    const sh = RENDER.SHADOW_FRUSTUM_HALF;
    this.moonLight.shadow.mapSize.set(RENDER.SHADOW_MAP_SIZE, RENDER.SHADOW_MAP_SIZE);
    this.moonLight.shadow.camera.left = -sh;
    this.moonLight.shadow.camera.right = sh;
    this.moonLight.shadow.camera.top = sh;
    this.moonLight.shadow.camera.bottom = -sh;
    this.moonLight.shadow.camera.near = 1;
    this.moonLight.shadow.camera.far = 260;
    this.moonLight.shadow.bias = -0.0005;
    this.moonLight.shadow.normalBias = 0.04;
    this.moonRight.crossVectors(new THREE.Vector3(0, 1, 0), this.moonDir).normalize();
    this.moonUp.crossVectors(this.moonDir, this.moonRight).normalize();
    this.scene.add(this.moonLight);
    this.scene.add(this.moonLight.target);
    this.hemiLight = new THREE.HemisphereLight(0x2b4070, 0x16223a, 0.5);
    this.scene.add(this.hemiLight);
    for (let i = 0; i < LIMITS.DYNAMIC_POINT_LIGHTS; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 18, 2);
      light.castShadow = false;
      this.scene.add(light);
      this.lights.push({ light, life: 0, duration: 1, peak: 0 });
    }
    // View-model lighting: key from moon side + cool fill, plus shared environment.
    const vmKey = new THREE.DirectionalLight(0xc8d8ff, 1.1);
    vmKey.position.set(-1, 1.2, 0.6);
    const vmFill = new THREE.HemisphereLight(0x3a5a8a, 0x120c1c, 0.6);
    this.viewModelScene.add(vmKey, vmFill);

    // --- Environment (PMREM, generated once) ----------------------------------------------
    this.buildEnvironment();

    // --- Composer --------------------------------------------------------------------------
    const target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples: RENDER.MSAA_SAMPLES,
      depthBuffer: true,
      stencilBuffer: false,
    });
    this.composer = new EffectComposer(renderer, target);

    const mainPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(mainPass);

    this.composer.addPass(new ViewModelPass(this.viewModelScene, this.viewModelCamera));

    // Guard against NaN / Inf before the bloom blur chain (prevents black-square artifacts).
    this.composer.addPass(new ShaderPass(HdrSanitizeShader));

    // 10A-1: Half-resolution UnrealBloomPass (~75% lower GPU fill cost, identical soft glow).
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(Math.max(128, Math.floor(window.innerWidth * 0.5)), Math.max(128, Math.floor(window.innerHeight * 0.5))),
      RENDER.BLOOM_STRENGTH,
      RENDER.BLOOM_RADIUS,
      RENDER.BLOOM_THRESHOLD,
    );
    this.composer.addPass(this.bloomPass);

    this.postFxPass = new ShaderPass(KineticPostFXShader);
    this.composer.addPass(this.postFxPass);

    this.composer.addPass(new OutputPass());

    this.setFilter('CYBER_NOIR');
    this.setQuality('HIGH');
    window.addEventListener('resize', () => this.resize());
  }

  // -------------------------------------------------------------------------------------------
  // Procedural environment cube (night neon points, moonlight, lower blue-violet glow)
  // -------------------------------------------------------------------------------------------
  private buildEnvironment(): void {
    const env = new THREE.Scene();
    const disposables: Array<{ dispose(): void }> = [];

    // Sky gradient sphere.
    const skyGeo = new THREE.SphereGeometry(900, 48, 24);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        zenith: { value: new THREE.Color(COLORS.SKY_ZENITH) },
        horizon: { value: new THREE.Color(0x1a2444) },
        below: { value: new THREE.Color(0x2a1a55) },
        abyss: { value: new THREE.Color(COLORS.FOG_ABYSS) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 zenith; uniform vec3 horizon; uniform vec3 below; uniform vec3 abyss;
        varying vec3 vDir;
        void main() {
          float y = vDir.y;
          vec3 c = mix(horizon, zenith, smoothstep(0.0, 0.55, y));
          // Lower blue-violet city glow under the horizon.
          vec3 low = mix(below * 1.6, abyss, smoothstep(-0.05, -0.7, y));
          c = y < 0.0 ? low : c;
          // Horizon glow band.
          c += vec3(0.10, 0.06, 0.22) * exp(-abs(y) * 14.0);
          gl_FragColor = vec4(c, 1.0);
        }
      `,
    });
    env.add(new THREE.Mesh(skyGeo, skyMat));
    disposables.push(skyGeo, skyMat);

    // Moon disc + halo.
    const moonDir = this.moonLight.position.clone().normalize();
    const moonGeo = new THREE.SphereGeometry(18, 16, 8);
    const moonMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(COLORS.MOON).multiplyScalar(7) });
    const moon = new THREE.Mesh(moonGeo, moonMat);
    moon.position.copy(moonDir).multiplyScalar(800);
    env.add(moon);
    disposables.push(moonGeo, moonMat);

    // Silhouette towers ring with lit-window dot grids, and neon strips (cyan / magenta / amber).
    const towerGeo = new THREE.BoxGeometry(1, 1, 1);
    const towerMat = new THREE.MeshBasicMaterial({ color: 0x070a12 });
    disposables.push(towerGeo, towerMat);
    const neonGeo = new THREE.BoxGeometry(1, 1, 1);
    disposables.push(neonGeo);
    const neonColors = [COLORS.WALLRUN_CYAN, COLORS.NEON_MAGENTA, COLORS.NEON_AMBER, COLORS.WINDOW_COOL];
    const neonMats = neonColors.map((c, i) => {
      const m = new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(i === 3 ? 1.2 : 2.6) });
      disposables.push(m);
      return m;
    });
    const windowDotGeo = new THREE.PlaneGeometry(1, 1);
    disposables.push(windowDotGeo);
    const warmWin = new THREE.MeshBasicMaterial({ color: new THREE.Color(COLORS.WINDOW_WARM).multiplyScalar(0.9), side: THREE.DoubleSide });
    const coolWin = new THREE.MeshBasicMaterial({ color: new THREE.Color(COLORS.WINDOW_COOL).multiplyScalar(0.8), side: THREE.DoubleSide });
    disposables.push(warmWin, coolWin);

    let seed = 1337;
    const rnd = (): number => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };
    const towers = 64;
    for (let i = 0; i < towers; i++) {
      const ang = (i / towers) * Math.PI * 2 + rnd() * 0.05;
      const dist = 260 + rnd() * 320;
      const w = 30 + rnd() * 50;
      const h = 120 + rnd() * 380;
      const baseY = -320;
      const tower = new THREE.Mesh(towerGeo, towerMat);
      tower.scale.set(w, h, w);
      tower.position.set(Math.cos(ang) * dist, baseY + h / 2, Math.sin(ang) * dist);
      tower.lookAt(0, tower.position.y, 0);
      env.add(tower);
      // Window clusters on the face pointing at the centre (instanced is unnecessary: one-off bake).
      const rows = 10 + Math.floor(rnd() * 14);
      for (let r = 0; r < rows; r++) {
        if (rnd() < 0.35) continue;
        const win = new THREE.Mesh(windowDotGeo, rnd() < 0.3 ? warmWin : coolWin);
        const wy = baseY + h * (0.35 + 0.6 * (r / rows));
        win.scale.set(w * (0.3 + rnd() * 0.6), 2.2, 1);
        win.position.set(Math.cos(ang) * (dist - w / 2 - 0.5), wy, Math.sin(ang) * (dist - w / 2 - 0.5));
        win.lookAt(0, wy, 0);
        env.add(win);
      }
      // Neon strips and points.
      const strips = 1 + Math.floor(rnd() * 3);
      for (let s = 0; s < strips; s++) {
        const neon = new THREE.Mesh(neonGeo, neonMats[Math.floor(rnd() * neonMats.length)]);
        const vertical = rnd() < 0.5;
        const ny = baseY + h * (0.5 + rnd() * 0.48);
        neon.scale.set(vertical ? 2.5 : w * 0.8, vertical ? 30 + rnd() * 50 : 2.5, 1);
        neon.position.set(Math.cos(ang) * (dist - w / 2 - 1.5), ny, Math.sin(ang) * (dist - w / 2 - 1.5));
        neon.lookAt(0, ny, 0);
        env.add(neon);
      }
    }
    // Searchlight shafts frozen in the bake (bright thin streaks into the sky).
    for (let i = 0; i < 6; i++) {
      const ang = rnd() * Math.PI * 2;
      const beam = new THREE.Mesh(neonGeo, neonMats[3]);
      beam.scale.set(3, 500, 3);
      beam.position.set(Math.cos(ang) * 420, 100, Math.sin(ang) * 420);
      beam.rotation.z = (rnd() - 0.5) * 0.6;
      beam.rotation.x = (rnd() - 0.5) * 0.6;
      env.add(beam);
    }

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envTarget = pmrem.fromScene(env, 0.02, 0.5, 2000, { size: RENDER.ENV_CUBE_SIZE });
    this.scene.environment = this.envTarget.texture;
    this.scene.environmentIntensity = 1.0;
    this.viewModelScene.environment = this.envTarget.texture;
    this.viewModelScene.environmentIntensity = 1.35; // 6B-1: neon / sky glints run along the bevelled edges
    pmrem.dispose();
    for (const d of disposables) d.dispose();
  }

  // -------------------------------------------------------------------------------------------
  // Quality presets: HIGH (DPR ≤ 1.25 / ≤ 2.2M px, MSAA 2 + half-res Bloom)
  //                  MEDIUM (DPR 1.0, MSAA 0 + half-res Bloom) / LOW (DPR 1.0, MSAA 0, lite PostFX)
  // -------------------------------------------------------------------------------------------
  private syncComposerSamples(): void {
    const samples = !this.lowLatency && this.quality === 'HIGH' ? RENDER.MSAA_SAMPLES : RENDER.MSAA_SAMPLES_LOW_LATENCY;
    for (const rt of [this.composer.renderTarget1, this.composer.renderTarget2]) {
      if (rt.samples === samples) continue;
      rt.samples = samples;
      rt.dispose();
    }
  }

  setQuality(preset: QualityPreset): void {
    this.quality = preset;
    const def = QUALITY_PRESETS[preset];
    this.syncComposerSamples();
    this.bloomPass.enabled = def.bloom;
    const mat = this.postFxPass.material as THREE.ShaderMaterial;
    if (def.litePostFx) mat.defines.LITE = 1;
    else delete mat.defines.LITE;
    mat.needsUpdate = true;
    this.resize();
  }

  /**
   * 7A-2 / 10A-1 LOW LATENCY: render at DPR 1.0 and 0× MSAA regardless of quality preset
   * so high-refresh / laptop GPUs keep the frame queue as short as possible.
   */
  setLowLatency(on: boolean): void {
    this.lowLatency = on;
    this.syncComposerSamples();
    this.setQuality(this.quality);
  }

  get isLowLatency(): boolean {
    return this.lowLatency;
  }

  getQuality(): QualityPreset {
    return this.quality;
  }

  /** 10A-1 optional lightweight directional shadows (default false for locked 60fps). */
  setShadows(enabled: boolean): void {
    if (this.shadowsEnabled === enabled) return;
    this.shadowsEnabled = enabled;
    this.renderer.shadowMap.enabled = enabled;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.moonLight.castShadow = enabled;
    this.renderer.shadowMap.needsUpdate = true;
    this.scene.traverse((obj) => {
      const m = (obj as THREE.Mesh).material;
      if (!m) return;
      if (Array.isArray(m)) {
        for (const sub of m) sub.needsUpdate = true;
      } else {
        m.needsUpdate = true;
      }
    });
  }

  get shadows(): boolean {
    return this.shadowsEnabled;
  }

  /** Snaps the ±36 m shadow frustum to shadow-map texels around `focus` to eliminate shimmer (zero alloc). */
  updateShadowFocus(focus: THREE.Vector3): void {
    if (!this.shadowsEnabled) return;
    const texel = (RENDER.SHADOW_FRUSTUM_HALF * 2) / RENDER.SHADOW_MAP_SIZE;
    const u = Math.round(focus.dot(this.moonRight) / texel) * texel;
    const v = Math.round(focus.dot(this.moonUp) / texel) * texel;
    const w = focus.dot(this.moonDir);
    this.shadowTarget
      .copy(this.moonRight)
      .multiplyScalar(u)
      .addScaledVector(this.moonUp, v)
      .addScaledVector(this.moonDir, w);
    this.moonLight.target.position.copy(this.shadowTarget);
    this.moonLight.position.copy(this.shadowTarget).addScaledVector(this.moonDir, 120);
    this.moonLight.target.updateMatrixWorld();
  }

  /** 10A-4 selectable screen filter executed inside KineticPostFX (+0 extra draw calls). */
  setFilter(id: ScreenFilterId): void {
    this.filter = id;
    const g = FILTER_GRADES[id] ?? FILTER_GRADES.CYBER_NOIR;
    const u = (this.postFxPass.material as THREE.ShaderMaterial).uniforms;
    u.uGradeActive.value = g.active;
    (u.uGradeShadow.value as THREE.Vector3).set(g.shadow[0], g.shadow[1], g.shadow[2]);
    (u.uGradeHigh.value as THREE.Vector3).set(g.high[0], g.high[1], g.high[2]);
    (u.uGradeTint.value as THREE.Vector3).set(g.tint[0], g.tint[1], g.tint[2]);
    u.uGradeSat.value = g.sat;
    u.uGradeCurve.value = g.curve;
    u.uGradeBlack.value = g.black;
    u.uGradeVig.value = g.vig;
    u.uGradeWarmKeep.value = g.warmKeep;
    u.uGrain.value = g.grain;
  }

  getFilter(): ScreenFilterId {
    return this.filter;
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.width = w;
    this.height = h;
    const dpr = computeEffectiveDpr(w, h, window.devicePixelRatio || 1, this.quality, this.lowLatency);
    this.renderer.setPixelRatio(dpr);
    this.composer.setPixelRatio(dpr);
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    // 10A-1: Keep UnrealBloomPass at half effective viewport resolution after composer.setSize().
    const effW = Math.floor(w * dpr);
    const effH = Math.floor(h * dpr);
    this.bloomPass.setSize(Math.max(128, Math.floor(effW * 0.5)), Math.max(128, Math.floor(effH * 0.5)));
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.viewModelCamera.aspect = w / h;
    this.viewModelCamera.updateProjectionMatrix();
    const u = (this.postFxPass.material as THREE.ShaderMaterial).uniforms;
    (u.uResolution.value as THREE.Vector2).set(effW, effH);
  }

  // -------------------------------------------------------------------------------------------
  // Runtime controls
  // -------------------------------------------------------------------------------------------
  setBloomStrength(strength: number): void {
    this.bloomPass.strength = strength;
  }

  /** Spike chromatic aberration to `amount`, decaying linearly to 0 over `durationMs`. */
  triggerChromaSpike(amount: number, durationMs: number): void {
    if (amount >= this.chromaSpike) {
      this.chromaSpike = amount;
      this.chromaSpikeDecayPerS = amount / Math.max(durationMs / 1000, 1e-3);
    }
  }

  /** Flash one of the 4 pooled point lights (muzzle flashes, explosions). */
  flashLight(position: THREE.Vector3, color: number, intensity: number, distance: number, durationS: number): void {
    let slot = this.lights[0];
    for (const l of this.lights) {
      if (l.life <= 0) {
        slot = l;
        break;
      }
      if (l.life < slot.life) slot = l;
    }
    slot.light.position.copy(position);
    slot.light.color.setHex(color);
    slot.light.distance = distance;
    slot.peak = intensity;
    slot.duration = durationS;
    slot.life = durationS;
    slot.light.intensity = intensity;
  }

  /**
   * Advance render-side timers.
   * @param realDt unscaled frame delta (s)
   */
  update(realDt: number): void {
    this.time += realDt;
    const fx = this.postFx;

    // Lights decay.
    for (const l of this.lights) {
      if (l.life > 0) {
        l.life = Math.max(0, l.life - realDt);
        const k = l.life / l.duration;
        l.light.intensity = l.peak * k * k;
      } else if (l.light.intensity !== 0) {
        l.light.intensity = 0;
      }
    }

    // Chromatic aberration: base 0.0005 → up to 0.0025 at high speed, plus decaying spikes.
    this.chromaSpike = Math.max(0, this.chromaSpike - this.chromaSpikeDecayPerS * realDt);
    const speedT = clamp((fx.speed - RENDER.SPEEDLINE_MIN_SPEED) / (34 - RENDER.SPEEDLINE_MIN_SPEED), 0, 1);
    const chroma = Math.max(
      RENDER.CHROMA_BASE + (RENDER.CHROMA_HIGH_SPEED_MAX - RENDER.CHROMA_BASE) * speedT,
      this.chromaSpike,
    );

    // Self-decaying flashes.
    fx.damageFlash = Math.max(0, fx.damageFlash - realDt * 3.5);
    fx.frameFlash = Math.max(0, fx.frameFlash - realDt * 6.0);

    const u = (this.postFxPass.material as THREE.ShaderMaterial).uniforms;
    u.uTime.value = this.time;
    u.uChroma.value = chroma;
    u.uBulletTime.value = fx.bulletTime;
    u.uSpeedLines.value = fx.speedLines;
    u.uSpeedLineDensity.value = fx.speedLineDensity;
    u.uCritical.value = fx.critical;
    u.uDamageFlash.value = fx.damageFlash;
    u.uZoom.value = fx.zoom;
    u.uRainDrops.value = fx.rainDrops;
    u.uOverdrive.value = fx.overdrive;
    u.uFrameFlash.value = fx.frameFlash;
    u.uGlitch.value = fx.glitch;
    u.uFade.value = fx.fade;
  }

  /** Set main camera FOV (degrees) keeping projection in sync. */
  setFov(fovDeg: number): void {
    if (Math.abs(this.camera.fov - fovDeg) > 1e-4) {
      this.camera.fov = fovDeg;
      this.camera.updateProjectionMatrix();
    }
  }

  render(): void {
    this.renderer.info.reset();
    this.composer.render();
  }

  get drawCalls(): number {
    return this.renderer.info.render.calls;
  }

  get triangles(): number {
    return this.renderer.info.render.triangles;
  }

  get viewportWidth(): number {
    return this.width;
  }

  get viewportHeight(): number {
    return this.height;
  }

  get elapsed(): number {
    return this.time;
  }

  /** Horizontal FOV helper for projection-based UI (radians). */
  get verticalFovRad(): number {
    return this.camera.fov * DEG2RAD;
  }
}
