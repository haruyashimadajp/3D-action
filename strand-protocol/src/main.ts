/**
 * STRAND // PROTOCOL — Entry point.
 * Fixed-step simulation (120 Hz, frame clamp 0.05 s) + variable-rate rendering with interpolation,
 * global game clock (bullet-time × hitstop time scaling), screen flow (title → playing ⇄ paused),
 * scene orchestration: input → equipment → player → projectiles → camera → view-model → HUD → render.
 */
import * as THREE from 'three';
import {
  ACCESSIBILITY,
  FIXED_DT,
  MAX_FRAME_DT,
  GAME_TITLE,
  GAME_SUBTITLE,
  CAMERA,
  PLAYER,
  RENDER,
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
import { InputManager } from './engine/InputManager';
import { CityBuilder, type SectorLayout } from './world/CityBuilder';
import { PhysicsWorld, type HitboxTarget } from './world/PhysicsWorld';
import { EffectsPool, BURST } from './entities/EffectsPool';
import { PlayerController } from './player/PlayerController';
import { EquipmentManager } from './player/EquipmentManager';
import { ViewModelRenderer } from './player/ViewModelRenderer';
import { HudManager, type HudFrame } from './ui/HudManager';

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
type AppState = 'TITLE' | 'PLAYING' | 'PAUSED';

const NO_TARGETS: readonly HitboxTarget[] = [];
const _lookDelta = { yaw: 0, pitch: 0 };
const _proj = new THREE.Vector3();
const _feet = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

class App {
  private readonly renderer: Renderer;
  private readonly city: CityBuilder;
  private readonly effects: EffectsPool;
  private readonly physics = new PhysicsWorld();
  private readonly input: InputManager;
  private readonly viewModel: ViewModelRenderer;
  private readonly player: PlayerController;
  private readonly equipment: EquipmentManager;
  private readonly hud: HudManager;
  private readonly clock = new GameClock();
  private readonly attract = new AttractCamera();
  private layout: SectorLayout;
  private state: AppState = 'TITLE';
  private sectorIndex: number;
  private loop = 0;
  private accumulator = 0;
  private lastFrame = performance.now();
  private readonly camVel = new THREE.Vector3();
  private readonly prevCamPos = new THREE.Vector3();
  private readonly hudFrame: HudFrame;
  /** Death sequence: red/white glitch 250 ms → respawn 250 ms (manual R retry 150 ms). */
  private deathTimer = -1;
  private deathDuration: number = PLAYER.DEATH_RETRY_MS / 1000;
  private splashTimer = 0;
  /** FLOW rank index (0 = D … 6 = SSS); driven by the FLOW system. Speed lines appear from rank B. */
  private flowRankIndex = 0;
  /** Debug-only frozen camera pose from `?view=x,y,z,yawDeg,pitchDeg` or `?view=spawn` (title screen). */
  private readonly fixedView: { pos: THREE.Vector3; yaw: number; pitch: number } | null;
  private readonly debugEl: HTMLElement | null;
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

    this.input = new InputManager(this.renderer.renderer.domElement);
    this.viewModel = new ViewModelRenderer(this.renderer.viewModelScene, this.renderer.viewModelCamera);
    this.viewModel.root.visible = false;
    this.player = new PlayerController(this.input, this.physics, {
      onLand: (fall, water) => {
        if (water) this.effects.burst(this.player.position, UP, BURST.LAND_SPLASH);
        else if (fall > 14) this.effects.burst(_feet.copy(this.player.position).setY(this.player.position.y + 0.05), UP, BURST.SPARK);
      },
      onGrappleDetach: (mode) => this.equipment.onRopeDetached(mode),
      onDamaged: () => {
        this.renderer.postFx.damageFlash = 1;
        this.renderer.triggerChromaSpike(RENDER.CHROMA_SPIKE, 220);
      },
      onDeath: () => this.beginDeath(PLAYER.DEATH_RETRY_MS),
    });
    this.equipment = new EquipmentManager(this.input, this.player, this.physics, this.effects, this.renderer, this.viewModel, this.renderer.scene);
    this.hud = new HudManager();
    this.hudFrame = {
      slot: 'PISTOL',
      pendingSlot: null,
      gear: 'IDLE',
      switchProgress: -1,
      reloadProgress: -1,
      ammo: 0,
      magazine: 0,
      ropeAttached: false,
      grappleCooldown: 0,
      btGauge: 100,
      btActive: false,
      hp: 100,
      maxHp: 100,
      regenCountdown: 1,
      regenerating: false,
      sinceShot: 10,
      speed: 0,
      altitude: 0,
      anchorVisible: false,
      anchorX: 0,
      anchorY: 0,
      anchorStrong: false,
      centerDot: ACCESSIBILITY.CENTER_DOT_DEFAULT,
    };

    this.sectorIndex = clamp(parseInt(params.get('sector') ?? '1', 10) || 1, 1, SECTORS.length);
    this.layout = this.buildSector(this.sectorIndex);
    if (params.get('gate') === '1') this.setGateOpen(true);

    const viewParam = params.get('view');
    const view = viewParam?.split(',').map(Number);
    if (viewParam === 'spawn') {
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
    if (this.debugEl) {
      // Debug-only handle for automated mechanic verification (never exposed without ?debug=1).
      window.__STRAND_DEBUG__ = { player: this.player, equipment: this.equipment, physics: this.physics, layout: () => this.layout, input: this.input };
      console.info(`[STRAND] procedural textures ${(t1 - t0).toFixed(0)} ms, sector build ${(performance.now() - t1).toFixed(0)} ms`);
      this.debugEl.hidden = false;
    }

    const titleEl = document.getElementById('title-name');
    const subEl = document.getElementById('title-sub');
    if (titleEl) titleEl.textContent = GAME_TITLE;
    if (subEl) subEl.textContent = GAME_SUBTITLE;
    this.updateSectorLabel();

    // --- Screen flow ---
    document.getElementById('title-start')?.addEventListener('click', () => this.deploy());
    document.getElementById('pause')?.addEventListener('click', () => this.input.requestPointerLock());
    this.input.onPointerLockChange((locked) => {
      if (locked && this.state === 'PAUSED') this.setState('PLAYING');
      else if (!locked && this.state === 'PLAYING') this.setState('PAUSED');
    });

    this.attract.step(0);
    this.attract.apply(this.renderer.camera, 1, 0);
    this.prevCamPos.copy(this.renderer.camera.position);
  }

  private buildSector(index: number): SectorLayout {
    const layout = this.city.buildSector(index, this.loop);
    this.physics.setLayout(layout);
    this.attract.rebuild(layout);
    this.layout = layout;
    return layout;
  }

  private setGateOpen(open: boolean): void {
    this.city.setGateOpen(open);
    this.physics.setGateOpen(open);
  }

  private updateSectorLabel(): void {
    const sectorEl = document.getElementById('title-sector');
    if (sectorEl) sectorEl.textContent = `${this.layout.sector.name} // ${this.layout.sector.subtitle}`;
  }

  private setState(s: AppState): void {
    this.state = s;
    const playing = s === 'PLAYING';
    this.input.gameplayEnabled = playing;
    this.input.setUnloadGuard(s !== 'TITLE');
    document.getElementById('pause')?.classList.toggle('visible', s === 'PAUSED');
    document.getElementById('title')?.classList.toggle('playing', s !== 'TITLE');
    this.hud.setVisible(s !== 'TITLE');
    this.viewModel.root.visible = s !== 'TITLE';
  }

  /** Title → drop into the district at the avenue spawn with the rail pistol drawn. */
  private deploy(): void {
    this.spawnPlayer();
    this.setState('PLAYING');
    this.input.requestPointerLock();
  }

  private spawnPlayer(): void {
    this.player.spawn(this.layout.playerSpawn, this.layout.playerSpawnYaw);
    this.equipment.reset();
    this.effects.clearProjectiles();
    this.accumulator = 0;
    this.deathTimer = -1;
    this.renderer.postFx.glitch = 0;
    this.renderer.postFx.fade = 0;
    this.renderer.postFx.critical = 0;
  }

  private beginDeath(totalMs: number): void {
    this.deathDuration = totalMs / 1000;
    this.deathTimer = 0;
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

  private readonly targetsFor = (): readonly HitboxTarget[] => NO_TARGETS;

  private readonly onImpact = (): void => {
    // World impacts already emit sparks / splashes inside the pool; humanoid hits arrive with the enemy system.
  };

  private fixedUpdate(dt: number): void {
    if (this.state === 'TITLE') {
      this.attract.step(dt);
      return;
    }
    if (this.state !== 'PLAYING') return;
    const cam = this.renderer.camera;
    this.equipment.fixedUpdate(dt, cam);
    this.player.fixedUpdate(dt, this.equipment.stepContext());
    this.effects.updateProjectiles(dt, this.physics, this.targetsFor, this.onImpact);
    this.input.markStep();
  }

  private tick(realDt: number): void {
    const playing = this.state === 'PLAYING';
    const cam = this.renderer.camera;

    // --- Real-time input: look, discrete actions, bullet time ---
    _lookDelta.yaw = 0;
    _lookDelta.pitch = 0;
    if (playing) {
      this.input.consumeLook(_lookDelta);
      this.player.applyLook(_lookDelta.yaw, _lookDelta.pitch);
      for (const a of this.equipment.handleActions()) {
        if (a === 'PAUSE') this.input.exitPointerLock();
        else if (a === 'FULLSCREEN') this.input.toggleFullscreen();
        else if (a === 'RELOAD' && this.deathTimer >= 0 && this.deathTimer < this.deathDuration - PLAYER.MANUAL_RETRY_MS / 1000) {
          // Manual instant retry from the death screen (150 ms).
          this.deathTimer = this.deathDuration - PLAYER.MANUAL_RETRY_MS / 1000;
        }
      }
      this.player.updateBulletTime(realDt);
      this.clock.bulletTimeScale = this.player.timeScaleRequest;
    } else {
      this.clock.bulletTimeScale = 1;
    }

    // --- Death → retry sequence (real time): glitch 250 ms, then respawn ---
    if (playing && this.deathTimer >= 0) {
      this.deathTimer += realDt;
      const glitchEnd = PLAYER.DEATH_GLITCH_MS / 1000;
      const fx = this.renderer.postFx;
      fx.glitch = clamp(this.deathTimer / glitchEnd, 0, 1);
      fx.fade = clamp((this.deathTimer - glitchEnd * 0.5) / glitchEnd, 0, 1);
      if (this.deathTimer >= this.deathDuration) this.spawnPlayer();
    }

    // --- Simulation clock (frozen while paused) ---
    const simDt = this.state === 'PAUSED' ? 0 : this.clock.advance(realDt);
    this.accumulator += simDt;
    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < 12) {
      this.fixedUpdate(FIXED_DT);
      this.accumulator -= FIXED_DT;
      steps++;
    }
    if (steps === 12) this.accumulator = 0;
    const alpha = this.accumulator / FIXED_DT;

    // --- Camera ---
    const fx = this.renderer.postFx;
    if (this.state === 'TITLE') {
      if (this.fixedView) {
        cam.position.copy(this.fixedView.pos);
        cam.rotation.set(this.fixedView.pitch, this.fixedView.yaw, 0, 'YXZ');
      } else {
        this.attract.apply(cam, alpha, realDt);
      }
      this.renderer.setFov(CAMERA.BASE_FOV);
      if (simDt > 0) this.camVel.subVectors(cam.position, this.prevCamPos).divideScalar(simDt);
      fx.speed = this.camVel.length();
      fx.bulletTime = 0;
      fx.speedLines = 0;
    } else {
      this.player.updateCamera(this.state === 'PAUSED' ? 0 : realDt, alpha, cam);
      cam.updateMatrixWorld();
      this.viewModel.syncEnvironment(this.player.cameraEuler);
      this.equipment.frameUpdate(this.state === 'PAUSED' ? 0 : realDt, cam, _lookDelta.yaw, _lookDelta.pitch);
      this.camVel.copy(this.player.velocity);
      fx.speed = this.player.speed;
      fx.bulletTime += ((this.player.btActive ? 1 : 0) - fx.bulletTime) * lerpFactor(14, realDt);
      fx.critical += ((this.player.isCritical && this.player.isAlive ? 1 : 0) - fx.critical) * lerpFactor(6, realDt);
      // Speed lines (§6.2 Pass 4 · FLOW table): from rank B at ≥ 18 m/s, denser with rank, always dense at SSS.
      const sp = this.player.speed;
      const sl = this.flowRankIndex >= 6 ? 1 : this.flowRankIndex >= 2 ? clamp((sp - RENDER.SPEEDLINE_MIN_SPEED) / 14, 0, 1) * (0.35 + 0.13 * (this.flowRankIndex - 2)) : 0;
      fx.speedLines += (sl - fx.speedLines) * lerpFactor(8, realDt);
      fx.speedLineDensity = this.flowRankIndex >= 6 ? 1 : 0.3 + 0.1 * Math.max(0, this.flowRankIndex - 2);
      // Shallow canal: wake splashes while wading.
      this.splashTimer -= simDt;
      if (this.player.isInWater && this.player.speed > 2 && this.splashTimer <= 0) {
        this.splashTimer = 0.12;
        this.effects.burst(this.player.position, UP, BURST.WATER);
      }
      this.updateHud();
    }
    this.prevCamPos.copy(cam.position);

    // --- World & effects ---
    this.city.update(this.clock.simTime, cam.position);
    this.effects.update(simDt, realDt, cam.position, this.camVel);
    this.renderer.update(realDt);
    this.renderer.render();

    if (this.debugEl) this.updateDebug();
  }

  private updateHud(): void {
    const f = this.hudFrame;
    const e = this.equipment;
    const p = this.player;
    f.slot = e.activeSlot;
    f.pendingSlot = e.pendingSlot;
    f.gear = e.state;
    f.switchProgress = e.switchProgress;
    f.reloadProgress = e.reloadProgress;
    f.ammo = e.vmFrame.ammo;
    f.magazine = e.vmFrame.magazine;
    f.ropeAttached = p.ropeAttached;
    f.grappleCooldown = e.grappleCooldown;
    f.btGauge = p.btGauge;
    f.btActive = p.btActive;
    f.hp = p.hp;
    f.maxHp = p.maxHp;
    f.regenCountdown = p.regenCountdown;
    f.regenerating = p.isRegenerating;
    f.sinceShot = e.sinceShot;
    f.speed = p.speed;
    f.altitude = p.position.y;
    const an = e.snap.anchor;
    f.anchorVisible = false;
    if (an && p.isAlive) {
      _proj.copy(an.position).project(this.renderer.camera);
      if (_proj.z < 1) {
        f.anchorVisible = true;
        f.anchorX = (_proj.x * 0.5 + 0.5) * this.renderer.viewportWidth;
        f.anchorY = (-_proj.y * 0.5 + 0.5) * this.renderer.viewportHeight;
        f.anchorStrong = e.activeSlot === 'GRAPPLE';
      }
    }
    this.hud.update(f);
  }

  private fpsLast = performance.now();

  private updateDebug(): void {
    this.fpsFrames++;
    const now = performance.now();
    this.fpsTime += (now - this.fpsLast) / 1000; // unclamped wall time
    this.fpsLast = now;
    if (this.fpsTime < 0.5) return;
    this.fps = this.fpsFrames / this.fpsTime;
    this.fpsFrames = 0;
    this.fpsTime = 0;
    const info = this.renderer.renderer.info;
    const st = this.layout.stats;
    const p = this.player;
    if (!this.debugEl) return;
    this.debugEl.textContent =
      `FPS ${this.fps.toFixed(0)}  |  CALLS ${this.renderer.drawCalls}  |  TRIS ${(this.renderer.triangles / 1000).toFixed(1)}k  |  ` +
      `GEO ${info.memory.geometries}  TEX ${info.memory.textures}  |  ${this.renderer.getQuality()}  |  ${this.layout.sector.name}  |  ${this.state}\n` +
      `TOWERS ${st.towers}  CARS ${st.cars}  HIGHWAYS ${st.highways}  RAMPS ${st.ramps}  BRIDGES ${st.bridges}  SKYBRIDGES ${st.skybridges}  ` +
      `LAMPS ${st.lamps}  CITY-LIGHTS ${st.cityLights}\n` +
      `COLLIDERS ${this.layout.colliders.length}  WALLRUN ${this.layout.wallRunSurfaces.length}  ANCHORS ${this.layout.anchors.length}\n` +
      `PLAYER ${p.state}  POS ${p.position.x.toFixed(1)},${p.position.y.toFixed(2)},${p.position.z.toFixed(1)}  SPD ${p.speed.toFixed(1)}  ` +
      `GEAR ${this.equipment.activeSlot}/${this.equipment.state}  ROPE ${p.ropeAttached ? p.ropeLength.toFixed(1) : '-'}  BT ${p.btGauge.toFixed(0)}`;
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
    /** Debug handle (only with ?debug=1). */
    __STRAND_DEBUG__?: Record<string, unknown>;
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
