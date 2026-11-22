/** 8A-4 reworked skills and 8A-5 unified sector deployment. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FLOW_RANKS, PLAYER } from '../src/config/constants';
import { SECTORS, SKILL_BY_ID, createDerivedModifiers, emptySkillLevels, deriveModifiers } from '../src/config/skills';

test('SK_07 SHADOW STEP: crouch speed +35/50/65 %, alert fill −35/48/60 %', () => {
  const sk = SKILL_BY_ID.SK_07;
  assert.equal(sk.nameEn, 'SHADOW STEP');
  assert.equal(sk.category, 'ステルス');
  assert.deepEqual([...sk.values], [0.35, 0.5, 0.65]);
  assert.deepEqual([...(sk.values2 ?? [])], [0.65, 0.52, 0.4]);
  const lv = emptySkillLevels();
  const d = createDerivedModifiers();
  for (const [level, speed, fill] of [[0, 0, 1], [1, 0.35, 0.65], [2, 0.5, 0.52], [3, 0.65, 0.4]] as const) {
    lv.SK_07 = level;
    deriveModifiers(lv, FLOW_RANKS[0], false, new Set(), d);
    assert.equal(d.crouchSpeedBonus, speed);
    assert.equal(d.alertFillMultiplier, fill);
  }
});

test('SK_09 SHIELD PIERCER: +60/90/120 % shield & wing damage', () => {
  const sk = SKILL_BY_ID.SK_09;
  assert.equal(sk.nameEn, 'SHIELD PIERCER');
  assert.deepEqual([...sk.values], [0.6, 0.9, 1.2]);
  const lv = emptySkillLevels();
  const d = createDerivedModifiers();
  lv.SK_09 = 2;
  deriveModifiers(lv, FLOW_RANKS[0], false, new Set(), d);
  assert.equal(d.shieldPartBonus, 0.9);
});

test('no skill text references the removed SMG / shotgun', () => {
  for (const id of Object.keys(SKILL_BY_ID) as (keyof typeof SKILL_BY_ID)[]) {
    const s = SKILL_BY_ID[id];
    const txt = `${s.name} ${s.nameEn} ${s.trigger} ${s.levelText.join(' ')}`;
    assert.ok(!/SMG|ショットガン|SHOTGUN/i.test(txt), `${id}: ${txt}`);
  }
});

test('Sectors 1–4 deploy every enemy in one initial wave with the 8A-5 rosters', () => {
  const want = [
    { ENFORCER: 7, VEIL: 2 },
    { ENFORCER: 5, AEGIS: 3, VEIL: 2, DRONE: 3 },
    { ENFORCER: 4, AEGIS: 3, VEIL: 3, PHANTOM: 2, DRONE: 2 },
    { ENFORCER: 3, AEGIS: 3, VEIL: 3, PHANTOM: 3, DRONE: 2 },
  ];
  const totals = [9, 13, 14, 14];
  for (let i = 0; i < 4; i++) {
    const s = SECTORS[i];
    assert.equal(s.waves.length, 1, `sector ${i + 1} waves`);
    assert.equal(s.waves[0].count, totals[i]);
    assert.deepEqual({ ...s.roster }, want[i]);
    const sum = Object.values(s.roster).reduce((a, b) => a + (b ?? 0), 0);
    assert.equal(sum, totals[i]);
    assert.ok(sum <= 14);
  }
  assert.equal(SECTORS[4].roster.VALKYRIE, 1);
});

test('crouch / slide heights (8A-2)', () => {
  assert.equal(PLAYER.CROUCH_EYE_HEIGHT, 0.78);
  assert.equal(PLAYER.SLIDE_EYE_HEIGHT, 0.68);
  assert.equal(PLAYER.SLIDE_HEIGHT, 0.94);
});
