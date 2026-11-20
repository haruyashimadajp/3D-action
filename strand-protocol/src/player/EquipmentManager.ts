/**
 * STRAND // PROTOCOL — Equipment (§3.2, §3.5, §3.6, §4).
 *
 * Exclusive right-hand slot: PISTOL | SMG | SHOTGUN | GRAPPLE.
 *  - With a gun active, LMB ALWAYS fires the gun — a new strand can never be launched.
 *  - A new strand requires switching to GRAPPLE (Q / 4 / wheel): holster 110 ms + draw 110 ms.
 *  - While the strand is ATTACHED it is locked to the left-arm winch: switching to a gun keeps the
 *    player hanging / swinging (and able to shoot); switching back to GRAPPLE does NOT cut it.
 *    Only Space (release), Ctrl/C (cut) or a new LMB launch with GRAPPLE active cut the strand.
 *  - Reel-in (LMB held) only while GRAPPLE is in hand; with a gun it is a pure pendulum.
 * 5-state gear FSM: IDLE · HOLSTERING · DRAWING · FIRING_RECOVERY · RELOADING (switch cancels reload and
 * interrupts recovery). Clicks up to 150 ms before a switch completes are buffered and fired on completion.
 * v1.2 / 5A-4: the gear timers (holster / draw, fire recovery, reload) run on REAL time — bullet time slows the
 * world, not the hands (only hitstop pauses them); the hook flies at 340 m/s and at ≥ 0.6× real-time speed in
 * bullet time; LMB is ignored while a hook is in flight (no self-cancel).
 * 5A-1 tactical zoom: RMB with a gun in IDLE / FIRING_RECOVERY blends in the weapon's zoom (FOV, sensitivity,
 * spread, view-model pivot, −10…−20 % visual recoil); reloads, switches and the grapple drop it.
 */
import * as THREE from 'three';
import { COLORS, DEG2RAD, EQUIP, MATERIALS, PHYSICS, clamp } from '../config/constants';
import { GRAPPLE, GUNS, SLOT_ORDER, type GunDef, type GunId, type SlotId, isGun } from '../config/weapons';
import { SKILL_BY_ID, SKILL_CONSTANTS } from '../config/skills';
import type { InputManager, DiscreteAction } from '../engine/InputManager';
import type { Renderer } from '../engine/Renderer';
import { BURST, type EffectsPool, type ProjectileSpec } from '../entities/EffectsPool';
import type { ColliderKind } from '../world/CityBuilder';
import {
  type AnchorSnap,
  type HitboxTarget,
  type PhysicsWorld,
  createRayHit,
  createTargetHit,
} from '../world/PhysicsWorld';
import type { PlayerController, PlayerStepContext, RopeDetach } from './PlayerController';
import type { ViewModelFrame, ViewModelRenderer } from './ViewModelRenderer';

export type GearState = 'IDLE' | 'HOLSTERING' | 'DRAWING' | 'FIRING_RECOVERY' | 'RELOADING';

/** Progression modifiers (FLOW rank + skills); neutral defaults. */
export interface EquipmentModifiers {
  /** Multiplier on holster + draw time (FLOW C −10 % … SSS −35 %, SK_01, SK_14). */
  switchTimeMultiplier: number;
  /** Multiplier on reload time (FLOW B −10 % … SSS −30 %, SK_14). */
  reloadTimeMultiplier: number;
  /** SK_07: shotgun air recoil impulse bonus (fraction). */
  shotgunImpulseBonus: number;
  /** SK_03: magazine refill fraction when switching to a gun while hanging. */
  swingReloadFraction: number;
  /** SK_02: number of piercing, +35 % speed shots after a strand release / switch (0 = not owned). */
  momentumShots: number;
  /** SK_06: hooking an enemy directly resets the strand cooldown. */
  enemyHookResetsCooldown: boolean;
}

export interface EquipmentEvents {
  onShot?(gun: GunId, ammoLeft: number, airborne: boolean): void;
  /** Tactical zoom engaged / released (servo SE). */
  onZoom?(on: boolean): void;
  onDryFire?(gun: GunId): void;
  onSwitchStart?(to: SlotId): void;
  onSwitchDone?(slot: SlotId): void;
  onReloadStart?(gun: GunId): void;
  onReloadDone?(gun: GunId): void;
  onHookFired?(): void;
  onHookAttached?(point: THREE.Vector3, snapped: boolean): void;
  onHookMissed?(): void;
}

/** Combat hooks supplied by the enemy system (Phase 3): hook a humanoid directly with the strand. */
export interface GrappleCombatHooks {
  targets(): readonly HitboxTarget[];
  onGrappleTarget(target: HitboxTarget, point: THREE.Vector3): void;
}

const ROPE_SEGMENTS = 16;
const GRAPPLE_IGNORE: ReadonlySet<ColliderKind> = new Set<ColliderKind>(['GROUND', 'WATER', 'BARRIER']);

const _eye = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _muzzle = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _ctrl = new THREE.Vector3();
const _p0 = new THREE.Vector3();
const _p1 = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _col = new THREE.Color();
const _white = new THREE.Color(1, 1, 1);
const _strand = new THREE.Color(COLORS.PLAYER_STRAND);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const _hit = createRayHit();
const _thit = createTargetHit();
const _snap: AnchorSnap = { anchor: null, angleDeg: 0, distance: 0 };
const _actions: DiscreteAction[] = [];

export class EquipmentManager {
  activeSlot: SlotId = 'PISTOL';
  state: GearState = 'IDLE';
  lastGun: GunId = 'PISTOL';
  pendingSlot: SlotId | null = null;
  readonly ammo: Record<GunId, number> = { PISTOL: GUNS.PISTOL.magazine, SMG: GUNS.SMG.magazine, SHOTGUN: GUNS.SHOTGUN.magazine };

  /** Gear timer (real seconds, see 5A-4) and its duration. */
  private stateTime = 0;
  private stateDuration = 0;
  /** Overshoot of the last FIRING_RECOVERY (keeps the SMG cadence exact at coarse bullet-time steps). */
  private recoveryCarry = 0;
  private simTime = 0;
  /** 5A-1 tactical zoom: target state, 0..1 blend and the gun whose zoom parameters apply. */
  private zoomTarget = false;
  zoomBlend = 0;
  private zoomGun: GunId = 'PISTOL';
  private lastShotAt = -1e9;
  private smgBurstIndex = 0;
  private grappleReadyAt = 0;
  private suppressCooldown = false;

  // Hook flight
  hookInFlight = false;
  private hookRetracting = false;
  private readonly hookStart = new THREE.Vector3();
  private readonly hookTarget = new THREE.Vector3();
  private readonly hookPos = new THREE.Vector3();
  private hookDistance = 0;
  private hookTravel = 0;
  private hookWillHit = false;
  private hookSnapped = false;
  private hookEnemy: HitboxTarget | null = null;
  private retractT = 0;

  /** Anchor currently inside the 6° snap cone (HUD gold diamond), refreshed every frame. */
  readonly snap: AnchorSnap = { anchor: null, angleDeg: 0, distance: 0 };

  readonly modifiers: EquipmentModifiers = {
    switchTimeMultiplier: 1,
    reloadTimeMultiplier: 1,
    shotgunImpulseBonus: 0,
    swingReloadFraction: 0,
    momentumShots: 0,
    enemyHookResetsCooldown: false,
  };
  /** SK_02 state: piercing shots left and the end of the 1.8 s window. */
  private momentumLeft = 0;
  private momentumUntil = -1;
  /** SK_06: the next strand release skips the 0.65 s cooldown. */
  private freeNextDetach = false;
  /** Weapon energy colour (§8.3 unlockable) and FLOW SS+ plasma muzzle. */
  private energyHex: number = COLORS.PLAYER_STRAND;
  private plasma = false;
  /** FLOW A+: strengthened strand light trail. */
  private strandBoost = 1;
  private specs: Record<GunId, ProjectileSpec> = buildSpecs(COLORS.PLAYER_STRAND, false, false);
  private pierceSpecs: Record<GunId, ProjectileSpec> = buildSpecs(COLORS.PLAYER_STRAND, false, true);
  private readonly muzzleColor = new THREE.Color(BURST.MUZZLE.color);
  combat: GrappleCombatHooks | null = null;

  // Rope visuals (world scene)
  private readonly ropeMesh: THREE.InstancedMesh;
  private readonly ropeMat: THREE.MeshBasicMaterial;
  private readonly hookMesh: THREE.Mesh;
  private lookYaw = 0;
  private lookPitch = 0;
  readonly vmFrame: ViewModelFrame = {
    slot: 'PISTOL',
    phase: 'IDLE',
    phaseT: 0,
    reloadT: -1,
    ammo: 0,
    magazine: 0,
    hookInFlight: false,
    ropeAttached: false,
    reeling: false,
    lookYaw: 0,
    lookPitch: 0,
    speed: 0,
    grounded: false,
    sliding: false,
    wallSide: 0,
    sinceShot: 10,
    zoom: 0,
    zoomGun: 'PISTOL',
  };
  private readonly stepCtx: PlayerStepContext = { grappleEquipped: false, reelHeld: false };

  constructor(
    private readonly input: InputManager,
    private readonly player: PlayerController,
    private readonly physics: PhysicsWorld,
    private readonly effects: EffectsPool,
    private readonly renderer: Renderer,
    private readonly viewModel: ViewModelRenderer,
    scene: THREE.Scene,
    readonly events: EquipmentEvents = {},
  ) {
    this.ropeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(COLORS.PLAYER_STRAND).multiplyScalar(MATERIALS.PLAYER_STRAND.emissive) });
    const seg = new THREE.CylinderGeometry(0.018, 0.018, 1, 6, 1, true);
    this.ropeMesh = new THREE.InstancedMesh(seg, this.ropeMat, ROPE_SEGMENTS);
    this.ropeMesh.name = 'Strand';
    this.ropeMesh.frustumCulled = false;
    this.ropeMesh.count = 0;
    scene.add(this.ropeMesh);
    const hookMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(COLORS.GRAPPLE_GOLD),
      emissive: new THREE.Color(COLORS.GRAPPLE_GOLD),
      emissiveIntensity: MATERIALS.GRAPPLE_ANCHOR.emissive,
      roughness: 0.25,
      metalness: 0.8,
    });
    this.hookMesh = new THREE.Mesh(new THREE.OctahedronGeometry(0.16, 0), hookMat);
    this.hookMesh.name = 'GrappleHook';
    this.hookMesh.visible = false;
    scene.add(this.hookMesh);
  }

  // ===============================================================================================
  // Reset
  // ===============================================================================================
  reset(): void {
    this.activeSlot = 'PISTOL';
    this.lastGun = 'PISTOL';
    this.pendingSlot = null;
    this.state = 'IDLE';
    this.stateTime = 0;
    this.stateDuration = 0;
    this.ammo.PISTOL = GUNS.PISTOL.magazine;
    this.ammo.SMG = GUNS.SMG.magazine;
    this.ammo.SHOTGUN = GUNS.SHOTGUN.magazine;
    this.hookInFlight = false;
    this.hookRetracting = false;
    this.grappleReadyAt = 0;
    this.lastShotAt = -1e9;
    this.hookMesh.visible = false;
    this.ropeMesh.count = 0;
    this.recoveryCarry = 0;
    this.zoomTarget = false;
    this.zoomBlend = 0;
    this.input.lookScale = 1;
    this.player.zoomFovDeg = 0;
    this.player.gunZoom = false;
    this.momentumLeft = 0;
    this.momentumUntil = -1;
    this.freeNextDetach = false;
  }

  // ===============================================================================================
  // Progression visuals
  // ===============================================================================================
  /** Weapon energy colour (tracers, strand, muzzle); the view-model is recoloured by its own renderer. */
  setEnergyColor(hex: number): void {
    if (hex === this.energyHex) return;
    this.energyHex = hex;
    _strand.setHex(hex);
    this.rebuildSpecs();
  }

  /** FLOW SS+: plasma blue-white muzzle and tracers. */
  setPlasmaMuzzle(on: boolean): void {
    if (on === this.plasma) return;
    this.plasma = on;
    this.rebuildSpecs();
  }

  /** FLOW A+: brighter, thicker strand light trail (1 = normal). */
  setStrandBoost(k: number): void {
    this.strandBoost = k;
  }

  private rebuildSpecs(): void {
    this.specs = buildSpecs(this.energyHex, this.plasma, false);
    this.pierceSpecs = buildSpecs(this.energyHex, this.plasma, true);
    this.muzzleColor.setHex(this.energyHex).lerp(_white, 0.45);
    if (this.plasma) this.muzzleColor.setHex(PLASMA_HEX);
  }

  /** SK_02: arm the momentum window (strand released, or a gun drawn from the strand). */
  private armMomentum(): void {
    if (this.modifiers.momentumShots <= 0) return;
    this.momentumLeft = this.modifiers.momentumShots;
    this.momentumUntil = this.simTime + SKILL_CONSTANTS.MOMENTUM_WINDOW_S;
  }

  /** SK_04: instant reload of the active gun. */
  instantReload(): void {
    if (!isGun(this.activeSlot)) return;
    this.refill(this.activeSlot, 1);
    if (this.state === 'RELOADING') this.enter('IDLE', 0);
  }

  /** True while SK_02 piercing shots are armed (HUD / tests). */
  get momentumArmed(): boolean {
    return this.momentumLeft > 0 && this.simTime <= this.momentumUntil;
  }

  /** SK_02 piercing shots still loaded (0 when the window is closed) — HUD buff tag. */
  get momentumShotsLeft(): number {
    return this.momentumArmed ? this.momentumLeft : 0;
  }

  // ===============================================================================================
  // Discrete actions (slot select, toggle, wheel, reload)
  // ===============================================================================================
  handleActions(): DiscreteAction[] {
    this.input.drainActions(_actions);
    for (const a of _actions) {
      switch (a) {
        case 'SLOT1':
          this.requestSlot('PISTOL');
          break;
        case 'SLOT2':
          this.requestSlot('SMG');
          break;
        case 'SLOT3':
          this.requestSlot('SHOTGUN');
          break;
        case 'SLOT4':
          this.requestSlot('GRAPPLE');
          break;
        case 'TOGGLE_GRAPPLE': {
          const current = this.pendingSlot ?? this.activeSlot;
          this.requestSlot(current === 'GRAPPLE' ? this.lastGun : 'GRAPPLE');
          break;
        }
        case 'SLOT_NEXT':
        case 'SLOT_PREV': {
          const current = this.pendingSlot ?? this.activeSlot;
          const i = SLOT_ORDER.indexOf(current);
          const n = SLOT_ORDER.length;
          this.requestSlot(SLOT_ORDER[(i + (a === 'SLOT_NEXT' ? 1 : n - 1)) % n]);
          break;
        }
        case 'RELOAD':
          this.startReload();
          break;
        default:
          break;
      }
    }
    return _actions;
  }

  private switchDurationS(): number {
    return ((EQUIP.HOLSTER_MS + EQUIP.DRAW_MS) / 1000) * this.modifiers.switchTimeMultiplier;
  }

  /** Begin a switch: HOLSTERING (110 ms) → DRAWING (110 ms). Reloads are cancelled immediately. */
  requestSlot(slot: SlotId): void {
    if (!this.player.isAlive) return;
    const half = this.switchDurationS() / 2;
    if (this.state === 'HOLSTERING') {
      // Retarget the pending slot (or abort back to the current one).
      this.pendingSlot = slot === this.activeSlot ? null : slot;
      if (!this.pendingSlot) this.enter('DRAWING', half * (this.stateTime / Math.max(this.stateDuration, 1e-4)));
      return;
    }
    if (this.state === 'DRAWING') {
      if (slot === this.activeSlot) return;
    } else if (slot === this.activeSlot) {
      return;
    }
    this.pendingSlot = slot;
    this.enter('HOLSTERING', half);
    this.events.onSwitchStart?.(slot);
  }

  private enter(state: GearState, duration: number): void {
    this.state = state;
    this.stateTime = 0;
    this.stateDuration = duration;
  }

  startReload(): void {
    if (!isGun(this.activeSlot)) return;
    if (this.state !== 'IDLE' && this.state !== 'FIRING_RECOVERY') return;
    const gun = GUNS[this.activeSlot];
    if (this.ammo[gun.id] >= gun.magazine) return;
    this.enter('RELOADING', gun.reloadS * this.modifiers.reloadTimeMultiplier);
    this.events.onReloadStart?.(gun.id);
  }

  /** Instant magazine refill (skill hooks: SK_04 wall overclock, SK_09 shield break). */
  refill(gun: GunId, fraction = 1): void {
    const def = GUNS[gun];
    this.ammo[gun] = Math.min(def.magazine, this.ammo[gun] + Math.ceil(def.magazine * fraction));
    if (this.state === 'RELOADING' && this.activeSlot === gun && this.ammo[gun] >= def.magazine) this.enter('IDLE', 0);
  }

  // ===============================================================================================
  // Rope callbacks (from PlayerController)
  // ===============================================================================================
  /** Strand released / cut ⇒ 0.65 s re-use cooldown (not when the release is a re-fire). */
  onRopeDetached(mode: RopeDetach): void {
    if (mode === 'REFIRE' || this.suppressCooldown) return;
    this.armMomentum();
    if (this.freeNextDetach) {
      // SK_06: hooking an enemy reset the cooldown.
      this.freeNextDetach = false;
      this.grappleReadyAt = this.simTime;
      return;
    }
    this.grappleReadyAt = this.simTime + PHYSICS.GRAPPLE_COOLDOWN;
  }

  /** Remaining grapple cooldown (s) for the HUD. */
  get grappleCooldown(): number {
    return Math.max(0, this.grappleReadyAt - this.simTime);
  }

  /** Context for the player's fixed step (reel only while the launcher itself is held). */
  stepContext(): PlayerStepContext {
    this.stepCtx.grappleEquipped = this.activeSlot === 'GRAPPLE' && (this.state === 'IDLE' || this.state === 'FIRING_RECOVERY');
    this.stepCtx.reelHeld = this.stepCtx.grappleEquipped && this.input.isDown('FIRE') && this.player.ropeAttached && !this.hookInFlight;
    return this.stepCtx;
  }

  // ===============================================================================================
  // Fixed step
  // ===============================================================================================
  /**
   * `dt` is the scaled simulation step; `btScale` the current bullet-time scale (1 or 0.25). Gear timers advance
   * by dt / btScale = real time in bullet time (hitstop still slows them, as it scales dt itself).
   */
  fixedUpdate(dt: number, camera: THREE.PerspectiveCamera, btScale = 1): void {
    const bt = Math.max(0.05, btScale);
    this.simTime += dt;
    this.updateHook(dt * Math.max(1, GRAPPLE.BT_MIN_SPEED_FACTOR / bt));
    if (!this.player.isAlive) return;

    const gearDt = dt / bt;
    this.stateTime += gearDt;
    this.recoveryCarry = 0;
    switch (this.state) {
      case 'HOLSTERING':
        if (this.stateTime >= this.stateDuration) {
          const prev = this.activeSlot;
          this.activeSlot = this.pendingSlot ?? this.activeSlot;
          this.pendingSlot = null;
          if (isGun(this.activeSlot)) {
            this.lastGun = this.activeSlot;
            // SK_03 swing reloader: switching to a gun while hanging refills the magazine.
            if (prev === 'GRAPPLE' && this.player.ropeAttached && this.modifiers.swingReloadFraction > 0) this.refill(this.activeSlot, this.modifiers.swingReloadFraction);
            // SK_02: drawing a gun from the strand arms the momentum chamber.
            if (prev === 'GRAPPLE') this.armMomentum();
          }
          this.enter('DRAWING', this.switchDurationS() / 2);
        }
        break;
      case 'DRAWING':
        if (this.stateTime >= this.stateDuration) {
          this.enter('IDLE', 0);
          this.events.onSwitchDone?.(this.activeSlot);
        }
        break;
      case 'FIRING_RECOVERY':
        if (this.stateTime >= this.stateDuration) {
          this.recoveryCarry = Math.min(this.stateTime - this.stateDuration, gearDt);
          this.enter('IDLE', 0);
          if (isGun(this.activeSlot) && this.ammo[this.activeSlot] === 0) this.startReload();
        }
        break;
      case 'RELOADING':
        if (this.stateTime >= this.stateDuration && isGun(this.activeSlot)) {
          this.ammo[this.activeSlot] = GUNS[this.activeSlot].magazine;
          this.enter('IDLE', 0);
          this.events.onReloadDone?.(this.activeSlot);
        }
        break;
      default:
        break;
    }

    if (this.state !== 'IDLE') return;

    if (isGun(this.activeSlot)) {
      const gun = GUNS[this.activeSlot];
      // Semi-auto: buffered press (≤ 150 ms). Full-auto (SMG): held trigger.
      const wants = gun.automatic ? this.input.isDown('FIRE') || this.input.consumeBuffered('FIRE') : this.input.consumeBuffered('FIRE');
      if (!wants) {
        if (!this.input.isDown('FIRE')) this.smgBurstIndex = 0;
        return;
      }
      if (this.ammo[gun.id] <= 0) {
        this.events.onDryFire?.(gun.id);
        this.startReload();
        return;
      }
      this.fireGun(gun, camera);
    } else if (this.input.hasBuffered('FIRE')) {
      if (this.hookInFlight) {
        // 5A-4: clicks while the hook is flying are swallowed — never a self-cancel, never a stale re-fire
        // that would cut the strand the moment it lands.
        this.input.consumeBuffered('FIRE');
      } else if (this.player.ropeAttached || this.simTime >= this.grappleReadyAt) {
        // GRAPPLE: a new launch (cuts any attached strand first). Cooldown applies only when not attached.
        this.input.consumeBuffered('FIRE');
        this.fireHook(camera);
      }
    }
  }

  // ===============================================================================================
  // Guns
  // ===============================================================================================
  private fireGun(gun: GunDef, camera: THREE.PerspectiveCamera): void {
    this.ammo[gun.id]--;
    this.lastShotAt = this.simTime;
    this.enter('FIRING_RECOVERY', gun.intervalMs / 1000);
    this.stateTime = this.recoveryCarry;
    this.recoveryCarry = 0;
    // Tactical zoom: tighter cone and −10…−20 % visual recoil, proportional to the blend.
    const zoomed = this.zoomBlend >= 0.5;
    const recoilK = 1 - (1 - gun.zoom.recoilScale) * this.zoomBlend;

    this.player.eyePosition(_eye);
    this.player.aimDirection(_aim);
    this.viewModel.muzzleWorld(gun.id, camera, _muzzle);
    // Basis around the aim for cone spread (no aim assist of any kind).
    _right.crossVectors(_aim, Y_AXIS);
    if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0);
    _right.normalize();
    _up.crossVectors(_right, _aim).normalize();
    const spreadDeg = zoomed
      ? this.player.btActive
        ? gun.zoom.spreadBtDeg
        : gun.zoom.spreadDeg
      : this.player.btActive
        ? gun.spreadBtDeg
        : gun.spreadDeg;
    const tanHalf = Math.tan((spreadDeg / 2) * DEG2RAD);
    // SK_02 momentum chamber: the first N shots inside the window pierce shields / bodies at +35 % speed.
    const momentum = this.momentumLeft > 0 && this.simTime <= this.momentumUntil;
    if (momentum) this.momentumLeft--;
    const spec: ProjectileSpec = momentum ? this.pierceSpecs[gun.id] : this.specs[gun.id];
    for (let p = 0; p < gun.pellets; p++) {
      _dir.copy(_aim);
      if (tanHalf > 0) {
        const r = Math.sqrt(Math.random()) * tanHalf;
        const t = Math.random() * Math.PI * 2;
        _dir.addScaledVector(_right, Math.cos(t) * r).addScaledVector(_up, Math.sin(t) * r).normalize();
      }
      this.effects.spawnProjectile(_eye, _dir, spec, _muzzle);
    }

    // Recoil (deg) — SMG horizontal kick follows a sine sway while held.
    const r = gun.recoil;
    const horiz = r.sineSway ? Math.sin(this.smgBurstIndex * 0.9) * r.horizontalDeg : (Math.random() * 2 - 1) * r.horizontalDeg;
    this.smgBurstIndex++;
    this.player.addRecoil(r.verticalDeg * recoilK, horiz * recoilK, r.recoverDegPerS);
    this.player.addTrauma(gun.shake, recoilK);
    this.player.notifyFired();
    this.viewModel.onFire(gun.id, recoilK);
    this.renderer.flashLight(_muzzle, this.plasma ? PLASMA_HEX : this.energyHex, gun.id === 'SHOTGUN' ? 18 : 9, 12, gun.id === 'SMG' ? 0.04 : 0.07);
    this.effects.burst(_muzzle, _aim, BURST.MUZZLE, this.muzzleColor.getHex());

    // Kinetic shotgun recoil jump: opposite to the view (+11.5 m/s airborne, +2.0 m/s grounded).
    const airborne = !this.player.isGrounded;
    if (gun.id === 'SHOTGUN') {
      const k = (airborne ? gun.recoilImpulseAir : gun.recoilImpulseGround) * (1 + (airborne ? this.modifiers.shotgunImpulseBonus : 0));
      this.player.viewDirection(_dir);
      this.player.addImpulse(_dir.multiplyScalar(-k));
    }
    this.events.onShot?.(gun.id, this.ammo[gun.id], airborne);
  }

  // ===============================================================================================
  // Grapple
  // ===============================================================================================
  private fireHook(camera: THREE.PerspectiveCamera): void {
    // A new launch always cuts the current strand (hit or miss).
    if (this.player.ropeAttached) {
      this.suppressCooldown = true;
      this.player.detachRope('REFIRE');
      this.suppressCooldown = false;
    }
    this.player.eyePosition(_eye);
    this.player.viewDirection(_aim);
    // 6° snap to gold anchors (movement assist only), else any structure surface within 52 m.
    this.physics.findSnapAnchor(_eye, _aim, GRAPPLE.RANGE, GRAPPLE.SNAP_ANGLE_DEG, _snap);
    this.hookEnemy = null;
    this.hookSnapped = false;
    if (_snap.anchor) {
      this.hookTarget.copy(_snap.anchor.position);
      this.hookWillHit = true;
      this.hookSnapped = true;
    } else {
      this.physics.raycast(_eye, _aim, GRAPPLE.RANGE, _hit, GRAPPLE_IGNORE);
      const worldDist = _hit.hit ? _hit.distance : GRAPPLE.RANGE;
      const targets = this.combat?.targets() ?? null;
      if (targets && targets.length) this.physics.raycastTargets(_eye, _aim, worldDist, targets, _thit);
      if (targets && targets.length && _thit.hit) {
        this.hookTarget.copy(_thit.point);
        this.hookEnemy = _thit.target;
        this.hookWillHit = true;
      } else if (_hit.hit) {
        this.hookTarget.copy(_hit.point).addScaledVector(_hit.normal, 0.05);
        this.hookWillHit = true;
      } else {
        this.hookTarget.copy(_aim).multiplyScalar(GRAPPLE.RANGE).add(_eye);
        this.hookWillHit = false;
      }
    }
    this.viewModel.muzzleWorld('GRAPPLE', camera, this.hookStart);
    this.hookPos.copy(this.hookStart);
    this.hookDistance = _eye.distanceTo(this.hookTarget);
    this.hookTravel = 0;
    this.hookInFlight = true;
    this.hookRetracting = false;
    this.lastShotAt = this.simTime;
    this.enter('FIRING_RECOVERY', 0.12);
    this.viewModel.onFire('GRAPPLE');
    this.events.onHookFired?.();
  }

  private updateHook(dt: number): void {
    if (this.hookRetracting) {
      this.retractT += dt / 0.15;
      if (this.retractT >= 1) {
        this.hookRetracting = false;
        this.hookMesh.visible = false;
      }
      return;
    }
    if (!this.hookInFlight) return;
    this.hookTravel += GRAPPLE.PROJECTILE_SPEED * dt;
    const t = clamp(this.hookTravel / Math.max(this.hookDistance, 1e-3), 0, 1);
    this.hookPos.lerpVectors(this.hookStart, this.hookTarget, t);
    if (t < 1) return;
    this.hookInFlight = false;
    if (this.hookWillHit && this.player.isAlive) {
      this.effects.burst(this.hookTarget, _dir.subVectors(this.hookStart, this.hookTarget).normalize(), BURST.HOOK);
      this.player.attachRope(this.hookTarget);
      if (this.hookEnemy && this.combat) this.combat.onGrappleTarget(this.hookEnemy, this.hookTarget);
      this.freeNextDetach = this.hookEnemy !== null && this.modifiers.enemyHookResetsCooldown;
      this.events.onHookAttached?.(this.hookTarget, this.hookSnapped);
    } else {
      // Miss: the hook snaps back and the cooldown starts.
      this.hookRetracting = true;
      this.retractT = 0;
      this.grappleReadyAt = this.simTime + PHYSICS.GRAPPLE_COOLDOWN;
      this.events.onHookMissed?.();
    }
  }

  // ===============================================================================================
  // Per frame: anchor-lock query, rope / hook visuals, view-model frame
  // ===============================================================================================
  frameUpdate(realDt: number, camera: THREE.PerspectiveCamera, lookYaw: number, lookPitch: number): void {
    this.lookYaw = lookYaw;
    this.lookPitch = lookPitch;
    if (realDt > 0) this.updateZoom(realDt);
    // Gold diamond lock display works with ANY slot equipped (§3.6-3).
    this.player.eyePosition(_eye);
    this.player.viewDirection(_aim);
    if (this.player.isAlive) this.physics.findSnapAnchor(_eye, _aim, GRAPPLE.RANGE, GRAPPLE.SNAP_ANGLE_DEG, this.snap);
    else this.snap.anchor = null;

    // Strand from the wrist winch to the anchor (or flying hook).
    const showRope = this.player.ropeAttached || this.hookInFlight || this.hookRetracting;
    if (showRope) {
      this.viewModel.winchWorld(camera, _p0);
      if (this.player.ropeAttached) _p1.copy(this.player.ropeAnchor);
      else if (this.hookInFlight) _p1.copy(this.hookPos);
      else _p1.lerpVectors(this.hookTarget, _p0, clamp(this.retractT, 0, 1));
      this.drawRope(_p0, _p1);
      this.hookMesh.visible = !this.player.ropeAttached;
      this.hookMesh.position.copy(_p1);
      this.hookMesh.rotation.y += realDt * 20;
      // White-hot under tension.
      const tension = this.player.ropeAttached ? this.player.ropeTension : 0.2;
      _col.copy(_strand).lerp(_white, tension).multiplyScalar(MATERIALS.PLAYER_STRAND.emissive * this.strandBoost);
      this.ropeMat.color.copy(_col);
    } else {
      this.ropeMesh.count = 0;
      this.hookMesh.visible = false;
    }

    // View-model frame data.
    const f = this.vmFrame;
    const total = this.stateDuration;
    f.slot = this.activeSlot;
    f.phase = this.state === 'HOLSTERING' ? 'HOLSTER' : this.state === 'DRAWING' ? 'DRAW' : 'IDLE';
    f.phaseT = total > 0 ? clamp(this.stateTime / total, 0, 1) : 0;
    f.reloadT = this.state === 'RELOADING' ? clamp(this.stateTime / Math.max(total, 1e-4), 0, 1) : -1;
    f.ammo = isGun(this.activeSlot) ? this.ammo[this.activeSlot] : 0;
    f.magazine = isGun(this.activeSlot) ? GUNS[this.activeSlot].magazine : 0;
    f.hookInFlight = this.hookInFlight;
    f.ropeAttached = this.player.ropeAttached;
    f.reeling = this.player.state === 'GRAPPLE_PULL';
    f.lookYaw = this.lookYaw;
    f.lookPitch = this.lookPitch;
    f.speed = this.player.speed;
    f.grounded = this.player.isGrounded;
    f.sliding = this.player.isSliding;
    f.wallSide = this.player.state === 'WALL_RUN_L' ? -1 : this.player.state === 'WALL_RUN_R' ? 1 : 0;
    f.sinceShot = this.simTime - this.lastShotAt;
    f.zoom = this.zoomBlend;
    f.zoomGun = this.zoomGun;
    this.viewModel.update(realDt, f);
  }

  /**
   * 5A-1: RMB held with a gun drawn (IDLE / FIRING_RECOVERY) → zoom. Grounded or not; bullet time is decided by
   * the player (air only). Blend += (target − blend) · min(1, rate · realDt); FOV offset, sensitivity and the
   * view-model pivot follow the blend. Frozen frames (pause, realDt = 0) never touch it.
   */
  private updateZoom(realDt: number): void {
    const gunReady = isGun(this.activeSlot) && (this.state === 'IDLE' || this.state === 'FIRING_RECOVERY');
    const target = gunReady && this.player.isAlive && this.input.isDown('BULLET_TIME');
    if (isGun(this.activeSlot) && (target || this.zoomBlend <= 0.001)) this.zoomGun = this.activeSlot;
    if (target !== this.zoomTarget) {
      this.zoomTarget = target;
      this.events.onZoom?.(target);
    }
    const z = GUNS[this.zoomGun].zoom;
    this.zoomBlend += ((target ? 1 : 0) - this.zoomBlend) * Math.min(1, z.lerpRate * realDt);
    if (this.zoomBlend < 0.0005) this.zoomBlend = 0;
    this.player.gunZoom = target;
    this.player.zoomFovDeg = z.fovOffsetDeg * this.zoomBlend;
    this.input.lookScale = 1 + (z.sensitivity - 1) * this.zoomBlend;
  }

  /** True while the zoom is engaged (RMB with a gun ready). */
  get isZooming(): boolean {
    return this.zoomTarget;
  }

  /** Straight when taut; a sagging quadratic curve when slack. 16 instanced segments, no allocation. */
  private drawRope(a: THREE.Vector3, b: THREE.Vector3): void {
    const dist = a.distanceTo(b);
    const slack = this.player.ropeAttached ? Math.max(0, this.player.ropeLength - dist) : 0;
    const sag = Math.min(6, Math.sqrt(slack * Math.max(dist, 1)) * 0.5);
    _ctrl.lerpVectors(a, b, 0.5);
    _ctrl.y -= sag * 2;
    for (let i = 0; i < ROPE_SEGMENTS; i++) {
      bezier(a, _ctrl, b, i / ROPE_SEGMENTS, _a);
      bezier(a, _ctrl, b, (i + 1) / ROPE_SEGMENTS, _b);
      _mid.addVectors(_a, _b).multiplyScalar(0.5);
      _dir.subVectors(_b, _a);
      const len = _dir.length();
      if (len > 1e-5) _q.setFromUnitVectors(Y_AXIS, _dir.divideScalar(len));
      const w = this.strandBoost > 1 ? 1.6 : 1;
      _s.set(w, len, w);
      _m4.compose(_mid, _q, _s);
      this.ropeMesh.setMatrixAt(i, _m4);
    }
    this.ropeMesh.count = ROPE_SEGMENTS;
    this.ropeMesh.instanceMatrix.needsUpdate = true;
  }

  // ===============================================================================================
  // HUD helpers
  // ===============================================================================================
  /** 0..1 switch progress (−1 when not switching). */
  get switchProgress(): number {
    if (this.state !== 'HOLSTERING' && this.state !== 'DRAWING') return -1;
    const half = this.stateDuration;
    const t = clamp(this.stateTime / Math.max(half, 1e-4), 0, 1);
    return this.state === 'HOLSTERING' ? t * 0.5 : 0.5 + t * 0.5;
  }

  /** 0..1 reload progress (−1 when not reloading). */
  get reloadProgress(): number {
    if (this.state !== 'RELOADING') return -1;
    return clamp(this.stateTime / Math.max(this.stateDuration, 1e-4), 0, 1);
  }

  /** Time since the last trigger pull in seconds (HUD regen flash, view-model). */
  get sinceShot(): number {
    return this.simTime - this.lastShotAt;
  }
}

/** FLOW SS+ plasma blue-white. */
const PLASMA_HEX = 0xdcf2ff;

/**
 * Projectile specs per gun, rebuilt only when the energy colour / plasma state changes (no allocation per shot).
 * `pierce` = SK_02 momentum rounds (+35 % speed, pass through shields and bodies).
 */
function buildSpecs(energyHex: number, plasma: boolean, pierce: boolean): Record<GunId, ProjectileSpec> {
  const c = new THREE.Color(plasma ? PLASMA_HEX : energyHex);
  const base = c.getHex();
  const light = c.clone().lerp(new THREE.Color(1, 1, 1), 0.35).getHex();
  const k = plasma ? 1.35 : 1;
  const speedK = pierce ? 1 + SKILL_BY_ID.SK_02.values2![0] : 1;
  const mk = (id: GunId, color: number, intensity: number, width: number, tag: number): ProjectileSpec => {
    const g = GUNS[id];
    return {
      owner: 'PLAYER',
      speed: g.projectileSpeed * speedK,
      range: g.range,
      damage: g.damageBody,
      headMultiplier: g.headMultiplier,
      shieldMultiplier: g.shieldMultiplier,
      color,
      intensity: intensity * k * (pierce ? 1.25 : 1),
      width: width * (pierce ? 1.4 : 1),
      tag,
      pierce,
    };
  };
  return {
    PISTOL: mk('PISTOL', base, MATERIALS.PLAYER_STRAND.emissive, 0.03, 0),
    SMG: mk('SMG', base, MATERIALS.PLAYER_STRAND.emissive * 0.8, 0.018, 1),
    SHOTGUN: mk('SHOTGUN', light, MATERIALS.PLAYER_STRAND.emissive * 0.7, 0.016, 2),
  };
}

function bezier(a: THREE.Vector3, c: THREE.Vector3, b: THREE.Vector3, t: number, out: THREE.Vector3): THREE.Vector3 {
  const u = 1 - t;
  out.set(
    u * u * a.x + 2 * u * t * c.x + t * t * b.x,
    u * u * a.y + 2 * u * t * c.y + t * t * b.y,
    u * u * a.z + 2 * u * t * c.z + t * t * b.z,
  );
  return out;
}
