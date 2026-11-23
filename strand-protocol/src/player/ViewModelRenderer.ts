/**
 * STRAND // PROTOCOL — First-person view-model (§2.3, §3.2, §6.2 Pass 2; Phase 6B-1 AAA remodel).
 *
 * Drawn in the dedicated view-model scene (cleared depth, FOV 68°), so weapons and hands never clip into
 * walls. Everything is procedural hard-surface geometry (ViewModelKit): bevelled extrusions (2–4 mm, two
 * segments), lathes and tubes, baked into one geometry per material and per moving part:
 *  - two tactical-glove hands with five jointed fingers (thumb 2 + fingers 3 phalanges), four independent
 *    carbon knuckle plates, wrist cuffs, jacket sleeves and a cyber exo-brace (frame, light fibres, cables);
 *    the right index finger pulls the trigger on every shot; the left hand supports the sniper fore-end and
 *    thrusts the wrist winch (frame, wound drum, guide rollers, status ring, pressure gauge) forward while the
 *    strand is out
 *  - 8A-3 MK-IV suppressed rail pistol (angled slide, glowing coil slits, vented integral suppressor, holo sight
 *    on a non-reciprocating frame bridge), K-90 single-shot rail sniper (faceted receiver with bevelled side
 *    armour, cheek-rest stock, fluted barrel with twin rail-coil channels, baffled muzzle brake, folded bipod,
 *    bolt / breech lever, two-hand breech reload), S-00 grapple launcher (twin hydraulics, pressure canister,
 *    wound reel + pulleys, three-claw anchor that opens on launch)
 *  - both guns share the old SMG holo hood (0.046 × 0.037 × 0.042): clear lens with a collimated dot (pistol)
 *    or an ultra-fine crosshair with mil ticks (sniper) that sits exactly on the aim point in ADS; blowback,
 *    ejection sparks, diegetic ammo bar recessed in a bevelled housing
 *  - lighting: tuned environment reflections + a 60 ms muzzle point light on every shot
 * Draw calls: ≤ 11 per frame for the whole view-model (one material per static body, one per moving part).
 */
import * as THREE from 'three';
import { CAMERA, COLORS, MATERIALS, clamp, lerpFactor } from '../config/constants';
import type { ProceduralTextureLibrary } from '../engine/ProceduralTextures';
import { RELOAD_BEATS, SLOT_ORDER, type GunId, type ReloadCue, type SlotId } from '../config/weapons';
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
  /** 7A-5: rounds loaded when the reload started (pistol slide lock). */
  reloadFrom: number;
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

/** 7A-5 / 7A-6 view-model helpers. */
interface ReloadPose {
  roll: number;
  pitch: number;
  lift: number;
  shift: number;
  /** Slide / bolt travel (× slideTravel) and pump stroke (0..1) driven by the hand. */
  slide: number;
  pump: number;
  /** Ammo-bar override (0 mag out, 1 fresh mag, −1 none) and visible side-saddle shells. */
  bar: number;
  shells: number;
  /** Rail cartridge in the left glove (sniper breech load). */
  handShell: number;
  /** The left hand follows `reloadHand` / `reloadQuat`. */
  hand: boolean;
}
const sstep = (a: number, b: number, x: number): number => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const _X = new THREE.Vector3(1, 0, 0);
const _ra = new THREE.Vector3();
const _rb = new THREE.Vector3();
const _qa = new THREE.Quaternion();
/** Left glove wrapped around a vertical magazine (grip axis down the mag, forearm down-left-back). */
const _qMagGrip = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, Math.PI / 2, 0, 'YXZ'));
/** Slingshot rack: palm on the left flank of the slide / receiver, fingers round the back, forearm down-left. */
const _qRack = new THREE.Quaternion().setFromEuler(new THREE.Euler(1.963, 1.963, 0.262, 'YXZ'));
/** Mantle: palm slapped down on the ledge, forearm back-left. */
const _qMantle = new THREE.Quaternion().setFromEuler(new THREE.Euler(2.487, 1.963, -0.131, 'YXZ'));
const MANTLE_HAND_S = 0.3;
const VM_RIM_INTENSITY = 1.5;

/** 7A-1: holo dot colour gain — every channel stays ≤ 0.82, under the 0.92 bloom threshold. */
const HOLO_DOT_GAIN = 0.82;

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
  /** Ejection spark delay after the shot (s); −1 = no spark on the shot (bolt action ejects on reload). */
  readonly ejectAt: number;
  /** 8A-3 bolt action: the bolt only moves by hand (reload), never as blowback. */
  readonly boltAction?: boolean;
  /** 8A-3 spent rail casing flung out of the breech on BOLT_OPEN. */
  readonly casing?: THREE.Object3D;
  readonly kickBack: number;
  readonly kickPitch: number;
}

/**
 * 7A-1 holo lens: practically clear glass (alpha 0.02 in the window, ≤ 0.12 only at the very rim) and a single
 * pin-point collimated dot (radius 0.0022 → 0.0038 NDC·aspect) drawn where the sight axis meets infinity. The dot
 * colour stays below the bloom threshold (≤ 0.82) so it never blooms over a target's head; no ring, no glint.
 */
function createLensMaterial(color: THREE.Color): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uColor: { value: color },
      uReticle: { value: new THREE.Vector2() },
      uAspect: { value: 1 },
      // 8A-3: 0 = pin-point dot (pistol), 1 = ultra-fine crosshair + open centre dot + mil ticks (sniper).
      uMode: { value: 0 },
      // NDC units per screen pixel (2 / viewport height).
      uPx: { value: 0.002 },
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
      uniform float uMode;
      uniform float uPx;
      varying vec2 vUv;
      varying vec2 vNdc;
      float hair(float x, float w) { return 1.0 - smoothstep(w, w + 0.9, abs(x)); }
      void main() {
        vec2 d = (vNdc - uReticle) * vec2(uAspect, 1.0);
        vec2 e = abs(vUv - 0.5) * 2.0;
        float edge = smoothstep(0.85, 1.0, max(e.x, e.y));
        vec3 glass = vec3(0.03, 0.06, 0.065);
        float base = 0.02 + 0.10 * edge;
        if (uMode < 0.5) {
          float dotR = 1.0 - smoothstep(0.0022, 0.0038, length(d));
          gl_FragColor = vec4(mix(glass, uColor, dotR), mix(base, 0.92, dotR));
          return;
        }
        // 8A-3 sniper: 0.7 px hairlines with an open centre (7 px gap), a 1 px centre dot and three tiny
        // perpendicular mil ticks every 18 px along each arm — 0.65 opacity, targets stay unobstructed.
        vec2 q = d / uPx;
        float lw = 0.35;
        float lines = max(hair(q.y, lw) * step(7.0, abs(q.x)), hair(q.x, lw) * step(7.0, abs(q.y)));
        float ticks = 0.0;
        for (int i = 1; i <= 3; i++) {
          float o = 18.0 * float(i);
          ticks = max(ticks, hair(abs(q.x) - o, lw) * step(abs(q.y), 3.0));
          ticks = max(ticks, hair(abs(q.y) - o, lw) * step(abs(q.x), 3.0));
        }
        float dotC = 1.0 - smoothstep(0.6, 1.4, length(q));
        float cross = max(max(lines, ticks), dotC);
        gl_FragColor = vec4(mix(glass, uColor, cross), mix(base, 0.65, cross));
      }
    `,
  });
}

/**
 * 10A-3.1: 3D first-person gunshot muzzle flash shader — crossed 3-plane additive star burst + tapered forward
 * plasma cone + lateral muzzle-brake side vents (aKind 0 = transverse star disc, 1 = forward plasma cone/blades,
 * 2 = lateral brake vents counter-rotated by -uRoll so they stay horizontal while the axial star rolls 0..2π).
 */
function createFlashMaterial(color: THREE.Color): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: { uColor: { value: color }, uSeed: { value: 0 }, uAlpha: { value: 0 }, uRoll: { value: 0 } },
    vertexShader: /* glsl */ `
      attribute float aKind;
      uniform float uRoll;
      varying vec2 vUv;
      varying float vKind;
      void main() {
        vUv = uv;
        vKind = aKind;
        vec3 p = position;
        if (aKind > 1.5) {
          float c = cos(-uRoll);
          float s = sin(-uRoll);
          p.xy = vec2(p.x * c - p.y * s, p.x * s + p.y * c);
        }
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uSeed; uniform float uAlpha;
      varying vec2 vUv; varying float vKind;
      void main() {
        float a = 0.0;
        float core = 0.0;
        if (vKind < 0.5) {
          vec2 p = vUv - 0.5;
          float r = length(p) * 2.0;
          float ang = atan(p.y, p.x);
          float spikes = pow(abs(sin(ang * 3.0 + uSeed * 6.28318)), 5.0);
          core = exp(-r * 5.2);
          a = (core * 2.5 + spikes * max(0.0, 1.0 - r) * 1.35) * step(r, 1.0);
        } else {
          // Axial forward plasma cone/blades (aKind 1) or lateral muzzle-brake vents (aKind 2):
          // vUv.x runs 0 (base at muzzle/port) -> 1 (tip); vUv.y runs 0..1 across width.
          float along = clamp(vUv.x, 0.0, 1.0);
          float across = abs(vUv.y - 0.5) * 2.0;
          float taper = 1.0 - along * 0.72;
          float radial = max(0.0, 1.0 - across / max(0.15, taper));
          core = exp(-along * 3.2) * pow(radial, 1.5);
          float jet = pow(radial, 2.0) * smoothstep(0.0, 0.08, along) * pow(1.0 - along, 1.25);
          a = (core * 2.2 + jet * 1.8) * (vKind > 1.5 ? 1.15 : 1.0);
        }
        a *= uAlpha;
        if (a < 0.004) discard;
        vec3 hot = mix(uColor, vec3(1.0, 0.98, 0.95), clamp(core * 1.15, 0.0, 1.0));
        gl_FragColor = vec4(hot * a * 3.1, 1.0);
      }
    `,
  });
}

/**
 * 10A-3.1: Builds a merged 1-draw muzzle flash geometry in local muzzle space (-Z forward):
 *  - Crossed 3-plane additive star burst (XY star disc + crossed XZ & YZ longitudinal plasma blades)
 *  - Tapered forward plasma cone (length, radius)
 *  - Optional blazing lateral muzzle-brake side vents extending ±lateralBrakeSpan along ±X (K-90 Rail Sniper).
 */
export function buildMuzzleFlashGeometry(length: number, radius: number, lateralBrakeSpan = 0): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const kind: number[] = [];
  const pushGeo = (g: THREE.BufferGeometry, k: number, flipUvX = false): void => {
    const ng = g.index ? g.toNonIndexed() : g;
    const pa = ng.getAttribute('position') as THREE.BufferAttribute;
    const ua = ng.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < pa.count; i++) {
      pos.push(pa.getX(i), pa.getY(i), pa.getZ(i));
      const ux = flipUvX ? 1 - ua.getX(i) : ua.getX(i);
      uv.push(ux, ua.getY(i));
      kind.push(k);
    }
    if (ng !== g) ng.dispose();
    g.dispose();
  };
  // 1. Transverse XY star burst disc at muzzle exit.
  const disc = new THREE.PlaneGeometry(radius * 2, radius * 2);
  disc.translate(0, 0, -0.004);
  pushGeo(disc, 0);

  // 2. Crossed longitudinal plasma blades (YZ and XZ planes) spanning z = 0 .. -length.
  for (const rotZ of [0, Math.PI / 2, Math.PI / 4, -Math.PI / 4]) {
    const blade = new THREE.PlaneGeometry(length, radius * 2);
    // PlaneGeometry +X -> -Z (after rotateY(-PI/2), +X maps to +Z, so rotateY(+PI/2) maps +X to -Z -> uv.x = 1 at z = -length).
    blade.rotateY(Math.PI / 2);
    blade.rotateZ(rotZ);
    blade.translate(0, 0, -length * 0.5);
    pushGeo(blade, 1);
  }

  // 3. Tapered forward plasma cone along -Z (z = 0 -> -length).
  const cone = new THREE.CylinderGeometry(radius * 0.14, radius * 0.68, length, 8, 1, true);
  // Cylinder +Y -> -Z via rotateX(-PI/2); swap UV so vUv.x = along (0 at base, 1 at tip) and vUv.y = 0.5 (center).
  cone.rotateX(-Math.PI / 2);
  cone.translate(0, 0, -length * 0.5);
  {
    const ng = cone.toNonIndexed();
    const pa = ng.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pa.count; i++) {
      const z = pa.getZ(i);
      const along = clamp(-z / Math.max(length, 1e-4), 0, 1);
      pos.push(pa.getX(i), pa.getY(i), z);
      uv.push(along, 0.5);
      kind.push(1);
    }
    ng.dispose();
    cone.dispose();
  }

  // 4. Blazing lateral muzzle-brake side vents (±lateralBrakeSpan along ±X at the brake ports z = +0.024).
  if (lateralBrakeSpan > 0) {
    const portZ = 0.024;
    const ventH = radius * 0.78;
    for (const sx of [-1, 1] as const) {
      for (const rx of [0, Math.PI / 2]) {
        const vPlane = new THREE.PlaneGeometry(lateralBrakeSpan, ventH);
        vPlane.rotateX(rx);
        // Slightly angled rearward/outward from the baffled muzzle brake vents.
        vPlane.rotateY(-sx * 0.16);
        vPlane.translate(sx * (0.012 + lateralBrakeSpan * 0.5), 0, portZ);
        pushGeo(vPlane, 2, sx < 0);
      }
      const vCone = new THREE.CylinderGeometry(ventH * 0.1, ventH * 0.36, lateralBrakeSpan, 6, 1, true);
      vCone.rotateZ(-sx * (Math.PI / 2));
      vCone.rotateY(-sx * 0.16);
      vCone.translate(sx * (0.012 + lateralBrakeSpan * 0.5), 0, portZ);
      const ng = vCone.toNonIndexed();
      const pa = ng.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < pa.count; i++) {
        const x = pa.getX(i);
        const along = clamp((Math.abs(x) - 0.012) / Math.max(lateralBrakeSpan, 1e-4), 0, 1);
        pos.push(x, pa.getY(i), pa.getZ(i));
        uv.push(along, 0.5);
        kind.push(2);
      }
      ng.dispose();
      vCone.dispose();
    }
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  out.setAttribute('aKind', new THREE.Float32BufferAttribute(kind, 1));
  out.computeBoundingSphere();
  return out;
}

export class ViewModelRenderer {
  readonly root = new THREE.Group();
  private readonly weaponPivot = new THREE.Group();
  private readonly leftArm = new THREE.Group();
  private readonly winchDrum: THREE.Object3D;
  private readonly winchExit = new THREE.Object3D();
  private readonly rigs: Record<SlotId, WeaponRig>;
  private readonly pistolFlashGeo = buildMuzzleFlashGeometry(0.09, 0.045, 0);
  private readonly sniperFlashGeo = buildMuzzleFlashGeometry(0.24, 0.11, 0.10);
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
  private flashMaxLife = 0.045;
  private sparkLife = 0;
  private lightLife = 0;
  private lightMaxLife = 0.06;
  private lightPeak = 5.5;
  /** 10A-3.2: K-90 post-shot barrel coil heat (1 -> 0 over 1.5 s). */
  private sniperHeat = 0;
  /** 10A-3.2: Pistol 3D spent brass/rail cartridge flight progress (0..1, -1 inactive). */
  private pistolCasingT = -1;
  private triggerT = 1;
  private clawT = 1;
  private drumAngle = 0;
  private winchAngle = 0;
  private time = 0;
  private lastSlot: SlotId = 'PISTOL';
  private ejectPending = false;
  // 7A-5 reload / 7A-6 mantle state
  private reloadPrevT = -1;
  private jolt = 0;
  private joltV = 0;
  private mantleT = 10;
  private mantleDip = 0;
  private readonly reloadHand = new THREE.Vector3();
  private readonly reloadQuat = new THREE.Quaternion();
  private readonly pose: ReloadPose = { roll: 0, pitch: 0, lift: 0, shift: 0, slide: 0, pump: 0, bar: -1, shells: 4, handShell: 0, hand: false };
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
    this.lensMat = createLensMaterial(new THREE.Color(COLORS.PLAYER_STRAND).multiplyScalar(HOLO_DOT_GAIN));
    this.applyEnergyUniforms();

    // Dedicated view-model lighting: cool key from the upper left, strand-cyan rim from behind-right, warm
    // low fill (street lamps) — plus the dynamic muzzle light (always present, so programs never recompile).
    const key = new THREE.DirectionalLight(0xdfe9ff, 2.1);
    key.position.set(-0.6, 1.0, 0.8);
    const rim = new THREE.DirectionalLight(COLORS.PLAYER_STRAND, VM_RIM_INTENSITY);
    rim.position.set(0.9, 0.3, -1.0);
    this.rimLight = rim;
    const fill = new THREE.PointLight(0xffb070, 0.6, 2.5, 2);
    fill.position.set(0.1, -0.6, -0.2);
    this.muzzleLight = new THREE.PointLight(0xffffff, 0, 2.2, 2);
    scene.add(key, rim, fill, this.muzzleLight);

    // ---------------- Weapons (each with its own posed right hand) ----------------
    this.rigs = {
      PISTOL: this.buildPistol(),
      SNIPER: this.buildSniper(),
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
    this.flash = new THREE.Mesh(this.pistolFlashGeo, this.flashMat);
    this.flash.name = 'MuzzleFlash';
    this.flash.visible = false;
    this.flash.renderOrder = 10;
    this.sparkMat = createFlashMaterial(new THREE.Color(0xffd9a0));
    this.spark = new THREE.Mesh(buildMuzzleFlashGeometry(0.03, 0.022, 0), this.sparkMat);
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
    (this.lensMat.uniforms.uColor.value as THREE.Color).copy(c).multiplyScalar(HOLO_DOT_GAIN);
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
    // 8A-3 non-reciprocating bridge mount: two side uprights clamp the frame outside the slide's path and carry a
    // short rail 6 mm above the slide — the SMG-size holo hood stays rock-steady while the slide cycles beneath.
    for (const sx of [-1, 1]) {
      for (const bz of [-0.028, 0.03]) {
        hard.add(bevelBox(0.0036, 0.068, 0.012, 0.0011), { tint: T.DARK, zone: 0 }, at(sx * 0.0207, 0.018, bz));
        hard.add(bevelBox(0.006, 0.01, 0.016, 0.0015), { tint: T.GUNMETAL, zone: 0 }, at(sx * 0.0204, -0.011, bz));
      }
      hard.add(bevelBox(0.003, 0.006, 0.07, 0.001), { tint: T.GUNMETAL, zone: 0 }, at(sx * 0.0207, 0.049, 0.001));
    }
    hard.add(bevelBox(0.045, 0.004, 0.072, 0.0012), { tint: T.DARK, zone: 0 }, at(0, 0.051, 0.001));
    addRail(hard, -0.032, 0.034, 0.057, 0, T.DARK);
    const lens = this.holoSight(hard, group, 0, 0.06, 0.0, 0.046, 0.037, 0.042);
    // 8A-3 integral suppressor: vented can ahead of the muzzle with a stepped front cap.
    hard.add(lathe([[0.0, 0.199], [0.0098, 0.199], [0.0142, 0.205], [0.0145, 0.212], [0.0145, 0.3], [0.0136, 0.312], [0.0, 0.312]], 22), { tint: T.DARK, zone: 3, rough: 1.1 }, at(0, 0.021, 0));
    hard.add(lathe([[0.0138, 0.3], [0.0148, 0.302], [0.0148, 0.309], [0.0138, 0.311]], 22), { tint: T.GUNMETAL, zone: 0 }, at(0, 0.021, 0));
    for (let i = 0; i < 5; i++) {
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2 + (i % 2) * 0.52;
        const f = 0.226 + i * 0.015;
        hard.add(new THREE.BoxGeometry(0.0046, 0.0024, 0.0072), { tint: 0x050607, zone: 3, rough: 2 }, at(Math.cos(a) * 0.0146, 0.021 + Math.sin(a) * 0.0146, -f, 0, 0, a + Math.PI / 2));
      }
    }
    const tr = torus(0.0147, 0.0011, 6, 24);
    tr.translate(0, 0.021, -0.292);
    hard.add(tr, { tint: 0x0a0c10, zone: 0, glow: [0.25, 0.7, 0] });
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
    // 10A-3.2: spent brass/rail cartridge ejected from port on every pistol shot.
    const casingKit = new MeshKit();
    casingKit.add(lathe([[0.0, 0.0], [0.0046, 0.0], [0.0046, 0.024], [0.0036, 0.028], [0.0, 0.028]], 10), { tint: T.BRASS, zone: 0 }, at(0, 0, 0, -Math.PI / 2));
    casingKit.add(lathe([[0.0, 0.024], [0.0037, 0.024], [0.0037, 0.029], [0.0, 0.03]], 10), { tint: 0x101214, zone: 0, glow: [0.22, 0, 0] }, at(0, 0, 0, -Math.PI / 2));
    const casing = this.mesh(casingKit, this.hardMat, 'PistolCasing', group);
    casing.visible = false;
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, 0.021, -0.316);
    const eject = new THREE.Object3D();
    eject.position.set(0.02, 0.032, -0.04);
    group.add(muzzle, eject);
    return { group, muzzle, eject, lens, sight: lens.position.clone(), adsDist: 0.27, slide, slideTravel: 0.028, mag, magRest, magAxis, index, hasBar: true, shells: false, ejectAt: 0, casing, kickBack: 0.045, kickPitch: 0.12 };
  }

  /**
   * 8A-3 K-90 rail sniper: faceted upper / lower receiver with bevelled side armour plates, cheek-rest stock,
   * long fluted barrel with two glowing rail-coil channels, baffled rectangular muzzle brake, folded bipod rails,
   * right-side bolt / breech lever (moving part) and the shared SMG-size holo hood with the fine crosshair.
   */
  private buildSniper(): WeaponRig {
    const group = new THREE.Group();
    const hard = new MeshKit();
    const gear = new MeshKit();
    const boltKit = new MeshKit();
    const casingKit = new MeshKit();
    // Receiver: faceted upper, polymer lower, bevelled side armour plates with recessed energy seams.
    hard.add(profile([[-0.12, 0.008], [-0.12, 0.038], [-0.095, 0.054], [0.15, 0.054], [0.172, 0.04], [0.172, 0.008]], 0.05, 0.0035), { tint: T.GUNMETAL, zone: 0 });
    hard.add(profile([[-0.12, -0.032], [-0.12, 0.008], [0.172, 0.008], [0.172, -0.014], [0.14, -0.034], [-0.08, -0.034]], 0.046, 0.0035), { tint: T.POLYMER, zone: 2 });
    for (const sx of [-1, 1]) {
      hard.add(profile([[-0.06, 0.012], [0.11, 0.012], [0.13, 0.03], [0.11, 0.046], [-0.04, 0.046], [-0.07, 0.03]], 0.004, 0.0015), { tint: T.DARK, zone: 3 }, at(sx * 0.0262, 0, 0));
      hard.add(new THREE.BoxGeometry(0.0012, 0.0016, 0.15), { tint: 0x0a0c10, zone: 0, glow: [0.35, 1.0, 0] }, at(sx * 0.0286, 0.029, -0.035));
    }
    addRail(hard, -0.1, 0.14, 0.058, 0, T.DARK);
    const lens = this.holoSight(hard, group, 0, 0.061, 0.0, 0.046, 0.037, 0.042);
    // Octagonal handguard around the barrel root, folded bipod rails beneath it.
    hard.add(bevelBox(0.046, 0.044, 0.2, 0.008), { tint: T.CARBON, zone: 2, tile: 0.08 }, at(0, 0.014, -0.27));
    for (let k = 0; k < 5; k++) hard.add(bevelBox(0.048, 0.006, 0.012, 0.0015), { tint: T.BLACK, zone: 3 }, at(0, 0.03, -0.2 - k * 0.032));
    for (const sx of [-1, 1]) {
      hard.add(bevelBox(0.006, 0.006, 0.17, 0.0015), { tint: T.DARK, zone: 0 }, at(sx * 0.012, -0.016, -0.27));
      hard.add(bevelBox(0.009, 0.01, 0.014, 0.002), { tint: T.RUBBER, zone: 2 }, at(sx * 0.012, -0.016, -0.355));
    }
    hard.add(bevelBox(0.03, 0.012, 0.02, 0.003), { tint: T.GUNMETAL, zone: 0 }, at(0, -0.01, -0.185));
    // Long fluted barrel with twin rail-coil channels (energy, pulse with the charge uniform).
    hard.add(lathe([[0.0, 0.37], [0.0135, 0.37], [0.0135, 0.585], [0.0, 0.585]], 22), { tint: T.DARK, zone: 0 }, at(0, 0.016, 0));
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      hard.add(new THREE.BoxGeometry(0.0034, 0.0026, 0.19), { tint: 0x050607, zone: 3, rough: 1.8 }, at(Math.cos(a) * 0.0134, 0.016 + Math.sin(a) * 0.0134, -0.475, 0, 0, a + Math.PI / 2));
    }
    for (const sx of [-1, 1]) {
      hard.add(bevelBox(0.005, 0.009, 0.2, 0.0012), { tint: T.GUNMETAL, zone: 0 }, at(sx * 0.0158, 0.016, -0.47));
      hard.add(new THREE.BoxGeometry(0.0016, 0.0042, 0.19), { tint: 0x0a0c10, zone: 0, glow: [0.5, 1.6, 0] }, at(sx * 0.0186, 0.016, -0.47));
    }
    for (const f of [0.39, 0.45, 0.51, 0.57]) {
      const t = torus(0.0145, 0.0014, 6, 24);
      t.translate(0, 0.016, -f);
      hard.add(t, { tint: 0x0a0c10, zone: 0, glow: [0.3, 1.2, 0] });
    }
    // Heavy baffled rectangular muzzle brake.
    hard.add(bevelBox(0.036, 0.03, 0.062, 0.005), { tint: T.GUNMETAL, zone: 0 }, at(0, 0.016, -0.616));
    for (const sx of [-1, 1]) {
      for (let k = 0; k < 3; k++) hard.add(new THREE.BoxGeometry(0.003, 0.018, 0.009), { tint: 0x050607, zone: 3, rough: 2 }, at(sx * 0.0178, 0.016, -0.598 - k * 0.016));
    }
    hard.add(new THREE.BoxGeometry(0.014, 0.012, 0.004), { tint: 0x050607, zone: 3 }, at(0, 0.016, -0.6475));
    // Grip, trigger guard, cheek-rest stock with riser and butt pad.
    const grip: GripDef = { top: V(0, -0.032, 0.03), tilt: -0.22, rx: 0.015, rz: 0.022, trigger: V(0, -0.046, -0.014) };
    hard.add(bevelBox(0.03, 0.1, 0.044, 0.006), { tint: T.GRIP, zone: 1, tile: 0.05 }, gripMatrix(grip, 0, -0.05, 0));
    hard.add(profile([[0.0, -0.034], [0.052, -0.034], [0.05, -0.042], [0.038, -0.058], [0.0, -0.058], [-0.006, -0.049]], 0.012, 0.0022, [[[0.007, -0.038], [0.044, -0.038], [0.036, -0.052], [0.007, -0.052]]]), { tint: T.POLYMER, zone: 2 });
    hard.add(profile([[0.004, -0.034], [0.009, -0.034], [0.007, -0.044], [0.001, -0.052], [-0.002, -0.05], [0.002, -0.042]], 0.006, 0.0012), { tint: T.DARK, zone: 0 });
    hard.add(profile([[-0.12, -0.03], [-0.12, 0.034], [-0.17, 0.03], [-0.31, 0.024], [-0.315, -0.046], [-0.29, -0.06], [-0.2, -0.04], [-0.14, -0.034]], 0.036, 0.005), { tint: T.POLYMER, zone: 2 });
    hard.add(bevelBox(0.03, 0.016, 0.12, 0.004), { tint: T.RUBBER, zone: 2 }, at(0, 0.04, 0.215));
    hard.add(bevelBox(0.04, 0.09, 0.016, 0.004), { tint: T.RUBBER, zone: 2 }, at(0, -0.012, 0.318));
    for (const sx of [-1, 1]) hard.add(bevelBox(0.003, 0.03, 0.09, 0.001), { tint: T.DARK, zone: 3 }, at(sx * 0.019, -0.005, 0.23));
    // Ejection port (right) — the bolt / breech lever is the moving part, opened only by hand.
    hard.add(new THREE.BoxGeometry(0.0016, 0.018, 0.06), { tint: 0x08090b, zone: 3 }, at(0.0252, 0.03, -0.02));
    this.ammoHousing(hard, -0.0262, -0.014, 0.06, 0.05);
    const bolt = new THREE.Group();
    group.add(bolt);
    boltKit.add(cylinder(V(0.012, 0.03, 0.04), V(0.012, 0.03, -0.045), 0.0085, 0.0085, 16), { tint: T.CHROME, zone: 0 });
    boltKit.add(cylinder(V(0.016, 0.03, 0.03), V(0.046, 0.026, 0.034), 0.0032, 0.0032, 10), { tint: T.DARK, zone: 0 });
    boltKit.add(lathe([[0.0, -0.007], [0.0075, -0.005], [0.0085, 0.0], [0.0075, 0.005], [0.0, 0.007]], 14), { tint: T.GUNMETAL, zone: 0 }, at(0.049, 0.026, 0.034, 0, 0, Math.PI / 2));
    // Spent rail casing (hidden until BOLT_OPEN throws it out to the right).
    casingKit.add(lathe([[0.0, 0.0], [0.0062, 0.0], [0.0062, 0.05], [0.0045, 0.056], [0.0, 0.056]], 12), { tint: T.BRASS, zone: 0 }, at(0, 0, 0, -Math.PI / 2));
    casingKit.add(lathe([[0.0, 0.05], [0.0046, 0.05], [0.0046, 0.056], [0.0, 0.058]], 10), { tint: 0x101214, zone: 0, glow: [0.12, 0, 0] }, at(0, 0, 0, -Math.PI / 2));
    const index = this.rightHand(gear, hard, group, grip);
    this.mesh(hard, this.hardMat, 'SniperBody', group);
    this.mesh(gear, this.gearMat, 'SniperHand', group);
    this.mesh(boltKit, this.hardMat, 'SniperBolt', bolt);
    const casing = this.mesh(casingKit, this.hardMat, 'SniperCasing', group);
    casing.visible = false;
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, 0.016, -0.652);
    const eject = new THREE.Object3D();
    eject.position.set(0.032, 0.03, -0.02);
    group.add(muzzle, eject);
    return {
      group, muzzle, eject, lens, sight: lens.position.clone(), adsDist: 0.27, slide: bolt, slideTravel: 0.075,
      index, support: V(0, -0.012, -0.27), hasBar: true, shells: false, ejectAt: -1, boltAction: true, casing, kickBack: 0.075, kickPitch: 0.17,
    };
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
    // 8A-3: fresh long cyan-tipped rail cartridge held in the fingers during the sniper breech load (shown only
    // through uHand — no extra draw call).
    hard.add(lathe([[0.0, 0.0], [0.0064, 0.0], [0.0064, 0.052], [0.0047, 0.058], [0.0047, 0.064], [0.0, 0.064]], 14), { tint: T.BRASS, zone: 0, anim: [0, 0, 0, 2] }, at(-0.008, 0.014, 0.03, -Math.PI / 2));
    hard.add(lathe([[0.0, 0.064], [0.0047, 0.064], [0.0035, 0.074], [0.0, 0.079]], 14), { tint: 0x0a0c10, zone: 0, glow: [1.1, 0, 0], anim: [0, 0, 0, 2] }, at(-0.008, 0.014, 0.03, -Math.PI / 2));
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
    this.lastSlot = slot;
    this.kickVZ += r.kickBack * 28 * kickScale;
    this.kickVP += r.kickPitch * 28 * kickScale;
    this.triggerT = 0;
    if (slot === 'GRAPPLE') {
      this.clawT = 0;
      return;
    }
    const isSniper = slot === 'SNIPER';
    // 10A-3.1: MK-IV Pistol = 45 ms compact burst (0.09 m × 0.045 m); K-90 Sniper = 75 ms plasma flash (0.24 m × 0.11 m + ±0.10 m lateral brake vents).
    this.flash.geometry = isSniper ? this.sniperFlashGeo : this.pistolFlashGeo;
    this.flashMaxLife = isSniper ? 0.075 : 0.045;
    this.flashLife = this.flashMaxLife;
    const roll = Math.random() * Math.PI * 2;
    this.flash.rotation.z = roll;
    this.flashMat.uniforms.uRoll.value = roll;
    this.flashMat.uniforms.uSeed.value = Math.random();
    this.flash.scale.setScalar(0.85 + Math.random() * 0.33);
    // 10A-3.1: 70 ms dynamic muzzle PointLight on Sniper (45 ms on Pistol) lighting the receiver.
    this.lightMaxLife = isSniper ? 0.07 : 0.045;
    this.lightLife = this.lightMaxLife;
    this.lightPeak = isSniper ? 8.5 : 4.5;
    this.muzzleLight.color.setHex(this.plasma ? 0xdcf2ff : this.energyHex).lerp(_tmpWhite, 0.55);
    // 10A-3.2: K-90 heats its rail-coil slits white-cyan and cools smoothly back to deep cyan over 1.5 s.
    if (isSniper) this.sniperHeat = 1.0;
    else this.pistolCasingT = 0;
    this.ejectPending = true;
  }

  /** 8A-3 breech beats: the round seats with an upward settle jolt, the bolt slams home with a forward kick. */
  onReloadCue(_gun: GunId, cue: ReloadCue): void {
    if (cue === 'LOAD_ROUND') {
      this.joltV += 0.5;
      this.kickVP += 0.8;
    } else if (cue === 'BOLT_CLOSE') {
      this.kickVZ += 0.7;
      this.boltPulse = 0.35;
    } else if (cue === 'BOLT_OPEN') {
      this.sparkLife = 0.04;
      this.sparkMat.uniforms.uSeed.value = Math.random();
    }
  }

  /** 8A-3: rail coils pulse bright along the barrel after the bolt locks (s). */
  private boltPulse = 0;

  /** 7A-6: auto-mantle started — left-hand push on the ledge, weapon dips. */
  onMantle(): void {
    this.mantleT = 0;
  }

  /**
   * 7A-5 reload timeline at progress t (−1 = not reloading). Fills `this.pose` plus the left-hand target
   * (`reloadHand` in gun space, `reloadQuat` gun-relative) when the hand is part of the move.
   *  Pistol — 0–0.24 roll +0.48 rad, lift; the left hand grabs the magazine and strips it downward ·
   *  0.24–0.56 hand out of view at the pouch (0.30–0.40), back with a fresh magazine, slammed home 0.46–0.56 ·
   *  0.56–0.82 the hand racks the slide (overhand) back and lets it snap · 0.82–1 back to the ready pose.
   *  Sniper (8A-3) — two-hand single-round breech load, see the bolt-action branch below.
   */
  private reloadPose(rig: WeaponRig, f: ViewModelFrame, t: number): ReloadPose {
    const P = this.pose;
    P.roll = 0;
    P.pitch = 0;
    P.lift = 0;
    P.shift = 0;
    P.slide = 0;
    P.pump = 0;
    P.bar = -1;
    P.shells = 4;
    P.handShell = 0;
    P.hand = false;
    if (rig.mag && rig.magRest && rig.magAxis) rig.mag.position.copy(rig.magRest);
    if (rig.mag) rig.mag.visible = true;
    if (rig.casing) rig.casing.visible = false;
    if (t < 0) return P;
    const B = RELOAD_BEATS;
    if (rig.boltAction) {
      // ----- 8A-3 K-90 two-hand single-round breech reload -----
      //  0.00–0.22 tilt left, left hand pulls the bolt back (BOLT_OPEN 0.10), spent casing flung right ·
      //  0.22–0.68 hand dips out of view, returns with a fresh cyan-tipped round and guides it into the open
      //  breech (LOAD_ROUND 0.60, settle jolt) · 0.68–0.88 bolt slammed forward and locked (BOLT_CLOSE 0.76),
      //  coils pulse · 0.88–1.00 back to the ready / ADS sight picture.
      const A = sstep(0, 0.12, t) * (1 - sstep(0.84, 1, t));
      P.roll = 0.26 * A;
      P.pitch = 0.08 * A;
      P.lift = 0.07 * A;
      P.shift = -0.05 * A;
      const open = t < 0.04 ? 0 : t < B.BOLT_OPEN + 0.04 ? sstep(0.04, B.BOLT_OPEN + 0.04, t) : t < 0.7 ? 1 : 1 - sstep(0.72, B.BOLT_CLOSE, t);
      P.slide = open;
      P.bar = t >= B.LOAD_ROUND ? 1 : 0;
      _rb.set(0.046, 0.03, 0.034 + rig.slideTravel * open);
      // Round path: below the gun (out of view) → up beside the breech → pushed forward into the chamber.
      const up = sstep(0.24, 0.42, t);
      const push = sstep(0.46, B.LOAD_ROUND, t);
      _ra.set(-0.006 + 0.018 * up, -0.24 + 0.27 * up, 0.12 - 0.075 * push);
      if (t < 0.22) {
        this.reloadHand.copy(_rb);
        this.reloadHand.x -= 0.035 * sstep(0.16, 0.22, t);
        this.reloadQuat.copy(_qRack);
      } else if (t < 0.66) {
        this.reloadHand.copy(_ra);
        this.reloadQuat.identity();
        P.handShell = t > 0.28 && t < B.LOAD_ROUND + 0.02 ? 1 : 0;
      } else {
        const k = sstep(0.66, 0.7, t);
        this.reloadHand.copy(_ra).lerp(_rb, k);
        this.reloadHand.y += 0.05 * sstep(B.BOLT_CLOSE + 0.02, 0.88, t);
        this.reloadHand.x -= 0.06 * sstep(B.BOLT_CLOSE + 0.02, 0.88, t);
        this.reloadQuat.identity().slerp(_qRack, k);
      }
      P.hand = t > 0.01 && t < 0.88;
      // Spent casing: out of the port at BOLT_OPEN, tumbling up and to the right.
      if (rig.casing) {
        const u = (t - B.BOLT_OPEN) / 0.2;
        rig.casing.visible = u > 0 && u < 1;
        if (rig.casing.visible) {
          rig.casing.position.set(rig.eject.position.x + 0.32 * u, rig.eject.position.y + 0.16 * u - 0.34 * u * u, rig.eject.position.z + 0.06 * u);
          rig.casing.rotation.set(u * 9, u * 4, 0);
        }
      }
      return P;
    }
    if (!rig.mag || !rig.magRest || !rig.magAxis) return P;
    // ----- MK-IV pistol -----
    const A = sstep(0, 0.12, t) * (1 - sstep(0.56, 0.64, t));
    const C = sstep(0.56, 0.64, t) * (1 - sstep(0.82, 1, t));
    P.roll = 0.48 * A + 0.16 * C;
    P.pitch = 0.1 * A + 0.04 * C;
    P.lift = 0.13 * A + 0.05 * C;
    P.shift = -0.07 * A - 0.03 * C;
    // Magazine travel along its axis: strip (0.10–0.30) · pouch (0.30–0.40) · return (0.40–0.46) · seat.
    const drop =
      t < 0.1 ? 0
      : t < 0.3 ? 0.55 * sstep(0.1, 0.3, t) * sstep(0.1, 0.3, t)
      : t < 0.4 ? 0.55
      : t < 0.46 ? 0.55 - 0.48 * sstep(0.4, 0.46, t)
      : t < B.SEATED ? 0.07 * (1 - Math.pow(sstep(0.46, B.SEATED, t), 2))
      : 0;
    rig.mag.position.copy(rig.magRest).addScaledVector(rig.magAxis, drop);
    P.bar = t >= B.MAG_OUT && t < B.SEATED ? 0 : t >= B.SEATED ? 1 : -1;
    // Slide: held back 0.60–0.70 (locked open stays back), released at 0.72 — snaps forward.
    const locked = f.slot === 'PISTOL' && f.reloadFrom <= 0 ? 1 : 0;
    const back = t < 0.6 ? locked : t < 0.7 ? locked + (1.08 - locked) * sstep(0.6, 0.7, t) : t < B.SLIDE ? 1.08 : 1.08 * (1 - sstep(B.SLIDE, B.SLIDE + 0.025, t));
    P.slide = back;
    // Left hand: on the magazine (grab → strip → pouch → fresh mag → seat) until 0.58, then on the slide.
    const tilt = Math.atan2(-rig.magAxis.z, -rig.magAxis.y);
    _qa.setFromAxisAngle(_X, tilt).multiply(_qMagGrip);
    _ra.copy(rig.mag.position).addScaledVector(rig.magAxis, 0.03);
    _ra.x -= 0.006;
    _rb.set(0, 0.024, 0.034 + rig.slideTravel * back);
    const toSlide = sstep(0.56, 0.6, t);
    const away = sstep(B.SLIDE, 0.8, t);
    this.reloadHand.copy(_ra).lerp(_rb, toSlide);
    this.reloadHand.y += 0.04 * away;
    this.reloadHand.x -= 0.05 * away;
    this.reloadQuat.copy(_qa).slerp(_qRack, toSlide);
    P.hand = t > 0.02 && t < 0.82;
    return P;
  }

  // =============================================================================================
  // Per frame
  // =============================================================================================
  update(realDt: number, f: ViewModelFrame): void {
    this.time += realDt;
    this.hardU.uWetTime.value = this.time;
    this.gearU.uWetTime.value = this.time;
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

    // Look sway (7A-2: max ±0.016 m, 28 /s follow — sharp, and cut by 95 % in ADS below).
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

    // 7A-5 two-handed tactical reload choreography (gun pose, magazine / shells, slide / bolt / pump, left hand).
    const rt = f.slot === 'GRAPPLE' ? -1 : f.reloadT;
    const R = this.reloadPose(rig, f, rt);
    if (rt < 0) this.reloadPrevT = -1;
    else {
      // Magazine seated (0.56): the gun takes a small upward jolt.
      if (rig.mag && this.reloadPrevT < RELOAD_BEATS.SEATED && rt >= RELOAD_BEATS.SEATED) {
        this.joltV += 0.55;
        this.kickVP += 1.1;
      }
      this.reloadPrevT = rt;
    }
    // The rolled reload poses turn the sight hood into the strand-cyan rim light's mirror angle — fade it.
    this.rimLight.intensity = VM_RIM_INTENSITY * (1 - 0.8 * clamp(Math.abs(R.roll) / 0.5, 0, 1));
    this.joltV += (-320 * this.jolt - 24 * this.joltV) * realDt;
    this.jolt += this.joltV * realDt;

    // Blowback: the pistol slide snaps back in 18 ms and returns in 62 ms (locks open on an empty magazine);
    // the sniper's bolt only moves by hand. Reloads drive them by hand.
    if (rig.slide) {
      const a = f.sinceShot;
      let s = rig.boltAction ? 0 : a < 0.018 ? a / 0.018 : a < 0.08 ? 1 - (a - 0.018) / 0.062 : 0;
      if (f.slot === 'PISTOL' && f.ammo <= 0 && rt < 0) s = 1;
      if (rt >= 0 && f.slot !== 'GRAPPLE') s = R.slide;
      rig.slide.position.z = s * rig.slideTravel;
    }
    if (rig.pump) {
      const t = f.sinceShot - 0.28;
      const pumpT = t > 0 && t < 0.22 ? Math.sin((t / 0.22) * Math.PI) : 0;
      rig.pump.position.z = -0.24 + (rt >= 0 ? R.pump : pumpT) * 0.07;
    }
    // Ejection spark at the port (the sniper's comes from BOLT_OPEN instead).
    if (this.ejectPending && rig.ejectAt >= 0 && f.sinceShot >= rig.ejectAt) {
      this.ejectPending = false;
      this.sparkLife = 0.04;
      this.sparkMat.uniforms.uSeed.value = Math.random();
    }

    // Trigger finger: pull 50 ms, release 80 ms.
    this.triggerT += realDt;
    const pull = this.triggerT < 0.05 ? this.triggerT / 0.05 : this.triggerT < 0.13 ? 1 - (this.triggerT - 0.05) / 0.08 : 0;
    rig.index.rotation.x = pull * 0.24;

    // Shader-driven parts: ammo bar length / colour, pistol coil charge, sniper rail-coil charge / bolt pulse / 1.5 s heat cooldown.
    const u = this.hardU;
    this.sniperHeat = Math.max(0, this.sniperHeat - realDt / 1.5);
    u.uBarrelHeat.value = f.slot === 'SNIPER' ? this.sniperHeat : 0;
    const frac = f.magazine > 0 ? clamp(f.ammo / f.magazine, 0, 1) : 1;
    u.uAmmo.value = rig.hasBar ? (rt >= 0 && R.bar >= 0 ? R.bar : frac) : 1;
    u.uShells.value = rig.shells ? (rt >= 0 ? R.shells : f.ammo) : 4;
    u.uHand.value = rt >= 0 ? R.handShell : 0;
    const low = f.ammo <= Math.max(1, Math.floor(f.magazine * 0.25));
    if (rig.hasBar && f.magazine > 0 && f.ammo <= 0) u.uBarColor.value.setRGB(0, 0, 0);
    else if (low) u.uBarColor.value.setHex(COLORS.ENEMY_DANGER).multiplyScalar(Math.sin(this.time * 18) > 0 ? 2.6 : 0.9);
    else u.uBarColor.value.setHex(this.plasma ? 0xdcf2ff : this.energyHex).multiplyScalar(2.2);
    const S = MATERIALS.PLAYER_STRAND.emissive;
    this.boltPulse = Math.max(0, this.boltPulse - realDt);
    u.uCharge.value =
      f.slot === 'PISTOL' ? (0.35 + 0.65 * clamp(f.sinceShot / 0.3, 0, 1)) * (S / 3)
      : f.slot === 'SNIPER' ? (f.ammo > 0 ? 0.85 : 0.15) + 2.2 * (this.boltPulse / 0.35)
      : 1;

    // 10A-3.2: Pistol spent cartridge arc out of the ejection port (0.22 s).
    if (this.pistolCasingT >= 0) {
      this.pistolCasingT += realDt / 0.22;
      const pc = this.rigs.PISTOL.casing;
      if (pc && f.slot === 'PISTOL' && this.pistolCasingT < 1) {
        const ct = this.pistolCasingT;
        pc.visible = true;
        const ej = this.rigs.PISTOL.eject.position;
        pc.position.set(ej.x + 0.26 * ct, ej.y + 0.12 * ct - 0.28 * ct * ct, ej.z + 0.05 * ct);
        pc.rotation.set(ct * 11, ct * 6, ct * 4);
      } else {
        if (pc) pc.visible = false;
        if (this.pistolCasingT >= 1) this.pistolCasingT = -1;
      }
    }

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
    const calm = 1 - CAMERA.ADS_SWAY_CUT * z;
    const p = this.weaponPivot;
    p.position.set(
      0.21 + (adsX - 0.21) * z + (this.swayX + bobX) * calm + R.shift,
      -0.2 + (adsY + 0.2) * z + (this.swayY + bobY) * calm - ease * 0.32 + R.lift + this.jolt - this.lower - this.mantleDip,
      -0.42 + (adsZ + 0.42) * z + this.kickZ + ease * 0.05,
    );
    p.rotation.set(this.kickP + ease * 0.95 + this.swayY * 2 * calm + R.pitch, this.swayX * 2.5 * calm, (-this.tilt - ease * 0.35 + R.roll) * (1 - 0.6 * z), 'XYZ');
    p.updateMatrix();

    // Left arm: supports the sniper fore-end, thrusts the winch forward while the strand is out,
    // otherwise rests low-left. Poses blend smoothly (position lerp + quaternion slerp).
    const strandOut = f.ropeAttached || f.hookInFlight;
    // 7A-6 mantle: the free hand slaps down on the ledge and pushes (0.3 s).
    this.mantleT += realDt;
    const mt = this.mantleT / MANTLE_HAND_S;
    const mantling = mt < 1;
    this.mantleDip = mantling ? Math.sin(Math.min(1, mt) * Math.PI) * 0.07 : 0;
    if (R.hand) {
      _p.copy(this.reloadHand).applyMatrix4(p.matrix);
      _q.copy(p.quaternion).multiply(this.reloadQuat);
    } else if (mantling) {
      const push = Math.sin(Math.min(1, mt) * Math.PI);
      _p.set(-0.15, -0.15 - 0.08 * push, -0.48 + 0.05 * push);
      _q.copy(_qMantle);
    } else if (strandOut) {
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
    const lk = lerpFactor(R.hand ? 30 : mantling ? 26 : rig.support && !strandOut ? 16 : 9, realDt);
    this.leftPos.lerp(_p, lk);
    this.leftQuat.slerp(_q, lk);
    this.leftArm.position.copy(this.leftPos);
    this.leftArm.quaternion.copy(this.leftQuat);

    // Muzzle flash, ejection spark, muzzle light.
    rig.group.updateMatrix();
    if (this.flashLife > 0) {
      this.flashLife -= realDt;
      if (this.flashLife > 0) {
        this.flash.visible = true;
        this.flashMat.uniforms.uAlpha.value = clamp(this.flashLife / Math.max(this.flashMaxLife, 1e-4), 0, 1);
        this.flash.position.copy(rig.muzzle.position).applyMatrix4(rig.group.matrix);
      } else {
        this.flash.visible = false;
      }
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
      this.muzzleLight.intensity = this.lightPeak * clamp(this.lightLife / Math.max(this.lightMaxLife, 1e-4), 0, 1);
      this.root.updateMatrixWorld(true);
      rig.muzzle.getWorldPosition(this.muzzleLight.position);
      this.muzzleLight.position.z += 0.05;
    } else {
      this.muzzleLight.intensity = 0;
    }

    // Holo reticle: project a point 50 m down the sight axis (collimated at infinity) to the lens shader.
    // 7A-2: from half zoom on the dot is locked to the screen centre — the camera / shot axis itself — so it
    // never trails the (sway-lagged) gun by a frame; below that it blends smoothly from the sight axis.
    this.root.updateMatrixWorld(true);
    rig.lens.getWorldPosition(_v);
    rig.group.getWorldQuaternion(_q2);
    _v2.set(0, 0, -50).applyQuaternion(_q2).add(_v);
    _ndc.copy(_v2).applyMatrix4(this.vmCamera.projectionMatrix);
    const lock = z >= 0.5 ? 1 : z <= 0 ? 0 : (z / 0.5) * (z / 0.5) * (3 - (2 * z) / 0.5);
    (this.lensMat.uniforms.uReticle.value as THREE.Vector2).set(_ndc.x * (1 - lock), _ndc.y * (1 - lock));
    this.lensMat.uniforms.uAspect.value = this.vmCamera.aspect;
    this.lensMat.uniforms.uMode.value = f.slot === 'SNIPER' ? 1 : 0;
    this.lensMat.uniforms.uPx.value = 2 / Math.max(1, typeof window !== 'undefined' ? window.innerHeight : 1080);
  }

  /** Keeps the view-model's PMREM reflections consistent with the main view orientation. */
  syncEnvironment(cameraEuler: THREE.Euler): void {
    this.scene.environmentRotation.set(-cameraEuler.x, -cameraEuler.y, 0, 'YXZ');
    // 7B-7: world up in view space for the wet gloss (pitch only; the view-model ignores roll).
    const up = this.hardU.uUpView.value;
    up.set(0, Math.cos(cameraEuler.x), -Math.sin(cameraEuler.x));
    this.gearU.uUpView.value.copy(up);
  }

  /** Reticle position (NDC) of the active holo sight — verification / HUD. */
  get holoReticleNdc(): THREE.Vector2 {
    return this.lensMat.uniforms.uReticle.value as THREE.Vector2;
  }

  /** 10A-3.2: current K-90 barrel heat (1 -> 0 over 1.5 s after firing). */
  get barrelHeat(): number {
    return this.sniperHeat;
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

  /** 10A-3.2: world-matched position of the weapon's ejection port (`eject`). */
  ejectWorld(slot: SlotId, mainCamera: THREE.PerspectiveCamera, out: THREE.Vector3): THREE.Vector3 {
    return this.screenMatchedWorld(this.rigs[slot].eject, mainCamera, out);
  }

  winchWorld(mainCamera: THREE.PerspectiveCamera, out: THREE.Vector3): THREE.Vector3 {
    return this.screenMatchedWorld(this.winchExit, mainCamera, out);
  }
}

const _tmpWhite = new THREE.Color(0xfff4e6);
