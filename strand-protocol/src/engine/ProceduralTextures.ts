/**
 * STRAND // PROTOCOL — Procedural PBR texture factory (§6.2-2).
 * Everything is generated once at boot with Canvas2D and cached; no external assets.
 *
 *  - Facade atlas (2048 × 1024, 6A-1): four archetype columns — glass curtain wall, cast-concrete
 *    residential, corrugated-metal industrial, commercial tenant — × typical / mechanical / ground floors.
 *    Albedo / Emissive (neutral room light + fixed neon) / packed glass mask · roughness · metalness /
 *    Normal; blinds, curtains, desk silhouettes, rain streaks, rust, panel joints, louvres
 *  - Wet rooftop / sidewalk concrete with cracks & puddles (512²): Albedo / Roughness (puddle 0.06, wet 0.42) / Normal
 *  - Wet road atlas (512²): lanes, centre line, white dashes, crosswalk, manholes, puddles
 *  - Hologram neon sign atlas (1024²): 8 vertical katakana / English-symbol strips
 *  - Sign atlas (1024², 5B-3): 6 wide banners + 2 seamless scrolling LED tickers, 8 emblems / holograms
 *  - Tactical tech PBR set (512², 5B-4): carbon weave, panel grooves, screw heads, edge wear, brushed metal
 *  - Rooftop machinery (256²): AC-unit fan grille Albedo / Roughness / Normal
 *  - 6B-1 view-model sets (512², 4 zones each): glove & wear (leather grain + stitching + knuckle creases,
 *    ballistic nylon, rubber grip, jacket twill) and gun hard-surface (brushed gunmetal with scratches / edge
 *    wear / screws, checkering, polymer stipple, anodised heat slits)
 */
import * as THREE from 'three';
import {
  COLORS,
  FACADE,
  RENDER,
  ROOF_PUDDLE_ROUGHNESS,
  ROOF_WET_ROUGHNESS,
  createRng,
  srgbToLinear,
  clamp,
} from '../config/constants';

export interface PbrTextureSet {
  map: THREE.Texture;
  roughnessMap: THREE.Texture;
  normalMap: THREE.Texture;
  emissiveMap?: THREE.Texture;
}

export interface ProceduralTextureLibrary {
  /** 6A-1 facade atlas (2048 × 1024): roughnessMap packs R glass mask · G roughness · B metalness. */
  facades: Required<PbrTextureSet>;
  roof: PbrTextureSet;
  /** Wet road atlas (lanes / crosswalk / plain asphalt) — see ROAD_ATLAS. */
  roads: PbrTextureSet;
  machinery: PbrTextureSet;
  neonAtlas: THREE.Texture;
  /** Number of strips in the neon atlas (u is split evenly). */
  neonAtlasStrips: number;
  /**
   * 5B-3 sign atlas (1024²): top half = 8 wide banner rows (1024 × 64; rows 6–7 are seamless scrolling
   * tickers), bottom half = 4 × 2 corporate emblems / geometric holograms (256²).
   */
  signAtlas: THREE.Texture;
  /** 5B-4 shared tactical tech PBR set (512²): carbon weave, panel grooves, edge wear, brushed metal. */
  tech: PbrTextureSet;
  /** 6B-1 tactical glove & wear set (512², four zones; roughnessMap packs G roughness · B metalness). */
  glove: PbrTextureSet;
  /** 6B-1 gun micro hard-surface set (512², four zones; roughnessMap packs G roughness · B metalness). */
  gun: PbrTextureSet;
}

/** Rows in the wide-banner half of the sign atlas and emblem cells (4 × 2). */
export const SIGN_ATLAS = { WIDE_ROWS: 8, SCROLL_ROWS: [6, 7] as readonly number[], EMBLEMS: 8 } as const;

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------
function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas2D context unavailable');
  return [c, ctx];
}

function linearToSrgbByte(v: number): number {
  const c = clamp(v, 0, 1);
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

function hexToLinearRgb(hex: number, out: [number, number, number]): [number, number, number] {
  out[0] = srgbToLinear(((hex >> 16) & 255) / 255);
  out[1] = srgbToLinear(((hex >> 8) & 255) / 255);
  out[2] = srgbToLinear((hex & 255) / 255);
  return out;
}

function linLum(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function rgbCss(r: number, g: number, b: number, a = 1): string {
  return `rgba(${r | 0},${g | 0},${b | 0},${a})`;
}

function grayCss(v01: number): string {
  const g = Math.round(clamp(v01, 0, 1) * 255);
  return `rgb(${g},${g},${g})`;
}

/** Tileable lattice value noise with smoothstep interpolation. */
class TileableValueNoise {
  private readonly lattice: Float32Array;
  constructor(private readonly period: number, rng: () => number) {
    this.lattice = new Float32Array(period * period);
    for (let i = 0; i < this.lattice.length; i++) this.lattice[i] = rng();
  }
  /** x, y in lattice units; wraps every `period`. */
  sample(x: number, y: number): number {
    const p = this.period;
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const x0 = ((xi % p) + p) % p;
    const y0 = ((yi % p) + p) % p;
    const x1 = (x0 + 1) % p;
    const y1 = (y0 + 1) % p;
    const l = this.lattice;
    const a = l[y0 * p + x0];
    const b = l[y0 * p + x1];
    const c = l[y1 * p + x0];
    const d = l[y1 * p + x1];
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
}

/** Fractal value noise, tileable over [0,1)² when sampled with u,v in [0,1). */
function fbm(noises: TileableValueNoise[], basePeriod: number, u: number, v: number): number {
  let amp = 0.5;
  let sum = 0;
  let norm = 0;
  let freq = basePeriod;
  for (let o = 0; o < noises.length; o++) {
    sum += noises[o].sample(u * freq, v * freq) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/**
 * Sobel normal-map generation from a height field (wrap-around sampling = tileable).
 * Output: tangent-space normal in RGB (OpenGL convention, +Y up).
 */
function sobelNormalMap(height: Float32Array, w: number, h: number, strength: number): ImageData {
  const out = new ImageData(w, h);
  const d = out.data;
  const hAt = (x: number, y: number): number => height[((y + h) % h) * w + ((x + w) % w)];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const tl = hAt(x - 1, y - 1);
      const t = hAt(x, y - 1);
      const tr = hAt(x + 1, y - 1);
      const l = hAt(x - 1, y);
      const r = hAt(x + 1, y);
      const bl = hAt(x - 1, y + 1);
      const b = hAt(x, y + 1);
      const br = hAt(x + 1, y + 1);
      const dx = tr + 2 * r + br - (tl + 2 * l + bl);
      const dy = bl + 2 * b + br - (tl + 2 * t + tr);
      let nx = -dx * strength;
      let ny = dy * strength; // canvas y is down; flip for +Y-up tangent space
      let nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      nz /= len;
      const i = (y * w + x) * 4;
      d[i] = Math.round((nx * 0.5 + 0.5) * 255);
      d[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      d[i + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      d[i + 3] = 255;
    }
  }
  return out;
}

function readHeight(ctx: CanvasRenderingContext2D, w: number, h: number): Float32Array {
  const src = ctx.getImageData(0, 0, w, h).data;
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = src[i * 4] / 255;
  return out;
}

function finalizeTexture(
  canvas: HTMLCanvasElement,
  colorSpace: THREE.ColorSpace,
  anisotropy: number,
  wrap = true,
): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = colorSpace;
  tex.anisotropy = anisotropy;
  tex.wrapS = wrap ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.wrapT = wrap ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

function normalTextureFromHeight(
  heightCtx: CanvasRenderingContext2D,
  w: number,
  h: number,
  strength: number,
  anisotropy: number,
): THREE.CanvasTexture {
  const heights = readHeight(heightCtx, w, h);
  const [nc, nctx] = makeCanvas(w, h);
  nctx.putImageData(sobelNormalMap(heights, w, h, strength), 0, 0);
  return finalizeTexture(nc, THREE.NoColorSpace, anisotropy);
}

// ---------------------------------------------------------------------------
// 1. Facade atlas (6A-1, 2048 × 1024): 4 archetype columns × 8 floor rows of 4 m
//    Columns (12 m tiles): A glass curtain wall · B cast-concrete residential · C corrugated-metal
//    industrial · D commercial tenant. Rows from the texture bottom: 0 ground floor, 1 dark mechanical
//    floor (full louvres), 2–7 typical floors.
//    Maps: Albedo · Emissive (NEUTRAL grey = room light, tinted per room in the shader; saturated =
//    fixed neon) · packed R clear-glass mask (interior mapping) / G roughness / B metalness · Normal.
// ---------------------------------------------------------------------------
const FIXED_NEON = [0xff2bd6, 0x00f0ff, 0xffa21f, 0xff3b5c, 0x39ff88, 0xb44bff] as const;
const CURTAIN_TONES = ['#5a4c40', '#4a4f55', '#58463f', '#3e4a44', '#625a4c', '#4b4256', '#6a6458'] as const;
const POSTER_TONES = ['#7a2a52', '#1f5a6a', '#7a5a1e', '#3a2a6a', '#6a1f2a', '#2a6a44'] as const;

interface FacadePaint {
  /** Albedo / emissive CSS colours (emissive: neutral grey = room light, saturated = fixed neon). */
  a?: string;
  e?: string;
  /** Clear-glass mask (interior mapping), roughness, metalness, height — all 0…1. */
  m?: number;
  r?: number;
  t?: number;
  h?: number;
}

function generateFacadeAtlas(anisotropy: number): Required<PbrTextureSet> {
  const W = FACADE.TEX_W;
  const HT = FACADE.TEX_H;
  const CW = W / FACADE.COLUMNS;
  const RH = HT / FACADE.ROWS;
  const PX = CW / FACADE.TILE_W_M;
  const PY = RH / FACADE.FLOOR_H_M;
  const TW = FACADE.TILE_W_M;
  const rng = createRng(0xfa5ade);
  const [albC, alb] = makeCanvas(W, HT);
  const [emiC, emi] = makeCanvas(W, HT);
  const [, msk] = makeCanvas(W, HT);
  const [, rgh] = makeCanvas(W, HT);
  const [, mtl] = makeCanvas(W, HT);
  const [, hgt] = makeCanvas(W, HT);
  for (const [ctx, style] of [[alb, '#15191f'], [emi, '#000'], [msk, '#000'], [rgh, grayCss(0.7)], [mtl, '#000'], [hgt, grayCss(0.6)]] as const) {
    ctx.fillStyle = style;
    ctx.fillRect(0, 0, W, HT);
  }

  // Every rectangle is clipped to the current (column, row) cell: nothing bleeds into a neighbour.
  let clipX0 = 0;
  let clipX1 = CW;
  let clipY0 = 0;
  let clipY1 = RH;
  const cell = (c: number, r: number): void => {
    clipX0 = c * CW;
    clipX1 = clipX0 + CW;
    clipY0 = (FACADE.ROWS - 1 - r) * RH;
    clipY1 = clipY0 + RH;
  };
  const P = (x: number, y: number, w: number, h: number, p: FacadePaint): void => {
    const x0 = Math.max(x, clipX0);
    const y0 = Math.max(y, clipY0);
    const x1 = Math.min(x + w, clipX1);
    const y1 = Math.min(y + h, clipY1);
    if (x1 <= x0 || y1 <= y0) return;
    const ww = x1 - x0;
    const hh = y1 - y0;
    if (p.a) {
      alb.fillStyle = p.a;
      alb.fillRect(x0, y0, ww, hh);
    }
    if (p.e) {
      emi.fillStyle = p.e;
      emi.fillRect(x0, y0, ww, hh);
    }
    if (p.m !== undefined) {
      msk.fillStyle = grayCss(p.m);
      msk.fillRect(x0, y0, ww, hh);
    }
    if (p.r !== undefined) {
      rgh.fillStyle = grayCss(p.r);
      rgh.fillRect(x0, y0, ww, hh);
    }
    if (p.t !== undefined) {
      mtl.fillStyle = grayCss(p.t);
      mtl.fillRect(x0, y0, ww, hh);
    }
    if (p.h !== undefined) {
      hgt.fillStyle = grayCss(p.h);
      hgt.fillRect(x0, y0, ww, hh);
    }
  };
  /** Rectangle in metres inside the current cell: x across the 12 m tile, y above the floor of the row. */
  const R = (x0: number, x1: number, y0: number, y1: number, p: FacadePaint): void =>
    P(clipX0 + x0 * PX, clipY1 - y1 * PY, (x1 - x0) * PX, (y1 - y0) * PY, p);
  /** Vertical bar that wraps around the tile edges (seamless horizontal tiling). */
  const vbar = (x: number, w: number, y0: number, y1: number, p: FacadePaint): void => {
    for (const s of [-TW, 0, TW]) R(x - w / 2 + s, x + w / 2 + s, y0, y1, p);
  };
  const lin = (v: number): string => {
    const b = linearToSrgbByte(v);
    return `rgb(${b},${b},${b})`;
  };
  const neonLin = FIXED_NEON.map((hx) => hexToLinearRgb(hx, [0, 0, 0]));
  /** Fixed neon (independent of the room light), linear luminance ≤ 0.62 (× 0.45 on screen). */
  const neon = (i: number, lum: number): string => {
    const c = neonLin[i % neonLin.length];
    const k = Math.min(lum, 0.62) / Math.max(linLum(c[0], c[1], c[2]), 1e-4);
    return rgbCss(linearToSrgbByte(c[0] * k), linearToSrgbByte(c[1] * k), linearToSrgbByte(c[2] * k));
  };
  const DIRT = '0,0,0';
  const RUST = '118,64,32';
  /** Run-off streak hanging from (x, yTop): albedo stain, rougher, less metallic, slightly recessed. */
  const streak = (x: number, yTop: number, len: number, w: number, a: number, rgb = DIRT): void => {
    const gx = clipX0 + x * PX;
    const gy = clipY1 - yTop * PY;
    const x0 = Math.max(gx, clipX0);
    const x1 = Math.min(gx + Math.max(1, w * PX), clipX1);
    const y0 = Math.max(gy, clipY0);
    const y1 = Math.min(gy + len * PY, clipY1);
    if (x1 <= x0 || y1 <= y0) return;
    const g = alb.createLinearGradient(0, gy, 0, gy + len * PY);
    g.addColorStop(0, `rgba(${rgb},${a})`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    alb.fillStyle = g;
    alb.fillRect(x0, y0, x1 - x0, y1 - y0);
    rgh.fillStyle = `rgba(255,255,255,${a * 0.5})`;
    rgh.fillRect(x0, y0, x1 - x0, (y1 - y0) * 0.6);
    if (rgb === RUST) {
      mtl.fillStyle = `rgba(0,0,0,${a})`;
      mtl.fillRect(x0, y0, x1 - x0, (y1 - y0) * 0.7);
    }
    hgt.fillStyle = `rgba(0,0,0,${a * 0.25})`;
    hgt.fillRect(x0, y0, x1 - x0, y1 - y0);
  };

  /** Neutral lit-room pattern behind a pane (0 office · 1 home · 2 workshop · 3 lobby / shop). */
  const glow = (x0: number, x1: number, y0: number, y1: number, kind: number): void => {
    const gy = clipY1 - y1 * PY;
    const gh = (y1 - y0) * PY;
    const g = emi.createLinearGradient(0, gy, 0, gy + gh);
    g.addColorStop(0, lin(1.0));
    g.addColorStop(0.1, lin(0.84));
    g.addColorStop(0.62, lin(0.64));
    g.addColorStop(1, lin(0.36));
    emi.fillStyle = g;
    const gx0 = Math.max(clipX0 + x0 * PX, clipX0);
    const gx1 = Math.min(clipX0 + x1 * PX, clipX1);
    const gy0 = Math.max(gy, clipY0);
    emi.fillRect(gx0, gy0, gx1 - gx0, Math.min(gy + gh, clipY1) - gy0);
    const sil = (a: number, xa: number, xb: number, ya: number, yb: number): void =>
      R(Math.max(x0, xa), Math.min(x1, xb), Math.max(y0, ya), Math.min(y1, yb), { e: `rgba(0,0,0,${a})` });
    const w = x1 - x0;
    if (kind === 0) {
      for (let k = 0; k < 2; k++) {
        const xa = x0 + rng() * w * 0.6;
        sil(0.55, xa, xa + w * (0.25 + rng() * 0.3), 0.7, 1.15);
      }
      if (rng() < 0.3) {
        const xa = x0 + rng() * w;
        sil(0.62, xa, xa + 0.12, y0, 2.3);
      }
      if (rng() < 0.25) {
        const xa = x0 + rng() * w;
        sil(0.4, xa, xa + 0.35, y0, 1.7 + rng() * 0.2);
      }
    } else if (kind === 1) {
      sil(0.5, x0, x0 + w * (0.3 + rng() * 0.5), y0, 0.85);
      if (rng() < 0.4) {
        const xa = x0 + rng() * w * 0.8;
        sil(0.55, xa, xa + 0.25, y0, 1.35);
      }
      if (rng() < 0.35) {
        const xa = x0 + rng() * Math.max(0, w - 0.3);
        R(xa, xa + 0.3, 1.3, 1.6, { e: lin(1.0) });
      }
    } else if (kind === 2) {
      for (let x = x0 + rng() * 0.3; x < x1; x += 0.45 + rng() * 0.3) sil(0.45, x, x + 0.05, y0, y1);
      sil(0.35, x0, x1, y0, y0 + (y1 - y0) * 0.35);
    } else {
      sil(0.5, x0, x1, y0, Math.min(y1, y0 + 0.9));
    }
  };
  /** Venetian blinds lowered from yTop to yBot (opaque at the glass plane, light leaking through). */
  const blinds = (x0: number, x1: number, yTop: number, yBot: number): void => {
    R(x0, x1, yBot, yTop, { a: '#3b4048', m: 0, r: 0.62, t: 0.15, h: 0.46, e: lin(0.2) });
    for (let y = yBot; y < yTop; y += 0.11) R(x0, x1, y, y + 0.035, { a: 'rgba(0,0,0,0.35)', e: lin(0.36), h: 0.38 });
    // Light falls off toward the bottom edge of the blind.
    R(x0, x1, yBot, yBot + (yTop - yBot) * 0.35, { e: 'rgba(0,0,0,0.25)' });
  };
  /** Curtain (fabric folds, glowing with the room light) or a sheer lace curtain (half see-through). */
  const curtain = (x0: number, x1: number, y0: number, y1: number, sheer: boolean): void => {
    const tone = CURTAIN_TONES[Math.floor(rng() * CURTAIN_TONES.length)];
    R(x0, x1, y0, y1, { a: tone, m: sheer ? 0.45 : 0, r: 0.92, t: 0, h: 0.5, e: lin(sheer ? 0.6 : 0.34) });
    for (let x = x0; x < x1; x += 0.09) R(x, x + 0.04, y0, y1, { a: 'rgba(0,0,0,0.18)', e: 'rgba(0,0,0,0.3)', h: 0.42 });
  };
  /** Horizontal-blade louvre panel. */
  const louvre = (x0: number, x1: number, y0: number, y1: number, blade = '#2a3037', back = '#0a0c10'): void => {
    R(x0, x1, y0, y1, { a: back, m: 0, r: 0.5, t: 0.7, h: 0.35, e: '#000' });
    for (let y = y0 + 0.04; y < y1 - 0.04; y += 0.15) {
      R(x0, x1, y, y + 0.07, { a: blade, r: 0.42, t: 0.8, h: 0.9 });
      R(x0, x1, y - 0.02, y, { a: 'rgba(0,0,0,0.6)', h: 0.2 });
    }
  };

  // ======================= Column A: glass curtain wall (1.5 m bays, 3 m rooms) =======================
  for (let row = 2; row < 8; row++) {
    cell(0, row);
    R(0, TW, 0, 4, { a: '#121821', m: 0, r: 0.3, t: 0.85, h: 0.82 });
    R(0, TW, 0.7, 0.78, { a: '#2a3343', r: 0.28, t: 0.95, h: 1.0 });
    for (let b = 0; b < 8; b++) {
      const x0 = b * 1.5 + 0.05;
      const x1 = x0 + 1.4;
      R(x0, x1, 0.78, 3.6, { a: '#0a0f17', m: 1, r: 0.05, t: 0.92, h: 0.3 });
      glow(x0, x1, 0.78, 3.6, 0);
      const roll = rng();
      if (roll < 0.32) blinds(x0, x1, 3.6, 3.6 - (0.35 + rng() * 2.3));
      else if (roll < 0.4) blinds(x0, x1, 3.6, 0.78);
    }
    R(0, TW, 3.6, 3.66, { a: '#262e3b', r: 0.3, t: 0.95, h: 0.95 });
    for (let b = 0; b <= 8; b++) vbar(b * 1.5, b % 2 === 0 ? 0.12 : 0.07, 0, 4, { a: '#2a3140', m: 0, r: 0.3, t: 0.95, h: 1.0 });
    for (let i = 0; i < 10; i++) streak(rng() * TW, 0.7, 0.25 + rng() * 0.45, 0.03 + rng() * 0.05, 0.1);
  }
  cell(0, 1); // mechanical floor: full louvres, unlit band
  R(0, TW, 0, 4, { a: '#0e131a', m: 0, r: 0.5, t: 0.7, h: 0.45 });
  louvre(0, TW, 0.3, 3.75, '#252c36', '#07090d');
  for (let b = 0; b <= 4; b++) vbar(b * 3, 0.16, 0, 4, { a: '#1f2631', r: 0.35, t: 0.9, h: 1.0 });
  R(0, TW, 0, 0.3, { a: '#121821', h: 0.8 });
  R(0, TW, 3.75, 4, { a: '#121821', h: 0.8 });
  for (let i = 0; i < 3; i++) {
    const x = 0.5 + rng() * 11;
    R(x, x + 0.06, 3.2, 3.26, { e: neon(i === 0 ? 3 : 4, 0.5) });
  }
  cell(0, 0); // lobby: tall glass, entrance doors
  R(0, TW, 0, 4, { a: '#131922', m: 0, r: 0.3, t: 0.85, h: 0.85 });
  for (let b = 0; b < 4; b++) {
    const x0 = b * 3 + 0.08;
    R(x0, x0 + 2.84, 0.12, 3.55, { a: '#0a0f17', m: 1, r: 0.05, t: 0.9, h: 0.3 });
    glow(x0, x0 + 2.84, 0.12, 3.55, 3);
  }
  R(0, TW, 2.55, 2.61, { a: '#2a3140', m: 0, r: 0.3, t: 0.95, h: 0.95 });
  for (const x of [3.9, 4.5, 5.1]) R(x - 0.03, x + 0.03, 0.12, 2.55, { a: '#3a4352', m: 0, r: 0.25, t: 0.95, h: 0.95 });
  for (const x of [4.2, 4.8]) R(x - 0.12, x + 0.12, 1.0, 1.04, { a: '#8a95a6', m: 0, r: 0.2, t: 1, h: 1 });
  for (let b = 0; b <= 4; b++) vbar(b * 3, 0.16, 0, 4, { a: '#2a3140', m: 0, r: 0.3, t: 0.95, h: 1.0 });
  R(0, TW, 3.55, 4, { a: '#1a212c', m: 0, r: 0.35, t: 0.9, h: 0.95 });

  // ======================= Column B: cast-concrete residential (6 m units = living + bedroom) ==========
  const concrete = (): void => {
    R(0, TW, 0, 4, { a: '#4a4c4f', m: 0, r: 0.8, t: 0, h: 0.6, e: '#000' });
    for (let i = 0; i < 90; i++) {
      const x = rng() * TW;
      const y = rng() * 4;
      R(x, x + 0.3 + rng() * 1.6, y, y + 0.2 + rng() * 0.9, { a: rng() < 0.5 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.05)' });
    }
    for (let x = 0.75; x < TW; x += 1.5) R(x - 0.015, x + 0.015, 0, 4, { a: 'rgba(0,0,0,0.25)', h: 0.45 });
    R(0, TW, 2.0, 2.025, { a: 'rgba(0,0,0,0.2)', h: 0.48 });
    for (let x = 0.3; x < TW; x += 0.6) for (let y = 0.45; y < 4; y += 0.9) R(x - 0.025, x + 0.025, y - 0.03, y + 0.03, { a: '#2e3033', h: 0.35 });
  };
  const sash = (x0: number, x1: number, y0: number, y1: number): void => {
    R(x0 - 0.05, x1 + 0.05, y0 - 0.1, y0, { a: '#606366', r: 0.7, h: 1.0 });
    R(x0, x1, y0, y1, { a: '#7b828a', m: 0, r: 0.32, t: 0.9, h: 0.92 });
    const g0 = x0 + 0.05;
    const g1 = x1 - 0.05;
    const gy0 = y0 + 0.05;
    const gy1 = y1 - 0.06;
    R(g0, g1, gy0, gy1, { a: '#0c1219', m: 1, r: 0.07, t: 0.5, h: 0.3 });
    glow(g0, g1, gy0, gy1, 1);
    const mid = (g0 + g1) / 2;
    const roll = rng();
    if (roll < 0.3) curtain(g0, g1, gy0, gy1, false);
    else if (roll < 0.5) {
      const left = rng() < 0.5;
      curtain(left ? g0 : mid, left ? mid : g1, gy0, gy1, false);
    } else if (roll < 0.62) curtain(g0, g1, gy0, gy1, true);
    R(mid - 0.03, mid + 0.03, gy0, gy1, { a: '#7b828a', m: 0, r: 0.32, t: 0.9, h: 0.95 });
    for (let i = 0; i < 3; i++) streak(x0 + rng() * (x1 - x0), y0 - 0.1, 0.3 + rng() * 0.6, 0.03 + rng() * 0.05, 0.16);
  };
  const slab = (): void => {
    R(0, TW, 0, 0.32, { a: '#3f4144', m: 0, r: 0.84, h: 0.78 });
    R(0, TW, 0.32, 0.36, { a: 'rgba(0,0,0,0.35)', h: 0.4 });
  };
  for (let row = 2; row < 8; row++) {
    cell(1, row);
    concrete();
    slab();
    for (let u = 0; u < 2; u++) {
      const ux = u * 6;
      sash(ux + 0.45, ux + 2.55, 0.45, 2.6);
      sash(ux + 3.8, ux + 5.2, 1.0, 2.35);
      const vx = ux + 5.45;
      R(vx, vx + 0.32, 2.05, 2.37, { a: '#3a3d41', r: 0.6, t: 0.4, h: 0.7 });
      for (let y = 2.09; y < 2.35; y += 0.06) R(vx + 0.03, vx + 0.29, y, y + 0.025, { a: '#1c1e21', h: 0.4 });
    }
    for (let i = 0; i < 14; i++) streak(rng() * TW, 0.32, 0.4 + rng() * 1.4, 0.02 + rng() * 0.06, 0.1 + rng() * 0.08);
  }
  cell(1, 1); // mechanical floor: concrete band with louvre vents
  concrete();
  slab();
  for (let k = 0; k < 4; k++) louvre(k * 3 + 0.4, k * 3 + 2.6, 0.9, 2.9, '#3b3f44', '#1f2226');
  cell(1, 0); // ground floor: entrance hall, letterboxes, corner shop
  concrete();
  R(0.3, 2.7, 0, 2.7, { a: '#6d747c', m: 0, r: 0.32, t: 0.9, h: 0.92 });
  R(0.38, 2.62, 0.05, 2.62, { a: '#0b1118', m: 1, r: 0.05, t: 0.6, h: 0.3 });
  glow(0.38, 2.62, 0.05, 2.62, 3);
  R(1.47, 1.53, 0.05, 2.62, { a: '#6d747c', m: 0, r: 0.32, t: 0.9, h: 0.95 });
  R(3.4, 5.6, 0.6, 2.2, { a: '#5f666e', r: 0.38, t: 0.85, h: 0.8 });
  for (let x = 3.4; x <= 5.61; x += 0.44) R(x - 0.01, x + 0.01, 0.6, 2.2, { a: '#30353a', h: 0.5 });
  for (let y = 0.6; y <= 2.21; y += 0.32) R(3.4, 5.6, y - 0.01, y + 0.01, { a: '#30353a', h: 0.5 });
  R(6.2, 11.8, 0, 2.9, { a: '#6d747c', m: 0, r: 0.32, t: 0.9, h: 0.92 });
  R(6.3, 11.7, 0.05, 2.8, { a: '#0b1118', m: 1, r: 0.05, t: 0.6, h: 0.3 });
  glow(6.3, 11.7, 0.05, 2.8, 3);
  {
    const ni = Math.floor(rng() * FIXED_NEON.length);
    R(6.2, 11.8, 2.95, 3.5, { a: '#15181d', m: 0, r: 0.4, t: 0.5, h: 0.9, e: neon(ni, 0.3) });
    for (let x = 6.6; x < 11.4; x += 0.55) R(x, x + 0.35, 3.05, 3.4, { e: neon(ni, 0.62) });
  }

  // ======================= Column C: corrugated-metal industrial (6 m bays, ribbon windows) ============
  const corrugated = (y0: number, y1: number): void => {
    for (let px = 0; px < TW; px += 1.0) {
      const v = 52 + Math.floor(rng() * 16);
      R(px, px + 1.0, y0, y1, { a: `rgb(${v - 4},${v + 4},${v + 8})`, m: 0, r: 0.46 + rng() * 0.14, t: 0.62, h: 0.6, e: '#000' });
    }
    const rib = TW / 72;
    for (let x = 0; x < TW - 1e-6; x += rib) {
      R(x, x + rib * 0.36, y0, y1, { a: 'rgba(255,255,255,0.06)', h: 0.85 });
      R(x + rib * 0.54, x + rib * 0.78, y0, y1, { a: 'rgba(0,0,0,0.16)', h: 0.32 });
    }
  };
  const grime = (y0: number, y1: number, n: number): void => {
    for (let i = 0; i < n; i++) {
      const x = rng() * TW;
      R(x, x + 0.2 + rng() * 0.8, y0 + rng() * (y1 - y0) * 0.8, y1, { a: 'rgba(0,0,0,0.1)' });
    }
  };
  for (let row = 2; row < 8; row++) {
    cell(2, row);
    corrugated(0.6, 4);
    R(0, TW, 0, 0.6, { a: '#44433e', m: 0, r: 0.88, t: 0, h: 0.72 });
    grime(0, 0.6, 26);
    for (let k = 0; k < 2; k++) {
      const x0 = k * 6 + 0.5;
      R(x0 - 0.06, x0 + 5.06, 1.34, 2.76, { a: '#2a2f33', m: 0, r: 0.45, t: 0.8, h: 0.95 });
      for (let p = 0; p < 5; p++) {
        const g0 = x0 + p + 0.04;
        const g1 = g0 + 0.92;
        if (rng() < 0.16) {
          R(g0, g1, 1.4, 2.7, { a: '#2b3131', m: 0, r: 0.75, t: 0.2, h: 0.45 });
          continue;
        }
        R(g0, g1, 1.4, 2.7, { a: '#132019', m: 0.85, r: 0.14, t: 0.35, h: 0.3 });
        glow(g0, g1, 1.4, 2.7, 2);
        for (let x = g0 + 0.12; x < g1; x += 0.12) R(x, x + 0.012, 1.4, 2.7, { a: 'rgba(170,180,170,0.22)', m: 0.6 });
        for (let y = 1.52; y < 2.7; y += 0.12) R(g0, g1, y, y + 0.012, { a: 'rgba(170,180,170,0.22)', m: 0.6 });
      }
      for (let i = 0; i < 4; i++) streak(x0 + rng() * 5, 1.34, 0.6 + rng() * 1.2, 0.04 + rng() * 0.05, 0.24, RUST);
    }
    if (rng() < 0.6) {
      const x = rng() < 0.5 ? 5.55 : 11.55;
      louvre(x, x + 0.4, 3.0, 3.5, '#3a4146', '#111417');
    }
    for (let i = 0; i < 6; i++) streak(rng() * TW, 4.0, 0.8 + rng() * 2, 0.03, 0.18, RUST);
  }
  cell(2, 1); // mechanical floor: big louvres in the cladding
  corrugated(0, 4);
  for (const x0 of [0.8, 6.8]) louvre(x0, x0 + 4.4, 0.6, 3.4, '#3a4146', '#0c0e11');
  for (let i = 0; i < 8; i++) streak(rng() * TW, 3.9, 1 + rng() * 2, 0.04, 0.2, RUST);
  cell(2, 0); // ground floor: roll-up shutters, loading dock edge, personnel door + caged amber lamp
  R(0, TW, 0, 4, { a: '#45443f', m: 0, r: 0.86, t: 0, h: 0.7, e: '#000' });
  grime(0, 4, 60);
  for (const x0 of [0.7, 6.9]) {
    R(x0 - 0.12, x0 + 4.52, 0, 3.55, { a: '#2a2f34', r: 0.45, t: 0.8, h: 0.95 });
    R(x0, x0 + 4.4, 0, 3.4, { a: '#3b4248', r: 0.5, t: 0.72, h: 0.6 });
    for (let y = 0.05; y < 3.4; y += 0.11) {
      R(x0, x0 + 4.4, y, y + 0.05, { a: 'rgba(255,255,255,0.05)', h: 0.85 });
      R(x0, x0 + 4.4, y + 0.06, y + 0.08, { a: 'rgba(0,0,0,0.3)', h: 0.3 });
    }
    R(x0, x0 + 4.4, 3.4, 3.55, { a: '#23282d', h: 0.95 });
    for (let x = x0; x < x0 + 4.4; x += 0.3) R(x, x + 0.15, 0, 0.18, { a: '#b8931e', r: 0.6, t: 0.1 });
    for (let i = 0; i < 5; i++) streak(x0 + rng() * 4.4, 3.4, 0.8 + rng() * 2, 0.05, 0.22, RUST);
  }
  R(5.35, 6.25, 0, 2.15, { a: '#2f363d', r: 0.4, t: 0.85, h: 0.85 });
  R(5.68, 5.92, 2.32, 2.52, { a: '#1a1d20', e: neon(2, 0.62) });
  R(5.64, 5.96, 2.3, 2.32, { a: '#2a2f34', h: 1 });

  // ======================= Column D: commercial tenants (3 m rooms, neon frames, posters) ==============
  for (let row = 2; row < 8; row++) {
    cell(3, row);
    R(0, TW, 0, 4, { a: '#1b1f27', m: 0, r: 0.42, t: 0.55, h: 0.75, e: '#000' });
    for (let x = 0; x < TW; x += 1.5) R(x, x + 0.02, 0, 4, { a: 'rgba(0,0,0,0.35)', h: 0.5 });
    R(0, TW, 0, 0.45, { a: '#151820', r: 0.38, t: 0.6, h: 0.82 });
    if (rng() < 0.3) {
      const ni = Math.floor(rng() * FIXED_NEON.length);
      for (let x = 0.3; x < TW - 0.4; x += 0.42 + rng() * 0.3) R(x, x + 0.22, 0.12, 0.34, { e: neon(ni, 0.55) });
    }
    for (let k = 0; k < 4; k++) {
      const x0 = k * 3 + 0.25;
      const x1 = x0 + 2.5;
      R(x0 - 0.05, x1 + 0.05, 0.5, 3.5, { a: '#2a303b', r: 0.3, t: 0.9, h: 0.95 });
      R(x0, x1, 0.55, 3.45, { a: '#0b1017', m: 1, r: 0.05, t: 0.85, h: 0.3 });
      glow(x0, x1, 0.55, 3.45, 3);
      const roll = rng();
      if (roll < 0.3) {
        const c = neon(Math.floor(rng() * FIXED_NEON.length), 0.62);
        R(x0, x1, 3.38, 3.45, { e: c });
        R(x0, x1, 0.55, 0.62, { e: c });
        R(x0, x0 + 0.06, 0.55, 3.45, { e: c });
        R(x1 - 0.06, x1, 0.55, 3.45, { e: c });
      } else if (roll < 0.48) {
        R(x0 + 0.2, x1 - 0.2, 1.2, 3.0, { a: POSTER_TONES[Math.floor(rng() * POSTER_TONES.length)], m: 0, r: 0.5, t: 0, e: lin(0.55) });
        for (let y = 1.4; y < 2.9; y += 0.3) R(x0 + 0.35, x1 - 0.35 - rng() * 0.8, y, y + 0.12, { a: 'rgba(0,0,0,0.4)', e: 'rgba(0,0,0,0.45)' });
      } else if (roll < 0.6) blinds(x0, x1, 3.45, 0.55);
    }
    if (rng() < 0.4) {
      const x = (1 + Math.floor(rng() * 3)) * 3;
      const ni = Math.floor(rng() * FIXED_NEON.length);
      R(x - 0.14, x + 0.14, 0.6, 3.4, { a: '#10141b', m: 0, r: 0.4, t: 0.5, h: 0.95, e: '#000' });
      for (let y = 0.75; y < 3.2; y += 0.34) R(x - 0.08, x + 0.08, y, y + 0.22, { e: neon(ni, 0.62) });
    }
  }
  cell(3, 1); // mechanical / billboard band
  R(0, TW, 0, 4, { a: '#101318', m: 0, r: 0.5, t: 0.6, h: 0.5, e: '#000' });
  louvre(0, TW, 0.35, 2.7, '#262b33', '#08090c');
  R(0, TW, 3.1, 3.2, { a: '#0d0f13', e: neon(1, 0.55) });
  R(0, TW, 3.2, 4, { a: '#181c23', r: 0.4, t: 0.6, h: 0.85 });
  R(0, TW, 2.7, 3.1, { a: '#14171d', r: 0.45, t: 0.5, h: 0.8 });
  cell(3, 0); // shop interiors behind a recessed shopfront: interior-mapped in the shader, 2D on LOW
  for (let k = 0; k < 4; k++) {
    const x0 = k * 3;
    const kind = Math.floor(rng() * 3);
    const ni = Math.floor(rng() * FIXED_NEON.length);
    R(x0, x0 + 3, 0, 3.3, { a: '#0b1017', m: 1, r: 0.06, t: 0.6, h: 0.3 });
    glow(x0 + 0.05, x0 + 2.95, 0, 3.3, 3);
    // LOW-quality hints only (dimmed): shelves / counter / lanterns.
    if (kind === 0) for (const y of [0.5, 1.05, 1.6, 2.15]) R(x0 + 0.2, x0 + 2.8, y, y + 0.05, { e: 'rgba(0,0,0,0.45)' });
    else if (kind === 1) R(x0, x0 + 3, 0, 1.0, { e: 'rgba(0,0,0,0.6)' });
    else for (let x = x0 + 0.4; x < x0 + 2.6; x += 0.6) R(x, x + 0.26, 2.5, 2.95, { e: neon(3, 0.32) });
    // Shop sign band inside the glass + thin dividers between tenants (opaque).
    R(x0, x0 + 3, 3.3, 4, { a: '#0f1217', m: 0, r: 0.4, t: 0.5, h: 0.85, e: '#000' });
    R(x0 + 0.4, x0 + 2.6, 3.4, 3.85, { e: neon(ni, 0.36) });
    for (let x = x0 + 0.55; x < x0 + 2.45; x += 0.3) R(x, x + 0.18, 3.48, 3.77, { e: neon(ni, 0.62) });
  }
  for (let k = 0; k <= 4; k++) vbar(k * 3, 0.1, 0, 4, { a: '#20252e', m: 0, r: 0.35, t: 0.8, h: 0.95, e: '#000' });

  // Pack the mask / roughness / metalness layers into one RGB texture.
  const mD = msk.getImageData(0, 0, W, HT).data;
  const rD = rgh.getImageData(0, 0, W, HT).data;
  const tD = mtl.getImageData(0, 0, W, HT).data;
  const [packC, pack] = makeCanvas(W, HT);
  const img = pack.createImageData(W, HT);
  const o = img.data;
  for (let i = 0; i < o.length; i += 4) {
    o[i] = mD[i];
    o[i + 1] = rD[i];
    o[i + 2] = tD[i];
    o[i + 3] = 255;
  }
  pack.putImageData(img, 0, 0);
  return {
    map: finalizeTexture(albC, THREE.SRGBColorSpace, anisotropy),
    emissiveMap: finalizeTexture(emiC, THREE.SRGBColorSpace, anisotropy),
    roughnessMap: finalizeTexture(packC, THREE.NoColorSpace, anisotropy),
    normalMap: normalTextureFromHeight(hgt, W, HT, 2.6, anisotropy),
  };
}

// ---------------------------------------------------------------------------
// 2. Wet rooftop concrete + puddle mask (512²)
// ---------------------------------------------------------------------------
function generateRoofSet(anisotropy: number): PbrTextureSet {
  const S = RENDER.ROOF_TEX_SIZE;
  const rng = createRng(0x900f);
  const octaves = 5;
  const grain: TileableValueNoise[] = [];
  const puddleN: TileableValueNoise[] = [];
  for (let i = 0; i < octaves; i++) {
    grain.push(new TileableValueNoise(256, rng));
    puddleN.push(new TileableValueNoise(256, rng));
  }

  const [albC, alb] = makeCanvas(S, S);
  const [rghC, rgh] = makeCanvas(S, S);
  const [, hgt] = makeCanvas(S, S);

  const albData = alb.createImageData(S, S);
  const rghData = rgh.createImageData(S, S);
  const hgtData = hgt.createImageData(S, S);
  const baseLin: [number, number, number] = [0, 0, 0];
  hexToLinearRgb(COLORS.ROOF_WET, baseLin);
  const puddleMask = new Float32Array(S * S);

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const v = y / S;
      const g = fbm(grain, 32, u, v);
      const speck = grain[4].sample(u * 256, v * 256);
      const p = fbm(puddleN, 3, u, v);
      // Puddle mask: smooth threshold on low-frequency noise.
      const m = clamp((p - 0.53) / 0.06, 0, 1);
      const pm = m * m * (3 - 2 * m);
      puddleMask[y * S + x] = pm;

      // Albedo: dark wet asphalt/concrete with aggregate speckle; water darker & bluer.
      const shade = 0.75 + g * 0.5 + (speck - 0.5) * 0.25;
      let r = baseLin[0] * shade;
      let gg = baseLin[1] * shade;
      let b = baseLin[2] * shade;
      r = r * (1 - pm) + baseLin[0] * 0.45 * pm;
      gg = gg * (1 - pm) + baseLin[1] * 0.5 * pm;
      b = b * (1 - pm) + baseLin[2] * 0.62 * pm;
      const i = (y * S + x) * 4;
      albData.data[i] = linearToSrgbByte(r);
      albData.data[i + 1] = linearToSrgbByte(gg);
      albData.data[i + 2] = linearToSrgbByte(b);
      albData.data[i + 3] = 255;

      // Roughness: puddle mirror 0.06, wet surface 0.42 (smooth shoreline transition).
      const rough = ROOF_WET_ROUGHNESS * (1 - pm) + ROOF_PUDDLE_ROUGHNESS * pm;
      const rv = Math.round(rough * 255);
      rghData.data[i] = rv;
      rghData.data[i + 1] = rv;
      rghData.data[i + 2] = rv;
      rghData.data[i + 3] = 255;

      // Height: grain everywhere, water surface perfectly flat.
      const hv = (0.55 + (g - 0.5) * 0.35 + (speck - 0.5) * 0.12) * (1 - pm) + 0.42 * pm;
      const hb = Math.round(clamp(hv, 0, 1) * 255);
      hgtData.data[i] = hb;
      hgtData.data[i + 1] = hb;
      hgtData.data[i + 2] = hb;
      hgtData.data[i + 3] = 255;
    }
  }
  alb.putImageData(albData, 0, 0);
  rgh.putImageData(rghData, 0, 0);
  hgt.putImageData(hgtData, 0, 0);

  // Slab expansion joints (tile-aligned so seams stay continuous).
  const joints = 2;
  for (let j = 0; j <= joints; j++) {
    const pos = (j / joints) * S;
    for (const ctx of [alb, hgt]) {
      ctx.fillStyle = ctx === alb ? 'rgba(4,6,10,0.85)' : grayCss(0.15);
      ctx.fillRect(pos - 1.5, 0, 3, S);
      ctx.fillRect(0, pos - 1.5, S, 3);
    }
  }

  // Cracks: wrapped random walks (drawn at 9 offsets so they tile seamlessly).
  const drawCrack = (sx: number, sy: number, steps: number, ang: number): void => {
    let x = sx;
    let y = sy;
    let a = ang;
    const pts: number[] = [x, y];
    for (let s = 0; s < steps; s++) {
      a += (rng() - 0.5) * 0.9;
      x += Math.cos(a) * 5;
      y += Math.sin(a) * 5;
      pts.push(x, y);
    }
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        for (const ctx of [alb, hgt, rgh]) {
          ctx.beginPath();
          ctx.moveTo(pts[0] + ox * S, pts[1] + oy * S);
          for (let k = 2; k < pts.length; k += 2) ctx.lineTo(pts[k] + ox * S, pts[k + 1] + oy * S);
          if (ctx === alb) {
            ctx.strokeStyle = 'rgba(2,3,6,0.9)';
            ctx.lineWidth = 1.4;
          } else if (ctx === hgt) {
            ctx.strokeStyle = grayCss(0.08);
            ctx.lineWidth = 1.8;
          } else {
            ctx.strokeStyle = grayCss(0.55);
            ctx.lineWidth = 1.2;
          }
          ctx.stroke();
        }
      }
    }
  };
  for (let c = 0; c < 22; c++) drawCrack(rng() * S, rng() * S, 14 + Math.floor(rng() * 30), rng() * Math.PI * 2);

  // Re-flatten puddles over cracks (water fills them): restore puddle roughness & flat height.
  const rghAfter = rgh.getImageData(0, 0, S, S);
  const hgtAfter = hgt.getImageData(0, 0, S, S);
  for (let i = 0; i < S * S; i++) {
    const pm = puddleMask[i];
    if (pm <= 0) continue;
    const j = i * 4;
    const rr = rghAfter.data[j] / 255;
    const rough = rr * (1 - pm) + ROOF_PUDDLE_ROUGHNESS * pm;
    const rv = Math.round(rough * 255);
    rghAfter.data[j] = rghAfter.data[j + 1] = rghAfter.data[j + 2] = rv;
    const hh = hgtAfter.data[j] / 255;
    const hv = Math.round((hh * (1 - pm) + 0.42 * pm) * 255);
    hgtAfter.data[j] = hgtAfter.data[j + 1] = hgtAfter.data[j + 2] = hv;
  }
  rgh.putImageData(rghAfter, 0, 0);
  hgt.putImageData(hgtAfter, 0, 0);

  return {
    map: finalizeTexture(albC, THREE.SRGBColorSpace, anisotropy),
    roughnessMap: finalizeTexture(rghC, THREE.NoColorSpace, anisotropy),
    normalMap: normalTextureFromHeight(hgt, S, S, 1.1, anisotropy),
  };
}

// ---------------------------------------------------------------------------
// 2b. Wet road atlas (512²): Albedo / Roughness (puddle 0.06, wet 0.42) / Normal
//     Four independently tileable regions, sampled via per-vertex atlas rects (textureGrad + fract):
//       LANES4    u 0.00–0.50, v 0–1   : 4-lane avenue / expressway strip (14 m × 28 m tile)
//       LANES2    u 0.50–0.75, v 0–0.5 : 2-lane street strip (10 m × 20 m tile)
//       CROSSWALK u 0.50–0.75, v 0.5–1 : zebra crossing (2 m across × 4 m deep tile)
//       ASPHALT   u 0.75–1.00, v 0–1   : unmarked asphalt for intersections / plazas (6 m × 24 m tile)
// ---------------------------------------------------------------------------
export interface AtlasRegion {
  /** UV rect inside the atlas texture. */
  readonly u0: number;
  readonly v0: number;
  readonly u1: number;
  readonly v1: number;
  /** World size of one tile of this region (m): across the road / along the road. */
  readonly tileAcross: number;
  readonly tileAlong: number;
}

export const ROAD_ATLAS = {
  LANES4: { u0: 0.0, v0: 0.0, u1: 0.5, v1: 1.0, tileAcross: 14, tileAlong: 28 },
  LANES2: { u0: 0.5, v0: 0.0, u1: 0.75, v1: 0.5, tileAcross: 10, tileAlong: 20 },
  CROSSWALK: { u0: 0.5, v0: 0.5, u1: 0.75, v1: 1.0, tileAcross: 2, tileAlong: 4 },
  ASPHALT: { u0: 0.75, v0: 0.0, u1: 1.0, v1: 1.0, tileAcross: 6, tileAlong: 24 },
} as const satisfies Record<string, AtlasRegion>;

function generateRoadAtlas(anisotropy: number): PbrTextureSet {
  const S = RENDER.ROAD_TEX_SIZE;
  const rng = createRng(0x40ad);
  const [albC, alb] = makeCanvas(S, S);
  const [rghC, rgh] = makeCanvas(S, S);
  const [, hgt] = makeCanvas(S, S);
  const albD = alb.createImageData(S, S);
  const rghD = rgh.createImageData(S, S);
  const hgtD = hgt.createImageData(S, S);
  const puddle = new Float32Array(S * S);
  const baseLin: [number, number, number] = [0, 0, 0];
  hexToLinearRgb(COLORS.ROOF_WET, baseLin);

  /** Canvas-space pixel rect of a region (canvas y grows downward; uv v grows upward). */
  const px = (r: AtlasRegion): { x0: number; y0: number; w: number; h: number } => ({
    x0: Math.round(r.u0 * S),
    y0: Math.round((1 - r.v1) * S),
    w: Math.round((r.u1 - r.u0) * S),
    h: Math.round((r.v1 - r.v0) * S),
  });

  // --- Asphalt base + puddles, tileable inside each region ---
  const regions: AtlasRegion[] = [ROAD_ATLAS.LANES4, ROAD_ATLAS.LANES2, ROAD_ATLAS.CROSSWALK, ROAD_ATLAS.ASPHALT];
  for (const r of regions) {
    const { x0, y0, w, h } = px(r);
    const grain: TileableValueNoise[] = [];
    const pud: TileableValueNoise[] = [];
    for (let i = 0; i < 5; i++) {
      grain.push(new TileableValueNoise(128, rng));
      pud.push(new TileableValueNoise(128, rng));
    }
    // Puddle period scales with the tile's world size so puddles keep a ~3–6 m scale.
    const pudPeriod = Math.max(1, Math.round(Math.max(r.tileAcross, r.tileAlong) / 7));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const u = x / w;
        const v = y / h;
        const g = fbm(grain, 8, u, v);
        const speck = grain[4].sample(u * 128, v * 128);
        const p = fbm(pud, pudPeriod, u, v);
        const m = clamp((p - 0.55) / 0.06, 0, 1);
        const pm = m * m * (3 - 2 * m);
        const gi = (y0 + y) * S + (x0 + x);
        puddle[gi] = pm;
        const shade = 0.72 + g * 0.5 + (speck - 0.5) * 0.3;
        const rr = baseLin[0] * shade;
        const gg = baseLin[1] * shade;
        const bb = baseLin[2] * shade;
        const i = gi * 4;
        albD.data[i] = linearToSrgbByte(rr);
        albD.data[i + 1] = linearToSrgbByte(gg);
        albD.data[i + 2] = linearToSrgbByte(bb);
        albD.data[i + 3] = 255;
        const rv = Math.round(ROOF_WET_ROUGHNESS * 255);
        rghD.data[i] = rghD.data[i + 1] = rghD.data[i + 2] = rv;
        rghD.data[i + 3] = 255;
        const hv = Math.round(clamp(0.55 + (g - 0.5) * 0.3 + (speck - 0.5) * 0.15, 0, 1) * 255);
        hgtD.data[i] = hgtD.data[i + 1] = hgtD.data[i + 2] = hv;
        hgtD.data[i + 3] = 255;
      }
    }
  }
  alb.putImageData(albD, 0, 0);
  rgh.putImageData(rghD, 0, 0);
  hgt.putImageData(hgtD, 0, 0);

  // --- Paint helpers (wet road paint: dull, slightly raised, roughness 0.3) ---
  const WHITE = '#bfc5cc';
  const AMBER = '#c79a3c';
  const paint = (x: number, y: number, w: number, h: number, color: string): void => {
    alb.fillStyle = color;
    alb.fillRect(x, y, w, h);
    rgh.fillStyle = grayCss(0.3);
    rgh.fillRect(x, y, w, h);
    hgt.fillStyle = grayCss(0.72);
    hgt.fillRect(x, y, w, h);
  };
  const manhole = (cx: number, cy: number, rad: number): void => {
    alb.fillStyle = '#15181d';
    alb.beginPath();
    alb.arc(cx, cy, rad, 0, Math.PI * 2);
    alb.fill();
    rgh.fillStyle = grayCss(0.28);
    rgh.beginPath();
    rgh.arc(cx, cy, rad, 0, Math.PI * 2);
    rgh.fill();
    hgt.fillStyle = grayCss(0.5);
    hgt.beginPath();
    hgt.arc(cx, cy, rad, 0, Math.PI * 2);
    hgt.fill();
    hgt.strokeStyle = grayCss(0.2);
    hgt.lineWidth = 2;
    for (let r = rad * 0.3; r < rad; r += rad * 0.22) {
      hgt.beginPath();
      hgt.arc(cx, cy, r, 0, Math.PI * 2);
      hgt.stroke();
    }
    hgt.beginPath();
    hgt.moveTo(cx - rad, cy);
    hgt.lineTo(cx + rad, cy);
    hgt.moveTo(cx, cy - rad);
    hgt.lineTo(cx, cy + rad);
    hgt.stroke();
    hgt.strokeStyle = grayCss(0.85);
    hgt.lineWidth = 2;
    hgt.beginPath();
    hgt.arc(cx, cy, rad, 0, Math.PI * 2);
    hgt.stroke();
  };

  // LANES4: 14 m across (256 px → 18.3 px/m), 28 m along (512 px). Lanes at 0–3.5–7–10.5–14 m.
  {
    const { x0, y0, w, h } = px(ROAD_ATLAS.LANES4);
    const ppm = w / 14;
    const line = Math.max(2, Math.round(0.15 * ppm));
    paint(x0 + Math.round(0.3 * ppm), y0, line, h, WHITE); // edge lines
    paint(x0 + w - Math.round(0.3 * ppm) - line, y0, line, h, WHITE);
    paint(x0 + Math.round((7 - 0.22) * ppm) - line / 2, y0, line, h, AMBER); // double centre line
    paint(x0 + Math.round((7 + 0.22) * ppm) - line / 2, y0, line, h, AMBER);
    const dashPeriod = h / 4; // 7 m
    for (const lane of [3.5, 10.5]) {
      for (let k = 0; k < 4; k++) paint(x0 + Math.round(lane * ppm) - line / 2, y0 + k * dashPeriod, line, dashPeriod * (3 / 7), WHITE);
    }
    manhole(x0 + Math.round(5.2 * ppm), y0 + h * 0.62, 0.55 * ppm);
    manhole(x0 + Math.round(12.1 * ppm), y0 + h * 0.18, 0.5 * ppm);
  }
  // LANES2: 10 m across (128 px), 20 m along (256 px). Centre dashed line, edge lines.
  {
    const { x0, y0, w, h } = px(ROAD_ATLAS.LANES2);
    const ppm = w / 10;
    const line = Math.max(2, Math.round(0.15 * ppm));
    paint(x0 + Math.round(0.3 * ppm), y0, line, h, WHITE);
    paint(x0 + w - Math.round(0.3 * ppm) - line, y0, line, h, WHITE);
    const dashPeriod = h / 4; // 5 m
    for (let k = 0; k < 4; k++) paint(x0 + Math.round(5 * ppm) - line / 2, y0 + k * dashPeriod, line, dashPeriod * 0.6, WHITE);
    manhole(x0 + Math.round(2.6 * ppm), y0 + h * 0.4, 0.5 * ppm);
  }
  // CROSSWALK: 2 m across (128 px), 4 m along (256 px): two 0.5 m bars per tile, parallel to traffic.
  {
    const { x0, y0, w, h } = px(ROAD_ATLAS.CROSSWALK);
    const ppm = w / 2;
    for (const off of [0.25, 1.25]) {
      paint(x0 + Math.round(off * ppm), y0 + 2, Math.round(0.5 * ppm), h - 4, WHITE);
      // Tyre-worn patches in the paint.
      for (let k = 0; k < 6; k++) {
        alb.fillStyle = `rgba(30,34,40,${0.25 + rng() * 0.35})`;
        alb.fillRect(x0 + Math.round(off * ppm) + rng() * 0.4 * ppm, y0 + rng() * h, 4 + rng() * 10, 6 + rng() * 20);
      }
    }
  }
  // ASPHALT: patch repairs, oil stains, one manhole.
  {
    const { x0, y0, w, h } = px(ROAD_ATLAS.ASPHALT);
    for (let k = 0; k < 5; k++) {
      const pw = 14 + rng() * 40;
      const ph = 14 + rng() * 60;
      const xx = x0 + rng() * (w - pw);
      const yy = y0 + rng() * (h - ph);
      alb.fillStyle = 'rgba(8,10,14,0.35)';
      alb.fillRect(xx, yy, pw, ph);
      hgt.strokeStyle = grayCss(0.35);
      hgt.lineWidth = 2;
      hgt.strokeRect(xx, yy, pw, ph);
    }
    for (let k = 0; k < 8; k++) {
      const g = alb.createRadialGradient(0, 0, 0, 0, 0, 1);
      g.addColorStop(0, 'rgba(10,8,18,0.55)');
      g.addColorStop(1, 'rgba(10,8,18,0)');
      alb.save();
      alb.translate(x0 + 8 + rng() * (w - 16), y0 + 8 + rng() * (h - 16));
      alb.scale(6 + rng() * 10, 10 + rng() * 18);
      alb.fillStyle = g;
      alb.beginPath();
      alb.arc(0, 0, 1, 0, Math.PI * 2);
      alb.fill();
      alb.restore();
    }
    manhole(x0 + w * 0.5, y0 + h * 0.3, 0.55 * (w / 6));
  }

  // --- Water over paint: re-apply puddles (darker albedo, mirror roughness, flat height) ---
  const a2 = alb.getImageData(0, 0, S, S);
  const r2 = rgh.getImageData(0, 0, S, S);
  const h2 = hgt.getImageData(0, 0, S, S);
  for (let i = 0; i < S * S; i++) {
    const pm = puddle[i];
    if (pm <= 0) continue;
    const j = i * 4;
    a2.data[j] = Math.round(a2.data[j] * (1 - pm * 0.45));
    a2.data[j + 1] = Math.round(a2.data[j + 1] * (1 - pm * 0.4));
    a2.data[j + 2] = Math.round(a2.data[j + 2] * (1 - pm * 0.3));
    const rv = Math.round(((r2.data[j] / 255) * (1 - pm) + ROOF_PUDDLE_ROUGHNESS * pm) * 255);
    r2.data[j] = r2.data[j + 1] = r2.data[j + 2] = rv;
    const hv = Math.round(((h2.data[j] / 255) * (1 - pm) + 0.45 * pm) * 255);
    h2.data[j] = h2.data[j + 1] = h2.data[j + 2] = hv;
  }
  alb.putImageData(a2, 0, 0);
  rgh.putImageData(r2, 0, 0);
  hgt.putImageData(h2, 0, 0);

  const map = finalizeTexture(albC, THREE.SRGBColorSpace, anisotropy);
  const roughnessMap = finalizeTexture(rghC, THREE.NoColorSpace, anisotropy);
  const normalMap = normalTextureFromHeight(hgt, S, S, 1.2, anisotropy);
  return { map, roughnessMap, normalMap };
}

// ---------------------------------------------------------------------------
// 4. Hologram neon sign atlas (1024², 8 vertical strips)
// ---------------------------------------------------------------------------
const NEON_STRIPS: ReadonlyArray<{ text: string; color: string; glow: string }> = [
  { text: 'ストランド', color: '#7ff8ff', glow: '#00f0ff' },
  { text: 'ネオンバー', color: '#ff8ae8', glow: '#ff2bd6' },
  { text: 'ラーメン', color: '#ffd28a', glow: '#ffa21f' },
  { text: 'STRAND//09', color: '#aefcff', glow: '#38f8ff' },
  { text: 'サイバネティクス', color: '#ff9ef0', glow: '#ff2bd6' },
  { text: 'ホロカフェ', color: '#9ffcff', glow: '#00f0ff' },
  { text: '▲ZONE-480▼', color: '#ffc96a', glow: '#ffa21f' },
  { text: 'ゼロナイン', color: '#ff86b0', glow: '#ff2b6d' },
];

function generateNeonAtlas(anisotropy: number): THREE.Texture {
  const W = 1024;
  const H = 1024;
  const strips = NEON_STRIPS.length;
  const sw = W / strips;
  const [c, ctx] = makeCanvas(W, H);
  ctx.clearRect(0, 0, W, H);
  const font = "'Hiragino Kaku Gothic ProN','Yu Gothic','Meiryo','Noto Sans CJK JP','Noto Sans JP','Arial Black',sans-serif";

  for (let s = 0; s < strips; s++) {
    const x0 = s * sw;
    const def = NEON_STRIPS[s];
    // Translucent dark backing panel.
    ctx.fillStyle = 'rgba(8,10,18,0.55)';
    ctx.fillRect(x0 + 6, 6, sw - 12, H - 12);
    // Neon tube border.
    ctx.save();
    ctx.shadowColor = def.glow;
    ctx.shadowBlur = 18;
    ctx.strokeStyle = def.color;
    ctx.lineWidth = 4;
    ctx.strokeRect(x0 + 12, 12, sw - 24, H - 24);
    ctx.restore();

    // Vertical text: one glyph per row.
    const chars = Array.from(def.text);
    const rows = chars.length;
    const cell = Math.min((H - 80) / rows, sw * 0.9);
    const startY = (H - cell * rows) / 2 + cell * 0.5;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 ${Math.floor(cell * 0.78)}px ${font}`;
    for (let r = 0; r < rows; r++) {
      const cy = startY + r * cell;
      ctx.save();
      ctx.shadowColor = def.glow;
      ctx.shadowBlur = 26;
      ctx.fillStyle = def.glow;
      ctx.fillText(chars[r], x0 + sw / 2, cy);
      ctx.shadowBlur = 8;
      ctx.fillStyle = def.color;
      ctx.fillText(chars[r], x0 + sw / 2, cy);
      ctx.restore();
    }
  }
  const tex = finalizeTexture(c, THREE.SRGBColorSpace, anisotropy, false);
  tex.premultiplyAlpha = false;
  return tex;
}

// ---------------------------------------------------------------------------
// 4b. Sign atlas (5B-3): wide banners + scrolling tickers (top) and emblems (bottom), 1024²
// ---------------------------------------------------------------------------
const WIDE_SIGNS: ReadonlyArray<{ text: string; color: string; glow: string }> = [
  { text: 'ラーメン 24H ◆ NEON NOODLE', color: '#ffd28a', glow: '#ffa21f' },
  { text: 'OMEGA//CORP — STRAND SYSTEMS', color: '#aefcff', glow: '#00f0ff' },
  { text: 'サイバー薬局 PHARMA+', color: '#9dffc8', glow: '#39ff88' },
  { text: 'HOTEL 九龍 ◆ VACANCY', color: '#ff9ef0', glow: '#ff2bd6' },
  { text: 'KARAOKE カラオケ ▶ BAR', color: '#d6a8ff', glow: '#b44bff' },
  { text: 'EXPRESS 09 ▶▶ EXIT 4B', color: '#7ff8ff', glow: '#38f8ff' },
  { text: '▶ SECTOR LOCKDOWN ▶ STAY INDOORS ▶ CURFEW 23:00 ', color: '#ffc96a', glow: '#ffa21f' },
  { text: '◆ VALKYRIE-09 SIGHTED ◆ ネオン市 警報 ◆ GRID 480 ', color: '#ff86b0', glow: '#ff2b6d' },
];

function generateSignAtlas(anisotropy: number): THREE.Texture {
  const W = 1024;
  const H = 1024;
  const RH = 64;
  const [c, ctx] = makeCanvas(W, H);
  ctx.clearRect(0, 0, W, H);
  const font = "'Hiragino Kaku Gothic ProN','Yu Gothic','Meiryo','Noto Sans CJK JP','Noto Sans JP','Arial Black',sans-serif";
  const glowText = (text: string, x: number, y: number, color: string, glow: string, align: CanvasTextAlign): void => {
    ctx.textAlign = align;
    ctx.save();
    ctx.shadowColor = glow;
    ctx.shadowBlur = 16;
    ctx.fillStyle = glow;
    ctx.fillText(text, x, y);
    ctx.shadowBlur = 5;
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
    ctx.restore();
  };
  // ---- Wide banners (rows 0–5) and seamless tickers (rows 6–7).
  WIDE_SIGNS.forEach((def, r) => {
    const y0 = r * RH;
    const scroll = SIGN_ATLAS.SCROLL_ROWS.includes(r);
    ctx.fillStyle = scroll ? 'rgba(4,6,12,0.82)' : 'rgba(8,10,18,0.6)';
    ctx.fillRect(2, y0 + 3, W - 4, RH - 6);
    ctx.textBaseline = 'middle';
    if (scroll) {
      // LED dot-matrix ticker: the text tiles every W px so a fract(u + t) scroll never shows a seam.
      ctx.font = `800 ${RH * 0.56}px ${font}`;
      const tw = ctx.measureText(def.text).width;
      const reps = Math.max(1, Math.round(W / tw));
      const step = W / reps;
      for (let k = 0; k <= reps; k++) glowText(def.text, k * step, y0 + RH / 2, def.color, def.glow, 'left');
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      for (let x = 0; x < W; x += 4) ctx.fillRect(x, y0, 1, RH);
      for (let y = y0; y < y0 + RH; y += 4) ctx.fillRect(0, y, W, 1);
    } else {
      ctx.save();
      ctx.shadowColor = def.glow;
      ctx.shadowBlur = 12;
      ctx.strokeStyle = def.color;
      ctx.lineWidth = 3;
      ctx.strokeRect(8, y0 + 8, W - 16, RH - 16);
      ctx.restore();
      ctx.font = `900 ${RH * 0.5}px ${font}`;
      glowText(def.text, W / 2, y0 + RH / 2 + 1, def.color, def.glow, 'center');
    }
  });
  // ---- Emblems (bottom half: 4 × 2 cells of 256²).
  const E = 256;
  const emblem = (i: number, draw: (cx: number, cy: number, r: number) => void, color: string, glow: string): void => {
    const cx = (i % 4) * E + E / 2;
    const cy = 512 + Math.floor(i / 4) * E + E / 2;
    ctx.save();
    ctx.shadowColor = glow;
    ctx.shadowBlur = 20;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 9;
    draw(cx, cy, E * 0.38);
    ctx.restore();
  };
  const poly = (cx: number, cy: number, r: number, n: number, rot: number): void => {
    ctx.beginPath();
    for (let k = 0; k <= n; k++) {
      const a = rot + (k / n) * Math.PI * 2;
      if (k === 0) ctx.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      else ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
    ctx.stroke();
  };
  // 0 concentric ring logo
  emblem(0, (cx, cy, r) => {
    for (const k of [1, 0.66, 0.33]) {
      ctx.beginPath();
      ctx.arc(cx, cy, r * k, 0.3, Math.PI * 2 - 0.3);
      ctx.stroke();
    }
  }, '#aefcff', '#00f0ff');
  // 1 hexagon corporate logo with inner Y
  emblem(1, (cx, cy, r) => {
    poly(cx, cy, r, 6, Math.PI / 6);
    poly(cx, cy, r * 0.62, 6, Math.PI / 6);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx, cy + r * 0.62);
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx - r * 0.54, cy - r * 0.31);
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + r * 0.54, cy - r * 0.31);
    ctx.stroke();
  }, '#ff9ef0', '#ff2bd6');
  // 2 warning triangle
  emblem(2, (cx, cy, r) => {
    poly(cx, cy + r * 0.15, r, 3, -Math.PI / 2);
    ctx.fillRect(cx - 7, cy - r * 0.35, 14, r * 0.6);
    ctx.fillRect(cx - 7, cy + r * 0.38, 14, 14);
  }, '#ffd28a', '#ffa21f');
  // 3 barcode
  emblem(3, (cx, cy, r) => {
    let x = cx - r;
    let k = 0;
    while (x < cx + r) {
      const w = 3 + ((k * 7919) % 5) * 3;
      if (k % 2 === 0) ctx.fillRect(x, cy - r * 0.7, w, r * 1.2);
      x += w + 3;
      k++;
    }
    ctx.font = `800 ${Math.floor(r * 0.3)}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('0x09-480', cx, cy + r * 0.82);
  }, '#9dffc8', '#39ff88');
  // 4 waveform graph
  emblem(4, (cx, cy, r) => {
    ctx.strokeRect(cx - r, cy - r * 0.7, r * 2, r * 1.4);
    ctx.lineWidth = 6;
    ctx.beginPath();
    for (let k = 0; k <= 40; k++) {
      const x = cx - r + (k / 40) * r * 2;
      const y = cy + Math.sin(k * 0.7) * Math.cos(k * 0.23) * r * 0.5;
      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }, '#7ff8ff', '#38f8ff');
  // 5 target reticle
  emblem(5, (cx, cy, r) => {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.45, 0, Math.PI * 2);
    ctx.stroke();
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r * 0.6, cy + Math.sin(a) * r * 0.6);
      ctx.lineTo(cx + Math.cos(a) * r * 1.15, cy + Math.sin(a) * r * 1.15);
      ctx.stroke();
    }
  }, '#ff86b0', '#ff2b6d');
  // 6 kanji seal 零
  emblem(6, (cx, cy, r) => {
    ctx.strokeRect(cx - r, cy - r, r * 2, r * 2);
    ctx.font = `900 ${Math.floor(r * 1.5)}px ${font}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('零', cx, cy + 4);
  }, '#d6a8ff', '#b44bff');
  // 7 chevron arrows
  emblem(7, (cx, cy, r) => {
    for (let k = -1; k <= 1; k++) {
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.5 + k * r * 0.55, cy - r * 0.6);
      ctx.lineTo(cx + k * r * 0.55, cy);
      ctx.lineTo(cx - r * 0.5 + k * r * 0.55, cy + r * 0.6);
      ctx.stroke();
    }
  }, '#aefcff', '#00f0ff');
  const tex = finalizeTexture(c, THREE.SRGBColorSpace, anisotropy, false);
  tex.wrapS = THREE.RepeatWrapping; // tickers scroll along u
  tex.premultiplyAlpha = false;
  return tex;
}

// ---------------------------------------------------------------------------
// 4c. Tactical tech PBR set (5B-4, 512²): carbon weave, machined panel grooves, edge wear, brushed metal.
//     Shared by the first-person weapons / arm armour and the enemy armour batch.
// ---------------------------------------------------------------------------
function generateTechSet(anisotropy: number): PbrTextureSet {
  const S = 512;
  const [albC, alb] = makeCanvas(S, S);
  const [rghC, rgh] = makeCanvas(S, S);
  const [, hgt] = makeCanvas(S, S);
  const rng = createRng(0x7ec4);
  // Base: neutral mid grey so per-part colours (material colour / instance colour) still read.
  alb.fillStyle = '#b9bec6';
  alb.fillRect(0, 0, S, S);
  rgh.fillStyle = grayCss(0.42);
  rgh.fillRect(0, 0, S, S);
  hgt.fillStyle = grayCss(0.6);
  hgt.fillRect(0, 0, S, S);
  // Brushed metal: fine horizontal streaks.
  for (let i = 0; i < 1400; i++) {
    const y = rng() * S;
    const x = rng() * S;
    const len = 30 + rng() * 140;
    const v = 0.5 + rng() * 0.25;
    alb.fillStyle = `rgba(${Math.round(255 * v)},${Math.round(255 * v)},${Math.round(255 * v)},0.12)`;
    alb.fillRect(x, y, len, 1);
    rgh.fillStyle = grayCss(0.3 + rng() * 0.25);
    rgh.globalAlpha = 0.25;
    rgh.fillRect(x, y, len, 1);
    rgh.globalAlpha = 1;
  }
  // Carbon weave patches (2 × 2 twill) in alternating panels.
  const cell = 8;
  for (let py = 0; py < S; py += 128) {
    for (let px = 0; px < S; px += 128) {
      if (((px + py) / 128) % 2 !== 0) continue;
      for (let y = py; y < py + 128; y += cell) {
        for (let x = px; x < px + 128; x += cell) {
          const k = ((x - px) / cell + (y - py) / cell) % 4 < 2;
          alb.fillStyle = k ? 'rgba(40,44,52,0.55)' : 'rgba(70,76,88,0.5)';
          alb.fillRect(x, y, cell, cell);
          hgt.fillStyle = grayCss(k ? 0.62 : 0.54);
          hgt.fillRect(x, y, cell, cell);
          rgh.fillStyle = grayCss(k ? 0.36 : 0.5);
          rgh.fillRect(x, y, cell, cell);
        }
      }
    }
  }
  // Machined panel grooves (seams every 128 px + random sub-panels) with highlighted, worn edges.
  const groove = (x0: number, y0: number, x1: number, y1: number): void => {
    hgt.fillStyle = grayCss(0.18);
    alb.fillStyle = 'rgba(18,20,26,0.9)';
    if (x0 === x1) {
      hgt.fillRect(x0 - 1, y0, 3, y1 - y0);
      alb.fillRect(x0 - 1, y0, 3, y1 - y0);
      alb.fillStyle = 'rgba(235,240,248,0.35)';
      alb.fillRect(x0 + 2, y0, 1, y1 - y0);
    } else {
      hgt.fillRect(x0, y0 - 1, x1 - x0, 3);
      alb.fillRect(x0, y0 - 1, x1 - x0, 3);
      alb.fillStyle = 'rgba(235,240,248,0.35)';
      alb.fillRect(x0, y0 + 2, x1 - x0, 1);
    }
  };
  for (let k = 0; k <= S; k += 128) {
    groove(k, 0, k, S);
    groove(0, k, S, k);
  }
  for (let i = 0; i < 18; i++) {
    const x = Math.floor(rng() * 4) * 128 + 16 + Math.floor(rng() * 6) * 16;
    const y = Math.floor(rng() * 4) * 128 + 16 + Math.floor(rng() * 6) * 16;
    const w = 24 + Math.floor(rng() * 5) * 8;
    const h = 24 + Math.floor(rng() * 5) * 8;
    groove(x, y, x + w, y);
    groove(x, y + h, x + w, y + h);
    groove(x, y, x, y + h);
    groove(x + w, y, x + w, y + h);
    // Recessed screw heads at the corners.
    for (const [sx, sy] of [[x + 5, y + 5], [x + w - 5, y + 5], [x + 5, y + h - 5], [x + w - 5, y + h - 5]]) {
      hgt.fillStyle = grayCss(0.3);
      hgt.beginPath();
      hgt.arc(sx, sy, 2.4, 0, Math.PI * 2);
      hgt.fill();
    }
  }
  // Edge wear: bright scuffs along seams, lower roughness where polished.
  for (let i = 0; i < 260; i++) {
    const onX = rng() < 0.5;
    const line = Math.floor(rng() * 5) * 128;
    const t = rng() * S;
    const x = onX ? line + (rng() - 0.5) * 6 : t;
    const y = onX ? t : line + (rng() - 0.5) * 6;
    alb.fillStyle = 'rgba(240,244,250,0.22)';
    alb.fillRect(x, y, onX ? 2 : 6 + rng() * 14, onX ? 6 + rng() * 14 : 2);
    rgh.fillStyle = grayCss(0.18);
    rgh.fillRect(x, y, onX ? 2 : 10, onX ? 10 : 2);
  }
  return {
    map: finalizeTexture(albC, THREE.SRGBColorSpace, anisotropy),
    roughnessMap: finalizeTexture(rghC, THREE.NoColorSpace, anisotropy),
    normalMap: normalTextureFromHeight(hgt, S, S, 2.4, anisotropy),
  };
}

// ---------------------------------------------------------------------------
// 5. Rooftop machinery: AC-unit fan grille (256²)
// ---------------------------------------------------------------------------
function generateMachinerySet(anisotropy: number): PbrTextureSet {
  const S = 256;
  const [albC, alb] = makeCanvas(S, S);
  const [rghC, rgh] = makeCanvas(S, S);
  const [, hgt] = makeCanvas(S, S);
  alb.fillStyle = '#3a414c';
  alb.fillRect(0, 0, S, S);
  rgh.fillStyle = grayCss(0.48);
  rgh.fillRect(0, 0, S, S);
  hgt.fillStyle = grayCss(0.6);
  hgt.fillRect(0, 0, S, S);

  // Twin fans.
  for (const cx of [S * 0.28, S * 0.72]) {
    const cy = S * 0.42;
    const rad = S * 0.2;
    alb.fillStyle = '#16191f';
    alb.beginPath();
    alb.arc(cx, cy, rad, 0, Math.PI * 2);
    alb.fill();
    hgt.fillStyle = grayCss(0.2);
    hgt.beginPath();
    hgt.arc(cx, cy, rad, 0, Math.PI * 2);
    hgt.fill();
    // Concentric grille rings.
    for (let r = 6; r < rad; r += 6) {
      for (const ctx of [alb, hgt]) {
        ctx.strokeStyle = ctx === alb ? '#5a636f' : grayCss(0.9);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    for (let a = 0; a < 8; a++) {
      const ang = (a / 8) * Math.PI * 2;
      for (const ctx of [alb, hgt]) {
        ctx.strokeStyle = ctx === alb ? '#5a636f' : grayCss(0.95);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad);
        ctx.stroke();
      }
    }
  }
  // Side vent slots.
  for (let y = S * 0.72; y < S * 0.94; y += 7) {
    alb.fillStyle = '#1a1e25';
    alb.fillRect(S * 0.08, y, S * 0.84, 3);
    hgt.fillStyle = grayCss(0.25);
    hgt.fillRect(S * 0.08, y, S * 0.84, 3);
  }
  // Rain-wet streaks.
  rgh.fillStyle = grayCss(0.22);
  for (let i = 0; i < 40; i++) rgh.fillRect((i * 37) % S, 0, 2, S * (0.3 + ((i * 13) % 7) / 10));

  return {
    map: finalizeTexture(albC, THREE.SRGBColorSpace, anisotropy),
    roughnessMap: finalizeTexture(rghC, THREE.NoColorSpace, anisotropy),
    normalMap: normalTextureFromHeight(hgt, S, S, 2.0, anisotropy),
  };
}

// ---------------------------------------------------------------------------
// 6B-1 view-model PBR sets (512², four 256² zones; R unused · G roughness · B metalness packed)
//   Glove / wear:  0 synthetic leather (grain, stitch rows, knuckle creases) · 1 ballistic nylon weave ·
//                  2 rubber grip pads · 3 jacket twill
//   Gun hard-surface: 0 brushed gunmetal (brush marks, micro scratches, edge wear, screws) · 1 grip
//                  checkering · 2 polymer composite (stipple) · 3 dark anodised heat-slit panel
// Parts sample their zone with box-proportional UVs (metres / tile), so small parts never stretch.
// ---------------------------------------------------------------------------
interface ZoneCanvases {
  alb: CanvasRenderingContext2D;
  rgh: CanvasRenderingContext2D;
  mtl: CanvasRenderingContext2D;
  hgt: CanvasRenderingContext2D;
}

function zonedSet(anisotropy: number, seed: number, paint: (z: ZoneCanvases, zone: number, ox: number, oy: number, n: number, rng: () => number) => void, normalStrength: number): PbrTextureSet {
  const S = 512;
  const Z = 256;
  const [albC, alb] = makeCanvas(S, S);
  const [, rgh] = makeCanvas(S, S);
  const [, mtl] = makeCanvas(S, S);
  const [, hgt] = makeCanvas(S, S);
  const rng = createRng(seed);
  const z: ZoneCanvases = { alb, rgh, mtl, hgt };
  for (let k = 0; k < 4; k++) {
    const ox = (k % 2) * Z;
    const oy = Math.floor(k / 2) * Z;
    for (const c of [alb, rgh, mtl, hgt]) {
      c.save();
      c.beginPath();
      c.rect(ox, oy, Z, Z);
      c.clip();
    }
    paint(z, k, ox, oy, Z, rng);
    for (const c of [alb, rgh, mtl, hgt]) c.restore();
  }
  const rD = rgh.getImageData(0, 0, S, S).data;
  const tD = mtl.getImageData(0, 0, S, S).data;
  const [packC, pack] = makeCanvas(S, S);
  const img = pack.createImageData(S, S);
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = 0;
    img.data[i + 1] = rD[i];
    img.data[i + 2] = tD[i];
    img.data[i + 3] = 255;
  }
  pack.putImageData(img, 0, 0);
  return {
    map: finalizeTexture(albC, THREE.SRGBColorSpace, anisotropy),
    roughnessMap: finalizeTexture(packC, THREE.NoColorSpace, anisotropy),
    normalMap: normalTextureFromHeight(hgt, S, S, normalStrength, anisotropy),
  };
}

const fillZ = (c: CanvasRenderingContext2D, style: string, ox: number, oy: number, n: number): void => {
  c.fillStyle = style;
  c.fillRect(ox, oy, n, n);
};

function generateGloveSet(anisotropy: number): PbrTextureSet {
  return zonedSet(anisotropy, 0x6107e, ({ alb, rgh, mtl, hgt }, zone, ox, oy, n, rng) => {
    fillZ(mtl, '#000', ox, oy, n);
    if (zone === 0) {
      // Synthetic leather: fine grain (shibo), knuckle creases, two stitch rows.
      fillZ(alb, grayCss(0.56), ox, oy, n);
      fillZ(rgh, grayCss(0.58), ox, oy, n);
      fillZ(hgt, grayCss(0.55), ox, oy, n);
      for (let i = 0; i < 2600; i++) {
        const x = ox + rng() * n;
        const y = oy + rng() * n;
        const r = 1 + rng() * 2.2;
        const up = rng() < 0.5;
        hgt.fillStyle = up ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.3)';
        hgt.beginPath();
        hgt.arc(x, y, r, 0, Math.PI * 2);
        hgt.fill();
        alb.fillStyle = up ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.06)';
        alb.fillRect(x - r, y - r, r * 2, r * 2);
        rgh.fillStyle = up ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.05)';
        rgh.fillRect(x - r, y - r, r * 2, r * 2);
      }
      for (let k = 0; k < 7; k++) {
        const y0 = oy + 18 + k * 34 + rng() * 6;
        hgt.strokeStyle = 'rgba(0,0,0,0.55)';
        hgt.lineWidth = 1.4;
        hgt.beginPath();
        for (let x = 0; x <= n; x += 8) hgt.lineTo(ox + x, y0 + Math.sin(x * 0.09 + k) * 2.2);
        hgt.stroke();
        alb.strokeStyle = 'rgba(0,0,0,0.12)';
        alb.beginPath();
        for (let x = 0; x <= n; x += 8) alb.lineTo(ox + x, y0 + Math.sin(x * 0.09 + k) * 2.2);
        alb.stroke();
      }
      for (const sy of [oy + 22, oy + 150]) {
        for (let x = ox; x < ox + n; x += 10) {
          alb.fillStyle = 'rgba(190,190,176,0.75)';
          alb.fillRect(x, sy, 6, 2);
          hgt.fillStyle = grayCss(0.85);
          hgt.fillRect(x, sy, 6, 2);
          rgh.fillStyle = grayCss(0.72);
          rgh.fillRect(x, sy, 6, 2);
        }
        hgt.fillStyle = 'rgba(0,0,0,0.35)';
        hgt.fillRect(ox, sy + 4, n, 1);
      }
    } else if (zone === 1) {
      // Ballistic nylon basket weave.
      fillZ(alb, grayCss(0.5), ox, oy, n);
      fillZ(rgh, grayCss(0.78), ox, oy, n);
      fillZ(hgt, grayCss(0.5), ox, oy, n);
      const c = 4;
      for (let y = 0; y < n; y += c) {
        for (let x = 0; x < n; x += c) {
          const k = (Math.floor(x / (c * 2)) + Math.floor(y / (c * 2))) % 2 === 0;
          hgt.fillStyle = grayCss(k ? 0.66 : 0.4);
          hgt.fillRect(ox + x, oy + y, k ? c : c - 1, k ? c - 1 : c);
          alb.fillStyle = k ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.08)';
          alb.fillRect(ox + x, oy + y, c, c);
        }
      }
      for (const sy of [oy + 64, oy + 192]) {
        for (let x = ox; x < ox + n; x += 9) {
          alb.fillStyle = 'rgba(170,170,160,0.6)';
          alb.fillRect(x, sy, 5, 2);
          hgt.fillStyle = grayCss(0.8);
          hgt.fillRect(x, sy, 5, 2);
        }
      }
    } else if (zone === 2) {
      // Anti-slip rubber pads: raised rounded nubs, glossier than the fabric.
      fillZ(alb, grayCss(0.38), ox, oy, n);
      fillZ(rgh, grayCss(0.5), ox, oy, n);
      fillZ(hgt, grayCss(0.42), ox, oy, n);
      for (let y = 6, row = 0; y < n; y += 11, row++) {
        for (let x = (row % 2) * 6 + 6; x < n; x += 12) {
          hgt.fillStyle = grayCss(0.9);
          hgt.beginPath();
          hgt.arc(ox + x, oy + y, 3.6, 0, Math.PI * 2);
          hgt.fill();
          rgh.fillStyle = grayCss(0.35);
          rgh.beginPath();
          rgh.arc(ox + x, oy + y, 3.6, 0, Math.PI * 2);
          rgh.fill();
          alb.fillStyle = 'rgba(0,0,0,0.25)';
          alb.beginPath();
          alb.arc(ox + x, oy + y, 3.6, 0, Math.PI * 2);
          alb.fill();
        }
      }
    } else {
      // Jacket twill with panel seams.
      fillZ(alb, grayCss(0.52), ox, oy, n);
      fillZ(rgh, grayCss(0.74), ox, oy, n);
      fillZ(hgt, grayCss(0.5), ox, oy, n);
      hgt.strokeStyle = 'rgba(255,255,255,0.4)';
      hgt.lineWidth = 1.2;
      for (let d = -n; d < n; d += 4) {
        hgt.beginPath();
        hgt.moveTo(ox + d, oy);
        hgt.lineTo(ox + d + n, oy + n);
        hgt.stroke();
      }
      for (const sy of [oy + 2, oy + 128]) {
        hgt.fillStyle = 'rgba(0,0,0,0.6)';
        hgt.fillRect(ox, sy, n, 2);
        alb.fillStyle = 'rgba(0,0,0,0.18)';
        alb.fillRect(ox, sy, n, 2);
        for (let x = ox; x < ox + n; x += 8) {
          alb.fillStyle = 'rgba(160,160,150,0.5)';
          alb.fillRect(x, sy + 5, 4, 1.5);
        }
      }
    }
  }, 2.2);
}

function generateGunSet(anisotropy: number): PbrTextureSet {
  return zonedSet(anisotropy, 0x6a7e7, ({ alb, rgh, mtl, hgt }, zone, ox, oy, n, rng) => {
    if (zone === 0) {
      // Brushed gunmetal: brush marks, micro scratches, worn bright edges, two screws.
      fillZ(alb, grayCss(0.62), ox, oy, n);
      fillZ(rgh, grayCss(0.36), ox, oy, n);
      fillZ(mtl, grayCss(0.92), ox, oy, n);
      fillZ(hgt, grayCss(0.6), ox, oy, n);
      for (let i = 0; i < 900; i++) {
        const y = oy + rng() * n;
        const x = ox + rng() * n;
        const v = 0.42 + rng() * 0.25;
        alb.fillStyle = `rgba(${Math.round(255 * v)},${Math.round(255 * v)},${Math.round(255 * v)},0.16)`;
        alb.fillRect(x, y, 20 + rng() * 90, 1);
        rgh.fillStyle = `rgba(${rng() < 0.5 ? '0,0,0' : '255,255,255'},0.08)`;
        rgh.fillRect(x, y, 30 + rng() * 60, 1);
      }
      for (let i = 0; i < 90; i++) {
        const x = ox + rng() * n;
        const y = oy + rng() * n;
        const a = rng() * Math.PI;
        const l = 3 + rng() * 9;
        alb.strokeStyle = 'rgba(230,236,244,0.28)';
        alb.lineWidth = 0.7;
        alb.beginPath();
        alb.moveTo(x, y);
        alb.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
        alb.stroke();
        rgh.strokeStyle = 'rgba(0,0,0,0.25)';
        rgh.beginPath();
        rgh.moveTo(x, y);
        rgh.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
        rgh.stroke();
      }
      for (const [sx, sy] of [[ox + 40, oy + 52], [ox + 196, oy + 188]]) {
        hgt.fillStyle = grayCss(0.25);
        hgt.beginPath();
        hgt.arc(sx, sy, 6, 0, Math.PI * 2);
        hgt.fill();
        hgt.fillStyle = grayCss(0.75);
        hgt.beginPath();
        hgt.arc(sx, sy, 4.4, 0, Math.PI * 2);
        hgt.fill();
        hgt.fillStyle = grayCss(0.3);
        hgt.fillRect(sx - 3.5, sy - 0.8, 7, 1.6);
        alb.fillStyle = 'rgba(20,22,26,0.6)';
        alb.beginPath();
        alb.arc(sx, sy, 6, 0, Math.PI * 2);
        alb.fill();
      }
      for (let i = 0; i < 40; i++) {
        alb.fillStyle = 'rgba(240,244,250,0.2)';
        const x = ox + rng() * n;
        const y = oy + rng() * n;
        alb.fillRect(x, y, 2 + rng() * 10, 1 + rng() * 2);
        rgh.fillStyle = grayCss(0.2);
        rgh.fillRect(x, y, 6, 1.5);
      }
    } else if (zone === 1) {
      // Grip checkering: raised diamonds.
      fillZ(alb, grayCss(0.44), ox, oy, n);
      fillZ(rgh, grayCss(0.64), ox, oy, n);
      fillZ(mtl, grayCss(0.08), ox, oy, n);
      fillZ(hgt, grayCss(0.35), ox, oy, n);
      const p = 8;
      for (let y = 0; y < n; y += p) {
        for (let x = 0; x < n; x += p) {
          const cx = ox + x + p / 2;
          const cy = oy + y + p / 2;
          hgt.fillStyle = grayCss(0.9);
          hgt.beginPath();
          hgt.moveTo(cx, cy - p * 0.42);
          hgt.lineTo(cx + p * 0.42, cy);
          hgt.lineTo(cx, cy + p * 0.42);
          hgt.lineTo(cx - p * 0.42, cy);
          hgt.closePath();
          hgt.fill();
          alb.fillStyle = 'rgba(255,255,255,0.05)';
          alb.fillRect(cx - 1, cy - 1, 2, 2);
        }
      }
    } else if (zone === 2) {
      // Polymer composite: stipple + moulding seams.
      fillZ(alb, grayCss(0.46), ox, oy, n);
      fillZ(rgh, grayCss(0.56), ox, oy, n);
      fillZ(mtl, grayCss(0.06), ox, oy, n);
      fillZ(hgt, grayCss(0.5), ox, oy, n);
      for (let i = 0; i < 3000; i++) {
        const x = ox + rng() * n;
        const y = oy + rng() * n;
        hgt.fillStyle = rng() < 0.5 ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.22)';
        hgt.fillRect(x, y, 1.5, 1.5);
        alb.fillStyle = rng() < 0.5 ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.04)';
        alb.fillRect(x, y, 2, 2);
      }
      for (const sy of [oy + 90, oy + 210]) {
        hgt.fillStyle = grayCss(0.2);
        hgt.fillRect(ox, sy, n, 1.5);
        alb.fillStyle = 'rgba(0,0,0,0.25)';
        alb.fillRect(ox, sy, n, 1.5);
      }
    } else {
      // Dark anodised panel with machined heat slits and hex bolt holes.
      fillZ(alb, grayCss(0.38), ox, oy, n);
      fillZ(rgh, grayCss(0.34), ox, oy, n);
      fillZ(mtl, grayCss(0.78), ox, oy, n);
      fillZ(hgt, grayCss(0.6), ox, oy, n);
      for (let col = 0; col < 2; col++) {
        for (let k = 0; k < 9; k++) {
          const x = ox + 24 + col * 120;
          const y = oy + 20 + k * 25;
          hgt.fillStyle = grayCss(0.15);
          hgt.fillRect(x, y, 90, 8);
          alb.fillStyle = 'rgba(4,5,7,0.9)';
          alb.fillRect(x, y, 90, 8);
          alb.fillStyle = 'rgba(230,236,244,0.22)';
          alb.fillRect(x, y + 8, 90, 1);
        }
      }
      for (const [sx, sy] of [[ox + 12, oy + 12], [ox + n - 12, oy + 12], [ox + 12, oy + n - 12], [ox + n - 12, oy + n - 12]]) {
        hgt.fillStyle = grayCss(0.2);
        hgt.beginPath();
        hgt.arc(sx, sy, 4, 0, Math.PI * 2);
        hgt.fill();
      }
    }
  }, 2.6);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
let cache: ProceduralTextureLibrary | null = null;

/** Generates (once) and returns the full procedural texture library. */
export function getProceduralTextures(renderer: THREE.WebGLRenderer): ProceduralTextureLibrary {
  if (cache) return cache;
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  cache = {
    facades: generateFacadeAtlas(aniso),
    roof: generateRoofSet(aniso),
    roads: generateRoadAtlas(aniso),
    machinery: generateMachinerySet(aniso),
    neonAtlas: generateNeonAtlas(aniso),
    neonAtlasStrips: NEON_STRIPS.length,
    signAtlas: generateSignAtlas(aniso),
    tech: generateTechSet(aniso),
    glove: generateGloveSet(aniso),
    gun: generateGunSet(aniso),
  };
  return cache;
}
