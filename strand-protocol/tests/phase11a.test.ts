/**
 * Phase 11A: enterable hollow interiors (dual body / collider split), deep architectural relief + floor-grid
 * sky-notches, InteriorPropsKit, kickable breach doors, destructible glass and the shared DestructDebris pool.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { SECTORS } from '../src/config/skills';
import { type PbrTextureSet, type ProceduralTextureLibrary } from '../src/engine/ProceduralTextures';
import { KEY_DISCRETE, PREVENT } from '../src/engine/InputManager';
import { DestructibleManager } from '../src/entities/DestructibleManager';
import { EffectsPool, type ProjectileImpact, type ProjectileSpec } from '../src/entities/EffectsPool';
import { isOnFloorGrid } from '../src/world/BuildingGrammar';
import { CityBuilder, type BoxCollider, type SectorLayout } from '../src/world/CityBuilder';
import { INTERIOR_PROP_TRI_BUDGET, buildInteriorPropsKit, interiorPropTris } from '../src/world/InteriorBuilder';
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
interface Built {
  L: SectorLayout;
  loop: number;
  towers: THREE.Mesh | null;
}
const BUILT: Built[] = [];
for (let loop = 0; loop <= 2; loop++) {
  for (let s = 1; s <= SECTORS.length; s++) {
    const L = CITY.buildSector(s, loop);
    let towers: THREE.Mesh | null = null;
    if (loop === 0) {
      CITY.root.traverse((o) => {
        if (o.name === 'Towers' && (o as THREE.Mesh).isMesh) towers = (o as THREE.Mesh).clone();
      });
    }
    BUILT.push({ L, loop, towers });
  }
}
const tagOf = (b: Built): string => `loop ${b.loop} S${b.L.sector.index}`;
const outward = (yaw: number): THREE.Vector3 => new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
const normalOf = (ax: 'x' | 'z', sg: number): THREE.Vector3 => (ax === 'x' ? new THREE.Vector3(sg, 0, 0) : new THREE.Vector3(0, 0, sg));
const P3 = (ax: 'x' | 'z', sg: number, plane: number, a: number, y: number, d: number): THREE.Vector3 =>
  ax === 'x' ? new THREE.Vector3(plane + sg * d, y, a) : new THREE.Vector3(a, y, plane + sg * d);

const PISTOL: ProjectileSpec = { owner: 'PLAYER', speed: 160, range: 120, damage: 34, headMultiplier: 2, shieldMultiplier: 1, color: 0xffffff, intensity: 1, width: 0.02, tag: 0 };
const SNIPER: ProjectileSpec = { ...PISTOL, damage: 140, tag: 1 };

test('11A-1 interiors: ≥ 6 (S1–S4) / ≥ 4 (S5) hollow rooms; no BUILDING collider in a room or an opening; no tower body across an opening', () => {
  const ray = new THREE.Raycaster();
  for (const B of BUILT) {
    const { L } = B;
    const tag = tagOf(B);
    assert.ok(L.interiors.length >= (L.sector.index === 5 ? 4 : 6) && L.interiors.length <= 10, `${tag}: ${L.interiors.length} interiors`);
    for (const iv of L.interiors) {
      const a = iv.aabb;
      const e = 0.05;
      const hit = L.colliders.find((c) => c.kind === 'BUILDING' && c.active !== false && c.min.x < a.maxX - e && c.max.x > a.minX + e && c.min.y < a.maxY - e && c.max.y > a.minY + e && c.min.z < a.maxZ - e && c.max.z > a.minZ + e);
      assert.equal(hit, undefined, `${tag}: interior ${iv.id} (${iv.template}) hollow is blocked by a BUILDING collider`);
    }
    for (const op of L.interiorOpenings) {
      const p0 = P3(op.ax, op.sg, op.plane, op.a0 + 0.03, op.y0 + 0.03, -0.32);
      const p1 = P3(op.ax, op.sg, op.plane, op.a1 - 0.03, op.y1 - 0.03, 0.3);
      const lo = p0.clone().min(p1);
      const hi = p0.clone().max(p1);
      const hit = L.colliders.find((c) => (c.kind === 'BUILDING' || c.kind === 'STEEL') && c.min.x < hi.x && c.max.x > lo.x && c.min.y < hi.y && c.max.y > lo.y && c.min.z < hi.z && c.max.z > lo.z);
      assert.equal(hit, undefined, `${tag}: ${op.kind} of interior ${op.interior} blocked by a ${hit?.kind} collider`);
      if (B.towers) {
        // The merged tower-body mesh (G.bodies) never crosses the opening through the wall thickness.
        const n = normalOf(op.ax, op.sg);
        for (const [u, v] of [[0.25, 0.3], [0.5, 0.5], [0.75, 0.7]]) {
          const o = P3(op.ax, op.sg, op.plane, op.a0 + (op.a1 - op.a0) * u, op.y0 + (op.y1 - op.y0) * v, 0.45);
          ray.set(o, n.clone().negate());
          ray.far = 0.9;
          const hits = ray.intersectObject(B.towers, false);
          assert.equal(hits.length, 0, `${tag}: tower body triangle across ${op.kind} of interior ${op.interior}`);
        }
      }
    }
  }
});

test('11A-2 doorways: the ray from 1.5 m outside hits only the DOOR leaf, passes clean once opened; phase10b2 door band clear', () => {
  const physics = new PhysicsWorld();
  const hit = createRayHit();
  let doors = 0;
  for (const B of BUILT) {
    const { L } = B;
    const tag = tagOf(B);
    assert.ok(L.breachDoors.length >= 6, `${tag}: ${L.breachDoors.length} breach doors`);
    assert.ok(L.groundDoors.length >= 60, `${tag}: ${L.groundDoors.length} ground doors`);
    physics.setLayout(L);
    for (const d of L.breachDoors) {
      const n = outward(d.yaw);
      // 1F doors: 1.5 m out on the street; 2F–3F gallery apartment doors: 1.0 m out, inside the 1.5 m corridor (its
      // outer columns stand on the railing line).
      const o = new THREE.Vector3(d.x, d.y + 1.0, d.z).addScaledVector(n, d.y > 0.5 ? 1.0 : 1.5);
      const dir = n.clone().negate();
      physics.raycast(o, dir, 3, hit);
      assert.ok(hit.hit && hit.kind === 'DOOR' && hit.collider === L.colliders[d.colliderIndex], `${tag}: door ray hit ${hit.kind}`);
      physics.setColliderActive(d.colliderIndex, false);
      physics.raycast(o, dir, 2.3, hit);
      assert.ok(!hit.hit || hit.distance > 2.0, `${tag}: opened doorway still blocked by ${hit.kind} at ${hit.distance.toFixed(2)} m`);
      physics.setColliderActive(d.colliderIndex, true);
      doors++;
    }
    // Zero DOOR colliders intrude into the [0.05, 1.5] m outward clearance band of any 1F ground door.
    for (const g of L.groundDoors) {
      const q0 = P3(g.ax, g.sg, g.plane, g.a - g.w / 2, 0, 0.05);
      const q1 = P3(g.ax, g.sg, g.plane, g.a + g.w / 2, g.h, 1.5);
      const lo = q0.clone().min(q1);
      const hi = q0.clone().max(q1);
      const bad = L.colliders.find((c) => c.kind === 'DOOR' && c.min.x < hi.x && c.max.x > lo.x && c.min.z < hi.z && c.max.z > lo.z && c.min.y < hi.y && c.max.y > lo.y);
      assert.equal(bad, undefined, `${tag}: DOOR collider in a ground door clearance band`);
    }
    for (const c of L.colliders) {
      if (c.kind !== 'DOOR') continue;
      const thin = Math.min(c.max.x - c.min.x, c.max.z - c.min.z);
      assert.ok(thin <= 0.12 + 1e-6, `${tag}: DOOR collider is a thin leaf (${thin.toFixed(3)} m)`);
    }
  }
  assert.ok(doors > 100, `${doors} doors checked`);
});

test('11A-2 breach / quiet open / ballistic breach: O(1) collider toggle, hooks, no scorch; [F]/[E] INTERACT, F11 FULLSCREEN', () => {
  const L = BUILT[0].L;
  const scene = new THREE.Scene();
  const effects = new EffectsPool(scene);
  const dm = new DestructibleManager(scene, effects, () => undefined);
  const physics = new PhysicsWorld();
  physics.setLayout(L);
  dm.setLevel(physics, L.colliders, L.breachDoors, L.glassPanes);
  let breaches = 0;
  let creaks = 0;
  dm.onDoorBreach = () => breaches++;
  dm.onDoorQuietOpen = () => creaks++;
  // Breach kick.
  dm.breachDoor(0, outward(L.breachDoors[0].yaw).negate());
  assert.equal(breaches, 1);
  assert.equal(L.colliders[L.breachDoors[0].colliderIndex].active, false, 'breached door collider disabled');
  assert.equal(dm.doorState(0), 'BREACHED');
  // Silent crouched open: 0 m noise (no breach hook), swings open over 0.38 s (105°, clamped to ~91° by the
  // 0.20 m jamb reveal behind the leaf so it never cuts into the wall).
  dm.openDoorQuietly(1);
  assert.equal(creaks, 1);
  assert.equal(breaches, 1, 'quiet open makes no breach noise');
  assert.equal(L.colliders[L.breachDoors[1].colliderIndex].active, false);
  for (let t = 0; t < 0.45; t += 1 / 60) dm.update(1 / 60, new THREE.Vector3(L.breachDoors[1].x, 1.6, L.breachDoors[1].z));
  assert.equal(dm.doorState(1), 'OPEN');
  // Ballistic breach: 2 pistol rounds (or 1 sniper round) blast a closed door; DOOR / GLASS never get a scorch decal.
  effects.setBreakables(dm);
  const fire = (i: number, spec: ProjectileSpec): void => {
    const d = L.breachDoors[i];
    const n = outward(d.yaw);
    const o = new THREE.Vector3(d.x, d.y + 1.2, d.z).addScaledVector(n, 4);
    effects.spawnProjectile(o, n.clone().negate(), spec);
    for (let k = 0; k < 30; k++) effects.updateProjectiles(1 / 60, physics, () => [], () => undefined);
  };
  const scorch0 = effects.scorch.count;
  fire(2, PISTOL);
  assert.equal(dm.doorState(2), 'CLOSED', 'one pistol round does not breach');
  fire(2, PISTOL);
  assert.equal(dm.doorState(2), 'BREACHED', 'second pistol round breaches');
  fire(3, SNIPER);
  assert.equal(dm.doorState(3), 'BREACHED', 'one sniper round breaches');
  assert.equal(effects.scorch.count, scorch0, 'no scorch decal on doors');
  assert.equal(breaches, 3);
  // main.ts payoff numbers: 40 dmg, 1.5 s stun, 8.5 m/s knockback within 2.4 m, 22 m alert; glass 26 m.
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.ok(main.includes('breachBlast(pos, inward, 2.4, 40, 1.5, 8.5)') && main.includes('onPlayerGunshot(pos, 22)') && main.includes('onPlayerGunshot(pos, 26)'));
  assert.ok(main.includes("'[F] OPEN QUIETLY'") && main.includes("'[F] BREACH KICK'"));
  // Keybinds.
  assert.equal(KEY_DISCRETE.KeyF, 'INTERACT');
  assert.equal(KEY_DISCRETE.KeyE, 'INTERACT');
  assert.equal(KEY_DISCRETE.F11, 'FULLSCREEN');
  assert.ok(PREVENT.has('KeyE') && PREVENT.has('F11'));
  const input = readFileSync(new URL('../src/engine/InputManager.ts', import.meta.url), 'utf8');
  assert.match(input, /if \(e\.code === 'F11'\) e\.preventDefault\(\);/);
});

test('11A-3 glass: rounds pass through with 100 % damage (no scorch), dives keep 100 % speed, 22–30 shards', () => {
  const L = BUILT.find((b) => b.L.glassPanes.length >= 3)?.L;
  assert.ok(L, 'a district with glass');
  for (const B of BUILT) assert.ok(B.L.glassPanes.length >= 4, `${tagOf(B)}: ${B.L.glassPanes.length} glass panes`);
  const scene = new THREE.Scene();
  const effects = new EffectsPool(scene);
  const dm = new DestructibleManager(scene, effects, () => undefined);
  const physics = new PhysicsWorld();
  physics.setLayout(L);
  dm.setLevel(physics, L.colliders, L.breachDoors, L.glassPanes);
  effects.setBreakables(dm);
  let shatters = 0;
  dm.onGlassShatter = () => shatters++;
  // Ballistic pass-through.
  const g = L.glassPanes[0];
  const n = outward(g.yaw);
  const o = new THREE.Vector3(g.x, g.y + g.height / 2, g.z).addScaledVector(n, 3);
  const impacts: ProjectileImpact[] = [];
  const scorch0 = effects.scorch.count;
  const debris0 = effects.debris.spawned;
  effects.spawnProjectile(o, n.clone().negate(), PISTOL);
  for (let k = 0; k < 40; k++) effects.updateProjectiles(1 / 60, physics, () => [], (im) => impacts.push({ ...im, point: im.point.clone() } as ProjectileImpact));
  assert.equal(shatters, 1, 'pane shattered');
  assert.ok(dm.glassBroken(0));
  assert.equal(L.colliders[g.colliderIndex].active, false, 'glass collider disabled');
  const shards = effects.debris.spawned - debris0;
  assert.ok(shards >= 22 && shards <= 30, `${shards} glass shards`);
  assert.ok(impacts.every((im) => im.kind !== 'GLASS'), 'the round never stopped on the glass');
  if (impacts.length) {
    assert.equal(impacts[0].damage, PISTOL.damage, '100 % damage after the glass');
    assert.ok(impacts[0].point.distanceTo(new THREE.Vector3(g.x, impacts[0].point.y, g.z)) > 0.15, 'stopped behind the pane');
  }
  assert.ok(effects.scorch.count <= scorch0 + 1, 'no scorch on the glass (only on the wall behind)');
  // Zero-speed-loss dive: the crash probe clears the pane before the sweep, the move keeps its full length.
  const g2 = L.glassPanes[1];
  const n2 = outward(g2.yaw);
  const pos = new THREE.Vector3(g2.x, Math.max(g2.y, 0) + 0.02, g2.z).addScaledVector(n2, 0.55);
  const delta = n2.clone().multiplyScalar(-0.7);
  assert.ok(dm.crashThrough(pos, delta, 0.35, 1.8, false) >= 1, 'dive shatters the pane');
  assert.ok(dm.glassBroken(1));
  const move = createMoveResult();
  const p0 = pos.clone();
  physics.movePlayer(pos, 0.35, 1.8, delta.clone(), true, move);
  const moved = Math.hypot(pos.x - p0.x, pos.z - p0.z);
  assert.ok(moved >= 0.7 - 0.02, `full move through the broken pane (${moved.toFixed(3)} m of 0.70)`);
});

test('11A-1c / 11A-1b: InteriorPropsKit ≤ 360 tris, grounded; sky-notches on the floor grid; ≥ 2 run faces kept', () => {
  for (let v = 0; v < 8; v++) {
    const tris = interiorPropTris(v);
    assert.ok(tris > 0 && tris <= INTERIOR_PROP_TRI_BUDGET, `v${v}: ${tris} tris`);
    const g = buildInteriorPropsKit([v]);
    g.computeBoundingBox();
    assert.ok(Math.abs((g.boundingBox as THREE.Box3).min.y) <= 0.02, `v${v}: min.y ${(g.boundingBox as THREE.Box3).min.y.toFixed(3)}`);
  }
  let notches = 0;
  for (const B of BUILT) {
    const { L } = B;
    for (const sn of L.skyNotches) {
      notches++;
      const b = L.buildings[sn.building];
      assert.ok(isOnFloorGrid(b.arch, sn.yNotch), `${tagOf(B)}: notch y ${sn.yNotch} on the arch ${b.arch} floor grid`);
      assert.ok(L.anchors.some((a) => a.kind === 'LEDGE' && Math.abs(a.position.y - sn.yNotch) < 4.5), `${tagOf(B)}: LEDGE anchors at the notch`);
    }
    assert.ok(L.interiorProps.length >= L.interiors.length, `${tagOf(B)}: furnished`);
    assert.ok(L.interiorProps.every((p) => p.destructible === [0, 2, 3, 4, 5, 7].includes(p.variant)));
  }
  assert.ok(notches >= 5, `${notches} sky-notches`);
  // Cantilevered bay-window / HVAC pods on ≥ 30 % of the S1–S4 towers (every S1–S4 district carries some).
  let towers = 0;
  let eligible = 0;
  for (const B of BUILT) {
    if (B.L.sector.index > 4) continue;
    assert.ok(B.L.reliefPods.pods >= 1, `${tagOf(B)}: pods placed`);
    towers += B.L.reliefPods.towers;
    eligible += B.L.reliefPods.eligible;
  }
  assert.ok(towers / eligible >= 0.3, `pod towers ${towers} / ${eligible}`);
  // Carved / notched towers keep their wall-run faces: every building still has ≥ 2 full-height lot spans.
  for (const B of BUILT) {
    B.L.buildings.forEach((b, i) => {
      const spans = B.L.buildingSpans[i] ?? [];
      const faces = new Set(spans.filter((sp) => sp.y1 - sp.y0 >= 3).map((sp) => `${sp.ax}:${sp.sg}`));
      assert.ok(faces.size >= 2, `${tagOf(B)}: building ${i} keeps ≥ 2 wall faces`);
    });
  }
  void ({} as BoxCollider);
});

test('11A audit regressions: glass shards rest on real support; kicked-in slabs land on the floor clear of walls', () => {
  type Internals = { pos: Float32Array; live: Uint8Array; sleep: Uint8Array };
  for (const B of BUILT.filter((b) => b.loop === 0)) {
    const L = B.L;
    const scene = new THREE.Scene();
    const effects = new EffectsPool(scene);
    const dm = new DestructibleManager(scene, effects, () => undefined);
    const physics = new PhysicsWorld();
    const deb = effects.debris as unknown as Internals;
    // Shards: shatter every pane both ways; every sleeping shard has a surface ≤ 0.12 m below it (0.2 m radius).
    L.glassPanes.forEach((g, i) => {
      for (const sgn of [1, -1]) {
        physics.setLayout(L);
        dm.setLevel(physics, L.colliders, L.breachDoors, L.glassPanes);
        effects.debris.clear();
        const n = outward(g.yaw).multiplyScalar(sgn);
        dm.shatterGlass(i, new THREE.Vector3(g.x, g.y + g.height / 2, g.z), n);
        const cam = new THREE.Vector3(g.x, g.y + 1.6, g.z);
        for (let t = 0; t < 1.3; t += 1 / 60) effects.debris.update(1 / 60, cam);
        for (let k = 0; k < deb.live.length; k++) {
          if (!deb.live[k] || !deb.sleep[k]) continue;
          const p = new THREE.Vector3(deb.pos[k * 3], deb.pos[k * 3 + 1], deb.pos[k * 3 + 2]);
          const gy = physics.probeGround(p.clone().setY(p.y + 0.1), 0.2, 40);
          assert.ok(gy === null || p.y - gy <= 0.12, `${tagOf(B)}: pane ${i} shard floats ${(p.y - (gy ?? 0)).toFixed(2)} m`);
        }
      }
    });
    // Slabs: every door kicked inward rests on a floor, ≤ 10 % with a leaf end > 0.15 m inside a wall / prop.
    physics.setLayout(L);
    const solid = L.colliders.filter((c) => c.kind === 'BUILDING' || c.kind === 'PROP');
    const inside = (p: THREE.Vector3): boolean => solid.some((c) => p.x > c.min.x + 0.15 && p.x < c.max.x - 0.15 && p.z > c.min.z + 0.15 && p.z < c.max.z - 0.15 && p.y > c.min.y + 0.02 && p.y < c.max.y - 0.02);
    let bad = 0;
    L.breachDoors.forEach((d, i) => {
      dm.setLevel(physics, L.colliders, L.breachDoors, L.glassPanes);
      dm.breachDoor(i, outward(d.yaw).negate());
      const cam = new THREE.Vector3(d.x, d.y + 1.6, d.z);
      for (let t = 0; t < 2.6; t += 1 / 60) dm.update(1 / 60, cam);
      const s = dm as unknown as { dPos: Float32Array; dRot: Float32Array };
      const c = new THREE.Vector3(s.dPos[i * 3], s.dPos[i * 3 + 1], s.dPos[i * 3 + 2]);
      const ax = new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(s.dRot[i * 4], s.dRot[i * 4 + 1], s.dRot[i * 4 + 2], s.dRot[i * 4 + 3]));
      const gy = physics.probeGround(c.clone().setY(c.y + 0.3), 0.6, 40);
      assert.ok(gy !== null && c.y - gy < 0.9, `${tagOf(B)}: door ${i} slab rests on a floor`);
      if (inside(c.clone().addScaledVector(ax, 0.95)) || inside(c.clone().addScaledVector(ax, -0.95))) bad++;
    });
    assert.ok(bad <= Math.ceil(L.breachDoors.length * 0.1), `${tagOf(B)}: ${bad} slabs with a leaf end inside a wall / prop`);
  }
});
