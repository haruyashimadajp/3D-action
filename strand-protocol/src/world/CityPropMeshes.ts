/**
 * STRAND // PROTOCOL — Phase 9B / 10A GPU kits for the city micro-props (10 persistent draw calls):
 *
 *   SocketPottedPlants · SocketStorageCrates · SocketWallFixtures · SocketMiscProps      (9B-1, cull 64 m)
 *   ClutterDebrisKit (Cardboard+TrashBins) · ClutterDumpsters · ClutterBenches · ClutterScrapBarriers (10A-1)
 *   GraffitiDecals (9B-3, fade 95 m) · PropContactShadows (10A-2, Y = 0.012 m soft radial shadow)
 *
 * Every kit is ONE InstancedMesh whose geometry holds all of its variants. Per-vertex `aVar` names the variant a
 * part belongs to and `aPart` its material class; the per-instance `aInst.x` selects the variant — inactive
 * variants and instances beyond `uCullDist` collapse to the origin in the vertex shader (zero-area, no overdraw).
 * Parts are shaded from baked vertex colour × per-instance tint × baked vertex AO × world-space archDetail,
 * with per-class roughness / metalness / emission, city lights within 28 m, and a strict ≤ 0.86 Bloom guard on
 * non-emissive surfaces. Nothing here runs per frame.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { PbrTextureSet } from '../engine/ProceduralTextures';
import { PROPS, PROP_DEFS, KIT_IDS, KIT_CAP, type DecalInstance, type KitId, type PropInstance } from './CityProps';

/** Material classes (aPart). TINT* classes (6..10) multiply the per-instance tint. */
const P = {
  MATTE: 0,
  METAL: 1,
  LEAF: 2,
  GLOW: 3,
  WET: 4,
  ATLAS: 5,
  TINT: 6,
  TINT_GLOSS: 7,
  TINT_GLOW: 8,
  TINT_METAL: 9,
  TINT_WET: 10,
  GUNMETAL: 11,
} as const;

const GLSL_PART_PARS = /* glsl */ `
varying float vAo;
varying float vPart;
varying vec3 vTint;
varying vec2 vAtlasUv;
varying float vGain;
`;

/** Contact AO of a prop vertex at local height y (0 = floor). */
const contactAo = (y: number): number => (y >= 0.3 ? 1 : 0.46 + 0.54 * (y / 0.3));

interface AddOpts {
  ao?: number;
  /** Darken toward the floor (props standing on the ground). */
  contact?: boolean;
  /** AO of downward faces. */
  under?: number;
  /** Keep the primitive's uv (plaque atlas face). */
  atlas?: boolean;
  rx?: number;
  ry?: number;
  rz?: number;
}

/** Accumulates primitives of one kit with the shared attribute set (position, normal, color, aAo, aVar, aPart, aUv). */
class KitBuilder {
  private readonly geos: THREE.BufferGeometry[] = [];
  private v = 0;
  private readonly col = new THREE.Color();

  variant(v: number): this {
    this.v = v;
    return this;
  }

  add(src: THREE.BufferGeometry, part: number, hex: number, x: number, y: number, z: number, o: AddOpts = {}): void {
    const g = src.index ? src.toNonIndexed() : src;
    if (g !== src) src.dispose();
    if (o.rx) g.rotateX(o.rx);
    if (o.rz) g.rotateZ(o.rz);
    if (o.ry) g.rotateY(o.ry);
    g.translate(x, y, z);
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const nrm = g.getAttribute('normal') as THREE.BufferAttribute;
    const n = pos.count;
    const uvSrc = g.getAttribute('uv') as THREE.BufferAttribute | undefined;
    const color = new Float32Array(n * 3);
    const ao = new Float32Array(n);
    const aVar = new Float32Array(n).fill(this.v);
    const aPart = new Float32Array(n).fill(part);
    const aUv = new Float32Array(n * 2);
    this.col.setHex(hex);
    for (let i = 0; i < n; i++) {
      color[i * 3] = this.col.r;
      color[i * 3 + 1] = this.col.g;
      color[i * 3 + 2] = this.col.b;
      let a = o.ao ?? 1;
      if (o.contact) a *= contactAo(pos.getY(i));
      if (o.under !== undefined && nrm.getY(i) < -0.5) a *= o.under;
      ao[i] = a;
      if (o.atlas && uvSrc) {
        aUv[i * 2] = uvSrc.getX(i);
        aUv[i * 2 + 1] = uvSrc.getY(i);
      }
    }
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
    g.setAttribute('color', new THREE.BufferAttribute(color, 3));
    g.setAttribute('aAo', new THREE.BufferAttribute(ao, 1));
    g.setAttribute('aVar', new THREE.BufferAttribute(aVar, 1));
    g.setAttribute('aPart', new THREE.BufferAttribute(aPart, 1));
    g.setAttribute('aUv', new THREE.BufferAttribute(aUv, 2));
    this.geos.push(g);
  }

  /** Box by centre. Ground-touching boxes taller than 0.6 m are split at 0.3 m so the contact AO stays local. */
  box(part: number, hex: number, w: number, h: number, d: number, x: number, y: number, z: number, o: AddOpts = {}): void {
    const y0 = y - h / 2;
    if (o.contact && !o.rx && !o.rz && y0 < 0.02 && h > 0.6) {
      this.add(new THREE.BoxGeometry(w, 0.3 - y0, d), part, hex, x, (y0 + 0.3) / 2, z, o);
      this.add(new THREE.BoxGeometry(w, y + h / 2 - 0.3, d), part, hex, x, (0.3 + y + h / 2) / 2, z, { ...o, contact: false });
      return;
    }
    this.add(new THREE.BoxGeometry(w, h, d), part, hex, x, y, z, o);
  }

  /** Cylinder by centre (axis Y unless rotated). */
  cyl(part: number, hex: number, rTop: number, rBot: number, h: number, x: number, y: number, z: number, seg = 10, o: AddOpts = {}): void {
    this.add(new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, false), part, hex, x, y, z, o);
  }

  /**
   * Lumpy slumped blob (garbage bags): a low-poly sphere with deterministic radial lumps, a flattened, spread-out
   * bottom and a pinched, twisted neck on top where the bag is tied.
   */
  blob(part: number, hex: number, rx: number, ry: number, rz: number, x: number, y: number, z: number, o: AddOpts = {}): void {
    const g = new THREE.SphereGeometry(1, 8, 5);
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const seed = (x * 13.1 + z * 7.7 + y * 3.3) * 1000;
    for (let i = 0; i < pos.count; i++) {
      let px = pos.getX(i);
      let py = pos.getY(i);
      let pz = pos.getZ(i);
      const n = Math.sin(px * 5.1 + seed) * Math.cos(pz * 4.3 - seed * 0.7) * Math.sin(py * 3.7 + seed * 0.3);
      const k = 1 + 0.16 * n;
      px *= k;
      pz *= k;
      py *= 1 + 0.08 * n;
      if (py < -0.35) {
        // Slumped base: flattened and spread.
        const t = (-py - 0.35) / 0.65;
        py = -0.35 - t * 0.35;
        px *= 1 + 0.18 * t;
        pz *= 1 + 0.18 * t;
      } else if (py > 0.75) {
        // Gathered neck.
        const t = (py - 0.75) / 0.25;
        px *= 1 - 0.75 * t;
        pz *= 1 - 0.75 * t;
        py += 0.25 * t;
      }
      pos.setXYZ(i, px, py, pz);
    }
    g.computeVertexNormals();
    g.scale(rx, ry, rz);
    this.add(g, part, hex, x, y, z, o);
  }

  /** Leaf blade: thin tapered slab leaning out at `tilt` toward heading `yaw`. */
  leaf(hex: number, len: number, wid: number, x: number, y: number, z: number, tilt: number, yaw: number, ao = 1): void {
    const g = new THREE.CylinderGeometry(0.004, wid / 2, len, 4, 1, false);
    g.scale(1, 1, 0.18);
    g.translate(0, len / 2, 0);
    g.rotateX(tilt);
    this.add(g, P.LEAF, hex, x, y, z, { ry: yaw, ao });
  }

  build(): THREE.BufferGeometry {
    const g = mergeGeometries(this.geos, false) as THREE.BufferGeometry;
    for (const s of this.geos) s.dispose();
    g.computeBoundingSphere();
    return g;
  }
}

// =============================================================================================
// Kit geometry (local frame: X along the wall, Y up, +Z out from the wall / front).
// Floor props: origin at the footprint centre on the floor. Wall fixtures: origin at the back face centre.
// =============================================================================================
const GREEN = [0x2f5a2c, 0x3a6a34, 0x274c26, 0x46723a] as const;

function plantsKit(): THREE.BufferGeometry {
  const k = new KitBuilder();
  // v0 terracotta / ceramic / slate pot with broad dark-green blades.
  k.variant(0);
  k.cyl(P.TINT, 0xffffff, 0.2, 0.15, 0.36, 0, 0.18, 0, 12, { contact: true });
  k.cyl(P.TINT, 0x9e978e, 0.215, 0.205, 0.04, 0, 0.36, 0, 12);
  k.cyl(P.MATTE, 0x1c1610, 0.185, 0.185, 0.02, 0, 0.365, 0, 12, { ao: 0.5 });
  for (let i = 0; i < 9; i++) k.leaf(GREEN[i % 4], 0.48 + (i % 3) * 0.08, 0.11, Math.cos(i * 2.4) * 0.05, 0.36, Math.sin(i * 2.4) * 0.05, 0.35 + (i % 3) * 0.18, i * 0.7, i < 3 ? 0.55 : 0.9);
  // v1 low concrete / metal planter box with twin cyber-fern tufts.
  k.variant(1);
  k.box(P.TINT, 0xffffff, 0.78, 0.32, 0.32, 0, 0.16, 0, { contact: true });
  k.box(P.MATTE, 0x1c1610, 0.72, 0.02, 0.26, 0, 0.32, 0, { ao: 0.5 });
  for (const sx of [-0.2, 0.2]) {
    for (let i = 0; i < 8; i++) k.leaf(GREEN[(i + 1) % 4], 0.36 + (i % 2) * 0.12, 0.06, sx, 0.32, 0, 0.55 + (i % 3) * 0.15, i * 0.8 + sx, i < 2 ? 0.6 : 0.95);
  }
  // v2 ceramic pot on a lidded plastic storage bin.
  k.variant(2);
  k.box(P.TINT_GLOSS, 0xffffff, 0.5, 0.42, 0.4, 0, 0.21, 0, { contact: true });
  k.box(P.TINT_GLOSS, 0x9e9e9e, 0.52, 0.04, 0.42, 0, 0.44, 0);
  k.cyl(P.MATTE, 0x78402a, 0.14, 0.11, 0.24, 0.02, 0.58, 0, 10, { under: 0.5 });
  for (let i = 0; i < 7; i++) k.leaf(GREEN[i % 4], 0.36 + (i % 2) * 0.1, 0.09, 0.02, 0.7, 0, 0.3 + (i % 3) * 0.2, i * 0.9, i < 2 ? 0.6 : 0.95);
  // v3 pair of small succulent pots.
  k.variant(3);
  k.cyl(P.TINT, 0xffffff, 0.1, 0.08, 0.16, -0.12, 0.08, 0, 10, { contact: true });
  k.cyl(P.TINT, 0xffffff, 0.09, 0.07, 0.13, 0.13, 0.065, 0.02, 10, { contact: true });
  for (let i = 0; i < 6; i++) k.leaf(GREEN[(i + 2) % 4], 0.12, 0.07, -0.12, 0.15, 0, 0.9, i * 1.05, 0.9);
  k.cyl(P.LEAF, 0x4f7a3e, 0.035, 0.04, 0.26, 0.13, 0.25, 0.02, 6);
  k.cyl(P.LEAF, 0x4f7a3e, 0.025, 0.03, 0.12, 0.18, 0.27, 0.02, 6, { rz: -0.9 });
  return k.build();
}

function storageKit(): THREE.BufferGeometry {
  const k = new KitBuilder();
  // v0 narrow 3-tier open wire rack (0.72 × 1.45 × 0.34): 10A-2 matte dark gunmetal (0x3c424a, rough 0.58).
  k.variant(0);
  for (const sx of [-0.35, 0.35]) for (const sz of [-0.155, 0.155]) k.box(P.GUNMETAL, 0x3c424a, 0.022, 1.45, 0.022, sx, 0.725, sz, { contact: true });
  for (const y of [0.06, 0.5, 0.95, 1.4]) {
    k.box(P.GUNMETAL, 0x3c424a, 0.72, 0.014, 0.34, 0, y, 0, { under: 0.7 });
    for (let x = -0.3; x <= 0.31; x += 0.1) k.box(P.GUNMETAL, 0x343a42, 0.008, 0.02, 0.34, x, y + 0.012, 0);
  }
  k.box(P.MATTE, 0x3b424c, 0.62, 0.3, 0.3, 0, 0.22, 0, { ao: 0.8 });
  k.box(P.TINT_GLOSS, 0xffffff, 0.3, 0.24, 0.28, -0.17, 0.63, 0, { ao: 0.85 });
  k.box(P.TINT_GLOSS, 0x9c9c9c, 0.31, 0.03, 0.29, -0.17, 0.765, 0);
  k.box(P.MATTE, 0x625d52, 0.3, 0.2, 0.26, 0.17, 0.61, 0, { ao: 0.85 });
  for (let i = 0; i < 3; i++) k.cyl(P.GUNMETAL, [0x585e66, 0x6e2b20, 0x244d63][i], 0.055, 0.055, 0.2, -0.22 + i * 0.13, 1.06, 0.02, 8);
  k.box(P.MATTE, 0x82441e, 0.22, 0.16, 0.22, 0.22, 1.04, 0);
  k.box(P.MATTE, 0x453629, 0.5, 0.12, 0.3, -0.05, 1.47, 0, { ao: 0.9 });
  // v1 two stacked lidded storage bins (slightly rotated).
  k.variant(1);
  k.box(P.TINT_GLOSS, 0xffffff, 0.6, 0.3, 0.44, 0, 0.15, 0, { contact: true });
  k.box(P.TINT_GLOSS, 0xa8a8a8, 0.62, 0.035, 0.46, 0, 0.317, 0);
  k.box(P.MATTE, 0x66625a, 0.56, 0.26, 0.4, 0.02, 0.465, 0.01, { ry: 0.1 });
  k.box(P.MATTE, 0x57544c, 0.58, 0.035, 0.42, 0.02, 0.612, 0.01, { ry: 0.1 });
  for (const sx of [-0.31, 0.31]) k.box(P.MATTE, 0x24272d, 0.02, 0.05, 0.16, sx, 0.28, 0);
  // v2 three slotted delivery crates.
  k.variant(2);
  for (let i = 0; i < 3; i++) {
    const y = 0.14 + i * 0.28;
    const r = (i - 1) * 0.06;
    k.box(P.TINT, 0xffffff, 0.54, 0.27, 0.38, i === 2 ? 0.02 : 0, y, 0, { contact: i === 0, ry: r });
    for (const dy of [-0.05, 0.05]) {
      k.box(P.MATTE, 0x111316, 0.4, 0.035, 0.005, 0, y + dy, 0.19, { ry: r });
      k.box(P.MATTE, 0x111316, 0.005, 0.035, 0.28, 0.27, y + dy, 0, { ry: r });
      k.box(P.MATTE, 0x111316, 0.005, 0.035, 0.28, -0.27, y + dy, 0, { ry: r });
    }
  }
  // v3 wall-leaning shipping tote + small utility bucket.
  k.variant(3);
  k.box(P.TINT_GLOSS, 0xffffff, 0.48, 0.36, 0.36, -0.13, 0.19, -0.01, { contact: true, rz: 0.08 });
  k.box(P.TINT_GLOSS, 0xa4a4a4, 0.5, 0.03, 0.38, -0.115, 0.375, -0.01, { rz: 0.08 });
  k.cyl(P.MATTE, 0x265282, 0.13, 0.11, 0.3, 0.24, 0.15, 0.02, 10, { contact: true });
  k.cyl(P.MATTE, 0x10141a, 0.115, 0.115, 0.01, 0.24, 0.29, 0.02, 10, { ao: 0.5 });
  k.box(P.GUNMETAL, 0x3c424a, 0.24, 0.012, 0.012, 0.24, 0.36, 0.02);
  return k.build();
}

function fixturesKit(): THREE.BufferGeometry {
  const k = new KitBuilder();
  // v0 illuminated room-number plaque (0.30 × 0.14), digits from the 4 × 4 atlas.
  k.variant(0);
  k.box(P.TINT, 0xffffff, 0.3, 0.14, 0.035, 0, 0, 0.0175);
  k.add(new THREE.PlaneGeometry(0.27, 0.11), P.ATLAS, 0xffffff, 0, 0, 0.0362, { atlas: true });
  // v1 wall breaker / meter cabinet (0.42 × 0.56 × 0.18): door seams, hinge latch, conduit stub, status LED.
  k.variant(1);
  k.box(P.TINT_METAL, 0xffffff, 0.42, 0.56, 0.18, 0, 0, 0.09, { under: 0.6 });
  k.box(P.MATTE, 0x1a1c20, 0.006, 0.5, 0.004, 0, 0, 0.181);
  k.box(P.MATTE, 0x1a1c20, 0.38, 0.006, 0.004, 0, 0.18, 0.181);
  k.box(P.GUNMETAL, 0x464b52, 0.03, 0.08, 0.02, 0.17, 0, 0.19);
  k.cyl(P.GUNMETAL, 0x4a5058, 0.026, 0.026, 0.3, 0.1, 0.43, 0.06, 8);
  k.box(P.GLOW, 0x40ff70, 0.018, 0.018, 0.006, -0.15, 0.23, 0.182);
  k.box(P.GLOW, 0xffa020, 0.018, 0.018, 0.006, -0.11, 0.23, 0.182);
  // v2 backlit biometric keypad / intercom (0.14 × 0.28 × 0.05).
  k.variant(2);
  k.box(P.MATTE, 0x15181d, 0.14, 0.28, 0.05, 0, 0, 0.025);
  k.box(P.TINT_GLOW, 0x9cdcff, 0.1, 0.04, 0.004, 0, 0.09, 0.051);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) k.box(P.TINT_GLOW, 0xffffff, 0.022, 0.018, 0.006, (c - 1) * 0.032, 0.03 - r * 0.03, 0.052);
  // v3 caged amber bulkhead lamp.
  k.variant(3);
  k.box(P.GUNMETAL, 0x2a2e33, 0.2, 0.26, 0.03, 0, 0, 0.015);
  k.cyl(P.TINT_GLOW, 0xffffff, 0.06, 0.06, 0.16, 0, 0, 0.09, 10, { rx: Math.PI / 2 });
  for (let i = 0; i < 4; i++) k.box(P.GUNMETAL, 0x30343a, 0.012, 0.22, 0.012, (i - 1.5) * 0.045, 0, 0.16);
  for (const y of [-0.08, 0.08]) k.box(P.GUNMETAL, 0x30343a, 0.16, 0.012, 0.14, 0, y, 0.09);
  return k.build();
}

function miscKit(): THREE.BufferGeometry {
  const k = new KitBuilder();
  // v0 pair of folding metal stools.
  k.variant(0);
  for (const sx of [-0.22, 0.22]) {
    k.cyl(P.TINT, 0xffffff, 0.17, 0.16, 0.045, sx, 0.68, 0, 12, { under: 0.6 });
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      k.cyl(P.GUNMETAL, 0x3c424a, 0.012, 0.014, 0.68, sx + Math.cos(a) * 0.1, 0.34, Math.sin(a) * 0.1, 5, { contact: true, rx: Math.sin(a) * 0.12, rz: -Math.cos(a) * 0.12 });
    }
    k.cyl(P.GUNMETAL, 0x3c424a, 0.11, 0.11, 0.012, sx, 0.26, 0, 10);
  }
  // v1 glowing A-frame sidewalk menu board.
  k.variant(1);
  for (const s of [-1, 1]) {
    k.box(P.MATTE, 0x16181c, 0.6, 1.02, 0.035, 0, 0.5, s * 0.14, { rx: s * 0.27, contact: true });
    if (s > 0) k.box(P.TINT_GLOW, 0xffffff, 0.48, 0.72, 0.006, 0, 0.56, 0.16, { rx: 0.27 });
    else k.box(P.MATTE, 0x2a2e35, 0.5, 0.74, 0.006, 0, 0.56, -0.16, { rx: -0.27 });
  }
  k.box(P.GUNMETAL, 0x42474e, 0.56, 0.02, 0.02, 0, 0.98, 0);
  // v2 industrial oil canisters / gas bottle cluster.
  k.variant(2);
  k.cyl(P.TINT_METAL, 0xffffff, 0.12, 0.12, 0.56, -0.16, 0.28, 0, 12, { contact: true });
  k.cyl(P.TINT_METAL, 0xffffff, 0.06, 0.12, 0.08, -0.16, 0.6, 0, 12);
  k.cyl(P.GUNMETAL, 0x484e56, 0.025, 0.025, 0.06, -0.16, 0.66, 0, 6);
  k.cyl(P.MATTE, 0x742d22, 0.11, 0.11, 0.44, 0.1, 0.22, 0.02, 12, { contact: true });
  k.cyl(P.GUNMETAL, 0x2a2e33, 0.112, 0.112, 0.03, 0.1, 0.42, 0.02, 12);
  k.box(P.MATTE, 0x2a2e34, 0.16, 0.2, 0.14, 0.24, 0.1, -0.04, { contact: true });
  // v3 umbrella stand with three closed umbrellas.
  k.variant(3);
  k.cyl(P.GUNMETAL, 0x3e444c, 0.13, 0.12, 0.45, 0, 0.225, 0, 12, { contact: true });
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.4;
    k.cyl(P.TINT, i === 1 ? 0x848484 : 0xffffff, 0.012, 0.05, 0.62, Math.cos(a) * 0.05, 0.62, Math.sin(a) * 0.05, 6, { rx: Math.sin(a) * 0.12, rz: -Math.cos(a) * 0.12 });
    k.cyl(P.GUNMETAL, 0x202226, 0.012, 0.012, 0.12, Math.cos(a) * 0.08, 0.95, Math.sin(a) * 0.08, 4);
  }
  return k.build();
}

/** 10A-1 consolidated debris kit: Cardboard (v0..2) + TrashBins (v3..4) in a single draw call. */
function debrisKit(): THREE.BufferGeometry {
  const k = new KitBuilder();
  const tape = 0x5c513b;
  // v0 two damp boxes.
  k.variant(0);
  k.box(P.TINT, 0xffffff, 0.62, 0.34, 0.46, 0, 0.17, 0, { contact: true });
  k.box(P.MATTE, tape, 0.62, 0.004, 0.06, 0, 0.342, 0);
  k.box(P.TINT, 0xd4ccc0, 0.44, 0.24, 0.36, 0.05, 0.46, 0.02, { ry: 0.16 });
  k.box(P.MATTE, tape, 0.06, 0.004, 0.36, 0.05, 0.582, 0.02, { ry: 0.16 });
  // v1 three-box tower.
  k.variant(1);
  k.box(P.TINT, 0xffffff, 0.68, 0.4, 0.54, 0, 0.2, 0, { contact: true });
  k.box(P.TINT, 0xd8cfc2, 0.56, 0.34, 0.46, -0.04, 0.57, 0.02, { ry: -0.12 });
  k.box(P.TINT, 0xffffff, 0.4, 0.26, 0.34, 0.03, 0.87, -0.01, { ry: 0.22 });
  k.box(P.MATTE, tape, 0.68, 0.004, 0.06, 0, 0.402, 0);
  k.box(P.MATTE, tape, 0.06, 0.004, 0.34, 0.03, 1.002, -0.01, { ry: 0.22 });
  // v2 pile of flattened / collapsed boxes.
  k.variant(2);
  k.box(P.TINT, 0xffffff, 0.86, 0.03, 0.56, 0, 0.03, 0, { contact: true, rz: 0.05 });
  k.box(P.TINT, 0xccc3b5, 0.78, 0.03, 0.5, 0.05, 0.07, 0.03, { ry: 0.3, rz: -0.04 });
  k.box(P.TINT, 0xffffff, 0.42, 0.2, 0.36, -0.22, 0.14, -0.06, { rx: 0.2, ry: -0.5, contact: true });
  k.box(P.TINT, 0xd8cfc2, 0.7, 0.025, 0.4, 0.12, 0.2, 0.08, { rz: 0.35 });
  // v3 vented metal street bin with glossy wet bags slumped beside it.
  k.variant(3);
  k.cyl(P.TINT_METAL, 0xffffff, 0.29, 0.27, 0.9, -0.22, 0.45, 0, 12, { contact: true });
  k.cyl(P.GUNMETAL, 0x2a2e33, 0.3, 0.3, 0.05, -0.22, 0.92, 0, 12);
  k.cyl(P.WET, 0x0c0d10, 0.25, 0.25, 0.02, -0.22, 0.95, 0, 12);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    k.box(P.MATTE, 0x0a0b0d, 0.05, 0.3, 0.01, -0.22 + Math.cos(a) * 0.282, 0.62, Math.sin(a) * 0.282, { ry: -a + Math.PI / 2 });
  }
  // Bag bases sit flush: the slumped blob's bottom is 0.7 × ry below its centre.
  k.blob(P.TINT_WET, 0xffffff, 0.24, 0.2, 0.22, 0.24, 0.14, 0.08, { contact: true });
  k.blob(P.TINT_WET, 0xc4c4c4, 0.2, 0.17, 0.2, 0.36, 0.119, -0.14, { contact: true });
  k.blob(P.TINT_WET, 0xffffff, 0.16, 0.22, 0.16, -0.22, 1.02, 0, {});
  // v4 standalone wet garbage-bag mound.
  k.variant(4);
  const bags: Array<[number, number, number, number, number | null]> = [
    [-0.26, 0.04, 0.26, 0.22, null],
    [0.16, -0.1, 0.27, 0.21, null],
    [0.0, 0.0, 0.22, 0.18, 0.36],
    [0.3, 0.2, 0.2, 0.16, null],
    [-0.12, 0.24, 0.19, 0.15, null],
  ];
  bags.forEach(([x, z, r, ry, sy], i) => k.blob(P.TINT_WET, i % 2 ? 0xc0c0c0 : 0xffffff, r, ry, r * 0.9, x, sy ?? ry * 0.7, z, { contact: sy === null }));
  return k.build();
}

function dumpsterKit(): THREE.BufferGeometry {
  const k = new KitBuilder();
  const body = (open: boolean): void => {
    // Tapered steel body 1.80 × 1.15 × ~1.0 m with side lifting pockets, top rim, corner posts and casters.
    k.box(P.TINT_METAL, 0xffffff, 1.8, 0.86, 1.15, 0, 0.53, 0, { contact: true, under: 0.5 });
    k.box(P.TINT_METAL, 0xc8c8c8, 1.84, 0.06, 1.19, 0, 0.98, 0);
    for (const sx of [-1, 1]) {
      k.box(P.GUNMETAL, 0x2a2e33, 0.14, 0.1, 1.0, sx * 0.97, 0.62, 0, { under: 0.6 });
      k.box(P.TINT_METAL, 0xb0b0b0, 0.05, 0.86, 0.05, sx * 0.885, 0.53, 0.56);
      k.box(P.TINT_METAL, 0xb0b0b0, 0.05, 0.86, 0.05, sx * 0.885, 0.53, -0.56);
      for (const sz of [-0.45, 0.45]) k.cyl(P.MATTE, 0x15171a, 0.05, 0.05, 0.05, sx * 0.75, 0.05, sz, 8, { rz: Math.PI / 2 });
    }
    if (open) {
      // Lid swung back, bags overflowing.
      k.box(P.TINT_METAL, 0x909090, 1.82, 0.04, 1.2, 0, 1.4, -0.86, { rx: -1.25 });
      k.blob(P.TINT_WET, 0x202226, 0.32, 0.18, 0.3, -0.4, 1.02, 0.05, {});
      k.blob(P.TINT_WET, 0x1a1c20, 0.3, 0.2, 0.28, 0.35, 1.04, -0.12, {});
    } else {
      // Angled lid, front lower than back, with a seam.
      k.box(P.TINT_METAL, 0x909090, 1.82, 0.04, 1.2, 0, 1.06, 0, { rx: 0.1, under: 0.5 });
      k.box(P.MATTE, 0x101215, 0.01, 0.045, 1.18, 0, 1.07, 0, { rx: 0.1 });
    }
  };
  k.variant(0);
  body(false);
  k.variant(1);
  body(true);
  return k.build();
}

function benchKit(): THREE.BufferGeometry {
  const k = new KitBuilder();
  k.variant(0);
  const iron = 0x22262b;
  for (const sx of [-0.82, 0.82]) {
    k.box(P.GUNMETAL, iron, 0.06, 0.44, 0.06, sx, 0.22, 0.2, { contact: true });
    k.box(P.GUNMETAL, iron, 0.06, 0.8, 0.06, sx, 0.4, -0.22, { contact: true, rx: -0.08 });
    k.box(P.GUNMETAL, iron, 0.06, 0.05, 0.5, sx, 0.42, 0, {});
    k.box(P.GUNMETAL, iron, 0.07, 0.04, 0.46, sx, 0.64, 0.02, {});
  }
  for (let i = 0; i < 4; i++) k.box(P.TINT, 0xffffff, 1.85, 0.035, 0.1, 0, 0.455, 0.2 - i * 0.115, { under: 0.6 });
  for (let i = 0; i < 3; i++) k.box(P.TINT, 0xd4d4d4, 1.85, 0.1, 0.03, 0, 0.56 + i * 0.12, -0.25 - i * 0.012, { rx: -0.1 });
  k.box(P.GUNMETAL, iron, 0.05, 0.05, 0.42, 0, 0.42, 0, {});
  return k.build();
}

function scrapKit(): THREE.BufferGeometry {
  const k = new KitBuilder();
  // v0 stacked weathered pallets + scrap pipes.
  k.variant(0);
  for (let p = 0; p < 3; p++) {
    const y = p * 0.15;
    const r = (p - 1) * 0.05;
    for (const sz of [-0.42, 0, 0.42]) k.box(P.TINT, 0xa4a4a4, 1.2, 0.09, 0.1, 0, y + 0.045, sz, { contact: p === 0, ry: r });
    for (let i = 0; i < 5; i++) k.box(P.TINT, 0xffffff, 0.12, 0.022, 1.0, -0.5 + i * 0.25, y + 0.1, 0, { ry: r });
  }
  k.cyl(P.TINT_METAL, 0x5c3420, 0.05, 0.05, 1.15, 0.05, 0.53, -0.1, 8, { rz: Math.PI / 2, ry: 0.15 });
  k.cyl(P.GUNMETAL, 0x42474e, 0.035, 0.035, 0.9, -0.1, 0.52, 0.16, 8, { rz: Math.PI / 2, ry: -0.3 });
  // v1 two dented rusted oil drums with hazard bands.
  k.variant(1);
  for (const [sx, sz, ry] of [[-0.32, 0, 0], [0.33, 0.02, 0.6]] as const) {
    k.cyl(P.TINT_METAL, 0xffffff, 0.29, 0.29, 0.88, sx, 0.44, sz, 11, { contact: true, ry });
    for (const y of [0.29, 0.59]) k.cyl(P.TINT_METAL, 0xb4b4b4, 0.297, 0.297, 0.035, sx, y, sz, 11);
    k.cyl(P.MATTE, 0x94761c, 0.293, 0.293, 0.1, sx, 0.75, sz, 11);
  }
  // v2 concrete jersey barrier (1.8 × 0.85 × 0.52) with a faded caution stripe band.
  k.variant(2);
  k.box(P.TINT, 0xffffff, 1.8, 0.26, 0.52, 0, 0.13, 0, { contact: true });
  {
    const g = new THREE.BoxGeometry(1.8, 0.59, 0.4);
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) if (pos.getY(i) > 0) pos.setZ(i, pos.getZ(i) * 0.45);
    g.computeVertexNormals();
    k.add(g, P.TINT, 0xffffff, 0, 0.555, 0, {});
  }
  for (let i = 0; i < 6; i++) {
    for (const sz of [-1, 1]) k.box(P.MATTE, i % 2 ? 0x161616 : 0x967e20, 0.3, 0.12, 0.006, -0.75 + i * 0.3, 0.55, sz * 0.15, { rx: sz * -0.17 });
  }
  // v3 pair of safety-orange traffic cones with muted retroreflective collars.
  k.variant(3);
  for (const sx of [-0.23, 0.24]) {
    k.box(P.MATTE, 0x16171a, 0.42, 0.035, 0.42, sx, 0.0175, 0, { contact: true });
    k.cyl(P.TINT, 0xffffff, 0.035, 0.17, 0.68, sx, 0.375, 0, 10);
    for (const y of [0.42, 0.56]) k.cyl(P.METAL, 0x767c84, 0.035 + 0.135 * (1 - (y - 0.035) / 0.68), 0.04 + 0.135 * (1 - (y - 0.075) / 0.68), 0.05, sx, y, 0, 10);
  }
  return k.build();
}

const KIT_GEO: Readonly<Record<KitId, () => THREE.BufferGeometry>> = {
  PLANTS: plantsKit,
  STORAGE: storageKit,
  FIXTURES: fixturesKit,
  MISC: miscKit,
  DEBRIS: debrisKit,
  DUMPSTER: dumpsterKit,
  BENCH: benchKit,
  SCRAP: scrapKit,
};

const KIT_NAME: Readonly<Record<KitId, string>> = {
  PLANTS: 'SocketPottedPlants',
  STORAGE: 'SocketStorageCrates',
  FIXTURES: 'SocketWallFixtures',
  MISC: 'SocketMiscProps',
  DEBRIS: 'ClutterDebrisKit',
  DUMPSTER: 'ClutterDumpsters',
  BENCH: 'ClutterBenches',
  SCRAP: 'ClutterScrapBarriers',
};

const SOCKET_KITS: ReadonlySet<KitId> = new Set(['PLANTS', 'STORAGE', 'FIXTURES', 'MISC']);

// =============================================================================================
// Materials
// =============================================================================================
type Decorate = (shader: THREE.WebGLProgramParametersWithUniforms, apply?: string) => void;

/** 10A-1 / 10A-2: skip city lights beyond 28 m and clamp non-emissive props ≤ 0.86 so they never Bloom white. */
const GLSL_PROP_LIGHTS_AND_GUARD = /* glsl */ `
  {
    vec3 strandToCam = cameraPosition - vCityWorld;
    float strandCamD2 = dot(strandToCam, strandToCam);
    if (strandCamD2 < 784.0) {
      vec3 strandNw = transformNormalByInverseViewMatrix(normal, viewMatrix);
      vec3 strandV = strandToCam * inversesqrt(max(strandCamD2, 1e-6));
      outgoingLight += strandCityLights(vCityWorld, strandNw, strandV, diffuseColor.rgb, roughnessFactor, metalnessFactor);
    }
    float strandPG = floor(vPart + 0.5);
    if (strandPG != 3.0 && strandPG != 5.0 && strandPG != 8.0) {
      outgoingLight = min(outgoingLight, vec3(0.86));
    }
  }
  #include <opaque_fragment>
`;

const GLSL_TRIPLANAR_HELPER = /* glsl */ `
vec2 strandPropTriUv(vec3 p, vec3 n) {
  vec3 an = abs(n);
  if (an.y >= an.x && an.y >= an.z) return p.xz * 0.833333;
  if (an.x >= an.z) return p.zy * 0.833333;
  return p.xy * 0.833333;
}
`;

function createKitMaterial(
  cullDist: number,
  atlas: THREE.Texture,
  decorate: Decorate,
  archDetail?: PbrTextureSet,
): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 1, metalness: 0, envMapIntensity: 0.65 });
  const uCull = { value: cullDist };
  const uAtlas = { value: atlas };
  const uArchMap = archDetail ? { value: archDetail.map } : null;
  const uArchRough = archDetail ? { value: archDetail.roughnessMap } : null;
  const uArchNormal = archDetail ? { value: archDetail.normalMap } : null;
  mat.onBeforeCompile = (shader) => {
    decorate(shader, GLSL_PROP_LIGHTS_AND_GUARD);
    shader.uniforms.uCullDist = uCull;
    shader.uniforms.uPlaqueAtlas = uAtlas;
    if (uArchMap && uArchRough && uArchNormal) {
      shader.uniforms.uArchMap = uArchMap;
      shader.uniforms.uArchRough = uArchRough;
      shader.uniforms.uArchNormal = uArchNormal;
    }
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute float aAo;
attribute float aVar;
attribute float aPart;
attribute vec2 aUv;
attribute vec4 aInst;
attribute vec3 aTint;
uniform float uCullDist;
${GLSL_PART_PARS}`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
{
  // 9B variant selector + distance cull: inactive variants / far instances collapse to the origin.
  vec3 strandInst = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float strandKeep = (aVar < -0.5 || abs(aVar - aInst.x) < 0.5) ? 1.0 : 0.0;
  strandKeep *= step(distance(strandInst, cameraPosition), uCullDist);
  transformed *= strandKeep;
  vAo = aAo;
  vPart = aPart;
  vTint = aTint;
  vGain = aInst.z;
  vAtlasUv = (vec2(mod(aInst.y, 4.0), 3.0 - floor(aInst.y / 4.0)) + aUv) * 0.25;
}`,
      );
    const detPars = uArchMap
      ? `uniform sampler2D uArchMap;
uniform sampler2D uArchRough;
uniform sampler2D uArchNormal;
${GLSL_TRIPLANAR_HELPER}`
      : '';
    const detColor = uArchMap
      ? `
  vec2 strandDetUv = strandPropTriUv(vCityWorld, vCityWorldN);
  if (!strandEmissive) {
    vec3 strandDetAlb = texture2D(uArchMap, strandDetUv).rgb;
    diffuseColor.rgb *= mix(vec3(1.0), strandDetAlb * 1.22, 0.82);
  }`
      : '';
    const detRough = uArchRough
      ? `
  float strandDetR = texture2D(uArchRough, strandDetUv).g;
  roughnessFactor = clamp(roughnessFactor * mix(0.76, 1.22, strandDetR), 0.14, 0.96);`
      : '';
    const detNormal = uArchNormal
      ? `
  if (!strandEmissive) {
    vec3 strandDetN = texture2D(uArchNormal, strandDetUv).xyz * 2.0 - 1.0;
    vec3 strandAn = abs(vCityWorldN);
    vec3 strandNwPert;
    if (strandAn.y >= strandAn.x && strandAn.y >= strandAn.z) strandNwPert = vec3(strandDetN.x, 0.0, strandDetN.y);
    else if (strandAn.x >= strandAn.z) strandNwPert = vec3(0.0, strandDetN.y, strandDetN.x);
    else strandNwPert = vec3(strandDetN.x, strandDetN.y, 0.0);
    normal = normalize(normal + mat3(viewMatrix) * (strandNwPert * 0.26));
  }`
      : '';
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform sampler2D uPlaqueAtlas;\n${GLSL_PART_PARS}\n${detPars}`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
  float strandP = floor(vPart + 0.5);
  bool strandTinted = strandP >= 5.5 && strandP <= 10.5;
  bool strandEmissive = strandP == 3.0 || strandP == 8.0 || strandP == 5.0;
  if (strandTinted) diffuseColor.rgb *= vTint;
  if (strandEmissive) diffuseColor.rgb *= 0.18;
  diffuseColor.rgb *= mix(0.32, 1.0, vAo);${detColor}`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
  roughnessFactor = strandP == 0.0 ? 0.8 : strandP == 1.0 ? 0.42 : strandP == 2.0 ? 0.52 : strandP == 4.0 ? 0.18
    : strandP == 5.0 ? 0.3 : strandP == 6.0 ? 0.74 : strandP == 7.0 ? 0.34 : strandP == 9.0 ? 0.58 : strandP == 10.0 ? 0.2
    : strandP == 11.0 ? 0.58 : 0.45;${detRough}`,
      )
      .replace(
        '#include <metalnessmap_fragment>',
        `#include <metalnessmap_fragment>
  metalnessFactor = strandP == 1.0 ? 0.78 : strandP == 9.0 ? 0.5 : strandP == 11.0 ? 0.6 : 0.0;`,
      )
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>${detNormal}`)
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
  if (strandP == 3.0) totalEmissiveRadiance += vColor.rgb * 2.2 * max(vGain, 0.6);
  else if (strandP == 8.0) totalEmissiveRadiance += vColor.rgb * vTint * 1.9 * vGain;
  else if (strandP == 5.0) totalEmissiveRadiance += texture2D(uPlaqueAtlas, vAtlasUv).rgb * 2.0 * vGain;`,
      );
  };
  const key = archDetail ? 'strand-propkit-v2-det' : 'strand-propkit-v2-flat';
  mat.customProgramCacheKey = () => key;
  return mat;
}

function createDecalMaterial(atlas: THREE.Texture, decorate: Decorate): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: atlas,
    roughness: 0.62,
    metalness: 0,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const uFade = { value: PROPS.DECAL_FADE_M };
  mat.onBeforeCompile = (shader) => {
    decorate(shader);
    shader.uniforms.uDecalFade = uFade;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aDecal;\nuniform float uDecalFade;\nvarying vec3 vDecalTint;\nvarying float vDecalFade;')
      .replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
  vMapUv = (vec2(mod(aDecal.x, 4.0), 1.0 - floor(aDecal.x / 4.0)) + uv) * vec2(0.25, 0.5);`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
{
  vec3 strandInst = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float strandD = distance(strandInst, cameraPosition);
  vDecalFade = 1.0 - smoothstep(uDecalFade * 0.8, uDecalFade, strandD);
  transformed *= step(strandD, uDecalFade);
  vDecalTint = aDecal.yzw;
}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vDecalTint;\nvarying float vDecalFade;')
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
  diffuseColor.rgb *= vDecalTint;
  diffuseColor.a *= vDecalFade;
  if (diffuseColor.a < 0.02) discard;`,
      )
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += diffuseColor.rgb * 0.07;');
  };
  mat.customProgramCacheKey = () => 'strand-decal-v1';
  return mat;
}

/** 10A-2 soft radial ground contact shadow decal (Y = 0.012 m, zero texture fetches). */
function createContactShadowMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
    vertexShader: /* glsl */ `
      attribute float aAlpha;
      varying vec2 vUv;
      varying float vAlpha;
      void main() {
        vUv = uv;
        vec3 inst = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        float dist = distance(inst, cameraPosition);
        float fade = 1.0 - smoothstep(68.0, 92.0, dist);
        vAlpha = aAlpha * fade;
        vec3 p = position * step(dist, 92.0);
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      varying float vAlpha;
      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        float r2 = dot(p, p);
        float edge = 1.0 - smoothstep(0.55, 1.0, sqrt(r2));
        float a = exp(-r2 * 2.4) * edge * vAlpha;
        if (a < 0.01) discard;
        gl_FragColor = vec4(0.012, 0.016, 0.024, a);
      }
    `,
  });
}

// =============================================================================================
// Kits
// =============================================================================================
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

export const CONTACT_SHADOW_Y = 0.012;

export interface ContactShadowDesc {
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  readonly w: number;
  readonly d: number;
  readonly alpha?: number;
}

export interface PropKitStats {
  counts: Record<KitId, number>;
  decals: number;
  contactShadows: number;
}

export class CityPropMeshes {
  readonly meshes: THREE.InstancedMesh[] = [];
  private readonly byKit = new Map<KitId, THREE.InstancedMesh>();
  private readonly decals: THREE.InstancedMesh;
  private readonly contactShadows: THREE.InstancedMesh;

  constructor(
    plaqueAtlas: THREE.Texture,
    graffitiAtlas: THREE.Texture,
    decorate: Decorate,
    archDetail?: PbrTextureSet,
  ) {
    const socketMat = createKitMaterial(PROPS.CULL_SOCKET_M, plaqueAtlas, decorate, archDetail);
    const clutterMat = createKitMaterial(PROPS.CULL_CLUTTER_M, plaqueAtlas, decorate, archDetail);
    for (const id of KIT_IDS) {
      const cap = KIT_CAP[id];
      const geo = KIT_GEO[id]();
      geo.setAttribute('aInst', new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4));
      geo.setAttribute('aTint', new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3));
      const m = new THREE.InstancedMesh(geo, SOCKET_KITS.has(id) ? socketMat : clutterMat, cap);
      m.count = 0;
      m.frustumCulled = false;
      m.visible = false;
      m.castShadow = id === 'DUMPSTER';
      m.receiveShadow = true;
      m.name = KIT_NAME[id];
      this.byKit.set(id, m);
      this.meshes.push(m);
    }
    const dgeo = new THREE.PlaneGeometry(1, 1);
    dgeo.setAttribute('aDecal', new THREE.InstancedBufferAttribute(new Float32Array(PROPS.CAP.DECAL * 4), 4));
    this.decals = new THREE.InstancedMesh(dgeo, createDecalMaterial(graffitiAtlas, decorate), PROPS.CAP.DECAL);
    this.decals.count = 0;
    this.decals.frustumCulled = false;
    this.decals.visible = false;
    this.decals.name = 'GraffitiDecals';
    this.decals.renderOrder = 2;
    this.meshes.push(this.decals);

    const sgeo = new THREE.PlaneGeometry(1, 1);
    sgeo.rotateX(-Math.PI / 2);
    sgeo.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(new Float32Array(PROPS.CAP.CONTACT_SHADOW), 1));
    this.contactShadows = new THREE.InstancedMesh(sgeo, createContactShadowMaterial(), PROPS.CAP.CONTACT_SHADOW);
    this.contactShadows.count = 0;
    this.contactShadows.frustumCulled = false;
    this.contactShadows.visible = false;
    this.contactShadows.name = 'PropContactShadows';
    this.contactShadows.renderOrder = 1;
    this.meshes.push(this.contactShadows);
  }

  /** Writes all instances of the sector (props beyond a kit's capacity are dropped and not counted). */
  commit(
    props: readonly PropInstance[],
    decals: readonly DecalInstance[],
    extraShadows: readonly ContactShadowDesc[] = [],
  ): PropKitStats {
    const counts = Object.fromEntries(KIT_IDS.map((k) => [k, 0])) as Record<KitId, number>;
    for (const p of props) {
      const m = this.byKit.get(p.kit) as THREE.InstancedMesh;
      const i = counts[p.kit];
      if (i >= KIT_CAP[p.kit]) continue;
      _p.set(p.x, p.y, p.z);
      _q.setFromEuler(_e.set(0, p.yaw, 0));
      _s.setScalar(p.s);
      m.setMatrixAt(i, _m4.compose(_p, _q, _s));
      (m.geometry.getAttribute('aInst') as THREE.InstancedBufferAttribute).setXYZW(i, p.v, Math.max(0, p.cell), p.glow, 0);
      _c.setHex(p.tint);
      (m.geometry.getAttribute('aTint') as THREE.InstancedBufferAttribute).setXYZ(i, _c.r, _c.g, _c.b);
      counts[p.kit] = i + 1;
    }
    for (const id of KIT_IDS) {
      const m = this.byKit.get(id) as THREE.InstancedMesh;
      m.count = counts[id];
      m.visible = m.count > 0;
      m.instanceMatrix.needsUpdate = true;
      (m.geometry.getAttribute('aInst') as THREE.InstancedBufferAttribute).needsUpdate = true;
      (m.geometry.getAttribute('aTint') as THREE.InstancedBufferAttribute).needsUpdate = true;
      if (m.count > 0) {
        m.computeBoundingSphere();
        m.frustumCulled = true;
      }
    }
    const da = this.decals.geometry.getAttribute('aDecal') as THREE.InstancedBufferAttribute;
    let n = 0;
    for (const d of decals) {
      if (n >= PROPS.CAP.DECAL) break;
      _p.set(d.x, d.y, d.z);
      _q.setFromEuler(_e.set(0, Math.atan2(d.nx, d.nz), d.roll, 'YXZ'));
      _s.set(d.w, d.h, 1);
      this.decals.setMatrixAt(n, _m4.compose(_p, _q, _s));
      _c.setHex(d.tint);
      da.setXYZW(n, d.cell, _c.r, _c.g, _c.b);
      n++;
    }
    this.decals.count = n;
    this.decals.visible = n > 0;
    this.decals.instanceMatrix.needsUpdate = true;
    da.needsUpdate = true;
    if (n > 0) {
      this.decals.computeBoundingSphere();
      this.decals.frustumCulled = true;
    }

    // 10A-2 PropContactShadows: cars + vending + dumpsters + jersey barriers + benches first, then debris/scrap.
    const sa = this.contactShadows.geometry.getAttribute('aAlpha') as THREE.InstancedBufferAttribute;
    let sn = 0;
    const addShadow = (x: number, z: number, yaw: number, w: number, d: number, alpha: number): void => {
      if (sn >= PROPS.CAP.CONTACT_SHADOW) return;
      _p.set(x, CONTACT_SHADOW_Y, z);
      _q.setFromEuler(_e.set(0, yaw, 0));
      _s.set(w, 1, d);
      this.contactShadows.setMatrixAt(sn, _m4.compose(_p, _q, _s));
      sa.setX(sn, alpha);
      sn++;
    };
    for (const ex of extraShadows) addShadow(ex.x, ex.z, ex.yaw, ex.w, ex.d, ex.alpha ?? 0.62);
    for (const p of props) {
      if (p.y > 0.15) continue;
      if (p.kit === 'DUMPSTER') {
        const def = PROP_DEFS[p.id];
        addShadow(p.x, p.z, p.yaw, def.w * p.s * 1.24, def.d * p.s * 1.28, 0.64);
      } else if (p.id === 'JERSEY') {
        const def = PROP_DEFS[p.id];
        addShadow(p.x, p.z, p.yaw, def.w * p.s * 1.18, def.d * p.s * 1.48, 0.56);
      } else if (p.kit === 'BENCH') {
        const def = PROP_DEFS[p.id];
        addShadow(p.x, p.z, p.yaw, def.w * p.s * 1.14, def.d * p.s * 1.38, 0.48);
      }
    }
    for (const p of props) {
      if (sn >= PROPS.CAP.CONTACT_SHADOW) break;
      if (p.y > 0.15) continue;
      if (p.kit === 'DEBRIS' || p.id === 'PALLETS' || p.id === 'DRUMS') {
        const def = PROP_DEFS[p.id];
        addShadow(p.x, p.z, p.yaw, def.w * p.s * 1.26, def.d * p.s * 1.26, 0.46);
      }
    }
    this.contactShadows.count = sn;
    this.contactShadows.visible = sn > 0;
    this.contactShadows.instanceMatrix.needsUpdate = true;
    sa.needsUpdate = true;
    if (sn > 0) {
      this.contactShadows.computeBoundingSphere();
      this.contactShadows.frustumCulled = true;
    }

    return { counts, decals: n, contactShadows: sn };
  }
}
