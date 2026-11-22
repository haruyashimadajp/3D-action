/**
 * STRAND // PROTOCOL — Weapons & grapple launcher (§4, §2.2, §3.2, §3.5).
 * Every value is verbatim from GAME_DESIGN_SPEC.md v1.5 / PHASE8_BRUSHUP_PLAN.md (8A-3 roster).
 */
import { SHAKE, type ShakeDef } from './constants';

export type GunId = 'PISTOL' | 'SNIPER';
export type SlotId = GunId | 'GRAPPLE';

/** 8A-3 slot order used by direct select [1]–[3] and mouse-wheel cycling. */
export const SLOT_ORDER: readonly SlotId[] = ['PISTOL', 'SNIPER', 'GRAPPLE'];

export interface RecoilDef {
  /** Upward kick per shot (deg). */
  readonly verticalDeg: number;
  /** Random horizontal kick ± (deg). */
  readonly horizontalDeg: number;
  /** Recovery speed back to zero (deg/s). */
  readonly recoverDegPerS: number;
  /** Horizontal kick follows a sine sway while firing continuously (unused since 8A; kept for tuning). */
  readonly sineSway: boolean;
}

/** 5A-1 Tactical zoom (ADS, RMB held with a gun in IDLE / FIRING_RECOVERY). */
export interface ZoomDef {
  /** FOV offset at full zoom (deg, negative = narrower). Replaces the −7° bullet-time offset while zoomed. */
  readonly fovOffsetDeg: number;
  /** Zoom blend rate: blend += (target − blend) · min(1, rate · realDt). */
  readonly lerpRate: number;
  /** Look-sensitivity multiplier at full zoom. */
  readonly sensitivity: number;
  /**
   * 8A-3 true optical magnification (0 = use `fovOffsetDeg`). The zoomed FOV is computed from the player's base
   * FOV: 2·atan(tan(base/2) / mag), and sensitivity = steadiness · tan(adsFov/2) / tan(base/2).
   */
  readonly magnification: number;
  /** Extra steadiness factor on top of the tan-FOV sensitivity scaling (magnified optics only). */
  readonly steadiness: number;
  /** Spread while zoomed (deg, full cone) and while zoomed in bullet time. */
  readonly spreadDeg: number;
  readonly spreadBtDeg: number;
  /** Right-hand view-model pivot at full zoom (hip pivot X 0.21, Y −0.20, Z −0.42). */
  readonly vmX: number;
  readonly vmY: number;
  readonly vmZ: number;
  /** Visual recoil (camera kick, shake, view-model kick) multiplier at full zoom. */
  readonly recoilScale: number;
}

export interface GunDef {
  readonly id: GunId;
  readonly slot: 1 | 2 | 3;
  readonly name: string;
  readonly role: string;
  readonly damageBody: number;
  readonly headMultiplier: number;
  readonly rpm: number;
  readonly intervalMs: number;
  readonly magazine: number;
  readonly reloadS: number;
  readonly projectileSpeed: number;
  readonly range: number;
  /** Hip-fire spread (deg, full cone). */
  readonly spreadDeg: number;
  /** Spread while bullet time is active (deg). */
  readonly spreadBtDeg: number;
  readonly pellets: number;
  readonly automatic: boolean;
  /** Damage multiplier against the Aegis energy shield. */
  readonly shieldMultiplier: number;
  /** 8A-5 acoustic radius (m): enemies inside hear the shot and fill their alert gauge. */
  readonly soundRadius: number;
  readonly recoil: RecoilDef;
  readonly shake: ShakeDef;
  /** Weapon energy colour (tracer / muzzle). */
  readonly tracerColor: number;
  readonly zoom: ZoomDef;
}

export const GUNS: Readonly<Record<GunId, GunDef>> = {
  /** 8A-3 suppressed stealth sidearm [1]. */
  PISTOL: {
    id: 'PISTOL', slot: 1, name: 'MK-IV RAIL PISTOL', role: 'SUPPRESSED SIDEARM',
    damageBody: 55, headMultiplier: 2.5, rpm: 200, intervalMs: 300, magazine: 8, reloadS: 1.15,
    projectileSpeed: 260, range: 140, spreadDeg: 0, spreadBtDeg: 0, pellets: 1, automatic: false,
    shieldMultiplier: 1.0, soundRadius: 14.0,
    recoil: { verticalDeg: 2.2, horizontalDeg: 0.25, recoverDegPerS: 14, sineSway: false },
    shake: SHAKE.PISTOL_FIRE,
    tracerColor: 0x38f8ff,
    zoom: { fovOffsetDeg: -14.0, lerpRate: 18.0, sensitivity: 0.55, magnification: 0, steadiness: 1, spreadDeg: 0.0, spreadBtDeg: 0.0, vmX: 0.08, vmY: -0.14, vmZ: -0.36, recoilScale: 0.78 },
  },
  /** 8A-3 single-shot breech-loaded 4x rail sniper [2]. */
  SNIPER: {
    id: 'SNIPER', slot: 2, name: 'K-90 RAIL SNIPER', role: 'SINGLE-SHOT 4X PRECISION',
    damageBody: 120, headMultiplier: 2.5, rpm: 273, intervalMs: 220, magazine: 1, reloadS: 1.35,
    projectileSpeed: 460, range: 280, spreadDeg: 0, spreadBtDeg: 0, pellets: 1, automatic: false,
    shieldMultiplier: 1.6, soundRadius: 58.0,
    recoil: { verticalDeg: 4.8, horizontalDeg: 0.4, recoverDegPerS: 10, sineSway: false },
    shake: SHAKE.SNIPER_FIRE,
    tracerColor: 0x7ffcff,
    zoom: { fovOffsetDeg: 0, lerpRate: 16.0, sensitivity: 0.2, magnification: 4.0, steadiness: 0.8, spreadDeg: 0.0, spreadBtDeg: 0.0, vmX: 0.0, vmY: -0.128, vmZ: -0.34, recoilScale: 0.7 },
  },
};

/** 8A-3 true-magnification ADS FOV (deg) for a base FOV: 2·atan(tan(base/2) / mag) — 84° at 4x → 25.37°. */
export function magnifiedFov(baseFovDeg: number, magnification: number): number {
  const half = baseFovDeg * 0.5 * (Math.PI / 180);
  return 2 * Math.atan(Math.tan(half) / magnification) * (180 / Math.PI);
}

/** 8A-3 ADS look sensitivity at full zoom (magnified optics: steadiness · tan-FOV ratio = 0.8 · 0.25 = 0.20). */
export function adsSensitivity(zoom: ZoomDef, baseFovDeg: number): number {
  if (zoom.magnification <= 0) return zoom.sensitivity;
  const half = baseFovDeg * 0.5 * (Math.PI / 180);
  const ads = magnifiedFov(baseFovDeg, zoom.magnification) * 0.5 * (Math.PI / 180);
  return zoom.steadiness * (Math.tan(ads) / Math.tan(half));
}

/** S-00 Grapple launcher [3] / [Q]. */
export const GRAPPLE = {
  NAME: 'S-00 GRAPPLE LAUNCHER',
  SLOT: 3,
  /** User-tuned: 2.5× the spec value of 52 m (shared with PHYSICS.GRAPPLE_RANGE). */
  RANGE: 130.0,
  /** v1.2 / 5A-4: 180 → 340 m/s for the 130 m range. */
  PROJECTILE_SPEED: 340,
  /** In bullet time the hook still flies at ≥ 0.6× its real-time speed (no 2 s waits on far anchors). */
  BT_MIN_SPEED_FACTOR: 0.6,
  COOLDOWN_S: 0.65,
  /** v1.5 §4: faint launch hiss audible to enemies within 8 m. */
  SOUND_RADIUS: 8.0,
  /** Hooking a humanoid directly: damage, stagger and pull toward the player (Phase 3 combat). */
  ENEMY_DAMAGE: 15,
  ENEMY_STUN_S: 0.4,
  SNAP_ANGLE_DEG: 6.0,
} as const;

export function isGun(slot: SlotId): slot is GunId {
  return slot !== 'GRAPPLE';
}

/** 7A-5 / 8A-3 reload SE cues (pistol magazine; sniper three-beat breech). */
export type ReloadCue = 'MAG_OUT' | 'MAG_IN' | 'SLIDE' | 'BOLT_OPEN' | 'LOAD_ROUND' | 'BOLT_CLOSE';

/** Reload timeline (fractions of the reload). */
export const RELOAD_BEATS = {
  MAG_OUT: 0.14,
  MAG_IN: 0.54,
  /** Magazine seated: the gun takes its upward jolt. */
  SEATED: 0.56,
  SLIDE: 0.72,
  /** 8A-3 sniper breech: bolt back + casing out (0–0.22), round guided in (0.22–0.68), bolt home (0.68–0.88). */
  BOLT_OPEN: 0.1,
  LOAD_ROUND: 0.6,
  BOLT_CLOSE: 0.76,
} as const;

/** Reload cue order and beat positions per gun. */
export const RELOAD_CUES: Readonly<Record<GunId, readonly ReloadCue[]>> = {
  PISTOL: ['MAG_OUT', 'MAG_IN', 'SLIDE'],
  SNIPER: ['BOLT_OPEN', 'LOAD_ROUND', 'BOLT_CLOSE'],
};
