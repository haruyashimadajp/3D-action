/**
 * Phase 10D: living-city atmosphere — expressway traffic (+1 call), AnimatedEnvKit (+1 call), ramen carts and bus
 * shelters in the StreetFurnishingsKit (+0), breaker sparks / canopy drips / audio scheduling, screenshot-audit polish.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { CITY_FX, LEVEL } from '../src/config/constants';
import { SECTORS } from '../src/config/skills';
import { readFileSync } from 'node:fs';
import { FURNISHINGS_ATLAS, type PbrTextureSet, type ProceduralTextureLibrary } from '../src/engine/ProceduralTextures';
import {
  ENV_DIMS,
  ENV_TRI_BUDGET,
  ENV_VARIANT,
  RING_INNER,
  ThunderScheduler,
  buildAnimatedEnvKit,
  envVariantTris,
  thunderPanRaw,
  RING_OUTER,
  TRAFFIC_BOUNDS,
  TRAFFIC_CAP,
  TRAFFIC_TRI_BUDGET,
  buildTrafficCarGeometry,
  ringPerimeter,
  sampleRing,
  trafficCarAt,
  type TrafficCarState,
} from '../src/world/CityAtmosphere';
import { CityBuilder, blimpPose, lightningAt, type SectorLayout } from '../src/world/CityBuilder';
import { FURNITURE_BOUNDS, FURNITURE_SOCKETS, KIT_VARIANT, buildFurnishingsKit, kitVariantTris } from '../src/world/CityFurniture';
import { CAR_TRI_BUDGET, buildCarVariant, triCount as carTris } from '../src/world/CityVehicles';

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
const triCount = (g: THREE.BufferGeometry): number => (g.index ? g.index.count : g.getAttribute('position').count) / 3;
function bbox(g: THREE.BufferGeometry): THREE.Box3 {
  g.computeBoundingBox();
  return g.boundingBox as THREE.Box3;
}

const CITY = new CityBuilder(mockTextures());
const DECK = LEVEL.HIGHWAY_DECK_Y;
interface Built {
  L: SectorLayout;
  loop: number;
  meshNames: string[];
  steam: Array<[number, number, number]>;
}
const BUILT: Built[] = [];
for (let loop = 0; loop <= 2; loop++) {
  for (let s = 1; s <= SECTORS.length; s++) {
    const L = CITY.buildSector(s, loop);
    const meshNames: string[] = [];
    const steam: Array<[number, number, number]> = [];
    const m = new THREE.Matrix4();
    CITY.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshNames.push(o.name);
      if (o.name === 'SteamMist') {
        const im = o as THREE.InstancedMesh;
        for (let i = 0; i < im.count; i++) {
          im.getMatrixAt(i, m);
          steam.push([m.elements[12], m.elements[13], m.elements[14]]);
        }
      }
    });
    BUILT.push({ L, loop, meshNames: meshNames.sort(), steam });
  }
}

// =============================================================================================
// 10D-1 Elevated traffic
// =============================================================================================
test('10D-1 traffic mesh: wedge coupe ≤ 240 tris, 4.5 × 1.92 × 1.18 m, grounded, opaque crimson ribbons to z −5.2', () => {
  const g = buildTrafficCarGeometry();
  assert.ok(triCount(g) <= TRAFFIC_TRI_BUDGET, `${triCount(g)} tris ≤ ${TRAFFIC_TRI_BUDGET}`);
  const bb = bbox(g);
  assert.ok(Math.abs(bb.min.y) <= 0.02, `min.y ${bb.min.y}`);
  assert.ok(Math.abs(bb.max.y - TRAFFIC_BOUNDS.h) <= 0.02, `height ${bb.max.y}`);
  assert.ok(Math.abs(bb.max.x - bb.min.x - TRAFFIC_BOUNDS.w) <= 0.02, `width ${bb.max.x - bb.min.x}`);
  assert.ok(Math.abs(bb.min.z - TRAFFIC_BOUNDS.ribbonEndZ) <= 0.01 && bb.max.z <= TRAFFIC_BOUNDS.l / 2 + 0.03, 'ribbons trail to −5.2 m');
  const part = g.getAttribute('aPart').array as ArrayLike<number>;
  for (const p of [0, 1, 2, 3, 4, 5]) assert.ok(Array.prototype.includes.call(part, p), `aPart ${p} present`);
});

test('10D-1 traffic: 24–36 cars in every sector × loop, no parked car on the deck, every car between the guard walls', () => {
  const car: TrafficCarState = { x: 0, z: 0, yaw: 0, px: 0, pz: 0 };
  for (const { L, loop, meshNames } of BUILT) {
    const tag = `loop ${loop} S${L.sector.index}`;
    assert.ok(L.stats.traffic >= 24 && L.stats.traffic <= TRAFFIC_CAP, `${tag}: ${L.stats.traffic} vehicles`);
    assert.equal(meshNames.filter((n) => n === 'ElevatedTraffic').length, 1, `${tag}: one traffic draw`);
    assert.equal(L.stats.cars, L.sector.parkedCars, `${tag}: exact parked-car count`);
    // No parked car collider stands on the expressway deck.
    assert.ok(!L.colliders.some((c) => c.kind === 'CAR' && c.min.y > DECK - 1), `${tag}: zero parked cars on the deck`);
    const lanes = CITY.traffic.laneList;
    const m4 = new THREE.Matrix4();
    for (const t of [0, 3.7, 11.2, 29.5]) {
      CITY.traffic.update(t);
      for (let k = 0; k < CITY.traffic.count; k++) {
        CITY.traffic.mesh.getMatrixAt(k, m4);
        const y = m4.elements[13];
        assert.ok(y >= DECK && y <= DECK + 0.1, `${tag}: car on the deck (y ${y.toFixed(3)})`);
      }
      for (let k = 0; k < CITY.traffic.count; k++) {
        CITY.traffic.carState(k, car);
        if (L.sector.index === 5) {
          const m = Math.max(Math.abs(car.x), Math.abs(car.z));
          assert.ok(m + 0.96 < 33.6, `${tag}: ring car inside the outer guard wall (${m.toFixed(2)})`);
          assert.ok(m - 0.96 > 20.4 || (Math.abs(car.x) > 20.4 && Math.abs(car.z) > 20.4), `${tag}: ring car outside the inner guard wall (${car.x.toFixed(2)}, ${car.z.toFixed(2)})`);
        }
      }
    }
    for (const ln of lanes) {
      if (ln.ring) continue;
      assert.ok(Math.abs(ln.lat - ln.centre) + TRAFFIC_BOUNDS.w / 2 < 6.6, `${tag}: lane inside the 6.6 m guard face`);
      assert.ok(Math.abs(ln.lat - ln.centre) - TRAFFIC_BOUNDS.w / 2 > 0.25 + 0.5, `${tag}: lane clear of the median`);
    }
  }
});

test('10D-1 Sector 5 ring: rear-ribbon corner < 33.6 m, inner body > inner wall, smooth closed loop (no teleports)', () => {
  const o = { x: 0, z: 0, tx: 0, tz: 0, nx: 0, nz: 0 };
  for (const [def, label] of [[RING_OUTER, 'outer'], [RING_INNER, 'inner']] as const) {
    const P = ringPerimeter(def.R, def.r);
    let prevYaw = NaN;
    let maxStep = 0;
    const v = 16;
    for (let s = 0; s <= P + 1e-6; s += v * 0.05) {
      sampleRing(s, def.R, def.r, o);
      // Car body corners incl. the ribbon tip.
      const yaw = Math.atan2(o.tx, o.tz);
      for (const [lx, lz] of [[0.96, 2.25], [-0.96, 2.25], [0.96, -2.25], [-0.96, -2.25], [0.7, TRAFFIC_BOUNDS.ribbonEndZ], [-0.7, TRAFFIC_BOUNDS.ribbonEndZ]]) {
        const wx = o.x + lx * Math.cos(yaw) + lz * Math.sin(yaw);
        const wz = o.z - lx * Math.sin(yaw) + lz * Math.cos(yaw);
        const m = Math.max(Math.abs(wx), Math.abs(wz));
        if (label === 'outer') assert.ok(m < 33.6, `outer ring corner at ${m.toFixed(2)} m`);
        else assert.ok(m < 26.75, `inner ring corner ${m.toFixed(2)} m inside the median face`);
      }
      if (label === 'inner') {
        // Inner body edge stays outside the inner guard wall (|coord| > 20.4) wherever a wall exists (|other| < 20).
        const inner = Math.min(Math.abs(o.x), Math.abs(o.z));
        const outer = Math.max(Math.abs(o.x), Math.abs(o.z));
        if (inner < 20) assert.ok(outer - 0.96 > 20.4, `inner ring clears the inner wall (${outer.toFixed(2)})`);
      }
      if (Number.isFinite(prevYaw)) {
        let d = Math.abs(yaw - prevYaw);
        if (d > Math.PI) d = 2 * Math.PI - d;
        maxStep = Math.max(maxStep, d);
      }
      prevYaw = yaw;
    }
    const limit = (v / def.r) * 0.05 + 0.05;
    assert.ok(maxStep < limit, `${label}: max heading step ${maxStep.toFixed(3)} rad < ${limit.toFixed(3)}`);
    // Closed: s = 0 and s = P coincide.
    sampleRing(0, def.R, def.r, o);
    const a = { ...o };
    sampleRing(P, def.R, def.r, o);
    assert.ok(Math.hypot(a.x - o.x, a.z - o.z) < 1e-6, `${label}: closed loop`);
  }
});

test('10D-1 Sector 3 grade crossing: perpendicular lanes keep ≥ 14 m centre distance for t = 0…60 s', () => {
  const s3 = BUILT.find((b) => b.L.sector.index === 3 && b.loop === 0)!;
  CITY.buildSector(3, 0);
  void s3;
  const lanes = CITY.traffic.laneList;
  const a: TrafficCarState = { x: 0, z: 0, yaw: 0, px: 0, pz: 0 };
  const b: TrafficCarState = { x: 0, z: 0, yaw: 0, px: 0, pz: 0 };
  let min = Infinity;
  for (let t = 0; t <= 60; t += 0.25) {
    for (const la of lanes) {
      if (la.axis !== 'z') continue;
      for (const lb of lanes) {
        if (lb.axis !== 'x') continue;
        for (let i = 0; i < la.n; i++) {
          trafficCarAt(la, i, t, a);
          for (let j = 0; j < lb.n; j++) {
            trafficCarAt(lb, j, t, b);
            min = Math.min(min, Math.hypot(a.x - b.x, a.z - b.z));
          }
        }
      }
    }
  }
  assert.ok(min >= 14, `closest perpendicular pair ${min.toFixed(2)} m ≥ 14 m`);
});

test('10D-1 non-lethal bump: inward horizontal impulse > 5 m/s, upward hop, cooldown, never outward over the wall', () => {
  for (const s of [1, 5]) {
    CITY.buildSector(s, 0);
    const tr = CITY.traffic;
    tr.update(4);
    const car: TrafficCarState = { x: 0, z: 0, yaw: 0, px: 0, pz: 0 };
    tr.carState(0, car);
    const imp = new THREE.Vector3();
    const player = new THREE.Vector3(car.x, DECK, car.z);
    assert.ok(tr.checkPlayerBump(player, imp), `S${s}: player on a car is bumped`);
    assert.ok(Math.hypot(imp.x, imp.z) > 5, `S${s}: horizontal impulse ${Math.hypot(imp.x, imp.z).toFixed(1)} m/s`);
    assert.ok(imp.y > 0, 'slight upward hop');
    // Inward: the push points from the car toward its highway centreline / the ring median.
    if (s === 1) {
      const lane = tr.laneList.find((l) => Math.abs((l.axis === 'x' ? car.z : car.x) - l.lat) < 1e-6)!;
      const lat = lane.axis === 'x' ? imp.z : imp.x;
      assert.ok(Math.sign(lat) === -Math.sign(lane.lat - lane.centre), 'pushed toward the centreline');
    } else {
      const m0 = Math.max(Math.abs(car.x), Math.abs(car.z));
      const m1 = Math.max(Math.abs(car.x + imp.x * 0.05), Math.abs(car.z + imp.z * 0.05));
      assert.ok(Math.abs(m1 - 27) < Math.abs(m0 - 27), 'ring push toward the 27 m median');
    }
    assert.ok(!tr.checkPlayerBump(player, imp), 'cooldown blocks an immediate second bump');
    // Far from the deck: never.
    tr.update(10);
    tr.carState(0, car);
    assert.ok(!tr.checkPlayerBump(new THREE.Vector3(car.x, 0, car.z), imp), 'street level below the deck is never bumped');
  }
});

// =============================================================================================
// 10D-2 AnimatedEnvKit
// =============================================================================================
test('10D-2 AnimatedEnvKit: variants ≤ 320 tris, normals rotate after beginnormal (before defaultnormal), one persistent draw', () => {
  for (const v of [ENV_VARIANT.FAN, ENV_VARIANT.NOREN, ENV_VARIANT.HOLO]) {
    const n = envVariantTris(v);
    assert.ok(n > 0 && n <= ENV_TRI_BUDGET, `variant ${v}: ${n} tris`);
  }
  // Shader order: objectNormal rotation sits between <beginnormal_vertex> and <defaultnormal_vertex>.
  const mat = CITY.envKit.mesh.material as THREE.MeshStandardMaterial;
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader } as unknown as THREE.WebGLProgramParametersWithUniforms;
  mat.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  const vs = shader.vertexShader;
  const iBegin = vs.indexOf('#include <beginnormal_vertex>');
  const iRot = vs.indexOf('objectNormal.xy = eRot');
  const iDefault = vs.indexOf('#include <defaultnormal_vertex>');
  const iPos = vs.indexOf('transformed.xy = eRot');
  const iBeginV = vs.indexOf('#include <begin_vertex>');
  assert.ok(iBegin >= 0 && iRot > iBegin && iRot < iDefault, 'objectNormal rotated right after beginnormal_vertex');
  assert.ok(iPos > iBeginV, 'positions rotate after begin_vertex');
  for (const { L, meshNames, loop } of BUILT) {
    assert.equal(meshNames.filter((n) => n === 'AnimatedEnvKit').length, 1, `loop ${loop} S${L.sector.index}: one kit draw`);
  }
  // Both new draws are persistent: identical mesh sets in every sector (+2 vs 10C).
  const ref = BUILT[0].meshNames.join('|');
  for (const b of BUILT) assert.equal(b.meshNames.join('|'), ref, `loop ${b.loop} S${b.L.sector.index} mesh set`);
});

test('10D-2 placement: fans flush on solid FaceSpans / machine-room flanks, noren ≥ 2.20 m, holograms on eligible roofs only', () => {
  const noren = buildAnimatedEnvKit([ENV_VARIANT.NOREN]);
  const pos = noren.getAttribute('position');
  const anim = noren.getAttribute('aAnim');
  const part = noren.getAttribute('aPart');
  for (let i = 0; i < pos.count; i++) {
    if (part.getX(i) === 0) assert.equal(anim.getY(i), 0, 'rod / hangers never sway');
    assert.ok(pos.getY(i) >= -ENV_DIMS.NOREN_DROP - 1e-6, 'cloth drop ≤ 0.68 m');
  }
  let fans = 0;
  let norens = 0;
  let holos = 0;
  for (const { L, loop } of BUILT) {
    const tag = `loop ${loop} S${L.sector.index}`;
    for (const e of L.animatedEnv) {
      const nx = Math.sin(e.yaw);
      const nz = Math.cos(e.yaw);
      if (e.variant === ENV_VARIANT.FAN) {
        fans++;
        const ax = Math.abs(nx) > 0.5 ? 'x' : 'z';
        const sg = Math.sign(ax === 'x' ? nx : nz);
        if (e.host === 'WALL') {
          const ok = L.buildingSpans.some((spans) =>
            spans.some((sp) => {
              if (sp.ax !== ax || sp.sg !== sg) return false;
              const d = Math.abs((ax === 'x' ? e.x : e.z) - sp.plane);
              const al = ax === 'x' ? e.z : e.x;
              return d <= 0.06 && al - ENV_DIMS.FAN_R >= sp.a0 - 1e-6 && al + ENV_DIMS.FAN_R <= sp.a1 + 1e-6 && e.y - ENV_DIMS.FAN_R >= sp.y0 - 1e-6 && e.y + ENV_DIMS.FAN_R <= sp.y1 + 1e-6;
            }),
          );
          assert.ok(ok, `${tag}: wall fan at (${e.x.toFixed(2)}, ${e.y.toFixed(2)}, ${e.z.toFixed(2)}) flush on a solid FaceSpan`);
        } else {
          assert.equal(e.host, 'ROOM', 'fans mount on walls or machine rooms only');
          const ok = L.machineRoomBoxes.some((r) => {
            if (r.doorFace === `${ax}:${sg}`) return false;
            const plane = ax === 'x' ? (sg > 0 ? r.x1 : r.x0) : sg > 0 ? r.z1 : r.z0;
            const al = ax === 'x' ? e.z : e.x;
            const [l0, l1] = ax === 'x' ? [r.z0, r.z1] : [r.x0, r.x1];
            return Math.abs((ax === 'x' ? e.x : e.z) - plane) <= 0.06 && al > l0 && al < l1 && e.y > r.y0 && e.y < r.y1;
          });
          assert.ok(ok, `${tag}: rooftop fan on a non-door machine-room flank`);
        }
      } else if (e.variant === ENV_VARIANT.NOREN) {
        norens++;
        assert.ok(e.y - ENV_DIMS.NOREN_DROP >= 2.2 - 1e-6, `${tag}: noren lowest vertex ${(e.y - ENV_DIMS.NOREN_DROP).toFixed(2)} m ≥ 2.20 m`);
      } else {
        holos++;
        const b = L.buildings.find((bb) => Math.abs(bb.roofY - e.y) < 1e-6 && Math.abs(e.x - bb.cx) <= bb.halfW - ENV_DIMS.HOLO_SWEEP && Math.abs(e.z - bb.cz) <= bb.halfD - ENV_DIMS.HOLO_SWEEP);
        assert.ok(b, `${tag}: hologram sweep inside a roof`);
        assert.ok(b.massing !== 'CYLINDER_RING_TOWER' && b.massing !== 'SLANT_CORP_TOWER' && b.massing !== 'TWIN_ARCH_GATE', `${tag}: never on ${b.massing}`);
        const S = ENV_DIMS.HOLO_SWEEP;
        const hit = L.colliders.find((c) => c.kind !== 'BARRIER' && e.x - S < c.max.x && e.x + S > c.min.x && e.z - S < c.max.z && e.z + S > c.min.z && e.y + 0.05 < c.max.y && e.y + ENV_DIMS.HOLO_TOP > c.min.y);
        assert.ok(!hit, `${tag}: full 3.6 m ring sweep clear of roof props (${hit?.kind})`);
        for (const bl of CITY_FX.BLIMPS) {
          const o = { x: 0, y: 0, z: 0, yaw: 0 };
          for (let t = 0; t < 400; t += 2) {
            blimpPose(bl, t, o);
            const d = Math.hypot(o.x - e.x, o.y - (e.y + ENV_DIMS.HOLO_TOP), o.z - e.z) - CITY_FX.BLIMP_RADIUS - S;
            assert.ok(d >= 18, `${tag}: ≥ 18 m from blimp (${d.toFixed(1)})`);
          }
        }
      }
    }
  }
  assert.ok(fans >= 150 && norens >= 150 && holos >= 30, `kit census fans ${fans} · noren ${norens} · holograms ${holos}`);
});

// =============================================================================================
// 10D-3 Ramen carts + bus shelters
// =============================================================================================
test('10D-3 street landmarks: v2 / v3 ≤ 380 tris, grounded, English-only furnishingsAtlas', () => {
  for (const v of [KIT_VARIANT.RAMEN_CART, KIT_VARIANT.BUS_SHELTER]) {
    assert.ok(kitVariantTris(v) > 0 && kitVariantTris(v) <= 380, `variant ${v}: ${kitVariantTris(v)} tris`);
    const bb = bbox(buildFurnishingsKit([v]));
    assert.ok(Math.abs(bb.min.y) <= 0.02, `variant ${v}: min.y ${bb.min.y}`);
  }
  const cart = bbox(buildFurnishingsKit([KIT_VARIANT.RAMEN_CART]));
  assert.ok(cart.max.x - cart.min.x <= FURNITURE_BOUNDS.RAMEN_CART.w + 0.02 && cart.max.y <= FURNITURE_BOUNDS.RAMEN_CART.h + 0.02 && cart.max.z - cart.min.z <= FURNITURE_BOUNDS.RAMEN_CART.d + 0.02, 'cart envelope');
  const sh = bbox(buildFurnishingsKit([KIT_VARIANT.BUS_SHELTER]));
  assert.ok(sh.max.x - sh.min.x <= FURNITURE_BOUNDS.BUS_SHELTER.w + 0.02 && sh.max.y <= FURNITURE_BOUNDS.BUS_SHELTER.h + 0.02 && sh.max.z - sh.min.z <= FURNITURE_BOUNDS.BUS_SHELTER.d + 0.02, 'shelter envelope');
  const jp = /[　-〿぀-ゟ゠-ヿㇰ-ㇿ㐀-䶿一-鿿豈-﫿＀-￯]/u;
  for (const label of FURNISHINGS_ATLAS.LABELS) assert.ok(!jp.test(label), `English label ${label}`);
  const src = readFileSync('src/engine/ProceduralTextures.ts', 'utf8');
  for (const needle of ['SYNTH RAMEN', 'HOT NOODLES 24H', 'NEO-KOWLOON METRO', 'SECTOR TRANSIT', 'NEXT SHUTTLE: 02 MIN']) assert.ok(src.includes(needle), needle);
  // The material samples the atlas through its own uniform (never mat.map) and keeps 4 explicit variant branches.
  const mat = CITY.root.getObjectByName('StreetFurnishingsKit') as THREE.Mesh;
  assert.ok(!(mat.material as THREE.MeshStandardMaterial).map, 'no mat.map');
  assert.equal((mat.material as THREE.MeshStandardMaterial).customProgramCacheKey(), 'strand-furnishings-v2');
});

test('10D-3 placement: carts / shelters on the sidewalk, zero road overhang, clear of doors, lamps, cars, kiosks, buildings; anchored steam', () => {
  const kitBox = (x: number, z: number, yaw: number, lx0: number, lx1: number, lz0: number, lz1: number) => {
    const c = Math.round(Math.cos(yaw));
    const sn = Math.round(Math.sin(yaw));
    const pts = [[lx0, lz0], [lx1, lz0], [lx0, lz1], [lx1, lz1]].map(([lx, lz]) => [x + lx * c + lz * sn, z - lx * sn + lz * c]);
    return { x0: Math.min(...pts.map((p) => p[0])), z0: Math.min(...pts.map((p) => p[1])), x1: Math.max(...pts.map((p) => p[0])), z1: Math.max(...pts.map((p) => p[1])) };
  };
  for (const { L, loop, steam } of BUILT) {
    const tag = `loop ${loop} S${L.sector.index}`;
    if (L.sector.index <= 4) {
      assert.ok(L.ramenCarts.length >= 2, `${tag}: ${L.ramenCarts.length} ramen carts`);
      assert.ok(L.busShelters.length >= 2, `${tag}: ${L.busShelters.length} bus shelters`);
    } else assert.ok(L.ramenCarts.length >= 1 && L.busShelters.length >= 2, `${tag}: S5 landmarks`);
    const B = FURNITURE_BOUNDS.BUS_SHELTER;
    const items = [
      ...L.busShelters.map((s) => ({ kind: 'shelter', s, r: kitBox(s.x, s.z, s.yaw, -B.w / 2, B.w / 2, 0.03 - B.d / 2, 0.03 + B.d / 2), h: 2.55, lamp: 2.2 })),
      ...L.ramenCarts.map((s) => ({ kind: 'cart', s, r: kitBox(s.x, s.z, s.yaw, -1.1, 1.1, -0.58, 0.58), h: 2.35, lamp: 1.0 })),
    ];
    for (const sh of L.busShelters) {
      // Front roof lip ≥ 0.3 m behind the kerb line, on the sidewalk side.
      const lat = sh.axis === 'x' ? sh.z : sh.x;
      const lip = lat - sh.side * (0.03 + B.d / 2);
      assert.ok((lip - sh.kerb) * sh.side >= 0.3, `${tag}: shelter lip ${((lip - sh.kerb) * sh.side).toFixed(2)} m behind the kerb`);
    }
    for (const it of items) {
      const r = it.r;
      assert.ok(!L.doorClearZones.some((d) => d.y < 1 && r.x0 < d.x1 && r.x1 > d.x0 && r.z0 < d.z1 && r.z1 > d.z0), `${tag}: ${it.kind} clear of doorways`);
      assert.ok(!L.lampPoles.some(([lx, lz]) => Math.hypot(Math.max(r.x0 - lx, 0, lx - r.x1), Math.max(r.z0 - lz, 0, lz - r.z1)) < it.lamp - 1e-6), `${tag}: ${it.kind} clear of lamp poles`);
      for (const c of L.colliders) {
        if (c.max.y <= 0.1 || c.min.y >= it.h || c.kind === 'BARRIER') continue;
        const inside = c.min.x >= r.x0 - 0.01 && c.max.x <= r.x1 + 0.01 && c.min.z >= r.z0 - 0.01 && c.max.z <= r.z1 + 0.01;
        if (inside && c.kind === 'PROP') continue; // its own colliders
        const m = c.kind === 'BUILDING' ? 0.65 - 1e-6 : 0;
        const hit = r.x0 - m < c.max.x && r.x1 + m > c.min.x && r.z0 - m < c.max.z && r.z1 + m > c.min.z;
        assert.ok(!hit, `${tag}: ${it.kind} at (${it.s.x.toFixed(1)}, ${it.s.z.toFixed(1)}) overlaps a ${c.kind} collider`);
      }
    }
    for (const c of L.ramenCarts) {
      const [sx, , sz] = FURNITURE_SOCKETS.RAMEN_STEAM;
      const vx = c.x + sx * Math.cos(c.yaw) + sz * Math.sin(c.yaw);
      const vz = c.z - sx * Math.sin(c.yaw) + sz * Math.cos(c.yaw);
      assert.ok(steam.some(([x, , z]) => Math.hypot(x - vx, z - vz) <= 0.8), `${tag}: steam puff over the boiler vat`);
    }
  }
});

// =============================================================================================
// 10D-5 polish + 10D-4 math
// =============================================================================================
test('10D-5 hero cars ≤ 1,100 tris, grounded; coupe tapered V-nose (z > 2.2) < 0.65 × rear fender width', () => {
  for (const v of [0, 1, 2] as const) {
    const g = buildCarVariant(v);
    assert.ok(carTris(g) <= CAR_TRI_BUDGET, `car ${v}: ${carTris(g)} tris`);
    assert.ok(Math.abs(bbox(g).min.y) <= 0.02, `car ${v}: min.y`);
  }
  const g = buildCarVariant(0);
  const pos = g.getAttribute('position');
  let nose = 0;
  let rear = 0;
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i);
    const w = Math.abs(pos.getX(i)) * 2;
    if (z > 2.2) nose = Math.max(nose, w);
    if (z < -1.0 && z > -2.0 && pos.getY(i) > 0.3) rear = Math.max(rear, w);
  }
  assert.ok(nose < 0.65 * rear, `nose ${nose.toFixed(2)} m < 0.65 × rear fender ${rear.toFixed(2)} m`);
});

test('10D-4 zero-alloc lightningAt(t, out) matches lightningAt(t); thunder 1.5–3.0 s after each strike, pan cos(az + yaw), silent paused, reset', () => {
  const out = { k: 0, start: 0, azimuth: 0, intensity: 0 };
  for (let t = 0; t < 400; t += 0.37) {
    const a = lightningAt(t);
    const b = lightningAt(t, out);
    assert.equal(b, out, 'returns the passed struct');
    assert.deepEqual({ ...b }, a, `t ${t.toFixed(2)}`);
  }
  assert.ok(Math.abs(thunderPanRaw(0, 0) - 1) < 1e-9, 'az 0, yaw 0 → dead right');
  assert.ok(Math.abs(thunderPanRaw(-Math.PI / 2, Math.PI / 2) - 1) < 1e-9, 'az −π/2, yaw +π/2 → dead right');
  const th = new ThunderScheduler();
  const sample = { k: 0, start: 0, azimuth: 0, intensity: 0 };
  let strikes = 0;
  let fired = 0;
  let strikeT = -1;
  for (let t = 0; t < 600; t += 0.02) {
    lightningAt(t, sample);
    const before = th.fireAt;
    if (th.step(t, sample, true, 0.3)) {
      fired++;
      const dt = t - strikeT;
      assert.ok(dt >= 1.5 - 0.03 && dt <= 3.0 + 0.03, `rumble ${dt.toFixed(2)} s after the strike`);
      assert.ok(Math.abs(th.pan - Math.max(-0.85, Math.min(0.85, Math.cos(th.azimuth + 0.3)))) < 1e-9, 'pan = clamp(cos(az + yaw))');
    }
    if (th.fireAt > 0 && th.fireAt !== before) {
      strikes++;
      strikeT = t;
    }
  }
  assert.ok(strikes >= 20 && fired === strikes, `every strike rumbles once (${strikes} strikes, ${fired} rumbles)`);
  // Paused: armed but silent; reset disarms (sector switch).
  const p = new ThunderScheduler();
  let silent = true;
  for (let t = 0; t < 120; t += 0.02) {
    lightningAt(t, sample);
    if (p.step(t, sample, false, 0)) silent = false;
  }
  assert.ok(silent, 'silent while paused');
  p.reset();
  assert.equal(p.fireAt, -1, 'reset disarms');
});

test('10D-4 breaker spark nodes (8–12, outward normals, alley-side first) and dripping canopy lips (≤ 48) in every sector', () => {
  for (const { L, loop } of BUILT) {
    const tag = `loop ${loop} S${L.sector.index}`;
    assert.ok(L.sparkNodes.length >= 8 && L.sparkNodes.length <= 12, `${tag}: ${L.sparkNodes.length} spark nodes`);
    for (const n of L.sparkNodes) {
      assert.ok(Math.abs(Math.hypot(n.nx, n.nz) - 1) < 1e-6, 'unit outward normal');
      assert.ok(n.pos.y > 0.5 && n.pos.y < 4, `${tag}: breaker at wall height (${n.pos.y.toFixed(2)})`);
    }
    assert.ok(L.canopyDripEdges.length >= 1 && L.canopyDripEdges.length <= 48, `${tag}: ${L.canopyDripEdges.length} drip lips`);
    for (const e of L.canopyDripEdges) assert.ok(e.y > 2.8 && e.y < 3.4 && Math.hypot(e.x1 - e.x0, e.z1 - e.z0) >= 1, `${tag}: lip at ${e.y.toFixed(2)} m`);
  }
});
