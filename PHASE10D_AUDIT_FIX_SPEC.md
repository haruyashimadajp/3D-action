# STRAND // PROTOCOL — Phase 10D Audit Fix Specification (`10D-Fix`)

**Target Implementer**: Claude (TypeScript / Three.js r187 / WebGL2)  
**Target Codebase**: `strand-protocol/` (on top of `d8fb7d9`)  
**Draw-Call Budget**: Strictly **`+0` net draw calls** (Sector 4 HIGH full combat remains `<= 84` calls, hard cap `<= 120`).  
**Zero Per-Frame Heap Allocations & Zero Mouse-Latency Regression.**

---

## Bounded File List
* `strand-protocol/src/world/CityFurniture.ts`
* `strand-protocol/src/world/CityAtmosphere.ts`
* `strand-protocol/src/world/CityBuilder.ts`
* `strand-protocol/src/entities/EnemyManager.ts`
* `strand-protocol/tests/phase10d.test.ts`

---

## FIX-1 (Must-Fix): Ramen Cart Open-Frame Sneeze Guard, Top-Capped Bottles & Solid Undersides (`CityFurniture.ts`, `+0` Calls, `<= 380` Tris)
* **Live Screenshot Defect (`audit10d_s1_ramen.png`, `audit10d_s1_ramen2.png`)**: `CityFurniture.ts:214` (`plane(1.0, 0.35, 0.38, 1.16, 0.36, [-0.3, 0, 0]), 5`) renders as an **opaque pitch-black slab** floating `+5.3 cm` above the `0.94 m` stainless counter with zero mounting posts, hiding the bowls behind it and vanishing from behind. Also the 3 condiment bottles (`L222`) are open hollow tubes (`caps = false`) and elevated boxes (`L208` counter lip, `L230` marquee backing, `L270` bus-shelter bench) omit their `-Y` underside (`bottom = false`).
* **Exact Fix & Triangle Budget Math (`ramenCart` starts at `379` tris; hard cap `<= 380`!)**:
  1. Remove the opaque black `plane(...)` at **`CityFurniture.ts:214`** (`-2` tris). Replace with a clean **grounded open-frame stainless sneeze-guard rail** flush on the counter (`y = 0.94`):
     - `2` slender `3`-sided upright posts (`rod(..., r = 0.012, 3)` at `x = -0.05` and `x = +0.85`, `z = +0.34`, `y = 0.94 -> 1.24`, `aPart = 1`, `+12` tris).
     - `1` slim angled stainless top hood bar (`box(0.94, 0.025, 0.14, 0.40, 1.24, 0.28, [0.22, 0, 0], true)`, `aPart = 1`, `+12` tris), leaving the view completely open so all 3 ceramic ramen bowls and condiment bottles are visible from front and back!
  2. Cap ONLY the tops of the 3 condiment bottles (`CityFurniture.ts:222`) with `4`-sided `CircleGeometry(0.03, 4)` discs rotated `-Math.PI / 2` around X at `y = 1.14` (`+12` tris total — avoids wasting `+12` tris on invisible bottom caps!).
  3. Set `bottom = true` on elevated boxes visible from crouch/slide angles: `ramenCart` counter lip (`L208`, `+2` tris), `ramenCart` marquee backing (`L230`, `+2` tris), and `busShelter` bench seat (`L270`, `+2` tris → `busShelter` `284 -> 286 <= 380` tris).
  4. Reclaim `>= 46` tris cleanly on `ramenCart` (zero visual downgrade):
     - Use `5`-sided casters instead of `6`-sided (`L204`: `-16` tris; update caster `y = 0.09 * Math.cos(Math.PI / 5)` & rotation so flat bottom rests on `y = 0` with `|min.y| <= 0.02`!).
     - Use `3`-sided roof posts (`L224`: `-8` tris) and `3`-sided push-handle bar/struts (`L243-244`: `-6` tris).
     - Use `3` corrugated awning top ribs (`x = -0.76, 0, +0.76`, `L226-229`: `-12` tris) and `2` horizontal timber skirt slats (`L207`: `-4` tris).
     - Net `ramenCart` total: `379 - 2 + 12 + 12 + 12 + 4 - 16 - 8 - 6 - 12 - 4 = 371 tris <= 380`!

---

## FIX-2 (Must-Fix): Keep Wall Exhaust Fans Strictly Off Glazed 2F+ Windows (`CityBuilder.ts`, `+0` Calls)
* **Live Screenshot Defect (`audit10d_s1_fan.png`, `audit10d_s1_coupe.png`)**: Wall fans mounted at `y = 4.95–5.5 m` and `floorTopY + 1.7–2.3 m` sit directly over glazed 2F–3F `Towers` windows! Meanwhile, opaque `1F` `ALLEY_INFRA` walls were pushed up to `4.95–5.5 m`, starving Sectors 3 & 5 of wall fans (`fanW = 9` in S3, `3` in S5).
* **Exact Fix**:
  1. **Export `readonly seed: number` on `BuildingInfo` (`CityBuilder.ts:156-179`)** so unit tests can independently verify `isMachineFloor(seedInt(b.seed), floor)` on every building across all 5 sectors × Loops `0..2`.
  2. **1F Opaque Band (`y = 2.65–3.35 m`)**: Allow `1F` wall fans at `y = 2.65 + p10dRng() * 0.70` on `CYBER_APARTMENT`, `ALLEY_INFRA` (explicitly clearing the `ALLEY_INFRA` transformer box `y ∈ [1.2, 2.6]` by `>= 0.55 m` margin plus `groundDoors` / `groundPiers` / `socketProps`), and non-awning bays of other programs.
  3. **Upper Floors (`y >= 4.0 m`) — Strictly Mechanical Floors Only**:
     - Because `MACHINE_EVERY_MIN = 7, MACHINE_EVERY_SPAN = 3`, `isMachineFloor(si, floor)` is always `false` for `floor = 1, 2` — scan **`floor ∈ [3, 9]`** (capped strictly by `floorTop <= Math.min(span.y1, b.roofY) - 0.55`) using the exact `facadeFloor` / `facadeFloorY` / `isMachineFloor` helpers already imported at `CityBuilder.ts:43` (`FacadeLighting.ts:53-57`):
       - Require `isMachineFloor(seedInt(b.seed), floor) === true`.
       - Place fan center `y` inside `[facadeFloorY(b.arch, floor) + 1.2, facadeFloorY(b.arch, floor) + FACADE.FLOOR_H_M - 1.2]` so the entire `±0.55 m` housing stays 100% inside the opaque mechanical floor band (never overlapping an adjacent glazed storey!).

---

## FIX-3 (Must-Fix): Enable Alley Noren (`norBay >= 4`) & Collapse Unused Hanger/Standoff Rods via `aEnv.w` (`CityAtmosphere.ts`, `CityBuilder.ts`, `+0` Calls)
* **Quantitative & Visual Defect**:
  - Across all 15 `S1–S5 × L0–L2` builds, `norBay === 0` (`CityBuilder.ts:7724` excludes `ALLEY_INFRA` and requires `>= 2` `groundPiers`).
  - `envNoren()` (`CityAtmosphere.ts:474-477`) bakes BOTH `+0.14 m` top awning hangers AND `-0.22 m` rear wall standoffs unconditionally into `v1`, so **100% of hanging awning noren have two dark rods sticking `22 cm` backward into empty air**!
* **Exact Fix**:
  1. **Zero Floating Rods & Safe Shader Mode Guard (`CityAtmosphere.ts:474-477, 566-593, 646-658`)**:
     - Tag the 2 vertical top awning hangers (`L475`) with `aAnim.x = 5` (awning-only) and the 2 horizontal rear wall standoffs (`L476`) with `aAnim.x = 6` (wall-bay-only).
     - Tighten BOTH hologram rotation guards (`L573` and `L580`) from `else if (eMode > 2.5)` to **`else if (eMode == 3.0 || eMode == 4.0)`** so modes `5` and `6` never enter the hologram rotation block!
     - Write `host === 'BAY' ? 1 : 0` into **`aEnv.w`** in `AnimatedEnvKit.add(...)` (`L652`).
     - In `#include <begin_vertex>` (`L589`):
       ```glsl
       if (abs(aVar - aEnv.x) > 0.5 || (eMode == 5.0 && aEnv.w > 0.5) || (eMode == 6.0 && aEnv.w < 0.5)) transformed = vec3(0.0);
       ```
  2. **Populate Alley Noren Without Slot Starvation (`CityBuilder.ts:7717-7754`)**:
     - Run a dedicated **`BAY` alley noren pass BEFORE the `AWNING` pass** (capped at `24` alley noren/sector so `env.count` always reserves ample slots before awning noren fill up to `212`!).
     - Allow non-run `g.alley` faces (including `ALLEY_INFRA` bays clear of transformer boxes `y ∈ [1.2, 2.6]`, `groundDoors`, `doorClearZones`, `signs`, `colliders`, and `lampPoles`).
     - When `piersHere.length >= 2`, iterate pier bays; when `piersHere.length < 2` on an alley span (`span.a1 - span.a0 >= 3.2 m`), step candidate centers every `4.0 m` (`span.a0 + 1.6 .. span.a1 - 1.6`) with `yRod = 3.05 m` (`bottom = 2.37 m >= 2.20 m`) and `dRod = 0.28 m` (rear standoffs terminate flush at `d = 0.00 m`). Target `>= 4` `BAY` alley noren in every Sector 1–4 across Loops `0..2`.

---

## FIX-4 (Must-Fix — Claude's Open Issue): Highway Traffic Clearance for Spawns, Patrols & Active Enemies (`CityAtmosphere.ts`, `CityBuilder.ts`, `EnemyManager.ts`, `+0` Calls)
* **Verified Defects**:
  - Sector 3 Loops `0, 1, 2` currently place a `highwaySpawn` at `(-6.5, 10.0)` inside the perpendicular highway's outer traffic lane!
  - `buildTrafficLanes(...)` is currently called at `CityBuilder.ts:8077` (928 lines AFTER `highwaySpawns` at `L7148-7155`).
  - Highway enemy patrols (`EnemyManager.buildPatrol()`, `L2006-2024`) and direct combat/lunge/orbit movement (`EnemyManager.walk()`, `L2616`, called directly at `L2801-2803, 2824, 2902, 2933-2934`) can step into moving traffic lanes!
* **Exact Fix**:
  1. Export a pure, allocation-free helper in **`src/world/CityAtmosphere.ts`**:
     ```ts
     export function inTrafficLane(lanes: readonly TrafficLane[], x: number, z: number, margin = 0.85): boolean
     ```
     - Linear lane (`!ln.ring`): `Math.abs((ln.axis === 'x' ? z : x) - ln.lat) < TRAFFIC_BOUNDS.w / 2 + margin`.
     - Ring lane (`ln.ring`): `dx = Math.max(0, Math.abs(x) - (ln.R - ln.r))`, `dz = Math.max(0, Math.abs(z) - (ln.R - ln.r))`, `off = (dx > 0 && dz > 0) ? Math.hypot(dx, dz) - ln.r : Math.max(Math.abs(x), Math.abs(z)) - ln.R`; returns `Math.abs(off) < TRAFFIC_BOUNDS.w / 2 + margin`.
     - Also export pure **`clampOutOfTrafficLanes(lanes: readonly TrafficLane[], pos: THREE.Vector3, margin = 0.85): void`** that pushes any highway-deck `(pos.x, pos.z)` strictly inward toward the highway centerline / `27 m` ring median when `inTrafficLane(...)` is true (zero allocations!).
  2. **Hoist `buildTrafficLanes(...)` BEFORE `highwaySpawns` (`CityBuilder.ts:7148`)** (using the exact same RNG seed `0x10d1 + sector.index * 71 + loop * 433`), filter `highwaySpawns` with `!inTrafficLane(trafficLanes, p.x, p.z, 0.85)` (fixing Sector 3's `(-6.5, 10.0)` spawn!), and export **`readonly trafficLanes: readonly TrafficLane[]`** on `SectorLayout`.
  3. **Patrol Clearance (`EnemyManager.buildPatrol()`, `L2006-2024`)**: When `Math.abs(_v5.y - LEVEL.HIGHWAY_DECK_Y) < 2.0 && L?.trafficLanes.length`, reject any candidate waypoint `_v3` OR intermediate leg sample `_v4` (`k = 1..3`) where `inTrafficLane(L.trafficLanes, p.x, p.z, 0.85)` is true!
  4. **All Active Movement Clearance (`EnemyManager.walk()`, `L2634`)**: Right after `this.physics.movePlayer(...)` inside **`EnemyManager.walk()`** (which covers BOTH `moveToGoal()` AND all 6 direct combat/retreat/lunge/orbit callers at `L2801-2934`!), if `Math.abs(e.pos.y - LEVEL.HIGHWAY_DECK_Y) < 2.0 && this.layout?.trafficLanes.length`: call `clampOutOfTrafficLanes(this.layout.trafficLanes, e.pos, 0.85)` so no highway enemy ever gets ghosted by moving traffic!

---

## FIX-5 (Should-Fix Visual Polish Bundle, `+0` Calls)
1. **Restore `v1` Cafe Parasol Wet Fresnel Sheen (`CityBuilder.ts:2256-2257`)**: Inside `createFurnishingsMaterial()` `<emissivemap_fragment>`, directly under `else if (kv == 1.0)`:
   ```glsl
   else if (kp == 1.0) {
     float fr = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 4.0);
     totalEmissiveRadiance = vec3(0.22, 0.26, 0.34) * fr * 0.5;
   }
   ```
2. **Slightly Plumper Ramen Steam Staying Strictly Below Awning (`CityBuilder.ts:8017`)**: Because `createSteam()` (`CityBuilder.ts:3349-3356`) swells `size` to `2.0 × aSteam.y` (`top(t) = base.y + t * rise + 0.85 * aSteam.y * (0.7 + t * 1.3)`), bump `ramenSteam` from `size 0.25..0.30 / rise 0.60..0.70` to **`size 0.30..0.34` / `rise 0.62..0.68`** — visibly fuller boiler mist while keeping `top(0.90) <= 2.20 m` and `center(1.0) <= 1.97 m` strictly below the `2.245 m` awning underside!
3. **Trim Sector 4 Market Stall Upper Sign Bloom (`CityBuilder.ts:6854`)**: Lower stall upper neon sign emissive from `1.6` → **`1.15`** so the recessed alcove, shelf, and warm under-valence light read crisply without bloom washout.

*(Note: Coupe dive-plane winglets at `CityVehicles.ts:350` were verified already strictly coplanar with antiparallel normals `[±1, 0, 0]` in `'XYZ'` — leave `CityVehicles.ts` untouched!)*

---

## Mandatory Regression Tests (Add to `strand-protocol/tests/phase10d.test.ts`)
1. **FIX-1**: Assert `ramenCart` has ZERO `aPart === 5` opaque sneeze-guard vertices, `kitVariantTris(KIT_VARIANT.RAMEN_CART) <= 380`, `kitVariantTris(KIT_VARIANT.BUS_SHELTER) <= 380`, and `|bbox.min.y| <= 0.02` for both.
2. **FIX-2**: Across all 5 sectors × Loops `0..2`, assert EVERY wall-mounted `ENV_VARIANT.FAN` with `y >= 4.0` lies on a floor `f` where `isMachineFloor(seedInt(b.seed), f) === true` AND `[y - 0.55, y + 0.55]` fits inside `[facadeFloorY(b.arch, f), facadeFloorY(b.arch, f) + FACADE.FLOOR_H_M]` (zero fans on glazed office/residential windows!).
3. **FIX-3**: Across Sectors 1–4 × Loops `0..2`, assert `BAY` alley noren count `>= 4`, assert `aEnv.w === 0` for every `AWNING` noren and `1` for every `BAY` noren, and assert `AnimatedEnvKit` vertex shader uses `eMode == 3.0 || eMode == 4.0` (NOT `eMode > 2.5`) and collapses `eMode == 5.0` when `aEnv.w > 0.5` and `eMode == 6.0` when `aEnv.w < 0.5`.
4. **FIX-4**: Across all 5 sectors × Loops `0..2`, assert ZERO `highwaySpawns` satisfy `inTrafficLane(L.trafficLanes, p.x, p.z, 0.85)`, and verify `clampOutOfTrafficLanes()` pushes highway-deck points cleanly outside `inTrafficLane(..., 0.85)` toward the highway centerline / `27 m` ring median.
