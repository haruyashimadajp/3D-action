/**
 * STRAND // PROTOCOL — Phase 10C-1 hero parked vehicles (HERO_3D_MODELING_SPEC §0–§1).
 *
 * Every body is a `loftSymHull`: cross-section stations along Z (front +Z → rear −Z), each a right-half profile
 * (bottom centre → rocker → fender → shoulder → top centre) mirrored to the left half — never a side profile
 * extruded across X. Hard creases (> `smoothCreaseDeg`) keep split normals, smooth curves share averaged ones.
 *
 * Per-vertex attributes (non-indexed, one merged geometry per variant → one instanced draw each):
 *   aPart  0 painted body · 1 glass · 2 front LED · 3 rear LED · 4 carbon / rubber / dark mesh · 5 taxi roof sign ·
 *          6 brushed alloy · 7 crimson caliper / tow hook · 8 glowing plate · 9 amber marker / strobe (blinks)
 *   aAo    baked ground-contact + cavity occlusion (`y < 0.30` ramp, recesses 0.35–0.50)
 * Ground contact is exact: every wheel's lowest tyre vertex sits on y = 0.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type HullPoint = readonly [number, number];
export interface LoftStation {
  /** Station plane (front = largest z). */
  readonly z: number;
  /** Right-half profile `(x ≥ 0, y)`: bottom centreline → rocker → fender → shoulder → top centreline. */
  readonly pts: ReadonlyArray<HullPoint>;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _n = new THREE.Vector3();

/**
 * Lofts a closed, capped, mirrored hull through `stations` (same point count each). Adjacent rings become quad
 * strips; vertex normals are averaged over neighbouring faces whose dihedral angle is ≤ `smoothCreaseDeg`.
 * Returns a non-indexed geometry with `position` + `normal` (outward-facing, counter-clockwise).
 */
export function loftSymHull(stations: ReadonlyArray<LoftStation>, smoothCreaseDeg = 35): THREE.BufferGeometry {
  const S = stations.length;
  const P = stations[0].pts.length;
  if (S < 2 || P < 3) throw new Error('loftSymHull: needs ≥ 2 stations with ≥ 3 points');
  for (const st of stations) if (st.pts.length !== P) throw new Error('loftSymHull: every station needs the same point count');
  const N = 2 * P - 2;
  const ring: THREE.Vector3[][] = stations.map((st) => {
    const r: THREE.Vector3[] = [];
    for (let i = 0; i < N; i++) {
      if (i < P) r.push(new THREE.Vector3(st.pts[i][0], st.pts[i][1], st.z));
      else {
        const j = 2 * P - 2 - i;
        r.push(new THREE.Vector3(-st.pts[j][0], st.pts[j][1], st.z));
      }
    }
    return r;
  });
  const cx = ring.map((r) => r.reduce((s, v) => s + v.x, 0) / N);
  const cy = ring.map((r) => r.reduce((s, v) => s + v.y, 0) / N);

  // Face normals per quad (k, i): corners a (k,i) b (k,i+1) c (k+1,i+1) d (k+1,i), oriented away from the ring axis.
  const flip: boolean[][] = [];
  const fn: THREE.Vector3[][] = [];
  for (let k = 0; k < S - 1; k++) {
    flip.push([]);
    fn.push([]);
    for (let i = 0; i < N; i++) {
      const i1 = (i + 1) % N;
      _a.copy(ring[k][i]);
      _b.copy(ring[k][i1]);
      _c.copy(ring[k + 1][i1]);
      _d.copy(ring[k + 1][i]);
      _n.subVectors(_c, _a).cross(_b.clone().sub(_d).multiplyScalar(-1)); // (c − a) × (d − b)
      const mx = (_a.x + _b.x + _c.x + _d.x) / 4 - (cx[k] + cx[k + 1]) / 2;
      const my = (_a.y + _b.y + _c.y + _d.y) / 4 - (cy[k] + cy[k + 1]) / 2;
      let f = false;
      if (_n.x * mx + _n.y * my < 0) {
        _n.negate();
        f = true;
      }
      const len = _n.length();
      flip[k].push(f);
      fn[k].push(len > 1e-9 ? _n.clone().divideScalar(len) : new THREE.Vector3());
    }
  }
  const cosC = Math.cos((smoothCreaseDeg * Math.PI) / 180);
  const smooth = (k: number, i: number, qk: number, qi: number): THREE.Vector3 => {
    const base = fn[qk][qi];
    const out = new THREE.Vector3();
    for (const kk of [k - 1, k]) {
      if (kk < 0 || kk > S - 2) continue;
      for (const ii of [i - 1, i]) {
        const q = fn[kk][(ii + N) % N];
        if (q.lengthSq() < 0.5) continue;
        if (base.lengthSq() < 0.5 || q.dot(base) >= cosC) out.add(q);
      }
    }
    return out.lengthSq() > 1e-12 ? out.normalize() : base.clone();
  };

  const pos: number[] = [];
  const nor: number[] = [];
  const push = (v: THREE.Vector3, n: THREE.Vector3): void => {
    pos.push(v.x, v.y, v.z);
    nor.push(n.x, n.y, n.z);
  };
  for (let k = 0; k < S - 1; k++) {
    for (let i = 0; i < N; i++) {
      const i1 = (i + 1) % N;
      const corners: Array<[number, number]> = [[k, i], [k, i1], [k + 1, i1], [k + 1, i]];
      const vs = corners.map(([kk, ii]) => ring[kk][ii]);
      const ns = corners.map(([kk, ii]) => smooth(kk, ii, k, i));
      const order = flip[k][i] ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3];
      for (const o of order) push(vs[o], ns[o]);
    }
  }
  // Flat caps (fan from the ring centroid): front +Z, rear −Z.
  for (const [k, nz] of [[0, 1], [S - 1, -1]] as const) {
    const c = new THREE.Vector3(cx[k], cy[k], stations[k].z);
    const cn = new THREE.Vector3(0, 0, nz);
    for (let i = 0; i < N; i++) {
      const p0 = ring[k][i];
      const p1 = ring[k][(i + 1) % N];
      _n.subVectors(p0, c).cross(_a.subVectors(p1, c));
      if (_n.z * nz >= 0) {
        push(c, cn);
        push(p0, cn);
        push(p1, cn);
      } else {
        push(c, cn);
        push(p1, cn);
        push(p0, cn);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return g;
}

// =============================================================================================
// Small primitive helpers (non-indexed, position + normal only, world-space)
// =============================================================================================
type Euler3 = readonly [number, number, number];
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s1 = new THREE.Vector3(1, 1, 1);

export function place(g: THREE.BufferGeometry, x: number, y: number, z: number, rot: Euler3 = [0, 0, 0], order: THREE.EulerOrder = 'XYZ'): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g;
  _q.setFromEuler(_e.set(rot[0], rot[1], rot[2], order));
  _m.compose(new THREE.Vector3(x, y, z), _q, _s1);
  out.applyMatrix4(_m);
  return out;
}

/** Box without its (invisible) bottom face: 10 triangles. */
export function box(w: number, h: number, d: number, x: number, y: number, z: number, rot: Euler3 = [0, 0, 0], bottom = false): THREE.BufferGeometry {
  const ni = new THREE.BoxGeometry(w, h, d).toNonIndexed();
  let g = ni;
  if (!bottom) {
    // BoxGeometry face order px, nx, py, ny, pz, nz — 6 vertices each once non-indexed.
    const keep = [0, 1, 2, 4, 5];
    const pos = ni.getAttribute('position');
    const nor = ni.getAttribute('normal');
    const p: number[] = [];
    const n: number[] = [];
    for (const f of keep) {
      for (let v = 0; v < 6; v++) {
        p.push(pos.getX(f * 6 + v), pos.getY(f * 6 + v), pos.getZ(f * 6 + v));
        n.push(nor.getX(f * 6 + v), nor.getY(f * 6 + v), nor.getZ(f * 6 + v));
      }
    }
    g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(n, 3));
  }
  return place(g, x, y, z, rot);
}

/** Single-sided quad facing +Z before rotation (2 triangles). */
export function plane(w: number, h: number, x: number, y: number, z: number, rot: Euler3 = [0, 0, 0], order: THREE.EulerOrder = 'XYZ'): THREE.BufferGeometry {
  return place(new THREE.PlaneGeometry(w, h), x, y, z, rot, order);
}

/** Cylinder along Y (rotate to aim it), open-ended unless `caps`. */
export function cyl(rTop: number, rBot: number, h: number, radial: number, x: number, y: number, z: number, rot: Euler3 = [0, 0, 0], caps = false): THREE.BufferGeometry {
  return place(new THREE.CylinderGeometry(rTop, rBot, h, radial, 1, !caps), x, y, z, rot);
}

/** Cylinder from point A to point B. */
export function rod(a: THREE.Vector3, b: THREE.Vector3, r: number, radial = 6): THREE.BufferGeometry {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(r, r, len, radial, 1, true);
  const dir = b.clone().sub(a).normalize();
  const qq = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  const mid = a.clone().add(b).multiplyScalar(0.5);
  const ng = g.toNonIndexed();
  ng.deleteAttribute('uv');
  ng.applyMatrix4(new THREE.Matrix4().compose(mid, qq, _s1));
  return ng;
}

export type PartList = THREE.BufferGeometry[];

/** Tags a geometry with `aPart` and baked `aAo` (ground ramp below y = 0.30 × optional cavity factor). */
function tag(list: PartList, g: THREE.BufferGeometry, part: number, cavity = 1): void {
  const out = g.index ? g.toNonIndexed() : g;
  for (const name of Object.keys(out.attributes)) if (name !== 'position' && name !== 'normal') out.deleteAttribute(name);
  const pos = out.getAttribute('position');
  const n = pos.count;
  const ao = new Float32Array(n);
  const pa = new Float32Array(n).fill(part);
  for (let i = 0; i < n; i++) {
    const y = pos.getY(i);
    ao[i] = cavity * (y < 0.3 ? 0.45 + 0.55 * (Math.max(y, 0) / 0.3) : 1);
  }
  out.setAttribute('aPart', new THREE.BufferAttribute(pa, 1));
  out.setAttribute('aAo', new THREE.BufferAttribute(ao, 1));
  list.push(out);
}

// =============================================================================================
// 1.1 Shared hero wheel
// =============================================================================================
/**
 * Four-corner wheel in the spec's recipe, trimmed to the triangle budget (≈ 120 tris): rubber tyre lathe (12 radial,
 * shouldered sidewall), recessed alloy barrel, brake-rotor disc inset behind seven flat spokes, crimson caliper on
 * the rear-upper quadrant. `side` +1 = outer face toward +X. The wheel's lowest tyre vertex lies on y = 0.
 */
export function buildHeroWheel(list: PartList, radius: number, width: number, x: number, side: 1 | -1): void {
  const R = radius;
  const hw = width / 2;
  const y = radius;
  const M = new THREE.Matrix4().makeRotationZ((-side * Math.PI) / 2);
  const local: Array<[THREE.BufferGeometry, number, number]> = [];
  const lathe = (pts: Array<[number, number]>, seg: number): THREE.BufferGeometry => {
    const g = new THREE.LatheGeometry(pts.map(([r, yy]) => new THREE.Vector2(r, yy)), seg).toNonIndexed();
    g.deleteAttribute('uv');
    return g;
  };
  // Tyre (+Y = outer face): inner crown edge → tread → shoulder → sidewall to the rim.
  local.push([lathe([[0.97 * R, -hw], [R, -hw * 0.5], [R, hw * 0.55], [0.64 * R, hw]], 12), 4, 1]);
  // Alloy barrel (deep dish) and the brake rotor / caliper sitting behind the spokes.
  // 10BC-Fix FIX-8: points run outer face → hub side so the lathe normals face the axle (barrel seen from outside).
  local.push([lathe([[0.62 * R, hw * 0.92], [0.62 * R, hw * 0.25]], 8), 6, 0.5]);
  const rotor = new THREE.CircleGeometry(0.46 * R, 8);
  rotor.rotateX(-Math.PI / 2);
  rotor.translate(0, hw * 0.3, 0);
  local.push([rotor.toNonIndexed(), 6, 0.7]);
  for (let k = 0; k < 7; k++) {
    const sp = new THREE.PlaneGeometry(0.06 * R, 0.5 * R);
    sp.rotateX(-Math.PI / 2);
    sp.translate(0, hw * 0.88, 0.27 * R);
    sp.rotateY((k / 7) * Math.PI * 2);
    local.push([sp.toNonIndexed(), 6, 1]);
  }
  // Caliper: world rear-upper quadrant (+40° behind the top). Local x = −side × world up, local z = world z.
  const ang = (40 * Math.PI) / 180;
  const cal = new THREE.BoxGeometry(0.14, 0.05, 0.06).toNonIndexed();
  cal.translate(-side * 0.42 * R * Math.cos(ang), hw * 0.52, -0.42 * R * Math.sin(ang));
  local.push([cal, 7, 1]);
  const T = new THREE.Matrix4().makeTranslation(x, y, 0);
  for (const [g, part, cav] of local) {
    const out = g.index ? g.toNonIndexed() : g;
    for (const name of Object.keys(out.attributes)) if (name !== 'position' && name !== 'normal') out.deleteAttribute(name);
    out.applyMatrix4(M);
    out.applyMatrix4(T);
    tag(list, out, part, cav);
  }
}

/** Wheel at world z (builds at z = 0 then slides along Z; keeps the tyre's lowest vertex on y = 0). */
function wheelAt(list: PartList, radius: number, width: number, x: number, z: number, side: 1 | -1): void {
  const tmp: PartList = [];
  buildHeroWheel(tmp, radius, width, x, side);
  for (const g of tmp) {
    g.translate(0, 0, z);
    list.push(g);
  }
}

// =============================================================================================
// Variants
// =============================================================================================
export const CAR_VARIANT_NAMES = ['Coupe', 'Pickup', 'Van'] as const;
/** Footprint / height of each hero variant (width, height, length) — colliders, shadows, light placement. */
export const CAR_DIMS: ReadonlyArray<readonly [number, number, number]> = [
  [2.06, 1.18, 4.66],
  [2.12, 1.88, 5.1],
  [2.08, 2.08, 4.95],
];
/** Triangle ceiling for every hero vehicle (spec §0 / §6). */
export const CAR_TRI_BUDGET = 1100;

const mirror = (fn: (sx: 1 | -1) => void): void => {
  fn(1);
  fn(-1);
};

function buildCoupe(): PartList {
  const L: PartList = [];
  const body = loftSymHull([
    { z: 2.33, pts: [[0, 0.2], [0.34, 0.21], [0.56, 0.32], [0.64, 0.44], [0.4, 0.47], [0, 0.45]] },
    { z: 2.05, pts: [[0, 0.18], [0.76, 0.19], [0.94, 0.36], [0.97, 0.56], [0.62, 0.6], [0, 0.54]] },
    { z: 1.36, pts: [[0, 0.16], [0.86, 0.17], [1.01, 0.44], [1.02, 0.72], [0.68, 0.76], [0, 0.7]] },
    { z: 0.72, pts: [[0, 0.16], [0.88, 0.17], [0.97, 0.46], [0.96, 0.78], [0.7, 0.8], [0, 0.78]] },
    { z: -0.15, pts: [[0, 0.16], [0.86, 0.17], [0.92, 0.45], [0.94, 0.82], [0.72, 0.84], [0, 0.82]] },
    { z: -1.05, pts: [[0, 0.17], [0.92, 0.18], [1.03, 0.5], [1.03, 0.88], [0.74, 0.9], [0, 0.88]] },
    { z: -1.85, pts: [[0, 0.2], [0.9, 0.22], [1.0, 0.54], [0.98, 0.9], [0.7, 0.91], [0, 0.89]] },
    { z: -2.33, pts: [[0, 0.28], [0.8, 0.3], [0.92, 0.56], [0.9, 0.86], [0.62, 0.88], [0, 0.86]] },
  ]);
  tag(L, body, 0);
  // Teardrop greenhouse, markedly narrower than the fenders.
  const cabin = loftSymHull([
    { z: 0.95, pts: [[0, 0.77], [0.6, 0.77], [0.56, 0.79], [0, 0.8]] },
    { z: 0.8, pts: [[0, 0.78], [0.68, 0.78], [0.62, 0.81], [0, 0.82]] },
    { z: 0.2, pts: [[0, 0.8], [0.7, 0.82], [0.54, 1.13], [0, 1.16]] },
    { z: -0.45, pts: [[0, 0.82], [0.69, 0.84], [0.53, 1.13], [0, 1.15]] },
    { z: -1.25, pts: [[0, 0.86], [0.58, 0.88], [0.44, 0.94], [0, 0.95]] },
  ]);
  tag(L, cabin, 1);
  mirror((sx) => {
    // Angled painted A-pillar + matte intake splitter vane.
    tag(L, box(0.045, 0.045, 0.62, sx * 0.62, 0.965, 0.46, [0.566, 0, 0]), 0);
    // Front: dual angular air intakes (dark pockets), recessed headlight housings with Y-beam DRL blades.
    tag(L, box(0.5, 0.2, 0.1, sx * 0.56, 0.3, 2.14), 4, 0.35);
    tag(L, box(0.3, 0.1, 0.2, sx * 0.66, 0.54, 1.93, [-0.28, sx * 0.31, 0]), 4, 0.5);
    tag(L, plane(0.024, 0.18, sx * 0.66, 0.54, 2.06, [-0.28, sx * 0.31, 0]), 2);
    tag(L, plane(0.024, 0.14, sx * 0.6, 0.575, 2.06, [-0.28, sx * 0.31, sx * 0.62]), 2);
    tag(L, plane(0.024, 0.14, sx * 0.72, 0.575, 2.06, [-0.28, sx * 0.31, -sx * 0.62]), 2);
    // Side intake scoop (deep wedge pocket) + rocker skirt.
    tag(L, box(0.14, 0.36, 0.58, sx * 0.93, 0.58, -0.62), 4, 0.35);
    tag(L, box(0.1, 0.1, 1.96, sx * 0.94, 0.18, 0), 4);
    // Wing mirrors on angled stalks.
    tag(L, box(0.22, 0.025, 0.03, sx * 0.95, 0.84, 0.45, [0, 0, sx * 0.1]), 4);
    tag(L, box(0.08, 0.06, 0.14, sx * 1.06, 0.86, 0.44), 0);
    // Twin-strut GT wing: swan-neck pylons + endplates.
    tag(L, box(0.04, 0.28, 0.06, sx * 0.46, 1.03, -2.12), 4);
    tag(L, box(0.025, 0.16, 0.32, sx * 0.94, 1.16, -2.18), 4);
  });
  tag(L, box(1.92, 0.045, 0.42, 0, 0.16, 2.14), 4); // carbon chin splitter
  tag(L, box(1.88, 0.035, 0.28, 0, 1.18, -2.18, [0.105, 0, 0]), 4); // wing airfoil
  tag(L, box(0.36, 0.1, 0.18, 0, 1.2, -0.45), 5); // cyber-taxi roof sign (taxi paint only)
  for (const z of [-1.35, -1.75]) tag(L, box(0.9, 0.02, 0.1, 0, 0.93, z, [0.12, 0, 0]), 4); // louvered engine deck
  // Tail: dark fascia, wrap Y-branch LED bar, glowing plate, 3-fin diffuser, quad exhaust tips.
  tag(L, box(1.6, 0.16, 0.04, 0, 0.6, -2.35), 4, 0.5);
  tag(L, box(1.5, 0.04, 0.03, 0, 0.66, -2.375), 3);
  mirror((sx) => tag(L, box(0.05, 0.18, 0.03, sx * 0.66, 0.58, -2.375), 3));
  tag(L, box(0.36, 0.14, 0.02, 0, 0.44, -2.36), 8);
  for (const x of [-0.4, 0, 0.4]) tag(L, box(0.03, 0.12, 0.3, x, 0.26, -2.2), 4);
  for (const x of [-0.3, -0.16, 0.16, 0.3]) tag(L, cyl(0.048, 0.048, 0.14, 6, x, 0.3, -2.4, [Math.PI / 2, 0, 0]), 6);
  // Wheels: rear wider.
  for (const [z, w] of [[1.36, 0.29], [-1.38, 0.33]] as const) {
    mirror((sx) => wheelAt(L, 0.34, w, sx * (1.03 - w / 2 - 0.01), z, sx));
  }
  return L;
}

function buildPickup(): PartList {
  const L: PartList = [];
  const cab = loftSymHull([
    { z: 2.5, pts: [[0, 0.42], [0.8, 0.44], [1.0, 0.7], [1.02, 1.12], [0.7, 1.18], [0, 1.24]] },
    { z: 1.6, pts: [[0, 0.34], [0.92, 0.34], [1.06, 0.62], [1.06, 1.14], [0.8, 1.18], [0, 1.24]] },
    { z: 0.95, pts: [[0, 0.34], [0.96, 0.34], [1.06, 0.6], [1.05, 1.12], [0.82, 1.16], [0, 1.2]] },
    { z: 0.5, pts: [[0, 0.34], [0.96, 0.34], [1.05, 0.62], [1.04, 1.2], [0.8, 1.8], [0, 1.84]] },
    { z: -0.2, pts: [[0, 0.34], [0.96, 0.34], [1.05, 0.62], [1.04, 1.22], [0.82, 1.82], [0, 1.84]] },
    { z: -0.5, pts: [[0, 0.34], [0.96, 0.34], [1.04, 0.6], [1.04, 1.2], [0.82, 1.8], [0, 1.84]] },
  ]);
  tag(L, cab, 0);
  // Greenhouse glass: windshield + side windows.
  // 10BC-Fix FIX-8: cab front slope (z 0.95, y 1.20) → (z 0.50, y 1.84) leans atan2(0.45, 0.64) back from vertical.
  tag(L, plane(1.52, 0.64, 0, 1.52, 0.745, [-0.613, 0, 0]), 1);
  mirror((sx) => {
    // Side window on the sloped upper cab flank (x 1.045, y 1.21) → (x 0.81, y 1.81): tilt first, then yaw (YXZ).
    tag(L, plane(0.84, 0.48, sx * 0.945, 1.52, 0.02, [-0.373, sx * Math.PI / 2, 0], 'YXZ'), 1);
  });
  // Front: illuminated-rim mesh grille, stacked quad LED bars, armoured bumper, plate, tow hooks.
  tag(L, box(1.36, 0.42, 0.06, 0, 0.76, 2.52), 4, 0.38);
  for (const y of [0.64, 0.76, 0.88]) tag(L, box(1.3, 0.03, 0.03, 0, y, 2.56), 6);
  mirror((sx) => {
    tag(L, box(0.34, 0.07, 0.04, sx * 0.82, 1.02, 2.51), 2);
    tag(L, box(0.34, 0.07, 0.04, sx * 0.82, 0.9, 2.51), 2);
    tag(L, box(0.05, 0.05, 0.14, sx * 0.56, 0.4, 2.62), 7);
    // Flared trapezoidal fender arches, running boards, truck mirrors.
    tag(L, box(0.12, 0.12, 1.0, sx * 1.07, 0.84, 1.58, [0, 0, sx * -0.12]), 4);
    tag(L, box(0.12, 0.12, 1.0, sx * 1.07, 0.84, -1.48, [0, 0, sx * -0.12]), 4);
    tag(L, box(0.1, 0.05, 1.7, sx * 1.07, 0.34, 0.05), 4);
    tag(L, box(0.16, 0.2, 0.1, sx * 1.14, 1.36, 0.58), 4);
    // Bed side walls (0.16 m thick), vertical red LED tail clusters.
    tag(L, box(0.16, 0.62, 2.02, sx * 0.98, 0.87, -1.49), 0);
    tag(L, box(0.07, 0.34, 0.04, sx * 0.9, 0.9, -2.54), 3);
    // Roll-bar posts (tubular) and work-light pods.
    tag(L, rod(new THREE.Vector3(sx * 0.82, 1.1, -0.66), new THREE.Vector3(sx * 0.82, 1.82, -0.66), 0.045), 6);
    tag(L, box(0.14, 0.1, 0.12, sx * 0.62, 1.84, -0.72), 2);
    // Dual side-exit exhaust.
    tag(L, cyl(0.04, 0.04, 0.3, 6, sx * 0.9, 0.3, -2.2, [Math.PI / 2, 0, 0]), 6);
  });
  tag(L, box(2.1, 0.26, 0.24, 0, 0.44, 2.56), 4); // heavy chin bumper
  tag(L, box(0.36, 0.16, 0.02, 0, 0.5, 2.69), 8); // glowing plate
  tag(L, rod(new THREE.Vector3(-0.82, 1.82, -0.66), new THREE.Vector3(0.82, 1.82, -0.66), 0.045), 6);
  for (const x of [-0.3, 0, 0.3]) tag(L, box(0.08, 0.04, 0.04, x, 1.87, 0.3), 9); // amber cab markers
  // Real hollow cargo bed: floor (recessed), tailgate, crates, rear bumper + plate.
  tag(L, box(1.84, 0.16, 2.0, 0, 0.54, -1.5, [0, 0, 0], true), 4, 0.42);
  tag(L, box(1.9, 0.62, 0.12, 0, 0.87, -2.5), 0); // tailgate
  tag(L, box(0.62, 0.42, 0.5, -0.4, 0.83, -1.1), 4); // strapped crates
  tag(L, box(0.5, 0.36, 0.5, 0.45, 0.8, -1.7), 0);
  tag(L, box(2.1, 0.2, 0.18, 0, 0.42, -2.58), 4);
  tag(L, box(0.34, 0.14, 0.02, 0, 0.62, -2.57), 8);
  tag(L, box(1.7, 0.2, 4.4, 0, 0.4, 0.1), 4, 0.5); // chassis / underbody
  tag(L, box(0.36, 0.1, 0.18, 0, 1.9, -0.2), 5);
  for (const [z, w] of [[1.58, 0.34], [-1.48, 0.34]] as const) mirror((sx) => wheelAt(L, 0.43, w, sx * (1.06 - w / 2 - 0.02), z, sx));
  return L;
}

function buildVan(): PartList {
  const L: PartList = [];
  const hull = loftSymHull([
    { z: 2.46, pts: [[0, 0.4], [0.72, 0.42], [0.9, 0.62], [0.92, 0.86], [0.66, 0.98], [0, 1.02]] },
    { z: 1.95, pts: [[0, 0.3], [0.94, 0.3], [1.04, 0.6], [1.04, 1.0], [0.78, 1.14], [0, 1.18]] },
    { z: 1.45, pts: [[0, 0.28], [1.0, 0.28], [1.04, 0.6], [1.04, 1.5], [0.9, 2.04], [0, 2.08]] },
    { z: -2.4, pts: [[0, 0.3], [0.98, 0.3], [1.03, 0.62], [1.03, 1.5], [0.9, 2.04], [0, 2.08]] },
    { z: -2.475, pts: [[0, 0.32], [0.94, 0.32], [0.99, 0.64], [0.99, 1.48], [0.86, 2.0], [0, 2.04]] },
  ]);
  tag(L, hull, 0);
  // 10BC-Fix FIX-8: front armour slope (z 1.95, y 1.18) → (z 1.45, y 2.08) leans atan2(0.50, 0.90) from vertical.
  tag(L, plane(1.36, 0.34, 0, 1.64, 1.715, [-0.507, 0, 0]), 1); // slit windshield under the visor brow
  tag(L, box(1.84, 0.06, 0.3, 0, 1.94, 1.52), 4); // overhanging steel visor
  tag(L, box(1.7, 0.2, 0.05, 0, 0.62, 2.45), 4, 0.4); // grille mesh
  tag(L, box(1.9, 0.18, 0.2, 0, 0.42, 2.42), 4);
  tag(L, box(0.34, 0.14, 0.02, 0, 0.5, -2.5), 8);
  tag(L, box(1.1, 0.07, 0.12, 0, 2.16, 1.0), 9); // amber strobe bar
  for (const x of [-0.75, 0.75]) tag(L, box(0.04, 0.05, 2.4, x, 2.14, -0.6), 6); // roof rack rails
  for (const z of [-1.7, -0.6, 0.5]) tag(L, box(1.5, 0.04, 0.04, 0, 2.14, z), 6);
  tag(L, box(0.02, 1.4, 0.02, 0, 1.2, -2.49), 4); // rear door split seam
  tag(L, box(0.36, 0.1, 0.18, 0, 2.2, -1.6), 5);
  mirror((sx) => {
    tag(L, box(0.3, 0.08, 0.04, sx * 0.62, 0.8, 2.48), 2); // headlights
    tag(L, box(0.08, 0.8, 0.03, sx * 0.88, 1.15, -2.5), 3); // vertical tail LED columns
    tag(L, box(0.16, 0.2, 0.1, sx * 1.1, 1.3, 1.5), 4); // mirrors
    for (const y of [0.84, 1.08, 1.32]) tag(L, box(0.04, 0.07, 3.2, sx * 1.06, y, -0.35), 4); // 3 raised armour ribs
    tag(L, box(0.02, 0.9, 1.3, sx * 1.045, 1.1, -0.3), 4, 0.45); // sliding-door groove
    tag(L, box(0.06, 0.12, 0.06, sx * 0.86, 0.9, -2.5), 6); // hinge knuckles
    tag(L, box(0.06, 0.12, 0.06, sx * 0.86, 1.6, -2.5), 6);
    tag(L, box(0.1, 0.1, 0.9, sx * 1.07, 0.74, 1.52, [0, 0, sx * -0.1]), 4); // wheel flares
    tag(L, box(0.1, 0.1, 0.9, sx * 1.07, 0.74, -1.5, [0, 0, sx * -0.1]), 4);
  });
  for (const [z, w] of [[1.52, 0.3], [-1.5, 0.3]] as const) mirror((sx) => wheelAt(L, 0.39, w, sx * (1.04 - w / 2 - 0.02), z, sx));
  return L;
}

/** Merged hero geometry of one variant: `position`, `normal`, `aPart`, `aAo` (instanced by the caller). */
export function buildCarVariant(variant: 0 | 1 | 2): THREE.BufferGeometry {
  const parts = [buildCoupe, buildPickup, buildVan][variant]();
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!merged) throw new Error('CityVehicles: mergeGeometries failed');
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

/** Triangle count of a non-indexed (or indexed) geometry. */
export function triCount(g: THREE.BufferGeometry): number {
  return (g.index ? g.index.count : g.getAttribute('position').count) / 3;
}
