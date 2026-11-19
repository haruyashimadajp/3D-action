/**
 * STRAND // PROTOCOL — Entry point.
 * Fixed-step simulation (120 Hz, frame clamp 0.05 s) + variable-rate rendering with interpolation,
 * global game clock (bullet-time × hitstop time scaling), scene orchestration.
 */
import * as THREE from 'three';
import {
  FIXED_DT,
  MAX_FRAME_DT,
  GAME_TITLE,
  GAME_SUBTITLE,
  CAMERA,
  PLAYER,
  DEG2RAD,
  type HitstopDef,
  type QualityPreset,
  QUALITY_PRESETS,
  clamp,
  lerpFactor,
} from './config/constants';
import { SECTORS } from './config/skills';
import { Renderer } from './engine/Renderer';
import { getProceduralTextures } from './engine/ProceduralTextures';
import { CityBuilder, type SectorLayout } from './world/CityBuilder';
import { EffectsPool } from './entities/EffectsPool';

// ---------------------------------------------------------------------------
// Game clock: simulation dt = real dt × min(bullet-time scale, hitstop scale).
// Mouse look always uses real dt (handled by the input layer).
// ---------------------------------------------------------------------------
export class GameClock {
  /** Bullet-time scale (1.0 or 0.25). */
  bulletTimeScale = 1.0;
  private hitstopRemainingMs = 0;
  private hitstopScale = 1.0;
  /** Accumulated scaled simulation time (s). */
  simTime = 0;
  /** Accumulated real time (s). */
  realTime = 0;

  /** Starts / extends a hitstop; the strongest (lowest scale) wins while overlapping. */
  hitstop(def: HitstopDef): void {
    if (def.durationMs <= 0) return;
    if (this.hitstopRemainingMs <= 0 || def.timeScale <= this.hitstopScale) {
      this.hitstopScale = def.timeScale;
      this.hitstopRemainingMs = Math.max(this.hitstopRemainingMs, def.durationMs);
    }
  }

  get timeScale(): number {
    return Math.min(this.bulletTimeScale, this.hitstopRemainingMs > 0 ? this.hitstopScale : 1.0);
  }

  get inHitstop(): boolean {
    return this.hitstopRemainingMs > 0;
  }

  /** Advances clocks; returns scaled simulation dt for this frame. */
  advance(realDt: number): number {
    const scaled = realDt * this.timeScale;
    this.realTime += realDt;
    this.simTime += scaled;
    if (this.hitstopRemainingMs > 0) {
      this.hitstopRemainingMs = Math.max(0, this.hitstopRemainingMs - realDt * 1000);
      if (this.hitstopRemainingMs === 0) this.hitstopScale = 1.0;
    }
    return scaled;
  }
}

// ---------------------------------------------------------------------------
// Title-screen attract camera: arc-length-parameterised fly-through of the live district.
// ---------------------------------------------------------------------------
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _look = new THREE.Vector3();
const _t0 = new THREE.Vector3();
const _t1 = new THREE.Vector3();

class AttractCamera {
  private curve: THREE.CatmullRomCurve3 | null = null;
  private length = 1;
  private u = 0;
  private prevU = 0;
  readonly speed = 15.5;
  private roll = 0;

  /** Uses the district's collision-free cinematic loop (low along the avenue, under the expressway, then over the roofs). */
  rebuild(layout: SectorLayout): void {
    this.curve = new THREE.CatmullRomCurve3(layout.cinematicPath.map((p) => p.clone()), true, 'centripetal', 0.5);
    this.curve.arcLengthDivisions = 800;
    this.length = this.curve.getLength();
    this.u = 0;
    this.prevU = 0;
  }

  /** Fixed-step advance. */
  step(dt: number): void {
    this.prevU = this.u;
    this.u = (this.u + (this.speed * dt) / this.length) % 1;
  }

  /** Interpolated pose → camera. Returns the camera world position. */
  apply(camera: THREE.PerspectiveCamera, alpha: number, realDt: number): void {
    if (!this.curve) return;
    let u = this.prevU + (this.u - this.prevU) * alpha;
    if (this.u < this.prevU) u = (this.prevU + (this.u + 1 - this.prevU) * alpha) % 1;
    this.curve.getPointAt(u, _a);
    this.curve.getPointAt((u + 18 / this.length) % 1, _b);
    _look.copy(_b);
    _look.y -= 1.5;
    camera.position.copy(_a);
    camera.lookAt(_look);
    // Bank into turns from tangent change (≤ 9°, same cap as swing roll).
    this.curve.getTangentAt(u, _t0);
    this.curve.getTangentAt((u + 6 / this.length) % 1, _t1);
    const turn = _t0.x * _t1.z - _t0.z * _t1.x;
    const target = clamp(-turn * 2.2, -CAMERA.SWING_ROLL_MAX_DEG * DEG2RAD, CAMERA.SWING_ROLL_MAX_DEG * DEG2RAD);
    this.roll += (target - this.roll) * lerpFactor(CAMERA.SWING_ROLL_LERP, realDt);
    camera.rotateZ(this.roll);
  }
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------
class App {
  private readonly renderer: Renderer;
  private readonly city: CityBuilder;
  private readonly effects: EffectsPool;
  private readonly clock = new GameClock();
  private readonly attract = new AttractCamera();
  private layout: SectorLayout;
  private accumulator = 0;
  private lastFrame = performance.now();
  private readonly camVel = new THREE.Vector3();
  private readonly prevCamPos = new THREE.Vector3();
  private readonly debugEl: HTMLElement | null;
  /** Debug-only frozen camera pose from `?view=x,y,z,yawDeg,pitchDeg` (visual verification). */
  private readonly fixedView: { pos: THREE.Vector3; yaw: number; pitch: number } | null;
  private fpsFrames = 0;
  private fpsTime = 0;
  private fps = 0;

  constructor(container: HTMLElement) {
    this.renderer = new Renderer(container);
    const params = new URLSearchParams(window.location.search);
    const q = params.get('quality')?.toUpperCase();
    if (q && q in QUALITY_PRESETS) this.renderer.setQuality(q as QualityPreset);

    const t0 = performance.now();
    const textures = getProceduralTextures(this.renderer.renderer);
    const t1 = performance.now();
    this.city = new CityBuilder(textures);
    this.renderer.scene.add(this.city.root);
    this.effects = new EffectsPool(this.renderer.scene);

    const sectorParam = clamp(parseInt(params.get('sector') ?? '1', 10) || 1, 1, SECTORS.length);
    this.layout = this.city.buildSector(sectorParam, 0);
    this.city.setGateOpen(params.get('gate') === '1');
    this.attract.rebuild(this.layout);

    const viewParam = params.get('view');
    const view = viewParam?.split(',').map(Number);
    if (viewParam === 'spawn') {
      // Player eye height on the spawn roof, facing the sector centre.
      this.fixedView = {
        pos: this.layout.playerSpawn.clone().setY(this.layout.playerSpawn.y + PLAYER.EYE_HEIGHT),
        yaw: this.layout.playerSpawnYaw,
        pitch: -10 * DEG2RAD,
      };
    } else {
      this.fixedView =
        view && view.length === 5 && view.every((v) => Number.isFinite(v))
          ? { pos: new THREE.Vector3(view[0], view[1], view[2]), yaw: view[3] * DEG2RAD, pitch: view[4] * DEG2RAD }
          : null;
    }

    this.debugEl = params.get('debug') === '1' ? document.getElementById('debug-stats') : null;
    if (this.debugEl) console.info(`[STRAND] procedural textures ${(t1 - t0).toFixed(0)} ms, sector build ${(performance.now() - t1).toFixed(0)} ms`);
    if (this.debugEl) this.debugEl.hidden = false;

    const titleEl = document.getElementById('title-name');
    const subEl = document.getElementById('title-sub');
    const sectorEl = document.getElementById('title-sector');
    if (titleEl) titleEl.textContent = GAME_TITLE;
    if (subEl) subEl.textContent = GAME_SUBTITLE;
    if (sectorEl) sectorEl.textContent = `${this.layout.sector.name} // ${this.layout.sector.subtitle}`;

    this.attract.step(0);
    this.attract.apply(this.renderer.camera, 1, 0);
    this.prevCamPos.copy(this.renderer.camera.position);
  }

  start(): void {
    const frame = (now: number): void => {
      requestAnimationFrame(frame);
      const realDt = Math.min((now - this.lastFrame) / 1000, MAX_FRAME_DT);
      this.lastFrame = now;
      this.tick(realDt);
    };
    requestAnimationFrame(frame);
  }

  private fixedUpdate(dt: number): void {
    this.attract.step(dt);
  }

  private tick(realDt: number): void {
    const simDt = this.clock.advance(realDt);

    // Fixed-step simulation.
    this.accumulator += simDt;
    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < 12) {
      this.fixedUpdate(FIXED_DT);
      this.accumulator -= FIXED_DT;
      steps++;
    }
    if (steps === 12) this.accumulator = 0;
    const alpha = this.accumulator / FIXED_DT;

    // Camera pose (interpolated).
    const cam = this.renderer.camera;
    if (this.fixedView) {
      cam.position.copy(this.fixedView.pos);
      cam.rotation.set(this.fixedView.pitch, this.fixedView.yaw, 0, 'YXZ');
    } else {
      this.attract.apply(cam, alpha, realDt);
    }
    this.renderer.setFov(CAMERA.BASE_FOV);
    if (simDt > 0) this.camVel.subVectors(cam.position, this.prevCamPos).divideScalar(simDt);
    this.prevCamPos.copy(cam.position);

    // World & effects.
    this.city.update(this.clock.simTime, cam.position);
    this.effects.update(simDt, cam.position, this.camVel);

    const fx = this.renderer.postFx;
    fx.speed = this.camVel.length();
    this.renderer.update(realDt);
    this.renderer.render();

    if (this.debugEl) this.updateDebug(realDt);
  }

  private updateDebug(realDt: number): void {
    this.fpsFrames++;
    this.fpsTime += realDt;
    if (this.fpsTime >= 0.5) {
      this.fps = this.fpsFrames / this.fpsTime;
      this.fpsFrames = 0;
      this.fpsTime = 0;
      const info = this.renderer.renderer.info;
      const st = this.layout.stats;
      if (this.debugEl) {
        this.debugEl.textContent =
          `FPS ${this.fps.toFixed(0)}  |  CALLS ${this.renderer.drawCalls}  |  TRIS ${(this.renderer.triangles / 1000).toFixed(1)}k  |  ` +
          `GEO ${info.memory.geometries}  TEX ${info.memory.textures}  |  ${this.renderer.getQuality()}  |  ` +
          `${this.layout.sector.name}\n` +
          `TOWERS ${st.towers}  CARS ${st.cars}  HIGHWAYS ${st.highways}  RAMPS ${st.ramps}  BRIDGES ${st.bridges}  SKYBRIDGES ${st.skybridges}  ` +
          `LAMPS ${st.lamps}  CITY-LIGHTS ${st.cityLights}\n` +
          `COLLIDERS ${this.layout.colliders.length}  WALLRUN ${this.layout.wallRunSurfaces.length}  ANCHORS ${this.layout.anchors.length}  ` +
          `SPAWNS G${this.layout.groundSpawns.length}/H${this.layout.highwaySpawns.length}/S${this.layout.skybridgeSpawns.length}/R${this.layout.roofSpawns.length}/P${this.layout.perchSpawns.length}/A${this.layout.airSpawns.length}`;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
declare global {
  interface Window {
    /** Set once the module has started booting (read by the loading watchdog in index.html). */
    __STRAND_BOOTED__?: boolean;
    /** Shows a fatal error on the loading overlay (defined inline in index.html). */
    strandShowError?: (message: string) => void;
  }
}

function boot(): void {
  window.__STRAND_BOOTED__ = true;
  const container = document.getElementById('app');
  const loading = document.getElementById('loading');
  if (!container) throw new Error('#app container missing');
  // Yield once so the loading overlay paints before the synchronous texture generation.
  // setTimeout (not requestAnimationFrame): rAF never fires in hidden tabs / some embedded previews.
  window.setTimeout(() => {
    try {
      const app = new App(container);
      app.start();
      loading?.classList.add('hidden');
      document.getElementById('title')?.classList.add('visible');
    } catch (err) {
      console.error(err);
      const message = `INITIALISATION FAILED — ${(err as Error).message}`;
      if (window.strandShowError) window.strandShowError(message);
      else if (loading) {
        loading.textContent = message;
        loading.classList.add('error');
      }
    }
  }, 30);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();
