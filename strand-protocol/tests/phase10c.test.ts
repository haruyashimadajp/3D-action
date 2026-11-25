/**
 * Phase 10C: lofted hero vehicles, recessed vending kiosks, detailed lamps, StreetFurnishingsKit (+1 draw call) and the
 * dense streetscape — HERO_3D_MODELING_SPEC §6 assertions (non-brick silhouette, ground contact, triangle budgets).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as THREE from 'three';
import { SECTORS } from '../src/config/skills';
import { VENDING_ATLAS, type PbrTextureSet, type ProceduralTextureLibrary } from '../src/engine/ProceduralTextures';
import { CityBuilder, type NeonSignRecord, type SectorLayout } from '../src/world/CityBuilder';
import {
  FURNITURE_TRI_BUDGET,
  KIT_CAP,
  KIT_VARIANT,
  buildFurnishingsKit,
  buildLampGeometry,
  buildVendingGeometry,
  kitVariantTris,
} from '../src/world/CityFurniture';
import { CAR_DIMS, CAR_TRI_BUDGET, buildCarVariant, loftSymHull, triCount } from '../src/world/CityVehicles';

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
    glove: mockPbr(),
    gun: mockPbr(),
  };
}

const attr = (g: THREE.BufferGeometry, name: string): ArrayLike<number> => g.getAttribute(name).array as ArrayLike<number>;
function bbox(g: THREE.BufferGeometry): THREE.Box3 {
  g.computeBoundingBox();
  return g.boundingBox as THREE.Box3;
}

// =============================================================================================
// loftSymHull (spec §0)
// =============================================================================================
test('10C-1 loftSymHull: closed mirrored loft, outward normals, hard creases split / smooth curves averaged', () => {
  const S = [
    { z: 2, pts: [[0, 0], [0.8, 0], [1, 0.5], [0.6, 1], [0, 1.1]] as const },
    { z: 0, pts: [[0, 0], [1, 0], [1.2, 0.5], [0.8, 1.1], [0, 1.2]] as const },
    { z: -2, pts: [[0, 0], [0.9, 0], [1, 0.5], [0.6, 1], [0, 1.05]] as const },
  ];
  const g = loftSymHull(S);
  const N = 2 * 5 - 2;
  assert.equal(triCount(g), (S.length - 1) * N * 2 + 2 * N, 'quad strips + two flat caps');
  const pos = attr(g, 'position');
  const nor = attr(g, 'normal');
  // Mirror symmetry: every vertex has a mirrored partner.
  const keys = new Set<string>();
  for (let i = 0; i < pos.length; i += 3) keys.add(`${pos[i].toFixed(4)},${pos[i + 1].toFixed(4)},${pos[i + 2].toFixed(4)}`);
  for (let i = 0; i < pos.length; i += 3) assert.ok(keys.has(`${(-pos[i]).toFixed(4).replace('-0.0000', '0.0000')},${pos[i + 1].toFixed(4)},${pos[i + 2].toFixed(4)}`) || Math.abs(pos[i]) < 1e-9, 'mirrored vertex');
  // Outward-facing strips: triangle normal · (centroid − axis point at mid height) > 0 for every non-cap triangle.
  let out = 0;
  let total = 0;
  const tri = pos.length / 9;
  for (let t = 0; t < tri; t++) {
    const a = new THREE.Vector3(pos[t * 9], pos[t * 9 + 1], pos[t * 9 + 2]);
    const b = new THREE.Vector3(pos[t * 9 + 3], pos[t * 9 + 4], pos[t * 9 + 5]);
    const c = new THREE.Vector3(pos[t * 9 + 6], pos[t * 9 + 7], pos[t * 9 + 8]);
    const n = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
    if (Math.abs(n.z) > 0.95) continue; // flat caps
    const mid = a.clone().add(b).add(c).divideScalar(3);
    total++;
    if (n.x * mid.x + n.y * (mid.y - 0.55) > 0) out++;
  }
  assert.ok(total > 20 && out / total >= 0.98, `outward winding ${((out / total) * 100).toFixed(1)} %`);
  for (let i = 0; i < nor.length; i += 3) assert.ok(Math.abs(Math.hypot(nor[i], nor[i + 1], nor[i + 2]) - 1) < 1e-4, 'unit normal');
  // Crease control: a 35° crease splits normals at a hard edge, a 180° crease welds them.
  const distinct = (geo: THREE.BufferGeometry): number => {
    const p = attr(geo, 'position');
    const n = attr(geo, 'normal');
    const m = new Map<string, Set<string>>();
    for (let i = 0; i < p.length; i += 3) {
      const k = `${p[i].toFixed(3)},${p[i + 1].toFixed(3)},${p[i + 2].toFixed(3)}`;
      m.set(k, (m.get(k) ?? new Set()).add(`${n[i].toFixed(2)},${n[i + 1].toFixed(2)},${n[i + 2].toFixed(2)}`));
    }
    return [...m.values()].filter((s) => s.size > 1).length;
  };
  assert.ok(distinct(loftSymHull(S, 35)) > distinct(loftSymHull(S, 179)), 'hard creases keep split normals');
});

// =============================================================================================
// §6 model-quality self-checks
// =============================================================================================
test('10C-1 §6.1 supercar is not a brick: V-nose < 0.70 × rear fender, greenhouse < 0.65 × body, all required aPart ids', () => {
  const g = buildCarVariant(0);
  const pos = attr(g, 'position');
  const part = attr(g, 'aPart');
  let noseW = 0;
  let rearFender = 0;
  let bodyFender = 0;
  let roofW = 0;
  for (let i = 0; i < part.length; i++) {
    const x = Math.abs(pos[i * 3]);
    const y = pos[i * 3 + 1];
    const z = pos[i * 3 + 2];
    if (part[i] !== 0 && part[i] !== 1) continue; // painted shell + glass (splitter / wing are separate carbon parts)
    if (z > 2.2) noseW = Math.max(noseW, x);
    if (z >= -1.2 && z <= -0.9) rearFender = Math.max(rearFender, x);
    if (part[i] === 0) bodyFender = Math.max(bodyFender, x);
    if (y > 1.05) roofW = Math.max(roofW, x);
  }
  assert.ok(noseW > 0 && noseW < 0.7 * rearFender, `nose ${noseW.toFixed(2)} vs rear fender ${rearFender.toFixed(2)}`);
  assert.ok(roofW > 0 && roofW < 0.65 * bodyFender, `greenhouse roof ${roofW.toFixed(2)} vs body ${bodyFender.toFixed(2)}`);
  const ids = new Set(Array.from(part));
  for (const id of [0, 1, 2, 3, 4, 6, 7, 8]) assert.ok(ids.has(id), `aPart ${id} present`);
  // Cross-section varies along Z (a side extrusion would be constant): ≥ 6 distinct half-widths in 0.3 m slices.
  const widths = new Set<number>();
  for (let z = -2.3; z <= 2.3; z += 0.3) {
    let w = 0;
    for (let i = 0; i < part.length; i++) if (part[i] === 0 && Math.abs(pos[i * 3 + 2] - z) < 0.15) w = Math.max(w, Math.abs(pos[i * 3]));
    widths.add(Math.round(w * 20));
  }
  assert.ok(widths.size >= 6, `body half-width varies along z (${widths.size} distinct)`);
});

test('10C-1 §6.2 ground contact: every hero vehicle / vending kiosk / lamp / parasol sits on y = 0 (|min.y| ≤ 0.02)', () => {
  for (const v of [0, 1, 2] as const) assert.ok(Math.abs(bbox(buildCarVariant(v)).min.y) <= 0.02, `car ${v}`);
  assert.ok(Math.abs(bbox(buildVendingGeometry()).min.y) <= 0.02, 'vending');
  assert.ok(Math.abs(bbox(buildLampGeometry()).min.y) <= 0.02, 'lamp');
  assert.ok(Math.abs(bbox(buildFurnishingsKit([KIT_VARIANT.PARASOL])).min.y) <= 0.02, 'parasol');
  // Four wheels: tyre contact vertices in all four x / z quadrants of every vehicle.
  for (const v of [0, 1, 2] as const) {
    const g = buildCarVariant(v);
    const pos = attr(g, 'position');
    const quad = new Set<string>();
    for (let i = 0; i < pos.length; i += 3) if (pos[i + 1] <= 0.02 && Math.abs(pos[i]) > 0.6) quad.add(`${Math.sign(pos[i])}${Math.sign(pos[i + 2])}`);
    assert.equal(quad.size, 4, `car ${v}: four wheels touch the ground`);
  }
});

test('10C §6.3 triangle budgets: vehicles ≤ 1,100 · vending / lamp / each furnishing variant ≤ 450 (kit variants ≤ 380)', () => {
  for (const v of [0, 1, 2] as const) {
    const n = triCount(buildCarVariant(v));
    assert.ok(n <= CAR_TRI_BUDGET, `car ${v}: ${n} tris`);
    assert.ok(n >= 600, `car ${v}: still hero-detailed (${n} tris)`);
  }
  assert.ok(triCount(buildVendingGeometry()) <= FURNITURE_TRI_BUDGET, 'vending');
  assert.ok(triCount(buildLampGeometry()) <= FURNITURE_TRI_BUDGET, 'lamp');
  for (const v of [KIT_VARIANT.LANTERNS, KIT_VARIANT.PARASOL]) assert.ok(kitVariantTris(v) <= 380, `kit variant ${v}: ${kitVariantTris(v)} tris`);
  assert.ok(KIT_CAP === 300);
  // Variants 2 / 3 are reserved for 10D: the builder accepts the ids and emits nothing for them yet.
  assert.equal(kitVariantTris(KIT_VARIANT.RAMEN_CART), 0);
  assert.equal(kitVariantTris(KIT_VARIANT.BUS_SHELTER), 0);
});

// =============================================================================================
// 10C-1 vehicle details
// =============================================================================================
test('10C-1 hero details: Y-beam DRLs + splitter + scoops + GT wing (coupe), mesh grille + plate + hollow bed (pickup), armoured van', () => {
  const sets = [0, 1, 2].map((v) => {
    const g = buildCarVariant(v as 0 | 1 | 2);
    return { pos: attr(g, 'position'), part: attr(g, 'aPart'), ao: attr(g, 'aAo'), g };
  });
  const count = (s: (typeof sets)[0], p: number): number => Array.from(s.part).filter((x) => x === p).length;
  // Coupe: wing above the roofline, carbon splitter at the nose, dark recessed intakes (aAo ≤ 0.5), caliper per wheel.
  const c = sets[0];
  const maxY = (s: (typeof sets)[0], p: number, zLo: number, zHi: number): number => {
    let m = -1;
    for (let i = 0; i < s.part.length; i++) if (s.part[i] === p && s.pos[i * 3 + 2] > zLo && s.pos[i * 3 + 2] < zHi) m = Math.max(m, s.pos[i * 3 + 1]);
    return m;
  };
  assert.ok(maxY(c, 4, -2.4, -1.9) >= 1.15, 'twin-strut GT wing rides above the roof');
  assert.ok(Array.from(c.part).some((p, i) => p === 4 && c.pos[i * 3 + 2] > 2.0 && c.pos[i * 3 + 1] < 0.2), 'front carbon splitter');
  assert.ok(Array.from(c.ao).filter((a) => a <= 0.5).length > 30, 'recessed cavities carry baked aAo ≤ 0.5');
  assert.ok(count(c, 7) >= 4 * 36 - 1, 'four crimson brake calipers');
  assert.ok(count(c, 2) > 0 && count(c, 3) > 0 && count(c, 8) > 0);
  // Pickup: open bed — bed floor below the side walls, tow hooks + plate, roll bar above the cab line.
  const p = sets[1];
  assert.ok(count(p, 7) > 0 && count(p, 8) > 0, 'tow hooks + glowing plate');
  assert.ok(maxY(p, 6, -0.9, -0.3) >= 1.8, 'roll bar reaches y ≥ 1.8');
  let bedFloorTop = -1;
  for (let i = 0; i < p.part.length; i++) if (p.part[i] === 4 && p.pos[i * 3 + 2] < -0.5 && p.pos[i * 3 + 2] > -2.4 && Math.abs(p.pos[i * 3]) < 0.8 && p.pos[i * 3 + 1] > 0.4 && p.pos[i * 3 + 1] < 0.7) bedFloorTop = Math.max(bedFloorTop, p.pos[i * 3 + 1]);
  assert.ok(bedFloorTop >= 0.6 && bedFloorTop <= 0.65, `bed floor at y ≈ 0.62 (${bedFloorTop.toFixed(2)})`);
  // Van: amber strobe (aPart 9) up on the roof rack.
  assert.ok(maxY(sets[2], 9, -3, 3) >= 2.1, 'roof strobe bar');
  // Footprints / heights are the collider dimensions used by the builder.
  for (const [v, dims] of CAR_DIMS.entries()) {
    const b = bbox(sets[v].g);
    assert.ok(b.max.y <= dims[1] + 0.2 && b.max.y >= dims[1] - 0.15, `car ${v} height ≈ ${dims[1]}`);
    assert.ok(b.max.z - b.min.z <= dims[2] + 0.5, `car ${v} length ≈ ${dims[2]}`);
  }
});

// =============================================================================================
// 10C-2 vending
// =============================================================================================
test('10C-2 vending kiosk: 1.10 × 2.05 × 0.78 m, 0.14 m recessed display, 0.19 m pickup chute, 3 shelf rails, English 512² atlas', () => {
  const g = buildVendingGeometry();
  const b = bbox(g);
  assert.ok(b.max.y > 2.04 && b.max.y < 2.06, 'height 2.05 m');
  assert.ok(b.max.x - b.min.x <= 1.15 && b.max.x - b.min.x >= 1.08, 'width ≈ 1.10 m');
  assert.ok(Math.abs(b.min.z + 0.39) < 1e-6 && b.max.z <= 0.46, 'depth 0.78 m + 0.06 m marquee');
  const pos = attr(g, 'position');
  const part = attr(g, 'aPart');
  const zs = (p: number): number[] => Array.from(part).flatMap((v, i) => (v === p ? [pos[i * 3 + 2]] : []));
  const display = zs(1);
  assert.ok(display.length > 0 && display.every((z) => Math.abs(z - 0.25) < 1e-6), 'display back plane at z = 0.25 (0.14 m behind the 0.39 m front)');
  assert.ok(Math.abs(0.39 - 0.25 - 0.14) < 1e-9);
  assert.ok(Array.from(part).some((p, i) => p === 4 && Math.abs(pos[i * 3 + 2] - 0.2) < 1e-6), 'pickup chute back plane at z = 0.20 (0.19 m deep)');
  const rails = new Set(Array.from(part).flatMap((p, i) => (p === 5 && pos[i * 3 + 1] > 0.9 && pos[i * 3 + 1] < 1.6 ? [Math.round(pos[i * 3 + 1] * 100)] : [])));
  assert.ok([...rails].filter((y) => Math.abs(y - 95) <= 2 || Math.abs(y - 123) <= 2 || Math.abs(y - 151) <= 2).length >= 3, 'three metal shelf rails');
  for (const id of [1, 2, 3, 4, 5, 6, 7, 8]) assert.ok(Array.from(part).includes(id), `aPart ${id}`);
  // Atlas: 512², 4 English brands in the 2 × 2 quadrants.
  assert.equal(VENDING_ATLAS.SIZE, 512);
  assert.deepEqual([...VENDING_ATLAS.BRANDS], ['NI-COLA', 'SYNTH-CAF', 'K-BOOST', 'ZERO-H2O']);
  const src = readFileSync('src/engine/ProceduralTextures.ts', 'utf8');
  for (const needle of ['generateVendingAtlas', "'$1.50'", 'NFC PAY', 'SELECT']) assert.ok(src.includes(needle), `${needle} in the atlas painter`);
  assert.ok(!/[ぁ-ヿ一-鿿￥]/u.test(src), 'no Japanese characters');
});

// =============================================================================================
// Built districts
// =============================================================================================
const CITY = new CityBuilder(mockTextures());
const ALL: SectorLayout[] = [];
const MESHES: string[][] = [];
for (let s = 1; s <= SECTORS.length; s++) {
  ALL.push(CITY.buildSector(s, 0));
  const names: string[] = [];
  CITY.root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) names.push(o.name);
  });
  MESHES.push(names);
}

test('10C +1 draw call: exactly one StreetFurnishingsKit mesh (cap 300); cars / vending / lamps stay one instanced draw each', () => {
  for (const [i, names] of MESHES.entries()) {
    const n = (name: string): number => names.filter((m) => m === name).length;
    assert.equal(n('StreetFurnishingsKit'), 1, `S${i + 1} kit`);
    assert.equal(n('VendingKiosks'), 1);
    assert.equal(n('StreetLamps'), 1);
    assert.equal(names.filter((m) => m.startsWith('ParkedCars_')).length, 3, 'three instanced car variants');
    for (const nm of ['ParkedCars_Coupe', 'ParkedCars_Pickup', 'ParkedCars_Van']) assert.equal(n(nm), 1);
    const kit = ALL[i].stats.streetscape.kitInstances;
    assert.ok(kit <= KIT_CAP, `S${i + 1}: ${kit} kit instances ≤ ${KIT_CAP}`);
  }
  const total = ALL.reduce((s, L) => s + L.stats.streetscape.kitInstances, 0);
  assert.ok(total >= 40, `lantern strings + parasols exist (${total})`);
});

test('10C-1 parked-car colliders use the hero footprints (coupe 1.18 · pickup 1.88 · van 2.08 m tall)', () => {
  const heights = new Set(CAR_DIMS.map((d) => d[1]));
  for (const L of ALL) {
    const cars = L.colliders.filter((c) => c.kind === 'CAR');
    assert.equal(cars.length, L.sector.parkedCars);
    for (const c of cars) assert.ok(heights.has(Math.round((c.max.y - c.min.y) * 100) / 100), `car height ${(c.max.y - c.min.y).toFixed(2)}`);
  }
});

test('10C-3 streetscape: curb LED bars, English roof scaffolds on solid low roofs, shacks, gantries, parasols clear of every doorway', () => {
  const tot = { curb: 0, scaf: 0, shack: 0, gantry: 0, par: 0, strings: 0 };
  let gantrySectors = 0;
  for (const [i, L] of ALL.entries()) {
    const s = L.stats.streetscape;
    assert.ok(s.curbLeds >= 20, `S${i + 1} curb LEDs ${s.curbLeds}`);
    tot.curb += s.curbLeds;
    tot.scaf += s.scaffolds;
    tot.shack += s.shacks;
    tot.gantry += s.gantries;
    tot.par += s.parasols;
    tot.strings += s.lanternStrings;
    if (s.gantries > 0) gantrySectors++;
    assert.ok(s.gantries <= 6 && s.scaffolds <= 9 && s.shacks <= 12);
    const scaffolds = L.neonSignRecords.filter((r: NeonSignRecord) => r.kind === 'SCAFFOLD');
    assert.equal(scaffolds.length, s.scaffolds);
    for (const r of scaffolds) {
      // Stands on the roof of a low solid span of its building, behind the street edge, facing outward.
      const roofY = r.y - 1.75;
      const spans = L.buildingSpans[r.building];
      assert.ok(roofY >= 4.5 - 1e-6 && roofY <= 12.5 + 1e-6, 'low roof');
      assert.ok(spans.some((sp) => Math.abs(sp.y1 - roofY) < 1e-6 && sp.y0 < 0.01), `S${i + 1} scaffold sits on a solid low roof`);
      assert.ok((Math.abs(r.nx) === 1) !== (Math.abs(r.nz) === 1), 'cardinal facing');
      assert.equal(r.w, 10);
    }
    // Parasol poles (0.6 × 0.6 × 1.2 m PROP colliders at street level) never stand in a 1F doorway clear zone.
    for (const c of L.colliders) {
      if (c.kind !== 'PROP' || c.building !== -1 || c.min.y !== 0 || Math.abs(c.max.y - 1.2) > 1e-6 || Math.abs(c.max.x - c.min.x - 0.6) > 1e-6 || Math.abs(c.max.z - c.min.z - 0.6) > 1e-6) continue;
      const cx = (c.min.x + c.max.x) / 2;
      const cz = (c.min.z + c.max.z) / 2;
      for (const z of L.doorClearZones) if (z.y < 1) assert.ok(!(cx + 0.3 > z.x0 && cx - 0.3 < z.x1 && cz + 0.3 > z.z0 && cz - 0.3 < z.z1), `S${i + 1} parasol in a door clear zone`);
    }
  }
  assert.ok(tot.scaf >= 10, `scaffold signs ${tot.scaf}`);
  assert.ok(tot.shack >= 8, `corrugated shacks ${tot.shack}`);
  assert.ok(gantrySectors >= 4 && tot.gantry >= 12, `gantries ${tot.gantry} over ${gantrySectors} sectors`);
  assert.ok(tot.par >= 6, `parasols ${tot.par}`);
  assert.ok(tot.strings >= 40, `lantern strings ${tot.strings}`);
});

test('10C-3 English scaffold words + gantry beacons: OPEN 24H / CYBER RAMEN / NIGHT BAR / MOTEL 09 tube lettering; grapple anchors on gantries', () => {
  const src = readFileSync('src/engine/ProceduralTextures.ts', 'utf8');
  for (const w of ['OPEN 24H', 'CYBER RAMEN', 'NIGHT BAR', 'MOTEL 09']) assert.ok(src.includes(`text: '${w}'`), `${w} banner row`);
  // Every gantry adds 3 BUILDING_CORNER anchors at 14–20 m (no anchor-less steel).
  for (const L of ALL) {
    const high = L.anchors.filter((a) => a.kind === 'BUILDING_CORNER' && a.position.y > 14.2 && a.position.y < 20.7);
    assert.ok(high.length >= L.stats.streetscape.gantries * 3, `S${L.sector.index} gantry anchors ${high.length}`);
  }
  // Gantry colliders (PROP boxes 1.6 m wide × 2.1 m tall spanning the avenue) are solid and clear of every building.
  for (const L of ALL) {
    for (const c of L.colliders) {
      if (c.kind !== 'PROP' || c.building !== -1 || Math.abs(c.max.y - c.min.y - 2.1) > 1e-6 || c.min.y < 12) continue;
      assert.ok(c.max.y <= 22.1, 'gantry height 12–22 m');
      for (const o of L.colliders) {
        if (o === c || o.kind !== 'BUILDING') continue;
        const overlap = c.min.x < o.max.x - 0.2 && c.max.x > o.min.x + 0.2 && c.min.y < o.max.y && c.max.y > o.min.y && c.min.z < o.max.z - 0.2 && c.max.z > o.min.z + 0.2;
        assert.ok(!overlap, 'gantry ends at the building faces');
      }
    }
  }
});
