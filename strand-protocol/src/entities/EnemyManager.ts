/**
 * STRAND // PROTOCOL — Enemy system (§5, §2.1, §1.3, §9.2).
 *
 *  - Six archetypes: Enforcer · Aegis Breacher · Veil Sniper · Phantom (humanoids) · Hunter Drone · VALKYRIE-09.
 *  - Humanoids are THREE.Group hierarchies Root → Pelvis → Torso → Head(Visor) / ArmL / ArmR(Weapon) / LegL / LegR,
 *    posed procedurally every frame (stride-driven leg swing with knee bend, aim-driven torso / arm, firing kick,
 *    hit flinch springs, shield brace, blink lean, flight). The rig Groups are pure transforms: every visible part
 *    is ONE instance of a shared BatchedMesh (armour = 1 draw call, emissive visors / accents / ghosts = 1 draw
 *    call), so 14 fully articulated enemies + the boss cost two draw calls.
 *  - Separate hitboxes (§5.2): head sphere r 0.24 (visor = HS ×2.5 by weapon) and a 0.62 × 1.35 × 0.42 body box.
 *    Hitboxes follow the rendered pose, so what you see is exactly what you hit. No aim assist anywhere.
 *  - Mandatory three-phase telegraph (§5.1) for every shooting enemy: ACQUIRING (thin dashed orange tracking line
 *    with angular-rate-limited aim) → LOCK_TELEGRAPH (aim frozen, 0.045 → 0.012 m red line, 25 Hz blink, muzzle
 *    flare, lock event for the spatial lock sound) → FIRE along the frozen line. If no line slot is free the
 *    enemy simply waits — a round is never fired without its telegraph.
 *  - GRAZE: every enemy round is tracked by the effects pool (closest pass 0.45 … 1.35 m without a hit).
 *  - Death: parts break off as ballistic debris that bounce on the surface below and digitally dissolve after 3 s.
 *  - VALKYRIE-09: rooftop-to-rooftop flight, 3× snipe, 5-line machine-gun fan; Phase 2 (< 50 %) crimson wings,
 *    ground-circle dive slash + shockwave and 4 shootable homing micro-missiles; each thruster wing (300 HP)
 *    destroyed ⇒ 3.5 s crash-down with the head fully exposed.
 * Zero allocation per frame: all scratch math uses module-scope temporaries; rigs, instances, lines, rings and
 * missiles are pre-allocated pools.
 */
import * as THREE from 'three';
import {
  BULLET_TIME,
  COLORS,
  DEG2RAD,
  HITSTOP,
  JUICE,
  LEVEL,
  LIMITS,
  MATERIALS,
  PHYSICS,
  PLAYER,
  SHAKE,
  TELEGRAPH,
  clamp,
  createRng,
  type HitstopDef,
} from '../config/constants';
import {
  AEGIS_SHIELD,
  DRONE_BEHAVIOUR,
  ENEMY_DEFS,
  HUMANOID,
  PHANTOM_BEHAVIOUR,
  VALKYRIE_BEHAVIOUR,
  VEIL_BEHAVIOUR,
  scaledLockMs,
  type EnemyDef,
} from '../config/enemies';
import { ENDLESS, type EnemyKind, type SectorDef } from '../config/skills';
import type { Renderer } from '../engine/Renderer';
import type { PlayerController } from '../player/PlayerController';
import type { SectorLayout, SpawnPoint } from '../world/CityBuilder';
import {
  type HitboxTarget,
  type PhysicsWorld,
  createMoveResult,
  createRayHit,
} from '../world/PhysicsWorld';
import { BURST, type EffectsPool, type GrazeProbe, type ProjectileImpact, type ProjectileSpec } from './EffectsPool';
import { getProceduralTextures } from '../engine/ProceduralTextures';

// =============================================================================================
// Public types
// =============================================================================================
/** `ARMOR` = VALKYRIE head hit while airborne (deflected); `WING` = hit on a boss thruster wing (weak point). */
export type HitMarkerKind = 'BODY' | 'HEAD' | 'KILL' | 'HEAD_KILL' | 'SHIELD' | 'PART' | 'ARMOR' | 'WING';

export interface KillInfo {
  readonly kind: EnemyKind;
  readonly headshot: boolean;
  readonly airborne: boolean;
  readonly wallRun: boolean;
  readonly swinging: boolean;
  readonly bulletTime: boolean;
  /** Weapon tag of the killing blow (0 pistol, 1 SMG, 2 shotgun, 3 grapple, 4 explosion / skill). */
  readonly weapon: number;
  readonly position: THREE.Vector3;
}

/** Events for juice, HUD, audio (lock sound / shots) and the FLOW / skill systems. */
export interface EnemyEvents {
  onHitstop?(def: HitstopDef): void;
  onHitMarker?(kind: HitMarkerKind): void;
  onKill?(info: KillInfo): void;
  onGraze?(point: THREE.Vector3): void;
  /**
   * LOCK_TELEGRAPH start: high-frequency lock sound at the muzzle (spatial). `lockS` is the lock duration in
   * simulation seconds; `sniper` marks 100-damage rounds (sharper 1400 → 2800 Hz tone).
   */
  onLockStart?(kind: EnemyKind, position: THREE.Vector3, lockS: number, sniper: boolean): void;
  onEnemyFire?(kind: EnemyKind, position: THREE.Vector3, sniper: boolean): void;
  /** `weapon` tag of the breaking blow (1 = SMG for SK_09). */
  onShieldBreak?(position: THREE.Vector3, weapon: number): void;
  onBossPartBreak?(position: THREE.Vector3, weapon: number): void;
  onBossPhase?(phase: 1 | 2): void;
  onBossDefeated?(position: THREE.Vector3): void;
  onPlayerHit?(damage: number, from: THREE.Vector3): void;
  /** VALKYRIE's crest deflected a head shot (not downed): "ARMORED — DESTROY WINGS". */
  onArmorDeflect?(position: THREE.Vector3): void;
  onWaveStart?(wave: number, waves: number): void;
  onSectorClear?(): void;
  onExplosion?(position: THREE.Vector3): void;
}

/** Progression hooks (FLOW rank / skills / modifiers); neutral defaults. */
export interface CombatModifiers {
  /** SK_06: grapple stun on a hooked enemy (s). */
  grappleStunS: number;
  /** FLOW S+: bullet-time recovery bonus on kills (fraction). */
  btKillRecoveryBonus: number;
  /** SK_09: SMG damage bonus vs shields / boss wings (fraction). */
  smgPartBonus: number;
  /** SK_12: extra BT gauge on GRAZE. */
  grazeBtBonus: number;
  /** HYPER SPEED modifier: lock-time reduction (fraction). */
  lockTimeReduction: number;
}

/** Off-screen warning sources (lock phase) for the HUD's directional arcs. */
export interface LockWarning {
  readonly position: THREE.Vector3;
  active: boolean;
}

// =============================================================================================
// Scratch (module scope, reused)
// =============================================================================================
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _m1Quat = new THREE.Quaternion();
const _m1 = new THREE.Matrix4();
const _col = new THREE.Color();
const _rayHit = createRayHit();
const _move = createMoveResult();
const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const _acqColor = new THREE.Color(TELEGRAPH.ACQ_COLOR);
const _lockColor = new THREE.Color(TELEGRAPH.LOCK_COLOR);
const _sightColor = new THREE.Color(0xff1030);
const _nearDist = new Float32Array(8);

const GRAVITY = PHYSICS.GRAVITY;

// =============================================================================================
// Part geometry library (all indexed, position / normal / uv — BatchedMesh requirement)
// =============================================================================================
type GeoName = 'box' | 'taper' | 'cyl' | 'sphere' | 'torus' | 'cone' | 'flare' | 'disc';
const GEO_NAMES: readonly GeoName[] = ['box', 'taper', 'cyl', 'sphere', 'torus', 'cone', 'flare', 'disc'];

function makeFlareGeometry(): THREE.BufferGeometry {
  // Three crossed quads (XY, YZ, XZ): a bright star flare from any view direction.
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const planes: ReadonlyArray<readonly [number[], number[], number[]]> = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    [[0, 0, 1], [0, 1, 0], [1, 0, 0]],
    [[1, 0, 0], [0, 0, 1], [0, 1, 0]],
  ];
  for (const [u, v, n] of planes) {
    const base = pos.length / 3;
    for (const [su, sv] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) {
      pos.push(u[0] * su + v[0] * sv, u[1] * su + v[1] * sv, u[2] * su + v[2] * sv);
      nrm.push(n[0], n[1], n[2]);
      uv.push(su + 0.5, sv + 0.5);
    }
    idx.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

function buildGeometries(): Record<GeoName, THREE.BufferGeometry> {
  const torus = new THREE.TorusGeometry(0.5, 0.06, 6, 24);
  torus.rotateX(Math.PI / 2);
  return {
    box: new THREE.BoxGeometry(1, 1, 1),
    // Hexagonal tapered prism: angular tactical plates (wide bottom, narrow top; flip for chests).
    taper: new THREE.CylinderGeometry(0.36, 0.5, 1, 6, 1),
    cyl: new THREE.CylinderGeometry(0.5, 0.5, 1, 8, 1),
    sphere: new THREE.SphereGeometry(0.5, 14, 10),
    torus,
    cone: new THREE.ConeGeometry(0.5, 1, 8, 1),
    flare: makeFlareGeometry(),
    disc: new THREE.CylinderGeometry(0.5, 0.5, 1, 20, 1),
  };
}

// =============================================================================================
// Rig
// =============================================================================================
type PartRole =
  | 'ARMOR'
  | 'VISOR'
  | 'ACCENT'
  | 'FLARE'
  | 'BLADE'
  | 'ROTOR'
  | 'THRUSTER'
  | 'SCOPE'
  | 'CORE';

interface Part {
  readonly socket: THREE.Object3D;
  readonly geo: GeoName;
  /** 0 = armour batch, 1 = glow batch. */
  readonly batch: 0 | 1;
  readonly inst: number;
  readonly role: PartRole;
  /** Linear base colour (glow parts pre-multiplied by their emissive intensity). */
  readonly base: THREE.Color;
  /** Boss thruster wing side (−1 / +1), 0 otherwise. */
  readonly wing: number;
  /** Included in Phantom afterimages. */
  readonly ghost: boolean;
}

interface Joints {
  pelvis: THREE.Object3D;
  torso: THREE.Object3D;
  head: THREE.Object3D;
  armL: THREE.Object3D;
  foreL: THREE.Object3D;
  armR: THREE.Object3D;
  foreR: THREE.Object3D;
  weapon: THREE.Object3D;
  legL: THREE.Object3D;
  shinL: THREE.Object3D;
  legR: THREE.Object3D;
  shinR: THREE.Object3D;
  wingL: THREE.Object3D;
  wingR: THREE.Object3D;
  rotors: THREE.Object3D[];
}

const GHOST_SNAPSHOTS = 6;

class Rig {
  readonly root = new THREE.Group();
  readonly parts: Part[] = [];
  readonly joints: Joints;
  readonly muzzle = new THREE.Object3D();
  readonly pods: THREE.Object3D[] = [];
  /** Body-box reference (chest) and head reference used to derive hitboxes from the rendered pose. */
  readonly chestRef = new THREE.Object3D();
  readonly wingRefL = new THREE.Object3D();
  readonly wingRefR = new THREE.Object3D();
  inUse = false;
  visible = false;
  // Debris (SoA, one entry per part)
  dPos: Float32Array = new Float32Array(0);
  dVel: Float32Array = new Float32Array(0);
  dQuat: Float32Array = new Float32Array(0);
  dAng: Float32Array = new Float32Array(0);
  dScl: Float32Array = new Float32Array(0);
  dGround: Float32Array = new Float32Array(0);
  /** Per-part: detached as debris (whole rig on death, a single wing on wing break). */
  dDetached: Uint8Array = new Uint8Array(0);
  /** Per-part debris age (s). */
  dAge: Float32Array = new Float32Array(0);
  // Phantom afterimages
  readonly ghostParts: Part[] = [];
  ghostInst: Int32Array = new Int32Array(0);
  readonly ghostLife = new Float32Array(GHOST_SNAPSHOTS);
  ghostNext = 0;

  constructor(readonly kind: EnemyKind) {
    const g = (): THREE.Group => new THREE.Group();
    this.joints = {
      pelvis: g(),
      torso: g(),
      head: g(),
      armL: g(),
      foreL: g(),
      armR: g(),
      foreR: g(),
      weapon: g(),
      legL: g(),
      shinL: g(),
      legR: g(),
      shinR: g(),
      wingL: g(),
      wingR: g(),
      rotors: [],
    };
    this.root.name = `Enemy-${kind}`;
  }

  allocateDebris(): void {
    const n = this.parts.length;
    this.dPos = new Float32Array(n * 3);
    this.dVel = new Float32Array(n * 3);
    this.dQuat = new Float32Array(n * 4);
    this.dAng = new Float32Array(n * 3);
    this.dScl = new Float32Array(n * 3);
    this.dGround = new Float32Array(n);
    this.dDetached = new Uint8Array(n);
    this.dAge = new Float32Array(n);
  }
}

/** Collects part definitions while a rig is assembled. */
class RigBuilder {
  constructor(
    private readonly rig: Rig,
    private readonly armor: THREE.BatchedMesh,
    private readonly glow: THREE.BatchedMesh,
    private readonly geoIdsArmor: Record<GeoName, number>,
    private readonly geoIdsGlow: Record<GeoName, number>,
  ) {}

  add(
    parent: THREE.Object3D,
    geo: GeoName,
    glow: boolean,
    p: readonly [number, number, number],
    s: readonly [number, number, number],
    color: number,
    intensity: number,
    role: PartRole,
    r: readonly [number, number, number] = [0, 0, 0],
    opts: { wing?: number; ghost?: boolean } = {},
  ): THREE.Object3D {
    const socket = new THREE.Object3D();
    socket.position.set(p[0], p[1], p[2]);
    socket.scale.set(s[0], s[1], s[2]);
    socket.rotation.set(r[0], r[1], r[2]);
    parent.add(socket);
    const batch = glow ? this.glow : this.armor;
    const inst = batch.addInstance(glow ? this.geoIdsGlow[geo] : this.geoIdsArmor[geo]);
    batch.setVisibleAt(inst, false);
    const base = new THREE.Color(color).multiplyScalar(intensity);
    batch.setColorAt(inst, base);
    this.rig.parts.push({ socket, geo, batch: glow ? 1 : 0, inst, role, base, wing: opts.wing ?? 0, ghost: opts.ghost ?? false });
    return socket;
  }

  /** Allocates Phantom afterimage instances (glow batch copies of the ghost parts). */
  allocateGhosts(color: number): void {
    const rig = this.rig;
    for (const p of rig.parts) if (p.ghost) rig.ghostParts.push(p);
    rig.ghostInst = new Int32Array(GHOST_SNAPSHOTS * rig.ghostParts.length);
    _col.setHex(color);
    for (let s = 0; s < GHOST_SNAPSHOTS; s++) {
      for (let k = 0; k < rig.ghostParts.length; k++) {
        const inst = this.glow.addInstance(this.geoIdsGlow[rig.ghostParts[k].geo]);
        this.glow.setVisibleAt(inst, false);
        this.glow.setColorAt(inst, _col);
        rig.ghostInst[s * rig.ghostParts.length + k] = inst;
      }
    }
  }
}

// =============================================================================================
// Rig assembly (procedural, built once per pooled rig)
// =============================================================================================
type V3 = readonly [number, number, number];
const HUMANOID_ARMOR = COLORS.HUMANOID_MATTE;
const UNDERSUIT = 0x0d1017;
const BOSS_ARMOR = 0xd3d8e2;
/** 5B-4: VALKYRIE accents white in phase 1 → crimson in phase 2 (visor stays crimson). */
const BOSS_ACCENT = 0xe8f6ff;
const BOSS_VISOR = 0xff0055;
const BOSS_ACCENT_P2 = 0xff0055;
/** Enforcer accents are red (kind colour coding, 5B-4). */
const ENFORCER_ACCENT = 0xff2a3c;

interface HumanoidStyle {
  armor: number;
  under: number;
  visor: number;
  accent: number;
  shoulder: V3;
  chest: V3;
  heavy: boolean;
}

/** Root → Pelvis → Torso → Head(Visor) / ArmL / ArmR(Weapon) / LegL / LegR (§5.2). Forward = +Z. */
function buildHumanoidBody(b: RigBuilder, rig: Rig, st: HumanoidStyle, ghost: boolean): void {
  const j = rig.joints;
  const A = st.armor;
  const U = st.under;
  const ACC = MATERIALS.WALLRUN_PANEL.emissive; // accent line intensity (2.2)
  rig.root.add(j.pelvis);
  j.pelvis.position.set(0, 1.0, 0);
  b.add(j.pelvis, 'box', false, [0, 0, 0], [0.34, 0.18, 0.24], A, 1, 'ARMOR', [0, 0, 0], { ghost });
  b.add(j.pelvis, 'box', false, [0, -0.1, 0.1], [0.22, 0.12, 0.05], U, 1, 'ARMOR');

  // Torso
  j.pelvis.add(j.torso);
  j.torso.position.set(0, 0.1, 0);
  b.add(j.torso, 'box', false, [0, 0.1, 0], [0.28, 0.22, 0.2], U, 1, 'ARMOR', [0, 0, 0], { ghost });
  b.add(j.torso, 'taper', false, [0, 0.36, 0], st.chest, A, 1, 'ARMOR', [Math.PI, 0, 0], { ghost });
  b.add(j.torso, 'box', false, [0, 0.38, st.chest[2] * 0.48], [st.chest[0] * 0.72, 0.2, 0.06], A, 1, 'ARMOR');
  b.add(j.torso, 'box', false, [0, 0.36, -0.2], [0.3, 0.32, 0.14], U, 1, 'ARMOR');
  // 5B-4 kind-coloured chest core (Enforcer red · Aegis orange · Veil crimson · Phantom violet · boss white→crimson).
  b.add(j.torso, 'box', true, [0, 0.33, st.chest[2] * 0.48 + 0.035], [0.16, 0.05, 0.022], st.accent, 2.6, 'CORE');
  rig.chestRef.position.set(0, 0.0, 0);
  j.pelvis.add(rig.chestRef);

  // Head (helmet + horizontal visor)
  j.torso.add(j.head);
  j.head.position.set(0, 0.62, 0);
  const hr = HUMANOID.HEAD_VISUAL_RADIUS * 2;
  b.add(j.head, 'cyl', false, [0, -0.15, 0], [0.12, 0.14, 0.12], U, 1, 'ARMOR');
  b.add(j.head, 'sphere', false, [0, 0, 0], [hr * 0.96, hr, hr], A, 1, 'ARMOR', [0, 0, 0], { ghost });
  b.add(j.head, 'box', false, [0, hr * 0.5, -0.02], [0.06, 0.06, hr * 0.8], A, 1, 'ARMOR');
  b.add(j.head, 'box', false, [0, -0.08, hr * 0.3], [hr * 0.72, 0.1, 0.12], A, 1, 'ARMOR');
  b.add(j.head, 'box', false, [-hr * 0.5, 0, 0], [0.05, 0.12, 0.1], A, 1, 'ARMOR');
  b.add(j.head, 'box', false, [hr * 0.5, 0, 0], [0.05, 0.12, 0.1], A, 1, 'ARMOR');
  b.add(j.head, 'box', true, [0, 0.02, hr * 0.42], [hr * 0.78, 0.075, 0.08], st.visor, MATERIALS.HUMANOID_VISOR.emissive, 'VISOR');

  // Arms
  for (const side of [-1, 1] as const) {
    const arm = side < 0 ? j.armL : j.armR;
    const fore = side < 0 ? j.foreL : j.foreR;
    j.torso.add(arm);
    arm.position.set(side * 0.29, 0.46, 0);
    b.add(arm, 'box', false, [side * 0.02, 0.05, 0], st.shoulder, A, 1, 'ARMOR');
    b.add(arm, 'box', true, [side * 0.02, 0.05 + st.shoulder[1] * 0.5 + 0.01, st.shoulder[2] * 0.3], [st.shoulder[0] * 0.9, 0.028, 0.026], st.accent, ACC * 1.2, 'ACCENT');
    b.add(arm, 'cyl', false, [0, -0.17, 0], [0.11, 0.3, 0.11], U, 1, 'ARMOR', [0, 0, 0], { ghost });
    arm.add(fore);
    fore.position.set(0, -0.33, 0);
    b.add(fore, 'taper', false, [0, -0.14, 0], [0.12, 0.28, 0.12], A, 1, 'ARMOR', [0, 0, 0], { ghost });
    b.add(fore, 'box', false, [0, -0.2, 0], [0.13, 0.12, 0.14], A, 1, 'ARMOR');
    b.add(fore, 'box', false, [0, -0.31, 0], [0.08, 0.1, 0.1], U, 1, 'ARMOR');
  }
  j.foreR.add(j.weapon);
  j.weapon.position.set(0, -0.3, 0.02);
  j.weapon.rotation.x = Math.PI / 2;

  // Legs
  for (const side of [-1, 1] as const) {
    const leg = side < 0 ? j.legL : j.legR;
    const shin = side < 0 ? j.shinL : j.shinR;
    j.pelvis.add(leg);
    leg.position.set(side * 0.12, -0.08, 0);
    b.add(leg, 'cyl', false, [0, -0.22, 0], [0.16, 0.44, 0.16], U, 1, 'ARMOR', [0, 0, 0], { ghost });
    b.add(leg, 'box', false, [0, -0.2, 0.08], [0.17, 0.26, 0.06], A, 1, 'ARMOR');
    leg.add(shin);
    shin.position.set(0, -0.46, 0);
    b.add(shin, 'box', false, [0, 0, 0.09], [0.15, 0.12, 0.08], A, 1, 'ARMOR');
    b.add(shin, 'box', true, [0, 0.02, 0.135], [0.1, 0.018, 0.02], st.accent, ACC, 'ACCENT');
    b.add(shin, 'taper', false, [0, -0.22, 0], [0.14, 0.4, 0.14], A, 1, 'ARMOR', [Math.PI, 0, 0], { ghost });
    b.add(shin, 'box', false, [0, -0.41, 0.05], [0.14, 0.1, 0.27], A, 1, 'ARMOR');
  }
  if (st.heavy) {
    b.add(j.torso, 'box', false, [0, 0.12, 0.13], [0.3, 0.16, 0.05], A, 1, 'ARMOR');
    b.add(j.pelvis, 'box', false, [-0.17, -0.12, 0], [0.06, 0.2, 0.22], A, 1, 'ARMOR');
    b.add(j.pelvis, 'box', false, [0.17, -0.12, 0], [0.06, 0.2, 0.22], A, 1, 'ARMOR');
  }
}

function addMuzzle(b: RigBuilder, rig: Rig, parent: THREE.Object3D, z: number, y: number, flareSize: number, color: number): void {
  rig.muzzle.position.set(0, y, z);
  parent.add(rig.muzzle);
  b.add(parent, 'flare', true, [0, y, z + 0.02], [flareSize, flareSize, flareSize], color, TELEGRAPH.LOCK_EMISSIVE, 'FLARE');
}

function buildEnforcer(b: RigBuilder, rig: Rig): void {
  const visor = ENEMY_DEFS.ENFORCER.visorColor;
  buildHumanoidBody(b, rig, { armor: HUMANOID_ARMOR, under: UNDERSUIT, visor, accent: ENFORCER_ACCENT, shoulder: [0.2, 0.12, 0.26], chest: [0.5, 0.34, 0.32], heavy: false }, false);
  const w = rig.joints.weapon;
  b.add(w, 'box', false, [0, 0.03, 0.12], [0.08, 0.13, 0.5], HUMANOID_ARMOR, 1, 'ARMOR');
  b.add(w, 'box', false, [0, -0.08, 0.06], [0.05, 0.14, 0.08], UNDERSUIT, 1, 'ARMOR');
  b.add(w, 'box', false, [0, 0.02, -0.16], [0.06, 0.1, 0.16], UNDERSUIT, 1, 'ARMOR');
  b.add(w, 'cyl', false, [0, 0.05, 0.48], [0.035, 0.28, 0.035], UNDERSUIT, 1, 'ARMOR', [Math.PI / 2, 0, 0]);
  b.add(w, 'box', true, [0.045, 0.06, 0.15], [0.012, 0.012, 0.28], visor, 2.0, 'ACCENT');
  addMuzzle(b, rig, w, 0.64, 0.05, 0.42, TELEGRAPH.LOCK_COLOR);
}

function buildAegis(b: RigBuilder, rig: Rig): void {
  const visor = ENEMY_DEFS.AEGIS.visorColor;
  buildHumanoidBody(b, rig, { armor: HUMANOID_ARMOR, under: UNDERSUIT, visor, accent: AEGIS_SHIELD.COLOR, shoulder: [0.27, 0.16, 0.31], chest: [0.58, 0.38, 0.36], heavy: true }, false);
  // Shield emitter on the left forearm.
  b.add(rig.joints.foreL, 'box', false, [-0.08, -0.17, 0.02], [0.06, 0.26, 0.2], HUMANOID_ARMOR, 1, 'ARMOR');
  b.add(rig.joints.foreL, 'box', true, [-0.112, -0.17, 0.02], [0.012, 0.2, 0.05], AEGIS_SHIELD.COLOR, MATERIALS.SHIELD_AMBER.emissive, 'ACCENT');
  // Plasma launcher.
  const w = rig.joints.weapon;
  b.add(w, 'box', false, [0, 0.03, 0.1], [0.13, 0.17, 0.46], HUMANOID_ARMOR, 1, 'ARMOR');
  b.add(w, 'cyl', false, [0, 0.05, 0.42], [0.09, 0.2, 0.09], UNDERSUIT, 1, 'ARMOR', [Math.PI / 2, 0, 0]);
  b.add(w, 'torus', true, [0, 0.05, 0.36], [0.13, 0.13, 0.13], 0xff7a1a, 2.4, 'ACCENT', [Math.PI / 2, 0, 0]);
  b.add(w, 'torus', true, [0, 0.05, 0.44], [0.13, 0.13, 0.13], 0xff7a1a, 2.4, 'ACCENT', [Math.PI / 2, 0, 0]);
  addMuzzle(b, rig, w, 0.54, 0.05, 0.55, TELEGRAPH.LOCK_COLOR);
}

function buildVeil(b: RigBuilder, rig: Rig): void {
  const visor = ENEMY_DEFS.VEIL.visorColor;
  buildHumanoidBody(b, rig, { armor: HUMANOID_ARMOR, under: UNDERSUIT, visor, accent: visor, shoulder: [0.18, 0.1, 0.22], chest: [0.46, 0.32, 0.3], heavy: false }, false);
  // Hood cowl + cape plate.
  b.add(rig.joints.head, 'taper', false, [0, 0.07, -0.03], [0.5, 0.24, 0.5], UNDERSUIT, 1, 'ARMOR');
  b.add(rig.joints.torso, 'box', false, [0, 0.12, -0.25], [0.38, 0.62, 0.035], UNDERSUIT, 1, 'ARMOR', [0.12, 0, 0]);
  // Long rifle with scope.
  const w = rig.joints.weapon;
  b.add(w, 'box', false, [0, 0.03, 0.14], [0.07, 0.11, 0.62], HUMANOID_ARMOR, 1, 'ARMOR');
  b.add(w, 'box', false, [0, 0.0, -0.22], [0.06, 0.12, 0.2], UNDERSUIT, 1, 'ARMOR');
  b.add(w, 'cyl', false, [0, 0.05, 0.72], [0.03, 0.62, 0.03], UNDERSUIT, 1, 'ARMOR', [Math.PI / 2, 0, 0]);
  b.add(w, 'cyl', false, [0, 0.13, 0.12], [0.055, 0.22, 0.055], UNDERSUIT, 1, 'ARMOR', [Math.PI / 2, 0, 0]);
  b.add(w, 'sphere', true, [0, 0.13, 0.235], [0.045, 0.045, 0.02], visor, 3.0, 'SCOPE');
  addMuzzle(b, rig, w, 1.04, 0.05, 0.5, TELEGRAPH.LOCK_COLOR);
}

function buildPhantom(b: RigBuilder, rig: Rig): void {
  const visor = ENEMY_DEFS.PHANTOM.visorColor;
  buildHumanoidBody(b, rig, { armor: 0x171425, under: UNDERSUIT, visor, accent: visor, shoulder: [0.17, 0.1, 0.22], chest: [0.46, 0.33, 0.3], heavy: false }, true);
  // Back fins.
  b.add(rig.joints.torso, 'box', false, [-0.1, 0.42, -0.28], [0.03, 0.4, 0.16], 0x171425, 1, 'ARMOR', [-0.5, 0, 0.25]);
  b.add(rig.joints.torso, 'box', false, [0.1, 0.42, -0.28], [0.03, 0.4, 0.16], 0x171425, 1, 'ARMOR', [-0.5, 0, -0.25]);
  b.add(rig.joints.torso, 'box', true, [0, 0.42, -0.275], [0.02, 0.36, 0.03], visor, 2.2, 'ACCENT');
  // Arm blade (left forearm) — glows during the 350 ms slash telegraph.
  b.add(rig.joints.foreL, 'box', false, [-0.08, -0.18, 0], [0.04, 0.22, 0.08], 0x171425, 1, 'ARMOR');
  b.add(rig.joints.foreL, 'box', true, [-0.085, -0.6, 0], [0.018, 0.78, 0.06], visor, 0.8, 'BLADE');
  // Pulse pistol.
  const w = rig.joints.weapon;
  b.add(w, 'box', false, [0, 0.03, 0.06], [0.07, 0.12, 0.3], 0x171425, 1, 'ARMOR');
  b.add(w, 'cyl', false, [0, 0.05, 0.25], [0.03, 0.14, 0.03], UNDERSUIT, 1, 'ARMOR', [Math.PI / 2, 0, 0]);
  b.add(w, 'box', true, [0.038, 0.05, 0.07], [0.01, 0.012, 0.2], visor, 2.4, 'ACCENT');
  addMuzzle(b, rig, w, 0.34, 0.05, 0.36, TELEGRAPH.LOCK_COLOR);
  b.allocateGhosts(PHANTOM_BEHAVIOUR.GHOST_COLOR);
}

function buildDrone(b: RigBuilder, rig: Rig): void {
  const lens = ENEMY_DEFS.DRONE.visorColor;
  const A = COLORS.ENEMY_ARMOR;
  const hull = rig.joints.pelvis; // the hull is the drone's root body
  rig.root.add(hull);
  hull.position.set(0, 0, 0);
  rig.chestRef.position.set(0, 0, 0);
  hull.add(rig.chestRef);
  b.add(hull, 'sphere', false, [0, 0, 0], [0.78, 0.38, 0.78], A, 1, 'ARMOR');
  b.add(hull, 'sphere', false, [0, 0.15, -0.05], [0.44, 0.26, 0.44], A, 1, 'ARMOR');
  b.add(hull, 'cyl', false, [0, 0, 0], [0.9, 0.07, 0.9], UNDERSUIT, 1, 'ARMOR');
  b.add(hull, 'box', false, [0, 0.02, -0.42], [0.06, 0.22, 0.24], A, 1, 'ARMOR', [0.4, 0, 0]);
  // Optical lens (weak point = head-shot region).
  rig.joints.head.position.set(0, -0.02, 0.4);
  hull.add(rig.joints.head);
  b.add(hull, 'cyl', false, [0, -0.02, 0.33], [0.32, 0.16, 0.32], UNDERSUIT, 1, 'ARMOR', [Math.PI / 2, 0, 0]);
  b.add(rig.joints.head, 'sphere', true, [0, 0, 0.04], [0.26, 0.26, 0.12], lens, MATERIALS.HUMANOID_VISOR.emissive, 'VISOR');
  b.add(rig.joints.head, 'torus', true, [0, 0, 0.0], [0.34, 0.34, 0.34], lens, 1.4, 'ACCENT', [Math.PI / 2, 0, 0]);
  // Rotor arms.
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + (k * Math.PI) / 2;
    const cx = Math.sin(a);
    const cz = Math.cos(a);
    b.add(hull, 'box', false, [cx * 0.45, 0.04, cz * 0.45], [0.08, 0.05, 0.62], A, 1, 'ARMOR', [0, a, 0]);
    const rotor = new THREE.Group();
    rotor.position.set(cx * 0.76, 0.08, cz * 0.76);
    hull.add(rotor);
    rig.joints.rotors.push(rotor);
    b.add(rotor, 'torus', true, [0, 0, 0], [0.5, 0.5, 0.5], COLORS.WALLRUN_CYAN, 1.1, 'ROTOR');
    b.add(rotor, 'disc', true, [0, 0, 0], [0.46, 0.008, 0.46], 0x9fdcff, 0.22, 'ROTOR');
    b.add(rotor, 'cyl', false, [0, -0.03, 0], [0.08, 0.08, 0.08], UNDERSUIT, 1, 'ARMOR');
  }
  // Gun pod.
  const w = rig.joints.weapon;
  hull.add(w);
  w.position.set(0, -0.17, 0.2);
  b.add(w, 'box', false, [0, 0, 0.05], [0.09, 0.09, 0.32], UNDERSUIT, 1, 'ARMOR');
  b.add(w, 'box', true, [0, -0.05, 0.05], [0.04, 0.01, 0.26], lens, 2.0, 'ACCENT');
  addMuzzle(b, rig, w, 0.24, 0, 0.36, TELEGRAPH.LOCK_COLOR);
}

function buildValkyrie(b: RigBuilder, rig: Rig): void {
  const accent = BOSS_ACCENT;
  buildHumanoidBody(b, rig, { armor: BOSS_ARMOR, under: 0x1a1f2a, visor: BOSS_VISOR, accent, shoulder: [0.26, 0.15, 0.3], chest: [0.56, 0.38, 0.36], heavy: true }, false);
  const j = rig.joints;
  // Crest & armoured head cowl (deflects head shots unless downed).
  b.add(j.head, 'cone', false, [0, 0.2, -0.06], [0.12, 0.2, 0.3], BOSS_ARMOR, 1, 'ARMOR', [-0.4, 0, 0]);
  b.add(j.head, 'box', true, [0, 0.14, 0.15], [0.03, 0.08, 0.02], accent, 3.0, 'ACCENT');
  // Shoulder micro-missile pods (2 tubes each → 4 launch points).
  for (const side of [-1, 1] as const) {
    const arm = side < 0 ? j.armL : j.armR;
    b.add(arm, 'box', false, [side * 0.03, 0.17, -0.02], [0.2, 0.14, 0.26], BOSS_ARMOR, 1, 'ARMOR');
    for (const t of [-1, 1] as const) {
      b.add(arm, 'cyl', true, [side * 0.03 + t * 0.05, 0.17, 0.13], [0.05, 0.02, 0.05], accent, 2.6, 'ACCENT', [Math.PI / 2, 0, 0]);
      const pod = new THREE.Object3D();
      pod.position.set(side * 0.03 + t * 0.05, 0.17, 0.16);
      arm.add(pod);
      rig.pods.push(pod);
    }
  }
  // Thruster wings: three feather panels per side with glowing thruster strips.
  for (const side of [-1, 1] as const) {
    const wing = side < 0 ? j.wingL : j.wingR;
    j.torso.add(wing);
    wing.position.set(side * 0.2, 0.44, -0.24);
    b.add(wing, 'cone', true, [0, -0.05, -0.04], [0.12, 0.16, 0.12], accent, 2.4, 'THRUSTER', [Math.PI, 0, 0], { wing: side });
    for (let k = 0; k < 3; k++) {
      const spread = 0.55 + k * 0.32;
      const len = 1.05 - k * 0.12;
      const px = side * (0.16 + 0.2 * k);
      const py = 0.18 + 0.06 * k;
      b.add(wing, 'box', false, [px, py, -0.06 - 0.05 * k], [0.06, len, 0.22], BOSS_ARMOR, 1, 'ARMOR', [0.25, 0, side * spread], { wing: side });
      b.add(wing, 'box', true, [px + side * 0.035, py, -0.02 - 0.05 * k], [0.02, len * 0.9, 0.05], VALKYRIE_BEHAVIOUR.WING_COLOR_P1, 3.0, 'THRUSTER', [0.25, 0, side * spread], { wing: side });
    }
    const ref = side < 0 ? rig.wingRefL : rig.wingRefR;
    ref.position.set(side * 0.42, 0.3, -0.12);
    wing.add(ref);
  }
  // Arm cannon.
  const w = j.weapon;
  b.add(w, 'box', false, [0, 0.03, 0.12], [0.14, 0.16, 0.52], BOSS_ARMOR, 1, 'ARMOR');
  b.add(w, 'cyl', false, [0, 0.05, 0.46], [0.07, 0.26, 0.07], 0x1a1f2a, 1, 'ARMOR', [Math.PI / 2, 0, 0]);
  b.add(w, 'box', true, [0.075, 0.05, 0.14], [0.012, 0.014, 0.36], accent, 2.8, 'ACCENT');
  addMuzzle(b, rig, w, 0.62, 0.05, 0.7, TELEGRAPH.LOCK_COLOR);
}

const RIG_BUILDERS: Readonly<Record<EnemyKind, (b: RigBuilder, rig: Rig) => void>> = {
  ENFORCER: buildEnforcer,
  AEGIS: buildAegis,
  VEIL: buildVeil,
  PHANTOM: buildPhantom,
  DRONE: buildDrone,
  VALKYRIE: buildValkyrie,
};

/** Pooled rigs per archetype (max simultaneously alive + dissolving). */
const RIG_POOL: Readonly<Record<EnemyKind, number>> = {
  ENFORCER: 14,
  AEGIS: 7,
  VEIL: 7,
  PHANTOM: 5,
  DRONE: 8,
  VALKYRIE: 1,
};

// =============================================================================================
// Attack patterns (telegraph → fire)
// =============================================================================================
type AttackPhase = 'IDLE' | 'ACQUIRING' | 'LOCK' | 'FIRING';
type PatternKind = 'BULLET' | 'MISSILE';

interface Pattern {
  readonly kind: PatternKind;
  /** Telegraph lines (one per pellet / fan line / missile pod). */
  readonly lines: number;
  /** Horizontal fan step between lines (deg). */
  readonly fanStepDeg: number;
  /** Lines start at the shoulder pods (missiles) instead of the muzzle. */
  readonly fromPods: boolean;
  readonly acquireMs: number;
  readonly lockMs: number;
  /** Rounds per line per pull. */
  readonly rounds: number;
  readonly roundIntervalS: number;
  /** Lines fire one after another (missile salvo) instead of together. */
  readonly sequentialLines: boolean;
  readonly spec: ProjectileSpec;
  readonly trackRadPerS: number;
  readonly predictive: boolean;
  readonly cooldownS: number;
}

const KIND_TAG: Readonly<Record<EnemyKind, number>> = { ENFORCER: 10, AEGIS: 11, VEIL: 12, PHANTOM: 13, DRONE: 14, VALKYRIE: 15 };
/** VALKYRIE attack-specific round tags (snipe uses the kind tag 15). */
const TAG_BOSS_SWEEP = 16;
const TAG_BOSS_MISSILE = 17;
/** 5A-5 death read-out "ELIMINATED // <cause>" per enemy round tag. */
const CAUSE_BY_TAG: Readonly<Record<number, string>> = {
  10: 'ENFORCER RIFLE',
  11: 'AEGIS BREACHER SCATTER',
  12: 'VEIL SNIPER',
  13: 'PHANTOM SMG',
  14: 'HUNTER DRONE',
  15: 'VALKYRIE-09 RAIL SNIPE',
  16: 'VALKYRIE-09 MG FAN',
  17: 'VALKYRIE-09 MICRO-MISSILE',
};
const CAUSE_PHANTOM_SLASH = 'PHANTOM BLADE';
const CAUSE_BOSS_DIVE = 'VALKYRIE-09 DIVE SHOCKWAVE';
const CAUSE_BOSS_MISSILE = 'VALKYRIE-09 MICRO-MISSILE';
const CAUSE_DRONE_BLAST = 'HUNTER DRONE SELF-DESTRUCT';

function enemySpec(def: EnemyDef, damage: number, speed: number, width: number, color: number, intensity: number, tag: number): ProjectileSpec {
  return { owner: 'ENEMY', speed, range: def.gun.range + 30, damage, headMultiplier: 1, shieldMultiplier: 1, color, intensity, width, tag };
}

function gunPattern(def: EnemyDef): Pattern {
  const g = def.gun;
  return {
    kind: 'BULLET',
    lines: g.pellets,
    fanStepDeg: g.pelletSpreadDeg,
    fromPods: false,
    acquireMs: g.telegraph.acquireMs,
    lockMs: g.telegraph.lockMs,
    rounds: g.shots,
    roundIntervalS: g.shotIntervalMs / 1000,
    sequentialLines: false,
    spec: enemySpec(def, g.damage, g.projectileSpeed, g.tracerWidth, g.tracerColor, 3.6, KIND_TAG[def.kind]),
    trackRadPerS: g.trackDegPerS * DEG2RAD,
    predictive: g.predictive,
    cooldownS: g.cooldownS,
  };
}

const VB = VALKYRIE_BEHAVIOUR;
const VALK_DEF = ENEMY_DEFS.VALKYRIE;
const PATTERNS = {
  ENFORCER: gunPattern(ENEMY_DEFS.ENFORCER),
  AEGIS: gunPattern(ENEMY_DEFS.AEGIS),
  VEIL: gunPattern(ENEMY_DEFS.VEIL),
  PHANTOM: gunPattern(ENEMY_DEFS.PHANTOM),
  DRONE: gunPattern(ENEMY_DEFS.DRONE),
  BOSS_SNIPE: {
    kind: 'BULLET', lines: 1, fanStepDeg: 0, fromPods: false,
    acquireMs: VB.SNIPE.telegraph.acquireMs, lockMs: VB.SNIPE.telegraph.lockMs,
    rounds: 1, roundIntervalS: 0, sequentialLines: false,
    spec: enemySpec(VALK_DEF, VB.SNIPE.damage, VB.SNIPE.speed, 0.07, VALK_DEF.gun.tracerColor, 4.2, KIND_TAG.VALKYRIE),
    trackRadPerS: VALK_DEF.gun.trackDegPerS * DEG2RAD, predictive: false, cooldownS: 0.25,
  },
  BOSS_SWEEP: {
    kind: 'BULLET', lines: VB.SWEEP.lines, fanStepDeg: VB.SWEEP.fanStepDeg, fromPods: false,
    acquireMs: VB.SWEEP.telegraph.acquireMs, lockMs: VB.SWEEP.telegraph.lockMs,
    rounds: VB.SWEEP.roundsPerLine, roundIntervalS: VB.SWEEP.roundIntervalMs / 1000, sequentialLines: false,
    spec: enemySpec(VALK_DEF, VB.SWEEP.damage, VB.SWEEP.speed, 0.05, 0xff3a7a, 3.6, TAG_BOSS_SWEEP),
    trackRadPerS: VALK_DEF.gun.trackDegPerS * DEG2RAD, predictive: false, cooldownS: 0.5,
  },
  BOSS_MISSILES: {
    kind: 'MISSILE', lines: VB.MISSILES.count, fanStepDeg: 0, fromPods: true,
    acquireMs: VB.MISSILES.telegraph.acquireMs, lockMs: VB.MISSILES.telegraph.lockMs,
    rounds: 1, roundIntervalS: VB.MISSILES.launchIntervalMs / 1000, sequentialLines: true,
    spec: enemySpec(VALK_DEF, VB.MISSILES.damage, VB.MISSILES.speedStart, 0.05, 0xff3a7a, 3.0, TAG_BOSS_MISSILE),
    trackRadPerS: VALK_DEF.gun.trackDegPerS * DEG2RAD, predictive: false, cooldownS: 0.5,
  },
} as const satisfies Record<string, Pattern>;

const MAX_LINES_PER_ENEMY = 5;

// =============================================================================================
// Enemy state
// =============================================================================================
type BossMode =
  | 'INTRO'
  | 'RELOCATE'
  | 'HOVER'
  | 'PHASE_SHIFT'
  | 'DIVE_ACQ'
  | 'DIVE_LOCK'
  | 'DIVING'
  | 'DIVE_GROUND'
  | 'FALLING'
  | 'DOWNED'
  | 'RECOVER';
type BossAttack = 'SNIPE' | 'SWEEP' | 'DIVE' | 'MISSILES';
type SlashState = 'NONE' | 'GLOW' | 'LUNGE' | 'COOL';

const BOSS_CYCLE_P1: readonly BossAttack[] = ['SNIPE', 'SWEEP'];
const BOSS_CYCLE_P2: readonly BossAttack[] = ['SNIPE', 'DIVE', 'SWEEP', 'MISSILES'];
const COVER_MAX = 24;
/** Roof perimeter vantage points (u, v in −1…1): corners, edge midpoints and quarter points. */
const ROOF_VANTAGE: readonly number[] = [-1, -1, 1, -1, -1, 1, 1, 1, 0, -1, 0, 1, -1, 0, 1, 0, -0.5, -1, 0.5, -1, -0.5, 1, 0.5, 1, -1, -0.5, -1, 0.5, 1, -0.5, 1, 0.5];

class Enemy {
  kind: EnemyKind = 'ENFORCER';
  def: EnemyDef = ENEMY_DEFS.ENFORCER;
  rig: Rig | null = null;
  active = false;
  alive = false;
  spawnT = 0;
  deathT = 0;
  hp = 0;
  maxHp = 0;
  shieldHp = 0;
  shieldMax = 0;
  shieldFlash = 0;
  readonly pos = new THREE.Vector3();
  readonly prevPos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  yaw = 0;
  prevYaw = 0;
  /** Unit aim direction (tracked with the angular limit). */
  readonly aimDir = new THREE.Vector3(0, 0, 1);
  aimBlend = 0;
  grounded = true;
  readonly home = new THREE.Vector3();
  layerY = 0;
  /** Roof the enemy stands on (Veil perches), −1 otherwise. */
  building = -1;
  // navigation
  readonly goal = new THREE.Vector3();
  hasGoal = false;
  goalTimer = 0;
  readonly cover = new Float32Array(COVER_MAX * 6);
  coverCount = 0;
  // perception
  canSee = false;
  losTimer = 0;
  lostT = 0;
  /** Time without line of sight to the player (s) — drives advancing. */
  unseenT = 0;
  // attack
  pattern: Pattern = PATTERNS.ENFORCER;
  phase: AttackPhase = 'IDLE';
  phaseT = 0;
  cooldown = 0;
  acquireS = 0;
  lockS = 0;
  readonly lineIds = new Int16Array(MAX_LINES_PER_ENEMY).fill(-1);
  lineCount = 0;
  sightLine = -1;
  readonly lockO = new Float32Array(MAX_LINES_PER_ENEMY * 3);
  readonly lockD = new Float32Array(MAX_LINES_PER_ENEMY * 3);
  readonly lockE = new Float32Array(MAX_LINES_PER_ENEMY * 3);
  shotIndex = 0;
  shotTimer = 0;
  // reactions
  stun = 0;
  flinchX = 0;
  flinchZ = 0;
  flinchVX = 0;
  flinchVZ = 0;
  recoil = 0;
  recoilV = 0;
  hitFlash = 0;
  visorBroken = false;
  walkPhase = 0;
  animSpeed = 0;
  crouch = 0;
  // world-space muzzle / pods (refreshed from the rendered pose)
  readonly muzzle = new THREE.Vector3();
  readonly pods = new Float32Array(12);
  // hitbox offsets from the rendered pose (relative to pos)
  readonly headOff = new THREE.Vector3();
  readonly bodyOff = new THREE.Vector3();
  readonly wingOffL = new THREE.Vector3();
  readonly wingOffR = new THREE.Vector3();
  // phantom
  blinkCd = 0;
  blinking = false;
  blinkT = 0;
  blinkDur = 0;
  readonly blinkFrom = new THREE.Vector3();
  readonly blinkTo = new THREE.Vector3();
  recoverT = 0;
  ghostTimer = 0;
  slash: SlashState = 'NONE';
  slashT = 0;
  slashCd = 0;
  slashHit = false;
  readonly slashDir = new THREE.Vector3();
  // drone
  orbitAngle = 0;
  orbitDir = 1;
  orbitR = 18;
  altitude = 12;
  retargetT = 0;
  rotorSpin = 0;
  // boss
  bossMode: BossMode = 'INTRO';
  bossT = 0;
  bossPhase: 1 | 2 = 1;
  readonly wingHp = new Float32Array(2);
  readonly wingBroken = new Uint8Array(2);
  cycleIndex = 0;
  snipesLeft = 0;
  nextAction: 'ATTACK' | 'SNIPE_AGAIN' | 'RELOCATE' = 'ATTACK';
  actionT = 0;
  currentAttack: BossAttack = 'SNIPE';
  readonly way = new Float32Array(9);
  wayCount = 0;
  wayIndex = 0;
  perch = -1;
  readonly diveTarget = new THREE.Vector3();
  diveRing = -1;
  shockT = -1;
  shockHit = false;
  readonly shockCenter = new THREE.Vector3();
  groundY = 0;
  hoverBaseY = 0;
  summoned = false;
  lean = 0;
  // hitboxes
  readonly hit: HitboxTarget;
  readonly shieldTarget: HitboxTarget;
  readonly wingTargetL: HitboxTarget;
  readonly wingTargetR: HitboxTarget;
  readonly warning: LockWarning = { position: new THREE.Vector3(), active: false };

  constructor(readonly index: number) {
    const mk = (id: number): HitboxTarget => ({
      id,
      group: index,
      shield: id % 4 === 1,
      alive: false,
      headCenter: new THREE.Vector3(),
      headRadius: 0,
      bodyCenter: new THREE.Vector3(),
      bodyHalf: new THREE.Vector3(),
      bodyYaw: 0,
    });
    this.hit = mk(index * 4);
    this.shieldTarget = mk(index * 4 + 1);
    this.wingTargetL = mk(index * 4 + 2);
    this.wingTargetR = mk(index * 4 + 3);
  }

  get scale(): number {
    return this.def.scale;
  }

  get isBoss(): boolean {
    return this.kind === 'VALKYRIE';
  }

  get downed(): boolean {
    return this.bossMode === 'DOWNED' || this.bossMode === 'FALLING';
  }
}

// =============================================================================================
// Helpers
// =============================================================================================
/** Rotates unit `cur` toward unit `target` by at most `maxAngle` (rad). */
function rotateToward(cur: THREE.Vector3, target: THREE.Vector3, maxAngle: number): void {
  const d = clamp(cur.dot(target), -1, 1);
  const ang = Math.acos(d);
  if (ang <= maxAngle || ang < 1e-6) {
    cur.copy(target);
    return;
  }
  _axis.crossVectors(cur, target);
  if (_axis.lengthSq() < 1e-10) _axis.copy(UP);
  else _axis.normalize();
  cur.applyAxisAngle(_axis, maxAngle).normalize();
}

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function turnToward(cur: number, target: number, maxStep: number): number {
  const d = wrapAngle(target - cur);
  return cur + clamp(d, -maxStep, maxStep);
}

/** Yaw (rad) of a horizontal direction with forward = +Z. */
function yawOf(x: number, z: number): number {
  return Math.atan2(x, z);
}

function readV(arr: Float32Array, i: number, out: THREE.Vector3): THREE.Vector3 {
  return out.set(arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]);
}

function writeV(arr: Float32Array, i: number, v: THREE.Vector3): void {
  arr[i * 3] = v.x;
  arr[i * 3 + 1] = v.y;
  arr[i * 3 + 2] = v.z;
}

// =============================================================================================
// Manager
// =============================================================================================
const ENEMY_SLOTS = 24;
const MISSILE_CAP = 8;
const ARMOR_INSTANCES = 2400;
const GLOW_INSTANCES = 1500;
const SHIELD_CAP = RIG_POOL.AEGIS;
const PLAYER_TARGET_ID = 9999;
const MISSILE_ID_BASE = 1000;
/** Projectile tag of SK_15 head-shot ricochet rounds. */
export const RICOCHET_TAG = 5;
/** Tracking markers appear once this few enemies remain (5A-5). */
const TRACK_REMAINING_MAX = 3;
const DEBRIS_LIFE = TELEGRAPH.DEBRIS_LIFETIME_S;
const DISSOLVE_S = 0.6;
const LINE_IGNORE_NONE = undefined;
const PLAYER_R = 0.38;
const GRAPPLE_HOOK_DAMAGE = 15;
const PLAYER_STAND_H = 1.86;
const PLAYER_SLIDE_H = 0.98;

export class EnemyManager {
  readonly armor: THREE.BatchedMesh;
  readonly glow: THREE.BatchedMesh;
  private readonly shieldMesh: THREE.InstancedMesh;
  private readonly shieldUniforms: { uTime: { value: number } };
  private readonly enemies: Enemy[] = [];
  private readonly rigs: Record<EnemyKind, Rig[]>;
  /** Targets for PLAYER rounds: enemy heads / bodies, Aegis shields, boss wings, micro-missiles. */
  readonly targets: HitboxTarget[] = [];
  /** Targets the grapple hook can bite into (no missiles). */
  readonly grappleTargets: HitboxTarget[] = [];
  /** The player's own hitbox for ENEMY rounds. */
  readonly playerTarget: HitboxTarget;
  readonly playerTargets: readonly HitboxTarget[];
  readonly graze: GrazeProbe;
  readonly warnings: LockWarning[] = [];
  readonly modifiers: CombatModifiers = { grappleStunS: 0.4, btKillRecoveryBonus: 0, smgPartBonus: 0, grazeBtBonus: 0, lockTimeReduction: 0 };

  // ---- micro-missiles ----
  private readonly mActive = new Uint8Array(MISSILE_CAP);
  private readonly mPos = new Float32Array(MISSILE_CAP * 3);
  private readonly mDir = new Float32Array(MISSILE_CAP * 3);
  private readonly mSpeed = new Float32Array(MISSILE_CAP);
  private readonly mLife = new Float32Array(MISSILE_CAP);
  private readonly mTrail = new Float32Array(MISSILE_CAP);
  private readonly mInst = new Int32Array(MISSILE_CAP * 3);
  private readonly mTargets: HitboxTarget[] = [];

  // ---- sector / waves ----
  private layout: SectorLayout | null = null;
  private loop = 0;
  private waveLists: EnemyKind[][] = [];
  private wave = -1;
  private readonly queue: EnemyKind[] = [];
  private waveDelay = -1;
  private cleared = false;
  private totalCount = 0;
  private killedCount = 0;
  private readonly perches: THREE.Vector3[] = [];
  private rng = createRng(1);
  private simTime = 0;
  private realTime = 0;
  private boss: Enemy | null = null;
  private bossDefeated = false;
  // grapple hook on an enemy
  private hooked: Enemy | null = null;
  private readonly hookOffset = new THREE.Vector3();

  constructor(
    scene: THREE.Scene,
    private readonly physics: PhysicsWorld,
    private readonly effects: EffectsPool,
    private readonly player: PlayerController,
    private readonly renderer: Renderer,
    readonly events: EnemyEvents = {},
  ) {
    // ---- shared part geometry ----
    const geos = buildGeometries();
    let verts = 0;
    let indices = 0;
    for (const n of GEO_NAMES) {
      verts += geos[n].getAttribute('position').count;
      indices += geos[n].getIndex()?.count ?? 0;
    }

    // Armour: matte carbon black PBR with an always-on cyan / red Fresnel rim (§6.1 enemy armour), now with the
    // shared tactical tech maps (5B-4: albedo ≈ 0.48 linear → colour ×2.05, roughness compensated).
    const tech = getProceduralTextures(renderer.renderer).tech;
    const armorMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(1, 1, 1).multiplyScalar(2.05),
      roughness: Math.min(1, MATERIALS.HUMANOID_MATTE.roughness / 0.45),
      metalness: MATERIALS.HUMANOID_MATTE.metalness,
      envMapIntensity: 1.15,
      map: tech.map,
      roughnessMap: tech.roughnessMap,
      normalMap: tech.normalMap,
      normalScale: new THREE.Vector2(0.9, 0.9),
    });
    armorMat.onBeforeCompile = (shader) => {
      shader.uniforms.uRimCyan = { value: new THREE.Color(COLORS.WALLRUN_CYAN) };
      shader.uniforms.uRimRed = { value: new THREE.Color(COLORS.ENEMY_DANGER) };
      // 5B-4: 0.55 → 1.05 — the silhouette cuts out against dark towers and cars.
      shader.uniforms.uRimStrength = { value: 1.05 };
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uRimCyan;\nuniform vec3 uRimRed;\nuniform float uRimStrength;')
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
          {
            vec3 vd = normalize(vViewPosition);
            float fr = pow(1.0 - clamp(abs(dot(normal, vd)), 0.0, 1.0), 3.0);
            vec3 rimCol = mix(uRimRed, uRimCyan, clamp(normal.y * 0.5 + 0.5, 0.0, 1.0));
            totalEmissiveRadiance += rimCol * fr * uRimStrength;
            #if defined( USE_BATCHING_COLOR ) || defined( USE_COLOR )
            // Instance colours above 1.0 drive the white hit flash / cyan spawn glitch as emission (5B-4 fix:
            // BatchedMesh colours define USE_BATCHING_COLOR, never USE_COLOR_ALPHA).
            totalEmissiveRadiance += max(vColor.rgb - 1.0, 0.0);
            #endif
          }`,
        );
    };
    this.armor = new THREE.BatchedMesh(ARMOR_INSTANCES, verts + 64, indices + 256, armorMat);
    this.armor.name = 'EnemyArmour';
    this.armor.frustumCulled = false;
    const glowMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    this.glow = new THREE.BatchedMesh(GLOW_INSTANCES, verts + 64, indices + 256, glowMat);
    this.glow.name = 'EnemyGlow';
    this.glow.frustumCulled = false;
    this.glow.renderOrder = 15;
    const ia = {} as Record<GeoName, number>;
    const ig = {} as Record<GeoName, number>;
    for (const n of GEO_NAMES) {
      ia[n] = this.armor.addGeometry(geos[n]);
      ig[n] = this.glow.addGeometry(geos[n]);
    }
    scene.add(this.armor);
    scene.add(this.glow);

    // ---- pooled rigs ----
    this.rigs = { ENFORCER: [], AEGIS: [], VEIL: [], PHANTOM: [], DRONE: [], VALKYRIE: [] };
    for (const kind of Object.keys(RIG_POOL) as EnemyKind[]) {
      for (let i = 0; i < RIG_POOL[kind]; i++) {
        const rig = new Rig(kind);
        const builder = new RigBuilder(rig, this.armor, this.glow, ia, ig);
        RIG_BUILDERS[kind](builder, rig);
        rig.allocateDebris();
        this.rigs[kind].push(rig);
      }
    }

    // ---- Aegis energy shields: 130° honeycomb arc, one instanced draw ----
    const arc = AEGIS_SHIELD.ARC_DEG * DEG2RAD;
    const shieldGeo = new THREE.CylinderGeometry(0.88, 0.88, 1.95, 24, 6, true, -arc / 2, arc);
    this.shieldUniforms = { uTime: { value: 0 } };
    const shieldMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: this.shieldUniforms,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        varying vec3 vN;
        varying vec3 vV;
        varying vec3 vTint;
        void main() {
          vUv = uv;
          vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
          vN = normalize(mat3(modelMatrix * instanceMatrix) * normal);
          vV = normalize(cameraPosition - wp.xyz);
          #ifdef USE_INSTANCING_COLOR
          vTint = instanceColor;
          #else
          vTint = vec3(1.0);
          #endif
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        varying vec2 vUv;
        varying vec3 vN;
        varying vec3 vV;
        varying vec3 vTint;
        // Hexagonal honeycomb distance (returns distance to the nearest cell edge).
        float hexEdge(vec2 p) {
          p.x *= 1.1547;
          p.y += mod(floor(p.x), 2.0) * 0.5;
          p = abs(fract(p) - 0.5);
          return abs(max(p.x * 1.5 + p.y, p.y * 2.0) - 1.0);
        }
        void main() {
          vec2 p = vec2(vUv.x * 9.0, vUv.y * 9.0);
          float e = hexEdge(p);
          float line = 1.0 - smoothstep(0.0, 0.09, e);
          float fres = pow(1.0 - abs(dot(normalize(vN), vV)), 2.0);
          float scan = 0.5 + 0.5 * sin(vUv.y * 40.0 - uTime * 6.0);
          float edge = smoothstep(0.9, 1.0, abs(vUv.x - 0.5) * 2.0) + smoothstep(0.92, 1.0, vUv.y) + smoothstep(0.08, 0.0, vUv.y);
          float a = 0.07 + line * 0.38 + fres * 0.35 + edge * 0.5 + scan * 0.04;
          gl_FragColor = vec4(vTint * a, 1.0);
        }
      `,
    });
    this.shieldMesh = new THREE.InstancedMesh(shieldGeo, shieldMat, SHIELD_CAP);
    this.shieldMesh.name = 'AegisShields';
    this.shieldMesh.frustumCulled = false;
    this.shieldMesh.count = 0;
    this.shieldMesh.renderOrder = 16;
    this.shieldMesh.setColorAt(0, _col.setRGB(1, 1, 1));
    scene.add(this.shieldMesh);

    // ---- enemy slots & targets ----
    for (let i = 0; i < ENEMY_SLOTS; i++) {
      const e = new Enemy(i);
      this.enemies.push(e);
      this.targets.push(e.hit, e.shieldTarget, e.wingTargetL, e.wingTargetR);
      this.grappleTargets.push(e.hit, e.shieldTarget, e.wingTargetL, e.wingTargetR);
      this.warnings.push(e.warning);
    }
    for (let m = 0; m < MISSILE_CAP; m++) {
      const t: HitboxTarget = { id: MISSILE_ID_BASE + m, alive: false, headCenter: new THREE.Vector3(), headRadius: VB.MISSILES.hitRadius, bodyCenter: new THREE.Vector3(), bodyHalf: new THREE.Vector3(0, 0, 0), bodyYaw: 0 };
      this.mTargets.push(t);
      this.targets.push(t);
      this.mInst[m * 3] = this.armor.addInstance(ia.cyl);
      this.mInst[m * 3 + 1] = this.armor.addInstance(ia.cone);
      this.mInst[m * 3 + 2] = this.glow.addInstance(ig.flare);
      this.armor.setVisibleAt(this.mInst[m * 3], false);
      this.armor.setVisibleAt(this.mInst[m * 3 + 1], false);
      this.glow.setVisibleAt(this.mInst[m * 3 + 2], false);
      this.armor.setColorAt(this.mInst[m * 3], _col.setHex(BOSS_ARMOR));
      this.armor.setColorAt(this.mInst[m * 3 + 1], _col.setHex(BOSS_ARMOR));
      this.glow.setColorAt(this.mInst[m * 3 + 2], _col.setHex(BOSS_ACCENT).multiplyScalar(4));
    }

    this.playerTarget = { id: PLAYER_TARGET_ID, alive: false, headCenter: new THREE.Vector3(), headRadius: 0, bodyCenter: new THREE.Vector3(), bodyHalf: new THREE.Vector3(0.38, 0.93, 0.38), bodyYaw: 0 };
    this.playerTargets = [this.playerTarget];
    this.graze = {
      active: false,
      a: new THREE.Vector3(),
      b: new THREE.Vector3(),
      onGraze: (point, direction, distance) => this.onGraze(point, direction, distance),
    };
  }

  // =============================================================================================
  // Sector lifecycle & waves (§8.1)
  // =============================================================================================
  /** Builds the wave composition for a sector and spawns wave 1. Also used for the 500 ms death retry. */
  startSector(layout: SectorLayout, loop: number): void {
    this.layout = layout;
    this.loop = loop;
    this.clearAll();
    const sector = layout.sector;
    this.rng = createRng(0x51ed + sector.index * 977 + loop * 131);
    this.waveLists = composeWaves(sector, loop);
    this.totalCount = 0;
    for (const w of this.waveLists) this.totalCount += w.length;
    this.killedCount = 0;
    this.wave = -1;
    this.cleared = false;
    this.bossDefeated = false;
    this.buildPerches(layout);
    this.startWave(0);
  }

  /** Death retry: the same sector restarts from wave 1. */
  resetSector(): void {
    if (this.layout) this.startSector(this.layout, this.loop);
  }

  /** Removes every enemy, round-trip state and wave (title screen). */
  clear(): void {
    this.clearAll();
    this.waveLists = [];
    this.wave = -1;
    this.totalCount = 0;
    this.killedCount = 0;
    this.cleared = false;
    this.bossDefeated = false;
  }

  private clearAll(): void {
    for (const e of this.enemies) this.releaseEnemy(e);
    for (let m = 0; m < MISSILE_CAP; m++) this.killMissile(m, false);
    this.queue.length = 0;
    this.waveDelay = -1;
    this.boss = null;
    this.hooked = null;
    this.shieldMesh.count = 0;
  }

  private startWave(w: number): void {
    this.wave = w;
    this.waveDelay = -1;
    for (const k of this.waveLists[w]) this.queue.push(k);
    this.events.onWaveStart?.(w + 1, this.waveLists.length);
  }

  /** Alive + queued enemies (HUD "REMAINING"). */
  get remaining(): number {
    let n = this.queue.length;
    for (const e of this.enemies) if (e.alive) n++;
    for (let w = this.wave + 1; w < this.waveLists.length; w++) n += this.waveLists[w].length;
    return n;
  }

  get isCleared(): boolean {
    return this.cleared;
  }

  get waveNumber(): number {
    return this.wave + 1;
  }

  get waveTotal(): number {
    return this.waveLists.length;
  }

  /** Boss HUD data (null when no boss is present). */
  bossStatus(out: { hp: number; maxHp: number; wingL: number; wingR: number; phase: number; downed: boolean }): boolean {
    const b = this.boss;
    if (!b || !b.alive) return false;
    out.hp = b.hp;
    out.maxHp = b.maxHp;
    out.wingL = b.wingBroken[0] ? 0 : b.wingHp[0] / VB.WING_HP;
    out.wingR = b.wingBroken[1] ? 0 : b.wingHp[1] / VB.WING_HP;
    out.phase = b.bossPhase;
    out.downed = b.downed;
    return true;
  }

  /**
   * 5A-5 tactical tracking markers: with ≤ 3 enemies left, every alive enemy; VALKYRIE always while alive.
   * Writes chest positions into `out` and 1 (boss) / 0 into `boss`; returns the count (≤ out.length).
   */
  trackedTargets(out: THREE.Vector3[], boss: Uint8Array): number {
    const all = this.remaining <= TRACK_REMAINING_MAX;
    let n = 0;
    for (const e of this.enemies) {
      if (!e.active || !e.alive || n >= out.length) continue;
      if (!all && !e.isBoss) continue;
      out[n].addVectors(e.pos, e.bodyOff);
      boss[n] = e.isBoss ? 1 : 0;
      n++;
    }
    return n;
  }

  private aliveCount(): number {
    let n = 0;
    for (const e of this.enemies) if (e.alive) n++;
    return n;
  }

  private updateWaves(dt: number): void {
    // Spawn queued enemies while under the 14-active cap and a rig is free.
    let guard = 4;
    while (this.queue.length > 0 && guard-- > 0 && this.aliveCount() < LIMITS.ACTIVE_ENEMIES) {
      const kind = this.queue[0];
      if (!this.spawn(kind, false)) break;
      this.queue.shift();
    }
    if (this.cleared) return;
    if (this.queue.length > 0 || this.aliveCount() > 0) return;
    if (this.wave < this.waveLists.length - 1) {
      if (this.waveDelay < 0) this.waveDelay = 1.5;
      this.waveDelay -= dt;
      if (this.waveDelay <= 0) this.startWave(this.wave + 1);
    } else if (!this.layout?.sector.bossSummons || this.bossDefeated) {
      this.cleared = true;
      this.events.onSectorClear?.();
    }
  }

  private buildPerches(layout: SectorLayout): void {
    this.perches.length = 0;
    for (const b of layout.buildings) {
      if (b.roofY < LEVEL.ROOF_LAYER_Y_MIN) continue;
      this.perches.push(new THREE.Vector3(b.cx, b.roofY + VB.PERCH_CLEARANCE, b.cz));
    }
    const c = layout.center;
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
      this.perches.push(new THREE.Vector3(c.x + Math.sin(a) * 22, 30 + (k % 2) * 8, c.z + Math.cos(a) * 22));
    }
  }

  // =============================================================================================
  // Spawning
  // =============================================================================================
  private freeRig(kind: EnemyKind): Rig | null {
    for (const r of this.rigs[kind]) if (!r.inUse) return r;
    return null;
  }

  private freeSlot(): Enemy | null {
    for (const e of this.enemies) if (!e.active) return e;
    return null;
  }

  private pickSpawn(kind: EnemyKind, out: THREE.Vector3): boolean {
    const L = this.layout;
    if (!L) return false;
    this.pickedBuilding = -1;
    if (kind === 'VALKYRIE') {
      out.copy(L.center).setY(2);
      return true;
    }
    if (kind === 'DRONE') return this.pickFrom(L.airSpawns, null, out, 12);
    let pools: ReadonlyArray<readonly SpawnPoint[]>;
    const r = this.rng();
    // 5A-5: roofs belong to the VEIL snipers only; ENFORCER / AEGIS / PHANTOM always spawn on connected
    // battlefields (streets, expressway decks, canal bridges, sky-bridges) — never stranded on a rooftop.
    if (kind === 'VEIL') pools = [L.perchSpawns, L.roofSpawns];
    else if (kind === 'PHANTOM') pools = r < 0.75 || L.bridgeSpawns.length === 0 ? [L.groundSpawns, L.highwaySpawns, L.bridgeSpawns] : [L.bridgeSpawns, L.groundSpawns, L.highwaySpawns];
    else if (kind === 'AEGIS') pools = r < 0.6 || L.highwaySpawns.length === 0 ? [L.groundSpawns, L.bridgeSpawns, L.highwaySpawns] : [L.highwaySpawns, L.groundSpawns, L.bridgeSpawns];
    else if (r < 0.45 || (L.highwaySpawns.length === 0 && L.skybridgeSpawns.length === 0)) pools = [L.groundSpawns, L.bridgeSpawns, L.highwaySpawns];
    else if (r < 0.6 && L.bridgeSpawns.length > 0) pools = [L.bridgeSpawns, L.groundSpawns, L.highwaySpawns];
    else if (r < 0.85 && L.highwaySpawns.length > 0) pools = [L.highwaySpawns, L.groundSpawns, L.bridgeSpawns];
    else pools = [L.skybridgeSpawns, L.groundSpawns, L.highwaySpawns];
    for (const pool of pools) if (this.pickFrom(null, pool, out, 9)) return true;
    for (const pool of pools) if (this.pickFrom(null, pool, out, 0)) return true;
    return false;
  }

  /** Random spawn point away from the player (≥ 25 m) and other enemies (≥ minSep). */
  private pickedBuilding = -1;

  private pickFrom(points: readonly THREE.Vector3[] | null, spawns: readonly SpawnPoint[] | null, out: THREE.Vector3, minSep: number): boolean {
    const n = points ? points.length : spawns ? spawns.length : 0;
    if (n === 0) return false;
    const start = Math.floor(this.rng() * n);
    const pp = this.player.position;
    for (let k = 0; k < n; k++) {
      const i = (start + k) % n;
      const p = points ? points[i] : (spawns as readonly SpawnPoint[])[i].position;
      if (minSep > 0 && Math.hypot(p.x - pp.x, p.z - pp.z) < 25) continue;
      let ok = true;
      for (const e of this.enemies) {
        if (!e.alive) continue;
        if (Math.hypot(e.pos.x - p.x, e.pos.z - p.z) < minSep && Math.abs(e.pos.y - p.y) < 4) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      out.copy(p);
      this.pickedBuilding = spawns ? spawns[i].building : -1;
      return true;
    }
    return false;
  }

  /** Materialises one enemy. Returns false when no rig / slot / spawn point is available yet. */
  private spawn(kind: EnemyKind, summon: boolean): boolean {
    const rig = this.freeRig(kind);
    const e = this.freeSlot();
    if (!rig || !e) return false;
    if (!this.pickSpawn(kind, _v1)) return false;
    const def = ENEMY_DEFS[kind];
    const hpScale = 1 + ENDLESS.ENEMY_HP_PER_LOOP * this.loop;
    e.kind = kind;
    e.def = def;
    e.rig = rig;
    rig.inUse = true;
    e.active = true;
    e.alive = true;
    e.spawnT = 0;
    e.deathT = 0;
    e.hp = def.hp * hpScale;
    e.maxHp = e.hp;
    e.shieldMax = kind === 'AEGIS' ? AEGIS_SHIELD.HP * hpScale : 0;
    e.shieldHp = e.shieldMax;
    e.shieldFlash = 0;
    e.pos.copy(_v1);
    if (kind === 'DRONE') e.pos.y = clamp(_v1.y, DRONE_BEHAVIOUR.ALT_MIN, DRONE_BEHAVIOUR.ALT_MAX);
    e.prevPos.copy(e.pos);
    e.home.copy(e.pos);
    e.layerY = e.pos.y;
    e.building = this.pickedBuilding;
    e.vel.set(0, 0, 0);
    e.yaw = yawOf(this.player.position.x - e.pos.x, this.player.position.z - e.pos.z);
    e.prevYaw = e.yaw;
    e.aimDir.set(Math.sin(e.yaw), 0, Math.cos(e.yaw));
    e.aimBlend = 0;
    e.grounded = kind !== 'DRONE' && kind !== 'VALKYRIE';
    e.hasGoal = false;
    e.goalTimer = 0.5 + this.rng() * 1.5;
    e.canSee = false;
    e.losTimer = this.rng() * HUMANOID.LOS_INTERVAL_S;
    e.lostT = 0;
    e.unseenT = 0;
    e.pattern = kind === 'VALKYRIE' ? PATTERNS.BOSS_SNIPE : PATTERNS[kind];
    e.phase = 'IDLE';
    e.phaseT = 0;
    e.cooldown = 0.4 + this.rng() * 1.2;
    e.lineCount = 0;
    e.lineIds.fill(-1);
    e.sightLine = -1;
    e.stun = 0;
    e.flinchX = e.flinchZ = e.flinchVX = e.flinchVZ = 0;
    e.recoil = e.recoilV = 0;
    e.hitFlash = 0;
    e.visorBroken = false;
    e.walkPhase = this.rng() * Math.PI * 2;
    e.animSpeed = 0;
    e.crouch = 0;
    e.blinkCd = 1 + this.rng();
    e.blinking = false;
    e.recoverT = 0;
    e.ghostTimer = 0;
    e.slash = 'NONE';
    e.slashCd = 0;
    e.orbitAngle = yawOf(e.pos.x - this.player.position.x, e.pos.z - this.player.position.z);
    e.orbitDir = this.rng() < 0.5 ? -1 : 1;
    e.orbitR = DRONE_BEHAVIOUR.ORBIT_RADIUS_MIN + this.rng() * (DRONE_BEHAVIOUR.ORBIT_RADIUS_MAX - DRONE_BEHAVIOUR.ORBIT_RADIUS_MIN);
    e.altitude = e.pos.y;
    e.retargetT = 2 + this.rng() * 2;
    e.summoned = summon;
    e.wingBroken.fill(0);
    e.wingHp.fill(VB.WING_HP * hpScale);
    e.bossPhase = 1;
    e.bossMode = 'INTRO';
    e.bossT = 0;
    e.cycleIndex = 0;
    e.perch = -1;
    e.wayCount = 0;
    e.diveRing = -1;
    e.shockT = -1;
    e.lean = 0;
    e.warning.active = false;
    rig.dDetached.fill(0);
    for (let g = 0; g < GHOST_SNAPSHOTS; g++) rig.ghostLife[g] = 0;
    if (kind === 'VALKYRIE') this.boss = e;
    if (kind !== 'DRONE' && kind !== 'VALKYRIE' && kind !== 'VEIL') this.buildCover(e);
    // Materialise: pose once so muzzle / hitboxes are valid on the first step.
    this.setRigVisible(rig, true);
    this.poseEnemy(e, e.pos, e.yaw, 0, 0);
    this.updateHitboxes(e);
    this.effects.burst(_v2.copy(e.pos).setY(e.pos.y + 1.0 * e.scale), UP, BURST.GLITCH);
    return true;
  }

  /** Spawns boss summons immediately (ignores the wave queue). */
  private summon(kind: EnemyKind, count: number): void {
    for (let i = 0; i < count; i++) {
      if (!this.spawn(kind, true)) this.queue.push(kind);
      else this.totalCount++;
    }
  }

  /** Cover points next to cars / props / steel near home on the same layer (computed at spawn only). */
  private buildCover(e: Enemy): void {
    const L = this.layout;
    e.coverCount = 0;
    if (!L) return;
    const r = HUMANOID.RADIUS * e.scale + 0.15;
    const h = HUMANOID.HEIGHT * e.scale;
    for (const c of L.colliders) {
      if (e.coverCount >= COVER_MAX) break;
      if (c.kind !== 'CAR' && c.kind !== 'PROP' && c.kind !== 'STEEL') continue;
      if (Math.abs(c.min.y - e.layerY) > 0.7 || c.max.y < e.layerY + 0.9 || c.max.y > e.layerY + 4.5) continue;
      const cx = (c.min.x + c.max.x) / 2;
      const cz = (c.min.z + c.max.z) / 2;
      if (Math.hypot(cx - e.home.x, cz - e.home.z) > 18) continue;
      const hx = (c.max.x - c.min.x) / 2 + r + 0.5;
      const hz = (c.max.z - c.min.z) / 2 + r + 0.5;
      for (let f = 0; f < 4 && e.coverCount < COVER_MAX; f++) {
        _v3.set(cx + (f === 0 ? hx : f === 1 ? -hx : 0), e.layerY + 0.05, cz + (f === 2 ? hz : f === 3 ? -hz : 0));
        if (!this.physics.boxFree(_v3, r, h)) continue;
        const gy = this.physics.probeGround(_v4.copy(_v3).setY(e.layerY + 0.6), 0.15, 1.2);
        if (gy === null || Math.abs(gy - e.layerY) > 0.4) continue;
        const o = e.coverCount * 6;
        e.cover[o] = _v3.x;
        e.cover[o + 1] = gy;
        e.cover[o + 2] = _v3.z;
        e.cover[o + 3] = cx;
        e.cover[o + 4] = (c.min.y + c.max.y) / 2;
        e.cover[o + 5] = cz;
        e.coverCount++;
      }
    }
  }

  private setRigVisible(rig: Rig, on: boolean): void {
    rig.visible = on;
    for (const p of rig.parts) (p.batch === 0 ? this.armor : this.glow).setVisibleAt(p.inst, on && p.role !== 'FLARE');
    for (let k = 0; k < rig.ghostInst.length; k++) this.glow.setVisibleAt(rig.ghostInst[k], false);
  }

  private releaseEnemy(e: Enemy): void {
    this.releaseLines(e);
    if (e.sightLine >= 0) this.effects.releaseLine(e.sightLine);
    e.sightLine = -1;
    if (e.diveRing >= 0) this.effects.releaseRing(e.diveRing);
    e.diveRing = -1;
    if (e.rig) {
      this.setRigVisible(e.rig, false);
      e.rig.inUse = false;
    }
    e.rig = null;
    e.active = false;
    e.alive = false;
    e.hit.alive = false;
    e.shieldTarget.alive = false;
    e.wingTargetL.alive = false;
    e.wingTargetR.alive = false;
    e.warning.active = false;
    if (this.hooked === e) this.hooked = null;
  }

  private releaseLines(e: Enemy): void {
    for (let i = 0; i < e.lineCount; i++) {
      // The Veil's sight laser doubles as its telegraph line and survives the attack.
      if (e.lineIds[i] >= 0 && e.lineIds[i] !== e.sightLine) this.effects.releaseLine(e.lineIds[i]);
      e.lineIds[i] = -1;
    }
    e.lineCount = 0;
  }
  // =============================================================================================
  // Fixed step (simulation time: bullet time & hitstop already applied)
  // =============================================================================================
  fixedUpdate(dt: number): void {
    this.simTime += dt;
    this.updatePlayerTarget();
    if (!this.layout) return;
    this.updateWaves(dt);
    for (const e of this.enemies) {
      if (!e.active || !e.alive) continue;
      e.prevPos.copy(e.pos);
      e.prevYaw = e.yaw;
      e.spawnT += dt;
      e.stun = Math.max(0, e.stun - dt);
      e.hitFlash = Math.max(0, e.hitFlash - dt);
      e.shieldFlash = Math.max(0, e.shieldFlash - dt);
      this.stepSprings(e, dt);
      this.perceive(e, dt);
      e.unseenT = e.canSee ? 0 : e.unseenT + dt;
      switch (e.kind) {
        case 'ENFORCER':
          this.thinkEnforcer(e, dt);
          break;
        case 'AEGIS':
          this.thinkAegis(e, dt);
          break;
        case 'VEIL':
          this.thinkVeil(e, dt);
          break;
        case 'PHANTOM':
          this.thinkPhantom(e, dt);
          break;
        case 'DRONE':
          this.thinkDrone(e, dt);
          break;
        case 'VALKYRIE':
          this.thinkBoss(e, dt);
          break;
      }
      if (e.kind !== 'VALKYRIE') this.attackUpdate(e, dt);
      if (e.alive) this.updateHitboxes(e);
    }
    this.updateMissiles(dt);
    this.updateHook();
  }

  private readonly playerChest = new THREE.Vector3();

  private updatePlayerTarget(): void {
    const p = this.player;
    const h = p.isSliding ? PLAYER_SLIDE_H : PLAYER_STAND_H;
    const t = this.playerTarget;
    t.alive = p.isAlive;
    t.bodyHalf.set(PLAYER_R, h / 2, PLAYER_R);
    t.bodyCenter.copy(p.position).setY(p.position.y + h / 2);
    t.bodyYaw = 0;
    this.playerChest.copy(p.position).setY(p.position.y + h * 0.66);
    const g = this.graze;
    g.active = p.isAlive;
    g.a.copy(p.position).setY(p.position.y + 0.15);
    g.b.copy(p.position).setY(p.position.y + h - 0.1);
  }

  private stepSprings(e: Enemy, dt: number): void {
    const k = HUMANOID.FLINCH_SPRING_K;
    const d = HUMANOID.FLINCH_SPRING_D;
    e.flinchVX += (-k * e.flinchX - d * e.flinchVX) * dt;
    e.flinchVZ += (-k * e.flinchZ - d * e.flinchVZ) * dt;
    e.flinchX += e.flinchVX * dt;
    e.flinchZ += e.flinchVZ * dt;
    e.recoilV += (-260 * e.recoil - 22 * e.recoilV) * dt;
    e.recoil += e.recoilV * dt;
  }

  private perceive(e: Enemy, dt: number): void {
    e.losTimer -= dt;
    if (e.losTimer > 0) return;
    e.losTimer = HUMANOID.LOS_INTERVAL_S;
    if (!this.player.isAlive) {
      e.canSee = false;
      return;
    }
    const range = e.isBoss ? VALK_DEF.gun.range : e.def.gun.range;
    // Eyes, not the (possibly lowered) gun: perception from the head / lens.
    _v1.addVectors(e.pos, e.headOff);
    const d = _v1.distanceTo(this.playerChest);
    e.canSee = d <= range && this.physics.lineOfSight(_v1, this.playerChest, 0.9);
  }

  /** Horizontal distance to the player and vertical offset. */
  private distH(e: Enemy): number {
    return Math.hypot(this.player.position.x - e.pos.x, this.player.position.z - e.pos.z);
  }

  private faceYaw(e: Enemy, target: number, degPerS: number, dt: number): void {
    e.yaw = turnToward(e.yaw, target, degPerS * DEG2RAD * dt);
  }

  private yawToPlayer(e: Enemy): number {
    return yawOf(this.player.position.x - e.pos.x, this.player.position.z - e.pos.z);
  }

  // ---------------------------------------------------------------------------------------------
  // Ground locomotion: swept capsule move on the enemy's layer, never walking off ledges.
  // ---------------------------------------------------------------------------------------------
  private walk(e: Enemy, dirX: number, dirZ: number, speed: number, dt: number, edgeGuard = true): void {
    const tx = dirX * speed;
    const tz = dirZ * speed;
    const k = 1 - Math.exp(-10 * dt);
    e.vel.x += (tx - e.vel.x) * k;
    e.vel.z += (tz - e.vel.z) * k;
    const hs = Math.hypot(e.vel.x, e.vel.z);
    if (edgeGuard && hs > 0.2 && e.grounded) {
      _v1.set(e.pos.x + (e.vel.x / hs) * 0.75, e.pos.y + 0.6, e.pos.z + (e.vel.z / hs) * 0.75);
      const gy = this.physics.probeGround(_v1, 0.12, 2.2);
      if (gy === null || gy < e.pos.y - 1.0) {
        e.vel.x = 0;
        e.vel.z = 0;
        e.hasGoal = false;
      }
    }
    e.vel.y = e.grounded ? -2 : e.vel.y + GRAVITY * dt;
    _v2.set(e.vel.x * dt, e.vel.y * dt, e.vel.z * dt);
    this.physics.movePlayer(e.pos, HUMANOID.RADIUS * e.scale, HUMANOID.HEIGHT * e.scale, _v2, e.grounded, _move);
    e.grounded = _move.grounded;
    if (e.grounded) e.vel.y = 0;
    if (_move.hitWall) e.hasGoal = false;
    // Never leave the district.
    const lim = LEVEL.HALF_EXTENT_M - 2;
    e.pos.x = clamp(e.pos.x, -lim, lim);
    e.pos.z = clamp(e.pos.z, -lim, lim);
  }

  /** Separation from other ground enemies (avoid stacking). Adds to the desired direction. */
  private separation(e: Enemy, out: THREE.Vector3): void {
    out.set(0, 0, 0);
    for (const o of this.enemies) {
      if (o === e || !o.alive || o.kind === 'DRONE' || o.kind === 'VALKYRIE') continue;
      const dx = e.pos.x - o.pos.x;
      const dz = e.pos.z - o.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > 2.25 || d2 < 1e-6 || Math.abs(e.pos.y - o.pos.y) > 1.5) continue;
      const d = Math.sqrt(d2);
      out.x += (dx / d) * (1.5 - d);
      out.z += (dz / d) * (1.5 - d);
    }
  }

  private moveToGoal(e: Enemy, speed: number, dt: number): boolean {
    const dx = e.goal.x - e.pos.x;
    const dz = e.goal.z - e.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.35) {
      this.walk(e, 0, 0, 0, dt);
      return true;
    }
    this.separation(e, _v3);
    let ux = dx / d + _v3.x;
    let uz = dz / d + _v3.z;
    const ul = Math.hypot(ux, uz) || 1;
    ux /= ul;
    uz /= ul;
    this.walk(e, ux, uz, Math.min(speed, d * 3), dt);
    return false;
  }

  private canMove(e: Enemy): boolean {
    return e.stun <= 0 && (e.phase === 'IDLE' || e.phase === 'ACQUIRING') && e.spawnT > HUMANOID.SPAWN_MATERIALIZE_S;
  }

  // ---------------------------------------------------------------------------------------------
  // 1. Enforcer — cover to cover
  // ---------------------------------------------------------------------------------------------
  private thinkEnforcer(e: Enemy, dt: number): void {
    e.goalTimer -= dt;
    if (this.canMove(e)) {
      if (!e.hasGoal && e.goalTimer <= 0) {
        // Out of range or out of sight: push toward the player; otherwise hop between cover.
        const far = this.distH(e) > e.def.gun.range * 0.8;
        if ((far || e.unseenT > 2.5) && this.chooseAdvance(e)) e.goalTimer = 0;
        else this.chooseCover(e);
      }
      if (e.hasGoal) {
        if (this.moveToGoal(e, e.def.moveSpeed * (e.phase === 'ACQUIRING' ? 0.45 : 1), dt)) {
          e.hasGoal = false;
          e.goalTimer = 2.5 + this.rng() * 2.5;
        }
      } else this.walk(e, 0, 0, 0, dt);
    } else this.walk(e, 0, 0, 0, dt);
    this.faceForCombat(e, 360, dt);
  }

  private chooseCover(e: Enemy): void {
    const pp = this.player.position;
    let best = -1e9;
    let bi = -1;
    for (let i = 0; i < e.coverCount; i++) {
      const o = i * 6;
      const px = e.cover[o];
      const pz = e.cover[o + 2];
      const tpx = pp.x - px;
      const tpz = pp.z - pz;
      const dp = Math.hypot(tpx, tpz) || 1;
      const tcx = e.cover[o + 3] - px;
      const tcz = e.cover[o + 5] - pz;
      const dc = Math.hypot(tcx, tcz) || 1;
      const coverScore = (tcx * tpx + tcz * tpz) / (dc * dp);
      const rangeScore = dp > 12 && dp < 45 ? 1 : 0;
      const travel = Math.hypot(px - e.pos.x, pz - e.pos.z);
      if (travel < 1) continue;
      const score = coverScore * 2 + rangeScore - travel * 0.04 + this.rng() * 0.8;
      if (score > best) {
        best = score;
        bi = i;
      }
    }
    if (bi >= 0) {
      e.goal.set(e.cover[bi * 6], e.cover[bi * 6 + 1], e.cover[bi * 6 + 2]);
      e.hasGoal = true;
      return;
    }
    // No cover: short reposition around home.
    for (let t = 0; t < 6; t++) {
      const a = this.rng() * Math.PI * 2;
      const r = 3 + this.rng() * 6;
      _v3.set(e.home.x + Math.sin(a) * r, e.layerY + 0.05, e.home.z + Math.cos(a) * r);
      if (!this.physics.boxFree(_v3, HUMANOID.RADIUS + 0.1, HUMANOID.HEIGHT)) continue;
      const gy = this.physics.probeGround(_v4.copy(_v3).setY(e.layerY + 0.6), 0.15, 1.2);
      if (gy === null || Math.abs(gy - e.layerY) > 0.4) continue;
      e.goal.set(_v3.x, gy, _v3.z);
      e.hasGoal = true;
      return;
    }
    e.goalTimer = 1.5;
  }

  /**
   * Picks a reachable point 6–13 m toward the player on the enemy's own layer (clear straight path, ground
   * under it at the same height) and refreshes nearby cover candidates around it.
   */
  private chooseAdvance(e: Enemy): boolean {
    const base = this.yawToPlayer(e);
    const r = HUMANOID.RADIUS * e.scale + 0.1;
    const h = HUMANOID.HEIGHT * e.scale;
    for (let t = 0; t < 12; t++) {
      const off = (t % 2 ? 1 : -1) * Math.ceil(t / 2) * 0.32;
      const dist = t < 6 ? 12 : 7;
      const a = base + off;
      _v3.set(e.pos.x + Math.sin(a) * dist, e.pos.y + 0.05, e.pos.z + Math.cos(a) * dist);
      if (Math.abs(_v3.x) > LEVEL.HALF_EXTENT_M - 3 || Math.abs(_v3.z) > LEVEL.HALF_EXTENT_M - 3) continue;
      if (!this.physics.boxFree(_v3, r, h)) continue;
      const gy = this.physics.probeGround(_v4.copy(_v3).setY(e.pos.y + 0.6), 0.15, 1.4);
      if (gy === null || Math.abs(gy - e.pos.y) > 0.5) continue;
      _v1.copy(e.pos).setY(e.pos.y + 1.0);
      _v2.copy(_v3).setY(gy + 1.0);
      this.physics.segmentCast(_v1, _v2, _rayHit);
      if (_rayHit.hit) continue;
      e.goal.set(_v3.x, gy, _v3.z);
      e.hasGoal = true;
      e.home.copy(e.goal);
      e.layerY = gy;
      this.buildCover(e);
      return true;
    }
    return false;
  }

  /** Faces the player while engaged / telegraphing, else the walking direction. */
  private faceForCombat(e: Enemy, degPerS: number, dt: number): void {
    if (e.phase !== 'IDLE' || e.canSee) this.faceYaw(e, yawOf(e.aimDir.x, e.aimDir.z), degPerS, dt);
    else if (Math.hypot(e.vel.x, e.vel.z) > 0.5) this.faceYaw(e, yawOf(e.vel.x, e.vel.z), degPerS, dt);
  }

  // ---------------------------------------------------------------------------------------------
  // 2. Aegis Breacher — advance to mid range behind the shield, turning slowly (flank it)
  // ---------------------------------------------------------------------------------------------
  private thinkAegis(e: Enemy, dt: number): void {
    const d = this.distH(e);
    if (this.canMove(e)) {
      const yawP = this.yawToPlayer(e);
      const fx = Math.sin(yawP);
      const fz = Math.cos(yawP);
      const speed = e.def.moveSpeed * (e.phase === 'ACQUIRING' ? 0.5 : 1);
      this.separation(e, _v3);
      e.goalTimer -= dt;
      if ((d > 26 || e.unseenT > 3) && !e.hasGoal && e.goalTimer <= 0) {
        if (!this.chooseAdvance(e)) e.goalTimer = 1.5;
      }
      if (e.hasGoal && (d > 22 || e.unseenT > 3)) {
        if (this.moveToGoal(e, speed, dt)) e.hasGoal = false;
      } else if (d > 26) this.walk(e, fx + _v3.x, fz + _v3.z, speed, dt);
      else if (d < 10) this.walk(e, -fx + _v3.x, -fz + _v3.z, speed * 0.6, dt);
      else this.walk(e, _v3.x, _v3.z, _v3.lengthSq() > 0 ? 1.5 : 0, dt);
    } else this.walk(e, 0, 0, 0, dt);
    // The shield arm tracks the player at a limited body turn rate.
    if (e.stun <= 0) this.faceYaw(e, this.yawToPlayer(e), AEGIS_SHIELD.TURN_DEG_PER_S, dt);
    e.crouch += ((e.shieldHp > 0 ? 0.18 : 0.05) - e.crouch) * Math.min(1, dt * 6);
  }

  // ---------------------------------------------------------------------------------------------
  // 3. Veil Sniper — perch, always-visible laser, backstep when approached
  // ---------------------------------------------------------------------------------------------
  private thinkVeil(e: Enemy, dt: number): void {
    // No sight line from this perch for 3 s: relocate along the roof edge to a vantage point that sees the player.
    e.goalTimer -= dt;
    if (e.unseenT > 3 && e.goalTimer <= 0 && e.phase === 'IDLE') {
      e.goalTimer = 3;
      this.chooseVantage(e);
    }
    const d = this.distH(e);
    const dy = Math.abs(this.player.position.y - e.pos.y);
    if (this.canMove(e) && d < VEIL_BEHAVIOUR.BACKSTEP_RADIUS && dy < 4) {
      const yawP = this.yawToPlayer(e);
      this.walk(e, -Math.sin(yawP), -Math.cos(yawP), e.def.moveSpeed, dt);
    } else if (this.canMove(e) && Math.hypot(e.home.x - e.pos.x, e.home.z - e.pos.z) > 0.8 && d > VEIL_BEHAVIOUR.BACKSTEP_RADIUS + 4) {
      e.goal.copy(e.home);
      if (this.moveToGoal(e, e.def.moveSpeed * (e.hasGoal ? 1 : 0.6), dt)) e.hasGoal = false;
    } else this.walk(e, 0, 0, 0, dt);
    this.faceYaw(e, yawOf(e.aimDir.x, e.aimDir.z), 120, dt);
    // Kneel while telegraphing.
    const target = e.phase === 'ACQUIRING' || e.phase === 'LOCK' || e.phase === 'FIRING' ? 0.42 : 0;
    e.crouch += (target - e.crouch) * Math.min(1, dt * 7);
    if (e.sightLine < 0) e.sightLine = this.effects.acquireLine();
  }

  /** Veil: picks the nearest roof-perimeter point (1 m inset) with line of sight to the player. */
  private chooseVantage(e: Enemy): void {
    const L = this.layout;
    if (!L || e.building < 0) return;
    const b = L.buildings[e.building];
    if (!b || b.index !== e.building) return;
    let best = Infinity;
    let found = false;
    for (let k = 0; k < ROOF_VANTAGE.length; k += 2) {
      const x = b.cx + ROOF_VANTAGE[k] * (b.halfW - 1.0);
      const z = b.cz + ROOF_VANTAGE[k + 1] * (b.halfD - 1.0);
      _v3.set(x, b.roofY + HUMANOID.HEAD_CENTER_Y, z);
      if (!this.physics.lineOfSight(_v3, this.playerChest, 0.9)) continue;
      const travel = Math.hypot(x - e.pos.x, z - e.pos.z);
      if (travel < best) {
        best = travel;
        e.home.set(x, b.roofY, z);
        found = true;
      }
    }
    if (found) e.hasGoal = true;
  }

  // ---------------------------------------------------------------------------------------------
  // 4. Phantom — chase, 10 m blinks (32 m/s, purple afterimages, 0.45 s landing stiffness), dash slash
  // ---------------------------------------------------------------------------------------------
  private thinkPhantom(e: Enemy, dt: number): void {
    const PB = PHANTOM_BEHAVIOUR;
    e.blinkCd -= dt;
    e.slashCd -= dt;
    if (e.blinking) {
      e.blinkT += dt;
      const t = Math.min(1, e.blinkT / e.blinkDur);
      e.pos.lerpVectors(e.blinkFrom, e.blinkTo, t);
      e.vel.subVectors(e.blinkTo, e.blinkFrom).multiplyScalar(1 / e.blinkDur);
      if (t >= 1) {
        e.blinking = false;
        e.recoverT = PB.BLINK_RECOVERY_S;
        e.vel.set(0, 0, 0);
        e.grounded = true;
      }
      return;
    }
    if (e.recoverT > 0) {
      e.recoverT -= dt;
      this.walk(e, 0, 0, 0, dt);
      return;
    }
    const d = this.distH(e);
    const dy = this.player.position.y - e.pos.y;
    const yawP = this.yawToPlayer(e);
    // Dash slash: 350 ms blade glow, then a lunge along the locked direction.
    if (e.slash === 'GLOW') {
      e.slashT += dt;
      this.walk(e, 0, 0, 0, dt);
      this.faceYaw(e, yawP, 540, dt);
      if (e.slashT >= PB.SLASH_GLOW_MS / 1000) {
        e.slash = 'LUNGE';
        e.slashT = 0;
        e.slashHit = false;
        e.slashDir.set(Math.sin(e.yaw), 0, Math.cos(e.yaw));
      }
      return;
    }
    if (e.slash === 'LUNGE') {
      e.slashT += dt;
      this.walk(e, e.slashDir.x, e.slashDir.z, PB.SLASH_LUNGE_SPEED, dt);
      e.vel.x = e.slashDir.x * PB.SLASH_LUNGE_SPEED;
      e.vel.z = e.slashDir.z * PB.SLASH_LUNGE_SPEED;
      _v1.copy(e.pos).setY(e.pos.y + 1.1);
      if (!e.slashHit && this.player.isAlive && _v1.distanceTo(this.playerChest) <= PB.SLASH_HIT_RADIUS) {
        e.slashHit = true;
        this.effects.burst(this.playerChest, _v2.copy(e.slashDir), BURST.SLASH);
        this.damagePlayer(PB.SLASH_DAMAGE, e.pos, CAUSE_PHANTOM_SLASH);
      }
      if (e.slashT >= PB.SLASH_LUNGE_TIME_S) {
        e.slash = 'COOL';
        e.slashCd = PB.SLASH_COOLDOWN_S;
      }
      return;
    }
    if (e.slash === 'COOL' && e.slashCd <= 0) e.slash = 'NONE';
    if (e.stun > 0 || e.spawnT < HUMANOID.SPAWN_MATERIALIZE_S) {
      this.walk(e, 0, 0, 0, dt);
      return;
    }
    if (e.phase === 'IDLE' && e.slash === 'NONE' && d <= PB.SLASH_RANGE && Math.abs(dy) < 2.5 && this.player.isAlive) {
      e.slash = 'GLOW';
      e.slashT = 0;
      return;
    }
    if (e.phase === 'IDLE' && e.blinkCd <= 0 && (d > 16 || (d < 8 && this.rng() < 0.02) || (!e.canSee && this.rng() < 0.05))) {
      if (this.tryBlink(e, d > 16 ? 0 : 1)) return;
    }
    this.separation(e, _v3);
    const fx = Math.sin(yawP);
    const fz = Math.cos(yawP);
    if (d > 9) this.walk(e, fx + _v3.x, fz + _v3.z, e.def.moveSpeed * (e.phase === 'ACQUIRING' ? 0.5 : 1), dt);
    else this.walk(e, fz * e.orbitDir + _v3.x, -fx * e.orbitDir + _v3.z, e.def.moveSpeed * 0.45, dt);
    if (_move.hitWall) e.orbitDir = -e.orbitDir;
    this.faceForCombat(e, 540, dt);
  }

  /** Blink 10 m toward (mode 0) or around (mode 1) the player. Path and landing are validated. */
  private tryBlink(e: Enemy, mode: number): boolean {
    const PB = PHANTOM_BEHAVIOUR;
    const pp = this.player.position;
    const base = yawOf(pp.x - e.pos.x, pp.z - e.pos.z);
    for (let t = 0; t < 8; t++) {
      const off = mode === 0 ? (t % 2 ? 1 : -1) * Math.ceil(t / 2) * 0.35 : (t % 2 ? 1 : -1) * (Math.PI / 2 + Math.ceil(t / 2) * 0.3);
      const a = base + off;
      _v3.set(e.pos.x + Math.sin(a) * PB.BLINK_DISTANCE, Math.max(e.pos.y, pp.y) + 3, e.pos.z + Math.cos(a) * PB.BLINK_DISTANCE);
      if (Math.abs(_v3.x) > LEVEL.HALF_EXTENT_M - 3 || Math.abs(_v3.z) > LEVEL.HALF_EXTENT_M - 3) continue;
      const gy = this.physics.probeGround(_v3, 0.3, 22);
      if (gy === null || gy < e.pos.y - 12 || gy > e.pos.y + 12) continue;
      _v3.y = gy;
      if (!this.physics.boxFree(_v3, HUMANOID.RADIUS, HUMANOID.HEIGHT)) continue;
      _v1.copy(e.pos).setY(e.pos.y + 1.0);
      _v2.copy(_v3).setY(_v3.y + 1.0);
      this.physics.segmentCast(_v1, _v2, _rayHit);
      if (_rayHit.hit) continue;
      e.blinking = true;
      e.blinkT = 0;
      e.blinkFrom.copy(e.pos);
      e.blinkTo.copy(_v3);
      e.blinkDur = e.blinkFrom.distanceTo(e.blinkTo) / PB.BLINK_SPEED;
      e.blinkCd = PB.BLINK_COOLDOWN_S;
      e.ghostTimer = 0;
      this.cancelAttack(e, 0.3);
      this.effects.burst(_v1, UP, BURST.GLITCH, PB.GHOST_COLOR);
      return true;
    }
    e.blinkCd = 0.5;
    return false;
  }

  // ---------------------------------------------------------------------------------------------
  // 5. Hunter Drone — 3D orbit at 6–22 m, leads the player's trajectory
  // ---------------------------------------------------------------------------------------------
  private thinkDrone(e: Enemy, dt: number): void {
    const DB = DRONE_BEHAVIOUR;
    e.retargetT -= dt;
    if (e.retargetT <= 0) {
      e.retargetT = 2.5 + this.rng() * 2.5;
      e.orbitR = DB.ORBIT_RADIUS_MIN + this.rng() * (DB.ORBIT_RADIUS_MAX - DB.ORBIT_RADIUS_MIN);
      e.altitude = DB.ALT_MIN + this.rng() * (DB.ALT_MAX - DB.ALT_MIN);
      if (!e.canSee) e.orbitDir = -e.orbitDir;
    }
    const speed = e.def.moveSpeed;
    const pp = this.player.position;
    if (e.stun <= 0 && e.phase !== 'LOCK' && e.phase !== 'FIRING') e.orbitAngle += (e.orbitDir * speed * 0.55 * dt) / e.orbitR;
    _v1.set(pp.x + Math.sin(e.orbitAngle) * e.orbitR, e.altitude, pp.z + Math.cos(e.orbitAngle) * e.orbitR);
    _v1.x = clamp(_v1.x, -LEVEL.HALF_EXTENT_M + 4, LEVEL.HALF_EXTENT_M - 4);
    _v1.z = clamp(_v1.z, -LEVEL.HALF_EXTENT_M + 4, LEVEL.HALF_EXTENT_M - 4);
    _v2.subVectors(_v1, e.pos);
    const dist = _v2.length();
    const hold = e.stun > 0 || e.phase === 'LOCK' || e.phase === 'FIRING' || e.spawnT < HUMANOID.SPAWN_MATERIALIZE_S;
    const want = hold ? 0 : Math.min(speed, dist * 1.4);
    if (dist > 1e-4) _v2.multiplyScalar(want / dist);
    else _v2.set(0, 0, 0);
    _v3.subVectors(_v2, e.vel);
    const maxDv = DB.ACCEL * dt;
    if (_v3.length() > maxDv) _v3.setLength(maxDv);
    e.vel.add(_v3);
    _v4.copy(e.vel).multiplyScalar(dt);
    // Swept box for the hull (centre-based position → feet-based query).
    e.pos.y -= 0.25;
    this.physics.movePlayer(e.pos, 0.5, 0.5, _v4, false, _move);
    e.pos.y += 0.25;
    if (_move.hitWall) {
      e.orbitDir = -e.orbitDir;
      e.vel.multiplyScalar(0.4);
    }
    if (_move.grounded || _move.hitCeiling) e.altitude = clamp(e.altitude + (_move.grounded ? 4 : -4), DB.ALT_MIN, DB.ALT_MAX);
    e.pos.y = clamp(e.pos.y, DB.ALT_MIN - 1, DB.ALT_MAX + 1);
    this.faceYaw(e, yawOf(e.aimDir.x, e.aimDir.z), 300, dt);
  }

  // ---------------------------------------------------------------------------------------------
  // Shared telegraph state machine: IDLE → ACQUIRING → LOCK_TELEGRAPH → FIRE
  // ---------------------------------------------------------------------------------------------
  /** Point the aim tracks: the player's chest, led by velocity for predictive shooters. */
  private aimPoint(e: Enemy, out: THREE.Vector3): THREE.Vector3 {
    out.copy(this.playerChest);
    if (e.pattern.predictive) {
      const t = Math.min(1.2, e.muzzle.distanceTo(out) / e.pattern.spec.speed);
      out.addScaledVector(this.player.velocity, t);
    }
    return out;
  }

  private trackAim(e: Enemy, dt: number, rate: number): void {
    this.aimPoint(e, _v1);
    _v2.subVectors(_v1, e.muzzle);
    if (_v2.lengthSq() < 1e-6) return;
    _v2.normalize();
    rotateToward(e.aimDir, _v2, rate * dt);
  }

  private attackReady(e: Enemy): boolean {
    if (e.stun > 0 || e.spawnT < HUMANOID.SPAWN_GRACE_S || !e.canSee || !this.player.isAlive) return false;
    if (e.kind === 'PHANTOM') {
      if (e.blinking || e.recoverT > 0 || e.slash !== 'NONE') return false;
      if (this.distH(e) < PHANTOM_BEHAVIOUR.SLASH_RANGE) return false;
    }
    return true;
  }

  /** Starts ACQUIRING with `pattern`; requires a free telegraph line for every line of the pattern. */
  private startAttack(e: Enemy, pattern: Pattern): boolean {
    let need = pattern.lines;
    const useSight = e.sightLine >= 0;
    if (useSight) need--;
    if (this.effects.freeLines < need) return false;
    e.pattern = pattern;
    e.lineCount = 0;
    for (let i = 0; i < pattern.lines; i++) {
      e.lineIds[i] = i === 0 && useSight ? e.sightLine : this.effects.acquireLine();
      e.lineCount++;
    }
    e.phase = 'ACQUIRING';
    e.phaseT = 0;
    e.lostT = 0;
    e.acquireS = pattern.acquireMs / 1000;
    e.lockS = scaledLockMs(pattern.lockMs, this.loop, this.modifiers.lockTimeReduction) / 1000;
    return true;
  }

  /** Cancels a telegraph (LOS lost, stun, blink, SK_08 shock). */
  cancelAttack(e: Enemy, cooldown: number): void {
    if (e.phase === 'IDLE') return;
    this.releaseLines(e);
    e.phase = 'IDLE';
    e.phaseT = 0;
    e.cooldown = Math.max(e.cooldown, cooldown);
    e.warning.active = false;
    if (e.isBoss) this.onBossAttackDone(e, true);
  }

  /** Direction of telegraph line `i` from `origin` (fan around the aim, or converging pods). */
  private lineDir(e: Enemy, i: number, origin: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const p = e.pattern;
    if (p.fromPods) {
      const dist = e.muzzle.distanceTo(this.playerChest);
      _v5.copy(e.aimDir).multiplyScalar(dist).add(e.muzzle);
      return out.subVectors(_v5, origin).normalize();
    }
    out.copy(e.aimDir);
    if (p.lines > 1 && p.fanStepDeg !== 0) out.applyAxisAngle(UP, (i - (p.lines - 1) / 2) * p.fanStepDeg * DEG2RAD);
    return out;
  }

  private lineOrigin(e: Enemy, i: number, out: THREE.Vector3): THREE.Vector3 {
    if (e.pattern.fromPods && i < 4) return readV(e.pods, i, out);
    return out.copy(e.muzzle);
  }

  private attackUpdate(e: Enemy, dt: number): void {
    const p = e.pattern;
    if (e.phase === 'IDLE') {
      e.warning.active = false;
      if (e.canSee || e.aimBlend > 0) this.trackAim(e, dt, p.trackRadPerS);
      e.cooldown -= dt;
      // The boss chooses its own patterns (thinkBoss); everyone else re-arms its gun pattern.
      if (!e.isBoss && e.cooldown <= 0 && this.attackReady(e)) this.startAttack(e, PATTERNS[e.kind as Exclude<EnemyKind, 'VALKYRIE'>]);
      return;
    }
    e.phaseT += dt;
    if (e.stun > 0) {
      this.cancelAttack(e, 0.6);
      return;
    }
    if (e.phase === 'ACQUIRING') {
      if (!e.canSee) {
        e.lostT += dt;
        if (e.lostT > HUMANOID.LOS_GRACE_S) {
          this.cancelAttack(e, 0.5);
          return;
        }
      } else e.lostT = 0;
      this.trackAim(e, dt, p.trackRadPerS);
      if (e.phaseT >= e.acquireS) this.enterLock(e);
      return;
    }
    if (e.phase === 'LOCK') {
      if (e.phaseT >= e.lockS) {
        e.phase = 'FIRING';
        e.phaseT = 0;
        e.shotIndex = 0;
        e.shotTimer = 0;
      } else return;
    }
    // FIRING
    e.shotTimer -= dt;
    const total = p.sequentialLines ? p.lines * p.rounds : p.rounds;
    while (e.shotTimer <= 0 && e.shotIndex < total) {
      if (p.sequentialLines) this.fireLine(e, e.shotIndex % p.lines);
      else for (let i = 0; i < p.lines; i++) this.fireLine(e, i);
      e.shotIndex++;
      e.shotTimer = p.roundIntervalS > 0 ? e.shotTimer + p.roundIntervalS : 0;
    }
    if (e.shotIndex >= total) {
      this.releaseLines(e);
      e.phase = 'IDLE';
      e.phaseT = 0;
      e.cooldown = p.cooldownS;
      e.warning.active = false;
      if (e.isBoss) this.onBossAttackDone(e, false);
    }
  }

  /** ACQUIRING → LOCK: freeze every line's origin, direction and end point (§5.1-2). */
  private enterLock(e: Enemy): void {
    e.phase = 'LOCK';
    e.phaseT = 0;
    const range = e.pattern.spec.range;
    for (let i = 0; i < e.lineCount; i++) {
      this.lineOrigin(e, i, _v1);
      this.lineDir(e, i, _v1, _v2);
      writeV(e.lockO, i, _v1);
      writeV(e.lockD, i, _v2);
      this.physics.raycast(_v1, _v2, range, _rayHit, LINE_IGNORE_NONE);
      _v3.copy(_v2).multiplyScalar(_rayHit.hit ? _rayHit.distance : range).add(_v1);
      writeV(e.lockE, i, _v3);
    }
    e.warning.position.copy(e.muzzle);
    e.warning.active = true;
    this.events.onLockStart?.(e.kind, e.muzzle, e.lockS, e.pattern.spec.damage >= PLAYER.DAMAGE_SNIPER);
  }

  private fireLine(e: Enemy, i: number): void {
    readV(e.lockO, i, _v1);
    readV(e.lockD, i, _v2);
    if (e.pattern.kind === 'MISSILE') this.launchMissile(_v1, _v2);
    else this.effects.spawnProjectile(_v1, _v2, e.pattern.spec);
    e.recoilV += e.isBoss ? 4 : 7;
    this.renderer.flashLight(_v1, e.pattern.spec.color, e.pattern.spec.damage >= 100 ? 10 : 6, 12, 0.05);
    this.events.onEnemyFire?.(e.kind, _v1, e.pattern.spec.damage >= PLAYER.DAMAGE_SNIPER);
  }

  /** What last hurt the player (death read-out, 5A-5). */
  lastHitCause = '';

  private damagePlayer(amount: number, from: THREE.Vector3, cause: string): void {
    if (!this.player.isAlive) return;
    this.lastHitCause = cause;
    this.player.takeDamage(amount);
    this.events.onPlayerHit?.(amount, from);
  }

  private onGraze(point: THREE.Vector3, direction: THREE.Vector3, distance: number): void {
    void distance;
    this.player.addBulletTimeGauge(BULLET_TIME.BONUS_GRAZE + this.modifiers.grazeBtBonus);
    this.player.addTrauma(SHAKE.GRAZE);
    this.effects.burst(point, direction, BURST.GRAZE);
    this.events.onGraze?.(point);
  }

  /** Keeps a strand that bit into an enemy attached to it (the anchor follows the body). */
  private updateHook(): void {
    const e = this.hooked;
    if (!e) return;
    if (!this.player.ropeAttached) {
      this.hooked = null;
      return;
    }
    if (!e.alive) {
      this.hooked = null;
      this.player.detachRope('CUT');
      return;
    }
    this.player.ropeAnchor.copy(e.pos).add(this.hookOffset);
  }

  /** Strand attached somewhere else / released: stop following. */
  onRopeChanged(): void {
    this.hooked = null;
  }
  // =============================================================================================
  // 6. VALKYRIE-09
  // =============================================================================================
  private thinkBoss(e: Enemy, dt: number): void {
    e.bossT += dt;
    // Phase 2 at HP < 50 %: crimson wings, summons, dive slash and micro-missiles join the cycle.
    if (e.bossPhase === 1 && e.hp <= e.maxHp * VB.PHASE2_HP_RATIO && e.bossMode !== 'FALLING' && e.bossMode !== 'DOWNED') {
      e.bossPhase = 2;
      this.abortBossAction(e);
      e.bossMode = 'PHASE_SHIFT';
      e.bossT = 0;
      e.cycleIndex = 0;
      this.events.onBossPhase?.(2);
      const summons = this.layout?.sector.bossSummons;
      if (summons) for (const k of ROSTER_ORDER) if (summons[k]) this.summon(k, summons[k] ?? 0);
      this.effects.spawnRing(_v1.copy(e.pos).setY(e.pos.y + 1.4 * e.scale), UP, VB.WING_COLOR_P2, 4, 0.5, 14, 0.6);
    }
    const yawP = this.yawToPlayer(e);
    switch (e.bossMode) {
      case 'INTRO': {
        const t = Math.min(1, e.bossT / VB.INTRO_S);
        e.pos.y = 2 + (30 - 2) * (1 - (1 - t) * (1 - t));
        this.faceYaw(e, yawP, 180, dt);
        this.trackAim(e, dt, 2);
        if (t >= 1) this.beginRelocate(e);
        break;
      }
      case 'RELOCATE':
        this.flyWaypoints(e, dt);
        this.trackAim(e, dt, 2);
        break;
      case 'HOVER':
        e.pos.y = e.hoverBaseY + Math.sin(this.simTime * 1.6) * 0.35;
        this.faceYaw(e, yawOf(e.aimDir.x, e.aimDir.z), 240, dt);
        e.lean += (0 - e.lean) * Math.min(1, dt * 4);
        e.actionT -= dt;
        if (e.phase === 'IDLE' && e.actionT <= 0) {
          if (e.nextAction === 'ATTACK') {
            if (!this.startBossAttack(e)) e.actionT = 0.25;
          } else if (e.nextAction === 'SNIPE_AGAIN') {
            if (this.startAttack(e, PATTERNS.BOSS_SNIPE)) e.currentAttack = 'SNIPE';
            else e.actionT = 0.2;
          } else this.beginRelocate(e);
        }
        this.attackUpdate(e, dt);
        break;
      case 'PHASE_SHIFT':
        e.pos.y += (e.hoverBaseY + 3 - e.pos.y) * Math.min(1, dt * 2);
        this.faceYaw(e, yawP, 120, dt);
        if (e.bossT >= VB.PHASE_SHIFT_S) this.beginRelocate(e);
        break;
      case 'DIVE_ACQ':
      case 'DIVE_LOCK':
        this.updateDiveTelegraph(e, dt);
        break;
      case 'DIVING':
        this.updateDive(e, dt);
        break;
      case 'DIVE_GROUND':
        e.crouch += (0.5 - e.crouch) * Math.min(1, dt * 8);
        if (e.bossT >= VB.DIVE.groundTimeS) this.beginRecover(e);
        break;
      case 'FALLING':
        e.vel.y += GRAVITY * dt;
        e.pos.y += e.vel.y * dt;
        if (e.pos.y <= e.groundY) {
          e.pos.y = e.groundY;
          e.vel.set(0, 0, 0);
          e.bossMode = 'DOWNED';
          e.bossT = 0;
          this.effects.spawnRing(_v1.copy(e.pos).setY(e.pos.y + 0.1), UP, 0xffffff, 2.5, 0.5, 6, 0.4);
          this.effects.burst(e.pos, UP, BURST.SPARK);
          this.player.addTrauma(SHAKE.HARD_LANDING);
        }
        break;
      case 'DOWNED':
        e.crouch += (0.75 - e.crouch) * Math.min(1, dt * 8);
        if (e.bossT >= VB.DOWN_S) this.beginRecover(e);
        break;
      case 'RECOVER':
        e.crouch += (0 - e.crouch) * Math.min(1, dt * 6);
        e.pos.y += 7 * dt;
        this.faceYaw(e, yawP, 180, dt);
        if (e.bossT >= VB.RECOVER_S) this.beginRelocate(e);
        break;
    }
    this.updateShock(e, dt);
  }

  private startBossAttack(e: Enemy): boolean {
    const cycle = e.bossPhase === 1 ? BOSS_CYCLE_P1 : BOSS_CYCLE_P2;
    const atk = cycle[e.cycleIndex % cycle.length];
    if (atk === 'DIVE') {
      if (!this.beginDive(e)) return false;
      e.cycleIndex++;
      e.currentAttack = 'DIVE';
      return true;
    }
    const pattern = atk === 'SNIPE' ? PATTERNS.BOSS_SNIPE : atk === 'SWEEP' ? PATTERNS.BOSS_SWEEP : PATTERNS.BOSS_MISSILES;
    if (!e.canSee) {
      // No line of sight from this perch: relocate instead of waiting.
      e.nextAction = 'RELOCATE';
      return true;
    }
    if (!this.startAttack(e, pattern)) return false;
    e.cycleIndex++;
    e.currentAttack = atk;
    if (atk === 'SNIPE') e.snipesLeft = VB.SNIPE.count;
    return true;
  }

  private onBossAttackDone(e: Enemy, cancelled: boolean): void {
    if (!cancelled && e.currentAttack === 'SNIPE' && --e.snipesLeft > 0) {
      e.nextAction = 'SNIPE_AGAIN';
      e.actionT = 0.25;
    } else {
      e.nextAction = 'RELOCATE';
      e.actionT = cancelled ? 0.2 : 0.5;
    }
  }

  /** Cancels any telegraph / dive in progress (phase shift, wing break, death). */
  private abortBossAction(e: Enemy): void {
    this.cancelAttack(e, 0);
    this.releaseLines(e);
    if (e.diveRing >= 0) this.effects.releaseRing(e.diveRing);
    e.diveRing = -1;
    e.warning.active = false;
  }

  private beginRelocate(e: Enemy): void {
    const n = this.perches.length;
    if (n === 0) {
      e.bossMode = 'HOVER';
      e.hoverBaseY = e.pos.y;
      e.nextAction = 'ATTACK';
      e.actionT = 0.4;
      return;
    }
    let pick = -1;
    const chest = this.playerChest;
    for (let t = 0; t < 10 && pick < 0; t++) {
      const i = Math.floor(this.rng() * n);
      if (i === e.perch) continue;
      const p = this.perches[i];
      const d = p.distanceTo(chest);
      if (d < 25 || d > 95) continue;
      _v1.copy(p).setY(p.y + 2.3 * e.scale);
      if (this.physics.lineOfSight(_v1, chest, 0.9)) pick = i;
    }
    if (pick < 0) {
      let best = Infinity;
      for (let i = 0; i < n; i++) {
        if (i === e.perch) continue;
        const d = Math.abs(this.perches[i].distanceTo(chest) - 45);
        if (d < best) {
          best = d;
          pick = i;
        }
      }
    }
    e.perch = pick;
    const target = this.perches[pick];
    // Direct line if clear, otherwise climb to cruise altitude above the 95 m skyline.
    _v1.copy(e.pos).setY(e.pos.y + 1.5);
    _v2.copy(target).setY(target.y + 1.5);
    this.physics.segmentCast(_v1, _v2, _rayHit);
    e.wayCount = 0;
    e.wayIndex = 0;
    if (_rayHit.hit) {
      _v3.set(e.pos.x, VB.CRUISE_Y, e.pos.z);
      writeV(e.way, e.wayCount++, _v3);
      _v3.set(target.x, VB.CRUISE_Y, target.z);
      writeV(e.way, e.wayCount++, _v3);
    }
    writeV(e.way, e.wayCount++, target);
    e.bossMode = 'RELOCATE';
    e.bossT = 0;
  }

  private flyWaypoints(e: Enemy, dt: number): void {
    readV(e.way, e.wayIndex, _v1);
    _v2.subVectors(_v1, e.pos);
    const dist = _v2.length();
    const step = VB.FLIGHT_SPEED * dt;
    if (dist <= step) {
      e.pos.copy(_v1);
      e.wayIndex++;
      if (e.wayIndex >= e.wayCount) {
        e.bossMode = 'HOVER';
        e.bossT = 0;
        e.hoverBaseY = e.pos.y;
        e.vel.set(0, 0, 0);
        e.nextAction = 'ATTACK';
        e.actionT = 0.35;
      }
      return;
    }
    _v2.multiplyScalar(1 / dist);
    e.pos.addScaledVector(_v2, step);
    e.vel.copy(_v2).multiplyScalar(VB.FLIGHT_SPEED);
    if (Math.hypot(_v2.x, _v2.z) > 0.3) this.faceYaw(e, yawOf(_v2.x, _v2.z), 260, dt);
    e.lean += (1 - e.lean) * Math.min(1, dt * 4);
  }

  // ---- Dive slash: ground prediction circle (700 ms track / 220 ms lock) → 60 m/s dive → shockwave ----
  private beginDive(e: Enemy): boolean {
    if (!this.player.isAlive || this.effects.freeLines < 1) return false;
    const ring = this.effects.acquireRing();
    if (ring < 0) return false;
    e.diveRing = ring;
    e.lineIds[0] = this.effects.acquireLine();
    e.lineCount = 1;
    e.bossMode = 'DIVE_ACQ';
    e.bossT = 0;
    e.acquireS = VB.DIVE.telegraph.acquireMs / 1000;
    e.lockS = scaledLockMs(VB.DIVE.telegraph.lockMs, this.loop, this.modifiers.lockTimeReduction) / 1000;
    return true;
  }

  private groundBelowPlayer(out: THREE.Vector3): THREE.Vector3 {
    this.physics.raycast(this.playerChest, DOWN, 120, _rayHit);
    if (_rayHit.hit) out.copy(_rayHit.point);
    else out.copy(this.player.position);
    return out;
  }

  private updateDiveTelegraph(e: Enemy, dt: number): void {
    if (e.bossMode === 'DIVE_ACQ') {
      this.groundBelowPlayer(e.diveTarget);
      const targetY = Math.max(e.hoverBaseY, e.diveTarget.y + 16);
      e.pos.y += (targetY - e.pos.y) * Math.min(1, dt * 2.5);
      if (e.bossT >= e.acquireS) {
        e.bossMode = 'DIVE_LOCK';
        e.bossT = 0;
        e.warning.position.copy(e.pos).setY(e.pos.y + 1.4 * e.scale);
        e.warning.active = true;
        this.events.onLockStart?.(e.kind, e.warning.position, e.lockS, false);
      }
    } else if (e.bossT >= e.lockS) {
      this.releaseLines(e);
      e.bossMode = 'DIVING';
      e.bossT = 0;
      e.warning.active = false;
      this.events.onEnemyFire?.(e.kind, e.pos, false);
    }
    this.faceYaw(e, yawOf(e.diveTarget.x - e.pos.x, e.diveTarget.z - e.pos.z), 300, dt);
  }

  private updateDive(e: Enemy, dt: number): void {
    _v1.subVectors(e.diveTarget, e.pos);
    const dist = _v1.length();
    const step = VB.DIVE.speed * dt;
    e.lean += (1.6 - e.lean) * Math.min(1, dt * 8);
    if (dist <= step) {
      e.pos.copy(e.diveTarget);
      this.diveImpact(e);
      return;
    }
    _v1.multiplyScalar(1 / dist);
    _v2.copy(e.pos).setY(e.pos.y + 0.6);
    _v3.copy(_v2).addScaledVector(_v1, step);
    this.physics.segmentCast(_v2, _v3, _rayHit);
    if (_rayHit.hit) {
      // Struck a structure first (e.g. the expressway deck above the player): shock lands there.
      e.pos.copy(_rayHit.point);
      if (_rayHit.normal.y > 0.5) e.pos.y = _rayHit.point.y;
      this.diveImpact(e);
      return;
    }
    e.pos.addScaledVector(_v1, step);
    e.vel.copy(_v1).multiplyScalar(VB.DIVE.speed);
  }

  private diveImpact(e: Enemy): void {
    if (e.diveRing >= 0) this.effects.releaseRing(e.diveRing);
    e.diveRing = -1;
    e.vel.set(0, 0, 0);
    e.shockCenter.copy(e.pos);
    e.shockT = 0;
    e.shockHit = false;
    _v1.copy(e.pos).setY(e.pos.y + 0.12);
    this.effects.spawnRing(_v1, UP, 0xff3060, 5, 0.6, VB.DIVE.shockRadius, VB.DIVE.shockDurationS);
    this.effects.spawnRing(_v1, UP, 0xffffff, 3, 0.3, VB.DIVE.shockRadius * 0.6, VB.DIVE.shockDurationS * 0.7);
    this.effects.burst(_v1, UP, BURST.EXPLOSION, 0xff3060);
    this.renderer.flashLight(_v1, 0xff3060, 24, 22, 0.25);
    const d = this.player.position.distanceTo(e.pos);
    if (d < 30) this.player.addTrauma({ trauma: 0.5 * (1 - d / 30), maxPitchYawDeg: 2.2, maxRollDeg: 1.8 });
    this.events.onExplosion?.(e.pos);
    e.bossMode = 'DIVE_GROUND';
    e.bossT = 0;
  }

  /** Shockwave front: 65 damage once when it sweeps past the player (within ±2.5 m height). */
  private updateShock(e: Enemy, dt: number): void {
    if (e.shockT < 0) return;
    e.shockT += dt;
    const t = Math.min(1, e.shockT / VB.DIVE.shockDurationS);
    const radius = VB.DIVE.shockRadius * (1 - (1 - t) * (1 - t) * (1 - t));
    if (!e.shockHit && this.player.isAlive) {
      const pp = this.player.position;
      const dh = Math.hypot(pp.x - e.shockCenter.x, pp.z - e.shockCenter.z);
      if (dh <= radius && Math.abs(pp.y - e.shockCenter.y) <= VB.DIVE.shockHeight) {
        e.shockHit = true;
        this.damagePlayer(VB.DIVE.damage, e.shockCenter, CAUSE_BOSS_DIVE);
      }
    }
    if (t >= 1) e.shockT = -1;
  }

  private beginRecover(e: Enemy): void {
    e.bossMode = 'RECOVER';
    e.bossT = 0;
  }

  /** A destroyed thruster wing drops the boss for 3.5 s, head fully exposed. */
  private startDowned(e: Enemy): void {
    this.abortBossAction(e);
    e.shockT = -1;
    e.vel.set(0, 0, 0);
    _v1.copy(e.pos).setY(e.pos.y + 1);
    this.physics.raycast(_v1, DOWN, 200, _rayHit);
    e.groundY = _rayHit.hit ? _rayHit.point.y : 0;
    if (e.bossMode === 'DOWNED' || e.pos.y - e.groundY < 0.3) {
      e.pos.y = Math.max(e.groundY, Math.min(e.pos.y, e.groundY));
      e.bossMode = 'DOWNED';
    } else e.bossMode = 'FALLING';
    e.bossT = 0;
  }

  // =============================================================================================
  // Micro-missiles (shootable)
  // =============================================================================================
  private launchMissile(origin: THREE.Vector3, dir: THREE.Vector3): void {
    for (let m = 0; m < MISSILE_CAP; m++) {
      if (this.mActive[m]) continue;
      this.mActive[m] = 1;
      writeV(this.mPos, m, origin);
      writeV(this.mDir, m, dir);
      this.mSpeed[m] = VB.MISSILES.speedStart;
      this.mLife[m] = VB.MISSILES.lifeS;
      this.mTrail[m] = 0;
      const t = this.mTargets[m];
      t.alive = true;
      t.headCenter.copy(origin);
      this.armor.setVisibleAt(this.mInst[m * 3], true);
      this.armor.setVisibleAt(this.mInst[m * 3 + 1], true);
      this.glow.setVisibleAt(this.mInst[m * 3 + 2], true);
      this.effects.burst(origin, dir, BURST.MUZZLE, BOSS_ACCENT);
      return;
    }
  }

  private updateMissiles(dt: number): void {
    const MB = VB.MISSILES;
    for (let m = 0; m < MISSILE_CAP; m++) {
      if (!this.mActive[m]) continue;
      this.mLife[m] -= dt;
      readV(this.mPos, m, _v1);
      readV(this.mDir, m, _v2);
      _v3.subVectors(this.playerChest, _v1);
      const distP = _v3.length();
      if (distP > 1e-4 && this.player.isAlive) rotateToward(_v2, _v3.multiplyScalar(1 / distP), MB.turnDegPerS * DEG2RAD * dt);
      this.mSpeed[m] = Math.min(MB.speedMax, this.mSpeed[m] + 12 * dt);
      _v4.copy(_v1).addScaledVector(_v2, this.mSpeed[m] * dt);
      this.physics.segmentCast(_v1, _v4, _rayHit);
      if (_rayHit.hit) {
        this.explodeMissile(m, _rayHit.point, true);
        continue;
      }
      if (this.player.isAlive && _v4.distanceTo(this.playerChest) <= MB.fuseRadius) {
        this.explodeMissile(m, _v4, true);
        continue;
      }
      if (this.mLife[m] <= 0) {
        this.explodeMissile(m, _v4, true);
        continue;
      }
      writeV(this.mPos, m, _v4);
      writeV(this.mDir, m, _v2);
      this.mTargets[m].headCenter.copy(_v4);
      this.mTrail[m] -= dt;
      if (this.mTrail[m] <= 0) {
        this.mTrail[m] = 0.035;
        _v3.copy(_v2).negate();
        this.effects.burst(_v4, _v3, BURST.MISSILE_TRAIL);
      }
    }
  }

  private explodeMissile(m: number, point: THREE.Vector3, harmful: boolean): void {
    const MB = VB.MISSILES;
    this.effects.burst(point, UP, BURST.EXPLOSION, 0xff5a3a);
    this.effects.spawnRing(point, UP, 0xff5a3a, 3, 0.2, MB.blastRadius, 0.3);
    this.renderer.flashLight(point, 0xff5a3a, 14, 14, 0.18);
    this.events.onExplosion?.(point);
    if (harmful && this.player.isAlive && point.distanceTo(this.playerChest) <= MB.blastRadius) this.damagePlayer(MB.damage, point, CAUSE_BOSS_MISSILE);
    this.killMissile(m, true);
  }

  private killMissile(m: number, fx: boolean): void {
    void fx;
    this.mActive[m] = 0;
    this.mTargets[m].alive = false;
    this.armor.setVisibleAt(this.mInst[m * 3], false);
    this.armor.setVisibleAt(this.mInst[m * 3 + 1], false);
    this.glow.setVisibleAt(this.mInst[m * 3 + 2], false);
  }
  // =============================================================================================
  // Per frame: pose rigs, write instances, telegraph visuals, shields, debris, ghosts, missiles
  // =============================================================================================
  /**
   * @param realDt real frame time (blink rates, UI-like animation)
   * @param simDt scaled simulation time this frame (debris / ghosts / rotors respect bullet time)
   * @param alpha fixed-step interpolation factor
   */
  frameUpdate(realDt: number, simDt: number, alpha: number): void {
    this.realTime += realDt;
    const blinkOn = Math.floor(this.realTime * TELEGRAPH.LOCK_BLINK_HZ * 2) % 2 === 0;
    let shields = 0;
    for (const e of this.enemies) {
      if (!e.active || !e.rig) continue;
      if (e.alive) {
        _v4.lerpVectors(e.prevPos, e.pos, alpha);
        const ryaw = e.prevYaw + wrapAngle(e.yaw - e.prevYaw) * alpha;
        this.poseEnemy(e, _v4, ryaw, realDt, simDt);
        this.writeRig(e, blinkOn);
        this.drawTelegraph(e, blinkOn);
        if (e.kind === 'PHANTOM') this.updateGhosts(e, simDt);
        if (e.kind === 'AEGIS' && e.shieldHp > 0 && shields < SHIELD_CAP) {
          _v1.copy(_v4).setY(_v4.y + 1.0 * e.scale);
          _q1.setFromAxisAngle(UP, ryaw);
          _v2.setScalar(e.scale * (0.6 + 0.4 * clamp(e.spawnT / HUMANOID.SPAWN_MATERIALIZE_S, 0, 1)));
          _m1.compose(_v1, _q1, _v2);
          this.shieldMesh.setMatrixAt(shields, _m1);
          const f = e.shieldFlash > 0 ? 1 : 0;
          const hpK = 0.55 + 0.45 * (e.shieldHp / Math.max(1, e.shieldMax));
          _col.setHex(AEGIS_SHIELD.COLOR).multiplyScalar(MATERIALS.SHIELD_AMBER.emissive * hpK);
          if (f) _col.setRGB(3, 3, 3);
          this.shieldMesh.setColorAt(shields, _col);
          shields++;
        }
      } else if (e.kind === 'PHANTOM') this.updateGhosts(e, simDt);
      this.updateDebris(e, simDt);
    }
    this.shieldMesh.count = shields;
    this.shieldMesh.instanceMatrix.needsUpdate = true;
    if (this.shieldMesh.instanceColor) this.shieldMesh.instanceColor.needsUpdate = true;
    this.shieldUniforms.uTime.value = this.realTime;
    this.writeMissiles(blinkOn);
  }

  /** Procedural pose (§5.2): stride-driven legs, aim-driven torso / arms, kick, flinch, brace, blink, flight. */
  private poseEnemy(e: Enemy, rp: THREE.Vector3, ryaw: number, realDt: number, simDt: number): void {
    const rig = e.rig as Rig;
    const j = rig.joints;
    const s = e.scale;
    const mat = clamp(e.spawnT / HUMANOID.SPAWN_MATERIALIZE_S, 0, 1);
    const grow = 1 - (1 - mat) * (1 - mat) * (1 - mat);
    rig.root.position.copy(rp);
    rig.root.rotation.set(0, ryaw, 0);
    rig.root.scale.setScalar(s * Math.max(0.02, grow));
    const engaged = e.phase !== 'IDLE' || e.canSee || (e.isBoss && e.bossMode === 'HOVER');
    e.aimBlend += ((engaged ? 1 : 0) - e.aimBlend) * Math.min(1, realDt * 6);
    const hs = Math.hypot(e.vel.x, e.vel.z);
    e.animSpeed += (hs - e.animSpeed) * Math.min(1, simDt * 10);
    const aimYaw = yawOf(e.aimDir.x, e.aimDir.z);
    const localYaw = clamp(wrapAngle(aimYaw - ryaw), -1.1, 1.1);
    const pitch = Math.asin(clamp(e.aimDir.y, -1, 1));

    if (e.kind === 'DRONE') {
      // Bank into motion, lens / gun pod pitch toward the aim, rotors spin.
      const fwd = e.vel.x * Math.sin(ryaw) + e.vel.z * Math.cos(ryaw);
      const side = e.vel.x * Math.cos(ryaw) - e.vel.z * Math.sin(ryaw);
      rig.root.rotation.set(clamp(fwd * 0.03, -0.35, 0.35), ryaw, clamp(-side * 0.03, -0.35, 0.35));
      j.pelvis.position.y = Math.sin(this.realTime * 3 + e.index) * 0.05;
      e.rotorSpin += simDt * 46;
      for (let k = 0; k < j.rotors.length; k++) j.rotors[k].rotation.y = e.rotorSpin * (k % 2 ? 1 : -1);
      j.weapon.rotation.x = -pitch;
      j.head.rotation.x = -pitch * 0.6;
    } else {
      this.poseHumanoid(e, rig, localYaw, pitch, simDt);
    }
    rig.root.updateMatrixWorld(true);

    // World muzzle / pods and hitbox offsets from the rendered pose (what you see is what you hit).
    e.muzzle.setFromMatrixPosition(rig.muzzle.matrixWorld);
    for (let k = 0; k < rig.pods.length && k < 4; k++) {
      _v1.setFromMatrixPosition(rig.pods[k].matrixWorld);
      writeV(e.pods, k, _v1);
    }
    _v1.setFromMatrixPosition(j.head.matrixWorld);
    e.headOff.subVectors(_v1, rp);
    if (e.kind === 'DRONE') {
      _v2.setFromMatrixPosition(j.pelvis.matrixWorld);
      e.bodyOff.subVectors(_v2, rp);
    } else {
      _v2.setFromMatrixPosition(j.pelvis.matrixWorld);
      const standK = e.headOff.y / (HUMANOID.HEAD_CENTER_Y * s);
      e.bodyOff.set(_v2.x - rp.x, HUMANOID.BODY_CENTER_Y * s * clamp(standK, 0.3, 1.2), _v2.z - rp.z);
    }
    if (e.isBoss) {
      _v1.setFromMatrixPosition(rig.wingRefL.matrixWorld);
      e.wingOffL.subVectors(_v1, rp);
      _v1.setFromMatrixPosition(rig.wingRefR.matrixWorld);
      e.wingOffR.subVectors(_v1, rp);
    }
  }

  private poseHumanoid(e: Enemy, rig: Rig, localYaw: number, pitch: number, simDt: number): void {
    const j = rig.joints;
    const flying = e.isBoss && (e.bossMode === 'INTRO' || e.bossMode === 'RELOCATE' || e.bossMode === 'HOVER' || e.bossMode === 'PHASE_SHIFT' || e.bossMode === 'DIVE_ACQ' || e.bossMode === 'DIVE_LOCK' || e.bossMode === 'DIVING' || e.bossMode === 'RECOVER' || e.bossMode === 'FALLING');
    const speed = flying ? 0 : e.animSpeed;
    const amp = clamp(speed / 5.5, 0, 1.2);
    e.walkPhase += ((Math.PI * 2 * speed) / 3.4) * simDt;
    const sw = Math.sin(e.walkPhase);
    const cw = Math.cos(e.walkPhase);
    const crouch = e.crouch + (e.kind === 'PHANTOM' && e.recoverT > 0 ? 0.35 : 0) + (e.stun > 0 ? 0.12 : 0);
    const aim = e.aimBlend;

    // Legs: stride swing with knee bend on the swing phase; crouch folds hips and knees.
    j.legL.rotation.set(-sw * 0.55 * amp - crouch * 0.95, 0, 0);
    j.legR.rotation.set(sw * 0.55 * amp - crouch * 0.95, 0, 0);
    j.shinL.rotation.set(Math.max(0, cw) * 0.9 * amp + crouch * 1.75, 0, 0);
    j.shinR.rotation.set(Math.max(0, -cw) * 0.9 * amp + crouch * 1.75, 0, 0);
    j.pelvis.position.set(0, 1.0 - Math.abs(sw) * 0.035 * amp - crouch * 0.4, 0);
    j.pelvis.rotation.set(0, sw * 0.08 * amp, 0);

    // Torso / head follow the aim; firing kick and hit flinch on top.
    const lean = amp * 0.12 + crouch * 0.28 + (e.stun > 0 ? 0.3 : 0);
    j.torso.rotation.set(-pitch * 0.35 * aim + lean + e.flinchX - e.recoil * 0.06, localYaw * 0.55 * aim - j.pelvis.rotation.y, e.flinchZ);
    j.head.rotation.set(-pitch * 0.35 * aim + (e.stun > 0 ? 0.3 : 0), localYaw * 0.35 * aim, 0);

    // Right arm holds the weapon on the aim line; low-ready swing when not engaged.
    const armAim = -Math.PI / 2 - pitch * 0.65;
    j.armR.rotation.set(-0.3 + sw * 0.35 * amp * (1 - aim) + (armAim + 0.3) * aim - e.recoil * 0.12, 0, 0.06 + 0.08 * aim);
    j.foreR.rotation.set(-0.45 * (1 - aim) - 0.1 * aim, 0, 0);
    // Left arm supports the weapon.
    j.armL.rotation.set(-0.2 - sw * 0.35 * amp * (1 - aim) + (-Math.PI / 2 - pitch * 0.6 + 0.45) * aim, 0, -0.06 - 0.5 * aim);
    j.foreL.rotation.set(-0.35 - 0.55 * aim, 0, 0);

    switch (e.kind) {
      case 'AEGIS':
        if (e.shieldHp > 0) {
          // Shield brace: emitter arm held forward.
          j.armL.rotation.set(-1.25, 0, -0.32);
          j.foreL.rotation.set(-0.5, 0, 0);
        }
        break;
      case 'PHANTOM':
        if (e.blinking) {
          j.torso.rotation.x += 0.75;
          j.armR.rotation.set(0.7, 0, 0.25);
          j.armL.rotation.set(0.7, 0, -0.25);
          j.legL.rotation.x = 0.5;
          j.legR.rotation.x = -0.2;
          j.shinL.rotation.x = 1.1;
          j.shinR.rotation.x = 0.6;
        } else if (e.slash === 'GLOW') {
          // Wind-up: blade arm drawn back and up.
          j.armL.rotation.set(0.6, 0, -1.25);
          j.foreL.rotation.set(-1.2, 0, 0);
          j.torso.rotation.y += 0.45;
        } else if (e.slash === 'LUNGE') {
          const k = clamp(e.slashT / PHANTOM_BEHAVIOUR.SLASH_LUNGE_TIME_S, 0, 1);
          j.armL.rotation.set(-1.5, 0, -1.25 + 1.9 * k);
          j.foreL.rotation.set(-0.15, 0, 0);
          j.torso.rotation.y += 0.45 - 1.1 * k;
          j.torso.rotation.x += 0.35;
        }
        break;
      case 'VALKYRIE': {
        const t = this.realTime;
        if (flying) {
          // Flight: legs trail, body pitches into the flight direction.
          rig.root.rotation.x = e.lean * 0.28;
          j.legL.rotation.set(0.25 + Math.sin(t * 2.1) * 0.08, 0, -0.05);
          j.legR.rotation.set(0.4 + Math.sin(t * 2.1 + 1) * 0.08, 0, 0.05);
          j.shinL.rotation.set(0.5, 0, 0);
          j.shinR.rotation.set(0.75, 0, 0);
          j.torso.rotation.x += e.lean * 0.25;
        }
        if (e.bossMode === 'DOWNED' || e.bossMode === 'DIVE_GROUND') {
          j.torso.rotation.x += 0.45;
          j.head.rotation.x += 0.35;
          j.armL.rotation.set(-0.3, 0, -0.25);
          j.armR.rotation.set(-0.4, 0, 0.25);
        }
        // Thruster wings: spread wider in flight, flutter, fold when downed.
        const spread = e.bossMode === 'DOWNED' ? -0.3 : flying ? 0.25 + 0.06 * Math.sin(t * 9) : 0.05;
        j.wingL.rotation.set(0.15, 0.25, -spread);
        j.wingR.rotation.set(0.15, -0.25, spread);
        break;
      }
      default:
        break;
    }
  }

  /** Writes part matrices + per-role colours into the batches. */
  private writeRig(e: Enemy, blinkOn: boolean): void {
    const rig = e.rig as Rig;
    const mat = clamp(e.spawnT / HUMANOID.SPAWN_MATERIALIZE_S, 0, 1);
    const glitch = mat < 1 && Math.floor(this.realTime * 30) % 2 === 0;
    const flash = e.hitFlash > 0 ? 3 : 0;
    const flareOn = (e.phase === 'LOCK' && blinkOn) || e.phase === 'FIRING' || (e.isBoss && e.bossMode === 'DIVE_LOCK' && blinkOn);
    const bladeK = e.slash === 'GLOW' ? 2 + 6 * clamp(e.slashT / (PHANTOM_BEHAVIOUR.SLASH_GLOW_MS / 1000), 0, 1) : e.slash === 'LUNGE' ? 8 : 1;
    const thrusterK = e.isBoss ? (e.bossMode === 'RELOCATE' || e.bossMode === 'DIVING' ? 1.6 : e.downed ? 0.15 : 1) : 1;
    for (let k = 0; k < rig.parts.length; k++) {
      if (rig.dDetached[k]) continue;
      const p = rig.parts[k];
      const batch = p.batch === 0 ? this.armor : this.glow;
      if (p.role === 'FLARE') {
        batch.setVisibleAt(p.inst, flareOn);
        if (!flareOn) continue;
        _m1.copy(p.socket.matrixWorld);
        batch.setMatrixAt(p.inst, _m1);
        _col.copy(_lockColor).multiplyScalar(TELEGRAPH.LOCK_EMISSIVE * (1.2 + 0.6 * Math.sin(this.realTime * 60)));
        batch.setColorAt(p.inst, _col);
        continue;
      }
      batch.setMatrixAt(p.inst, p.socket.matrixWorld);
      switch (p.role) {
        case 'ARMOR':
          if (glitch) _col.setRGB(0.2, 2.2, 2.6);
          else _col.copy(p.base).addScalar(flash);
          break;
        case 'VISOR':
          if (e.visorBroken) _col.setRGB(0.02, 0.02, 0.02);
          else _col.copy(p.base).multiplyScalar(e.stun > 0 && blinkOn ? 0.35 : 1);
          break;
        case 'BLADE':
          _col.copy(p.base).multiplyScalar(bladeK);
          break;
        case 'THRUSTER':
          _col.setHex(e.bossPhase === 2 ? VB.WING_COLOR_P2 : VB.WING_COLOR_P1).multiplyScalar(3.0 * thrusterK);
          break;
        case 'ACCENT':
        case 'CORE':
          // VALKYRIE: white accents turn crimson in phase 2 (same intensity).
          if (e.isBoss && e.bossPhase === 2) _col.setHex(BOSS_ACCENT_P2).multiplyScalar(Math.max(p.base.r, p.base.g, p.base.b));
          else _col.copy(p.base);
          break;
        default:
          _col.copy(p.base);
          break;
      }
      batch.setColorAt(p.inst, _col);
    }
  }

  /** Telegraph line visuals (§5.1): ACQUIRING / LOCK / FIRING, Veil sight laser, boss dive circle. */
  private drawTelegraph(e: Enemy, blinkOn: boolean): void {
    const fx = this.effects;
    const range = e.pattern.spec.range;
    if (e.isBoss && (e.bossMode === 'DIVE_ACQ' || e.bossMode === 'DIVE_LOCK')) {
      const lock = e.bossMode === 'DIVE_LOCK';
      _v1.copy(e.pos).setY(e.pos.y + 1.2 * e.scale);
      _v2.copy(e.diveTarget).setY(e.diveTarget.y + 0.05);
      if (lock) {
        const t = clamp(e.bossT / Math.max(e.lockS, 1e-3), 0, 1);
        const w = TELEGRAPH.LOCK_WIDTH_END + (TELEGRAPH.LOCK_WIDTH_START - TELEGRAPH.LOCK_WIDTH_END) * (1 - t) * (1 - t);
        fx.setLine(e.lineIds[0], _v1, _v2, w, w, _lockColor, TELEGRAPH.LOCK_EMISSIVE, 1, false, blinkOn);
        fx.setRing(e.diveRing, _v2, UP, TELEGRAPH.LOCK_COLOR, blinkOn ? TELEGRAPH.LOCK_EMISSIVE : 0.8, VB.DIVE.shockRadius);
      } else {
        fx.setLine(e.lineIds[0], _v1, _v2, TELEGRAPH.ACQ_WIDTH, TELEGRAPH.ACQ_WIDTH, _acqColor, MATERIALS.ENEMY_AIM.emissive, TELEGRAPH.ACQ_OPACITY, true);
        fx.setRing(e.diveRing, _v2, UP, TELEGRAPH.ACQ_COLOR, 1.6, VB.DIVE.shockRadius * (0.85 + 0.15 * Math.sin(this.realTime * 12)));
      }
      return;
    }
    switch (e.phase) {
      case 'ACQUIRING':
        for (let i = 0; i < e.lineCount; i++) {
          this.lineOrigin(e, i, _v1);
          this.lineDir(e, i, _v1, _v2);
          this.physics.raycast(_v1, _v2, range, _rayHit, LINE_IGNORE_NONE);
          _v3.copy(_v2).multiplyScalar(_rayHit.hit ? _rayHit.distance : range).add(_v1);
          fx.setLine(e.lineIds[i], _v1, _v3, TELEGRAPH.ACQ_WIDTH, TELEGRAPH.ACQ_WIDTH, _acqColor, MATERIALS.ENEMY_AIM.emissive, TELEGRAPH.ACQ_OPACITY, true);
        }
        break;
      case 'LOCK': {
        const t = clamp(e.phaseT / Math.max(e.lockS, 1e-3), 0, 1);
        // 0.045 m → 0.012 m, converging sharply toward the shot.
        const w = TELEGRAPH.LOCK_WIDTH_END + (TELEGRAPH.LOCK_WIDTH_START - TELEGRAPH.LOCK_WIDTH_END) * (1 - t) * (1 - t);
        for (let i = 0; i < e.lineCount; i++) {
          readV(e.lockO, i, _v1);
          readV(e.lockE, i, _v3);
          fx.setLine(e.lineIds[i], _v1, _v3, w, w, _lockColor, TELEGRAPH.LOCK_EMISSIVE, 1, false, blinkOn);
        }
        break;
      }
      case 'FIRING':
        for (let i = 0; i < e.lineCount; i++) {
          readV(e.lockO, i, _v1);
          readV(e.lockE, i, _v3);
          fx.setLine(e.lineIds[i], _v1, _v3, TELEGRAPH.LOCK_WIDTH_END, TELEGRAPH.LOCK_WIDTH_END, _lockColor, TELEGRAPH.LOCK_EMISSIVE, 1, false, true);
        }
        break;
      default:
        if (e.sightLine >= 0) {
          // Veil: the always-on thin sight laser.
          this.physics.raycast(e.muzzle, e.aimDir, range, _rayHit, LINE_IGNORE_NONE);
          _v3.copy(e.aimDir).multiplyScalar(_rayHit.hit ? _rayHit.distance : range).add(e.muzzle);
          fx.setLine(e.sightLine, e.muzzle, _v3, VEIL_BEHAVIOUR.SIGHT_WIDTH, VEIL_BEHAVIOUR.SIGHT_WIDTH, _sightColor, 2.0, VEIL_BEHAVIOUR.SIGHT_OPACITY, false);
        }
        break;
    }
  }

  /** Phantom blink afterimages: purple snapshots of the body every 50 ms, fading over 0.35 s. */
  private updateGhosts(e: Enemy, simDt: number): void {
    const rig = e.rig as Rig;
    const n = rig.ghostParts.length;
    if (n === 0) return;
    const PB = PHANTOM_BEHAVIOUR;
    if (e.alive && e.blinking) {
      e.ghostTimer -= simDt;
      if (e.ghostTimer <= 0) {
        e.ghostTimer = PB.GHOST_INTERVAL_S;
        const s = rig.ghostNext;
        rig.ghostNext = (s + 1) % GHOST_SNAPSHOTS;
        rig.ghostLife[s] = PB.GHOST_LIFE_S;
        for (let k = 0; k < n; k++) {
          const inst = rig.ghostInst[s * n + k];
          this.glow.setMatrixAt(inst, rig.ghostParts[k].socket.matrixWorld);
          this.glow.setVisibleAt(inst, true);
        }
      }
    }
    for (let s = 0; s < GHOST_SNAPSHOTS; s++) {
      if (rig.ghostLife[s] <= 0) continue;
      rig.ghostLife[s] -= simDt;
      const k = Math.max(0, rig.ghostLife[s] / PB.GHOST_LIFE_S);
      _col.setHex(PB.GHOST_COLOR).multiplyScalar(1.3 * k);
      for (let q = 0; q < n; q++) {
        const inst = rig.ghostInst[s * n + q];
        if (k <= 0) this.glow.setVisibleAt(inst, false);
        else this.glow.setColorAt(inst, _col);
      }
    }
  }

  private writeMissiles(blinkOn: boolean): void {
    for (let m = 0; m < MISSILE_CAP; m++) {
      if (!this.mActive[m]) continue;
      readV(this.mPos, m, _v1);
      readV(this.mDir, m, _v2);
      _q1.setFromUnitVectors(UP, _v2);
      _v3.set(0.13, 0.55, 0.13);
      _m1.compose(_v1, _q1, _v3);
      this.armor.setMatrixAt(this.mInst[m * 3], _m1);
      _v4.copy(_v1).addScaledVector(_v2, 0.36);
      _v3.set(0.14, 0.18, 0.14);
      _m1.compose(_v4, _q1, _v3);
      this.armor.setMatrixAt(this.mInst[m * 3 + 1], _m1);
      _v4.copy(_v1).addScaledVector(_v2, -0.34);
      const f = blinkOn ? 0.55 : 0.42;
      _v3.set(f, f, f);
      _m1.compose(_v4, _q1, _v3);
      this.glow.setMatrixAt(this.mInst[m * 3 + 2], _m1);
    }
  }

  /** Hitboxes = logical position + offsets measured on the last rendered pose. */
  private updateHitboxes(e: Enemy): void {
    const s = e.scale;
    const t = e.hit;
    t.alive = e.alive;
    t.headCenter.addVectors(e.pos, e.headOff);
    t.bodyCenter.addVectors(e.pos, e.bodyOff);
    t.bodyYaw = e.yaw;
    if (e.kind === 'DRONE') {
      t.headRadius = DRONE_BEHAVIOUR.LENS_RADIUS;
      t.bodyHalf.set(DRONE_BEHAVIOUR.BODY_HALF[0], DRONE_BEHAVIOUR.BODY_HALF[1], DRONE_BEHAVIOUR.BODY_HALF[2]);
    } else {
      t.headRadius = HUMANOID.HEAD_RADIUS * s;
      t.bodyHalf.set(HUMANOID.BODY_HALF[0] * s, HUMANOID.BODY_HALF[1] * s, HUMANOID.BODY_HALF[2] * s);
    }
    const sh = e.shieldTarget;
    sh.alive = e.alive && e.kind === 'AEGIS' && e.shieldHp > 0;
    if (sh.alive) {
      sh.bodyCenter.set(e.pos.x + Math.sin(e.yaw) * 0.62 * s, e.pos.y + 1.0 * s, e.pos.z + Math.cos(e.yaw) * 0.62 * s);
      sh.bodyHalf.set(0.77 * s, 0.98 * s, 0.25 * s);
      sh.bodyYaw = e.yaw;
      sh.headRadius = 0;
    }
    for (let side = 0; side < 2; side++) {
      const w = side === 0 ? e.wingTargetL : e.wingTargetR;
      w.alive = e.alive && e.isBoss && !e.wingBroken[side];
      if (!w.alive) continue;
      w.bodyCenter.addVectors(e.pos, side === 0 ? e.wingOffL : e.wingOffR);
      w.bodyHalf.set(0.55 * s, 0.7 * s, 0.22 * s);
      w.bodyYaw = e.yaw;
      w.headRadius = 0;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Debris: parts break off, fly ballistically, bounce on the surface below, dissolve after 3 s
  // ---------------------------------------------------------------------------------------------
  private detachPart(e: Enemy, k: number, dir: THREE.Vector3, power: number, launchUp: number): void {
    const rig = e.rig as Rig;
    const p = rig.parts[k];
    if (rig.dDetached[k]) return;
    if (p.role === 'FLARE') {
      rig.dDetached[k] = 2;
      (p.batch === 0 ? this.armor : this.glow).setVisibleAt(p.inst, false);
      return;
    }
    rig.dDetached[k] = 1;
    rig.dAge[k] = 0;
    p.socket.matrixWorld.decompose(_v1, _q1, _v2);
    rig.dPos[k * 3] = _v1.x;
    rig.dPos[k * 3 + 1] = _v1.y;
    rig.dPos[k * 3 + 2] = _v1.z;
    rig.dQuat[k * 4] = _q1.x;
    rig.dQuat[k * 4 + 1] = _q1.y;
    rig.dQuat[k * 4 + 2] = _q1.z;
    rig.dQuat[k * 4 + 3] = _q1.w;
    rig.dScl[k * 3] = _v2.x;
    rig.dScl[k * 3 + 1] = _v2.y;
    rig.dScl[k * 3 + 2] = _v2.z;
    // Outward from the body centre + shot direction + upward pop.
    _v3.subVectors(_v1, rig.root.position);
    _v3.y = 0;
    if (_v3.lengthSq() < 1e-4) _v3.set(this.rng() - 0.5, 0, this.rng() - 0.5);
    _v3.normalize();
    rig.dVel[k * 3] = _v3.x * (1.5 + this.rng() * 2.5) * power + dir.x * 4 * power + (this.rng() * 2 - 1);
    rig.dVel[k * 3 + 1] = (2.5 + this.rng() * 3.5) * power + launchUp;
    rig.dVel[k * 3 + 2] = _v3.z * (1.5 + this.rng() * 2.5) * power + dir.z * 4 * power + (this.rng() * 2 - 1);
    rig.dAng[k * 3] = (this.rng() * 2 - 1) * 9;
    rig.dAng[k * 3 + 1] = (this.rng() * 2 - 1) * 9;
    rig.dAng[k * 3 + 2] = (this.rng() * 2 - 1) * 9;
    _v4.copy(_v1).setY(_v1.y + 0.2);
    this.physics.raycast(_v4, DOWN, 160, _rayHit);
    rig.dGround[k] = _rayHit.hit ? _rayHit.point.y : _v1.y - 160;
  }

  private updateDebris(e: Enemy, simDt: number): void {
    const rig = e.rig;
    if (!rig) return;
    let live = 0;
    let any = false;
    for (let k = 0; k < rig.parts.length; k++) {
      const st = rig.dDetached[k];
      if (st === 0) continue;
      any = true;
      if (st === 2) continue;
      const p = rig.parts[k];
      const batch = p.batch === 0 ? this.armor : this.glow;
      rig.dAge[k] += simDt;
      const age = rig.dAge[k];
      if (age >= DEBRIS_LIFE) {
        rig.dDetached[k] = 2;
        batch.setVisibleAt(p.inst, false);
        continue;
      }
      live++;
      const o = k * 3;
      rig.dVel[o + 1] += GRAVITY * 0.75 * simDt;
      rig.dPos[o] += rig.dVel[o] * simDt;
      rig.dPos[o + 1] += rig.dVel[o + 1] * simDt;
      rig.dPos[o + 2] += rig.dVel[o + 2] * simDt;
      const halfH = Math.min(0.3, rig.dScl[o + 1] * 0.5);
      if (rig.dPos[o + 1] - halfH < rig.dGround[k] && rig.dVel[o + 1] < 0) {
        // Bounce on the wet roof / street.
        rig.dPos[o + 1] = rig.dGround[k] + halfH;
        rig.dVel[o + 1] = -rig.dVel[o + 1] * 0.32;
        rig.dVel[o] *= 0.62;
        rig.dVel[o + 2] *= 0.62;
        rig.dAng[o] *= 0.6;
        rig.dAng[o + 1] *= 0.6;
        rig.dAng[o + 2] *= 0.6;
      }
      _q1.set(rig.dQuat[k * 4], rig.dQuat[k * 4 + 1], rig.dQuat[k * 4 + 2], rig.dQuat[k * 4 + 3]);
      _axis.set(rig.dAng[o], rig.dAng[o + 1], rig.dAng[o + 2]);
      const w = _axis.length();
      if (w > 1e-4) {
        _axis.multiplyScalar(1 / w);
        _q1.premultiply(_m1Quat.setFromAxisAngle(_axis, w * simDt));
        rig.dQuat[k * 4] = _q1.x;
        rig.dQuat[k * 4 + 1] = _q1.y;
        rig.dQuat[k * 4 + 2] = _q1.z;
        rig.dQuat[k * 4 + 3] = _q1.w;
      }
      // Digital dissolve over the last 0.6 s: shrink, jitter and glitch-flicker cyan.
      const dk = clamp((age - (DEBRIS_LIFE - DISSOLVE_S)) / DISSOLVE_S, 0, 1);
      const shrink = 1 - dk * dk;
      _v1.set(rig.dPos[o], rig.dPos[o + 1], rig.dPos[o + 2]);
      if (dk > 0) {
        _v1.x += (this.rng() - 0.5) * 0.08 * dk;
        _v1.y += (this.rng() - 0.5) * 0.08 * dk;
      }
      _v2.set(rig.dScl[o] * shrink, rig.dScl[o + 1] * shrink, rig.dScl[o + 2] * shrink);
      _m1.compose(_v1, _q1, _v2);
      batch.setMatrixAt(p.inst, _m1);
      if (p.batch === 0) {
        if (dk > 0 && Math.floor(this.realTime * 30 + k) % 3 === 0) _col.setRGB(0.3, 2.4, 2.8);
        else _col.copy(p.base);
      } else {
        _col.copy(p.base).multiplyScalar(p.role === 'VISOR' && !e.visorBroken ? 0.25 * (1 - dk) : 0.5 * (1 - dk));
      }
      batch.setColorAt(p.inst, _col);
      if (dk > 0 && age - simDt < DEBRIS_LIFE - DISSOLVE_S && k % 6 === 0) this.effects.burst(_v1, UP, BURST.GLITCH);
    }
    if (any && live === 0 && !e.alive) this.releaseEnemy(e);
  }
  // =============================================================================================
  // Damage (§2.1 hitstop / feedback, §4 multipliers, §5.2 regions)
  // =============================================================================================
  private readonly killInfo = {
    kind: 'ENFORCER' as EnemyKind,
    headshot: false,
    airborne: false,
    wallRun: false,
    swinging: false,
    bulletTime: false,
    weapon: 0,
    position: new THREE.Vector3(),
  };

  /** Every projectile impact (both owners) is routed here. */
  handleImpact(im: ProjectileImpact): void {
    if (im.owner === 'ENEMY') {
      if (im.target === this.playerTarget) {
        _v1.copy(im.point).addScaledVector(im.direction, -20);
        this.damagePlayer(im.damage, _v1, CAUSE_BY_TAG[im.tag] ?? 'HOSTILE FIRE');
      }
      return;
    }
    const t = im.target;
    if (!t) return;
    if (t.id >= MISSILE_ID_BASE && t.id < MISSILE_ID_BASE + MISSILE_CAP) {
      // Micro-missile shot down: detonates harmlessly.
      this.explodeMissile(t.id - MISSILE_ID_BASE, im.point, false);
      this.events.onHitMarker?.('PART');
      return;
    }
    const e = this.enemies[t.id >> 2];
    if (!e || !e.alive) return;
    const part = t.id & 3;
    const ricochet = im.tag === RICOCHET_TAG;
    // Kill-info weapon tag: ricochets count as skill damage.
    const weapon = ricochet ? 4 : im.tag;
    const partBonus = im.tag === 1 ? 1 + this.modifiers.smgPartBonus : 1;
    if (part === 1) {
      this.damageShield(e, im.damage * im.shieldMultiplier * partBonus, im.point, im.direction, weapon);
      return;
    }
    if (part >= 2) {
      this.damageWing(e, part - 2, im.damage * partBonus, im.point, im.direction, weapon);
      return;
    }
    let head = im.region === 'HEAD';
    // Piercing rounds (SK_02) pass through the Aegis shield; everything else is blocked by its frontal arc.
    if (!im.pierce && e.kind === 'AEGIS' && e.shieldHp > 0 && this.shieldBlocks(e, im.direction)) {
      this.damageShield(e, im.damage * im.shieldMultiplier * partBonus, im.point, im.direction, weapon);
      return;
    }
    // SK_15 ricochet interrupts the target's telegraph.
    if (ricochet) this.cancelAttack(e, 0.6);
    let mult = 1;
    if (head) {
      if (e.isBoss && !e.downed) {
        // VALKYRIE's crest deflects head shots unless she is downed: metal ricochet sparks, ARMOR marker,
        // "ARMORED — DESTROY WINGS" (5A-5).
        mult = VB.ARMORED_HEAD_MULTIPLIER;
        head = false;
        _v1.copy(im.direction).negate();
        this.effects.burst(im.point, _v1, BURST.SPARK, 0xe8f6ff);
        this.effects.burst(im.point, _v1, BURST.HIT_SPARK);
        this.markerOverride = 'ARMOR';
        this.events.onArmorDeflect?.(im.point);
      } else mult = im.headMultiplier;
    }
    this.applyDamage(e, Math.round(im.damage * mult), head, im.point, im.direction, weapon);
    this.markerOverride = null;
  }

  /** Replaces the surviving-body hit marker for the current impact (boss armour deflect). */
  private markerOverride: HitMarkerKind | null = null;

  /** Frontal 130° arc blocks the shot unless it comes steeply from above (strand / wall-run flank). */
  private shieldBlocks(e: Enemy, dir: THREE.Vector3): boolean {
    const hx = -dir.x;
    const hz = -dir.z;
    const hl = Math.hypot(hx, hz);
    if (hl < 1e-4) return false;
    const cosA = (hx * Math.sin(e.yaw) + hz * Math.cos(e.yaw)) / hl;
    if (cosA < Math.cos((AEGIS_SHIELD.ARC_DEG / 2) * DEG2RAD)) return false;
    const below = Math.asin(clamp(-dir.y, -1, 1)) / DEG2RAD;
    return below < AEGIS_SHIELD.OVERHEAD_PASS_DEG;
  }

  private damageShield(e: Enemy, dmg: number, point: THREE.Vector3, dir: THREE.Vector3, weapon: number): void {
    e.shieldHp -= dmg;
    e.shieldFlash = 0.07;
    _v1.copy(dir).negate();
    this.effects.burst(point, _v1, BURST.SPARK, AEGIS_SHIELD.COLOR);
    if (e.shieldHp > 0) {
      this.events.onHitMarker?.('SHIELD');
      return;
    }
    // Shield break: 85 ms hitstop, 32 shards, shock ring, +0.5 trauma, 1.5 s stun.
    e.shieldHp = 0;
    e.stun = Math.max(e.stun, AEGIS_SHIELD.STUN_S);
    this.cancelAttack(e, 0.6);
    _v2.copy(e.pos).setY(e.pos.y + 1.0 * e.scale);
    this.effects.burst(_v2, _v1, BURST.BREAK_DEBRIS, AEGIS_SHIELD.COLOR);
    this.effects.spawnRing(_v2, UP, AEGIS_SHIELD.COLOR, 3.5, 0.4, 6, 0.45);
    this.renderer.flashLight(_v2, AEGIS_SHIELD.COLOR, 14, 14, 0.2);
    this.events.onHitstop?.(HITSTOP.SHIELD_OR_BOSS_PART_BREAK);
    this.player.addTrauma(SHAKE.SHIELD_OR_BOSS_PART_BREAK);
    this.events.onHitMarker?.('PART');
    this.events.onShieldBreak?.(_v2, weapon);
  }

  private damageWing(e: Enemy, side: number, dmg: number, point: THREE.Vector3, dir: THREE.Vector3, weapon: number): void {
    if (e.wingBroken[side]) return;
    e.wingHp[side] -= dmg;
    e.hitFlash = 0.05;
    _v1.copy(dir).negate();
    this.effects.burst(point, _v1, BURST.SPARK, e.bossPhase === 2 ? VB.WING_COLOR_P2 : 0xe8f6ff);
    if (e.wingHp[side] > 0) {
      // Orange weak-point marker (5A-5).
      this.events.onHitMarker?.('WING');
      return;
    }
    e.wingBroken[side] = 1;
    const rig = e.rig as Rig;
    const sideSign = side === 0 ? -1 : 1;
    for (let k = 0; k < rig.parts.length; k++) if (rig.parts[k].wing === sideSign) this.detachPart(e, k, dir, 1.4, 2);
    _v2.copy(point);
    this.effects.burst(_v2, _v1, BURST.BREAK_DEBRIS, VB.WING_COLOR_P2);
    this.effects.spawnRing(_v2, _v1, 0xffffff, 3.5, 0.4, 7, 0.45);
    this.renderer.flashLight(_v2, VB.WING_COLOR_P2, 20, 18, 0.25);
    this.events.onHitstop?.(HITSTOP.SHIELD_OR_BOSS_PART_BREAK);
    this.player.addTrauma(SHAKE.SHIELD_OR_BOSS_PART_BREAK);
    this.events.onHitMarker?.('PART');
    this.events.onBossPartBreak?.(_v2, weapon);
    this.startDowned(e);
  }

  /**
   * Applies damage to an enemy's HP with full feedback. `weapon`: 0 pistol, 1 SMG, 2 shotgun, 3 grapple,
   * 4 explosion / skill effect.
   */
  applyDamage(e: Enemy, dmg: number, head: boolean, point: THREE.Vector3, dir: THREE.Vector3, weapon: number): void {
    if (!e.alive) return;
    e.hp -= dmg;
    e.hitFlash = 0.06;
    // Flinch away from the hit (local frame).
    const fwd = dir.x * Math.sin(e.yaw) + dir.z * Math.cos(e.yaw);
    const side = dir.x * Math.cos(e.yaw) - dir.z * Math.sin(e.yaw);
    const k = clamp(dmg / 60, 0.3, 1.6);
    e.flinchVX += fwd * 5 * k;
    e.flinchVZ += -side * 5 * k;
    _v1.copy(dir).negate();
    if (e.hp > 0) {
      if (head) {
        // Head-shot (survived): visor shatters, 22 ms hitstop, gold marker.
        if (!e.visorBroken) this.effects.burst(point, _v1, BURST.VISOR_SHARD, e.def.visorColor);
        else this.effects.burst(point, _v1, BURST.HIT_SPARK);
        e.visorBroken = true;
        this.events.onHitstop?.(HITSTOP.HEADSHOT_HIT);
        this.events.onHitMarker?.('HEAD');
      } else {
        this.effects.burst(point, _v1, BURST.HIT_SPARK);
        this.events.onHitMarker?.(this.markerOverride ?? 'BODY');
      }
      return;
    }
    this.kill(e, head, point, dir, weapon);
  }

  private kill(e: Enemy, head: boolean, point: THREE.Vector3, dir: THREE.Vector3, weapon: number): void {
    e.alive = false;
    e.hp = 0;
    e.deathT = 0;
    this.releaseLines(e);
    if (e.sightLine >= 0) this.effects.releaseLine(e.sightLine);
    e.sightLine = -1;
    if (e.diveRing >= 0) this.effects.releaseRing(e.diveRing);
    e.diveRing = -1;
    e.phase = 'IDLE';
    e.warning.active = false;
    e.hit.alive = false;
    e.shieldTarget.alive = false;
    e.wingTargetL.alive = false;
    e.wingTargetR.alive = false;
    this.killedCount++;

    const p = this.player;
    const wall = p.isWallRunning;
    const air = p.isAirborne && !wall;
    const bt = p.btActive;
    // Bullet-time recovery: HS +22 / air +14 / wall-run +16 (additive), FLOW S+ bonus.
    let gain = 0;
    if (head) gain += BULLET_TIME.BONUS_HS_KILL;
    if (air) gain += BULLET_TIME.BONUS_AIR_KILL;
    if (wall) gain += BULLET_TIME.BONUS_WALLRUN_KILL;
    if (gain > 0) p.addBulletTimeGauge(gain * (1 + this.modifiers.btKillRecoveryBonus));

    _v2.copy(e.pos).add(e.bodyOff);
    _v3.copy(e.pos).add(e.headOff);
    if (e.isBoss) {
      this.bossKilled(e, _v2);
    } else if (head) {
      this.events.onHitstop?.(bt ? HITSTOP.BT_AIR_HEADSHOT_KILL : HITSTOP.HEADSHOT_KILL);
      if (bt) this.renderer.triggerChromaSpike(JUICE.BT_HS_KILL_CHROMA_SPIKE, JUICE.BT_HS_KILL_CHROMA_DECAY_MS);
      p.pulseFov(JUICE.HEADSHOT_KILL_FOV_PULSE_DEG);
      _v1.copy(dir).negate();
      if (!e.visorBroken) this.effects.burst(point, _v1, BURST.VISOR_SHARD, e.def.visorColor);
      // Discharge from the top of the head (cyan + crimson).
      _v4.copy(_v3).setY(_v3.y + 0.18 * e.scale);
      this.effects.burst(_v4, UP, BURST.DISCHARGE_CYAN);
      this.effects.burst(_v4, UP, BURST.DISCHARGE_CRIMSON);
      this.renderer.flashLight(_v4, COLORS.PLAYER_STRAND, 10, 10, 0.12);
      this.events.onHitMarker?.('HEAD_KILL');
    } else {
      this.events.onHitstop?.(HITSTOP.BODY_KILL);
      this.events.onHitMarker?.('KILL');
    }
    // Core rupture + light shockwave.
    this.effects.burst(_v2, UP, BURST.CORE_BURST, e.def.visorColor);
    this.effects.spawnRing(_v2, UP, e.def.visorColor, 2.2, 0.3, 2.6 * e.scale, 0.28);

    const info = this.killInfo;
    info.kind = e.kind;
    info.headshot = head;
    info.airborne = air;
    info.wallRun = wall;
    info.swinging = p.isSwinging;
    info.bulletTime = bt;
    info.weapon = weapon;
    info.position.copy(_v2);
    this.events.onKill?.(info);

    this.startDeath(e, dir, head);
    if (e.kind === 'DRONE') {
      // Drone self-destruct: 50 damage within 4 m (player and other enemies).
      _v4.copy(e.pos);
      this.explosion(_v4, DRONE_BEHAVIOUR.EXPLOSION_RADIUS, DRONE_BEHAVIOUR.EXPLOSION_DAMAGE, ENEMY_DEFS.DRONE.visorColor);
    }
  }

  private startDeath(e: Enemy, dir: THREE.Vector3, head: boolean): void {
    const rig = e.rig;
    if (!rig) return;
    const headJoint = rig.joints.head;
    for (let k = 0; k < rig.parts.length; k++) {
      const onHead = rig.parts[k].socket.parent === headJoint;
      this.detachPart(e, k, dir, e.kind === 'DRONE' ? 1.6 : 1, onHead && head ? 4.5 : 0);
    }
    for (let s = 0; s < GHOST_SNAPSHOTS; s++) if (rig.ghostLife[s] > 0) rig.ghostLife[s] = Math.min(rig.ghostLife[s], 0.1);
  }

  private bossKilled(e: Enemy, at: THREE.Vector3): void {
    // 240 ms near-freeze, micro zoom, frame flash, every enemy round and missile vanishes.
    this.events.onHitstop?.(HITSTOP.BOSS_KILL);
    this.renderer.postFx.frameFlash = 1;
    this.renderer.triggerChromaSpike(0.009, 400);
    this.player.pulseFov(-3.5);
    this.effects.clearProjectiles('ENEMY');
    for (let m = 0; m < MISSILE_CAP; m++) if (this.mActive[m]) this.explodeMissile(m, readV(this.mPos, m, _v5), false);
    this.effects.burst(at, UP, BURST.EXPLOSION, BOSS_ACCENT);
    this.effects.burst(at, UP, BURST.BREAK_DEBRIS, 0xffffff);
    this.effects.spawnRing(at, UP, BOSS_ACCENT, 5, 0.5, 18, 0.8);
    this.effects.spawnRing(at, UP, 0xffffff, 4, 0.5, 10, 0.5);
    this.renderer.flashLight(at, BOSS_ACCENT, 40, 40, 0.5);
    this.bossDefeated = true;
    this.boss = null;
    // Her summons shut down with her.
    for (const o of this.enemies) {
      if (o === e || !o.alive || !o.summoned) continue;
      _v1.set(0, 1, 0);
      o.alive = false;
      o.hit.alive = false;
      this.releaseLines(o);
      if (o.sightLine >= 0) this.effects.releaseLine(o.sightLine);
      o.sightLine = -1;
      o.warning.active = false;
      this.killedCount++;
      this.startDeath(o, _v1, false);
    }
    this.queue.length = 0;
    this.events.onBossDefeated?.(at);
  }

  /** Spherical blast: damages enemies (with cancel) and optionally the player. */
  private explosion(point: THREE.Vector3, radius: number, damage: number, color: number): void {
    this.effects.burst(point, UP, BURST.EXPLOSION, color);
    this.effects.spawnRing(point, UP, color, 3.2, 0.3, radius, 0.32);
    this.renderer.flashLight(point, color, 16, radius * 4, 0.22);
    this.events.onExplosion?.(point);
    if (this.player.isAlive && point.distanceTo(this.playerChest) <= radius) this.damagePlayer(damage, point, CAUSE_DRONE_BLAST);
    this.applyAreaDamage(point, radius, damage, 4, false);
  }

  /**
   * Area damage to enemies (drone blasts; skill hooks such as SK_08 thermal shock, which also force-cancels
   * telegraphs). Returns the number of enemies hit.
   */
  applyAreaDamage(point: THREE.Vector3, radius: number, damage: number, weapon: number, cancelTelegraph: boolean): number {
    let n = 0;
    for (const o of this.enemies) {
      if (!o.alive) continue;
      _v1.addVectors(o.pos, o.bodyOff);
      const d = _v1.distanceTo(point);
      if (d > radius) continue;
      n++;
      if (cancelTelegraph) this.cancelAttack(o, 0.8);
      _v2.subVectors(_v1, point);
      if (_v2.lengthSq() < 1e-6) _v2.set(0, 1, 0);
      _v2.normalize();
      this.applyDamage(o, damage, false, _v1, _v2, weapon);
    }
    return n;
  }

  /** Nearest living enemy (body centre) to `point` within `radius`, excluding `exclude` (SK_15 ricochet). */
  nearestEnemy(point: THREE.Vector3, radius: number, exclude: HitboxTarget | null, out: THREE.Vector3): HitboxTarget | null {
    let best = radius;
    let pick: HitboxTarget | null = null;
    for (const o of this.enemies) {
      if (!o.alive || o.hit === exclude) continue;
      const d = o.hit.bodyCenter.distanceTo(point);
      if (d < best) {
        best = d;
        pick = o.hit;
        out.copy(o.hit.bodyCenter);
      }
    }
    return pick;
  }

  /**
   * Up to `out.length` distinct living enemies (body centres) nearest to `point` within `radius`, sorted by
   * distance (SK_15 ricochet targets). Returns how many were written.
   */
  nearestEnemies(point: THREE.Vector3, radius: number, out: THREE.Vector3[]): number {
    let n = 0;
    const max = out.length;
    _nearDist.fill(Infinity);
    for (const o of this.enemies) {
      if (!o.alive) continue;
      const d = o.hit.bodyCenter.distanceTo(point);
      if (d > radius) continue;
      // Insertion into the sorted top-`max` list.
      let k = Math.min(n, max - 1);
      if (n === max && d >= _nearDist[max - 1]) continue;
      while (k > 0 && _nearDist[k - 1] > d) {
        _nearDist[k] = _nearDist[k - 1];
        out[k].copy(out[k - 1]);
        k--;
      }
      _nearDist[k] = d;
      out[k].copy(o.hit.bodyCenter);
      if (n < max) n++;
    }
    return n;
  }

  // =============================================================================================
  // Grapple bite (§4 S-00): 15 damage + 0.4 s stagger, the strand stays fixed to the enemy
  // =============================================================================================
  onGrappleTarget(target: HitboxTarget, point: THREE.Vector3): void {
    if (target.id >= MISSILE_ID_BASE) return;
    const e = this.enemies[target.id >> 2];
    if (!e || !e.alive) return;
    const part = target.id & 3;
    this.player.eyePosition(_v1);
    _v2.subVectors(point, _v1);
    if (_v2.lengthSq() < 1e-6) _v2.set(0, 0, 1);
    _v2.normalize();
    if (part === 1) this.damageShield(e, GRAPPLE_HOOK_DAMAGE, point, _v2, 3);
    else if (part >= 2) this.damageWing(e, part - 2, GRAPPLE_HOOK_DAMAGE, point, _v2, 3);
    else this.applyDamage(e, GRAPPLE_HOOK_DAMAGE, false, point, _v2, 3);
    if (!e.alive) return;
    e.stun = Math.max(e.stun, this.modifiers.grappleStunS);
    this.cancelAttack(e, 0.4);
    if (e.kind === 'PHANTOM') {
      e.slash = 'NONE';
      e.blinking = false;
    }
    this.hooked = e;
    this.hookOffset.subVectors(point, e.pos);
  }

  // =============================================================================================
  // Debug / tests
  // =============================================================================================
  debugState(): { kind: EnemyKind; hp: number; phase: AttackPhase; pos: number[]; alive: boolean; shield: number; boss: string }[] {
    const out: { kind: EnemyKind; hp: number; phase: AttackPhase; pos: number[]; alive: boolean; shield: number; boss: string }[] = [];
    for (const e of this.enemies) {
      if (!e.active) continue;
      out.push({ kind: e.kind, hp: Math.round(e.hp), phase: e.phase, pos: [+e.pos.x.toFixed(2), +e.pos.y.toFixed(2), +e.pos.z.toFixed(2)], alive: e.alive, shield: Math.round(e.shieldHp), boss: e.isBoss ? e.bossMode : '' });
    }
    return out;
  }

  /** Tests: skip to the last wave and kill everything alive (the normal clear / boss-defeat flow follows). */
  debugKillAll(): void {
    this.queue.length = 0;
    if (this.wave < this.waveLists.length - 1) this.wave = this.waveLists.length - 1;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      _v1.copy(e.pos).add(e.bodyOff);
      this.applyDamage(e, 1e6, false, _v1, UP, 4);
    }
  }

  get stats(): { total: number; killed: number; wave: number; waves: number; remaining: number; cleared: boolean } {
    return { total: this.totalCount, killed: this.killedCount, wave: this.wave + 1, waves: this.waveLists.length, remaining: this.remaining, cleared: this.cleared };
  }
}

// =============================================================================================
// Wave composition: roster split proportionally across waves (largest remainder), endless scaling.
// =============================================================================================
const ROSTER_ORDER: readonly EnemyKind[] = ['ENFORCER', 'AEGIS', 'VEIL', 'PHANTOM', 'DRONE', 'VALKYRIE'];

function composeWaves(sector: SectorDef, loop: number): EnemyKind[][] {
  // Endless +20 % per loop applies to the sector total (9 → 11 at Loop 2), split across kinds by largest remainder.
  const scale = 1 + ENDLESS.SPAWN_COUNT_PER_LOOP * loop;
  const remaining = new Map<EnemyKind, number>();
  let baseRegular = 0;
  for (const k of ROSTER_ORDER) if (k !== 'VALKYRIE') baseRegular += sector.roster[k] ?? 0;
  const targetRegular = Math.round(baseRegular * scale);
  const fracs: { k: EnemyKind; f: number }[] = [];
  let assigned = 0;
  for (const k of ROSTER_ORDER) {
    const base = sector.roster[k] ?? 0;
    if (base <= 0) continue;
    if (k === 'VALKYRIE') {
      remaining.set(k, base);
      continue;
    }
    const exact = base * scale;
    const n = Math.floor(exact);
    remaining.set(k, n);
    assigned += n;
    fracs.push({ k, f: exact - n });
  }
  fracs.sort((a, b) => b.f - a.f);
  for (let i = 0; assigned < targetRegular && i < fracs.length; i++, assigned++) remaining.set(fracs[i].k, (remaining.get(fracs[i].k) ?? 0) + 1);
  let total = 0;
  for (const n of remaining.values()) total += n;
  const baseTotal = sector.waves.reduce((a, w) => a + w.count, 0);
  const waves: EnemyKind[][] = [];
  let left = total;
  for (let w = 0; w < sector.waves.length; w++) {
    const last = w === sector.waves.length - 1;
    const size = last ? left : Math.min(left, Math.round((sector.waves[w].count / baseTotal) * total));
    const list: EnemyKind[] = [];
    if (last) {
      for (const k of ROSTER_ORDER) for (let i = 0; i < (remaining.get(k) ?? 0); i++) list.push(k);
    } else {
      const fr: { k: EnemyKind; f: number }[] = [];
      const pool = left;
      for (const k of ROSTER_ORDER) {
        const r = remaining.get(k) ?? 0;
        if (r <= 0) continue;
        const quota = (r * size) / pool;
        const take = Math.min(r, Math.floor(quota));
        for (let i = 0; i < take; i++) list.push(k);
        remaining.set(k, r - take);
        fr.push({ k, f: quota - take });
      }
      fr.sort((a, b) => b.f - a.f);
      for (const { k } of fr) {
        if (list.length >= size) break;
        const r = remaining.get(k) ?? 0;
        if (r <= 0) continue;
        list.push(k);
        remaining.set(k, r - 1);
      }
    }
    // Interleave kinds so a wave never spawns all of one type first.
    list.sort((a, b) => ROSTER_ORDER.indexOf(a) - ROSTER_ORDER.indexOf(b));
    const mixed: EnemyKind[] = [];
    const byKind = ROSTER_ORDER.map((k) => list.filter((x) => x === k));
    let any = true;
    while (any) {
      any = false;
      for (const arr of byKind) {
        const k = arr.pop();
        if (k) {
          mixed.push(k);
          any = true;
        }
      }
    }
    left -= mixed.length;
    waves.push(mixed);
  }
  return waves;
}
