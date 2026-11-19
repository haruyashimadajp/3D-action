/**
 * STRAND // PROTOCOL — Supertall neon city builder (§6.1, §6.2-2, §8.1, §9.2).
 *
 * Persistent (built once):  sky dome · cloud deck · 80 instanced far-field towers
 * Per sector (rebuilt):     4–7 playable towers (merged, world-space window PBR) · wet roofs with
 *                           puddle rain ripples · cyan wall-run panels · cranes / steel / gold anchors ·
 *                           instanced rooftop details (AC units, fences, ducts, antennas, aviation
 *                           lights @1.2 Hz, hologram neon signs, volumetric searchlights, machine rooms)
 *                           · jade gate tower + light pillar · colliders / wall-run surfaces / anchors.
 *
 * Draw-call budget: every repeated element is one InstancedMesh or one merged geometry.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  COLORS,
  LEVEL,
  LIMITS,
  MATERIALS,
  RENDER,
  createRng,
  clamp,
} from '../config/constants';
import { SECTORS, type SectorDef } from '../config/skills';
import type { ProceduralTextureLibrary } from '../engine/ProceduralTextures';

// ---------------------------------------------------------------------------
// Public layout data consumed by PhysicsWorld / EnemyManager / PlayerController
// ---------------------------------------------------------------------------
export type ColliderKind = 'BUILDING' | 'PROP' | 'STEEL';

export interface BoxCollider {
  readonly min: THREE.Vector3;
  readonly max: THREE.Vector3;
  readonly kind: ColliderKind;
  /** Index of the owning building (-1 for free-standing steel). */
  readonly building: number;
}

export interface WallRunSurface {
  /** Axis-aligned rectangle lying on the building face. */
  readonly min: THREE.Vector3;
  readonly max: THREE.Vector3;
  /** Outward unit normal (±X or ±Z). */
  readonly normal: THREE.Vector3;
  readonly building: number;
}

export type AnchorKind = 'CRANE' | 'EDGE_BEAM' | 'NODE' | 'GATE';
export interface GrappleAnchor {
  readonly position: THREE.Vector3;
  readonly kind: AnchorKind;
  /** Gate anchor is only usable once the sector gate opens. */
  enabled: boolean;
}

export interface BuildingInfo {
  readonly index: number;
  readonly cx: number;
  readonly cz: number;
  readonly halfW: number;
  readonly halfD: number;
  readonly roofY: number;
  readonly isSpawn: boolean;
  readonly isGateTower: boolean;
}

export interface SpawnPoint {
  readonly position: THREE.Vector3;
  readonly building: number;
}

export interface SectorLayout {
  readonly sector: SectorDef;
  readonly loop: number;
  readonly buildings: readonly BuildingInfo[];
  readonly colliders: readonly BoxCollider[];
  readonly wallRunSurfaces: readonly WallRunSurface[];
  readonly anchors: readonly GrappleAnchor[];
  readonly playerSpawn: THREE.Vector3;
  readonly playerSpawnYaw: number;
  /** Standing positions on roofs for humanoids (excluding the spawn roof). */
  readonly roofSpawns: readonly SpawnPoint[];
  /** Elevated sniper perches near roof edges of the highest towers. */
  readonly perchSpawns: readonly SpawnPoint[];
  /** Free-air points for drones (6–22 m above reference). */
  readonly airSpawns: readonly THREE.Vector3[];
  /** Gate pillar base on the gate tower roof. */
  readonly gatePosition: THREE.Vector3;
  readonly gateAnchor: GrappleAnchor;
  /** Center of the play area. */
  readonly center: THREE.Vector3;
}

// ---------------------------------------------------------------------------
// Module-scope temporaries (no per-frame allocation)
// ---------------------------------------------------------------------------
const _m4 = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scl = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();
const _euler = new THREE.Euler();

// Instance capacities (pre-allocated once)
const CAP = {
  AC: 72,
  DUCT: 36,
  FENCE: 110,
  ANTENNA: 28,
  AVIATION: 140,
  NEON: 56,
  SEARCH: 18,
  MACHINE_ROOM: 18,
  BEACON: 72,
} as const;

interface RoofRect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------
/** Box with UVs scaled to world size (tile metres) so textures keep constant texel density. */
function worldUvBox(w: number, h: number, d: number, cx: number, cy: number, cz: number, tile: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  // Face order: +x, -x, +y, -y, +z, -z (4 vertices each)
  const dims: Array<[number, number, number, number]> = [
    [d, h, cz, cy],
    [d, h, cz, cy],
    [w, d, cx, cz],
    [w, d, cx, cz],
    [w, h, cx, cy],
    [w, h, cx, cy],
  ];
  for (let f = 0; f < 6; f++) {
    const [su, sv, ou, ov] = dims[f];
    for (let v = 0; v < 4; v++) {
      const i = f * 4 + v;
      uv.setXY(i, (uv.getX(i) * su + ou) / tile, (uv.getY(i) * sv + ov) / tile);
    }
  }
  g.translate(cx, cy, cz);
  return g;
}

/** Thin box spanning a → b (lattice members, cables). */
function beam(a: THREE.Vector3, b: THREE.Vector3, thickness: number): THREE.BufferGeometry {
  const len = a.distanceTo(b);
  const g = new THREE.BoxGeometry(thickness, len, thickness);
  _dir.subVectors(b, a).normalize();
  _quat.setFromUnitVectors(_up, _dir);
  g.applyQuaternion(_quat);
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return g;
}

function boxAt(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

function addSeed(g: THREE.BufferGeometry, seed: number): THREE.BufferGeometry {
  const n = g.getAttribute('position').count;
  const arr = new Float32Array(n).fill(seed);
  g.setAttribute('aSeed', new THREE.BufferAttribute(arr, 1));
  return g;
}

function rectsOverlap(a: RoofRect, b: RoofRect): boolean {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.z0 < b.z1 && a.z1 > b.z0;
}

/** Edge-to-edge distance between two axis-aligned footprints. */
function footprintGap(a: BuildingInfo, b: BuildingInfo): number {
  const gx = Math.abs(a.cx - b.cx) - (a.halfW + b.halfW);
  const gz = Math.abs(a.cz - b.cz) - (a.halfD + b.halfD);
  if (gx > 0 && gz > 0) return Math.hypot(gx, gz);
  return Math.max(gx, gz);
}

// ---------------------------------------------------------------------------
// Shared shader snippets
// ---------------------------------------------------------------------------
const FOG_FADE_GLSL = /* glsl */ `
  float strandFogFade(float dist, float density) {
    float f = 1.0 - exp(-density * density * dist * dist);
    return 1.0 - clamp(f, 0.0, 1.0);
  }
`;

// ---------------------------------------------------------------------------
// CityBuilder
// ---------------------------------------------------------------------------
export class CityBuilder {
  readonly root = new THREE.Group();
  private readonly persistent = new THREE.Group();
  private readonly sectorGroup = new THREE.Group();
  private sectorDisposables: Array<{ dispose(): void }> = [];

  // Materials (created once)
  private readonly buildingMat: THREE.MeshStandardMaterial;
  private readonly roofMat: THREE.MeshStandardMaterial;
  private readonly panelMat: THREE.MeshStandardMaterial;
  private readonly steelMat: THREE.MeshStandardMaterial;
  private readonly beaconMat: THREE.MeshStandardMaterial;
  private readonly machineryMat: THREE.MeshStandardMaterial;
  private readonly housingMat: THREE.MeshStandardMaterial;
  private readonly ductMat: THREE.MeshStandardMaterial;
  private readonly fenceMat: THREE.MeshStandardMaterial;

  // Shader uniforms shared across animated materials
  private readonly uTime = { value: 0 };
  private readonly uNeonBoost = { value: 1.0 };
  private readonly uSearchPulse = { value: 0.0 };
  private readonly uGateActive = { value: 0.0 };
  private readonly uFogDensity = { value: RENDER.FOG_DENSITY };
  private readonly uFogColor = { value: new THREE.Color(COLORS.FOG_ABYSS) };

  // Persistent meshes
  private readonly sky: THREE.Mesh;
  private readonly clouds: THREE.Mesh;
  private readonly farTowers: THREE.InstancedMesh;
  private readonly farTowerInfo: Array<{ x: number; z: number; w: number; d: number; top: number }> = [];

  // Instanced rooftop detail meshes (pre-allocated, counts set per sector)
  private readonly acUnits: THREE.InstancedMesh;
  private readonly ducts: THREE.InstancedMesh;
  private readonly fences: THREE.InstancedMesh;
  private readonly antennas: THREE.InstancedMesh;
  private readonly aviation: THREE.InstancedMesh;
  private readonly neonSigns: THREE.InstancedMesh;
  private readonly searchlights: THREE.InstancedMesh;
  private readonly machineRooms: THREE.InstancedMesh;
  private readonly beacons: THREE.InstancedMesh;
  private readonly halos: THREE.InstancedMesh;
  private readonly gatePillar: THREE.Mesh;
  private readonly gateBeacon: THREE.Mesh;

  private layout: SectorLayout | null = null;

  constructor(private readonly tex: ProceduralTextureLibrary) {
    this.root.name = 'City';
    this.root.add(this.persistent, this.sectorGroup);

    // ---------------- Materials ----------------
    this.buildingMat = this.createBuildingMaterial();
    this.roofMat = this.createRoofMaterial();
    this.panelMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: tex.wallPanel.map,
      roughness: 1.0,
      roughnessMap: tex.wallPanel.roughnessMap,
      metalness: MATERIALS.WALLRUN_PANEL.metalness,
      normalMap: tex.wallPanel.normalMap,
      emissive: new THREE.Color(COLORS.WALLRUN_CYAN),
      emissiveMap: tex.wallPanel.emissiveMap,
      emissiveIntensity: MATERIALS.WALLRUN_PANEL.emissive,
    });
    this.steelMat = new THREE.MeshStandardMaterial({ color: 0x2a303b, roughness: 0.42, metalness: 0.85 });
    this.beaconMat = this.createBeaconMaterial();
    this.machineryMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: tex.machinery.map,
      roughness: 1.0,
      roughnessMap: tex.machinery.roughnessMap,
      normalMap: tex.machinery.normalMap,
      metalness: 0.55,
    });
    this.housingMat = new THREE.MeshStandardMaterial({ color: 0x232934, roughness: 0.5, metalness: 0.55 });
    this.ductMat = new THREE.MeshStandardMaterial({ color: 0x4a525e, roughness: 0.3, metalness: 0.9 });
    this.fenceMat = new THREE.MeshStandardMaterial({ color: 0x3a414d, roughness: 0.38, metalness: 0.88 });

    // ---------------- Persistent backdrop ----------------
    this.sky = this.createSky();
    this.clouds = this.createCloudDeck();
    this.farTowers = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), this.buildingMat, LIMITS.FAR_BUILDINGS);
    this.farTowers.geometry.setAttribute(
      'aSeed',
      new THREE.InstancedBufferAttribute(new Float32Array(LIMITS.FAR_BUILDINGS), 1),
    );
    this.farTowers.name = 'FarTowers';
    this.persistent.add(this.sky, this.clouds, this.farTowers);
    this.layoutFarTowers(0xfa77);

    // ---------------- Instanced rooftop details ----------------
    this.acUnits = this.makeInstanced(this.createAcGeometry(), this.machineryMat, CAP.AC, 'ACUnits');
    this.ducts = this.makeInstanced(this.createDuctGeometry(), this.ductMat, CAP.DUCT, 'Ducts');
    this.fences = this.makeInstanced(this.createFenceGeometry(), this.fenceMat, CAP.FENCE, 'Fences');
    this.antennas = this.makeInstanced(this.createAntennaGeometry(), this.steelMat, CAP.ANTENNA, 'Antennas');
    this.machineRooms = this.makeInstanced(this.createMachineRoomGeometry(), this.housingMat, CAP.MACHINE_ROOM, 'MachineRooms');
    this.aviation = this.createAviationLights();
    this.neonSigns = this.createNeonSigns();
    this.searchlights = this.createSearchlights();
    this.beacons = this.makeInstanced(this.createBeaconGeometry(), this.beaconMat, CAP.BEACON, 'GoldAnchors');
    this.halos = this.createAnchorHalos();
    const gate = this.createGate();
    this.gatePillar = gate.pillar;
    this.gateBeacon = gate.beacon;
    this.persistent.add(
      this.acUnits, this.ducts, this.fences, this.antennas, this.machineRooms, this.aviation,
      this.neonSigns, this.searchlights, this.beacons, this.halos, this.gatePillar, this.gateBeacon,
    );
  }

  get currentLayout(): SectorLayout | null {
    return this.layout;
  }

  // =========================================================================================
  // Materials
  // =========================================================================================
  /** Glass tower material: world-space window mapping, per-building seed, roof-face override. */
  private createBuildingMaterial(): THREE.MeshStandardMaterial {
    const w = this.tex.windows;
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: w.map,
      roughness: 1.0,
      roughnessMap: w.roughnessMap,
      metalness: MATERIALS.BUILDING_GLASS.metalness,
      normalMap: w.normalMap,
      normalScale: new THREE.Vector2(0.8, 0.8),
      emissive: new THREE.Color(0xffffff),
      emissiveMap: w.emissiveMap,
      emissiveIntensity: MATERIALS.BUILDING_GLASS.emissive,
    });
    const tileW = RENDER.WINDOW_TILE_WIDTH_M.toFixed(2);
    const tileH = RENDER.WINDOW_TILE_HEIGHT_M.toFixed(2);
    const roofCol = new THREE.Color(COLORS.ROOF_WET);
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          /* glsl */ `#include <common>
          attribute float aSeed;
          varying float vTop;
          varying float vSeed;`,
        )
        .replace(
          '#include <uv_vertex>',
          /* glsl */ `#include <uv_vertex>
          {
            #ifdef USE_INSTANCING
              mat4 strandWm = modelMatrix * instanceMatrix;
            #else
              mat4 strandWm = modelMatrix;
            #endif
            vec4 strandWp = strandWm * vec4(position, 1.0);
            vec3 strandWn = normalize(mat3(strandWm) * normal);
            vec2 strandUv;
            if (abs(strandWn.y) > 0.5) {
              vTop = 1.0;
              strandUv = strandWp.xz / ${tileW};
            } else {
              vTop = 0.0;
              float along = abs(strandWn.x) > abs(strandWn.z) ? -strandWp.z * sign(strandWn.x) : strandWp.x * sign(strandWn.z);
              strandUv = vec2(along / ${tileW}, strandWp.y / ${tileH});
            }
            strandUv += vec2(floor(aSeed * 8.0) / 8.0, floor(fract(aSeed * 13.7) * 8.0) / 8.0);
            vSeed = aSeed;
            vMapUv = strandUv;
            vEmissiveMapUv = strandUv;
            vRoughnessMapUv = strandUv;
            vNormalMapUv = strandUv;
          }`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          /* glsl */ `#include <common>
          varying float vTop;
          varying float vSeed;`,
        )
        .replace(
          '#include <map_fragment>',
          /* glsl */ `#include <map_fragment>
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(${roofCol.r.toFixed(4)}, ${roofCol.g.toFixed(4)}, ${roofCol.b.toFixed(4)}), vTop);`,
        )
        .replace(
          '#include <emissivemap_fragment>',
          /* glsl */ `#include <emissivemap_fragment>
          totalEmissiveRadiance *= (1.0 - vTop) * (0.72 + 0.28 * fract(vSeed * 91.7));`,
        );
    };
    mat.customProgramCacheKey = () => 'strand-building-v1';
    return mat;
  }

  /** Wet rooftop concrete with puddle mirror roughness and animated rain ripples inside puddles. */
  private createRoofMaterial(): THREE.MeshStandardMaterial {
    const r = this.tex.roof;
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: r.map,
      roughness: 1.0,
      roughnessMap: r.roughnessMap,
      metalness: MATERIALS.ROOF_WET.metalness,
      normalMap: r.normalMap,
      normalScale: new THREE.Vector2(0.6, 0.6),
    });
    const uTime = this.uTime;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = uTime;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vRoofWorld;\nvarying float vRoofUp;')
        .replace(
          '#include <worldpos_vertex>',
          `#include <worldpos_vertex>
          vRoofWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
          vRoofUp = normalize(mat3(modelMatrix) * objectNormal).y;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          /* glsl */ `#include <common>
          uniform float uTime;
          varying vec3 vRoofWorld;
          varying float vRoofUp;
          float rHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
          vec2 rainRipples(vec2 p, float t) {
            vec2 cell = floor(p);
            vec2 grad = vec2(0.0);
            for (int j = -1; j <= 1; j++) {
              for (int i = -1; i <= 1; i++) {
                vec2 c = cell + vec2(float(i), float(j));
                float h = rHash(c);
                vec2 center = c + vec2(rHash(c + 7.1), rHash(c + 3.7));
                float life = fract(t * (0.9 + h * 0.6) + h);
                vec2 d = p - center;
                float dist = length(d);
                float radius = life * 0.75;
                float x = (dist - radius) * 22.0;
                float ring = sin(clamp(x, -3.14159, 3.14159)) * (1.0 - life) * (1.0 - life);
                ring *= step(abs(x), 3.14159);
                grad += (dist > 1e-4 ? d / dist : vec2(0.0)) * ring;
              }
            }
            return grad;
          }`,
        )
        .replace(
          '#include <normal_fragment_maps>',
          /* glsl */ `#include <normal_fragment_maps>
          {
            #ifdef USE_ROUGHNESSMAP
              float rr = texture2D(roughnessMap, vRoughnessMapUv).g;
              float puddle = 1.0 - smoothstep(0.08, 0.22, rr);
            #else
              float puddle = 0.0;
            #endif
            if (puddle > 0.001 && vRoofUp > 0.5) {
              vec2 g = rainRipples(vRoofWorld.xz * 2.2, uTime) * 0.32 + rainRipples(vRoofWorld.xz * 3.7 + 11.0, uTime * 1.21) * 0.22;
              vec3 rippleWorld = vec3(g.x, 0.0, g.y) * puddle;
              normal = normalize(normal + mat3(viewMatrix) * rippleWorld);
            }
          }`,
        );
    };
    mat.customProgramCacheKey = () => 'strand-roof-v1';
    return mat;
  }

  /** Gold anchor beacons: spin around Y in the vertex shader (no CPU matrix updates). */
  private createBeaconMaterial(): THREE.MeshStandardMaterial {
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(COLORS.GRAPPLE_GOLD),
      roughness: MATERIALS.GRAPPLE_ANCHOR.roughness,
      metalness: MATERIALS.GRAPPLE_ANCHOR.metalness,
      emissive: new THREE.Color(COLORS.GRAPPLE_GOLD),
      emissiveIntensity: MATERIALS.GRAPPLE_ANCHOR.emissive,
    });
    const uTime = this.uTime;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = uTime;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform float uTime;
          mat3 strandRotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }`,
        )
        .replace(
          '#include <beginnormal_vertex>',
          `#include <beginnormal_vertex>
          objectNormal = strandRotY(uTime * 1.6) * objectNormal;`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          transformed = strandRotY(uTime * 1.6) * transformed;`,
        );
    };
    mat.customProgramCacheKey = () => 'strand-beacon-v1';
    return mat;
  }

  // =========================================================================================
  // Persistent backdrop
  // =========================================================================================
  private createSky(): THREE.Mesh {
    const geo = new THREE.SphereGeometry(2400, 64, 32);
    const moonDir = new THREE.Vector3(-0.45, 0.62, -0.64).normalize();
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uZenith: { value: new THREE.Color(COLORS.SKY_ZENITH) },
        uHorizon: { value: new THREE.Color(COLORS.FOG_ABYSS) },
        uMoonDir: { value: moonDir },
        uMoonColor: { value: new THREE.Color(COLORS.MOON) },
        uTime: this.uTime,
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uZenith; uniform vec3 uHorizon; uniform vec3 uMoonDir; uniform vec3 uMoonColor; uniform float uTime;
        varying vec3 vDir;
        float h12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
        float vn(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); vec2 u = f*f*(3.0-2.0*f);
          return mix(mix(h12(i), h12(i+vec2(1,0)), u.x), mix(h12(i+vec2(0,1)), h12(i+vec2(1,1)), u.x), u.y); }
        void main() {
          vec3 d = normalize(vDir);
          float y = d.y;
          // Below & at the horizon = exact fog colour so fogged towers dissolve seamlessly.
          vec3 col = mix(uHorizon, uZenith, smoothstep(0.0, 0.42, y));
          // City light pollution: magenta / violet haze just above the horizon.
          col += vec3(0.020, 0.008, 0.034) * exp(-max(y, 0.0) * 9.0) * smoothstep(-0.06, 0.05, y);
          // High storm-cloud streaks lit from below.
          vec2 cp = d.xz / max(y + 0.15, 0.05) * 1.6 + vec2(uTime * 0.004, uTime * 0.002);
          float cloud = smoothstep(0.55, 0.85, vn(cp) * 0.65 + vn(cp * 2.7) * 0.35);
          col = mix(col, vec3(0.018, 0.014, 0.03), cloud * smoothstep(0.02, 0.25, y) * 0.8);
          // Stars (sparse, faint, hidden by clouds).
          vec2 sp = vec2(atan(d.z, d.x) * 180.0, y * 260.0);
          float star = step(0.9965, h12(floor(sp))) * smoothstep(0.12, 0.5, y) * (1.0 - cloud);
          col += vec3(0.16, 0.18, 0.24) * star * (0.6 + 0.4 * sin(uTime * 3.0 + h12(floor(sp)) * 40.0));
          // Moon disc & halo.
          float md = dot(d, normalize(uMoonDir));
          col += uMoonColor * smoothstep(0.99935, 0.9996, md) * 0.9;
          col += uMoonColor * pow(max(md, 0.0), 220.0) * 0.12 + uMoonColor * pow(max(md, 0.0), 18.0) * 0.015;
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'SkyDome';
    mesh.frustumCulled = false;
    mesh.renderOrder = -10;
    return mesh;
  }

  /** Cloud deck ~300 m below the sector reference with city glow bleeding up through it. */
  private createCloudDeck(): THREE.Mesh {
    const geo = new THREE.PlaneGeometry(6000, 6000, 1, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.ShaderMaterial({
      fog: false,
      depthWrite: false,
      transparent: false,
      uniforms: {
        uTime: this.uTime,
        uAbyss: { value: new THREE.Color(COLORS.FOG_ABYSS) },
        uMagenta: { value: new THREE.Color(COLORS.NEON_MAGENTA) },
        uAmber: { value: new THREE.Color(COLORS.NEON_AMBER) },
        uCyan: { value: new THREE.Color(COLORS.WINDOW_COOL) },
        uFogColor: this.uFogColor,
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform vec3 uAbyss; uniform vec3 uMagenta; uniform vec3 uAmber; uniform vec3 uCyan; uniform vec3 uFogColor;
        varying vec3 vWorld;
        float h12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
        float vn(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); vec2 u = f*f*(3.0-2.0*f);
          return mix(mix(h12(i), h12(i+vec2(1,0)), u.x), mix(h12(i+vec2(0,1)), h12(i+vec2(1,1)), u.x), u.y); }
        float fbm(vec2 p) { float s = 0.0; float a = 0.5; for (int i = 0; i < 5; i++) { s += vn(p) * a; p = p * 2.03 + 17.1; a *= 0.5; } return s; }
        void main() {
          vec2 p = vWorld.xz * 0.006 + vec2(uTime * 0.006, uTime * 0.0035);
          float dens = fbm(p);
          float billow = fbm(p * 2.6 - uTime * 0.01);
          vec3 col = uAbyss * (0.55 + dens * 1.25 + billow * 0.35);
          // City light pockets glowing up through gaps in the deck.
          float pocket = smoothstep(0.62, 0.8, fbm(vWorld.xz * 0.0021 + 3.3)) * (1.0 - dens * 0.6);
          float hueSel = vn(vWorld.xz * 0.0013 + 9.0);
          vec3 glow = hueSel < 0.38 ? uMagenta : (hueSel < 0.7 ? uAmber : uCyan);
          col += glow * pocket * 0.07;
          float dist = length(vWorld - cameraPosition);
          float fade = 1.0 - exp(-pow(dist * 0.0016, 2.0));
          col = mix(col, uFogColor, clamp(fade, 0.0, 1.0));
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'CloudDeck';
    mesh.position.y = LEVEL.CLOUD_DECK_Y;
    mesh.frustumCulled = false;
    mesh.renderOrder = -9;
    return mesh;
  }

  /** Far-field ring of up to 80 instanced towers (150–620 m). */
  private layoutFarTowers(seed: number): void {
    const rng = createRng(seed);
    const seedAttr = this.farTowers.geometry.getAttribute('aSeed') as THREE.InstancedBufferAttribute;
    this.farTowerInfo.length = 0;
    let placed = 0;
    let guard = 0;
    while (placed < LIMITS.FAR_BUILDINGS && guard < 4000) {
      guard++;
      const ang = rng() * Math.PI * 2;
      const t = rng();
      const dist = LEVEL.FAR_RING_INNER_M + Math.pow(t, 0.8) * (LEVEL.FAR_RING_OUTER_M - LEVEL.FAR_RING_INNER_M);
      const x = Math.cos(ang) * dist;
      const z = Math.sin(ang) * dist;
      const w = 22 + rng() * 40;
      const d = 22 + rng() * 40;
      let ok = true;
      for (const o of this.farTowerInfo) {
        if (Math.abs(o.x - x) < (o.w + w) / 2 + 10 && Math.abs(o.z - z) < (o.d + d) / 2 + 10) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      // Taller towers further out so the skyline layers; some drop far below into the clouds.
      const top = -140 + rng() * 260 + (dist - LEVEL.FAR_RING_INNER_M) * 0.12;
      const h = top - LEVEL.BUILDING_BASE_Y;
      _pos.set(x, LEVEL.BUILDING_BASE_Y + h / 2, z);
      _quat.identity();
      _scl.set(w, h, d);
      _m4.compose(_pos, _quat, _scl);
      this.farTowers.setMatrixAt(placed, _m4);
      seedAttr.setX(placed, rng());
      this.farTowerInfo.push({ x, z, w, d, top });
      placed++;
    }
    this.farTowers.count = placed;
    this.farTowers.instanceMatrix.needsUpdate = true;
    seedAttr.needsUpdate = true;
    this.farTowers.computeBoundingSphere();
  }

  // =========================================================================================
  // Instanced detail geometry & materials
  // =========================================================================================
  private makeInstanced(geo: THREE.BufferGeometry, mat: THREE.Material, cap: number, name: string): THREE.InstancedMesh {
    const m = new THREE.InstancedMesh(geo, mat, cap);
    m.count = 0;
    m.name = name;
    m.frustumCulled = false;
    return m;
  }

  private createAcGeometry(): THREE.BufferGeometry {
    // Unit footprint 2.2 × 1.3 × 1.2 with fan grille on top face via machinery map.
    const body = new THREE.BoxGeometry(2.2, 1.3, 1.2);
    body.translate(0, 0.65 + 0.12, 0);
    const feet = boxAt(2.0, 0.12, 1.0, 0, 0.06, 0);
    return mergeGeometries([body, feet]) as THREE.BufferGeometry;
  }

  private createDuctGeometry(): THREE.BufferGeometry {
    // Horizontal exhaust duct (unit length along X) on two saddles; scaled in X per instance.
    const pipe = new THREE.CylinderGeometry(0.45, 0.45, 1, 16, 1, false);
    pipe.rotateZ(Math.PI / 2);
    pipe.translate(0, 1.05, 0);
    const s1 = boxAt(0.12, 0.6, 0.8, -0.38, 0.3, 0);
    const s2 = boxAt(0.12, 0.6, 0.8, 0.38, 0.3, 0);
    return mergeGeometries([pipe, s1, s2]) as THREE.BufferGeometry;
  }

  private createFenceGeometry(): THREE.BufferGeometry {
    // 3 m segment along X: posts, rails, vertical pickets (1.2 m tall).
    const parts: THREE.BufferGeometry[] = [];
    parts.push(boxAt(0.08, 1.2, 0.08, -1.5, 0.6, 0), boxAt(0.08, 1.2, 0.08, 1.5, 0.6, 0));
    parts.push(boxAt(3.0, 0.06, 0.06, 0, 1.17, 0), boxAt(3.0, 0.05, 0.05, 0, 0.12, 0), boxAt(3.0, 0.04, 0.04, 0, 0.64, 0));
    for (let i = 1; i < 15; i++) parts.push(boxAt(0.025, 1.08, 0.025, -1.5 + i * 0.2, 0.62, 0));
    return mergeGeometries(parts) as THREE.BufferGeometry;
  }

  private createAntennaGeometry(): THREE.BufferGeometry {
    // Unit-height mast (scaled in Y) with cross arms.
    const parts: THREE.BufferGeometry[] = [];
    parts.push(boxAt(0.14, 1.0, 0.14, 0, 0.5, 0));
    parts.push(boxAt(0.9, 0.02, 0.04, 0, 0.72, 0), boxAt(0.04, 0.02, 0.9, 0, 0.82, 0), boxAt(0.6, 0.02, 0.04, 0, 0.92, 0));
    parts.push(boxAt(0.7, 0.04, 0.7, 0, 0.02, 0));
    return mergeGeometries(parts) as THREE.BufferGeometry;
  }

  private createMachineRoomGeometry(): THREE.BufferGeometry {
    const body = boxAt(1, 1, 1, 0, 0.5, 0);
    const cap = boxAt(1.06, 0.06, 1.06, 0, 1.0, 0);
    return mergeGeometries([body, cap]) as THREE.BufferGeometry;
  }

  private createBeaconGeometry(): THREE.BufferGeometry {
    const core = new THREE.OctahedronGeometry(0.42, 0);
    core.deleteAttribute('uv');
    const ring = new THREE.TorusGeometry(0.62, 0.05, 6, 24);
    ring.deleteAttribute('uv');
    ring.rotateX(Math.PI / 2);
    const merged = mergeGeometries([core, ring.toNonIndexed()]) as THREE.BufferGeometry;
    merged.computeVertexNormals();
    return merged;
  }

  private createAviationLights(): THREE.InstancedMesh {
    const geo = new THREE.SphereGeometry(0.2, 10, 6);
    geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(new Float32Array(CAP.AVIATION), 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: this.uTime,
        uColor: { value: new THREE.Color(COLORS.AVIATION_RED) },
        uHz: { value: RENDER.AVIATION_BLINK_HZ },
        uFogDensity: this.uFogDensity,
      },
      vertexShader: /* glsl */ `
        attribute float aPhase;
        varying float vPhase;
        varying float vDist;
        void main() {
          vPhase = aPhase;
          vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
          vDist = length(wp.xyz - cameraPosition);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform vec3 uColor; uniform float uHz; uniform float uFogDensity;
        varying float vPhase; varying float vDist;
        ${FOG_FADE_GLSL}
        void main() {
          float cyc = fract(uTime * uHz + vPhase);
          float on = smoothstep(0.0, 0.04, cyc) * (1.0 - smoothstep(0.32, 0.4, cyc));
          // Background element: peak 0.9 keeps it below the 0.92 bloom threshold.
          vec3 c = uColor * (0.06 + 0.84 * on);
          float f = strandFogFade(vDist, uFogDensity * 0.55);
          gl_FragColor = vec4(c * f, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    const m = new THREE.InstancedMesh(geo, mat, CAP.AVIATION);
    m.count = 0;
    m.frustumCulled = false;
    m.name = 'AviationLights';
    return m;
  }

  private createNeonSigns(): THREE.InstancedMesh {
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.setAttribute('aStrip', new THREE.InstancedBufferAttribute(new Float32Array(CAP.NEON), 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uTime: this.uTime,
        uAtlas: { value: this.tex.neonAtlas },
        uStrips: { value: this.tex.neonAtlasStrips },
        uBoost: this.uNeonBoost,
        uFogDensity: this.uFogDensity,
      },
      vertexShader: /* glsl */ `
        attribute float aStrip;
        varying vec2 vUv;
        varying float vStrip;
        varying float vDist;
        void main() {
          vUv = uv;
          vStrip = aStrip;
          vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
          vDist = length(wp.xyz - cameraPosition);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform sampler2D uAtlas; uniform float uStrips; uniform float uBoost; uniform float uFogDensity;
        varying vec2 vUv; varying float vStrip; varying float vDist;
        ${FOG_FADE_GLSL}
        float h11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
        void main() {
          float strip = floor(vStrip + 0.5);
          // Hologram jitter: rare horizontal tears.
          float tearRow = floor(vUv.y * 48.0);
          float tear = step(0.985, h11(tearRow + floor(uTime * 12.0) * 7.0 + strip * 3.0)) * 0.03;
          vec2 auv = vec2((strip + clamp(vUv.x + tear, 0.0, 1.0)) / uStrips, vUv.y);
          vec4 t = texture2D(uAtlas, auv);
          // Flicker: brief dropouts unique per sign.
          float fl = h11(floor(uTime * 9.0) + strip * 17.0);
          float flicker = fl < 0.04 ? 0.25 : 1.0;
          float scan = 0.82 + 0.18 * sin(vUv.y * 420.0 - uTime * 6.0);
          // Background decoration: peak ~0.85 (below the 0.92 bloom threshold) — FLOW A boosts +25 %.
          vec3 c = t.rgb * 0.85 * scan * flicker * uBoost;
          float f = strandFogFade(vDist, uFogDensity * 0.7);
          gl_FragColor = vec4(c * f, t.a * mix(0.35, 1.0, f));
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    const m = new THREE.InstancedMesh(geo, mat, CAP.NEON);
    m.count = 0;
    m.frustumCulled = false;
    m.name = 'NeonSigns';
    return m;
  }

  /** Additive translucent cones; sweep animated entirely in the vertex shader. */
  private createSearchlights(): THREE.InstancedMesh {
    const length = 160;
    const geo = new THREE.CylinderGeometry(0.35, 9, length, 24, 1, true);
    geo.translate(0, length / 2, 0);
    geo.setAttribute('aBase', new THREE.InstancedBufferAttribute(new Float32Array(CAP.SEARCH * 3), 3));
    geo.setAttribute('aParams', new THREE.InstancedBufferAttribute(new Float32Array(CAP.SEARCH * 4), 4));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: {
        uTime: this.uTime,
        uLength: { value: length },
        uPulse: this.uSearchPulse,
        uColor: { value: new THREE.Color(0x9fd8ff) },
        uFogDensity: this.uFogDensity,
      },
      vertexShader: /* glsl */ `
        attribute vec3 aBase;
        attribute vec4 aParams; // phase, speed, sweepAmplitude, baseTilt
        uniform float uTime; uniform float uLength;
        varying float vAlong; varying float vEdge; varying float vDist;
        void main() {
          float yaw = aParams.x + sin(uTime * aParams.y + aParams.x) * aParams.z;
          float tilt = aParams.w + sin(uTime * aParams.y * 0.73 + aParams.x * 2.0) * 0.16;
          float ct = cos(tilt), st = sin(tilt), cy = cos(yaw), sy = sin(yaw);
          mat3 rz = mat3(ct, st, 0.0, -st, ct, 0.0, 0.0, 0.0, 1.0);
          mat3 ry = mat3(cy, 0.0, -sy, 0.0, 1.0, 0.0, sy, 0.0, cy);
          mat3 r = ry * rz;
          vec3 wp = aBase + r * position;
          vec3 wn = normalize(r * normal);
          vec3 v = normalize(cameraPosition - wp);
          vEdge = abs(dot(wn, v));
          vAlong = position.y / uLength;
          vDist = length(wp - cameraPosition);
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; uniform float uPulse; uniform float uFogDensity;
        varying float vAlong; varying float vEdge; varying float vDist;
        ${FOG_FADE_GLSL}
        void main() {
          float core = pow(vEdge, 2.2);
          float falloff = pow(1.0 - clamp(vAlong, 0.0, 1.0), 1.7);
          float a = core * falloff * 0.16 * (1.0 + uPulse * 0.9);
          float f = strandFogFade(vDist, uFogDensity * 0.45);
          gl_FragColor = vec4(uColor * a * f, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    const m = new THREE.InstancedMesh(geo, mat, CAP.SEARCH);
    m.count = 0;
    m.frustumCulled = false;
    m.name = 'Searchlights';
    m.renderOrder = 5;
    return m;
  }

  /** Camera-facing additive halos around gold anchors (pulsing, interactive → HDR). */
  private createAnchorHalos(): THREE.InstancedMesh {
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: this.uTime,
        uColor: { value: new THREE.Color(COLORS.GRAPPLE_GOLD) },
        uFogDensity: this.uFogDensity,
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv; varying float vDist; varying float vSeed;
        void main() {
          vUv = uv;
          vec3 center = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          vSeed = fract(center.x * 0.173 + center.z * 0.311);
          vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
          vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
          float size = 3.2;
          vec3 wp = center + (right * position.x + up * position.y) * size;
          vDist = length(center - cameraPosition);
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform vec3 uColor; uniform float uFogDensity;
        varying vec2 vUv; varying float vDist; varying float vSeed;
        ${FOG_FADE_GLSL}
        void main() {
          vec2 p = vUv - 0.5;
          float r = length(p) * 2.0;
          float pulse = fract(uTime * 0.8 + vSeed);
          float ring = smoothstep(0.06, 0.0, abs(r - pulse)) * (1.0 - pulse);
          float glow = exp(-r * 5.5) * 0.9;
          float a = (glow + ring * 1.4) * strandFogFade(vDist, uFogDensity * 0.35);
          gl_FragColor = vec4(uColor * a * 1.6, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    const m = new THREE.InstancedMesh(geo, mat, CAP.BEACON);
    m.count = 0;
    m.frustumCulled = false;
    m.name = 'AnchorHalos';
    m.renderOrder = 6;
    return m;
  }

  /** Jade gate: volumetric light pillar + high-altitude jade anchor (hidden until the sector clears). */
  private createGate(): { pillar: THREE.Mesh; beacon: THREE.Mesh } {
    const h = 900;
    const geo = new THREE.CylinderGeometry(3.2, 3.2, h, 32, 1, true);
    geo.translate(0, h / 2 - 300, 0);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: {
        uTime: this.uTime,
        uColor: { value: new THREE.Color(COLORS.GATE_JADE) },
        uIntensity: { value: MATERIALS.GATE_JADE.emissive },
        uActive: this.uGateActive,
      },
      vertexShader: /* glsl */ `
        varying vec3 vN; varying vec3 vV; varying float vY;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vN = normalize(mat3(modelMatrix) * normal);
          vV = normalize(cameraPosition - wp.xyz);
          vY = position.y;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform vec3 uColor; uniform float uIntensity; uniform float uActive;
        varying vec3 vN; varying vec3 vV; varying float vY;
        float h11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
        void main() {
          float edge = pow(abs(dot(normalize(vN), normalize(vV))), 2.4);
          float flow = 0.75 + 0.25 * sin(vY * 0.35 - uTime * 7.0) + 0.15 * sin(vY * 1.3 - uTime * 13.0);
          float spark = step(0.992, h11(floor(vY * 2.0) + floor(uTime * 20.0)));
          float fadeY = smoothstep(-300.0, -120.0, vY) * (1.0 - smoothstep(320.0, 600.0, vY));
          float a = (edge * flow + spark * 0.6) * fadeY * uActive;
          gl_FragColor = vec4(uColor * uIntensity * a, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    const pillar = new THREE.Mesh(geo, mat);
    pillar.name = 'GatePillar';
    pillar.frustumCulled = false;
    pillar.visible = false;
    pillar.renderOrder = 7;

    const bGeo = new THREE.OctahedronGeometry(0.75, 0);
    const bMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(COLORS.GATE_JADE),
      emissive: new THREE.Color(COLORS.GATE_JADE),
      emissiveIntensity: MATERIALS.GATE_JADE.emissive,
      roughness: 0.2,
      metalness: 0.6,
    });
    const beacon = new THREE.Mesh(bGeo, bMat);
    beacon.name = 'GateAnchor';
    beacon.visible = false;
    return { pillar, beacon };
  }

  // =========================================================================================
  // Sector construction
  // =========================================================================================
  /**
   * Builds the playable tower cluster for sector `sectorIndex` (1..5) of endless loop `loop`.
   * Deterministic: identical inputs always produce the identical layout (instant retries).
   */
  buildSector(sectorIndex: number, loop: number): SectorLayout {
    const sector = SECTORS[clamp(sectorIndex, 1, SECTORS.length) - 1];
    const rng = createRng(0x5eed + sector.index * 7919 + loop * 104729);
    this.clearSector();

    const buildings = sector.layout === 'RING' ? this.layoutRing(sector, rng) : this.layoutGrid(sector, rng);
    const gateTower = this.placeGateTower(buildings, rng);
    const allBuildings = [...buildings, gateTower];

    const colliders: BoxCollider[] = [];
    const wallRun: WallRunSurface[] = [];
    const anchors: GrappleAnchor[] = [];
    const roofRects: RoofRect[][] = allBuildings.map(() => []);

    const bodyGeos: THREE.BufferGeometry[] = [];
    const roofGeos: THREE.BufferGeometry[] = [];
    const panelGeos: THREE.BufferGeometry[] = [];
    const steelGeos: THREE.BufferGeometry[] = [];

    // Instance writers
    let acN = 0, ductN = 0, fenceN = 0, antN = 0, aviN = 0, neonN = 0, searchN = 0, roomN = 0, beaconN = 0;
    const aviPhase = this.aviation.geometry.getAttribute('aPhase') as THREE.InstancedBufferAttribute;
    const neonStrip = this.neonSigns.geometry.getAttribute('aStrip') as THREE.InstancedBufferAttribute;
    const searchBase = this.searchlights.geometry.getAttribute('aBase') as THREE.InstancedBufferAttribute;
    const searchParams = this.searchlights.geometry.getAttribute('aParams') as THREE.InstancedBufferAttribute;

    const addAviation = (x: number, y: number, z: number): void => {
      if (aviN >= CAP.AVIATION) return;
      _m4.makeTranslation(x, y, z);
      this.aviation.setMatrixAt(aviN, _m4);
      aviPhase.setX(aviN, (Math.abs(x * 0.013 + z * 0.007)) % 0.12);
      aviN++;
    };
    const addBeacon = (p: THREE.Vector3, kind: AnchorKind): void => {
      anchors.push({ position: p.clone(), kind, enabled: true });
      if (beaconN >= CAP.BEACON) return;
      _m4.makeTranslation(p.x, p.y, p.z);
      this.beacons.setMatrixAt(beaconN, _m4);
      this.halos.setMatrixAt(beaconN, _m4);
      beaconN++;
    };
    const addNeon = (x: number, y: number, z: number, nx: number, nz: number, w: number, h: number, strip: number): void => {
      if (neonN >= CAP.NEON) return;
      _pos.set(x, y, z);
      _euler.set(0, Math.atan2(nx, nz), 0);
      _quat.setFromEuler(_euler);
      _scl.set(w, h, 1);
      _m4.compose(_pos, _quat, _scl);
      this.neonSigns.setMatrixAt(neonN, _m4);
      neonStrip.setX(neonN, strip % this.tex.neonAtlasStrips);
      neonN++;
    };
    const addSearch = (x: number, y: number, z: number): void => {
      if (searchN >= CAP.SEARCH) return;
      searchBase.setXYZ(searchN, x, y, z);
      searchParams.setXYZW(searchN, rng() * Math.PI * 2, 0.18 + rng() * 0.25, 0.6 + rng() * 0.9, 0.25 + rng() * 0.35);
      searchN++;
    };

    // ---------------- Towers, roofs, colliders ----------------
    allBuildings.forEach((b) => {
      const w = b.halfW * 2;
      const d = b.halfD * 2;
      const bodyTop = b.roofY - 0.45;
      const bodyH = bodyTop - LEVEL.BUILDING_BASE_Y;
      const body = new THREE.BoxGeometry(w, bodyH, d);
      body.translate(b.cx, LEVEL.BUILDING_BASE_Y + bodyH / 2, b.cz);
      bodyGeos.push(addSeed(body, rng()));
      // Roof slab with slight overhang + metal flashing edge.
      roofGeos.push(worldUvBox(w + 0.3, 0.5, d + 0.3, b.cx, b.roofY - 0.25, b.cz, RENDER.ROOF_TILE_M));
      steelGeos.push(
        boxAt(w + 0.42, 0.08, 0.22, b.cx, b.roofY + 0.02, b.cz + b.halfD + 0.1),
        boxAt(w + 0.42, 0.08, 0.22, b.cx, b.roofY + 0.02, b.cz - b.halfD - 0.1),
        boxAt(0.22, 0.08, d + 0.2, b.cx + b.halfW + 0.1, b.roofY + 0.02, b.cz),
        boxAt(0.22, 0.08, d + 0.2, b.cx - b.halfW - 0.1, b.roofY + 0.02, b.cz),
      );
      colliders.push({
        min: new THREE.Vector3(b.cx - b.halfW, LEVEL.BUILDING_BASE_Y, b.cz - b.halfD),
        max: new THREE.Vector3(b.cx + b.halfW, b.roofY, b.cz + b.halfD),
        kind: 'BUILDING',
        building: b.index,
      });
      // Roof-corner steel beam stubs with gold beacons (grapple-able building edges).
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const ex = b.cx + sx * (b.halfW + 0.6);
          const ez = b.cz + sz * (b.halfD + 0.6);
          const base = new THREE.Vector3(b.cx + sx * (b.halfW - 0.6), b.roofY, b.cz + sz * (b.halfD - 0.6));
          const tip = new THREE.Vector3(ex, b.roofY + 2.4, ez);
          steelGeos.push(beam(base, tip, 0.22), beam(new THREE.Vector3(base.x, b.roofY, base.z), new THREE.Vector3(base.x, b.roofY + 2.6, base.z), 0.26));
          addBeacon(new THREE.Vector3(ex, b.roofY + 2.9, ez), 'EDGE_BEAM');
          roofRects[b.index].push({ x0: base.x - 1, z0: base.z - 1, x1: base.x + 1, z1: base.z + 1 });
        }
      }
    });

    // ---------------- Neighbour analysis: wall-run panels, cranes, floating nodes ----------------
    const pairs: Array<[BuildingInfo, BuildingInfo, number]> = [];
    for (let i = 0; i < buildings.length; i++) {
      for (let j = i + 1; j < buildings.length; j++) {
        const gap = footprintGap(buildings[i], buildings[j]);
        if (gap >= LEVEL.GAP_MIN_M - 0.01 && gap <= LEVEL.GAP_MAX_M + 0.01) pairs.push([buildings[i], buildings[j], gap]);
      }
    }
    // Gate tower links to its nearest playable building.
    {
      let best = buildings[0];
      let bestGap = Infinity;
      for (const b of buildings) {
        const g = footprintGap(b, gateTower);
        if (g < bestGap) {
          bestGap = g;
          best = b;
        }
      }
      pairs.push([best, gateTower, bestGap]);
    }

    const panelSides = new Map<string, true>();
    const addPanel = (b: BuildingInfo, axis: 'x' | 'z', sign: number, rngW: number): void => {
      const key = `${b.index}:${axis}:${sign}`;
      if (panelSides.has(key)) return;
      panelSides.set(key, true);
      const sideLen = axis === 'x' ? b.halfD * 2 : b.halfW * 2;
      const pw = Math.min(22, sideLen * (0.64 + rngW * 0.16));
      const ph = 10 + rngW * 2.5;
      const top = b.roofY - 1.4;
      const bottom = top - ph;
      const cy = (top + bottom) / 2;
      const off = 0.06;
      const plane = new THREE.PlaneGeometry(pw, ph);
      const uv = plane.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setX(i, (uv.getX(i) * pw) / RENDER.WALLRUN_CHEVRON_TILE_M);
      let px: number, pz: number;
      const normal = new THREE.Vector3();
      if (axis === 'x') {
        plane.rotateY(sign > 0 ? Math.PI / 2 : -Math.PI / 2);
        px = b.cx + sign * (b.halfW + off);
        pz = b.cz;
        normal.set(sign, 0, 0);
      } else {
        plane.rotateY(sign > 0 ? 0 : Math.PI);
        px = b.cx;
        pz = b.cz + sign * (b.halfD + off);
        normal.set(0, 0, sign);
      }
      plane.translate(px, cy, pz);
      panelGeos.push(plane);
      // Steel frame around the panel for depth.
      const fr = 0.18;
      if (axis === 'x') {
        steelGeos.push(
          boxAt(0.2, fr, pw + fr * 2, px, top + fr / 2, pz),
          boxAt(0.2, fr, pw + fr * 2, px, bottom - fr / 2, pz),
          boxAt(0.2, ph, fr, px, cy, pz - pw / 2 - fr / 2),
          boxAt(0.2, ph, fr, px, cy, pz + pw / 2 + fr / 2),
        );
      } else {
        steelGeos.push(
          boxAt(pw + fr * 2, fr, 0.2, px, top + fr / 2, pz),
          boxAt(pw + fr * 2, fr, 0.2, px, bottom - fr / 2, pz),
          boxAt(fr, ph, 0.2, px - pw / 2 - fr / 2, cy, pz),
          boxAt(fr, ph, 0.2, px + pw / 2 + fr / 2, cy, pz),
        );
      }
      const faceCoord = axis === 'x' ? b.cx + sign * b.halfW : b.cz + sign * b.halfD;
      wallRun.push({
        min: new THREE.Vector3(axis === 'x' ? faceCoord : b.cx - pw / 2, bottom, axis === 'x' ? b.cz - pw / 2 : faceCoord),
        max: new THREE.Vector3(axis === 'x' ? faceCoord : b.cx + pw / 2, top, axis === 'x' ? b.cz + pw / 2 : faceCoord),
        normal,
        building: b.index,
      });
    };

    const craneSides = new Set<string>();
    pairs.forEach(([a, b, gap], pi) => {
      const dx = b.cx - a.cx;
      const dz = b.cz - a.cz;
      const axis: 'x' | 'z' = Math.abs(dx) >= Math.abs(dz) ? 'x' : 'z';
      const sA = axis === 'x' ? Math.sign(dx) : Math.sign(dz);
      // Wall-run panels on both facing sides.
      addPanel(a, axis, sA, rng());
      addPanel(b, axis, -sA, rng());

      // Anchor in the gap: crane from the higher roof on even pairs / gate link, floating node otherwise.
      const hi = a.roofY >= b.roofY ? a : b;
      const lo = hi === a ? b : a;
      const dirSign = axis === 'x' ? Math.sign(lo.cx - hi.cx) : Math.sign(lo.cz - hi.cz);
      // Lateral coordinate: overlap centre of the two footprints on the other axis.
      const latMin = axis === 'x' ? Math.max(a.cz - a.halfD, b.cz - b.halfD) : Math.max(a.cx - a.halfW, b.cx - b.halfW);
      const latMax = axis === 'x' ? Math.min(a.cz + a.halfD, b.cz + b.halfD) : Math.min(a.cx + a.halfW, b.cx + b.halfW);
      const hiLatMin = axis === 'x' ? hi.cz - hi.halfD + 3 : hi.cx - hi.halfW + 3;
      const hiLatMax = axis === 'x' ? hi.cz + hi.halfD - 3 : hi.cx + hi.halfW - 3;
      const lat = clamp(latMin < latMax ? (latMin + latMax) / 2 : axis === 'x' ? (a.cz + b.cz) / 2 : (a.cx + b.cx) / 2, hiLatMin, hiLatMax);
      const hiEdge = axis === 'x' ? hi.cx + dirSign * hi.halfW : hi.cz + dirSign * hi.halfD;
      const isGateLink = b.isGateTower || a.isGateTower;

      const craneKey = `${hi.index}:${axis}:${dirSign}`;
      if ((pi % 2 === 0 || isGateLink) && !craneSides.has(craneKey)) {
        craneSides.add(craneKey);
        // ---- Tower crane on the higher roof ----
        const mastH = 14 + rng() * 5;
        const mastAlong = hiEdge - dirSign * 2.6;
        const mx = axis === 'x' ? mastAlong : lat;
        const mz = axis === 'x' ? lat : mastAlong;
        const base = hi.roofY;
        const top = base + mastH;
        const c = 0.6; // mast half-width
        const corners: Array<[number, number]> = [[-c, -c], [c, -c], [c, c], [-c, c]];
        for (const [ox, oz] of corners) {
          steelGeos.push(beam(new THREE.Vector3(mx + ox, base, mz + oz), new THREE.Vector3(mx + ox, top, mz + oz), 0.14));
        }
        const seg = 1.6;
        for (let y = base; y < top - 0.01; y += seg) {
          const y2 = Math.min(y + seg, top);
          for (let k = 0; k < 4; k++) {
            const [ax, az] = corners[k];
            const [bx, bz] = corners[(k + 1) % 4];
            steelGeos.push(beam(new THREE.Vector3(mx + ax, y, mz + az), new THREE.Vector3(mx + bx, y2, mz + bz), 0.07));
            steelGeos.push(beam(new THREE.Vector3(mx + ax, y2, mz + az), new THREE.Vector3(mx + bx, y2, mz + bz), 0.07));
          }
        }
        // Jib over the gap and counter-jib with counterweight.
        const jibLen = gap / 2 + 2.6 + 3.5;
        const jibEnd = mastAlong + dirSign * jibLen;
        const cjEnd = mastAlong - dirSign * 7;
        const jy = top - 0.4;
        const P = (along: number, y: number, latOff = 0): THREE.Vector3 =>
          axis === 'x' ? new THREE.Vector3(along, y, lat + latOff) : new THREE.Vector3(lat + latOff, y, along);
        steelGeos.push(
          beam(P(cjEnd, jy, -0.45), P(jibEnd, jy, -0.45), 0.16),
          beam(P(cjEnd, jy, 0.45), P(jibEnd, jy, 0.45), 0.16),
          beam(P(mastAlong, top + 3.2), P(jibEnd, jy + 0.6), 0.08),
          beam(P(mastAlong, top + 3.2), P(cjEnd, jy + 0.6), 0.08),
          beam(P(mastAlong, top), P(mastAlong, top + 3.2), 0.18),
        );
        for (let t = 0; t <= 1.0001; t += 1 / 8) {
          const al = cjEnd + (jibEnd - cjEnd) * t;
          steelGeos.push(beam(P(al, jy, -0.45), P(al, jy, 0.45), 0.06));
        }
        const cw = P(cjEnd + dirSign * 1.4, jy - 1.0);
        steelGeos.push(boxAt(axis === 'x' ? 2.2 : 1.8, 1.8, axis === 'x' ? 1.8 : 2.2, cw.x, cw.y, cw.z));
        // Hook cable & block; anchor at the jib tip underside.
        const tip = P(jibEnd - dirSign * 0.6, jy - 0.4);
        const hook = P(jibEnd - dirSign * 0.6, jy - 4.5);
        steelGeos.push(beam(tip, hook, 0.04), boxAt(0.6, 0.8, 0.6, hook.x, hook.y - 0.4, hook.z));
        addBeacon(P(jibEnd - dirSign * 0.6, jy - 1.1), 'CRANE');
        addAviation(P(mastAlong, top + 3.4).x, top + 3.5, P(mastAlong, top + 3.4).z);
        addAviation(P(jibEnd, jy).x, jy + 0.3, P(jibEnd, jy).z);
        colliders.push({
          min: new THREE.Vector3(mx - c, base, mz - c),
          max: new THREE.Vector3(mx + c, top + 3.2, mz + c),
          kind: 'STEEL',
          building: hi.index,
        });
        const jA = P(Math.min(cjEnd, jibEnd), jy - 0.12, -0.55);
        const jB = P(Math.max(cjEnd, jibEnd), jy + 0.12, 0.55);
        colliders.push({
          min: new THREE.Vector3(Math.min(jA.x, jB.x), jy - 0.12, Math.min(jA.z, jB.z)),
          max: new THREE.Vector3(Math.max(jA.x, jB.x), jy + 0.12, Math.max(jA.z, jB.z)),
          kind: 'STEEL',
          building: -1,
        });
        roofRects[hi.index].push({ x0: mx - 2.5, z0: mz - 2.5, x1: mx + 2.5, z1: mz + 2.5 });
      } else {
        // ---- Floating drone anchor node in mid-gap ----
        const midAlong = hiEdge + dirSign * (gap / 2);
        const ny = Math.max(a.roofY, b.roofY) + 9 + rng() * 4;
        const p = axis === 'x' ? new THREE.Vector3(midAlong, ny, lat) : new THREE.Vector3(lat, ny, midAlong);
        // Rotor housing ring drawn in steel.
        steelGeos.push(
          boxAt(1.6, 0.12, 0.18, p.x, p.y + 0.85, p.z),
          boxAt(0.18, 0.12, 1.6, p.x, p.y + 0.85, p.z),
          boxAt(0.3, 0.5, 0.3, p.x, p.y + 0.55, p.z),
        );
        addBeacon(p, 'NODE');
        addAviation(p.x, p.y + 1.05, p.z);
      }
    });
    // Every tower must carry wall-run panels: guarantee at least two per building.
    allBuildings.forEach((b) => {
      const count = wallRun.filter((s) => s.building === b.index).length;
      const sides: Array<['x' | 'z', number]> = [['x', 1], ['x', -1], ['z', 1], ['z', -1]];
      let k = Math.floor(rng() * 4);
      for (let need = Math.max(0, 2 - count); need > 0; k++) {
        const [ax, sg] = sides[k % 4];
        const key = `${b.index}:${ax}:${sg}`;
        if (!panelSides.has(key)) {
          addPanel(b, ax, sg, rng());
          need--;
        }
        if (k > 12) break;
      }
    });

    // ---------------- Rooftop details per building ----------------
    const tryPlace = (bi: number, b: BuildingInfo, hw: number, hd: number, margin: number): RoofRect | null => {
      for (let attempt = 0; attempt < 24; attempt++) {
        const x = b.cx + (rng() * 2 - 1) * (b.halfW - hw - margin);
        const z = b.cz + (rng() * 2 - 1) * (b.halfD - hd - margin);
        const r: RoofRect = { x0: x - hw, z0: z - hd, x1: x + hw, z1: z + hd };
        let ok = true;
        for (const o of roofRects[bi]) {
          if (rectsOverlap({ x0: r.x0 - 0.9, z0: r.z0 - 0.9, x1: r.x1 + 0.9, z1: r.z1 + 0.9 }, o)) {
            ok = false;
            break;
          }
        }
        if (ok) {
          roofRects[bi].push(r);
          return r;
        }
      }
      return null;
    };

    const spawnB = allBuildings[0];
    // Keep the player spawn pad clear.
    roofRects[spawnB.index].push({ x0: spawnB.cx - 4, z0: spawnB.cz - 4, x1: spawnB.cx + 4, z1: spawnB.cz + 4 });

    allBuildings.forEach((b) => {
      const bi = b.index;
      // Machine room (penthouse).
      if (roomN < CAP.MACHINE_ROOM) {
        const rw = 4 + rng() * 3;
        const rd = 3.5 + rng() * 2.5;
        const rh = 3.2 + rng() * 1.6;
        const r = tryPlace(bi, b, rw / 2, rd / 2, 2.5);
        if (r) {
          _pos.set((r.x0 + r.x1) / 2, b.roofY, (r.z0 + r.z1) / 2);
          _quat.identity();
          _scl.set(rw, rh, rd);
          _m4.compose(_pos, _quat, _scl);
          this.machineRooms.setMatrixAt(roomN++, _m4);
          colliders.push({ min: new THREE.Vector3(r.x0, b.roofY, r.z0), max: new THREE.Vector3(r.x1, b.roofY + rh + 0.06, r.z1), kind: 'PROP', building: bi });
          // Antenna on the machine room.
          if (antN < CAP.ANTENNA) {
            const ah = 6 + rng() * 8;
            _pos.set(r.x0 + 0.8, b.roofY + rh, r.z0 + 0.8);
            _scl.set(1, ah, 1);
            _m4.compose(_pos, _quat, _scl);
            this.antennas.setMatrixAt(antN++, _m4);
            addAviation(r.x0 + 0.8, b.roofY + rh + ah + 0.15, r.z0 + 0.8);
          }
        }
      }
      // AC unit clusters.
      const acCount = 3 + Math.floor(rng() * 5);
      for (let i = 0; i < acCount && acN < CAP.AC; i++) {
        const rot = rng() < 0.5 ? 0 : Math.PI / 2;
        const hw = rot === 0 ? 1.1 : 0.6;
        const hd = rot === 0 ? 0.6 : 1.1;
        const r = tryPlace(bi, b, hw, hd, 1.4);
        if (!r) continue;
        _pos.set((r.x0 + r.x1) / 2, b.roofY, (r.z0 + r.z1) / 2);
        _euler.set(0, rot, 0);
        _quat.setFromEuler(_euler);
        _scl.set(1, 1, 1);
        _m4.compose(_pos, _quat, _scl);
        this.acUnits.setMatrixAt(acN++, _m4);
        colliders.push({ min: new THREE.Vector3(r.x0, b.roofY, r.z0), max: new THREE.Vector3(r.x1, b.roofY + 1.42, r.z1), kind: 'PROP', building: bi });
      }
      // Exhaust ducts.
      const ductCount = 1 + Math.floor(rng() * 2);
      for (let i = 0; i < ductCount && ductN < CAP.DUCT; i++) {
        const len = 4 + rng() * 4;
        const alongX = rng() < 0.5;
        const r = tryPlace(bi, b, alongX ? len / 2 : 0.5, alongX ? 0.5 : len / 2, 1.6);
        if (!r) continue;
        _pos.set((r.x0 + r.x1) / 2, b.roofY, (r.z0 + r.z1) / 2);
        _euler.set(0, alongX ? 0 : Math.PI / 2, 0);
        _quat.setFromEuler(_euler);
        _scl.set(len, 1, 1);
        _m4.compose(_pos, _quat, _scl);
        this.ducts.setMatrixAt(ductN++, _m4);
        colliders.push({ min: new THREE.Vector3(r.x0, b.roofY, r.z0), max: new THREE.Vector3(r.x1, b.roofY + 1.5, r.z1), kind: 'PROP', building: bi });
      }
      // Fences along edges that do NOT face a neighbour (keep traversal routes open).
      const edges: Array<['x' | 'z', number]> = [['x', 1], ['x', -1], ['z', 1], ['z', -1]];
      for (const [ax, sg] of edges) {
        if (panelSides.has(`${bi}:${ax}:${sg}`) || rng() < 0.35) continue;
        const len = ax === 'x' ? b.halfD * 2 : b.halfW * 2;
        const segs = Math.floor((len - 6) / 3);
        const start = -((segs - 1) * 3) / 2;
        for (let s = 0; s < segs && fenceN < CAP.FENCE; s++) {
          const along = start + s * 3;
          const fx = ax === 'x' ? b.cx + sg * (b.halfW - 0.5) : b.cx + along;
          const fz = ax === 'x' ? b.cz + along : b.cz + sg * (b.halfD - 0.5);
          _pos.set(fx, b.roofY, fz);
          _euler.set(0, ax === 'x' ? Math.PI / 2 : 0, 0);
          _quat.setFromEuler(_euler);
          _scl.set(1, 1, 1);
          _m4.compose(_pos, _quat, _scl);
          this.fences.setMatrixAt(fenceN++, _m4);
        }
        if (segs > 0) {
          const half = (segs * 3) / 2;
          colliders.push(
            ax === 'x'
              ? { min: new THREE.Vector3(b.cx + sg * (b.halfW - 0.5) - 0.05, b.roofY, b.cz - half), max: new THREE.Vector3(b.cx + sg * (b.halfW - 0.5) + 0.05, b.roofY + 1.2, b.cz + half), kind: 'PROP', building: bi }
              : { min: new THREE.Vector3(b.cx - half, b.roofY, b.cz + sg * (b.halfD - 0.5) - 0.05), max: new THREE.Vector3(b.cx + half, b.roofY + 1.2, b.cz + sg * (b.halfD - 0.5) + 0.05), kind: 'PROP', building: bi },
          );
        }
      }
      // Hologram neon signs on faces without wall-run panels, hung below the traversal band.
      const signs = 1 + Math.floor(rng() * 2);
      for (let s = 0; s < signs; s++) {
        const [ax, sg] = edges[Math.floor(rng() * 4)];
        const hasPanel = panelSides.has(`${bi}:${ax}:${sg}`);
        const sh = 14 + rng() * 10;
        const sw = sh / 6.5;
        const topY = hasPanel ? b.roofY - 16 : b.roofY - 2.5;
        const sy = topY - sh / 2;
        const lateral = (rng() * 2 - 1) * ((ax === 'x' ? b.halfD : b.halfW) - sw);
        const sx = ax === 'x' ? b.cx + sg * (b.halfW + 1.2) : b.cx + lateral;
        const sz = ax === 'x' ? b.cz + lateral : b.cz + sg * (b.halfD + 1.2);
        addNeon(sx, sy, sz, ax === 'x' ? sg : 0, ax === 'z' ? sg : 0, sw, sh, Math.floor(rng() * 8));
      }
    });

    // Searchlights: two on sector roofs, the rest on far towers.
    for (let i = 0; i < 2; i++) {
      const b = allBuildings[1 + Math.floor(rng() * (allBuildings.length - 1))];
      addSearch(b.cx + (rng() - 0.5) * b.halfW, b.roofY + 0.6, b.cz + (rng() - 0.5) * b.halfD);
    }
    // Far-field dressing: aviation lights, neon, searchlights.
    this.farTowerInfo.forEach((t, i) => {
      if (i % 2 === 0) addAviation(t.x, t.top + 0.4, t.z);
      if (i % 5 === 0) addSearch(t.x, t.top + 0.5, t.z);
      if (i % 3 === 0) {
        const toC = Math.atan2(-t.x, -t.z);
        const nx = Math.sin(toC);
        const nz = Math.cos(toC);
        const sh = 26 + (i % 7) * 5;
        addNeon(t.x + nx * (t.w / 2 + 1.5), t.top - 10 - sh / 2, t.z + nz * (t.d / 2 + 1.5), nx, nz, sh / 6.5, sh, i);
      }
    });

    // ---------------- Merge sector geometry (4 draw calls) ----------------
    const bodies = new THREE.Mesh(mergeGeometries(bodyGeos) as THREE.BufferGeometry, this.buildingMat);
    bodies.name = 'SectorTowers';
    const roofs = new THREE.Mesh(mergeGeometries(roofGeos) as THREE.BufferGeometry, this.roofMat);
    roofs.name = 'SectorRoofs';
    const panels = new THREE.Mesh(mergeGeometries(panelGeos) as THREE.BufferGeometry, this.panelMat);
    panels.name = 'WallRunPanels';
    const steel = new THREE.Mesh(mergeGeometries(steelGeos.map(stripToPosNormal)) as THREE.BufferGeometry, this.steelMat);
    steel.name = 'SteelStructures';
    for (const g of [...bodyGeos, ...roofGeos, ...panelGeos, ...steelGeos]) g.dispose();
    this.sectorGroup.add(bodies, roofs, panels, steel);
    this.sectorDisposables.push(bodies.geometry, roofs.geometry, panels.geometry, steel.geometry);

    // ---------------- Commit instance counts ----------------
    const commit = (m: THREE.InstancedMesh, n: number): void => {
      m.count = n;
      m.instanceMatrix.needsUpdate = true;
    };
    commit(this.acUnits, acN);
    commit(this.ducts, ductN);
    commit(this.fences, fenceN);
    commit(this.antennas, antN);
    commit(this.machineRooms, roomN);
    commit(this.aviation, aviN);
    aviPhase.needsUpdate = true;
    commit(this.neonSigns, neonN);
    neonStrip.needsUpdate = true;
    this.searchlights.count = searchN;
    searchBase.needsUpdate = true;
    searchParams.needsUpdate = true;
    commit(this.beacons, beaconN);
    commit(this.halos, beaconN);

    // ---------------- Gate ----------------
    const gatePos = new THREE.Vector3(gateTower.cx, gateTower.roofY, gateTower.cz);
    this.gatePillar.position.set(gatePos.x, gatePos.y, gatePos.z);
    const nearest = pairs[pairs.length - 1][0];
    const gx = clamp(nearest.cx, gateTower.cx - gateTower.halfW, gateTower.cx + gateTower.halfW);
    const gz = clamp(nearest.cz, gateTower.cz - gateTower.halfD, gateTower.cz + gateTower.halfD);
    const gateAnchor: GrappleAnchor = {
      position: new THREE.Vector3((gx + gateTower.cx) / 2, gateTower.roofY + 16, (gz + gateTower.cz) / 2),
      kind: 'GATE',
      enabled: false,
    };
    anchors.push(gateAnchor);
    this.gateBeacon.position.copy(gateAnchor.position);
    this.setGateActive(false);

    // ---------------- Spawns ----------------
    const center = new THREE.Vector3();
    buildings.forEach((b) => center.add(_pos.set(b.cx, b.roofY, b.cz)));
    center.divideScalar(buildings.length);
    const playerSpawn = new THREE.Vector3(spawnB.cx, spawnB.roofY, spawnB.cz);
    const toCenter = _dir.set(center.x - spawnB.cx, 0, center.z - spawnB.cz);
    const playerSpawnYaw = Math.atan2(-toCenter.x, -toCenter.z);

    const roofSpawns: SpawnPoint[] = [];
    const perchSpawns: SpawnPoint[] = [];
    buildings.forEach((b) => {
      if (b.isSpawn) return;
      for (let i = 0; i < 8; i++) {
        const r = tryPlace(b.index, b, 0.6, 0.6, 2.0);
        if (r) roofSpawns.push({ position: new THREE.Vector3((r.x0 + r.x1) / 2, b.roofY, (r.z0 + r.z1) / 2), building: b.index });
      }
    });
    const byHeight = [...buildings].filter((b) => !b.isSpawn).sort((p, q) => q.roofY - p.roofY);
    byHeight.slice(0, Math.max(2, Math.ceil(byHeight.length / 2))).forEach((b) => {
      // Perches on the edge facing the spawn roof.
      const dx = spawnB.cx - b.cx;
      const dz = spawnB.cz - b.cz;
      const alongX = Math.abs(dx) >= Math.abs(dz);
      for (const lat of [-0.45, 0.45]) {
        const px = alongX ? b.cx + Math.sign(dx) * (b.halfW - 1.4) : b.cx + lat * b.halfW;
        const pz = alongX ? b.cz + lat * b.halfD : b.cz + Math.sign(dz) * (b.halfD - 1.4);
        perchSpawns.push({ position: new THREE.Vector3(px, b.roofY, pz), building: b.index });
      }
    });
    const airSpawns: THREE.Vector3[] = [];
    pairs.forEach(([a, b]) => {
      airSpawns.push(new THREE.Vector3((a.cx + b.cx) / 2, 6 + rng() * 16, (a.cz + b.cz) / 2));
    });
    while (airSpawns.length < 12) {
      airSpawns.push(new THREE.Vector3(center.x + (rng() - 0.5) * 100, 6 + rng() * 16, center.z + (rng() - 0.5) * 100));
    }

    this.layout = {
      sector,
      loop,
      buildings: allBuildings,
      colliders,
      wallRunSurfaces: wallRun,
      anchors,
      playerSpawn,
      playerSpawnYaw,
      roofSpawns,
      perchSpawns,
      airSpawns,
      gatePosition: gatePos,
      gateAnchor,
      center,
    };
    return this.layout;
  }

  private clearSector(): void {
    for (const c of [...this.sectorGroup.children]) this.sectorGroup.remove(c);
    for (const d of this.sectorDisposables) d.dispose();
    this.sectorDisposables = [];
  }

  /** 4–7 towers on a jittered 3×3 lattice with validated 18–42 m gaps (within ~140 m × 140 m). */
  private layoutGrid(sector: SectorDef, rng: () => number): BuildingInfo[] {
    const spacing = 52;
    const n = sector.buildingCount;
    const neighbours = (c: number): number[] => {
      const x = c % 3;
      const z = Math.floor(c / 3);
      const out: number[] = [];
      if (x > 0) out.push(c - 1);
      if (x < 2) out.push(c + 1);
      if (z > 0) out.push(c - 3);
      if (z < 2) out.push(c + 3);
      return out;
    };
    for (let attempt = 0; attempt < 400; attempt++) {
      // Random connected growth from a corner-adjacent start cell (spawn).
      const start = [1, 3, 5, 7][Math.floor(rng() * 4)];
      const cells = [start];
      while (cells.length < n) {
        const frontier: number[] = [];
        for (const c of cells) for (const nb of neighbours(c)) if (!cells.includes(nb) && !frontier.includes(nb)) frontier.push(nb);
        cells.push(frontier[Math.floor(rng() * frontier.length)]);
      }
      const jitter = attempt < 300 ? 5 : 0;
      const out: BuildingInfo[] = cells.map((c, i) => {
        const gx = (c % 3) - 1;
        const gz = Math.floor(c / 3) - 1;
        const hw = attempt < 300 ? 10 + rng() * 5 : 12;
        const hd = attempt < 300 ? 10 + rng() * 5 : 12;
        return {
          index: i,
          cx: gx * spacing + (rng() * 2 - 1) * jitter,
          cz: gz * spacing + (rng() * 2 - 1) * jitter,
          halfW: hw,
          halfD: hd,
          roofY: 0,
          isSpawn: i === 0,
          isGateTower: false,
        };
      });
      if (!this.validateGaps(out, (a, b) => {
        const ca = cells[a.index];
        const cb = cells[b.index];
        return neighbours(ca).includes(cb);
      })) continue;
      if (!this.withinPlayArea(out)) continue;
      return this.assignHeights(out, sector, rng);
    }
    throw new Error('Sector layout generation failed');
  }

  /** Sector 5: six towers in a ring around an open shaft (boss arena). */
  private layoutRing(sector: SectorDef, rng: () => number): BuildingInfo[] {
    const n = sector.buildingCount;
    for (let attempt = 0; attempt < 200; attempt++) {
      const radius = 54 + (attempt < 150 ? rng() * 4 : 0);
      const rot = rng() * Math.PI * 2;
      const out: BuildingInfo[] = [];
      for (let i = 0; i < n; i++) {
        const a = rot + (i / n) * Math.PI * 2;
        const hw = attempt < 150 ? 10 + rng() * 3 : 11;
        const hd = attempt < 150 ? 10 + rng() * 3 : 11;
        out.push({ index: i, cx: Math.cos(a) * radius, cz: Math.sin(a) * radius, halfW: hw, halfD: hd, roofY: 0, isSpawn: i === 0, isGateTower: false });
      }
      if (!this.validateGaps(out, (a, b) => Math.abs(a.index - b.index) === 1 || Math.abs(a.index - b.index) === n - 1)) continue;
      if (!this.withinPlayArea(out)) continue;
      return this.assignHeights(out, sector, rng);
    }
    throw new Error('Ring layout generation failed');
  }

  private validateGaps(list: BuildingInfo[], isNeighbour: (a: BuildingInfo, b: BuildingInfo) => boolean): boolean {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const gap = footprintGap(list[i], list[j]);
        if (gap < LEVEL.GAP_MIN_M) return false;
        if (isNeighbour(list[i], list[j]) && gap > LEVEL.GAP_MAX_M) return false;
      }
    }
    return true;
  }

  private withinPlayArea(list: BuildingInfo[]): boolean {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const b of list) {
      minX = Math.min(minX, b.cx - b.halfW);
      maxX = Math.max(maxX, b.cx + b.halfW);
      minZ = Math.min(minZ, b.cz - b.halfD);
      maxZ = Math.max(maxZ, b.cz + b.halfD);
    }
    return maxX - minX <= LEVEL.PLAY_AREA_M && maxZ - minZ <= LEVEL.PLAY_AREA_M;
  }

  /** Spawn roof at 0 m; the sector's full height band is guaranteed to be used. */
  private assignHeights(list: BuildingInfo[], sector: SectorDef, rng: () => number): BuildingInfo[] {
    const q = (v: number): number => Math.round(v * 2) / 2;
    const others = list.slice(1);
    const heights: number[] = others.map(() => q(sector.heightMin + rng() * (sector.heightMax - sector.heightMin)));
    if (heights.length > 0) heights[0] = sector.heightMax;
    if (heights.length > 1 && sector.heightMin < 0) heights[1] = sector.heightMin;
    // Shuffle so extremes land on random towers.
    for (let i = heights.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [heights[i], heights[j]] = [heights[j], heights[i]];
    }
    return list.map((b, i) => ({ ...b, roofY: i === 0 ? 0 : heights[i - 1] }));
  }

  /**
   * The next sector's entry tower: placed 24–30 m beyond the tower farthest from spawn, on the
   * outward side first; every candidate is validated against the 18 m minimum gap to all towers.
   */
  private placeGateTower(list: BuildingInfo[], rng: () => number): BuildingInfo {
    const spawn = list[0];
    const byDist = [...list].sort(
      (p, q) => Math.hypot(q.cx - spawn.cx, q.cz - spawn.cz) - Math.hypot(p.cx - spawn.cx, p.cz - spawn.cz),
    );
    const cxAvg = list.reduce((s, b) => s + b.cx, 0) / list.length;
    const czAvg = list.reduce((s, b) => s + b.cz, 0) / list.length;
    const gap = 24 + rng() * 6;
    const half = 11;
    for (const far of byDist) {
      const ox = far.cx - cxAvg;
      const oz = far.cz - czAvg;
      // Candidate directions ordered by how "outward" they point.
      const dirs: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      dirs.sort((p, q) => q[0] * ox + q[1] * oz - (p[0] * ox + p[1] * oz));
      for (const [dx, dz] of dirs) {
        const cand: BuildingInfo = {
          index: list.length,
          cx: dx !== 0 ? far.cx + dx * (far.halfW + gap + half) : far.cx,
          cz: dz !== 0 ? far.cz + dz * (far.halfD + gap + half) : far.cz,
          halfW: half,
          halfD: half,
          roofY: Math.round((far.roofY + 6) * 2) / 2,
          isSpawn: false,
          isGateTower: true,
        };
        if (list.every((b) => footprintGap(b, cand) >= LEVEL.GAP_MIN_M)) return cand;
      }
    }
    throw new Error('Gate tower placement failed');
  }

  // =========================================================================================
  // Runtime
  // =========================================================================================
  /** Opens / closes the jade gate (pillar visibility + gate anchor usability). */
  setGateActive(active: boolean): void {
    this.uGateActive.value = active ? 1 : 0;
    this.gatePillar.visible = active;
    this.gateBeacon.visible = active;
    if (this.layout) this.layout.gateAnchor.enabled = active;
  }

  /** FLOW Rank A+: building neon emissive +25 %. */
  setNeonBoost(boost: number): void {
    this.uNeonBoost.value = 1 + boost;
  }

  /** FLOW Rank SS+: searchlights pulse with the beat (0..1). */
  setSearchlightPulse(v: number): void {
    this.uSearchPulse.value = v;
  }

  /**
   * @param simTime scaled simulation time (bullet time slows rain ripples, hologram, beacons)
   * @param cameraPos sky/cloud follow the camera
   */
  update(simTime: number, cameraPos: THREE.Vector3): void {
    this.uTime.value = simTime;
    this.sky.position.copy(cameraPos);
    this.clouds.position.set(cameraPos.x, LEVEL.CLOUD_DECK_Y, cameraPos.z);
    this.gateBeacon.rotation.y = simTime * 1.6;
  }
}

/** Steel merge: drop UVs so all members share the same attribute layout. */
function stripToPosNormal(g: THREE.BufferGeometry): THREE.BufferGeometry {
  if (g.getAttribute('uv')) g.deleteAttribute('uv');
  return g;
}
