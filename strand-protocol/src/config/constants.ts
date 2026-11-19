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
  SWAY_MAX: 0.035,
  BOB_AMPLITUDE: 0.012,
  SWAY_LERP: 14.0,
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
  SENSITIVITY_MAX: 3.0,
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
  WALLRUN_MIN_ENTER_SPEED: 7.0,
  WALLRUN_MIN_SPEED: 13.5,
  WALLRUN_GRAVITY: -2.8,
  WALLRUN_ZERO_G_TIME: 0.25,
  WALLRUN_MAX_TIME: 1.8,
  WALLRUN_SAME_WALL_COOLDOWN: 0.45,
  WALLKICK_VERTICAL: 11.2,
  WALLKICK_NORMAL: 9.5,
  WALLKICK_FORWARD: 4.5,

  GRAPPLE_RANGE: 52.0,
  GRAPPLE_PROJECTILE_SPEED: 180,
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
  WALLRUN_PANEL: { roughness: 0.2, metalness: 0.6, emissive: 2.2 },
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
/** Warm : cool window ratio = 3 : 7. */
export const WINDOW_WARM_RATIO = 0.3;
/** Puddle mirror roughness and wet-surface roughness (§6.2-2). */
export const ROOF_PUDDLE_ROUGHNESS = 0.06;
export const ROOF_WET_ROUGHNESS = 0.42;

// ---------------------------------------------------------------------------
// §6.2 Rendering pipeline
// ---------------------------------------------------------------------------
export const RENDER = {
  TONE_MAPPING_EXPOSURE: 1.15,
  MSAA_SAMPLES: 4,
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
  WINDOW_TEX_SIZE: 1024,
  ROOF_TEX_SIZE: 512,
  ROAD_TEX_SIZE: 512,
  /**
   * Window atlas: 8 rows × 4 m. Rows 0–4 (top of canvas) = office floors, repeating every 20 m above 12 m.
   * Rows 5–7 (bottom) = low-rise shop floors (1F–3F, Y 0–12 m) with neon shop frames. 8 bays × 3 m.
   */
  WINDOW_TILE_WIDTH_M: 24,
  WINDOW_FLOOR_HEIGHT_M: 4,
  WINDOW_ROWS: 8,
  WINDOW_OFFICE_ROWS: 5,
  WINDOW_SHOP_ROWS: 3,
  WINDOW_BAYS_PER_TILE: 8,
  ROOF_TILE_M: 14,
  /** City-light reflections (street lamps / bridge neon / highway strips) evaluated in ground, road & water shaders. */
  CITY_LIGHTS_MAX: 24,
  CITY_LIGHT_RANGE_M: 20,
  WALLRUN_CHEVRON_TILE_M: 4,
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
