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
import { ARCHETYPE, BALCONY, CITY_FX, CITY_SHADING, COLORS, FACADE, FIRE_ESCAPE, LEVEL, LIMITS, MATERIALS, NEON_BLOOM, PHYSICS, RENDER, SILHOUETTE, createRng, clamp } from '../config/constants';
import { ARCH_A, ARCH_B, ARCH_C, ARCH_D, GLSL_FACADE, facadeFloorY, facadeRoomState, faceKey, isMachineFloor, roomOffset, roomsPerTile, seedInt } from './FacadeLighting';
import { SECTORS, type MegaStructureKind, type SectorDef } from '../config/skills';
import { MEGA_ATLAS, NEON_STRIP_GLOW, ROAD_ATLAS, SIGN_ATLAS, type AtlasRegion, type ProceduralTextureLibrary } from '../engine/ProceduralTextures';
import {
  GRAMMAR,
  PAINT,
  PROGRAM_SOCKETS,
  aoBox,
  aoPipe,
  applyAo,
  assignMassings,
  assignPrograms,
  baySocket,
  doorClearZone,
  DOOR_PIER_GAP_M,
  DOOR_SURROUND_M,
  doorSockets,
  galleryDoorFit,
  groundDoorFit,
  ensureAo,
  faceKeyOf,
  floorTopY,
  heightBand,
  isOnFloorGrid,
  onSolidRoof,
  parapetSegments,
  planGallery,
  planGroundFace,
  planMassing,
  quantizeToFloors,
  canMega,
  withTint,
  type FaceSpan,
  type GroundProgram,
  type MassingCandidate,
  type MassingKind,
  type MassingPlan,
  type PropSocket,
  MASSING_KINDS,
  MEGA_KINDS,
  isMegaKind,
} from './BuildingGrammar';
import {
  PROPS,
  alleyCentreBand,
  alleyStrips,
  composeSockets,
  planClutter,
  planDecals,
  toAabb,
  type Aabb3,
  type ClutterStrip,
  type DecalSurface,
  type KitId,
  type PropInstance,
} from './CityProps';
import { CityPropMeshes, type ContactShadowDesc, type DestructiblePropRecord } from './CityPropMeshes';
import { AnimatedEnvKit, ENV_CAP, ENV_DIMS, ENV_VARIANT, ElevatedTraffic, buildTrafficLanes, inTrafficLane, type CityLightInjector, type EnvInstance, type TrafficLane } from './CityAtmosphere';
import { doorSafeOpenRad, type DoorSpec, type GlassSpec } from '../entities/DestructibleManager';
import {
  InteriorPropsKit,
  interiorPropRecord,
  interiorVolumeOf,
  planInteriors,
  planSkyNotch,
  bayPodPieces,
  SKY_NOTCH,
  splitMassBox,
  type InteriorHost,
  type InteriorHostFace,
  type InteriorOpening,
  type InteriorPlan,
  type InteriorPropRecord,
  type InteriorVolume,
  type ShellPiece,
} from './InteriorBuilder';

/** 10BC-Fix FIX-4: megastructure reservation order (rarest eligibility first, as in assignMassings). */
const MEGA_ORDER: readonly MegaStructureKind[] = ['TWIN_ARCH_GATE', 'CYLINDER_RING_TOWER', 'SLANT_CORP_TOWER', 'X_TRUSS_TOWER'];
import { CAR_DIMS, CAR_VARIANT_NAMES, buildCarVariant } from './CityVehicles';
import { FURNITURE_BOUNDS, FURNITURE_SOCKETS, KIT_CAP, KIT_VARIANT, buildFurnishingsKit, buildLampGeometry, buildVendingGeometry } from './CityFurniture';

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
  | 'BARRIER'
  /** 11A-2 interactive breach door leaf (dynamic: setColliderActive). */
  | 'DOOR'
  /** 11A-3 destructible glass pane (dynamic: setColliderActive). */
  | 'GLASS';

export interface BoxCollider {
  readonly min: THREE.Vector3;
  readonly max: THREE.Vector3;
  readonly kind: ColliderKind;
  /** Owning building index (-1 when not part of a building). */
  readonly building: number;
  /** The district gate section of the lockdown barrier (passable once the gate opens). */
  readonly gate?: boolean;
  /** 10A-1 dynamic enable/disable flag (default true when undefined; supports future destructible doors/glass). */
  active?: boolean;
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

export type AnchorKind = 'HIGHWAY_EDGE' | 'BRIDGE_TRUSS' | 'BUILDING_CORNER' | 'SKYBRIDGE' | 'SIGN' | 'LEDGE';
export interface GrappleAnchor {
  readonly position: THREE.Vector3;
  readonly kind: AnchorKind;
  enabled: boolean;
}

export interface BuildingInfo {
  /** 9A-2 massing (optional for older consumers). */
  massing?: string;
  /** 10B-3 CYLINDER_RING_TOWER shaft circumradius (12-gon, flats facing ±x / ±z). */
  cylR?: number;
  /** 10B-3 TWIN_ARCH_GATE open void (grapple-passable slot between the slabs, under the sky-arch bridge). */
  voidBox?: { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number };
  /** 10B-3 SLANT_CORP_TOWER cap height above the flat deck. */
  slantH?: number;
  /** 10BC-Fix CYLINDER_RING_TOWER shaft centre. */
  cylC?: { x: number; z: number };
  /** 10BC-Fix SLANT_CORP_TOWER cap frame: ramp foot a0 → crest a1 along `axis`, lateral [l0, l1], deck y0, rise h. */
  slant?: { axis: Axis; a0: number; a1: number; l0: number; l1: number; y0: number; h: number };
  /** 9A-1 first terrace height (0 = none). */
  setbackY?: number;
  readonly index: number;
  readonly cx: number;
  readonly cz: number;
  readonly halfW: number;
  readonly halfD: number;
  readonly roofY: number;
  /** 6A-2 archetype: 0 A glass tower · 1 B residential · 2 C industrial · 3 D commercial. */
  readonly arch: number;
  /** Facade seed (0..1): `isMachineFloor(seedInt(seed), floor)` picks the opaque mechanical storeys (10D-Fix FIX-2). */
  readonly seed: number;
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

export interface DoorZone extends RectXZ {
  readonly y: number;
}

/**
 * 10B-2 audit record of one 1F street doorway, in its face frame (along `a`, wall plane `plane`, outward `sg`).
 * `e0 … e1` is the full built assembly (jambs + portal pillars / canopy / access panel); `top` its highest point.
 */
export interface GroundDoorRecord {
  readonly building: number;
  readonly ax: Axis;
  readonly sg: number;
  readonly plane: number;
  readonly program: GroundProgram;
  readonly a: number;
  readonly w: number;
  readonly h: number;
  readonly e0: number;
  readonly e1: number;
  readonly top: number;
  /** Host solid FaceSpan and the 4 m-grammar bay (between pier faces) the door sits in. */
  readonly span: { readonly a0: number; readonly a1: number; readonly y0: number; readonly y1: number };
  readonly bay: { readonly a0: number; readonly a1: number };
}

/** 10B-2 audit record of one 1F stone pier (along extent on its face plane). */
export interface GroundPierRecord {
  readonly building: number;
  readonly ax: Axis;
  readonly sg: number;
  readonly plane: number;
  readonly a0: number;
  readonly a1: number;
  readonly top: number;
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
  readonly kind: 'BALCONY' | 'FIRE_ESCAPE' | 'SHUTTER_FRONT' | 'GALLERY' | 'SPINE';
  readonly building: number;
  readonly center: THREE.Vector3;
  readonly normal: THREE.Vector3;
  /** Top of the feature (highest balcony slab / landing, street-base height). */
  readonly top: number;
}

export interface NeonSignRecord {
  readonly kind: 'BUILDING_FLAT' | 'BUILDING_BLADE' | 'ALLEY_BLADE' | 'ALLEY_BAR' | 'FAR_TOWER' | 'HIGHWAY' | 'BRIDGE' | 'SCAFFOLD';
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly nx: number;
  readonly nz: number;
  readonly w: number;
  readonly h: number;
  readonly building: number;
  readonly buildingB?: number;
  readonly farIndex?: number;
}

export interface FarTowerInfo {
  readonly x: number;
  readonly z: number;
  readonly w: number;
  readonly d: number;
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
  /** Layer 1: expressway deck positions (10D-Fix: never inside a traffic lane). */
  readonly highwaySpawns: readonly SpawnPoint[];
  /** 10D-Fix FIX-4: the elevated traffic lanes (spawn / patrol / enemy clearance). */
  readonly trafficLanes: readonly TrafficLane[];
  /** 11A-1 enterable hollow interiors (≤ 10). */
  readonly interiors: readonly InteriorVolume[];
  /** 11A-1c InteriorPropsKit placements (11B destructible registry). */
  readonly interiorProps: readonly InteriorPropRecord[];
  /** 11B-1 destructible street / alley prop records (CityPropMeshes.commit; cover + wall fixtures excluded). */
  readonly destructibleProps: readonly DestructiblePropRecord[];
  /** 11A-2 kickable breach doors (DestructibleManager.setLevel). */
  readonly breachDoors: readonly DoorSpec[];
  /** 11A-3 destructible glass panes. */
  readonly glassPanes: readonly GlassSpec[];
  /** 11A-1b cantilevered bay-window / HVAC pods placed (towers carrying ≥ 1 pod). */
  readonly reliefPods: { readonly pods: number; readonly towers: number; readonly eligible: number };
  /** 11A-1 every carved opening (door / window / arcade) on its wall plane (QA). */
  readonly interiorOpenings: ReadonlyArray<InteriorOpening & { readonly building: number; readonly interior: number }>;
  /** 11A-1b mid-tower refuge sky-notches (floor-grid aligned). */
  readonly skyNotches: ReadonlyArray<{ readonly building: number; readonly yNotch: number; readonly inset: number }>;
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
  /** 9A-4 deterministic prop sockets (every 1F doorway and gallery apartment door) for Phase 9B micro-props. */
  readonly propSockets: readonly PropSocket[];
  /** 9A-4 1.8 m × 1.8 m clear entry zones in front of every 1F doorway (Phase 9B clutter keeps out). */
  /** 1.8 × 1.8 m clear entry zones; `y` = the floor they stand on (0 street, deck height on galleries). */
  readonly doorClearZones: readonly DoorZone[];
  /** 9B: footprints of every socket prop and clutter item (verification) and each alley's clear centre band. */
  readonly propFootprints: readonly Aabb3[];
  readonly alleyBands: ReadonlyArray<RectXZ & { readonly width: number }>;
  /** 9A-6 manhole centres (steam anchors / Phase 9B clutter avoidance). */
  readonly manholes: readonly THREE.Vector3[];
  /** 10A-2 audit records: placed neon signs, solid building FaceSpans (by building index), and far towers. */
  readonly neonSignRecords: readonly NeonSignRecord[];
  readonly buildingSpans: readonly (readonly FaceSpan[])[];
  readonly farTowersInfo: readonly FarTowerInfo[];
  /** 10B-2 Mega-Billboard records (FaceSpan-bound; L-corner halves / ring segments share a group). */
  readonly megaBillboards: readonly MegaBillboardRecord[];
  /** 10B-1 the open pocket(s) built as a covered cyber street-market (≤ 1 per district). */
  readonly marketRects: readonly RectXZ[];
  /** 10BC-Fix FIX-1 QA: each market ridge trestle (world AABBs of its cross-tie, king-post and the aisle posts under it). */
  readonly marketTrestles: ReadonlyArray<{ readonly tie: Aabb3; readonly king: Aabb3; readonly posts: readonly Aabb3[]; readonly awningEdges: readonly Aabb3[] }>;
  /** 10BC-Fix FIX-7 QA: curb LED bar AABBs with the kerb line (lateral coord of the curb's road face) and road side. */
  /** Street lamp pole positions (x, z). */
  readonly lampPoles: ReadonlyArray<readonly [number, number]>;
  /** 10D-4 faulty alley breaker spark emitters (outward wall normal nx / nz). */
  readonly sparkNodes: ReadonlyArray<{ readonly pos: THREE.Vector3; readonly nx: number; readonly nz: number }>;
  /** 10D-4 dripping canopy / awning front lips (world segments at the lip height). */
  readonly canopyDripEdges: ReadonlyArray<{ readonly x0: number; readonly z0: number; readonly x1: number; readonly z1: number; readonly y: number }>;
  /** 10D-3 ramen carts (kit v2) with their anchored boiler-steam point. */
  readonly ramenCarts: ReadonlyArray<{ readonly x: number; readonly z: number; readonly yaw: number; readonly steam: readonly [number, number, number] }>;
  /** 10D-3 bus shelters (kit v3): front roof lip offset from the street centreline vs the kerb line. */
  readonly busShelters: ReadonlyArray<{ readonly x: number; readonly z: number; readonly yaw: number; readonly front: number; readonly kerb: number; readonly axis: Axis; readonly side: 1 | -1 }>;
  /** 10D-2 AnimatedEnvKit instances (fans / noren / holograms) with their host kind. */
  readonly animatedEnv: readonly EnvInstance[];
  /** 10D-2 rooftop machine-room boxes (rooftop fans mount on their non-door flanks). */
  readonly machineRoomBoxes: ReadonlyArray<{ readonly x0: number; readonly x1: number; readonly y0: number; readonly y1: number; readonly z0: number; readonly z1: number; readonly doorFace: string | null; readonly building: number }>;
  readonly curbLedBoxes: ReadonlyArray<{ readonly box: Aabb3; readonly axis: Axis; readonly kerb: number; readonly side: 1 | -1 }>;
  /** 10B-2 audit: every 1F street doorway assembly and every 1F pier (face frame). */
  readonly groundDoors: readonly GroundDoorRecord[];
  readonly groundPiers: readonly GroundPierRecord[];
  readonly stats: {
    /** 10C-3 streetscape census: curb LED bars, roof scaffolds + shacks, avenue gantries, lantern strings, parasols. */
    readonly streetscape: {
      readonly curbLeds: number;
      readonly scaffolds: number;
      readonly shacks: number;
      readonly gantries: number;
      readonly lanternStrings: number;
      readonly parasols: number;
      readonly kitInstances: number;
      readonly vending: number;
    };
    readonly towers: number;
    readonly cars: number;
    readonly highways: number;
    readonly ramps: number;
    readonly bridges: number;
    readonly skybridges: number;
    readonly lamps: number;
    readonly cityLights: number;
    /** 10D-1 moving expressway vehicles (24–36). */
    readonly traffic: number;
    /** 6A-2 tower count per archetype (A · B · C · D). */
    readonly archetypes: readonly number[];
    readonly balconies: number;
    readonly fireEscapes: number;
    readonly escapeFlights: number;
    readonly shutterFronts: number;
    /** Phase 7B set pieces. */
    readonly signals: number;
    readonly lampCones: number;
    readonly cableBundles: number;
    readonly carPaints: number[];
    readonly carPools: number;
    /** 6A-1 rooms per night-light state on the rendered facades: dark · warm · cool · accent. */
    readonly facadeRooms: readonly number[];
    /** Phase 9A architecture. */
    readonly massings: Readonly<Record<string, number>>;
    readonly programs: Readonly<Record<string, number>>;
    readonly roofsOnGrid: number;
    readonly setbacksOnGrid: number;
    readonly parapetLengthM: number;
    readonly parapetGaps: number;
    readonly bulkheads: number;
    readonly galleryDoors: number;
    readonly galleryLevels: number;
    readonly galleryRamps: number;
    /** Galleries whose zig-zag stair links street → 2F → 3F → 4F. */
    readonly galleriesLinked: number;
    /** GALLERY_DANCHI buildings left without a corridor face (no free in-play face ≥ GALLERY_MIN_FACE_M). */
    readonly galleriesWithoutCorridor: number;
    readonly spines: number;
    readonly slabBands: number;
    readonly piers: number;
    readonly doors: number;
    readonly doorWidth: readonly number[];
    readonly doorHeight: readonly number[];
    readonly sockets: number;
    readonly pipeBundles: number;
    readonly manholes: number;
    readonly steamColumns: number;
    readonly neon: number;
    readonly alleyNeon: number;
    readonly minRunFaces: number;
    readonly floatingRoofProps: number;
    /** Phase 9B micro-props / clutter / decals (committed instance counts per kit). */
    readonly props: {
      readonly doors: number;
      readonly tidyDoors: number;
      readonly dressedDoors: number;
      readonly adjacentPairs: number;
      readonly adjacentClones: number;
      readonly bayProps: number;
      readonly socketProps: number;
      readonly kits: Readonly<Record<KitId, number>>;
      readonly clutter: number;
      readonly clutterColliders: number;
      readonly clutterByStrip: Readonly<Record<string, number>>;
      readonly dumpstersByStrip: Readonly<Record<string, number>>;
      readonly decals: number;
      readonly contactShadows: number;
    };
    /** 10B-1 lot census: generated valid lots, built towers, market pockets, built share. */
    readonly lots: { readonly generated: number; readonly built: number; readonly market: number; readonly fill: number; readonly marketStalls: number };
    /** 10B-3 megastructure counts. */
    readonly megastructures: Readonly<Record<string, number>>;
    /** 10B-2 Mega-Billboard instances by format + rain-mist halos. */
    readonly megaBillboards: { readonly total: number; readonly avenue: number; readonly perimeter: number; readonly corner: number; readonly cornerPieces: number; readonly blade: number; readonly ring: number; readonly mists: number };
    /** 10B-2 signs rejected by the 3D AABB non-overlap guard. */
    readonly signRejects: number;
    /** 10B-4 district identity name + neon palette. */
    readonly identity: string;
    readonly palette: readonly number[];
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
const _colB = new THREE.Color();
const _white = new THREE.Color(1, 1, 1);

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

/**
 * 10A-2: Sloped concrete prism with exact vertical sides (never twisted `beam()`), outward normals, world UVs,
 * and per-vertex `aAo`. Spans along `axis` from `a0` (vertical `[y0Bot, y0Top]`) to `a1` (`[y1Bot, y1Top]`),
 * across `[l0, l1]`.
 */
function slopedPrism(
  axis: Axis,
  a0: number,
  a1: number,
  l0: number,
  l1: number,
  y0Bot: number,
  y0Top: number,
  y1Bot: number,
  y1Top: number,
  ao: { ground?: boolean; bottom?: number; top?: number; side?: number } = {},
): THREE.BufferGeometry {
  const sA = Math.min(a0, a1);
  const sB = Math.max(a0, a1);
  const swap = a0 > a1;
  const botA = swap ? y1Bot : y0Bot;
  const topA = swap ? y1Top : y0Top;
  const botB = swap ? y0Bot : y1Bot;
  const topB = swap ? y0Top : y1Top;
  const lMin = Math.min(l0, l1);
  const lMax = Math.max(l0, l1);
  const P = (al: number, y: number, lat: number): THREE.Vector3 => pt(axis, al, y, lat, new THREE.Vector3());
  const A00 = P(sA, botA, lMin);
  const A01 = P(sA, botA, lMax);
  const A10 = P(sA, topA, lMin);
  const A11 = P(sA, topA, lMax);
  const B00 = P(sB, botB, lMin);
  const B01 = P(sB, botB, lMax);
  const B10 = P(sB, topB, lMin);
  const B11 = P(sB, topB, lMax);
  const T = RENDER.ROOF_TILE_M;
  const vAo = (y: number, base: number): number => (ao.ground && y < 0.35 ? base * (0.46 + 0.54 * (Math.max(0, y) / 0.35)) : base);
  const parts: THREE.BufferGeometry[] = [];
  const emit = (
    p: readonly [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3],
    hint: THREE.Vector3,
    uv: readonly [number, number, number, number, number, number, number, number],
    baseAo: number,
  ): void => {
    const q = quad(p, uv, hint);
    const aArr = new Float32Array([vAo(p[0].y, baseAo), vAo(p[1].y, baseAo), vAo(p[2].y, baseAo), vAo(p[3].y, baseAo)]);
    q.setAttribute('aAo', new THREE.BufferAttribute(aArr, 1));
    parts.push(q);
  };
  const alLen = (sB - sA) / T;
  const latLen = (lMax - lMin) / T;
  // Top & bottom sloped slabs.
  emit([A10, A11, B11, B10], new THREE.Vector3(0, 1, 0), [0, 0, latLen, 0, latLen, alLen, 0, alLen], ao.top ?? 1);
  emit([A00, A01, B01, B00], new THREE.Vector3(0, -1, 0), [0, 0, latLen, 0, latLen, alLen, 0, alLen], ao.bottom ?? 1);
  // Vertical lateral sides.
  const nMin = axis === 'z' ? new THREE.Vector3(-1, 0, 0) : new THREE.Vector3(0, 0, -1);
  const nMax = axis === 'z' ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
  const sideAo = ao.side ?? 1;
  emit([A00, B00, B10, A10], nMin, [0, botA / T, alLen, botB / T, alLen, topB / T, 0, topA / T], sideAo);
  emit([A01, B01, B11, A11], nMax, [0, botA / T, alLen, botB / T, alLen, topB / T, 0, topA / T], sideAo);
  // End faces (skip degenerate zero-height ends).
  const nA = axis === 'z' ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(-1, 0, 0);
  const nB = axis === 'z' ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
  if (topA - botA > 1e-3) emit([A00, A01, A11, A10], nA, [0, botA / T, latLen, botA / T, latLen, topA / T, 0, topA / T], sideAo);
  if (topB - botB > 1e-3) emit([B00, B01, B11, B10], nB, [0, botB / T, latLen, botB / T, latLen, topB / T, 0, topB / T], sideAo);
  return mergeOrEmpty(parts);
}

// =============================================================================================
// 10B-3 n-gon helpers (CYLINDER_RING_TOWER): indexed quads; for n = 12 the flats face ±x / ±z
// =============================================================================================
function ngonCorner(cx: number, cz: number, r: number, n: number, k: number): THREE.Vector3 {
  const a = ((k + 0.5) / n) * Math.PI * 2;
  return new THREE.Vector3(cx + Math.cos(a) * r, 0, cz + Math.sin(a) * r);
}
/** Vertical n-gon wall from y0 to y1 (outward, or inward-facing); uv = (perimeter, y) / tile. */
function ngonWall(cx: number, cz: number, r: number, y0: number, y1: number, n: number, inward = false, tile = 4): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const side = 2 * r * Math.sin(Math.PI / n);
  for (let k = 0; k < n; k++) {
    const a = ngonCorner(cx, cz, r, n, k - 1);
    const b = ngonCorner(cx, cz, r, n, k);
    const mid = (k / n) * Math.PI * 2;
    const nh = new THREE.Vector3(Math.cos(mid), 0, Math.sin(mid)).multiplyScalar(inward ? -1 : 1);
    const u0 = (k * side) / tile;
    const u1 = ((k + 1) * side) / tile;
    parts.push(quad([a.clone().setY(y0), b.clone().setY(y0), b.clone().setY(y1), a.clone().setY(y1)], [u0, y0 / tile, u1, y0 / tile, u1, y1 / tile, u0, y1 / tile], nh));
  }
  return mergeOrEmpty(parts);
}
/** Flat n-gon annulus (r0 → r1) at height y facing up or down; world uv / tile (r0 ≈ 0 gives a disc). */
function ngonAnnulus(cx: number, cz: number, r0: number, r1: number, y: number, n: number, up: boolean, tile = 4): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const nh = new THREE.Vector3(0, up ? 1 : -1, 0);
  for (let k = 0; k < n; k++) {
    const p = [ngonCorner(cx, cz, r0, n, k - 1), ngonCorner(cx, cz, r1, n, k - 1), ngonCorner(cx, cz, r1, n, k), ngonCorner(cx, cz, r0, n, k)].map((v) => v.setY(y)) as [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3];
    const uv = p.flatMap((v) => [v.x / tile, v.z / tile]) as unknown as [number, number, number, number, number, number, number, number];
    parts.push(quad(p, uv, nh));
  }
  return mergeOrEmpty(parts);
}
/** Closed n-gon ring band (outer + inner walls, top + bottom). */
function ngonRing(cx: number, cz: number, r0: number, r1: number, y0: number, y1: number, n: number, tile = 4): THREE.BufferGeometry {
  return mergeOrEmpty([
    ngonWall(cx, cz, r1, y0, y1, n, false, tile),
    ngonWall(cx, cz, r0, y0, y1, n, true, tile),
    ngonAnnulus(cx, cz, r0, r1, y1, n, true, tile),
    ngonAnnulus(cx, cz, r0, r1, y0, n, false, tile),
  ]);
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

/**
 * 7B-2 height fog (after the regular exp² fog): low street haze that thickens toward Y ≤ 26 m and clears above
 * 50 m — tower feet sink into the wet neon mist, the tops pierce the night sky.
 */
/**
 * 12A-4: the street haze keeps its designed offset from the abyss fog (HEIGHT_FOG_COLOR − FOG_ABYSS, linear) but
 * rides on the scene's live `fogColor` uniform, so a sector-tinted fog (Renderer.setSectorAtmosphere) tints the
 * haze too. Identical output while the fog colour is the default FOG_ABYSS.
 */
const HFOG_DELTA = new THREE.Color(RENDER.HEIGHT_FOG_COLOR).sub(new THREE.Color(COLORS.FOG_ABYSS));
const GLSL_HEIGHT_FOG = /* glsl */ `
  #ifdef USE_FOG
  {
    float hfD = length(vCityWorld - cameraPosition);
    float hfY = vCityWorld.y;
    float hfH = hfY <= ${RENDER.HEIGHT_FOG_FULL_Y.toFixed(1)} ? 1.0
      : exp(-(hfY - ${RENDER.HEIGHT_FOG_FULL_Y.toFixed(1)}) / 9.0) * (1.0 - smoothstep(${(RENDER.HEIGHT_FOG_CLEAR_Y - 10).toFixed(1)}, ${RENDER.HEIGHT_FOG_CLEAR_Y.toFixed(1)}, hfY));
    float hfA = ${RENDER.HEIGHT_FOG_MAX.toFixed(3)} * uHeightFog * hfH * smoothstep(${RENDER.HEIGHT_FOG_NEAR_M.toFixed(1)}, ${RENDER.HEIGHT_FOG_FAR_M.toFixed(1)}, hfD);
    gl_FragColor.rgb = mix(gl_FragColor.rgb, max(fogColor + vec3(${HFOG_DELTA.r.toFixed(5)}, ${HFOG_DELTA.g.toFixed(5)}, ${HFOG_DELTA.b.toFixed(5)}), vec3(0.0)), hfA);
  }
  #endif
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

/** 7B-5 blimp orbit at sim time t (also used by tests): position + heading. */
export function blimpPose(b: { radius: number; y: number; speed: number; phase: number }, t: number, out: { x: number; y: number; z: number; yaw: number }): void {
  const a = b.phase + (b.speed / b.radius) * t;
  out.x = Math.cos(a) * b.radius;
  out.z = Math.sin(a) * b.radius;
  out.y = b.y + Math.sin(t * 0.07 + b.phase) * 2.5;
  // Velocity direction d/dt (cos a, sin a) · sign(speed) → heading for +Z forward.
  const vx = -Math.sin(a) * Math.sign(b.speed);
  const vz = Math.cos(a) * Math.sign(b.speed);
  out.yaw = Math.atan2(vx, vz);
}
const _bp = { x: 0, y: 0, z: 0, yaw: 0 };

/**
 * 7B-5 distant lightning schedule (mirrors the sky shader): one strike per ~22 s cycle k at
 * k·22 + 11 + jitter(k) with jitter ∈ ±2 s ⇒ 18–26 s apart; azimuth per cycle. Pattern: 0.08 s flash →
 * 0.10 s dark → 0.14 s second flash. Returns the strike intensity (0 … 1) at time t.
 */
/** Fractional part (module scope: lightningAt runs every frame and must not allocate a closure). */
function fract01(x: number): number {
  return x - Math.floor(x);
}
export interface LightningSample {
  k: number;
  start: number;
  azimuth: number;
  intensity: number;
}
export function lightningAt(t: number, out?: LightningSample): LightningSample {
  const P = CITY_FX.LIGHTNING_PERIOD_S;
  const k = Math.floor(t / P);
  const g = fract01;
  const start = k * P + P * 0.5 + (g(k * 0.618034 + 0.137) - 0.5) * 2 * CITY_FX.LIGHTNING_JITTER_S;
  const az = g(k * 0.754877 + 0.31) * Math.PI * 2;
  const d = t - start;
  const intensity = d >= 0 && d < 0.08 ? 1 - (d / 0.08) * 0.3 : d >= 0.18 && d < 0.32 ? 0.85 * (1 - (d - 0.18) / 0.14) : 0;
  // 10D-4: zero-allocation path — the caller passes a pre-allocated sample every frame.
  if (out) {
    out.k = k;
    out.start = start;
    out.azimuth = az;
    out.intensity = intensity;
    return out;
  }
  return { k, start, azimuth: az, intensity };
}

const MAX_LIGHTS = RENDER.CITY_LIGHTS_MAX;
const CORNERS_4: ReadonlyArray<readonly [number, number]> = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

/** Analytic GGX reflections of the nearest city lights (wet streets, puddles, canal water). */
const GLSL_CITY_LIGHTS = /* glsl */ `
  uniform vec3 uCityLightPos[${MAX_LIGHTS}];
  uniform vec3 uCityLightCol[${MAX_LIGHTS}];
  uniform int uCityLightCount;
  uniform float uStreakGain;
  uniform float uHeightFog;
  varying vec3 vCityWorld;
  varying vec3 vCityWorldN;
  vec3 strandCityLights(vec3 P, vec3 N, vec3 V, vec3 albedo, float rough, float metal) {
    const float R2 = ${(RENDER.CITY_LIGHT_RANGE_M * RENDER.CITY_LIGHT_RANGE_M).toFixed(1)};
    vec3 acc = vec3(0.0);
    float a = max(rough * rough, 0.0025);
    float a2 = a * a;
    vec3 F0 = mix(vec3(0.04), albedo, metal);
    float NdV = max(dot(N, V), 1e-3);
    for (int i = 0; i < ${MAX_LIGHTS}; i++) {
      if (i >= uCityLightCount) break;
      vec3 Lv = uCityLightPos[i] - P;
      float d2 = dot(Lv, Lv);
      if (d2 > R2) continue;
      float d = sqrt(d2);
      vec3 L = Lv / max(d, 1e-3);
      float att = (1.0 / (1.0 + d2 * 0.045)) * (1.0 - smoothstep(${(RENDER.CITY_LIGHT_RANGE_M * 0.6).toFixed(1)}, ${RENDER.CITY_LIGHT_RANGE_M.toFixed(1)}, d));
      float NdL = max(dot(N, L), 0.0);
      if (att * NdL <= 0.0) continue;
      vec3 Hh = normalize(L + V);
      float NdH = max(dot(N, Hh), 0.0);
      float dn = NdH * NdH * (a2 - 1.0) + 1.0;
      float D = min(a2 / (3.14159 * dn * dn), 120.0);
      vec3 F = F0 + (1.0 - F0) * pow(1.0 - max(dot(V, Hh), 0.0), 5.0);
      float Vis = 0.25 / max(NdL * NdV, 0.06);
      vec3 spec = F * D * Vis;
      // 7B-1: wet horizontal surfaces (street, puddles, canal) add an anisotropic GGX lobe stretched along the
      // horizontal view direction — lights smear into long vertical streaks toward the camera, and the rain
      // ripple normals make them waver.
      if (N.y > 0.75 && rough < ${RENDER.STREAK_MAX_ROUGHNESS.toFixed(2)}) {
        vec3 Ta = vec3(V.x, 0.0, V.z);
        Ta = normalize(Ta + vec3(1e-4, 0.0, 0.0));
        vec3 Ba = normalize(cross(N, Ta));
        Ta = cross(Ba, N);
        float ax = max(rough * 2.6, 0.28);
        float ay = max(rough * 0.42, 0.035);
        float th = dot(Hh, Ta);
        float bh = dot(Hh, Ba);
        float dA = th * th / (ax * ax) + bh * bh / (ay * ay) + NdH * NdH;
        float Da = min(1.0 / (3.14159 * ax * ay * dA * dA), 60.0);
        float wet = 1.0 - smoothstep(${(RENDER.STREAK_MAX_ROUGHNESS * 0.65).toFixed(3)}, ${RENDER.STREAK_MAX_ROUGHNESS.toFixed(2)}, rough);
        spec += F * Da * Vis * wet * ${RENDER.STREAK_GAIN.toFixed(2)} * uStreakGain;
      }
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

/** 11A: ≤ 10 interior AABBs (min, max pairs): rooms stay dry (no puddle ripples / gloss, no rain). */
export const INDOOR_MAX = 10;
export const GLSL_INDOOR = /* glsl */ `
  uniform vec3 uIndoor[${INDOOR_MAX * 2}];
  uniform int uIndoorN;
  bool strandIndoor(vec3 p) {
    for (int i = 0; i < ${INDOOR_MAX}; i++) {
      if (i >= uIndoorN) break;
      if (all(greaterThan(p, uIndoor[i * 2])) && all(lessThan(p, uIndoor[i * 2 + 1]))) return true;
    }
    return false;
  }
  #define STRAND_INDOOR_TEST strandIndoor(vCityWorld)
`;
/** 10A-2 puddle micro-ripple normals: flat rain-soaked asphalt with crisp high-frequency raindrop micro-rings. */
const GLSL_PUDDLE_RIPPLES = /* glsl */ `
  {
    float strandPuddle = 1.0 - smoothstep(0.13, 0.26, roughnessFactor);
    vec3 strandNwUp = transformNormalByInverseViewMatrix(normal, viewMatrix);
    if (strandPuddle > 0.001 && strandNwUp.y > 0.5 && !(STRAND_INDOOR_TEST)) {
      vec2 g = strandRipples(vCityWorld.xz * 4.5, uTime) * 0.055 + strandRipples(vCityWorld.xz * 7.8 + 11.0, uTime * 1.18) * 0.035;
      normal = normalize(normal + mat3(viewMatrix) * (vec3(g.x, 0.0, g.y) * strandPuddle));
    }
  }
`;

/** 12A-2 Mega-Billboard wet-street reflection ribbons: nearest-8 selector limits (tests read these). */
/** Phase 13: materials already hooked by `CityBuilder.applyStrandMaterialHooks` (identity, survives clones). */
const STRAND_GLB_HOOKED = new WeakSet<THREE.Material>();

export const MEGA_REFL = {
  /** Uniform slots (GLSL array size). */
  MAX: 8,
  /** Selection radius (3D distance from the camera). */
  RANGE_M: 90,
  /** Screens whose centre sits above this height (and every RING) never reflect in the street. */
  MAX_Y_M: 42,
  /**
   * Linear AD_HUES[cell] colour multiplier written to uMegaReflCol.rgb. Lead tune 1.5 → 3.0: after the puddle
   * wet mask, grazing Fresnel and the spec's 0.65 factor, 1.5 only lifted the asphalt by a barely visible wash.
   */
  INTENSITY: 3.0,
} as const;

/** 12A-2 anisotropic wet-ribbon reflections of the nearest Mega-Billboards (road material, `lights_fragment_end`). */
const GLSL_MEGA_REFL_PARS = /* glsl */ `
  uniform vec4 uMegaReflPos[${MEGA_REFL.MAX}];
  uniform vec4 uMegaReflCol[${MEGA_REFL.MAX}];
  uniform vec4 uMegaReflNrm[${MEGA_REFL.MAX}];
  uniform int uMegaReflCount;
  uniform float uMegaReflEnabled;
`;

/**
 * 12A-3.1 cotangent frame from screen derivatives (no uv / tangent attributes): view-space position + any planar
 * uv → TBN whose columns follow d(uv). Used by the zero-UV parked-car detail normals.
 */
const GLSL_COTANGENT = /* glsl */ `
  mat3 strandCotangentFrame(vec3 N, vec3 dp1, vec3 dp2, vec2 duv1, vec2 duv2) {
    vec3 dp2perp = cross(dp2, N);
    vec3 dp1perp = cross(N, dp1);
    vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
    vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
    float invmax = inversesqrt(max(max(dot(T, T), dot(B, B)), 1e-20));
    return mat3(T * invmax, B * invmax, N);
  }
`;

/**
 * Phase 13 `.glb` hook: rain-wet clearcoat Fresnel sheen (same tint as the parked-car clearcoat), injected after
 * `#include <emissivemap_fragment>`; glossier surfaces catch more of it.
 */
const GLSL_GLB_WET_CLEARCOAT = /* glsl */ `
  {
    float strandWetFr = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 4.0);
    totalEmissiveRadiance += vec3(0.20, 0.26, 0.36) * strandWetFr * 0.5 * (1.0 - 0.6 * clamp(roughnessFactor, 0.0, 1.0));
  }
`;

// =============================================================================================
// Capacities (pre-allocated once; counts set per sector)
// =============================================================================================
/** 9A-5 baked vertex AO: `aAo` (1 = open) → albedo and indirect specular × mix(0.32, 1, aAo); emissive untouched. */
function injectVertexAo(shader: THREE.WebGLProgramParametersWithUniforms): void {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float aAo;\nvarying float vAo;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvAo = aAo;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vAo;')
    .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb *= mix(0.32, 1.0, vAo);')
    .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\nreflectedLight.indirectSpecular *= mix(0.32, 1.0, vAo);');
}

const CAP = {
  /** Roof units + 6A-3 balcony outdoor units. */
  AC: 300,
  DUCT: 60,
  FENCE: 240,
  ANTENNA: 44,
  AVIATION: 280,
  /** 9A-6: layered alley / street signage (was 420). */
  NEON: 960,
  SEARCH: 20,
  MACHINE_ROOM: 26,
  BEACON: 220,
  LAMP: 170,
  VENDING: 90,
  GUARDRAIL: 220,
  /** 10A-1 consolidated guardrails + roof fences + antennas (−2 draw calls). */
  STEEL_FIXTURES: 220 + 240 + 44,
  /** 7B-1: lamps, crowns, balconies, neon signs, car head / tail lights, vending fronts. */
  CITY_LIGHTS: 1100,
  /** 9A-6: steam columns anchored on manholes and eatery vents (2 puffs each) + canal mist. */
  STEAM: 232,
  /** 9A-6 cast-iron manholes. */
  MANHOLE: 55,
  /** 10B-2 Mega-Billboards (avenue screens, L-corner wraps, monolith blades, cylinder ad rings): one draw call. */
  MEGA: 140,
  /** 10B-2 coloured rain-mist halos packed after the lamp halos in the same instanced draw. */
  MIST: 90,
} as const;

/** 10B-1 inner far-tower ring pulled in for tight skyline framing (heights still blimp-corridor clamped). */
export const FAR_INNER = { COUNT: 36, R_MIN: 115, R_MAX: 220, H_MIN: 55, H_MAX: 180, CLEAR_M: 14 } as const;

/** 10B-1 proximity-only lockdown barrier: full at ≤ 3 m, invisible (alpha 0) beyond 14 m from the camera. */
export const BARRIER_NEAR_M = 3;
export const BARRIER_FAR_M = 14;

/** 10B-2 sign non-overlap guard: AABB padding per sign and the plane thickness used for its box. */
export const SIGN_MARGIN_M = 0.35;
export const SIGN_THICK_M = 0.1;
/** 10B-2 dominant hue of each Mega-Billboard atlas cell (street light + mist tint). */
export const AD_HUES: readonly number[] = [0x38f8ff, 0xd040ff, 0xc8ff2e, 0xff5a8a, 0xff1f3d, 0x19e6e6, 0xffa21f, 0x2f7bff];

/** 10B-2 Mega-Billboard placement record (tests: zero floating, zero overlap). */
export interface MegaBillboardRecord {
  readonly kind: 'AVENUE' | 'PERIMETER' | 'CORNER' | 'BLADE' | 'RING';
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Plane normal (flat screens: outward from the wall; blades: perpendicular to the wall). */
  readonly nx: number;
  readonly nz: number;
  readonly w: number;
  readonly h: number;
  readonly building: number;
  readonly cell: number;
  /** Pieces sharing a group (L-corner halves, ring segments) are one screen: exempt from each other's guard. */
  readonly group: number;
  readonly standoff: number;
}

/**
 * `halfW` / `halfD` / `roofY` describe the ROOF (upper tier on setback towers) — roof props, corner anchors,
 * perches and the enemy rooftop logic use them. Street faces (panels, signs, canopies, fins) use the lot.
 */
interface Building extends BuildingInfo {
  readonly rect: RectXZ;
  readonly lotHalfW: number;
  readonly lotHalfD: number;
  /** Lot centre (street faces); `cx` / `cz` are the ROOF centre (offset tower, larger L wing). */
  readonly lcx: number;
  readonly lcz: number;
  /** Setback terrace / podium height (0 = single block). */
  readonly setbackY: number;
  /** 9A-2 massing and its geometry plan (boxes, roof plates, exposed face spans). */
  readonly massing: MassingKind;
  readonly plan: MassingPlan;
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
  /** 10D-1 expressway traffic (persistent, +1 call). */
  readonly traffic: ElevatedTraffic;
  /** 10D-2 GPU-animated micro-environment kit (persistent, +1 call). */
  readonly envKit: AnimatedEnvKit;
  /** 11A-1c close-up interior props (one persistent instanced draw, cap 260). */
  readonly interiorKit: InteriorPropsKit;
  /** 11A dry-interior mask shared by the wet concrete shader (min / max pairs, count). */
  readonly uIndoor = { value: Array.from({ length: INDOOR_MAX * 2 }, () => new THREE.Vector3()) };
  readonly uIndoorN = { value: 0 };
  private readonly uNeonBoost = { value: 1.0 };
  private readonly uSearchPulse = { value: 0.0 };
  private readonly uGateOpen = { value: 0.0 };
  private readonly uFogDensity = { value: RENDER.FOG_DENSITY };
  private readonly uCityLightPos = { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector3()) };
  private readonly uCityLightCol = { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector3()) };
  private readonly uCityLightCount = { value: 0 };
  /** 1 = tower walls receive the city lights (HIGH / MEDIUM), 0 = off (LOW). */
  private readonly uWallLights = { value: 1 };
  /** 12A-2 nearest Mega-Billboards reflected by the wet road (xyz centre, w half-width m). */
  readonly uMegaReflPos = { value: Array.from({ length: MEGA_REFL.MAX }, () => new THREE.Vector4()) };
  /** 12A-2 linear AD_HUES[cell] × MEGA_REFL.INTENSITY (rgb), w = half-height m. */
  readonly uMegaReflCol = { value: Array.from({ length: MEGA_REFL.MAX }, () => new THREE.Vector4()) };
  /** 12A-2 active slots (GLSL `int`; always an integer 0 … 8). */
  readonly uMegaReflCount = { value: 0 };
  /** 12A-2 uniform toggle (no recompiles): 0 in LOW quality or lowLatency mode, 1 otherwise. */
  readonly uMegaReflEnabled = { value: 1 };
  /** 12A-2 slot k → index into `currentLayout.megaBillboards` (-1 = unused slot). */
  readonly megaReflSrc = new Int32Array(MEGA_REFL.MAX).fill(-1);
  // 12A-2 per-sector Mega-Billboard reflection pool (fixed capacity, filled in buildSector, read in update).
  private readonly megaPos = new Float32Array(CAP.MEGA * 3);
  private readonly megaCol = new Float32Array(CAP.MEGA * 3);
  /** Half-width, half-height (m). */
  private readonly megaSize = new Float32Array(CAP.MEGA * 2);
  private readonly megaDist = new Float32Array(CAP.MEGA);
  private readonly megaSrcIdx = new Int32Array(CAP.MEGA);
  /** Screen plane normal (x, z) + two-sided flag (BLADE screens read from both sides). */
  private readonly megaNrm = new Float32Array(CAP.MEGA * 3);
  private megaCount = 0;
  /** 12A-2 audit fix: per-slot screen normal (xy = normal x/z, z = 1 two-sided) for the per-fragment front test. */
  readonly uMegaReflNrm = { value: Array.from({ length: MEGA_REFL.MAX }, () => new THREE.Vector4()) };
  private qualityLow = false;
  private lowLatency = false;
  /** 12A-4 sky-dome horizon = scene fog colour (shared with the blimp hull's fog tint). */
  private readonly uSkyHorizon = { value: new THREE.Color(COLORS.FOG_ABYSS) };
  /** 12A-3.1 1 × 1 flat placeholder so the car detail samplers are always valid (headless / tests). */
  private static placeholderTex: THREE.DataTexture | null = null;

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
  /** 9A-5 weathered painted trim (doors, frames, awnings, shutters, mailboxes): vertex tint × archDetail + aAo. */
  private readonly archPaintMat: THREE.MeshStandardMaterial;
  /** 9A-6 cast-iron manholes (one instanced draw). */
  private readonly manholes: THREE.InstancedMesh;
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
  /** 10C-3 StreetFurnishingsKit: lantern strings (v0) + cafe parasols (v1); v2 / v3 reserved for 10D — 1 draw call. */
  private readonly furnishings: THREE.InstancedMesh;
  /** 10A-1 consolidated guardrails (v0) + roof fences (v1) + antennas (v2) — 1 draw call (−2 calls). */
  private readonly steelFixtures: THREE.InstancedMesh;
  /** 11B-3 RoofMechKit: rooftop / balcony AC units (aInstVar 0) + exhaust ducts (aInstVar 1) in ONE draw call. */
  private readonly roofMech: THREE.InstancedMesh;
  private readonly machineRooms: THREE.InstancedMesh;
  private readonly aviation: THREE.InstancedMesh;
  private readonly neonSigns: THREE.InstancedMesh;
  private readonly searchlights: THREE.InstancedMesh;
  private readonly beacons: THREE.InstancedMesh;
  private readonly halos: THREE.InstancedMesh;
  /** 5B-1: soft rain-haze glow around every street-lamp head (one instanced draw). */
  private readonly lampHalos: THREE.InstancedMesh;
  /** 10B-2 giant English ad screens (one draw call). */
  private readonly megaBillboards: THREE.InstancedMesh;
  /** 7B-3 / 7B-4 / 7B-5 set pieces (one draw each). */
  private readonly lampCones: THREE.InstancedMesh;
  /** 7B-1 / 7B-2 A/B switches (1 = on; verification only). */
  readonly fxDebug = { streak: { value: 1 }, heightFog: { value: 1 } };
  /** 7B-4 cable bundle midpoints (verification / camera framing). */
  readonly cableDebug: Array<{ x: number; y: number; z: number; axis: Axis }> = [];
  private readonly signals: THREE.InstancedMesh;
  private readonly carPools: THREE.InstancedMesh;
  private readonly blimpHull: THREE.InstancedMesh;
  private readonly blimpBanner: THREE.InstancedMesh;
  /** 5B-3: low steam from manholes / ducts and canal mist (one instanced draw, animated on the GPU). */
  private readonly steam: THREE.InstancedMesh;
  private readonly gatePillar: THREE.Mesh;
  /** Phase 9B / 10A socket kits, clutter batches, graffiti decals and prop contact shadows (10 persistent draws). */
  /** 9B / 10A prop kits (11B: DestructibleManager hides broken instances + their contact shadows). */
  readonly propMeshes: CityPropMeshes;

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
    this.steelMat = this.createSteelMaterial(false);
    this.archPaintMat = this.createArchPaintMaterial();
    this.glassMat = new THREE.MeshStandardMaterial({ color: 0x0a1018, roughness: 0.06, metalness: 0.9 });
    this.beaconMat = this.createBeaconMaterial();
    this.barrierMat = this.createBarrierMaterial();

    // ---------------- Persistent backdrop ----------------
    this.sky = this.createSky();
    this.farTowers = new THREE.InstancedMesh(ensureAo(new THREE.BoxGeometry(1, 1, 1)), this.buildingMat, LIMITS.FAR_BUILDINGS);
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
      const g = buildCarVariant(v);
      g.setAttribute('aCar', new THREE.InstancedBufferAttribute(new Float32Array(LIMITS.PARKED_CARS * 4), 4));
      g.setAttribute('aPaint', new THREE.InstancedBufferAttribute(new Float32Array(LIMITS.PARKED_CARS), 1));
      const m = this.makeInstanced(g, carMat, LIMITS.PARKED_CARS, `ParkedCars_${CAR_VARIANT_NAMES[v]}`);
      m.receiveShadow = true;
      return m;
    });
    const lampGeo = buildLampGeometry();
    lampGeo.setAttribute('aTint', new THREE.InstancedBufferAttribute(new Float32Array(CAP.LAMP * 3), 3));
    this.lamps = this.makeInstanced(lampGeo, this.createLampMaterial(), CAP.LAMP, 'StreetLamps');
    const vendGeo = buildVendingGeometry();
    vendGeo.setAttribute('aTint', new THREE.InstancedBufferAttribute(new Float32Array(CAP.VENDING * 3), 3));
    vendGeo.setAttribute('aBrand', new THREE.InstancedBufferAttribute(new Float32Array(CAP.VENDING), 1));
    this.vending = this.makeInstanced(vendGeo, this.createVendingMaterial(), CAP.VENDING, 'VendingKiosks');
    const kitGeo = buildFurnishingsKit();
    kitGeo.setAttribute('aKit', new THREE.InstancedBufferAttribute(new Float32Array(KIT_CAP * 4), 4));
    this.furnishings = this.makeInstanced(kitGeo, this.createFurnishingsMaterial(), KIT_CAP, 'StreetFurnishingsKit');
    // 12A-4: the tightened player shadow frustum lands crisp shadows on the street furnishings (no extra draws).
    this.furnishings.receiveShadow = true;
    const steelFixGeo = this.createSteelFixturesGeometry();
    steelFixGeo.setAttribute('aInstVar', new THREE.InstancedBufferAttribute(new Float32Array(CAP.STEEL_FIXTURES), 1));
    this.steelFixtures = this.makeInstanced(steelFixGeo, this.createSteelMaterial(true), CAP.STEEL_FIXTURES, 'SteelFixturesInstanced');
    this.steelFixtures.receiveShadow = true;
    this.roofMech = this.createRoofMechKit(machinery);
    this.machineRooms = this.makeInstanced(this.createMachineRoomGeometry(), new THREE.MeshStandardMaterial({ color: 0x232934, roughness: 0.5, metalness: 0.55 }), CAP.MACHINE_ROOM, 'MachineRooms');
    this.aviation = this.createAviationLights();
    this.neonSigns = this.createNeonSigns();
    this.searchlights = this.createSearchlights();
    this.beacons = this.makeInstanced(this.createBeaconGeometry(), this.beaconMat, CAP.BEACON, 'GoldAnchors');
    this.halos = this.createAnchorHalos();
    this.lampHalos = this.createLampHalos();
    this.megaBillboards = this.createMegaBillboards();
    this.lampCones = this.createLampCones();
    this.signals = this.createSignals();
    this.carPools = this.createCarPools();
    [this.blimpHull, this.blimpBanner] = this.createBlimps();
    this.steam = this.createSteam();
    this.manholes = this.createManholes();
    this.gatePillar = this.createGatePillar();
    this.propMeshes = new CityPropMeshes(
      tex.plaqueAtlas,
      tex.graffitiAtlas,
      (shader, apply) => this.injectCityLights(shader, apply),
      tex.archDetail,
    );
    this.persistent.add(
      ...this.cars, this.lamps, this.vending, this.furnishings, this.steelFixtures, this.roofMech,
      this.machineRooms, this.aviation, this.neonSigns, this.megaBillboards, this.searchlights, this.beacons, this.halos, this.lampHalos, this.steam, this.gatePillar,
      this.lampCones, this.signals, this.carPools, this.blimpHull, this.blimpBanner, this.manholes,
      ...this.propMeshes.meshes,
    );
    this.traffic = new ElevatedTraffic((shader, apply) => this.injectCityLights(shader, apply));
    this.envKit = new AnimatedEnvKit((shader, apply) => this.injectCityLights(shader, apply), this.uTime);
    this.interiorKit = new InteriorPropsKit((shader, apply) => this.injectCityLights(shader, apply));
    this.persistent.add(this.traffic.mesh, this.envKit.mesh, this.interiorKit.mesh);
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
   * Shared city-light uniforms + world-position & world-normal varyings, injected into a MeshStandardMaterial shader.
   * The world position honours instancing (parked cars, far towers) as well as plain meshes (5B-2).
   * `apply` replaces the default lighting add-on (walls use a height-limited variant).
   */
  /** 11A: shared city-light injector for runtime pools outside the builder (doors, glass, debris). */
  readonly cityLightInjector: CityLightInjector = (shader, apply) => this.injectCityLights(shader, apply);

  private injectCityLights(shader: THREE.WebGLProgramParametersWithUniforms, apply: string = GLSL_CITY_LIGHTS_APPLY): void {
    shader.uniforms.uCityLightPos = this.uCityLightPos;
    shader.uniforms.uStreakGain = this.fxDebug.streak;
    shader.uniforms.uHeightFog = this.fxDebug.heightFog;
    shader.uniforms.uCityLightCol = this.uCityLightCol;
    shader.uniforms.uCityLightCount = this.uCityLightCount;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCityWorld;\nvarying vec3 vCityWorldN;')
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        #ifdef USE_INSTANCING
          vCityWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
          {
            vec3 strandWn = mat3(modelMatrix) * mat3(instanceMatrix) * objectNormal;
            vCityWorldN = strandWn * inversesqrt(max(dot(strandWn, strandWn), 1e-8));
          }
        #else
          vCityWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
          {
            vec3 strandWn = mat3(modelMatrix) * objectNormal;
            vCityWorldN = strandWn * inversesqrt(max(dot(strandWn, strandWn), 1e-8));
          }
        #endif`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${GLSL_CITY_LIGHTS}`)
      .replace('#include <opaque_fragment>', apply)
      .replace('#include <fog_fragment>', `#include <fog_fragment>\n${GLSL_HEIGHT_FOG}`);
  }

  /** LOW quality skips the per-fragment city lights on tower walls and the interior mapping (STRAND_LITE). */
  setQuality(preset: 'HIGH' | 'MEDIUM' | 'LOW'): void {
    this.uWallLights.value = preset === 'LOW' ? 0 : 1;
    const lite = preset === 'LOW';
    this.qualityLow = lite;
    this.uMegaReflEnabled.value = this.qualityLow || this.lowLatency ? 0 : 1;
    const defs = this.buildingMat.defines as Record<string, string>;
    if (lite !== ('STRAND_LITE' in defs)) {
      if (lite) defs.STRAND_LITE = '';
      else delete defs.STRAND_LITE;
      this.buildingMat.needsUpdate = true;
    }
  }

  /** 12A-2 lowLatency mode drops the Mega-Billboard road ribbons (uniform toggle, no shader recompile). */
  setLowLatency(on: boolean): void {
    this.lowLatency = on;
    this.uMegaReflEnabled.value = this.qualityLow || this.lowLatency ? 0 : 1;
  }

  /**
   * 12A-4 sector atmosphere: the sky dome's horizon (and the blimp hull's fog tint) take the EXACT scene fog colour
   * so fogged towers dissolve into the sky with zero seam. Call once per sector load (no allocation).
   */
  setSkyHorizon(fogColor: THREE.Color): void {
    this.uSkyHorizon.value.copy(fogColor);
  }

  /** 12A-4 live sky-dome `uHorizon` colour (verification: equals scene.fog.color after setSkyHorizon). */
  get skyHorizon(): THREE.Color {
    return this.uSkyHorizon.value;
  }

  /**
   * Phase 13 Blender `.glb` swap hook: gives a STANDARD UV-mapped `MeshStandardMaterial` / `MeshPhysicalMaterial`
   * (e.g. emitted by GLTFLoader) the 12 dynamic city lights + street height fog, and optionally a rain-wet
   * clearcoat Fresnel sheen (`opts.wetClearcoat`, after `#include <emissivemap_fragment>`). Needs no custom
   * attributes (no `aPart` / `aAo`). Chains any previous `onBeforeCompile`, appends `-strand-glb[-wet]` to the
   * previous program cache key and is idempotent (second calls are no-ops).
   *
   * ONLY for plain standard materials of imported assets. NEVER call it on the builder's own custom-shader
   * materials (towers, roads, cars, concrete, RoofMechKit `strand-roofmech-v1`, CityPropMeshes kits,
   * InteriorPropsKit, DestructDebris, breach doors / glass, …): those already inject the city lights and would
   * receive them twice.
   */
  applyStrandMaterialHooks(mat: THREE.MeshStandardMaterial, opts?: { wetClearcoat?: boolean }): THREE.MeshStandardMaterial {
    // Identity guard (audit fix): a userData flag would be copied by Material.clone() while the own-property hook
    // is not, leaving a clone flagged but unhooked forever (GLTFLoader clones in assignFinalMaterial).
    if (STRAND_GLB_HOOKED.has(mat)) return mat;
    STRAND_GLB_HOOKED.add(mat);
    const prev = mat.onBeforeCompile;
    const prevKey = mat.customProgramCacheKey();
    const wet = opts?.wetClearcoat === true;
    mat.onBeforeCompile = (shader, renderer) => {
      prev.call(mat, shader, renderer);
      this.injectCityLights(shader);
      if (wet) {
        shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${GLSL_GLB_WET_CLEARCOAT}`);
      }
    };
    const key = `${prevKey}-strand-glb${wet ? '-wet' : ''}`;
    mat.customProgramCacheKey = () => key;
    mat.needsUpdate = true;
    return mat;
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
      varying float vAo;
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
      // 12A-3.2 camera distance of the current interior lookup (LOD of the fine LED / blind detail).
      float strandIntDist;
      // 12A-3.2 room profile from the archetype column + the per-room drift hash (the lighting-state hash is
      // untouched): 0 corporate office · 1 cyber residential · 2 server vault / data floor · 3 neon loft / workshop.
      // A glass → office (72 %) / server vault (28 %) · B residential → residential · C industrial → server vault
      // (60 %) / loft (40 %) · D commercial → loft (66 %) / office (34 %).
      int strandRoomProfile(int col, float h) {
        float hp = fract(h * 5.917 + 0.31);
        if (col == 0) return hp > 0.72 ? 2 : 0;
        if (col == 2) return hp > 0.6 ? 3 : 2;
        if (col == 3) return hp > 0.66 ? 0 : 3;
        return 1;
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
        int prof = strandRoomProfile(col, h);
        float lum = dot(light, vec3(0.2126, 0.7152, 0.0722));
        // Fine detail (LED dots, blind slats) resolves only up close; far rooms get the averaged tone.
        float sNear = 1.0 - smoothstep(30.0, 70.0, strandIntDist);
        vec3 emit = vec3(0.0);
        float k;
        if (tz <= tx && tz <= ty) {
          k = 0.62 - 0.22 * abs(q.x - 0.5) + 0.12 * q.y;
          if (prof == 0) {
            // Corporate office: desk band, teal / cyan monitors, whiteboard, dark filing cabinets.
            k *= 1.0 - 0.7 * step(q.y, 0.29) * step(0.16, fract(q.x * 2.0 + h));
            float mon = step(abs(q.y - 0.36), 0.05) * step(abs(fract(q.x * 2.0 + h) - 0.55), 0.12);
            k += 0.5 * mon;
            emit += mix(vec3(0.25, 0.95, 1.0), vec3(0.12, 0.85, 0.7), h2) * (mon * lum * 1.3);
            k += 0.5 * step(abs(q.x - 0.25 - 0.5 * h2), 0.14) * step(abs(q.y - 0.55), 0.09);
            k *= 1.0 - 0.65 * step(abs(q.x - (h2 < 0.5 ? 0.08 : 0.92)), 0.06) * step(q.y, 0.48);
          } else if (prof == 1) {
            // Cyber residential: sofa, warm tungsten pendant cone, bookshelf silhouette.
            k *= 1.0 - 0.6 * step(q.y, 0.2) * step(abs(q.x - 0.5), 0.32);
            float px = 0.3 + 0.4 * h2;
            float cw = (0.8 - q.y) * 0.42 + 0.03;
            float cone = step(q.y, 0.8) * (1.0 - smoothstep(cw * 0.55, cw, abs(q.x - px)));
            vec2 bp = q.xy - vec2(px, 0.8);
            float bulb = exp(-dot(bp, bp) * 700.0);
            k *= 1.0 - 0.5 * step(abs(q.x - px), 0.006) * step(0.8, q.y);
            emit += vec3(1.0, 0.68, 0.36) * (lum * (cone * 0.5 + bulb * 1.2));
            float shelf = step(abs(q.x - (h2 < 0.5 ? 0.86 : 0.14)), 0.1) * step(q.y, 0.74);
            float books = mix(0.78, 0.55 + 0.45 * step(0.35, fract(q.x * 38.0 + floor(q.y * 5.0) * 0.37)), sNear);
            float plank = step(fract(q.y * 5.0), 0.12);
            k *= 1.0 - shelf * mix(0.8 * books, 0.35, plank);
          } else if (prof == 2) {
            // Server vault: tall dark racks with slow-blinking vertical rows of cyan / emerald / red LEDs.
            float rx = fract(q.x * 4.0 + h);
            float rack = step(rx, 0.8) * step(q.y, 0.88);
            k *= 1.0 - 0.78 * rack;
            vec2 sv = vec2((q.x * 4.0 + h) * 0.625, q.y * 3.0);
            int lx = int(floor(sv.x * 8.0));
            int ly = int(floor(sv.y * 8.0));
            vec2 lf = fract(sv * 8.0) - 0.5;
            float pick = strandHash(lx, ly, 991);
            vec3 ledC = pick < 0.5 ? vec3(0.2, 0.95, 1.0) : (pick < 0.88 ? vec3(0.15, 1.0, 0.45) : vec3(1.0, 0.15, 0.12));
            // Audit fix: the per-LED blink hashes only run while the dots are resolvable (sNear > 0).
            if (sNear > 0.0) {
              float dotM = step(abs(lf.x), 0.16) * step(abs(lf.y), 0.2) * step(0.06, q.y) * step(q.y, 0.84);
              float ph = strandHash(lx, ly, 77) * 6.0;
              float on = step(0.42, strandHash(lx, ly, int(floor(uTime * 2.0 + ph))));
              emit += ledC * (dotM * on * rack * sNear * (0.035 + lum * 2.2));
            }
            // Averaged far-field glow of the LED columns (no shimmer once the dots go sub-pixel).
            emit += ledC * (rack * (1.0 - sNear) * 0.06 * (0.035 + lum * 2.2));
          } else {
            // Neon loft / workshop: workbench band, angled cyan / magenta strip, industrial ceiling beam.
            k *= 1.0 - 0.6 * step(q.y, 0.24);
            float diag = q.y - 0.55 - (q.x - 0.5) * (h2 < 0.5 ? 0.35 : -0.35);
            float strip = step(abs(diag), 0.012) * step(abs(q.x - 0.5), 0.38);
            emit += (h2 < 0.5 ? vec3(0.2, 0.95, 1.0) : vec3(1.0, 0.25, 0.85)) * (strip * lum * 2.2);
            k *= 1.0 - 0.75 * step(abs(q.y - 0.9), 0.045);
          }
        } else if (ty <= tx) {
          if (d.y > 0.0) {
            float panel = step(abs(q.x - 0.5), 0.3) * step(abs(fract(depth * 1.6 + 0.2) - 0.5), 0.2);
            if (prof == 0) {
              // Suspended ceiling grid.
              float grid = max(step(0.93, fract(q.x * 5.0)), step(0.9, fract(depth * 4.0)));
              k = (0.2 + panel * 1.55) * (1.0 - 0.5 * grid);
            } else if (prof == 1) {
              vec2 cp = vec2(q.x - 0.3 - 0.4 * h2, depth - 0.45);
              k = 0.2 + 0.35 * exp(-dot(cp, cp) * 30.0);
            } else if (prof == 2) {
              // Cable trays over the rack rows.
              k = (0.14 + panel * 0.9) * (1.0 - 0.6 * step(abs(fract(q.x * 4.0 + h) - 0.4), 0.08));
            } else {
              // Exposed industrial beams.
              k = (0.18 + panel * 1.2) * (1.0 - 0.7 * step(0.82, fract(depth * 2.5)));
            }
          } else {
            k = 0.34 * (1.0 - 0.35 * depth);
            k *= 1.0 - 0.45 * step(0.45, depth) * step(0.35, fract(q.x * 2.0 + h));
            // Raised data-floor tiles.
            if (prof == 2) k *= 1.0 - 0.3 * max(step(0.92, fract(q.x * 6.0)), step(0.9, fract(depth * 4.0)));
          }
        } else {
          k = 0.44 * (1.0 - 0.4 * depth) + 0.1 * q.y;
          k *= 1.0 - 0.35 * step(q.y, 0.5) * step(0.55, depth) * step(0.5, fract(h * 5.3));
          if (prof == 0) k *= 1.0 - 0.5 * step(q.y, 0.42) * step(depth, 0.35);
          else if (prof == 1) k *= 1.0 - 0.45 * step(q.y, 0.7) * step(0.6, depth) * (0.6 + 0.4 * step(0.12, fract(q.y * 5.0)));
          else if (prof == 2) k *= 1.0 - 0.7 * step(q.y, 0.88) * step(fract(depth * 3.0), 0.8);
        }
        vec3 room = vec3(0.0035, 0.0045, 0.007) * (1.6 - depth) + light * k + emit;
        // Residential venetian blinds across the upper pane (on the glass plane, ~60 % of homes).
        if (prof == 1 && fract(h * 3.1) > 0.4) {
          float blindM = smoothstep(0.6, 0.62, cell.y);
          float slat = mix(0.62, 0.35 + 0.65 * smoothstep(0.32, 0.45, abs(fract(cell.y * 30.0) - 0.5)), sNear);
          room *= mix(1.0, slat, blindM);
        }
        return room;
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
          attribute float aAo;
          varying float vAo;
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
            vAo = aAo;
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
          // 12A-3.2 rain-streak lane footprint (lanes per pixel), taken in uniform control flow for valid derivatives.
          float sStreakPx = fwidth(sAlongM * 9.0);
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
          diffuseColor.rgb *= strandAO * mix(0.32, 1.0, vAo);`)
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
                  // 12A-3.2 close-range raindrop streaks on the glass (< 22 m, fading 18 → 22 m): running drops
                  // refract the room behind them and catch a faint highlight.
                  float sStreak = 0.0;
                  if (sMask > 0.5 && sDist < 22.0) {
                    // Audit fix: fade the ~1 cm lanes out once they go sub-pixel (no shimmer in motion), AA the edges.
                    float sRf = (1.0 - smoothstep(18.0, 22.0, sDist)) * (1.0 - smoothstep(0.06, 0.14, sStreakPx));
                    float sGx = sAlongM * 9.0;
                    int sColI = int(floor(sGx));
                    float sHc = strandHash(sColI, sSeedI, 4242);
                    float sYy = vStrandY * 1.6 + uTime * (0.35 + sHc * 0.5) + sHc * 17.0;
                    float sSeg = fract(sYy);
                    float sLive = step(0.45, sHc) * step(0.35, strandHash(sColI, int(floor(sYy)), sSeedI));
                    float sLane = 1.0 - smoothstep(0.05, 0.14 + sStreakPx, abs(fract(sGx) - 0.5 - (sHc - 0.5) * 0.3));
                    // Bright drop head at the bottom of each segment, thin trail above it.
                    float sHead = smoothstep(0.0, 0.03, sSeg) * (1.0 - smoothstep(0.03, 0.09, sSeg));
                    float sTrail = (1.0 - smoothstep(0.03, 0.6, sSeg)) * 0.45;
                    sStreak = sLane * sLive * max(sHead, sTrail) * sRf;
                    sD.xy += vec2(0.06, 0.03) * sStreak;
                  }
                  strandIntDist = sDist;
                  vec3 sInt = strandInterior(sCell, sD, sRoomLight, sDrift, sCol);
                  sInt += vec3(0.022, 0.026, 0.032) * sStreak;
                  sInt *= 0.3 + 0.7 * smoothstep(0.04, 0.5, abs(dot(sV, sN)));
                  sOut = mix(sOut, sInt, sMask * (1.0 - smoothstep(${PMAX} * 0.7, ${PMAX}, sDist)));
                }
              }
            #endif
            totalEmissiveRadiance = sOut * (1.0 - vTop) * mix(0.72, 1.0, strandAO);
          }`);
    };
    mat.customProgramCacheKey = () => 'strand-building-v18';
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
      normalScale: new THREE.Vector2(0.42, 0.42),
    });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.uTime;
      shader.uniforms.uIndoor = this.uIndoor;
      shader.uniforms.uIndoorN = this.uIndoorN;
      this.injectCityLights(shader);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nuniform float uTime;\n${GLSL_HASH}\n${GLSL_RIPPLES}\n${GLSL_INDOOR}`)
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  if (strandIndoor(vCityWorld)) roughnessFactor = max(roughnessFactor, 0.62);')
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${GLSL_PUDDLE_RIPPLES}`);
      injectVertexAo(shader);
    };
    mat.customProgramCacheKey = () => 'strand-concrete-v14';
    return mat;
  }

  /** 9A-5 weathered painted trim: per-vertex RGB tint × the scuffed-paint / stain detail maps, city lights, aAo. */
  private createArchPaintMaterial(): THREE.MeshStandardMaterial {
    const t = this.tex.archDetail;
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(1.12, 1.12, 1.12),
      vertexColors: true,
      map: t.map,
      roughness: 1.0,
      roughnessMap: t.roughnessMap,
      normalMap: t.normalMap,
      normalScale: new THREE.Vector2(0.55, 0.55),
      metalness: 0.32,
      envMapIntensity: 0.9,
    });
    mat.onBeforeCompile = (shader) => {
      this.injectCityLights(shader);
      injectVertexAo(shader);
    };
    mat.customProgramCacheKey = () => 'strand-archpaint-v1';
    return mat;
  }

  /** 9A-6 flush cast-iron manholes: iron PBR + per-instance subterranean glow through the vent slots. */
  private createManholes(): THREE.InstancedMesh {
    const t = this.tex.manhole;
    const geo = new THREE.CircleGeometry(0.46, 28);
    geo.rotateX(-Math.PI / 2);
    geo.setAttribute('aGlow', new THREE.InstancedBufferAttribute(new Float32Array(CAP.MANHOLE * 3), 3));
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: t.map,
      roughness: 1.0,
      roughnessMap: t.roughnessMap,
      normalMap: t.normalMap,
      metalness: 0.7,
      emissive: 0xffffff,
      emissiveMap: t.emissiveMap,
      emissiveIntensity: 1.0,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -6,
    });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.uTime;
      this.injectCityLights(shader);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 aGlow;\nvarying vec3 vGlow;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = aGlow;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;\nvarying vec3 vGlow;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= vGlow * (0.85 + 0.15 * sin(uTime * 1.7 + vCityWorld.x * 0.7));');
    };
    mat.customProgramCacheKey = () => 'strand-manhole-v1';
    const m = new THREE.InstancedMesh(geo, mat, CAP.MANHOLE);
    m.count = 0;
    m.frustumCulled = false;
    m.name = 'Manholes';
    return m;
  }

  /** Wet road atlas: per-vertex atlas rect + continuous tile UV, sampled with textureGrad(fract()). */
  private createRoadMaterial(): THREE.MeshStandardMaterial {
    const r = this.tex.roads;
    // 12A-2 anisotropic wet-ribbon reflections of the nearest Mega-Billboards (inside lights_fragment_end).
    const megaRefl = /* glsl */ `
        // Audit fix: street-level effect — fades out as the camera rises 3 → 8 m above the asphalt (the 0.35 vertical
        // squash would otherwise align almost any steep reflection and flood the street seen from decks / roofs).
        float sMegaH = 1.0 - smoothstep(3.0, 8.0, cameraPosition.y - vCityWorld.y);
        float sRibR = min(roughnessFactor, sGutterR);
        if (uMegaReflEnabled > 0.5 && uMegaReflCount > 0 && sRibR < 0.42 && sMegaH > 0.0) {
          float wetMask = (1.0 - smoothstep(0.14, 0.42, sRibR)) * sMegaH;
          vec3 sV = normalize(cameraPosition - vCityWorld);
          // World normal = road normal map + puddle ripples (both already folded into the view-space normal).
          vec3 sWorldN = normalize(transformNormalByInverseViewMatrix(normal, viewMatrix));
          vec3 sR = reflect(-sV, sWorldN);
          float fres = 0.04 + 0.96 * pow(1.0 - clamp(dot(sWorldN, sV), 0.0, 1.0), 4.0);
          vec3 sRs = normalize(vec3(sR.x, sR.y * 0.35, sR.z));
          vec3 ribbonSum = vec3(0.0);
          for (int i = 0; i < ${MEGA_REFL.MAX}; i++) {
            if (i >= uMegaReflCount) break;
            vec3 toB = uMegaReflPos[i].xyz - vCityWorld;
            // Only asphalt in front of a one-sided screen can mirror it (no light through the host wall).
            if (uMegaReflNrm[i].z < 0.5 && dot(toB.xz, uMegaReflNrm[i].xy) > 0.0) continue;
            float dist = length(toB);
            if (dist > 85.0) continue;
            vec3 Ldir = toB / max(dist, 1e-3);
            // Anisotropic stretch: tight horizontally (screen width), elongated vertically along the wet asphalt.
            float alignY = max(dot(sRs, normalize(vec3(Ldir.x, Ldir.y * 0.35, Ldir.z))), 0.0);
            float spread = mix(42.0, 10.0, clamp(uMegaReflPos[i].w / 8.0, 0.0, 1.0));
            float lobe = pow(alignY, spread * mix(1.2, 0.45, sRibR));
            float atten = 1.0 / (1.0 + dist * dist * 0.0018);
            ribbonSum += uMegaReflCol[i].rgb * lobe * atten;
          }
          reflectedLight.indirectSpecular += ribbonSum * wetMask * fres * 0.65;
        }
    `;
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: r.map,
      roughness: 1.0,
      roughnessMap: r.roughnessMap,
      metalness: MATERIALS.ROOF_WET.metalness,
      normalMap: r.normalMap,
      normalScale: new THREE.Vector2(0.45, 0.45),
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.uTime;
      // 12A-2 Mega-Billboard ribbons (nearest 8, selected allocation-free in update()).
      shader.uniforms.uMegaReflPos = this.uMegaReflPos;
      shader.uniforms.uMegaReflCol = this.uMegaReflCol;
      shader.uniforms.uMegaReflNrm = this.uMegaReflNrm;
      shader.uniforms.uMegaReflCount = this.uMegaReflCount;
      shader.uniforms.uMegaReflEnabled = this.uMegaReflEnabled;
      this.injectCityLights(shader);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 aAtlas;\nvarying vec4 vAtlas;\nvarying vec2 vTileUv;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\nvAtlas = aAtlas;\nvTileUv = uv;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nuniform float uTime;\nvarying vec4 vAtlas;\nvarying vec2 vTileUv;\n${GLSL_HASH}\n${GLSL_RIPPLES}\n${GLSL_MEGA_REFL_PARS}\n#define STRAND_INDOOR_TEST false`)
        .replace('#include <map_fragment>', `
          vec2 sRSize = vAtlas.zw - vAtlas.xy;
          vec2 sRUv = vAtlas.xy + sRSize * fract(vTileUv);
          vec2 sRGX = dFdx(vTileUv) * sRSize;
          vec2 sRGY = dFdy(vTileUv) * sRSize;
          diffuseColor *= textureGrad(map, sRUv, sRGX, sRGY);`)
        .replace('#include <roughnessmap_fragment>', `
          float roughnessFactor = roughness * textureGrad(roughnessMap, sRUv, sRGX, sRGY).g;
          // 9A-6: low-frequency gutter / alley grime patches (albedo 0.72–1.0).
          float sGrime = smoothstep(0.42, 0.78, sNoise(vCityWorld.xz * 0.045) * 0.65 + sNoise(vCityWorld.xz * 0.19 + 3.1) * 0.35);
          diffuseColor.rgb *= mix(1.0, 0.72, sGrime);
          roughnessFactor = mix(roughnessFactor, min(1.0, roughnessFactor + 0.1), sGrime * 0.6);
          // 12A-2 tyre-track wear + curb gutter puddles. Across-road coordinate: ONLY the lane atlas tiles
          // (LANES4 u0 = 0 / LANES2 u0 = 0.5, both v0 = 0 → vAtlas.x < 0.7 && vAtlas.y < 0.25) carry
          // vTileUv.x = 0 … 1 from curb to curb (uAcross = width / tileAcross = 14/14, 10/10; expressway decks
          // pass 1). Crosswalks (u = 2 m bar tiles), plain asphalt (world-planar u = x / 6 m: junctions, plaza,
          // ramps) and zebras never get strips.
          // Gutter gloss seen by the billboard ribbons only (1 = none); direct lamp light keeps roughness ≥ 0.30 there.
          float sGutterR = 1.0;
          if (vAtlas.x < 0.7 && vAtlas.y < 0.25) {
            float sAcross = clamp(vTileUv.x, 0.0, 1.0);
            float sLanes = vAtlas.x < 0.25 ? 4.0 : 2.0;
            // Tyre-polished wheel paths (two per lane, at 1/4 and 3/4 of each lane width): slightly glossier.
            float sTrack = 0.5 - 0.5 * cos(fract(sAcross * sLanes) * 6.2832 * 2.0);
            sTrack *= sTrack * sTrack;
            roughnessFactor *= 1.0 - 0.12 * sTrack * (0.6 + 0.4 * sNoise(vCityWorld.xz * 0.21 + 5.3));
            // Glossy gutter puddles hugging both curbs (|u − 0.5| > 0.38), broken along the kerb. Audit fix: a 0.08–0.14
            // mirror under the kerb-side street lamps blew the bloom into a full-frame wash (+54 % frame mean), so the
            // lit material only drops to 0.30 there while the billboard ribbons see the 0.18–0.24 wet gloss (sGutterR).
            float sEdge = abs(sAcross - 0.5) + (sNoise(vCityWorld.xz * 0.8 + 1.3) - 0.5) * 0.04;
            float sGutter = smoothstep(0.38, 0.465, sEdge) * smoothstep(0.22, 0.5, sNoise(vCityWorld.xz * 0.33 + 9.1));
            roughnessFactor = mix(roughnessFactor, min(roughnessFactor, 0.30), sGutter);
            sGutterR = mix(1.0, mix(0.18, 0.24, sNoise(vCityWorld.xz * 0.9)), sGutter);
          }`)
        .replace('#include <normal_fragment_maps>', `
          {
            vec3 mapN = textureGrad(normalMap, sRUv, sRGX, sRGY).xyz * 2.0 - 1.0;
            mapN.xy *= normalScale;
            normal = normalize(tbn * mapN);
          }
          ${GLSL_PUDDLE_RIPPLES}`)
        // … and a thin-film oil-slick tint on the glossiest puddle regions (subtle: 0.08–0.13).
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
          ${megaRefl}
          {
            float sSlick = (1.0 - smoothstep(0.13, 0.22, roughnessFactor)) * smoothstep(0.35, 0.75, sNoise(vCityWorld.xz * 0.11 + 7.7));
            vec3 sV = normalize(cameraPosition - vCityWorld);
            float sPh = dot(sV, vec3(0.0, 1.0, 0.0)) * 6.0 + sNoise(vCityWorld.xz * 0.6) * 4.0;
            vec3 sFilm = 0.5 + 0.5 * cos(6.2832 * (vec3(0.0, 0.33, 0.67) + sPh));
            float sK = mix(0.08, 0.13, sNoise(vCityWorld.xz * 0.3)) * sSlick;
            reflectedLight.indirectSpecular *= mix(vec3(1.0), sFilm * 1.7, sK);
            reflectedLight.directSpecular *= mix(vec3(1.0), sFilm * 1.7, sK);
          }`);
    };
    mat.customProgramCacheKey = () => 'strand-road-v15';
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

  /** Expressway / bridge / canal-wall / pier / ramp concrete (#1A202C, R 0.48, M 0.30) + city lights + vertex AO. */
  private createHighwayConcreteMaterial(): THREE.MeshStandardMaterial {
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(COLORS.HIGHWAY_CONCRETE),
      roughness: MATERIALS.HIGHWAY_CONCRETE.roughness,
      metalness: MATERIALS.HIGHWAY_CONCRETE.metalness,
      normalMap: this.tex.roof.normalMap,
      normalScale: new THREE.Vector2(0.42, 0.42),
    });
    mat.onBeforeCompile = (shader) => {
      this.injectCityLights(shader);
      injectVertexAo(shader);
    };
    mat.customProgramCacheKey = () => 'strand-hwconcrete-v12';
    return mat;
  }

  /**
   * 10A-2 weathered wet steel (pipes, fire escapes, railings, canopies, SteelFixturesInstanced):
   * triplanar-lite `archDetail` at 1.2 m tile + `injectCityLights` + baked vertex AO.
   */
  private createSteelMaterial(instancedVariant: boolean): THREE.MeshStandardMaterial {
    const t = this.tex.archDetail;
    const mat = new THREE.MeshStandardMaterial({
      color: 0x343b47,
      roughness: 0.44,
      metalness: 0.8,
      envMapIntensity: 0.95,
    });
    const uArchMap = { value: t.map };
    const uArchRough = { value: t.roughnessMap };
    const uArchNormal = { value: t.normalMap };
    mat.onBeforeCompile = (shader) => {
      this.injectCityLights(shader);
      injectVertexAo(shader);
      shader.uniforms.uArchMap = uArchMap;
      shader.uniforms.uArchRough = uArchRough;
      shader.uniforms.uArchNormal = uArchNormal;
      if (instancedVariant) {
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nattribute float aVar;\nattribute float aInstVar;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\n  transformed *= (abs(aVar - aInstVar) < 0.5) ? 1.0 : 0.0;');
      }
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
uniform sampler2D uArchMap;
uniform sampler2D uArchRough;
uniform sampler2D uArchNormal;
vec2 strandSteelTriUv(vec3 p, vec3 n) {
  vec3 an = abs(n);
  if (an.y >= an.x && an.y >= an.z) return p.xz * 0.833333;
  if (an.x >= an.z) return p.zy * 0.833333;
  return p.xy * 0.833333;
}`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
  vec2 strandSteelUv = strandSteelTriUv(vCityWorld, vCityWorldN);
  vec3 strandSteelAlb = texture2D(uArchMap, strandSteelUv).rgb;
  diffuseColor.rgb *= mix(vec3(1.0), strandSteelAlb * 1.22, 0.85);`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
  float strandSteelR = texture2D(uArchRough, strandSteelUv).g;
  roughnessFactor = clamp(roughnessFactor * mix(0.68, 1.32, strandSteelR), 0.18, 0.76);`,
        )
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
  {
    vec3 sDn = texture2D(uArchNormal, strandSteelUv).xyz * 2.0 - 1.0;
    vec3 sAn = abs(vCityWorldN);
    vec3 sPert;
    if (sAn.y >= sAn.x && sAn.y >= sAn.z) sPert = vec3(sDn.x, 0.0, sDn.y);
    else if (sAn.x >= sAn.z) sPert = vec3(0.0, sDn.y, sDn.x);
    else sPert = vec3(sDn.x, sDn.y, 0.0);
    normal = normalize(normal + mat3(viewMatrix) * (sPert * 0.28));
  }`,
        );
    };
    const key = instancedVariant ? 'strand-steel-inst-v2' : 'strand-steel-v2';
    mat.customProgramCacheKey = () => key;
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

  /** 12A-3.1 shared 1 × 1 flat-normal placeholder (keeps optional samplers valid when a texture is missing). */
  private static placeholder(): THREE.DataTexture {
    if (!CityBuilder.placeholderTex) {
      const t = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1, THREE.RGBAFormat);
      t.needsUpdate = true;
      CityBuilder.placeholderTex = t;
    }
    return CityBuilder.placeholderTex;
  }

  /**
   * 10C-1 hero parked-car material (#171D28 base, R 0.22, M 0.78). Per-vertex aPart: 0 painted clearcoat body ·
   * 1 glass · 2 front LED · 3 rear LED · 4 carbon / rubber / dark mesh · 5 taxi roof sign · 6 brushed alloy ·
   * 7 crimson caliper / tow hook · 8 glowing plate · 9 amber marker / strobe. Per-vertex aAo (baked contact +
   * cavity occlusion). Per-instance aCar: (frontCyan 0|1, LED intensity 2.2–2.8, hazard 0|1, phase).
   * Body shading: wet clearcoat Fresnel sheen, lower-body splash grime (local y < 0.38), faint panel seams.
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
    // 12A-3.1 zero-UV close-up detail (cars carry NO uv attribute: mat.normalMap / roughnessMap stay null).
    const vd = this.tex.vehicleDetail;
    const ph = CityBuilder.placeholder();
    const uDetailNormal = { value: vd?.normalMap ?? ph };
    const uDetailRough = { value: vd?.roughnessMap ?? ph };
    const uHasVehicleDetail = { value: vd ? 1 : 0 };
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.uTime;
      shader.uniforms.uDetailNormal = uDetailNormal;
      shader.uniforms.uDetailRough = uDetailRough;
      shader.uniforms.uHasVehicleDetail = uHasVehicleDetail;
      // 5B-2: lamps and neon light up the bodywork (instanced world position).
      this.injectCityLights(shader);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aPart;\nattribute float aAo;\nattribute vec4 aCar;\nattribute float aPaint;\nvarying float vPart;\nvarying float vCarAo;\nvarying vec3 vLocal;\nvarying vec3 vLocalN;\nvarying vec4 vCar;\nvarying float vPaint;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\nvPart = aPart;\nvCarAo = aAo;\nvLocal = position;\nvLocalN = normal;\nvCar = aCar;\nvPaint = aPaint;')
        // 7B-4: the taxi roof sign (aPart 5) only exists on cyber-taxi paint.
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          if (abs(aPart - 5.0) < 0.5 && aPaint < ${(CITY_FX.CAR_TAXI - 0.5).toFixed(1)}) transformed = vec3(0.0);`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform float uTime;
          varying float vPart;
          varying float vCarAo;
          varying vec3 vLocal;
          varying vec3 vLocalN;
          varying vec4 vCar;
          varying float vPaint;
          uniform sampler2D uDetailNormal;
          uniform sampler2D uDetailRough;
          uniform float uHasVehicleDetail;
          ${GLSL_COTANGENT}
          vec3 strandPaint(float k) {
            ${CITY_FX.CAR_PAINTS.map((h, i) => { const c = new THREE.Color(h); return `if (k < ${i + 0.5}) return vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)});`; }).join('\n            ')}
            return vec3(0.02);
          }`)
        .replace('#include <map_fragment>', `#include <map_fragment>
          float sPart = floor(vPart + 0.5);
          // 7B-4: six body paints per instance (the weathered pearl gets a dusty, rougher coat).
          if (sPart == 0.0) {
            vec3 paint = strandPaint(vPaint);
            // Lower splash grime near the wheel wells / sills, thin panel seams every ~1.1 m.
            float grime = 1.0 - smoothstep(0.12, 0.38, vLocal.y);
            float seam = 1.0 - 0.4 * smoothstep(0.488, 0.5, abs(fract(vLocal.z * 0.9 + 0.31) - 0.5));
            diffuseColor.rgb = mix(paint, vec3(0.012, 0.012, 0.013), grime * 0.55) * seam;
          } else if (sPart == 1.0) diffuseColor.rgb = vec3(0.006, 0.008, 0.012);
          else if (sPart == 4.0) diffuseColor.rgb = vec3(0.012, 0.012, 0.014);
          else if (sPart == 6.0) diffuseColor.rgb = vec3(0.30, 0.32, 0.35);
          else if (sPart == 7.0) diffuseColor.rgb = vec3(0.30, 0.012, 0.02);
          else if (sPart >= 2.0) diffuseColor.rgb = vec3(0.05);
          diffuseColor.rgb *= vCarAo;
          // 12A-3.1 close-up detail quadrant per part (local planar uv, metres per tile per quadrant):
          // 4 carbon (Q0) except front-facing intakes / grilles → honeycomb (Q1, aPart untouched) · 6 brushed alloy
          // (Q2) · 0 paint / 1 glass → clearcoat rain beading (Q3, subtle). Tyres (part 4 inside the wheel zone)
          // stay plain rubber. Fades out 18 → 25 m (no shimmer, zero cost beyond).
          vec3 sAn = abs(vLocalN);
          vec2 sPlanar = sAn.y > 0.5 ? vLocal.xz : (sAn.z > 0.5 ? vLocal.xy : vLocal.zy);
          bool sTyreZone = abs(vLocal.x) > 0.62 && vLocal.y < 0.88 && abs(abs(vLocal.z) - 1.49) < 0.54;
          vec2 sQ = vec2(-1.0);
          float sTileM = 0.35;
          float sNStr = 0.0;
          float sRW = 0.0;
          float sCav = 0.5;
          if (sPart == 4.0 && !sTyreZone) {
            bool sGrille = sAn.z > 0.7 && vLocal.z > 0.5 && vLocalN.z > 0.0;
            sQ = sGrille ? vec2(0.5, 0.0) : vec2(0.0, 0.0);
            // Audit fix: carbon at 0.30 m / 0.8 aliased into running-bond "brickwork" at 2–4 m; 0.12 m tiles
            // (≈ 4 mm tows) mip into a fine diagonal twill sheen, with softer normals and cavity.
            sTileM = sGrille ? 0.25 : 0.12;
            sNStr = sGrille ? 1.0 : 0.35;
            sCav = sGrille ? 0.5 : 0.2;
            sRW = 0.8;
          } else if (sPart == 6.0) {
            sQ = vec2(0.0, 0.5); sTileM = 0.16; sNStr = 0.6; sRW = 0.55;
          } else if (sPart < 1.5) {
            // Lead tune: beads stay a subtle wet sparkle (0.35 read as hail pocks on pale paint at 3 m).
            sQ = vec2(0.5, 0.5); sTileM = 0.35; sNStr = sPart == 0.0 ? 0.18 : 0.14; sRW = sPart == 0.0 ? 0.35 : 0.0;
          }
          vec2 sUvDet = sPlanar / sTileM;
          vec2 sDuv1 = dFdx(sUvDet);
          vec2 sDuv2 = dFdy(sUvDet);
          vec3 sDp1 = dFdx(-vViewPosition);
          vec3 sDp2 = dFdy(-vViewPosition);
          float sDetW = uHasVehicleDetail * step(0.0, sQ.x) * (1.0 - smoothstep(18.0, 25.0, length(vViewPosition)));
          vec3 sDetN = vec3(0.0, 0.0, 1.0);
          vec4 sDetRM = vec4(1.0);
          if (sDetW > 0.001) {
            vec2 sDUv = sQ + 0.008 + fract(sUvDet) * 0.484;
            sDetN = textureGrad(uDetailNormal, sDUv, sDuv1 * 0.484, sDuv2 * 0.484).xyz * 2.0 - 1.0;
            sDetRM = textureGrad(uDetailRough, sDUv, sDuv1 * 0.484, sDuv2 * 0.484);
            // Cavity / AO (R, 1 = open) darkens the tow gaps, honeycomb cells and grooves a little.
            diffuseColor.rgb *= mix(1.0, sDetRM.r, sCav * sDetW);
          }`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          if (sPart == 1.0) roughnessFactor = 0.05;
          else if (sPart == 4.0) roughnessFactor = 0.72;
          else if (sPart == 6.0) roughnessFactor = 0.24;
          else if (sPart == 7.0) roughnessFactor = 0.32;
          else if (sPart == 0.0) {
            // Wet clearcoat: glossy upper panels, duller dirty sills; the pearl paint stays dusty.
            roughnessFactor = mix(0.16, 0.52, 1.0 - smoothstep(0.12, 0.38, vLocal.y));
            if (abs(vPaint - 3.0) < 0.5) roughnessFactor = min(1.0, roughnessFactor + 0.22);
          }
          // 12A-3.1 detail roughness (G = absolute roughness) blended over the per-part value.
          roughnessFactor = mix(roughnessFactor, sDetRM.g, sRW * sDetW);`)
        .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
          if (sPart == 1.0 || sPart == 6.0) metalnessFactor = 0.92;
          else if (sPart == 4.0) metalnessFactor = 0.15;
          else if (sPart == 7.0) metalnessFactor = 0.4;`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
          // 12A-3.1 detail normal through a derivative-based tangent frame (view space, no uv / tangents).
          if (sDetW > 0.001) {
            mat3 sTbn = strandCotangentFrame(normal, sDp1, sDp2, sDuv1, sDuv2);
            vec3 sMapN = vec3(sDetN.xy * (sNStr * sDetW), 1.0);
            normal = normalize(sTbn * sMapN);
          }`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          {
            float blink = step(0.5, fract(uTime * 1.5 + vCar.w));
            vec3 led = vec3(0.0);
            if (sPart == 2.0) led = vCar.z > 0.5 ? ${v3(COLORS.CAR_HAZARD)} * blink : mix(${v3(COLORS.CAR_LED_WHITE)}, ${v3(COLORS.CAR_LED_CYAN)}, vCar.x);
            else if (sPart == 3.0) led = ${v3(COLORS.CAR_LED_REAR)} * (vCar.z > 0.5 ? (0.25 + 0.75 * blink) : 1.0);
            else if (sPart == 5.0) led = ${v3(0xffb020)} * 0.55;
            else if (sPart == 9.0) led = ${v3(COLORS.CAR_HAZARD)} * (0.35 + 0.65 * step(0.5, fract(uTime * 2.0 + vCar.w * 3.0)));
            totalEmissiveRadiance = led * vCar.y;
            // Glowing cool-white cyber plate (0.85, below harsh bloom).
            if (sPart == 8.0) totalEmissiveRadiance = vec3(0.55, 0.72, 1.0) * 0.85;
            // Rain-wet clearcoat Fresnel sheen on the painted shell and glass.
            if (sPart < 1.5) {
              float fr = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 4.0);
              totalEmissiveRadiance += vec3(0.20, 0.26, 0.36) * fr * (sPart == 0.0 ? 0.55 : 0.8);
            }
          }`);
    };
    mat.customProgramCacheKey = () => 'strand-car-v15-detail';
    return mat;
  }

  /**
   * 10C-3 detailed gooseneck street lamps: aPart 0 cast steel · 1 LED lens (cool white) · 2 neon accent ring / banner
   * trim (per-instance tint) · 3 green status LED · 5 banner flag cloth (only on every other lamp).
   */
  private createLampMaterial(): THREE.MeshStandardMaterial {
    const mat = new THREE.MeshStandardMaterial({ color: 0x252a33, roughness: 0.4, metalness: 0.85, emissive: new THREE.Color(0xffffff) });
    const lamp = new THREE.Color(COLORS.STREET_LAMP);
    mat.onBeforeCompile = (shader) => {
      // 10BC-Fix FIX-13: close-up metal picks up the city lights and the baked per-vertex AO.
      this.injectCityLights(shader);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aPart;\nattribute float aAo;\nattribute vec3 aTint;\nvarying float vPart;\nvarying float vAoL;\nvarying vec3 vTint;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\nvPart = aPart;\nvAoL = aAo;\nvTint = aTint;')
        // 10BC-Fix FIX-9: flag cloth (5), banner trim (6) and banner arms (7) collapse together on odd poles.
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nif (aPart > 4.5 && (gl_InstanceID & 1) == 1) transformed = vec3(0.0);');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vPart;\nvarying float vAoL;\nvarying vec3 vTint;')
        .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb *= vAoL;')
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          {
            float p = floor(vPart + 0.5);
            // 5B-1: lamp head 1.45 / neon ring 1.30 — point accents bloom (wide window walls stay ≤ 0.28).
            totalEmissiveRadiance = p == 1.0 ? vec3(${lamp.r.toFixed(3)}, ${lamp.g.toFixed(3)}, ${lamp.b.toFixed(3)}) * ${NEON_BLOOM.LAMP_HEAD.toFixed(2)} : ((p == 2.0 || p == 6.0) ? vTint * ${NEON_BLOOM.LAMP_RING.toFixed(2)} : vec3(0.0));
            if (p == 3.0) totalEmissiveRadiance = vec3(0.2, 1.0, 0.35) * 1.1;
            else if (p == 5.0) totalEmissiveRadiance = vTint * 0.32;
            else if (p == 0.0 || p == 7.0) totalEmissiveRadiance = vec3(0.0);
          }`);
    };
    mat.customProgramCacheKey = () => 'strand-lamp-v14-hero';
    return mat;
  }

  /**
   * 10C-2 vending kiosks. aPart: 0 steel · 1 display (atlas) · 2 marquee (atlas) · 3 control bezel (atlas) ·
   * 4 dark cavity / rubber · 5 brushed steel · 6 white downlight · 7 tint accent · 8 anodised bezel. Per-vertex aAo;
   * per-instance aTint (accent) and aBrand (0–3: NI-COLA · SYNTH-CAF · K-BOOST · ZERO-H2O quadrant of the atlas).
   */
  private createVendingMaterial(): THREE.MeshStandardMaterial {
    const mat = new THREE.MeshStandardMaterial({ color: 0x1c2230, roughness: 0.3, metalness: 0.6, emissive: new THREE.Color(0xffffff) });
    const atlas = this.tex.vendingAtlas ?? null;
    mat.onBeforeCompile = (shader) => {
      // 10BC-Fix FIX-13: the brushed-steel cabinet picks up the nearby city lights up close.
      this.injectCityLights(shader);
      shader.uniforms.uVendAtlas = { value: atlas };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aPart;\nattribute float aAo;\nattribute vec3 aTint;\nattribute float aBrand;\nvarying float vPart;\nvarying float vAoV;\nvarying vec3 vTint;\nvarying vec2 vVUv;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\nvPart = aPart;\nvAoV = aAo;\nvTint = aTint;\nfloat bq = floor(aBrand + 0.5);\nvVUv = uv + vec2(mod(bq, 2.0) * 0.5, -floor(bq * 0.5) * 0.5);');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D uVendAtlas;\nvarying float vPart;\nvarying float vAoV;\nvarying vec3 vTint;\nvarying vec2 vVUv;')
        .replace('#include <map_fragment>', `#include <map_fragment>
          float vp = floor(vPart + 0.5);
          vec3 vAtl = vec3(0.0);
          if (vp > 0.5 && vp < 3.5) {
            vAtl = texture2D(uVendAtlas, vVUv).rgb;
            diffuseColor.rgb = vAtl * 0.22;
          } else if (vp == 4.0) diffuseColor.rgb = vec3(0.012);
          else if (vp == 5.0) diffuseColor.rgb = vec3(0.34, 0.36, 0.4);
          else if (vp == 8.0) diffuseColor.rgb = vec3(0.12, 0.13, 0.16);
          diffuseColor.rgb *= vAoV;`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          if (vp == 5.0 || vp == 8.0) roughnessFactor = 0.26;
          else if (vp == 4.0) roughnessFactor = 0.82;
          else if (vp > 0.5 && vp < 3.5) roughnessFactor = 0.16;`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          totalEmissiveRadiance = vec3(0.0);
          if (vp == 1.0) totalEmissiveRadiance = vAtl * 0.85;
          else if (vp == 2.0) totalEmissiveRadiance = vAtl * 1.0;
          else if (vp == 3.0) totalEmissiveRadiance = vAtl * 0.95;
          else if (vp == 6.0) totalEmissiveRadiance = vec3(1.0, 0.96, 0.88) * 1.05;
          else if (vp == 7.0) totalEmissiveRadiance = vTint * 0.9;`);
    };
    mat.customProgramCacheKey = () => 'strand-vending-v13-hero';
    return mat;
  }

  /**
   * 10C-3 StreetFurnishingsKit material (one draw for variants 0..3). Per-vertex aPart / aAo / aVar, per-instance
   * aKit = (variant, tint 0 crimson … 1 charcoal, 0, 0): vertices of other variants collapse in the vertex shader.
   * v0 lanterns: 1 red / 2 orange paper (emissive 1.35). v1 parasol: 1 wet canopy, 2 underside, 3 cage bulb.
   */
  private createFurnishingsMaterial(): THREE.MeshStandardMaterial {
    const mat = new THREE.MeshStandardMaterial({ color: 0x20242c, roughness: 0.4, metalness: 0.5, emissive: new THREE.Color(0xffffff) });
    const atlas = this.tex.furnishingsAtlas ?? null;
    mat.onBeforeCompile = (shader) => {
      this.injectCityLights(shader);
      // 10D-3: custom atlas uniform (never mat.map) for the ramen marquee / transit map.
      shader.uniforms.uFurnAtlas = { value: atlas };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aPart;\nattribute float aAo;\nattribute float aVar;\nattribute vec4 aKit;\nvarying float vPart;\nvarying float vAoK;\nvarying float vVar;\nvarying vec4 vKit;\nvarying vec2 vFUv;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\nvPart = aPart;\nvAoK = aAo;\nvVar = aVar;\nvKit = aKit;\nvFUv = uv;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nif (abs(aVar - aKit.x) > 0.5) transformed = vec3(0.0);');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D uFurnAtlas;\nvarying float vPart;\nvarying float vAoK;\nvarying float vVar;\nvarying vec4 vKit;\nvarying vec2 vFUv;')
        .replace('#include <map_fragment>', `#include <map_fragment>
          float kp = floor(vPart + 0.5);
          float kv = floor(vVar + 0.5);
          vec3 fAtl = vec3(0.0);
          if (kv >= 1.5 && kp == 4.0) fAtl = texture2D(uFurnAtlas, vFUv).rgb;
          if (kv == 0.0) {
            diffuseColor.rgb = kp == 1.0 ? vec3(0.35, 0.03, 0.02) : (kp == 2.0 ? vec3(0.4, 0.12, 0.02) : vec3(0.03, 0.022, 0.02));
          } else if (kv == 1.0) {
            if (kp == 0.0) diffuseColor.rgb = vec3(0.17, 0.18, 0.2);
            else if (kp == 1.0) diffuseColor.rgb = mix(vec3(0.22, 0.012, 0.02), vec3(0.04, 0.04, 0.05), vKit.y);
            else if (kp == 2.0) diffuseColor.rgb = mix(vec3(0.08, 0.008, 0.012), vec3(0.02, 0.02, 0.025), vKit.y);
            else diffuseColor.rgb = vec3(0.3, 0.2, 0.1);
          } else if (kv == 2.0) {
            if (kp == 0.0) diffuseColor.rgb = vec3(0.05, 0.055, 0.06);
            else if (kp == 1.0) diffuseColor.rgb = vec3(0.42, 0.43, 0.45);
            else if (kp == 2.0) diffuseColor.rgb = vec3(0.13, 0.065, 0.03);
            else if (kp == 4.0) diffuseColor.rgb = fAtl * 0.2;
            else if (kp == 5.0) diffuseColor.rgb = vec3(0.02, 0.025, 0.03);
            else if (kp == 6.0) diffuseColor.rgb = vec3(0.55, 0.5, 0.44);
            else if (kp == 7.0) diffuseColor.rgb = vec3(0.24, 0.025, 0.02);
            else diffuseColor.rgb = vec3(0.05);
          } else {
            if (kp == 0.0) diffuseColor.rgb = vec3(0.05, 0.055, 0.065);
            else if (kp == 1.0) diffuseColor.rgb = vec3(0.4, 0.42, 0.45);
            else if (kp == 2.0) diffuseColor.rgb = vec3(0.08, 0.085, 0.09);
            else if (kp == 4.0) diffuseColor.rgb = fAtl * 0.2;
            else if (kp == 5.0) diffuseColor.rgb = vec3(0.02, 0.03, 0.035);
            else diffuseColor.rgb = vec3(0.05);
          }
          diffuseColor.rgb *= vAoK;`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          if (kv == 0.0) roughnessFactor = 0.6;
          else if (kv == 1.0) roughnessFactor = kp == 1.0 ? 0.26 : (kp == 0.0 ? 0.35 : 0.5);
          else if (kv == 2.0) roughnessFactor = kp == 1.0 ? 0.4 : (kp == 2.0 ? 0.72 : (kp == 5.0 || kp == 4.0 ? 0.08 : (kp == 6.0 ? 0.35 : 0.5)));
          else roughnessFactor = kp == 1.0 ? 0.3 : (kp == 5.0 || kp == 4.0 ? 0.06 : 0.42);`)
        .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
          if (kv == 0.0) metalnessFactor = 0.0;
          else if (kv == 1.0) metalnessFactor = kp == 1.0 ? 0.05 : 0.5;
          else if (kv == 2.0) metalnessFactor = kp == 1.0 ? 0.72 : (kp == 0.0 ? 0.6 : 0.05);
          else metalnessFactor = kp == 1.0 ? 0.85 : (kp == 0.0 || kp == 2.0 ? 0.6 : 0.05);`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          totalEmissiveRadiance = vec3(0.0);
          if (kv == 0.0) {
            if (kp == 1.0) totalEmissiveRadiance = vec3(1.0, 0.22, 0.08) * 1.35;
            else if (kp == 2.0) totalEmissiveRadiance = vec3(1.0, 0.52, 0.14) * 1.35;
          } else if (kv == 1.0) {
            if (kp == 3.0) totalEmissiveRadiance = vec3(1.0, 0.7, 0.38) * 1.3;
            else if (kp == 1.0) {
              // 10D-Fix FIX-5: rain-wet canopy Fresnel sheen (restored from v1).
              float fr = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 4.0);
              totalEmissiveRadiance = vec3(0.22, 0.26, 0.34) * fr * 0.5;
            }
          } else if (kv == 2.0) {
            if (kp == 3.0) totalEmissiveRadiance = vec3(1.0, 0.62, 0.3) * 1.3;
            else if (kp == 4.0) totalEmissiveRadiance = fAtl * 1.05;
          } else {
            if (kp == 3.0) totalEmissiveRadiance = vec3(0.75, 0.95, 1.0) * 1.15;
            else if (kp == 4.0) totalEmissiveRadiance = fAtl * 0.95;
          }`);
    };
    mat.customProgramCacheKey = () => 'strand-furnishings-v3';
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
          // 10B-1: the lockdown wall is invisible (alpha 0) beyond 14 m and fades in only from 14 m → 3 m.
          float prox = 1.0 - smoothstep(${BARRIER_NEAR_M.toFixed(1)}, ${BARRIER_FAR_M.toFixed(1)}, dist);
          if (k < 0.5) {
            // Faint wall: only reveals itself near the player.
            float near = prox;
            c = uCyan * (hex * 0.55 + 0.03) * near * scan * (1.0 - smoothstep(6.0, 40.0, vWorld.y - cameraPosition.y));
          } else {
            float frame = max(smoothstep(0.03, 0.0, min(vUv.x, 1.0 - vUv.x)), smoothstep(0.04, 0.0, 1.0 - vUv.y));
            float stripes = step(0.5, fract((along + vWorld.y) * 0.35 - uTime * 0.8));
            float topFade = 1.0 - smoothstep(0.55, 1.0, vUv.y);
            vec3 locked = uRed * (hex * 0.9 + 0.12 + frame * 1.6) * scan + uAmber * stripes * 0.18 * topFade;
            if (k > 1.5) {
              // The open emerald next-sector gate stays visible from anywhere.
              float chev = step(0.5, fract(vWorld.y * 0.25 - abs(vUv.x - 0.5) * 2.0 - uTime * 1.2));
              vec3 open = uJade * (frame * uJadeI + hex * 0.35 + chev * 0.25 * topFade);
              c = mix(locked * prox, open, uGateOpen);
            } else {
              c = locked * prox;
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
    const skyGlow = (h: number): string => {
      const c = new THREE.Color(h);
      return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
    };
    const geo = new THREE.SphereGeometry(2400, 64, 32);
    const moonDir = new THREE.Vector3(-0.45, 0.62, -0.64).normalize();
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uZenith: { value: new THREE.Color(COLORS.SKY_ZENITH) },
        // 12A-4: shared with setSkyHorizon() (exact scene fog colour, per sector).
        uHorizon: this.uSkyHorizon,
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
        const vec3 GLOW_MAGENTA = ${skyGlow(CITY_FX.SKY_GLOW_MAGENTA)};
        const vec3 GLOW_CYAN = ${skyGlow(CITY_FX.SKY_GLOW_CYAN)};
        const vec3 GLOW_AMBER = ${skyGlow(CITY_FX.SKY_GLOW_AMBER)};
        void main() {
          vec3 d = normalize(vDir);
          float y = d.y;
          // At / below the horizon = exact fog colour so fogged towers dissolve seamlessly.
          vec3 col = mix(uHorizon, uZenith, smoothstep(0.0, 0.42, y));
          // City light pollution: magenta / violet haze above the skyline.
          col += vec3(0.022, 0.009, 0.036) * exp(-max(y, 0.0) * 7.0) * smoothstep(-0.06, 0.05, y);
          // 7B-5: heavy 3-octave storm deck, its belly lit from below by the city's light pollution (slowly
          // drifting magenta / cyan / amber zones), thinning toward the zenith.
          vec2 cp = d.xz / max(y + 0.15, 0.05) * 1.6 + vec2(uTime * 0.004, uTime * 0.002);
          float fb = sNoise(cp) * 0.55 + sNoise(cp * 2.3 + 7.1) * 0.3 + sNoise(cp * 5.1 + 3.3) * 0.15;
          float cloud = smoothstep(0.42, 0.8, fb);
          float deck = cloud * smoothstep(0.02, 0.25, y);
          vec2 zp = d.xz / max(y + 0.3, 0.1) * 0.35 + uTime * 0.0015;
          float zm = sNoise(zp);
          float zc = sNoise(zp + 17.3);
          vec3 glow = mix(mix(GLOW_AMBER, GLOW_MAGENTA, smoothstep(0.3, 0.7, zm)), GLOW_CYAN, smoothstep(0.45, 0.8, zc));
          float under = (1.0 - smoothstep(0.05, 0.55, y)) * (0.35 + 0.65 * (1.0 - fb));
          col = mix(col, vec3(0.018, 0.014, 0.028), deck * 0.82);
          col += glow * 0.11 * deck * under;
          // 7B-5: distant lightning — one strike per ~22 s (18–26 s apart), a pale double flash deep inside the
          // clouds above a random stretch of the skyline.
          {
            float P = ${CITY_FX.LIGHTNING_PERIOD_S.toFixed(1)};
            float k = floor(uTime / P);
            float st = k * P + P * 0.5 + (fract(k * 0.618034 + 0.137) - 0.5) * ${(2 * CITY_FX.LIGHTNING_JITTER_S).toFixed(1)};
            float az = fract(k * 0.754877 + 0.31) * 6.2831853;
            float dt = uTime - st;
            float fl = (dt >= 0.0 && dt < 0.08) ? 1.0 - dt / 0.08 * 0.3 : ((dt >= 0.18 && dt < 0.32) ? 0.85 * (1.0 - (dt - 0.18) / 0.14) : 0.0);
            if (fl > 0.0) {
              vec2 hd = normalize(d.xz + vec2(1e-4));
              float dirW = pow(max(dot(hd, vec2(cos(az), sin(az))), 0.0), 7.0);
              float band = smoothstep(0.0, 0.07, y) * (1.0 - smoothstep(0.18, 0.6, y));
              col += vec3(0.5, 0.58, 0.82) * fl * dirW * band * (0.2 + cloud) * 0.5;
            }
          }
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

  private createGuardrailGeometry(): THREE.BufferGeometry {
    // 3 m W-beam segment along X with two posts (1.0 m tall).
    return mergeOrEmpty([
      boxAt(0.1, 1.0, 0.1, -1.45, 0.5, 0),
      boxAt(0.1, 1.0, 0.1, 1.45, 0.5, 0),
      boxAt(3.0, 0.32, 0.06, 0, 0.78, 0.07),
      boxAt(3.0, 0.06, 0.08, 0, 0.98, 0.04),
    ].map(stripUv));
  }

  /**
   * 11B-3 RoofMechKit (-1 draw call): the AC-unit and exhaust-duct geometries merged into one InstancedMesh. Per-vertex
   * `aPart` (0 = AC unit, 1 = duct) vs per-instance `aInstVar` collapses the other part to the origin; AC units keep
   * the `machinery` PBR maps (albedo / roughness / normal, metalness 0.55), ducts keep their former untextured
   * 0x4a525e steel (roughness 0.30, metalness 0.90, no normal map). Ducts still scale along local X (length).
   */
  private createRoofMechKit(machinery: THREE.MeshStandardMaterial): THREE.InstancedMesh {
    const tag = (g: THREE.BufferGeometry, part: number): THREE.BufferGeometry => {
      const n = g.getAttribute('position').count;
      g.setAttribute('aPart', new THREE.Float32BufferAttribute(new Float32Array(n).fill(part), 1));
      return g;
    };
    const geo = mergeOrEmpty([tag(this.createAcGeometry(), 0), tag(this.createDuctGeometry(), 1)]);
    geo.setAttribute('aInstVar', new THREE.InstancedBufferAttribute(new Float32Array(CAP.AC + CAP.DUCT), 1));
    const mat = machinery;
    const duct = new THREE.Color(0x4a525e);
    const dv = `vec3(${duct.r.toFixed(5)}, ${duct.g.toFixed(5)}, ${duct.b.toFixed(5)})`;
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aPart;\nattribute float aInstVar;\nvarying float vMechDuct;')
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvMechDuct = aInstVar;\nif (abs(aPart - aInstVar) > 0.5) transformed = vec3(0.0);',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vMechDuct;')
        .replace('#include <map_fragment>', `#include <map_fragment>\nif (vMechDuct > 0.5) diffuseColor.rgb = ${dv};`)
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nif (vMechDuct > 0.5) roughnessFactor = 0.30;')
        .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nif (vMechDuct > 0.5) metalnessFactor = 0.90;')
        .replace('#include <normal_fragment_maps>', 'if (vMechDuct < 0.5) {\n#include <normal_fragment_maps>\n}');
    };
    mat.customProgramCacheKey = () => 'strand-roofmech-v1';
    return this.makeInstanced(geo, mat, CAP.AC + CAP.DUCT, 'RoofMechKit');
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

  /** 10A-1 consolidated steel fixtures geometry: v0 guardrail, v1 fence, v2 antenna (−2 draw calls). */
  private createSteelFixturesGeometry(): THREE.BufferGeometry {
    const prep = (g: THREE.BufferGeometry, v: number): THREE.BufferGeometry => withAttr1(ensureAo(stripUv(g)), 'aVar', v);
    return mergeOrEmpty([
      prep(this.createGuardrailGeometry(), 0),
      prep(this.createFenceGeometry(), 1),
      prep(this.createAntennaGeometry(), 2),
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
        varying float vSid;
        void main() {
          vUv = uv;
          vStrip = aStrip;
          vFormat = aFormat;
          vec4 c0 = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          vSid = fract(sin(dot(c0.xz, vec2(12.9898, 78.233)) + c0.y * 3.17) * 43758.5453);
          vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
          vDist = length(wp.xyz - cameraPosition);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform sampler2D uAtlas; uniform sampler2D uSigns; uniform float uStrips; uniform float uBoost; uniform float uFogDensity;
        varying vec2 vUv; varying float vStrip; varying float vFormat; varying float vDist; varying float vSid;
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
          // 9A-6: ~12 % of the tubes are failing — buzzing stutter and a dead segment band.
          if (vSid < 0.12) {
            float bz = h11(floor(uTime * 23.0) + vSid * 911.0);
            flicker *= bz < 0.3 ? 0.08 : bz < 0.45 ? 0.55 : 1.0;
            float seg = floor(vUv.y * 5.0);
            if (abs(seg - floor(vSid * 41.0)) < 0.5 || abs(seg - mod(floor(vSid * 41.0) + 3.0, 5.0)) < 0.5 && vSid < 0.05) flicker *= 0.12;
          }
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
   * 7B-3 volumetric lamp cones: an open cone from each lamp head (6.2 m, r 0.35) to 0.2 m (r 2.8), additive.
   * Vertical fade pow(1 − t, 1.8) · smoothstep(0, 0.08, t), silhouette-free view-edge fade |n·v|^2.2, faded close to
   * the camera (2 → 6 m) and with the fog; cool white with a hint of the pole's neon (≤ 0.11).
   */
  private createLampCones(): THREE.InstancedMesh {
    const C = CITY_FX;
    const geo = new THREE.CylinderGeometry(C.CONE_R_TOP, C.CONE_R_BOTTOM, C.CONE_HEIGHT, 28, 1, true);
    geo.translate(0, -C.CONE_HEIGHT / 2, 0);
    geo.setAttribute('aTint', new THREE.InstancedBufferAttribute(new Float32Array(CAP.LAMP * 3), 3));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uColor: { value: new THREE.Color(COLORS.STREET_LAMP) }, uFogDensity: this.uFogDensity },
      vertexShader: /* glsl */ `
        attribute vec3 aTint;
        varying vec3 vWorld; varying vec3 vN; varying float vAlong; varying vec3 vTint;
        void main() {
          vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          vN = normalize(mat3(modelMatrix * instanceMatrix) * normal);
          vAlong = clamp(-position.y / ${C.CONE_HEIGHT.toFixed(1)}, 0.0, 1.0);
          vTint = aTint;
          gl_Position = projectionMatrix * viewMatrix * w;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; uniform float uFogDensity;
        varying vec3 vWorld; varying vec3 vN; varying float vAlong; varying vec3 vTint;
        ${GLSL_FOG_FADE}
        void main() {
          vec3 toCam = cameraPosition - vWorld;
          float dist = length(toCam);
          float vert = pow(1.0 - vAlong, 1.8) * smoothstep(0.0, 0.08, vAlong);
          float edge = pow(abs(dot(normalize(vN), toCam / max(dist, 1e-3))), 2.2);
          float a = ${C.CONE_OPACITY.toFixed(3)} * vert * edge * smoothstep(2.0, 6.0, dist) * strandFogFade(dist, uFogDensity * 0.7);
          gl_FragColor = vec4(mix(uColor, vTint, 0.18) * a, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    const m = new THREE.InstancedMesh(geo, mat, CAP.LAMP);
    m.count = 0;
    m.frustumCulled = false;
    m.name = 'LampCones';
    m.renderOrder = 5;
    return m;
  }

  /**
   * 7B-4 cantilever traffic signals: pole, arm over the lanes, horizontal three-lamp head (double-faced).
   * aPart 1 red · 2 yellow · 3 green; per instance aPhase (s): the cycle green 10 s → yellow 2.5 s → red 12.5 s
   * runs entirely in the shader; the crossing axis is offset by 12.5 s so red / green invert in sync.
   */
  private createSignals(): THREE.InstancedMesh {
    const C = CITY_FX;
    const parts: THREE.BufferGeometry[] = [];
    const add = (g: THREE.BufferGeometry, id: number): void => {
      const ng = g.index ? g.toNonIndexed() : g;
      if (ng.getAttribute('uv')) ng.deleteAttribute('uv');
      parts.push(withAttr1(ng, 'aPart', id));
    };
    const pole = new THREE.CylinderGeometry(0.085, 0.1, C.SIGNAL_POLE_H, 10);
    pole.translate(0, C.SIGNAL_POLE_H / 2, 0);
    add(pole, 0);
    const base = new THREE.CylinderGeometry(0.16, 0.2, 0.3, 10);
    base.translate(0, 0.15, 0);
    add(base, 0);
    const armY = C.SIGNAL_POLE_H - 0.25;
    add(boxAt(C.SIGNAL_ARM, 0.12, 0.12, C.SIGNAL_ARM / 2, armY, 0), 0);
    const brace = new THREE.BoxGeometry(1.4, 0.06, 0.06);
    brace.rotateZ(0.55);
    brace.translate(0.6, armY - 0.38, 0);
    add(brace, 0);
    const hx = C.SIGNAL_ARM - 0.75;
    const hy = armY - 0.36;
    add(boxAt(0.08, 0.16, 0.08, hx, armY - 0.1, 0), 0);
    add(boxAt(1.36, 0.46, 0.34, hx, hy, 0), 0);
    const order = [3, 2, 1];
    for (let k = 0; k < 3; k++) {
      const x = hx + (k - 1) * 0.42;
      for (const sz of [-1, 1]) {
        const lens = new THREE.CylinderGeometry(0.15, 0.15, 0.03, 18);
        lens.rotateX(Math.PI / 2);
        lens.translate(x, hy, sz * 0.18);
        add(lens, order[k]);
        add(boxAt(0.36, 0.03, 0.16, x, hy + 0.17, sz * 0.25), 0);
      }
    }
    const geo = mergeOrEmpty(parts);
    geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(new Float32Array(C.SIGNALS_MAX), 1));
    const mat = new THREE.MeshStandardMaterial({ color: 0x2a2f37, roughness: 0.45, metalness: 0.8, emissive: new THREE.Color(0xffffff) });
    const cyc = C.SIGNAL_GREEN_S + C.SIGNAL_YELLOW_S + C.SIGNAL_RED_S;
    const red = new THREE.Color(0xff2430);
    const yel = new THREE.Color(0xffb020);
    const grn = new THREE.Color(0x1ff0b0);
    const c3 = (c: THREE.Color): string => `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.uTime;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aPart;\nattribute float aPhase;\nvarying float vPart;\nvarying float vPhase;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPart = aPart;\nvPhase = aPhase;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;\nvarying float vPart;\nvarying float vPhase;')
        .replace('#include <map_fragment>', `#include <map_fragment>
          float sp = floor(vPart + 0.5);
          if (sp > 0.5) diffuseColor.rgb = vec3(0.02, 0.022, 0.026);`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          {
            float t = mod(uTime + vPhase, ${cyc.toFixed(2)});
            float g = step(t, ${C.SIGNAL_GREEN_S.toFixed(2)});
            float y = step(${C.SIGNAL_GREEN_S.toFixed(2)}, t) * step(t, ${(C.SIGNAL_GREEN_S + C.SIGNAL_YELLOW_S).toFixed(2)});
            float r = 1.0 - g - y;
            vec3 e = vec3(0.0);
            if (sp == 1.0) e = ${c3(red)} * mix(0.035, ${C.SIGNAL_LENS.toFixed(2)}, r);
            else if (sp == 2.0) e = ${c3(yel)} * mix(0.035, ${C.SIGNAL_LENS.toFixed(2)}, y);
            else if (sp == 3.0) e = ${c3(grn)} * mix(0.035, ${C.SIGNAL_LENS.toFixed(2)}, g);
            totalEmissiveRadiance = e;
          }`);
    };
    mat.customProgramCacheKey = () => 'strand-signal-v1';
    const m = new THREE.InstancedMesh(geo, mat, C.SIGNALS_MAX);
    m.count = 0;
    m.frustumCulled = false;
    m.name = 'TrafficSignals';
    return m;
  }

  /**
   * 7B-4 head / tail light pools: soft additive quads on the road in front of (white / cyan, 4.5 m) and behind
   * (red, 2.8 m) every parked car; hazard cars blink in sync with their LEDs (same clock and phase as the car).
   * Per instance aPool = (r, g, b, gain) and aPoolB = (hazard, phase, front, 0).
   */
  private createCarPools(): THREE.InstancedMesh {
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    const n = LIMITS.PARKED_CARS * 2;
    geo.setAttribute('aPool', new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4));
    geo.setAttribute('aPoolB', new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -8,
      uniforms: { uTime: this.uTime, uFogDensity: this.uFogDensity, uHazard: { value: new THREE.Color(COLORS.CAR_HAZARD) } },
      vertexShader: /* glsl */ `
        attribute vec4 aPool; attribute vec4 aPoolB;
        varying vec2 vUv; varying vec4 vPool; varying vec4 vPoolB; varying float vDist;
        void main() {
          vUv = uv; vPool = aPool; vPoolB = aPoolB;
          vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
          vDist = length(w.xyz - cameraPosition);
          gl_Position = projectionMatrix * viewMatrix * w;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform float uFogDensity; uniform vec3 uHazard;
        varying vec2 vUv; varying vec4 vPool; varying vec4 vPoolB; varying float vDist;
        ${GLSL_FOG_FADE}
        void main() {
          float along = 1.0 - vUv.y;
          float across = (vUv.x - 0.5) * 2.0;
          float w = 0.42 + 0.58 * along;
          float a = pow(1.0 - smoothstep(0.0, 1.0, along), 1.3) * exp(-across * across / (w * w) * 2.6) * smoothstep(0.0, 0.06, along);
          float blink = step(0.5, fract(uTime * 1.5 + vPoolB.y));
          vec3 c = vPool.rgb;
          if (vPoolB.x > 0.5) c = vPoolB.z > 0.5 ? uHazard * blink : c * (0.25 + 0.75 * blink);
          gl_FragColor = vec4(c * a * vPool.a * strandFogFade(vDist, uFogDensity), 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    const m = new THREE.InstancedMesh(geo, mat, n);
    m.count = 0;
    m.frustumCulled = false;
    m.name = 'CarLightPools';
    m.renderOrder = 2;
    return m;
  }

  /**
   * 7B-5 two advertising blimps on a slow orbit over the far skyline (Y 125–165 m, r 230–340 m).
   * Hull mesh (one draw for both): lathed envelope, four tail fins, gondola with a warm window strip, nav /
   * strobe lights, cyan running lines and a downward searchlight cone (soft alpha). Banner mesh (one draw):
   * a huge holographic ticker on each flank, scrolling the wide sign-atlas rows with scanlines and flicker.
   */
  private createBlimps(): [THREE.InstancedMesh, THREE.InstancedMesh] {
    const C = CITY_FX;
    const L = C.BLIMP_LENGTH;
    const R = C.BLIMP_RADIUS;
    const parts: THREE.BufferGeometry[] = [];
    const add = (g: THREE.BufferGeometry, id: number): void => {
      const ng = g.index ? g.toNonIndexed() : g;
      if (ng.getAttribute('uv')) ng.deleteAttribute('uv');
      parts.push(withAttr1(ng, 'aPart', id));
    };
    const prof: THREE.Vector2[] = [];
    for (let i = 0; i <= 28; i++) {
      const t = i / 28;
      const y = (t - 0.5) * L;
      const u = (2 * y) / L;
      const r = R * Math.sqrt(Math.max(0, 1 - u * u)) * (u < 0 ? 1 - 0.18 * u * u : 1);
      prof.push(new THREE.Vector2(Math.max(r, 0.01), y));
    }
    const hull = new THREE.LatheGeometry(prof, 36);
    hull.rotateX(Math.PI / 2);
    add(hull, 0);
    // Tail fins (+Z forward, so the tail is at −Z).
    const finZ = -L / 2 + 11;
    const FH = R * 0.9;
    add(boxAt(0.8, FH, L * 0.16, 0, R * 0.5 + FH / 2, finZ), 1);
    add(boxAt(0.8, FH, L * 0.16, 0, -R * 0.5 - FH / 2, finZ), 1);
    add(boxAt(FH, 0.8, L * 0.16, R * 0.5 + FH / 2, 0, finZ), 1);
    add(boxAt(FH, 0.8, L * 0.16, -R * 0.5 - FH / 2, 0, finZ), 1);
    // Gondola + window strip.
    add(boxAt(4.2, 3.2, 17, 0, -R - 1.3, 4), 1);
    add(boxAt(4.35, 0.7, 14, 0, -R - 0.9, 4.5), 5);
    // Nav lights (red port / green starboard fin tips, white strobes) and cyan running lines.
    add(boxAt(1, 1, 1, -R * 0.5 - FH, 0, finZ), 2);
    add(boxAt(1, 1, 1, R * 0.5 + FH, 0, finZ), 3);
    add(boxAt(1, 1, 1, 0, R * 0.5 + FH, finZ), 4);
    add(boxAt(0.8, 0.8, 0.8, 0, -R - 3.0, 12), 4);
    for (const sx of [-1, 1]) {
      const run = new THREE.CylinderGeometry(0.22, 0.22, L * 0.72, 6);
      run.rotateX(Math.PI / 2);
      run.translate(sx * (R * 0.98), R * 0.22, 2);
      add(run, 7);
    }
    // Searchlight cone hanging from the gondola, tilted forward.
    const cone = new THREE.CylinderGeometry(0.7, 15, 130, 20, 1, true);
    cone.translate(0, -65, 0);
    cone.rotateX(0.42);
    cone.translate(0, -R - 3, 10);
    add(cone, 6);
    const geo = mergeOrEmpty(parts);
    const glow = (h: number): string => {
      const c = new THREE.Color(h);
      return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
    };
    const hullMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: true,
      uniforms: { uTime: this.uTime, uFogDensity: this.uFogDensity, uFogColor: this.uSkyHorizon },
      vertexShader: /* glsl */ `
        attribute float aPart;
        varying vec3 vWorld; varying vec3 vN; varying float vPart; varying float vConeT;
        void main() {
          vPart = aPart;
          vConeT = clamp((-${(R + 3).toFixed(1)} - position.y) / 120.0, 0.0, 1.0);
          vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          vN = normalize(mat3(modelMatrix * instanceMatrix) * normal);
          gl_Position = projectionMatrix * viewMatrix * w;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform float uFogDensity; uniform vec3 uFogColor;
        varying vec3 vWorld; varying vec3 vN; varying float vPart; varying float vConeT;
        ${GLSL_FOG_FADE}
        void main() {
          float p = floor(vPart + 0.5);
          vec3 n = normalize(vN);
          vec3 v = normalize(cameraPosition - vWorld);
          float dist = length(cameraPosition - vWorld);
          float fog = strandFogFade(dist, uFogDensity * 0.42);
          if (p == 6.0) {
            // Searchlight: soft beam, brightest at the lamp, no silhouette edge.
            float edge = pow(abs(dot(n, v)), 1.6);
            float a = 0.07 * pow(1.0 - vConeT, 1.3) * edge * fog;
            gl_FragColor = vec4(vec3(0.75, 0.9, 1.0), a);
            return;
          }
          vec3 base = p == 0.0 ? vec3(0.030, 0.034, 0.044) : vec3(0.014, 0.016, 0.02);
          // Moon key + the city's magenta / cyan glow on the belly + a cool fresnel rim.
          float key = max(dot(n, normalize(vec3(-0.45, 0.62, -0.64))), 0.0);
          float belly = max(-n.y, 0.0);
          float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0);
          vec3 col = base * (0.25 + key * 0.9) + belly * (${glow(C.SKY_GLOW_MAGENTA)} * 0.22 + ${glow(C.SKY_GLOW_CYAN)} * 0.18) + rim * vec3(0.03, 0.05, 0.08);
          // Panel seams along the envelope.
          if (p == 0.0) col *= 0.85 + 0.15 * step(0.08, fract(atan(n.y, n.x) * 2.546));
          float blink = step(0.82, fract(uTime * 0.9));
          if (p == 2.0) col = vec3(1.6, 0.06, 0.08);
          else if (p == 3.0) col = vec3(0.05, 1.5, 0.4);
          else if (p == 4.0) col = vec3(2.4) * blink;
          else if (p == 5.0) col = vec3(1.1, 0.62, 0.26);
          else if (p == 7.0) col = vec3(0.1, 0.95, 1.2) * (0.75 + 0.25 * sin(uTime * 2.0 + vWorld.x * 0.05));
          col = mix(uFogColor, col, fog);
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    const hullMesh = new THREE.InstancedMesh(geo, hullMat, C.BLIMPS.length);
    hullMesh.frustumCulled = false;
    hullMesh.name = 'BlimpHulls';
    hullMesh.renderOrder = -1;
    // Banners: one plane per flank, facing outward.
    const bparts: THREE.BufferGeometry[] = [];
    for (const sx of [-1, 1]) {
      const pl = new THREE.PlaneGeometry(L * 0.56, R * 0.85);
      pl.rotateY(sx * Math.PI / 2);
      if (sx < 0) {
        // Keep the text reading front-to-back on both flanks (mirror the uv).
        const uv = pl.getAttribute('uv') as THREE.BufferAttribute;
        for (let i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i));
      }
      pl.translate(sx * (R + 0.9), 1.5, 4);
      bparts.push(withAttr1(pl, 'aSide', sx));
    }
    const bgeo = mergeOrEmpty(bparts);
    bgeo.setAttribute('aRow', new THREE.InstancedBufferAttribute(new Float32Array([6, 7]), 1));
    const bannerMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: { uTime: this.uTime, uSigns: { value: this.tex.signAtlas }, uFogDensity: this.uFogDensity },
      vertexShader: /* glsl */ `
        attribute float aRow;
        varying vec2 vUv; varying float vRow; varying float vDist;
        void main() {
          vUv = uv; vRow = aRow;
          vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
          vDist = length(w.xyz - cameraPosition);
          gl_Position = projectionMatrix * viewMatrix * w;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform sampler2D uSigns; uniform float uFogDensity;
        varying vec2 vUv; varying float vRow; varying float vDist;
        ${GLSL_FOG_FADE}
        void main() {
          float u = vUv.x * 2.0 + uTime * 0.05 * (vRow > 6.5 ? -1.0 : 1.0);
          vec2 auv = vec2(u, 1.0 - (vRow + 1.0 - clamp(vUv.y, 0.04, 0.96)) / 16.0);
          vec3 t = texture2D(uSigns, auv).rgb;
          float scan = 0.72 + 0.28 * sin(vUv.y * 140.0 + uTime * 9.0);
          float flick = 0.88 + 0.12 * step(0.5, fract(sin(floor(uTime * 12.0) * 12.9898) * 43758.55));
          float frame = smoothstep(0.0, 0.015, vUv.x) * smoothstep(0.0, 0.015, 1.0 - vUv.x) * smoothstep(0.0, 0.05, vUv.y) * smoothstep(0.0, 0.05, 1.0 - vUv.y);
          vec3 col = (t * 1.25 + vec3(0.02, 0.06, 0.09)) * scan * flick * frame;
          gl_FragColor = vec4(col * strandFogFade(vDist, uFogDensity * 0.42), 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    const bannerMesh = new THREE.InstancedMesh(bgeo, bannerMat, C.BLIMPS.length);
    bannerMesh.frustumCulled = false;
    bannerMesh.name = 'BlimpBanners';
    bannerMesh.renderOrder = 7;
    return [hullMesh, bannerMesh];
  }

  /**
   * 5B-1 lamp halo: camera-facing soft disc (radius 2.2 m) at each lamp head, alpha 0.28 · exp(−r² · 3.5),
   * additive — the light scattering in the wet night air.
   */
  private createLampHalos(): THREE.InstancedMesh {
    const geo = new THREE.PlaneGeometry(1, 1);
    // 10B-2: per-instance colour (premultiplied by its opacity ratio) + radius: lamp halos and the coloured rain-mist
    // halos around Mega-Billboards share this one draw.
    geo.setAttribute('aHalo', new THREE.InstancedBufferAttribute(new Float32Array((CAP.LAMP + CAP.MIST) * 4), 4));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uFogDensity: this.uFogDensity },
      vertexShader: /* glsl */ `
        attribute vec4 aHalo;
        varying vec2 vUv; varying float vDist; varying vec3 vCol; varying float vR;
        void main() {
          vUv = uv;
          vCol = aHalo.rgb;
          vR = aHalo.w;
          vec3 center = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          vec3 toCam = cameraPosition - center;
          float dc = length(toCam);
          // Big mist sprites slide toward the camera so the facade behind never slices them.
          center += toCam / max(dc, 1e-3) * (vR > 4.0 ? min(vR * 0.8, dc * 0.5) : 0.0);
          vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
          vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
          vec3 wp = center + (right * position.x + up * position.y) * vR * 2.0;
          vDist = dc;
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uFogDensity;
        varying vec2 vUv; varying float vDist; varying vec3 vCol; varying float vR;
        ${GLSL_FOG_FADE}
        void main() {
          float r = length(vUv - 0.5) * 2.0;
          float mist = step(4.0, vR);
          // 10D-5 dual-lobe Mie haze: lamps get a crisp luminous core dissolving softly into the wet air (no cotton
          // ball edge); billboard mist keeps its ultra-soft wide falloff.
          float r2 = r * r;
          float outerFade = pow(clamp(1.0 - r, 0.0, 1.0), 1.8);
          float lampGlow = (exp(-r2 * 11.5) * 0.20 + exp(-r2 * 2.6) * 0.075) * outerFade;
          float mistGlow = ${NEON_BLOOM.LAMP_HALO_OPACITY.toFixed(2)} * exp(-r2 * 2.2) * (1.0 - smoothstep(0.82, 1.0, r));
          float a = mix(lampGlow, mistGlow, mist);
          // Close-up: fade so the halo never washes the screen when the camera passes through it.
          a *= mix(smoothstep(0.6, 2.4, vDist), smoothstep(vR * 0.35, vR * 1.1, vDist), mist) * strandFogFade(vDist, uFogDensity * 0.6);
          gl_FragColor = vec4(vCol * a, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    const m = new THREE.InstancedMesh(geo, mat, CAP.LAMP + CAP.MIST);
    m.count = 0;
    m.frustumCulled = false;
    m.name = 'LampHalos';
    m.renderOrder = 6;
    return m;
  }

  /**
   * 10B-2 Mega-Billboards: one InstancedMesh (cap 140) of unit quads sampling the 2048 × 1024 English ad atlas
   * (4 × 2 cells). Per instance: `aUvRect` (atlas sub-rect, so every screen / L-corner half / ring segment shows an
   * undistorted crop) and `aMega` (HDR 1.15–1.55, shimmer phase, data-scroll flag, blade flag). Subtle LCD
   * scanlines, a slow diagonal scroll shimmer, scrolling data panels, blades readable from both sides, scene fog.
   */
  private createMegaBillboards(): THREE.InstancedMesh {
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.setAttribute('aUvRect', new THREE.InstancedBufferAttribute(new Float32Array(CAP.MEGA * 4), 4));
    geo.setAttribute('aMega', new THREE.InstancedBufferAttribute(new Float32Array(CAP.MEGA * 4), 4));
    const mat = new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      fog: true,
      uniforms: {
        ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
        uTime: this.uTime,
        uAtlas: { value: this.tex.megaBillboard ?? null },
        uBoost: this.uNeonBoost,
        uFogDensity: this.uFogDensity,
      },
      vertexShader: /* glsl */ `
        attribute vec4 aUvRect;
        attribute vec4 aMega;
        varying vec2 vLocal; varying vec4 vRect; varying vec4 vMega; varying float vDist; varying vec3 vWorld;
        #include <fog_pars_vertex>
        void main() {
          vLocal = uv;
          vRect = aUvRect;
          vMega = aMega;
          vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          vDist = length(wp.xyz - cameraPosition);
          vec4 mvPosition = viewMatrix * wp;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform sampler2D uAtlas; uniform float uBoost; uniform float uFogDensity;
        varying vec2 vLocal; varying vec4 vRect; varying vec4 vMega; varying float vDist; varying vec3 vWorld;
        #include <fog_pars_fragment>
        void main() {
          vec2 l = vLocal;
          // Blades read correctly from both sides; flat screens / ring segments are front-only (backs face the wall).
          if (!gl_FrontFacing) {
            if (vMega.w < 0.5) discard;
            l.x = 1.0 - l.x;
          }

          vec2 uv = vRect.xy + clamp(l, 0.004, 0.996) * vRect.zw;
          vec3 t = texture2D(uAtlas, uv).rgb;
          // DATA FLOW panels: cascading code columns pulse downward (title glyphs stay steady).
          float rain = 1.0;
          if (vMega.z > 0.5) {
            float col = floor(vLocal.x * 22.0);
            float sp = 0.25 + fract(sin(col * 12.9898) * 43758.5453) * 0.5;
            float f = fract(vLocal.y * 1.3 + uTime * sp + col * 0.37);
            rain = mix(0.5 + 0.95 * pow(f, 5.0), 1.0, smoothstep(0.45, 0.8, max(t.r, max(t.g, t.b))));
          }
          // LCD scanlines (fade with distance to avoid moire) + a slow diagonal refresh shimmer.
          float scanAmp = 0.14 * (1.0 - smoothstep(18.0, 70.0, vDist));
          float scan = 1.0 - scanAmp + scanAmp * sin(vWorld.y * 38.0);
          float sweep = fract(vLocal.y * 0.55 + vLocal.x * 0.25 - uTime * 0.09 + vMega.y);
          float shimmer = smoothstep(0.0, 0.05, sweep) * (1.0 - smoothstep(0.05, 0.12, sweep)) * 0.22;
          vec3 c = t * vMega.x * uBoost * scan * rain + t * shimmer;
          gl_FragColor = vec4(c, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }
      `,
    });
    const m = new THREE.InstancedMesh(geo, mat, CAP.MEGA);
    m.count = 0;
    m.frustumCulled = false;
    m.name = 'MegaBillboards';
    return m;
  }

  /**
   * 5B-3 low steam & canal mist: 40–60 soft noise billboards that rise, swell and sway entirely in the vertex
   * shader (zero CPU cost); per instance aSteam = (phase, size, rise rate, seed).
   */
  private createSteam(): THREE.InstancedMesh {
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.setAttribute('aSteam', new THREE.InstancedBufferAttribute(new Float32Array(CAP.STEAM * 4), 4));
    geo.setAttribute('aSteamH', new THREE.InstancedBufferAttribute(new Float32Array(CAP.STEAM), 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uTime: this.uTime, uFogDensity: this.uFogDensity },
      vertexShader: /* glsl */ `
        attribute vec4 aSteam;
        attribute float aSteamH;
        uniform float uTime;
        varying vec2 vUv; varying float vAlpha; varying float vDist; varying float vSeed;
        void main() {
          vUv = uv;
          vec3 base = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          float cyc = uTime * aSteam.z + aSteam.x;
          float t = fract(cyc);
          float size = aSteam.y * (0.7 + t * 1.3);
          // 9A-6: rise height per anchor (2.5–6 m columns over manholes / vents; ~3.4 m canal mist).
          float rise = aSteamH > 0.0 ? aSteamH : 3.4;
          float drift = aSteamH > 0.0 ? 0.25 : 0.6;
          vec3 c = base + vec3(sin(uTime * 0.6 + aSteam.w * 6.28) * drift * t, t * rise + size * 0.35, cos(uTime * 0.45 + aSteam.w * 4.0) * drift * 0.8 * t);
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
      /** 9A-5 weathered painted trim: doors, frames, awnings, shutters, mailboxes, panels (one draw). */
      archPaint: [] as THREE.BufferGeometry[],
    };

    // Instance counters & attributes
    const counts = { ac: 0, duct: 0, mech: 0, fence: 0, ant: 0, room: 0, avi: 0, neon: 0, search: 0, beacon: 0, lamp: 0, vend: 0, kit: 0, rail: 0, steelFix: 0, mega: 0 };
    // 10B-2 sign registry: padded world AABBs of every neon sign + Mega-Billboard (strict non-overlap guard).
    const signBoxes: Array<{ x0: number; y0: number; z0: number; x1: number; y1: number; z1: number; group: number }> = [];
    let signRejects = 0;
    const claimSignBox = (x: number, y: number, z: number, nx: number, nz: number, w: number, h: number, group: number): boolean => {
      const m = SIGN_MARGIN_M;
      const len = Math.hypot(nx, nz) || 1;
      const ux = Math.abs(nx / len);
      const uz = Math.abs(nz / len);
      // Plane of width w along the tangent (nz, −nx), thickness SIGN_THICK_M along the normal.
      const hx = (uz * w + ux * SIGN_THICK_M) / 2 + m;
      const hz = (ux * w + uz * SIGN_THICK_M) / 2 + m;
      const hy = h / 2 + m;
      const box = { x0: x - hx, x1: x + hx, y0: y - hy, y1: y + hy, z0: z - hz, z1: z + hz, group };
      for (const o of signBoxes) {
        if (group >= 0 && o.group === group) continue;
        if (box.x0 < o.x1 && box.x1 > o.x0 && box.y0 < o.y1 && box.y1 > o.y0 && box.z0 < o.z1 && box.z1 > o.z0) return false;
      }
      signBoxes.push(box);
      return true;
    };
    /** Dry-run of claimSignBox (multi-piece screens are only placed when every piece fits). */
    const signFits = (x: number, y: number, z: number, nx: number, nz: number, w: number, h: number, group: number): boolean => {
      const n0 = signBoxes.length;
      const ok = claimSignBox(x, y, z, nx, nz, w, h, group);
      signBoxes.length = n0;
      return ok;
    };
    const megaRecords: MegaBillboardRecord[] = [];
    const mists: Array<{ x: number; y: number; z: number; hex: number; radius: number; opacity: number }> = [];
    /** 10B-3 buildings whose facades belong to a megastructure (signs stay on the podium band). */
    const megaBuilding = new Set<number>();
    /** 10B-4 district neon palette. */
    const PAL: readonly number[] = sector.identity?.palette ?? [COLORS.WALLRUN_CYAN, COLORS.NEON_MAGENTA, COLORS.NEON_AMBER];
    const carCounts = [0, 0, 0];
    const neonSignRecords: NeonSignRecord[] = [];
    const extraShadows: ContactShadowDesc[] = [];
    const aviPhase = this.aviation.geometry.getAttribute('aPhase') as THREE.InstancedBufferAttribute;
    const neonStrip = this.neonSigns.geometry.getAttribute('aStrip') as THREE.InstancedBufferAttribute;
    const neonFormat = this.neonSigns.geometry.getAttribute('aFormat') as THREE.InstancedBufferAttribute;
    const steelFixVar = this.steelFixtures.geometry.getAttribute('aInstVar') as THREE.InstancedBufferAttribute;
    const mechVar = this.roofMech.geometry.getAttribute('aInstVar') as THREE.InstancedBufferAttribute;
    const steamAttr = this.steam.geometry.getAttribute('aSteam') as THREE.InstancedBufferAttribute;
    const srng = createRng(0x51e7 + sector.index * 31 + loop * 977);
    const searchBase = this.searchlights.geometry.getAttribute('aBase') as THREE.InstancedBufferAttribute;
    const searchParams = this.searchlights.geometry.getAttribute('aParams') as THREE.InstancedBufferAttribute;
    const lampTint = this.lamps.geometry.getAttribute('aTint') as THREE.InstancedBufferAttribute;
    const coneTint = this.lampCones.geometry.getAttribute('aTint') as THREE.InstancedBufferAttribute;
    const signalPhase = this.signals.geometry.getAttribute('aPhase') as THREE.InstancedBufferAttribute;
    const poolA = this.carPools.geometry.getAttribute('aPool') as THREE.InstancedBufferAttribute;
    const poolB = this.carPools.geometry.getAttribute('aPoolB') as THREE.InstancedBufferAttribute;
    let signalCount = 0;
    /** 7B-4 paint stream (independent of the prop stream so paints stay evenly spread). */
    const prng = createRng(0xc0105 + sector.index * 17 + loop * 131);
    let poolCount = 0;
    let cableBundles = 0;
    const paintCounts = [0, 0, 0, 0, 0, 0];
    const vendTint = this.vending.geometry.getAttribute('aTint') as THREE.InstancedBufferAttribute;
    const vendBrand = this.vending.geometry.getAttribute('aBrand') as THREE.InstancedBufferAttribute;
    const kitAttr = this.furnishings.geometry.getAttribute('aKit') as THREE.InstancedBufferAttribute;
    const haloAttr = this.lampHalos.geometry.getAttribute('aHalo') as THREE.InstancedBufferAttribute;

    const inArea = (x: number, z: number, m = 0): boolean => Math.abs(x) <= H - m && Math.abs(z) <= H - m;

    // ------------------------------------------------------------------ writers
    /** True when a registered light lies within r of (x, y, z) (7B-1 density balance). */
    const lightNear = (x: number, y: number, z: number, r: number): boolean => {
      const r2 = r * r;
      for (let i = 0; i < this.lightCount; i++) {
        const dx = this.lightPos[i * 3] - x;
        const dy = this.lightPos[i * 3 + 1] - y;
        const dz = this.lightPos[i * 3 + 2] - z;
        if (dx * dx + dy * dy + dz * dz < r2) return true;
      }
      return false;
    };
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
    const addNeon = (
      x: number,
      y: number,
      z: number,
      nx: number,
      nz: number,
      w: number,
      h: number,
      strip: number,
      format: 0 | 1 | 2 = 0,
      meta: { kind: NeonSignRecord['kind']; building?: number; buildingB?: number; farIndex?: number } = { kind: 'HIGHWAY' },
    ): boolean => {
      if (counts.neon >= CAP.NEON) return false;
      // 10B-3: megastructure facades (exoskeleton, slant ribs, twin-arch slabs) keep signs on the podium band only.
      if (meta.building !== undefined && meta.building >= 0 && megaBuilding.has(meta.building) && y + h / 2 > GRAMMAR.MEGA_PODIUM_M) return false;
      // 10B-2 strict 3D AABB non-overlap guard (0.35 m padding) against every placed neon sign and Mega-Billboard.
      if (!claimSignBox(x, y, z, nx, nz, w, h, -1)) {
        signRejects++;
        return false;
      }
      // 7B-1: low / mid-rise signs light the wet street (sign colour), one light per ~3.5 m.
      if (y < 30) {
        const hex = format === 0 ? NEON_STRIP_GLOW[strip % NEON_STRIP_GLOW.length] : NEON_TINTS[strip % NEON_TINTS.length];
        const lx = x + nx * 0.7;
        const lz = z + nz * 0.7;
        if (!lightNear(lx, y, lz, 3.5)) addLight(lx, y, lz, hex, Math.min(2.4, 0.9 + 0.12 * w * h));
      }
      _pos.set(x, y, z);
      _euler.set(0, Math.atan2(nx, nz), 0);
      _quat.setFromEuler(_euler);
      _scl.set(w, h, 1);
      _m4.compose(_pos, _quat, _scl);
      this.neonSigns.setMatrixAt(counts.neon, _m4);
      neonStrip.setX(counts.neon, format === 0 ? strip % this.tex.neonAtlasStrips : strip);
      neonFormat.setX(counts.neon, format);
      neonSignRecords.push({
        kind: meta.kind,
        x,
        y,
        z,
        nx,
        nz,
        w,
        h,
        building: meta.building ?? -1,
        buildingB: meta.buildingB,
        farIndex: meta.farIndex,
      });
      counts.neon++;
      return true;
    };
    /** 10B-2 Mega-Billboard (2048 × 1024 English ad atlas, 4 × 2 cells): flat screen, L-corner piece, blade or ring segment. */
    const megaAttrRect = this.megaBillboards.geometry.getAttribute('aUvRect') as THREE.InstancedBufferAttribute;
    const megaAttrParams = this.megaBillboards.geometry.getAttribute('aMega') as THREE.InstancedBufferAttribute;
    const addMegaBillboard = (o: {
      kind: MegaBillboardRecord['kind'];
      x: number;
      y: number;
      z: number;
      nx: number;
      nz: number;
      w: number;
      h: number;
      building: number;
      cell: number;
      /** Sub-rect of the cell (0..1) this quad shows: u0, v0, su, sv. */
      rect: readonly [number, number, number, number];
      /** Mounting depth: screen-plane distance from the wall (flat) or inner-edge gap (blade). */
      standoff: number;
      group?: number;
      hdr?: number;
      skipGuard?: boolean;
    }): boolean => {
      if (counts.mega >= CAP.MEGA) return false;
      const group = o.group ?? -1;
      if (!o.skipGuard && !claimSignBox(o.x, o.y, o.z, o.nx, o.nz, o.w, o.h, group)) {
        signRejects++;
        return false;
      }
      _pos.set(o.x, o.y, o.z);
      _euler.set(0, Math.atan2(o.nx, o.nz), 0);
      _quat.setFromEuler(_euler);
      _scl.set(o.w, o.h, 1);
      _m4.compose(_pos, _quat, _scl);
      this.megaBillboards.setMatrixAt(counts.mega, _m4);
      const cx = o.cell % 4;
      const cy = Math.floor(o.cell / 4);
      // Atlas v runs bottom-up: row 0 is the top half.
      // Atlas uv (flipY): cell row 0 is the top half (v 0.5 … 1); rect v is measured up from the cell bottom.
      megaAttrRect.setXYZW(counts.mega, (cx + o.rect[0]) / 4, (1 - cy) / 2 + o.rect[1] / 2, o.rect[2] / 4, o.rect[3] / 2);
      megaAttrParams.setXYZW(counts.mega, o.hdr ?? 1.15 + srng() * 0.4, srng(), o.cell === 1 ? 1 : 0, o.kind === 'BLADE' ? 1 : 0);
      megaRecords.push({ kind: o.kind, x: o.x, y: o.y, z: o.z, nx: o.nx, nz: o.nz, w: o.w, h: o.h, building: o.building, cell: o.cell, group, standoff: o.standoff });
      counts.mega++;
      // Mega screens light the wet street below like the neon signs (one light per ~6 m).
      if (o.y - o.h / 2 < 30) {
        const hex = AD_HUES[o.cell];
        const lx = o.x + o.nx * 2;
        const lz = o.z + o.nz * 2;
        const ly = Math.max(3, o.y - o.h / 2);
        if (!lightNear(lx, ly, lz, 6)) addLight(lx, ly, lz, hex, Math.min(3.2, 1.2 + 0.02 * o.w * o.h));
      }
      return true;
    };
    /** 10B-2 coloured rain-mist halo (packed into the lampHalos instancing, +0 calls). */
    const addMist = (x: number, y: number, z: number, hex: number, radius: number, opacity: number): void => {
      if (mists.length >= CAP.MIST) return;
      mists.push({ x, y, z, hex, radius, opacity });
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
    /** 11B-3 RoofMechKit instance: part 0 = AC unit (machinery PBR), 1 = exhaust duct (sx = length along local X). */
    const placeMech = (part: 0 | 1, x: number, y: number, z: number, yaw: number, sx = 1, sy = 1, sz = 1): void => {
      placeInstance(this.roofMech, counts.mech, x, y, z, yaw, sx, sy, sz);
      mechVar.setX(counts.mech++, part);
    };
    /** 10C-3 StreetFurnishingsKit instance (variant 0 lantern string spanning `sx` × 4.2 m · 1 parasol, tint 0 / 1). */
    const addKit = (variant: number, x: number, y: number, z: number, yaw: number, sx = 1, tint = 0): boolean => {
      if (counts.kit >= KIT_CAP) return false;
      placeInstance(this.furnishings, counts.kit, x, y, z, yaw, sx, 1, 1);
      kitAttr.setXYZW(counts.kit, variant, tint, 0, 0);
      counts.kit++;
      return true;
    };
    const addSteelFixture = (variant: 0 | 1 | 2, x: number, y: number, z: number, yaw: number, sx = 1, sy = 1, sz = 1): void => {
      if (counts.steelFix >= CAP.STEEL_FIXTURES) return;
      placeInstance(this.steelFixtures, counts.steelFix, x, y, z, yaw, sx, sy, sz);
      steelFixVar.setX(counts.steelFix, variant);
      counts.steelFix++;
    };
    const addRail = (x: number, z: number, alongX: boolean): void => {
      if (counts.rail >= CAP.GUARDRAIL) return;
      counts.rail++;
      addSteelFixture(0, x, 0, z, alongX ? 0 : Math.PI / 2);
    };
    const NEON_TINTS = [0xff2bd6, 0x00f0ff, 0xffa21f, 0x39ff88, 0xb44bff];
    /** 10B-4: lamp-arm and vending tints follow the district palette. */
    const LAMP_TINTS: readonly number[] = [...PAL, ...PAL, 0xf2f6ff];
    /** 9B: lamp poles carry no collider; clutter keeps clear of them. */
    const lampPoles: Array<readonly [number, number]> = [];
    const addLamp = (x: number, z: number, yaw: number): void => {
      if (counts.lamp >= CAP.LAMP) return;
      lampPoles.push([x, z]);
      placeInstance(this.lamps, counts.lamp, x, 0, z, yaw);
      _col.setHex(LAMP_TINTS[Math.floor(rng() * LAMP_TINTS.length)]);
      lampTint.setXYZ(counts.lamp, _col.r, _col.g, _col.b);
      counts.lamp++;
      // Lamp head sits 2.05 m out along the arm (+Z rotated by yaw).
      addLight(x + Math.sin(yaw) * 2.05, 6.2, z + Math.cos(yaw) * 2.05, COLORS.STREET_LAMP, 4.0);
      _m4.makeTranslation(x + Math.sin(yaw) * 2.05, 6.22, z + Math.cos(yaw) * 2.05);
      this.lampHalos.setMatrixAt(counts.lamp - 1, _m4);
      _colB.setHex(COLORS.STREET_LAMP);
      haloAttr.setXYZW(counts.lamp - 1, _colB.r, _colB.g, _colB.b, NEON_BLOOM.LAMP_HALO_RADIUS_M);
      // 7B-3: volumetric cone under the head.
      _m4.makeTranslation(x + Math.sin(yaw) * 2.05, CITY_FX.CONE_TOP_Y, z + Math.cos(yaw) * 2.05);
      this.lampCones.setMatrixAt(counts.lamp - 1, _m4);
      coneTint.setXYZ(counts.lamp - 1, _col.r, _col.g, _col.b);
    };
    /** 10BC-Fix FIX-10: placed kiosk centres (no two hero kiosks closer than 1.16 m: bumpers / marquees clear). */
    const vendPos: Array<[number, number]> = [];
    const addVending = (x: number, z: number, yaw: number, scale = 1): void => {
      if (counts.vend >= CAP.VENDING) return;
      const vHex = LAMP_TINTS[Math.floor(rng() * LAMP_TINTS.length)];
      if (vendPos.some(([px, pz]) => Math.hypot(px - x, pz - z) < 1.16)) return;
      vendPos.push([x, z]);
      placeInstance(this.vending, counts.vend, x, 0, z, yaw, scale, scale, scale);
      _col.setHex(vHex);
      vendTint.setXYZ(counts.vend, _col.r, _col.g, _col.b);
      vendBrand.setX(counts.vend, (((Math.floor(x * 7.3) + Math.floor(z * 3.1)) % 4) + 4) % 4); // position hash: keeps the RNG stream untouched
      counts.vend++;
      extraShadows.push({ x, z, yaw, w: 1.24 * scale, d: 1.04 * scale, alpha: 0.62 });
      // 7B-1: the lit front panel (+Z) spills on the wet pavement.
      const fx = x + Math.sin(yaw) * 0.7 * scale;
      const fz = z + Math.cos(yaw) * 0.7 * scale;
      if (!lightNear(fx, 1.2, fz, 2.5)) addLight(fx, 1.2 * scale, fz, _colB.setHex(vHex).lerp(_white, 0.45).getHex(), 1.25);
      const hw = 0.55 * scale + 0.03;
      const hd = 0.45 * scale + 0.03;
      const ax = Math.abs(Math.sin(yaw)) > 0.5;
      colliders.push({
        min: new THREE.Vector3(x - (ax ? hd : hw), 0, z - (ax ? hw : hd)),
        max: new THREE.Vector3(x + (ax ? hd : hw), 2.05 * scale, z + (ax ? hw : hd)),
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
      // 10B-4: truss-bridge neon glows in the district palette (Kowloon canal amber / jade / coral …).
      const neon = PAL[bi % PAL.length];
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
        addNeon(q.x, q.y, q.z, axis === 'z' ? side : 0, axis === 'x' ? side : 0, Math.min(L * 0.6, 10), 0.9, Math.floor(srng() * SIGN_ATLAS.WIDE_ROWS), 1, { kind: 'BRIDGE' });
      }
    });

    // ------------------------------------------------------------------ 5. expressways, piers, on-ramps
    const decks: Array<{ hi: number; axis: Axis; coord: number; a0: number; a1: number }> = [];
    const pierRects: RectXZ[] = [];
    /** 9B: highway pier centres + the highway's along axis (underpass clutter, pier graffiti). */
    const pierLines: Array<{ x: number; z: number; axis: Axis }> = [];
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
        // 10A-2: toned-down underside industrial light strips (narrowed 0.14 → 0.09 m, emissive 0.85) + street glow.
        for (const side of [-1, 1]) {
          const color = side < 0 ? h.lightNeg : h.lightPos;
          const lat = h.coord + side * (HW - 1.6);
          G.strips.push(withColor(boxGeoWorld(h.axis, d0, d1, lat - 0.09, lat + 0.09, UNDER - 0.055, UNDER), color, NEON_BLOOM.UNDERSIDE_STRIP));
          for (let a = d0 + 6; a < d1; a += 12) {
            const q = pt(h.axis, a, UNDER - 0.3, lat);
            if (inArea(q.x, q.z, -20)) addLight(q.x, q.y, q.z, color, 2.0);
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
            addNeon(q.x, q.y, q.z, h.axis === 'z' ? side : 0, h.axis === 'x' ? side : 0, 7, 1.0, Math.floor(srng() * SIGN_ATLAS.WIDE_ROWS), 1, { kind: 'HIGHWAY' });
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
        pierLines.push({ x: qp.x, z: qp.z, axis: h.axis });
        if (inArea(qp.x, qp.z)) colliders.push({ min: new THREE.Vector3(pr.x0, 0, pr.z0), max: new THREE.Vector3(pr.x1, UNDER, pr.z1), kind: 'HIGHWAY', building: -1 });
        a += LEVEL.HIGHWAY_PIER_SPACING_MIN_M + rng() * (LEVEL.HIGHWAY_PIER_SPACING_MAX_M - LEVEL.HIGHWAY_PIER_SPACING_MIN_M);
      }
    });

    // 10A-2 On-ramps: lower retaining-wall abutment (y ≤ 2.8 m), elevated 0.85 m box-girder underside with twin
    // longitudinal beams, proper T-piers every 11 m, and upright concrete side parapets (+0.0 to +0.95 m above deck).
    rampInfo.forEach((ri) => {
      const axis = ri.s.axis;
      const len = ri.len;
      const latC = (ri.lat0 + ri.lat1) / 2;
      const abutY = Math.min(2.8, DECK - 1.2);
      const tSplit = 1 - abutY / DECK;
      const aSplit = ri.top + ri.r.dir * tSplit * len;
      const yDeckAt = (al: number): number => DECK * (1 - ((al - ri.top) * ri.r.dir) / len);

      // Lower section (y ≤ 2.8 m): solid sloped concrete retaining-wall abutment resting cleanly on Y = 0.0.
      G.hw.push(slopedPrism(axis, aSplit, ri.bottom, ri.lat0, ri.lat1, 0, abutY, 0, 0.02, { ground: true, side: 0.92 }));

      // Elevated section (y > 2.8 m): 0.85 m-deep concrete box-girder underside (aAo = 0.45) + twin underside beams.
      G.hw.push(slopedPrism(axis, ri.top, aSplit, ri.lat0, ri.lat1, DECK - 0.4, DECK, abutY - 0.4, abutY, { bottom: 0.45, side: 0.92 }));
      G.hw.push(slopedPrism(axis, ri.top, aSplit, ri.lat0 + 0.55, ri.lat1 - 0.55, DECK - 0.85, DECK - 0.4, abutY - 0.85, abutY - 0.4, { bottom: 0.45, side: 0.72 }));
      for (const off of [-1.65, 1.65]) {
        G.hw.push(slopedPrism(axis, ri.top, aSplit, latC + off - 0.28, latC + off + 0.28, DECK - 0.96, DECK - 0.4, abutY - 0.96, abutY - 0.4, { bottom: 0.45, side: 0.65 }));
      }

      // Road asphalt surface flush atop the ramp deck.
      const ar = ROAD_ATLAS.ASPHALT;
      roadQuad(axis, ri.lat0, ri.lat1, ri.top, ri.bottom, DECK + ROAD_Y, ROAD_Y, ar, LEVEL.RAMP_WIDTH_M / ar.tileAcross, 0, len / ar.tileAlong);

      // Upright vertical concrete side parapets (+0.0 to +0.95 m above deck — never twisted beam()).
      for (const [p0, p1] of [[ri.lat0, ri.lat0 + 0.3], [ri.lat1 - 0.3, ri.lat1]] as const) {
        G.hw.push(slopedPrism(axis, ri.top, ri.bottom, p0, p1, DECK, DECK + 0.95, 0, 0.95, { side: 0.94 }));
      }

      // Proper T-pier columns every 11 m along the elevated span (1.2 m shaft + horizontal cross-head flush to underside).
      const elevLen = tSplit * len;
      const capHalfL = (LEVEL.RAMP_WIDTH_M - 0.6) / 2;
      for (let d = 10; d < elevLen - 2.5; d += 11) {
        const al = ri.top + ri.r.dir * d;
        const yUnder = DECK * (1 - d / len) - 0.85;
        if (yUnder < 1.2) continue;
        const capBot = yUnder - 0.75;
        // Cross-head cap: horizontal soffit at capBot, sloped top embedded 0.06 m into the box-girder underside.
        G.hw.push(
          slopedPrism(
            axis,
            al - 0.65,
            al + 0.65,
            latC - capHalfL,
            latC + capHalfL,
            capBot,
            yDeckAt(al - 0.65) - 0.79,
            capBot,
            yDeckAt(al + 0.65) - 0.79,
            { bottom: 0.48, side: 0.85 },
          ),
        );
        // 1.2 m vertical pier shaft with ground-contact AO.
        const qp = pt(axis, al, 0, latC);
        G.hw.push(slopedPrism(axis, al - 0.6, al + 0.6, latC - 0.6, latC + 0.6, 0, capBot + 0.04, 0, capBot + 0.04, { ground: true, side: 0.9 }));
        if (inArea(qp.x, qp.z)) colliders.push({ min: new THREE.Vector3(qp.x - 0.6, 0, qp.z - 0.6), max: new THREE.Vector3(qp.x + 0.6, yUnder, qp.z + 0.6), kind: 'HIGHWAY', building: -1 });
      }
      rampColliders.push({ axis, lateralMin: ri.lat0, lateralMax: ri.lat1, alongStart: ri.top, alongEnd: ri.bottom, yStart: DECK, yEnd: 0, thickness: 0.5 });
      const r0 = pt(axis, ri.top, 0, ri.lat0);
      const r1 = pt(axis, ri.bottom, 0, ri.lat1);
      rampRects.push(rectFrom(r0.x, r0.z, r1.x, r1.z));
    });

    // ------------------------------------------------------------------ 6. building lots, alleys & heights
    const lotList = plan.explicitLots ? plan.explicitLots.map((r) => ({ r, pair: -1 })) : this.computeLots(plan, sector, rng);
    const isPerimeter = (r: RectXZ): boolean => Math.max(Math.abs(r.x0), Math.abs(r.x1), Math.abs(r.z0), Math.abs(r.z1)) > H - 6;
    // 10B-1: every valid lot (≥ 10 × 10 m) is built — `buildingCount` is now a minimum. At most ONE small interior
    // single lot (never an alley-split piece, never on the perimeter) stays open and becomes a dense covered cyber
    // street-market, and only while the district still builds ≥ 92 % of its lots.
    const lotArea = (r: RectXZ): number => (r.x1 - r.x0) * (r.z1 - r.z0);
    const marketCands = lotList
      .filter((l) => l.pair < 0 && !isPerimeter(l.r) && lotArea(l.r) <= 560)
      .map((l) => ({ r: l.r, a: lotArea(l.r), roll: rng() }))
      .sort((p, o) => p.a - o.a || p.roll - o.roll);
    const marketLot = !plan.explicitLots && marketCands.length && (lotList.length - 1) / lotList.length >= 0.92 ? marketCands[0].r : null;
    const chosen: RectXZ[] = lotList.filter((l) => l.r !== marketLot).map((l) => l.r);
    const plazas: RectXZ[] = marketLot ? [marketLot] : [];
    const N = chosen.length;
    if (N < sector.buildingCount) throw new Error(`Sector ${sector.index}: only ${N}/${sector.buildingCount} building lots`);
    const lotsGenerated = lotList.length;

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
    /** 10B-1 perimeter skyline framing: lots on the ±H wall always rise ≥ 36 m. */
    const PERIM_MIN_H = 36;
    const heights = chosen.map((r) => {
      const t = isPerimeter(r) ? 0.45 + rng() * 0.55 : rng();
      const hgt = q2(sector.heightMin + t * (sector.heightMax - sector.heightMin));
      return isPerimeter(r) ? Math.max(PERIM_MIN_H, hgt) : hgt;
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
    /** 9B: narrowest alley a face fronts (socket props stop short of the alley's clear centre path). */
    const alleyWidth = new Map<string, number>();
    for (const al of alleyRecs) {
      for (const k of [`${al.a}:${al.axis}:1`, `${al.b}:${al.axis}:-1`]) alleyWidth.set(k, Math.min(alleyWidth.get(k) ?? Infinity, al.gap1 - al.gap0));
    }
    const FACES: ReadonlyArray<readonly [Axis, number]> = [['x', 1], ['x', -1], ['z', 1], ['z', -1]];
    const FE = FIRE_ESCAPE;
    const AR = ARCHETYPE;
    const escapeNeed = 2 * FE.LANDING_WIDTH_M + FE.RUN_MIN_M + 1.2;
    const lotFaceLen = (r: RectXZ, ax: Axis): number => (ax === 'x' ? r.z1 - r.z0 : r.x1 - r.x0);
    const hasEscapeFace = (i: number): boolean => FACES.some(([ax, sg]) => !alleyFaces.has(`${i}:${ax}:${sg}`) && lotFaceLen(chosen[i], ax) >= escapeNeed);
    const quota = (sector.identity?.archShares ?? AR.SHARES).map((sh) => sh * N);
    const archCount = quota.map((q) => Math.floor(q));
    const remOrder = quota.map((q, i) => ({ i, r: q - archCount[i] })).sort((p, o) => o.r - p.r || p.i - o.i);
    for (let k = 0; archCount.reduce((s, v) => s + v, 0) < N; k++) archCount[remOrder[k % 4].i]++;
    const archOf: number[] = new Array<number>(N).fill(ARCH_D);
    const byHeight = heights.map((h, i) => ({ i, h, roll: arng() })).sort((p, o) => o.h - p.h || p.roll - o.roll);
    /** Face sets for a lot (alley-facing / within 4 m of the lockdown wall) shared by the massing candidates. */
    const lotFaceSets = (i: number): { alley: Set<string>; edge: Set<string> } => {
      const r = chosen[i];
      const alley = new Set<string>();
      for (const [ax, sg] of FACES) if (alleyFaces.has(`${i}:${ax}:${sg}`)) alley.add(faceKeyOf(ax, sg));
      // 10B-3: faces within 4 m of the lockdown wall never cantilever / open a void toward it.
      const edge = new Set<string>();
      if (r.x1 > H - 4) edge.add('x:1');
      if (r.x0 < -H + 4) edge.add('x:-1');
      if (r.z1 > H - 4) edge.add('z:1');
      if (r.z0 < -H + 4) edge.add('z:-1');
      return { alley, edge };
    };
    /** Final 9A-1 roof of lot i under archetype a (band clamp + floor quantization, as applied below). */
    const roofFor = (i: number, a: number): number => {
      const [lo0, hi] = heightBand(a, sector.heightMin, sector.heightMax);
      const lo = isPerimeter(chosen[i]) ? Math.min(hi, Math.max(lo0, PERIM_MIN_H)) : lo0;
      return quantizeToFloors(a, clamp(heights[i], lo, hi), lo, hi, bridged.has(i) || isPerimeter(chosen[i]) ? 'ceil' : 'round');
    };
    // 10BC-Fix FIX-4: deficit-aware Type A reservation. Only when the tallest archCount[0] lots cannot host the
    // district's megastructure quotas (endless loops reshuffle heights) is the tallest eligible lower lot swapped
    // in for the shortest A lot that hosts nothing — zero churn whenever the quotas already fit (loop 0).
    const megaWant = sector.identity?.megastructures ?? {};
    if (MEGA_ORDER.some((k) => (megaWant[k] ?? 0) > 0)) {
      const okFor = (k: MegaStructureKind, i: number): boolean =>
        !((k === 'CYLINDER_RING_TOWER' || k === 'TWIN_ARCH_GATE') && bridged.has(i)) &&
        canMega(k, { arch: ARCH_A, lot: chosen[i], roofY: roofFor(i, ARCH_A), ...lotFaceSets(i) });
      const nA = archCount[0];
      const slots: MegaStructureKind[] = [];
      for (const k of MEGA_ORDER) for (let n = 0; n < (megaWant[k] ?? 0); n++) slots.push(k);
      const okMemo = new Map<string, boolean>();
      const ok = (k: MegaStructureKind, i: number): boolean => {
        const key = `${k}:${i}`;
        let v = okMemo.get(key);
        if (v === undefined) okMemo.set(key, (v = okFor(k, i)));
        return v;
      };
      /** Max bipartite matching of quota slots onto the current A slice (Kuhn); returns the matched positions. */
      const match = (): { n: number; used: Set<number> } => {
        const owner = new Array<number>(nA).fill(-1);
        const tryS = (si: number, seen: boolean[]): boolean => {
          for (let p = 0; p < nA; p++) {
            if (seen[p] || !ok(slots[si], byHeight[p].i)) continue;
            seen[p] = true;
            if (owner[p] < 0 || tryS(owner[p], seen)) {
              owner[p] = si;
              return true;
            }
          }
          return false;
        };
        let n = 0;
        for (let si = 0; si < slots.length; si++) if (tryS(si, new Array<boolean>(nA).fill(false))) n++;
        return { n, used: new Set(owner.map((o, p) => (o >= 0 ? p : -1)).filter((p) => p >= 0)) };
      };
      let m = match();
      for (let guard = 0; guard < slots.length && m.n < slots.length; guard++) {
        let dst = -1;
        for (let p = nA - 1; p >= 0 && dst < 0; p--) if (!m.used.has(p)) dst = p;
        if (dst < 0) break;
        let improved = false;
        for (let src = nA; src < byHeight.length && !improved; src++) {
          if (!slots.some((k) => ok(k, byHeight[src].i))) continue;
          [byHeight[src], byHeight[dst]] = [byHeight[dst], byHeight[src]];
          const m2 = match();
          if (m2.n > m.n) {
            m = m2;
            improved = true;
          } else [byHeight[src], byHeight[dst]] = [byHeight[dst], byHeight[src]];
        }
        if (!improved) break;
      }
    }
    byHeight.forEach((o, k) => {
      if (k < archCount[0]) archOf[o.i] = ARCH_A;
      else if (k < archCount[0] + archCount[1]) archOf[o.i] = ARCH_B;
    });
    byHeight
      .slice(archCount[0] + archCount[1])
      .map((o) => ({ i: o.i, pref: hasEscapeFace(o.i) ? 1 : 0, roll: arng() }))
      .sort((p, o) => o.pref - p.pref || p.roll - o.roll)
      .forEach((o, k) => (archOf[o.i] = k < archCount[2] ? ARCH_C : ARCH_D));
    // 9A-1: every roof sits on the archetype floor grid (FLOOR_BASE_M[arch] + n · 4 m) inside the archetype ∩ sector
    // band — zero sliced windows; sky-bridge towers round up so Layer 2 keeps its clearance. (Type C bases at 0 m,
    // so its fire escapes still land flush on whole 4 m storeys.)
    const roofs = heights.map((_, i) => roofFor(i, archOf[i]));
    roofs.forEach((y, i) => (heights[i] = y));

    // 9A-2: five massings (own rng stream, so streets / cars / lamps stay where they were).
    const SB = SILHOUETTE;
    const mrng = createRng(0x9a55 + sector.index * 211 + loop * 1013);
    const candidates: MassingCandidate[] = chosen.map((r, i) => ({ arch: archOf[i], lot: r, roofY: heights[i], ...lotFaceSets(i) }));
    const ident = sector.identity;
    const massings = assignMassings(candidates, mrng, ident ? { minCounts: ident.minMassings, mega: ident.megastructures, noMega: bridged } : {});
    const buildings: Building[] = chosen.map((r, i) => {
      const plan = planMassing(massings[i], candidates[i], mrng);
      return {
        index: i,
        cx: plan.roof.cx,
        cz: plan.roof.cz,
        halfW: plan.roof.halfW,
        halfD: plan.roof.halfD,
        roofY: heights[i],
        arch: archOf[i],
        rect: r,
        seed: rng(),
        lotHalfW: (r.x1 - r.x0) / 2,
        lotHalfD: (r.z1 - r.z0) / 2,
        lcx: (r.x0 + r.x1) / 2,
        lcz: (r.z0 + r.z1) / 2,
        setbackY: plan.setbackY,
        massing: massings[i],
        plan,
        cylR: plan.cyl?.r,
        cylC: plan.cyl ? { x: plan.cyl.cx, z: plan.cyl.cz } : undefined,
        slant: plan.slant ? { axis: plan.slant.axis, a0: plan.slant.a0, a1: plan.slant.a1, l0: plan.slant.l0, l1: plan.slant.l1, y0: plan.slant.y0, h: plan.slant.h } : undefined,
        voidBox: plan.twin
          ? plan.twin.axis === 'x'
            ? { x0: plan.twin.v0, x1: plan.twin.v1, y0: plan.twin.y0, y1: plan.twin.y1, z0: plan.twin.l0, z1: plan.twin.l1 }
            : { x0: plan.twin.l0, x1: plan.twin.l1, y0: plan.twin.y0, y1: plan.twin.y1, z0: plan.twin.v0, z1: plan.twin.v1 }
          : undefined,
        slantH: plan.slant?.h,
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
    /** The band `reach` m out from a lot face (and the face's along span) lies inside the lockdown barrier. */
    const faceInPlay = (b: Building, ax: Axis, sg: number, reach: number): boolean => {
      const lim = H - 0.5;
      const plane = ax === 'x' ? b.lcx + sg * b.lotHalfW : b.lcz + sg * b.lotHalfD;
      const [c, half] = ax === 'x' ? [b.lcz, b.lotHalfD] : [b.lcx, b.lotHalfW];
      return Math.abs(plane + sg * reach) <= lim && Math.abs(c) + half <= lim;
    };
    const runFaces = new Set<string>();
    const balconyFaces = new Set<string>();
    const escapeFaces = new Set<string>();
    const shutterFaces = new Set<string>();
    const ductFaces = new Set<string>();
    /** 9A-2: GALLERY_DANCHI corridor faces, PENCIL_TOWER spine faces, L_SHAPE partial (courtyard-cut) lot faces. */
    const galleryFaces = new Set<string>();
    const spineFaces = new Set<string>();
    const partialFaces = new Set<string>();
    buildings.forEach((b) => {
      // 10B-3: TWIN_ARCH_GATE void openings are not full-height walls (no run / feature roles).
      for (const k of b.plan.partial ?? []) partialFaces.add(`${b.index}:${k}`);
      const cut = b.plan.cut;
      if (cut) {
        if (Math.abs(cut.x1 - b.rect.x1) < 1e-6) partialFaces.add(fkey(b, 'x', 1));
        if (Math.abs(cut.x0 - b.rect.x0) < 1e-6) partialFaces.add(fkey(b, 'x', -1));
        if (Math.abs(cut.z1 - b.rect.z1) < 1e-6) partialFaces.add(fkey(b, 'z', 1));
        if (Math.abs(cut.z0 - b.rect.z0) < 1e-6) partialFaces.add(fkey(b, 'z', -1));
      }
    });
    buildings.forEach((b) => {
      let count = 0;
      for (const [ax, sg] of FACES) {
        if (!alleyFaces.has(fkey(b, ax, sg))) continue;
        runFaces.add(fkey(b, ax, sg));
        count++;
      }
      const free = (ax: Axis, sg: number): boolean => !runFaces.has(fkey(b, ax, sg)) && !partialFaces.has(fkey(b, ax, sg));
      // Reserve the massing's signature face before the extra run faces are drawn.
      if (b.massing === 'GALLERY_DANCHI') {
        // The corridor's external stair (out to ~2.5 m) and its street approach must be on playable ground.
        const cands = FACES.filter(([ax, sg]) => free(ax, sg) && faceLen(b, ax) >= GRAMMAR.GALLERY_MIN_FACE_M && faceInPlay(b, ax, sg, GRAMMAR.GALLERY_DEPTH_M + 2.6))
          .map((f) => ({ f, roll: arng() }))
          .sort((p, o) => faceLen(b, o.f[0]) - faceLen(b, p.f[0]) || p.roll - o.roll);
        // Keep ≥ 2 faces for wall-running: a second corridor face only when 4 faces are free.
        const freeCount = FACES.filter(([ax, sg]) => free(ax, sg)).length + count;
        const n = Math.min(cands.length, freeCount >= 4 && count === 0 && cands.length >= 3 && arng() < 0.4 ? 2 : 1);
        for (let i = 0; i < n; i++) galleryFaces.add(fkey(b, cands[i].f[0], cands[i].f[1]));
      } else if (b.massing === 'PENCIL_TOWER') {
        const cands = FACES.filter(([ax, sg]) => free(ax, sg) && faceLen(b, ax) >= GRAMMAR.SPINE_W_M + 3 && FACES.filter(([a2, s2]) => !partialFaces.has(fkey(b, a2, s2))).length >= 3);
        if (cands.length) {
          const [ax, sg] = cands[Math.floor(arng() * cands.length)];
          spineFaces.add(fkey(b, ax, sg));
        }
      }
      let escape = '';
      // Faces still available for the ≥ 2 clean run faces once the signature faces are reserved.
      const runnable = FACES.filter(([ax, sg]) => !partialFaces.has(fkey(b, ax, sg)) && !galleryFaces.has(fkey(b, ax, sg)) && !spineFaces.has(fkey(b, ax, sg))).length;
      if (b.arch === ARCH_C && runnable >= 3) {
        const cands = FACES.filter(([ax, sg]) => free(ax, sg) && !galleryFaces.has(fkey(b, ax, sg)) && !spineFaces.has(fkey(b, ax, sg)) && faceLen(b, ax) >= escapeNeed);
        if (cands.length) {
          const [ax, sg] = cands[Math.floor(arng() * cands.length)];
          escape = fkey(b, ax, sg);
          escapeFaces.add(escape);
        }
      }
      // ≥ 2 clean full-height run faces: podium towers prefer their flush (full-height) faces; L shapes only use
      // their two uncut faces; signature faces (gallery / spine / escape) are never taken.
      const order = [...FACES].map((f, k) => ({ f, k: (k + Math.floor(rng() * 4)) % 4 }));
      const flush = new Set(b.plan.flush);
      order.sort((p, o) => (flush.has(faceKeyOf(o.f[0], o.f[1])) ? 1 : 0) - (flush.has(faceKeyOf(p.f[0], p.f[1])) ? 1 : 0) || p.k - o.k);
      for (const { f: [ax, sg] } of order) {
        if (count >= 2) break;
        const key = fkey(b, ax, sg);
        if (runFaces.has(key) || key === escape || galleryFaces.has(key) || spineFaces.has(key) || partialFaces.has(key)) continue;
        runFaces.add(key);
        count++;
      }
      const feature = FACES.filter(([ax, sg]) => {
        const key = fkey(b, ax, sg);
        return !runFaces.has(key) && key !== escape && !partialFaces.has(key) && !galleryFaces.has(key) && !spineFaces.has(key);
      });
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
    // 9B: every alley gets one service side (bins, dumpsters, pallets against its wall) while the opposite wall stays
    // a clean run strip. A tower may only give up an alley run face if it keeps ≥ 2 clean run faces: either it has a
    // spare one, or a plain feature face (no balcony / duct / shutter / escape / gallery / spine) is promoted to a
    // clean run face in exchange.
    const serviceFaces = new Set<string>();
    const alleyService: Array<0 | 1 | null> = [];
    {
      const srv = createRng(0x9b5e + sector.index * 53 + loop * 211);
      const cleanRuns = (bi: number): number => FACES.filter(([ax, sg]) => runFaces.has(`${bi}:${ax}:${sg}`) && !serviceFaces.has(`${bi}:${ax}:${sg}`)).length;
      const plainFace = (bi: number): string | null => {
        for (const [ax, sg] of FACES) {
          const k = `${bi}:${ax}:${sg}`;
          if (runFaces.has(k) || escapeFaces.has(k) || partialFaces.has(k) || galleryFaces.has(k) || spineFaces.has(k) || balconyFaces.has(k) || ductFaces.has(k) || shutterFaces.has(k)) continue;
          if (faceLen(buildings[bi], ax) >= PHYSICS.WALLRUN_MIN_FACE_WIDTH + 1) return k;
        }
        return null;
      };
      for (const al of alleyRecs) {
        const sides = [
          { side: 0 as const, bi: al.a, key: `${al.a}:${al.axis}:1` },
          { side: 1 as const, bi: al.b, key: `${al.b}:${al.axis}:-1` },
        ]
          .filter((c) => runFaces.has(c.key) && !serviceFaces.has(c.key) && (cleanRuns(c.bi) > 2 || plainFace(c.bi) !== null))
          .map((c) => ({ ...c, roll: srv() }))
          .sort((p, q) => cleanRuns(q.bi) - cleanRuns(p.bi) || p.roll - q.roll);
        const pick = sides[0];
        if (pick) {
          if (cleanRuns(pick.bi) <= 2) runFaces.add(plainFace(pick.bi) as string);
          serviceFaces.add(pick.key);
        }
        alleyService.push(pick ? pick.side : null);
      }
    }
    const runFaceCount = buildings.map((b) => FACES.filter(([ax, sg]) => runFaces.has(fkey(b, ax, sg))).length);

    /** Face frame on an arbitrary wall plane (9A helpers, shared by 10B megastructures / Mega-Billboards). */
    const sf = (ax: Axis, sg: number, plane: number) => {
      const P3 = (al: number, y: number, d: number): THREE.Vector3 => (ax === 'x' ? new THREE.Vector3(plane + sg * d, y, al) : new THREE.Vector3(al, y, plane + sg * d));
      const ext = (a0: number, a1: number, y0: number, y1: number, d0: number, d1: number) => {
        const lo = P3(a0, y0, d0);
        const hi = P3(a1, y1, d1);
        return { w: Math.abs(hi.x - lo.x), h: y1 - y0, d: Math.abs(hi.z - lo.z), x: (lo.x + hi.x) / 2, y: (y0 + y1) / 2, z: (lo.z + hi.z) / 2, lo, hi };
      };
      const bx = (a0: number, a1: number, y0: number, y1: number, d0: number, d1: number, ao: Parameters<typeof aoBox>[6] = {}): THREE.BufferGeometry[] => {
        const e = ext(a0, a1, y0, y1, d0, d1);
        return aoBox(Math.max(e.w, 0.005), Math.max(e.h, 0.005), Math.max(e.d, 0.005), e.x, e.y, e.z, ao);
      };
      const paint = (hex: number, a0: number, a1: number, y0: number, y1: number, d0: number, d1: number, ao: Parameters<typeof aoBox>[6] = {}): THREE.BufferGeometry[] =>
        bx(a0, a1, y0, y1, d0, d1, { tile: 1.6, ...ao }).map((g) => withTint(g, hex));
      const glow = (hex: number, k: number, a0: number, a1: number, y0: number, y1: number, d0: number, d1: number): THREE.BufferGeometry => {
        const e = ext(a0, a1, y0, y1, d0, d1);
        return withColor(boxAt(Math.max(e.w, 0.005), Math.max(e.h, 0.005), Math.max(e.d, 0.005), e.x, e.y, e.z), hex, k);
      };
      const coll = (a0: number, a1: number, y0: number, y1: number, d0: number, d1: number, building: number, kind: ColliderKind = 'PROP'): void => {
        const e = ext(a0, a1, y0, y1, d0, d1);
        colliders.push({ min: new THREE.Vector3(Math.min(e.lo.x, e.hi.x), y0, Math.min(e.lo.z, e.hi.z)), max: new THREE.Vector3(Math.max(e.lo.x, e.hi.x), y1, Math.max(e.lo.z, e.hi.z)), kind, building });
      };
      /** Slanted slab from the wall (yIn at d0) out to yOut at d1 across [a0, a1] (awnings). */
      const slant = (a0: number, a1: number, yIn: number, yOut: number, d0: number, d1: number, th: number): THREE.BufferGeometry => {
        const run = d1 - d0;
        const len = Math.hypot(run, yIn - yOut);
        const ang = Math.atan2(yIn - yOut, run);
        const g = ax === 'x' ? new THREE.BoxGeometry(len, th, a1 - a0) : new THREE.BoxGeometry(a1 - a0, th, len);
        if (ax === 'x') g.rotateZ(-ang * sg);
        else g.rotateX(ang * sg);
        const c = P3((a0 + a1) / 2, (yIn + yOut) / 2, (d0 + d1) / 2);
        g.translate(c.x, c.y, c.z);
        return applyAo(g, { bottom: GRAMMAR.AO_UNDERSIDE });
      };
      return { P3, bx, paint, glow, coll, slant, ref: { ax, sg, plane }, nx: ax === 'x' ? sg : 0, nz: ax === 'z' ? sg : 0 };
    };
    type SF = ReturnType<typeof sf>;


    // ------------------------------------------------------------------ 7c. 10B-3 cyber megastructures (+0 calls)
    // Merged into the existing buckets: G.bodies (glass shafts), G.steel (exoskeleton, arch ribs, spire, frames),
    // G.strips (neon pillars / rings / ribs), G.concrete (round roof + parapet); cylinder ad rings are Mega-Billboards.
    const megaCounts: Record<string, number> = Object.fromEntries(MEGA_KINDS.map((k) => [k, 0]));
    let signGroup = 0;
    const palOf = (b: Building, k: number): number => PAL[(Math.floor(b.seed * 977) + k) % PAL.length];
    /** Beam lying in a wall plane: `inPlane` section width, `relief` depth along the wall normal. */
    const faceBeam = (ax: Axis, p0: THREE.Vector3, p1: THREE.Vector3, inPlane: number, relief: number): THREE.BufferGeometry =>
      ax === 'x' ? beam(p0, p1, relief, inPlane) : beam(p0, p1, inPlane, relief);
    const lotPlane = (b: Building, ax: Axis, sg: number): number => (ax === 'x' ? (sg > 0 ? b.rect.x1 : b.rect.x0) : sg > 0 ? b.rect.z1 : b.rect.z0);
    const lotRange = (b: Building, ax: Axis): [number, number] => (ax === 'x' ? [b.rect.z0, b.rect.z1] : [b.rect.x0, b.rect.x1]);
    /** Undistorted crop of an ad cell for a screen of aspect `a` (≤ 25 % stretch), centred on the cell's title band. */
    const adCrop = (cell: number, a: number): [number, number, number, number] => {
      const ac = MEGA_ATLAS.ASPECT[cell];
      const r = a / ac;
      let su = 1;
      let sv = 1;
      if (r > 1.25) sv = Math.max(0.12, 1.25 / r);
      else if (r < 0.8) su = Math.max(0.12, r / 0.8);
      const v0 = Math.min(1 - sv, Math.max(0, MEGA_ATLAS.TITLE_V[cell] - sv / 2));
      return [(1 - su) / 2, v0, su, sv];
    };
    const megaStructure = (b: Building): void => {
      const plan = b.plan;
      const GM = GRAMMAR;
      megaBuilding.add(b.index);
      megaCounts[b.massing]++;
      const neonA = palOf(b, 0);
      const neonB = palOf(b, 1);
      const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

      if (plan.truss) {
        // X_TRUSS_TOWER: bold diagonal X-brace exoskeleton (0.45 m beams, 12 m bays, 0.26 m relief: wall-run safe),
        // ring beams on every bay line, heavy corner columns, glowing node plates, lit cantilevered crown soffits.
        const { y0, y1 } = plan.truss;
        const R = GM.TRUSS_RELIEF_M;
        const BW = GM.TRUSS_BEAM_M;
        const nb = Math.max(1, Math.round((y1 - y0) / GM.TRUSS_BAY_M));
        const bh = (y1 - y0) / nb;
        for (const [ax, sg] of FACES) {
          const f = sf(ax, sg, lotPlane(b, ax, sg));
          const [a0, a1] = lotRange(b, ax);
          const np = a1 - a0 > 22 ? 2 : 1;
          const pw = (a1 - a0) / np;
          for (let i = 0; i < nb; i++) {
            const ya = y0 + i * bh;
            const yb = ya + bh;
            for (let j = 0; j < np; j++) {
              const pa = a0 + j * pw;
              const pb = pa + pw;
              G.steel.push(
                faceBeam(ax, f.P3(pa + BW, ya + BW / 2, R / 2), f.P3(pb - BW, yb - BW / 2, R / 2), BW, R),
                faceBeam(ax, f.P3(pb - BW, ya + BW / 2, R / 2), f.P3(pa + BW, yb - BW / 2, R / 2), BW, R),
              );
              const ma = (pa + pb) / 2;
              const my = (ya + yb) / 2;
              G.strips.push(f.glow(neonA, 1.7, ma - 0.28, ma + 0.28, my - 0.28, my + 0.28, R - 0.04, R + 0.05));
              if (i % 2 === 0 && my < 40) {
                const lp = f.P3(ma, my, 1.2);
                if (!lightNear(lp.x, lp.y, lp.z, 8)) addLight(lp.x, lp.y, lp.z, neonA, 1.2);
              }
            }
            for (let j = 1; j < np; j++) G.steel.push(...f.bx(a0 + j * pw - BW / 2, a0 + j * pw + BW / 2, ya, yb, 0, R));
          }
          for (let i = 0; i <= nb; i++) G.steel.push(...f.bx(a0, a1, y0 + i * bh - BW / 2, y0 + i * bh + BW / 2, 0, R, { bottom: GM.AO_UNDERSIDE }));
        }
        for (const [sx, sz] of CORNERS_4) {
          const x = sx > 0 ? b.rect.x1 : b.rect.x0;
          const z = sz > 0 ? b.rect.z1 : b.rect.z0;
          G.steel.push(boxAt(0.62, y1 - y0 + BW, 0.62, x + sx * 0.09, (y0 + y1) / 2, z + sz * 0.09));
        }
        // Cantilevered crown: neon line under each overhanging tier edge + a lit top edge.
        for (const bx of plan.boxes.slice(1)) {
          for (const [ax, sg] of FACES) {
            if (!plan.truss.cantilever.includes(faceKeyOf(ax, sg))) continue;
            const plane = ax === 'x' ? (sg > 0 ? bx.x1 : bx.x0) : sg > 0 ? bx.z1 : bx.z0;
            const [a0, a1] = ax === 'x' ? [bx.z0, bx.z1] : [bx.x0, bx.x1];
            const f = sf(ax, sg, plane);
            G.strips.push(f.glow(neonB, 1.6, a0 + 0.1, a1 - 0.1, bx.y0 + 0.02, bx.y0 + 0.12, -0.05, 0.04));
          }
        }
        addLight(b.cx, b.roofY + 2, b.cz, neonB, 2.4);
        return;
      }

      if (plan.cyl) {
        // CYLINDER_RING_TOWER: 12-sided glass shaft on the 8 m podium, vertical fins, 3 tiered ad rings (Mega-Billboard
        // segments + steel frames + neon edges), round roof + parapet, blazing crown halo and an 18 m radio spire.
        const { cx, cz, r, y0, y1 } = plan.cyl;
        const n = GM.CYL_SIDES;
        G.bodies.push(withAttr1(withAttr1(ngonWall(cx, cz, r, y0 - 0.05, y1 - 0.45, n), 'aSeed', b.seed), 'aArch', b.arch));
        // Circumscribed collider cross (≤ 0.18 r outside the facets, never inside).
        for (const [hx, hz] of [[0.966, 0.5], [0.5, 0.966], [0.837, 0.837]] as const) {
          colliders.push({ min: V(cx - hx * r, y0, cz - hz * r), max: V(cx + hx * r, y1, cz + hz * r), kind: 'BUILDING', building: b.index });
        }
        for (let k = 0; k < n; k++) {
          const c = ngonCorner(cx, cz, r + 0.03, n, k);
          G.steel.push(boxAt(0.16, y1 - y0 - 0.5, 0.16, c.x, (y0 + y1 - 0.5) / 2, c.z));
        }
        const T = RENDER.ROOF_TILE_M;
        G.concrete.push(ngonWall(cx, cz, r + 0.15, y1 - 0.5, y1, n, false, T), ngonAnnulus(cx, cz, 0.02, r + 0.15, y1, n, true, T), ngonAnnulus(cx, cz, r - 0.3, r + 0.15, y1 - 0.5, n, false, T));
        const pr1 = r + 0.12;
        const pr0 = pr1 - GM.PARAPET_T;
        G.concrete.push(ngonRing(cx, cz, pr0, pr1, y1, y1 + GM.PARAPET_H, n, T));
        G.steel.push(ngonRing(cx, cz, pr1 - GM.COPING_W, pr1 + 0.03, y1 + GM.PARAPET_H, y1 + GM.PARAPET_H + GM.COPING_H, n));
        for (let k = 0; k < n; k++) {
          const pa = ngonCorner(cx, cz, (pr0 + pr1) / 2, n, k - 1);
          const pb = ngonCorner(cx, cz, (pr0 + pr1) / 2, n, k);
          for (let q = 0; q < 3; q++) {
            const p0 = pa.clone().lerp(pb, q / 3);
            const p1 = pa.clone().lerp(pb, (q + 1) / 3);
            const t = GM.PARAPET_T / 2;
            colliders.push({
              min: V(Math.min(p0.x, p1.x) - t, y1, Math.min(p0.z, p1.z) - t),
              max: V(Math.max(p0.x, p1.x) + t, y1 + GM.PARAPET_H, Math.max(p0.z, p1.z) + t),
              kind: 'PROP',
              building: b.index,
            });
          }
        }
        // Tiered ad rings: 12 flush segments each, the ad repeating 4× around (3 segments per repeat).
        const ap = r * Math.cos(Math.PI / n);
        const ra = ap + 0.36;
        const ws = 2 * ra * Math.tan(Math.PI / n);
        const hr = 3.2;
        const rings = 3;
        const cells = sector.identity?.adCells.filter((c) => MEGA_ATLAS.ASPECT[c] >= 1) ?? [0, 1, 2, 5, 6, 7];
        for (let i = 0; i < rings; i++) {
          const yk = y0 + 7 + ((i + 0.5) / rings) * (y1 - y0 - 12);
          const cell = cells[(Math.floor(b.seed * 31) + i) % cells.length];
          const crop = adCrop(cell, (3 * ws) / hr);
          const g = ++signGroup;
          for (let k = 0; k < n; k++) {
            const th = (k / n) * Math.PI * 2;
            const seg = 2 - (k % 3);
            addMegaBillboard({
              kind: 'RING',
              x: cx + Math.cos(th) * ra,
              y: yk,
              z: cz + Math.sin(th) * ra,
              nx: Math.cos(th),
              nz: Math.sin(th),
              w: ws,
              h: hr,
              building: b.index,
              cell,
              rect: [crop[0] + (seg / 3) * crop[2], crop[1], crop[2] / 3, crop[3]],
              standoff: 0.36,
              group: g,
            });
          }
          const rf = (ap + 0.5) / Math.cos(Math.PI / n);
          for (const yy of [yk + hr / 2 + 0.02, yk - hr / 2 - 0.2]) G.steel.push(ngonRing(cx, cz, r - 0.05, rf, yy, yy + 0.18, n));
          for (const yy of [yk + hr / 2 + 0.2, yk - hr / 2 - 0.26]) G.strips.push(withColor(ngonWall(cx, cz, rf + 0.02, yy, yy + 0.06, n), neonA, 1.7));
          addMist(cx, yk, cz, AD_HUES[cell], r + 4, 0.12);
        }
        // Crown halo + posts, radio spire with aviation light.
        for (let k = 0; k < n; k += 2) {
          const c = ngonCorner(cx, cz, r + 0.3, n, k);
          G.steel.push(boxAt(0.14, 2.5, 0.14, c.x, y1 + 1.25, c.z));
        }
        G.strips.push(withColor(ngonWall(cx, cz, r + 0.34, y1 + 1.9, y1 + 2.4, n), neonA, 2.0), withColor(ngonWall(cx, cz, r + 0.3, y1 + 1.9, y1 + 2.4, n, true), neonA, 2.0));
        addLight(cx, y1 + 3, cz, neonA, 3.4);
        const SP = 18;
        G.steel.push(boxAt(0.4, SP, 0.4, cx, y1 + SP / 2, cz), boxAt(3.2, 0.14, 0.14, cx, y1 + 7, cz), boxAt(0.14, 0.14, 2.4, cx, y1 + 11.5, cz));
        colliders.push({ min: V(cx - 0.2, y1, cz - 0.2), max: V(cx + 0.2, y1 + SP, cz + 0.2), kind: 'STEEL', building: b.index });
        roofRects[b.index].push(rectFrom(cx - 1.8, cz - 1.8, cx + 1.8, cz + 1.8));
        addAviation(cx, y1 + SP + 0.3, cz);
        return;
      }

      if (plan.twin) {
        // TWIN_ARCH_GATE: twin slabs over a 6–8 m void (grapple-passable), bridged by a neon-framed sky-arch truss
        // with glowing vertical edge pillars; anchors under the soffit on both openings.
        const t = plan.twin;
        const openAx: Axis = t.axis === 'x' ? 'z' : 'x';
        const span = t.v1 - t.v0;
        const midA = (t.v0 + t.v1) / 2;
        const rise = Math.min(span * 0.62, (t.y1 - t.y0) * 0.4);
        const R = GM.TRUSS_RELIEF_M;
        for (const sgO of [-1, 1] as const) {
          const f = sf(openAx, sgO, sgO > 0 ? t.l1 : t.l0);
          for (const a of [t.v0, t.v1]) {
            G.strips.push(f.glow(neonA, 2.0, a - 0.22, a + 0.22, t.y0, t.bridgeY1 - 0.4, 0.02, 0.34));
            G.steel.push(...f.bx(a - 0.34, a + 0.34, t.y0, t.bridgeY1 - 0.4, -0.02, 0.24));
          }
          G.strips.push(f.glow(neonB, 1.8, t.v0, t.v1, t.bridgeY0 - 0.14, t.bridgeY0 + 0.04, 0.0, 0.26));
          G.strips.push(f.glow(neonB, 1.4, t.v0, t.v1, t.y0 + GM.PARAPET_H + 0.1, t.y0 + GM.PARAPET_H + 0.2, 0.0, 0.2));
          // Sky-arch: steel rib + neon face along a sine arch under the bridge soffit.
          const segs = 14;
          for (let i = 0; i < segs; i++) {
            const q0 = i / segs;
            const q1 = (i + 1) / segs;
            const p0 = f.P3(t.v0 + q0 * span, t.bridgeY0 - rise * (1 - Math.sin(Math.PI * q0)), 0.2);
            const p1 = f.P3(t.v0 + q1 * span, t.bridgeY0 - rise * (1 - Math.sin(Math.PI * q1)), 0.2);
            G.steel.push(faceBeam(openAx, p0, p1, 0.42, 0.3));
            G.strips.push(withColor(faceBeam(openAx, f.P3(t.v0 + q0 * span, t.bridgeY0 - rise * (1 - Math.sin(Math.PI * q0)), 0.38), f.P3(t.v0 + q1 * span, t.bridgeY0 - rise * (1 - Math.sin(Math.PI * q1)), 0.38), 0.16, 0.05), neonA, 2.0));
          }
          // Truss X on the bridge face + hanger rods from the arch crown.
          const yb0 = t.bridgeY0 + 0.4;
          const yb1 = t.bridgeY1 - 0.6;
          G.steel.push(
            faceBeam(openAx, f.P3(t.v0 + 0.3, yb0, R / 2), f.P3(t.v1 - 0.3, yb1, R / 2), 0.4, R),
            faceBeam(openAx, f.P3(t.v1 - 0.3, yb0, R / 2), f.P3(t.v0 + 0.3, yb1, R / 2), 0.4, R),
          );
          for (const q of [0.25, 0.5, 0.75]) {
            const a = t.v0 + q * span;
            const ya = t.bridgeY0 - rise * (1 - Math.sin(Math.PI * q));
            G.steel.push(...f.bx(a - 0.05, a + 0.05, ya, t.bridgeY0, 0.15, 0.25));
          }
          // Grapple anchor 1.2 m inside the opening, hung from the soffit.
          const an = f.P3(midA, t.bridgeY0 - 1.0, -1.2);
          G.steel.push(beam(an, an.clone().setY(t.bridgeY0), 0.16));
          addBeacon(an, 'BUILDING_CORNER');
        }
        const vc = openAx === 'x' ? V((t.l0 + t.l1) / 2, (t.y0 + t.y1) / 2, midA) : V(midA, (t.y0 + t.y1) / 2, (t.l0 + t.l1) / 2);
        addLight(vc.x, vc.y, vc.z, neonA, 2.6);
        addMist(vc.x, vc.y, vc.z, neonA, 9, 0.11);
        return;
      }

      if (plan.slant) {
        // SLANT_CORP_TOWER: sloped crown cap (walkable 35° ramp over the back half; the flat sniper deck stays in
        // front), vertical glowing spine ribs and an upward searchlight from the cap's crest.
        const sl = plan.slant;
        const yT = sl.y0 + sl.h;
        G.steel.push(slopedPrism(sl.axis, sl.a0, sl.a1, sl.l0, sl.l1, sl.y0 - 0.5, sl.y0 + 0.02, sl.y0 - 0.5, yT, { side: 0.9 }));
        for (const l of [sl.l0 + 0.08, sl.l1 - 0.08]) {
          G.strips.push(withColor(beam(pt(sl.axis, sl.a0, sl.y0 + 0.08, l), pt(sl.axis, sl.a1, yT + 0.06, l), 0.12), neonA, 2.0));
        }
        G.strips.push(withColor(boxGeoWorld(sl.axis, sl.a1 - sl.sg * 0.12, sl.a1, sl.l0, sl.l1, yT - 0.06, yT + 0.06), neonB, 1.8));
        rampColliders.push({ axis: sl.axis, lateralMin: sl.l0, lateralMax: sl.l1, alongStart: sl.a1, alongEnd: sl.a0, yStart: yT, yEnd: sl.y0, thickness: 0.5 });
        // 10BC-Fix FIX-3: seal the hollow cap's triangular sides with stepped solid bands under the ramp slab, each
        // kept ≥ slope·0.42 below the ramp surface at its high end so the centre-sampled ramp never snags the feet.
        {
          const N = Math.max(8, Math.ceil(sl.h / 0.75));
          const slope = sl.h / Math.abs(sl.a1 - sl.a0);
          const clearance = Math.max(0.42, slope * 0.42);
          for (let i = 0; i < N; i++) {
            const t0 = i / N;
            const t1 = (i + 1) / N;
            const yTop = sl.y0 + sl.h * t0 - clearance;
            if (yTop <= sl.y0 + 0.05) continue;
            const p0 = sl.a0 + (sl.a1 - sl.a0) * t0;
            const p1 = sl.a0 + (sl.a1 - sl.a0) * t1;
            const lo = Math.min(p0, p1);
            const hi = Math.max(p0, p1);
            colliders.push(
              sl.axis === 'x'
                ? { min: V(lo, sl.y0, sl.l0), max: V(hi, yTop, sl.l1), kind: 'BUILDING', building: b.index }
                : { min: V(sl.l0, sl.y0, lo), max: V(sl.l1, yTop, hi), kind: 'BUILDING', building: b.index },
            );
          }
        }
        const wall = pt(sl.axis, sl.a1 - sl.sg * 0.2, 0, (sl.l0 + sl.l1) / 2);
        const half = (sl.l1 - sl.l0) / 2;
        colliders.push(
          sl.axis === 'x'
            ? { min: V(Math.min(sl.a1, sl.a1 - sl.sg * 0.4), sl.y0, sl.l0), max: V(Math.max(sl.a1, sl.a1 - sl.sg * 0.4), yT, sl.l1), kind: 'BUILDING', building: b.index }
            : { min: V(sl.l0, sl.y0, Math.min(sl.a1, sl.a1 - sl.sg * 0.4)), max: V(sl.l1, yT, Math.max(sl.a1, sl.a1 - sl.sg * 0.4)), kind: 'BUILDING', building: b.index },
        );
        void wall;
        void half;
        // Spine ribs: 3 per face (0.24 m wide, 0.14 m relief), the back face's ribs continue up the cap wall.
        for (const [ax, sg] of FACES) {
          const f = sf(ax, sg, lotPlane(b, ax, sg));
          const [a0, a1] = lotRange(b, ax);
          const back = ax === sl.axis && sg === sl.sg;
          for (const q of [0.2, 0.5, 0.8]) {
            const a = a0 + q * (a1 - a0);
            G.strips.push(f.glow(q === 0.5 ? neonB : neonA, 1.7, a - 0.12, a + 0.12, GM.MEGA_PODIUM_M, (back ? yT : sl.y0) - 0.3, 0, 0.14));
          }
        }
        const crest = pt(sl.axis, sl.a1 - sl.sg * 1.2, yT + 0.4, (sl.l0 + sl.l1) / 2);
        addSearch(crest.x, crest.y, crest.z);
        addLight(crest.x, crest.y + 1, crest.z, neonA, 2.6);
        addAviation(crest.x, yT + 0.6, crest.z);
      }
    };

    // ------------------------------------------------------------------ 7b. tower bodies, roofs, crowns
    const roofRects: RectXZ[][] = buildings.map(() => []);
    /** Tower body box: aSeed + aArch. */
    const bodyBox = (w: number, h: number, d: number, x: number, y: number, z: number, seed: number, arch: number): THREE.BufferGeometry =>
      withAttr1(withAttr1(boxAt(w, h, d, x, y, z), 'aSeed', seed), 'aArch', arch);
    /** 11A: world-AABB shell piece → the matching static bucket (+0 draw calls). */
    const shellGeo = (pc: ShellPiece): void => {
      const w = Math.max(pc.x1 - pc.x0, 0.005);
      const h = Math.max(pc.y1 - pc.y0, 0.005);
      const d = Math.max(pc.z1 - pc.z0, 0.005);
      const x = (pc.x0 + pc.x1) / 2;
      const y = (pc.y0 + pc.y1) / 2;
      const z = (pc.z0 + pc.z1) / 2;
      if (pc.bucket === 'concrete') G.concrete.push(...aoBox(w, h, d, x, y, z, { all: pc.ao ?? 1, tile: RENDER.ROOF_TILE_M }));
      else if (pc.bucket === 'steel') G.steel.push(...aoBox(w, h, d, x, y, z, { all: pc.ao ?? 1 }));
      else if (pc.bucket === 'archPaint') G.archPaint.push(...aoBox(w, h, d, x, y, z, { tile: 1.6, all: pc.ao ?? 1 }).map((g) => withTint(g, pc.color ?? 0x3a3d42)));
      else G.strips.push(withColor(boxAt(w, h, d, x, y, z), pc.color ?? 0xffffff, pc.emissive ?? 1));
    };
    // 11A-1b mid-tower refuge sky-notches (own RNG stream): ≤ 4 per district on tall non-megastructure towers
    // without balconies / fire escapes / ducts / spines / galleries, on the floor grid, clear of terrace seams ± 4 m.
    const nrng = createRng(0x11b1 + sector.index * 71 + loop * 433);
    const notched = new Set<number>();
    const skyNotches: Array<{ building: number; yNotch: number; inset: number }> = [];
    let notchCount = 0;
    const notchOk = (b: Building): boolean =>
      !isMegaKind(b.massing) && b.massing !== 'GALLERY_DANCHI' && b.massing !== 'PENCIL_TOWER' &&
      !FACES.some(([ax, sg]) => {
        const k = fkey(b, ax, sg);
        return balconyFaces.has(k) || escapeFaces.has(k) || ductFaces.has(k) || spineFaces.has(k) || galleryFaces.has(k) || partialFaces.has(k);
      });
    const TERRACE_NEON = PAL;
    /** 11A-1: G.bodies / colliders slot of every massing box (carved interiors replace them in place). */
    const bodySlot: Array<Array<{ body: number; coll: number }>> = buildings.map(() => []);
    buildings.forEach((b) => {
      // 9A-2: one tower-material body + one BUILDING collider per massing box (L wings, podium + offset tower,
      // stepped tiers); every box top is a floor-grid roof / terrace with a wet concrete cap.
      for (const bx of b.plan.boxes) {
        const top = bx.y1 - 0.45;
        const y0 = bx.y0 > 0 ? bx.y0 - 0.05 : 0;
        bodySlot[b.index].push({ body: G.bodies.length, coll: colliders.length });
        const roll = nrng();
        const seams: Array<[number, number]> = b.plan.boxes.filter((o) => o !== bx).map((o) => [o.y1 - 4, o.y1 + 4]);
        if (b.plan.setbackY > 0) seams.push([b.plan.setbackY - 4, b.plan.setbackY + 4]);
        const notch = notchCount < 4 && roll < 0.55 && !notched.has(b.index) && notchOk(b) ? planSkyNotch(bx, b.arch, nrng, { blockedBands: seams }) : null;
        if (!notch) {
          G.bodies.push(bodyBox(bx.x1 - bx.x0, top - y0, bx.z1 - bx.z0, (bx.x0 + bx.x1) / 2, (y0 + top) / 2, (bx.z0 + bx.z1) / 2, b.seed, b.arch));
          colliders.push({ min: new THREE.Vector3(bx.x0, bx.y0, bx.z0), max: new THREE.Vector3(bx.x1, bx.y1, bx.z1), kind: 'BUILDING', building: b.index });
          continue;
        }
        // Lower shaft · recessed mechanical core · upper shaft (bodies + BUILDING colliders), steel columns, refuge
        // ledge, rail, 'LEDGE' grapple anchors; the facade spans split around the 4 m band before any sign is placed.
        notched.add(b.index);
        notchCount++;
        for (const pc of notch.solids) {
          const t = pc.y1 >= bx.y1 - 1e-6 ? pc.y1 - 0.45 : pc.y1;
          const yb = pc.y0 > 0 ? (pc.y0 <= bx.y0 + 1e-6 ? pc.y0 - 0.05 : pc.y0) : 0;
          G.bodies.push(bodyBox(pc.x1 - pc.x0, t - yb, pc.z1 - pc.z0, (pc.x0 + pc.x1) / 2, (yb + t) / 2, (pc.z0 + pc.z1) / 2, b.seed, b.arch));
          colliders.push({ min: new THREE.Vector3(pc.x0, pc.y0, pc.z0), max: new THREE.Vector3(pc.x1, pc.y1, pc.z1), kind: 'BUILDING', building: b.index });
        }
        for (const pc of notch.shell) shellGeo(pc);
        for (const l of notch.ledges) colliders.push({ min: new THREE.Vector3(l.x0, l.y0, l.z0), max: new THREE.Vector3(l.x1, l.y1, l.z1), kind: 'BUILDING', building: b.index });
        for (const l of notch.rails) colliders.push({ min: new THREE.Vector3(l.x0, l.y0, l.z0), max: new THREE.Vector3(l.x1, l.y1, l.z1), kind: 'STEEL', building: b.index });
        for (const p of notch.anchors) anchors.push({ position: p.clone(), kind: 'LEDGE', enabled: true });
        const n0 = notch.yNotch;
        const n1 = notch.yNotch + SKY_NOTCH.H_M;
        const onBox = (sp: FaceSpan): boolean => Math.abs(sp.plane - (sp.ax === 'x' ? (sp.sg > 0 ? bx.x1 : bx.x0) : sp.sg > 0 ? bx.z1 : bx.z0)) < 1e-6;
        const split: FaceSpan[] = [];
        for (const sp of b.plan.faces) {
          if (!onBox(sp) || sp.y1 <= n0 || sp.y0 >= n1) {
            split.push(sp);
            continue;
          }
          if (n0 - sp.y0 >= 1) split.push({ ...sp, y1: n0 });
          if (sp.y1 - n1 >= 1) split.push({ ...sp, y0: n1 });
        }
        b.plan.faces.length = 0;
        b.plan.faces.push(...split);
        skyNotches.push({ building: b.index, yNotch: n0, inset: notch.inset });
      }
      for (const pl of b.plan.plates) {
        if (pl.round) continue;
        G.concrete.push(worldUvBox(pl.x1 - pl.x0 + 0.3, 0.5, pl.z1 - pl.z0 + 0.3, (pl.x0 + pl.x1) / 2, pl.y - 0.25, (pl.z0 + pl.z1) / 2, RENDER.ROOF_TILE_M));
      }
      if (isMegaKind(b.massing)) megaStructure(b);
      // Terraces (stepped tiers, podium): a thin neon edge line under the parapet where the edge is open.
      if (b.plan.plates.some((pl) => !pl.main)) {
        const tn = TERRACE_NEON[Math.floor(srng() * TERRACE_NEON.length)];
        const sub = { ...b.plan, plates: b.plan.plates.filter((pl) => !pl.main) };
        for (const seg of parapetSegments(sub)) {
          const out = seg.plane + seg.sg * 0.18;
          G.strips.push(withColor(seg.ax === 'x' ? boxAt(0.06, 0.06, seg.a1 - seg.a0, out, seg.y - 0.6, (seg.a0 + seg.a1) / 2) : boxAt(seg.a1 - seg.a0, 0.06, 0.06, (seg.a0 + seg.a1) / 2, seg.y - 0.6, out), tn, 1.3));
        }
      }
      // Type A roof crown: steel corner posts + two horizontal neon rings — a sharp, lit skyline (the cylinder and
      // slant-cap megastructures carry their own crowns).
      if (b.arch === ARCH_A && b.massing !== 'CYLINDER_RING_TOWER' && b.massing !== 'SLANT_CORP_TOWER') {
        const cn = TERRACE_NEON[Math.floor(srng() * TERRACE_NEON.length)];
        // Inset clear of the 0.32 m parapet.
        const ix = b.halfW - 0.55;
        const iz = b.halfD - 0.55;
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
      // Two diagonal roof corners carry gold anchors on steel stubs (grapple-able building corners), now standing on
      // the parapet corner (9A-1).
      const diag = rng() < 0.5 ? 1 : -1;
      const pTop = b.roofY + GRAMMAR.PARAPET_H + GRAMMAR.COPING_H;
      const cyl = b.plan.cyl;
      const cylR = cyl?.r;
      const roofSegs = cylR === undefined ? parapetSegments(b.plan).filter((sg) => Math.abs(sg.y - b.roofY) < 0.1) : [];
      for (const [sx, sz] of [[1, diag], [-1, -diag]]) {
        let ex = b.cx + sx * (b.halfW + 0.6);
        let ez = b.cz + sz * (b.halfD + 0.6);
        const base = new THREE.Vector3(b.cx + sx * (b.halfW - 0.16), pTop, b.cz + sz * (b.halfD - 0.16));
        let stubY0 = pTop;
        if (cyl && cylR !== undefined) {
          // 10BC-Fix FIX-2: round roofs stand the stub on the 12-gon parapet midline (45° vertices), not inside it.
          const rMid = cylR + 0.12 - GRAMMAR.PARAPET_T * 0.5;
          const ux = sx / Math.SQRT2;
          const uz = sz / Math.SQRT2;
          base.set(cyl.cx + ux * rMid, pTop, cyl.cz + uz * rMid);
          ex = cyl.cx + ux * (rMid + 0.85);
          ez = cyl.cz + uz * (rMid + 0.85);
        } else {
          // 10BC-Fix FIX-2: a corner on an open (parapet-less) roof edge carries the vertical stub down to the deck.
          const onParapet = roofSegs.some((sg) => {
            const lat = sg.ax === 'x' ? base.x : base.z;
            const al = sg.ax === 'x' ? base.z : base.x;
            const d = (lat - sg.plane) * sg.sg;
            return d >= 0.12 - GRAMMAR.PARAPET_T - 0.02 && d <= 0.14 && al >= sg.a0 - 0.02 && al <= sg.a1 + 0.02;
          });
          if (!onParapet) stubY0 = b.roofY;
        }
        G.steel.push(beam(base, new THREE.Vector3(ex, b.roofY + 2.4, ez), 0.22), beam(base.clone().setY(stubY0), base.clone().setY(b.roofY + 2.6), 0.26));
        addBeacon(new THREE.Vector3(ex, b.roofY + 2.9, ez), 'BUILDING_CORNER');
        roofRects[b.index].push(rectFrom(base.x - 1, base.z - 1, base.x + 1, base.z + 1));
      }
    });


    // ------------------------------------------------------------------ 7c-2. 10B-2 Mega-Billboards (+1 call)
    // Strictly bound to solid lot FaceSpans: giant avenue screens (10–20 × 10–34 m), synchronized 90° L-corner
    // wrap-around screens (2–4 stacked tiers), towering monolith blades (3.2–4.5 × 18–38 m) and inward-facing
    // perimeter screens. Flat screens sit 0.30 m proud (0.47 m over Type A mullions; never on an A run face) with
    // steel frames and no collider; feature faces (balconies, escapes, galleries, spines, ducts, shutters) stay clear.
    const ident10 = sector.identity;
    const density = ident10?.billboardDensity ?? 0.6;
    const adCells = ident10?.adCells ?? [0, 1, 2, 5, 6, 7];
    const brng = createRng(0x10b2 + sector.index * 71 + loop * 307);
    /** Faces carrying a flat Mega-Billboard (Type B fins and riser bundles keep off them). */
    const megaFaces = new Set<string>();
    const megaRects: Array<{ b: number; ax: Axis; sg: number; a0: number; a1: number; y0: number; y1: number }> = [];
    const megaStats = { avenue: 0, perimeter: 0, corner: 0, cornerPieces: 0, blade: 0, ring: 0 };
    const pickCell = (pred: (c: number) => boolean): number => {
      const pool = adCells.filter(pred);
      const all = pool.length ? pool : [0, 1, 2, 3, 4, 5, 6, 7].filter(pred);
      return all[Math.floor(brng() * all.length)];
    };
    /** Named rejection (documents why a face / screen was skipped). */
    const why = (_reason: string): false => false;
    const screenFace = (b: Building, ax: Axis, sg: number, blade = false): boolean => {
      const k = fkey(b, ax, sg);
      // Slant monoliths take blades between their spine ribs; every other megastructure facade stays clean.
      if (isMegaKind(b.massing) && !(blade && b.massing === 'SLANT_CORP_TOWER')) return why('mega');
      if (megaFaces.has(k)) return why('used');
      if (alleyFaces.has(k)) return why('alley');
      if (partialFaces.has(k)) return why('partial');
      if (balconyFaces.has(k)) return why('balc');
      if (escapeFaces.has(k)) return why('esc');
      if (galleryFaces.has(k)) return why('gal');
      if (spineFaces.has(k)) return why('spine');
      if (ductFaces.has(k)) return why('duct');
      if (shutterFaces.has(k)) return why('shutter');
      if (blade && runFaces.has(k)) return why('run');
      return faceInPlay(b, ax, sg, blade ? 5.5 : 2) || why('play');
    };
    /** Screens sit 0.30 m proud (inside the 0.38 m wall-run capsule radius); Type A mullions are cut behind them. */
    const standoffOf = (_b: Building): number => 0.3;
    /** Tallest solid lot span of a face with its usable screen band (≥ 10 m up, 1 m under the span top). */
    const screenSpan = (b: Building, ax: Axis, sg: number): { sp: FaceSpan; yLo: number; yHi: number } | null => {
      let best: { sp: FaceSpan; yLo: number; yHi: number } | null = null;
      for (const sp of b.plan.faces) {
        if (sp.ax !== ax || sp.sg !== sg || !sp.lot || sp.court) continue;
        const yLo = Math.max(sp.y0 + 0.4, 10);
        const yHi = sp.y1 - 1.0;
        if (yHi - yLo < 8) continue;
        if (!best || (yHi - yLo) * (sp.a1 - sp.a0) > (best.yHi - best.yLo) * (best.sp.a1 - best.sp.a0)) best = { sp, yLo, yHi };
      }
      return best;
    };
    const frame = (f: SF, a0: number, a1: number, y0: number, y1: number, d: number): void => {
      // Steel mounting truss: top + bottom chords, side posts and two stand-off stiffeners behind the panel.
      G.steel.push(...f.bx(a0 - 0.12, a1 + 0.12, y1, y1 + 0.26, 0, d + 0.04, { bottom: GRAMMAR.AO_UNDERSIDE }));
      G.steel.push(...f.bx(a0 - 0.12, a1 + 0.12, y0 - 0.26, y0, 0, d + 0.04, { bottom: GRAMMAR.AO_UNDERSIDE }));
      G.steel.push(...f.bx(a0 - 0.12, a0, y0, y1, 0, d + 0.04), ...f.bx(a1, a1 + 0.12, y0, y1, 0, d + 0.04));
      for (const q of [0.33, 0.67]) {
        const a = a0 + q * (a1 - a0);
        G.steel.push(...f.bx(a - 0.06, a + 0.06, y0, y1, 0, Math.max(0.05, d - 0.03)));
      }
    };
    const flatScreen = (b: Building, ax: Axis, sg: number, kind: 'AVENUE' | 'PERIMETER'): boolean => {
      if (!screenFace(b, ax, sg)) return false;
      const ss = screenSpan(b, ax, sg);
      if (!ss) return why('nospan');
      const { sp, yLo, yHi } = ss;
      // 0.8 m end margins clear Type B corner pilasters and the frame posts.
      const aw = sp.a1 - sp.a0 - 1.6;
      const w = Math.min(20, aw, 10 + brng() * 10);
      const h = Math.min(34, yHi - yLo, w * (0.8 + brng() * 1.1));
      if (w < 10) return why('narrow');
      if (h < 10) return why('short');
      const cell = h / w >= 1.8 ? 3 : pickCell((c) => MEGA_ATLAS.ASPECT[c] >= 1);
      const d = standoffOf(b);
      const a = sp.a0 + 0.8 + w / 2 + brng() * Math.max(0, aw - w);
      const y = yLo + 0.3 + h / 2 + brng() * Math.max(0, Math.min(3, yHi - yLo - h - 0.3));
      if (y + h / 2 > yHi) return false;
      const f = sf(ax, sg, sp.plane);
      const p = f.P3(a, y, d);
      const ok = addMegaBillboard({ kind, x: p.x, y: p.y, z: p.z, nx: f.nx, nz: f.nz, w, h, building: b.index, cell, rect: adCrop(cell, w / h), standoff: d });
      if (!ok) return why('guard');
      frame(f, a - w / 2, a + w / 2, y - h / 2, y + h / 2, d);
      megaFaces.add(fkey(b, ax, sg));
      megaRects.push({ b: b.index, ax, sg, a0: a - w / 2 - 0.2, a1: a + w / 2 + 0.2, y0: y - h / 2 - 0.3, y1: y + h / 2 + 0.3 });
      const m = f.P3(a, y, d + 3);
      addMist(m.x, m.y, m.z, AD_HUES[cell], Math.min(16, Math.max(8, Math.sqrt(w * h) * 0.6)), 0.1 + brng() * 0.06);
      return true;
    };

    // (1) Synchronized 90° L-corner wrap-around screens on prominent street corners.
    {
      const want = Math.round(density * (sector.denseNeon ? 6 : 4));
      const cands: Array<{ b: Building; sx: 1 | -1; sz: 1 | -1; score: number }> = [];
      for (const b of buildings) {
        if (b.arch === ARCH_B) continue;
        for (const [sx, sz] of CORNERS_4 as ReadonlyArray<readonly [1 | -1, 1 | -1]>) {
          if (!screenFace(b, 'x', sx) || !screenFace(b, 'z', sz)) continue;
          const cxp = sx > 0 ? b.rect.x1 : b.rect.x0;
          const czp = sz > 0 ? b.rect.z1 : b.rect.z0;
          const near = Math.min(...intersectionSquares.map((r) => Math.hypot((r.x0 + r.x1) / 2 - cxp, (r.z0 + r.z1) / 2 - czp)), 99);
          cands.push({ b, sx, sz, score: -near + b.roofY * 0.2 + brng() * 6 });
        }
      }
      cands.sort((p, o) => o.score - p.score);
      const used = new Set<number>();
      for (const { b, sx, sz } of cands) {
        if (megaStats.corner >= want) break;
        if (used.has(b.index) || isMegaKind(b.massing) || !screenFace(b, 'x', sx) || !screenFace(b, 'z', sz)) continue;
        const cxp = sx > 0 ? b.rect.x1 : b.rect.x0;
        const czp = sz > 0 ? b.rect.z1 : b.rect.z0;
        // Spans of both faces that reach the corner.
        const reach = (ax: Axis, sg: number, cornerA: number): FaceSpan | undefined =>
          b.plan.faces.find((sp) => sp.ax === ax && sp.sg === sg && sp.lot && !sp.court && (Math.abs(sp.a0 - cornerA) < 1e-6 || Math.abs(sp.a1 - cornerA) < 1e-6) && sp.y1 - sp.y0 > 12);
        const spX = reach('x', sx, czp);
        const spZ = reach('z', sz, cxp);
        if (!spX || !spZ) continue;
        const yLo = Math.max(spX.y0 + 0.4, spZ.y0 + 0.4, 10);
        const yHi = Math.min(spX.y1, spZ.y1) - 1.0;
        if (yHi - yLo < 8) continue;
        const d = standoffOf(b);
        const lenX = Math.min(12, spX.a1 - spX.a0 - 0.6);
        const lenZ = Math.min(12, spZ.a1 - spZ.a0 - 0.6);
        if (lenX < 5 || lenZ < 5) continue;
        const Wt = lenX + lenZ + 2 * d;
        let n = Math.max(2, Math.min(4, Math.floor((yHi - yLo) / 6)));
        const gap = 1.0;
        let ht = Math.min(5.5, (Math.min(yHi - yLo, Wt * 1.1) - (n - 1) * gap) / n);
        while (ht < 2.6 && n > 2) {
          n--;
          ht = Math.min(5.5, (Math.min(yHi - yLo, Wt * 1.1) - (n - 1) * gap) / n);
        }
        if (ht < 2.6) continue;
        const Hs = n * ht + (n - 1) * gap;
        const ys = yLo + 0.3 + brng() * Math.max(0, yHi - yLo - Hs - 0.3);
        const cell = pickCell((c) => MEGA_ATLAS.ASPECT[c] >= 1);
        const crop = adCrop(cell, Wt / Hs);
        const g = ++signGroup;
        // Pieces: face x (along z) ends at the outer corner (czp + sz·d); face z (along x) ends at (cxp + sx·d).
        const fX = sf('x', sx, cxp);
        const fZ = sf('z', sz, czp);
        const pieces = [
          { f: fX, ax: 'x' as Axis, sg: sx, len: lenX, a0: czp - sz * lenX, a1: czp + sz * d, nx: sx, nz: 0 },
          { f: fZ, ax: 'z' as Axis, sg: sz, len: lenZ, a0: cxp - sx * lenZ, a1: cxp + sx * d, nx: 0, nz: sz },
        ];
        const geo = pieces.map((pc) => {
          const am = (pc.a0 + pc.a1) / 2;
          const w = Math.abs(pc.a1 - pc.a0);
          const c = pc.f.P3(am, 0, d);
          // Tangent of the quad's +u axis is (nz, −nx): the piece whose +u runs toward the corner is the LEFT half.
          const corner = pc.f.P3(pc.a1, 0, d);
          const left = (corner.x - c.x) * pc.nz + (corner.z - c.z) * -pc.nx > 0;
          return { ...pc, am, w, c, left };
        });
        if (geo[0].left === geo[1].left) continue;
        const wL = geo.find((q) => q.left)!.w;
        let fits = true;
        for (let k = 0; k < n && fits; k++) {
          const yc = ys + k * (ht + gap) + ht / 2;
          for (const q of geo) if (!signFits(q.c.x, yc, q.c.z, q.nx, q.nz, q.w, ht, g)) fits = false;
        }
        if (!fits || counts.mega + 2 * n > CAP.MEGA) continue;
        for (let k = 0; k < n; k++) {
          const yk0 = ys + k * (ht + gap);
          const vs0 = crop[1] + crop[3] * ((yk0 - ys) / Hs);
          const vsh = crop[3] * (ht / Hs);
          for (const q of geo) {
            const u0 = q.left ? crop[0] : crop[0] + crop[2] * (wL / Wt);
            const su = crop[2] * (q.w / Wt);
            addMegaBillboard({ kind: 'CORNER', x: q.c.x, y: yk0 + ht / 2, z: q.c.z, nx: q.nx, nz: q.nz, w: q.w, h: ht, building: b.index, cell, rect: [u0, vs0, su, vsh], standoff: d, group: g });
            megaStats.cornerPieces++;
            const lo = Math.min(q.a0, q.a1);
            const hi = Math.max(q.a0, q.a1);
            G.steel.push(...q.f.bx(lo, hi, yk0 + ht, yk0 + ht + 0.2, 0, d + 0.04, { bottom: GRAMMAR.AO_UNDERSIDE }), ...q.f.bx(lo, hi, yk0 - 0.2, yk0, 0, d + 0.04));
            G.strips.push(q.f.glow(AD_HUES[cell], 1.6, lo, hi, yk0 + ht + 0.2, yk0 + ht + 0.27, d - 0.02, d + 0.05));
          }
        }
        for (const q of geo) {
          const lo = Math.min(q.a0, q.a1);
          const hi = Math.max(q.a0, q.a1);
          megaFaces.add(fkey(b, q.ax, q.sg));
          megaRects.push({ b: b.index, ax: q.ax, sg: q.sg, a0: lo - 0.2, a1: hi + 0.2, y0: ys - 0.3, y1: ys + Hs + 0.3 });
          const fEnd = q.f.P3(q.a0, ys + Hs / 2, d / 2);
          G.steel.push(boxAt(0.16, Hs + 0.4, 0.16, fEnd.x, fEnd.y, fEnd.z));
        }
        const oc = fX.P3(czp + sz * d, ys + Hs / 2, d);
        G.steel.push(boxAt(0.2, Hs + 0.5, 0.2, oc.x, oc.y, oc.z));
        addMist(oc.x + sx * 2.5, oc.y, oc.z + sz * 2.5, AD_HUES[cell], Math.min(16, 8 + Hs * 0.35), 0.13);
        megaStats.corner++;
        used.add(b.index);
      }
    }

    // (2) Towering vertical monolith blades (cell 4) on solid spans: street lot faces without a run / feature role,
    // or set-back upper tower faces (podium towers, stepped tiers); Sector 5 frames its scramble arena with them.
    {
      const want = Math.round(density * 4) + (plan.plaza ? 4 : 0);
      const cands: Array<{ b: Building; sp: FaceSpan; score: number }> = [];
      for (const b of buildings) {
        if (isMegaKind(b.massing) && b.massing !== 'SLANT_CORP_TOWER') continue;
        for (const sp of b.plan.faces) {
          if (sp.court || sp.a1 - sp.a0 < 1.6 || sp.y1 - 0.45 - Math.max(sp.y0 + 0.4, 10) < 18) continue;
          const k = fkey(b, sp.ax, sp.sg);
          if (sp.lot && !screenFace(b, sp.ax, sp.sg, true)) continue;
          if (!sp.lot && (alleyFaces.has(k) || partialFaces.has(k))) continue;
          const toPlaza = plan.plaza ? (Math.sign(-sp.plane) === sp.sg && Math.abs(sp.plane) < 46 ? 60 : 0) : 0;
          cands.push({ b, sp, score: toPlaza + sp.y1 * 0.5 + brng() * 25 });
        }
      }
      cands.sort((p, o) => o.score - p.score);
      const used = new Set<number>();
      for (const { b, sp } of cands) {
        if (megaStats.blade >= want) break;
        if (used.has(b.index) || (sp.lot && megaFaces.has(fkey(b, sp.ax, sp.sg)))) continue;
        const ax = sp.ax;
        const bw = 3.2 + brng() * 1.3;
        let yLo = Math.max(sp.y0 + 0.4, 10);
        const yHi = sp.y1 - 0.45;
        const f = sf(ax, sp.sg, sp.plane);
        const a = b.massing === 'SLANT_CORP_TOWER' ? sp.a0 + (brng() < 0.5 ? 0.35 : 0.65) * (sp.a1 - sp.a0) : sp.a0 + 0.6 + brng() * Math.max(0, sp.a1 - sp.a0 - 1.2);
        // Clear the expressway decks (Y 7.9–10.6) wherever the blade's footprint overhangs one.
        const pIn = f.P3(a, 0, 0.3);
        const pOut = f.P3(a, 0, 0.3 + bw);
        const foot = rectFrom(Math.min(pIn.x, pOut.x) - 0.2, Math.min(pIn.z, pOut.z) - 0.2, Math.max(pIn.x, pOut.x) + 0.2, Math.max(pIn.z, pOut.z) + 0.2);
        if (highwayRects.some((r) => rectsOverlap(r, foot, 1))) yLo = Math.max(yLo, 12.5);
        if (!inArea(pOut.x, pOut.z, 0.5)) continue;
        // Never through a neighbouring tower (set-back faces look over a podium roof first).
        if (buildings.some((o) => o !== b && rectsOverlap(o.rect, foot, 0.4))) continue;
        const bh = Math.min(38, yHi - yLo, 18 + brng() * 20);
        if (bh < 18) continue;
        const y = yLo + bh / 2 + brng() * Math.max(0, Math.min(4, yHi - yLo - bh));
        const c = f.P3(a, y, 0.3 + bw / 2);
        const nx = ax === 'x' ? 0 : 1;
        const nz = ax === 'x' ? 1 : 0;
        const cell = 4;
        if (!addMegaBillboard({ kind: 'BLADE', x: c.x, y: c.y, z: c.z, nx, nz, w: bw, h: bh, building: b.index, cell, rect: adCrop(cell, bw / bh), standoff: 0.3 })) continue;
        // Steel spine along the inner edge + three cantilever arms, neon edge on the outer edge.
        G.steel.push(...f.bx(a - 0.12, a + 0.12, y - bh / 2 - 0.3, y + bh / 2 + 0.3, 0.06, 0.3));
        for (const q of [-0.45, 0, 0.45]) G.steel.push(...f.bx(a - 0.08, a + 0.08, y + q * bh - 0.12, y + q * bh + 0.12, 0, 0.3 + bw));
        G.strips.push(f.glow(0xff2b4a, 1.8, a - 0.06, a + 0.06, y - bh / 2, y + bh / 2, 0.3 + bw, 0.3 + bw + 0.08));
        const m = f.P3(a, y, 0.3 + bw / 2);
        addMist(m.x, m.y, m.z, AD_HUES[cell], Math.min(16, 8 + bh * 0.2), 0.12);
        used.add(b.index);
        megaStats.blade++;
      }
    }

    // (3) Giant avenue wall screens facing the district's avenues.
    {
      const want = Math.round(density * 6);
      const faces: Array<{ b: Building; ax: Axis; sg: number; score: number }> = [];
      for (const s0 of plan.streets) {
        if (s0.kind !== 'AVENUE') continue;
        const ch = corridorHalf(s0) + 4;
        for (const b of buildings) {
          const ax: Axis = s0.axis === 'z' ? 'x' : 'z';
          for (const sg of [1, -1] as const) {
            const plane = ax === 'x' ? (sg > 0 ? b.rect.x1 : b.rect.x0) : sg > 0 ? b.rect.z1 : b.rect.z0;
            const along = ax === 'x' ? (b.rect.z0 + b.rect.z1) / 2 : (b.rect.x0 + b.rect.x1) / 2;
            if (Math.sign(s0.coord - plane) !== sg || Math.abs(s0.coord - plane) > ch || along < s0.from - 15 || along > s0.to + 15) continue;
            faces.push({ b, ax, sg, score: b.roofY + brng() * 20 });
          }
        }
      }
      faces.sort((p, o) => o.score - p.score);
      for (const fc of faces) {
        if (megaStats.avenue >= want) break;
        if (flatScreen(fc.b, fc.ax, fc.sg, 'AVENUE')) megaStats.avenue++;
      }
    }

    // (4) Perimeter skyline: tall lots on the ±H wall face the district with inward screens.
    {
      const want = Math.round(density * 6);
      const cands: Array<{ b: Building; ax: Axis; sg: number; score: number }> = [];
      for (const b of buildings) {
        if (!isPerimeter(b.rect)) continue;
        for (const [ax, sg] of FACES) {
          const c = ax === 'x' ? b.lcx : b.lcz;
          if (sg * c >= 0) continue;
          cands.push({ b, ax, sg, score: Math.abs(c) + b.roofY * 0.3 + brng() * 10 });
        }
      }
      cands.sort((p, o) => o.score - p.score);
      const used = new Set<number>();
      for (const { b, ax, sg } of cands) {
        if (megaStats.perimeter >= want) break;
        if (used.has(b.index)) continue;
        if (flatScreen(b, ax, sg, 'PERIMETER')) {
          megaStats.perimeter++;
          used.add(b.index);
        }
      }
    }
    megaStats.ring = megaRecords.filter((r) => r.kind === 'RING').length;

    // ------------------------------------------------------------------ 7d. archetype 3D details
    /** Structural add-on drawn with the tower material in its archetype's plain cladding band (one draw). */
    const plainBody = (g: THREE.BufferGeometry, seed: number, col: number): THREE.BufferGeometry => withAttr1(withAttr1(g, 'aSeed', seed), 'aArch', col + 0.25);
    /** Point in a face frame: `al` along the face, `y` up, `d` metres out from the wall (negative = inside). */
    const faceFrame = (b: Building, ax: Axis, sg: number) => {
      const face = ax === 'x' ? b.lcx + sg * b.lotHalfW : b.lcz + sg * b.lotHalfD;
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
      const c = ax === 'x' ? b.lcz : b.lcx;
      const len = faceLen(b, ax);
      return { face, P3, box, coll, c, len, a0: c - len / 2, a1: c + len / 2, nx: ax === 'x' ? sg : 0, nz: ax === 'z' ? sg : 0 };
    };

    /**
     * 9A-3 room-grid lines of a face: world coordinates (z on x-faces, x on z-faces) of the facade room boundaries
     * (same mapping and per-tower room offset as the tower shader / facadeProbe), every `step` rooms.
     */
    const roomLines = (b: Building, ax: Axis, sg: number, w0: number, w1: number, step: number, margin = 0.4): number[] => {
      const roomW = FACADE.TILE_W_M / roomsPerTile(b.arch);
      const off = roomOffset(seedInt(b.seed), b.arch) * roomW;
      const out: number[] = [];
      // along = −z·sg on x faces, x·sg on z faces; boundaries where along + off = k · roomW.
      const toW = (k: number): number => (ax === 'x' ? -(k * roomW - off) * sg : (k * roomW - off) * sg);
      const kA = Math.floor(((ax === 'x' ? -w1 * sg : w0 * sg) + off) / roomW) - 2;
      const kB = Math.ceil(((ax === 'x' ? -w0 * sg : w1 * sg) + off) / roomW) + 2;
      for (let k = Math.min(kA, kB); k <= Math.max(kA, kB); k++) {
        if (((k % step) + step) % step !== 0) continue;
        const w = toW(k);
        if (w > Math.min(w0, w1) + margin && w < Math.max(w0, w1) - margin) out.push(w);
      }
      return out;
    };
    /** Type A: vertical aluminium mullions on the 3 m room lines of every massing box + corner columns (no collider). */
    const mullions = (b: Building, bx: { x0: number; x1: number; z0: number; z1: number }, y0: number, y1: number): void => {
      if (y1 - y0 < 2) return;
      const h = y1 - y0;
      const cy = (y0 + y1) / 2;
      const cx = (bx.x0 + bx.x1) / 2;
      const cz = (bx.z0 + bx.z1) / 2;
      const hw = (bx.x1 - bx.x0) / 2;
      const hd = (bx.z1 - bx.z0) / 2;
      for (const [ax, sg] of FACES) {
        const lines = ax === 'x' ? roomLines(b, ax, sg, bx.z0, bx.z1, 1, 0.6) : roomLines(b, ax, sg, bx.x0, bx.x1, 1, 0.6);
        const plane = ax === 'x' ? cx + sg * hw : cz + sg * hd;
        for (const a of lines) {
          // 10B-2: mullions stop behind Mega-Billboards (screens sit 0.30 m proud of the glass).
          let segs: Array<[number, number]> = [[y0, y1]];
          for (const mr of megaRects) {
            if (mr.b !== b.index || mr.ax !== ax || mr.sg !== sg || a < mr.a0 - 0.2 || a > mr.a1 + 0.2) continue;
            const mPlane = ax === 'x' ? (sg > 0 ? b.rect.x1 : b.rect.x0) : sg > 0 ? b.rect.z1 : b.rect.z0;
            if (Math.abs(mPlane - plane) > 1e-3) continue;
            segs = segs.flatMap(([s0, s1]): Array<[number, number]> => (mr.y1 <= s0 || mr.y0 >= s1 ? [[s0, s1]] : [[s0, Math.min(s1, mr.y0)], [Math.max(s0, mr.y1), s1]]));
          }
          for (const [s0, s1] of segs) {
            if (s1 - s0 < 0.3) continue;
            if (ax === 'x') G.steel.push(boxAt(AR.MULLION_D, s1 - s0, AR.MULLION_W, cx + sg * (hw + AR.MULLION_D / 2), (s0 + s1) / 2, a));
            else G.steel.push(boxAt(AR.MULLION_W, s1 - s0, AR.MULLION_D, a, (s0 + s1) / 2, cz + sg * (hd + AR.MULLION_D / 2)));
          }
        }
      }
      for (const [sx, sz] of CORNERS_4) G.steel.push(boxAt(AR.MULLION_D + 0.1, h, AR.MULLION_D + 0.1, cx + sx * (hw + 0.02), cy, cz + sz * (hd + 0.02)));
    };

    /** True when the corner point lies on / inside another massing box at that height (concave or shared corner). */
    const coveredCorner = (b: Building, self: number, x: number, z: number, y: number): boolean =>
      b.plan.boxes.some((o, j) => j !== self && o.y0 <= y && o.y1 > y && x >= o.x0 - 1e-6 && x <= o.x1 + 1e-6 && z >= o.z0 - 1e-6 && z <= o.z1 + 1e-6);
    /** Type B: thick cast-concrete pilasters on every convex massing corner (0.4 m relief ≤ 0.45 m: no collider). */
    const pilasters = (b: Building): void => {
      const P = AR.PILASTER_W;
      const O = AR.PILASTER_OUT;
      b.plan.boxes.forEach((bx, i) => {
        const y0 = bx.y0;
        const top = bx.y1 + 0.4 - y0;
        for (const [sx, sz] of CORNERS_4) {
          const cxr = sx > 0 ? bx.x1 : bx.x0;
          const czr = sz > 0 ? bx.z1 : bx.z0;
          if (coveredCorner(b, i, cxr, czr, y0 + 1)) continue;
          G.bodies.push(plainBody(boxAt(P, top, P, cxr + sx * (O - P / 2), y0 + top / 2, czr + sz * (O - P / 2)), b.seed, ARCH_B));
        }
      });
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
        counts.ac++;
        placeMech(0, p.x, p.y, p.z, ax === 'x' ? Math.PI / 2 : 0, 0.5, 0.5, 0.5);
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

    /** 9A: fire-escape landing gaps in the roof parapet, and along ranges kept free of 1F doors per face. */
    const escapeGaps: Array<{ building: number; ax: Axis; sg: number; plane: number; a0: number; a1: number }> = [];
    const blockedRanges = new Map<string, Array<[number, number]>>();
    /** 10B-2: along ranges with a ground-standing obstacle in front of the wall (gallery columns): no 1F doorway. */
    const noDoorRanges = new Map<string, Array<[number, number]>>();
    const noDoorRange = (key: string, a0: number, a1: number): void => {
      const l = noDoorRanges.get(key) ?? [];
      l.push([a0, a1]);
      noDoorRanges.set(key, l);
    };
    const blockRange = (key: string, a0: number, a1: number): void => {
      const l = blockedRanges.get(key) ?? [];
      l.push([Math.min(a0, a1), Math.max(a0, a1)]);
      blockedRanges.set(key, l);
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
      if (toRoof) {
        roofEscapes.add(fkey(b, ax, sg));
        // 9A-1: 2.4 m parapet gap centred on the top landing.
        const lc = (K % 2 === 1 ? nearA : farA) + LW / 2;
        escapeGaps.push({ building: b.index, ax, sg, plane: f.face, a0: lc - GRAMMAR.ESCAPE_GAP_M / 2, a1: lc + GRAMMAR.ESCAPE_GAP_M / 2 });
      }
      blockRange(fkey(b, ax, sg), nearA - 0.3, farA + LW + 0.3);
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
        blockRange(fkey(b, ax, sg), a - W2 - 0.5, a + W2 + 0.5);
        G.steel.push(f.box(a - W2, a + W2, 0.4, lowTop + 0.9, 0, O), f.box(a - W2 - 0.15, a + W2 + 0.15, lowTop + 0.9, lowTop + 1.15, -0.1, O + 0.2));
        for (let y = 3; y < lowTop; y += 3) G.steel.push(f.box(a - W2 - 0.05, a + W2 + 0.05, y, y + 0.08, 0, O + 0.04));
        for (const off of [W2 + 0.25, W2 + 0.45]) G.steel.push(f.box(a + off - 0.05, a + off + 0.05, 0, lowTop + 0.3, 0.12, 0.22));
      }
      if (f.len >= 10) {
        const a = f.c + (arng() - 0.5) * (f.len - 8);
        blockRange(fkey(b, ax, sg), a - 3.3, a + 3.3);
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
      facadeFeatures.push({ kind: 'SHUTTER_FRONT', building: b.index, center: f.P3(f.c, 0, 0), normal: new THREE.Vector3(f.nx, 0, f.nz), top: RT });
      // 9A-4: the 1F street base (piers, doors, fascia) now comes from the face's ground program.
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
          const yBan = y + 0.95;
          const bh = 0.85;
          const span = b.plan.faces.find(
            (sp) => sp.ax === ax && sp.sg === sg && sp.a1 - sp.a0 >= 2.6 && yBan - bh / 2 >= sp.y0 + 0.4 && yBan + bh / 2 <= sp.y1 - 0.4,
          );
          if (span) {
            const bw = Math.min(span.a1 - span.a0 - 0.6, Math.min(f.len * 0.7, 9));
            const aMid = (span.a0 + span.a1) / 2;
            const maxShift = Math.max(0, (span.a1 - span.a0 - 0.6 - bw) / 2);
            const along = aMid + (srng() * 2 - 1) * maxShift;
            const nx = span.ax === 'x' ? span.sg : 0;
            const nz = span.ax === 'z' ? span.sg : 0;
            const px = span.ax === 'x' ? span.plane + span.sg * 0.1 : along;
            const pz = span.ax === 'z' ? span.plane + span.sg * 0.1 : along;
            addNeon(px, yBan, pz, nx, nz, bw, bh, Math.floor(srng() * SIGN_ATLAS.WIDE_ROWS), 1, { kind: 'BUILDING_FLAT', building: b.index });
          }
        }
      }
    };

    buildings.forEach((b) => {
      const lowTop = lowTopOf(b);
      void lowTop;
      if (b.arch === ARCH_A) {
        // 10B-3: exoskeleton / spine-rib megastructures keep mullions on the podium band only.
        const ribbed = b.massing === 'X_TRUSS_TOWER' || b.massing === 'SLANT_CORP_TOWER';
        for (const bx of b.plan.boxes) mullions(b, bx, Math.max(4.0, bx.y0 + 0.05), ribbed ? Math.min(bx.y1 - 0.45, GRAMMAR.MEGA_PODIUM_M) : bx.y1 - 0.45);
      }
      else if (b.arch === ARCH_B) pilasters(b);
      for (const [ax, sg] of FACES) {
        const key = fkey(b, ax, sg);
        if (balconyFaces.has(key)) balconies(b, ax, sg);
        if (escapeFaces.has(key)) fireEscape(b, ax, sg);
        if (ductFaces.has(key)) ductsAndDock(b, ax, sg);
        if (shutterFaces.has(key)) shutterFront(b, ax, sg);
      }
    });

    // =========================================================================================
    // 9A architectural pass: galleries, pencil spines, ground programs, slab bands, piers, parapets, pipes
    // =========================================================================================
    const GR = GRAMMAR;
    const grng = createRng(0x9a0d + sector.index * 97 + loop * 389);
    /** 9B stream (bay sockets, decal surfaces, clutter): separate so the 9A layout stays identical. */
    const p9Rng = createRng(0x9b0b + sector.index * 61 + loop * 433);
    const propSockets: PropSocket[] = [];
    const doorClearZones: DoorZone[] = [];
    /** 9B: ground obstacles without colliders (lamp poles, riser pipes) + decal surfaces gathered by the 9A passes. */
    const propObstacles: Aabb3[] = [];
    const decalSurfaces: DecalSurface[] = [];
    const eateryVents: THREE.Vector3[] = [];
    /** 10D-4 storefront canopy / market awning front lips that drip rain (world segments, ≤ 48). */
    const canopyDripEdges: Array<{ x0: number; z0: number; x1: number; z1: number; y: number }> = [];
    const addDripEdge = (f: { P3: (a: number, y: number, d: number) => THREE.Vector3 }, a0: number, a1: number, d: number, y: number): void => {
      if (canopyDripEdges.length >= 48 || a1 - a0 < 1) return;
      const p = f.P3(a0, y, d);
      const q = f.P3(a1, y, d);
      canopyDripEdges.push({ x0: p.x, z0: p.z, x1: q.x, z1: q.z, y });
    };
    const programCounts: Record<GroundProgram, number> = { CYBER_EATERY: 0, TECH_APPAREL: 0, CAPSULE_HOTEL: 0, CYBER_APARTMENT: 0, ALLEY_INFRA: 0 };
    const doorSizes: Array<[number, number]> = [];
    const groundDoors: GroundDoorRecord[] = [];
    const groundPiers: GroundPierRecord[] = [];
    /** 10D-Fix FIX-2: 1F storefront bays (face-local) — 1F wall fans mount only on opaque bay relief. */
    const groundBays: Array<{ building: number; ax: Axis; sg: number; plane: number; a0: number; a1: number; use: string; oT: number }> = [];
    /** 10D-Fix FIX-2/3: collider-less wall fixtures (infra transformer boxes, 1F conduits + junction boxes), world AABBs. */
    const wallFixtures: Aabb3[] = [];
    const fixtureBox = (f: { P3: (a: number, y: number, d: number) => THREE.Vector3 }, a0: number, a1: number, y0: number, y1: number, d0: number, d1: number): void => {
      const p = f.P3(a0, y0, d0);
      const q = f.P3(a1, y1, d1);
      wallFixtures.push({ minX: Math.min(p.x, q.x), minY: y0, minZ: Math.min(p.z, q.z), maxX: Math.max(p.x, q.x), maxY: y1, maxZ: Math.max(p.z, q.z) });
    };
    let doorId = 0;
    let galleryDoors = 0;
    let galleryLevels = 0;
    let galleryRamps = 0;
    let galleriesLinked = 0;
    let spineCount = 0;
    let bandCount = 0;
    let pierCount = 0;
    let parapetLen = 0;
    let parapetGapCount = 0;
    let pipeBundles = 0;
    /** Span-local frame: `a` along the wall, `y` up, `d` metres out from the wall plane. */

    // ---------------------------------------------------------------- GALLERY_DANCHI corridors
    const galleryDoorPaint = (b: Building): number => PAINT.DOORS[Math.floor(b.seed * 97) % PAINT.DOORS.length];
    const ramp = (f: SF, ax: Axis, aLow: number, aHigh: number, yLow: number, yHigh: number, d0: number, d1: number): void => {
      const alongAxis: Axis = ax === 'x' ? 'z' : 'x';
      const l0 = f.ref.plane + f.ref.sg * d0;
      const l1 = f.ref.plane + f.ref.sg * d1;
      rampColliders.push({ axis: alongAxis, lateralMin: Math.min(l0, l1), lateralMax: Math.max(l0, l1), alongStart: aHigh, alongEnd: aLow, yStart: yHigh, yEnd: yLow, thickness: 0.25, steel: true });
      for (const d of [d0 + 0.03, d1 - 0.03]) G.steel.push(beam(f.P3(aLow, yLow - 0.12, d), f.P3(aHigh, yHigh - 0.12, d), 0.05, 0.22));
      const steps = Math.max(4, Math.round((yHigh - yLow) / 0.2));
      const half = Math.abs(aHigh - aLow) / steps / 2 + 0.03;
      for (let i = 0; i < steps; i++) {
        const a = aLow + ((aHigh - aLow) * (i + 0.5)) / steps;
        const ty = yLow + ((i + 1) * (yHigh - yLow)) / steps - 0.02;
        G.steel.push(...f.bx(a - half, a + half, ty - 0.05, ty, d0 + 0.05, d1 - 0.05));
      }
      G.steel.push(beam(f.P3(aLow, yLow + 1.0, d1 - 0.03), f.P3(aHigh, yHigh + 1.0, d1 - 0.03), 0.05));
      galleryRamps++;
    };
    const gallery = (b: Building, ax: Axis, sg: number): void => {
      const f0 = faceFrame(b, ax, sg);
      const f = sf(ax, sg, f0.face);
      const gp = planGallery(b.arch, f0.a0, f0.a1);
      const D = GR.GALLERY_DEPTH_M;
      const S = GR.GALLERY_SLAB_M;
      const RH = GR.GALLERY_RAIL_M;
      const doorHex = galleryDoorPaint(b);
      const e0 = f0.a0 + GR.GALLERY_END_PIER_M;
      const e1 = f0.a1 - GR.GALLERY_END_PIER_M;
      const sub = (a0: number, a1: number, cuts: ReadonlyArray<readonly [number, number]>): Array<[number, number]> => subtractIntervals(a0, a1, cuts.map(([c0, c1]) => [c0, c1] as [number, number]));
      gp.levels.forEach((lv, li) => {
        const ceilY = (li + 1 < gp.levels.length ? gp.levels[li + 1].y : gp.capY) - S;
        G.concrete.push(...f.bx(lv.a0, lv.a1, lv.y - S, lv.y, 0, D, { bottom: GR.AO_SOFFIT_GALLERY, tile: RENDER.ROOF_TILE_M }));
        f.coll(lv.a0, lv.a1, lv.y - S, lv.y, 0, D, b.index);
        // Floor drain channel along the outer edge.
        G.steel.push(...f.bx(lv.a0, lv.a1, lv.y - 0.005, lv.y + 0.01, D - 0.2, D - 0.12, { all: 0.7 }));
        // Outer balustrade (top / bottom rails, pickets every 0.42 m) open where a stair landing meets the deck.
        for (const [r0, r1] of sub(lv.a0, lv.a1, lv.railGaps)) {
          if (r1 - r0 < 0.2) continue;
          G.steel.push(...f.bx(r0, r1, lv.y + RH - 0.05, lv.y + RH, D - 0.07, D), ...f.bx(r0, r1, lv.y + 0.1, lv.y + 0.14, D - 0.06, D - 0.02));
          for (let a = r0 + 0.05; a <= r1 - 0.04; a += GR.GALLERY_PICKET_M) G.steel.push(...f.bx(a - 0.015, a + 0.015, lv.y, lv.y + RH, D - 0.05, D - 0.02));
          f.coll(r0, r1, lv.y, lv.y + RH, D - 0.1, D, b.index);
        }
        // End railings.
        for (const a of [lv.a0, lv.a1]) {
          G.steel.push(...f.bx(a - 0.03, a + 0.03, lv.y + RH - 0.05, lv.y + RH, 0, D));
          f.coll(a - 0.05, a + 0.05, lv.y, lv.y + RH, 0, D, b.index);
        }
        // Overhead infrastructure: galvanised cable-tray ladder on the outer soffit, two conduits, caged tubes.
        if (ceilY - lv.y > 2.4) {
          const tY = ceilY - 0.14;
          G.steel.push(...f.bx(lv.a0, lv.a1, tY, tY + 0.05, D - 0.62, D - 0.58), ...f.bx(lv.a0, lv.a1, tY, tY + 0.05, D - 0.2, D - 0.16));
          for (let a = lv.a0 + 0.3; a < lv.a1; a += 0.6) G.steel.push(...f.bx(a - 0.015, a + 0.015, tY, tY + 0.025, D - 0.6, D - 0.18));
          for (const d of [0.32, 0.46]) G.steel.push(aoPipe(f.P3(lv.a0, ceilY - 0.07, d), f.P3(lv.a1, ceilY - 0.07, d), 0.03, null));
          for (let a = lv.a0 + 2; a < lv.a1 - 0.6; a += GR.GALLERY_COLUMN_M) {
            const warm = Math.floor(a * 7.3 + li) % 3 === 0;
            G.strips.push(f.glow(warm ? 0xffd9a0 : 0xdcecff, 0.85, a - 0.6, a + 0.6, ceilY - 0.1, ceilY - 0.06, 0.7, 0.76));
            G.steel.push(...f.bx(a - 0.65, a + 0.65, ceilY - 0.13, ceilY - 0.12, 0.66, 0.8), ...f.bx(a - 0.65, a - 0.62, ceilY - 0.13, ceilY, 0.66, 0.8), ...f.bx(a + 0.62, a + 0.65, ceilY - 0.13, ceilY, 0.66, 0.8));
            if (Math.floor((a - lv.a0) / GR.GALLERY_COLUMN_M) % 2 === 0) {
              const lp = f.P3(a, ceilY - 0.4, 0.9);
              if (!lightNear(lp.x, lp.y, lp.z, 3)) addLight(lp.x, lp.y, lp.z, warm ? 0xffd9a0 : 0xdcecff, 0.9);
            }
          }
        }
        // Apartment doors every 4 m: frame surround, recessed painted steel door, barred corridor window.
        for (const a of lv.doors) {
          const y = lv.y;
          // 11A-1: a carved apartment's real InteractiveDoor replaces the fake corridor door + barred window.
          if (openingsAt(b.index, ax, sg, f0.face, a - 0.65, a + 2.2, y, y + 2.3).length) continue;
          G.concrete.push(
            ...f.bx(a - 0.65, a - 0.51, y, y + 2.3, 0, 0.18, { all: 0.8, tile: RENDER.ROOF_TILE_M }),
            ...f.bx(a + 0.51, a + 0.65, y, y + 2.3, 0, 0.18, { all: 0.8, tile: RENDER.ROOF_TILE_M }),
            ...f.bx(a - 0.65, a + 0.65, y + 2.15, y + 2.3, 0, 0.18, { bottom: GR.AO_UNDERSIDE, tile: RENDER.ROOF_TILE_M }),
          );
          G.archPaint.push(
            ...f.paint(doorHex, a - 0.51, a + 0.51, y, y + 2.15, 0.01, 0.06, { all: 0.5 }),
            ...f.paint(PAINT.FRAME_DARK, a - 0.5, a + 0.5, y + 1.07, y + 1.09, 0.06, 0.065),
            ...f.paint(PAINT.STEEL_BRUSHED, a - 0.44, a + 0.44, y + 0.02, y + 0.26, 0.06, 0.07),
            ...f.paint(PAINT.STEEL_BRUSHED, a + 0.2, a + 0.42, y + 1.0, y + 1.06, 0.06, 0.1),
            ...f.paint(PAINT.STEEL_BRUSHED, a - 0.03, a + 0.03, y + 1.55, y + 1.6, 0.06, 0.08),
          );
          const wa = a + 1.55;
          if (wa + 0.6 < lv.a1 && !lv.doors.some((o) => Math.abs(o - wa) < 1.3)) {
            G.archPaint.push(...f.paint(0x0c0f13, wa - 0.55, wa + 0.55, y + 1.1, y + 2.2, 0.01, 0.03, { all: 0.6 }));
            G.steel.push(...f.bx(wa - 0.6, wa + 0.6, y + 1.05, y + 1.1, 0, 0.08), ...f.bx(wa - 0.6, wa + 0.6, y + 2.2, y + 2.25, 0, 0.08));
            for (let k = -4; k <= 4; k++) G.steel.push(...f.bx(wa + k * 0.12 - 0.012, wa + k * 0.12 + 0.012, y + 1.1, y + 2.2, 0.04, 0.07));
          }
          doorClearZones.push({ ...doorClearZone(f.ref, a), y });
          propSockets.push(...doorSockets(f.ref, { a, w: 1.02, h: 2.15 }, y, 'GALLERY', ['FLOOR_L', 'FLOOR_R', 'WALL_SIDE', 'WALL_HIGH'], b.index, doorId++, grng, galleryDoorFit(a, lv.a0, lv.a1)));
          galleryDoors++;
        }
        galleryLevels++;
      });
      // Corridor cap over the top level, outer columns every 4 m (ground → cap), zig-zag external stair.
      G.concrete.push(...f.bx(e0, e1, gp.capY - S, gp.capY, 0, D, { bottom: GR.AO_SOFFIT_GALLERY, tile: RENDER.ROOF_TILE_M }));
      f.coll(e0, e1, gp.capY - S, gp.capY, 0, D, b.index);
      // Outer columns stay clear of the landing gaps so the deck → stair step is unobstructed.
      for (let a = e0 + 0.12; a <= e1 - 0.1; a += GR.GALLERY_COLUMN_M) {
        if (gp.landings.some((l) => a + 0.12 > l.a0 - 0.05 && a - 0.12 < l.a1 + 0.05)) continue;
        G.concrete.push(...f.bx(a - 0.12, a + 0.12, 0, gp.capY - S, D - 0.26, D - 0.02, { ground: true, tile: RENDER.ROOF_TILE_M }));
        f.coll(a - 0.12, a + 0.12, 0, gp.capY - S, D - 0.26, D - 0.02, b.index);
        noDoorRange(fkey(b, ax, sg), a - 0.12, a + 0.12);
      }
      // Zig-zag external stair: flights + landings (steel grating, outer and end guard rails).
      for (const r of gp.ramps) ramp(f, ax, r.aLow, r.aHigh, r.yLow, r.yHigh, r.d0, r.d1);
      for (const ld of gp.landings) {
        G.steel.push(...f.bx(ld.a0, ld.a1, ld.y - 0.12, ld.y, ld.d0, ld.d1, { bottom: GR.AO_UNDERSIDE }));
        f.coll(ld.a0, ld.a1, ld.y - 0.25, ld.y, ld.d0, ld.d1, b.index);
        const ea = ld.endRail > 0 ? ld.a1 : ld.a0;
        const e0r = ld.endRail > 0 ? ea - 0.05 : ea;
        G.steel.push(...f.bx(ld.a0, ld.a1, ld.y + RH - 0.05, ld.y + RH, ld.d1 - 0.06, ld.d1), ...f.bx(e0r, e0r + 0.05, ld.y + RH - 0.05, ld.y + RH, ld.d0, ld.d1));
        for (let a = ld.a0 + 0.05; a <= ld.a1 - 0.04; a += GR.GALLERY_PICKET_M) G.steel.push(...f.bx(a - 0.015, a + 0.015, ld.y, ld.y + RH, ld.d1 - 0.05, ld.d1 - 0.02));
        for (let d = ld.d0 + 0.3; d < ld.d1 - 0.1; d += GR.GALLERY_PICKET_M) G.steel.push(...f.bx(e0r + 0.01, e0r + 0.04, ld.y, ld.y + RH, d - 0.015, d + 0.015));
        f.coll(ld.a0, ld.a1, ld.y, ld.y + RH, ld.d1 - 0.1, ld.d1, b.index);
        f.coll(ld.endRail > 0 ? ea - 0.1 : ea, ld.endRail > 0 ? ea : ea + 0.1, ld.y, ld.y + RH, ld.d0, ld.d1, b.index);
        if (ld.post) {
          const pa = ld.endRail > 0 ? ld.a1 - 0.14 : ld.a0;
          G.steel.push(...f.bx(pa, pa + 0.14, 0, ld.y - 0.12, ld.d1 - 0.14, ld.d1, { ground: true }));
          f.coll(pa, pa + 0.14, 0, ld.y - 0.12, ld.d1 - 0.14, ld.d1, b.index);
        } else {
          // Upper landings hang on two knee brackets back to the deck edge.
          for (const a of [ld.a0 + 0.2, ld.a1 - 0.2]) G.steel.push(beam(f.P3(a, ld.y - 0.95, ld.d0 + 0.02), f.P3(a, ld.y - 0.14, ld.d1 - 0.08), 0.045));
        }
      }
      if (gp.ramps.length === GR.GALLERY_LEVELS) galleriesLinked++;
      const stair = gp.ramps.find((r) => r.yLow === 0);
      const stairLanding = stair ? gp.landings.find((l) => l.post) : undefined;
      if (stair) blockRange(fkey(b, ax, sg), Math.min(stair.aLow, stair.aHigh) - 0.3, Math.max(stair.aLow, stair.aHigh, stairLanding ? stairLanding.a1 : -Infinity) + 0.3);
      facadeFeatures.push({ kind: 'GALLERY', building: b.index, center: f.P3(f0.c, gp.levels[0].y, D / 2), normal: new THREE.Vector3(f.nx, 0, f.nz), top: gp.levels[gp.levels.length - 1].y });
    };

    // ---------------------------------------------------------------- PENCIL_TOWER service spine
    const spine = (b: Building, ax: Axis, sg: number): void => {
      const f0 = faceFrame(b, ax, sg);
      const f = sf(ax, sg, f0.face);
      const W2 = GR.SPINE_W_M / 2;
      const SD = GR.SPINE_D_M;
      const a = f0.c + (grng() - 0.5) * Math.max(0, f0.len - GR.SPINE_W_M - 3) * 0.6;
      const top = b.roofY + 2.0;
      G.concrete.push(...f.bx(a - W2, a + W2, 0, top, 0, SD, { ground: true, tile: RENDER.ROOF_TILE_M }));
      f.coll(a - W2, a + W2, 0, top, 0, SD, b.index, 'BUILDING');
      G.concrete.push(...f.bx(a - W2 - 0.1, a + W2 + 0.1, top, top + 0.25, -0.1, SD + 0.1, { tile: RENDER.ROOF_TILE_M }));
      // Recessed vertical cable chase with two risers, floor-marker vents with a tiny cyan level light.
      G.steel.push(...f.bx(a - 0.32, a + 0.32, 0.4, top - 0.4, SD, SD + 0.015, { all: 0.4 }));
      for (const o of [-0.14, 0.14]) G.steel.push(aoPipe(f.P3(a + o, 0.4, SD + 0.06), f.P3(a + o, top - 0.4, SD + 0.06), 0.045, new THREE.Vector3(f.nx, 0, f.nz)));
      for (let n = 1; floorTopY(b.arch, n) < top - 1; n++) {
        const y = floorTopY(b.arch, n);
        G.steel.push(...f.bx(a - 1.05, a - 0.45, y - 0.7, y - 0.25, SD, SD + 0.05), ...f.bx(a + 0.45, a + 1.05, y - 0.7, y - 0.25, SD, SD + 0.05));
        if (n % 2 === 0) G.strips.push(f.glow(COLORS.WALLRUN_CYAN, 0.7, a + 1.1, a + 1.25, y - 0.55, y - 0.4, SD, SD + 0.02));
      }
      // 10A-2: dense stacked vertical neon blades strictly bound to a solid FaceSpan beside the spine, with brackets.
      const spineSpan = b.plan.faces.find((sp) => sp.ax === ax && sp.sg === sg && sp.lot);
      if (spineSpan) {
        const fs = sf(spineSpan.ax, spineSpan.sg, spineSpan.plane);
        for (let y = 6 + grng() * 2, k = 0; y < Math.min(spineSpan.y1 - 3.2, 44); y += 5.5 + grng() * 2.5, k++) {
          const side = k % 2 === 0 ? -1 : 1;
          const w = 1.2 + grng() * 0.8;
          const hgt = 3.2 + grng() * 1.6;
          const along = a + side * (W2 + 0.35);
          if (along < spineSpan.a0 + 0.3 || along > spineSpan.a1 - 0.3) continue;
          if (y - hgt / 2 < spineSpan.y0 + 0.4 || y + hgt / 2 > spineSpan.y1 - 0.4) continue;
          const p = fs.P3(along, y, w / 2 + 0.14);
          if (addNeon(p.x, p.y, p.z, ax === 'x' ? 0 : 1, ax === 'x' ? 1 : 0, w, hgt, Math.floor(grng() * 8), 0, { kind: 'BUILDING_BLADE', building: b.index }))
            for (const yy of [y + hgt / 2 - 0.18, y - hgt / 2 + 0.18]) G.steel.push(...fs.bx(along - 0.03, along + 0.03, yy - 0.03, yy + 0.03, 0, w + 0.14));
        }
      }
      blockRange(fkey(b, ax, sg), a - W2 - 0.3, a + W2 + 0.3);
      facadeFeatures.push({ kind: 'SPINE', building: b.index, center: f.P3(a, 0, SD), normal: new THREE.Vector3(f.nx, 0, f.nz), top });
      spineCount++;
    };


    // ---------------------------------------------------------------- 11A-1 enterable hollow interiors (+0 static)
    // Rooms are planned in two phases on their own RNG stream (layouts elsewhere stay put): GALLERY_DANCHI
    // apartments before the corridors are dressed, shops / arcades once the 1F programs are known. Each carved
    // massing box replaces its body + BUILDING collider IN PLACE with splitMassBox() pieces (dual split), and the
    // room shell / props / doors / glass are emitted into the existing buckets and pools.
    const irng = createRng(0x11a1 + sector.index * 71 + loop * 433);
    const iRing = !!plan.plaza && plan.highways.length === 4;
    const breachDoors: DoorSpec[] = [];
    const glassPanes: GlassSpec[] = [];
    const interiors: InteriorVolume[] = [];
    const interiorProps: InteriorPropRecord[] = [];
    const interiorPlans: InteriorPlan[] = [];
    const interiorOpenings: Array<InteriorOpening & { building: number; interior: number }> = [];
    const carvedBuildings = new Set<number>();
    /** Openings on exterior planes: key `${building}:${ax}:${sg}:${plane}` → along / height ranges. */
    const openingMap = new Map<string, Array<{ a0: number; a1: number; y0: number; y1: number; kind: string }>>();
    const planeKeyOf = (bi: number, ax: Axis, sg: number, plane: number): string => `${bi}:${ax}:${sg > 0 ? 1 : -1}:${plane.toFixed(3)}`;
    /** Openings of building `bi` on the face plane overlapping the along range [a0, a1] (and optionally y). */
    const openingsAt = (bi: number, ax: Axis, sg: number, plane: number, a0: number, a1: number, y0 = -1e9, y1 = 1e9, pad = 0.05) =>
      (openingMap.get(planeKeyOf(bi, ax, sg, plane)) ?? []).filter((o) => a0 < o.a1 + pad && a1 > o.a0 - pad && y0 < o.y1 && y1 > o.y0);
    const ikit = this.interiorKit;
    ikit.begin();
    const emitInterior = (ip: InteriorPlan): void => {
      const b = buildings[ip.building];
      const B = b.plan.boxes[ip.boxIndex];
      const slot = bodySlot[b.index][ip.boxIndex];
      interiorPlans.push(ip);
      carvedBuildings.add(b.index);
      // Dual split: tower body + BUILDING collider become the solid remainder around the hollow room.
      splitMassBox(B, ip.room).forEach((pc, k) => {
        const top = pc.y1 >= B.y1 - 1e-6 ? pc.y1 - 0.45 : pc.y1;
        const y0 = pc.y0 > 0 ? (pc.y0 <= B.y0 + 1e-6 ? pc.y0 - 0.05 : pc.y0) : 0;
        const geo = bodyBox(pc.x1 - pc.x0, top - y0, pc.z1 - pc.z0, (pc.x0 + pc.x1) / 2, (y0 + top) / 2, (pc.z0 + pc.z1) / 2, b.seed, b.arch);
        const col: BoxCollider = { min: new THREE.Vector3(pc.x0, pc.y0, pc.z0), max: new THREE.Vector3(pc.x1, pc.y1, pc.z1), kind: 'BUILDING', building: b.index };
        if (k === 0) {
          G.bodies[slot.body] = geo;
          colliders[slot.coll] = col;
        } else {
          G.bodies.push(geo);
          colliders.push(col);
        }
      });
      for (const a of ip.structure) colliders.push({ min: new THREE.Vector3(a.minX, a.minY, a.minZ), max: new THREE.Vector3(a.maxX, a.maxY, a.maxZ), kind: 'BUILDING', building: b.index });
      for (const a of ip.solids) colliders.push({ min: new THREE.Vector3(a.minX, a.minY, a.minZ), max: new THREE.Vector3(a.maxX, a.maxY, a.maxZ), kind: 'PROP', building: b.index });
      for (const pc of ip.shell) shellGeo(pc);
      for (const l of ip.lights) addLight(l.x, l.y, l.z, l.color, l.intensity);
      const doorIds: number[] = [];
      const glassIds: number[] = [];
      for (const op of ip.openings) {
        interiorOpenings.push({ ...op, building: b.index, interior: ip.id });
        const f = sf(op.ax, op.sg, op.plane);
        const key = planeKeyOf(b.index, op.ax, op.sg, op.plane);
        const list = openingMap.get(key) ?? [];
        list.push({ a0: op.a0, a1: op.a1, y0: op.y0, y1: op.y1, kind: op.kind });
        openingMap.set(key, list);
        const yaw = op.ax === 'x' ? (op.sg * Math.PI) / 2 : op.sg > 0 ? 0 : Math.PI;
        const am = (op.a0 + op.a1) / 2;
        if (op.kind === 'DOOR') {
          // Recessed in the wall reveal (d −0.10 … −0.02): never intrudes into the street clearance band.
          const ci = colliders.length;
          f.coll(op.a0, op.a1, op.y0, op.y1, -0.1, -0.02, b.index, 'DOOR');
          const c = f.P3(am, op.y0, -0.06);
          doorIds.push(breachDoors.length);
          breachDoors.push({ x: c.x, y: op.y0, z: c.z, yaw, width: op.a1 - op.a0, height: op.y1 - op.y0, colliderIndex: ci, interiorId: ip.id, tint: PAINT.DOORS[(ip.id * 3 + doorIds.length) % PAINT.DOORS.length], openRad: doorSafeOpenRad(0.2) });
        } else if (op.kind === 'WINDOW') {
          const ci = colliders.length;
          f.coll(op.a0, op.a1, op.y0, op.y1, -0.06, -0.02, b.index, 'GLASS');
          const c = f.P3(am, op.y0, -0.04);
          glassIds.push(glassPanes.length);
          glassPanes.push({ x: c.x, y: op.y0, z: c.z, yaw, width: op.a1 - op.a0, height: op.y1 - op.y0, colliderIndex: ci, interiorId: ip.id });
        }
        // Keep the doorway / arcade mouth clear of later street dressing, and every opening clear of signs.
        if (op.kind !== 'WINDOW') {
          const p0 = f.P3(op.a0 - 0.2, 0, 0);
          const p1 = f.P3(op.a1 + 0.2, 0, GR.DOOR_CLEAR_M);
          doorClearZones.push({ x0: Math.min(p0.x, p1.x), z0: Math.min(p0.z, p1.z), x1: Math.max(p0.x, p1.x), z1: Math.max(p0.z, p1.z), y: op.y0 });
        }
        const q0 = f.P3(op.a0 - 0.3, op.y0, -0.3);
        const q1 = f.P3(op.a1 + 0.3, op.y1 + 0.3, 1.4);
        signBoxes.push({ x0: Math.min(q0.x, q1.x), y0: op.y0, z0: Math.min(q0.z, q1.z), x1: Math.max(q0.x, q1.x), y1: op.y1 + 0.3, z1: Math.max(q0.z, q1.z), group: -77 });
      }
      interiors.push(interiorVolumeOf(ip, doorIds, glassIds));
      for (const pr of ip.props) {
        const idx = ikit.add(pr.variant, pr.x, pr.y, pr.z, pr.yaw, pr.tint);
        if (idx >= 0) interiorProps.push(interiorPropRecord(idx, pr.variant, pr.x, pr.y, pr.z, pr.yaw, pr.tint, ip.floorY));
      }
    };
    /** Ground FaceSpans of a building as interior host faces (feature / signature faces are never opened). */
    const hostFaces = (b: Building, programOf: (span: FaceSpan, key: string, alley: boolean) => GroundProgram | null): InteriorHostFace[] => {
      const out: InteriorHostFace[] = [];
      b.plan.faces.forEach((span, id) => {
        if (span.y0 > 0.01 || span.a1 - span.a0 < 3) return;
        const key = fkey(b, span.ax, span.sg);
        // Escape flights, ducts, docks and spines are passed on as `blocked` along-ranges; balconies start at 6 m;
        // only a Mega-Billboard reaching below 4.5 m closes the face.
        if (megaRects.some((m) => m.b === b.index && m.ax === span.ax && m.sg === span.sg && m.y0 < 4.5)) return;
        const alley = span.lot && alleyFaces.has(key);
        const program = programOf(span, key, alley);
        if (!program) return;
        out.push({ id, ax: span.ax, sg: span.sg, plane: span.plane, a0: span.a0, a1: span.a1, y1: span.y1, program, alley, run: span.lot && runFaces.has(key), clear: alley ? alleyWidth.get(key) ?? 3 : span.court ? 3 : 6, blocked: blockedRanges.get(key) ?? [] });
      });
      return out;
    };
    const runKeysOf = (b: Building): Set<string> => new Set(FACES.filter(([ax, sg]) => runFaces.has(fkey(b, ax, sg))).map(([ax, sg]) => faceKeyOf(ax, sg)));
    // Phase 1: GALLERY_DANCHI apartments at the real 2F / 3F deck elevations.
    {
      const hosts: InteriorHost[] = [];
      for (const b of buildings) {
        if (b.massing !== 'GALLERY_DANCHI' || megaBuilding.has(b.index) || notched.has(b.index)) continue;
        const gk = FACES.find(([ax, sg]) => galleryFaces.has(fkey(b, ax, sg)));
        if (!gk) continue;
        const f0 = faceFrame(b, gk[0], gk[1]);
        const gp = planGallery(b.arch, f0.a0, f0.a1);
        const deckYs = gp.levels.map((lv) => lv.y).filter((y) => y > 2 && y < 12).slice(0, 2);
        if (!deckYs.length) continue;
        hosts.push({
          building: b.index,
          massing: b.massing,
          arch: b.arch,
          boxes: b.plan.boxes,
          lot: b.rect,
          faces: hostFaces(b, (_sp, _k, alley) => (alley ? 'ALLEY_INFRA' : 'CYBER_APARTMENT')),
          gallery: { faceKey: faceKeyOf(gk[0], gk[1]), deckYs, depth: GR.GALLERY_DEPTH_M, a0: f0.a0, a1: f0.a1 },
          runKeys: runKeysOf(b),
        });
      }
      for (const ip of planInteriors(hosts, sector.index, irng, { halfExtent: H, isRing: iRing, templates: ['APARTMENT'], idBase: 0 })) emitInterior(ip);
    }

    buildings.forEach((b) => {
      for (const [ax, sg] of FACES) {
        if (galleryFaces.has(fkey(b, ax, sg))) gallery(b, ax, sg);
        if (spineFaces.has(fkey(b, ax, sg))) spine(b, ax, sg);
      }
    });

    // ---------------------------------------------------------------- 9A-4 ground-floor programs
    type GroundFace = { b: Building; span: FaceSpan; key: string; alley: boolean; run: boolean };
    const groundFaces: GroundFace[] = [];
    buildings.forEach((b) => {
      for (const span of b.plan.faces) {
        if (span.y0 > 0.01 || span.a1 - span.a0 < 3) continue;
        const key = fkey(b, span.ax, span.sg);
        const alley = span.lot && alleyFaces.has(key);
        const run = span.lot && runFaces.has(key);
        groundFaces.push({ b, span, key, alley, run });
      }
    });
    const programs = assignPrograms(
      groundFaces.map((g, i) => ({ id: i, arch: g.b.arch, alley: g.alley, massing: g.b.massing, len: g.span.a1 - g.span.a0 })),
      grng,
    );
    // 11A-1 phase 2: eateries, tech shops and pass-through arcades on the assigned 1F programs.
    {
      const progOf = new Map<FaceSpan, GroundProgram>();
      groundFaces.forEach((g, i) => progOf.set(g.span, programs[i]));
      const hosts: InteriorHost[] = [];
      for (const b of buildings) {
        // GALLERY_DANCHI 1F faces carry the corridor columns / stair: only the 2F–3F apartments are carved there.
        if (megaBuilding.has(b.index) || carvedBuildings.has(b.index) || notched.has(b.index) || isMegaKind(b.massing) || b.massing === 'GALLERY_DANCHI') continue;
        const faces = hostFaces(b, (span) => progOf.get(span) ?? null);
        if (!faces.length) continue;
        hosts.push({ building: b.index, massing: b.massing, arch: b.arch, boxes: b.plan.boxes, lot: b.rect, faces, runKeys: runKeysOf(b) });
      }
      const n1 = interiorPlans.length;
      const target = iRing ? { min: Math.max(0, 4 - n1), max: Math.max(0, 6 - n1) } : { min: Math.max(0, 6 - n1), max: Math.max(0, 10 - n1) };
      for (const ip of planInteriors(hosts, sector.index, irng, { halfExtent: H, isRing: iRing, templates: ['EATERY', 'TECH_SHOP', 'PASS_ARCADE'], target, idBase: n1 })) emitInterior(ip);
    }
    ikit.end();
    interiors.slice(0, INDOOR_MAX).forEach((iv, i) => {
      this.uIndoor.value[i * 2].set(iv.aabb.minX - 0.35, iv.aabb.minY - 0.3, iv.aabb.minZ - 0.35);
      this.uIndoor.value[i * 2 + 1].set(iv.aabb.maxX + 0.35, iv.aabb.maxY + 0.3, iv.aabb.maxZ + 0.35);
    });
    this.uIndoorN.value = Math.min(interiors.length, INDOOR_MAX);
    const NEON_SHOP = [0x38d8f0, 0xe048b8];
    const groundFace = (g: GroundFace, program: GroundProgram): { piers: number[] } => {
      const { b, span, run } = g;
      const f = sf(span.ax, span.sg, span.plane);
      // 10B-2: an outward perimeter face closer than the 1.8 m door clear zone to the lockdown wall's inner face
      // (±(H − 0.5)) has no street in front of it — no doorway opens into the 0.7 m crack.
      const toWall = span.sg * span.plane > 0 ? LEVEL.HALF_EXTENT_M - 0.5 - Math.abs(span.plane) : Infinity;
      // 11A-1: grammar doors never land in a carved doorway / shopfront / arcade opening.
      const carved = openingsAt(b.index, span.ax, span.sg, span.plane, span.a0, span.a1, 0, 4.2).map((o): [number, number] => [o.a0 - 0.3, o.a1 + 0.3]);
      const plan = planGroundFace(program, span.a0, span.a1, grng, span.lot ? blockedRanges.get(g.key) ?? [] : [], toWall >= GR.DOOR_CLEAR_M, [...(noDoorRanges.get(g.key) ?? []), ...carved]);
      const cut = (a0: number, a1: number): boolean => carved.length > 0 && openingsAt(b.index, span.ax, span.sg, span.plane, a0, a1, 0, 4.2, 0.02).length > 0;
      programCounts[program]++;
      const gTop = Math.min(span.y1, floorTopY(b.arch, 1));
      const sTop = Math.min(gTop, GR.GROUND_TOP_M);
      const PD = run ? GR.PIER_D_RUN_M : GR.PIER_D_M;
      const T = RENDER.ROOF_TILE_M;
      const feature = !run && !g.alley;
      // Shared grammar: weathered stone piers every ~4 m with dark steel kick plates.
      for (const a of plan.piers) {
        if (cut(a - GR.PIER_W_M / 2, a + GR.PIER_W_M / 2)) continue;
        if ((g.alley || program === 'ALLEY_INFRA') && gTop > 3.4) {
          decalSurfaces.push({ kind: 'PIER', nAx: span.ax, sg: span.sg, plane: span.plane + span.sg * (run ? GR.PIER_D_RUN_M : GR.PIER_D_M), a0: a - 0.2, a1: a + 0.2, y0: 0.7, y1: Math.min(3.3, gTop - 0.5), seed: p9Rng() });
        }
        G.concrete.push(...f.bx(a - GR.PIER_W_M / 2, a + GR.PIER_W_M / 2, 0, gTop, 0, PD, { ground: true, tile: T }));
        G.steel.push(...f.bx(a - GR.PIER_W_M / 2 - 0.02, a + GR.PIER_W_M / 2 + 0.02, 0, GR.KICK_H_M, 0, PD + 0.03, { ground: true }));
        groundPiers.push({ building: b.index, ax: span.ax, sg: span.sg, plane: span.plane, a0: a - GR.PIER_W_M / 2, a1: a + GR.PIER_W_M / 2, top: gTop });
        pierCount++;
      }
      // Lintel band over the storefronts (Type B adds a 2 m mezzanine fascia above it).
      G.concrete.push(...f.bx(span.a0 + 0.2, span.a1 - 0.2, sTop - 0.4, sTop, 0, Math.min(PD, 0.22), { bottom: GR.AO_UNDERSIDE, tile: T }));
      if (gTop > sTop + 1) G.concrete.push(...f.bx(span.a0 + 0.2, span.a1 - 0.2, gTop - 0.35, gTop - 0.1, 0, 0.12, { bottom: GR.AO_BAND_UNDERSIDE, tile: T }));
      const oT = sTop - 0.42;
      const tint = (k: number): number => NEON_SHOP[(Math.floor(b.seed * 31) + k) % 2];
      // 9B socket space: sidewalk faces keep a ≥ 2 m walk; alley faces stop short of the 2.6 m clear centre path;
      // gallery faces stay inside the corridor's outer columns; wall-run faces only take low props.
      const sockGroup = PROGRAM_SOCKETS[program].group;
      const service = serviceFaces.has(g.key);
      const lowProps = (run || g.alley) && !service;
      const alleyHalf = g.alley ? ((alleyWidth.get(g.key) ?? 4) - PROPS.ALLEY_CLEAR_M) / 2 - 0.05 : Infinity;
      const floorReach = Math.min(alleyHalf, galleryFaces.has(g.key) ? 1.1 : run ? 0.75 : 1.55);
      for (const bay of plan.bays) {
        const { a0, a1 } = bay;
        const m = (a0 + a1) / 2;
        // 11A-1: bays opened by a carved interior keep no solid fill, socket props or decals.
        if (cut(a0, a1)) continue;
        groundBays.push({ building: b.index, ax: span.ax, sg: span.sg, plane: span.plane, a0, a1, use: bay.use, oT });
        if (!service && (bay.use === 'PANEL' || bay.use === 'VITRINE' || bay.use === 'SHUTTER' || bay.use === 'GRILLE')) {
          const bs = baySocket(f.ref, a0 + 0.45, a1 - 0.45, 0.36, floorReach - 0.36, 0, sockGroup, b.index, lowProps, p9Rng);
          if (bs) propSockets.push(bs);
        }
        if (bay.use === 'SHUTTER') decalSurfaces.push({ kind: 'SHUTTER', nAx: span.ax, sg: span.sg, plane: span.plane + span.sg * 0.075, a0: a0 + 0.1, a1: a1 - 0.1, y0: 0.35, y1: oT - 0.4, seed: p9Rng() });
        switch (bay.use) {
          case 'PANEL':
            if (program === 'CAPSULE_HOTEL') {
              G.concrete.push(...f.bx(a0, a1, 0, oT, 0.02, 0.1, { ground: true, all: 0.85, tile: T }));
              for (let a = a0 + 0.25; a < a1 - 0.1; a += 0.3) G.concrete.push(...f.bx(a - 0.04, a + 0.04, 0.3, oT - 0.1, 0.1, 0.14, { ground: true, tile: T }));
              G.strips.push(f.glow(0xffb45a, 0.55, m - 0.04, m + 0.04, 0.6, oT - 0.3, 0.14, 0.16));
            } else {
              // 10A-2 Eatery: timber / slate panelling + calm frosted ribbed glass (emissive 0.24) with recessed dark mullions.
              G.archPaint.push(...f.paint(PAINT.TIMBER, a0, a1, 0, 0.92, 0.02, 0.1, { ground: true }), ...f.paint(PAINT.SLATE, a0, a1, oT - 0.4, oT, 0.02, 0.1));
              G.strips.push(f.glow(0xff9b42, 0.24, a0 + 0.12, a1 - 0.12, 0.98, oT - 0.46, 0.03, 0.05));
              for (let y = 1.12; y < oT - 0.5; y += 0.28) G.archPaint.push(...f.paint(0x121010, a0 + 0.1, a1 - 0.1, y, y + 0.032, 0.05, 0.1));
              for (let k = 1; k < 4; k++) {
                const a = a0 + ((a1 - a0) * k) / 4;
                G.archPaint.push(...f.paint(0x0f1115, a - 0.035, a + 0.035, 0.96, oT - 0.44, 0.05, 0.11));
              }
            }
            break;
          case 'VITRINE': {
            // 10A-2 Matte black frame, deep backlit display niches (emissive 0.24) with recessed dark mullions, ribbed shutter.
            G.archPaint.push(...f.paint(PAINT.BLACK_ALU, a0, a1, 0, 0.42, 0.02, 0.14, { ground: true }), ...f.paint(PAINT.BLACK_ALU, a0, a0 + 0.1, 0.42, oT, 0.02, 0.14), ...f.paint(PAINT.BLACK_ALU, a1 - 0.1, a1, 0.42, oT, 0.02, 0.14));
            const shutterY = 0.42 + (oT - 0.42) * 0.62;
            G.strips.push(f.glow(tint(Math.floor(m)), 0.24, a0 + 0.12, a1 - 0.12, 0.45, shutterY, 0.02, 0.04));
            for (let k = 1; k < 4; k++) {
              const a = a0 + ((a1 - a0) * k) / 4;
              G.archPaint.push(...f.paint(0x080a0e, a - 0.055, a + 0.055, 0.45, shutterY, 0.04, 0.11));
            }
            const midV = 0.45 + (shutterY - 0.45) * 0.5;
            G.archPaint.push(...f.paint(0x080a0e, a0 + 0.1, a1 - 0.1, midV - 0.03, midV + 0.03, 0.04, 0.1));
            G.archPaint.push(...f.paint(PAINT.SHUTTER[0], a0 + 0.1, a1 - 0.1, shutterY, oT, 0.04, 0.08, { all: 0.85 }));
            for (let y = shutterY + 0.06; y < oT; y += 0.11) G.archPaint.push(...f.paint(0x1d2025, a0 + 0.1, a1 - 0.1, y, y + 0.02, 0.08, 0.095));
            break;
          }
          case 'SHUTTER': {
            const sh = PAINT.SHUTTER[Math.floor(b.seed * 13 + m) % PAINT.SHUTTER.length];
            G.archPaint.push(...f.paint(sh, a0 + 0.05, a1 - 0.05, 0.12, oT - 0.3, 0.02, 0.06, { ground: true, all: 0.9 }));
            for (let y = 0.2; y < oT - 0.3; y += 0.1) G.archPaint.push(...f.paint(0x15171a, a0 + 0.05, a1 - 0.05, y, y + 0.018, 0.06, 0.075));
            G.steel.push(...f.bx(a0, a1, oT - 0.3, oT, 0.02, 0.2, { bottom: GR.AO_UNDERSIDE }));
            G.concrete.push(...f.bx(a0, a1, 0, 0.16, 0, run ? 0.2 : 0.32, { ground: true, tile: T }));
            if (feature) {
              for (const a of [a0 + 0.25, a1 - 0.25]) {
                G.archPaint.push(...f.paint(PAINT.HAZARD_Y, a - 0.09, a + 0.09, 0, 0.95, 0.42, 0.6, { ground: true }));
                for (const y of [0.3, 0.62]) G.archPaint.push(...f.paint(PAINT.HAZARD_K, a - 0.095, a + 0.095, y, y + 0.12, 0.415, 0.605));
              }
            }
            break;
          }
          case 'GRILLE':
            G.archPaint.push(...f.paint(PAINT.FRAME_DARK, a0 + 0.1, a1 - 0.1, 0.5, oT - 0.2, 0.02, 0.06, { all: 0.8 }));
            for (let y = 0.58; y < oT - 0.25; y += 0.14) G.steel.push(...f.bx(a0 + 0.12, a1 - 0.12, y, y + 0.03, 0.06, 0.12));
            G.archPaint.push(...f.paint(PAINT.SLATE, a0, a1, 0, 0.5, 0.02, 0.1, { ground: true }));
            break;
          case 'MAILBOX': {
            // Brushed-steel mailbox bank, glowing intercom, utility meter cabinet.
            const mx = m - 0.3;
            G.archPaint.push(...f.paint(PAINT.MAILBOX, mx - 0.6, mx + 0.6, 1.0, 1.85, 0.02, 0.16));
            for (let k = 1; k < 4; k++) G.archPaint.push(...f.paint(0x23262b, mx - 0.6 + k * 0.3 - 0.01, mx - 0.6 + k * 0.3 + 0.01, 1.0, 1.85, 0.16, 0.17));
            for (const y of [1.28, 1.57]) G.archPaint.push(...f.paint(0x23262b, mx - 0.6, mx + 0.6, y - 0.01, y + 0.01, 0.16, 0.17));
            G.strips.push(f.glow(0x6fb4ff, 0.8, m + 0.55, m + 0.72, 1.25, 1.5, 0.02, 0.05));
            G.archPaint.push(...f.paint(0x4b5158, m + 0.45, m + 1.05, 0.4, 1.0, 0.02, 0.22, { ground: true }));
            G.archPaint.push(...f.paint(PAINT.SLATE, a0, a1, 0, 0.3, 0.02, 0.08, { ground: true }));
            break;
          }
          case 'BLOCKED':
            G.archPaint.push(...f.paint(PAINT.SLATE, a0, a1, 0, oT, 0.01, 0.04, { ground: true, all: 0.9 }));
            break;
          default:
            break;
        }
      }
      // Doors: human-scale, recessed inside bevelled surrounds; clear entry zone + sockets.
      const sockets = PROGRAM_SOCKETS[program];
      for (const door of plan.doors) {
        const { a, w, h, half } = door;
        const r = run ? Math.min(door.recess, GR.PIER_D_RUN_M) : door.recess;
        // 10B-2: optional assembly parts are built only when they fit inside `half` (clear of the bay's piers).
        const fits = (outer: number): boolean => outer <= half + 1e-6;
        let reach = w / 2 + DOOR_SURROUND_M;
        let top = h + 0.2;
        const hx = PAINT.DOORS[(Math.floor(b.seed * 53) + doorId) % PAINT.DOORS.length];
        const leaf = program === 'CYBER_APARTMENT' || program === 'ALLEY_INFRA' ? hx : program === 'CYBER_EATERY' ? 0x5a6068 : PAINT.STEEL_BRUSHED;
        // Surround (jambs + lintel), threshold step.
        G.concrete.push(
          ...f.bx(a - w / 2 - 0.2, a - w / 2, 0, h + 0.2, 0, r, { ground: true, all: 0.75, tile: T }),
          ...f.bx(a + w / 2, a + w / 2 + 0.2, 0, h + 0.2, 0, r, { ground: true, all: 0.75, tile: T }),
          ...f.bx(a - w / 2 - 0.2, a + w / 2 + 0.2, h, h + 0.2, 0, r, { bottom: GR.AO_UNDERSIDE, tile: T }),
          ...f.bx(a - w / 2, a + w / 2, 0, 0.08, 0, r, { all: 0.8, tile: T }),
        );
        // Leaf (recess back: dark AO), seams, kick plate, handle.
        G.archPaint.push(...f.paint(leaf, a - w / 2, a + w / 2, 0.08, h, 0.01, 0.06, { all: GR.AO_RECESS + 0.08 }));
        if (door.double) G.archPaint.push(...f.paint(0x0b0c0e, a - 0.012, a + 0.012, 0.08, h, 0.06, 0.065));
        G.archPaint.push(...f.paint(PAINT.FRAME_DARK, a - w / 2, a + w / 2, h * 0.52, h * 0.52 + 0.02, 0.06, 0.065), ...f.paint(PAINT.STEEL_BRUSHED, a - w / 2 + 0.05, a + w / 2 - 0.05, 0.1, 0.32, 0.06, 0.07));
        G.archPaint.push(...f.paint(PAINT.STEEL_BRUSHED, a + w / 2 - 0.3, a + w / 2 - 0.08, 0.98, 1.04, 0.06, 0.11));
        if (program === 'TECH_APPAREL' && fits(w / 2 + 0.38)) {
          G.strips.push(f.glow(0x58f0ff, 0.9, a + w / 2 + 0.25, a + w / 2 + 0.38, 1.2, 1.42, 0.01, 0.04));
          reach = Math.max(reach, w / 2 + 0.38);
        }
        if (program === 'ALLEY_INFRA') {
          G.strips.push(f.glow(0xffb34a, 0.95, a - 0.12, a + 0.12, h + 0.32, h + 0.5, 0.05, 0.17));
          G.steel.push(...f.bx(a - 0.16, a + 0.16, h + 0.28, h + 0.3, 0, 0.22), ...f.bx(a - 0.16, a + 0.16, h + 0.52, h + 0.54, 0, 0.22));
          top = h + 0.54;
        }
        doorSizes.push([w, h]);
        doorClearZones.push({ ...doorClearZone(f.ref, a), y: 0 });
        const dBay = plan.bays.find((bb) => a > bb.a0 && a < bb.a1);
        const fit = groundDoorFit(program, door, dBay, floorReach, lowProps, run);
        propSockets.push(...doorSockets(f.ref, { a, w, h }, 0, sockets.group, sockets.slots, b.index, doorId++, grng, fit));
        // Program portals in front of the door.
        if (program === 'CAPSULE_HOTEL' && fits(w / 2 + 0.47)) {
          const dp = run ? GR.PIER_D_RUN_M : 0.8;
          for (const s of [-1, 1]) {
            const ai = a + s * (w / 2 + 0.36);
            G.concrete.push(...f.bx(ai - 0.11, ai + 0.11, 0, sTop - 0.4, 0, dp, { ground: true, tile: T }));
            G.strips.push(f.glow(0xffb45a, 0.7, ai - 0.02, ai + 0.02, 0.4, sTop - 0.7, dp, dp + 0.015));
          }
          reach = Math.max(reach, w / 2 + 0.47);
          top = Math.max(top, sTop - 0.4);
        } else if (program === 'CYBER_APARTMENT' && fits(w / 2 + 0.4)) {
          const dp = run ? GR.PIER_D_RUN_M : 0.68;
          for (const s of [-1, 1]) G.concrete.push(...f.bx(a + s * (w / 2 + 0.3) - 0.1, a + s * (w / 2 + 0.3) + 0.1, 0, 2.85, 0, dp, { ground: true, tile: T }));
          reach = Math.max(reach, w / 2 + 0.4);
          top = Math.max(top, 2.85);
        }
        if (program === 'CYBER_APARTMENT' && feature && door === plan.doors[0]) {
          // Entry canopy (built below with the feature fittings) is clamped to the assembly half-width.
          reach = Math.max(reach, half);
          top = Math.max(top, 3.05);
        }
        const bayR = dBay ?? { a0: a - half - DOOR_PIER_GAP_M, a1: a + half + DOOR_PIER_GAP_M };
        groundDoors.push({
          building: b.index, ax: span.ax, sg: span.sg, plane: span.plane, program, a, w, h,
          e0: a - reach, e1: a + reach, top,
          span: { a0: span.a0, a1: span.a1, y0: span.y0, y1: span.y1 },
          bay: { a0: bayR.a0, a1: bayR.a1 },
        });
      }
      // Canopies / awnings / exhaust (feature faces only — run faces stay ≤ 0.28 m relief).
      const ca0 = span.a0 + 0.4;
      const ca1 = span.a1 - 0.4;
      const door0 = plan.doors[0];
      if (feature && ca1 - ca0 > 2) {
        if (program === 'CYBER_EATERY') {
          const aw = PAINT.AWNINGS[Math.floor(b.seed * 7 + span.a0) % PAINT.AWNINGS.length];
          G.archPaint.push(withTint(f.slant(ca0, ca1, 3.55, 3.15, 0, 1.35, 0.06), aw));
          for (let a = ca0 + 0.1; a < ca1; a += 0.32) G.archPaint.push(withTint(f.slant(a - 0.03, a + 0.03, 3.6, 3.2, 0, 1.33, 0.05), 0x1a1a1d));
          G.strips.push(f.glow(0xffc884, 0.95, ca0 + 0.2, ca1 - 0.2, 3.12, 3.15, 1.05, 1.15));
          G.strips.push(f.glow(0xffa848, 0.75, ca0 + 0.3, ca1 - 0.3, 3.66, 3.95, 0.02, 0.1));
          f.coll(ca0, ca1, 3.12, 3.22, 0, 1.35, b.index);
          addDripEdge(f, ca0, ca1, 1.35, 3.15);
          // 11A-1b: 45° steel tension tie-rods from the awning lip back up into the facade.
          for (const ta of [ca0 + 0.35, ca1 - 0.35]) G.steel.push(aoPipe(f.P3(ta, 3.2, 1.28), f.P3(ta, 4.46, 0.02), 0.032, null));
          const lp = f.P3((ca0 + ca1) / 2, 2.8, 1.0);
          addLight(lp.x, lp.y, lp.z, 0xffa860, 1.3);
          // 10B-2: counter shelf centred in the bay right of the entrance (never across a pier); skipped when that
          // bay is a door / too narrow for the 1.8 m shelf + 0.05 m pier gap.
          const di = door0 ? plan.bays.findIndex((bb) => door0.a > bb.a0 && door0.a < bb.a1) : -1;
          const shelfBay = [plan.bays[di + 1], plan.bays[di - 1]].find((bb) => di >= 0 && bb && bb.use === 'PANEL' && bb.a1 - bb.a0 >= 1.8 + 2 * DOOR_PIER_GAP_M && !cut(bb.a0, bb.a1));
          if (shelfBay) {
            const sa = (shelfBay.a0 + shelfBay.a1) / 2;
            G.steel.push(...f.bx(sa - 0.9, sa + 0.9, 1.03, 1.08, 0, 0.35), ...f.bx(sa - 0.85, sa - 0.8, 0.7, 1.03, 0, 0.3), ...f.bx(sa + 0.8, sa + 0.85, 0.7, 1.03, 0, 0.3));
            const c0 = f.P3(sa - 0.92, 0, 0);
            const c1 = f.P3(sa + 0.92, 0, 0.37);
            propObstacles.push({ minX: Math.min(c0.x, c1.x), minY: 0.72, minZ: Math.min(c0.z, c1.z), maxX: Math.max(c0.x, c1.x), maxY: 1.08, maxZ: Math.max(c0.z, c1.z) });
          }
          // Stainless exhaust hood + grease duct climbing the wall; its mouth breathes steam.
          const top = Math.min(span.y1 - 1.0, 12 + grng() * 8);
          const da = plan.piers[plan.piers.length > 2 ? 1 : 0] + 0.6;
          if (top > 6 && da + 0.4 < span.a1) {
            G.steel.push(...f.bx(da - 0.28, da + 0.28, 3.7, top, 0, 0.45, { all: 0.92 }));
            for (let y = 4.5; y < top - 0.3; y += 3) G.steel.push(...f.bx(da - 0.33, da + 0.33, y, y + 0.08, 0, 0.5));
            G.steel.push(...f.bx(da - 0.4, da + 0.4, top, top + 0.22, -0.05, 0.6, { bottom: GR.AO_UNDERSIDE }));
            G.steel.push(...f.bx(da - 0.55, da + 0.55, 3.62, 3.95, 0, 0.62, { bottom: GR.AO_UNDERSIDE }));
            eateryVents.push(f.P3(da, top + 0.35, 0.3));
          }
        } else if (program === 'TECH_APPAREL') {
          G.steel.push(...f.bx(ca0, ca1, 3.29, 3.41, 0, 1.45, { bottom: GR.AO_UNDERSIDE }));
          G.strips.push(f.glow(tint(0), 1.35, ca0, ca1, 3.29, 3.33, 1.43, 1.47), f.glow(0xe8f4ff, 0.85, ca0 + 0.3, ca1 - 0.3, 3.26, 3.29, 0.3, 0.36));
          f.coll(ca0, ca1, 3.29, 3.41, 0, 1.45, b.index);
          for (const ta of [ca0 + 0.35, ca1 - 0.35]) G.steel.push(aoPipe(f.P3(ta, 3.41, 1.38), f.P3(ta, 4.77, 0.02), 0.032, null));
          addDripEdge(f, ca0, ca1, 1.45, 3.29);
          const ba = Math.min(span.a1 - 0.3, Math.max(span.a0 + 0.3, ca1 - 0.6));
          const maxH = span.y1 - 0.4 - Math.max(span.y0 + 0.4, 3.9);
          if (maxH >= 1.8 && span.a1 - span.a0 >= 0.8) {
            const hgt = Math.min(3.4, maxH);
            const yLo = Math.max(span.y0 + 0.4, 3.9) + hgt / 2;
            const yHi = span.y1 - 0.4 - hgt / 2;
            const y = Math.min(yHi, Math.max(yLo, 5.6 + grng()));
            const w = 1.2;
            const sp = f.P3(ba, y, w / 2 + 0.14);
            if (addNeon(sp.x, sp.y, sp.z, span.ax === 'x' ? 0 : 1, span.ax === 'x' ? 1 : 0, w, hgt, Math.floor(grng() * 8), 0, { kind: 'BUILDING_BLADE', building: b.index }))
              for (const yy of [y + hgt / 2 - 0.16, y - hgt / 2 + 0.16]) G.steel.push(...f.bx(ba - 0.03, ba + 0.03, yy - 0.03, yy + 0.03, 0, w + 0.14));
          }
        } else if (program === 'CAPSULE_HOTEL' && door0) {
          const half = Math.min((ca1 - ca0) / 2, 3 + grng());
          const ma = Math.min(ca1 - half, Math.max(ca0 + half, door0.a));
          G.steel.push(...f.bx(ma - half, ma + half, 3.47, 3.63, 0, 1.9, { bottom: GR.AO_UNDERSIDE }));
          G.strips.push(f.glow(0xffb040, 1.3, ma - half, ma + half, 3.47, 3.52, 1.88, 1.92), f.glow(0xff2a50, 1.2, ma - half, ma + half, 3.58, 3.63, 1.88, 1.92));
          for (let a = ma - half + 0.6; a < ma + half - 0.4; a += 1.2) G.strips.push(f.glow(0xfff0d8, 0.6, a - 0.35, a + 0.35, 3.44, 3.47, 0.6, 1.5));
          f.coll(ma - half, ma + half, 3.47, 3.63, 0, 1.9, b.index);
          const banW = Math.min(2 * half - 0.4, 6, span.a1 - span.a0 - 0.6);
          if (banW >= 1.2 && 4.25 - 0.35 >= span.y0 + 0.4 && 4.25 + 0.35 <= span.y1 - 0.4) {
            const bAlong = Math.min(span.a1 - 0.3 - banW / 2, Math.max(span.a0 + 0.3 + banW / 2, ma));
            const tp = f.P3(bAlong, 4.25, 0.12);
            addNeon(tp.x, tp.y, tp.z, f.nx, f.nz, banW, 0.7, 6 + Math.floor(grng() * 2), 1, { kind: 'BUILDING_FLAT', building: b.index });
          }
          const maxMh = span.y1 - 0.4 - Math.max(span.y0 + 0.4, 4.4);
          if (maxMh >= 2.2 && span.a1 - span.a0 >= 0.8) {
            const mh = Math.min(8 + grng() * 8, maxMh);
            const vAlong = Math.min(span.a1 - 0.3, Math.max(span.a0 + 0.3, ma + half - 0.3));
            const vy = Math.min(span.y1 - 0.4 - mh / 2, Math.max(span.y0 + 0.4 + mh / 2, 4.4 + mh / 2));
            const w = 1.4;
            const vp = f.P3(vAlong, vy, w / 2 + 0.14);
            if (addNeon(vp.x, vp.y, vp.z, span.ax === 'x' ? 0 : 1, span.ax === 'x' ? 1 : 0, w, mh, Math.floor(grng() * 8), 0, { kind: 'BUILDING_BLADE', building: b.index }))
              for (const yy of [vy + mh / 2 - 0.2, vy - mh / 2 + 0.2]) G.steel.push(...f.bx(vAlong - 0.035, vAlong + 0.035, yy - 0.035, yy + 0.035, 0, w + 0.14));
          }
          const lp = f.P3(ma, 2.8, 1.2);
          addLight(lp.x, lp.y, lp.z, 0xffc070, 1.0);
        } else if (program === 'CYBER_APARTMENT' && door0) {
          const ea0 = door0.a - door0.half;
          const ea1 = door0.a + door0.half;
          G.concrete.push(...f.bx(ea0, ea1, 2.85, 3.05, 0, 1.15, { bottom: GR.AO_UNDERSIDE, tile: T }));
          G.strips.push(f.glow(0xdcecff, 0.85, door0.a - 0.55, door0.a + 0.55, 2.79, 2.83, 0.55, 0.6));
          G.steel.push(...f.bx(door0.a - 0.6, door0.a + 0.6, 2.77, 2.78, 0.5, 0.66));
          f.coll(ea0, ea1, 2.85, 3.05, 0, 1.15, b.index);
          const lp = f.P3(door0.a, 2.4, 0.8);
          addLight(lp.x, lp.y, lp.z, 0xdcecff, 1.0);
        } else if (program === 'ALLEY_INFRA') {
          // Wall-mounted high-voltage transformer box with heat-sink fins and status LEDs.
          const sb = plan.bays.find((bb) => bb.use === 'SHUTTER');
          if (sb) {
            const m = (sb.a0 + sb.a1) / 2;
            G.steel.push(...f.bx(m - 0.5, m + 0.5, 1.2, 2.6, 0.06, 0.5));
            fixtureBox(f, m - 0.5, m + 0.5, 1.2, 2.6, 0, 0.58);
            for (let k = 0; k < 6; k++) G.steel.push(...f.bx(m - 0.45 + k * 0.18 - 0.02, m - 0.45 + k * 0.18 + 0.02, 1.3, 2.5, 0.5, 0.58));
            G.strips.push(f.glow(0xff3030, 1.3, m + 0.3, m + 0.36, 2.42, 2.48, 0.5, 0.52), f.glow(0xffb020, 1.2, m + 0.18, m + 0.24, 2.42, 2.48, 0.5, 0.52));
          }
        }
      } else if (program === 'CYBER_EATERY' || program === 'TECH_APPAREL') {
        // Flat run-face variant: a lit fascia box only (≤ 0.12 m relief).
        G.strips.push(f.glow(program === 'CYBER_EATERY' ? 0xffa848 : tint(1), 0.7, ca0 + 0.3, ca1 - 0.3, 3.66, 3.92, 0.02, 0.1));
      }
      return { piers: plan.piers };
    };
    const pipeSpots: Array<{ g: GroundFace; piers: number[]; program: GroundProgram }> = [];
    const faceProgram = new Map<GroundFace, GroundProgram>();
    groundFaces.forEach((g, i) => {
      const r = groundFace(g, programs[i]);
      faceProgram.set(g, programs[i]);
      pipeSpots.push({ g, piers: r.piers, program: programs[i] });
      // 9A-6 dense layered street signage: staggered protruding vertical blades on the piers, 1F–5F (4.6–20 m).
      const { span, b } = g;
      if (g.alley || galleryFaces.has(g.key) || spineFaces.has(g.key) || span.y1 < 9) return;
      const dense = sector.denseNeon || b.arch === ARCH_D ? 1 : 0;
      for (let k = 1; k < r.piers.length - 1; k += dense ? 1 : 2) {
        if (grng() < 0.35) continue;
        const a = r.piers[k];
        if (a < span.a0 + 0.3 || a > span.a1 - 0.3) continue;
        const reach = 1.2 + grng() * 1.6;
        const maxH = span.y1 - 0.4 - Math.max(4.4, span.y0 + 0.4);
        if (maxH < 2.2) continue;
        const hgt = Math.min(2.6 + grng() * 3.4, maxH);
        const yLo = Math.max(4.4, span.y0 + 0.4) + hgt / 2;
        const yHi = span.y1 - 0.4 - hgt / 2;
        const y = Math.min(yHi, Math.max(yLo, 4.6 + hgt / 2 + grng() * 13));
        const f = sf(span.ax, span.sg, span.plane);
        const p = f.P3(a, y, reach / 2 + 0.1);
        if (addNeon(p.x, p.y, p.z, span.ax === 'x' ? 0 : 1, span.ax === 'x' ? 1 : 0, reach, hgt, Math.floor(grng() * 8), 0, { kind: 'BUILDING_BLADE', building: b.index }))
          for (const yy of [y + hgt / 2 - 0.15, y - hgt / 2 + 0.15]) G.steel.push(...f.bx(a - 0.03, a + 0.03, yy - 0.03, yy + 0.03, 0, reach + 0.1));
      }
    });

    // ---------------------------------------------------------------- 9A-3 slab drip bands + aligned piers
    let finCount = 0;
    buildings.forEach((b) => {
      for (const span of b.plan.faces) {
        const key = fkey(b, span.ax, span.sg);
        const run = span.lot && runFaces.has(key);
        const isGallery = span.lot && galleryFaces.has(key);
        const f = sf(span.ax, span.sg, span.plane);
        const out = run ? GR.BAND_OUT_RUN_M : GR.BAND_OUT_FEATURE_M;
        const yMax = Math.min(span.y1 - 1.5, GR.BAND_MAX_Y_M);
        for (let n = 1; floorTopY(b.arch, n) <= yMax; n++) {
          const y = floorTopY(b.arch, n);
          if (y < span.y0 + 3.9) continue;
          // 10B-3: megastructure shafts carry their own exoskeleton / ribs / screens above the podium.
          if (isMegaKind(b.massing) && y > GR.MEGA_PODIUM_M + 0.1) continue;
          if (isGallery && y <= floorTopY(b.arch, GR.GALLERY_LEVELS + 1) + 0.1) continue;
          G.concrete.push(...f.bx(span.a0, span.a1, y - GR.BAND_H_M, y, 0, out, { bottom: GR.AO_BAND_UNDERSIDE, tile: RENDER.ROOF_TILE_M }));
          bandCount++;
        }
        // Vertical structure on the room grid (A has its mullions): B piers every room, D every 2 rooms, C H-beam ribs.
        if (b.arch === ARCH_A || isGallery) continue;
        const y0 = Math.max(span.y0 + 0.05, floorTopY(b.arch, 1));
        const y1 = span.y1 - 0.45;
        if (y1 - y0 < 3) continue;
        const lines = roomLines(b, span.ax, span.sg, span.a0, span.a1, b.arch === ARCH_D ? 2 : 1, 0.7);
        // 11A-1b: non-run lot feature faces get deep 0.48 m structural reveal piers (run faces stay ≤ 0.22 m flush).
        const deep = !run && span.lot && !span.court && b.arch !== ARCH_C && !balconyFaces.has(key) && !escapeFaces.has(key) && !megaFaces.has(key);
        const rel = run ? 0.14 : deep ? 0.48 : 0.22;
        const w = b.arch === ARCH_D ? 0.42 : 0.32;
        /** Vertical [y0, y1] pieces of a pier at `a` clear of carved openings and (deep piers) of every sign box. */
        const pierRuns = (a: number, hw: number, d: number): Array<[number, number]> => {
          const cuts: Array<[number, number]> = openingsAt(b.index, span.ax, span.sg, span.plane, a - hw, a + hw, y0, y1).map((o) => [o.y0 - 0.1, o.y1 + 0.1]);
          if (d > 0.3) {
            const q0 = f.P3(a - hw, y0, 0);
            const q1 = f.P3(a + hw, y1, d);
            const lx = Math.min(q0.x, q1.x);
            const hx = Math.max(q0.x, q1.x);
            const lz = Math.min(q0.z, q1.z);
            const hz = Math.max(q0.z, q1.z);
            for (const o of signBoxes) if (o.x0 < hx && o.x1 > lx && o.z0 < hz && o.z1 > lz && o.y0 < y1 && o.y1 > y0) cuts.push([o.y0 - 0.05, o.y1 + 0.05]);
          }
          return subtractIntervals(y0, y1, cuts).filter(([c0, c1]) => c1 - c0 >= 1.2);
        };
        for (const a of lines) {
          if (b.arch === ARCH_C) {
            for (const [c0, c1] of pierRuns(a, 0.18, rel)) G.steel.push(...f.bx(a - 0.06, a + 0.06, c0, c1, 0, rel - 0.05), ...f.bx(a - 0.18, a + 0.18, c0, c1, rel - 0.05, rel));
          } else {
            for (const [c0, c1] of pierRuns(a, w / 2, rel)) {
              const p0 = f.P3(a - w / 2, c0, 0);
              const p1 = f.P3(a + w / 2, c1, rel);
              G.bodies.push(plainBody(boxAt(Math.abs(p1.x - p0.x), c1 - c0, Math.abs(p1.z - p0.z), (p0.x + p1.x) / 2, (c0 + c1) / 2, (p0.z + p1.z) / 2), b.seed, b.arch));
              // 11A-1b: deep (0.48 m > player radius) reveal piers are solid, so the camera never enters one.
              if (deep) f.coll(a - w / 2, a + w / 2, c0, c1, 0, rel, b.index);
            }
          }
          pierCount++;
        }
        // 11A-1b: 0.38 m dark-steel sun-breaker fins above each 2F–8F window head between the deep piers.
        if (deep) {
          for (let k = 0; k + 1 < lines.length; k++) {
            // Bolted to the wall (d 0) and butted into both deep piers: a full load path, nothing floats.
            const f0 = lines[k] + w / 2;
            const f1 = lines[k + 1] - w / 2;
            if (f1 - f0 < 1) continue;
            for (let n = 2; n <= 8; n++) {
              const yf = floorTopY(b.arch, n) - 0.6;
              if (yf < y0 + 2 || yf + 0.6 > Math.min(y1, GR.BAND_MAX_Y_M)) continue;
              if (openingsAt(b.index, span.ax, span.sg, span.plane, f0, f1, yf - 0.1, yf + 0.15).length) continue;
              const q0 = f.P3(f0, yf, 0);
              const q1 = f.P3(f1, yf + 0.05, 0.38);
              const lx = Math.min(q0.x, q1.x);
              const hx = Math.max(q0.x, q1.x);
              const lz = Math.min(q0.z, q1.z);
              const hz = Math.max(q0.z, q1.z);
              if (signBoxes.some((o) => o.x0 < hx + 0.05 && o.x1 > lx - 0.05 && o.z0 < hz + 0.05 && o.z1 > lz - 0.05 && o.y0 < yf + 0.1 && o.y1 > yf - 0.05)) continue;
              G.steel.push(...f.bx(f0, f1, yf, yf + 0.05, 0, 0.38, { bottom: GR.AO_UNDERSIDE }));
              finCount++;
            }
          }
        }
      }
    });

    // ---------------------------------------------------------------- 9A-1 parapets (1.05 m) + coping
    buildings.forEach((b) => {
      const gaps = escapeGaps.filter((gp) => gp.building === b.index);
      parapetGapCount += gaps.length;
      // 10B-3 round cylinder roof: 12-gon parapet built with the megastructure.
      if (b.plan.cyl) parapetLen += GRAMMAR.CYL_SIDES * 2 * (b.plan.cyl.r + 0.12) * Math.sin(Math.PI / GRAMMAR.CYL_SIDES);
      for (const seg of parapetSegments(b.plan, gaps)) {
        const f = sf(seg.ax, seg.sg, seg.plane);
        const H2 = GR.PARAPET_H;
        G.concrete.push(...f.bx(seg.a0, seg.a1, seg.y, seg.y + H2, 0.12 - GR.PARAPET_T, 0.12, { ground: true, contact: seg.y, tile: RENDER.ROOF_TILE_M }));
        G.steel.push(...f.bx(seg.a0, seg.a1, seg.y + H2, seg.y + H2 + GR.COPING_H, 0.15 - GR.COPING_W, 0.15, { bottom: 0.7 }));
        f.coll(seg.a0, seg.a1, seg.y, seg.y + H2, 0.12 - GR.PARAPET_T, 0.12, b.index);
        parapetLen += seg.a1 - seg.a0;
      }
    });

    // ---------------------------------------------------------------- 9A-6 building-side riser bundles + conduits
    for (const { g, piers, program } of pipeSpots) {
      const { b, span, run } = g;
      if (!(g.alley || program === 'ALLEY_INFRA' || program === 'CYBER_EATERY')) continue;
      if (span.y1 < 8 || piers.length < 2) continue;
      const f = sf(span.ax, span.sg, span.plane);
      const wallN = new THREE.Vector3(f.nx, 0, f.nz);
      const n = grng() < 0.5 ? 2 : 3;
      const r = run || g.alley ? 0.075 : 0.1 + grng() * 0.04;
      const gap = r * 2.4;
      const base = (grng() < 0.5 ? piers[0] + 0.55 : piers[piers.length - 1] - 0.55 - gap * (n - 1));
      let top = Math.min(span.y1 - 1.0, 12 + grng() * 16);
      // 10B-2: risers stop 0.6 m under any Mega-Billboard mounted over their run.
      for (const mr of megaRects) {
        if (mr.b !== b.index || mr.ax !== span.ax || mr.sg !== span.sg) continue;
        if (mr.a1 < Math.min(base, base + gap * (n - 1)) - r - 0.2 || mr.a0 > Math.max(base, base + gap * (n - 1)) + r + 0.2) continue;
        top = Math.min(top, mr.y0 - 0.6);
      }
      if (top < 4) continue;
      const d = r + 0.04;
      for (let k = 0; k < n; k++) {
        const a = base + k * gap;
        G.steel.push(aoPipe(f.P3(a, 0.3, d), f.P3(a, top, d), r, wallN, true));
        // 90° elbow into the facade.
        G.steel.push(aoPipe(f.P3(a, top - r, d), f.P3(a, top - r, -0.05), r, null));
        G.steel.push(...f.bx(a - r * 1.15, a + r * 1.15, top - r * 2.1, top + 0.02, d - r * 1.15, d + r * 1.15));
      }
      for (let y = 1.6; y < top - 0.5; y += 3.5) G.steel.push(...f.bx(base - r - 0.05, base + gap * (n - 1) + r + 0.05, y, y + 0.06, 0, d + r + 0.04));
      {
        // 9B: the bundle has no collider; props and clutter keep clear of it.
        const p0 = f.P3(base - r - 0.08, 0, 0);
        const p1 = f.P3(base + gap * (n - 1) + r + 0.08, 0, d + r + 0.08);
        propObstacles.push({ minX: Math.min(p0.x, p1.x), minY: 0, minZ: Math.min(p0.z, p1.z), maxX: Math.max(p0.x, p1.x), maxY: top, maxZ: Math.max(p0.z, p1.z) });
      }
      // Horizontal conduit just above the 1F fascias + junction boxes with status LEDs.
      if (program === 'ALLEY_INFRA' || program === 'CYBER_EATERY') {
        const cy = 3.85 + grng() * 0.5;
        G.steel.push(aoPipe(f.P3(span.a0 + 0.6, cy, 0.09), f.P3(span.a1 - 0.6, cy, 0.09), 0.045, wallN));
        fixtureBox(f, span.a0 + 0.6, span.a1 - 0.6, cy - 0.06, cy + 0.06, 0, 0.15);
        const jn = span.a1 - span.a0 > 12 ? 2 : 1;
        for (let k = 0; k < jn; k++) {
          const ja = span.a0 + (span.a1 - span.a0) * (k + 1) / (jn + 1);
          G.steel.push(...f.bx(ja - 0.18, ja + 0.18, cy - 0.3, cy + 0.15, 0, 0.15));
          fixtureBox(f, ja - 0.18, ja + 0.18, cy - 0.3, cy + 0.15, 0, 0.15);
          G.strips.push(f.glow([0xff3030, 0xffb020, 0x30e8ff][(k + Math.floor(b.seed * 5)) % 3], 1.2, ja + 0.08, ja + 0.12, cy + 0.02, cy + 0.06, 0.15, 0.165));
        }
      }
      pipeBundles++;
    }

    // 7B-4: sagging catenary cable bundles (2–3 thin cables, 6 segments each, sag 0.6–1.4 m) strung diagonally
    // across the alleys at 5.5–18 m — visual only (no collider), merged into the existing strip batch (+0 draws);
    // one in four bundles carries a faint optic fibre.
    {
      const C = CITY_FX;
      const cat = (t: number, k = 1.25): number => (Math.cosh(k * (2 * t - 1)) - Math.cosh(k)) / (1 - Math.cosh(k));
      const a0x = (al: { axis: Axis; gap0: number; gap1: number }, o1: number, o2: number): number => (al.axis === 'x' ? (al.gap0 + al.gap1) / 2 : (o1 + o2) / 2);
      const a0z = (al: { axis: Axis; gap0: number; gap1: number }, o1: number, o2: number): number => (al.axis === 'x' ? (o1 + o2) / 2 : (al.gap0 + al.gap1) / 2);
      this.cableDebug.length = 0;
      for (const al of alleyRecs) {
        const A = buildings[al.a];
        const B = buildings[al.b];
        const top = Math.min(C.CABLE_Y[1], lowTopOf(A) - 1.5, lowTopOf(B) - 1.5);
        if (top < C.CABLE_Y[0] + 0.5 || al.gap1 - al.gap0 > 14) continue;
        const span = al.ov1 - al.ov0;
        // 9A-6: denser layered overhead cables (up to 5 bundles per alley).
        const bundles = Math.min(5, 1 + Math.floor(span / 6));
        for (let k = 0; k < bundles; k++) {
          const o1 = al.ov0 + ((k + 0.5) / bundles) * span + (srng() - 0.5) * 2;
          const o2 = Math.min(al.ov1 - 0.5, Math.max(al.ov0 + 0.5, o1 + (srng() - 0.5) * 5));
          const y1 = C.CABLE_Y[0] + srng() * (top - C.CABLE_Y[0]);
          const y2 = Math.min(top, Math.max(C.CABLE_Y[0], y1 + (srng() - 0.5) * 3));
          const nCab = 2 + (srng() < 0.5 ? 1 : 0);
          const fibre = srng() < 0.25;
          for (let c = 0; c < nCab; c++) {
            const sag = C.CABLE_SAG[0] + srng() * (C.CABLE_SAG[1] - C.CABLE_SAG[0]);
            const dy = c * 0.11;
            const dz = (c - (nCab - 1) / 2) * 0.09;
            const a = al.axis === 'x' ? new THREE.Vector3(al.gap0, y1 - dy, o1 + dz) : new THREE.Vector3(o1 + dz, y1 - dy, al.gap0);
            const b = al.axis === 'x' ? new THREE.Vector3(al.gap1, y2 - dy, o2 + dz) : new THREE.Vector3(o2 + dz, y2 - dy, al.gap1);
            const pts: THREE.Vector3[] = [];
            for (let i = 0; i <= C.CABLE_SEGMENTS; i++) {
              const t = i / C.CABLE_SEGMENTS;
              pts.push(a.clone().lerp(b, t).setY(a.y + (b.y - a.y) * t - sag * cat(t)));
            }
            const tube = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), C.CABLE_SEGMENTS, c === 0 && fibre ? C.CABLE_RADIUS * 0.8 : C.CABLE_RADIUS, 3, false);
            // Rain-wet cables catch the street light: a dim cool sheen keeps them readable against the night sky.
            if (c === 0 && fibre) G.strips.push(withColor(tube, NEON_TINTS[Math.floor(srng() * NEON_TINTS.length)], 0.55));
            else G.strips.push(withColor(tube, 0x8a97ad, 0.16));
          }
          // Wall bracket anchors at both ends.
          for (const [ga, oo, yy] of [[al.gap0, o1, y1], [al.gap1, o2, y2]] as const) {
            const out = ga === al.gap0 ? 0.12 : -0.12;
            G.steel.push(al.axis === 'x' ? boxAt(0.24, 0.12, 0.3, ga + out, yy + 0.02, oo) : boxAt(0.3, 0.12, 0.24, oo, yy + 0.02, ga + out));
          }
          cableBundles++;
          this.cableDebug.push({ x: (a0x(al, o1, o2)), y: (y1 + y2) / 2, z: a0z(al, o1, o2), axis: al.axis });
        }
      }
    }

    // 10A-2 alley signage: staggered protruding vertical blades & cross-alley hanging bars strictly bound to solid FaceSpans.
    let alleyNeon = 0;
    for (const al of alleyRecs) {
      const A = buildings[al.a];
      const B = buildings[al.b];
      const spansA = A.plan.faces.filter((sp) => sp.ax === al.axis && sp.sg === 1 && Math.abs(sp.plane - al.gap0) < 0.05);
      const spansB = B.plan.faces.filter((sp) => sp.ax === al.axis && sp.sg === -1 && Math.abs(sp.plane - al.gap1) < 0.05);
      for (const [bld, spans, out, wall] of [[A, spansA, 1, al.gap0], [B, spansB, -1, al.gap1]] as const) {
        for (const sp of spans) {
          const a0 = Math.max(al.ov0, sp.a0) + 0.3;
          const a1 = Math.min(al.ov1, sp.a1) - 0.3;
          const yLoLim = Math.max(3.6, sp.y0 + 0.4);
          const yHiLim = Math.min(24, sp.y1 - 0.4);
          if (a1 <= a0 + 0.4 || yHiLim - yLoLim < 2.2) continue;
          for (let o = a0 + 0.6 + srng() * 1.4; o <= a1 - 0.1; o += 3.4 + srng() * 2.6) {
            const reach = Math.min(al.gap1 - al.gap0 - 1.4, 1.2 + srng() * 1.6);
            if (reach < 1) continue;
            const hgt = Math.min(2.4 + srng() * 3.2, yHiLim - yLoLim);
            const y = yLoLim + hgt / 2 + srng() * Math.max(0, yHiLim - yLoLim - hgt);
            const c = wall + out * (reach / 2 + 0.1);
            const bladeStrip = Math.floor(srng() * 8);
            const placed = al.axis === 'x'
              ? addNeon(c, y, o, 0, 1, reach, hgt, bladeStrip, 0, { kind: 'ALLEY_BLADE', building: bld.index })
              : addNeon(o, y, c, 1, 0, reach, hgt, bladeStrip, 0, { kind: 'ALLEY_BLADE', building: bld.index });
            if (!placed) continue;
            for (const yy of [y + hgt / 2 - 0.15, y - hgt / 2 + 0.15]) {
              G.steel.push(al.axis === 'x' ? boxAt(reach + 0.1, 0.06, 0.06, wall + out * (reach / 2 + 0.05), yy, o) : boxAt(0.06, 0.06, reach + 0.1, o, yy, wall + out * (reach / 2 + 0.05)));
            }
            alleyNeon++;
          }
        }
      }
      // Cross-alley hanging bars: only where BOTH walls have solid FaceSpans at the mounting height & along coordinate.
      const barH = 0.75;
      for (const spA of spansA) {
        for (const spB of spansB) {
          const a0 = Math.max(al.ov0, spA.a0, spB.a0) + 0.3;
          const a1 = Math.min(al.ov1, spA.a1, spB.a1) - 0.3;
          const y0 = Math.max(6.5, spA.y0 + 0.4, spB.y0 + 0.4);
          const y1 = Math.min(14, spA.y1 - 0.4, spB.y1 - 0.4);
          if (a1 <= a0 + 0.8 || y1 - y0 < barH + 0.1) continue;
          const bars = Math.min(4, 1 + Math.floor((a1 - a0) / 9));
          for (let k = 0; k < bars; k++) {
            const o = a0 + ((k + 0.5) / bars) * (a1 - a0);
            const y = y0 + barH / 2 + srng() * Math.max(0, y1 - y0 - barH);
            const w = al.gap1 - al.gap0 - 0.6;
            const c = (al.gap0 + al.gap1) / 2;
            const barRow = Math.floor(srng() * SIGN_ATLAS.WIDE_ROWS);
            const placed = al.axis === 'x'
              ? addNeon(c, y, o, 0, 1, w, barH, barRow, 1, { kind: 'ALLEY_BAR', building: A.index, buildingB: B.index })
              : addNeon(o, y, c, 1, 0, w, barH, barRow, 1, { kind: 'ALLEY_BAR', building: A.index, buildingB: B.index });
            if (!placed) continue;
            // Mounting steel cross-bar touching both solid alley walls.
            G.steel.push(al.axis === 'x' ? boxAt(al.gap1 - al.gap0, 0.06, 0.06, c, y + barH / 2 + 0.03, o) : boxAt(0.06, 0.06, al.gap1 - al.gap0, o, y + barH / 2 + 0.03, c));
            alleyNeon++;
          }
        }
      }
    }

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
    // 10D-2: reserve the rooftop hologram footprints first (full 3.6 m ring sweep) so machine rooms, AC units, ducts
    // and roof spawns keep clear of the spinning rings. Never on cylinder / slant / twin-arch megastructures or on the
    // two searchlight towers; ≥ 18 m from every blimp orbit.
    const holoReserve: Array<{ b: Building; x: number; z: number }> = [];
    {
      const SW = ENV_DIMS.HOLO_SWEEP;
      const searchTowers = new Set([...buildings].sort((p, o) => o.roofY - p.roofY).slice(0, 2).map((b) => b.index));
      const elig = [...buildings]
        .filter((b) => b.roofY >= 28 && b.halfW >= 5.5 && b.halfD >= 5.5 && !searchTowers.has(b.index) && b.massing !== 'CYLINDER_RING_TOWER' && b.massing !== 'SLANT_CORP_TOWER' && b.massing !== 'TWIN_ARCH_GATE')
        .sort((p, o) => o.roofY - p.roofY);
      for (const b of elig) {
        if (holoReserve.length >= 10) break;
        const ex = Math.max(0, b.halfW - SW - 0.6);
        const ez = Math.max(0, b.halfD - SW - 0.6);
        let best: [number, number] | null = null;
        for (let dx = -ex; dx <= ex + 1e-6; dx += 0.5) {
          for (let dz = -ez; dz <= ez + 1e-6; dz += 0.5) {
            const x = b.cx + dx;
            const z = b.cz + dz;
            if (best && Math.hypot(dx, dz) >= Math.hypot(best[0] - b.cx, best[1] - b.cz)) continue;
            const r = rectFrom(x - SW, z - SW, x + SW, z + SW);
            if (roofRects[b.index].some((o) => rectsOverlap(r, o, 0.2)) || !inArea(x, z, 0)) continue;
            const y0 = b.roofY + 0.05;
            const y1 = b.roofY + ENV_DIMS.HOLO_TOP + 0.3;
            if (colliders.some((c) => c.kind !== 'BARRIER' && r.x0 < c.max.x && r.x1 > c.min.x && y0 < c.max.y && y1 > c.min.y && r.z0 < c.max.z && r.z1 > c.min.z)) continue;
            if (CITY_FX.BLIMPS.some((bl) => Math.hypot(Math.abs(Math.hypot(x, z) - bl.radius), Math.max(0, bl.y - y1)) < 18 + SW + CITY_FX.BLIMP_RADIUS)) continue;
            best = [x, z];
          }
        }
        if (!best) continue;
        roofRects[b.index].push(rectFrom(best[0] - SW, best[1] - SW, best[0] + SW, best[1] + SW));
        holoReserve.push({ b, x: best[0], z: best[1] });
      }
    }
    /** 9A-2 audit: every roof prop footprint (machine rooms, AC units, ducts, spawns) must sit on solid roof. */
    const roofPropRects: Array<{ b: Building; r: RectXZ }> = [];
    const tryPlace = (b: Building, hw: number, hd: number, margin: number): RectXZ | null => {
      for (let attempt = 0; attempt < 24; attempt++) {
        const x = b.cx + (rng() * 2 - 1) * Math.max(0, b.halfW - hw - margin);
        const z = b.cz + (rng() * 2 - 1) * Math.max(0, b.halfD - hd - margin);
        const r = rectFrom(x - hw, z - hd, x + hw, z + hd);
        if (!roofRects[b.index].some((o) => rectsOverlap(r, o, 0.9))) {
          roofRects[b.index].push(r);
          roofPropRects.push({ b, r });
          return r;
        }
      }
      return null;
    };
    /** 10B-2: true when a ground prop of half-size `r` at (x, z) would stand in a 1F doorway or against its assembly. */
    const blocksDoor = (x: number, z: number, r: number): boolean => {
      if (doorClearZones.some((c) => c.y < 1 && x + r > c.x0 && x - r < c.x1 && z + r > c.z0 && z - r < c.z1)) return true;
      return groundDoors.some((d) => {
        const along = d.ax === 'x' ? z : x;
        const out = d.sg * ((d.ax === 'x' ? x : z) - d.plane);
        return out > -0.1 && out - r < 1.2 && along + r > d.e0 - 0.1 && along - r < d.e1 + 0.1;
      });
    };
    const facePoint = (b: Building, axis: Axis, sign: number, along01: number, out: THREE.Vector3): THREE.Vector3 =>
      axis === 'x'
        ? out.set(b.lcx + sign * b.lotHalfW, 0, b.lcz + (along01 - 0.5) * b.lotHalfD * 2)
        : out.set(b.lcx + (along01 - 0.5) * b.lotHalfW * 2, 0, b.lcz + sign * b.lotHalfD);

    let bulkheads = 0;
    /** 10D-2: explicit rooftop machine-room boxes (rooftop fans mount on their non-door flanks, never on roofRects). */
    const machineRoomBoxes: Array<{ x0: number; x1: number; y0: number; y1: number; z0: number; z1: number; doorFace: string | null; building: number }> = [];
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
          const roomRec = { x0: r.x0, x1: r.x1, y0: b.roofY, y1: b.roofY + rh, z0: r.z0, z1: r.z1, doorFace: null as string | null, building: b.index };
          machineRoomBoxes.push(roomRec);
          // 9A-1 rooftop access bulkhead: recessed painted steel door (1.0 × 2.1 m) on the side facing the roof centre,
          // with a small caged amber / cyan door light.
          if (b.halfW * 2 >= GRAMMAR.BULKHEAD_MIN_ROOF_M && b.halfD * 2 >= GRAMMAR.BULKHEAD_MIN_ROOF_M) {
            const mx = (r.x0 + r.x1) / 2;
            const mz = (r.z0 + r.z1) / 2;
            const dx = b.cx - mx;
            const dz = b.cz - mz;
            const fx = Math.abs(dx) > Math.abs(dz);
            const sgn = fx ? Math.sign(dx) || 1 : Math.sign(dz) || 1;
            const plane = fx ? (sgn > 0 ? r.x1 : r.x0) : sgn > 0 ? r.z1 : r.z0;
            const along = fx ? mz : mx;
            const P = (al: number, y: number, d: number): [number, number, number] => (fx ? [plane + sgn * d, y, al] : [al, y, plane + sgn * d]);
            const pbox = (a0: number, a1: number, y0: number, y1: number, d0: number, d1: number): [number, number, number, number, number, number] => {
              const [x0, , z0] = P(a0, y0, d0);
              const [x1, , z1] = P(a1, y1, d1);
              return [Math.abs(x1 - x0), y1 - y0, Math.abs(z1 - z0), (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
            };
            const ry = b.roofY;
            const [w1, h1, d1, x1, y1, z1] = pbox(along - 0.5, along + 0.5, ry, ry + 2.1, 0.0, 0.05);
            G.archPaint.push(...aoBox(w1, h1, d1, x1, y1, z1, { all: GRAMMAR.AO_RECESS + 0.1, tile: 1.6 }).map((g) => withTint(g, PAINT.DOORS[Math.floor(b.seed * 11) % PAINT.DOORS.length])));
            for (const [a0, a1, y0, y2] of [[along - 0.62, along - 0.5, ry, ry + 2.22], [along + 0.5, along + 0.62, ry, ry + 2.22], [along - 0.62, along + 0.62, ry + 2.1, ry + 2.22]] as const) {
              const [w2, h2, d2, x2, y2c, z2] = pbox(a0, a1, y0, y2, 0, 0.12);
              G.steel.push(boxAt(w2, h2, d2, x2, y2c, z2));
            }
            const [w3, h3, d3, x3, y3, z3] = pbox(along - 0.1, along + 0.1, ry + 2.38, ry + 2.56, 0.04, 0.16);
            const lightHex = b.seed < 0.5 ? 0xffb040 : COLORS.WALLRUN_CYAN;
            G.strips.push(withColor(boxAt(w3, h3, d3, x3, y3, z3), lightHex, 1.0));
            roomRec.doorFace = `${fx ? 'x' : 'z'}:${sgn}`;
            bulkheads++;
          }
          if (counts.ant < CAP.ANTENNA) {
            const ah = 6 + rng() * 8;
            counts.ant++;
            addSteelFixture(2, r.x0 + 0.8, b.roofY + rh, r.z0 + 0.8, 0, 1, ah, 1);
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
        counts.ac++;
        placeMech(0, (r.x0 + r.x1) / 2, b.roofY, (r.z0 + r.z1) / 2, rot);
        colliders.push({ min: new THREE.Vector3(r.x0, b.roofY, r.z0), max: new THREE.Vector3(r.x1, b.roofY + 1.42, r.z1), kind: 'PROP', building: b.index });
      }
      // Exhaust duct.
      if (counts.duct < CAP.DUCT && b.halfW > 6 && b.halfD > 6) {
        const len = 4 + rng() * 3;
        const alongX = rng() < 0.5;
        const r = tryPlace(b, alongX ? len / 2 : 0.5, alongX ? 0.5 : len / 2, 1.4);
        if (r) {
          counts.duct++;
          placeMech(1, (r.x0 + r.x1) / 2, b.roofY, (r.z0 + r.z1) / 2, alongX ? 0 : Math.PI / 2, len, 1, 1);
          colliders.push({ min: new THREE.Vector3(r.x0, b.roofY, r.z0), max: new THREE.Vector3(r.x1, b.roofY + 1.5, r.z1), kind: 'PROP', building: b.index });
        }
      }
      // 9A-1: the 1.05 m parapets (with fire-escape landing gaps) replace the old roof fences.
      if (b.roofY >= 45) {
        addAviation(b.cx + b.halfW - 0.3, b.roofY + 0.4, b.cz + b.halfD - 0.3);
        addAviation(b.cx - b.halfW + 0.3, b.roofY + 0.4, b.cz - b.halfD + 0.3);
      }

      // Street-facing faces: 1F canopies + wide banners, low-rise shop blade signs, Layer-2 projecting signs,
      // emblem holograms, vertical facade fins, vending machines. Balcony and fire-escape faces keep their
      // 3D structure clear of projecting signs.
      const streetFaces = FACES.filter(([ax, sg]) => !alleyFaces.has(fkey(b, ax, sg)) && !partialFaces.has(fkey(b, ax, sg)));
      const signFaces = streetFaces.filter(([ax, sg]) => !balconyFaces.has(fkey(b, ax, sg)) && !escapeFaces.has(fkey(b, ax, sg)) && !galleryFaces.has(fkey(b, ax, sg)) && !spineFaces.has(fkey(b, ax, sg)));
      const lowTop = lowTopOf(b);
      const busyFaces = new Set<string>();
      // 10A-2: bind EVERY building-mounted neonSign strictly inside a solid FaceSpan of b.plan.faces.
      const shopSigns = b.arch === ARCH_D
        ? (sector.denseNeon ? 4 : 3) + Math.floor(rng() * 3)
        : sector.denseNeon ? 3 + Math.floor(rng() * 3) : 1 + Math.floor(rng() * 2);
      const fp = new THREE.Vector3();
      for (let s = 0; s < shopSigns && signFaces.length; s++) {
        const [ax, sg] = signFaces[Math.floor(rng() * signFaces.length)];
        const minY = SB.CANOPY_Y + 0.5;
        const cands = b.plan.faces.filter((sp) => sp.ax === ax && sp.sg === sg && sp.a1 - sp.a0 >= 0.8 && sp.y1 - 0.4 - Math.max(minY, sp.y0 + 0.4) >= 3.0);
        if (!cands.length) continue;
        const span = cands[Math.floor(rng() * cands.length)];
        busyFaces.add(fkey(b, ax, sg));
        const w = 1.7;
        const yLoLim = Math.max(minY, span.y0 + 0.4);
        const yHiLim = span.y1 - 0.4;
        const hgt = Math.min(5 + rng() * 4, yHiLim - yLoLim);
        const y = Math.min(yHiLim - hgt / 2, yLoLim + hgt / 2 + rng() * Math.min(1.5, Math.max(0, yHiLim - yLoLim - hgt)));
        const along = span.a0 + 0.3 + rng() * (span.a1 - span.a0 - 0.6);
        const fSpan = sf(span.ax, span.sg, span.plane);
        const p = fSpan.P3(along, y, w / 2 + 0.3);
        const shopStrip = Math.floor(rng() * 8);
        if (!addNeon(p.x, p.y, p.z, span.ax === 'x' ? 0 : 1, span.ax === 'x' ? 1 : 0, w, hgt, shopStrip, 0, { kind: 'BUILDING_BLADE', building: b.index })) continue;
        for (const yy of [y + hgt / 2 - 0.2, y - hgt / 2 + 0.2]) {
          G.steel.push(...fSpan.bx(along - 0.04, along + 0.04, yy - 0.04, yy + 0.04, 0, w + 0.3));
        }
      }
      if (b.roofY >= 36 && signFaces.length) {
        const [ax, sg] = signFaces[Math.floor(rng() * signFaces.length)];
        const cands = b.plan.faces.filter((sp) => {
          if (sp.ax !== ax || sp.sg !== sg || sp.a1 - sp.a0 < 0.8) return false;
          const lo = Math.max(LEVEL.SKYBRIDGE_Y_MIN, sp.y0 + 0.4);
          const hi = Math.min(LEVEL.SKYBRIDGE_Y_MAX, sp.y1 - 0.4);
          return hi - lo >= 6.0;
        });
        if (cands.length) {
          const span = cands[Math.floor(rng() * cands.length)];
          busyFaces.add(fkey(b, ax, sg));
          const w = 2.6;
          const lo = Math.max(LEVEL.SKYBRIDGE_Y_MIN, span.y0 + 0.4);
          const hi = Math.min(LEVEL.SKYBRIDGE_Y_MAX, span.y1 - 0.4);
          const hgt = Math.min(11 + rng() * 4, hi - lo);
          const y = lo + hgt / 2 + rng() * Math.max(0, hi - lo - hgt);
          const along = span.a0 + 0.3 + (0.15 + rng() * 0.7) * (span.a1 - span.a0 - 0.6);
          const fSpan = sf(span.ax, span.sg, span.plane);
          const p = fSpan.P3(along, y, w / 2 + 0.4);
          const l2Strip = Math.floor(rng() * 8);
          const beaconRoll = rng();
          if (addNeon(p.x, p.y, p.z, span.ax === 'x' ? 0 : 1, span.ax === 'x' ? 1 : 0, w, hgt, l2Strip, 0, { kind: 'BUILDING_BLADE', building: b.index })) {
            for (const yy of [y + hgt / 2 - 0.25, y - hgt / 2 + 0.25]) {
              G.steel.push(...fSpan.bx(along - 0.06, along + 0.06, yy - 0.06, yy + 0.06, 0, w + 0.4));
            }
            if (beaconRoll < 0.6) addBeacon(new THREE.Vector3(p.x, y + hgt / 2 + 0.9, p.z), 'SIGN');
          }
        }
      }
      // 5B-3 emblem / geometric hologram on the mid floors (14 m … below the top / 42 m), strictly inside a solid FaceSpan.
      if (lowTop >= 26 && signFaces.length && srng() < 0.42) {
        const [ax, sg] = signFaces[Math.floor(srng() * signFaces.length)];
        const sz = 4.5 + srng() * 2.5;
        const cands = b.plan.faces.filter((sp) => {
          if (sp.ax !== ax || sp.sg !== sg || sp.a1 - sp.a0 < sz + 0.6) return false;
          const lo = Math.max(14, sp.y0 + 0.4);
          const hi = Math.min(42, sp.y1 - 0.4);
          return hi - lo >= sz;
        });
        if (cands.length) {
          const span = cands[Math.floor(srng() * cands.length)];
          busyFaces.add(fkey(b, ax, sg));
          const lo = Math.max(14, span.y0 + 0.4);
          const hi = Math.min(42, span.y1 - 0.4);
          const y = lo + sz / 2 + srng() * Math.max(0, hi - lo - sz);
          const aMin = span.a0 + 0.3 + sz / 2;
          const aMax = span.a1 - 0.3 - sz / 2;
          const along = aMin + srng() * Math.max(0, aMax - aMin);
          const fSpan = sf(span.ax, span.sg, span.plane);
          const p = fSpan.P3(along, y, b.arch === ARCH_A ? AR.MULLION_D + 0.12 : 0.12);
          addNeon(p.x, p.y, p.z, fSpan.nx, fSpan.nz, sz, sz, Math.floor(srng() * SIGN_ATLAS.EMBLEMS), 2, { kind: 'BUILDING_FLAT', building: b.index });
        }
      }
      // 5B-3 vertical concrete fins on Type B street faces without balconies (decorative, ≤ 0.45 m: no collider).
      if (b.arch === ARCH_B && lowTop >= 16) {
        for (const [ax, sg] of streetFaces) {
          const key = fkey(b, ax, sg);
          if (runFaces.has(key) || balconyFaces.has(key) || busyFaces.has(key) || galleryFaces.has(key) || megaFaces.has(key) || srng() < 0.45) continue;
          const len = (ax === 'x' ? b.lotHalfD : b.lotHalfW) * 2;
          const n = 3 + Math.floor(srng() * 3);
          const y0 = SB.CANOPY_Y + 0.9;
          const y1 = lowTop - 1.2;
          for (let k = 0; k < n; k++) {
            const along = -len / 2 + len * (0.15 + (0.7 * k) / Math.max(1, n - 1));
            if (ax === 'x') G.bodies.push(plainBody(boxAt(0.42, y1 - y0, 0.2, b.lcx + sg * (b.lotHalfW + 0.21), (y0 + y1) / 2, b.lcz + along), b.seed, ARCH_B));
            else G.bodies.push(plainBody(boxAt(0.2, y1 - y0, 0.42, b.lcx + along, (y0 + y1) / 2, b.lcz + sg * (b.lotHalfD + 0.21)), b.seed, ARCH_B));
          }
        }
      }
      const vendFaces = streetFaces.filter(([ax, sg]) => !escapeFaces.has(fkey(b, ax, sg)) && !ductFaces.has(fkey(b, ax, sg)) && !galleryFaces.has(fkey(b, ax, sg)) && !spineFaces.has(fkey(b, ax, sg)));
      if (vendFaces.length && rng() < 0.75) {
        const fi = Math.floor(rng() * vendFaces.length);
        const along01 = 0.2 + rng() * 0.5;
        const n = 2 + Math.floor(rng() * 2);
        const off = 0.45;
        // 10D: a row that places nothing (piers / doors / span ends) moves to the next eligible face — no extra RNG.
        for (let fo = 0; fo < vendFaces.length; fo++) {
        const [ax, sg] = vendFaces[(fi + fo) % vendFaces.length];
        facePoint(b, ax, sg, along01, fp);
        const yaw = ax === 'x' ? (sg > 0 ? Math.PI / 2 : -Math.PI / 2) : sg > 0 ? 0 : Math.PI;
        const before = counts.vend;
        // 10BC-Fix FIX-10: 1.20 m stride (1.14 m hero kiosk + 6 cm air), every kiosk inside the lot face span.
        const [fa0, fa1] = lotRange(b, ax);
        for (let k = 0; k < n; k++) {
          const x = fp.x + (ax === 'x' ? sg * off : k * 1.2);
          const z = fp.z + (ax === 'z' ? sg * off : k * 1.2);
          const along = ax === 'x' ? z : x;
          if (along - 0.57 < fa0 || along + 0.57 > fa1) continue;
          // Never against a 1F ground pier (they stand 0.24–0.36 m proud of the wall; the kiosk back is 0.06 m off).
          if (groundPiers.some((gp) => gp.building === b.index && gp.ax === ax && gp.sg === sg && gp.a0 < along + 0.6 && gp.a1 > along - 0.6)) continue;
          // 10B-2: never in a doorway's 1.8 m clear zone or against its assembly (jambs / portal / canopy).
          if (inArea(x, z, 2) && !blocksDoor(x, z, 0.6)) addVending(x, z, yaw);
        }
        if (counts.vend > before) break;
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
    // 9A-2: census over the exposed wall spans of every massing box (L wings, courtyards, podium + tower, tiers).
    buildings.forEach((b) => {
      for (const span of b.plan.faces) {
        const top = span.y1 - 0.45;
        if (span.ax === 'x') censusFace(b, span.sg, 0, span.a0, span.a1, span.y0, top);
        else censusFace(b, 0, span.sg, span.a0, span.a1, span.y0, top);
      }
    });

    // 10B-1 the single open pocket becomes a dense covered cyber street-market (never bare concrete): two stall
    // rows (back cabinets, lit counters, stall signs) under overhanging lit awnings along a 3.2 m central aisle, a
    // steel ridge with lantern strings and cables, vending at the aisle mouth, a two-car parking bay, crates (9B).
    const parkingSlots: CarSlot[] = [];
    let marketStalls = 0;
    const marketTrestles: Array<{ tie: Aabb3; king: Aabb3; posts: Aabb3[]; awningEdges: Aabb3[] }> = [];
    const faceAabb = (f: SF, a0: number, a1: number, y0: number, y1: number, d0: number, d1: number): Aabb3 => {
      const p = f.P3(a0, y0, d0);
      const q = f.P3(a1, y1, d1);
      return { minX: Math.min(p.x, q.x), minY: y0, minZ: Math.min(p.z, q.z), maxX: Math.max(p.x, q.x), maxY: y1, maxZ: Math.max(p.z, q.z) };
    };
    const STALL_PAINT = [0x3a2a20, 0x2f3a2c, 0x4a3226, 0x272e38, 0x432d26];
    plazas.forEach((r) => {
      const alongX = r.x1 - r.x0 >= r.z1 - r.z0;
      const ax: Axis = alongX ? 'z' : 'x';
      const [a0, a1] = alongX ? [r.x0, r.x1] : [r.z0, r.z1];
      const [l0, l1] = alongX ? [r.z0, r.z1] : [r.x0, r.x1];
      const S = l1 - l0;
      const L = a1 - a0;
      const aisle = 3.2;
      const rowD = Math.min(3.4, (S - aisle) / 2 - 0.3);
      if (rowD < 1.8 || L < 12) return;
      const park = L >= 24 ? 5.5 : 0;
      const sA0 = a0 + 1.0 + park;
      const sA1 = a1 - 1.0;
      const bay = 3.0;
      const nB = Math.floor((sA1 - sA0) / bay);
      const back0 = 0.3;
      const back1 = back0 + Math.max(0.9, rowD * 0.45);
      const front = back0 + rowD;
      const yOut = 3.05;
      // 10BC-Fix FIX-1: aisle-edge posts from the first trestle every 6 m plus an exact end post under the last one.
      const postAs: number[] = [];
      for (let a = sA0 + 0.2; a < sA1 - 1.5; a += 6) postAs.push(a);
      postAs.push(sA1 - 0.2);
      for (const sg of [1, -1] as const) {
        const f = sf(ax, sg, sg > 0 ? l0 : l1);
        for (let k = 0; k < nB; k++) {
          const b0 = sA0 + k * bay + 0.08;
          const b1 = b0 + bay - 0.16;
          const cab = STALL_PAINT[(k * 3 + (sg > 0 ? 0 : 2)) % STALL_PAINT.length];
          // 10D-5: recessed illuminated display alcove — back panel 0.24 m behind the stall face, 0.12 m divider fins,
          // fascia valance (2.0–2.3 m), inner shelf (1.25 m) lit by a warm under-valance strip.
          G.archPaint.push(...f.paint(cab, b0, b1, 0, 2.3, back0, back1 - 0.24, { ground: true }));
          for (const [fa0, fa1] of [[b0, b0 + 0.12], [b1 - 0.12, b1]] as const) G.archPaint.push(...f.paint(cab, fa0, fa1, 0, 2.3, back1 - 0.24, back1, { ground: true }));
          G.archPaint.push(...f.paint(cab, b0 + 0.12, b1 - 0.12, 2.0, 2.3, back1 - 0.24, back1, { bottom: 0.6 }));
          G.archPaint.push(...f.paint(0x2a241e, b0 + 0.12, b1 - 0.12, 1.22, 1.25, back1 - 0.24, back1 - 0.02, { all: 0.42 }));
          G.strips.push(f.glow(0xffc880, 0.85, b0 + 0.2, b1 - 0.2, 1.96, 2.0, back1 - 0.22, back1 - 0.16));
          // Stall-sign backing board (the lit sign strip at 2.45–2.75 m sits on it, never floating over the cabinet).
          G.archPaint.push(...f.paint(PAINT.FRAME_DARK, b0 + 0.25, b1 - 0.25, 2.3, 2.82, back1 - 0.14, back1 - 0.02));
          G.archPaint.push(...f.paint(PAINT.FRAME_DARK, b0 + 0.15, b1 - 0.15, 0, 0.95, front - 0.6, front, { ground: true }));
          f.coll(b0, b1, 0, 2.3, back0, back1, -1);
          f.coll(b0 + 0.15, b1 - 0.15, 0, 0.95, front - 0.6, front, -1);
          G.strips.push(f.glow(PAL[(k + (sg > 0 ? 0 : 1)) % PAL.length], 1.15, b0 + 0.3, b1 - 0.3, 2.45, 2.75, back1 - 0.02, back1 + 0.04));
          G.strips.push(f.glow(0xffd8a0, 0.9, b0 + 0.4, b1 - 0.4, 0.95, 1.0, front - 0.55, front - 0.05));
          marketStalls++;
        }
        // Overhanging awning (walkable slab) over the row with a lit lip over the aisle, steel posts at the aisle edge.
        const yIn = 3.45;
        G.archPaint.push(withTint(f.slant(sA0 - 0.2, sA1 + 0.2, yIn, yOut, back0 - 0.1, front + 0.7, 0.1), PAINT.AWNINGS[sg > 0 ? 0 : 1]));
        G.strips.push(f.glow(PAL[sg > 0 ? 0 : 1 % PAL.length], 1.8, sA0 - 0.2, sA1 + 0.2, yOut - 0.14, yOut - 0.06, front + 0.62, front + 0.72));
        f.coll(sA0 - 0.2, sA1 + 0.2, yOut - 0.1, yIn, back0 - 0.1, front + 0.7, -1);
        addDripEdge(f, sA0 - 0.2, sA1 + 0.2, front + 0.7, yOut - 0.1);
        for (const a of postAs) {
          G.steel.push(...f.bx(a - 0.06, a + 0.06, 0, yOut, front + 0.45, front + 0.57, { ground: true }));
          f.coll(a - 0.06, a + 0.06, 0, yOut, front + 0.45, front + 0.57, -1, 'STEEL');
          // 10D-5: vertical power conduit clamped to the post's side.
          G.steel.push(...f.bx(a + 0.06, a + 0.1, 0.3, yOut - 0.1, front + 0.47, front + 0.51));
        }
        // 10D-5: 4 longitudinal corrugated roof purlins resting on the awning's slanted top.
        {
          const d0 = back0 - 0.1;
          const d1 = front + 0.7;
          const len = Math.hypot(d1 - d0, yIn - yOut);
          for (const u of [0.15, 0.4, 0.65, 0.9]) {
            const d = d0 + (d1 - d0) * u;
            const yTop = yIn + (yOut - yIn) * u + (0.05 * len) / (d1 - d0);
            G.steel.push(...f.bx(sA0 - 0.15, sA1 + 0.15, yTop, yTop + 0.05, d - 0.025, d + 0.025));
          }
        }
      }
      // Covered ridge over the aisle: steel spine on two trestles, lantern strings + cables across every 3 m.
      const fC = sf(ax, 1, l0);
      const mid = S / 2;
      G.steel.push(...fC.bx(sA0, sA1, 4.25, 4.4, mid - 0.08, mid + 0.08));
      // 10BC-Fix FIX-1: each trestle = cross-tie beam (aisle post to aisle post) + king-post + twin diagonal braces.
      for (const a of [sA0 + 0.2, sA1 - 0.2]) {
        marketTrestles.push({
          tie: faceAabb(fC, a - 0.07, a + 0.07, yOut - 0.08, yOut + 0.06, front + 0.45, S - front - 0.45),
          king: faceAabb(fC, a - 0.07, a + 0.07, yOut + 0.06, 4.25, mid - 0.07, mid + 0.07),
          posts: postAs.filter((pa) => Math.abs(pa - a) < 0.07).flatMap((pa) => [faceAabb(fC, pa - 0.06, pa + 0.06, 0, yOut, front + 0.45, front + 0.57), faceAabb(fC, pa - 0.06, pa + 0.06, 0, yOut, S - front - 0.57, S - front - 0.45)]),
          awningEdges: [faceAabb(fC, a - 0.01, a + 0.01, yOut - 0.1, yOut, front + 0.69, front + 0.7), faceAabb(fC, a - 0.01, a + 0.01, yOut - 0.1, yOut, S - front - 0.7, S - front - 0.69)],
        });
        G.steel.push(...fC.bx(a - 0.07, a + 0.07, yOut - 0.08, yOut + 0.06, front + 0.45, S - front - 0.45));
        fC.coll(a - 0.07, a + 0.07, yOut - 0.08, yOut + 0.06, front + 0.45, S - front - 0.45, -1, 'STEEL');
        G.steel.push(...fC.bx(a - 0.07, a + 0.07, yOut + 0.06, 4.25, mid - 0.07, mid + 0.07));
        G.steel.push(beam(fC.P3(a, yOut, front + 0.51), fC.P3(a, 4.28, mid), 0.07), beam(fC.P3(a, yOut, S - front - 0.51), fC.P3(a, 4.28, mid), 0.07));
      }
      for (let a = sA0 + 1.5; a < sA1; a += 3) {
        G.steel.push(...fC.bx(a - 0.015, a + 0.015, 3.86, 3.89, front + 0.6, S - front - 0.6));
        for (const q of [0.38, 0.5, 0.62]) G.strips.push(fC.glow(PAL[Math.floor(a + q * 7) % PAL.length], 1.5, a - 0.13, a + 0.13, 3.45, 3.78, q * S - 0.13, q * S + 0.13));
      }
      for (let a = sA0 + 2; a < sA1; a += 6) {
        const p = fC.P3(a, 3.1, mid);
        if (!lightNear(p.x, p.y, p.z, 4)) addLight(p.x, p.y, p.z, PAL[Math.floor(a) % PAL.length], 1.7);
      }
      const v = fC.P3(sA1 + 0.55, 0, mid + aisle / 2 - 0.6);
      if (inArea(v.x, v.z, 2)) addVending(v.x, v.z, alongX ? -Math.PI / 2 : Math.PI, 1.0);
      if (park) for (const q of [0.3, 0.7]) {
        const c = fC.P3(a0 + park / 2 + 0.3, 0, q * S);
        parkingSlots.push({ x: c.x, z: c.z, y: 0, yaw: alongX ? Math.PI / 2 : 0, onHighway: false });
      }
    });

    // ------------------------------------------------------------------ 9. street lamps + curbside slots
    const carSlots: CarSlot[] = [];
    const occupied = (x: number, z: number, m: number): boolean =>
      intersectionSquares.some((r) => insideRect(x, z, r, m)) ||
      crosswalkZones.some((r) => insideRect(x, z, r, m)) ||
      rampRects.some((r) => insideRect(x, z, r, m)) ||
      pierRects.some((r) => insideRect(x, z, r, m + 1));
    // 7B-4: cantilever traffic signals on the corners of every street junction (4 on avenue crossings, else 2),
    // ≤ 32 per sector. The arm reaches over the lanes it controls; the crossing axis runs 12.5 s out of phase.
    {
      const C = CITY_FX;
      const cyc = C.SIGNAL_GREEN_S + C.SIGNAL_YELLOW_S + C.SIGNAL_RED_S;
      const junctions: Array<{ r: RectXZ; plaza: boolean }> = intersectionSquares.map((r) => ({ r, plaza: false }));
      if (plan.plaza) junctions.unshift({ r: plan.plaza, plaza: true });
      for (const { r, plaza } of junctions) {
        if (signalCount >= C.SIGNALS_MAX) break;
        const cx = (r.x0 + r.x1) / 2;
        const cz = (r.z0 + r.z1) / 2;
        if (!inArea(cx, cz, 4)) continue;
        const hx = (r.x1 - r.x0) / 2;
        const hz = (r.z1 - r.z0) / 2;
        const big = plaza || (hx * 2 >= LEVEL.AVENUE_WIDTH_M - 0.1 && hz * 2 >= LEVEL.AVENUE_WIDTH_M - 0.1);
        // The scramble plaza's corners carry light masts: its signals stand 2.5 m further along the kerb.
        const extra = plaza ? 2.5 : 0;
        const off = srng() * cyc;
        const corners: Array<[number, number, 'z' | 'x']> = big
          ? [[1, 1, 'z'], [-1, -1, 'z'], [1, -1, 'x'], [-1, 1, 'x']]
          : [[1, 1, 'z'], [-1, -1, 'x']];
        for (const [sx, sz, ctl] of corners) {
          if (signalCount >= C.SIGNALS_MAX) break;
          const px = cx + sx * (hx + 0.85 + (ctl === 'x' ? extra : 0));
          const pz = cz + sz * (hz + 0.85 + (ctl === 'z' ? extra : 0));
          // Arm over the controlled street: z-traffic → across x toward the centre; x-traffic → across z.
          const yaw = ctl === 'z' ? (sx > 0 ? Math.PI : 0) : (sz > 0 ? Math.PI / 2 : -Math.PI / 2);
          placeInstance(this.signals, signalCount, px, 0, pz, yaw);
          signalPhase.setX(signalCount, off + (ctl === 'x' ? C.SIGNAL_GREEN_S + C.SIGNAL_YELLOW_S : 0));
          colliders.push({ min: new THREE.Vector3(px - 0.13, 0, pz - 0.13), max: new THREE.Vector3(px + 0.13, C.SIGNAL_POLE_H, pz + 0.13), kind: 'PROP', building: -1 });
          signalCount++;
        }
      }
    }
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
    // 10D-1: the expressway decks carry moving traffic now — every parked car stands on a ground slot.
    const pick: CarSlot[] = [];
    for (const c of shuffle([...carSlots, ...parkingSlots].filter(farFromSpawn))) {
      if (pick.length >= nCars) break;
      if (pick.some((o) => Math.abs(o.y - c.y) < 1 && Math.hypot(o.x - c.x, o.z - c.z) < 5.2)) continue;
      pick.push(c);
    }
    if (pick.length !== nCars) throw new Error(`Sector ${sector.index}: placed ${pick.length}/${nCars} parked cars`);
    const carDims = CAR_DIMS;
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
      // 7B-1: head lights (white / cyan, amber when the hazards run) and red tail lights reflect on the road.
      {
        const aCar = mesh.geometry.getAttribute('aCar') as THREE.InstancedBufferAttribute;
        const cyan = aCar.getX(idx) > 0.5;
        const hazard = aCar.getZ(idx) > 0.5;
        const phase = aCar.getW(idx);
        const half = carDims[variant][2] / 2 + 0.6;
        const sx = Math.sin(c.yaw);
        const sz = Math.cos(c.yaw);
        addLight(c.x + sx * half, c.y + 0.75, c.z + sz * half, hazard ? COLORS.CAR_HAZARD : cyan ? COLORS.CAR_LED_CYAN : COLORS.CAR_LED_WHITE, hazard ? 1.3 : 1.8);
        addLight(c.x - sx * half, c.y + 0.8, c.z - sz * half, COLORS.CAR_LED_REAR, 1.4);
        // 7B-4: six paints (one in ~6 is a cyber-taxi).
        const paint = Math.floor(prng() * CITY_FX.CAR_PAINTS.length);
        (mesh.geometry.getAttribute('aPaint') as THREE.InstancedBufferAttribute).setX(idx, paint);
        paintCounts[paint]++;
        // 7B-4: head / tail light pools on the road surface (front 4.5 m, rear 2.8 m).
        const C = CITY_FX;
        const L2 = carDims[variant][2] / 2;
        for (const front of [true, false]) {
          const len = front ? C.POOL_FRONT_LEN : C.POOL_REAR_LEN;
          const wid = front ? C.POOL_FRONT_W : C.POOL_REAR_W;
          const dir = front ? 1 : -1;
          const d = L2 - 0.15 + len / 2;
          placeInstance(this.carPools, poolCount, c.x + sx * d * dir, c.y + 0.03, c.z + sz * d * dir, front ? c.yaw : c.yaw + Math.PI, wid, 1, len);
          _col.setHex(front ? (cyan ? COLORS.CAR_LED_CYAN : COLORS.CAR_LED_WHITE) : COLORS.CAR_LED_REAR);
          poolA.setXYZW(poolCount, _col.r, _col.g, _col.b, front ? C.POOL_FRONT_GAIN : C.POOL_REAR_GAIN);
          poolB.setXYZW(poolCount, hazard ? 1 : 0, phase, front ? 1 : 0, 0);
          poolCount++;
        }
      }
      const [w, hgt, l] = carDims[variant];
      const alongZ = Math.abs(Math.cos(c.yaw)) > 0.5;
      const hx = (alongZ ? w : l) / 2;
      const hz = (alongZ ? l : w) / 2;
      colliders.push({ min: new THREE.Vector3(c.x - hx, c.y, c.z - hz), max: new THREE.Vector3(c.x + hx, c.y + hgt, c.z + hz), kind: 'CAR', building: -1 });
      if (!c.onHighway) {
        extraShadows.push({ x: c.x, z: c.z, yaw: c.yaw, w: w * 1.18, d: l * 1.08, alpha: 0.72 });
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
        // 10A-2: snap farTower signs strictly to the exact cardinal face (±X / ±Z) facing the city centre.
        const faceX = Math.abs(t.x) >= Math.abs(t.z);
        const sg = faceX ? (t.x > 0 ? -1 : 1) : t.z > 0 ? -1 : 1;
        const nx = faceX ? sg : 0;
        const nz = faceX ? 0 : sg;
        const halfDepth = (faceX ? t.w : t.d) / 2;
        const faceWidth = faceX ? t.d : t.w;
        const sh = Math.min(26 + (i % 7) * 5, t.top - 12);
        if (sh >= 8 && faceWidth >= 4) {
          const sw = Math.min(sh / 6.5, faceWidth - 2);
          const yLo = sh / 2 + 4.0;
          const yHi = t.top - sh / 2 - 4.0;
          if (yHi >= yLo) {
            const y = Math.min(yHi, Math.max(yLo, 70 + (i % 5) * 18));
            addNeon(t.x + nx * (halfDepth + 0.35), y, t.z + nz * (halfDepth + 0.35), nx, nz, sw, sh, i, 0, { kind: 'FAR_TOWER', farIndex: i });
          }
        }
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
    // 10D-Fix FIX-4: traffic lanes are built here (same own RNG stream, consumed again by setLanes below) so no
    // highway spawn ever lands inside a moving lane.
    const trafficRng = createRng(0x10d1 + sector.index * 71 + loop * 433);
    const trafficLanes = buildTrafficLanes(plan.highways, !!plan.plaza && plan.highways.length === 4, trafficRng);
    decks.forEach((d) => {
      for (let a = Math.max(d.a0, -H + 10); a < Math.min(d.a1, H - 10); a += 18) {
        // 10D-1: Sector 5's ring lanes run 3.8 / 4.0 m off the centreline — its deck spawns stay nearer the median.
        const spawnLat = plan.plaza && plan.highways.length === 4 ? 1.8 : 2.5;
        const p = pt(d.axis, a, DECK, d.coord + (rng() < 0.5 ? -spawnLat : spawnLat));
        if (Math.hypot(p.x - playerSpawn.x, p.z - playerSpawn.z) > 25 && !inTrafficLane(trafficLanes, p.x, p.z, 0.85)) highwaySpawns.push({ position: p, layer: 1, building: -1 });
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

    // ------------------------------------------------------------------ 9B. micro-props, clutter, decals
    // World blocker for every prop: non-ground colliders at the prop's height, ramp / stair flights, lamp poles and
    // riser pipes (no colliders), water and the lockdown boundary.
    const propBlockers: Aabb3[] = [];
    for (const c of colliders) {
      if (c.kind === 'GROUND' || c.kind === 'BARRIER') continue;
      propBlockers.push({ minX: c.min.x, minY: c.min.y, minZ: c.min.z, maxX: c.max.x, maxY: c.max.y, maxZ: c.max.z });
    }
    for (const rp of rampColliders) {
      const [l0, l1] = [rp.lateralMin, rp.lateralMax];
      const [a0, a1] = [Math.min(rp.alongStart, rp.alongEnd), Math.max(rp.alongStart, rp.alongEnd)];
      const y0 = Math.min(rp.yStart, rp.yEnd) - rp.thickness;
      const y1 = Math.max(rp.yStart, rp.yEnd) + 1.2;
      propBlockers.push(rp.axis === 'x' ? { minX: a0, minY: y0, minZ: l0, maxX: a1, maxY: y1, maxZ: l1 } : { minX: l0, minY: y0, minZ: a0, maxX: l1, maxY: y1, maxZ: a1 });
    }
    for (const [x, z] of lampPoles) propBlockers.push({ minX: x - 0.18, minY: 0, minZ: z - 0.18, maxX: x + 0.18, maxY: 7, maxZ: z + 0.18 });
    propBlockers.push(...propObstacles);
    const blockGrid = new Map<number, Aabb3[]>();
    const bkey = (i: number, j: number): number => (i + 512) * 1024 + (j + 512);
    for (const bb of propBlockers) {
      if (bb.maxX - bb.minX > 60 || bb.maxZ - bb.minZ > 60) continue;
      for (let i = Math.floor(bb.minX / 4); i <= Math.floor(bb.maxX / 4); i++) {
        for (let j = Math.floor(bb.minZ / 4); j <= Math.floor(bb.maxZ / 4); j++) {
          const l = blockGrid.get(bkey(i, j));
          if (l) l.push(bb);
          else blockGrid.set(bkey(i, j), [bb]);
        }
      }
    }
    const bigBlockers = propBlockers.filter((bb) => bb.maxX - bb.minX > 60 || bb.maxZ - bb.minZ > 60);
    const propBlocked = (x0: number, z0: number, x1: number, z1: number, y0: number, y1: number): boolean => {
      if (!inArea(x0, z0, 1) || !inArea(x1, z1, 1)) return true;
      if (y0 < 0.5 && canalWater.some((r) => x1 > r.x0 - 0.3 && x0 < r.x1 + 0.3 && z1 > r.z0 - 0.3 && z0 < r.z1 + 0.3)) return true;
      const hit = (bb: Aabb3): boolean => x1 > bb.minX + 0.015 && x0 < bb.maxX - 0.015 && z1 > bb.minZ + 0.015 && z0 < bb.maxZ - 0.015 && y1 > bb.minY + 0.01 && y0 < bb.maxY - 0.01;
      if (bigBlockers.some(hit)) return true;
      for (let i = Math.floor(x0 / 4); i <= Math.floor(x1 / 4); i++) {
        for (let j = Math.floor(z0 / 4); j <= Math.floor(z1 / 4); j++) {
          const l = blockGrid.get(bkey(i, j));
          if (l && l.some(hit)) return true;
        }
      }
      return false;
    };
    // 9B-1 per-door / per-bay socket props.
    const composed = composeSockets(propSockets, propBlocked);
    const socketProps: PropInstance[] = [...composed.bays];
    for (const d of composed.doors) socketProps.push(...d.props);
    let adjacentPairs = 0;
    let adjacentClones = 0;
    composed.doors.forEach((d, i) => {
      const prev = composed.doors[i - 1];
      if (!prev || prev.door !== d.door - 1 || prev.building !== d.building || Math.abs(prev.y - d.y) > 0.5) return;
      adjacentPairs++;
      if (prev.signature === d.signature) adjacentClones++;
    });
    // 9B-2 clutter strips: alleys (clear centre path), sidewalk walls, kerbs, L courtyards, underpasses, plazas,
    // canal promenades.
    const strips: ClutterStrip[] = [];
    alleyRecs.forEach((al, i) => strips.push(...alleyStrips(al, p9Rng(), 0.26, alleyService[i])));
    for (const g of groundFaces) {
      if (g.alley) continue;
      const { span } = g;
      const along: Axis = span.ax === 'x' ? 'z' : 'x';
      const court = span.court;
      // Infra / back-of-house street frontage (not a wall-run face) takes dumpsters and pallets.
      const service = !court && !g.run && faceProgram.get(g) === 'ALLEY_INFRA';
      strips.push({
        kind: court ? 'COURT' : service ? 'SERVICE' : 'WALL',
        ax: along,
        a0: span.a0 + 0.6,
        a1: span.a1 - 0.6,
        line: span.plane,
        sg: span.sg,
        d0: 0.42,
        d1: court ? 2.4 : service ? 1.62 : galleryFaces.has(g.key) ? 1.15 : 1.35,
        run: g.run,
        y: 0,
        seed: p9Rng(),
        spacing: court ? 3.4 : service ? 4.5 : 7.5,
      });
    }
    streets.forEach((st, si) => {
      const lh = laneHalf(st.kind);
      for (const [a0, a1] of segmentsByStreet[si]) {
        for (const side of [-1, 1] as const) {
          strips.push({ kind: 'CURB', ax: st.axis, a0: a0 + 3, a1: a1 - 3, line: st.coord + side * lh, sg: side, d0: 0.3, d1: 1.05, run: false, y: 0, seed: p9Rng(), spacing: 11 });
        }
      }
    });
    for (const pl of pierLines) {
      const lat = pl.axis === 'x' ? pl.z : pl.x;
      const al = pl.axis === 'x' ? pl.x : pl.z;
      for (const side of [-1, 1] as const) {
        strips.push({ kind: 'UNDERPASS', ax: pl.axis, a0: al - 4.5, a1: al + 4.5, line: lat + side * 0.7, sg: side, d0: 0.15, d1: 1.7, run: false, y: 0, seed: p9Rng(), spacing: 3.5 });
      }
    }
    for (const r of [...plazas, ...(plan.plaza ? [plan.plaza] : [])]) {
      if (r.x1 - r.x0 < 8 || r.z1 - r.z0 < 8) continue;
      strips.push({ kind: 'OPEN', ax: 'x', a0: r.x0 + 1, a1: r.x1 - 1, line: r.z0, sg: 1, d0: 0.6, d1: 1.6, run: false, y: 0, seed: p9Rng(), spacing: 6 });
      strips.push({ kind: 'OPEN', ax: 'x', a0: r.x0 + 1, a1: r.x1 - 1, line: r.z1, sg: -1, d0: 0.6, d1: 1.6, run: false, y: 0, seed: p9Rng(), spacing: 6 });
    }
    for (const c of canals) {
      for (const side of [-1, 1] as const) {
        strips.push({ kind: 'CURB', ax: c.axis, a0: Math.max(c.from, -H) + 4, a1: Math.min(c.to, H) - 4, line: c.coord + side * (c.width / 2), sg: side, d0: 0.55, d1: 1.4, run: false, y: 0, seed: p9Rng(), spacing: 9 });
      }
    }
    const clutterSpawns = [...groundSpawns.map((sp) => ({ x: sp.position.x, z: sp.position.z })), { x: playerSpawn.x, z: playerSpawn.z }, { x: gatePos.x, z: gatePos.z }];
    const clutter = planClutter({
      strips,
      forbid: [...doorClearZones.filter((r) => r.y < 1), ...crosswalkZones, ...intersectionSquares, ...rampRects],
      spawns: clutterSpawns,
      occupied: socketProps.filter((p) => p.y0 < 1).map(toAabb),
      blocked: propBlocked,
    });
    for (const c of clutter.colliders) colliders.push({ min: new THREE.Vector3(c.minX, c.minY, c.minZ), max: new THREE.Vector3(c.maxX, c.maxY, c.maxZ), kind: 'PROP', building: -1 });
    // 9B-3 decals: shutters, alley / infra piers (gathered above), highway piers, dumpster fronts.
    for (const pl of pierLines) {
      if (!inArea(pl.x, pl.z, 2)) continue;
      for (const [nAx, sg] of [['x', 1], ['x', -1], ['z', 1], ['z', -1]] as const) {
        const c = nAx === 'x' ? pl.z : pl.x;
        decalSurfaces.push({ kind: 'HWPIER', nAx, sg, plane: (nAx === 'x' ? pl.x : pl.z) + sg * 0.7, a0: c - 0.6, a1: c + 0.6, y0: 0.6, y1: 3.8, seed: p9Rng() });
      }
    }
    for (const it of clutter.items) {
      if (it.kit !== 'DUMPSTER') continue;
      const nx = Math.round(Math.sin(it.yaw));
      const nz = Math.round(Math.cos(it.yaw));
      const nAx: Axis = Math.abs(nx) > 0 ? 'x' : 'z';
      const sg = (nAx === 'x' ? nx : nz) > 0 ? 1 : -1;
      const c = nAx === 'x' ? it.z : it.x;
      decalSurfaces.push({ kind: 'DUMPSTER', nAx, sg, plane: (nAx === 'x' ? it.x : it.z) + sg * 0.575, a0: c - 0.78, a1: c + 0.78, y0: 0.18, y1: 0.92, seed: p9Rng() });
    }
    const decals = planDecals([...decalSurfaces].sort((p, q) => p.seed - q.seed));
    const alleyBands = alleyRecs.map((al) => ({ ...alleyCentreBand(al), width: al.gap1 - al.gap0 }));

    // ------------------------------------------------------------------ 15b. 10C-3 streetscape details
    // Curb LED guide bars, open-frame English scaffold neon, corrugated shacks, steel gantries (all merged into the
    // existing G.* buckets, +0 calls) and the StreetFurnishingsKit (lantern strings v0, cafe parasols v1; +1 call).
    // A dedicated RNG keeps every earlier random stream (and layout) untouched.
    const p10Rng = createRng(0x10c3 + sector.index * 71 + loop * 433);
    const hitsSign = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): boolean =>
      signBoxes.some((o) => x0 < o.x1 && x1 > o.x0 && y0 < o.y1 && y1 > o.y0 && z0 < o.z1 && z1 > o.z0);
    const hitsCollider = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, skipBuilding = -2): boolean =>
      colliders.some((c) => c.kind !== 'BARRIER' && c.building !== skipBuilding && x0 < c.max.x && x1 > c.min.x && y0 < c.max.y && y1 > c.min.y && z0 < c.max.z && z1 > c.min.z);
    const stat = { curbLeds: 0, scaffolds: 0, shacks: 0, gantries: 0, lanternStrings: 0, parasols: 0 };

    // (1) Glowing sidewalk curb LED guide bars: 1.8 m every 5 m along avenue kerbs (cyan / warm white / crimson, 0.95).
    const CURB_LED = [0x20d8ff, 0xffe0a8, 0xff3050];
    const curbLedBoxes: Array<{ box: Aabb3; axis: Axis; kerb: number; side: 1 | -1 }> = [];
    streets.forEach((st, si) => {
      if (st.kind !== 'AVENUE') return;
      const lh = laneHalf(st.kind);
      for (const [a0, a1] of segmentsByStreet[si]) {
        for (const side of [-1, 1] as const) {
          let k = 0;
          for (let a = a0 + 3.5; a + 1.8 < a1 - 3.5; a += 5, k++) {
            const c = a + 0.9;
            // 10BC-Fix FIX-7: on the curb's upper road-facing lip, 1.5 cm proud of both the gutter face and the top.
            const l = st.coord + side * (lh + 0.01);
            const cx = st.axis === 'x' ? c : l;
            const cz = st.axis === 'x' ? l : c;
            if (crosswalkZones.some((r) => cx > r.x0 - 1.2 && cx < r.x1 + 1.2 && cz > r.z0 - 1.2 && cz < r.z1 + 1.2)) continue;
            if (!inArea(cx, cz, 2)) continue;
            G.strips.push(withColor(st.axis === 'x' ? boxAt(1.8, 0.04, 0.05, cx, 0.115, cz) : boxAt(0.05, 0.04, 1.8, cx, 0.115, cz), CURB_LED[(k + si + (side > 0 ? 1 : 0)) % CURB_LED.length], 0.95));
            stat.curbLeds++;
            const hl = st.axis === 'x' ? [0.9, 0.025] : [0.025, 0.9];
            curbLedBoxes.push({ box: { minX: cx - hl[0], minY: 0.095, minZ: cz - hl[1], maxX: cx + hl[0], maxY: 0.135, maxZ: cz + hl[1] }, axis: st.axis, kerb: st.coord + side * lh, side });
          }
        }
      }
    });

    // (2) Open-frame steel lattice scaffolds with English tube-letter neon (OPEN 24H / CYBER RAMEN / NIGHT BAR /
    //     MOTEL 09) standing on low roofs / podium parapets behind the street edge.
    const WORDS = [SIGN_ATLAS.WORD_ROWS.OPEN_24H, SIGN_ATLAS.WORD_ROWS.CYBER_RAMEN, SIGN_ATLAS.WORD_ROWS.NIGHT_BAR, SIGN_ATLAS.WORD_ROWS.MOTEL_09];
    const SCAFFOLD_MAX = 9;
    const SCAFFOLD_LEN = 10;
    const order = buildings.map((b) => ({ b, k: p10Rng() })).sort((p, q) => p.k - q.k).map((o) => o.b);
    let wordIdx = Math.floor(p10Rng() * WORDS.length);
    for (const b of order) {
      if (stat.scaffolds >= SCAFFOLD_MAX) break;
      if (megaBuilding.has(b.index)) continue;
      for (const sp of b.plan.faces) {
        if (!sp.lot || sp.court || sp.y0 > 0.01 || sp.y1 < 4.5 || sp.y1 > 12.5 || sp.a1 - sp.a0 < SCAFFOLD_LEN + 3) continue;
        if (alleyFaces.has(fkey(b, sp.ax, sp.sg)) || (sp.sg * sp.plane > 0 && H - Math.abs(sp.plane) < 3.5)) continue;
        const f = sf(sp.ax, sp.sg, sp.plane);
        const roofY = sp.y1;
        const a = sp.a0 + SCAFFOLD_LEN / 2 + 1.5 + p10Rng() * (sp.a1 - sp.a0 - SCAFFOLD_LEN - 3);
        const lo = f.P3(a - SCAFFOLD_LEN / 2, roofY, -1.6);
        const hi = f.P3(a + SCAFFOLD_LEN / 2, roofY + 2.8, -0.4);
        const fp = rectFrom(Math.min(lo.x, hi.x), Math.min(lo.z, hi.z), Math.max(lo.x, hi.x), Math.max(lo.z, hi.z));
        // Solid low roof underneath: a plate at this height covering the footprint, no taller box over it.
        const plate = b.plan.plates.find((pl) => !pl.round && Math.abs(pl.y - roofY) < 1e-3 && fp.x0 >= pl.x0 - 1e-3 && fp.x1 <= pl.x1 + 1e-3 && fp.z0 >= pl.z0 - 1e-3 && fp.z1 <= pl.z1 + 1e-3);
        if (!plate) continue;
        if (b.plan.boxes.some((bx) => bx.y0 >= roofY - 0.05 && fp.x0 < bx.x1 + 0.4 && fp.x1 > bx.x0 - 0.4 && fp.z0 < bx.z1 + 0.4 && fp.z1 > bx.z0 - 0.4)) continue;
        if (roofRects[b.index].some((o) => rectsOverlap(fp, o, 0.6))) continue;
        if (hitsCollider(fp.x0, roofY, fp.z0, fp.x1, roofY + 3.2, fp.z1)) continue;
        const sc = f.P3(a, roofY + 1.75, -1.0);
        if (!addNeon(sc.x, sc.y, sc.z, f.nx, f.nz, SCAFFOLD_LEN, 0.62, WORDS[wordIdx % WORDS.length], 1, { kind: 'SCAFFOLD', building: b.index })) continue;
        wordIdx++;
        roofRects[b.index].push(fp);
        // Lattice behind the letters: end + centre posts, two chords, zig-zag braces, foot plates.
        const d0 = -1.3;
        const d1 = -1.16;
        for (const pa of [a - SCAFFOLD_LEN / 2, a, a + SCAFFOLD_LEN / 2 - 0.14]) G.steel.push(...f.bx(pa, pa + 0.14, roofY, roofY + 2.8, d0, d1));
        G.steel.push(...f.bx(a - SCAFFOLD_LEN / 2, a + SCAFFOLD_LEN / 2, roofY + 0.9, roofY + 0.98, d0, d1), ...f.bx(a - SCAFFOLD_LEN / 2, a + SCAFFOLD_LEN / 2, roofY + 2.55, roofY + 2.63, d0, d1));
        for (let i = 0; i < 8; i++) {
          const ax0 = a - SCAFFOLD_LEN / 2 + (SCAFFOLD_LEN * i) / 8;
          const ax1 = ax0 + SCAFFOLD_LEN / 8;
          const up = i % 2 === 0;
          G.steel.push(beam(f.P3(ax0, roofY + (up ? 0.94 : 2.59), -1.23), f.P3(ax1, roofY + (up ? 2.59 : 0.94), -1.23), 0.06));
        }
        for (const pa of [a - SCAFFOLD_LEN / 2, a + SCAFFOLD_LEN / 2 - 0.14]) G.steel.push(...f.bx(pa - 0.1, pa + 0.24, roofY, roofY + 0.06, d0 - 0.12, d1 + 0.12));
        // Standoff brackets tying the letters to the frame.
        for (const pa of [a - SCAFFOLD_LEN / 2 + 0.6, a, a + SCAFFOLD_LEN / 2 - 0.6]) G.steel.push(...f.bx(pa - 0.03, pa + 0.03, roofY + 1.5, roofY + 2.0, -1.16, -1.0));
        stat.scaffolds++;
        break;
      }
    }

    // (3) Slanted corrugated sheet-metal shacks on low podium / wing roofs (rust + gunmetal ribs, AC + pipe, neon wash).
    const SHACK_MAX = 12;
    const RUST = [0x5a3a2a, 0x3a4048, 0x4a3226, 0x30363e];
    for (const b of order) {
      if (stat.shacks >= SHACK_MAX) break;
      if (megaBuilding.has(b.index)) continue;
      for (const pl of b.plan.plates) {
        if (pl.round || pl.y < 4 || pl.y > 8.6 || pl.x1 - pl.x0 < 7 || pl.z1 - pl.z0 < 7) continue;
        let placed = false;
        for (let tries = 0; tries < 8 && !placed; tries++) {
          const alongX = p10Rng() < 0.5;
          const W = 3 + p10Rng() * 2; // 3–5 m along the wall
          const D = 2.6 + p10Rng() * 0.6;
          const hx = (alongX ? W : D) / 2;
          const hz = (alongX ? D : W) / 2;
          const x = pl.x0 + 1.4 + hx + p10Rng() * Math.max(0, pl.x1 - pl.x0 - 2.8 - 2 * hx);
          const z = pl.z0 + 1.4 + hz + p10Rng() * Math.max(0, pl.z1 - pl.z0 - 2.8 - 2 * hz);
          if (x + hx > pl.x1 - 1.3 || z + hz > pl.z1 - 1.3) continue;
          // 10BC-Fix FIX-11: the footprint also covers the exterior AC unit on the +lateral side (reach hL + 0.53 m).
          const fp = rectFrom(x - hx - 0.35, z - hz - 0.35, x + hx + 0.35 + (alongX ? 0.58 : 0), z + hz + 0.35 + (alongX ? 0 : 0.58));
          if (b.plan.boxes.some((bx) => bx.y0 >= pl.y - 0.05 && fp.x0 < bx.x1 + 0.5 && fp.x1 > bx.x0 - 0.5 && fp.z0 < bx.z1 + 0.5 && fp.z1 > bx.z0 - 0.5)) continue;
          if (roofRects[b.index].some((o) => rectsOverlap(fp, o, 0.7))) continue;
          if (hitsCollider(fp.x0, pl.y, fp.z0, fp.x1, pl.y + 3.2, fp.z1)) continue;
          if (hitsSign(fp.x0, pl.y, fp.z0, fp.x1, pl.y + 3.2, fp.z1)) continue;
          roofRects[b.index].push(fp);
          placed = true;
          // Shack frame: depth axis `da` runs back (high, against the nearer parapet) → front (low).
          const da: Axis = alongX ? 'z' : 'x';
          const la: Axis = alongX ? 'x' : 'z';
          const cDepth = alongX ? z : x;
          const cLat = alongX ? x : z;
          const hL = alongX ? hx : hz;
          const depthHalf = alongX ? hz : hx;
          // Back toward the nearer plate edge along the depth axis.
          const back = (alongX ? z - pl.z0 < pl.z1 - z : x - pl.x0 < pl.x1 - x) ? -1 : 1;
          const aBack = cDepth + back * depthHalf;
          const aFront = cDepth - back * depthHalf;
          const yB = pl.y;
          const hBack = 2.85;
          const hFront = 2.15;
          const tint = RUST[Math.floor(p10Rng() * RUST.length)];
          // Side walls (sloped tops), back wall, front posts.
          for (const sgn of [-1, 1] as const) {
            const l = cLat + sgn * (hL - 0.05);
            G.archPaint.push(withTint(slopedPrism(da, aBack, aFront, l - 0.05, l + 0.05, yB, yB + hBack, yB, yB + hFront), tint));
          }
          const bw = la === 'x' ? boxAt(2 * hL, hBack, 0.1, cLat, yB + hBack / 2, aBack) : boxAt(0.1, hBack, 2 * hL, aBack, yB + hBack / 2, cLat);
          G.archPaint.push(withTint(ensureAo(bw), tint));
          // Corrugated roof: sloped slab with overhang + ribs along the slope, a lit eave strip facing the open front.
          const oh = 0.35;
          G.steel.push(slopedPrism(da, aBack + back * 0.1, aFront - back * oh, cLat - hL - 0.2, cLat + hL + 0.2, yB + hBack - 0.08, yB + hBack, yB + hFront - 0.08, yB + hFront));
          for (let r = 0; r < 11; r++) {
            const l = cLat - hL - 0.1 + ((2 * hL + 0.2) * (r + 0.5)) / 11;
            G.steel.push(beam(pt(da, aBack + back * 0.1, yB + hBack + 0.03, l), pt(da, aFront - back * oh, yB + hFront + 0.03, l), 0.045, 0.05));
          }
          const neon = [0x20d8ff, 0xff2bd6, 0xffa21f][Math.floor(p10Rng() * 3)];
          G.strips.push(withColor(la === 'x' ? boxAt(2 * hL, 0.05, 0.05, cLat, yB + hFront - 0.2, aFront - back * (oh - 0.05)) : boxAt(0.05, 0.05, 2 * hL, aFront - back * (oh - 0.05), yB + hFront - 0.2, cLat), neon, 1.1));
          // Small exterior AC unit on the side + a riser pipe up the back wall.
          const sideL = cLat + hL + 0.28;
          G.steel.push(la === 'x' ? boxAt(0.5, 0.48, 0.55, sideL, yB + 0.24, cDepth) : boxAt(0.55, 0.48, 0.5, cDepth, yB + 0.24, sideL));
          G.steel.push(beam(pt(da, aBack - back * 0.1, yB, cLat - hL * 0.5), pt(da, aBack - back * 0.1, yB + hBack + 0.5, cLat - hL * 0.5), 0.07));
          colliders.push({ min: new THREE.Vector3(Math.min(x - hx, x + hx), pl.y, z - hz), max: new THREE.Vector3(x + hx, pl.y + hFront, z + hz), kind: 'PROP', building: b.index });
          stat.shacks++;
        }
        if (placed) break;
      }
    }

    // (4) Overhead steel gantries across avenues (y 14–20 m, grapple-able) with blinking red beacon dots.
    const GANTRY_MAX = 5;
    // Avenues first, then side streets (keeps 4–5 gantries per district where the street walls allow it).
    const gantryOrder = streets.map((st, si) => ({ st, si })).sort((p, q) => (p.st.kind === 'AVENUE' ? 0 : 1) - (q.st.kind === 'AVENUE' ? 0 : 1)).map((o) => o.si);
    for (const si of gantryOrder) {
      if (stat.gantries >= GANTRY_MAX) break;
      // 10BC-Fix FIX-12: the 30 m spacing compares positions along this street only (never across x / z streets).
      const gantryAt: number[] = [];
      const st = streets[si];
      const ch = corridorHalf(st);
      const across: Axis = st.axis === 'x' ? 'z' : 'x';
      const P = (l: number, y: number, al: number): THREE.Vector3 => pt(across, l, y, al);
      for (const [s0, s1] of segmentsByStreet[si]) {
        if (stat.gantries >= GANTRY_MAX || s1 - s0 < 24) continue;
        let built = false;
        for (let tryK = 0; tryK < 48 && !built; tryK++) {
        const a = s0 + 8 + (s1 - s0 - 16) * p10Rng();
        if (gantryAt.some((g) => Math.abs(g - a) < 30)) continue;
        const yTop = 14 + p10Rng() * 6;
        // Solid street-facing walls on both sides, tall enough, flush at the corridor edge.
        const wallAt = (side: -1 | 1): number | null => {
          for (const b of buildings) {
            for (const sp of b.plan.faces) {
              if (!sp.lot || sp.ax !== across || sp.sg !== -side || sp.y0 > yTop - 2.0 || sp.y1 < yTop + 1) continue;
              const off = side * (sp.plane - st.coord);
              if (off < ch - 0.5 || off > ch + 2.5) continue;
              if (a - 1.2 < sp.a0 + 0.6 || a + 1.2 > sp.a1 - 0.6) continue;
              return sp.plane;
            }
          }
          return null;
        };
        const pL = wallAt(-1);
        const pR = wallAt(1);
        if (pL === null || pR === null) continue;
        const l0 = pL + 0.05;
        const l1 = pR - 0.05;
        const box0 = P(l0, yTop - 2.0, a - 0.8);
        const box1 = P(l1, yTop + 0.5, a + 0.8);
        const bx0 = Math.min(box0.x, box1.x);
        const bx1 = Math.max(box0.x, box1.x);
        const bz0 = Math.min(box0.z, box1.z);
        const bz1 = Math.max(box0.z, box1.z);
        if (hitsSign(bx0, yTop - 2.0, bz0, bx1, yTop + 0.5, bz1) || hitsCollider(bx0, yTop - 2.0, bz0, bx1, yTop + 0.5, bz1)) continue;
        gantryAt.push(a);
        const Lg = l1 - l0;
        const n = Math.max(4, Math.round(Lg / 2.4));
        for (const al of [a - 0.5, a + 0.5]) {
          G.steel.push(beam(P(l0, yTop, al), P(l1, yTop, al), 0.22), beam(P(l0, yTop - 1.8, al), P(l1, yTop - 1.8, al), 0.2));
          for (let i = 0; i <= n; i++) {
            const l = l0 + (Lg * i) / n;
            G.steel.push(beam(P(l, yTop - 1.8, al), P(l, yTop, al), 0.12));
            if (i < n) {
              const l2 = l0 + (Lg * (i + 1)) / n;
              G.steel.push(beam(P(l, i % 2 === 0 ? yTop - 1.8 : yTop, al), P(l2, i % 2 === 0 ? yTop : yTop - 1.8, al), 0.1));
            }
          }
        }
        for (let i = 0; i <= n; i += 2) {
          const l = l0 + (Lg * i) / n;
          G.steel.push(beam(P(l, yTop, a - 0.5), P(l, yTop, a + 0.5), 0.1), beam(P(l, yTop - 1.8, a - 0.5), P(l, yTop - 1.8, a + 0.5), 0.1));
        }
        // End saddle plates against the walls, blinking red beacon dots along the top chord, 3 grapple anchors.
        for (const l of [l0 + 0.15, l1 - 0.15]) G.steel.push(across === 'z' ? boxAt(1.6, 2.4, 0.3, a, yTop - 0.9, l) : boxAt(0.3, 2.4, 1.6, l, yTop - 0.9, a));
        for (let l = l0 + 2; l < l1 - 1; l += 3.5) {
          const q = P(l, yTop + 0.2, a);
          addAviation(q.x, q.y, q.z);
        }
        for (const q of [0.25, 0.5, 0.75]) addBeacon(P(l0 + Lg * q, yTop + 0.3, a), 'BUILDING_CORNER');
        colliders.push({ min: new THREE.Vector3(bx0, yTop - 1.95, bz0), max: new THREE.Vector3(bx1, yTop + 0.15, bz1), kind: 'PROP', building: -1 });
        stat.gantries++;
        built = true;
        }
      }
    }

    // (5) StreetFurnishingsKit: lantern strings over eatery storefronts + alleys, rain-wet cafe parasols on terraces.
    const footprints = [...socketProps, ...clutter.items].map(toAabb);
    const stringHook = (f: SF, a: number, y: number, d: number): void => {
      G.steel.push(...f.bx(a - 0.03, a + 0.03, y - 0.04, y + 0.03, 0, d));
    };
    const eaterySeen = new Set<string>();
    for (const g of groundFaces) {
      if (stat.lanternStrings >= 26 && stat.parasols >= 14) break;
      if (g.alley || g.run || g.span.court || faceProgram.get(g) !== 'CYBER_EATERY') continue;
      const span = g.span;
      const door = groundDoors.find((d) => d.building === g.b.index && d.ax === span.ax && d.sg === span.sg && Math.abs(d.plane - span.plane) < 1e-6);
      if (!door) continue;
      const f = sf(span.ax, span.sg, span.plane);
      // 10BC-Fix FIX-6: span.ax is the wall NORMAL — an x-normal facade runs along z, so the +X string turns −90°.
      const yaw = span.ax === 'x' ? -Math.PI / 2 : 0;
      // Lantern string pier to pier across the entrance bay, 4.9 m up, 0.72 m out (clear of the exhaust duct / awning).
      const sa0 = door.bay.a0 - GR.PIER_W_M / 2;
      const sa1 = door.bay.a1 + GR.PIER_W_M / 2;
      const mid = (sa0 + sa1) / 2;
      const c = f.P3(mid, 4.9, 0.72);
      const w = sa1 - sa0;
      if (stat.lanternStrings < 26 && inArea(c.x, c.z, 2) && !hitsSign(Math.min(f.P3(sa0, 4.0, 0).x, f.P3(sa1, 5.0, 0.9).x) - 0.1, 3.9, Math.min(f.P3(sa0, 4.0, 0).z, f.P3(sa1, 5.0, 0.9).z) - 0.1, Math.max(f.P3(sa0, 4.0, 0).x, f.P3(sa1, 5.0, 0.9).x) + 0.1, 5.05, Math.max(f.P3(sa0, 4.0, 0).z, f.P3(sa1, 5.0, 0.9).z) + 0.1) && addKit(KIT_VARIANT.LANTERNS, c.x, c.y, c.z, yaw, w / 4.2, 0)) {
        stringHook(f, sa0, 4.9, 0.72);
        stringHook(f, sa1, 4.9, 0.72);
        if (!lightNear(c.x, 4.2, c.z, 3.2)) addLight(c.x, 4.0, c.z, 0xff5a28, 1.0);
        stat.lanternStrings++;
      }
      // Cafe parasol beside the entrance: base 2.0 m from the wall, canopy r 1.28 m, never in a clear zone / prop.
      const key = `${g.b.index}:${span.ax}:${span.sg}`;
      if (stat.parasols >= 14 || eaterySeen.has(key)) continue;
      for (const off of [door.w / 2 + 3.4, -(door.w / 2 + 3.4)]) {
        const a = door.a + off;
        if (a - 1.4 < span.a0 || a + 1.4 > span.a1) continue;
        const q = f.P3(a, 0, 2.0);
        if (!inArea(q.x, q.z, 2)) continue;
        if (crosswalkZones.some((r) => q.x > r.x0 - 1.6 && q.x < r.x1 + 1.6 && q.z > r.z0 - 1.6 && q.z < r.z1 + 1.6)) continue;
        if (doorClearZones.some((r) => r.y < 1 && q.x + 0.6 > r.x0 && q.x - 0.6 < r.x1 && q.z + 0.6 > r.z0 && q.z - 0.6 < r.z1)) continue;
        if (footprints.some((fp) => fp.minY < 2.2 && q.x + 0.55 > fp.minX && q.x - 0.55 < fp.maxX && q.z + 0.55 > fp.minZ && q.z - 0.55 < fp.maxZ)) continue;
        const R = 1.3;
        // Canopy (y 2.0–2.5, r 1.3) and pole base (r 0.5) must clear every solid collider; the ground slab (max y 0) is ignored.
        if (colliders.some((cl) => cl.kind !== 'BARRIER' && cl.min.y < 2.5 && cl.max.y > 2.0 && q.x + R > cl.min.x && q.x - R < cl.max.x && q.z + R > cl.min.z && q.z - R < cl.max.z)) continue;
        if (colliders.some((cl) => cl.kind !== 'BARRIER' && cl.min.y < 0.6 && cl.max.y > 0.1 && q.x + 0.5 > cl.min.x && q.x - 0.5 < cl.max.x && q.z + 0.5 > cl.min.z && q.z - 0.5 < cl.max.z)) continue;
        if (!addKit(KIT_VARIANT.PARASOL, q.x, 0, q.z, p10Rng() * Math.PI * 2, 1, p10Rng() < 0.5 ? 0 : 1)) break;
        colliders.push({ min: new THREE.Vector3(q.x - 0.3, 0, q.z - 0.3), max: new THREE.Vector3(q.x + 0.3, 1.2, q.z + 0.3), kind: 'PROP', building: -1 });
        if (!lightNear(q.x, 2.0, q.z, 2.5)) addLight(q.x, 2.0, q.z, 0xffb060, 0.9);
        eaterySeen.add(key);
        stat.parasols++;
        break;
      }
    }
    // Narrow alleys: strings across the gap (end to end, ≤ 4.2 m pieces) at 5.6 m, never over a sign.
    for (const al of alleyRecs) {
      if (stat.lanternStrings >= 26) break;
      const gap = al.gap1 - al.gap0;
      const len = al.ov1 - al.ov0;
      if (len < 8) continue;
      const pieces = Math.max(1, Math.round(gap / 4.2));
      const sw = gap / pieces;
      const cAlong = al.ov0 + len * (0.3 + 0.4 * p10Rng());
      let ok = true;
      for (let i = 0; i < pieces && ok; i++) {
        const mid = al.gap0 + sw * (i + 0.5);
        const x = al.axis === 'x' ? mid : cAlong;
        const z = al.axis === 'x' ? cAlong : mid;
        const hx = al.axis === 'x' ? sw / 2 : 0.5;
        const hz = al.axis === 'x' ? 0.5 : sw / 2;
        if (hitsSign(x - hx, 4.8, z - hz, x + hx, 5.8, z + hz) || hitsCollider(x - hx + 0.1, 4.8, z - hz + 0.1, x + hx - 0.1, 5.8, z + hz - 0.1)) ok = false;
      }
      if (!ok) continue;
      for (let i = 0; i < pieces; i++) {
        const mid = al.gap0 + sw * (i + 0.5);
        const x = al.axis === 'x' ? mid : cAlong;
        const z = al.axis === 'x' ? cAlong : mid;
        addKit(KIT_VARIANT.LANTERNS, x, 5.6, z, al.axis === 'x' ? 0 : -Math.PI / 2, sw / 4.2, 0);
      }
      const mx = al.axis === 'x' ? (al.gap0 + al.gap1) / 2 : cAlong;
      const mz = al.axis === 'x' ? cAlong : (al.gap0 + al.gap1) / 2;
      if (!lightNear(mx, 4.8, mz, 3.5)) addLight(mx, 4.8, mz, 0xff5a28, 1.0);
      stat.lanternStrings++;
    }

    // ------------------------------------------------------------------ 11A-1b cantilevered bay-window / HVAC pods
    // 35–50 % of the non-megastructure towers carry 1–2 staggered pods (8–32 m) centred between the room piers of a
    // non-run lot feature face, ≥ 2.4 m street / alley clearance in front, clear of signs, colliders, props, openings.
    const podRng = createRng(0x11b3 + sector.index * 71 + loop * 433);
    let podCount = 0;
    let podTowers = 0;
    let podEligible = 0;
    for (const b of buildings) {
      if (isMegaKind(b.massing) || !b.plan.faces.some((sp) => sp.y1 >= 14 && !sp.court && sp.a1 - sp.a0 >= 6)) continue;
      podEligible++;
      if (podRng() > 0.85) continue;
      let placed = 0;
      for (const span of b.plan.faces) {
        if (placed >= 2) break;
        const key = fkey(b, span.ax, span.sg);
        // Never on a wall-run side (lot or set-back wall of that side); signature faces only matter on lot faces.
        if (span.court || runFaces.has(key)) continue;
        if (span.lot && ( balconyFaces.has(key) || escapeFaces.has(key) || ductFaces.has(key) || spineFaces.has(key) || galleryFaces.has(key) || megaFaces.has(key) || partialFaces.has(key))) continue;
        if (span.y1 < 14 || span.a1 - span.a0 < 6) continue;
        const hvac = podRng() < 0.35;
        const [pw, pd, ph] = hvac ? [2.4, 1.2, 2.4] : [3.2, 0.95, 2.8];
        if ((alleyFaces.has(key) ? alleyWidth.get(key) ?? 0 : 8) < 2.4 + pd) continue;
        // Faces looking at the lockdown barrier: the gap to its inner face is the clearance.
        if (span.sg * span.plane > 0 && H - 0.5 - Math.abs(span.plane) < 2.4 + pd) continue;
        const lines = roomLines(b, span.ax, span.sg, span.a0, span.a1, b.arch === ARCH_D ? 2 : 1, 0.7);
        // Centred in a wide bay between two room piers, or hung across one pier (the pier runs through the pod).
        const cands: number[] = [];
        for (let k = 0; k + 1 < lines.length; k++) if (lines[k + 1] - lines[k] - 0.42 >= pw + 0.1) cands.push((lines[k] + lines[k + 1]) / 2);
        for (const ln of lines) cands.push(ln);
        if (!lines.length) cands.push((span.a0 + span.a1) / 2);
        let a = 0;
        let yBase = 0;
        let bb: [number, number, number, number, number, number] | null = null;
        const f = sf(span.ax, span.sg, span.plane);
        // Up to 4 (position, storey) tries; own-building colliders are skipped (deep reveal piers pass through pods).
        for (let t = 0; t < 4 && !bb; t++) {
          a = cands[Math.floor(podRng() * cands.length)];
          yBase = floorTopY(b.arch, 2 + Math.floor(podRng() * 5)) + 0.15;
          if (yBase < 8 || yBase + ph > Math.min(32, span.y1 - 1.2)) continue;
          // The whole pod incl. its 45° brackets (down to yBase − depth) hangs on THIS wall span, never inside a
          // lower tier / terrace, and clear of the tower's sky-notch band.
          if (yBase - pd - 0.2 < span.y0 + 0.05) continue;
          if (skyNotches.some((sn) => sn.building === b.index && yBase - pd - 0.5 < sn.yNotch + SKY_NOTCH.H_M + 0.5 && yBase + ph + 0.5 > sn.yNotch - 0.5)) continue;
          if (a - pw / 2 < span.a0 + 0.5 || a + pw / 2 > span.a1 - 0.5) continue;
          if (openingsAt(b.index, span.ax, span.sg, span.plane, a - pw / 2 - 0.3, a + pw / 2 + 0.3, yBase - 1.2, yBase + ph + 0.3).length) continue;
          const q0 = f.P3(a - pw / 2 - 0.1, yBase - 1.1, 0.02);
          const q1 = f.P3(a + pw / 2 + 0.1, yBase + ph + 0.1, pd + 0.1);
          const box: [number, number, number, number, number, number] = [Math.min(q0.x, q1.x), yBase - 1.1, Math.min(q0.z, q1.z), Math.max(q0.x, q1.x), yBase + ph + 0.1, Math.max(q0.z, q1.z)];
          if (hitsSign(...box) || hitsCollider(...box, b.index) || [...footprints, ...propObstacles].some((o) => box[0] < o.maxX && box[3] > o.minX && box[1] < o.maxY && box[4] > o.minY && box[2] < o.maxZ && box[5] > o.minZ)) continue;
          bb = box;
        }
        if (!bb) continue;
        const pod = bayPodPieces({ ax: span.ax, sg: span.sg, plane: span.plane, a0: span.a0, a1: span.a1 }, a, yBase, pw, pd, ph, hvac);
        for (const pc of pod.shell) shellGeo(pc);
        for (const sd of pod.solids) colliders.push({ min: new THREE.Vector3(sd.x0, sd.y0, sd.z0), max: new THREE.Vector3(sd.x1, sd.y1, sd.z1), kind: 'BUILDING', building: b.index });
        for (const bm of pod.beams) G.steel.push(aoPipe(bm.a, bm.b, bm.w / 2, null));
        propObstacles.push({ minX: bb[0], minY: bb[1], minZ: bb[2], maxX: bb[3], maxY: bb[4], maxZ: bb[5] });
        placed++;
        podCount++;
        if (placed === 1) podTowers++;
      }
    }

    // ------------------------------------------------------------------ 15c. 10D-2 AnimatedEnvKit (+1 call)
    // Spinning exhaust fans on solid facade spans + machine-room flanks, noren curtains under eatery awning lips and
    // in door-free alley bays, counter-rotating wireframe holograms on tall flat roofs. Own RNG stream.
    const p10dRng = createRng(0x10d2 + sector.index * 71 + loop * 433);
    const env = this.envKit;
    env.begin();
    const faceYaw = (ax: Axis, sg: number): number => (ax === 'x' ? (sg > 0 ? Math.PI / 2 : -Math.PI / 2) : sg > 0 ? 0 : Math.PI);
    const FAN_COLS = [0xffa040, 0x38f8ff, 0xff8a3a];
    const NOREN_COLS = [0x1c2a7a, 0x8a1420, 0xa8561a, 0x2a1a3a];
    const fanAt: Array<[number, number, number]> = [];
    const hitsFootprint = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): boolean =>
      [...footprints, ...propObstacles].some((o) => x0 < o.maxX && x1 > o.minX && y0 < o.maxY && y1 > o.minY && z0 < o.maxZ && z1 > o.minZ);
    const faceBox = (f: SF, a0: number, a1: number, y0: number, y1: number, d0: number, d1: number): [number, number, number, number, number, number] => {
      const p = f.P3(a0, y0, d0);
      const q = f.P3(a1, y1, d1);
      return [Math.min(p.x, q.x), y0, Math.min(p.z, q.z), Math.max(p.x, q.x), y1, Math.max(p.z, q.z)];
    };
    const solidAt = (b: Building, ax: Axis, sg: number, plane: number, a: number, ha: number, y: number, hy: number): boolean =>
      b.plan.faces.some((sp) => sp.ax === ax && sp.sg === sg && Math.abs(sp.plane - plane) < 1e-6 && a - ha >= sp.a0 && a + ha <= sp.a1 && y - hy >= sp.y0 && y + hy <= sp.y1);
    const envStat = { wallFans: 0, roomFans: 0, awningNoren: 0, bayNoren: 0, holos: 0 };
    // (1) Wall fans on non-run lot faces (wall-run faces stay clean). 10D-Fix FIX-2:
    //  · 1F band (2.65–3.35 m, capped under each bay's top trim / the lintel): only on opaque bay relief — apartment
    //    grilles, infra shutters, blocked bays — mounted flush on the relief depth, never on glazed vitrines / frosted
    //    eatery panels / doors, and ≥ 0.55 m clear of infra transformer boxes and 1F conduits.
    //  · Upper band (y ≥ 4 m): only on the opaque mechanical storey (floor 3..9, isMachineFloor) with the whole ±0.55 m
    //    housing inside that storey — never over glazed office / residential windows.
    // Door bays, piers, slab drip bands, signs, pipe risers, exhaust ducts, socket props and every collider stay clear.
    const bandClear = (b: Building, y: number): boolean => {
      for (let n = 1; floorTopY(b.arch, n) <= GR.BAND_MAX_Y_M; n++) {
        const by = floorTopY(b.arch, n);
        if (y + 0.55 > by - GR.BAND_H_M - 0.05 && y - 0.55 < by + 0.05) return false;
      }
      return true;
    };
    const wallFixtureHit = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, m: number): boolean =>
      wallFixtures.some((o) => x0 - m < o.maxX && x1 + m > o.minX && y0 - m < o.maxY && y1 + m > o.minY && z0 - m < o.maxZ && z1 + m > o.minZ);
    /** Opaque 1F bay relief: mount depth `d` and the top trim height `top` below oT that the housing must clear. */
    const BAY_RELIEF: Readonly<Record<string, { d: number; top: number }>> = { GRILLE: { d: 0.125, top: 0.2 }, SHUTTER: { d: 0.09, top: 0.3 }, BLOCKED: { d: 0.05, top: 0 } };
    for (const g of groundFaces) {
      if (env.count >= 150 || envStat.wallFans >= 72) break;
      const { b, span } = g;
      // Alley service sides (bins / dumpsters) are not clean run strips: they may carry fans too.
      if ((g.run && !serviceFaces.has(g.key)) || span.court || megaBuilding.has(b.index)) continue;
      const k = g.key;
      if (escapeFaces.has(k) || balconyFaces.has(k) || galleryFaces.has(k) || megaFaces.has(k) || spineFaces.has(k) || ductFaces.has(k)) continue;
      const program = faceProgram.get(g);
      const f = sf(span.ax, span.sg, span.plane);
      const onFace = <T extends { building: number; ax: Axis; sg: number; plane: number }>(r: T): boolean => r.building === b.index && r.ax === span.ax && r.sg === span.sg && Math.abs(r.plane - span.plane) < 1e-6;
      const doors = groundDoors.filter(onFace);
      const piersHere = groundPiers.filter(onFace);
      const bays = groundBays.filter(onFace);
      const ducts = program === 'CYBER_EATERY' ? eateryVents.filter((v) => Math.abs((span.ax === 'x' ? v.x : v.z) - (span.plane + span.sg * 0.3)) < 0.05).map((v) => (span.ax === 'x' ? v.z : v.x)) : [];
      // The face's opaque mechanical storey (floors 1–2 are never mechanical: MACHINE_EVERY_MIN = 7).
      const si = seedInt(b.seed);
      const topLim = Math.min(span.y1, b.roofY) - 0.55;
      let machineFloor = -1;
      for (let fl = 3; fl <= 9 && facadeFloorY(b.arch, fl) + FACADE.FLOOR_H_M <= topLim; fl++) {
        if (isMachineFloor(si, fl)) {
          machineFloor = fl;
          break;
        }
      }
      let placedHere = 0;
      for (let a0 = span.a0 + 0.65 + p10dRng() * 1.5; a0 <= span.a1 - 0.65 && placedHere < 3; a0 += 2.4 + p10dRng() * 2) {
        const band = p10dRng();
        const yr = p10dRng();
        let a = a0;
        let y: number;
        let d = 0;
        if (band < 0.45) {
          // Centred in the bay under the sample point.
          const bay = bays.find((q) => a0 >= q.a0 && a0 <= q.a1 && q.a1 - q.a0 >= 1.3);
          const rel = bay ? BAY_RELIEF[bay.use] : undefined;
          if (!bay || !rel) continue;
          a = (bay.a0 + bay.a1) / 2;
          const yMax = Math.min(3.35, bay.oT - rel.top - 0.57);
          if (yMax < 2.65) continue;
          y = 2.65 + yr * Math.min(0.7, yMax - 2.65);
          d = rel.d;
        } else {
          if (machineFloor < 0) continue;
          y = facadeFloorY(b.arch, machineFloor) + 1.2 + yr * (FACADE.FLOOR_H_M - 2.4);
        }
        if (!solidAt(b, span.ax, span.sg, span.plane, a, 0.65, y, 0.55) || !bandClear(b, y)) continue;
        if (y < 6 && doors.some((dr) => a + 0.55 > dr.bay.a0 - 0.3 && a - 0.55 < dr.bay.a1 + 0.3)) continue;
        if (piersHere.some((gp) => a + 0.55 > gp.a0 - 0.05 && a - 0.55 < gp.a1 + 0.05 && y - 0.55 < gp.top)) continue;
        if (ducts.some((da) => Math.abs(da - a) < 1.25)) continue;
        const [x0, y0, z0, x1, y1, z1] = faceBox(f, a - 0.55, a + 0.55, y - 0.55, y + 0.55, d + 0.03, d + 0.32);
        if (hitsSign(x0, y0, z0, x1, y1, z1) || hitsCollider(x0, y0, z0, x1, y1, z1) || hitsFootprint(x0, y0, z0, x1, y1, z1)) continue;
        if (wallFixtureHit(x0, y0, z0, x1, y1, z1, 0.55)) continue;
        const c = f.P3(a, y, d);
        if (fanAt.some(([fx, fy, fz]) => Math.hypot(fx - c.x, fy - c.y, fz - c.z) < 2.2)) continue;
        if (!inArea(c.x, c.z, 2)) continue;
        if (!env.add(ENV_VARIANT.FAN, c.x, c.y, c.z, faceYaw(span.ax, span.sg), (4.5 + p10dRng() * 4.5) * (p10dRng() < 0.5 ? 1 : -1), p10dRng() * 6.28, FAN_COLS[Math.floor(p10dRng() * 3)], 'WALL', b.index)) break;
        fanAt.push([c.x, c.y, c.z]);
        envStat.wallFans++;
        placedHere++;
      }
    }
    // (2) Rooftop fans flush on the non-door vertical flanks of the explicit machine-room boxes.
    for (const rm of machineRoomBoxes) {
      if (env.count >= 190) break;
      const h = rm.y1 - rm.y0;
      if (h < 1.6) continue;
      for (const [ax, sg] of FACES) {
        if (rm.doorFace === `${ax}:${sg}`) continue;
        const plane = ax === 'x' ? (sg > 0 ? rm.x1 : rm.x0) : sg > 0 ? rm.z1 : rm.z0;
        const [l0, l1] = ax === 'x' ? [rm.z0, rm.z1] : [rm.x0, rm.x1];
        if (l1 - l0 < 1.4 || p10dRng() < 0.35) continue;
        const a = (l0 + l1) / 2;
        const y = rm.y0 + Math.min(h - 0.62, Math.max(0.62, h * 0.5));
        const f = sf(ax, sg, plane);
        const [x0, y0, z0, x1, y1, z1] = faceBox(f, a - 0.55, a + 0.55, y - 0.55, y + 0.55, 0.03, 0.32);
        if (hitsCollider(x0, y0, z0, x1, y1, z1) || hitsSign(x0, y0, z0, x1, y1, z1)) continue;
        const c = f.P3(a, y, 0);
        if (!env.add(ENV_VARIANT.FAN, c.x, c.y, c.z, faceYaw(ax, sg), (4.5 + p10dRng() * 4.5) * (p10dRng() < 0.5 ? 1 : -1), p10dRng() * 6.28, FAN_COLS[Math.floor(p10dRng() * 3)], 'ROOM')) break;
        envStat.roomFans++;
      }
    }
    // (3) Noren. 10D-Fix FIX-3: the alley-bay pass runs FIRST (≤ 24 / district, so awning noren can never starve it),
    // then the canopy pass. Alley bays: rod d 0.28 / y 3.05 (cloth bottom 2.37 m), wall standoffs back to d = 0, one per
    // pier bay or every 4 m on pier-less spans (infra included, clear of transformer boxes, doors, door clear zones,
    // signs, colliders, props and lamps). Canopies (eatery awning y 3.08 / d 1.18, apparel 3.22 / 1.3, hotel 3.4 / 1.7):
    // hangers reach up into the canopy collider. Never on wall-run faces.
    const norenNearLamp = (x: number, z: number): boolean => lampPoles.some(([lx, lz]) => Math.hypot(lx - x, lz - z) < 1.6);
    /** Alley run faces already dressed with noren (a dressed face no longer counts as a clean run face). */
    const dressedRuns = new Set<string>();
    /** A tower may dress a spare alley run face only if it keeps ≥ 2 other clean run faces (wall-run pillar). */
    const spareRun = (b: Building, key: string): boolean => {
      const clean = FACES.filter(([ax, sg]) => {
        const k = fkey(b, ax, sg);
        return k !== key && runFaces.has(k) && !serviceFaces.has(k) && !dressedRuns.has(k);
      });
      return clean.length >= 2;
    };
    for (const g of groundFaces) {
      if (env.count >= 212 || envStat.bayNoren >= 24) break;
      const { b, span } = g;
      if (!g.alley || span.court) continue;
      if (g.run && !serviceFaces.has(g.key) && !spareRun(b, g.key)) continue;
      const f = sf(span.ax, span.sg, span.plane);
      const onFace = <T extends { building: number; ax: Axis; sg: number; plane: number }>(r: T): boolean => r.building === b.index && r.ax === span.ax && r.sg === span.sg && Math.abs(r.plane - span.plane) < 1e-6;
      const piersHere = groundPiers.filter(onFace).sort((p, q) => p.a0 - q.a0);
      const doors = groundDoors.filter(onFace);
      const yRod = 3.05;
      const dRod = 0.28;
      const centres: number[] = [];
      if (piersHere.length >= 2) {
        for (let i = 0; i + 1 < piersHere.length; i++) if (piersHere[i + 1].a0 - piersHere[i].a1 >= ENV_DIMS.NOREN_W + 0.1) centres.push((piersHere[i].a1 + piersHere[i + 1].a0) / 2);
      } else if (span.a1 - span.a0 >= 3.2) {
        for (let a = span.a0 + 1.6; a <= span.a1 - 1.6 + 1e-6; a += 4.0) centres.push(a);
      }
      for (const a of centres) {
        if (envStat.bayNoren >= 24 || env.count >= 212) break;
        if (a - 0.86 < span.a0 + 0.1 || a + 0.86 > span.a1 - 0.1) continue;
        if (!solidAt(b, span.ax, span.sg, span.plane, a, 0.86, 2.7, 0.4)) continue;
        if (openingsAt(b.index, span.ax, span.sg, span.plane, a - 0.9, a + 0.9, 2.2, 3.4).length) continue;
        if (doors.some((d) => a + 0.85 > d.bay.a0 && a - 0.85 < d.bay.a1)) continue;
        if (piersHere.some((gp) => a + 0.86 > gp.a0 - 0.02 && a - 0.86 < gp.a1 + 0.02)) continue;
        const [x0, y0, z0, x1, y1, z1] = faceBox(f, a - 0.86, a + 0.86, yRod - 0.7, yRod + 0.06, 0.02, dRod + 0.14);
        if (hitsSign(x0, y0, z0, x1, y1, z1) || hitsCollider(x0, y0, z0, x1, y1, z1) || hitsFootprint(x0, y0, z0, x1, y1, z1)) continue;
        if (wallFixtureHit(x0, y0, z0, x1, y1, z1, 0.1)) continue;
        const c = f.P3(a, yRod, dRod - 0.06);
        if (!inArea(c.x, c.z, 2) || norenNearLamp(c.x, c.z)) continue;
        // Never in a bay that already carries a 1F wall fan (fan housing 2.1–3.9 m, ±0.55 m).
        if (fanAt.some(([fx, fy, fz]) => Math.hypot(fx - c.x, fz - c.z) < 1.6 && fy < 4.2)) continue;
        if (doorClearZones.some((r) => c.x + 0.9 > r.x0 && c.x - 0.9 < r.x1 && c.z + 0.9 > r.z0 && c.z - 0.9 < r.z1)) continue;
        if (!env.add(ENV_VARIANT.NOREN, c.x, c.y, c.z, faceYaw(span.ax, span.sg), 1.5 + p10dRng() * 0.9, p10dRng() * 6.28, NOREN_COLS[Math.floor(p10dRng() * NOREN_COLS.length)], 'BAY', b.index)) break;
        if (g.run && !serviceFaces.has(g.key)) dressedRuns.add(g.key);
        envStat.bayNoren++;
      }
    }
    for (const g of groundFaces) {
      if (env.count >= 212) break;
      const { b, span } = g;
      if (g.alley || g.run || span.court) continue;
      const program = faceProgram.get(g);
      const canopy = program === 'CYBER_EATERY' ? { y: 3.08, d: 1.18 } : program === 'TECH_APPAREL' ? { y: 3.22, d: 1.3 } : program === 'CAPSULE_HOTEL' ? { y: 3.4, d: 1.7 } : null;
      if (!canopy || span.a1 - span.a0 - 0.8 <= 2) continue;
      const f = sf(span.ax, span.sg, span.plane);
      const piersHere = groundPiers
        .filter((gp) => gp.building === b.index && gp.ax === span.ax && gp.sg === span.sg && Math.abs(gp.plane - span.plane) < 1e-6)
        .sort((p, q) => p.a0 - q.a0);
      const yRod = canopy.y;
      const dRod = canopy.d;
      /** The rod must hang directly under a canopy collider at both ends (hangers reach ≤ 0.2 m up into it). */
      const underCanopy = (a: number): boolean =>
        [a - 0.75, a + 0.75].every((ae) => {
          const q = f.P3(ae, yRod, dRod);
          return colliders.some((c) => c.building === b.index && c.min.y >= yRod + 0.02 && c.min.y <= yRod + 0.2 && q.x > c.min.x && q.x < c.max.x && q.z > c.min.z && q.z < c.max.z);
        });
      for (let i = 0; i + 1 < piersHere.length; i++) {
        const b0 = piersHere[i].a1;
        const b1 = piersHere[i + 1].a0;
        if (b1 - b0 < ENV_DIMS.NOREN_W + 0.1) continue;
        const a = (b0 + b1) / 2;
        if (a - 0.85 < span.a0 + 0.5 || a + 0.85 > span.a1 - 0.5 || !underCanopy(a)) continue;
        if (openingsAt(b.index, span.ax, span.sg, span.plane, a - 0.9, a + 0.9, 2.2, 3.6).length) continue;
        const [x0, y0, z0, x1, y1, z1] = faceBox(f, a - 0.86, a + 0.86, yRod - 0.7, yRod + 0.02, dRod - 0.12, dRod + 0.14);
        if (hitsSign(x0, y0, z0, x1, y1, z1) || hitsCollider(x0, y0, z0, x1, y1, z1) || hitsFootprint(x0, y0, z0, x1, y1, z1)) continue;
        const c = f.P3(a, yRod, dRod - 0.06);
        if (!inArea(c.x, c.z, 2) || norenNearLamp(c.x, c.z)) continue;
        if (!env.add(ENV_VARIANT.NOREN, c.x, c.y, c.z, faceYaw(span.ax, span.sg), 1.5 + p10dRng() * 0.9, p10dRng() * 6.28, NOREN_COLS[Math.floor(p10dRng() * NOREN_COLS.length)], 'AWNING', b.index)) break;
        envStat.awningNoren++;
      }
    }
    // (4) Rooftop wireframe holograms on the reserved tall flat roofs (full 3.6 m sweep already clear of roofRects and
    // roof colliders); a final sign check drops any that a later roof sign overlaps.
    for (const h of holoReserve) {
      if (env.count >= ENV_CAP) break;
      const SW = ENV_DIMS.HOLO_SWEEP;
      if (hitsSign(h.x - SW, h.b.roofY, h.z - SW, h.x + SW, h.b.roofY + ENV_DIMS.HOLO_TOP + 0.3, h.z + SW)) continue;
      if (!env.add(ENV_VARIANT.HOLO, h.x, h.b.roofY, h.z, p10dRng() * 6.28, 0, p10dRng() * 6.28, PAL[Math.floor(p10dRng() * PAL.length)], 'ROOF')) break;
      envStat.holos++;
    }
    env.end();

    // ------------------------------------------------------------------ 15d. 10D-3 ramen carts + bus shelters (+0 calls)
    // StreetFurnishingsKit v2 / v3 on avenue (and wide street) sidewalks: the ramen cart's counter and the shelter's
    // open boarding side face the road; every footprint clears buildings (≥ 0.65 m), doorways, crosswalks (≥ 4 m),
    // lamps, cars, vending kiosks and props. Solid PROP colliders, contact shadows, warm / cool lights, boiler steam.
    const ramenCarts: Array<{ x: number; z: number; yaw: number; steam: [number, number, number] }> = [];
    const busShelters: Array<{ x: number; z: number; yaw: number; front: number; kerb: number; axis: Axis; side: 1 | -1 }> = [];
    const ramenSteam: Array<[number, number, number]> = [];
    /** World AABB of a local box (yaw is a multiple of 90°) — x along the kit's local X, z along local Z. */
    const kitBox = (x: number, z: number, yaw: number, lx0: number, lx1: number, lz0: number, lz1: number): RectXZ => {
      const c = Math.round(Math.cos(yaw));
      const sn = Math.round(Math.sin(yaw));
      const pts = [[lx0, lz0], [lx1, lz0], [lx0, lz1], [lx1, lz1]].map(([lx, lz]) => [x + lx * c + lz * sn, z - lx * sn + lz * c]);
      return rectFrom(Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1])));
    };
    const rectDist = (r: RectXZ, x: number, z: number): number => Math.hypot(Math.max(r.x0 - x, 0, x - r.x1), Math.max(r.z0 - z, 0, z - r.z1));
    const groundClear = (r: RectXZ, h: number, lampGap: number): boolean => {
      if (!inArea((r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2, 3)) return false;
      for (const c of colliders) {
        if (c.kind === 'BARRIER' || c.max.y <= 0.1 || c.min.y >= h) continue;
        const m = c.kind === 'BUILDING' ? 0.65 : 0.2;
        if (r.x0 - m < c.max.x && r.x1 + m > c.min.x && r.z0 - m < c.max.z && r.z1 + m > c.min.z) return false;
      }
      if ([...footprints, ...propObstacles].some((o) => o.minY < h && r.x0 - 0.15 < o.maxX && r.x1 + 0.15 > o.minX && r.z0 - 0.15 < o.maxZ && r.z1 + 0.15 > o.minZ)) return false;
      if (doorClearZones.some((d) => d.y < 1 && r.x0 < d.x1 && r.x1 > d.x0 && r.z0 < d.z1 && r.z1 > d.z0)) return false;
      if (crosswalkZones.some((cz) => r.x0 - 4 < cz.x1 && r.x1 + 4 > cz.x0 && r.z0 - 4 < cz.z1 && r.z1 + 4 > cz.z0)) return false;
      if (intersectionSquares.some((q) => r.x0 - 2 < q.x1 && r.x1 + 2 > q.x0 && r.z0 - 2 < q.z1 && r.z1 + 2 > q.z0)) return false;
      if (lampPoles.some(([lx, lz]) => rectDist(r, lx, lz) < lampGap)) return false;
      return true;
    };
    const ring5 = !!plan.plaza;
    const shelterCap = ring5 ? 2 : 4;
    const cartCap = ring5 ? 2 : 4;
    const SH = FURNITURE_BOUNDS.BUS_SHELTER;
    for (const pass of ['SHELTER', 'CART'] as const) {
      for (const [si, st] of streets.entries()) {
        if (pass === 'SHELTER' && st.kind !== 'AVENUE') continue;
        const lh = laneHalf(st.kind);
        if (sidewalk(st.kind) < 3.2) continue;
        for (const [a0, a1] of segmentsByStreet[si]) {
          for (const side of [-1, 1] as const) {
            for (let a = a0 + 8 + p10dRng() * 6; a < a1 - 8; a += 6 + p10dRng() * 4) {
              const done = pass === 'SHELTER' ? busShelters.length >= shelterCap : ramenCarts.length >= cartCap;
              if (done) break;
              // Face the road: local +Z → −side along the lateral axis.
              const yaw = st.axis === 'z' ? -side * (Math.PI / 2) : side > 0 ? Math.PI : 0;
              if (pass === 'SHELTER') {
                const lat = st.coord + side * (lh + 1.35);
                const p = pt(st.axis, a, 0, lat);
                if (busShelters.some((o) => Math.hypot(o.x - p.x, o.z - p.z) < 28)) continue;
                const r = kitBox(p.x, p.z, yaw, -SH.w / 2, SH.w / 2, 0.03 - SH.d / 2, 0.03 + SH.d / 2);
                if (!groundClear(r, 2.6, 2.2)) continue;
                if (!addKit(KIT_VARIANT.BUS_SHELTER, p.x, 0, p.z, yaw, 1, 0)) break;
                const glass = kitBox(p.x, p.z, yaw, -1.78, 1.78, -0.7, -0.6);
                const kiosk = kitBox(p.x, p.z, yaw, 1.63, 1.81, -0.625, 0.625);
                const roof = kitBox(p.x, p.z, yaw, -SH.w / 2, SH.w / 2, 0.03 - SH.d / 2, 0.03 + SH.d / 2);
                colliders.push(
                  { min: new THREE.Vector3(glass.x0, 0, glass.z0), max: new THREE.Vector3(glass.x1, 2.41, glass.z1), kind: 'PROP', building: -1 },
                  { min: new THREE.Vector3(kiosk.x0, 0, kiosk.z0), max: new THREE.Vector3(kiosk.x1, 2.15, kiosk.z1), kind: 'PROP', building: -1 },
                  { min: new THREE.Vector3(roof.x0, 2.41, roof.z0), max: new THREE.Vector3(roof.x1, 2.55, roof.z1), kind: 'PROP', building: -1 },
                );
                extraShadows.push({ x: p.x, z: p.z, yaw, w: SH.w + 0.1, d: SH.d + 0.05, alpha: 0.45 });
                if (!lightNear(p.x, 2.2, p.z, 2.5)) addLight(p.x, 2.25, p.z, 0x9fe8ff, 1.0);
                busShelters.push({ x: p.x, z: p.z, yaw, front: lh + 1.35 - (0.03 + SH.d / 2), kerb: st.coord + side * lh, axis: st.axis, side });
              } else {
                const lat = st.coord + side * (lh + (st.kind === 'AVENUE' ? 2.4 : 2.1));
                const p = pt(st.axis, a, 0, lat);
                if (ramenCarts.some((o) => Math.hypot(o.x - p.x, o.z - p.z) < 20) || busShelters.some((o) => Math.hypot(o.x - p.x, o.z - p.z) < 8)) continue;
                const r = kitBox(p.x, p.z, yaw, -1.1, 1.1, -0.58, 0.58);
                if (!groundClear(r, 2.4, 1.0)) continue;
                if (!addKit(KIT_VARIANT.RAMEN_CART, p.x, 0, p.z, yaw, 1, 0)) break;
                const cb = kitBox(p.x, p.z, yaw, -1.05, 1.05, -0.55, 0.55);
                colliders.push({ min: new THREE.Vector3(cb.x0, 0, cb.z0), max: new THREE.Vector3(cb.x1, 2.3, cb.z1), kind: 'PROP', building: -1 });
                extraShadows.push({ x: p.x, z: p.z, yaw, w: 2.3, d: 1.25, alpha: 0.6 });
                if (!lightNear(p.x, 1.9, p.z, 2.5)) addLight(p.x, 1.9, p.z, 0xffa860, 1.25);
                const [sx, sy, sz] = FURNITURE_SOCKETS.RAMEN_STEAM;
                const steam: [number, number, number] = [p.x + sx * Math.cos(yaw) + sz * Math.sin(yaw), sy, p.z - sx * Math.sin(yaw) + sz * Math.cos(yaw)];
                ramenSteam.push(steam);
                ramenCarts.push({ x: p.x, z: p.z, yaw, steam });
              }
            }
          }
        }
      }
    }

    // ------------------------------------------------------------------ 15e. 10D-4 breaker spark nodes
    // 8–12 faulty BREAKER wall fixtures (alley / service-corridor ones first); fallback: alley wall junction points.
    const sparkNodes: Array<{ pos: THREE.Vector3; nx: number; nz: number }> = [];
    {
      const inAlley = (x: number, z: number): boolean => alleyBands.some((r) => x > r.x0 - 1.5 && x < r.x1 + 1.5 && z > r.z0 - 1.5 && z < r.z1 + 1.5);
      const breakers = socketProps
        .filter((p) => p.id === 'BREAKER' && p.y < 3.5)
        .map((p) => ({ p, alley: inAlley(p.x, p.z) ? 0 : 1, roll: p10dRng() }))
        .sort((a, b) => a.alley - b.alley || a.roll - b.roll);
      const want = 8 + Math.floor(p10dRng() * 5);
      for (const { p } of breakers) {
        if (sparkNodes.length >= want) break;
        const nx = Math.sin(p.yaw);
        const nz = Math.cos(p.yaw);
        if (sparkNodes.some((o) => Math.hypot(o.pos.x - p.x, o.pos.z - p.z) < 6)) continue;
        sparkNodes.push({ pos: new THREE.Vector3(p.x + nx * 0.2, p.y + 0.1, p.z + nz * 0.2), nx, nz });
      }
      // Fallback: alley walls first, then any street-level wall, at junction-box height (2.4 m) on a solid span.
      for (const alleyOnly of [true, false]) {
        for (const g of groundFaces) {
          if (sparkNodes.length >= 8) break;
          if ((alleyOnly && !g.alley) || g.span.court || g.span.y0 > 1.8 || g.span.y1 < 3) continue;
          const f = sf(g.span.ax, g.span.sg, g.span.plane);
          for (const u of [0.35, 0.65]) {
            const a = g.span.a0 + (g.span.a1 - g.span.a0) * u;
            const q = f.P3(a, 2.4, 0.18);
            if (!inArea(q.x, q.z, 2) || sparkNodes.some((o) => Math.hypot(o.pos.x - q.x, o.pos.z - q.z) < 6)) continue;
            sparkNodes.push({ pos: q, nx: f.nx, nz: f.nz });
            break;
          }
        }
      }
    }

    // ------------------------------------------------------------------ 16. commit merged geometry & instances
    const mk = (geos: THREE.BufferGeometry[], mat: THREE.Material, name: string, renderOrder = 0): THREE.Mesh => {
      const geo = mergeOrEmpty(geos);
      for (const gg of geos) gg.dispose();
      const posAttr = geo.getAttribute('position');
      const hasVerts = !!posAttr && posAttr.count > 0;
      if (hasVerts) geo.computeBoundingSphere();
      const m = new THREE.Mesh(geo, mat);
      m.name = name;
      m.renderOrder = renderOrder;
      m.visible = hasVerts;
      m.frustumCulled = hasVerts;
      this.sectorGroup.add(m);
      this.sectorDisposables.push(geo);
      return m;
    };
    // 9A-5 / 10A-2: every geometry of the AO-shaded buckets (including highway/ramp concrete) carries `aAo`.
    for (const list of [G.concrete, G.hw, G.steel, G.archPaint, G.bodies]) for (const gg of list) ensureAo(gg);
    const mConcrete = mk(G.concrete, this.concreteMat, 'GroundConcreteRoofs');
    mConcrete.receiveShadow = true;
    const mRoad = mk(G.road, this.roadMat, 'Roads');
    mRoad.receiveShadow = true;
    mk(G.water, this.waterMat, 'CanalWater');
    const mHw = mk(G.hw, this.hwConcreteMat, 'ExpresswayBridgeConcrete');
    mHw.castShadow = true;
    mHw.receiveShadow = true;
    mk(G.strips, this.stripMat, 'LightStrips');
    const mSteel = mk(G.steel.map(stripUv), this.steelMat, 'Steel');
    mSteel.receiveShadow = true;
    mk(G.glass, this.glassMat, 'SkybridgeGlass');
    mk(G.glassT, this.shopGlassMat, 'BalconyShopGlass');
    const mTowers = mk(G.bodies, this.buildingMat, 'Towers');
    mTowers.castShadow = true;
    mTowers.receiveShadow = true;
    const mTrim = mk(G.archPaint, this.archPaintMat, 'ArchFacadesTrim');
    mTrim.receiveShadow = true;
    mk(G.barrier, this.barrierMat, 'LockdownBarrier', 8).frustumCulled = false;

    const kitStats = this.propMeshes.commit([...socketProps, ...clutter.items], decals, extraShadows);
    const commit = (m: THREE.InstancedMesh, n: number, cull = true): void => {
      m.count = n;
      m.visible = n > 0;
      m.instanceMatrix.needsUpdate = true;
      if (cull && n > 0) {
        m.computeBoundingSphere();
        m.frustumCulled = true;
      } else {
        m.frustumCulled = false;
      }
    };
    this.cars.forEach((m, i) => {
      commit(m, carCounts[i]);
      (m.geometry.getAttribute('aCar') as THREE.InstancedBufferAttribute).needsUpdate = true;
      (m.geometry.getAttribute('aPaint') as THREE.InstancedBufferAttribute).needsUpdate = true;
    });
    commit(this.carPools, poolCount, false);
    poolA.needsUpdate = true;
    poolB.needsUpdate = true;
    commit(this.signals, signalCount);
    signalPhase.needsUpdate = true;
    // 9A-6 glowing cast-iron manholes: along street lanes (clear of intersections, crosswalks, ramps, cars) and on
    // narrow-alley centre lines — flush at 0.016 m; 70 % warm amber / 30 % toxic cyan subterranean glow.
    const manholePos: THREE.Vector3[] = [];
    const glowAttr = this.manholes.geometry.getAttribute('aGlow') as THREE.InstancedBufferAttribute;
    const nearCar = (x: number, z: number): boolean => pick.some((c) => c.y < 1 && Math.hypot(c.x - x, c.z - z) < 3.2);
    const addManhole = (x: number, z: number): void => {
      if (manholePos.length >= CAP.MANHOLE || !inArea(x, z, 2)) return;
      if (manholePos.some((m) => Math.hypot(m.x - x, m.z - z) < 7)) return;
      if (doorClearZones.some((r) => r.y < 1 && insideRect(x, z, r, 0.6))) return;
      const i = manholePos.length;
      _m4.makeTranslation(x, 0.016, z);
      this.manholes.setMatrixAt(i, _m4);
      const cyan = srng() < 0.3;
      _col.setHex(cyan ? 0x1ce8ff : 0xff7828).multiplyScalar(0.55 + srng() * 0.5);
      glowAttr.setXYZ(i, _col.r, _col.g, _col.b);
      manholePos.push(new THREE.Vector3(x, 0.016, z));
      if (!lightNear(x, 0.4, z, 3)) addLight(x, 0.35, z, cyan ? 0x1ce8ff : 0xff7828, 0.6);
    };
    for (let si = 0; si < streets.length; si++) {
      const st = streets[si];
      for (const [a0, a1] of segmentsByStreet[si]) {
        for (let a = a0 + 6 + srng() * 8; a < a1 - 4; a += 16 + srng() * 14) {
          const lat = st.coord + (srng() < 0.5 ? -1 : 1) * laneHalf(st.kind) * (0.35 + srng() * 0.3);
          const q = pt(st.axis, a, 0, lat);
          if (occupied(q.x, q.z, 1.0) || nearCar(q.x, q.z)) continue;
          addManhole(q.x, q.z);
        }
      }
    }
    for (const al of alleyRecs) {
      const c = (al.gap0 + al.gap1) / 2;
      const n = al.ov1 - al.ov0 > 18 ? 2 : 1;
      for (let k = 0; k < n; k++) {
        const o = al.ov0 + ((k + 0.5) / n) * (al.ov1 - al.ov0) + (srng() - 0.5) * 3;
        if (al.axis === 'x') addManhole(c, o);
        else addManhole(o, c);
      }
    }
    commit(this.manholes, manholePos.length);
    glowAttr.needsUpdate = true;

    // Steam re-anchored: focused 2.5–6 m columns rising straight out of manholes and eatery exhaust mouths (two
    // phase-offset puffs each), plus low canal mist.
    let steamN = 0;
    const steamH = this.steam.geometry.getAttribute('aSteamH') as THREE.InstancedBufferAttribute;
    const addSteam = (x: number, y: number, z: number, size: number, height: number, phase: number): void => {
      if (steamN >= CAP.STEAM || !inArea(x, z, -10)) return;
      _m4.makeTranslation(x, y, z);
      this.steam.setMatrixAt(steamN, _m4);
      steamAttr.setXYZW(steamN, phase, size, 0.08 + srng() * 0.06, srng());
      steamH.setX(steamN, height);
      steamN++;
    };
    let steamColumns = 0;
    for (const m of manholePos) {
      if (srng() < 0.25) continue;
      const hgt = 2.5 + srng() * 3.5;
      const ph = srng();
      addSteam(m.x, 0.05, m.z, 0.9 + srng() * 0.5, hgt, ph);
      addSteam(m.x, 0.05, m.z, 0.8 + srng() * 0.5, hgt, ph + 0.5);
      steamColumns++;
    }
    for (const v of eateryVents) {
      const ph = srng();
      addSteam(v.x, v.y, v.z, 0.7 + srng() * 0.3, 2.5 + srng() * 2, ph);
      addSteam(v.x, v.y, v.z, 0.6 + srng() * 0.3, 2.5 + srng() * 2, ph + 0.5);
      steamColumns++;
    }
    // 10D-3: delicate anchored noodle-boiler steam over every ramen cart's vat (before the canal mist fills up).
    for (const [x, y, z] of ramenSteam) {
      const ph = srng();
      // 10D-Fix FIX-5: fuller boiler mist, short rise — top(0.9) = base + 0.9 · rise + 0.85 · size · 1.87 ≤ 2.20 m, under
      // the 2.245 m awning underside.
      addSteam(x, y, z, 0.3 + srng() * 0.035, 0.62 + srng() * 0.06, ph);
      addSteam(x, y, z, 0.3 + srng() * 0.035, 0.62 + srng() * 0.06, ph + 0.5);
    }
    const canalSteam = canalWater.length ? 24 : 0;
    for (let k = 0; k < canalSteam * 4 && steamN < CAP.STEAM && k < 400; k++) {
      if (k >= canalSteam) break;
      const r = canalWater[Math.floor(srng() * canalWater.length)];
      addSteam(r.x0 + srng() * (r.x1 - r.x0), LEVEL.CANAL_WATER_Y + 0.4, r.z0 + srng() * (r.z1 - r.z0), 2.2 + srng() * 1.6, 0, srng());
    }
    steamH.needsUpdate = true;
    commit(this.steam, steamN, false);
    steamAttr.needsUpdate = true;

    commit(this.lamps, counts.lamp);
    // 10B-2: rain-mist halos ride behind the lamp halos in the same instanced draw.
    mists.forEach((mi, k) => {
      const i = counts.lamp + k;
      _m4.makeTranslation(mi.x, mi.y, mi.z);
      this.lampHalos.setMatrixAt(i, _m4);
      _colB.setHex(mi.hex).multiplyScalar(mi.opacity / NEON_BLOOM.LAMP_HALO_OPACITY);
      haloAttr.setXYZW(i, _colB.r, _colB.g, _colB.b, mi.radius);
    });
    haloAttr.needsUpdate = true;
    commit(this.lampHalos, counts.lamp + mists.length, false);
    commit(this.megaBillboards, counts.mega);
    megaAttrRect.needsUpdate = true;
    megaAttrParams.needsUpdate = true;
    commit(this.lampCones, counts.lamp, false);
    coneTint.needsUpdate = true;
    lampTint.needsUpdate = true;
    commit(this.vending, counts.vend);
    vendTint.needsUpdate = true;
    vendBrand.needsUpdate = true;
    commit(this.furnishings, counts.kit);
    kitAttr.needsUpdate = true;
    commit(this.steelFixtures, counts.steelFix);
    steelFixVar.needsUpdate = true;
    commit(this.roofMech, counts.mech);
    mechVar.needsUpdate = true;
    commit(this.machineRooms, counts.room);
    commit(this.aviation, counts.avi, false);
    aviPhase.needsUpdate = true;
    commit(this.neonSigns, counts.neon);
    neonStrip.needsUpdate = true;
    neonFormat.needsUpdate = true;
    this.searchlights.count = counts.search;
    this.searchlights.visible = counts.search > 0;
    searchBase.needsUpdate = true;
    searchParams.needsUpdate = true;
    commit(this.beacons, counts.beacon);
    commit(this.halos, counts.beacon, false);
    this.gatePillar.position.copy(gatePos).addScaledVector(fwd, 6);

    const center = new THREE.Vector3();
    buildings.forEach((b) => center.add(_pos.set(b.cx, 0, b.cz)));
    center.divideScalar(Math.max(1, buildings.length));

    // 10D-1 expressway traffic lanes (own RNG stream: layouts stay where they were).
    this.traffic.setLanes(trafficLanes, trafficRng);
    // 12A-2 reflection pool of the street-level Mega-Billboards (RING segments and screens above 42 m skipped).
    // Audit fix: pieces sharing a `group` (L-corner halves) are ONE screen → one pool entry (area-weighted centre,
    // summed normal, extent covering every piece), so a single screen can never fill several slots.
    this.megaCount = 0;
    const megaGroupSlot = new Map<number, number>();
    const megaArea = new Float32Array(CAP.MEGA);
    for (let i = 0; i < megaRecords.length; i++) {
      const r = megaRecords[i];
      if (r.kind === 'RING' || r.y > MEGA_REFL.MAX_Y_M) continue;
      const a = Math.max(1e-3, r.w * r.h);
      const g = r.group >= 0 ? megaGroupSlot.get(r.group) : undefined;
      if (g !== undefined) {
        const t = megaArea[g] + a;
        for (let c = 0; c < 3; c++) this.megaPos[g * 3 + c] = (this.megaPos[g * 3 + c] * megaArea[g] + (c === 0 ? r.x : c === 1 ? r.y : r.z) * a) / t;
        megaArea[g] = t;
        this.megaNrm[g * 3] += r.nx;
        this.megaNrm[g * 3 + 1] += r.nz;
        // BLADEs read from both sides; so does an L-corner (arms > 45° apart): its merged diagonal normal would cut
        // the ribbon along a straight line near the outer arm ends (the only blind quadrant is inside the building).
        const r0 = megaRecords[this.megaSrcIdx[g]];
        if (r.kind === 'BLADE' || r.nx * r0.nx + r.nz * r0.nz < Math.SQRT1_2) this.megaNrm[g * 3 + 2] = 1;
        continue;
      }
      if (this.megaCount >= CAP.MEGA) continue;
      const j = this.megaCount++;
      if (r.group >= 0) megaGroupSlot.set(r.group, j);
      megaArea[j] = a;
      _col.setHex(AD_HUES[r.cell]);
      this.megaPos[j * 3] = r.x;
      this.megaPos[j * 3 + 1] = r.y;
      this.megaPos[j * 3 + 2] = r.z;
      this.megaCol[j * 3] = _col.r * MEGA_REFL.INTENSITY;
      this.megaCol[j * 3 + 1] = _col.g * MEGA_REFL.INTENSITY;
      this.megaCol[j * 3 + 2] = _col.b * MEGA_REFL.INTENSITY;
      this.megaNrm[j * 3] = r.nx;
      this.megaNrm[j * 3 + 1] = r.nz;
      this.megaNrm[j * 3 + 2] = r.kind === 'BLADE' ? 1 : 0;
      this.megaSrcIdx[j] = i;
    }
    // Second pass: normalise merged normals; half extents cover every piece of the screen.
    for (let j = 0; j < this.megaCount; j++) {
      const nl = Math.hypot(this.megaNrm[j * 3], this.megaNrm[j * 3 + 1]) || 1;
      this.megaNrm[j * 3] /= nl;
      this.megaNrm[j * 3 + 1] /= nl;
      this.megaSize[j * 2] = 0;
      this.megaSize[j * 2 + 1] = 0;
    }
    for (let i = 0; i < megaRecords.length; i++) {
      const r = megaRecords[i];
      if (r.kind === 'RING' || r.y > MEGA_REFL.MAX_Y_M) continue;
      let j = r.group >= 0 ? (megaGroupSlot.get(r.group) ?? -1) : -1;
      if (j < 0) for (let k = 0; k < this.megaCount; k++) if (this.megaSrcIdx[k] === i) { j = k; break; }
      if (j < 0) continue;
      const off = Math.hypot(r.x - this.megaPos[j * 3], r.z - this.megaPos[j * 3 + 2]);
      this.megaSize[j * 2] = Math.max(this.megaSize[j * 2], off + r.w / 2);
      this.megaSize[j * 2 + 1] = Math.max(this.megaSize[j * 2 + 1], Math.abs(r.y - this.megaPos[j * 3 + 1]) + r.h / 2);
    }
    this.uMegaReflCount.value = 0;
    this.megaReflSrc.fill(-1);
    this.layout = {
      sector,
      loop,
      buildings: buildings.map(({ index, cx, cz, halfW, halfD, roofY, arch, massing, setbackY, cylR, cylC, voidBox, slantH, slant, seed }) => ({ index, cx, cz, halfW, halfD, roofY, arch, massing, setbackY, cylR, cylC, voidBox, slantH, slant, seed })),
      colliders,
      ramps: rampColliders,
      anchors,
      facadeFeatures,
      canalWater,
      playerSpawn,
      playerSpawnYaw,
      groundSpawns,
      highwaySpawns,
      trafficLanes,
      interiors,
      interiorProps,
      destructibleProps: kitStats.destructibles,
      breachDoors,
      glassPanes,
      skyNotches,
      interiorOpenings,
      reliefPods: { pods: podCount, towers: podTowers, eligible: podEligible },
      bridgeSpawns,
      skybridgeSpawns,
      roofSpawns,
      perchSpawns,
      airSpawns,
      gate: { position: gatePos, normal: fwd.clone(), halfWidth: gateHalf, height: 16, open: false },
      center,
      cinematicPath,
      propSockets,
      doorClearZones,
      propFootprints: [...socketProps, ...clutter.items].map(toAabb),
      alleyBands,
      manholes: manholePos,
      neonSignRecords,
      buildingSpans: buildings.map((b) => b.plan.faces),
      farTowersInfo: this.farInfo.map((t) => ({ ...t })),
      megaBillboards: megaRecords,
      marketRects: plazas,
      marketTrestles,
      curbLedBoxes,
      animatedEnv: [...env.instances],
      ramenCarts,
      busShelters,
      sparkNodes,
      canopyDripEdges,
      lampPoles,
      machineRoomBoxes,
      groundDoors,
      groundPiers,
      stats: {
        towers: buildings.length,
        cars: pick.length,
        highways: plan.highways.length,
        ramps: rampColliders.length,
        bridges: bridgeSpans.length,
        skybridges: skybridgeCount,
        streetscape: { ...stat, kitInstances: counts.kit, vending: counts.vend },
        lamps: counts.lamp,
        cityLights: this.lightCount,
        traffic: this.traffic.count,
        archetypes: [ARCH_A, ARCH_B, ARCH_C, ARCH_D].map((a) => buildings.filter((b) => b.arch === a).length),
        balconies: balconyCount,
        fireEscapes: escapeCount,
        escapeFlights: flightCount,
        shutterFronts: shutterFaces.size,
        signals: signalCount,
        lampCones: counts.lamp,
        cableBundles,
        carPaints: paintCounts,
        carPools: poolCount,
        facadeRooms,
        massings: Object.fromEntries(([...MASSING_KINDS, ...MEGA_KINDS] as const).map((k) => [k, buildings.filter((b) => b.massing === k).length])),
        lots: { generated: lotsGenerated, built: buildings.length, market: plazas.length, fill: buildings.length / Math.max(1, lotsGenerated), marketStalls },
        megastructures: { ...megaCounts },
        megaBillboards: { total: counts.mega, ...megaStats, mists: mists.length },
        signRejects,
        identity: sector.identity?.name ?? '',
        palette: [...PAL],
        programs: { ...programCounts },
        roofsOnGrid: buildings.filter((b) => b.plan.plates.every((pl) => isOnFloorGrid(b.arch, pl.y))).length,
        setbacksOnGrid: buildings.filter((b) => b.setbackY === 0 || isOnFloorGrid(b.arch, b.setbackY)).length,
        parapetLengthM: Math.round(parapetLen),
        parapetGaps: parapetGapCount,
        bulkheads,
        galleryDoors,
        galleryLevels,
        galleryRamps,
        galleriesLinked,
        galleriesWithoutCorridor: buildings.filter((b) => b.massing === 'GALLERY_DANCHI' && !FACES.some(([ax, sg]) => galleryFaces.has(fkey(b, ax, sg)))).length,
        spines: spineCount,
        slabBands: bandCount,
        piers: pierCount,
        doors: doorSizes.length,
        doorWidth: doorSizes.length ? [Math.min(...doorSizes.map((d) => d[0])), Math.max(...doorSizes.map((d) => d[0]))] : [0, 0],
        doorHeight: doorSizes.length ? [Math.min(...doorSizes.map((d) => d[1])), Math.max(...doorSizes.map((d) => d[1]))] : [0, 0],
        sockets: propSockets.length,
        pipeBundles,
        manholes: manholePos.length,
        steamColumns,
        neon: counts.neon,
        alleyNeon,
        minRunFaces: Math.min(...runFaceCount.map((n, bi) => n - FACES.filter(([ax, sg]) => serviceFaces.has(`${bi}:${ax}:${sg}`)).length)),
        floatingRoofProps: roofPropRects.filter(({ b, r }) => !onSolidRoof(b.plan, r)).length,
        props: {
          doors: composed.doors.length,
          tidyDoors: composed.doors.filter((d) => d.tidy).length,
          dressedDoors: composed.doors.filter((d) => !d.tidy && d.signature.length > 0).length,
          adjacentPairs,
          adjacentClones,
          bayProps: composed.bays.length,
          socketProps: socketProps.length,
          kits: kitStats.counts,
          clutter: clutter.items.length,
          clutterColliders: clutter.colliders.length,
          clutterByStrip: clutter.byKind,
          dumpstersByStrip: clutter.dumpstersByKind,
          decals: kitStats.decals,
          contactShadows: kitStats.contactShadows,
        },
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
    /** 10B-1: lots stretch to 44 m (was 34 m) so no block leaves a barren concrete strip behind its tower. */
    const LOT_MAX_M = 44;
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
        lots.push({ r: rectFrom(r.x0, r.z0, Math.min(r.x1, r.x0 + LOT_MAX_M), Math.min(r.z1, r.z0 + LOT_MAX_M)), pair: -1 });
        return;
      }
      const pieces = b.long >= 54 ? 3 : 2;
      const each = (b.long - alley * (pieces - 1)) / pieces;
      for (let i = 0; i < pieces; i++) {
        const o = i * (each + alley);
        const piece = w >= d ? rectFrom(r.x0 + o, r.z0, r.x0 + o + each, r.z1) : rectFrom(r.x0, r.z0 + o, r.x1, r.z0 + o + each);
        lots.push({ r: rectFrom(piece.x0, piece.z0, Math.min(piece.x1, piece.x0 + LOT_MAX_M), Math.min(piece.z1, piece.z0 + LOT_MAX_M)), pair: bi });
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
      // 10A-2: hard-clamp any far tower whose radial swath enters a blimp cruise corridor (guarantees >= 18 m 360° clearance).
      const dist = Math.hypot(x, z);
      const rad = Math.hypot(w * 0.5, d * 0.5);
      let clampedTop = top;
      for (const blimp of CITY_FX.BLIMPS) {
        if (Math.abs(dist - blimp.radius) <= CITY_FX.BLIMP_LENGTH * 0.5 + rad + 20) {
          const cap = blimp.y - CITY_FX.BLIMP_RADIUS - 30;
          if (clampedTop > cap) clampedTop = cap;
        }
      }
      const i = this.farInfo.length;
      _pos.set(x, clampedTop / 2, z);
      _quat.identity();
      _scl.set(w, clampedTop, d);
      _m4.compose(_pos, _quat, _scl);
      this.farTowers.setMatrixAt(i, _m4);
      const seed = rng();
      seedAttr.setX(i, seed);
      // Distant supertalls: mostly glass corporate towers, some residential slabs and industrial blocks.
      const h = (seed * 13.37) % 1;
      archAttr.setX(i, clampedTop < 70 ? (h < 0.5 ? ARCH_B : ARCH_C) : h < 0.62 ? ARCH_A : h < 0.9 ? ARCH_B : ARCH_D);
      this.farInfo.push({ x, z, w, d, top: clampedTop });
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
    // 10B-1 tight skyline framing: an inner ring 115–220 m out (55–180 m tall, blimp-corridor clamped in place()),
    // every footprint kept ≥ 14 m outside the lockdown square, then the classic outer ring.
    const hitsCorridorAt = (x: number, z: number, w: number): boolean =>
      corridors.some((c) => {
        const lat = c.axis === 'z' ? x : z;
        const along = c.axis === 'z' ? z : x;
        return Math.abs(along) < VIS + 4 && lat + w / 2 > c.l0 - 2 && lat - w / 2 < c.l1 + 2;
      });
    const innerWant = this.farInfo.length + FAR_INNER.COUNT;
    for (let g = 0; this.farInfo.length < Math.min(innerWant, LIMITS.FAR_BUILDINGS) && g < 3000; g++) {
      const ang = rng() * Math.PI * 2;
      const dist = FAR_INNER.R_MIN + rng() * (FAR_INNER.R_MAX - FAR_INNER.R_MIN);
      const x = Math.cos(ang) * dist;
      const z = Math.sin(ang) * dist;
      const w = 18 + rng() * 24;
      const d = 18 + rng() * 24;
      if (Math.max(Math.abs(x) - w / 2, Math.abs(z) - d / 2) < H + FAR_INNER.CLEAR_M) continue;
      if (hitsCorridorAt(x, z, Math.max(w, d))) continue;
      place(x, z, w, d, FAR_INNER.H_MIN + rng() * (FAR_INNER.H_MAX - FAR_INNER.H_MIN));
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
    this.farTowers.visible = this.farInfo.length > 0;
    this.farTowers.instanceMatrix.needsUpdate = true;
    seedAttr.needsUpdate = true;
    archAttr.needsUpdate = true;
    this.farTowers.computeBoundingSphere();
    this.farTowers.frustumCulled = true;
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
    this.traffic.update(simTime);
    this.sky.position.copy(cameraPos);
    // 7B-5: the two blimps cruise slow circles over the far skyline (heading along the orbit tangent).
    // 12A: indexed loop (a per-frame forEach closure would allocate).
    for (let i = 0; i < CITY_FX.BLIMPS.length; i++) {
      blimpPose(CITY_FX.BLIMPS[i], simTime, _bp);
      _euler.set(0, _bp.yaw, Math.sin(simTime * 0.11 + i) * 0.02);
      _quat.setFromEuler(_euler);
      _m4.compose(_pos.set(_bp.x, _bp.y, _bp.z), _quat, _scl.set(1, 1, 1));
      this.blimpHull.setMatrixAt(i, _m4);
      this.blimpBanner.setMatrixAt(i, _m4);
    }
    this.blimpHull.instanceMatrix.needsUpdate = true;
    this.blimpBanner.instanceMatrix.needsUpdate = true;

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

    // 12A-2 nearest-8 Mega-Billboards within 90 m (same allocation-free partial selection).
    const mn = this.megaCount;
    const R2 = MEGA_REFL.RANGE_M * MEGA_REFL.RANGE_M;
    for (let i = 0; i < mn; i++) {
      const dx = this.megaPos[i * 3] - cameraPos.x;
      const dy = this.megaPos[i * 3 + 1] - cameraPos.y;
      const dz = this.megaPos[i * 3 + 2] - cameraPos.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      // Audit fix: a one-sided screen facing away from the camera can never be seen in a reflection.
      const facing = this.megaNrm[i * 3 + 2] > 0.5 || -dx * this.megaNrm[i * 3] - dz * this.megaNrm[i * 3 + 1] >= 0;
      this.megaDist[i] = d2 < R2 && facing ? d2 : Infinity;
    }
    const mPos = this.uMegaReflPos.value;
    const mCol = this.uMegaReflCol.value;
    const mNrm = this.uMegaReflNrm.value;
    let mTake = 0;
    for (let k = 0; k < MEGA_REFL.MAX; k++) {
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < mn; i++) {
        if (this.megaDist[i] < bestD) {
          bestD = this.megaDist[i];
          best = i;
        }
      }
      if (best < 0) break;
      this.megaDist[best] = Infinity;
      mPos[k].set(this.megaPos[best * 3], this.megaPos[best * 3 + 1], this.megaPos[best * 3 + 2], this.megaSize[best * 2]);
      mCol[k].set(this.megaCol[best * 3], this.megaCol[best * 3 + 1], this.megaCol[best * 3 + 2], this.megaSize[best * 2 + 1]);
      mNrm[k].set(this.megaNrm[best * 3], this.megaNrm[best * 3 + 1], this.megaNrm[best * 3 + 2], 0);
      this.megaReflSrc[k] = this.megaSrcIdx[best];
      mTake++;
    }
    for (let k = mTake; k < MEGA_REFL.MAX; k++) this.megaReflSrc[k] = -1;
    this.uMegaReflCount.value = mTake;
  }
}
