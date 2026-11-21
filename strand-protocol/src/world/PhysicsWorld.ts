/**
 * STRAND // PROTOCOL — Collision & queries (§3.3, §3.4, §3.6-3, §5.2, §9.1).
 *
 *  - Uniform XZ grid broadphase over the district's static AABBs (rebuilt per sector, never per frame).
 *  - Swept AABB player movement resolved axis by axis: the move is clamped to the first contact along
 *    each axis, so even 40 m/s motion cannot tunnel through 0.1 m fences. Step-up 0.45 m. Depenetration.
 *  - Sloped on-ramps and fire-escape stair flights (6A-4) as analytic ground surfaces (with a slab underneath).
 *  - Wall-run detection against the flat-face wall-run surfaces (distance ≤ 0.95 m; panels removed in 6A-5).
 *  - Ray / segment casts against world colliders (grapple, bullets, line of sight).
 *  - 6° grapple anchor snap (movement assist only — guns never get aim assist).
 *  - Head-sphere / body-OBB hitbox ray tests for humanoids (targets supplied by the enemy system).
 * All hot paths reuse module-scope scratch objects: zero allocation per frame.
 */
import * as THREE from 'three';
import { LEVEL, PHYSICS } from '../config/constants';
import type { BoxCollider, ColliderKind, GrappleAnchor, RampCollider, SectorLayout } from './CityBuilder';

// -------------------------------------------------------------------------------------------------
// Public result types (callers own and reuse instances)
// -------------------------------------------------------------------------------------------------
export interface RayHit {
  hit: boolean;
  distance: number;
  readonly point: THREE.Vector3;
  readonly normal: THREE.Vector3;
  collider: BoxCollider | null;
  kind: ColliderKind | null;
}

export function createRayHit(): RayHit {
  return { hit: false, distance: 0, point: new THREE.Vector3(), normal: new THREE.Vector3(), collider: null, kind: null };
}

export interface MoveResult {
  grounded: boolean;
  groundKind: ColliderKind | null;
  /** Ramp the player stands on (index into layout.ramps) or −1. */
  rampIndex: number;
  readonly groundNormal: THREE.Vector3;
  /** Horizontal unit vector pointing downhill (zero on flat ground). */
  readonly downhill: THREE.Vector3;
  hitWall: boolean;
  readonly wallNormal: THREE.Vector3;
  hitCeiling: boolean;
  steppedUp: boolean;
}

export function createMoveResult(): MoveResult {
  return {
    grounded: false,
    groundKind: null,
    rampIndex: -1,
    groundNormal: new THREE.Vector3(0, 1, 0),
    downhill: new THREE.Vector3(),
    hitWall: false,
    wallNormal: new THREE.Vector3(),
    hitCeiling: false,
    steppedUp: false,
  };
}

/**
 * 6B-2: a vertical collider face usable for a wall-run, found dynamically around the player (pooled — copy
 * what you keep with `copyWallFace`).
 */
export interface WallFace {
  /** Collider index of the face beside the player's mid-body (same-wall cooldown identity). */
  collider: number;
  /** Outward unit normal (±X or ±Z). */
  readonly normal: THREE.Vector3;
  /** Plane coordinate (x for ±X faces, z for ±Z faces). */
  plane: number;
  /** Along-wall and vertical extent of the face (coplanar stacked colliders merged). */
  lat0: number;
  lat1: number;
  y0: number;
  y1: number;
  building: number;
  /** Player centre → plane distance. */
  distance: number;
  /** −1 = wall on the player's left, +1 = right. */
  side: number;
}

export function createWallFace(): WallFace {
  return { collider: -1, normal: new THREE.Vector3(), plane: 0, lat0: 0, lat1: 0, y0: 0, y1: 0, building: -1, distance: 0, side: 0 };
}

export function copyWallFace(src: WallFace, dst: WallFace): WallFace {
  dst.collider = src.collider;
  dst.normal.copy(src.normal);
  dst.plane = src.plane;
  dst.lat0 = src.lat0;
  dst.lat1 = src.lat1;
  dst.y0 = src.y0;
  dst.y1 = src.y1;
  dst.building = src.building;
  dst.distance = src.distance;
  dst.side = src.side;
  return dst;
}

export type HitRegion = 'HEAD' | 'BODY';

/** Humanoid / drone hitbox: head sphere (HS ×2.5) + yaw-rotated body box. */
export interface HitboxTarget {
  readonly id: number;
  /** Hitboxes of one body share a group (piercing rounds never hit the same body twice). */
  readonly group?: number;
  /** Shield hitbox: piercing rounds pass straight through it (SK_02). */
  readonly shield?: boolean;
  alive: boolean;
  readonly headCenter: THREE.Vector3;
  headRadius: number;
  readonly bodyCenter: THREE.Vector3;
  readonly bodyHalf: THREE.Vector3;
  bodyYaw: number;
}

export interface TargetHit {
  hit: boolean;
  distance: number;
  target: HitboxTarget | null;
  region: HitRegion;
  readonly point: THREE.Vector3;
}

export function createTargetHit(): TargetHit {
  return { hit: false, distance: 0, target: null, region: 'BODY', point: new THREE.Vector3() };
}

export interface AnchorSnap {
  anchor: GrappleAnchor | null;
  angleDeg: number;
  distance: number;
}

// -------------------------------------------------------------------------------------------------
// Scratch
// -------------------------------------------------------------------------------------------------
const EPS = 1e-4;
const SKIN = 0.001;
const STEP_HEIGHT = 0.45;
const CELL = 8;
const GRID_MIN = -LEVEL.HALF_EXTENT_M - 16;
const GRID_SIZE = Math.ceil((LEVEL.HALF_EXTENT_M * 2 + 32) / CELL);
const MAX_CANDIDATES = 4096;

const _bmin = new THREE.Vector3();
const _bmax = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();
const _hit = createRayHit();
const _save = new THREE.Vector3();
const _rampN = new THREE.Vector3();

type Axis3 = 'x' | 'y' | 'z';
const AXES_XZ = ['x', 'z'] as const;
const CORNERS: ReadonlyArray<readonly [number, number]> = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
/** 6A-4: body half-width used against open steel stair flights (0.9 m lanes side by side). */
const STEEL_FLIGHT_BODY_R = 0.22;
/** 6B-2: collider kinds whose vertical faces can be wall-run (buildings, expressway, bridges, sky-bridges). */
const WALL_KINDS: ReadonlySet<ColliderKind> = new Set<ColliderKind>(['BUILDING', 'HIGHWAY', 'BRIDGE', 'SKYBRIDGE']);
const MAX_WALL_FACES = 6;
const _down = new THREE.Vector3(0, -1, 0);
const _origin = new THREE.Vector3();
const _ledgeP = new THREE.Vector3();

export class PhysicsWorld {
  private layout: SectorLayout | null = null;
  private colliders: readonly BoxCollider[] = [];
  private ramps: readonly RampCollider[] = [];
  private readonly wallFaces: WallFace[] = Array.from({ length: MAX_WALL_FACES }, createWallFace);
  private wallFaceCount = 0;
  private anchors: readonly GrappleAnchor[] = [];
  private readonly cells: number[][] = Array.from({ length: GRID_SIZE * GRID_SIZE }, () => []);
  private stamps = new Int32Array(1);
  private stamp = 1;
  private readonly cand = new Int32Array(MAX_CANDIDATES);
  private candCount = 0;
  private gateOpen = false;

  setLayout(layout: SectorLayout): void {
    this.layout = layout;
    this.colliders = layout.colliders;
    this.ramps = layout.ramps;
    this.anchors = layout.anchors;
    this.gateOpen = layout.gate.open;
    for (const c of this.cells) c.length = 0;
    this.stamps = new Int32Array(this.colliders.length);
    this.stamp = 1;
    this.colliders.forEach((c, i) => {
      const x0 = this.cellIndex(c.min.x);
      const x1 = this.cellIndex(c.max.x);
      const z0 = this.cellIndex(c.min.z);
      const z1 = this.cellIndex(c.max.z);
      for (let gx = x0; gx <= x1; gx++) for (let gz = z0; gz <= z1; gz++) this.cells[gz * GRID_SIZE + gx].push(i);
    });
  }

  get currentLayout(): SectorLayout | null {
    return this.layout;
  }

  /** The district gate section of the barrier becomes passable once the sector is cleared. */
  setGateOpen(open: boolean): void {
    this.gateOpen = open;
  }

  // ===============================================================================================
  // Broadphase
  // ===============================================================================================
  private cellIndex(v: number): number {
    return Math.max(0, Math.min(GRID_SIZE - 1, Math.floor((v - GRID_MIN) / CELL)));
  }

  /** Collects candidate collider indices overlapping the XZ box into `this.cand`. */
  private gather(minX: number, minZ: number, maxX: number, maxZ: number): void {
    this.stamp++;
    if (this.stamp > 0x3fffffff) {
      this.stamps.fill(0);
      this.stamp = 1;
    }
    this.candCount = 0;
    const x0 = this.cellIndex(minX);
    const x1 = this.cellIndex(maxX);
    const z0 = this.cellIndex(minZ);
    const z1 = this.cellIndex(maxZ);
    for (let gz = z0; gz <= z1; gz++) {
      for (let gx = x0; gx <= x1; gx++) {
        const cell = this.cells[gz * GRID_SIZE + gx];
        for (let k = 0; k < cell.length; k++) {
          const i = cell[k];
          if (this.stamps[i] === this.stamp) continue;
          this.stamps[i] = this.stamp;
          if (this.candCount < MAX_CANDIDATES) this.cand[this.candCount++] = i;
        }
      }
    }
  }

  private solid(c: BoxCollider): boolean {
    return !(c.gate && this.gateOpen);
  }

  // ===============================================================================================
  // Player movement (swept AABB, axis by axis)
  // ===============================================================================================
  /**
   * Moves the player box (feet-centred, half-width `r`, height `h`) by `delta`, resolving collisions.
   * `wasGrounded` enables step-up and ground snapping (ramps / step-down ≤ 0.6 m).
   */
  movePlayer(pos: THREE.Vector3, r: number, h: number, delta: THREE.Vector3, wasGrounded: boolean, out: MoveResult): void {
    out.grounded = false;
    out.groundKind = null;
    out.rampIndex = -1;
    out.groundNormal.set(0, 1, 0);
    out.downhill.set(0, 0, 0);
    out.hitWall = false;
    out.wallNormal.set(0, 0, 0);
    out.hitCeiling = false;
    out.steppedUp = false;

    this.gather(
      Math.min(pos.x, pos.x + delta.x) - r - 1,
      Math.min(pos.z, pos.z + delta.z) - r - 1,
      Math.max(pos.x, pos.x + delta.x) + r + 1,
      Math.max(pos.z, pos.z + delta.z) + r + 1,
    );
    this.depenetrate(pos, r, h);

    // Vertical first (landing / ceilings), then horizontal axes.
    const dy = this.sweepAxis(pos, r, h, 'y', delta.y);
    if (delta.y > 0) {
      // Ramp underside is a ceiling: a jump from below stops under the slab instead of warping on top (5A-3).
      const slabBottom = this.rampCeiling(pos, r, h);
      if (slabBottom !== null && pos.y + dy + h > slabBottom) {
        pos.y = slabBottom - h - SKIN;
        out.hitCeiling = true;
      } else pos.y += dy;
    } else pos.y += dy;
    if (delta.y < 0 && dy > delta.y + EPS) {
      out.grounded = true;
      out.groundKind = this.lastKind;
    } else if (delta.y > 0 && dy < delta.y - EPS) {
      out.hitCeiling = true;
    }

    for (const axis of AXES_XZ) {
      const d = axis === 'x' ? delta.x : delta.z;
      if (Math.abs(d) < 1e-9) continue;
      let moved = this.sweepAxis(pos, r, h, axis, d);
      if (Math.abs(moved - d) > EPS && wasGrounded) {
        // Step-up: lift, move, drop back down.
        _save.copy(pos);
        const up = this.sweepAxis(pos, r, h, 'y', STEP_HEIGHT);
        pos.y += up;
        const moved2 = this.sweepAxis(pos, r, h, axis, d);
        if (Math.abs(moved2) > Math.abs(moved) + 0.01) {
          if (axis === 'x') pos.x += moved2;
          else pos.z += moved2;
          const down = this.sweepAxis(pos, r, h, 'y', -up - 0.02);
          pos.y += down;
          out.steppedUp = true;
          moved = d;
          continue;
        }
        pos.copy(_save);
      }
      if (this.blockedByRampSlab(pos, r, h, axis, moved)) moved = 0;
      if (axis === 'x') pos.x += moved;
      else pos.z += moved;
      if (Math.abs(moved - d) > EPS) {
        out.hitWall = true;
        if (axis === 'x') out.wallNormal.set(-Math.sign(d), 0, 0);
        else out.wallNormal.set(0, 0, -Math.sign(d));
      }
    }

    // Ramps act as analytic ground.
    const rampY = this.rampSurface(pos, r, out);
    if (rampY !== null) {
      const gap = pos.y - rampY;
      const falling = delta.y <= 0;
      if ((gap < 0 && gap > -0.6) || (falling && gap >= 0 && (gap < 0.05 || (wasGrounded && gap < 0.6)))) {
        pos.y = rampY;
        out.grounded = true;
        out.groundKind = 'HIGHWAY';
      } else {
        out.rampIndex = -1;
        out.groundNormal.set(0, 1, 0);
        out.downhill.set(0, 0, 0);
      }
    }

    // Step-down snap: keep contact walking off tiny ledges / down ramps.
    if (!out.grounded && wasGrounded && delta.y <= 0) {
      const probe = this.sweepAxis(pos, r, h, 'y', -0.6);
      if (probe > -0.6 + EPS) {
        pos.y += probe;
        out.grounded = true;
        out.groundKind = this.lastKind;
      }
    }
  }

  private lastKind: ColliderKind | null = null;

  /** Largest allowed displacement along `axis` (≤ |d|) before touching a solid candidate. */
  private sweepAxis(pos: THREE.Vector3, r: number, h: number, axis: Axis3, d: number): number {
    if (d === 0) return 0;
    _bmin.set(pos.x - r, pos.y, pos.z - r);
    _bmax.set(pos.x + r, pos.y + h, pos.z + r);
    let allowed = d;
    this.lastKind = null;
    for (let k = 0; k < this.candCount; k++) {
      const c = this.colliders[this.cand[k]];
      if (!this.solid(c)) continue;
      if (axis !== 'x' && (_bmax.x <= c.min.x + EPS || _bmin.x >= c.max.x - EPS)) continue;
      if (axis !== 'y' && (_bmax.y <= c.min.y + EPS || _bmin.y >= c.max.y - EPS)) continue;
      if (axis !== 'z' && (_bmax.z <= c.min.z + EPS || _bmin.z >= c.max.z - EPS)) continue;
      if (d > 0) {
        if (c.min[axis] >= _bmax[axis] - EPS) {
          const dist = c.min[axis] - _bmax[axis] - SKIN;
          if (dist < allowed) {
            allowed = Math.max(0, dist);
            this.lastKind = c.kind;
          }
        }
      } else if (c.max[axis] <= _bmin[axis] + EPS) {
        const dist = c.max[axis] - _bmin[axis] + SKIN;
        if (dist > allowed) {
          allowed = Math.min(0, dist);
          this.lastKind = c.kind;
        }
      }
    }
    return allowed;
  }

  /** Pushes the box out of any solid it overlaps (minimum-translation axis). */
  private depenetrate(pos: THREE.Vector3, r: number, h: number): void {
    for (let iter = 0; iter < 4; iter++) {
      let pushed = false;
      for (let k = 0; k < this.candCount; k++) {
        const c = this.colliders[this.cand[k]];
        if (!this.solid(c)) continue;
        const ox = Math.min(pos.x + r, c.max.x) - Math.max(pos.x - r, c.min.x);
        const oy = Math.min(pos.y + h, c.max.y) - Math.max(pos.y, c.min.y);
        const oz = Math.min(pos.z + r, c.max.z) - Math.max(pos.z - r, c.min.z);
        if (ox <= EPS || oy <= EPS || oz <= EPS) continue;
        // Prefer lifting onto shallow tops (≤ 0.5 m) — avoids sinking into steps after landing.
        const upPush = c.max.y - pos.y;
        if (upPush > 0 && upPush <= 0.5) {
          pos.y += upPush + SKIN;
        } else if (ox <= oz && ox <= oy) {
          pos.x += pos.x < (c.min.x + c.max.x) / 2 ? -ox - SKIN : ox + SKIN;
        } else if (oz <= oy) {
          pos.z += pos.z < (c.min.z + c.max.z) / 2 ? -oz - SKIN : oz + SKIN;
        } else {
          pos.y += pos.y + h / 2 < (c.min.y + c.max.y) / 2 ? -oy - SKIN : oy + SKIN;
        }
        pushed = true;
      }
      if (!pushed) return;
    }
  }

  // ===============================================================================================
  // Ramps
  // ===============================================================================================
  private rampHeightAt(rp: RampCollider, x: number, z: number): number | null {
    const along = rp.axis === 'z' ? z : x;
    const lat = rp.axis === 'z' ? x : z;
    const a0 = Math.min(rp.alongStart, rp.alongEnd);
    const a1 = Math.max(rp.alongStart, rp.alongEnd);
    if (lat < rp.lateralMin || lat > rp.lateralMax || along < a0 || along > a1) return null;
    const t = (along - rp.alongStart) / (rp.alongEnd - rp.alongStart);
    return rp.yStart + (rp.yEnd - rp.yStart) * t;
  }

  /** Highest ramp surface under the player centre (fills out.rampIndex / normal / downhill). */
  private rampSurface(pos: THREE.Vector3, _r: number, out: MoveResult): number | null {
    let best: number | null = null;
    for (let i = 0; i < this.ramps.length; i++) {
      const rp = this.ramps[i];
      const y = this.rampHeightAt(rp, pos.x, pos.z);
      if (y === null || y > pos.y + 0.6) continue;
      if (best === null || y > best) {
        best = y;
        out.rampIndex = i;
        const len = Math.abs(rp.alongEnd - rp.alongStart);
        const rise = rp.yStart - rp.yEnd;
        // Downhill points from start (high) toward end (low).
        const s = Math.sign(rp.alongEnd - rp.alongStart);
        if (rp.axis === 'z') out.downhill.set(0, 0, s);
        else out.downhill.set(s, 0, 0);
        const slope = Math.atan2(rise, len);
        out.groundNormal.set(out.downhill.x * Math.sin(slope), Math.cos(slope), out.downhill.z * Math.sin(slope));
      }
    }
    return best;
  }

  /**
   * Lowest ramp underside (surface − thickness) above the head of a box at `pos`, sampled at the centre and
   * the four footprint corners; only slabs the head is still below (5 cm tolerance) count. Null if none.
   */
  private rampCeiling(pos: THREE.Vector3, r: number, h: number): number | null {
    let best: number | null = null;
    const head = pos.y + h;
    for (let i = 0; i < this.ramps.length; i++) {
      const rp = this.ramps[i];
      const rr = rp.steel ? Math.min(r, STEEL_FLIGHT_BODY_R) : r;
      for (let c = -1; c < CORNERS.length; c++) {
        const x = c < 0 ? pos.x : pos.x + CORNERS[c][0] * rr;
        const z = c < 0 ? pos.z : pos.z + CORNERS[c][1] * rr;
        const y = this.rampHeightAt(rp, x, z);
        if (y === null) continue;
        const bottom = y - rp.thickness;
        if (head > bottom + 0.05) continue;
        if (best === null || bottom < best) best = bottom;
      }
    }
    return best;
  }

  /** The ramp slab (0.5 m thick) blocks walking into it from underneath / the side. */
  private blockedByRampSlab(pos: THREE.Vector3, r: number, h: number, axis: 'x' | 'z', d: number): boolean {
    if (d === 0) return false;
    const nx = axis === 'x' ? pos.x + d : pos.x;
    const nz = axis === 'z' ? pos.z + d : pos.z;
    for (const rp of this.ramps) {
      const rr = rp.steel ? Math.min(r, STEEL_FLIGHT_BODY_R) : r;
      for (const [cx, cz] of CORNERS) {
        const y = this.rampHeightAt(rp, nx + cx * rr, nz + cz * rr);
        if (y === null) continue;
        const slabBottom = y - rp.thickness;
        // Standing on / just above the surface is fine; the body intersecting the slab is not.
        if (pos.y >= y - 0.6) continue;
        if (pos.y + h > slabBottom && pos.y < y) return true;
      }
    }
    return false;
  }

  /** True when a box (feet-centred, half-width r, height h) at `pos` overlaps no solid (headroom checks). */
  boxFree(pos: THREE.Vector3, r: number, h: number): boolean {
    this.gather(pos.x - r - 0.5, pos.z - r - 0.5, pos.x + r + 0.5, pos.z + r + 0.5);
    for (let k = 0; k < this.candCount; k++) {
      const c = this.colliders[this.cand[k]];
      if (!this.solid(c)) continue;
      if (pos.x + r <= c.min.x + EPS || pos.x - r >= c.max.x - EPS) continue;
      if (pos.y + h <= c.min.y + EPS || pos.y >= c.max.y - EPS) continue;
      if (pos.z + r <= c.min.z + EPS || pos.z - r >= c.max.z - EPS) continue;
      return false;
    }
    return true;
  }

  /** Ground height directly below `pos` within `maxDrop` (for shadows / landing previews). */
  probeGround(pos: THREE.Vector3, r: number, maxDrop: number): number | null {
    this.gather(pos.x - r - 1, pos.z - r - 1, pos.x + r + 1, pos.z + r + 1);
    const d = this.sweepAxis(pos, r, 0.1, 'y', -maxDrop);
    if (d <= -maxDrop + EPS) return null;
    return pos.y + d;
  }

  // ===============================================================================================
  // Wall-run detection
  // ===============================================================================================
  /**
   * 6B-2 anywhere wall-run: the vertical faces of BUILDING / HIGHWAY / BRIDGE / SKYBRIDGE colliders around the
   * player (spatial grid, no fixed list). Coplanar stacked colliders are merged (expressway deck edge + guard
   * wall), so a face qualifies with height ≥ 2.2 m and width ≥ 2.5 m, the player centre within `maxDist` of
   * the plane, inside its width, and the mid-body inside [y0 + 0.3, y1 − 0.2]. Shallow decorations (mullions,
   * canopy lips ≤ 0.45 m) carry no collider, so runs never snag on them.
   * Fills a pooled list sorted by distance and returns its length; `onlyNormal` keeps faces parallel to a wall
   * (continuation across seams / gaps). `right` classifies left / right walls.
   */
  findWallFaces(pos: THREE.Vector3, h: number, right: THREE.Vector3, maxDist: number = PHYSICS.WALLRUN_DETECT_DISTANCE, onlyNormal: THREE.Vector3 | null = null): number {
    this.wallFaceCount = 0;
    const R = maxDist + 0.2;
    this.gather(pos.x - R, pos.z - R, pos.x + R, pos.z + R);
    const midY = pos.y + h * 0.5;
    for (let k = 0; k < this.candCount; k++) {
      const ci = this.cand[k];
      const c = this.colliders[ci];
      if (!WALL_KINDS.has(c.kind) || !this.solid(c)) continue;
      // Identity: the collider whose own height range holds the mid-body (one face per stack).
      if (midY < c.min.y - 0.05 || midY > c.max.y + 0.05) continue;
      for (let f = 0; f < 4; f++) {
        const onX = f < 2;
        const sgn = f % 2 === 0 ? 1 : -1;
        const nx = onX ? sgn : 0;
        const nz = onX ? 0 : sgn;
        if (onlyNormal && nx * onlyNormal.x + nz * onlyNormal.z < 0.95) continue;
        const plane = onX ? (sgn > 0 ? c.max.x : c.min.x) : sgn > 0 ? c.max.z : c.min.z;
        const dist = onX ? (pos.x - plane) * sgn : (pos.z - plane) * sgn;
        if (dist < -0.05 || dist > maxDist) continue;
        const lat = onX ? pos.z : pos.x;
        const l0 = onX ? c.min.z : c.min.x;
        const l1 = onX ? c.max.z : c.max.x;
        if (l1 - l0 < PHYSICS.WALLRUN_MIN_FACE_WIDTH || lat < l0 || lat > l1) continue;
        let y0 = c.min.y;
        let y1 = c.max.y;
        for (let pass = 0; pass < 2; pass++) {
          for (let j = 0; j < this.candCount; j++) {
            if (j === k) continue;
            const o = this.colliders[this.cand[j]];
            if (!WALL_KINDS.has(o.kind) || !this.solid(o)) continue;
            const op = onX ? (sgn > 0 ? o.max.x : o.min.x) : sgn > 0 ? o.max.z : o.min.z;
            if (Math.abs(op - plane) > 0.03) continue;
            if (lat < (onX ? o.min.z : o.min.x) || lat > (onX ? o.max.z : o.max.x)) continue;
            if (o.max.y < y0 - 0.05 || o.min.y > y1 + 0.05) continue;
            y0 = Math.min(y0, o.min.y);
            y1 = Math.max(y1, o.max.y);
          }
        }
        if (y1 - y0 < PHYSICS.WALLRUN_MIN_FACE_HEIGHT || midY < y0 + 0.3 || midY > y1 - 0.2) continue;
        // Seams of a stack yield the same face twice: keep one.
        let dup = false;
        for (let i = 0; i < this.wallFaceCount; i++) {
          const w = this.wallFaces[i];
          if (w.normal.x === nx && w.normal.z === nz && Math.abs(w.plane - plane) < 0.03) dup = true;
        }
        if (dup) continue;
        // Insert sorted by distance into the fixed pool (reference swaps only — allocation-free).
        let at: number;
        if (this.wallFaceCount < MAX_WALL_FACES) at = this.wallFaceCount++;
        else if (dist < this.wallFaces[MAX_WALL_FACES - 1].distance) at = MAX_WALL_FACES - 1;
        else continue;
        const w = this.wallFaces[at];
        w.collider = ci;
        w.normal.set(nx, 0, nz);
        w.plane = plane;
        w.lat0 = l0;
        w.lat1 = l1;
        w.y0 = y0;
        w.y1 = y1;
        w.building = c.building;
        w.distance = dist;
        // Wall normal pointing toward the player's right ⇒ the wall is on the left.
        w.side = nx * right.x + nz * right.z > 0 ? -1 : 1;
        while (at > 0 && this.wallFaces[at - 1].distance > w.distance) {
          this.wallFaces[at] = this.wallFaces[at - 1];
          this.wallFaces[at - 1] = w;
          at--;
        }
      }
    }
    return this.wallFaceCount;
  }

  /** i-th face of the last `findWallFaces` call (pooled). */
  wallFace(i: number): WallFace {
    return this.wallFaces[i];
  }

  /**
   * 6B-2 condition ①: free fall below the feet — distance to the first solid / ramp straight down, up to
   * `maxCheck` (Infinity when nothing is that close).
   */
  groundClearance(pos: THREE.Vector3, maxCheck: number): number {
    _origin.set(pos.x, pos.y + 0.05, pos.z);
    this.raycast(_origin, _down, maxCheck + 0.05, _hit);
    return _hit.hit ? Math.max(0, _hit.distance - 0.05) : Infinity;
  }

  /**
   * 7A-6 auto-mantle ledge probe. Marches forward from the body surface (≤ `reach` m) casting rays straight
   * down from `maxRise` above the feet to `minRise`: the first upward-facing top of a mantle-able collider
   * (not WATER / BARRIER) is the ledge. The body (half-width r, height h) must fit on top one radius past the
   * edge and the column above the current position must be clear up to the ledge height. A thin top with
   * a lower floor right behind it (balcony / fire-escape rail) is vaulted: the body passes over the rail top
   * (`ledgeApex`) and lands on the slab beyond. Writes the standing position (feet) into `out` and returns
   * the collider kind, or null.
   */
  ledgeApex = 0;
  findLedge(pos: THREE.Vector3, fwd: THREE.Vector3, r: number, h: number, minRise: number, maxRise: number, reach: number, out: THREE.Vector3): ColliderKind | 'RAMP' | null {
    const span = maxRise - minRise;
    for (let s = r + 0.04; s <= r + reach + 1e-6; s += 0.08) {
      _origin.set(pos.x + fwd.x * s, pos.y + maxRise + 0.02, pos.z + fwd.z * s);
      this.raycast(_origin, _down, span + 0.02, _hit);
      if (!_hit.hit) continue;
      if (_hit.normal.y < 0.7) return null;
      const kind = _hit.kind;
      if (kind === 'WATER' || kind === 'BARRIER') return null;
      const ly = _hit.point.y;
      // Headroom above us at ledge height (the pull-up path), then the standing spot on top.
      _ledgeP.set(pos.x, ly + 0.05, pos.z);
      if (!this.boxFree(_ledgeP, r, h)) return null;
      out.set(pos.x + fwd.x * (s + r + 0.06), ly + 0.05, pos.z + fwd.z * (s + r + 0.06));
      if (!this.boxFree(out, r, h)) return null;
      const g = this.probeGround(out, r, ly + 0.05 - (pos.y + 0.3));
      if (g === null) return null;
      out.y = g + 0.01;
      if (g < ly - 0.3 && !this.boxFree(out, r, h)) return null;
      this.ledgeApex = ly + 0.05;
      return kind ?? 'RAMP';
    }
    return null;
  }

  // ===============================================================================================
  // Rays
  // ===============================================================================================
  /**
   * Ray vs world AABBs (slab test). `ignore` filters collider kinds (e.g. WATER / GROUND for the grapple).
   * Returns `out` (hit = false when nothing within maxDist).
   */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, out: RayHit, ignore?: ReadonlySet<ColliderKind>): RayHit {
    out.hit = false;
    out.distance = maxDist;
    out.collider = null;
    out.kind = null;
    const ex = origin.x + dir.x * maxDist;
    const ez = origin.z + dir.z * maxDist;
    this.gather(Math.min(origin.x, ex) - 0.5, Math.min(origin.z, ez) - 0.5, Math.max(origin.x, ex) + 0.5, Math.max(origin.z, ez) + 0.5);
    let best = maxDist;
    let bestIdx = -1;
    let bestAxis = 0;
    let bestSign = 0;
    const ix = 1 / (Math.abs(dir.x) > 1e-12 ? dir.x : 1e-12);
    const iy = 1 / (Math.abs(dir.y) > 1e-12 ? dir.y : 1e-12);
    const iz = 1 / (Math.abs(dir.z) > 1e-12 ? dir.z : 1e-12);
    for (let k = 0; k < this.candCount; k++) {
      const c = this.colliders[this.cand[k]];
      if (!this.solid(c) || (ignore && ignore.has(c.kind))) continue;
      let t0 = 0;
      let t1 = best;
      let axis = -1;
      let sign = 0;
      // X slab
      let ta = (c.min.x - origin.x) * ix;
      let tb = (c.max.x - origin.x) * ix;
      if (ta > tb) {
        const sw = ta;
        ta = tb;
        tb = sw;
      }
      if (ta > t0) {
        t0 = ta;
        axis = 0;
        sign = dir.x > 0 ? -1 : 1;
      }
      if (tb < t1) t1 = tb;
      if (t0 > t1) continue;
      // Y slab
      ta = (c.min.y - origin.y) * iy;
      tb = (c.max.y - origin.y) * iy;
      if (ta > tb) {
        const sw = ta;
        ta = tb;
        tb = sw;
      }
      if (ta > t0) {
        t0 = ta;
        axis = 1;
        sign = dir.y > 0 ? -1 : 1;
      }
      if (tb < t1) t1 = tb;
      if (t0 > t1) continue;
      // Z slab
      ta = (c.min.z - origin.z) * iz;
      tb = (c.max.z - origin.z) * iz;
      if (ta > tb) {
        const sw = ta;
        ta = tb;
        tb = sw;
      }
      if (ta > t0) {
        t0 = ta;
        axis = 2;
        sign = dir.z > 0 ? -1 : 1;
      }
      if (tb < t1) t1 = tb;
      if (t0 > t1 || axis < 0) continue; // axis < 0 ⇒ origin inside the box: ignore
      if (t0 < best) {
        best = t0;
        bestIdx = this.cand[k];
        bestAxis = axis;
        bestSign = sign;
      }
    }
    if (bestIdx >= 0) {
      out.hit = true;
      out.distance = best;
      out.point.copy(dir).multiplyScalar(best).add(origin);
      out.normal.set(bestAxis === 0 ? bestSign : 0, bestAxis === 1 ? bestSign : 0, bestAxis === 2 ? bestSign : 0);
      out.collider = this.colliders[bestIdx];
      out.kind = out.collider.kind;
    }
    // Sloped on-ramp slabs (top y(along), bottom y − thickness): rounds, strand hooks and enemy sight lines
    // can never pass through an on-ramp (5A-3).
    if (!(ignore && ignore.has('HIGHWAY'))) {
      for (let i = 0; i < this.ramps.length; i++) {
        const t = this.rayRamp(this.ramps[i], origin, dir, out.hit ? out.distance : maxDist, _rampN);
        if (t < 0) continue;
        out.hit = true;
        out.distance = t;
        out.point.copy(dir).multiplyScalar(t).add(origin);
        out.normal.copy(_rampN);
        out.collider = null;
        out.kind = 'HIGHWAY';
      }
    }
    return out;
  }

  /**
   * Ray vs one ramp slab, in the ramp's (along, lateral, y) frame: the solid is a ≤ along ≤ b,
   * lmin ≤ lateral ≤ lmax and −thickness ≤ y − surface(along) ≤ 0 — three linear slabs in t.
   * Returns the entry distance (< maxDist) and the entry normal, or −1.
   */
  private rayRamp(rp: RampCollider, origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, n: THREE.Vector3): number {
    const alongZ = rp.axis === 'z';
    const oA = alongZ ? origin.z : origin.x;
    const dA = alongZ ? dir.z : dir.x;
    const oL = alongZ ? origin.x : origin.z;
    const dL = alongZ ? dir.x : dir.z;
    const span = rp.alongEnd - rp.alongStart;
    if (Math.abs(span) < 1e-6) return -1;
    const k = (rp.yEnd - rp.yStart) / span;
    let t0 = 0;
    let t1 = maxDist;
    let which = -1; // 0 along end, 1 lateral side, 2 top / bottom
    let sign = 0;
    // Along slab.
    const a0 = Math.min(rp.alongStart, rp.alongEnd);
    const a1 = Math.max(rp.alongStart, rp.alongEnd);
    if (Math.abs(dA) < 1e-12) {
      if (oA < a0 || oA > a1) return -1;
    } else {
      let ta = (a0 - oA) / dA;
      let tb = (a1 - oA) / dA;
      if (ta > tb) {
        const s = ta;
        ta = tb;
        tb = s;
      }
      if (ta > t0) {
        t0 = ta;
        which = 0;
        sign = dA > 0 ? -1 : 1;
      }
      if (tb < t1) t1 = tb;
      if (t0 > t1) return -1;
    }
    // Lateral slab.
    if (Math.abs(dL) < 1e-12) {
      if (oL < rp.lateralMin || oL > rp.lateralMax) return -1;
    } else {
      let ta = (rp.lateralMin - oL) / dL;
      let tb = (rp.lateralMax - oL) / dL;
      if (ta > tb) {
        const s = ta;
        ta = tb;
        tb = s;
      }
      if (ta > t0) {
        t0 = ta;
        which = 1;
        sign = dL > 0 ? -1 : 1;
      }
      if (tb < t1) t1 = tb;
      if (t0 > t1) return -1;
    }
    // Height slab: f(t) = y(t) − surface(along(t)) ∈ [−thickness, 0].
    const f0 = origin.y - rp.yStart - k * (oA - rp.alongStart);
    const fd = dir.y - k * dA;
    if (Math.abs(fd) < 1e-12) {
      if (f0 < -rp.thickness || f0 > 0) return -1;
    } else {
      let ta = (-rp.thickness - f0) / fd;
      let tb = (0 - f0) / fd;
      let fromTop = false;
      if (ta > tb) {
        const s = ta;
        ta = tb;
        tb = s;
        fromTop = true;
      }
      if (ta > t0) {
        t0 = ta;
        which = 2;
        sign = fromTop ? 1 : -1;
      }
      if (tb < t1) t1 = tb;
      if (t0 > t1) return -1;
    }
    if (which < 0 || t0 >= maxDist) return -1; // origin inside the slab, or farther than the current best
    if (which === 2) {
      // Surface normal (−k along, 1 up), flipped for the underside.
      const inv = 1 / Math.sqrt(1 + k * k);
      if (alongZ) n.set(0, inv, -k * inv);
      else n.set(-k * inv, inv, 0);
      if (sign < 0) n.negate();
    } else if (which === 0) {
      if (alongZ) n.set(0, 0, sign);
      else n.set(sign, 0, 0);
    } else if (alongZ) n.set(sign, 0, 0);
    else n.set(0, 0, sign);
    return t0;
  }

  /** Segment a → b (projectile step). */
  segmentCast(a: THREE.Vector3, b: THREE.Vector3, out: RayHit, ignore?: ReadonlySet<ColliderKind>): RayHit {
    _dir.subVectors(b, a);
    const len = _dir.length();
    if (len < 1e-6) {
      out.hit = false;
      return out;
    }
    _dir.divideScalar(len);
    _tmp2.copy(_dir);
    return this.raycast(a, _tmp2, len, out, ignore);
  }

  /** Line of sight between two points (true when unobstructed). */
  lineOfSight(a: THREE.Vector3, b: THREE.Vector3, endTolerance = 0.6): boolean {
    _dir.subVectors(b, a);
    const len = _dir.length();
    if (len < 1e-6) return true;
    _dir.divideScalar(len);
    _tmp2.copy(_dir);
    this.raycast(a, _tmp2, len, _hit, LOS_IGNORE);
    return !_hit.hit || _hit.distance >= len - endTolerance;
  }

  // ===============================================================================================
  // Grapple anchor snap (§3.6-3): nearest gold anchor within the grapple range and 6° of the view centre
  // ===============================================================================================
  findSnapAnchor(eye: THREE.Vector3, viewDir: THREE.Vector3, range: number, maxAngleDeg: number, out: AnchorSnap): AnchorSnap {
    out.anchor = null;
    out.angleDeg = Infinity;
    out.distance = 0;
    const cosMax = Math.cos((maxAngleDeg * Math.PI) / 180);
    // Up to three best candidates are verified with line-of-sight rays.
    let c0: GrappleAnchor | null = null;
    let c1: GrappleAnchor | null = null;
    let c2: GrappleAnchor | null = null;
    let a0 = -2;
    let a1 = -2;
    let a2 = -2;
    for (const an of this.anchors) {
      if (!an.enabled) continue;
      _tmp.subVectors(an.position, eye);
      const d = _tmp.length();
      if (d > range || d < 2) continue;
      const cos = _tmp.dot(viewDir) / d;
      if (cos < cosMax) continue;
      if (cos > a0) {
        c2 = c1; a2 = a1; c1 = c0; a1 = a0; c0 = an; a0 = cos;
      } else if (cos > a1) {
        c2 = c1; a2 = a1; c1 = an; a1 = cos;
      } else if (cos > a2) {
        c2 = an; a2 = cos;
      }
    }
    if (this.acceptSnap(eye, c0, a0, out) || this.acceptSnap(eye, c1, a1, out)) return out;
    this.acceptSnap(eye, c2, a2, out);
    return out;
  }

  private acceptSnap(eye: THREE.Vector3, an: GrappleAnchor | null, cos: number, out: AnchorSnap): boolean {
    if (!an || !this.lineOfSight(eye, an.position, 1.2)) return false;
    out.anchor = an;
    out.angleDeg = (Math.acos(Math.min(1, cos)) * 180) / Math.PI;
    out.distance = eye.distanceTo(an.position);
    return true;
  }

  // ===============================================================================================
  // Hitboxes (§5.2): head sphere first (HS), then body OBB (yaw-rotated)
  // ===============================================================================================
  /**
   * Nearest hitbox along the ray. `skipGroup` ≥ 0 ignores every hitbox of that body group; `skipShields` lets the
   * ray pass through shield hitboxes (piercing rounds).
   */
  raycastTargets(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, targets: readonly HitboxTarget[], out: TargetHit, skipGroup = -1, skipShields = false): TargetHit {
    out.hit = false;
    out.target = null;
    out.distance = maxDist;
    for (const t of targets) {
      if (!t.alive) continue;
      if (skipShields && t.shield) continue;
      if (skipGroup >= 0 && t.group === skipGroup) continue;
      // Head sphere (radius ≤ 0 ⇒ the target has no head region, e.g. shields / wings).
      const th = t.headRadius > 0 ? raySphere(origin, dir, t.headCenter, t.headRadius) : -1;
      if (th >= 0 && th < out.distance) {
        out.hit = true;
        out.distance = th;
        out.target = t;
        out.region = 'HEAD';
      }
      // Body box rotated about Y (zero half-extent ⇒ head-only target, e.g. missiles).
      const tb = t.bodyHalf.x > 0 ? rayYawBox(origin, dir, t.bodyCenter, t.bodyHalf, t.bodyYaw) : -1;
      if (tb >= 0 && tb < out.distance - 1e-4) {
        out.hit = true;
        out.distance = tb;
        out.target = t;
        out.region = 'BODY';
      }
    }
    if (out.hit) out.point.copy(dir).multiplyScalar(out.distance).add(origin);
    return out;
  }
}

const LOS_IGNORE: ReadonlySet<ColliderKind> = new Set<ColliderKind>(['WATER', 'BARRIER']);

/** Ray vs sphere: distance or −1. */
function raySphere(o: THREE.Vector3, d: THREE.Vector3, c: THREE.Vector3, r: number): number {
  const ox = o.x - c.x;
  const oy = o.y - c.y;
  const oz = o.z - c.z;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - cc;
  if (disc < 0) return -1;
  const s = Math.sqrt(disc);
  const t = -b - s;
  if (t >= 0) return t;
  const t2 = -b + s;
  return t2 >= 0 ? 0 : -1;
}

/** Ray vs box rotated by `yaw` about Y: distance or −1 (closure-free slab test). */
let _t0 = 0;
let _t1 = 0;
function slab(oo: number, dd: number, h: number): boolean {
  if (Math.abs(dd) < 1e-12) return Math.abs(oo) <= h;
  let a = (-h - oo) / dd;
  let b = (h - oo) / dd;
  if (a > b) {
    const t = a;
    a = b;
    b = t;
  }
  if (a > _t0) _t0 = a;
  if (b < _t1) _t1 = b;
  return _t0 <= _t1;
}

function rayYawBox(o: THREE.Vector3, d: THREE.Vector3, c: THREE.Vector3, half: THREE.Vector3, yaw: number): number {
  const cs = Math.cos(-yaw);
  const sn = Math.sin(-yaw);
  const px = o.x - c.x;
  const pz = o.z - c.z;
  const lox = px * cs + pz * sn;
  const loz = -px * sn + pz * cs;
  const ldx = d.x * cs + d.z * sn;
  const ldz = -d.x * sn + d.z * cs;
  _t0 = 0;
  _t1 = Infinity;
  if (!slab(lox, ldx, half.x) || !slab(o.y - c.y, d.y, half.y) || !slab(loz, ldz, half.z)) return -1;
  return _t0;
}
