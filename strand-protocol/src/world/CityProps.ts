/**
 * STRAND // PROTOCOL — Phase 9B city micro-props: pure, deterministic planning (no scene objects).
 *
 *  9B-1  Per-door / per-bay socket composer. Every doorway's PropSockets (9A) are filled from a seeded RNG:
 *        ~15 % of doors stay tidy (room plaque + keypad only), the rest get 1–3 distinct props with ±0.06 m /
 *        ±12° / 0.88–1.12× jitter, and two adjacent doors never share a composition. Props are fitted into the
 *        free space each socket records (bay piers, portal pillars, gallery windows) and never overlap a wall
 *        fixture of the same door.
 *  9B-2  Alley / sidewalk / courtyard / underpass clutter clusters along "strips" (a back line + outward depth
 *        band): door clear zones, crosswalks, junctions, ramps, cars and spawn points are forbidden; alley strips
 *        stop short of a ≥ 2.6 m clear centre path; collidable clutter (dumpsters, jersey barriers, bench seats)
 *        stays out of wall-run strips and registers exact crouch-cover AABBs.
 *  9B-3  Graffiti / torn-poster decals on shutters, alley piers, highway piers and dumpster flanks.
 *
 * Rendering lives in CityPropMeshes.ts; CityBuilder gathers the inputs and commits the instances.
 */
import { createRng } from '../config/constants';
import type { PropSocket, SocketGroup, SocketSlot } from './BuildingGrammar';

// =============================================================================================
// Constants
// =============================================================================================
export const PROPS = {
  /** Vertex-shader distance cull of the socket micro-props / clutter, decal fade-out distance. */
  CULL_SOCKET_M: 64,
  CULL_CLUTTER_M: 110,
  DECAL_FADE_M: 95,
  CAP: {
    PLANTS: 260,
    STORAGE: 360,
    FIXTURES: 420,
    MISC: 220,
    DEBRIS: 480,
    DUMPSTER: 65,
    BENCH: 110,
    SCRAP: 200,
    DECAL: 340,
    CONTACT_SHADOW: 420,
  },
  /** Raw tidy roll; ~15 % of doors end up tidy once adjacent tidy pairs are broken up. */
  TIDY_CHANCE: 0.175,
  JITTER_LAT_M: 0.06,
  JITTER_YAW_RAD: (12 * Math.PI) / 180,
  SCALE_MIN: 0.88,
  SCALE_MAX: 1.12,
  /** Floor props at most this tall on wall-run faces (`socket.low`). */
  LOW_MAX_H: 0.75,
  /** Clear walkable centre path kept down every narrow alley. */
  ALLEY_CLEAR_M: 2.6,
  /** Collidable clutter keeps this far off a wall-run face (player capsule 0.38 m + 0.95 m detect reach). */
  RUN_STRIP_M: 1.45,
  /** Collidable clutter keeps clear of spawn points. */
  SPAWN_CLEAR_M: 1.6,
  /** Wall fixtures are mounted 0.02 m proud of the socket's mounting plane (socket point = plane + 0.02). */
  WALL_SOCKET_OFFSET_M: 0.02,
  /** Decals sit this far off their surface. */
  DECAL_OFFSET_M: 0.032,
} as const;

/** 16 room / suite numbers of the procedural 4 × 4 plaque atlas (cell = index). */
export const PLAQUE_LABELS: readonly string[] = [
  '2-0401', '3-0805', '3-0806', '4-1102', 'B-209', '2-0312', '3-0807', '4-1105',
  'C-114', '2-0405', '3-0808', '4-1201', 'B-215', 'SV-04', '3-0902', 'A-301',
];

// =============================================================================================
// Catalogue
// =============================================================================================
export type KitId = 'PLANTS' | 'STORAGE' | 'FIXTURES' | 'MISC' | 'DEBRIS' | 'DUMPSTER' | 'BENCH' | 'SCRAP';
export const KIT_IDS: readonly KitId[] = ['PLANTS', 'STORAGE', 'FIXTURES', 'MISC', 'DEBRIS', 'DUMPSTER', 'BENCH', 'SCRAP'];
export const KIT_CAP: Readonly<Record<KitId, number>> = {
  PLANTS: PROPS.CAP.PLANTS,
  STORAGE: PROPS.CAP.STORAGE,
  FIXTURES: PROPS.CAP.FIXTURES,
  MISC: PROPS.CAP.MISC,
  DEBRIS: PROPS.CAP.DEBRIS,
  DUMPSTER: PROPS.CAP.DUMPSTER,
  BENCH: PROPS.CAP.BENCH,
  SCRAP: PROPS.CAP.SCRAP,
};

export type PropId =
  | 'POT_PLANT' | 'PLANTER' | 'PLANT_ON_BIN' | 'SUCCULENTS'
  | 'WIRE_RACK' | 'BINS' | 'CRATES' | 'TOTE_BUCKET'
  | 'PLAQUE' | 'BREAKER' | 'KEYPAD' | 'SCONCE'
  | 'STOOLS' | 'AFRAME' | 'CANISTERS' | 'UMBRELLA'
  | 'BOXES' | 'BOX_TOWER' | 'BOX_PILE'
  | 'BIN_BAGS' | 'BAG_MOUND'
  | 'DUMPSTER' | 'DUMPSTER_OPEN'
  | 'BENCH'
  | 'PALLETS' | 'DRUMS' | 'JERSEY' | 'CONES';

export interface PropDef {
  readonly kit: KitId;
  /** aVariant of the kit geometry. */
  readonly v: number;
  /** Footprint along the wall (w) × outward (d), height (h); wall fixtures: face w × h, depth d. */
  readonly w: number;
  readonly d: number;
  readonly h: number;
  readonly wall: boolean;
  /** Per-instance tint palette (sRGB hex); the kit shades its TINT parts with it. */
  readonly tints: readonly number[];
  /** Registers an AABB collider of this height (crouch cover / bench seat); 0 = none. */
  readonly colliderH: number;
}

const D = (kit: KitId, v: number, w: number, d: number, h: number, tints: readonly number[], wall = false, colliderH = 0): PropDef => ({ kit, v, w, d, h, wall, tints, colliderH });

export const PROP_DEFS: Readonly<Record<PropId, PropDef>> = {
  // SocketPottedPlants: rain-wet terracotta / weathered stone ceramic / matte slate (10A-2 damped).
  POT_PLANT: D('PLANTS', 0, 0.44, 0.44, 0.95, [0x78402a, 0x7c786e, 0x383d44]),
  PLANTER: D('PLANTS', 1, 0.78, 0.32, 0.8, [0x4e4c49, 0x2c3036, 0x5c564d]),
  PLANT_ON_BIN: D('PLANTS', 2, 0.52, 0.42, 1.2, [0x6a675f, 0x9c481e, 0x263d5e]),
  SUCCULENTS: D('PLANTS', 3, 0.48, 0.26, 0.42, [0x78402a, 0x7c786e, 0x2b3036]),
  // SocketStorageCrates: muted rain-wet storage bins / crates (no white blow-out).
  WIRE_RACK: D('STORAGE', 0, 0.72, 0.34, 1.45, [0x5c584e, 0x924620, 0x3d444d]),
  BINS: D('STORAGE', 1, 0.62, 0.46, 0.66, [0x68655d, 0x984820, 0x243b5c]),
  CRATES: D('STORAGE', 2, 0.56, 0.4, 0.84, [0x9a6e22, 0x1a6664, 0x2b2f35]),
  TOTE_BUCKET: D('STORAGE', 3, 0.76, 0.4, 0.6, [0x2d5485, 0x8f823d, 0x444b54]),
  // SocketWallFixtures (wall: w × h face, d out from the wall).
  PLAQUE: D('FIXTURES', 0, 0.3, 0.04, 0.14, [0x1c2026], true),
  BREAKER: D('FIXTURES', 1, 0.42, 0.18, 0.56, [0x565a60, 0x6c6556, 0x6a2420], true),
  KEYPAD: D('FIXTURES', 2, 0.14, 0.05, 0.28, [0x3ad8ff, 0x4a7dff, 0x5cffc8], true),
  SCONCE: D('FIXTURES', 3, 0.24, 0.16, 0.3, [0xffb054, 0xffd9a0, 0xff5a3a], true),
  // SocketMiscProps.
  STOOLS: D('MISC', 0, 0.86, 0.4, 0.7, [0x585e64, 0x7d2c22, 0x26292e]),
  AFRAME: D('MISC', 1, 0.6, 0.62, 1.02, [0xff3fa8, 0x3ae8ff, 0xffb23a, 0x8cff5a]),
  CANISTERS: D('MISC', 2, 0.62, 0.36, 0.62, [0x742d22, 0x24526a, 0x86782c]),
  UMBRELLA: D('MISC', 3, 0.3, 0.3, 0.86, [0x2a2d33, 0x6a1e2b, 0x23485e]),
  // ClutterDebrisKit (10A-1 consolidated Cardboard v0..2 + TrashBins v3..4; damp cardboard 0x3e3024).
  BOXES: D('DEBRIS', 0, 0.66, 0.5, 0.58, [0x3e3024, 0x35291e, 0x2a2018]),
  BOX_TOWER: D('DEBRIS', 1, 0.72, 0.58, 1.02, [0x3e3024, 0x35291e, 0x2a2018]),
  BOX_PILE: D('DEBRIS', 2, 0.95, 0.66, 0.32, [0x3e3024, 0x35291e, 0x2a2018]),
  BIN_BAGS: D('DEBRIS', 3, 1.05, 0.62, 0.96, [0x32373e, 0x233b2e, 0x3b2e22]),
  BAG_MOUND: D('DEBRIS', 4, 0.95, 0.72, 0.56, [0x101114, 0x1a1d22, 0x252830]),
  // ClutterDumpsters (1.80 × 1.15 × 1.10 m, crouch cover).
  DUMPSTER: D('DUMPSTER', 0, 1.8, 1.15, 1.1, [0x1e3328, 0x492a1f, 0x222730], false, 1.1),
  DUMPSTER_OPEN: D('DUMPSTER', 1, 1.8, 1.15, 1.1, [0x1e3328, 0x492a1f, 0x222730], false, 1.1),
  // ClutterBenches (1.85 × 0.62 × 0.82 m, low seat collider — a step-over / sit-on surface).
  BENCH: D('BENCH', 0, 1.85, 0.62, 0.82, [0x523e2c, 0x3c2d20, 0x484640], false, 0.44),
  // ClutterScrapBarriers (10A-2 rain-wet concrete jersey 0x4e5258 & muted industrial scrap).
  PALLETS: D('SCRAP', 0, 1.22, 1.02, 0.62, [0x584634, 0x463829, 0x4f4333]),
  DRUMS: D('SCRAP', 1, 1.28, 0.64, 0.9, [0x4c271d, 0x1a4848, 0x8c701b]),
  JERSEY: D('SCRAP', 2, 1.8, 0.52, 0.85, [0x4e5258, 0x45494f, 0x565a60], false, 0.85),
  CONES: D('SCRAP', 3, 0.92, 0.46, 0.72, [0xb84210, 0xc44c18, 0xa8380c]),
};

// =============================================================================================
// Placed instances
// =============================================================================================
export interface PropInstance {
  id: PropId;
  kit: KitId;
  v: number;
  /** Floor props: footprint centre at floor level. Wall fixtures: back centre on the wall, y = centre. */
  x: number;
  y: number;
  z: number;
  /** Local +Z (front) faces (sin yaw, cos yaw). */
  yaw: number;
  s: number;
  tint: number;
  /** Plaque atlas cell (0..15) / -1. */
  cell: number;
  /** Emissive gain (plaques, keypads, A-frame panels, sconces). */
  glow: number;
  /** World AABB of the placed prop. */
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  y0: number;
  y1: number;
  /** Sockets: slot and door (−1 for bays / clutter). */
  slot: SocketSlot | 'CLUTTER';
  door: number;
  building: number;
}

export interface Aabb3 {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export interface RectXZLike {
  readonly x0: number;
  readonly z0: number;
  readonly x1: number;
  readonly z1: number;
}

/** Optional world blocker (existing colliders / pipes / lamp poles): true = the AABB is not free. */
export type BlockedFn = (minX: number, minZ: number, maxX: number, maxZ: number, y0: number, y1: number) => boolean;

const hash32 = (seed: number, salt: number): number => (Math.floor(seed * 4294967296) ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0;

function pickWeighted<T>(rng: () => number, list: ReadonlyArray<readonly [T, number]>): T | null {
  let sum = 0;
  for (const [, w] of list) sum += w;
  if (sum <= 0) return null;
  let r = rng() * sum;
  for (const [t, w] of list) {
    r -= w;
    if (r <= 0) return t;
  }
  return list[list.length - 1][0];
}

/** Places a def at a face-local position: along offset `a` (from the socket), back at `d0` out from the socket line. */
function placeOnFace(
  def: PropDef,
  id: PropId,
  sx: number,
  sy: number,
  sz: number,
  nx: number,
  nz: number,
  a: number,
  d0: number,
  yawJ: number,
  s: number,
  extra: Pick<PropInstance, 'tint' | 'cell' | 'glow' | 'slot' | 'door' | 'building'>,
): PropInstance {
  // Along unit (perpendicular to the normal in XZ).
  const ux = nz !== 0 ? 1 : 0;
  const uz = nx !== 0 ? 1 : 0;
  const c = Math.abs(Math.cos(yawJ));
  const sn = Math.abs(Math.sin(yawJ));
  const ew = (c * def.w + sn * def.d) * s;
  const ed = (sn * def.w + c * def.d) * s;
  let x: number;
  let z: number;
  let y: number;
  let y0: number;
  let y1: number;
  if (def.wall) {
    // Back on the mounting plane (socket point − 0.02), centred at the socket height.
    const back = d0 - PROPS.WALL_SOCKET_OFFSET_M;
    x = sx + ux * a + nx * back;
    z = sz + uz * a + nz * back;
    y = sy;
    y0 = sy - (def.h * s) / 2;
    y1 = sy + (def.h * s) / 2;
  } else {
    x = sx + ux * a + nx * (d0 + ed / 2);
    z = sz + uz * a + nz * (d0 + ed / 2);
    y = sy;
    y0 = sy;
    y1 = sy + def.h * s;
  }
  const baseYaw = Math.atan2(nx, nz);
  // World AABB: along extent ew, outward extent ed (wall fixtures: from the plane outward).
  const halfA = ew / 2;
  const [o0, o1] = def.wall ? [0, ed] : [-ed / 2, ed / 2];
  const ax0 = x + ux * -halfA + nx * o0;
  const ax1 = x + ux * halfA + nx * o1;
  const az0 = z + uz * -halfA + nz * o0;
  const az1 = z + uz * halfA + nz * o1;
  return {
    id,
    kit: def.kit,
    v: def.v,
    x,
    y,
    z,
    yaw: baseYaw + yawJ,
    s,
    minX: Math.min(ax0, ax1),
    maxX: Math.max(ax0, ax1),
    minZ: Math.min(az0, az1),
    maxZ: Math.max(az0, az1),
    y0,
    y1,
    ...extra,
  };
}

// =============================================================================================
// 9B-1 Socket composer
// =============================================================================================
type Table = ReadonlyArray<readonly [PropId, number]>;

/** Floor props by group (door FLOOR_L / FLOOR_R). */
const FLOOR_TABLE: Readonly<Record<SocketGroup, Table>> = {
  GALLERY: [['POT_PLANT', 3], ['PLANT_ON_BIN', 2], ['SUCCULENTS', 1.5], ['WIRE_RACK', 3], ['BINS', 2.5], ['CRATES', 1], ['TOTE_BUCKET', 1.5], ['UMBRELLA', 1.5]],
  APARTMENT: [['POT_PLANT', 2], ['PLANTER', 1.5], ['SUCCULENTS', 1], ['BINS', 1.5], ['TOTE_BUCKET', 1], ['UMBRELLA', 2], ['WIRE_RACK', 0.8]],
  EATERY: [['CRATES', 3], ['CANISTERS', 2], ['AFRAME', 2.5], ['STOOLS', 2.5], ['PLANTER', 1], ['BINS', 0.8]],
  TECH: [['AFRAME', 3], ['PLANTER', 2.5], ['POT_PLANT', 1.2], ['CRATES', 0.6]],
  HOTEL: [['PLANTER', 3], ['POT_PLANT', 1.5], ['UMBRELLA', 2.5], ['SUCCULENTS', 1]],
  INFRA: [['CRATES', 3], ['CANISTERS', 3], ['TOTE_BUCKET', 2], ['BINS', 1.5], ['WIRE_RACK', 0.8]],
};

/** Storefront bay props (BAY sockets). */
const BAY_TABLE: Readonly<Record<SocketGroup, Table>> = {
  GALLERY: [['POT_PLANT', 1]],
  APARTMENT: [['POT_PLANT', 2], ['PLANTER', 2], ['BINS', 1], ['SUCCULENTS', 1]],
  EATERY: [['CRATES', 3], ['STOOLS', 3], ['CANISTERS', 1.5], ['AFRAME', 1.5], ['PLANTER', 1]],
  TECH: [['AFRAME', 2.5], ['PLANTER', 2.5], ['POT_PLANT', 1]],
  HOTEL: [['PLANTER', 3], ['POT_PLANT', 2], ['UMBRELLA', 1]],
  INFRA: [['CRATES', 3], ['CANISTERS', 2.5], ['TOTE_BUCKET', 2], ['BINS', 1]],
};
const BAY_EMPTY: Readonly<Record<SocketGroup, number>> = { GALLERY: 1, APARTMENT: 0.55, EATERY: 0.3, TECH: 0.45, HOTEL: 0.4, INFRA: 0.35 };

/** WALL_SIDE fixtures by group. */
const SIDE_TABLE: Readonly<Record<SocketGroup, Table>> = {
  GALLERY: [['BREAKER', 3], ['KEYPAD', 3], ['SCONCE', 1.5]],
  APARTMENT: [['KEYPAD', 3], ['BREAKER', 2], ['SCONCE', 1]],
  EATERY: [['SCONCE', 2], ['KEYPAD', 1.5], ['PLAQUE', 1]],
  TECH: [['KEYPAD', 3], ['PLAQUE', 1.5]],
  HOTEL: [['KEYPAD', 3], ['PLAQUE', 1]],
  INFRA: [['BREAKER', 3], ['KEYPAD', 1.5], ['SCONCE', 2]],
};

const GLOW: Partial<Record<PropId, number>> = { PLAQUE: 1, KEYPAD: 1, SCONCE: 1, AFRAME: 1, BREAKER: 1 };

export interface DoorComposition {
  door: number;
  building: number;
  y: number;
  tidy: boolean;
  /** Composition key (slot:prop per placed item, plaque excluded): adjacent doors never share one. */
  signature: string;
  props: PropInstance[];
}

export interface ComposeResult {
  doors: DoorComposition[];
  /** Storefront bay props. */
  bays: PropInstance[];
}


interface Fitted {
  a: number;
  yawJ: number;
  s: number;
}

/** Fits a floor def into a socket's free range with jitter; null if it cannot fit. */
function fitFloor(def: PropDef, sock: PropSocket, rng: () => number): Fitted | null {
  if (sock.low && def.h * PROPS.SCALE_MIN > PROPS.LOW_MAX_H) return null;
  let s = PROPS.SCALE_MIN + rng() * (PROPS.SCALE_MAX - PROPS.SCALE_MIN);
  let yawJ = (rng() * 2 - 1) * PROPS.JITTER_YAW_RAD;
  const lat = rng() * 2 - 1;
  for (let attempt = 0; attempt < 2; attempt++) {
    const c = Math.abs(Math.cos(yawJ));
    const sn = Math.abs(Math.sin(yawJ));
    const ew1 = c * def.w + sn * def.d;
    const ed1 = sn * def.w + c * def.d;
    const sMax = Math.min(sock.w / ew1, sock.depth / ed1, sock.low ? PROPS.LOW_MAX_H / def.h : Infinity);
    if (sMax >= PROPS.SCALE_MIN) {
      s = Math.min(s, sMax);
      const slack = Math.max(0, (sock.w - ew1 * s) / 2);
      return { a: lat * Math.min(PROPS.JITTER_LAT_M, slack), yawJ, s };
    }
    yawJ = 0;
  }
  return null;
}

function fitWall(def: PropDef, sock: PropSocket, rng: () => number): Fitted | null {
  const s = 0.96 + rng() * 0.08;
  if (def.w * s > sock.w + 1e-6 || def.d * s > sock.depth + 1e-6) return null;
  return { a: 0, yawJ: 0, s };
}

interface ComposeCtx {
  blocked?: BlockedFn;
  /** Plaque cell sequencer per building (consecutive doors → consecutive room numbers). */
  plaque: Map<number, number>;
}

/**
 * Composes one door. `salt` re-rolls the composition (adjacency de-duplication); the plaque cell does not change
 * between re-rolls.
 */
function composeOneDoor(socks: readonly PropSocket[], salt: number, forceTidy: boolean | null, cell: number, ctx: ComposeCtx): DoorComposition {
  const first = socks[0];
  const rng = createRng(hash32(first.seed, 0x9b1 + salt * 7919));
  const group = first.group;
  const bySlot = new Map<SocketSlot, PropSocket>();
  for (const s of socks) bySlot.set(s.slot, s);
  const tidyRoll = rng() < PROPS.TIDY_CHANCE;
  const tidy = forceTidy ?? tidyRoll;
  const props: PropInstance[] = [];
  const used = new Set<PropId>();
  const sigParts: string[] = [];
  const free = (p: PropInstance): boolean => !ctx.blocked || !ctx.blocked(p.minX, p.minZ, p.maxX, p.maxZ, p.y0, p.y1);
  const base = (slot: SocketSlot, def: PropDef, sock: PropSocket, tintRoll: number, glow: number, c = -1): Pick<PropInstance, 'tint' | 'cell' | 'glow' | 'slot' | 'door' | 'building'> => ({
    tint: def.tints[Math.floor(tintRoll * def.tints.length) % def.tints.length],
    cell: c,
    glow,
    slot,
    door: sock.door,
    building: sock.building,
  });
  const placeFixture = (slot: SocketSlot, id: PropId, c = -1): PropInstance | null => {
    const sock = bySlot.get(slot);
    if (!sock) return null;
    const def = PROP_DEFS[id];
    const f = fitWall(def, sock, rng);
    const tintRoll = rng();
    const glow = (GLOW[id] ?? 0) * (0.8 + rng() * 0.4);
    if (!f) return null;
    const p = placeOnFace(def, id, sock.x, sock.y, sock.z, sock.nx, sock.nz, f.a, 0, 0, f.s, base(slot, def, sock, tintRoll, glow, c));
    if (!free(p)) return null;
    props.push(p);
    return p;
  };
  // Room-number plaque above the lintel (always), or beside the frame on shopfronts.
  const hasHigh = bySlot.has('WALL_HIGH');
  if (hasHigh) placeFixture('WALL_HIGH', 'PLAQUE', cell);
  let side: PropInstance | null = null;
  if (tidy) {
    // Tidy doorway: plaque + keypad / intercom only.
    side = placeFixture('WALL_SIDE', 'KEYPAD') ?? (hasHigh ? null : placeFixture('WALL_SIDE', 'PLAQUE', cell));
    if (side) sigParts.push(`WALL_SIDE:${side.id}`);
    return { door: first.door, building: first.building, y: first.y, tidy: true, signature: `TIDY|${sigParts.join('|')}`, props };
  }
  // 1–3 distinct props across the non-plaque slots.
  const slots = (['FLOOR_L', 'FLOOR_R', 'WALL_SIDE'] as const).filter((s) => bySlot.has(s));
  for (let i = slots.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [slots[i], slots[j]] = [slots[j], slots[i]];
  }
  const want = Math.min(slots.length, 1 + Math.floor(rng() * 3));
  // Wall fixture first (floor props must stay below it where they share the wall).
  const chosen = slots.slice(0, want).sort((p, q) => (p === 'WALL_SIDE' ? -1 : q === 'WALL_SIDE' ? 1 : 0));
  for (const slot of chosen) {
    const sock = bySlot.get(slot) as PropSocket;
    if (slot === 'WALL_SIDE') {
      const id = pickWeighted(rng, SIDE_TABLE[group].filter(([k]) => !(hasHigh && k === 'PLAQUE')));
      if (!id) continue;
      side = placeFixture('WALL_SIDE', id, id === 'PLAQUE' ? cell : -1);
      if (side) {
        used.add(id);
        sigParts.push(`WALL_SIDE:${id}`);
      }
      continue;
    }
    // Floor: try weighted picks until one fits the free space, clears the fixture and the world.
    let table = FLOOR_TABLE[group].filter(([k]) => !used.has(k));
    for (let tries = 0; tries < 5 && table.length; tries++) {
      const id = pickWeighted(rng, table) as PropId;
      table = table.filter(([k]) => k !== id);
      const def = PROP_DEFS[id];
      const f = fitFloor(def, sock, rng);
      const tintRoll = rng();
      if (!f) continue;
      const p = placeOnFace(def, id, sock.x, sock.y, sock.z, sock.nx, sock.nz, f.a, 0, f.yawJ, f.s, base(slot, def, sock, tintRoll, (GLOW[id] ?? 0) * (0.8 + rng() * 0.4)));
      if (side && overlapsAlong(p, side, sock) && p.y1 > side.y0 - 0.04) continue;
      if (!free(p)) continue;
      props.push(p);
      used.add(id);
      sigParts.push(`${slot}:${id}`);
      break;
    }
  }
  sigParts.sort();
  return { door: first.door, building: first.building, y: first.y, tidy: false, signature: sigParts.join('|'), props };
}

function overlapsAlong(p: PropInstance, q: PropInstance, sock: { nx: number }): boolean {
  if (sock.nx !== 0) return p.maxZ > q.minZ + 0.01 && p.minZ < q.maxZ - 0.01;
  return p.maxX > q.minX + 0.01 && p.minX < q.maxX - 0.01;
}

/** Bay props: 0–2 items along the storefront bay. */
function composeBay(sock: PropSocket, ctx: ComposeCtx): PropInstance[] {
  const rng = createRng(hash32(sock.seed, 0xba7));
  if (rng() < BAY_EMPTY[sock.group]) return [];
  const out: PropInstance[] = [];
  const two = sock.w >= 1.7 && rng() < 0.4;
  const parts = two ? [-1, 1] : [0];
  const used = new Set<PropId>();
  for (const k of parts) {
    const sub: PropSocket = two ? { ...sock, w: sock.w / 2 - 0.1 } : sock;
    const off = two ? (k * sock.w) / 4 : 0;
    let table = BAY_TABLE[sock.group].filter(([id]) => !used.has(id));
    for (let tries = 0; tries < 4 && table.length; tries++) {
      const id = pickWeighted(rng, table) as PropId;
      table = table.filter(([t]) => t !== id);
      const def = PROP_DEFS[id];
      const f = fitFloor(def, sub, rng);
      const tintRoll = rng();
      if (!f) continue;
      const p = placeOnFace(def, id, sock.x, sock.y, sock.z, sock.nx, sock.nz, off + f.a, 0, f.yawJ, f.s, {
        tint: def.tints[Math.floor(tintRoll * def.tints.length) % def.tints.length],
        cell: -1,
        glow: (GLOW[id] ?? 0) * (0.8 + rng() * 0.4),
        slot: 'BAY',
        door: -1,
        building: sock.building,
      });
      if (ctx.blocked && ctx.blocked(p.minX, p.minZ, p.maxX, p.maxZ, p.y0, p.y1)) continue;
      out.push(p);
      used.add(id);
      break;
    }
  }
  return out;
}

/**
 * 9B-1: composes every door (sockets grouped by `door`, in emission order) and storefront bay. Adjacent doors
 * (consecutive ids of one building on one floor) never share a composition, and no two adjacent doors are both tidy.
 */
export function composeSockets(sockets: readonly PropSocket[], blocked?: BlockedFn): ComposeResult {
  const ctx: ComposeCtx = { blocked, plaque: new Map() };
  const byDoor = new Map<number, PropSocket[]>();
  const order: number[] = [];
  const bays: PropInstance[] = [];
  for (const s of sockets) {
    if (s.slot === 'BAY' || s.door < 0) {
      bays.push(...composeBay(s, ctx));
      continue;
    }
    let l = byDoor.get(s.door);
    if (!l) {
      l = [];
      byDoor.set(s.door, l);
      order.push(s.door);
    }
    l.push(s);
  }
  const doors: DoorComposition[] = [];
  let prev: DoorComposition | null = null;
  for (const id of order) {
    const socks = byDoor.get(id) as PropSocket[];
    const first = socks[0];
    const n = ctx.plaque.get(first.building) ?? 0;
    ctx.plaque.set(first.building, n + 1);
    const cell = (first.building * 7 + n) % PLAQUE_LABELS.length;
    const adjacent = prev !== null && prev.door === id - 1 && prev.building === first.building && Math.abs(prev.y - first.y) < 0.5;
    let comp = composeOneDoor(socks, 0, adjacent && prev?.tidy ? false : null, cell, ctx);
    for (let salt = 1; adjacent && prev && comp.signature === prev.signature && salt < 12; salt++) {
      comp = composeOneDoor(socks, salt, salt > 6 ? !prev.tidy : prev.tidy ? false : null, cell, ctx);
    }
    doors.push(comp);
    prev = comp;
  }
  return { doors, bays };
}

// =============================================================================================
// 9B-2 Clutter clusters
// =============================================================================================
/** SERVICE = sidewalk frontage of an infra / back-of-house face (dumpsters, pallets, drums). */
export type StripKind = 'ALLEY' | 'WALL' | 'SERVICE' | 'CURB' | 'COURT' | 'UNDERPASS' | 'OPEN';

/**
 * A placement strip: back line at `line` on the axis perpendicular to `ax` (the along axis), outward sign `sg`,
 * footprints between d0 and d1 out from the line, along [a0, a1], ground height y.
 */
export interface ClutterStrip {
  kind: StripKind;
  ax: 'x' | 'z';
  a0: number;
  a1: number;
  line: number;
  sg: 1 | -1;
  d0: number;
  d1: number;
  /** The back line is a wall-run face: collidable clutter keeps d ≥ RUN_STRIP_M. */
  run: boolean;
  y: number;
  seed: number;
  /** Mean cluster spacing (m). */
  spacing: number;
}

export interface ClutterInput {
  strips: readonly ClutterStrip[];
  /** Forbidden ground rects: door clear zones, crosswalks, junctions, ramps, car slots. */
  forbid: readonly RectXZLike[];
  /** Spawn points collidable clutter keeps clear of. */
  spawns: ReadonlyArray<{ x: number; z: number }>;
  /** Already placed footprints (socket props, vending …). */
  occupied: readonly Aabb3[];
  blocked?: BlockedFn;
  /** Remaining capacity per kit. */
  caps?: Partial<Record<KitId, number>>;
}

export interface ClutterResult {
  items: PropInstance[];
  colliders: Aabb3[];
  /** Items placed per strip kind and dumpsters per strip kind (verification). */
  byKind: Record<StripKind, number>;
  dumpstersByKind: Record<StripKind, number>;
}

/** Cluster recipe: items laid side by side along the strip; `d` = extra outward offset; optional items may be skipped. */
type Recipe = ReadonlyArray<{ id: PropId; d: number; optional?: boolean }>;

/** Cluster recipes (along offset from the cluster start, outward offset from the strip's d0). */
const RECIPES: Readonly<Record<StripKind, ReadonlyArray<readonly [Recipe, number]>>> = {
  ALLEY: [
    [[{ id: 'BOXES', d: 0 }, { id: 'BAG_MOUND', d: 0, optional: true }, { id: 'BOX_PILE', d: 0, optional: true }], 3],
    [[{ id: 'BIN_BAGS', d: 0 }, { id: 'BOXES', d: 0, optional: true }], 3],
    [[{ id: 'DUMPSTER', d: 0 }, { id: 'BAG_MOUND', d: 0, optional: true }, { id: 'BOX_PILE', d: 0, optional: true }], 2.6],
    [[{ id: 'DUMPSTER_OPEN', d: 0 }, { id: 'BOXES', d: 0, optional: true }], 1.6],
    [[{ id: 'PALLETS', d: 0 }, { id: 'DRUMS', d: 0, optional: true }], 1.2],
    [[{ id: 'DRUMS', d: 0 }, { id: 'BOX_TOWER', d: 0, optional: true }], 1.2],
    [[{ id: 'BAG_MOUND', d: 0 }, { id: 'BOX_PILE', d: 0, optional: true }], 1.6],
    [[{ id: 'BOX_TOWER', d: 0 }, { id: 'BOXES', d: 0, optional: true }], 1.4],
  ],
  WALL: [
    [[{ id: 'BOXES', d: 0 }, { id: 'BAG_MOUND', d: 0, optional: true }], 3],
    [[{ id: 'BAG_MOUND', d: 0 }], 2],
    [[{ id: 'BIN_BAGS', d: 0 }], 2],
    [[{ id: 'BOX_TOWER', d: 0 }, { id: 'BOX_PILE', d: 0, optional: true }], 1.5],
  ],
  SERVICE: [
    [[{ id: 'DUMPSTER', d: 0 }, { id: 'BAG_MOUND', d: 0, optional: true }], 3],
    [[{ id: 'DUMPSTER_OPEN', d: 0 }, { id: 'BOXES', d: 0, optional: true }], 1.5],
    [[{ id: 'PALLETS', d: 0 }, { id: 'DRUMS', d: 0, optional: true }], 1.5],
    [[{ id: 'BOX_TOWER', d: 0 }, { id: 'BAG_MOUND', d: 0, optional: true }], 1.5],
    [[{ id: 'BIN_BAGS', d: 0 }], 1],
  ],
  CURB: [
    [[{ id: 'BENCH', d: 0 }], 3],
    [[{ id: 'BIN_BAGS', d: 0 }], 2.5],
    [[{ id: 'CONES', d: 0 }], 0.6],
  ],
  COURT: [
    [[{ id: 'DUMPSTER', d: 0 }, { id: 'BAG_MOUND', d: 0, optional: true }], 2.5],
    [[{ id: 'BENCH', d: 0.3 }], 2],
    [[{ id: 'BOXES', d: 0 }, { id: 'BOX_TOWER', d: 0, optional: true }], 2],
    [[{ id: 'PALLETS', d: 0 }, { id: 'DRUMS', d: 0, optional: true }], 1.5],
    [[{ id: 'BIN_BAGS', d: 0 }, { id: 'BOX_PILE', d: 0, optional: true }], 1.5],
  ],
  UNDERPASS: [
    [[{ id: 'JERSEY', d: 0 }, { id: 'CONES', d: 0, optional: true }], 3],
    [[{ id: 'DRUMS', d: 0 }, { id: 'PALLETS', d: 0, optional: true }], 2],
    [[{ id: 'CONES', d: 0 }, { id: 'BOXES', d: 0, optional: true }], 1.5],
    [[{ id: 'DUMPSTER', d: 0 }, { id: 'BAG_MOUND', d: 0, optional: true }], 1],
    [[{ id: 'BOX_PILE', d: 0 }, { id: 'BAG_MOUND', d: 0, optional: true }], 1.2],
  ],
  OPEN: [
    [[{ id: 'BENCH', d: 0 }], 3],
    [[{ id: 'BIN_BAGS', d: 0 }], 1.5],
  ],
};

const rectHit = (a: { minX: number; minZ: number; maxX: number; maxZ: number }, r: RectXZLike, m = 0): boolean => a.maxX > r.x0 - m && a.minX < r.x1 + m && a.maxZ > r.z0 - m && a.minZ < r.z1 + m;
const boxHit = (a: PropInstance, b: Aabb3, m = 0.04): boolean => a.maxX > b.minX - m && a.minX < b.maxX + m && a.maxZ > b.minZ - m && a.minZ < b.maxZ + m && a.y1 > b.minY && a.y0 < b.maxY;

/** Uniform 2 m hash of placed footprints for overlap tests. */
class FootGrid {
  private readonly cells = new Map<number, Aabb3[]>();
  private key(i: number, j: number): number {
    return (i + 4096) * 8192 + (j + 4096);
  }
  add(b: Aabb3): void {
    for (let i = Math.floor(b.minX / 2); i <= Math.floor(b.maxX / 2); i++) {
      for (let j = Math.floor(b.minZ / 2); j <= Math.floor(b.maxZ / 2); j++) {
        const k = this.key(i, j);
        const l = this.cells.get(k);
        if (l) l.push(b);
        else this.cells.set(k, [b]);
      }
    }
  }
  hits(p: PropInstance, m = 0.04): boolean {
    for (let i = Math.floor((p.minX - m) / 2); i <= Math.floor((p.maxX + m) / 2); i++) {
      for (let j = Math.floor((p.minZ - m) / 2); j <= Math.floor((p.maxZ + m) / 2); j++) {
        const l = this.cells.get(this.key(i, j));
        if (l && l.some((b) => boxHit(p, b, m))) return true;
      }
    }
    return false;
  }
}

export const toAabb = (p: PropInstance): Aabb3 => ({ minX: p.minX, minY: p.y0, minZ: p.minZ, maxX: p.maxX, maxY: p.y1, maxZ: p.maxZ });

/**
 * 9B-2: organic clutter clusters along every strip. Collidable items (dumpsters, jersey barriers, bench seats) are
 * axis-aligned (exact AABB colliders), stay ≥ RUN_STRIP_M off wall-run faces and clear of spawn points.
 */
export function planClutter(input: ClutterInput): ClutterResult {
  const grid = new FootGrid();
  for (const o of input.occupied) grid.add(o);
  const caps: Record<KitId, number> = { ...KIT_CAP, ...(input.caps ?? {}) };
  const items: PropInstance[] = [];
  const colliders: Aabb3[] = [];
  const zero = (): Record<StripKind, number> => ({ ALLEY: 0, WALL: 0, SERVICE: 0, CURB: 0, COURT: 0, UNDERPASS: 0, OPEN: 0 });
  const byKind = zero();
  const dumpstersByKind = zero();
  for (const st of input.strips) {
    const rng = createRng(hash32(st.seed, 0xc1a));
    const nx = st.ax === 'z' ? st.sg : 0;
    const nz = st.ax === 'x' ? st.sg : 0;
    // Socket-like origin on the back line at a = 0 (along coordinate = world x or z).
    const ox = st.ax === 'x' ? 0 : st.line;
    const oz = st.ax === 'x' ? st.line : 0;
    let a = st.a0 + rng() * st.spacing * 0.6;
    while (a < st.a1 - 0.4) {
      const recipe = pickWeighted(rng, RECIPES[st.kind]) as Recipe;
      let cursor = a;
      let placedAny = false;
      for (const part of recipe) {
        const def = PROP_DEFS[part.id];
        if (caps[def.kit] <= 0) {
          if (!part.optional) break;
          continue;
        }
        const collidable = def.colliderH > 0;
        // Collidables are axis-aligned; soft clutter gets the ±12° / 0.88–1.12× jitter.
        const yawJ = collidable ? 0 : (rng() * 2 - 1) * PROPS.JITTER_YAW_RAD;
        const s = collidable ? 1 : PROPS.SCALE_MIN + rng() * (PROPS.SCALE_MAX - PROPS.SCALE_MIN);
        const c = Math.abs(Math.cos(yawJ));
        const sn = Math.abs(Math.sin(yawJ));
        const ew = (c * def.w + sn * def.d) * s;
        const ed = (sn * def.w + c * def.d) * s;
        let dBack = st.d0 + part.d;
        // Wall-run strips: collidables and anything taller than LOW_MAX_H start beyond the run band.
        if (st.run && (collidable || def.h * s > PROPS.LOW_MAX_H)) dBack = Math.max(dBack, PROPS.RUN_STRIP_M);
        const centreA = (placedAny ? cursor : a) + ew / 2;
        const ok = dBack + ed <= st.d1 + 1e-6 && centreA + ew / 2 <= st.a1 && centreA - ew / 2 >= st.a0;
        let placed: PropInstance | null = null;
        if (ok) {
          // Soft clutter may face either way; benches on a curb face the street (their back to the walk).
          const flip = collidable ? (st.kind === 'CURB' && def.kit === 'BENCH' ? Math.PI : 0) : rng() < 0.5 ? Math.PI : 0;
          const p = placeOnFace(def, part.id, ox, st.y, oz, nx, nz, centreA, dBack, yawJ + flip, s, {
            tint: def.tints[Math.floor(rng() * def.tints.length) % def.tints.length],
            cell: -1,
            glow: 0,
            slot: 'CLUTTER',
            door: -1,
            building: -1,
          });
          const spawnHit = collidable && input.spawns.some((q) => q.x > p.minX - PROPS.SPAWN_CLEAR_M && q.x < p.maxX + PROPS.SPAWN_CLEAR_M && q.z > p.minZ - PROPS.SPAWN_CLEAR_M && q.z < p.maxZ + PROPS.SPAWN_CLEAR_M);
          const clear =
            !spawnHit &&
            !input.forbid.some((r) => rectHit(p, r, 0.05)) &&
            !grid.hits(p) &&
            !(input.blocked && input.blocked(p.minX, p.minZ, p.maxX, p.maxZ, p.y0, p.y1));
          if (clear) placed = p;
        }
        if (!placed) {
          if (!part.optional && !placedAny) break;
          continue;
        }
        items.push(placed);
        byKind[st.kind]++;
        if (def.kit === 'DUMPSTER') dumpstersByKind[st.kind]++;
        const box = { minX: placed.minX, minY: placed.y0, minZ: placed.minZ, maxX: placed.maxX, maxY: placed.y1, maxZ: placed.maxZ };
        grid.add(box);
        caps[def.kit]--;
        if (collidable) colliders.push({ ...box, maxY: placed.y0 + def.colliderH });
        cursor = centreA + ew / 2 + 0.08 + rng() * 0.25;
        placedAny = true;
      }
      a = (placedAny ? cursor : a) + st.spacing * (0.55 + rng() * 0.9);
    }
  }
  return { items, colliders, byKind, dumpstersByKind };
}

/** Clear centre band of an alley (lateral [gap0, gap1] across, along [ov0, ov1]) as a ground rect. */
export function alleyCentreBand(al: { axis: 'x' | 'z'; gap0: number; gap1: number; ov0: number; ov1: number }): RectXZLike {
  const c = (al.gap0 + al.gap1) / 2;
  const h = PROPS.ALLEY_CLEAR_M / 2;
  return al.axis === 'x' ? { x0: c - h, x1: c + h, z0: al.ov0, z1: al.ov1 } : { x0: al.ov0, x1: al.ov1, z0: c - h, z1: c + h };
}

/**
 * Both wall strips of an alley: depth stops short of the clear centre band. `service` (0 = the gap0 wall, 1 = the
 * gap1 wall) marks the one side whose wall is not a clean run strip (dumpsters / bins may stand against it).
 */
export function alleyStrips(al: { axis: 'x' | 'z'; gap0: number; gap1: number; ov0: number; ov1: number }, seed: number, d0: number, service: 0 | 1 | null = null): ClutterStrip[] {
  const half = (al.gap1 - al.gap0 - PROPS.ALLEY_CLEAR_M) / 2 - 0.02;
  if (half - d0 < 0.3) return [];
  // Alley across x (gap along x): walls are x-planes, the along axis is z.
  const along: 'x' | 'z' = al.axis === 'x' ? 'z' : 'x';
  return [
    { kind: 'ALLEY', ax: along, a0: al.ov0 + 0.3, a1: al.ov1 - 0.3, line: al.gap0, sg: 1, d0, d1: half, run: service !== 0, y: 0, seed, spacing: service === 0 ? 2.2 : 3.4 },
    { kind: 'ALLEY', ax: along, a0: al.ov0 + 0.3, a1: al.ov1 - 0.3, line: al.gap1, sg: -1, d0, d1: half, run: service !== 1, y: 0, seed: (seed + 0.5) % 1, spacing: service === 1 ? 2.2 : 3.4 },
  ];
}

// =============================================================================================
// 9B-3 Graffiti / poster decals
// =============================================================================================
/** Atlas cells: 0–3 spray graffiti / stencils, 4–7 torn posters / caution stencils. */
export type DecalSurfaceKind = 'SHUTTER' | 'PIER' | 'HWPIER' | 'DUMPSTER' | 'WALL';

/** A vertical surface: plane normal along ±`nAx` at `plane`, along [a0, a1] (the other horizontal axis), y [y0, y1]. */
export interface DecalSurface {
  kind: DecalSurfaceKind;
  nAx: 'x' | 'z';
  sg: 1 | -1;
  plane: number;
  a0: number;
  a1: number;
  y0: number;
  y1: number;
  seed: number;
}

export interface DecalInstance {
  x: number;
  y: number;
  z: number;
  nx: number;
  nz: number;
  w: number;
  h: number;
  cell: number;
  tint: number;
  roll: number;
  kind: DecalSurfaceKind;
}

const DECAL_RULES: Readonly<Record<DecalSurfaceKind, { chance: number; perM: number; cells: readonly number[]; size: readonly [number, number] }>> = {
  SHUTTER: { chance: 0.7, perM: 0.42, cells: [0, 1, 2, 3, 0, 1, 6], size: [0.8, 1.9] },
  PIER: { chance: 0.5, perM: 1.2, cells: [4, 5, 4, 5, 7, 3], size: [0.36, 0.46] },
  HWPIER: { chance: 0.85, perM: 0.9, cells: [0, 1, 2, 3, 4, 5, 6, 7], size: [0.55, 1.2] },
  DUMPSTER: { chance: 0.55, perM: 0.6, cells: [0, 1, 2, 3, 7], size: [0.45, 0.85] },
  WALL: { chance: 0.6, perM: 0.35, cells: [0, 1, 2, 3, 4, 5, 6, 7], size: [0.6, 1.6] },
};
const DECAL_TINTS: readonly number[] = [0xffffff, 0xffffff, 0xe8f6ff, 0xffe8f4, 0xf4ffe0, 0xffeedd];

/** 9B-3: decals on every surface (deterministic, non-stacking beyond a 25 % overlap, capped). */
export function planDecals(surfaces: readonly DecalSurface[], cap: number = PROPS.CAP.DECAL): DecalInstance[] {
  const out: DecalInstance[] = [];
  for (const sf of surfaces) {
    if (out.length >= cap) break;
    const R = DECAL_RULES[sf.kind];
    const rng = createRng(hash32(sf.seed, 0xdec));
    if (rng() > R.chance) continue;
    const len = sf.a1 - sf.a0;
    const hgt = sf.y1 - sf.y0;
    const n = Math.max(1, Math.round(len * R.perM * (0.5 + rng())));
    const mine: DecalInstance[] = [];
    for (let k = 0; k < n * 2 && mine.length < n && out.length + mine.length < cap; k++) {
      const size = Math.min(R.size[0] + rng() * (R.size[1] - R.size[0]), len - 0.04, hgt - 0.04);
      if (size < 0.3) break;
      const cell = R.cells[Math.floor(rng() * R.cells.length)];
      // Posters are portrait-ish; tags are landscape-ish.
      const w = cell >= 4 ? size * 0.78 : size;
      const h = cell >= 4 ? size : size * 0.62;
      if (w > len - 0.02 || h > hgt - 0.02) continue;
      const a = sf.a0 + w / 2 + rng() * (len - w);
      const y = sf.y0 + h / 2 + rng() * (hgt - h);
      const ov = mine.some((o) => {
        const oa = sf.nAx === 'x' ? o.z : o.x;
        const ix = Math.max(0, Math.min(a + w / 2, oa + o.w / 2) - Math.max(a - w / 2, oa - o.w / 2));
        const iy = Math.max(0, Math.min(y + h / 2, o.y + o.h / 2) - Math.max(y - h / 2, o.y - o.h / 2));
        return ix * iy > 0.25 * Math.min(w * h, o.w * o.h);
      });
      if (ov) continue;
      const p = sf.plane + sf.sg * PROPS.DECAL_OFFSET_M;
      mine.push({
        x: sf.nAx === 'x' ? p : a,
        y,
        z: sf.nAx === 'x' ? a : p,
        nx: sf.nAx === 'x' ? sf.sg : 0,
        nz: sf.nAx === 'z' ? sf.sg : 0,
        w,
        h,
        cell,
        tint: DECAL_TINTS[Math.floor(rng() * DECAL_TINTS.length)],
        roll: (rng() - 0.5) * (cell >= 4 ? 0.12 : 0.22),
        kind: sf.kind,
      });
    }
    out.push(...mine);
  }
  return out;
}
