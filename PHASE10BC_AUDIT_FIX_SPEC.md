# STRAND // PROTOCOL — Phase 10B + 10C Audit Fix Patch Specification (`10BC-Fix`)

**Target Implementer**: Claude (TypeScript / Three.js / WebGL2)  
**Base Branch & Commit**: `origin/claude/loving-bohr-lb0uj2` @ `d9b1c11`  
**Scope**: Targeted geometry, normal, collider, placement, and loop-parity fixes identified during the Director audit of Phase 10B (`22d45dd`), 10B-2 (`22dfddc`), and 10C (`d9b1c11`).  
**Hard Constraints**:
1. **`+0` net draw calls**: Do NOT add any new mesh or `InstancedMesh`. Sector 4 draw calls must stay `<= 120` (expected `~82`).
2. **Zero regressions**: All existing 86 unit tests + new regression tests MUST pass (`npm run build && npm test`), and all `HERO_3D_MODELING_SPEC.md` §6 budgets (`cars <= 1,100` tris, `vending/lamp <= 450` tris, `kit variants <= 380` tris, `|min.y| <= 0.02`) MUST still hold.
3. **100% English in-world signage**: Zero Japanese characters added to textures or 3D world strings.
4. **Files touched (bounded)**: Only `src/world/CityBuilder.ts`, `src/world/BuildingGrammar.ts`, `src/world/CityVehicles.ts`, `src/world/CityFurniture.ts`, `tests/phase10b.test.ts`, `tests/phase10b2.test.ts`, `tests/phase10c.test.ts`, and `PHASE10_PROGRESS.md`.

---

## PART A — Phase 10B & 10B-2 Fixes

### FIX-1 (`10B-1`): Ground Covered-Market Ridge Trestles (`src/world/CityBuilder.ts` ~L6576–6596)
- **Root Cause**: Each market stall awning ends at `front + 0.7`, leaving a `1.40 m` (S2) to `2.65 m` (S4) open gap to aisle center `mid = S / 2`. The two steel ridge king-posts at `a ∈ [sA0 + 0.2, sA1 - 0.2]` (`y = 3.05..4.25`, depth `mid ± 0.07`) have no beam underneath and float in mid-air at `Y = 3.05 m`.
- **Fix**:
  1. On both stall sides (`sg = 1, -1`), ensure aisle-edge steel posts (`y = 0..yOut`, depth `front + 0.45..front + 0.57`) always include exact end posts at `sA0 + 0.2` and `sA1 - 0.2` (in addition to intermediate posts every `~6 m`).
  2. At each trestle `a ∈ [sA0 + 0.2, sA1 - 0.2]`, add a horizontal steel cross-tie beam spanning from aisle post to aisle post across the aisle:
     - `fC.bx(a - 0.07, a + 0.07, yOut - 0.08, yOut + 0.06, front + 0.45, S - front - 0.45)`
     - Keep the central king-post (`y = yOut..4.25, mid ± 0.07`) resting directly on this cross-tie beam, and add twin diagonal steel braces (`beam(..., 0.07)`) from `(a, yOut, front + 0.51)` and `(a, yOut, S - front - 0.51)` up to `(a, 4.28, mid)`.
- **Acceptance**: Zero floating steel vertices in market trestles; continuous load path from ridge beam (`y = 4.32`) → king-post & braces → cross-tie (`y = 3.05`) → aisle posts (`y = 0`).

### FIX-2 (`10B-3`): Ground `CYLINDER_RING_TOWER` Roof Grapple Anchor Stubs (`src/world/CityBuilder.ts` ~L4848–4857)
- **Root Cause**: Diagonal roof grapple anchor stubs start at `y = pTop = b.roofY + 1.14 m` at `b.cx ± (b.halfW - 0.16), b.cz ± (b.halfD - 0.16)`. On `CYLINDER_RING_TOWER`, `halfW = halfD = 0.68 * r`, placing the stub base `0.33–0.39 m` INSIDE the circular parapet `[r - 0.20, r + 0.12]` so the steel stub floats `1.14 m` above the roof deck.
- **Fix**:
  - When `b.plan.cyl` is present (`r = b.plan.cyl.r`), compute `rMid = r + 0.12 - GRAMMAR.PARAPET_T * 0.5` and place each diagonal corner's `base` directly on the circular parapet midline:
    - `ux = sx / Math.SQRT2`, `uz = sz / Math.SQRT2`
    - `base = (cx + ux * rMid, pTop, cz + uz * rMid)`
    - `ex = cx + ux * (rMid + 0.85)`, `ez = cz + uz * (rMid + 0.85)`
  - For non-cylinder roofs (`SLANT_CORP_TOWER`, `TWIN_ARCH_GATE`, etc.): verify whether the chosen corner sits on a parapet; if a corner lies on an `open` edge without a parapet, extend the vertical stub beam down to `b.roofY` so it never floats.

### FIX-3 (`10B-3`): Seal Hollow `SLANT_CORP_TOWER` Sloped Crown Sides (`src/world/CityBuilder.ts` ~L4755–4770)
- **Root Cause**: The `7.5 m`-tall `slopedPrism` crown cap has only a `0.5 m`-thick `rampCollider` on top and a `0.4 m` back-wall collider. Both triangular sides (`l0`, `l1`) are physically open, allowing players to grapple/jump straight inside the hollow prism.
- **Fix**:
  - Beneath the `rampCollider`, add **3 stepped solid `BUILDING` box colliders** filling the prism interior along `sl.a0 → sl.a1`:
    - Bands `(t0, t1) ∈ [(0.15, 0.45), (0.45, 0.75), (0.75, 1.0)]` where `a(t) = sl.a0 + (sl.a1 - sl.a0) * t`.
    - Each band spans full lateral width `[sl.l0, sl.l1]`, along `[min(a(t0), a(t1)), max(a(t0), a(t1))]`, and height `[sl.y0, sl.y0 + sl.h * t0 - 0.05]`.
    - Because each box top stays strictly below the sloped surface (`y(t) = sl.y0 + sl.h * t`), walking up the ramp remains 100% smooth while lateral entry into the prism is physically blocked.

### FIX-4 (`10B-3` / `10B-4`): Guarantee Megastructure Quotas Across Endless Loops (`loop >= 1`) (`src/world/BuildingGrammar.ts` ~L398–452, `src/world/CityBuilder.ts` ~L4287–4328)
- **Root Cause**: `phase10b.test.ts` only tested `loop = 0`. In `loop = 1, 2`, S5 drops `SLANT_CORP_TOWER` from `4 → 2` and S4 Loop 2 drops `CYLINDER_RING_TOWER` from `2 → 1` because `assignMassings()` `take()` only converts `ARCH_A` towers whose current massing exceeds `floorOf()`.
- **Fix**:
  1. In `CityBuilder.ts` archetype assignment (~L4292–4296), when `sector.identity?.megastructures` specifies quotas, prefer assigning `ARCH_A` to tall lots that satisfy `CYLINDER_RING_TOWER` / `TWIN_ARCH_GATE` / `SLANT_CORP_TOWER` eligibility (wide non-bridged lots) before arbitrary ties.
  2. In `BuildingGrammar.ts` `assignMassings()` (~L446–450), if a megastructure quota `want` is not yet satisfied after the primary `take()` pass, run a fallback pass that allows taking any eligible non-megastructure `ARCH_A` tower whose base massing count exceeds `mins[k] ?? 0` (i.e., respecting explicit sector `minMassings` while allowing generic base massings like `STEPPED_SETBACK` / `PODIUM_OFFSET` to yield to required megastructures).
- **Acceptance**: Every sector `1..5` meets 100% of its `sector.identity.megastructures` quotas across `loop = 0, 1, 2`.

### FIX-5 (`10B-2`): Sync `groundDoorFit()` With Clamped `door.half` (`src/world/BuildingGrammar.ts` ~L1170–1189, `src/world/CityBuilder.ts` ~L5887)
- **Root Cause**: When a narrow `CAPSULE_HOTEL` bay omits its portal pillars (`!fits(w / 2 + 0.47)`), `groundDoorFit()` does not check `door.half` and would still place the `WALL_SIDE` socket at `d = 0.82 m` (floating in mid-air). Also `ALLEY_INFRA` `WALL_HIGH` at `a - w / 2 - 0.5` is not clamped to the bay piers.
- **Fix**:
  - Pass `door` (including `half?: number`) to `groundDoorFit()`.
  - Use the hotel pillar-front socket (`d = (run ? PIER_D_RUN_M : 0.8) + 0.02`) ONLY when `program === 'CAPSULE_HOTEL' && (door.half === undefined || door.half >= w / 2 + 0.47 - 1e-6)`; otherwise fall back to the standard wall-flush `sideLo..sideHi` socket (`d = 0.02`).
  - Clamp `ALLEY_INFRA` `high.a` within `[bay.a0 + 0.22, bay.a1 - 0.22]` when `bay` is provided (returning `null` if the bay cannot clear the door lamp + piers).

---

## PART B — Phase 10C Fixes

### FIX-6 (`10C-3`): Fix 90° Rotation on `CYBER_EATERY` Storefront Lantern Strings (`src/world/CityBuilder.ts` ~L7257)
- **Root Cause**: `lanternString` runs along local `+X`. On a building face, `span.ax` is the wall NORMAL (`'x'` means the facade runs along `Z`, `'z'` means the facade runs along `X`), opposite to `alleyRec.axis` (gap axis). Line 7257 used `span.ax === 'x' ? 0 : -Math.PI / 2`, rotating 100% of eatery lantern strings **perpendicular to the facade** so they pierce `2 m` straight into building interiors and miss their wall hooks!
- **Fix**:
  - Change line 7257 from `const yaw = span.ax === 'x' ? 0 : -Math.PI / 2;` to **`const yaw = span.ax === 'x' ? -Math.PI / 2 : 0;`**.
  - Keep alley lantern strings (L7312) unchanged (`al.axis === 'x' ? 0 : -Math.PI / 2` is already correct).
- **Acceptance**: Zero `StreetFurnishingsKit` lantern-string endpoints penetrate any `BUILDING` collider across all 5 sectors (loops 0..2), and every eatery string connects end-to-end between its two wall hooks (`sa0`, `sa1`).

### FIX-7 (`10C-3`): Expose Curb LED Guide Bars Out of Concrete Curbs (`src/world/CityBuilder.ts` ~L7032–7052)
- **Root Cause**: Concrete curbs (`L3779`) occupy lateral `[lh, lh + 0.16]` and height `y = [0.00, 0.12]`. Curb LEDs (`L7042, L7047`) were placed at `lh + 0.13 ± 0.06` (`[lh + 0.07, lh + 0.19]`) and `y = 0.04 ± 0.0175` (`[0.0225, 0.0575]`) — completely buried `7 cm` behind the road-facing curb face and `6.25 cm` below the curb top!
- **Fix**:
  - Mount each curb LED bar along the **upper road-facing lip of the concrete curb**, proud of BOTH the gutter face (`lh`) and top face (`0.12`):
    - `const l = st.coord + side * (lh + 0.01);` (spans `[lh - 0.015, lh + 0.035]`, sticking `1.5 cm` proud toward the wet asphalt gutter!)
    - Height: `0.04 m` centered at `y = 0.115` (`y ∈ [0.095, 0.135]`, sticking `1.5 cm` proud above the `0.12 m` curb top so it reads crisply from both road and sidewalk!).
    - Width across curb: `0.05 m`, length along avenue: `1.8 m`.
  - Keep luminance `0.95` and color cycle `CURB_LED = [0x20d8ff, 0xffe0a8, 0xff3050]`.

### FIX-8 (`10C-1`): Fix Hero Vehicle Wheel Barrel Normals & Pickup/Van Glass Alignment (`src/world/CityVehicles.ts`)
1. **Deep-Dish Alloy Wheel Rim Barrel Back-Face Culling (`L242`)**:
   - Reverse lathe point order from `[[0.62 * R, hw * 0.25], [0.62 * R, hw * 0.92]]` to **`[[0.62 * R, hw * 0.92], [0.62 * R, hw * 0.25]]`**.
   - Normals now point inward toward the wheel hub (`avg radial dot = -1.0`), making the recessed metallic barrel visible from outside under `FrontSide` rendering.
2. **Pickup Front Windshield Slope Angle (`L368`)**:
   - Front cab slope runs `(z = 0.95, y = 1.20) → (z = 0.50, y = 1.84)`; tilt angle from vertical is `-Math.atan2(0.45, 0.64) ≈ -0.613 rad` (previous `-0.97` was the complementary angle, burying the top `-18.3 cm` inside the cab and poking the bottom `+15.1 cm` out).
   - Replace L368 with: `tag(L, plane(1.52, 0.64, 0, 1.52, 0.745, [-0.613, 0, 0]), 1);` (flush `+2.0 cm` proud across the full cab front slope).
3. **Pickup Side Windows Orientation (`L371`)**:
   - Cab upper flank slopes `(x = 1.045, y = 1.21) → (x = 0.81, y = 1.81)` (`theta = Math.atan2(0.235, 0.60) ≈ 0.373 rad`, outward normal `(sx * 0.931, 0.365, 0)`). Previous `'XYZ'` Euler `[0, sx * Math.PI / 2, sx * -0.3]` rolled the vertical pane diagonally so it poked `4.6 cm` above the roof.
   - Replace L371 by building `new THREE.PlaneGeometry(0.84, 0.48)` rotated **first** `rotateX(-0.373)`, **then** `rotateY(sx * Math.PI / 2)`, **then** `translate(sx * 0.945, 1.52, 0.02)` (or add a `placeYXZ` helper using `Euler(-0.373, sx * Math.PI / 2, 0, 'YXZ')`). Every vertex now lies `+2.0 cm` proud of the sloped cab flank with `max.y ≈ 1.74 < 1.84`.
4. **Armored Van Slit Windshield Slope Angle (`L421`)**:
   - Van front armor slope runs `(z = 1.95, y = 1.18) → (z = 1.45, y = 2.08)`; tilt angle from vertical is `-Math.atan2(0.50, 0.90) ≈ -0.507 rad` (previous `-1.05` buried the top `-10.3 cm` inside the hull).
   - Replace L421 with: `tag(L, plane(1.36, 0.34, 0, 1.64, 1.715, [-0.507, 0, 0]), 1);` (flush `+2.1 cm` proud beneath the overhanging steel visor brow).

### FIX-9 (`10C-3`): Eliminate Floating Banner Neon Trim on Odd Street Lamps (`src/world/CityFurniture.ts` ~L123–127, `src/world/CityBuilder.ts` ~L2068–2089)
- **Root Cause**: `createLampMaterial()` collapses `aPart > 4.5` on odd instances (`(gl_InstanceID & 1) == 1`), hiding the flag cloth (`aPart = 5`) while leaving the flag's bottom neon trim (`aPart = 2` at `y = 3.42, x = 0.14..0.56`) floating in empty air `20 cm` above the lower banner arm on 50% of all lamps.
- **Fix**:
  - In `buildLampGeometry()` (`CityFurniture.ts`):
    - Tag the twin banner arms (`y = 3.2, 4.4`) as **`aPart = 7`** (dark steel, collapses on odd poles).
    - Stretch flag cloth (`aPart = 5`) cleanly from arm to arm: `h = 1.14`, center `y = 3.81` (`y ∈ [3.24, 4.38]`, zero gap to the arms at `3.20` and `4.40`).
    - Tag the banner bottom neon trim bar as **`aPart = 6`** at `y = 3.23` (attached flush along the bottom edge of the flag/arm, collapses on odd poles along with `aPart = 5` and `7` since `aPart > 4.5`).
    - Keep the pole accent collar ring (`cyl(..., 3.2, 0)`) as `aPart = 2` (visible on all poles).
  - In `createLampMaterial()` (`CityBuilder.ts`):
    - Vertex shader keeps `if (aPart > 4.5 && (gl_InstanceID & 1) == 1) transformed = vec3(0.0);` (now collapses flag `5`, banner trim `6`, and banner arms `7` together cleanly!).
    - Fragment shader: emit `vTint * NEON_BLOOM.LAMP_RING` for `p == 2.0 || p == 6.0`; `vTint * 0.32` for `p == 5.0`; `vec3(0.0)` for `p == 0.0 || p == 7.0`.

### FIX-10 (`10C-2`): Fix Adjacent Vending Kiosk Overlap & Collider Height (`src/world/CityBuilder.ts` ~L3670–3678, ~L6502–6510)
- **Root Cause**: The 10C-2 hero vending kiosk is `1.14 m` wide (with rubber bumpers) and `2.05 m` tall, but building-side vending rows still step by `k * 1.05` (causing 56 overlapping kiosk pairs in Loop 0!) and use a `1.9 m` collider.
- **Fix**:
  - Change L6505–6506 stride from `k * 1.05` → **`k * 1.20`** (`6 cm` clean air gap between adjacent kiosks), and check `!blocksDoor(x, z, 0.60)`.
  - Change L3675 collider top from `1.9 * scale` → **`2.05 * scale`**.

### FIX-11 (`10C-3`): Contain Corrugated Shack Exterior AC Inside Checked Footprint (`src/world/CityBuilder.ts` ~L7120, ~L7159–7160)
- **Fix**: Tuck the exterior AC box to `sideL = cLat + hL + 0.28` with dimensions `0.50 × 0.48 × 0.55` (outer reach `hL + 0.53 m`), and expand `fp` along `la` by `0.58 m` on the `+la` side so `fp` always covers the AC during roof-plate, upper-box, and `roofRects` collision checks.

### FIX-12 (`10C-3`): Scope `gantryAt` Spacing Check Per Street (`src/world/CityBuilder.ts` ~L7171–7185)
- **Fix**: Declare `const gantryAt: number[] = [];` inside `for (const si of gantryOrder)` (or key by street index) so X-axis streets and Z-axis streets never compare coordinates across orthogonal axes.

### FIX-13 (`10C-2` / `10C-3` + Doc Sync): Lamp `aAo` + City Lights on Close-Up Metal & Progress Doc Sync
- In `createLampMaterial()` (`CityBuilder.ts` ~L2068): bind `attribute float aAo;` → `diffuseColor.rgb *= vAoL;` and call `this.injectCityLights(shader);`.
- In `createVendingMaterial()` (`CityBuilder.ts` ~L2096): call `this.injectCityLights(shader);`.
- Update `PHASE10_PROGRESS.md`: record actual commit hashes (`bee4630`, `22d45dd`, `22dfddc`, `d9b1c11`, and this `10BC-Fix` commit), fix the stale `61 tests` line in the bottom verification section, and confirm `10D` as the next step.

---

## PART C — Mandatory New Unit Tests (Regression Guards)

Add unit tests to `tests/phase10b.test.ts`, `tests/phase10b2.test.ts`, and `tests/phase10c.test.ts` asserting:
1. **`10B-1` Market trestles**: Every market lot's ridge trestle has horizontal tie-beam support spanning the aisle to the aisle-edge posts (no floating gap between awning edge and `mid`).
2. **`10B-3` Cylinder anchor stubs & Slant prism solidity**:
   - Every `CYLINDER_RING_TOWER` roof `BUILDING_CORNER` anchor stub base sits on the circular parapet radius `[r - 0.20, r + 0.12]`.
   - Every `SLANT_CORP_TOWER` sloped crown interior blocks lateral `PhysicsWorld.lineOfSight` entry from `l0`/`l1` into the prism at `y = roofY + slantH * 0.25`.
3. **`10B-4` Endless-loop megastructure quotas**: All 5 sectors satisfy `sector.identity.megastructures` across **`loop = 0, 1, 2`**.
4. **`10B-2` Narrow `CAPSULE_HOTEL` `groundDoorFit`**: Passing a clamped `door.half < w / 2 + 0.47` places the `WALL_SIDE` socket flush on the wall (`d <= 0.05`), never at `d = 0.82`.
5. **`10C-1` Vehicle barrel normals & glass flushness**:
   - `buildHeroWheel` rim barrel average radial normal dot `< -0.95` (inward-facing, visible from outside).
   - Pickup front windshield, Pickup side windows (`max.y < 1.84`, upward normal `ny > 0.25`), and Van slit windshield all sit proud (`+0.005 .. +0.05 m`) of their lofted hull faces (zero buried vertices).
6. **`10C-2` Vending spacing**: Minimum center-to-center distance between any two `VendingKiosks` instances in every sector (loops `0..2`) is `>= 1.16 m` (zero bumper/marquee overlaps).
7. **`10C-3` Eatery lantern strings, curb LEDs, lamp alternating banners**:
   - Zero `StreetFurnishingsKit` lantern-string endpoints lie inside any `BUILDING` collider across all 5 sectors (loops `0..2`).
   - Curb LED strip vertices protrude beyond the concrete curb (`yMax > 0.12` and road-side edge `< lh`).
   - In `buildLampGeometry()`, no `aPart === 2` vertex sits at `x > 0.17` (banner neon trim uses `aPart === 6 > 4.5` so odd poles leave zero floating bar).

---

## Verification Gate
1. `npm run build` passes with 0 TypeScript/Vite errors.
2. `npm test` passes 100% (all 86 existing + all new regression tests).
3. Draw-call check: Sector 4 visible `CityBuilder` meshes unchanged (`+0` net calls; full-scene `renderer.info.render.calls <= 120`).
4. Commit cleanly to `claude/loving-bohr-lb0uj2` and push to `origin/claude/loving-bohr-lb0uj2`.
