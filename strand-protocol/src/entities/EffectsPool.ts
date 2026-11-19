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
 */
import * as THREE from 'three';
import { COLORS, LIMITS, RENDER, createRng } from '../config/constants';
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
}

export interface ProjectileImpact {
  owner: ProjectileOwner;
  tag: number;
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

export const BURST = {
  SPARK: { count: 10, color: 0xffc27a, intensity: 2.4, speed: 9, spread: 0.85, life: 0.35, gravity: -14, size: 0.035 },
  WATER: { count: 14, color: 0x9fdcff, intensity: 1.1, speed: 5.5, spread: 0.45, life: 0.6, gravity: -11, size: 0.05 },
  LAND_SPLASH: { count: 26, color: 0xb6e6ff, intensity: 1.0, speed: 6.5, spread: 0.7, life: 0.7, gravity: -12, size: 0.06 },
  MUZZLE: { count: 6, color: 0x7ffcff, intensity: 2.8, speed: 7, spread: 0.35, life: 0.12, gravity: 0, size: 0.03 },
  HOOK: { count: 12, color: 0xffd26a, intensity: 2.6, speed: 7, spread: 0.9, life: 0.3, gravity: -10, size: 0.04 },
} as const satisfies Record<string, ParticleBurst>;

const P_CAP = LIMITS.PROJECTILES;
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
  private pNext = 0;
  private readonly impact: ProjectileImpact = {
    owner: 'PLAYER',
    tag: 0,
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
  ): void {
    for (let i = 0; i < P_CAP; i++) {
      if (!this.pActive[i]) continue;
      const o = i * 3;
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
        physics.raycastTargets(_a, _d, _worldHit.hit ? _worldHit.distance : step, targets, _targetHit);
        tHit = _targetHit.hit;
      }
      if (_worldHit.hit || tHit) {
        const im = this.impact;
        im.owner = owner;
        im.tag = this.pTag[i];
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
  burst(point: THREE.Vector3, normal: THREE.Vector3, b: ParticleBurst): void {
    _c.setHex(b.color);
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
  update(simDt: number, realDt: number, cameraPos: THREE.Vector3, cameraVel: THREE.Vector3): void {
    this.syncTracers(realDt);
    this.updateParticles(simDt);
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
