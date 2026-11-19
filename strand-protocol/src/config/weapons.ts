/**
 * STRAND // PROTOCOL — Weapons & grapple launcher (§4, §2.2, §3.2, §3.5).
 * Every value is verbatim from GAME_DESIGN_SPEC.md v1.1.
 */
import { SHAKE, type ShakeDef } from './constants';

export type GunId = 'PISTOL' | 'SMG' | 'SHOTGUN';
export type SlotId = GunId | 'GRAPPLE';

/** Slot order used by direct select [1]–[4] and mouse-wheel cycling. */
export const SLOT_ORDER: readonly SlotId[] = ['PISTOL', 'SMG', 'SHOTGUN', 'GRAPPLE'];

export interface RecoilDef {
  /** Upward kick per shot (deg). */
  readonly verticalDeg: number;
  /** Random horizontal kick ± (deg). */
  readonly horizontalDeg: number;
  /** Recovery speed back to zero (deg/s). */
  readonly recoverDegPerS: number;
  /** SMG: horizontal kick follows a sine sway while firing continuously. */
  readonly sineSway: boolean;
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
  /** Shotgun recoil jump impulse opposite to the view direction (m/s): airborne / grounded. */
  readonly recoilImpulseAir: number;
  readonly recoilImpulseGround: number;
  readonly recoil: RecoilDef;
  readonly shake: ShakeDef;
  /** Weapon energy colour (tracer / muzzle). */
  readonly tracerColor: number;
}

export const GUNS: Readonly<Record<GunId, GunDef>> = {
  PISTOL: {
    id: 'PISTOL', slot: 1, name: 'MK-IV RAIL PISTOL', role: '主力・精密HS',
    damageBody: 55, headMultiplier: 2.5, rpm: 200, intervalMs: 300, magazine: 8, reloadS: 1.15,
    projectileSpeed: 260, range: 140, spreadDeg: 0, spreadBtDeg: 0, pellets: 1, automatic: false,
    shieldMultiplier: 1.0, recoilImpulseAir: 0, recoilImpulseGround: 0,
    recoil: { verticalDeg: 2.4, horizontalDeg: 0.3, recoverDegPerS: 14, sineSway: false },
    shake: SHAKE.PISTOL_FIRE,
    tracerColor: 0x38f8ff,
  },
  SMG: {
    id: 'SMG', slot: 2, name: 'VX-9 PULSE SMG', role: '牽制・対ドローン・盾削り',
    damageBody: 22, headMultiplier: 2.0, rpm: 840, intervalMs: 71, magazine: 30, reloadS: 1.45,
    projectileSpeed: 190, range: 75, spreadDeg: 1.4, spreadBtDeg: 0.4, pellets: 1, automatic: true,
    shieldMultiplier: 1.5, recoilImpulseAir: 0, recoilImpulseGround: 0,
    recoil: { verticalDeg: 0.65, horizontalDeg: 0.45, recoverDegPerS: 18, sineSway: true },
    shake: SHAKE.SMG_FIRE,
    tracerColor: 0x38f8ff,
  },
  SHOTGUN: {
    id: 'SHOTGUN', slot: 3, name: 'K-12 KINETIC SHOTGUN', role: '至近火力 ＆ 反動ジャンプ',
    damageBody: 16, headMultiplier: 1.75, rpm: 75, intervalMs: 800, magazine: 4, reloadS: 1.75,
    projectileSpeed: 150, range: 28, spreadDeg: 5.2, spreadBtDeg: 5.2, pellets: 9, automatic: false,
    shieldMultiplier: 1.0, recoilImpulseAir: 11.5, recoilImpulseGround: 2.0,
    recoil: { verticalDeg: 5.8, horizontalDeg: 1.2, recoverDegPerS: 11, sineSway: false },
    shake: SHAKE.SHOTGUN_FIRE,
    tracerColor: 0x7ffcff,
  },
};

/** S-00 Grapple launcher [4] / [Q]. */
export const GRAPPLE = {
  NAME: 'S-00 GRAPPLE LAUNCHER',
  SLOT: 4,
  /** User-tuned: 2.5× the spec value of 52 m (shared with PHYSICS.GRAPPLE_RANGE). */
  RANGE: 130.0,
  PROJECTILE_SPEED: 180,
  COOLDOWN_S: 0.65,
  /** Hooking a humanoid directly: damage, stagger and pull toward the player (Phase 3 combat). */
  ENEMY_DAMAGE: 15,
  ENEMY_STUN_S: 0.4,
  SNAP_ANGLE_DEG: 6.0,
} as const;

export function isGun(slot: SlotId): slot is GunId {
  return slot !== 'GRAPPLE';
}
