/**
 * STRAND // PROTOCOL — Entry point.
 * Fixed-step simulation (120 Hz, frame clamp 0.05 s) + variable-rate rendering with interpolation,
 * global game clock (bullet-time × hitstop time scaling), screen flow
 * (title → playing ⇄ paused → skill choice → gate transition → … → Sector 05 result → endless loop),
 * scene orchestration: input → equipment → player → enemies → projectiles → camera → view-model → HUD → render.
 * Also hosts the FLOW RANK system (§2.4) and the runtime triggers of the 15 roguelite skills (§8.2).
 */
import * as THREE from 'three';
import {
  AUDIO,
  FIXED_DT,
  MAX_FRAME_DT,
  GAME_TITLE,
  GAME_SUBTITLE,
  CAMERA,
  CITY_FX,
  FLOW_POINTS,
  FLOW_RANKS,
  INPUT,
  PLAYER,
  RENDER,
  DEG2RAD,
  type HitstopDef,
  type QualityPreset,
  QUALITY_PRESETS,
  clamp,
  lerpFactor,
} from './config/constants';
import {
  ENERGY_COLORS,
  MODIFIERS,
  ONE_SHOT_HP,
  SECTORS,
  SKILL_BY_ID,
  SKILL_CONSTANTS,
  SKILLS,
  averageFlowRankIndex,
  checkHeadshotUnlock,
  computeRunRank,
  createDerivedModifiers,
  createRunStats,
  deriveModifiers,
  emptySkillLevels,
  headshotRate,
  modifierScoreMultiplier,
  recordRun,
  rollSkillChoices,
  skillValue,
  skillValue2,
  type EnergyColorId,
  type ModifierId,
  type RunStats,
  type SaveSettings,
  type SkillId,
  type SkillLevels,
} from './config/skills';
import { AudioEngine } from './engine/AudioEngine';
import { Renderer } from './engine/Renderer';
import { getProceduralTextures } from './engine/ProceduralTextures';
import { InputManager } from './engine/InputManager';
import { CityBuilder, type SectorLayout, blimpPose, lightningAt } from './world/CityBuilder';
import { PhysicsWorld, type HitboxTarget } from './world/PhysicsWorld';
import { EffectsPool, BURST, type ProjectileImpact, type ProjectileOwner, type ProjectileSpec } from './entities/EffectsPool';
import { EnemyManager, RICOCHET_TAG, type HitMarkerKind, type KillInfo } from './entities/EnemyManager';
import { PlayerController } from './player/PlayerController';
import { EquipmentManager } from './player/EquipmentManager';
import { ViewModelRenderer } from './player/ViewModelRenderer';
import { HUD_MAX_AWARE, HUD_MAX_TRACKS, HUD_MAX_WARNINGS, HudManager, SaveStore, formatTime, type HudFrame } from './ui/HudManager';

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
// §2.4 FLOW RANK: points from technical actions, multi-kill bonus, decay after 3.5 s, −40 % on hit
// (at most one rank lost per hit). Runs on simulation time (bullet time stretches the windows).
// ---------------------------------------------------------------------------
export class FlowSystem {
  points = 0;
  rankIndex = 0;
  /** FLOW points earned this loop (before decay) — the run's FLOW score base. */
  earned = 0;
  peak = 0;
  private sinceGain = 1e9;
  private lastKillAt = -1e9;
  private chain = 0;
  private time = 0;

  reset(): void {
    this.points = 0;
    this.rankIndex = 0;
    this.earned = 0;
    this.peak = 0;
    this.sinceGain = 1e9;
    this.lastKillAt = -1e9;
    this.chain = 0;
  }

  /** Clears the per-loop score but keeps the current rank (endless loops / new run). */
  resetScore(): void {
    this.earned = 0;
    this.peak = this.points;
  }

  add(points: number): void {
    this.points += points;
    this.earned += points;
    this.sinceGain = 0;
    if (this.points > this.peak) this.peak = this.points;
    this.updateRank();
  }

  /** Kill points: body 100 / HS 220 + air 80 | wall-run 100 | swing 120, × multi-kill (+25 % per chained kill within 2.5 s, max +100 %). */
  kill(info: KillInfo, out: { label: string; points: number }): void {
    const P = FLOW_POINTS;
    let pts = info.headshot ? P.HEADSHOT_KILL : P.BODY_KILL;
    let tag = '';
    // 8A-5: +120 for killing an UNAWARE / ALERT enemy (STEALTH KILL / STEALTH HS).
    if (info.stealth) {
      pts += P.STEALTH_KILL_BONUS;
      tag = 'STEALTH ';
    }
    if (info.swinging) {
      pts += P.SWING_KILL_BONUS;
      tag = 'SWING ';
    } else if (info.wallRun) {
      pts += P.WALLRUN_KILL_BONUS;
      tag = 'WALLRUN ';
    } else if (info.airborne) {
      pts += P.AIR_KILL_BONUS;
      tag = 'AIR ';
    }
    if (this.time - this.lastKillAt <= P.MULTIKILL_WINDOW_MS / 1000) this.chain++;
    else this.chain = 0;
    this.lastKillAt = this.time;
    const mult = 1 + Math.min(P.MULTIKILL_MAX, P.MULTIKILL_STEP * this.chain);
    out.points = Math.round(pts * mult);
    out.label = `${tag}${info.headshot ? (info.stealth ? 'HS' : 'HEADSHOT') : 'KILL'}${mult > 1 ? ` ×${mult.toFixed(2)}` : ''}`;
    this.add(out.points);
  }

  /** Player hit: −40 % of the current points, never more than one rank down. */
  hit(): void {
    const floor = this.rankIndex > 0 ? FLOW_RANKS[this.rankIndex - 1].minPoints : 0;
    this.points = Math.max(floor, this.points * (1 - FLOW_POINTS.HIT_PENALTY_RATIO));
    this.updateRank();
  }

  update(dt: number): void {
    this.time += dt;
    this.sinceGain += dt;
    if (this.sinceGain * 1000 > FLOW_POINTS.DECAY_DELAY_MS && this.points > 0) {
      this.points = Math.max(0, this.points - FLOW_RANKS[this.rankIndex].decayPerS * dt);
      this.updateRank();
    }
  }

  private updateRank(): void {
    let r = 0;
    for (let i = FLOW_RANKS.length - 1; i >= 0; i--) {
      if (this.points >= FLOW_RANKS[i].minPoints) {
        r = i;
        break;
      }
    }
    this.rankIndex = r;
  }

  /** 0..1 toward the next rank (1 at SSS). */
  get progress(): number {
    const r = this.rankIndex;
    if (r >= FLOW_RANKS.length - 1) return 1;
    const lo = FLOW_RANKS[r].minPoints;
    return clamp((this.points - lo) / (FLOW_RANKS[r + 1].minPoints - lo), 0, 1);
  }

  /** 1 → 0 across the 3.5 s grace before decay starts. */
  get decayGrace(): number {
    return clamp(1 - (this.sinceGain * 1000) / FLOW_POINTS.DECAY_DELAY_MS, 0, 1);
  }
}

// ---------------------------------------------------------------------------
// Title-screen attract camera: arc-length-parameterised fly-through of the live district.
// ---------------------------------------------------------------------------
/** 7A-4: ADS target read-out cone (deg) and scratch. */
const AIM_HP_MAX_DEG = 3.5;
/** 7B-8: seconds without shots, hits or telegraph locks before the HUD settles. */
const ADAPTIVE_HUD_QUIET_S = 4.0;
const _groundQ = new THREE.Vector3();
const _aimFwd = new THREE.Vector3();
const _aimInfo = { hp: 0, maxHp: 1, name: '', dist: 0 };
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
type AppState = 'TITLE' | 'PLAYING' | 'PAUSED' | 'SKILL' | 'TRANSITION' | 'RESULT';

const _lookDelta = { yaw: 0, pitch: 0 };
const _camRight = new THREE.Vector3();
const _camUp = new THREE.Vector3();
const _camBack = new THREE.Vector3();
const _camFwd = new THREE.Vector3();
const _toSrc = new THREE.Vector3();
const _bossStatus = { hp: 0, maxHp: 1, wingL: 1, wingR: 1, phase: 1, downed: false };
const _proj = new THREE.Vector3();
const _awarePos = Array.from({ length: HUD_MAX_AWARE }, () => new THREE.Vector3());
const _feet = new THREE.Vector3();
const _chest = new THREE.Vector3();
const _killPos = new THREE.Vector3();
const _ricoDir = new THREE.Vector3();
const _ricoTargets = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const _flowOut = { label: '', points: 0 };
const UP = new THREE.Vector3(0, 1, 0);
const _trkPos = Array.from({ length: HUD_MAX_TRACKS }, () => new THREE.Vector3());
const _trkBoss = new Uint8Array(HUD_MAX_TRACKS);
/** Tracking diamonds clamp this far inside the screen edge (px). */
const TRACK_EDGE_MARGIN_PX = 44;
/** Volume-slider preview tick throttle (s). */
const VOLUME_TICK_S = 0.06;
/** 5B-5 speed lines: FLOW D / C intensity at ≥ 18 m/s and the on-ramp downhill slide boost. */
const SPEEDLINE_LOW_RANK = 0.22;
const SPEEDLINE_RAMP_BOOST = 0.2;

/** Delay between the last kill and the skill modal / result screen (lets the kill juice play out). */
const CLEAR_TO_MODAL_S = 1.0;
const CLEAR_TO_RESULT_S = 2.8;
/** District transition: fade out, rebuild, fade in. */
const TRANSITION_FADE_S = 0.3;
/** Crossing the opened gate plane by this much (m) starts the transition. */
const GATE_CROSS_M = 1.2;
/** SK_12: radius of "surrounding" enemy rounds slowed on a graze (spec leaves it open). */
const PHANTOM_GRAZE_RADIUS_M = 15;

/** SK_15 ricochet round: 55 damage, interrupts the target's telegraph. */
const RICOCHET_SPEC: ProjectileSpec = {
  owner: 'PLAYER',
  speed: 240,
  range: SKILL_CONSTANTS.RICOCHET_RANGE_M + 4,
  damage: 55,
  headMultiplier: 1,
  shieldMultiplier: 1,
  color: 0xffd35a,
  intensity: 3.6,
  width: 0.026,
  tag: RICOCHET_TAG,
};

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
  private readonly enemies: EnemyManager;
  private readonly audio = new AudioEngine();
  private readonly store = new SaveStore();
  private readonly clock = new GameClock();
  private readonly flow = new FlowSystem();
  /** `?gate=1` debug: keep the district gate open. */
  private readonly debugGate: boolean;
  /** `?quality=` overrides the saved preset for this session. */
  private readonly qualityOverride: boolean;
  private readonly attract = new AttractCamera();
  private layout: SectorLayout;
  private state: AppState = 'TITLE';
  private sectorIndex: number;
  private readonly startSector: number;
  private loop = 0;
  private accumulator = 0;
  private lastFrame = performance.now();
  private readonly camVel = new THREE.Vector3();
  private readonly prevCamPos = new THREE.Vector3();
  /** 7B-8: sim time of the last enemy telegraph lock. */
  private lastLockAt = -1e9;
  private readonly hudFrame: HudFrame;
  /** Death sequence: red/white glitch 250 ms → respawn 250 ms (manual R retry 150 ms). */
  private deathTimer = -1;
  private deathDuration: number = PLAYER.DEATH_RETRY_MS / 1000;
  private splashTimer = 0;
  /** FLOW rank index (0 = D … 6 = SSS) currently applied to visuals / audio. */
  private flowRankIndex = -1;
  /** HUD sector label (rebuilt only when the district or loop changes — no per-frame strings). */
  private sectorLabel = '';

  // ---- run / progression ----
  private skills: SkillLevels = emptySkillLevels();
  private readonly derived = createDerivedModifiers();
  private activeMods = new Set<ModifierId>();
  private stats: RunStats = createRunStats(1);
  /** Seconds until the pending clear action (skill modal or result) runs; −1 = none. */
  private clearTimer = -1;
  private clearAction: 'SKILL' | 'RESULT' | null = null;
  /** The cleared sector's skill has been chosen (or none was available): the gate may be crossed. */
  private gateReady = false;
  private transitionT = -1;
  private transitionBuilt = false;
  /** SK_11: kills inside the current bullet-time activation. */
  private btKills = 0;
  /** 5A-6 wall-run boot tap timer (simulation s). */
  private wallStepTimer = 0;
  /** 5A-5: the pause overlay is the light "PROTOCOL INSTALLED — CLICK TO DEPLOY" variant. */
  private pauseMini = false;
  private lastVolumeTick = -1;

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
    this.qualityOverride = !!q && q in QUALITY_PRESETS;
    if (this.qualityOverride) this.renderer.setQuality(q as QualityPreset);

    const t0 = performance.now();
    const textures = getProceduralTextures(this.renderer.renderer);
    const t1 = performance.now();
    this.city = new CityBuilder(textures);
    if (this.qualityOverride) this.city.setQuality(q as QualityPreset);
    this.renderer.scene.add(this.city.root);
    this.effects = new EffectsPool(this.renderer.scene);
    // 7B-7: rain splashes land on the first surface under their spot (street, deck, roof, puddle).
    this.effects.setGroundQuery((x, y, z) => this.physics.probeGround(_groundQ.set(x, y, z), 0.05, 6.5));

    this.input = new InputManager(this.renderer.renderer.domElement);
    this.viewModel = new ViewModelRenderer(this.renderer.viewModelScene, this.renderer.viewModelCamera, textures);
    this.viewModel.root.visible = false;
    const audio = this.audio;
    this.player = new PlayerController(this.input, this.physics, {
      onJump: () => audio.jump(),
      onWallKick: () => audio.jump(),
      onSlideStart: () => audio.slide(),
      onMantle: () => {
        audio.mantle();
        this.viewModel.onMantle();
      },
      onCrouch: (down) => audio.crouch(down),
      onLand: (fall, water) => {
        if (water) this.effects.burst(this.player.position, UP, BURST.LAND_SPLASH);
        else if (fall > 14) this.effects.burst(_feet.copy(this.player.position).setY(this.player.position.y + 0.05), UP, BURST.SPARK);
        if (fall > 6 || water) audio.land(fall, water);
      },
      onGrappleAttach: () => this.enemies.onRopeChanged(),
      onGrappleDetach: (mode) => {
        this.enemies.onRopeChanged();
        this.equipment.onRopeDetached(mode);
      },
      onBulletTime: (active) => this.onBulletTime(active),
      onBulletTimeDenied: () => this.hud.btDenied(),
      onRegenStart: () => audio.regenStart(),
      onDamaged: () => {
        this.renderer.postFx.damageFlash = 1;
        this.renderer.triggerChromaSpike(RENDER.CHROMA_SPIKE, 220);
        audio.playerHit();
        this.flow.hit();
      },
      onDeath: () => {
        this.stats.deaths++;
        audio.death();
        // 5A-5: the one-line cause during the glitch blackout.
        this.hud.eliminated(this.enemies.lastHitCause || 'SYSTEM FAILURE');
        this.beginDeath(PLAYER.DEATH_RETRY_MS);
      },
    });
    this.equipment = new EquipmentManager(this.input, this.player, this.physics, this.effects, this.renderer, this.viewModel, this.renderer.scene, {
      onShot: (gun, ammoLeft, airborne) => audio.gunshot(gun, ammoLeft, airborne),
      // 8A-5 acoustic sensing: 14 m suppressed pistol, 58 m rail sniper, 8 m grapple hiss.
      onGunshot: (origin, radius) => this.enemies.onPlayerGunshot(origin, radius),
      onDryFire: () => audio.dryFire(),
      onZoom: (on) => audio.zoom(on),
      onSwitchStart: (to) => audio.switchGear(to),
      onReloadStart: () => audio.reload(true),
      onReloadDone: () => audio.reload(false),
      onReloadCue: (gun, cue) => {
        audio.reloadCue(cue);
        this.viewModel.onReloadCue(gun, cue);
      },
      onHookFired: () => audio.strandFire(),
      onHookAttached: () => audio.strandAnchor(),
      onHookMissed: () => audio.strandMiss(),
    });
    this.hud = new HudManager();
    this.enemies = new EnemyManager(this.renderer.scene, this.physics, this.effects, this.player, this.renderer, {
      onHitstop: (def: HitstopDef) => this.clock.hitstop(def),
      onHitMarker: (kind) => this.onHitMarker(kind),
      onKill: (info) => this.onKill(info),
      onGraze: () => this.onGraze(),
      onLockStart: (_kind, pos, lockS, sniper) => {
        this.lastLockAt = this.player.clockS;
        audio.lock(pos, lockS / Math.max(this.clock.bulletTimeScale, 0.05), sniper);
      },
      onEnemyFire: (kind, pos, sniper) => audio.enemyFire(kind, pos, sniper),
      onShieldBreak: (pos, weapon) => this.onPartBreak(pos, weapon, 'SHIELD BREAK'),
      onBossPartBreak: (pos, weapon) => this.onPartBreak(pos, weapon, 'WING BREAK'),
      onBossPhase: (phase) => {
        if (phase === 2) this.hud.flowLog('VALKYRIE // PHASE 2', 0, 'skill');
      },
      onBossDefeated: (pos) => audio.bossKill(pos),
      onPlayerHit: (_damage, from) => this.hud.damageFrom(this.screenAngle(from)),
      onArmorDeflect: () => this.hud.armorAlert(),
      onWaveStart: (wave, waves) => {
        if (wave > 1) this.hud.flowLog(`WAVE ${wave}/${waves}`, 0, 'skill');
      },
      onSectorClear: () => this.onSectorCleared(),
      onExplosion: (pos) => audio.explosion(pos),
      onAlertState: (kind) => {
        // 8A-5 awareness cues: suspicion hum, spotted sting, radio alarm, all-clear.
        if (this.state !== 'PLAYING') return;
        if (kind === 'ALERT' || kind === 'DETECTED' || kind === 'GLOBAL_COMBAT' || kind === 'DEESCALATE') audio.awareness(kind);
        if (kind === 'GLOBAL_COMBAT') this.hud.flowLog('DISTRICT ALERT — COMBAT', 0, 'skill');
        else if (kind === 'DEESCALATE') this.hud.flowLog('SEARCH ABANDONED — ALERT', 0, 'skill');
      },
    });
    // The strand can bite straight into humanoids / drones / the boss (15 dmg + stagger, anchor follows).
    this.equipment.combat = {
      targets: () => this.enemies.grappleTargets,
      onGrappleTarget: (target, point) => this.enemies.onGrappleTarget(target, point),
    };
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
      centerDot: true,
      realDt: 0,
      warnCount: 0,
      warnAngles: new Float32Array(HUD_MAX_WARNINGS),
      sectorName: '',
      remaining: 0,
      gateOpen: false,
      bossVisible: false,
      bossHp: 0,
      bossMaxHp: 1,
      bossWingL: 1,
      bossWingR: 1,
      bossPhase: 1,
      bossDowned: false,
      zoom: 0,
      calm: false,
      aimVisible: false,
      aimFrac: 1,
      aimName: '',
      reticleKick: 0,
      buffPierce: 0,
      buffZero: false,
      buffAdren: false,
      trackCount: 0,
      trackX: new Float32Array(HUD_MAX_TRACKS),
      trackY: new Float32Array(HUD_MAX_TRACKS),
      trackDist: new Float32Array(HUD_MAX_TRACKS),
      trackOff: new Uint8Array(HUD_MAX_TRACKS),
      trackBoss: new Uint8Array(HUD_MAX_TRACKS),
      awareCount: 0,
      awareAngles: new Float32Array(HUD_MAX_AWARE),
      awareGauge: new Float32Array(HUD_MAX_AWARE),
      awareRank: new Uint8Array(HUD_MAX_AWARE),
      alertTag: '',
    };

    this.startSector = clamp(parseInt(params.get('sector') ?? '1', 10) || 1, 1, SECTORS.length);
    this.sectorIndex = this.startSector;
    this.layout = this.buildSector(this.sectorIndex);
    this.debugGate = params.get('gate') === '1';
    if (this.debugGate) this.setGateOpen(true);

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
      window.__STRAND_DEBUG__ = {
        app: this,
        player: this.player,
        equipment: this.equipment,
        physics: this.physics,
        enemies: this.enemies,
        effects: this.effects,
        clock: this.clock,
        flow: this.flow,
        audio: this.audio,
        hud: this.hud,
        store: this.store,
        layout: () => this.layout,
        input: this.input,
        renderer: this.renderer,
        // 7B-5 verification helpers (deterministic blimp orbit / lightning schedule).
        cityFx: {
          blimpPose: (i: number, t: number) => {
            const o = { x: 0, y: 0, z: 0, yaw: 0 };
            blimpPose(CITY_FX.BLIMPS[i], t, o);
            return o;
          },
          lightningAt,
        },
      };
      console.info(`[STRAND] procedural textures ${(t1 - t0).toFixed(0)} ms, sector build ${(performance.now() - t1).toFixed(0)} ms`);
      this.debugEl.hidden = false;
    }

    const titleEl = document.getElementById('title-name');
    const subEl = document.getElementById('title-sub');
    // The wordmark is an inline SVG (5B-5); keep the name for assistive tech.
    if (titleEl) titleEl.setAttribute('aria-label', GAME_TITLE);
    if (subEl) subEl.textContent = GAME_SUBTITLE;
    this.updateSectorLabel();

    // --- Settings, save, title panels ---
    this.applyAllSettings();
    this.hud.bindSettings(this.store.data.settings, (key) => this.onSettingChanged(key));
    this.applyEnergyColor();
    this.renderTitlePanels();

    // --- Screen flow ---
    document.getElementById('title-start')?.addEventListener('click', () => this.deploy());
    for (const [id, name] of [['title-settings-btn', 'settings'], ['title-protocol-btn', 'protocol']] as const) {
      document.getElementById(id)?.addEventListener('click', () => {
        this.audio.init();
        this.hud.toggleDrawer(name);
        this.audio.uiTick();
      });
    }
    document.getElementById('pause')?.addEventListener('click', () => {
      this.audio.init();
      this.input.requestPointerLock();
    });
    document.getElementById('pause-quit')?.addEventListener('click', () => this.returnToTitle());
    this.input.onPointerLockChange((locked) => {
      if (locked && this.state === 'PAUSED') this.setState('PLAYING');
      else if (!locked && this.state === 'PLAYING') this.setState('PAUSED');
    });
    // 5A-2: a hidden tab suspends all audio; returning resumes it (the world bus stays muted while paused).
    document.addEventListener('visibilitychange', () => this.audio.setHidden(document.hidden));
    this.setState('TITLE');

    this.attract.step(0);
    this.attract.apply(this.renderer.camera, 1, 0);
    this.prevCamPos.copy(this.renderer.camera.position);
  }

  // =============================================================================================
  // Settings (§3.1, §3.6-7, §9.2) & save
  // =============================================================================================
  private applySetting(key: keyof SaveSettings): void {
    const s = this.store.data.settings;
    switch (key) {
      case 'sensitivity':
        this.input.sensitivity = clamp(s.sensitivity, INPUT.SENSITIVITY_MIN, INPUT.SENSITIVITY_MAX);
        break;
      case 'shake':
        this.player.settings.shakeScale = s.shake;
        break;
      case 'roll':
        this.player.settings.rollScale = s.roll;
        break;
      case 'centerDot':
        this.hudFrame.centerDot = s.centerDot;
        break;
      case 'fov':
        this.player.settings.baseFov = clamp(s.fov, CAMERA.FOV_SETTING_MIN, CAMERA.FOV_SETTING_MAX);
        break;
      case 'quality':
        if (!this.qualityOverride) {
          this.renderer.setQuality(s.quality);
          this.city.setQuality(s.quality);
        }
        break;
      case 'volume':
        this.audio.setVolume(s.volume);
        break;
      case 'lowLatency':
        this.renderer.setLowLatency(s.lowLatency);
        break;
      default:
        break;
    }
  }

  private applyAllSettings(): void {
    for (const k of ['sensitivity', 'shake', 'roll', 'centerDot', 'fov', 'quality', 'volume', 'lowLatency'] as const) this.applySetting(k);
  }

  private onSettingChanged(key: keyof SaveSettings): void {
    this.applySetting(key);
    this.store.write();
    if (key === 'volume') {
      // Volume preview: only the UI tick sounds (the world bus is muted on the title / pause screens).
      this.audio.init();
      const now = performance.now() / 1000;
      if (now - this.lastVolumeTick >= VOLUME_TICK_S) {
        this.lastVolumeTick = now;
        this.audio.uiTick();
      }
    }
  }

  private applyEnergyColor(): void {
    const c = ENERGY_COLORS.find((e) => e.id === this.store.data.selectedColor) ?? ENERGY_COLORS[0];
    this.equipment.setEnergyColor(c.hex);
    this.viewModel.setEnergyColor(c.hex);
  }

  private renderTitlePanels(): void {
    this.hud.renderProtocol(
      this.store.data,
      (id: ModifierId) => {
        const d = this.store.data;
        if (!d.cleared) return;
        const i = d.activeModifiers.indexOf(id);
        if (i >= 0) d.activeModifiers.splice(i, 1);
        else d.activeModifiers.push(id);
        this.store.write();
        this.audio.uiTick();
        this.renderTitlePanels();
      },
      (id: EnergyColorId) => {
        const d = this.store.data;
        if (!d.unlockedColors.includes(id)) return;
        d.selectedColor = id;
        this.store.write();
        this.applyEnergyColor();
        this.audio.uiTick();
        this.renderTitlePanels();
      },
    );
  }

  // =============================================================================================
  // Sector lifecycle
  // =============================================================================================
  private buildSector(index: number): SectorLayout {
    const layout = this.city.buildSector(index, this.loop);
    this.physics.setLayout(layout);
    this.attract.rebuild(layout);
    this.layout = layout;
    this.sectorIndex = index;
    this.sectorLabel = this.loop > 0 ? `${layout.sector.name} · LOOP ${this.loop + 1}` : layout.sector.name;
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
    if (s !== 'PAUSED') this.pauseMini = false;
    this.input.gameplayEnabled = playing;
    // 5A-4: nothing pressed on the title / pause / modal screens leaks into the first frame of play.
    if (playing) this.input.clearActions();
    this.input.setUnloadGuard(s !== 'TITLE');
    // 5A-2: rain, wind, BGM and every world SE are fully silent while paused, on the result screen and title.
    this.audio.setPaused(s === 'PAUSED' || s === 'RESULT' || s === 'TITLE');
    const pause = document.getElementById('pause');
    pause?.classList.toggle('visible', s === 'PAUSED');
    pause?.classList.toggle('mini', s === 'PAUSED' && this.pauseMini);
    document.getElementById('title')?.classList.toggle('playing', s !== 'TITLE');
    // 5B-5: the title uses right-side drawers (SETTINGS / PROTOCOL buttons); the pause screen shows settings.
    this.hud.showPanels(s === 'PAUSED' && !this.pauseMini, false, s === 'TITLE');
    this.hud.setVisible(s !== 'TITLE');
    this.hud.setDim(s === 'SKILL' || s === 'RESULT');
    this.viewModel.root.visible = s !== 'TITLE';
    if (playing) (document.activeElement as HTMLElement | null)?.blur?.();
    if (s === 'PAUSED') this.refreshPauseInfo();
  }

  private refreshPauseInfo(): void {
    const owned = SKILLS.filter((k) => this.skills[k.id] > 0).map((k) => ({ name: k.name, level: this.skills[k.id] }));
    const mods = MODIFIERS.filter((m) => this.activeMods.has(m.id)).map((m) => m.label);
    this.hud.setPauseInfo(
      `${this.layout.sector.name} · LOOP ${this.loop + 1} · TIME ${formatTime(this.stats.timeS)} · DEATHS ${this.stats.deaths}` +
        (mods.length ? ` · ${mods.join(' + ')}` : ''),
      owned,
    );
  }

  /** Title → new run: skills reset, challenge modifiers from the save, drop into the first district. */
  private deploy(): void {
    this.audio.init();
    this.skills = emptySkillLevels();
    this.activeMods = new Set(this.store.data.cleared ? this.store.data.activeModifiers : []);
    this.player.maxHp = this.activeMods.has('ONE_SHOT_PROTOCOL') ? ONE_SHOT_HP : PLAYER.MAX_HP;
    this.loop = 0;
    this.flow.reset();
    this.stats = createRunStats(1);
    this.hud.clearFlowLog();
    if (this.sectorIndex !== this.startSector || this.layout.loop !== 0) this.buildSector(this.startSector);
    this.spawnPlayer();
    this.showSectorBanner();
    this.setState('PLAYING');
    this.input.requestPointerLock();
  }

  /**
   * Deploy, district entry and the 500 ms death retry: the player and the whole sector (wave 1) restart together.
   * `restartSector` false only re-spawns the player (death after the sector was already cleared).
   */
  private spawnPlayer(restartSector = true): void {
    this.player.spawn(this.layout.playerSpawn, this.layout.playerSpawnYaw);
    this.equipment.reset();
    this.effects.clearProjectiles();
    this.accumulator = 0;
    this.deathTimer = -1;
    this.btKills = 0;
    this.wallStepTimer = 0;
    this.hud.eliminated(null);
    this.renderer.postFx.glitch = 0;
    this.renderer.postFx.fade = 0;
    this.renderer.postFx.critical = 0;
    if (!restartSector) return;
    this.setGateOpen(this.debugGate);
    this.enemies.startSector(this.layout, this.loop);
    this.clearTimer = -1;
    this.clearAction = null;
    this.gateReady = this.debugGate;
    this.audio.setCalm(false);
  }

  private showSectorBanner(): void {
    const sec = this.layout.sector;
    this.hud.banner(sec.name, sec.subtitle, this.loop > 0 ? `ENDLESS PROTOCOL // LOOP ${this.loop + 1}` : '');
  }

  private beginDeath(totalMs: number): void {
    this.deathDuration = totalMs / 1000;
    this.deathTimer = 0;
  }

  /** All waves down: open the gate (Sectors 1–4) and queue the 3-choice skill modal, or the run result (Sector 5). */
  private onSectorCleared(): void {
    this.audio.setCalm(true);
    this.store.write();
    if (this.layout.sector.reward === 'RUN_COMPLETE') {
      this.clearAction = 'RESULT';
      this.clearTimer = CLEAR_TO_RESULT_S;
      return;
    }
    this.setGateOpen(true);
    this.audio.gateOpen();
    this.clearAction = 'SKILL';
    this.clearTimer = CLEAR_TO_MODAL_S;
  }

  /** §1.2 / §3.6-5: three choices, every click and the 1/2/3 keys disabled for the first 450 ms. */
  private openSkillModal(): void {
    const choices = rollSkillChoices(this.skills, Math.random);
    if (choices.length === 0) {
      this.gateReady = true;
      this.hud.flowLog('ALL PROTOCOLS MAXED', 0, 'skill');
      return;
    }
    this.setState('SKILL');
    this.input.lockClicks(INPUT.SKILL_MODAL_LOCK_MS);
    this.hud.openSkillModal(`${this.layout.sector.name} CLEARED`, choices, this.skills, this.input, (id) => this.pickSkill(id));
    this.input.exitPointerLock();
    this.audio.modalOpen();
  }

  private pickSkill(id: SkillId): void {
    this.skills[id] = Math.min(3, this.skills[id] + 1);
    this.gateReady = true;
    this.audio.uiSelect();
    this.hud.flowLog(`${SKILL_BY_ID[id].nameEn} Lv.${this.skills[id]}`, 0, 'skill');
    this.input.clearActions();
    // Resume through the pause state: the pick (click / key) is a user gesture, so the re-lock normally
    // succeeds at once; if the browser refuses it (common after a keyboard pick) a light one-click overlay
    // "PROTOCOL INSTALLED — CLICK TO DEPLOY" appears instead of the full settings pause screen (5A-5).
    this.pauseMini = true;
    this.setState('PAUSED');
    this.input.requestPointerLock();
  }

  /** Opened gate crossed (Sectors 1–4): fade, build the next district, keep skills / FLOW / run stats. */
  private beginTransition(): void {
    this.setState('TRANSITION');
    this.transitionT = 0;
    this.transitionBuilt = false;
    document.getElementById('fader')?.classList.add('on');
    this.audio.transition();
  }

  private updateTransition(realDt: number): void {
    if (this.transitionT < 0) return;
    this.transitionT += realDt;
    if (!this.transitionBuilt && this.transitionT >= TRANSITION_FADE_S) {
      this.transitionBuilt = true;
      this.buildSector(this.sectorIndex + 1);
      this.spawnPlayer();
      this.showSectorBanner();
      this.updateSectorLabel();
      document.getElementById('fader')?.classList.remove('on');
    }
    if (this.transitionBuilt && this.transitionT >= TRANSITION_FADE_S * 2) {
      this.transitionT = -1;
      this.setState(this.input.isPointerLocked ? 'PLAYING' : 'PAUSED');
    }
  }

  /** Sector 05 cleared: rank, records, unlocks, then endless loop or title (§8.3). */
  private showResult(): void {
    this.setState('RESULT');
    this.input.exitPointerLock();
    const st = this.stats;
    st.flowScore = Math.round(this.flow.earned * modifierScoreMultiplier(this.activeMods));
    const rank = computeRunRank(st);
    const save = this.store.data;
    const rec = recordRun(save, st, rank);
    save.maxLoop = Math.max(save.maxLoop, this.loop + 2);
    this.store.write();
    const avg = averageFlowRankIndex(st);
    const mult = modifierScoreMultiplier(this.activeMods);
    const notes: string[] = [];
    if (rec.newBestTime) notes.push('NEW BEST TIME');
    if (rec.newBestScore) notes.push('NEW BEST FLOW SCORE');
    for (const id of rec.unlocked) notes.push(`ENERGY COLOUR UNLOCKED — ${id}`);
    if (this.loop === 0) notes.push('ENDLESS PROTOCOL UNLOCKED · CHALLENGE MODIFIERS UNLOCKED');
    this.hud.showResult(
      {
        title: this.loop === 0 ? 'RUN COMPLETE' : `LOOP ${this.loop + 1} COMPLETE`,
        rank,
        rows: [
          ['CLEAR TIME', formatTime(st.timeS)],
          ['DEATHS', String(st.deaths)],
          ['KILLS', String(st.kills)],
          ['HEADSHOT RATE', `${Math.round(headshotRate(st) * 100)}%`],
          ['AVERAGE FLOW RANK', `${FLOW_RANKS[Math.round(avg)].id} (${avg.toFixed(2)})`],
          ['PEAK FLOW', String(Math.round(this.flow.peak))],
          ['GRAZES', String(st.grazes)],
          ['FLOW SCORE', mult > 1 ? `${st.flowScore} (×${mult.toFixed(2)})` : String(st.flowScore)],
        ],
        notes,
        endlessLabel: `ENDLESS PROTOCOL — LOOP ${this.loop + 2}`,
      },
      () => this.startNextLoop(),
      () => this.returnToTitle(),
    );
  }

  /** Endless Protocol: skills carry over; enemy HP +25 %, lock −8 %, count +20 % per loop. */
  private startNextLoop(): void {
    this.audio.init();
    this.hud.hideResult();
    this.loop++;
    this.stats = createRunStats(this.loop + 1);
    this.flow.resetScore();
    this.buildSector(1);
    this.updateSectorLabel();
    this.spawnPlayer();
    this.showSectorBanner();
    this.pauseMini = true;
    this.setState('PAUSED');
    this.input.requestPointerLock();
  }

  private returnToTitle(): void {
    this.hud.hideResult();
    this.hud.closeSkillModal();
    this.hud.eliminated(null);
    this.input.exitPointerLock();
    this.loop = 0;
    this.skills = emptySkillLevels();
    this.flow.reset();
    this.effects.clearProjectiles();
    this.enemies.clear();
    this.buildSector(this.startSector);
    this.setGateOpen(this.debugGate);
    this.updateSectorLabel();
    this.clearTimer = -1;
    this.transitionT = -1;
    document.getElementById('fader')?.classList.remove('on');
    this.renderTitlePanels();
    this.audio.setCalm(true);
    this.setState('TITLE');
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

  // =============================================================================================
  // Combat events → FLOW, skills, audio
  // =============================================================================================
  private onHitMarker(kind: HitMarkerKind): void {
    this.hud.hitMarker(kind);
    if (kind === 'BODY' || kind === 'WING') this.audio.hitBody();
    else if (kind === 'SHIELD' || kind === 'ARMOR') this.audio.hitShield();
    else if (kind === 'HEAD' || kind === 'HEAD_KILL') this.audio.headshot(kind === 'HEAD_KILL', this.clock.realTime);
    // SK_04 wall overclock: head-shot while wall-running → BT gauge + instant reload.
    if ((kind === 'HEAD' || kind === 'HEAD_KILL') && this.player.isWallRunning && this.skills.SK_04 > 0) {
      this.player.addBulletTimeGauge(skillValue(this.skills, 'SK_04'));
      this.equipment.instantReload();
      this.hud.flowLog('WALL OVERCLOCK', 0, 'skill');
    }
  }

  private onKill(info: KillInfo): void {
    // Copy everything first: skill effects below can trigger nested kills that reuse the info record.
    const headshot = info.headshot;
    const weapon = info.weapon;
    const inAir = info.airborne || info.wallRun || info.swinging;
    const bt = info.bulletTime;
    _killPos.copy(info.position);

    this.flow.kill(info, _flowOut);
    this.hud.flowLog(_flowOut.label, _flowOut.points, 'kill');
    this.stats.kills++;
    if (headshot) {
      this.stats.headshotKills++;
      this.store.data.totalHeadshots++;
      if (checkHeadshotUnlock(this.store.data).length) {
        this.store.write();
        this.hud.flowLog('ENERGY COLOUR UNLOCKED — VIOLET', 0, 'skill');
      }
    } else this.audio.kill(_killPos);
    const r = this.flow.rankIndex;
    // FLOW S+: RGB split on kills; SSS: kill frame flash.
    if (r >= 4) this.renderer.triggerChromaSpike(0.006, 160);
    if (r >= 6) this.renderer.postFx.frameFlash = Math.max(this.renderer.postFx.frameFlash, 0.55);
    if (bt) this.btKills++;

    // SK_08 thermal headhunter: rail-pistol head-shot kill → EM shock (65 dmg, cancels telegraphs).
    if (headshot && weapon === 0 && this.skills.SK_08 > 0) {
      const radius = skillValue(this.skills, 'SK_08');
      this.effects.spawnRing(_killPos, UP, 0x38f8ff, 3.6, 0.3, radius, 0.32);
      this.effects.burst(_killPos, UP, BURST.DISCHARGE_CYAN);
      this.renderer.flashLight(_killPos, 0x38f8ff, 18, radius * 3, 0.2);
      this.audio.partBreak(_killPos);
      this.hud.flowLog('THERMAL SHOCK', 0, 'skill');
      this.enemies.applyAreaDamage(_killPos, radius, skillValue2(this.skills, 'SK_08'), 4, true);
    }
    // SK_15 head-shot ricochet: airborne head-shot kill → 1/2/3 rounds to the nearest other enemies (≤ 18 m).
    if (headshot && inAir && this.skills.SK_15 > 0) {
      const shots = skillValue(this.skills, 'SK_15');
      const n = this.enemies.nearestEnemies(_killPos, SKILL_CONSTANTS.RICOCHET_RANGE_M, _ricoTargets);
      if (n > 0) {
        for (let i = 0; i < shots; i++) {
          _ricoDir.subVectors(_ricoTargets[i % n], _killPos).normalize();
          this.effects.spawnProjectile(_killPos, _ricoDir, RICOCHET_SPEC);
        }
        this.hud.flowLog(`RICOCHET ×${shots}`, 0, 'skill');
      }
    }
  }

  private onGraze(): void {
    this.hud.evade(FLOW_POINTS.GRAZE);
    this.flow.add(FLOW_POINTS.GRAZE);
    this.hud.flowLog('EVADE', FLOW_POINTS.GRAZE, 'evade');
    this.stats.grazes++;
    this.audio.graze(this.clock.realTime);
    // SK_12 phantom graze: surrounding enemy rounds at half speed for 0.6 s (the BT bonus is a combat modifier).
    if (this.skills.SK_12 > 0) {
      this.player.eyePosition(_chest);
      this.effects.scaleEnemyRoundSpeed(_chest, PHANTOM_GRAZE_RADIUS_M, 0.5, skillValue2(this.skills, 'SK_12'));
    }
  }

  private onPartBreak(pos: THREE.Vector3, weapon: number, label: string): void {
    this.flow.add(FLOW_POINTS.SHIELD_BREAK);
    this.hud.flowLog(label, FLOW_POINTS.SHIELD_BREAK, 'kill');
    this.audio.partBreak(pos);
    // 8A-4 SK_09 Shield Piercer: a pistol / sniper break instantly refills the active gun (sniper 1/1, pistol 8/8),
    // skipping the breech reload so the staggered target can be punished at once.
    if ((weapon === 0 || weapon === 1) && this.skills.SK_09 > 0 && this.equipment.refillActive()) {
      this.hud.flowLog('CHAMBER REFILLED', 0, 'skill');
    }
  }

  private onBulletTime(active: boolean): void {
    this.audio.setBulletTime(active);
    if (active) {
      this.btKills = 0;
      return;
    }
    // SK_11 zero-time bonus: 2+ kills in one activation → speed boost when time resumes.
    if (this.btKills >= 2 && this.skills.SK_11 > 0) {
      this.player.speedBoost(skillValue(this.skills, 'SK_11'), skillValue2(this.skills, 'SK_11'));
      this.hud.flowLog(`ZERO-TIME +${skillValue(this.skills, 'SK_11')} m/s`, 0, 'skill');
    }
    this.btKills = 0;
  }

  /** Player rounds test enemy hitboxes (+ shields, wings, missiles); enemy rounds test the player. */
  private readonly targetsFor = (owner: ProjectileOwner): readonly HitboxTarget[] => (owner === 'PLAYER' ? this.enemies.targets : this.enemies.playerTargets);

  private readonly onImpact = (im: ProjectileImpact): void => {
    this.enemies.handleImpact(im);
  };

  /** Screen angle (deg, clockwise from up) of a world point relative to the view (HUD arcs). */
  private screenAngle(world: THREE.Vector3): number {
    const cam = this.renderer.camera;
    _camRight.setFromMatrixColumn(cam.matrixWorld, 0);
    _camUp.setFromMatrixColumn(cam.matrixWorld, 1);
    _camBack.setFromMatrixColumn(cam.matrixWorld, 2);
    _toSrc.subVectors(world, cam.position);
    const x = _toSrc.dot(_camRight);
    const y = _toSrc.dot(_camUp);
    const z = -_toSrc.dot(_camBack);
    if (Math.abs(x) < 1e-3 && Math.abs(y) < 1e-3) return z < 0 ? 180 : 0;
    // Straight behind: point the arc downward.
    if (z < 0 && Math.hypot(x, y) < Math.abs(z) * 0.15) return 180;
    return (Math.atan2(x, y) * 180) / Math.PI;
  }

  /** FLOW rank × skills × challenge modifiers → player / equipment / enemy modifiers (SK_14 tracks HP live). */
  private applyModifiers(): void {
    const d = deriveModifiers(this.skills, FLOW_RANKS[this.flow.rankIndex], this.player.isCritical, this.activeMods, this.derived);
    const pm = this.player.modifiers;
    pm.maxSpeedBonus = d.maxSpeedBonus;
    pm.wallKickHeightBonus = d.wallKickHeightBonus;
    pm.kickBoostBonus = d.kickBoostBonus;
    pm.wallRunTimeBonusS = d.wallRunTimeBonusS;
    pm.btDrainReduction = d.btDrainReduction;
    pm.regenDelayMs = d.regenDelayMs;
    pm.criticalMoveBonus = d.criticalMoveBonus;
    pm.bulletTimeDisabled = d.bulletTimeDisabled;
    pm.crouchSpeedBonus = d.crouchSpeedBonus;
    const em = this.equipment.modifiers;
    em.switchTimeMultiplier = d.switchTimeMultiplier;
    em.reloadTimeMultiplier = d.reloadTimeMultiplier;
    em.swingReloadFraction = d.swingReloadFraction;
    em.momentumShots = skillValue(this.skills, 'SK_02');
    em.enemyHookResetsCooldown = this.skills.SK_06 > 0;
    const cm = this.enemies.modifiers;
    cm.grappleStunS = d.grappleStunS;
    cm.btKillRecoveryBonus = d.btKillRecoveryBonus;
    cm.shieldPartBonus = d.shieldPartBonus;
    cm.alertFillMultiplier = d.alertFillMultiplier;
    cm.grazeBtBonus = d.grazeBtBonus;
    cm.lockTimeReduction = d.lockTimeReduction;
  }

  /** FLOW rank visuals & BGM layers (§2.4 table). Changes are applied only when the rank changes. */
  private applyFlowRank(realDt: number): void {
    const r = this.flow.rankIndex;
    const fx = this.renderer.postFx;
    if (r !== this.flowRankIndex) {
      this.flowRankIndex = r;
      const def = FLOW_RANKS[r];
      this.renderer.setBloomStrength(def.bloomStrength);
      this.city.setNeonBoost(r >= 3 ? 0.25 : 0);
      this.equipment.setStrandBoost(r >= 3 ? 1.6 : 1);
      this.effects.setRainNeonReflect(r >= 4 ? 1 : 0);
      this.equipment.setPlasmaMuzzle(r >= 5);
      this.viewModel.setPlasmaMuzzle(r >= 5);
      this.audio.setFlowRank(r, def.bgmLayers);
    }
    // SS+: searchlights pulse on the BGM beat; SSS: OVERDRIVE cyan electric border.
    const phase = this.audio.beatPhase(this.clock.realTime);
    this.city.setSearchlightPulse(r >= 5 ? Math.pow(1 - phase, 3) : 0);
    fx.overdrive += ((r >= 6 ? 1 : 0) - fx.overdrive) * lerpFactor(6, realDt);
  }

  private fixedUpdate(dt: number): void {
    if (this.state === 'TITLE') {
      this.attract.step(dt);
      return;
    }
    if (this.state !== 'PLAYING') return;
    const cam = this.renderer.camera;
    this.equipment.fixedUpdate(dt, cam, this.clock.bulletTimeScale);
    this.player.fixedUpdate(dt, this.equipment.stepContext());
    this.enemies.fixedUpdate(dt);
    this.effects.updateProjectiles(dt, this.physics, this.targetsFor, this.onImpact, this.enemies.graze);
    this.flow.update(dt);
    this.input.markStep();
  }

  private tick(realDt: number): void {
    const playing = this.state === 'PLAYING';
    const cam = this.renderer.camera;

    // --- Real-time input: look, discrete actions, bullet time ---
    _lookDelta.yaw = 0;
    _lookDelta.pitch = 0;
    if (playing) {
      this.applyModifiers();
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
      // A sector already cleared stays cleared (stray rounds after the last kill only respawn the player).
      if (this.deathTimer >= this.deathDuration) this.spawnPlayer(!this.enemies.isCleared);
    }

    // --- Run clock, clear → modal / result, gate crossing, district transition ---
    if (playing) {
      this.stats.timeS += realDt;
      this.stats.rankTime[this.flow.rankIndex] += realDt;
      if (this.clearTimer >= 0) {
        this.clearTimer -= realDt;
        if (this.clearTimer < 0) {
          const action = this.clearAction;
          this.clearAction = null;
          if (action === 'SKILL') this.openSkillModal();
          else if (action === 'RESULT') this.showResult();
        }
      }
      this.checkGateCrossing();
    }
    if (this.state === 'SKILL' && this.hud.updateSkillModal()) this.audio.modalUnlocked();
    if (this.state === 'TRANSITION') this.updateTransition(realDt);

    // --- Simulation clock (frozen outside PLAYING) ---
    const simDt = this.state === 'PLAYING' || this.state === 'TITLE' ? this.clock.advance(realDt) : 0;
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
      this.renderer.setFov(this.player.settings.baseFov);
      if (simDt > 0) this.camVel.subVectors(cam.position, this.prevCamPos).divideScalar(simDt);
      fx.speed = this.camVel.length();
      fx.bulletTime = 0;
      fx.speedLines = 0;
      fx.overdrive = 0;
      fx.zoom = 0;
      this.enemies.zoomScan.value = 0;
    } else {
      const frozen = this.state !== 'PLAYING';
      this.player.updateCamera(frozen ? 0 : realDt, alpha, cam);
      cam.updateMatrixWorld();
      this.viewModel.syncEnvironment(this.player.cameraEuler);
      this.equipment.frameUpdate(frozen ? 0 : realDt, cam, _lookDelta.yaw, _lookDelta.pitch);
      this.enemies.frameUpdate(realDt, simDt, alpha);
      this.camVel.copy(this.player.velocity);
      fx.speed = this.player.speed;
      fx.bulletTime += ((this.player.btActive ? 1 : 0) - fx.bulletTime) * lerpFactor(14, realDt);
      fx.critical += ((this.player.isCritical && this.player.isAlive ? 1 : 0) - fx.critical) * lerpFactor(6, realDt);
      fx.zoom = this.equipment.zoomBlend;
      // 7A-4: the optical scan rim follows the zoom blend smoothly (0 → 1).
      const zs = this.enemies.zoomScan;
      zs.value += ((this.player.isAlive ? this.equipment.zoomBlend : 0) - zs.value) * lerpFactor(12, realDt);
      if (zs.value < 1e-3) zs.value = 0;
      this.applyFlowRank(realDt);
      // Speed lines (5B-5): from 18 m/s at every rank — faint 0.22 at D / C, stronger and denser B → SSS
      // (always on at SSS); +0.2 while sliding down an on-ramp.
      const sp = this.player.speed;
      const rk = this.flowRankIndex;
      const fast = clamp((sp - RENDER.SPEEDLINE_MIN_SPEED) / 14, 0, 1);
      let sl = rk >= 6 ? 1 : rk >= 2 ? fast * (0.35 + 0.13 * (rk - 2)) : fast * SPEEDLINE_LOW_RANK;
      if (this.player.isRampSliding && sp >= RENDER.SPEEDLINE_MIN_SPEED) sl = Math.min(1, sl + SPEEDLINE_RAMP_BOOST);
      fx.speedLines += (sl - fx.speedLines) * lerpFactor(8, realDt);
      fx.speedLineDensity = rk >= 6 ? 1 : rk >= 2 ? 0.3 + 0.1 * (rk - 2) : 0.22;
      // 5A-6: magnetic boot taps every 0.22 s (simulation time) while wall-running.
      if (this.player.isWallRunning && this.player.isAlive) {
        this.wallStepTimer -= simDt;
        if (this.wallStepTimer <= 0) {
          this.audio.wallRunStep();
          this.wallStepTimer += AUDIO.WALLRUN_STEP.intervalS;
          if (this.wallStepTimer < 0) this.wallStepTimer = AUDIO.WALLRUN_STEP.intervalS;
        }
      } else this.wallStepTimer = 0;
      // Shallow canal: wake splashes while wading.
      this.splashTimer -= simDt;
      if (this.player.isInWater && this.player.speed > 2 && this.splashTimer <= 0) {
        this.splashTimer = 0.12;
        this.effects.burst(this.player.position, UP, BURST.WATER);
      }
      this.updateHud(realDt);
    }
    this.prevCamPos.copy(cam.position);

    // --- Audio: listener, swing wind, heartbeat / repair, calm mix ---
    _camBack.setFromMatrixColumn(cam.matrixWorld, 2);
    _camFwd.copy(_camBack).negate();
    _camUp.setFromMatrixColumn(cam.matrixWorld, 1);
    const live = playing && this.player.isAlive;
    this.audio.update(cam.position, _camFwd, _camUp, live && this.player.ropeAttached, this.player.speed, live && this.player.state === 'GRAPPLE_PULL');
    this.audio.setPlayerState(live && this.player.isCritical, live && this.player.isRegenerating);
    if (this.state === 'PLAYING') {
      this.audio.setCalm(this.enemies.isCleared || this.player.isRegenerating);
      // 8A-5 adaptive BGM: ducked tension pulse while the district is UNAWARE / ALERT.
      const hi = this.enemies.highestAlert;
      this.audio.setStealth(!this.enemies.isCleared && (hi === 'UNAWARE' || hi === 'ALERT'));
    }

    // --- World & effects ---
    this.city.update(this.clock.simTime, cam.position);
    this.effects.update(simDt, realDt, cam.position, this.camVel, this.clock.realTime, this.renderer.viewportHeight);
    this.renderer.update(realDt);
    this.renderer.render();

    if (this.debugEl) this.updateDebug();
  }

  /** Opened gate (after the skill pick) crossed toward the next district. */
  private checkGateCrossing(): void {
    if (!this.gateReady || this.layout.sector.reward !== 'SKILL' || !this.player.isAlive) return;
    if (!this.enemies.isCleared && !this.debugGate) return;
    const g = this.layout.gate;
    _toSrc.subVectors(this.player.position, g.position);
    if (_toSrc.dot(g.normal) > GATE_CROSS_M) this.beginTransition();
  }

  private updateHud(realDt: number): void {
    const f = this.hudFrame;
    f.realDt = realDt;
    // Off-screen enemies in LOCK_TELEGRAPH → blinking red arcs toward them (§6.3).
    f.warnCount = 0;
    const cam = this.renderer.camera;
    for (const w of this.enemies.warnings) {
      if (!w.active || f.warnCount >= HUD_MAX_WARNINGS) continue;
      _proj.copy(w.position).project(cam);
      const onScreen = _proj.z < 1 && Math.abs(_proj.x) <= 1 && Math.abs(_proj.y) <= 1;
      if (onScreen) continue;
      f.warnAngles[f.warnCount++] = this.screenAngle(w.position);
    }
    this.updateTracking(f);
    // 8A-5 awareness arcs (≤ 4) toward enemies filling their gauge or engaging with LOS, and the district badge.
    f.awareCount = this.enemies.awareness(_awarePos, f.awareGauge, f.awareRank);
    for (let i = 0; i < f.awareCount; i++) f.awareAngles[i] = this.screenAngle(_awarePos[i]);
    f.alertTag = this.enemies.isCleared ? '' : this.enemies.highestAlert;
    f.sectorName = this.sectorLabel;
    f.remaining = this.enemies.remaining;
    f.gateOpen = (this.enemies.isCleared && this.layout.sector.reward === 'SKILL') || this.debugGate;
    f.bossVisible = this.enemies.bossStatus(_bossStatus);
    if (f.bossVisible) {
      f.bossHp = _bossStatus.hp;
      f.bossMaxHp = _bossStatus.maxHp;
      f.bossWingL = _bossStatus.wingL;
      f.bossWingR = _bossStatus.wingR;
      f.bossPhase = _bossStatus.phase;
      f.bossDowned = _bossStatus.downed;
    }
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
    f.zoom = e.zoomBlend;
    // 7B-8 adaptive HUD: calm 4 s after the last shot / hit / telegraph lock — with full HP, or with the sector
    // cleared — while slower than 18 m/s and not aiming down sights; any of those wakes it at once.
    {
      const since = p.clockS - Math.max(p.lastAttackTime, p.lastDamageTime, this.lastLockAt);
      const quiet = since >= ADAPTIVE_HUD_QUIET_S && (this.enemies.isCleared || p.hp >= p.maxHp);
      f.calm = p.isAlive && quiet && p.speed < RENDER.SPEEDLINE_MIN_SPEED && e.zoomBlend < 0.05;
    }
    f.aimVisible = false;
    if (e.zoomBlend > 0.3 && p.isAlive) {
      const cam = this.renderer.camera;
      cam.getWorldDirection(_aimFwd);
      if (this.enemies.aimTarget(cam.position, _aimFwd, AIM_HP_MAX_DEG, _aimInfo)) {
        f.aimVisible = true;
        f.aimFrac = _aimInfo.hp / Math.max(_aimInfo.maxHp, 1e-3);
        f.aimName = _aimInfo.name;
      }
    }
    f.reticleKick = e.reticleKick;
    f.buffPierce = e.momentumShotsLeft;
    f.buffZero = this.skills.SK_11 > 0 && p.speedBoostActive;
    f.buffAdren = this.skills.SK_14 > 0 && p.isCritical && p.isAlive;
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
    const fl = this.flow;
    this.stats.flowScore = fl.earned * modifierScoreMultiplier(this.activeMods);
    this.stats.peakFlowPoints = fl.peak;
    this.hud.updateFlow(fl.rankIndex, fl.progress, fl.decayGrace, fl.points, this.stats.flowScore);
  }

  /**
   * 5A-5 tactical tracking: the last ≤ 3 enemies and VALKYRIE get a diamond at their screen position; off-screen
   * targets are clamped to the screen edge (44 px inset) along their view-space direction, with the distance.
   */
  private updateTracking(f: HudFrame): void {
    const n = this.enemies.trackedTargets(_trkPos, _trkBoss);
    const cam = this.renderer.camera;
    const w = this.renderer.viewportWidth;
    const h = this.renderer.viewportHeight;
    _camRight.setFromMatrixColumn(cam.matrixWorld, 0);
    _camUp.setFromMatrixColumn(cam.matrixWorld, 1);
    _camBack.setFromMatrixColumn(cam.matrixWorld, 2);
    const hx = w / 2 - TRACK_EDGE_MARGIN_PX;
    const hy = h / 2 - TRACK_EDGE_MARGIN_PX;
    for (let i = 0; i < n; i++) {
      const pos = _trkPos[i];
      _toSrc.subVectors(pos, cam.position);
      f.trackDist[i] = _toSrc.length();
      f.trackBoss[i] = _trkBoss[i];
      const forward = -_toSrc.dot(_camBack);
      let sx = 0;
      let sy = 0;
      let off = true;
      if (forward > 0.1) {
        _proj.copy(pos).project(cam);
        sx = _proj.x * (w / 2);
        sy = -_proj.y * (h / 2);
        off = Math.abs(sx) > hx || Math.abs(sy) > hy;
      }
      if (off) {
        // Direction on screen from the view-space offset (works behind the camera too).
        let dx = _toSrc.dot(_camRight);
        let dy = -_toSrc.dot(_camUp);
        if (forward <= 0.1 && Math.abs(dx) < 1e-3 && Math.abs(dy) < 1e-3) dy = 1;
        const k = Math.min(hx / Math.max(Math.abs(dx), 1e-6), hy / Math.max(Math.abs(dy), 1e-6));
        dx *= k;
        dy *= k;
        sx = dx;
        sy = dy;
      }
      f.trackX[i] = w / 2 + sx;
      f.trackY[i] = h / 2 + sy;
      f.trackOff[i] = off ? 1 : 0;
    }
    f.trackCount = n;
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
      `COLLIDERS ${this.layout.colliders.length}  ANCHORS ${this.layout.anchors.length}  RAMPS ${this.layout.ramps.length}\n` +
      `ARCH A/B/C/D ${this.layout.stats.archetypes.join('/')}  BALCONIES ${this.layout.stats.balconies}  ESCAPES ${this.layout.stats.fireEscapes}  SHUTTERS ${this.layout.stats.shutterFronts}\n` +
      `PLAYER ${p.state}  POS ${p.position.x.toFixed(1)},${p.position.y.toFixed(2)},${p.position.z.toFixed(1)}  SPD ${p.speed.toFixed(1)}  ` +
      `GEAR ${this.equipment.activeSlot}/${this.equipment.state}  ROPE ${p.ropeAttached ? p.ropeLength.toFixed(1) : '-'}  BT ${p.btGauge.toFixed(0)}  HP ${p.hp.toFixed(0)}\n` +
      `ENEMIES  WAVE ${this.enemies.waveNumber}/${this.enemies.waveTotal}  REMAINING ${this.enemies.remaining}  ${this.enemies.isCleared ? 'CLEARED' : ''}  |  ` +
      `FLOW ${FLOW_RANKS[this.flow.rankIndex].id} ${this.flow.points.toFixed(0)}  LOOP ${this.loop + 1}`;
  }

  // =============================================================================================
  // Debug / test hooks (only reachable through ?debug=1)
  // =============================================================================================
  debugInfo(): Record<string, unknown> {
    return {
      state: this.state,
      sector: this.sectorIndex,
      loop: this.loop,
      skills: { ...this.skills },
      flow: { points: this.flow.points, rank: FLOW_RANKS[this.flow.rankIndex].id, earned: this.flow.earned },
      stats: { ...this.stats, rankTime: Array.from(this.stats.rankTime) },
      gateReady: this.gateReady,
      clearAction: this.clearAction,
      derived: { ...this.derived },
      mods: [...this.activeMods],
    };
  }

  /** Grants a skill level directly (tests). */
  debugGrantSkill(id: SkillId, level = 1): void {
    this.skills[id] = clamp(level, 0, 3);
  }

  /** Kills every enemy of the current sector (tests). */
  debugClearSector(): void {
    this.enemies.debugKillAll();
  }

  /** Sets challenge modifiers for the next deploy (tests). */
  debugSetModifiers(ids: ModifierId[]): void {
    this.store.data.cleared = true;
    this.store.data.activeModifiers = ids;
  }

  /** Starts the run without the pointer-lock gesture (tests). */
  debugDeploy(): void {
    this.deploy();
    this.setState('PLAYING');
  }

  /** Forces a screen state (tests). */
  debugForceState(s: AppState): void {
    this.setState(s);
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
