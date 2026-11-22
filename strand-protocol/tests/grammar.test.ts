/** Phase 9A architectural grammar (BuildingGrammar.ts): floor grid, massings, parapets, programs, sockets, AO. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ARCHETYPE, FACADE, createRng } from '../src/config/constants';
import {
  ARCH_A,
  ARCH_B,
  ARCH_C,
  ARCH_D,
  GRAMMAR,
  GROUND_PROGRAMS,
  MASSING_KINDS,
  PROGRAM_DOOR,
  aoBox,
  assignMassings,
  assignPrograms,
  doorClearZone,
  doorSockets,
  faceKeyOf,
  floorTopY,
  groundContactAo,
  isOnFloorGrid,
  onSolidRoof,
  parapetSegments,
  planGallery,
  galleryClearance,
  planGroundFace,
  planMassing,
  quantizeToFloors,
  type MassingCandidate,
  type Rect,
} from '../src/world/BuildingGrammar';

const lot = (x0: number, z0: number, w: number, d: number): Rect => ({ x0, z0, x1: x0 + w, z1: z0 + d });
const cand = (arch: number, r: Rect, roofY: number, alley: string[] = []): MassingCandidate => ({ arch, lot: r, roofY, alley: new Set(alley) });
const inside = (r: Rect, o: Rect): boolean => r.x0 >= o.x0 - 1e-6 && r.x1 <= o.x1 + 1e-6 && r.z0 >= o.z0 - 1e-6 && r.z1 <= o.z1 + 1e-6;

test('9A-1 floor grid: roofs snap to FLOOR_BASE_M[arch] + n · 4 m inside the archetype ∩ sector band', () => {
  assert.equal(FACADE.FLOOR_H_M, 4);
  for (const arch of [ARCH_A, ARCH_B, ARCH_C, ARCH_D]) {
    for (let h = 10; h <= 100; h += 0.5) {
      const lo = Math.max(ARCHETYPE.MIN_H[arch], 16);
      const hi = Math.min(ARCHETYPE.MAX_H[arch], 95);
      const y = quantizeToFloors(arch, h, lo, hi);
      assert.ok(isOnFloorGrid(arch, y), `arch ${arch} h ${h} → ${y}`);
      assert.equal((y - FACADE.FLOOR_BASE_M[arch]) % FACADE.FLOOR_H_M, 0);
      assert.ok(y >= lo - 1e-9 && y <= hi + 1e-9, `arch ${arch} ${y} in [${lo}, ${hi}]`);
    }
  }
  assert.equal(floorTopY(ARCH_B, 1), 6);
  assert.equal(floorTopY(ARCH_A, 2), 8);
  assert.equal(quantizeToFloors(ARCH_A, 49.9, 45, 95, 'ceil'), 52);
  assert.ok(!isOnFloorGrid(ARCH_B, 24) && isOnFloorGrid(ARCH_B, 26));
});

test('9A-2 every massing plan sits on the floor grid, with an on-grid setback', () => {
  const rng = createRng(7);
  const cases: Array<[(typeof MASSING_KINDS)[number], MassingCandidate]> = [
    ['STEPPED_SETBACK', cand(ARCH_A, lot(0, 0, 30, 28), 88)],
    ['STEPPED_SETBACK', cand(ARCH_A, lot(0, 0, 22, 20), 52)],
    ['PODIUM_OFFSET', cand(ARCH_D, lot(0, 0, 24, 20), 40, ['x:1'])],
    ['L_SHAPE', cand(ARCH_B, lot(0, 0, 26, 24), 38, ['x:-1'])],
    ['GALLERY_DANCHI', cand(ARCH_B, lot(0, 0, 24, 16), 34)],
    ['PENCIL_TOWER', cand(ARCH_C, lot(0, 0, 12, 22), 32)],
  ];
  for (const [kind, c] of cases) {
    const p = planMassing(kind, c, rng);
    assert.equal(p.kind, kind);
    for (const pl of p.plates) assert.ok(isOnFloorGrid(c.arch, pl.y), `${kind} plate ${pl.y}`);
    if (p.setbackY) assert.ok(isOnFloorGrid(c.arch, p.setbackY), `${kind} setback ${p.setbackY}`);
    assert.equal(Math.max(...p.plates.map((x) => x.y)), c.roofY, `${kind} top = roof`);
    for (const b of p.boxes) assert.ok(inside(b, c.lot), `${kind} box inside the lot`);
    assert.ok(p.roof.halfW >= GRAMMAR.MIN_ROOF_HALF_M && p.roof.halfD >= GRAMMAR.MIN_ROOF_HALF_M, `${kind} roof ≥ 8 × 8 m`);
  }
});

test('9A-2 STEPPED_SETBACK: tiers taper upward, terraces above 36 m, ≥ 8 m per tier', () => {
  for (let s = 0; s < 20; s++) {
    const p = planMassing('STEPPED_SETBACK', cand(ARCH_A, lot(0, 0, 30, 30), 92), createRng(100 + s));
    assert.ok(p.boxes.length === 2 || p.boxes.length === 3);
    for (let i = 1; i < p.boxes.length; i++) {
      const a = p.boxes[i - 1];
      const b = p.boxes[i];
      assert.ok(b.x1 - b.x0 < a.x1 - a.x0 && b.z1 - b.z0 < a.z1 - a.z0, 'tapers');
      assert.equal(b.y0, a.y1);
      assert.ok(b.y1 - b.y0 >= GRAMMAR.STEPPED_MIN_TIER_M);
    }
    assert.ok(p.setbackY >= GRAMMAR.STEPPED_MIN_SETBACK_Y);
  }
});

test('9A-2 PODIUM_OFFSET: 8 m podium, tower 60–72 % flush to one corner (preferring alley faces)', () => {
  const c = cand(ARCH_D, lot(-10, -12, 24, 20), 44, ['x:1', 'z:-1']);
  const p = planMassing('PODIUM_OFFSET', c, createRng(3));
  const [podium, tower] = p.boxes;
  assert.equal(podium.y1, 8);
  assert.equal(tower.y0, 8);
  assert.equal(tower.y1, 44);
  const kw = (tower.x1 - tower.x0) / 24;
  const kd = (tower.z1 - tower.z0) / 20;
  assert.ok(kw >= 0.6 - 1e-9 && kw <= 0.72 + 1e-9 && kd >= 0.6 - 1e-9 && kd <= 0.72 + 1e-9);
  assert.equal(tower.x1, c.lot.x1, 'flush with the alley face x:+1');
  assert.equal(tower.z0, c.lot.z0, 'flush with the alley face z:-1');
  assert.deepEqual(p.flush.sort(), ['x:1', 'z:-1']);
  // Terrace parapet: the lot perimeter minus the tower's footprint on the flush edges.
  const segs = parapetSegments(p).filter((s) => s.y === 8);
  const len = segs.reduce((a, s) => a + s.a1 - s.a0, 0);
  assert.ok(Math.abs(len - (2 * (24 + 20) - (tower.x1 - tower.x0) - (tower.z1 - tower.z0))) < 1e-6, `terrace parapet ${len}`);
});

test('9A-2 L_SHAPE: two wing AABBs, courtyard ≥ 7 × 7 m on a free street corner, wings ≥ 10 m, roof on wing A', () => {
  for (let s = 0; s < 40; s++) {
    const w = 18 + (s % 7) * 2.5;
    const d = 18 + ((s * 3) % 7) * 2.3;
    const c = cand(ARCH_B, lot(5, -7, w, d), 30, s % 2 ? ['x:-1'] : ['z:1']);
    const p = planMassing('L_SHAPE', c, createRng(500 + s));
    assert.equal(p.boxes.length, 2);
    const cut = p.cut as Rect;
    assert.ok(cut.x1 - cut.x0 >= GRAMMAR.L_MIN_CUT_M - 1e-9 && cut.z1 - cut.z0 >= GRAMMAR.L_MIN_CUT_M - 1e-9, 'courtyard ≥ 7 m');
    assert.ok(w - (cut.x1 - cut.x0) >= GRAMMAR.L_MIN_WING_M - 1e-9 && d - (cut.z1 - cut.z0) >= GRAMMAR.L_MIN_WING_M - 1e-9, 'wings ≥ 10 m');
    // The cut corner faces are never alleys.
    const cx = Math.abs(cut.x1 - c.lot.x1) < 1e-6 ? 1 : -1;
    const cz = Math.abs(cut.z1 - c.lot.z1) < 1e-6 ? 1 : -1;
    assert.ok(!c.alley.has(faceKeyOf('x', cx)) && !c.alley.has(faceKeyOf('z', cz)));
    // Wings + courtyard tile the lot exactly, without overlap.
    const area = (r: Rect): number => (r.x1 - r.x0) * (r.z1 - r.z0);
    assert.ok(Math.abs(area(p.boxes[0]) + area(p.boxes[1]) + area(cut) - w * d) < 1e-6);
    // Roof record = the larger wing; zero roof props can float over the cutout.
    const roof: Rect = { x0: p.roof.cx - p.roof.halfW, x1: p.roof.cx + p.roof.halfW, z0: p.roof.cz - p.roof.halfD, z1: p.roof.cz + p.roof.halfD };
    assert.ok(inside(roof, p.boxes[0]) && area(p.boxes[0]) >= area(p.boxes[1]));
    const rng = createRng(s);
    for (let k = 0; k < 50; k++) {
      const hw = 0.6 + rng() * 2;
      const hd = 0.6 + rng() * 2;
      const x = p.roof.cx + (rng() * 2 - 1) * Math.max(0, p.roof.halfW - hw - 1);
      const z = p.roof.cz + (rng() * 2 - 1) * Math.max(0, p.roof.halfD - hd - 1);
      const r = { x0: x - hw, x1: x + hw, z0: z - hd, z1: z + hd };
      assert.ok(onSolidRoof(p, r), 'roof prop on solid roof');
      assert.ok(!(r.x1 > cut.x0 && r.x0 < cut.x1 && r.z1 > cut.z0 && r.z0 < cut.z1), 'never over the courtyard');
    }
    // Courtyard walls are exposed and flagged; no wall span runs through the cut.
    assert.ok(p.faces.some((f) => f.court));
  }
  // A prop rect over the courtyard is detected as floating.
  const p = planMassing('L_SHAPE', cand(ARCH_C, lot(0, 0, 24, 24), 28), createRng(1));
  const cut = p.cut as Rect;
  assert.ok(!onSolidRoof(p, { x0: cut.x0 + 1, x1: cut.x0 + 2, z0: cut.z0 + 1, z1: cut.z0 + 2 }));
});

test('9A-1 parapets: closed perimeter at 1.05 m, 2.4 m gaps at fire-escape landings, none on shared wing walls', () => {
  const c = cand(ARCH_C, lot(0, 0, 20, 16), 24);
  const p = planMassing('PENCIL_TOWER', c, createRng(2));
  const full = parapetSegments(p).reduce((a, s) => a + s.a1 - s.a0, 0);
  assert.ok(Math.abs(full - 2 * (20 + 16)) < 1e-6);
  const gapped = parapetSegments(p, [{ ax: 'x', sg: 1, plane: 20, a0: 6.8, a1: 9.2 }]);
  const len = gapped.reduce((a, s) => a + s.a1 - s.a0, 0);
  assert.ok(Math.abs(full - len - GRAMMAR.ESCAPE_GAP_M) < 1e-6, 'one 2.4 m gap');
  assert.ok(!gapped.some((s) => s.ax === 'x' && s.sg === 1 && s.a0 < 9.2 && s.a1 > 6.8), 'gap is open');
  assert.equal(GRAMMAR.PARAPET_H, 1.05);
  assert.equal(GRAMMAR.PARAPET_T, 0.32);
  const L = planMassing('L_SHAPE', cand(ARCH_B, lot(0, 0, 24, 24), 30), createRng(4));
  const [A, B] = L.boxes;
  const segs = parapetSegments(L);
  // No parapet along the wall the two wings share.
  const shared = (s: (typeof segs)[number]): boolean => (s.ax === 'x' ? (Math.abs(s.plane - A.x1) < 1e-6 || Math.abs(s.plane - A.x0) < 1e-6) && Math.abs(s.plane - (s.sg > 0 ? B.x0 : B.x1)) < 1e-6 : (Math.abs(s.plane - A.z1) < 1e-6 || Math.abs(s.plane - A.z0) < 1e-6) && Math.abs(s.plane - (s.sg > 0 ? B.z0 : B.z1)) < 1e-6);
  for (const s of segs) {
    if (!shared(s)) continue;
    const lo = s.ax === 'x' ? Math.max(A.z0, B.z0) : Math.max(A.x0, B.x0);
    const hi = s.ax === 'x' ? Math.min(A.z1, B.z1) : Math.min(A.x1, B.x1);
    assert.ok(s.a1 <= lo + 1e-6 || s.a0 >= hi - 1e-6, 'no parapet on the shared wing wall');
  }
});

test('9A-2 assignment: all five massings per district, ≥ 2 galleries, rules respected', () => {
  for (let seed = 0; seed < 30; seed++) {
    const rng = createRng(900 + seed);
    const cands: MassingCandidate[] = [];
    const archs = [ARCH_A, ARCH_A, ARCH_A, ARCH_A, ARCH_B, ARCH_B, ARCH_B, ARCH_B, ARCH_C, ARCH_C, ARCH_C, ARCH_D, ARCH_D, ARCH_D];
    archs.forEach((arch, i) => {
      const w = 10 + Math.floor(rng() * 25);
      const d = 10 + Math.floor(rng() * 25);
      const roof = arch === ARCH_A ? 48 + Math.floor(rng() * 10) * 4 : arch === ARCH_B ? 26 + Math.floor(rng() * 8) * 4 : 20 + Math.floor(rng() * 6) * 4;
      cands.push(cand(arch, lot(i * 40, 0, w, d), roof, rng() < 0.4 ? ['x:1'] : []));
    });
    // Make sure the rule-eligible lots exist (one big B/C, one narrow C).
    cands[5] = cand(ARCH_B, lot(200, 0, 26, 24), 34);
    cands[9] = cand(ARCH_C, lot(360, 0, 12, 20), 28);
    const kinds = assignMassings(cands, createRng(seed));
    for (const k of MASSING_KINDS) assert.ok(kinds.includes(k), `seed ${seed}: ${k} present (${kinds.join(',')})`);
    assert.ok(kinds.filter((k) => k === 'GALLERY_DANCHI').length >= 2);
    kinds.forEach((k, i) => {
      const c = cands[i];
      const ms = Math.min(c.lot.x1 - c.lot.x0, c.lot.z1 - c.lot.z0);
      if (k === 'L_SHAPE') assert.ok(ms >= GRAMMAR.L_MIN_SIDE_M, 'L lots ≥ 18 m');
      if (k === 'STEPPED_SETBACK') assert.ok(c.roofY >= GRAMMAR.STEPPED_MIN_ROOF_M, 'stepped ≥ 44 m');
      if (k === 'PODIUM_OFFSET') assert.ok(ms >= GRAMMAR.PODIUM_MIN_SIDE_M, 'podium lots ≥ 14 m');
    });
  }
});

test('9A-2 GALLERY_DANCHI corridors: 2F–4F on the floor grid, zig-zag external stair links every level, doors every 4 m', () => {
  const g = planGallery(ARCH_B, -12, 12);
  assert.deepEqual(g.levels.map((l) => l.y), [6, 10, 14]);
  assert.equal(g.capY, 18);
  assert.equal(g.ramps.length, 3, 'street → 2F → 3F → 4F');
  // Every flight sits outside the balustrade and both of its ends meet the street or a landing at the same height.
  const lands = g.landings;
  for (const r of g.ramps) {
    assert.ok(r.d0 >= GRAMMAR.GALLERY_DEPTH_M, 'flight outside the deck');
    const at = (a: number, y: number): boolean => lands.some((l) => l.y === y && (Math.abs(l.a0 - a) < 1e-9 || Math.abs(l.a1 - a) < 1e-9));
    assert.ok(at(r.aHigh, r.yHigh), `flight top ${r.yHigh} m lands on a landing`);
    assert.ok(r.yLow === 0 || at(r.aLow, r.yLow), `flight foot ${r.yLow} m starts on a landing`);
  }
  // Each level is reached by exactly one flight; each landing touches the deck edge through a balustrade gap.
  g.levels.forEach((lv, k) => {
    const below = k === 0 ? 0 : g.levels[k - 1].y;
    assert.equal(g.ramps.filter((r) => r.yLow === below && r.yHigh === lv.y).length, 1, `${lv.y} m reachable`);
    for (const l of lands.filter((q) => q.y === lv.y)) {
      assert.ok(l.d0 <= GRAMMAR.GALLERY_DEPTH_M && l.a0 >= lv.a0 - 1e-9 && l.a1 <= lv.a1 + 1e-9);
      assert.ok(lv.railGaps.some(([r0, r1]) => r0 <= l.a0 + 1e-9 && r1 >= l.a1 - 1e-9), 'rail gap over the landing');
    }
    // Decks are uninterrupted: doors every 4 m from end to end.
    assert.ok(lv.doors.length >= 4);
    for (let i = 1; i < lv.doors.length; i++) assert.ok(Math.abs(lv.doors[i] - lv.doors[i - 1] - 4) < 1e-6);
  });
  // The player fits under every stacked flight / landing.
  assert.ok(galleryClearance(g) >= GRAMMAR.GALLERY_HEADROOM_M);
  // Shorter faces drop flights from the top, never leaving a flight without its landings or head room.
  assert.ok(GRAMMAR.GALLERY_MIN_FACE_M >= 2 * GRAMMAR.GALLERY_END_PIER_M + GRAMMAR.GALLERY_STAIR_RUN_M + GRAMMAR.GALLERY_LANDING_M);
  for (let w = GRAMMAR.GALLERY_MIN_FACE_M; w <= 30; w += 0.5) {
    const p = planGallery(ARCH_B, 0, w);
    assert.ok(p.ramps.length >= 1, `${w} m face reachable from the street`);
    assert.ok(galleryClearance(p) >= GRAMMAR.GALLERY_HEADROOM_M, `head room at ${w} m`);
    p.ramps.forEach((r, i) => assert.equal(r.yHigh, p.levels[i].y, 'flights climb level by level'));
    assert.equal(p.landings.length, p.ramps.length * 2 - (p.ramps.length ? 1 : 0));
  }
  assert.equal(planGallery(ARCH_B, 0, GRAMMAR.GALLERY_MIN_FACE_M).ramps.length, 1, 'shortest face: street stair only');
  let prev = 0;
  for (let w = GRAMMAR.GALLERY_MIN_FACE_M; w <= 30; w += 0.1) {
    const n = planGallery(ARCH_B, 0, w).ramps.length;
    assert.ok(n >= prev, 'a longer face never loses a flight');
    prev = n;
  }
  const ga = planGallery(ARCH_A, 0, 20);
  assert.deepEqual(ga.levels.map((l) => l.y), [4, 8, 12]);
});

test('9A-4 programs: alley backs are ALLEY_INFRA, galleries get apartment lobbies, all five per district', () => {
  for (let seed = 0; seed < 25; seed++) {
    const rng = createRng(seed);
    const faces = Array.from({ length: 36 }, (_, i) => ({ id: i, arch: i % 4, alley: rng() < 0.2, massing: (i % 9 === 0 ? 'GALLERY_DANCHI' : 'PODIUM_OFFSET') as (typeof MASSING_KINDS)[number], len: 8 + rng() * 20 }));
    const p = assignPrograms(faces, createRng(seed + 1));
    faces.forEach((f, i) => {
      if (f.alley) assert.equal(p[i], 'ALLEY_INFRA');
      else if (f.massing === 'GALLERY_DANCHI') assert.equal(p[i], 'CYBER_APARTMENT');
    });
    for (const prog of GROUND_PROGRAMS) assert.ok(faces.some((f, i) => !f.alley && p[i] === prog), `seed ${seed}: ${prog}`);
  }
});

test('9A-4 shared 4 m bay grammar + human-scale recessed doors on every program', () => {
  for (const prog of GROUND_PROGRAMS) {
    const d = PROGRAM_DOOR[prog];
    assert.ok(d.w >= 1.0 && d.w <= 1.8, `${prog} door width ${d.w}`);
    assert.ok(d.h >= 2.1 && d.h <= 2.25, `${prog} door height ${d.h}`);
    assert.ok(d.recess >= 0.32 && d.recess <= 0.8, `${prog} recess ${d.recess}`);
    const plan = planGroundFace(prog, 0, 20.48, createRng(5));
    assert.equal(plan.piers.length, 6);
    for (let i = 1; i < plan.piers.length; i++) assert.ok(Math.abs(plan.piers[i] - plan.piers[i - 1] - 4) < 1e-6, 'piers every 4 m');
    assert.ok(plan.doors.length >= 1, `${prog} has a door`);
    for (const door of plan.doors) {
      const bay = plan.bays.find((b) => door.a > b.a0 && door.a < b.a1);
      assert.ok(bay && bay.a1 - bay.a0 >= door.w + 0.5, 'door fits its bay');
    }
  }
  // Blocked ranges (fire-escape flights, docks) never receive doors.
  const blocked = planGroundFace('ALLEY_INFRA', 0, 20.48, createRng(5), [[0, 14]]);
  for (const door of blocked.doors) assert.ok(door.a > 14.3);
});

test('9A-4 sockets + clear zones: deterministic, 1.8 × 1.8 m zone, floor sockets outside it, wall sockets on the wall', () => {
  const f = { ax: 'z' as const, sg: 1, plane: 10 };
  const zone = doorClearZone(f, 3);
  assert.ok(Math.abs(zone.x1 - zone.x0 - 1.8) < 1e-9 && Math.abs(zone.z1 - zone.z0 - 1.8) < 1e-9);
  assert.equal(zone.z0, 10);
  const s1 = doorSockets(f, { a: 3, w: 1.12, h: 2.15 }, 0, 'APARTMENT', ['FLOOR_L', 'FLOOR_R', 'WALL_SIDE', 'WALL_HIGH'], 4, 17, createRng(9));
  const s2 = doorSockets(f, { a: 3, w: 1.12, h: 2.15 }, 0, 'APARTMENT', ['FLOOR_L', 'FLOOR_R', 'WALL_SIDE', 'WALL_HIGH'], 4, 17, createRng(9));
  assert.deepEqual(s1, s2, 'deterministic');
  assert.deepEqual(s1.map((s) => s.slot), ['FLOOR_L', 'FLOOR_R', 'WALL_SIDE', 'WALL_HIGH']);
  for (const s of s1) {
    assert.equal(s.nz, 1);
    assert.equal(s.door, 17);
    if (s.slot.startsWith('FLOOR')) {
      assert.equal(s.y, 0);
      assert.ok(s.x < zone.x0 || s.x > zone.x1, 'floor socket outside the clear zone');
    } else {
      assert.ok(Math.abs(s.z - 10.02) < 1e-9, 'wall socket on the facade');
      assert.ok(s.y > 1);
    }
  }
  const high = s1.find((s) => s.slot === 'WALL_HIGH');
  assert.ok(high && high.y > 2.15, 'above the lintel');
  const gal = doorSockets(f, { a: 3, w: 1.02, h: 2.15 }, 10, 'GALLERY', ['FLOOR_L', 'FLOOR_R', 'WALL_SIDE', 'WALL_HIGH'], 1, 2, createRng(1));
  assert.ok(gal.filter((s) => s.slot.startsWith('FLOOR')).every((s) => s.y === 10), 'gallery floor sockets sit on the deck');
});

test('9A-5 vertex AO: 0.55 m contact split, ramp to 0.42 at the ground, dark undersides', () => {
  assert.equal(groundContactAo(0), 0.42);
  assert.equal(groundContactAo(0.55), 1);
  assert.equal(groundContactAo(3), 1);
  const parts = aoBox(0.48, 4, 0.36, 0, 2, 0, { ground: true, bottom: 0.44 });
  assert.equal(parts.length, 2, 'split at the contact line');
  const all = parts.flatMap((g) => {
    const p = g.getAttribute('position');
    const a = g.getAttribute('aAo');
    return Array.from({ length: p.count }, (_, i) => [p.getY(i), a.getX(i)] as const);
  });
  for (const [y, a] of all) {
    if (y < 0.01) assert.ok(a <= 0.42 + 1e-6);
    if (y > 0.56) assert.equal(a, 1);
  }
  const canopy = aoBox(4, 0.12, 1.4, 0, 3.3, 0, { bottom: 0.44 })[0];
  const n = canopy.getAttribute('normal');
  const ao = canopy.getAttribute('aAo');
  for (let i = 0; i < n.count; i++) assert.ok(Math.abs(ao.getX(i) - (n.getY(i) < -0.5 ? 0.44 : 1)) < 1e-6);
  const raised = aoBox(1, 1.05, 0.32, 0, 30.525, 0, { ground: true, contact: 30 });
  assert.equal(raised.length, 2, 'parapet split above its roof');
  const ra = raised[0].getAttribute('aAo');
  const rp = raised[0].getAttribute('position');
  let minAo = 1;
  for (let i = 0; i < ra.count; i++) if (rp.getY(i) < 30.01) minAo = Math.min(minAo, ra.getX(i));
  assert.ok(Math.abs(minAo - 0.42) < 1e-6, 'parapet base darkened to 0.42 at its roof');
  void THREE;
});

test('9A-2 narrow-lot district (≤ 14 m short sides) still gets all five massings via the fallbacks', () => {
  const archs = [ARCH_B, ARCH_B, ARCH_C, ARCH_D, ARCH_B, ARCH_C, ARCH_D, ARCH_C, ARCH_A, ARCH_C, ARCH_A, ARCH_A, ARCH_D, ARCH_A, ARCH_A, ARCH_B, ARCH_B, ARCH_D];
  const dims: Array<[number, number, number]> = [[30.6, 13.55, 62], [30.6, 13.55, 62], [12, 29, 48], [12, 29, 52], [13, 27, 62], [13, 27, 48], [28, 14, 52], [28, 14, 48], [13, 29, 76], [13, 29, 48], [25, 14, 84], [25, 14, 76], [12, 27, 24], [12, 27, 80], [31, 14, 76], [31, 14, 62], [28, 12, 62], [28, 12, 52]];
  const cands = dims.map(([w, d, h], i) => cand(archs[i], lot(i * 40, 0, w, d), h));
  const kinds = assignMassings(cands, createRng(3));
  for (const k of MASSING_KINDS) assert.ok(kinds.includes(k), `${k} present (${kinds.join(',')})`);
  const li = kinds.indexOf('L_SHAPE');
  const p = planMassing('L_SHAPE', cands[li], createRng(8));
  const cut = p.cut as Rect;
  assert.ok(cut.x1 - cut.x0 >= 7 - 1e-9 && cut.z1 - cut.z0 >= 7 - 1e-9, 'courtyard ≥ 7 × 7 m');
  const A = p.boxes[0];
  assert.ok(A.x1 - A.x0 >= 10 - 1e-9 && A.z1 - A.z0 >= 10 - 1e-9, 'roof wing ≥ 10 m');
  assert.ok(p.boxes.every((b) => Math.min(b.x1 - b.x0, b.z1 - b.z0) >= 6.5 - 1e-9), 'secondary wing ≥ 6.5 m');
});
