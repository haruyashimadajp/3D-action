/**
 * STRAND // PROTOCOL — First-person view-model (§2.3, §3.2, §6.2 Pass 2; Phase 6B-1 AAA remodel).
 *
 * Drawn in the dedicated view-model scene (cleared depth, FOV 68°), so weapons and hands never clip into
 * walls. Everything is procedural hard-surface geometry (ViewModelKit): bevelled extrusions (2–4 mm, two
 * segments), lathes and tubes, baked into one geometry per material and per moving part:
 *  - two tactical-glove hands with five jointed fingers (thumb 2 + fingers 3 phalanges), four independent
 *    carbon knuckle plates, wrist cuffs, jacket sleeves and a cyber exo-brace (frame, light fibres, cables);
 *    the right index finger pulls the trigger on every shot; the left hand supports the SMG / shotgun
 *    fore-end and thrusts the wrist winch (frame, wound drum, guide rollers, status ring, pressure gauge)
 *    forward while the strand is out
 *  - MK-IV rail pistol (angled slide, glowing coil slits, under-barrel laser), VX-9 pulse SMG (faceted
 *    receiver, perforated shroud, angled foregrip, heat-sink fins), K-12 kinetic shotgun (twin barrels,
 *    perforated heat shield, ammo-linked 4-shell side saddle, ribbed pump), S-00 grapple launcher (twin
 *    hydraulics, pressure canister, wound reel + pulleys, three-claw anchor that opens on launch)
 *  - every gun: Picatinny rail + physical holographic sight (bevelled hood, coated lens, collimated reticle
 *    that sits exactly on the aim point in ADS), blowback (slide / bolt / pump / pistons), ejection sparks,
 *    diegetic ammo bar recessed in a bevelled housing
 *  - lighting: tuned environment reflections + a 60 ms muzzle point light on every shot
 * Draw calls: ≤ 11 per frame for the whole view-model (one material per static body, one per moving part).
 */
import * as THREE from 'three';
import { CAMERA, COLORS, MATERIALS, clamp, lerpFactor } from '../config/constants';
import type { ProceduralTextureLibrary } from '../engine/ProceduralTextures';
import { SLOT_ORDER, type GunId, type SlotId } from '../config/weapons';
import {
  MeshKit,
  type PartOpts,
  addRail,
  at,
  bevelBox,
  capsule,
  createKitUniforms,
  cylinder,
  frontPlate,
  kitMaterial,
  lathe,
  profile,
  roundRect,
  torus,
  tube,
  type KitUniforms,
} from './ViewModelKit';

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
  /** Seconds since the last shot (pump / charge / blowback animation). */
  sinceShot: number;
  /** 0..1 tactical-zoom blend and the gun whose zoom pivot applies (5A-1). */
  zoom: number;
  zoomGun: GunId;
}

// ---------------------------------------------------------------------------------------------
// Palette (tints multiply the zoned PBR albedo ≈ 0.4–0.5 linear)
// ---------------------------------------------------------------------------------------------
const T = {
  GUNMETAL: 0xa8b3c4,
  DARK: 0x7a8494,
  BLACK: 0x4a515c,
  POLYMER: 0x9aa2b0,
  GRIP: 0x8a909c,
  CHROME: 0xdde3ec,
  BRASS: 0xe0bb66,
  SHELL: 0xd04450,
  GOLD: 0xffc23a,
  CANISTER: 0xd8703a,
  LEATHER: 0x8a8e96,
  NYLON: 0x7a8490,
  RUBBER: 0x60646c,
  JACKET: 0x76808e,
  CARBON: 0x646a78,
  LASER: 0xff2a3c,
  GAUGE: 0xd8f4ff,
} as const;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _ndc = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

interface GripDef {
  /** Top centre of the grip (gun space) and its rake (rad about X). */
  top: THREE.Vector3;
  tilt: number;
  /** Half width (x) / half depth (z) of the grip section. */
  rx: number;
  rz: number;
  /** Trigger face (gun space). */
  trigger: THREE.Vector3;
}

/** Matrix of a point in the grip frame (grip axis = local Y, raked by `tilt` + `extra`). */
function gripMatrix(g: GripDef, x: number, y: number, z: number, extra = 0): THREE.Matrix4 {
  const p = V(x, y, z).applyAxisAngle(V(1, 0, 0), g.tilt).add(g.top);
  return new THREE.Matrix4().compose(p, new THREE.Quaternion().setFromEuler(new THREE.Euler(g.tilt + extra, 0, 0)), new THREE.Vector3(1, 1, 1));
}

interface WeaponRig {
  readonly group: THREE.Group;
  readonly muzzle: THREE.Object3D;
  readonly eject: THREE.Object3D;
  /** Holographic sight: lens mesh (moves with its parent) and the lens centre in gun space at rest. */
  readonly lens: THREE.Mesh;
  readonly sight: THREE.Vector3;
  /** Eye → lens distance at full zoom. */
  readonly adsDist: number;
  /** Blowback part (+z travel in metres) and its rest position. */
  readonly slide?: THREE.Object3D;
  readonly slideTravel: number;
  readonly mag?: THREE.Object3D;
  readonly magRest?: THREE.Vector3;
  readonly magAxis?: THREE.Vector3;
  readonly pump?: THREE.Object3D;
  readonly hook?: THREE.Object3D;
  readonly reel?: THREE.Object3D;
  readonly index: THREE.Object3D;
  /** Left-hand support point (gun space) — undefined: the left hand rests. */
  readonly support?: THREE.Vector3;
  readonly hasBar: boolean;
  readonly shells: boolean;
  /** Ejection happens at the pump stroke (shotgun) instead of on the shot. */
  readonly ejectAt: number;
  readonly kickBack: number;
  readonly kickPitch: number;
}

/** Holo lens: coated glass + collimated reticle (dot + broken ring) drawn where the sight axis meets infinity. */
function createLensMaterial(color: THREE.Color): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uColor: { value: color },
      uReticle: { value: new THREE.Vector2() },
      uAspect: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec2 vNdc;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        vNdc = gl_Position.xy / gl_Position.w;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform vec2 uReticle;
      uniform float uAspect;
      varying vec2 vUv;
      varying vec2 vNdc;
      void main() {
        vec2 d = (vNdc - uReticle) * vec2(uAspect, 1.0);
        float r = length(d);
        float dotR = 1.0 - smoothstep(0.0035, 0.0065, r);
        float ring = (1.0 - smoothstep(0.0018, 0.0042, abs(r - 0.034)));
        float ang = atan(d.y, d.x);
        ring *= step(0.16, abs(sin(ang * 2.0 + 0.785)));
        vec2 e = abs(vUv - 0.5) * 2.0;
        float edge = smoothstep(0.55, 1.0, max(e.x, e.y));
        vec3 glass = mix(vec3(0.05, 0.11, 0.12), vec3(0.16, 0.08, 0.2), vUv.y) * (0.6 + 0.8 * edge);
        float glint = smoothstep(0.08, 0.0, abs(vUv.x - vUv.y * 0.7 - 0.12)) * 0.35;
        vec3 col = glass + vec3(glint) + uColor * (dotR * 3.2 + ring * 1.9);
        float a = clamp(0.16 + 0.3 * edge + glint * 0.4 + dotR + ring * 0.85, 0.0, 1.0);
        gl_FragColor = vec4(col, a);
      }
    `,
  });
}

/** Additive star flash (muzzle) / spark (ejection port). */
function createFlashMaterial(color: THREE.Color): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: { uColor: { value: color }, uSeed: { value: 0 }, uAlpha: { value: 0 } },
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
}

/** Three crossed quads merged into one geometry (one draw). */
function starGeometry(size: number): THREE.BufferGeometry {
  const a = new THREE.PlaneGeometry(size, size);
  const b = new THREE.PlaneGeometry(size, size).rotateY(Math.PI / 2);
  const c = new THREE.PlaneGeometry(size, size).rotateX(Math.PI / 2);
  const out = new THREE.BufferGeometry();
  const pos: number[] = [];
  const uv: number[] = [];
  for (const g of [a, b, c]) {
    const ng = g.toNonIndexed();
    pos.push(...(ng.getAttribute('position').array as Float32Array));
    uv.push(...(ng.getAttribute('uv').array as Float32Array));
    ng.dispose();
    g.dispose();
  }
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return out;
}

export class ViewModelRenderer {
  readonly root = new THREE.Group();
  private readonly weaponPivot = new THREE.Group();
  private readonly leftArm = new THREE.Group();
  private readonly winchDrum: THREE.Object3D;
  private readonly winchExit = new THREE.Object3D();
  private readonly rigs: Record<SlotId, WeaponRig>;
  private readonly flash: THREE.Mesh;
  private readonly flashMat: THREE.ShaderMaterial;
  private readonly spark: THREE.Mesh;
  private readonly sparkMat: THREE.ShaderMaterial;
  private readonly muzzleLight: THREE.PointLight;
  private readonly lensMat: THREE.ShaderMaterial;
  /** Shared hard-surface / glove uniforms (energy colour, charge, ammo bar, shells, claws). */
  private readonly hardU: KitUniforms = createKitUniforms();
  private readonly gearU: KitUniforms = createKitUniforms();
  private readonly hardMat: THREE.MeshStandardMaterial;
  private readonly gearMat: THREE.MeshStandardMaterial;

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
  private sparkLife = 0;
  private lightLife = 0;
  private triggerT = 1;
  private clawT = 1;
  private drumAngle = 0;
  private winchAngle = 0;
  private time = 0;
  private lastSlot: SlotId = 'PISTOL';
  private ejectPending = false;
  private readonly leftPos = new THREE.Vector3(-0.25, -0.3, -0.42);
  private readonly leftQuat = new THREE.Quaternion();
  private rimLight!: THREE.DirectionalLight;
  private energyHex: number = COLORS.PLAYER_STRAND;
  private plasma = false;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly vmCamera: THREE.PerspectiveCamera,
    textures: Pick<ProceduralTextureLibrary, 'gun' | 'glove'>,
  ) {
    this.root.name = 'ViewModel';
    scene.add(this.root);
    this.root.add(this.weaponPivot, this.leftArm);

    this.hardMat = kitMaterial(textures.gun, this.hardU, 'hard', 1.0);
    this.gearMat = kitMaterial(textures.glove, this.gearU, 'gear', 0.9);
    this.lensMat = createLensMaterial(new THREE.Color(COLORS.PLAYER_STRAND).multiplyScalar(1.6));
    this.applyEnergyUniforms();

    // Dedicated view-model lighting: cool key from the upper left, strand-cyan rim from behind-right, warm
    // low fill (street lamps) — plus the 60 ms muzzle light (always present, so programs never recompile).
    const key = new THREE.DirectionalLight(0xdfe9ff, 2.1);
    key.position.set(-0.6, 1.0, 0.8);
    const rim = new THREE.DirectionalLight(COLORS.PLAYER_STRAND, 1.5);
    rim.position.set(0.9, 0.3, -1.0);
    this.rimLight = rim;
    const fill = new THREE.PointLight(0xffb070, 0.6, 2.5, 2);
    fill.position.set(0.1, -0.6, -0.2);
    this.muzzleLight = new THREE.PointLight(0xffffff, 0, 1.3, 2);
    scene.add(key, rim, fill, this.muzzleLight);

    // ---------------- Weapons (each with its own posed right hand) ----------------
    this.rigs = {
      PISTOL: this.buildPistol(),
      SMG: this.buildSmg(),
      SHOTGUN: this.buildShotgun(),
      GRAPPLE: this.buildGrapple(),
    };
    for (const r of Object.values(this.rigs)) {
      r.group.visible = false;
      this.weaponPivot.add(r.group);
    }

    // ---------------- Left hand / forearm with the wrist winch ----------------
    const left = this.buildLeftArm();
    this.winchDrum = left.drum;
    this.leftQuat.setFromEuler(_e.set(0.25, 0.3, 0.2));

    // ---------------- Muzzle flash + ejection spark (one draw each, only while visible) ----------------
    this.flashMat = createFlashMaterial(new THREE.Color(COLORS.PLAYER_STRAND));
    this.flash = new THREE.Mesh(starGeometry(0.16), this.flashMat);
    this.flash.visible = false;
    this.flash.renderOrder = 10;
    this.sparkMat = createFlashMaterial(new THREE.Color(0xffd9a0));
    this.spark = new THREE.Mesh(starGeometry(0.05), this.sparkMat);
    this.spark.visible = false;
    this.spark.renderOrder = 10;
    this.weaponPivot.add(this.flash, this.spark);
    this.weaponPivot.position.set(0.21, -0.2, -0.42);
  }

  // =============================================================================================
  // Materials / colours
  // =============================================================================================
  private applyEnergyUniforms(): void {
    const c = new THREE.Color(this.plasma ? 0xdcf2ff : this.energyHex);
    this.hardU.uEnergy.value.copy(c);
    this.gearU.uEnergy.value.copy(c);
    (this.lensMat.uniforms.uColor.value as THREE.Color).copy(c).multiplyScalar(1.6);
  }

  /** §8.3 weapon energy colour: every energy-lit part, the holo reticles, the muzzle flash and the rim light. */
  setEnergyColor(hex: number): void {
    if (hex === this.energyHex) return;
    this.energyHex = hex;
    this.rimLight.color.setHex(hex);
    if (!this.plasma) (this.flashMat.uniforms.uColor.value as THREE.Color).setHex(hex);
    this.applyEnergyUniforms();
  }

  /** FLOW SS+: the muzzle flash turns plasma blue-white. */
  setPlasmaMuzzle(on: boolean): void {
    this.plasma = on;
    (this.flashMat.uniforms.uColor.value as THREE.Color).setHex(on ? 0xdcf2ff : this.energyHex);
  }

  private mesh(kit: MeshKit, mat: THREE.Material, name: string, parent: THREE.Object3D, pos?: THREE.Vector3): THREE.Mesh {
    const m = new THREE.Mesh(kit.build(), mat);
    m.name = name;
    m.frustumCulled = false;
    if (pos) m.position.copy(pos);
    parent.add(m);
    return m;
  }

  // =============================================================================================
  // Shared parts
  // =============================================================================================
  /** Holographic sight: bevelled hood with a window + coated lens. Returns the lens (local window centre). */
  private holoSight(kit: MeshKit, parent: THREE.Object3D, x: number, y: number, z: number, w: number, h: number, depth: number): THREE.Mesh {
    const win = roundRect(w - 0.008, h - 0.012, 0.003).map(([px, py]) => [px, py + h * 0.46] as [number, number]);
    const outer: Array<[number, number]> = [[-w / 2, 0], [w / 2, 0], [w / 2, h * 0.78], [w / 2 - 0.004, h], [-w / 2 + 0.004, h], [-w / 2, h * 0.78]];
    kit.add(frontPlate(outer, depth, 0.0022, [win]), { tint: T.BLACK, zone: 3 }, at(x, y, z));
    // Mount base (on the rail), battery cap and two adjustment turrets.
    kit.add(bevelBox(w * 0.8, 0.006, depth * 0.9, 0.0015), { tint: T.DARK, zone: 0 }, at(x, y - 0.003, z));
    kit.add(lathe([[0, 0], [0.0045, 0], [0.0045, 0.006], [0, 0.006]], 14), { tint: T.DARK, zone: 0 }, at(x + w / 2, y + h * 0.45, z, 0, -Math.PI / 2));
    kit.add(bevelBox(0.008, 0.004, 0.008, 0.0012), { tint: T.GUNMETAL, zone: 0 }, at(x, y + h + 0.002, z + depth * 0.15));
    // Emitter window at the rear bottom (laser diode glow).
    kit.add(bevelBox(0.006, 0.003, 0.002, 0.0006), { tint: 0xffffff, zone: 0, glow: [0.6, 0, 0] }, at(x, y + 0.004, z + depth / 2 - 0.004));
    const lens = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.009, h - 0.013), this.lensMat);
    lens.position.set(x, y + h * 0.46, z);
    lens.renderOrder = 5;
    lens.frustumCulled = false;
    parent.add(lens);
    return lens;
  }

  /** Diegetic ammo bar recessed in a bevelled housing on the left flank (length scales in the shader). */
  private ammoHousing(kit: MeshKit, x: number, y: number, zRear: number, len: number): void {
    kit.add(bevelBox(0.003, 0.012, len + 0.012, 0.001), { tint: T.BLACK, zone: 3 }, at(x - 0.0006, y, zRear - len / 2));
    kit.add(bevelBox(0.0034, 0.0022, len + 0.012, 0.0008), { tint: T.GUNMETAL, zone: 0 }, at(x - 0.0012, y + 0.0058, zRear - len / 2));
    kit.add(bevelBox(0.0034, 0.0022, len + 0.012, 0.0008), { tint: T.GUNMETAL, zone: 0 }, at(x - 0.0012, y - 0.0058, zRear - len / 2));
    const bar = new THREE.BoxGeometry(0.0022, 0.0052, len);
    kit.add(bar, { tint: 0x101214, zone: 3, glow: [0, 0, 1], anim: [zRear, 1, 0, 0] }, at(x - 0.0019, y, zRear - len / 2));
  }

  /**
   * Right glove wrapped around a grip: five jointed fingers (index on the trigger, separate mesh that pulls),
   * palm and back with four carbon knuckle plates, thumb along the left flank, wrist, cuff, sleeve and the
   * forearm exo-brace (rails, rings, light fibres, cables).
   */
  private rightHand(gear: MeshKit, hard: MeshKit, group: THREE.Group, g: GripDef): THREE.Object3D {
    const M = new THREE.Matrix4().compose(g.top, _q.setFromEuler(_e.set(g.tilt, 0, 0)), _s.set(1, 1, 1));
    const G = (x: number, y: number, z: number): THREE.Vector3 => V(x, y, z).applyMatrix4(M);
    const leather: PartOpts = { tint: T.LEATHER, zone: 0, tile: 0.06 };
    const rubber: PartOpts = { tint: T.RUBBER, zone: 2, tile: 0.05 };
    const carbon: PartOpts = { tint: T.CARBON, zone: 2, rough: 0.8, metal: 2 };
    const ring = (a: number, y: number, r: number): THREE.Vector3 => {
      const rad = (a * Math.PI) / 180;
      return G(Math.cos(rad) * (g.rx + r + 0.001), y, -Math.sin(rad) * (g.rz + r + 0.001));
    };
    // Middle, ring, little fingers wrap the grip (MCP −45° → PIP 35° → DIP 100° → tip 150°).
    const fingers: Array<[number, number, number]> = [[-0.026, 0.0105, 150], [-0.047, 0.0102, 148], [-0.067, 0.0092, 138]];
    for (const [y, r, tipA] of fingers) {
      const j = [ring(-45, y, r), ring(35, y, r), ring(100, y - 0.001, r * 0.94), ring(tipA, y - 0.002, r * 0.86)];
      gear.add(capsule(j[0], j[1], r), leather);
      gear.add(capsule(j[1], j[2], r * 0.92), leather);
      gear.add(capsule(j[2], j[3], r * 0.84), rubber);
      // Carbon knuckle plate over the proximal phalanx.
      hard.add(this.knucklePlate(j[0], j[1], G(0, y, 0), r), carbon);
    }
    // Palm block + back plate (between the knuckle line and the wrist).
    const kTop = ring(-45, -0.004, 0.0105);
    const kBot = ring(-45, -0.07, 0.0095);
    const wrist = G(g.rx * 0.7, -0.05, g.rz + 0.058);
    const kMid = kTop.clone().lerp(kBot, 0.5);
    const u = wrist.clone().sub(kMid).normalize();
    const vax = kTop.clone().sub(kBot).normalize();
    const w = V(0, 0, 0).crossVectors(u, vax).normalize();
    if (w.x < 0) {
      w.negate();
      vax.negate();
    }
    const palmLen = kMid.distanceTo(wrist) + 0.008;
    const palm = bevelBox(palmLen, 0.082, 0.032, 0.008);
    palm.applyMatrix4(new THREE.Matrix4().makeBasis(u, vax, w));
    const pc = kMid.clone().lerp(wrist, 0.5).addScaledVector(w, -0.006);
    palm.translate(pc.x, pc.y, pc.z);
    gear.add(palm, leather);
    const back = bevelBox(palmLen * 0.7, 0.06, 0.006, 0.002);
    back.applyMatrix4(new THREE.Matrix4().makeBasis(u, vax, w));
    const bc = pc.clone().addScaledVector(w, 0.017).addScaledVector(u, 0.004);
    back.translate(bc.x, bc.y, bc.z);
    hard.add(back, carbon);
    // Thumb along the left flank (CMC → MCP → IP → tip) with its thenar pad.
    const t0 = ring(-120, -0.004, 0.012);
    const t1 = ring(-162, 0.002, 0.012);
    const t2 = ring(160, 0.006, 0.0115);
    const t3 = ring(132, 0.008, 0.0095);
    gear.add(capsule(wrist.clone().addScaledVector(w, -0.02), t0, 0.017), leather);
    gear.add(capsule(t0, t1, 0.0125), leather);
    gear.add(capsule(t1, t2, 0.0115), leather);
    gear.add(capsule(t2, t3, 0.0098), rubber);
    // Wrist, gauntlet cuff, jacket sleeve toward the bottom-right of the screen.
    const fDir = V(0.08, -0.34, 0.94).normalize();
    const f0 = wrist.clone().addScaledVector(fDir, 0.012);
    gear.add(capsule(pc.clone().addScaledVector(u, palmLen * 0.3), f0, 0.03), leather);
    gear.add(cylinder(f0, f0.clone().addScaledVector(fDir, 0.07), 0.034, 0.04, 16), { tint: T.NYLON, zone: 1, tile: 0.07 });
    gear.add(cylinder(f0.clone().addScaledVector(fDir, 0.02), f0.clone().addScaledVector(fDir, 0.045), 0.0415, 0.0425, 16), { tint: T.RUBBER, zone: 2 });
    gear.add(cylinder(f0.clone().addScaledVector(fDir, 0.065), f0.clone().addScaledVector(fDir, 0.48), 0.046, 0.056, 18), { tint: T.JACKET, zone: 3, tile: 0.12 });
    this.exoBrace(hard, f0, fDir, 0.044, 1);
    // Cables from the back plate into the brace.
    const up = V(0, 1, 0);
    hard.add(tube([bc.clone().addScaledVector(w, 0.004), bc.clone().addScaledVector(u, 0.03).addScaledVector(w, 0.012), f0.clone().addScaledVector(fDir, 0.1).addScaledVector(up, 0.05)], 0.0022, 18, 5), { tint: T.BLACK, zone: 2 });
    hard.add(tube([bc.clone().addScaledVector(vax, -0.02).addScaledVector(w, 0.004), bc.clone().addScaledVector(u, 0.035).addScaledVector(w, 0.014).addScaledVector(vax, -0.015), f0.clone().addScaledVector(fDir, 0.12).addScaledVector(up, 0.035).add(V(0.02, 0, 0))], 0.0018, 18, 5), { tint: T.DARK, zone: 2 });
    // Index finger on the trigger (own mesh: it pulls on every shot).
    const iMcp = ring(-22, -0.004, 0.0105);
    const tr = g.trigger;
    const iPip = V(Math.max(iMcp.x, 0.024), (iMcp.y + tr.y) / 2 + 0.004, tr.z + 0.028);
    const iDip = V(0.013, tr.y + 0.001, tr.z - 0.004);
    const iTip = V(0.003, tr.y - 0.006, tr.z + 0.004);
    const idx = new MeshKit();
    for (const [a, b, r, o] of [[iMcp, iPip, 0.0105, leather], [iPip, iDip, 0.0095, leather], [iDip, iTip, 0.0086, rubber]] as const) {
      idx.add(capsule(a.clone().sub(iMcp), b.clone().sub(iMcp), r), o);
    }
    const pivot = new THREE.Group();
    pivot.position.copy(iMcp);
    group.add(pivot);
    this.mesh(idx, this.gearMat, 'IndexFinger', pivot);
    // The index knuckle plate sits on the knuckle itself (static hard mesh — the knuckle barely moves).
    hard.add(this.knucklePlate(iMcp.clone().lerp(iPip, -0.25), iMcp.clone().lerp(iPip, 0.45), G(0, iMcp.y - g.top.y, 0), 0.0105), carbon);
    return pivot;
  }

  /** Bevelled carbon plate over a proximal phalanx a → b (`hub` = point on the held axis at that height). */
  private knucklePlate(a: THREE.Vector3, b: THREE.Vector3, hub: THREE.Vector3, r: number): THREE.BufferGeometry {
    const along = b.clone().sub(a).normalize();
    const mid = a.clone().lerp(b, 0.35);
    const out = mid.clone().sub(hub);
    out.addScaledVector(along, -out.dot(along)).normalize();
    const x = V(0, 0, 0).crossVectors(out, along).normalize();
    const plate = bevelBox(0.016, 0.004, 0.02, 0.0012);
    plate.applyMatrix4(new THREE.Matrix4().makeBasis(x, out, along));
    plate.translate(mid.x + out.x * (r + 0.002), mid.y + out.y * (r + 0.002), mid.z + out.z * (r + 0.002));
    return plate;
  }

  /** Forearm exo-brace: two rails, three clamp rings, energy fibres. `side` mirrors it for the left arm. */
  private exoBrace(hard: MeshKit, f0: THREE.Vector3, dir: THREE.Vector3, r: number, side: 1 | -1): void {
    const up = V(0, 1, 0).addScaledVector(dir, -dir.y).normalize();
    const right = V(0, 0, 0).crossVectors(dir, up).normalize().multiplyScalar(side);
    for (const o of [up, right]) {
      const a = f0.clone().addScaledVector(dir, 0.08).addScaledVector(o, r + 0.008);
      const b = f0.clone().addScaledVector(dir, 0.34).addScaledVector(o, r + 0.016);
      hard.add(cylinder(a, b, 0.0045, 0.0045, 6), { tint: T.GUNMETAL, zone: 0 });
      hard.add(cylinder(a.clone().addScaledVector(right, 0.007), b.clone().addScaledVector(right, 0.007), 0.0016, 0.0016, 5), { tint: 0x0a0c10, zone: 0, glow: [1.3, 0, 0] });
    }
    for (const t of [0.1, 0.2, 0.31]) {
      const c = f0.clone().addScaledVector(dir, t);
      const ringG = torus(r + 0.006 + t * 0.03, 0.0035, 6, 24);
      _q.setFromUnitVectors(V(0, 0, 1), dir);
      ringG.applyQuaternion(_q);
      ringG.translate(c.x, c.y, c.z);
      hard.add(ringG, { tint: T.DARK, zone: 3 });
    }
  }

  // =============================================================================================
  // Weapon builders (gun space: +Z toward the player, −Z toward the muzzle; profiles use f = −z)
  // =============================================================================================
  private buildPistol(): WeaponRig {
    const group = new THREE.Group();
    const hard = new MeshKit();
    const gear = new MeshKit();
    const slideKit = new MeshKit();
    const magKit = new MeshKit();
    // Frame (polymer) with dust-cover rail, trigger guard loop, trigger and laser module.
    hard.add(profile([[-0.05, -0.002], [0.17, -0.002], [0.172, -0.012], [0.165, -0.03], [0.075, -0.03], [0.07, -0.024], [0.0, -0.024], [-0.03, -0.02], [-0.05, -0.012]], 0.03, 0.003), { tint: T.POLYMER, zone: 2 });
    hard.add(profile([[0.0, -0.024], [0.072, -0.024], [0.07, -0.032], [0.056, -0.052], [0.0, -0.052], [-0.006, -0.044]], 0.013, 0.0025, [[[0.007, -0.028], [0.058, -0.028], [0.05, -0.046], [0.007, -0.046]]]), { tint: T.POLYMER, zone: 2 });
    hard.add(profile([[0.028, -0.024], [0.033, -0.024], [0.031, -0.035], [0.024, -0.044], [0.021, -0.042], [0.026, -0.034]], 0.006, 0.0012), { tint: T.DARK, zone: 0 });
    for (let f = 0.088; f < 0.162; f += 0.01) hard.add(bevelBox(0.021, 0.0036, 0.0052, 0.0009), { tint: T.DARK, zone: 0 }, at(0, -0.032, -f));
    hard.add(bevelBox(0.024, 0.02, 0.05, 0.0035), { tint: T.BLACK, zone: 3 }, at(0, -0.045, -0.13));
    hard.add(cylinder(V(0, -0.045, -0.154), V(0, -0.045, -0.157), 0.0055, 0.0055, 14), { tint: T.LASER, zone: 0, self: 2.4 });
    hard.add(bevelBox(0.004, 0.006, 0.01, 0.001), { tint: T.GUNMETAL, zone: 0 }, at(0.013, -0.04, -0.115));
    // Grip (checkered) with beavertail; magazine base plate is a moving part.
    const grip: GripDef = { top: V(0, -0.02, 0.022), tilt: -0.25, rx: 0.0155, rz: 0.023, trigger: V(0, -0.034, -0.027) };
    hard.add(bevelBox(0.031, 0.1, 0.046, 0.006), { tint: T.GRIP, zone: 1, tile: 0.05 }, gripMatrix(grip, 0, -0.05, 0));
    hard.add(bevelBox(0.03, 0.012, 0.024, 0.004), { tint: T.POLYMER, zone: 2 }, gripMatrix(grip, 0, -0.002, 0.03, 0.3));
    magKit.add(bevelBox(0.024, 0.09, 0.032, 0.002), { tint: T.DARK, zone: 0 }, at(0, 0.0, 0));
    magKit.add(bevelBox(0.033, 0.011, 0.05, 0.003), { tint: T.BLACK, zone: 2 }, at(0, -0.047, 0.002));
    // Slide (blowback): angled front cut, rear serrations, coil slits glowing from inside, port, rail, sight.
    const slide = new THREE.Group();
    group.add(slide);
    slideKit.add(profile([[-0.05, 0.0], [0.175, 0.0], [0.197, 0.01], [0.197, 0.03], [0.183, 0.043], [-0.03, 0.043], [-0.05, 0.03]], 0.032, 0.0035), { tint: T.GUNMETAL, zone: 0 });
    for (const sx of [-1, 1]) {
      for (let k = 0; k < 6; k++) slideKit.add(bevelBox(0.0016, 0.026, 0.0028, 0.0006), { tint: T.DARK, zone: 0 }, at(sx * 0.0166, 0.022, 0.045 - k * 0.005));
      for (let k = 0; k < 5; k++) {
        const z = -0.08 - k * 0.018;
        slideKit.add(bevelBox(0.0014, 0.019, 0.009, 0.0006), { tint: 0x0a0b0d, zone: 3, rough: 1.6 }, at(sx * 0.0167, 0.022, z));
        slideKit.add(new THREE.BoxGeometry(0.0012, 0.011, 0.0022), { tint: 0x0a0c10, zone: 3, glow: [0.1, 1.5, 0] }, at(sx * 0.0169, 0.022, z));
      }
    }
    slideKit.add(new THREE.BoxGeometry(0.0016, 0.014, 0.036), { tint: 0x08090b, zone: 3 }, at(0.0166, 0.031, -0.04));
    slideKit.add(bevelBox(0.0018, 0.008, 0.03, 0.0008), { tint: T.CHROME, zone: 0 }, at(0.0168, 0.031, -0.04));
    slideKit.add(lathe([[0.0098, 0], [0.0098, 0.002], [0.0062, 0.003], [0.0045, 0.002], [0.0045, -0.004]], 18), { tint: T.DARK, zone: 0 }, at(0, 0.021, -0.197));
    addRail(slideKit, -0.046, 0.012, 0.047, 0, T.DARK);
    const lens = this.holoSight(slideKit, slide, 0, 0.05, -0.014, 0.03, 0.025, 0.026);
    // Ammo housing on the left flank of the frame.
    this.ammoHousing(hard, -0.0158, -0.012, 0.035, 0.08);
    const index = this.rightHand(gear, hard, group, grip);
    this.mesh(hard, this.hardMat, 'PistolFrame', group);
    this.mesh(gear, this.gearMat, 'PistolHand', group);
    this.mesh(slideKit, this.hardMat, 'PistolSlide', slide);
    const magRest = V(0, -0.05, 0.012).applyAxisAngle(V(1, 0, 0), grip.tilt).add(grip.top);
    const magAxis = V(0, -Math.cos(grip.tilt), -Math.sin(grip.tilt));
    const mag = this.mesh(magKit, this.hardMat, 'PistolMag', group, magRest);
    mag.rotation.x = grip.tilt;
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, 0.021, -0.2);
    const eject = new THREE.Object3D();
    eject.position.set(0.02, 0.032, -0.04);
    group.add(muzzle, eject);
    return { group, muzzle, eject, lens, sight: lens.position.clone(), adsDist: 0.3, slide, slideTravel: 0.028, mag, magRest, magAxis, index, hasBar: true, shells: false, ejectAt: 0, kickBack: 0.05, kickPitch: 0.13 };
  }

  private buildSmg(): WeaponRig {
    const group = new THREE.Group();
    const hard = new MeshKit();
    const gear = new MeshKit();
    const boltKit = new MeshKit();
    const magKit = new MeshKit();
    // Faceted (polyhedral) upper receiver + polymer lower, angled side armour plates.
    hard.add(profile([[-0.11, 0.008], [-0.11, 0.036], [-0.085, 0.05], [0.125, 0.05], [0.15, 0.036], [0.15, 0.008]], 0.046, 0.0035), { tint: T.GUNMETAL, zone: 0 });
    hard.add(profile([[-0.11, -0.03], [-0.11, 0.008], [0.15, 0.008], [0.15, -0.012], [0.115, -0.032], [-0.07, -0.032]], 0.043, 0.0035), { tint: T.POLYMER, zone: 2 });
    hard.add(profile([[-0.005, 0.012], [0.1, 0.012], [0.116, 0.03], [0.0, 0.035], [-0.022, 0.024]], 0.05, 0.002), { tint: T.DARK, zone: 3 });
    // Top rail + holographic sight (EOTech-like hood).
    addRail(hard, -0.095, 0.125, 0.054, 0, T.DARK);
    const lens = this.holoSight(hard, group, 0, 0.057, 0.0, 0.046, 0.037, 0.042);
    // Perforated heat shroud and the pulse emitter with energy rings.
    hard.add(lathe([[0.0195, 0.15], [0.0195, 0.258], [0.016, 0.262], [0.016, 0.15]], 22), { tint: T.DARK, zone: 3 }, at(0, 0.012, 0));
    for (let i = 0; i < 6; i++) {
      for (let k = 0; k < 4; k++) {
        const a = 0.35 + (k / 3) * 2.4;
        const f = 0.162 + i * 0.016;
        hard.add(new THREE.BoxGeometry(0.0062, 0.0062, 0.003), { tint: 0x050607, zone: 3, rough: 2 }, at(Math.cos(a) * 0.0196, 0.012 + Math.sin(a) * 0.0196, -f, 0, 0, a + Math.PI / 2));
      }
    }
    hard.add(lathe([[0.012, 0.258], [0.0165, 0.262], [0.0165, 0.292], [0.013, 0.3], [0.007, 0.3], [0.007, 0.29]], 22), { tint: T.GUNMETAL, zone: 0 }, at(0, 0.012, 0));
    for (const f of [0.268, 0.278, 0.288]) {
      const t = torus(0.0168, 0.0016, 6, 24);
      t.translate(0, 0.012, -f);
      hard.add(t, { tint: 0x0a0c10, zone: 0, glow: [0.5, 1.3, 0] });
    }
    // Side heat-sink fins, energy strips, angled foregrip, grip, skeletal stock.
    for (const sx of [-1, 1]) {
      for (let k = 0; k < 7; k++) hard.add(bevelBox(0.004, 0.022, 0.0075, 0.001), { tint: T.GUNMETAL, zone: 0 }, at(sx * 0.0262, 0.025, -0.035 - k * 0.0115));
      hard.add(new THREE.BoxGeometry(0.0014, 0.0018, 0.11), { tint: 0x0a0c10, zone: 0, glow: [1.05, 0, 0] }, at(sx * 0.0232, 0.003, -0.02));
    }
    hard.add(bevelBox(0.028, 0.072, 0.034, 0.006), { tint: T.GRIP, zone: 1, tile: 0.05 }, at(0, -0.062, -0.112, 0.35));
    const grip: GripDef = { top: V(0, -0.03, 0.032), tilt: -0.2, rx: 0.015, rz: 0.021, trigger: V(0, -0.044, -0.012) };
    hard.add(bevelBox(0.03, 0.095, 0.042, 0.006), { tint: T.GRIP, zone: 1, tile: 0.05 }, gripMatrix(grip, 0, -0.0475, 0));
    hard.add(profile([[0.0, -0.032], [0.05, -0.032], [0.048, -0.04], [0.036, -0.056], [0.0, -0.056], [-0.006, -0.047]], 0.012, 0.0022, [[[0.007, -0.036], [0.042, -0.036], [0.034, -0.05], [0.007, -0.05]]]), { tint: T.POLYMER, zone: 2 }, at(0, 0, 0.0));
    hard.add(profile([[0.006, -0.032], [0.011, -0.032], [0.009, -0.042], [0.003, -0.05], [0.0, -0.048], [0.004, -0.04]], 0.006, 0.0012), { tint: T.DARK, zone: 0 });
    hard.add(bevelBox(0.012, 0.012, 0.13, 0.003), { tint: T.DARK, zone: 0 }, at(0, 0.006, 0.17));
    hard.add(bevelBox(0.012, 0.012, 0.12, 0.003), { tint: T.DARK, zone: 0 }, at(0, -0.026, 0.165, 0.12));
    hard.add(bevelBox(0.03, 0.062, 0.014, 0.004), { tint: T.RUBBER, zone: 2 }, at(0, -0.012, 0.236));
    // Ejection port (right) with the bolt carrier visible inside — the bolt and charging handle are the blowback part.
    hard.add(new THREE.BoxGeometry(0.0016, 0.016, 0.046), { tint: 0x08090b, zone: 3 }, at(0.0232, 0.026, -0.03));
    const bolt = new THREE.Group();
    group.add(bolt);
    boltKit.add(bevelBox(0.003, 0.012, 0.03, 0.001), { tint: T.CHROME, zone: 0 }, at(0.0226, 0.026, -0.032));
    boltKit.add(bevelBox(0.012, 0.008, 0.018, 0.002), { tint: T.DARK, zone: 0 }, at(0.03, 0.04, 0.0));
    // Magazine (detachable).
    magKit.add(bevelBox(0.024, 0.115, 0.034, 0.003), { tint: T.DARK, zone: 0 }, at(0, 0, 0));
    magKit.add(bevelBox(0.028, 0.008, 0.04, 0.0025), { tint: T.BLACK, zone: 2 }, at(0, -0.06, 0.0));
    for (let k = 0; k < 4; k++) magKit.add(bevelBox(0.0254, 0.003, 0.03, 0.0008), { tint: T.BLACK, zone: 0 }, at(0, 0.03 - k * 0.02, 0));
    this.ammoHousing(hard, -0.0218, -0.012, 0.05, 0.1);
    const index = this.rightHand(gear, hard, group, grip);
    this.mesh(hard, this.hardMat, 'SmgBody', group);
    this.mesh(gear, this.gearMat, 'SmgHand', group);
    this.mesh(boltKit, this.hardMat, 'SmgBolt', bolt);
    const magRest = V(0, -0.085, -0.065);
    const mag = this.mesh(magKit, this.hardMat, 'SmgMag', group, magRest);
    mag.rotation.x = 0.12;
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, 0.012, -0.3);
    const eject = new THREE.Object3D();
    eject.position.set(0.03, 0.026, -0.03);
    group.add(muzzle, eject);
    return {
      group, muzzle, eject, lens, sight: lens.position.clone(), adsDist: 0.24, slide: bolt, slideTravel: 0.018,
      mag, magRest, magAxis: V(0, -Math.cos(0.12), -Math.sin(0.12)), index, support: V(0, -0.034, -0.082), hasBar: true, shells: false, ejectAt: 0, kickBack: 0.016, kickPitch: 0.035,
    };
  }

  private buildShotgun(): WeaponRig {
    const group = new THREE.Group();
    const hard = new MeshKit();
    const gear = new MeshKit();
    const pumpKit = new MeshKit();
    // Receiver, twin barrels, perforated heat shield.
    hard.add(profile([[-0.09, -0.032], [-0.09, 0.03], [-0.07, 0.046], [0.12, 0.046], [0.136, 0.032], [0.136, -0.012], [0.1, -0.036], [-0.05, -0.036]], 0.062, 0.004), { tint: T.GUNMETAL, zone: 0 });
    hard.add(profile([[-0.06, -0.02], [0.1, -0.02], [0.11, 0.0], [0.1, 0.03], [-0.06, 0.03]], 0.066, 0.002), { tint: T.DARK, zone: 3 });
    for (const bx of [-0.0165, 0.0165]) {
      hard.add(lathe([[0.016, 0.136], [0.016, 0.462], [0.0175, 0.466], [0.0175, 0.476], [0.0115, 0.476], [0.0115, 0.45]], 20), { tint: T.DARK, zone: 0 }, at(bx, 0.02, 0));
      hard.add(lathe([[0.0115, 0.47], [0.0115, 0.477], [0.0, 0.477]], 16), { tint: 0x050505, zone: 3 }, at(bx, 0.02, 0));
    }
    const shield = new THREE.CylinderGeometry(0.039, 0.039, 0.26, 26, 1, true, -1.75, 3.5);
    shield.rotateX(Math.PI / 2);
    hard.add(shield, { tint: T.DARK, zone: 3, rough: 1.2 }, at(0, 0.02, -0.29));
    for (let i = 0; i < 9; i++) {
      for (let k = 0; k < 5; k++) {
        const a = -1.2 + k * 0.6;
        const z = -0.175 - i * 0.026;
        hard.add(bevelBox(0.008, 0.0042, 0.013, 0.0012), { tint: 0x040506, zone: 3, rough: 2 }, at(Math.sin(a) * 0.0394, 0.02 + Math.cos(a) * 0.0394, z, 0, 0, -a));
      }
    }
    for (const z of [-0.17, -0.41]) hard.add(bevelBox(0.07, 0.008, 0.008, 0.002), { tint: T.GUNMETAL, zone: 0 }, at(0, 0.004, z));
    addRail(hard, -0.07, 0.12, 0.05, 0, T.DARK);
    const lens = this.holoSight(hard, group, 0, 0.053, 0.01, 0.046, 0.037, 0.042);
    // Side-saddle 4-shell carrier (right flank, ammo-linked in the shader).
    hard.add(bevelBox(0.004, 0.036, 0.1, 0.0012), { tint: T.BLACK, zone: 2 }, at(0.0335, 0.004, 0.0));
    for (let i = 0; i < 4; i++) {
      const z = 0.034 - i * 0.022;
      hard.add(lathe([[0.0, 0.0], [0.0092, 0.0], [0.0092, 0.011], [0.0, 0.011]], 14), { tint: T.BRASS, zone: 0, anim: [0, 0, i, 1] }, at(0.0395, -0.025, z, Math.PI / 2));
      hard.add(lathe([[0.0086, 0.011], [0.0086, 0.056], [0.006, 0.058], [0.0, 0.058]], 14), { tint: T.SHELL, zone: 2, rough: 0.8, anim: [0, 0, i, 1] }, at(0.0395, -0.025, z, Math.PI / 2));
    }
    // Grip, trigger guard, stock stub.
    const grip: GripDef = { top: V(0, -0.03, 0.058), tilt: -0.25, rx: 0.016, rz: 0.023, trigger: V(0, -0.046, 0.022) };
    hard.add(bevelBox(0.032, 0.1, 0.046, 0.006), { tint: T.GRIP, zone: 1, tile: 0.05 }, gripMatrix(grip, 0, -0.05, 0));
    hard.add(profile([[-0.04, -0.036], [0.012, -0.036], [0.008, -0.044], [-0.006, -0.06], [-0.04, -0.06], [-0.046, -0.05]], 0.012, 0.0022, [[[-0.034, -0.04], [0.004, -0.04], [-0.004, -0.054], [-0.034, -0.054]]]), { tint: T.POLYMER, zone: 2 });
    hard.add(profile([[-0.024, -0.036], [-0.019, -0.036], [-0.021, -0.046], [-0.027, -0.054], [-0.03, -0.052], [-0.026, -0.044]], 0.006, 0.0012), { tint: T.DARK, zone: 0 });
    hard.add(bevelBox(0.05, 0.06, 0.1, 0.008), { tint: T.POLYMER, zone: 2 }, at(0, -0.005, 0.13, -0.08));
    this.ammoHousing(hard, -0.0328, 0.0, 0.07, 0.12);
    // Ribbed pump fore-end (cycles 280 ms after the shot).
    const pump = new THREE.Group();
    pump.position.set(0, 0, -0.24);
    group.add(pump);
    pumpKit.add(bevelBox(0.064, 0.042, 0.12, 0.007), { tint: T.POLYMER, zone: 1, tile: 0.06 }, at(0, -0.016, 0));
    for (let k = 0; k < 6; k++) pumpKit.add(bevelBox(0.0685, 0.046, 0.0065, 0.002), { tint: T.BLACK, zone: 2 }, at(0, -0.016, -0.05 + k * 0.02));
    pumpKit.add(bevelBox(0.03, 0.012, 0.16, 0.003), { tint: T.DARK, zone: 0 }, at(0, -0.002, 0.07));
    const index = this.rightHand(gear, hard, group, grip);
    this.mesh(hard, this.hardMat, 'ShotgunBody', group);
    this.mesh(gear, this.gearMat, 'ShotgunHand', group);
    this.mesh(pumpKit, this.hardMat, 'ShotgunPump', pump);
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, 0.02, -0.48);
    const eject = new THREE.Object3D();
    eject.position.set(0.034, 0.03, -0.02);
    group.add(muzzle, eject);
    return { group, muzzle, eject, lens, sight: lens.position.clone(), adsDist: 0.25, slideTravel: 0, pump, index, support: V(0, -0.012, -0.24), hasBar: true, shells: true, ejectAt: 0.3, kickBack: 0.09, kickPitch: 0.28 };
  }

  private buildGrapple(): WeaponRig {
    const group = new THREE.Group();
    const hard = new MeshKit();
    const gear = new MeshKit();
    const pistonKit = new MeshKit();
    const hookKit = new MeshKit();
    const reelKit = new MeshKit();
    // Main launcher tube, top frame with rail + holo sight, clamp bands.
    hard.add(lathe([[0.0, -0.05], [0.03, -0.05], [0.036, -0.042], [0.036, 0.172], [0.03, 0.186], [0.02, 0.19], [0.0, 0.19]], 26), { tint: T.GUNMETAL, zone: 0 }, at(0, 0.015, 0));
    for (const f of [-0.02, 0.06, 0.14]) {
      const t = torus(0.0372, 0.0028, 6, 30);
      t.translate(0, 0.015, -f);
      hard.add(t, { tint: T.DARK, zone: 3 });
    }
    hard.add(profile([[-0.035, 0.045], [0.16, 0.045], [0.17, 0.052], [-0.025, 0.058]], 0.03, 0.0025), { tint: T.DARK, zone: 3 });
    addRail(hard, -0.03, 0.15, 0.062, 0, T.DARK);
    const lens = this.holoSight(hard, group, 0, 0.065, -0.02, 0.04, 0.032, 0.036);
    hard.add(new THREE.BoxGeometry(0.0022, 0.0028, 0.15), { tint: 0x0a0c10, zone: 0, glow: [1.1, 0, 0] }, at(0.0322, 0.034, -0.07));
    // Twin hydraulic cylinders (rods are the moving pistons) and the high-pressure canister with its gauge.
    for (const sx of [-1, 1]) {
      hard.add(lathe([[0.0, 0.0], [0.0095, 0.0], [0.0095, 0.112], [0.006, 0.116], [0.0, 0.116]], 16), { tint: T.DARK, zone: 0 }, at(sx * 0.034, -0.006, 0.01));
      hard.add(bevelBox(0.008, 0.014, 0.012, 0.002), { tint: T.GUNMETAL, zone: 0 }, at(sx * 0.03, -0.0, 0.016));
      pistonKit.add(cylinder(V(sx * 0.034, -0.006, -0.1), V(sx * 0.034, -0.006, -0.165), 0.0045, 0.0045, 12), { tint: T.CHROME, zone: 0, rough: 0.6 });
      pistonKit.add(bevelBox(0.012, 0.014, 0.01, 0.002), { tint: T.GUNMETAL, zone: 0 }, at(sx * 0.031, -0.004, -0.168));
    }
    hard.add(lathe([[0.0, -0.02], [0.011, -0.018], [0.017, -0.008], [0.017, 0.088], [0.011, 0.1], [0.0, 0.102]], 20), { tint: T.CANISTER, zone: 0, metal: 0.8 }, at(0, -0.048, 0.02));
    for (const f of [0.005, 0.07]) {
      const t = torus(0.0176, 0.002, 6, 24);
      t.translate(0, -0.048, 0.02 - f);
      hard.add(t, { tint: T.DARK, zone: 0 });
    }
    hard.add(cylinder(V(0.016, -0.048, -0.02), V(0.026, -0.048, -0.02), 0.008, 0.008, 18), { tint: T.GUNMETAL, zone: 0 });
    hard.add(cylinder(V(0.0262, -0.048, -0.02), V(0.0266, -0.048, -0.02), 0.0066, 0.0066, 18), { tint: T.GAUGE, zone: 2, self: 0.5 });
    hard.add(new THREE.BoxGeometry(0.0006, 0.0055, 0.0009), { tint: 0x101010, zone: 0 }, at(0.0268, -0.046, -0.02, 0, 0, 0.0, ));
    // Grip and guard.
    const grip: GripDef = { top: V(0, -0.022, 0.034), tilt: -0.22, rx: 0.015, rz: 0.022, trigger: V(0, -0.036, -0.01) };
    hard.add(bevelBox(0.03, 0.095, 0.044, 0.006), { tint: T.GRIP, zone: 1, tile: 0.05 }, gripMatrix(grip, 0, -0.0475, 0));
    hard.add(profile([[-0.006, -0.024], [0.042, -0.024], [0.04, -0.032], [0.028, -0.048], [-0.006, -0.048], [-0.012, -0.04]], 0.012, 0.0022, [[[0.0, -0.028], [0.034, -0.028], [0.026, -0.044], [0.0, -0.044]]]), { tint: T.POLYMER, zone: 2 });
    hard.add(profile([[0.008, -0.022], [0.013, -0.022], [0.011, -0.032], [0.005, -0.04], [0.002, -0.038], [0.006, -0.03]], 0.006, 0.0012), { tint: T.DARK, zone: 0 });
    // Exposed wire reel (rotating) + two guide pulleys + the wire into the breech.
    const reel = new THREE.Group();
    reel.position.set(0, -0.012, 0.075);
    group.add(reel);
    const core = new THREE.CylinderGeometry(0.022, 0.022, 0.034, 22);
    core.rotateZ(Math.PI / 2);
    reelKit.add(core, { tint: T.DARK, zone: 0 });
    for (const sx of [-0.019, 0.019]) {
      const fl = new THREE.CylinderGeometry(0.031, 0.031, 0.004, 26);
      fl.rotateZ(Math.PI / 2);
      fl.translate(sx, 0, 0);
      reelKit.add(fl, { tint: T.GUNMETAL, zone: 0 });
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * Math.PI * 2;
        reelKit.add(new THREE.BoxGeometry(0.0045, 0.006, 0.006), { tint: 0x0a0c10, zone: 0, glow: [0.6, 0, 0] }, at(sx * 1.12, Math.cos(a) * 0.024, Math.sin(a) * 0.024));
      }
    }
    const helix: THREE.Vector3[] = [];
    for (let i = 0; i <= 160; i++) {
      const t = i / 160;
      const a = t * Math.PI * 2 * 9;
      helix.push(V(-0.015 + t * 0.03, Math.cos(a) * 0.0245, Math.sin(a) * 0.0245));
    }
    reelKit.add(tube(helix, 0.0017, 320, 4), { tint: T.CHROME, zone: 0, rough: 0.7 });
    for (const [z, y] of [[0.035, 0.012], [0.0, 0.02]] as const) {
      const pg = new THREE.CylinderGeometry(0.0075, 0.0075, 0.008, 16);
      pg.rotateZ(Math.PI / 2);
      hard.add(pg, { tint: T.GUNMETAL, zone: 0 }, at(0, y, z));
    }
    hard.add(tube([V(0, 0.012, 0.075), V(0, 0.02, 0.04), V(0, 0.028, 0.0), V(0, 0.02, -0.04)], 0.0012, 20, 4), { tint: T.CHROME, zone: 0 });
    // Three-claw anchor (opens radially on launch, gold).
    const hook = new THREE.Group();
    hook.position.set(0, 0.015, -0.19);
    group.add(hook);
    hookKit.add(lathe([[0.0, 0.0], [0.011, 0.0], [0.011, 0.03], [0.008, 0.05], [0.0, 0.058]], 16), { tint: T.DARK, zone: 0 });
    for (let k = 0; k < 3; k++) {
      const claw = profile([[0.01, 0.006], [0.04, 0.014], [0.06, 0.022], [0.072, 0.016], [0.064, 0.011], [0.046, 0.009], [0.014, 0.002]], 0.006, 0.0012);
      claw.rotateZ((k / 3) * Math.PI * 2);
      hookKit.add(claw, { tint: T.GOLD, zone: 0, self: 0.9, anim: [0, 0, 0, -1] });
    }
    const index = this.rightHand(gear, hard, group, grip);
    this.mesh(hard, this.hardMat, 'GrappleBody', group);
    this.mesh(gear, this.gearMat, 'GrappleHand', group);
    const pistons = new THREE.Group();
    group.add(pistons);
    this.mesh(pistonKit, this.hardMat, 'GrapplePistons', pistons);
    this.mesh(hookKit, this.hardMat, 'GrappleHook', hook);
    this.mesh(reelKit, this.hardMat, 'GrappleReel', reel);
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, 0.015, -0.26);
    const eject = new THREE.Object3D();
    eject.position.set(0, 0.015, -0.2);
    group.add(muzzle, eject);
    return { group, muzzle, eject, lens, sight: lens.position.clone(), adsDist: 0.3, slide: pistons, slideTravel: 0.022, hook, reel, index, hasBar: false, shells: false, ejectAt: -1, kickBack: 0.03, kickPitch: 0.06 };
  }

  // =============================================================================================
  // Left arm: five-finger support hand + wrist winch
  // =============================================================================================
  /**
   * Local frame: the held fore-end runs along −Z through the origin (radius ≈ 0.026), the palm is underneath
   * (−Y), fingers wrap up the right side, the thumb lies along the left; the forearm leaves toward the lower left.
   */
  private buildLeftArm(): { drum: THREE.Object3D } {
    const gear = new MeshKit();
    const hard = new MeshKit();
    const drumKit = new MeshKit();
    const leather: PartOpts = { tint: T.LEATHER, zone: 0, tile: 0.06 };
    const rubber: PartOpts = { tint: T.RUBBER, zone: 2, tile: 0.05 };
    const carbon: PartOpts = { tint: T.CARBON, zone: 2, rough: 0.8, metal: 2 };
    const R = 0.026;
    const P = (a: number, z: number, r: number): THREE.Vector3 => {
      const rad = (a * Math.PI) / 180;
      return V(Math.sin(rad) * (R + r), -Math.cos(rad) * (R + r), z);
    };
    // Index (front) → little (rear).
    const fingers: Array<[number, number, number]> = [[-0.031, 0.0102, 152], [-0.01, 0.0105, 156], [0.011, 0.0102, 152], [0.031, 0.0092, 140]];
    const knuckles: THREE.Vector3[] = [];
    for (const [z, r, tipA] of fingers) {
      const j = [P(-35, z, r), P(38, z, r), P(100, z - 0.002, r * 0.94), P(tipA, z - 0.004, r * 0.86)];
      knuckles.push(j[0]);
      gear.add(capsule(j[0], j[1], r), leather);
      gear.add(capsule(j[1], j[2], r * 0.92), leather);
      gear.add(capsule(j[2], j[3], r * 0.84), rubber);
      hard.add(this.knucklePlate(j[0], j[1], V(0, 0, z), r), carbon);
    }
    // Palm under the fore-end and the back of the hand (carbon guard), wrist and thumb.
    const wrist = V(-0.018, -0.07, 0.072);
    const kMid = knuckles[0].clone().lerp(knuckles[3], 0.5);
    const u = wrist.clone().sub(kMid).normalize();
    const vax = knuckles[3].clone().sub(knuckles[0]).normalize();
    const w = V(0, 0, 0).crossVectors(vax, u).normalize();
    if (w.y > 0) {
      w.negate();
      vax.negate();
    }
    const palmLen = kMid.distanceTo(wrist) + 0.01;
    const palm = bevelBox(palmLen, 0.03, 0.086, 0.009);
    palm.applyMatrix4(new THREE.Matrix4().makeBasis(u, w, vax));
    const pc = kMid.clone().lerp(wrist, 0.5).addScaledVector(w, 0.004);
    palm.translate(pc.x, pc.y, pc.z);
    gear.add(palm, leather);
    const guard = bevelBox(palmLen * 0.7, 0.006, 0.062, 0.002);
    guard.applyMatrix4(new THREE.Matrix4().makeBasis(u, w, vax));
    const gc = pc.clone().addScaledVector(w, 0.016);
    guard.translate(gc.x, gc.y, gc.z);
    hard.add(guard, carbon);
    const t0 = V(-0.03, -0.035, 0.03);
    const t1 = V(-0.036, -0.012, 0.0);
    const t2 = V(-0.034, 0.0, -0.026);
    const t3 = V(-0.028, 0.006, -0.046);
    gear.add(capsule(wrist.clone().add(V(-0.01, 0.01, 0)), t0, 0.017), leather);
    gear.add(capsule(t0, t1, 0.0125), leather);
    gear.add(capsule(t1, t2, 0.0115), leather);
    gear.add(capsule(t2, t3, 0.0098), rubber);
    // Forearm (cuff, sleeve, exo-brace) toward the lower left.
    const fDir = V(-0.42, -0.38, 0.82).normalize();
    const f0 = wrist.clone().addScaledVector(fDir, 0.01);
    gear.add(capsule(pc, f0, 0.03), leather);
    gear.add(cylinder(f0, f0.clone().addScaledVector(fDir, 0.07), 0.034, 0.04, 16), { tint: T.NYLON, zone: 1, tile: 0.07 });
    gear.add(cylinder(f0.clone().addScaledVector(fDir, 0.065), f0.clone().addScaledVector(fDir, 0.5), 0.046, 0.056, 18), { tint: T.JACKET, zone: 3, tile: 0.12 });
    this.exoBrace(hard, f0, fDir, 0.044, -1);
    // Magnetic wrist winch on the inner-top of the wrist: frame plates, wound drum (rotating), guide rollers,
    // status ring, pressure gauge; the strand leaves through the front rollers.
    const wc = f0.clone().addScaledVector(fDir, 0.045).add(V(0.035, 0.03, 0));
    const axisD = V(0, 0, 0).crossVectors(fDir, V(0, 1, 0)).normalize();
    const fwdA = fDir.clone().negate();
    const upA = V(0, 0, 0).crossVectors(axisD, fwdA).normalize();
    const frameQ = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(axisD, upA, fDir));
    const frameM = new THREE.Matrix4().compose(wc, frameQ, new THREE.Vector3(1, 1, 1));
    const F = (x: number, y: number, z: number, extra?: THREE.Matrix4): THREE.Matrix4 => {
      const m = frameM.clone().multiply(new THREE.Matrix4().makeTranslation(x, y, z));
      return extra ? m.multiply(extra) : m;
    };
    for (const s of [-1, 1]) hard.add(frontPlate(roundRect(0.07, 0.05, 0.012), 0.005, 0.0015), { tint: T.DARK, zone: 3 }, F(s * 0.024, 0, 0, new THREE.Matrix4().makeRotationY(Math.PI / 2)));
    hard.add(bevelBox(0.05, 0.012, 0.07, 0.003), { tint: T.GUNMETAL, zone: 0 }, F(0, -0.024, 0));
    const ringG = torus(0.021, 0.0024, 6, 28);
    ringG.rotateY(Math.PI / 2);
    hard.add(ringG, { tint: 0x0a0c10, zone: 0, glow: [1.8, 0, 0] }, F(0.027, 0, 0));
    for (const dy of [0.012, -0.004]) {
      const rg = new THREE.CylinderGeometry(0.0055, 0.0055, 0.04, 14);
      rg.rotateZ(Math.PI / 2);
      hard.add(rg, { tint: T.CHROME, zone: 0 }, F(0, dy, -0.036));
    }
    hard.add(cylinder(V(0, 0, 0), V(0, 0.008, 0), 0.0085, 0.0085, 18), { tint: T.GUNMETAL, zone: 0 }, F(0, 0.024, 0.022));
    hard.add(cylinder(V(0, 0.008, 0), V(0, 0.0088, 0), 0.0068, 0.0068, 18), { tint: T.GAUGE, zone: 2, self: 0.55 }, F(0, 0.024, 0.022));
    hard.add(new THREE.BoxGeometry(0.0055, 0.0008, 0.0007), { tint: T.LASER, zone: 0, self: 1.2 }, F(0.002, 0.0335, 0.022));
    // Drum: core + 8 turns of wound wire + flanges (rotates about the winch axis).
    const drumHolder = new THREE.Group();
    drumHolder.position.copy(wc);
    drumHolder.quaternion.copy(frameQ);
    const drum = new THREE.Group();
    drumHolder.add(drum);
    const dcore = new THREE.CylinderGeometry(0.014, 0.014, 0.04, 20);
    dcore.rotateZ(Math.PI / 2);
    drumKit.add(dcore, { tint: T.DARK, zone: 0 });
    const turns: THREE.Vector3[] = [];
    for (let i = 0; i <= 140; i++) {
      const t = i / 140;
      const a = t * Math.PI * 2 * 8;
      turns.push(V(-0.017 + t * 0.034, Math.cos(a) * 0.0158, Math.sin(a) * 0.0158));
    }
    drumKit.add(tube(turns, 0.0015, 280, 4), { tint: T.CHROME, zone: 0, rough: 0.7 });
    for (const s of [-0.02, 0.02]) {
      const fl = new THREE.CylinderGeometry(0.02, 0.02, 0.003, 22);
      fl.rotateZ(Math.PI / 2);
      fl.translate(s, 0, 0);
      drumKit.add(fl, { tint: T.GUNMETAL, zone: 0 });
    }
    this.mesh(gear, this.gearMat, 'LeftHand', this.leftArm);
    this.mesh(hard, this.hardMat, 'LeftArmor', this.leftArm);
    this.leftArm.add(drumHolder);
    this.mesh(drumKit, this.hardMat, 'WinchDrum', drum);
    this.winchExit.position.copy(V(0, 0.004, -0.045).applyMatrix4(frameM));
    this.leftArm.add(this.winchExit);
    return { drum };
  }

  // =============================================================================================
  // Events
  // =============================================================================================
  /** `kickScale` < 1 while zoomed (−10 … −20 % visual recoil). */
  onFire(slot: SlotId, kickScale = 1): void {
    const r = this.rigs[slot];
    this.kickVZ += r.kickBack * 28 * kickScale;
    this.kickVP += r.kickPitch * 28 * kickScale;
    this.triggerT = 0;
    if (slot === 'GRAPPLE') {
      this.clawT = 0;
      return;
    }
    this.flashLife = slot === 'SHOTGUN' ? 0.07 : 0.045;
    this.flashMat.uniforms.uSeed.value = Math.random();
    this.flash.scale.setScalar(slot === 'SHOTGUN' ? 1.6 : slot === 'SMG' ? 0.75 : 1.0);
    this.flash.rotation.z = Math.random() * Math.PI;
    // 6B-1: 60 ms muzzle light — the barrel and the glove fingers flash with the shot.
    this.lightLife = 0.06;
    this.muzzleLight.color.setHex(this.plasma ? 0xdcf2ff : this.energyHex).lerp(_tmpWhite, 0.55);
    this.ejectPending = true;
  }

  // =============================================================================================
  // Per frame
  // =============================================================================================
  update(realDt: number, f: ViewModelFrame): void {
    this.time += realDt;
    for (const id of SLOT_KEYS) this.rigs[id].group.visible = id === f.slot;
    const rig = this.rigs[f.slot];
    if (f.slot !== this.lastSlot) {
      this.lastSlot = f.slot;
      this.ejectPending = false;
    }

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

    // Reload: roll, dip and magazine drop along its own axis.
    let reloadRoll = 0;
    let reloadDip = 0;
    if (f.reloadT >= 0) {
      const t = f.reloadT;
      const env = Math.sin(Math.min(1, t) * Math.PI);
      reloadRoll = env * 0.55;
      reloadDip = env * 0.06;
    }
    if (rig.mag && rig.magRest && rig.magAxis) {
      const t = f.reloadT;
      const drop = t < 0 ? 0 : t < 0.45 ? t / 0.45 : t < 0.55 ? 1 : 1 - (t - 0.55) / 0.45;
      rig.mag.position.copy(rig.magRest).addScaledVector(rig.magAxis, drop * 0.14);
      rig.mag.visible = !(t > 0.42 && t < 0.58);
    }

    // Blowback: the slide / bolt / pistons snap back in 18 ms and return in 62 ms (pistol slide locks open
    // on an empty magazine); the shotgun pump cycles 280 ms after the shot.
    if (rig.slide) {
      const a = f.sinceShot;
      let s = a < 0.018 ? a / 0.018 : a < 0.08 ? 1 - (a - 0.018) / 0.062 : 0;
      if (f.slot === 'PISTOL' && f.ammo <= 0 && f.reloadT < 0) s = 1;
      rig.slide.position.z = s * rig.slideTravel;
    }
    if (rig.pump) {
      const t = f.sinceShot - 0.28;
      const pumpT = t > 0 && t < 0.22 ? Math.sin((t / 0.22) * Math.PI) : 0;
      rig.pump.position.z = -0.24 + pumpT * 0.07;
    }
    // Ejection spark at the port (shotgun: on the pump stroke).
    if (this.ejectPending && rig.ejectAt >= 0 && f.sinceShot >= rig.ejectAt) {
      this.ejectPending = false;
      this.sparkLife = 0.04;
      this.sparkMat.uniforms.uSeed.value = Math.random();
    }

    // Trigger finger: pull 50 ms, release 80 ms.
    this.triggerT += realDt;
    const pull = this.triggerT < 0.05 ? this.triggerT / 0.05 : this.triggerT < 0.13 ? 1 - (this.triggerT - 0.05) / 0.08 : 0;
    rig.index.rotation.x = pull * 0.24;

    // Shader-driven parts: ammo bar length / colour, shells, pistol coil charge, SMG emitter flicker.
    const u = this.hardU;
    const frac = f.magazine > 0 ? clamp(f.ammo / f.magazine, 0, 1) : 1;
    u.uAmmo.value = rig.hasBar ? frac : 1;
    u.uShells.value = rig.shells ? f.ammo : 4;
    const low = f.ammo <= Math.max(1, Math.floor(f.magazine * 0.25));
    if (rig.hasBar && f.magazine > 0 && f.ammo <= 0) u.uBarColor.value.setRGB(0, 0, 0);
    else if (low) u.uBarColor.value.setHex(COLORS.ENEMY_DANGER).multiplyScalar(Math.sin(this.time * 18) > 0 ? 2.6 : 0.9);
    else u.uBarColor.value.setHex(this.plasma ? 0xdcf2ff : this.energyHex).multiplyScalar(2.2);
    const S = MATERIALS.PLAYER_STRAND.emissive;
    u.uCharge.value = f.slot === 'PISTOL' ? (0.35 + 0.65 * clamp(f.sinceShot / 0.3, 0, 1)) * (S / 3) : f.slot === 'SMG' ? (f.sinceShot < 0.1 ? 1.3 : 0.7) : 1;

    // Grapple: claws open on launch (90 ms) before the anchor leaves; drums spin while reeling / paying out.
    this.clawT += realDt;
    u.uClaw.value = this.clawT < 0.09 ? this.clawT / 0.09 : f.hookInFlight ? 1 : Math.max(0, 1 - (this.clawT - 0.09) * 4);
    if (rig.hook) rig.hook.visible = !f.hookInFlight || this.clawT < 0.09;
    if (rig.reel) {
      this.drumAngle += realDt * (f.hookInFlight ? 40 : f.reeling ? -30 : 0);
      rig.reel.rotation.x = this.drumAngle;
    }
    this.winchAngle += realDt * (f.reeling ? -26 : f.hookInFlight ? 30 : 0);
    this.winchDrum.rotation.x = this.winchAngle;

    // Compose the right-hand pivot. Tactical zoom slides the gun so its holo lens sits on the view axis at
    // the gun's eye relief (the collimated reticle then lands exactly on the aim point), calming sway / bob.
    const z = clamp(f.zoom, 0, 1);
    const zr = this.rigs[f.zoomGun] ?? rig;
    const adsX = -zr.sight.x;
    const adsY = -zr.sight.y;
    const adsZ = -zr.adsDist - zr.sight.z;
    const calm = 1 - 0.55 * z;
    const p = this.weaponPivot;
    p.position.set(
      0.21 + (adsX - 0.21) * z + (this.swayX + bobX) * calm,
      -0.2 + (adsY + 0.2) * z + (this.swayY + bobY) * calm - ease * 0.32 - reloadDip - this.lower,
      -0.42 + (adsZ + 0.42) * z + this.kickZ + ease * 0.05,
    );
    p.rotation.set(this.kickP + ease * 0.95 + this.swayY * 2 * calm, this.swayX * 2.5 * calm, (-this.tilt - ease * 0.35 + reloadRoll) * (1 - 0.6 * z), 'XYZ');
    p.updateMatrix();

    // Left arm: supports the SMG / shotgun fore-end, thrusts the winch forward while the strand is out,
    // otherwise rests low-left. Poses blend smoothly (position lerp + quaternion slerp).
    const strandOut = f.ropeAttached || f.hookInFlight;
    if (strandOut) {
      _p.set(-0.2 + this.swayX * 0.7, -0.2 + this.swayY * 0.7 - this.lower, -0.5);
      _q.setFromEuler(_e.set(0.15, 0.12, 0.35 + this.tilt * 0.5));
    } else if (rig.support && hp < 0.5) {
      _v.copy(rig.support);
      if (rig.pump) _v.z = rig.pump.position.z;
      rig.group.updateMatrix();
      _p.copy(_v).applyMatrix4(p.matrix);
      _q.copy(p.quaternion);
    } else {
      _p.set(-0.25 + this.swayX * 0.7 + bobX * 0.6, -0.31 + this.swayY * 0.7 + bobY - this.lower, -0.43);
      _q.setFromEuler(_e.set(0.32, 0.32, 0.35 + this.tilt * 0.5));
    }
    const lk = lerpFactor(rig.support && !strandOut ? 16 : 9, realDt);
    this.leftPos.lerp(_p, lk);
    this.leftQuat.slerp(_q, lk);
    this.leftArm.position.copy(this.leftPos);
    this.leftArm.quaternion.copy(this.leftQuat);

    // Muzzle flash, ejection spark, muzzle light.
    rig.group.updateMatrix();
    if (this.flashLife > 0) {
      this.flashLife -= realDt;
      this.flash.visible = true;
      this.flashMat.uniforms.uAlpha.value = clamp(this.flashLife / 0.05, 0, 1);
      this.flash.position.copy(rig.muzzle.position).applyMatrix4(rig.group.matrix);
    } else {
      this.flash.visible = false;
    }
    if (this.sparkLife > 0) {
      this.sparkLife -= realDt;
      this.spark.visible = true;
      this.sparkMat.uniforms.uAlpha.value = clamp(this.sparkLife / 0.04, 0, 1);
      this.spark.position.copy(rig.eject.position).applyMatrix4(rig.group.matrix);
      this.spark.position.x += (0.04 - this.sparkLife) * 0.6;
      this.spark.position.y += (0.04 - this.sparkLife) * 0.4;
    } else {
      this.spark.visible = false;
    }
    if (this.lightLife > 0) {
      this.lightLife -= realDt;
      this.muzzleLight.intensity = 5.5 * clamp(this.lightLife / 0.06, 0, 1);
      this.root.updateMatrixWorld(true);
      rig.muzzle.getWorldPosition(this.muzzleLight.position);
      this.muzzleLight.position.z += 0.05;
    } else {
      this.muzzleLight.intensity = 0;
    }

    // Holo reticle: project a point 50 m down the sight axis (collimated at infinity) to the lens shader.
    this.root.updateMatrixWorld(true);
    rig.lens.getWorldPosition(_v);
    rig.group.getWorldQuaternion(_q2);
    _v2.set(0, 0, -50).applyQuaternion(_q2).add(_v);
    _ndc.copy(_v2).applyMatrix4(this.vmCamera.projectionMatrix);
    (this.lensMat.uniforms.uReticle.value as THREE.Vector2).set(_ndc.x, _ndc.y);
    this.lensMat.uniforms.uAspect.value = this.vmCamera.aspect;
  }

  /** Keeps the view-model's PMREM reflections consistent with the main view orientation. */
  syncEnvironment(cameraEuler: THREE.Euler): void {
    this.scene.environmentRotation.set(-cameraEuler.x, -cameraEuler.y, 0, 'YXZ');
  }

  /** Reticle position (NDC) of the active holo sight — verification / HUD. */
  get holoReticleNdc(): THREE.Vector2 {
    return this.lensMat.uniforms.uReticle.value as THREE.Vector2;
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

const _tmpWhite = new THREE.Color(0xfff4e6);
