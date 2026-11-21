/**
 * STRAND // PROTOCOL — 6A-1 per-room night lighting, shared by the tower shader and the CPU.
 *
 * Every window room (a cell of the facade atlas: one floor high, 3 m or 6 m wide) is lit or dark by an
 * integer PCG hash of (building seed, face, room column, floor). The GLSL below and the TypeScript mirror
 * compute bit-identical results, so the layout stats can report the exact distribution of the city that
 * is on screen: dark 65 % · warm bulb 20 % · cool office 13 % · cyber accent 2 %, clustered per floor
 * (tenants) and never repeating with the 12 m texture tile.
 * 7A-3: floor 0 (the solid street base: stone, shutters, steel doors) is never a lit window room.
 */
import { FACADE } from '../config/constants';

export type RoomState = 0 | 1 | 2 | 3; // dark · warm · cool · accent
export const ARCH_A = 0;
export const ARCH_B = 1;
export const ARCH_C = 2;
export const ARCH_D = 3;

const LIT_WARM = FACADE.SHARE_WARM / (1 - FACADE.SHARE_DARK);
const LIT_COOL = (FACADE.SHARE_WARM + FACADE.SHARE_COOL) / (1 - FACADE.SHARE_DARK);

export function pcg(v: number): number {
  const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
}

/** Uniform [0, 1) with 24-bit resolution (exact in float32 on the GPU). */
export function hash3(a: number, b: number, c: number): number {
  return (pcg((a >>> 0) ^ pcg((b >>> 0) ^ pcg(c >>> 0))) >>> 8) / 16777216;
}

/** Building seed (float32 vertex attribute) → integer used by every facade hash. */
export function seedInt(seed: number): number {
  return Math.floor(Math.fround(seed) * 65536);
}

/** Face key from the outward normal: +X 1 · −X 3 · +Z 2 · −Z 5. */
export function faceKey(nx: number, nz: number): number {
  return (nx > 0.5 ? 1 : 0) + (nz > 0.5 ? 2 : 0) + (nx < -0.5 ? 3 : 0) + (nz < -0.5 ? 5 : 0);
}

export function roomsPerTile(arch: number): number {
  return FACADE.ROOMS_PER_TILE[arch];
}

/** Horizontal tile offset (in rooms) so neighbouring towers never share the same window phase. */
export function roomOffset(si: number, arch: number): number {
  return si % roomsPerTile(arch);
}

/** Floor index of height y on an archetype's facade (floor 0 = ground / podium). */
export function facadeFloor(arch: number, y: number): number {
  const base = FACADE.FLOOR_BASE_M[arch];
  const yb = Math.max(y, 0) - base;
  return yb < FACADE.FLOOR_H_M ? 0 : Math.floor(yb / FACADE.FLOOR_H_M);
}

/** Bottom height of floor n ≥ 1. */
export function facadeFloorY(arch: number, n: number): number {
  return FACADE.FLOOR_BASE_M[arch] + n * FACADE.FLOOR_H_M;
}

/** Mechanical (louvre) floor test for floor index n ≥ 1 (floor 0 is the ground floor). */
export function isMachineFloor(si: number, n: number): boolean {
  if (n < 1) return false;
  const c = FACADE.MACHINE_EVERY_MIN + (Math.floor(si / 16) % FACADE.MACHINE_EVERY_SPAN);
  const off = Math.floor(si / 256) % (c - 2);
  return (n - 1 + off) % c === c - 1;
}

/** Lighting state of one room. `floorN` = floor(Y / 4), `roomI` = room column along the face (with offset). */
export function facadeRoomState(si: number, face: number, roomI: number, floorN: number): RoomState {
  if (floorN <= 0) return 0;
  const hf = hash3(floorN + 1000, face, si);
  const pLit = hf < FACADE.FLOOR_TIER_LOW ? FACADE.FLOOR_LIT_LOW : hf < FACADE.FLOOR_TIER_MID ? FACADE.FLOOR_LIT_MID : FACADE.FLOOR_LIT_HIGH;
  const h1 = hash3(roomI + 100000, floorN + 1000, si * 8 + face);
  if (h1 >= pLit) return 0;
  const h2 = hash3(roomI + 200000, floorN + 3000, si * 8 + face);
  return h2 < LIT_WARM ? 1 : h2 < LIT_COOL ? 2 : 3;
}

const f = (v: number): string => v.toFixed(6);

/** GLSL twin of the functions above (needs `#version 300 es` integer ops — WebGL2 only). */
export const GLSL_FACADE = /* glsl */ `
  uint strandPcg(uint v) {
    uint s = v * 747796405u + 2891336453u;
    uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
    return (w >> 22u) ^ w;
  }
  float strandHash(int a, int b, int c) {
    return float(strandPcg(uint(a) ^ strandPcg(uint(b) ^ strandPcg(uint(c)))) >> 8u) / 16777216.0;
  }
  int strandRoomsPerTile(int col) { return col == 2 ? ${FACADE.ROOMS_PER_TILE[2]} : ${FACADE.ROOMS_PER_TILE[0]}; }
  bool strandMachineFloor(int si, int n) {
    if (n < 1) return false;
    int c = ${FACADE.MACHINE_EVERY_MIN} + (si / 16) % ${FACADE.MACHINE_EVERY_SPAN};
    int off = (si / 256) % (c - 2);
    return (n - 1 + off) % c == c - 1;
  }
  int strandRoomState(int si, int face, int roomI, int floorN) {
    if (floorN <= 0) return 0;
    float hf = strandHash(floorN + 1000, face, si);
    float pLit = hf < ${f(FACADE.FLOOR_TIER_LOW)} ? ${f(FACADE.FLOOR_LIT_LOW)}
      : (hf < ${f(FACADE.FLOOR_TIER_MID)} ? ${f(FACADE.FLOOR_LIT_MID)} : ${f(FACADE.FLOOR_LIT_HIGH)});
    float h1 = strandHash(roomI + 100000, floorN + 1000, si * 8 + face);
    if (h1 >= pLit) return 0;
    float h2 = strandHash(roomI + 200000, floorN + 3000, si * 8 + face);
    return h2 < ${f(LIT_WARM)} ? 1 : (h2 < ${f(LIT_COOL)} ? 2 : 3);
  }
`;
