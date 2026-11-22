/** 8A-3 roster: Pistol + single-shot 4x Sniper + Grapple; true magnification and ADS sensitivity. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GRAPPLE, GUNS, RELOAD_BEATS, RELOAD_CUES, SLOT_ORDER, adsSensitivity, isGun, magnifiedFov } from '../src/config/weapons';
import { AEGIS_SHIELD } from '../src/config/enemies';

const near = (a: number, b: number, eps: number, msg?: string) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} ${a} ≈ ${b} (±${eps})`);

test('only PISTOL [1], SNIPER [2], GRAPPLE [3] exist', () => {
  assert.deepEqual([...SLOT_ORDER], ['PISTOL', 'SNIPER', 'GRAPPLE']);
  assert.deepEqual(Object.keys(GUNS).sort(), ['PISTOL', 'SNIPER']);
  assert.equal(GUNS.PISTOL.slot, 1);
  assert.equal(GUNS.SNIPER.slot, 2);
  assert.equal(GRAPPLE.SLOT, 3);
  assert.ok(isGun('PISTOL') && isGun('SNIPER') && !isGun('GRAPPLE'));
  assert.ok(!('SMG' in GUNS) && !('SHOTGUN' in GUNS));
});

test('MK-IV suppressed pistol stats', () => {
  const p = GUNS.PISTOL;
  assert.equal(p.damageBody, 55);
  assert.equal(p.headMultiplier, 2.5);
  assert.equal(p.intervalMs, 300);
  assert.equal(p.magazine, 8);
  assert.equal(p.reloadS, 1.15);
  assert.equal(p.soundRadius, 14);
  assert.equal(p.recoil.verticalDeg, 2.2);
  assert.equal(p.recoil.horizontalDeg, 0.25);
  assert.equal(p.zoom.fovOffsetDeg, -14);
  assert.equal(p.zoom.recoilScale, 0.78);
  assert.equal(adsSensitivity(p.zoom, 84), 0.55);
});

test('K-90 sniper: single shot, 300 HS, 58 m report, shield multiplier 1.6', () => {
  const s = GUNS.SNIPER;
  assert.equal(s.magazine, 1);
  assert.equal(s.damageBody, 120);
  assert.equal(s.damageBody * s.headMultiplier, 300);
  assert.equal(s.reloadS, 1.35);
  assert.equal(s.intervalMs, 220);
  assert.equal(s.projectileSpeed, 460);
  assert.equal(s.range, 280);
  assert.equal(s.soundRadius, 58);
  assert.equal(s.shieldMultiplier, 1.6);
  assert.ok(s.damageBody * s.shieldMultiplier >= AEGIS_SHIELD.HP, '120 × 1.6 = 192 ≥ 180 breaks a fresh Aegis shield in one hit');
  assert.equal(s.recoil.verticalDeg, 4.8);
  assert.equal(s.zoom.recoilScale, 0.7);
});

test('true 4x magnification from any base FOV: 2·atan(tan(base/2)/4)', () => {
  // The plan's formula evaluates to 25.37° at 84° (its "≈ 24.22°" annotation does not match the formula itself).
  near(magnifiedFov(84, 4), 2 * Math.atan(Math.tan(42 * (Math.PI / 180)) / 4) * (180 / Math.PI), 1e-9, 'formula');
  near(magnifiedFov(84, 4), 25.37, 0.01, 'ADS FOV at 84°');
  for (const base of [75, 84, 90, 100]) {
    const ads = magnifiedFov(base, 4);
    const ratio = Math.tan((base / 2) * (Math.PI / 180)) / Math.tan((ads / 2) * (Math.PI / 180));
    near(ratio, 4, 1e-9, `tan ratio at ${base}°`);
  }
});

test('sniper ADS sensitivity = 0.80 × tan(ads/2)/tan(base/2) = 0.20 at every base FOV', () => {
  for (const base of [75, 84, 92, 100]) near(adsSensitivity(GUNS.SNIPER.zoom, base), 0.2, 1e-9, `base ${base}`);
});

test('reload cues: pistol magazine beats, sniper three-beat breech in order', () => {
  assert.deepEqual([...RELOAD_CUES.PISTOL], ['MAG_OUT', 'MAG_IN', 'SLIDE']);
  assert.deepEqual([...RELOAD_CUES.SNIPER], ['BOLT_OPEN', 'LOAD_ROUND', 'BOLT_CLOSE']);
  assert.ok(RELOAD_BEATS.BOLT_OPEN < 0.22 && RELOAD_BEATS.LOAD_ROUND > 0.22 && RELOAD_BEATS.LOAD_ROUND < 0.68);
  assert.ok(RELOAD_BEATS.BOLT_CLOSE >= 0.68 && RELOAD_BEATS.BOLT_CLOSE <= 0.88);
});
