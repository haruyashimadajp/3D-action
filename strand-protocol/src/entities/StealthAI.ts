/**
 * STRAND // PROTOCOL — 8A-5 4-state Stealth / Alert / Detected / Combat AI core (§5.1).
 *
 * Pure state machine (no three.js, no allocation per step) driven by the EnemyManager, which writes each agent's
 * perception (vision cone, proximity, line of sight to the player, inspection of the shared last-known position)
 * and then calls `stepAgent` for every living agent followed by one `stepGlobal`:
 *
 *   UNAWARE ──(FOV / proximity / gunshot)──▶ ALERT ──(gauge 100)──▶ DETECTED ──(3.5 s or damage)──▶ COMBAT
 *      ▲                                      │  ▲                     │ 1.6 s: allies ≤ 22 m → DETECTED
 *      └──────────(unseen: hold 1 s, −14/s)───┘  └──(shared position inspected, 0 LOS for 4.5 s)─┘
 *   Any damage ⇒ COMBAT. Any COMBAT for 2.2 s ⇒ every living agent COMBAT (global broadcast).
 *
 * `locked` agents (VALKYRIE-09 and its escorts) stay in COMBAT and never de-escalate.
 */
import { AI_STEALTH, type AlertState } from '../config/enemies';

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface StealthAgent {
  alive: boolean;
  /** World position (feet) for the 22 m propagation radius. */
  readonly pos: Vec3Like;
  alertState: AlertState;
  /** 0 … 100. */
  alertGauge: number;
  alertHoldTimer: number;
  detectedTimer: number;
  /** DETECTED / COMBAT: clear line of sight to the player within engagement range (written by the manager). */
  hasPlayerLos: boolean;
  /** Player inside this agent's vision cone + range with clear LOS (written by the manager). */
  seesPlayer: boolean;
  visionDist: number;
  visionRange: number;
  /** Player within the proximity radius with clear LOS, even outside the cone (written by the manager). */
  nearPlayer: boolean;
  proxDist: number;
  proxRadius: number;
  /** DETECTED / COMBAT without LOS: at the shared last-known position confirming the player is gone. */
  inspecting: boolean;
  /** Where the last stimulus came from (gunshot origin, sighting); ALERT agents turn toward and approach it. */
  readonly investigatePos: Vec3Like;
  hasInvestigate: boolean;
  /** Never leaves COMBAT (sector 5 boss and escorts). */
  locked: boolean;
}

export interface StealthEvents {
  /** UNAWARE → ALERT (suspicion hum). */
  onAlert?(a: StealthAgent): void;
  /** Gauge reached 100 or a nearby ally propagated (spotted sting). */
  onDetected?(a: StealthAgent, propagated: boolean): void;
  onCombat?(a: StealthAgent): void;
  /** 2.2 s broadcast: the whole sector is now in COMBAT (radio alarm). */
  onGlobalCombat?(): void;
  /** Search gave up: every engaged agent reverts to ALERT. */
  onDeescalate?(): void;
  /** Agent fell back to UNAWARE (gauge decayed to 0). */
  onCalm?(a: StealthAgent): void;
}

/** Plan formula coefficient: 18 + 95 · (1 − d/R)^1.6 (capped at 115). */
const VISION_FILL_SPAN = 95;

/** Distance-scaled vision fill rate (pt/s): clamp(18 + 95 · (1 − d/R)^1.6, 18, 115). */
export function visionFillRate(d: number, range: number): number {
  const S = AI_STEALTH;
  const k = Math.max(0, 1 - d / Math.max(range, 1e-3));
  return Math.min(S.FILL_MAX_PER_S, Math.max(S.FILL_MIN_PER_S, S.FILL_MIN_PER_S + VISION_FILL_SPAN * Math.pow(k, S.FILL_DIST_EXP)));
}

/** Proximity fill (pt/s): lerp(38, 85, 1 − d/r). */
export function proximityFillRate(d: number, radius: number): number {
  const S = AI_STEALTH;
  const t = Math.min(1, Math.max(0, 1 - d / Math.max(radius, 1e-3)));
  return S.PROX_FILL_MIN_PER_S + (S.PROX_FILL_MAX_PER_S - S.PROX_FILL_MIN_PER_S) * t;
}

/** Instant gunshot impulse (pt) at distance d inside the sound radius: lerp(25, 75, 1 − d/r); 0 outside. */
export function gunshotImpulse(d: number, radius: number): number {
  if (d > radius || radius <= 0) return 0;
  const S = AI_STEALTH;
  const t = 1 - d / radius;
  return S.GUNSHOT_IMPULSE_MIN + (S.GUNSHOT_IMPULSE_MAX - S.GUNSHOT_IMPULSE_MIN) * t;
}

export function isEngaged(s: AlertState): boolean {
  return s === 'DETECTED' || s === 'COMBAT';
}

const RANK: Readonly<Record<AlertState, number>> = { UNAWARE: 0, ALERT: 1, DETECTED: 2, COMBAT: 3 };

export function alertRank(s: AlertState): number {
  return RANK[s];
}

export class StealthDirector {
  readonly sharedLastKnownPos: Vec3Like = { x: 0, y: 0, z: 0 };
  hasSharedLastKnown = false;
  combatBroadcastTimer = 0;
  searchClearTimer = 0;
  /** SK_07 Shadow Step: multiplier on every vision / proximity fill (1 = none, 0.65 / 0.52 / 0.40). */
  fillMultiplier = 1;
  /** Player is crouching / sliding (vision fill × 0.72, proximity radius 3.5 m). */
  playerCrouching = false;
  /** Highest state among living agents after the last `stepGlobal` (HUD tag, BGM). */
  highest: AlertState = 'UNAWARE';
  /** LOS from any engaged agent this step. */
  anyEnemyHasLos = false;

  constructor(readonly events: StealthEvents = {}) {}

  reset(): void {
    this.hasSharedLastKnown = false;
    this.combatBroadcastTimer = 0;
    this.searchClearTimer = 0;
    this.highest = 'UNAWARE';
    this.anyEnemyHasLos = false;
  }

  /** Initial state for a freshly spawned agent. */
  initAgent(a: StealthAgent, state: AlertState = 'UNAWARE', locked = false): void {
    a.alertState = state;
    a.alertGauge = state === 'UNAWARE' ? 0 : state === 'ALERT' ? 1 : 100;
    a.alertHoldTimer = 0;
    a.detectedTimer = 0;
    a.hasPlayerLos = false;
    a.seesPlayer = false;
    a.nearPlayer = false;
    a.inspecting = false;
    a.hasInvestigate = false;
    a.locked = locked;
  }

  private copyTo(out: Vec3Like, p: Vec3Like): void {
    out.x = p.x;
    out.y = p.y;
    out.z = p.z;
  }

  private toAlert(a: StealthAgent): void {
    if (a.alertState !== 'UNAWARE') return;
    a.alertState = 'ALERT';
    this.events.onAlert?.(a);
  }

  /** ALERT (or UNAWARE) → DETECTED. */
  toDetected(a: StealthAgent, player: Vec3Like | null, propagated: boolean): void {
    if (isEngaged(a.alertState)) return;
    a.alertState = 'DETECTED';
    a.alertGauge = 100;
    a.detectedTimer = 0;
    if (player) {
      this.copyTo(this.sharedLastKnownPos, player);
      this.hasSharedLastKnown = true;
    }
    this.events.onDetected?.(a, propagated);
  }

  toCombat(a: StealthAgent): void {
    if (a.alertState === 'COMBAT') return;
    a.alertState = 'COMBAT';
    a.alertGauge = 100;
    this.events.onCombat?.(a);
  }

  /**
   * Per-agent perception integration (UNAWARE / ALERT gauge, DETECTED timers). `player` is the player's
   * position (copied into the shared last-known position on detection).
   */
  stepAgent(a: StealthAgent, dt: number, player: Vec3Like): void {
    if (!a.alive) return;
    if (a.locked) {
      if (a.alertState !== 'COMBAT') this.toCombat(a);
      return;
    }
    const S = AI_STEALTH;
    if (a.alertState === 'UNAWARE' || a.alertState === 'ALERT') {
      if (a.seesPlayer) {
        this.toAlert(a);
        const crouch = this.playerCrouching ? S.CROUCH_FILL_MULT : 1;
        a.alertGauge = Math.min(100, a.alertGauge + visionFillRate(a.visionDist, a.visionRange) * crouch * this.fillMultiplier * dt);
        a.alertHoldTimer = S.DECAY_HOLD_S;
        this.copyTo(a.investigatePos, player);
        a.hasInvestigate = true;
      } else if (a.nearPlayer) {
        this.toAlert(a);
        a.alertGauge = Math.min(100, a.alertGauge + proximityFillRate(a.proxDist, a.proxRadius) * this.fillMultiplier * dt);
        a.alertHoldTimer = S.DECAY_HOLD_S;
        this.copyTo(a.investigatePos, player);
        a.hasInvestigate = true;
      } else if (a.alertState === 'ALERT') {
        a.alertHoldTimer -= dt;
        if (a.alertHoldTimer <= 0) a.alertGauge -= S.DECAY_PER_S * dt;
        if (a.alertGauge <= 0) {
          a.alertGauge = 0;
          a.alertState = 'UNAWARE';
          a.hasInvestigate = false;
          this.events.onCalm?.(a);
        }
      }
      if (a.alertGauge >= 100) this.toDetected(a, player, false);
      return;
    }
    if (a.alertState === 'DETECTED') {
      a.detectedTimer += dt;
      if (a.detectedTimer >= S.DETECTED_TO_COMBAT_S) this.toCombat(a);
    }
  }

  /** Sector-wide rules: local propagation, combat broadcast, shared position, search de-escalation. */
  stepGlobal(agents: readonly StealthAgent[], dt: number, player: Vec3Like): void {
    const S = AI_STEALTH;
    const r2 = S.DETECTED_PROPAGATE_RADIUS * S.DETECTED_PROPAGATE_RADIUS;
    // 1. Local propagation: a DETECTED agent for ≥ 1.6 s pulls every UNAWARE / ALERT ally within 22 m in.
    for (const a of agents) {
      if (!a.alive || a.alertState !== 'DETECTED' || a.detectedTimer < S.DETECTED_PROPAGATE_DELAY_S) continue;
      for (const b of agents) {
        if (b === a || !b.alive || isEngaged(b.alertState)) continue;
        const dx = b.pos.x - a.pos.x;
        const dy = b.pos.y - a.pos.y;
        const dz = b.pos.z - a.pos.z;
        if (dx * dx + dy * dy + dz * dz <= r2) this.toDetected(b, null, true);
      }
    }
    // 2. Global COMBAT broadcast after 2.2 s.
    let anyCombat = false;
    let anyNotCombat = false;
    for (const a of agents) {
      if (!a.alive) continue;
      if (a.alertState === 'COMBAT') anyCombat = true;
      else anyNotCombat = true;
    }
    if (anyCombat && anyNotCombat) {
      this.combatBroadcastTimer += dt;
      if (this.combatBroadcastTimer >= S.COMBAT_GLOBAL_DELAY_S) {
        for (const a of agents) if (a.alive) this.toCombat(a);
        this.combatBroadcastTimer = 0;
        this.events.onGlobalCombat?.();
      }
    } else if (!anyCombat) this.combatBroadcastTimer = 0;

    // 3. Shared last-known position & search de-escalation.
    let anyLos = false;
    let anyInspecting = false;
    let anyEngaged = false;
    let anyUnlockedEngaged = false;
    for (const a of agents) {
      if (!a.alive || !isEngaged(a.alertState)) continue;
      anyEngaged = true;
      if (!a.locked) anyUnlockedEngaged = true;
      if (a.hasPlayerLos) anyLos = true;
      if (a.inspecting) anyInspecting = true;
    }
    this.anyEnemyHasLos = anyLos;
    if (anyLos) {
      this.searchClearTimer = 0;
      this.copyTo(this.sharedLastKnownPos, player);
      this.hasSharedLastKnown = true;
    } else if (anyEngaged && anyUnlockedEngaged && anyInspecting) {
      this.searchClearTimer += dt;
      if (this.searchClearTimer >= S.SEARCH_GIVE_UP_S) this.deescalate(agents);
    }

    let hi = 0;
    for (const a of agents) if (a.alive) hi = Math.max(hi, RANK[a.alertState]);
    this.highest = hi === 3 ? 'COMBAT' : hi === 2 ? 'DETECTED' : hi === 1 ? 'ALERT' : 'UNAWARE';
  }

  /** Every engaged (unlocked) agent reverts to ALERT at gauge 65 and searches around the last-known position. */
  deescalate(agents: readonly StealthAgent[]): void {
    const S = AI_STEALTH;
    for (const a of agents) {
      if (!a.alive || a.locked || !isEngaged(a.alertState)) continue;
      a.alertState = 'ALERT';
      a.alertGauge = S.DEESCALATE_ALERT_GAUGE;
      a.alertHoldTimer = 2.0;
      a.detectedTimer = 0;
      a.inspecting = false;
      if (this.hasSharedLastKnown) {
        this.copyTo(a.investigatePos, this.sharedLastKnownPos);
        a.hasInvestigate = true;
      }
    }
    this.combatBroadcastTimer = 0;
    this.searchClearTimer = 0;
    this.hasSharedLastKnown = false;
    this.events.onDeescalate?.();
  }

  /**
   * Acoustic sensing: every living UNAWARE / ALERT agent within `radius` of `origin` gets lerp(25, 75, 1 − d/r)
   * gauge points, investigates the origin and becomes ALERT (DETECTED at 100). Returns how many heard it.
   */
  hearGunshot(agents: readonly StealthAgent[], origin: Vec3Like, radius: number, player: Vec3Like): number {
    let n = 0;
    for (const a of agents) {
      if (!a.alive || a.locked || isEngaged(a.alertState)) continue;
      const d = Math.hypot(a.pos.x - origin.x, a.pos.y - origin.y, a.pos.z - origin.z);
      const imp = gunshotImpulse(d, radius);
      if (imp <= 0) continue;
      n++;
      this.toAlert(a);
      a.alertGauge = Math.min(100, a.alertGauge + imp);
      a.alertHoldTimer = AI_STEALTH.DECAY_HOLD_S;
      this.copyTo(a.investigatePos, origin);
      a.hasInvestigate = true;
      if (a.alertGauge >= 100) this.toDetected(a, player, false);
    }
    return n;
  }

  /** Any damage from the player: immediate COMBAT and the shared position snaps to the shooter. */
  onDamaged(a: StealthAgent, player: Vec3Like): void {
    if (!a.alive) return;
    if (a.alertState !== 'DETECTED' && a.alertState !== 'COMBAT') a.detectedTimer = 0;
    this.toCombat(a);
    this.copyTo(this.sharedLastKnownPos, player);
    this.hasSharedLastKnown = true;
  }
}
