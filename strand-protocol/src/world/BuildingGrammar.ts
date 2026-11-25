/**
 * STRAND // PROTOCOL — Phase 9A architectural grammar (PHASE9_CITY_OVERHAUL_PLAN.md 9A-1 … 9A-5).
 *
 * Pure planning (plain data, deterministic for a given rng, unit-tested in node) plus small geometry helpers
 * that the CityBuilder merges into its existing buckets:
 *  - 9A-1 strict floor-grid quantization: every roof / setback sits on FACADE.FLOOR_BASE_M[arch] + n · 4 m
 *    (zero sliced windows); parapet edges (1.05 m walls, 0.32 m thick) with fire-escape landing gaps.
 *  - 9A-2 five massings: L_SHAPE (two wing boxes around a recessed street-corner courtyard; the roof record stays
 *    on the larger wing), PODIUM_OFFSET (8 m podium + corner-flush offset tower), STEPPED_SETBACK (2–3 tiers),
 *    GALLERY_DANCHI (walkable 2F–4F exterior corridors) and PENCIL_TOWER (external service-shaft spine).
 *  - 9A-4 five ground-floor programs on one shared 4 m bay grammar with human-scale recessed doors; every door
 *    records a 1.8 m × 1.8 m clear entry zone and deterministic PropSockets for Phase 9B.
 *  - 9A-5 baked vertex ambient occlusion (`aAo`): boxes split at the 0.55 m contact line, dark undersides,
 *    recessed backs and wall-facing pipe sides — no extra draw calls, no extra lights.
 */
import * as THREE from 'three';
import { ARCHETYPE, FACADE } from '../config/constants';
import type { MegaStructureKind } from '../config/skills';

export type Axis = 'x' | 'z';
export interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export type BaseMassingKind = 'L_SHAPE' | 'PODIUM_OFFSET' | 'STEPPED_SETBACK' | 'GALLERY_DANCHI' | 'PENCIL_TOWER';
/** 9A-2 base massings + the four 10B-3 megastructures. */
export type MassingKind = BaseMassingKind | MegaStructureKind;
export const MASSING_KINDS: readonly BaseMassingKind[] = ['L_SHAPE', 'PODIUM_OFFSET', 'STEPPED_SETBACK', 'GALLERY_DANCHI', 'PENCIL_TOWER'];
export const MEGA_KINDS: readonly MegaStructureKind[] = ['X_TRUSS_TOWER', 'CYLINDER_RING_TOWER', 'TWIN_ARCH_GATE', 'SLANT_CORP_TOWER'];
export const isMegaKind = (k: MassingKind): k is MegaStructureKind => (MEGA_KINDS as readonly string[]).includes(k);

export type GroundProgram = 'CYBER_EATERY' | 'TECH_APPAREL' | 'CAPSULE_HOTEL' | 'CYBER_APARTMENT' | 'ALLEY_INFRA';
export const GROUND_PROGRAMS: readonly GroundProgram[] = ['CYBER_EATERY', 'TECH_APPAREL', 'CAPSULE_HOTEL', 'CYBER_APARTMENT', 'ALLEY_INFRA'];

/** Archetype indices (same as the facade atlas columns). */
export const ARCH_A = 0;
export const ARCH_B = 1;
export const ARCH_C = 2;
export const ARCH_D = 3;

/** 9A constants (plan values; tuned extras marked). */
export const GRAMMAR = {
  // 9A-1 parapets
  PARAPET_H: 1.05,
  PARAPET_T: 0.32,
  COPING_H: 0.09,
  COPING_W: 0.38,
  ESCAPE_GAP_M: 2.4,
  BULKHEAD_MIN_ROOF_M: 10,
  // 9A-2 massings
  STEPPED_MIN_ROOF_M: 44,
  STEPPED_CHANCE: 0.65,
  /** Terraces stay above every sky-bridge / Layer-2 sign (≤ 35 m). */
  STEPPED_MIN_SETBACK_Y: 36,
  STEPPED_MIN_TIER_M: 8,
  STEPPED_MID_K: [0.72, 0.84] as readonly number[],
  STEPPED_CROWN_K: [0.5, 0.64] as readonly number[],
  /** Crown tier keeps room for roof props: ≥ 4 m half extents. */
  MIN_ROOF_HALF_M: 4,
  PODIUM_H_M: 8,
  PODIUM_MIN_SIDE_M: 14,
  PODIUM_TOWER_K: [0.6, 0.72] as readonly number[],
  L_MIN_SIDE_M: 18,
  L_CHANCE: 0.45,
  L_CUT_K: [0.38, 0.44] as readonly number[],
  L_MIN_WING_M: 10,
  L_MIN_CUT_M: 7,
  /**
   * Fallback L for districts without any ≥ 18 × 18 m lot (Sector 3's every-block alley split leaves ≤ 14 m short
   * sides): courtyard still ≥ 7 × 7 m, roof wing still ≥ 10 m on both axes, the secondary wing may narrow to 6.5 m.
   */
  L_FALLBACK_MIN_SIDE_M: 13.5,
  L_FALLBACK_LONG_SIDE_M: 20,
  L_FALLBACK_MIN_WING_M: 6.5,
  PENCIL_MAX_SIDE_M: 15,
  GALLERY_MIN_PER_SECTOR: 2,
  GALLERY_DEPTH_M: 1.45,
  GALLERY_SLAB_M: 0.22,
  GALLERY_RAIL_M: 1.08,
  GALLERY_PICKET_M: 0.42,
  GALLERY_END_PIER_M: 0.8,
  GALLERY_COLUMN_M: 4,
  GALLERY_DOOR_SPACING_M: 4,
  GALLERY_LEVELS: 3,
  /** Run of the 2F → 3F and 3F → 4F external flights (4 m rise). */
  GALLERY_RAMP_RUN_M: 6.0,
  /** Run of the street → 2F flight (6 m rise on Type B). */
  GALLERY_STAIR_RUN_M: 9.0,
  /** Stair landing length (along): flights start / end on landings flush with the deck edge. */
  GALLERY_LANDING_M: 1.5,
  /** Shortest corridor face: end piers + street stair + its landing (every gallery is reachable from the street). */
  GALLERY_MIN_FACE_M: 12.2,
  /** Vertical gap needed between stacked stair elements: 1.86 m player + 0.25 m slab + 0.25 m slope under the
   *  0.38 m capsule radius + margin. */
  GALLERY_HEADROOM_M: 2.5,
  SPINE_W_M: 2.8,
  SPINE_D_M: 0.85,
  // 9A-3 relief
  BAND_H_M: 0.24,
  BAND_OUT_RUN_M: 0.16,
  BAND_OUT_FEATURE_M: 0.26,
  BAND_MAX_Y_M: 36,
  // 9A-4 ground floor
  BAY_M: 4,
  PIER_W_M: 0.48,
  PIER_D_M: 0.36,
  /** Piers on wall-run faces keep ≤ 0.28 m relief (no snag, no collider). */
  PIER_D_RUN_M: 0.24,
  KICK_H_M: 0.3,
  DOOR_CLEAR_M: 1.8,
  GROUND_TOP_M: 4,
  // 9A-5 AO
  AO_CONTACT_M: 0.55,
  AO_UNDERSIDE: 0.44,
  AO_BAND_UNDERSIDE: 0.48,
  AO_RECESS: 0.42,
  AO_PIPE_BACK: 0.48,
  AO_SOFFIT_GALLERY: 0.45,
  // 10B-3 megastructures (Type A only)
  MEGA_PODIUM_M: 8,
  TRUSS_MIN_ROOF_M: 44,
  TRUSS_MAX_ROOF_M: 92,
  /** Exoskeleton: 0.45 m beams, 12 m vertical bays, ≤ 0.28 m relief (wall-run safe, no collider). */
  TRUSS_BEAM_M: 0.45,
  TRUSS_BAY_M: 12,
  TRUSS_RELIEF_M: 0.26,
  /** Cantilevered stepped crown: two 4 m tiers stepping 0.6 m / 1.2 m out over the street faces. */
  TRUSS_CROWN_OUT_M: [0.6, 1.2] as readonly number[],
  CYL_SIDES: 12,
  CYL_R_MIN_M: 6.5,
  CYL_R_MAX_M: 9.5,
  /** Cylinder shaft 38–84 m tall above the 8 m podium. */
  CYL_MIN_ROOF_M: 46,
  CYL_MAX_ROOF_M: 92,
  ARCH_VOID_MIN_M: 6,
  ARCH_VOID_MAX_M: 8,
  ARCH_SLAB_MIN_M: 6,
  ARCH_BRIDGE_M: 12,
  ARCH_MIN_ROOF_M: 36,
  SLANT_MIN_ROOF_M: 44,
  SLANT_MIN_SIDE_M: 14,
  /** Sloped crown cap: rise / run of the walkable cap ramp (≈ 35°) and its height cap. */
  SLANT_RISE_K: 0.7,
  SLANT_MAX_H_M: 12,
} as const;

// =============================================================================================
// 9A-1 Floor grid
// =============================================================================================
/** Top of floor `n` for archetype `arch`: FLOOR_BASE_M[arch] + n · FLOOR_H_M. */
export function floorTopY(arch: number, n: number): number {
  return FACADE.FLOOR_BASE_M[arch] + n * FACADE.FLOOR_H_M;
}

/** True when `y` lies exactly on the archetype's floor grid. */
export function isOnFloorGrid(arch: number, y: number): boolean {
  const k = (y - FACADE.FLOOR_BASE_M[arch]) / FACADE.FLOOR_H_M;
  return Math.abs(k - Math.round(k)) < 1e-6 && k >= 0;
}

/** Whole-floor counts n with floorTopY(arch, n) inside [lo, hi] (n ≥ 1). Empty range → [nMax, nMax]. */
export function floorRange(arch: number, lo: number, hi: number): [number, number] {
  const base = FACADE.FLOOR_BASE_M[arch];
  const F = FACADE.FLOOR_H_M;
  const nMin = Math.max(1, Math.ceil((lo - base) / F - 1e-9));
  const nMax = Math.max(1, Math.floor((hi - base) / F + 1e-9));
  return nMin <= nMax ? [nMin, nMax] : [nMax, nMax];
}

/** 9A-1 roof quantization: nearest (or next higher) whole floor inside the archetype ∩ sector band. */
export function quantizeToFloors(arch: number, h: number, lo: number, hi: number, mode: 'round' | 'ceil' | 'floor' = 'round'): number {
  const [nMin, nMax] = floorRange(arch, lo, hi);
  const raw = (h - FACADE.FLOOR_BASE_M[arch]) / FACADE.FLOOR_H_M;
  const n = mode === 'ceil' ? Math.ceil(raw - 1e-9) : mode === 'floor' ? Math.floor(raw + 1e-9) : Math.round(raw);
  return floorTopY(arch, Math.min(nMax, Math.max(nMin, n)));
}

/** Archetype ∩ sector height band (the clamp range of 9A-1). */
export function heightBand(arch: number, sectorMin: number, sectorMax: number): [number, number] {
  return [Math.max(ARCHETYPE.MIN_H[arch], sectorMin), Math.min(ARCHETYPE.MAX_H[arch], sectorMax)];
}

// =============================================================================================
// 9A-2 Massings
// =============================================================================================
export interface MassBox extends Rect {
  y0: number;
  y1: number;
}

/** Roof / terrace surface that carries a perimeter parapet. */
export interface RoofPlate extends Rect {
  y: number;
  /** The main (roof-prop) surface. */
  main: boolean;
  /** 10B-3 round roof (CYLINDER_RING_TOWER): the rect is the inscribed prop square; parapet / cap are 12-gons. */
  round?: { cx: number; cz: number; r: number };
  /** 10B-3 plate edges left open (no parapet), e.g. the foot of the SLANT_CORP_TOWER cap ramp ("z:1"). */
  open?: string[];
}

/** One exposed vertical wall span: plane coordinate, along range and height range. */
export interface FaceSpan {
  ax: Axis;
  sg: 1 | -1;
  plane: number;
  a0: number;
  a1: number;
  y0: number;
  y1: number;
  /** On the lot boundary (street / alley side); false = inner courtyard or set-back upper wall. */
  lot: boolean;
  /** Inner L-courtyard wall. */
  court: boolean;
}

export interface MassingPlan {
  kind: MassingKind;
  boxes: MassBox[];
  plates: RoofPlate[];
  /** Roof record (top tier / larger wing): every roof prop, spawn and anchor uses it. */
  roof: { cx: number; cz: number; halfW: number; halfD: number };
  /** First terrace / podium height (0 = none). */
  setbackY: number;
  faces: FaceSpan[];
  /** L_SHAPE courtyard rect (open to the sky), else null. */
  cut: Rect | null;
  /** PODIUM_OFFSET: the lot faces the tower is flush with ("x:1", "z:-1"). */
  flush: string[];
  /** 10B-3: lot faces that are not full-height walls (TWIN_ARCH_GATE void openings) — no run / feature roles. */
  partial?: string[];
  /** 10B-3 CYLINDER_RING_TOWER shaft (12-gon, flats facing ±x / ±z) standing on the 8 m podium. */
  cyl?: { cx: number; cz: number; r: number; y0: number; y1: number };
  /** 10B-3 TWIN_ARCH_GATE: split axis, void range along it, open void height band, bridge (sky-arch) band. */
  twin?: { axis: Axis; v0: number; v1: number; l0: number; l1: number; y0: number; y1: number; bridgeY0: number; bridgeY1: number };
  /** 10B-3 SLANT_CORP_TOWER sloped crown cap: rises along `axis` toward side `sg` from `a0` (deck edge) to `a1`. */
  slant?: { axis: Axis; sg: 1 | -1; a0: number; a1: number; l0: number; l1: number; y0: number; h: number };
  /** 10B-3 X_TRUSS_TOWER exoskeleton band (lot faces, y0 → y1) and the faces whose crown cantilevers out. */
  truss?: { y0: number; y1: number; cantilever: string[] };
}

export const faceKeyOf = (ax: Axis, sg: number): string => `${ax}:${sg > 0 ? 1 : -1}`;
const FACES4: ReadonlyArray<readonly [Axis, 1 | -1]> = [['x', 1], ['x', -1], ['z', 1], ['z', -1]];

export interface MassingCandidate {
  arch: number;
  lot: Rect;
  roofY: number;
  /** Lot faces that border a wall-run alley ("x:1" …). */
  alley: ReadonlySet<string>;
  /** 10B-3 lot faces on the lockdown boundary (no cantilever / no void opening). */
  edge?: ReadonlySet<string>;
}

const lotW = (r: Rect): number => r.x1 - r.x0;
const lotD = (r: Rect): number => r.z1 - r.z0;
const minSide = (r: Rect): number => Math.min(lotW(r), lotD(r));

/** L_SHAPE courtyard corner: a lot corner whose two faces are both non-alley street faces (null if none). */
export function lCutCorner(c: MassingCandidate, rng: () => number = () => 0): [1 | -1, 1 | -1] | null {
  const opts: Array<[1 | -1, 1 | -1]> = [];
  for (const sx of [1, -1] as const) for (const sz of [1, -1] as const) if (!c.alley.has(faceKeyOf('x', sx)) && !c.alley.has(faceKeyOf('z', sz))) opts.push([sx, sz]);
  if (!opts.length) return null;
  return opts[Math.floor(rng() * opts.length) % opts.length];
}

export function canLShape(c: MassingCandidate, fallback = false): boolean {
  const G = GRAMMAR;
  if (lCutCorner(c) === null || c.roofY < 12) return false;
  if (minSide(c.lot) >= G.L_MIN_SIDE_M) return true;
  return fallback && minSide(c.lot) >= G.L_FALLBACK_MIN_SIDE_M && Math.max(lotW(c.lot), lotD(c.lot)) >= G.L_FALLBACK_LONG_SIDE_M;
}

/** Tall Type A towers; the crown keeps ≥ 8 × 8 m, so lots down to 12 m taper cleanly. */
export function canStepped(c: MassingCandidate): boolean {
  return c.roofY >= GRAMMAR.STEPPED_MIN_ROOF_M && minSide(c.lot) >= 12;
}

export function canPodium(c: MassingCandidate, fallback = false): boolean {
  return minSide(c.lot) >= (fallback ? 12 : GRAMMAR.PODIUM_MIN_SIDE_M) && c.roofY >= GRAMMAR.PODIUM_H_M + 8;
}

export function canGallery(c: MassingCandidate): boolean {
  return c.roofY >= floorTopY(c.arch, GRAMMAR.GALLERY_LEVELS) + FACADE.FLOOR_H_M && Math.max(lotW(c.lot), lotD(c.lot)) >= 12;
}

export function isNarrow(c: MassingCandidate): boolean {
  return minSide(c.lot) <= GRAMMAR.PENCIL_MAX_SIDE_M;
}

const freeFace = (c: MassingCandidate, k: string): boolean => !c.alley.has(k) && !(c.edge?.has(k) ?? false);

/** 10B-3 TWIN_ARCH_GATE split axis: slabs ≥ 6 m either side of a 6–8 m void whose two openings face streets. */
export function twinSplitAxis(c: MassingCandidate): Axis | null {
  const G = GRAMMAR;
  const need = 2 * G.ARCH_SLAB_MIN_M + G.ARCH_VOID_MIN_M;
  const opts: Axis[] = lotW(c.lot) >= lotD(c.lot) ? ['x', 'z'] : ['z', 'x'];
  for (const ax of opts) {
    const len = ax === 'x' ? lotW(c.lot) : lotD(c.lot);
    // Split along x ⇒ the void opens on the z faces (and vice versa).
    const open: Axis = ax === 'x' ? 'z' : 'x';
    if (len >= need && minSide(c.lot) >= 12 && freeFace(c, faceKeyOf(open, 1)) && freeFace(c, faceKeyOf(open, -1))) return ax;
  }
  return null;
}

/** 10B-3 megastructure eligibility (Type A glass towers only: no balconies / escapes / galleries to collide with). */
export function canMega(kind: MegaStructureKind, c: MassingCandidate): boolean {
  const G = GRAMMAR;
  if (c.arch !== ARCH_A) return false;
  switch (kind) {
    case 'X_TRUSS_TOWER':
      return c.roofY >= G.TRUSS_MIN_ROOF_M && c.roofY <= G.TRUSS_MAX_ROOF_M && minSide(c.lot) >= 10;
    case 'CYLINDER_RING_TOWER':
      return c.roofY >= G.CYL_MIN_ROOF_M && c.roofY <= G.CYL_MAX_ROOF_M && minSide(c.lot) >= 2 * G.CYL_R_MIN_M + 2.4;
    case 'TWIN_ARCH_GATE':
      return c.roofY >= G.ARCH_MIN_ROOF_M && twinSplitAxis(c) !== null;
    case 'SLANT_CORP_TOWER':
      return c.roofY >= G.SLANT_MIN_ROOF_M && minSide(c.lot) >= G.SLANT_MIN_SIDE_M;
  }
}

/** 10B-4 sector identity knobs for `assignMassings` (defaults reproduce the 9A assignment exactly). */
export interface MassingOptions {
  /** Minimum counts of base massings (topped up where eligible lots exist). */
  minCounts?: Readonly<Partial<Record<BaseMassingKind, number>>>;
  /** Megastructure quotas (converted from eligible Type A towers). */
  mega?: Readonly<Partial<Record<MegaStructureKind, number>>>;
  /** Sky-bridge towers: never CYLINDER / TWIN_ARCH (their alley walls must stay solid up to Layer 2). */
  noMega?: ReadonlySet<number>;
}

/**
 * 9A-2 deterministic massing assignment. Rules in order: STEPPED_SETBACK (Type A ≥ 44 m, ~65 %), L_SHAPE (Type B / C
 * on ≥ 18 × 18 m lots with a free street corner, ~45 %), GALLERY_DANCHI (Type B on non-L lots), PODIUM_OFFSET (the
 * remaining A and Type D on ≥ 14 × 14 m lots), PENCIL_TOWER (remaining narrow ≤ 15 m lots, C / D). Then each sector
 * is guaranteed every massing where an eligible lot exists (≥ 2 galleries), and any leftover building takes the
 * closest fitting massing (podium on wide lots, pencil otherwise).
 */
export function assignMassings(cands: readonly MassingCandidate[], rng: () => number, opts: MassingOptions = {}): MassingKind[] {
  const G = GRAMMAR;
  const out: Array<MassingKind | null> = cands.map(() => null);
  cands.forEach((c, i) => {
    if (c.arch === ARCH_A && canStepped(c) && rng() < G.STEPPED_CHANCE) out[i] = 'STEPPED_SETBACK';
  });
  cands.forEach((c, i) => {
    if (out[i] === null && (c.arch === ARCH_B || c.arch === ARCH_C) && canLShape(c) && rng() < G.L_CHANCE) out[i] = 'L_SHAPE';
  });
  cands.forEach((c, i) => {
    if (out[i] === null && c.arch === ARCH_B && canGallery(c)) out[i] = 'GALLERY_DANCHI';
  });
  cands.forEach((c, i) => {
    if (out[i] === null && (c.arch === ARCH_A || c.arch === ARCH_D) && canPodium(c) && !isNarrow(c)) out[i] = 'PODIUM_OFFSET';
  });
  cands.forEach((c, i) => {
    if (out[i] === null && (c.arch === ARCH_C || c.arch === ARCH_D) && isNarrow(c)) out[i] = 'PENCIL_TOWER';
  });
  // Leftovers: closest fitting massing.
  cands.forEach((c, i) => {
    if (out[i] !== null) return;
    if (c.arch === ARCH_A && canStepped(c)) out[i] = 'STEPPED_SETBACK';
    else if (canPodium(c) && !isNarrow(c)) out[i] = 'PODIUM_OFFSET';
    else out[i] = 'PENCIL_TOWER';
  });
  const kinds = out as MassingKind[];
  // Guarantees: every massing present wherever an eligible lot exists; ≥ 2 galleries.
  const count = (k: MassingKind): number => kinds.filter((x) => x === k).length;
  const steal = (k: MassingKind, ok: (c: MassingCandidate, i: number) => boolean, score: (c: MassingCandidate) => number): boolean => {
    let best = -1;
    let bestS = -Infinity;
    cands.forEach((c, i) => {
      if (kinds[i] === k || !ok(c, i)) return;
      // Never take the last instance of another massing (the gallery top-up runs last and restores two).
      if (count(kinds[i]) <= 1) return;
      const s = score(c);
      if (s > bestS) {
        bestS = s;
        best = i;
      }
    });
    if (best < 0) return false;
    kinds[best] = k;
    return true;
  };
  if (!count('L_SHAPE')) steal('L_SHAPE', (c) => canLShape(c), (c) => (c.arch === ARCH_B || c.arch === ARCH_C ? 100 : 0) + minSide(c.lot));
  if (!count('L_SHAPE')) steal('L_SHAPE', (c) => canLShape(c, true), (c) => (c.arch === ARCH_B || c.arch === ARCH_C ? 100 : 0) + Math.max(lotW(c.lot), lotD(c.lot)));
  if (!count('STEPPED_SETBACK')) steal('STEPPED_SETBACK', (c) => canStepped(c), (c) => (c.arch === ARCH_A ? 100 : 0) + c.roofY);
  if (!count('PODIUM_OFFSET')) steal('PODIUM_OFFSET', (c) => canPodium(c, true), (c) => (c.arch === ARCH_D || c.arch === ARCH_A ? 100 : 0) + minSide(c.lot));
  if (!count('PENCIL_TOWER')) steal('PENCIL_TOWER', () => true, (c) => (c.arch === ARCH_C || c.arch === ARCH_D ? 100 : 0) - minSide(c.lot));
  for (let guard = 0; guard < 4 && count('GALLERY_DANCHI') < G.GALLERY_MIN_PER_SECTOR; guard++) {
    if (!steal('GALLERY_DANCHI', (c) => (c.arch === ARCH_B || c.arch === ARCH_C) && canGallery(c), (c) => (c.arch === ARCH_B ? 100 : 0) + c.roofY * 0.01)) break;
  }
  if (!opts.minCounts && !opts.mega) return kinds;

  // 10B-4 identity: top up minimum base-massing counts, then convert Type A towers into megastructures. Neither
  // pass takes a tower whose massing would drop below its own floor (≥ 1, ≥ 2 galleries, ≥ the identity minimum).
  const mins = opts.minCounts ?? {};
  const floorOf = (k: MassingKind): number =>
    isMegaKind(k) ? Infinity : Math.max(1, mins[k as BaseMassingKind] ?? 0, k === 'GALLERY_DANCHI' ? G.GALLERY_MIN_PER_SECTOR : 0);
  const take = (k: MassingKind, ok: (c: MassingCandidate, i: number) => boolean, score: (c: MassingCandidate) => number): boolean => {
    let best = -1;
    let bestS = -Infinity;
    cands.forEach((c, i) => {
      if (kinds[i] === k || !ok(c, i) || count(kinds[i]) <= floorOf(kinds[i])) return;
      const s = score(c) + rng() * 1e-3;
      if (s > bestS) {
        bestS = s;
        best = i;
      }
    });
    if (best < 0) return false;
    kinds[best] = k;
    return true;
  };
  // A gallery needs one free (non-alley, non-boundary) face long enough for its corridor + street stair.
  const galleryFace = (c: MassingCandidate): boolean =>
    FACES4.some(([ax, sg]) => freeFace(c, faceKeyOf(ax, sg)) && (ax === 'x' ? lotD(c.lot) : lotW(c.lot)) >= G.GALLERY_MIN_FACE_M);
  kinds.forEach((k, i) => {
    if (k !== 'GALLERY_DANCHI' || galleryFace(cands[i]) || count('GALLERY_DANCHI') <= floorOf('GALLERY_DANCHI')) return;
    const c = cands[i];
    kinds[i] = canPodium(c) && !isNarrow(c) ? 'PODIUM_OFFSET' : 'PENCIL_TOWER';
  });
  const baseRule: Record<BaseMassingKind, [(c: MassingCandidate) => boolean, (c: MassingCandidate) => number]> = {
    L_SHAPE: [(c) => canLShape(c) || canLShape(c, true), (c) => (c.arch === ARCH_B || c.arch === ARCH_C ? 100 : 0) + minSide(c.lot)],
    PODIUM_OFFSET: [(c) => canPodium(c) && !isNarrow(c), (c) => (c.arch === ARCH_A || c.arch === ARCH_D ? 100 : 0) + minSide(c.lot)],
    STEPPED_SETBACK: [(c) => canStepped(c), (c) => (c.arch === ARCH_A ? 100 : 0) + c.roofY],
    GALLERY_DANCHI: [(c) => (c.arch === ARCH_B || c.arch === ARCH_C) && canGallery(c) && galleryFace(c), (c) => (c.arch === ARCH_B ? 100 : 0) + c.roofY * 0.01],
    PENCIL_TOWER: [() => true, (c) => (c.arch === ARCH_C || c.arch === ARCH_D ? 100 : 0) + (isNarrow(c) ? 50 : 0) - minSide(c.lot)],
  };
  for (const k of MASSING_KINDS) {
    const want = mins[k] ?? 0;
    const [ok, score] = baseRule[k];
    for (let guard = 0; guard < 16 && count(k) < want; guard++) if (!take(k, ok, score)) break;
  }
  const megaScore: Record<MegaStructureKind, (c: MassingCandidate) => number> = {
    X_TRUSS_TOWER: (c) => c.roofY,
    CYLINDER_RING_TOWER: (c) => minSide(c.lot) + c.roofY * 0.1,
    TWIN_ARCH_GATE: (c) => Math.max(lotW(c.lot), lotD(c.lot)) + c.roofY * 0.05,
    SLANT_CORP_TOWER: (c) => c.roofY + minSide(c.lot) * 0.2,
  };
  // Rarest-eligibility first so a twin-arch / cylinder lot is not taken by a truss tower.
  const megaOrder: MegaStructureKind[] = ['TWIN_ARCH_GATE', 'CYLINDER_RING_TOWER', 'SLANT_CORP_TOWER', 'X_TRUSS_TOWER'];
  for (const k of megaOrder) {
    const want = opts.mega?.[k] ?? 0;
    const needsSolidWalls = k === 'CYLINDER_RING_TOWER' || k === 'TWIN_ARCH_GATE';
    for (let n = 0; n < want; n++) if (!take(k, (c, i) => !(needsSolidWalls && (opts.noMega?.has(i) ?? false)) && canMega(k, c), megaScore[k])) break;
  }
  return kinds;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Exposed lot face spans of a single box rising from the ground. */
function boxFaces(b: MassBox, lot: Rect, court = false): FaceSpan[] {
  const out: FaceSpan[] = [];
  for (const [ax, sg] of FACES4) {
    const plane = ax === 'x' ? (sg > 0 ? b.x1 : b.x0) : sg > 0 ? b.z1 : b.z0;
    const a0 = ax === 'x' ? b.z0 : b.x0;
    const a1 = ax === 'x' ? b.z1 : b.x1;
    const lotPlane = ax === 'x' ? (sg > 0 ? lot.x1 : lot.x0) : sg > 0 ? lot.z1 : lot.z0;
    out.push({ ax, sg, plane, a0, a1, y0: b.y0, y1: b.y1, lot: Math.abs(plane - lotPlane) < 1e-6, court });
  }
  return out;
}

/**
 * Builds the geometry plan of one massing (boxes, roof plates, exposed face spans). `roofY` and every terrace are
 * already on the floor grid of `c.arch`.
 */
export function planMassing(kind: MassingKind, c: MassingCandidate, rng: () => number): MassingPlan {
  const G = GRAMMAR;
  const L = c.lot;
  const W = lotW(L);
  const D = lotD(L);
  const cx = (L.x0 + L.x1) / 2;
  const cz = (L.z0 + L.z1) / 2;
  const roofY = c.roofY;
  const whole: MassBox = { ...L, y0: 0, y1: roofY };
  const single = (k: MassingKind): MassingPlan => ({
    kind: k,
    boxes: [whole],
    plates: [{ ...L, y: roofY, main: true }],
    roof: { cx, cz, halfW: W / 2, halfD: D / 2 },
    setbackY: 0,
    faces: boxFaces(whole, L),
    cut: null,
    flush: [],
  });
  if (kind === 'GALLERY_DANCHI' || kind === 'PENCIL_TOWER') return single(kind);
  if (isMegaKind(kind)) return planMega(kind, c, rng);

  if (kind === 'STEPPED_SETBACK') {
    const tiers = roofY >= 64 && rng() < 0.6 ? 3 : 2;
    const [nMin, nMax] = floorRange(c.arch, G.STEPPED_MIN_SETBACK_Y, roofY - G.STEPPED_MIN_TIER_M * (tiers - 1));
    // Lower block top in the lower 60 % of the allowed floor range.
    const n1 = nMin + Math.floor(rng() * (Math.round((nMax - nMin) * 0.6) + 1));
    const s1 = floorTopY(c.arch, Math.min(nMax, Math.max(nMin, n1)));
    const kMid = lerp(G.STEPPED_MID_K[0], G.STEPPED_MID_K[1], rng());
    const kCrown = lerp(G.STEPPED_CROWN_K[0], G.STEPPED_CROWN_K[1], rng());
    const half = (k: number): [number, number] => [Math.max(G.MIN_ROOF_HALF_M, (W * k) / 2), Math.max(G.MIN_ROOF_HALF_M, (D * k) / 2)];
    const boxes: MassBox[] = [{ ...L, y0: 0, y1: s1 }];
    const plates: RoofPlate[] = [{ ...L, y: s1, main: false }];
    const faces: FaceSpan[] = boxFaces(boxes[0], L);
    let top = s1;
    const ks = tiers === 3 ? [kMid, kCrown] : [lerp(kMid, kCrown, 0.45)];
    let roof = { cx, cz, halfW: W / 2, halfD: D / 2 };
    ks.forEach((k, ti) => {
      const last = ti === ks.length - 1;
      let y1 = roofY;
      if (!last) {
        const [m0, m1] = floorRange(c.arch, top + G.STEPPED_MIN_TIER_M, roofY - G.STEPPED_MIN_TIER_M);
        y1 = floorTopY(c.arch, Math.round(lerp(m0, m1, 0.35 + rng() * 0.3)));
      }
      const [hw, hd] = half(k);
      const b: MassBox = { x0: cx - hw, x1: cx + hw, z0: cz - hd, z1: cz + hd, y0: top, y1 };
      boxes.push(b);
      plates.push({ x0: b.x0, x1: b.x1, z0: b.z0, z1: b.z1, y: y1, main: last });
      faces.push(...boxFaces(b, L));
      roof = { cx, cz, halfW: hw, halfD: hd };
      top = y1;
    });
    return { kind, boxes, plates, roof, setbackY: s1, faces, cut: null, flush: [] };
  }

  if (kind === 'PODIUM_OFFSET') {
    const P = G.PODIUM_H_M;
    // Flush corner: prefer the corner whose faces are alleys (alley walls keep their full wall-run height).
    let best: [1 | -1, 1 | -1] = [1, 1];
    let bestS = -1;
    for (const sx of [1, -1] as const) {
      for (const sz of [1, -1] as const) {
        const s = (c.alley.has(faceKeyOf('x', sx)) ? 2 : 0) + (c.alley.has(faceKeyOf('z', sz)) ? 2 : 0) + rng() * 0.5;
        if (s > bestS) {
          bestS = s;
          best = [sx, sz];
        }
      }
    }
    const [sx, sz] = best;
    const tw = Math.max(2 * G.MIN_ROOF_HALF_M, W * lerp(G.PODIUM_TOWER_K[0], G.PODIUM_TOWER_K[1], rng()));
    const td = Math.max(2 * G.MIN_ROOF_HALF_M, D * lerp(G.PODIUM_TOWER_K[0], G.PODIUM_TOWER_K[1], rng()));
    const tx0 = sx > 0 ? L.x1 - tw : L.x0;
    const tz0 = sz > 0 ? L.z1 - td : L.z0;
    const podium: MassBox = { ...L, y0: 0, y1: P };
    const tower: MassBox = { x0: tx0, x1: tx0 + tw, z0: tz0, z1: tz0 + td, y0: P, y1: roofY };
    const faces = boxFaces(podium, L);
    // Flush lot faces continue up the tower: extend those spans; the two inner tower walls are set back.
    for (const f of boxFaces(tower, L)) {
      const flushFace = (f.ax === 'x' && f.sg === sx) || (f.ax === 'z' && f.sg === sz);
      faces.push({ ...f, lot: flushFace });
    }
    return {
      kind,
      boxes: [podium, tower],
      plates: [{ ...L, y: P, main: false }, { x0: tower.x0, x1: tower.x1, z0: tower.z0, z1: tower.z1, y: roofY, main: true }],
      roof: { cx: (tower.x0 + tower.x1) / 2, cz: (tower.z0 + tower.z1) / 2, halfW: tw / 2, halfD: td / 2 },
      setbackY: P,
      faces,
      cut: null,
      flush: [faceKeyOf('x', sx), faceKeyOf('z', sz)],
    };
  }

  // L_SHAPE: carve one free street corner (38–44 % × 38–44 %), both wings ≥ 10 m, courtyard ≥ 7 × 7 m.
  const corner = lCutCorner(c, rng) ?? [1, 1];
  const [sx, sz] = corner;
  const wingMin = (side: number): number => (side >= G.L_MIN_CUT_M + G.L_MIN_WING_M ? G.L_MIN_WING_M : G.L_FALLBACK_MIN_WING_M);
  const cw = Math.min(W - wingMin(W), Math.max(G.L_MIN_CUT_M, W * lerp(G.L_CUT_K[0], G.L_CUT_K[1], rng())));
  const cd = Math.min(D - wingMin(D), Math.max(G.L_MIN_CUT_M, D * lerp(G.L_CUT_K[0], G.L_CUT_K[1], rng())));
  const cut: Rect = { x0: sx > 0 ? L.x1 - cw : L.x0, x1: sx > 0 ? L.x1 : L.x0 + cw, z0: sz > 0 ? L.z1 - cd : L.z0, z1: sz > 0 ? L.z1 : L.z0 + cd };
  // Wing A = the full strip away from the cut along the axis that gives the larger wing; wing B the remainder.
  const stripX = (W - cw) * D >= (D - cd) * W;
  const wingA: MassBox = stripX
    ? { x0: sx > 0 ? L.x0 : cut.x1, x1: sx > 0 ? cut.x0 : L.x1, z0: L.z0, z1: L.z1, y0: 0, y1: roofY }
    : { x0: L.x0, x1: L.x1, z0: sz > 0 ? L.z0 : cut.z1, z1: sz > 0 ? cut.z0 : L.z1, y0: 0, y1: roofY };
  const wingB: MassBox = stripX
    ? { x0: cut.x0, x1: cut.x1, z0: sz > 0 ? L.z0 : cut.z1, z1: sz > 0 ? cut.z0 : L.z1, y0: 0, y1: roofY }
    : { x0: sx > 0 ? L.x0 : cut.x1, x1: sx > 0 ? cut.x0 : L.x1, z0: cut.z0, z1: cut.z1, y0: 0, y1: roofY };
  const faces = exposedFaces([wingA, wingB], L, cut);
  return {
    kind,
    boxes: [wingA, wingB],
    plates: [{ x0: wingA.x0, x1: wingA.x1, z0: wingA.z0, z1: wingA.z1, y: roofY, main: true }, { x0: wingB.x0, x1: wingB.x1, z0: wingB.z0, z1: wingB.z1, y: roofY, main: false }],
    roof: { cx: (wingA.x0 + wingA.x1) / 2, cz: (wingA.z0 + wingA.z1) / 2, halfW: (wingA.x1 - wingA.x0) / 2, halfD: (wingA.z1 - wingA.z0) / 2 },
    setbackY: 0,
    faces,
    cut,
    flush: [],
  };
}

/**
 * 10B-3 megastructure plans. Every solid part is still an axis-aligned MassBox (bodies + BUILDING colliders + face
 * spans keep working); the cylinder shaft, exoskeleton, sky-arch and sloped cap are described by extra records the
 * CityBuilder turns into geometry merged into its existing buckets (+0 draw calls).
 */
function planMega(kind: MegaStructureKind, c: MassingCandidate, rng: () => number): MassingPlan {
  const G = GRAMMAR;
  const L = c.lot;
  const W = lotW(L);
  const D = lotD(L);
  const cx = (L.x0 + L.x1) / 2;
  const cz = (L.z0 + L.z1) / 2;
  const roofY = c.roofY;
  const P = G.MEGA_PODIUM_M;

  if (kind === 'X_TRUSS_TOWER') {
    // Shaft to roofY − 8, then two 4 m crown tiers stepping out (0.6 / 1.2 m) over the free street faces.
    const yC = roofY - 8;
    const cant = FACES4.filter(([ax, sg]) => freeFace(c, faceKeyOf(ax, sg))).map(([ax, sg]) => faceKeyOf(ax, sg));
    const grow = (e: number): Rect => ({
      x0: L.x0 - (cant.includes('x:-1') ? e : 0),
      x1: L.x1 + (cant.includes('x:1') ? e : 0),
      z0: L.z0 - (cant.includes('z:-1') ? e : 0),
      z1: L.z1 + (cant.includes('z:1') ? e : 0),
    });
    const shaft: MassBox = { ...L, y0: 0, y1: yC };
    const t1: MassBox = { ...grow(G.TRUSS_CROWN_OUT_M[0]), y0: yC, y1: roofY - 4 };
    const t2: MassBox = { ...grow(G.TRUSS_CROWN_OUT_M[1]), y0: roofY - 4, y1: roofY };
    const faces = [...boxFaces(shaft, L), ...boxFaces(t1, L), ...boxFaces(t2, L)];
    return {
      kind,
      boxes: [shaft, t1, t2],
      plates: [{ x0: t2.x0, x1: t2.x1, z0: t2.z0, z1: t2.z1, y: roofY, main: true }],
      roof: { cx: (t2.x0 + t2.x1) / 2, cz: (t2.z0 + t2.z1) / 2, halfW: (t2.x1 - t2.x0) / 2, halfD: (t2.z1 - t2.z0) / 2 },
      setbackY: 0,
      faces,
      cut: null,
      flush: [],
      truss: { y0: P, y1: yC, cantilever: cant },
    };
  }

  if (kind === 'CYLINDER_RING_TOWER') {
    const r = Math.min(G.CYL_R_MAX_M, Math.max(G.CYL_R_MIN_M, minSide(L) / 2 - 1.2));
    const podium: MassBox = { ...L, y0: 0, y1: P };
    // Inscribed prop square of the 12-gon (apothem 0.966 r): 0.68 r keeps parapet + crown clear.
    const q = r * 0.68;
    return {
      kind,
      boxes: [podium],
      plates: [
        { ...L, y: P, main: false },
        { x0: cx - q, x1: cx + q, z0: cz - q, z1: cz + q, y: roofY, main: true, round: { cx, cz, r } },
      ],
      roof: { cx, cz, halfW: q, halfD: q },
      setbackY: P,
      faces: boxFaces(podium, L),
      cut: null,
      flush: [],
      cyl: { cx, cz, r, y0: P, y1: roofY },
    };
  }

  if (kind === 'TWIN_ARCH_GATE') {
    const axis = twinSplitAxis(c) ?? (W >= D ? 'x' : 'z');
    const len = axis === 'x' ? W : D;
    const v = Math.min(G.ARCH_VOID_MAX_M, Math.max(G.ARCH_VOID_MIN_M, Math.round(len * 0.28 * 2) / 2), len - 2 * G.ARCH_SLAB_MIN_M);
    const mid = axis === 'x' ? cx : cz;
    const v0 = mid - v / 2;
    const v1 = mid + v / 2;
    const yB = roofY - G.ARCH_BRIDGE_M;
    const podium: MassBox = { ...L, y0: 0, y1: P };
    const slabA: MassBox = axis === 'x' ? { ...L, x1: v0, y0: P, y1: roofY } : { ...L, z1: v0, y0: P, y1: roofY };
    const slabB: MassBox = axis === 'x' ? { ...L, x0: v1, y0: P, y1: roofY } : { ...L, z0: v1, y0: P, y1: roofY };
    const bridge: MassBox = axis === 'x' ? { ...L, x0: v0, x1: v1, y0: yB, y1: roofY } : { ...L, z0: v0, z1: v1, y0: yB, y1: roofY };
    const boxes = [podium, slabA, slabB, bridge];
    const open: Axis = axis === 'x' ? 'z' : 'x';
    const plate = (b: MassBox, main: boolean): RoofPlate => ({ x0: b.x0, x1: b.x1, z0: b.z0, z1: b.z1, y: b.y1, main });
    const [l0, l1] = axis === 'x' ? [L.z0, L.z1] : [L.x0, L.x1];
    void rng;
    return {
      kind,
      boxes,
      plates: [plate(podium, false), plate(slabA, true), plate(slabB, true), plate(bridge, true)],
      roof: { cx: (slabA.x0 + slabA.x1) / 2, cz: (slabA.z0 + slabA.z1) / 2, halfW: (slabA.x1 - slabA.x0) / 2, halfD: (slabA.z1 - slabA.z0) / 2 },
      setbackY: P,
      faces: exposedBoxFaces(boxes, L),
      cut: null,
      flush: [],
      partial: [faceKeyOf(open, 1), faceKeyOf(open, -1)],
      twin: { axis, v0, v1, l0, l1, y0: P, y1: yB, bridgeY0: yB, bridgeY1: roofY },
    };
  }

  // SLANT_CORP_TOWER: one monolith box; the sloped cap covers the back half of the roof along the long axis, rising
  // from the flat sniper deck (front half, main plate, open edge at the ramp foot) to the back edge.
  const axis: Axis = W >= D ? 'x' : 'z';
  const sg: 1 | -1 = rng() < 0.5 ? 1 : -1;
  const [a0L, a1L] = axis === 'x' ? [L.x0, L.x1] : [L.z0, L.z1];
  const [l0, l1] = axis === 'x' ? [L.z0, L.z1] : [L.x0, L.x1];
  const midA = (a0L + a1L) / 2;
  const back = sg > 0 ? a1L : a0L;
  const run = Math.abs(back - midA);
  const h = Math.min(G.SLANT_MAX_H_M, Math.round(run * G.SLANT_RISE_K * 2) / 2);
  const whole: MassBox = { ...L, y0: 0, y1: roofY };
  const deck: Rect = axis === 'x' ? (sg > 0 ? { ...L, x1: midA } : { ...L, x0: midA }) : sg > 0 ? { ...L, z1: midA } : { ...L, z0: midA };
  return {
    kind,
    boxes: [whole],
    plates: [{ ...deck, y: roofY, main: true, open: [faceKeyOf(axis, sg)] }],
    roof: { cx: (deck.x0 + deck.x1) / 2, cz: (deck.z0 + deck.z1) / 2, halfW: (deck.x1 - deck.x0) / 2, halfD: (deck.z1 - deck.z0) / 2 },
    setbackY: 0,
    faces: boxFaces(whole, L),
    cut: null,
    flush: [],
    slant: { axis, sg, a0: midA, a1: back, l0, l1, y0: roofY, h },
  };
}

/** Exposed vertical face spans of arbitrary stacked / abutting boxes: each face minus every box abutting its plane. */
export function exposedBoxFaces(boxes: readonly MassBox[], lot: Rect): FaceSpan[] {
  const out: FaceSpan[] = [];
  boxes.forEach((b, i) => {
    for (const f of boxFaces(b, lot)) {
      let rects: Array<[number, number, number, number]> = [[f.a0, f.a1, f.y0, f.y1]];
      boxes.forEach((o, j) => {
        if (i === j) return;
        const touches = f.ax === 'x' ? Math.abs((f.sg > 0 ? o.x0 : o.x1) - f.plane) < 1e-6 : Math.abs((f.sg > 0 ? o.z0 : o.z1) - f.plane) < 1e-6;
        if (!touches) return;
        const c0 = f.ax === 'x' ? o.z0 : o.x0;
        const c1 = f.ax === 'x' ? o.z1 : o.x1;
        const next: Array<[number, number, number, number]> = [];
        for (const [a0, a1, y0, y1] of rects) {
          if (c1 <= a0 || c0 >= a1 || o.y1 <= y0 || o.y0 >= y1) {
            next.push([a0, a1, y0, y1]);
            continue;
          }
          if (c0 > a0) next.push([a0, c0, y0, y1]);
          if (c1 < a1) next.push([c1, a1, y0, y1]);
          const m0 = Math.max(a0, c0);
          const m1 = Math.min(a1, c1);
          if (o.y0 > y0) next.push([m0, m1, y0, o.y0]);
          if (o.y1 < y1) next.push([m0, m1, o.y1, y1]);
        }
        rects = next;
      });
      for (const [a0, a1, y0, y1] of rects) if (a1 - a0 > 0.05 && y1 - y0 > 0.05) out.push({ ...f, a0, a1, y0, y1 });
    }
  });
  return out;
}

/** Exposed face spans of ground-standing boxes of equal height (shared walls removed); courtyard walls flagged. */
function exposedFaces(boxes: readonly MassBox[], lot: Rect, cut: Rect): FaceSpan[] {
  const out: FaceSpan[] = [];
  boxes.forEach((b, i) => {
    for (const f of boxFaces(b, lot)) {
      // Subtract the along-range covered by another box touching this plane from outside.
      let spans: Array<[number, number]> = [[f.a0, f.a1]];
      boxes.forEach((o, j) => {
        if (i === j) return;
        const touches = f.ax === 'x' ? Math.abs((f.sg > 0 ? o.x0 : o.x1) - f.plane) < 1e-6 : Math.abs((f.sg > 0 ? o.z0 : o.z1) - f.plane) < 1e-6;
        if (!touches) return;
        const c0 = f.ax === 'x' ? o.z0 : o.x0;
        const c1 = f.ax === 'x' ? o.z1 : o.x1;
        spans = subtract(spans, c0, c1);
      });
      for (const [a0, a1] of spans) {
        if (a1 - a0 < 0.05) continue;
        const mid = (a0 + a1) / 2;
        const px = f.ax === 'x' ? f.plane + f.sg * 0.01 : mid;
        const pz = f.ax === 'x' ? mid : f.plane + f.sg * 0.01;
        const court = px > cut.x0 - 1e-6 && px < cut.x1 + 1e-6 && pz > cut.z0 - 1e-6 && pz < cut.z1 + 1e-6;
        out.push({ ...f, a0, a1, court, lot: f.lot && !court });
      }
    }
  });
  return out;
}

function subtract(spans: Array<[number, number]>, c0: number, c1: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [a, b] of spans) {
    if (c1 <= a || c0 >= b) {
      out.push([a, b]);
      continue;
    }
    if (c0 > a) out.push([a, c0]);
    if (c1 < b) out.push([c1, b]);
  }
  return out;
}

/** True when the rect lies entirely on solid roof (inside one of the plan's plates at the main roof height). */
export function onSolidRoof(plan: MassingPlan, r: Rect): boolean {
  const y = Math.max(...plan.plates.map((p) => p.y));
  return plan.plates.some((p) => Math.abs(p.y - y) < 1e-6 && r.x0 >= p.x0 - 1e-6 && r.x1 <= p.x1 + 1e-6 && r.z0 >= p.z0 - 1e-6 && r.z1 <= p.z1 + 1e-6);
}

// ---------------------------------------------------------------------------------------------
// Parapets
// ---------------------------------------------------------------------------------------------
export interface ParapetSeg {
  ax: Axis;
  sg: 1 | -1;
  /** Outer plane (the plate edge). */
  plane: number;
  a0: number;
  a1: number;
  y: number;
}

/**
 * 9A-1 parapet edges of every plate: the plate perimeter minus the stretches where another box of the massing
 * stands on / abuts that edge line (podium under the tower, shared wing wall), minus `gaps` (2.4 m fire-escape
 * landings: plane-aligned along ranges).
 */
export function parapetSegments(plan: MassingPlan, gaps: ReadonlyArray<{ ax: Axis; sg: number; plane: number; a0: number; a1: number }> = []): ParapetSeg[] {
  const out: ParapetSeg[] = [];
  plan.plates.forEach((p) => {
    // 10B-3: the round cylinder roof carries a 12-gon parapet built by the CityBuilder.
    if (p.round) return;
    const own = plan.boxes.find((b) => Math.abs(b.y1 - p.y) < 1e-6 && b.x0 <= p.x0 + 1e-6 && b.x1 >= p.x1 - 1e-6 && b.z0 <= p.z0 + 1e-6 && b.z1 >= p.z1 - 1e-6);
    for (const [ax, sg] of FACES4) {
      const plane = ax === 'x' ? (sg > 0 ? p.x1 : p.x0) : sg > 0 ? p.z1 : p.z0;
      let spans: Array<[number, number]> = [[ax === 'x' ? p.z0 : p.x0, ax === 'x' ? p.z1 : p.x1]];
      for (const b of plan.boxes) {
        if (b === own || b.y1 < p.y - 0.05 || b.y0 > p.y + 0.05) continue;
        const lo = ax === 'x' ? b.x0 : b.z0;
        const hi = ax === 'x' ? b.x1 : b.z1;
        if (plane < lo - 1e-6 || plane > hi + 1e-6) continue;
        spans = subtract(spans, ax === 'x' ? b.z0 : b.x0, ax === 'x' ? b.z1 : b.x1);
      }
      for (const g of gaps) {
        if (g.ax !== ax || g.sg !== sg || Math.abs(g.plane - plane) > 0.05) continue;
        spans = subtract(spans, g.a0, g.a1);
      }
      if (p.open?.includes(faceKeyOf(ax, sg))) spans = [];
      for (const [a0, a1] of spans) if (a1 - a0 > 0.2) out.push({ ax, sg, plane, a0, a1, y: p.y });
    }
  });
  return out;
}

// =============================================================================================
// 9A-4 Ground-floor programs, doors, clear zones, sockets
// =============================================================================================
/** Door sockets (FLOOR_L / FLOOR_R / WALL_SIDE / WALL_HIGH) and the per-bay storefront floor socket (BAY). */
export type SocketSlot = 'FLOOR_L' | 'FLOOR_R' | 'WALL_SIDE' | 'WALL_HIGH' | 'BAY';
export type SocketGroup = 'EATERY' | 'TECH' | 'HOTEL' | 'APARTMENT' | 'INFRA' | 'GALLERY';

export interface PropSocket {
  x: number;
  y: number;
  z: number;
  /** Outward wall normal. */
  nx: number;
  nz: number;
  slot: SocketSlot;
  group: SocketGroup;
  building: number;
  /** Sector-unique doorway id (sockets of one door share it); BAY sockets carry −1. */
  door: number;
  /** Deterministic per-socket variation seed 0..1. */
  seed: number;
  /**
   * 9B free space. Floor slots: the socket sits at the centre of the free along range on the back line (wall /
   * plinth face); a prop must fit `w` along the wall and `depth` outward. Wall slots: the mounting point (fixture
   * back on the wall plane, centred at `y`); `w` = free width, `depth` = max fixture depth.
   */
  w: number;
  depth: number;
  /** Wall-run face: only low (≤ 0.75 m) floor props, so nothing stands in the run strip. */
  low: boolean;
}

/**
 * 9B per-door free space (face coordinates). Omitted fields fall back to the 9A defaults: floor props within 0.7 m
 * beyond the clear zone / door frame, WALL_SIDE beside the frame, WALL_HIGH centred above the lintel.
 */
export interface SocketFit {
  floorL?: readonly [number, number] | null;
  floorR?: readonly [number, number] | null;
  /** Back line of floor props (d) and the depth they may take beyond it. */
  floorD0?: number;
  floorDepth?: number;
  low?: boolean;
  /** WALL_SIDE mounting point (along, mounting plane d, free width); null drops the slot. */
  side?: { a: number; d: number; w: number } | null;
  /** WALL_HIGH mounting point (along, height above the floor, free width); null drops the slot. */
  high?: { a: number; y: number; w: number } | null;
}

export const PROGRAM_SOCKETS: Readonly<Record<GroundProgram, { group: SocketGroup; slots: readonly SocketSlot[] }>> = {
  CYBER_EATERY: { group: 'EATERY', slots: ['FLOOR_L', 'FLOOR_R', 'WALL_SIDE'] },
  TECH_APPAREL: { group: 'TECH', slots: ['FLOOR_L', 'FLOOR_R', 'WALL_SIDE'] },
  CAPSULE_HOTEL: { group: 'HOTEL', slots: ['FLOOR_L', 'FLOOR_R', 'WALL_SIDE'] },
  CYBER_APARTMENT: { group: 'APARTMENT', slots: ['FLOOR_L', 'FLOOR_R', 'WALL_SIDE', 'WALL_HIGH'] },
  ALLEY_INFRA: { group: 'INFRA', slots: ['FLOOR_L', 'FLOOR_R', 'WALL_SIDE', 'WALL_HIGH'] },
};

/** Door spec per program: width × height, recess depth, double leaf. */
export const PROGRAM_DOOR: Readonly<Record<GroundProgram, { w: number; h: number; recess: number; double: boolean }>> = {
  CYBER_EATERY: { w: 1.15, h: 2.15, recess: 0.38, double: false },
  TECH_APPAREL: { w: 1.45, h: 2.18, recess: 0.42, double: true },
  CAPSULE_HOTEL: { w: 1.8, h: 2.25, recess: 0.8, double: true },
  CYBER_APARTMENT: { w: 1.12, h: 2.15, recess: 0.68, double: false },
  ALLEY_INFRA: { w: 1.0, h: 2.1, recess: 0.32, double: false },
};

export interface ProgramFace {
  /** Index into the caller's face list. */
  id: number;
  arch: number;
  alley: boolean;
  /** Building-wide massing (galleries take apartment lobbies). */
  massing: MassingKind;
  len: number;
}

/**
 * 9A-4 deterministic program assignment. Alley faces are always ALLEY_INFRA; street faces follow archetype
 * preferences (A hotel / tech · B apartment / eatery / hotel · C infra · D eatery / tech) with weights near the plan's
 * 22 / 22 / 16 / 22 / 18 % mix, and every sector is guaranteed all five programs on its street faces.
 */
export function assignPrograms(faces: readonly ProgramFace[], rng: () => number): GroundProgram[] {
  const W: Readonly<Record<number, readonly number[]>> = {
    // weights: EATERY, TECH, HOTEL, APARTMENT, INFRA
    [ARCH_A]: [0.1, 0.42, 0.38, 0.0, 0.1],
    [ARCH_B]: [0.3, 0.06, 0.22, 0.42, 0.0],
    [ARCH_C]: [0.18, 0.04, 0.0, 0.08, 0.7],
    [ARCH_D]: [0.42, 0.4, 0.1, 0.0, 0.08],
  };
  const out = faces.map((f): GroundProgram => {
    if (f.alley) return 'ALLEY_INFRA';
    if (f.massing === 'GALLERY_DANCHI') return 'CYBER_APARTMENT';
    const w = W[f.arch] ?? W[ARCH_D];
    let r = rng() * w.reduce((s, v) => s + v, 0);
    for (let k = 0; k < 5; k++) {
      r -= w[k];
      if (r <= 0) return GROUND_PROGRAMS[k];
    }
    return GROUND_PROGRAMS[0];
  });
  // Guarantee all five on street faces (convert the longest suitable face of the most common program).
  for (const p of GROUND_PROGRAMS) {
    if (faces.some((f, i) => !f.alley && out[i] === p)) continue;
    const counts = new Map<GroundProgram, number>();
    faces.forEach((f, i) => {
      if (!f.alley) counts.set(out[i], (counts.get(out[i]) ?? 0) + 1);
    });
    let best = -1;
    faces.forEach((f, i) => {
      if (f.alley || f.massing === 'GALLERY_DANCHI' || (counts.get(out[i]) ?? 0) <= 1) return;
      if (best < 0 || f.len > faces[best].len) best = i;
    });
    if (best >= 0) out[best] = p;
  }
  return out;
}

export type BayUse = 'DOOR' | 'PANEL' | 'VITRINE' | 'SHUTTER' | 'GRILLE' | 'PORTICO' | 'MAILBOX' | 'BLOCKED';

export interface DoorSpec {
  /** Along-face centre. */
  a: number;
  w: number;
  h: number;
  recess: number;
  double: boolean;
  program: GroundProgram;
}

export interface GroundFacePlan {
  program: GroundProgram;
  /** Pier centres along the face (bay boundaries). */
  piers: number[];
  bays: Array<{ a0: number; a1: number; use: BayUse }>;
  doors: DoorSpec[];
}

/**
 * 9A-4 shared 4 m bay grammar: piers (0.48 m) every ~4 m along [a0, a1], one entrance per face for most programs
 * (hotel portico centred over two bays when the face allows it), program-specific fills elsewhere. `blocked` along
 * ranges (fire-escape flights, loading docks) never receive doors.
 */
export function planGroundFace(program: GroundProgram, a0: number, a1: number, rng: () => number, blocked: ReadonlyArray<readonly [number, number]> = []): GroundFacePlan {
  const G = GRAMMAR;
  const len = a1 - a0;
  const nb = Math.max(1, Math.round((len - G.PIER_W_M) / G.BAY_M));
  const bw = (len - G.PIER_W_M) / nb;
  const piers: number[] = [];
  for (let k = 0; k <= nb; k++) piers.push(a0 + G.PIER_W_M / 2 + k * bw);
  const bays: GroundFacePlan['bays'] = [];
  for (let k = 0; k < nb; k++) {
    const b0 = piers[k] + G.PIER_W_M / 2;
    const b1 = piers[k + 1] - G.PIER_W_M / 2;
    const isBlocked = blocked.some(([c0, c1]) => b1 > c0 - 0.3 && b0 < c1 + 0.3);
    bays.push({ a0: b0, a1: b1, use: isBlocked ? 'BLOCKED' : 'PANEL' });
  }
  const spec = PROGRAM_DOOR[program];
  const free = bays.map((b, i) => ({ b, i })).filter(({ b }) => b.use !== 'BLOCKED' && b.a1 - b.a0 >= spec.w + 0.5);
  const doors: DoorSpec[] = [];
  const fill: Readonly<Record<GroundProgram, BayUse>> = {
    CYBER_EATERY: 'PANEL',
    TECH_APPAREL: 'VITRINE',
    CAPSULE_HOTEL: 'PANEL',
    CYBER_APARTMENT: 'GRILLE',
    ALLEY_INFRA: 'SHUTTER',
  };
  for (const b of bays) if (b.use !== 'BLOCKED') b.use = fill[program];
  if (free.length) {
    // Entrance bay: near the centre with a small seeded offset; infra / long eateries get a second door.
    const mid = (free.length - 1) / 2;
    const pick = free[Math.min(free.length - 1, Math.max(0, Math.round(mid + (rng() - 0.5) * Math.min(2, free.length - 1))))];
    const bay = pick.b;
    bay.use = program === 'CAPSULE_HOTEL' ? 'PORTICO' : 'DOOR';
    doors.push({ a: (bay.a0 + bay.a1) / 2, w: spec.w, h: spec.h, recess: spec.recess, double: spec.double, program });
    if (program === 'CYBER_APARTMENT') {
      const next = bays[pick.i + 1] ?? bays[pick.i - 1];
      if (next && next.use !== 'BLOCKED') next.use = 'MAILBOX';
    }
    if ((program === 'ALLEY_INFRA' || program === 'CYBER_EATERY') && free.length >= 4) {
      const far = free[pick.i < free.length / 2 ? free.length - 1 : 0];
      if (far.b !== bay && far.b.use !== 'MAILBOX') {
        far.b.use = 'DOOR';
        doors.push({ a: (far.b.a0 + far.b.a1) / 2, w: spec.w, h: spec.h, recess: spec.recess, double: spec.double, program });
      }
    }
  }
  return { program, piers, bays, doors };
}

/** Face frame: along `a`, height `y`, `d` metres out from the wall plane (negative = into the wall). */
export interface FaceRef {
  ax: Axis;
  sg: number;
  plane: number;
}

export function faceToWorld(f: FaceRef, a: number, d: number): [number, number] {
  return f.ax === 'x' ? [f.plane + f.sg * d, a] : [a, f.plane + f.sg * d];
}

/** 1.8 m wide × 1.8 m deep clear entry zone in front of a door (world XZ rect). */
export function doorClearZone(f: FaceRef, a: number): Rect {
  const h = GRAMMAR.DOOR_CLEAR_M / 2;
  const [xA, zA] = faceToWorld(f, a - h, 0);
  const [xB, zB] = faceToWorld(f, a + h, GRAMMAR.DOOR_CLEAR_M);
  return { x0: Math.min(xA, xB), x1: Math.max(xA, xB), z0: Math.min(zA, zB), z1: Math.max(zA, zB) };
}

/** Door clearance half-width along the wall: the 1.8 m clear zone or the frame (+ portal pillars) if wider. */
export function doorClearHalf(w: number): number {
  return Math.max(GRAMMAR.DOOR_CLEAR_M / 2, w / 2 + 0.45);
}

/**
 * Deterministic sockets around a doorway: FLOOR_L / FLOOR_R on the floor beside the clear zone, WALL_SIDE at
 * hand height beside the frame, WALL_HIGH above the lintel. `floorY` = the walkable surface (0 at street level).
 * `fit` (9B) narrows each socket to the free space the caller knows about (bay piers, portal pillars, windows).
 */
export function doorSockets(f: FaceRef, door: { a: number; w: number; h: number }, floorY: number, group: SocketGroup, slots: readonly SocketSlot[], building: number, doorId: number, rng: () => number, fit: SocketFit = {}): PropSocket[] {
  const out: PropSocket[] = [];
  const nx = f.ax === 'x' ? f.sg : 0;
  const nz = f.ax === 'z' ? f.sg : 0;
  const clear = doorClearHalf(door.w);
  const floorL = fit.floorL === undefined ? ([door.a - clear - 0.7, door.a - clear] as const) : fit.floorL;
  const floorR = fit.floorR === undefined ? ([door.a + clear, door.a + clear + 0.7] as const) : fit.floorR;
  const d0 = fit.floorD0 ?? 0.04;
  const depth = fit.floorDepth ?? 0.6;
  const low = fit.low ?? false;
  const side = fit.side === undefined ? { a: door.a + door.w / 2 + 0.62, d: 0.02, w: 0.44 } : fit.side;
  const high = fit.high === undefined ? { a: door.a, y: door.h + 0.42, w: 0.4 } : fit.high;
  for (const slot of slots) {
    // One draw per requested slot (even when the slot is dropped) keeps the caller's RNG stream stable.
    const seed = rng();
    let a: number;
    let d: number;
    let y = floorY;
    let w: number;
    let dep = depth;
    if (slot === 'FLOOR_L' || slot === 'FLOOR_R') {
      const r = slot === 'FLOOR_L' ? floorL : floorR;
      if (!r || r[1] - r[0] < 0.25) continue;
      a = (r[0] + r[1]) / 2;
      w = r[1] - r[0];
      d = d0;
    } else if (slot === 'WALL_SIDE') {
      if (!side) continue;
      a = side.a;
      d = side.d;
      w = side.w;
      y = floorY + 1.45;
      dep = 0.2;
    } else if (slot === 'WALL_HIGH') {
      if (!high) continue;
      a = high.a;
      d = 0.02;
      w = high.w;
      y = floorY + high.y;
      dep = 0.08;
    } else continue;
    const [x, z] = faceToWorld(f, a, d);
    out.push({ x, y, z, nx, nz, slot, group, building, door: doorId, seed, w, depth: dep, low: slot.startsWith('FLOOR') && low });
  }
  return out;
}

/**
 * 9B ground-floor door free space: floor props inside the door bay beyond the frame (+ hotel portal pillars),
 * WALL_SIDE beside the frame (on the pillar front for hotels), WALL_HIGH above the lintel (beside the door lamp on
 * infra doors). `reach` = free depth in front of the wall; `low` = wall-run face; `run` = run-face pier depth.
 */
export function groundDoorFit(program: GroundProgram, door: { a: number; w: number; h: number }, bay: { a0: number; a1: number } | undefined, reach: number, low: boolean, run: boolean): SocketFit {
  const { a, w, h } = door;
  const clear = doorClearHalf(w) + (program === 'CAPSULE_HOTEL' ? 0.08 : 0);
  const sideLo = Math.max(a + GRAMMAR.DOOR_CLEAR_M / 2 + 0.02, a + w / 2 + (program === 'CYBER_APARTMENT' ? 0.45 : 0.42));
  const sideHi = (bay ? bay.a1 : a + w / 2 + 1) - 0.05;
  return {
    floorL: bay ? [bay.a0 + 0.06, a - clear] : null,
    floorR: bay ? [a + clear, bay.a1 - 0.06] : null,
    floorD0: 0.04,
    floorDepth: reach,
    low,
    side:
      program === 'CAPSULE_HOTEL'
        ? { a: a + w / 2 + 0.36, d: (run ? GRAMMAR.PIER_D_RUN_M : 0.8) + 0.02, w: 0.2 }
        : sideHi - sideLo >= 0.16
          ? { a: (sideLo + sideHi) / 2, d: 0.02, w: sideHi - sideLo }
          : null,
    high: program === 'ALLEY_INFRA' ? { a: a - w / 2 - 0.5, y: h + 0.3, w: 0.32 } : { a, y: h + 0.42, w: 0.4 },
  };
}

/**
 * 9B gallery door free space: floor props between the clear zone and the half-way line to the neighbouring doors
 * (in front of the barred window bars), WALL_SIDE on the hinge side away from the window, plaque above the lintel.
 */
export function galleryDoorFit(a: number, deckA0: number, deckA1: number): SocketFit {
  const G = GRAMMAR;
  return {
    floorL: [Math.max(deckA0 + 0.12, a - G.GALLERY_DOOR_SPACING_M / 2 + 0.02), a - G.DOOR_CLEAR_M / 2],
    floorR: [a + G.DOOR_CLEAR_M / 2, Math.min(deckA1 - 0.12, a + G.GALLERY_DOOR_SPACING_M / 2 - 0.02)],
    floorD0: 0.1,
    floorDepth: 0.56,
    low: false,
    // Hinge side, fully outside the 1.8 m clear zone and clear of the previous door's window.
    side: { a: a - G.DOOR_CLEAR_M / 2 - 0.24, d: 0.02, w: 0.44 },
    high: { a, y: 2.15 + 0.42, w: 0.4 },
  };
}

/** 9B storefront bay floor socket: centre of [a0, a1] on the back line d0, `depth` free outward. */
export function baySocket(f: FaceRef, a0: number, a1: number, d0: number, depth: number, floorY: number, group: SocketGroup, building: number, low: boolean, rng: () => number): PropSocket | null {
  if (a1 - a0 < 0.5 || depth < 0.3) return null;
  const [x, z] = faceToWorld(f, (a0 + a1) / 2, d0);
  return { x, y: floorY, z, nx: f.ax === 'x' ? f.sg : 0, nz: f.ax === 'z' ? f.sg : 0, slot: 'BAY', group, building, door: -1, seed: rng(), w: a1 - a0, depth, low };
}

// =============================================================================================
// GALLERY_DANCHI exterior corridors
// =============================================================================================
export interface GalleryLevel {
  y: number;
  /** Deck along range (minus end piers). */
  a0: number;
  a1: number;
  doors: number[];
  /** Balustrade gaps (where a stair landing meets the deck edge) along ranges. */
  railGaps: Array<[number, number]>;
}

/** One straight stair flight in the outer band (outside the balustrade), low end → high end along the face. */
export interface GalleryRamp {
  aLow: number;
  aHigh: number;
  yLow: number;
  yHigh: number;
  /** Lateral band (out from the wall). */
  d0: number;
  d1: number;
}

/** Stair landing flush with a deck level, bridging the deck edge to a flight. */
export interface GalleryLanding {
  a0: number;
  a1: number;
  y: number;
  d0: number;
  d1: number;
  /** End guard rail at a0 (−1) or a1 (+1): the side away from the flight. */
  endRail: -1 | 1;
  /** Corner post to the street (street-stair landing only; upper landings hang on brackets). */
  post: boolean;
}

export interface GalleryPlan {
  levels: GalleryLevel[];
  /** Zig-zag stair flights: street → 2F, 2F → 3F, 3F → 4F (as many as the face length allows). */
  ramps: GalleryRamp[];
  landings: GalleryLanding[];
  /** Ceiling slab over the top corridor. */
  capY: number;
}

/** Walkable height of a flight / landing at along `a` (null outside it). */
function galleryElementY(e: GalleryRamp | GalleryLanding, a: number): number | null {
  if ('aLow' in e) {
    const lo = Math.min(e.aLow, e.aHigh);
    const hi = Math.max(e.aLow, e.aHigh);
    if (a < lo - 1e-9 || a > hi + 1e-9) return null;
    return e.yLow + ((e.yHigh - e.yLow) * (a - e.aLow)) / (e.aHigh - e.aLow);
  }
  return a >= e.a0 - 1e-9 && a <= e.a1 + 1e-9 ? e.y : null;
}

/**
 * Smallest vertical gap between two stacked (non-touching) stair elements in the outer band, sampled every 0.1 m —
 * the player (1.86 m) must fit under every flight / landing above another one (Infinity when nothing stacks).
 */
export function galleryClearance(plan: Pick<GalleryPlan, 'ramps' | 'landings'>): number {
  const els: Array<GalleryRamp | GalleryLanding> = [...plan.ramps, ...plan.landings];
  if (els.length < 2) return Infinity;
  let lo = Infinity;
  let hi = -Infinity;
  for (const e of els) {
    const [x0, x1] = 'aLow' in e ? [Math.min(e.aLow, e.aHigh), Math.max(e.aLow, e.aHigh)] : [e.a0, e.a1];
    lo = Math.min(lo, x0);
    hi = Math.max(hi, x1);
  }
  let best = Infinity;
  for (let a = lo; a <= hi + 1e-9; a += 0.1) {
    const ys: number[] = [];
    for (const e of els) {
      const y = galleryElementY(e, a);
      if (y !== null) ys.push(y);
    }
    ys.sort((p, q) => p - q);
    for (let i = 1; i < ys.length; i++) if (ys[i] - ys[i - 1] > 0.01) best = Math.min(best, ys[i] - ys[i - 1]);
  }
  return best;
}

/**
 * GALLERY_DANCHI corridors along one face [a0, a1]: levels 2F–4F on the archetype floor grid and a zig-zag external
 * stair in the band just outside the balustrade, so every deck stays clear end to end:
 *   street → 2F climbs toward a1 and lands at the a1 end; 2F → 3F climbs back toward a0 from a landing near the a0
 *   end; 3F → 4F climbs toward a1 again. Each flight starts and ends on a landing flush with the deck (balustrade
 *   gap). Flights are dropped from the top when the face is too short or the player would not fit under a flight.
 *   Apartment doors every 4 m on every level.
 */
export function planGallery(arch: number, a0: number, a1: number): GalleryPlan {
  const G = GRAMMAR;
  const D = G.GALLERY_DEPTH_M;
  const e0 = a0 + G.GALLERY_END_PIER_M;
  const e1 = a1 - G.GALLERY_END_PIER_M;
  const len = e1 - e0;
  const L = G.GALLERY_LANDING_M;
  const SR = G.GALLERY_STAIR_RUN_M;
  const RR = G.GALLERY_RAMP_RUN_M;
  const d0 = D + 0.05;
  const d1 = D + 1.05;
  const levels: GalleryLevel[] = [];
  for (let k = 1; k <= G.GALLERY_LEVELS; k++) levels.push({ y: floorTopY(arch, k), a0: e0, a1: e1, doors: [], railGaps: [] });
  const [y2, y3, y4] = levels.map((l) => l.y);
  const land = (x0: number, x1: number, y: number, endRail: -1 | 1, post = false): GalleryLanding => ({ a0: x0, a1: x1, y, d0: D, d1, endRail, post });
  // Stages: [flights, landings] in climbing order.
  const stages: Array<{ ramps: GalleryRamp[]; landings: GalleryLanding[] }> = [];
  if (len >= SR + L - 1e-9) {
    stages.push({ ramps: [{ aLow: e1 - L - SR, aHigh: e1 - L, yLow: 0, yHigh: y2, d0, d1 }], landings: [land(e1 - L, e1, y2, 1, true)] });
    stages.push({
      ramps: [{ aLow: e0 + L + RR, aHigh: e0 + L, yLow: y2, yHigh: y3, d0, d1 }],
      landings: [land(e0 + L + RR, e0 + 2 * L + RR, y2, 1), land(e0, e0 + L, y3, -1)],
    });
    stages.push({
      ramps: [{ aLow: e1 - L - RR, aHigh: e1 - L, yLow: y3, yHigh: y4, d0, d1 }],
      landings: [land(e1 - 2 * L - RR, e1 - L - RR, y3, -1), land(e1 - L, e1, y4, 1)],
    });
  }
  // Keep the longest prefix of stages that fits the face and leaves head room under every stacked element.
  const ramps: GalleryRamp[] = [];
  const landings: GalleryLanding[] = [];
  for (const st of stages) {
    const r2 = [...ramps, ...st.ramps];
    const l2 = [...landings, ...st.landings];
    const inside = l2.every((l) => l.a0 >= e0 - 1e-9 && l.a1 <= e1 + 1e-9) && r2.every((r) => Math.min(r.aLow, r.aHigh) >= e0 - 1e-9);
    // Same-level landings must not overlap; stacked elements need ≥ GALLERY_HEADROOM_M.
    const overlap = l2.some((p, i) => l2.some((q, j) => j > i && p.y === q.y && p.a0 < q.a1 - 1e-9 && q.a0 < p.a1 - 1e-9));
    if (!inside || overlap || galleryClearance({ ramps: r2, landings: l2 }) < G.GALLERY_HEADROOM_M) break;
    ramps.push(...st.ramps);
    landings.push(...st.landings);
  }
  for (const l of landings) levels.find((lv) => lv.y === l.y)?.railGaps.push([l.a0, l.a1]);
  for (const lv of levels) for (let a = e0 + 2; a <= e1 - 1.2; a += G.GALLERY_DOOR_SPACING_M) lv.doors.push(a);
  return { levels, ramps, landings, capY: floorTopY(arch, G.GALLERY_LEVELS + 1) };
}

// =============================================================================================
// 9A-5 Baked vertex AO geometry helpers
// =============================================================================================
export interface AoOpts {
  /** aAo of downward faces (canopy / slab / balcony undersides). */
  bottom?: number;
  /** aAo of every vertex (recess backs, pipe backs …), multiplied with the rest. */
  all?: number;
  /** Ground contact darkening: vertices below 0.55 m above `contact` ramp to 0.42 (the box is split there). */
  ground?: boolean;
  /** Height of the contact surface (0 = street; roof / deck level for parapets and corridor walls). */
  contact?: number;
  /** World-space UV tile (metres) — constant texel density on concrete / paint (default: per-face 0..1). */
  tile?: number;
}

/** Rescales a BoxGeometry's per-face UVs to world metres / tile (same face order as THREE.BoxGeometry). */
function worldUv(g: THREE.BufferGeometry, w: number, h: number, d: number, cx: number, cy: number, cz: number, tile: number): void {
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const dims: Array<[number, number, number, number]> = [
    [d, h, cz, cy],
    [d, h, cz, cy],
    [w, d, cx, cz],
    [w, d, cx, cz],
    [w, h, cx, cy],
    [w, h, cx, cy],
  ];
  for (let f = 0; f < 6; f++) {
    const [su, sv, ou, ov] = dims[f];
    for (let v = 0; v < 4; v++) {
      const i = f * 4 + v;
      uv.setXY(i, (uv.getX(i) * su + ou) / tile, (uv.getY(i) * sv + ov) / tile);
    }
  }
}

function smooth01(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Per-vertex contact multiplier for a world height y (1 above 0.55 m). */
export function groundContactAo(y: number): number {
  return y >= GRAMMAR.AO_CONTACT_M ? 1 : smooth01(0, GRAMMAR.AO_CONTACT_M, y) * 0.58 + 0.42;
}

/** Writes (or multiplies into) the `aAo` attribute from per-vertex rules. */
export function applyAo(g: THREE.BufferGeometry, o: AoOpts): THREE.BufferGeometry {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const nrm = g.getAttribute('normal') as THREE.BufferAttribute | undefined;
  let ao = g.getAttribute('aAo') as THREE.BufferAttribute | undefined;
  if (!ao) {
    ao = new THREE.BufferAttribute(new Float32Array(pos.count).fill(1), 1);
    g.setAttribute('aAo', ao);
  }
  for (let i = 0; i < pos.count; i++) {
    let v = ao.getX(i) * (o.all ?? 1);
    if (o.bottom !== undefined && nrm && nrm.getY(i) < -0.5) v *= o.bottom;
    if (o.ground) v *= groundContactAo(pos.getY(i) - (o.contact ?? 0));
    ao.setX(i, v);
  }
  return g;
}

/** Ensures an `aAo` attribute (1.0) so every geometry of a merged bucket shares the attribute set. */
export function ensureAo(g: THREE.BufferGeometry): THREE.BufferGeometry {
  if (!g.getAttribute('aAo')) g.setAttribute('aAo', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count).fill(1), 1));
  return g;
}

/** Axis-aligned box centred at (x, y, z); split at the 0.55 m contact line when it touches the ground. */
export function aoBox(w: number, h: number, d: number, x: number, y: number, z: number, o: AoOpts = {}): THREE.BufferGeometry[] {
  const y0 = y - h / 2;
  const y1 = y + h / 2;
  const C = (o.contact ?? 0) + GRAMMAR.AO_CONTACT_M;
  const mk = (a: number, b: number, bottomCap: boolean): THREE.BufferGeometry => {
    const g = new THREE.BoxGeometry(w, b - a, d);
    if (o.tile) worldUv(g, w, b - a, d, x, (a + b) / 2, z, o.tile);
    g.translate(x, (a + b) / 2, z);
    return applyAo(g, { ...o, bottom: bottomCap ? o.bottom : undefined });
  };
  if (o.ground && y0 < C - 0.02 && y1 > C + 0.02) return [mk(y0, C, true), mk(C, y1, false)];
  return [mk(y0, y1, true)];
}

/** Hexagonal pipe from a to b (radius r) with wall-facing AO; for risers, clamps and conduits. */
export function aoPipe(a: THREE.Vector3, b: THREE.Vector3, r: number, wallN: THREE.Vector3 | null, ground = false): THREE.BufferGeometry {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const g = new THREE.CylinderGeometry(r, r, len, 6, 1, false);
  g.translate(0, len / 2, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  g.applyQuaternion(q);
  g.translate(a.x, a.y, a.z);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const nrm = g.getAttribute('normal') as THREE.BufferAttribute;
  const ao = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    let v = 1;
    // Sides turned toward the wall sit in its shadow.
    if (wallN) v *= nrm.getX(i) * -wallN.x + nrm.getZ(i) * -wallN.z > 0.3 ? GRAMMAR.AO_PIPE_BACK : 1;
    if (ground) v *= groundContactAo(pos.getY(i));
    ao[i] = v;
  }
  g.setAttribute('aAo', new THREE.BufferAttribute(ao, 1));
  return g;
}

/** Per-vertex RGB tint (archPaintMat albedo). */
export function withTint(g: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const c = new THREE.Color(hex);
  const n = g.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

/** Muted cyberpunk door / trim palette (linear-dark weathered paints, 0.06–0.28 albedo). */
export const PAINT = {
  DOORS: [0x2e3e35, 0x272e38, 0x432d26, 0x23272d] as readonly number[],
  AWNINGS: [0x4a1c24, 0x163c40, 0x26292e] as readonly number[],
  SHUTTER: [0x3b4048, 0x2f3a2c, 0x4a3226] as readonly number[],
  FRAME_DARK: 0x24272c,
  CONCRETE_FRAME: 0x4b4a47,
  STEEL_BRUSHED: 0x7a8088,
  TIMBER: 0x3a2a20,
  SLATE: 0x2a2d31,
  HAZARD_Y: 0x8a6a10,
  HAZARD_K: 0x161616,
  MAILBOX: 0x6e747c,
  BLACK_ALU: 0x15171a,
} as const;
