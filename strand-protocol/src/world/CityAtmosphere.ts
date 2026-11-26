/**
 * STRAND // PROTOCOL — Phase 10D living-city atmosphere (2 persistent draw calls):
 *
 *   ElevatedTraffic (10D-1, cap 36, +1 call)   rivers of wedge coupes on the expressways' outer lanes with
 *                                              integrated opaque crimson light ribbons; simTime driven (Bullet
 *                                              Time slows traffic), strictly non-lethal inward bump.
 *   AnimatedEnvKit  (10D-2, cap 220, +1 call)  GPU-animated micro-environment: spinning exhaust fans (v0),
 *                                              wind-swaying noren curtains (v1), counter-rotating rooftop
 *                                              wireframe holograms (v2) — 100 % uTime, nothing runs per frame.
 *
 * Geometry builders are pure exported factories (`buildTrafficCarGeometry`, `buildAnimatedEnvKit`) so Phase 13
 * can swap in imported `.glb` BufferGeometry without touching lane routing or placement.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { LEVEL } from '../config/constants';
import { box, cyl, loftSymHull, rod } from './CityVehicles';

type Axis = 'x' | 'z';
/** `(shader, apply?) => CityBuilder.injectCityLights(shader, apply)` — the shared city-light reflection hook. */
export type CityLightInjector = (shader: THREE.WebGLProgramParametersWithUniforms, apply?: string) => void;

// =============================================================================================
// 10D-1 Elevated traffic
// =============================================================================================
export const TRAFFIC_CAP = 36;
/** Phase 13 swap contract: traffic coupe envelope (forward +Z, grounded y = 0) and ribbon tip. */
export const TRAFFIC_BOUNDS = { w: 1.92, h: 1.18, l: 4.5, ribbonEndZ: -5.2 } as const;
export const TRAFFIC_TRI_BUDGET = 240;
const DECK = LEVEL.HIGHWAY_DECK_Y;
const VIS = LEVEL.VISUAL_EXTENT_M;
const SPAN = 2 * VIS;
/** Outer-lane lateral offset from the highway centreline (clears the ±0.25 m median and the 6.6 m guard face). */
export const TRAFFIC_LANE_OFFSET_M = 4.9;
/** Sector 3 grade crossing: equal speed + exact divisor count ⇒ no wrap seam, S / 2 phase at every crossing. */
export const CROSSING_SPEED = 22;
export const CROSSING_CARS_PER_LANE = 8;
/** Sector 5 rounded-square ring expressway (outer CW / inner CCW): half size R, fillet r. */
export const RING_OUTER = { R: 30.8, r: 5.0 } as const;
export const RING_INNER = { R: 23.0, r: 3.0 } as const;
const BUMP_MARGIN_M = 0.55;
const BUMP_LATERAL = 11.5;
const BUMP_UP = 3.5;
const BUMP_COOLDOWN_S = 0.6;

export interface TrafficLane {
  /** Rounded-square ring (Sector 5) or a straight lane along `axis`. */
  readonly ring: boolean;
  readonly axis: Axis;
  /** Straight lane: lateral coordinate of the lane; ring: unused. */
  readonly lat: number;
  /** Straight lane: highway centreline (the bump pushes toward it). */
  readonly centre: number;
  /** +1 travels +along (ring: counter-clockwise in x–z), −1 the opposite way. */
  readonly dir: 1 | -1;
  readonly n: number;
  readonly speed: number;
  /** Arc-length / along offset of car 0 at t = 0. */
  readonly phase: number;
  /** Ring half size + fillet radius. */
  readonly R: number;
  readonly r: number;
  /** Ring: +1 ⇒ the bump pushes outward (inner ring toward the median), −1 ⇒ inward. */
  readonly pushSign: 1 | -1;
}

const wrapAlong = (a: number): number => ((((a + VIS) % SPAN) + SPAN) % SPAN) - VIS;

/** Perimeter of a rounded square (half size R, fillet r). */
export function ringPerimeter(R: number, r: number): number {
  return 8 * (R - r) + 2 * Math.PI * r;
}

/**
 * Rounded-square loop by arc length (counter-clockwise in the x–z plane: +x → +z), zero corner teleports.
 * Writes position `(x, z)`, unit tangent `(tx, tz)` and outward normal `(nx, nz)` into `out`.
 */
export function sampleRing(s: number, R: number, r: number, out: { x: number; z: number; tx: number; tz: number; nx: number; nz: number }): void {
  const q = 2 * (R - r);
  const arc = 0.5 * Math.PI * r;
  const quarter = q + arc;
  const P = 4 * quarter;
  let u = ((s % P) + P) % P;
  const k = Math.floor(u / quarter);
  u -= k * quarter;
  let x: number;
  let z: number;
  let tx: number;
  let tz: number;
  if (u < q) {
    x = R;
    z = -(R - r) + u;
    tx = 0;
    tz = 1;
  } else {
    const th = (u - q) / r;
    x = R - r + Math.cos(th) * r;
    z = R - r + Math.sin(th) * r;
    tx = -Math.sin(th);
    tz = Math.cos(th);
  }
  // Rotate the base quarter by k · 90° (counter-clockwise: (x, z) → (−z, x)).
  for (let i = 0; i < k; i++) {
    const nx0 = -z;
    z = x;
    x = nx0;
    const ntx = -tz;
    tz = tx;
    tx = ntx;
  }
  out.x = x;
  out.z = z;
  out.tx = tx;
  out.tz = tz;
  out.nx = tz;
  out.nz = -tx;
}

/**
 * 10D-1 lane plan. Straight expressways: two outer lanes at centre ± 4.9 m running in opposite directions over the
 * full ±175 m deck (the wrap happens far outside the playable square). Perpendicular grade crossings (Sector 3):
 * every lane at exactly 22 m/s with 8 cars (S = 43.75 m), phases anchored on the crossing centre and the x-axis
 * lanes shifted by S / 2 ⇒ ≥ 15.5 m centre-to-centre at every crossing for all t. Ring layout (Sector 5): outer
 * CW (R 30.8, r 5) and inner CCW (R 23, r 3) rounded-square loops, 12 cars each at 14–16 m/s.
 */
export function buildTrafficLanes(highways: ReadonlyArray<{ readonly axis: Axis; readonly coord: number }>, ring: boolean, rng: () => number): TrafficLane[] {
  const lanes: TrafficLane[] = [];
  if (ring) {
    for (const [def, dir, pushSign] of [[RING_OUTER, -1, -1], [RING_INNER, 1, 1]] as const) {
      lanes.push({ ring: true, axis: 'x', lat: 0, centre: 0, dir, n: 12, speed: 14 + rng() * 2, phase: rng() * ringPerimeter(def.R, def.r), R: def.R, r: def.r, pushSign });
    }
    return lanes;
  }
  const crossing = highways.some((h, i) => highways.some((o, j) => j !== i && o.axis !== h.axis));
  const perLane = crossing ? CROSSING_CARS_PER_LANE : Math.max(6, Math.min(18, Math.floor(TRAFFIC_CAP / Math.max(1, highways.length * 2))));
  for (const h of highways) {
    const cross = highways.find((o) => o.axis !== h.axis);
    const S = SPAN / perLane;
    const baseSpeed = crossing ? CROSSING_SPEED : 18 + rng() * 8;
    for (const dir of [1, -1] as const) {
      const speed = crossing ? CROSSING_SPEED : Math.min(26, Math.max(18, baseSpeed + (rng() - 0.5) * 2));
      const phase = crossing && cross ? cross.coord + (h.axis === 'x' ? S / 2 : 0) : rng() * S;
      lanes.push({ ring: false, axis: h.axis, lat: h.coord + dir * TRAFFIC_LANE_OFFSET_M, centre: h.coord, dir, n: perLane, speed, phase, R: 0, r: 0, pushSign: 1 });
    }
  }
  return lanes;
}

/** Car state at simulation time `t` (pure; used by the runtime and the tests). */
export interface TrafficCarState {
  x: number;
  z: number;
  /** Heading (forward +Z rotated by yaw about +Y). */
  yaw: number;
  /** Horizontal unit push direction toward the highway centreline (non-lethal bump). */
  px: number;
  pz: number;
}
const _ring = { x: 0, z: 0, tx: 0, tz: 0, nx: 0, nz: 0 };
export function trafficCarAt(lane: TrafficLane, i: number, t: number, out: TrafficCarState): TrafficCarState {
  if (lane.ring) {
    const P = ringPerimeter(lane.R, lane.r);
    const s = lane.phase + (i * P) / lane.n + lane.dir * lane.speed * t;
    sampleRing(s, lane.R, lane.r, _ring);
    const tx = _ring.tx * lane.dir;
    const tz = _ring.tz * lane.dir;
    out.x = _ring.x;
    out.z = _ring.z;
    out.yaw = Math.atan2(tx, tz);
    out.px = _ring.nx * lane.pushSign;
    out.pz = _ring.nz * lane.pushSign;
    return out;
  }
  const S = SPAN / lane.n;
  const a = wrapAlong(lane.phase + i * S + lane.dir * lane.speed * t);
  const push = -Math.sign(lane.lat - lane.centre) || 1;
  if (lane.axis === 'x') {
    out.x = a;
    out.z = lane.lat;
    out.yaw = lane.dir > 0 ? Math.PI / 2 : -Math.PI / 2;
    out.px = 0;
    out.pz = push;
  } else {
    out.x = lane.lat;
    out.z = a;
    out.yaw = lane.dir > 0 ? 0 : Math.PI;
    out.px = push;
    out.pz = 0;
  }
  return out;
}

/** Tags a primitive with `aPart` + `aAo` (non-indexed, position + normal only). */
function tagPart(list: THREE.BufferGeometry[], g: THREE.BufferGeometry, part: number, ao: number | ((y: number, z: number) => number) = 1): void {
  const out = g.index ? g.toNonIndexed() : g;
  for (const name of Object.keys(out.attributes)) if (name !== 'position' && name !== 'normal') out.deleteAttribute(name);
  const pos = out.getAttribute('position');
  const n = pos.count;
  const pa = new Float32Array(n).fill(part);
  const aa = new Float32Array(n);
  for (let i = 0; i < n; i++) aa[i] = typeof ao === 'number' ? ao * (pos.getY(i) < 0.3 ? 0.5 + 0.5 * Math.max(0, pos.getY(i)) / 0.3 : 1) : ao(pos.getY(i), pos.getZ(i));
  out.setAttribute('aPart', new THREE.BufferAttribute(pa, 1));
  out.setAttribute('aAo', new THREE.BufferAttribute(aa, 1));
  list.push(out);
}

/** Flat horizontal tapered ribbon (both faces) from z0 → z1 at (x, y), widths w0 → w1; aAo = fade 1 → 0. */
function ribbon(list: THREE.BufferGeometry[], x: number, y: number, z0: number, z1: number, w0: number, w1: number, segs: number): void {
  const p: number[] = [];
  const nrm: number[] = [];
  const fade: number[] = [];
  for (let k = 0; k < segs; k++) {
    const t0 = k / segs;
    const t1 = (k + 1) / segs;
    const za = z0 + (z1 - z0) * t0;
    const zb = z0 + (z1 - z0) * t1;
    const wa = (w0 + (w1 - w0) * t0) / 2;
    const wb = (w0 + (w1 - w0) * t1) / 2;
    const quad = [
      [x - wa, za, 1 - t0], [x + wa, za, 1 - t0], [x + wb, zb, 1 - t1],
      [x - wa, za, 1 - t0], [x + wb, zb, 1 - t1], [x - wb, zb, 1 - t1],
    ];
    // Top face (+Y: 0-1-2 winds counter-clockwise seen from above as z decreases) then the mirrored bottom face.
    for (const [up, order] of [[1, [0, 1, 2, 3, 4, 5]], [-1, [0, 2, 1, 3, 5, 4]]] as const) {
      for (const idx of order) {
        const [vx, vz, f] = quad[idx];
        p.push(vx, y, vz);
        nrm.push(0, up, 0);
        fade.push(f);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(new Array(p.length / 3).fill(5), 1));
  g.setAttribute('aAo', new THREE.Float32BufferAttribute(fade, 1));
  list.push(g);
}

/**
 * 10D-1 sculpted low-poly traffic wedge coupe (≤ 240 tris, 4.5 × 1.92 × 1.18 m, forward +Z, min.y = 0):
 * aPart 0 paint · 1 tinted canopy · 2 white / cyan LED head bar (z +2.24) · 3 crimson tail bar (z −2.24) ·
 * 4 wheel blocks · 5 opaque crimson light ribbons (z −2.28 → −5.2, aAo = fade).
 */
export function buildTrafficCarGeometry(): THREE.BufferGeometry {
  const L: THREE.BufferGeometry[] = [];
  tagPart(L, loftSymHull([
    { z: 2.25, pts: [[0, 0.3], [0.62, 0.32], [0.8, 0.45], [0.52, 0.56], [0, 0.58]] },
    { z: 1.5, pts: [[0, 0.22], [0.9, 0.24], [0.96, 0.5], [0.8, 0.72], [0, 0.76]] },
    { z: -1.2, pts: [[0, 0.22], [0.92, 0.24], [0.96, 0.55], [0.82, 0.8], [0, 0.84]] },
    { z: -2.25, pts: [[0, 0.3], [0.84, 0.32], [0.9, 0.55], [0.76, 0.78], [0, 0.8]] },
  ]), 0);
  tagPart(L, loftSymHull([
    { z: 0.95, pts: [[0, 0.7], [0.66, 0.72], [0.4, 0.92], [0, 0.94]] },
    { z: -0.2, pts: [[0, 0.76], [0.72, 0.78], [0.46, 1.16], [0, 1.18]] },
    { z: -1.45, pts: [[0, 0.8], [0.72, 0.82], [0.5, 1.0], [0, 1.02]] },
  ]), 1);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) tagPart(L, box(0.26, 0.56, 0.64, sx * 0.83, 0.28, sz * 1.42), 4, 0.6);
  tagPart(L, box(1.2, 0.06, 0.04, 0, 0.5, 2.24), 2);
  tagPart(L, box(1.44, 0.07, 0.04, 0, 0.56, -2.24), 3);
  for (const sx of [-1, 1]) ribbon(L, sx * 0.66, 0.56, -2.28, TRAFFIC_BOUNDS.ribbonEndZ, 0.075, 0.008, 4);
  return mergeGeometries(L) as THREE.BufferGeometry;
}

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s1 = new THREE.Vector3(1, 1, 1);
const _yAxis = new THREE.Vector3(0, 1, 0);
const _car: TrafficCarState = { x: 0, z: 0, yaw: 0, px: 0, pz: 0 };

/** 10D-1 expressway traffic: one persistent InstancedMesh (cap 36), instance matrices refreshed from simTime. */
export class ElevatedTraffic {
  readonly mesh: THREE.InstancedMesh;
  private lanes: TrafficLane[] = [];
  private readonly laneOf = new Int16Array(TRAFFIC_CAP);
  private readonly idxOf = new Int16Array(TRAFFIC_CAP);
  private readonly cx = new Float32Array(TRAFFIC_CAP);
  private readonly cz = new Float32Array(TRAFFIC_CAP);
  private readonly cyaw = new Float32Array(TRAFFIC_CAP);
  private readonly cpx = new Float32Array(TRAFFIC_CAP);
  private readonly cpz = new Float32Array(TRAFFIC_CAP);
  private bumpCooldown = 0;
  private lastT = NaN;

  constructor(inject: CityLightInjector) {
    const geo = buildTrafficCarGeometry();
    geo.setAttribute('aTraffic', new THREE.InstancedBufferAttribute(new Float32Array(TRAFFIC_CAP * 4), 4));
    const mat = new THREE.MeshStandardMaterial({ color: 0x1a1e26, roughness: 0.34, metalness: 0.62, emissive: new THREE.Color(0xffffff) });
    mat.onBeforeCompile = (shader) => {
      inject(shader);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aPart;\nattribute float aAo;\nattribute vec4 aTraffic;\nvarying float vTPart;\nvarying float vTAo;\nvarying vec4 vTraffic;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\nvTPart = aPart;\nvTAo = aAo;\nvTraffic = aTraffic;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
varying float vTPart;
varying float vTAo;
varying vec4 vTraffic;
vec3 strandTrafficPaint(float k) {
  if (k < 0.5) return vec3(0.02, 0.022, 0.026);
  if (k < 1.5) return vec3(0.34, 0.35, 0.37);
  if (k < 2.5) return vec3(0.16, 0.012, 0.02);
  if (k < 3.5) return vec3(0.012, 0.05, 0.11);
  if (k < 4.5) return vec3(0.2, 0.13, 0.015);
  return vec3(0.07, 0.075, 0.085);
}`)
        .replace('#include <map_fragment>', `#include <map_fragment>
          float tp = floor(vTPart + 0.5);
          if (tp == 0.0) diffuseColor.rgb = strandTrafficPaint(vTraffic.x) * vTAo;
          else if (tp == 1.0) diffuseColor.rgb = vec3(0.012, 0.018, 0.026);
          else if (tp == 4.0) diffuseColor.rgb = vec3(0.012) * vTAo;
          else diffuseColor.rgb = vec3(0.01);`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          if (tp == 1.0) roughnessFactor = 0.08;
          else if (tp == 4.0) roughnessFactor = 0.85;`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          totalEmissiveRadiance = vec3(0.0);
          if (tp == 2.0) totalEmissiveRadiance = mix(vec3(1.0, 0.96, 0.9), vec3(0.35, 0.9, 1.0), vTraffic.y) * 1.6 * vTraffic.z;
          else if (tp == 3.0) totalEmissiveRadiance = vec3(1.0, 0.05, 0.08) * 1.5 * vTraffic.z;
          else if (tp == 5.0) totalEmissiveRadiance = vec3(1.0, 0.04, 0.07) * 1.8 * pow(clamp(vTAo, 0.0, 1.0), 1.4) * vTraffic.z;`);
    };
    mat.customProgramCacheKey = () => 'strand-traffic-v1';
    this.mesh = new THREE.InstancedMesh(geo, mat, TRAFFIC_CAP);
    this.mesh.name = 'ElevatedTraffic';
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
  }

  get count(): number {
    return this.mesh.count;
  }
  get laneList(): readonly TrafficLane[] {
    return this.lanes;
  }

  /** New district: lanes + per-car paint / head-light / emissive variation (seeded, deterministic). */
  setLanes(lanes: TrafficLane[], rng: () => number): void {
    this.lanes = lanes;
    const attr = this.mesh.geometry.getAttribute('aTraffic') as THREE.InstancedBufferAttribute;
    let n = 0;
    lanes.forEach((ln, li) => {
      for (let i = 0; i < ln.n && n < TRAFFIC_CAP; i++, n++) {
        this.laneOf[n] = li;
        this.idxOf[n] = i;
        attr.setXYZW(n, Math.floor(rng() * 6), rng() < 0.45 ? 1 : 0, 0.85 + rng() * 0.3, 0);
      }
    });
    attr.needsUpdate = true;
    this.mesh.count = n;
    this.bumpCooldown = 0;
    this.lastT = NaN;
    this.update(0);
  }

  /** Per frame (allocation-free): advance every car along its lane at simulation time t. */
  update(t: number): void {
    const dt = Number.isFinite(this.lastT) ? Math.max(0, t - this.lastT) : 0;
    this.lastT = t;
    if (this.bumpCooldown > 0) this.bumpCooldown = Math.max(0, this.bumpCooldown - dt);
    const n = this.mesh.count;
    for (let k = 0; k < n; k++) {
      trafficCarAt(this.lanes[this.laneOf[k]], this.idxOf[k], t, _car);
      this.cx[k] = _car.x;
      this.cz[k] = _car.z;
      this.cyaw[k] = _car.yaw;
      this.cpx[k] = _car.px;
      this.cpz[k] = _car.pz;
      _q.setFromAxisAngle(_yAxis, _car.yaw);
      _m4.compose(_p.set(_car.x, DECK + 0.02, _car.z), _q, _s1);
      this.mesh.setMatrixAt(k, _m4);
    }
    if (n) this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Current car k (after the last update) — tests / debug. */
  carState(k: number, out: TrafficCarState): TrafficCarState {
    out.x = this.cx[k];
    out.z = this.cz[k];
    out.yaw = this.cyaw[k];
    out.px = this.cpx[k];
    out.pz = this.cpz[k];
    return out;
  }

  /**
   * Strictly non-lethal bump (0 damage): when the player's horizontal distance to a car's body box is < 0.55 m
   * and the cooldown is clear, writes an inward impulse (toward the highway centreline, never over the guard
   * wall) of 11.5 m/s + a 3.5 m/s hop into `outImpulse` and returns true. The caller applies impulse + trauma.
   */
  checkPlayerBump(playerPos: THREE.Vector3, outImpulse: THREE.Vector3): boolean {
    if (this.bumpCooldown > 0 || Math.abs(playerPos.y - DECK) >= 2.2) return false;
    const hw = TRAFFIC_BOUNDS.w / 2;
    const hl = TRAFFIC_BOUNDS.l / 2;
    for (let k = 0; k < this.mesh.count; k++) {
      const dx = playerPos.x - this.cx[k];
      const dz = playerPos.z - this.cz[k];
      if (dx * dx + dz * dz > 16) continue;
      const s = Math.sin(this.cyaw[k]);
      const c = Math.cos(this.cyaw[k]);
      const along = dx * s + dz * c;
      const lat = dx * c - dz * s;
      const margin = Math.max(Math.abs(lat) - hw, Math.abs(along) - hl);
      if (margin >= BUMP_MARGIN_M) continue;
      outImpulse.set(this.cpx[k] * BUMP_LATERAL, BUMP_UP, this.cpz[k] * BUMP_LATERAL);
      this.bumpCooldown = BUMP_COOLDOWN_S;
      return true;
    }
    return false;
  }
}

// =============================================================================================
// 10D-2 AnimatedEnvKit
// =============================================================================================
export const ENV_CAP = 220;
export const ENV_TRI_BUDGET = 320;
export const ENV_VARIANT = { FAN: 0, NOREN: 1, HOLO: 2 } as const;
/** Fan disc radius / projection, noren rod width / cloth drop, hologram ring sweep. */
export const ENV_DIMS = { FAN_R: 0.44, FAN_DEPTH: 0.26, NOREN_W: 1.64, NOREN_DROP: 0.68, HOLO_R: 3.4, HOLO_SWEEP: 3.6, HOLO_TOP: 8.4 } as const;
/**
 * aAnim.x modes: 0 static · 1 fan blades (spin xy about local +Z) · 2 noren cloth (wind sway, aAnim.y = drop 0…1) ·
 * 3 hologram outer ring (+uTime · 0.45 about Y) · 4 hologram gyro ring + crystal (−uTime · 0.85 about Y + bob).
 * aPart: 0 dark steel · 2 backlit vent core · 3 emitter pad glow · 4 neon hologram strut · 5 dyed cloth · 6 fan blade.
 */
function tagEnv(list: THREE.BufferGeometry[], g: THREE.BufferGeometry, variant: number, part: number, mode: number, ao = 1): void {
  const out = g.index ? g.toNonIndexed() : g;
  for (const name of Object.keys(out.attributes)) if (name !== 'position' && name !== 'normal') out.deleteAttribute(name);
  const pos = out.getAttribute('position');
  const n = pos.count;
  const anim = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    anim[i * 2] = mode;
    anim[i * 2 + 1] = mode === 2 ? Math.min(1, Math.max(0, -pos.getY(i) / ENV_DIMS.NOREN_DROP)) : 0;
  }
  out.setAttribute('aVar', new THREE.BufferAttribute(new Float32Array(n).fill(variant), 1));
  out.setAttribute('aPart', new THREE.BufferAttribute(new Float32Array(n).fill(part), 1));
  out.setAttribute('aAo', new THREE.BufferAttribute(new Float32Array(n).fill(ao), 1));
  out.setAttribute('aAnim', new THREE.BufferAttribute(anim, 2));
  list.push(out);
}

/** v0: octagonal exhaust fan — back plate on the wall (z = 0), shroud to z 0.24, guard at z 0.25, 6 pitched blades. */
function envFan(L: THREE.BufferGeometry[]): void {
  const V = 0;
  tagEnv(L, box(0.98, 0.98, 0.03, 0, 0, 0.015), V, 0, 0, 0.7);
  tagEnv(L, cyl(0.44, 0.44, 0.24, 8, 0, 0, 0.12, [Math.PI / 2, 0, 0]), V, 0, 0, 0.85);
  // Inner shroud wall (inward normals: descending lathe), so grazing views never see through the open cylinder.
  const inner = new THREE.LatheGeometry([new THREE.Vector2(0.43, 0.24), new THREE.Vector2(0.43, 0.0)], 8).toNonIndexed();
  inner.rotateX(Math.PI / 2);
  tagEnv(L, inner, V, 0, 0, 0.55);
  const lip = new THREE.RingGeometry(0.34, 0.46, 8, 1);
  lip.translate(0, 0, 0.24);
  tagEnv(L, lip, V, 0, 0, 0.9);
  const core = new THREE.CircleGeometry(0.34, 8);
  core.translate(0, 0, 0.04);
  tagEnv(L, core, V, 2, 0, 0.38);
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) tagEnv(L, box(0.05, 0.05, 0.04, sx * 0.4, sy * 0.4, 0.05), V, 0, 0, 0.8);
  for (const r of [Math.PI / 4, -Math.PI / 4]) tagEnv(L, box(0.9, 0.025, 0.02, 0, 0, 0.25, [0, 0, r]), V, 0, 0, 0.9);
  tagEnv(L, cyl(0.07, 0.07, 0.06, 6, 0, 0, 0.14, [Math.PI / 2, 0, 0], true), V, 6, 1, 0.8);
  for (let k = 0; k < 6; k++) {
    const b = box(0.09, 0.3, 0.012, 0, 0.21, 0.14, [0, (22 * Math.PI) / 180, 0]);
    b.rotateZ((k * Math.PI) / 3);
    tagEnv(L, b, V, 6, 1, 0.85);
  }
}

/** v1: noren — rod at y 0 / z 0.06 (1.64 m), 4 split back-to-back flaps to y −0.68, hangers up + standoffs back. */
function envNoren(L: THREE.BufferGeometry[]): void {
  const V = 1;
  const hw = ENV_DIMS.NOREN_W / 2;
  tagEnv(L, rod(new THREE.Vector3(-hw, 0, 0.06), new THREE.Vector3(hw, 0, 0.06), 0.018, 6), V, 0, 0);
  for (const sx of [-1, 1]) {
    tagEnv(L, rod(new THREE.Vector3(sx * 0.7, 0, 0.06), new THREE.Vector3(sx * 0.7, 0.14, 0.06), 0.012, 4), V, 0, 0);
    tagEnv(L, rod(new THREE.Vector3(sx * 0.7, 0, 0.06), new THREE.Vector3(sx * 0.7, 0, -0.22), 0.012, 4), V, 0, 0);
  }
  const fw = 0.385;
  for (let k = 0; k < 4; k++) {
    const cx = -hw + 0.005 + fw / 2 + k * (fw + 0.03);
    for (const back of [false, true]) {
      const pg = new THREE.PlaneGeometry(fw, 0.66, 1, 4);
      if (back) pg.rotateY(Math.PI);
      pg.translate(cx, -0.35, 0.06);
      tagEnv(L, pg, V, 5, 2);
    }
  }
}

/** v2: rooftop corporate wireframe hologram — emitter pedestal, light beam, 12-gon outer ring, tilted gyro + crystal. */
function envHolo(L: THREE.BufferGeometry[]): void {
  const V = 2;
  tagEnv(L, cyl(0.85, 0.85, 0.25, 8, 0, 0.125, 0, [0, 0, 0], true), V, 0, 0, 0.75);
  const pad = new THREE.RingGeometry(0.45, 0.7, 8, 1);
  pad.rotateX(-Math.PI / 2);
  pad.translate(0, 0.255, 0);
  tagEnv(L, pad, V, 3, 0);
  const R = ENV_DIMS.HOLO_R;
  const yc = 1.6 + R;
  tagEnv(L, rod(new THREE.Vector3(0, 0.25, 0), new THREE.Vector3(0, 1.6, 0), 0.04, 3), V, 4, 0);
  const outer = (k: number): THREE.Vector3 => {
    const th = (k / 12) * Math.PI * 2;
    return new THREE.Vector3(R * Math.sin(th), yc - R * Math.cos(th), 0);
  };
  for (let k = 0; k < 12; k++) tagEnv(L, rod(outer(k), outer(k + 1), 0.03, 3), V, 4, 3);
  const tilt = (35 * Math.PI) / 180;
  const inner = (k: number): THREE.Vector3 => {
    const ph = (k / 10) * Math.PI * 2;
    return new THREE.Vector3(1.8 * Math.cos(ph), yc + 1.8 * Math.sin(ph) * Math.sin(tilt), 1.8 * Math.sin(ph) * Math.cos(tilt));
  };
  for (let k = 0; k < 10; k++) tagEnv(L, rod(inner(k), inner(k + 1), 0.0275, 3), V, 4, 4);
  const oct = new THREE.OctahedronGeometry(0.6, 0);
  oct.translate(0, yc, 0);
  tagEnv(L, oct, V, 4, 4);
}

/** Merged kit geometry for `variants` (position, normal, aVar, aPart, aAo, aAnim). */
export function buildAnimatedEnvKit(variants: readonly number[] = [ENV_VARIANT.FAN, ENV_VARIANT.NOREN, ENV_VARIANT.HOLO]): THREE.BufferGeometry {
  const L: THREE.BufferGeometry[] = [];
  if (variants.includes(ENV_VARIANT.FAN)) envFan(L);
  if (variants.includes(ENV_VARIANT.NOREN)) envNoren(L);
  if (variants.includes(ENV_VARIANT.HOLO)) envHolo(L);
  return mergeGeometries(L) as THREE.BufferGeometry;
}
export function envVariantTris(v: number): number {
  const g = buildAnimatedEnvKit([v]);
  return g.getAttribute('position').count / 3;
}

/** One placed kit instance (QA record). */
export interface EnvInstance {
  readonly variant: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  /** Host: WALL / ROOM (machine-room flank) / AWNING / BAY (alley bay) / ROOF. */
  readonly host: 'WALL' | 'ROOM' | 'AWNING' | 'BAY' | 'ROOF';
}

const _col = new THREE.Color();

/** 10D-2 GPU-animated micro-environment: one persistent InstancedMesh (cap 220), 100 % uTime-driven. */
export class AnimatedEnvKit {
  readonly mesh: THREE.InstancedMesh;
  readonly instances: EnvInstance[] = [];
  private readonly env: THREE.InstancedBufferAttribute;
  private readonly envCol: THREE.InstancedBufferAttribute;

  constructor(inject: CityLightInjector, uTime: { value: number }) {
    const geo = buildAnimatedEnvKit();
    this.env = new THREE.InstancedBufferAttribute(new Float32Array(ENV_CAP * 4), 4);
    this.envCol = new THREE.InstancedBufferAttribute(new Float32Array(ENV_CAP * 3), 3);
    geo.setAttribute('aEnv', this.env);
    geo.setAttribute('aEnvCol', this.envCol);
    const mat = new THREE.MeshStandardMaterial({ color: 0x1c2028, roughness: 0.45, metalness: 0.6, emissive: new THREE.Color(0xffffff) });
    mat.onBeforeCompile = (shader) => {
      inject(shader);
      shader.uniforms.uTime = uTime;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform float uTime;\nattribute float aVar;\nattribute float aPart;\nattribute float aAo;\nattribute vec2 aAnim;\nattribute vec4 aEnv;\nattribute vec3 aEnvCol;\nvarying float vEPart;\nvarying float vEAo;\nvarying vec3 vECol;\nvarying vec3 vELocal;',
        )
        // Normals rotate right after beginnormal (it runs BEFORE begin_vertex in r187), positions after begin_vertex.
        .replace(
          '#include <beginnormal_vertex>',
          `#include <beginnormal_vertex>
          float eMode = floor(aAnim.x + 0.5);
          float eAng = eMode == 1.0 ? uTime * aEnv.y + aEnv.z : (eMode == 3.0 ? uTime * 0.45 + aEnv.z : (eMode == 4.0 ? -uTime * 0.85 + aEnv.z : 0.0));
          mat2 eRot = mat2(cos(eAng), sin(eAng), -sin(eAng), cos(eAng));
          if (eMode == 1.0) objectNormal.xy = eRot * objectNormal.xy;
          else if (eMode > 2.5) objectNormal.xz = eRot * objectNormal.xz;`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          vELocal = position;
          if (eMode == 1.0) transformed.xy = eRot * transformed.xy;
          else if (eMode > 2.5) {
            transformed.xz = eRot * transformed.xz;
            if (eMode == 4.0) transformed.y += sin(uTime * 1.4 + aEnv.z) * 0.22;
          } else if (eMode == 2.0) {
            float bend = aAnim.y * aAnim.y;
            float wave = sin(uTime * aEnv.y + aEnv.z + position.x * 2.6) * 0.11 + sin(uTime * aEnv.y * 2.3 + aEnv.z * 1.7 + position.x * 5.2) * 0.035;
            transformed.z += wave * bend;
            transformed.y += abs(wave) * 0.08 * bend;
          }
          if (abs(aVar - aEnv.x) > 0.5) transformed = vec3(0.0);
          vEPart = aPart;
          vEAo = aAo;
          vECol = aEnvCol;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;\nvarying float vEPart;\nvarying float vEAo;\nvarying vec3 vECol;\nvarying vec3 vELocal;')
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
          float ep = floor(vEPart + 0.5);
          if (ep == 0.0) diffuseColor.rgb = vec3(0.1, 0.11, 0.13);
          else if (ep == 6.0) diffuseColor.rgb = vec3(0.16, 0.17, 0.19);
          else if (ep == 5.0) diffuseColor.rgb = vECol * 0.32 * (1.0 + 0.8 * (1.0 - step(0.022, abs(vELocal.y + 0.1))));
          else diffuseColor.rgb = vec3(0.015);
          diffuseColor.rgb *= vEAo;`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
          if (ep == 5.0) roughnessFactor = 0.78;
          else if (ep == 6.0) roughnessFactor = 0.35;`,
        )
        .replace(
          '#include <metalnessmap_fragment>',
          `#include <metalnessmap_fragment>
          if (ep == 5.0) metalnessFactor = 0.02;
          else if (ep == 0.0 || ep == 6.0) metalnessFactor = 0.7;`,
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
          totalEmissiveRadiance = vec3(0.0);
          if (ep == 2.0) totalEmissiveRadiance = vECol * 0.65;
          else if (ep == 3.0) totalEmissiveRadiance = vECol * 1.1;
          else if (ep == 4.0) totalEmissiveRadiance = vECol * (1.25 + 0.35 * sin(vCityWorld.y * 5.0 - uTime * 4.0));
          else if (ep == 5.0) totalEmissiveRadiance = vECol * 0.12;`,
        );
    };
    mat.customProgramCacheKey = () => 'strand-envkit-v1';
    this.mesh = new THREE.InstancedMesh(geo, mat, ENV_CAP);
    this.mesh.name = 'AnimatedEnvKit';
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
  }

  get count(): number {
    return this.mesh.count;
  }

  /** New district: clears every instance. */
  begin(): void {
    this.mesh.count = 0;
    this.instances.length = 0;
  }

  /** Adds one instance (local +Z faces outward at `yaw`). `speed` rad/s, `phase` rad, `hex` sRGB colour. */
  add(variant: number, x: number, y: number, z: number, yaw: number, speed: number, phase: number, hex: number, host: EnvInstance['host']): boolean {
    const i = this.mesh.count;
    if (i >= ENV_CAP) return false;
    _q.setFromAxisAngle(_yAxis, yaw);
    _m4.compose(_p.set(x, y, z), _q, _s1);
    this.mesh.setMatrixAt(i, _m4);
    this.env.setXYZW(i, variant, speed, phase, 0);
    _col.setHex(hex);
    this.envCol.setXYZ(i, _col.r, _col.g, _col.b);
    this.mesh.count = i + 1;
    this.instances.push({ variant, x, y, z, yaw, host });
    return true;
  }

  /** Uploads the instance buffers after a district build. */
  end(): void {
    this.mesh.instanceMatrix.needsUpdate = true;
    this.env.needsUpdate = true;
    this.envCol.needsUpdate = true;
  }
}

// =============================================================================================
// 10D-4 speed-of-sound thunder scheduling (pure, allocation-free)
// =============================================================================================
/** Raw stereo pan of a lightning azimuth `az` for a camera yaw: cos(az + yaw) (+1 = dead right). */
export function thunderPanRaw(az: number, yaw: number): number {
  return Math.cos(az + yaw);
}
const hash01 = (k: number): number => {
  const x = Math.sin(k * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};
export interface LightningLike {
  k: number;
  azimuth: number;
  intensity: number;
}
/**
 * Arms one rumble per lightning strike (intensity ≥ 0.25) 1.5–3.0 s later (deterministic per cycle k); fires only
 * while playing, with pan = clamp(cos(az + yaw), −0.85, 0.85). `reset()` on a sector switch / pause.
 */
export class ThunderScheduler {
  private lastK = Number.NaN;
  fireAt = -1;
  azimuth = 0;
  intensity = 0;
  pan = 0;

  reset(): void {
    this.fireAt = -1;
    this.lastK = Number.NaN;
  }

  /** Feeds the current lightning sample; returns true on the frame the rumble should play (pan / intensity set). */
  step(simTime: number, sample: LightningLike, playing: boolean, yaw: number): boolean {
    // Outside PLAYING nothing is armed (strikes seen on the title / menus never rumble later).
    if (!playing) {
      this.fireAt = -1;
      if (sample.intensity >= 0.25) this.lastK = sample.k;
      return false;
    }
    if (sample.k !== this.lastK && sample.intensity >= 0.25) {
      this.lastK = sample.k;
      this.fireAt = simTime + 1.5 + hash01(sample.k) * 1.5;
      this.azimuth = sample.azimuth;
      this.intensity = sample.intensity;
    }
    if (this.fireAt < 0 || simTime < this.fireAt) return false;
    this.fireAt = -1;
    this.pan = Math.max(-0.85, Math.min(0.85, thunderPanRaw(this.azimuth, yaw)));
    return true;
  }
}
