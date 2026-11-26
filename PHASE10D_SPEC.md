# STRAND // PROTOCOL — Phase 10D AAA Master Specification: Living Cyberpunk World Animations, Landmarks, Spatial Audio Immersion & Screenshot-Audit Visual Polish

**Target Implementer**: Claude (TypeScript / Three.js r187 / WebGL2 / Web Audio API)  
**Target Codebase**: `strand-protocol/` (on top of `10BC-Fix`, HEAD `d7ac480`)  
**Master Blueprints**: `HERO_3D_MODELING_SPEC.md` §1.2 & §3.2, `CLAUDE.md`  
**Priority Order (Non-Negotiable)**: **#1 Screenshot Visual Quality** · **#2 Locked 60fps & Ultra-Low Mouse Latency**

> [!IMPORTANT]
> **Hard Engineering Ceilings for Phase 10D**
> 1. **Net Draw-Call Delta**: Strictly **`+2` draw calls** (`ElevatedTraffic` `+1`, `AnimatedEnvKit` `+1`, BOTH added to `this.persistent` in `CityBuilder.ts` so `phase10b.test.ts:268-270` sees identical mesh sets across all 5 sectors!). All Ramen Carts, Bus Shelters, Breaker Sparks, Canopy Drips, Coupe/Lamp/Market visual upgrades, and Audio systems MUST add **`+0` draw calls**. Live Sector 4 HIGH full-combat baseline (`82` calls at `d7ac480`) MUST stay `<= 92` calls (hard ceiling `<= 120`).
> 2. **Zero Per-Frame Heap Allocations**: Pre-allocate all scratch `THREE.Vector3`, `THREE.Matrix4`, `THREE.Quaternion`, `THREE.Euler`, typed arrays, and `_lightning` output structs at module/class scope.
> 3. **Zero Mouse-Latency Regression**: Never add fullscreen passes, never raise `MSAA` / `CITY_LIGHTS_MAX`, never block the main thread or touch `InputManager.consumeLook()`.
> 4. **Clean Modularity (`CityBuilder.ts` is already 8,018 lines)**: Place all new traffic and animated-environment geometry, shader, and runtime update logic inside **`src/world/CityAtmosphere.ts`** (receiving `uTime` and `(shader, apply) => this.injectCityLights(shader, apply)` callback from `CityBuilder`, matching `CityPropMeshes` at `CityBuilder.ts:1339`). Place Ramen Cart (`v2`) and Bus Shelter (`v3`) geometry builders inside **`src/world/CityFurniture.ts`**.
> 5. **100% English-Only In-World Text**: Zero Japanese/CJK characters on Ramen Cart signage (`SYNTH RAMEN`), Bus Shelter transit maps (`METRO TRANSIT // SECTOR MAP`), or any procedural atlas (`phase10c.test.ts:229`).

---

## 10D-1. Elevated Highway Moving Cyber-Traffic (`src/world/CityAtmosphere.ts`, `ElevatedTraffic`, `cap: 36`, `+1` Draw Call)

Bring the expressways alive with continuous rivers of cyberpunk traffic headlights and crimson light-ribbon taillights.

### 1.1 Exact Highway Geometry, Zero Parked-Car Collisions & Zero-Teleport Routing
* **Exact Live Constants (`constants.ts:790-830`, `CityBuilder.ts:3988-3992, 581-586`)**:
  - `DECK = LEVEL.HIGHWAY_DECK_Y` (`9.5 m`), `HW = LEVEL.HIGHWAY_WIDTH_M / 2` (`7.0 m`), `GT = LEVEL.HIGHWAY_GUARD_THICKNESS_M` (`0.4 m` → guard wall inner face is **`HW - GT = 6.6 m`**!), `VIS = LEVEL.VISUAL_EXTENT_M` (`175 m` → full linear span **`L = 350 m`** from `-175` to `+175`).
* **Remove Parked Highway Cars (`CityBuilder.ts:6826-6855`)**:
  - Currently `CityBuilder.ts:6826-6855` places `plan.highways.length * 3` parked cars directly on the elevated deck at `lat = ±5.25 m` (`|lat| ∈ [4.13, 6.37 m]`), which would collide head-on with moving traffic!
  - Remove `hwSlots` from the parked-car selection pool (`pick`) so all `sector.parkedCars` spawn cleanly on ground `carSlots + parkingSlots` (Sector 5 has ~60 ground curbside slots for 34 cars; `phase10c.test.ts:294` asserts total `cars.length === L.sector.parkedCars`, which remains 100% satisfied!).
* **Export `HighwayLaneSpec[]` from `CityBuilder.ts` to `CityAtmosphere.buildSector(...)`**:
  - **Sectors 1–4 (Linear Expressways)**: For each `h` in `plan.highways`, create **2 outer traffic lanes** running in opposite directions along `h.axis`:
    - Lane `+1` (traveling `+along`): lateral offset `h.coord + 4.9 m` (`car width 1.92 m → |lat| ∈ [3.94, 5.86 m]`, clearing both median `±0.25 m` and guard inner face `6.6 m` by `>= 0.74 m`!), `y = DECK + 0.02`.
    - Lane `-1` (traveling `-along`): lateral offset `h.coord - 4.9 m`, `y = DECK + 0.02`.
    - Center `[-3.9 m, +3.9 m]` remains clear for combat and sprints; wrap seamlessly over `[-VIS, +VIS]` (`L = 350 m`, outside playable `±H` so wrap-around occurs invisible in abyss fog!).
  - **Sector 3 Grade-Crossing Anti-Overlap (`CityBuilder.ts:518-521`, crossing at `(-4, +4)`)**:
    - All 4 lanes run at exact equal speed **`v = 22.0 m/s`** with exact divisor count **`N = 8` cars/lane** (`S = 350 / 8 = 43.75 m`, `32` cars total; OR `N = 7`, `S = 50.0 m`, `28` cars total) so `mod L` has ZERO wrap seam!
    - Anchor phase directly to the crossing center `(-4, +4)`: `z`-axis lanes (`coord = -4`) use `phase_z(t) = ((zCross + i * S + dir * v * t) mod L)` with `zCross = +4`; `x`-axis lanes (`coord = +4`) use `xCross = -4` shifted by **`+S / 2`** (`+21.875 m`), guaranteeing exact **`21.875 m`** center-to-center separation at all 4 perpendicular lane crossings for all `t`!
  - **Sector 5 Closed Square Ring Expressway (`plan.highways.length === 4 && plan.plaza !== undefined`, `x = ±27, z = ±27`, outer wall inner face `±33.6 m`, inner wall outer face `±20.4 m`)**:
    - Construct **2 closed rounded-square loops** parameterized analytically by arc length `sampleRing(s, R, r, dir)` (zero corner clipping, zero teleports!):
      - **Outer Ring (CW)**: half-size **`R = 30.8 m`**, corner fillet radius **`r = 5.0 m`** (arc center `(25.8, 25.8)`: at 45° midpoint car center is `(29.34, 29.34)`, max rear-ribbon corner reaches `33.48 m < 33.6 m` outer guard wall, and clears median end `(20.0, 27.25)` by `> 3.3 m`!).
      - **Inner Ring (CCW)**: half-size **`R = 23.0 m`**, corner fillet radius **`r = 3.0 m`** (arc center `(20.0, 20.0)`: inner body clears inner wall corner `(20.4, 20.4)` by `1.47 m`, max rear-ribbon corner reaches `26.26 m < 26.75 m` median inner face!).
      - Ring speed **`14–16 m/s`** (`12` outer + `12` inner = `24` vehicles, max turn rate `v / rMin <= 5.33 rad/s`, smooth heading around all 4 bends!).
* **Vehicle Count & Speeds**: `24–36` active vehicles (`cap = 36`), speeds `18–26 m/s` on linear expressways (`14–16 m/s` on Sector 5 ring), driven by `simTime` so Bullet Time slows traffic dramatically!

### 1.2 Sculpted Low-Poly Traffic Mesh + Integrated Trailing Light Ribbons (`<= 240` tris, `+1` Draw Call)
* Build one crisp futuristic wedge-coupe geometry (`length 4.5 m`, `width 1.92 m`, `height 1.18 m`, forward `+Z`, grounded `min.y = 0.0`) using `loftSymHull` (from `CityVehicles.ts`) + `4` wheel blocks (`aPart = 4`) + tinted canopy (`aPart = 1`) + bright white/cyan LED headlight bar (`aPart = 2`, front `z = +2.24`) + blazing crimson taillight bar (`aPart = 3`, rear `z = -2.24`).
* **Integrated Opaque Crimson Light Ribbons (`aPart = 5`, `+0` Extra Draw Calls!)**:
  - Attach two slim tapered horizontal quad-ribbon needles behind the rear taillights (`z = -2.28 -> -5.2 m`, `x = ±0.66`, `y = 0.56`, width tapering `0.075 m -> 0.008 m`, dark base albedo `vec3(0.01)`, `emissive = crimson * 1.8 * pow(fade, 1.4)` via vertex `aAo`) — zero transparency sorting artifacts and razor-sharp flowing red light streaks under half-res Bloom!
* **Per-Instance Paint & Light Variation**: `aTraffic (vec4: paintIdx, headCyanMix, emissiveScale, unused)` + `injectCityLights` so overhead gantries & billboards glint off moving hoods.
* **Strictly Non-Lethal Gameplay Safety (`0` Damage — `ONE_SHOT_PROTOCOL` Safe!)**:
  - Expose `ElevatedTraffic.checkPlayerBump(playerPos, outImpulse)` called from `main.ts` when `Math.abs(playerPos.y - DECK) < 2.2`:
  - If player horizontal OBB margin `< 0.55 m` and `bumpCooldown <= 0`, apply **strictly `0` damage** (never triggers `takeDamage()` / never instant-kills under `ONE_SHOT_PROTOCOL`!), push the player **inward toward the highway centerline** (`-sign(laneOffset)` × `11.5 m/s` + `+3.5 m/s` slight upward hop — NEVER outward over the `1.1 m` guard wall!) via **`player.addImpulse(outImpulse)`** (`PlayerController.ts:504`) + **`player.addTrauma(SHAKE.GRAZE)`** (`PlayerController.ts:438`, valid `ShakeDef`!) + `0.6 s` cooldown + horn/whoosh SE!

---

## 10D-2. GPU-Animated Micro-Environment Kit (`src/world/CityAtmosphere.ts`, `AnimatedEnvKit`, `cap: 220`, `+1` Draw Call, 100% GPU `uTime`)

One persistent opaque `InstancedMesh` (`name = 'AnimatedEnvKit'`, `cap = 220`, `+1` draw call, added to `this.persistent`) with per-vertex attributes `aVar (0..2)`, `aPart`, `aAo`, `aAnim (vec2: mode, factor)` and per-instance attributes **`aEnv (vec4: variant, speed, phase, unused)`** and **`aEnvCol (vec3: linear RGB per instance)`** (one branchless linear color path for `v0` vent glow, `v1` fabric dye, and `v2` sector `PAL` hologram neon!).

> [!CAUTION]
> **Three.js r187 Vertex Shader Normal-Rotation Order (CRITICAL!)**:
> In `THREE.ShaderLib.standard.vertexShader`, `#include <beginnormal_vertex>` → `#include <defaultnormal_vertex>` → `#include <normal_vertex>` runs **BEFORE** `#include <begin_vertex>`! Rotating `objectNormal` inside `<begin_vertex>` is a complete no-op for `vNormal` and `strandCityLights`.
> **Rule**: Rotate `objectNormal.xy` (for `v0` spinning blades) and `objectNormal.xz` (for `v2` counter-rotating hologram rings) immediately after **`#include <beginnormal_vertex>`**, and rotate/sway/collapse `transformed` immediately after **`#include <begin_vertex>`**!

### Variant Specifications (`<= 320` tris per variant)
1. **v0 — Spinning Industrial Exhaust Fans (`~180` tris, `70–100` instances/sector)**:
   - Local frame: back plate at `z = 0.0` (flush against host wall), projects outward along `+Z` to `z = +0.26 m`, radius `r = 0.44 m`.
   - Static parts (`aAnim.x = 0`): octagonal chamfered dark-steel shroud (`z = 0..0.24`), `4` bolts, recessed backlit inner vent core (`z = 0.04`, `aPart = 2`, `aEnvCol` warm-amber/cyan emissive `0.65`, `aAo = 0.38`), and outer protective cross-wire guard bars (`z = 0.25`).
   - Animated blades (`aAnim.x = 1`): hub + `6` pitched aerodynamic blades (`z = 0.14`, pitched `22°`). Rotate `objectNormal.xy` after `<beginnormal_vertex>` and `transformed.xy` after `<begin_vertex>` by `ang = uTime * aEnv.y + aEnv.z` (`speed = 4.5–9.0 rad/s`, alternating CW/CCW).
   - **Collision-Free Placement Contract**:
     - **Wall Fans**: Strictly bound to solid `FaceSpan`s (`sp.a0 + 0.65 .. sp.a1 - 0.65`). On `ALLEY_INFRA` / non-awning faces: `y = 2.6–3.4 m`. On `CYBER_EATERY` walls (which carry awnings at `y = 3.15..3.55 m`, `CityBuilder.ts:6053`): mount **above the awning (`y = 4.4–5.4 m`)** or strictly on non-awning bays! Clear all `groundPiers`, `groundDoors`, `propObstacles`, `socketProps`, `neonSignRecords` / `signBoxes`, and megastructure shafts (`<= 0.05 m` from solid `FaceSpan`).
     - **Rooftop Fans**: Do **NOT** use `roofRects` (which holds open-air spawn clearance squares!). Record explicit **`machineRoomBoxes`** (`{ x0, x1, y0, y1, z0, z1, doorFace }`) when emitting `machineRooms` at `CityBuilder.ts:6459` and mount rooftop `v0` fans flush on non-door vertical flanks of `machineRoomBoxes` (zero floating fans!).
2. **v1 — Wind-Swaying Eatery `Noren` Curtains & Alley Banners (`~180` tris, `60–90` instances/sector)**:
   - Local frame: top bamboo/steel mounting rod at `y = 0.0, z = +0.06` (`width 1.64 m`, `r = 0.018 m`), `4` split cloth curtain flaps hanging downward (`y ∈ [-0.68, -0.02]`, `4` vertical quad subdivisions per flap, **back-to-back `+Z/-Z` quads or `DoubleSide`** so flaps never vanish when viewed from beneath an awning!).
   - Vertex shader wind animation (`aAnim.x = 2`, `aAnim.y = clamp(-position.y / 0.68, 0.0, 1.0)`):
     - `float bend = aAnim.y * aAnim.y;` (strictly `0.0` at top rod so cloth NEVER detaches!).
     - `float wave = sin(uTime * aEnv.y + aEnv.z + position.x * 2.6) * 0.11 + sin(uTime * aEnv.y * 2.3 + aEnv.z * 1.7 + position.x * 5.2) * 0.035;`
     - `transformed.z += wave * bend; transformed.y += abs(wave) * 0.08 * bend;`
   - Shading: deep dyed indigo/crimson/burnt-amber wet fabric via `aEnvCol` (`roughness 0.78`, `metalness 0.02`, subtle horizontal woven border stripe, `emissive <= 0.35`, never blooming).
   - **Collision-Free Placement Contract**:
     - Under **`CYBER_EATERY` awning front lips** (`CityBuilder.ts:6053`): hang at **`d = 1.18 m, y = 3.08 m`** (lowest vertex `y = 2.40 m > 2.20 m` clear headroom, clearing `0.24–0.36 m` `groundPiers` cleanly!).
     - On awning-less alley storefronts: mount strictly inside single bays between `groundPiers` at `d = 0.28 m, y >= 3.05 m` with twin dark-steel standoff brackets reaching back to `d = 0.0`, clearing all `doorClearZones` & `lamp` poles!
3. **v2 — Giant Counter-Rotating Rooftop Corporate Wireframe Holograms (`~240` tris, `6–12` instances/sector)**:
   - Opaque thin-strut neon lattice (`bar thickness 0.055–0.065 m`, zero transparent sorting issues!): base emitter pedestal pad at `y = 0.0` (`r = 0.85 m, h = 0.25 m`, static `aAnim.x = 0`), outer 12-sided bevelled neon ring (`r = 3.4 m`, `y = 1.6..8.4 m`, `aAnim.x = 3`, rotates `+uTime * 0.45` around Y), inner tilted gyroscope ring + octahedron crystal (`aAnim.x = 4`, rotates `-uTime * 0.85` around Y + gentle vertical bob `sin(uTime * 1.4 + phase) * 0.22 m`).
   - Fragment shader (`aPart = 4`): `aEnvCol` (sector `PAL`), animated scanline pulse `emissive = aEnvCol * (1.25 + 0.35 * sin(vCityWorld.y * 5.0 - uTime * 4.0))`.
   - **Collision-Free Placement Contract**:
     - Eligible rooftops: tall flat rooftops (`STEPPED_SETBACK` main roof and regular `TOWER` rooftops with `roofY >= 28 m` and `halfW, halfD >= 5.5 m`). **Explicitly EXCLUDE `CYLINDER_RING_TOWER`** (occupied by central `18 m` radio spire at `CityBuilder.ts:4778-4782`), **`SLANT_CORP_TOWER`**, and **`TWIN_ARCH_GATE`** voids!
     - Check `roofRects` + `b.plan.plates` using the **FULL hologram ring sweep (`hw = hd = 3.6 m`)** so spinning rings NEVER clip `4.4 m`-tall `machineRooms` or rooftop shacks, AND verify `>= 18 m` 3D clearance from `CITY_FX.BLIMPS`!

---

## 10D-3. Street Landmarks in Existing `StreetFurnishingsKit` (`src/world/CityFurniture.ts`, `ProceduralTextures.ts`, `CityBuilder.ts`, `+0` Draw Calls)

Complete the two reserved variants in `StreetFurnishingsKit` (`KIT_VARIANT.RAMEN_CART = 2`, `KIT_VARIANT.BUS_SHELTER = 3`, `KIT_CAP = 300`, **`+0` extra draw calls!**).

### 3.1 `furnishingsAtlas` (`512 × 256`), `CityFurniture.ts` Defaults & `createFurnishingsMaterial()` Upgrade
* **Dedicated `512 × 256` `furnishingsAtlas` (`src/engine/ProceduralTextures.ts:40-73, 2918-2956`)**:
  - Add `furnishingsAtlas?: THREE.Texture` (optional on `ProceduralTextureLibrary`, typed as `THREE.Texture` matching `vendingAtlas` at `ProceduralTextures.ts:68, 2932` so headless Node fallback & `mockTextures()` compile cleanly — also add mock entry cleanly to `phase10c.test.ts` / `phase10d.test.ts`!).
  - 100% English-only (`phase10c.test.ts:229`):
    - **Top Half (`v ∈ [0.5, 1.0]`) — Ramen Cart Sign**: `"SYNTH RAMEN // HOT NOODLES 24H"`, bowl emblem, `"$6 · $9"`.
    - **Bottom Half (`v ∈ [0.0, 0.5]`) — Bus Shelter Transit Map**: Glowing cyan/magenta/amber schematic metro lines + `"NEO-KOWLOON METRO // SECTOR TRANSIT"` + `"NEXT SHUTTLE: 02 MIN"`.
* **`CityFurniture.ts` Required Updates**:
  - Update `buildFurnishingsKit()` default parameter (`CityFurniture.ts:188`) to `[KIT_VARIANT.LANTERNS, KIT_VARIANT.PARASOL, KIT_VARIANT.RAMEN_CART, KIT_VARIANT.BUS_SHELTER]`.
  - Ensure `tag()` (`CityFurniture.ts:47`) ALWAYS emits `uv` (`Float32Array(n * 2)`) for every variant and `finish()` empty fallback (`CityFurniture.ts:20`) includes `['uv', 2]`.
  - Update **`tests/phase10c.test.ts:163-164`** from `=== 0` to `> 0 && <= 380` (since 10D implements the two reserved variants!).
* **`createFurnishingsMaterial()` (`CityBuilder.ts:2156-2199`, `v2` Cache Key)**:
  - Follow `createVendingMaterial()` (`CityBuilder.ts:2113-2148`): do **NOT** set `map:` on `MeshStandardMaterial`! Inject custom uniform `shader.uniforms.uFurnAtlas = { value: this.tex.furnishingsAtlas ?? null }` + `varying vec2 vFUv;` (`vFUv = uv;`).
  - Add **4 explicit `kv == 0.0 / 1.0 / 2.0 / 3.0` branches** across `<map_fragment>`, `<roughnessmap_fragment>`, `<metalnessmap_fragment>`, and `<emissivemap_fragment>` (NEVER letting `v2`/`v3` fall into `v1` parasol's `else` branch!).
  - When `kv >= 1.5 && kp == 4.0`: sample `vec3 fAtl = texture2D(uFurnAtlas, vFUv).rgb;`, set `diffuseColor.rgb = fAtl * 0.20`, and set `totalEmissiveRadiance = fAtl * (kv < 2.5 ? 1.05 : 0.95)`!
  - Bump `customProgramCacheKey` to `'strand-furnishings-v2'`.

### 3.2 Variant 2 — Steaming Cyberpunk Ramen Street-Vendor Cart (`HERO_3D_MODELING_SPEC.md` §3.2, `<= 380` tris)
* **Envelope**: `2.20 × 2.35 × 1.15 m`, grounded strictly `|min.y| <= 0.02`, front customer counter facing `+Z`. Use `4–6` radial segments on wheels/bowls/bottles and open-bottom `box()` / `plane()` to stay comfortably `<= 360` tris (`<= 380` cap).
* **Parts**: `4` caster wheels (`r = 0.09 m`), stainless cart chassis (`1.85 × 0.84 × 0.85 m`), push handle (`x = -1.02`), dark slatted timber skirt + cantilevered counter lip (`y = 0.94`), recessed boiler vat (`x = -0.32, y = 0.945`, warm glow), glass sneeze-guard hood, stacked ceramic bowls & bottles, `4` roof posts, slanted corrugated awning (`5` ribs), backlit English marquee (`aPart = 4`, top half of `furnishingsAtlas`), `3` valance flaps, and `2` warm glowing corner lanterns (`aPart = 3`, emissive `1.30`).
* **Placement (`2–4` in S1–S4, `1–2` in S5)**:
  - Tucked into `L_SHAPE` pocket courtyards, covered market margins, or wide `AVENUE` sidewalk pockets (`sidewalk >= 3.2 m`), counter facing open walkway, clearing `doorClearZones`, `propFootprints`, lamps, vending machines, cars, crosswalks, and building AABBs (`>= 0.65 m`).
  - Push `PropContactShadows` quad into `extraShadows` **BEFORE** `this.propMeshes.commit(...)` (`CityBuilder.ts:7525`).
  - Register solid `PROP` AABB collider (`2.10 × 2.30 × 1.10 m`), warm `addLight(1.25)`, and emit **anchored delicate noodle-boiler steam** (`size = 0.35–0.45 m, rise = 1.6–2.2 m`) into `this.steam` (`CAP.STEAM` bumped `200 -> 232`) at `CityBuilder.ts:7614` **BEFORE** `canalSteam` fills remaining slots (`+0` draw calls!).

### 3.3 Variant 3 — Holographic Bus-Stop Shelter (`HERO_3D_MODELING_SPEC.md` §3.2, `<= 380` tris)
* **Envelope**: `3.60 × 2.55 × 1.45 m`, grounded strictly `|min.y| <= 0.02`, open boarding side facing `+Z` (toward road).
* **Parts**: `3` angled dark-steel cantilevered C-frame ribs (`x = -1.75, 0, +1.75`), chamfered rain roof (`3.70 × 0.14 × 1.55 m` at `y = 2.48`) with recessed cyan/white underside ceiling LED strip (`aPart = 3`, emissive `1.15`), rear tempered glass windscreen + aluminum mullions (`aPart = 6` / `0`), right-side double-sided transit map lightbox kiosk (`0.18 × 2.15 × 1.25 m` at `x = +1.72`, `aPart = 4`, bottom half of `furnishingsAtlas`, emissive `0.95`), and integrated slatted steel bench (`1.85 m`, seat `y = 0.46`, backrest `y = 0.84`, `3` armrests).
* **Placement (`2–4` in S1–S4, `2` on S5 outer ring avenues)**:
  - Placed along major `AVENUE` sidewalks with **shelter center at `lh + 1.35 m`** (so front roof overhang `0.775 m` stays `0.575 m` strictly behind the curb edge — ZERO road overhang — while rear clears `4.0 m` building facade by `>= 1.85 m`!), facing `+Z` toward the road, minimum `28 m` spacing, clearing `doorClearZones`, crosswalks (`>= 4.0 m`), lamps (`>= 2.2 m`), vending machines, and cars.
  - Register `PROP` colliders for rear windscreen + kiosk + pillars (leaving open front boarding bay walkable!), push `extraShadows` before `commit()`, and add cool-cyan `addLight()`.

---

## 10D-4. Alley Breaker Sparks, Canopy Rain Drips & Procedural Audio Immersion (`EffectsPool.ts`, `AudioEngine.ts`, `EnemyManager.ts`, `main.ts`, `+0` Draw Calls)

### 4.1 Faulty Alley Breaker Sparks (`8–12` Emitters/Sector, `+0` Calls)
* Export `sparkNodes: ReadonlyArray<{ readonly pos: THREE.Vector3; readonly nx: number; readonly nz: number }>` on `SectorLayout` (`8–12` deterministic points selected from `CityProps` `BREAKER` fixtures in alleys/service corridors, with fallback to alley wall junction boxes if `< 8`).
* Pre-allocated cadence table (`nextFireTime: Float32Array`, zero allocations): every `4.0–9.0 s`, if `distSq <= 52 * 52`, emit a `BURST.BREAKER_SPARK` (`6–10` blue-white particles, `minor: true`) oriented outward along `(nx, 0.25, nz)` via existing `EffectsPool` particle pool (note: `updateParticles` uses gravity + drag; normal orientation ensures sparks arc cleanly out into the alley!), plus `this.renderer.flashLight(pos, 0x70d8ff, 3.0, 10, 0.09)` (`Renderer.ts:895`) when `dist < 18 m`, and `audio.breakerCrackle(pos)` when `dist <= 14 m` (`3D` panned via `panner(..., this.seBus)`).

### 4.2 Storefront Canopy Rain Drips (`EffectsPool.ts`, `+0` Calls)
* Export `canopyDripEdges: ReadonlyArray<{ x0: number; z0: number; x1: number; z1: number; y: number }>` on `SectorLayout` (capped at `48` segments) sampled from full **covered-market awning front lips** (`sA0 - 0.2 .. sA1 + 0.2` at `d = front + 0.7, y = yOut - 0.1`, `CityBuilder.ts:6723` — NOT the `2 cm` `marketTrestles.awningEdges` QA stubs!) plus **`CYBER_EATERY`** (`d = 1.35, y = 3.15`, `L6053`) and **`TECH_APPAREL`** (`d = 1.45, y = 3.29`, `L6082`) canopy front lips!
* Every frame while playing (`simDt > 0`), sample at most `2` segments within `16 m` of `cameraPos` (rolling cursor, zero allocations) emitting `3–6` downward stretched drip streaks/sec via `BURST.CANOPY_DRIP` (`EffectsPool` particle pool) + optional tiny `spawnSplashAt(x, 0.02, z)` ring on the existing `RainSplashes` pool (`+0` draw calls!).

### 4.3 Procedural Audio Immersion (`src/engine/AudioEngine.ts`, `EnemyManager.ts`, `CityBuilder.ts`, `main.ts`)
* **Routing Rule**: Connect ALL 3D panned world SE to **`this.seBus`** (matching `AudioEngine.ts:998-1039`, NOT `this.seFilter`) so both city reverb and Bullet-Time lowpass apply cleanly! When custom rolloff is needed, mutate `p.refDistance` / `p.rolloffFactor` on the node returned by `this.panner(c, pos, true, this.seBus)` (since `panner()` sets `distanceModel = 'inverse'`, where `refDistance` and `rolloffFactor` control falloff).
1. **Approaching `ALERT` Enemy Wet Footsteps (`AudioEngine.enemyWetStep(pos: THREE.Vector3)`)**:
   - In `EnemyManager.ts:2399-2441` (grounded `ALERT` investigation movement, `VEIL`/`DRONE`/`VALKYRIE` already excluded), when `e.investigating && e.investigateSweepT <= 0 && speed > 0.6` and `distToPlayer <= 22 m`: advance per-enemy `stepPhase += speed * dt * 0.55`; on wrap `>= 1.0`, invoke `onEnemyStep(e.pos)`.
   - `enemyWetStep(pos)`: HRTF `panner(c, pos, true, this.seBus)` (`refDistance = 3.5, rolloffFactor = 1.6`), short wet-asphalt heel thud (`140 -> 65 Hz`) + crisp bandpass water splash (`1900 Hz`, `55 ms`), globally rate-limited to `<= 4/s`!
2. **Synthetic Enemy Radio Vocoder Squelch (`AudioEngine.enemyRadioSquelch(pos: THREE.Vector3, urgent: boolean)`)**:
   - Wired at `main.ts:529` on `'DETECTED'` (`urgent = false`, `135 ms`) and `'COMBAT'` (`urgent = true`, `220 ms`) — **strictly guard `if (pos)`** because `'GLOBAL_COMBAT'` (`EnemyManager.ts:1430`) passes `pos = null`!
   - Synthesis: `18 ms` static squelch (`bandpass 2400 Hz`) → `90–160 ms` 3-formant-swept robotic cipher tones (`sawtooth 160–240 Hz` → `700 / 1350 / 2200 Hz` bandpass) → `20 ms` closing roger click. Panned to `this.seBus`, `>= 0.8 s` global cooldown.
3. **Speed-of-Sound Delayed Rolling Thunder (`AudioEngine.thunderRumble(pan: number, intensity: number)`)**:
   - **Zero-Allocation `lightningAt()` (`CityBuilder.ts:969`)**: Add optional output param `lightningAt(t: number, out?: LightningSample): LightningSample` so `main.ts` passes a pre-allocated `_lightning` struct every frame (zero heap allocs!).
   - Whenever `_lightning.k !== lastLightningK && _lightning.intensity >= 0.25`: arm pre-allocated `thunderFireAt = simTime + 1.5 + hash(k) * 1.5`, `thunderAz = _lightning.azimuth`, `thunderInt = _lightning.intensity`.
   - When `simTime >= thunderFireAt` (only while `state === 'PLAYING'`): compute exact stereo pan against camera right vector **`R = (cos(yaw), -sin(yaw))`** and lightning sky vector **`L = (cos(az), sin(az))`** (`CityBuilder.ts:2346, 6843`):
     ```ts
     const pan = clamp(Math.cos(this.thunderAz + this.player.yaw), -0.85, 0.85);
     ```
     (Check: `yaw = 0, az = 0` → `L = +X` dead right → `cos(0) = +1.0` right; `yaw = +π/2, az = -π/2` → `L = -Z` dead right → `cos(0) = +1.0` right!).
   - Call `audio.thunderRumble(pan, thunderInt)`: reuses existing pre-allocated `4.0 s` **`this.pink`** buffer (`AudioEngine.ts:261`, zero buffer allocs!) → dynamic lowpass sweeping `95 -> 38 Hz` (`Q = 1.4`) over `3.2 s` + `1.8 Hz` LFO rumble → `StereoPannerNode(pan)` → `this.seBus`. Disarm cleanly on `buildSector()` / pause!

---

## 10D-5. Immediate Screenshot-Audit AAA Visual Polish (`CityVehicles.ts`, `CityBuilder.ts`, `main.ts`, `+0` Draw Calls)

Directly resolves every visual flaw caught in the live `d7ac480` WebGL screenshot audit while staying strictly within **`CAR_TRI_BUDGET = 1,100`** (`phase10c.test.ts:155`)!

1. **Coupe Tapered V-Nose Carbon Splitter (`src/world/CityVehicles.ts:339`)**:
   - Replace boxy `box(1.92, 0.045, 0.42, 0, 0.16, 2.14)` (`-10` tris) with a sleek 3-station `loftSymHull` tapered chin splitter (`+36` tris) following the V-nose planform:
     - `z = +2.38`: `[[0, 0.14], [0.52, 0.14], [0.54, 0.185], [0, 0.185]]`
     - `z = +2.06`: `[[0, 0.14], [0.91, 0.14], [0.93, 0.185], [0, 0.185]]`
     - `z = +1.90`: `[[0, 0.14], [0.92, 0.14], [0.92, 0.185], [0, 0.185]]`
   - Add slim angled carbon dive-plane winglets at `x = ±0.92, y = 0.21, z = 2.02` (`plane` pair, `+8` tris total, `aPart = 4`).
2. **Closed Tyre-Cavity Dark Backing Discs + Triangle-Budget Reclamation (`src/world/CityVehicles.ts:240-265`)**:
   - Current measured tri counts at `d7ac480`: Coupe `1,078`, Pickup `1,046`, Van `930` (hard budget `1,100`).
   - Inside `buildHeroWheel()`:
     1. Reduce tyre lathe radial segments `12 → 10` (`-12` tris/wheel = **`-48` tris/car**; visually indistinguishable at `10` facets with smooth normals!).
     2. Swap brake caliper `BoxGeometry` (`12` tris) to open-bottom `box()` (`-2` tris/wheel = **`-8` tris/car**).
     3. Seal the open back of the tyre lathe (`y_local = -hw + 0.01`, **strictly inside the tyre cavity** — NEVER hanging below the Pickup/Van chassis!) with a `6`-tri `CircleGeometry(0.95 * R, 6)` rotated `-Math.PI / 2` around X facing outward (`aPart = 4, aAo = 0.26`, `+24` tris/car → net **`-32` tris/car**!).
   - Final measured tri budgets: Coupe **`~1,080 <= 1,100`**, Pickup **`~1,014 <= 1,100`**, Van **`~898 <= 1,100`** — zero see-through wheel backs, zero hanging flaps, 100% compliant with `phase10c.test.ts:155`!
3. **Physically Soft Dual-Lobe Mie Atmospheric `LampHalos` (`CityBuilder.ts:3154–3161`)**:
   - Replace single Gaussian cotton-ball falloff on streetlamps (`mist < 0.5`) with a dual-lobe Mie haze profile:
     ```glsl
     float r2 = r * r;
     float outerFade = pow(clamp(1.0 - r, 0.0, 1.0), 1.8);
     float lampGlow = (exp(-r2 * 11.5) * 0.20 + exp(-r2 * 2.6) * 0.075) * outerFade;
     float mistGlow = ${NEON_BLOOM.LAMP_HALO_OPACITY.toFixed(2)} * exp(-r2 * 2.2) * (1.0 - smoothstep(0.82, 1.0, r));
     float a = mix(lampGlow, mistGlow, mist);
     ```
   - Preserves `phase10b.test.ts:321-326` billboard mist behavior while giving streetlamps a crisp luminous core dissolving softly into misty air!
4. **Richer Covered Street-Market Stalls (`CityBuilder.ts:6707–6730`, `+0` Draw Calls)**:
   - Upgrade bare stall boxes into recessed illuminated display alcoves: recessed rear back panel (`back0 .. back1 - 0.24`), left/right divider fins (`0.12 m`), upper fascia valance (`y = 2.0..2.3`), inner shelf (`y = 1.25`, `aAo = 0.42`) lit by a warm under-valence strip (`G.strips`, `emissive 0.85`), plus `4` longitudinal corrugated roof purlins (`G.steel`) and vertical corner power conduits down each aisle post!
   - Keep `marketTrestles` QA geometry & colliders 100% compatible with **`tests/phase10b.test.ts:347-383`**!
5. **Camera-Snap `prevCamPos` Guard (`src/main.ts:1325-1332`)**:
   - Add `private camSnapped = true;` set `true` inside `buildSector()`, `spawnPlayer()`, `returnToTitle()`, and debug `fixedView` teleports.
   - Immediately after `cam.position` updates at `main.ts:1329` (BEFORE `this.camVel.subVectors(cam.position, this.prevCamPos)` at `L1331`), if `this.camSnapped || cam.position.distanceToSquared(this.prevCamPos) > 25`: execute `this.prevCamPos.copy(cam.position); this.camVel.set(0, 0, 0); this.camSnapped = false;` — completely eliminating single-frame horizontal rain smears on every teleport or sector transition!

---

## Phase 13 Blender `.glb` Swap-Ready Contract (`HERO_3D_MODELING_SPEC.md` §7, `+0` Runtime Cost)

To ensure Phase 13 Blender `.glb` hero replacements drop in with zero collider or placement rework:
* Export canonical socket & envelope constants: `FURNITURE_SOCKETS = { RAMEN_STEAM: [-0.32, 1.05, -0.05] as const }` and `FURNITURE_BOUNDS` (`RAMEN_CART`, `BUS_SHELTER`) in `CityFurniture.ts`, plus `TRAFFIC_BOUNDS = { w: 1.92, h: 1.18, l: 4.5, ribbonEndZ: -5.2 }` in `CityAtmosphere.ts`.
* Keep procedural geometry builders cleanly isolated behind exported pure factory functions (`buildTrafficCarGeometry()`, `buildAnimatedEnvKit()`, `buildFurnishingsKit()`) so Phase 13 can supply imported `.glb` `BufferGeometry` overrides without modifying lane routing, steam emission, or collider placement!

---

## Draw-Call & Performance Audit (`<= 120` Cap)

| System | Delta | Sector 4 HIGH Full-Combat Total |
| :--- | :---: | :---: |
| Phase `10BC-Fix` Measured Baseline (`d7ac480`) | `—` | **`82`** |
| `ElevatedTraffic` (`cap: 36`, `CityAtmosphere.ts`, in `persistent`) | **`+1`** | `83` |
| `AnimatedEnvKit` (`cap: 220`, `CityAtmosphere.ts`, in `persistent`) | **`+1`** | `84` |
| Ramen Carts (`v2`) + Bus Shelters (`v3`) in `StreetFurnishingsKit` + `SteamMist` | **`+0`** | `84` |
| Breaker Sparks + Canopy Drips + Audio + Visual Polish (Coupe/Halos/Market) | **`+0`** | **`84`** (`36` calls below `120` cap!) |

---

## Mandatory Verification & Unit Tests (`strand-protocol/tests/phase10d.test.ts`)

Before reporting done, Claude MUST pass `npm run build`, `npm test` (updating `tests/phase10c.test.ts:163-164` for implemented `v2`/`v3` + adding `tests/phase10d.test.ts`), and `strand-auditor` review:

1. **Highway Traffic Safety, Clearance & Continuity**:
   - All 5 sectors × Loops `0..2` spawn `24–36` active vehicles (`count <= 36`) and ZERO parked cars sit on the elevated highway deck (`L.stats.cars === L.sector.parkedCars` still holds!).
   - Every traffic car sits at `y ∈ [DECK, DECK + 0.1]` strictly inside guard walls (`|lat - coord| + 0.96 < 6.6` in S1–S4; Sector 5 outer ring max rear-ribbon corner `< 33.6 m` and inner ring inner edge `> 20.4 m`).
   - Sector 3 perpendicular lanes maintain `min center dist >= 14.0 m` across `t = 0..60 s` sampled at `0.25 s` (exact `21.875 m` crossing separation!).
   - Sector 5 ring traffic executes a smooth closed loop with continuous tangent heading (`max angular step < (vMax / rMin) * 0.05 + 0.05 = 0.32 rad` per `0.05 s`, zero corner teleports).
   - Non-lethal player bump outputs strictly inward horizontal impulse (`|impulse.xz| > 5.0`) and **`0` damage**.
2. **`AnimatedEnvKit` Geometry, Shader Order & Clearance**:
   - Each variant (`v0` fan, `v1` noren, `v2` holo) `<= 320` tris.
   - All wall-mounted `v0` fans sit `<= 0.06 m` from a solid `FaceSpan`, and all rooftop `v0` fans sit `<= 0.06 m` from an actual `machineRoomBoxes` flank (`0` floating fans).
   - All `v1` noren curtains have lowest vertex `y >= 2.20 m` and `aAnim.y === 0` on the top rod.
   - All `v2` rooftop holograms exclude `CYLINDER_RING_TOWER` / `SLANT_CORP_TOWER`, clear `roofRects` by full `3.6 m` ring sweep, and maintain `>= 18.0 m` 3D clearance from `CITY_FX.BLIMPS`.
3. **Street Landmarks (`v2` Ramen Cart, `v3` Bus Shelter)**:
   - `kitVariantTris(2) <= 380` and `kitVariantTris(3) <= 380`; `Math.abs(bbox.min.y) <= 0.02` for both.
   - 100% English-only regex check on `furnishingsAtlas` labels (`phase10c.test.ts:229`).
   - Placed carts (`>= 2` in S1–S4) and shelters (`>= 2` in S1–S4) have zero road overhang (shelter front roof lip stays `>= 0.3 m` behind the curb edge on the sidewalk side), zero overlap with `doorClearZones`, lamps, cars, vending machines, or buildings, and each cart has an anchored steam puff within `0.8 m` of its boiler vat.
4. **Coupe Tapered Splitter, Tyre Backing & Audio/Thunder Math**:
   - **`buildCarVariant(0)`** (Coupe) `<= 1,100` tris, `buildCarVariant(1)` `<= 1,100`, `buildCarVariant(2)` `<= 1,100`; `|min.y| <= 0.02`; Coupe nose width at `z > 2.2` strictly `< 0.65 ×` rear fender width.
   - Zero-alloc `lightningAt(t, _out)` returns identical results to `lightningAt(t)`.
   - Thunder scheduler fires `1.5–3.0 s` after each `lightningAt` event (`intensity >= 0.25`), stereo pan `cos(az + yaw)` yields `+1` when `az = 0, yaw = 0` (right) and `+1` when `az = -π/2, yaw = +π/2` (right), resets on sector switch, and stays silent while paused.
