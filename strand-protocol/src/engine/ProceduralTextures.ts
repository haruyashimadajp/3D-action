/**
 * STRAND // PROTOCOL — Procedural PBR texture factory (§6.2-2).
 * Everything is generated once at boot with Canvas2D and cached; no external assets.
 *
 *  - Supertall window set (1024²): Albedo / Emissive / Roughness / Normal (Sobel from height),
 *    office floors + low-rise (1F–3F) shop floors with neon shop frames
 *  - Wet rooftop / sidewalk concrete with cracks & puddles (512²): Albedo / Roughness (puddle 0.06, wet 0.42) / Normal
 *  - Wet road atlas (512²): lanes, centre line, white dashes, crosswalk, manholes, puddles
 *  - Cyan wall-run panel (512²): Albedo / Emissive (strips + chevrons) / Roughness / Normal
 *  - Hologram neon sign atlas (1024²): 8 vertical katakana / English-symbol strips
 *  - Sign atlas (1024², 5B-3): 6 wide banners + 2 seamless scrolling LED tickers, 8 emblems / holograms
 *  - Tactical tech PBR set (512², 5B-4): carbon weave, panel grooves, screw heads, edge wear, brushed metal
 *  - Rooftop machinery (256²): AC-unit fan grille Albedo / Roughness / Normal
 */
import * as THREE from 'three';
import {
  COLORS,
  MATERIALS,
  RENDER,
  BACKGROUND_MAX_LUMINANCE,
  WINDOW_WARM_RATIO,
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
  windows: Required<PbrTextureSet>;
  roof: PbrTextureSet;
  /** Wet road atlas (lanes / crosswalk / plain asphalt) — see ROAD_ATLAS. */
  roads: PbrTextureSet;
  wallPanel: Required<PbrTextureSet>;
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
// 1. Supertall window set (1024², 4 maps)
//    Canvas rows 0–4  (uv v 0.375…1): office floors, sampled repeating every 20 m above Y 12 m.
//    Canvas rows 5–7  (uv v 0…0.375): low-rise shop floors 3F/2F/1F (Y 0–12 m) with neon shop frames.
// ---------------------------------------------------------------------------
const SHOP_NEON = [0xff2bd6, 0x00f0ff, 0xffa21f, 0xff3b5c, 0x39ff88, 0xb44bff] as const;

function generateWindowSet(anisotropy: number): Required<PbrTextureSet> {
  const S = RENDER.WINDOW_TEX_SIZE;
  const rows = RENDER.WINDOW_ROWS;
  const officeRows = RENDER.WINDOW_OFFICE_ROWS;
  const bays = RENDER.WINDOW_BAYS_PER_TILE;
  const floorPx = S / rows;
  const bayPx = S / bays;
  const officePx = officeRows * floorPx;
  const rng = createRng(0x57a2d);

  const [albC, alb] = makeCanvas(S, S);
  const [emiC, emi] = makeCanvas(S, S);
  const [rghC, rgh] = makeCanvas(S, S);
  const [, hgt] = makeCanvas(S, S);

  // Background: spandrel/structure everywhere.
  alb.fillStyle = '#161b24';
  alb.fillRect(0, 0, S, S);
  emi.fillStyle = '#000';
  emi.fillRect(0, 0, S, S);
  rgh.fillStyle = grayCss(0.62);
  rgh.fillRect(0, 0, S, S);
  hgt.fillStyle = grayCss(0.8);
  hgt.fillRect(0, 0, S, S);

  const warm: [number, number, number] = [0, 0, 0];
  const cool: [number, number, number] = [0, 0, 0];
  const tmp: [number, number, number] = [0, 0, 0];
  hexToLinearRgb(COLORS.WINDOW_WARM, warm);
  hexToLinearRgb(COLORS.WINDOW_COOL, cool);
  // Emissive is scaled by material.emissiveIntensity (0.45). Keep final linear luminance <= 0.28.
  const emissiveScale = MATERIALS.BUILDING_GLASS.emissive;
  const maxTexLum = BACKGROUND_MAX_LUMINANCE / emissiveScale;
  /** CSS colour for a linear RGB scaled so its luminance equals `lum` (≤ maxTexLum). */
  const capped = (lin: [number, number, number], lum: number): string => {
    const k = Math.min(lum, maxTexLum) / Math.max(linLum(lin[0], lin[1], lin[2]), 1e-4);
    return rgbCss(linearToSrgbByte(lin[0] * k), linearToSrgbByte(lin[1] * k), linearToSrgbByte(lin[2] * k));
  };

  const glass = '#0c121d';
  const mullionAlb = '#2a3242';
  const frame = 3;
  const mullion = 4;
  const spandrelPx = Math.round(floorPx * 0.16);

  const drawSpandrel = (fy: number): void => {
    alb.fillStyle = '#121720';
    alb.fillRect(0, fy + floorPx - spandrelPx, S, spandrelPx);
    rgh.fillStyle = grayCss(0.58);
    rgh.fillRect(0, fy + floorPx - spandrelPx, S, spandrelPx);
    hgt.fillStyle = grayCss(0.86);
    hgt.fillRect(0, fy + floorPx - spandrelPx, S, spandrelPx);
    alb.fillStyle = '#2b3445';
    alb.fillRect(0, fy + floorPx - spandrelPx, S, 2);
    hgt.fillStyle = grayCss(1.0);
    hgt.fillRect(0, fy + floorPx - spandrelPx, S, 2);
  };

  // ----------------------------- Office floors (rows 0–4) -----------------------------
  for (let f = 0; f < officeRows; f++) {
    const fy = f * floorPx;
    drawSpandrel(fy);
    // 2 AM occupancy: whole floors cluster dark or lit (tenants), giving realistic horizontal banding.
    const floorRoll = rng();
    const occupancy = floorRoll < 0.3 ? 0.06 : floorRoll < 0.75 ? 0.38 : 0.78;

    for (let b = 0; b < bays; b++) {
      const bx = b * bayPx;
      const wx = bx + frame;
      const wy = fy + frame;
      const ww = bayPx - frame * 2;
      const wh = floorPx - spandrelPx - frame * 2;

      // Two panes per bay split by a vertical mullion.
      const paneW = (ww - mullion) / 2;
      for (let p = 0; p < 2; p++) {
        const px = wx + p * (paneW + mullion);
        alb.fillStyle = glass;
        alb.fillRect(px, wy, paneW, wh);
        rgh.fillStyle = grayCss(MATERIALS.BUILDING_GLASS.roughness);
        rgh.fillRect(px, wy, paneW, wh);
        hgt.fillStyle = grayCss(0.32);
        hgt.fillRect(px, wy, paneW, wh);

        if (rng() >= occupancy) {
          // Unlit office: faint interior silhouettes barely visible through dark glass.
          alb.fillStyle = 'rgba(20,28,40,0.6)';
          alb.fillRect(px + paneW * 0.1, wy + wh * 0.62, paneW * 0.8, wh * 0.38);
          continue;
        }

        // Lit pane: warm : cool = 3 : 7, with colour-temperature drift.
        const base = rng() < WINDOW_WARM_RATIO ? warm : cool;
        const drift = (rng() - 0.5) * 0.18;
        tmp[0] = base[0] * (1 + drift);
        tmp[1] = base[1] * (1 + drift * 0.4);
        tmp[2] = base[2] * (1 - drift);
        const brightness = 0.32 + rng() * 0.68;
        const lum = maxTexLum * brightness;

        // Interior light falloff: ceiling brighter, floor darker.
        const grad = emi.createLinearGradient(0, wy, 0, wy + wh);
        grad.addColorStop(0, capped(tmp, lum));
        grad.addColorStop(0.55, capped(tmp, lum * 0.82));
        grad.addColorStop(1, capped(tmp, lum * 0.45));
        emi.fillStyle = grad;
        emi.fillRect(px, wy, paneW, wh);
        // Ceiling light fixtures (brightest strip — still capped by maxTexLum).
        emi.fillStyle = capped(tmp, maxTexLum);
        if (rng() < 0.7) emi.fillRect(px + paneW * 0.15, wy + 3, paneW * 0.7, 2);
        // Interior silhouettes: desks, partitions, a column.
        emi.fillStyle = 'rgba(0,0,0,0.55)';
        emi.fillRect(px, wy + wh * 0.7, paneW, wh * 0.3);
        if (rng() < 0.35) emi.fillRect(px + rng() * paneW * 0.7, wy + wh * 0.25, paneW * 0.12, wh * 0.75);
        if (rng() < 0.4) {
          emi.fillStyle = 'rgba(0,0,0,0.7)';
          const dw = paneW * (0.2 + rng() * 0.3);
          emi.fillRect(px + rng() * (paneW - dw), wy + wh * 0.55, dw, wh * 0.18);
        }
        // Random blinds: horizontal slats covering a random fraction from the top.
        if (rng() < 0.45) {
          const blindH = wh * (0.15 + rng() * 0.8);
          for (let y = 0; y < blindH; y += 4) {
            emi.fillStyle = 'rgba(0,0,0,0.62)';
            emi.fillRect(px, wy + y, paneW, 3);
            alb.fillStyle = 'rgba(48,54,64,0.85)';
            alb.fillRect(px, wy + y, paneW, 3);
            rgh.fillStyle = grayCss(0.6);
            rgh.fillRect(px, wy + y, paneW, 3);
            hgt.fillStyle = grayCss(0.42);
            hgt.fillRect(px, wy + y, paneW, 3);
          }
        }
      }

      // Mullions & frame (raised, brushed metal).
      alb.fillStyle = mullionAlb;
      alb.fillRect(wx + paneW, wy, mullion, wh);
      alb.fillRect(bx, fy, frame, floorPx - spandrelPx);
      alb.fillRect(bx + bayPx - frame, fy, frame, floorPx - spandrelPx);
      alb.fillRect(bx, fy, bayPx, frame);
      rgh.fillStyle = grayCss(0.35);
      rgh.fillRect(wx + paneW, wy, mullion, wh);
      rgh.fillRect(bx, fy, frame, floorPx - spandrelPx);
      rgh.fillRect(bx + bayPx - frame, fy, frame, floorPx - spandrelPx);
      hgt.fillStyle = grayCss(1.0);
      hgt.fillRect(wx + paneW, wy, mullion, wh);
      hgt.fillRect(bx, fy, frame, floorPx - spandrelPx);
      hgt.fillRect(bx + bayPx - frame, fy, frame, floorPx - spandrelPx);
      hgt.fillRect(bx, fy, bayPx, frame);
    }
  }
  // Rain run-off grime on the office band only (wrapped inside the band so it tiles vertically).
  for (let i = 0; i < 220; i++) {
    const x = rng() * S;
    const y = rng() * officePx;
    const len = 20 + rng() * 120;
    const a = 0.05 + rng() * 0.08;
    const w = 1 + rng() * 2;
    for (const oy of [0, -officePx]) {
      const y0 = Math.max(0, y + oy);
      const y1 = Math.min(officePx, y + oy + len);
      if (y1 <= y0) continue;
      alb.fillStyle = `rgba(0,0,0,${a})`;
      alb.fillRect(x, y0, w, y1 - y0);
      rgh.fillStyle = `rgba(255,255,255,${a * 0.6})`;
      rgh.fillRect(x, y0, 1, y1 - y0);
    }
  }

  // ----------------------------- Shop floors (rows 5–7 = 3F, 2F, 1F) -----------------------------
  const neonLin: Array<[number, number, number]> = SHOP_NEON.map((h) => hexToLinearRgb(h, [0, 0, 0]));
  const shopFloors = RENDER.WINDOW_SHOP_ROWS;
  for (let sf = 0; sf < shopFloors; sf++) {
    const f = officeRows + sf;
    const fy = f * floorPx;
    const isGround = sf === shopFloors - 1;
    drawSpandrel(fy);
    let b = 0;
    while (b < bays) {
      // Each tenant spans 1–3 bays.
      const span = Math.min(bays - b, 1 + Math.floor(rng() * 3));
      const x0 = b * bayPx + frame;
      const w = span * bayPx - frame * 2;
      const y0 = fy + frame;
      const h = floorPx - spandrelPx - frame * 2;
      const neon = neonLin[Math.floor(rng() * neonLin.length)];
      const open = rng() < (isGround ? 0.78 : 0.6);

      if (isGround) {
        // Fascia sign band across the top of the storefront.
        const fasciaH = Math.round(h * 0.24);
        alb.fillStyle = '#0f131a';
        alb.fillRect(x0, y0, w, fasciaH);
        hgt.fillStyle = grayCss(0.95);
        hgt.fillRect(x0, y0, w, fasciaH);
        if (open) {
          emi.fillStyle = capped(neon, maxTexLum * 0.55);
          emi.fillRect(x0 + 4, y0 + 4, w - 8, fasciaH - 8);
          // Glyph-like dashes of the shop name.
          emi.fillStyle = capped(neon, maxTexLum);
          const glyphs = 3 + Math.floor(rng() * 6);
          const gw = (w - 24) / glyphs;
          for (let gI = 0; gI < glyphs; gI++) {
            const gh = fasciaH * (0.35 + rng() * 0.3);
            emi.fillRect(x0 + 12 + gI * gw + gw * 0.15, y0 + (fasciaH - gh) / 2, gw * 0.7, gh);
          }
        }
        const sy = y0 + fasciaH + 4;
        const sh = h - fasciaH - 4;
        if (open) {
          // Lit storefront glass with interior shelves / counter silhouettes.
          alb.fillStyle = glass;
          alb.fillRect(x0, sy, w, sh);
          rgh.fillStyle = grayCss(0.1);
          rgh.fillRect(x0, sy, w, sh);
          hgt.fillStyle = grayCss(0.3);
          hgt.fillRect(x0, sy, w, sh);
          const interior = rng() < 0.5 ? warm : cool;
          const grad = emi.createLinearGradient(0, sy, 0, sy + sh);
          grad.addColorStop(0, capped(interior, maxTexLum * 0.95));
          grad.addColorStop(1, capped(interior, maxTexLum * 0.5));
          emi.fillStyle = grad;
          emi.fillRect(x0, sy, w, sh);
          emi.fillStyle = 'rgba(0,0,0,0.6)';
          for (let k = 0; k < span * 2; k++) {
            emi.fillRect(x0 + 6 + rng() * (w - 30), sy + sh * (0.3 + rng() * 0.4), 10 + rng() * 18, sh * 0.6);
          }
          // Door.
          const dx = x0 + rng() * (w - 34);
          alb.fillStyle = '#1d2430';
          alb.fillRect(dx, sy + sh * 0.12, 30, sh * 0.88);
          // Neon frame outline around the storefront.
          emi.strokeStyle = capped(neon, maxTexLum);
          emi.lineWidth = 3;
          emi.strokeRect(x0 + 2, sy + 2, w - 4, sh - 4);
        } else {
          // Closed: ribbed roll-down shutter.
          alb.fillStyle = '#2a3039';
          alb.fillRect(x0, sy, w, sh);
          rgh.fillStyle = grayCss(0.5);
          rgh.fillRect(x0, sy, w, sh);
          for (let yy = sy; yy < sy + sh; yy += 5) {
            hgt.fillStyle = grayCss(0.9);
            hgt.fillRect(x0, yy, w, 3);
            hgt.fillStyle = grayCss(0.5);
            hgt.fillRect(x0, yy + 3, w, 2);
            alb.fillStyle = 'rgba(0,0,0,0.25)';
            alb.fillRect(x0, yy + 3, w, 1);
          }
          // Graffiti-tag smear and a tiny status LED.
          alb.fillStyle = `rgba(${80 + rng() * 120},${40 + rng() * 60},${120 + rng() * 120},0.25)`;
          alb.fillRect(x0 + rng() * w * 0.5, sy + sh * 0.4, w * 0.3, sh * 0.25);
          emi.fillStyle = capped(neon, maxTexLum * 0.6);
          emi.fillRect(x0 + w - 10, sy + 6, 4, 4);
        }
      } else {
        // Upper shop floors: bars / karaoke / salons — windows with neon frames or dark.
        for (let k = 0; k < span; k++) {
          const wx = b * bayPx + k * bayPx + frame + 6;
          const ww = bayPx - frame * 2 - 12;
          alb.fillStyle = glass;
          alb.fillRect(wx, y0 + 4, ww, h - 8);
          rgh.fillStyle = grayCss(0.12);
          rgh.fillRect(wx, y0 + 4, ww, h - 8);
          hgt.fillStyle = grayCss(0.3);
          hgt.fillRect(wx, y0 + 4, ww, h - 8);
          if (open) {
            const tint = rng() < 0.5 ? neon : rng() < 0.5 ? warm : cool;
            emi.fillStyle = capped(tint, maxTexLum * (0.45 + rng() * 0.4));
            emi.fillRect(wx, y0 + 4, ww, h - 8);
            emi.strokeStyle = capped(neon, maxTexLum);
            emi.lineWidth = 2;
            emi.strokeRect(wx + 1, y0 + 5, ww - 2, h - 10);
            emi.fillStyle = 'rgba(0,0,0,0.5)';
            emi.fillRect(wx, y0 + h * 0.62, ww, h * 0.34);
          }
        }
        // Small vertical signboard between tenants.
        if (open && rng() < 0.6) {
          const sx = b * bayPx + span * bayPx - 10;
          alb.fillStyle = '#10141b';
          alb.fillRect(sx, y0, 12, h);
          emi.fillStyle = capped(neon, maxTexLum);
          for (let yy = y0 + 6; yy < y0 + h - 8; yy += 14) emi.fillRect(sx + 3, yy, 6, 8);
        }
      }
      // Pilasters between tenants.
      alb.fillStyle = mullionAlb;
      alb.fillRect(b * bayPx, fy, frame, floorPx - spandrelPx);
      hgt.fillStyle = grayCss(1.0);
      hgt.fillRect(b * bayPx, fy, frame, floorPx - spandrelPx);
      b += span;
    }
  }

  return {
    map: finalizeTexture(albC, THREE.SRGBColorSpace, anisotropy),
    emissiveMap: finalizeTexture(emiC, THREE.SRGBColorSpace, anisotropy),
    roughnessMap: finalizeTexture(rghC, THREE.NoColorSpace, anisotropy),
    normalMap: normalTextureFromHeight(hgt, S, S, 3.2, anisotropy),
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
// 3. Cyan wall-run panel (512²): v spans full panel height, u repeats every 4 m
// ---------------------------------------------------------------------------
function generateWallPanelSet(anisotropy: number): Required<PbrTextureSet> {
  const S = 512;
  const rng = createRng(0xc7a0);
  const [albC, alb] = makeCanvas(S, S);
  const [emiC, emi] = makeCanvas(S, S);
  const [rghC, rgh] = makeCanvas(S, S);
  const [, hgt] = makeCanvas(S, S);

  // Dark gunmetal plate with brushed streaks.
  alb.fillStyle = '#18202c';
  alb.fillRect(0, 0, S, S);
  rgh.fillStyle = grayCss(MATERIALS.WALLRUN_PANEL.roughness);
  rgh.fillRect(0, 0, S, S);
  hgt.fillStyle = grayCss(0.6);
  hgt.fillRect(0, 0, S, S);
  emi.fillStyle = '#000';
  emi.fillRect(0, 0, S, S);
  for (let i = 0; i < 900; i++) {
    const y = rng() * S;
    alb.fillStyle = `rgba(${40 + rng() * 30},${50 + rng() * 30},${64 + rng() * 30},0.08)`;
    alb.fillRect(0, y, S, 1);
  }

  const strip = Math.round(S * 0.06);
  const stripInset = Math.round(S * 0.025);
  // Horizontal cyan emissive strips at top & bottom edges.
  for (const y of [stripInset, S - stripInset - strip]) {
    emi.fillStyle = '#ffffff';
    emi.fillRect(0, y, S, strip);
    alb.fillStyle = '#6a8a94';
    alb.fillRect(0, y, S, strip);
    rgh.fillStyle = grayCss(0.12);
    rgh.fillRect(0, y, S, strip);
    hgt.fillStyle = grayCss(0.9);
    hgt.fillRect(0, y, S, strip);
    // Recessed channel around each strip.
    hgt.fillStyle = grayCss(0.25);
    hgt.fillRect(0, y - 4, S, 3);
    hgt.fillRect(0, y + strip + 1, S, 3);
  }

  // Diagonal chevrons in the middle band (two chevrons per 4 m tile, pointing in run direction).
  const bandTop = stripInset + strip + 26;
  const bandBot = S - stripInset - strip - 26;
  const mid = (bandTop + bandBot) / 2;
  const half = (bandBot - bandTop) / 2;
  const chevW = 34;
  emi.save();
  alb.save();
  for (let c = 0; c < 2; c++) {
    const cx = c * (S / 2) + S / 4;
    for (let ox = -S; ox <= S; ox += S) {
      for (const ctx of [emi, alb, hgt]) {
        ctx.beginPath();
        ctx.moveTo(cx + ox - half * 0.55, bandTop);
        ctx.lineTo(cx + ox - half * 0.55 + chevW, bandTop);
        ctx.lineTo(cx + ox + chevW, mid);
        ctx.lineTo(cx + ox - half * 0.55 + chevW, bandBot);
        ctx.lineTo(cx + ox - half * 0.55, bandBot);
        ctx.lineTo(cx + ox, mid);
        ctx.closePath();
        if (ctx === emi) ctx.fillStyle = 'rgb(140,140,140)';
        else if (ctx === alb) ctx.fillStyle = '#2c4a52';
        else ctx.fillStyle = grayCss(0.75);
        ctx.fill();
      }
    }
  }
  emi.restore();
  alb.restore();

  // Panel seams every 2 m with rivets.
  for (let x = 0; x <= S; x += S / 2) {
    alb.fillStyle = '#0a0e14';
    alb.fillRect(x - 2, 0, 4, S);
    hgt.fillStyle = grayCss(0.1);
    hgt.fillRect(x - 2, 0, 4, S);
    for (let y = 40; y < S; y += 56) {
      hgt.fillStyle = grayCss(1);
      hgt.beginPath();
      hgt.arc(x + 9, y, 3, 0, Math.PI * 2);
      hgt.arc(x - 9, y, 3, 0, Math.PI * 2);
      hgt.fill();
    }
  }
  // Small hazard ticks along the strips.
  for (let x = 8; x < S; x += 32) {
    emi.fillStyle = 'rgb(90,90,90)';
    emi.fillRect(x, stripInset + strip + 8, 12, 4);
    emi.fillRect(x, S - stripInset - strip - 12, 12, 4);
  }

  return {
    map: finalizeTexture(albC, THREE.SRGBColorSpace, anisotropy),
    emissiveMap: finalizeTexture(emiC, THREE.SRGBColorSpace, anisotropy),
    roughnessMap: finalizeTexture(rghC, THREE.NoColorSpace, anisotropy),
    normalMap: normalTextureFromHeight(hgt, S, S, 2.0, anisotropy),
  };
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
// Public API
// ---------------------------------------------------------------------------
let cache: ProceduralTextureLibrary | null = null;

/** Generates (once) and returns the full procedural texture library. */
export function getProceduralTextures(renderer: THREE.WebGLRenderer): ProceduralTextureLibrary {
  if (cache) return cache;
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  cache = {
    windows: generateWindowSet(aniso),
    roof: generateRoofSet(aniso),
    roads: generateRoadAtlas(aniso),
    wallPanel: generateWallPanelSet(aniso),
    machinery: generateMachinerySet(aniso),
    neonAtlas: generateNeonAtlas(aniso),
    neonAtlasStrips: NEON_STRIPS.length,
    signAtlas: generateSignAtlas(aniso),
    tech: generateTechSet(aniso),
  };
  return cache;
}
