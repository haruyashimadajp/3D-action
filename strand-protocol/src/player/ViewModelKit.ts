/**
 * STRAND // PROTOCOL — 6B-1 view-model modelling kit.
 *
 * Hard-surface parts are built from bevelled extrusions (ExtrudeGeometry, bevel 2–4 mm, 2 segments),
 * lathes (barrels, muzzle brakes, coils, canisters), tubes (cables, fibres) and capsules (finger phalanges),
 * then baked into ONE geometry per material with per-vertex data:
 *   color  — tint (multiplies the zoned PBR albedo)
 *   aSurf  — roughness multiplier · metalness multiplier · self-glow (vertex colour as emissive)
 *   aZone  — texture zone 0–3 of the 512² zoned PBR set
 *   aGlow  — energy glow (constant · charge-modulated) · ammo-bar glow
 *   aAnim  — ammo bar (rear z, flag) · shell (index, flag) / claw (flag −1) · hand-held shell (flag 2)
 * UVs are box-proportional (metres / tile from the dominant normal axis), so tiny parts never stretch.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { PbrTextureSet } from '../engine/ProceduralTextures';

export interface PartOpts {
  tint: number;
  zone: number;
  /** Roughness / metalness multipliers on the zone texture (default 1, 1). */
  rough?: number;
  metal?: number;
  /** Vertex colour as emissive (status LEDs, laser lens, gold claws). */
  self?: number;
  /** Energy glow: constant, charge-modulated, ammo bar. */
  glow?: readonly [number, number, number];
  /** Ammo bar (rearZ, 1, 0, 0) · shell (0, 0, index, 1) · claw (0, 0, 0, −1). */
  anim?: readonly [number, number, number, number];
  /** Metres per texture tile (default 0.09). */
  tile?: number;
}

const _c = new THREE.Color();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3(1, 1, 1);
const _p = new THREE.Vector3();
const _d = new THREE.Vector3();
const Y_UP = new THREE.Vector3(0, 1, 0);

/** Accumulates parts for one draw (one material). */
export class MeshKit {
  private readonly parts: THREE.BufferGeometry[] = [];

  add(geo: THREE.BufferGeometry, o: PartOpts, matrix?: THREE.Matrix4): this {
    let g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    if (matrix) g.applyMatrix4(matrix);
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const nor = g.getAttribute('normal') as THREE.BufferAttribute;
    const n = pos.count;
    const tile = o.tile ?? 0.09;
    const uv = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const ax = Math.abs(nor.getX(i));
      const ay = Math.abs(nor.getY(i));
      const az = Math.abs(nor.getZ(i));
      const x = pos.getX(i) / tile;
      const y = pos.getY(i) / tile;
      const z = pos.getZ(i) / tile;
      if (ax >= ay && ax >= az) uv.set([z, y], i * 2);
      else if (ay >= az) uv.set([x, z], i * 2);
      else uv.set([x, y], i * 2);
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    _c.setHex(o.tint);
    const fill = (size: number, vals: readonly number[]): THREE.BufferAttribute => {
      const a = new Float32Array(n * size);
      for (let i = 0; i < n; i++) for (let k = 0; k < size; k++) a[i * size + k] = vals[k];
      return new THREE.BufferAttribute(a, size);
    };
    g.setAttribute('color', fill(3, [_c.r, _c.g, _c.b]));
    g.setAttribute('aSurf', fill(3, [o.rough ?? 1, o.metal ?? 1, o.self ?? 0]));
    g.setAttribute('aZone', fill(1, [o.zone]));
    g.setAttribute('aGlow', fill(3, o.glow ?? [0, 0, 0]));
    g.setAttribute('aAnim', fill(4, o.anim ?? [0, 0, 0, 0]));
    this.parts.push(g);
    return this;
  }

  get empty(): boolean {
    return this.parts.length === 0;
  }

  build(): THREE.BufferGeometry {
    const g = this.parts.length ? (mergeGeometries(this.parts, false) as THREE.BufferGeometry) : new THREE.BufferGeometry();
    for (const p of this.parts) p.dispose();
    this.parts.length = 0;
    g.computeBoundingSphere();
    return g;
  }
}

// =============================================================================================
// Geometry helpers (gun space: +Z toward the player, −Z toward the muzzle; "f" = forward = −z)
// =============================================================================================
export function at(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.Matrix4 {
  _q.setFromEuler(new THREE.Euler(rx, ry, rz, 'XYZ'));
  return new THREE.Matrix4().compose(_p.set(x, y, z), _q, _s);
}

/** Box with bevelled edges (overall size w × h × d), centred. */
export function bevelBox(w: number, h: number, d: number, b = 0.003): THREE.BufferGeometry {
  const bb = Math.min(b, w * 0.3, h * 0.3, d * 0.3);
  const sh = new THREE.Shape();
  const hw = w / 2 - bb;
  const hh = h / 2 - bb;
  sh.moveTo(-hw, -hh);
  sh.lineTo(hw, -hh);
  sh.lineTo(hw, hh);
  sh.lineTo(-hw, hh);
  sh.closePath();
  const g = new THREE.ExtrudeGeometry(sh, { depth: Math.max(1e-4, d - 2 * bb), bevelEnabled: true, bevelThickness: bb, bevelSize: bb, bevelSegments: 2, curveSegments: 1 });
  g.translate(0, 0, -(d - 2 * bb) / 2);
  return g;
}

/**
 * Side-profile extrusion: `pts` are (f, y) with f = forward (−z), extruded across x (overall `width`), bevelled.
 * Optional holes (same coordinates) cut windows / trigger-guard loops.
 */
export function profile(pts: ReadonlyArray<readonly [number, number]>, width: number, b = 0.003, holes: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = []): THREE.BufferGeometry {
  const sh = new THREE.Shape(pts.map(([f, y]) => new THREE.Vector2(f, y)));
  for (const h of holes) sh.holes.push(new THREE.Path(h.map(([f, y]) => new THREE.Vector2(f, y))));
  const depth = Math.max(1e-4, width - 2 * b);
  const g = new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: b > 0, bevelThickness: b, bevelSize: b * 0.8, bevelSegments: 2, curveSegments: 6 });
  // shape (f, y, e) → gun (x = e − depth/2, y, z = −f): rotation about Y by +90°.
  g.rotateY(Math.PI / 2);
  // After the rotation x = e, z = −f.
  g.translate(-depth / 2, 0, 0);
  return g;
}

/** Front-view extrusion: `pts` are (x, y), extruded along −z over `depth` (holes allowed) — sight hoods, plates. */
export function frontPlate(pts: ReadonlyArray<readonly [number, number]>, depth: number, b = 0.002, holes: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = []): THREE.BufferGeometry {
  const sh = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
  for (const h of holes) sh.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, y))));
  const d = Math.max(1e-4, depth - 2 * b);
  const g = new THREE.ExtrudeGeometry(sh, { depth: d, bevelEnabled: b > 0, bevelThickness: b, bevelSize: b * 0.8, bevelSegments: 2, curveSegments: 8 });
  g.translate(0, 0, -d / 2);
  return g;
}

/** Rounded rectangle outline (x, y) centred, radius r. */
export function roundRect(w: number, h: number, r: number, seg = 4): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const cs: Array<[number, number, number]> = [[w / 2 - r, h / 2 - r, 0], [-w / 2 + r, h / 2 - r, 90], [-w / 2 + r, -h / 2 + r, 180], [w / 2 - r, -h / 2 + r, 270]];
  for (const [cx, cy, a0] of cs) {
    for (let k = 0; k <= seg; k++) {
      const a = ((a0 + (90 * k) / seg) * Math.PI) / 180;
      out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
  }
  return out;
}

/** Lathe around the forward axis: `pts` are (radius, f) with f = forward (−z). */
export function lathe(pts: ReadonlyArray<readonly [number, number]>, seg = 20, phiStart = 0, phiLength = Math.PI * 2): THREE.BufferGeometry {
  const g = new THREE.LatheGeometry(pts.map(([r, f]) => new THREE.Vector2(r, f)), seg, phiStart, phiLength);
  // lathe axis +Y → −Z (forward): rotate about X by −90°.
  g.rotateX(-Math.PI / 2);
  return g;
}

/** Simple tube along a polyline (smoothed). */
export function tube(points: ReadonlyArray<THREE.Vector3>, r: number, seg = 24, radial = 6): THREE.BufferGeometry {
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.slice()), seg, r, radial, false);
}

/** Capsule spanning a → b (finger phalanges). */
export function capsule(a: THREE.Vector3, b: THREE.Vector3, r: number, cap = 4, radial = 10): THREE.BufferGeometry {
  const len = Math.max(1e-4, a.distanceTo(b));
  const g = new THREE.CapsuleGeometry(r, len, cap, radial);
  _d.subVectors(b, a).normalize();
  _q.setFromUnitVectors(Y_UP, _d);
  g.applyMatrix4(_m.compose(_p.addVectors(a, b).multiplyScalar(0.5), _q, _s));
  return g;
}

/** Cylinder spanning a → b with radii r0 (at a) / r1 (at b). */
export function cylinder(a: THREE.Vector3, b: THREE.Vector3, r0: number, r1: number, radial = 12, open = false): THREE.BufferGeometry {
  const len = Math.max(1e-4, a.distanceTo(b));
  const g = new THREE.CylinderGeometry(r1, r0, len, radial, 1, open);
  _d.subVectors(b, a).normalize();
  _q.setFromUnitVectors(Y_UP, _d);
  g.applyMatrix4(_m.compose(_p.addVectors(a, b).multiplyScalar(0.5), _q, _s));
  return g;
}

export function torus(r: number, tube: number, radial = 8, tubular = 28): THREE.BufferGeometry {
  return new THREE.TorusGeometry(r, tube, radial, tubular);
}

/** Picatinny rail: base + cross teeth every 10 mm, along f ∈ [f0, f1] at height y (top of base). */
export function addRail(kit: MeshKit, f0: number, f1: number, y: number, x = 0, tint = 0x2c323c): void {
  const len = f1 - f0;
  kit.add(bevelBox(0.016, 0.004, len, 0.0012), { tint, zone: 0, rough: 0.9 }, at(x, y - 0.002, -(f0 + f1) / 2));
  for (let f = f0 + 0.004; f < f1 - 0.003; f += 0.01) {
    kit.add(bevelBox(0.021, 0.0036, 0.0052, 0.0009), { tint, zone: 0 }, at(x, y + 0.0016, -f));
  }
}

// =============================================================================================
// Materials
// =============================================================================================
export interface KitUniforms {
  [k: string]: { value: unknown };
  /** Energy colour × intensity (linear). */
  uEnergy: { value: THREE.Color };
  uCharge: { value: number };
  uBarColor: { value: THREE.Color };
  /** Ammo fraction (bar length) and visible shell count. */
  uAmmo: { value: number };
  uShells: { value: number };
  /** Anchor claw opening 0..1. */
  uClaw: { value: number };
  /** 7A-5: shotgun shell held in the left glove (visible ≥ 0.5). */
  uHand: { value: number };
}

export function createKitUniforms(): KitUniforms {
  return {
    uEnergy: { value: new THREE.Color() },
    uCharge: { value: 1 },
    uBarColor: { value: new THREE.Color() },
    uAmmo: { value: 1 },
    uShells: { value: 4 },
    uClaw: { value: 0 },
    uHand: { value: 0 },
  };
}

/** Zoned PBR material (one draw per kit mesh). */
export function kitMaterial(tex: PbrTextureSet, u: KitUniforms, key: string, normalScale = 1): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    map: tex.map,
    roughnessMap: tex.roughnessMap,
    normalMap: tex.normalMap,
    normalScale: new THREE.Vector2(normalScale, normalScale),
    roughness: 1,
    metalness: 1,
    envMapIntensity: 1.3,
  });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec3 aSurf;
        attribute float aZone;
        attribute vec3 aGlow;
        attribute vec4 aAnim;
        varying vec3 vSurf;
        varying float vZone;
        varying vec3 vGlow;
        varying vec2 vKitUv;
        uniform float uAmmo;
        uniform float uShells;
        uniform float uClaw;
        uniform float uHand;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vSurf = aSurf;
        vZone = aZone;
        vGlow = aGlow;
        vKitUv = uv;
        // Diegetic ammo bar: length follows the magazine (anchored at its rear end).
        if (aAnim.y > 0.5) transformed.z = aAnim.x + (transformed.z - aAnim.x) * max(uAmmo, 1e-4);
        // Side-saddle shells beyond the loaded count collapse out of sight.
        if (aAnim.w > 1.5) { if (uHand < 0.5) transformed = vec3(0.0, -50.0, 0.0); }
        else if (aAnim.w > 0.5 && aAnim.z > uShells - 0.5) transformed = vec3(0.0, -50.0, 0.0);
        // Anchor claws open radially (tips more than roots).
        if (aAnim.w < -0.5) transformed.xy *= 1.0 + uClaw * clamp(-transformed.z * 22.0, 0.0, 1.6);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform vec3 uEnergy;
        uniform float uCharge;
        uniform vec3 uBarColor;
        varying vec3 vSurf;
        varying float vZone;
        varying vec3 vGlow;
        varying vec2 vKitUv;`)
      .replace('#include <map_fragment>', `
        float kZ = floor(vZone + 0.5);
        vec2 kUv = vec2(mod(kZ, 2.0), 1.0 - floor(kZ / 2.0 + 0.01)) * 0.5 + 0.008 + fract(vKitUv) * 0.484;
        vec2 kGx = dFdx(vKitUv) * 0.484;
        vec2 kGy = dFdy(vKitUv) * 0.484;
        diffuseColor *= textureGrad(map, kUv, kGx, kGy);`)
      .replace('#include <roughnessmap_fragment>', `
        vec4 kRM = textureGrad(roughnessMap, kUv, kGx, kGy);
        float roughnessFactor = clamp(kRM.g * vSurf.x, 0.04, 1.0);`)
      .replace('#include <metalnessmap_fragment>', `
        float metalnessFactor = clamp(kRM.b * vSurf.y, 0.0, 1.0);`)
      .replace('#include <normal_fragment_maps>', `
        {
          vec3 mapN = textureGrad(normalMap, kUv, kGx, kGy).xyz * 2.0 - 1.0;
          mapN.xy *= normalScale;
          normal = normalize(tbn * mapN);
        }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += uEnergy * (vGlow.x + vGlow.y * uCharge) + uBarColor * vGlow.z + vColor.rgb * vSurf.z;`);
  };
  mat.customProgramCacheKey = () => `strand-vmkit-${key}`;
  return mat;
}
