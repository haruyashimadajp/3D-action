/** 8A-5 four-state Stealth / Alert / Detected / Combat state machine (StealthAI.ts). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AI_STEALTH } from '../src/config/enemies';
import { StealthDirector, gunshotImpulse, proximityFillRate, visionFillRate, type StealthAgent } from '../src/entities/StealthAI';

const DT = 1 / 120;

function agent(x = 0, z = 0): StealthAgent {
  return {
    alive: true, pos: { x, y: 0, z }, alertState: 'UNAWARE', alertGauge: 0, alertHoldTimer: 0, detectedTimer: 0,
    hasPlayerLos: false, seesPlayer: false, visionDist: 0, visionRange: AI_STEALTH.VISION_RANGE, nearPlayer: false,
    proxDist: 0, proxRadius: AI_STEALTH.PROX_RADIUS_STAND, inspecting: false, investigatePos: { x: 0, y: 0, z: 0 },
    hasInvestigate: false, locked: false,
  };
}

const PLAYER = { x: 10, y: 0, z: 0 };

/** Steps `agents` for `seconds`; `perceive` updates perception each step. */
function run(d: StealthDirector, agents: StealthAgent[], seconds: number, perceive?: (t: number) => void): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    perceive?.(i * DT);
    for (const a of agents) d.stepAgent(a, DT, PLAYER);
    d.stepGlobal(agents, DT, PLAYER);
  }
}

test('fill-rate formulas: vision clamp(18 + 95·(1−d/R)^1.6, 18, 115), proximity lerp(38, 85), gunshot lerp(25, 75)', () => {
  assert.equal(visionFillRate(0, 52), 113);
  assert.equal(visionFillRate(52, 52), 18);
  assert.equal(visionFillRate(80, 52), 18);
  assert.ok(Math.abs(visionFillRate(26, 52) - (18 + 95 * Math.pow(0.5, 1.6))) < 1e-9);
  assert.ok(visionFillRate(5, 52) > visionFillRate(30, 52), 'closer fills faster');
  assert.equal(proximityFillRate(0, 5.5), 85);
  assert.equal(proximityFillRate(5.5, 5.5), 38);
  assert.equal(gunshotImpulse(0, 14), 75);
  assert.equal(gunshotImpulse(14, 14), 25);
  assert.equal(gunshotImpulse(15, 14), 0);
});

test('UNAWARE → ALERT on sight; gauge fills with distance; crouch and SK_07 slow it', () => {
  const fillTime = (dist: number, crouch: boolean, mult: number): number => {
    const d = new StealthDirector();
    d.playerCrouching = crouch;
    d.fillMultiplier = mult;
    const a = agent();
    a.seesPlayer = true;
    a.visionDist = dist;
    let t = 0;
    while (a.alertState !== 'DETECTED' && t < 30) {
      d.stepAgent(a, DT, PLAYER);
      if (t === 0) assert.equal(a.alertState, 'ALERT');
      t += DT;
    }
    return t;
  };
  const near = fillTime(8, false, 1);
  const far = fillTime(45, false, 1);
  assert.ok(near < far, `near ${near.toFixed(2)} s < far ${far.toFixed(2)} s`);
  const crouched = fillTime(20, true, 1);
  const standing = fillTime(20, false, 1);
  assert.ok(Math.abs(crouched / standing - 1 / 0.72) < 0.02, 'crouch ×0.72');
  const shadow = fillTime(20, false, 0.4);
  assert.ok(Math.abs(shadow / standing - 1 / 0.4) < 0.02, 'SK_07 Lv.3 ×0.40');
});

test('proximity (even outside the cone) alerts and fills', () => {
  const d = new StealthDirector();
  const a = agent();
  a.nearPlayer = true;
  a.proxDist = 2;
  run(d, [a], 0.5);
  assert.equal(a.alertState, 'ALERT');
  assert.ok(a.alertGauge > 0.5 * 38);
});

test('ALERT decays after a 1 s hold at 14 pt/s back to UNAWARE', () => {
  const d = new StealthDirector();
  const a = agent();
  a.seesPlayer = true;
  a.visionDist = 40;
  run(d, [a], 1.0);
  a.seesPlayer = false;
  const g = a.alertGauge;
  run(d, [a], 0.99);
  assert.ok(Math.abs(a.alertGauge - g) < 1e-9, 'held for 1 s');
  run(d, [a], 0.5);
  assert.ok(Math.abs(a.alertGauge - (g - 14 * 0.51)) < 0.3);
  run(d, [a], g / 14 + 0.2);
  assert.equal(a.alertState, 'UNAWARE');
  assert.equal(a.alertGauge, 0);
});

test('gunshot impulse: 14 m pistol vs 58 m sniper; ALERT, investigate the origin, DETECTED at 100', () => {
  const d = new StealthDirector();
  const a = agent(20, 0);
  const b = agent(10, 0);
  assert.equal(d.hearGunshot([a, b], { x: 0, y: 0, z: 0 }, 14, PLAYER), 1, 'only b inside 14 m');
  assert.equal(a.alertState, 'UNAWARE');
  assert.equal(b.alertState, 'ALERT');
  assert.ok(Math.abs(b.alertGauge - gunshotImpulse(10, 14)) < 1e-9);
  assert.deepEqual(b.investigatePos, { x: 0, y: 0, z: 0 });
  d.hearGunshot([a, b], { x: 0, y: 0, z: 0 }, 58, PLAYER);
  assert.equal(a.alertState, 'ALERT');
  const c = agent(1, 0);
  d.hearGunshot([c], { x: 0, y: 0, z: 0 }, 58, PLAYER);
  d.hearGunshot([c], { x: 0, y: 0, z: 0 }, 58, PLAYER);
  assert.equal(c.alertState, 'DETECTED');
});

test('gauge 100 → DETECTED; 1.6 s later allies ≤ 22 m join; 3.5 s → COMBAT; 2.2 s → everyone COMBAT', () => {
  const events: string[] = [];
  const d = new StealthDirector({ onGlobalCombat: () => events.push('global') });
  const spotter = agent(0, 0);
  const ally = agent(15, 0);
  const far = agent(60, 0);
  const all = [spotter, ally, far];
  spotter.alertGauge = 99.9;
  spotter.alertState = 'ALERT';
  spotter.seesPlayer = true;
  spotter.visionDist = 5;
  run(d, all, DT);
  assert.equal(spotter.alertState, 'DETECTED');
  assert.ok(d.hasSharedLastKnown);
  spotter.seesPlayer = false;
  run(d, all, 1.55);
  assert.equal(ally.alertState, 'UNAWARE', 'not yet at 1.55 s');
  run(d, all, 0.1);
  assert.equal(ally.alertState, 'DETECTED', '22 m propagation after 1.6 s');
  assert.equal(far.alertState, 'UNAWARE', '60 m is out of range');
  run(d, all, 3.5 - 1.65 + 0.02);
  assert.equal(spotter.alertState, 'COMBAT', 'DETECTED 3.5 s → COMBAT');
  run(d, all, 2.1);
  assert.equal(far.alertState, 'UNAWARE', 'broadcast not yet at 2.1 s');
  run(d, all, 0.15);
  assert.equal(far.alertState, 'COMBAT', 'global broadcast at 2.2 s');
  assert.deepEqual(events, ['global']);
});

test('damage in any state → COMBAT immediately with the shared position at the player', () => {
  const d = new StealthDirector();
  for (const s of ['UNAWARE', 'ALERT', 'DETECTED'] as const) {
    const a = agent();
    a.alertState = s;
    d.onDamaged(a, { x: 3, y: 1, z: 4 });
    assert.equal(a.alertState, 'COMBAT');
    assert.deepEqual(d.sharedLastKnownPos, { x: 3, y: 1, z: 4 });
  }
});

test('LOS keeps the shared position live; 4.5 s of inspection without LOS reverts everyone to ALERT 65', () => {
  const d = new StealthDirector();
  const a = agent(0, 0);
  const b = agent(5, 0);
  a.alertState = 'COMBAT';
  b.alertState = 'DETECTED';
  a.hasPlayerLos = true;
  run(d, [a, b], 0.5);
  assert.deepEqual(d.sharedLastKnownPos, PLAYER);
  assert.equal(d.searchClearTimer, 0);
  // Player broke LOS; nobody has reached the last-known position yet → no countdown.
  a.hasPlayerLos = false;
  run(d, [a, b], 2);
  assert.equal(d.searchClearTimer, 0);
  // One searcher arrives and confirms the spot is empty.
  b.inspecting = true;
  run(d, [a, b], 4.4);
  assert.equal(a.alertState, 'COMBAT');
  run(d, [a, b], 0.15);
  assert.equal(a.alertState, 'ALERT');
  assert.equal(b.alertState, 'ALERT');
  assert.equal(a.alertGauge, 65);
  assert.ok(a.hasInvestigate);
  // Regaining LOS mid-search resets the timer.
  const c = agent();
  const e = agent();
  c.alertState = 'COMBAT';
  e.alertState = 'COMBAT';
  e.inspecting = true;
  run(d, [c, e], 3);
  c.hasPlayerLos = true;
  run(d, [c, e], DT);
  assert.equal(d.searchClearTimer, 0);
});

test('locked agents (sector 5 boss) stay in COMBAT and never de-escalate', () => {
  const d = new StealthDirector();
  const boss = agent();
  d.initAgent(boss, 'COMBAT', true);
  boss.inspecting = true;
  run(d, [boss], 10);
  assert.equal(boss.alertState, 'COMBAT');
  assert.equal(d.highest, 'COMBAT');
});
