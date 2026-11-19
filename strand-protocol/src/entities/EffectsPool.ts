/**
 * STRAND // PROTOCOL — Effects pool (§6.2 Pass 1, §9.2).
 *
 * Rain: 1,800 streaks in ONE InstancedMesh. Each instance stores only a seed offset; the vertex
 * shader advects it with the (bullet-time-scaled) rain clock and wraps it inside a
 * 45 m × 30 m × 45 m box centred on the camera — zero CPU work and zero allocation per frame.
 * Streaks stretch along the relative velocity (fall velocity − camera velocity) for motion feel.
 */
import * as THREE from 'three';
import { COLORS, LIMITS, RENDER, createRng } from '../config/constants';

const _relVel = new THREE.Vector3();

export class EffectsPool {
  readonly rain: THREE.InstancedMesh;
  private readonly rainUniforms: {
    uRainTime: { value: number };
    uCamPos: { value: THREE.Vector3 };
    uBox: { value: THREE.Vector3 };
    uFall: { value: THREE.Vector3 };
    uRelVel: { value: THREE.Vector3 };
    uStreakLen: { value: number };
    uNeonReflect: { value: number };
    uCyan: { value: THREE.Color };
    uMagenta: { value: THREE.Color };
    uFogDensity: { value: number };
  };
  private rainTime = 0;

  constructor(scene: THREE.Scene) {
    const count = LIMITS.RAIN_DROPS;
    const geo = new THREE.PlaneGeometry(1, 1);
    this.rainUniforms = {
      uRainTime: { value: 0 },
      uCamPos: { value: new THREE.Vector3() },
      uBox: { value: new THREE.Vector3(LIMITS.RAIN_BOX_X, LIMITS.RAIN_BOX_Y, LIMITS.RAIN_BOX_Z) },
      uFall: { value: new THREE.Vector3(1.6, -26.0, 0.9) },
      uRelVel: { value: new THREE.Vector3(1.6, -26.0, 0.9) },
      uStreakLen: { value: 0.75 },
      uNeonReflect: { value: 0 },
      uCyan: { value: new THREE.Color(COLORS.WALLRUN_CYAN) },
      uMagenta: { value: new THREE.Color(COLORS.NEON_MAGENTA) },
      uFogDensity: { value: RENDER.FOG_DENSITY },
    };
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: this.rainUniforms,
      vertexShader: /* glsl */ `
        uniform float uRainTime;
        uniform vec3 uCamPos;
        uniform vec3 uBox;
        uniform vec3 uFall;
        uniform vec3 uRelVel;
        uniform float uStreakLen;
        varying vec2 vUv;
        varying float vDist;
        varying float vSeed;
        varying float vSide;
        void main() {
          vec3 seed = instanceMatrix[3].xyz;
          float speedVar = 0.82 + fract(seed.x * 0.618 + seed.z * 0.414) * 0.36;
          vec3 p = seed + uFall * uRainTime * speedVar;
          // Wrap into the box centred on the camera.
          p = mod(p - uCamPos + uBox * 0.5, uBox) - uBox * 0.5 + uCamPos;
          float relSpeed = length(uRelVel);
          vec3 dir = relSpeed > 1e-3 ? uRelVel / relSpeed : vec3(0.0, -1.0, 0.0);
          float len = uStreakLen * (0.6 + relSpeed / 30.0);
          vec3 toCam = normalize(cameraPosition - p);
          vec3 side = cross(dir, toCam);
          float sl = length(side);
          vSide = sl;
          side = sl > 1e-4 ? side / sl : vec3(1.0, 0.0, 0.0);
          float width = 0.012 + 0.006 * fract(seed.y * 3.7);
          vec3 wp = p + side * position.x * width * 2.0 + dir * position.y * len;
          vUv = uv;
          vDist = length(p - cameraPosition);
          vSeed = fract(seed.x * 1.31 + seed.y * 0.77 + seed.z * 2.13);
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uNeonReflect;
        uniform vec3 uCyan;
        uniform vec3 uMagenta;
        uniform float uFogDensity;
        varying vec2 vUv;
        varying float vDist;
        varying float vSeed;
        varying float vSide;
        void main() {
          float across = 1.0 - abs(vUv.x - 0.5) * 2.0;
          float along = smoothstep(0.0, 0.35, vUv.y) * (1.0 - smoothstep(0.75, 1.0, vUv.y));
          float a = across * across * along;
          // Fade drops hugging the lens and far into the fog.
          a *= smoothstep(0.4, 2.2, vDist);
          // Streaks aimed straight at the lens collapse to dots: fade them out.
          a *= smoothstep(0.15, 0.55, vSide);
          float fog = exp(-uFogDensity * uFogDensity * vDist * vDist * 4.0);
          vec3 base = vec3(0.30, 0.36, 0.46) * 0.55;
          vec3 neon = mix(uCyan, uMagenta, step(0.5, vSeed)) * 1.25;
          vec3 c = mix(base, neon, uNeonReflect * (0.35 + 0.65 * step(0.4, vSeed)));
          gl_FragColor = vec4(c * a * fog, 1.0);
        }
      `,
    });
    this.rain = new THREE.InstancedMesh(geo, mat, count);
    this.rain.name = 'Rain';
    this.rain.frustumCulled = false;
    this.rain.renderOrder = 20;
    const rng = createRng(0x7a1);
    const m = new THREE.Matrix4();
    for (let i = 0; i < count; i++) {
      m.makeTranslation(rng() * LIMITS.RAIN_BOX_X, rng() * LIMITS.RAIN_BOX_Y, rng() * LIMITS.RAIN_BOX_Z);
      this.rain.setMatrixAt(i, m);
    }
    this.rain.instanceMatrix.needsUpdate = true;
    scene.add(this.rain);
  }

  /** FLOW S+: raindrops strongly reflect cyan / magenta neon (0..1). */
  setRainNeonReflect(v: number): void {
    this.rainUniforms.uNeonReflect.value = v;
  }

  /**
   * @param simDt scaled simulation delta (bullet time slows the rain to 0.25×)
   * @param cameraPos current camera world position
   * @param cameraVel current camera world velocity (m/s, simulation space)
   */
  update(simDt: number, cameraPos: THREE.Vector3, cameraVel: THREE.Vector3): void {
    this.rainTime += simDt;
    // Keep float precision in the shader: rebase the rain clock once per hour (one imperceptible reshuffle).
    if (this.rainTime > 3600) this.rainTime -= 3600;
    const u = this.rainUniforms;
    u.uRainTime.value = this.rainTime;
    u.uCamPos.value.copy(cameraPos);
    _relVel.copy(u.uFall.value).sub(cameraVel);
    u.uRelVel.value.copy(_relVel);
  }
}
