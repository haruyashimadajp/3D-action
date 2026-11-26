/**
 * STRAND // PROTOCOL — Phase 10C hero street furniture (HERO_3D_MODELING_SPEC §2–§3): recessed vending kiosk,
 * detailed gooseneck street lamp, and the `StreetFurnishingsKit` (one instanced draw, variants 0..3 reserved:
 * v0 festoon lantern string · v1 rain-wet cafe parasol · v2 ramen cart · v3 bus shelter — the last two are 10D).
 * Pure geometry builders (no CityBuilder dependency) so the triangle / ground-contact budgets are unit-testable.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { VENDING_ATLAS } from '../engine/ProceduralTextures';
import { box, cyl, plane, rod, type PartList } from './CityVehicles';

/** Triangle ceilings (spec §0 / §6): vending / furnishing variants. */
export const FURNITURE_TRI_BUDGET = 450;
export const LAMP_HEIGHT_M = 6.65;

function finish(list: PartList): THREE.BufferGeometry {
  if (list.length === 0) {
    // Reserved variants (10D) emit nothing yet: an empty geometry with the kit's attribute layout.
    const e = new THREE.BufferGeometry();
    for (const [name, size] of [['position', 3], ['normal', 3], ['aPart', 1], ['aAo', 1], ['aVar', 1]] as const) e.setAttribute(name, new THREE.BufferAttribute(new Float32Array(0), size));
    e.computeBoundingBox();
    return e;
  }
  const merged = mergeGeometries(list, false);
  for (const p of list) p.dispose();
  if (!merged) throw new Error('CityFurniture: mergeGeometries failed');
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

/** Adds `aPart`, baked `aAo` (ground ramp below 0.30 m × cavity factor), optional `uv` rect (u0, v0, u1, v1) and `aVar`. */
function tag(list: PartList, g: THREE.BufferGeometry, part: number, cavity = 1, uvRect?: readonly number[], variant?: number): void {
  const out = g.index ? g.toNonIndexed() : g;
  const uvSrc = out.getAttribute('uv');
  const uvVals = uvSrc ? Float32Array.from(uvSrc.array as ArrayLike<number>) : null;
  for (const name of Object.keys(out.attributes)) if (name !== 'position' && name !== 'normal') out.deleteAttribute(name);
  const pos = out.getAttribute('position');
  const n = pos.count;
  const ao = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const y = pos.getY(i);
    ao[i] = cavity * (y < 0.3 ? 0.45 + 0.55 * (Math.max(y, 0) / 0.3) : 1);
  }
  out.setAttribute('aPart', new THREE.BufferAttribute(new Float32Array(n).fill(part), 1));
  out.setAttribute('aAo', new THREE.BufferAttribute(ao, 1));
  if (uvRect !== undefined || variant === undefined) {
    const uv = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      if (uvRect && uvVals) {
        uv[i * 2] = uvRect[0] + (uvRect[2] - uvRect[0]) * uvVals[i * 2];
        uv[i * 2 + 1] = uvRect[1] + (uvRect[3] - uvRect[1]) * uvVals[i * 2 + 1];
      }
    }
    out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  }
  if (variant !== undefined) out.setAttribute('aVar', new THREE.BufferAttribute(new Float32Array(n).fill(variant), 1));
  list.push(out);
}

// =============================================================================================
// 2. Vending kiosk (1.10 × 2.05 × 0.78 m, front +Z)
// =============================================================================================
/**
 * aPart: 0 painted steel · 1 display (atlas) · 2 marquee (atlas) · 3 control bezel (atlas) · 4 dark cavity / rubber ·
 * 5 brushed steel (rails, flap) · 6 white downlight strip · 7 per-instance tint accent · 8 anodised bezel.
 * UVs address the brand-0 quadrant of `VENDING_ATLAS`; the material offsets them per instance brand (aBrand).
 */
export function buildVendingGeometry(): THREE.BufferGeometry {
  const L: PartList = [];
  const S = VENDING_ATLAS.SIZE;
  const rect = (r: readonly number[]): number[] => [r[0] / S, 1 - (r[1] + r[3]) / S, (r[0] + r[2]) / S, 1 - r[1] / S];
  // Plinth, side panels (0.08 m), solid back.
  tag(L, box(1.04, 0.12, 0.72, 0, 0.06, 0), 4, 0.42);
  for (const sx of [-1, 1]) tag(L, box(0.08, 1.74, 0.78, sx * 0.51, 0.99, 0), 0);
  tag(L, box(1.02, 1.74, 0.08, 0, 0.99, -0.35), 0);
  // Front slab pieces around the two recesses (display 0.14 m deep, chute 0.19 m deep).
  tag(L, box(0.94, 0.04, 0.19, 0, 1.84, 0.295), 0);
  tag(L, box(0.73, 0.12, 0.19, -0.105, 0.62, 0.295), 0);
  tag(L, box(0.94, 0.04, 0.19, 0, 0.14, 0.295), 0);
  tag(L, box(0.21, 1.66, 0.22, 0.365, 0.99, 0.31), 8); // protruding right control bezel
  // Recessed illuminated display window with 3 real metal shelf rails.
  tag(L, plane(0.73, 1.14, -0.105, 1.25, 0.25), 1, 0.85, rect(VENDING_ATLAS.DISPLAY));
  for (const y of [0.94, 1.22, 1.5]) tag(L, box(0.73, 0.02, 0.08, -0.105, y, 0.3), 5);
  tag(L, plane(0.73, 0.012, -0.105, 1.835, 0.391), 7); // lit tint trim along the glass frame
  // Deep pickup chute: dark cavity, tilted brushed-steel hinged flap, rubber bumper edge.
  tag(L, plane(0.73, 0.4, -0.105, 0.36, 0.2), 4, 0.34);
  tag(L, box(0.66, 0.3, 0.025, -0.105, 0.36, 0.33, [0.18, 0, 0]), 5);
  tag(L, box(0.66, 0.03, 0.04, -0.105, 0.21, 0.36), 4);
  // Control bezel face: touchscreen, NFC ring, card slot (all in the atlas).
  tag(L, plane(0.18, 0.6, 0.365, 1.16, 0.4215), 3, 1, rect(VENDING_ATLAS.CONTROL));
  // Marquee hood projecting 0.06 m, brand banner + white underside downlight strip.
  tag(L, box(1.1, 0.19, 0.84, 0, 1.955, 0.03), 0);
  tag(L, plane(0.9, 0.15, 0, 1.96, 0.4505), 2, 1, rect(VENDING_ATLAS.MARQUEE));
  tag(L, plane(0.9, 0.05, 0, 1.859, 0.42, [Math.PI / 2, 0, 0]), 6);
  tag(L, plane(0.5, 0.3, 0, 2.051, -0.1, [-Math.PI / 2, 0, 0]), 4, 0.6); // top heat-exhaust grate
  // Armour: 5 slanted louvres per flank, rubber corner bumper rails.
  for (const sx of [-1, 1]) {
    for (let k = 0; k < 5; k++) tag(L, plane(0.5, 0.035, sx * 0.5525, 0.9 + k * 0.17, -0.02, [0, sx * (Math.PI / 2), 0.35]), 4, 0.5);
    tag(L, box(0.06, 1.7, 0.06, sx * 0.54, 0.99, 0.37), 4);
  }
  return finish(L);
}

// =============================================================================================
// 3.1 Detailed street lamp (6.65 m, arm reaching +Z over the road)
// =============================================================================================
/**
 * aPart: 0 painted cast-iron / steel · 1 luminaire LED lens · 2 neon accent ring (instance tint) · 3 green status LED ·
 * 5 banner flag cloth · 6 banner neon trim · 7 dark-steel banner arms. Parts > 4.5 (flag + trim + arms) collapse
 * together on every other lamp, so alternating poles carry the banner with nothing left floating.
 */
export function buildLampGeometry(): THREE.BufferGeometry {
  const L: PartList = [];
  tag(L, cyl(0.24, 0.24, 0.08, 8, 0, 0.04, 0, [0, 0, 0], true), 0); // octagonal flange plate
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) tag(L, box(0.045, 0.05, 0.045, sx * 0.17, 0.105, sz * 0.17), 0); // anchor bolts
  tag(L, cyl(0.14, 0.2, 0.47, 8, 0, 0.315, 0), 0); // stepped collar plinth
  tag(L, cyl(0.075, 0.11, 5.25, 8, 0, 3.175, 0), 0); // tapered shaft
  // Latched electrical service cabinet (sidewalk side, −Z) with a green status LED; ribbed mounting collars.
  tag(L, box(0.22, 0.42, 0.16, 0, 1.35, -0.16), 0);
  tag(L, plane(0.035, 0.035, 0.06, 1.5, -0.2415, [0, Math.PI, 0]), 3);
  for (const y of [0.95, 1.75]) tag(L, cyl(0.1, 0.1, 0.06, 8, 0, y, 0), 0);
  // Twin banner arms (+X) with the district flag stretched arm to arm and a neon trim along its bottom edge
  // (10BC-Fix FIX-9: arms 7, cloth 5, trim 6 all > 4.5, so they hide together on alternating poles).
  for (const y of [3.2, 4.4]) tag(L, box(0.55, 0.04, 0.04, 0.3, y, 0), 7);
  tag(L, plane(0.42, 1.14, 0.35, 3.81, 0.012), 5);
  tag(L, plane(0.42, 1.14, 0.35, 3.81, -0.012, [0, Math.PI, 0]), 5);
  tag(L, box(0.42, 0.04, 0.03, 0.35, 3.23, 0), 6);
  tag(L, cyl(0.16, 0.16, 0.07, 8, 0, 3.2, 0), 2); // accent light ring on the pole
  // Curved gooseneck (6-point arc) into the ribbed-heatsink luminaire head with a recessed LED lens.
  const arc = [[5.8, 0], [6.35, 0.25], [6.62, 0.6], [6.65, 1.0], [6.6, 1.5], [6.5, 2.05]];
  for (let i = 0; i < arc.length - 1; i++) tag(L, rod(new THREE.Vector3(0, arc[i][0], arc[i][1]), new THREE.Vector3(0, arc[i + 1][0], arc[i + 1][1]), 0.045, 5), 0);
  tag(L, box(0.46, 0.15, 0.96, 0, 6.42, 2.05), 0);
  for (const x of [-0.12, 0, 0.12]) tag(L, box(0.03, 0.05, 0.88, x, 6.52, 2.05), 0);
  tag(L, plane(0.38, 0.84, 0, 6.3425, 2.05, [Math.PI / 2, 0, 0]), 1);
  return finish(L);
}

// =============================================================================================
// 3.2 StreetFurnishingsKit
// =============================================================================================
export const KIT_VARIANT = { LANTERNS: 0, PARASOL: 1, RAMEN_CART: 2, BUS_SHELTER: 3 } as const;
export const KIT_CAP = 300;
export const KIT_STRING_SPAN_M = 4.2;
export const KIT_STRING_SAG_M = 0.35;
export const KIT_PARASOL_R = 1.28;
export const KIT_PARASOL_H = 2.45;

/**
 * aPart per variant — v0: 0 wire / wood ring · 1 red paper lantern · 2 orange paper lantern.
 * v1: 0 steel pole / base · 1 canopy · 2 canopy underside · 3 warm cage bulb. `aVar` = variant of every vertex.
 */
function lanternString(L: PartList): void {
  const V = KIT_VARIANT.LANTERNS;
  const span = KIT_STRING_SPAN_M;
  const sag = KIT_STRING_SAG_M;
  const wireY = (u: number): number => -sag * (1 - u * u);
  const wireAt = (u: number): THREE.Vector3 => new THREE.Vector3(u * span * 0.5, wireY(u), 0);
  for (let i = 0; i < 6; i++) tag(L, rod(wireAt(-1 + (2 * i) / 6), wireAt(-1 + (2 * (i + 1)) / 6), 0.012, 3), 0, 1, undefined, V);
  [-0.8, -0.4, 0, 0.4, 0.8].forEach((u, k) => {
    const x = u * span * 0.5;
    const top = wireY(u) - 0.06;
    const lathePts = [[0.045, -0.17], [0.12, -0.09], [0.14, 0.0], [0.12, 0.09], [0.045, 0.17]].map(([r, y]) => new THREE.Vector2(r, y));
    const lg = new THREE.LatheGeometry(lathePts, 6).toNonIndexed();
    lg.translate(x, top - 0.17, 0);
    tag(L, lg, k % 2 === 0 ? 1 : 2, 1, undefined, V);
    tag(L, cyl(0.05, 0.05, 0.025, 6, x, top + 0.005, 0), 0, 1, undefined, V);
  });
}

function parasol(L: PartList): void {
  const V = KIT_VARIANT.PARASOL;
  const R = KIT_PARASOL_R;
  tag(L, cyl(0.28, 0.28, 0.08, 8, 0, 0.04, 0, [0, 0, 0], true), 0, 1, undefined, V); // weighted octagonal base
  tag(L, cyl(0.028, 0.028, 2.4, 6, 0, 1.25, 0), 0, 1, undefined, V); // steel pole
  const outer = [[R, 2.02], [R, 2.12], [0.9, 2.26], [0.45, 2.38], [0, KIT_PARASOL_H]].map(([r, y]) => new THREE.Vector2(r, y));
  tag(L, new THREE.LatheGeometry(outer, 8).toNonIndexed(), 1, 1, undefined, V);
  const inner = [[0, KIT_PARASOL_H - 0.03], [0.45, 2.35], [0.9, 2.23], [R - 0.02, 2.1]].map(([r, y]) => new THREE.Vector2(r, y));
  tag(L, new THREE.LatheGeometry(inner, 8).toNonIndexed(), 2, 0.45, undefined, V);
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
    tag(L, rod(new THREE.Vector3(Math.cos(a) * 0.08, 2.3, Math.sin(a) * 0.08), new THREE.Vector3(Math.cos(a) * (R - 0.08), 2.12, Math.sin(a) * (R - 0.08)), 0.012, 3), 0, 0.45, undefined, V);
  }
  tag(L, box(0.07, 0.09, 0.07, 0, 2.03, 0), 3, 1, undefined, V); // tiny warm cage bulb under the hub
}

/** Merged kit geometry: `position`, `normal`, `uv` (unused), `aPart`, `aAo`, `aVar`. Variants 2 / 3 are 10D. */
export function buildFurnishingsKit(variants: readonly number[] = [KIT_VARIANT.LANTERNS, KIT_VARIANT.PARASOL]): THREE.BufferGeometry {
  const L: PartList = [];
  if (variants.includes(KIT_VARIANT.LANTERNS)) lanternString(L);
  if (variants.includes(KIT_VARIANT.PARASOL)) parasol(L);
  return finish(L);
}

/** Triangle count of the variant `v` alone (budget test). */
export function kitVariantTris(v: number): number {
  const g = buildFurnishingsKit([v]);
  const n = g.getAttribute('position').count / 3;
  g.dispose();
  return n;
}
