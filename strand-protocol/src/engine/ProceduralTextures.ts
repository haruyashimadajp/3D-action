/**
 * STRAND // PROTOCOL — Procedural PBR texture factory (§6.2-2).
 * Everything is generated once at boot with Canvas2D and cached; no external assets.
 *
 *  - Facade atlas (2048 × 1024, 6A-1): four archetype columns — glass curtain wall, cast-concrete
 *    residential, corrugated-metal industrial, commercial tenant — × typical / mechanical / solid ground floors.
 *    Albedo / Emissive (neutral room light + fixed neon) / packed glass mask · roughness · metalness /
 *    Normal; blinds, curtains, desk silhouettes, rain streaks, rust, panel joints, louvres
 *  - Wet rooftop / sidewalk concrete with cracks & puddles (512²): Albedo / Roughness (puddle 0.06, wet 0.42) / Normal
 *  - Wet road atlas (512²): lanes, centre line, white dashes, crosswalk, manholes, puddles
 *  - Hologram neon sign atlas (1024²): 8 vertical stacked-English / symbol strips (10B-2: 100 % English signage)
 *  - Sign atlas (1024², 5B-3): 6 wide banners + 2 seamless scrolling LED tickers, 8 emblems / holograms
 *  - Tactical tech PBR set (512², 5B-4): carbon weave, panel grooves, screw heads, edge wear, brushed metal
 *  - Rooftop machinery (256²): AC-unit fan grille Albedo / Roughness / Normal
 *  - 6B-1 view-model sets (512², 4 zones each): glove & wear (leather grain + stitching + knuckle creases,
 *    ballistic nylon, rubber grip, jacket twill) and gun hard-surface (brushed gunmetal with scratches / edge
 *    wear / screws, checkering, polymer stipple, anodised heat slits)
 *  - 12A-3 close-up automotive detail set (512², 4 quadrants, DataTexture — no Canvas2D): carbon twill,
 *    honeycomb grille, radial brushed metal, clearcoat rain beading (see VEHICLE_DETAIL)
 */
import * as THREE from 'three';
import {
  COLORS,
  FACADE,
  RENDER,
  ROOF_PUDDLE_ROUGHNESS,
  ROOF_WET_ROUGHNESS,
  ROAD_WET_ROUGHNESS,
  createRng,
  srgbToLinear,
  clamp,
} from '../config/constants';
import { PLAQUE_LABELS } from '../world/CityProps';

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
  /** 9A-5 weathered paint / stained architectural detail (512²): neutral grey map × vertex tint. */
  archDetail: PbrTextureSet;
  /** 9A-6 cast-iron manhole (256²): map / roughness / normal + emissive grate-glow mask. */
  manhole: Required<PbrTextureSet>;
  /** 9B-1 illuminated room-number plaque atlas (512 × 256, 4 × 4 cells of PLAQUE_LABELS; black = unlit). */
  plaqueAtlas: THREE.Texture;
  /** 9B-3 graffiti / torn-poster decal atlas (1024 × 512, 4 × 2 alpha-masked cells: 0–3 spray, 4–7 posters). */
  graffitiAtlas: THREE.Texture;
  /** 10B-2 Mega-Billboard hero-ad atlas (2048 × 1024, 4 × 2 cells, 100 % English) — see MEGA_ATLAS. */
  megaBillboard: THREE.Texture;
  /** 10C-2 vending display atlas (512², 2 × 2 brand quadrants of 256², 100 % English) — see VENDING_ATLAS. */
  vendingAtlas: THREE.Texture;
  /** 10D-3 street-landmark atlas (512 × 256, 100 % English): top half ramen-cart marquee, bottom half transit map. */
  furnishingsAtlas?: THREE.Texture;
  /**
   * 12A-3 close-up automotive detail set (512², 4 quadrants of 256²: Q0 carbon twill · Q1 honeycomb grille ·
   * Q2 brushed radial metal · Q3 clearcoat rain-beading). Sampled by the zero-UV car shader via custom
   * uniforms (cars carry no `uv`), never assigned to `mat.normalMap`. Optional so headless mocks stay valid.
   */
  vehicleDetail?: { readonly normalMap: THREE.Texture; readonly roughnessMap: THREE.Texture };
  /** 6B-1 tactical glove & wear set (512², four zones; roughnessMap packs G roughness · B metalness). */
  glove: PbrTextureSet;
  /** 6B-1 gun micro hard-surface set (512², four zones; roughnessMap packs G roughness · B metalness). */
  gun: PbrTextureSet;
}

/** Rows in the wide-banner half of the sign atlas and emblem cells (4 × 2). */
export const SIGN_ATLAS = {
  WIDE_ROWS: 8,
  SCROLL_ROWS: [6, 7] as readonly number[],
  EMBLEMS: 8,
  /** 10C-3 wide-banner rows carrying the open-frame scaffold neon words (English tube lettering). */
  WORD_ROWS: { CYBER_RAMEN: 0, MOTEL_09: 2, NIGHT_BAR: 4, OPEN_24H: 5 } as const,
} as const;

/** 10B-2: crisp uppercase geometric Latin typography for every in-world sign (zero CJK font fallbacks). */
export const SIGN_FONT = "'Arial Black','Helvetica Neue','Arial Narrow',Impact,Arial,sans-serif";

/**
 * 10B-2 Mega-Billboard atlas (2048 × 1024, 4 × 2 cells of 512², 100 % English). `ASPECT` is each cell's designed
 * content aspect (cell 3 is drawn 3× squashed for 1:3 portrait screens, cell 4 6× for 1:6 monolith blades);
 * `TITLE_V` is the title band centre (cell v from the bottom) that wide crops anchor on.
 */
export const MEGA_ATLAS = {
  W: 2048,
  H: 1024,
  CELLS: 8,
  ASPECT: [1, 1, 1, 1 / 3, 1 / 6, 1, 1, 1] as readonly number[],
  TITLE_V: [0.48, 0.5, 0.46, 0.3, 0.5, 0.47, 0.47, 0.48] as readonly number[],
  TITLES: [
    'NEO-TOKYO REALTY',
    'DATA FLOW // 09',
    'CYBERNETICS NOW',
    'BELOW DECK',
    'STRAND // RESTRICTED ZONE 09',
    'KIROSHI // OPTICS',
    'SYNTH NOODLES // 24H',
    'SOFTSYS // CORE',
  ] as readonly string[],
} as const;

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

export interface FacadePaint {
  /** Albedo / emissive CSS colours (emissive: neutral grey = room light, saturated = fixed neon). */
  a?: string;
  e?: string;
  /** Clear-glass mask (interior mapping), roughness, metalness, height — all 0…1. */
  m?: number;
  r?: number;
  t?: number;
  h?: number;
}

/** 10B-2 one full-width horizontal band of the solid street base (metres above the street, base height per column). */
export interface FacadeBaseBand {
  readonly y0: number;
  readonly y1: number;
  readonly p: FacadePaint;
  /** Painted after the column's cladding texture (C corrugation) instead of under it. */
  readonly over?: boolean;
}

/**
 * 10B-2 door-free solid street base per archetype column (atlas row 0): full-width bands only, so nothing on it can
 * read as a doorway / shutter / pillar on a fixed 12 m pitch behind the 3D ground-program bays. Heights are real
 * metres over the column's base storey (4 m; B's podium storey is 4 + FLOOR_BASE_M[1] = 6 m).
 */
export const FACADE_BASE_BANDS: readonly (readonly FacadeBaseBand[])[] = [
  // A office: dark polished granite, panel joints, plinth, canopy fascia.
  [
    { y0: 0, y1: 4, p: { a: '#24272c', m: 0, r: 0.3, t: 0.12, h: 0.72, e: '#000' } },
    { y0: 0, y1: 0.3, p: { a: '#17191d', r: 0.26, t: 0.15, h: 0.9 } },
    { y0: 1.092, y1: 1.108, p: { a: 'rgba(0,0,0,0.5)', h: 0.55 } },
    { y0: 1.892, y1: 1.908, p: { a: 'rgba(0,0,0,0.5)', h: 0.55 } },
    { y0: 2.692, y1: 2.708, p: { a: 'rgba(0,0,0,0.5)', h: 0.55 } },
    { y0: 3.4, y1: 4, p: { a: '#14171c', m: 0, r: 0.36, t: 0.85, h: 0.95 } },
    { y0: 3.4, y1: 3.44, p: { a: '#2b313b', h: 1.0 } },
  ],
  // B residential podium (6 m): plinth, warm tile field, slab band, cast concrete.
  [
    { y0: 0, y1: 6, p: { a: '#57524b', m: 0, r: 0.5, t: 0.05, h: 0.62, e: '#000' } },
    { y0: 0, y1: 0.5, p: { a: '#3c3e41', m: 0, r: 0.85, t: 0, h: 0.8 } },
    { y0: 1.994, y1: 2.006, p: { a: 'rgba(30,26,22,0.55)', h: 0.5 } },
    { y0: 3.294, y1: 3.306, p: { a: 'rgba(30,26,22,0.55)', h: 0.5 } },
    { y0: 4.6, y1: 6, p: { a: '#4a4c4f', r: 0.82, h: 0.62 } },
    { y0: 4.6, y1: 4.75, p: { a: '#3a3c3f', r: 0.8, h: 0.85 } },
  ],
  // C industrial: corrugated cladding over a grimy concrete kerb with a hazard-yellow edge.
  [
    { y0: 0, y1: 0.6, p: { a: '#45443f', m: 0, r: 0.86, t: 0, h: 0.7, e: '#000' }, over: true },
    { y0: 0.6, y1: 0.66, p: { a: '#2a2f34', r: 0.45, t: 0.8, h: 0.95 }, over: true },
    { y0: 0.04, y1: 0.16, p: { a: '#8a741e', r: 0.6, t: 0.1 }, over: true },
    { y0: 3.85, y1: 4, p: { a: '#23282d', h: 0.95 }, over: true },
  ],
  // D commercial: dark stone base, unlit sign band, cornice.
  [
    { y0: 0, y1: 4, p: { a: '#2a2725', m: 0, r: 0.5, t: 0.1, h: 0.75, e: '#000' } },
    { y0: 0, y1: 0.35, p: { a: '#23201e', r: 0.5, h: 1.0 } },
    { y0: 3.1, y1: 3.74, p: { a: '#121418', m: 0, r: 0.38, t: 0.55, h: 0.92 } },
    { y0: 3.8, y1: 4, p: { a: '#23211f', r: 0.45, t: 0.1, h: 0.95 } },
  ],
];

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
  // <solid-base> 10B-2: atlas row 0 is a door-free solid street base painted ONLY from full-width horizontal bands
  // (FACADE_BASE_BANDS) plus sub-0.8 m speckle / grime. The 3D ground programs own every pier, bay, door and shutter
  // on the 4 m bay grid; the old 12 m-periodic painted entrances / service doors / shutters showed through the gaps
  // beside the real 3D doorways (double / offset doors), so none are painted here any more.
  for (let col = 0; col < FACADE.COLUMNS; col++) {
    cell(col, 0);
    const S = FACADE.FLOOR_H_M / (FACADE.FLOOR_H_M + (FACADE.FLOOR_BASE_M[col] ?? 0));
    for (const band of FACADE_BASE_BANDS[col]) R(0, TW, band.y0 * S, band.y1 * S, band.p);
    if (col === 2) corrugated(0.6, 4);
    for (const band of FACADE_BASE_BANDS[col]) if (band.over) R(0, TW, band.y0 * S, band.y1 * S, band.p);
    // Speckle / grime: small random marks only (≤ 0.8 m wide), never an opening.
    const marks = col === 0 ? 260 : col === 1 ? 90 : 70;
    for (let i = 0; i < marks; i++) {
      const x = rng() * TW;
      const y = rng() * 3.4;
      const w = col === 0 ? 0.03 + rng() * 0.07 : 0.2 + rng() * 0.6;
      const h = col === 0 ? 0.02 + rng() * 0.04 : 0.1 + rng() * 0.5;
      R(x, x + w, y, y + h, { a: rng() < 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.1)' });
    }
  }
  // </solid-base>

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

  // 10A-2: Subtle weathered slab hairlines (no harsh dark X-seam trenches across narrow alley tiles).
  const joints = 2;
  for (let j = 0; j <= joints; j++) {
    const pos = (j / joints) * S;
    alb.fillStyle = 'rgba(8,10,14,0.14)';
    alb.fillRect(pos - 0.5, 0, 1, S);
    alb.fillRect(0, pos - 0.5, S, 1);
    hgt.fillStyle = grayCss(0.46);
    hgt.fillRect(pos - 0.5, 0, 1, S);
    hgt.fillRect(0, pos - 0.5, S, 1);
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
            ctx.strokeStyle = 'rgba(4,6,10,0.42)';
            ctx.lineWidth = 1.0;
          } else if (ctx === hgt) {
            ctx.strokeStyle = grayCss(0.32);
            ctx.lineWidth = 1.2;
          } else {
            ctx.strokeStyle = grayCss(0.54);
            ctx.lineWidth = 1.0;
          }
          ctx.stroke();
        }
      }
    }
  };
  for (let c = 0; c < 18; c++) drawCrack(rng() * S, rng() * S, 14 + Math.floor(rng() * 30), rng() * Math.PI * 2);

  // Re-flatten puddles over cracks (water fills them): restore puddle roughness (0.13) & flat height.
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
    normalMap: normalTextureFromHeight(hgt, S, S, 0.65, anisotropy),
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
        // 10A-2: Damp asphalt varies naturally in 0.36–0.48; puddles drop smoothly to 0.13 below.
        const dampRough = clamp(ROAD_WET_ROUGHNESS + (g - 0.5) * 0.14 + (speck - 0.5) * 0.04, 0.36, 0.48);
        const rv = Math.round(dampRough * 255);
        rghD.data[i] = rghD.data[i + 1] = rghD.data[i + 2] = rv;
        rghD.data[i + 3] = 255;
        const hv = Math.round(clamp(0.55 + (g - 0.5) * 0.22 + (speck - 0.5) * 0.1, 0, 1) * 255);
        hgtD.data[i] = hgtD.data[i + 1] = hgtD.data[i + 2] = hv;
        hgtD.data[i + 3] = 255;
      }
    }
  }
  alb.putImageData(albD, 0, 0);
  rgh.putImageData(rghD, 0, 0);
  hgt.putImageData(hgtD, 0, 0);

  // --- Paint helpers (wet road paint: dull, slightly raised, roughness 0.36) ---
  const WHITE = '#bfc5cc';
  const AMBER = '#c79a3c';
  const paint = (x: number, y: number, w: number, h: number, color: string): void => {
    alb.fillStyle = color;
    alb.fillRect(x, y, w, h);
    rgh.fillStyle = grayCss(0.36);
    rgh.fillRect(x, y, w, h);
    hgt.fillStyle = grayCss(0.64);
    hgt.fillRect(x, y, w, h);
  };
  const manhole = (cx: number, cy: number, rad: number): void => {
    alb.fillStyle = '#15181d';
    alb.beginPath();
    alb.arc(cx, cy, rad, 0, Math.PI * 2);
    alb.fill();
    rgh.fillStyle = grayCss(0.32);
    rgh.beginPath();
    rgh.arc(cx, cy, rad, 0, Math.PI * 2);
    rgh.fill();
    hgt.fillStyle = grayCss(0.5);
    hgt.beginPath();
    hgt.arc(cx, cy, rad, 0, Math.PI * 2);
    hgt.fill();
    hgt.strokeStyle = grayCss(0.28);
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
    hgt.strokeStyle = grayCss(0.74);
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
      alb.fillStyle = 'rgba(8,10,14,0.22)';
      alb.fillRect(xx, yy, pw, ph);
      hgt.strokeStyle = grayCss(0.47);
      hgt.lineWidth = 1;
      hgt.strokeRect(xx, yy, pw, ph);
    }
    for (let k = 0; k < 8; k++) {
      const g = alb.createRadialGradient(0, 0, 0, 0, 0, 1);
      g.addColorStop(0, 'rgba(10,8,18,0.45)');
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

  // --- Water over paint: re-apply puddles (darker albedo, 0.13 wet-puddle roughness, flat height) ---
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
  const normalMap = normalTextureFromHeight(hgt, S, S, 0.65, anisotropy);
  return { map, roughnessMap, normalMap };
}

// ---------------------------------------------------------------------------
// 4. Hologram neon sign atlas (1024², 8 vertical strips)
// ---------------------------------------------------------------------------
/** 7B-1: glow colour of each vertical blade strip (reflection lights on the wet street). */
export const NEON_STRIP_GLOW: readonly number[] = [0x00f0ff, 0xff2bd6, 0xffa21f, 0x38f8ff, 0xff2bd6, 0x00f0ff, 0xffa21f, 0xff2b6d];
const NEON_STRIPS: ReadonlyArray<{ text: string; color: string; glow: string }> = [
  { text: 'STRAND', color: '#7ff8ff', glow: '#00f0ff' },
  { text: 'NEON BAR', color: '#ff8ae8', glow: '#ff2bd6' },
  { text: 'NOODLE 24H', color: '#ffd28a', glow: '#ffa21f' },
  { text: 'STRAND//09', color: '#aefcff', glow: '#38f8ff' },
  { text: 'CYBERNETICS', color: '#ff9ef0', glow: '#ff2bd6' },
  { text: 'HOLO CAFE', color: '#9ffcff', glow: '#00f0ff' },
  { text: '▲ZONE-480▼', color: '#ffc96a', glow: '#ffa21f' },
  { text: 'ZERO-09', color: '#ff86b0', glow: '#ff2b6d' },
];

function generateNeonAtlas(anisotropy: number): THREE.Texture {
  const W = 1024;
  const H = 1024;
  const strips = NEON_STRIPS.length;
  const sw = W / strips;
  const [c, ctx] = makeCanvas(W, H);
  ctx.clearRect(0, 0, W, H);
  const font = SIGN_FONT;

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

    // Vertical stacked uppercase English: one glyph per row.
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
// 4c. Mega-Billboard hero-ad atlas (10B-2): 2048 × 1024, 4 × 2 cells, 100 % English
// ---------------------------------------------------------------------------

/**
 * 10C-2 vending atlas layout (512², origin top-left, 2 × 2 brand quadrants of 256²). Each quadrant holds a display
 * window (4 product rows between 3 shelf rails), the right-side control bezel (touchscreen · NFC ring · card slot)
 * and the top marquee. `*_UV` rects are quadrant-local (u, v from the quadrant's bottom-left, 0…0.5 scale).
 */
export const VENDING_ATLAS = {
  SIZE: 512,
  BRANDS: ['NI-COLA', 'SYNTH-CAF', 'K-BOOST', 'ZERO-H2O'] as readonly string[],
  /** Pixel regions inside a 256² quadrant: x, y (from the top), w, h. */
  DISPLAY: [0, 0, 176, 228] as readonly number[],
  CONTROL: [180, 0, 76, 228] as readonly number[],
  MARQUEE: [0, 232, 256, 24] as readonly number[],
} as const;

/**
 * 10D-3 street-landmark atlas (512 × 256, origin top-left, 100 % English). Top half (v 0.5…1): ramen-cart marquee
 * `SYNTH RAMEN // HOT NOODLES 24H` with a bowl emblem and `$6 · $9`. Bottom half (v 0…0.5): two 2:1 bus-shelter
 * lightbox cells — `NEO-KOWLOON METRO` map with glowing cyan / magenta / amber lines (u 0…0.5) and the `SECTOR
 * TRANSIT` departure board with `NEXT SHUTTLE: 02 MIN` (u 0.5…1).
 */
export const FURNISHINGS_ATLAS = {
  W: 512,
  H: 256,
  LABELS: ['SYNTH RAMEN', 'HOT NOODLES 24H', '$6 · $9', 'NEO-KOWLOON METRO', 'SECTOR TRANSIT', 'NEXT SHUTTLE: 02 MIN', 'S1', 'S2', 'S3', 'S4', 'S5', 'S2 CANAL', 'S3 CROSSING', 'S5 PLAZA', '06 MIN', '11 MIN', '18 MIN'] as readonly string[],
} as const;

function generateFurnishingsAtlas(anisotropy: number): THREE.Texture {
  const W = FURNISHINGS_ATLAS.W;
  const H = FURNISHINGS_ATLAS.H;
  const [c, ctx] = makeCanvas(W, H);
  const font = SIGN_FONT;
  // ---- Top half: ramen marquee (black = unlit).
  ctx.fillStyle = '#1a0604';
  ctx.fillRect(0, 0, W, H / 2);
  const g = ctx.createLinearGradient(0, 0, 0, H / 2);
  g.addColorStop(0, 'rgba(255,90,30,0.28)');
  g.addColorStop(1, 'rgba(120,10,0,0.05)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H / 2);
  ctx.strokeStyle = '#ffb040';
  ctx.lineWidth = 4;
  ctx.strokeRect(6, 6, W - 12, H / 2 - 12);
  // Bowl emblem: steaming bowl, chopsticks.
  ctx.save();
  ctx.translate(64, 66);
  ctx.fillStyle = '#ff5a28';
  ctx.beginPath();
  ctx.arc(0, 0, 34, 0, Math.PI);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#ffd890';
  ctx.fillRect(-40, -4, 80, 6);
  ctx.strokeStyle = '#fff0d0';
  ctx.lineWidth = 3;
  for (const dx of [-12, 0, 12]) {
    ctx.beginPath();
    ctx.moveTo(dx, -12);
    ctx.bezierCurveTo(dx + 8, -22, dx - 8, -30, dx, -42);
    ctx.stroke();
  }
  ctx.strokeStyle = '#c87a3a';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(18, -6);
  ctx.lineTo(44, -40);
  ctx.moveTo(26, -4);
  ctx.lineTo(50, -34);
  ctx.stroke();
  ctx.restore();
  ctx.textBaseline = 'middle';
  ctx.shadowColor = '#ff6a20';
  ctx.shadowBlur = 14;
  ctx.fillStyle = '#ffe8c0';
  ctx.font = `900 46px ${font}`;
  ctx.fillText('SYNTH RAMEN', 120, 44);
  ctx.shadowBlur = 8;
  ctx.fillStyle = '#ffb040';
  ctx.font = `700 22px ${font}`;
  ctx.fillText('// HOT NOODLES 24H', 122, 86);
  ctx.fillStyle = '#ff5a28';
  ctx.font = `800 26px ${font}`;
  ctx.fillText('$6 · $9', 400, 108);
  ctx.shadowBlur = 0;
  // ---- Bottom half: two 2:1 lightbox cells (each panel samples one cell undistorted).
  // Left cell (x 0–256): metro map. Right cell (x 256–512): shuttle departure board.
  const y0 = H / 2;
  ctx.fillStyle = '#04080e';
  ctx.fillRect(0, y0, W, H / 2);
  ctx.strokeStyle = 'rgba(80,140,180,0.16)';
  ctx.lineWidth = 1;
  for (let x = 0; x < 256; x += 16) {
    ctx.beginPath();
    ctx.moveTo(x, y0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }
  ctx.fillStyle = '#e0fbff';
  ctx.font = `800 15px ${font}`;
  ctx.fillText('NEO-KOWLOON METRO', 10, y0 + 14);
  const lines: ReadonlyArray<{ col: string; pts: ReadonlyArray<readonly [number, number]> }> = [
    { col: '#38f8ff', pts: [[16, 58], [70, 58], [96, 40], [166, 40], [190, 58], [240, 58]] },
    { col: '#ff2bd6', pts: [[20, 92], [60, 92], [86, 64], [130, 64], [156, 86], [236, 86]] },
    { col: '#ffa21f', pts: [[30, 40], [50, 72], [116, 72], [140, 50], [210, 50], [230, 100]] },
  ];
  ctx.shadowBlur = 8;
  for (const ln of lines) {
    ctx.shadowColor = ln.col;
    ctx.strokeStyle = ln.col;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ln.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y0 + y) : ctx.moveTo(x, y0 + y)));
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    for (const [x, y] of ln.pts) {
      ctx.beginPath();
      ctx.arc(x, y0 + y, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.shadowBlur = 0;
  ctx.font = `700 11px ${font}`;
  ctx.fillStyle = '#9fdcff';
  ['S1', 'S2', 'S3', 'S4', 'S5'].forEach((t, i) => ctx.fillText(t, 14 + i * 50, y0 + 116));
  // Right cell: departure board.
  ctx.fillStyle = '#060a10';
  ctx.fillRect(256, y0, 256, H / 2);
  ctx.strokeStyle = '#38f8ff';
  ctx.lineWidth = 2;
  ctx.strokeRect(260, y0 + 4, 248, H / 2 - 8);
  ctx.fillStyle = '#e0fbff';
  ctx.font = `800 17px ${font}`;
  ctx.fillText('SECTOR TRANSIT', 270, y0 + 22);
  ctx.fillStyle = '#ffd36a';
  ctx.font = `800 16px ${font}`;
  ctx.fillText('NEXT SHUTTLE: 02 MIN', 270, y0 + 48);
  ctx.font = `700 13px ${font}`;
  const rows = [['S2 CANAL', '06 MIN', '#ff2bd6'], ['S3 CROSSING', '11 MIN', '#ffa21f'], ['S5 PLAZA', '18 MIN', '#38f8ff']] as const;
  rows.forEach(([dst, eta, col], i) => {
    ctx.fillStyle = col;
    ctx.fillText(dst, 270, y0 + 74 + i * 18);
    ctx.fillStyle = '#e0fbff';
    ctx.fillText(eta, 440, y0 + 74 + i * 18);
  });
  const tex = finalizeTexture(c, THREE.SRGBColorSpace, anisotropy, false);
  tex.name = 'FurnishingsAtlas';
  return tex;
}

function generateVendingAtlas(anisotropy: number): THREE.Texture {
  const S = VENDING_ATLAS.SIZE;
  const Q = S / 2;
  const [c, ctx] = makeCanvas(S, S);
  const rng = createRng(0x10c2);
  const font = SIGN_FONT;
  ctx.fillStyle = '#05070b';
  ctx.fillRect(0, 0, S, S);
  /** Draws in a logical `lw × lh` space stretched into pixel region `r` of quadrant `q`. */
  const region = (q: number, r: readonly number[], lw: number, lh: number, draw: () => void): void => {
    const ox = (q % 2) * Q + r[0];
    const oy = Math.floor(q / 2) * Q + r[1];
    ctx.save();
    ctx.beginPath();
    ctx.rect(ox, oy, r[2], r[3]);
    ctx.clip();
    ctx.translate(ox, oy);
    ctx.scale(r[2] / lw, r[3] / lh);
    draw();
    ctx.restore();
  };
  const PAL: ReadonlyArray<{ bg: string; cans: string[]; accent: string; text: string; glow: string }> = [
    { bg: '#2a0a0e', cans: ['#d8202c', '#f2f2f2', '#9c1420', '#ff5a4a'], accent: '#ff3040', text: '#fff0f0', glow: '#ff2b3d' },
    { bg: '#1c1208', cans: ['#e09a22', '#2ab6d6', '#6a4a22', '#ffd070'], accent: '#ffb030', text: '#ffe8b8', glow: '#ffa21f' },
    { bg: '#0c1c0a', cans: ['#7bd62c', '#e8e22a', '#2a9a2a', '#c8ff60'], accent: '#a6ff3a', text: '#f0ffd0', glow: '#7cff2b' },
    { bg: '#071a24', cans: ['#2a8ae0', '#8ae8ff', '#e8f6ff', '#1a5aa8'], accent: '#38f8ff', text: '#e0fbff', glow: '#00f0ff' },
  ];
  const roundRect = (x: number, y: number, w: number, h: number, r: number): void => {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  };
  const PRICES = ['$1.50', '$2.20', '$2.50', '$3.20', '$1.80', '$2.80', '$3.50', '$1.20'];
  for (let q = 0; q < 4; q++) {
    const pal = PAL[q];
    // ---- Display window: backlit back plane, 4 product rows between shelf rails, price LEDs, condensation.
    region(q, VENDING_ATLAS.DISPLAY, 176, 283, () => {
      const g = ctx.createLinearGradient(0, 0, 0, 283);
      g.addColorStop(0, '#3a424e');
      g.addColorStop(1, '#232a34');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 176, 283);
      const rows = [[6, 79], [79, 149], [149, 218], [218, 281]];
      rows.forEach(([y0, y1], r) => {
        const h = y1 - y0;
        // Shelf glow strip + rail.
        ctx.fillStyle = 'rgba(255,255,255,0.1)';
        ctx.fillRect(0, y0, 176, h - 16);
        for (let k = 0; k < 4; k++) {
          const x = 8 + k * 42;
          const col = pal.cans[Math.floor(rng() * pal.cans.length)];
          const bottle = (k + r) % 3 === 1;
          const bh = h - 30;
          const top = y1 - 15 - bh;
          for (let n = 0; n < 2; n++) {
            const xx = x + n * 17;
            ctx.fillStyle = col;
            if (bottle) {
              roundRect(xx + 2, top + 12, 12, bh - 12, 4);
              ctx.fill();
              ctx.fillRect(xx + 5, top, 6, 14);
              ctx.fillStyle = pal.accent;
              ctx.fillRect(xx + 5, top - 2, 6, 3);
            } else {
              roundRect(xx, top + 6, 15, bh - 6, 3);
              ctx.fill();
              ctx.fillStyle = '#c8ccd2';
              ctx.fillRect(xx + 1, top + 3, 13, 4);
            }
            // Label band + specular highlight + condensation beads.
            ctx.fillStyle = 'rgba(255,255,255,0.78)';
            ctx.fillRect(xx + 1, top + bh * 0.45, 13, bh * 0.18);
            ctx.fillStyle = 'rgba(255,255,255,0.32)';
            ctx.fillRect(xx + 2, top + 8, 2, bh - 12);
            ctx.fillStyle = 'rgba(210,235,255,0.5)';
            for (let d = 0; d < 4; d++) ctx.fillRect(xx + 3 + rng() * 9, top + 10 + rng() * (bh - 16), 1.4, 1.4);
          }
          // Price-tag LED under each pair.
          ctx.fillStyle = '#05070a';
          ctx.fillRect(x - 1, y1 - 13, 36, 11);
          ctx.fillStyle = '#ff3a2a';
          ctx.font = `900 9px ${font}`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(PRICES[(q * 3 + r * 2 + k) % PRICES.length], x + 17, y1 - 7);
        }
        ctx.fillStyle = '#aeb6c2';
        ctx.fillRect(0, y1 - 2, 176, 3);
      });
    });
    // ---- Control bezel: touchscreen selection pad, NFC tap ring, card slot, status LEDs.
    region(q, VENDING_ATLAS.CONTROL, 76, 253, () => {
      ctx.fillStyle = '#10151c';
      ctx.fillRect(0, 0, 76, 253);
      // Touchscreen (glowing blue-cyan).
      ctx.fillStyle = '#05141c';
      ctx.fillRect(4, 6, 68, 104);
      ctx.fillStyle = pal.glow;
      ctx.globalAlpha = 0.55;
      ctx.fillRect(7, 9, 62, 98);
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#e8fbff';
      ctx.font = `900 9px ${font}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('SELECT', 38, 18);
      for (let r = 0; r < 4; r++) {
        for (let k = 0; k < 2; k++) {
          ctx.fillStyle = 'rgba(5,20,28,0.8)';
          ctx.fillRect(10 + k * 30, 28 + r * 19, 26, 15);
          ctx.fillStyle = '#e8fbff';
          ctx.font = `800 8px ${font}`;
          ctx.fillText(`${'ABCD'[r]}${k + 1}`, 23 + k * 30, 36 + r * 19);
        }
      }
      // NFC tap ring.
      ctx.strokeStyle = '#38f8ff';
      ctx.shadowColor = '#00f0ff';
      ctx.shadowBlur = 5;
      ctx.lineWidth = 3;
      for (const rr of [9, 16]) {
        ctx.beginPath();
        ctx.arc(38, 152, rr, -2.4, -0.74);
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#e8fbff';
      ctx.font = `900 8px ${font}`;
      ctx.fillText('TAP', 38, 152);
      ctx.fillText('NFC PAY', 38, 178);
      // Card slot + status LEDs.
      ctx.fillStyle = '#020305';
      ctx.fillRect(14, 218, 48, 7);
      ctx.fillStyle = '#39ff88';
      ctx.fillRect(10, 236, 6, 6);
      ctx.fillStyle = '#ffb030';
      ctx.fillRect(22, 236, 6, 6);
      ctx.fillStyle = '#ff3040';
      ctx.fillRect(34, 236, 6, 6);
    });
    // ---- Marquee: brand header banner.
    region(q, VENDING_ATLAS.MARQUEE, 256, 43, () => {
      const g = ctx.createLinearGradient(0, 0, 0, 43);
      g.addColorStop(0, pal.bg);
      g.addColorStop(1, '#000');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 256, 43);
      ctx.strokeStyle = pal.accent;
      ctx.lineWidth = 3;
      ctx.strokeRect(3, 3, 250, 37);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `900 24px ${font}`;
      ctx.shadowColor = pal.glow;
      ctx.shadowBlur = 10;
      ctx.fillStyle = pal.text;
      ctx.fillText(VENDING_ATLAS.BRANDS[q], 128, 23);
      ctx.shadowBlur = 0;
    });
  }
  const tex = finalizeTexture(c, THREE.SRGBColorSpace, anisotropy, false);
  tex.premultiplyAlpha = false;
  return tex;
}

function generateMegaBillboardAtlas(anisotropy: number): THREE.Texture {
  const { W, H } = MEGA_ATLAS;
  const C = 512;
  const [c, ctx] = makeCanvas(W, H);
  const rng = createRng(0x10b2);
  const font = SIGN_FONT;
  /** Draws cell `i` in a virtual C × (C / aspect) space (squashed back into the 512² cell). */
  const cell = (i: number, draw: (w: number, h: number) => void): void => {
    const ox = (i % 4) * C;
    const oy = Math.floor(i / 4) * C;
    const k = 1 / MEGA_ATLAS.ASPECT[i];
    ctx.save();
    ctx.beginPath();
    ctx.rect(ox, oy, C, C);
    ctx.clip();
    ctx.translate(ox, oy);
    ctx.scale(1, 1 / k);
    draw(C, C * k);
    ctx.restore();
  };
  const grad = (w: number, h: number, c0: string, c1: string): void => {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, c0);
    g.addColorStop(1, c1);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  };
  const fit = (text: string, maxW: number, size: number, weight = 900): number => {
    let sz = size;
    ctx.font = `${weight} ${sz}px ${font}`;
    while (ctx.measureText(text).width > maxW && sz > 8) {
      sz -= 2;
      ctx.font = `${weight} ${sz}px ${font}`;
    }
    return sz;
  };
  const glow = (text: string, x: number, y: number, maxW: number, size: number, color: string, glowC: string, weight = 900, blur = 22): void => {
    fit(text, maxW, size, weight);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.save();
    ctx.shadowColor = glowC;
    ctx.shadowBlur = blur;
    ctx.fillStyle = glowC;
    ctx.fillText(text, x, y);
    ctx.shadowBlur = blur * 0.3;
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
    ctx.restore();
  };
  const bezel = (w: number, h: number, col: string): void => {
    ctx.save();
    ctx.strokeStyle = col;
    ctx.shadowColor = col;
    ctx.shadowBlur = 12;
    ctx.lineWidth = 5;
    ctx.strokeRect(10, 10, w - 20, h - 20);
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.5;
    ctx.strokeRect(22, 22, w - 44, h - 44);
    ctx.restore();
  };
  const line = (pts: Array<[number, number]>, col: string, lw: number, alpha = 1): void => {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = col;
    ctx.lineWidth = lw;
    ctx.beginPath();
    pts.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
    ctx.restore();
  };

  // 0 NEO-TOKYO REALTY — cyan / white corporate typography over a blueprint wireframe.
  cell(0, (w, h) => {
    grad(w, h, '#03132c', '#08294c');
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = '#5fe8ff';
    for (let x = 0; x < w; x += 32) ctx.fillRect(x, 0, 1, h);
    for (let y = 0; y < h; y += 32) ctx.fillRect(0, y, w, 1);
    ctx.globalAlpha = 1;
    const tower = (x: number, base: number, tw: number, th: number): void => {
      const d = tw * 0.45;
      line([[x, base], [x, base - th], [x + tw, base - th], [x + tw, base], [x, base]], '#7ff8ff', 2.5, 0.8);
      line([[x, base - th], [x + d, base - th - d * 0.5], [x + tw + d, base - th - d * 0.5], [x + tw, base - th]], '#7ff8ff', 2, 0.6);
      line([[x + tw, base], [x + tw + d, base - d * 0.5], [x + tw + d, base - th - d * 0.5]], '#7ff8ff', 2, 0.6);
      for (let y = base - 14; y > base - th; y -= 14) line([[x + 4, y], [x + tw - 4, y]], '#38f8ff', 1, 0.35);
    };
    tower(118, 196, 52, 150);
    tower(210, 196, 70, 176);
    tower(320, 196, 48, 120);
    line([[60, 198], [452, 198]], '#aefcff', 3, 0.9);
    glow('NEO-TOKYO', w / 2, 262, w - 64, 92, '#ffffff', '#00f0ff');
    glow('REALTY', w / 2, 340, w - 120, 74, '#e8fdff', '#38f8ff');
    glow('SKY RESIDENCES // FROM 480K', w / 2, 404, w - 80, 26, '#aefcff', '#00f0ff', 700, 10);
    ctx.fillStyle = 'rgba(0,240,255,0.85)';
    ctx.fillRect(64, 446, w - 128, 34);
    glow('LEASING NOW ▶ LEVEL 88', w / 2, 464, w - 150, 22, '#03132c', '#03132c', 900, 0);
    bezel(w, h, '#38f8ff');
  });

  // 1 DATA FLOW // 09 — magenta / violet diagonal tech bars + cascading code.
  cell(1, (w, h) => {
    grad(w, h, '#12021e', '#2c0644');
    ctx.font = `700 15px ${font}`;
    ctx.textAlign = 'left';
    for (let x = 14; x < w; x += 22) {
      for (let y = 16; y < h; y += 19) {
        ctx.globalAlpha = 0.12 + rng() * 0.35;
        ctx.fillStyle = rng() < 0.15 ? '#ffffff' : '#ff4fd8';
        ctx.fillText('0123456789ABCDEF'[Math.floor(rng() * 16)], x, y);
      }
    }
    ctx.globalAlpha = 1;
    for (let k = 0; k < 6; k++) {
      ctx.save();
      ctx.globalAlpha = 0.28 + 0.1 * (k % 3);
      ctx.fillStyle = k % 2 ? '#b44bff' : '#ff2bd6';
      ctx.beginPath();
      const x0 = -120 + k * 110;
      ctx.moveTo(x0, h);
      ctx.lineTo(x0 + 46, h);
      ctx.lineTo(x0 + 46 + 300, 0);
      ctx.lineTo(x0 + 300, 0);
      ctx.fill();
      ctx.restore();
    }
    ctx.fillStyle = 'rgba(10,0,20,0.72)';
    ctx.fillRect(30, 190, w - 60, 150);
    glow('DATA FLOW', w / 2, 248, w - 80, 96, '#ffffff', '#ff2bd6');
    glow('// 09', w / 2, 314, w - 200, 54, '#ffb8f4', '#d040ff');
    for (let k = 0; k < 18; k++) {
      const bh = 12 + rng() * 60;
      ctx.fillStyle = k % 3 ? '#ff2bd6' : '#ffffff';
      ctx.globalAlpha = 0.75;
      ctx.fillRect(48 + k * 23, 470 - bh, 14, bh);
    }
    ctx.globalAlpha = 1;
    glow('STREAM 480 TB/S', w / 2, 120, w - 120, 30, '#ffd6fa', '#ff2bd6', 800, 10);
    bezel(w, h, '#d040ff');
  });

  // 2 CYBERNETICS NOW — acid-lime / yellow stencil + bionic eye / circuit emblem.
  cell(2, (w, h) => {
    grad(w, h, '#090e02', '#1c2806');
    const ex = w / 2;
    const ey = 128;
    ctx.save();
    ctx.shadowColor = '#c8ff2e';
    ctx.shadowBlur = 18;
    ctx.strokeStyle = '#c8ff2e';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(ex - 150, ey);
    ctx.quadraticCurveTo(ex, ey - 96, ex + 150, ey);
    ctx.quadraticCurveTo(ex, ey + 96, ex - 150, ey);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(ex, ey, 42, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#f4ff6a';
    ctx.beginPath();
    ctx.arc(ex, ey, 16, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    for (const [sx, dy] of [[-1, -1], [1, 1], [-1, 1], [1, -1]] as const) {
      line([[ex + sx * 160, ey + dy * 8], [ex + sx * 200, ey + dy * 8], [ex + sx * 220, ey + dy * 40], [ex + sx * 236, ey + dy * 40]], '#c8ff2e', 3, 0.85);
      ctx.fillStyle = '#c8ff2e';
      ctx.fillRect(ex + sx * 236 - 5, ey + dy * 40 - 5, 10, 10);
    }
    glow('CYBERNETICS', w / 2, 270, w - 50, 80, '#f4ff6a', '#c8ff2e');
    glow('NOW', w / 2, 352, w - 200, 96, '#ffffff', '#c8ff2e');
    glow('UPGRADE YOUR CHROME', w / 2, 418, w - 90, 28, '#e8ff9a', '#9fdc00', 800, 8);
    ctx.save();
    ctx.beginPath();
    ctx.rect(24, 450, w - 48, 36);
    ctx.clip();
    for (let x = -40; x < w; x += 36) {
      ctx.fillStyle = '#e8ff2e';
      ctx.beginPath();
      ctx.moveTo(x, 486);
      ctx.lineTo(x + 18, 486);
      ctx.lineTo(x + 54, 450);
      ctx.lineTo(x + 36, 450);
      ctx.fill();
    }
    ctx.restore();
    bezel(w, h, '#c8ff2e');
  });

  // 3 BELOW DECK — tall 1:3 portrait: glowing halftone face silhouette in coral / magenta / gold.
  cell(3, (w, h) => {
    grad(w, h, '#1c0514', '#3c0a26');
    const inHead = (x: number, y: number): number => {
      // Profile facing left: skull ellipse, nose / lips / chin bumps, neck.
      const hx = (x - 270) / 170;
      const hy = (y - 470) / 260;
      let d = hx * hx + hy * hy;
      if (y > 520 && y < 720 && x > 150 && x < 300) d = Math.min(d, ((x - 205) / 70) ** 2 + ((y - 640) / 110) ** 2);
      if (y > 700 && y < 930 && x > 230 && x < 360) d = Math.min(d, 0.6);
      return d;
    };
    const sp = 18;
    for (let y = 120; y < 960; y += sp) {
      for (let x = 40; x < w - 30; x += sp) {
        const d = inHead(x, y);
        if (d > 1.05) continue;
        const shade = 1 - Math.min(1, Math.max(0, (x - 120) / 330 + (y - 250) / 1400));
        const r = (sp * 0.5) * (0.25 + 0.75 * shade) * (d > 0.85 ? 0.6 : 1);
        ctx.fillStyle = y < 420 ? '#ff6f8f' : y < 700 ? '#ff2bd6' : '#ffb347';
        ctx.globalAlpha = 0.9;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    line([[60, 990], [w - 60, 990]], '#ffb347', 6);
    glow('BELOW', w / 2, 1090, w - 50, 150, '#ffe0c0', '#ff6f5e');
    glow('DECK', w / 2, 1240, w - 70, 160, '#ffffff', '#ff2bd6');
    glow('CLUB // LEVEL -3', w / 2, 1348, w - 60, 44, '#ffd28a', '#ffa21f', 800, 12);
    glow('OPEN TILL DAWN', w / 2, 1430, w - 90, 40, '#ffc2e4', '#ff2bd6', 800, 12);
    bezel(w, h, '#ff6f8f');
  });

  // 4 Crimson vertical monolith (1:6): hexagon sigil + stacked bold column STRAND // RESTRICTED ZONE 09.
  cell(4, (w, h) => {
    grad(w, h, '#140208', '#2c0610');
    const cx = w / 2;
    const hex = (r: number, lw: number): void => {
      ctx.lineWidth = lw;
      ctx.beginPath();
      for (let k = 0; k <= 6; k++) {
        const a = Math.PI / 6 + (k / 6) * Math.PI * 2;
        if (k) ctx.lineTo(cx + Math.cos(a) * r, 300 + Math.sin(a) * r);
        else ctx.moveTo(cx + Math.cos(a) * r, 300 + Math.sin(a) * r);
      }
      ctx.stroke();
    };
    ctx.save();
    ctx.strokeStyle = '#ff2b4a';
    ctx.shadowColor = '#ff1f3d';
    ctx.shadowBlur = 30;
    hex(200, 16);
    hex(128, 10);
    ctx.beginPath();
    ctx.moveTo(cx, 210);
    ctx.lineTo(cx + 80, 350);
    ctx.lineTo(cx - 80, 350);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
    const letters = Array.from('STRAND');
    letters.forEach((ch, k) => glow(ch, cx, 700 + k * 300, w - 60, 300, '#ffffff', '#ff1f3d', 900, 34));
    line([[80, 2500], [w - 80, 2500]], '#ff2b4a', 10);
    glow('ZONE', cx, 2640, w - 60, 170, '#ffd0d6', '#ff1f3d');
    glow('09', cx, 2860, w - 120, 230, '#ffffff', '#ff1f3d');
    ctx.save();
    ctx.translate(46, h / 2);
    ctx.rotate(-Math.PI / 2);
    glow('◆ RESTRICTED ZONE 09 ◆ RESTRICTED ZONE 09 ◆', 0, 0, h - 120, 44, '#ff8a9a', '#ff1f3d', 800, 10);
    ctx.restore();
    ctx.save();
    ctx.translate(w - 46, h / 2);
    ctx.rotate(Math.PI / 2);
    glow('◆ STRAND // RESTRICTED ZONE 09 ◆', 0, 0, h - 120, 44, '#ff8a9a', '#ff1f3d', 800, 10);
    ctx.restore();
    bezel(w, h, '#ff1f3d');
  });

  // 5 KIROSHI // OPTICS — teal / cyan reticle emblem + SEE THE FUTURE.
  cell(5, (w, h) => {
    grad(w, h, '#011414', '#043232');
    const cx = w / 2;
    const cy = 132;
    ctx.save();
    ctx.strokeStyle = '#19e6e6';
    ctx.shadowColor = '#19e6e6';
    ctx.shadowBlur = 18;
    ctx.lineWidth = 6;
    for (const r of [92, 58]) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * 66, cy + Math.sin(a) * 66);
      ctx.lineTo(cx + Math.cos(a) * 120, cy + Math.sin(a) * 120);
      ctx.stroke();
    }
    ctx.fillStyle = '#aefcff';
    ctx.beginPath();
    ctx.moveTo(cx, cy - 20);
    ctx.lineTo(cx + 20, cy);
    ctx.lineTo(cx, cy + 20);
    ctx.lineTo(cx - 20, cy);
    ctx.fill();
    ctx.restore();
    glow('KIROSHI', w / 2, 284, w - 60, 100, '#ffffff', '#19e6e6');
    glow('// OPTICS', w / 2, 352, w - 160, 50, '#aefcff', '#00c8c8');
    glow('SEE THE FUTURE', w / 2, 420, w - 100, 36, '#e0ffff', '#19e6e6', 800, 10);
    line([[60, 462], [w - 60, 462]], '#19e6e6', 3, 0.8);
    bezel(w, h, '#19e6e6');
  });

  // 6 SYNTH NOODLES // 24H — warm amber neon ramen bowl.
  cell(6, (w, h) => {
    grad(w, h, '#1a0702', '#3c1404');
    const cx = w / 2;
    ctx.save();
    ctx.strokeStyle = '#ffa21f';
    ctx.shadowColor = '#ff8a00';
    ctx.shadowBlur = 20;
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(cx - 130, 150);
    ctx.lineTo(cx + 130, 150);
    ctx.arc(cx, 150, 130, 0, Math.PI);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + 40, 160);
    ctx.lineTo(cx + 170, 60);
    ctx.moveTo(cx + 62, 166);
    ctx.lineTo(cx + 196, 72);
    ctx.stroke();
    ctx.lineWidth = 4;
    for (const dx of [-60, 0, 60]) {
      ctx.beginPath();
      for (let k = 0; k <= 16; k++) {
        const y = 128 - k * 6;
        const x = cx + dx + Math.sin(k * 0.8) * 10;
        if (k) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      }
      ctx.stroke();
    }
    ctx.restore();
    glow('SYNTH NOODLES', w / 2, 330, w - 50, 70, '#ffe2b0', '#ffa21f');
    glow('24H', w / 2, 404, w - 200, 74, '#ffffff', '#ff7a00');
    glow('HOT ▶ FAST ▶ CHEAP', w / 2, 462, w - 100, 30, '#ffd28a', '#ffa21f', 800, 8);
    bezel(w, h, '#ffa21f');
  });

  // 7 SOFTSYS // CORE — deep electric-blue isometric server wireframe + telemetry.
  cell(7, (w, h) => {
    grad(w, h, '#020718', '#061a4c');
    const iso = (x: number, y: number, bw: number, bh: number): void => {
      const d = bw * 0.5;
      line([[x, y], [x + bw, y - d * 0.5], [x + bw + d, y], [x + d, y + d * 0.5], [x, y]], '#4f9bff', 2.5, 0.9);
      line([[x, y], [x, y + bh], [x + d, y + bh + d * 0.5], [x + bw + d, y + bh], [x + bw + d, y]], '#2f7bff', 2.5, 0.9);
      line([[x + d, y + d * 0.5], [x + d, y + bh + d * 0.5]], '#2f7bff', 2.5, 0.9);
      for (let k = 1; k < 4; k++) line([[x + 4, y + (bh * k) / 4], [x + d - 4, y + (bh * k) / 4 + d * 0.5 - 4]], '#9cc4ff', 1.5, 0.7);
    };
    iso(120, 70, 90, 120);
    iso(250, 50, 90, 140);
    glow('SOFTSYS', w / 2, 280, w - 60, 100, '#ffffff', '#2f7bff');
    glow('// CORE', w / 2, 348, w - 180, 52, '#b8d4ff', '#2f7bff');
    const pts: Array<[number, number]> = [];
    for (let x = 48; x <= w - 48; x += 12) pts.push([x, 440 - 18 * Math.sin(x * 0.05) - rng() * 16]);
    line(pts, '#7fb6ff', 3, 0.95);
    glow('UPTIME 99.999%  ▲ LOAD 72%', w / 2, 480, w - 80, 22, '#cfe2ff', '#2f7bff', 700, 6);
    bezel(w, h, '#2f7bff');
  });

  const tex = finalizeTexture(c, THREE.SRGBColorSpace, anisotropy, false);
  return tex;
}

// ---------------------------------------------------------------------------
// 4b. Sign atlas (5B-3): wide banners + scrolling tickers (top) and emblems (bottom), 1024²
// ---------------------------------------------------------------------------
const WIDE_SIGNS: ReadonlyArray<{ text: string; color: string; glow: string }> = [
  { text: 'CYBER RAMEN', color: '#ffd28a', glow: '#ffa21f' },
  { text: 'OMEGA//CORP — STRAND SYSTEMS', color: '#aefcff', glow: '#00f0ff' },
  { text: 'MOTEL 09', color: '#9dffc8', glow: '#39ff88' },
  { text: 'HOTEL KOWLOON // VACANCY', color: '#ff9ef0', glow: '#ff2bd6' },
  { text: 'NIGHT BAR', color: '#d6a8ff', glow: '#b44bff' },
  { text: 'OPEN 24H', color: '#7ff8ff', glow: '#38f8ff' },
  { text: '▶ SECTOR LOCKDOWN ▶ STAY INDOORS ▶ CURFEW 23:00 ', color: '#ffc96a', glow: '#ffa21f' },
  { text: '◆ VALKYRIE-09 SIGHTED ◆ NEON CITY ALERT ◆ GRID 480 ', color: '#ff86b0', glow: '#ff2b6d' },
];

function generateSignAtlas(anisotropy: number): THREE.Texture {
  const W = 1024;
  const H = 1024;
  const RH = 64;
  const [c, ctx] = makeCanvas(W, H);
  ctx.clearRect(0, 0, W, H);
  const font = SIGN_FONT;
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
    // 10C-3: scaffold words are free-standing tube letters (no panel, no frame), spaced across the whole banner.
    const word = (Object.values(SIGN_ATLAS.WORD_ROWS) as number[]).includes(r);
    if (!word) {
      ctx.fillStyle = scroll ? 'rgba(4,6,12,0.82)' : 'rgba(8,10,18,0.6)';
      ctx.fillRect(2, y0 + 3, W - 4, RH - 6);
    }
    ctx.textBaseline = 'middle';
    if (word) {
      const chars = Array.from(def.text);
      const step = Math.min((W * 0.92) / chars.length, RH * 2.2);
      const x0 = W / 2 - (step * (chars.length - 1)) / 2;
      ctx.font = `900 ${RH * 0.8}px ${font}`;
      chars.forEach((ch, k) => {
        if (ch !== ' ') glowText(ch, x0 + k * step, y0 + RH / 2 + 2, def.color, def.glow, 'center');
      });
    } else if (scroll) {
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
  // 6 '09' district seal
  emblem(6, (cx, cy, r) => {
    ctx.strokeRect(cx - r, cy - r, r * 2, r * 2);
    ctx.strokeRect(cx - r * 0.82, cy - r * 0.82, r * 1.64, r * 1.64);
    ctx.font = `900 ${Math.floor(r * 1.15)}px ${font}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('09', cx, cy + 4);
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
// 9A-5 Weathered paint / stained concrete detail (512²): vertical rain streaks, paint scuffs, stain mottling and
// edge wear. Map is neutral grey 0.78–1.05 (×2 headroom via the material colour), roughness 0.28–0.78.
// ---------------------------------------------------------------------------
function generateArchDetailSet(anisotropy: number): PbrTextureSet {
  const S = 512;
  const [albC, alb] = makeCanvas(S, S);
  const [rghC, rgh] = makeCanvas(S, S);
  const [, hgt] = makeCanvas(S, S);
  const rng = createRng(0xa9c4d);
  const noises = [8, 16, 32, 64].map((p) => new TileableValueNoise(p, rng));
  const img = alb.createImageData(S, S);
  const rimg = rgh.createImageData(S, S);
  const himg = hgt.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const v = y / S;
      const m = fbm(noises, 1, u, v);
      const fine = fbm(noises.slice(2), 1, u * 2, v * 2);
      // Albedo stays in a narrow neutral band (0.78–1.05 relative) so vertex tints carry the colour.
      const a = 0.8 + 0.12 * m + 0.05 * fine;
      const i = (y * S + x) * 4;
      const g8 = Math.round(Math.min(1, a / 1.06) * 235);
      img.data[i] = g8;
      img.data[i + 1] = g8;
      img.data[i + 2] = g8;
      img.data[i + 3] = 255;
      const r8 = Math.round((0.42 + 0.3 * m) * 255);
      rimg.data[i] = r8;
      rimg.data[i + 1] = r8;
      rimg.data[i + 2] = r8;
      rimg.data[i + 3] = 255;
      const h8 = Math.round((0.5 + 0.12 * fine) * 255);
      himg.data[i] = h8;
      himg.data[i + 1] = h8;
      himg.data[i + 2] = h8;
      himg.data[i + 3] = 255;
    }
  }
  alb.putImageData(img, 0, 0);
  rgh.putImageData(rimg, 0, 0);
  hgt.putImageData(himg, 0, 0);
  // Vertical rain streaks (darker, slightly glossier where water runs).
  for (let k = 0; k < 220; k++) {
    const x = rng() * S;
    const y = rng() * S * 0.6;
    const len = 40 + rng() * 220;
    const w = 1 + rng() * 3;
    const grad = alb.createLinearGradient(0, y, 0, y + len);
    grad.addColorStop(0, 'rgba(30,32,36,0.22)');
    grad.addColorStop(1, 'rgba(30,32,36,0)');
    alb.fillStyle = grad;
    alb.fillRect(x, y, w, len);
    rgh.fillStyle = 'rgba(70,70,70,0.25)';
    rgh.fillRect(x, y, w, len * 0.7);
  }
  // Paint scuff scratches (bright, rough) and chipped edge wear.
  for (let k = 0; k < 360; k++) {
    const x = rng() * S;
    const y = rng() * S;
    const ang = (rng() - 0.5) * 0.9;
    const len = 6 + rng() * 34;
    alb.strokeStyle = `rgba(250,250,250,${0.08 + rng() * 0.14})`;
    alb.lineWidth = 0.6 + rng() * 1.2;
    alb.beginPath();
    alb.moveTo(x, y);
    alb.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    alb.stroke();
    rgh.strokeStyle = 'rgba(200,200,200,0.35)';
    rgh.lineWidth = 1;
    rgh.beginPath();
    rgh.moveTo(x, y);
    rgh.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    rgh.stroke();
    hgt.strokeStyle = 'rgba(40,40,40,0.5)';
    hgt.beginPath();
    hgt.moveTo(x, y);
    hgt.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    hgt.stroke();
  }
  // Stain blotches (rust / grime mottling).
  for (let k = 0; k < 70; k++) {
    const x = rng() * S;
    const y = rng() * S;
    const r = 8 + rng() * 40;
    const grad = alb.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(${40 + Math.round(rng() * 30)},${34 + Math.round(rng() * 16)},30,0.22)`);
    grad.addColorStop(1, 'rgba(40,36,30,0)');
    alb.fillStyle = grad;
    alb.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // Fine pitting in the height field.
  for (let k = 0; k < 2600; k++) {
    hgt.fillStyle = `rgba(30,30,30,${0.2 + rng() * 0.3})`;
    hgt.fillRect(rng() * S, rng() * S, 1 + rng(), 1 + rng());
  }
  return {
    map: finalizeTexture(albC, THREE.SRGBColorSpace, anisotropy),
    roughnessMap: finalizeTexture(rghC, THREE.NoColorSpace, anisotropy),
    normalMap: normalTextureFromHeight(hgt, S, S, 1.6, anisotropy),
  };
}

// ---------------------------------------------------------------------------
// 9A-6 Cast-iron manhole (256²): bevelled frame ring, raised diamond tread, recessed vent slots; the emissive mask
// is white only inside the slots (tinted amber / cyan per instance in the shader).
// ---------------------------------------------------------------------------
function generateManholeSet(anisotropy: number): Required<PbrTextureSet> {
  const S = 256;
  const [albC, alb] = makeCanvas(S, S);
  const [rghC, rgh] = makeCanvas(S, S);
  const [emC, em] = makeCanvas(S, S);
  const [, hgt] = makeCanvas(S, S);
  const c = S / 2;
  const rng = createRng(0x3a401e);
  alb.fillStyle = '#101113';
  alb.fillRect(0, 0, S, S);
  rgh.fillStyle = grayCss(0.5);
  rgh.fillRect(0, 0, S, S);
  hgt.fillStyle = grayCss(0.5);
  hgt.fillRect(0, 0, S, S);
  em.fillStyle = '#000';
  em.fillRect(0, 0, S, S);
  const disc = (ctx: CanvasRenderingContext2D, r: number, style: string): void => {
    ctx.fillStyle = style;
    ctx.beginPath();
    ctx.arc(c, c, r, 0, Math.PI * 2);
    ctx.fill();
  };
  // Frame ring (worn, glossy) and the lid.
  disc(alb, 126, '#3a3b3e');
  disc(alb, 112, '#24262a');
  disc(hgt, 126, grayCss(0.7));
  disc(hgt, 114, grayCss(0.42));
  disc(hgt, 110, grayCss(0.6));
  disc(rgh, 126, grayCss(0.26));
  disc(rgh, 112, grayCss(0.44));
  // Diamond tread.
  for (let y = 24; y < S - 24; y += 12) {
    for (let x = 24 + ((y / 12) % 2) * 6; x < S - 24; x += 12) {
      if (Math.hypot(x - c, y - c) > 100) continue;
      hgt.fillStyle = grayCss(0.72);
      hgt.beginPath();
      hgt.moveTo(x, y - 3.5);
      hgt.lineTo(x + 3.5, y);
      hgt.lineTo(x, y + 3.5);
      hgt.lineTo(x - 3.5, y);
      hgt.fill();
      alb.fillStyle = 'rgba(80,82,86,0.6)';
      alb.fillRect(x - 1, y - 1, 2, 2);
    }
  }
  // Two rows of recessed vent slots (the subterranean glow leaks through).
  for (const off of [-34, 34]) {
    for (let k = -3; k <= 3; k++) {
      const x = c + k * 13 - 3;
      const y = c + off - 12;
      alb.fillStyle = '#050505';
      alb.fillRect(x, y, 6, 24);
      hgt.fillStyle = grayCss(0.12);
      hgt.fillRect(x, y, 6, 24);
      em.fillStyle = `rgba(255,255,255,${0.75 + rng() * 0.25})`;
      em.fillRect(x + 1, y + 1, 4, 22);
    }
  }
  // Central maker disc + rust freckles.
  disc(alb, 18, '#2c2d30');
  for (let k = 0; k < 220; k++) {
    const a = rng() * Math.PI * 2;
    const r = rng() * 112;
    alb.fillStyle = `rgba(${70 + Math.round(rng() * 40)},${40 + Math.round(rng() * 20)},24,${0.15 + rng() * 0.25})`;
    alb.fillRect(c + Math.cos(a) * r, c + Math.sin(a) * r, 1 + rng() * 2, 1 + rng() * 2);
  }
  return {
    map: finalizeTexture(albC, THREE.SRGBColorSpace, anisotropy, false),
    roughnessMap: finalizeTexture(rghC, THREE.NoColorSpace, anisotropy, false),
    normalMap: normalTextureFromHeight(hgt, S, S, 3.0, anisotropy),
    emissiveMap: finalizeTexture(emC, THREE.SRGBColorSpace, anisotropy, false),
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
// 9B-1 Room-number plaque atlas (512 × 256, 4 × 4 cells of 128 × 64): crisp backlit digits on black (the plaque
// shader uses the texture as an emissive mask; the anodised housing colour comes from the kit).
// ---------------------------------------------------------------------------
function generatePlaqueAtlas(anisotropy: number): THREE.Texture {
  const W = 512;
  const H = 256;
  const cw = W / 4;
  const ch = H / 4;
  const [c, ctx] = makeCanvas(W, H);
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, W, H);
  const accents = ['#ffb347', '#4fd8ff', '#ff4f8a', '#9dff6a'];
  PLAQUE_LABELS.forEach((label, i) => {
    const x0 = (i % 4) * cw;
    const y0 = Math.floor(i / 4) * ch;
    // Faint backlight bleed behind the digits.
    const g = ctx.createLinearGradient(x0, y0, x0, y0 + ch);
    g.addColorStop(0, 'rgba(40,60,80,0.10)');
    g.addColorStop(1, 'rgba(20,30,40,0.04)');
    ctx.fillStyle = g;
    ctx.fillRect(x0 + 6, y0 + 6, cw - 12, ch - 12);
    // Thin accent rule + crisp condensed digits.
    ctx.fillStyle = accents[i % accents.length];
    ctx.fillRect(x0 + 12, y0 + ch - 14, 22, 3);
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = "700 30px 'DejaVu Sans Mono','Consolas','Menlo',monospace";
    ctx.shadowColor = 'rgba(160,220,255,0.85)';
    ctx.shadowBlur = 6;
    ctx.fillStyle = '#eaf6ff';
    ctx.fillText(label, x0 + cw / 2, y0 + ch / 2 - 3, cw - 20);
    ctx.restore();
  });
  const tex = finalizeTexture(c, THREE.SRGBColorSpace, anisotropy, false);
  return tex;
}

// ---------------------------------------------------------------------------
// 9B-3 Graffiti / torn-poster atlas (1024 × 512, 4 × 2 alpha-masked cells of 256²).
//   0 STRAND wild tag · 1 NO SIGNAL glitch stencil · 2 ZERO / 09 bubble letters · 3 glitch skull stencil
//   4 rain-stained flyer collage · 5 torn NEO tag promo · 6 RESTRICTED caution stencil · 7 HIGH VOLTAGE / SECTOR 04
// ---------------------------------------------------------------------------
function generateGraffitiAtlas(anisotropy: number): THREE.Texture {
  const W = 1024;
  const H = 512;
  const S = 256;
  const [c, ctx] = makeCanvas(W, H);
  ctx.clearRect(0, 0, W, H);
  const rng = createRng(0x9b3);
  const font = "'Arial Black','Impact','Helvetica Neue',sans-serif";
  const cell = (i: number, draw: (ox: number, oy: number) => void): void => {
    const ox = (i % 4) * S;
    const oy = Math.floor(i / 4) * S;
    ctx.save();
    ctx.beginPath();
    ctx.rect(ox + 8, oy + 8, S - 16, S - 16);
    ctx.clip();
    draw(ox, oy);
    ctx.restore();
  };
  /** Soft overspray halo + core stroke + paint drips under the glyphs. */
  const spray = (text: string, x: number, y: number, size: number, fill: string, edge: string, rot: number, family = font): void => {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 ${size}px ${family}`;
    ctx.shadowColor = edge;
    ctx.shadowBlur = size * 0.35;
    ctx.lineJoin = 'round';
    ctx.lineWidth = size * 0.16;
    ctx.strokeStyle = edge;
    ctx.strokeText(text, 0, 0);
    ctx.shadowBlur = size * 0.08;
    ctx.fillStyle = fill;
    ctx.fillText(text, 0, 0);
    ctx.restore();
    // Drips.
    const tw = Math.min(size * text.length * 0.62, S - 40);
    for (let k = 0; k < 4 + Math.floor(rng() * 4); k++) {
      const dx = x - tw / 2 + rng() * tw;
      const len = 10 + rng() * 46;
      ctx.strokeStyle = rng() < 0.5 ? fill : edge;
      ctx.globalAlpha = 0.75;
      ctx.lineWidth = 2 + rng() * 3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(dx, y + size * 0.3);
      ctx.lineTo(dx + (rng() - 0.5) * 2, y + size * 0.3 + len);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  };
  const speckle = (ox: number, oy: number, col: string, n: number): void => {
    ctx.fillStyle = col;
    for (let k = 0; k < n; k++) {
      ctx.globalAlpha = 0.25 + rng() * 0.5;
      ctx.beginPath();
      ctx.arc(ox + 12 + rng() * (S - 24), oy + 12 + rng() * (S - 24), 0.6 + rng() * 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  };
  /** Torn paper sheet: jagged polygon with a ripped corner. */
  const sheet = (x: number, y: number, w: number, h: number, col: string, rot: number, tearCorner: number): void => {
    ctx.save();
    ctx.translate(x + w / 2, y + h / 2);
    ctx.rotate(rot);
    ctx.beginPath();
    const pts: Array<[number, number]> = [];
    const edge = (ax: number, ay: number, bx: number, by: number, rough: number): void => {
      const n = 10;
      for (let k = 0; k < n; k++) {
        const t = k / n;
        pts.push([ax + (bx - ax) * t + (rng() - 0.5) * rough, ay + (by - ay) * t + (rng() - 0.5) * rough]);
      }
    };
    const hw = w / 2;
    const hh = h / 2;
    edge(-hw, -hh, hw, -hh, 2);
    edge(hw, -hh, hw, hh, 2);
    if (tearCorner) {
      // Diagonal rip across the bottom-right corner.
      pts.push([hw, hh * 0.25], [hw * 0.2, hh]);
    }
    edge(hw * (tearCorner ? 0.2 : 1), hh, -hw, hh, 5);
    edge(-hw, hh, -hw, -hh, 2);
    pts.forEach(([px, py], k) => (k ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
    ctx.closePath();
    ctx.fillStyle = col;
    ctx.fill();
    ctx.clip();
    // Rain stains: vertical streaks and a grimy bottom.
    for (let k = 0; k < 14; k++) {
      ctx.fillStyle = `rgba(60,48,30,${0.05 + rng() * 0.12})`;
      ctx.fillRect(-hw + rng() * w, -hh + rng() * h * 0.4, 2 + rng() * 5, h);
    }
    const g = ctx.createLinearGradient(0, hh * 0.2, 0, hh);
    g.addColorStop(0, 'rgba(50,40,24,0)');
    g.addColorStop(1, 'rgba(50,40,24,0.45)');
    ctx.fillStyle = g;
    ctx.fillRect(-hw, -hh, w, h);
    ctx.restore();
  };
  const caution = (ox: number, oy: number, y: number, h: number): void => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(ox + 20, oy + y, S - 40, h);
    ctx.clip();
    for (let k = -6; k < 16; k++) {
      ctx.fillStyle = k % 2 ? 'rgba(20,20,18,0.9)' : 'rgba(226,190,40,0.9)';
      ctx.beginPath();
      ctx.moveTo(ox + k * 24, oy + y + h);
      ctx.lineTo(ox + k * 24 + 12, oy + y + h);
      ctx.lineTo(ox + k * 24 + 12 + h, oy + y);
      ctx.lineTo(ox + k * 24 + h, oy + y);
      ctx.fill();
    }
    ctx.restore();
  };
  const stencil = (text: string, x: number, y: number, size: number, col: string): void => {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 ${size}px ${font}`;
    ctx.fillStyle = col;
    ctx.fillText(text, x, y, S - 36);
    // Stencil bridges: thin gaps through the letters.
    ctx.globalCompositeOperation = 'destination-out';
    for (let k = 0; k < 7; k++) ctx.fillRect(x - S / 2 + 30 + k * 30, y - size / 2, 3, size);
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();
  };
  const fade = (ox: number, oy: number, amount: number): void => {
    // Weathering: punch random holes / scuffs through the paint.
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    for (let k = 0; k < 160; k++) {
      ctx.globalAlpha = rng() * amount;
      ctx.beginPath();
      ctx.arc(ox + rng() * S, oy + rng() * S, 1 + rng() * 6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  };

  // 0 STRAND wild tag (neon cyan over hot magenta) + 09 badge.
  cell(0, (ox, oy) => {
    speckle(ox, oy, '#22f0ff', 120);
    spray('STRAND', ox + S / 2, oy + S * 0.45, 58, '#28f4ff', '#ff2bd6', -0.12);
    spray('09', ox + S * 0.78, oy + S * 0.76, 40, '#d6ff3a', '#1a1a1a', 0.18);
    fade(ox, oy, 0.5);
  });
  // 1 NO SIGNAL glitch stencil (magenta) with displaced scan bars.
  cell(1, (ox, oy) => {
    stencil('NO', ox + S / 2, oy + S * 0.34, 64, 'rgba(255,43,190,0.95)');
    stencil('SIGNAL', ox + S / 2, oy + S * 0.6, 50, 'rgba(255,43,190,0.95)');
    for (let k = 0; k < 9; k++) {
      ctx.fillStyle = k % 3 ? 'rgba(40,240,255,0.55)' : 'rgba(255,255,255,0.6)';
      ctx.fillRect(ox + 20 + rng() * 120, oy + 40 + rng() * 170, 30 + rng() * 90, 3 + rng() * 5);
    }
    fade(ox, oy, 0.45);
  });
  // 2 ZERO bubble letters (acid lime fill, coral edge).
  cell(2, (ox, oy) => {
    speckle(ox, oy, '#ff7a4a', 90);
    spray('ZERO', ox + S / 2, oy + S * 0.5, 72, '#b6ff2a', '#ff6a3a', 0.08);
    fade(ox, oy, 0.4);
  });
  // 3 Glitch skull stencil (coral + white).
  cell(3, (ox, oy) => {
    const cx = ox + S / 2;
    const cy = oy + S * 0.46;
    ctx.fillStyle = 'rgba(255,110,70,0.95)';
    ctx.beginPath();
    ctx.arc(cx, cy - 10, 62, Math.PI, 0);
    ctx.lineTo(cx + 62, cy + 20);
    ctx.lineTo(cx + 34, cy + 42);
    ctx.lineTo(cx + 34, cy + 70);
    ctx.lineTo(cx - 34, cy + 70);
    ctx.lineTo(cx - 34, cy + 42);
    ctx.lineTo(cx - 62, cy + 20);
    ctx.closePath();
    ctx.fill();
    ctx.globalCompositeOperation = 'destination-out';
    for (const sx of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(cx + sx * 26, cy + 2, 17, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.moveTo(cx, cy + 22);
    ctx.lineTo(cx - 9, cy + 38);
    ctx.lineTo(cx + 9, cy + 38);
    ctx.fill();
    for (let k = -2; k <= 2; k++) ctx.fillRect(cx + k * 13 - 2, cy + 50, 4, 20);
    ctx.globalCompositeOperation = 'source-over';
    for (let k = 0; k < 6; k++) {
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.fillRect(ox + 30 + rng() * 150, cy - 60 + rng() * 120, 40 + rng() * 50, 3);
    }
    fade(ox, oy, 0.5);
  });
  // 4 Rain-stained flyer collage.
  cell(4, (ox, oy) => {
    const tones = ['#d8d0bc', '#c9c2ae', '#e2d9c0'];
    for (let k = 0; k < 3; k++) {
      const x = ox + 22 + k * 52 + rng() * 10;
      const y = oy + 18 + rng() * 40;
      sheet(x, y, 108, 150, tones[k], (rng() - 0.5) * 0.12, k === 2 ? 1 : 0);
      ctx.save();
      ctx.translate(x + 54, y + 40);
      ctx.fillStyle = ['#b8202e', '#1a3a6a', '#202020'][k];
      ctx.font = `900 22px ${font}`;
      ctx.textAlign = 'center';
      ctx.fillText(['RIOT', 'JOBS', 'LOST'][k], 0, 0);
      ctx.fillStyle = 'rgba(30,30,30,0.6)';
      for (let l = 0; l < 6; l++) ctx.fillRect(-40, 18 + l * 12, 60 + rng() * 20, 4);
      ctx.restore();
    }
  });
  // 5 Torn 'NEO' tag promo poster.
  cell(5, (ox, oy) => {
    sheet(ox + 40, oy + 18, 176, 214, '#1a1424', -0.03, 1);
    ctx.save();
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ff2bd6';
    ctx.font = `900 50px ${font}`;
    ctx.fillText('NEO', ox + 128, oy + 90);
    ctx.fillStyle = '#28f4ff';
    ctx.font = `900 64px ${font}`;
    ctx.fillText('77', ox + 128, oy + 160);
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = `700 14px ${font}`;
    ctx.fillText('LIVE // SECTOR CLUB', ox + 128, oy + 196);
    ctx.restore();
    fade(ox, oy, 0.35);
  });
  // 6 RESTRICTED caution stencil.
  cell(6, (ox, oy) => {
    caution(ox, oy, 46, 30);
    stencil('RESTRICTED', ox + S / 2, oy + S * 0.52, 34, 'rgba(232,196,40,0.95)');
    caution(ox, oy, 172, 30);
    fade(ox, oy, 0.55);
  });
  // 7 HIGH VOLTAGE / SECTOR 04 + bolt + rust drips.
  cell(7, (ox, oy) => {
    ctx.fillStyle = 'rgba(232,196,40,0.95)';
    ctx.beginPath();
    ctx.moveTo(ox + 128, oy + 26);
    ctx.lineTo(ox + 190, oy + 132);
    ctx.lineTo(ox + 66, oy + 132);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(20,20,18,0.95)';
    ctx.beginPath();
    ctx.moveTo(ox + 134, oy + 52);
    ctx.lineTo(ox + 114, oy + 92);
    ctx.lineTo(ox + 130, oy + 92);
    ctx.lineTo(ox + 118, oy + 124);
    ctx.lineTo(ox + 146, oy + 80);
    ctx.lineTo(ox + 130, oy + 80);
    ctx.closePath();
    ctx.fill();
    stencil('HIGH VOLTAGE', ox + S / 2, oy + 166, 24, 'rgba(232,196,40,0.95)');
    stencil('SECTOR 04', ox + S / 2, oy + 200, 28, 'rgba(240,240,236,0.9)');
    for (let k = 0; k < 6; k++) {
      ctx.fillStyle = 'rgba(120,52,24,0.55)';
      ctx.fillRect(ox + 40 + rng() * 170, oy + 212, 3 + rng() * 3, 18 + rng() * 26);
    }
    fade(ox, oy, 0.45);
  });
  return finalizeTexture(c, THREE.SRGBColorSpace, anisotropy, false);
}

// ---------------------------------------------------------------------------
// 12A-3. Close-up automotive detail set (512 × 512, 4 quadrants of 256²) — generated straight into
//        Uint8Array RGBA buffers (THREE.DataTexture, no Canvas2D) so it also builds in headless Node.
// ---------------------------------------------------------------------------
/**
 * 12A-3 vehicle detail layout. DataTexture row 0 is v = 0, so quadrant origins are given in UV space
 * (`[u0, v0]`, each quadrant spans 0.5 × 0.5). Every quadrant tiles seamlessly on its own; sample it with
 * `origin + QUAD_INSET + fract(uv) * QUAD_SPAN` and `textureGrad(..., dFdx(uv) * QUAD_SPAN, dFdy(uv) * QUAD_SPAN)`.
 *
 * Channel packing (both maps linear, `NoColorSpace`):
 *  - `normalMap`:    RGB = tangent-space normal, OpenGL convention (+X = +u, +Y = +v up), flat = (128, 128, 255); A = 255.
 *  - `roughnessMap`: R = cavity / AO (255 = open, darker in tow gaps / honeycomb cells / grooves),
 *                    G = absolute roughness (0..255 => 0..1), B = metalness hint (0..255 => 0..1), A = 255.
 *
 *  - Q0 carbon fibre: 45° 2×2 twill, 8 weave repeats (32 tows of 8 px); roughness 0.22 warp / 0.34 weft, metal 0.1.
 *  - Q1 honeycomb grille: 7 × 8 sharp hex cells, raised 2 px walls, deep dark cells; roughness 0.55 / 0.8, metal 0.3.
 *  - Q2 brushed metal: radial grooves around the quadrant centre + faint concentric lathe rings; roughness
 *    0.25–0.35, metal 0.9 (mirror-folded about the quadrant axes so the radial field tiles).
 *  - Q3 clearcoat rain beading: sparse hemispherical micro droplets (r 2–7 px) over faint orange peel;
 *    roughness 0.12 drops / 0.18 paint, metal 0.
 */
export const VEHICLE_DETAIL = {
  SIZE: 512,
  QUAD: 256,
  Q0_CARBON: [0, 0],
  Q1_HONEYCOMB: [0.5, 0],
  Q2_BRUSHED: [0, 0.5],
  Q3_CLEARCOAT: [0.5, 0.5],
  /** UV inset applied inside each quadrant before sampling (anti-mip-bleed). */
  QUAD_INSET: 0.008,
  /** UV span used inside each quadrant (`0.5 - 2 × QUAD_INSET`). */
  QUAD_SPAN: 0.484,
} as const;

const VD_Q = 256;
const VD_MASK = VD_Q - 1;

function vdSmooth(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** 1-D value noise over a pre-filled table (no wrap; caller keeps `t` inside [0, tab.length - 1]). */
function vdNoise1(tab: Float32Array, t: number): number {
  const n = tab.length - 1;
  let i = Math.floor(t);
  if (i < 0) i = 0;
  else if (i >= n) i = n - 1;
  const f = clamp(t - i, 0, 1);
  const s = f * f * (3 - 2 * f);
  return tab[i] + (tab[i + 1] - tab[i]) * s;
}

/** 2-D periodic value noise on an `n × n` table (`n` a power of two), `x`/`y` in lattice units. */
function vdNoise2(tab: Float32Array, n: number, x: number, y: number): number {
  const m = n - 1;
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const x0 = xi & m;
  const x1 = (xi + 1) & m;
  const y0 = (yi & m) * n;
  const y1 = ((yi + 1) & m) * n;
  const a = tab[y0 + x0] + (tab[y0 + x1] - tab[y0 + x0]) * sx;
  const b = tab[y1 + x0] + (tab[y1 + x1] - tab[y1 + x0]) * sx;
  return a + (b - a) * sy;
}

function vdTable(len: number, rng: () => number): Float32Array {
  const t = new Float32Array(len);
  for (let i = 0; i < len; i++) t[i] = rng();
  return t;
}

/** Twill over-state of tow cell (i, j): true = warp (runs along v) on top, false = weft (runs along u) on top. */
function vdWarpOver(i: number, j: number): boolean {
  return ((i + j) & 3) < 2;
}

/** Q0 — 45° 2×2 twill carbon weave. Heights in pixels. */
function vdPaintCarbon(h: Float32Array, rg: Float32Array, mt: Float32Array, cv: Float32Array, rng: () => number): void {
  const TOW = 8; // 32 tows across, 8 twill repeats per quadrant
  const peel = vdTable(64 * 64, rng);
  for (let y = 0; y < VD_Q; y++) {
    const j = (y / TOW) | 0;
    const fy = ((y % TOW) + 0.5) / TOW;
    for (let x = 0; x < VD_Q; x++) {
      const i = (x / TOW) | 0;
      const fx = ((x % TOW) + 0.5) / TOW;
      const warp = vdWarpOver(i, j);
      // across = coordinate across the top tow, along = coordinate along it
      const across = warp ? fx : fy;
      const along = warp ? fy : fx;
      const prevOver = warp ? vdWarpOver(i, j - 1) : !vdWarpOver(i - 1, j);
      const nextOver = warp ? vdWarpOver(i, j + 1) : !vdWarpOver(i + 1, j);
      const cross = Math.sqrt(Math.max(0, Math.sin(Math.PI * across)));
      const tPrev = prevOver ? 1 : 0.5 + 0.5 * vdSmooth(0, 0.42, along);
      const tNext = nextOver ? 1 : 0.5 + 0.5 * vdSmooth(0, 0.42, 1 - along);
      const taper = Math.min(tPrev, tNext);
      const fibre = 0.05 * Math.cos(Math.PI * 4 * across); // 2 filament ridges per tow (4 px period)
      const micro = (vdNoise2(peel, 64, x * 0.25, y * 0.25) - 0.5) * 0.06;
      const k = y * VD_Q + x;
      h[k] = (cross * taper + fibre * cross + micro) * 1.25;
      rg[k] = (warp ? 0.22 : 0.34) + 0.07 * (1 - cross);
      mt[k] = 0.1;
      cv[k] = (0.5 + 0.5 * Math.min(1, cross * 1.5)) * (0.86 + 0.14 * taper);
    }
  }
}

/** Q1 — sharp hexagonal honeycomb grille (7 cells across, 8 rows, periodic). Heights in pixels. */
function vdPaintHoneycomb(h: Float32Array, rg: Float32Array, mt: Float32Array, cv: Float32Array): void {
  const SQ3 = Math.sqrt(3);
  const CX = 7; // hex columns across the quadrant (lattice units of 1 = centre spacing)
  const CY = 4 * SQ3; // 8 staggered rows (lattice period √3 per 2 rows), ≈ 1 % vertical stretch
  const WALL = 0.055; // half wall thickness ≈ 2 px
  const BEVEL = 0.05; // ≈ 1.8 px bevel into the cell
  for (let y = 0; y < VD_Q; y++) {
    const v = ((y + 0.5) * CY) / VD_Q;
    for (let x = 0; x < VD_Q; x++) {
      const u = ((x + 0.5) * CX) / VD_Q;
      // nearest centre among the two rectangular sub-lattices of the triangular lattice
      const ax = Math.round(u);
      const ay = Math.round(v / SQ3) * SQ3;
      const bx = Math.round(u - 0.5) + 0.5;
      const by = Math.round((v - SQ3 * 0.5) / SQ3) * SQ3 + SQ3 * 0.5;
      const da = (u - ax) * (u - ax) + (v - ay) * (v - ay);
      const db = (u - bx) * (u - bx) + (v - by) * (v - by);
      const qx = Math.abs(da <= db ? u - ax : u - bx);
      const qy = Math.abs(da <= db ? v - ay : v - by);
      const e = 0.5 - Math.max(qx, qx * 0.5 + qy * SQ3 * 0.5); // distance to the hex edge (0.5 at centre)
      const wall = 1 - vdSmooth(WALL, WALL + BEVEL, e);
      const deep = vdSmooth(WALL + BEVEL, 0.5, e);
      const k = y * VD_Q + x;
      h[k] = (wall - (1 - wall) * 0.45 * deep) * 3.0;
      rg[k] = 0.55 + 0.25 * (1 - wall);
      mt[k] = 0.3;
      cv[k] = wall + (1 - wall) * (0.45 - 0.33 * deep);
    }
  }
}

/** Q2 — brushed metal: radial grooves + faint concentric lathe rings (D2-folded so it tiles). Heights in pixels. */
function vdPaintBrushed(h: Float32Array, rg: Float32Array, mt: Float32Array, cv: Float32Array, rng: () => number): void {
  const HALF_PI = Math.PI * 0.5;
  // Angular bands (cells per quarter turn); each fades in only where its arc spacing is >= ~2 px.
  const N0 = 24;
  const N1 = 56;
  const N2 = 110;
  const b0 = vdTable(N0 + 1, rng);
  const b1 = vdTable(N1 + 1, rng);
  const b2 = vdTable(N2 + 1, rng);
  const ringTab = vdTable(96, rng);
  const ringPhase = vdTable(40, rng);
  const C = VD_Q * 0.5;
  for (let y = 0; y < VD_Q; y++) {
    const py = Math.abs(y + 0.5 - C);
    for (let x = 0; x < VD_Q; x++) {
      const px = Math.abs(x + 0.5 - C);
      const r = Math.sqrt(px * px + py * py);
      const a = Math.atan2(py, px) / HALF_PI; // 0..1 over the folded quarter
      const g0 = vdNoise1(b0, a * N0) * vdSmooth(31, 50, r);
      const g1 = vdNoise1(b1, a * N1) * vdSmooth(71, 115, r);
      const g2 = vdNoise1(b2, a * N2) * vdSmooth(140, 175, r);
      const wSum = vdSmooth(31, 50, r) + vdSmooth(71, 115, r) + vdSmooth(140, 175, r);
      const groove = wSum > 0 ? (g0 + g1 + g2) / wSum : 0.5;
      const radialAmt = Math.min(1, wSum);
      // concentric lathe rings: 3.4 px period with slow phase wander + per-ring tone
      const ring = 0.5 + 0.5 * Math.sin((r * Math.PI * 2) / 3.4 + vdNoise1(ringPhase, r / 6) * 2.5);
      const ringTone = vdNoise1(ringTab, r / 2.5);
      const hub = 1 - vdSmooth(4, 14, r);
      const k = y * VD_Q + x;
      h[k] = (groove - 0.5) * 1.1 * radialAmt + (ring - 0.5) * 0.05 + (ringTone - 0.5) * 0.08 - hub * 0.6;
      rg[k] = clamp(0.3 + (groove - 0.5) * 0.1 * radialAmt + (ringTone - 0.5) * 0.04, 0.25, 0.35);
      mt[k] = 0.9;
      cv[k] = 0.94 + 0.06 * (groove * radialAmt + (1 - radialAmt) * 0.6) - hub * 0.1;
    }
  }
}

/** Q3 — clearcoat rain beading: sparse hemispherical droplets (toroidally wrapped) over faint orange peel. */
function vdPaintClearcoat(h: Float32Array, rg: Float32Array, mt: Float32Array, cv: Float32Array, rng: () => number): void {
  const peelA = vdTable(16 * 16, rng);
  const peelB = vdTable(32 * 32, rng);
  for (let y = 0; y < VD_Q; y++) {
    for (let x = 0; x < VD_Q; x++) {
      const k = y * VD_Q + x;
      h[k] = (vdNoise2(peelA, 16, x / 16, y / 16) - 0.5) * 0.35 + (vdNoise2(peelB, 32, x / 8, y / 8) - 0.5) * 0.12;
      rg[k] = 0.18;
      mt[k] = 0;
      cv[k] = 1;
    }
  }
  const DROPS = 85;
  for (let d = 0; d < DROPS; d++) {
    const cx = rng() * VD_Q;
    const cy = rng() * VD_Q;
    const s = rng();
    const R = 2 + s * s * 5; // mostly small beads, a few 7 px ones
    const hR = R * 0.5;
    const ext = Math.ceil(R) + 1;
    const x0 = Math.floor(cx) - ext;
    const y0 = Math.floor(cy) - ext;
    for (let yy = y0; yy <= y0 + 2 * ext; yy++) {
      const dy = yy + 0.5 - cy;
      for (let xx = x0; xx <= x0 + 2 * ext; xx++) {
        const dx = xx + 0.5 - cx;
        const t = (dx * dx + dy * dy) / (R * R);
        if (t >= 1) continue;
        const k = (yy & VD_MASK) * VD_Q + (xx & VD_MASK);
        const hd = hR * Math.sqrt(1 - t);
        if (hd > h[k]) h[k] = hd;
        const m = 1 - vdSmooth(0.75, 1, t);
        rg[k] = Math.min(rg[k], 0.18 - 0.06 * m);
        cv[k] = Math.min(cv[k], 1 - 0.06 * vdSmooth(0.7, 1, t) * (1 - vdSmooth(0.98, 1, t)));
      }
    }
  }
}

function vdTexture(data: Uint8Array, size: number, anisotropy: number): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = anisotropy;
  tex.flipY = false;
  tex.needsUpdate = true;
  return tex;
}

/**
 * 12A-3: builds the 512 × 512 close-up automotive detail set (see {@link VEHICLE_DETAIL} for the quadrant
 * layout and channel packing). Pure & deterministic (seeded RNG), Canvas-free, safe in headless Node.
 */
export function generateVehicleDetailSet(anisotropy = 1): { normalMap: THREE.DataTexture; roughnessMap: THREE.DataTexture } {
  const S = VEHICLE_DETAIL.SIZE;
  const QQ = VD_Q * VD_Q;
  const nrm = new Uint8Array(S * S * 4);
  const rgh = new Uint8Array(S * S * 4);
  const h = new Float32Array(QQ);
  const rg = new Float32Array(QQ);
  const mt = new Float32Array(QQ);
  const cv = new Float32Array(QQ);
  const rng = createRng(0x12a3c4);
  // normal strength per quadrant (heights are already in pixel units)
  const STRENGTH = [1.0, 1.0, 1.0, 0.9];
  for (let q = 0; q < 4; q++) {
    if (q === 0) vdPaintCarbon(h, rg, mt, cv, rng);
    else if (q === 1) vdPaintHoneycomb(h, rg, mt, cv);
    else if (q === 2) vdPaintBrushed(h, rg, mt, cv, rng);
    else vdPaintClearcoat(h, rg, mt, cv, rng);
    const ox = (q & 1) * VD_Q;
    const oy = (q >> 1) * VD_Q;
    const str = STRENGTH[q];
    for (let y = 0; y < VD_Q; y++) {
      const rowU = ((y + 1) & VD_MASK) * VD_Q;
      const rowD = ((y - 1) & VD_MASK) * VD_Q;
      const row = y * VD_Q;
      for (let x = 0; x < VD_Q; x++) {
        // central differences, wrapped inside the quadrant (row index grows with +v)
        const dhx = (h[row + ((x + 1) & VD_MASK)] - h[row + ((x - 1) & VD_MASK)]) * 0.5;
        const dhy = (h[rowU + x] - h[rowD + x]) * 0.5;
        const nx = -dhx * str;
        const ny = -dhy * str;
        const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
        const k = row + x;
        const o = ((oy + y) * S + ox + x) * 4;
        nrm[o] = Math.round((nx * inv * 0.5 + 0.5) * 255);
        nrm[o + 1] = Math.round((ny * inv * 0.5 + 0.5) * 255);
        nrm[o + 2] = Math.round((inv * 0.5 + 0.5) * 255);
        nrm[o + 3] = 255;
        rgh[o] = Math.round(clamp(cv[k], 0, 1) * 255);
        rgh[o + 1] = Math.round(clamp(rg[k], 0, 1) * 255);
        rgh[o + 2] = Math.round(clamp(mt[k], 0, 1) * 255);
        rgh[o + 3] = 255;
      }
    }
  }
  return { normalMap: vdTexture(nrm, S, anisotropy), roughnessMap: vdTexture(rgh, S, anisotropy) };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
let cache: ProceduralTextureLibrary | null = null;

/** Generates (once) and returns the full procedural texture library (falls back to placeholder textures in headless Node tests). */
export function getProceduralTextures(renderer: THREE.WebGLRenderer): ProceduralTextureLibrary {
  if (cache) return cache;
  if (typeof document === 'undefined') {
    const pbr = (): Required<PbrTextureSet> => ({
      map: new THREE.Texture(),
      roughnessMap: new THREE.Texture(),
      normalMap: new THREE.Texture(),
      emissiveMap: new THREE.Texture(),
    });
    cache = {
      facades: pbr(),
      roof: pbr(),
      roads: pbr(),
      machinery: pbr(),
      neonAtlas: new THREE.Texture(),
      neonAtlasStrips: NEON_STRIPS.length,
      signAtlas: new THREE.Texture(),
      tech: pbr(),
      archDetail: pbr(),
      manhole: pbr(),
      plaqueAtlas: new THREE.Texture(),
      graffitiAtlas: new THREE.Texture(),
      megaBillboard: new THREE.Texture(),
      vendingAtlas: new THREE.Texture(),
      furnishingsAtlas: new THREE.Texture(),
      glove: pbr(),
      gun: pbr(),
      vehicleDetail: generateVehicleDetailSet(1),
    };
    return cache;
  }
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
    archDetail: generateArchDetailSet(aniso),
    manhole: generateManholeSet(aniso),
    plaqueAtlas: generatePlaqueAtlas(aniso),
    graffitiAtlas: generateGraffitiAtlas(aniso),
    megaBillboard: generateMegaBillboardAtlas(aniso),
    vendingAtlas: generateVendingAtlas(aniso),
    furnishingsAtlas: generateFurnishingsAtlas(aniso),
    glove: generateGloveSet(aniso),
    gun: generateGunSet(aniso),
    vehicleDetail: generateVehicleDetailSet(aniso),
  };
  return cache;
}
