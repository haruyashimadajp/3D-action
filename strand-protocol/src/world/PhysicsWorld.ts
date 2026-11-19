/**
 * STRAND // PROTOCOL — Collision & queries (§3.3, §3.4, §3.6-3, §5.2, §9.1).
 *
 *  - Uniform XZ grid broadphase over the district's static AABBs (rebuilt per sector, never per frame).
 *  - Swept AABB player movement resolved axis by axis: the move is clamped to the first contact along
 *    each axis, so even 40 m/s motion cannot tunnel through 0.1 m fences. Step-up 0.45 m. Depenetration.
 *  - Sloped on-ramps as analytic ground surfaces (with a solid slab underneath).
 *  - Wall-run detection against cyan wall-run surfaces only (distance ≤ 0.95 m).
 *  - Ray / segment casts against world colliders (grapple, bullets, line of sight).
 *  - 6° grapple anchor snap (movement assist only — guns never get aim assist).
 *  - Head-sphere / body-OBB hitbox ray tests for humanoids (targets supplied by the enemy system).
 * All hot paths reuse module-scope scratch objects: zero allocation per frame.
 */
import * as THREE from 'three';
import { LEVEL, PHYSICS } from '../config/constants';
import type { BoxCollider, ColliderKind, GrappleAnchor, RampCollider, SectorLayout, WallRunSurface } from './CityBuilder';

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

export interface WallRunContact {
  surface: WallRunSurface | null;
  /** −1 = wall on the player's left, +1 = right. */
  side: number;
  distance: number;
}

export type HitRegion = 'HEAD' | 'BODY';

/** Humanoid / drone hitbox: head sphere (HS ×2.5) + yaw-rotated body box. */
export interface HitboxTarget {
  readonly id: number;
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

type Axis3 = 'x' | 'y' | 'z';
const AXES_XZ = ['x', 'z'] as const;
const CORNERS: ReadonlyArray<readonly [number, number]> = [[-1, -1], [1, -1], [-1, 1], [1, 1]];

export class PhysicsWorld {
  private layout: SectorLayout | null = null;
  private colliders: readonly BoxCollider[] = [];
  private ramps: readonly RampCollider[] = [];
  private surfaces: readonly WallRunSurface[] = [];
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
    this.surfaces = layout.wallRunSurfaces;
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
    pos.y += dy;
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

  /** The ramp slab (0.5 m thick) blocks walking into it from underneath / the side. */
  private blockedByRampSlab(pos: THREE.Vector3, r: number, h: number, axis: 'x' | 'z', d: number): boolean {
    if (d === 0) return false;
    const nx = axis === 'x' ? pos.x + d : pos.x;
    const nz = axis === 'z' ? pos.z + d : pos.z;
    for (const rp of this.ramps) {
      for (const [cx, cz] of CORNERS) {
        const y = this.rampHeightAt(rp, nx + cx * r, nz + cz * r);
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
   * Finds the nearest cyan wall-run surface within 0.95 m of the player centre, overlapping the body.
   * `right` is the player's horizontal right vector (to classify left / right walls).
   */
  findWallRun(pos: THREE.Vector3, h: number, right: THREE.Vector3, out: WallRunContact): WallRunContact {
    out.surface = null;
    out.side = 0;
    out.distance = Infinity;
    const midY = pos.y + h * 0.5;
    for (const s of this.surfaces) {
      const n = s.normal;
      const onX = Math.abs(n.x) > 0.5;
      const plane = onX ? s.min.x : s.min.z;
      const dist = onX ? (pos.x - plane) * n.x : (pos.z - plane) * n.z;
      if (dist < -0.05 || dist > PHYSICS.WALLRUN_DETECT_DISTANCE) continue;
      const lat = onX ? pos.z : pos.x;
      const l0 = onX ? s.min.z : s.min.x;
      const l1 = onX ? s.max.z : s.max.x;
      if (lat < l0 + 0.2 || lat > l1 - 0.2) continue;
      if (midY < s.min.y - 0.4 || midY > s.max.y + 0.3) continue;
      if (dist < out.distance) {
        out.surface = s;
        out.distance = dist;
        // Wall normal pointing toward the player's right ⇒ the wall is on the left.
        out.side = n.x * right.x + n.z * right.z > 0 ? -1 : 1;
      }
    }
    return out;
  }

  /** Is the given surface still beside the player (for continuing a wall-run)? */
  stillOnSurface(pos: THREE.Vector3, h: number, s: WallRunSurface): boolean {
    const n = s.normal;
    const onX = Math.abs(n.x) > 0.5;
    const plane = onX ? s.min.x : s.min.z;
    const dist = onX ? (pos.x - plane) * n.x : (pos.z - plane) * n.z;
    if (dist < -0.05 || dist > PHYSICS.WALLRUN_DETECT_DISTANCE + 0.25) return false;
    const lat = onX ? pos.z : pos.x;
    if (lat < (onX ? s.min.z : s.min.x) || lat > (onX ? s.max.z : s.max.x)) return false;
    const midY = pos.y + h * 0.5;
    return midY > s.min.y - 0.6 && midY < s.max.y + 0.4;
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
    return out;
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
  raycastTargets(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, targets: readonly HitboxTarget[], out: TargetHit): TargetHit {
    out.hit = false;
    out.target = null;
    out.distance = maxDist;
    for (const t of targets) {
      if (!t.alive) continue;
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
