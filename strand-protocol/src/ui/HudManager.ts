/**
 * STRAND // PROTOCOL — HUD (§6.3, §3.6-3, §3.6-7).
 *
 * Minimal, high-visibility cyber HUD (≤ 8 % of the screen); critical gauges sit around the crosshair:
 *  - Centre anchor dot (2 px white + 1 px black border, accessibility toggle) + weapon reticle
 *    (pistol precise cross · SMG four brackets · shotgun arcs · grapple chain-hook)
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
 * DOM is written only when values change (no per-frame layout churn).
 */
import { BULLET_TIME, FLOW_RANKS, JUICE, PLAYER, SAVE_KEY, TELEGRAPH, clamp } from '../config/constants';
import {
  ENERGY_COLORS,
  MODIFIERS,
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
import type { HitMarkerKind } from '../entities/EnemyManager';

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
}

export const HUD_MAX_WARNINGS = 8;
export const HUD_MAX_TRACKS = 6;
/** BT arc "refused" blink (ms) and armour alert (ms), 5A-1 / 5A-5. */
const BT_DENIED_S = 0.35;
const ALERT_S = 1.2;

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
  private hitT = 0;
  private hitKind: HitMarkerKind = 'BODY';
  private readonly evadeEl = el('evade');
  private readonly warns: SVGPathElement[] = [];
  private readonly dmgArcs: SVGPathElement[] = [];
  private readonly dmgT = new Float32Array(DAMAGE_ARCS);
  private readonly dmgAngle = new Float32Array(DAMAGE_ARCS);
  private dmgNext = 0;
  private readonly sectorEl = el('sector-hud');
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

  constructor() {
    this.reticles = {
      PISTOL: el<SVGElement>('ret-pistol'),
      SMG: el<SVGElement>('ret-smg'),
      SHOTGUN: el<SVGElement>('ret-shotgun'),
      GRAPPLE: el<SVGElement>('ret-grapple'),
    };
    this.dockItems = {
      PISTOL: el('dock-PISTOL'),
      SMG: el('dock-SMG'),
      SHOTGUN: el('dock-SHOTGUN'),
      GRAPPLE: el('dock-GRAPPLE'),
    };
    this.btLen = this.btArc.getTotalLength();
    this.swLen = this.swArc.getTotalLength();
    this.btTrack.style.strokeDasharray = `${this.btLen} ${this.btLen}`;
    for (let i = 0; i < HUD_MAX_WARNINGS; i++) this.warns.push(el<SVGPathElement>(`warn-${i}`));
    for (let i = 0; i < DAMAGE_ARCS; i++) this.dmgArcs.push(el<SVGPathElement>(`dmg-${i}`));
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

  showPanels(settings: boolean, protocol: boolean): void {
    el('settings').classList.toggle('hidden', !settings);
    el('protocol').classList.toggle('hidden', !protocol);
  }

  // =============================================================================================
  // Settings & accessibility (§3.1 sensitivity, §3.6-7, §9.2 quality)
  // =============================================================================================
  /** Initialises every control from `s`; `onChange(key)` runs after `s` was updated by the user. */
  bindSettings(s: SaveSettings, onChange: (key: keyof SaveSettings) => void): void {
    const range = el<HTMLElement>('sens-range') as unknown as HTMLInputElement;
    const num = el<HTMLElement>('sens-num') as unknown as HTMLInputElement;
    const setSens = (v: number, fromNum: boolean): void => {
      const value = Math.round(clamp(Number.isFinite(v) ? v : 1, 0.2, 3) * 100) / 100;
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
    seg('set-quality', s.quality, (v) => {
      s.quality = v === 'LOW' ? 'LOW' : v === 'MEDIUM' ? 'MEDIUM' : 'HIGH';
      onChange('quality');
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

  private changed(key: string, v: string | number | boolean): boolean {
    if (this.last.get(key) === v) return false;
    this.last.set(key, v);
    return true;
  }

  update(f: HudFrame): void {
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
      const ret = this.reticles[f.slot];
      ret.setAttribute('transform', `scale(${(1 - 0.12 * zq).toFixed(3)})`);
    }
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
      this.sectorEl.textContent = f.gateOpen ? 'GATE OPEN — ADVANCE TO NEXT DISTRICT' : `${f.sectorName} // REMAINING: ${String(f.remaining).padStart(2, '0')}`;
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
