/**
 * STRAND // PROTOCOL — Procedural PBR texture factory (§6.2-2).
 * Everything is generated once at boot with Canvas2D and cached; no external assets.
 *
 *  - Supertall window set (1024²): Albedo / Emissive / Roughness / Normal (Sobel from height)
 *  - Wet rooftop concrete with puddles (512²): Albedo / Roughness (puddle 0.06, wet 0.42) / Normal
 *  - Cyan wall-run panel (512²): Albedo / Emissive (strips + chevrons) / Roughness / Normal
 *  - Hologram neon sign atlas (1024²): 8 vertical katakana / English-symbol strips
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
  wallPanel: Required<PbrTextureSet>;
  machinery: PbrTextureSet;
  neonAtlas: THREE.Texture;
  /** Number of strips in the neon atlas (u is split evenly). */
  neonAtlasStrips: number;
}

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
// ---------------------------------------------------------------------------
function generateWindowSet(anisotropy: number): Required<PbrTextureSet> {
  const S = RENDER.WINDOW_TEX_SIZE;
  const floors = RENDER.WINDOW_FLOORS_PER_TILE;
  const bays = RENDER.WINDOW_BAYS_PER_TILE;
  const floorPx = S / floors;
  const bayPx = S / bays;
  const rng = createRng(0x57a2d);

  const [albC, alb] = makeCanvas(S, S);
  const [emiC, emi] = makeCanvas(S, S);
  const [rghC, rgh] = makeCanvas(S, S);
  const [hgtC, hgt] = makeCanvas(S, S);
  void hgtC;

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
  hexToLinearRgb(COLORS.WINDOW_WARM, warm);
  hexToLinearRgb(COLORS.WINDOW_COOL, cool);
  // Emissive is scaled by material.emissiveIntensity (0.45). Keep final linear luminance <= 0.28.
  const emissiveScale = MATERIALS.BUILDING_GLASS.emissive;
  const maxTexLum = BACKGROUND_MAX_LUMINANCE / emissiveScale;

  const glass = '#0c121d';
  const mullionAlb = '#2a3242';
  const mechanicalFloor = 3; // louvred plant floor inside each 32 m tile (rooftop machine-room vents)
  const frame = 3;
  const mullion = 4;
  const spandrelPx = Math.round(floorPx * 0.16);

  for (let f = 0; f < floors; f++) {
    const fy = f * floorPx;
    // Floor slab / spandrel band at the bottom of each floor.
    alb.fillStyle = '#121720';
    alb.fillRect(0, fy + floorPx - spandrelPx, S, spandrelPx);
    rgh.fillStyle = grayCss(0.58);
    rgh.fillRect(0, fy + floorPx - spandrelPx, S, spandrelPx);
    hgt.fillStyle = grayCss(0.86);
    hgt.fillRect(0, fy + floorPx - spandrelPx, S, spandrelPx);
    // Thin slab edge highlight line.
    alb.fillStyle = '#2b3445';
    alb.fillRect(0, fy + floorPx - spandrelPx, S, 2);
    hgt.fillStyle = grayCss(1.0);
    hgt.fillRect(0, fy + floorPx - spandrelPx, S, 2);

    const isMechanical = f === mechanicalFloor;
    // 2 AM occupancy: whole floors cluster dark or lit (tenants), giving realistic horizontal banding.
    const floorRoll = rng();
    const occupancy = floorRoll < 0.3 ? 0.06 : floorRoll < 0.75 ? 0.38 : 0.78;

    for (let b = 0; b < bays; b++) {
      const bx = b * bayPx;
      const wx = bx + frame;
      const wy = fy + frame;
      const ww = bayPx - frame * 2;
      const wh = floorPx - spandrelPx - frame * 2;

      if (isMechanical) {
        // Louvred ventilation grille of the mechanical plant floor.
        alb.fillStyle = '#1b212c';
        alb.fillRect(wx, wy, ww, wh);
        rgh.fillStyle = grayCss(0.5);
        rgh.fillRect(wx, wy, ww, wh);
        const slat = 6;
        for (let y = wy; y < wy + wh; y += slat) {
          const g = hgt.createLinearGradient(0, y, 0, y + slat);
          g.addColorStop(0, grayCss(0.95));
          g.addColorStop(1, grayCss(0.45));
          hgt.fillStyle = g;
          hgt.fillRect(wx, y, ww, slat);
          alb.fillStyle = 'rgba(70,80,96,0.55)';
          alb.fillRect(wx, y, ww, 1);
        }
        // A few exhaust fans glow very faintly amber through the louvres (maintenance lamps).
        if (rng() < 0.18) {
          const k = Math.min(maxTexLum * 0.35 / linLum(warm[0], warm[1], warm[2]), 1);
          emi.fillStyle = rgbCss(linearToSrgbByte(warm[0] * k), linearToSrgbByte(warm[1] * k), linearToSrgbByte(warm[2] * k));
          emi.fillRect(wx + ww * 0.3, wy + wh * 0.4, ww * 0.4, 3);
        }
        continue;
      }

      // Two panes per bay split by a vertical mullion.
      const paneW = (ww - mullion) / 2;
      for (let p = 0; p < 2; p++) {
        const px = wx + p * (paneW + mullion);
        // Glass base: dark reflective.
        alb.fillStyle = glass;
        alb.fillRect(px, wy, paneW, wh);
        rgh.fillStyle = grayCss(MATERIALS.BUILDING_GLASS.roughness);
        rgh.fillRect(px, wy, paneW, wh);
        hgt.fillStyle = grayCss(0.32);
        hgt.fillRect(px, wy, paneW, wh);

        const lit = rng() < occupancy;
        if (!lit) {
          // Unlit office: faint interior silhouettes barely visible through dark glass.
          alb.fillStyle = 'rgba(20,28,40,0.6)';
          alb.fillRect(px + paneW * 0.1, wy + wh * 0.62, paneW * 0.8, wh * 0.38);
          continue;
        }

        // Lit pane: warm : cool = 3 : 7, with colour-temperature drift.
        const isWarm = rng() < WINDOW_WARM_RATIO;
        const base = isWarm ? warm : cool;
        const drift = (rng() - 0.5) * 0.18;
        let r = base[0] * (1 + drift);
        let g = base[1] * (1 + drift * 0.4);
        let bl = base[2] * (1 - drift);
        const lum = linLum(r, g, bl);
        const brightness = 0.32 + rng() * 0.68;
        const k = (maxTexLum * brightness) / lum;
        r *= k;
        g *= k;
        bl *= k;

        // Interior light falloff: ceiling brighter, floor darker.
        const grad = emi.createLinearGradient(0, wy, 0, wy + wh);
        grad.addColorStop(0, rgbCss(linearToSrgbByte(r), linearToSrgbByte(g), linearToSrgbByte(bl)));
        grad.addColorStop(0.55, rgbCss(linearToSrgbByte(r * 0.82), linearToSrgbByte(g * 0.82), linearToSrgbByte(bl * 0.82)));
        grad.addColorStop(1, rgbCss(linearToSrgbByte(r * 0.45), linearToSrgbByte(g * 0.45), linearToSrgbByte(bl * 0.45)));
        emi.fillStyle = grad;
        emi.fillRect(px, wy, paneW, wh);

        // Ceiling light fixtures (brightest strip — still capped by maxTexLum).
        emi.fillStyle = rgbCss(
          linearToSrgbByte(Math.min(r * 1.0 / brightness, 1)),
          linearToSrgbByte(Math.min(g * 1.0 / brightness, 1)),
          linearToSrgbByte(Math.min(bl * 1.0 / brightness, 1)),
        );
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
          const cover = 0.15 + rng() * 0.8;
          const slat = 4;
          const blindH = wh * cover;
          for (let y = 0; y < blindH; y += slat) {
            emi.fillStyle = 'rgba(0,0,0,0.62)';
            emi.fillRect(px, wy + y, paneW, slat - 1);
            alb.fillStyle = 'rgba(48,54,64,0.85)';
            alb.fillRect(px, wy + y, paneW, slat - 1);
            rgh.fillStyle = grayCss(0.6);
            rgh.fillRect(px, wy + y, paneW, slat - 1);
            hgt.fillStyle = grayCss(0.42);
            hgt.fillRect(px, wy + y, paneW, slat - 1);
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

  // Subtle grime streaks on albedo / roughness (rain run-off).
  for (let i = 0; i < 260; i++) {
    const x = rng() * S;
    const y = rng() * S;
    const len = 20 + rng() * 120;
    alb.fillStyle = `rgba(0,0,0,${0.05 + rng() * 0.08})`;
    alb.fillRect(x, y, 1 + rng() * 2, len);
    rgh.fillStyle = `rgba(255,255,255,${0.03 + rng() * 0.05})`;
    rgh.fillRect(x, y, 1, len);
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
    wallPanel: generateWallPanelSet(aniso),
    machinery: generateMachinerySet(aniso),
    neonAtlas: generateNeonAtlas(aniso),
    neonAtlasStrips: NEON_STRIPS.length,
  };
  return cache;
}
