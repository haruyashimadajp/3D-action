/**
 * STRAND // PROTOCOL — HUD (§6.3, §3.6-3, §3.6-7).
 *
 * Minimal, high-visibility cyber HUD (≤ 8 % of the screen); critical gauges sit around the crosshair:
 *  - Centre anchor dot (2 px white + 1 px black border, accessibility toggle) + weapon reticle
 *    (pistol precise cross · sniper fine open cross with mil ticks · grapple chain-hook)
 *  - Gold diamond grapple lock at the snapped anchor's screen position — shown with ANY slot equipped
 *    (thin when a gun is held, thick & bright with the grapple launcher)
 *  - Bullet-time arc (right, r = 36 px, 3 px wide): cyan, grey below 12 %, white-hot while active
 *  - Switch / reload arc (left, r = 36 px): only while switching (220 ms) or reloading
 *  - HP bar (bottom-left, 240 px) + out-of-combat regen countdown line (flashes red on firing)
 *  - SPEED / ALT read-out (cyan glow above 18 m/s)
 *  - Equipment dock + LOCKED badge on STRAND while attached + 48 px ammo counter
 *  - Hit markers: body = white × (120 ms), head = gold / red large × (180 ms), kills, shield / part breaks
 *  - "EVADE +90" (cyan) below the crosshair on every GRAZE
 *  - Directional lock warnings: blinking red arcs on the r = 85 px ring toward enemies locking on from
 *    outside the view (no unfair off-screen deaths) + red damage-direction arcs on hits
 *  - Sector progress "SECTOR 02 // REMAINING: 07" → green "GATE OPEN — ADVANCE TO NEXT DISTRICT"
 *  - VALKYRIE-09 integrity bar with both thruster wings
 *  - FLOW RANK (top-right): huge italic rank letter D … SSS, decay gauge, last-3 action log
 *    ("AIR HEADSHOT +300", "EVADE +90"); rank C+ lights the HUD frame faint cyan
 *  - 3-choice skill modal with the 450 ms click / number-key lock shown as a progress bar (§3.6-5)
 *  - Settings & accessibility menu (title + pause): sensitivity, camera-shake 0/50/100 %, roll 0/50/100 %,
 *    centre anchor dot, base FOV 75–100°, quality preset, master volume
 *  - Save management (localStorage `strand_protocol_save_v1`), records, challenge modifiers, energy colours,
 *    run result screen, sector banner
 *  - Phase 5A: tactical-zoom optical brackets [ ] (46 → 28 px) + sharpened reticle, BT arc dark-grey blink when
 *    bullet time is refused (350 ms), tracking diamonds for the last ≤ 3 enemies and VALKYRIE (clamped to the
 *    screen edge with distance when off-screen), "ARMORED — DESTROY WINGS", orange wing / grey armour hit
 *    markers, "ELIMINATED // <cause>" during the death glitch, active buff tags (PIERCE ×N / ZERO-TIME /
 *    ADRENALINE)
 *  - 8A-5: awareness arcs (r = 78 px) toward enemies filling their alert gauge / engaging, and a district status
 *    badge (STEALTH · ALERT · DETECTED · COMBAT) beside the sector read-out
 *  - Phase 5B: dynamic reticle (recoil opens it, zoom tightens it), helmet-visor perspective on
 *    the side panels + faint edge scales, title SETTINGS / PROTOCOL as right-side drawers
 * DOM is written only when values change (no per-frame layout churn).
 */
import { BULLET_TIME, FLOW_RANKS, INPUT, JUICE, PLAYER, RADAR, SAVE_KEY, TELEGRAPH, clamp } from '../config/constants';
import type { AlertState } from '../config/enemies';
import {
  ENERGY_COLORS,
  MODIFIERS,
  SCREEN_FILTERS,
  SKILL_MAX_LEVEL,
  defaultSave,
  sanitizeSave,
  type EnergyColorId,
  type ModifierId,
  type SaveData,
  type SaveSettings,
  type SkillDef,
  type SkillId,
  type SkillLevels,
} from '../config/skills';
import { GUNS, type SlotId, isGun } from '../config/weapons';
import type { GearState } from '../player/EquipmentManager';
import type { HitMarkerKind, RadarEnemySample } from '../entities/EnemyManager';

export interface HudFrame {
  slot: SlotId;
  pendingSlot: SlotId | null;
  gear: GearState;
  switchProgress: number;
  reloadProgress: number;
  ammo: number;
  magazine: number;
  ropeAttached: boolean;
  grappleCooldown: number;
  btGauge: number;
  btActive: boolean;
  hp: number;
  maxHp: number;
  /** 0 → 1 regen countdown (1 = regenerating / full). */
  regenCountdown: number;
  regenerating: boolean;
  /** Seconds since the last trigger pull. */
  sinceShot: number;
  speed: number;
  altitude: number;
  anchorVisible: boolean;
  anchorX: number;
  anchorY: number;
  anchorStrong: boolean;
  centerDot: boolean;
  /** Real frame time (marker / arc timers). */
  realDt: number;
  /** Screen angles (deg, clockwise from up) of off-screen enemies in LOCK_TELEGRAPH. */
  warnCount: number;
  readonly warnAngles: Float32Array;
  sectorName: string;
  remaining: number;
  gateOpen: boolean;
  bossVisible: boolean;
  bossHp: number;
  bossMaxHp: number;
  bossWingL: number;
  bossWingR: number;
  bossPhase: number;
  bossDowned: boolean;
  /** 0..1 tactical-zoom blend. */
  zoom: number;
  /** 7B-8 out of combat: peripheral HUD at 55 %. */
  calm: boolean;
  /** 7A-4 ADS target mini HP bar: shown, HP fraction, enemy name. */
  aimVisible: boolean;
  aimFrac: number;
  aimName: string;
  /** 0..1 recoil bloom of the reticle (shots open it, it closes again — 5B-5 dynamic reticle). */
  reticleKick: number;
  /** Active buffs: SK_02 piercing shots left (0 = none), SK_11 boost, SK_14 adrenaline. */
  buffPierce: number;
  buffZero: boolean;
  buffAdren: boolean;
  /** Tracking markers (screen px, already clamped), distance (m), off-screen / boss flags. */
  trackCount: number;
  readonly trackX: Float32Array;
  readonly trackY: Float32Array;
  readonly trackDist: Float32Array;
  readonly trackOff: Uint8Array;
  readonly trackBoss: Uint8Array;
  /** 8A-5 awareness arcs: screen angle (deg, clockwise from up), 0..1 gauge, state rank (1 alert, 2 detected, 3 combat). */
  awareCount: number;
  readonly awareAngles: Float32Array;
  readonly awareGauge: Float32Array;
  readonly awareRank: Uint8Array;
  /** 8A-5 district status ('' hides the badge, e.g. boss sector or gate open). */
  alertTag: string;
  /** 10A-3.4: Sniper 4x ADS digital rangefinder distance in metres (−1 when hidden). */
  rangefinderM: number;
  /** 10A-6: Player world coordinates & yaw for the top-left pulse-scan mini-radar. */
  playerX: number;
  playerY: number;
  playerZ: number;
  playerYaw: number;
}

export const HUD_MAX_AWARE = 4;
/** Length of one 28° awareness arc at r = 78 px. */
const AWARE_LEN = 78 * 28 * (Math.PI / 180);

export const HUD_MAX_WARNINGS = 8;
export const HUD_MAX_TRACKS = 6;
export const HUD_MAX_RADAR = 24;
/** BT arc "refused" blink (ms) and armour alert (ms), 5A-1 / 5A-5. */
const BT_DENIED_S = 0.35;
const ALERT_S = 1.2;

// =============================================================================================
// 10A-6: Tactical Pulse-Scan Mini-Radar (pure math & state machine, Option C — no 3D wallhack)
// =============================================================================================
export type RadarElevation = 'UP' | 'DOWN' | 'LEVEL';

export interface RadarProjection {
  /** Horizontal offset in radar canvas pixels from center (+X right). */
  xPx: number;
  /** Vertical offset in radar canvas pixels from center (-Y up / player forward). */
  yPx: number;
  /** Player-relative right offset in metres. */
  rightM: number;
  /** Player-relative forward offset in metres. */
  fwdM: number;
  /** Horizontal distance in metres. */
  distM: number;
  /** True when horizontal distance exceeds the radar range (75 m). */
  outOfRange: boolean;
}

export interface RadarBlipSnapshot {
  id: number;
  active: boolean;
  x: number;
  y: number;
  z: number;
  state: AlertState;
  ageS: number;
  alpha: number;
}

/** 10A-6: Elevation tick indicator (`▲` above if Δy >= +3.5 m, `▼` below if Δy <= −3.5 m). */
export function computeRadarElevation(enemyY: number, playerY: number): RadarElevation {
  const dy = enemyY - playerY;
  if (dy >= RADAR.ELEVATION_THRESHOLD_M) return 'UP';
  if (dy <= -RADAR.ELEVATION_THRESHOLD_M) return 'DOWN';
  return 'LEVEL';
}

/** 10A-6: Blip alpha fading smoothly from 1.0 down to 0.18 over 3.2 s between 3.5 s sweeps. */
export function computeRadarBlipAlpha(ageS: number): number {
  const t = clamp(ageS / RADAR.BLIP_FADE_S, 0, 1);
  return 1.0 - (1.0 - RADAR.BLIP_MIN_ALPHA) * t;
}

/**
 * 10A-6: Projects an enemy world position `(enemyX, enemyZ)` into player-relative radar canvas coordinates
 * rotating continuously with `-playerYaw` so "up" (`-Y`) is always the player's current forward view direction.
 */
export function projectRadarBlip(
  enemyX: number,
  enemyZ: number,
  playerX: number,
  playerZ: number,
  playerYaw: number,
  radiusPx: number,
  rangeM: number = RADAR.RANGE_M,
  out?: RadarProjection,
): RadarProjection {
  const dx = enemyX - playerX;
  const dz = enemyZ - playerZ;
  const distM = Math.hypot(dx, dz);
  const cos = Math.cos(playerYaw);
  const sin = Math.sin(playerYaw);
  // Three.js camera yaw: forward = (-sin(yaw), 0, -cos(yaw)), right = (cos(yaw), 0, -sin(yaw)).
  const rightM = dx * cos - dz * sin;
  const fwdM = -dx * sin - dz * cos;
  const outOfRange = distM > rangeM;
  const clampedM = Math.min(distM, rangeM);
  const scale = distM > 1e-5 ? ((clampedM / rangeM) * radiusPx) / distM : 0;
  const xPx = rightM * scale;
  const yPx = -fwdM * scale;
  if (out) {
    out.xPx = xPx;
    out.yPx = yPx;
    out.rightM = rightM;
    out.fwdM = fwdM;
    out.distM = distM;
    out.outOfRange = outOfRange;
    return out;
  }
  return { xPx, yPx, rightM, fwdM, distM, outOfRange };
}

/**
 * 10A-6: Pulse-scan radar state machine (zero allocations per step).
 * Every 3.5 s, an expanding cyan pulse ring sweeps from 0 -> 75 m over 0.65 s.
 * As the pulse ring crosses each enemy's distance, it refreshes that enemy's blip snapshot
 * `(x, y, z, state)` to `alpha = 1.0`, which then fades smoothly down to `0.18` over `3.2 s`.
 */
export class PulseRadar {
  readonly blips: RadarBlipSnapshot[] = Array.from({ length: HUD_MAX_RADAR }, (_, i) => ({
    id: i,
    active: false,
    x: 0,
    y: 0,
    z: 0,
    state: 'UNAWARE',
    ageS: 0,
    alpha: RADAR.BLIP_MIN_ALPHA,
  }));
  private readonly aliveMask = new Uint8Array(HUD_MAX_RADAR);
  private readonly sweptMask = new Uint8Array(HUD_MAX_RADAR);
  sweepClock = 0;
  /** Current expanding pulse ring radius in metres (0..75 m during the 0.65 s sweep, −1 between sweeps). */
  sweepRadiusM = 0;
  /**
   * 10B-2: true whenever the app is not `PLAYING` (PAUSED / TITLE / SKILL / RESULT / TRANSITION). While frozen,
   * `step()` is a no-op: the sweep clock, pulse radius, blip ages / alphas and snapshots hold, and no ping fires.
   */
  frozen = false;
  private initialized = false;

  reset(): void {
    for (const b of this.blips) {
      b.active = false;
      b.ageS = 0;
      b.alpha = RADAR.BLIP_MIN_ALPHA;
    }
    this.aliveMask.fill(0);
    this.sweptMask.fill(0);
    this.sweepClock = 0;
    this.sweepRadiusM = 0;
    this.initialized = false;
  }

  /**
   * Advances the pulse-scan cycle by `dt` real seconds.
   * Returns `true` on the frame a new 3.5 s sweep starts while at least one enemy is alive (`targetCount > 0`).
   */
  step(
    dt: number,
    playerX: number,
    playerY: number,
    playerZ: number,
    targets: readonly RadarEnemySample[],
    targetCount: number,
  ): boolean {
    void playerY;
    if (this.frozen) return false;
    this.aliveMask.fill(0);
    for (let i = 0; i < targetCount; i++) {
      const id = targets[i].id;
      if (id >= 0 && id < HUD_MAX_RADAR) this.aliveMask[id] = 1;
    }
    for (let i = 0; i < HUD_MAX_RADAR; i++) {
      if (!this.aliveMask[i]) this.blips[i].active = false;
      else if (this.blips[i].active) {
        this.blips[i].ageS += dt;
        this.blips[i].alpha = computeRadarBlipAlpha(this.blips[i].ageS);
      }
    }

    let pingTriggered = false;
    let prevR = this.sweepRadiusM < 0 ? 0 : this.sweepRadiusM;
    if (!this.initialized) {
      this.initialized = true;
      this.sweepClock = 0;
      this.sweepRadiusM = 0;
      prevR = 0;
      this.sweptMask.fill(0);
      pingTriggered = targetCount > 0;
    } else {
      this.sweepClock += dt;
      if (this.sweepClock >= RADAR.SWEEP_PERIOD_S) {
        this.sweepClock %= RADAR.SWEEP_PERIOD_S;
        this.sweepRadiusM = 0;
        prevR = 0;
        this.sweptMask.fill(0);
        pingTriggered = targetCount > 0;
      }
    }

    if (this.sweepClock <= RADAR.SWEEP_DURATION_S) {
      const curR = clamp(this.sweepClock / RADAR.SWEEP_DURATION_S, 0, 1) * RADAR.RANGE_M;
      this.sweepRadiusM = curR;
      for (let i = 0; i < targetCount; i++) {
        const t = targets[i];
        const id = t.id;
        if (id < 0 || id >= HUD_MAX_RADAR) continue;
        const b = this.blips[id];
        const d = Math.hypot(t.x - playerX, t.z - playerZ);
        const crossD = Math.min(d, RADAR.RANGE_M);
        if (!this.sweptMask[id] && crossD <= curR + 1e-4 && crossD >= prevR - 1e-4) {
          this.sweptMask[id] = 1;
          b.active = true;
          b.x = t.x;
          b.y = t.y;
          b.z = t.z;
          b.state = t.state;
          b.ageS = 0;
          b.alpha = 1.0;
        }
      }
    } else {
      // Ensure any target within the current sweep cycle that spawned or crossed at the boundary was captured.
      for (let i = 0; i < targetCount; i++) {
        const t = targets[i];
        const id = t.id;
        if (id < 0 || id >= HUD_MAX_RADAR) continue;
        if (!this.sweptMask[id]) {
          this.sweptMask[id] = 1;
          const b = this.blips[id];
          b.active = true;
          b.x = t.x;
          b.y = t.y;
          b.z = t.z;
          b.state = t.state;
          b.ageS = Math.max(0, this.sweepClock - RADAR.SWEEP_DURATION_S);
          b.alpha = computeRadarBlipAlpha(b.ageS);
        }
      }
      this.sweepRadiusM = -1;
    }

    return pingTriggered;
  }
}

const _radarProj: RadarProjection = { xPx: 0, yPx: 0, rightM: 0, fwdM: 0, distM: 0, outOfRange: false };

/** Structural view of the input's 450 ms click lock (InputManager satisfies it). */
export interface ClickGate {
  readonly clicksLocked: boolean;
  readonly clickLockProgress: number;
}

export interface ResultView {
  title: string;
  rank: string;
  rows: readonly (readonly [string, string])[];
  notes: readonly string[];
  endlessLabel: string;
}

export type FlowLogKind = 'kill' | 'evade' | 'skill';

/** m:ss.d */
export function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`;
}

// =============================================================================================
// Persistent save (§8.3)
// =============================================================================================
export class SaveStore {
  data: SaveData;

  constructor() {
    this.data = SaveStore.read();
  }

  private static read(): SaveData {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      return sanitizeSave(raw ? JSON.parse(raw) : null);
    } catch {
      return defaultSave();
    }
  }

  /** Writes the whole save; storage failures (private mode / sandboxed preview) are ignored. */
  write(): void {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(this.data));
    } catch {
      // Settings and records still apply for this session.
    }
  }
}
const DAMAGE_ARCS = 4;
const DAMAGE_ARC_S = 0.65;

function el<T extends HTMLElement | SVGElement = HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`HUD element #${id} missing`);
  return e as unknown as T;
}

export class HudManager {
  private readonly root = el('hud');
  private readonly dot = el('xh-dot');
  private readonly rangeEl = el('xh-range');
  private readonly radarCanvas = el<HTMLCanvasElement>('radar-canvas');
  private readonly radarCtx = this.radarCanvas.getContext('2d');
  readonly radar = new PulseRadar();
  private readonly reticles: Record<SlotId, SVGElement>;
  private readonly anchor = el('xh-anchor');
  private readonly btArc = el<SVGPathElement>('xh-bt-arc');
  private readonly btTrack = el<SVGPathElement>('xh-bt-track');
  private readonly swArc = el<SVGPathElement>('xh-sw-arc');
  private readonly swGroup = el<SVGGElement>('xh-sw');
  private readonly hpFill = el('hp-fill');
  private readonly hpNum = el('hp-num');
  private readonly hpRegen = el('hp-regen');
  private readonly hpRegenFill = el('hp-regen-fill');
  private readonly hpBar = el('hp');
  private readonly speedNum = el('spd-num');
  private readonly speedBox = el('spd');
  private readonly altNum = el('alt-num');
  private readonly dockItems: Record<SlotId, HTMLElement>;
  private readonly locked = el('dock-locked');
  private readonly ammoNum = el('ammo-num');
  private readonly ammoMax = el('ammo-max');
  private readonly ammoName = el('ammo-name');
  private readonly hitmarker = el<SVGGElement>('hitmarker');
  private readonly zoomBrackets = el<SVGGElement>('xh-zoom');
  private readonly adsTicks = el<SVGGElement>('xh-ads');
  private readonly aimHp = el('aim-hp');
  private readonly aimHpName = el('aim-hp-name');
  private readonly aimHpFill = el('aim-hp-fill');
  private btDeniedT = 0;
  private readonly alertEl = el('hud-alert');
  private alertT = 0;
  private readonly elimEl = el('eliminated');
  private readonly buffPierce = el('buff-pierce');
  private readonly buffZero = el('buff-zero');
  private readonly buffAdren = el('buff-adren');
  private readonly tracks: HTMLElement[];
  private readonly trackLabels: HTMLElement[];
  private readonly tkKeys = Array.from({ length: HUD_MAX_TRACKS }, (_, i) => [`tv${i}`, `tx${i}`, `to${i}`, `tb${i}`, `td${i}`]);
  /** 5B-5 title drawers (SETTINGS / PROTOCOL slide in from the right). */
  private drawerMode = false;
  private drawerOpen: 'settings' | 'protocol' | null = null;
  private hitT = 0;
  private hitKind: HitMarkerKind = 'BODY';
  private readonly evadeEl = el('evade');
  /** 11A-2 contextual door prompt below the reticle ("[F] OPEN QUIETLY" / "[F] BREACH KICK"). */
  private readonly interactEl = el('interact-prompt');
  private interactText: string | null = null;
  /** 11A-2 short event callout ("BREACH STUN"). */
  private readonly eventEl = el('hud-event');
  private readonly pauseFullscreenBtn = el('pause-fullscreen');
  /** 11A-2: Pause-menu FULLSCREEN button hook (main.ts wires it to `input.toggleFullscreen(false)`). */
  onFullscreen: (() => void) | null = null;
  private readonly warns: SVGPathElement[] = [];
  private readonly dmgArcs: SVGPathElement[] = [];
  private readonly dmgT = new Float32Array(DAMAGE_ARCS);
  private readonly dmgAngle = new Float32Array(DAMAGE_ARCS);
  private dmgNext = 0;
  private readonly sectorEl = el('sector-hud');
  private readonly sectorText = el('sector-text');
  private readonly alertTagEl = el('alert-tag');
  private readonly awareArcs: SVGPathElement[] = [];
  private readonly bossEl = el('boss-hud');
  private readonly bossName = el('boss-name');
  private readonly bossFill = el('boss-fill');
  private readonly bossWL = el('boss-wl');
  private readonly bossWR = el('boss-wr');
  private readonly bossDown = el('boss-down');
  private blinkClock = 0;
  // FLOW
  private readonly flowRankEl = el('flow-rank');
  private readonly flowFill = el('flow-fill');
  private readonly flowDelay = el('flow-delay');
  private readonly flowPts = el('flow-pts');
  private readonly flowLines: HTMLElement[];
  private readonly logText: string[] = ['', '', ''];
  private readonly logKind: string[] = ['', '', ''];
  private readonly bannerEl = el('banner');
  // Skill modal
  private readonly modal = el('skill-modal');
  private readonly modalHead = el('skill-head');
  private readonly modalCards = el('skill-cards');
  private readonly modalLock = el('skill-lock');
  private readonly modalLockFill = el('skill-lock-fill');
  private readonly modalLockLabel = el('skill-lock-label');
  private modalChoices: readonly SkillDef[] = [];
  private modalGate: ClickGate | null = null;
  private modalPick: ((id: SkillId) => void) | null = null;
  private modalUnlocked = false;
  // Result
  private readonly resultEl = el('result');
  private onEndless: (() => void) | null = null;
  private onTitle: (() => void) | null = null;
  private readonly wvKeys = Array.from({ length: HUD_MAX_WARNINGS }, (_, i) => `wv${i}`);
  private readonly waKeys = Array.from({ length: HUD_MAX_WARNINGS }, (_, i) => `wa${i}`);
  private readonly btLen: number;
  private readonly swLen: number;
  private readonly last = new Map<string, string | number | boolean>();
  private readonly perfEl = el('perf-overlay');
  private perfVisible = false;

  constructor() {
    this.reticles = {
      PISTOL: el<SVGElement>('ret-pistol'),
      SNIPER: el<SVGElement>('ret-sniper'),
      GRAPPLE: el<SVGElement>('ret-grapple'),
    };
    this.dockItems = {
      PISTOL: el('dock-PISTOL'),
      SNIPER: el('dock-SNIPER'),
      GRAPPLE: el('dock-GRAPPLE'),
    };
    this.btLen = this.btArc.getTotalLength();
    this.swLen = this.swArc.getTotalLength();
    this.btTrack.style.strokeDasharray = `${this.btLen} ${this.btLen}`;
    for (let i = 0; i < HUD_MAX_WARNINGS; i++) this.warns.push(el<SVGPathElement>(`warn-${i}`));
    for (let i = 0; i < DAMAGE_ARCS; i++) this.dmgArcs.push(el<SVGPathElement>(`dmg-${i}`));
    for (let i = 0; i < HUD_MAX_AWARE; i++) this.awareArcs.push(el<SVGPathElement>(`aware-${i}`));
    this.flowLines = Array.from(el('flow-log').children) as HTMLElement[];
    this.tracks = Array.from(el('trk-layer').children) as HTMLElement[];
    this.trackLabels = this.tracks.map((t) => t.querySelector('span') as HTMLElement);

    // Skill modal: number keys 1 / 2 / 3 (ignored during the 450 ms lock).
    window.addEventListener('keydown', (e) => {
      if (!this.modal.classList.contains('on') || e.repeat) return;
      const i = e.code === 'Digit1' ? 0 : e.code === 'Digit2' ? 1 : e.code === 'Digit3' ? 2 : -1;
      if (i >= 0) this.pickSkill(i);
    });
    el('result-endless').addEventListener('click', () => this.onEndless?.());
    el('result-title-btn').addEventListener('click', () => this.onTitle?.());
    this.pauseFullscreenBtn.addEventListener('click', () => this.onFullscreen?.());
    document.addEventListener('fullscreenchange', () => {
      this.pauseFullscreenBtn.textContent = document.fullscreenElement ? 'EXIT FULLSCREEN [F11]' : 'FULLSCREEN [F11]';
    });
    for (const b of Array.from(document.querySelectorAll<HTMLElement>('.drawer-close'))) {
      b.addEventListener('click', () => this.toggleDrawer(b.dataset.drawer === 'protocol' ? 'protocol' : 'settings'));
    }
    for (const id of ['settings', 'protocol', 'pause-panel', 'skill-modal', 'result']) {
      const p = document.getElementById(id);
      // Clicks inside menus never reach the pause overlay / canvas.
      p?.addEventListener('click', (e) => e.stopPropagation());
      p?.addEventListener('mousedown', (e) => e.stopPropagation());
    }
  }

  // =============================================================================================
  // FLOW RANK panel (§6.3 top-right)
  // =============================================================================================
  /** `progress` 0..1 toward the next rank; `delay` 0..1 of the 3.5 s grace before decay starts. */
  updateFlow(rankIndex: number, progress: number, delay: number, points: number, score: number): void {
    if (this.changed('frk', rankIndex)) {
      const prev = this.last.get('frkPrev');
      this.flowRankEl.textContent = FLOW_RANKS[rankIndex].id;
      this.flowRankEl.className = `r${rankIndex}`;
      if (typeof prev === 'number' && rankIndex > prev) {
        void this.flowRankEl.offsetWidth;
        this.flowRankEl.classList.add('pop');
      }
      this.last.set('frkPrev', rankIndex);
      this.root.classList.toggle('flow-c', rankIndex >= 1);
    }
    const pq = Math.round(clamp(progress, 0, 1) * 200) / 2;
    if (this.changed('fpg', pq)) this.flowFill.style.width = `${pq}%`;
    const dq = Math.round(clamp(delay, 0, 1) * 100);
    if (this.changed('fdl', dq)) this.flowDelay.style.width = `${dq}%`;
    const pts = Math.round(points);
    const sc = Math.round(score);
    if (this.changed('fpt', pts) || this.changed('fsc', sc)) this.flowPts.textContent = `FLOW ${pts} · SCORE ${sc}`;
  }

  /** Pushes a line onto the 3-line action log ("AIR HEADSHOT +300"); `points` ≤ 0 shows the label only. */
  flowLog(label: string, points: number, kind: FlowLogKind): void {
    for (let i = this.logText.length - 1; i > 0; i--) {
      this.logText[i] = this.logText[i - 1];
      this.logKind[i] = this.logKind[i - 1];
    }
    this.logText[0] = points > 0 ? `${label} +${Math.round(points)}` : label;
    this.logKind[0] = kind;
    for (let i = 0; i < this.flowLines.length; i++) {
      const line = this.flowLines[i];
      line.textContent = this.logText[i];
      line.className = `${this.logKind[i]}${i === 0 ? ' fresh' : ''}`;
      line.style.opacity = String(1 - i * 0.28);
    }
    void this.flowLines[0].offsetWidth;
  }

  clearFlowLog(): void {
    for (let i = 0; i < this.logText.length; i++) {
      this.logText[i] = '';
      this.flowLines[i].textContent = '';
    }
  }

  /** Sector start banner. */
  banner(title: string, sub: string, loopText: string): void {
    el('banner-s').textContent = title;
    el('banner-sub').textContent = sub;
    el('banner-loop').textContent = loopText;
    this.bannerEl.classList.remove('on');
    void this.bannerEl.offsetWidth;
    this.bannerEl.classList.add('on');
  }

  setDim(on: boolean): void {
    this.root.classList.toggle('dim', on);
  }

  // =============================================================================================
  // Skill modal (§3.6-5: 450 ms input lock with a progress bar)
  // =============================================================================================
  openSkillModal(header: string, choices: readonly SkillDef[], levels: SkillLevels, gate: ClickGate, onPick: (id: SkillId) => void): void {
    this.modalChoices = choices;
    this.modalGate = gate;
    this.modalPick = onPick;
    this.modalUnlocked = false;
    this.modalHead.textContent = header;
    this.modalCards.textContent = '';
    choices.forEach((sk, i) => {
      const lv = levels[sk.id];
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'skill-card locked';
      const pips = Array.from({ length: SKILL_MAX_LEVEL }, (_, k) => `<i class="${k < lv ? 'own' : k === lv ? 'next' : ''}"></i>`).join('');
      card.innerHTML =
        `<div class="k">[${i + 1}] ${sk.id}</div><div class="cat">${sk.category}</div>` +
        `<div class="nm">${sk.name}</div><div class="en">${sk.nameEn}</div>` +
        `<div class="tr">TRIGGER — ${sk.trigger}</div><div class="fx">Lv.${lv + 1}: ${sk.levelText[lv]}</div>` +
        `<div class="lv">${pips}<span>${lv > 0 ? `Lv.${lv} → ${lv + 1}` : 'NEW'}</span></div>`;
      card.addEventListener('click', () => this.pickSkill(i));
      this.modalCards.appendChild(card);
    });
    this.modalLock.classList.remove('open');
    this.modalLockLabel.classList.remove('open');
    this.modalLockLabel.textContent = 'INPUT LOCK';
    this.modalLockFill.style.width = '0%';
    this.modal.classList.add('on');
  }

  /** Per frame while the modal is open; returns true on the frame the 450 ms lock releases. */
  updateSkillModal(): boolean {
    const g = this.modalGate;
    if (!g || !this.modal.classList.contains('on')) return false;
    this.modalLockFill.style.width = `${(g.clickLockProgress * 100).toFixed(1)}%`;
    if (!g.clicksLocked && !this.modalUnlocked) {
      this.modalUnlocked = true;
      this.modalLock.classList.add('open');
      this.modalLockLabel.classList.add('open');
      this.modalLockLabel.textContent = 'READY — SELECT';
      for (const c of Array.from(this.modalCards.children)) c.classList.remove('locked');
      return true;
    }
    return false;
  }

  private pickSkill(i: number): void {
    const g = this.modalGate;
    if (!g || g.clicksLocked || i >= this.modalChoices.length) return;
    const pick = this.modalPick;
    const id = this.modalChoices[i].id;
    this.closeSkillModal();
    pick?.(id);
  }

  closeSkillModal(): void {
    this.modal.classList.remove('on');
    this.modalGate = null;
    this.modalPick = null;
  }

  get skillModalOpen(): boolean {
    return this.modal.classList.contains('on');
  }

  // =============================================================================================
  // Result screen (§8.3)
  // =============================================================================================
  showResult(v: ResultView, onEndless: () => void, onTitle: () => void): void {
    el('result-title').textContent = v.title;
    el('result-rank').textContent = v.rank;
    const stats = el('result-stats');
    stats.textContent = '';
    for (const [k, val] of v.rows) {
      const a = document.createElement('span');
      a.textContent = k;
      const b = document.createElement('span');
      b.textContent = val;
      stats.append(a, b);
    }
    el('result-notes').innerHTML = v.notes.map((n) => `<div>${n}</div>`).join('');
    el('result-endless').textContent = v.endlessLabel;
    this.onEndless = onEndless;
    this.onTitle = onTitle;
    this.resultEl.classList.add('on');
  }

  hideResult(): void {
    this.resultEl.classList.remove('on');
  }

  // =============================================================================================
  // Pause panel / screen-level panels
  // =============================================================================================
  setPauseInfo(runText: string, skills: readonly { name: string; level: number }[]): void {
    el('pause-run').textContent = runText;
    const box = el('pause-skills');
    box.textContent = '';
    if (skills.length === 0) {
      const s = document.createElement('span');
      s.textContent = 'NO PROTOCOLS YET';
      box.appendChild(s);
    }
    for (const sk of skills) {
      const s = document.createElement('span');
      s.textContent = `${sk.name} Lv.${sk.level}`;
      box.appendChild(s);
    }
  }

  /**
   * `drawers` (title screen): both panels become right-side drawers, closed until a title button opens one.
   * Otherwise the panels show in place (pause: settings only).
   */
  showPanels(settings: boolean, protocol: boolean, drawers = false): void {
    const s = el('settings');
    const p = el('protocol');
    this.drawerMode = drawers;
    this.drawerOpen = null;
    for (const e of [s, p]) {
      e.classList.toggle('drawer', drawers);
      e.classList.remove('open');
    }
    s.classList.toggle('hidden', !drawers && !settings);
    p.classList.toggle('hidden', !drawers && !protocol);
    this.syncDrawerButtons();
  }

  /** Opens `name` (closing the other drawer) or closes it when already open. Returns the open drawer. */
  toggleDrawer(name: 'settings' | 'protocol'): 'settings' | 'protocol' | null {
    if (!this.drawerMode) return null;
    this.drawerOpen = this.drawerOpen === name ? null : name;
    el('settings').classList.toggle('open', this.drawerOpen === 'settings');
    el('protocol').classList.toggle('open', this.drawerOpen === 'protocol');
    this.syncDrawerButtons();
    return this.drawerOpen;
  }

  private syncDrawerButtons(): void {
    document.getElementById('title-settings-btn')?.classList.toggle('on', this.drawerOpen === 'settings');
    document.getElementById('title-protocol-btn')?.classList.toggle('on', this.drawerOpen === 'protocol');
  }

  // =============================================================================================
  // Settings & accessibility (§3.1 sensitivity, §3.6-7, §9.2 quality)
  // =============================================================================================
  /** Initialises every control from `s`; `onChange(key)` runs after `s` was updated by the user. */
  bindSettings(s: SaveSettings, onChange: (key: keyof SaveSettings) => void): void {
    const range = el<HTMLElement>('sens-range') as unknown as HTMLInputElement;
    const num = el<HTMLElement>('sens-num') as unknown as HTMLInputElement;
    const setSens = (v: number, fromNum: boolean): void => {
      // 7A-2: 0.20 … 10.00 in 0.05 steps.
      const st = INPUT.SENSITIVITY_STEP;
      const value = Math.round(Math.round(clamp(Number.isFinite(v) ? v : 1, INPUT.SENSITIVITY_MIN, INPUT.SENSITIVITY_MAX) / st) * st * 100) / 100;
      s.sensitivity = value;
      range.value = String(value);
      if (!fromNum || document.activeElement !== num) num.value = value.toFixed(2);
      onChange('sensitivity');
    };
    range.value = String(s.sensitivity);
    num.value = s.sensitivity.toFixed(2);
    range.addEventListener('input', () => setSens(parseFloat(range.value), false));
    num.addEventListener('change', () => {
      setSens(parseFloat(num.value), false);
    });
    num.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') num.blur();
    });
    el('sens-reset').addEventListener('click', () => setSens(1, false));

    const seg = (id: string, current: string, apply: (v: string) => void): void => {
      const box = el(id);
      const buttons = Array.from(box.querySelectorAll('button'));
      const mark = (v: string): void => buttons.forEach((b) => b.classList.toggle('on', b.dataset.v === v));
      mark(current);
      buttons.forEach((b) =>
        b.addEventListener('click', () => {
          const v = b.dataset.v ?? '';
          mark(v);
          apply(v);
        }),
      );
    };
    seg('set-shake', String(s.shake), (v) => {
      s.shake = parseFloat(v);
      onChange('shake');
    });
    seg('set-roll', String(s.roll), (v) => {
      s.roll = parseFloat(v);
      onChange('roll');
    });
    seg('set-dot', s.centerDot ? '1' : '0', (v) => {
      s.centerDot = v === '1';
      onChange('centerDot');
    });
    seg('set-latency', s.lowLatency ? '1' : '0', (v) => {
      s.lowLatency = v === '1';
      onChange('lowLatency');
    });
    seg('set-quality', s.quality, (v) => {
      s.quality = v === 'LOW' ? 'LOW' : v === 'MEDIUM' ? 'MEDIUM' : 'HIGH';
      onChange('quality');
    });
    seg('set-filter', s.filter, (v) => {
      const hit = SCREEN_FILTERS.find((f) => f.id === v);
      s.filter = hit ? hit.id : 'CYBER_NOIR';
      onChange('filter');
    });
    seg('set-shadows', s.shadows ? '1' : '0', (v) => {
      s.shadows = v === '1';
      onChange('shadows');
    });
    // 12A-4 RCAS sharpening toggle (KineticPostFX; compiled out on LOW via the LITE define).
    seg('set-sharpen', s.sharpen ? '1' : '0', (v) => {
      s.sharpen = v === '1';
      onChange('sharpen');
    });
    seg('set-perf', s.showPerf ? '1' : '0', (v) => {
      s.showPerf = v === '1';
      onChange('showPerf');
    });
    const fov = el('set-fov') as unknown as HTMLInputElement;
    const fovVal = el('set-fov-val');
    fov.value = String(s.fov);
    fovVal.textContent = `${s.fov}°`;
    fov.addEventListener('input', () => {
      s.fov = Math.round(clamp(parseFloat(fov.value), 75, 100));
      fovVal.textContent = `${s.fov}°`;
      onChange('fov');
    });
    const vol = el('set-vol') as unknown as HTMLInputElement;
    const volVal = el('set-vol-val');
    vol.value = String(Math.round(s.volume * 100));
    volVal.textContent = String(Math.round(s.volume * 100));
    vol.addEventListener('input', () => {
      s.volume = clamp(parseFloat(vol.value) / 100, 0, 1);
      volVal.textContent = String(Math.round(s.volume * 100));
      onChange('volume');
    });
  }

  /** 10A-1 compact top-right performance telemetry overlay (`FPS | frame ms | draw calls`). */
  setPerfVisible(on: boolean): void {
    this.perfVisible = on;
    this.perfEl.hidden = !on;
  }

  updatePerf(fps: number, frameMs: number, calls: number): void {
    if (!this.perfVisible) return;
    const f = Math.round(fps);
    const ms = frameMs.toFixed(1);
    const text = `${f} FPS | ${ms} ms | ${calls} calls`;
    if (this.changed('perfTxt', text)) this.perfEl.textContent = text;
  }

  // =============================================================================================
  // Title: records, challenge modifiers (after the first clear), energy colours
  // =============================================================================================
  renderProtocol(save: SaveData, onToggleModifier: (id: ModifierId) => void, onColor: (id: EnergyColorId) => void): void {
    const best = save.bestTimeS === null ? '--:--' : formatTime(save.bestTimeS);
    el('records').innerHTML =
      `BEST TIME <b>${best}</b> · BEST RANK <b>${save.bestRank ?? '—'}</b><br />` +
      `BEST FLOW SCORE <b>${Math.round(save.bestFlowScore)}</b> · MAX LOOP <b>${save.maxLoop}</b><br />` +
      `TOTAL HEADSHOTS <b>${save.totalHeadshots}</b>`;
    const mods = el('mod-buttons');
    mods.textContent = '';
    for (const m of MODIFIERS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = `${m.label} ×${m.scoreMultiplier}`;
      b.title = m.description;
      b.disabled = !save.cleared;
      b.classList.toggle('on', save.activeModifiers.includes(m.id));
      b.addEventListener('click', () => onToggleModifier(m.id));
      mods.appendChild(b);
    }
    el('mod-note').textContent = save.cleared
      ? save.activeModifiers.length
        ? MODIFIERS.filter((m) => save.activeModifiers.includes(m.id)).map((m) => m.description).join(' / ')
        : 'NONE ACTIVE'
      : 'LOCKED — CLEAR SECTOR 05 ONCE TO UNLOCK';
    const colors = el('colors');
    colors.textContent = '';
    for (const c of ENERGY_COLORS) {
      const b = document.createElement('button');
      b.type = 'button';
      const unlocked = save.unlockedColors.includes(c.id);
      b.innerHTML = `<i style="background:#${c.hex.toString(16).padStart(6, '0')}"></i>${unlocked ? c.id : 'LOCKED'}`;
      b.title = unlocked ? c.label : `${c.label} — ${c.unlock}`;
      b.disabled = !unlocked;
      b.classList.toggle('on', save.selectedColor === c.id);
      b.addEventListener('click', () => onColor(c.id));
      colors.appendChild(b);
    }
  }

  /** Hit marker: body = white × 120 ms, head / kills / breaks = 180 ms (§6.3). */
  hitMarker(kind: HitMarkerKind): void {
    this.hitKind = kind;
    const light = kind === 'BODY' || kind === 'SHIELD' || kind === 'ARMOR' || kind === 'WING';
    this.hitT = (light ? JUICE.HITMARKER_BODY_MS : JUICE.HITMARKER_HEAD_MS) / 1000;
    this.hitmarker.setAttribute('class', `hm on ${HIT_CLASS[kind]}`);
    const big = kind === 'HEAD' || kind === 'HEAD_KILL' || kind === 'PART';
    this.hitmarker.setAttribute('transform', big ? 'scale(1.45)' : 'scale(1)');
  }

  /** 5A-1: air RMB that could not start bullet time — the BT arc blinks dark grey for 350 ms. */
  btDenied(): void {
    this.btDeniedT = BT_DENIED_S;
  }

  /** 5A-5: short centre alert ("ARMORED — DESTROY WINGS", 1.2 s). */
  armorAlert(): void {
    this.alertT = ALERT_S;
    if (this.changed('alert', true)) this.alertEl.classList.add('on');
  }

  /** 5A-5: "ELIMINATED // <cause>" over the death glitch; null hides it. */
  eliminated(cause: string | null): void {
    if (cause === null) {
      this.elimEl.classList.remove('on');
      return;
    }
    this.elimEl.innerHTML = `ELIMINATED <small>// ${cause}</small>`;
    this.elimEl.classList.remove('on');
    void this.elimEl.offsetWidth;
    this.elimEl.classList.add('on');
  }

  /** GRAZE pop-up "EVADE +90" (restarts the animation). */
  evade(points: number): void {
    this.evadeEl.textContent = `EVADE +${points}`;
    this.evadeEl.classList.remove('on');
    void this.evadeEl.offsetWidth;
    this.evadeEl.classList.add('on');
  }

  /**
   * 11A-2: contextual interact prompt below the reticle; `null` hides it. Touches the DOM only when the text
   * changes (call every frame freely — same string literal → zero DOM writes, zero allocations).
   */
  setInteractPrompt(text: string | null): void {
    if (text === this.interactText) return;
    this.interactText = text;
    if (text === null) {
      this.interactEl.classList.remove('on');
      return;
    }
    this.interactEl.textContent = text;
    this.interactEl.classList.toggle('breach', text.includes('BREACH'));
    this.interactEl.classList.add('on');
  }

  /** 11A-2: short-lived centre event callout (e.g. "BREACH STUN", 1.1 s pop; restarts on repeat). */
  flashEvent(text: string): void {
    this.eventEl.textContent = text;
    this.eventEl.classList.remove('on');
    void this.eventEl.offsetWidth;
    this.eventEl.classList.add('on');
  }

  /** Red arc toward where a hit came from (deg, clockwise from screen-up). */
  damageFrom(angleDeg: number): void {
    const i = this.dmgNext;
    this.dmgNext = (i + 1) % DAMAGE_ARCS;
    this.dmgT[i] = DAMAGE_ARC_S;
    this.dmgAngle[i] = angleDeg;
    this.dmgArcs[i].setAttribute('transform', `rotate(${angleDeg.toFixed(1)})`);
    this.dmgArcs[i].style.display = 'block';
  }

  setVisible(on: boolean): void {
    this.root.classList.toggle('visible', on);
  }

  /**
   * 10B-2: freezes the mini-radar outside `PLAYING` — `radar.step()` stops advancing, the canvas is no longer
   * redrawn (it keeps the last live frame) and it dims to 22 % grey behind the pause / modal overlays.
   */
  setRadarFrozen(on: boolean): void {
    this.radar.frozen = on;
    this.root.classList.toggle('radar-frozen', on);
  }

  /** Clears the radar state and canvas (new sector / retry) so no stale blips linger behind a frozen overlay. */
  resetRadar(): void {
    this.radar.reset();
    this.radarCtx?.clearRect(0, 0, RADAR.SIZE_PX, RADAR.SIZE_PX);
  }

  private changed(key: string, v: string | number | boolean): boolean {
    if (this.last.get(key) === v) return false;
    this.last.set(key, v);
    return true;
  }

  update(f: HudFrame): void {
    if (this.changed('calm', f.calm)) this.root.classList.toggle('calm', f.calm);
    this.updateCombat(f);
    // --- Crosshair ---
    if (this.changed('dot', f.centerDot)) this.dot.style.display = f.centerDot ? 'block' : 'none';
    if (this.changed('slot', f.slot)) {
      for (const k of Object.keys(this.reticles) as SlotId[]) this.reticles[k].style.display = k === f.slot ? 'block' : 'none';
      for (const k of Object.keys(this.dockItems) as SlotId[]) this.dockItems[k].classList.toggle('active', k === f.slot);
      this.ammoName.textContent = isGun(f.slot) ? GUNS[f.slot].name : 'S-00 STRAND';
    }
    if (this.changed('pending', f.pendingSlot ?? '')) {
      for (const k of Object.keys(this.dockItems) as SlotId[]) this.dockItems[k].classList.toggle('pending', k === f.pendingSlot);
    }

    // --- Grapple lock diamond ---
    if (this.changed('anc', f.anchorVisible)) this.anchor.style.display = f.anchorVisible ? 'block' : 'none';
    if (f.anchorVisible) {
      const ax = Math.round(f.anchorX);
      const ay = Math.round(f.anchorY);
      if (this.changed('ax', ax) || this.changed('ay', ay)) this.anchor.style.transform = `translate(${ax}px, ${ay}px) translate(-50%, -50%) rotate(45deg)`;
      if (this.changed('ancS', f.anchorStrong)) this.anchor.classList.toggle('strong', f.anchorStrong);
    }

    // --- Tactical zoom: optical brackets close 46 → 28 px and fade in past 20 %; the reticle tightens ---
    const z = clamp(f.zoom, 0, 1);
    const zq = Math.round(z * 100) / 100;
    if (this.changed('zm', zq)) {
      const r = 46 + (28 - 46) * zq;
      this.zoomBrackets.setAttribute('transform', `scale(${(r / 46).toFixed(3)})`);
      this.zoomBrackets.style.opacity = clamp((zq - 0.2) / 0.3, 0, 1).toFixed(2);
    }
    // 5B-5 dynamic reticle: recoil opens it (up to +55 %), zoom tightens it (−12 %).
    const kq = Math.round(clamp(f.reticleKick, 0, 1) * 50) / 50;
    if (this.changed('rk', kq) || this.changed('rkz', zq) || this.changed('rks', f.slot)) {
      const sc = (1 + 0.55 * kq) * (1 - 0.12 * zq);
      this.reticles[f.slot].setAttribute('transform', `scale(${sc.toFixed(3)})`);
      // 7A-1: past 60 % zoom the physical holo sight's collimated dot is the only aim point — the weapon reticle
      // and the centre dot fade out, four hairline ticks (12 → 18 px from the centre) stay as a frame.
      const ads = clamp((zq - 0.45) / 0.15, 0, 1);
      this.reticles[f.slot].style.opacity = (1 - ads).toFixed(2);
      this.adsTicks.style.opacity = ads.toFixed(2);
      this.dot.style.opacity = (1 - ads).toFixed(2);
    }
    // 7A-4: target mini HP bar (zoom > 0.3, ≤ 3.5° from the aim point, visible, not the boss).
    if (this.changed('aimV', f.aimVisible)) this.aimHp.style.opacity = f.aimVisible ? '1' : '0';
    if (f.aimVisible) {
      if (this.changed('aimN', f.aimName)) this.aimHpName.textContent = f.aimName.toLowerCase();
      const fq = Math.round(clamp(f.aimFrac, 0, 1) * 88) / 88;
      if (this.changed('aimF', fq)) this.aimHpFill.style.transform = `scaleX(${fq.toFixed(3)})`;
    }
    // 10A-3.4: Sniper 4x ADS digital rangefinder readout (just bottom-right of reticle, 11px, subtle cyan 0.75 alpha).
    const showRange = f.rangefinderM >= 0;
    if (this.changed('rngV', showRange)) this.rangeEl.style.display = showRange ? 'block' : 'none';
    if (showRange) {
      const rm = Math.round(f.rangefinderM);
      if (this.changed('rngM', rm)) this.rangeEl.textContent = `${rm}m`;
    }
    // 10A-6: Top-left 136×136 circular pulse-scan mini-radar (+0 WebGL draw calls).
    this.drawRadar(f);
    const sharp = z > 0.2;
    if (this.changed('zs', sharp) || this.changed('zsl', f.slot)) {
      for (const k of Object.keys(this.reticles) as SlotId[]) {
        this.reticles[k].classList.toggle('sharp', sharp && k === f.slot);
        if (k !== f.slot) this.reticles[k].removeAttribute('transform');
      }
    }

    // --- Bullet-time arc (right); dark-grey blink when an air activation was refused ---
    const bt = clamp(f.btGauge / BULLET_TIME.MAX_GAUGE, 0, 1);
    const btQ = Math.round(bt * 200) / 200;
    if (this.changed('bt', btQ)) this.btArc.style.strokeDasharray = `${this.btLen * btQ} ${this.btLen}`;
    if (this.btDeniedT > 0) this.btDeniedT -= f.realDt;
    const denied = this.btDeniedT > 0;
    const btClass = denied ? 'denied' : f.btActive ? 'active' : f.btGauge < BULLET_TIME.MIN_ACTIVATE ? 'low' : 'ready';
    if (this.changed('btc', btClass)) {
      this.btArc.setAttribute('class', `arc ${btClass}`);
      this.btTrack.setAttribute('class', denied ? 'track denied' : 'track');
    }

    // --- Active buff tags ---
    const pierceOn = f.buffPierce > 0;
    if (this.changed('bfp', f.buffPierce)) {
      this.buffPierce.classList.toggle('on', pierceOn);
      if (pierceOn) this.buffPierce.textContent = `PIERCE ×${f.buffPierce}`;
    }
    if (this.changed('bfz', f.buffZero)) this.buffZero.classList.toggle('on', f.buffZero);
    if (this.changed('bfa', f.buffAdren)) this.buffAdren.classList.toggle('on', f.buffAdren);

    // --- Switch / reload arc (left) ---
    const sw = f.switchProgress >= 0 ? f.switchProgress : f.reloadProgress;
    const swOn = sw >= 0;
    if (this.changed('swOn', swOn)) this.swGroup.style.display = swOn ? 'block' : 'none';
    if (swOn) {
      const q = Math.round(sw * 100) / 100;
      if (this.changed('sw', q)) this.swArc.style.strokeDasharray = `${this.swLen * q} ${this.swLen}`;
      const mode = f.switchProgress >= 0 ? 'switch' : 'reload';
      if (this.changed('swm', mode)) this.swArc.setAttribute('class', `arc ${mode}`);
    }

    // --- HP + regen countdown ---
    const hpQ = Math.round((f.hp / f.maxHp) * 1000) / 10;
    if (this.changed('hp', hpQ)) {
      this.hpFill.style.width = `${hpQ}%`;
      this.hpNum.textContent = String(Math.ceil(f.hp));
    }
    const crit = f.hp <= PLAYER.CRITICAL_HP;
    if (this.changed('crit', crit)) this.hpBar.classList.toggle('critical', crit);
    if (this.changed('regen', f.regenerating)) this.hpBar.classList.toggle('regen', f.regenerating);
    const waiting = f.hp < f.maxHp && !f.regenerating;
    if (this.changed('wait', waiting)) this.hpRegen.style.visibility = waiting ? 'visible' : 'hidden';
    const rc = Math.round(f.regenCountdown * 200) / 2;
    if (this.changed('rc', rc)) this.hpRegenFill.style.width = `${rc}%`;
    const flash = f.sinceShot < 0.18;
    if (this.changed('fl', flash)) this.hpRegen.classList.toggle('reset', flash);

    // --- Speed / altitude ---
    const sp = (Math.round(f.speed * 10) / 10).toFixed(1);
    if (this.changed('sp', sp)) this.speedNum.textContent = sp;
    const fast = f.speed > 18;
    if (this.changed('fast', fast)) this.speedBox.classList.toggle('fast', fast);
    const alt = (Math.round(f.altitude * 10) / 10).toFixed(1);
    if (this.changed('alt', alt)) this.altNum.textContent = alt;

    // --- Dock / ammo ---
    if (this.changed('lock', f.ropeAttached)) this.locked.classList.toggle('on', f.ropeAttached);
    if (isGun(f.slot)) {
      if (this.changed('am', f.ammo)) this.ammoNum.textContent = String(f.ammo);
      if (this.changed('mx', f.magazine)) this.ammoMax.textContent = `/ ${f.magazine}`;
      const low = f.ammo <= Math.max(1, Math.floor(f.magazine * 0.25));
      if (this.changed('low', low)) this.ammoNum.classList.toggle('low', low);
    } else {
      const cd = f.grappleCooldown > 0 ? f.grappleCooldown.toFixed(2) : '∞';
      if (this.changed('am', cd)) this.ammoNum.textContent = cd;
      const unit = f.grappleCooldown > 0 ? 's' : '';
      if (this.changed('mx', unit)) this.ammoMax.textContent = unit;
      if (this.changed('low', false)) this.ammoNum.classList.remove('low');
    }
  }

  private updateCombat(f: HudFrame): void {
    const dt = f.realDt;
    this.blinkClock += dt;
    // Armour alert timer.
    if (this.alertT > 0) {
      this.alertT -= dt;
      if (this.alertT <= 0 && this.changed('alert', false)) this.alertEl.classList.remove('on');
    }
    // Tracking diamonds (last ≤ 3 enemies, VALKYRIE always).
    for (let i = 0; i < HUD_MAX_TRACKS; i++) {
      const k = this.tkKeys[i];
      const vis = i < f.trackCount;
      if (this.changed(k[0], vis)) this.tracks[i].style.display = vis ? 'block' : 'none';
      if (!vis) continue;
      const x = Math.round(f.trackX[i]);
      const y = Math.round(f.trackY[i]);
      const key = x * 10000 + y;
      if (this.changed(k[1], key)) this.tracks[i].style.transform = `translate(${x}px, ${y}px)`;
      const off = f.trackOff[i] === 1;
      const boss = f.trackBoss[i] === 1;
      if (this.changed(k[2], off) || this.changed(k[3], boss)) this.tracks[i].className = `trk${off ? ' off' : ''}${boss ? ' boss' : ''}`;
      if (off) {
        const d = Math.round(f.trackDist[i]);
        if (this.changed(k[4], d)) this.trackLabels[i].textContent = `${d}m`;
      }
    }
    // Hit marker timer.
    if (this.hitT > 0) {
      this.hitT -= dt;
      if (this.hitT <= 0) this.hitmarker.setAttribute('class', `hm ${HIT_CLASS[this.hitKind]}`);
    }
    // Off-screen lock warnings blink at the telegraph rate.
    const on = Math.floor(this.blinkClock * TELEGRAPH.LOCK_BLINK_HZ * 2) % 2 === 0;
    for (let i = 0; i < HUD_MAX_WARNINGS; i++) {
      const vis = i < f.warnCount && on;
      if (this.changed(this.wvKeys[i], vis)) this.warns[i].style.display = vis ? 'block' : 'none';
      if (i < f.warnCount) {
        const a = Math.round(f.warnAngles[i]);
        if (this.changed(this.waKeys[i], a)) this.warns[i].setAttribute('transform', `rotate(${a})`);
      }
    }
    // Damage direction arcs fade out.
    for (let i = 0; i < DAMAGE_ARCS; i++) {
      if (this.dmgT[i] <= 0) continue;
      this.dmgT[i] -= dt;
      if (this.dmgT[i] <= 0) this.dmgArcs[i].style.display = 'none';
      else this.dmgArcs[i].style.opacity = (this.dmgT[i] / DAMAGE_ARC_S).toFixed(2);
    }
    // Sector progress / gate.
    if (this.changed('gate', f.gateOpen)) this.sectorEl.classList.toggle('open', f.gateOpen);
    const remChanged = this.changed('rem', f.remaining);
    const nameChanged = this.changed('sname', f.sectorName);
    if (this.changed('gateTxt', f.gateOpen) || remChanged || nameChanged) {
      this.sectorText.textContent = f.gateOpen ? 'GATE OPEN — ADVANCE TO NEXT DISTRICT' : `${f.sectorName} // REMAINING: ${String(f.remaining).padStart(2, '0')}`;
    }
    // 8A-5 district status badge.
    if (this.changed('atag', f.alertTag)) {
      const st = f.alertTag;
      this.alertTagEl.className = st ? `st-${st}` : 'off';
      this.alertTagEl.textContent = st === 'UNAWARE' ? 'STEALTH' : st;
    }
    // 8A-5 awareness arcs: amber = gauge filling, orange / crimson flashing = detected / combat with LOS.
    const flashOn = Math.floor(this.blinkClock * 6) % 2 === 0;
    for (let i = 0; i < HUD_MAX_AWARE; i++) {
      const arc = this.awareArcs[i];
      const vis = i < f.awareCount && (f.awareRank[i] === 1 || flashOn);
      if (this.changed(`awv${i}`, vis)) arc.style.display = vis ? 'block' : 'none';
      if (i >= f.awareCount) continue;
      const a = Math.round(f.awareAngles[i]);
      if (this.changed(`awa${i}`, a)) arc.setAttribute('transform', `rotate(${a})`);
      const rank = f.awareRank[i];
      if (this.changed(`awr${i}`, rank)) arc.setAttribute('class', rank === 3 ? 'aware cbt' : rank === 2 ? 'aware det' : 'aware');
      const g = rank === 1 ? Math.round(clamp(f.awareGauge[i], 0.06, 1) * 50) / 50 : 1;
      if (this.changed(`awg${i}`, g)) arc.style.strokeDasharray = `${(AWARE_LEN * g).toFixed(1)} ${AWARE_LEN.toFixed(1)}`;
    }
    // Boss bar.
    if (this.changed('boss', f.bossVisible)) this.bossEl.classList.toggle('on', f.bossVisible);
    if (f.bossVisible) {
      const hpQ = Math.round((f.bossHp / Math.max(1, f.bossMaxHp)) * 1000) / 10;
      if (this.changed('bhp', hpQ)) this.bossFill.style.width = `${hpQ}%`;
      if (this.changed('bp', f.bossPhase)) this.bossName.classList.toggle('p2', f.bossPhase === 2);
      const wl = Math.round(clamp(f.bossWingL, 0, 1) * 100);
      const wr = Math.round(clamp(f.bossWingR, 0, 1) * 100);
      if (this.changed('bwl', wl)) {
        (this.bossWL.firstElementChild as HTMLElement).style.width = `${wl}%`;
        this.bossWL.classList.toggle('broken', wl === 0);
      }
      if (this.changed('bwr', wr)) {
        (this.bossWR.firstElementChild as HTMLElement).style.width = `${wr}%`;
        this.bossWR.classList.toggle('broken', wr === 0);
      }
      if (this.changed('bdn', f.bossDowned)) this.bossDown.classList.toggle('on', f.bossDowned);
    }
  }

  /**
   * 10A-6: Renders the 136×136 top-left circular pulse-scan mini-radar (+0 WebGL draw calls).
   * Rotates continuously with -player.yaw so "up" is always the player's forward view direction.
   */
  private drawRadar(f: HudFrame): void {
    const ctx = this.radarCtx;
    if (!ctx || this.radar.frozen) return;
    const size = RADAR.SIZE_PX;
    const cx = size * 0.5;
    const cy = size * 0.5;
    const outerR = cx - 6; // 62 px radius inside 136x136 canvas
    ctx.clearRect(0, 0, size, size);

    // 1. Dark translucent circular backdrop
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(5, 7, 14, 0.72)';
    ctx.fill();

    // 2. Rotating compass crosshair ticks (-player.yaw)
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(f.playerYaw);
    ctx.strokeStyle = 'rgba(56, 248, 255, 0.14)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, -outerR);
    ctx.lineTo(0, -outerR + 5);
    ctx.moveTo(0, outerR - 5);
    ctx.lineTo(0, outerR);
    ctx.moveTo(-outerR, 0);
    ctx.lineTo(-outerR + 5, 0);
    ctx.moveTo(outerR - 5, 0);
    ctx.lineTo(outerR, 0);
    ctx.stroke();
    ctx.restore();

    // 3. Concentric range rings (25 m / 50 m / 75 m)
    for (let i = 0; i < RADAR.RINGS_M.length; i++) {
      const rM = RADAR.RINGS_M[i];
      const rPx = (rM / RADAR.RANGE_M) * outerR;
      const isOuter = i === RADAR.RINGS_M.length - 1;
      ctx.beginPath();
      ctx.arc(cx, cy, rPx, 0, Math.PI * 2);
      ctx.strokeStyle = isOuter ? 'rgba(56, 248, 255, 0.58)' : 'rgba(56, 248, 255, 0.16)';
      ctx.lineWidth = isOuter ? 1.5 : 1.0;
      ctx.stroke();
    }

    // 4. Subtle forward FOV cone wedge (pointing UP on the radar)
    const fovHalfRad = 42 * (Math.PI / 180);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, outerR, -Math.PI * 0.5 - fovHalfRad, -Math.PI * 0.5 + fovHalfRad);
    ctx.closePath();
    ctx.fillStyle = 'rgba(56, 248, 255, 0.08)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(56, 248, 255, 0.22)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // 5. Expanding cyan pulse-scan ring (0 -> 75 m over 0.65 s every 3.5 s)
    if (this.radar.sweepRadiusM >= 0) {
      const frac = clamp(this.radar.sweepRadiusM / RADAR.RANGE_M, 0, 1);
      const pulseR = Math.max(1, frac * outerR);
      ctx.beginPath();
      ctx.arc(cx, cy, pulseR, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(56, 248, 255, ${(0.82 * (1 - frac * 0.35)).toFixed(2)})`;
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }

    // 6. State-colored enemy blips + ▲/▼ elevation ticks + outer-rim edge ticks (> 75 m)
    const blips = this.radar.blips;
    for (let i = 0; i < blips.length; i++) {
      const b = blips[i];
      if (!b.active) continue;
      projectRadarBlip(b.x, b.z, f.playerX, f.playerZ, f.playerYaw, outerR - 2, RADAR.RANGE_M, _radarProj);
      const color = RADAR.STATE_HEX[b.state];
      ctx.save();
      ctx.globalAlpha = clamp(b.alpha, RADAR.BLIP_MIN_ALPHA, 1);
      ctx.fillStyle = color;
      ctx.strokeStyle = color;
      const bx = cx + _radarProj.xPx;
      const by = cy + _radarProj.yPx;
      if (_radarProj.outOfRange) {
        // Subtle outer-rim directional tick for enemies beyond 75 m
        const ang = Math.atan2(_radarProj.yPx, _radarProj.xPx);
        ctx.translate(cx + Math.cos(ang) * (outerR - 1.5), cy + Math.sin(ang) * (outerR - 1.5));
        ctx.rotate(ang);
        ctx.beginPath();
        ctx.moveTo(2, 0);
        ctx.lineTo(-3, -2.4);
        ctx.lineTo(-3, 2.4);
        ctx.closePath();
        ctx.fill();
      } else {
        // Blip dot
        ctx.beginPath();
        ctx.arc(bx, by, 3.0, 0, Math.PI * 2);
        ctx.fill();
        // Elevation tick: ▲ above if enemy.y - player.y >= +3.5 m, ▼ below if <= -3.5 m
        const elev = computeRadarElevation(b.y, f.playerY);
        if (elev === 'UP') {
          ctx.beginPath();
          ctx.moveTo(bx, by - 7.2);
          ctx.lineTo(bx - 2.6, by - 4.2);
          ctx.lineTo(bx + 2.6, by - 4.2);
          ctx.closePath();
          ctx.fill();
        } else if (elev === 'DOWN') {
          ctx.beginPath();
          ctx.moveTo(bx, by + 7.2);
          ctx.lineTo(bx - 2.6, by + 4.2);
          ctx.lineTo(bx + 2.6, by + 4.2);
          ctx.closePath();
          ctx.fill();
        }
      }
      ctx.restore();
    }

    // 7. Central player chevron pointing forward (up)
    ctx.fillStyle = '#e8fbff';
    ctx.beginPath();
    ctx.moveTo(cx, cy - 4.5);
    ctx.lineTo(cx + 3.4, cy + 3.5);
    ctx.lineTo(cx, cy + 1.5);
    ctx.lineTo(cx - 3.4, cy + 3.5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

const HIT_CLASS: Readonly<Record<HitMarkerKind, string>> = {
  BODY: 'body',
  HEAD: 'head',
  KILL: 'kill',
  HEAD_KILL: 'headkill',
  SHIELD: 'shield',
  PART: 'part',
  ARMOR: 'armor',
  WING: 'wing',
};
