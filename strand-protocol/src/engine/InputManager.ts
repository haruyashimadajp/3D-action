/**
 * STRAND // PROTOCOL — Input (§3.1, §3.6).
 *
 *  - Pointer Lock mouse look with sensitivity 0.2–3.0 (default 1.0); look deltas are applied per rendered
 *    frame in real time (never time-scaled by bullet time or hitstop).
 *  - Held state for continuous actions (WASD, fire, bullet time, slide).
 *  - Buffered presses (150 ms) for jump / fire / grapple: a press is remembered with its timestamp and
 *    consumed by the first simulation step in which the action becomes possible (§3.6-2).
 *  - Discrete actions (slot select, Q toggle, wheel, reload, pause) are queued and drained once per frame —
 *    only while gameplay input is enabled: nothing typed on the title / pause / modal screens is replayed on
 *    the first frame back in play (5A-4).
 *  - Tactical zoom scales the look sensitivity (`lookScale`, 0.72× … 0.88× at full zoom).
 *  - 450 ms click / number-key lock for the skill-choice modal (§3.6-5).
 *  - Ctrl+W safety: a leave-page confirmation while playing, and optional fullscreen + Keyboard Lock so
 *    the browser cannot steal Ctrl / W.
 */
import { INPUT, clamp } from '../config/constants';

/** `BULLET_TIME` is the RMB hold: tactical zoom with a gun, plus air bullet time when airborne (v1.2). */
export type HeldAction = 'FORWARD' | 'BACK' | 'LEFT' | 'RIGHT' | 'JUMP' | 'SLIDE' | 'FIRE' | 'BULLET_TIME';
export type BufferedAction = 'JUMP' | 'FIRE' | 'SLIDE';
export type DiscreteAction =
  | 'SLOT1'
  | 'SLOT2'
  | 'SLOT3'
  | 'SLOT4'
  | 'TOGGLE_GRAPPLE'
  | 'SLOT_NEXT'
  | 'SLOT_PREV'
  | 'RELOAD'
  | 'PAUSE'
  | 'FULLSCREEN';

const KEY_HELD: Readonly<Record<string, HeldAction>> = {
  KeyW: 'FORWARD',
  KeyS: 'BACK',
  KeyA: 'LEFT',
  KeyD: 'RIGHT',
  Space: 'JUMP',
  ControlLeft: 'SLIDE',
  KeyC: 'SLIDE',
};

const KEY_DISCRETE: Readonly<Record<string, DiscreteAction>> = {
  Digit1: 'SLOT1',
  Digit2: 'SLOT2',
  Digit3: 'SLOT3',
  Digit4: 'SLOT4',
  KeyQ: 'TOGGLE_GRAPPLE',
  KeyR: 'RELOAD',
  Escape: 'PAUSE',
  Tab: 'PAUSE',
  KeyF: 'FULLSCREEN',
};

/** Keys whose default browser behaviour must never fire during play. */
const PREVENT = new Set(['Space', 'Tab', 'ControlLeft', 'KeyC', 'KeyQ', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyR', 'KeyF', 'Digit1', 'Digit2', 'Digit3', 'Digit4']);

interface KeyboardLockApi {
  lock(keys?: string[]): Promise<void>;
  unlock(): void;
}

export class InputManager {
  /** Look sensitivity multiplier (0.2–3.0). */
  sensitivity: number = INPUT.SENSITIVITY_DEFAULT;
  /** Input only drives the game while true (title / pause / modal screens set it false). */
  gameplayEnabled = false;
  /** Extra look multiplier (tactical zoom sensitivity, 1 = none). */
  lookScale = 1;

  private readonly held = new Set<HeldAction>();
  /** Physical key codes currently down (for keys sharing one action). */
  private readonly physical = new Set<string>();
  /** Real-time stamp (ms) of the last press of each buffered action, and whether it was consumed. */
  private readonly pressAt = new Map<BufferedAction, number>();
  private readonly consumed = new Set<BufferedAction>();
  /** Simulation step counter at press time: every press is seen by at least one fixed step. */
  private readonly pressStep = new Map<BufferedAction, number>();
  private stepIndex = 0;
  private readonly queue: DiscreteAction[] = [];
  private lookX = 0;
  private lookY = 0;
  private clickLockUntil = 0;
  private clickLockStart = 0;
  private locked = false;
  private guardUnload = false;
  private readonly lockListeners: Array<(locked: boolean) => void> = [];

  constructor(private readonly target: HTMLElement) {
    window.addEventListener('keydown', this.onKeyDown, { capture: true });
    window.addEventListener('keyup', this.onKeyUp, { capture: true });
    target.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('blur', () => this.releaseAll());
    document.addEventListener('pointerlockchange', this.onLockChange);
    window.addEventListener('beforeunload', (e) => {
      // Ctrl+W (slide + forward) would otherwise close the tab mid-run.
      if (this.guardUnload) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Pointer lock / fullscreen
  // ---------------------------------------------------------------------------------------------
  requestPointerLock(): void {
    const el = this.target as HTMLElement & { requestPointerLock(options?: { unadjustedMovement?: boolean }): Promise<void> | void };
    try {
      const r = el.requestPointerLock({ unadjustedMovement: true });
      if (r && typeof (r as Promise<void>).catch === 'function') {
        (r as Promise<void>).catch(() => {
          const r2 = el.requestPointerLock();
          if (r2 && typeof (r2 as Promise<void>).catch === 'function') (r2 as Promise<void>).catch(() => undefined);
        });
      }
    } catch {
      el.requestPointerLock();
    }
  }

  exitPointerLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  get isPointerLocked(): boolean {
    return this.locked;
  }

  onPointerLockChange(cb: (locked: boolean) => void): void {
    this.lockListeners.push(cb);
  }

  /** Fullscreen + Keyboard Lock: Ctrl / W / Tab / Esc can no longer be intercepted by the browser. */
  toggleFullscreen(relock = true): void {
    const kb = (navigator as Navigator & { keyboard?: KeyboardLockApi }).keyboard;
    if (!document.fullscreenElement) {
      document.documentElement
        .requestFullscreen()
        .then(() => kb?.lock(['ControlLeft', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyC', 'Tab', 'Space']).catch(() => undefined))
        .then(() => {
          if (relock) this.requestPointerLock();
        })
        .catch(() => undefined);
    } else {
      kb?.unlock();
      document.exitFullscreen().catch(() => undefined);
    }
  }

  /** While playing, closing the tab asks for confirmation (Ctrl+W safety net). */
  setUnloadGuard(on: boolean): void {
    this.guardUnload = on;
  }

  // ---------------------------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------------------------
  isDown(a: HeldAction): boolean {
    return this.gameplayEnabled && this.held.has(a);
  }

  /** −1 … 1 strafe (A/D) */
  get moveX(): number {
    return (this.isDown('RIGHT') ? 1 : 0) - (this.isDown('LEFT') ? 1 : 0);
  }

  /** −1 … 1 forward (W/S) */
  get moveZ(): number {
    return (this.isDown('FORWARD') ? 1 : 0) - (this.isDown('BACK') ? 1 : 0);
  }

  /**
   * True once if `a` was pressed within the last `windowMs` (default 150 ms input buffer) and has not been
   * consumed yet. The press is consumed on success.
   */
  consumeBuffered(a: BufferedAction, windowMs: number = INPUT.BUFFER_MS): boolean {
    if (!this.hasBuffered(a, windowMs)) return false;
    this.consumed.add(a);
    return true;
  }

  /**
   * Peek without consuming. A press is live for `windowMs` of real time — and, however long a frame took,
   * at least until one simulation step has run after it (no press is ever lost to a slow frame).
   */
  hasBuffered(a: BufferedAction, windowMs: number = INPUT.BUFFER_MS): boolean {
    if (!this.gameplayEnabled || this.consumed.has(a)) return false;
    const t = this.pressAt.get(a);
    if (t === undefined) return false;
    return performance.now() - t <= windowMs || (this.pressStep.get(a) ?? -1) >= this.stepIndex;
  }

  /** Called once after every fixed simulation step. */
  markStep(): void {
    this.stepIndex++;
  }

  /** Drains queued discrete actions into `out` (reused array, no allocation). */
  drainActions(out: DiscreteAction[]): DiscreteAction[] {
    out.length = 0;
    for (const a of this.queue) out.push(a);
    this.queue.length = 0;
    return out;
  }

  /** Discards queued discrete actions and buffered presses (e.g. number keys used to pick a skill card). */
  clearActions(): void {
    this.queue.length = 0;
    this.consumed.add('FIRE');
    this.consumed.add('JUMP');
    this.consumed.add('SLIDE');
  }

  /** Returns accumulated look delta in radians (yaw, pitch) and resets it. */
  consumeLook(out: { yaw: number; pitch: number }): { yaw: number; pitch: number } {
    const k = INPUT.BASE_RAD_PER_PIXEL * clamp(this.sensitivity, INPUT.SENSITIVITY_MIN, INPUT.SENSITIVITY_MAX) * this.lookScale;
    out.yaw = -this.lookX * k;
    out.pitch = -this.lookY * k;
    this.lookX = 0;
    this.lookY = 0;
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // 450 ms click lock (skill modal)
  // ---------------------------------------------------------------------------------------------
  lockClicks(ms: number): void {
    this.clickLockStart = performance.now();
    this.clickLockUntil = this.clickLockStart + ms;
  }

  get clicksLocked(): boolean {
    return performance.now() < this.clickLockUntil;
  }

  /** 0 → 1 progress of the current click lock (1 = unlocked). */
  get clickLockProgress(): number {
    const span = this.clickLockUntil - this.clickLockStart;
    if (span <= 0) return 1;
    return clamp((performance.now() - this.clickLockStart) / span, 0, 1);
  }

  // ---------------------------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------------------------
  private press(a: BufferedAction): void {
    this.pressAt.set(a, performance.now());
    this.pressStep.set(a, this.stepIndex);
    this.consumed.delete(a);
  }

  private releaseAll(): void {
    this.held.clear();
    this.physical.clear();
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    // Typing into a settings field (title / pause menu) must not trigger game bindings.
    if (e.target instanceof HTMLInputElement) return;
    if (this.locked && PREVENT.has(e.code)) e.preventDefault();
    if (e.code === 'Tab') e.preventDefault();
    if (e.repeat) return;
    this.physical.add(e.code);
    const held = KEY_HELD[e.code];
    if (held) {
      this.held.add(held);
      if (held === 'JUMP') this.press('JUMP');
      if (held === 'SLIDE') this.press('SLIDE');
    }
    const d = KEY_DISCRETE[e.code];
    // Title / pause / modal: discrete actions are never queued (no stale SLOT / RELOAD / PAUSE on resume).
    // F still toggles fullscreen there, immediately (the key press is the required user gesture).
    if (d && this.gameplayEnabled) {
      if (d.startsWith('SLOT') && this.clicksLocked) return;
      this.queue.push(d);
    } else if (d === 'FULLSCREEN') {
      this.toggleFullscreen(false);
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.physical.delete(e.code);
    const held = KEY_HELD[e.code];
    if (!held) return;
    // Ctrl and C share SLIDE: keep it held while the other key is still physically down.
    if (held === 'SLIDE' && (this.physical.has('ControlLeft') || this.physical.has('KeyC'))) return;
    this.held.delete(held);
  };

  private readonly onMouseDown = (e: MouseEvent): void => {
    if (this.clicksLocked) return;
    if (e.button === 0) {
      this.held.add('FIRE');
      this.press('FIRE');
    } else if (e.button === 2) {
      this.held.add('BULLET_TIME');
    } else if (e.button === 3 || e.button === 4) {
      // Mouse side button ("Mouse Side 4"): grapple ⇄ last gun toggle.
      e.preventDefault();
      if (this.gameplayEnabled) this.queue.push('TOGGLE_GRAPPLE');
    }
  };

  private readonly onMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) this.held.delete('FIRE');
    else if (e.button === 2) this.held.delete('BULLET_TIME');
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (!this.locked || !this.gameplayEnabled) return;
    // Some browsers emit a large spurious delta right after locking: clamp per event.
    this.lookX += clamp(e.movementX, -300, 300);
    this.lookY += clamp(e.movementY, -300, 300);
  };

  private readonly onWheel = (e: WheelEvent): void => {
    if (!this.locked) return;
    e.preventDefault();
    if (this.clicksLocked || !this.gameplayEnabled || Math.abs(e.deltaY) < 1) return;
    this.queue.push(e.deltaY > 0 ? 'SLOT_NEXT' : 'SLOT_PREV');
  };

  private readonly onLockChange = (): void => {
    this.locked = document.pointerLockElement === this.target;
    if (!this.locked) this.releaseAll();
    for (const cb of this.lockListeners) cb(this.locked);
  };
}
