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
 *  - 5B-4 scorch decals: 48 hot impact marks in ONE InstancedMesh (ring buffer) lying on the hit normal;
 *    white-hot orange (enemy rounds: crimson-hot) with an energy-cyan rim, cooling to dark red and gone in
 *    0.85 s of simulation time — all colour / fade work is done in the shader.
 */
import * as THREE from 'three';
import { COLORS, JUICE, LIMITS, RENDER, SCORCH, TELEGRAPH, VFX7, createRng } from '../config/constants';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  type HitboxTarget,
  type HitRegion,
  type PhysicsWorld,
  createRayHit,
  createTargetHit,
} from '../world/PhysicsWorld';
import type { BoxCollider, ColliderKind } from '../world/CityBuilder';
import type { CityLightInjector } from '../world/CityAtmosphere';

const _relVel = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _d = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const _qSpin = new THREE.Quaternion();
const _worldHit = createRayHit();
const _targetHit = createTargetHit();
const _chest = new THREE.Vector3();
const _grazePt = new THREE.Vector3();
/** A wall the round itself stopped on (≤ 5 cm short of the closest point) does not count as cover. */
const GRAZE_LOS_TOLERANCE_M = 0.05;
const _segEnd = new THREE.Vector3();
const _vanishPt = new THREE.Vector3();
const _ringN = new THREE.Vector3();
const Y_UP = new THREE.Vector3(0, 1, 0);
/** 11A-3: dedicated projectile sweep scratch (never touched by burst()/addScorch()/breakable hooks). */
const _pA = new THREE.Vector3();
const _pB = new THREE.Vector3();
const _pD = new THREE.Vector3();
/** 11A-3: max glass pass-through re-sweeps of one round inside one fixed step. */
const MAX_GLASS_RESWEEPS = 4;
/** 11A-3: a round passing through glass continues from 2 cm past the hit point. */
const GLASS_PASS_ADVANCE_M = 0.02;

export type ProjectileOwner = 'PLAYER' | 'ENEMY';

/**
 * 11A-2/11A-3: world objects a swept round can break ('GLASS' panes, 'DOOR' leaves). Called synchronously from
 * `updateProjectiles()` when the world hit kind is 'GLASS' or 'DOOR'. Return true to let the round pass through
 * (glass, 100 % damage preserved) or false to stop it (doors). `point` / `dir` are pool scratch: copy, never keep.
 */
export interface ProjectileBreakables {
  onProjectileHit(collider: BoxCollider, point: THREE.Vector3, dir: THREE.Vector3, damage: number, sniper: boolean, owner: ProjectileOwner): boolean;
  /**
   * 11B-1: collider-less destructible props along this swept (sub-)step `start + dir * [0, len]` (`len` already
   * clipped to the world / hitbox hit). Light props break and the round passes; a surviving heavy prop (bins / bags /
   * drums) stops it — returns that distance, else -1. Called at ARRIVAL each fixed step (Bullet-Time accurate).
   */
  raycastProp?(start: THREE.Vector3, dir: THREE.Vector3, len: number, damage: number, sniper: boolean, byPlayer: boolean): number;
}

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
  /** 8A-3 Aegis rule: a piercing round is still consumed by an energy shield (K-90 sniper). */
  readonly shieldStop?: boolean;
  /** 7B-7: leaves a plasma smoke trail (pistol, sniper and boss heavy rounds). */
  readonly smoke?: boolean;
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
  /** 10A-1: non-essential ambient/minor bursts auto-skip beyond 52 m from the camera. */
  readonly minor?: boolean;
}

const TELEGRAPH_VISOR_SHARDS = JUICE.HEADSHOT_VISOR_PARTICLES;
const MINOR_SKIP_DIST_SQ = RENDER.MINOR_PARTICLE_SKIP_DIST_M * RENDER.MINOR_PARTICLE_SKIP_DIST_M;

export const BURST = {
  SPARK: { count: 10, color: 0xffc27a, intensity: 2.4, speed: 9, spread: 0.85, life: 0.35, gravity: -14, size: 0.035, minor: true },
  WATER: { count: 14, color: 0x9fdcff, intensity: 1.1, speed: 5.5, spread: 0.45, life: 0.6, gravity: -11, size: 0.05, minor: true },
  LAND_SPLASH: { count: 26, color: 0xb6e6ff, intensity: 1.0, speed: 6.5, spread: 0.7, life: 0.7, gravity: -12, size: 0.06, minor: true },
  MUZZLE: { count: 6, color: 0x7ffcff, intensity: 2.8, speed: 7, spread: 0.35, life: 0.12, gravity: 0, size: 0.03 },
  HOOK: { count: 12, color: 0xffd26a, intensity: 2.6, speed: 7, spread: 0.9, life: 0.3, gravity: -10, size: 0.04 },
  /** Body hit: fine sparks only (no hitstop). */
  HIT_SPARK: { count: 6, color: 0xfff0d0, intensity: 3.0, speed: 7, spread: 0.9, life: 0.22, gravity: -12, size: 0.028, minor: true },
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
  MISSILE_TRAIL: { count: 1, color: 0xff6a2a, intensity: 1.6, speed: 1.2, spread: 1.0, life: 0.45, gravity: 1.0, size: 0.09, minor: true },
  /** Phantom dash-slash arc sparks. */
  SLASH: { count: 14, color: 0xd04dff, intensity: 3.6, speed: 9, spread: 0.7, life: 0.3, gravity: -4, size: 0.035 },
  /** 10A-3.2: Sniper post-shot rising translucent barrel heat-vent vapor puffs. */
  BARREL_STEAM: { count: 2, color: 0x9ceeff, intensity: 0.48, speed: 0.45, spread: 0.42, life: 0.55, gravity: 1.35, size: 0.022 },
  /** 10D-4: faulty alley breaker — blue-white arcing sparks spraying out of the wall box. */
  BREAKER_SPARK: { count: 8, color: 0xbfe8ff, intensity: 3.2, speed: 6.5, spread: 0.55, life: 0.45, gravity: -14, size: 0.03, minor: true },
  /** 10D-4: rain dripping off a storefront canopy lip (falls straight down). */
  CANOPY_DRIP: { count: 1, color: 0xa8d8ff, intensity: 0.7, speed: 0.4, spread: 0.06, life: 0.42, gravity: -9.8, size: 0.022, minor: true },
  /** 11A-3: one tiny rising spark when a DestructDebris chunk finishes its digital dissolve. */
  DEBRIS_VANISH: { count: 1, color: 0x7ffcff, intensity: 2.2, speed: 1.1, spread: 0.25, life: 0.45, gravity: 2.6, size: 0.026, minor: true },
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
const CASING_CAP = 16;
const MUZZLE_BLEND_S = 0.06;
const _cEuler = new THREE.Euler();

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
    uIndoor: { value: THREE.Vector3[] };
    uIndoorN: { value: number };
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
  private hasCamPos = false;
  private readonly rng = createRng(0x5a4c);

  // ---- 10A-3.2 3D ejected brass/rail casings (pooled into sparks InstancedMesh, +0 extra draw calls) ----
  private readonly cLife = new Float32Array(CASING_CAP);
  private readonly cMax = new Float32Array(CASING_CAP);
  private readonly cPos = new Float32Array(CASING_CAP * 3);
  private readonly cVel = new Float32Array(CASING_CAP * 3);
  private readonly cRot = new Float32Array(CASING_CAP * 3);
  private readonly cAng = new Float32Array(CASING_CAP * 3);
  private readonly cSniper = new Uint8Array(CASING_CAP);
  private cNext = 0;
  casingsSpawned = 0;
  steamPuffsEmitted = 0;

  // ---- 7B-7 rain micro-splashes (ground-probed respawns, shader-animated) ----
  readonly splashes: THREE.InstancedMesh;
  private readonly splashAttr: THREE.InstancedBufferAttribute;
  private readonly splashStart = new Float32Array(VFX7.SPLASHES);
  private readonly splashPeriod = new Float32Array(VFX7.SPLASHES);
  private readonly vfxTime = { value: 0 };
  private groundQuery: ((x: number, y: number, z: number) => number | null) | null = null;
  /** Splashes that found ground on their last respawn (verification). */
  splashLive = 0;

  // ---- 7B-7 plasma smoke trails (48-ribbon ring) ----
  readonly smoke: THREE.InstancedMesh;
  private readonly smA: THREE.InstancedBufferAttribute;
  private readonly smB: THREE.InstancedBufferAttribute;
  private readonly smC: THREE.InstancedBufferAttribute;
  private smNext = 0;
  private smStepCount = 0;
  private smStepAt = -1;
  /** Smoke trail of each round (−1 none). */
  private readonly pSmoke = new Int16Array(P_CAP).fill(-1);
  /** Trails spawned so far (verification). */
  smokeSpawned = 0;

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
  /** 5B-4 / 10A-3.3 cooling bullet impact scorch decals (48-slot ring buffer, +1 draw call). */
  readonly scorch: THREE.InstancedMesh;
  private readonly scorchAttr: THREE.InstancedBufferAttribute;
  private readonly scorchTime = { value: 0 };
  private scorchNext = 0;
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

  /** 11A-3: shared tumbling digital-dissolve debris pool (ONE InstancedMesh 'DestructDebris', cap 200, +1 draw call). */
  readonly debris: DestructDebris;
  /** 11A-2/11A-3: breakable doors/glass handler for swept rounds (null = plain world stop, never scorched). */
  private breakables: ProjectileBreakables | null = null;

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
      uIndoor: { value: Array.from({ length: 20 }, () => new THREE.Vector3()) },
      uIndoorN: { value: 0 },
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
        uniform vec3 uIndoor[20];
        uniform int uIndoorN;
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
          // 11A: no rain inside carved interiors (outside rain stays visible through the glass).
          for (int i = 0; i < 10; i++) {
            if (i >= uIndoorN) break;
            if (all(greaterThan(p, uIndoor[i * 2])) && all(lessThan(p, uIndoor[i * 2 + 1]))) {
              gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
              return;
            }
          }
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

    // 7B-7 rain micro-splashes: a crown billboard (aKind 0) + a flat ripple ring (aKind 1) per instance; each
    // lives 0.18 s from its start time (aSplash = start, size, seed, live). Positions respawn on the CPU on the
    // ground level found under a random point within 18 m (5–6 short probes per frame), the animation is GPU-only.
    {
      const crown = new THREE.PlaneGeometry(1, 1);
      const ring = new THREE.PlaneGeometry(1, 1);
      ring.rotateX(-Math.PI / 2);
      const kind = (g: THREE.BufferGeometry, k: number): THREE.BufferGeometry => {
        g.setAttribute('aKind', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count).fill(k), 1));
        return g;
      };
      const sg = mergeGeometries([kind(crown, 0), kind(ring, 1)]) as THREE.BufferGeometry;
      this.splashAttr = new THREE.InstancedBufferAttribute(new Float32Array(VFX7.SPLASHES * 4), 4);
      sg.setAttribute('aSplash', this.splashAttr);
      const smat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        uniforms: { uTime: this.vfxTime, uFogDensity: { value: RENDER.FOG_DENSITY } },
        vertexShader: /* glsl */ `
          attribute vec4 aSplash; attribute float aKind;
          uniform float uTime;
          varying vec2 vUv; varying float vT; varying float vKind; varying float vDist; varying float vSeed;
          void main() {
            float t = (uTime - aSplash.x) / ${VFX7.SPLASH_LIFE_S.toFixed(3)};
            vT = t; vKind = aKind; vUv = uv; vSeed = aSplash.z;
            vec3 c = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
            vDist = length(c - cameraPosition);
            if (t < 0.0 || t > 1.0 || aSplash.w < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
            float sz = aSplash.y;
            vec3 wp;
            if (aKind < 0.5) {
              vec3 toCam = cameraPosition - c;
              toCam.y = 0.0;
              toCam = normalize(toCam + vec3(1e-4, 0.0, 0.0));
              vec3 right = vec3(toCam.z, 0.0, -toCam.x);
              float h = sz * (0.05 + 0.12 * sin(t * 3.14159));
              float w = sz * (0.06 + 0.12 * t);
              wp = c + right * position.x * w * 2.0 + vec3(0.0, (position.y + 0.5) * h, 0.0);
            } else {
              float r = sz * (0.03 + 0.17 * t);
              wp = c + vec3(position.x * r * 2.0, 0.004, position.z * r * 2.0);
            }
            gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform float uFogDensity;
          varying vec2 vUv; varying float vT; varying float vKind; varying float vDist; varying float vSeed;
          void main() {
            float fade = (1.0 - vT) * exp(-uFogDensity * uFogDensity * vDist * vDist * 3.0) * smoothstep(0.6, 2.0, vDist);
            float a;
            if (vKind < 0.5) {
              // Crown: a fan of thin droplet jets.
              float jets = pow(abs(sin(vUv.x * 15.0 + vSeed * 40.0)), 8.0);
              a = jets * smoothstep(0.0, 0.25, vUv.y) * (1.0 - smoothstep(0.6, 1.0, vUv.y)) * (1.0 - abs(vUv.x - 0.5) * 2.0) * 0.55;
            } else {
              float r = length(vUv - 0.5) * 2.0;
              a = smoothstep(0.12, 0.0, abs(r - 0.78)) * 0.32;
            }
            gl_FragColor = vec4(vec3(0.62, 0.72, 0.86) * a * fade, 1.0);
          }
        `,
      });
      this.splashes = new THREE.InstancedMesh(sg, smat, VFX7.SPLASHES);
      this.splashes.name = 'RainSplashes';
      this.splashes.frustumCulled = false;
      this.splashes.renderOrder = 19;
      for (let i = 0; i < VFX7.SPLASHES; i++) this.splashStart[i] = -1;
      scene.add(this.splashes);
    }

    // 7B-7 plasma smoke trails: camera-facing ribbons revealed behind the round (age = t − s / speed), each
    // point thinning out over 0.38 s while it widens 0.04 → 0.14 m and wavers. aSmA = (start, spawn time),
    // aSmB = (dir, speed), aSmC = (length, seed, enemy 0|1, live).
    {
      const geo = new THREE.PlaneGeometry(1, 1, 1, 24);
      this.smA = new THREE.InstancedBufferAttribute(new Float32Array(VFX7.SMOKE_TRAILS * 4), 4);
      this.smB = new THREE.InstancedBufferAttribute(new Float32Array(VFX7.SMOKE_TRAILS * 4), 4);
      this.smC = new THREE.InstancedBufferAttribute(new Float32Array(VFX7.SMOKE_TRAILS * 4), 4);
      geo.setAttribute('aSmA', this.smA);
      geo.setAttribute('aSmB', this.smB);
      geo.setAttribute('aSmC', this.smC);
      const W = VFX7.SMOKE_WIDTH;
      const mat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        uniforms: { uTime: this.vfxTime, uFogDensity: { value: RENDER.FOG_DENSITY }, uTint: { value: new THREE.Color(COLORS.PLAYER_STRAND) } },
        vertexShader: /* glsl */ `
          attribute vec4 aSmA; attribute vec4 aSmB; attribute vec4 aSmC;
          uniform float uTime;
          varying vec2 vUv; varying float vAge; varying float vK; varying float vDist; varying float vEnemy;
          void main() {
            vUv = uv; vEnemy = aSmC.z;
            float s = (position.y + 0.5) * aSmC.x;
            float age = uTime - aSmA.w - s / max(aSmB.w, 1.0);
            float k = clamp(age / ${VFX7.SMOKE_LIFE_S.toFixed(3)}, 0.0, 1.0);
            vAge = age; vK = k;
            if (aSmC.w < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
            vec3 p = aSmA.xyz + aSmB.xyz * s;
            vec3 toCam = normalize(cameraPosition - p);
            vec3 side = normalize(cross(aSmB.xyz, toCam) + vec3(0.0, 1e-4, 0.0));
            float wob = (sin(s * 1.7 + aSmC.y * 40.0 + uTime * 3.1) + 0.6 * sin(s * 4.3 + uTime * 5.3)) * 0.06 * k;
            p += side * wob + vec3(0.0, 0.22 * k, 0.0);
            p += side * position.x * mix(${W[0].toFixed(3)}, ${W[1].toFixed(3)}, k);
            vDist = length(p - cameraPosition);
            gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform float uFogDensity; uniform vec3 uTint;
          varying vec2 vUv; varying float vAge; varying float vK; varying float vDist; varying float vEnemy;
          void main() {
            if (vAge < 0.0 || vAge > ${VFX7.SMOKE_LIFE_S.toFixed(3)}) discard;
            float across = 1.0 - abs(vUv.x - 0.5) * 2.0;
            float a = ${VFX7.SMOKE_ALPHA.toFixed(3)} * pow(1.0 - vK, 1.4) * pow(across, 1.5);
            // Close to the lens the ribbon would smear across the screen: fade it in from 1.2 m.
            a *= smoothstep(1.2, 4.0, vDist) * exp(-uFogDensity * uFogDensity * vDist * vDist * 2.0);
            vec3 tint = mix(uTint, vec3(1.0, 0.25, 0.32), vEnemy);
            gl_FragColor = vec4(mix(vec3(0.6, 0.66, 0.76), tint, 0.3 * (1.0 - vK)), a);
          }
        `,
      });
      this.smoke = new THREE.InstancedMesh(geo, mat, VFX7.SMOKE_TRAILS);
      this.smoke.name = 'SmokeTrails';
      this.smoke.frustumCulled = false;
      this.smoke.renderOrder = 21;
      scene.add(this.smoke);
    }

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

    // ---- 5B-4 / 10A-3.3 scorch decals: aScorch = (birth sim time, owner 0 player / 1 enemy, seed) ----
    const scGeo = new THREE.PlaneGeometry(1, 1);
    this.scorchAttr = new THREE.InstancedBufferAttribute(new Float32Array(SCORCH.POOL * 3).fill(-1e6), 3);
    scGeo.setAttribute('aScorch', this.scorchAttr);
    const scMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -8,
      uniforms: {
        uTime: this.scorchTime,
        uCool: { value: SCORCH.COOL_S },
        uEmissive: { value: SCORCH.EMISSIVE },
        uRim: { value: new THREE.Color(COLORS.PLAYER_STRAND) },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aScorch;
        varying vec2 vUv; varying vec3 vSc;
        void main() {
          vUv = uv;
          vSc = aScorch;
          gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform float uCool; uniform float uEmissive; uniform vec3 uRim;
        varying vec2 vUv; varying vec3 vSc;
        float h12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
        void main() {
          float elapsed = uTime - vSc.x;
          if (elapsed < 0.0) discard;
          // Cools smoothly over uCool (4.0 s) from hot orange-cyan (emissive 2.8) into a dark charred pockmark.
          float cool = clamp(elapsed / uCool, 0.0, 1.0);
          vec2 c = vUv - 0.5;
          float r = length(c) * 2.0;
          float ang = atan(c.y, c.x);
          float edge = 0.78 + 0.22 * h12(vec2(floor(ang * 5.0 + vSc.z * 40.0), vSc.z * 13.0));
          float mask = 1.0 - smoothstep(edge * 0.55, edge, r);
          if (mask < 0.01) discard;
          float core = exp(-r * r * 7.5);
          vec3 hotBase = vSc.y > 0.5 ? vec3(1.0, 0.32, 0.22) : mix(vec3(1.0, 0.62, 0.26), uRim, 0.36);
          vec3 hotGlow = hotBase * uEmissive * (0.42 + 0.58 * core);
          // Energy-cyan rim flash in the initial impact phase.
          hotGlow += uRim * smoothstep(0.32, 0.78, r) * mask * (1.0 - smoothstep(0.0, 0.28, cool)) * 1.45 * (1.0 - vSc.y);
          // Dark charred pockmark center + soot ring remaining after the 4.0 s cooling phase.
          vec3 charMark = vec3(0.025, 0.022, 0.020) * (0.35 + 0.65 * smoothstep(0.0, 0.65, r));
          float heatK = pow(1.0 - cool, 1.55);
          vec3 col = mix(charMark, hotGlow, heatK);
          float a = mask * mix(0.78, 0.96, heatK);
          gl_FragColor = vec4(col, a);
        }
      `,
    });
    this.scorch = new THREE.InstancedMesh(scGeo, scMat, SCORCH.POOL);
    this.scorch.name = 'BulletScorchDecals';
    this.scorch.frustumCulled = false;
    this.scorch.count = 0;
    this.scorch.renderOrder = 19;
    scene.add(this.scorch);

    // ---- 11A-3 shared DestructDebris pool (one tiny rising spark on every vanish) ----
    this.debris = new DestructDebris(scene, (x, y, z) => {
      _vanishPt.set(x, y, z);
      this.burst(_vanishPt, Y_UP, BURST.DEBRIS_VANISH);
    });
  }

  /** 11A-2/11A-3: routes swept-round hits on 'GLASS' / 'DOOR' colliders to the destructible manager (null clears). */
  /** 11A: interior AABBs (≤ 10) where rain streaks are dropped (call at every district build). */
  setIndoorVolumes(boxes: ReadonlyArray<{ readonly minX: number; readonly minY: number; readonly minZ: number; readonly maxX: number; readonly maxY: number; readonly maxZ: number }>): void {
    const u = this.rainUniforms;
    const n = Math.min(boxes.length, 10);
    for (let i = 0; i < n; i++) {
      const b = boxes[i];
      u.uIndoor.value[i * 2].set(b.minX - 0.3, b.minY - 0.3, b.minZ - 0.3);
      u.uIndoor.value[i * 2 + 1].set(b.maxX + 0.3, b.maxY + 0.3, b.maxZ + 0.3);
    }
    u.uIndoorN.value = n;
  }

  setBreakables(b: ProjectileBreakables | null): void {
    this.breakables = b;
  }

  /**
   * 11A-3: lets the shared DestructDebris material take the 12 dynamic city lights (call once, ideally before the
   * first render; a later call recompiles the debris material exactly once).
   */
  setCityLightInjector(inject: CityLightInjector | null): void {
    this.debris.setCityLightInjector(inject);
  }

  /**
   * 5B-4 / 10A-3.3: stamps a flush circular scorch decal on a world surface (`radius 0.08 m` Pistol / `0.15 m` Sniper,
   * `+0.015 m` normal offset): center glows hot orange-cyan (`emissive 2.8`) at impact and cools smoothly over `4.0 s`
   * into a dark charred pockmark.
   */
  addScorch(point: THREE.Vector3, normal: THREE.Vector3, enemy: boolean, sniper = false): void {
    const i = this.scorchNext;
    this.scorchNext = (i + 1) % SCORCH.POOL;
    _q.setFromUnitVectors(Z_AXIS, normal);
    _d.copy(normal).multiplyScalar(SCORCH.NORMAL_OFFSET_M).add(point);
    const spin = Math.random() * Math.PI * 2;
    const radius = sniper ? SCORCH.RADIUS_SNIPER_M : SCORCH.RADIUS_PISTOL_M;
    const diameter = radius * 2;
    _s.set(diameter, diameter, 1);
    _m4.compose(_d, _q.multiply(_qSpin.setFromAxisAngle(Z_AXIS, spin)), _s);
    this.scorch.setMatrixAt(i, _m4);
    this.scorchAttr.setXYZ(i, this.scorchTime.value, enemy ? 1 : 0, Math.random());
    this.scorch.instanceMatrix.needsUpdate = true;
    this.scorchAttr.needsUpdate = true;
    if (this.scorch.count < SCORCH.POOL) this.scorch.count = Math.max(this.scorch.count, i + 1);
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
    // 0 = stops at the first target, 1 = pierces bodies + shields, 2 = pierces bodies but stops at shields (8A-3).
    this.pPierce[i] = spec.pierce ? (spec.shieldStop ? 2 : 1) : 0;
    this.pSkipGroup[i] = -1;
    this.pSlowT[i] = 0;
    this.pSlowK[i] = 1;
    this.pGrazeMin[i] = Infinity;
    this.pGrazeDone[i] = spec.owner === 'PLAYER' ? 1 : 0;
    this.pSmoke[i] = spec.smoke ? this.spawnSmoke(muzzle ?? origin, dir, spec.speed, spec.range, spec.owner === 'ENEMY') : -1;
    return i;
  }

  /** 7B-7: opens a smoke trail behind a round (player rail rounds, enemy snipes). Returns the trail slot or −1. */
  private spawnSmoke(start: THREE.Vector3, dir: THREE.Vector3, speed: number, range: number, enemy: boolean): number {
    const now = this.vfxTime.value;
    if (now === this.smStepAt) {
      if (this.smStepCount >= VFX7.SMOKE_PER_SHOT) return -1;
      this.smStepCount++;
    } else {
      this.smStepAt = now;
      this.smStepCount = 1;
    }
    const k = this.smNext;
    this.smNext = (k + 1) % VFX7.SMOKE_TRAILS;
    // A trail being recycled must no longer be shortened by its old round.
    for (let j = 0; j < P_CAP; j++) if (this.pSmoke[j] === k) this.pSmoke[j] = -1;
    this.smA.setXYZW(k, start.x, start.y, start.z, now);
    this.smB.setXYZW(k, dir.x, dir.y, dir.z, speed);
    this.smC.setXYZW(k, range, this.rng(), enemy ? 1 : 0, 1);
    this.smA.needsUpdate = true;
    this.smB.needsUpdate = true;
    this.smC.needsUpdate = true;
    this.smokeSpawned++;
    return k;
  }

  /** 7B-7: the round stopped after `travelled` m — its smoke trail ends there. */
  private endSmoke(i: number): void {
    const k = this.pSmoke[i];
    if (k < 0) return;
    this.pSmoke[i] = -1;
    this.smC.setX(k, Math.max(0.5, this.pTravel[i]));
    this.smC.needsUpdate = true;
  }

  /** 7B-7: ground height query for the rain splashes (y of the first surface at or below (x, y, z)). */
  setGroundQuery(q: (x: number, y: number, z: number) => number | null): void {
    this.groundQuery = q;
  }

  /** 7B-7: respawns finished splashes on the ground level around the camera (≤ 18 m). */
  private updateSplashes(cameraPos: THREE.Vector3): void {
    const now = this.vfxTime.value;
    const R = VFX7.SPLASH_RADIUS_M;
    let changed = false;
    let live = 0;
    for (let i = 0; i < VFX7.SPLASHES; i++) {
      if (this.splashAttr.getW(i) > 0.5) live++;
      if (now < this.splashStart[i] + this.splashPeriod[i]) continue;
      const a = this.rng() * Math.PI * 2;
      const r = Math.sqrt(this.rng()) * R;
      const x = cameraPos.x + Math.cos(a) * r;
      const z = cameraPos.z + Math.sin(a) * r;
      const gy = this.groundQuery ? this.groundQuery(x, cameraPos.y + 0.5, z) : null;
      const ok = gy !== null && gy > cameraPos.y - 6;
      this.splashStart[i] = now + this.rng() * 0.2;
      this.splashPeriod[i] = VFX7.SPLASH_PERIOD[0] + this.rng() * (VFX7.SPLASH_PERIOD[1] - VFX7.SPLASH_PERIOD[0]);
      _m4.makeTranslation(x, (gy ?? 0) + 0.02, z);
      this.splashes.setMatrixAt(i, _m4);
      this.splashAttr.setXYZW(i, this.splashStart[i], 0.8 + this.rng() * 0.6, this.rng(), ok ? 1 : 0);
      changed = true;
    }
    this.splashLive = live;
    if (changed) {
      this.splashes.instanceMatrix.needsUpdate = true;
      this.splashAttr.needsUpdate = true;
    }
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
    const brk = this.breakables;
    outer: for (let i = 0; i < P_CAP; i++) {
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
      _pA.set(this.pPos[o], this.pPos[o + 1], this.pPos[o + 2]);
      _pD.set(this.pVel[o], this.pVel[o + 1], this.pVel[o + 2]);
      const speed = _pD.length();
      let step = speed * dt;
      const remaining = this.pRange[i] - this.pTravel[i];
      if (step > remaining) step = remaining;
      _pD.divideScalar(speed);
      const owner: ProjectileOwner = this.pOwner[i] === 0 ? 'PLAYER' : 'ENEMY';
      const targets = targetsFor(owner);
      // 11A-3: a round passing through glass re-sweeps the REMAINING distance of this step (≤ 4 times).
      for (let sweep = 0; ; sweep++) {
        _pB.copy(_pD).multiplyScalar(step).add(_pA);
        physics.segmentCast(_pA, _pB, _worldHit);
        let tHit = false;
        if (targets.length) {
          const pierce = this.pPierce[i] !== 0;
          physics.raycastTargets(_pA, _pD, _worldHit.hit ? _worldHit.distance : step, targets, _targetHit, pierce ? this.pSkipGroup[i] : -1, this.pPierce[i] === 1);
          tHit = _targetHit.hit;
        }
        // GRAZE: closest approach of this (sub-)step's path (up to a world hit) to the player's body axis.
        if (!tHit && graze && graze.active && !this.pGrazeDone[i]) {
          _segEnd.copy(_worldHit.hit ? _worldHit.point : _pB);
          this.trackGraze(i, _pA, _segEnd, _pD, graze, physics);
        }
        // 11B-1: destructible props on the path up to the first world / hitbox hit (light ones break and let it pass).
        if (brk && brk.raycastProp) {
          const lim = tHit ? _targetHit.distance : _worldHit.hit ? _worldHit.distance : step;
          const sniperP = this.pTag[i] === 1 || this.pDamage[i] >= 100;
          const ts = brk.raycastProp(_pA, _pD, lim, this.pDamage[i], sniperP, owner === 'PLAYER');
          _pD.set(this.pVel[o], this.pVel[o + 1], this.pVel[o + 2]).divideScalar(speed);
          if (ts >= 0 && ts <= lim) {
            // A heavy prop survived the hit: the round stops on it (spark, never a scorch decal on a breakable).
            const im = this.impact;
            im.owner = owner;
            im.tag = this.pTag[i];
            im.pierce = false;
            im.damage = this.pDamage[i];
            im.headMultiplier = this.pHead[i];
            im.shieldMultiplier = this.pShield[i];
            im.direction.copy(_pD);
            im.point.copy(_pA).addScaledVector(_pD, ts);
            im.normal.copy(_pD).negate();
            im.kind = 'PROP';
            im.target = null;
            im.region = 'BODY';
            im.travelled = this.pTravel[i] + ts;
            this.burst(im.point, im.normal, BURST.SPARK);
            this.pActive[i] = 0;
            this.pTravel[i] = im.travelled;
            this.endSmoke(i);
            onImpact(im);
            continue outer;
          }
        }
        const wk = _worldHit.hit && !tHit ? _worldHit.kind : null;
        const breakable = wk === 'GLASS' || wk === 'DOOR';
        if (breakable && brk && _worldHit.collider) {
          const sniper = this.pTag[i] === 1 || this.pDamage[i] >= 100;
          const pass = brk.onProjectileHit(_worldHit.collider, _worldHit.point, _pD, this.pDamage[i], sniper, owner);
          // Hooks may run arbitrary pool code: re-derive the flight direction from the stored velocity.
          _pD.set(this.pVel[o], this.pVel[o + 1], this.pVel[o + 2]).divideScalar(speed);
          if (pass && wk === 'GLASS' && sweep < MAX_GLASS_RESWEEPS) {
            const adv = Math.min(step, _worldHit.distance + GLASS_PASS_ADVANCE_M);
            _pA.addScaledVector(_pD, adv);
            this.pTravel[i] += adv;
            step -= adv;
            if (step <= 1e-4 || this.pTravel[i] >= this.pRange[i] - 1e-3) {
              this.pPos[o] = _pA.x;
              this.pPos[o + 1] = _pA.y;
              this.pPos[o + 2] = _pA.z;
              if (this.pTravel[i] >= this.pRange[i] - 1e-3) this.pActive[i] = 0;
              continue outer;
            }
            continue; // full damage preserved: sweep the rest of this step (hitboxes included)
          }
        }
        if (_worldHit.hit || tHit) {
          const im = this.impact;
          im.owner = owner;
          im.tag = this.pTag[i];
          im.pierce = tHit && (this.pPierce[i] === 1 || (this.pPierce[i] === 2 && !_targetHit.target?.shield));
          im.damage = this.pDamage[i];
          im.headMultiplier = this.pHead[i];
          im.shieldMultiplier = this.pShield[i];
          im.direction.copy(_pD);
          if (tHit) {
            im.point.copy(_targetHit.point);
            im.normal.copy(_pD).negate();
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
            // 11A: glass gets no spark; doors spark but are never scorched (no decal hanging in mid-air after a breach).
            if (im.kind !== 'GLASS') this.burst(im.point, im.normal, im.kind === 'WATER' ? BURST.WATER : BURST.SPARK);
            if (im.kind !== 'WATER' && im.kind !== 'BARRIER' && im.kind !== 'DOOR' && im.kind !== 'GLASS') {
              this.addScorch(im.point, im.normal, owner === 'ENEMY', im.tag === 1 || im.damage >= 100);
            }
          }
          if (im.pierce && _targetHit.target) {
            // Piercing round: keep flying from just past the hit, never re-hitting this body.
            this.pSkipGroup[i] = _targetHit.target.group ?? _targetHit.target.id;
            this.pPos[o] = _targetHit.point.x + _pD.x * 0.02;
            this.pPos[o + 1] = _targetHit.point.y + _pD.y * 0.02;
            this.pPos[o + 2] = _targetHit.point.z + _pD.z * 0.02;
            this.pTravel[i] += _targetHit.distance;
            onImpact(im);
            if (this.pTravel[i] >= this.pRange[i] - 1e-3) this.pActive[i] = 0;
            continue outer;
          }
          this.pActive[i] = 0;
          this.pTravel[i] = im.travelled;
          this.endSmoke(i);
          onImpact(im);
          continue outer;
        }
        this.pPos[o] = _pB.x;
        this.pPos[o + 1] = _pB.y;
        this.pPos[o + 2] = _pB.z;
        this.pTravel[i] += step;
        if (this.pTravel[i] >= this.pRange[i] - 1e-3) this.pActive[i] = 0;
        continue outer;
      }
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
    this.tracers.visible = n > 0;
    this.tracers.instanceMatrix.needsUpdate = true;
    if (this.tracers.instanceColor) this.tracers.instanceColor.needsUpdate = true;
  }

  // =============================================================================================
  // Particles
  // =============================================================================================
  /** Emits a burst around `normal` (unit) at `point`. */
  burst(point: THREE.Vector3, normal: THREE.Vector3, b: ParticleBurst, colorOverride = -1): void {
    // 10A-1: auto-skip non-essential minor sparks/splashes beyond 52 m from the camera.
    if (b.minor && this.hasCamPos) {
      const cam = this.rainUniforms.uCamPos.value;
      const dx = point.x - cam.x;
      const dy = point.y - cam.y;
      const dz = point.z - cam.z;
      if (dx * dx + dy * dy + dz * dz > MINOR_SKIP_DIST_SQ) return;
    }
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

  /**
   * 10A-3.2: emits subtle rising translucent heat-vent vapor puffs from the K-90 Sniper barrel vents while
   * cooling after a shot (pooled into `sparks`, zero allocations).
   */
  emitBarrelSteam(point: THREE.Vector3): void {
    this.steamPuffsEmitted++;
    this.burst(point, Y_UP, BURST.BARREL_STEAM);
  }

  /**
   * 10A-3.2: ejects a visible spinning glowing spent brass/rail cartridge from `eject` on Pistol shots and
   * Sniper breech-open reload beats (pooled 16-slot ring buffer rendered in `sparks`, zero allocations).
   */
  spawnCasing(origin: THREE.Vector3, rightDir: THREE.Vector3, upDir: THREE.Vector3, sniper = false): number {
    const i = this.cNext;
    this.cNext = (i + 1) % CASING_CAP;
    const o = i * 3;
    this.cPos[o] = origin.x;
    this.cPos[o + 1] = origin.y;
    this.cPos[o + 2] = origin.z;
    const vr = (1.6 + this.rng() * 0.75) * (sniper ? 1.15 : 1.0);
    const vu = (1.15 + this.rng() * 0.55) * (sniper ? 1.1 : 1.0);
    this.cVel[o] = rightDir.x * vr + upDir.x * vu + (this.rng() - 0.5) * 0.35;
    this.cVel[o + 1] = rightDir.y * vr + upDir.y * vu;
    this.cVel[o + 2] = rightDir.z * vr + upDir.z * vu + (this.rng() - 0.5) * 0.35;
    this.cRot[o] = this.rng() * Math.PI * 2;
    this.cRot[o + 1] = this.rng() * Math.PI * 2;
    this.cRot[o + 2] = this.rng() * Math.PI * 2;
    this.cAng[o] = (14 + this.rng() * 12) * (this.rng() < 0.5 ? -1 : 1);
    this.cAng[o + 1] = (10 + this.rng() * 10) * (this.rng() < 0.5 ? -1 : 1);
    this.cAng[o + 2] = (12 + this.rng() * 10) * (this.rng() < 0.5 ? -1 : 1);
    const life = sniper ? 1.05 : 0.85;
    this.cLife[i] = life;
    this.cMax[i] = life;
    this.cSniper[i] = sniper ? 1 : 0;
    this.casingsSpawned++;
    return i;
  }

  /** Number of currently active 3D ejected casings in flight. */
  get activeCasings(): number {
    let n = 0;
    for (let i = 0; i < CASING_CAP; i++) if (this.cLife[i] > 0) n++;
    return n;
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
    // 10A-3.2: integrate & render 3D tumbling ejected brass/rail casings into free slots of `sparks`.
    for (let i = 0; i < CASING_CAP && n < S_CAP; i++) {
      if (this.cLife[i] <= 0) continue;
      this.cLife[i] -= simDt;
      if (this.cLife[i] <= 0) continue;
      const o = i * 3;
      this.cVel[o + 1] -= 13.5 * simDt;
      this.cPos[o] += this.cVel[o] * simDt;
      this.cPos[o + 1] += this.cVel[o + 1] * simDt;
      this.cPos[o + 2] += this.cVel[o + 2] * simDt;
      this.cRot[o] += this.cAng[o] * simDt;
      this.cRot[o + 1] += this.cAng[o + 1] * simDt;
      this.cRot[o + 2] += this.cAng[o + 2] * simDt;
      const t = this.cLife[i] / Math.max(this.cMax[i], 1e-4);
      const sn = this.cSniper[i] === 1;
      _cEuler.set(this.cRot[o], this.cRot[o + 1], this.cRot[o + 2]);
      _q.setFromEuler(_cEuler);
      _s.set(sn ? 0.014 : 0.011, sn ? 0.014 : 0.011, sn ? 0.064 : 0.036);
      _a.set(this.cPos[o], this.cPos[o + 1], this.cPos[o + 2]);
      _m4.compose(_a, _q, _s);
      this.sparks.setMatrixAt(n, _m4);
      const glow = 0.35 + 0.65 * t;
      // Warm glowing brass with a hot cyan-white rail-charge tint on Sniper casings.
      _c.setRGB((sn ? 1.85 : 2.15) * glow, (sn ? 1.82 : 1.55) * glow, (sn ? 2.15 : 0.72) * glow);
      this.sparks.setColorAt(n, _c);
      n++;
    }
    this.sparks.count = n;
    this.sparks.visible = n > 0;
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
    const u = this.rainUniforms;
    u.uCamPos.value.copy(cameraPos);
    this.hasCamPos = true;
    this.vfxTime.value += simDt;
    if (simDt > 0) this.updateSplashes(cameraPos);
    this.syncTracers(realDt);
    this.scorchTime.value += simDt;
    this.debris.update(simDt, cameraPos);
    this.updateParticles(simDt);
    this.updateRings(simDt);
    this.syncLines(realTime, viewportH);
    this.rainTime += simDt;
    // Keep float precision in the shader: rebase the rain clock once per hour (one imperceptible reshuffle).
    if (this.rainTime > 3600) this.rainTime -= 3600;
    u.uRainTime.value = this.rainTime;
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

// =================================================================================================
// 11A-3 / 11B-2 shared DestructDebris pool
// =================================================================================================
/** 11B-2 DestructDebris non-glass surface classes (spawn `surface`): material-matched roughness / metalness. */
export const DEBRIS_SURFACE = { DEFAULT: 0, MATTE: 1, PLASTIC: 2, METAL: 3 } as const;

/** 11A-3 / 11B-2 DestructDebris tuning (cap 200, simDt physics, scanline dissolve). */
export const DEBRIS = {
  CAP: 200,
  GRAVITY: -22,
  RESTITUTION: 0.35,
  /** Horizontal velocity kept on each floor bounce. */
  FRICTION: 0.62,
  SLEEP_SPEED: 0.15,
  TUMBLE_MIN: 6,
  TUMBLE_MAX: 16,
  /** Solid tumbling time before the dissolve (random in [MIN, MAX] unless spawn() passes `life`). */
  LIFE_MIN: 1.4,
  LIFE_MAX: 2.2,
  DISSOLVE_S: 0.55,
  /** Chunks beyond this camera distance freeze their physics (timers still run, so they still vanish). */
  SKIP_DIST_M: RENDER.MINOR_PARTICLE_SKIP_DIST_M,
} as const;

/**
 * 11A-3 signature digital scanline dissolve, shared by DestructDebris and InteractiveDoors so both disintegrate
 * identically. `strandDissolve(worldPos, d)` with d = (progress 0..1, isGlass 0|1, seed, glowBoost) discards the
 * dissolved world-grid cells (7 cm cells mixed with 2.8 cm scanline rows) and returns the HDR edge emission
 * (cyan for glass, amber otherwise; 0.12-wide edge band, HDR 2.2). Requires derivatives-free GLSL ES 3.0 only.
 */
export const GLSL_DIGITAL_DISSOLVE = /* glsl */ `
  float strandDisHash(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.x + p.y) * p.z);
  }
  vec3 strandDissolve(vec3 wp, vec4 d) {
    if (d.x <= 0.0) return vec3(0.0);
    float n = strandDisHash(floor(wp * 14.0) + d.z * 131.0);
    float row = fract(floor(wp.y * 36.0) * 0.6180339 + d.z * 7.31);
    float k = 0.6 * n + 0.4 * row;
    float t = d.x * 1.12;
    if (k < t - 0.12) discard;
    float e = clamp((t - k) / 0.12, 0.0, 1.0);
    vec3 col = d.y > 0.5 ? vec3(0.25, 0.95, 1.0) : vec3(1.0, 0.58, 0.16);
    float scan = step(0.5, fract(wp.y * 36.0)) * 0.08 * d.x;
    return col * (2.2 * e * e + scan) * (1.0 + d.w);
  }
`;

/**
 * Sculpted angular bevelled shard (exactly 20 triangles): an irregular pentagonal band (y ±0.25) capped by two
 * off-centre shallow pyramids (apex y ±0.5), flat-shaded, all normals outward, bounds within [-0.5, 0.5]³.
 * Local Y is the THIN axis (flat plates scale Y smallest).
 */
export function buildDebrisShardGeometry(): THREE.BufferGeometry {
  const ring: Array<[number, number]> = [];
  const radii = [0.5, 0.41, 0.49, 0.37, 0.46];
  const jitter = [0.0, 0.21, -0.14, 0.18, -0.09];
  for (let k = 0; k < 5; k++) {
    const a = ((k + jitter[k]) / 5) * Math.PI * 2;
    ring.push([Math.cos(a) * radii[k], Math.sin(a) * radii[k]]);
  }
  const top: [number, number, number] = [0.06, 0.5, -0.04];
  const bot: [number, number, number] = [-0.05, -0.5, 0.05];
  const pos: number[] = [];
  const tri = (a: readonly number[], b: readonly number[], c: readonly number[]): void => {
    // Outward winding: the shard is convex and star-shaped around the origin.
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const cx = a[0] + b[0] + c[0], cy = a[1] + b[1] + c[1], cz = a[2] + b[2] + c[2];
    if (nx * cx + ny * cy + nz * cz >= 0) pos.push(...a, ...b, ...c);
    else pos.push(...a, ...c, ...b);
  };
  for (let k = 0; k < 5; k++) {
    const p = ring[k];
    const q = ring[(k + 1) % 5];
    const ut = [p[0], 0.25, p[1]], vt = [q[0], 0.25, q[1]];
    const ub = [p[0], -0.25, p[1]], vb = [q[0], -0.25, q[1]];
    tri(top, ut, vt);
    tri(bot, ub, vb);
    tri(ub, vb, vt);
    tri(ub, vt, ut);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

const _dbP = new THREE.Vector3();
const _dbS = new THREE.Vector3();
const _dbAxis = new THREE.Vector3();
const _dbQ = new THREE.Quaternion();
const _dbQd = new THREE.Quaternion();
const _dbQt = new THREE.Quaternion();
const _dbQx = new THREE.Quaternion();
const _dbM = new THREE.Matrix4();
const _dbC = new THREE.Color();
const _dbX = new THREE.Vector3(1, 0, 0);
const _dbY = new THREE.Vector3(0, 1, 0);
let _dbSeed = 0x2f6b1d;
/** Tiny deterministic LCG (zero allocation). */
function dbRand(): number {
  _dbSeed = (Math.imul(_dbSeed, 1664525) + 1013904223) >>> 0;
  return _dbSeed / 4294967296;
}

/**
 * 11A-3 / 11B-2 shared debris pool: ONE persistent InstancedMesh 'DestructDebris' (cap 200, +1 draw call while any
 * chunk lives), pre-allocated SoA ring buffer, simDt physics (Bullet-Time compatible), solid tumbling for 1.4–2.2 s
 * then a 0.55 s digital scanline dissolve. Zero per-frame allocations. Driven by `EffectsPool.update()`.
 */
export class DestructDebris {
  readonly mesh: THREE.InstancedMesh;
  /** Chunks spawned so far (verification). */
  spawned = 0;
  /** Chunks that completed their dissolve (verification). */
  vanished = 0;
  private readonly disAttr: THREE.InstancedBufferAttribute;
  private readonly mat: THREE.MeshStandardMaterial;
  private inject: CityLightInjector | null = null;
  private readonly onVanish: ((x: number, y: number, z: number, glass: boolean) => void) | null;
  private readonly live = new Uint8Array(DEBRIS.CAP);
  private readonly pos = new Float32Array(DEBRIS.CAP * 3);
  private readonly vel = new Float32Array(DEBRIS.CAP * 3);
  /** Orientation quaternion (x, y, z, w). */
  private readonly rot = new Float32Array(DEBRIS.CAP * 4);
  /** World angular velocity (rad/s). */
  private readonly ang = new Float32Array(DEBRIS.CAP * 3);
  private readonly scl = new Float32Array(DEBRIS.CAP * 3);
  private readonly col = new Float32Array(DEBRIS.CAP * 3);
  private readonly glass = new Uint8Array(DEBRIS.CAP);
  /** 11B-2 DEBRIS_SURFACE class of non-glass chunks. */
  private readonly surf = new Uint8Array(DEBRIS.CAP);
  private readonly floorY = new Float32Array(DEBRIS.CAP);
  private readonly solid = new Float32Array(DEBRIS.CAP);
  private readonly age = new Float32Array(DEBRIS.CAP);
  private readonly seed = new Float32Array(DEBRIS.CAP);
  private readonly glow = new Float32Array(DEBRIS.CAP);
  private readonly sleep = new Uint8Array(DEBRIS.CAP);
  private next = 0;
  private liveN = 0;

  constructor(scene: THREE.Scene, onVanish: ((x: number, y: number, z: number, glass: boolean) => void) | null = null) {
    this.onVanish = onVanish;
    const geo = buildDebrisShardGeometry();
    this.disAttr = new THREE.InstancedBufferAttribute(new Float32Array(DEBRIS.CAP * 4), 4);
    this.disAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aDissolve', this.disAttr);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.58, metalness: 0.45 });
    mat.onBeforeCompile = (shader) => {
      if (this.inject) this.inject(shader);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 aDissolve;\nvarying vec4 vDDis;\nvarying vec3 vDDWorld;')
        .replace(
          '#include <worldpos_vertex>',
          '#include <worldpos_vertex>\nvDDis = aDissolve;\nvDDWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying vec4 vDDis;\nvarying vec3 vDDWorld;\n${GLSL_DIGITAL_DISSOLVE}`)
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          vec3 ddEdge = strandDissolve(vDDWorld, vDDis);
          bool ddGlass = vDDis.y > 0.5;
          float ddSurf = floor(-vDDis.y + 0.5);
          if (ddGlass) diffuseColor.rgb = diffuseColor.rgb * 0.6 + 0.04;`,
        )
        // 11B-2 material-matched surfaces: 0 default steel-ish · 1 matte (cardboard / wood / terracotta / leaves) ·
        // 2 plastic · 3 bare metal.
        .replace(
          '#include <roughnessmap_fragment>',
          '#include <roughnessmap_fragment>\nroughnessFactor = ddGlass ? 0.06 : ddSurf > 2.5 ? 0.38 : ddSurf > 1.5 ? 0.46 : ddSurf > 0.5 ? 0.88 : 0.58;',
        )
        .replace(
          '#include <metalnessmap_fragment>',
          '#include <metalnessmap_fragment>\nmetalnessFactor = ddGlass ? 0.85 : ddSurf > 2.5 ? 0.82 : ddSurf > 0.5 ? 0.0 : 0.45;',
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
          totalEmissiveRadiance = ddEdge;
          if (ddGlass) {
            float ddF = pow(1.0 - clamp(abs(dot(normal, normalize(vViewPosition))), 0.0, 1.0), 3.0);
            totalEmissiveRadiance += vec3(0.55, 0.85, 1.0) * (0.05 + 0.7 * ddF);
          }`,
        );
    };
    mat.customProgramCacheKey = () => (this.inject ? 'strand-debris-v2-lit' : 'strand-debris-v2');
    this.mat = mat;
    this.mesh = new THREE.InstancedMesh(geo, mat, DEBRIS.CAP);
    this.mesh.name = 'DestructDebris';
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, _dbC.setRGB(1, 1, 1));
    if (this.mesh.instanceColor) this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.mesh);
  }

  /** Live chunk count. */
  get count(): number {
    return this.liveN;
  }

  /** Adds the 12 dynamic city lights to the debris material (recompiles it once). */
  setCityLightInjector(inject: CityLightInjector | null): void {
    if (this.inject === inject) return;
    this.inject = inject;
    this.mat.needsUpdate = true;
  }

  /** Clears every chunk (sector change / retry). */
  clear(): void {
    this.live.fill(0);
    this.liveN = 0;
    this.next = 0;
    this.mesh.count = 0;
    this.mesh.visible = false;
  }

  /**
   * Spawns one chunk (zero allocation). Position / velocity in world metres; (sx, sy, sz) = chunk size in metres
   * (the smallest component becomes the thin local Y axis); `color` sRGB hex; `floorY` = bounce plane; `life` =
   * solid time before the dissolve (< 0 → random 1.4–2.2 s); `glowBoost` scales the dissolve edge emission;
   * `surface` (11B-2, non-glass only) = DEBRIS_SURFACE class (material-matched roughness / metalness).
   * Recycles the oldest slot when all 200 are alive. Returns the slot.
   */
  spawn(px: number, py: number, pz: number, vx: number, vy: number, vz: number, sx: number, sy: number, sz: number, color: number, isGlass: boolean, floorY: number, life = -1, glowBoost = 0, surface = 0): number {
    let i = this.next;
    for (let k = 0; k < DEBRIS.CAP; k++) {
      const j = (this.next + k) % DEBRIS.CAP;
      if (!this.live[j]) {
        i = j;
        break;
      }
    }
    this.next = (i + 1) % DEBRIS.CAP;
    if (!this.live[i]) this.liveN++;
    this.live[i] = 1;
    // Thin axis → local Y (the settle pose lays the chunk flat on it).
    if (sx < sy && sx <= sz) {
      const t = sx;
      sx = sy;
      sy = t;
    } else if (sz < sy && sz < sx) {
      const t = sz;
      sz = sy;
      sy = t;
    }
    const o = i * 3;
    this.pos[o] = px;
    this.pos[o + 1] = Math.max(py, floorY + sy * 0.5);
    this.pos[o + 2] = pz;
    this.vel[o] = vx;
    this.vel[o + 1] = vy;
    this.vel[o + 2] = vz;
    this.scl[o] = Math.max(sx, 1e-3);
    this.scl[o + 1] = Math.max(sy, 1e-3);
    this.scl[o + 2] = Math.max(sz, 1e-3);
    _dbC.setHex(color);
    this.col[o] = _dbC.r;
    this.col[o + 1] = _dbC.g;
    this.col[o + 2] = _dbC.b;
    _dbAxis.set(dbRand() * 2 - 1, dbRand() * 2 - 1, dbRand() * 2 - 1);
    if (_dbAxis.lengthSq() < 1e-4) _dbAxis.set(0.3, 1, 0.2);
    _dbAxis.normalize();
    _dbQ.setFromAxisAngle(_dbAxis, dbRand() * Math.PI * 2);
    const r = i * 4;
    this.rot[r] = _dbQ.x;
    this.rot[r + 1] = _dbQ.y;
    this.rot[r + 2] = _dbQ.z;
    this.rot[r + 3] = _dbQ.w;
    _dbAxis.set(dbRand() * 2 - 1, dbRand() * 2 - 1, dbRand() * 2 - 1);
    if (_dbAxis.lengthSq() < 1e-4) _dbAxis.set(1, 0.2, 0.4);
    _dbAxis.normalize().multiplyScalar(DEBRIS.TUMBLE_MIN + dbRand() * (DEBRIS.TUMBLE_MAX - DEBRIS.TUMBLE_MIN));
    this.ang[o] = _dbAxis.x;
    this.ang[o + 1] = _dbAxis.y;
    this.ang[o + 2] = _dbAxis.z;
    this.glass[i] = isGlass ? 1 : 0;
    this.surf[i] = isGlass ? 0 : surface;
    this.floorY[i] = floorY;
    this.solid[i] = life >= 0 ? life : DEBRIS.LIFE_MIN + dbRand() * (DEBRIS.LIFE_MAX - DEBRIS.LIFE_MIN);
    this.age[i] = 0;
    this.seed[i] = dbRand();
    this.glow[i] = glowBoost;
    this.sleep[i] = 0;
    this.spawned++;
    return i;
  }

  /** Vector convenience wrapper of {@link spawn} (zero allocation). */
  spawnV(pos: THREE.Vector3, vel: THREE.Vector3, scale: THREE.Vector3, color: number, isGlass: boolean, floorY: number, life = -1, glowBoost = 0, surface = 0): number {
    return this.spawn(pos.x, pos.y, pos.z, vel.x, vel.y, vel.z, scale.x, scale.y, scale.z, color, isGlass, floorY, life, glowBoost, surface);
  }

  /** Simulates (simDt) and uploads every live chunk. Called by EffectsPool.update(). */
  update(simDt: number, camPos: THREE.Vector3): void {
    if (this.liveN === 0) {
      if (this.mesh.count !== 0) {
        this.mesh.count = 0;
        this.mesh.visible = false;
      }
      return;
    }
    const skip2 = DEBRIS.SKIP_DIST_M * DEBRIS.SKIP_DIST_M;
    const settleK = 1 - Math.exp(-14 * simDt);
    let n = 0;
    for (let i = 0; i < DEBRIS.CAP; i++) {
      if (!this.live[i]) continue;
      const o = i * 3;
      const r = i * 4;
      this.age[i] += simDt;
      const prog = (this.age[i] - this.solid[i]) / DEBRIS.DISSOLVE_S;
      if (prog >= 1) {
        this.live[i] = 0;
        this.liveN--;
        this.vanished++;
        if (this.onVanish) this.onVanish(this.pos[o], this.pos[o + 1], this.pos[o + 2], this.glass[i] === 1);
        continue;
      }
      _dbQ.set(this.rot[r], this.rot[r + 1], this.rot[r + 2], this.rot[r + 3]);
      const dx = this.pos[o] - camPos.x;
      const dy = this.pos[o + 1] - camPos.y;
      const dz = this.pos[o + 2] - camPos.z;
      if (simDt > 0 && !this.sleep[i] && dx * dx + dy * dy + dz * dz <= skip2) {
        this.vel[o + 1] += DEBRIS.GRAVITY * simDt;
        this.pos[o] += this.vel[o] * simDt;
        this.pos[o + 1] += this.vel[o + 1] * simDt;
        this.pos[o + 2] += this.vel[o + 2] * simDt;
        const ax = this.ang[o], ay = this.ang[o + 1], az = this.ang[o + 2];
        const w = Math.sqrt(ax * ax + ay * ay + az * az);
        if (w > 1e-5) {
          _dbAxis.set(ax / w, ay / w, az / w);
          _dbQd.setFromAxisAngle(_dbAxis, w * simDt);
          _dbQ.premultiply(_dbQd).normalize();
        }
        // Lowest point of the rotated chunk (row 1 of the rotation matrix · half extents).
        const qx = _dbQ.x, qy = _dbQ.y, qz = _dbQ.z, qw = _dbQ.w;
        const r10 = 2 * (qx * qy + qw * qz);
        const r11 = 1 - 2 * (qx * qx + qz * qz);
        const r12 = 2 * (qy * qz - qw * qx);
        const low = 0.5 * (Math.abs(r10) * this.scl[o] + Math.abs(r11) * this.scl[o + 1] + Math.abs(r12) * this.scl[o + 2]);
        const fy = this.floorY[i];
        let grounded = false;
        if (this.pos[o + 1] - low <= fy) {
          this.pos[o + 1] = fy + low;
          grounded = true;
          if (this.vel[o + 1] < -0.8) {
            // Real impact: bounce (restitution 0.35) and lose horizontal speed (friction 0.62).
            this.vel[o + 1] = -this.vel[o + 1] * DEBRIS.RESTITUTION;
            if (this.vel[o + 1] < 0.6) this.vel[o + 1] = 0;
            // Glass shards bite on impact (no skating off a narrow deck / ledge past their probed floor).
            const fr = this.glass[i] ? 0 : DEBRIS.FRICTION;
            this.vel[o] *= fr;
            this.vel[o + 2] *= fr;
            this.ang[o] *= 0.55;
            this.ang[o + 1] *= 0.55;
            this.ang[o + 2] *= 0.55;
          } else if (this.vel[o + 1] < 0) this.vel[o + 1] = 0; // resting contact
        }
        if (grounded) {
          // Rolling friction while in contact + settle flat on the thin local Y axis (yaw preserved).
          const fk = Math.exp(-5 * simDt);
          this.vel[o] *= fk;
          this.vel[o + 2] *= fk;
          const sp = Math.sqrt(this.vel[o] * this.vel[o] + this.vel[o + 1] * this.vel[o + 1] + this.vel[o + 2] * this.vel[o + 2]);
          if (sp < 1.5) {
            const r00 = 1 - 2 * (qy * qy + qz * qz);
            const r20 = 2 * (qx * qz - qw * qy);
            _dbQt.setFromAxisAngle(_dbY, Math.atan2(-r20, r00));
            if (r11 < 0) _dbQt.multiply(_dbQx.setFromAxisAngle(_dbX, Math.PI));
            _dbQ.slerp(_dbQt, settleK);
            const ak = Math.exp(-8 * simDt);
            this.ang[o] *= ak;
            this.ang[o + 1] *= ak;
            this.ang[o + 2] *= ak;
            if (sp < DEBRIS.SLEEP_SPEED && Math.abs(r11) > 0.995) {
              // Asleep: lie exactly flat on the floor (|min.y − floorY| = 0).
              this.sleep[i] = 1;
              _dbQ.copy(_dbQt);
              this.vel[o] = this.vel[o + 1] = this.vel[o + 2] = 0;
              this.ang[o] = this.ang[o + 1] = this.ang[o + 2] = 0;
              this.pos[o + 1] = fy + this.scl[o + 1] * 0.5;
            }
          }
        }
        this.rot[r] = _dbQ.x;
        this.rot[r + 1] = _dbQ.y;
        this.rot[r + 2] = _dbQ.z;
        this.rot[r + 3] = _dbQ.w;
      } else if (simDt > 0 && !this.sleep[i]) {
        // 11B audit fix: beyond the 52 m physics skip a chunk never hangs in mid-air (a scoped 60 m+ shot): it jumps
        // straight to its ballistic landing spot (the probed floor its launch velocity was fitted to) and lies flat.
        const vy = this.vel[o + 1];
        const fy = this.floorY[i];
        const h = Math.max(0, this.pos[o + 1] - this.scl[o + 1] * 0.5 - fy);
        const tl = (vy + Math.sqrt(vy * vy - 2 * DEBRIS.GRAVITY * h)) / -DEBRIS.GRAVITY;
        this.pos[o] += this.vel[o] * tl;
        this.pos[o + 2] += this.vel[o + 2] * tl;
        this.pos[o + 1] = fy + this.scl[o + 1] * 0.5;
        _dbQ.setFromAxisAngle(_dbY, this.seed[i] * Math.PI * 2);
        this.vel[o] = this.vel[o + 1] = this.vel[o + 2] = 0;
        this.ang[o] = this.ang[o + 1] = this.ang[o + 2] = 0;
        this.sleep[i] = 1;
        this.rot[r] = _dbQ.x;
        this.rot[r + 1] = _dbQ.y;
        this.rot[r + 2] = _dbQ.z;
        this.rot[r + 3] = _dbQ.w;
      }
      _dbP.set(this.pos[o], this.pos[o + 1], this.pos[o + 2]);
      _dbS.set(this.scl[o], this.scl[o + 1], this.scl[o + 2]);
      _dbM.compose(_dbP, _dbQ, _dbS);
      this.mesh.setMatrixAt(n, _dbM);
      _dbC.setRGB(this.col[o], this.col[o + 1], this.col[o + 2]);
      this.mesh.setColorAt(n, _dbC);
      // aDissolve.y: 1 = glass (cyan edge); 0 / -1 / -2 / -3 = DEBRIS_SURFACE class of a non-glass chunk (amber edge).
      this.disAttr.setXYZW(n, prog > 0 ? prog : 0, this.glass[i] ? 1 : -this.surf[i], this.seed[i], this.glow[i]);
      n++;
    }
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    if (n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
      this.disAttr.needsUpdate = true;
    }
  }
}
