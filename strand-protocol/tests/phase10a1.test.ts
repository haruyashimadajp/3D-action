import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { CITY_FX, PHYSICS, RENDER, createRng } from '../src/config/constants';
import { SCREEN_FILTERS, SECTORS, defaultSave, sanitizeSave, type ScreenFilterId } from '../src/config/skills';
import { computeEffectiveDpr } from '../src/engine/Renderer';
import type { PbrTextureSet, ProceduralTextureLibrary } from '../src/engine/ProceduralTextures';
import { CityBuilder, type BoxCollider, type ColliderKind, type RampCollider, type SectorLayout, blimpPose } from '../src/world/CityBuilder';
import { PhysicsWorld, createMoveResult, createRayHit } from '../src/world/PhysicsWorld';
import { BURST, EffectsPool } from '../src/entities/EffectsPool';

function mockPbr(): Required<PbrTextureSet> {
  return {
    map: new THREE.Texture(),
    roughnessMap: new THREE.Texture(),
    normalMap: new THREE.Texture(),
    emissiveMap: new THREE.Texture(),
  };
}

function mockTextures(): ProceduralTextureLibrary {
  return {
    facades: mockPbr(),
    roof: mockPbr(),
    roads: mockPbr(),
    machinery: mockPbr(),
    neonAtlas: new THREE.Texture(),
    neonAtlasStrips: 8,
    signAtlas: new THREE.Texture(),
    tech: mockPbr(),
    archDetail: mockPbr(),
    manhole: mockPbr(),
    plaqueAtlas: new THREE.Texture(),
    graffitiAtlas: new THREE.Texture(),
    glove: mockPbr(),
    gun: mockPbr(),
  };
}

function buildAllSectors(): SectorLayout[] {
  const city = new CityBuilder(mockTextures());
  const layouts: SectorLayout[] = [];
  for (let s = 1; s <= SECTORS.length; s++) {
    layouts.push(city.buildSector(s, 0));
  }
  return layouts;
}

// =============================================================================================
// Independent linear brute-force physics oracle (zero spatial grid, zero DDA)
// =============================================================================================
const WALL_KINDS: ReadonlySet<ColliderKind> = new Set(['BUILDING', 'HIGHWAY', 'BRIDGE', 'SKYBRIDGE']);

function oracleSolid(c: BoxCollider, gateOpen: boolean): boolean {
  if (c.active === false) return false;
  if (gateOpen && c.gate) return false;
  return true;
}

function oracleRayRamp(rp: RampCollider, origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, n: THREE.Vector3): number {
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
  let which = -1;
  let sign = 0;
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
  const f0 = origin.y - rp.yStart - k * (oA - rp.alongStart);
  const fd = dir.y - k * dA;
  if (Math.abs(fd) < 1e-12) {
    if (f0 < -rp.thickness || f0 > 0) return -1;
  } else {
    let ta = (-rp.thickness - f0) / fd;
    let tb = (0 - f0) / fd;
    if (ta > tb) {
      const s = ta;
      ta = tb;
      tb = s;
    }
    if (ta > t0) {
      t0 = ta;
      which = 2;
      sign = fd > 0 ? -1 : 1;
    }
    if (tb < t1) t1 = tb;
    if (t0 > t1) return -1;
  }
  if (which < 0) return -1;
  if (which === 0) n.set(alongZ ? 0 : sign, 0, alongZ ? sign : 0);
  else if (which === 1) n.set(alongZ ? sign : 0, 0, alongZ ? 0 : sign);
  else n.set(alongZ ? 0 : -k * sign, sign, alongZ ? -k * sign : 0).normalize();
  return t0;
}

function oracleRaycast(
  colliders: readonly BoxCollider[],
  ramps: readonly RampCollider[],
  gateOpen: boolean,
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  maxDist: number,
  ignore?: ReadonlySet<ColliderKind>,
) {
  let best = maxDist;
  let bestIdx = -1;
  let bestAxis = 0;
  let bestSign = 0;
  const ix = 1 / (Math.abs(dir.x) > 1e-12 ? dir.x : 1e-12);
  const iy = 1 / (Math.abs(dir.y) > 1e-12 ? dir.y : 1e-12);
  const iz = 1 / (Math.abs(dir.z) > 1e-12 ? dir.z : 1e-12);
  for (let i = 0; i < colliders.length; i++) {
    const c = colliders[i];
    if (!oracleSolid(c, gateOpen) || (ignore && ignore.has(c.kind))) continue;
    let t0 = 0;
    let t1 = best;
    let axis = -1;
    let sign = 0;
    let ta = (c.min.x - origin.x) * ix;
    let tb = (c.max.x - origin.x) * ix;
    if (ta > tb) {
      const s = ta;
      ta = tb;
      tb = s;
    }
    if (ta > t0) {
      t0 = ta;
      axis = 0;
      sign = dir.x > 0 ? -1 : 1;
    }
    if (tb < t1) t1 = tb;
    if (t0 > t1) continue;
    ta = (c.min.y - origin.y) * iy;
    tb = (c.max.y - origin.y) * iy;
    if (ta > tb) {
      const s = ta;
      ta = tb;
      tb = s;
    }
    if (ta > t0) {
      t0 = ta;
      axis = 1;
      sign = dir.y > 0 ? -1 : 1;
    }
    if (tb < t1) t1 = tb;
    if (t0 > t1) continue;
    ta = (c.min.z - origin.z) * iz;
    tb = (c.max.z - origin.z) * iz;
    if (ta > tb) {
      const s = ta;
      ta = tb;
      tb = s;
    }
    if (ta > t0) {
      t0 = ta;
      axis = 2;
      sign = dir.z > 0 ? -1 : 1;
    }
    if (tb < t1) t1 = tb;
    if (t0 > t1 || axis < 0) continue;
    if (t0 < best || (t0 === best && i < bestIdx)) {
      best = t0;
      bestIdx = i;
      bestAxis = axis;
      bestSign = sign;
    }
  }
  let hit = bestIdx >= 0;
  let collider: BoxCollider | null = bestIdx >= 0 ? colliders[bestIdx] : null;
  let kind: ColliderKind | null = collider ? collider.kind : null;
  const normal = new THREE.Vector3();
  if (hit) normal.set(bestAxis === 0 ? bestSign : 0, bestAxis === 1 ? bestSign : 0, bestAxis === 2 ? bestSign : 0);
  if (!(ignore && ignore.has('HIGHWAY'))) {
    const rn = new THREE.Vector3();
    for (const r of ramps) {
      const t = oracleRayRamp(r, origin, dir, hit ? best : maxDist, rn);
      if (t < 0) continue;
      hit = true;
      best = t;
      normal.copy(rn);
      collider = null;
      kind = 'HIGHWAY';
    }
  }
  return { hit, distance: best, kind, collider, normal };
}

function oracleLineOfSight(
  colliders: readonly BoxCollider[],
  ramps: readonly RampCollider[],
  gateOpen: boolean,
  from: THREE.Vector3,
  to: THREE.Vector3,
  endTolerance = 0.25,
): boolean {
  const d = new THREE.Vector3().subVectors(to, from);
  const len = d.length();
  if (len <= endTolerance) return true;
  d.divideScalar(len);
  const res = oracleRaycast(colliders, ramps, gateOpen, from, d, len);
  return !res.hit || res.distance >= len - endTolerance;
}

function oracleFindWallFaceColliders(
  colliders: readonly BoxCollider[],
  gateOpen: boolean,
  pos: THREE.Vector3,
  h: number,
  maxDist: number = PHYSICS.WALLRUN_DETECT_DISTANCE,
): number[] {
  const midY = pos.y + h * 0.5;
  const found: Array<{ collider: number; nx: number; nz: number; plane: number; distance: number }> = [];
  for (let ci = 0; ci < colliders.length; ci++) {
    const c = colliders[ci];
    if (!WALL_KINDS.has(c.kind) || !oracleSolid(c, gateOpen)) continue;
    if (midY < c.min.y - 0.05 || midY > c.max.y + 0.05) continue;
    for (let f = 0; f < 4; f++) {
      const onX = f < 2;
      const sgn = f % 2 === 0 ? 1 : -1;
      const nx = onX ? sgn : 0;
      const nz = onX ? 0 : sgn;
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
        for (let j = 0; j < colliders.length; j++) {
          if (j === ci) continue;
          const o = colliders[j];
          if (!WALL_KINDS.has(o.kind) || !oracleSolid(o, gateOpen)) continue;
          const op = onX ? (sgn > 0 ? o.max.x : o.min.x) : sgn > 0 ? o.max.z : o.min.z;
          if (Math.abs(op - plane) > 0.03) continue;
          if (lat < (onX ? o.min.z : o.min.x) || lat > (onX ? o.max.z : o.max.x)) continue;
          if (o.max.y < y0 - 0.05 || o.min.y > y1 + 0.05) continue;
          y0 = Math.min(y0, o.min.y);
          y1 = Math.max(y1, o.max.y);
        }
      }
      if (y1 - y0 < PHYSICS.WALLRUN_MIN_FACE_HEIGHT || midY < y0 + 0.3 || midY > y1 - 0.2) continue;
      if (found.some((w) => w.nx === nx && w.nz === nz && Math.abs(w.plane - plane) < 0.03)) continue;
      found.push({ collider: ci, nx, nz, plane, distance: dist });
    }
  }
  found.sort((a, b) => a.distance - b.distance);
  return found.slice(0, 8).map((f) => f.collider);
}

const ALL_SECTORS = buildAllSectors();

test('10A-1.6 PhysicsWorld 12m CSR spatial grid + DDA matches brute-force oracle across all 5 sectors', () => {
  const physics = new PhysicsWorld();
  const rng = createRng(100101);
  const hitOut = createRayHit();
  const origin = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const target = new THREE.Vector3();
  const right = new THREE.Vector3(1, 0, 0);
  const ignoreSets: Array<ReadonlySet<ColliderKind> | undefined> = [
    undefined,
    new Set<ColliderKind>(['GROUND']),
    new Set<ColliderKind>(['GROUND', 'PROP', 'CAR']),
    new Set<ColliderKind>(['HIGHWAY']),
  ];

  for (const layout of ALL_SECTORS) {
    physics.setLayout(layout);
    for (const gateOpen of [false, true]) {
      physics.setGateOpen(gateOpen);

      // 260 diverse rays per sector/gate state: cell-boundary grazing, vertical, outside-grid, general 3D, ignore kinds
      for (let r = 0; r < 260; r++) {
        if (r < 24) {
          // Exact 12 m cell-boundary grazing rays along X or Z
          const cell = (Math.floor(rng() * 14) - 7) * 12;
          if (r % 2 === 0) {
            origin.set(cell, 0.5 + rng() * 30, -90 + rng() * 180);
            dir.set(0, (rng() - 0.5) * 0.2, r % 4 === 0 ? 1 : -1).normalize();
          } else {
            origin.set(-90 + rng() * 180, 0.5 + rng() * 30, cell);
            dir.set(r % 4 === 1 ? 1 : -1, (rng() - 0.5) * 0.2, 0).normalize();
          }
        } else if (r < 44) {
          // Pure vertical rays (dx = dz = 0)
          origin.set((rng() - 0.5) * 140, r % 2 === 0 ? 95 : 0.2, (rng() - 0.5) * 140);
          dir.set(0, r % 2 === 0 ? -1 : 1, 0);
        } else if (r < 64) {
          // Starting outside the playable grid pointing inward
          const ang = rng() * Math.PI * 2;
          origin.set(Math.cos(ang) * 260, 2 + rng() * 40, Math.sin(ang) * 260);
          dir.set(-Math.cos(ang), (rng() - 0.5) * 0.15, -Math.sin(ang)).normalize();
        } else {
          // General 3D combat / sightline rays inside the city
          origin.set((rng() - 0.5) * 130, 0.4 + rng() * 55, (rng() - 0.5) * 130);
          dir.set(rng() * 2 - 1, (rng() - 0.5) * 0.9, rng() * 2 - 1);
          if (dir.lengthSq() < 1e-6) dir.set(1, 0, 0);
          dir.normalize();
        }
        const maxDist = 20 + rng() * 200;
        const ignore = ignoreSets[r % 13 === 0 ? 1 + (r % 3) : 0];

        const got = physics.raycast(origin, dir, maxDist, hitOut, ignore);
        const ref = oracleRaycast(layout.colliders, layout.ramps, gateOpen, origin, dir, maxDist, ignore);
        assert.equal(got.hit, ref.hit, `S${layout.sector.index} ray ${r} hit mismatch`);
        if (ref.hit) {
          assert.ok(Math.abs(got.distance - ref.distance) < 1e-6, `S${layout.sector.index} ray ${r} dist ${got.distance} vs ${ref.distance}`);
          assert.equal(got.collider, ref.collider, `S${layout.sector.index} ray ${r} collider mismatch`);
          assert.equal(got.kind, ref.kind, `S${layout.sector.index} ray ${r} kind ${got.kind} vs ${ref.kind}`);
          assert.ok(got.normal.distanceTo(ref.normal) < 1e-6, `S${layout.sector.index} ray ${r} normal mismatch`);
        }
      }

      // 120 lineOfSight pairs per sector/gate state
      for (let k = 0; k < 120; k++) {
        origin.set((rng() - 0.5) * 120, 1 + rng() * 40, (rng() - 0.5) * 120);
        target.set((rng() - 0.5) * 120, 1 + rng() * 40, (rng() - 0.5) * 120);
        const tol = k % 3 === 0 ? 0.05 : 0.25;
        const got = physics.lineOfSight(origin, target, tol);
        const ref = oracleLineOfSight(layout.colliders, layout.ramps, gateOpen, origin, target, tol);
        assert.equal(got, ref, `S${layout.sector.index} LOS ${k} mismatch`);
      }

      // 80 findWallFaces queries near building perimeters and cell boundaries
      for (let k = 0; k < 80; k++) {
        const b = layout.buildings[k % layout.buildings.length];
        const side = k % 4;
        const px = side === 0 ? b.cx - b.halfW - 0.45 : side === 1 ? b.cx + b.halfW + 0.45 : b.cx + (rng() - 0.5) * b.halfW * 2;
        const pz = side === 2 ? b.cz - b.halfD - 0.45 : side === 3 ? b.cz + b.halfD + 0.45 : b.cz + (rng() - 0.5) * b.halfD * 2;
        const py = 1 + rng() * Math.max(2, b.roofY - 3);
        origin.set(px, py, pz);
        const n = physics.findWallFaces(origin, 1.8, right);
        const gotIds: number[] = [];
        for (let i = 0; i < n; i++) gotIds.push(physics.wallFace(i).collider);
        const refIds = oracleFindWallFaceColliders(layout.colliders, gateOpen, origin, 1.8);
        assert.deepEqual(gotIds, refIds, `S${layout.sector.index} wallFaces ${k} mismatch`);
      }
    }
  }
});

test('10A-1.6 PhysicsWorld dynamic collider active flag toggles raycast, LOS, wallFaces, and movePlayer without rebuild', () => {
  const physics = new PhysicsWorld();
  const s1 = ALL_SECTORS[0];
  physics.setLayout(s1);
  // Find a tall BUILDING collider to toggle
  const idx = s1.colliders.findIndex((c) => c.kind === 'BUILDING' && c.max.y - c.min.y > 10 && c.max.z - c.min.z > 4);
  assert.ok(idx >= 0, 'building collider found');
  const box = s1.colliders[idx];
  const cy = (box.min.y + Math.min(box.max.y, box.min.y + 8)) * 0.5;
  const cz = (box.min.z + box.max.z) * 0.5;
  const from = new THREE.Vector3(box.min.x - 1.2, cy, cz);
  const to = new THREE.Vector3(box.min.x + 1.2, cy, cz);
  const dir = new THREE.Vector3(1, 0, 0);
  const right = new THREE.Vector3(0, 0, 1);
  const hit = createRayHit();

  // Initially active: ray hits this collider, LOS blocked, wall face detected, movePlayer stops at wall
  physics.raycast(from, dir, 4, hit);
  assert.equal(hit.hit, true);
  assert.equal(hit.collider, box);
  assert.equal(physics.lineOfSight(from, to, 0.05), false);
  const nearWall = new THREE.Vector3(box.min.x - 0.5, box.min.y + 2, cz);
  const countBefore = physics.findWallFaces(nearWall, 1.8, right);
  const hasBefore = Array.from({ length: countBefore }, (_, i) => physics.wallFace(i).collider).includes(idx);
  assert.equal(hasBefore, true, 'wallFace finds active collider');

  const move = createMoveResult();
  const pos = new THREE.Vector3(box.min.x - 0.8, box.min.y + 0.1, cz);
  const delta = new THREE.Vector3(2.0, 0, 0);
  physics.movePlayer(pos, 0.4, 1.8, delta, false, move);
  assert.ok(pos.x <= box.min.x - 0.4 + 1e-3, 'blocked while collider active');

  // Deactivate collider (without rebuilding grid)
  physics.setColliderActive(idx, false);
  physics.raycast(from, dir, 4, hit);
  assert.notEqual(hit.collider, box, 'deactivated collider ignored by raycast');
  const countOff = physics.findWallFaces(nearWall, 1.8, right);
  const hasOff = Array.from({ length: countOff }, (_, i) => physics.wallFace(i).collider).includes(idx);
  assert.equal(hasOff, false, 'deactivated collider ignored by findWallFaces');
  const pos2 = new THREE.Vector3(box.min.x - 0.8, box.min.y + 0.1, cz);
  physics.movePlayer(pos2, 0.4, 1.8, delta, false, move);
  assert.ok(pos2.x > box.min.x + 0.5, 'passes through deactivated collider');

  // Reactivate collider: solid again
  physics.setColliderActive(idx, true);
  physics.raycast(from, dir, 4, hit);
  assert.equal(hit.hit, true);
  assert.equal(hit.collider, box, 'reactivated collider hits again');
});

test('10A-2.6 zero floating neon signs across all 5 sectors (strict FaceSpan + cardinal FarTower binding)', () => {
  const EPS = 1e-3;
  for (const layout of ALL_SECTORS) {
    assert.ok(layout.neonSignRecords.length > 0, `S${layout.sector.index} emits neonSignRecords`);
    let buildingSigns = 0;
    let farSigns = 0;
    for (const rec of layout.neonSignRecords) {
      if (rec.kind === 'BUILDING_FLAT') {
        buildingSigns++;
        const spans = layout.buildingSpans[rec.building];
        assert.ok(spans && spans.length > 0, `S${layout.sector.index} building ${rec.building} has FaceSpans`);
        const ax = Math.abs(rec.nx) > 0.5 ? 'x' : 'z';
        const sg = ax === 'x' ? Math.sign(rec.nx) : Math.sign(rec.nz);
        const along = ax === 'x' ? rec.z : rec.x;
        const perp = ax === 'x' ? rec.x : rec.z;

        const matching = spans.find((sp) => {
          if (sp.ax !== ax || sp.sg !== sg) return false;
          if (rec.y - rec.h * 0.5 < sp.y0 + 0.4 - EPS || rec.y + rec.h * 0.5 > sp.y1 - 0.4 + EPS) return false;
          if (along - rec.w * 0.5 < sp.a0 + 0.3 - EPS || along + rec.w * 0.5 > sp.a1 - 0.3 + EPS) return false;
          // Flush on facade (or flush on ARCH_A exterior curtain-wall mullions AR.MULLION_D + 0.12)
          const distFromWall = (perp - sp.plane) * sg;
          return distFromWall >= -0.05 && distFromWall <= 0.6;
        });
        assert.ok(
          matching,
          `S${layout.sector.index} BUILDING_FLAT on building ${rec.building} at (${rec.x.toFixed(2)},${rec.y.toFixed(2)},${rec.z.toFixed(2)}) n=(${rec.nx},${rec.nz}) size=(${rec.w.toFixed(2)}x${rec.h.toFixed(2)}) not inside any solid FaceSpan`,
        );
      } else if (rec.kind === 'BUILDING_BLADE' || rec.kind === 'ALLEY_BLADE') {
        buildingSigns++;
        const spans = layout.buildingSpans[rec.building];
        assert.ok(spans && spans.length > 0, `S${layout.sector.index} building ${rec.building} has FaceSpans`);
        // Blade signs protrude perpendicularly from their host wall, so the host wall axis is perpendicular to sign face normal.
        const wallAx = Math.abs(rec.nx) > 0.5 ? 'z' : 'x';
        const along = wallAx === 'x' ? rec.z : rec.x;
        const perp = wallAx === 'x' ? rec.x : rec.z;

        const matching = spans.find((sp) => {
          if (sp.ax !== wallAx) return false;
          if (rec.y - rec.h * 0.5 < sp.y0 + 0.4 - EPS || rec.y + rec.h * 0.5 > sp.y1 - 0.4 + EPS) return false;
          if (along < sp.a0 + 0.3 - EPS || along > sp.a1 - 0.3 + EPS) return false;
          // Inner edge of blade faces sp.plane on the outward (sp.sg) side, bridged by mounting brackets
          const innerGap = (perp - sp.plane) * sp.sg - rec.w * 0.5;
          return innerGap >= -0.05 && innerGap <= 0.5;
        });
        assert.ok(
          matching,
          `S${layout.sector.index} ${rec.kind} on building ${rec.building} at (${rec.x.toFixed(2)},${rec.y.toFixed(2)},${rec.z.toFixed(2)}) faceN=(${rec.nx},${rec.nz}) size=(${rec.w.toFixed(2)}x${rec.h.toFixed(2)}) not anchored to any solid FaceSpan`,
        );
      } else if (rec.kind === 'ALLEY_BAR') {
        buildingSigns++;
        assert.ok(rec.buildingB !== undefined, 'ALLEY_BAR records both anchoring buildings');
        const wallAx = Math.abs(rec.nx) > 0.5 ? 'z' : 'x';
        const along = wallAx === 'x' ? rec.z : rec.x;
        for (const bIdx of [rec.building, rec.buildingB!]) {
          const spans = layout.buildingSpans[bIdx];
          const ok = spans.some(
            (sp) =>
              sp.ax === wallAx &&
              along >= sp.a0 + 0.3 - EPS &&
              along <= sp.a1 - 0.3 + EPS &&
              rec.y - rec.h * 0.5 >= sp.y0 + 0.4 - EPS &&
              rec.y + rec.h * 0.5 <= sp.y1 - 0.4 + EPS,
          );
          assert.ok(ok, `S${layout.sector.index} ALLEY_BAR anchor building ${bIdx} missing solid FaceSpan`);
        }
      } else if (rec.kind === 'FAR_TOWER') {
        farSigns++;
        assert.ok(rec.farIndex !== undefined, 'FAR_TOWER record has farIndex');
        const t = layout.farTowersInfo[rec.farIndex!];
        assert.ok(t, 'far tower exists');
        const cardinal =
          (Math.abs(rec.nx) === 1 && rec.nz === 0) ||
          (rec.nx === 0 && Math.abs(rec.nz) === 1);
        assert.ok(cardinal, `S${layout.sector.index} FAR_TOWER sign normal must be cardinal, got (${rec.nx}, ${rec.nz})`);
        if (Math.abs(rec.nx) === 1) {
          const expectedX = t.x + rec.nx * (t.w * 0.5);
          const off = (rec.x - expectedX) * rec.nx;
          assert.ok(off >= -0.05 && off <= 0.6, `FAR_TOWER X face offset ${off}`);
          assert.ok(Math.abs(rec.z - t.z) + rec.w * 0.5 <= t.d * 0.5 + 0.05, 'FAR_TOWER Z span fits face');
        } else {
          const expectedZ = t.z + rec.nz * (t.d * 0.5);
          const off = (rec.z - expectedZ) * rec.nz;
          assert.ok(off >= -0.05 && off <= 0.6, `FAR_TOWER Z face offset ${off}`);
          assert.ok(Math.abs(rec.x - t.x) + rec.w * 0.5 <= t.w * 0.5 + 0.05, 'FAR_TOWER X span fits face');
        }
        assert.ok(rec.y + rec.h * 0.5 <= t.top - 4.0 + EPS, `FAR_TOWER sign top ${rec.y + rec.h * 0.5} exceeds t.top - 4 (${t.top - 4})`);
      }
    }
    assert.ok(buildingSigns > 0 && farSigns > 0, `S${layout.sector.index} has both building (${buildingSigns}) and farTower (${farSigns}) signs`);
  }
});

test('10A-2.7 blimps keep >= 18 m 360-degree clearance from every tower across all 5 sectors', () => {
  assert.equal(CITY_FX.BLIMPS[0].y, 168);
  assert.equal(CITY_FX.BLIMPS[0].radius, 265);
  assert.equal(CITY_FX.BLIMPS[1].y, 194);
  assert.equal(CITY_FX.BLIMPS[1].radius, 335);

  const blimpBobM = 2.5;
  const blimpHalfHoriz = CITY_FX.BLIMP_LENGTH * 0.5;
  // Lower tail fin / gondola reaches ~1.45 * BLIMP_RADIUS below centerline; worst-case altitude uses def.y - blimpBobM.
  const blimpHalfVert = CITY_FX.BLIMP_RADIUS * 1.45;
  const pose = { x: 0, y: 0, z: 0, yaw: 0 };

  const boxClearance = (bx: number, by: number, bz: number, minX: number, maxX: number, minY: number, maxY: number, minZ: number, maxZ: number) => {
    const cx = Math.max(minX, Math.min(bx, maxX));
    const cy = Math.max(minY, Math.min(by, maxY));
    const cz = Math.max(minZ, Math.min(bz, maxZ));
    const dx = Math.max(0, Math.hypot(bx - cx, bz - cz) - blimpHalfHoriz);
    const dy = Math.max(0, Math.abs(by - cy) - blimpHalfVert);
    return Math.hypot(dx, dy);
  };

  for (const layout of ALL_SECTORS) {
    for (const def of CITY_FX.BLIMPS) {
      for (let deg = 0; deg < 360; deg += 2) {
        const ang = (deg * Math.PI) / 180;
        const t = ((ang - def.phase) * def.radius) / def.speed;
        blimpPose(def, t, pose);
        const minBlimpY = def.y - blimpBobM;
        for (const ft of layout.farTowersInfo) {
          const clr = boxClearance(
            pose.x,
            minBlimpY,
            pose.z,
            ft.x - ft.w * 0.5,
            ft.x + ft.w * 0.5,
            0,
            ft.top,
            ft.z - ft.d * 0.5,
            ft.z + ft.d * 0.5,
          );
          assert.ok(
            clr >= 18,
            `S${layout.sector.index} blimp r=${def.radius} y=${def.y} at ${deg}° cleared farTower (${ft.x.toFixed(0)},${ft.z.toFixed(0)},top=${ft.top.toFixed(1)}) by only ${clr.toFixed(2)} m`,
          );
        }
        for (const b of layout.buildings) {
          const clr = boxClearance(
            pose.x,
            minBlimpY,
            pose.z,
            b.cx - b.halfW,
            b.cx + b.halfW,
            0,
            b.roofY,
            b.cz - b.halfD,
            b.cz + b.halfD,
          );
          assert.ok(clr >= 18, `S${layout.sector.index} blimp cleared playable building ${b.index} by only ${clr.toFixed(2)} m`);
        }
      }
    }
  }
});

test('10A-1 & 10A-4 settings persistence (5 filters, shadows, showPerf) and <= 2.2M pixel DPR cap', () => {
  const def = defaultSave();
  assert.equal(def.settings.filter, 'CYBER_NOIR');
  assert.equal(def.settings.shadows, false);
  assert.equal(def.settings.showPerf, false);
  assert.equal(SCREEN_FILTERS.length, 5);

  for (const f of SCREEN_FILTERS) {
    const saved = sanitizeSave({
      settings: { filter: f.id, shadows: true, showPerf: true },
    });
    assert.equal(saved.settings.filter, f.id);
    assert.equal(saved.settings.shadows, true);
    assert.equal(saved.settings.showPerf, true);
  }

  const bad = sanitizeSave({
    settings: { filter: 'UNKNOWN_GRADE' as ScreenFilterId, shadows: 'yes', showPerf: 1 },
  });
  assert.equal(bad.settings.filter, 'CYBER_NOIR');
  assert.equal(bad.settings.shadows, false);
  assert.equal(bad.settings.showPerf, false);

  for (const [w, h, devDpr] of [
    [1280, 720, 2],
    [1920, 1080, 2],
    [2560, 1440, 2],
    [3840, 2160, 2],
    [3440, 1440, 1.5],
  ] as const) {
    const dprHigh = computeEffectiveDpr(w, h, devDpr, 'HIGH', false);
    assert.ok(dprHigh <= RENDER.DPR_CAP + 1e-9, `HIGH dpr ${dprHigh} <= ${RENDER.DPR_CAP}`);
    assert.ok(w * h * dprHigh * dprHigh <= RENDER.MAX_RENDER_PIXELS + 1, `${w}x${h} pixels <= 2.2M`);
    assert.equal(computeEffectiveDpr(w, h, devDpr, 'HIGH', true), 1);
    assert.equal(computeEffectiveDpr(w, h, devDpr, 'MEDIUM', false), 1);
    assert.equal(computeEffectiveDpr(w, h, devDpr, 'LOW', false), 1);
  }
});

test('10A-1.7 & 10A-1.8 consolidated steel fixtures, contact shadows, and 52 m minor particle skip', () => {
  const city = new CityBuilder(mockTextures());
  const layout = city.buildSector(1, 0);
  const meshNames: string[] = [];
  city.root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) meshNames.push(o.name);
  });
  assert.ok(meshNames.includes('SteelFixturesInstanced'), 'consolidated SteelFixturesInstanced present');
  assert.ok(meshNames.includes('ClutterDebrisKit'), 'consolidated ClutterDebrisKit present');
  assert.ok(meshNames.includes('PropContactShadows'), 'PropContactShadows present');
  assert.ok(!meshNames.includes('ClutterCardboard'), 'ClutterCardboard merged out');
  assert.ok(!meshNames.includes('ClutterTrashBins'), 'ClutterTrashBins merged out');
  assert.ok(layout.stats.props.contactShadows > 0, 'contact shadows populated');

  const scene = new THREE.Scene();
  const fx = new EffectsPool(scene);
  const camPos = new THREE.Vector3(0, 2, 0);
  const camVel = new THREE.Vector3();
  fx.update(0.016, 0.016, camPos, camVel);

  const farPt = new THREE.Vector3(60, 2, 0);
  const up = new THREE.Vector3(0, 1, 0);
  fx.burst(farPt, up, BURST.SPARK);
  fx.update(0.016, 0.016, camPos, camVel);
  const sparksMesh = scene.children.find((c) => c.name === 'Particles') as THREE.InstancedMesh | undefined;
  assert.ok(sparksMesh, 'Particles mesh exists');
  assert.equal(sparksMesh!.count, 0, 'minor SPARK beyond 52 m is skipped');

  fx.burst(farPt, up, BURST.EXPLOSION);
  fx.update(0.016, 0.016, camPos, camVel);
  assert.ok(sparksMesh!.count > 0, 'major EXPLOSION beyond 52 m still emits');
});
