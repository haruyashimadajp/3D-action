/**
 * Phase 11B: destructible street + interior props (8 m CSR prop grid, zero-alloc instance / contact-shadow hiding,
 * swept-projectile destruction at arrival, slide / kick breaks, impact-point stealth distraction), material-matched
 * DestructDebris with the digital scanline dissolve, and the RoofMechKit (-1 draw call) consolidation.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { createRng } from '../src/config/constants';
import { SECTORS } from '../src/config/skills';
import { type PbrTextureSet, type ProceduralTextureLibrary } from '../src/engine/ProceduralTextures';
import { DestructibleManager, PROP_CAP, PROP_DESTRUCTION, PROP_GRID_CELL_M } from '../src/entities/DestructibleManager';
import { DEBRIS, EffectsPool, type ProjectileImpact, type ProjectileSpec } from '../src/entities/EffectsPool';
import { CityBuilder, type BoxCollider, type ColliderKind, type RampCollider, type SectorLayout } from '../src/world/CityBuilder';
import { DESTRUCTIBLE_PROP_IDS, type DestructiblePropRecord } from '../src/world/CityPropMeshes';
import type { PropId } from '../src/world/CityProps';
import { PhysicsWorld, createMoveResult, createRayHit } from '../src/world/PhysicsWorld';

function mockPbr(): Required<PbrTextureSet> {
  return { map: new THREE.Texture(), roughnessMap: new THREE.Texture(), normalMap: new THREE.Texture(), emissiveMap: new THREE.Texture() };
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
    megaBillboard: new THREE.Texture(),
    vendingAtlas: new THREE.Texture(),
    furnishingsAtlas: new THREE.Texture(),
    glove: mockPbr(),
    gun: mockPbr(),
  };
}

const CITY = new CityBuilder(mockTextures());
const PISTOL: ProjectileSpec = { owner: 'PLAYER', speed: 160, range: 120, damage: 34, headMultiplier: 2, shieldMultiplier: 1, color: 0xffffff, intensity: 1, width: 0.02, tag: 0 };
const SNIPER: ProjectileSpec = { ...PISTOL, damage: 140, tag: 1 };
const GROUND_ONLY: ReadonlySet<ColliderKind> = new Set<ColliderKind>(['GROUND']);

// =============================================================================================
// Brute-force physics oracle (linear scan over every active collider + ramps; no grid, no DDA)
// =============================================================================================
function slab(c: BoxCollider, o: THREE.Vector3, d: THREE.Vector3, maxT: number): number {
  let t0 = 0;
  let t1 = maxT;
  let axis = -1;
  for (let a = 0; a < 3; a++) {
    const oa = a === 0 ? o.x : a === 1 ? o.y : o.z;
    const da = a === 0 ? d.x : a === 1 ? d.y : d.z;
    const lo = a === 0 ? c.min.x : a === 1 ? c.min.y : c.min.z;
    const hi = a === 0 ? c.max.x : a === 1 ? c.max.y : c.max.z;
    const inv = 1 / (Math.abs(da) > 1e-12 ? da : 1e-12);
    let ta = (lo - oa) * inv;
    let tb = (hi - oa) * inv;
    if (ta > tb) [ta, tb] = [tb, ta];
    if (ta > t0) {
      t0 = ta;
      axis = a;
    }
    if (tb < t1) t1 = tb;
    if (t0 > t1) return -1;
  }
  return axis < 0 ? -1 : t0;
}

function rampT(rp: RampCollider, origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): number {
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
  const clip = (o: number, d: number, lo: number, hi: number, w: number): boolean => {
    if (Math.abs(d) < 1e-12) return o >= lo && o <= hi;
    let ta = (lo - o) / d;
    let tb = (hi - o) / d;
    if (ta > tb) [ta, tb] = [tb, ta];
    if (ta > t0) {
      t0 = ta;
      which = w;
    }
    if (tb < t1) t1 = tb;
    return t0 <= t1;
  };
  if (!clip(oA, dA, Math.min(rp.alongStart, rp.alongEnd), Math.max(rp.alongStart, rp.alongEnd), 0)) return -1;
  if (!clip(oL, dL, rp.lateralMin, rp.lateralMax, 1)) return -1;
  const f0 = origin.y - rp.yStart - k * (oA - rp.alongStart);
  const fd = dir.y - k * dA;
  if (!clip(f0, fd, -rp.thickness, 0, 2)) return -1;
  return which < 0 ? -1 : t0;
}

function oracleRay(L: SectorLayout, o: THREE.Vector3, d: THREE.Vector3, maxDist: number, ignore?: ReadonlySet<ColliderKind>): { hit: boolean; distance: number; collider: BoxCollider | null } {
  let best = maxDist;
  let bestIdx = -1;
  for (let i = 0; i < L.colliders.length; i++) {
    const c = L.colliders[i];
    if (c.active === false || (ignore && ignore.has(c.kind))) continue;
    const t = slab(c, o, d, best);
    if (t >= 0 && (t < best || (t === best && i < bestIdx))) {
      best = t;
      bestIdx = i;
    }
  }
  let hit = bestIdx >= 0;
  let collider = hit ? L.colliders[bestIdx] : null;
  if (!(ignore && ignore.has('HIGHWAY'))) {
    for (const r of L.ramps) {
      const t = rampT(r, o, d, hit ? best : maxDist);
      if (t < 0) continue;
      hit = true;
      best = t;
      collider = null;
    }
  }
  return { hit, distance: best, collider };
}

const LOS_IGNORE: ReadonlySet<ColliderKind> = new Set<ColliderKind>(['WATER', 'BARRIER', 'GLASS']);
function oracleLos(L: SectorLayout, a: THREE.Vector3, b: THREE.Vector3, tol: number): boolean {
  const d = new THREE.Vector3().subVectors(b, a);
  const len = d.length();
  if (len <= tol) return true;
  d.divideScalar(len);
  const r = oracleRay(L, a, d, len, LOS_IGNORE);
  return !r.hit || r.distance >= len - tol;
}

/** Fresh grid over the still-active colliders only (what a full rebuild after the toggles would give). */
function rebuiltWithoutInactive(L: SectorLayout): PhysicsWorld {
  const p = new PhysicsWorld();
  p.setLayout({ ...L, colliders: L.colliders.filter((c) => c.active !== false) });
  return p;
}

test('11B-3 spatial-grid equivalence: raycast / lineOfSight / movePlayer match brute force in S1–S5, before and after O(1) door + glass toggles', () => {
  const rng = createRng(0x11b3);
  const hit = createRayHit();
  const o = new THREE.Vector3();
  const d = new THREE.Vector3();
  const t = new THREE.Vector3();
  for (let s = 1; s <= SECTORS.length; s++) {
    const L = CITY.buildSector(s, 0);
    const physics = new PhysicsWorld();
    physics.setLayout(L);
    const dyn = [...L.breachDoors.map((x) => x.colliderIndex), ...L.glassPanes.map((x) => x.colliderIndex)].filter((i) => i >= 0);
    assert.ok(dyn.length >= 6, `S${s}: ${dyn.length} dynamic colliders`);
    for (const phase of ['intact', 'toggled'] as const) {
      if (phase === 'toggled') for (const i of dyn) physics.setColliderActive(i, false);
      // Rays: half aimed straight through doors / panes (both phases), half general combat sightlines.
      for (let r = 0; r < 220; r++) {
        if (r < 110) {
          const c = L.colliders[dyn[r % dyn.length]];
          t.set((c.min.x + c.max.x) / 2, c.min.y + 0.4 + rng() * Math.max(0.2, c.max.y - c.min.y - 0.8), (c.min.z + c.max.z) / 2);
          const thinX = c.max.x - c.min.x < c.max.z - c.min.z;
          o.copy(t).add(new THREE.Vector3(thinX ? (rng() < 0.5 ? -3 : 3) : (rng() - 0.5) * 2, (rng() - 0.5) * 0.6, thinX ? (rng() - 0.5) * 2 : rng() < 0.5 ? -3 : 3));
          d.subVectors(t, o).normalize();
        } else {
          o.set((rng() - 0.5) * 130, 0.4 + rng() * 40, (rng() - 0.5) * 130);
          d.set(rng() * 2 - 1, (rng() - 0.5) * 0.8, rng() * 2 - 1).normalize();
        }
        const maxD = 8 + rng() * 120;
        const ignore = r % 7 === 0 ? GROUND_ONLY : undefined;
        const got = physics.raycast(o, d, maxD, hit, ignore);
        const ref = oracleRay(L, o, d, maxD, ignore);
        assert.equal(got.hit, ref.hit, `S${s} ${phase} ray ${r} hit`);
        if (ref.hit) {
          assert.ok(Math.abs(got.distance - ref.distance) < 1e-6, `S${s} ${phase} ray ${r}: ${got.distance} vs ${ref.distance}`);
          if (ref.collider) assert.equal(got.collider, ref.collider, `S${s} ${phase} ray ${r} collider`);
        }
        t.copy(o).addScaledVector(d, maxD);
        assert.equal(physics.lineOfSight(o, t, 0.25), oracleLos(L, o, t, 0.25), `S${s} ${phase} LOS ${r}`);
      }
      // movePlayer through every doorway / pane: the toggled grid behaves exactly like a grid rebuilt without them.
      if (phase === 'toggled') {
        const ref = rebuiltWithoutInactive(L);
        const m1 = createMoveResult();
        const m2 = createMoveResult();
        for (const i of dyn) {
          const c = L.colliders[i];
          const thinX = c.max.x - c.min.x < c.max.z - c.min.z;
          const p1 = new THREE.Vector3((c.min.x + c.max.x) / 2, c.min.y + 0.02, (c.min.z + c.max.z) / 2);
          if (thinX) p1.x -= 0.8;
          else p1.z -= 0.8;
          const p2 = p1.clone();
          const delta = thinX ? new THREE.Vector3(1.6, 0, 0) : new THREE.Vector3(0, 0, 1.6);
          physics.movePlayer(p1, 0.35, 1.8, delta.clone(), true, m1);
          ref.movePlayer(p2, 0.35, 1.8, delta.clone(), true, m2);
          assert.ok(p1.distanceTo(p2) < 1e-9 && m1.hitWall === m2.hitWall && m1.grounded === m2.grounded, `S${s} move through collider ${i}`);
        }
      }
    }
  }
});

// =============================================================================================
// Prop destruction
// =============================================================================================
interface Rig {
  L: SectorLayout;
  physics: PhysicsWorld;
  effects: EffectsPool;
  dm: DestructibleManager;
  breaks: Array<{ index: number; pos: THREE.Vector3; noise: number; byPlayer: boolean }>;
}
function rig(sector: number): Rig {
  const L = CITY.buildSector(sector, 0);
  const scene = new THREE.Scene();
  const effects = new EffectsPool(scene);
  const dm = new DestructibleManager(scene, effects, () => undefined);
  const physics = new PhysicsWorld();
  physics.setLayout(L);
  dm.setLevel(physics, L.colliders, L.breachDoors, L.glassPanes);
  dm.setProps(L.destructibleProps, L.interiorProps, (k) => CITY.propMeshes.kitMesh(k), CITY.propMeshes.shadowMesh, CITY.interiorKit.mesh);
  effects.setBreakables(dm);
  const breaks: Rig['breaks'] = [];
  dm.onPropBreak = (index, pos, _mat, noise, byPlayer) => breaks.push({ index, pos: pos.clone(), noise, byPlayer });
  return { L, physics, effects, dm, breaks };
}
const _m = new THREE.Matrix4();
const detOf = (mesh: THREE.InstancedMesh, i: number): number => {
  mesh.getMatrixAt(i, _m);
  return _m.determinant();
};
/** True when another intact prop (not the one centred at `centre`) overlaps the firing lane centre → centre + dir·dist. */
function otherPropOnLane(R: Rig, centre: THREE.Vector3, dir: THREE.Vector3, dist: number): boolean {
  const c = new THREE.Vector3();
  const h = new THREE.Vector3();
  for (let i = 0; i < R.dm.propCount; i++) {
    if (R.dm.propBroken(i)) continue;
    R.dm.propAabb(i, c, h);
    if (c.distanceTo(centre) < 1e-4) continue;
    const box = new THREE.Box3(c.clone().sub(h).subScalar(0.05), c.clone().add(h).addScalar(0.05));
    const ray = new THREE.Ray(centre, dir);
    const at = ray.intersectBox(box, new THREE.Vector3());
    if (at && at.distanceTo(centre) <= dist + 0.05) return true;
    if (box.containsPoint(centre)) return true;
  }
  return false;
}

/** Fires `spec` from `dist` m away along a clear horizontal approach at the prop centre; returns the origin used. */
function shoot(R: Rig, centre: THREE.Vector3, spec: ProjectileSpec, dist: number, impacts: ProjectileImpact[] = []): THREE.Vector3 | null {
  const hit = createRayHit();
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    const dir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    R.physics.raycast(centre, dir, dist + 0.3, hit, GROUND_ONLY);
    if (hit.hit || otherPropOnLane(R, centre, dir, dist)) continue;
    const origin = centre.clone().addScaledVector(dir, dist);
    R.effects.spawnProjectile(origin, dir.clone().negate(), spec);
    for (let s = 0; s < 20; s++) R.effects.updateProjectiles(1 / 120, R.physics, () => [], (im) => impacts.push({ ...im, point: im.point.clone() } as ProjectileImpact));
    return origin;
  }
  return null;
}

test('11B-1 swept rounds shatter props at arrival: instance + contact shadow zeroed, debris dissolves, distraction at the PROP', () => {
  const R = rig(4);
  const { L, dm, effects, breaks } = R;
  assert.ok(L.destructibleProps.length > 150, `${L.destructibleProps.length} street records`);
  assert.ok(dm.propCount > 200 && dm.propCount <= PROP_CAP, `${dm.propCount} registered props`);
  assert.equal(PROP_GRID_CELL_M, 8);
  // Shadow contract: shadowed DEBRIS / PALLETS / DRUMS vs never-shadowed POT_PLANT / AFRAME.
  for (const r of L.destructibleProps) if (r.propId === 'POT_PLANT' || r.propId === 'AFRAME') assert.equal(r.shadowIndex, -1, `${r.propId} has no contact shadow`);
  const shadowMesh = CITY.propMeshes.shadowMesh;
  const cases: Array<{ id: PropId | 'v4'; spec: ProjectileSpec; rec?: DestructiblePropRecord }> = [];
  for (const id of ['BOXES', 'PALLETS', 'DRUMS'] as const) {
    const rec = L.destructibleProps.find((r) => r.propId === id && r.shadowIndex >= 0 && r.floorY < 0.15);
    assert.ok(rec, `a shadowed ${id}`);
    cases.push({ id, spec: id === 'DRUMS' ? SNIPER : PISTOL, rec });
  }
  for (const id of ['POT_PLANT', 'AFRAME'] as const) {
    const rec = L.destructibleProps.find((r) => r.propId === id);
    if (rec) cases.push({ id, spec: PISTOL, rec });
  }
  assert.ok(cases.length >= 4);
  const debris0 = effects.debris.spawned;
  for (const c of cases) {
    const rec = c.rec as DestructiblePropRecord;
    const i = dm.propIndexOf('STREET', L.destructibleProps.indexOf(rec));
    assert.ok(i >= 0);
    const kit = CITY.propMeshes.kitMesh(rec.kitId);
    assert.notEqual(detOf(kit, rec.instanceIndex), 0);
    if (rec.shadowIndex >= 0) assert.notEqual(detOf(shadowMesh, rec.shadowIndex), 0);
    const n0 = breaks.length;
    const origin = shoot(R, rec.worldPos, c.spec, 4);
    assert.ok(origin, `${c.id}: clear firing lane`);
    assert.ok(dm.propBroken(i), `${c.id} broken by one ${c.spec === SNIPER ? 'sniper' : 'pistol'} round`);
    assert.equal(detOf(kit, rec.instanceIndex), 0, `${c.id} instance matrix zeroed`);
    if (rec.shadowIndex >= 0) assert.equal(detOf(shadowMesh, rec.shadowIndex), 0, `${c.id} contact shadow zeroed`);
    const b = breaks.slice(n0).find((x) => x.index === i);
    assert.ok(b, `${c.id} break hook`);
    assert.ok(b.byPlayer && b.pos.distanceTo(rec.worldPos) < 1e-3, `${c.id}: distraction at the prop's own coordinates`);
    assert.ok(b.pos.distanceTo(origin as THREE.Vector3) > 3, 'never at the shooter');
    assert.equal(b.noise, PROP_DESTRUCTION[rec.propId]?.noise);
  }
  // Interior desk rig (v4): no shadow, the InteriorPropsKit instance collapses.
  const v4 = L.interiorProps.find((p) => p.variant === 4 && p.destructible) ?? null;
  if (v4) {
    const i = dm.propIndexOf('INTERIOR', L.interiorProps.indexOf(v4));
    const origin = shoot(R, v4.worldPos, PISTOL, 1.6);
    assert.ok(origin, 'clear lane inside the room');
    assert.ok(dm.propBroken(i), 'v4 desk rig broken');
    assert.equal(detOf(CITY.interiorKit.mesh, v4.instIndex), 0, 'v4 instance zeroed');
  }
  // Debris: material-matched chunks spawned, then every one tumbles and completes its 0 → 1 digital dissolve.
  const spawned = effects.debris.spawned - debris0;
  assert.ok(spawned >= 10 * cases.length, `${spawned} debris chunks`);
  const v0 = effects.debris.vanished;
  const cam = new THREE.Vector3(cases[0].rec?.worldPos.x ?? 0, 1.7, cases[0].rec?.worldPos.z ?? 0);
  for (let k = 0; k < 60 * 3.2; k++) effects.update(1 / 60, 1 / 60, cam, new THREE.Vector3(), k / 60);
  assert.ok(effects.debris.vanished - v0 >= spawned, `${effects.debris.vanished - v0} / ${spawned} chunks dissolved`);
  assert.equal(effects.debris.count, 0);
  assert.ok(DEBRIS.CAP <= 200 && DEBRIS.DISSOLVE_S === 0.55);
  // main.ts wiring: the stealth lure uses the hook's prop position (never the player's), plus the material SE.
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(main, /onPropBreak = \(_prop, pos, mat, noise, byPlayer\) => \{\s*audio\.propBreak\(pos, mat\);\s*if \(byPlayer\) this\.enemies\.onPlayerGunshot\(pos, noise\);/);
});

test('11B-1 heavy props (2 pistol / 1 sniper), light pass-through, slide / kick breaks with zero slowdown, cover stays solid', () => {
  const R = rig(3);
  const { L, dm } = R;
  // Heavy bag mound / bin bags: the first pistol round stops on it (PROP impact, no scorch), the second breaks it.
  const bag = L.destructibleProps.find((r) => (r.propId === 'BIN_BAGS' || r.propId === 'BAG_MOUND') && r.floorY < 0.15);
  assert.ok(bag, 'a bag pile');
  const bi = dm.propIndexOf('STREET', L.destructibleProps.indexOf(bag));
  const imp: ProjectileImpact[] = [];
  const scorch0 = R.effects.scorch.count;
  assert.ok(shoot(R, bag.worldPos, PISTOL, 4, imp));
  assert.equal(dm.propBroken(bi), false, 'one pistol round does not break a 2-HP prop');
  assert.ok(imp.some((im) => im.kind === 'PROP'), 'the round stopped on the heavy prop');
  assert.equal(R.effects.scorch.count, scorch0, 'no scorch decal on a breakable');
  shoot(R, bag.worldPos, PISTOL, 4);
  assert.ok(dm.propBroken(bi), 'second pistol round breaks it');
  // Light props never stop a round: raycastProp returns -1 and breaks everything on the segment.
  const box = L.destructibleProps.find((r) => r.propId.startsWith('BOX') && !dm.propBroken(dm.propIndexOf('STREET', L.destructibleProps.indexOf(r))));
  assert.ok(box);
  const start = box.worldPos.clone().add(new THREE.Vector3(0, 0, -2));
  assert.equal(dm.raycastProp(start, new THREE.Vector3(0, 0, 1), 4, 34, false), -1);
  assert.ok(dm.propBroken(dm.propIndexOf('STREET', L.destructibleProps.indexOf(box))));
  // Slide at 7 m/s through a light prop: broken, velocity untouched. A 6 m/s slide / 9 m/s run break nothing.
  const pick = (pred: (r: DestructiblePropRecord) => boolean): DestructiblePropRecord | undefined =>
    L.destructibleProps.find((r) => pred(r) && !dm.propBroken(dm.propIndexOf('STREET', L.destructibleProps.indexOf(r))) && r.floorY < 0.15);
  const lite = pick((r) => r.propId !== 'DRUMS' && PROP_DESTRUCTION[r.propId]?.slide === true);
  assert.ok(lite);
  const li = dm.propIndexOf('STREET', L.destructibleProps.indexOf(lite));
  const feet = new THREE.Vector3(lite.worldPos.x, lite.floorY, lite.worldPos.z);
  assert.equal(dm.checkPlayerSlideBreak(feet, new THREE.Vector3(6, 0, 0), true), 0, '6 m/s slide');
  assert.equal(dm.checkPlayerSlideBreak(feet, new THREE.Vector3(9, 0, 0), false), 0, '9 m/s run');
  const vel = new THREE.Vector3(7, -0.5, 0);
  assert.ok(dm.checkPlayerSlideBreak(feet, vel, true) >= 1 && dm.propBroken(li), '7 m/s slide shatters it');
  assert.deepEqual(vel.toArray(), [7, -0.5, 0], 'zero player slowdown');
  // Drums ignore slides but a boot kick (or a 10.5 m/s sprint for light props) breaks them.
  const drum = pick((r) => r.propId === 'DRUMS');
  if (drum) {
    const di = dm.propIndexOf('STREET', L.destructibleProps.indexOf(drum));
    const f = new THREE.Vector3(drum.worldPos.x, drum.floorY, drum.worldPos.z);
    dm.checkPlayerSlideBreak(f, new THREE.Vector3(11, 0, 0), true);
    assert.equal(dm.propBroken(di), false, 'drums are not slide-breakable');
    const kp = f.clone().add(new THREE.Vector3(-1.2, 0, 0));
    assert.ok(dm.kickBreak(kp, new THREE.Vector3(1, 0, 0)) >= 1 && dm.propBroken(di), 'one kick breaks a drum');
  }
  // Indestructible cover: never registered, and a sniper round at a dumpster / bench leaves its instance intact.
  for (const id of ['DUMPSTER', 'DUMPSTER_OPEN', 'BENCH', 'JERSEY', 'PLAQUE', 'KEYPAD'] as const) {
    assert.equal(DESTRUCTIBLE_PROP_IDS.has(id), false, `${id} not destructible`);
    assert.equal(PROP_DESTRUCTION[id], undefined);
  }
  assert.ok(L.destructibleProps.every((r) => DESTRUCTIBLE_PROP_IDS.has(r.propId)));
  for (const kitId of ['DUMPSTER', 'BENCH'] as const) {
    const kit = CITY.propMeshes.kitMesh(kitId);
    assert.ok(kit.count > 0, `${kitId} instances`);
    const p = new THREE.Vector3().setFromMatrixPosition((kit.getMatrixAt(0, _m), _m)).add(new THREE.Vector3(0, 0.5, 0));
    const n0 = R.breaks.length;
    shoot(R, p, SNIPER, 3);
    assert.notEqual(detOf(kit, 0), 0, `${kitId} survives a sniper round`);
    assert.equal(R.breaks.length, n0);
  }
  // Restart: everything comes back (instances, shadows, HP).
  dm.resetProps();
  assert.ok(!dm.propBroken(bi) && dm.propHp(bi) === 2 && detOf(CITY.propMeshes.kitMesh(bag.kitId), bag.instanceIndex) !== 0);
});

test('11B-1 8 m prop grid query equals brute force; prop hot paths allocate nothing', () => {
  const R = rig(2);
  const { dm } = R;
  const rng = createRng(0x8b);
  const out = new Int32Array(PROP_CAP);
  const c = new THREE.Vector3();
  const h = new THREE.Vector3();
  for (let q = 0; q < 300; q++) {
    const x0 = (rng() - 0.5) * 220;
    const z0 = (rng() - 0.5) * 220;
    const x1 = x0 + rng() * 30;
    const z1 = z0 + rng() * 30;
    const n = dm.queryPropsXZ(x0, z0, x1, z1, out);
    const got = Array.from(out.subarray(0, n)).sort((a, b) => a - b);
    const ref: number[] = [];
    for (let i = 0; i < dm.propCount; i++) {
      dm.propAabb(i, c, h);
      if (c.x + h.x >= x0 && c.x - h.x <= x1 && c.z + h.z >= z0 && c.z - h.z <= z1) ref.push(i);
    }
    assert.deepEqual(got, ref, `query ${q}`);
  }
  // Zero per-frame allocation discipline in the prop hot paths (no `new`, no clones, no literals).
  const src = readFileSync(new URL('../src/entities/DestructibleManager.ts', import.meta.url), 'utf8');
  for (const fn of ['breakProp(', 'raycastProp(', 'checkPlayerSlideBreak(', 'kickBreak(', 'private spawnPropDebris(']) {
    const at = src.indexOf(`  ${fn}`);
    assert.ok(at > 0, fn);
    const body = src.slice(at, src.indexOf('\n  }\n', at));
    assert.doesNotMatch(body, /\bnew \w|\.clone\(\)|= \[\]|= \{\}/, `${fn} allocates`);
  }
  // setQuality precedence cleanup.
  assert.match(src, /lite !== \('STRAND_LITE' in defs\)/);
});

test('11B-3 RoofMechKit: AC units + ducts in ONE instanced draw (-1 call); 10 prop kits kept; debris cap ≤ 200', () => {
  CITY.buildSector(4, 0);
  const names: string[] = [];
  let mech: THREE.InstancedMesh | null = null;
  CITY.root.traverse((o) => {
    names.push(o.name);
    if (o.name === 'RoofMechKit') mech = o as THREE.InstancedMesh;
  });
  assert.ok(!names.includes('ACUnits') && !names.includes('Ducts'), 'the two old meshes are gone');
  assert.equal(names.filter((n) => n === 'RoofMechKit').length, 1);
  const m = mech as unknown as THREE.InstancedMesh;
  const part = m.geometry.getAttribute('aPart');
  const parts = new Set<number>();
  for (let i = 0; i < part.count; i++) parts.add(part.getX(i));
  assert.deepEqual([...parts].sort(), [0, 1], 'per-vertex aPart: AC unit 0, duct 1');
  const v = m.geometry.getAttribute('aInstVar');
  let ac = 0;
  let duct = 0;
  let longDuct = false;
  for (let i = 0; i < m.count; i++) {
    if (v.getX(i) > 0.5) {
      duct++;
      m.getMatrixAt(i, _m);
      const sx = new THREE.Vector3().setFromMatrixColumn(_m, 0).length();
      if (sx >= 4) longDuct = true;
    } else ac++;
  }
  assert.ok(ac > 20 && duct >= 2, `${ac} AC units, ${duct} ducts`);
  assert.ok(longDuct, 'ducts keep their X-axis length scaling (4–7 m)');
  const mat = m.material as THREE.MeshStandardMaterial;
  assert.ok(mat.map && mat.roughnessMap && mat.normalMap, 'AC units keep the machinery PBR maps');
  // props.test.ts contract untouched: exactly 10 prop meshes.
  assert.equal(CITY.propMeshes.meshes.length, 10);
  assert.ok(DEBRIS.CAP <= 200);
});

test('11B audit regressions: map-edge debris never sinks, far debris never hangs in mid-air, kicks never reach through walls', () => {
  type DebrisInternals = { live: Uint8Array; pos: Float32Array; floorY: Float32Array; sleep: Uint8Array; scl: Float32Array };
  let edgeProps = 0;
  let edgeChunks = 0;
  let blocked = 0;
  for (let s = 1; s <= SECTORS.length; s++) {
    const R = rig(s);
    const { L, dm, effects } = R;
    const D = effects.debris as unknown as DebrisInternals;
    // 1) Props within 3 m of the map-edge BARRIER, broken toward it: every chunk keeps a real floor (≥ prop floor − 1 m).
    const barriers = L.colliders.filter((c) => c.kind === 'BARRIER');
    for (let ri = 0; ri < L.destructibleProps.length; ri++) {
      const r = L.destructibleProps[ri];
      let best: BoxCollider | null = null;
      let bd = 3;
      for (const b of barriers) {
        const dx = Math.max(b.min.x - r.worldPos.x, 0, r.worldPos.x - b.max.x);
        const dz = Math.max(b.min.z - r.worldPos.z, 0, r.worldPos.z - b.max.z);
        const d = Math.hypot(dx, dz);
        if (d < bd) {
          bd = d;
          best = b;
        }
      }
      if (!best) continue;
      const i = dm.propIndexOf('STREET', ri);
      if (i < 0 || dm.propBroken(i)) continue;
      const tx = Math.max(best.min.x, Math.min(best.max.x, r.worldPos.x));
      const tz = Math.max(best.min.z, Math.min(best.max.z, r.worldPos.z));
      const dir = new THREE.Vector3(tx - r.worldPos.x, -0.05, tz - r.worldPos.z).normalize();
      effects.debris.clear();
      dm.breakProp(i, r.worldPos, dir, true);
      edgeProps++;
      for (let k = 0; k < DEBRIS.CAP; k++) {
        if (!D.live[k]) continue;
        edgeChunks++;
        assert.ok(D.floorY[k] >= r.floorY - 1, `S${s} ${r.propId} edge chunk floor ${D.floorY[k].toFixed(2)} (prop floor ${r.floorY.toFixed(2)})`);
      }
      const cam = new THREE.Vector3(r.worldPos.x, 1.7, r.worldPos.z);
      for (let k = 0; k < 70; k++) effects.update(1 / 60, 1 / 60, cam, new THREE.Vector3(), k / 60);
      for (let k = 0; k < DEBRIS.CAP; k++) if (D.live[k]) assert.ok(D.pos[k * 3 + 1] > r.floorY - 0.6, `S${s} ${r.propId} chunk sank to y ${D.pos[k * 3 + 1].toFixed(2)}`);
    }
    // 2) A prop broken 60 m from the camera: every chunk rests flat on its floor at once (no mid-air freeze).
    const far = L.destructibleProps.find((r) => r.floorY < 0.15 && !dm.propBroken(dm.propIndexOf('STREET', L.destructibleProps.indexOf(r))));
    if (far) {
      effects.debris.clear();
      dm.breakProp(dm.propIndexOf('STREET', L.destructibleProps.indexOf(far)), far.worldPos, new THREE.Vector3(1, 0, 0), true);
      const cam = far.worldPos.clone().add(new THREE.Vector3(0, 8, 60));
      for (let k = 0; k < 3; k++) effects.update(1 / 60, 1 / 60, cam, new THREE.Vector3(), k / 60);
      let n = 0;
      for (let k = 0; k < DEBRIS.CAP; k++) {
        if (!D.live[k]) continue;
        n++;
        assert.equal(D.sleep[k], 1, `S${s}: far chunk asleep`);
        assert.ok(Math.abs(D.pos[k * 3 + 1] - (D.floorY[k] + D.scl[k * 3 + 1] * 0.5)) < 1e-4, `S${s}: far chunk lies on its floor`);
      }
      assert.ok(n >= 5, `S${s}: ${n} far chunks`);
    }
    // 3) Kicks: a boot behind a wall / pane / door never reaches an interior prop (line of sight knee → prop centre).
    const hit = createRayHit();
    const ignore = new Set<ColliderKind>(['WATER', 'PROP', 'GROUND']);
    for (const ip of L.interiorProps) {
      if (!ip.destructible) continue;
      const i = dm.propIndexOf('INTERIOR', L.interiorProps.indexOf(ip));
      if (i < 0 || dm.propBroken(i)) continue;
      for (let a = 0; a < 8; a++) {
        const ang = (a / 8) * Math.PI * 2;
        const feet = new THREE.Vector3(ip.worldPos.x + Math.cos(ang) * 1.3, ip.floorY, ip.worldPos.z + Math.sin(ang) * 1.3);
        const knee = feet.clone().setY(feet.y + 0.6);
        const to = ip.worldPos.clone().sub(knee);
        const len = to.length();
        R.physics.raycast(knee, to.normalize(), len, hit, ignore);
        if (!hit.hit || (hit.kind !== 'BUILDING' && hit.kind !== 'GLASS' && hit.kind !== 'DOOR')) continue;
        const fwd = new THREE.Vector3(ip.worldPos.x - feet.x, 0, ip.worldPos.z - feet.z).normalize();
        dm.kickBreak(feet, fwd, 1.6);
        assert.equal(dm.propBroken(i), false, `S${s} v${ip.variant} kicked through a ${hit.kind}`);
        blocked++;
      }
    }
  }
  assert.ok(edgeProps >= 10 && edgeChunks >= 80, `${edgeProps} edge props, ${edgeChunks} chunks checked`);
  assert.ok(blocked >= 20, `${blocked} blocked kick positions checked`);
});
