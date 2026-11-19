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
 * DOM is written only when values change (no per-frame layout churn).
 */
import { BULLET_TIME, PLAYER, clamp } from '../config/constants';
import { GUNS, type SlotId, isGun } from '../config/weapons';
import type { GearState } from '../player/EquipmentManager';

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
}

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

    // --- Bullet-time arc (right) ---
    const bt = clamp(f.btGauge / BULLET_TIME.MAX_GAUGE, 0, 1);
    const btQ = Math.round(bt * 200) / 200;
    if (this.changed('bt', btQ)) this.btArc.style.strokeDasharray = `${this.btLen * btQ} ${this.btLen}`;
    const btClass = f.btActive ? 'active' : f.btGauge < BULLET_TIME.MIN_ACTIVATE ? 'low' : 'ready';
    if (this.changed('btc', btClass)) this.btArc.setAttribute('class', `arc ${btClass}`);

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
}
