/**
 * STRAND // PROTOCOL — Enemy archetypes (§5.1 – §5.3).
 *
 * Six archetypes: four humanoids (Enforcer · Aegis Breacher · Veil Sniper · Phantom), one aerial mech
 * (Hunter Drone) and the humanoid exoskeleton boss VALKYRIE-09. Every enemy that fires runs the mandatory
 * three-phase telegraph (ACQUIRING → LOCK_TELEGRAPH → FIRE); the per-archetype ACQUIRING / LOCK times,
 * HP, speeds, damage and projectile speeds below are the spec table values.
 *
 * Values the spec leaves open (aim tracking rates, engagement ranges, burst spacing of the two-round
 * patterns, the boss machine-gun round speed / fan width, missile flight model) are tuned here and marked.
 */
import { COLORS, PLAYER, TELEGRAPH } from './constants';
import { ENDLESS, type EnemyKind } from './skills';

export type { EnemyKind } from './skills';

/** ACQUIRING (tracking) and LOCK_TELEGRAPH (fixed aim, blinking) durations (§5.1). */
export interface TelegraphTiming {
  readonly acquireMs: number;
  readonly lockMs: number;
}

export interface EnemyGunDef {
  readonly telegraph: TelegraphTiming;
  readonly damage: number;
  readonly projectileSpeed: number;
  /** Rounds per trigger pull, fired along the locked line. */
  readonly shots: number;
  /** Spacing between rounds of one pull (ms); 0 = simultaneous. */
  readonly shotIntervalMs: number;
  /** Simultaneous pellets per round (Aegis plasma spread = 3). */
  readonly pellets: number;
  /** Fan spread between pellets (deg). */
  readonly pelletSpreadDeg: number;
  /** Cool-down after a pull before the next ACQUIRING may start (s). */
  readonly cooldownS: number;
  /** Max engagement distance (m) — tuned. */
  readonly range: number;
  /** Aim tracking angular speed during ACQUIRING (deg/s) — tuned; fast swings / wall-runs out-run it. */
  readonly trackDegPerS: number;
  /** Lead the target by its velocity (Hunter Drone predicts swing trajectories). */
  readonly predictive: boolean;
  readonly tracerColor: number;
  readonly tracerWidth: number;
}

export interface EnemyDef {
  readonly kind: EnemyKind;
  readonly name: string;
  readonly hp: number;
  readonly moveSpeed: number;
  readonly gun: EnemyGunDef;
  /** Visor / lens / accent emissive colour. */
  readonly visorColor: number;
  /** Rig scale relative to the 1.92 m humanoid base. */
  readonly scale: number;
}

const NORMAL = PLAYER.DAMAGE_NORMAL;
const SNIPER = PLAYER.DAMAGE_SNIPER;
const MELEE = PLAYER.DAMAGE_MELEE_EXPLOSION;

/** 1. Enforcer — humanoid infantry: moves between cover, 3-round bursts. */
export const ENFORCER = {
  kind: 'ENFORCER',
  name: 'ENFORCER',
  hp: 110,
  moveSpeed: 5.2,
  visorColor: 0xff3b5c,
  scale: 1,
  gun: {
    telegraph: { acquireMs: 550, lockMs: 220 },
    damage: NORMAL,
    projectileSpeed: 85,
    shots: 3,
    shotIntervalMs: 110,
    pellets: 1,
    pelletSpreadDeg: 0,
    cooldownS: 1.6,
    range: 75,
    trackDegPerS: 95,
    predictive: false,
    tracerColor: COLORS.ENEMY_DANGER,
    tracerWidth: 0.045,
  },
} as const satisfies EnemyDef;

/** 2. Aegis Breacher — heavy shield trooper: 130° frontal energy shield, 3-pellet plasma spread. */
export const AEGIS = {
  kind: 'AEGIS',
  name: 'AEGIS BREACHER',
  hp: 220,
  moveSpeed: 3.6,
  visorColor: COLORS.ENEMY_DANGER,
  scale: 1.06,
  gun: {
    telegraph: { acquireMs: 650, lockMs: 260 },
    damage: NORMAL,
    projectileSpeed: 68,
    shots: 1,
    shotIntervalMs: 0,
    pellets: 3,
    pelletSpreadDeg: 4.5,
    cooldownS: 2.2,
    range: 50,
    trackDegPerS: 70,
    predictive: false,
    tracerColor: 0xff7a1a,
    tracerWidth: 0.075,
  },
} as const satisfies EnemyDef;

export const AEGIS_SHIELD = {
  HP: 180,
  /** Frontal coverage (deg). Shots arriving inside this horizontal arc and below the steep-angle limit are blocked. */
  ARC_DEG: 130,
  /** Shots from above steeper than this (deg below horizontal) pass over the shield rim (head from above). */
  OVERHEAD_PASS_DEG: 42,
  COLOR: 0xff8c00,
  STUN_S: 1.5,
  /** Body turn rate while bracing (deg/s): flanking via strand / wall-run beats it. */
  TURN_DEG_PER_S: 80,
} as const;

/** 3. Veil Sniper — rooftop marksman: one-hit-kill rifle, always-visible thin laser, backsteps when approached. */
export const VEIL = {
  kind: 'VEIL',
  name: 'VEIL SNIPER',
  hp: 85,
  moveSpeed: 3.0,
  visorColor: 0xff003c,
  scale: 1,
  gun: {
    telegraph: { acquireMs: 1150, lockMs: 320 },
    damage: SNIPER,
    projectileSpeed: 240,
    shots: 1,
    shotIntervalMs: 0,
    pellets: 1,
    pelletSpreadDeg: 0,
    cooldownS: 2.8,
    range: 175,
    trackDegPerS: 42,
    predictive: false,
    tracerColor: 0xff2050,
    tracerWidth: 0.06,
  },
} as const satisfies EnemyDef;

export const VEIL_BEHAVIOUR = {
  /** Backstep trigger distance (m) — tuned. */
  BACKSTEP_RADIUS: 14,
  /** Sight laser drawn while not telegraphing (thin red). */
  SIGHT_WIDTH: 0.01,
  /** 5A-5: 0.20 → 0.42 so the snipe laser reads clearly at night. */
  SIGHT_OPACITY: 0.42,
} as const;

/** 4. Phantom — high-mobility blink trooper: 10 m blinks at 32 m/s, 2-round pulse gun, dash slash ≤ 4.5 m. */
export const PHANTOM = {
  kind: 'PHANTOM',
  name: 'PHANTOM',
  hp: 150,
  moveSpeed: 8.5,
  visorColor: 0xc800ff,
  scale: 1,
  gun: {
    telegraph: { acquireMs: 400, lockMs: 190 },
    damage: NORMAL,
    projectileSpeed: 95,
    shots: 2,
    shotIntervalMs: 120,
    pellets: 1,
    pelletSpreadDeg: 0,
    cooldownS: 1.5,
    range: 45,
    trackDegPerS: 160,
    predictive: false,
    tracerColor: 0xd04dff,
    tracerWidth: 0.045,
  },
} as const satisfies EnemyDef;

export const PHANTOM_BEHAVIOUR = {
  BLINK_DISTANCE: 10,
  BLINK_SPEED: 32,
  BLINK_COOLDOWN_S: 2.0,
  /** Post-blink landing stiffness — the bullet-time window. */
  BLINK_RECOVERY_S: 0.45,
  /** Afterimage spawn spacing and lifetime (s). */
  GHOST_INTERVAL_S: 0.05,
  GHOST_LIFE_S: 0.35,
  SLASH_RANGE: 4.5,
  /** Blade glow telegraph before the slash (ms). */
  SLASH_GLOW_MS: 350,
  SLASH_DAMAGE: MELEE,
  SLASH_LUNGE_SPEED: 18,
  SLASH_LUNGE_TIME_S: 0.22,
  SLASH_HIT_RADIUS: 2.0,
  SLASH_COOLDOWN_S: 1.2,
  GHOST_COLOR: 0xa020ff,
} as const;

/** 5. Hunter Drone — aerial mech: 6–22 m altitude 3D orbit, leads swing trajectories, 2-round bursts. */
export const DRONE = {
  kind: 'DRONE',
  name: 'HUNTER DRONE',
  hp: 75,
  moveSpeed: 9.5,
  visorColor: 0xff5500,
  scale: 1,
  gun: {
    telegraph: { acquireMs: 500, lockMs: 200 },
    damage: NORMAL,
    projectileSpeed: 80,
    shots: 2,
    shotIntervalMs: 130,
    pellets: 1,
    pelletSpreadDeg: 0,
    cooldownS: 1.8,
    range: 65,
    trackDegPerS: 120,
    predictive: true,
    tracerColor: 0xff6a1a,
    tracerWidth: 0.045,
  },
} as const satisfies EnemyDef;

export const DRONE_BEHAVIOUR = {
  ALT_MIN: 6,
  ALT_MAX: 22,
  ORBIT_RADIUS_MIN: 14,
  ORBIT_RADIUS_MAX: 24,
  ACCEL: 14,
  /** Death: small explosion — 50 damage within 4 m (player and other enemies). */
  EXPLOSION_RADIUS: 4,
  EXPLOSION_DAMAGE: 50,
  /** Lens weak-point radius (head-shot hitbox). */
  LENS_RADIUS: 0.2,
  BODY_HALF: [0.45, 0.2, 0.45] as readonly [number, number, number],
} as const;

/** 6. Sector boss VALKYRIE-09 — humanoid exoskeleton with glowing thruster wings. */
export const VALKYRIE = {
  kind: 'VALKYRIE',
  name: 'VALKYRIE-09',
  hp: 1600,
  moveSpeed: 14.0,
  visorColor: 0xff0055,
  scale: 1.35,
  gun: {
    // Phase-1 sniper pattern (×3 per volley).
    telegraph: { acquireMs: 850, lockMs: 280 },
    damage: SNIPER,
    projectileSpeed: 240,
    shots: 3,
    shotIntervalMs: 0,
    pellets: 1,
    pelletSpreadDeg: 0,
    cooldownS: 1.2,
    range: 170,
    trackDegPerS: 110,
    predictive: false,
    tracerColor: 0xff2a6a,
    tracerWidth: 0.07,
  },
} as const satisfies EnemyDef;

export const VALKYRIE_BEHAVIOUR = {
  WING_HP: 300,
  FLIGHT_SPEED: 28,
  PHASE2_HP_RATIO: 0.5,
  /** A destroyed wing drops the boss for 3.5 s with its head fully exposed. */
  DOWN_S: 3.5,
  RECOVER_S: 1.0,
  INTRO_S: 1.6,
  PHASE_SHIFT_S: 1.2,
  /** Head armour while airborne / not downed: no head-shot bonus (the crest deflects). */
  ARMORED_HEAD_MULTIPLIER: 1.0,
  SNIPE: { telegraph: { acquireMs: 850, lockMs: 280 }, damage: SNIPER, speed: 240, count: 3 },
  /** Aerial machine-gun sweep: 5 fan lines; each line fires a short burst (round speed / fan width tuned). */
  SWEEP: { telegraph: { acquireMs: 600, lockMs: 240 }, damage: NORMAL, speed: 110, lines: 5, fanStepDeg: 7, roundsPerLine: 3, roundIntervalMs: 70 },
  /** Phase 2 high-speed dive slash: ground prediction circle + shockwave. */
  DIVE: { telegraph: { acquireMs: 700, lockMs: 220 }, damage: MELEE, speed: 60, shockRadius: 7, shockDurationS: 0.35, shockHeight: 2.5, groundTimeS: 0.8 },
  /** Phase 2 homing micro-missiles ×4 (can be shot down). Telegraphed with the sweep timing (rule 0-2). */
  MISSILES: { telegraph: { acquireMs: 600, lockMs: 240 }, damage: NORMAL, count: 4, launchIntervalMs: 90, speedStart: 18, speedMax: 30, turnDegPerS: 95, lifeS: 7, fuseRadius: 1.3, blastRadius: 2.6, hitRadius: 0.45 },
  /** Phase 2 summons (HP < 50 %) are taken from the sector definition. */
  WING_COLOR_P1: 0xffffff,
  WING_COLOR_P2: 0xff0055,
  /** Cruise altitude used when a direct flight line between perches is blocked (above the 95 m skyline). */
  CRUISE_Y: 104,
  PERCH_CLEARANCE: 3.5,
} as const;

export const ENEMY_DEFS: Readonly<Record<EnemyKind, EnemyDef>> = {
  ENFORCER,
  AEGIS,
  VEIL,
  PHANTOM,
  DRONE,
  VALKYRIE,
};

/** Shared humanoid hitbox (§5.2): head sphere r 0.24 (visual +15 %), body box 0.62 × 1.35 × 0.42. */
export const HUMANOID = {
  HEIGHT: 1.92,
  HEAD_CENTER_Y: 1.72,
  HEAD_RADIUS: TELEGRAPH.HEAD_HITBOX_RADIUS,
  /** Visible head radius = hitbox / 1.15. */
  HEAD_VISUAL_RADIUS: TELEGRAPH.HEAD_HITBOX_RADIUS / 1.15,
  BODY_HALF: [TELEGRAPH.BODY_HITBOX_WIDTH / 2, TELEGRAPH.BODY_HITBOX_HEIGHT / 2, TELEGRAPH.BODY_HITBOX_DEPTH / 2] as readonly [number, number, number],
  /** Body box centre height: spans 0.13 … 1.48 m, the head sphere covers 1.48 … 1.96 m. */
  BODY_CENTER_Y: 0.13 + TELEGRAPH.BODY_HITBOX_HEIGHT / 2,
  RADIUS: 0.34,
  /** Ground enemies hold their fire for this long after materialising (fairness). */
  SPAWN_GRACE_S: 1.2,
  SPAWN_MATERIALIZE_S: 0.6,
  /** Grapple hook on a humanoid / drone (§4 S-00): stagger. */
  FLINCH_SPRING_K: 160,
  FLINCH_SPRING_D: 14,
  /** Line-of-sight re-check interval (s). */
  LOS_INTERVAL_S: 0.1,
  /** ACQUIRING is abandoned after losing sight for this long (s). */
  LOS_GRACE_S: 0.25,
} as const;

/** Endless loop scaling (§8.1): HP +25 % / loop, lock −8 % / loop (floor 140 ms), count +20 % / loop. */
export function scaledLockMs(baseMs: number, loop: number, extraReduction = 0): number {
  const ms = baseMs * (1 - ENDLESS.LOCK_TIME_REDUCTION_PER_LOOP * loop) * (1 - extraReduction);
  return Math.max(Math.min(ENDLESS.LOCK_TIME_FLOOR_MS, baseMs), ms);
}

// ---------------------------------------------------------------------------
// 8A-5 4-state Stealth / Alert / Detected / Combat AI (§5.1, PHASE8_BRUSHUP_PLAN.md 8A-5-B)
// ---------------------------------------------------------------------------
export type AlertState = 'UNAWARE' | 'ALERT' | 'DETECTED' | 'COMBAT';

export const AI_STEALTH = {
  // Vision cones
  FOV_HALF_DEG: 52,            // Standard humanoids (104° cone)
  FOV_HALF_VEIL_DEG: 38,       // Veil Sniper narrow long-range cone
  VISION_RANGE: 52,            // Standard units
  VISION_RANGE_VEIL: 95,       // Veil Sniper
  VISION_RANGE_DRONE: 40,      // Drone downward 360° scan cone
  // Distance-scaled vision fill rate (pts/sec, gauge 0..100)
  FILL_MIN_PER_S: 18,
  FILL_MAX_PER_S: 115,
  FILL_DIST_EXP: 1.6,
  CROUCH_FILL_MULT: 0.72,
  // Out-of-FOV proximity sensing
  PROX_RADIUS_STAND: 5.5,      // m
  PROX_RADIUS_CROUCH: 3.5,     // m
  PROX_FILL_MIN_PER_S: 38,
  PROX_FILL_MAX_PER_S: 85,
  // Acoustic gunshot sensing (instant gauge impulse)
  GUNSHOT_IMPULSE_MIN: 25,
  GUNSHOT_IMPULSE_MAX: 75,
  // Decay while unseen
  DECAY_HOLD_S: 1.0,
  DECAY_PER_S: 14,
  // Escalation timers
  DETECTED_PROPAGATE_DELAY_S: 1.6,
  DETECTED_PROPAGATE_RADIUS: 22.0,
  DETECTED_TO_COMBAT_S: 3.5,
  COMBAT_GLOBAL_DELAY_S: 2.2,
  // De-escalation (Shared Last Known Position search)
  SEARCH_ARRIVE_DIST: 8.0,
  SEARCH_GIVE_UP_S: 4.5,
  DEESCALATE_ALERT_GAUGE: 65,
  // Suppressive fire when no LOS
  SUPPRESS_SPREAD_DEG: 8.0,
  SUPPRESS_CD_MULT: 1.35,
} as const;

/** 8A-5 values the plan states outside the AI_STEALTH block (patrol / scan / fallback), plus tuned extras. */
export const AI_PATROL = {
  /** Calm patrol speed per archetype (m/s; spec §5.4: Enforcer 2.6, Aegis 2.0, Drone 5.0; others in 2.0–2.6). */
  SPEED: { ENFORCER: 2.6, AEGIS: 2.0, VEIL: 2.0, PHANTOM: 2.4, DRONE: 5.0, VALKYRIE: 0 } as Readonly<Record<EnemyKind, number>>,
  /** Patrol legs: 2–3 connected waypoints, each leg this long (m). */
  LEG_MIN_M: 7,
  LEG_MAX_M: 15,
  /** Pause at each turn, scanning left / right. */
  PAUSE_MIN_S: 1.5,
  PAUSE_MAX_S: 3.0,
  SCAN_DEG: 35,
  /** Rooftop Veil watch arc over the avenue (±deg) and its sweep period (s). */
  VEIL_SCAN_DEG: 40,
  VEIL_SCAN_PERIOD_S: 9,
  /** Drone oval / figure-8 loops. */
  DRONE_ALT_MIN: 8,
  DRONE_ALT_MAX: 18,
  DRONE_LOOP_R_MIN: 9,
  DRONE_LOOP_R_MAX: 16,
  /** 10A-5 ALERT investigation: advance toward investigateGoal at 0.80× combat speed; stop within <= 2.2 m. */
  INVESTIGATE_SPEED_K: 0.8,
  INVESTIGATE_STOP_M: 2.2,
  /** 10A-5 movement-stall timeout safety while walking/flying toward investigateGoal (s). */
  INVESTIGATE_STALL_S: 7.0,
  /** 10A-5 upon arriving within <= 2.2 m (or stall timeout), pause and sweep gaze ±60° for 2.0 s. */
  INVESTIGATE_SWEEP_S: 2.0,
  INVESTIGATE_SWEEP_DEG: 60,
  /** 10A-5 minimum alertGauge floor while investigating en route / sweeping. */
  INVESTIGATE_GAUGE_FLOOR: 25,
  /** 10A-5 drone hover offset above investigatePos (m). */
  INVESTIGATE_DRONE_OFFSET_Y: 3.5,
  /** 10A-5 diegetic enemy tactical flashlight / visor scanner cones (InstancedMesh, cap: 14). */
  SCANNER_CONE_CAP: 14,
  SCANNER_CONE_RADIUS_M: 2.4,
  SCANNER_CONE_LENGTH_GROUND_M: 12.5,
  SCANNER_CONE_LENGTH_DRONE_M: 11.5,
  SCANNER_CONE_OPACITY_UNAWARE: 0.11,
  SCANNER_CONE_OPACITY_ALERT: 0.14,
  /** Body turn rate while patrolling / investigating (deg/s). */
  TURN_DEG_PER_S: 150,
  /** Suppressive fire: max distance to the shared last-known position, pitch scatter (±deg). */
  SUPPRESS_MAX_DIST: 45,
  SUPPRESS_PITCH_DEG: 4.0,
  /** Unreachable last-known position (rooftop): a stalled searcher counts as inspecting after this long. */
  SEARCH_STALL_S: 6.0,
  /** Revert to ALERT: hold before decay starts (s). */
  DEESCALATE_HOLD_S: 2.0,
  /** Visor / rim colour and emissive per state (§6.1). */
  STATE_COLOR: { UNAWARE: 0x2a7a99, ALERT: 0xffcc22, DETECTED: 0xff6a1a, COMBAT: 0xff2244 } as Readonly<Record<AlertState, number>>,
  STATE_EMISSIVE: { UNAWARE: 1.2, ALERT: 2.8, DETECTED: 3.8, COMBAT: 4.2 } as Readonly<Record<AlertState, number>>,
  /** Stealth kill FLOW bonus (killing an UNAWARE / ALERT enemy). */
  STEALTH_KILL_FLOW: 120,
} as const;
