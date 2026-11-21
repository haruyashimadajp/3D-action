/**
 * STRAND // PROTOCOL — Global constants.
 * Physics, camera, juice, durability, out-of-combat regen, color tokens,
 * render pipeline, multi-layer city geometry and performance limits.
 * Every value is taken verbatim from GAME_DESIGN_SPEC.md (v1.1); section references are noted per block.
 */

// ---------------------------------------------------------------------------
// §1.1 Concept
// ---------------------------------------------------------------------------
export const GAME_TITLE = 'STRAND // PROTOCOL';
export const GAME_SUBTITLE = 'CYBERNETIC KINETIC GUNPLAY';

// ---------------------------------------------------------------------------
// §1.3 Player durability, out-of-combat regen, instant retry
// ---------------------------------------------------------------------------
export const PLAYER = {
  MAX_HP: 100,
  DAMAGE_NORMAL: 55,
  DAMAGE_SNIPER: 100,
  DAMAGE_MELEE_EXPLOSION: 65,
  CRITICAL_HP: 45,
  /** Heartbeat BPM while HP <= CRITICAL_HP. */
  CRITICAL_HEARTBEAT_BPM: 128,
  REGEN_DELAY_MS: 3000,
  REGEN_RATE_HP_PER_S: 18.0,
  /** v1.1: no fall death — the street (Y = 0) exists; the canal is a shallow landing (see LEVEL / PHYSICS). */
  /** Death → automatic retry total (glitch blackout + respawn). */
  DEATH_RETRY_MS: 500,
  DEATH_GLITCH_MS: 250,
  DEATH_RESPAWN_MS: 250,
  /** Manual retry with R while dead. */
  MANUAL_RETRY_MS: 150,
  EYE_HEIGHT: 1.72,
  SLIDE_EYE_HEIGHT: 0.86,
  /** 7A-6 crouch eye height (collider = SLIDE_HEIGHT). */
  CROUCH_EYE_HEIGHT: 1.05,
  /** Player capsule. */
  RADIUS: 0.38,
  HEIGHT: 1.86,
  SLIDE_HEIGHT: 0.98,
} as const;

// ---------------------------------------------------------------------------
// §2.1 Hitstop
// ---------------------------------------------------------------------------
export interface HitstopDef {
  readonly durationMs: number;
  readonly timeScale: number;
}
export const HITSTOP = {
  BODY_HIT: { durationMs: 0, timeScale: 1.0 },
  HEADSHOT_HIT: { durationMs: 22, timeScale: 0.08 },
  BODY_KILL: { durationMs: 30, timeScale: 0.08 },
  HEADSHOT_KILL: { durationMs: 52, timeScale: 0.05 },
  BT_AIR_HEADSHOT_KILL: { durationMs: 65, timeScale: 0.04 },
  SHIELD_OR_BOSS_PART_BREAK: { durationMs: 85, timeScale: 0.03 },
  BOSS_KILL: { durationMs: 240, timeScale: 0.04 },
} as const satisfies Record<string, HitstopDef>;

export const JUICE = {
  HEADSHOT_VISOR_PARTICLES: 12,
  HEADSHOT_KILL_FOV_PULSE_DEG: 2.5,
  BT_HS_KILL_CHROMA_SPIKE: 0.008,
  BT_HS_KILL_CHROMA_DECAY_MS: 140,
  BT_HS_KILL_GAUGE_BONUS: 22,
  BREAK_DEBRIS_COUNT: 32,
  HITMARKER_BODY_MS: 120,
  HITMARKER_HEAD_MS: 180,
} as const;

// ---------------------------------------------------------------------------
// §2.2 Camera shake (trauma)
// ---------------------------------------------------------------------------
export interface ShakeDef {
  readonly trauma: number;
  readonly maxPitchYawDeg: number;
  readonly maxRollDeg: number;
}
export const SHAKE_FREQUENCY_HZ = 28;
export const SHAKE_DECAY_PER_S = 2.2;
export const SHAKE = {
  PISTOL_FIRE: { trauma: 0.18, maxPitchYawDeg: 0.6, maxRollDeg: 0.4 },
  SMG_FIRE: { trauma: 0.06, maxPitchYawDeg: 0.25, maxRollDeg: 0.15 },
  SHOTGUN_FIRE: { trauma: 0.42, maxPitchYawDeg: 1.8, maxRollDeg: 1.2 },
  ANCHOR_IMPACT: { trauma: 0.15, maxPitchYawDeg: 0.5, maxRollDeg: 0.5 },
  HARD_LANDING: { trauma: 0.32, maxPitchYawDeg: 1.4, maxRollDeg: 0.8 },
  GRAZE: { trauma: 0.14, maxPitchYawDeg: 0.4, maxRollDeg: 1.0 },
  PLAYER_HIT: { trauma: 0.68, maxPitchYawDeg: 3.2, maxRollDeg: 4.5 },
  SHIELD_OR_BOSS_PART_BREAK: { trauma: 0.5, maxPitchYawDeg: 2.2, maxRollDeg: 1.8 },
} as const satisfies Record<string, ShakeDef>;
/** Falling speed above which a landing counts as a hard landing (m/s). */
export const HARD_LANDING_SPEED = 14.0;

// ---------------------------------------------------------------------------
// §2.3 Dynamic camera work
// ---------------------------------------------------------------------------
export const CAMERA = {
  BASE_FOV: 84,
  BASE_FOV_LERP: 10.0,
  SPEED_FOV_MIN_SPEED: 9.5,
  SPEED_FOV_MAX_SPEED: 32.0,
  SPEED_FOV_MAX: 110,
  SPEED_FOV_HARD_CAP: 114,
  SPEED_FOV_LERP: 8.0,
  BT_FOV_OFFSET: -7.0,
  BT_FOV_LERP: 14.0,
  WALLRUN_ROLL_DEG: 13.5,
  WALLRUN_ROLL_LERP: 12.0,
  SLIDE_ROLL_DEG: 4.0,
  SLIDE_LERP: 16.0,
  SWING_ROLL_MAX_DEG: 9.0,
  SWING_ROLL_LERP: 6.0,
  LANDING_DIP_MAX: 0.28,
  LANDING_SPRING_K: 180,
  LANDING_SPRING_DAMPING: 18,
  /** 7A-2: tighter, faster weapon sway (0.035 → 0.016 m, lerp 14 → 28 /s); ADS cuts it by 95 %. */
  SWAY_MAX: 0.016,
  BOB_AMPLITUDE: 0.012,
  SWAY_LERP: 28.0,
  /** 7A-2: fraction of sway / bob removed at full zoom. */
  ADS_SWAY_CUT: 0.95,
  NEAR: 0.05,
  FAR: 2600,
  /** Accessibility: FOV base range (§3.6-7). */
  FOV_SETTING_MIN: 75,
  FOV_SETTING_MAX: 100,
  /** First-person view-model pass FOV (§6.2 Pass 2). */
  VIEWMODEL_FOV: 68,
} as const;

// ---------------------------------------------------------------------------
// §2.4 FLOW RANK
// ---------------------------------------------------------------------------
export const FLOW_POINTS = {
  BODY_KILL: 100,
  HEADSHOT_KILL: 220,
  AIR_KILL_BONUS: 80,
  WALLRUN_KILL_BONUS: 100,
  SWING_KILL_BONUS: 120,
  GRAZE: 90,
  SHIELD_BREAK: 150,
  MULTIKILL_WINDOW_MS: 2500,
  MULTIKILL_STEP: 0.25,
  MULTIKILL_MAX: 1.0,
  DECAY_DELAY_MS: 3500,
  HIT_PENALTY_RATIO: 0.4,
  /** A single hit may demote by at most this many ranks. */
  HIT_MAX_DEMOTE: 1,
} as const;

export type FlowRankId = 'D' | 'C' | 'B' | 'A' | 'S' | 'SS' | 'SSS';
export interface FlowRankDef {
  readonly id: FlowRankId;
  readonly minPoints: number;
  readonly decayPerS: number;
  /** Fractional reduction of weapon/grapple switch time. */
  readonly switchReduction: number;
  readonly reloadReduction: number;
  readonly maxSpeedBonus: number;
  readonly btKillRecoveryBonus: number;
  readonly wallKickHeightBonus: number;
  /** Number of unlocked BGM layers (1..5). */
  readonly bgmLayers: number;
  readonly bloomStrength: number;
}
export const FLOW_RANKS: readonly FlowRankDef[] = [
  { id: 'D', minPoints: 0, decayPerS: 15, switchReduction: 0, reloadReduction: 0, maxSpeedBonus: 0, btKillRecoveryBonus: 0, wallKickHeightBonus: 0, bgmLayers: 1, bloomStrength: 0.65 },
  { id: 'C', minPoints: 250, decayPerS: 25, switchReduction: 0.1, reloadReduction: 0, maxSpeedBonus: 0, btKillRecoveryBonus: 0, wallKickHeightBonus: 0, bgmLayers: 2, bloomStrength: 0.65 },
  { id: 'B', minPoints: 600, decayPerS: 40, switchReduction: 0.15, reloadReduction: 0.1, maxSpeedBonus: 0, btKillRecoveryBonus: 0, wallKickHeightBonus: 0, bgmLayers: 3, bloomStrength: 0.65 },
  { id: 'A', minPoints: 1100, decayPerS: 60, switchReduction: 0.2, reloadReduction: 0.15, maxSpeedBonus: 0.08, btKillRecoveryBonus: 0, wallKickHeightBonus: 0, bgmLayers: 4, bloomStrength: 0.65 },
  { id: 'S', minPoints: 1800, decayPerS: 85, switchReduction: 0.25, reloadReduction: 0.2, maxSpeedBonus: 0.08, btKillRecoveryBonus: 0.2, wallKickHeightBonus: 0, bgmLayers: 5, bloomStrength: 0.65 },
  { id: 'SS', minPoints: 2700, decayPerS: 115, switchReduction: 0.3, reloadReduction: 0.25, maxSpeedBonus: 0.14, btKillRecoveryBonus: 0.2, wallKickHeightBonus: 0, bgmLayers: 5, bloomStrength: 0.65 },
  { id: 'SSS', minPoints: 3800, decayPerS: 150, switchReduction: 0.35, reloadReduction: 0.3, maxSpeedBonus: 0.18, btKillRecoveryBonus: 0.2, wallKickHeightBonus: 0.1, bgmLayers: 5, bloomStrength: 0.95 },
];
/** FLOW visual thresholds. */
export const FLOW_VISUALS = {
  /** Rank B: speed lines appear faintly above this speed. */
  SPEEDLINE_RANK_B_SPEED: 18,
  /** Rank A: building neon emissive +25 %. */
  RANK_A_NEON_BOOST: 0.25,
} as const;

// ---------------------------------------------------------------------------
// §3.1 Input
// ---------------------------------------------------------------------------
export const INPUT = {
  SENSITIVITY_MIN: 0.2,
  /** 7A-2: 0.20 … 10.00 in 0.05 steps (default 1.00). */
  SENSITIVITY_MAX: 10.0,
  SENSITIVITY_STEP: 0.05,
  SENSITIVITY_DEFAULT: 1.0,
  /** Radians per pixel at sensitivity 1.0. */
  BASE_RAD_PER_PIXEL: 0.0022,
  BUFFER_MS: 150,
  SKILL_MODAL_LOCK_MS: 450,
} as const;

// ---------------------------------------------------------------------------
// §3.2 / §3.5 Equipment switching
// ---------------------------------------------------------------------------
export const EQUIP = {
  HOLSTER_MS: 110,
  DRAW_MS: 110,
  /** Clicks during the final 40 ms of DRAWING are buffered and fired on completion. */
  DRAW_BUFFER_WINDOW_MS: 40,
} as const;

// ---------------------------------------------------------------------------
// §3.4 Movement physics
// ---------------------------------------------------------------------------
export const FIXED_DT = 1 / 120;
export const MAX_FRAME_DT = 0.05;

export const PHYSICS = {
  GRAVITY: -26.0,
  RUN_SPEED: 10.5,
  GROUND_ACCEL: 75,
  GROUND_FRICTION: 10.0,
  /** Grounded on the canal water surface (Y = -2.4 m): ground speed × 0.55; jump / grapple exit instantly. */
  CANAL_SPEED_MULT: 0.55,
  JUMP_VELOCITY: 10.8,
  AIR_ACCEL: 18.0,
  AIR_STRAFE_SPEED_LIMIT: 11.5,
  SOFT_SPEED_CAP: 34.0,
  SOFT_CAP_DRAG: 1.8,
  /** Rank SSS soft cap (34.0 × 1.18). */
  SOFT_SPEED_CAP_SSS: 40.1,

  SLIDE_MIN_ENTER_SPEED: 7.5,
  SLIDE_EXIT_SPEED: 5.5,
  SLIDE_BOOST: 4.2,
  SLIDE_COOLDOWN: 0.85,
  SLIDE_DECAY: 2.6,
  SLIDE_SLOPE_ACCEL: 9.0,
  SLIDE_JUMP_VERTICAL: 11.4,
  SLIDE_JUMP_HORIZONTAL: 2.5,

  WALLRUN_DETECT_DISTANCE: 0.95,
  /** 6B-2 anywhere parallel wall-run: entry needs ≥ 6.5 m/s ALONG the wall … */
  WALLRUN_MIN_ALONG_SPEED: 6.5,
  /** … a travel direction within ±35° of the wall (|v̂·n| ≤ sin 35°) … */
  WALLRUN_MAX_ENTRY_DEG: 35,
  /** … a view within ±52° of the wall, looking the way of travel … */
  WALLRUN_MAX_VIEW_DEG: 52,
  /** … and ≥ 0.35 m of free fall under the feet (never from walking along a wall). */
  WALLRUN_MIN_GROUND_CLEARANCE: 0.35,
  /** Wall faces: vertical extent ≥ 2.2 m, horizontal width ≥ 2.5 m. */
  WALLRUN_MIN_FACE_HEIGHT: 2.2,
  WALLRUN_MIN_FACE_WIDTH: 2.5,
  /** Seams / window frames / collider joints: a same-normal wall found again within 0.12 s keeps the run. */
  WALLRUN_GAP_GRACE_S: 0.12,
  /** The run ends when obstacles drop the along-wall speed below 5.5 m/s. */
  WALLRUN_END_ALONG_SPEED: 5.5,
  WALLRUN_MIN_SPEED: 13.5,
  WALLRUN_GRAVITY: -2.8,
  WALLRUN_ZERO_G_TIME: 0.25,
  WALLRUN_MAX_TIME: 1.8,
  /** Same collider & same normal (dot > 0.95): no re-attach for 0.5 s; any other wall chains immediately. */
  WALLRUN_SAME_WALL_COOLDOWN: 0.5,
  /** 7A-6 look-led wall-kick: vertical 11.2 + wall normal 7.5 + view-forward 8.8, keeping 85 % of the along-wall speed. */
  WALLKICK_VERTICAL: 11.2,
  WALLKICK_NORMAL: 7.5,
  WALLKICK_FORWARD: 8.8,
  WALLKICK_TANGENT_KEEP: 0.85,
  /**
   * 7A-6 auto-mantle: airborne with W or Space held, a ledge 0.55 … 2.15 m above the feet within 0.55 m ahead
   * (BUILDING / BALCONY / CAR / HIGHWAY / BRIDGE / PROP) and room for the whole body on top ⇒ 0.22 s pull-up,
   * leaving with ≥ 6.5 m/s forward.
   */
  MANTLE_MIN_RISE: 0.55,
  MANTLE_MAX_RISE: 2.15,
  MANTLE_REACH: 0.55,
  MANTLE_DURATION_S: 0.22,
  MANTLE_EXIT_SPEED: 6.5,
  /** 7A-6 crouch: grounded below 7.5 m/s with Ctrl/C held — 0.98 m body, 1.05 m eyes, 5.0 m/s. */
  CROUCH_MAX_ENTER_SPEED: 7.5,
  CROUCH_SPEED: 5.0,

  /** User-tuned: 2.5× the spec value of 52 m. */
  GRAPPLE_RANGE: 130.0,
  GRAPPLE_PROJECTILE_SPEED: 340,
  GRAPPLE_SWING_ASSIST: 5.5,
  GRAPPLE_REEL_ACCEL: 24.0,
  GRAPPLE_REEL_SHORTEN_SPEED: 22.0,
  GRAPPLE_MIN_LENGTH: 3.0,
  GRAPPLE_END_UP_BOOST: 8.0,
  GRAPPLE_COOLDOWN: 0.65,
  GRAPPLE_RELEASE_UP_BOOST: 7.5,
  GRAPPLE_RELEASE_FORWARD_BOOST: 6.0,
  GRAPPLE_SNAP_ANGLE_DEG: 6.0,

  COYOTE_LEDGE_MS: 140,
  COYOTE_WALLRUN_MS: 160,
} as const;

export const BULLET_TIME = {
  MAX_GAUGE: 100.0,
  MIN_ACTIVATE: 12.0,
  TIME_SCALE: 0.25,
  DRAIN_PER_REAL_S: 34.0,
  REGEN_PER_S: 4.5,
  BONUS_HS_KILL: 22,
  BONUS_AIR_KILL: 14,
  BONUS_WALLRUN_KILL: 16,
  BONUS_GRAZE: 12,
} as const;

// ---------------------------------------------------------------------------
// §3.6 Accessibility options
// ---------------------------------------------------------------------------
export const ACCESSIBILITY = {
  SHAKE_SCALE_OPTIONS: [0, 0.5, 1.0] as readonly number[],
  ROLL_SCALE_OPTIONS: [0, 0.5, 1.0] as readonly number[],
  CENTER_DOT_DEFAULT: true,
  CENTER_DOT_SIZE_PX: 2,
  CENTER_DOT_BORDER_PX: 1,
} as const;

// ---------------------------------------------------------------------------
// §5.1 Telegraph lines / GRAZE
// ---------------------------------------------------------------------------
export const TELEGRAPH = {
  ACQ_WIDTH: 0.015,
  ACQ_OPACITY: 0.28,
  ACQ_COLOR: 0xff6b00,
  LOCK_WIDTH_START: 0.045,
  LOCK_WIDTH_END: 0.012,
  LOCK_COLOR: 0xff1e42,
  LOCK_EMISSIVE: 4.0,
  LOCK_BLINK_HZ: 25,
  LOCK_MIN_MS: 180,
  LOCK_MAX_MS: 340,
  GRAZE_MIN_DIST: 0.45,
  GRAZE_MAX_DIST: 1.35,
  HEADSHOT_MULTIPLIER: 2.5,
  HEAD_HITBOX_RADIUS: 0.24,
  BODY_HITBOX_WIDTH: 0.62,
  BODY_HITBOX_HEIGHT: 1.35,
  BODY_HITBOX_DEPTH: 0.42,
  DEBRIS_LIFETIME_S: 3.0,
} as const;

// ---------------------------------------------------------------------------
// §6.1 Color palette & emissive tokens
// ---------------------------------------------------------------------------
export const COLORS = {
  SKY_ZENITH: 0x05070e,
  FOG_ABYSS: 0x0d1628,
  ROOF_WET: 0x12161f,
  BUILDING_GLASS: 0x0c121d,
  WINDOW_WARM: 0xffd28a,
  WINDOW_COOL: 0x5ce1e6,
  WALLRUN_CYAN: 0x00f0ff,
  GRAPPLE_GOLD: 0xffb800,
  PLAYER_STRAND: 0x38f8ff,
  ENEMY_ARMOR: 0x161b26,
  ENEMY_DANGER: 0xff1e42,
  ENEMY_AIM: 0xff7a00,
  SHIELD_AMBER: 0xff9500,
  GATE_JADE: 0x00ff9d,
  CANAL_WATER: 0x06111b,
  HIGHWAY_CONCRETE: 0x1a202c,
  CAR_BODY: 0x171d28,
  CAR_LED_WHITE: 0xf2f8ff,
  CAR_LED_CYAN: 0x38f8ff,
  CAR_LED_REAR: 0xff1a2e,
  CAR_HAZARD: 0xff9a1a,
  HIGHWAY_LIGHT_CYAN: 0x2ee8ff,
  HIGHWAY_LIGHT_AMBER: 0xffa12e,
  BARRIER_RED: 0xff2a3c,
  STREET_LAMP: 0xd8ecff,
  HUMANOID_MATTE: 0x141821,
  BT_TINT: 0x0a2a40,
  CRITICAL_VIGNETTE: 0xcc0022,
  AVIATION_RED: 0xff1a12,
  NEON_MAGENTA: 0xff2bd6,
  NEON_AMBER: 0xffa21f,
  MOON: 0xb8c8ff,
} as const;

export interface PbrToken {
  readonly roughness: number;
  readonly roughnessMax?: number;
  readonly metalness: number;
  readonly emissive: number;
  readonly emissiveMax?: number;
}
export const MATERIALS = {
  /** Wet road & rooftop asphalt: roughness map 0.06 (puddle) … 0.42 (wet). */
  ROOF_WET: { roughness: 0.06, roughnessMax: 0.42, metalness: 0.25, emissive: 0.0 },
  CANAL_WATER: { roughness: 0.04, metalness: 0.85, emissive: 0.0 },
  /** Elevated highway / bridge concrete; underside industrial light strips at emissive 1.6. */
  HIGHWAY_CONCRETE: { roughness: 0.48, metalness: 0.3, emissive: 1.6 },
  /** Parked cyber-car body; LED bands 2.2 … 2.8. */
  CAR_BODY: { roughness: 0.22, metalness: 0.78, emissive: 2.2, emissiveMax: 2.8 },
  BUILDING_GLASS: { roughness: 0.15, metalness: 0.85, emissive: 0.45 },
  /** Cyan / accent light lines (enemy armour seams). */
  ACCENT_LINE: { roughness: 0.2, metalness: 0.6, emissive: 2.2 },
  GRAPPLE_ANCHOR: { roughness: 0.25, metalness: 0.8, emissive: 2.8 },
  PLAYER_STRAND: { roughness: 0, metalness: 0, emissive: 3.2 },
  ENEMY_ARMOR: { roughness: 0.5, metalness: 0.65, emissive: 0.0 },
  HUMANOID_MATTE: { roughness: 0.55, metalness: 0.6, emissive: 0.0 },
  ENEMY_DANGER: { roughness: 0, metalness: 0, emissive: 4.2 },
  ENEMY_AIM: { roughness: 0, metalness: 0, emissive: 1.8 },
  SHIELD_AMBER: { roughness: 0.1, metalness: 0.1, emissive: 2.0 },
  GATE_JADE: { roughness: 0, metalness: 0, emissive: 3.0 },
  HUMANOID_VISOR: { roughness: 0, metalness: 0, emissive: 3.5 },
} as const satisfies Record<string, PbrToken>;

/** Max linear luminance of background architecture (keeps it below the HDR bloom threshold). */
export const BACKGROUND_MAX_LUMINANCE = 0.28;
/** Puddle mirror roughness and wet-surface roughness (§6.2-2). */
export const ROOF_PUDDLE_ROUGHNESS = 0.06;
export const ROOF_WET_ROUGHNESS = 0.42;
/** 7B-1: rain-soaked asphalt (below the 0.40 streak threshold, puddles far lower). */
export const ROAD_WET_ROUGHNESS = 0.32;

// ---------------------------------------------------------------------------
// §6.2 Rendering pipeline
// ---------------------------------------------------------------------------
export const RENDER = {
  /** 7A-4: 1.15 → 1.28 (no crushed blacks; neon contrast kept). */
  TONE_MAPPING_EXPOSURE: 1.28,
  MSAA_SAMPLES: 4,
  /** 7A-2 LOW LATENCY composer MSAA. */
  MSAA_SAMPLES_LOW_LATENCY: 2,
  ENV_CUBE_SIZE: 256,
  /** v1.1: FogExp2(0x0D1628, 0.0036) — the cloud-deck mesh is abolished. */
  FOG_DENSITY: 0.0036,
  BLOOM_THRESHOLD: 0.92,
  BLOOM_STRENGTH: 0.65,
  BLOOM_STRENGTH_SSS: 0.95,
  BLOOM_RADIUS: 0.48,
  CHROMA_BASE: 0.0005,
  CHROMA_HIGH_SPEED_MAX: 0.0025,
  CHROMA_SPIKE: 0.009,
  BT_SATURATION: 0.55,
  SPEEDLINE_MIN_SPEED: 18,
  SPEEDLINE_INNER_RADIUS: 0.62,
  DPR_CAP: 1.5,
  ROOF_TEX_SIZE: 512,
  ROAD_TEX_SIZE: 512,
  ROOF_TILE_M: 14,
  /** City-light reflections (street lamps / bridge neon / highway strips) evaluated in ground, road & water shaders. */
  /** 7B-1: nearest 20 of all registered lights (lamps, neon signs, car head / tail lights, vending fronts). */
  CITY_LIGHTS_MAX: 20,
  /** 7B-1 anisotropic wet streaks: horizontal surfaces (n.y > 0.75) with roughness < 0.40. */
  STREAK_MAX_ROUGHNESS: 0.4,
  STREAK_GAIN: 1.0,
  CITY_LIGHT_RANGE_M: 20,
  /**
   * 7B-2 height fog: a blue-violet / teal street haze (#101E38) thickening exponentially toward Y ≤ 26 m, gone
   * by Y = 50 m; blends in from 25 m to 220 m of view distance, at most 0.38.
   */
  HEIGHT_FOG_COLOR: 0x101e38,
  HEIGHT_FOG_MAX: 0.38,
  HEIGHT_FOG_FULL_Y: 26,
  HEIGHT_FOG_CLEAR_Y: 50,
  HEIGHT_FOG_NEAR_M: 25,
  HEIGHT_FOG_FAR_M: 220,
  /** 7B-2 grading + grain (display-referred, before tone mapping). */
  GRADE_SHADOW_TINT: [-0.008, 0.004, 0.014] as readonly number[],
  GRADE_HIGHLIGHT_TINT: [0.012, 0.004, -0.006] as readonly number[],
  GRADE_S_CURVE: 0.12,
  FILM_GRAIN: 0.016,
  AVIATION_BLINK_HZ: 1.2,
} as const;

export type QualityPreset = 'HIGH' | 'MEDIUM' | 'LOW';
export interface QualityDef {
  readonly dpr: number;
  readonly bloom: boolean;
  readonly litePostFx: boolean;
}
export const QUALITY_PRESETS: Readonly<Record<QualityPreset, QualityDef>> = {
  HIGH: { dpr: 1.5, bloom: true, litePostFx: false },
  MEDIUM: { dpr: 1.0, bloom: true, litePostFx: false },
  LOW: { dpr: 1.0, bloom: false, litePostFx: true },
};

// ---------------------------------------------------------------------------
// §9.2 Performance limits
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Phase 5B — art pass (PHASE5_BRUSHUP_PLAN.md 5B-1 … 5B-5). Draw calls stay ≤ 120.
// ---------------------------------------------------------------------------
/** 5B-1: point / line accents above the 0.92 bloom threshold (window walls stay ≤ 0.28). */
export const NEON_BLOOM = {
  SIGN: 1.38,
  LAMP_HEAD: 1.45,
  LAMP_RING: 1.3,
  HOVER_TRAIL: 1.55,
  AVIATION_PEAK: 1.6,
  UNDERSIDE_STRIP: 1.6,
  /** Soft additive halo around every lamp head: radius 2.2 m, alpha 0.28 · exp(−r² · 3.5). */
  LAMP_HALO_RADIUS_M: 2.2,
  LAMP_HALO_FALLOFF: 3.5,
  LAMP_HALO_OPACITY: 0.28,
} as const;

/** 5B-2: ground AO (0 → 2.6 m) and the low-rise city bounce / high moonlight gradient on tower walls. */
export const CITY_SHADING = {
  AO_HEIGHT_M: 2.6,
  AO_MIN: 0.45,
  BOUNCE_TOP_M: 16,
  BOUNCE_COLOR: 0x5a2a8c,
  BOUNCE_STRENGTH: 0.07,
  MOON_FROM_M: 40,
  MOON_TO_M: 95,
  MOON_COLOR: 0x8fb4e6,
  MOON_STRENGTH: 0.05,
  /** City lights are evaluated on walls only up to this height (they reach ≈ 36 m). */
  WALL_LIGHT_MAX_Y: 40,
} as const;

/** 5B-3: tower silhouettes, canopies, fins, steam. */
export const SILHOUETTE = {
  SETBACK_MIN_ROOF_M: 45,
  SETBACK_CHANCE: 0.6,
  SETBACK_AT_MIN: 0.65,
  SETBACK_AT_MAX: 0.8,
  SETBACK_SCALE_MIN: 0.65,
  SETBACK_SCALE_MAX: 0.78,
  /** Upper tier must start above every sky-bridge / Layer-2 sign (≤ 35 m). */
  SETBACK_MIN_Y: 36,
  SETBACK_MIN_UPPER_M: 9,
  CROWN_MIN_ROOF_M: 50,
  CANOPY_Y: 4.2,
  CANOPY_DEPTH_M: 1.4,
  STEAM_MIN: 40,
  STEAM_MAX: 60,
} as const;

/**
 * 6A-1 facade atlas (2048 × 1024): four archetype columns (A glass curtain wall · B cast-concrete
 * residential · C corrugated-metal industrial · D commercial tenant) × 8 floor rows of 4 m. Rows from the
 * bottom of the texture: 0 ground floor, 1 dark mechanical floor (louvres), 2–7 typical floors.
 * Room lighting is decided per room in the shader with an integer hash that `facadeRoomState()` mirrors
 * exactly on the CPU (stats / verification).
 */
export const FACADE = {
  TEX_W: 2048,
  TEX_H: 1024,
  COLUMNS: 4,
  TILE_W_M: 12,
  FLOOR_H_M: 4,
  ROWS: 8,
  TYPICAL_ROWS: 6,
  /** Floor grid offset: Type B residential has a 6 m podium, so its balcony floors sit at 6, 10, 14 m … */
  FLOOR_BASE_M: [0, 2, 0, 0] as readonly number[],
  /** Rooms per 12 m tile: A 3 m · B 3 m · C 6 m · D 3 m. */
  ROOMS_PER_TILE: [4, 4, 2, 4] as readonly number[],
  /** A mechanical floor every 7–9 floors (6–8 typical floors between), never below floor 3. */
  MACHINE_EVERY_MIN: 7,
  MACHINE_EVERY_SPAN: 3,
  /** Night distribution: dark 65 % · warm bulb 20 % · cool office 13 % · cyber accent 2 %. */
  SHARE_DARK: 0.65,
  SHARE_WARM: 0.2,
  SHARE_COOL: 0.13,
  SHARE_ACCENT: 0.02,
  /** Tenant clustering: floor occupancy tiers (mean lit share = 0.35). */
  FLOOR_TIER_LOW: 0.3,
  FLOOR_TIER_MID: 0.75,
  FLOOR_LIT_LOW: 0.12,
  FLOOR_LIT_MID: 0.35,
  FLOOR_LIT_HIGH: 0.626,
  WARM_A: 0xe2be8e,
  WARM_B: 0xd4a56a,
  COOL_A: 0xc5d7ea,
  COOL_B: 0xdce8f5,
  ACCENT_CYAN: 0x58e8f0,
  ACCENT_MAGENTA: 0xe864b8,
  /** Final linear luminance of a lit room: warm stays dim, offices brighter; all below the bloom threshold. */
  LUM_WARM: [0.085, 0.16] as readonly number[],
  LUM_COOL: [0.13, 0.23] as readonly number[],
  LUM_ACCENT: [0.17, 0.26] as readonly number[],
  /** Interior mapping: room box depth in room units (floor height), parallax drawn up to this distance. */
  INTERIOR_DEPTH: 0.55,
  PARALLAX_MAX_DIST_M: 170,
} as const;

/** 6A-2 archetypes (shares of the playable towers and their height bands). */
export const ARCHETYPE = {
  SHARES: [0.3, 0.25, 0.25, 0.2] as readonly number[],
  MIN_H: [45, 24, 18, 18] as readonly number[],
  MAX_H: [95, 65, 48, 55] as readonly number[],
  /** Type A vertical aluminium mullions (decorative, no collider). */
  MULLION_W: 0.25,
  MULLION_D: 0.35,
  MULLION_SPACING_M: 3,
  /** Type B corner pilasters (protrusion ≤ 0.45 m ⇒ no collider). */
  PILASTER_W: 0.9,
  PILASTER_OUT: 0.4,
  /** Type C wall ducts. */
  DUCT_W: 0.7,
  DUCT_OUT: 0.4,
  /**
   * 7A-3 Type D street base (replaces the recessed glass shopfront): closed roll shutters in the facade atlas,
   * heavy stone pillars (0.7 m wide, 0.36 m out ⇒ no collider) every ~6 m, a projecting sign fascia above the
   * shutters with a warm downlight strip — then the per-floor canopies from the 2nd floor up.
   */
  SHUTTER_PILLAR_M: 0.7,
  SHUTTER_PILLAR_OUT_M: 0.36,
  SHUTTER_PILLAR_SPACING_M: 6,
  SHUTTER_FASCIA_Y: [3.1, 3.72] as readonly number[],
  SHUTTER_FASCIA_OUT_M: 0.22,
  BASE_TOP_M: 4.2,
  FLOOR_CANOPY_DEPTH_M: 0.8,
  FLOOR_CANOPIES_MAX: 4,
} as const;

/** 7B-7 rain micro-splashes and plasma smoke trails. */
export const VFX7 = {
  SPLASHES: 180,
  SPLASH_RADIUS_M: 18,
  SPLASH_LIFE_S: 0.18,
  SPLASH_PERIOD: [0.3, 0.8] as readonly number[],
  SMOKE_TRAILS: 48,
  SMOKE_LIFE_S: 0.38,
  SMOKE_WIDTH: [0.04, 0.14] as readonly number[],
  SMOKE_ALPHA: 0.2,
  /** Pellets of one shotgun blast sharing a step: at most this many trails. */
  SMOKE_PER_SHOT: 3,
} as const;

/** Phase 7B street-life and sky set pieces. */
export const CITY_FX = {
  /** 7B-3 lamp light cones: head (6.2 m) → 0.2 m, radius 0.35 → 2.8 m, additive ≤ 0.11. */
  CONE_TOP_Y: 6.2,
  CONE_HEIGHT: 6.0,
  CONE_R_TOP: 0.35,
  CONE_R_BOTTOM: 2.8,
  CONE_OPACITY: 0.11,
  /** 7B-4 traffic lights: ≤ 32 per sector, green 10 s → yellow 2.5 s → red 12.5 s (cross axis inverted). */
  SIGNALS_MAX: 32,
  SIGNAL_GREEN_S: 10,
  SIGNAL_YELLOW_S: 2.5,
  SIGNAL_RED_S: 12.5,
  SIGNAL_LENS: 1.45,
  SIGNAL_POLE_H: 6.0,
  SIGNAL_ARM: 4.2,
  /** 7B-4 catenary cable bundles across alleys (4–14 m wide), Y 5.5–18 m, sag 0.6–1.4 m, 2–3 cables, 6 segments. */
  CABLE_Y: [5.5, 18] as readonly number[],
  CABLE_SAG: [0.6, 1.4] as readonly number[],
  CABLE_SEGMENTS: 6,
  CABLE_RADIUS: 0.03,
  /** 7B-4 parked-car paints: carbon · gunmetal · navy · weathered pearl · wine · cyber-taxi amber. */
  CAR_PAINTS: [0x141821, 0x252c38, 0x152238, 0x6b7482, 0x3a1620, 0x5c4318] as readonly number[],
  CAR_TAXI: 5,
  /** 7B-4 head / tail light pools on the road: front 4.5 m (white / cyan), rear 2.8 m (red). */
  POOL_FRONT_LEN: 4.5,
  POOL_FRONT_W: 2.6,
  POOL_REAR_LEN: 2.8,
  POOL_REAR_W: 2.2,
  POOL_FRONT_GAIN: 0.42,
  POOL_REAR_GAIN: 0.34,
  /** 7B-5 storm sky: light pollution under the clouds; distant lightning every 18–26 s (double flash). */
  SKY_GLOW_MAGENTA: 0x6b1858,
  SKY_GLOW_CYAN: 0x0f4f6b,
  SKY_GLOW_AMBER: 0x5a3614,
  LIGHTNING_PERIOD_S: 22,
  LIGHTNING_JITTER_S: 2,
  /** 7B-5 two advertising blimps cruising the far sky. */
  BLIMPS: [
    { radius: 262, y: 138, speed: 5.2, phase: 0.4 },
    { radius: 322, y: 158, speed: -4.4, phase: 3.3 },
  ] as ReadonlyArray<{ radius: number; y: number; speed: number; phase: number }>,
  BLIMP_LENGTH: 112,
  BLIMP_RADIUS: 16,
} as const;

/** 6A-3 walkable balconies (Type B). */
export const BALCONY = {
  FIRST_Y: 6,
  DEPTH_M: 1.8,
  WIDTH_MIN_M: 4.5,
  WIDTH_MAX_M: 7.5,
  SLAB_M: 0.26,
  RAIL_H_M: 1.1,
  /** Colliders on every balcony up to this floor height (slab + rails); above it only the slab. */
  COLLIDER_MAX_Y: 36,
  AC_CHANCE: 0.4,
  LAMP_CHANCE: 0.12,
  LAMP_COLOR: 0xffc884,
  LAMP_INTENSITY: 0.85,
  MAX_PER_SECTOR: 240,
} as const;

/** 6A-4 climbable external fire escapes (Type C). */
export const FIRE_ESCAPE = {
  LEVEL_H_M: 4,
  LANDING_DEPTH_M: 1.8,
  LANDING_WIDTH_M: 3.2,
  RAIL_H_M: 1.1,
  RUN_MIN_M: 4.6,
  RUN_MAX_M: 7,
  STEP_RISE_M: 0.2,
  /** Reach the roof on towers up to this height, otherwise stop at 12–24 m. */
  ROOF_ACCESS_MAX_Y: 28,
  CAGE_LIGHT: 0xffa84c,
  CAGE_INTENSITY: 1.15,
  RAMP_THICKNESS_M: 0.25,
} as const;

/** 5B-4: hot impact scorch decals. */
export const SCORCH = {
  POOL: 48,
  COOL_S: 0.85,
  SIZE_M: 0.34,
} as const;

export const LIMITS = {
  DRAW_CALLS_PER_FRAME: 120,
  FAR_BUILDINGS: 100,
  PARKED_CARS: 45,
  HOVER_TRAILS: 40,
  RAIN_DROPS: 1800,
  RAIN_BOX_X: 45,
  RAIN_BOX_Y: 30,
  RAIN_BOX_Z: 45,
  VFX_PARTICLES: 600,
  PROJECTILES: 120,
  TELEGRAPH_LINES: 32,
  SHOCK_RINGS: 24,
  ACTIVE_ENEMIES: 14,
  DYNAMIC_POINT_LIGHTS: 4,
} as const;

// ---------------------------------------------------------------------------
// §1.1 / §6.2-2 / §8.1 Multi-layer cyberpunk district geometry (v1.1)
// ---------------------------------------------------------------------------
export const LEVEL = {
  /** Playable district ≈ 180 m × 180 m centred on the origin. */
  PLAY_AREA_M: 180,
  HALF_EXTENT_M: 90,
  /** Layer 0: wet avenue & alleys. */
  GROUND_Y: 0.0,
  /** Layer 0: canal water surface (shallow landing, no death). */
  CANAL_WATER_Y: -2.4,
  CANAL_WIDTH_MIN_M: 14,
  CANAL_WIDTH_MAX_M: 18,
  /** Visual canal bed below the water surface. */
  CANAL_BED_Y: -3.4,
  /** Canal-side towpath ledge (lets a jump escape the canal in two hops: −2.4 → −1.1 → 0). */
  CANAL_TOWPATH_Y: -1.1,
  CANAL_TOWPATH_WIDTH_M: 1.2,
  CANAL_PROMENADE_M: 3,
  /** Truss bridges: deck surface within Y 0.0 … +0.5 (flat at 0.0 here), truss height above deck. */
  BRIDGE_DECK_Y: 0.0,
  BRIDGE_DECK_THICKNESS_M: 0.6,
  BRIDGE_TRUSS_HEIGHT_M: 6.0,
  /** Layer 1: elevated expressway. */
  HIGHWAY_DECK_Y: 9.5,
  HIGHWAY_MIN_CLEARANCE_M: 7.8,
  /** Underside of the girders (≥ 7.8 m clearance). */
  HIGHWAY_UNDERSIDE_Y: 7.9,
  /** 2 lanes each direction + central median. */
  HIGHWAY_WIDTH_M: 14,
  HIGHWAY_GUARD_HEIGHT_M: 1.1,
  HIGHWAY_GUARD_THICKNESS_M: 0.4,
  HIGHWAY_MEDIAN_HEIGHT_M: 0.8,
  HIGHWAY_PIER_SPACING_MIN_M: 24,
  HIGHWAY_PIER_SPACING_MAX_M: 28,
  HIGHWAY_ANCHOR_SPACING_M: 24,
  RAMP_WIDTH_M: 7,
  RAMP_MAX_LENGTH_M: 38,
  RAMP_MIN_LENGTH_M: 26,
  /** Layer 2: mid-level sky-bridges & projecting neon signs. */
  SKYBRIDGE_Y_MIN: 18,
  SKYBRIDGE_Y_MAX: 35,
  /** Layer 3: high rooftops (sniper nests). */
  ROOF_LAYER_Y_MIN: 30,
  ROOF_LAYER_Y_MAX: 95,
  BUILDING_HEIGHT_MIN_M: 16,
  BUILDING_HEIGHT_MAX_M: 95,
  BUILDINGS_MIN: 14,
  BUILDINGS_MAX: 22,
  /** Street cross-sections. */
  AVENUE_WIDTH_M: 14,
  AVENUE_SIDEWALK_M: 4,
  STREET_WIDTH_M: 10,
  STREET_SIDEWALK_M: 3.5,
  ALLEY_WIDTH_M: 6,
  /** Parked cyber-cars. */
  PARKED_CARS_MIN: 25,
  PARKED_CARS_MAX: 45,
  CAR_SIZE_X_M: 2.0,
  CAR_SIZE_Y_M: 1.35,
  CAR_SIZE_Z_M: 4.4,
  /** City-lockdown barrier height (above the tallest tower so it cannot be grappled over). */
  BOUNDARY_HEIGHT_M: 110,
  /** Far-field ring of supertall towers + hover-car trails. */
  FAR_RING_INNER_M: 160,
  FAR_RING_OUTER_M: 650,
  FAR_BUILDINGS_MIN: 80,
  /** Streets / highways / canals are drawn past the barrier up to this distance for continuity. */
  VISUAL_EXTENT_M: 175,
  /** Ground plane drawn out to this radius under the far ring. */
  OUTER_GROUND_M: 720,
} as const;

// ---------------------------------------------------------------------------
// §7 Sound (100 % procedural Web Audio DSP)
// ---------------------------------------------------------------------------
export const AUDIO = {
  // §7.1 master routing
  /** Bullet-time dynamic lowpass: 22 kHz → 680 Hz (Q 2.4) in 120 ms, back in 180 ms (SE + BGM buses). */
  BT_LOWPASS_OPEN_HZ: 22000,
  BT_LOWPASS_CLOSED_HZ: 680,
  BT_LOWPASS_Q: 2.4,
  BT_LOWPASS_IN_MS: 120,
  BT_LOWPASS_OUT_MS: 180,
  /** City reverb impulse response: stereo exponentially decaying white noise. */
  REVERB_LENGTH_S: 1.8,
  REVERB_DECAY: 3.2,
  REVERB_ROLLOFF_HZ: 4500,
  REVERB_SEND: 0.28,
  /** Rain ambience: pink noise → bandpass 1200 Hz (Q 0.6) + high-shelf 6 kHz +4 dB at 0.09. */
  RAIN_BANDPASS_HZ: 1200,
  RAIN_BANDPASS_Q: 0.6,
  RAIN_SHELF_HZ: 6000,
  RAIN_SHELF_DB: 4,
  RAIN_GAIN: 0.09,
  MASTER_GAIN: 0.8,
  /**
   * 5A-6 voice caps, counted separately: BGM voices can never starve combat SE. Player shots, lock warnings,
   * hits / grazes / head-shots are priority voices that bypass the SE cap entirely.
   */
  MAX_BGM_VOICES: 24,
  MAX_SE_VOICES: 28,
  MAX_LOCK_VOICES: 10,
  /** 5A-2 world bus (rain, wind, BGM, combat SE, reverb): pause ramp 60 ms down / 80 ms up. */
  WORLD_PAUSE_MS: 60,
  WORLD_RESUME_MS: 80,

  // §7.2 SE parameters
  PISTOL_TRANSIENT: { f0: 1400, f1: 120, ms: 35 },
  PISTOL_BODY: { f0: 180, f1: 42, ms: 110 },
  PISTOL_TAIL: { f0: 3200, f1: 900, ms: 180 },
  /** Last two rounds: metallic click (sine 2600 Hz, 25 ms). */
  PISTOL_LOW_AMMO_CLICK: { hz: 2600, ms: 25, rounds: 2 },
  /** 5A-6: SMG ≤ 5 rounds left and the shotgun's last shell add the same metallic dry click. */
  SMG_LOW_AMMO_ROUNDS: 5,
  /** 5A-6 Aegis shield / boss armour deflect: FM 2400 Hz carrier × 3700 Hz modulator, 85 ms + energy ring. */
  HIT_SHIELD: { carrierHz: 2400, modHz: 3700, ms: 85, ringHz: 620, ringMs: 160 },
  /** 5A-6 wall-run magnetic boot taps every 0.22 s: bandpass 1800 Hz noise 25 ms + triangle 320 → 160 Hz 30 ms. */
  WALLRUN_STEP: { intervalS: 0.22, noiseHz: 1800, noiseMs: 25, f0: 320, f1: 160, ms: 30 },
  /** 5A-6 winch motor while reeling (GRAPPLE_PULL): saw 140 → 360 Hz with speed, bandpass 900 Hz, gain 0.06. */
  WINCH: { f0: 140, f1: 360, maxSpeed: 32, bandpassHz: 900, gain: 0.06 },
  /** 5A-1 optical servo: zoom in sine 1400 → 2100 Hz 45 ms (0.05), out 1800 → 1100 Hz 40 ms (0.04), UI bus. */
  ZOOM_IN: { f0: 1400, f1: 2100, ms: 45, gain: 0.05 },
  ZOOM_OUT: { f0: 1800, f1: 1100, ms: 40, gain: 0.04 },
  SMG_ATTACK: { f0: 620, f1: 140, ms: 28 },
  SMG_SNAP: { hz: 2800, ms: 40 },
  SMG_PITCH_JITTER: 0.03,
  SHOTGUN_SUB: { f0: 135, f1: 28, ms: 260 },
  SHOTGUN_BLAST: { hz: 900, ms: 220, shaperK: 40 },
  SHOTGUN_PUMP: { delayMs: 280, hzA: 1800, hzB: 2200, ms: 45 },
  /** Air recoil jump: sub +3 dB. */
  SHOTGUN_AIR_SUB_DB: 3,
  HEADSHOT_GLASS: { hz: 5500, ms: 90 },
  HEADSHOT_CHORD: { attackMs: 2, decayMs: 240 },
  /** Consecutive head-shots within 5 s climb this pentatonic ladder (C6 D6 E6 G6 A6 C7 D7 E7). */
  HEADSHOT_LADDER_HZ: [1046.5, 1174.66, 1318.51, 1567.98, 1760.0, 2093.0, 2349.32, 2637.02] as readonly number[],
  HEADSHOT_CHAIN_S: 5,
  SWITCH_HOLSTER: { hz: 800, ms: 45 },
  SWITCH_CLICK: { delayMs: 90, f0: 1600, f1: 2400, ms: 30 },
  SWITCH_REEL_FM_HZ: 3100,
  STRAND_FIRE_AIR: { f0: 2200, f1: 600, ms: 120 },
  STRAND_FIRE_PAYOUT: { f0: 900, f1: 1800 },
  STRAND_ANCHOR: { squareHz: 420, fmHz: 1950, ms: 140 },
  /** Swing wind: bandpass 400 → 1600 Hz, gain rises linearly with speed. */
  SWING_WIND: { f0: 400, f1: 1600, maxSpeed: 34, maxGain: 0.16 },
  LOCK_TONE: { f0: 980, f1: 1960, tremoloHz: 25 },
  LOCK_TONE_SNIPER: { f0: 1400, f1: 2800 },
  GRAZE_WHOOSH: { f0: 2400, f1: 450, ms: 160 },
  GRAZE_BELL: { hz: 1760, ms: 120 },
  /** Consecutive grazes inside this window raise the bell by a semitone each (cap one octave). */
  GRAZE_CHAIN_S: 3,
  GRAZE_CHAIN_MAX_SEMITONES: 12,
  BT_ENTER: { f0: 160, f1: 32, ms: 280 },
  BT_EXIT: { f0: 45, f1: 220, ms: 200 },
  DAMAGE_PUNCH: { f0: 90, f1: 25, ms: 260 },
  DAMAGE_TINNITUS: { hz: 4200, gain: 0.06, decayS: 1.2 },
  HEARTBEAT: { lowpassHz: 60, bpm: PLAYER.CRITICAL_HEARTBEAT_BPM, dubDelayS: 0.15 },
  /** Out-of-combat regen start: clear F#4 + C#5 sine chord, 350 ms. */
  REGEN_CHORD_HZ: [369.99, 554.37] as readonly number[],
  REGEN_CHORD_MS: 350,

  // §7.3 adaptive 5-layer BGM
  BPM: 136,
  /** 16th note = 60 / 136 / 4 = 110.29 ms. */
  SIXTEENTH_S: 60 / 136 / 4,
  SCHEDULER_INTERVAL_MS: 25,
  SCHEDULER_LOOKAHEAD_S: 0.1,
  /** Layer 1 bass roots per bar: D2 / F2 / G2 / A#1. */
  BASS_ROOTS_HZ: [73.42, 87.31, 98.0, 58.27] as readonly number[],
  BASS_LOWPASS_HZ: 380,
  KICK: { f0: 130, f1: 42 },
  SNARE_BODY_HZ: 210,
  /** D minor pentatonic (D F G A C), octave 4–5. */
  ARP_SCALE_HZ: [293.66, 349.23, 392.0, 440.0, 523.25, 587.33, 698.46, 783.99, 880.0, 1046.5] as readonly number[],
  /** Arp delay = 3/16 note, feedback 0.35. */
  ARP_DELAY_SIXTEENTHS: 3,
  ARP_DELAY_FEEDBACK: 0.35,
  HAT_HIGHPASS_HZ: 8000,
  /** Layers 2–5 fade out over 800 ms when out of combat (sector clear / regenerating). */
  CALM_FADE_MS: 800,
  LAYER_FADE_S: 0.6,
  BGM_GAIN: 0.42,
} as const;

/** localStorage key (§8.3). */
export const SAVE_KEY = 'strand_protocol_save_v1';

// ---------------------------------------------------------------------------
// Small helpers shared across modules (allocation-free).
// ---------------------------------------------------------------------------
export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

/** Frame-rate independent exponential lerp factor for `rate * dt` style interpolation. */
export function lerpFactor(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt);
}

/** Linear luminance of an sRGB hex color (after sRGB → linear decode). */
export function hexLinearLuminance(hex: number): number {
  const r = srgbToLinear(((hex >> 16) & 255) / 255);
  const g = srgbToLinear(((hex >> 8) & 255) / 255);
  const b = srgbToLinear((hex & 255) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Deterministic seeded PRNG (mulberry32). Same seed → same sector layout on every retry. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
