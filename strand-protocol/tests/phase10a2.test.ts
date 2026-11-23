import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { DEG2RAD, RADAR, SCORCH } from '../src/config/constants';
import { AI_PATROL } from '../src/config/enemies';
import { EffectsPool } from '../src/entities/EffectsPool';
import { EnemyManager, type RadarEnemySample } from '../src/entities/EnemyManager';
import { PlayerController } from '../src/player/PlayerController';
import { ViewModelRenderer, buildMuzzleFlashGeometry } from '../src/player/ViewModelRenderer';
import {
  PulseRadar,
  computeRadarBlipAlpha,
  computeRadarElevation,
  projectRadarBlip,
} from '../src/ui/HudManager';
import { CityBuilder } from '../src/world/CityBuilder';
import { PhysicsWorld } from '../src/world/PhysicsWorld';
import { getProceduralTextures } from '../src/engine/ProceduralTextures';

function makeMockRenderer() {
  return {
    camera: new THREE.PerspectiveCamera(84, 16 / 9, 0.1, 400),
    renderer: { capabilities: { getMaxAnisotropy: () => 1 } },
    postFx: { frameFlash: 0, glitch: 0, fade: 0, critical: 0 },
    flashLight() {},
    triggerChromaSpike() {},
  };
}

function makeMockInput() {
  return {
    isDown: () => false,
    consumeBuffered: () => false,
    hasBuffered: () => false,
    clearBuffer: () => {},
  };
}

// =============================================================================================
// 10A-3: 3D Muzzle Flash, Sniper Barrel Heat Steam, 3D Ejected Casings & Cooling Scorch Decals
// =============================================================================================
test('10A-3.1 & 10A-3.2: 3D first-person muzzle flash geometry, active duration (45 ms pistol / 75 ms sniper), and 1.5 s sniper barrel heat decay', () => {
  const pistolGeo = buildMuzzleFlashGeometry(0.09, 0.045, 0);
  const sniperGeo = buildMuzzleFlashGeometry(0.24, 0.11, 0.1);
  pistolGeo.computeBoundingBox();
  sniperGeo.computeBoundingBox();
  assert.ok(pistolGeo.boundingBox && sniperGeo.boundingBox);
  // In gun/muzzle space, forward is -Z, so the cone extends from z = 0 to z = -length
  assert.ok(Math.abs(pistolGeo.boundingBox.min.z - -0.09) < 1e-5, 'pistol flash forward cone length is 0.09 m along -Z');
  assert.ok(Math.abs(pistolGeo.boundingBox.max.x - 0.045) < 1e-5, 'pistol flash radius is 0.045 m');
  assert.ok(Math.abs(sniperGeo.boundingBox.min.z - -0.24) < 1e-5, 'sniper flash forward cone length is 0.24 m along -Z');
  // Sniper lateral muzzle-brake side vents extend ±0.10 m from the port at ±0.012 m
  assert.ok(sniperGeo.boundingBox.max.x > 0.11, 'sniper lateral brake vents extend past ±0.10 m');

  const vm = new ViewModelRenderer(
    new THREE.Scene(),
    new THREE.PerspectiveCamera(68, 16 / 9, 0.01, 4),
    getProceduralTextures(makeMockRenderer().renderer as never),
  );
  const frame = {
    slot: 'PISTOL' as const,
    phase: 'IDLE' as const,
    phaseT: 0,
    reloadT: -1,
    reloadFrom: 8,
    ammo: 8,
    magazine: 8,
    hookInFlight: false,
    ropeAttached: false,
    reeling: false,
    lookYaw: 0,
    lookPitch: 0,
    speed: 0,
    grounded: true,
    sliding: false,
    wallSide: 0 as const,
    sinceShot: 0,
    zoom: 0,
    zoomGun: 'PISTOL' as const,
  };

  vm.onFire('PISTOL', 1);
  vm.update(0.01, frame);
  const flashMesh = vm.root.getObjectByName('MuzzleFlash') as THREE.Mesh;
  assert.ok(flashMesh, '3D MuzzleFlash mesh exists on view-model');
  assert.equal(flashMesh.visible, true, 'pistol muzzle flash visible at 10 ms (< 45 ms)');
  assert.ok(flashMesh.scale.x >= 0.85 && flashMesh.scale.x <= 1.18, 'random 0.85–1.18x micro-scale applied');
  vm.update(0.04, frame);
  assert.equal(flashMesh.visible, false, 'pistol muzzle flash hidden after 45 ms (0 extra draw calls when inactive)');

  // Sniper 75 ms flash + 1.5 s rail-coil heat decay
  frame.slot = 'SNIPER';
  vm.onFire('SNIPER', 1);
  assert.equal(vm.barrelHeat, 1, 'sniper firing heats rail-coil slits to 1.0');
  vm.update(0.06, frame);
  assert.equal(flashMesh.visible, true, 'sniper muzzle flash visible at 60 ms (< 75 ms)');
  vm.update(0.02, frame);
  assert.equal(flashMesh.visible, false, 'sniper muzzle flash hidden after 75 ms');

  // Remaining time to 1.5 s total cools barrelHeat smoothly back to 0
  vm.update(0.67, frame); // total 0.75 s = half of 1.5 s
  assert.ok(Math.abs(vm.barrelHeat - 0.5) < 0.02, `barrelHeat at 0.75 s is ~0.5 (got ${vm.barrelHeat})`);
  vm.update(0.8, frame);
  assert.equal(vm.barrelHeat, 0, 'barrelHeat cools completely to 0 after 1.5 s');
});

test('10A-3.2 & 10A-3.3: EffectsPool 3D ejected casings, barrel heat-vent steam, and 48-cap cooling bullet scorch decals (0.08 m Pistol / 0.15 m Sniper, +0.015 m offset, 4.0 s cool)', () => {
  const scene = new THREE.Scene();
  const physics = new PhysicsWorld();
  const fx = new EffectsPool(scene, physics);

  // 3D ejected casings (pooled into sparks InstancedMesh, zero extra draw calls)
  const port = new THREE.Vector3(0, 1.5, 0);
  const right = new THREE.Vector3(1, 0, 0);
  const up = new THREE.Vector3(0, 1, 0);
  fx.spawnCasing(port, right, up, false);
  fx.spawnCasing(port, right, up, true);
  assert.equal(fx.casingsSpawned, 2);
  assert.equal(fx.activeCasings, 2);

  // Barrel heat-vent steam
  fx.emitBarrelSteam(port);

  // Cooling bullet impact scorch decals (cap: 48, +0.015 m normal offset, 0.08 m Pistol / 0.15 m Sniper)
  assert.equal(SCORCH.POOL, 48);
  assert.equal(SCORCH.COOL_S, 4.0);
  assert.equal(SCORCH.EMISSIVE, 2.8);
  const hitPt = new THREE.Vector3(4, 2, -6);
  const hitNormal = new THREE.Vector3(0, 0, 1);
  fx.addScorch(hitPt, hitNormal, false, false); // Pistol impact
  fx.addScorch(hitPt, hitNormal, false, true); // Sniper impact
  assert.equal(fx.scorch.count, 2);

  const m0 = new THREE.Matrix4();
  const m1 = new THREE.Matrix4();
  const p0 = new THREE.Vector3();
  const q0 = new THREE.Quaternion();
  const s0 = new THREE.Vector3();
  const s1 = new THREE.Vector3();
  fx.scorch.getMatrixAt(0, m0);
  fx.scorch.getMatrixAt(1, m1);
  m0.decompose(p0, q0, s0);
  m1.decompose(new THREE.Vector3(), new THREE.Quaternion(), s1);

  assert.ok(Math.abs(p0.z - (hitPt.z + SCORCH.NORMAL_OFFSET_M)) < 1e-5, 'scorch decal offset +0.015 m along surface normal');
  assert.ok(Math.abs(s0.x - SCORCH.RADIUS_PISTOL_M * 2) < 1e-5, 'Pistol scorch radius is 0.08 m (diameter 0.16 m)');
  assert.ok(Math.abs(s1.x - SCORCH.RADIUS_SNIPER_M * 2) < 1e-5, 'Sniper scorch radius is 0.15 m (diameter 0.30 m)');

  const scMat = fx.scorch.material as THREE.ShaderMaterial;
  assert.equal(scMat.uniforms.uCool.value, 4.0, 'scorch shader uCool uniform is 4.0 s');
  assert.equal(scMat.uniforms.uEmissive.value, 2.8, 'scorch shader uEmissive uniform is 2.8');

  const camPos = new THREE.Vector3(0, 1.7, 0);
  const camVel = new THREE.Vector3();
  fx.update(1.2, 1.2, camPos, camVel, 1.2);
  assert.ok(Math.abs(scMat.uniforms.uTime.value - 1.2) < 1e-5, 'scorch uTime advances with simulation time');

  fx.update(3.0, 3.0, camPos, camVel, 4.2);
  assert.equal(fx.activeCasings, 0, 'casings expire cleanly after lifetime');
});

// =============================================================================================
// 10A-3b: Figure-8 Stride Head-Bob & Physical Spring-Damper Gunshot Recoil Camera Kick
// =============================================================================================
test('10A-3b.1: organic figure-8 stride head-bob scales by 0.15x during ADS and damps when airborne', () => {
  const physics = new PhysicsWorld();
  const playerHip = new PlayerController(makeMockInput() as never, physics);
  const playerAds = new PlayerController(makeMockInput() as never, physics);
  playerHip.state = 'GROUNDED';
  playerAds.state = 'GROUNDED';
  playerHip.velocity.set(0, 0, -9);
  playerAds.velocity.set(0, 0, -9);
  playerHip.adsBlend = 0;
  playerAds.adsBlend = 1; // Full ADS -> 0.15x head-bob

  const camHip = new THREE.PerspectiveCamera(84, 16 / 9, 0.1, 400);
  const camAds = new THREE.PerspectiveCamera(84, 16 / 9, 0.1, 400);
  for (let i = 0; i < 30; i++) {
    playerHip.updateCamera(1 / 60, 1, camHip);
    playerAds.updateCamera(1 / 60, 1, camAds);
  }
  const hipOffset = Math.hypot(camHip.position.x, camHip.position.y - playerHip.eyeHeight);
  const adsOffset = Math.hypot(camAds.position.x, camAds.position.y - playerAds.eyeHeight);
  assert.ok(hipOffset > 0.005, 'grounded walking produces figure-8 stride head-bob');
  assert.ok(Math.abs(adsOffset / hipOffset - 0.15) < 0.02, `ADS scales head-bob by 0.15x (ratio ${(adsOffset / hipOffset).toFixed(3)})`);

  // Airborne smoothly damps stride head-bob back toward 0
  playerHip.state = 'AIRBORNE';
  for (let i = 0; i < 60; i++) playerHip.updateCamera(1 / 60, 1, camHip);
  const airOffset = Math.hypot(camHip.position.x, camHip.position.y - playerHip.eyeHeight);
  assert.ok(airOffset < hipOffset * 0.05, 'head-bob damps out smoothly when airborne');
});

test('10A-3b.2: physical spring-damper gunshot recoil camera kick (Pistol vs Sniper + FOV punch)', () => {
  const physics = new PhysicsWorld();
  const player = new PlayerController(makeMockInput() as never, physics);
  player.state = 'GROUNDED';
  const cam = new THREE.PerspectiveCamera(84, 16 / 9, 0.1, 400);

  // Pistol hip-fire kick: +0.85° pitch, +0.45° roll, -0.016 m Z-punch
  player.onWeaponKick('PISTOL', false);
  assert.ok(Math.abs(player.kickPitch - 0.85 * DEG2RAD) < 1e-6);
  assert.ok(Math.abs(player.kickRoll - 0.45 * DEG2RAD) < 1e-6);
  assert.ok(Math.abs(player.kickZ - -0.016) < 1e-6);

  // Step spring-damper for 0.6 s -> critically damped back to ~0
  for (let i = 0; i < 60; i++) player.updateCamera(0.01, 1, cam);
  assert.ok(Math.abs(player.kickPitch) < 1e-3 && Math.abs(player.kickZ) < 1e-4, 'pistol kick spring settles smoothly to 0');

  // Sniper ADS kick: +1.4° pitch, ±1.1° roll, -0.048 m Z-punch, +1.8° FOV punch
  const fovBefore = player.fov;
  player.onWeaponKick('SNIPER', true);
  assert.ok(Math.abs(player.kickPitch - 1.4 * DEG2RAD) < 1e-5);
  assert.ok(Math.abs(Math.abs(player.kickRoll) - 1.1 * DEG2RAD) < 1e-5);
  assert.ok(Math.abs(player.kickZ - -0.048) < 1e-5);
  player.updateCamera(0.001, 1, cam);
  assert.ok(cam.fov > fovBefore + 1.2, 'sniper kick applies +1.8° FOV punch');
});

// =============================================================================================
// 10A-5: Guaranteed Mobile-Enemy ALERT Investigation (Elevated Player) & Diegetic Scanner Cones
// =============================================================================================
test('10A-5.1 & 10A-5.2: mobile enemy investigates elevated ALERT stimulus (|dy| >= 2.5 m), freezes gauge >= 25 en route, sweeps ±60° for 2.0 s on arrival, then decays to UNAWARE; scanner cones hide in DETECTED/COMBAT', () => {
  const scene = new THREE.Scene();
  const renderer = makeMockRenderer();
  const city = new CityBuilder(getProceduralTextures(renderer.renderer as never));
  const layout = city.buildSector(1, 0);
  const physics = new PhysicsWorld();
  physics.setLayout(layout);
  const fx = new EffectsPool(scene, physics);
  const player = new PlayerController(makeMockInput() as never, physics);
  const enemies = new EnemyManager(scene, physics, fx, player, renderer as never);
  enemies.startSector(layout, 0);

  // Spawn wave 1
  const DT = 1 / 60;
  for (let i = 0; i < 40; i++) enemies.fixedUpdate(DT);

  const states0 = enemies.debugState();
  const enforcerIdx = states0.findIndex((s) => s.kind === 'ENFORCER');
  assert.ok(enforcerIdx >= 0, 'Sector 1 spawns an ENFORCER');

  // Place Enforcer on an open street spawn and keep the player hidden out of LOS of all enemies so no other enemy triggers global combat
  const spawnPos = layout.groundSpawns[0].position;
  enemies.debugPlace(enforcerIdx, spawnPos.x, spawnPos.y, spawnPos.z, 0, 'UNAWARE');
  player.position.set(0, -500, 0);

  // Fire a gunshot from an elevated position (y = spawnPos.y + 12 m, 6 m away horizontally along +Z)
  const elevatedOrigin = new THREE.Vector3(spawnPos.x, spawnPos.y + 12, spawnPos.z + 6);
  const heard = enemies.onPlayerGunshot(elevatedOrigin, 14);
  assert.ok(heard >= 1, 'Enforcer hears elevated pistol shot within 14 m');

  enemies.fixedUpdate(DT);
  const stAlert = enemies.debugState()[enforcerIdx];
  assert.equal(stAlert.state, 'ALERT');
  assert.equal(stAlert.investigating, true, 'Enforcer enters investigating = true even though |dy| = 12 m >= 2.5 m');
  assert.ok(stAlert.gauge >= AI_PATROL.INVESTIGATE_GAUGE_FLOOR, `gauge floored at >= 25 (got ${stAlert.gauge})`);

  // 10A-5.2: Scanner cones visible while UNAWARE / ALERT
  enemies.frameUpdate(DT, DT, 1);
  assert.ok(enemies.scannerCones.visible && enemies.scannerCones.count > 0, 'scannerCones active for UNAWARE/ALERT mobile enemies');

  // Step while Enforcer walks toward investigateGoal at 0.80x combat speed: gauge MUST stay frozen (no decay!)
  const initialGauge = stAlert.gauge;
  let arrived = false;
  for (let step = 0; step < 480; step++) {
    enemies.fixedUpdate(DT);
    const cur = enemies.debugState()[enforcerIdx];
    assert.equal(cur.state, 'ALERT');
    assert.equal(cur.investigating, true);
    assert.ok(Math.abs(cur.gauge - initialGauge) < 1e-4, 'alertGauge decay is frozen while walking to investigateGoal');
    if (cur.sweepT > 0) {
      arrived = true;
      break;
    }
  }
  assert.equal(arrived, true, 'Enforcer arrives within <= 2.2 m of ground-reachable investigateGoal (or 7.0 s stall timeout) and starts 2.0 s ±60° sweep');

  // During the 2.0 s ±60° gaze sweep, investigating remains true and gauge remains frozen
  const yawSamples: number[] = [];
  let sweepFinished = false;
  for (let step = 0; step < 140; step++) {
    enemies.fixedUpdate(DT);
    const cur = enemies.debugState()[enforcerIdx];
    yawSamples.push(cur.yaw);
    if (!cur.investigating) {
      sweepFinished = true;
      break;
    }
    assert.ok(Math.abs(cur.gauge - initialGauge) < 1e-4, 'alertGauge remains frozen during the 2.0 s arrival sweep');
  }
  assert.equal(sweepFinished, true, 'Enforcer finishes 2.0 s sweep and clears investigating = false');
  const minYaw = Math.min(...yawSamples);
  const maxYaw = Math.max(...yawSamples);
  assert.ok(maxYaw - minYaw > 0.8, 'Enforcer actively sweeps gaze ±60° during the 2.0 s arrival pause');

  // Now that investigating is false, gauge decays at 14 pt/s back to 0 -> UNAWARE
  for (let step = 0; step < 300; step++) enemies.fixedUpdate(DT);
  const stCalm = enemies.debugState()[enforcerIdx];
  assert.equal(stCalm.state, 'UNAWARE', 'Enforcer decays back to UNAWARE after completing investigation sweep');
  assert.equal(stCalm.gauge, 0);

  // 10A-5.2: When all enemies enter COMBAT, scannerCones are hidden (0 draw calls)
  for (let i = 0; i < states0.length; i++) {
    const s = enemies.debugState()[i];
    enemies.debugPlace(i, s.pos[0], s.pos[1], s.pos[2], 0, 'COMBAT');
  }
  enemies.frameUpdate(DT, DT, 1);
  assert.equal(enemies.scannerCones.count, 0, 'scannerCones count is 0 in COMBAT');
  assert.equal(enemies.scannerCones.visible, false, 'scannerCones hidden in COMBAT');

  // 10A-6 Option C: trackedTargets returns 0 for regular enemies (no 3D wallhack diamonds!)
  const trkOut = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const trkBoss = new Uint8Array(3);
  assert.equal(enemies.trackedTargets(trkOut, trkBoss), 0, '10A-6 Option C: no 3D wallhack tracking markers for regular enemies');
});

// =============================================================================================
// 10A-6: Top-Left Circular Pulse-Scan Mini-Radar Math & Sweep State Machine
// =============================================================================================
test('10A-6: radar player-relative rotation (-player.yaw), 75 m range clamping, and ▲/▼ elevation ticks (|Δy| >= 3.5 m)', () => {
  const outerR = 60;
  // Player at (10, 0, 20) facing yaw = 0 (-Z is forward, +X is right)
  // Enemy 25 m straight ahead at (10, 0, -5) -> xPx = 0, yPx = -20 (up on radar)
  const pAhead = projectRadarBlip(10, -5, 10, 20, 0, outerR, 75);
  assert.equal(pAhead.outOfRange, false);
  assert.ok(Math.abs(pAhead.xPx) < 1e-6);
  assert.ok(Math.abs(pAhead.yPx - -20) < 1e-6, 'enemy 25 m ahead projects to -Y (up) at 1/3 radius');

  // Player turns left 90° (yaw = +π/2, looking toward -X). The same enemy at (10, -5) is now to the player's RIGHT (+X on radar)
  const pTurned = projectRadarBlip(10, -5, 10, 20, Math.PI / 2, outerR, 75);
  assert.ok(Math.abs(pTurned.xPx - 20) < 1e-6, 'rotating player +90° rotates blip to +X (right)');
  assert.ok(Math.abs(pTurned.yPx) < 1e-6);

  // Enemy beyond 75 m (120 m to the right at yaw = 0) clamps to the outer rim (60 px) with outOfRange = true
  const pFar = projectRadarBlip(130, 20, 10, 20, 0, outerR, 75);
  assert.equal(pFar.outOfRange, true);
  assert.ok(Math.abs(pFar.xPx - outerR) < 1e-6, 'enemy beyond 75 m clamps to outer rim');
  assert.ok(Math.abs(pFar.yPx) < 1e-6);

  // Elevation ticks: ▲ above when enemy.y - player.y >= +3.5 m, ▼ below when <= -3.5 m
  assert.equal(computeRadarElevation(10.0, 6.5), 'UP', 'Δy = +3.5 m -> UP (▲)');
  assert.equal(computeRadarElevation(9.9, 6.5), 'LEVEL', 'Δy = +3.4 m -> LEVEL');
  assert.equal(computeRadarElevation(3.0, 6.5), 'DOWN', 'Δy = -3.5 m -> DOWN (▼)');
  assert.equal(computeRadarElevation(3.1, 6.5), 'LEVEL', 'Δy = -3.4 m -> LEVEL');
});

test('10A-6: PulseRadar 3.5 s sweep cycle (0 -> 75 m over 0.65 s), distance-crossing snapshot refresh, and 3.2 s alpha fade (1.0 -> 0.18)', () => {
  assert.ok(Math.abs(computeRadarBlipAlpha(0) - 1.0) < 1e-6);
  assert.ok(Math.abs(computeRadarBlipAlpha(RADAR.BLIP_FADE_S) - RADAR.BLIP_MIN_ALPHA) < 1e-6);
  assert.ok(Math.abs(computeRadarBlipAlpha(RADAR.BLIP_FADE_S * 0.5) - (1.0 + RADAR.BLIP_MIN_ALPHA) * 0.5) < 1e-6);

  const radar = new PulseRadar();
  const targets: RadarEnemySample[] = [
    { id: 0, x: 0, y: 0, z: -10, state: 'UNAWARE' }, // 10 m away (crossed early in the 0.65 s sweep)
    { id: 1, x: 0, y: 8, z: -60, state: 'ALERT' }, // 60 m away (crossed late in the 0.65 s sweep)
  ];

  // Initial step (t = 0): triggers sonar ping because targetCount > 0, sweep starts at 0 m
  const ping0 = radar.step(0.01, 0, 0, 0, targets, 2);
  assert.equal(ping0, true, 'sonar ping fires at start of 3.5 s sweep with alive enemies');
  assert.equal(radar.blips[0].active, false, '10 m enemy not yet crossed at r = 1.15 m');

  // Advance to t = 0.15 s (sweep radius = (0.15/0.65)*75 ≈ 17.3 m): enemy 0 (10 m) is crossed and snapshotted, enemy 1 (60 m) not yet
  radar.step(0.14, 0, 0, 0, targets, 2);
  assert.equal(radar.blips[0].active, true, '10 m enemy blip refreshed when sweep ring crosses 10 m');
  assert.equal(radar.blips[0].alpha, 1.0);
  assert.equal(radar.blips[1].active, false, '60 m enemy not yet crossed at 17.3 m');

  // Move enemy 0 AFTER it was already snapshotted by this sweep — its snapshot must hold its scanned position until the next sweep!
  targets[0].x = 25;
  // Advance to t = 0.60 s (sweep radius ≈ 69.2 m): enemy 1 (60 m) is now crossed and snapshotted
  radar.step(0.45, 0, 0, 0, targets, 2);
  assert.equal(radar.blips[0].x, 0, 'blip snapshot holds scanned position between sweeps');
  assert.ok(radar.blips[0].alpha < 1.0 && radar.blips[0].alpha > RADAR.BLIP_MIN_ALPHA, 'enemy 0 blip is fading smoothly');
  assert.equal(radar.blips[1].active, true, '60 m enemy blip refreshed when sweep ring crosses 60 m');
  assert.equal(radar.blips[1].alpha, 1.0);
  assert.equal(radar.blips[1].state, 'ALERT');

  // Advance past 0.65 s sweep duration -> sweepRadiusM becomes -1 (ring hidden between sweeps)
  radar.step(0.2, 0, 0, 0, targets, 2);
  assert.equal(radar.sweepRadiusM, -1, 'pulse ring hides after 0.65 s expansion completes');

  // Advance to 3.45 s -> blips have faded to 0.18 min alpha
  radar.step(2.65, 0, 0, 0, targets, 2);
  assert.ok(Math.abs(radar.blips[0].alpha - RADAR.BLIP_MIN_ALPHA) < 1e-4, 'blip fades down to 0.18 over 3.2 s');

  // Cross the 3.5 s period boundary (3.45 s + 0.35 s = 3.80 s -> sweepClock = 0.30 s, sweepRadiusM ≈ 34.6 m > 26.9 m)
  const pingNext = radar.step(0.35, 0, 0, 0, targets, 2);
  assert.equal(pingNext, true, 'next 3.5 s sweep triggers sonar ping');
  assert.equal(radar.blips[0].x, 25, 'new sweep refreshes enemy 0 snapshot to x = 25');
  assert.equal(radar.blips[0].alpha, 1.0);
});
