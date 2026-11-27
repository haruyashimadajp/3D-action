/**
 * STRAND // PROTOCOL — 11A-2 / 11A-3 destructibles: kickable breach doors + shatterable tempered glass.
 *
 *  - 'InteractiveDoors': ONE persistent InstancedMesh (cap 32, +1 draw call). HERO §5.2 steel door leaf (162 tris)
 *    scaled per doorway (x = width / 1.04, y = height / 2.16). Three modes: quiet open (105° inward pivot about the
 *    hinge edge over 0.38 s, LED amber → green), breach (slab rockets inward 11 m/s + 1.8 m/s lift + tumble, bounces,
 *    rests 2.0 s, then the shared 0.55 s digital scanline dissolve), ballistic breach (1 sniper / 2 pistol hits).
 *  - 'DestructibleGlassPanes': ONE persistent InstancedMesh (cap 48, +1 draw call). Transparent tempered glass
 *    (alpha 0.18–0.32 at normal incidence → 0.65 grazing), rain-streak Fresnel glints, city-light glints and a
 *    dark-steel bezel (+ centre mullion above 2.2 m) drawn in the fragment shader in METRES (constant under
 *    non-uniform instance scale, zero double-draw / z-fighting with the pane surface).
 *  - Breaking anything is O(1): `physics.setColliderActive(colliderIndex, false)` + a zero instance matrix. Glass
 *    shards (22–30) and breach splinters (6) go into the shared `effects.debris` pool (+0 draw calls here).
 *  Zero per-frame heap allocations (module-scope scratch only).
 */
import * as THREE from 'three';
import type { BoxCollider, ColliderKind } from '../world/CityBuilder';
import type { CityLightInjector } from '../world/CityAtmosphere';
import type { PhysicsWorld, RayHit } from '../world/PhysicsWorld';
import { createRayHit } from '../world/PhysicsWorld';
import { type EffectsPool, type ProjectileBreakables, type ProjectileOwner, GLSL_DIGITAL_DISSOLVE } from './EffectsPool';

// =================================================================================================
// Canonical door contract (HERO §5.2 / §7 Phase 13 .glb swap-ready)
// =================================================================================================
/** Canonical leaf envelope: x ∈ [-0.52, 0.52], y ∈ [0, 2.16], z ∈ [-0.0375, 0.0375]; hinge axis along local x = -0.52. */
export const DOOR_DIMS = { w: 1.04, h: 2.16, d: 0.075, hingeX: -0.52 } as const;
/** Hinge axis local z (inner face, −Z = inward): the leaf swings inward without cutting its own jamb corner. */
export const DOOR_HINGE_Z = -0.0375;
/** Quiet-open swing: 105° inward over 0.38 s (ease-out cubic). */
export const DOOR_OPEN_RAD = (105 * Math.PI) / 180;
export const DOOR_OPEN_S = 0.38;
/**
 * Largest clean inward swing for a door whose wall reveal continues `revealDepth` metres behind the leaf's inner face
 * (jamb clip ≤ 5 mm): 105° when the reveal is ≤ ~2 cm (door hung on the interior face), approaching 90° for deep
 * reveals. Feed it into `DoorSpec.openRad` when the doorway sits in a thick wall.
 */
export function doorSafeOpenRad(revealDepth: number): number {
  if (revealDepth <= 0.0186) return DOOR_OPEN_RAD;
  return Math.min(DOOR_OPEN_RAD, Math.PI / 2 + Math.atan(0.005 / revealDepth));
}
/** Breach slab ballistics. */
export const DOOR_BREACH = { SPEED: 11.0, LIFT: 1.8, GRAVITY: -22, REST_S: 2.0, DISSOLVE_S: 0.55, MAX_FLIGHT_S: 3.2, DEBRIS: 6 } as const;
/** Hardware sockets in canonical leaf space (Phase 13 swap contract). +Z = outer face, −Z = inner face. */
export const DOOR_SOCKETS = {
  lever: [0.38, 1.02, 0.0375],
  crashBar: [-0.03, 1.02, -0.0375],
  ledOuter: [0.38, 1.103, 0.0515],
  ledInner: [0.433, 1.043, -0.1345],
} as const;
/** Glass pane bezel width (m) and centre mullion width (m, panes wider than GLASS_MULLION_MIN_W). */
export const GLASS_BEZEL_M = 0.045;
export const GLASS_MULLION_M = 0.06;
export const GLASS_MULLION_MIN_W = 2.2;
export const DOOR_CAP = 32;
export const GLASS_CAP = 48;
/** Glass shards per shattered pane (inclusive range). */
export const GLASS_SHARDS = { MIN: 22, MAX: 30 } as const;

export type DoorState = 'CLOSED' | 'OPENING' | 'OPEN' | 'BREACHED' | 'GONE';

export interface DoorSpec {
  /** Centre of the doorway bottom, on the door's resting plane (world). */
  x: number;
  y: number;
  z: number;
  /** Local +Z (outer face) → world via rotation about +Y; inward = local −Z. */
  yaw: number;
  width: number;
  height: number;
  /** Index of this door's 'DOOR' collider in `layout.colliders`. */
  colliderIndex: number;
  interiorId: number;
  /** Leaf paint (sRGB hex; weathered olive / slate / charcoal). */
  tint: number;
  /** Optional swing override (rad, default DOOR_OPEN_RAD) for doorways whose inner jamb reveal would clip at 105°. */
  openRad?: number;
}

export interface GlassSpec {
  /** Bottom centre of the pane (world). */
  x: number;
  y: number;
  z: number;
  /** Local +Z (outer face) → world via rotation about +Y. */
  yaw: number;
  width: number;
  height: number;
  /** Index of this pane's 'GLASS' collider in `layout.colliders`. */
  colliderIndex: number;
  interiorId: number;
}

// =================================================================================================
// HERO §5.2 door geometry
// =================================================================================================
/** aPart ids of the door geometry. */
export const DOOR_PART = { LEAF: 0, PANEL: 1, GLASS: 2, STEEL: 3, DARK: 4, LED: 5, REVEAL: 6 } as const;

type P3 = readonly [number, number, number];

class DoorGeo {
  readonly pos: number[] = [];
  readonly nor: number[] = [];
  readonly part: number[] = [];
  readonly ao: number[] = [];

  /** Triangle with outward winding forced to agree with `hint`. */
  tri(a: P3, b: P3, c: P3, hint: P3, part: number, ao: number | readonly [number, number, number]): void {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    const ar = typeof ao === 'number' ? [ao, ao, ao] : ao;
    const flip = nx * hint[0] + ny * hint[1] + nz * hint[2] < 0;
    const vs = flip ? [a, c, b] : [a, b, c];
    const as = flip ? [ar[0], ar[2], ar[1]] : [ar[0], ar[1], ar[2]];
    const s = flip ? -1 : 1;
    for (let k = 0; k < 3; k++) {
      this.pos.push(vs[k][0], vs[k][1], vs[k][2]);
      this.nor.push(nx * s, ny * s, nz * s);
      this.part.push(part);
      this.ao.push(as[k]);
    }
  }

  /** Planar quad a-b-c-d (loop order) → 2 triangles, outward along `hint`. */
  quad(a: P3, b: P3, c: P3, d: P3, hint: P3, part: number, ao: number | readonly [number, number, number, number]): void {
    const ar = typeof ao === 'number' ? [ao, ao, ao, ao] : ao;
    this.tri(a, b, c, hint, part, [ar[0], ar[1], ar[2]]);
    this.tri(a, c, d, hint, part, [ar[0], ar[2], ar[3]]);
  }

  /** Axis-aligned box; `faces` lists the drawn faces among px nx py ny pz nz. */
  box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, faces: string, part: number, ao = 1): void {
    if (faces.includes('px')) this.quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [1, 0, 0], part, ao);
    if (faces.includes('nx')) this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], part, ao);
    if (faces.includes('py')) this.quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [0, 1, 0], part, ao);
    if (faces.includes('ny')) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], part, ao);
    if (faces.includes('pz')) this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], part, ao);
    if (faces.includes('nz')) this.quad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [0, 0, -1], part, ao);
  }
}

/**
 * HERO §5.2 interactive breach door (162 tris, flat-shaded, outward normals, min.y = 0). Outer face (+Z): bevelled
 * leaf frame with 2 recessed stamped panels (upper 0.74 × 0.88, lower 0.74 × 0.72, 45° stamped walls, AO 0.55),
 * wire-glass vision slit 0.18 × 0.44 at y 1.55 cut through the upper panel, lever + armoured escutcheon (x 0.38,
 * y 1.02) and the lock-status LED lens. Inner face (−Z): flush leaf with a brushed crash push-bar on two housings
 * (inner LED on the lock housing). Stainless kickplate (h 0.24) is shader-defined on the leaf (flush, zero z-fight).
 * Attributes: position, normal, aPart (DOOR_PART), aAo (baked cavity + ground-contact AO).
 */
export function buildInteractiveDoorGeometry(): THREE.BufferGeometry {
  const g = new DoorGeo();
  const W2 = DOOR_DIMS.w / 2;
  const H = DOOR_DIMS.h;
  const HZ = DOOR_DIMS.d / 2;
  const B = 0.005; // leaf edge bevel
  const PX0 = -0.41, PX1 = 0.33; // panel columns (0.74 wide; wider lock stile carries the escutcheon)
  const LY0 = 0.3, LY1 = 1.02; // lower panel 0.72
  const UY0 = 1.14, UY1 = 2.02; // upper panel 0.88
  const SX0 = -0.13, SX1 = 0.05, SY0 = 1.33, SY1 = 1.77; // vision slit 0.18 × 0.44 centred at y 1.55
  const RD = 0.01; // stamped recess depth
  const RI = 0.012; // 45°-ish stamped wall inset
  const ZF = HZ - RD; // recess floor plane (outer side)
  const PZ: P3 = [0, 0, 1];
  const NZ: P3 = [0, 0, -1];

  // ---- outer face frame (z = +HZ): rectangle with 2 panel holes, 14 tris, no T-junctions ----
  const O0: P3 = [-W2 + B, B, HZ], O1: P3 = [W2 - B, B, HZ], O2: P3 = [W2 - B, H - B, HZ], O3: P3 = [-W2 + B, H - B, HZ];
  const L0: P3 = [PX0, LY0, HZ], L1: P3 = [PX1, LY0, HZ], L2: P3 = [PX1, LY1, HZ], L3: P3 = [PX0, LY1, HZ];
  const U0: P3 = [PX0, UY0, HZ], U1: P3 = [PX1, UY0, HZ], U2: P3 = [PX1, UY1, HZ], U3: P3 = [PX0, UY1, HZ];
  const LF = DOOR_PART.LEAF;
  g.tri(O0, O1, L1, PZ, LF, 1);
  g.tri(O0, L1, L0, PZ, LF, 1);
  g.tri(O1, O2, U2, PZ, LF, 1);
  g.tri(O1, U2, U1, PZ, LF, 1);
  g.tri(O1, U1, L2, PZ, LF, 1);
  g.tri(O1, L2, L1, PZ, LF, 1);
  g.tri(L3, L2, U1, PZ, LF, 1);
  g.tri(L3, U1, U0, PZ, LF, 1);
  g.tri(U3, U2, O2, PZ, LF, 1);
  g.tri(U3, O2, O3, PZ, LF, 1);
  g.tri(O3, O0, L0, PZ, LF, 1);
  g.tri(O3, L0, L3, PZ, LF, 1);
  g.tri(O3, L3, U0, PZ, LF, 1);
  g.tri(O3, U0, U3, PZ, LF, 1);

  // ---- stamped recesses: 4 sloped walls (AO 0.80 rim → 0.55 floor edge) + floor ----
  const PN = DOOR_PART.PANEL;
  const recessWalls = (x0: number, x1: number, y0: number, y1: number): void => {
    const a0: P3 = [x0, y0, HZ], a1: P3 = [x1, y0, HZ], a2: P3 = [x1, y1, HZ], a3: P3 = [x0, y1, HZ];
    const b0: P3 = [x0 + RI, y0 + RI, ZF], b1: P3 = [x1 - RI, y0 + RI, ZF], b2: P3 = [x1 - RI, y1 - RI, ZF], b3: P3 = [x0 + RI, y1 - RI, ZF];
    g.quad(a0, a1, b1, b0, [0, 1, 1], PN, [0.8, 0.8, 0.55, 0.55]);
    g.quad(a1, a2, b2, b1, [-1, 0, 1], PN, [0.8, 0.8, 0.55, 0.55]);
    g.quad(a2, a3, b3, b2, [0, -1, 1], PN, [0.8, 0.8, 0.55, 0.55]);
    g.quad(a3, a0, b0, b3, [1, 0, 1], PN, [0.8, 0.8, 0.55, 0.55]);
  };
  recessWalls(PX0, PX1, LY0, LY1);
  g.quad([PX0 + RI, LY0 + RI, ZF], [PX1 - RI, LY0 + RI, ZF], [PX1 - RI, LY1 - RI, ZF], [PX0 + RI, LY1 - RI, ZF], PZ, PN, 0.86);
  recessWalls(PX0, PX1, UY0, UY1);
  // Upper panel floor with the vision-slit hole (8 tris).
  const ringWithHole = (f: readonly P3[], s: readonly P3[], hint: P3, part: number, ao: number): void => {
    for (let k = 0; k < 4; k++) {
      const n = (k + 1) % 4;
      g.tri(f[k], f[n], s[n], hint, part, ao);
      g.tri(f[k], s[n], s[k], hint, part, ao);
    }
  };
  ringWithHole(
    [[PX0 + RI, UY0 + RI, ZF], [PX1 - RI, UY0 + RI, ZF], [PX1 - RI, UY1 - RI, ZF], [PX0 + RI, UY1 - RI, ZF]],
    [[SX0, SY0, ZF], [SX1, SY0, ZF], [SX1, SY1, ZF], [SX0, SY1, ZF]],
    PZ,
    PN,
    0.86,
  );

  // ---- inner face (z = −HZ): flush leaf with the slit hole (8 tris) ----
  ringWithHole(
    [[-W2 + B, B, -HZ], [W2 - B, B, -HZ], [W2 - B, H - B, -HZ], [-W2 + B, H - B, -HZ]],
    [[SX0, SY0, -HZ], [SX1, SY0, -HZ], [SX1, SY1, -HZ], [SX0, SY1, -HZ]],
    NZ,
    LF,
    1,
  );

  // ---- vision slit: dark steel reveal through the leaf + armoured wire glass (front & back faces) ----
  const RV = DOOR_PART.REVEAL;
  g.quad([SX0, SY0, ZF], [SX1, SY0, ZF], [SX1, SY0, -HZ], [SX0, SY0, -HZ], [0, 1, 0], RV, 0.5);
  g.quad([SX0, SY1, ZF], [SX1, SY1, ZF], [SX1, SY1, -HZ], [SX0, SY1, -HZ], [0, -1, 0], RV, 0.5);
  g.quad([SX0, SY0, ZF], [SX0, SY1, ZF], [SX0, SY1, -HZ], [SX0, SY0, -HZ], [1, 0, 0], RV, 0.5);
  g.quad([SX1, SY0, ZF], [SX1, SY1, ZF], [SX1, SY1, -HZ], [SX1, SY0, -HZ], [-1, 0, 0], RV, 0.5);
  const GZ = -0.004;
  g.quad([SX0, SY0, GZ], [SX1, SY0, GZ], [SX1, SY1, GZ], [SX0, SY1, GZ], PZ, DOOR_PART.GLASS, 1);
  g.quad([SX0, SY0, GZ], [SX1, SY0, GZ], [SX1, SY1, GZ], [SX0, SY1, GZ], NZ, DOOR_PART.GLASS, 1);

  // ---- leaf edges (full size, z inset by the bevel) + 8 bevel chamfers (closed shell, no corner gaps) ----
  const ZE = HZ - B;
  g.quad([-W2, 0, -ZE], [-W2, 0, ZE], [-W2, H, ZE], [-W2, H, -ZE], [-1, 0, 0], LF, 1);
  g.quad([W2, 0, -ZE], [W2, H, -ZE], [W2, H, ZE], [W2, 0, ZE], [1, 0, 0], LF, 1);
  g.quad([-W2, H, -ZE], [-W2, H, ZE], [W2, H, ZE], [W2, H, -ZE], [0, 1, 0], LF, 1);
  g.quad([-W2, 0, -ZE], [W2, 0, -ZE], [W2, 0, ZE], [-W2, 0, ZE], [0, -1, 0], LF, 1);
  for (const sz of [1, -1]) {
    const zf = HZ * sz;
    const ze = ZE * sz;
    g.quad([-W2 + B, H - B, zf], [W2 - B, H - B, zf], [W2, H, ze], [-W2, H, ze], [0, 1, sz], LF, 1);
    g.quad([-W2 + B, B, zf], [W2 - B, B, zf], [W2, 0, ze], [-W2, 0, ze], [0, -1, sz], LF, 1);
    g.quad([-W2 + B, B, zf], [-W2 + B, H - B, zf], [-W2, H, ze], [-W2, 0, ze], [-1, 0, sz], LF, 1);
    g.quad([W2 - B, B, zf], [W2 - B, H - B, zf], [W2, H, ze], [W2, 0, ze], [1, 0, sz], LF, 1);
  }

  // ---- outer hardware (+Z): armoured escutcheon, lever on its neck, lock-status LED lens ----
  const ST = DOOR_PART.STEEL;
  g.box(0.345, 0.415, 0.89, 1.15, HZ, HZ + 0.012, 'px nx py ny pz', ST);
  g.box(0.366, 0.394, 1.006, 1.034, HZ + 0.012, HZ + 0.05, 'px nx py ny', ST, 0.8);
  g.box(0.236, 0.402, 1.008, 1.032, HZ + 0.046, HZ + 0.07, 'px nx py ny pz nz', ST);
  g.box(0.372, 0.388, 1.095, 1.111, HZ + 0.012, HZ + 0.016, 'px nx py ny pz', DOOR_PART.LED);

  // ---- inner hardware (−Z): crash push-bar between a hinge bracket and the lock housing (+ inner LED) ----
  g.box(-0.36, 0.3, 0.9975, 1.0425, -HZ - 0.085, -HZ - 0.055, 'py ny pz nz', ST);
  g.box(-0.42, -0.36, 0.985, 1.055, -HZ - 0.09, -HZ, 'px nx py ny nz', DOOR_PART.DARK, 0.85);
  g.box(0.3, 0.46, 0.975, 1.065, -HZ - 0.095, -HZ, 'px nx py ny nz', DOOR_PART.DARK, 0.85);
  g.box(0.425, 0.441, 1.035, 1.051, -HZ - 0.099, -HZ - 0.095, 'px nx py ny nz', DOOR_PART.LED);

  // ---- baked ground-contact AO (HERO §0): y < 0.30 → ao *= 0.45 + 0.55 · y / 0.30 ----
  for (let v = 0; v < g.ao.length; v++) {
    const y = g.pos[v * 3 + 1];
    if (y < 0.3) g.ao[v] *= 0.45 + 0.55 * (y / 0.3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(g.pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(g.nor, 3));
  geo.setAttribute('aPart', new THREE.Float32BufferAttribute(g.part, 1));
  geo.setAttribute('aAo', new THREE.Float32BufferAttribute(g.ao, 1));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/** Glass pane unit quad: x ∈ [-0.5, 0.5], y ∈ [0, 1], z = 0 (bottom-centre pivot, +Z = outer face). */
export function buildGlassPaneGeometry(): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(1, 1);
  g.translate(0, 0.5, 0);
  return g;
}

// =================================================================================================
// Scratch (module scope: zero per-frame allocation)
// =================================================================================================
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _c = new THREE.Color();
const _sa = new THREE.Vector3();
const _sb = new THREE.Vector3();
const _dirN = new THREE.Vector3();
const _hookPos = new THREE.Vector3();
const _hookDir = new THREE.Vector3();
const _zeroMat = new THREE.Matrix4().makeScale(0, 0, 0);
const _ray: RayHit = createRayHit();
const _wallRay: RayHit = createRayHit();
const FLOOR_PROBE_IGNORE: ReadonlySet<ColliderKind> = new Set<ColliderKind>(['GLASS', 'DOOR', 'WATER']);
/** Breached slabs float on canal water when there is no solid floor under them. */
const SLAB_PROBE_IGNORE: ReadonlySet<ColliderKind> = new Set<ColliderKind>(['DOOR', 'GLASS']);
const GLASS_COLORS = [0xd2f1fa, 0xaedfee, 0xe8fcff, 0xbfe8f4] as const;
/** Breached-slab support points in canonical leaf space (8 leaf corners + lever tips + crash-bar housing corners). */
const SLAB_SUPPORT: ReadonlyArray<readonly [number, number, number]> = [
  [-0.52, 0, -0.0375], [0.52, 0, -0.0375], [-0.52, 2.16, -0.0375], [0.52, 2.16, -0.0375],
  [-0.52, 0, 0.0375], [0.52, 0, 0.0375], [-0.52, 2.16, 0.0375], [0.52, 2.16, 0.0375],
  [0.236, 1.02, 0.1075], [0.402, 1.02, 0.1075],
  [0.46, 0.975, -0.1325], [0.46, 1.065, -0.1325], [-0.42, 0.985, -0.1275], [-0.42, 1.055, -0.1275],
];
let _seed = 0x51ab3c7;
function rand(): number {
  _seed = (Math.imul(_seed, 1664525) + 1013904223) >>> 0;
  return _seed / 4294967296;
}

const S_CLOSED = 0;
const S_OPENING = 1;
const S_OPEN = 2;
const S_BREACHED = 3;
const S_GONE = 4;
const STATE_NAMES: readonly DoorState[] = ['CLOSED', 'OPENING', 'OPEN', 'BREACHED', 'GONE'];
const GLASS_ID = 1 << 16;

// =================================================================================================
// Manager
// =================================================================================================
export class DestructibleManager implements ProjectileBreakables {
  readonly doorMesh: THREE.InstancedMesh;
  readonly glassMesh: THREE.InstancedMesh;
  /** Breach (kick / ballistic / sprint): lead plays SE, behind-door stun cone, 22 m alert, HUD. Args are scratch. */
  onDoorBreach?: (door: number, pos: THREE.Vector3, inward: THREE.Vector3) => void;
  /** Quiet crouch open: lead plays the hinge creak (0 m noise). `pos` is scratch. */
  onDoorQuietOpen?: (door: number, pos: THREE.Vector3) => void;
  /** Glass shattered: lead plays SE + 26 m alert. `pos` is scratch (impact point). */
  onGlassShatter?: (pane: number, pos: THREE.Vector3) => void;

  private readonly effects: EffectsPool;
  private physics: PhysicsWorld | null = null;
  private colliders: readonly BoxCollider[] = [];
  private doors: readonly DoorSpec[] = [];
  private glass: readonly GlassSpec[] = [];
  private doorN = 0;
  private glassN = 0;
  private readonly lookup = new Map<BoxCollider, number>();
  private readonly doorDis: THREE.InstancedBufferAttribute;
  private readonly doorLed: THREE.InstancedBufferAttribute;
  private readonly paneAttr: THREE.InstancedBufferAttribute;
  private readonly glassMat: THREE.MeshStandardMaterial;
  private readonly glassTime = { value: 0 };

  private readonly dState = new Uint8Array(DOOR_CAP);
  private readonly dHits = new Uint8Array(DOOR_CAP);
  private readonly dPhase = new Uint8Array(DOOR_CAP);
  private readonly dT = new Float32Array(DOOR_CAP);
  /** Breached slab: live floor under its path (re-probed every 0.1 s) and the probe timer. */
  private readonly dFloor = new Float32Array(DOOR_CAP);
  private readonly dProbeT = new Float32Array(DOOR_CAP);
  private readonly dFlight = new Float32Array(DOOR_CAP);
  private readonly dPos = new Float32Array(DOOR_CAP * 3);
  private readonly dVel = new Float32Array(DOOR_CAP * 3);
  private readonly dAng = new Float32Array(DOOR_CAP * 3);
  private readonly dRot = new Float32Array(DOOR_CAP * 4);
  private readonly dSeed = new Float32Array(DOOR_CAP);
  private readonly gBroken = new Uint8Array(GLASS_CAP);
  /** Doors currently animating (OPENING or BREACHED). */
  private animating = 0;

  constructor(scene: THREE.Scene, effects: EffectsPool, inject: CityLightInjector) {
    this.effects = effects;

    // ---- InteractiveDoors ----
    const dg = buildInteractiveDoorGeometry();
    this.doorDis = new THREE.InstancedBufferAttribute(new Float32Array(DOOR_CAP * 4), 4);
    this.doorDis.setUsage(THREE.DynamicDrawUsage);
    this.doorLed = new THREE.InstancedBufferAttribute(new Float32Array(DOOR_CAP), 1);
    this.doorLed.setUsage(THREE.DynamicDrawUsage);
    dg.setAttribute('aDissolve', this.doorDis);
    dg.setAttribute('aDoorLed', this.doorLed);
    const dm = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.55 });
    dm.onBeforeCompile = (shader) => {
      inject(shader);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nattribute float aPart;\nattribute float aAo;\nattribute vec4 aDissolve;\nattribute float aDoorLed;\nvarying float vDPart;\nvarying float vDAo;\nvarying vec3 vDLocal;\nvarying vec4 vDDis;\nvarying vec3 vDWorld;\nvarying float vDLed;',
        )
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvDPart = aPart;\nvDAo = aAo;\nvDLocal = position;\nvDDis = aDissolve;\nvDLed = aDoorLed;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvDWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>\nvarying float vDPart;\nvarying float vDAo;\nvarying vec3 vDLocal;\nvarying vec4 vDDis;\nvarying vec3 vDWorld;\nvarying float vDLed;\n${GLSL_DIGITAL_DISSOLVE}`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          vec3 dEdge = strandDissolve(vDWorld, vDDis);
          float dp = floor(vDPart + 0.5);
          vec3 dAlb = vec3(0.5);
          float dRough = 0.5;
          float dMetal = 0.5;
          vec3 dEmis = vec3(0.0);
          if (dp < 1.5) {
            // Weathered painted steel (per-door tint): faint vertical run-off streaks + grime above the kickplate.
            float dCol = fract(sin(floor(vDLocal.x * 160.0) * 12.9898) * 43758.5453);
            float dGrime = mix(0.74, 1.0, smoothstep(0.24, 0.85, vDLocal.y)) * (0.97 + 0.03 * dCol);
            dAlb = vColor.rgb * dGrime * (dp > 0.5 ? 0.88 : 1.0);
            dRough = 0.54 + 0.04 * dCol;
            dMetal = 0.55;
            if (dp < 0.5 && vDLocal.y < 0.24) {
              // Flush brushed-stainless kickplate (shader-defined: no overlay, no z-fighting) with a dark top seam.
              float dBr = fract(sin(floor(vDLocal.y * 700.0) * 78.233) * 43758.5453);
              dAlb = vec3(0.54, 0.55, 0.57) * (0.9 + 0.1 * dBr) * (1.0 - 0.7 * smoothstep(0.235, 0.239, vDLocal.y));
              dRough = 0.22 + 0.06 * dBr;
              dMetal = 1.0;
            }
          } else if (dp < 2.5) {
            // Armoured wire glass: dark glass with a 25 mm diamond wire mesh.
            vec2 dq = vDLocal.xy / 0.025;
            float dW = max(abs(fract(dq.x + dq.y) - 0.5), abs(fract(dq.x - dq.y) - 0.5));
            float dWire = smoothstep(0.43, 0.47, dW);
            dAlb = mix(vec3(0.02, 0.03, 0.035), vec3(0.42), dWire);
            dRough = mix(0.06, 0.4, dWire);
            dMetal = mix(0.2, 0.9, dWire);
            dEmis = vec3(0.012, 0.01, 0.008) * (1.0 - dWire);
          } else if (dp < 3.5) {
            dAlb = vec3(0.6, 0.61, 0.63);
            dRough = 0.3;
            dMetal = 0.95;
          } else if (dp < 4.5) {
            dAlb = vec3(0.07, 0.075, 0.08);
            dRough = 0.55;
            dMetal = 0.6;
          } else if (dp < 5.5) {
            // Lock status LED: amber closed / green quietly opened / dark once breached.
            dAlb = vec3(0.05);
            dRough = 0.2;
            dMetal = 0.0;
            dEmis = vDLed < 0.5 ? vec3(1.0, 0.4, 0.03) * 2.0 : (vDLed < 1.5 ? vec3(0.08, 1.0, 0.3) * 1.8 : vec3(0.05, 0.012, 0.006));
          } else {
            dAlb = vec3(0.09, 0.095, 0.1);
            dRough = 0.45;
            dMetal = 0.7;
          }
          diffuseColor.rgb = dAlb * vDAo;`,
        )
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = dRough;')
        .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = dMetal;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance = dEmis + dEdge;');
    };
    dm.customProgramCacheKey = () => 'strand-doors-v1';
    this.doorMesh = new THREE.InstancedMesh(dg, dm, DOOR_CAP);
    this.doorMesh.name = 'InteractiveDoors';
    this.doorMesh.frustumCulled = false;
    this.doorMesh.count = 0;
    this.doorMesh.visible = false;
    this.doorMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.doorMesh.setColorAt(0, _c.setRGB(1, 1, 1));
    scene.add(this.doorMesh);

    // ---- DestructibleGlassPanes ----
    const gg = buildGlassPaneGeometry();
    this.paneAttr = new THREE.InstancedBufferAttribute(new Float32Array(GLASS_CAP * 4), 4);
    gg.setAttribute('aPane', this.paneAttr);
    const gm = new THREE.MeshStandardMaterial({
      color: 0x0a1116,
      roughness: 0.05,
      metalness: 0.0,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    // One pass only (a flat pane never self-overlaps): keeps DestructibleGlassPanes at exactly ONE draw call.
    gm.forceSinglePass = true;
    const B = GLASS_BEZEL_M.toFixed(4);
    const MH = (GLASS_MULLION_M * 0.5).toFixed(4);
    const MW = GLASS_MULLION_MIN_W.toFixed(2);
    const glassApply = /* glsl */ `
      {
        vec3 strandNw = transformNormalByInverseViewMatrix(normal, viewMatrix);
        vec3 strandV = normalize(cameraPosition - vCityWorld);
        #ifndef STRAND_LITE
        outgoingLight += strandCityLights(vCityWorld, strandNw, strandV, diffuseColor.rgb, roughnessFactor, metalnessFactor);
        #endif
        float gFres = pow(1.0 - clamp(abs(dot(strandNw, strandV)), 0.0, 1.0), 3.0);
        float gAlpha = mix(vGPane.z, 0.65, gFres);
        #ifndef STRAND_LITE
        // Rain streaks running down the pane (world metres) with Fresnel glints on the drop heads.
        float gColId = floor(gM.x * 22.0);
        float gH = fract(sin(gColId * 91.17 + vGPane.w * 37.0) * 43758.5453);
        float gFx = fract(gM.x * 22.0);
        float gLine = smoothstep(0.3, 0.5, gFx) * (1.0 - smoothstep(0.5, 0.7, gFx)) * step(0.55, gH);
        float gRun = fract(gM.y * (0.6 + gH) + uGlassTime * (0.35 + 0.6 * gH) + gH * 17.0);
        float gDrop = pow(1.0 - gRun, 8.0);
        float gStreak = gLine * (0.18 + 0.82 * gDrop) * (1.0 - gFrame);
        gAlpha += gStreak * 0.18;
        outgoingLight += vec3(0.55, 0.72, 0.9) * gStreak * (0.05 + 0.6 * gFres + 0.25 * gDrop);
        #endif
        outgoingLight += vec3(0.07, 0.09, 0.12) * gFres * (1.0 - gFrame);
        diffuseColor.a = mix(clamp(gAlpha, 0.0, 1.0), 1.0, gFrame);
      }
      #include <opaque_fragment>
    `;
    gm.onBeforeCompile = (shader) => {
      inject(shader, glassApply);
      shader.uniforms.uGlassTime = this.glassTime;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 aPane;\nvarying vec4 vGPane;\nvarying vec2 vGUv;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGPane = aPane;\nvGUv = uv;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uGlassTime;\nvarying vec4 vGPane;\nvarying vec2 vGUv;')
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
          // Bezel + mullion in METRES from the pane edges (constant width under non-uniform instance scale).
          vec2 gM = vGUv * vGPane.xy;
          float gE = min(min(gM.x, vGPane.x - gM.x), min(gM.y, vGPane.y - gM.y));
          float gD = gE - ${B};
          if (vGPane.x > ${MW}) gD = min(gD, abs(gM.x - 0.5 * vGPane.x) - ${MH});
          float gAA = max(fwidth(gD), 1e-4);
          float gFrame = 1.0 - smoothstep(-gAA, gAA, gD);
          float gLip = (1.0 - smoothstep(0.0, max(0.005, gAA * 1.5), abs(gD + 0.004))) * gFrame;
          float gOut = smoothstep(0.012, 0.0, gE) * gFrame;
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.045, 0.05, 0.058) * (1.0 + 2.6 * gLip) * (1.0 - 0.45 * gOut), gFrame);`,
        )
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(0.05, 0.38, gFrame);')
        .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix(0.0, 0.85, gFrame);');
    };
    gm.customProgramCacheKey = () => 'strand-glass-v1';
    this.glassMat = gm;
    this.glassMesh = new THREE.InstancedMesh(gg, gm, GLASS_CAP);
    this.glassMesh.name = 'DestructibleGlassPanes';
    this.glassMesh.frustumCulled = false;
    this.glassMesh.renderOrder = 4;
    this.glassMesh.count = 0;
    this.glassMesh.visible = false;
    scene.add(this.glassMesh);
  }

  // ===============================================================================================
  // Level
  // ===============================================================================================
  /**
   * Per-sector reset (call AFTER `physics.setLayout(layout)`; `colliders` = `layout.colliders`). Rebuilds the
   * collider → object lookup once, re-enables every door / glass collider (retry-safe), resets all state, clears
   * the shared debris pool and uploads both instance buffers. Doors beyond 32 / panes beyond 48 are ignored.
   */
  setLevel(physics: PhysicsWorld, colliders: readonly BoxCollider[], doors: readonly DoorSpec[], glass: readonly GlassSpec[]): void {
    this.physics = physics;
    this.colliders = colliders;
    this.doors = doors;
    this.glass = glass;
    this.doorN = Math.min(doors.length, DOOR_CAP);
    this.glassN = Math.min(glass.length, GLASS_CAP);
    this.lookup.clear();
    this.animating = 0;
    this.effects.debris.clear();
    for (let i = 0; i < this.doorN; i++) {
      const d = doors[i];
      const c = colliders[d.colliderIndex];
      if (c) {
        this.lookup.set(c, i);
        physics.setColliderActive(d.colliderIndex, true);
      }
      this.dState[i] = S_CLOSED;
      this.dHits[i] = 0;
      this.dPhase[i] = 0;
      this.dT[i] = 0;
      this.dSeed[i] = rand();
      this.writeDoorPose(i, 0);
      this.doorMesh.setColorAt(i, _c.setHex(d.tint));
      this.doorDis.setXYZW(i, 0, 0, this.dSeed[i], 0);
      this.doorLed.setX(i, 0);
    }
    for (let j = 0; j < this.glassN; j++) {
      const p = glass[j];
      const c = colliders[p.colliderIndex];
      if (c) {
        this.lookup.set(c, GLASS_ID + j);
        physics.setColliderActive(p.colliderIndex, true);
      }
      this.gBroken[j] = 0;
      _q.setFromAxisAngle(Y_AXIS, p.yaw);
      _m.compose(_p.set(p.x, p.y, p.z), _q, _s.set(p.width, p.height, 1));
      this.glassMesh.setMatrixAt(j, _m);
      const seed = rand();
      this.paneAttr.setXYZW(j, p.width, p.height, 0.18 + 0.14 * seed, rand());
    }
    this.doorMesh.count = this.doorN;
    this.doorMesh.visible = this.doorN > 0;
    this.glassMesh.count = this.glassN;
    this.glassMesh.visible = this.glassN > 0;
    this.doorMesh.instanceMatrix.needsUpdate = true;
    if (this.doorMesh.instanceColor) this.doorMesh.instanceColor.needsUpdate = true;
    this.doorDis.needsUpdate = true;
    this.doorLed.needsUpdate = true;
    this.glassMesh.instanceMatrix.needsUpdate = true;
    this.paneAttr.needsUpdate = true;
  }

  /** LOW quality: the glass skips the per-fragment city-light loop and the rain streaks (STRAND_LITE). */
  setQuality(preset: 'HIGH' | 'MEDIUM' | 'LOW'): void {
    const lite = preset === 'LOW';
    const defs = (this.glassMat.defines ??= {}) as Record<string, string>;
    if (lite !== 'STRAND_LITE' in defs) {
      if (lite) defs.STRAND_LITE = '';
      else delete defs.STRAND_LITE;
      this.glassMat.needsUpdate = true;
    }
  }

  // ===============================================================================================
  // Accessors (tests / HUD)
  // ===============================================================================================
  get doorCount(): number {
    return this.doorN;
  }
  get glassCount(): number {
    return this.glassN;
  }
  doorState(i: number): DoorState {
    return STATE_NAMES[this.dState[i]] ?? 'GONE';
  }
  glassBroken(i: number): boolean {
    return this.gBroken[i] === 1;
  }
  doorSpec(i: number): DoorSpec | undefined {
    return i >= 0 && i < this.doorN ? this.doors[i] : undefined;
  }
  glassSpec(i: number): GlassSpec | undefined {
    return i >= 0 && i < this.glassN ? this.glass[i] : undefined;
  }
  /** Doorway centre at mid height (world) → `out`. */
  doorCenter(i: number, out: THREE.Vector3): THREE.Vector3 {
    const d = this.doors[i];
    return out.set(d.x, d.y + d.height * 0.5, d.z);
  }
  /** Unit inward direction (world local −Z) → `out`. */
  doorInward(i: number, out: THREE.Vector3): THREE.Vector3 {
    const yaw = this.doors[i].yaw;
    return out.set(-Math.sin(yaw), 0, -Math.cos(yaw));
  }

  // ===============================================================================================
  // Queries
  // ===============================================================================================
  /**
   * Closest CLOSED door whose leaf rectangle lies within `maxDist` of `pos` and whose direction from `pos` has
   * dot ≥ `minDot` with the view forward `fwd` (−1 when none). Zero allocation.
   */
  nearestDoor(pos: THREE.Vector3, fwd: THREE.Vector3, maxDist = 2.2, minDot = 0.55): number {
    const fl = Math.sqrt(fwd.x * fwd.x + fwd.y * fwd.y + fwd.z * fwd.z) || 1;
    let best = -1;
    let bestScore = Infinity;
    for (let i = 0; i < this.doorN; i++) {
      if (this.dState[i] !== S_CLOSED) continue;
      const d = this.doors[i];
      const ax = Math.cos(d.yaw);
      const az = -Math.sin(d.yaw);
      const rx = pos.x - d.x;
      const rz = pos.z - d.z;
      const hw = d.width * 0.5;
      const u = Math.max(-hw, Math.min(hw, rx * ax + rz * az));
      const v = Math.max(0, Math.min(d.height, pos.y - d.y));
      const tx = d.x + ax * u - pos.x;
      const ty = d.y + v - pos.y;
      const tz = d.z + az * u - pos.z;
      const dist = Math.sqrt(tx * tx + ty * ty + tz * tz);
      if (dist > maxDist) continue;
      const dot = dist < 1e-4 ? 1 : (tx * fwd.x + ty * fwd.y + tz * fwd.z) / (dist * fl);
      if (dot < minDot) continue;
      const score = dist - dot * 0.5;
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return best;
  }

  // ===============================================================================================
  // Actions
  // ===============================================================================================
  /**
   * Breach kick / ballistic / sprint impact on a CLOSED door: collider off (O(1)), slab rockets away from the
   * breacher (inward when `dir` points inward, outward when kicked from inside) at 11 m/s + 1.8 m/s lift with a
   * forward tumble, + 6 steel / splinter debris chunks, then `onDoorBreach`.
   */
  breachDoor(i: number, dir: THREE.Vector3): void {
    if (i < 0 || i >= this.doorN || this.dState[i] !== S_CLOSED) return;
    const d = this.doors[i];
    if (this.physics && d.colliderIndex >= 0) this.physics.setColliderActive(d.colliderIndex, false);
    this.dState[i] = S_BREACHED;
    this.dPhase[i] = 0;
    this.dT[i] = 0;
    this.dFloor[i] = this.doors[i].y;
    this.dProbeT[i] = 0;
    this.dFlight[i] = 0;
    this.animating++;
    const yaw = d.yaw;
    const ax = Math.cos(yaw), az = -Math.sin(yaw);
    let fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    if (dir.x * fx + dir.z * fz < 0) {
      fx = -fx;
      fz = -fz;
    }
    const o = i * 3;
    this.dPos[o] = d.x;
    this.dPos[o + 1] = d.y + d.height * 0.5;
    this.dPos[o + 2] = d.z;
    const lat = (rand() - 0.5) * 1.2;
    this.dVel[o] = fx * DOOR_BREACH.SPEED + ax * lat;
    this.dVel[o + 1] = DOOR_BREACH.LIFT;
    this.dVel[o + 2] = fz * DOOR_BREACH.SPEED + az * lat;
    // Tumble: top falls forward along the flight (ω = up × f) + a little yaw spin and roll.
    const tumble = 3.6 + rand() * 1.4;
    const spin = (rand() - 0.5) * 3.0;
    const roll = (rand() - 0.5) * 2.0;
    this.dAng[o] = fz * tumble + fx * roll;
    this.dAng[o + 1] = spin;
    this.dAng[o + 2] = -fx * tumble + fz * roll;
    _q.setFromAxisAngle(Y_AXIS, yaw);
    const r = i * 4;
    this.dRot[r] = _q.x;
    this.dRot[r + 1] = _q.y;
    this.dRot[r + 2] = _q.z;
    this.dRot[r + 3] = _q.w;
    this.doorLed.setX(i, 2);
    this.doorLed.needsUpdate = true;
    // 6 steel hinge knuckles / latch splinters.
    const debris = this.effects.debris;
    const sy = d.height / DOOR_DIMS.h;
    for (let k = 0; k < DOOR_BREACH.DEBRIS; k++) {
      const hinge = k < 3;
      const lx = hinge ? -d.width * 0.5 + 0.02 : d.width * 0.5 - 0.04;
      const ly = (hinge ? 0.28 + k * 0.8 : 0.96 + (k - 3) * 0.07) * sy;
      const sp = 3 + rand() * 4;
      const sl = (rand() - 0.5) * 3;
      debris.spawn(
        d.x + ax * lx,
        d.y + ly,
        d.z + az * lx,
        fx * sp + ax * sl,
        0.5 + rand() * 2,
        fz * sp + az * sl,
        hinge ? 0.05 : 0.14,
        hinge ? 0.03 : 0.022,
        hinge ? 0.11 : 0.04,
        hinge ? 0x7a828c : 0x5d646d,
        false,
        d.y,
      );
    }
    if (this.onDoorBreach) {
      _hookPos.set(d.x, d.y + d.height * 0.5, d.z);
      _hookDir.set(fx, 0, fz);
      this.onDoorBreach(i, _hookPos, _hookDir);
    }
  }

  /** Silent crouch open of a CLOSED door: collider off (O(1)), LED green, 105° inward swing over 0.38 s. */
  openDoorQuietly(i: number): void {
    if (i < 0 || i >= this.doorN || this.dState[i] !== S_CLOSED) return;
    const d = this.doors[i];
    if (this.physics && d.colliderIndex >= 0) this.physics.setColliderActive(d.colliderIndex, false);
    this.dState[i] = S_OPENING;
    this.dT[i] = 0;
    this.animating++;
    this.doorLed.setX(i, 1);
    this.doorLed.needsUpdate = true;
    if (this.onDoorQuietOpen) {
      _hookPos.set(d.x, d.y + d.height * 0.5, d.z);
      this.onDoorQuietOpen(i, _hookPos);
    }
  }

  /**
   * Shatters an intact pane: collider off (O(1)), instance hidden (zero matrix), 22–30 glittering shards into the
   * shared debris pool (mostly along `dir`, some blown back), then `onGlassShatter`. Zero allocation.
   */
  shatterGlass(i: number, hitPos: THREE.Vector3, dir: THREE.Vector3): void {
    if (i < 0 || i >= this.glassN || this.gBroken[i]) return;
    const p = this.glass[i];
    this.gBroken[i] = 1;
    if (this.physics && p.colliderIndex >= 0) this.physics.setColliderActive(p.colliderIndex, false);
    this.glassMesh.setMatrixAt(i, _zeroMat);
    this.glassMesh.instanceMatrix.needsUpdate = true;
    const ax = Math.cos(p.yaw), az = -Math.sin(p.yaw);
    const nx = Math.sin(p.yaw), nz = Math.cos(p.yaw);
    _dirN.copy(dir);
    const dl = _dirN.length();
    if (dl > 1e-6) _dirN.divideScalar(dl);
    else _dirN.set(-nx, 0, -nz);
    const side = _dirN.x * nx + _dirN.z * nz >= 0 ? 1 : -1;
    const floorFwd = this.probeFloor(p, side * 0.75);
    // A gallery deck / ledge in front with a drop beyond it: forward shards stay slow enough to land on it.
    const ledgeFwd = floorFwd - this.probeFloor(p, side * 2.6) > 0.8;
    const floorBack = this.probeFloor(p, -side * 0.75);
    const hu = Math.max(-p.width * 0.5, Math.min(p.width * 0.5, (hitPos.x - p.x) * ax + (hitPos.z - p.z) * az));
    const hv = Math.max(0, Math.min(p.height, hitPos.y - p.y));
    const base = Math.max(0.06, Math.min(0.2, Math.sqrt(p.width * p.height) / 11));
    // Flight direction of the forward spray: blend of the hit direction and the pane normal on that side.
    _w.set(_dirN.x * 0.55 + nx * side * 0.45, _dirN.y * 0.55, _dirN.z * 0.55 + nz * side * 0.45);
    if (_w.lengthSq() < 1e-6) _w.set(nx * side, 0, nz * side);
    _w.normalize();
    const n = GLASS_SHARDS.MIN + Math.floor(rand() * (GLASS_SHARDS.MAX - GLASS_SHARDS.MIN + 1));
    const debris = this.effects.debris;
    for (let k = 0; k < n; k++) {
      const near = rand() < 0.35;
      const u = Math.max(-p.width * 0.5, Math.min(p.width * 0.5, near ? hu + (rand() - 0.5) * 0.5 : (rand() - 0.5) * p.width));
      const v = Math.max(0.02, Math.min(p.height, near ? hv + (rand() - 0.5) * 0.5 : rand() * p.height));
      const back = rand() < 0.16;
      const px = p.x + ax * u + nx * side * (back ? -0.02 : 0.02);
      const py = p.y + v;
      const pz = p.z + az * u + nz * side * (back ? -0.02 : 0.02);
      // Radial burst away from the impact point (in the pane plane).
      const ru = u - hu;
      const rv = v - hv;
      const rl = Math.sqrt(ru * ru + rv * rv) || 1;
      const rk = 1.2 * rand() / rl;
      const sp = back ? 1 + rand() * 1.6 : ledgeFwd ? 0.8 + rand() * 1.6 : 3 + rand() * 6;
      let vx: number, vy: number, vz: number;
      if (back) {
        vx = -nx * side * sp;
        vy = 0;
        vz = -nz * side * sp;
      } else {
        vx = _w.x * sp;
        vy = _w.y * sp;
        vz = _w.z * sp;
      }
      const lat = (rand() - 0.5) * 2;
      vx += ax * (ru * rk + lat);
      vz += az * (ru * rk + lat);
      vy += rv * rk + 0.4 + rand() * 2.2;
      // 11A audit fix: every shard gets its own floor — one wall ray caps its horizontal flight (never through the
      // room's back wall), one downward ray at its predicted landing spot (deck edge / street / towpath).
      const fy0 = back ? floorBack : floorFwd;
      const tf = (vy + Math.sqrt(vy * vy + 44 * Math.max(0, py - fy0))) / 22;
      const hsp = Math.sqrt(vx * vx + vz * vz);
      let reach = hsp * tf;
      if (this.physics && hsp > 0.05) {
        _sa.set(px, py, pz);
        _v.set(vx / hsp, 0, vz / hsp);
        this.physics.raycast(_sa, _v, reach + 0.3, _ray, SLAB_PROBE_IGNORE);
        if (_ray.hit && _ray.distance - 0.25 < reach) {
          const k = Math.max(0, _ray.distance - 0.25) / Math.max(reach, 1e-3);
          vx *= k;
          vz *= k;
          reach *= k;
        }
      }
      let shardFloor = fy0;
      if (this.physics) {
        // Two passes: a shard dropping onto a higher surface (counter, rail, deck) lands sooner / shorter.
        let f = fy0;
        for (let pass = 0; pass < 2; pass++) {
          const t2 = (vy + Math.sqrt(vy * vy + 44 * Math.max(0, py - f))) / 22;
          const rr = Math.min(reach, hsp * t2);
          const lx = hsp > 1e-3 ? px + (vx / hsp) * rr : px;
          const lz = hsp > 1e-3 ? pz + (vz / hsp) * rr : pz;
          _sb.set(lx, py + 0.3, lz);
          this.physics.raycast(_sb, DOWN, 80, _ray, FLOOR_PROBE_IGNORE);
          const nf = _ray.hit ? _ray.point.y : py - 60;
          if (pass === 1 && nf < f - 0.2) {
            // Short of the higher surface (counter / deck face): land on the lower floor at exactly this probed spot.
            const t3 = (vy + Math.sqrt(vy * vy + 44 * Math.max(0, py - nf))) / 22;
            const k = hsp > 1e-3 ? rr / Math.max(hsp * t3, 1e-3) : 1;
            vx *= k;
            vz *= k;
            f = nf;
            break;
          }
          f = nf;
          if (pass === 1) {
            // Range at this floor equals the probed spot.
            const k = hsp > 1e-3 ? rr / Math.max(hsp * t2, 1e-3) : 1;
            vx *= k;
            vz *= k;
          }
        }
        shardFloor = f;
      }
      debris.spawn(
        px,
        py,
        pz,
        vx,
        vy,
        vz,
        base * (0.6 + rand() * 0.9),
        0.008 + rand() * 0.008,
        base * (0.5 + rand() * 0.8),
        GLASS_COLORS[k & 3],
        true,
        shardFloor,
      );
    }
    if (this.onGlassShatter) {
      _hookPos.copy(hitPos);
      this.onGlassShatter(i, _hookPos);
    }
  }

  /**
   * Pre-movement crash probe (call BEFORE `physics.movePlayer()`): the player box (feet `pos`, radius, height) swept
   * along `delta` shatters every intact pane (and, when `breakDoors`, breaches every CLOSED door) whose collider AABB
   * it touches (+5 cm reach), so momentum is preserved. Returns the number of objects broken. Zero allocation.
   */
  crashThrough(pos: THREE.Vector3, delta: THREE.Vector3, radius: number, height: number, breakDoors: boolean): number {
    const M = 0.05;
    const x0 = Math.min(pos.x, pos.x + delta.x) - radius - M;
    const x1 = Math.max(pos.x, pos.x + delta.x) + radius + M;
    const y0 = Math.min(pos.y, pos.y + delta.y);
    const y1 = Math.max(pos.y, pos.y + delta.y) + height;
    const z0 = Math.min(pos.z, pos.z + delta.z) - radius - M;
    const z1 = Math.max(pos.z, pos.z + delta.z) + radius + M;
    let broken = 0;
    for (let j = 0; j < this.glassN; j++) {
      if (this.gBroken[j]) continue;
      const c = this.colliders[this.glass[j].colliderIndex];
      if (!c || c.active === false) continue;
      if (c.max.x < x0 || c.min.x > x1 || c.max.y < y0 || c.min.y > y1 || c.max.z < z0 || c.min.z > z1) continue;
      _sa.set(
        Math.max(c.min.x, Math.min(c.max.x, pos.x)),
        Math.max(c.min.y, Math.min(c.max.y, pos.y + height * 0.55)),
        Math.max(c.min.z, Math.min(c.max.z, pos.z)),
      );
      this.shatterGlass(j, _sa, delta);
      broken++;
    }
    if (breakDoors) {
      for (let i = 0; i < this.doorN; i++) {
        if (this.dState[i] !== S_CLOSED) continue;
        const c = this.colliders[this.doors[i].colliderIndex];
        if (!c || c.active === false) continue;
        if (c.max.x < x0 || c.min.x > x1 || c.max.y < y0 || c.min.y > y1 || c.max.z < z0 || c.min.z > z1) continue;
        this.breachDoor(i, delta);
        broken++;
      }
    }
    return broken;
  }

  /**
   * ProjectileBreakables: GLASS → shatter, true (round passes with full damage, enemy rounds too). DOOR → player
   * rounds only: sniper breaches in 1 hit, any other round in 2; always false (round stops, never scorched).
   */
  onProjectileHit(collider: BoxCollider, point: THREE.Vector3, dir: THREE.Vector3, _damage: number, sniper: boolean, owner: ProjectileOwner): boolean {
    const id = this.lookup.get(collider);
    if (id === undefined) return false;
    if (id >= GLASS_ID) {
      this.shatterGlass(id - GLASS_ID, point, dir);
      return true;
    }
    if (owner !== 'PLAYER' || this.dState[id] !== S_CLOSED) return false;
    this.dHits[id]++;
    if (sniper || this.dHits[id] >= 2) this.breachDoor(id, dir);
    return false;
  }

  // ===============================================================================================
  // Per-frame
  // ===============================================================================================
  /** Animates quiet-open swings and breached slabs (simDt, Bullet-Time compatible). Zero allocation. */
  update(simDt: number, camPos: THREE.Vector3): void {
    this.glassTime.value += simDt;
    if (this.glassTime.value > 3600) this.glassTime.value -= 3600;
    if (this.animating === 0 || simDt <= 0) return;
    let disDirty = false;
    for (let i = 0; i < this.doorN; i++) {
      const st = this.dState[i];
      if (st === S_OPENING) {
        this.dT[i] += simDt;
        const k = Math.min(1, this.dT[i] / DOOR_OPEN_S);
        const e = 1 - (1 - k) * (1 - k) * (1 - k);
        this.writeDoorPose(i, e * (this.doors[i].openRad ?? DOOR_OPEN_RAD));
        if (k >= 1) {
          this.dState[i] = S_OPEN;
          this.animating--;
        }
      } else if (st === S_BREACHED) {
        if (this.stepSlab(i, simDt, camPos)) disDirty = true;
      }
    }
    this.doorMesh.instanceMatrix.needsUpdate = true;
    if (disDirty) this.doorDis.needsUpdate = true;
  }

  // ===============================================================================================
  // Internals
  // ===============================================================================================
  /** Closed / swinging pose: rotation about the hinge axis (local x = −w/2, z = DOOR_HINGE_Z) by `angle` (inward). */
  private writeDoorPose(i: number, angle: number): void {
    const d = this.doors[i];
    const hx = -d.width * 0.5;
    const hz = DOOR_HINGE_Z;
    const ca = Math.cos(angle), sa = Math.sin(angle);
    const dx = hx - (hx * ca + hz * sa);
    const dz = hz - (-hx * sa + hz * ca);
    const cy = Math.cos(d.yaw), sy = Math.sin(d.yaw);
    _p.set(d.x + dx * cy + dz * sy, d.y, d.z - dx * sy + dz * cy);
    _q.setFromAxisAngle(Y_AXIS, d.yaw + angle);
    _m.compose(_p, _q, _s.set(d.width / DOOR_DIMS.w, d.height / DOOR_DIMS.h, 1));
    this.doorMesh.setMatrixAt(i, _m);
  }

  /** Floor height 0.75 m in front of (`off` > 0) or behind a pane (one downward ray at shatter time, not per frame). */
  private probeFloor(p: GlassSpec, off: number): number {
    if (!this.physics) return p.y;
    _sb.set(p.x + Math.sin(p.yaw) * off, p.y + 0.35, p.z + Math.cos(p.yaw) * off);
    this.physics.raycast(_sb, DOWN, 60, _ray, FLOOR_PROBE_IGNORE);
    return _ray.hit ? _ray.point.y : p.y - 60;
  }

  /**
   * 11A audit fix: a slab coming to rest lying flat reaches ~1.1 m past its centre along the leaf's long axis (and
   * ~0.5 m across): cast both ways along both leaf axes just above the floor and slide it back out of any wall,
   * counter or bed it would otherwise rest inside. Runs once per slab (rest transition), zero allocations.
   */
  private clearSlab(i: number, o: number, sx: number, sy: number, halfH: number, fy: number): void {
    if (!this.physics) return;
    const r = i * 4;
    _q.set(this.dRot[r], this.dRot[r + 1], this.dRot[r + 2], this.dRot[r + 3]);
    for (let axis = 0; axis < 2; axis++) {
      if (axis === 0) _v.set(0, 1, 0).applyQuaternion(_q);
      else _v.set(1, 0, 0).applyQuaternion(_q);
      _v.y = 0;
      const l = _v.length();
      if (l < 0.2) continue;
      _v.divideScalar(l);
      const ext = (axis === 0 ? halfH * sy : DOOR_DIMS.w * 0.5 * sx) * l + 0.06;
      for (let k = 0; k < 2; k++) {
        const sgn = 1 - 2 * k;
        _sa.set(this.dPos[o], fy + 0.12, this.dPos[o + 2]);
        _sb.copy(_sa).addScaledVector(_v, sgn * ext);
        this.physics.segmentCast(_sa, _sb, _wallRay, SLAB_PROBE_IGNORE);
        if (_wallRay.hit && Math.abs(_wallRay.normal.y) < 0.5) {
          const push = ext - _wallRay.distance;
          this.dPos[o] -= _v.x * sgn * push;
          this.dPos[o + 2] -= _v.z * sgn * push;
        }
      }
    }
  }

  /** One breached-slab step. Returns true when its dissolve attribute changed. */
  private stepSlab(i: number, dt: number, camPos: THREE.Vector3): boolean {
    const d = this.doors[i];
    const o = i * 3;
    const r = i * 4;
    const sx = d.width / DOOR_DIMS.w;
    const sy = d.height / DOOR_DIMS.h;
    const halfH = d.height * 0.5;
    this.dT[i] += dt;
    this.dFlight[i] += dt;
    let disDirty = false;
    if (this.dPhase[i] === 2) {
      const prog = this.dT[i] / DOOR_BREACH.DISSOLVE_S;
      if (prog >= 1) {
        this.dState[i] = S_GONE;
        this.animating--;
        this.doorMesh.setMatrixAt(i, _zeroMat);
        return false;
      }
      this.doorDis.setX(i, prog);
      disDirty = true;
    } else if (this.dPhase[i] === 1 && this.dT[i] >= DOOR_BREACH.REST_S) {
      this.dPhase[i] = 2;
      this.dT[i] = 0;
      // Second clearance pass once the settle has fully flattened the leaf.
      this.clearSlab(i, o, sx, sy, halfH, this.dFloor[i]);
    }
    _q.set(this.dRot[r], this.dRot[r + 1], this.dRot[r + 2], this.dRot[r + 3]);
    // Integrate.
    _sa.set(this.dPos[o], this.dPos[o + 1], this.dPos[o + 2]);
    this.dVel[o + 1] += DOOR_BREACH.GRAVITY * dt;
    this.dPos[o] += this.dVel[o] * dt;
    this.dPos[o + 1] += this.dVel[o + 1] * dt;
    this.dPos[o + 2] += this.dVel[o + 2] * dt;
    const wx = this.dAng[o], wy = this.dAng[o + 1], wz = this.dAng[o + 2];
    const w = Math.sqrt(wx * wx + wy * wy + wz * wz);
    if (w > 1e-5) {
      _v.set(wx / w, wy / w, wz / w);
      _q2.setFromAxisAngle(_v, w * dt);
      _q.premultiply(_q2).normalize();
    }
    // Interior walls: one segment cast per moving slab (centre path + 0.12 m margin); floors / ceilings ignored.
    const hs = Math.sqrt(this.dVel[o] * this.dVel[o] + this.dVel[o + 2] * this.dVel[o + 2]);
    const cdx = camPos.x - this.dPos[o], cdz = camPos.z - this.dPos[o + 2];
    if (this.physics && hs > 0.3 && cdx * cdx + cdz * cdz < 52 * 52) {
      const ux = this.dVel[o] / hs, uz = this.dVel[o + 2] / hs;
      _sb.set(this.dPos[o] + ux * 0.12, this.dPos[o + 1], this.dPos[o + 2] + uz * 0.12);
      _sa.y = this.dPos[o + 1];
      this.physics.segmentCast(_sa, _sb, _wallRay);
      if (_wallRay.hit && Math.abs(_wallRay.normal.y) < 0.5 && _wallRay.collider) {
        const gid = this.lookup.get(_wallRay.collider);
        if (gid !== undefined && gid >= GLASS_ID) {
          _v.set(ux, 0, uz);
          this.shatterGlass(gid - GLASS_ID, _wallRay.point, _v);
        } else {
          const back = Math.max(0, _wallRay.distance - 0.12);
          this.dPos[o] = _sa.x + ux * back;
          this.dPos[o + 2] = _sa.z + uz * back;
          const n = _wallRay.normal;
          const vn = this.dVel[o] * n.x + this.dVel[o + 2] * n.z;
          if (vn < 0) {
            this.dVel[o] -= 1.3 * vn * n.x;
            this.dVel[o + 2] -= 1.3 * vn * n.z;
          }
          this.dVel[o] *= 0.6;
          this.dVel[o + 2] *= 0.6;
          this.dAng[o] *= 0.6;
          this.dAng[o + 1] *= 0.6;
          this.dAng[o + 2] *= 0.6;
        }
      }
    }
    // Floor contact on the exact support points (leaf corners + lever + crash-bar housings).
    const low = this.slabLowest(sx, sy, halfH);
    // 11A audit fix: the slab lands on whatever is really under its path (street below a gallery railing, a
    // counter top inside the room) — one downward ray every 0.1 s while it moves, never per frame.
    this.dProbeT[i] -= dt;
    if (this.physics && this.dProbeT[i] <= 0) {
      this.dProbeT[i] = 0.1;
      _sb.set(this.dPos[o], this.dPos[o + 1] + 0.3, this.dPos[o + 2]);
      this.physics.raycast(_sb, DOWN, 80, _ray, SLAB_PROBE_IGNORE);
      this.dFloor[i] = _ray.hit ? _ray.point.y : d.y - 80;
    }
    const fy = this.dFloor[i];
    let grounded = false;
    if (this.dPos[o + 1] + low <= fy) {
      this.dPos[o + 1] = fy - low;
      grounded = true;
      if (this.dVel[o + 1] < -0.8) {
        this.dVel[o + 1] = -this.dVel[o + 1] * 0.3;
        if (this.dVel[o + 1] < 0.6) this.dVel[o + 1] = 0;
        this.dVel[o] *= 0.55;
        this.dVel[o + 2] *= 0.55;
        this.dAng[o] *= 0.5;
        this.dAng[o + 1] *= 0.5;
        this.dAng[o + 2] *= 0.5;
      } else if (this.dVel[o + 1] < 0) this.dVel[o + 1] = 0;
    }
    if (grounded) {
      const fk = Math.exp(-6 * dt);
      this.dVel[o] *= fk;
      this.dVel[o + 2] *= fk;
      const sp = Math.sqrt(this.dVel[o] * this.dVel[o] + this.dVel[o + 1] * this.dVel[o + 1] + this.dVel[o + 2] * this.dVel[o + 2]);
      if (sp < 3) {
        // Settle flat (yaw kept), propped on its hardware: inner face down rests on the crash bar (tilt about local
        // X, bottom edge down); outer face down rests on the lever (tilt about local Y, hinge edge down).
        const qx = _q.x, qy = _q.y, qz = _q.z, qw = _q.w;
        const r00 = 1 - 2 * (qy * qy + qz * qz);
        const r20 = 2 * (qx * qz - qw * qy);
        const r12 = 2 * (qy * qz - qw * qx);
        _q3.setFromAxisAngle(Y_AXIS, Math.atan2(-r20, r00));
        if (r12 >= 0) {
          _q2.setFromAxisAngle(X_AXIS, -Math.PI / 2 + Math.atan2(0.095, 1.02 * sy));
          _q3.multiply(_q2);
        } else {
          _q2.setFromAxisAngle(X_AXIS, Math.PI / 2);
          _q3.multiply(_q2);
          _q2.setFromAxisAngle(Y_AXIS, Math.atan2(0.07, 0.922 * sx));
          _q3.multiply(_q2);
        }
        _q.slerp(_q3, 1 - Math.exp(-9 * dt));
        const ak = Math.exp(-7 * dt);
        this.dAng[o] *= ak;
        this.dAng[o + 1] *= ak;
        this.dAng[o + 2] *= ak;
        // Re-seat on the floor after the settle rotation (never buried).
        const low2 = this.slabLowest(sx, sy, halfH);
        if (this.dPos[o + 1] + low2 < fy) this.dPos[o + 1] = fy - low2;
      }
      if (this.dPhase[i] === 0 && sp < 0.25) {
        this.dPhase[i] = 1;
        this.dT[i] = 0;
        this.clearSlab(i, o, sx, sy, halfH, fy);
      }
    }
    if (this.dPhase[i] === 0 && this.dFlight[i] >= DOOR_BREACH.MAX_FLIGHT_S) {
      this.dPhase[i] = 1;
      this.dT[i] = 0;
    }
    this.dRot[r] = _q.x;
    this.dRot[r + 1] = _q.y;
    this.dRot[r + 2] = _q.z;
    this.dRot[r + 3] = _q.w;
    // Instance pose: COM − q·(0, h/2, 0), scaled leaf.
    _v.set(0, halfH, 0).applyQuaternion(_q);
    _p.set(this.dPos[o] - _v.x, this.dPos[o + 1] - _v.y, this.dPos[o + 2] - _v.z);
    _m.compose(_p, _q, _s.set(sx, sy, 1));
    this.doorMesh.setMatrixAt(i, _m);
    return disDirty;
  }

  /** Lowest support-point offset (world y relative to the COM) of the slab at orientation `_q`. */
  private slabLowest(sx: number, sy: number, halfH: number): number {
    const qx = _q.x, qy = _q.y, qz = _q.z, qw = _q.w;
    const r10 = 2 * (qx * qy + qw * qz);
    const r11 = 1 - 2 * (qx * qx + qz * qz);
    const r12 = 2 * (qy * qz - qw * qx);
    let low = Infinity;
    for (let k = 0; k < SLAB_SUPPORT.length; k++) {
      const s = SLAB_SUPPORT[k];
      const y = r10 * s[0] * sx + r11 * (s[1] * sy - halfH) + r12 * s[2];
      if (y < low) low = y;
    }
    return low;
  }
}
