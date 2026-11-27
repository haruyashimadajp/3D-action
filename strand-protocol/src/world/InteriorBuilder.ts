/**
 * STRAND // PROTOCOL — Phase 11A-1 / 11A-1b / 11A-1c real enterable interiors (PHASE11_INTERIORS_DESTRUCTION_PLAN.md).
 *
 * Pure, deterministic planning (no CityBuilder import, unit-testable in node) that the CityBuilder converts into its
 * existing static buckets (+0 static draw calls) and colliders:
 *  - 11A-1   `planInteriors`: 6–10 hollow rooms per district (4–6 around the Sector 5 plaza) in four templates —
 *            EATERY / TECH_SHOP / PASS_ARCADE (1F) and APARTMENT (GALLERY_DANCHI 2F–3F) — with exact door / window /
 *            archway openings on the host box face planes, the room envelope (slab, soffit, recessed light troughs,
 *            0.30 m perimeter walls split around every opening, dark-steel jambs) and template dressing, plus
 *            `splitMassBox` (dual split of the tower body + BUILDING collider around the carved volume).
 *  - 11A-1b  `planSkyNotch` (mid-tower refuge notch on the floor grid), `revealFinPieces` (deep window reveals /
 *            sun-breaker fins) and `bayPodPieces` (cantilevered bay-window / HVAC pods).
 *  - 11A-1c  `InteriorPropsKit`: one persistent InstancedMesh (cap 260, +1 draw call) packing the 8 close-up hero
 *            interior props of HERO_3D_MODELING_SPEC §4 (≤ 360 tris each, |min.y| ≤ 0.02, 64 m vertex cull).
 *
 * Conventions
 *  - World: right-handed Y-up. A face (`ax`, `sg`, `plane`) is the wall plane `x = plane` (ax 'x') or `z = plane`
 *    (ax 'z') with outward normal sign `sg`; its along coordinate `a` is z for ax 'x' and x for ax 'z'.
 *  - Prop yaw rotates the prop's local +Z (its front) about +Y exactly like `THREE.Object3D.rotation.y`:
 *    local +Z → world (sin yaw, 0, cos yaw).
 *  - ShellPiece: axis-aligned world box for one static bucket. `ao` = uniform baked aAo multiplier (AoOpts.all);
 *    archPaint uses `color` (sRGB hex); strips use `color` (emissive hex) × `emissive` (0.85–1.15).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { faceKeyOf, floorTopY, groundBayGrid, isMegaKind, GRAMMAR, type Axis, type GroundProgram, type MassBox, type MassingKind, type Rect } from './BuildingGrammar';
import type { Aabb3 } from './CityProps';
import type { CityLightInjector } from './CityAtmosphere';
import { box, cyl, plane, rod } from './CityVehicles';

// =============================================================================================
// Public types
// =============================================================================================
export type InteriorTemplate = 'EATERY' | 'TECH_SHOP' | 'PASS_ARCADE' | 'APARTMENT';
export const INTERIOR_TEMPLATES: readonly InteriorTemplate[] = ['EATERY', 'TECH_SHOP', 'PASS_ARCADE', 'APARTMENT'];

export interface InteriorVolume {
  readonly id: number;
  readonly building: number;
  readonly template: InteriorTemplate;
  readonly aabb: Aabb3;
  readonly floorY: number;
  readonly entryPoints: readonly THREE.Vector3[];
  readonly doorIds: readonly number[];
  readonly glassIds: readonly number[];
}

export interface InteriorPropRecord {
  readonly instIndex: number;
  readonly variant: number;
  readonly worldPos: THREE.Vector3;
  readonly halfExtents: THREE.Vector3;
  readonly floorY: number;
  readonly tint: number;
  readonly destructible: boolean;
}

/** One candidate ground face handed in by the lead (lot / courtyard face of a building, y0 == 0). */
export interface InteriorHostFace {
  readonly id: number;
  readonly ax: Axis;
  readonly sg: 1 | -1;
  readonly plane: number;
  readonly a0: number;
  readonly a1: number;
  readonly y1: number;
  readonly program: GroundProgram;
  readonly alley: boolean;
  readonly run: boolean;
  /** clear street/alley depth in front of the face (m) */
  readonly clear: number;
  /** Optional along ranges no opening may touch (fire-escape flights, spines, duct risers, loading docks …). */
  readonly blocked?: ReadonlyArray<readonly [number, number]>;
}

export interface InteriorHost {
  readonly building: number;
  readonly massing: MassingKind;
  readonly arch: number;
  readonly boxes: readonly MassBox[];
  readonly lot: Rect;
  readonly faces: readonly InteriorHostFace[];
  /** GALLERY_DANCHI: walkable gallery deck floor heights (2F-3F) and the gallery face key 'x:1' etc. */
  readonly gallery?: { readonly faceKey: string; readonly deckYs: readonly number[]; readonly depth: number; /** exact corridor along range used by the gallery builder (door / column grid) */ readonly a0?: number; readonly a1?: number };
  /** face keys ('x:1') that must stay clean flush wall-run faces */
  readonly runKeys: ReadonlySet<string>;
}

export type OpeningKind = 'DOOR' | 'WINDOW' | 'ARCADE';
export interface InteriorOpening {
  readonly kind: OpeningKind;
  readonly ax: Axis;
  readonly sg: 1 | -1;
  readonly plane: number;
  readonly a0: number;
  readonly a1: number;
  readonly y0: number;
  readonly y1: number;
  /** host face id when the opening is in an exterior lot face (-1 for gallery-side) */
  readonly faceId: number;
}

export interface ShellPiece {
  readonly bucket: 'concrete' | 'archPaint' | 'steel' | 'strips';
  readonly x0: number;
  readonly y0: number;
  readonly z0: number;
  readonly x1: number;
  readonly y1: number;
  readonly z1: number;
  readonly ao?: number;
  readonly color?: number;
  readonly emissive?: number;
}

export interface InteriorPlan {
  readonly id: number;
  readonly building: number;
  readonly template: InteriorTemplate;
  readonly boxIndex: number;
  readonly room: MassBox;
  readonly floorY: number;
  readonly ceilY: number;
  readonly openings: readonly InteriorOpening[];
  readonly shell: readonly ShellPiece[];
  /** PROP colliders: counters, bed base, showcase base, non-destructible kit props (v1 kitchen, v6 console). */
  readonly solids: readonly Aabb3[];
  readonly props: ReadonlyArray<{ variant: number; x: number; y: number; z: number; yaw: number; tint: number }>;
  readonly lights: ReadonlyArray<{ x: number; y: number; z: number; color: number; intensity: number }>;
  /** BUILDING colliders of the interior envelope: perimeter walls (split around openings), jambs, soffit,
   *  upper-floor floor slab, arcade piers. None of them intrudes into an opening. */
  readonly structure: readonly Aabb3[];
  /** Room frame: the main open face (street face / gallery face), room along range and depth into the box. */
  readonly frame: { readonly ax: Axis; readonly sg: 1 | -1; readonly plane: number; readonly a0: number; readonly a1: number; readonly depth: number };
  /** Walkable inner volume (inside the walls, floor → soffit). */
  readonly inner: Aabb3;
}

export interface PlanInteriorsOptions {
  halfExtent: number;
  isRing?: boolean;
  /** Only plan these templates (two-phase integration). Default: all four. */
  templates?: readonly InteriorTemplate[];
  /** Room-count target for THIS call (default S1–S4 {6, 10}, S5 {4, 6}; with `templates` set: the base quota sum). */
  target?: { min: number; max: number };
  /** First plan id (default 0). */
  idBase?: number;
}

// =============================================================================================
// Constants
// =============================================================================================
export const INTERIOR = {
  CLEAR_H_M: 3.5,
  SOFFIT_M: 0.18,
  SLAB_M: 0.16,
  WALL_M: 0.3,
  JAMB_M: 0.07,
  JAMB_PROUD_M: 0.015,
  CORNER_M: 0.4,
  MARGIN_M: 0.6,
  FOOT_PAD_M: 1.2,
  /** 1F floor finish top above the street ground (no z-fight with the ground plane). */
  GROUND_LIFT_M: 0.015,
  DOOR_H_M: 2.25,
  DOOR_W_M: 1.15,
  TECH_DOOR_W_M: 1.45,
  SERVICE_DOOR_W_M: 1.2,
  WINDOW_MIN_W_M: 2.4,
  WINDOW_MAX_W_M: 3.6,
  APT_WINDOW_W_M: 2.8,
  APT_WINDOW_H_M: 2.0,
  SILL_M: 0.65,
  ARCADE_W_M: 4.5,
  ARCADE_H_M: 3.5,
  ARCADE_DOOR_W_M: 1.6,
  DOOR_SWING_M: 1.2,
  WALK_CLEAR_M: 1.8,
  WINDOW_CLEAR_M: 1.0,
  PIER_GAP_M: 0.05,
  WALL_AO: 0.44,
  APT_WALL_AO: 0.4,
  FLOOR_AO: 0.55,
  SOFFIT_AO: 0.5,
  PIER_AO: 0.45,
} as const;

/** Clamped room footprint ranges [minW, maxW, minD, maxD] (W along the open face, D into the box). */
export const INTERIOR_FOOTPRINT: Readonly<Record<'EATERY' | 'TECH_SHOP' | 'APARTMENT', readonly [number, number, number, number]>> = {
  EATERY: [6.4, 8.0, 5.6, 7.0],
  TECH_SHOP: [7.0, 10.0, 5.6, 7.0],
  APARTMENT: [5.2, 6.0, 4.4, 5.0],
};

export const INTERIOR_LIGHT_COLOR: Readonly<Record<InteriorTemplate, number>> = {
  EATERY: 0xffb070,
  TECH_SHOP: 0x7ff0ff,
  PASS_ARCADE: 0xd8f6ff,
  APARTMENT: 0xdfefff,
};
const TECH_MAGENTA = 0xff5fd8;

/** Height of the room ceiling plane above the floor (clear height + soffit). */
export const INTERIOR_CEIL_ABOVE_FLOOR_M = INTERIOR.CLEAR_H_M + INTERIOR.SOFFIT_M;

// =============================================================================================
// 11A-1 dual split
// =============================================================================================
const vol = (b: MassBox): number => (b.x1 - b.x0) * (b.y1 - b.y0) * (b.z1 - b.z0);

/**
 * Dual-splitting rule: B minus the carved room R → the solid pieces for BOTH `G.bodies` and the BUILDING colliders.
 * Above slab [R.y1, B.y1] and below slab [B.y0, R.y0] keep the full footprint; on [R.y0, R.y1] up to four
 * non-overlapping remainder boxes surround R (two full-depth x strips, two z strips between them). Pieces thinner than
 * `minThick` on any axis are dropped (the planner never produces such slivers: open sides are flush, solid margins
 * ≥ 0.6 m). Output is sorted largest volume first; union(output) ∪ R == B (no overlaps) when nothing is dropped.
 */
export function splitMassBox(B: MassBox, R: MassBox, minThick = 0.25): MassBox[] {
  const r = {
    x0: Math.max(R.x0, B.x0),
    x1: Math.min(R.x1, B.x1),
    z0: Math.max(R.z0, B.z0),
    z1: Math.min(R.z1, B.z1),
    y0: Math.max(R.y0, B.y0),
    y1: Math.min(R.y1, B.y1),
  };
  if (r.x1 - r.x0 <= 1e-9 || r.z1 - r.z0 <= 1e-9 || r.y1 - r.y0 <= 1e-9) return [{ x0: B.x0, x1: B.x1, z0: B.z0, z1: B.z1, y0: B.y0, y1: B.y1 }];
  const out: MassBox[] = [];
  const push = (b: MassBox): void => {
    if (b.x1 - b.x0 >= minThick - 1e-9 && b.y1 - b.y0 >= minThick - 1e-9 && b.z1 - b.z0 >= minThick - 1e-9) out.push(b);
  };
  if (B.y1 - r.y1 > 1e-9) push({ x0: B.x0, x1: B.x1, z0: B.z0, z1: B.z1, y0: r.y1, y1: B.y1 });
  if (r.y0 - B.y0 > 1e-9) push({ x0: B.x0, x1: B.x1, z0: B.z0, z1: B.z1, y0: B.y0, y1: r.y0 });
  if (r.x0 - B.x0 > 1e-9) push({ x0: B.x0, x1: r.x0, z0: B.z0, z1: B.z1, y0: r.y0, y1: r.y1 });
  if (B.x1 - r.x1 > 1e-9) push({ x0: r.x1, x1: B.x1, z0: B.z0, z1: B.z1, y0: r.y0, y1: r.y1 });
  if (r.z0 - B.z0 > 1e-9) push({ x0: r.x0, x1: r.x1, z0: B.z0, z1: r.z0, y0: r.y0, y1: r.y1 });
  if (B.z1 - r.z1 > 1e-9) push({ x0: r.x0, x1: r.x1, z0: r.z1, z1: B.z1, y0: r.y0, y1: r.y1 });
  out.sort((p, q) => vol(q) - vol(p));
  return out;
}

// =============================================================================================
// 11A-1c InteriorPropsKit geometry (HERO_3D_MODELING_SPEC §4)
// =============================================================================================
export const INTERIOR_PROP_CAP = 260;
export const INTERIOR_PROP_TRI_BUDGET = 360;
/** Variants registered as destructible by Phase 11B (v1 kitchen station and v6 console are solid PROP colliders). */
export const INTERIOR_PROP_DESTRUCTIBLE: readonly number[] = [0, 2, 3, 4, 5, 7];
export const INTERIOR_PROP_VARIANT = { COUNTER_SETTING: 0, KITCHEN: 1, HELMET_PEDESTAL: 2, JACKET_RACK: 3, DESK_RIG: 4, KITCHENETTE: 5, RECEPTION: 6, PENDANT_FAN: 7 } as const;
/** Vertex-shader cull distance of the kit (m). */
export const INTERIOR_PROP_CULL_M = 64;

/**
 * Phase 13 swap contract — canonical envelopes (local metres, front = +Z, footprint centred on x = z = 0, floor at
 * y = 0; v0 pivots at the counter-top centre). v7's drop rod reaches the 3.50 m room ceiling (grounded load path)
 * instead of the spec's free-hanging 2.35 m top; v6 packs a 1.70 m counter + 0.95 m lounge bench into the locked
 * 2.20 m envelope.
 */
export const INTERIOR_PROP_BOUNDS: ReadonlyArray<{ readonly w: number; readonly h: number; readonly d: number }> = [
  { w: 0.85, h: 0.36, d: 0.45 },
  { w: 1.6, h: 1.95, d: 0.72 },
  { w: 0.72, h: 1.48, d: 0.72 },
  { w: 1.45, h: 1.62, d: 0.56 },
  { w: 1.45, h: 1.38, d: 0.95 },
  { w: 1.15, h: 1.52, d: 0.62 },
  { w: 2.2, h: 1.15, d: 0.95 },
  { w: 0.95, h: 3.5, d: 0.65 },
];
/** Height of the v0 counter top above the room floor (v0 instances sit at floorY + this). */
export const INTERIOR_COUNTER_TOP_M = 1.05;

/**
 * aPart material ids. Non-emissive albedo ≤ 0.62 (bloom guard); emissive parts 0.85–1.15 × per-instance scale.
 * TINT / FABRIC take the per-instance palette colour (`aProp.y`).
 */
const P = {
  BLACK: 0,
  STEEL: 1,
  TINT: 2,
  WOOD: 3,
  FABRIC: 4,
  WARM: 5,
  CYAN: 6,
  MAGENTA: 7,
  GLASS: 8,
  RED: 9,
  GREEN: 10,
  BROTH: 11,
  CREAM: 12,
  BLUE: 13,
  BRASS: 14,
  PAPER: 15,
  SLATE: 16,
  WATER: 17,
  MENU: 18,
} as const;

type RGB = readonly [number, number, number];
interface PartLook {
  readonly c: RGB;
  readonly r: number;
  readonly m: number;
  readonly e?: RGB;
  /** multiply the instance tint colour by this instead of using `c` */
  readonly tint?: number;
}
const PART_LOOK: readonly PartLook[] = [
  { c: [0.05, 0.055, 0.065], r: 0.5, m: 0.55 }, // 0 matte black steel / plastic
  { c: [0.42, 0.43, 0.45], r: 0.3, m: 0.85 }, // 1 brushed stainless / chrome
  { c: [0.3, 0.3, 0.3], r: 0.38, m: 0.05, tint: 1 }, // 2 tinted ceramic / paint
  { c: [0.4, 0.28, 0.16], r: 0.68, m: 0.0 }, // 3 bamboo / timber
  { c: [0.2, 0.2, 0.2], r: 0.85, m: 0.0, tint: 0.55 }, // 4 tinted fabric / leather
  { c: [0.06, 0.05, 0.04], r: 0.4, m: 0.0, e: [1.0, 0.64, 0.32] }, // 5 warm bulb
  { c: [0.03, 0.05, 0.06], r: 0.2, m: 0.0, e: [0.3, 0.9, 1.0] }, // 6 cyan screen / strip
  { c: [0.05, 0.03, 0.05], r: 0.2, m: 0.0, e: [1.0, 0.28, 0.82] }, // 7 magenta strip
  { c: [0.025, 0.03, 0.035], r: 0.08, m: 0.1 }, // 8 dark glass / bezel
  { c: [0.05, 0.02, 0.02], r: 0.3, m: 0.0, e: [1.0, 0.14, 0.08] }, // 9 red digital readout
  { c: [0.02, 0.05, 0.02], r: 0.3, m: 0.0, e: [0.28, 1.0, 0.38] }, // 10 green LED
  { c: [0.52, 0.32, 0.14], r: 0.22, m: 0.0 }, // 11 ramen broth
  { c: [0.58, 0.56, 0.52], r: 0.35, m: 0.0 }, // 12 cream ceramic / white plastic
  { c: [0.02, 0.03, 0.06], r: 0.3, m: 0.0, e: [0.3, 0.56, 1.0] }, // 13 blue temp strip
  { c: [0.55, 0.41, 0.2], r: 0.32, m: 0.9 }, // 14 brushed brass
  { c: [0.6, 0.55, 0.45], r: 0.8, m: 0.0 }, // 15 paper / card
  { c: [0.11, 0.12, 0.14], r: 0.34, m: 0.1 }, // 16 dark slate
  { c: [0.3, 0.29, 0.26], r: 0.08, m: 0.0 }, // 17 cloudy boiling water
  { c: [0.08, 0.06, 0.04], r: 0.5, m: 0.0, e: [0.88, 0.6, 0.34] }, // 18 backlit menu (subtle)
];
/** Per-instance tint palette (linear, ≤ 0.62). */
const TINT_PALETTE: readonly RGB[] = [
  [0.42, 0.05, 0.05],
  [0.05, 0.05, 0.055],
  [0.05, 0.3, 0.32],
  [0.5, 0.32, 0.08],
  [0.18, 0.22, 0.1],
  [0.12, 0.16, 0.3],
  [0.55, 0.52, 0.45],
  [0.28, 0.08, 0.22],
];
export const INTERIOR_TINT_COUNT = TINT_PALETTE.length;

type GL = THREE.BufferGeometry[];
let kVar = 0;
let kGround = true;
const V3 = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

/** Tags a geometry with aPart / aAo / aVar (ground-contact ramp below 0.30 m on floor-standing variants). */
function tg(L: GL, g: THREE.BufferGeometry, part: number, ao = 1, m?: THREE.Matrix4): void {
  const out = g.index ? g.toNonIndexed() : g;
  for (const name of Object.keys(out.attributes)) if (name !== 'position' && name !== 'normal') out.deleteAttribute(name);
  if (!out.getAttribute('normal')) out.computeVertexNormals();
  if (m) out.applyMatrix4(m);
  const pos = out.getAttribute('position');
  const n = pos.count;
  const aAo = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const y = pos.getY(i);
    aAo[i] = ao * (kGround && y < 0.3 ? 0.45 + 0.55 * (Math.max(y, 0) / 0.3) : 1);
  }
  out.setAttribute('aPart', new THREE.BufferAttribute(new Float32Array(n).fill(part), 1));
  out.setAttribute('aAo', new THREE.BufferAttribute(aAo, 1));
  out.setAttribute('aVar', new THREE.BufferAttribute(new Float32Array(n).fill(kVar), 1));
  L.push(out);
}

/** Flat-shaded copy (hard facets for low-segment lathes / extrusions). */
function flat(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g;
  out.deleteAttribute('normal');
  out.computeVertexNormals();
  return out;
}

/** Lathe about +Y; points (r, y) bottom → top give outward normals (top → bottom = inward, e.g. a bowl's inside). */
function lat(pts: ReadonlyArray<readonly [number, number]>, seg: number, x: number, y: number, z: number, phiStart = 0, phiLen = Math.PI * 2, sz = 1): THREE.BufferGeometry {
  const g = new THREE.LatheGeometry(
    pts.map(([r, yy]) => new THREE.Vector2(r, yy)),
    seg,
    phiStart,
    phiLen,
  ).toNonIndexed();
  g.deleteAttribute('uv');
  if (sz !== 1) g.scale(1, 1, sz);
  g.translate(x, y, z);
  return g;
}

/** Flat disc facing +Y (or −Y). */
function disc(r: number, seg: number, x: number, y: number, z: number, thetaStart = 0, down = false): THREE.BufferGeometry {
  const g = new THREE.CircleGeometry(r, seg, thetaStart);
  g.rotateX(down ? Math.PI / 2 : -Math.PI / 2);
  g.translate(x, y, z);
  return g;
}

/** Vertical cylinder with thetaStart (flats aligned), optional z flattening. */
function cylT(rTop: number, rBot: number, h: number, radial: number, open: boolean, thetaStart: number, x: number, y: number, z: number, sz = 1): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, radial, 1, open, thetaStart).toNonIndexed();
  g.deleteAttribute('uv');
  if (sz !== 1) g.scale(1, 1, sz);
  g.translate(x, y, z);
  return g;
}

/** Tapered cylinder a → b (radii r0 at a, r1 at b). */
const _yUp = new THREE.Vector3(0, 1, 0);
function cylAB(a: THREE.Vector3, b: THREE.Vector3, r0: number, r1: number, radial: number, open = true): THREE.BufferGeometry {
  const len = Math.max(1e-4, a.distanceTo(b));
  const g = new THREE.CylinderGeometry(r1, r0, len, radial, 1, open).toNonIndexed();
  g.deleteAttribute('uv');
  const q = new THREE.Quaternion().setFromUnitVectors(_yUp, b.clone().sub(a).normalize());
  g.applyMatrix4(new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1)));
  return g;
}

/** Reverses winding + normals (inner shell of a single-sided surface). */
function flip(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g;
  const pos = out.getAttribute('position') as THREE.BufferAttribute;
  const nor = out.getAttribute('normal') as THREE.BufferAttribute;
  for (let t = 0; t < pos.count; t += 3) {
    for (const attr of [pos, nor]) {
      const x = attr.getX(t + 1);
      const y = attr.getY(t + 1);
      const z = attr.getZ(t + 1);
      attr.setXYZ(t + 1, attr.getX(t + 2), attr.getY(t + 2), attr.getZ(t + 2));
      attr.setXYZ(t + 2, x, y, z);
    }
  }
  for (let i = 0; i < nor.count; i++) nor.setXYZ(i, -nor.getX(i), -nor.getY(i), -nor.getZ(i));
  return out;
}

const mYaw = (yaw: number, x: number, y: number, z: number): THREE.Matrix4 => new THREE.Matrix4().makeRotationY(yaw).setPosition(x, y, z);

/** v0 — eatery counter place-setting cluster (0.85 × 0.36 × 0.45, pivot = counter-top centre). */
function propCounterSetting(L: GL): void {
  const bowl = (x: number, z: number): void => {
    // Outer foot → belly → rim (outward), rim lip → inner wall down to the broth line (inward-facing).
    tg(L, lat([[0.044, 0], [0.082, 0.03], [0.105, 0.085], [0.096, 0.085], [0.086, 0.066]], 8, x, 0, z), P.TINT);
    tg(L, disc(0.086, 8, x, 0.066, z), P.BROTH);
  };
  bowl(-0.2, 0.08);
  bowl(0.07, 0.1);
  // Bamboo chopsticks resting across both sides of the first bowl's rim (rod centre 0.004 above the 0.085 rim).
  for (const dz of [0.0, 0.018]) tg(L, rod(V3(-0.33, 0.089, 0.105 + dz), V3(-0.1, 0.089, 0.125 + dz), 0.004, 3), P.WOOD);
  // Stack of three nested spare bowls (stepped rims) + its inner glaze disc.
  tg(L, lat([[0.044, 0], [0.082, 0.03], [0.105, 0.085], [0.107, 0.1], [0.109, 0.115], [0.1, 0.115], [0.09, 0.1]], 6, 0.3, 0, -0.1), P.TINT);
  tg(L, disc(0.09, 6, 0.3, 0.1, -0.1, Math.PI / 2), P.CREAM);
  // Two condiment squeeze bottles (glassy body + red / amber cap).
  for (const [x, z, cap] of [[-0.34, -0.15, P.RED], [-0.26, -0.165, P.BRASS]] as const) {
    tg(L, lat([[0.028, 0], [0.028, 0.11], [0.012, 0.138]], 6, x, 0, z), P.GLASS);
    tg(L, lat([[0.014, 0.132], [0.012, 0.152], [0, 0.162]], 6, x, 0, z), cap === P.RED ? P.TINT : P.BRASS);
  }
  // Brushed-steel napkin dispenser + napkin slot.
  tg(L, box(0.11, 0.14, 0.07, 0.07, 0.07, -0.15), P.STEEL);
  tg(L, plane(0.07, 0.03, 0.07, 0.11, -0.113), P.PAPER);
  // Backlit acrylic menu tent (A-frame, both faces softly glowing).
  tg(L, plane(0.12, 0.185, -0.08, 0.09, -0.127, [-0.25, 0, 0]), P.MENU);
  tg(L, plane(0.12, 0.185, -0.08, 0.09, -0.173, [0.25, Math.PI, 0]), P.MENU);
}

/** v1 — kitchen back-counter appliance station (1.60 × 1.95 × 0.72, back against the wall at z = −0.36). */
function propKitchen(L: GL): void {
  tg(L, box(1.52, 0.1, 0.6, 0, 0.05, -0.04), P.BLACK, 0.7); // recessed toe kick
  tg(L, box(1.6, 0.8, 0.68, 0, 0.5, -0.02), P.STEEL); // stainless prep cabinet y 0.1–0.9
  for (const x of [-0.53, 0, 0.53]) tg(L, plane(0.32, 0.018, x, 0.8, 0.323), P.STEEL); // flush door bar pulls
  for (const vx of [-0.4, 0.05]) {
    // Raised vat lip (outer wall up, lip top, inner wall down) around the boiling water surface.
    tg(L, lat([[0.215, 0.9], [0.215, 0.945], [0.19, 0.945], [0.19, 0.92]], 8, vx, 0, -0.04), P.STEEL);
    tg(L, disc(0.19, 8, vx, 0.92, -0.04), P.WATER);
  }
  // Wire strainer baskets: vat 1 handle to −x, vat 2 handle to +x; hooks rest on the vat rims.
  for (const [vx, s] of [[-0.4, -1], [0.05, 1]] as const) {
    const bk = cylT(0.085, 0.075, 0.1, 5, true, 0, vx + s * 0.06, 0.91, -0.04); // wire basket, 4 cm proud of the water
    tg(L, bk, P.STEEL, 0.8);
    tg(L, flip(cylT(0.083, 0.073, 0.1, 5, true, 0, vx + s * 0.06, 0.91, -0.04)), P.BLACK, 0.6); // dark mesh inside
    tg(L, rod(V3(vx + s * 0.145, 0.955, -0.04), V3(vx + s * 0.33, 0.99, -0.04), 0.007, 3), P.BLACK);
    tg(L, rod(V3(vx + s * 0.205, 0.974, -0.04), V3(vx + s * 0.205, 0.946, -0.04), 0.006, 3), P.STEEL);
  }
  tg(L, box(0.3, 0.05, 0.4, 0.55, 0.925, -0.04), P.STEEL); // stacked prep trays
  tg(L, plane(0.3, 0.004, 0.55, 0.925, 0.161), P.BLACK); // tray seam
  tg(L, box(1.6, 1.05, 0.03, 0, 1.425, -0.345), P.STEEL, 0.85); // backsplash y 0.9–1.95
  tg(L, rod(V3(-0.7, 1.68, -0.27), V3(0.7, 1.68, -0.27), 0.012, 4), P.STEEL); // utensil rail y 1.68
  for (const x of [-0.7, 0.7]) tg(L, box(0.025, 0.025, 0.06, x, 1.68, -0.3), P.STEEL);
  for (const x of [-0.42, -0.12, 0.18]) {
    tg(L, rod(V3(x, 1.69, -0.27), V3(x, 1.31, -0.25), 0.006, 3), P.STEEL); // ladle handle hooked over the rail
    tg(L, lat([[0, 1.272], [0.032, 1.28], [0.045, 1.31]], 5, x, 0, -0.25), P.STEEL); // hemispherical ladle bowl
    tg(L, disc(0.045, 5, x, 1.302, -0.25), P.BLACK, 0.7);
  }
  tg(L, box(0.2, 0.1, 0.03, 0.5, 1.45, -0.315), P.BLACK); // temp readout housing
  tg(L, plane(0.18, 0.08, 0.5, 1.45, -0.298), P.RED); // glowing red digital readout
}

/** v2 — tech-shop illuminated cyber-gear pedestal (0.72 × 1.48 × 0.72). */
function propHelmetPedestal(L: GL): void {
  const q = Math.PI / 4; // 4-segment lathes with flats facing ±x / ±z
  // Tapered bevelled monolith plinth (half 0.34 → 0.27) with chamfered foot and top.
  tg(L, flat(lat([[0.481, 0], [0.481, 0.055], [0.465, 0.07], [0.43, 0.88], [0.41, 0.9], [0.38, 0.92], [0, 0.92]], 4, 0, 0, 0, q)), P.BLACK);
  tg(L, flat(lat([[0.486, 0.054], [0.486, 0.076]], 4, 0, 0, 0, q)), P.CYAN); // glowing base collar strip
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) tg(L, rod(V3(sx * 0.25, 0.92, sz * 0.25), V3(sx * 0.25, 1.425, sz * 0.25), 0.012, 4), P.STEEL); // showcase corner posts
  tg(L, flat(lat([[0.375, 1.42], [0.375, 1.45], [0.335, 1.45], [0.335, 1.42], [0.375, 1.42]], 4, 0, 0, 0, q)), P.STEEL); // top frame ring
  // Chrome neck cradle.
  tg(L, cylT(0.03, 0.05, 0.12, 6, true, 0, 0, 0.98, 0), P.STEEL);
  tg(L, cylT(0.075, 0.03, 0.03, 6, true, 0, 0, 1.055, 0), P.STEEL);
  // Sculpted cranial shell (elongated front-to-back), sealed underside, wrap-around cyan visor, ear-comm pods.
  const hy = 1.06;
  tg(L, lat([[0.09, 0], [0.128, 0.06], [0.125, 0.15], [0.08, 0.225], [0, 0.255]], 8, 0, hy, 0, 0, Math.PI * 2, 1.12), P.TINT);
  tg(L, disc(0.09, 8, 0, hy + 0.002, 0, 0, true), P.BLACK);
  tg(L, lat([[0.129, 0.07], [0.134, 0.105], [0.13, 0.14]], 8, 0, hy, 0, -1.9, 3.8, 1.12), P.CYAN);
  for (const s of [-1, 1]) tg(L, cyl(0.045, 0.045, 0.05, 6, s * 0.13, hy + 0.11, 0, [0, 0, Math.PI / 2], true), P.BLACK);
  // Sculpted jaw / chin guard wrapping the lower front (tucked under the visor line).
  tg(L, lat([[0.075, -0.012], [0.118, 0.02], [0.129, 0.072]], 6, 0, hy, 0, -1.1, 2.2, 1.18), P.BLACK);
  // Angled holographic spec placard on the plinth's front lip.
  tg(L, box(0.22, 0.02, 0.03, 0, 0.93, 0.2), P.STEEL);
  tg(L, plane(0.2, 0.09, 0, 0.94 + 0.045 * Math.cos(0.6), 0.2 - 0.045 * Math.sin(0.6), [-0.6, 0, 0]), P.CYAN);
}

/** v3 — tech-apparel tactical jacket rack (1.45 × 1.62 × 0.56): A-frame ends, shoe shelf, four jackets. */
function propJacketRack(L: GL): void {
  for (const x of [-0.68, 0.68]) for (const sz of [-1, 1]) tg(L, rod(V3(x, 0, sz * 0.26), V3(x, 1.58, 0), 0.018, 3), P.BLACK);
  tg(L, rod(V3(-0.7, 1.58, 0), V3(0.7, 1.58, 0), 0.018, 4), P.BLACK); // hanging bar
  tg(L, box(1.34, 0.03, 0.44, 0, 0.2, 0, [0, 0, 0], true), P.BLACK); // shoe shelf (touches all four legs)
  tg(L, box(0.36, 0.2, 0.3, -0.3, 0.315, 0), P.TINT, 0.85); // storage boxes
  tg(L, box(0.32, 0.16, 0.28, 0.25, 0.295, 0.02), P.PAPER, 0.85);
  const xs = [-0.5, -0.17, 0.17, 0.5];
  xs.forEach((x, k) => {
    const yaw = Math.PI / 2 + (k % 2 === 0 ? 1 : -1) * 0.105; // shoulders along z, ±6° organic yaw
    const m = mYaw(yaw, x, 0, 0);
    const pipe = k % 2 === 0 ? P.CYAN : P.MAGENTA;
    tg(L, rod(V3(0, 1.563, 0), V3(0, 1.5, 0), 0.006, 3), P.STEEL, 1, m); // hanger hook
    tg(L, cylT(0.1, 0.075, 0.11, 6, true, Math.PI / 6, 0, 1.475, 0, 0.8), P.FABRIC, 0.9, m); // high upturned tech collar
    tg(L, cylT(0.085, 0.235, 0.05, 6, true, Math.PI / 6, 0, 1.395, 0, 0.55), P.FABRIC, 1, m); // squared shoulder yoke
    const torso = cylT(0.235, 0.18, 0.62, 6, true, Math.PI / 6, 0, 1.06, 0, 0.55);
    tg(L, torso, P.FABRIC, 1, m);
    tg(L, disc(0.18, 6, 0, 0.75, 0, Math.PI / 6 - Math.PI / 2, true).scale(1, 1, 0.55), P.FABRIC, 0.6, m); // hem closure
    for (const s of [-1, 1]) tg(L, cylAB(V3(s * 0.215, 1.37, 0), V3(s * 0.232, 0.8, 0.02), 0.054, 0.04, 4), P.FABRIC, 0.9, m); // sleeves
    for (const s of [-1, 1]) tg(L, plane(0.012, 0.58, s * 0.075, 1.07, 0.103, [0.042, 0, 0]), pipe, 1, m); // glowing piping
  });
}

/** v4 — apartment desk + curved dual-monitor terminal + tucked swivel chair (1.45 × 1.38 × 0.95). */
function propDeskRig(L: GL): void {
  const dz = -0.135; // desk centre (desk z −0.475 … 0.205, chair tucked in front)
  tg(L, box(1.4, 0.035, 0.68, 0, 0.7425, dz, [0, 0, 0], true), P.WOOD, 0.8);
  for (const sx of [-1, 1]) for (const z of [-0.445, 0.175]) tg(L, rod(V3(sx * 0.66, 0, z), V3(sx * 0.66, 0.725, z), 0.02, 3), P.BLACK);
  tg(L, rod(V3(-0.66, 0.12, -0.445), V3(0.66, 0.12, -0.445), 0.015, 3), P.BLACK); // lower cross-bar
  tg(L, box(0.2, 0.44, 0.45, 0.5, 0.22, -0.2), P.BLACK); // PC tower
  tg(L, plane(0.03, 0.3, 0.5, 0.24, 0.027), P.CYAN); // glowing fan slit
  // Monitor stand + articulated arms + two inward-yawed monitors.
  tg(L, box(0.22, 0.015, 0.16, 0, 0.7675, -0.36), P.BLACK);
  tg(L, rod(V3(0, 0.775, -0.36), V3(0, 1.12, -0.36), 0.018, 4), P.STEEL);
  for (const s of [-1, 1]) {
    tg(L, rod(V3(0, 1.08, -0.36), V3(s * 0.27, 1.08, -0.31), 0.01, 3), P.STEEL);
    const yaw = -s * 0.244;
    const cx = s * 0.29;
    const cz = -0.29;
    tg(L, box(0.54, 0.34, 0.025, cx, 1.08, cz, [0, yaw, 0]), P.GLASS);
    tg(L, plane(0.5, 0.3, cx + Math.sin(yaw) * 0.0135, 1.08, cz + Math.cos(yaw) * 0.0135, [0, yaw, 0]), P.CYAN, 0.85);
  }
  tg(L, box(0.42, 0.025, 0.15, -0.05, 0.7725, -0.08, [0.06, 0, 0]), P.BLACK); // mechanical keyboard
  tg(L, box(0.06, 0.03, 0.1, 0.27, 0.775, -0.06), P.BLACK); // mouse
  // Ceramic mug (wall + lip + coffee) with handle.
  tg(L, lat([[0.036, 0.76], [0.04, 0.855], [0.032, 0.845]], 6, -0.45, 0, -0.2), P.CREAM);
  tg(L, disc(0.032, 6, -0.45, 0.845, -0.2, Math.PI / 2), P.BROTH);
  tg(L, rod(V3(-0.41, 0.83, -0.2), V3(-0.41, 0.78, -0.2), 0.008, 3), P.CREAM);
  // Articulated swing-arm desk lamp with warm bulb.
  const lx = -0.58;
  const lz = -0.38;
  tg(L, cyl(0.07, 0.075, 0.02, 6, lx, 0.77, lz, [0, 0, 0], true), P.BLACK);
  tg(L, rod(V3(lx, 0.78, lz), V3(lx + 0.05, 1.05, lz + 0.05), 0.008, 3), P.STEEL);
  tg(L, rod(V3(lx + 0.05, 1.05, lz + 0.05), V3(lx + 0.18, 1.215, lz + 0.1), 0.008, 3), P.STEEL);
  tg(L, cylT(0.02, 0.07, 0.09, 6, true, 0, lx + 0.18, 1.17, lz + 0.1), P.BLACK);
  tg(L, disc(0.065, 6, lx + 0.18, 1.13, lz + 0.1, 0, true), P.WARM);
  // Tucked ergonomic swivel chair rotated 22°.
  const cm = mYaw(0.384, 0.05, 0, 0.17);
  for (let k = 0; k < 5; k++) {
    const t = (k / 5) * Math.PI * 2 + 0.3;
    const ex = Math.cos(t) * 0.24;
    const ez = Math.sin(t) * 0.24;
    tg(L, rod(V3(0, 0.09, 0), V3(ex, 0.065, ez), 0.016, 3), P.BLACK, 1, cm);
    tg(L, rod(V3(ex - 0.025 * Math.sin(t), 0.026, ez + 0.025 * Math.cos(t)), V3(ex + 0.025 * Math.sin(t), 0.026, ez - 0.025 * Math.cos(t)), 0.026, 3), P.BLACK, 1, cm);
  }
  tg(L, rod(V3(0, 0.09, 0), V3(0, 0.42, 0), 0.025, 6), P.STEEL, 1, cm); // pneumatic cylinder
  tg(L, box(0.48, 0.07, 0.46, 0, 0.45, 0, [0, 0, 0], true), P.FABRIC, 1, cm); // seat
  const back = new THREE.CylinderGeometry(0.45, 0.45, 0.42, 4, 1, true, -0.5, 1.0).toNonIndexed();
  back.deleteAttribute('uv');
  back.translate(0, 0.76, -0.2);
  tg(L, back, P.FABRIC, 1, cm); // curved mesh backrest (outer)
  const backIn = new THREE.CylinderGeometry(0.44, 0.44, 0.42, 4, 1, true, -0.5, 1.0).toNonIndexed();
  backIn.deleteAttribute('uv');
  backIn.translate(0, 0.76, -0.2);
  tg(L, flip(backIn), P.FABRIC, 0.8, cm); // inner face toward the seat
  tg(L, rod(V3(0, 0.45, 0.2), V3(0, 0.6, 0.235), 0.015, 3), P.BLACK, 1, cm);
  for (const s of [-1, 1]) {
    tg(L, rod(V3(s * 0.22, 0.485, 0), V3(s * 0.22, 0.655, 0), 0.012, 3), P.BLACK, 1, cm);
    tg(L, rod(V3(s * 0.22, 0.67, -0.12), V3(s * 0.22, 0.67, 0.12), 0.022, 4), P.BLACK, 1, cm);
  }
}

/** v5 — apartment compact kitchenette (1.15 × 1.52 × 0.62): mini-fridge + microwave, steel side shelf. */
function propKitchenette(L: GL): void {
  const fx = -0.28;
  tg(L, box(0.58, 0.96, 0.58, fx, 0.48, -0.02), P.CREAM, 0.85); // weathered fridge body (z −0.31 … 0.27)
  tg(L, box(0.56, 0.6, 0.02, fx, 0.34, 0.28), P.CREAM); // lower door
  tg(L, box(0.56, 0.28, 0.02, fx, 0.8, 0.28), P.CREAM); // freezer door
  tg(L, plane(0.025, 0.3, fx + 0.24, 0.45, 0.292), P.BLACK); // recessed door grips
  tg(L, plane(0.025, 0.12, fx + 0.24, 0.75, 0.292), P.BLACK);
  tg(L, plane(0.012, 0.2, fx - 0.24, 0.78, 0.292), P.BLUE); // vertical glowing temp strip
  tg(L, plane(0.09, 0.12, fx - 0.08, 0.5, 0.292), P.TINT); // sticker / magnets
  tg(L, plane(0.05, 0.05, fx + 0.06, 0.82, 0.292), P.PAPER);
  // Countertop microwave on the fridge.
  tg(L, box(0.48, 0.28, 0.36, fx - 0.01, 1.1, -0.06), P.BLACK);
  tg(L, plane(0.3, 0.18, fx - 0.06, 1.1, 0.122), P.GLASS);
  tg(L, plane(0.1, 0.22, fx + 0.17, 1.1, 0.122), P.SLATE);
  tg(L, plane(0.06, 0.025, fx + 0.17, 1.18, 0.123), P.GREEN); // LED clock
  // Steel side shelf unit (x 0.03 … 0.555) with four boards.
  for (const x of [0.045, 0.54]) for (const z of [-0.28, 0.12]) tg(L, rod(V3(x, 0, z), V3(x, 1.51, z), 0.012, 3), P.STEEL);
  for (const y of [0.13, 0.71, 1.23, 1.5]) tg(L, box(0.52, 0.02, 0.42, 0.2925, y, -0.08), P.STEEL, 0.9);
  for (let k = 0; k < 3; k++) {
    const x = 0.12 + k * 0.17;
    tg(L, cylT(0.05, 0.038, 0.1, 6, true, 0, x, 0.77, -0.06), P.TINT); // instant-noodle cups
    tg(L, disc(0.05, 6, x, 0.82, -0.06, Math.PI / 2), P.PAPER);
  }
  tg(L, box(0.3, 0.03, 0.22, 0.29, 1.255, -0.08, [0, 0.12, 0]), P.PAPER); // stacked magazines
  tg(L, box(0.28, 0.025, 0.2, 0.3, 1.2825, -0.07, [0, -0.08, 0]), P.TINT);
  tg(L, lat([[0.11, 0.14], [0.12, 0.3], [0, 0.32]], 6, 0.29, 0, -0.08), P.CREAM); // rice cooker
  tg(L, plane(0.03, 0.015, 0.29, 0.25, 0.04), P.GREEN);
}

/** v6 — hotel / arcade reception console + segmented lounge bench (2.20 × 1.15 × 0.95). */
function propReception(L: GL): void {
  // Faceted dark-slate counter: side profile (z, y) extruded along x over [−1.10, 0.60].
  const prof: Array<[number, number]> = [[-0.475, 0], [0.12, 0], [0.12, 0.1], [0.19, 0.14], [0.245, 0.96], [0.245, 1.05], [0.05, 1.05], [0.05, 0.96], [-0.475, 0.96]];
  const sh = new THREE.Shape(prof.map(([z, y]) => new THREE.Vector2(z, y)));
  const ex = new THREE.ExtrudeGeometry(sh, { depth: 1.7, bevelEnabled: false, curveSegments: 1 });
  ex.rotateY(-Math.PI / 2); // shape x → world z, extrusion → world −x
  ex.translate(0.6, 0, 0);
  tg(L, flat(ex), P.SLATE);
  tg(L, box(1.72, 0.012, 0.21, -0.25, 1.056, 0.1475), P.BRASS); // brass transaction-ledge cap
  tg(L, plane(1.66, 0.06, -0.25, 0.05, 0.122), P.CYAN); // recessed glowing kick strip
  for (const x of [-0.95, -0.55, -0.15, 0.25]) tg(L, plane(0.03, 0.8, x, 0.55, 0.2205, [0.067, 0, 0]), P.BRASS); // brass pinstripes on the facet
  for (const x of [-0.75, -0.2]) {
    tg(L, box(0.08, 0.04, 0.06, x, 0.98, -0.1), P.BRASS);
    tg(L, plane(0.3, 0.16, x, 1.0 + 0.08 * Math.cos(0.35), -0.1 - 0.08 * Math.sin(0.35), [-0.35, 0, 0]), P.CYAN, 0.9); // holo terminal (guest side)
    tg(L, plane(0.3, 0.16, x, 1.0 + 0.08 * Math.cos(0.35), -0.1 - 0.08 * Math.sin(0.35) - 0.002, [-0.35, Math.PI, 0]), P.GLASS);
  }
  tg(L, lat([[0.04, 1.062], [0.035, 1.09], [0, 1.105]], 6, 0.3, 0, 0.15), P.BRASS); // service bell
  tg(L, box(0.12, 0.015, 0.08, -0.5, 1.0695, 0.15), P.BLACK); // keycard tray
  // Segmented lounge bench (x 0.65 … 1.10), dark leather cushions.
  tg(L, box(0.37, 0.12, 0.87, 0.875, 0.06, 0), P.BLACK, 0.7);
  tg(L, box(0.45, 0.16, 0.95, 0.875, 0.2, 0, [0, 0, 0], true), P.BLACK);
  for (const s of [-1, 1]) tg(L, box(0.43, 0.12, 0.455, 0.875, 0.34, s * 0.2325), P.FABRIC);
}

/** v7 — caged industrial pendant lamp (ceiling 3.50) + oscillating standing fan + two storage crates. */
function propPendantFan(L: GL): void {
  const px = -0.2;
  const pz = -0.05;
  tg(L, cylT(0.07, 0.07, 0.025, 6, true, 0, px, 3.4875, pz), P.BLACK); // ceiling rose
  tg(L, disc(0.07, 6, px, 3.475, pz, 0, true), P.BLACK);
  tg(L, rod(V3(px, 3.475, pz), V3(px, 1.86, pz), 0.008, 3), P.BLACK); // drop rod
  tg(L, lat([[0.22, 1.64], [0.17, 1.76], [0.035, 1.86]], 8, px, 0, pz), P.BLACK); // enamelled dome (outside)
  tg(L, lat([[0.03, 1.85], [0.165, 1.75], [0.22, 1.64]], 8, px, 0, pz), P.CREAM, 0.85); // dome (inside)
  tg(L, cylT(0.03, 0.03, 0.06, 6, true, 0, px, 1.83, pz), P.BLACK); // socket
  tg(L, lat([[0, 1.672], [0.038, 1.7], [0.04, 1.75], [0.013, 1.8]], 6, px, 0, pz), P.WARM); // Edison bulb
  // Wire guard cage: four ribs rim → bottom hub, square ring through them.
  const ring: THREE.Vector3[] = [];
  for (let k = 0; k < 4; k++) {
    const t = (k / 4) * Math.PI * 2;
    tg(L, rod(V3(px + Math.cos(t) * 0.21, 1.645, pz + Math.sin(t) * 0.21), V3(px, 1.6, pz), 0.004, 3), P.BLACK);
    ring.push(V3(px + Math.cos(t) * 0.12, 1.6257, pz + Math.sin(t) * 0.12));
  }
  for (let k = 0; k < 4; k++) tg(L, rod(ring[k], ring[(k + 1) % 4], 0.004, 3), P.BLACK);
  // Oscillating floor fan.
  const fx = 0.22;
  const fz = 0.05;
  tg(L, cylT(0.17, 0.18, 0.04, 6, true, 0, fx, 0.02, fz), P.BLACK); // weighted base
  tg(L, disc(0.17, 6, fx, 0.04, fz), P.BLACK);
  tg(L, rod(V3(fx, 0.04, fz), V3(fx, 0.75, fz), 0.018, 4), P.STEEL); // telescoping chrome stand
  tg(L, rod(V3(fx, 0.75, fz), V3(fx, 1.05, fz), 0.012, 4), P.STEEL);
  tg(L, cyl(0.065, 0.065, 0.12, 6, fx, 1.1, fz - 0.03, [Math.PI / 2, 0, 0], true), P.CREAM); // motor housing
  tg(L, cyl(0.2, 0.2, 0.05, 8, fx, 1.1, fz + 0.09, [Math.PI / 2, 0, 0]), P.STEEL, 0.9); // circular guard rim
  for (const t of [Math.PI / 4, -Math.PI / 4]) tg(L, rod(V3(fx - Math.cos(t) * 0.2, 1.1 - Math.sin(t) * 0.2, fz + 0.113), V3(fx + Math.cos(t) * 0.2, 1.1 + Math.sin(t) * 0.2, fz + 0.113), 0.003, 3), P.STEEL); // front guard wires
  for (const s of [-1, 1]) tg(L, rod(V3(fx + s * 0.05, 1.1, fz + 0.02), V3(fx + s * 0.198, 1.1, fz + 0.07), 0.005, 3), P.STEEL); // guard struts
  tg(L, cyl(0.0, 0.03, 0.04, 6, fx, 1.1, fz + 0.07, [Math.PI / 2, 0, 0]), P.CREAM); // hub cap (cone)
  for (let k = 0; k < 3; k++) {
    const t = (k / 3) * Math.PI * 2;
    for (const back of [0, Math.PI]) tg(L, plane(0.08, 0.15, fx + Math.cos(t) * 0.1, 1.1 + Math.sin(t) * 0.1, fz + 0.075, [0, back, t - Math.PI / 2 + 0.25], 'ZYX'), P.TINT, 0.9);
  }
  // Two stacked storage crates under the pendant.
  tg(L, box(0.5, 0.3, 0.4, -0.2, 0.15, -0.05), P.TINT, 0.9);
  tg(L, box(0.46, 0.28, 0.38, -0.2, 0.44, -0.05), P.FABRIC);
}

const BUILDERS: ReadonlyArray<(L: GL) => void> = [propCounterSetting, propKitchen, propHelmetPedestal, propJacketRack, propDeskRig, propKitchenette, propReception, propPendantFan];

/** Merged kit geometry: position, normal, aPart, aAo, aVar for the requested variants (default all eight). */
export function buildInteriorPropsKit(variants: readonly number[] = [0, 1, 2, 3, 4, 5, 6, 7]): THREE.BufferGeometry {
  const L: GL = [];
  for (const v of variants) {
    const b = BUILDERS[v];
    if (!b) continue;
    kVar = v;
    kGround = v !== 0;
    b(L);
  }
  kVar = 0;
  kGround = true;
  if (L.length === 0) {
    const e = new THREE.BufferGeometry();
    for (const [name, size] of [['position', 3], ['normal', 3], ['aPart', 1], ['aAo', 1], ['aVar', 1]] as const) e.setAttribute(name, new THREE.BufferAttribute(new Float32Array(0), size));
    return e;
  }
  const merged = mergeGeometries(L, false);
  for (const g of L) g.dispose();
  if (!merged) throw new Error('InteriorBuilder: mergeGeometries failed');
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

/** Triangle count of variant `v` alone (budget test). */
export function interiorPropTris(v: number): number {
  const g = buildInteriorPropsKit([v]);
  const n = g.getAttribute('position').count / 3;
  g.dispose();
  return n;
}

// ---------------------------------------------------------------------------------------------
// Kit shader + instanced mesh
// ---------------------------------------------------------------------------------------------
const glv = (c: RGB): string => `vec3(${c[0].toFixed(3)}, ${c[1].toFixed(3)}, ${c[2].toFixed(3)})`;
function partGlsl(): string {
  const lines: string[] = [];
  PART_LOOK.forEach((p, k) => {
    const base = p.tint !== undefined ? `ipTint(vITint) * ${p.tint.toFixed(3)}` : glv(p.c);
    const e = p.e ? ` ipE = ${glv(p.e)};` : '';
    lines.push(`${k === 0 ? 'if' : 'else if'} (ip < ${(k + 0.5).toFixed(1)}) { ipBase = ${base}; ipR = ${p.r.toFixed(3)}; ipM = ${p.m.toFixed(3)};${e} }`);
  });
  return lines.join('\n');
}
function tintGlsl(): string {
  const lines = TINT_PALETTE.map((c, k) => `${k === 0 ? 'if' : 'else if'} (t < ${(k + 0.5).toFixed(1)}) return ${glv(c)};`);
  return `vec3 ipTint(float t) {\n${lines.join('\n')}\nreturn ${glv(TINT_PALETTE[0])};\n}`;
}

const _kq = new THREE.Quaternion();
const _km = new THREE.Matrix4();
const _kp = new THREE.Vector3();
const _ks = new THREE.Vector3(1, 1, 1);
const _ky = new THREE.Vector3(0, 1, 0);

/**
 * 11A-1c InteriorPropsKit: one persistent InstancedMesh (cap 260, +1 draw call). Per-instance `aProp` (variant,
 * tintIdx, emissiveScale, 0); the vertex shader collapses every vertex of the other variants and of instances farther
 * than 64 m from the camera. Zero per-frame work (instances are written once per district build).
 */
export class InteriorPropsKit {
  readonly mesh: THREE.InstancedMesh;
  private readonly prop: THREE.InstancedBufferAttribute;

  constructor(inject: CityLightInjector) {
    const geo = buildInteriorPropsKit();
    this.prop = new THREE.InstancedBufferAttribute(new Float32Array(INTERIOR_PROP_CAP * 4), 4);
    geo.setAttribute('aProp', this.prop);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, metalness: 0.1 });
    mat.onBeforeCompile = (shader) => {
      inject(shader);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nattribute float aVar;\nattribute float aPart;\nattribute float aAo;\nattribute vec4 aProp;\nvarying float vIPart;\nvarying float vIAo;\nvarying float vITint;\nvarying float vIEm;',
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          #ifdef USE_INSTANCING
            vec3 ipW = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          #else
            vec3 ipW = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          #endif
          if (abs(aVar - aProp.x) > 0.5 || length(cameraPosition - ipW) > ${INTERIOR_PROP_CULL_M.toFixed(1)}) transformed = vec3(0.0);
          vIPart = aPart;
          vIAo = aAo;
          vITint = aProp.y;
          vIEm = aProp.z;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying float vIPart;\nvarying float vIAo;\nvarying float vITint;\nvarying float vIEm;\n${tintGlsl()}`)
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
          float ip = floor(vIPart + 0.5);
          vec3 ipBase = vec3(0.3);
          float ipR = 0.6;
          float ipM = 0.0;
          vec3 ipE = vec3(0.0);
          ${partGlsl()}
          diffuseColor.rgb = ipBase * vIAo;`,
        )
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = ipR;')
        .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = ipM;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance = ipE * vIEm;');
    };
    mat.customProgramCacheKey = () => 'strand-interior-props-v1';
    this.mesh = new THREE.InstancedMesh(geo, mat, INTERIOR_PROP_CAP);
    this.mesh.name = 'InteriorPropsKit';
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
  }

  get count(): number {
    return this.mesh.count;
  }

  /** New district: clears every instance. */
  begin(): void {
    this.mesh.count = 0;
  }

  /**
   * Adds one instance (local +Z = front, rotated by `yaw` about +Y like Object3D.rotation.y). `tint` indexes the
   * 8-colour palette; `emissiveScale` is clamped to the 0.85–1.15 bloom guard. Returns the instance index or −1.
   */
  add(variant: number, x: number, y: number, z: number, yaw: number, tint: number, emissiveScale = 1): number {
    const i = this.mesh.count;
    if (i >= INTERIOR_PROP_CAP || variant < 0 || variant > 7) return -1;
    _kq.setFromAxisAngle(_ky, yaw);
    _km.compose(_kp.set(x, y, z), _kq, _ks);
    this.mesh.setMatrixAt(i, _km);
    const t = ((Math.floor(tint) % INTERIOR_TINT_COUNT) + INTERIOR_TINT_COUNT) % INTERIOR_TINT_COUNT;
    this.prop.setXYZW(i, variant, t, Math.min(1.15, Math.max(0.85, emissiveScale)), 0);
    this.mesh.count = i + 1;
    return i;
  }

  /** Uploads the instance buffers after a district build. */
  end(): void {
    this.mesh.instanceMatrix.needsUpdate = true;
    this.prop.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

/**
 * Phase 11B registration record for one placed prop: world AABB centre / half extents of the yawed envelope
 * (v0 sits on the counter top: worldPos.y is the envelope centre above `y`).
 */
export function interiorPropRecord(instIndex: number, variant: number, x: number, y: number, z: number, yaw: number, tint: number, floorY: number): InteriorPropRecord {
  const b = INTERIOR_PROP_BOUNDS[variant] ?? INTERIOR_PROP_BOUNDS[0];
  const c = Math.abs(Math.cos(yaw));
  const s = Math.abs(Math.sin(yaw));
  const hx = (b.w * c + b.d * s) / 2;
  const hz = (b.w * s + b.d * c) / 2;
  return {
    instIndex,
    variant,
    worldPos: new THREE.Vector3(x, y + b.h / 2, z),
    halfExtents: new THREE.Vector3(hx, b.h / 2, hz),
    floorY,
    tint,
    destructible: INTERIOR_PROP_DESTRUCTIBLE.includes(variant),
  };
}

// =============================================================================================
// 11A-1 room planning
// =============================================================================================
export interface InteriorFrame {
  readonly ax: Axis;
  readonly sg: 1 | -1;
  readonly plane: number;
}
type Frame = InteriorFrame;
const alongOf = (ax: Axis): Axis => (ax === 'x' ? 'z' : 'x');
const spanOf = (b: Rect, axis: Axis): [number, number] => (axis === 'x' ? [b.x0, b.x1] : [b.z0, b.z1]);
const planeOf = (b: Rect, ax: Axis, sg: number): number => (ax === 'x' ? (sg > 0 ? b.x1 : b.x0) : sg > 0 ? b.z1 : b.z0);
const EPS = 1e-6;

interface Slot {
  c: number;
  max: number;
}

/** Opening centres per bay of a face (1F: inside the pier grid, ≥ pier gap + jamb clear of both piers). */
function fitSlots(f: InteriorHostFace, lo: number, hi: number, w: number, ground: boolean): Slot[] {
  const J = INTERIOR.JAMB_M;
  const gap = INTERIOR.PIER_GAP_M;
  const bays: Array<[number, number]> = ground && f.a1 - f.a0 >= 3 ? groundBayGrid(f.a0, f.a1).bays : [[f.a0 - gap - J, f.a1 + gap + J]];
  const out: Slot[] = [];
  for (const [b0, b1] of bays) {
    const u0 = Math.max(b0 + gap + J, lo, f.a0 + J);
    const u1 = Math.min(b1 - gap - J, hi, f.a1 - J);
    if (u1 - u0 < w - 1e-9) continue;
    if (f.blocked?.some(([c0, c1]) => u1 + J + 0.3 > c0 && u0 - J - 0.3 < c1)) continue;
    out.push({ c: (u0 + u1) / 2, max: u1 - u0 });
  }
  return out;
}

/**
 * Fallback slots ignoring the 1F pier rhythm (the CityBuilder drops any pier an opening overlaps): free intervals of
 * [lo, hi] minus the blocked ranges; an interval long enough for door + glass is split into a door slot and a glass
 * slot (≥ 0.3 m solid between their jambs).
 */
function freeSlots(f: InteriorHostFace, lo: number, hi: number, doorW: number): Slot[] {
  const J = INTERIOR.JAMB_M;
  let iv: Array<[number, number, number, number]> = [[Math.max(lo, f.a0 + J), Math.min(hi, f.a1 - J), 0, 1]];
  for (const [c0, c1] of f.blocked ?? []) iv = subRects(iv, [c0 - 0.3 - J, c1 + 0.3 + J, -1, 2]);
  const out: Slot[] = [];
  for (const [u0, u1] of iv) {
    if (u1 - u0 < doorW - EPS) continue;
    const split = u0 + doorW + 2 * J + 0.3;
    if (u1 - split >= INTERIOR.WINDOW_MIN_W_M - EPS) {
      out.push({ c: u0 + doorW / 2, max: doorW });
      out.push({ c: (split + u1) / 2, max: u1 - split });
    } else out.push({ c: (u0 + u1) / 2, max: u1 - u0 });
  }
  return out;
}

interface Ctx {
  readonly halfExtent: number;
}

/** Walkable clear depth in front of a face (street / alley depth, capped by the lockdown wall ±(H − 0.5)). */
function walkClear(f: { sg: number; plane: number; clear: number }, ctx: Ctx): number {
  const toWall = f.sg * f.plane > 0 ? ctx.halfExtent - 0.5 - Math.abs(f.plane) : Infinity;
  return Math.min(f.clear, toWall);
}

function openable(f: InteriorHostFace, host: InteriorHost): boolean {
  const key = faceKeyOf(f.ax, f.sg);
  if (f.run) return false;
  // A run key only protects the lot-boundary plane: an L courtyard wall sharing the key is a different wall.
  if (host.runKeys.has(key) && Math.abs(f.plane - planeOf(host.lot, f.ax, f.sg)) < 1e-6) return false;
  if (host.gallery && host.gallery.faceKey === key) return false; // gallery face: stairs / columns in front of 1F
  return true;
}

function faceOnBox(f: InteriorHostFace, b: MassBox): boolean {
  if (Math.abs(f.plane - planeOf(b, f.ax, f.sg)) > EPS) return false;
  const [a0, a1] = spanOf(b, alongOf(f.ax));
  return f.a0 < a1 - EPS && f.a1 > a0 + EPS;
}

interface RoomSpec {
  template: InteriorTemplate;
  boxIndex: number;
  F: Frame;
  ra0: number;
  ra1: number;
  D: number;
  floorY: number;
  openings: InteriorOpening[];
  seed: number;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Opening on the main face F (along coordinates). */
function opF(kind: OpeningKind, F: Frame, a0: number, a1: number, y0: number, y1: number, faceId: number): InteriorOpening {
  return { kind, ax: F.ax, sg: F.sg, plane: F.plane, a0, a1, y0, y1, faceId };
}

/** EATERY / TECH_SHOP on a 1F street face (corner room + side door when a perpendicular face is openable). */
function planShop(t: 'EATERY' | 'TECH_SHOP', host: InteriorHost, strict: boolean, rng: () => number, ctx: Ctx, needGlass = false): RoomSpec | null {
  const [minW, maxW, minD, maxD] = INTERIOR_FOOTPRINT[t];
  const prog: GroundProgram = t === 'EATERY' ? 'CYBER_EATERY' : 'TECH_APPAREL';
  const C = INTERIOR.CORNER_M;
  const M = INTERIOR.MARGIN_M;
  const faces = host.faces
    .filter((f) => openable(f, host) && walkClear(f, ctx) >= INTERIOR.WALK_CLEAR_M && f.y1 >= INTERIOR_CEIL_ABOVE_FLOOR_M + 0.25)
    .filter((f) => !strict || (f.program === prog && !f.alley))
    .map((f) => ({ f, k: (f.program === prog ? 4 : 0) + (f.alley ? 0 : 2) + (f.a1 - f.a0) * 0.01 + rng() }))
    .sort((p, q) => q.k - p.k)
    .map((e) => e.f);
  let top: { k: number; spec: RoomSpec } | null = null;
  for (const f of faces) {
    for (let bi = 0; bi < host.boxes.length; bi++) {
      const b = host.boxes[bi];
      if (b.y0 > 0.01 || b.y1 < INTERIOR_CEIL_ABOVE_FLOOR_M + 0.25 || !faceOnBox(f, b)) continue;
      const alongAx = alongOf(f.ax);
      const [bA0, bA1] = spanOf(b, alongAx);
      const [bN0, bN1] = spanOf(b, f.ax);
      const boxW = bA1 - bA0;
      const boxD = bN1 - bN0;
      if (boxW < minW + INTERIOR.FOOT_PAD_M || boxD < minD + INTERIOR.FOOT_PAD_M) continue;
      const W = Math.max(minW, Math.min(lerp(minW, maxW, rng()), maxW, boxW - INTERIOR.FOOT_PAD_M));
      const D = Math.max(minD, Math.min(lerp(minD, maxD, rng()), maxD, boxD - INTERIOR.FOOT_PAD_M));
      const F: Frame = { ax: f.ax, sg: f.sg, plane: f.plane };
      const nLo = Math.min(f.plane, f.plane - f.sg * D);
      const nHi = Math.max(f.plane, f.plane - f.sg * D);
      // Side faces at either along end of the box.
      const sideAt = (end: 1 | -1): InteriorHostFace | null => {
        const p = end > 0 ? bA1 : bA0;
        for (const s of host.faces) {
          if (s.ax !== alongAx || s.sg !== end || Math.abs(s.plane - p) > EPS) continue;
          if (!openable(s, host) || walkClear(s, ctx) < INTERIOR.WALK_CLEAR_M || !faceOnBox(s, b)) continue;
          if (s.a1 < nLo + C + 1.5 || s.a0 > nHi - C - 1.5) continue;
          return s;
        }
        return null;
      };
      // Candidate room positions: corner rooms (side door) with pier-aligned widths, mid-face rooms centred on a
      // pier (two symmetric ≥ 2.4 m slots) or at a seeded offset. The option with the richest opening set wins.
      const options: Array<{ ra0: number; ra1: number; side: InteriorHostFace | null }> = [];
      const piers = f.a1 - f.a0 >= 3 ? groundBayGrid(f.a0, f.a1).piers : [];
      const wMax = Math.min(maxW, boxW - INTERIOR.FOOT_PAD_M);
      const ends: Array<1 | -1> = rng() < 0.5 ? [1, -1] : [-1, 1];
      for (const end of ends) {
        const s = sideAt(end);
        if (!s) continue;
        const widths = [W, wMax, ...piers.map((p) => (end > 0 ? bA1 - (p - 0.04) : p + 0.04 - bA0)).filter((w) => w >= minW - EPS && w <= wMax + EPS)];
        for (const w of widths) {
          if (end > 0 && f.a1 >= bA1 - EPS && bA1 - w >= Math.max(f.a0, bA0 + M) - EPS) options.push({ ra0: bA1 - w, ra1: bA1, side: s });
          if (end < 0 && f.a0 <= bA0 + EPS && bA0 + w <= Math.min(f.a1, bA1 - M) + EPS) options.push({ ra0: bA0, ra1: bA0 + w, side: s });
        }
      }
      const lo = Math.max(f.a0, bA0) + M;
      const hi = Math.min(f.a1, bA1) - M;
      // Rooms clearing a blocked range (fire escape, dock, spine) on either side, flush against it.
      for (const [c0, c1] of f.blocked ?? []) {
        for (const w of [W, wMax]) {
          if (c1 + 0.3 >= lo - EPS && c1 + 0.3 + w <= hi + EPS) options.push({ ra0: c1 + 0.3, ra1: c1 + 0.3 + w, side: null });
          if (c0 - 0.3 - w >= lo - EPS && c0 - 0.3 <= hi + EPS) options.push({ ra0: c0 - 0.3 - w, ra1: c0 - 0.3, side: null });
        }
        for (const end of ends) {
          const sEnd = sideAt(end);
          if (!sEnd) continue;
          const w = end > 0 ? bA1 - (c1 + 0.3) : c0 - 0.3 - bA0;
          if (w < minW - EPS || w > wMax + EPS) continue;
          if (end > 0 && f.a1 >= bA1 - EPS && bA1 - w >= Math.max(f.a0, bA0 + M) - EPS) options.push({ ra0: bA1 - w, ra1: bA1, side: sEnd });
          if (end < 0 && f.a0 <= bA0 + EPS && bA0 + w <= Math.min(f.a1, bA1 - M) + EPS) options.push({ ra0: bA0, ra1: bA0 + w, side: sEnd });
        }
      }
      for (const w of [W, wMax]) {
        if (hi - lo < w - EPS) continue;
        for (const p of piers) if (p - w / 2 >= lo - EPS && p + w / 2 <= hi + EPS) options.push({ ra0: p - w / 2, ra1: p + w / 2, side: null });
        if (w === wMax) options.push({ ra0: (lo + hi - w) / 2, ra1: (lo + hi + w) / 2, side: null });
      }
      if (hi - lo >= W - EPS) {
        const ra0 = lo + (hi - lo - W) * rng();
        options.push({ ra0, ra1: ra0 + W, side: null });
      }
      const doorW = t === 'EATERY' ? INTERIOR.DOOR_W_M : INTERIOR.TECH_DOOR_W_M;
      const winY0 = t === 'TECH_SHOP' ? 0.1 : INTERIOR.SILL_M;
      const winY1 = t === 'TECH_SHOP' ? 3.05 : INTERIOR.SILL_M + 2.05;
      const sw = INTERIOR.SERVICE_DOOR_W_M;
      let best: { o: (typeof options)[number]; openings: InteriorOpening[]; score: number } | null = null;
      const variants: Array<{ o: (typeof options)[number]; free: boolean }> = [];
      for (const o of options) variants.push({ o, free: false }, { o, free: true });
      for (const { o, free } of variants) {
        const slots = free ? freeSlots(f, o.ra0 + C, o.ra1 - C, doorW) : fitSlots(f, o.ra0 + C, o.ra1 - C, doorW, true);
        if (slots.length === 0) continue;
        const openings: InteriorOpening[] = [];
        // Front door takes the narrowest slot nearest the room centre; the wider slots take the shopfront glass.
        const mid = (o.ra0 + o.ra1) / 2;
        const byFit = [...slots].sort((p, q) => (p.max >= INTERIOR.WINDOW_MIN_W_M ? 1 : 0) - (q.max >= INTERIOR.WINDOW_MIN_W_M ? 1 : 0) || Math.abs(p.c - mid) - Math.abs(q.c - mid));
        const door = slots.length > 1 && byFit.filter((s) => s.max >= INTERIOR.WINDOW_MIN_W_M).length === slots.length ? [...slots].sort((p, q) => p.max - q.max)[0] : byFit[0];
        openings.push(opF('DOOR', F, door.c - doorW / 2, door.c + doorW / 2, 0, INTERIOR.DOOR_H_M, f.id));
        const rest = slots.filter((s) => s !== door);
        const glass = rest.filter((s) => s.max >= INTERIOR.WINDOW_MIN_W_M).sort((p, q) => q.max - p.max);
        // No openable side face and no spare slot: the tech shop's farthest glass bay becomes the service door.
        const winSlots = t === 'EATERY' ? glass.slice(0, 1) : !o.side && glass.length >= 2 && !rest.some((s) => !glass.includes(s) && s.max >= sw) ? glass.slice(0, -1) : glass;
        for (const s of winSlots) {
          const w = Math.min(t === 'TECH_SHOP' ? 3.3 : 3.2, s.max, INTERIOR.WINDOW_MAX_W_M);
          openings.push(opF('WINDOW', F, s.c - w / 2, s.c + w / 2, winY0, winY1, f.id));
        }
        let sideDoor = false;
        if (o.side) {
          const s = o.side;
          const sl = fitSlots(s, nLo + C, nHi - C, sw, true);
          if (!sl.length) continue;
          // Deepest slot (farthest from the street face): kitchen / stock-room flank route.
          const deep = sl.reduce((p, q) => (Math.abs(q.c - f.plane) > Math.abs(p.c - f.plane) ? q : p));
          openings.push({ kind: 'DOOR', ax: s.ax, sg: s.sg, plane: s.plane, a0: deep.c - sw / 2, a1: deep.c + sw / 2, y0: 0, y1: INTERIOR.DOOR_H_M, faceId: s.id });
          sideDoor = true;
        } else {
          // No openable side face: a leftover slot becomes the rear / service door on the front face.
          const spare = rest.filter((s) => !winSlots.includes(s) && s.max >= sw);
          if (spare.length) {
            const far = spare.reduce((p, q) => (Math.abs(q.c - door.c) > Math.abs(p.c - door.c) ? q : p));
            openings.push(opF('DOOR', F, far.c - sw / 2, far.c + sw / 2, 0, INTERIOR.DOOR_H_M, f.id));
          }
        }
        const nWin = openings.filter((op) => op.kind === 'WINDOW').length;
        const nDoor = openings.filter((op) => op.kind === 'DOOR').length;
        // Shopfront glass first, then a second (flank / service) door, then extra glass.
        const score = Math.min(nWin, 1) * 4 + (nDoor >= 2 ? 3 : 0) + (sideDoor ? 0.5 : 0) + Math.min(nWin, t === 'EATERY' ? 1 : 2) * 0.5 + nWin * 0.05 - (free ? 0.3 : 0);
        if (!best || score > best.score + 1e-9) best = { o, openings, score };
      }
      // Best layout across every face / box of the host (program-matching street faces get a bonus).
      if (best) {
        const k = best.score + (f.program === prog ? 0.6 : 0) + (f.alley ? 0 : 0.3);
        if (!top || k > top.k + 1e-9) top = { k, spec: { template: t, boxIndex: bi, F, ra0: best.o.ra0, ra1: best.o.ra1, D, floorY: 0, openings: best.openings, seed: 0 } };
      }
    }
  }
  if (!top || (needGlass && !top.spec.openings.some((o) => o.kind === 'WINDOW'))) return null;
  return { ...top.spec, seed: Math.floor(rng() * 1e9) };
}

/**
 * Lobby end of an arcade on face `f` over the along range [lo, hi]: kickable 1.50–1.60 m doors at both ends of the
 * lobby wall with a 2.4–3.2 m glass lobby partition between them when the wall is long enough; otherwise two doors
 * (≥ 0.8 m solid between), else door + glass, else a single door (placed at the `doorHigh` end).
 */
function lobbyEnd(f: InteriorHostFace, lo: number, hi: number, doorHigh: boolean, y0: number): InteriorOpening[] {
  const J = INTERIOR.JAMB_M;
  const L = hi - lo;
  const door = (a0: number, w: number): InteriorOpening => ({ kind: 'DOOR', ax: f.ax, sg: f.sg, plane: f.plane, a0, a1: a0 + w, y0, y1: y0 + INTERIOR.DOOR_H_M, faceId: f.id });
  const glass = (a0: number, w: number): InteriorOpening => ({ kind: 'WINDOW', ax: f.ax, sg: f.sg, plane: f.plane, a0, a1: a0 + w, y0: y0 + 0.1, y1: y0 + 2.95, faceId: f.id });
  const dw = 1.5;
  const gap = 2 * J + 0.1;
  const gw = Math.min(3.2, L - 2 * dw - 2 * gap);
  if (gw >= INTERIOR.WINDOW_MIN_W_M - EPS) {
    const g0 = lo + dw + gap + (L - 2 * dw - 2 * gap - gw) / 2;
    return [door(lo, dw), glass(g0, gw), door(hi - dw, dw)];
  }
  if (L >= 2 * dw + 2 * J + 0.8 - EPS) return [door(lo, dw), door(hi - dw, dw)];
  const dw1 = INTERIOR.ARCADE_DOOR_W_M;
  if (L < dw1 - EPS) return L >= INTERIOR.DOOR_W_M - EPS ? [door(doorHigh ? hi - INTERIOR.DOOR_W_M : lo, INTERIOR.DOOR_W_M)] : [];
  const d0 = doorHigh ? hi - dw1 : lo;
  const out = [door(d0, dw1)];
  const g0 = doorHigh ? lo : d0 + dw1 + gap;
  const g1 = doorHigh ? d0 - gap : hi;
  const w = Math.min(3.2, g1 - g0);
  if (w >= INTERIOR.WINDOW_MIN_W_M - EPS) out.push(glass(doorHigh ? g1 - w : g0, w));
  return out;
}

const freeOf = (f: InteriorHostFace, a0: number, a1: number): boolean => !f.blocked?.some(([c0, c1]) => a1 + 0.3 > c0 && a0 - 0.3 < c1);

/**
 * PASS_ARCADE: covered 4.5 m × 3.5 m breezeway / hotel lobby. Open archway on the main face; the far end is a lobby
 * wall with a kickable door + glass partition, either straight through the box (opposite face) or — when the
 * opposite face is a wall-run face — around the corner (perpendicular face), so the arcade always links two streets.
 */
function planArcade(host: InteriorHost, strict: boolean, rng: () => number, ctx: Ctx): RoomSpec | null {
  const C = INTERIOR.CORNER_M;
  const Wr = INTERIOR.ARCADE_W_M + 2 * C;
  const M = INTERIOR.MARGIN_M;
  const boxIdx = host.massing === 'PODIUM_OFFSET' ? [0] : host.boxes.map((_, i) => i);
  const ok = (f: InteriorHostFace): boolean => openable(f, host) && walkClear(f, ctx) >= INTERIOR.WALK_CLEAR_M && f.y1 >= INTERIOR_CEIL_ABOVE_FLOOR_M + 0.25;
  const eligibleHost = host.massing === 'PODIUM_OFFSET' || host.massing === 'L_SHAPE';
  type Cand = { bi: number; F: InteriorHostFace; O: InteriorHostFace; through: boolean; k: number };
  const cands: Cand[] = [];
  for (const bi of boxIdx) {
    const b = host.boxes[bi];
    if (!b || b.y0 > 0.01 || b.y1 < INTERIOR_CEIL_ABOVE_FLOOR_M + 0.25) continue;
    for (const F of host.faces) {
      if (!ok(F) || !faceOnBox(F, b)) continue;
      for (const O of host.faces) {
        if (O === F || !ok(O) || !faceOnBox(O, b)) continue;
        const through = O.ax === F.ax && O.sg === -F.sg;
        if (!through && O.ax === F.ax) continue;
        const hotel = F.program === 'CAPSULE_HOTEL' || O.program === 'CAPSULE_HOTEL';
        if (strict && !hotel && !eligibleHost) continue;
        // Main (open archway) face: the street side; alley / courtyard faces take the lobby end.
        if (F.alley && !O.alley) continue;
        cands.push({ bi, F, O, through, k: (hotel ? 4 : 0) + (eligibleHost ? 2 : 0) + (through ? 1 : 0) + (F.alley ? 0 : 1) + rng() });
      }
    }
  }
  cands.sort((p, q) => q.k - p.k);
  for (const { bi, F, O, through } of cands) {
    const b = host.boxes[bi];
    const [bA0, bA1] = spanOf(b, alongOf(F.ax));
    const [bN0, bN1] = spanOf(b, F.ax);
    const Fr: Frame = { ax: F.ax, sg: F.sg, plane: F.plane };
    if (through) {
      const D = bN1 - bN0;
      if (D < 4 || bA1 - bA0 < Wr + 2 * M) continue;
      const I0 = Math.max(F.a0, O.a0, bA0 + M);
      const I1 = Math.min(F.a1, O.a1, bA1 - M);
      if (I1 - I0 < Wr - EPS) continue;
      const hw = Wr / 2;
      const free = (c: number): boolean => freeOf(F, c - hw, c + hw) && freeOf(O, c - hw, c + hw);
      const bayC = (F.a1 - F.a0 >= 3 ? groundBayGrid(F.a0, F.a1).bays : []).map(([b0, b1]) => (b0 + b1) / 2).filter((c) => c - hw >= I0 - EPS && c + hw <= I1 + EPS && free(c));
      let c: number;
      if (bayC.length) c = bayC[Math.min(bayC.length - 1, Math.floor(rng() * bayC.length))];
      else {
        c = (I0 + I1) / 2;
        if (!free(c)) continue;
      }
      const ra0 = c - hw;
      const ra1 = c + hw;
      const openings: InteriorOpening[] = [opF('ARCADE', Fr, ra0 + C, ra1 - C, 0, INTERIOR.ARCADE_H_M, F.id), ...lobbyEnd(O, ra0 + C, ra1 - C, rng() < 0.5, 0)];
      return { template: 'PASS_ARCADE', boxIndex: bi, F: Fr, ra0, ra1, D, floorY: 0, openings, seed: Math.floor(rng() * 1e9) };
    }
    // Corner arcade: archway on F at the box end where the perpendicular face O stands, lobby end on O.
    const end: 1 | -1 = O.sg;
    const pO = end > 0 ? bA1 : bA0;
    if (Math.abs(O.plane - pO) > EPS) continue;
    if (end > 0 ? F.a1 < bA1 - EPS : F.a0 > bA0 + EPS) continue;
    const ra0 = end > 0 ? bA1 - Wr : bA0;
    const ra1 = ra0 + Wr;
    if (end > 0 ? ra0 < Math.max(F.a0, bA0 + M) - EPS : ra1 > Math.min(F.a1, bA1 - M) + EPS) continue;
    const boxD = bN1 - bN0;
    const D = Math.min(lerp(Wr, 8.0, rng()), boxD - INTERIOR.FOOT_PAD_M);
    if (D < Wr - EPS) continue;
    const nLo = Math.min(F.plane, F.plane - F.sg * D);
    const nHi = Math.max(F.plane, F.plane - F.sg * D);
    const lo = Math.max(nLo + C, O.a0 + INTERIOR.JAMB_M);
    const hi = Math.min(nHi - C, O.a1 - INTERIOR.JAMB_M);
    if (!freeOf(F, ra0 + C, ra1 - C) || !freeOf(O, lo, hi)) continue;
    // Door at the end farther from the street corner (deep in the lobby), glass toward the archway.
    const doorHigh = F.sg < 0;
    const lobby = lobbyEnd(O, lo, hi, doorHigh, 0);
    if (!lobby.length) continue;
    const openings: InteriorOpening[] = [opF('ARCADE', Fr, ra0 + C, ra1 - C, 0, INTERIOR.ARCADE_H_M, F.id), ...lobby];
    return { template: 'PASS_ARCADE', boxIndex: bi, F: Fr, ra0, ra1, D, floorY: 0, openings, seed: Math.floor(rng() * 1e9) };
  }
  return null;
}

/** APARTMENT on a GALLERY_DANCHI 2F / 3F deck: front door on the gallery face + 2.8 × 2.0 window. */
function planApartment(host: InteriorHost, rng: () => number, ctx: Ctx): RoomSpec | null {
  const gal = host.gallery;
  if (!gal || gal.deckYs.length === 0) return null;
  const [gaxS, gsgS] = gal.faceKey.split(':');
  const gax: Axis = gaxS === 'z' ? 'z' : 'x';
  const gsg: 1 | -1 = Number(gsgS) > 0 ? 1 : -1;
  const b = host.boxes[0];
  if (!b) return null;
  const [minW, maxW, minD, maxD] = INTERIOR_FOOTPRINT.APARTMENT;
  const C = INTERIOR.CORNER_M;
  const M = INTERIOR.MARGIN_M;
  const J = INTERIOR.JAMB_M;
  const alongAx = alongOf(gax);
  const [bA0, bA1] = spanOf(b, alongAx);
  const [bN0, bN1] = spanOf(b, gax);
  const boxW = bA1 - bA0;
  const boxD = bN1 - bN0;
  if (boxW < minW + INTERIOR.FOOT_PAD_M || boxD < minD + INTERIOR.FOOT_PAD_M) return null;
  const plane = planeOf(b, gax, gsg);
  const gf = host.faces.find((f) => f.ax === gax && f.sg === gsg && Math.abs(f.plane - plane) < EPS);
  const ga0 = gal.a0 ?? (gf ? Math.max(gf.a0, bA0) : bA0);
  const ga1 = gal.a1 ?? (gf ? Math.min(gf.a1, bA1) : bA1);
  const e0 = ga0 + GRAMMAR.GALLERY_END_PIER_M;
  const e1 = ga1 - GRAMMAR.GALLERY_END_PIER_M;
  const slotsG: number[] = [];
  for (let a = e0 + 2; a <= e1 - 1.2 + 1e-9; a += GRAMMAR.GALLERY_DOOR_SPACING_M) slotsG.push(a);
  const W = Math.max(minW, Math.min(lerp(minW, maxW, rng()), maxW, boxW - INTERIOR.FOOT_PAD_M));
  const D = Math.max(minD, Math.min(lerp(minD, maxD, rng()), maxD, boxD - INTERIOR.FOOT_PAD_M));
  const F: Frame = { ax: gax, sg: gsg, plane };
  const nLo = Math.min(plane, plane - gsg * D);
  const nHi = Math.max(plane, plane - gsg * D);
  const decks = gal.deckYs.map((y) => ({ y, k: rng() })).sort((p, q) => p.k - q.k).map((e) => e.y);
  const dw = INTERIOR.DOOR_W_M;
  const doorIn = (lo: number, hi: number, avoid?: readonly [number, number]): number | null => {
    const l = Math.max(lo, e0 + 0.1) + dw / 2 + J;
    const h = Math.min(hi, e1 - 0.1) - dw / 2 - J;
    if (h < l - EPS) return null;
    const clear = (c: number): boolean => !avoid || c + dw / 2 + J + 0.3 <= avoid[0] || c - dw / 2 - J - 0.3 >= avoid[1];
    const slot = slotsG.filter((a) => a >= l - EPS && a <= h + EPS && clear(a));
    if (slot.length) return slot[Math.floor(rng() * slot.length) % slot.length];
    const mid = (l + h) / 2;
    return clear(mid) ? mid : null;
  };
  for (const deckY of decks) {
    const floorY = deckY;
    const ceilY = floorY + INTERIOR_CEIL_ABOVE_FLOOR_M;
    if (b.y1 < ceilY + 0.25 || floorY - INTERIOR.SLAB_M - b.y0 < 0.25) continue;
    const wy0 = floorY + INTERIOR.SILL_M;
    const wy1 = wy0 + INTERIOR.APT_WINDOW_H_M;
    const ends: Array<1 | -1> = rng() < 0.5 ? [1, -1] : [-1, 1];
    for (const end of ends) {
      const p = end > 0 ? bA1 : bA0;
      const s = host.faces.find(
        (f) =>
          f.ax === alongAx &&
          f.sg === end &&
          Math.abs(f.plane - p) < EPS &&
          openable(f, host) &&
          walkClear(f, ctx) >= INTERIOR.WINDOW_CLEAR_M &&
          f.y1 >= ceilY + 0.25,
      );
      if (!s) continue;
      const ra0 = end > 0 ? bA1 - W : bA0;
      const ra1 = ra0 + W;
      const sl = fitSlots(s, nLo + C, nHi - C, INTERIOR.APT_WINDOW_W_M, false);
      if (!sl.length) continue;
      const dc = doorIn(ra0 + C, ra1 - C);
      if (dc === null) continue;
      const ww = INTERIOR.APT_WINDOW_W_M;
      const openings: InteriorOpening[] = [
        opF('DOOR', F, dc - dw / 2, dc + dw / 2, floorY, floorY + INTERIOR.DOOR_H_M, -1),
        { kind: 'WINDOW', ax: s.ax, sg: s.sg, plane: s.plane, a0: sl[0].c - ww / 2, a1: sl[0].c + ww / 2, y0: wy0, y1: wy1, faceId: s.id },
      ];
      return { template: 'APARTMENT', boxIndex: 0, F, ra0, ra1, D, floorY, openings, seed: Math.floor(rng() * 1e9) };
    }
    // Fallback: mid-face room, door and window both on the gallery face (window looks onto the deck).
    const lo = Math.max(ga0 + M, e0);
    const hi = Math.min(ga1 - M, e1);
    if (hi - lo < W - EPS) continue;
    const ra0 = lo + (hi - lo - W) * rng();
    const ra1 = ra0 + W;
    const ww = INTERIOR.APT_WINDOW_W_M;
    // Window at one end of the room, door in the remaining stretch.
    const winLeft = rng() < 0.5;
    const wa0 = winLeft ? ra0 + C : ra1 - C - ww;
    const wa1 = wa0 + ww;
    const dc = doorIn(winLeft ? wa1 + J + 0.3 : ra0 + C, winLeft ? ra1 - C : wa0 - J - 0.3, [wa0 - J, wa1 + J]);
    if (dc === null) continue;
    const openings: InteriorOpening[] = [
      opF('DOOR', F, dc - dw / 2, dc + dw / 2, floorY, floorY + INTERIOR.DOOR_H_M, -1),
      opF('WINDOW', F, wa0, wa1, wy0, wy1, -1),
    ];
    return { template: 'APARTMENT', boxIndex: 0, F, ra0, ra1, D, floorY, openings, seed: Math.floor(rng() * 1e9) };
  }
  return null;
}

// =============================================================================================
// 11A-1 room envelope + template dressing
// =============================================================================================
/** Local (along a, depth v from the main face plane) rectangle. */
interface LRect {
  a0: number;
  a1: number;
  v0: number;
  v1: number;
}
const lHit = (p: LRect, q: LRect, gap = 0): boolean => p.a0 < q.a1 + gap - EPS && q.a0 < p.a1 + gap - EPS && p.v0 < q.v1 + gap - EPS && q.v0 < p.v1 + gap - EPS;

/** 2D rectangle subtraction (along × height or along × depth). */
function subRects(rects: Array<[number, number, number, number]>, c: readonly [number, number, number, number]): Array<[number, number, number, number]> {
  const out: Array<[number, number, number, number]> = [];
  const [c0, c1, d0, d1] = c;
  for (const [a0, a1, y0, y1] of rects) {
    if (c1 <= a0 + EPS || c0 >= a1 - EPS || d1 <= y0 + EPS || d0 >= y1 - EPS) {
      out.push([a0, a1, y0, y1]);
      continue;
    }
    if (c0 > a0 + EPS) out.push([a0, c0, y0, y1]);
    if (c1 < a1 - EPS) out.push([c1, a1, y0, y1]);
    const m0 = Math.max(a0, c0);
    const m1 = Math.min(a1, c1);
    if (d0 > y0 + EPS) out.push([m0, m1, y0, d0]);
    if (d1 < y1 - EPS) out.push([m0, m1, d1, y1]);
  }
  return out;
}

const mulberry = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export interface InteriorShellInput {
  readonly template: InteriorTemplate;
  /** Main open face (street face; gallery face for apartments). */
  readonly frame: Frame;
  /** Room along range on the main face. */
  readonly a0: number;
  readonly a1: number;
  /** Room depth into the box from the main face plane. */
  readonly depth: number;
  readonly floorY: number;
  readonly openings: readonly InteriorOpening[];
  /** Deterministic dressing seed (prop tints / slat rhythm). */
  readonly seed: number;
}

interface Dressed {
  room: MassBox;
  ceilY: number;
  shell: ShellPiece[];
  structure: Aabb3[];
  solids: Aabb3[];
  props: Array<{ variant: number; x: number; y: number; z: number; yaw: number; tint: number }>;
  lights: Array<{ x: number; y: number; z: number; color: number; intensity: number }>;
  inner: Aabb3;
}

/** Room box for a frame / along range / depth / height range. */
function roomBoxOf(F: Frame, a0: number, a1: number, D: number, y0: number, y1: number): MassBox {
  const n0 = F.plane;
  const n1 = F.plane - F.sg * D;
  const lo = Math.min(n0, n1);
  const hi = Math.max(n0, n1);
  return F.ax === 'x' ? { x0: lo, x1: hi, z0: a0, z1: a1, y0, y1 } : { x0: a0, x1: a1, z0: lo, z1: hi, y0, y1 };
}

type Facing = 'F' | 'B' | 'L' | 'R';

/** Builds the room envelope, template dressing, props and lights (pure; used by `planInteriors`). */
function dressRoom(inp: InteriorShellInput): Dressed {
  const T = INTERIOR.WALL_M;
  const J = INTERIOR.JAMB_M;
  const { frame: F, a0: ra0, a1: ra1, depth: D, floorY, template: tpl } = inp;
  const ceilY = floorY + INTERIOR_CEIL_ABOVE_FLOOR_M;
  const upper = floorY > 0.01;
  const yR0 = upper ? floorY - INTERIOR.SLAB_M : floorY;
  const R = roomBoxOf(F, ra0, ra1, D, yR0, ceilY);
  const rng = mulberry(inp.seed);
  const shell: ShellPiece[] = [];
  const structure: Aabb3[] = [];
  const solids: Aabb3[] = [];
  const props: Dressed['props'] = [];
  const lights: Dressed['lights'] = [];
  const wallAo = tpl === 'APARTMENT' ? INTERIOR.APT_WALL_AO : INTERIOR.WALL_AO;
  const lightCol = INTERIOR_LIGHT_COLOR[tpl];
  const arcade = tpl === 'PASS_ARCADE';

  // ---- local frame helpers -------------------------------------------------------------
  const nAt = (v: number): number => F.plane - F.sg * v;
  const W3 = (a0: number, a1: number, v0: number, v1: number, y0: number, y1: number): Aabb3 => {
    const n0 = nAt(v0);
    const n1 = nAt(v1);
    const lo = Math.min(n0, n1);
    const hi = Math.max(n0, n1);
    return F.ax === 'x' ? { minX: lo, maxX: hi, minZ: a0, maxZ: a1, minY: y0, maxY: y1 } : { minX: a0, maxX: a1, minZ: lo, maxZ: hi, minY: y0, maxY: y1 };
  };
  const toPiece = (bucket: ShellPiece['bucket'], b: Aabb3, extra: { ao?: number; color?: number; emissive?: number } = {}): ShellPiece => ({
    bucket,
    x0: b.minX,
    y0: b.minY,
    z0: b.minZ,
    x1: b.maxX,
    y1: b.maxY,
    z1: b.maxZ,
    ...extra,
  });
  const piece = (bucket: ShellPiece['bucket'], a0: number, a1: number, v0: number, v1: number, y0: number, y1: number, extra: { ao?: number; color?: number; emissive?: number } = {}): void => {
    if (a1 - a0 < 1e-4 || v1 - v0 < 1e-4 || y1 - y0 < 1e-4) return;
    shell.push(toPiece(bucket, W3(a0, a1, v0, v1, floorY + y0, floorY + y1), extra));
  };
  const worldXZ = (a: number, v: number): [number, number] => (F.ax === 'x' ? [nAt(v), a] : [a, nAt(v)]);
  const dirW = (f: Facing): [number, number] => {
    const out: [number, number] = F.ax === 'x' ? [F.sg, 0] : [0, F.sg];
    if (f === 'F') return out;
    if (f === 'B') return [-out[0], -out[1]];
    const r: [number, number] = F.ax === 'x' ? [0, 1] : [1, 0];
    return f === 'R' ? r : [-r[0], -r[1]];
  };
  const yawOf = (f: Facing): number => {
    const [dx, dz] = dirW(f);
    return Math.atan2(dx, dz);
  };

  // Inner rect (inside the perimeter walls). Arcade end walls are open archways: inner runs face to face.
  const a0i = ra0 + T;
  const a1i = ra1 - T;
  const v0i = T;
  const v1i = D - T;

  // ---- perimeter walls split around the openings + steel jambs --------------------------
  const sides: Array<[Axis, 1 | -1]> = [['x', 1], ['x', -1], ['z', 1], ['z', -1]];
  for (const [ax, sg] of sides) {
    const pl = planeOf(R, ax, sg);
    const [A0, A1] = ax === 'x' ? [R.z0, R.z1] : [R.x0 + T, R.x1 - T];
    const n0 = sg > 0 ? pl - T : pl;
    const n1 = sg > 0 ? pl : pl + T;
    const jn0 = sg > 0 ? pl - T - 0.01 : pl - INTERIOR.JAMB_PROUD_M;
    const jn1 = sg > 0 ? pl + INTERIOR.JAMB_PROUD_M : pl + T + 0.01;
    const box3 = (a0: number, a1: number, y0: number, y1: number, m0: number, m1: number): Aabb3 =>
      ax === 'x' ? { minX: m0, maxX: m1, minZ: a0, maxZ: a1, minY: y0, maxY: y1 } : { minX: a0, maxX: a1, minZ: m0, maxZ: m1, minY: y0, maxY: y1 };
    const ops = inp.openings.filter((o) => o.ax === ax && o.sg === sg && Math.abs(o.plane - pl) < 1e-5);
    let rects: Array<[number, number, number, number]> = [[A0, A1, R.y0, R.y1]];
    for (const o of ops) rects = subRects(rects, [o.a0 - J, o.a1 + J, o.kind === 'WINDOW' ? o.y0 - J : R.y0 - 1, o.y1 + J]);
    for (const [a0, a1, y0, y1] of rects) {
      if (a1 - a0 < 0.004 || y1 - y0 < 0.004) continue;
      const b = box3(a0, a1, y0, y1, n0, n1);
      shell.push(toPiece('concrete', b, { ao: wallAo }));
      structure.push(b);
    }
    for (const o of ops) {
      const yb = o.kind === 'WINDOW' ? o.y0 - J : o.y0;
      const jambs: Aabb3[] = [
        box3(o.a0 - J, o.a0, yb, o.y1 + J, jn0, jn1),
        box3(o.a1, o.a1 + J, yb, o.y1 + J, jn0, jn1),
        box3(o.a0, o.a1, o.y1, o.y1 + J, jn0, jn1),
      ];
      if (o.kind === 'WINDOW') jambs.push(box3(o.a0, o.a1, o.y0 - J, o.y0, jn0, jn1));
      for (const b of jambs) {
        shell.push(toPiece('steel', b, { ao: 0.8 }));
        structure.push(b);
      }
      if (o.kind === 'DOOR' && upper) {
        const th = box3(o.a0, o.a1, floorY - INTERIOR.SLAB_M, floorY, n0, n1); // steel threshold over the wall band
        shell.push(toPiece('steel', th, { ao: 0.7 }));
        structure.push(th);
      }
    }
  }

  // ---- floor slab, soffit + recessed light troughs -------------------------------------
  const fv0 = arcade ? T : v0i;
  const fv1 = arcade ? D - T : v1i;
  if (upper) {
    piece('concrete', a0i, a1i, fv0, fv1, -INTERIOR.SLAB_M, 0, { ao: INTERIOR.FLOOR_AO });
    structure.push(W3(a0i, a1i, fv0, fv1, floorY - INTERIOR.SLAB_M, floorY));
  } else piece('concrete', a0i, a1i, fv0, fv1, 0, INTERIOR.GROUND_LIFT_M, { ao: INTERIOR.FLOOR_AO });
  const ch = INTERIOR_CEIL_ABOVE_FLOOR_M; // ceiling (local y)
  const sb = ch - INTERIOR.SOFFIT_M; // soffit bottom (local y) = clear height
  structure.push(W3(a0i, a1i, fv0, fv1, floorY + sb, floorY + ch));
  const troughs: LRect[] = [];
  const troughStrip = (r: LRect, color: number, em: number): void => {
    troughs.push(r);
    const alongA = r.a1 - r.a0 > r.v1 - r.v0;
    const ia0 = alongA ? r.a0 : r.a0 + 0.04;
    const ia1 = alongA ? r.a1 : r.a1 - 0.04;
    const iv0 = alongA ? r.v0 + 0.04 : r.v0;
    const iv1 = alongA ? r.v1 - 0.04 : r.v1;
    piece('steel', r.a0, r.a1, r.v0, r.v1, ch - 0.07, ch, { ao: 0.5 });
    piece('strips', ia0, ia1, iv0, iv1, ch - 0.12, ch - 0.07, { color, emissive: em });
  };

  // ---- template dressing ---------------------------------------------------------------
  const zones: LRect[] = []; // door swing / walk zones kept free of props & solids
  const used: LRect[] = [];
  for (const o of inp.openings) {
    if (o.kind === 'WINDOW') continue;
    const sw = o.kind === 'ARCADE' ? 1.5 : INTERIOR.DOOR_SWING_M;
    if (o.ax === F.ax) {
      const atFront = Math.abs(o.plane - F.plane) < 1e-5;
      zones.push({ a0: o.a0 - 0.1, a1: o.a1 + 0.1, v0: atFront ? v0i - 0.01 : v1i - sw, v1: atFront ? v0i + sw : v1i + 0.01 });
    } else {
      const v0 = Math.min(F.sg * (F.plane - o.a0), F.sg * (F.plane - o.a1));
      const v1 = Math.max(F.sg * (F.plane - o.a0), F.sg * (F.plane - o.a1));
      const hiEnd = Math.abs(o.plane - ra1) < 1e-5;
      zones.push({ a0: hiEnd ? a1i - sw : a0i - 0.01, a1: hiEnd ? a1i + 0.01 : a0i + sw, v0: v0 - 0.1, v1: v1 + 0.1 });
    }
  }
  const sideHasOpening = (hiEnd: boolean): boolean => inp.openings.some((o) => o.ax !== F.ax && Math.abs(o.plane - (hiEnd ? ra1 : ra0)) < 1e-5);
  const freeRect = (r: LRect, gap = 0.05): boolean =>
    r.a0 >= a0i + 0.02 - EPS && r.a1 <= a1i - 0.02 + EPS && r.v0 >= v0i + 0.02 - EPS && r.v1 <= v1i - 0.02 + EPS && !zones.some((z) => lHit(r, z)) && !used.some((u) => lHit(r, u, gap));
  const footprint = (variant: number, f: Facing, ac: number, vc: number): LRect => {
    const b = INTERIOR_PROP_BOUNDS[variant];
    const ea = f === 'F' || f === 'B' ? b.w : b.d;
    const ev = f === 'F' || f === 'B' ? b.d : b.w;
    return { a0: ac - ea / 2, a1: ac + ea / 2, v0: vc - ev / 2, v1: vc + ev / 2 };
  };
  const addProp = (variant: number, f: Facing, ac: number, vc: number, y = 0, check = true, solid = false): boolean => {
    const fp = footprint(variant, f, ac, vc);
    if (check && !freeRect(fp)) return false;
    if (check) used.push(fp);
    const [x, z] = worldXZ(ac, vc);
    props.push({ variant, x, y: floorY + y, z, yaw: yawOf(f), tint: Math.floor(rng() * INTERIOR_TINT_COUNT) });
    if (solid) solids.push(W3(fp.a0, fp.a1, fp.v0, fp.v1, floorY, floorY + INTERIOR_PROP_BOUNDS[variant].h));
    return true;
  };
  /** Props hugging a wall: tries along positions (a) at a fixed depth / along a side wall. */
  const tryAlong = (variant: number, f: Facing, vc: number, cands: number[], solid = false): boolean => cands.some((ac) => addProp(variant, f, ac, vc, 0, true, solid));
  const tryDepth = (variant: number, f: Facing, ac: number, cands: number[], solid = false): boolean => cands.some((vc) => addProp(variant, f, ac, vc, 0, true, solid));
  const steps = (lo: number, hi: number, n: number): number[] => {
    const out: number[] = [];
    for (let k = 0; k <= n; k++) out.push(lerp(lo, hi, k / n));
    return out;
  };
  const Wi = a1i - a0i;
  const Di = v1i - v0i;
  const amid = (a0i + a1i) / 2;

  if (tpl === 'EATERY') {
    // Kitchen station against the back wall, hood + backlit menu over it.
    const kb = INTERIOR_PROP_BOUNDS[1];
    const kv = v1i - kb.d / 2 - 0.02;
    const kOk = tryAlong(1, 'F', kv, [amid, amid - 0.6, amid + 0.6, a0i + kb.w / 2 + 0.05, a1i - kb.w / 2 - 0.05], true);
    const kc = kOk ? used[used.length - 1] : null;
    if (kc) {
      piece('steel', kc.a0 - 0.05, kc.a1 + 0.05, v1i - 0.95, v1i, 2.45, sb, { ao: 0.7 }); // recessed exhaust hood
      piece('steel', kc.a0, kc.a1, v1i - 0.9, v1i - 0.05, 2.4, 2.45, { ao: 0.45 }); // grease-filter band
      piece('strips', kc.a0 + 0.1, kc.a1 - 0.1, v1i - 0.97, v1i - 0.95, 2.6, 2.85, { color: 0xffa040, emissive: 0.95 }); // menu strip
    }
    // L-shaped noodle bar: long leg parallel to the back wall, short return leg toward the street.
    const cv1 = v1i - kb.d - 0.95;
    const cv0 = cv1 - 0.55;
    let la0 = a0i + 0.9;
    let la1 = a1i - 0.9;
    for (const z of zones) {
      if (z.v1 <= cv0 || z.v0 >= cv1) continue;
      if ((z.a0 + z.a1) / 2 > amid) la1 = Math.min(la1, z.a0 - 0.1);
      else la0 = Math.max(la0, z.a1 + 0.1);
    }
    if (la1 - la0 >= 1.6 && cv0 > v0i + 1.6) {
      const legs: LRect[] = [{ a0: la0, a1: la1, v0: cv0, v1: cv1 }];
      const ret = sideHasOpening(true) ? -1 : 1; // return leg away from the side door
      const sv0 = Math.max(v0i + INTERIOR.DOOR_SWING_M + 0.5, cv0 - 1.3);
      if (cv0 - sv0 >= 0.6) {
        const r: LRect = ret > 0 ? { a0: la1 - 0.55, a1: la1, v0: sv0, v1: cv0 } : { a0: la0, a1: la0 + 0.55, v0: sv0, v1: cv0 };
        if (!zones.some((z) => lHit(r, z))) legs.push(r);
      }
      const retLeg = legs[1];
      for (const g of legs) {
        const longA = g === legs[0];
        // Customer side overhang: −v for the long leg, toward the room centre for the return leg.
        const oa0 = !longA && ret < 0 ? 0 : !longA ? 0.05 : 0;
        const oa1 = !longA && ret < 0 ? 0.05 : 0;
        piece('steel', g.a0 + 0.06, g.a1 - 0.06, g.v0 + 0.06, g.v1 - 0.06, 0, 0.1, { ao: 0.55 });
        piece('archPaint', g.a0, g.a1, g.v0, g.v1, 0.1, 0.98, { color: 0x4a3426, ao: 0.85 });
        // Counter top: the long leg overhangs the customer side; the return leg's top stops where the long top begins.
        piece('archPaint', g.a0 - oa0, g.a1 + oa1, longA ? g.v0 - 0.05 : g.v0, longA ? g.v1 : g.v1 - 0.05, 0.98, INTERIOR_COUNTER_TOP_M, { color: 0x2b2b30 });
        if (longA) {
          const s0 = retLeg && ret < 0 ? retLeg.a1 + 0.05 : g.a0 + 0.05;
          const s1 = retLeg && ret > 0 ? retLeg.a0 - 0.05 : g.a1 - 0.05;
          piece('strips', s0, s1, g.v0 - 0.035, g.v0 - 0.005, 0.96, 0.98, { color: 0xffb060, emissive: 0.9 }); // under-ledge glow
        }
        solids.push(W3(g.a0, g.a1, g.v0, g.v1, floorY, floorY + INTERIOR_COUNTER_TOP_M));
        used.push({ a0: g.a0 - 0.05, a1: g.a1 + 0.05, v0: g.v0 - 0.05, v1: g.v1 });
      }
      // v0 place settings on the long leg, facing the customers (street side).
      const legLen = la1 - la0;
      const nSet = legLen >= 2.2 ? 2 : 1;
      for (let k = 0; k < nSet; k++) addProp(0, 'F', nSet === 1 ? (la0 + la1) / 2 : lerp(la0 + 0.55, la1 - 0.55, k), (cv0 + cv1) / 2, INTERIOR_COUNTER_TOP_M, false);
      // Pendant rods over the bar (rod from the soffit, shade + warm bulb at 2.2–2.35 m).
      const np = Math.max(2, Math.min(4, Math.floor(legLen / 1.1)));
      for (let k = 0; k < np; k++) {
        const pa = lerp(la0 + 0.4, la1 - 0.4, np === 1 ? 0.5 : k / (np - 1));
        const pv = (cv0 + cv1) / 2 - 0.1;
        piece('steel', pa - 0.015, pa + 0.015, pv - 0.015, pv + 0.015, 2.35, sb, { ao: 0.9 });
        piece('steel', pa - 0.13, pa + 0.13, pv - 0.13, pv + 0.13, 2.21, 2.35, { ao: 0.75 });
        piece('strips', pa - 0.07, pa + 0.07, pv - 0.07, pv + 0.07, 2.18, 2.21, { color: 0xffb070, emissive: 1.0 });
      }
      troughStrip({ a0: a0i + 0.6, a1: a1i - 0.6, v0: cv1 + 0.34, v1: cv1 + 0.56 }, 0xffc890, 0.85);
      // Timber slats on the plain side wall of the dining zone.
      const slatHi = !sideHasOpening(true);
      if (!sideHasOpening(slatHi ? true : false)) {
        const sa0 = slatHi ? a1i - 0.025 : a0i;
        const sa1 = slatHi ? a1i : a0i + 0.025;
        for (let v = v0i + 0.5; v + 0.045 <= cv0 - 0.3; v += 0.13) piece('archPaint', sa0, sa1, v, v + 0.045, 0.9, 2.5, { color: 0x6a4a2c, ao: 0.9 });
      }
    }
    troughStrip({ a0: a0i + 0.6, a1: a1i - 0.6, v0: v0i + Math.max(0.9, (cv0 - v0i) / 2 - 0.11), v1: v0i + Math.max(1.12, (cv0 - v0i) / 2 + 0.11) }, 0xffb070, 1.0);
    // v7 lamp / fan corner in the dining zone.
    tryAlong(7, 'B', v0i + 0.36, [a0i + 0.5, a1i - 0.5]) || tryDepth(7, 'R', a0i + 0.35, steps(v0i + 0.6, cv0 - 0.6, 3)) || tryDepth(7, 'L', a1i - 0.35, steps(v0i + 0.6, cv0 - 0.6, 3));
  } else if (tpl === 'TECH_SHOP') {
    // Recessed cyan / magenta display alcoves along the back wall.
    const n = Math.max(1, Math.min(4, Math.floor((Wi - 0.6) / 1.5)));
    const aw = (Wi - 0.6) / n;
    for (let k = 0; k < n; k++) {
      const x0 = a0i + 0.3 + k * aw;
      const x1 = x0 + aw;
      const unit: LRect = { a0: x0 - 0.04, a1: x1 + 0.04, v0: v1i - 0.34, v1: v1i };
      if (zones.some((z) => lHit(unit, z))) continue;
      used.push(unit);
      piece('concrete', x0 - 0.04, x1 + 0.04, v1i - 0.32, v1i, 0, 0.3, { ao: 0.6 }); // alcove plinth
      for (const xf of [x0, x1]) piece('steel', xf - 0.04, xf + 0.04, v1i - 0.32, v1i, 0.3, 2.9, { ao: 0.6 }); // fins
      piece('steel', x0 - 0.04, x1 + 0.04, v1i - 0.32, v1i, 2.9, 3.05, { ao: 0.6 }); // header
      for (const sy of [1.0, 1.8]) {
        piece('steel', x0 + 0.04, x1 - 0.04, v1i - 0.3, v1i, sy, sy + 0.03);
        piece('strips', x0 + 0.06, x1 - 0.06, v1i - 0.28, v1i - 0.02, sy - 0.015, sy, { color: k % 2 ? TECH_MAGENTA : 0x7ff0ff, emissive: 0.9 });
      }
      const col = k % 2 ? TECH_MAGENTA : 0x7ff0ff;
      piece('strips', x0 + 0.06, x0 + 0.09, v1i - 0.02, v1i, 0.35, 2.85, { color: col, emissive: 1.0 });
      piece('strips', x1 - 0.09, x1 - 0.06, v1i - 0.02, v1i, 0.35, 2.85, { color: col, emissive: 1.0 });
    }
    // Central showcase counter (solid base y 0 … 0.92, glowing display bed).
    const sw = Math.min(1.8, Wi - 2.4);
    const sv = v0i + Di * 0.56;
    if (sw >= 1.0) {
      const r: LRect = { a0: amid - sw / 2, a1: amid + sw / 2, v0: sv - 0.35, v1: sv + 0.35 };
      if (freeRect(r, 0.6)) {
        used.push({ a0: r.a0 - 0.5, a1: r.a1 + 0.5, v0: r.v0 - 0.5, v1: r.v1 + 0.5 });
        piece('steel', r.a0 + 0.05, r.a1 - 0.05, r.v0 + 0.05, r.v1 - 0.05, 0, 0.08, { ao: 0.5 });
        piece('strips', r.a0 + 0.03, r.a1 - 0.03, r.v0 + 0.03, r.v1 - 0.03, 0.03, 0.06, { color: 0x7ff0ff, emissive: 0.9 });
        piece('steel', r.a0, r.a1, r.v0, r.v1, 0.08, 0.92, { ao: 0.85 });
        piece('strips', r.a0 + 0.08, r.a1 - 0.08, r.v0 + 0.08, r.v1 - 0.08, 0.92, 0.93, { color: TECH_MAGENTA, emissive: 0.85 });
        solids.push(W3(r.a0, r.a1, r.v0, r.v1, floorY, floorY + 0.92));
      }
    }
    // v2 pedestals in the shopfront window line, v3 racks along the side walls.
    // Spread across the shopfront: each target fraction tries its nearest free position.
    let nPed = 0;
    const pedC = steps(a0i + 0.6, a1i - 0.6, Math.max(2, Math.round(Wi / 0.3)));
    for (const fr of [0.5, 0.12, 0.88]) {
      const tgt = lerp(a0i + 0.6, a1i - 0.6, fr);
      const order = [...pedC].sort((p, q) => Math.abs(p - tgt) - Math.abs(q - tgt));
      for (const ac of order.slice(0, 6)) if (addProp(2, 'F', ac, v0i + 0.75)) {
        nPed++;
        break;
      }
    }
    if (nPed < 2) for (const ac of steps(a0i + 0.6, a1i - 0.6, 8)) if (nPed < 2 && addProp(2, 'F', ac, v0i + Di * 0.35)) nPed++;
    let nRack = 0;
    const rv = steps(v0i + 0.9, v1i - 0.9, 4);
    if (tryDepth(3, 'R', a0i + 0.29, rv)) nRack++;
    if (tryDepth(3, 'L', a1i - 0.29, rv)) nRack++;
    if (nRack === 0) tryAlong(3, 'B', v0i + Di * 0.3, steps(a0i + 0.8, a1i - 0.8, 6));
    troughStrip({ a0: a0i + 0.5, a1: a1i - 0.5, v0: v0i + Di * 0.3 - 0.11, v1: v0i + Di * 0.3 + 0.11 }, 0x7ff0ff, 1.05);
    troughStrip({ a0: a0i + 0.5, a1: a1i - 0.5, v0: v0i + Di * 0.78 - 0.11, v1: v0i + Di * 0.78 + 0.11 }, TECH_MAGENTA, 0.9);
  } else if (tpl === 'PASS_ARCADE') {
    // Lobby alcove: reception console against a side wall without openings, backlit panel behind it.
    const side: 1 | -1 = sideHasOpening(true) ? -1 : sideHasOpening(false) ? 1 : rng() < 0.5 ? 1 : -1;
    const v6 = INTERIOR_PROP_BOUNDS[6];
    const ac = side > 0 ? a1i - v6.d / 2 - 0.02 : a0i + v6.d / 2 + 0.02;
    let vc = -1;
    for (const c of [D / 2, ...steps(v0i + v6.w / 2 + 0.05, v1i - v6.w / 2 - 0.05, 6)]) {
      if (addProp(6, side > 0 ? 'L' : 'R', ac, c, 0, true, true)) {
        vc = c;
        break;
      }
    }
    const hasLobby = vc >= 0;
    const lobby: LRect = hasLobby ? { ...footprint(6, side > 0 ? 'L' : 'R', ac, vc) } : { a0: 0, a1: 0, v0: 0, v1: 0 };
    if (hasLobby) {
      lobby.v0 -= 0.4;
      lobby.v1 += 0.4;
      const wa0 = side > 0 ? a1i - 0.02 : a0i;
      const fa0 = side > 0 ? a1i - 0.04 : a0i;
      piece('strips', wa0, wa0 + 0.02, vc - 1.0, vc + 1.0, 1.3, 2.4, { color: 0xd8f6ff, emissive: 0.9 });
      piece('steel', fa0, fa0 + 0.04, vc - 1.06, vc - 1.0, 1.24, 2.46, { ao: 0.7 });
      piece('steel', fa0, fa0 + 0.04, vc + 1.0, vc + 1.06, 1.24, 2.46, { ao: 0.7 });
    }
    // Chamfered colonnade piers engaged on the plain side walls (never in front of a door / glass partition).
    for (const s of [-1, 1] as const) {
      if (sideHasOpening(s > 0)) continue;
      for (let v = T + 1.2; v <= D - T - 1.2 + EPS; v += 3.2) {
        if (hasLobby && s === side && v + 0.2 > lobby.v0 && v - 0.2 < lobby.v1) continue;
        const w0 = s > 0 ? a1i - 0.16 : a0i;
        const w1 = s > 0 ? a1i : a0i + 0.16;
        const c0 = s > 0 ? a1i - 0.22 : a0i + 0.16;
        const c1 = s > 0 ? a1i - 0.16 : a0i + 0.22;
        const pr: LRect = { a0: Math.min(w0, c0), a1: Math.max(w1, c1), v0: v - 0.2, v1: v + 0.2 };
        if (zones.some((z) => lHit(pr, z))) continue;
        piece('concrete', w0, w1, v - 0.2, v + 0.2, 0, sb, { ao: INTERIOR.PIER_AO });
        piece('concrete', c0, c1, v - 0.13, v + 0.13, 0, sb, { ao: INTERIOR.PIER_AO });
        solids.push(W3(pr.a0, pr.a1, pr.v0, pr.v1, floorY, floorY + sb)); // inside the walkable volume: PROP collider
      }
    }
    for (const s of [-1, 1]) troughStrip({ a0: amid + s * 1.0 - 0.11, a1: amid + s * 1.0 + 0.11, v0: T + 0.3, v1: D - T - 0.3 }, 0xd8f6ff, 1.0);
  } else {
    // APARTMENT: low steel bed platform, caged fluorescent tube, desk / kitchenette / lamp props.
    const bedW = 2.0;
    const bedD = 1.0;
    const bedCands: LRect[] = [];
    for (const ac of [a1i - bedW / 2 - 0.02, a0i + bedW / 2 + 0.02, amid]) bedCands.push({ a0: ac - bedW / 2, a1: ac + bedW / 2, v0: v1i - bedD - 0.02, v1: v1i - 0.02 });
    for (const vc of steps(v0i + bedW / 2 + 0.3, v1i - bedW / 2 - 0.02, 2)) {
      bedCands.push({ a0: a0i + 0.02, a1: a0i + 0.02 + bedD, v0: vc - bedW / 2, v1: vc + bedW / 2 });
      bedCands.push({ a0: a1i - 0.02 - bedD, a1: a1i - 0.02, v0: vc - bedW / 2, v1: vc + bedW / 2 });
    }
    const bed = bedCands.find((r) => freeRect(r, 0.1));
    if (bed) {
      used.push(bed);
      piece('steel', bed.a0 + 0.05, bed.a1 - 0.05, bed.v0 + 0.05, bed.v1 - 0.05, 0, 0.12, { ao: 0.5 }); // recessed plinth
      piece('steel', bed.a0, bed.a1, bed.v0, bed.v1, 0.12, 0.3, { ao: 0.8 }); // steel frame
      piece('archPaint', bed.a0 + 0.03, bed.a1 - 0.03, bed.v0 + 0.03, bed.v1 - 0.03, 0.3, 0.46, { color: 0x3a4048 }); // futon
      const longA = bed.a1 - bed.a0 > bed.v1 - bed.v0;
      if (longA) piece('archPaint', bed.a1 - 0.5, bed.a1 - 0.1, bed.v0 + 0.15, bed.v1 - 0.15, 0.46, 0.55, { color: 0x8a8a84 }); // pillow
      else piece('archPaint', bed.a0 + 0.15, bed.a1 - 0.15, bed.v1 - 0.5, bed.v1 - 0.1, 0.46, 0.55, { color: 0x8a8a84 });
      solids.push(W3(bed.a0, bed.a1, bed.v0, bed.v1, floorY, floorY + 0.46));
    }
    const kv = v1i - INTERIOR_PROP_BOUNDS[5].d / 2 - 0.02;
    tryAlong(5, 'F', kv, steps(a0i + 0.6, a1i - 0.6, 6)) || tryDepth(5, 'R', a0i + 0.33, steps(v0i + 0.7, v1i - 0.7, 4)) || tryDepth(5, 'L', a1i - 0.33, steps(v0i + 0.7, v1i - 0.7, 4));
    const dd = INTERIOR_PROP_BOUNDS[4].d / 2 + 0.02;
    tryDepth(4, 'R', a0i + dd, steps(v0i + 0.8, v1i - 0.8, 4)) || tryDepth(4, 'L', a1i - dd, steps(v0i + 0.8, v1i - 0.8, 4)) || tryAlong(4, 'F', v1i - dd, steps(a0i + 0.8, a1i - 0.8, 5)) || tryAlong(4, 'B', v0i + dd, steps(a0i + 0.8, a1i - 0.8, 5));
    tryAlong(7, 'B', v0i + 0.35, [a0i + 0.5, a1i - 0.5]) || tryAlong(7, 'F', v1i - 0.35, [a0i + 0.5, a1i - 0.5]) || tryDepth(7, 'R', a0i + 0.5, steps(v0i + 0.5, v1i - 0.5, 4));
    // Caged fluorescent tube on two hanger stubs from the soffit.
    const tc = amid;
    const tvc = v0i + Di * 0.5;
    const tb = sb - 0.12; // tube bottom
    piece('strips', tc - 0.6, tc + 0.6, tvc - 0.035, tvc + 0.035, tb, tb + 0.06, { color: lightCol, emissive: 1.05 });
    for (const s of [-1, 1]) {
      piece('steel', tc + s * 0.63 - 0.03, tc + s * 0.63 + 0.03, tvc - 0.08, tvc + 0.08, tb - 0.03, tb + 0.07, { ao: 0.8 }); // end caps
      piece('steel', tc + s * 0.63 - 0.015, tc + s * 0.63 + 0.015, tvc - 0.015, tvc + 0.015, tb + 0.07, sb, { ao: 0.8 }); // hangers
      piece('steel', tc - 0.6, tc + 0.6, tvc + s * 0.0725 - 0.0075, tvc + s * 0.0725 + 0.0075, tb + 0.02, tb + 0.035); // side cage bars
    }
    for (const k of [-0.3, 0, 0.3]) piece('steel', tc + k - 0.008, tc + k + 0.008, tvc - 0.08, tvc + 0.08, tb - 0.03, tb - 0.015); // cage hoops
  }

  // ---- soffit (inner ceiling minus trough gaps) + lights --------------------------------
  let soff: Array<[number, number, number, number]> = [[a0i, a1i, fv0, fv1]];
  for (const t of troughs) soff = subRects(soff, [t.a0, t.a1, t.v0, t.v1]);
  for (const [a0, a1, v0, v1] of soff) piece('concrete', a0, a1, v0, v1, sb, ch, { ao: INTERIOR.SOFFIT_AO });
  const lightAt = (a: number, v: number, color: number, intensity: number): void => {
    const [x, z] = worldXZ(a, v);
    lights.push({ x, y: floorY + sb - 0.35, z, color, intensity });
  };
  if (tpl === 'APARTMENT') lightAt(amid, v0i + Di * 0.5, lightCol, 1.15);
  else if (tpl === 'PASS_ARCADE') {
    lightAt(amid, D * 0.3, lightCol, 1.2);
    lightAt(amid, D * 0.7, lightCol, 1.2);
  } else if (tpl === 'TECH_SHOP') {
    lightAt(amid, v0i + Di * 0.3, lightCol, 1.4);
    lightAt(amid, v0i + Di * 0.78, 0xd070ff, 1.1);
  } else {
    lightAt(amid, v0i + Di * 0.3, lightCol, 1.3);
    lightAt(amid, v1i - 1.4, lightCol, 1.2);
  }
  const inner = W3(a0i, a1i, fv0, fv1, floorY, floorY + sb);
  return { room: R, ceilY, shell, structure, solids, props, lights, inner };
}

/**
 * Room envelope + template dressing of one interior as ShellPieces (floor slab, soffit with recessed light troughs,
 * 0.30 m perimeter walls split exactly around the openings, dark-steel jambs / headers / sills, template fittings).
 */
export function buildInteriorShell(inp: InteriorShellInput): ShellPiece[] {
  return dressRoom(inp).shell;
}

// =============================================================================================
// 11A-1 district planner
// =============================================================================================
const TEMPLATE_ORDER: readonly InteriorTemplate[] = ['PASS_ARCADE', 'APARTMENT', 'EATERY', 'TECH_SHOP'];

/**
 * 11A-1 §1.1–1.2: picks 6–10 interiors (S1–S4) / 4–6 (S5, perimeter hosts pre-filtered by the caller) — never on a
 * megastructure, never opening a wall-run face. Base quota per district: EATERY 2, TECH_SHOP 2, PASS_ARCADE 2,
 * APARTMENT 2–3 (S5: 1 each); glazed shopfronts are preferred over door-only ones, unmet quotas fall back to
 * relaxed hosts / substitute templates, then up to two bonus rooms (≤ target.max). One room per building, except
 * when still below `target.min`: a second room in a different massing box (L wing) of an already-carved building.
 */
export function planInteriors(hosts: readonly InteriorHost[], sectorIndex: number, rng: () => number, opts: PlanInteriorsOptions): InteriorPlan[] {
  const ring = opts.isRing === true || sectorIndex === 5;
  const allowed = opts.templates ?? INTERIOR_TEMPLATES;
  const ctx: Ctx = { halfExtent: opts.halfExtent };
  const aptBase = ring ? 1 : rng() < 0.5 ? 3 : 2;
  const base: Record<InteriorTemplate, number> = ring ? { EATERY: 1, TECH_SHOP: 1, PASS_ARCADE: 1, APARTMENT: 1 } : { EATERY: 2, TECH_SHOP: 2, PASS_ARCADE: 2, APARTMENT: aptBase };
  const quotaSum = allowed.reduce((s, t) => s + base[t], 0);
  const target = opts.target ?? (opts.templates ? { min: quotaSum, max: quotaSum } : ring ? { min: 4, max: 6 } : { min: 6, max: 10 });
  const pool = hosts
    .filter((h) => !isMegaKind(h.massing) && h.boxes.length > 0)
    .map((h) => ({ h, k: rng() }))
    .sort((p, q) => p.k - q.k)
    .map((e) => e.h);
  const usedB = new Set<number>();
  const usedBox = new Set<string>();
  const specs: Array<{ host: InteriorHost; spec: RoomSpec }> = [];
  /** Host view without the boxes already carved (second-room pass) — box indices stay those of the real host. */
  const freeBoxesOf = (h: InteriorHost): InteriorHost => ({ ...h, boxes: h.boxes.map((b, i) => (usedBox.has(`${h.building}:${i}`) ? { ...b, y0: 1e6, y1: 1e6 } : b)) });
  let needGlass = false;
  const attempt = (t: InteriorTemplate, h: InteriorHost, strict: boolean): RoomSpec | null => {
    if (t === 'APARTMENT') return usedBox.has(`${h.building}:0`) ? null : planApartment(h, rng, ctx);
    if (t === 'PASS_ARCADE') return planArcade(h, strict, rng, ctx);
    return planShop(t, h, strict, rng, ctx, needGlass);
  };
  /** `perBox`: a building already hosting a room may take a second one in a different massing box (L wing). */
  const fill = (t: InteriorTemplate, want: number, strict: boolean, perBox = false): number => {
    let got = 0;
    for (const h of pool) {
      if (got >= want || specs.length >= target.max) break;
      if (usedB.has(h.building) && !perBox) continue;
      const s = attempt(t, usedB.has(h.building) ? freeBoxesOf(h) : h, strict);
      if (!s || usedBox.has(`${h.building}:${s.boxIndex}`)) continue;
      // Never two rooms on one face plane closer than 1.2 m (their jambs / door zones stay apart).
      const clash = specs.some(({ host, spec: o }) => host.building === h.building && o.openings.some((p) => s.openings.some((q) => p.ax === q.ax && p.sg === q.sg && Math.abs(p.plane - q.plane) < 1e-6 && p.a0 < q.a1 + 1.2 && q.a0 < p.a1 + 1.2)));
      if (clash) continue;
      usedB.add(h.building);
      usedBox.add(`${h.building}:${s.boxIndex}`);
      specs.push({ host: h, spec: s });
      got++;
    }
    return got;
  };
  for (const t of TEMPLATE_ORDER) {
    if (!allowed.includes(t)) continue;
    const want = Math.min(base[t], Math.max(0, target.max - specs.length));
    // Complete shopfronts (with glass) first, door-only shops only when nothing better exists.
    needGlass = t === 'EATERY' || t === 'TECH_SHOP';
    let got = fill(t, want, true);
    if (got < want) got += fill(t, want - got, false);
    needGlass = false;
    if (got < want) fill(t, want - got, false);
  }
  // Substitute templates until the minimum is met.
  let guard = 0;
  while (specs.length < target.min && guard++ < 16) {
    let added = 0;
    for (const t of ['EATERY', 'TECH_SHOP', 'PASS_ARCADE', 'APARTMENT'] as const) {
      if (specs.length >= target.min) break;
      if (!allowed.includes(t)) continue;
      added += fill(t, 1, false);
    }
    if (added === 0) break;
  }
  // Bonus: up to two extra complete rooms (arcade, then glazed shops) on spare hosts, within target.max.
  const bonusCap = Math.min(target.max, specs.length + 2);
  for (const t of ['PASS_ARCADE', 'EATERY', 'TECH_SHOP'] as const) {
    if (!allowed.includes(t) || specs.length >= bonusCap) continue;
    needGlass = t !== 'PASS_ARCADE';
    fill(t, bonusCap - specs.length, false);
    needGlass = false;
  }
  // Still short (e.g. the Sector 5 ring with few non-megastructure lots): second rooms in other massing boxes.
  guard = 0;
  while (specs.length < target.min && guard++ < 8) {
    let added = 0;
    for (const t of ['EATERY', 'TECH_SHOP', 'PASS_ARCADE'] as const) {
      if (specs.length >= target.min) break;
      if (allowed.includes(t)) added += fill(t, 1, false, true);
    }
    if (added === 0) break;
  }
  const idBase = opts.idBase ?? 0;
  return specs.map(({ host, spec }, i) => {
    const d = dressRoom({ template: spec.template, frame: spec.F, a0: spec.ra0, a1: spec.ra1, depth: spec.D, floorY: spec.floorY, openings: spec.openings, seed: spec.seed });
    return {
      id: idBase + i,
      building: host.building,
      template: spec.template,
      boxIndex: spec.boxIndex,
      room: d.room,
      floorY: spec.floorY,
      ceilY: d.ceilY,
      openings: spec.openings,
      shell: d.shell,
      solids: d.solids,
      props: d.props,
      lights: d.lights,
      structure: d.structure,
      frame: { ax: spec.F.ax, sg: spec.F.sg, plane: spec.F.plane, a0: spec.ra0, a1: spec.ra1, depth: spec.D },
      inner: d.inner,
    };
  });
}

/** SectorLayout.interiors record of a plan (entry points 0.8 m outside every door / archway, at floor height). */
export function interiorVolumeOf(plan: InteriorPlan, doorIds: readonly number[], glassIds: readonly number[]): InteriorVolume {
  const entryPoints: THREE.Vector3[] = [];
  for (const o of plan.openings) {
    if (o.kind === 'WINDOW') continue;
    const a = (o.a0 + o.a1) / 2;
    const n = o.plane + o.sg * 0.8;
    entryPoints.push(o.ax === 'x' ? new THREE.Vector3(n, o.y0, a) : new THREE.Vector3(a, o.y0, n));
  }
  return { id: plan.id, building: plan.building, template: plan.template, aabb: { ...plan.inner }, floorY: plan.floorY, entryPoints, doorIds, glassIds };
}

/**
 * QA: list of invariant violations of one plan (empty = clean): every shell piece / structure / solid stays inside
 * the room box (≤ 0.02 m outward), no piece intersects any opening slab, openings avoid the 0.4 m room corners.
 */
export function validateInteriorPlan(plan: InteriorPlan): string[] {
  const out: string[] = [];
  const R = plan.room;
  const tol = 0.02 + 1e-6;
  const boxes: Array<[string, Aabb3]> = [
    ...plan.shell.map((s, i): [string, Aabb3] => [`shell${i}:${s.bucket}`, { minX: s.x0, minY: s.y0, minZ: s.z0, maxX: s.x1, maxY: s.y1, maxZ: s.z1 }]),
    ...plan.structure.map((s, i): [string, Aabb3] => [`structure${i}`, s]),
    ...plan.solids.map((s, i): [string, Aabb3] => [`solid${i}`, s]),
  ];
  for (const [name, b] of boxes) {
    if (b.minX < R.x0 - tol || b.maxX > R.x1 + tol || b.minZ < R.z0 - tol || b.maxZ > R.z1 + tol || b.minY < R.y0 - tol || b.maxY > R.y1 + tol) out.push(`${name} outside room`);
    for (const o of plan.openings) {
      const n0 = Math.min(o.plane - o.sg * INTERIOR.WALL_M, o.plane + o.sg * 0.05);
      const n1 = Math.max(o.plane - o.sg * INTERIOR.WALL_M, o.plane + o.sg * 0.05);
      const s = o.ax === 'x' ? { minX: n0, maxX: n1, minZ: o.a0, maxZ: o.a1 } : { minX: o.a0, maxX: o.a1, minZ: n0, maxZ: n1 };
      const e = 1e-5;
      if (b.minX < s.maxX - e && b.maxX > s.minX + e && b.minZ < s.maxZ - e && b.maxZ > s.minZ + e && b.minY < o.y1 - e && b.maxY > o.y0 + e) out.push(`${name} blocks ${o.kind}@${o.ax}:${o.sg}`);
    }
  }
  for (const o of plan.openings) {
    const [r0, r1] = o.ax === 'x' ? [R.z0, R.z1] : [R.x0, R.x1];
    if (o.a0 < r0 + INTERIOR.CORNER_M - 1e-6 || o.a1 > r1 - INTERIOR.CORNER_M + 1e-6) out.push(`${o.kind} within 0.4 m of a room corner`);
    const pl = planeOf(R, o.ax, o.sg);
    if (Math.abs(pl - o.plane) > 1e-6) out.push(`${o.kind} not on the room wall plane`);
  }
  return out;
}

// =============================================================================================
// 11A-1b deep architectural relief
// =============================================================================================
export interface SkyNotchPlan {
  readonly yNotch: number;
  readonly inset: number;
  /** lower shaft, recessed core, upper shaft — replace the tower box in G.bodies + BUILDING colliders. */
  readonly solids: MassBox[];
  /** steel columns, refuge ledge + soffit ring (concrete ao 0.36), louvered core cladding (ao 0.38), rail + strip. */
  readonly shell: ShellPiece[];
  /** walkable refuge-ledge colliders (top at yNotch + 0.12). */
  readonly ledges: MassBox[];
  /** 1.05 m safety-rail colliders between the columns (optional). */
  readonly rails: MassBox[];
  /** 1–2 'LEDGE' grapple anchors at notch outer corners (under the upper-shaft soffit). */
  readonly anchors: THREE.Vector3[];
}

export const SKY_NOTCH = { MIN_ROOF_M: 36, H_M: 4.0, INSET_MIN_M: 1.8, INSET_MAX_M: 2.4, MIN_ABOVE_GROUND_M: 12, MIN_BELOW_TOP_M: 8, LEDGE_M: 0.12, SOFFIT_M: 0.1, COLUMN_M: 0.45, RAIL_H_M: 1.05 } as const;

/**
 * Mid-tower refuge sky-notch on the archetype floor grid (`floorTopY`), ≥ 12 m above ground, ≥ 8 m below the top,
 * clear of `blockedBands` ([y0, y1] ranges that must stay solid: balconies, escapes, spines, terrace seams ± 4 m,
 * sign bands). Returns null when the box is shorter than 36 m, too slender for a 1.8 m inset or fully blocked.
 */
export function planSkyNotch(box: MassBox, arch: number, rng: () => number, opts: { blockedBands?: ReadonlyArray<[number, number]> } = {}): SkyNotchPlan | null {
  const S = SKY_NOTCH;
  if (box.y1 < S.MIN_ROOF_M) return null;
  const W = box.x1 - box.x0;
  const Dz = box.z1 - box.z0;
  const inset = Math.min(lerp(S.INSET_MIN_M, S.INSET_MAX_M, rng()), (Math.min(W, Dz) - 4) / 2);
  if (inset < S.INSET_MIN_M - 1e-9) return null;
  const cands: number[] = [];
  for (let n = 0; n < 64; n++) {
    const y = floorTopY(arch, n);
    if (y > box.y1) break;
    if (y < Math.max(S.MIN_ABOVE_GROUND_M, box.y0 + 4) - 1e-9 || y + S.H_M > box.y1 - S.MIN_BELOW_TOP_M + 1e-9) continue;
    if (opts.blockedBands?.some(([b0, b1]) => b1 > y + 1e-9 && b0 < y + S.H_M - 1e-9)) continue;
    cands.push(y);
  }
  if (!cands.length) return null;
  const yN = cands[Math.min(cands.length - 1, Math.floor(rng() * cands.length))];
  const yT = yN + S.H_M;
  const core: MassBox = { x0: box.x0 + inset, x1: box.x1 - inset, z0: box.z0 + inset, z1: box.z1 - inset, y0: yN, y1: yT };
  const solids: MassBox[] = [{ ...box, y1: yN }, core, { ...box, y0: yT }];
  const shell: ShellPiece[] = [];
  const sp = (bucket: ShellPiece['bucket'], b: MassBox, extra: { ao?: number; color?: number; emissive?: number } = {}): void => {
    shell.push({ bucket, x0: b.x0, y0: b.y0, z0: b.z0, x1: b.x1, y1: b.y1, z1: b.z1, ...extra });
  };
  const ring = (y0: number, y1: number): MassBox[] => [
    { x0: box.x0, x1: box.x0 + inset, z0: box.z0, z1: box.z1, y0, y1 },
    { x0: box.x1 - inset, x1: box.x1, z0: box.z0, z1: box.z1, y0, y1 },
    { x0: box.x0 + inset, x1: box.x1 - inset, z0: box.z0, z1: box.z0 + inset, y0, y1 },
    { x0: box.x0 + inset, x1: box.x1 - inset, z0: box.z1 - inset, z1: box.z1, y0, y1 },
  ];
  const ledges = ring(yN, yN + S.LEDGE_M);
  for (const b of ledges) sp('concrete', b, { ao: 0.36 });
  for (const b of ring(yT - S.SOFFIT_M, yT)) sp('concrete', b, { ao: 0.36 });
  // Structural columns (outer faces 0.05 inside the facade) carry the upper shaft: corners + long-side mids.
  const c = S.COLUMN_M;
  const cy0 = yN + S.LEDGE_M;
  const cy1 = yT - S.SOFFIT_M;
  const colX = [box.x0 + 0.05, box.x1 - 0.05 - c];
  const colZ = [box.z0 + 0.05, box.z1 - 0.05 - c];
  const cols: Array<[number, number]> = [];
  for (const x of colX) for (const z of colZ) cols.push([x, z]);
  if (W > 12) for (const z of colZ) cols.push([(box.x0 + box.x1 - c) / 2, z]);
  if (Dz > 12) for (const x of colX) cols.push([x, (box.z0 + box.z1 - c) / 2]);
  for (const [x, z] of cols) sp('steel', { x0: x, x1: x + c, z0: z, z1: z + c, y0: cy0, y1: cy1 }, { ao: 0.8 });
  // Safety rail between the columns on each side (top bar + mid bar + posts + glowing strip on top).
  const railCol = rng() < 0.5 ? 0xffb040 : 0x40e0ff;
  const rails: MassBox[] = [];
  const rt = cy0 + S.RAIL_H_M;
  const sideRail = (ax: Axis, sg: 1 | -1): void => {
    const pl = planeOf(box, ax, sg);
    const m0 = sg > 0 ? pl - 0.1 : pl + 0.05;
    const m1 = sg > 0 ? pl - 0.05 : pl + 0.1;
    const [A0, A1] = ax === 'x' ? [box.z0, box.z1] : [box.x0, box.x1];
    const colA = cols.filter(([x, z]) => (ax === 'x' ? Math.abs((sg > 0 ? x + c : x) - (sg > 0 ? box.x1 - 0.05 : box.x0 + 0.05)) < 1e-6 : Math.abs((sg > 0 ? z + c : z) - (sg > 0 ? box.z1 - 0.05 : box.z0 + 0.05)) < 1e-6)).map(([x, z]) => (ax === 'x' ? z : x));
    colA.sort((p, q) => p - q);
    let spans: Array<[number, number, number, number]> = [[A0 + 0.05, A1 - 0.05, 0, 1]];
    for (const a of colA) spans = subRects(spans, [a, a + c, -1, 2]);
    const mk = (a0: number, a1: number, y0: number, y1: number): MassBox => (ax === 'x' ? { x0: m0, x1: m1, z0: a0, z1: a1, y0, y1 } : { x0: a0, x1: a1, z0: m0, z1: m1, y0, y1 });
    for (const [a0, a1] of spans) {
      if (a1 - a0 < 0.1) continue;
      sp('steel', mk(a0, a1, rt - 0.05, rt));
      sp('steel', mk(a0, a1, cy0 + 0.5, cy0 + 0.54));
      sp('strips', mk(a0 + 0.02, a1 - 0.02, rt, rt + 0.015), { color: railCol, emissive: 0.9 });
      const np = Math.max(1, Math.round((a1 - a0) / 1.5));
      for (let k = 1; k < np; k++) {
        const a = a0 + ((a1 - a0) * k) / np;
        sp('steel', mk(a - 0.02, a + 0.02, cy0, rt - 0.05));
      }
      rails.push(mk(a0, a1, cy0, rt));
    }
  };
  sideRail('x', 1);
  sideRail('x', -1);
  sideRail('z', 1);
  sideRail('z', -1);
  // Louvered mechanical cladding on the recessed core (horizontal steel fins, 0.08 proud).
  for (let y = yN + 0.4; y + 0.05 <= yT - 0.35; y += 0.33) {
    sp('steel', { x0: core.x1, x1: core.x1 + 0.08, z0: core.z0 + 0.05, z1: core.z1 - 0.05, y0: y, y1: y + 0.05 }, { ao: 0.38 });
    sp('steel', { x0: core.x0 - 0.08, x1: core.x0, z0: core.z0 + 0.05, z1: core.z1 - 0.05, y0: y, y1: y + 0.05 }, { ao: 0.38 });
    sp('steel', { x0: core.x0 + 0.05, x1: core.x1 - 0.05, z0: core.z1, z1: core.z1 + 0.08, y0: y, y1: y + 0.05 }, { ao: 0.38 });
    sp('steel', { x0: core.x0 + 0.05, x1: core.x1 - 0.05, z0: core.z0 - 0.08, z1: core.z0, y0: y, y1: y + 0.05 }, { ao: 0.38 });
  }
  const corners: Array<[number, number]> = [
    [box.x0 + 0.05 + c / 2, box.z0 + 0.05 + c / 2],
    [box.x1 - 0.05 - c / 2, box.z1 - 0.05 - c / 2],
    [box.x1 - 0.05 - c / 2, box.z0 + 0.05 + c / 2],
    [box.x0 + 0.05 + c / 2, box.z1 - 0.05 - c / 2],
  ];
  const first = Math.floor(rng() * 4) % 4;
  const anchors = [new THREE.Vector3(corners[first][0], yT - 0.35, corners[first][1])];
  if (rng() < 0.6) {
    const opp = first ^ 1;
    anchors.push(new THREE.Vector3(corners[opp][0], yT - 0.35, corners[opp][1]));
  }
  return { yNotch: yN, inset, solids, shell, ledges, rails, anchors };
}

/** Face reference for the relief helpers (lot face plane, along range). */
export interface ReliefFace {
  readonly ax: Axis;
  readonly sg: number;
  readonly plane: number;
  readonly a0: number;
  readonly a1: number;
}

const reliefBox = (f: ReliefFace, a0: number, a1: number, d0: number, d1: number, y0: number, y1: number): MassBox => {
  const n0 = f.plane + f.sg * d0;
  const n1 = f.plane + f.sg * d1;
  const lo = Math.min(n0, n1);
  const hi = Math.max(n0, n1);
  return f.ax === 'x' ? { x0: lo, x1: hi, z0: a0, z1: a1, y0, y1 } : { x0: a0, x1: a1, z0: lo, z1: hi, y0, y1 };
};
const mbPiece = (bucket: ShellPiece['bucket'], b: MassBox, extra: { ao?: number; color?: number; emissive?: number } = {}): ShellPiece => ({ bucket, x0: b.x0, y0: b.y0, z0: b.z0, x1: b.x1, y1: b.y1, z1: b.z1, ...extra });

/**
 * Deep recessed window reveals on a NON-run feature face, y ∈ [y0, y1]: 0.48 m concrete piers every ~4 m (inner jamb
 * ao 0.38), 0.42 m floor-line sills between them and one 0.38 m dark-steel sun-breaker fin per floor (3.2 m above the
 * floor line) spanning pier to pier. Every projection ≤ 0.48 m (≤ 0.55 cap); sills / fins touch both piers.
 */
export function revealFinPieces(face: ReliefFace, y0: number, y1: number, arch: number): ShellPiece[] {
  const out: ShellPiece[] = [];
  const { piers } = groundBayGrid(face.a0, face.a1);
  const pw = GRAMMAR.PIER_W_M / 2;
  for (const a of piers) out.push(mbPiece('concrete', reliefBox(face, a - pw, a + pw, 0, 0.48, y0, y1), { ao: 0.38 }));
  for (let n = 0; n < 64; n++) {
    const yf = floorTopY(arch, n);
    if (yf > y1) break;
    for (let k = 0; k + 1 < piers.length; k++) {
      const b0 = piers[k] + pw;
      const b1 = piers[k + 1] - pw;
      if (yf - 0.14 >= y0 - 1e-9 && yf <= y1 + 1e-9 && yf > y0 + 0.5) out.push(mbPiece('concrete', reliefBox(face, b0, b1, 0, 0.42, yf - 0.14, yf), { ao: 0.6 }));
      const fy = yf + 3.2;
      if (fy >= y0 && fy + 0.06 <= y1 && fy + 0.06 <= floorTopY(arch, n + 1) - 0.2) out.push(mbPiece('steel', reliefBox(face, b0, b1, 0, 0.38, fy, fy + 0.06), { ao: 0.7 }));
    }
  }
  return out;
}

export interface PodPlan {
  readonly shell: ShellPiece[];
  /** Solid BUILDING collider(s) of the pod body. */
  readonly solids: MassBox[];
  /** 45° underside steel brackets (wall foot → pod soffit) for the lead's beam() helper. */
  readonly beams: ReadonlyArray<{ readonly a: THREE.Vector3; readonly b: THREE.Vector3; readonly w: number }>;
}

/**
 * Cantilevered bay-window pod (default 3.2 × 0.95 × 2.8 m) or HVAC service pod (pass 2.4, 1.2, 2.4, hvac = true) on
 * a NON-run face, centred at along `a`, soffit at `yBase`; twin 45° brackets from the wall into the pod soffit, dark
 * soffit plate (ao 0.38). Note: pods project 0.95–1.2 m (spec) — the caller verifies the ≥ 2.4 m corridor clearance.
 */
export function bayPodPieces(face: ReliefFace, a: number, yBase: number, w = 3.2, depth = 0.95, h = 2.8, hvac = false): PodPlan {
  const shell: ShellPiece[] = [];
  const body = reliefBox(face, a - w / 2, a + w / 2, 0, depth, yBase + 0.05, yBase + h);
  shell.push(mbPiece(hvac ? 'steel' : 'archPaint', body, hvac ? { ao: 0.85 } : { color: 0x3a3f46 }));
  shell.push(mbPiece('concrete', reliefBox(face, a - w / 2, a + w / 2, 0, depth, yBase, yBase + 0.05), { ao: 0.38 }));
  if (hvac) {
    for (let k = 0; k < 6; k++) {
      const y = yBase + 0.4 + k * 0.3;
      if (y + 0.04 > yBase + h - 0.3) break;
      shell.push(mbPiece('steel', reliefBox(face, a - w / 2 + 0.15, a + w / 2 - 0.15, depth, depth + 0.04, y, y + 0.04), { ao: 0.6 }));
    }
  } else {
    shell.push(mbPiece('steel', reliefBox(face, a - w / 2 + 0.2, a + w / 2 - 0.2, depth, depth + 0.02, yBase + 0.7, yBase + h - 0.35), { ao: 0.7 }));
    shell.push(mbPiece('strips', reliefBox(face, a - w / 2 + 0.3, a + w / 2 - 0.3, depth + 0.02, depth + 0.03, yBase + h - 0.33, yBase + h - 0.3), { color: 0xffc070, emissive: 0.85 }));
  }
  const beams: Array<{ a: THREE.Vector3; b: THREE.Vector3; w: number }> = [];
  const rise = depth - 0.08;
  for (const s of [-1, 1]) {
    const ab = a + s * (w / 2 - 0.4);
    shell.push(mbPiece('steel', reliefBox(face, ab - 0.1, ab + 0.1, 0, 0.04, yBase - rise - 0.15, yBase - rise + 0.1), { ao: 0.8 }));
    const p0 = reliefBox(face, ab, ab, 0.04, 0.04, yBase - rise, yBase - rise);
    const p1 = reliefBox(face, ab, ab, rise, rise, yBase, yBase);
    beams.push({ a: new THREE.Vector3(p0.x0, p0.y0, p0.z0), b: new THREE.Vector3(p1.x0, p1.y0, p1.z0), w: 0.06 });
  }
  return { shell, solids: [body], beams };
}
