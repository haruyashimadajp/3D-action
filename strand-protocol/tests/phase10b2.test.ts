/**
 * Phase 10B-2 bug-fix pass: the pulse-scan mini-radar freezes outside PLAYING, and every 1F street doorway sits
 * centred in its 4 m bay on a solid FaceSpan with zero door / pier / obstacle overlap and no painted atlas doors.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as THREE from 'three';
import { LEVEL, RADAR, createRng } from '../src/config/constants';
import { SECTORS } from '../src/config/skills';
import type { RadarEnemySample } from '../src/entities/EnemyManager';
import { FACADE_BASE_BANDS, type PbrTextureSet, type ProceduralTextureLibrary } from '../src/engine/ProceduralTextures';
import { PulseRadar } from '../src/ui/HudManager';
import { DOOR_PIER_GAP_M, GRAMMAR, PROGRAM_DOOR, doorAssemblyHalf, planGroundFace } from '../src/world/BuildingGrammar';
import { CityBuilder, type GroundDoorRecord, type GroundPierRecord, type SectorLayout } from '../src/world/CityBuilder';

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
    glove: mockPbr(),
    gun: mockPbr(),
  };
}

// =============================================================================================
// 1. Paused mini-radar
// =============================================================================================
test('10B-2 radar: sweep phase, pulse radius, blips and ping stay frozen outside PLAYING and resume unchanged', () => {
  const radar = new PulseRadar();
  const targets: RadarEnemySample[] = [
    { id: 0, x: 0, y: 0, z: -10, state: 'UNAWARE' },
    { id: 1, x: 0, y: 8, z: -60, state: 'ALERT' },
  ];
  assert.equal(radar.step(0.01, 0, 0, 0, targets, 2), true, 'live radar pings at the first sweep');
  radar.step(0.5, 0, 0, 0, targets, 2);
  radar.step(0.4, 0, 0, 0, targets, 2);
  const snap = (): string => JSON.stringify({ c: radar.sweepClock, r: radar.sweepRadiusM, b: radar.blips });
  const before = snap();
  assert.ok(radar.blips[0].active && radar.blips[0].alpha < 1, 'a fading blip exists before the pause');

  // PAUSED / SKILL / RESULT / TRANSITION: 30 s of real time across several sweep periods, enemies moving.
  radar.frozen = true;
  let pings = 0;
  for (let i = 0; i < 1800; i++) {
    targets[0].z = -10 - i * 0.01;
    if (radar.step(1 / 60, 0, 0, 0, targets, 2)) pings++;
  }
  assert.equal(pings, 0, 'no sonar ping while frozen (30 s > 8 sweep periods)');
  assert.equal(snap(), before, 'sweep clock, pulse radius, blip snapshots and alphas are bit-identical after 30 s paused');

  // Resume: continues from the frozen phase (not from 30 s later).
  radar.frozen = false;
  const clock = radar.sweepClock;
  radar.step(0.1, 0, 0, 0, targets, 2);
  assert.ok(Math.abs(radar.sweepClock - (clock + 0.1)) < 1e-9, 'sweep phase resumes exactly where it froze');
  assert.ok(RADAR.SWEEP_PERIOD_S > 3, 'sanity: the period the paused span exceeded');
});

test('10B-2 radar wiring: step / ping only in PLAYING, frozen + dimmed on every other state, cleared on reset', () => {
  const main = readFileSync('src/main.ts', 'utf8');
  assert.match(main, /this\.hud\.setRadarFrozen\(!playing\)/, 'setState() freezes the radar outside PLAYING');
  const at = main.indexOf('this.hud.radar.step(');
  assert.ok(at > 0);
  const guard = main.lastIndexOf("if (this.state === 'PLAYING') {", at);
  assert.ok(guard > 0 && at - guard < 400, 'radar.step() is inside a PLAYING-only block');
  const ping = main.indexOf('this.audio.radarPing()');
  assert.ok(ping > at && ping - guard < 600, 'radarPing() is inside the same PLAYING-only block');
  assert.equal((main.match(/audio\.radarPing\(\)/g) ?? []).length, 1, 'no other radarPing() call site');
  assert.match(main, /this\.hud\.resetRadar\(\)/, 'respawn clears radar state and canvas');
  const hud = readFileSync('src/ui/HudManager.ts', 'utf8');
  assert.match(hud, /if \(!ctx \|\| this\.radar\.frozen\) return;/, 'canvas is not redrawn while frozen');
  assert.match(hud, /if \(this\.frozen\) return false;/, 'PulseRadar.step() is a no-op while frozen');
  const html = readFileSync('index.html', 'utf8');
  assert.match(html, /#hud\.radar-frozen #radar-canvas \{[^}]*opacity: 0\.22/, 'frozen radar dims behind the overlays');
});

// =============================================================================================
// 2. 1F doorways
// =============================================================================================
const CITY = new CityBuilder(mockTextures());
const ALL: SectorLayout[] = [];
for (let s = 1; s <= SECTORS.length; s++) ALL.push(CITY.buildSector(s, 0));
const planeKey = (r: { ax: string; sg: number; plane: number }): string => `${r.ax}:${r.sg}:${r.plane.toFixed(3)}`;
const EPS = 1e-6;

test('10B-2 doors: zero overlapping 1F doorway assemblies on any facade plane across all 5 sectors', () => {
  for (const [si, L] of ALL.entries()) {
    assert.ok(L.groundDoors.length >= 60, `S${si + 1}: plenty of 1F doors (${L.groundDoors.length})`);
    const byPlane = new Map<string, GroundDoorRecord[]>();
    for (const d of L.groundDoors) byPlane.set(planeKey(d), [...(byPlane.get(planeKey(d)) ?? []), d]);
    for (const list of byPlane.values()) {
      list.sort((p, q) => p.e0 - q.e0);
      for (let i = 1; i < list.length; i++) {
        assert.ok(list[i].e0 >= list[i - 1].e1 - EPS, `S${si + 1}: doors b${list[i - 1].building} @${list[i - 1].a.toFixed(2)} / b${list[i].building} @${list[i].a.toFixed(2)} overlap`);
      }
    }
  }
});

test('10B-2 doors: every door is centred in its bay, strictly inside its solid FaceSpan, and clear of every pier', () => {
  for (const [si, L] of ALL.entries()) {
    const piers = new Map<string, GroundPierRecord[]>();
    for (const p of L.groundPiers) piers.set(planeKey(p), [...(piers.get(planeKey(p)) ?? []), p]);
    for (const d of L.groundDoors) {
      const tag = `S${si + 1} b${d.building} ${d.program} @${d.a.toFixed(2)}`;
      // Host solid FaceSpan: a ground-standing span of this building, on this plane, containing the assembly.
      const spans = L.buildingSpans[d.building];
      const host = spans.find((sp) => sp.ax === d.ax && sp.sg === d.sg && Math.abs(sp.plane - d.plane) < EPS && sp.y0 < 0.01 && d.e0 >= sp.a0 - EPS && d.e1 <= sp.a1 + EPS);
      assert.ok(host, `${tag}: inside a solid ground FaceSpan`);
      assert.ok(d.top <= host.y1 + EPS, `${tag}: assembly top ${d.top.toFixed(2)} ≤ span top ${host.y1.toFixed(2)}`);
      // Bay: between pier faces, door centred, whole assembly ≥ DOOR_PIER_GAP_M inside.
      assert.ok(Math.abs(d.a - (d.bay.a0 + d.bay.a1) / 2) < EPS, `${tag}: centred in its bay`);
      assert.ok(d.e0 >= d.bay.a0 + DOOR_PIER_GAP_M - EPS && d.e1 <= d.bay.a1 - DOOR_PIER_GAP_M + EPS, `${tag}: assembly inside the bay`);
      assert.ok(d.bay.a1 - d.bay.a0 <= GRAMMAR.BAY_M * 1.5, `${tag}: a real 4 m-grammar bay`);
      assert.ok(d.e1 - d.e0 >= d.w + 0.4 - EPS, `${tag}: jamb surround is never clipped`);
      // Zero pier intersections (any building's pier on the same plane).
      for (const p of piers.get(planeKey(d)) ?? []) {
        assert.ok(p.a1 <= d.e0 + EPS || p.a0 >= d.e1 - EPS, `${tag}: pier b${p.building} [${p.a0.toFixed(2)}, ${p.a1.toFixed(2)}] cuts the doorway`);
      }
    }
  }
});

test('10B-2 doors: every doorway opens onto walkable ground (no lockdown wall, vending machine or gallery column within 1.5 m)', () => {
  const H = LEVEL.HALF_EXTENT_M;
  for (const [si, L] of ALL.entries()) {
    for (const d of L.groundDoors) {
      const tag = `S${si + 1} b${d.building} ${d.program} @${d.a.toFixed(2)}`;
      if (d.sg * d.plane > 0) assert.ok(H - 0.5 - Math.abs(d.plane) >= GRAMMAR.DOOR_CLEAR_M, `${tag}: faces the lockdown wall`);
      const P = (a: number, dd: number): [number, number] => (d.ax === 'x' ? [d.plane + d.sg * dd, a] : [a, d.plane + d.sg * dd]);
      const [x0, z0] = P(d.a - d.w / 2, 0.05);
      const [x1, z1] = P(d.a + d.w / 2, 1.5);
      const bx = { x0: Math.min(x0, x1), x1: Math.max(x0, x1), z0: Math.min(z0, z1), z1: Math.max(z0, z1) };
      const hit = L.colliders.find((c) => c.min.x < bx.x1 && c.max.x > bx.x0 && c.min.z < bx.z1 && c.max.z > bx.z0 && c.min.y < d.h && c.max.y > 0.1);
      assert.equal(hit, undefined, `${tag}: doorway blocked by ${hit?.kind} (building ${hit?.building})`);
    }
  }
});

test('10B-2 planGroundFace: narrow bays clamp the assembly, noDoor / allowDoors respected, far door indexed in free bays', () => {
  for (const prog of ['CYBER_EATERY', 'TECH_APPAREL', 'CAPSULE_HOTEL', 'CYBER_APARTMENT', 'ALLEY_INFRA'] as const) {
    // 6.6 m face → two 2.58 m bays: too narrow for a full hotel portal (2.94 m) or apartment canopy (2.52 + gap).
    for (const len of [3.2, 5.5, 6.6, 9.2, 20.48, 33]) {
      const plan = planGroundFace(prog, 0, len, createRng(11));
      for (const d of plan.doors) {
        const bay = plan.bays.find((b) => d.a > b.a0 && d.a < b.a1);
        assert.ok(bay, `${prog} ${len}: door in a bay`);
        assert.ok(Math.abs(d.a - (bay.a0 + bay.a1) / 2) < EPS, `${prog} ${len}: centred`);
        assert.ok(d.half <= doorAssemblyHalf(prog) + EPS, `${prog} ${len}: half ≤ full assembly`);
        assert.ok(d.a - d.half >= bay.a0 + DOOR_PIER_GAP_M - EPS && d.a + d.half <= bay.a1 - DOOR_PIER_GAP_M + EPS, `${prog} ${len}: assembly clear of piers`);
        assert.ok(d.half >= PROGRAM_DOOR[prog].w / 2 + 0.2 - EPS, `${prog} ${len}: surround fits`);
      }
      const doorsAt = plan.doors.map((d) => d.a).sort((p, q) => p - q);
      for (let i = 1; i < doorsAt.length; i++) assert.ok(doorsAt[i] - doorsAt[i - 1] > GRAMMAR.BAY_M * 0.5, `${prog} ${len}: doors in distinct bays`);
    }
    assert.equal(planGroundFace(prog, 0, 20.48, createRng(3), [], false).doors.length, 0, `${prog}: allowDoors = false`);
    const cols: Array<[number, number]> = [];
    for (let a = 0.12; a < 20.48; a += 4) cols.push([a - 0.12, a + 0.12]);
    for (const d of planGroundFace(prog, 0, 20.48, createRng(3), [], true, cols).doors) {
      for (const [c0, c1] of cols) assert.ok(c1 <= d.a - d.w / 2 - 0.2 - 0.15 + EPS || c0 >= d.a + d.w / 2 + 0.2 + 0.15 - EPS, `${prog}: door clear of noDoor column`);
    }
  }
});

// =============================================================================================
// 3. Facade atlas: no painted 2D doors behind the 3D doorways
// =============================================================================================
test('10B-2 facade atlas: the row-0 street base is door-free (full-width bands only, no painted entrances)', () => {
  assert.equal(FACADE_BASE_BANDS.length, 4, 'one solid base per archetype column');
  for (const bands of FACADE_BASE_BANDS) {
    assert.ok(bands.length >= 3);
    for (const b of bands) assert.ok(b.y1 > b.y0 && b.y0 >= 0, 'bands are full-width horizontal strips');
    assert.ok(bands.some((b) => b.y0 === 0), 'the base starts at the street');
  }
  const src = readFileSync('src/engine/ProceduralTextures.ts', 'utf8');
  assert.equal((src.match(/\bcell\(\d, 0\)/g) ?? []).length, 0, 'no hand-painted row-0 cell remains');
  const i0 = src.indexOf('// <solid-base>');
  const i1 = src.indexOf('// </solid-base>');
  assert.ok(i0 > 0 && i1 > i0, 'solid-base section present');
  const code = src
    .slice(i0, i1)
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
  assert.ok(!/door|shutter|wicket|entrance|louvre\(|vbar\(|pool\(|graffiti\(/i.test(code), 'no door / shutter / pillar / downlight painting in the base');
  for (const m of code.matchAll(/\bR\(([^,]+),/g)) assert.ok(m[1].trim() === '0' || m[1].trim() === 'x', `R(${m[1]}, …): only full-width bands or random marks`);
  assert.match(code, /0\.2 \+ rng\(\) \* 0\.6/, 'marks are ≤ 0.8 m wide');
});
