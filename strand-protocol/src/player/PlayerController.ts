/**
 * STRAND // PROTOCOL — Player controller (§1.3, §2.2, §2.3, §3.3, §3.4, §3.6).
 *
 *  9-state movement FSM (SPAWN = the diagram's entry state [*]):
 *    SPAWN → GROUNDED ⇄ SLIDING → AIRBORNE ⇄ WALL_RUN_L / WALL_RUN_R
 *    any (alive) → GRAPPLE_SWING ⇄ GRAPPLE_PULL → AIRBORNE, any → DEAD
 *  Fixed-step physics (FIXED_DT = 1/120 s), momentum-preserving Source-style air strafing, wall-run with
 *  delayed gravity, wall-kicks, slides that accelerate down ramps, rope pendulum constraint & winch reel.
 *  Air-only bullet time (0.25×) with gauge, out-of-combat regeneration, camera work (speed FOV, BT zoom,
 *  wall-run / slide / swing roll, landing spring), trauma-based camera shake with accessibility scaling.
 *  v1.2: RMB = tactical zoom (equipment) + air bullet time; with a gun zoomed the weapon's FOV offset replaces the
 *  −7° BT offset (never both). An air RMB press that cannot start bullet time (gauge < 12, NO BULLET TIME)
 *  raises onBulletTimeDenied (HUD arc blink). Strand attached from the ground to a higher anchor lifts off at once.
 */
import * as THREE from 'three';
import {
  BULLET_TIME,
  CAMERA,
  DEG2RAD,
  HARD_LANDING_SPEED,
  PHYSICS,
  PLAYER,
  SHAKE,
  SHAKE_DECAY_PER_S,
  SHAKE_FREQUENCY_HZ,
  type ShakeDef,
  clamp,
  lerpFactor,
} from '../config/constants';
import type { InputManager } from '../engine/InputManager';
import { type MoveResult, type PhysicsWorld, type WallFace, copyWallFace, createMoveResult, createWallFace } from '../world/PhysicsWorld';

export type MoveState =
  | 'SPAWN'
  | 'GROUNDED'
  | 'SLIDING'
  | 'CROUCHING'
  | 'MANTLING'
  | 'AIRBORNE'
  | 'WALL_RUN_L'
  | 'WALL_RUN_R'
  | 'GRAPPLE_SWING'
  | 'GRAPPLE_PULL'
  | 'DEAD';

/** FLOW-rank / skill modifiers (set by the progression systems; neutral defaults). */
export interface PlayerModifiers {
  /** Max-speed soft-cap bonus (fraction, FLOW A +8 % … SSS +18 %). */
  maxSpeedBonus: number;
  /** SSS: wall-kick height +10 %. */
  wallKickHeightBonus: number;
  /** SK_05: wall-kick / slide-jump initial boost (fraction). */
  kickBoostBonus: number;
  /** SK_05: extra wall-run time (s). */
  wallRunTimeBonusS: number;
  /** SK_10: bullet-time drain reduction (fraction). */
  btDrainReduction: number;
  /** SK_13: out-of-combat regen delay (ms). */
  regenDelayMs: number;
  /** SK_14: move-speed bonus while HP ≤ 45 (fraction). */
  criticalMoveBonus: number;
  /** Modifier NO BULLET TIME. */
  bulletTimeDisabled: boolean;
  /** 8A-4 SK_07 Shadow Step: crouch move-speed bonus (fraction, +35 / 50 / 65 %). */
  crouchSpeedBonus: number;
}

export interface PlayerEvents {
  onJump?(kind: 'GROUND' | 'COYOTE' | 'SLIDE_JUMP'): void;
  onLand?(fallSpeed: number, water: boolean): void;
  onSlideStart?(): void;
  onWallRunStart?(side: -1 | 1): void;
  onWallKick?(): void;
  /** 7A-6 auto-mantle started (0.22 s pull-up onto a ledge). */
  onMantle?(): void;
  onCrouch?(down: boolean): void;
  onGrappleAttach?(): void;
  onGrappleDetach?(mode: RopeDetach): void;
  onBulletTime?(active: boolean): void;
  /** Air RMB press while bullet time cannot start (gauge < 12 or NO BULLET TIME) — zoom only. */
  onBulletTimeDenied?(): void;
  onRegenStart?(): void;
  onDamaged?(amount: number): void;
  onDeath?(): void;
}

export type RopeDetach = 'RELEASE' | 'CUT' | 'REFIRE' | 'ARRIVED';

/** Per-step context provided by the equipment system (exclusive gun / grapple rules). */
export interface PlayerStepContext {
  /** The grapple launcher is the active slot (reel-in only allowed then). */
  grappleEquipped: boolean;
  /** LMB held with the grapple equipped. */
  reelHeld: boolean;
}

export interface AccessibilitySettings {
  /** 0 / 0.5 / 1 */
  shakeScale: number;
  /** 0 / 0.5 / 1 */
  rollScale: number;
  /** Base FOV 75–100 (default 84). */
  baseFov: number;
}

// Scratch
const _wish = new THREE.Vector3();
const _hv = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _right = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _rope = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const UP = new THREE.Vector3(0, 1, 0);

const _along = new THREE.Vector3();
const SIN_ENTRY = Math.sin((PHYSICS.WALLRUN_MAX_ENTRY_DEG * Math.PI) / 180);
const SIN_VIEW = Math.sin((PHYSICS.WALLRUN_MAX_VIEW_DEG * Math.PI) / 180);
const sstepP = (x: number): number => {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
};
/** 7A-6 mantle camera lean (deg). */
const MANTLE_ROLL_DEG = 3.5;
const AIR_STATES: ReadonlySet<MoveState> = new Set<MoveState>(['AIRBORNE', 'WALL_RUN_L', 'WALL_RUN_R', 'GRAPPLE_SWING', 'GRAPPLE_PULL']);
/** Rope attaches at the player's chest/winch height above the feet. */
const ROPE_ATTACH_Y = 1.2;
/** 5A-4: ground attach to an anchor > 2.2 m above the feet lifts off with vy ≥ 4.2 m/s. */
const GROUND_ATTACH_MIN_RISE = 2.2;
const GROUND_ATTACH_LIFT = 4.2;

export class PlayerController {
  // ---- kinematic state (feet position) ----
  readonly position = new THREE.Vector3();
  readonly prevPosition = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  state: MoveState = 'SPAWN';
  /** View yaw / pitch (rad), driven by the mouse in real time. */
  yaw = 0;
  pitch = 0;
  /** Weapon recoil offsets (deg), recovering at the weapon's rate. */
  recoilPitchDeg = 0;
  recoilYawDeg = 0;
  private recoilRecoverDegPerS = 14;

  // ---- durability ----
  hp: number = PLAYER.MAX_HP;
  maxHp: number = PLAYER.MAX_HP;
  /** Simulation-time stamps (s) of the last shot fired / damage taken. */
  lastAttackTime = -1e9;
  lastDamageTime = -1e9;
  private regenerating = false;
  /** SK_07: gravity halved until this sim time. */
  private hoverUntil = -1;
  /** SK_11: speed boost amount (m/s) and expiry. */
  private boostAmount = 0;
  private boostUntil = -1;

  // ---- bullet time ----
  btGauge: number = BULLET_TIME.MAX_GAUGE;
  btActive = false;
  private airRmbPrev = false;

  // ---- tactical zoom (written by the equipment each frame) ----
  /** Blended weapon zoom FOV offset (deg, ≤ 0). */
  zoomFovDeg = 0;
  /** 8A-3 magnified optic: absolute ADS FOV (deg) and its 0..1 blend over the unzoomed FOV. */
  zoomAbsFov = 0;
  zoomAbsBlend = 0;
  /** A gun zoom is engaged: the −7° bullet-time FOV offset is not added on top. */
  gunZoom = false;

  // ---- rope ----
  ropeAttached = false;
  readonly ropeAnchor = new THREE.Vector3();
  ropeLength = 0;
  /** 0..1 rope tension (drives the strand's cyan → white-hot colour). */
  ropeTension = 0;

  // ---- timers (simulation seconds) ----
  simTime = 0;
  private coyoteUntil = -1;
  private wallCoyoteUntil = -1;
  private readonly wallCoyoteNormal = new THREE.Vector3();
  private readonly wallCoyoteTangent = new THREE.Vector3();
  private wallCoyoteSpeed = 0;
  private slideReadyAt = 0;
  // 7A-6 auto-mantle
  private mantleT = 0;
  private mantleExit = 0;
  /** Highest point of the pull-up (rail top when vaulting onto a balcony / landing). */
  private mantleApex = 0;
  private readonly mantleFrom = new THREE.Vector3();
  private readonly mantleTo = new THREE.Vector3();
  private readonly mantleDir = new THREE.Vector3();
  private wallTime = 0;
  /** 6B-2: the wall face being run (copied from the dynamic detection; refreshed every step). */
  private readonly wallFace: WallFace = createWallFace();
  private wallLostFor = 0;
  private readonly prevPos = new THREE.Vector3();
  /**
   * 6B-2 ④: a steep (> 35° off parallel) airborne impact taints that wall normal until the player leaves the
   * wall or lands — collision response alone would otherwise turn a head-on hit into a parallel slide that
   * passes the angle test on the next step.
   */
  private bonkActive = false;
  private readonly bonkNormal = new THREE.Vector3();
  private readonly wallNormal = new THREE.Vector3();
  private readonly wallTangent = new THREE.Vector3();
  private wallSpeed = 0;
  private lastWallCollider = -1;
  private readonly lastWallNormal = new THREE.Vector3();
  private lastWallEndedAt = -1e9;
  private grounded = false;
  private inWater = false;
  private colliderHeight: number = PLAYER.HEIGHT;
  private readonly move: MoveResult = createMoveResult();
  private readonly ropeMove: MoveResult = createMoveResult();
  private fallSpeedBeforeLanding = 0;

  // ---- camera ----
  private eyeHeight: number = PLAYER.EYE_HEIGHT;
  private roll = 0;
  private fov: number = CAMERA.BASE_FOV;
  private fovPulse = 0;
  private dipX = 0;
  private dipV = 0;
  private trauma = 0;
  private shakeMaxPitchYaw = 0;
  private shakeMaxRoll = 0;
  private shakeTime = 0;
  private swingRollTarget = 0;
  /** 10A-3b: organic figure-8 stride head-bob phase, blend, ADS blend, and current gait offsets. */
  stridePhase = 0;
  strideBlend = 0;
  adsBlend = 0;
  strideBobY = 0;
  strideBobX = 0;
  strideBobRoll = 0;
  /** 10A-3b: physical spring-damper gunshot recoil camera kick (pitch/roll in rad, Z in m). */
  kickPitch = 0;
  kickRoll = 0;
  kickZ = 0;
  kickPitchV = 0;
  kickRollV = 0;
  kickZV = 0;
  kickSpringK = 260;
  kickSpringC = 28;
  private kickRollSign = 1;
  readonly eye = new THREE.Vector3();
  /** Final camera Euler angles (rad) after recoil, shake and roll. */
  readonly cameraEuler = new THREE.Euler(0, 0, 0, 'YXZ');

  readonly modifiers: PlayerModifiers = {
    maxSpeedBonus: 0,
    wallKickHeightBonus: 0,
    kickBoostBonus: 0,
    wallRunTimeBonusS: 0,
    btDrainReduction: 0,
    regenDelayMs: PLAYER.REGEN_DELAY_MS,
    criticalMoveBonus: 0,
    bulletTimeDisabled: false,
    crouchSpeedBonus: 0,
  };
  readonly settings: AccessibilitySettings = { shakeScale: 1, rollScale: 1, baseFov: CAMERA.BASE_FOV };

  constructor(
    private readonly input: InputManager,
    private readonly physics: PhysicsWorld,
    readonly events: PlayerEvents = {},
  ) {}

  // ===============================================================================================
  // Lifecycle
  // ===============================================================================================
  spawn(pos: THREE.Vector3, yaw: number): void {
    this.position.copy(pos);
    this.prevPosition.copy(pos);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = 0;
    this.recoilPitchDeg = 0;
    this.recoilYawDeg = 0;
    this.hp = this.maxHp;
    this.lastAttackTime = -1e9;
    this.lastDamageTime = -1e9;
    this.regenerating = false;
    this.btGauge = BULLET_TIME.MAX_GAUGE;
    if (this.btActive) this.setBulletTime(false);
    this.ropeAttached = false;
    this.ropeTension = 0;
    this.state = 'SPAWN';
    this.colliderHeight = PLAYER.HEIGHT;
    this.eyeHeight = PLAYER.EYE_HEIGHT;
    this.roll = 0;
    this.dipX = 0;
    this.dipV = 0;
    this.trauma = 0;
    this.stridePhase = 0;
    this.strideBlend = 0;
    this.strideBobY = 0;
    this.strideBobX = 0;
    this.strideBobRoll = 0;
    this.kickPitch = 0;
    this.kickRoll = 0;
    this.kickZ = 0;
    this.kickPitchV = 0;
    this.kickRollV = 0;
    this.kickZV = 0;
    this.fov = this.settings.baseFov;
    this.lastWallCollider = -1;
    this.wallLostFor = 0;
    this.bonkActive = false;
    this.hoverUntil = -1;
    this.boostUntil = -1;
  }

  get isAlive(): boolean {
    return this.state !== 'DEAD';
  }

  get isGrounded(): boolean {
    return this.grounded;
  }

  get isInWater(): boolean {
    return this.inWater;
  }

  /** Airborne in the bullet-time sense: mid-air, wall-running or on the rope (not standing on ground). */
  get isAirborne(): boolean {
    return AIR_STATES.has(this.state) && !this.grounded;
  }

  get isWallRunning(): boolean {
    return this.state === 'WALL_RUN_L' || this.state === 'WALL_RUN_R';
  }

  get isSwinging(): boolean {
    return this.state === 'GRAPPLE_SWING' || this.state === 'GRAPPLE_PULL';
  }

  get isSliding(): boolean {
    return this.state === 'SLIDING';
  }

  get isCrouching(): boolean {
    return this.state === 'CROUCHING';
  }

  get isMantling(): boolean {
    return this.state === 'MANTLING';
  }

  /** Player simulation clock (s) — the base of lastAttackTime / lastDamageTime (7B-8 adaptive HUD). */
  get clockS(): number {
    return this.simTime;
  }

  /** 0 → 1 progress of the running auto-mantle (−1 when not mantling). */
  get mantleProgress(): number {
    return this.state === 'MANTLING' ? clamp(this.mantleT / PHYSICS.MANTLE_DURATION_S, 0, 1) : -1;
  }

  /** 7A-6: sliding, crouching or stuck low under a ceiling — the 0.98 m body enemies aim at. */
  get isLowProfile(): boolean {
    return this.state === 'SLIDING' || this.state === 'CROUCHING' || this.colliderHeight < PLAYER.HEIGHT;
  }

  get speed(): number {
    return this.velocity.length();
  }

  get isCritical(): boolean {
    return this.hp <= PLAYER.CRITICAL_HP;
  }

  get isRegenerating(): boolean {
    return this.regenerating;
  }

  /** Sliding downhill on an on-ramp (speed-line boost, 5B-5). */
  get isRampSliding(): boolean {
    return this.state === 'SLIDING' && this.move.rampIndex >= 0 && this.velocity.dot(this.move.downhill) > 1;
  }

  /** SK_11 zero-time speed boost running (HUD buff tag). */
  get speedBoostActive(): boolean {
    return this.boostAmount > 0 && this.simTime < this.boostUntil;
  }

  /** 0 → 1 progress of the out-of-combat regen countdown (1 = regenerating / full). */
  get regenCountdown(): number {
    const since = (this.simTime - Math.max(this.lastAttackTime, this.lastDamageTime)) * 1000;
    return clamp(since / this.modifiers.regenDelayMs, 0, 1);
  }

  // ===============================================================================================
  // View
  // ===============================================================================================
  /** Mouse look in real time (never scaled by bullet time / hitstop). */
  applyLook(yawDelta: number, pitchDelta: number): void {
    if (this.state === 'DEAD') return;
    this.yaw += yawDelta;
    this.pitch = clamp(this.pitch + pitchDelta, -89 * DEG2RAD, 89 * DEG2RAD);
  }

  /** Aim direction including recoil (what guns fire along). */
  aimDirection(out: THREE.Vector3): THREE.Vector3 {
    _euler.set(this.pitch + this.recoilPitchDeg * DEG2RAD, this.yaw + this.recoilYawDeg * DEG2RAD, 0, 'YXZ');
    return out.set(0, 0, -1).applyEuler(_euler);
  }

  /** Pure look direction (grapple snap / anchor lock display). */
  viewDirection(out: THREE.Vector3): THREE.Vector3 {
    _euler.set(this.pitch, this.yaw, 0, 'YXZ');
    return out.set(0, 0, -1).applyEuler(_euler);
  }

  /** Current physics eye position (non-interpolated) — origin for shots and grapple. */
  eyePosition(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.position).setY(this.position.y + this.eyeHeight);
  }

  ropeAttachPoint(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.position).setY(this.position.y + ROPE_ATTACH_Y);
  }

  addRecoil(verticalDeg: number, horizontalDeg: number, recoverDegPerS: number): void {
    this.recoilPitchDeg += verticalDeg;
    this.recoilYawDeg += horizontalDeg;
    this.recoilRecoverDegPerS = recoverDegPerS;
  }

  /** Camera shake (§2.2): trauma accumulates (max 1), displacement = trauma². `scale` < 1 while zoomed. */
  addTrauma(def: ShakeDef, scale = 1): void {
    this.trauma = Math.min(1, this.trauma + def.trauma * scale);
    // The strongest active event defines the angular envelope until the trauma has fully decayed.
    this.shakeMaxPitchYaw = Math.max(this.shakeMaxPitchYaw, def.maxPitchYawDeg);
    this.shakeMaxRoll = Math.max(this.shakeMaxRoll, def.maxRollDeg);
  }

  /** Brief FOV pulse: widening (HS kill +2.5°) or a micro zoom-in (negative, boss finisher). Largest magnitude wins. */
  pulseFov(deg: number): void {
    if (Math.abs(deg) > Math.abs(this.fovPulse)) this.fovPulse = deg;
  }

  /**
   * 10A-3b: physical spring-damper gunshot recoil camera kick (`kickPitch`, `kickRoll`, `kickZ` + sniper FOV punch).
   *  - MK-IV Rail Pistol: +0.85° hip / +0.55° ADS upward pitch snap, +0.45° clockwise roll flick, -0.016 m Z-punch (k=260, c=28).
   *  - K-90 Rail Sniper: +2.4° hip / +1.4° ADS upward pitch kick, ±1.1° roll whip, -0.048 m Z-punch, +1.8° FOV punch (k=175, c=21).
   */
  onWeaponKick(gunId: 'PISTOL' | 'SNIPER', ads = false): void {
    const ss = this.settings.shakeScale;
    const rs = this.settings.rollScale;
    if (gunId === 'PISTOL') {
      this.kickSpringK = 260;
      this.kickSpringC = 28;
      this.kickPitch += (ads ? 0.55 : 0.85) * DEG2RAD * ss;
      this.kickRoll += 0.45 * DEG2RAD * rs;
      this.kickZ += -0.016 * ss;
    } else {
      this.kickSpringK = 175;
      this.kickSpringC = 21;
      this.kickPitch += (ads ? 1.4 : 2.4) * DEG2RAD * ss;
      this.kickRoll += this.kickRollSign * 1.1 * DEG2RAD * rs;
      this.kickRollSign = -this.kickRollSign;
      this.kickZ += -0.048 * ss;
      this.pulseFov(1.8 * ss);
    }
  }

  // ===============================================================================================
  // Combat hooks
  // ===============================================================================================
  /** Firing a gun resets the out-of-combat regen timer (wire / wall-run / slide / switch / reload do not). */
  notifyFired(): void {
    this.lastAttackTime = this.simTime;
    this.regenerating = false;
  }

  takeDamage(amount: number): void {
    if (this.state === 'DEAD') return;
    this.hp = Math.max(0, this.hp - amount);
    this.lastDamageTime = this.simTime;
    this.regenerating = false;
    this.addTrauma(SHAKE.PLAYER_HIT);
    this.events.onDamaged?.(amount);
    if (this.hp <= 0) this.die();
  }

  die(): void {
    if (this.state === 'DEAD') return;
    if (this.ropeAttached) this.detachRope('CUT');
    if (this.btActive) this.setBulletTime(false);
    this.state = 'DEAD';
    this.velocity.set(0, 0, 0);
    this.events.onDeath?.();
  }

  /** External impulse (shotgun recoil jump). Leaves the ground if the impulse has an upward component. */
  addImpulse(v: THREE.Vector3): void {
    this.velocity.add(v);
    if (v.y > 0.5 && (this.state === 'GROUNDED' || this.state === 'SLIDING' || this.state === 'CROUCHING')) {
      this.state = 'AIRBORNE';
      this.grounded = false;
    }
  }

  addBulletTimeGauge(amount: number): void {
    this.btGauge = clamp(this.btGauge + amount, 0, BULLET_TIME.MAX_GAUGE);
  }

  // ===============================================================================================
  // Rope
  // ===============================================================================================
  attachRope(anchor: THREE.Vector3): void {
    if (this.state === 'DEAD') return;
    this.ropeAttached = true;
    this.ropeAnchor.copy(anchor);
    this.ropeLength = Math.max(PHYSICS.GRAPPLE_MIN_LENGTH, this.ropeAttachPoint(_tmp).distanceTo(anchor));
    this.state = 'GRAPPLE_SWING';
    // 5A-4: hooked from the ground onto something higher → a light lift straight into the pendulum / reel.
    if (this.grounded && anchor.y > this.position.y + GROUND_ATTACH_MIN_RISE) {
      this.grounded = false;
      this.velocity.y = Math.max(this.velocity.y, GROUND_ATTACH_LIFT);
    }
    this.addTrauma(SHAKE.ANCHOR_IMPACT);
    this.events.onGrappleAttach?.();
  }

  /**
   * Detach the rope. RELEASE (Space): +7.5 m/s up and +6.0 m/s along the view; CUT (Ctrl/C) and REFIRE:
   * no boost; ARRIVED (reeled to 3 m): +8.0 m/s up.
   */
  detachRope(mode: RopeDetach): void {
    if (!this.ropeAttached) return;
    this.ropeAttached = false;
    this.ropeTension = 0;
    if (mode === 'RELEASE') {
      this.viewDirection(_tmp);
      this.velocity.addScaledVector(UP, PHYSICS.GRAPPLE_RELEASE_UP_BOOST).addScaledVector(_tmp, PHYSICS.GRAPPLE_RELEASE_FORWARD_BOOST);
    } else if (mode === 'ARRIVED') {
      this.velocity.y += PHYSICS.GRAPPLE_END_UP_BOOST;
    }
    if (this.state !== 'DEAD') this.state = this.grounded && mode !== 'RELEASE' && mode !== 'ARRIVED' ? 'GROUNDED' : 'AIRBORNE';
    this.events.onGrappleDetach?.(mode);
  }

  // ===============================================================================================
  // Bullet time (real time): air only, RMB held, gauge ≥ 12 to start
  // ===============================================================================================
  private setBulletTime(on: boolean): void {
    if (this.btActive === on) return;
    this.btActive = on;
    this.events.onBulletTime?.(on);
  }

  updateBulletTime(realDt: number): void {
    const airRmb = this.input.isDown('BULLET_TIME') && this.isAirborne && this.state !== 'DEAD';
    const want = !this.modifiers.bulletTimeDisabled && airRmb;
    if (this.btActive) {
      this.btGauge -= BULLET_TIME.DRAIN_PER_REAL_S * (1 - this.modifiers.btDrainReduction) * realDt;
      if (this.btGauge <= 0 || !want) {
        this.btGauge = Math.max(0, this.btGauge);
        this.setBulletTime(false);
      }
    } else if (want && this.btGauge >= BULLET_TIME.MIN_ACTIVATE) {
      this.setBulletTime(true);
    }
    // Air press (or leaving the ground with RMB held) that could not start bullet time → zoom only + HUD blink.
    if (airRmb && !this.airRmbPrev && !this.btActive) this.events.onBulletTimeDenied?.();
    this.airRmbPrev = airRmb;
    if (!this.btActive) this.btGauge = Math.min(BULLET_TIME.MAX_GAUGE, this.btGauge + BULLET_TIME.REGEN_PER_S * realDt);
  }

  get timeScaleRequest(): number {
    return this.btActive ? BULLET_TIME.TIME_SCALE : 1;
  }

  // ===============================================================================================
  // Fixed-step simulation
  // ===============================================================================================
  fixedUpdate(dt: number, ctx: PlayerStepContext): void {
    this.simTime += dt;
    this.prevPosition.copy(this.position);
    if (this.state === 'DEAD') return;

    // Out-of-combat regeneration.
    this.updateRegen(dt);

    // Wish direction (horizontal, relative to view yaw).
    _fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    _wish.set(0, 0, 0).addScaledVector(_fwd, this.input.moveZ).addScaledVector(_right, this.input.moveX);
    if (_wish.lengthSq() > 1) _wish.normalize();

    if (this.state === 'SPAWN') {
      this.grounded = false;
      this.state = 'AIRBORNE';
    }

    switch (this.state) {
      case 'GROUNDED':
        this.stepGrounded(dt);
        break;
      case 'SLIDING':
        this.stepSliding(dt);
        break;
      case 'CROUCHING':
        this.stepCrouching(dt);
        break;
      case 'MANTLING':
        this.stepMantle(dt);
        break;
      case 'AIRBORNE':
        this.stepAirborne(dt);
        break;
      case 'WALL_RUN_L':
      case 'WALL_RUN_R':
        this.stepWallRun(dt);
        break;
      case 'GRAPPLE_SWING':
      case 'GRAPPLE_PULL':
        this.stepGrapple(dt, ctx);
        break;
      default:
        break;
    }

    // 7A-6: the mantle is kinematic (its path was verified free) — no integration / collision this step.
    if (this.state === 'MANTLING') {
      this.postMoveTransitions(this.grounded, dt);
      return;
    }

    // Soft speed cap: only the excess above 34 m/s (SSS 40.1) is dragged at 1.8 /s.
    const cap = PHYSICS.SOFT_SPEED_CAP * (1 + this.modifiers.maxSpeedBonus) + this.activeBoost();
    const sp = this.velocity.length();
    if (sp > cap) this.velocity.multiplyScalar((cap + (sp - cap) * Math.exp(-PHYSICS.SOFT_CAP_DRAG * dt)) / sp);

    // Integrate with collisions.
    const wasGrounded = this.grounded;
    this.fallSpeedBeforeLanding = -this.velocity.y;
    _delta.copy(this.velocity).multiplyScalar(dt);
    this.prevPos.copy(this.position);
    this.physics.movePlayer(this.position, PLAYER.RADIUS, this.colliderHeight, _delta, wasGrounded, this.move);
    this.resolveVelocity(dt);

    // Rope constraint after movement.
    if (this.ropeAttached) this.applyRopeConstraint(dt);

    this.postMoveTransitions(wasGrounded, dt);

    // Safety: anything that escapes below the canal bed respawns via death handling upstream.
    if (this.position.y < -20) this.die();
  }

  private updateRegen(dt: number): void {
    if (this.hp <= 0 || this.hp >= this.maxHp) {
      this.regenerating = false;
      return;
    }
    const since = (this.simTime - Math.max(this.lastAttackTime, this.lastDamageTime)) * 1000;
    if (since >= this.modifiers.regenDelayMs) {
      if (!this.regenerating) {
        this.regenerating = true;
        this.events.onRegenStart?.();
      }
      this.hp = Math.min(this.maxHp, this.hp + PLAYER.REGEN_RATE_HP_PER_S * dt);
    } else {
      this.regenerating = false;
    }
  }

  private runSpeed(): number {
    let s: number = this.state === 'CROUCHING' ? PHYSICS.CROUCH_SPEED * (1 + this.modifiers.crouchSpeedBonus) : PHYSICS.RUN_SPEED;
    if (this.inWater) s *= PHYSICS.CANAL_SPEED_MULT;
    if (this.isCritical) s *= 1 + this.modifiers.criticalMoveBonus;
    return s + this.activeBoost();
  }

  /** SK_07 blast thruster: 0.35 s at half gravity after a shotgun air recoil jump. */
  private gravityScale(): number {
    return this.simTime < this.hoverUntil ? 0.5 : 1;
  }

  private activeBoost(): number {
    return this.simTime < this.boostUntil ? this.boostAmount : 0;
  }

  /** SK_07: halves gravity for `seconds` of simulation time. */
  hover(seconds: number): void {
    this.hoverUntil = Math.max(this.hoverUntil, this.simTime + seconds);
  }

  /**
   * SK_11 zero-time bonus: +`amount` m/s along the current horizontal motion (or the view when nearly still);
   * for `seconds` the run-speed target and the soft cap are raised by the same amount so it is not damped away.
   */
  speedBoost(amount: number, seconds: number): void {
    if (this.state === 'DEAD') return;
    _tmp.set(this.velocity.x, 0, this.velocity.z);
    if (_tmp.lengthSq() < 4) _tmp.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    _tmp.normalize();
    this.velocity.addScaledVector(_tmp, amount);
    this.boostAmount = amount;
    this.boostUntil = this.simTime + seconds;
  }

  /** Ground acceleration (75 m/s²) toward wish × run speed; friction 10 /s; excess speed decays smoothly. */
  private groundMove(dt: number): void {
    _hv.set(this.velocity.x, 0, this.velocity.z);
    const speed = _hv.length();
    const maxRun = this.runSpeed();
    const hasWish = _wish.lengthSq() > 1e-4;
    if (hasWish) {
      if (speed > maxRun + 0.01) {
        const newSpeed = maxRun + (speed - maxRun) * Math.exp(-PHYSICS.GROUND_FRICTION * dt);
        _tmp.copy(_wish).normalize().multiplyScalar(speed);
        moveTowards(_hv, _tmp, PHYSICS.GROUND_ACCEL * dt);
        if (_hv.lengthSq() > 1e-6) _hv.setLength(newSpeed);
      } else {
        _tmp.copy(_wish).multiplyScalar(maxRun);
        moveTowards(_hv, _tmp, PHYSICS.GROUND_ACCEL * dt);
      }
    } else {
      _hv.multiplyScalar(Math.exp(-PHYSICS.GROUND_FRICTION * dt));
      if (_hv.lengthSq() < 0.0025) _hv.set(0, 0, 0);
    }
    this.velocity.x = _hv.x;
    this.velocity.z = _hv.z;
    // Stick to the ground / ramp surface.
    this.velocity.y = -2.0;
  }

  private stepGrounded(dt: number): void {
    this.colliderHeight = PLAYER.HEIGHT;
    this.groundMove(dt);
    if (this.input.consumeBuffered('JUMP')) {
      this.doJump('GROUND');
      return;
    }
    _hv.set(this.velocity.x, 0, this.velocity.z);
    if (_hv.length() >= PHYSICS.SLIDE_MIN_ENTER_SPEED && this.simTime >= this.slideReadyAt && this.input.consumeBuffered('SLIDE')) {
      this.startSlide();
      return;
    }
    // 7A-6: below slide speed, holding Ctrl / C crouches.
    if (_hv.length() < PHYSICS.CROUCH_MAX_ENTER_SPEED && this.input.isDown('SLIDE')) {
      this.input.consumeBuffered('SLIDE');
      this.startCrouch();
    }
  }

  private startCrouch(): void {
    this.state = 'CROUCHING';
    this.colliderHeight = PLAYER.SLIDE_HEIGHT;
    this.events.onCrouch?.(true);
  }

  /**
   * 7A-6 crouch: 0.98 m body, 1.05 m eyes, 5.0 m/s; release Ctrl / C to stand once there is headroom
   * (canStand). Space jumps (when standing room exists); a fresh Ctrl / C tap at slide speed slides.
   */
  private stepCrouching(dt: number): void {
    this.colliderHeight = PLAYER.SLIDE_HEIGHT;
    this.groundMove(dt);
    const stand = this.canStand();
    if (stand && this.input.consumeBuffered('JUMP')) {
      this.colliderHeight = PLAYER.HEIGHT;
      this.events.onCrouch?.(false);
      this.doJump('GROUND');
      return;
    }
    if (!this.input.isDown('SLIDE') && stand) {
      this.state = 'GROUNDED';
      this.colliderHeight = PLAYER.HEIGHT;
      this.events.onCrouch?.(false);
    }
  }

  private doJump(kind: 'GROUND' | 'COYOTE'): void {
    this.velocity.y = PHYSICS.JUMP_VELOCITY;
    this.state = 'AIRBORNE';
    this.grounded = false;
    this.coyoteUntil = -1;
    this.events.onJump?.(kind);
  }

  private startSlide(): void {
    _hv.set(this.velocity.x, 0, this.velocity.z);
    if (_hv.lengthSq() < 1e-6) return;
    _hv.setLength(_hv.length() + PHYSICS.SLIDE_BOOST);
    this.velocity.x = _hv.x;
    this.velocity.z = _hv.z;
    this.state = 'SLIDING';
    this.colliderHeight = PLAYER.SLIDE_HEIGHT;
    this.slideReadyAt = this.simTime + PHYSICS.SLIDE_COOLDOWN;
    this.events.onSlideStart?.();
  }

  private stepSliding(dt: number): void {
    this.colliderHeight = PLAYER.SLIDE_HEIGHT;
    _hv.set(this.velocity.x, 0, this.velocity.z);
    let speed = _hv.length();
    const dir = speed > 1e-4 ? _tmp.copy(_hv).divideScalar(speed) : _tmp.copy(_fwd);
    // Downhill (on-ramps): no decay, +9 m/s² along the slope.
    const downhill = this.move.rampIndex >= 0 ? dir.dot(this.move.downhill) : 0;
    if (downhill > 0.2) {
      _hv.addScaledVector(this.move.downhill, PHYSICS.SLIDE_SLOPE_ACCEL * dt);
      speed = _hv.length();
    } else {
      speed *= Math.exp(-PHYSICS.SLIDE_DECAY * dt);
      _hv.setLength(speed);
    }
    // Light steering toward the wish direction without adding speed.
    if (_wish.lengthSq() > 1e-4 && speed > 1e-3) {
      _tmp2.copy(_wish).normalize();
      const turn = Math.min(1, 1.6 * dt);
      _hv.divideScalar(speed).lerp(_tmp2, turn).normalize().multiplyScalar(speed);
    }
    this.velocity.x = _hv.x;
    this.velocity.z = _hv.z;
    this.velocity.y = -2.0;

    if (this.input.consumeBuffered('JUMP')) {
      // Slide jump: vertical 11.4 + horizontal +2.5 (SK_05 boosts).
      const k = 1 + this.modifiers.kickBoostBonus;
      if (speed > 1e-3) _hv.setLength(speed + PHYSICS.SLIDE_JUMP_HORIZONTAL * k);
      this.velocity.x = _hv.x;
      this.velocity.z = _hv.z;
      this.velocity.y = PHYSICS.SLIDE_JUMP_VERTICAL * k;
      this.state = 'AIRBORNE';
      this.grounded = false;
      this.events.onJump?.('SLIDE_JUMP');
      return;
    }
    if ((speed < PHYSICS.SLIDE_EXIT_SPEED || !this.input.isDown('SLIDE')) && this.canStand()) {
      // 7A-6: a slide that runs out with Ctrl / C still held settles into a crouch.
      if (this.input.isDown('SLIDE')) this.startCrouch();
      else {
        this.state = 'GROUNDED';
        this.colliderHeight = PLAYER.HEIGHT;
      }
    } else if (speed < PHYSICS.SLIDE_EXIT_SPEED) {
      this.startCrouch();
    }
  }

  private canStand(): boolean {
    return this.physics.boxFree(this.position, PLAYER.RADIUS, PLAYER.HEIGHT);
  }

  /** Source-style air strafe: the wish-projected speed is capped at 11.5 m/s, momentum is never removed. */
  private airStrafe(dt: number, accel: number): void {
    if (_wish.lengthSq() < 1e-4) return;
    _tmp.copy(_wish).normalize();
    _hv.set(this.velocity.x, 0, this.velocity.z);
    const cur = _hv.dot(_tmp);
    const add = PHYSICS.AIR_STRAFE_SPEED_LIMIT - cur;
    if (add <= 0) return;
    const a = Math.min(add, accel * dt);
    this.velocity.x += _tmp.x * a;
    this.velocity.z += _tmp.z * a;
  }

  private stepAirborne(dt: number): void {
    this.colliderHeight = this.colliderHeight < PLAYER.HEIGHT && !this.canStand() ? PLAYER.SLIDE_HEIGHT : PLAYER.HEIGHT;
    this.velocity.y += PHYSICS.GRAVITY * this.gravityScale() * dt;
    this.airStrafe(dt, PHYSICS.AIR_ACCEL);

    // Coyote jumps (ledge 140 ms / wall-run end 160 ms).
    if (this.simTime <= this.wallCoyoteUntil && this.input.consumeBuffered('JUMP')) {
      this.wallKick(this.wallCoyoteNormal, this.wallCoyoteTangent, this.wallCoyoteSpeed);
      return;
    }
    if (this.simTime <= this.coyoteUntil && this.input.consumeBuffered('JUMP')) {
      this.doJump('COYOTE');
      return;
    }

    // 7A-6 auto-mantle: W or Space held and a ledge 0.55 … 2.15 m above the feet within 0.55 m ahead.
    if ((this.input.moveZ > 0 || this.input.isDown('JUMP')) && !this.grounded && this.tryMantle()) return;

    // 6B-2 anywhere parallel wall-run: ② W held (① airborne, checked inside).
    if (this.input.moveZ > 0 && !this.grounded) this.tryStartWallRun();
  }

  /** 7A-6: probes for a ledge straight ahead (view yaw) and starts the 0.22 s pull-up onto it. */
  private tryMantle(): boolean {
    _fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const kind = this.physics.findLedge(this.position, _fwd, PLAYER.RADIUS, PLAYER.HEIGHT, PHYSICS.MANTLE_MIN_RISE, PHYSICS.MANTLE_MAX_RISE, PHYSICS.MANTLE_REACH, this.mantleTo);
    if (!kind) return false;
    this.mantleFrom.copy(this.position);
    this.mantleApex = this.physics.ledgeApex;
    this.mantleDir.copy(_fwd);
    _hv.set(this.velocity.x, 0, this.velocity.z);
    this.mantleExit = Math.max(PHYSICS.MANTLE_EXIT_SPEED, _hv.dot(_fwd));
    this.mantleT = 0;
    this.state = 'MANTLING';
    this.colliderHeight = PLAYER.HEIGHT;
    this.velocity.set(0, 0, 0);
    this.wallCoyoteUntil = -1;
    this.coyoteUntil = -1;
    this.events.onMantle?.();
    return true;
  }

  /**
   * 7A-6 mantle: kinematic pull-up — height leads (ease-out), the forward step follows (ease-in), so the body
   * clears the edge before moving over it. Ends grounded with ≥ 6.5 m/s forward.
   */
  private stepMantle(dt: number): void {
    this.mantleT += dt;
    const t = clamp(this.mantleT / PHYSICS.MANTLE_DURATION_S, 0, 1);
    const u = Math.min(1, t / 0.7);
    const ty = 1 - (1 - u) * (1 - u);
    const w = clamp((t - 0.35) / 0.65, 0, 1);
    const th = w * w * (3 - 2 * w);
    const a = this.mantleFrom;
    const b = this.mantleTo;
    // Rise to the apex (ledge top, or the rail top when vaulting), then settle onto the standing height.
    const apex = Math.max(this.mantleApex, b.y);
    const y = t < 0.7 ? a.y + (apex - a.y) * ty : apex + (b.y - apex) * sstepP((t - 0.7) / 0.3);
    _tmp.set(a.x + (b.x - a.x) * th, y, a.z + (b.z - a.z) * th);
    this.velocity.subVectors(_tmp, this.position).divideScalar(Math.max(dt, 1e-4));
    this.position.copy(_tmp);
    if (t >= 1) {
      this.position.copy(b);
      this.velocity.copy(this.mantleDir).multiplyScalar(this.mantleExit);
      this.velocity.y = 0;
    }
  }

  /**
   * 6B-2 entry — every condition at once, otherwise nothing happens (no sticking when still, walking along
   * a wall or hitting it head-on):
   *  ① airborne with ≥ 0.35 m free fall under the feet · ② W held (caller) · ③ along-wall speed ≥ 6.5 m/s ·
   *  ④ travel within ±35° of the wall (|v̂·n| ≤ sin 35°) · ⑤ view within ±52° of the wall and looking the way of
   *  travel · ⑥ not the same collider + normal (dot > 0.95) within 0.5 s of the last run (other walls chain).
   */
  private tryStartWallRun(): void {
    _hv.set(this.velocity.x, 0, this.velocity.z);
    const hs = _hv.length();
    if (hs < PHYSICS.WALLRUN_MIN_ALONG_SPEED) return;
    const n = this.physics.findWallFaces(this.position, this.colliderHeight, _right);
    if (this.bonkActive) {
      let still = false;
      for (let i = 0; i < n; i++) if (this.physics.wallFace(i).normal.dot(this.bonkNormal) > 0.95) still = true;
      if (!still) this.bonkActive = false;
    }
    if (n === 0) return;
    if (this.physics.groundClearance(this.position, 1.0) < PHYSICS.WALLRUN_MIN_GROUND_CLEARANCE) return;
    _fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    for (let i = 0; i < n; i++) {
      const f = this.physics.wallFace(i);
      const vn = _hv.x * f.normal.x + _hv.z * f.normal.z;
      _along.set(_hv.x - vn * f.normal.x, 0, _hv.z - vn * f.normal.z);
      const along = _along.length();
      if (along < PHYSICS.WALLRUN_MIN_ALONG_SPEED) continue;
      if (Math.abs(vn) / hs > SIN_ENTRY) continue;
      const fn = _fwd.x * f.normal.x + _fwd.z * f.normal.z;
      if (Math.abs(fn) > SIN_VIEW || _fwd.x * _along.x + _fwd.z * _along.z <= 0) continue;
      if (this.bonkActive && f.normal.dot(this.bonkNormal) > 0.95) continue;
      const sameWall = f.collider === this.lastWallCollider && f.normal.dot(this.lastWallNormal) > 0.95;
      if (sameWall && this.simTime - this.lastWallEndedAt < PHYSICS.WALLRUN_SAME_WALL_COOLDOWN) continue;
      this.startWallRun(f, along);
      return;
    }
  }

  /** Starts on face `f`; `_along` holds the along-wall velocity. Speed ≥ 13.5 m/s, faster entries keep theirs. */
  private startWallRun(f: WallFace, along: number): void {
    copyWallFace(f, this.wallFace);
    this.wallNormal.copy(f.normal);
    this.wallTangent.copy(_along).divideScalar(Math.max(along, 1e-4));
    this.wallSpeed = Math.max(along, PHYSICS.WALLRUN_MIN_SPEED);
    this.wallTime = 0;
    this.wallLostFor = 0;
    this.velocity.y = clamp(this.velocity.y, -1.0, 3.5);
    this.state = f.side < 0 ? 'WALL_RUN_L' : 'WALL_RUN_R';
    this.events.onWallRunStart?.(f.side < 0 ? -1 : 1);
  }

  private endWallRun(coyote: boolean): void {
    this.lastWallCollider = this.wallFace.collider;
    this.lastWallNormal.copy(this.wallNormal);
    this.lastWallEndedAt = this.simTime;
    if (coyote) {
      this.wallCoyoteUntil = this.simTime + PHYSICS.COYOTE_WALLRUN_MS / 1000;
      this.wallCoyoteNormal.copy(this.wallNormal);
      this.wallCoyoteTangent.copy(this.wallTangent);
      this.wallCoyoteSpeed = this.wallSpeed;
    }
    this.state = 'AIRBORNE';
  }

  /**
   * 7A-6 look-led wall-kick: vertical 11.2 + wall normal 7.5 + view-forward 8.8, keeping 85 % of the along-wall
   * speed — the jump goes where you look (roofs, balconies, enemies) instead of straight off the wall.
   */
  private wallKick(normal: THREE.Vector3, tangent: THREE.Vector3, alongSpeed: number): void {
    const k = 1 + this.modifiers.kickBoostBonus;
    _fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.velocity.copy(tangent).multiplyScalar(alongSpeed * PHYSICS.WALLKICK_TANGENT_KEEP);
    this.velocity.addScaledVector(normal, PHYSICS.WALLKICK_NORMAL * k).addScaledVector(_fwd, PHYSICS.WALLKICK_FORWARD * k);
    this.velocity.y = PHYSICS.WALLKICK_VERTICAL * k * (1 + this.modifiers.wallKickHeightBonus);
    this.wallCoyoteUntil = -1;
    this.state = 'AIRBORNE';
    this.events.onWallKick?.();
  }

  private stepWallRun(dt: number): void {
    this.wallTime += dt;
    // ⑤ Space: wall-kick.
    if (this.input.consumeBuffered('JUMP')) {
      this.lastWallCollider = this.wallFace.collider;
      this.lastWallNormal.copy(this.wallNormal);
      this.lastWallEndedAt = this.simTime;
      this.wallKick(this.wallNormal, this.wallTangent, this.wallSpeed);
      return;
    }
    const maxTime = PHYSICS.WALLRUN_MAX_TIME + this.modifiers.wallRunTimeBonusS;
    if (this.wallTime >= maxTime) {
      this.endWallRun(true);
      return;
    }
    if (this.input.moveZ <= 0) {
      this.endWallRun(true);
      return;
    }
    // Keep the tangent aligned with the look direction's side of travel.
    _fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    if (_fwd.dot(this.wallTangent) < -0.2) this.wallTangent.negate();
    // Along-wall speed is maintained (inertia preserved), slight stick force into the wall — none while
    // crossing a seam / gap (grace period), so the body never drifts into a slot between colliders.
    const stick = this.wallLostFor > 0 ? 0 : 1.0;
    this.velocity.x = this.wallTangent.x * this.wallSpeed - this.wallNormal.x * stick;
    this.velocity.z = this.wallTangent.z * this.wallSpeed - this.wallNormal.z * stick;
    // Apparent gravity: 0 for the first 0.25 s, then −2.8 m/s².
    if (this.wallTime > PHYSICS.WALLRUN_ZERO_G_TIME) this.velocity.y += PHYSICS.WALLRUN_GRAVITY * dt;
    else this.velocity.y = Math.max(this.velocity.y - 6 * dt, 0);
  }

  private stepGrapple(dt: number, ctx: PlayerStepContext): void {
    if (!this.ropeAttached) {
      this.state = 'AIRBORNE';
      return;
    }
    // Space: release with boost · Ctrl/C: pure cut.
    if (this.input.consumeBuffered('JUMP')) {
      this.detachRope('RELEASE');
      return;
    }
    if (this.input.consumeBuffered('SLIDE')) {
      this.detachRope('CUT');
      return;
    }
    // Reel only while the grapple launcher itself is held (guns ⇒ pure pendulum).
    this.state = ctx.grappleEquipped && ctx.reelHeld ? 'GRAPPLE_PULL' : 'GRAPPLE_SWING';

    this.ropeAttachPoint(_rope).sub(this.ropeAnchor).negate(); // player → anchor
    const dist = _rope.length();
    _rope.divideScalar(Math.max(dist, 1e-4));

    if (this.grounded) {
      // Standing on the ground while tethered: walk normally within the rope radius.
      this.groundMove(dt);
      if (this.state === 'GRAPPLE_PULL') this.velocity.y = Math.max(this.velocity.y, 1.0);
    } else {
      this.velocity.y += PHYSICS.GRAVITY * this.gravityScale() * dt;
      // Swing assist: WASD thrust perpendicular to the rope (+5.5 m/s²).
      if (_wish.lengthSq() > 1e-4) {
        _tmp.copy(_wish).normalize();
        _tmp.addScaledVector(_rope, -_tmp.dot(_rope));
        if (_tmp.lengthSq() > 1e-6) this.velocity.addScaledVector(_tmp.normalize(), PHYSICS.GRAPPLE_SWING_ASSIST * dt);
      }
    }
    if (this.state === 'GRAPPLE_PULL') {
      this.ropeLength = Math.max(PHYSICS.GRAPPLE_MIN_LENGTH, this.ropeLength - PHYSICS.GRAPPLE_REEL_SHORTEN_SPEED * dt);
      this.velocity.addScaledVector(_rope, PHYSICS.GRAPPLE_REEL_ACCEL * dt);
      if (dist <= PHYSICS.GRAPPLE_MIN_LENGTH + 0.05) {
        this.detachRope('ARRIVED');
        return;
      }
    }
    // Swing roll ∝ lateral centripetal acceleration (max ±9°).
    const v2 = this.velocity.lengthSq();
    const lateral = _rope.dot(_right) * (v2 / Math.max(this.ropeLength, 1));
    this.swingRollTarget = clamp(lateral * 0.3, -CAMERA.SWING_ROLL_MAX_DEG, CAMERA.SWING_ROLL_MAX_DEG);
  }

  /** Pendulum constraint: |P − A| ≤ L; outward velocity removed, position projected back onto the sphere. */
  private applyRopeConstraint(dt: number): void {
    this.ropeAttachPoint(_rope).sub(this.ropeAnchor); // anchor → player
    const d = _rope.length();
    let tension = 0;
    if (d > this.ropeLength && d > 1e-4) {
      _rope.divideScalar(d);
      const vOut = this.velocity.dot(_rope);
      if (vOut > 0) {
        this.velocity.addScaledVector(_rope, -vOut);
        tension = vOut / Math.max(dt, 1e-4);
      }
      // Position correction goes through collision so the rope can't drag us into walls.
      _delta.copy(_rope).multiplyScalar(-(d - this.ropeLength));
      this.physics.movePlayer(this.position, PLAYER.RADIUS, this.colliderHeight, _delta, false, this.ropeMove);
      if (this.ropeMove.grounded) this.move.grounded = true;
      // Centripetal load adds to the tension read-out.
      _hv.copy(this.velocity).addScaledVector(_rope, -this.velocity.dot(_rope));
      tension += _hv.lengthSq() / this.ropeLength;
    }
    this.ropeTension += (clamp(tension / 60, 0, 1) - this.ropeTension) * lerpFactor(8, dt);
  }

  /** Zero velocity into contacts after the collision pass. */
  private resolveVelocity(_dt: number): void {
    const m = this.move;
    if (m.grounded && this.velocity.y < 0) this.velocity.y = 0;
    if (m.hitCeiling && this.velocity.y > 0) this.velocity.y = 0;
    if (m.hitWall) {
      const vn = this.velocity.dot(m.wallNormal);
      if (vn < 0) {
        // Steep airborne impact (outside ±35° of parallel): no wall-run on this wall until we leave it.
        const hs = Math.hypot(this.velocity.x, this.velocity.z);
        if (this.state === 'AIRBORNE' && hs > 2 && -vn / hs > SIN_ENTRY) {
          this.bonkActive = true;
          this.bonkNormal.copy(m.wallNormal);
        }
        this.velocity.addScaledVector(m.wallNormal, -vn);
      }
    }
  }

  private postMoveTransitions(wasGrounded: boolean, dt: number): void {
    const m = this.move;
    this.inWater = m.grounded && m.groundKind === 'WATER';
    const nowGrounded = m.grounded;

    if (this.isWallRunning) {
      // 6B-2 end rules: ④ landing, ⑥ an obstacle dropping the along-wall speed below 5.5 m/s, ③ the wall gone
      // for more than 0.12 s (seams, window frames, collider joints and short gaps keep the run alive).
      const moved = (this.position.x - this.prevPos.x) * this.wallTangent.x + (this.position.z - this.prevPos.z) * this.wallTangent.z;
      if (nowGrounded) {
        this.endWallRun(false);
        this.land(wasGrounded);
      } else if (moved < PHYSICS.WALLRUN_END_ALONG_SPEED * dt) {
        this.endWallRun(true);
      } else if (this.physics.findWallFaces(this.position, this.colliderHeight, _right, PHYSICS.WALLRUN_DETECT_DISTANCE + 0.25, this.wallNormal) > 0) {
        copyWallFace(this.physics.wallFace(0), this.wallFace);
        this.wallLostFor = 0;
      } else if ((this.wallLostFor += dt) > PHYSICS.WALLRUN_GAP_GRACE_S) {
        this.endWallRun(true);
      }
      this.grounded = nowGrounded;
      return;
    }

    if (this.isSwinging) {
      if (nowGrounded && !wasGrounded) this.land(false);
      this.grounded = nowGrounded;
      return;
    }

    if (this.state === 'MANTLING') {
      // The pull-up path was verified free; finish on the ledge (or fall if something moved underneath).
      if (this.mantleT >= PHYSICS.MANTLE_DURATION_S) {
        this.grounded = this.physics.probeGround(this.position, PLAYER.RADIUS, 0.12) !== null;
        this.move.grounded = this.grounded;
        this.state = this.grounded ? 'GROUNDED' : 'AIRBORNE';
        if (this.grounded) this.events.onLand?.(0, false);
      } else this.grounded = false;
      return;
    }

    if (this.state === 'AIRBORNE' && nowGrounded) {
      this.grounded = true;
      this.land(wasGrounded);
      // Buffered jump within 150 ms before touching down fires immediately (bunny hop).
      if (this.input.consumeBuffered('JUMP')) {
        this.doJump('GROUND');
        return;
      }
      // Landing with slide held at speed goes straight into a slide.
      _hv.set(this.velocity.x, 0, this.velocity.z);
      if ((this.input.isDown('SLIDE') || this.input.hasBuffered('SLIDE')) && _hv.length() >= PHYSICS.SLIDE_MIN_ENTER_SPEED && this.simTime >= this.slideReadyAt) {
        this.input.consumeBuffered('SLIDE');
        this.startSlide();
      } else if (this.input.isDown('SLIDE') && _hv.length() < PHYSICS.CROUCH_MAX_ENTER_SPEED) {
        this.startCrouch();
      } else {
        this.state = 'GROUNDED';
      }
      return;
    }

    if ((this.state === 'GROUNDED' || this.state === 'SLIDING' || this.state === 'CROUCHING') && !nowGrounded) {
      if (this.state === 'CROUCHING') this.events.onCrouch?.(false);
      // Walked / slid off an edge: coyote window.
      this.coyoteUntil = this.simTime + PHYSICS.COYOTE_LEDGE_MS / 1000;
      this.state = 'AIRBORNE';
    }
    this.grounded = nowGrounded;
  }

  private land(wasGrounded: boolean): void {
    this.bonkActive = false;
    if (wasGrounded) return;
    const fall = Math.max(0, this.fallSpeedBeforeLanding);
    if (fall > HARD_LANDING_SPEED) this.addTrauma(SHAKE.HARD_LANDING);
    if (fall > 3) this.dipV -= Math.min(8, fall * 0.4);
    this.events.onLand?.(fall, this.move.groundKind === 'WATER');
  }

  // ===============================================================================================
  // Per-frame camera (real time): eye height, roll, FOV, landing spring, shake, recoil recovery
  // ===============================================================================================
  updateCamera(realDt: number, alpha: number, camera: THREE.PerspectiveCamera): void {
    // Recoil recovery (deg/s toward zero).
    const rec = this.recoilRecoverDegPerS * realDt;
    this.recoilPitchDeg = this.recoilPitchDeg > 0 ? Math.max(0, this.recoilPitchDeg - rec) : Math.min(0, this.recoilPitchDeg + rec);
    this.recoilYawDeg = this.recoilYawDeg > 0 ? Math.max(0, this.recoilYawDeg - rec) : Math.min(0, this.recoilYawDeg + rec);

    // Eye height: 1.72 → 0.86 while sliding (lerp 16·dt).
    // 8A-2: crouch 0.78 m, slide 0.68 m.
    const eyeTarget =
      this.state === 'SLIDING' ? PLAYER.SLIDE_EYE_HEIGHT
      : this.state === 'CROUCHING' ? PLAYER.CROUCH_EYE_HEIGHT
      : this.colliderHeight < PLAYER.HEIGHT ? PLAYER.SLIDE_EYE_HEIGHT
      : PLAYER.EYE_HEIGHT;
    this.eyeHeight += (eyeTarget - this.eyeHeight) * lerpFactor(CAMERA.SLIDE_LERP, realDt);

    // Landing spring dip (k = 180, damping = 18), clamped to −0.28 m.
    const acc = -CAMERA.LANDING_SPRING_K * this.dipX - CAMERA.LANDING_SPRING_DAMPING * this.dipV;
    this.dipV += acc * realDt;
    this.dipX = clamp(this.dipX + this.dipV * realDt, -CAMERA.LANDING_DIP_MAX, 0.1);

    // Roll targets.
    const rs = this.settings.rollScale;
    let rollTarget = 0;
    let rollRate: number = CAMERA.WALLRUN_ROLL_LERP;
    // 8A-1: lean AWAY from the wall — left wall ⇒ camera.rotation.z < 0 (top tilts right), right wall ⇒ > 0.
    if (this.state === 'WALL_RUN_L') rollTarget = CAMERA.WALLRUN_ROLL_DEG;
    else if (this.state === 'WALL_RUN_R') rollTarget = -CAMERA.WALLRUN_ROLL_DEG;
    else if (this.state === 'SLIDING') {
      rollTarget = CAMERA.SLIDE_ROLL_DEG;
      rollRate = CAMERA.SLIDE_LERP;
    } else if (this.isSwinging) {
      rollTarget = this.swingRollTarget;
      rollRate = CAMERA.SWING_ROLL_LERP;
    } else if (this.state === 'MANTLING') {
      // 7A-6: a short lean into the pull-up.
      rollTarget = MANTLE_ROLL_DEG;
      rollRate = 22;
    }
    // Positive spec roll = tilt toward the right; camera Z rotation is counter-clockwise ⇒ negate.
    this.roll += (-rollTarget * rs * DEG2RAD - this.roll) * lerpFactor(rollRate, realDt);

    // FOV: base → speed FOV (9.5 → 32 m/s maps base → base+26, cap 114) → bullet-time −7°.
    const base = this.settings.baseFov;
    const sp = this.speed;
    let fovTarget = base;
    let fovRate: number = CAMERA.BASE_FOV_LERP;
    if (sp > CAMERA.SPEED_FOV_MIN_SPEED) {
      const t = clamp((sp - CAMERA.SPEED_FOV_MIN_SPEED) / (CAMERA.SPEED_FOV_MAX_SPEED - CAMERA.SPEED_FOV_MIN_SPEED), 0, 1.5);
      fovTarget = Math.min(CAMERA.SPEED_FOV_HARD_CAP, base + t * (CAMERA.SPEED_FOV_MAX - CAMERA.BASE_FOV));
      fovRate = CAMERA.SPEED_FOV_LERP;
    }
    // Bullet time −7° only without a gun zoom (the weapon zoom offset is applied instead, never both).
    if (this.btActive && !this.gunZoom) {
      fovTarget += CAMERA.BT_FOV_OFFSET;
      fovRate = CAMERA.BT_FOV_LERP;
    }
    this.fov += (fovTarget - this.fov) * lerpFactor(fovRate, realDt);
    const fovDecay = realDt * 18;
    this.fovPulse = this.fovPulse > 0 ? Math.max(0, this.fovPulse - fovDecay) : Math.min(0, this.fovPulse + fovDecay);

    // Trauma shake: displacement = trauma², 28 Hz sine-sum noise, decays 2.2 /s.
    this.trauma = Math.max(0, this.trauma - SHAKE_DECAY_PER_S * realDt);
    if (this.trauma <= 0) {
      this.shakeMaxPitchYaw = 0;
      this.shakeMaxRoll = 0;
    }
    this.shakeTime += realDt;
    const shake = this.trauma * this.trauma * this.settings.shakeScale;
    const w = this.shakeTime * SHAKE_FREQUENCY_HZ * Math.PI * 2;
    const nP = 0.6 * Math.sin(w) + 0.4 * Math.sin(w * 1.73 + 1.3);
    const nY = 0.6 * Math.sin(w * 1.11 + 2.1) + 0.4 * Math.sin(w * 2.07 + 0.7);
    const nR = 0.6 * Math.sin(w * 0.93 + 4.2) + 0.4 * Math.sin(w * 1.61 + 3.3);
    const sPitch = this.shakeMaxPitchYaw * shake * nP * DEG2RAD;
    const sYaw = this.shakeMaxPitchYaw * shake * nY * DEG2RAD;
    const sRoll = this.shakeMaxRoll * shake * nR * DEG2RAD;

    // 10A-3b.1: Organic figure-8 stride head-bob (synced to ground footsteps, 0.15× in ADS).
    const hs = Math.hypot(this.velocity.x, this.velocity.z);
    const strideActive = (this.state === 'GROUNDED' || this.state === 'CROUCHING') && hs > 0.15;
    if (strideActive) {
      this.stridePhase += hs * 0.62 * realDt;
      this.strideBlend += (1 - this.strideBlend) * lerpFactor(14, realDt);
    } else {
      this.strideBlend += (0 - this.strideBlend) * lerpFactor(10, realDt);
      if (this.strideBlend < 1e-4) this.strideBlend = 0;
    }
    const crouching = this.state === 'CROUCHING';
    const adsK = 1 - 0.85 * clamp(this.adsBlend > 0 ? this.adsBlend : this.gunZoom ? 1 : 0, 0, 1);
    const bobScale = this.strideBlend * adsK * this.settings.shakeScale;
    this.strideBobY = -Math.abs(Math.sin(this.stridePhase)) * (crouching ? 0.014 : 0.028) * bobScale;
    this.strideBobX = Math.cos(this.stridePhase) * (crouching ? 0.006 : 0.012) * bobScale;
    this.strideBobRoll = Math.sin(this.stridePhase) * (crouching ? 0.22 : 0.45) * DEG2RAD * rs * this.strideBlend * adsK;

    // 10A-3b.2: Physical spring-damper gunshot recoil kick (critically damped sub-stepped integration).
    if (realDt > 0) {
      const subSteps = Math.max(1, Math.ceil(realDt / (1 / 240)));
      const h = realDt / subSteps;
      const k = this.kickSpringK;
      const c = this.kickSpringC;
      for (let s = 0; s < subSteps; s++) {
        this.kickPitchV += (-k * this.kickPitch - c * this.kickPitchV) * h;
        this.kickPitch += this.kickPitchV * h;
        this.kickRollV += (-k * this.kickRoll - c * this.kickRollV) * h;
        this.kickRoll += this.kickRollV * h;
        this.kickZV += (-k * this.kickZ - c * this.kickZV) * h;
        this.kickZ += this.kickZV * h;
      }
    }

    // Interpolated eye position + stride head-bob + physical recoil Z-punch.
    this.eye.lerpVectors(this.prevPosition, this.position, alpha);
    this.eye.y += this.eyeHeight + this.dipX + this.strideBobY;
    _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    this.eye.addScaledVector(_right, this.strideBobX);
    if (Math.abs(this.kickZ) > 1e-6) {
      _fwd.set(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
      this.eye.addScaledVector(_fwd, this.kickZ);
    }

    this.cameraEuler.set(
      this.pitch + this.recoilPitchDeg * DEG2RAD + this.kickPitch + sPitch,
      this.yaw + this.recoilYawDeg * DEG2RAD + sYaw,
      this.roll + this.strideBobRoll - this.kickRoll + sRoll,
      'YXZ',
    );
    camera.position.copy(this.eye);
    camera.rotation.copy(this.cameraEuler);
    let fov = this.fov + this.fovPulse + this.zoomFovDeg;
    if (this.zoomAbsBlend > 0) fov += (this.zoomAbsFov - fov) * this.zoomAbsBlend;
    if (Math.abs(camera.fov - fov) > 1e-3) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  }

  /** Current horizontal right vector of the view (for HUD / wall-side logic). */
  rightVector(out: THREE.Vector3): THREE.Vector3 {
    return out.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
  }
}

/** Move vector `v` toward `target` by at most `maxDelta` (in place). */
function moveTowards(v: THREE.Vector3, target: THREE.Vector3, maxDelta: number): void {
  const dx = target.x - v.x;
  const dy = target.y - v.y;
  const dz = target.z - v.z;
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (d <= maxDelta || d < 1e-9) {
    v.copy(target);
    return;
  }
  const k = maxDelta / d;
  v.x += dx * k;
  v.y += dy * k;
  v.z += dz * k;
}
