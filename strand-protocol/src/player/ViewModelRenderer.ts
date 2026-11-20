/**
 * STRAND // PROTOCOL — First-person view-model (§2.3, §3.2, §6.2 Pass 2).
 *
 * Drawn in the dedicated view-model scene (cleared depth, FOV 68°), so weapons and hands never clip
 * into walls. Everything is procedural PBR geometry:
 *   right hand + MK-IV rail pistol / VX-9 pulse SMG / K-12 kinetic shotgun / S-00 grapple launcher,
 *   left forearm with the wrist winch reel (the strand exits here while attached).
 * Animation: holster / draw (110 ms each), recoil springs, reload with magazine drop, shotgun pump
 * (280 ms after the shot), look sway (±0.035 m, lerp 14·dt), movement bob (0.012 m, stops in the air /
 * on walls), slide & wall-run tilt, muzzle flash, emissive charge / shell-count indicators, winch spin.
 */
import * as THREE from 'three';
import { CAMERA, COLORS, MATERIALS, clamp, lerpFactor } from '../config/constants';
import { SLOT_ORDER, type SlotId } from '../config/weapons';

const SLOT_KEYS: readonly SlotId[] = SLOT_ORDER;

export interface ViewModelFrame {
  slot: SlotId;
  /** 'IDLE' | 'HOLSTER' | 'DRAW' with 0..1 progress. */
  phase: 'IDLE' | 'HOLSTER' | 'DRAW';
  phaseT: number;
  /** 0..1 reload progress (−1 when not reloading). */
  reloadT: number;
  ammo: number;
  magazine: number;
  hookInFlight: boolean;
  ropeAttached: boolean;
  reeling: boolean;
  /** Look delta this frame (rad) for sway. */
  lookYaw: number;
  lookPitch: number;
  speed: number;
  grounded: boolean;
  sliding: boolean;
  /** −1 left wall, +1 right wall, 0 none. */
  wallSide: number;
  /** Seconds since the last shot (pump / charge animation). */
  sinceShot: number;
}

const _v = new THREE.Vector3();
const _ndc = new THREE.Vector3();

function std(color: number, roughness: number, metalness: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

function glow(color: number, intensity: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: 0x000000, emissive: new THREE.Color(color), emissiveIntensity: intensity, roughness: 0.3, metalness: 0 });
}

function box(w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}

function cyl(rTop: number, rBot: number, len: number, mat: THREE.Material, seg = 16): THREE.Mesh {
  const g = new THREE.CylinderGeometry(rTop, rBot, len, seg);
  g.rotateX(Math.PI / 2); // along Z
  return new THREE.Mesh(g, mat);
}

interface WeaponRig {
  readonly group: THREE.Group;
  readonly muzzle: THREE.Object3D;
  readonly energy: THREE.MeshStandardMaterial;
  readonly mag?: THREE.Object3D;
  readonly pump?: THREE.Object3D;
  readonly shells?: THREE.Mesh[];
  readonly hook?: THREE.Object3D;
  readonly drum?: THREE.Object3D;
  /** Recoil impulse: back (m) and pitch (rad). */
  readonly kickBack: number;
  readonly kickPitch: number;
}

export class ViewModelRenderer {
  readonly root = new THREE.Group();
  private readonly weaponPivot = new THREE.Group();
  private readonly rightHand = new THREE.Group();
  private readonly leftArm = new THREE.Group();
  private readonly winchDrum: THREE.Object3D;
  private readonly winchExit = new THREE.Object3D();
  private readonly winchGlow: THREE.MeshStandardMaterial;
  private readonly rigs: Record<SlotId, WeaponRig>;
  private readonly flash: THREE.Mesh;
  private readonly flashMat: THREE.ShaderMaterial;

  // animation state
  private swayX = 0;
  private swayY = 0;
  private bobPhase = 0;
  private bobAmp = 0;
  private kickZ = 0;
  private kickVZ = 0;
  private kickP = 0;
  private kickVP = 0;
  private tilt = 0;
  private lower = 0;
  private flashLife = 0;
  private drumAngle = 0;
  private winchAngle = 0;
  private leftRaise = 0;
  private time = 0;
  /** Energy-coloured emissive materials (collected once) + the strand rim light, for the unlockable colours. */
  private readonly energyMats: THREE.MeshStandardMaterial[] = [];
  private rimLight!: THREE.DirectionalLight;
  private energyHex: number = COLORS.PLAYER_STRAND;
  private plasma = false;

  constructor(private readonly scene: THREE.Scene, private readonly vmCamera: THREE.PerspectiveCamera) {
    this.root.name = 'ViewModel';
    scene.add(this.root);
    this.root.add(this.weaponPivot, this.leftArm);
    this.weaponPivot.add(this.rightHand);

    // Values tuned so silhouettes read against the night city (the view-model has its own lights).
    const gunmetal = std(0x3a4352, 0.34, 0.72);
    const darkMetal = std(0x262c36, 0.4, 0.7);
    const polymer = std(0x1d222b, 0.55, 0.25);
    const armor = std(0x343d4c, 0.42, 0.55);
    const glove = std(0x24282f, 0.7, 0.08);
    const sleeve = std(0x1d222a, 0.66, 0.15);

    // Dedicated view-model lighting: cool key from the upper left, strand-cyan rim from behind-right,
    // warm low fill reflecting street lamps.
    const key = new THREE.DirectionalLight(0xdfe9ff, 1.6);
    key.position.set(-0.6, 1.0, 0.8);
    const rim = new THREE.DirectionalLight(COLORS.PLAYER_STRAND, 1.4);
    rim.position.set(0.9, 0.3, -1.0);
    this.rimLight = rim;
    const fill = new THREE.PointLight(0xffb070, 0.6, 2.5, 2);
    fill.position.set(0.1, -0.6, -0.2);
    scene.add(key, rim, fill);
    const strand = MATERIALS.PLAYER_STRAND.emissive;

    // ---------------- Right hand / forearm ----------------
    const palm = box(0.075, 0.09, 0.1, glove, 0, -0.065, 0.05);
    palm.rotation.x = -0.25;
    this.rightHand.add(palm);
    for (let i = 0; i < 4; i++) {
      const f = new THREE.Mesh(new THREE.CapsuleGeometry(0.0115, 0.04, 4, 8), glove);
      f.rotation.z = Math.PI / 2;
      f.position.set(-0.012, -0.03 - i * 0.022, 0.028 + i * 0.004);
      this.rightHand.add(f);
    }
    const thumb = new THREE.Mesh(new THREE.CapsuleGeometry(0.012, 0.045, 4, 8), glove);
    thumb.rotation.set(0.6, 0, 0.9);
    thumb.position.set(-0.03, -0.01, 0.02);
    this.rightHand.add(thumb);
    const forearm = cyl(0.04, 0.05, 0.42, sleeve, 14);
    forearm.position.set(0.02, -0.14, 0.25);
    forearm.rotation.x = 0.35;
    this.rightHand.add(forearm);
    const bracer = cyl(0.05, 0.053, 0.14, armor, 6);
    bracer.position.set(0.02, -0.11, 0.17);
    bracer.rotation.x = 0.35;
    this.rightHand.add(bracer);
    const stripe = box(0.006, 0.012, 0.12, glow(COLORS.PLAYER_STRAND, strand * 0.6), -0.045, -0.1, 0.17);
    stripe.rotation.x = 0.35;
    this.rightHand.add(stripe);

    // ---------------- Weapons ----------------
    this.rigs = {
      PISTOL: this.buildPistol(gunmetal, polymer, darkMetal),
      SMG: this.buildSmg(gunmetal, polymer, darkMetal),
      SHOTGUN: this.buildShotgun(gunmetal, polymer, darkMetal),
      GRAPPLE: this.buildGrapple(gunmetal, polymer, darkMetal),
    };
    for (const r of Object.values(this.rigs)) {
      r.group.visible = false;
      this.weaponPivot.add(r.group);
    }

    // ---------------- Left forearm with wrist winch ----------------
    const lForearm = cyl(0.042, 0.05, 0.44, sleeve, 14);
    lForearm.rotation.x = 0.55;
    lForearm.position.set(0, -0.05, 0.18);
    this.leftArm.add(lForearm);
    const lGlove = box(0.07, 0.085, 0.09, glove, 0, 0.04, -0.04);
    lGlove.rotation.x = 0.4;
    this.leftArm.add(lGlove);
    const housing = cyl(0.055, 0.055, 0.075, armor, 18);
    housing.rotation.set(0, Math.PI / 2, 0);
    housing.position.set(0.055, -0.02, 0.08);
    this.leftArm.add(housing);
    const drum = new THREE.Group();
    const drumCore = cyl(0.04, 0.04, 0.08, darkMetal, 20);
    drumCore.rotation.set(0, Math.PI / 2, 0);
    drum.add(drumCore);
    for (let i = 0; i < 6; i++) {
      const rib = box(0.085, 0.006, 0.012, gunmetal);
      rib.rotation.x = (i / 6) * Math.PI;
      drum.add(rib);
    }
    drum.position.copy(housing.position);
    this.leftArm.add(drum);
    this.winchDrum = drum;
    this.winchGlow = glow(COLORS.PLAYER_STRAND, strand * 0.5);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.047, 0.004, 6, 28), this.winchGlow);
    ring.rotation.y = Math.PI / 2;
    ring.position.set(0.097, -0.02, 0.08);
    this.leftArm.add(ring);
    this.winchExit.position.set(0.06, 0.02, 0.02);
    this.leftArm.add(this.winchExit);
    this.leftArm.position.set(-0.24, -0.28, -0.42);
    this.leftArm.rotation.set(0.2, 0.25, 0.25);

    // ---------------- Muzzle flash (two crossed additive quads) ----------------
    this.flashMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: { uColor: { value: new THREE.Color(COLORS.PLAYER_STRAND) }, uSeed: { value: 0 }, uAlpha: { value: 0 } },
      vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; uniform float uSeed; uniform float uAlpha; varying vec2 vUv;
        void main() {
          vec2 p = vUv - 0.5;
          float r = length(p) * 2.0;
          float ang = atan(p.y, p.x);
          float spikes = pow(abs(sin(ang * 3.0 + uSeed * 6.28)), 6.0);
          float core = exp(-r * 6.0);
          float a = (core * 2.4 + spikes * (1.0 - r) * 1.2) * uAlpha * step(r, 1.0);
          gl_FragColor = vec4(mix(uColor, vec3(1.0), core) * a * 3.0, 1.0);
        }
      `,
    });
    const flashGeo = new THREE.PlaneGeometry(0.16, 0.16);
    const f2 = flashGeo.clone().rotateY(Math.PI / 2);
    const f3 = flashGeo.clone().rotateX(Math.PI / 2);
    this.flash = new THREE.Mesh(flashGeo, this.flashMat);
    this.flash.add(new THREE.Mesh(f2, this.flashMat), new THREE.Mesh(f3, this.flashMat));
    this.flash.visible = false;
    this.flash.renderOrder = 10;
    this.weaponPivot.add(this.flash);

    this.weaponPivot.position.set(0.21, -0.2, -0.42);

    const strandHex = COLORS.PLAYER_STRAND;
    const seen = new Set<THREE.Material>();
    this.root.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      if (!(m instanceof THREE.MeshStandardMaterial) || seen.has(m)) return;
      seen.add(m);
      if (m.emissive.getHex() === strandHex) this.energyMats.push(m);
    });
  }

  /** §8.3 weapon energy colour: every strand-cyan emissive part, the muzzle flash and the rim light. */
  setEnergyColor(hex: number): void {
    if (hex === this.energyHex) return;
    this.energyHex = hex;
    for (const m of this.energyMats) m.emissive.setHex(hex);
    this.rimLight.color.setHex(hex);
    if (!this.plasma) (this.flashMat.uniforms.uColor.value as THREE.Color).setHex(hex);
  }

  /** FLOW SS+: the muzzle flash turns plasma blue-white. */
  setPlasmaMuzzle(on: boolean): void {
    this.plasma = on;
    (this.flashMat.uniforms.uColor.value as THREE.Color).setHex(on ? 0xdcf2ff : this.energyHex);
  }

  // =============================================================================================
  // Weapon builders (local space: +Z toward the player, −Z toward the muzzle)
  // =============================================================================================
  private buildPistol(gunmetal: THREE.Material, polymer: THREE.Material, dark: THREE.Material): WeaponRig {
    const g = new THREE.Group();
    const energy = glow(COLORS.PLAYER_STRAND, MATERIALS.PLAYER_STRAND.emissive);
    g.add(box(0.034, 0.045, 0.2, gunmetal, 0, 0.02, -0.06));
    g.add(box(0.03, 0.03, 0.17, polymer, 0, -0.012, -0.05));
    const grip = box(0.03, 0.1, 0.045, polymer, 0, -0.07, 0.025);
    grip.rotation.x = -0.25;
    g.add(grip);
    g.add(box(0.012, 0.03, 0.03, dark, 0, -0.03, -0.005)); // trigger guard
    const barrel = cyl(0.009, 0.009, 0.12, dark, 12);
    barrel.position.set(0, 0.022, -0.2);
    g.add(barrel);
    // Rail coils (charge glow).
    for (let i = 0; i < 4; i++) {
      const coil = new THREE.Mesh(new THREE.TorusGeometry(0.0145, 0.0035, 6, 16), energy);
      coil.position.set(0, 0.022, -0.15 - i * 0.025);
      g.add(coil);
    }
    g.add(box(0.036, 0.004, 0.16, energy, 0, 0.045, -0.06));
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, 0.022, -0.27);
    g.add(muzzle);
    const mag = box(0.024, 0.07, 0.03, dark, 0, -0.085, 0.025);
    mag.rotation.x = -0.25;
    g.add(mag);
    return { group: g, muzzle, energy, mag, kickBack: 0.05, kickPitch: 0.13 };
  }

  private buildSmg(gunmetal: THREE.Material, polymer: THREE.Material, dark: THREE.Material): WeaponRig {
    const g = new THREE.Group();
    const energy = glow(COLORS.PLAYER_STRAND, MATERIALS.PLAYER_STRAND.emissive * 0.8);
    g.add(box(0.045, 0.06, 0.26, gunmetal, 0, 0.01, -0.07));
    g.add(box(0.04, 0.03, 0.2, polymer, 0, 0.055, -0.07));
    const grip = box(0.032, 0.095, 0.042, polymer, 0, -0.065, 0.03);
    grip.rotation.x = -0.2;
    g.add(grip);
    const fore = box(0.03, 0.06, 0.035, polymer, 0, -0.045, -0.15);
    fore.rotation.x = 0.15;
    g.add(fore);
    const emitter = cyl(0.016, 0.019, 0.09, dark, 10);
    emitter.position.set(0, 0.012, -0.24);
    g.add(emitter);
    for (let i = 0; i < 3; i++) g.add(box(0.05, 0.006, 0.012, energy, 0, 0.012, -0.215 - i * 0.022));
    g.add(box(0.004, 0.02, 0.12, energy, 0.024, 0.02, -0.07));
    g.add(box(0.004, 0.02, 0.12, energy, -0.024, 0.02, -0.07));
    const stock = box(0.02, 0.04, 0.12, dark, 0, 0.0, 0.1);
    g.add(stock);
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, 0.012, -0.3);
    g.add(muzzle);
    const mag = box(0.024, 0.12, 0.034, dark, 0, -0.08, -0.07);
    mag.rotation.x = 0.12;
    g.add(mag);
    return { group: g, muzzle, energy, mag, kickBack: 0.016, kickPitch: 0.035 };
  }

  private buildShotgun(gunmetal: THREE.Material, polymer: THREE.Material, dark: THREE.Material): WeaponRig {
    const g = new THREE.Group();
    const energy = glow(COLORS.PLAYER_STRAND, MATERIALS.PLAYER_STRAND.emissive * 0.7);
    g.add(box(0.06, 0.07, 0.24, gunmetal, 0, 0.01, -0.03));
    const b1 = cyl(0.016, 0.016, 0.36, dark, 14);
    b1.position.set(-0.014, 0.022, -0.29);
    const b2 = cyl(0.016, 0.016, 0.36, dark, 14);
    b2.position.set(0.014, 0.022, -0.29);
    g.add(b1, b2);
    const grip = box(0.034, 0.1, 0.045, polymer, 0, -0.07, 0.06);
    grip.rotation.x = -0.25;
    g.add(grip);
    const pump = new THREE.Group();
    pump.add(box(0.058, 0.04, 0.11, polymer, 0, -0.012, 0));
    for (let i = 0; i < 4; i++) pump.add(box(0.06, 0.004, 0.006, dark, 0, -0.012, -0.04 + i * 0.026));
    pump.position.set(0, -0.004, -0.24);
    g.add(pump);
    g.add(box(0.062, 0.006, 0.2, energy, 0, 0.047, -0.04));
    const shells: THREE.Mesh[] = [];
    for (let i = 0; i < 4; i++) {
      const s = box(0.008, 0.008, 0.014, glow(COLORS.PLAYER_STRAND, 2.6), 0.031, 0.0 + 0.0, 0.04 - i * 0.022);
      g.add(s);
      shells.push(s);
    }
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, 0.022, -0.48);
    g.add(muzzle);
    return { group: g, muzzle, energy, pump, shells, kickBack: 0.09, kickPitch: 0.28 };
  }

  private buildGrapple(gunmetal: THREE.Material, polymer: THREE.Material, dark: THREE.Material): WeaponRig {
    const g = new THREE.Group();
    const energy = glow(COLORS.PLAYER_STRAND, MATERIALS.PLAYER_STRAND.emissive * 0.8);
    const gold = glow(COLORS.GRAPPLE_GOLD, MATERIALS.GRAPPLE_ANCHOR.emissive * 0.6);
    const body = cyl(0.034, 0.04, 0.24, gunmetal, 18);
    body.position.set(0, 0.015, -0.08);
    g.add(body);
    const grip = box(0.032, 0.095, 0.045, polymer, 0, -0.065, 0.03);
    grip.rotation.x = -0.22;
    g.add(grip);
    const drum = new THREE.Group();
    const drumCore = cyl(0.045, 0.045, 0.05, dark, 20);
    drumCore.rotation.set(0, Math.PI / 2, 0);
    drum.add(drumCore);
    for (let i = 0; i < 5; i++) {
      const rib = box(0.054, 0.005, 0.012, energy);
      rib.rotation.x = (i / 5) * Math.PI;
      drum.add(rib);
    }
    drum.position.set(0, -0.02, 0.02);
    g.add(drum);
    const hook = new THREE.Group();
    const shaft = cyl(0.012, 0.016, 0.06, dark, 10);
    hook.add(shaft);
    for (let i = 0; i < 3; i++) {
      const claw = box(0.006, 0.006, 0.045, gold);
      const a = (i / 3) * Math.PI * 2;
      claw.position.set(Math.cos(a) * 0.018, Math.sin(a) * 0.018, -0.03);
      claw.rotation.set(-Math.sin(a) * 0.5, Math.cos(a) * 0.5, 0);
      hook.add(claw);
    }
    hook.position.set(0, 0.015, -0.225);
    g.add(hook);
    g.add(box(0.004, 0.012, 0.16, energy, 0.035, 0.03, -0.08));
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, 0.015, -0.26);
    g.add(muzzle);
    return { group: g, muzzle, energy, hook, drum, kickBack: 0.03, kickPitch: 0.06 };
  }

  // =============================================================================================
  // Events
  // =============================================================================================
  onFire(slot: SlotId): void {
    const r = this.rigs[slot];
    this.kickVZ += r.kickBack * 28;
    this.kickVP += r.kickPitch * 28;
    if (slot !== 'GRAPPLE') {
      this.flashLife = slot === 'SHOTGUN' ? 0.07 : 0.045;
      this.flashMat.uniforms.uSeed.value = Math.random();
      this.flash.scale.setScalar(slot === 'SHOTGUN' ? 1.6 : slot === 'SMG' ? 0.75 : 1.0);
      this.flash.position.copy(r.muzzle.position).applyMatrix4(r.group.matrix);
      this.flash.rotation.z = Math.random() * Math.PI;
    }
  }

  // =============================================================================================
  // Per frame
  // =============================================================================================
  update(realDt: number, f: ViewModelFrame): void {
    this.time += realDt;
    for (const id of SLOT_KEYS) this.rigs[id].group.visible = id === f.slot;
    const rig = this.rigs[f.slot];

    // Holster / draw: rotate down & away.
    let hp = 0;
    if (f.phase === 'HOLSTER') hp = f.phaseT;
    else if (f.phase === 'DRAW') hp = 1 - f.phaseT;
    const ease = hp * hp * (3 - 2 * hp);

    // Look sway (lags behind mouse, max ±0.035 m).
    const sx = clamp(-f.lookYaw * 0.9, -CAMERA.SWAY_MAX, CAMERA.SWAY_MAX);
    const sy = clamp(f.lookPitch * 0.9, -CAMERA.SWAY_MAX, CAMERA.SWAY_MAX);
    const k = lerpFactor(CAMERA.SWAY_LERP, realDt);
    this.swayX += (sx - this.swayX) * k;
    this.swayY += (sy - this.swayY) * k;

    // Bob: grounded movement only (stops in the air and on walls).
    const bobOn = f.grounded && !f.sliding && f.wallSide === 0 && f.speed > 0.6;
    this.bobAmp += ((bobOn ? 1 : 0) - this.bobAmp) * lerpFactor(8, realDt);
    this.bobPhase += realDt * (2 + f.speed * 0.9);
    const bobX = Math.sin(this.bobPhase) * CAMERA.BOB_AMPLITUDE * this.bobAmp;
    const bobY = -Math.abs(Math.cos(this.bobPhase)) * CAMERA.BOB_AMPLITUDE * this.bobAmp;

    // Recoil springs.
    this.kickVZ += (-260 * this.kickZ - 26 * this.kickVZ) * realDt;
    this.kickZ += this.kickVZ * realDt;
    this.kickVP += (-260 * this.kickP - 26 * this.kickVP) * realDt;
    this.kickP += this.kickVP * realDt;

    // Slide / wall-run tilt.
    const tiltTarget = f.sliding ? 0.2 : f.wallSide !== 0 ? -0.12 * f.wallSide : 0;
    this.tilt += (tiltTarget - this.tilt) * lerpFactor(10, realDt);
    this.lower += ((f.sliding ? 0.03 : 0) - this.lower) * lerpFactor(10, realDt);

    // Reload: roll, dip and magazine drop.
    let reloadRoll = 0;
    let reloadDip = 0;
    if (f.reloadT >= 0) {
      const t = f.reloadT;
      const env = Math.sin(Math.min(1, t) * Math.PI);
      reloadRoll = env * 0.55;
      reloadDip = env * 0.06;
      if (rig.mag) {
        const drop = t < 0.45 ? t / 0.45 : t < 0.55 ? 1 : 1 - (t - 0.55) / 0.45;
        rig.mag.position.y = (f.slot === 'SMG' ? -0.08 : -0.085) - drop * 0.14;
        rig.mag.visible = !(t > 0.42 && t < 0.58);
      }
    } else if (rig.mag) {
      rig.mag.position.y = f.slot === 'SMG' ? -0.08 : -0.085;
      rig.mag.visible = true;
    }

    // Shotgun pump 280 ms after the shot.
    if (rig.pump) {
      const t = f.sinceShot - 0.28;
      const pumpT = t > 0 && t < 0.22 ? Math.sin((t / 0.22) * Math.PI) : 0;
      rig.pump.position.z = -0.24 + pumpT * 0.07;
    }
    if (rig.shells) rig.shells.forEach((s, i) => (s.visible = i < f.ammo));

    // Pistol charge glow rises between shots; SMG emitter flickers while firing.
    if (f.slot === 'PISTOL') rig.energy.emissiveIntensity = MATERIALS.PLAYER_STRAND.emissive * (0.35 + 0.65 * clamp(f.sinceShot / 0.3, 0, 1));
    else if (f.slot === 'SMG') rig.energy.emissiveIntensity = MATERIALS.PLAYER_STRAND.emissive * (f.sinceShot < 0.1 ? 1.3 : 0.7);

    // Grapple: hook hidden while in flight; drum spins while reeling / paying out.
    if (rig.hook) rig.hook.visible = !f.hookInFlight;
    if (rig.drum) {
      this.drumAngle += realDt * (f.hookInFlight ? 40 : f.reeling ? -30 : 0);
      rig.drum.rotation.x = this.drumAngle;
    }
    this.winchAngle += realDt * (f.reeling ? -26 : f.hookInFlight ? 30 : 0);
    this.winchDrum.rotation.x = this.winchAngle;
    this.winchGlow.emissiveIntensity = MATERIALS.PLAYER_STRAND.emissive * (f.ropeAttached ? 1.0 : 0.35);
    this.leftRaise += ((f.ropeAttached || f.hookInFlight ? 1 : 0) - this.leftRaise) * lerpFactor(9, realDt);

    // Compose the right-hand pivot.
    const p = this.weaponPivot;
    p.position.set(
      0.21 + this.swayX + bobX,
      -0.2 + this.swayY + bobY - ease * 0.32 - reloadDip - this.lower,
      -0.42 + this.kickZ + ease * 0.05,
    );
    p.rotation.set(this.kickP + ease * 0.95 + this.swayY * 2, this.swayX * 2.5, -this.tilt - ease * 0.35 + reloadRoll, 'XYZ');

    // Left arm: raised forward while the strand is out.
    this.leftArm.position.set(-0.26 + this.swayX * 0.7 + bobX * 0.6, -0.33 + this.leftRaise * 0.08 + this.swayY * 0.7 + bobY - this.lower, -0.44 - this.leftRaise * 0.04);
    this.leftArm.rotation.set(0.25 + this.leftRaise * 0.25, 0.3 - this.leftRaise * 0.1, 0.2 + this.tilt * 0.5);

    // Muzzle flash.
    if (this.flashLife > 0) {
      this.flashLife -= realDt;
      this.flash.visible = true;
      this.flashMat.uniforms.uAlpha.value = clamp(this.flashLife / 0.05, 0, 1);
      this.flash.position.copy(rig.muzzle.position).applyMatrix4(rig.group.matrix);
    } else {
      this.flash.visible = false;
    }
  }

  /** Keeps the view-model's PMREM reflections consistent with the main view orientation. */
  syncEnvironment(cameraEuler: THREE.Euler): void {
    this.scene.environmentRotation.set(-cameraEuler.x, -cameraEuler.y, 0, 'YXZ');
  }

  /**
   * World point that appears on screen exactly where `local` (view-model camera space) is drawn:
   * project with the view-model FOV, unproject with the main camera at the same view depth.
   */
  private screenMatchedWorld(local: THREE.Object3D, mainCamera: THREE.PerspectiveCamera, out: THREE.Vector3): THREE.Vector3 {
    this.root.updateMatrixWorld(true);
    local.getWorldPosition(_v); // view-model scene == view space (camera at origin, identity rotation)
    const depth = -_v.z;
    _ndc.copy(_v).applyMatrix4(this.vmCamera.projectionMatrix);
    // Reconstruct a view-space point on the main camera's frustum at the same depth.
    const tanY = Math.tan((mainCamera.fov * Math.PI) / 360);
    const tanX = tanY * mainCamera.aspect;
    out.set(_ndc.x * tanX * depth, _ndc.y * tanY * depth, -depth);
    return out.applyMatrix4(mainCamera.matrixWorld);
  }

  muzzleWorld(slot: SlotId, mainCamera: THREE.PerspectiveCamera, out: THREE.Vector3): THREE.Vector3 {
    return this.screenMatchedWorld(this.rigs[slot].muzzle, mainCamera, out);
  }

  winchWorld(mainCamera: THREE.PerspectiveCamera, out: THREE.Vector3): THREE.Vector3 {
    return this.screenMatchedWorld(this.winchExit, mainCamera, out);
  }
}
