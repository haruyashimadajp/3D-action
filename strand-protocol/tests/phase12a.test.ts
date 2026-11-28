/**
 * Phase 12A: per-sector PMREM IBL, Mega-Billboard wet-street reflection ribbons, zero-UV automotive detail,
 * upgraded parallax interiors, RCAS + anamorphic streak inside KineticPostFX, sector-tinted fog / sky horizon,
 * and the Phase 13 `applyStrandMaterialHooks` contract (+0 draw calls, +0 passes).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as THREE from 'three';
import { COLORS, RENDER } from '../src/config/constants';
import { SECTORS, defaultSave, sanitizeSave } from '../src/config/skills';
import { VEHICLE_DETAIL, generateVehicleDetailSet, type PbrTextureSet, type ProceduralTextureLibrary } from '../src/engine/ProceduralTextures';
import { KineticPostFXShader, anamorphicStrength, sectorFogColor } from '../src/engine/Renderer';
import { AD_HUES, CityBuilder, type MegaBillboardRecord, type SectorLayout } from '../src/world/CityBuilder';

function mockPbr(): Required<PbrTextureSet> {
  return { map: new THREE.Texture(), roughnessMap: new THREE.Texture(), normalMap: new THREE.Texture(), emissiveMap: new THREE.Texture() };
}
function mockTextures(withDetail = false): ProceduralTextureLibrary {
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
    ...(withDetail ? { vehicleDetail: { normalMap: new THREE.Texture(), roughnessMap: new THREE.Texture() } } : {}),
  };
}

const CITY = new CityBuilder(mockTextures());
const CITY_SRC = readFileSync('src/world/CityBuilder.ts', 'utf8');
const RENDERER_SRC = readFileSync('src/engine/Renderer.ts', 'utf8');
const MAIN_SRC = readFileSync('src/main.ts', 'utf8');

/** Source text of a class method / function from its signature to the next blank-line-separated member. */
function methodSrc(src: string, signature: string): string {
  const i = src.indexOf(signature);
  assert.ok(i >= 0, `${signature} exists`);
  const next = src.indexOf('\n  }\n', i);
  return src.slice(i, next < 0 ? undefined : next);
}

const MEGA_RANGE_M = 90;
const STRAND_KEY_ONCE = /^(?:(?!-strand-glb).)*-strand-glb$/s;
const MEGA_MAX_Y = 42;
const eligible = (r: MegaBillboardRecord): boolean => r.kind !== 'RING' && r.y <= MEGA_MAX_Y;

/** Street-level probe points: the spawn plus a spread of points in front of eligible billboards. */
function probes(L: SectorLayout): THREE.Vector3[] {
  const out = [L.playerSpawn.clone().setY(L.playerSpawn.y + 1.7)];
  const el = L.megaBillboards.filter(eligible);
  const step = Math.max(1, Math.floor(el.length / 6));
  for (let i = 0; i < el.length; i += step) {
    const r = el[i];
    out.push(new THREE.Vector3(r.x + r.nx * 14, 1.7, r.z + r.nz * 14));
  }
  out.push(new THREE.Vector3(L.playerSpawn.x + 400, 1.7, L.playerSpawn.z + 400)); // far outside: may select nothing
  return out;
}

// =============================================================================================
// 1. Billboard reflection selector across 5 sectors × Loops 0..2
// =============================================================================================
/** Oracle screen list: pieces sharing a `group` merged into one screen (area-weighted centre, summed normal). */
interface Screen { idx: number[]; x: number; y: number; z: number; nx: number; nz: number; two: boolean; cell: number }
function screens(L: SectorLayout): Screen[] {
  const out: Screen[] = [];
  const byGroup = new Map<number, Screen & { a: number }>();
  L.megaBillboards.forEach((r, i) => {
    if (!eligible(r)) return;
    const a = Math.max(1e-3, r.w * r.h);
    const g = r.group >= 0 ? byGroup.get(r.group) : undefined;
    if (g) {
      const t = g.a + a;
      g.x = (g.x * g.a + r.x * a) / t; g.y = (g.y * g.a + r.y * a) / t; g.z = (g.z * g.a + r.z * a) / t;
      const r0 = L.megaBillboards[g.idx[0]];
      g.a = t; g.nx += r.nx; g.nz += r.nz; g.two ||= r.kind === 'BLADE' || r.nx * r0.nx + r.nz * r0.nz < Math.SQRT1_2; g.idx.push(i);
      return;
    }
    const sc = { idx: [i], x: r.x, y: r.y, z: r.z, nx: r.nx, nz: r.nz, two: r.kind === 'BLADE', cell: r.cell, a };
    if (r.group >= 0) byGroup.set(r.group, sc);
    out.push(sc);
  });
  for (const sc of out) { const l = Math.hypot(sc.nx, sc.nz) || 1; sc.nx /= l; sc.nz /= l; }
  return out;
}

test('12A-2 nearest-8 Mega-Billboard selector: ≤ 8, within 90 m, facing, one slot per screen group, exact nearest set, AD_HUES colours', () => {
  const col = new THREE.Color();
  let selectedTotal = 0;
  for (let s = 1; s <= SECTORS.length; s++) {
    for (let loop = 0; loop <= 2; loop++) {
      const L = CITY.buildSector(s, loop);
      const scr = screens(L);
      for (const cam of probes(L)) {
        CITY.update(10, cam);
        const n = CITY.uMegaReflCount.value;
        assert.ok(Number.isInteger(n) && n >= 0 && n <= 8, `S${s} L${loop}: count ${n} ≤ 8`);
        // Brute-force oracle: facing (or two-sided) screens within 90 m, nearest first.
        const cand = scr
          .map((sc) => ({ sc, d: Math.hypot(sc.x - cam.x, sc.y - cam.y, sc.z - cam.z), f: (cam.x - sc.x) * sc.nx + (cam.z - sc.z) * sc.nz }))
          .filter((o) => o.d <= MEGA_RANGE_M && (o.sc.two || o.f >= 1e-3))
          .sort((a, b) => a.d - b.d);
        assert.equal(n, Math.min(8, cand.length), `S${s} L${loop}: selected count equals the oracle`);
        const kth = n > 0 ? cand[n - 1].d : 0;
        const groups = new Set<number>();
        for (let k = 0; k < n; k++) {
          const idx = CITY.megaReflSrc[k];
          const sc = scr.find((o) => o.idx.includes(idx));
          assert.ok(sc, `S${s} L${loop}: slot ${k} maps to an eligible screen (no RING / y > 42 m)`);
          assert.equal(sc!.idx[0], idx, 'slot source = first piece of its screen');
          assert.ok(!groups.has(sc!.idx[0]), 'one slot per screen (L-corner halves never stack)');
          groups.add(sc!.idx[0]);
          const p = CITY.uMegaReflPos.value[k];
          assert.ok(Math.hypot(p.x - sc!.x, p.y - sc!.y, p.z - sc!.z) < 1e-3, 'slot position = screen centre');
          const d = Math.hypot(p.x - cam.x, p.y - cam.y, p.z - cam.z);
          assert.ok(d <= MEGA_RANGE_M + 1e-3, 'within 90 m');
          assert.ok(d <= kth + 1e-3, 'one of the nearest 8');
          const nr = CITY.uMegaReflNrm.value[k];
          assert.ok(nr.z > 0.5 || (cam.x - p.x) * nr.x + (cam.z - p.z) * nr.y >= -1e-3, 'one-sided screens face the camera');
          assert.ok(p.w > 0 && CITY.uMegaReflCol.value[k].w > 0, 'half-width / half-height > 0');
          // Colour = linear AD_HUES[cell] × intensity: same chromaticity.
          col.setHex(AD_HUES[sc!.cell]);
          const c = CITY.uMegaReflCol.value[k];
          const kx = c.x / Math.max(col.r, 1e-6);
          for (const [a, b] of [[c.y, col.g], [c.z, col.b]] as const) {
            if (b > 0.02) assert.ok(Math.abs(a / b - kx) / kx < 0.02, `S${s}: slot ${k} colour resolves via AD_HUES[${sc!.cell}]`);
          }
        }
        selectedTotal += n;
      }
    }
  }
  assert.ok(selectedTotal > 0, 'billboards are actually selected somewhere');
});

test('12A-2 reflection gate: LOW quality and lowLatency both force uMegaReflEnabled = 0 (uniform toggle, no recompile)', () => {
  const c = CITY;
  c.setQuality('HIGH');
  c.setLowLatency(false);
  assert.equal(c.uMegaReflEnabled.value, 1);
  c.setQuality('LOW');
  assert.equal(c.uMegaReflEnabled.value, 0, 'LOW');
  c.setQuality('MEDIUM');
  assert.equal(c.uMegaReflEnabled.value, 1, 'MEDIUM');
  c.setLowLatency(true);
  assert.equal(c.uMegaReflEnabled.value, 0, 'lowLatency');
  c.setQuality('HIGH');
  assert.equal(c.uMegaReflEnabled.value, 0, 'HIGH + lowLatency stays off');
  c.setLowLatency(false);
  assert.equal(c.uMegaReflEnabled.value, 1);
});

test('12A-2 road shader: world normal via transformNormalByInverseViewMatrix, gated ribbon loop, no undefined helpers; update() allocation-free', () => {
  const road = methodSrc(CITY_SRC, 'private createRoadMaterial(');
  assert.match(road, /transformNormalByInverseViewMatrix\(normal, viewMatrix\)/);
  assert.match(road, /uMegaReflEnabled > 0\.5/);
  assert.match(road, /uMegaReflPos\[i\]/);
  assert.match(road, /uMegaReflNrm\[i\]/, 'per-fragment front-of-screen test');
  assert.match(road, /smoothstep\(3\.0, 8\.0, cameraPosition\.y - vCityWorld\.y\)/, 'street-level camera-height fade');
  assert.doesNotMatch(road, /sRipGrad/);
  assert.doesNotMatch(CITY_SRC, /[^a-zA-Z_.]hash\(/, 'no undefined GLSL hash()');
  const upd = methodSrc(CITY_SRC, '  update(simTime: number, cameraPos: THREE.Vector3)');
  assert.doesNotMatch(upd, /new [A-Z]|\.clone\(\)|\[\]|=>/, 'update() allocates nothing');
});

// =============================================================================================
// 2. Automotive PBR detail, parallax interiors, sky horizon
// =============================================================================================
test('12A-3 vehicleDetail: 512² normal + roughness DataTextures, unit normals, four distinct quadrants', () => {
  const t0 = performance.now();
  const vd = generateVehicleDetailSet(1);
  const ms = performance.now() - t0;
  assert.ok(ms < 1500, `generation ${ms.toFixed(0)} ms`);
  for (const t of [vd.normalMap, vd.roughnessMap]) {
    assert.equal(t.image.width, 512);
    assert.equal(t.image.height, 512);
    assert.equal((t.image.data as Uint8Array).length, 512 * 512 * 4);
    assert.equal(t.colorSpace, THREE.NoColorSpace);
    assert.ok(t.generateMipmaps);
  }
  assert.equal(VEHICLE_DETAIL.SIZE, 512);
  const N = vd.normalMap.image.data as Uint8Array;
  const R = vd.roughnessMap.image.data as Uint8Array;
  let worst = 0;
  for (let i = 0; i < 512 * 512; i += 7) {
    const x = N[i * 4] / 127.5 - 1, y = N[i * 4 + 1] / 127.5 - 1, z = N[i * 4 + 2] / 127.5 - 1;
    worst = Math.max(worst, Math.abs(Math.hypot(x, y, z) - 1));
    assert.ok(z > 0, 'normals face out of the surface');
  }
  assert.ok(worst < 0.03, `|n| ≈ 1 (worst ${worst.toFixed(3)})`);
  // Per-quadrant mean roughness / metalness differ (carbon · honeycomb · brushed metal · clearcoat).
  const quad = (u0: number, v0: number): { g: number; b: number } => {
    let g = 0, b = 0, n = 0;
    for (let y = v0 * 512; y < v0 * 512 + 256; y += 2) for (let x = u0 * 512; x < u0 * 512 + 256; x += 2) {
      const o = (y * 512 + x) * 4;
      g += R[o + 1]; b += R[o + 2]; n++;
    }
    return { g: g / n / 255, b: b / n / 255 };
  };
  const q0 = quad(...VEHICLE_DETAIL.Q0_CARBON), q1 = quad(...VEHICLE_DETAIL.Q1_HONEYCOMB);
  const q2 = quad(...VEHICLE_DETAIL.Q2_BRUSHED), q3 = quad(...VEHICLE_DETAIL.Q3_CLEARCOAT);
  assert.ok(q2.b > 0.7, 'brushed metal quadrant is metallic');
  assert.ok(q3.g < 0.25 && q3.b < 0.05, 'clearcoat quadrant is glossy dielectric');
  assert.ok(q1.g > q0.g + 0.2, 'honeycomb grille is rougher than carbon');
});

test('12A-3 zero-UV car shader: normalMap / roughnessMap stay null, detail via custom uniforms + textureGrad, toggled by uHasVehicleDetail', () => {
  const findCar = (c: CityBuilder): THREE.MeshStandardMaterial => {
    let m: THREE.MeshStandardMaterial | null = null;
    c.root.traverse((o) => {
      const mat = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (!m && mat && !Array.isArray(mat) && mat.customProgramCacheKey && mat.customProgramCacheKey().startsWith('strand-car')) m = mat;
    });
    assert.ok(m, 'car material found');
    return m as THREE.MeshStandardMaterial;
  };
  const compile = (mat: THREE.MeshStandardMaterial): { vertexShader: string; fragmentShader: string; uniforms: Record<string, THREE.IUniform> } => {
    const shader = {
      vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader,
      uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.standard.uniforms),
    };
    mat.onBeforeCompile(shader as never, {} as never);
    return shader;
  };
  for (const [c, has] of [[CITY, 0], [new CityBuilder(mockTextures(true)), 1]] as const) {
    const mat = findCar(c);
    assert.equal(mat.normalMap, null, 'cars carry no uv: normalMap must stay null');
    assert.equal(mat.roughnessMap, null);
    const sh = compile(mat);
    assert.ok(sh.uniforms.uDetailNormal?.value, 'uDetailNormal bound to a texture');
    assert.ok(sh.uniforms.uDetailRough?.value, 'uDetailRough bound to a texture');
    assert.equal(sh.uniforms.uHasVehicleDetail.value, has);
    assert.match(sh.fragmentShader, /textureGrad\(uDetailNormal/);
    assert.match(sh.vertexShader, /vLocalN/);
    assert.doesNotMatch(sh.vertexShader + sh.fragmentShader, /[^a-zA-Z_.]hash\(|sRipGrad/);
    assert.doesNotMatch(sh.fragmentShader, /vUv\b/, 'no uv varying referenced');
  }
});

test('12A-3 strandInterior: four col-keyed room profiles, strandHash LED blink, STRAND_LITE-gated close rain streaks', () => {
  const i = CITY_SRC.indexOf('vec3 strandInterior(');
  assert.ok(i >= 0);
  const body = CITY_SRC.slice(i, CITY_SRC.indexOf('\n      }\n', i));
  assert.match(body, /\bcol\b/);
  assert.match(body, /strandHash\(/);
  assert.match(body, /uTime/);
  assert.match(CITY_SRC, /#ifndef STRAND_LITE[\s\S]{0,4000}22\.0/, 'close-range (< 22 m) rain streaks live behind STRAND_LITE');
});

test('12A-4 sky horizon matches scene fog after setSectorAtmosphere (per sector palette)', () => {
  const fog = new THREE.Color();
  const seen = new Set<string>();
  const firsts = new Set<number>();
  for (let s = 1; s <= SECTORS.length; s++) {
    const L = CITY.buildSector(s, 0);
    sectorFogColor(L.stats.palette, fog);
    CITY.setSkyHorizon(fog);
    assert.ok(CITY.skyHorizon.equals(fog), `S${s}: SkyDome uHorizon === scene.fog.color`);
    assert.notEqual(CITY.skyHorizon, fog, 'copied, not aliased');
    seen.add(fog.getHexString());
    firsts.add(L.stats.palette[0]);
    // 12 % of palette[0] blended perceptually (sRGB space) into FOG_ABYSS (sectors sharing palette[0] share the tint).
    const want = new THREE.Color(COLORS.FOG_ABYSS).convertLinearToSRGB().lerp(new THREE.Color(L.stats.palette[0]).convertLinearToSRGB(), 0.12).convertSRGBToLinear();
    assert.ok(Math.abs(want.r - fog.r) + Math.abs(want.g - fog.g) + Math.abs(want.b - fog.b) < 1e-6, `S${s}: fog = mix(FOG_ABYSS, palette[0], 0.12)`);
  }
  assert.equal(seen.size, firsts.size, 'one atmosphere tint per distinct district key colour');
  // main.ts wiring: one PMREM bake per sector change, fog → sky horizon, ribbons follow lowLatency, sharpen applied.
  const bs = methodSrc(MAIN_SRC, 'private buildSector(index: number)');
  assert.match(bs, /this\.renderer\.buildEnvironment\(palette, index\)/);
  assert.match(bs, /index !== this\.envSector/);
  assert.match(bs, /this\.city\.setSkyHorizon\(this\.renderer\.setSectorAtmosphere\(palette\)\)/);
  assert.match(MAIN_SRC, /this\.city\.setLowLatency\(s\.lowLatency\)/);
  assert.match(MAIN_SRC, /this\.renderer\.setSharpen\(s\.sharpen\)/);
  // Leak-free bake: the previous env target is disposed before the new texture is installed.
  const env = methodSrc(RENDERER_SRC, 'buildEnvironment(sectorPalette');
  const d = env.search(/this\.envTarget\??\.dispose\(\)/);
  assert.ok(d >= 0 && d < env.indexOf('this.scene.environment ='), 'previous envTarget disposed before the new texture is installed');
  assert.match(env, /1337 \+ sectorIndex \* 7919/);
  assert.equal(RENDER.ENV_CUBE_SIZE, 256);
  assert.equal(RENDER.SHADOW_FRUSTUM_HALF, 30);
});

// =============================================================================================
// 3. RCAS + anamorphic gating, sharpen setting
// =============================================================================================
test('12A-4 KineticPostFX: RCAS on raw tDiffuse before grading, anamorphic streak gated off on LOW / lowLatency', () => {
  const fs = KineticPostFXShader.fragmentShader;
  const rcas = fs.indexOf('// 12A RCAS —');
  const streak = fs.indexOf('// 12A ANAMORPHIC');
  const bt = fs.indexOf('uBulletTime > 0.0');
  assert.ok(rcas > 0 && streak > rcas && bt > streak, 'RCAS → streak → bullet-time / grading');
  const block = fs.slice(rcas, bt);
  assert.match(block, /texture2D\(tDiffuse|texture\(tDiffuse/);
  assert.match(block, /uSharpen/);
  assert.match(block, /uAnamorphic/);
  assert.ok(fs.lastIndexOf('#ifndef LITE', rcas) > fs.lastIndexOf('#endif', rcas), 'RCAS sits inside #ifndef LITE');
  assert.ok('uSharpen' in KineticPostFXShader.uniforms && 'uAnamorphic' in KineticPostFXShader.uniforms);
  assert.equal(RENDER.RCAS_SHARPEN, 0.28);
  assert.equal(anamorphicStrength('LOW', false), 0);
  assert.equal(anamorphicStrength('HIGH', true), 0);
  assert.equal(anamorphicStrength('MEDIUM', true), 0);
  assert.equal(anamorphicStrength('HIGH', false), RENDER.ANAMORPHIC);
  assert.equal(anamorphicStrength('MEDIUM', false), RENDER.ANAMORPHIC);
  assert.equal(RENDER.ANAMORPHIC, 0.14);
  // Settings: sharpen defaults ON, persists through a save round-trip, older saves fall back to ON.
  assert.equal(defaultSave().settings.sharpen, true);
  const save = defaultSave();
  save.settings.sharpen = false;
  assert.equal(sanitizeSave(JSON.parse(JSON.stringify(save))).settings.sharpen, false);
  const old = JSON.parse(JSON.stringify(defaultSave()));
  delete old.settings.sharpen;
  assert.equal(sanitizeSave(old).settings.sharpen, true);
  assert.equal(sanitizeSave({ settings: { sharpen: 'yes' } }).settings.sharpen, true);
});

// =============================================================================================
// Phase 13 contract
// =============================================================================================
test('Phase 13 applyStrandMaterialHooks: chains onBeforeCompile, injects city lights, composes the cache key, idempotent, never on custom kits', () => {
  for (const wet of [false, true]) {
    const mat = new THREE.MeshStandardMaterial({ map: new THREE.Texture() });
    let prevCalled = 0;
    mat.onBeforeCompile = (sh) => {
      prevCalled++;
      sh.fragmentShader = `// prev-hook\n${sh.fragmentShader}`;
    };
    const prevKey = mat.customProgramCacheKey();
    const out = CITY.applyStrandMaterialHooks(mat, wet ? { wetClearcoat: true } : undefined);
    assert.equal(out, mat);
    assert.equal(mat.customProgramCacheKey(), `${prevKey}-strand-glb${wet ? '-wet' : ''}`);
    CITY.applyStrandMaterialHooks(mat, wet ? { wetClearcoat: true } : undefined);
    assert.equal(mat.customProgramCacheKey(), `${prevKey}-strand-glb${wet ? '-wet' : ''}`, 'second application is a no-op');
    const shader = {
      vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader,
      uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.standard.uniforms),
    };
    mat.onBeforeCompile(shader as never, {} as never);
    assert.equal(prevCalled, 1, 'previous hook chained exactly once');
    assert.match(shader.fragmentShader, /prev-hook/);
    assert.ok('uCityLightPos' in shader.uniforms, 'city lights injected');
    assert.match(shader.fragmentShader, /uCityLightPos/);
    assert.doesNotMatch(shader.vertexShader, /attribute float aPart/, 'no custom aPart attribute required');
  }
  // A clone (GLTFLoader assignFinalMaterial) loses the own-property hook but can be hooked again.
  const orig = new THREE.MeshStandardMaterial();
  CITY.applyStrandMaterialHooks(orig);
  const cl = orig.clone();
  CITY.applyStrandMaterialHooks(cl);
  assert.ok(STRAND_KEY_ONCE.test(cl.customProgramCacheKey()), 'clone re-hooked exactly once');
  assert.match(cl.customProgramCacheKey(), /-strand-glb$/);
  // Never applied to the existing custom-shader kits.
  const keys: string[] = [];
  CITY.root.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    for (const mm of Array.isArray(m) ? m : m ? [m] : []) keys.push(mm.customProgramCacheKey());
  });
  assert.ok(keys.includes('strand-roofmech-v1'), 'RoofMechKit key unchanged');
  assert.ok(keys.every((k) => !k.includes('-strand-glb')), 'no existing city material was hooked');
});
