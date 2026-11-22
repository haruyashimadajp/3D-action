/** 8A-3 single-shot sniper reload FSM, switch cancel / resume, 4x zoom, SK_03 / SK_09 refills (EquipmentManager). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { EquipmentManager } from '../src/player/EquipmentManager';
import { GUNS, magnifiedFov } from '../src/config/weapons';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

function makeRig() {
  const buffered = new Set<string>();
  const held = new Set<string>();
  const actions: string[] = [];
  const input: Any = {
    lookScale: 1,
    drainActions(out: string[]) { out.length = 0; out.push(...actions); actions.length = 0; },
    isDown: (a: string) => held.has(a),
    consumeBuffered: (a: string) => buffered.delete(a),
    hasBuffered: (a: string) => buffered.has(a),
  };
  const player: Any = {
    isAlive: true, isGrounded: true, ropeAttached: false, btActive: false, state: 'IDLE', speed: 0, isSliding: false,
    ropeAnchor: new THREE.Vector3(), ropeLength: 0, ropeTension: 0, zoomFovDeg: 0, zoomAbsFov: 0, zoomAbsBlend: 0, gunZoom: false,
    settings: { baseFov: 84 },
    eyePosition: (o: THREE.Vector3) => o.set(0, 1.7, 0),
    aimDirection: (o: THREE.Vector3) => o.set(0, 0, -1),
    viewDirection: (o: THREE.Vector3) => o.set(0, 0, -1),
    addRecoil() {}, addTrauma() {}, notifyFired() {}, addImpulse() {}, detachRope() {},
  };
  const shots: number[] = [];
  const effects: Any = { spawnProjectile: (_o: unknown, _d: unknown, spec: { tag: number }) => shots.push(spec.tag), burst() {} };
  const renderer: Any = { flashLight() {} };
  const viewModel: Any = { muzzleWorld: (_g: unknown, _c: unknown, o: THREE.Vector3) => o.set(0, 1.6, -0.5), onFire() {}, winchWorld: (_c: unknown, o: THREE.Vector3) => o.set(0, 0, 0), update() {} };
  const physics: Any = { findSnapAnchor: (_a: unknown, _b: unknown, _c: unknown, _d: unknown, out: { anchor: unknown }) => { out.anchor = null; } };
  const cues: string[] = [];
  const gunshots: number[] = [];
  const eq = new EquipmentManager(input, player, physics, effects, renderer, viewModel, new THREE.Scene(), {
    onReloadCue: (_g, c) => cues.push(c),
    onGunshot: (_o, r) => gunshots.push(r),
  });
  const cam = new THREE.PerspectiveCamera();
  const step = (seconds: number) => {
    const n = Math.round(seconds / (1 / 120));
    for (let i = 0; i < n; i++) {
      eq.handleActions();
      eq.fixedUpdate(1 / 120, cam, 1);
    }
  };
  return { eq, input, player, buffered, held, actions, shots, cues, gunshots, step, cam };
}

function equipSniper(r: ReturnType<typeof makeRig>) {
  r.actions.push('SLOT2');
  r.step(0.3);
  assert.equal(r.eq.activeSlot, 'SNIPER');
  assert.equal(r.eq.state, 'IDLE');
}

test('slot keys: [1] pistol, [2] sniper, [3] grapple, Q toggles grapple ⇄ last gun, wheel cycles 1→2→3', () => {
  const r = makeRig();
  r.actions.push('SLOT2');
  r.step(0.3);
  assert.equal(r.eq.activeSlot, 'SNIPER');
  r.actions.push('SLOT3');
  r.step(0.3);
  assert.equal(r.eq.activeSlot, 'GRAPPLE');
  r.actions.push('TOGGLE_GRAPPLE');
  r.step(0.3);
  assert.equal(r.eq.activeSlot, 'SNIPER');
  r.actions.push('SLOT1');
  r.step(0.3);
  for (const want of ['SNIPER', 'GRAPPLE', 'PISTOL']) {
    r.actions.push('SLOT_NEXT');
    r.step(0.3);
    assert.equal(r.eq.activeSlot, want);
  }
});

test('sniper: one shot (58 m report) → automatic two-hand breech reload (1.35 s) with BOLT_OPEN / LOAD_ROUND / BOLT_CLOSE', () => {
  const r = makeRig();
  equipSniper(r);
  r.buffered.add('FIRE');
  r.step(1 / 120);
  assert.equal(r.eq.ammo.SNIPER, 0);
  assert.deepEqual(r.shots, [1]);
  assert.deepEqual(r.gunshots, [58]);
  assert.equal(r.eq.state, 'FIRING_RECOVERY');
  r.step(0.23);
  assert.equal(r.eq.state, 'RELOADING', 'auto reload right after the 0.22 s recoil beat');
  r.buffered.add('FIRE');
  r.step(0.5);
  assert.equal(r.shots.length, 1, 'cannot fire while the breech is open');
  r.buffered.delete('FIRE'); // the real input buffer expires after 150 ms
  r.step(0.9);
  assert.equal(r.eq.state, 'IDLE');
  assert.equal(r.eq.ammo.SNIPER, 1);
  assert.deepEqual(r.cues, ['BOLT_OPEN', 'LOAD_ROUND', 'BOLT_CLOSE']);
});

test('switching away cancels the breech reload; drawing the empty sniper again resumes it', () => {
  const r = makeRig();
  equipSniper(r);
  r.buffered.add('FIRE');
  r.step(0.4);
  assert.equal(r.eq.state, 'RELOADING');
  r.actions.push('SLOT1');
  r.step(0.3);
  assert.equal(r.eq.activeSlot, 'PISTOL');
  assert.equal(r.eq.ammo.SNIPER, 0, 'reload cancelled');
  r.actions.push('SLOT2');
  r.step(0.25);
  assert.equal(r.eq.activeSlot, 'SNIPER');
  assert.equal(r.eq.state, 'RELOADING', 'resumes automatically');
  r.step(1.4);
  assert.equal(r.eq.ammo.SNIPER, 1);
});

test('SK_09: breaking a shield refills the active gun instantly (sniper 1/1 mid-reload, pistol 8/8)', () => {
  const r = makeRig();
  equipSniper(r);
  r.buffered.add('FIRE');
  r.step(0.5);
  assert.equal(r.eq.state, 'RELOADING');
  assert.ok(r.eq.refillActive());
  assert.equal(r.eq.ammo.SNIPER, 1);
  assert.equal(r.eq.state, 'IDLE', 'breech reload skipped');
  r.actions.push('SLOT1');
  r.step(0.3);
  r.eq.ammo.PISTOL = 2;
  r.eq.refillActive();
  assert.equal(r.eq.ammo.PISTOL, 8);
});

test('SK_03 swing reloader always refills the 1-round sniper to 1/1 at every level', () => {
  for (const frac of [0.4, 0.7, 1.0]) {
    const r = makeRig();
    r.eq.ammo.SNIPER = 0;
    r.actions.push('SLOT3');
    r.step(0.3);
    r.player.ropeAttached = true;
    r.eq.modifiers.swingReloadFraction = frac;
    r.actions.push('SLOT2');
    r.step(0.12);
    assert.equal(r.eq.ammo.SNIPER, 1, `fraction ${frac}`);
    assert.equal(Math.ceil(GUNS.SNIPER.magazine * frac), 1);
  }
});

test('pistol shot is a 14 m report; grapple launch 8 m', () => {
  const r = makeRig();
  r.buffered.add('FIRE');
  r.step(1 / 120);
  assert.deepEqual(r.gunshots, [14]);
});

test('ADS: sniper true 4x FOV + 0.20× look sensitivity, pistol −14° + 0.55×', () => {
  const r = makeRig();
  equipSniper(r);
  r.held.add('BULLET_TIME');
  for (let i = 0; i < 120; i++) r.eq.frameUpdate(1 / 60, r.cam, 0, 0);
  assert.ok(Math.abs(r.player.zoomAbsFov - magnifiedFov(84, 4)) < 1e-9);
  assert.ok(r.player.zoomAbsBlend > 0.999);
  assert.ok(Math.abs(r.input.lookScale - 0.2) < 1e-3, `look ${r.input.lookScale}`);
  r.held.delete('BULLET_TIME');
  for (let i = 0; i < 120; i++) r.eq.frameUpdate(1 / 60, r.cam, 0, 0);
  r.actions.push('SLOT1');
  r.step(0.3);
  r.held.add('BULLET_TIME');
  for (let i = 0; i < 120; i++) r.eq.frameUpdate(1 / 60, r.cam, 0, 0);
  assert.equal(r.player.zoomAbsBlend, 0);
  assert.ok(Math.abs(r.player.zoomFovDeg + 14) < 0.02);
  assert.ok(Math.abs(r.input.lookScale - 0.55) < 1e-3);
});
