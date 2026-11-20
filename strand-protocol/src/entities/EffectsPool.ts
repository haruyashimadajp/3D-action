/**
 * STRAND // PROTOCOL — Effects pool (§4, §6.2 Pass 1, §9.2). Fixed-capacity pools, zero allocation per frame.
 *
 *  - Rain: 1,800 streaks in ONE InstancedMesh. Each instance stores only a seed offset; the vertex shader
 *    advects it with the (bullet-time-scaled) rain clock and wraps it inside a 45 m × 30 m × 45 m box
 *    centred on the camera. Streaks stretch along the relative velocity for motion feel.
 *  - Projectiles: 120 high-velocity rounds shared by player and enemies (SoA typed arrays). Each round is
 *    advanced per fixed step and segment-tested against world colliders and hitboxes, so shots have real
 *    travel time (bullet-time trails). Rendered as stretched additive tracer boxes in ONE InstancedMesh;
 *    the tracer starts at the on-screen muzzle and blends onto the true eye-ray within 60 ms.
 *  - Particles: 600 sparks / visor shards / water-splash droplets in ONE InstancedMesh (ring buffer).
 *  - Telegraph lines (§5.1): 32 camera-facing ribbon quads in ONE instanced draw (never THREE.Line — width and
 *    bloom are real geometry). ACQUIRING = thin translucent dashed orange; LOCK = thick → thin red, 25 Hz blink.
 *    A screen-space minimum width keeps a 0.015 m line visible at 100 m while fading it by its true coverage.
 *  - Shock rings / ground prediction circles: 24 additive rings in ONE InstancedMesh.
 *  - GRAZE (§5.1-3): every enemy round tracks its closest approach to the player's body axis; when it passes
 *    the player without hitting and the closest distance was 0.45 m … 1.35 m, a single GRAZE fires — after one
 *    line-of-sight check from the chest to the closest point (a round passing behind cover never counts, 5A-5).
 */
import * as THREE from 'three';
import { COLORS, JUICE, LIMITS, RENDER, TELEGRAPH, createRng } from '../config/constants';
import {
  type HitboxTarget,
  type HitRegion,
  type PhysicsWorld,
  createRayHit,
  createTargetHit,
} from '../world/PhysicsWorld';
import type { ColliderKind } from '../world/CityBuilder';

const _relVel = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _d = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const _worldHit = createRayHit();
const _targetHit = createTargetHit();
const _chest = new THREE.Vector3();
const _grazePt = new THREE.Vector3();
/** A wall the round itself stopped on (≤ 5 cm short of the closest point) does not count as cover. */
const GRAZE_LOS_TOLERANCE_M = 0.05;
const _segEnd = new THREE.Vector3();
const _ringN = new THREE.Vector3();
const Y_UP = new THREE.Vector3(0, 1, 0);

export type ProjectileOwner = 'PLAYER' | 'ENEMY';

export interface ProjectileSpec {
  readonly owner: ProjectileOwner;
  readonly speed: number;
  readonly range: number;
  readonly damage: number;
  readonly headMultiplier: number;
  readonly shieldMultiplier: number;
  /** Tracer colour (hex) and HDR intensity. */
  readonly color: number;
  readonly intensity: number;
  readonly width: number;
  /** Free tag for the combat system (gun id / enemy kind). */
  readonly tag: number;
  /** Passes through shields and bodies (each body is hit once); stops at world geometry (SK_02). */
  readonly pierce?: boolean;
}

export interface ProjectileImpact {
  owner: ProjectileOwner;
  tag: number;
  /** The round pierces (continues after this impact). */
  pierce: boolean;
  damage: number;
  headMultiplier: number;
  shieldMultiplier: number;
  readonly point: THREE.Vector3;
  readonly normal: THREE.Vector3;
  readonly direction: THREE.Vector3;
  /** World collider kind when the world was hit. */
  kind: ColliderKind | null;
  /** Hitbox target when a humanoid / drone was hit. */
  target: HitboxTarget | null;
  region: HitRegion;
  travelled: number;
}

export interface ParticleBurst {
  readonly count: number;
  readonly color: number;
  readonly intensity: number;
  readonly speed: number;
  /** 0 = along the normal, 1 = full hemisphere. */
  readonly spread: number;
  readonly life: number;
  readonly gravity: number;
  readonly size: number;
}

const TELEGRAPH_VISOR_SHARDS = JUICE.HEADSHOT_VISOR_PARTICLES;

export const BURST = {
  SPARK: { count: 10, color: 0xffc27a, intensity: 2.4, speed: 9, spread: 0.85, life: 0.35, gravity: -14, size: 0.035 },
  WATER: { count: 14, color: 0x9fdcff, intensity: 1.1, speed: 5.5, spread: 0.45, life: 0.6, gravity: -11, size: 0.05 },
  LAND_SPLASH: { count: 26, color: 0xb6e6ff, intensity: 1.0, speed: 6.5, spread: 0.7, life: 0.7, gravity: -12, size: 0.06 },
  MUZZLE: { count: 6, color: 0x7ffcff, intensity: 2.8, speed: 7, spread: 0.35, life: 0.12, gravity: 0, size: 0.03 },
  HOOK: { count: 12, color: 0xffd26a, intensity: 2.6, speed: 7, spread: 0.9, life: 0.3, gravity: -10, size: 0.04 },
  /** Body hit: fine sparks only (no hitstop). */
  HIT_SPARK: { count: 6, color: 0xfff0d0, intensity: 3.0, speed: 7, spread: 0.9, life: 0.22, gravity: -12, size: 0.028 },
  /** Head-shot visor shatter: exactly 12 shards (§2.1), tinted with the visor colour. */
  VISOR_SHARD: { count: TELEGRAPH_VISOR_SHARDS, color: 0xff3b5c, intensity: 3.6, speed: 8.5, spread: 1.0, life: 0.6, gravity: -16, size: 0.05 },
  /** Kill: core rupture. */
  CORE_BURST: { count: 22, color: 0xff6a3a, intensity: 3.2, speed: 11, spread: 1.0, life: 0.5, gravity: -9, size: 0.045 },
  /** Head-shot kill: discharge from the top of the head (cyan + crimson bursts). */
  DISCHARGE_CYAN: { count: 12, color: 0x38f8ff, intensity: 4.0, speed: 7.5, spread: 0.55, life: 0.42, gravity: 2, size: 0.03 },
  DISCHARGE_CRIMSON: { count: 12, color: 0xff1e42, intensity: 4.0, speed: 7.5, spread: 0.55, life: 0.42, gravity: 2, size: 0.03 },
  /** Shield / boss part break: 32 large shards (§2.1). */
  BREAK_DEBRIS: { count: JUICE.BREAK_DEBRIS_COUNT, color: 0xff9500, intensity: 2.6, speed: 13, spread: 1.0, life: 1.1, gravity: -18, size: 0.08 },
  EXPLOSION: { count: 40, color: 0xff7a2a, intensity: 3.4, speed: 14, spread: 1.0, life: 0.55, gravity: -6, size: 0.06 },
  /** Enemy materialisation / digital dissolve glitch squares. */
  GLITCH: { count: 10, color: 0x38f8ff, intensity: 2.2, speed: 2.5, spread: 1.0, life: 0.5, gravity: 1.5, size: 0.05 },
  /** GRAZE: wind-cut streaks along the bullet path. */
  GRAZE: { count: 8, color: 0x7ffcff, intensity: 3.0, speed: 6, spread: 0.3, life: 0.25, gravity: 0, size: 0.025 },
  MISSILE_TRAIL: { count: 1, color: 0xff6a2a, intensity: 1.6, speed: 1.2, spread: 1.0, life: 0.45, gravity: 1.0, size: 0.09 },
  /** Phantom dash-slash arc sparks. */
  SLASH: { count: 14, color: 0xd04dff, intensity: 3.6, speed: 9, spread: 0.7, life: 0.3, gravity: -4, size: 0.035 },
} as const satisfies Record<string, ParticleBurst>;

/** Telegraph-line style (§5.1). */
export type LineStyle = 'ACQUIRE' | 'LOCK' | 'SIGHT';

/** Player body axis for GRAZE (closest-approach) tracking of enemy rounds. */
export interface GrazeProbe {
  active: boolean;
  /** Bottom and top of the player's body axis. */
  readonly a: THREE.Vector3;
  readonly b: THREE.Vector3;
  onGraze(point: THREE.Vector3, direction: THREE.Vector3, distance: number, tag: number): void;
}

const P_CAP = LIMITS.PROJECTILES;
const L_CAP = LIMITS.TELEGRAPH_LINES;
const R_CAP = LIMITS.SHOCK_RINGS;
const S_CAP = LIMITS.VFX_PARTICLES;
const MUZZLE_BLEND_S = 0.06;

export class EffectsPool {
  readonly rain: THREE.InstancedMesh;
  private readonly rainUniforms: {
    uRainTime: { value: number };
    uCamPos: { value: THREE.Vector3 };
    uBox: { value: THREE.Vector3 };
    uFall: { value: THREE.Vector3 };
    uRelVel: { value: THREE.Vector3 };
    uStreakLen: { value: number };
    uNeonReflect: { value: number };
    uCyan: { value: THREE.Color };
    uMagenta: { value: THREE.Color };
    uFogDensity: { value: number };
  };
  private rainTime = 0;

  // ---- projectiles (SoA) ----
  readonly tracers: THREE.InstancedMesh;
  private readonly pActive = new Uint8Array(P_CAP);
  private readonly pOwner = new Uint8Array(P_CAP);
  private readonly pPos = new Float32Array(P_CAP * 3);
  private readonly pVel = new Float32Array(P_CAP * 3);
  private readonly pOff = new Float32Array(P_CAP * 3);
  private readonly pOffLife = new Float32Array(P_CAP);
  private readonly pTravel = new Float32Array(P_CAP);
  private readonly pRange = new Float32Array(P_CAP);
  private readonly pDamage = new Float32Array(P_CAP);
  private readonly pHead = new Float32Array(P_CAP);
  private readonly pShield = new Float32Array(P_CAP);
  private readonly pColor = new Float32Array(P_CAP * 3);
  private readonly pWidth = new Float32Array(P_CAP);
  private readonly pTag = new Int32Array(P_CAP);
  private readonly pPierce = new Uint8Array(P_CAP);
  /** Body group a piercing round last passed through (−1 = none). */
  private readonly pSkipGroup = new Int32Array(P_CAP);
  /** SK_12: remaining slow time (s) and the factor to undo when it ends. */
  private readonly pSlowT = new Float32Array(P_CAP);
  private readonly pSlowK = new Float32Array(P_CAP);
  private pNext = 0;
  private readonly impact: ProjectileImpact = {
    owner: 'PLAYER',
    tag: 0,
    pierce: false,
    damage: 0,
    headMultiplier: 1,
    shieldMultiplier: 1,
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    direction: new THREE.Vector3(),
    kind: null,
    target: null,
    region: 'BODY',
    travelled: 0,
  };

  // ---- particles (SoA ring buffer) ----
  readonly sparks: THREE.InstancedMesh;
  private readonly sPos = new Float32Array(S_CAP * 3);
  private readonly sVel = new Float32Array(S_CAP * 3);
  private readonly sLife = new Float32Array(S_CAP);
  private readonly sMax = new Float32Array(S_CAP);
  private readonly sGrav = new Float32Array(S_CAP);
  private readonly sSize = new Float32Array(S_CAP);
  private readonly sColor = new Float32Array(S_CAP * 3);
  private sNext = 0;
  private readonly rng = createRng(0x5a4c);

  // ---- GRAZE tracking per round ----
  private readonly pGrazeMin = new Float32Array(P_CAP);
  private readonly pGrazeDone = new Uint8Array(P_CAP);
  /** Closest point of the round's path to the player axis (where the minimum was reached). */
  private readonly pGrazePt = new Float32Array(P_CAP * 3);

  // ---- telegraph lines (§5.1, 32-line pool) ----
  readonly lines: THREE.Mesh;
  private readonly lineGeo: THREE.InstancedBufferGeometry;
  private readonly lineStart: THREE.InstancedBufferAttribute;
  private readonly lineEnd: THREE.InstancedBufferAttribute;
  private readonly lineWidth: THREE.InstancedBufferAttribute;
  private readonly lineColor: THREE.InstancedBufferAttribute;
  private readonly lineDash: THREE.InstancedBufferAttribute;
  private readonly lineUniforms: { uViewportH: { value: number }; uMinPx: { value: number }; uTime: { value: number } };
  private readonly lInUse = new Uint8Array(L_CAP);
  private readonly lShown = new Uint8Array(L_CAP);
  private readonly lData = new Float32Array(L_CAP * 14);

  // ---- shock rings / prediction circles (24-ring pool) ----
  readonly rings: THREE.InstancedMesh;
  private readonly rActive = new Uint8Array(R_CAP);
  /** 0 = timed expanding shock ring, 1 = persistent (caller-driven) prediction circle. */
  private readonly rPersistent = new Uint8Array(R_CAP);
  private readonly rPos = new Float32Array(R_CAP * 3);
  private readonly rNormal = new Float32Array(R_CAP * 3);
  private readonly rR0 = new Float32Array(R_CAP);
  private readonly rR1 = new Float32Array(R_CAP);
  private readonly rLife = new Float32Array(R_CAP);
  private readonly rMax = new Float32Array(R_CAP);
  private readonly rColor = new Float32Array(R_CAP * 3);
  private rNext = 0;

  constructor(scene: THREE.Scene) {
    const count = LIMITS.RAIN_DROPS;
    const geo = new THREE.PlaneGeometry(1, 1);
    this.rainUniforms = {
      uRainTime: { value: 0 },
      uCamPos: { value: new THREE.Vector3() },
      uBox: { value: new THREE.Vector3(LIMITS.RAIN_BOX_X, LIMITS.RAIN_BOX_Y, LIMITS.RAIN_BOX_Z) },
      uFall: { value: new THREE.Vector3(1.6, -26.0, 0.9) },
      uRelVel: { value: new THREE.Vector3(1.6, -26.0, 0.9) },
      uStreakLen: { value: 0.75 },
      uNeonReflect: { value: 0 },
      uCyan: { value: new THREE.Color(COLORS.WALLRUN_CYAN) },
      uMagenta: { value: new THREE.Color(COLORS.NEON_MAGENTA) },
      uFogDensity: { value: RENDER.FOG_DENSITY },
    };
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: this.rainUniforms,
      vertexShader: /* glsl */ `
        uniform float uRainTime;
        uniform vec3 uCamPos;
        uniform vec3 uBox;
        uniform vec3 uFall;
        uniform vec3 uRelVel;
        uniform float uStreakLen;
        varying vec2 vUv;
        varying float vDist;
        varying float vSeed;
        varying float vSide;
        void main() {
          vec3 seed = instanceMatrix[3].xyz;
          float speedVar = 0.82 + fract(seed.x * 0.618 + seed.z * 0.414) * 0.36;
          vec3 p = seed + uFall * uRainTime * speedVar;
          // Wrap into the box centred on the camera.
          p = mod(p - uCamPos + uBox * 0.5, uBox) - uBox * 0.5 + uCamPos;
          float relSpeed = length(uRelVel);
          vec3 dir = relSpeed > 1e-3 ? uRelVel / relSpeed : vec3(0.0, -1.0, 0.0);
          float len = uStreakLen * (0.6 + relSpeed / 30.0);
          vec3 toCam = normalize(cameraPosition - p);
          vec3 side = cross(dir, toCam);
          float sl = length(side);
          vSide = sl;
          side = sl > 1e-4 ? side / sl : vec3(1.0, 0.0, 0.0);
          float width = 0.012 + 0.006 * fract(seed.y * 3.7);
          vec3 wp = p + side * position.x * width * 2.0 + dir * position.y * len;
          vUv = uv;
          vDist = length(p - cameraPosition);
          vSeed = fract(seed.x * 1.31 + seed.y * 0.77 + seed.z * 2.13);
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uNeonReflect;
        uniform vec3 uCyan;
        uniform vec3 uMagenta;
        uniform float uFogDensity;
        varying vec2 vUv;
        varying float vDist;
        varying float vSeed;
        varying float vSide;
        void main() {
          float across = 1.0 - abs(vUv.x - 0.5) * 2.0;
          float along = smoothstep(0.0, 0.35, vUv.y) * (1.0 - smoothstep(0.75, 1.0, vUv.y));
          float a = across * across * along;
          // Fade drops hugging the lens and far into the fog.
          a *= smoothstep(0.4, 2.2, vDist);
          // Streaks aimed straight at the lens collapse to dots: fade them out.
          a *= smoothstep(0.15, 0.55, vSide);
          float fog = exp(-uFogDensity * uFogDensity * vDist * vDist * 4.0);
          vec3 base = vec3(0.30, 0.36, 0.46) * 0.55;
          vec3 neon = mix(uCyan, uMagenta, step(0.5, vSeed)) * 1.25;
          vec3 c = mix(base, neon, uNeonReflect * (0.35 + 0.65 * step(0.4, vSeed)));
          gl_FragColor = vec4(c * a * fog, 1.0);
        }
      `,
    });
    this.rain = new THREE.InstancedMesh(geo, mat, count);
    this.rain.name = 'Rain';
    this.rain.frustumCulled = false;
    this.rain.renderOrder = 20;
    const rng = createRng(0x7a1);
    const m = new THREE.Matrix4();
    for (let i = 0; i < count; i++) {
      m.makeTranslation(rng() * LIMITS.RAIN_BOX_X, rng() * LIMITS.RAIN_BOX_Y, rng() * LIMITS.RAIN_BOX_Z);
      this.rain.setMatrixAt(i, m);
    }
    this.rain.instanceMatrix.needsUpdate = true;
    scene.add(this.rain);

    // Tracers: unit box stretched along the flight direction, additive HDR colour per instance.
    const tracerMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    this.tracers = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), tracerMat, P_CAP);
    this.tracers.name = 'Tracers';
    this.tracers.frustumCulled = false;
    this.tracers.count = 0;
    this.tracers.renderOrder = 22;
    this.tracers.setColorAt(0, _c.setRGB(1, 1, 1));
    scene.add(this.tracers);

    const sparkMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    this.sparks = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), sparkMat, S_CAP);
    this.sparks.name = 'Particles';
    this.sparks.frustumCulled = false;
    this.sparks.count = 0;
    this.sparks.renderOrder = 23;
    this.sparks.setColorAt(0, _c.setRGB(1, 1, 1));
    scene.add(this.sparks);

    // ---- Telegraph lines: one ribbon quad per instance, oriented to face the camera around its axis ----
    const lg = new THREE.InstancedBufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, -1, 1, 0, 1, 1, 0], 3));
    lg.setIndex([0, 1, 2, 2, 1, 3]);
    const mk = (n: number): THREE.InstancedBufferAttribute => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(L_CAP * n), n);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.lineStart = mk(3);
    this.lineEnd = mk(3);
    this.lineWidth = mk(2);
    this.lineColor = mk(4);
    this.lineDash = mk(1);
    lg.setAttribute('aStart', this.lineStart);
    lg.setAttribute('aEnd', this.lineEnd);
    lg.setAttribute('aWidth', this.lineWidth);
    lg.setAttribute('aColor', this.lineColor);
    lg.setAttribute('aDash', this.lineDash);
    lg.instanceCount = 0;
    this.lineGeo = lg;
    this.lineUniforms = { uViewportH: { value: 1080 }, uMinPx: { value: 1.35 }, uTime: { value: 0 } };
    const lineMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: this.lineUniforms,
      vertexShader: /* glsl */ `
        uniform float uViewportH;
        uniform float uMinPx;
        attribute vec3 aStart;
        attribute vec3 aEnd;
        attribute vec2 aWidth;
        attribute vec4 aColor;
        attribute float aDash;
        varying vec4 vColor;
        varying float vAcross;
        varying float vAlong;
        varying float vDash;
        varying float vCoverage;
        void main() {
          vec3 axis = aEnd - aStart;
          float len = max(length(axis), 1e-4);
          vec3 dir = axis / len;
          vec3 p = aStart + axis * position.y;
          vec3 toCam = cameraPosition - p;
          float d = max(length(toCam), 1e-3);
          vec3 side = cross(dir, toCam / d);
          float sl = length(side);
          side = sl > 1e-4 ? side / sl : normalize(cross(dir, abs(dir.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
          float w = mix(aWidth.x, aWidth.y, position.y);
          // World size of one pixel at this depth; never thinner than uMinPx pixels on screen.
          float pxWorld = d * 2.0 / (projectionMatrix[1][1] * uViewportH);
          float wEff = max(w, uMinPx * pxWorld);
          vCoverage = clamp(w / wEff, 0.0, 1.0);
          vec3 wp = p + side * position.x * wEff * 0.5;
          vColor = aColor;
          vAcross = position.x;
          vAlong = position.y * len;
          vDash = aDash;
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        varying vec4 vColor;
        varying float vAcross;
        varying float vAlong;
        varying float vDash;
        varying float vCoverage;
        void main() {
          float core = 1.0 - abs(vAcross);
          float a = core * core * (3.0 - 2.0 * core);
          if (vDash > 0.5) {
            // Dotted ACQUIRING line, dashes stream toward the target.
            float ph = fract((vAlong - uTime * 7.0) / 0.9);
            a *= smoothstep(0.0, 0.08, ph) * (1.0 - smoothstep(0.55, 0.63, ph));
          }
          // Thin lines widened to the pixel floor keep their true energy (fainter, never vanishing).
          float energy = mix(0.35, 1.0, vCoverage);
          gl_FragColor = vec4(vColor.rgb * vColor.a * a * energy, 1.0);
        }
      `,
    });
    this.lines = new THREE.Mesh(lg, lineMat);
    this.lines.name = 'TelegraphLines';
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 24;
    scene.add(this.lines);

    // ---- Shock rings: flat annulus, additive HDR colour per instance ----
    const ringGeo = new THREE.RingGeometry(0.9, 1.0, 64, 1);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
    this.rings = new THREE.InstancedMesh(ringGeo, ringMat, R_CAP);
    this.rings.name = 'ShockRings';
    this.rings.frustumCulled = false;
    this.rings.count = 0;
    this.rings.renderOrder = 21;
    this.rings.setColorAt(0, _c.setRGB(1, 1, 1));
    scene.add(this.rings);
  }

  // =============================================================================================
  // Telegraph lines (§5.1)
  // =============================================================================================
  /** Reserves a line slot; −1 when all 32 are in use (the caller must then hold its attack). */
  acquireLine(): number {
    for (let i = 0; i < L_CAP; i++) {
      if (!this.lInUse[i]) {
        this.lInUse[i] = 1;
        this.lShown[i] = 0;
        return i;
      }
    }
    return -1;
  }

  releaseLine(i: number): void {
    if (i < 0 || i >= L_CAP) return;
    this.lInUse[i] = 0;
    this.lShown[i] = 0;
  }

  /** Number of free slots (an attack needing several lines checks this first). */
  get freeLines(): number {
    let n = 0;
    for (let i = 0; i < L_CAP; i++) if (!this.lInUse[i]) n++;
    return n;
  }

  /**
   * Updates a reserved line for this frame. Widths in metres at the start / end; `color` is linear RGB
   * multiplied by `intensity` (HDR) and `opacity`. `visible = false` hides it (e.g. the blink off-phase).
   */
  setLine(i: number, start: THREE.Vector3, end: THREE.Vector3, widthStart: number, widthEnd: number, color: THREE.Color, intensity: number, opacity: number, dashed: boolean, visible = true): void {
    if (i < 0 || i >= L_CAP || !this.lInUse[i]) return;
    const o = i * 14;
    const d = this.lData;
    d[o] = start.x;
    d[o + 1] = start.y;
    d[o + 2] = start.z;
    d[o + 3] = end.x;
    d[o + 4] = end.y;
    d[o + 5] = end.z;
    d[o + 6] = widthStart;
    d[o + 7] = widthEnd;
    d[o + 8] = color.r * intensity;
    d[o + 9] = color.g * intensity;
    d[o + 10] = color.b * intensity;
    d[o + 11] = opacity;
    d[o + 12] = dashed ? 1 : 0;
    d[o + 13] = 0;
    this.lShown[i] = visible ? 1 : 0;
  }

  hideLine(i: number): void {
    if (i >= 0 && i < L_CAP) this.lShown[i] = 0;
  }

  private syncLines(realTime: number, viewportH: number): void {
    let n = 0;
    const d = this.lData;
    const st = this.lineStart.array as Float32Array;
    const en = this.lineEnd.array as Float32Array;
    const wd = this.lineWidth.array as Float32Array;
    const co = this.lineColor.array as Float32Array;
    const da = this.lineDash.array as Float32Array;
    for (let i = 0; i < L_CAP; i++) {
      if (!this.lInUse[i] || !this.lShown[i]) continue;
      const o = i * 14;
      st[n * 3] = d[o];
      st[n * 3 + 1] = d[o + 1];
      st[n * 3 + 2] = d[o + 2];
      en[n * 3] = d[o + 3];
      en[n * 3 + 1] = d[o + 4];
      en[n * 3 + 2] = d[o + 5];
      wd[n * 2] = d[o + 6];
      wd[n * 2 + 1] = d[o + 7];
      co[n * 4] = d[o + 8];
      co[n * 4 + 1] = d[o + 9];
      co[n * 4 + 2] = d[o + 10];
      co[n * 4 + 3] = d[o + 11];
      da[n] = d[o + 12];
      n++;
    }
    this.lineGeo.instanceCount = n;
    if (n > 0) {
      this.lineStart.needsUpdate = true;
      this.lineEnd.needsUpdate = true;
      this.lineWidth.needsUpdate = true;
      this.lineColor.needsUpdate = true;
      this.lineDash.needsUpdate = true;
    }
    this.lines.visible = n > 0;
    this.lineUniforms.uTime.value = realTime;
    this.lineUniforms.uViewportH.value = viewportH;
  }

  // =============================================================================================
  // Shock rings & prediction circles
  // =============================================================================================
  /** Expanding ring from r0 to r1 over `duration` (simulation seconds), fading out. */
  spawnRing(position: THREE.Vector3, normal: THREE.Vector3, color: number, intensity: number, r0: number, r1: number, duration: number): void {
    let i = this.rNext;
    for (let k = 0; k < R_CAP; k++) {
      const j = (this.rNext + k) % R_CAP;
      if (!this.rActive[j]) {
        i = j;
        break;
      }
    }
    if (this.rActive[i] && this.rPersistent[i]) return; // never steal a live prediction circle
    this.rNext = (i + 1) % R_CAP;
    this.writeRing(i, position, normal, color, intensity, r0, r1);
    this.rPersistent[i] = 0;
    this.rLife[i] = duration;
    this.rMax[i] = duration;
  }

  /** Reserves a persistent ring (boss dive prediction circle); −1 when the pool is full. */
  acquireRing(): number {
    for (let i = 0; i < R_CAP; i++) {
      if (!this.rActive[i]) {
        this.rActive[i] = 1;
        this.rPersistent[i] = 1;
        this.rLife[i] = 1;
        this.rMax[i] = 1;
        this.rR0[i] = 0;
        this.rR1[i] = 0;
        return i;
      }
    }
    return -1;
  }

  /** Drives a persistent ring each frame (radius, colour × intensity; intensity 0 hides it). */
  setRing(i: number, position: THREE.Vector3, normal: THREE.Vector3, color: number, intensity: number, radius: number): void {
    if (i < 0 || i >= R_CAP || !this.rPersistent[i]) return;
    this.writeRing(i, position, normal, color, intensity, radius, radius);
    this.rPersistent[i] = 1;
  }

  releaseRing(i: number): void {
    if (i < 0 || i >= R_CAP) return;
    this.rActive[i] = 0;
    this.rPersistent[i] = 0;
  }

  private writeRing(i: number, position: THREE.Vector3, normal: THREE.Vector3, color: number, intensity: number, r0: number, r1: number): void {
    this.rActive[i] = 1;
    this.rPos[i * 3] = position.x;
    this.rPos[i * 3 + 1] = position.y;
    this.rPos[i * 3 + 2] = position.z;
    this.rNormal[i * 3] = normal.x;
    this.rNormal[i * 3 + 1] = normal.y;
    this.rNormal[i * 3 + 2] = normal.z;
    this.rR0[i] = r0;
    this.rR1[i] = r1;
    _c.setHex(color);
    this.rColor[i * 3] = _c.r * intensity;
    this.rColor[i * 3 + 1] = _c.g * intensity;
    this.rColor[i * 3 + 2] = _c.b * intensity;
  }

  private updateRings(simDt: number): void {
    let n = 0;
    for (let i = 0; i < R_CAP; i++) {
      if (!this.rActive[i]) continue;
      let k = 1;
      let radius = this.rR1[i];
      if (!this.rPersistent[i]) {
        this.rLife[i] -= simDt;
        if (this.rLife[i] <= 0) {
          this.rActive[i] = 0;
          continue;
        }
        const t = 1 - this.rLife[i] / this.rMax[i];
        const e = 1 - (1 - t) * (1 - t) * (1 - t);
        radius = this.rR0[i] + (this.rR1[i] - this.rR0[i]) * e;
        k = 1 - t;
      }
      if (radius <= 1e-3 || (this.rColor[i * 3] + this.rColor[i * 3 + 1] + this.rColor[i * 3 + 2]) * k <= 1e-4) continue;
      _ringN.set(this.rNormal[i * 3], this.rNormal[i * 3 + 1], this.rNormal[i * 3 + 2]);
      if (_ringN.lengthSq() < 1e-6) _ringN.copy(Y_UP);
      _q.setFromUnitVectors(Y_UP, _ringN.normalize());
      _s.set(radius, radius, radius);
      _a.set(this.rPos[i * 3], this.rPos[i * 3 + 1], this.rPos[i * 3 + 2]);
      _m4.compose(_a, _q, _s);
      this.rings.setMatrixAt(n, _m4);
      _c.setRGB(this.rColor[i * 3] * k, this.rColor[i * 3 + 1] * k, this.rColor[i * 3 + 2] * k);
      this.rings.setColorAt(n, _c);
      n++;
    }
    this.rings.count = n;
    this.rings.instanceMatrix.needsUpdate = true;
    if (this.rings.instanceColor) this.rings.instanceColor.needsUpdate = true;
  }

  // =============================================================================================
  // Projectiles
  // =============================================================================================
  /**
   * Fires a round from `origin` (the eye) along unit `dir`. `muzzle` is where the tracer should appear to
   * start on screen; the visual offset decays to the true path within 60 ms. Returns the pool slot.
   */
  spawnProjectile(origin: THREE.Vector3, dir: THREE.Vector3, spec: ProjectileSpec, muzzle?: THREE.Vector3): number {
    // Ring-buffer slot (oldest round is recycled when all 120 are in flight).
    let i = this.pNext;
    for (let k = 0; k < P_CAP; k++) {
      const j = (this.pNext + k) % P_CAP;
      if (!this.pActive[j]) {
        i = j;
        break;
      }
    }
    this.pNext = (i + 1) % P_CAP;
    this.pActive[i] = 1;
    this.pOwner[i] = spec.owner === 'PLAYER' ? 0 : 1;
    this.pPos[i * 3] = origin.x;
    this.pPos[i * 3 + 1] = origin.y;
    this.pPos[i * 3 + 2] = origin.z;
    this.pVel[i * 3] = dir.x * spec.speed;
    this.pVel[i * 3 + 1] = dir.y * spec.speed;
    this.pVel[i * 3 + 2] = dir.z * spec.speed;
    if (muzzle) {
      this.pOff[i * 3] = muzzle.x - origin.x;
      this.pOff[i * 3 + 1] = muzzle.y - origin.y;
      this.pOff[i * 3 + 2] = muzzle.z - origin.z;
      this.pOffLife[i] = MUZZLE_BLEND_S;
    } else {
      this.pOff[i * 3] = this.pOff[i * 3 + 1] = this.pOff[i * 3 + 2] = 0;
      this.pOffLife[i] = 0;
    }
    this.pTravel[i] = 0;
    this.pRange[i] = spec.range;
    this.pDamage[i] = spec.damage;
    this.pHead[i] = spec.headMultiplier;
    this.pShield[i] = spec.shieldMultiplier;
    _c.setHex(spec.color);
    this.pColor[i * 3] = _c.r * spec.intensity;
    this.pColor[i * 3 + 1] = _c.g * spec.intensity;
    this.pColor[i * 3 + 2] = _c.b * spec.intensity;
    this.pWidth[i] = spec.width;
    this.pTag[i] = spec.tag;
    this.pPierce[i] = spec.pierce ? 1 : 0;
    this.pSkipGroup[i] = -1;
    this.pSlowT[i] = 0;
    this.pSlowK[i] = 1;
    this.pGrazeMin[i] = Infinity;
    this.pGrazeDone[i] = spec.owner === 'PLAYER' ? 1 : 0;
    return i;
  }

  /** Cancels all rounds of one owner (e.g. boss finisher clears enemy fire). */
  clearProjectiles(owner?: ProjectileOwner): void {
    for (let i = 0; i < P_CAP; i++) {
      if (!this.pActive[i]) continue;
      if (owner === undefined || (owner === 'PLAYER' ? 0 : 1) === this.pOwner[i]) this.pActive[i] = 0;
    }
  }

  /**
   * Advances every round by `dt` (simulation time), testing the swept segment against the world and the
   * hitboxes of the opposing side. `onImpact` receives a reused impact record.
   */
  updateProjectiles(
    dt: number,
    physics: PhysicsWorld,
    targetsFor: (owner: ProjectileOwner) => readonly HitboxTarget[],
    onImpact: (impact: ProjectileImpact) => void,
    graze: GrazeProbe | null = null,
  ): void {
    for (let i = 0; i < P_CAP; i++) {
      if (!this.pActive[i]) continue;
      const o = i * 3;
      if (this.pSlowT[i] > 0) {
        this.pSlowT[i] -= dt;
        if (this.pSlowT[i] <= 0) {
          // Slow window over: restore the original velocity.
          const k = 1 / this.pSlowK[i];
          this.pVel[o] *= k;
          this.pVel[o + 1] *= k;
          this.pVel[o + 2] *= k;
          this.pSlowK[i] = 1;
        }
      }
      _a.set(this.pPos[o], this.pPos[o + 1], this.pPos[o + 2]);
      _d.set(this.pVel[o], this.pVel[o + 1], this.pVel[o + 2]);
      const speed = _d.length();
      let step = speed * dt;
      const remaining = this.pRange[i] - this.pTravel[i];
      if (step > remaining) step = remaining;
      _d.divideScalar(speed);
      _b.copy(_d).multiplyScalar(step).add(_a);

      physics.segmentCast(_a, _b, _worldHit);
      const owner: ProjectileOwner = this.pOwner[i] === 0 ? 'PLAYER' : 'ENEMY';
      const targets = targetsFor(owner);
      let tHit = false;
      if (targets.length) {
        const pierce = this.pPierce[i] === 1;
        physics.raycastTargets(_a, _d, _worldHit.hit ? _worldHit.distance : step, targets, _targetHit, pierce ? this.pSkipGroup[i] : -1, pierce);
        tHit = _targetHit.hit;
      }
      // GRAZE: closest approach of this step's path (up to a world hit) to the player's body axis.
      if (!tHit && graze && graze.active && !this.pGrazeDone[i]) {
        _segEnd.copy(_worldHit.hit ? _worldHit.point : _b);
        this.trackGraze(i, _a, _segEnd, _d, graze, physics);
      }
      if (_worldHit.hit || tHit) {
        const im = this.impact;
        im.owner = owner;
        im.tag = this.pTag[i];
        im.pierce = tHit && this.pPierce[i] === 1;
        im.damage = this.pDamage[i];
        im.headMultiplier = this.pHead[i];
        im.shieldMultiplier = this.pShield[i];
        im.direction.copy(_d);
        if (tHit) {
          im.point.copy(_targetHit.point);
          im.normal.copy(_d).negate();
          im.kind = null;
          im.target = _targetHit.target;
          im.region = _targetHit.region;
          im.travelled = this.pTravel[i] + _targetHit.distance;
        } else {
          im.point.copy(_worldHit.point);
          im.normal.copy(_worldHit.normal);
          im.kind = _worldHit.kind;
          im.target = null;
          im.region = 'BODY';
          im.travelled = this.pTravel[i] + _worldHit.distance;
          this.burst(im.point, im.normal, im.kind === 'WATER' ? BURST.WATER : BURST.SPARK);
        }
        if (im.pierce && _targetHit.target) {
          // Piercing round: keep flying from just past the hit, never re-hitting this body.
          this.pSkipGroup[i] = _targetHit.target.group ?? _targetHit.target.id;
          this.pPos[o] = _targetHit.point.x + _d.x * 0.02;
          this.pPos[o + 1] = _targetHit.point.y + _d.y * 0.02;
          this.pPos[o + 2] = _targetHit.point.z + _d.z * 0.02;
          this.pTravel[i] += _targetHit.distance;
          onImpact(im);
          if (this.pTravel[i] >= this.pRange[i] - 1e-3) this.pActive[i] = 0;
          continue;
        }
        this.pActive[i] = 0;
        onImpact(im);
        continue;
      }
      this.pPos[o] = _b.x;
      this.pPos[o + 1] = _b.y;
      this.pPos[o + 2] = _b.z;
      this.pTravel[i] += step;
      if (this.pTravel[i] >= this.pRange[i] - 1e-3) this.pActive[i] = 0;
    }
  }

  /**
   * Updates the round's minimum distance to the player axis; once the round passes the player's closest
   * point (or stops at a wall beyond it) the GRAZE band 0.45 … 1.35 m is evaluated exactly once.
   */
  private trackGraze(i: number, a: THREE.Vector3, b: THREE.Vector3, dir: THREE.Vector3, g: GrazeProbe, physics: PhysicsWorld): void {
    _chest.addVectors(g.a, g.b).multiplyScalar(0.5);
    const along = (_chest.x - a.x) * dir.x + (_chest.y - a.y) * dir.y + (_chest.z - a.z) * dir.z;
    if (along < 0 && this.pTravel[i] === 0) {
      // Fired away from the player: never a near miss.
      this.pGrazeDone[i] = 1;
      return;
    }
    const dist = segmentSegmentDistance(a, b, g.a, g.b, _grazePt);
    const o = i * 3;
    if (dist < this.pGrazeMin[i]) {
      this.pGrazeMin[i] = dist;
      this.pGrazePt[o] = _grazePt.x;
      this.pGrazePt[o + 1] = _grazePt.y;
      this.pGrazePt[o + 2] = _grazePt.z;
    }
    const stepLen = a.distanceTo(b);
    if (along <= stepLen) {
      this.pGrazeDone[i] = 1;
      const m = this.pGrazeMin[i];
      if (m < TELEGRAPH.GRAZE_MIN_DIST || m > TELEGRAPH.GRAZE_MAX_DIST) return;
      // One sight check chest → closest point: a round passing on the far side of cover is not a near miss.
      _grazePt.set(this.pGrazePt[o], this.pGrazePt[o + 1], this.pGrazePt[o + 2]);
      if (!physics.lineOfSight(_chest, _grazePt, GRAZE_LOS_TOLERANCE_M)) return;
      g.onGraze(_grazePt, dir, m, this.pTag[i]);
    }
  }

  /**
   * Scales (×k) the speed of enemy rounds within `radius` of `point` for `durationS` of simulation time, then
   * restores it (SK_12 Phantom Graze: half speed for 0.6 s). Rounds already slowed are not slowed twice.
   */
  scaleEnemyRoundSpeed(point: THREE.Vector3, radius: number, k: number, durationS: number): void {
    const r2 = radius * radius;
    for (let i = 0; i < P_CAP; i++) {
      if (!this.pActive[i] || this.pOwner[i] === 0) continue;
      if (this.pSlowT[i] > 0) {
        this.pSlowT[i] = Math.max(this.pSlowT[i], durationS);
        continue;
      }
      const o = i * 3;
      const dx = this.pPos[o] - point.x;
      const dy = this.pPos[o + 1] - point.y;
      const dz = this.pPos[o + 2] - point.z;
      if (dx * dx + dy * dy + dz * dz > r2) continue;
      this.pVel[o] *= k;
      this.pVel[o + 1] *= k;
      this.pVel[o + 2] *= k;
      this.pSlowT[i] = durationS;
      this.pSlowK[i] = k;
    }
  }

  /** Writes tracer instances (real-time visual blend of the muzzle offset). */
  private syncTracers(realDt: number): void {
    let n = 0;
    for (let i = 0; i < P_CAP; i++) {
      if (!this.pActive[i]) continue;
      const o = i * 3;
      _d.set(this.pVel[o], this.pVel[o + 1], this.pVel[o + 2]);
      const speed = _d.length();
      _d.divideScalar(speed);
      if (this.pOffLife[i] > 0) this.pOffLife[i] = Math.max(0, this.pOffLife[i] - realDt);
      const k = this.pOffLife[i] / MUZZLE_BLEND_S;
      const len = Math.max(0.4, Math.min(this.pTravel[i] + 0.4, speed * 0.032));
      _a.set(this.pPos[o] + this.pOff[o] * k, this.pPos[o + 1] + this.pOff[o + 1] * k, this.pPos[o + 2] + this.pOff[o + 2] * k);
      _b.copy(_a).addScaledVector(_d, -len * 0.5);
      _q.setFromUnitVectors(Z_AXIS, _d);
      _s.set(this.pWidth[i], this.pWidth[i], len);
      _m4.compose(_b, _q, _s);
      this.tracers.setMatrixAt(n, _m4);
      _c.setRGB(this.pColor[o], this.pColor[o + 1], this.pColor[o + 2]);
      this.tracers.setColorAt(n, _c);
      n++;
    }
    this.tracers.count = n;
    this.tracers.instanceMatrix.needsUpdate = true;
    if (this.tracers.instanceColor) this.tracers.instanceColor.needsUpdate = true;
  }

  // =============================================================================================
  // Particles
  // =============================================================================================
  /** Emits a burst around `normal` (unit) at `point`. */
  burst(point: THREE.Vector3, normal: THREE.Vector3, b: ParticleBurst, colorOverride = -1): void {
    _c.setHex(colorOverride >= 0 ? colorOverride : b.color);
    for (let k = 0; k < b.count; k++) {
      const i = this.sNext;
      this.sNext = (this.sNext + 1) % S_CAP;
      const o = i * 3;
      // Random direction in a cone around the normal.
      const rx = this.rng() * 2 - 1;
      const ry = this.rng() * 2 - 1;
      const rz = this.rng() * 2 - 1;
      _d.set(normal.x + rx * b.spread, normal.y + ry * b.spread, normal.z + rz * b.spread);
      if (_d.lengthSq() < 1e-6) _d.copy(normal);
      _d.normalize().multiplyScalar(b.speed * (0.45 + this.rng() * 0.75));
      this.sPos[o] = point.x;
      this.sPos[o + 1] = point.y;
      this.sPos[o + 2] = point.z;
      this.sVel[o] = _d.x;
      this.sVel[o + 1] = _d.y;
      this.sVel[o + 2] = _d.z;
      const life = b.life * (0.6 + this.rng() * 0.6);
      this.sLife[i] = life;
      this.sMax[i] = life;
      this.sGrav[i] = b.gravity;
      this.sSize[i] = b.size * (0.7 + this.rng() * 0.6);
      this.sColor[o] = _c.r * b.intensity;
      this.sColor[o + 1] = _c.g * b.intensity;
      this.sColor[o + 2] = _c.b * b.intensity;
    }
  }

  private updateParticles(simDt: number): void {
    let n = 0;
    for (let i = 0; i < S_CAP; i++) {
      if (this.sLife[i] <= 0) continue;
      this.sLife[i] -= simDt;
      if (this.sLife[i] <= 0) continue;
      const o = i * 3;
      this.sVel[o + 1] += this.sGrav[i] * simDt;
      const drag = Math.exp(-2.2 * simDt);
      this.sVel[o] *= drag;
      this.sVel[o + 1] *= drag;
      this.sVel[o + 2] *= drag;
      this.sPos[o] += this.sVel[o] * simDt;
      this.sPos[o + 1] += this.sVel[o + 1] * simDt;
      this.sPos[o + 2] += this.sVel[o + 2] * simDt;
      _d.set(this.sVel[o], this.sVel[o + 1], this.sVel[o + 2]);
      const sp = _d.length();
      if (sp > 1e-4) _q.setFromUnitVectors(Z_AXIS, _d.divideScalar(sp));
      else _q.identity();
      const t = this.sLife[i] / this.sMax[i];
      const size = this.sSize[i];
      _s.set(size, size, size + sp * 0.025);
      _a.set(this.sPos[o], this.sPos[o + 1], this.sPos[o + 2]);
      _m4.compose(_a, _q, _s);
      this.sparks.setMatrixAt(n, _m4);
      _c.setRGB(this.sColor[o] * t, this.sColor[o + 1] * t, this.sColor[o + 2] * t);
      this.sparks.setColorAt(n, _c);
      n++;
    }
    this.sparks.count = n;
    this.sparks.instanceMatrix.needsUpdate = true;
    if (this.sparks.instanceColor) this.sparks.instanceColor.needsUpdate = true;
  }

  /** FLOW S+: raindrops strongly reflect cyan / magenta neon (0..1). */
  setRainNeonReflect(v: number): void {
    this.rainUniforms.uNeonReflect.value = v;
  }

  /**
   * @param simDt scaled simulation delta (bullet time slows the rain to 0.25×)
   * @param cameraPos current camera world position
   * @param cameraVel current camera world velocity (m/s, simulation space)
   */
  update(simDt: number, realDt: number, cameraPos: THREE.Vector3, cameraVel: THREE.Vector3, realTime = 0, viewportH = 1080): void {
    this.syncTracers(realDt);
    this.updateParticles(simDt);
    this.updateRings(simDt);
    this.syncLines(realTime, viewportH);
    this.rainTime += simDt;
    // Keep float precision in the shader: rebase the rain clock once per hour (one imperceptible reshuffle).
    if (this.rainTime > 3600) this.rainTime -= 3600;
    const u = this.rainUniforms;
    u.uRainTime.value = this.rainTime;
    u.uCamPos.value.copy(cameraPos);
    _relVel.copy(u.uFall.value).sub(cameraVel);
    u.uRelVel.value.copy(_relVel);
  }
}

/**
 * Closest distance between segments p1–q1 and p2–q2 (Ericson, Real-Time Collision Detection §5.1.9).
 * Writes the closest point on the first segment into `outOnFirst`. Scalar math only (no allocation).
 */
function segmentSegmentDistance(p1: THREE.Vector3, q1: THREE.Vector3, p2: THREE.Vector3, q2: THREE.Vector3, outOnFirst: THREE.Vector3): number {
  const d1x = q1.x - p1.x;
  const d1y = q1.y - p1.y;
  const d1z = q1.z - p1.z;
  const d2x = q2.x - p2.x;
  const d2y = q2.y - p2.y;
  const d2z = q2.z - p2.z;
  const rx = p1.x - p2.x;
  const ry = p1.y - p2.y;
  const rz = p1.z - p2.z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  let s = 0;
  let t = 0;
  if (a <= 1e-9 && e <= 1e-9) {
    s = 0;
    t = 0;
  } else if (a <= 1e-9) {
    t = Math.min(1, Math.max(0, f / e));
  } else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= 1e-9) {
      s = Math.min(1, Math.max(0, -c / a));
    } else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const denom = a * e - b * b;
      s = denom > 1e-9 ? Math.min(1, Math.max(0, (b * f - c * e) / denom)) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = Math.min(1, Math.max(0, -c / a));
      } else if (t > 1) {
        t = 1;
        s = Math.min(1, Math.max(0, (b - c) / a));
      }
    }
  }
  const c1x = p1.x + d1x * s;
  const c1y = p1.y + d1y * s;
  const c1z = p1.z + d1z * s;
  const c2x = p2.x + d2x * t;
  const c2y = p2.y + d2y * t;
  const c2z = p2.z + d2z * t;
  outOnFirst.set(c1x, c1y, c1z);
  const dx = c1x - c2x;
  const dy = c1y - c2y;
  const dz = c1z - c2z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
