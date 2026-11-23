/**
 * Phase 9B unit tests: per-door socket composition (adjacent-door diversity, tidy share, fit), door clear-zone
 * non-overlap, the ≥ 2.6 m alley centre path, wall-run strips, L-courtyard containment, decals and the GPU kits.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createRng } from '../src/config/constants';
import {
  ARCH_B,
  GROUND_PROGRAMS,
  PROGRAM_SOCKETS,
  baySocket,
  doorClearZone,
  doorSockets,
  galleryDoorFit,
  groundDoorFit,
  planGallery,
  planGroundFace,
  planMassing,
  type FaceRef,
  type GroundProgram,
  type MassingCandidate,
  type PropSocket,
  type Rect,
} from '../src/world/BuildingGrammar';
import {
  KIT_CAP,
  KIT_IDS,
  PLAQUE_LABELS,
  PROPS,
  PROP_DEFS,
  alleyCentreBand,
  alleyStrips,
  composeSockets,
  planClutter,
  planDecals,
  toAabb,
  type ClutterStrip,
  type DecalSurface,
  type PropId,
  type PropInstance,
} from '../src/world/CityProps';
import { CityPropMeshes } from '../src/world/CityPropMeshes';

const F: FaceRef = { ax: 'z', sg: 1, plane: 10 };
const overlaps = (a: { minX: number; maxX: number; minZ: number; maxZ: number }, r: Rect, m = 0): boolean => a.maxX > r.x0 + m && a.minX < r.x1 - m && a.maxZ > r.z0 + m && a.minZ < r.z1 - m;

/** Gallery corridor sockets: 3 levels × doors every 4 m (exactly as CityBuilder emits them). */
function gallerySockets(seed: number, building: number, idStart: number): { sockets: PropSocket[]; zones: Array<Rect & { y: number }> } {
  const rng = createRng(seed);
  const g = planGallery(ARCH_B, -14, 14);
  const sockets: PropSocket[] = [];
  const zones: Array<Rect & { y: number }> = [];
  let id = idStart;
  for (const lv of g.levels) {
    for (const a of lv.doors) {
      zones.push({ ...doorClearZone(F, a), y: lv.y });
      sockets.push(...doorSockets(F, { a, w: 1.02, h: 2.15 }, lv.y, 'GALLERY', ['FLOOR_L', 'FLOOR_R', 'WALL_SIDE', 'WALL_HIGH'], building, id++, rng, galleryDoorFit(a, lv.a0, lv.a1)));
    }
  }
  return { sockets, zones };
}

/** One 1F street face of a program: door sockets (with fits), bay sockets, clear zones. */
function streetSockets(program: GroundProgram, seed: number, building: number, idStart: number, opts: { reach?: number; low?: boolean } = {}): { sockets: PropSocket[]; zones: Rect[]; doors: number[] } {
  const rng = createRng(seed);
  const plan = planGroundFace(program, -10, 10, rng);
  const spec = PROGRAM_SOCKETS[program];
  const reach = opts.reach ?? 1.55;
  const low = opts.low ?? false;
  const sockets: PropSocket[] = [];
  const zones: Rect[] = [];
  let id = idStart;
  for (const b of plan.bays) {
    if (b.use === 'PANEL' || b.use === 'VITRINE' || b.use === 'SHUTTER' || b.use === 'GRILLE') {
      const s = baySocket(F, b.a0 + 0.45, b.a1 - 0.45, 0.36, reach - 0.36, 0, spec.group, building, low, rng);
      if (s) sockets.push(s);
    }
  }
  for (const d of plan.doors) {
    zones.push(doorClearZone(F, d.a));
    const bay = plan.bays.find((b) => d.a > b.a0 && d.a < b.a1);
    sockets.push(...doorSockets(F, d, 0, spec.group, spec.slots, building, id++, rng, groundDoorFit(program, d, bay, reach, low, false)));
  }
  return { sockets, zones, doors: plan.doors.map((d) => d.a) };
}

const nonPlaque = (props: readonly PropInstance[]): PropInstance[] => props.filter((p) => !(p.id === 'PLAQUE' && p.slot === 'WALL_HIGH'));

test('9B-1 adjacent doors never share a composition; ~15 % tidy; 1–3 distinct props per dressed door', () => {
  let doors = 0;
  let tidy = 0;
  let pairs = 0;
  let dressedEmpty = 0;
  for (let seed = 0; seed < 60; seed++) {
    const { sockets } = gallerySockets(seed, seed % 9, 0);
    const res = composeSockets(sockets);
    res.doors.forEach((d, i) => {
      doors++;
      if (d.tidy) tidy++;
      const ids = nonPlaque(d.props).map((p) => p.id);
      if (d.tidy) {
        assert.ok(d.props.every((p) => p.id === 'PLAQUE' || p.id === 'KEYPAD'), 'tidy door: plaque + keypad only');
      } else {
        assert.ok(ids.length <= 3, '≤ 3 props');
        assert.equal(new Set(ids).size, ids.length, 'distinct props');
        if (ids.length === 0) dressedEmpty++;
      }
      // Every gallery door carries its room-number plaque.
      assert.equal(d.props.filter((p) => p.id === 'PLAQUE' && p.slot === 'WALL_HIGH').length, 1, 'room plaque');
      const prev = res.doors[i - 1];
      if (prev && prev.door === d.door - 1 && Math.abs(prev.y - d.y) < 0.5) {
        pairs++;
        assert.notEqual(prev.signature, d.signature, `doors ${prev.door}/${d.door} cloned (${d.signature})`);
        assert.ok(!(prev.tidy && d.tidy), 'never two tidy doors in a row');
        const cell = (c: typeof d): number => (c.props.find((p) => p.id === 'PLAQUE' && p.slot === 'WALL_HIGH') as PropInstance).cell;
        assert.notEqual(cell(prev), cell(d), 'different room numbers');
        assert.ok(cell(d) >= 0 && cell(d) < PLAQUE_LABELS.length);
      }
    });
  }
  assert.ok(pairs > 500, `${pairs} adjacent pairs`);
  const share = tidy / doors;
  assert.ok(share > 0.1 && share < 0.2, `tidy share ${share.toFixed(3)}`);
  assert.ok(dressedEmpty / doors < 0.03, 'dressed doors carry 1–3 props');
  // Storefronts: consecutive doors of one building differ too, and every bay prop stays on its bay.
  for (let seed = 0; seed < 30; seed++) {
    const all: PropSocket[] = [];
    let id = 0;
    for (const program of GROUND_PROGRAMS) {
      const s = streetSockets(program, seed * 7 + id, 3, id);
      id += 10;
      all.push(...s.sockets);
    }
    const res = composeSockets(all);
    res.doors.forEach((d, i) => {
      const prev = res.doors[i - 1];
      if (prev && prev.door === d.door - 1) assert.notEqual(prev.signature, d.signature);
    });
  }
});

test('9B-1 props fit their sockets: inside the free range, flush, jitter limits, low on run faces, below wall fixtures', () => {
  const check = (sockets: PropSocket[]): number => {
    const res = composeSockets(sockets);
    const props = [...res.bays, ...res.doors.flatMap((d) => d.props)];
    for (const p of props) {
      const sock = sockets.find((s) => s.slot === p.slot && (p.slot === 'BAY' ? Math.abs(s.x - p.x) <= s.w / 2 + 1e-6 && Math.abs(s.z - F.plane) < 1 : s.door === p.door)) as PropSocket;
      assert.ok(sock, 'socket found');
      const def = PROP_DEFS[p.id];
      assert.equal(def.kit, p.kit);
      assert.equal(def.v, p.v);
      if (def.wall) {
        assert.ok(p.s >= 0.95 && p.s <= 1.05);
        assert.ok(Math.abs(p.minZ - (sock.z - PROPS.WALL_SOCKET_OFFSET_M)) < 1e-6, 'fixture back on the mounting plane');
        assert.ok(p.maxX - p.minX <= sock.w + 1e-6);
        continue;
      }
      assert.ok(p.s >= PROPS.SCALE_MIN - 1e-9 && p.s <= PROPS.SCALE_MAX + 1e-9, 'scale 0.88–1.12');
      assert.ok(Math.abs(p.yaw) <= PROPS.JITTER_YAW_RAD + 1e-9, 'yaw ±12°');
      assert.equal(p.y0, sock.y, 'flush on the floor');
      assert.ok(p.minZ >= sock.z - 1e-6 && p.maxZ <= sock.z + sock.depth + 1e-6, 'within the free depth');
      const half = sock.slot === 'BAY' ? sock.w / 2 : sock.w / 2;
      assert.ok(p.minX >= sock.x - half - 1e-6 && p.maxX <= sock.x + half + 1e-6, 'within the free width');
      if (sock.low) assert.ok(p.y1 - p.y0 <= PROPS.LOW_MAX_H + 1e-6, 'low on wall-run faces');
    }
    // Floor props never reach a same-door wall fixture they share the wall with.
    for (const d of res.doors) {
      const side = d.props.find((p) => p.slot === 'WALL_SIDE');
      if (!side) continue;
      for (const p of d.props) {
        if (p.slot !== 'FLOOR_L' && p.slot !== 'FLOOR_R') continue;
        if (p.maxX > side.minX + 0.01 && p.minX < side.maxX - 0.01) assert.ok(p.y1 <= side.y0 - 0.04 + 1e-6, 'floor prop below the fixture');
      }
    }
    return props.length;
  };
  let n = 0;
  for (let seed = 0; seed < 25; seed++) {
    n += check(gallerySockets(seed, 1, 0).sockets);
    for (const program of GROUND_PROGRAMS) {
      n += check(streetSockets(program, seed, 2, 0).sockets);
      n += check(streetSockets(program, seed + 100, 2, 0, { reach: 0.75, low: true }).sockets);
    }
  }
  assert.ok(n > 1500, `${n} props checked`);
});

test('9B doorClearZones: no socket prop or clutter item inside any 1.8 × 1.8 m door zone', () => {
  for (let seed = 0; seed < 30; seed++) {
    // Gallery decks (zones carry their deck height).
    const g = gallerySockets(seed, 4, 0);
    // The zone is the walk-in space: nothing in it below head height (the room plaque above the lintel is fine).
    const headroom = (p: PropInstance, zy: number): boolean => p.y1 > zy + 0.01 && p.y0 < zy + 2.1;
    for (const p of composeSockets(g.sockets).doors.flatMap((d) => d.props)) {
      for (const z of g.zones) if (headroom(p, z.y)) assert.ok(!overlaps(p, z, 1e-6), 'gallery prop in a door zone');
    }
    // Street faces: socket props + sidewalk clutter forbidden from the zones.
    for (const program of GROUND_PROGRAMS) {
      const s = streetSockets(program, seed * 3 + 1, 5, 0);
      const res = composeSockets(s.sockets);
      const props = [...res.bays, ...res.doors.flatMap((d) => d.props)];
      for (const p of props) for (const z of s.zones) if (headroom(p, 0)) assert.ok(!overlaps(p, z, 1e-6), `${program} prop in a door zone`);
      const strip: ClutterStrip = { kind: 'SERVICE', ax: 'x', a0: -9.4, a1: 9.4, line: F.plane, sg: 1, d0: 0.42, d1: 1.62, run: false, y: 0, seed: seed / 31, spacing: 2.2 };
      const clutter = planClutter({ strips: [strip], forbid: s.zones, spawns: [], occupied: props.filter((p) => p.y0 < 1).map(toAabb) });
      for (const it of clutter.items) {
        for (const z of s.zones) assert.ok(!overlaps(it, z, 1e-6), 'clutter in a door zone');
        for (const p of props) assert.ok(!(it.maxX > p.minX && it.minX < p.maxX && it.maxZ > p.minZ && it.minZ < p.maxZ && it.y1 > p.y0 && it.y0 < p.y1), 'clutter overlaps a socket prop');
      }
    }
  }
});

test('9B-2 alleys keep a ≥ 2.6 m clear centre path; collidable / tall clutter stays out of wall-run strips', () => {
  let dumpsters6 = 0;
  for (const W of [4, 5, 6, 7, 8, 10]) {
    for (const service of [null, 0, 1] as const) {
      for (let seed = 0; seed < 8; seed++) {
        const al = { axis: 'x' as const, gap0: 20, gap1: 20 + W, ov0: -15, ov1: 15 };
        const res = planClutter({ strips: alleyStrips(al, (seed + 1) / 11, 0.26, service), forbid: [], spawns: [], occupied: [] });
        const band = alleyCentreBand(al);
        assert.ok(band.x1 - band.x0 >= PROPS.ALLEY_CLEAR_M - 1e-9);
        for (const it of res.items) {
          assert.ok(!overlaps(it, band, 1e-6), `W ${W}: clutter in the clear centre path`);
          assert.ok(it.minX >= al.gap0 - 1e-6 && it.maxX <= al.gap1 + 1e-6, 'inside the alley');
          const def = PROP_DEFS[it.id];
          const tall = def.colliderH > 0 || it.y1 - it.y0 > PROPS.LOW_MAX_H;
          // Run walls: x = gap0 unless it is the service side 0; x = gap1 unless service side 1.
          if (tall && service !== 0 && it.minX < al.gap0 + PROPS.RUN_STRIP_M - 1e-6) assert.fail(`W ${W}: ${it.id} in the gap0 run strip`);
          if (tall && service !== 1 && it.maxX > al.gap1 - PROPS.RUN_STRIP_M + 1e-6) assert.fail(`W ${W}: ${it.id} in the gap1 run strip`);
          if (W === 6 && def.kit === 'DUMPSTER') dumpsters6++;
        }
        for (const c of res.colliders) {
          const dx = c.maxX - c.minX;
          const dz = c.maxZ - c.minZ;
          const dy = c.maxY - c.minY;
          const isDump = Math.abs(dy - 1.1) < 1e-9;
          if (isDump) assert.ok(Math.abs(Math.max(dx, dz) - 1.8) < 1e-6 && Math.abs(Math.min(dx, dz) - 1.15) < 1e-6, 'dumpster cover AABB 1.80 × 1.15 × 1.10');
        }
      }
    }
  }
  assert.ok(dumpsters6 > 0, 'a 6 m alley with a service side gets dumpsters');
});

test('9B-2 forbidden rects, spawn clearance and determinism', () => {
  const strip: ClutterStrip = { kind: 'UNDERPASS', ax: 'z', a0: -20, a1: 20, line: 3, sg: 1, d0: 0.15, d1: 1.7, run: false, y: 0, seed: 0.37, spacing: 1.5 };
  const forbid: Rect[] = [{ x0: 2, x1: 8, z0: -4, z1: 4 }];
  const spawns = [{ x: 4, z: 12 }];
  const a = planClutter({ strips: [strip], forbid, spawns, occupied: [] });
  const b = planClutter({ strips: [strip], forbid, spawns, occupied: [] });
  assert.deepEqual(a, b, 'deterministic');
  assert.ok(a.items.length > 5);
  for (const it of a.items) assert.ok(!overlaps(it, forbid[0], 1e-6), 'crosswalk / junction / ramp rect respected');
  for (const it of a.items) {
    if (PROP_DEFS[it.id].colliderH > 0) {
      const m = PROPS.SPAWN_CLEAR_M;
      assert.ok(!(spawns[0].x > it.minX - m && spawns[0].x < it.maxX + m && spawns[0].z > it.minZ - m && spawns[0].z < it.maxZ + m), 'cover clear of spawns');
    }
  }
  // Jersey barriers / dumpsters / bench seats register exact colliders; soft clutter none.
  const coll = a.items.filter((it) => PROP_DEFS[it.id].colliderH > 0);
  assert.equal(a.colliders.length, coll.length);
  coll.forEach((it, i) => {
    assert.ok(Math.abs(a.colliders[i].maxY - a.colliders[i].minY - PROP_DEFS[it.id].colliderH) < 1e-9);
    assert.ok(Math.abs(it.yaw % (Math.PI / 2)) < 1e-9, 'collidables are axis-aligned');
  });
});

test('9B-2 L_SHAPE courtyard clutter stays inside the courtyard cut, on the ground', () => {
  for (let s = 0; s < 20; s++) {
    const c: MassingCandidate = { arch: ARCH_B, lot: { x0: 5, z0: -7, x1: 5 + 20 + (s % 5) * 2, z1: -7 + 20 + (s % 3) * 3 }, roofY: 30, alley: new Set(s % 2 ? ['x:-1'] : ['z:1']) };
    const p = planMassing('L_SHAPE', c, createRng(700 + s));
    const cut = p.cut as Rect;
    const strips: ClutterStrip[] = p.faces
      .filter((f) => f.court && f.y0 < 0.01)
      .map((f, i) => ({ kind: 'COURT' as const, ax: f.ax === 'x' ? ('z' as const) : ('x' as const), a0: f.a0 + 0.6, a1: f.a1 - 0.6, line: f.plane, sg: f.sg, d0: 0.42, d1: Math.min(2.4, Math.min(cut.x1 - cut.x0, cut.z1 - cut.z0) - 1), run: false, y: 0, seed: (s * 7 + i) / 97, spacing: 2.5 }));
    assert.ok(strips.length >= 2, 'two courtyard walls');
    const res = planClutter({ strips, forbid: [], spawns: [], occupied: [] });
    for (const it of res.items) {
      assert.equal(it.y0, 0, 'on the ground');
      assert.ok(it.minX >= cut.x0 - 1e-6 && it.maxX <= cut.x1 + 1e-6 && it.minZ >= cut.z0 - 1e-6 && it.maxZ <= cut.z1 + 1e-6, 'inside the courtyard');
    }
  }
});

test('9B-3 decals: flush +0.032 m on their surface, inside it, capped at 340, deterministic', () => {
  const surfaces: DecalSurface[] = [];
  for (let i = 0; i < 400; i++) surfaces.push({ kind: (['SHUTTER', 'PIER', 'HWPIER', 'DUMPSTER', 'WALL'] as const)[i % 5], nAx: i % 2 ? 'x' : 'z', sg: i % 3 ? 1 : -1, plane: i * 0.5, a0: -1, a1: i % 5 === 1 ? -0.6 : 2.6, y0: 0.4, y1: 3.2, seed: (i * 37 % 101) / 101 });
  const d1 = planDecals(surfaces);
  assert.deepEqual(d1, planDecals(surfaces));
  assert.ok(d1.length <= PROPS.CAP.DECAL && d1.length > 200);
  for (const d of d1) {
    const sf = surfaces.find((s) => Math.abs((s.nAx === 'x' ? d.x : d.z) - (s.plane + s.sg * PROPS.DECAL_OFFSET_M)) < 1e-9 && s.nAx === (d.nx !== 0 ? 'x' : 'z')) as DecalSurface;
    assert.ok(sf, 'sits 0.032 m off a surface');
    const a = sf.nAx === 'x' ? d.z : d.x;
    assert.ok(a - d.w / 2 >= sf.a0 - 1e-6 && a + d.w / 2 <= sf.a1 + 1e-6 && d.y - d.h / 2 >= sf.y0 - 1e-6 && d.y + d.h / 2 <= sf.y1 + 1e-6, 'inside the surface');
    assert.ok(d.cell >= 0 && d.cell < 8);
  }
});

test('9B kits: 10 instanced meshes (consolidated debris + contact shadows), every catalogue variant present, plan capacities', () => {
  const kits = new CityPropMeshes(new THREE.Texture(), new THREE.Texture(), () => {});
  assert.equal(kits.meshes.length, 10);
  assert.deepEqual(
    kits.meshes.map((m) => m.name),
    ['SocketPottedPlants', 'SocketStorageCrates', 'SocketWallFixtures', 'SocketMiscProps', 'ClutterDebrisKit', 'ClutterDumpsters', 'ClutterBenches', 'ClutterScrapBarriers', 'GraffitiDecals', 'PropContactShadows'],
  );
  assert.deepEqual(KIT_CAP, { PLANTS: 260, STORAGE: 360, FIXTURES: 420, MISC: 220, DEBRIS: 480, DUMPSTER: 65, BENCH: 110, SCRAP: 200 });
  KIT_IDS.forEach((k, i) => {
    const m = kits.meshes[i];
    assert.equal(m.count, 0);
    const vars = new Set(Array.from((m.geometry.getAttribute('aVar') as THREE.BufferAttribute).array as Float32Array));
    for (const id of Object.keys(PROP_DEFS) as PropId[]) if (PROP_DEFS[id].kit === k) assert.ok(vars.has(PROP_DEFS[id].v), `${id} variant in ${m.name}`);
    for (const a of ['color', 'aAo', 'aVar', 'aPart', 'aUv', 'aInst', 'aTint']) assert.ok(m.geometry.getAttribute(a), `${m.name}.${a}`);
    // Lean kits: the shader runs every variant's vertices per instance.
    assert.ok((m.geometry.getAttribute('position') as THREE.BufferAttribute).count < 4000, `${m.name} vertex budget`);
  });
  const { sockets } = gallerySockets(3, 1, 0);
  const res = composeSockets(sockets);
  const props = res.doors.flatMap((d) => d.props);
  const st = kits.commit(props, planDecals([{ kind: 'SHUTTER', nAx: 'z', sg: 1, plane: 0, a0: 0, a1: 3.5, y0: 0.3, y1: 3, seed: 0.1 }]));
  assert.equal(Object.values(st.counts).reduce((a, b) => a + b, 0), props.length);
  assert.equal(kits.meshes[2].count, props.filter((p) => p.kit === 'FIXTURES').length);
});
