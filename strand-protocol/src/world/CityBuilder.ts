/**
 * STRAND // PROTOCOL — Multi-layer cyberpunk district builder (spec v1.1: §1.1, §6.1, §6.2-2, §8.1, §9.2).
 *
 *  Layer 0  (Y −2.4 … 0)  wet avenues / streets / alleys (road atlas: lanes, centre line, dashes, crosswalks,
 *                          manholes, puddles), parked cyber-cars (3 variants), canal with ripple/flow water,
 *                          towpaths, guard-rails and neon truss bridges (gold anchors on truss apexes)
 *  Layer 1  (Y 9.5)        elevated expressway: 2+2 lanes, median, guard walls (bare concrete, edge-line lit,
 *                          outer face wall-runnable),
 *                          piers every 24–28 m, underside industrial light strips, ground on-ramps,
 *                          clearance ≥ 7.8 m so it can be slid / swung under freely
 *  Layer 2  (Y 18–35)      sky-bridges between towers, projecting neon blade signs, gold anchors
 *  Layer 3  (Y 30–95)      high rooftops with AC units, ducts, fences, antennas, aviation lights, searchlights
 *  Boundary                hologram lockdown barrier (+ emerald gate) · 100 far supertalls · 40 hover-car trails
 *
 * Draw calls: every repeated element is ONE InstancedMesh or ONE merged geometry (≈ 38 scene calls).
 * Wet ground, roads, canal water, expressway concrete, tower walls (≤ 40 m) and parked cars receive analytic
 * reflections of the nearest 24 city lights (street lamps, bridge neon, expressway strips, roof crowns),
 * selected allocation-free each frame.
 *
 * Phase 5B art pass:
 *  - 5B-1 point / line accents above the bloom threshold (signs 1.38, lamp heads 1.45 / rings 1.30, hover
 *    trails 1.55, aviation 1.60, underside strips 1.60) + an instanced rain-haze halo on every lamp head
 *  - 5B-2 tower walls: city lights, ground contact AO (0 → 2.6 m), violet low-rise bounce (0–16 m) and a
 *    cold moonlight lift (40–95 m); parked cars take the city lights too
 *  - 5B-3 two-tier setback towers (two colliders), roof crowns, 1F canopies with under-glow, facade fins, signs
 *    in three formats (blade / wide banner + LED ticker / emblem hologram), 40–60 steam billboards
 *
 * Phase 6A architecture pass (still one merged draw per material):
 *  - 6A-1 facade atlas with four archetype columns, per-room night lighting (dark 65 / warm 20 / cool 13 /
 *    accent 2 %, integer hash shared with FacadeLighting.ts), mechanical floors every 7–9 storeys and
 *    interior mapping (parallax room boxes) behind clear glass; LOW quality falls back to 2D windows
 *  - 6A-2 archetypes 30 / 25 / 25 / 20 %: A glass towers (mullions, setback, crown) · B concrete residential
 *    (pilasters, balconies) · C industrial (fire escape, ducts, loading dock) · D commercial (recessed
 *    roll-shutter street base with stone pillars and a sign fascia, per-floor canopies, packed signage)
 *  - 6A-3 walkable balconies (slab + rail colliders ≤ 36 m) · 6A-4 climbable zig-zag fire escapes (landing
 *    boxes + RampCollider flights) · 6A-5 cyan wall-run cladding removed
 *  - 6B-2 no wall-run list any more: PhysicsWorld finds runnable faces on every BUILDING / HIGHWAY / BRIDGE /
 *    SKYBRIDGE collider; shallow decorations (mullions, pilasters, ducts, fins ≤ 0.45 m) have no collider
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ARCHETYPE, BALCONY, CITY_SHADING, COLORS, FACADE, FIRE_ESCAPE, LEVEL, LIMITS, MATERIALS, NEON_BLOOM, RENDER, SILHOUETTE, createRng, clamp } from '../config/constants';
import { ARCH_A, ARCH_B, ARCH_C, ARCH_D, GLSL_FACADE, facadeFloorY, facadeRoomState, faceKey, isMachineFloor, roomOffset, roomsPerTile, seedInt } from './FacadeLighting';
import { SECTORS, type SectorDef } from '../config/skills';
import { ROAD_ATLAS, SIGN_ATLAS, type AtlasRegion, type ProceduralTextureLibrary } from '../engine/ProceduralTextures';

// =============================================================================================
// Public layout data (consumed by PhysicsWorld / PlayerController / EnemyManager / HUD)
// =============================================================================================
export type ColliderKind =
  | 'GROUND'
  | 'BUILDING'
  | 'PROP'
  | 'STEEL'
  | 'CAR'
  | 'HIGHWAY'
  | 'BRIDGE'
  | 'WATER'
  | 'TOWPATH'
  | 'SKYBRIDGE'
  | 'BARRIER';

export interface BoxCollider {
  readonly min: THREE.Vector3;
  readonly max: THREE.Vector3;
  readonly kind: ColliderKind;
  /** Owning building index (-1 when not part of a building). */
  readonly building: number;
  /** The district gate section of the lockdown barrier (passable once the gate opens). */
  readonly gate?: boolean;
}

/** Sloped on-ramp: surface height interpolates linearly along `axis` from (alongStart, yStart) to (alongEnd, yEnd). */
export interface RampCollider {
  readonly axis: 'x' | 'z';
  readonly lateralMin: number;
  readonly lateralMax: number;
  readonly alongStart: number;
  readonly alongEnd: number;
  readonly yStart: number;
  readonly yEnd: number;
  readonly thickness: number;
  /** 6A-4 open steel stair flight (fire escape): slab contacts use a slimmer body so the 0.9 m lanes don't snag. */
  readonly steel?: boolean;
}

export type AnchorKind = 'HIGHWAY_EDGE' | 'BRIDGE_TRUSS' | 'BUILDING_CORNER' | 'SKYBRIDGE' | 'SIGN';
export interface GrappleAnchor {
  readonly position: THREE.Vector3;
  readonly kind: AnchorKind;
  enabled: boolean;
}

export interface BuildingInfo {
  readonly index: number;
  readonly cx: number;
  readonly cz: number;
  readonly halfW: number;
  readonly halfD: number;
  readonly roofY: number;
  /** 6A-2 archetype: 0 A glass tower · 1 B residential · 2 C industrial · 3 D commercial. */
  readonly arch: number;
}

export type CityLayer = 0 | 1 | 2 | 3;
export interface SpawnPoint {
  readonly position: THREE.Vector3;
  readonly layer: CityLayer;
  /** Building index for roof / perch spawns, -1 otherwise. */
  readonly building: number;
}

export interface RectXZ {
  readonly x0: number;
  readonly z0: number;
  readonly x1: number;
  readonly z1: number;
}

export interface GateInfo {
  /** Centre of the gate opening at street level. */
  readonly position: THREE.Vector3;
  /** Outward normal of the barrier at the gate. */
  readonly normal: THREE.Vector3;
  readonly halfWidth: number;
  readonly height: number;
  open: boolean;
}

/** 6A: a 3D facade feature (centre of the face it occupies, outward normal) — tests / spawn logic. */
export interface FacadeFeature {
  readonly kind: 'BALCONY' | 'FIRE_ESCAPE' | 'SHUTTER_FRONT';
  readonly building: number;
  readonly center: THREE.Vector3;
  readonly normal: THREE.Vector3;
  /** Top of the feature (highest balcony slab / landing, street-base height). */
  readonly top: number;
}

export interface SectorLayout {
  readonly sector: SectorDef;
  readonly loop: number;
  readonly buildings: readonly BuildingInfo[];
  readonly colliders: readonly BoxCollider[];
  readonly ramps: readonly RampCollider[];
  readonly anchors: readonly GrappleAnchor[];
  readonly facadeFeatures: readonly FacadeFeature[];
  /** Canal water rectangles (water surface Y = −2.4 m): grounded here ⇒ shallow-water speed × 0.55. */
  readonly canalWater: readonly RectXZ[];
  readonly playerSpawn: THREE.Vector3;
  readonly playerSpawnYaw: number;
  /** Layer 0: street / plaza positions near cover. */
  readonly groundSpawns: readonly SpawnPoint[];
  /** Layer 1: expressway deck positions. */
  readonly highwaySpawns: readonly SpawnPoint[];
  /** Layer 0: canal truss-bridge decks (connected street battlefield, 5A-5). */
  readonly bridgeSpawns: readonly SpawnPoint[];
  /** Layer 2: sky-bridge roofs. */
  readonly skybridgeSpawns: readonly SpawnPoint[];
  /** Layer 3: rooftops (Y ≥ 30 m). */
  readonly roofSpawns: readonly SpawnPoint[];
  /** Layer 3: sniper perches on roof edges of the highest towers, facing the spawn. */
  readonly perchSpawns: readonly SpawnPoint[];
  /** Free air above streets for drones (6–22 m, clear of expressway decks). */
  readonly airSpawns: readonly THREE.Vector3[];
  readonly gate: GateInfo;
  readonly center: THREE.Vector3;
  /** Closed collision-free camera loop used by the title-screen attract mode. */
  readonly cinematicPath: readonly THREE.Vector3[];
  readonly stats: {
    readonly towers: number;
    readonly cars: number;
    readonly highways: number;
    readonly ramps: number;
    readonly bridges: number;
    readonly skybridges: number;
    readonly lamps: number;
    readonly cityLights: number;
    /** 6A-2 tower count per archetype (A · B · C · D). */
    readonly archetypes: readonly number[];
    readonly balconies: number;
    readonly fireEscapes: number;
    readonly escapeFlights: number;
    readonly shutterFronts: number;
    /** 6A-1 rooms per night-light state on the rendered facades: dark · warm · cool · accent. */
    readonly facadeRooms: readonly number[];
  };
}

// =============================================================================================
// District plans
// =============================================================================================
type Axis = 'x' | 'z';
type StreetKind = 'AVENUE' | 'STREET';

/** A street running along `axis` at the perpendicular coordinate `coord`, between `from` and `to` along its axis. */
interface StreetPlan {
  readonly axis: Axis;
  readonly coord: number;
  readonly kind: StreetKind;
  readonly from: number;
  readonly to: number;
}
interface CanalPlan {
  readonly axis: Axis;
  readonly coord: number;
  readonly width: number;
  readonly from: number;
  readonly to: number;
}
interface HighwayPlan {
  readonly axis: Axis;
  readonly coord: number;
  readonly from: number;
  readonly to: number;
  /** Underside strip colours: side −1 / side +1. */
  readonly lightNeg: number;
  readonly lightPos: number;
}
interface RampPlan {
  readonly highway: number;
  /** Street (perpendicular to the highway) the ramp descends along. */
  readonly street: number;
  /** Descending direction along the ramp street. */
  readonly dir: 1 | -1;
  /** Which half of the ramp street the ramp occupies. */
  readonly side: 1 | -1;
}
interface DistrictPlan {
  readonly streets: readonly StreetPlan[];
  readonly canals: readonly CanalPlan[];
  readonly highways: readonly HighwayPlan[];
  readonly ramps: readonly RampPlan[];
  /** Streets that cross the canal on a truss bridge (others dead-end at the promenade). */
  readonly bridgeStreets: readonly number[];
  /** Main avenue (spawn → gate). */
  readonly avenue: number;
  readonly gateDir: 1 | -1;
  readonly spawnAlong: number;
  /** Explicit building footprints (ring layout). */
  readonly explicitLots?: readonly RectXZ[];
  /** Scramble-crossing plaza (ring layout). */
  readonly plaza?: RectXZ;
}

const VIS = LEVEL.VISUAL_EXTENT_M;
const H = LEVEL.HALF_EXTENT_M;
const CYAN = COLORS.HIGHWAY_LIGHT_CYAN;
const AMBER = COLORS.HIGHWAY_LIGHT_AMBER;

function st(axis: Axis, coord: number, kind: StreetKind, from: number = -VIS, to: number = VIS): StreetPlan {
  return { axis, coord, kind, from, to };
}

function makePlan(sector: SectorDef): DistrictPlan {
  switch (sector.index) {
    case 1:
      // Main avenue (x = 0) under one expressway (z = 0) with an on-ramp down toward the spawn.
      return {
        streets: [st('z', 0, 'AVENUE'), st('z', -52, 'STREET'), st('z', 52, 'STREET'), st('x', -50, 'STREET'), st('x', 0, 'STREET'), st('x', 50, 'STREET')],
        canals: [],
        highways: [{ axis: 'x', coord: 0, from: -VIS, to: VIS, lightNeg: CYAN, lightPos: AMBER }],
        ramps: [{ highway: 0, street: 0, dir: -1, side: 1 }],
        bridgeStreets: [],
        avenue: 0,
        gateDir: 1,
        spawnAlong: -76,
      };
    case 2:
      // Canal along z (x = 24, 16 m) crossed by two neon truss bridges; one expressway over the canal.
      return {
        streets: [st('z', -12, 'AVENUE'), st('z', -56, 'STREET'), st('z', 62, 'STREET'), st('x', -48, 'STREET'), st('x', 6, 'STREET'), st('x', 52, 'STREET')],
        canals: [{ axis: 'z', coord: 24, width: 16, from: -VIS, to: VIS }],
        highways: [{ axis: 'x', coord: 6, from: -VIS, to: VIS, lightNeg: AMBER, lightPos: CYAN }],
        ramps: [{ highway: 0, street: 0, dir: -1, side: 1 }],
        bridgeStreets: [3, 5],
        avenue: 0,
        gateDir: 1,
        spawnAlong: -76,
      };
    case 3:
      // Two expressways crossing at grade (x = −4 / z = 4), narrow wall-run alleys, sky-bridges.
      return {
        streets: [st('z', 46, 'AVENUE'), st('z', -48, 'STREET'), st('z', -4, 'STREET'), st('x', -46, 'STREET'), st('x', 4, 'STREET'), st('x', 50, 'STREET')],
        canals: [],
        highways: [
          { axis: 'z', coord: -4, from: -VIS, to: VIS, lightNeg: CYAN, lightPos: CYAN },
          { axis: 'x', coord: 4, from: -VIS, to: VIS, lightNeg: AMBER, lightPos: AMBER },
        ],
        ramps: [
          { highway: 1, street: 0, dir: -1, side: 1 },
          { highway: 0, street: 3, dir: -1, side: 1 },
        ],
        bridgeStreets: [],
        avenue: 0,
        gateDir: 1,
        spawnAlong: -76,
      };
    case 4:
      // Neon canal (z = −12, 18 m) with three truss bridges under twin expressways (x = −26 / x = 50).
      return {
        streets: [st('z', 10, 'AVENUE'), st('z', -64, 'STREET'), st('z', -26, 'STREET'), st('z', 50, 'STREET'), st('x', -58, 'STREET'), st('x', 38, 'STREET')],
        canals: [{ axis: 'x', coord: -12, width: 18, from: -VIS, to: VIS }],
        highways: [
          { axis: 'z', coord: -26, from: -VIS, to: VIS, lightNeg: CYAN, lightPos: AMBER },
          { axis: 'z', coord: 50, from: -VIS, to: VIS, lightNeg: AMBER, lightPos: CYAN },
        ],
        ramps: [
          { highway: 0, street: 5, dir: -1, side: 1 },
          { highway: 1, street: 4, dir: -1, side: 1 },
        ],
        bridgeStreets: [0, 1, 3],
        avenue: 0,
        gateDir: 1,
        spawnAlong: -76,
      };
    default: {
      // Sector 5: central scramble plaza, ring road under a ring expressway, 16 supertalls, outer canal ring.
      const lots: RectXZ[] = [];
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          // Corner pair split by a 6 m alley.
          lots.push(rectFrom(sx * 38, sz * 38, sx * 49, sz * 66));
          lots.push(rectFrom(sx * 55, sz * 38, sx * 66, sz * 66));
        }
      }
      for (const s of [-1, 1]) {
        // Side towers either side of the axial avenues.
        lots.push(rectFrom(-32, s * 41, -14, s * 63), rectFrom(14, s * 41, 32, s * 63));
        lots.push(rectFrom(s * 41, -32, s * 63, -14), rectFrom(s * 41, 14, s * 63, 32));
      }
      return {
        streets: [
          st('x', 27, 'AVENUE', -34, 34),
          st('x', -27, 'AVENUE', -34, 34),
          st('z', 27, 'AVENUE', -20, 20),
          st('z', -27, 'AVENUE', -20, 20),
          st('z', 0, 'AVENUE', 34, VIS),
          st('z', 0, 'AVENUE', -VIS, -34),
          st('x', 0, 'AVENUE', 34, VIS),
          st('x', 0, 'AVENUE', -VIS, -34),
        ],
        canals: [
          { axis: 'x', coord: 78, width: 16, from: -86, to: 86 },
          { axis: 'x', coord: -78, width: 16, from: -86, to: 86 },
          { axis: 'z', coord: 78, width: 16, from: -70, to: 70 },
          { axis: 'z', coord: -78, width: 16, from: -70, to: 70 },
        ],
        highways: [
          { axis: 'x', coord: 27, from: -34, to: 34, lightNeg: CYAN, lightPos: AMBER },
          { axis: 'x', coord: -27, from: -34, to: 34, lightNeg: AMBER, lightPos: CYAN },
          { axis: 'z', coord: 27, from: -34, to: 34, lightNeg: CYAN, lightPos: AMBER },
          { axis: 'z', coord: -27, from: -34, to: 34, lightNeg: AMBER, lightPos: CYAN },
        ],
        ramps: [{ highway: 0, street: 4, dir: 1, side: 1 }],
        bridgeStreets: [4, 5, 6, 7],
        avenue: 5,
        gateDir: 1,
        spawnAlong: -60,
        explicitLots: lots,
        plaza: { x0: -20, z0: -20, x1: 20, z1: 20 },
      };
    }
  }
}

// =============================================================================================
// Small helpers
// =============================================================================================
const _m4 = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scl = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();
const _euler = new THREE.Euler();
const _col = new THREE.Color();

function rectFrom(ax: number, az: number, bx: number, bz: number): RectXZ {
  return { x0: Math.min(ax, bx), z0: Math.min(az, bz), x1: Math.max(ax, bx), z1: Math.max(az, bz) };
}

function laneHalf(kind: StreetKind): number {
  return (kind === 'AVENUE' ? LEVEL.AVENUE_WIDTH_M : LEVEL.STREET_WIDTH_M) / 2;
}
function sidewalk(kind: StreetKind): number {
  return kind === 'AVENUE' ? LEVEL.AVENUE_SIDEWALK_M : LEVEL.STREET_SIDEWALK_M;
}
function corridorHalf(s: StreetPlan): number {
  return laneHalf(s.kind) + sidewalk(s.kind);
}
function canalCorridorHalf(c: CanalPlan): number {
  return c.width / 2 + LEVEL.CANAL_PROMENADE_M;
}

/** World point from (along, lateral) coordinates of an axis-aligned feature. */
function pt(axis: Axis, along: number, y: number, lateral: number, out = new THREE.Vector3()): THREE.Vector3 {
  return axis === 'z' ? out.set(lateral, y, along) : out.set(along, y, lateral);
}

function colliderAL(axis: Axis, a0: number, a1: number, l0: number, l1: number, y0: number, y1: number, kind: ColliderKind, building = -1, gate = false): BoxCollider {
  const p = pt(axis, Math.min(a0, a1), y0, Math.min(l0, l1));
  const q = pt(axis, Math.max(a0, a1), y1, Math.max(l0, l1));
  return { min: p, max: q, kind, building, gate };
}

function boxAt(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

/** Box with UVs scaled to world size (tile metres) so textures keep constant texel density. */
function worldUvBox(w: number, h: number, d: number, cx: number, cy: number, cz: number, tile: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
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
  g.translate(cx, cy, cz);
  return g;
}

/** World-UV axis-aligned box from (along, lateral, y) extents. */
function boxGeoWorld(axis: Axis, a0: number, a1: number, l0: number, l1: number, y0: number, y1: number): THREE.BufferGeometry {
  const along = Math.abs(a1 - a0);
  const lat = Math.abs(l1 - l0);
  const c = pt(axis, (a0 + a1) / 2, (y0 + y1) / 2, (l0 + l1) / 2, new THREE.Vector3());
  return axis === 'z'
    ? worldUvBox(lat, y1 - y0, along, c.x, c.y, c.z, RENDER.ROOF_TILE_M)
    : worldUvBox(along, y1 - y0, lat, c.x, c.y, c.z, RENDER.ROOF_TILE_M);
}

/** Thin box spanning a → b (lattice members, sloped parapets). */
function beam(a: THREE.Vector3, b: THREE.Vector3, thickness: number, depth = thickness): THREE.BufferGeometry {
  const len = a.distanceTo(b);
  const g = new THREE.BoxGeometry(thickness, len, depth);
  _dir.subVectors(b, a).normalize();
  _quat.setFromUnitVectors(_up, _dir);
  g.applyQuaternion(_quat);
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return g;
}

/**
 * Indexed quad from 4 corners (in order around the perimeter) facing `normalHint`.
 * `extra` adds per-vertex attributes (same value on all 4 vertices).
 */
function quad(
  p: readonly [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3],
  uv: readonly [number, number, number, number, number, number, number, number],
  normalHint: THREE.Vector3,
  extra?: Record<string, readonly number[]>,
): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(12);
  p.forEach((v, i) => v.toArray(pos, i * 3));
  const e1 = new THREE.Vector3().subVectors(p[2], p[0]);
  const e2 = new THREE.Vector3().subVectors(p[1], p[0]);
  const n = new THREE.Vector3().crossVectors(e1, e2).normalize();
  const flip = n.dot(normalHint) < 0;
  if (flip) n.negate();
  const nor = new Float32Array(12);
  for (let i = 0; i < 4; i++) n.toArray(nor, i * 3);
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
  if (extra) {
    for (const [name, val] of Object.entries(extra)) {
      const arr = new Float32Array(val.length * 4);
      for (let i = 0; i < 4; i++) arr.set(val, i * val.length);
      g.setAttribute(name, new THREE.BufferAttribute(arr, val.length));
    }
  }
  g.setIndex(flip ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]);
  return g;
}

function withColor(g: THREE.BufferGeometry, hex: number, intensity: number): THREE.BufferGeometry {
  _col.setHex(hex);
  const n = g.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = _col.r * intensity;
    arr[i * 3 + 1] = _col.g * intensity;
    arr[i * 3 + 2] = _col.b * intensity;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

function withAttr1(g: THREE.BufferGeometry, name: string, value: number): THREE.BufferGeometry {
  const n = g.getAttribute('position').count;
  g.setAttribute(name, new THREE.BufferAttribute(new Float32Array(n).fill(value), 1));
  return g;
}

function stripUv(g: THREE.BufferGeometry): THREE.BufferGeometry {
  if (g.getAttribute('uv')) g.deleteAttribute('uv');
  return g;
}

function mergeOrEmpty(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  if (list.length === 0) return new THREE.BufferGeometry();
  const merged = mergeGeometries(list);
  if (!merged) throw new Error('mergeGeometries failed: incompatible attributes');
  return merged;
}

/** Subtract closed intervals from [a, b]. */
function subtractIntervals(a: number, b: number, cuts: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  let parts: Array<[number, number]> = [[a, b]];
  for (const [c0, c1] of cuts) {
    const next: Array<[number, number]> = [];
    for (const [p0, p1] of parts) {
      if (c1 <= p0 || c0 >= p1) {
        next.push([p0, p1]);
        continue;
      }
      if (c0 > p0) next.push([p0, c0]);
      if (c1 < p1) next.push([c1, p1]);
    }
    parts = next;
  }
  return parts.filter(([p0, p1]) => p1 - p0 > 0.05);
}

function rectsOverlap(a: RectXZ, b: RectXZ, margin = 0): boolean {
  return a.x0 < b.x1 + margin && a.x1 > b.x0 - margin && a.z0 < b.z1 + margin && a.z1 > b.z0 - margin;
}

function insideRect(x: number, z: number, r: RectXZ, margin = 0): boolean {
  return x > r.x0 - margin && x < r.x1 + margin && z > r.z0 - margin && z < r.z1 + margin;
}

// =============================================================================================
// Shared GLSL
// =============================================================================================
const GLSL_HASH = /* glsl */ `
  float sHash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  float sNoise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(sHash12(i), sHash12(i + vec2(1.0, 0.0)), u.x), mix(sHash12(i + vec2(0.0, 1.0)), sHash12(i + vec2(1.0, 1.0)), u.x), u.y);
  }
`;

const GLSL_FOG_FADE = /* glsl */ `
  float strandFogFade(float dist, float density) {
    float f = 1.0 - exp(-density * density * dist * dist);
    return 1.0 - clamp(f, 0.0, 1.0);
  }
`;

/** Expanding rain-drop rings (gradient), used in puddles and canal water. */
const GLSL_RIPPLES = /* glsl */ `
  vec2 strandRipples(vec2 p, float t) {
    vec2 cell = floor(p);
    vec2 grad = vec2(0.0);
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 c = cell + vec2(float(i), float(j));
        float h = sHash12(c);
        vec2 center = c + vec2(sHash12(c + 7.1), sHash12(c + 3.7));
        float life = fract(t * (0.9 + h * 0.6) + h);
        vec2 d = p - center;
        float dist = length(d);
        float x = (dist - life * 0.75) * 22.0;
        float ring = sin(clamp(x, -3.14159, 3.14159)) * (1.0 - life) * (1.0 - life) * step(abs(x), 3.14159);
        grad += (dist > 1e-4 ? d / dist : vec2(0.0)) * ring;
      }
    }
    return grad;
  }
`;

const MAX_LIGHTS = RENDER.CITY_LIGHTS_MAX;
const CORNERS_4: ReadonlyArray<readonly [number, number]> = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

/** Analytic GGX reflections of the nearest city lights (wet streets, puddles, canal water). */
const GLSL_CITY_LIGHTS = /* glsl */ `
  uniform vec3 uCityLightPos[${MAX_LIGHTS}];
  uniform vec3 uCityLightCol[${MAX_LIGHTS}];
  uniform int uCityLightCount;
  varying vec3 vCityWorld;
  vec3 strandCityLights(vec3 P, vec3 N, vec3 V, vec3 albedo, float rough, float metal) {
    vec3 acc = vec3(0.0);
    float a = max(rough * rough, 0.0025);
    float a2 = a * a;
    vec3 F0 = mix(vec3(0.04), albedo, metal);
    float NdV = max(dot(N, V), 1e-3);
    for (int i = 0; i < ${MAX_LIGHTS}; i++) {
      if (i >= uCityLightCount) break;
      vec3 Lv = uCityLightPos[i] - P;
      float d = length(Lv);
      vec3 L = Lv / max(d, 1e-3);
      float att = (1.0 / (1.0 + d * d * 0.045)) * (1.0 - smoothstep(${(RENDER.CITY_LIGHT_RANGE_M * 0.6).toFixed(1)}, ${RENDER.CITY_LIGHT_RANGE_M.toFixed(1)}, d));
      float NdL = max(dot(N, L), 0.0);
      if (att * NdL <= 0.0) continue;
      vec3 Hh = normalize(L + V);
      float NdH = max(dot(N, Hh), 0.0);
      float dn = NdH * NdH * (a2 - 1.0) + 1.0;
      float D = min(a2 / (3.14159 * dn * dn), 120.0);
      vec3 F = F0 + (1.0 - F0) * pow(1.0 - max(dot(V, Hh), 0.0), 5.0);
      float Vis = 0.25 / max(NdL * NdV, 0.06);
      vec3 spec = F * D * Vis;
      vec3 diff = albedo * (1.0 - metal) * 0.31831;
      acc += uCityLightCol[i] * att * NdL * (diff + spec);
    }
    return acc;
  }
`;

const GLSL_CITY_LIGHTS_APPLY = /* glsl */ `
  {
    vec3 strandNw = transformNormalByInverseViewMatrix(normal, viewMatrix);
    vec3 strandV = normalize(cameraPosition - vCityWorld);
    outgoingLight += strandCityLights(vCityWorld, strandNw, strandV, diffuseColor.rgb, roughnessFactor, metalnessFactor);
  }
  #include <opaque_fragment>
`;

/** Puddle ripple normals: puddles are detected from the sampled roughness (< ~0.2). */
const GLSL_PUDDLE_RIPPLES = /* glsl */ `
  {
    float strandPuddle = 1.0 - smoothstep(0.08, 0.22, roughnessFactor);
    vec3 strandNwUp = transformNormalByInverseViewMatrix(normal, viewMatrix);
    if (strandPuddle > 0.001 && strandNwUp.y > 0.5) {
      vec2 g = strandRipples(vCityWorld.xz * 2.2, uTime) * 0.32 + strandRipples(vCityWorld.xz * 3.7 + 11.0, uTime * 1.21) * 0.22;
      normal = normalize(normal + mat3(viewMatrix) * (vec3(g.x, 0.0, g.y) * strandPuddle));
    }
  }
`;

// =============================================================================================
// Capacities (pre-allocated once; counts set per sector)
// =============================================================================================
const CAP = {
  /** Roof units + 6A-3 balcony outdoor units. */
  AC: 300,
  DUCT: 60,
  FENCE: 240,
  ANTENNA: 44,
  AVIATION: 280,
  NEON: 420,
  SEARCH: 20,
  MACHINE_ROOM: 26,
  BEACON: 220,
  LAMP: 170,
  VENDING: 90,
  GUARDRAIL: 220,
  CITY_LIGHTS: 420,
  STEAM: SILHOUETTE.STEAM_MAX,
} as const;

/**
 * `halfW` / `halfD` / `roofY` describe the ROOF (upper tier on setback towers) — roof props, corner anchors,
 * perches and the enemy rooftop logic use them. Street faces (panels, signs, canopies, fins) use the lot.
 */
interface Building extends BuildingInfo {
  readonly rect: RectXZ;
  readonly seed: number;
  readonly lotHalfW: number;
  readonly lotHalfD: number;
  /** Setback terrace height (0 = single block). */
  readonly setbackY: number;
}

interface CarSlot {
  readonly x: number;
  readonly z: number;
  readonly y: number;
  readonly yaw: number;
  readonly onHighway: boolean;
}

// =============================================================================================
// CityBuilder
// =============================================================================================
export class CityBuilder {
  readonly root = new THREE.Group();
  private readonly persistent = new THREE.Group();
  private readonly sectorGroup = new THREE.Group();
  private sectorDisposables: Array<{ dispose(): void }> = [];

  // Shared uniforms
  private readonly uTime = { value: 0 };
  private readonly uNeonBoost = { value: 1.0 };
  private readonly uSearchPulse = { value: 0.0 };
  private readonly uGateOpen = { value: 0.0 };
  private readonly uFogDensity = { value: RENDER.FOG_DENSITY };
  private readonly uCityLightPos = { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector3()) };
  private readonly uCityLightCol = { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector3()) };
  private readonly uCityLightCount = { value: 0 };
  /** 1 = tower walls receive the city lights (HIGH / MEDIUM), 0 = off (LOW). */
  private readonly uWallLights = { value: 1 };

  // City light pool (per sector)
  private readonly lightPos = new Float32Array(CAP.CITY_LIGHTS * 3);
  private readonly lightCol = new Float32Array(CAP.CITY_LIGHTS * 3);
  private readonly lightDist = new Float32Array(CAP.CITY_LIGHTS);
  private lightCount = 0;

  // Materials
  private readonly buildingMat: THREE.MeshStandardMaterial;
  private readonly concreteMat: THREE.MeshStandardMaterial;
  private readonly roadMat: THREE.MeshStandardMaterial;
  private readonly waterMat: THREE.MeshStandardMaterial;
  private readonly hwConcreteMat: THREE.MeshStandardMaterial;
  private readonly stripMat: THREE.MeshBasicMaterial;
  /** 6A: transparent tempered glass (balcony rail panels) — one draw. */
  private readonly shopGlassMat: THREE.MeshStandardMaterial;
  private readonly steelMat: THREE.MeshStandardMaterial;
  private readonly glassMat: THREE.MeshStandardMaterial;
  private readonly beaconMat: THREE.MeshStandardMaterial;
  private readonly barrierMat: THREE.ShaderMaterial;

  // Persistent meshes
  private readonly sky: THREE.Mesh;
  private readonly farTowers: THREE.InstancedMesh;
  private readonly farInfo: Array<{ x: number; z: number; w: number; d: number; top: number }> = [];
  private readonly hoverTrails: THREE.InstancedMesh;

  // Instanced detail meshes
  private readonly cars: THREE.InstancedMesh[];
  private readonly lamps: THREE.InstancedMesh;
  private readonly vending: THREE.InstancedMesh;
  private readonly guardrails: THREE.InstancedMesh;
  private readonly acUnits: THREE.InstancedMesh;
  private readonly ducts: THREE.InstancedMesh;
  private readonly fences: THREE.InstancedMesh;
  private readonly antennas: THREE.InstancedMesh;
  private readonly machineRooms: THREE.InstancedMesh;
  private readonly aviation: THREE.InstancedMesh;
  private readonly neonSigns: THREE.InstancedMesh;
  private readonly searchlights: THREE.InstancedMesh;
  private readonly beacons: THREE.InstancedMesh;
  private readonly halos: THREE.InstancedMesh;
  /** 5B-1: soft rain-haze glow around every street-lamp head (one instanced draw). */
  private readonly lampHalos: THREE.InstancedMesh;
  /** 5B-3: low steam from manholes / ducts and canal mist (one instanced draw, animated on the GPU). */
  private readonly steam: THREE.InstancedMesh;
  private readonly gatePillar: THREE.Mesh;

  private layout: SectorLayout | null = null;
  /** Tower records of the current sector (facade probe). */
  private towers: readonly Building[] = [];

  constructor(private readonly tex: ProceduralTextureLibrary) {
    this.root.name = 'City';
    this.root.add(this.persistent, this.sectorGroup);

    this.buildingMat = this.createBuildingMaterial();
    this.concreteMat = this.createConcreteMaterial();
    this.roadMat = this.createRoadMaterial();
    this.waterMat = this.createWaterMaterial();
    this.hwConcreteMat = this.createHighwayConcreteMaterial();
    this.stripMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: true });
    this.shopGlassMat = new THREE.MeshStandardMaterial({
      color: 0x9fb6cc,
      roughness: 0.04,
      metalness: 0.7,
      transparent: true,
      opacity: 0.24,
      depthWrite: false,
      envMapIntensity: 1.5,
    });
    this.steelMat = new THREE.MeshStandardMaterial({ color: 0x2a303b, roughness: 0.42, metalness: 0.85 });
    this.glassMat = new THREE.MeshStandardMaterial({ color: 0x0a1018, roughness: 0.06, metalness: 0.9 });
    this.beaconMat = this.createBeaconMaterial();
    this.barrierMat = this.createBarrierMaterial();

    // ---------------- Persistent backdrop ----------------
    this.sky = this.createSky();
    this.farTowers = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), this.buildingMat, LIMITS.FAR_BUILDINGS);
    this.farTowers.geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(new Float32Array(LIMITS.FAR_BUILDINGS), 1));
    this.farTowers.geometry.setAttribute('aArch', new THREE.InstancedBufferAttribute(new Float32Array(LIMITS.FAR_BUILDINGS), 1));
    this.farTowers.name = 'FarTowers';
    this.hoverTrails = this.createHoverTrails();
    this.persistent.add(this.sky, this.farTowers, this.hoverTrails);

    // ---------------- Instanced details ----------------
    const machinery = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: tex.machinery.map,
      roughness: 1.0,
      roughnessMap: tex.machinery.roughnessMap,
      normalMap: tex.machinery.normalMap,
      metalness: 0.55,
    });
    const carMat = this.createCarMaterial();
    this.cars = ([0, 1, 2] as const).map((v) => {
      const g = this.createCarGeometry(v);
      g.setAttribute('aCar', new THREE.InstancedBufferAttribute(new Float32Array(LIMITS.PARKED_CARS * 4), 4));
      return this.makeInstanced(g, carMat, LIMITS.PARKED_CARS, `ParkedCars_${['Coupe', 'Sedan', 'Van'][v]}`);
    });
    const lampGeo = this.createLampGeometry();
    lampGeo.setAttribute('aTint', new THREE.InstancedBufferAttribute(new Float32Array(CAP.LAMP * 3), 3));
    this.lamps = this.makeInstanced(lampGeo, this.createLampMaterial(), CAP.LAMP, 'StreetLamps');
    const vendGeo = this.createVendingGeometry();
    vendGeo.setAttribute('aTint', new THREE.InstancedBufferAttribute(new Float32Array(CAP.VENDING * 3), 3));
    this.vending = this.makeInstanced(vendGeo, this.createVendingMaterial(), CAP.VENDING, 'VendingKiosks');
    this.guardrails = this.makeInstanced(this.createGuardrailGeometry(), this.steelMat, CAP.GUARDRAIL, 'Guardrails');
    this.acUnits = this.makeInstanced(this.createAcGeometry(), machinery, CAP.AC, 'ACUnits');
    this.ducts = this.makeInstanced(this.createDuctGeometry(), new THREE.MeshStandardMaterial({ color: 0x4a525e, roughness: 0.3, metalness: 0.9 }), CAP.DUCT, 'Ducts');
    this.fences = this.makeInstanced(this.createFenceGeometry(), new THREE.MeshStandardMaterial({ color: 0x3a414d, roughness: 0.38, metalness: 0.88 }), CAP.FENCE, 'RoofFences');
    this.antennas = this.makeInstanced(this.createAntennaGeometry(), this.steelMat, CAP.ANTENNA, 'Antennas');
    this.machineRooms = this.makeInstanced(this.createMachineRoomGeometry(), new THREE.MeshStandardMaterial({ color: 0x232934, roughness: 0.5, metalness: 0.55 }), CAP.MACHINE_ROOM, 'MachineRooms');
    this.aviation = this.createAviationLights();
    this.neonSigns = this.createNeonSigns();
    this.searchlights = this.createSearchlights();
    this.beacons = this.makeInstanced(this.createBeaconGeometry(), this.beaconMat, CAP.BEACON, 'GoldAnchors');
    this.halos = this.createAnchorHalos();
    this.lampHalos = this.createLampHalos();
    this.steam = this.createSteam();
    this.gatePillar = this.createGatePillar();
    this.persistent.add(
      ...this.cars, this.lamps, this.vending, this.guardrails, this.acUnits, this.ducts, this.fences, this.antennas,
      this.machineRooms, this.aviation, this.neonSigns, this.searchlights, this.beacons, this.halos, this.lampHalos, this.steam, this.gatePillar,
    );
  }

  get currentLayout(): SectorLayout | null {
    return this.layout;
  }

  /**
   * CPU mirror of the tower shader's facade mapping (verification / debug): the night-light state of the room
   * at world point (x, y, z) on face (nx, nz) of tower `index`, plus the facade-atlas uv the shader samples.
   */
  facadeProbe(index: number, nx: number, nz: number, x: number, y: number, z: number): { state: number; machine: boolean; floor: number; room: number; u: number; v: number } | null {
    const b = this.towers[index];
    if (!b) return null;
    const F = FACADE;
    const si = seedInt(b.seed);
    const roomW = F.TILE_W_M / roomsPerTile(b.arch);
    const along = Math.abs(nx) > Math.abs(nz) ? -z * Math.sign(nx) : x * Math.sign(nz);
    const alongM = along + roomOffset(si, b.arch) * roomW;
    const room = Math.floor(alongM / roomW);
    const base = F.FLOOR_BASE_M[b.arch];
    const yb = Math.max(y, 0) - base;
    const floor = yb < F.FLOOR_H_M ? 0 : Math.floor(yb / F.FLOOR_H_M);
    const local = yb < F.FLOOR_H_M ? Math.max(y, 0) / (F.FLOOR_H_M + base) : yb / F.FLOOR_H_M - floor;
    const machine = isMachineFloor(si, floor);
    let rowV = local;
    if (floor > 0) {
      const c = F.MACHINE_EVERY_MIN + (Math.floor(si / 16) % F.MACHINE_EVERY_SPAN);
      const off = Math.floor(si / 256) % (c - 2);
      const m = (floor - 1 + off) % c;
      rowV = m === c - 1 ? 1 + local : 2 + ((m + Math.floor((floor - 1 + off) / c) * 5 + (Math.floor(si / 4096) % F.TYPICAL_ROWS)) % F.TYPICAL_ROWS) + local;
    }
    const tiles = alongM / F.TILE_W_M;
    const rowI = Math.floor(rowV);
    return {
      state: machine ? 0 : facadeRoomState(si, faceKey(nx, nz), room, floor),
      machine,
      floor,
      room,
      u: (b.arch + 0.003 + (tiles - Math.floor(tiles)) * 0.994) / F.COLUMNS,
      v: (rowI + 0.012 + (rowV - rowI) * 0.976) / F.ROWS,
    };
  }

  // ===========================================================================================
  // Materials
  // ===========================================================================================
  /**
   * Shared city-light uniforms + world-position varying, injected into a MeshStandardMaterial shader.
   * The world position honours instancing (parked cars, far towers) as well as plain meshes (5B-2).
   * `apply` replaces the default lighting add-on (walls use a height-limited variant).
   */
  private injectCityLights(shader: THREE.WebGLProgramParametersWithUniforms, apply: string = GLSL_CITY_LIGHTS_APPLY): void {
    shader.uniforms.uCityLightPos = this.uCityLightPos;
    shader.uniforms.uCityLightCol = this.uCityLightCol;
    shader.uniforms.uCityLightCount = this.uCityLightCount;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCityWorld;')
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        #ifdef USE_INSTANCING
          vCityWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
        #else
          vCityWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
        #endif`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${GLSL_CITY_LIGHTS}`)
      .replace('#include <opaque_fragment>', apply);
  }

  /** LOW quality skips the per-fragment city lights on tower walls and the interior mapping (STRAND_LITE). */
  setQuality(preset: 'HIGH' | 'MEDIUM' | 'LOW'): void {
    this.uWallLights.value = preset === 'LOW' ? 0 : 1;
    const lite = preset === 'LOW';
    const defs = this.buildingMat.defines as Record<string, string>;
    if (lite !== ('STRAND_LITE' in defs)) {
      if (lite) defs.STRAND_LITE = '';
      else delete defs.STRAND_LITE;
      this.buildingMat.needsUpdate = true;
    }
  }

  /**
   * 6A-1 tower material. Facade atlas with four archetype columns (aArch 0 A glass · 1 B residential ·
   * 2 C industrial · 3 D commercial; +0.25 = plain cladding of a structural add-on), world-space
   * 12 m tiles with a per-tower room offset, a dark mechanical floor every 7–9 storeys and per-room night
   * lighting (integer hash shared with FacadeLighting.ts: dark 65 % · warm 20 % · cool 13 % · accent 2 %).
   * Behind clear glass the view ray is taken into the facade's tangent space and intersected with a room
   * box (depth 0.55 floor units — ceiling panels, back wall, floor, side walls, furniture by archetype), so
   * the rooms shift with real parallax as the player swings past. STRAND_LITE (LOW) keeps the 2D windows.
   * 7A-3: floor 0 (row 0) is the solid street base of every archetype — never a lit room, never interior-mapped.
   */
  private createBuildingMaterial(): THREE.MeshStandardMaterial {
    const f = this.tex.facades;
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: f.map,
      roughness: 1.0,
      roughnessMap: f.roughnessMap,
      metalness: 1.0,
      normalMap: f.normalMap,
      normalScale: new THREE.Vector2(0.8, 0.8),
      emissive: new THREE.Color(0xffffff),
      emissiveMap: f.emissiveMap,
      emissiveIntensity: 1.0,
    });
    const F = FACADE;
    const TW = F.TILE_W_M.toFixed(1);
    const FH = F.FLOOR_H_M.toFixed(1);
    const TEX_H = (F.FLOOR_H_M * F.ROWS).toFixed(1);
    const roofCol = new THREE.Color(COLORS.ROOF_WET);
    const CS = CITY_SHADING;
    const bounce = new THREE.Color(CS.BOUNCE_COLOR);
    const moon = new THREE.Color(CS.MOON_COLOR);
    const v3 = (c: THREE.Color): string => `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
    const hx = (h: number): string => v3(new THREE.Color(h));
    const v2 = (r: readonly number[]): string => `vec2(${r[0].toFixed(3)}, ${r[1].toFixed(3)})`;
    const D = F.INTERIOR_DEPTH.toFixed(3);
    const PMAX = F.PARALLAX_MAX_DIST_M.toFixed(1);
    // 5B-2: walls up to 40 m take the street-lamp / neon city lights; 0–16 m add a violet-magenta street
    // bounce and 40–95 m a cold moonlight lift (vertical gradient); ground contact AO multiplies the albedo.
    const wallApply = /* glsl */ `
      {
        vec3 strandNw = transformNormalByInverseViewMatrix(normal, viewMatrix);
        vec3 strandV = normalize(cameraPosition - vCityWorld);
        if (uWallLights > 0.5 && vStrandY < ${CS.WALL_LIGHT_MAX_Y.toFixed(1)}) {
          outgoingLight += strandCityLights(vCityWorld, strandNw, strandV, diffuseColor.rgb, roughnessFactor, metalnessFactor);
        }
        float side = 1.0 - vTop;
        // 6A-1: dark glass mirrors the violet night-sky glow at grazing angles (Fresnel), never at normal incidence.
        float strandFres = pow(1.0 - clamp(abs(dot(strandNw, strandV)), 0.0, 1.0), 4.0);
        outgoingLight += vec3(0.05, 0.038, 0.1) * strandFres * metalnessFactor * (1.0 - roughnessFactor) * side;
        float low = 1.0 - smoothstep(0.0, ${CS.BOUNCE_TOP_M.toFixed(1)}, vStrandY);
        float high = smoothstep(${CS.MOON_FROM_M.toFixed(1)}, ${CS.MOON_TO_M.toFixed(1)}, vStrandY);
        vec3 lift = (diffuseColor.rgb * 0.6 + vec3(0.032)) * side;
        outgoingLight += lift * (${v3(bounce)} * ${CS.BOUNCE_STRENGTH.toFixed(3)} * low + ${v3(moon)} * ${CS.MOON_STRENGTH.toFixed(3)} * high * (0.4 + 0.6 * max(strandNw.y + 0.6, 0.0)));
      }
      #include <opaque_fragment>
    `;
    const fragCommon = /* glsl */ `
      uniform float uWallLights;
      uniform float uTime;
      varying vec2 vStrandUv;
      varying float vStrandY;
      varying float vTop;
      flat varying float vSeed;
      flat varying float vArch;
      varying vec3 vFaceN;
      ${GLSL_FACADE}
      vec3 strandRoomLight(int st, float h) {
        if (st == 0) return vec3(0.0);
        vec3 c;
        vec2 L;
        if (st == 1) { c = mix(${hx(F.WARM_A)}, ${hx(F.WARM_B)}, h); L = ${v2(F.LUM_WARM)}; }
        else if (st == 2) { c = mix(${hx(F.COOL_A)}, ${hx(F.COOL_B)}, h); L = ${v2(F.LUM_COOL)}; }
        else { c = h < 0.5 ? ${hx(F.ACCENT_CYAN)} : ${hx(F.ACCENT_MAGENTA)}; L = ${v2(F.LUM_ACCENT)}; }
        float target = mix(L.x, L.y, fract(h * 7.31));
        // Fluorescent colour-temperature drift is in the mix above; ~1.5 % of offices flicker faintly.
        if (st == 2 && h > 0.985) target *= 0.72 + 0.28 * step(0.22, fract(uTime * 3.7 + h * 91.0));
        return c * (target / max(dot(c, vec3(0.2126, 0.7152, 0.0722)), 1e-4));
      }
      // Interior mapping: room box x∈[0,1] (room width), y∈[0,1] (floor height), z∈[-D,0] behind the glass.
      vec3 strandInterior(vec2 cell, vec3 d, vec3 light, float h, int col) {
        float D = ${D};
        vec3 p = vec3(cell, 0.0);
        float tx = d.x > 0.0 ? (1.0 - p.x) / d.x : (d.x < 0.0 ? -p.x / d.x : 1e5);
        float ty = d.y > 0.0 ? (1.0 - p.y) / d.y : (d.y < 0.0 ? -p.y / d.y : 1e5);
        float tz = D / max(-d.z, 1e-4);
        vec3 q = p + d * min(min(tx, ty), tz);
        float depth = clamp(-q.z / D, 0.0, 1.0);
        float h2 = fract(h * 13.7);
        float k;
        if (tz <= tx && tz <= ty) {
          k = 0.62 - 0.22 * abs(q.x - 0.5) + 0.12 * q.y;
          if (col == 0) {
            k *= 1.0 - 0.7 * step(q.y, 0.29) * step(0.16, fract(q.x * 2.0 + h));
            k += 1.4 * step(abs(q.y - 0.36), 0.05) * step(abs(fract(q.x * 2.0 + h) - 0.55), 0.12);
            k += 0.5 * step(abs(q.x - 0.25 - 0.5 * h2), 0.14) * step(abs(q.y - 0.55), 0.09);
          } else if (col == 1) {
            k *= 1.0 - 0.6 * step(q.y, 0.2) * step(abs(q.x - 0.5), 0.32);
            k *= 1.0 - 0.45 * step(abs(q.x - 0.3 - 0.4 * h2), 0.09) * step(abs(q.y - 0.5), 0.07);
            vec2 lp = q.xy - vec2(0.12 + 0.76 * step(0.5, h2), 0.3);
            k += 0.9 * exp(-dot(lp, lp) * 60.0);
          } else if (col == 2) {
            float rack = step(0.82, fract(q.x * 4.0 + h)) + step(abs(fract(q.y * 3.0) - 0.5), 0.04) * step(q.y, 0.75);
            k *= 1.0 - 0.55 * clamp(rack, 0.0, 1.0);
          } else {
            k *= 1.0 - 0.6 * step(q.y, 0.24);
            k += 1.6 * step(abs(q.y - 0.7), 0.012);
          }
        } else if (ty <= tx) {
          if (d.y > 0.0) {
            float panel = step(abs(q.x - 0.5), 0.3) * step(abs(fract(depth * 1.6 + 0.2) - 0.5), 0.2);
            k = 0.2 + panel * (col == 1 ? 0.6 : 1.55);
          } else {
            k = 0.34 * (1.0 - 0.35 * depth);
            k *= 1.0 - 0.45 * step(0.45, depth) * step(0.35, fract(q.x * 2.0 + h));
          }
        } else {
          k = 0.44 * (1.0 - 0.4 * depth) + 0.1 * q.y;
          k *= 1.0 - 0.35 * step(q.y, 0.5) * step(0.55, depth) * step(0.5, fract(h * 5.3));
        }
        return vec3(0.0035, 0.0045, 0.007) * (1.6 - depth) + light * k;
      }
    `;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uWallLights = this.uWallLights;
      shader.uniforms.uTime = this.uTime;
      this.injectCityLights(shader, wallApply);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          attribute float aSeed;
          attribute float aArch;
          varying vec2 vStrandUv;
          varying float vStrandY;
          varying float vTop;
          flat varying float vSeed;
          flat varying float vArch;
          varying vec3 vFaceN;`)
        .replace('#include <uv_vertex>', `#include <uv_vertex>
          {
            #ifdef USE_INSTANCING
              mat4 strandWm = modelMatrix * instanceMatrix;
            #else
              mat4 strandWm = modelMatrix;
            #endif
            vec4 strandWp = strandWm * vec4(position, 1.0);
            vec3 strandWn = normalize(mat3(strandWm) * normal);
            vFaceN = strandWn;
            if (abs(strandWn.y) > 0.5) {
              vTop = 1.0;
              vStrandUv = strandWp.xz / ${TW};
            } else {
              vTop = 0.0;
              float along = abs(strandWn.x) > abs(strandWn.z) ? -strandWp.z * sign(strandWn.x) : strandWp.x * sign(strandWn.z);
              float rooms = float(strandRoomsPerTileV(int(aArch)));
              vStrandUv = vec2(along / ${TW} + mod(floor(aSeed * 65536.0), rooms) / rooms, strandWp.y / ${TEX_H});
            }
            vStrandY = strandWp.y;
            vSeed = aSeed;
            vArch = aArch;
            vNormalMapUv = vStrandUv;
          }`)
        .replace('#include <common>', `#include <common>
          int strandRoomsPerTileV(int col) { return col == 2 ? ${F.ROOMS_PER_TILE[2]} : ${F.ROOMS_PER_TILE[0]}; }`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${fragCommon}`)
        .replace('#include <map_fragment>', `
          int sCol = int(vArch);
          // aArch + 0.25: structural add-on (balcony slab, pilaster, shop pillar) — the archetype's plain cladding band.
          bool sPlain = abs(fract(vArch) - 0.25) < 0.05;
          int sSeedI = int(floor(vSeed * 65536.0));
          float sY = max(vStrandY, 0.0);
          float sBase = sCol == 1 ? ${F.FLOOR_BASE_M[1].toFixed(1)} : 0.0;
          float sYb = sY - sBase;
          int sFloor = sYb < ${FH} ? 0 : int(floor(sYb / ${FH}));
          float sLocal = sYb < ${FH} ? sY / (${FH} + sBase) : fract(sYb / ${FH});
          bool sMachine = false;
          float sRowV = sLocal;
          if (sFloor > 0) {
            int c = ${F.MACHINE_EVERY_MIN} + (sSeedI / 16) % ${F.MACHINE_EVERY_SPAN};
            int off = (sSeedI / 256) % (c - 2);
            int m = (sFloor - 1 + off) % c;
            if (m == c - 1) { sMachine = true; sRowV = 1.0 + sLocal; }
            else sRowV = 2.0 + float((m + ((sFloor - 1 + off) / c) * 5 + (sSeedI / 4096) % ${F.TYPICAL_ROWS}) % ${F.TYPICAL_ROWS}) + sLocal;
          }
          if (sPlain) {
            vec2 band = sCol == 0 ? vec2(0.05, 0.6) : (sCol == 1 ? vec2(2.7, 1.25) : (sCol == 2 ? vec2(2.8, 1.15) : vec2(3.52, 0.45)));
            sRowV = 2.0 + (band.x + fract(sY / ${FH}) * band.y) / ${FH};
            sMachine = true;
          }
          float sRowI = floor(sRowV);
          vec2 sWUv = vTop > 0.5 ? vStrandUv
            : vec2((float(sCol) + 0.003 + fract(vStrandUv.x) * 0.994) * ${(1 / F.COLUMNS).toFixed(4)}, (sRowI + 0.012 + (sRowV - sRowI) * 0.976) / ${F.ROWS.toFixed(1)});
          vec2 sWGX = dFdx(vStrandUv) * vec2(${(1 / F.COLUMNS).toFixed(4)}, 1.0);
          vec2 sWGY = dFdy(vStrandUv) * vec2(${(1 / F.COLUMNS).toFixed(4)}, 1.0);
          float sRoomW = ${TW} / float(strandRoomsPerTile(sCol));
          float sAlongM = vStrandUv.x * ${TW};
          int sRoomI = int(floor(sAlongM / sRoomW));
          vec2 sCell = vec2(fract(sAlongM / sRoomW), sLocal);
          int sFace = int(dot(step(vec2(0.5), vFaceN.xz), vec2(1.0, 2.0)) + dot(step(vec2(0.5), -vFaceN.xz), vec2(3.0, 5.0)));
          int sState = 0;
          float sDrift = 0.0;
          if (vTop < 0.5 && !sMachine) {
            sState = strandRoomState(sSeedI, sFace, sRoomI, sFloor);
            sDrift = strandHash(sRoomI + 300000, sFloor + 5000, sSeedI);
          }
          vec3 sRoomLight = strandRoomLight(sState, sDrift);
          diffuseColor *= textureGrad(map, sWUv, sWGX, sWGY);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(${roofCol.r.toFixed(4)}, ${roofCol.g.toFixed(4)}, ${roofCol.b.toFixed(4)}), vTop);
          // Ground contact AO (0 → 2.6 m): the towers sit heavily on the wet street.
          float strandAO = mix(${CS.AO_MIN.toFixed(2)}, 1.0, mix(smoothstep(0.0, ${CS.AO_HEIGHT_M.toFixed(2)}, vStrandY), 1.0, vTop));
          diffuseColor.rgb *= strandAO;`)
        .replace('#include <roughnessmap_fragment>', `
          vec4 sRM = textureGrad(roughnessMap, sWUv, sWGX, sWGY);
          float sMask = sRM.r * (1.0 - vTop);
          float roughnessFactor = mix(roughness * sRM.g, 0.7, vTop);`)
        .replace('#include <metalnessmap_fragment>', `
          float metalnessFactor = mix(metalness * sRM.b, 0.15, vTop);`)
        .replace('#include <normal_fragment_maps>', `
          {
            vec3 mapN = textureGrad(normalMap, sWUv, sWGX, sWGY).xyz * 2.0 - 1.0;
            mapN.xy *= normalScale;
            normal = normalize(tbn * mapN);
          }`)
        .replace('#include <emissivemap_fragment>', `
          {
            vec3 sEm = textureGrad(emissiveMap, sWUv, sWGX, sWGY).rgb;
            float sMx = max(max(sEm.r, sEm.g), sEm.b);
            float sMn = min(min(sEm.r, sEm.g), sEm.b);
            // Neutral grey = room light (tinted per room), saturated = fixed neon (× 0.45, as before).
            float sNeutral = 1.0 - smoothstep(0.08, 0.22, (sMx - sMn) / max(sMx, 1e-3));
            float sPat = dot(sEm, vec3(0.2126, 0.7152, 0.0722));
            vec3 sOut = sEm * (1.0 - sNeutral) * ${MATERIALS.BUILDING_GLASS.emissive.toFixed(2)} + sRoomLight * (sPat * sNeutral);
            #ifndef STRAND_LITE
              if (sMask > 0.01 && !sMachine && sFloor > 0) {
                float sDist = length(cameraPosition - vCityWorld);
                if (sDist < ${PMAX}) {
                  vec3 sN = normalize(vFaceN);
                  vec3 sT = normalize(cross(vec3(0.0, 1.0, 0.0), sN));
                  vec3 sV = (vCityWorld - cameraPosition) / max(sDist, 1e-3);
                  vec3 sD = vec3(dot(sV, sT) / sRoomW, sV.y / ${FH}, dot(sV, sN) / ${FH});
                  vec3 sInt = strandInterior(sCell, sD, sRoomLight, sDrift, sCol);
                  sInt *= 0.3 + 0.7 * smoothstep(0.04, 0.5, abs(dot(sV, sN)));
                  sOut = mix(sOut, sInt, sMask * (1.0 - smoothstep(${PMAX} * 0.7, ${PMAX}, sDist)));
                }
              }
            #endif
            totalEmissiveRadiance = sOut * (1.0 - vTop) * mix(0.72, 1.0, strandAO);
          }`);
    };
    mat.customProgramCacheKey = () => 'strand-building-v16';
    return mat;
  }

  /** Wet concrete (sidewalks, plazas, promenades, rooftops, towpaths): puddle ripples + city lights. */
  private createConcreteMaterial(): THREE.MeshStandardMaterial {
    const r = this.tex.roof;
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: r.map,
      roughness: 1.0,
      roughnessMap: r.roughnessMap,
      metalness: MATERIALS.ROOF_WET.metalness,
      normalMap: r.normalMap,
      normalScale: new THREE.Vector2(0.6, 0.6),
    });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.uTime;
      this.injectCityLights(shader);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nuniform float uTime;\n${GLSL_HASH}\n${GLSL_RIPPLES}`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${GLSL_PUDDLE_RIPPLES}`);
    };
    mat.customProgramCacheKey = () => 'strand-concrete-v11';
    return mat;
  }

  /** Wet road atlas: per-vertex atlas rect + continuous tile UV, sampled with textureGrad(fract()). */
  private createRoadMaterial(): THREE.MeshStandardMaterial {
    const r = this.tex.roads;
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: r.map,
      roughness: 1.0,
      roughnessMap: r.roughnessMap,
      metalness: MATERIALS.ROOF_WET.metalness,
      normalMap: r.normalMap,
      normalScale: new THREE.Vector2(0.7, 0.7),
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.uTime;
      this.injectCityLights(shader);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 aAtlas;\nvarying vec4 vAtlas;\nvarying vec2 vTileUv;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\nvAtlas = aAtlas;\nvTileUv = uv;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nuniform float uTime;\nvarying vec4 vAtlas;\nvarying vec2 vTileUv;\n${GLSL_HASH}\n${GLSL_RIPPLES}`)
        .replace('#include <map_fragment>', `
          vec2 sRSize = vAtlas.zw - vAtlas.xy;
          vec2 sRUv = vAtlas.xy + sRSize * fract(vTileUv);
          vec2 sRGX = dFdx(vTileUv) * sRSize;
          vec2 sRGY = dFdy(vTileUv) * sRSize;
          diffuseColor *= textureGrad(map, sRUv, sRGX, sRGY);`)
        .replace('#include <roughnessmap_fragment>', `
          float roughnessFactor = roughness * textureGrad(roughnessMap, sRUv, sRGX, sRGY).g;`)
        .replace('#include <normal_fragment_maps>', `
          {
            vec3 mapN = textureGrad(normalMap, sRUv, sRGX, sRGY).xyz * 2.0 - 1.0;
            mapN.xy *= normalScale;
            normal = normalize(tbn * mapN);
          }
          ${GLSL_PUDDLE_RIPPLES}`);
    };
    mat.customProgramCacheKey = () => 'strand-road-v11';
    return mat;
  }

  /** Canal water (§6.2-2): slow UV flow + spreading rain-ring normals + Fresnel PBR reflection + city lights. */
  private createWaterMaterial(): THREE.MeshStandardMaterial {
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(COLORS.CANAL_WATER),
      roughness: MATERIALS.CANAL_WATER.roughness,
      metalness: MATERIALS.CANAL_WATER.metalness,
    });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.uTime;
      this.injectCityLights(shader);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 aFlow;\nvarying vec2 vFlow;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\nvFlow = aFlow;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nuniform float uTime;\nvarying vec2 vFlow;\n${GLSL_HASH}\n${GLSL_RIPPLES}`)
        .replace('#include <normal_fragment_maps>', `
          {
            // Flow: scrolling two-octave noise height field differentiated into a normal.
            vec2 p = vCityWorld.xz * 0.32 - vFlow * uTime * 0.45;
            float e = 0.35;
            float h0 = sNoise(p) + 0.5 * sNoise(p * 2.3 + 5.1);
            float hx = sNoise(p + vec2(e, 0.0)) + 0.5 * sNoise((p + vec2(e, 0.0)) * 2.3 + 5.1);
            float hz = sNoise(p + vec2(0.0, e)) + 0.5 * sNoise((p + vec2(0.0, e)) * 2.3 + 5.1);
            vec2 flowGrad = vec2(hx - h0, hz - h0) * 0.55;
            vec2 rip = strandRipples(vCityWorld.xz * 1.6, uTime) * 0.42 + strandRipples(vCityWorld.xz * 2.9 + 3.0, uTime * 1.3) * 0.25;
            vec3 nW = normalize(vec3(-(flowGrad.x + rip.x), 1.0, -(flowGrad.y + rip.y)));
            normal = normalize(mat3(viewMatrix) * nW);
          }`);
    };
    mat.customProgramCacheKey = () => 'strand-water-v11';
    return mat;
  }

  /** Expressway / bridge / canal-wall / pier concrete (#1A202C, R 0.48, M 0.30) + city lights. */
  private createHighwayConcreteMaterial(): THREE.MeshStandardMaterial {
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(COLORS.HIGHWAY_CONCRETE),
      roughness: MATERIALS.HIGHWAY_CONCRETE.roughness,
      metalness: MATERIALS.HIGHWAY_CONCRETE.metalness,
      normalMap: this.tex.roof.normalMap,
      normalScale: new THREE.Vector2(0.45, 0.45),
    });
    mat.onBeforeCompile = (shader) => this.injectCityLights(shader);
    mat.customProgramCacheKey = () => 'strand-hwconcrete-v11';
    return mat;
  }

  /** Gold anchor beacons: spin around Y in the vertex shader (no CPU matrix updates). */
  private createBeaconMaterial(): THREE.MeshStandardMaterial {
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(COLORS.GRAPPLE_GOLD),
      roughness: MATERIALS.GRAPPLE_ANCHOR.roughness,
      metalness: MATERIALS.GRAPPLE_ANCHOR.metalness,
      emissive: new THREE.Color(COLORS.GRAPPLE_GOLD),
      emissiveIntensity: MATERIALS.GRAPPLE_ANCHOR.emissive,
    });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.uTime;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          uniform float uTime;
          mat3 strandRotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }`)
        .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nobjectNormal = strandRotY(uTime * 1.6) * objectNormal;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed = strandRotY(uTime * 1.6) * transformed;');
    };
    mat.customProgramCacheKey = () => 'strand-beacon-v1';
    return mat;
  }

  /**
   * Parked cyber-car material (#171D28, R 0.22, M 0.78). Per-vertex aPart: 0 body · 1 glass · 2 front LED ·
   * 3 rear LED · 4 tyres/trim. Per-instance aCar: (frontCyan 0|1, LED intensity 2.2–2.8, hazard 0|1, phase).
   */
  private createCarMaterial(): THREE.MeshStandardMaterial {
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(COLORS.CAR_BODY),
      roughness: MATERIALS.CAR_BODY.roughness,
      metalness: MATERIALS.CAR_BODY.metalness,
      emissive: new THREE.Color(0xffffff),
    });
    const v3 = (hex: number): string => {
      const c = new THREE.Color(hex);
      return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
    };
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.uTime;
      // 5B-2: lamps and neon light up the bodywork (instanced world position).
      this.injectCityLights(shader);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aPart;\nattribute vec4 aCar;\nvarying float vPart;\nvarying vec4 vCar;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\nvPart = aPart;\nvCar = aCar;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;\nvarying float vPart;\nvarying vec4 vCar;')
        .replace('#include <map_fragment>', `#include <map_fragment>
          float sPart = floor(vPart + 0.5);
          if (sPart == 1.0) diffuseColor.rgb = vec3(0.006, 0.008, 0.012);
          else if (sPart == 4.0) diffuseColor.rgb = vec3(0.012, 0.012, 0.014);
          else if (sPart >= 2.0) diffuseColor.rgb = vec3(0.05);`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          if (sPart == 1.0) roughnessFactor = 0.05;
          else if (sPart == 4.0) roughnessFactor = 0.78;`)
        .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
          if (sPart == 1.0) metalnessFactor = 0.9;
          else if (sPart == 4.0) metalnessFactor = 0.1;`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          {
            float blink = step(0.5, fract(uTime * 1.5 + vCar.w));
            vec3 led = vec3(0.0);
            if (sPart == 2.0) led = vCar.z > 0.5 ? ${v3(COLORS.CAR_HAZARD)} * blink : mix(${v3(COLORS.CAR_LED_WHITE)}, ${v3(COLORS.CAR_LED_CYAN)}, vCar.x);
            else if (sPart == 3.0) led = ${v3(COLORS.CAR_LED_REAR)} * (vCar.z > 0.5 ? (0.25 + 0.75 * blink) : 1.0);
            totalEmissiveRadiance = led * vCar.y;
          }`);
    };
    mat.customProgramCacheKey = () => 'strand-car-v12';
    return mat;
  }

  /** Neon street lamps: aPart 1 = lamp head (cool white), 2 = neon accent ring (per-instance tint). */
  private createLampMaterial(): THREE.MeshStandardMaterial {
    const mat = new THREE.MeshStandardMaterial({ color: 0x252a33, roughness: 0.4, metalness: 0.85, emissive: new THREE.Color(0xffffff) });
    const lamp = new THREE.Color(COLORS.STREET_LAMP);
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aPart;\nattribute vec3 aTint;\nvarying float vPart;\nvarying vec3 vTint;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\nvPart = aPart;\nvTint = aTint;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vPart;\nvarying vec3 vTint;')
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          {
            float p = floor(vPart + 0.5);
            // 5B-1: lamp head 1.45 / neon ring 1.30 — point accents bloom (wide window walls stay ≤ 0.28).
            totalEmissiveRadiance = p == 1.0 ? vec3(${lamp.r.toFixed(3)}, ${lamp.g.toFixed(3)}, ${lamp.b.toFixed(3)}) * ${NEON_BLOOM.LAMP_HEAD.toFixed(2)} : (p == 2.0 ? vTint * ${NEON_BLOOM.LAMP_RING.toFixed(2)} : vec3(0.0));
          }`);
    };
    mat.customProgramCacheKey = () => 'strand-lamp-v12';
    return mat;
  }

  /** Vending machines / kiosks: aPart 1 = lit front panel, 2 = top sign (per-instance tint). */
  private createVendingMaterial(): THREE.MeshStandardMaterial {
    const mat = new THREE.MeshStandardMaterial({ color: 0x1c2230, roughness: 0.3, metalness: 0.6, emissive: new THREE.Color(0xffffff) });
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aPart;\nattribute vec3 aTint;\nvarying float vPart;\nvarying vec3 vTint;\nvarying vec2 vVUv;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\nvPart = aPart;\nvTint = aTint;\nvVUv = uv;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vPart;\nvarying vec3 vTint;\nvarying vec2 vVUv;')
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          {
            float p = floor(vPart + 0.5);
            // Product rows on the panel: bright slots in a 4 × 6 grid.
            float slots = step(0.18, fract(vVUv.x * 4.0)) * step(0.25, fract(vVUv.y * 6.0)) * step(0.35, vVUv.y);
            vec3 panel = mix(vTint * 0.35, vec3(0.85), slots * 0.55);
            totalEmissiveRadiance = p == 1.0 ? panel : (p == 2.0 ? vTint * 0.85 : vec3(0.0));
          }`);
    };
    mat.customProgramCacheKey = () => 'strand-vending-v11';
    return mat;
  }

  /** Lockdown barrier: aKind 0 faint hex wall (near the camera only), 1 street blockade, 2 district gate. */
  private createBarrierMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: {
        uTime: this.uTime,
        uGateOpen: this.uGateOpen,
        uRed: { value: new THREE.Color(COLORS.BARRIER_RED) },
        uAmber: { value: new THREE.Color(COLORS.SHIELD_AMBER) },
        uJade: { value: new THREE.Color(COLORS.GATE_JADE) },
        uCyan: { value: new THREE.Color(COLORS.WALLRUN_CYAN) },
        uJadeI: { value: MATERIALS.GATE_JADE.emissive },
        uFogDensity: this.uFogDensity,
      },
      vertexShader: /* glsl */ `
        attribute float aKind;
        varying float vKind; varying vec3 vWorld; varying vec2 vUv; varying vec3 vN;
        void main() {
          vKind = aKind;
          vUv = uv;
          vN = normal;
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform float uGateOpen; uniform vec3 uRed; uniform vec3 uAmber; uniform vec3 uJade; uniform vec3 uCyan;
        uniform float uJadeI; uniform float uFogDensity;
        varying float vKind; varying vec3 vWorld; varying vec2 vUv; varying vec3 vN;
        ${GLSL_FOG_FADE}
        float hexLine(vec2 p) {
          vec2 h = vec2(1.0, 1.7320508);
          vec2 a = mod(p, h) - h * 0.5;
          vec2 b = mod(p - h * 0.5, h) - h * 0.5;
          vec2 g = dot(a, a) < dot(b, b) ? a : b;
          float hd = max(dot(abs(g), vec2(0.5, 0.8660254)), abs(g.x));
          return smoothstep(0.44, 0.5, hd);
        }
        void main() {
          float along = abs(vN.x) > 0.5 ? vWorld.z : vWorld.x;
          float hex = hexLine(vec2(along, vWorld.y) / 1.6);
          float dist = length(vWorld - cameraPosition);
          float scan = 0.65 + 0.35 * sin(vWorld.y * 1.4 - uTime * 3.0);
          float k = floor(vKind + 0.5);
          vec3 c;
          if (k < 0.5) {
            // Faint wall: only reveals itself near the player.
            float near = 1.0 - smoothstep(10.0, 34.0, dist);
            c = uCyan * (hex * 0.55 + 0.03) * near * scan * (1.0 - smoothstep(6.0, 40.0, vWorld.y - cameraPosition.y));
          } else {
            float frame = max(smoothstep(0.03, 0.0, min(vUv.x, 1.0 - vUv.x)), smoothstep(0.04, 0.0, 1.0 - vUv.y));
            float stripes = step(0.5, fract((along + vWorld.y) * 0.35 - uTime * 0.8));
            float topFade = 1.0 - smoothstep(0.55, 1.0, vUv.y);
            vec3 locked = uRed * (hex * 0.9 + 0.12 + frame * 1.6) * scan + uAmber * stripes * 0.18 * topFade;
            if (k > 1.5) {
              float chev = step(0.5, fract(vWorld.y * 0.25 - abs(vUv.x - 0.5) * 2.0 - uTime * 1.2));
              vec3 open = uJade * (frame * uJadeI + hex * 0.35 + chev * 0.25 * topFade);
              c = mix(locked, open, uGateOpen);
            } else {
              c = locked;
            }
            c *= strandFogFade(dist, uFogDensity * 0.6);
          }
          gl_FragColor = vec4(c, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
  }

  // ===========================================================================================
  // Persistent backdrop
  // ===========================================================================================
  private createSky(): THREE.Mesh {
    const geo = new THREE.SphereGeometry(2400, 64, 32);
    const moonDir = new THREE.Vector3(-0.45, 0.62, -0.64).normalize();
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uZenith: { value: new THREE.Color(COLORS.SKY_ZENITH) },
        uHorizon: { value: new THREE.Color(COLORS.FOG_ABYSS) },
        uMoonDir: { value: moonDir },
        uMoonColor: { value: new THREE.Color(COLORS.MOON) },
        uTime: this.uTime,
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uZenith; uniform vec3 uHorizon; uniform vec3 uMoonDir; uniform vec3 uMoonColor; uniform float uTime;
        varying vec3 vDir;
        ${GLSL_HASH}
        void main() {
          vec3 d = normalize(vDir);
          float y = d.y;
          // At / below the horizon = exact fog colour so fogged towers dissolve seamlessly.
          vec3 col = mix(uHorizon, uZenith, smoothstep(0.0, 0.42, y));
          // City light pollution: magenta / violet haze above the skyline.
          col += vec3(0.022, 0.009, 0.036) * exp(-max(y, 0.0) * 7.0) * smoothstep(-0.06, 0.05, y);
          // Storm-cloud streaks lit from below.
          vec2 cp = d.xz / max(y + 0.15, 0.05) * 1.6 + vec2(uTime * 0.004, uTime * 0.002);
          float cloud = smoothstep(0.55, 0.85, sNoise(cp) * 0.65 + sNoise(cp * 2.7) * 0.35);
          col = mix(col, vec3(0.02, 0.015, 0.032), cloud * smoothstep(0.02, 0.25, y) * 0.8);
          vec2 sp = vec2(atan(d.z, d.x) * 180.0, y * 260.0);
          float star = step(0.9965, sHash12(floor(sp))) * smoothstep(0.12, 0.5, y) * (1.0 - cloud);
          col += vec3(0.16, 0.18, 0.24) * star * (0.6 + 0.4 * sin(uTime * 3.0 + sHash12(floor(sp)) * 40.0));
          float md = dot(d, normalize(uMoonDir));
          col += uMoonColor * smoothstep(0.99935, 0.9996, md) * 0.9;
          col += uMoonColor * pow(max(md, 0.0), 220.0) * 0.12 + uMoonColor * pow(max(md, 0.0), 18.0) * 0.015;
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'SkyDome';
    mesh.frustumCulled = false;
    mesh.renderOrder = -10;
    return mesh;
  }

  /** 40 red / white hover-car light trails threading the far skyline (animated fully on the GPU). */
  private createHoverTrails(): THREE.InstancedMesh {
    const n = LIMITS.HOVER_TRAILS;
    const geo = new THREE.PlaneGeometry(1, 1);
    const a = new Float32Array(n * 4);
    const b = new Float32Array(n * 4);
    const c = new Float32Array(n * 4);
    const rng = createRng(0x40e7);
    for (let i = 0; i < n; i++) {
      const ang = rng() * Math.PI * 2;
      const r = 230 + rng() * 300;
      const tangent = ang + Math.PI / 2 + (rng() - 0.5) * 0.6;
      const len = 320 + rng() * 260;
      const sx = Math.cos(ang) * r - Math.cos(tangent) * len * 0.5;
      const sz = Math.sin(ang) * r - Math.sin(tangent) * len * 0.5;
      const y = 35 + rng() * 150;
      a.set([sx, y, sz, rng()], i * 4);
      b.set([Math.cos(tangent), (rng() - 0.5) * 0.04, Math.sin(tangent), 28 + rng() * 34], i * 4);
      c.set([len, 22 + rng() * 26, rng() < 0.55 ? 0 : 1, 0.45 + rng() * 0.35], i * 4);
    }
    geo.setAttribute('aA', new THREE.InstancedBufferAttribute(a, 4));
    geo.setAttribute('aB', new THREE.InstancedBufferAttribute(b, 4));
    geo.setAttribute('aC', new THREE.InstancedBufferAttribute(c, 4));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: { uTime: this.uTime, uFogDensity: this.uFogDensity },
      vertexShader: /* glsl */ `
        attribute vec4 aA; attribute vec4 aB; attribute vec4 aC;
        uniform float uTime;
        varying float vAlong; varying float vAcross; varying float vSel; varying float vFade; varying float vDist;
        void main() {
          vec3 dir = normalize(aB.xyz);
          float s = fract(aA.w + uTime * aB.w / aC.x);
          vec3 head = aA.xyz + dir * s * aC.x;
          vec3 p = head - dir * (0.5 - position.y) * aC.y;
          vec3 toCam = normalize(cameraPosition - p);
          vec3 side = normalize(cross(dir, toCam));
          p += side * position.x * aC.w;
          vAlong = position.y + 0.5;
          vAcross = position.x * 2.0;
          vSel = aC.z;
          vFade = smoothstep(0.0, 0.08, s) * (1.0 - smoothstep(0.9, 1.0, s));
          vDist = length(p - cameraPosition);
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uFogDensity;
        varying float vAlong; varying float vAcross; varying float vSel; varying float vFade; varying float vDist;
        ${GLSL_FOG_FADE}
        void main() {
          float core = 1.0 - abs(vAcross);
          float a = core * core * pow(vAlong, 1.6) * vFade * strandFogFade(vDist, uFogDensity * 0.45);
          vec3 c = mix(vec3(1.0, 0.1, 0.16), vec3(1.0, 0.95, 0.88), vSel) * ${NEON_BLOOM.HOVER_TRAIL.toFixed(2)};
          gl_FragColor = vec4(c * a, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    const m = new THREE.InstancedMesh(geo, mat, n);
    m.name = 'HoverCarTrails';
    m.frustumCulled = false;
    m.renderOrder = 4;
    return m;
  }

  // ===========================================================================================
  // Instanced detail geometry
  // ===========================================================================================
  private makeInstanced(geo: THREE.BufferGeometry, mat: THREE.Material, cap: number, name: string): THREE.InstancedMesh {
    const m = new THREE.InstancedMesh(geo, mat, cap);
    m.count = 0;
    m.name = name;
    m.frustumCulled = false;
    return m;
  }

  /**
   * Cyber-car variants (side profiles extruded across the width, forward = +Z):
   * 0 wedge coupe (≈4.5 × 1.2 m), 1 sedan (≈4.6 × 1.4 m), 2 van (≈4.8 × 1.95 m).
   */
  private createCarGeometry(variant: 0 | 1 | 2): THREE.BufferGeometry {
    const profiles: Array<{ body: number[][]; glass: number[][]; roof?: number[][]; len: number; width: number; ledF: number; ledR: number }> = [
      {
        body: [[2.25, 0.3], [2.25, 0.5], [2.0, 0.62], [0.6, 0.86], [-1.8, 0.92], [-2.25, 0.85], [-2.25, 0.3]],
        glass: [[0.6, 0.86], [-0.25, 1.18], [-1.45, 1.14], [-1.85, 0.92]],
        len: 4.5, width: 1.95, ledF: 0.52, ledR: 0.8,
      },
      {
        body: [[2.3, 0.3], [2.3, 0.62], [1.6, 0.78], [0.8, 0.82], [-1.6, 0.86], [-2.3, 0.82], [-2.3, 0.3]],
        glass: [[0.8, 0.82], [0.05, 1.38], [-1.2, 1.4], [-1.75, 0.86]],
        len: 4.6, width: 1.95, ledF: 0.6, ledR: 0.74,
      },
      {
        body: [[2.4, 0.32], [2.4, 1.0], [1.75, 1.12], [-2.4, 1.12], [-2.4, 0.32]],
        glass: [[1.75, 1.12], [1.2, 1.62], [-2.35, 1.62], [-2.4, 1.12]],
        roof: [[1.2, 1.62], [1.05, 1.92], [-2.35, 1.94], [-2.35, 1.62]],
        len: 4.8, width: 2.0, ledF: 0.85, ledR: 1.0,
      },
    ];
    const p = profiles[variant];
    const part = (g: THREE.BufferGeometry, id: number): THREE.BufferGeometry => withAttr1(stripUv(g.index ? g.toNonIndexed() : g), 'aPart', id);
    const extrude = (pts: number[][], width: number, id: number): THREE.BufferGeometry => {
      const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
      const g = new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.03, bevelSegments: 2, curveSegments: 1 });
      g.translate(0, 0, -width / 2);
      g.rotateY(-Math.PI / 2);
      return part(g, id);
    };
    const parts: THREE.BufferGeometry[] = [];
    parts.push(extrude(p.body, p.width - 0.08, 0));
    parts.push(extrude(p.glass, p.width - 0.3, 1));
    if (p.roof) parts.push(extrude(p.roof, p.width - 0.3, 0));
    parts.push(part(boxAt(p.width - 0.25, 0.07, 0.06, 0, p.ledF, p.len / 2 + 0.02), 2));
    parts.push(part(boxAt(p.width - 0.2, 0.08, 0.06, 0, p.ledR, -p.len / 2 - 0.02), 3));
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const w = new THREE.CylinderGeometry(0.34, 0.34, 0.26, 14);
        w.rotateZ(Math.PI / 2);
        w.translate(sx * (p.width / 2 - 0.12), 0.34, sz * (p.len / 2 - 0.85));
        parts.push(part(w, 4));
      }
    }
    const merged = mergeOrEmpty(parts);
    merged.computeBoundingSphere();
    return merged;
  }

  private createLampGeometry(): THREE.BufferGeometry {
    // Pole along +Y, arm reaching +Z over the road, head at the arm tip, neon accent ring on the pole.
    const parts: THREE.BufferGeometry[] = [];
    const add = (g: THREE.BufferGeometry, id: number): void => {
      parts.push(withAttr1(stripUv(g.index ? g.toNonIndexed() : g), 'aPart', id));
    };
    const pole = new THREE.CylinderGeometry(0.09, 0.13, 6.6, 10);
    pole.translate(0, 3.3, 0);
    add(pole, 0);
    add(boxAt(0.1, 0.1, 2.0, 0, 6.5, 1.0), 0);
    add(boxAt(0.42, 0.14, 0.95, 0, 6.42, 2.05), 0);
    add(boxAt(0.34, 0.03, 0.82, 0, 6.34, 2.05), 1);
    const ring = new THREE.TorusGeometry(0.16, 0.035, 6, 18);
    ring.rotateX(Math.PI / 2);
    ring.translate(0, 3.2, 0);
    add(ring, 2);
    add(boxAt(0.36, 0.25, 0.36, 0, 0.125, 0), 0);
    return mergeOrEmpty(parts);
  }

  private createVendingGeometry(): THREE.BufferGeometry {
    // 1.0 × 1.9 × 0.8 machine facing +Z; front panel and top sign glow.
    const parts: THREE.BufferGeometry[] = [];
    const add = (g: THREE.BufferGeometry, id: number): void => {
      parts.push(withAttr1(g.index ? g.toNonIndexed() : g, 'aPart', id));
    };
    add(boxAt(1.0, 1.9, 0.8, 0, 0.95, 0), 0);
    const panel = new THREE.PlaneGeometry(0.82, 1.35);
    panel.translate(0, 1.05, 0.405);
    add(panel, 1);
    const sign = new THREE.PlaneGeometry(0.9, 0.22);
    sign.translate(0, 1.79, 0.405);
    add(sign, 2);
    return mergeOrEmpty(parts);
  }

  private createGuardrailGeometry(): THREE.BufferGeometry {
    // 3 m W-beam segment along X with two posts (1.0 m tall).
    return mergeOrEmpty([
      boxAt(0.1, 1.0, 0.1, -1.45, 0.5, 0),
      boxAt(0.1, 1.0, 0.1, 1.45, 0.5, 0),
      boxAt(3.0, 0.32, 0.06, 0, 0.78, 0.07),
      boxAt(3.0, 0.06, 0.08, 0, 0.98, 0.04),
    ].map(stripUv));
  }

  private createAcGeometry(): THREE.BufferGeometry {
    const body = new THREE.BoxGeometry(2.2, 1.3, 1.2);
    body.translate(0, 0.65 + 0.12, 0);
    return mergeOrEmpty([body, boxAt(2.0, 0.12, 1.0, 0, 0.06, 0)]);
  }

  private createDuctGeometry(): THREE.BufferGeometry {
    const pipe = new THREE.CylinderGeometry(0.45, 0.45, 1, 16, 1, false);
    pipe.rotateZ(Math.PI / 2);
    pipe.translate(0, 1.05, 0);
    return mergeOrEmpty([pipe, boxAt(0.12, 0.6, 0.8, -0.38, 0.3, 0), boxAt(0.12, 0.6, 0.8, 0.38, 0.3, 0)]);
  }

  private createFenceGeometry(): THREE.BufferGeometry {
    const parts: THREE.BufferGeometry[] = [];
    parts.push(boxAt(0.08, 1.2, 0.08, -1.5, 0.6, 0), boxAt(0.08, 1.2, 0.08, 1.5, 0.6, 0));
    parts.push(boxAt(3.0, 0.06, 0.06, 0, 1.17, 0), boxAt(3.0, 0.05, 0.05, 0, 0.12, 0), boxAt(3.0, 0.04, 0.04, 0, 0.64, 0));
    for (let i = 1; i < 15; i++) parts.push(boxAt(0.025, 1.08, 0.025, -1.5 + i * 0.2, 0.62, 0));
    return mergeOrEmpty(parts);
  }

  private createAntennaGeometry(): THREE.BufferGeometry {
    return mergeOrEmpty([
      boxAt(0.14, 1.0, 0.14, 0, 0.5, 0),
      boxAt(0.9, 0.02, 0.04, 0, 0.72, 0),
      boxAt(0.04, 0.02, 0.9, 0, 0.82, 0),
      boxAt(0.6, 0.02, 0.04, 0, 0.92, 0),
      boxAt(0.7, 0.04, 0.7, 0, 0.02, 0),
    ]);
  }

  private createMachineRoomGeometry(): THREE.BufferGeometry {
    return mergeOrEmpty([boxAt(1, 1, 1, 0, 0.5, 0), boxAt(1.06, 0.06, 1.06, 0, 1.0, 0)]);
  }

  private createBeaconGeometry(): THREE.BufferGeometry {
    const core = new THREE.OctahedronGeometry(0.42, 0);
    core.deleteAttribute('uv');
    const ring = new THREE.TorusGeometry(0.62, 0.05, 6, 24);
    ring.deleteAttribute('uv');
    ring.rotateX(Math.PI / 2);
    const merged = mergeOrEmpty([core, ring.toNonIndexed()]);
    merged.computeVertexNormals();
    return merged;
  }

  private createAviationLights(): THREE.InstancedMesh {
    const geo = new THREE.SphereGeometry(0.2, 10, 6);
    geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(new Float32Array(CAP.AVIATION), 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: this.uTime,
        uColor: { value: new THREE.Color(COLORS.AVIATION_RED) },
        uHz: { value: RENDER.AVIATION_BLINK_HZ },
        uFogDensity: this.uFogDensity,
      },
      vertexShader: /* glsl */ `
        attribute float aPhase;
        varying float vPhase;
        varying float vDist;
        void main() {
          vPhase = aPhase;
          vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
          vDist = length(wp.xyz - cameraPosition);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform vec3 uColor; uniform float uHz; uniform float uFogDensity;
        varying float vPhase; varying float vDist;
        ${GLSL_FOG_FADE}
        void main() {
          float cyc = fract(uTime * uHz + vPhase);
          float on = smoothstep(0.0, 0.04, cyc) * (1.0 - smoothstep(0.32, 0.4, cyc));
          // 5B-1: blinking peak 1.60 blooms into a red halo; the dim idle level stays background.
          vec3 c = uColor * (0.06 + ${(NEON_BLOOM.AVIATION_PEAK - 0.06).toFixed(2)} * on);
          gl_FragColor = vec4(c * strandFogFade(vDist, uFogDensity * 0.55), 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    const m = new THREE.InstancedMesh(geo, mat, CAP.AVIATION);
    m.count = 0;
    m.frustumCulled = false;
    m.name = 'AviationLights';
    return m;
  }

  private createNeonSigns(): THREE.InstancedMesh {
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.setAttribute('aStrip', new THREE.InstancedBufferAttribute(new Float32Array(CAP.NEON), 1));
    geo.setAttribute('aFormat', new THREE.InstancedBufferAttribute(new Float32Array(CAP.NEON), 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uTime: this.uTime,
        uAtlas: { value: this.tex.neonAtlas },
        uSigns: { value: this.tex.signAtlas },
        uStrips: { value: this.tex.neonAtlasStrips },
        uBoost: this.uNeonBoost,
        uFogDensity: this.uFogDensity,
      },
      vertexShader: /* glsl */ `
        attribute float aStrip;
        attribute float aFormat;
        varying vec2 vUv;
        varying float vStrip;
        varying float vFormat;
        varying float vDist;
        void main() {
          vUv = uv;
          vStrip = aStrip;
          vFormat = aFormat;
          vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
          vDist = length(wp.xyz - cameraPosition);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform sampler2D uAtlas; uniform sampler2D uSigns; uniform float uStrips; uniform float uBoost; uniform float uFogDensity;
        varying vec2 vUv; varying float vStrip; varying float vFormat; varying float vDist;
        ${GLSL_FOG_FADE}
        float h11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
        void main() {
          float strip = floor(vStrip + 0.5);
          float fmt = floor(vFormat + 0.5);
          float tearRow = floor(vUv.y * 48.0);
          float tear = step(0.985, h11(tearRow + floor(uTime * 12.0) * 7.0 + strip * 3.0)) * 0.03;
          vec4 t;
          if (fmt < 0.5) {
            // 1) Vertical blade sign (katakana strips).
            vec2 auv = vec2((strip + clamp(vUv.x + tear, 0.0, 1.0)) / uStrips, vUv.y);
            t = texture2D(uAtlas, auv);
          } else if (fmt < 1.5) {
            // 2) Wide banner (1F facades, expressway sides, bridge girders); rows 6–7 scroll like LED tickers.
            float row = mod(strip, ${SIGN_ATLAS.WIDE_ROWS.toFixed(1)});
            float u = row > 5.5 ? vUv.x * 2.0 + uTime * 0.18 * (row > 6.5 ? -1.0 : 1.0) : vUv.x;
            vec2 auv = vec2(u, 1.0 - (row + 1.0 - clamp(vUv.y, 0.04, 0.96)) / 16.0);
            vec2 g = vec2(row > 5.5 ? 2.0 : 1.0, 1.0 / 16.0);
            t = textureGrad(uSigns, auv, dFdx(vUv) * g, dFdy(vUv) * g);
          } else {
            // 3) Corporate emblem / geometric hologram (rings, hexagon logo, warning, barcode, waveform …).
            float cellI = mod(strip, ${SIGN_ATLAS.EMBLEMS.toFixed(1)});
            float cx = mod(cellI, 4.0);
            float cy = floor(cellI / 4.0);
            vec2 q = clamp(vUv, 0.02, 0.98);
            vec2 auv = vec2((cx + q.x) / 4.0, 0.5 - (cy + 1.0 - q.y) * 0.25);
            t = texture2D(uSigns, auv);
            t.rgb *= 0.85 + 0.15 * sin(uTime * 2.0 + strip);
          }
          float fl = h11(floor(uTime * 9.0) + strip * 17.0);
          float flicker = fl < 0.04 ? 0.25 : 1.0;
          float scan = 0.82 + 0.18 * sin(vUv.y * 420.0 - uTime * 6.0);
          // 5B-1: base 1.38 so the tubes bleed into bloom — FLOW A+ boosts a further +25 %.
          vec3 c = t.rgb * ${NEON_BLOOM.SIGN.toFixed(2)} * scan * flicker * uBoost;
          float f = strandFogFade(vDist, uFogDensity * 0.7);
          gl_FragColor = vec4(c * f, t.a * mix(0.35, 1.0, f));
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    const m = new THREE.InstancedMesh(geo, mat, CAP.NEON);
    m.count = 0;
    m.frustumCulled = false;
    m.name = 'NeonSigns';
    return m;
  }

  /** Additive translucent cones; sweep animated entirely in the vertex shader. */
  private createSearchlights(): THREE.InstancedMesh {
    const length = 170;
    const geo = new THREE.CylinderGeometry(0.35, 9, length, 24, 1, true);
    geo.translate(0, length / 2, 0);
    geo.setAttribute('aBase', new THREE.InstancedBufferAttribute(new Float32Array(CAP.SEARCH * 3), 3));
    geo.setAttribute('aParams', new THREE.InstancedBufferAttribute(new Float32Array(CAP.SEARCH * 4), 4));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: {
        uTime: this.uTime,
        uLength: { value: length },
        uPulse: this.uSearchPulse,
        uColor: { value: new THREE.Color(0x9fd8ff) },
        uFogDensity: this.uFogDensity,
      },
      vertexShader: /* glsl */ `
        attribute vec3 aBase;
        attribute vec4 aParams;
        uniform float uTime; uniform float uLength;
        varying float vAlong; varying float vEdge; varying float vDist;
        void main() {
          float yaw = aParams.x + sin(uTime * aParams.y + aParams.x) * aParams.z;
          float tilt = aParams.w + sin(uTime * aParams.y * 0.73 + aParams.x * 2.0) * 0.16;
          float ct = cos(tilt), st = sin(tilt), cy = cos(yaw), sy = sin(yaw);
          mat3 rz = mat3(ct, st, 0.0, -st, ct, 0.0, 0.0, 0.0, 1.0);
          mat3 ry = mat3(cy, 0.0, -sy, 0.0, 1.0, 0.0, sy, 0.0, cy);
          mat3 r = ry * rz;
          vec3 wp = aBase + r * position;
          vec3 wn = normalize(r * normal);
          vEdge = abs(dot(wn, normalize(cameraPosition - wp)));
          vAlong = position.y / uLength;
          vDist = length(wp - cameraPosition);
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; uniform float uPulse; uniform float uFogDensity;
        varying float vAlong; varying float vEdge; varying float vDist;
        ${GLSL_FOG_FADE}
        void main() {
          float core = pow(vEdge, 2.2);
          float falloff = pow(1.0 - clamp(vAlong, 0.0, 1.0), 1.7);
          float a = core * falloff * 0.16 * (1.0 + uPulse * 0.9);
          gl_FragColor = vec4(uColor * a * strandFogFade(vDist, uFogDensity * 0.45), 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    const m = new THREE.InstancedMesh(geo, mat, CAP.SEARCH);
    m.count = 0;
    m.frustumCulled = false;
    m.name = 'Searchlights';
    m.renderOrder = 5;
    return m;
  }

  private createAnchorHalos(): THREE.InstancedMesh {
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: this.uTime, uColor: { value: new THREE.Color(COLORS.GRAPPLE_GOLD) }, uFogDensity: this.uFogDensity },
      vertexShader: /* glsl */ `
        varying vec2 vUv; varying float vDist; varying float vSeed;
        void main() {
          vUv = uv;
          vec3 center = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          vSeed = fract(center.x * 0.173 + center.z * 0.311);
          vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
          vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
          vec3 wp = center + (right * position.x + up * position.y) * 3.2;
          vDist = length(center - cameraPosition);
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform vec3 uColor; uniform float uFogDensity;
        varying vec2 vUv; varying float vDist; varying float vSeed;
        ${GLSL_FOG_FADE}
        void main() {
          float r = length(vUv - 0.5) * 2.0;
          float pulse = fract(uTime * 0.8 + vSeed);
          float ring = smoothstep(0.06, 0.0, abs(r - pulse)) * (1.0 - pulse);
          float glow = exp(-r * 5.5) * 0.9;
          float a = (glow + ring * 1.4) * strandFogFade(vDist, uFogDensity * 0.35);
          gl_FragColor = vec4(uColor * a * 1.6, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    const m = new THREE.InstancedMesh(geo, mat, CAP.BEACON);
    m.count = 0;
    m.frustumCulled = false;
    m.name = 'AnchorHalos';
    m.renderOrder = 6;
    return m;
  }

  /**
   * 5B-1 lamp halo: camera-facing soft disc (radius 2.2 m) at each lamp head, alpha 0.28 · exp(−r² · 3.5),
   * additive — the light scattering in the wet night air.
   */
  private createLampHalos(): THREE.InstancedMesh {
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uColor: { value: new THREE.Color(COLORS.STREET_LAMP) }, uFogDensity: this.uFogDensity },
      vertexShader: /* glsl */ `
        varying vec2 vUv; varying float vDist;
        void main() {
          vUv = uv;
          vec3 center = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
          vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
          vec3 wp = center + (right * position.x + up * position.y) * ${(NEON_BLOOM.LAMP_HALO_RADIUS_M * 2).toFixed(2)};
          vDist = length(center - cameraPosition);
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; uniform float uFogDensity;
        varying vec2 vUv; varying float vDist;
        ${GLSL_FOG_FADE}
        void main() {
          float r = length(vUv - 0.5) * 2.0;
          float a = ${NEON_BLOOM.LAMP_HALO_OPACITY.toFixed(2)} * exp(-r * r * ${NEON_BLOOM.LAMP_HALO_FALLOFF.toFixed(2)}) * (1.0 - smoothstep(0.85, 1.0, r));
          // Close-up: fade so the halo never washes the screen when the camera passes through it.
          a *= smoothstep(0.6, 2.4, vDist) * strandFogFade(vDist, uFogDensity * 0.6);
          gl_FragColor = vec4(uColor * a, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    const m = new THREE.InstancedMesh(geo, mat, CAP.LAMP);
    m.count = 0;
    m.frustumCulled = false;
    m.name = 'LampHalos';
    m.renderOrder = 6;
    return m;
  }

  /**
   * 5B-3 low steam & canal mist: 40–60 soft noise billboards that rise, swell and sway entirely in the vertex
   * shader (zero CPU cost); per instance aSteam = (phase, size, rise rate, seed).
   */
  private createSteam(): THREE.InstancedMesh {
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.setAttribute('aSteam', new THREE.InstancedBufferAttribute(new Float32Array(CAP.STEAM * 4), 4));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uTime: this.uTime, uFogDensity: this.uFogDensity },
      vertexShader: /* glsl */ `
        attribute vec4 aSteam;
        uniform float uTime;
        varying vec2 vUv; varying float vAlpha; varying float vDist; varying float vSeed;
        void main() {
          vUv = uv;
          vec3 base = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          float cyc = uTime * aSteam.z + aSteam.x;
          float t = fract(cyc);
          float size = aSteam.y * (0.7 + t * 1.3);
          vec3 c = base + vec3(sin(uTime * 0.6 + aSteam.w * 6.28) * 0.6 * t, t * 3.4 + size * 0.35, cos(uTime * 0.45 + aSteam.w * 4.0) * 0.5 * t);
          vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
          vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
          vec3 wp = c + (right * position.x + up * position.y) * size;
          vAlpha = smoothstep(0.0, 0.18, t) * (1.0 - smoothstep(0.55, 1.0, t));
          vDist = length(c - cameraPosition);
          vSeed = aSteam.w + floor(cyc) * 0.37;
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform float uFogDensity;
        varying vec2 vUv; varying float vAlpha; varying float vDist; varying float vSeed;
        ${GLSL_HASH}
        ${GLSL_FOG_FADE}
        void main() {
          float r = length(vUv - 0.5) * 2.0;
          float n = sNoise(vUv * 3.0 + vec2(vSeed * 7.0, uTime * 0.3)) * 0.6 + sNoise(vUv * 6.5 - uTime * 0.2 + vSeed * 3.1) * 0.4;
          float a = vAlpha * (1.0 - smoothstep(0.2, 1.0, r)) * (0.4 + 0.6 * n) * 0.17;
          a *= strandFogFade(vDist, uFogDensity * 0.8) * smoothstep(0.6, 2.6, vDist);
          gl_FragColor = vec4(vec3(0.62, 0.68, 0.8) * 0.34, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    const m = new THREE.InstancedMesh(geo, mat, CAP.STEAM);
    m.count = 0;
    m.frustumCulled = false;
    m.name = 'SteamMist';
    m.renderOrder = 3;
    return m;
  }

  /** Emerald light pillar rising from the opened district gate. */
  private createGatePillar(): THREE.Mesh {
    const h = 600;
    const geo = new THREE.CylinderGeometry(3.2, 3.2, h, 32, 1, true);
    geo.translate(0, h / 2, 0);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: {
        uTime: this.uTime,
        uColor: { value: new THREE.Color(COLORS.GATE_JADE) },
        uIntensity: { value: MATERIALS.GATE_JADE.emissive },
        uActive: this.uGateOpen,
      },
      vertexShader: /* glsl */ `
        varying vec3 vN; varying vec3 vV; varying float vY;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vN = normalize(mat3(modelMatrix) * normal);
          vV = normalize(cameraPosition - wp.xyz);
          vY = position.y;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform vec3 uColor; uniform float uIntensity; uniform float uActive;
        varying vec3 vN; varying vec3 vV; varying float vY;
        float h11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
        void main() {
          float edge = pow(abs(dot(normalize(vN), normalize(vV))), 2.4);
          float flow = 0.75 + 0.25 * sin(vY * 0.35 - uTime * 7.0) + 0.15 * sin(vY * 1.3 - uTime * 13.0);
          float spark = step(0.992, h11(floor(vY * 2.0) + floor(uTime * 20.0)));
          float fadeY = smoothstep(0.0, 6.0, vY) * (1.0 - smoothstep(260.0, 560.0, vY));
          float a = (edge * flow + spark * 0.6) * fadeY * uActive;
          gl_FragColor = vec4(uColor * uIntensity * a, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    const m = new THREE.Mesh(geo, mat);
    m.name = 'GatePillar';
    m.frustumCulled = false;
    m.visible = false;
    m.renderOrder = 7;
    return m;
  }

  // ===========================================================================================
  // Sector construction
  // ===========================================================================================
  /**
   * Builds district `sectorIndex` (1..5) of endless loop `loop`.
   * Deterministic: identical inputs always produce the identical layout (instant retries).
   */
  buildSector(sectorIndex: number, loop: number): SectorLayout {
    const sector = SECTORS[clamp(sectorIndex, 1, SECTORS.length) - 1];
    const plan = makePlan(sector);
    const rng = createRng(0x5eed + sector.index * 7919 + loop * 104729);
    this.clearSector();
    this.lightCount = 0;

    const colliders: BoxCollider[] = [];
    const rampColliders: RampCollider[] = [];
    const anchors: GrappleAnchor[] = [];
    const canalWater: RectXZ[] = [];
    const groundSpawns: SpawnPoint[] = [];
    const highwaySpawns: SpawnPoint[] = [];
    const bridgeSpawns: SpawnPoint[] = [];
    const skybridgeSpawns: SpawnPoint[] = [];
    const roofSpawns: SpawnPoint[] = [];
    const perchSpawns: SpawnPoint[] = [];
    const airSpawns: THREE.Vector3[] = [];

    // Merged geometry buckets (one draw call each)
    const G = {
      concrete: [] as THREE.BufferGeometry[],
      road: [] as THREE.BufferGeometry[],
      water: [] as THREE.BufferGeometry[],
      hw: [] as THREE.BufferGeometry[],
      strips: [] as THREE.BufferGeometry[],
      glassT: [] as THREE.BufferGeometry[],
      steel: [] as THREE.BufferGeometry[],
      glass: [] as THREE.BufferGeometry[],
      bodies: [] as THREE.BufferGeometry[],
      barrier: [] as THREE.BufferGeometry[],
    };

    // Instance counters & attributes
    const counts = { ac: 0, duct: 0, fence: 0, ant: 0, room: 0, avi: 0, neon: 0, search: 0, beacon: 0, lamp: 0, vend: 0, rail: 0 };
    const carCounts = [0, 0, 0];
    const aviPhase = this.aviation.geometry.getAttribute('aPhase') as THREE.InstancedBufferAttribute;
    const neonStrip = this.neonSigns.geometry.getAttribute('aStrip') as THREE.InstancedBufferAttribute;
    const neonFormat = this.neonSigns.geometry.getAttribute('aFormat') as THREE.InstancedBufferAttribute;
    const steamAttr = this.steam.geometry.getAttribute('aSteam') as THREE.InstancedBufferAttribute;
    const srng = createRng(0x51e7 + sector.index * 31 + loop * 977);
    const searchBase = this.searchlights.geometry.getAttribute('aBase') as THREE.InstancedBufferAttribute;
    const searchParams = this.searchlights.geometry.getAttribute('aParams') as THREE.InstancedBufferAttribute;
    const lampTint = this.lamps.geometry.getAttribute('aTint') as THREE.InstancedBufferAttribute;
    const vendTint = this.vending.geometry.getAttribute('aTint') as THREE.InstancedBufferAttribute;

    const inArea = (x: number, z: number, m = 0): boolean => Math.abs(x) <= H - m && Math.abs(z) <= H - m;

    // ------------------------------------------------------------------ writers
    const addLight = (x: number, y: number, z: number, hex: number, intensity: number): void => {
      if (this.lightCount >= CAP.CITY_LIGHTS) return;
      _col.setHex(hex);
      const i = this.lightCount++;
      this.lightPos[i * 3] = x;
      this.lightPos[i * 3 + 1] = y;
      this.lightPos[i * 3 + 2] = z;
      this.lightCol[i * 3] = _col.r * intensity;
      this.lightCol[i * 3 + 1] = _col.g * intensity;
      this.lightCol[i * 3 + 2] = _col.b * intensity;
    };
    const addAviation = (x: number, y: number, z: number): void => {
      if (counts.avi >= CAP.AVIATION) return;
      _m4.makeTranslation(x, y, z);
      this.aviation.setMatrixAt(counts.avi, _m4);
      aviPhase.setX(counts.avi, Math.abs(x * 0.013 + z * 0.007) % 0.12);
      counts.avi++;
    };
    const addBeacon = (p: THREE.Vector3, kind: AnchorKind): void => {
      anchors.push({ position: p.clone(), kind, enabled: true });
      if (counts.beacon >= CAP.BEACON) return;
      _m4.makeTranslation(p.x, p.y, p.z);
      this.beacons.setMatrixAt(counts.beacon, _m4);
      this.halos.setMatrixAt(counts.beacon, _m4);
      counts.beacon++;
    };
    /**
     * Neon sign plane: centre, plane normal (nx, nz), size, atlas index and format
     * (0 vertical blade · 1 wide banner / scrolling ticker · 2 emblem hologram — 5B-3).
     */
    const addNeon = (x: number, y: number, z: number, nx: number, nz: number, w: number, h: number, strip: number, format: 0 | 1 | 2 = 0): void => {
      if (counts.neon >= CAP.NEON) return;
      _pos.set(x, y, z);
      _euler.set(0, Math.atan2(nx, nz), 0);
      _quat.setFromEuler(_euler);
      _scl.set(w, h, 1);
      _m4.compose(_pos, _quat, _scl);
      this.neonSigns.setMatrixAt(counts.neon, _m4);
      neonStrip.setX(counts.neon, format === 0 ? strip % this.tex.neonAtlasStrips : strip);
      neonFormat.setX(counts.neon, format);
      counts.neon++;
    };
    const addSearch = (x: number, y: number, z: number): void => {
      if (counts.search >= CAP.SEARCH) return;
      searchBase.setXYZ(counts.search, x, y, z);
      searchParams.setXYZW(counts.search, rng() * Math.PI * 2, 0.18 + rng() * 0.25, 0.6 + rng() * 0.9, 0.25 + rng() * 0.35);
      counts.search++;
    };
    const placeInstance = (mesh: THREE.InstancedMesh, idx: number, x: number, y: number, z: number, yaw: number, sx = 1, sy = 1, sz = 1): void => {
      _pos.set(x, y, z);
      _euler.set(0, yaw, 0);
      _quat.setFromEuler(_euler);
      _scl.set(sx, sy, sz);
      _m4.compose(_pos, _quat, _scl);
      mesh.setMatrixAt(idx, _m4);
    };
    const addRail = (x: number, z: number, alongX: boolean): void => {
      if (counts.rail >= CAP.GUARDRAIL) return;
      placeInstance(this.guardrails, counts.rail++, x, 0, z, alongX ? 0 : Math.PI / 2);
    };
    const NEON_TINTS = [0xff2bd6, 0x00f0ff, 0xffa21f, 0x39ff88, 0xb44bff];
    const addLamp = (x: number, z: number, yaw: number): void => {
      if (counts.lamp >= CAP.LAMP) return;
      placeInstance(this.lamps, counts.lamp, x, 0, z, yaw);
      _col.setHex(NEON_TINTS[Math.floor(rng() * NEON_TINTS.length)]);
      lampTint.setXYZ(counts.lamp, _col.r, _col.g, _col.b);
      counts.lamp++;
      // Lamp head sits 2.05 m out along the arm (+Z rotated by yaw).
      addLight(x + Math.sin(yaw) * 2.05, 6.2, z + Math.cos(yaw) * 2.05, COLORS.STREET_LAMP, 4.0);
      _m4.makeTranslation(x + Math.sin(yaw) * 2.05, 6.22, z + Math.cos(yaw) * 2.05);
      this.lampHalos.setMatrixAt(counts.lamp - 1, _m4);
    };
    const addVending = (x: number, z: number, yaw: number, scale = 1): void => {
      if (counts.vend >= CAP.VENDING) return;
      placeInstance(this.vending, counts.vend, x, 0, z, yaw, scale, scale, scale);
      _col.setHex(NEON_TINTS[Math.floor(rng() * NEON_TINTS.length)]);
      vendTint.setXYZ(counts.vend, _col.r, _col.g, _col.b);
      counts.vend++;
      const hw = 0.5 * scale + 0.05;
      const hd = 0.4 * scale + 0.05;
      const ax = Math.abs(Math.sin(yaw)) > 0.5;
      colliders.push({
        min: new THREE.Vector3(x - (ax ? hd : hw), 0, z - (ax ? hw : hd)),
        max: new THREE.Vector3(x + (ax ? hd : hw), 1.9 * scale, z + (ax ? hw : hd)),
        kind: 'PROP',
        building: -1,
      });
    };

    // ------------------------------------------------------------------ 1. streets
    const streets = plan.streets;
    const canals = plan.canals;
    const bridgeSet = new Set(plan.bridgeStreets);

    // Canal along-range cuts for each street (non-bridge streets stop at the promenade).
    const streetRanges = streets.map((s, si) => {
      const cuts: Array<[number, number]> = [];
      for (const c of canals) {
        if (c.axis === s.axis || s.coord < c.from || s.coord > c.to || bridgeSet.has(si)) continue;
        const ch = canalCorridorHalf(c);
        cuts.push([c.coord - ch, c.coord + ch]);
      }
      return subtractIntervals(s.from, s.to, cuts);
    });

    /** Lane band of street p crossing street s (in s's along coordinate) if p actually reaches s. */
    const crossingBand = (s: StreetPlan, si: number, p: StreetPlan, pi: number): [number, number] | null => {
      if (p.axis === s.axis) return null;
      const pl = laneHalf(p.kind);
      const sl = laneHalf(s.kind);
      const reaches = streetRanges[pi].some(([r0, r1]) => r0 < s.coord + sl - 0.01 && r1 > s.coord - sl + 0.01);
      if (!reaches) return null;
      const inS = streetRanges[si].some(([r0, r1]) => p.coord > r0 - pl && p.coord < r1 + pl);
      if (!inS) return null;
      return [p.coord - pl, p.coord + pl];
    };

    const atlasAttr = (r: AtlasRegion): number[] => {
      const inset = 1.5 / RENDER.ROAD_TEX_SIZE;
      return [r.u0 + inset, r.v0 + inset, r.u1 - inset, r.v1 - inset];
    };
    /** Flat (or sloped) road quad along `axis`: lateral [l0,l1], along [a0,a1], heights y0 → y1 along. */
    const roadQuad = (axis: Axis, l0: number, l1: number, a0: number, a1: number, y0: number, y1: number, region: AtlasRegion, uAcross: number, vStart: number, vEnd: number): void => {
      const p0 = pt(axis, a0, y0, l0);
      const p1 = pt(axis, a0, y0, l1);
      const p2 = pt(axis, a1, y1, l1);
      const p3 = pt(axis, a1, y1, l0);
      G.road.push(quad([p0, p1, p2, p3], [0, vStart, uAcross, vStart, uAcross, vEnd, 0, vEnd], _up, { aAtlas: atlasAttr(region) }));
    };
    const flatRect = (r: RectXZ, y: number, reg: AtlasRegion): void => {
      G.road.push(quad(
        [new THREE.Vector3(r.x0, y, r.z0), new THREE.Vector3(r.x1, y, r.z0), new THREE.Vector3(r.x1, y, r.z1), new THREE.Vector3(r.x0, y, r.z1)],
        [r.x0 / reg.tileAcross, r.z0 / reg.tileAlong, r.x1 / reg.tileAcross, r.z0 / reg.tileAlong, r.x1 / reg.tileAcross, r.z1 / reg.tileAlong, r.x0 / reg.tileAcross, r.z1 / reg.tileAlong],
        _up,
        { aAtlas: atlasAttr(reg) },
      ));
    };

    const intersectionSquares: RectXZ[] = [];
    const crosswalkZones: RectXZ[] = [];
    const segmentsByStreet: Array<Array<[number, number]>> = streets.map(() => []);
    const ROAD_Y = 0.02;

    streets.forEach((s, si) => {
      const lh = laneHalf(s.kind);
      const region = s.kind === 'AVENUE' ? ROAD_ATLAS.LANES4 : ROAD_ATLAS.LANES2;
      for (const [r0, r1] of streetRanges[si]) {
        const bands: Array<[number, number]> = [];
        streets.forEach((p, pi) => {
          const b = crossingBand(s, si, p, pi);
          if (b && b[1] > r0 && b[0] < r1) bands.push([Math.max(b[0], r0), Math.min(b[1], r1)]);
        });
        bands.sort((a, b) => a[0] - b[0]);
        if (s.axis === 'z') {
          for (const [b0, b1] of bands) {
            const rect = rectFrom(s.coord - lh, b0, s.coord + lh, b1);
            intersectionSquares.push(rect);
            flatRect(rect, ROAD_Y, ROAD_ATLAS.ASPHALT);
          }
        }
        for (const [a0, a1] of subtractIntervals(r0, r1, bands)) {
          segmentsByStreet[si].push([a0, a1]);
          const startsAtJunction = bands.some(([, b1]) => Math.abs(b1 - a0) < 0.02);
          const endsAtJunction = bands.some(([b0]) => Math.abs(b0 - a1) < 0.02);
          let la0 = a0;
          let la1 = a1;
          const cw = 4;
          const xing = (c0: number, c1: number): void => {
            const reg = ROAD_ATLAS.CROSSWALK;
            roadQuad(s.axis, s.coord - lh, s.coord + lh, c0, c1, ROAD_Y, ROAD_Y, reg, (lh * 2) / reg.tileAcross, 0, 1);
            const p0 = pt(s.axis, c0, 0, s.coord - lh);
            const p1 = pt(s.axis, c1, 0, s.coord + lh);
            crosswalkZones.push(rectFrom(p0.x, p0.z, p1.x, p1.z));
          };
          if (a1 - a0 > cw * 2 + 2) {
            if (startsAtJunction) {
              xing(a0, a0 + cw);
              la0 = a0 + cw;
            }
            if (endsAtJunction) {
              xing(a1 - cw, a1);
              la1 = a1 - cw;
            }
          }
          roadQuad(s.axis, s.coord - lh, s.coord + lh, la0, la1, ROAD_Y, ROAD_Y, region, (lh * 2) / region.tileAcross, la0 / region.tileAlong, la1 / region.tileAlong);
          // Curbs (visual, 0.12 m) along both lane edges.
          for (const side of [-1, 1]) {
            G.concrete.push(boxGeoWorld(s.axis, a0, a1, s.coord + side * lh, s.coord + side * (lh + 0.16), 0, 0.12));
          }
        }
      }
    });

    // Scramble plaza (sector 5): unmarked asphalt + edge and diagonal zebra crossings.
    if (plan.plaza) {
      const r = plan.plaza;
      flatRect(r, ROAD_Y, ROAD_ATLAS.ASPHALT);
      const cwReg = ROAD_ATLAS.CROSSWALK;
      const zebra = (ax: number, az: number, bx: number, bz: number, y: number): void => {
        const len = Math.hypot(bx - ax, bz - az);
        const dx = (bx - ax) / len;
        const dz = (bz - az) / len;
        const nx = -dz * 2;
        const nz = dx * 2;
        const p0 = new THREE.Vector3(ax - nx, y, az - nz);
        const p1 = new THREE.Vector3(bx - nx, y, bz - nz);
        const p2 = new THREE.Vector3(bx + nx, y, bz + nz);
        const p3 = new THREE.Vector3(ax + nx, y, az + nz);
        // u = along A→B in 2 m tiles (bars repeat across the walking direction), v = 4 m band depth.
        G.road.push(quad([p0, p1, p2, p3], [0, 0, len / cwReg.tileAcross, 0, len / cwReg.tileAcross, 1, 0, 1], _up, { aAtlas: atlasAttr(cwReg) }));
      };
      const e = r.x1 - 3;
      zebra(-e, r.z0 + 2.5, e, r.z0 + 2.5, ROAD_Y + 0.004);
      zebra(-e, r.z1 - 2.5, e, r.z1 - 2.5, ROAD_Y + 0.004);
      zebra(r.x0 + 2.5, -e, r.x0 + 2.5, e, ROAD_Y + 0.004);
      zebra(r.x1 - 2.5, -e, r.x1 - 2.5, e, ROAD_Y + 0.004);
      zebra(-e + 2, -e + 2, e - 2, e - 2, ROAD_Y + 0.008);
      zebra(-e + 2, e - 2, e - 2, -e + 2, ROAD_Y + 0.012);
      // Plaza light masts at the corners.
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) addLamp(sx * (r.x1 + 1), sz * (r.z1 + 1), Math.atan2(-sx, -sz));
    }

    // ------------------------------------------------------------------ 2. canals
    const bridgeSpans: Array<{ canal: number; street: number; along0: number; along1: number; lat0: number; lat1: number }> = [];
    canals.forEach((c, ci) => {
      const hw = c.width / 2;
      const a0 = Math.max(c.from, -VIS);
      const a1 = Math.min(c.to, VIS);
      const spans: Array<[number, number]> = [];
      streets.forEach((s, si) => {
        if (!bridgeSet.has(si) || s.axis === c.axis || s.coord < c.from || s.coord > c.to) return;
        if (!streetRanges[si].some(([r0, r1]) => r0 < c.coord - hw && r1 > c.coord + hw)) return;
        const half = laneHalf(s.kind) + 1.6;
        spans.push([s.coord - half - 0.3, s.coord + half + 0.3]);
        bridgeSpans.push({ canal: ci, street: si, along0: c.coord - hw - 0.8, along1: c.coord + hw + 0.8, lat0: s.coord - half, lat1: s.coord + half });
      });
      // Water surface.
      const flow = c.axis === 'z' ? [0, 1] : [1, 0];
      G.water.push(quad(
        [pt(c.axis, a0, LEVEL.CANAL_WATER_Y, c.coord - hw), pt(c.axis, a0, LEVEL.CANAL_WATER_Y, c.coord + hw), pt(c.axis, a1, LEVEL.CANAL_WATER_Y, c.coord + hw), pt(c.axis, a1, LEVEL.CANAL_WATER_Y, c.coord - hw)],
        [0, 0, 1, 0, 1, 1, 0, 1],
        _up,
        { aFlow: flow },
      ));
      const wr0 = pt(c.axis, Math.max(a0, -H), 0, c.coord - hw);
      const wr1 = pt(c.axis, Math.min(a1, H), 0, c.coord + hw);
      canalWater.push(rectFrom(wr0.x, wr0.z, wr1.x, wr1.z));
      colliders.push(colliderAL(c.axis, Math.max(a0, -H), Math.min(a1, H), c.coord - hw, c.coord + hw, -4, LEVEL.CANAL_WATER_Y, 'WATER'));
      for (const side of [-1, 1]) {
        const wallLat = c.coord + side * hw;
        const inward = pt(c.axis, 0, 0, -side, new THREE.Vector3());
        G.hw.push(quad(
          [pt(c.axis, a0, LEVEL.CANAL_BED_Y, wallLat), pt(c.axis, a1, LEVEL.CANAL_BED_Y, wallLat), pt(c.axis, a1, 0, wallLat), pt(c.axis, a0, 0, wallLat)],
          [a0 / 6, LEVEL.CANAL_BED_Y / 6, a1 / 6, LEVEL.CANAL_BED_Y / 6, a1 / 6, 0, a0 / 6, 0],
          inward,
        ));
        // Towpath ledge (−1.1 m) so a jump can climb out: −2.4 → −1.1 → 0.
        const tpLat = wallLat - side * LEVEL.CANAL_TOWPATH_WIDTH_M;
        for (const [t0, t1] of subtractIntervals(a0, a1, spans)) {
          G.concrete.push(boxGeoWorld(c.axis, t0, t1, Math.min(wallLat, tpLat), Math.max(wallLat, tpLat), LEVEL.CANAL_BED_Y, LEVEL.CANAL_TOWPATH_Y));
          const c0 = Math.max(t0, -H);
          const c1 = Math.min(t1, H);
          if (c1 > c0) colliders.push(colliderAL(c.axis, c0, c1, wallLat, tpLat, -4, LEVEL.CANAL_TOWPATH_Y, 'TOWPATH'));
        }
        // Guard-rails on the promenade edge (gaps at bridges) + promenade lamps over the water.
        for (const [g0, g1] of subtractIntervals(Math.max(a0, -H + 1), Math.min(a1, H - 1), spans)) {
          for (let a = g0 + 1.5; a + 1.5 <= g1; a += 3) {
            const p = pt(c.axis, a, 0, wallLat + side * 0.25);
            addRail(p.x, p.z, c.axis === 'x');
          }
          if (g1 - g0 > 1) colliders.push(colliderAL(c.axis, g0, g1, wallLat + side * 0.2, wallLat + side * 0.32, 0, 1.0, 'PROP'));
          for (let a = g0 + 8; a < g1 - 4; a += 16) {
            const p = pt(c.axis, a, 0, wallLat + side * (LEVEL.CANAL_PROMENADE_M - 0.6));
            const yaw = c.axis === 'z' ? (side > 0 ? -Math.PI / 2 : Math.PI / 2) : side > 0 ? Math.PI : 0;
            addLamp(p.x, p.z, yaw);
          }
        }
      }
    });

    // ------------------------------------------------------------------ 3. ground concrete (everything except water)
    {
      const water: RectXZ[] = canals.map((c) => {
        const p0 = pt(c.axis, Math.max(c.from, -VIS), 0, c.coord - c.width / 2);
        const p1 = pt(c.axis, Math.min(c.to, VIS), 0, c.coord + c.width / 2);
        return rectFrom(p0.x, p0.z, p1.x, p1.z);
      });
      const O = LEVEL.OUTER_GROUND_M;
      const xs = new Set<number>([-O, -H, H, O]);
      const zs = new Set<number>([-O, -H, H, O]);
      for (const r of water) {
        xs.add(r.x0).add(r.x1);
        zs.add(r.z0).add(r.z1);
      }
      const xa = [...xs].sort((a, b) => a - b);
      const za = [...zs].sort((a, b) => a - b);
      const t = RENDER.ROOF_TILE_M;
      for (let i = 0; i < xa.length - 1; i++) {
        for (let j = 0; j < za.length - 1; j++) {
          const cx = (xa[i] + xa[i + 1]) / 2;
          const cz = (za[j] + za[j + 1]) / 2;
          if (water.some((r) => insideRect(cx, cz, r))) continue;
          G.concrete.push(quad(
            [new THREE.Vector3(xa[i], 0, za[j]), new THREE.Vector3(xa[i + 1], 0, za[j]), new THREE.Vector3(xa[i + 1], 0, za[j + 1]), new THREE.Vector3(xa[i], 0, za[j + 1])],
            [xa[i] / t, za[j] / t, xa[i + 1] / t, za[j] / t, xa[i + 1] / t, za[j + 1] / t, xa[i] / t, za[j + 1] / t],
            _up,
          ));
          const x0 = Math.max(xa[i], -H);
          const x1 = Math.min(xa[i + 1], H);
          const z0 = Math.max(za[j], -H);
          const z1 = Math.min(za[j + 1], H);
          if (x1 > x0 && z1 > z0) colliders.push({ min: new THREE.Vector3(x0, -4, z0), max: new THREE.Vector3(x1, 0, z1), kind: 'GROUND', building: -1 });
        }
      }
    }

    // ------------------------------------------------------------------ 4. neon truss bridges
    const BRIDGE_NEON = [COLORS.NEON_MAGENTA, COLORS.WALLRUN_CYAN, COLORS.NEON_AMBER];
    bridgeSpans.forEach((b, bi) => {
      const c = canals[b.canal];
      const s = streets[b.street];
      const axis = s.axis;
      const L = b.along1 - b.along0;
      G.hw.push(boxGeoWorld(axis, b.along0, b.along1, b.lat0, b.lat1, -LEVEL.BRIDGE_DECK_THICKNESS_M, LEVEL.BRIDGE_DECK_Y - 0.005));
      // Enemy spawn points across the deck (centre + both quarter points of the span).
      for (const k of [-0.5, 0, 0.5]) {
        bridgeSpawns.push({ position: pt(axis, c.coord + k * (c.width / 2), LEVEL.BRIDGE_DECK_Y, (b.lat0 + b.lat1) / 2), layer: 0, building: -1 });
      }
      colliders.push(colliderAL(axis, c.coord - c.width / 2, c.coord + c.width / 2, b.lat0, b.lat1, -LEVEL.BRIDGE_DECK_THICKNESS_M, LEVEL.BRIDGE_DECK_Y, 'BRIDGE'));
      const neon = BRIDGE_NEON[bi % BRIDGE_NEON.length];
      const tops = [3.5, 5.6, 6.5, 5.6, 3.5];
      for (const side of [-1, 1]) {
        const lat = side < 0 ? b.lat0 - 0.25 : b.lat1 + 0.25;
        const node = (i: number, top: boolean): THREE.Vector3 => pt(axis, b.along0 + (L * i) / 4, top ? tops[i] : 0.15, lat);
        const out = pt(axis, 0, 0, side * 0.2, new THREE.Vector3());
        for (let i = 0; i < 4; i++) {
          G.steel.push(beam(node(i, false), node(i + 1, false), 0.32));
          G.steel.push(beam(node(i, true), node(i + 1, true), 0.3));
          G.steel.push(i % 2 === 0 ? beam(node(i, false), node(i + 1, true), 0.2) : beam(node(i, true), node(i + 1, false), 0.2));
          G.strips.push(withColor(beam(node(i, true).add(out).setY(tops[i] + 0.2), node(i + 1, true).add(out).setY(tops[i + 1] + 0.2), 0.08), neon, 1.4));
        }
        for (let i = 0; i <= 4; i++) G.steel.push(beam(node(i, false), node(i, true), 0.22));
        G.strips.push(withColor(beam(pt(axis, b.along0, 0.42, lat + side * 0.2), pt(axis, b.along1, 0.42, lat + side * 0.2), 0.07), neon, 1.4));
        // Gold anchors on the truss apexes (centre + quarter nodes).
        for (const i of [1, 2, 3]) {
          const n = node(i, true);
          addBeacon(n.clone().setY(tops[i] + 0.75), 'BRIDGE_TRUSS');
          addLight(n.x, tops[i], n.z, neon, 2.6);
        }
        colliders.push(colliderAL(axis, b.along0, b.along1, lat - 0.18, lat + 0.18, 0, 3.5, 'BRIDGE'));
      }
      // Overhead lateral bracing at the three middle nodes (clear of traffic: ≥ 5.6 m).
      for (const i of [1, 2, 3]) {
        const a = b.along0 + (L * i) / 4;
        G.steel.push(beam(pt(axis, a, tops[i], b.lat0 - 0.25), pt(axis, a, tops[i], b.lat1 + 0.25), 0.22));
        colliders.push(colliderAL(axis, a - 0.15, a + 0.15, b.lat0, b.lat1, tops[i] - 0.15, tops[i] + 0.15, 'STEEL'));
      }
      G.steel.push(beam(pt(axis, b.along0 + L / 4, tops[1], b.lat0 - 0.25), pt(axis, b.along0 + (3 * L) / 4, tops[3], b.lat1 + 0.25), 0.12));
      G.steel.push(beam(pt(axis, b.along0 + L / 4, tops[1], b.lat1 + 0.25), pt(axis, b.along0 + (3 * L) / 4, tops[3], b.lat0 - 0.25), 0.12));
      // 5B-3 girder banners facing up / down the canal.
      for (const side of [-1, 1]) {
        const q = pt(axis, (b.along0 + b.along1) / 2, -0.62, side < 0 ? b.lat0 - 0.32 : b.lat1 + 0.32);
        addNeon(q.x, q.y, q.z, axis === 'z' ? side : 0, axis === 'x' ? side : 0, Math.min(L * 0.6, 10), 0.9, Math.floor(srng() * SIGN_ATLAS.WIDE_ROWS), 1);
      }
    });

    // ------------------------------------------------------------------ 5. expressways, piers, on-ramps
    const decks: Array<{ hi: number; axis: Axis; coord: number; a0: number; a1: number }> = [];
    const pierRects: RectXZ[] = [];
    const highwayRects: RectXZ[] = [];
    const rampRects: RectXZ[] = [];
    const HW = LEVEL.HIGHWAY_WIDTH_M / 2;
    const DECK = LEVEL.HIGHWAY_DECK_Y;
    const UNDER = LEVEL.HIGHWAY_UNDERSIDE_Y;
    const GUARD_TOP = DECK + LEVEL.HIGHWAY_GUARD_HEIGHT_M;
    const GT = LEVEL.HIGHWAY_GUARD_THICKNESS_M;

    const rampInfo = plan.ramps.map((r) => {
      const h = plan.highways[r.highway];
      const s = streets[r.street];
      const lh = laneHalf(s.kind);
      const top = h.coord + r.dir * HW;
      // Run available until the next perpendicular street centre, canal corridor or street end.
      let limit = r.dir > 0 ? s.to : s.from;
      streets.forEach((p) => {
        if (p.axis === s.axis || Math.abs(p.coord - h.coord) <= HW + 0.5) return;
        if ((p.coord - top) * r.dir > 1) limit = r.dir > 0 ? Math.min(limit, p.coord) : Math.max(limit, p.coord);
      });
      canals.forEach((c) => {
        if (c.axis === s.axis) return;
        const edge = c.coord - r.dir * canalCorridorHalf(c);
        if ((edge - top) * r.dir > 0) limit = r.dir > 0 ? Math.min(limit, edge) : Math.max(limit, edge);
      });
      const avail = Math.abs(limit - top) - 2;
      if (avail < LEVEL.RAMP_MIN_LENGTH_M) throw new Error(`Ramp ${r.highway}/${r.street}: only ${avail.toFixed(1)} m available`);
      const len = Math.min(avail, LEVEL.RAMP_MAX_LENGTH_M);
      const latC = s.coord + r.side * (lh - LEVEL.RAMP_WIDTH_M / 2);
      return { r, s, top, bottom: top + r.dir * len, lat0: latC - LEVEL.RAMP_WIDTH_M / 2, lat1: latC + LEVEL.RAMP_WIDTH_M / 2, len };
    });

    plan.highways.forEach((h, hi) => {
      const a0 = Math.max(h.from, -VIS);
      const a1 = Math.min(h.to, VIS);
      const junctions: Array<[number, number]> = [];
      for (const d of decks) {
        if (d.axis === h.axis) continue;
        if (h.coord + HW > d.a0 && h.coord - HW < d.a1 && d.coord + HW > a0 && d.coord - HW < a1) junctions.push([d.coord - HW, d.coord + HW]);
      }
      const ownedJunctions: Array<[number, number]> = [];
      plan.highways.forEach((o, oi) => {
        if (oi <= hi || o.axis === h.axis) return;
        if (h.coord + HW > o.from && h.coord - HW < o.to && o.coord + HW > a0 && o.coord - HW < a1) ownedJunctions.push([o.coord - HW, o.coord + HW]);
      });
      const pieces = subtractIntervals(a0, a1, junctions);
      for (const [p0, p1] of pieces) decks.push({ hi, axis: h.axis, coord: h.coord, a0: p0, a1: p1 });
      const hr0 = pt(h.axis, a0, 0, h.coord - HW);
      const hr1 = pt(h.axis, a1, 0, h.coord + HW);
      highwayRects.push(rectFrom(hr0.x, hr0.z, hr1.x, hr1.z));

      for (const [d0, d1] of pieces) {
        G.hw.push(boxGeoWorld(h.axis, d0, d1, h.coord - HW, h.coord + HW, DECK - 0.45, DECK));
        for (const g of [-4.6, 0, 4.6]) G.hw.push(boxGeoWorld(h.axis, d0, d1, h.coord + g - 0.8, h.coord + g + 0.8, UNDER, DECK - 0.45));
        G.hw.push(boxGeoWorld(h.axis, d0, d1, h.coord - HW, h.coord - HW + 0.3, UNDER, DECK));
        G.hw.push(boxGeoWorld(h.axis, d0, d1, h.coord + HW - 0.3, h.coord + HW, UNDER, DECK));
        const reg = ROAD_ATLAS.LANES4;
        for (const [l0, l1] of subtractIntervals(d0, d1, ownedJunctions)) {
          roadQuad(h.axis, h.coord - HW, h.coord + HW, l0, l1, DECK + ROAD_Y, DECK + ROAD_Y, reg, 1, l0 / reg.tileAlong, l1 / reg.tileAlong);
        }
        for (const [j0, j1] of ownedJunctions) {
          if (j1 <= d0 || j0 >= d1) continue;
          const ar = ROAD_ATLAS.ASPHALT;
          roadQuad(h.axis, h.coord - HW, h.coord + HW, j0, j1, DECK + ROAD_Y, DECK + ROAD_Y, ar, (HW * 2) / ar.tileAcross, j0 / ar.tileAlong, j1 / ar.tileAlong);
        }
        // Underside industrial light strips (emissive 1.6) + their glow on the street below.
        for (const side of [-1, 1]) {
          const color = side < 0 ? h.lightNeg : h.lightPos;
          const lat = h.coord + side * (HW - 1.6);
          G.strips.push(withColor(boxGeoWorld(h.axis, d0, d1, lat - 0.14, lat + 0.14, UNDER - 0.07, UNDER), color, NEON_BLOOM.UNDERSIDE_STRIP));
          for (let a = d0 + 6; a < d1; a += 12) {
            const q = pt(h.axis, a, UNDER - 0.3, lat);
            if (inArea(q.x, q.z, -20)) addLight(q.x, q.y, q.z, color, 2.2);
          }
        }
        const c0 = Math.max(d0, -H);
        const c1 = Math.min(d1, H);
        if (c1 > c0) colliders.push(colliderAL(h.axis, c0, c1, h.coord - HW, h.coord + HW, UNDER, DECK, 'HIGHWAY'));
      }

      // Guard walls with openings (junctions, ramps); the outer face + deck edge is a wall-runnable stack (6B-2).
      for (const side of [-1, 1]) {
        const openings: Array<[number, number]> = [];
        plan.highways.forEach((o, oi) => {
          if (oi === hi || o.axis === h.axis) return;
          const wallLat = h.coord + side * HW;
          const beyond = side > 0 ? o.to > h.coord + HW + 0.5 : o.from < h.coord - HW - 0.5;
          if (o.from < wallLat && o.to > wallLat && beyond && o.coord + HW > a0 && o.coord - HW < a1) openings.push([o.coord - HW, o.coord + HW]);
        });
        for (const ri of rampInfo) {
          if (ri.r.highway === hi && Math.sign(ri.top - h.coord) === side) openings.push([ri.lat0, ri.lat1]);
        }
        const wallOuter = h.coord + side * HW;
        const wallInner = wallOuter - side * GT;
        for (const [w0, w1] of subtractIntervals(a0, a1, openings)) {
          G.hw.push(boxGeoWorld(h.axis, w0, w1, Math.min(wallOuter, wallInner), Math.max(wallOuter, wallInner), DECK, GUARD_TOP));
          // 5B-3 wide banners / LED tickers along the expressway side (low on the face, cladding stays visible).
          for (let a = w0 + 14; a < w1 - 8; a += 40) {
            const q = pt(h.axis, a, UNDER + 0.75, wallOuter + side * 0.09);
            if (!inArea(q.x, q.z, -30)) continue;
            addNeon(q.x, q.y, q.z, h.axis === 'z' ? side : 0, h.axis === 'x' ? side : 0, 7, 1.0, Math.floor(srng() * SIGN_ATLAS.WIDE_ROWS), 1);
          }
          // 6A-5: bare concrete outer face with restrained architectural edge lines (no chevron cladding).
          const e0 = Math.min(wallOuter, wallOuter + side * 0.04);
          const e1 = Math.max(wallOuter, wallOuter + side * 0.04);
          G.strips.push(
            withColor(boxGeoWorld(h.axis, w0, w1, e0, e1, GUARD_TOP - 0.2, GUARD_TOP - 0.16), COLORS.STREET_LAMP, 0.95),
            withColor(boxGeoWorld(h.axis, w0, w1, e0, e1, UNDER + 0.12, UNDER + 0.15), COLORS.STREET_LAMP, 0.95),
          );
          const c0 = Math.max(w0, -H);
          const c1 = Math.min(w1, H);
          if (c1 > c0 + 1) colliders.push(colliderAL(h.axis, c0, c1, wallOuter, wallInner, DECK, GUARD_TOP, 'HIGHWAY'));
          // Gold anchors on wall-top posts every 24 m (highway edges).
          const sp = LEVEL.HIGHWAY_ANCHOR_SPACING_M;
          for (let a = Math.ceil((w0 + 4) / sp) * sp; a < w1 - 2; a += sp) {
            const q = pt(h.axis, a, GUARD_TOP, wallOuter - (side * GT) / 2);
            if (!inArea(q.x, q.z, -4)) continue;
            G.steel.push(boxAt(0.22, 0.6, 0.22, q.x, GUARD_TOP + 0.3, q.z));
            addBeacon(q.clone().setY(GUARD_TOP + 0.95), 'HIGHWAY_EDGE');
          }
        }
      }
      // Median barrier (opens at junctions).
      for (const [m0, m1] of subtractIntervals(a0, a1, [...junctions, ...ownedJunctions])) {
        G.hw.push(boxGeoWorld(h.axis, m0, m1, h.coord - 0.25, h.coord + 0.25, DECK, DECK + LEVEL.HIGHWAY_MEDIAN_HEIGHT_M));
        const c0 = Math.max(m0, -H);
        const c1 = Math.min(m1, H);
        if (c1 > c0) colliders.push(colliderAL(h.axis, c0, c1, h.coord - 0.25, h.coord + 0.25, DECK, DECK + LEVEL.HIGHWAY_MEDIAN_HEIGHT_M, 'HIGHWAY'));
      }

      // Piers every 24–28 m — never inside crossing street lanes, canal water or bridge spans.
      const blocked: Array<[number, number]> = [];
      streets.forEach((p) => {
        if (p.axis === h.axis || h.coord + HW < p.from || h.coord - HW > p.to) return;
        const pl = laneHalf(p.kind) + 1.5;
        blocked.push([p.coord - pl, p.coord + pl]);
      });
      canals.forEach((c) => {
        if (c.axis === h.axis || h.coord + HW < c.from || h.coord - HW > c.to) return;
        blocked.push([c.coord - c.width / 2 - 1.2, c.coord + c.width / 2 + 1.2]);
      });
      const crossAxisIsX = pt(h.axis, 0, 0, 1, new THREE.Vector3()).x !== 0;
      let a = a0 + 6 + rng() * 6;
      while (a < a1 - 4) {
        if (blocked.some(([b0, b1]) => a > b0 && a < b1)) {
          a += 1;
          continue;
        }
        const qp = pt(h.axis, a, 0, h.coord);
        G.hw.push(boxAt(1.4, UNDER, 1.4, qp.x, UNDER / 2, qp.z));
        G.hw.push(boxAt(crossAxisIsX ? 3.2 : 1.9, 0.7, crossAxisIsX ? 1.9 : 3.2, qp.x, UNDER - 0.35, qp.z));
        const pr = rectFrom(qp.x - 0.7, qp.z - 0.7, qp.x + 0.7, qp.z + 0.7);
        pierRects.push(pr);
        if (inArea(qp.x, qp.z)) colliders.push({ min: new THREE.Vector3(pr.x0, 0, pr.z0), max: new THREE.Vector3(pr.x1, UNDER, pr.z1), kind: 'HIGHWAY', building: -1 });
        a += LEVEL.HIGHWAY_PIER_SPACING_MIN_M + rng() * (LEVEL.HIGHWAY_PIER_SPACING_MAX_M - LEVEL.HIGHWAY_PIER_SPACING_MIN_M);
      }
    });

    // On-ramps: sloped slab + asphalt + parapets + supports; RampCollider for physics.
    rampInfo.forEach((ri) => {
      const axis = ri.s.axis;
      const len = ri.len;
      const slope = Math.atan2(DECK, len);
      const slabLen = len / Math.cos(slope);
      const slab = axis === 'z' ? new THREE.BoxGeometry(LEVEL.RAMP_WIDTH_M, 0.5, slabLen) : new THREE.BoxGeometry(slabLen, 0.5, LEVEL.RAMP_WIDTH_M);
      // Rising toward `top` (opposite of the descending dir).
      if (axis === 'z') slab.rotateX(ri.r.dir > 0 ? slope : -slope);
      else slab.rotateZ(ri.r.dir > 0 ? -slope : slope);
      const mid = pt(axis, (ri.top + ri.bottom) / 2, DECK / 2 - 0.25 / Math.cos(slope), (ri.lat0 + ri.lat1) / 2);
      slab.translate(mid.x, mid.y, mid.z);
      G.hw.push(slab);
      const ar = ROAD_ATLAS.ASPHALT;
      roadQuad(axis, ri.lat0, ri.lat1, ri.top, ri.bottom, DECK + ROAD_Y, ROAD_Y, ar, LEVEL.RAMP_WIDTH_M / ar.tileAcross, 0, len / ar.tileAlong);
      for (const lat of [ri.lat0 + 0.15, ri.lat1 - 0.15]) G.hw.push(beam(pt(axis, ri.top, DECK + 0.45, lat), pt(axis, ri.bottom, 0.45, lat), 0.3, 0.9));
      for (let d = 10; d < len - 6; d += 10) {
        const al = ri.top + ri.r.dir * d;
        const y = DECK * (1 - d / len) - 0.5;
        if (y < 1.2) continue;
        const qp = pt(axis, al, 0, (ri.lat0 + ri.lat1) / 2);
        G.hw.push(boxAt(1.0, y, 1.0, qp.x, y / 2, qp.z));
        if (inArea(qp.x, qp.z)) colliders.push({ min: new THREE.Vector3(qp.x - 0.5, 0, qp.z - 0.5), max: new THREE.Vector3(qp.x + 0.5, y, qp.z + 0.5), kind: 'HIGHWAY', building: -1 });
      }
      rampColliders.push({ axis, lateralMin: ri.lat0, lateralMax: ri.lat1, alongStart: ri.top, alongEnd: ri.bottom, yStart: DECK, yEnd: 0, thickness: 0.5 });
      const r0 = pt(axis, ri.top, 0, ri.lat0);
      const r1 = pt(axis, ri.bottom, 0, ri.lat1);
      rampRects.push(rectFrom(r0.x, r0.z, r1.x, r1.z));
    });

    // ------------------------------------------------------------------ 6. building lots, alleys & heights
    const lotList = plan.explicitLots ? plan.explicitLots.map((r) => ({ r, pair: -1 })) : this.computeLots(plan, sector, rng);
    const N = sector.buildingCount;
    const isPerimeter = (r: RectXZ): boolean => Math.max(Math.abs(r.x0), Math.abs(r.x1), Math.abs(r.z0), Math.abs(r.z1)) > H - 6;
    // Whole alley-split groups first (keeps both sides of each wall-run alley), perimeter wall preferred,
    // then single lots; spare lots become plazas.
    const groups = new Map<number, RectXZ[]>();
    const singles: RectXZ[] = [];
    for (const l of lotList) {
      if (l.pair < 0) singles.push(l.r);
      else groups.set(l.pair, [...(groups.get(l.pair) ?? []), l.r]);
    }
    const groupOrder = [...groups.values()]
      .map((g) => ({ g, perim: g.some(isPerimeter) ? 1 : 0, roll: rng() }))
      .sort((p, o) => o.perim - p.perim || p.roll - o.roll);
    const chosen: RectXZ[] = [];
    const rest: RectXZ[] = [...singles];
    for (const { g } of groupOrder) {
      if (chosen.length + g.length <= N) chosen.push(...g);
      else rest.push(...g);
    }
    const restOrder = rest.map((r) => ({ r, perim: isPerimeter(r) ? 1 : 0, roll: rng() })).sort((p, o) => o.perim - p.perim || p.roll - o.roll);
    while (chosen.length < N && restOrder.length) chosen.push((restOrder.shift() as { r: RectXZ }).r);
    const plazas = restOrder.map((o) => o.r);
    if (chosen.length !== N) throw new Error(`Sector ${sector.index}: only ${chosen.length}/${N} building lots`);

    // Alley detection: footprints facing each other across a 4–10 m gap with ≥ 5 m overlap.
    type AlleyRec = { a: number; b: number; axis: Axis; gap0: number; gap1: number; ov0: number; ov1: number };
    const alleyRecs: AlleyRec[] = [];
    for (let i = 0; i < chosen.length; i++) {
      for (let j = i + 1; j < chosen.length; j++) {
        const A = chosen[i];
        const B = chosen[j];
        const ovZ0 = Math.max(A.z0, B.z0);
        const ovZ1 = Math.min(A.z1, B.z1);
        if (ovZ1 - ovZ0 >= 5) {
          const [l, r] = A.x1 <= B.x0 ? [i, j] : B.x1 <= A.x0 ? [j, i] : [-1, -1];
          if (l >= 0) {
            const g0 = chosen[l].x1;
            const g1 = chosen[r].x0;
            if (g1 - g0 >= 4 && g1 - g0 <= 10) alleyRecs.push({ a: l, b: r, axis: 'x', gap0: g0, gap1: g1, ov0: ovZ0, ov1: ovZ1 });
          }
        }
        const ovX0 = Math.max(A.x0, B.x0);
        const ovX1 = Math.min(A.x1, B.x1);
        if (ovX1 - ovX0 >= 5) {
          const [n, f] = A.z1 <= B.z0 ? [i, j] : B.z1 <= A.z0 ? [j, i] : [-1, -1];
          if (n >= 0) {
            const g0 = chosen[n].z1;
            const g1 = chosen[f].z0;
            if (g1 - g0 >= 4 && g1 - g0 <= 10) alleyRecs.push({ a: n, b: f, axis: 'z', gap0: g0, gap1: g1, ov0: ovX0, ov1: ovX1 });
          }
        }
      }
    }
    // Sky-bridge alleys: exactly sector.skyBridges, preferring distinct tower pairs.
    const skyAlleys: AlleyRec[] = [];
    const bridged = new Set<number>();
    const shuffledAlleys = alleyRecs.map((al) => ({ al, roll: rng() })).sort((p, o) => p.roll - o.roll).map((x) => x.al);
    for (const pass of [0, 1]) {
      for (const al of shuffledAlleys) {
        if (skyAlleys.length >= sector.skyBridges) break;
        if (skyAlleys.includes(al)) continue;
        if (pass === 0 && (bridged.has(al.a) || bridged.has(al.b))) continue;
        skyAlleys.push(al);
        bridged.add(al.a).add(al.b);
      }
    }
    if (skyAlleys.length !== sector.skyBridges) throw new Error(`Sector ${sector.index}: ${skyAlleys.length}/${sector.skyBridges} sky-bridge alleys`);

    // Heights inside the sector band; perimeter towers lean tall; sky-bridge towers tall enough for Layer 2.
    const q2 = (v: number): number => Math.round(v * 2) / 2;
    const heights = chosen.map((r) => {
      const t = isPerimeter(r) ? 0.45 + rng() * 0.55 : rng();
      return q2(sector.heightMin + t * (sector.heightMax - sector.heightMin));
    });
    for (const i of bridged) heights[i] = Math.min(sector.heightMax, Math.max(heights[i], q2(LEVEL.SKYBRIDGE_Y_MIN + 12 + rng() * 14)));
    let iMax = 0;
    heights.forEach((hgt, i) => {
      if (hgt > heights[iMax]) iMax = i;
    });
    heights[iMax] = sector.heightMax;
    let iMin = -1;
    heights.forEach((hgt, i) => {
      if (i !== iMax && !bridged.has(i) && (iMin < 0 || hgt < heights[iMin])) iMin = i;
    });
    if (iMin >= 0) heights[iMin] = sector.heightMin;

    // ------------------------------------------------------------------ 6A-2 archetypes
    // Shares 30 / 25 / 25 / 20 (largest remainder) by height rank: the tallest towers become A glass
    // corporate towers, the next B residential blocks, the low-rise remainder C industrial (lots with a
    // street face long enough for a fire escape first) / D commercial. Heights are then clamped into each
    // archetype's band. Own RNG stream (arng) so the streets / cars / lamps stay where they were.
    const arng = createRng(0xa7c4 + sector.index * 131 + loop * 1009);
    const alleyFaces = new Set<string>();
    for (const al of alleyRecs) alleyFaces.add(`${al.a}:${al.axis}:1`).add(`${al.b}:${al.axis}:-1`);
    const FACES: ReadonlyArray<readonly [Axis, number]> = [['x', 1], ['x', -1], ['z', 1], ['z', -1]];
    const FE = FIRE_ESCAPE;
    const AR = ARCHETYPE;
    const escapeNeed = 2 * FE.LANDING_WIDTH_M + FE.RUN_MIN_M + 1.2;
    const lotFaceLen = (r: RectXZ, ax: Axis): number => (ax === 'x' ? r.z1 - r.z0 : r.x1 - r.x0);
    const hasEscapeFace = (i: number): boolean => FACES.some(([ax, sg]) => !alleyFaces.has(`${i}:${ax}:${sg}`) && lotFaceLen(chosen[i], ax) >= escapeNeed);
    const quota = AR.SHARES.map((sh) => sh * N);
    const archCount = quota.map((q) => Math.floor(q));
    const remOrder = quota.map((q, i) => ({ i, r: q - archCount[i] })).sort((p, o) => o.r - p.r || p.i - o.i);
    for (let k = 0; archCount.reduce((s, v) => s + v, 0) < N; k++) archCount[remOrder[k % 4].i]++;
    const archOf: number[] = new Array<number>(N).fill(ARCH_D);
    const byHeight = heights.map((h, i) => ({ i, h, roll: arng() })).sort((p, o) => o.h - p.h || p.roll - o.roll);
    byHeight.forEach((o, k) => {
      if (k < archCount[0]) archOf[o.i] = ARCH_A;
      else if (k < archCount[0] + archCount[1]) archOf[o.i] = ARCH_B;
    });
    byHeight
      .slice(archCount[0] + archCount[1])
      .map((o) => ({ i: o.i, pref: hasEscapeFace(o.i) ? 1 : 0, roll: arng() }))
      .sort((p, o) => o.pref - p.pref || p.roll - o.roll)
      .forEach((o, k) => (archOf[o.i] = k < archCount[2] ? ARCH_C : ARCH_D));
    heights.forEach((h, i) => {
      const a = archOf[i];
      const lo = Math.max(AR.MIN_H[a], sector.heightMin);
      const hi = Math.min(AR.MAX_H[a], sector.heightMax);
      let v = q2(clamp(h, lo, hi));
      // Low-rise Type C: whole 4 m storeys, so its fire escape lands flush on the roof.
      if (a === ARCH_C && v <= FE.ROOF_ACCESS_MAX_Y) v = clamp(Math.round(v / FE.LEVEL_H_M) * FE.LEVEL_H_M, Math.ceil(lo / FE.LEVEL_H_M) * FE.LEVEL_H_M, hi);
      heights[i] = v;
    });

    // 5B-3 / 6A-2: ~60 % of the Type A towers (≥ 45 m) become two-tier — a slimmer crown tier (65–78 %
    // footprint) rises from a terrace at 65–80 % of the height (above every sky-bridge / Layer-2 sign).
    const SB = SILHOUETTE;
    const buildings: Building[] = chosen.map((r, i) => {
      const lotHalfW = (r.x1 - r.x0) / 2;
      const lotHalfD = (r.z1 - r.z0) / 2;
      const roof = heights[i];
      let setbackY = 0;
      let kw = 1;
      let kd = 1;
      if (archOf[i] === ARCH_A && roof >= SB.SETBACK_MIN_ROOF_M && srng() < SB.SETBACK_CHANCE) {
        const lo = Math.max(roof * SB.SETBACK_AT_MIN, SB.SETBACK_MIN_Y);
        const hi = Math.min(roof * SB.SETBACK_AT_MAX, roof - SB.SETBACK_MIN_UPPER_M);
        const kwr = SB.SETBACK_SCALE_MIN + srng() * (SB.SETBACK_SCALE_MAX - SB.SETBACK_SCALE_MIN);
        const kdr = SB.SETBACK_SCALE_MIN + srng() * (SB.SETBACK_SCALE_MAX - SB.SETBACK_SCALE_MIN);
        const t = srng();
        // The crown tier keeps room for roof props (machine room, anchors): ≥ 4 m half extents.
        if (hi >= lo && lotHalfW * kwr >= 4 && lotHalfD * kdr >= 4) {
          setbackY = q2(lo + t * (hi - lo));
          kw = kwr;
          kd = kdr;
        }
      }
      return {
        index: i,
        cx: (r.x0 + r.x1) / 2,
        cz: (r.z0 + r.z1) / 2,
        halfW: lotHalfW * kw,
        halfD: lotHalfD * kd,
        roofY: roof,
        arch: archOf[i],
        rect: r,
        seed: rng(),
        lotHalfW,
        lotHalfD,
        setbackY,
      };
    });
    const lowTopOf = (b: Building): number => (b.setbackY > 0 ? b.setbackY : b.roofY);

    // ------------------------------------------------------------------ 7. face roles
    // Alley faces and ≥ 2 faces per tower stay FLAT (clean runs for 6B-2's anywhere wall-run, which detects
    // every vertical collider face); the other faces carry the archetype's 3D features: B balconies, C the
    // fire escape (+ ducts / loading dock), D the solid roll-shutter street base (7A-3: no recessed glass) with
    // per-floor canopies. A keeps every face flat behind its decorative mullions.
    const fkey = (b: Building, ax: Axis, sg: number): string => `${b.index}:${ax}:${sg}`;
    const faceLen = (b: Building, ax: Axis): number => (ax === 'x' ? b.lotHalfD : b.lotHalfW) * 2;
    const runFaces = new Set<string>();
    const balconyFaces = new Set<string>();
    const escapeFaces = new Set<string>();
    const shutterFaces = new Set<string>();
    const ductFaces = new Set<string>();
    buildings.forEach((b) => {
      let count = 0;
      for (const [ax, sg] of FACES) {
        if (!alleyFaces.has(fkey(b, ax, sg))) continue;
        runFaces.add(fkey(b, ax, sg));
        count++;
      }
      let escape = '';
      if (b.arch === ARCH_C) {
        const cands = FACES.filter(([ax, sg]) => !runFaces.has(fkey(b, ax, sg)) && faceLen(b, ax) >= escapeNeed);
        if (cands.length) {
          const [ax, sg] = cands[Math.floor(arng() * cands.length)];
          escape = fkey(b, ax, sg);
          escapeFaces.add(escape);
        }
      }
      let k = Math.floor(rng() * 4);
      let guard = 0;
      while (count < 2 && guard++ < 8) {
        const [ax, sg] = FACES[k++ % 4];
        const key = fkey(b, ax, sg);
        if (runFaces.has(key) || key === escape) continue;
        runFaces.add(key);
        count++;
      }
      const feature = FACES.filter(([ax, sg]) => !runFaces.has(fkey(b, ax, sg)) && fkey(b, ax, sg) !== escape);
      if (b.arch === ARCH_B) {
        const cands = feature
          .filter(([ax]) => faceLen(b, ax) >= BALCONY.WIDTH_MIN_M + 2)
          .map((f) => ({ f, roll: arng() }))
          .sort((p, o) => faceLen(b, o.f[0]) - faceLen(b, p.f[0]) || p.roll - o.roll);
        const n = Math.min(cands.length, arng() < 0.45 ? 2 : 1);
        for (let i = 0; i < n; i++) balconyFaces.add(fkey(b, cands[i].f[0], cands[i].f[1]));
      } else if (b.arch === ARCH_C) {
        if (feature.length) ductFaces.add(fkey(b, feature[0][0], feature[0][1]));
      } else if (b.arch === ARCH_D && feature.length) {
        if (lowTopOf(b) >= 12) for (const [ax, sg] of feature) shutterFaces.add(fkey(b, ax, sg));
      }
    });

    // ------------------------------------------------------------------ 7b. tower bodies, roofs, crowns
    const roofRects: RectXZ[][] = buildings.map(() => []);
    /** Tower body box: aSeed + aArch. */
    const bodyBox = (w: number, h: number, d: number, x: number, y: number, z: number, seed: number, arch: number): THREE.BufferGeometry =>
      withAttr1(withAttr1(boxAt(w, h, d, x, y, z), 'aSeed', seed), 'aArch', arch);
    const TERRACE_NEON = [COLORS.WALLRUN_CYAN, COLORS.NEON_MAGENTA, COLORS.NEON_AMBER];
    buildings.forEach((b) => {
      const lowTop = lowTopOf(b);
      const top = lowTop - 0.45;
      G.bodies.push(bodyBox(b.lotHalfW * 2, top, b.lotHalfD * 2, b.cx, top / 2, b.cz, b.seed, b.arch));
      if (b.setbackY > 0) {
        // Terrace: wet concrete cap + steel lip + a thin neon edge line, then the slimmer crown tier.
        G.concrete.push(worldUvBox(b.lotHalfW * 2 + 0.3, 0.5, b.lotHalfD * 2 + 0.3, b.cx, b.setbackY - 0.25, b.cz, RENDER.ROOF_TILE_M));
        G.steel.push(
          boxAt(b.lotHalfW * 2 + 0.42, 0.08, 0.22, b.cx, b.setbackY + 0.02, b.cz + b.lotHalfD + 0.1),
          boxAt(b.lotHalfW * 2 + 0.42, 0.08, 0.22, b.cx, b.setbackY + 0.02, b.cz - b.lotHalfD - 0.1),
          boxAt(0.22, 0.08, b.lotHalfD * 2 + 0.2, b.cx + b.lotHalfW + 0.1, b.setbackY + 0.02, b.cz),
          boxAt(0.22, 0.08, b.lotHalfD * 2 + 0.2, b.cx - b.lotHalfW - 0.1, b.setbackY + 0.02, b.cz),
        );
        const tn = TERRACE_NEON[Math.floor(srng() * TERRACE_NEON.length)];
        for (const sz of [-1, 1]) G.strips.push(withColor(boxAt(b.lotHalfW * 2 + 0.3, 0.06, 0.06, b.cx, b.setbackY - 0.6, b.cz + sz * (b.lotHalfD + 0.18)), tn, 1.3));
        for (const sx of [-1, 1]) G.strips.push(withColor(boxAt(0.06, 0.06, b.lotHalfD * 2 + 0.3, b.cx + sx * (b.lotHalfW + 0.18), b.setbackY - 0.6, b.cz), tn, 1.3));
        const uh = b.roofY - 0.45 - b.setbackY;
        G.bodies.push(bodyBox(b.halfW * 2, uh, b.halfD * 2, b.cx, b.setbackY + uh / 2, b.cz, b.seed, b.arch));
      }
      G.concrete.push(worldUvBox(b.halfW * 2 + 0.3, 0.5, b.halfD * 2 + 0.3, b.cx, b.roofY - 0.25, b.cz, RENDER.ROOF_TILE_M));
      G.steel.push(
        boxAt(b.halfW * 2 + 0.42, 0.08, 0.22, b.cx, b.roofY + 0.02, b.cz + b.halfD + 0.1),
        boxAt(b.halfW * 2 + 0.42, 0.08, 0.22, b.cx, b.roofY + 0.02, b.cz - b.halfD - 0.1),
        boxAt(0.22, 0.08, b.halfD * 2 + 0.2, b.cx + b.halfW + 0.1, b.roofY + 0.02, b.cz),
        boxAt(0.22, 0.08, b.halfD * 2 + 0.2, b.cx - b.halfW - 0.1, b.roofY + 0.02, b.cz),
      );
      // Two box colliders on setback towers: lower block (lot) + crown tier (5B-3).
      colliders.push({ min: new THREE.Vector3(b.rect.x0, 0, b.rect.z0), max: new THREE.Vector3(b.rect.x1, lowTop, b.rect.z1), kind: 'BUILDING', building: b.index });
      if (b.setbackY > 0) {
        colliders.push({ min: new THREE.Vector3(b.cx - b.halfW, b.setbackY, b.cz - b.halfD), max: new THREE.Vector3(b.cx + b.halfW, b.roofY, b.cz + b.halfD), kind: 'BUILDING', building: b.index });
      }
      // Type A roof crown: steel corner posts + two horizontal neon rings — a sharp, lit skyline.
      if (b.arch === ARCH_A) {
        const cn = TERRACE_NEON[Math.floor(srng() * TERRACE_NEON.length)];
        const ix = b.halfW - 0.35;
        const iz = b.halfD - 0.35;
        const yb = b.roofY;
        for (const [sx, sz] of CORNERS_4) {
          G.steel.push(boxAt(0.26, 4.8, 0.26, b.cx + sx * ix, yb + 2.4, b.cz + sz * iz));
          colliders.push({ min: new THREE.Vector3(b.cx + sx * ix - 0.13, yb, b.cz + sz * iz - 0.13), max: new THREE.Vector3(b.cx + sx * ix + 0.13, yb + 4.8, b.cz + sz * iz + 0.13), kind: 'STEEL', building: b.index });
        }
        for (const [y, th] of [[yb + 3.2, 0.09], [yb + 4.55, 0.11]] as const) {
          G.strips.push(
            withColor(boxAt(ix * 2, th, th, b.cx, y, b.cz + iz), cn, 1.45),
            withColor(boxAt(ix * 2, th, th, b.cx, y, b.cz - iz), cn, 1.45),
            withColor(boxAt(th, th, iz * 2, b.cx + ix, y, b.cz), cn, 1.45),
            withColor(boxAt(th, th, iz * 2, b.cx - ix, y, b.cz), cn, 1.45),
          );
        }
        G.steel.push(
          boxAt(ix * 2 + 0.3, 0.16, 0.2, b.cx, yb + 4.85, b.cz + iz),
          boxAt(ix * 2 + 0.3, 0.16, 0.2, b.cx, yb + 4.85, b.cz - iz),
          boxAt(0.2, 0.16, iz * 2 + 0.3, b.cx + ix, yb + 4.85, b.cz),
          boxAt(0.2, 0.16, iz * 2 + 0.3, b.cx - ix, yb + 4.85, b.cz),
        );
        addLight(b.cx, yb + 4.0, b.cz, cn, 3.0);
      }
      // Two diagonal roof corners carry gold anchors on steel stubs (grapple-able building corners).
      const diag = rng() < 0.5 ? 1 : -1;
      for (const [sx, sz] of [[1, diag], [-1, -diag]]) {
        const ex = b.cx + sx * (b.halfW + 0.6);
        const ez = b.cz + sz * (b.halfD + 0.6);
        const base = new THREE.Vector3(b.cx + sx * (b.halfW - 0.6), b.roofY, b.cz + sz * (b.halfD - 0.6));
        G.steel.push(beam(base, new THREE.Vector3(ex, b.roofY + 2.4, ez), 0.22), beam(base, base.clone().setY(b.roofY + 2.6), 0.26));
        addBeacon(new THREE.Vector3(ex, b.roofY + 2.9, ez), 'BUILDING_CORNER');
        roofRects[b.index].push(rectFrom(base.x - 1, base.z - 1, base.x + 1, base.z + 1));
      }
    });

    // ------------------------------------------------------------------ 7d. archetype 3D details
    /** Structural add-on drawn with the tower material in its archetype's plain cladding band (one draw). */
    const plainBody = (g: THREE.BufferGeometry, seed: number, col: number): THREE.BufferGeometry => withAttr1(withAttr1(g, 'aSeed', seed), 'aArch', col + 0.25);
    /** Point in a face frame: `al` along the face, `y` up, `d` metres out from the wall (negative = inside). */
    const faceFrame = (b: Building, ax: Axis, sg: number) => {
      const face = ax === 'x' ? b.cx + sg * b.lotHalfW : b.cz + sg * b.lotHalfD;
      const P3 = (al: number, y: number, d: number): THREE.Vector3 => (ax === 'x' ? new THREE.Vector3(face + sg * d, y, al) : new THREE.Vector3(al, y, face + sg * d));
      const box = (a0: number, a1: number, y0: number, y1: number, d0: number, d1: number): THREE.BufferGeometry => {
        const lo = P3(a0, y0, d0);
        const hi = P3(a1, y1, d1);
        return boxAt(Math.abs(hi.x - lo.x), y1 - y0, Math.abs(hi.z - lo.z), (lo.x + hi.x) / 2, (y0 + y1) / 2, (lo.z + hi.z) / 2);
      };
      const coll = (a0: number, a1: number, y0: number, y1: number, d0: number, d1: number): void => {
        const lo = P3(a0, y0, d0);
        const hi = P3(a1, y1, d1);
        colliders.push({
          min: new THREE.Vector3(Math.min(lo.x, hi.x), y0, Math.min(lo.z, hi.z)),
          max: new THREE.Vector3(Math.max(lo.x, hi.x), y1, Math.max(lo.z, hi.z)),
          kind: 'PROP',
          building: b.index,
        });
      };
      const c = ax === 'x' ? b.cz : b.cx;
      const len = faceLen(b, ax);
      return { face, P3, box, coll, c, len, a0: c - len / 2, a1: c + len / 2, nx: ax === 'x' ? sg : 0, nz: ax === 'z' ? sg : 0 };
    };

    /** Type A: vertical aluminium mullions on every 3 m room line + corner columns (decorative, no collider). */
    const mullions = (cx: number, cz: number, hw: number, hd: number, y0: number, y1: number): void => {
      if (y1 - y0 < 2) return;
      const S = AR.MULLION_SPACING_M;
      const h = y1 - y0;
      const cy = (y0 + y1) / 2;
      for (const [ax, sg] of FACES) {
        const c = ax === 'x' ? cz : cx;
        const half = ax === 'x' ? hd : hw;
        for (let a = Math.ceil((c - half + 0.6) / S) * S; a <= c + half - 0.6; a += S) {
          if (ax === 'x') G.steel.push(boxAt(AR.MULLION_D, h, AR.MULLION_W, cx + sg * (hw + AR.MULLION_D / 2), cy, a));
          else G.steel.push(boxAt(AR.MULLION_W, h, AR.MULLION_D, a, cy, cz + sg * (hd + AR.MULLION_D / 2)));
        }
      }
      for (const [sx, sz] of CORNERS_4) G.steel.push(boxAt(AR.MULLION_D + 0.1, h, AR.MULLION_D + 0.1, cx + sx * (hw + 0.02), cy, cz + sz * (hd + 0.02)));
    };

    /** Type B: thick cast-concrete corner pilasters (0.4 m relief ≤ 0.45 m: decorative, no collider — 6B-2). */
    const pilasters = (b: Building): void => {
      const P = AR.PILASTER_W;
      const O = AR.PILASTER_OUT;
      const top = lowTopOf(b) + 0.4;
      for (const [sx, sz] of CORNERS_4) {
        const x = b.cx + sx * (b.lotHalfW + O - P / 2);
        const z = b.cz + sz * (b.lotHalfD + O - P / 2);
        G.bodies.push(plainBody(boxAt(P, top, P, x, top / 2, z), b.seed, ARCH_B));
      }
    };

    const facadeFeatures: FacadeFeature[] = [];
    /** 6A-3 walkable balcony: 1.8 m concrete slab, 1.1 m rail (tempered glass or bars), AC unit, lamp. */
    let balconyCount = 0;
    const balcony = (b: Building, ax: Axis, sg: number, along: number, y: number, w: number, glass: boolean): void => {
      const B = BALCONY;
      const f = faceFrame(b, ax, sg);
      const D = B.DEPTH_M;
      const a0 = along - w / 2;
      const a1 = along + w / 2;
      const rt = y + B.RAIL_H_M;
      G.bodies.push(plainBody(f.box(a0, a1, y - B.SLAB_M, y, 0, D), b.seed, ARCH_B));
      G.steel.push(
        f.box(a0, a1, rt - 0.05, rt, D - 0.06, D),
        f.box(a0, a0 + 0.06, rt - 0.05, rt, 0, D),
        f.box(a1 - 0.06, a1, rt - 0.05, rt, 0, D),
        f.box(a0, a1, y + 0.06, y + 0.1, D - 0.05, D - 0.01),
        f.box(a0, a0 + 0.05, y, rt, D / 2 - 0.03, D / 2 + 0.03),
        f.box(a1 - 0.05, a1, y, rt, D / 2 - 0.03, D / 2 + 0.03),
      );
      const posts = Math.max(2, Math.round(w / 1.5));
      for (let k = 0; k <= posts; k++) {
        const a = a0 + 0.03 + (k * (w - 0.06)) / posts;
        G.steel.push(f.box(a - 0.03, a + 0.03, y, rt, D - 0.06, D));
      }
      if (glass) {
        G.glassT.push(
          stripUv(f.box(a0 + 0.05, a1 - 0.05, y + 0.12, rt - 0.07, D - 0.04, D - 0.02)),
          stripUv(f.box(a0 + 0.01, a0 + 0.03, y + 0.12, rt - 0.07, 0.05, D - 0.06)),
          stripUv(f.box(a1 - 0.03, a1 - 0.01, y + 0.12, rt - 0.07, 0.05, D - 0.06)),
        );
      } else {
        for (let a = a0 + 0.15; a < a1 - 0.1; a += 0.3) G.steel.push(f.box(a - 0.015, a + 0.015, y + 0.1, rt - 0.05, D - 0.04, D - 0.01));
        for (let d = 0.25; d < D - 0.1; d += 0.3) G.steel.push(f.box(a0 + 0.01, a0 + 0.04, y + 0.1, rt - 0.05, d - 0.015, d + 0.015), f.box(a1 - 0.04, a1 - 0.01, y + 0.1, rt - 0.05, d - 0.015, d + 0.015));
      }
      // Walkable slab always; the rails become cover up to the mid-rise limit.
      f.coll(a0, a1, y - B.SLAB_M, y, 0, D);
      if (y <= B.COLLIDER_MAX_Y) {
        f.coll(a0, a1, y, rt, D - 0.1, D);
        f.coll(a0, a0 + 0.1, y, rt, 0, D);
        f.coll(a1 - 0.1, a1, y, rt, 0, D);
      }
      if (arng() < B.AC_CHANCE && counts.ac < CAP.AC) {
        const p = f.P3(a1 - 0.8, y, 0.42);
        placeInstance(this.acUnits, counts.ac++, p.x, p.y, p.z, ax === 'x' ? Math.PI / 2 : 0, 0.5, 0.5, 0.5);
      }
      if (arng() < B.LAMP_CHANCE) {
        const p = f.P3(along, y + 2.3, 0.05);
        G.strips.push(withColor(boxAt(ax === 'x' ? 0.08 : 0.2, 0.1, ax === 'x' ? 0.2 : 0.08, p.x, p.y, p.z), B.LAMP_COLOR, B.LAMP_INTENSITY));
        if (y < 30) addLight(p.x + f.nx * 0.6, p.y, p.z + f.nz * 0.6, B.LAMP_COLOR, 0.9);
      }
      balconyCount++;
    };
    // The sector budget is shared evenly by every balcony face (tall slabs switch to 8 m spacing first,
    // then keep their lowest — playable — levels).
    const balconyBudget = Math.floor(BALCONY.MAX_PER_SECTOR / Math.max(1, balconyFaces.size));
    const balconies = (b: Building, ax: Axis, sg: number): void => {
      const f = faceFrame(b, ax, sg);
      const B = BALCONY;
      const w = Math.min(B.WIDTH_MIN_M + arng() * (B.WIDTH_MAX_M - B.WIDTH_MIN_M), f.len - 1.6);
      const gap = 1.2 + arng() * 1.3;
      const n = Math.max(1, Math.floor((f.len - 1.6 + gap) / (w + gap)));
      const total = n * w + (n - 1) * gap;
      let spacing = arng() < 0.5 ? 4 : 8;
      const glass = arng() < 0.7;
      const room = lowTopOf(b) - 3.5 - B.FIRST_Y;
      if (n * (Math.floor(room / spacing) + 1) > balconyBudget) spacing = 8;
      const levels = Math.min(Math.floor(room / spacing) + 1, Math.max(1, Math.floor(balconyBudget / n)));
      let lastY = 0;
      for (let l = 0; l < levels; l++) {
        const y = B.FIRST_Y + l * spacing;
        for (let k = 0; k < n && balconyCount < B.MAX_PER_SECTOR; k++) balcony(b, ax, sg, f.c - total / 2 + w / 2 + k * (w + gap), y, w, glass);
        lastY = y;
      }
      if (lastY > 0) facadeFeatures.push({ kind: 'BALCONY', building: b.index, center: f.P3(f.c, B.FIRST_Y, 0), normal: new THREE.Vector3(f.nx, 0, f.nz), top: lastY });
      // Drain pipe down each balcony stack.
      if (lastY > 0) {
        for (let k = 0; k < n; k++) {
          const a = f.c - total / 2 + k * (w + gap) + 0.14;
          G.steel.push(f.box(a - 0.04, a + 0.04, 0.2, lastY + 1.0, B.DEPTH_M - 0.2, B.DEPTH_M - 0.12));
        }
      }
    };

    /** 6A-4 zig-zag steel fire escape: landings every 4 m (RampCollider flights between them). */
    let escapeCount = 0;
    let flightCount = 0;
    const roofEscapes = new Set<string>();
    const fireEscape = (b: Building, ax: Axis, sg: number): void => {
      const f = faceFrame(b, ax, sg);
      const LH = FE.LEVEL_H_M;
      const LW = FE.LANDING_WIDTH_M;
      const LD = FE.LANDING_DEPTH_M;
      const RAIL = FE.RAIL_H_M;
      const lowTop = lowTopOf(b);
      const run = clamp(f.len - 1.2 - 2 * LW, FE.RUN_MIN_M, FE.RUN_MAX_M);
      const span = 2 * LW + run;
      const nearA = f.c - span / 2 + (arng() * 2 - 1) * Math.max(0, (f.len - 1.2 - span) / 2);
      const farA = nearA + LW + run;
      const toRoof = lowTop <= FE.ROOF_ACCESS_MAX_Y;
      const top = toRoof ? lowTop : LH * (3 + Math.floor(arng() * 4));
      const K = Math.round(top / LH);
      if (toRoof) roofEscapes.add(fkey(b, ax, sg));
      facadeFeatures.push({ kind: 'FIRE_ESCAPE', building: b.index, center: f.P3(farA, 0, LD * 0.75), normal: new THREE.Vector3(f.nx, 0, f.nz), top: K * LH });
      const alongAxis: Axis = ax === 'x' ? 'z' : 'x';
      for (let k = 1; k <= K; k++) {
        const y = k * LH;
        const near = k % 2 === 1;
        const l0 = near ? nearA : farA;
        const l1 = l0 + LW;
        const endA = near ? l0 : l1;
        G.steel.push(f.box(l0, l1, y - 0.08, y, 0, LD));
        for (let d = 0.3; d < LD; d += 0.3) G.steel.push(f.box(l0, l1, y - 0.12, y - 0.08, d - 0.02, d + 0.02));
        f.coll(l0, l1, y - 0.12, y, 0, LD);
        // Safety rail: front + outer end (the wall side and the flight side stay open).
        G.steel.push(
          f.box(l0, l1, y + RAIL - 0.05, y + RAIL, LD - 0.05, LD),
          f.box(l0, l1, y + 0.5, y + 0.54, LD - 0.04, LD - 0.01),
          f.box(endA - 0.025, endA + 0.025, y + RAIL - 0.05, y + RAIL, 0, LD),
          f.box(endA - 0.025, endA + 0.025, y + 0.5, y + 0.54, 0, LD),
          f.box(endA - 0.025, endA + 0.025, y, y + RAIL, LD / 2 - 0.025, LD / 2 + 0.025),
        );
        for (let a = l0; a <= l1 + 1e-3; a += LW / 3) G.steel.push(f.box(a - 0.025, a + 0.025, y, y + RAIL, LD - 0.05, LD));
        // Front rail collider sits on / just outside the landing edge: a body centred in the outer stair lane
        // (0.9 – 1.8 m) never clips it while stepping off the flight.
        f.coll(l0, l1, y, y + RAIL, LD - 0.015, LD + 0.06);
        f.coll(endA - 0.05, endA + 0.05, y, y + RAIL, 0, LD);
        for (const a of [l0 + 0.25, l1 - 0.25]) G.steel.push(beam(f.P3(a, y - 1.3, 0.02), f.P3(a, y - 0.1, LD - 0.12), 0.07));
        // Caged amber lamp on the wall above every second landing.
        if (k % 2 === 0) {
          const m = (l0 + l1) / 2;
          const p = f.P3(m, y + 2.5, 0.1);
          G.strips.push(withColor(boxAt(0.16, 0.2, 0.16, p.x, p.y, p.z), FE.CAGE_LIGHT, FE.CAGE_INTENSITY));
          G.steel.push(f.box(m - 0.13, m + 0.13, y + 2.37, y + 2.4, 0, 0.24), f.box(m - 0.13, m + 0.13, y + 2.6, y + 2.63, 0, 0.24), f.box(m - 0.015, m + 0.015, y + 2.37, y + 2.63, 0.2, 0.23));
          addLight(p.x + f.nx * 0.6, p.y - 0.4, p.z + f.nz * 0.6, FE.CAGE_LIGHT, 1.6);
        }
      }
      // Flights: even k climb far → near on the outer lane, odd k near → far on the inner lane.
      const steps = Math.round(LH / FE.STEP_RISE_M);
      for (let k = 0; k < K; k++) {
        const y0 = k * LH;
        const y1 = y0 + LH;
        const outer = k % 2 === 0;
        const d0 = outer ? LD / 2 : 0.04;
        const d1 = outer ? LD : LD / 2;
        const aLow = outer ? farA : nearA + LW;
        const aHigh = outer ? nearA + LW : farA;
        const lat0 = f.face + sg * d0;
        const lat1 = f.face + sg * d1;
        rampColliders.push({ axis: alongAxis, lateralMin: Math.min(lat0, lat1), lateralMax: Math.max(lat0, lat1), alongStart: aHigh, alongEnd: aLow, yStart: y1, yEnd: y0, thickness: FE.RAMP_THICKNESS_M, steel: true });
        for (const d of [d0 + 0.03, d1 - 0.03]) G.steel.push(beam(f.P3(aLow, y0 - 0.12, d), f.P3(aHigh, y1 - 0.12, d), 0.05, 0.22));
        const half = Math.abs(aHigh - aLow) / steps / 2 + 0.03;
        for (let i = 0; i < steps; i++) {
          const a = aLow + ((aHigh - aLow) * (i + 0.5)) / steps;
          const ty = y0 + ((i + 1) * LH) / steps - 0.02;
          G.steel.push(f.box(a - half, a + half, ty - 0.05, ty, d0 + 0.05, d1 - 0.05));
        }
        const dr = outer ? LD - 0.03 : LD / 2;
        G.steel.push(beam(f.P3(aLow, y0 + 1.0, dr), f.P3(aHigh, y1 + 1.0, dr), 0.05));
        for (const [a, yy] of [[aLow, y0], [aHigh, y1]] as const) G.steel.push(f.box(a - 0.025, a + 0.025, yy, yy + 1.0, dr - 0.025, dr + 0.025));
        flightCount++;
      }
      escapeCount++;
    };

    /** Type C: wall ducts with hoods (0.4 m relief, no collider), cable / drain pipes, a loading dock with bumpers. */
    const ductsAndDock = (b: Building, ax: Axis, sg: number): void => {
      const f = faceFrame(b, ax, sg);
      const lowTop = lowTopOf(b);
      const n = f.len > 14 ? 2 : 1;
      const W2 = AR.DUCT_W / 2;
      const O = AR.DUCT_OUT;
      for (let k = 0; k < n; k++) {
        const a = f.c + (n === 1 ? (arng() - 0.5) * f.len * 0.4 : (k === 0 ? -1 : 1) * f.len * 0.3);
        G.steel.push(f.box(a - W2, a + W2, 0.4, lowTop + 0.9, 0, O), f.box(a - W2 - 0.15, a + W2 + 0.15, lowTop + 0.9, lowTop + 1.15, -0.1, O + 0.2));
        for (let y = 3; y < lowTop; y += 3) G.steel.push(f.box(a - W2 - 0.05, a + W2 + 0.05, y, y + 0.08, 0, O + 0.04));
        for (const off of [W2 + 0.25, W2 + 0.45]) G.steel.push(f.box(a + off - 0.05, a + off + 0.05, 0, lowTop + 0.3, 0.12, 0.22));
      }
      if (f.len >= 10) {
        const a = f.c + (arng() - 0.5) * (f.len - 8);
        G.bodies.push(plainBody(f.box(a - 3, a + 3, 0, 1.1, 0, 1.6), b.seed, ARCH_B));
        f.coll(a - 3, a + 3, 0, 1.1, 0, 1.6);
        for (const s of [-2, 2]) G.steel.push(f.box(a + s - 0.18, a + s + 0.18, 0.35, 0.95, 1.6, 1.75));
        G.strips.push(withColor(f.box(a - 3, a + 3, 1.06, 1.1, 1.58, 1.62), 0xffb020, 0.35));
      }
    };

    /**
     * 7A-3 Type D street base (the recessed glass shopfront is gone): closed roll shutters come from the facade
     * atlas; heavy stone pillars (0.36 m out, no collider) every ~6 m, a projecting sign fascia over the shutters
     * with a warm downlight strip and its spill on the pavement — then per-floor canopies with wide banners.
     */
    const shutterFront = (b: Building, ax: Axis, sg: number): void => {
      const f = faceFrame(b, ax, sg);
      const RT = AR.BASE_TOP_M;
      const PW = AR.SHUTTER_PILLAR_M;
      const PO = AR.SHUTTER_PILLAR_OUT_M;
      facadeFeatures.push({ kind: 'SHUTTER_FRONT', building: b.index, center: f.P3(f.c, 0, 0), normal: new THREE.Vector3(f.nx, 0, f.nz), top: RT });
      const bays = Math.max(1, Math.round((f.len - PW) / AR.SHUTTER_PILLAR_SPACING_M));
      const bw = (f.len - PW) / bays;
      for (let k = 0; k <= bays; k++) {
        const a = f.a0 + PW / 2 + k * bw;
        G.bodies.push(plainBody(f.box(a - PW / 2, a + PW / 2, 0, RT, 0, PO), b.seed, ARCH_D));
        G.steel.push(f.box(a - PW / 2 - 0.03, a + PW / 2 + 0.03, 0, 0.32, 0, PO + 0.04));
      }
      // Sign fascia over the shutters (dark steel box, neon edge) + the warm downlight strip on its soffit.
      const [fy0, fy1] = AR.SHUTTER_FASCIA_Y;
      const FO = AR.SHUTTER_FASCIA_OUT_M;
      G.steel.push(f.box(f.a0 + PW, f.a1 - PW, fy0, fy1, 0, FO));
      const tintF = NEON_TINTS[Math.floor(srng() * NEON_TINTS.length)];
      G.strips.push(withColor(f.box(f.a0 + PW + 0.1, f.a1 - PW - 0.1, fy1 - 0.05, fy1 - 0.02, FO, FO + 0.02), tintF, 1.1));
      G.strips.push(withColor(f.box(f.a0 + PW + 0.25, f.a1 - PW - 0.25, fy0 - 0.03, fy0, 0.04, FO - 0.04), COLORS.STREET_LAMP, 1.05));
      const sp = f.P3(f.c, 2.6, 0.9);
      addLight(sp.x, sp.y, sp.z, FACADE.WARM_A, 1.3);
      // Horizontal canopy on every floor above the shopfront (dense wide banners).
      const tint = NEON_TINTS[Math.floor(srng() * NEON_TINTS.length)];
      const floors = Math.min(AR.FLOOR_CANOPIES_MAX, Math.floor((lowTopOf(b) - RT - 3) / 4) + 1);
      const DD = AR.FLOOR_CANOPY_DEPTH_M;
      for (let j = 0; j < floors; j++) {
        const y = RT + 0.06 + j * 4;
        G.steel.push(f.box(f.a0 + 0.3, f.a1 - 0.3, y - 0.07, y + 0.07, 0, DD));
        if (j === 0) G.strips.push(withColor(f.box(f.a0 + 0.5, f.a1 - 0.5, y - 0.1, y - 0.07, DD - 0.12, DD - 0.06), tint, 1.3));
        if (y <= BALCONY.COLLIDER_MAX_Y) f.coll(f.a0 + 0.3, f.a1 - 0.3, y - 0.07, y + 0.07, 0, DD);
        if (j === 0 || srng() < 0.55) {
          const p = f.P3(f.c + (srng() - 0.5) * f.len * 0.3, y + 0.95, 0.1);
          addNeon(p.x, p.y, p.z, f.nx, f.nz, Math.min(f.len * 0.7, 9), 0.85, Math.floor(srng() * SIGN_ATLAS.WIDE_ROWS), 1);
        }
      }
    };

    buildings.forEach((b) => {
      const lowTop = lowTopOf(b);
      if (b.arch === ARCH_A) {
        mullions(b.cx, b.cz, b.lotHalfW, b.lotHalfD, 4.0, lowTop - 0.45);
        if (b.setbackY > 0) mullions(b.cx, b.cz, b.halfW, b.halfD, b.setbackY + 0.05, b.roofY - 0.45);
      } else if (b.arch === ARCH_B) pilasters(b);
      for (const [ax, sg] of FACES) {
        const key = fkey(b, ax, sg);
        if (balconyFaces.has(key)) balconies(b, ax, sg);
        if (escapeFaces.has(key)) fireEscape(b, ax, sg);
        if (ductFaces.has(key)) ductsAndDock(b, ax, sg);
        if (shutterFaces.has(key)) shutterFront(b, ax, sg);
      }
    });

    // Sky-bridges (Layer 2) across the selected alleys.
    let skybridgeCount = 0;
    for (const rec of skyAlleys) {
      const al = { a: buildings[rec.a], b: buildings[rec.b], axis: rec.axis, gap0: rec.gap0, gap1: rec.gap1, ov0: rec.ov0, ov1: rec.ov1 };
      const minRoof = Math.min(al.a.roofY, al.b.roofY);
      if (minRoof < LEVEL.SKYBRIDGE_Y_MIN + 9) continue;
      const yMax = Math.min(LEVEL.SKYBRIDGE_Y_MAX - 3.2, minRoof - 6);
      const y = q2(LEVEL.SKYBRIDGE_Y_MIN + rng() * Math.max(0, yMax - LEVEL.SKYBRIDGE_Y_MIN));
      const lat = (al.ov0 + al.ov1) / 2;
      const axis = al.axis;
      const a0 = al.gap0;
      const a1 = al.gap1;
      const half = 2.0;
      G.hw.push(boxGeoWorld(axis, a0, a1, lat - half, lat + half, y - 0.35, y));
      G.hw.push(boxGeoWorld(axis, a0, a1, lat - half - 0.1, lat + half + 0.1, y + 2.9, y + 3.2));
      for (const side of [-1, 1]) {
        const l = lat + side * half;
        G.glass.push(stripUv(boxGeoWorld(axis, a0, a1, l - 0.04, l + 0.04, y, y + 2.9)));
        G.steel.push(boxGeoWorld(axis, a0, a1, l - 0.1, l + 0.1, y + 1.0, y + 1.12));
        for (let a = a0; a <= a1 + 0.01; a += (a1 - a0) / 3) G.steel.push(boxGeoWorld(axis, a - 0.08, a + 0.08, l - 0.1, l + 0.1, y, y + 2.9));
      }
      G.strips.push(withColor(boxGeoWorld(axis, a0, a1, lat - 0.15, lat + 0.15, y + 2.82, y + 2.88), COLORS.WALLRUN_CYAN, 1.2));
      colliders.push(colliderAL(axis, a0, a1, lat - half - 0.1, lat + half + 0.1, y - 0.35, y + 3.2, 'SKYBRIDGE'));
      const top = pt(axis, (a0 + a1) / 2, y + 3.2, lat);
      addBeacon(top.clone().setY(y + 4.0), 'SKYBRIDGE');
      skybridgeSpawns.push({ position: top.clone(), layer: 2, building: -1 });
      skybridgeCount++;
    }


    // ------------------------------------------------------------------ 8. rooftop details, signs, vending
    const tryPlace = (b: Building, hw: number, hd: number, margin: number): RectXZ | null => {
      for (let attempt = 0; attempt < 24; attempt++) {
        const x = b.cx + (rng() * 2 - 1) * Math.max(0, b.halfW - hw - margin);
        const z = b.cz + (rng() * 2 - 1) * Math.max(0, b.halfD - hd - margin);
        const r = rectFrom(x - hw, z - hd, x + hw, z + hd);
        if (!roofRects[b.index].some((o) => rectsOverlap(r, o, 0.9))) {
          roofRects[b.index].push(r);
          return r;
        }
      }
      return null;
    };
    const facePoint = (b: Building, axis: Axis, sign: number, along01: number, out: THREE.Vector3): THREE.Vector3 =>
      axis === 'x'
        ? out.set(b.cx + sign * b.lotHalfW, 0, b.cz + (along01 - 0.5) * b.lotHalfD * 2)
        : out.set(b.cx + (along01 - 0.5) * b.lotHalfW * 2, 0, b.cz + sign * b.lotHalfD);

    buildings.forEach((b) => {
      const area = b.halfW * b.halfD * 4;
      // Machine room + antenna.
      if (counts.room < CAP.MACHINE_ROOM) {
        const rw = 3.5 + rng() * 2.5;
        const rd = 3 + rng() * 2;
        const rh = 3 + rng() * 1.4;
        const r = tryPlace(b, rw / 2, rd / 2, 2);
        if (r) {
          placeInstance(this.machineRooms, counts.room++, (r.x0 + r.x1) / 2, b.roofY, (r.z0 + r.z1) / 2, 0, rw, rh, rd);
          colliders.push({ min: new THREE.Vector3(r.x0, b.roofY, r.z0), max: new THREE.Vector3(r.x1, b.roofY + rh + 0.06, r.z1), kind: 'PROP', building: b.index });
          if (counts.ant < CAP.ANTENNA) {
            const ah = 6 + rng() * 8;
            placeInstance(this.antennas, counts.ant++, r.x0 + 0.8, b.roofY + rh, r.z0 + 0.8, 0, 1, ah, 1);
            addAviation(r.x0 + 0.8, b.roofY + rh + ah + 0.15, r.z0 + 0.8);
          }
        }
      }
      // AC units (count scales with roof area).
      const acN = Math.min(8, 2 + Math.floor(area / 120));
      for (let i = 0; i < acN && counts.ac < CAP.AC; i++) {
        const rot = rng() < 0.5 ? 0 : Math.PI / 2;
        const r = tryPlace(b, rot === 0 ? 1.1 : 0.6, rot === 0 ? 0.6 : 1.1, 1.3);
        if (!r) continue;
        placeInstance(this.acUnits, counts.ac++, (r.x0 + r.x1) / 2, b.roofY, (r.z0 + r.z1) / 2, rot);
        colliders.push({ min: new THREE.Vector3(r.x0, b.roofY, r.z0), max: new THREE.Vector3(r.x1, b.roofY + 1.42, r.z1), kind: 'PROP', building: b.index });
      }
      // Exhaust duct.
      if (counts.duct < CAP.DUCT && b.halfW > 6 && b.halfD > 6) {
        const len = 4 + rng() * 3;
        const alongX = rng() < 0.5;
        const r = tryPlace(b, alongX ? len / 2 : 0.5, alongX ? 0.5 : len / 2, 1.4);
        if (r) {
          placeInstance(this.ducts, counts.duct++, (r.x0 + r.x1) / 2, b.roofY, (r.z0 + r.z1) / 2, alongX ? 0 : Math.PI / 2, len, 1, 1);
          colliders.push({ min: new THREE.Vector3(r.x0, b.roofY, r.z0), max: new THREE.Vector3(r.x1, b.roofY + 1.5, r.z1), kind: 'PROP', building: b.index });
        }
      }
      // Roof fences on edges that are not alley sides (alley edges stay open for jumps) nor the roof exit of a
      // fire escape.
      for (const [ax, sg] of FACES) {
        if (alleyFaces.has(fkey(b, ax, sg)) || rng() < 0.4 || roofEscapes.has(fkey(b, ax, sg))) continue;
        const len = ax === 'x' ? b.halfD * 2 : b.halfW * 2;
        const segs = Math.floor((len - 5) / 3);
        if (segs <= 0) continue;
        const start = -((segs - 1) * 3) / 2;
        for (let sI = 0; sI < segs && counts.fence < CAP.FENCE; sI++) {
          const along = start + sI * 3;
          const fx = ax === 'x' ? b.cx + sg * (b.halfW - 0.5) : b.cx + along;
          const fz = ax === 'x' ? b.cz + along : b.cz + sg * (b.halfD - 0.5);
          placeInstance(this.fences, counts.fence++, fx, b.roofY, fz, ax === 'x' ? Math.PI / 2 : 0);
        }
        const half = (segs * 3) / 2;
        colliders.push(ax === 'x'
          ? { min: new THREE.Vector3(b.cx + sg * (b.halfW - 0.5) - 0.05, b.roofY, b.cz - half), max: new THREE.Vector3(b.cx + sg * (b.halfW - 0.5) + 0.05, b.roofY + 1.2, b.cz + half), kind: 'PROP', building: b.index }
          : { min: new THREE.Vector3(b.cx - half, b.roofY, b.cz + sg * (b.halfD - 0.5) - 0.05), max: new THREE.Vector3(b.cx + half, b.roofY + 1.2, b.cz + sg * (b.halfD - 0.5) + 0.05), kind: 'PROP', building: b.index });
      }
      if (b.roofY >= 45) {
        addAviation(b.cx + b.halfW - 0.3, b.roofY + 0.4, b.cz + b.halfD - 0.3);
        addAviation(b.cx - b.halfW + 0.3, b.roofY + 0.4, b.cz - b.halfD + 0.3);
      }

      // Street-facing faces: 1F canopies + wide banners, low-rise shop blade signs, Layer-2 projecting signs,
      // emblem holograms, vertical facade fins, vending machines. Balcony and fire-escape faces keep their
      // 3D structure clear of projecting signs.
      const streetFaces = FACES.filter(([ax, sg]) => !alleyFaces.has(fkey(b, ax, sg)));
      const signFaces = streetFaces.filter(([ax, sg]) => !balconyFaces.has(fkey(b, ax, sg)) && !escapeFaces.has(fkey(b, ax, sg)));
      const lowTop = lowTopOf(b);
      const busyFaces = new Set<string>();
      // 5B-3: 1F canopy (Y 4.2 m, 1.4 m deep) with an under-glow strip and a wide banner above it — never on the
      // flat wall-run faces, the fire escape or a Type D shutter front (D has its own per-floor canopies).
      for (const [ax, sg] of streetFaces) {
        const key = fkey(b, ax, sg);
        if (runFaces.has(key) || escapeFaces.has(key) || shutterFaces.has(key) || srng() < 0.22) continue;
        const len = (ax === 'x' ? b.lotHalfD : b.lotHalfW) * 2;
        const cl = len - 3;
        if (cl < 4) continue;
        const D = SB.CANOPY_DEPTH_M;
        const cy = SB.CANOPY_Y;
        const tint = NEON_TINTS[Math.floor(srng() * NEON_TINTS.length)];
        if (ax === 'x') {
          const fx = b.cx + sg * b.lotHalfW;
          G.steel.push(boxAt(D, 0.16, cl, fx + (sg * D) / 2, cy, b.cz));
          G.strips.push(withColor(boxAt(0.07, 0.04, cl - 0.4, fx + sg * (D - 0.12), cy - 0.1, b.cz), tint, 1.3));
          G.strips.push(withColor(boxAt(0.05, 0.03, cl - 0.4, fx + sg * 0.2, cy - 0.09, b.cz), COLORS.STREET_LAMP, 1.1));
          colliders.push({ min: new THREE.Vector3(Math.min(fx, fx + sg * D), cy - 0.08, b.cz - cl / 2), max: new THREE.Vector3(Math.max(fx, fx + sg * D), cy + 0.08, b.cz + cl / 2), kind: 'PROP', building: b.index });
          addNeon(fx + sg * 0.1, cy + 1.0, b.cz, sg, 0, Math.min(cl * 0.8, 9), 0.85, Math.floor(srng() * SIGN_ATLAS.WIDE_ROWS), 1);
        } else {
          const fz = b.cz + sg * b.lotHalfD;
          G.steel.push(boxAt(cl, 0.16, D, b.cx, cy, fz + (sg * D) / 2));
          G.strips.push(withColor(boxAt(cl - 0.4, 0.04, 0.07, b.cx, cy - 0.1, fz + sg * (D - 0.12)), tint, 1.3));
          G.strips.push(withColor(boxAt(cl - 0.4, 0.03, 0.05, b.cx, cy - 0.09, fz + sg * 0.2), COLORS.STREET_LAMP, 1.1));
          colliders.push({ min: new THREE.Vector3(b.cx - cl / 2, cy - 0.08, Math.min(fz, fz + sg * D)), max: new THREE.Vector3(b.cx + cl / 2, cy + 0.08, Math.max(fz, fz + sg * D)), kind: 'PROP', building: b.index });
          addNeon(b.cx, cy + 1.0, fz + sg * 0.1, 0, sg, Math.min(cl * 0.8, 9), 0.85, Math.floor(srng() * SIGN_ATLAS.WIDE_ROWS), 1);
        }
      }
      // Blade signs: Type D commercial streets are packed (3–5, dense-neon sectors 4–6).
      const shopSigns = b.arch === ARCH_D
        ? (sector.denseNeon ? 4 : 3) + Math.floor(rng() * 3)
        : sector.denseNeon ? 3 + Math.floor(rng() * 3) : 1 + Math.floor(rng() * 2);
      const fp = new THREE.Vector3();
      for (let s = 0; s < shopSigns && signFaces.length; s++) {
        const [ax, sg] = signFaces[Math.floor(rng() * signFaces.length)];
        busyFaces.add(fkey(b, ax, sg));
        facePoint(b, ax, sg, 0.12 + rng() * 0.76, fp);
        const w = 1.7;
        const hgt = 5 + rng() * 4;
        // Blade signs start above the 1F canopy (5B-3).
        const y = SB.CANOPY_Y + 0.5 + hgt / 2 + rng() * 1.5;
        const nx = ax === 'x' ? sg : 0;
        const nz = ax === 'z' ? sg : 0;
        addNeon(fp.x + nx * (w / 2 + 0.3), y, fp.z + nz * (w / 2 + 0.3), ax === 'x' ? 0 : 1, ax === 'x' ? 1 : 0, w, hgt, Math.floor(rng() * 8));
        for (const yy of [y + hgt / 2 - 0.2, y - hgt / 2 + 0.2]) {
          G.steel.push(boxAt(Math.abs(nx) * (w + 0.3) + 0.08, 0.08, Math.abs(nz) * (w + 0.3) + 0.08, fp.x + (nx * (w + 0.3)) / 2, yy, fp.z + (nz * (w + 0.3)) / 2));
        }
      }
      if (b.roofY >= 36 && signFaces.length) {
        const [ax, sg] = signFaces[Math.floor(rng() * signFaces.length)];
        busyFaces.add(fkey(b, ax, sg));
        facePoint(b, ax, sg, 0.2 + rng() * 0.6, fp);
        const w = 2.6;
        const hgt = 11 + rng() * 4;
        const y = LEVEL.SKYBRIDGE_Y_MIN + hgt / 2 + rng() * Math.max(0, LEVEL.SKYBRIDGE_Y_MAX - LEVEL.SKYBRIDGE_Y_MIN - hgt);
        const nx = ax === 'x' ? sg : 0;
        const nz = ax === 'z' ? sg : 0;
        const cx = fp.x + nx * (w / 2 + 0.4);
        const cz = fp.z + nz * (w / 2 + 0.4);
        addNeon(cx, y, cz, ax === 'x' ? 0 : 1, ax === 'x' ? 1 : 0, w, hgt, Math.floor(rng() * 8));
        G.steel.push(boxAt(Math.abs(nx) * (w + 0.4) + 0.12, 0.12, Math.abs(nz) * (w + 0.4) + 0.12, fp.x + (nx * (w + 0.4)) / 2, y + hgt / 2 + 0.1, fp.z + (nz * (w + 0.4)) / 2));
        if (rng() < 0.6) addBeacon(new THREE.Vector3(cx, y + hgt / 2 + 0.9, cz), 'SIGN');
      }
      // 5B-3 emblem / geometric hologram on the mid floors (14 m … below the terrace / 42 m).
      if (lowTop >= 26 && signFaces.length && srng() < 0.42) {
        const [ax, sg] = signFaces[Math.floor(srng() * signFaces.length)];
        busyFaces.add(fkey(b, ax, sg));
        const sz = 4.5 + srng() * 2.5;
        const top = Math.min(lowTop - 6, 42);
        const y = 14 + sz / 2 + srng() * Math.max(0, top - 14 - sz);
        facePoint(b, ax, sg, 0.3 + srng() * 0.4, fp);
        const nx = ax === 'x' ? sg : 0;
        const nz = ax === 'z' ? sg : 0;
        addNeon(fp.x + nx * (b.arch === ARCH_A ? AR.MULLION_D + 0.12 : 0.12), y, fp.z + nz * (b.arch === ARCH_A ? AR.MULLION_D + 0.12 : 0.12), nx, nz, sz, sz, Math.floor(srng() * SIGN_ATLAS.EMBLEMS), 2);
      }
      // 5B-3 vertical concrete fins on Type B street faces without balconies (decorative, ≤ 0.45 m: no collider).
      if (b.arch === ARCH_B && lowTop >= 16) {
        for (const [ax, sg] of streetFaces) {
          const key = fkey(b, ax, sg);
          if (runFaces.has(key) || balconyFaces.has(key) || busyFaces.has(key) || srng() < 0.45) continue;
          const len = (ax === 'x' ? b.lotHalfD : b.lotHalfW) * 2;
          const n = 3 + Math.floor(srng() * 3);
          const y0 = SB.CANOPY_Y + 0.9;
          const y1 = lowTop - 1.2;
          for (let k = 0; k < n; k++) {
            const along = -len / 2 + len * (0.15 + (0.7 * k) / Math.max(1, n - 1));
            if (ax === 'x') G.bodies.push(plainBody(boxAt(0.42, y1 - y0, 0.2, b.cx + sg * (b.lotHalfW + 0.21), (y0 + y1) / 2, b.cz + along), b.seed, ARCH_B));
            else G.bodies.push(plainBody(boxAt(0.2, y1 - y0, 0.42, b.cx + along, (y0 + y1) / 2, b.cz + sg * (b.lotHalfD + 0.21)), b.seed, ARCH_B));
          }
        }
      }
      const vendFaces = streetFaces.filter(([ax, sg]) => !escapeFaces.has(fkey(b, ax, sg)) && !ductFaces.has(fkey(b, ax, sg)));
      if (vendFaces.length && rng() < 0.75) {
        const [ax, sg] = vendFaces[Math.floor(rng() * vendFaces.length)];
        facePoint(b, ax, sg, 0.2 + rng() * 0.5, fp);
        const yaw = ax === 'x' ? (sg > 0 ? Math.PI / 2 : -Math.PI / 2) : sg > 0 ? 0 : Math.PI;
        const n = 2 + Math.floor(rng() * 2);
        const off = 0.45;
        for (let k = 0; k < n; k++) {
          const x = fp.x + (ax === 'x' ? sg * off : k * 1.05);
          const z = fp.z + (ax === 'z' ? sg * off : k * 1.05);
          if (inArea(x, z, 2)) addVending(x, z, yaw);
        }
      }
    });

    // 6A-1: exact night-light census of the rendered facades (same integer hash as the tower shader):
    // every room cell on every full typical floor of every tower face, mechanical floors excluded.
    const facadeRooms = [0, 0, 0, 0];
    const censusFace = (b: Building, nx: number, nz: number, w0: number, w1: number, y0: number, y1: number): void => {
      const si = seedInt(b.seed);
      const roomW = FACADE.TILE_W_M / roomsPerTile(b.arch);
      const off = roomOffset(si, b.arch) * roomW;
      const [a0, a1] = nx > 0.5 || nz < -0.5 ? [-w1, -w0] : [w0, w1];
      const r0 = Math.floor((a0 + off) / roomW + 1e-6);
      const r1 = Math.floor((a1 + off) / roomW - 1e-6);
      const face = faceKey(nx, nz);
      for (let n = 1; facadeFloorY(b.arch, n) + FACADE.FLOOR_H_M <= y1 + 1e-3; n++) {
        if (facadeFloorY(b.arch, n) < y0 - 1e-3 || isMachineFloor(si, n)) continue;
        for (let r = r0; r <= r1; r++) facadeRooms[facadeRoomState(si, face, r, n)]++;
      }
    };
    buildings.forEach((b) => {
      const top = lowTopOf(b) - 0.45;
      for (const [ax, sg] of FACES) {
        const y0 = 0;
        if (ax === 'x') censusFace(b, sg, 0, b.rect.z0, b.rect.z1, y0, top);
        else censusFace(b, 0, sg, b.rect.x0, b.rect.x1, y0, top);
        if (b.setbackY > 0) {
          if (ax === 'x') censusFace(b, sg, 0, b.cz - b.halfD, b.cz + b.halfD, b.setbackY, b.roofY - 0.45);
          else censusFace(b, 0, sg, b.cx - b.halfW, b.cx + b.halfW, b.setbackY, b.roofY - 0.45);
        }
      }
    });

    // Plazas (unbuilt lots): kiosk + parking rows.
    const parkingSlots: CarSlot[] = [];
    plazas.forEach((r) => {
      const cx = (r.x0 + r.x1) / 2;
      const cz = (r.z0 + r.z1) / 2;
      if (inArea(cx, cz, 4)) addVending(cx + (r.x1 - r.x0) * 0.25, cz, 0, 1.6);
      for (let x = r.x0 + 3; x < r.x1 - 3; x += 2.8) {
        for (const z of [r.z0 + 3.2, r.z1 - 3.2]) parkingSlots.push({ x, z, y: 0, yaw: z < cz ? 0 : Math.PI, onHighway: false });
      }
    });

    // ------------------------------------------------------------------ 9. street lamps + curbside slots
    const carSlots: CarSlot[] = [];
    const occupied = (x: number, z: number, m: number): boolean =>
      intersectionSquares.some((r) => insideRect(x, z, r, m)) ||
      crosswalkZones.some((r) => insideRect(x, z, r, m)) ||
      rampRects.some((r) => insideRect(x, z, r, m)) ||
      pierRects.some((r) => insideRect(x, z, r, m + 1));
    streets.forEach((s, si) => {
      const lh = laneHalf(s.kind);
      for (const [a0, a1] of segmentsByStreet[si]) {
        for (let a = a0 + 7; a < a1 - 5; a += 18) {
          for (const side of [-1, 1]) {
            const p = pt(s.axis, a, 0, s.coord + side * (lh + 0.75));
            if (!inArea(p.x, p.z, 1)) continue;
            const yaw = s.axis === 'z' ? (side > 0 ? -Math.PI / 2 : Math.PI / 2) : side > 0 ? Math.PI : 0;
            addLamp(p.x, p.z, yaw);
          }
        }
        for (let a = a0 + 6.5; a < a1 - 5; a += 6.4) {
          for (const side of [-1, 1]) {
            const p = pt(s.axis, a, 0, s.coord + side * (lh - 1.3));
            if (!inArea(p.x, p.z, 4) || occupied(p.x, p.z, 2.5)) continue;
            const yaw = s.axis === 'z' ? (side > 0 ? 0 : Math.PI) : side > 0 ? Math.PI / 2 : -Math.PI / 2;
            carSlots.push({ x: p.x, z: p.z, y: 0, yaw, onHighway: false });
          }
        }
      }
    });
    const hwSlots: CarSlot[] = [];
    decks.forEach((d) => {
      for (let a = Math.max(d.a0, -H + 8) + 5; a < Math.min(d.a1, H - 8) - 5; a += 9) {
        for (const lat of [-5.25, 5.25]) {
          const p = pt(d.axis, a, DECK, d.coord + lat);
          if (highwayRects.some((r, ri) => ri !== d.hi && insideRect(p.x, p.z, r, 2))) continue;
          hwSlots.push({ x: p.x, z: p.z, y: DECK, yaw: d.axis === 'z' ? (lat > 0 ? 0 : Math.PI) : lat > 0 ? Math.PI / 2 : -Math.PI / 2, onHighway: true });
        }
      }
    });

    // ------------------------------------------------------------------ 10. player spawn
    const av = streets[plan.avenue];
    const avRamp = rampInfo.find((ri) => ri.r.street === plan.avenue);
    const spawnLane = avRamp ? -avRamp.r.side : -1;
    const playerSpawn = pt(av.axis, plan.spawnAlong, 0, av.coord + spawnLane * laneHalf(av.kind) * 0.5);
    const fwd = pt(av.axis, plan.gateDir, 0, 0, new THREE.Vector3());
    const playerSpawnYaw = Math.atan2(-fwd.x, -fwd.z);

    // ------------------------------------------------------------------ 11. parked cars (exact count)
    const nCars = sector.parkedCars;
    const shuffle = <T,>(arr: T[]): T[] => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    };
    const farFromSpawn = (c: CarSlot): boolean => Math.hypot(c.x - playerSpawn.x, c.z - playerSpawn.z) > 7;
    const pick: CarSlot[] = shuffle(hwSlots.filter(farFromSpawn)).slice(0, plan.highways.length * 3);
    for (const c of shuffle([...carSlots, ...parkingSlots].filter(farFromSpawn))) {
      if (pick.length >= nCars) break;
      if (pick.some((o) => Math.abs(o.y - c.y) < 1 && Math.hypot(o.x - c.x, o.z - c.z) < 5.2)) continue;
      pick.push(c);
    }
    if (pick.length !== nCars) throw new Error(`Sector ${sector.index}: placed ${pick.length}/${nCars} parked cars`);
    const carDims: Array<[number, number, number]> = [[1.95, 1.2, 4.5], [1.95, 1.4, 4.6], [2.0, 1.95, 4.8]];
    for (const c of pick) {
      const variant = Math.floor(rng() * 3) as 0 | 1 | 2;
      const mesh = this.cars[variant];
      const idx = carCounts[variant]++;
      placeInstance(mesh, idx, c.x, c.y, c.z, c.yaw);
      (mesh.geometry.getAttribute('aCar') as THREE.InstancedBufferAttribute).setXYZW(
        idx,
        rng() < 0.5 ? 1 : 0,
        MATERIALS.CAR_BODY.emissive + rng() * (MATERIALS.CAR_BODY.emissiveMax - MATERIALS.CAR_BODY.emissive),
        rng() < 0.2 ? 1 : 0,
        rng(),
      );
      const [w, hgt, l] = carDims[variant];
      const alongZ = Math.abs(Math.cos(c.yaw)) > 0.5;
      const hx = (alongZ ? w : l) / 2;
      const hz = (alongZ ? l : w) / 2;
      colliders.push({ min: new THREE.Vector3(c.x - hx, c.y, c.z - hz), max: new THREE.Vector3(c.x + hx, c.y + hgt, c.z + hz), kind: 'CAR', building: -1 });
      if (!c.onHighway) {
        // Cover position beside the car (toward the district centre).
        const ox = alongZ ? -Math.sign(c.x || 1) * 2.2 : 0;
        const oz = alongZ ? 0 : -Math.sign(c.z || 1) * 2.2;
        groundSpawns.push({ position: new THREE.Vector3(c.x + ox, 0, c.z + oz), layer: 0, building: -1 });
      }
    }

    // ------------------------------------------------------------------ 12. lockdown barrier + emerald gate
    const gateHalf = corridorHalf(av);
    const gatePos = pt(av.axis, plan.gateDir * H, 0, av.coord);
    const sides: Array<{ axis: Axis; at: number }> = [{ axis: 'x', at: H }, { axis: 'x', at: -H }, { axis: 'z', at: H }, { axis: 'z', at: -H }];
    for (const side of sides) {
      // Barrier plane perpendicular to `side.axis` at `side.at`, running along the other axis.
      const runAxis: Axis = side.axis === 'x' ? 'z' : 'x';
      const openings: Array<{ l0: number; l1: number; y0: number; y1: number; kind: number }> = [];
      streets.forEach((s, si) => {
        if (s.axis !== side.axis || !streetRanges[si].some(([r0, r1]) => r0 < side.at && r1 > side.at)) return;
        const ch = corridorHalf(s);
        const isGate = si === plan.avenue && Math.sign(side.at) === plan.gateDir;
        openings.push({ l0: s.coord - ch, l1: s.coord + ch, y0: 0, y1: isGate ? 16 : 8, kind: isGate ? 2 : 1 });
      });
      canals.forEach((c) => {
        if (c.axis === side.axis && c.from < side.at && c.to > side.at) openings.push({ l0: c.coord - c.width / 2, l1: c.coord + c.width / 2, y0: LEVEL.CANAL_WATER_Y, y1: 4, kind: 1 });
      });
      plan.highways.forEach((h) => {
        if (h.axis === side.axis && h.from < side.at && h.to > side.at) openings.push({ l0: h.coord - HW, l1: h.coord + HW, y0: UNDER, y1: DECK + 4, kind: 1 });
      });
      const n = pt(runAxis, 0, 0, -Math.sign(side.at), new THREE.Vector3());
      const seg = (l0: number, l1: number, y0: number, y1: number, kind: number, inset: number): void => {
        const at = side.at - Math.sign(side.at) * inset;
        G.barrier.push(quad([pt(runAxis, l0, y0, at), pt(runAxis, l1, y0, at), pt(runAxis, l1, y1, at), pt(runAxis, l0, y1, at)], [0, 0, 1, 0, 1, 1, 0, 1], n, { aKind: [kind] }));
      };
      seg(-H, H, LEVEL.CANAL_WATER_Y, LEVEL.BOUNDARY_HEIGHT_M, 0, 0);
      for (const o of openings) seg(o.l0, o.l1, o.y0, o.y1, o.kind, 0.05);
      const gateOpening = openings.find((o) => o.kind === 2);
      const wall = (l0: number, l1: number, gate: boolean): void => {
        const p0 = pt(runAxis, l0, -5, side.at - 0.5);
        const p1 = pt(runAxis, l1, LEVEL.BOUNDARY_HEIGHT_M, side.at + 0.5);
        colliders.push({ min: new THREE.Vector3(Math.min(p0.x, p1.x), -5, Math.min(p0.z, p1.z)), max: new THREE.Vector3(Math.max(p0.x, p1.x), LEVEL.BOUNDARY_HEIGHT_M, Math.max(p0.z, p1.z)), kind: 'BARRIER', building: -1, gate });
      };
      if (gateOpening) {
        wall(-H, gateOpening.l0, false);
        wall(gateOpening.l0, gateOpening.l1, true);
        wall(gateOpening.l1, H, false);
      } else {
        wall(-H, H, false);
      }
    }

    // ------------------------------------------------------------------ 13. far field
    this.layoutFarTowers(createRng(0xfa77 + sector.index * 31), plan);
    this.farInfo.forEach((t, i) => {
      if (i % 2 === 0) addAviation(t.x, t.top + 0.4, t.z);
      if (i % 6 === 0) addSearch(t.x, t.top + 0.5, t.z);
      if (i % 3 === 0) {
        const toC = Math.atan2(-t.x, -t.z);
        const nx = Math.sin(toC);
        const nz = Math.cos(toC);
        const sh = 26 + (i % 7) * 5;
        const y = Math.min(t.top - sh / 2 - 6, 70 + (i % 5) * 18);
        addNeon(t.x + nx * (Math.min(t.w, t.d) / 2 + 1.5), y, t.z + nz * (Math.min(t.w, t.d) / 2 + 1.5), nx, nz, sh / 6.5, sh, i);
      }
    });
    [...buildings].sort((p, o) => o.roofY - p.roofY).slice(0, 2).forEach((b) => addSearch(b.cx, b.roofY + 0.6, b.cz));

    // ------------------------------------------------------------------ 14. enemy spawn points by layer
    buildings.forEach((b) => {
      if (b.roofY < LEVEL.ROOF_LAYER_Y_MIN) return;
      for (let i = 0; i < 4; i++) {
        const r = tryPlace(b, 0.6, 0.6, 1.8);
        if (r) roofSpawns.push({ position: new THREE.Vector3((r.x0 + r.x1) / 2, b.roofY, (r.z0 + r.z1) / 2), layer: 3, building: b.index });
      }
    });
    [...buildings].sort((p, o) => o.roofY - p.roofY).slice(0, Math.max(3, Math.ceil(buildings.length / 4))).forEach((b) => {
      const dx = playerSpawn.x - b.cx;
      const dz = playerSpawn.z - b.cz;
      const alongX = Math.abs(dx) >= Math.abs(dz);
      for (const lat of [-0.4, 0.4]) {
        const px = alongX ? b.cx + Math.sign(dx) * (b.halfW - 1.4) : b.cx + lat * b.halfW;
        const pz = alongX ? b.cz + lat * b.halfD : b.cz + Math.sign(dz) * (b.halfD - 1.4);
        perchSpawns.push({ position: new THREE.Vector3(px, b.roofY, pz), layer: 3, building: b.index });
      }
    });
    decks.forEach((d) => {
      for (let a = Math.max(d.a0, -H + 10); a < Math.min(d.a1, H - 10); a += 18) {
        const p = pt(d.axis, a, DECK, d.coord + (rng() < 0.5 ? -2.5 : 2.5));
        if (Math.hypot(p.x - playerSpawn.x, p.z - playerSpawn.z) > 25) highwaySpawns.push({ position: p, layer: 1, building: -1 });
      }
    });
    const airCandidates: Array<[number, number]> = intersectionSquares.map((r) => [(r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2]);
    streets.forEach((s, si) => segmentsByStreet[si].forEach(([a0, a1]) => {
      for (let a = a0 + 8; a < a1 - 4; a += 20) {
        const p = pt(s.axis, a, 0, s.coord);
        airCandidates.push([p.x, p.z]);
      }
    }));
    if (plan.plaza) airCandidates.push([0, 0], [plan.plaza.x0 + 6, plan.plaza.z0 + 6], [plan.plaza.x1 - 6, plan.plaza.z1 - 6]);
    for (const [x, z] of airCandidates) {
      if (!inArea(x, z, 6)) continue;
      const underDeck = highwayRects.some((r) => insideRect(x, z, r, 2));
      airSpawns.push(new THREE.Vector3(x, underDeck ? 13 + rng() * 9 : 6 + rng() * 16, z));
    }
    plazas.forEach((r) => groundSpawns.push({ position: new THREE.Vector3((r.x0 + r.x1) / 2, 0, (r.z0 + r.z1) / 2), layer: 0, building: -1 }));
    const keptGround = groundSpawns.filter((s) => Math.hypot(s.position.x - playerSpawn.x, s.position.z - playerSpawn.z) > 30 && inArea(s.position.x, s.position.z, 3));
    groundSpawns.length = 0;
    groundSpawns.push(...keptGround);
    const keptBridge = bridgeSpawns.filter((s) => Math.hypot(s.position.x - playerSpawn.x, s.position.z - playerSpawn.z) > 30 && inArea(s.position.x, s.position.z, 3));
    bridgeSpawns.length = 0;
    bridgeSpawns.push(...keptBridge);

    // ------------------------------------------------------------------ 15. cinematic loop (title attract)
    const lane = av.coord + spawnLane * 3.5;
    const g = plan.gateDir;
    const cp = (along: number, y: number): THREE.Vector3 => pt(av.axis, along, y, lane);
    const cinematicPath = [
      cp(-g * 76, 3.4), cp(-g * 40, 3.4), cp(0, 3.6), cp(g * 40, 3.4), cp(g * 72, 4.2),
      cp(g * 84, 30), cp(g * 80, 82), cp(g * 50, 112), cp(0, 114), cp(-g * 50, 112), cp(-g * 80, 82), cp(-g * 86, 30),
    ];

    // ------------------------------------------------------------------ 16. commit merged geometry & instances
    const mk = (geos: THREE.BufferGeometry[], mat: THREE.Material, name: string, renderOrder = 0): THREE.Mesh => {
      const geo = mergeOrEmpty(geos);
      for (const gg of geos) gg.dispose();
      const m = new THREE.Mesh(geo, mat);
      m.name = name;
      m.renderOrder = renderOrder;
      this.sectorGroup.add(m);
      this.sectorDisposables.push(geo);
      return m;
    };
    mk(G.concrete, this.concreteMat, 'GroundConcreteRoofs');
    mk(G.road, this.roadMat, 'Roads');
    mk(G.water, this.waterMat, 'CanalWater');
    mk(G.hw, this.hwConcreteMat, 'ExpresswayBridgeConcrete');
    mk(G.strips, this.stripMat, 'LightStrips');
    mk(G.steel.map(stripUv), this.steelMat, 'Steel');
    mk(G.glass, this.glassMat, 'SkybridgeGlass');
    mk(G.glassT, this.shopGlassMat, 'BalconyShopGlass');
    mk(G.bodies, this.buildingMat, 'Towers');
    mk(G.barrier, this.barrierMat, 'LockdownBarrier', 8).frustumCulled = false;

    const commit = (m: THREE.InstancedMesh, n: number): void => {
      m.count = n;
      m.instanceMatrix.needsUpdate = true;
    };
    this.cars.forEach((m, i) => {
      commit(m, carCounts[i]);
      (m.geometry.getAttribute('aCar') as THREE.InstancedBufferAttribute).needsUpdate = true;
    });
    // 5B-3 steam: ~40 % canal mist just above the water, the rest from street manholes / curbside ducts.
    let steamN = 0;
    const steamTotal = SB.STEAM_MIN + Math.floor(srng() * (SB.STEAM_MAX - SB.STEAM_MIN + 1));
    const addSteam = (x: number, y: number, z: number, size: number): void => {
      if (steamN >= steamTotal || steamN >= CAP.STEAM || !inArea(x, z, -10)) return;
      _m4.makeTranslation(x, y, z);
      this.steam.setMatrixAt(steamN, _m4);
      steamAttr.setXYZW(steamN, srng(), size, 0.06 + srng() * 0.07, srng());
      steamN++;
    };
    const canalSteam = canalWater.length ? Math.round(steamTotal * 0.4) : 0;
    for (let k = 0; k < canalSteam * 4 && steamN < canalSteam; k++) {
      const r = canalWater[Math.floor(srng() * canalWater.length)];
      addSteam(r.x0 + srng() * (r.x1 - r.x0), LEVEL.CANAL_WATER_Y + 0.4, r.z0 + srng() * (r.z1 - r.z0), 2.2 + srng() * 1.6);
    }
    for (let k = 0; k < steamTotal * 6 && steamN < steamTotal; k++) {
      const si = Math.floor(srng() * streets.length);
      const segs = segmentsByStreet[si];
      if (!segs.length) continue;
      const [a0, a1] = segs[Math.floor(srng() * segs.length)];
      const st = streets[si];
      const q = pt(st.axis, a0 + srng() * (a1 - a0), 0.1, st.coord + (srng() * 2 - 1) * laneHalf(st.kind) * 0.8);
      if (occupied(q.x, q.z, 0.5)) continue;
      addSteam(q.x, q.y, q.z, 1.3 + srng() * 1.1);
    }
    this.steam.count = steamN;
    this.steam.instanceMatrix.needsUpdate = true;
    steamAttr.needsUpdate = true;

    commit(this.lamps, counts.lamp);
    commit(this.lampHalos, counts.lamp);
    lampTint.needsUpdate = true;
    commit(this.vending, counts.vend);
    vendTint.needsUpdate = true;
    commit(this.guardrails, counts.rail);
    commit(this.acUnits, counts.ac);
    commit(this.ducts, counts.duct);
    commit(this.fences, counts.fence);
    commit(this.antennas, counts.ant);
    commit(this.machineRooms, counts.room);
    commit(this.aviation, counts.avi);
    aviPhase.needsUpdate = true;
    commit(this.neonSigns, counts.neon);
    neonStrip.needsUpdate = true;
    neonFormat.needsUpdate = true;
    this.searchlights.count = counts.search;
    searchBase.needsUpdate = true;
    searchParams.needsUpdate = true;
    commit(this.beacons, counts.beacon);
    commit(this.halos, counts.beacon);
    this.gatePillar.position.copy(gatePos).addScaledVector(fwd, 6);

    const center = new THREE.Vector3();
    buildings.forEach((b) => center.add(_pos.set(b.cx, 0, b.cz)));
    center.divideScalar(Math.max(1, buildings.length));

    this.layout = {
      sector,
      loop,
      buildings: buildings.map(({ index, cx, cz, halfW, halfD, roofY, arch }) => ({ index, cx, cz, halfW, halfD, roofY, arch })),
      colliders,
      ramps: rampColliders,
      anchors,
      facadeFeatures,
      canalWater,
      playerSpawn,
      playerSpawnYaw,
      groundSpawns,
      highwaySpawns,
      bridgeSpawns,
      skybridgeSpawns,
      roofSpawns,
      perchSpawns,
      airSpawns,
      gate: { position: gatePos, normal: fwd.clone(), halfWidth: gateHalf, height: 16, open: false },
      center,
      cinematicPath,
      stats: {
        towers: buildings.length,
        cars: pick.length,
        highways: plan.highways.length,
        ramps: rampColliders.length,
        bridges: bridgeSpans.length,
        skybridges: skybridgeCount,
        lamps: counts.lamp,
        cityLights: this.lightCount,
        archetypes: [ARCH_A, ARCH_B, ARCH_C, ARCH_D].map((a) => buildings.filter((b) => b.arch === a).length),
        balconies: balconyCount,
        fireEscapes: escapeCount,
        escapeFlights: flightCount,
        shutterFronts: shutterFaces.size,
        facadeRooms,
      },
    };
    this.towers = buildings;
    this.setGateOpen(false);
    return this.layout;
  }

  /**
   * Street-grid lots: blocks between corridors with a 1.2 m street setback, split by 6 m alleys.
   * Narrow-alley sectors split every block; others split at random but always at least `skyBridges` blocks
   * (each split creates a wall-run alley that can carry a Layer-2 sky-bridge). `pair` ≥ 0 marks split pieces.
   */
  private computeLots(plan: DistrictPlan, sector: SectorDef, rng: () => number): Array<{ r: RectXZ; pair: number }> {
    const cutsX: Array<[number, number]> = [];
    const cutsZ: Array<[number, number]> = [];
    for (const s of plan.streets) {
      const ch = corridorHalf(s);
      (s.axis === 'z' ? cutsX : cutsZ).push([s.coord - ch, s.coord + ch]);
    }
    for (const c of plan.canals) {
      const ch = canalCorridorHalf(c);
      (c.axis === 'z' ? cutsX : cutsZ).push([c.coord - ch, c.coord + ch]);
    }
    const xs = subtractIntervals(-H, H, cutsX).filter(([a, b]) => b - a >= 12);
    const zs = subtractIntervals(-H, H, cutsZ).filter(([a, b]) => b - a >= 12);
    const setback = 1.2;
    const alley = LEVEL.ALLEY_WIDTH_M;
    const minSplitLong = 20 + alley;
    const blocks: Array<{ r: RectXZ; long: number; split: boolean }> = [];
    for (const [x0, x1] of xs) {
      for (const [z0, z1] of zs) {
        const r = rectFrom(x0 + setback, z0 + setback, x1 - setback, z1 - setback);
        const long = Math.max(r.x1 - r.x0, r.z1 - r.z0);
        blocks.push({ r, long, split: sector.narrowAlleys ? long >= minSplitLong : long >= 34 && rng() < 0.6 });
      }
    }
    let splits = blocks.filter((b) => b.split).length;
    for (const b of [...blocks].sort((p, o) => o.long - p.long)) {
      if (splits >= sector.skyBridges + 1) break;
      if (!b.split && b.long >= minSplitLong) {
        b.split = true;
        splits++;
      }
    }
    const lots: Array<{ r: RectXZ; pair: number }> = [];
    blocks.forEach((b, bi) => {
      const r = b.r;
      const w = r.x1 - r.x0;
      const d = r.z1 - r.z0;
      if (!b.split) {
        lots.push({ r: rectFrom(r.x0, r.z0, Math.min(r.x1, r.x0 + 34), Math.min(r.z1, r.z0 + 34)), pair: -1 });
        return;
      }
      const pieces = b.long >= 54 ? 3 : 2;
      const each = (b.long - alley * (pieces - 1)) / pieces;
      for (let i = 0; i < pieces; i++) {
        const o = i * (each + alley);
        const piece = w >= d ? rectFrom(r.x0 + o, r.z0, r.x0 + o + each, r.z1) : rectFrom(r.x0, r.z0 + o, r.x1, r.z0 + o + each);
        lots.push({ r: rectFrom(piece.x0, piece.z0, Math.min(piece.x1, piece.x0 + 34), Math.min(piece.z1, piece.z0 + 34)), pair: bi });
      }
    });
    // Ensure enough lots by splitting the largest remaining ones.
    let guard = 0;
    while (lots.length < sector.buildingCount && guard++ < 40) {
      lots.sort((a, b) => (b.r.x1 - b.r.x0) * (b.r.z1 - b.r.z0) - (a.r.x1 - a.r.x0) * (a.r.z1 - a.r.z0));
      const l = lots.shift();
      if (!l) break;
      const r = l.r;
      const w = r.x1 - r.x0;
      const d = r.z1 - r.z0;
      if (Math.max(w, d) < minSplitLong) {
        lots.push(l);
        break;
      }
      const each = (Math.max(w, d) - alley) / 2;
      const pair = 1000 + guard;
      if (w >= d) lots.push({ r: rectFrom(r.x0, r.z0, r.x0 + each, r.z1), pair }, { r: rectFrom(r.x0 + each + alley, r.z0, r.x1, r.z1), pair });
      else lots.push({ r: rectFrom(r.x0, r.z0, r.x1, r.z0 + each), pair }, { r: rectFrom(r.x0, r.z0 + each + alley, r.x1, r.z1), pair });
    }
    return lots.filter((l) => l.r.x1 - l.r.x0 >= 10 && l.r.z1 - l.r.z0 >= 10);
  }

  /** Far-field ring: towers capping every corridor that leaves the district, then up to 100 in total. */
  private layoutFarTowers(rng: () => number, plan: DistrictPlan): void {
    const seedAttr = this.farTowers.geometry.getAttribute('aSeed') as THREE.InstancedBufferAttribute;
    const archAttr = this.farTowers.geometry.getAttribute('aArch') as THREE.InstancedBufferAttribute;
    this.farInfo.length = 0;
    const corridors: Array<{ axis: Axis; l0: number; l1: number }> = [];
    plan.streets.forEach((s) => corridors.push({ axis: s.axis, l0: s.coord - corridorHalf(s), l1: s.coord + corridorHalf(s) }));
    plan.canals.forEach((c) => corridors.push({ axis: c.axis, l0: c.coord - canalCorridorHalf(c), l1: c.coord + canalCorridorHalf(c) }));
    plan.highways.forEach((h) => corridors.push({ axis: h.axis, l0: h.coord - 9, l1: h.coord + 9 }));
    const place = (x: number, z: number, w: number, d: number, top: number): void => {
      if (this.farInfo.length >= LIMITS.FAR_BUILDINGS) return;
      for (const o of this.farInfo) if (Math.abs(o.x - x) < (o.w + w) / 2 + 6 && Math.abs(o.z - z) < (o.d + d) / 2 + 6) return;
      const i = this.farInfo.length;
      _pos.set(x, top / 2, z);
      _quat.identity();
      _scl.set(w, top, d);
      _m4.compose(_pos, _quat, _scl);
      this.farTowers.setMatrixAt(i, _m4);
      const seed = rng();
      seedAttr.setX(i, seed);
      // Distant supertalls: mostly glass corporate towers, some residential slabs and industrial blocks.
      const h = (seed * 13.37) % 1;
      archAttr.setX(i, top < 70 ? (h < 0.5 ? ARCH_B : ARCH_C) : h < 0.62 ? ARCH_A : h < 0.9 ? ARCH_B : ARCH_D);
      this.farInfo.push({ x, z, w, d, top });
    };
    // Corridor caps just past the visual extent so no street / canal / expressway runs into the void.
    for (const c of corridors) {
      if (c.l1 < -H - 20 || c.l0 > H + 20) continue;
      for (const end of [-1, 1]) {
        const w = c.l1 - c.l0 + 14;
        const p = pt(c.axis, end * (VIS + 16), 0, (c.l0 + c.l1) / 2);
        place(p.x, p.z, c.axis === 'z' ? w : 30, c.axis === 'z' ? 30 : w, 90 + rng() * 140);
      }
    }
    let guard = 0;
    while (this.farInfo.length < LIMITS.FAR_BUILDINGS && guard++ < 6000) {
      const ang = rng() * Math.PI * 2;
      const dist = LEVEL.FAR_RING_INNER_M + Math.pow(rng(), 0.8) * (LEVEL.FAR_RING_OUTER_M - LEVEL.FAR_RING_INNER_M);
      const x = Math.cos(ang) * dist;
      const z = Math.sin(ang) * dist;
      const w = 20 + rng() * 40;
      const d = 20 + rng() * 40;
      const hitsCorridor = corridors.some((c) => {
        const lat = c.axis === 'z' ? x : z;
        const along = c.axis === 'z' ? z : x;
        return Math.abs(along) < VIS + 4 && lat + w / 2 > c.l0 - 2 && lat - w / 2 < c.l1 + 2;
      });
      if (!hitsCorridor) place(x, z, w, d, 50 + rng() * 210 + (dist - LEVEL.FAR_RING_INNER_M) * 0.08);
    }
    this.farTowers.count = this.farInfo.length;
    this.farTowers.instanceMatrix.needsUpdate = true;
    seedAttr.needsUpdate = true;
    archAttr.needsUpdate = true;
    this.farTowers.computeBoundingSphere();
  }

  private clearSector(): void {
    for (const c of [...this.sectorGroup.children]) this.sectorGroup.remove(c);
    for (const d of this.sectorDisposables) d.dispose();
    this.sectorDisposables = [];
  }

  // ===========================================================================================
  // Runtime
  // ===========================================================================================
  /** Opens / closes the emerald district gate (barrier section turns jade + light pillar). */
  setGateOpen(open: boolean): void {
    this.uGateOpen.value = open ? 1 : 0;
    this.gatePillar.visible = open;
    if (this.layout) this.layout.gate.open = open;
  }

  /** FLOW Rank A+: building neon emissive +25 %. */
  setNeonBoost(boost: number): void {
    this.uNeonBoost.value = 1 + boost;
  }

  /** FLOW Rank SS+: searchlights pulse with the beat (0..1). */
  setSearchlightPulse(v: number): void {
    this.uSearchPulse.value = v;
  }

  /**
   * @param simTime scaled simulation time (bullet time slows ripples, flow, holograms, traffic)
   * @param cameraPos sky follows the camera; the nearest city lights are selected for reflections
   */
  update(simTime: number, cameraPos: THREE.Vector3): void {
    this.uTime.value = simTime;
    this.sky.position.copy(cameraPos);

    // Nearest-N city light selection (allocation-free partial selection).
    const n = this.lightCount;
    for (let i = 0; i < n; i++) {
      const dx = this.lightPos[i * 3] - cameraPos.x;
      const dy = this.lightPos[i * 3 + 1] - cameraPos.y;
      const dz = this.lightPos[i * 3 + 2] - cameraPos.z;
      this.lightDist[i] = dx * dx + dy * dy + dz * dz;
    }
    const take = Math.min(MAX_LIGHTS, n);
    const posU = this.uCityLightPos.value;
    const colU = this.uCityLightCol.value;
    for (let k = 0; k < take; k++) {
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < n; i++) {
        if (this.lightDist[i] < bestD) {
          bestD = this.lightDist[i];
          best = i;
        }
      }
      if (best < 0) break;
      this.lightDist[best] = Infinity;
      posU[k].set(this.lightPos[best * 3], this.lightPos[best * 3 + 1], this.lightPos[best * 3 + 2]);
      colU[k].set(this.lightCol[best * 3], this.lightCol[best * 3 + 1], this.lightCol[best * 3 + 2]);
    }
    this.uCityLightCount.value = take;
  }
}
