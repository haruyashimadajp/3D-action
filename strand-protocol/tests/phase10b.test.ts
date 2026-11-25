/**
 * Phase 10B: zero empty lots, English-only signage, sign / Mega-Billboard non-overlap, FaceSpan-bound screens,
 * four cyber megastructures, per-sector identities, proximity-only lockdown barrier.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as THREE from 'three';
import { LEVEL } from '../src/config/constants';
import { MEGA_STRUCTURE_KINDS, SECTORS } from '../src/config/skills';
import { MEGA_ATLAS, type PbrTextureSet, type ProceduralTextureLibrary } from '../src/engine/ProceduralTextures';
import {
  BARRIER_FAR_M,
  BARRIER_NEAR_M,
  CityBuilder,
  FAR_INNER,
  SIGN_MARGIN_M,
  SIGN_THICK_M,
  type MegaBillboardRecord,
  type NeonSignRecord,
  type SectorLayout,
} from '../src/world/CityBuilder';
import { PhysicsWorld } from '../src/world/PhysicsWorld';

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

const CITY = new CityBuilder(mockTextures());
/** Built sectors + the merged-mesh census of each (the megastructures must add zero draw calls). */
const SECTOR_DATA: Array<{ layout: SectorLayout; meshNames: string[] }> = [];
for (let s = 1; s <= SECTORS.length; s++) {
  const layout = CITY.buildSector(s, 0);
  const meshNames: string[] = [];
  CITY.root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) meshNames.push(o.name);
  });
  SECTOR_DATA.push({ layout, meshNames: meshNames.sort() });
}
const ALL = SECTOR_DATA.map((d) => d.layout);
const H = LEVEL.HALF_EXTENT_M;

/** Same padded world AABB as the CityBuilder guard: plane of width w along (nz, −nx), thickness along (nx, nz). */
function signBox(r: { x: number; y: number; z: number; nx: number; nz: number; w: number; h: number }) {
  const len = Math.hypot(r.nx, r.nz) || 1;
  const ux = Math.abs(r.nx / len);
  const uz = Math.abs(r.nz / len);
  const hx = (uz * r.w + ux * SIGN_THICK_M) / 2 + SIGN_MARGIN_M;
  const hz = (ux * r.w + uz * SIGN_THICK_M) / 2 + SIGN_MARGIN_M;
  const hy = r.h / 2 + SIGN_MARGIN_M;
  return { x0: r.x - hx, x1: r.x + hx, y0: r.y - hy, y1: r.y + hy, z0: r.z - hz, z1: r.z + hz };
}

test('10B-2 100 % English signage: zero Japanese characters in ProceduralTextures.ts and English ad titles', () => {
  const src = readFileSync('src/engine/ProceduralTextures.ts', 'utf8');
  // Hiragana, katakana (incl. half-width), CJK ideographs + extension A, CJK symbols, full-width forms.
  const jp = /[　-〿぀-ゟ゠-ヿㇰ-ㇿ㐀-䶿一-鿿豈-﫿＀-￯]/u;
  const hits = src.split('\n').map((l, i) => [i + 1, l] as const).filter(([, l]) => jp.test(l));
  assert.equal(hits.length, 0, `Japanese characters found: ${hits.map(([n, l]) => `L${n}: ${l.trim().slice(0, 60)}`).join(' | ')}`);
  assert.ok(!/Hiragino|Noto Sans CJK|Noto Sans JP|Yu Gothic|Meiryo/.test(src), 'no Japanese font fallbacks for in-world signs');
  assert.equal(MEGA_ATLAS.W, 2048);
  assert.equal(MEGA_ATLAS.H, 1024);
  assert.equal(MEGA_ATLAS.TITLES.length, 8);
  for (const t of MEGA_ATLAS.TITLES) assert.match(t, /^[A-Z0-9 /\-+.:!]+$/, `ad title "${t}" is uppercase English`);
  for (const needle of ['NEO-TOKYO', 'DATA FLOW', 'CYBERNETICS', 'BELOW', 'RESTRICTED ZONE', 'KIROSHI', 'SYNTH NOODLES', 'SOFTSYS', 'HOTEL KOWLOON', 'NOODLE 24H', "'NEO'", "'09'"]) {
    assert.ok(src.includes(needle), `English copy "${needle}" present`);
  }
});

test('10B-1 every district builds >= 92 % of its lots; at most one covered market; perimeter skyline >= 36 m', () => {
  for (const L of ALL) {
    const s = L.stats.lots;
    assert.ok(s.fill >= 0.92, `S${L.sector.index} lot fill ${(s.fill * 100).toFixed(1)} % (${s.built}/${s.generated})`);
    assert.ok(s.fill >= 0.9, 'and therefore >= 90 %');
    assert.ok(s.built >= L.sector.buildingCount, `S${L.sector.index} buildingCount is a minimum`);
    assert.equal(s.built + s.market, s.generated, `S${L.sector.index}: every lot is a tower or the market (zero barren lots)`);
    assert.ok(s.market <= 1 && L.marketRects.length === s.market, 'at most one open pocket per district');
    if (s.market) assert.ok(s.marketStalls >= 6, `S${L.sector.index} market is a dense covered street-market (${s.marketStalls} stalls)`);
    for (const b of L.buildings) {
      const ext = Math.max(Math.abs(b.cx) + b.halfW, Math.abs(b.cz) + b.halfD);
      // Perimeter lots (touching the ±H wall band) rise ≥ 36 m.
      if (ext > H - 6 + 1e-6) assert.ok(b.roofY >= 36, `S${L.sector.index} perimeter tower ${b.index} roof ${b.roofY} m`);
    }
  }
  assert.ok(ALL.some((L) => L.stats.lots.market === 1), 'at least one district turns its pocket into a market');
});

test('10B-1 inner far-tower ring 115–220 m, outside the lockdown square, heights 55–180 m (blimp-clamped)', () => {
  for (const L of ALL) {
    const inner = L.farTowersInfo.filter((t) => {
      const r = Math.hypot(t.x, t.z);
      return r >= FAR_INNER.R_MIN && r <= FAR_INNER.R_MAX;
    });
    assert.ok(inner.length >= 20, `S${L.sector.index}: ${inner.length} inner-ring far towers`);
    for (const t of L.farTowersInfo) {
      assert.ok(Math.max(Math.abs(t.x) - t.w / 2, Math.abs(t.z) - t.d / 2) >= H + 6 - 1e-6, `S${L.sector.index} far tower at (${t.x.toFixed(0)}, ${t.z.toFixed(0)}) stays outside the district`);
    }
    for (const t of inner) assert.ok(t.top <= FAR_INNER.H_MAX + 1e-6 && t.top > 0, `inner tower height ${t.top}`);
  }
});

test('10B-2 zero overlapping neon signs or Mega-Billboards across all 5 sectors (0.35 m padded 3D AABBs)', () => {
  for (const L of ALL) {
    const items: Array<{ box: ReturnType<typeof signBox>; group: number; tag: string }> = [];
    L.neonSignRecords.forEach((r: NeonSignRecord, i) => items.push({ box: signBox(r), group: -1, tag: `${r.kind}#${i}` }));
    L.megaBillboards.forEach((r: MegaBillboardRecord, i) => items.push({ box: signBox(r), group: r.group, tag: `MEGA-${r.kind}#${i}` }));
    assert.ok(L.megaBillboards.length > 0, `S${L.sector.index} has Mega-Billboards`);
    let overlaps = 0;
    const examples: string[] = [];
    for (let i = 0; i < items.length; i++) {
      const a = items[i].box;
      for (let j = i + 1; j < items.length; j++) {
        if (items[i].group >= 0 && items[i].group === items[j].group) continue;
        const b = items[j].box;
        if (a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0 && a.z0 < b.z1 && a.z1 > b.z0) {
          overlaps++;
          if (examples.length < 4) examples.push(`${items[i].tag} × ${items[j].tag}`);
        }
      }
    }
    assert.equal(overlaps, 0, `S${L.sector.index}: ${overlaps} overlapping signs (${examples.join(', ')})`);
  }
});

test('10B-2 zero floating Mega-Billboards: every screen is bound to a solid FaceSpan (rings to their cylinder)', () => {
  const EPS = 1e-3;
  const kinds = new Set<string>();
  for (const L of ALL) {
    const S = L.megaBillboards;
    assert.ok(S.length <= 140, `S${L.sector.index} Mega-Billboards within cap (${S.length})`);
    for (const r of S) {
      kinds.add(r.kind);
      const tag = `S${L.sector.index} ${r.kind} on building ${r.building} at (${r.x.toFixed(2)}, ${r.y.toFixed(2)}, ${r.z.toFixed(2)})`;
      const b = L.buildings[r.building];
      assert.ok(b, `${tag}: host building exists`);
      if (r.kind === 'RING') {
        assert.equal(b.massing, 'CYLINDER_RING_TOWER', `${tag}: ring segments only on cylinder towers`);
        const R = b.cylR as number;
        const dx = r.x - b.cx;
        const dz = r.z - b.cz;
        const dist = Math.hypot(dx, dz);
        assert.ok(Math.abs(dist - (R * Math.cos(Math.PI / 12) + r.standoff)) < 0.02, `${tag}: segment sits ${r.standoff} m off the facet`);
        assert.ok((dx * r.nx + dz * r.nz) / dist > 0.999, `${tag}: segment faces radially out`);
        assert.ok(r.y - r.h / 2 >= 8 && r.y + r.h / 2 <= b.roofY, `${tag}: within the shaft height`);
        continue;
      }
      const spans = L.buildingSpans[r.building];
      if (r.kind === 'BLADE') {
        const wallAx = Math.abs(r.nx) > 0.5 ? 'z' : 'x';
        const along = wallAx === 'x' ? r.z : r.x;
        const perp = wallAx === 'x' ? r.x : r.z;
        const ok = spans.some((sp) => {
          if (sp.ax !== wallAx) return false;
          if (r.y - r.h / 2 < sp.y0 + 0.4 - EPS || r.y + r.h / 2 > sp.y1 - 0.4 + EPS) return false;
          if (along < sp.a0 + 0.3 - EPS || along > sp.a1 - 0.3 + EPS) return false;
          const innerGap = (perp - sp.plane) * sp.sg - r.w / 2;
          return innerGap >= -0.05 && innerGap <= 0.5;
        });
        assert.ok(ok, `${tag}: blade anchored to a solid FaceSpan`);
        assert.ok(r.w >= 3.2 - EPS && r.w <= 4.5 + EPS && r.h >= 18 - EPS && r.h <= 38 + EPS, `${tag}: blade ${r.w.toFixed(1)} × ${r.h.toFixed(1)} m`);
        continue;
      }
      // Flat screens (avenue / perimeter / L-corner halves): flush on a solid span of the face they cover.
      const ax = Math.abs(r.nx) > 0.5 ? 'x' : 'z';
      const sg = ax === 'x' ? Math.sign(r.nx) : Math.sign(r.nz);
      const along = ax === 'x' ? r.z : r.x;
      const perp = ax === 'x' ? r.x : r.z;
      const a0 = along - r.w / 2;
      const a1 = along + r.w / 2;
      const ok = spans.some((sp) => {
        if (sp.ax !== ax || sp.sg !== sg) return false;
        if (r.y - r.h / 2 < sp.y0 + 0.4 - EPS || r.y + r.h / 2 > sp.y1 - 0.4 + EPS) return false;
        const d = (perp - sp.plane) * sg;
        if (d < 0.05 || d > 0.6) return false;
        if (r.kind !== 'CORNER') return a0 >= sp.a0 + 0.3 - EPS && a1 <= sp.a1 - 0.3 + EPS;
        // L-corner halves run out to the outer corner: one end may overhang the span end by the stand-off only,
        // and only where the perpendicular face of the same tower continues (a solid corner, not a free edge).
        const overLo = sp.a0 - a0;
        const overHi = a1 - sp.a1;
        const inner = overLo > EPS ? a1 <= sp.a1 - 0.3 + EPS : a0 >= sp.a0 + 0.3 - EPS;
        const over = Math.max(overLo, overHi);
        const cornerA = overLo > EPS ? sp.a0 : sp.a1;
        const perpAx = ax === 'x' ? 'z' : 'x';
        const corner = spans.some((o) => o.ax === perpAx && Math.abs(o.plane - cornerA) < EPS && r.y - r.h / 2 >= o.y0 - EPS && r.y + r.h / 2 <= o.y1 + EPS);
        return inner && over <= r.standoff + 0.05 && corner;
      });
      assert.ok(ok, `${tag}: screen bound to a solid FaceSpan`);
      if (r.kind === 'AVENUE' || r.kind === 'PERIMETER') {
        assert.ok(r.w >= 10 - EPS && r.w <= 20 + EPS && r.h >= 10 - EPS && r.h <= 34 + EPS, `${tag}: giant screen ${r.w.toFixed(1)} × ${r.h.toFixed(1)} m`);
      }
    }
    // L-corner wraps: synchronized pairs (two perpendicular halves per tier, same ad cell, 2–4 tiers).
    const groups = new Map<number, MegaBillboardRecord[]>();
    for (const r of S) if (r.kind === 'CORNER') groups.set(r.group, [...(groups.get(r.group) ?? []), r]);
    for (const [g, pieces] of groups) {
      assert.ok(pieces.length % 2 === 0 && pieces.length >= 4 && pieces.length <= 8, `S${L.sector.index} corner group ${g}: ${pieces.length} pieces (2–4 tiers × 2)`);
      assert.equal(new Set(pieces.map((p) => p.cell)).size, 1, 'one synchronized ad per wrap');
      assert.ok(pieces.some((p) => Math.abs(p.nx) === 1) && pieces.some((p) => Math.abs(p.nz) === 1), 'two perpendicular faces (90° wrap)');
    }
  }
  for (const k of ['AVENUE', 'CORNER', 'BLADE', 'RING']) assert.ok(kinds.has(k), `format ${k} placed somewhere`);
});

test('10B-3 all four megastructures exist, are solid / passable as designed and add zero draw calls', () => {
  const physics = new PhysicsWorld();
  const totals: Record<string, number> = {};
  for (const L of ALL) for (const [k, n] of Object.entries(L.stats.megastructures)) totals[k] = (totals[k] ?? 0) + n;
  for (const k of MEGA_STRUCTURE_KINDS) assert.ok(totals[k] >= 1, `${k} built somewhere (${totals[k] ?? 0})`);
  for (const L of ALL) {
    physics.setLayout(L);
    for (const b of L.buildings) {
      const own = L.colliders.filter((c) => c.building === b.index && c.kind === 'BUILDING');
      if (b.massing === 'TWIN_ARCH_GATE') {
        const v = b.voidBox!;
        const vw = Math.min(v.x1 - v.x0, v.z1 - v.z0);
        assert.ok(vw >= 6 - 1e-6 && vw <= 8 + 1e-6, `void ${vw.toFixed(2)} m wide (6–8 m)`);
        // Grapple-passable: a straight flight line through the void (mid-height) from street side to street side.
        const alongX = v.x1 - v.x0 > v.z1 - v.z0;
        const y = (v.y0 + v.y1) / 2;
        const a = alongX ? new THREE.Vector3(v.x0 - 3, y, (v.z0 + v.z1) / 2) : new THREE.Vector3((v.x0 + v.x1) / 2, y, v.z0 - 3);
        const c = alongX ? new THREE.Vector3(v.x1 + 3, y, (v.z0 + v.z1) / 2) : new THREE.Vector3((v.x0 + v.x1) / 2, y, v.z1 + 3);
        assert.ok(physics.lineOfSight(a, c, 0), `S${L.sector.index} twin arch ${b.index}: open void is grapple-passable`);
        assert.ok(v.y1 - v.y0 >= 12, `void ${(v.y1 - v.y0).toFixed(1)} m tall`);
        // The sky-arch bridge closes the top 12 m; anchors hang under it.
        assert.ok(own.some((o) => o.min.y >= v.y1 - 1e-6 && o.max.y >= b.roofY - 1e-6), 'bridge box above the void');
        assert.ok(L.anchors.some((an) => an.position.y < v.y1 && an.position.y > v.y1 - 2 && an.position.x > Math.min(v.x0, v.x1) - 2 && an.position.x < v.x1 + 2 && an.position.z > v.z0 - 2 && an.position.z < v.z1 + 2), 'grapple anchor under the soffit');
      } else if (b.massing === 'CYLINDER_RING_TOWER') {
        assert.ok(b.cylR! >= 6.5 - 1e-6 && b.cylR! <= 9.5 + 1e-6, `cylinder radius ${b.cylR}`);
        assert.ok(b.roofY - 8 >= 38 - 1e-6 && b.roofY - 8 <= 84 + 1e-6, `cylinder shaft ${b.roofY - 8} m tall`);
        assert.ok(own.filter((o) => o.min.y >= 8 - 1e-6).length >= 3, 'circumscribed collider cross on the 8 m podium');
        const rings = L.megaBillboards.filter((r) => r.kind === 'RING' && r.building === b.index);
        assert.ok(rings.length >= 36 && rings.length % 12 === 0, `3–4 tiered ad rings of 12 segments (${rings.length})`);
      } else if (b.massing === 'SLANT_CORP_TOWER') {
        assert.ok(b.roofY >= 44, 'slant monolith ≥ 44 m');
        assert.ok(L.ramps.some((rp) => Math.min(rp.yStart, rp.yEnd) === b.roofY && Math.max(rp.yStart, rp.yEnd) === b.roofY + (b.slantH as number)), 'walkable sloped crown cap over the flat sniper deck');
      } else if (b.massing === 'X_TRUSS_TOWER') {
        assert.ok(b.roofY >= 44 && b.roofY <= 92, `truss tower ${b.roofY} m`);
        assert.ok(own.length >= 3, 'shaft + two crown tiers');
      }
    }
  }
  // +0 draw calls: every district commits exactly the same set of merged meshes, megastructures or not.
  const ref = SECTOR_DATA[1].meshNames.join('|');
  for (const d of SECTOR_DATA) assert.equal(d.meshNames.join('|'), ref, `S${d.layout.sector.index} mesh set`);
  assert.equal(SECTOR_DATA[0].meshNames.filter((n) => n === 'MegaBillboards').length, 1, 'MegaBillboards is one InstancedMesh (+1 call)');
});

test('10B-4 five distinct sector identities: names, palettes, megastructure quotas, massing minimums', () => {
  const names = ['NEON DOWNTOWN', 'KOWLOON CANAL', 'INDUSTRIAL INTERCHANGE', 'MEGA-PLAZA OVERDRIVE', 'VALKYRIE CITADEL'];
  const palettes = new Set<string>();
  ALL.forEach((L, i) => {
    const id = L.sector.identity;
    assert.equal(L.stats.identity, names[i]);
    assert.deepEqual([...L.stats.palette], [...id.palette], 'layout carries the district palette');
    assert.ok(id.palette.length >= 3, 'palette of ≥ 3 neon hues');
    palettes.add([...id.palette].sort().join(','));
    for (const [k, n] of Object.entries(id.megastructures)) assert.equal(L.stats.megastructures[k], n, `S${L.sector.index} ${k} quota`);
    for (const [k, n] of Object.entries(id.minMassings)) assert.ok((L.stats.massings[k] ?? 0) >= (n as number), `S${L.sector.index} ≥ ${n} ${k} (${L.stats.massings[k]})`);
  });
  assert.equal(palettes.size, 5, 'five distinct palettes');
  // Signature traits.
  assert.ok(ALL[0].stats.megastructures.TWIN_ARCH_GATE >= 1 && ALL[0].stats.massings.GALLERY_DANCHI >= 2, 'S1 twin arch + galleries');
  assert.ok(ALL[1].stats.massings.GALLERY_DANCHI >= 4 && ALL[1].stats.massings.L_SHAPE >= 2, 'S2 dense galleries + L markets');
  assert.ok(ALL[2].stats.megastructures.X_TRUSS_TOWER >= 2 && ALL[2].stats.massings.PENCIL_TOWER >= 5, 'S3 truss exoskeletons + pencil shafts');
  assert.ok(ALL[3].stats.megastructures.CYLINDER_RING_TOWER >= 1 && ALL[3].stats.megastructures.TWIN_ARCH_GATE >= 1, 'S4 cylinders + arch gate');
  assert.ok(ALL[3].stats.megaBillboards.corner >= Math.max(...ALL.map((L) => L.stats.megaBillboards.corner)) - 1, 'S4 among the densest L-corner wraps');
  assert.ok(ALL[4].stats.megastructures.SLANT_CORP_TOWER >= 2 && ALL[4].stats.megastructures.X_TRUSS_TOWER >= 2, 'S5 ring of slant + truss monoliths');
  assert.ok(ALL[4].megaBillboards.filter((r) => r.kind === 'BLADE' && r.cell === 4).length >= 3, 'S5 crimson monolith blades frame the arena');
});

test('10B-1 / 10B-2 LockdownBarrier proximity fade (0 beyond 14 m) and mist halos packed into lampHalos', () => {
  assert.equal(BARRIER_NEAR_M, 3);
  assert.equal(BARRIER_FAR_M, 14);
  const fade = (d: number): number => {
    const t = Math.min(1, Math.max(0, (d - BARRIER_NEAR_M) / (BARRIER_FAR_M - BARRIER_NEAR_M)));
    return 1 - t * t * (3 - 2 * t);
  };
  assert.equal(fade(14.01), 0);
  assert.equal(fade(60), 0);
  assert.equal(fade(3), 1);
  assert.ok(fade(8) > 0 && fade(8) < 1);
  let barrier: THREE.Mesh | null = null;
  let halos: THREE.InstancedMesh | null = null;
  let mega: THREE.InstancedMesh | null = null;
  CITY.root.traverse((o) => {
    if (o.name === 'LockdownBarrier') barrier = o as THREE.Mesh;
    if (o.name === 'LampHalos') halos = o as THREE.InstancedMesh;
    if (o.name === 'MegaBillboards') mega = o as THREE.InstancedMesh;
  });
  assert.ok(barrier && halos && mega);
  const fs = ((barrier as THREE.Mesh).material as THREE.ShaderMaterial).fragmentShader;
  assert.ok(fs.includes('smoothstep(3.0, 14.0, dist)'), 'barrier shader fades over 3 → 14 m');
  assert.ok(/mix\(locked \* prox, open, uGateOpen\)/.test(fs), 'the open emerald gate stays visible from anywhere');
  const L = ALL[ALL.length - 1];
  const h = halos as THREE.InstancedMesh;
  assert.equal(h.count, L.stats.lamps + L.stats.megaBillboards.mists, 'lamp + mist halos in ONE instanced draw');
  assert.ok(L.stats.megaBillboards.mists > 0 && L.stats.megaBillboards.mists <= 90, 'mist halos within the +90 budget');
  const attr = h.geometry.getAttribute('aHalo') as THREE.InstancedBufferAttribute;
  let mistR = 0;
  for (let i = L.stats.lamps; i < h.count; i++) mistR = Math.max(mistR, attr.getW(i));
  assert.ok(mistR >= 8 && mistR <= 16, `mist radius ${mistR}`);
  assert.equal((mega as THREE.InstancedMesh).count, L.stats.megaBillboards.total);
});
