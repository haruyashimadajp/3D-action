# STRAND // PROTOCOL — Phase 10 Complete Overhaul Master Specification (10A / 10B / 10C / 10D)

**Target Implementer**: Claude (TypeScript / Three.js / WebGL2 / Web Audio API)  
**Target Codebase**: `strand-protocol/` (on top of Phase 9B `7fdf96c`)  
**Master Spec Alignment**: `GAME_DESIGN_SPEC.md` v1.7  
**Execution Strategy (Token-Optimal 5-Step Split)**: Execute strictly one bounded step at a time (**10A-1 → 10A-2 → 10B → 10C → 10D**), touching only 3–5 files per step and passing `npm run build` + `npm test` (plus headless visual screenshot check if available) before proceeding.
- **10A-1**: `10A-1`, `10A-2`, `10A-4` (GPU/CPU pipeline optimization, `PhysicsWorld` spatial grid, early kit consolidation, all visual/geometry bug fixes, 5 live-preview screen filters).
- **10A-2**: `10A-3`, `10A-3b`, `10A-5`, `10A-6` (muzzle flash, cooling scorch decals, sniper steam/casings/rangefinder, realistic walk bob & recoil kick, fixed `ALERT` investigation AI + enemy flashlight cones, circular pulse mini-radar).

> [!IMPORTANT]
> **Hard Non-Negotiable Constraints (Zero Regression Across All 4 Sub-Phases)**
> 1. **Locked 60fps & Ultra-Low Mouse Latency FIRST**: `renderer.info.render.calls <= 120` in ALL 5 sectors (strictly audited in Sector 4 at full density), zero per-frame heap allocations in update/render loops.
> 2. **100% Procedural WebGL2 + Web Audio API**: Zero external `.glb`/`.png`/`.mp3` files.
> 3. **Preserve Core Pillars**: Exclusive gun⇄grapple switching (hanging allowed), 3-phase telegraph lines, 100 HP / 3.0s regen / 0.5s retry, zero shooting aim assist, airborne Bullet Time, 4-state stealth AI, and clean parallel wall-run faces (`>= 2` per tower + narrow alleys).
> 4. **Clean Modularity**: Keep files focused and maintainable — place new hero vehicle/vending/street-furniture builders in dedicated helpers (`src/world/CityVehicles.ts`, `src/world/CityAtmosphere.ts`) instead of overloading `CityBuilder.ts`.

---

## PHASE 10A — Zero-Lag 60fps Pipeline, Critical Visual/Geometry Bug Fixes, Combat Polish (Muzzle Flash / Scorch / Rangefinder), 5 Live Screen Filters, ALERT Investigation AI + Enemy Scanner Cones & Circular Pulse Radar

### 10A-1. Root-Cause Mouse Lag & GPU Fill-Rate Optimization (`Renderer.ts`, `main.ts`, `CityBuilder.ts`, `constants.ts`, `HudManager.ts`)
1. **Half-Resolution Bloom (`Renderer.ts`)**: Initialize and resize `UnrealBloomPass` at half viewport resolution (`Math.max(128, Math.floor(w * 0.5))`, `Math.max(128, Math.floor(h * 0.5))`) — identical soft glow at ~75% lower GPU fill cost.
2. **Smart MSAA & Pixel Budget Cap (`Renderer.ts`, `constants.ts`)**:
   - Lower `RENDER.MSAA_SAMPLES` from `4` → **`2`** on `HIGH` (`0` on `MEDIUM`/`LOW` and when `lowLatency` is enabled).
   - Cap effective render pixel budget on `HIGH` so `w * h * dpr * dpr <= 2_200_000` (`dpr = Math.min(devicePixelRatio, 1.25, Math.sqrt(2_200_000 / Math.max(1, w * h)))`).
3. **Faster Dynamic City Lights (`CityBuilder.ts`, `constants.ts`)**:
   - Reduce `RENDER.CITY_LIGHTS_MAX` from `20` → **`12`** (nearest 12 lights).
   - Add squared-distance early-out (`float d2 = dot(Lv, Lv); if (d2 > R2) continue;`) BEFORE `sqrt`/`normalize`/`GGX` in `GLSL_CITY_LIGHTS`.
   - Skip `strandCityLights` evaluation in `CityPropMeshes.ts` beyond `28 m` from `cameraPosition`.
4. **Late-Frame Pre-Render Mouse Look Sync (`main.ts`)**:
   - Keep `requestPointerLock({ unadjustedMovement: true })` in `InputManager.ts`.
   - Call `this.input.consumeLook(_lookDelta)` a second time RIGHT BEFORE `this.player.updateCamera(...)` and `this.renderer.render(...)` so any mouse delta arriving during fixed physics/AI steps is reflected on the current frame with zero frame delay.
5. **Optional Lightweight Shadows Toggle & Performance Telemetry Toggle (`skills.ts`, `HudManager.ts`, `Renderer.ts`)**:
   - `SaveSettings.shadows: boolean` (default `false` for locked 60fps; when `true`, enable `THREE.PCFSoftShadowMap` `1024×1024` with a `±36 m` texel-snapped frustum centered on the player casting shadows from towers, highways, and dumpsters).
   - `SaveSettings.showPerf: boolean` (default `false`; when `true`, display a compact top-right corner readout showing `FPS | frame ms | draw calls`).
6. **CPU Broadphase Optimization — `PhysicsWorld.ts` 2D Static Spatial Grid (`cellSize = 12 m`, Zero Allocations!)**:
   - Build a flat pre-allocated 2D uniform spatial grid (`Int32Array` cell offsets + collider index list + integer `queryStamp` dedup) once per `loadLevel()`, supporting fast dynamic disable flags (`active: boolean` for future Phase 11 doors/glass) and DDA grid traversal for `raycast` / `lineOfSight` plus cell-range lookup for `movePlayer` / `findWallFaces`.
   - Eliminates linear 300–600 collider scans across 14 stealth enemies + 120Hz physics + bullets, cutting `PhysicsWorld` CPU time by **`70–85%`** right now BEFORE Phase 10B increases building count! (Verified bit-identical to brute-force via unit test!)
7. **Early Draw-Call Consolidation (`-3` Calls Right in 10A!)**:
   - Consolidate `ClutterCardboard` + `ClutterTrashBins` → single `ClutterDebrisKit` via `aVariant` (`-1` call).
   - Consolidate `guardrails` + `fences` + `antennas` (all share `steelMat`) → single `SteelFixturesInstanced` via `aVariant` (`-2` calls).
8. **True Frustum Culling & Distant Particle Auto-Skip**:
   - Compute tight exact `boundingSphere` on committed static sector meshes where safe (`frustumCulled = true`) and auto-skip spawning non-essential minor ambient sparks/splashes beyond `52 m` from the camera.

### 10A-2. Critical Visual & Structural Bug Fixes (Confirmed From Live Screenshots!)
1. **Fix "Melted Silver Mercury" Wet Road & Alley Floor (`CityBuilder.ts`, `ProceduralTextures.ts`)**:
   - Calm `GLSL_PUDDLE_RIPPLES` down to crisp delicate high-frequency raindrop micro-rings (`0.055` at `vCityWorld.xz * 4.5` + `0.035` at `vCityWorld.xz * 7.8`) on **flat** rain-soaked asphalt (matching Cyberpunk 2077 blotchy-wet asphalt reflections, never undulating mercury waves!).
   - Raise minimum wet road/alley puddle roughness from `0.06` → **`0.13`** (damp asphalt `0.36–0.48`), lower `RENDER.STREAK_GAIN` to **`0.72`**, and eliminate harsh dark X-seam lines from narrow alley tiles.
2. **Tone Down Over-Bloomed Highway Underside Strip (`constants.ts`, `CityBuilder.ts`)**:
   - Reduce `NEON_BLOOM.UNDERSIDE_STRIP` by ~`45%` (`~0.85`) and narrow strip width (`0.14 m` → `0.09 m`).
3. **Fix Blinding White `WIRE_RACK`, Untextured Props & Dead-Grey Steel (`CityPropMeshes.ts`, `CityBuilder.ts`, `BuildingGrammar.ts`)**:
   - Darken `WIRE_RACK` steel to matte dark gunmetal (`0x3c424a`, `roughness 0.58`) and dampen over-bright prop tints (`JERSEY 0x4e5258`, damp cardboard `0x3e3024`, muted rain-wet crates/bins).
   - **Strict Bloom Guard**: In `CityPropMeshes.ts` fragment shader, clamp `outgoingLight` on all non-emissive parts (`strandP != 3.0 && strandP != 5.0 && strandP != 8.0`) to `min(outgoingLight, vec3(0.86))` so non-glow props NEVER blow out into white Bloom.
   - **Weathered Surface Detail on ALL Props & Steel**: Bind `tex.archDetail` (sampled via world-space triplanar-lite `vCityWorld` UV at `1.2 m` tile) to BOTH `CityPropMeshes` (`createKitMaterial`) AND `this.steelMat`, AND call `this.injectCityLights(shader)` on `this.steelMat` so wet pipes, fire escapes, and railings reflect neon cleanly!
   - Lower flat cyan/amber frosted storefront panel emissive (`0.48` → `0.24`) with recessed dark mullions so `GALLERY_DANCHI` & `TECH_APPAREL` panels read as deep architectural glass.
4. **Cheap Ground Contact Shadow Decals (`CityPropMeshes.ts`, `+1` draw call)**:
   - Single `InstancedMesh` (`PropContactShadows`, `cap: 420`, flush at `Y = 0.012 m`, soft radial dark alpha shadow) beneath dumpsters, jersey barriers, benches, trash clusters, vending machines, and parked cars.
5. **Fix Unnatural On-Ramp Underside (`CityBuilder.ts` ~L3504–3525)**:
   - Lower section (`y <= 2.8 m`): solid sloped concrete retaining-wall abutment resting cleanly on `Y = 0.0` (with ground-contact `aAo`).
   - Elevated section (`y > 2.8 m`): clean `0.85 m`-deep concrete box-girder underside (`aAo = 0.45`) with twin underside beams, proper T-pier columns every `10–12 m` (`1.2 m` shaft + `width RAMP_WIDTH_M - 0.6 m × 0.75 m` horizontal cross-head cap flush against the sloped underside), and clean vertical-profile concrete side parapets (`+0.0` to `+0.95 m` above deck — NEVER twisted `beam()` geometry poking underneath!).
6. **Eliminate Floating Neon Signs Everywhere (`CityBuilder.ts` ~L5046–5072 & L5347)**:
   - Bind EVERY building-mounted `neonSign` (and every Phase 10B `MegaBillboard`) strictly inside an actual solid `FaceSpan` from `b.plan.faces` (never `b.rect` over `L_SHAPE` cutouts, `PODIUM_OFFSET` terraces, or `STEPPED_SETBACK` insets): verify `y ± signH/2` fits inside `[span.y0 + 0.4, span.y1 - 0.4]` and `along` fits inside `[span.a0 + 0.3, span.a1 - 0.3]` (with steel brackets touching `span.plane`).
   - Snap `farTowers` signs to exact cardinal faces (`±X`/`±Z`, using `t.w/2` or `t.d/2`) with `y + sh/2 <= t.top - 4.0`.
7. **Eliminate Blimp-Through-Building Clipping (`constants.ts`, `CityBuilder.ts`)**:
   - Raise `CITY_FX.BLIMPS` cruise altitudes to **`y: 168`** (`radius: 265`) and **`y: 194`** (`radius: 335`).
   - In `layoutFarTowers()`, hard-clamp any far tower whose radial swath enters a blimp corridor (`Math.abs(dist - blimp.radius) <= BLIMP_LENGTH * 0.5 + rad + 20`) to `top <= blimp.y - BLIMP_RADIUS - 24`.

### 10A-3. First-Person Combat Polish: 3D Muzzle Flash, Cooling Bullet Scorches, Sniper Barrel Steam/Casings & 4x Rangefinder (`ViewModelRenderer.ts`, `EffectsPool.ts`, `HudManager.ts`)
1. **3D First-Person Gunshot Muzzle Flash (`ViewModelRenderer.ts`, `+1` call only when active)**:
   - Crossed 3-plane additive star burst + tapered forward plasma cone attached to `muzzle` (random Z-roll `0..2π` & `0.85–1.18x` micro-scale per shot):
     - **MK-IV Suppressed Pistol**: Tight compact cyan-white burst (`length 0.09 m`, `radius 0.045 m`, `45 ms`) — snappy without obstructing the holo sight.
     - **K-90 Rail Sniper**: Dramatic plasma flash (`length 0.24 m`, `radius 0.11 m`) + **blazing lateral muzzle-brake side vents (`±0.10 m`)** (`75 ms`) + intense `70 ms` dynamic muzzle PointLight lighting the receiver & surrounding walls!
2. **Sniper Post-Shot Barrel Heat Vent Steam & 3D Ejected Rail Casings (`ViewModelRenderer.ts`, `EffectsPool.ts`)**:
   - Firing K-90 heats its rail-coil slits white-cyan and smoothly cools back to deep cyan over `1.5 s`, emitting subtle rising translucent heat-vent vapor puffs from the barrel vents.
   - Eject a visible spinning glowing spent brass/rail cartridge from `eject` on Pistol shots and Sniper breech-open reload beats (pooled into `EffectsPool`, zero allocations).
3. **Cooling Bullet Impact Scorch Decals (`EffectsPool.ts`, `InstancedMesh`, `cap: 48`, `+1` call)**:
   - Every bullet impact on buildings, concrete, roads, or dumpsters stamps a flush circular scorch decal (`radius 0.08 m` Pistol / `0.15 m` Sniper, `+0.015 m` normal offset): center glows hot orange-cyan (`emissive 2.8`) at impact and cools smoothly over `4.0 s` into a dark charred pockmark!
4. **Sniper 4x ADS Digital Rangefinder (`HudManager.ts`)**:
   - While ADS with K-90 Sniper, perform a lightweight center-ray distance check (using existing `PhysicsWorld` / enemy raycast) and render a crisp minimal monospace distance readout (e.g., `64m`, `112m`) just bottom-right of the reticle (`11px`, subtle cyan `0.75` alpha).

### 10A-3b. Realistic Stride Head-Bob & Physical Spring-Damper Recoil Camera Kick (`src/player/PlayerController.ts`)
Replace the robotic rail-flat walk camera and generic uniform `28 Hz` gunshot buzz with physically grounded AAA FPS camera motion (scaled by `settings.shakeScale` / `settings.rollScale` for zero motion sickness):
1. **Organic Figure-8 Stride Head-Bob (Synced to Ground Footsteps)**:
   - Advance `stridePhase` proportional to grounded horizontal speed (`stridePhase += speed * 0.62 * realDt` when `GROUNDED` or `CROUCHING`, smoothly damping back to neutral when airborne, sliding, wall-running, or stationary).
   - Apply subtle natural gait offsets to camera position & roll (scaled by `0.15×` during ADS so precision aiming stays rock-steady!):
     - Vertical bob: `-Math.abs(Math.sin(stridePhase)) * (crouching ? 0.014 : 0.028)` m (crisp heel-strike dip, smooth push-off arc).
     - Lateral shift: `Math.cos(stridePhase) * (crouching ? 0.006 : 0.012)` m.
     - Footstep micro-roll: `Math.sin(stridePhase) * (crouching ? 0.22 : 0.45) * DEG2RAD * settings.rollScale` (subtle weight transfer left/right).
2. **Physical Spring-Damper Gunshot Recoil Kick (Replacing Flat Vibrator Buzz)**:
   - Maintain a critically damped camera impulse spring (`kickPitch`, `kickRoll`, `kickZ` with velocities) fired on every shot (`onWeaponKick(gunId, ads)`):
     - **MK-IV Rail Pistol**: Sharp instant upward pitch snap (`+0.85°` hip / `+0.55°` ADS), tiny clockwise roll flick (`+0.45°`), and crisp `-0.016 m` backward Z-punch recovering cleanly (`k = 260, c = 28`).
     - **K-90 Rail Sniper**: Visceral heavy shoulder-slam! Strong upward pitch kick (`+2.4°` hip / `+1.4°` ADS), crisp roll whip (`±1.1°`), noticeable `-0.048 m` backward Z-punch, and brief `+1.8°` instantaneous FOV punch settling heavily (`k = 175, c = 21`).
   - Keep existing `trauma` shake for explosions, hard landings, and taking damage; reduce gunshot `trauma` so the crisp physical spring kick carries the feel instead of noisy vibration!

### 10A-4. 5 Selectable Atmospheric Full-Screen Filters With Live Pause Preview (`Renderer.ts`, `skills.ts`, `HudManager.ts`)
* `export type ScreenFilterId = 'CYBER_NOIR' | 'NEON_OVERDRIVE' | 'COLD_STEEL' | 'AMBER_DUST' | 'RAW';` (persisted in `SaveSettings.filter`, default `'CYBER_NOIR'`, `+0` extra draw calls — executed inside `KineticPostFX`!).
  - **`CYBER_NOIR`** (Default): Deep rain-soaked teal-indigo shadows, richer blacks, crisp warm/cyan neon highlights, cinematic S-curve `0.16`, soft vignette `0.18`.
  - **`NEON_OVERDRIVE`**: High-vibrance `+22%` saturation, deep indigo shadows, punchy magenta/cyan night-city pop.
  - **`COLD_STEEL`**: Desaturated (`0.72`) Ghost-in-the-Shell / Matrix cool slate-blue tactical grade so crimson visors & amber alerts pop sharply.
  - **`AMBER_DUST`**: Blade Runner 2049 warm sodium-amber atmospheric highlights & dark charcoal-bronze shadows.
  - **`RAW`**: Pure neutral ACES Filmic pass-through.
* **Live Preview in Settings**: Keep the live 3D background canvas rendered (or render 1 update frame immediately on filter change) with slightly reduced pause overlay opacity so switching filters in Settings previews the exact new screen grade in real time!

### 10A-5. Fixed `ALERT` Enemy Investigation Movement & Diegetic Enemy Flashlight / Scanner Cones (`EnemyManager.ts`)
1. **Guaranteed Mobile-Enemy `ALERT` Investigation**:
   - Applies to `ENFORCER`, `AEGIS`, `PHANTOM`, and `DRONE` (`VEIL` snipers remain perched and sweep gaze).
   - On entering/updating `ALERT`: compute ground-reachable horizontal `investigateGoal` beneath `investigatePos` (NEVER abort because `Math.abs(dy) >= 2.5`; Drones fly to `investigatePos + (0, 3.5, 0)`).
   - Set `investigating = true` and **freeze `alertGauge` decay** (floor `>= 25`) while walking/flying toward `investigateGoal` at `0.80×` combat speed (`7.0 s` movement-stall timeout safety).
   - Upon arriving within `<= 2.2 m` (or stall timeout), pause and sweep gaze `±60°` for **`2.0 s`**, and ONLY THEN clear `investigating = false` and resume normal `-14 pt/s` decay back to `0 -> UNAWARE`.
2. **Diegetic Enemy Tactical Flashlight / Visor Scanner Cones (`EnemyManager.ts`, `InstancedMesh`, `cap: 14`, `+1` call)**:
   - Patrolling `UNAWARE` and `ALERT` ground units & Drones project a soft volumetric additive cone (`length 10–14 m`, `radius 2.4 m`, subtle low opacity `0.10–0.15` so it never clutters combat, hidden in `DETECTED`/`COMBAT` where telegraph lines take over):
     - `UNAWARE`: faint cool white-cyan tactical beam sweeping with enemy head/patrol facing.
     - `ALERT`: shifts to **warm amber-yellow** sweeping actively as the enemy searches for you!

### 10A-6. Minimal Top-Left Circular Pulse-Scan Mini-Radar (`HudManager.ts`, `AudioEngine.ts`, `index.html`)
* **Option C Strictly** (corner circular radar ONLY — NO 3D wallhack markers!):
  - Top-left (`left: 24px, top: 24px`, `136 × 136 px` crisp HTML5 `<canvas>`, `+0` WebGL draw calls), player-relative rotation (`-player.yaw`), forward FOV wedge, range rings (`25 / 50 / 75 m`).
  - **Every `3.5 s`**, an expanding cyan pulse ring sweeps `0 -> 75 m` over `0.65 s` (with a faint subtle sonar ping SE when enemies remain alive).
  - Crossing an enemy refreshes its snapshot blip `(x, y, z, state)` to `alpha = 1.0`, fading smoothly to `0.18` over `3.2 s` until the next sweep.
  - State colors (`UNAWARE` `#38F8FF`, `ALERT` `#FFCC22`, `DETECTED` `#FF6A1A`, `COMBAT` `#FF2244`), **`▲`/`▼` elevation ticks** when `|enemy.y - player.y| >= 3.5 m`, and subtle outer-rim edge ticks for enemies beyond `75 m`.

---

## PHASE 10B — Zero Empty Lots, Giant Mega-Billboards & L-Corner Screens (+ Mist Halos), 4 Iconic Cyber Megastructures, Distinct Sector Identities & Proximity Lockdown Barrier

### 10B-1. Eliminate Barren Empty Lots & Barren Edges (`CityBuilder.ts`, `skills.ts`)
1. **Build Structures on `>= 92%` of ALL Generated Lots**:
   - Remove the artificial `sector.buildingCount` slice cap that left spare lots as barren concrete `plazas`! Treat `buildingCount` as a minimum and populate ALL remaining valid lots (`>= 10 m × 10 m`) with varied low/mid/high-rise buildings (at most `1` small compact courtyard per sector).
   - Any single small open pocket becomes a **dense covered cyber street-market / compact neon pavilion** (overhanging lit awnings, kiosk cluster, cars, crates, cables — NEVER bare flat concrete!).
2. **Tight Perimeter Skyline Framing**:
   - Perimeter lots along `±H` always receive tall skyline buildings (`>= 36 m`) with inward-facing Mega-Billboards.
   - Pull the inner ring of `farTowers` closer (`115–220 m` radius, varied `55–180 m` heights while strictly obeying the blimp corridor height clamp!).
3. **Proximity-Only `LockdownBarrier` Fade (`CityBuilder.ts`)**:
   - Modify `createBarrierMaterial()` so the red perimeter hex barrier is **completely invisible (`alpha = 0`) when the camera is `> 14 m` away**, fading in smoothly only as the player approaches `14 m -> 3 m` from the sector boundary (keeping the open emerald next-sector gate always visible!). Eliminates the jarring bright-red honeycomb wall ruining distant vistas!

### 10B-2. 100% English-Only Signage Overhaul, Giant Avenue-Facing Mega-Billboards, 90° L-Corner Wrap-Around Screens & Colored Mist Halos (`ProceduralTextures.ts`, `CityBuilder.ts`)
> [!IMPORTANT]
> **STRICT ART RULE — 100% ENGLISH-ONLY SIGNAGE (ZERO JAPANESE CHARACTERS IN 3D WORLD)**: Replace ALL existing Japanese katakana/kanji strings in `ProceduralTextures.ts` (vertical neon strips ~L1241–1248, wide banners & scrolling tickers ~L1305–1312, kanji seal emblem ~L1457–1463, graffiti tag ~L2411) with crisp uppercase geometric English cyberpunk typography (e.g., `STRAND`, `NEON BAR`, `NOODLE 24H`, `CYBERNETICS`, `HOLO CAFE`, `ZERO-09`, `PHARMA+`, `HOTEL KOWLOON // VACANCY`, `KARAOKE // BAR`, `VALKYRIE-09 SIGHTED // GRID 480`, `09` seal, `NEO` tag). Every sign, billboard, ticker, emblem, vending machine, scaffold tube sign, and graffiti decal MUST be **100% English / numerals / symbols**.

1. **Procedural `2048 × 1024` Mega-Billboard Atlas (`tex.megaBillboard`, `4 × 2` = 8 Hero Ads, 100% English)**:
   - Cell 0: `NEO-TOKYO REALTY` (cyan/white bold corporate typography + blueprint wireframe)
   - Cell 1: `DATA FLOW // 09` (magenta/violet diagonal tech bars + cascading matrix code)
   - Cell 2: `CYBERNETICS NOW` (acid-lime/yellow stencil + bionic eye/circuit emblem)
   - Cell 3: Tall Vertical Portrait Ad (`BELOW DECK` — glowing neon halftone face/silhouette in coral/magenta/gold for `1:3` tall screens!)
   - Cell 4: Blazing Crimson Vertical Monolith Emblem (geometric hexagon sigil + vertical bold English column `STRAND // RESTRICTED ZONE 09`)
   - Cell 5: `KIROSHI // OPTICS` (teal/cyan reticle emblem + sharp subhead `SEE THE FUTURE`)
   - Cell 6: `SYNTH NOODLES // 24H` (warm amber-orange neon ramen bowl emblem)
   - Cell 7: `SOFTSYS // CORE` (deep electric-blue isometric server wireframe + telemetry)
2. **`MegaBillboards` `InstancedMesh` (`cap: 140`, `+1` draw call) & Global Sign 3D Non-Overlap Guard**:
   - Strictly bound to solid `FaceSpan`s (`10A-2b` rule — zero floating billboards!).
   - **MANDATORY 3D AABB Non-Overlap Guard (Fixes Overlapping Neon Blade Signs Confirmed in Sector 1!)**: Inside BOTH `addNeon()` and `addMegaBillboard()`, compute each sign's exact world 3D AABB (`margin = 0.35 m` padding around width/height/thickness) and **reject/skip** any candidate sign whose 3D AABB intersects ANY previously placed `neonSign` or `MegaBillboard`! Add a **unit test** asserting **zero overlapping neon signs or Mega-Billboards** across all 5 sectors.
   - Subtle LCD scanlines, animated scroll shimmer on data panels, controlled HDR (`1.15–1.55`), and steel mounting trusses (`G.steel`).
   - **3 Formats**: Giant avenue wall screens (`10–20 m × 10–34 m`), **synchronized 90° L-corner wrap-around screens** (2–4 stacked tiers wrapping prominent street corners!), and **towering vertical neon monolith blades** (`3.2–4.5 m × 18–38 m`).
3. **Colored Neon Rain-Mist Halos Around Mega-Billboards (`+0` Extra Calls — Packed Directly Into `lampHalos`!)**:
   - Extend the existing `lampHalos` instanced shader with per-instance `aRadius` & `aColor` (`cap` expanded by `+90`) so ultra-soft additive camera-facing radial mist sprites (`radius 8–16 m`, low opacity `0.10–0.16`) tinted to each Mega-Billboard's dominant cyan/magenta/lime/crimson hue render in the SAME draw call as street-lamp halos!

### 10B-3. 4 Iconic Cyber-Megastructure Silhouettes (`BuildingGrammar.ts`, `CityBuilder.ts`, `+0` extra draw calls!)
Extend `MassingKind` with 4 skyline-defining cyber megastructures (all merged into existing `G.*` buckets):
1. **`X_TRUSS_TOWER`**: Heavy corporate tower (`44–92 m`) wrapped above `Y = 8 m` in bold external diagonal **X-brace steel exoskeleton trusses** (`0.45 m` beams in `G.steel`, `12 m` vertical bays) + cantilevered stepped crown.
2. **`CYLINDER_RING_TOWER`**: **12-sided cylindrical tower** (`radius 6.5–9.5 m`, `38–84 m` tall, grounded cleanly on an `8 m` square 5-program street podium) wrapped in **3–4 tiered glowing horizontal neon ad rings** + blazing crown halo & tall radio spire.
3. **`TWIN_ARCH_GATE`**: Twin vertical slabs separated above `Y = 8 m` by a `6–8 m` central void, bridged at `Y = roofY - 12 m -> roofY` by a **monumental neon-framed sky-arch truss** with glowing vertical edge pillars (grapple-passable through the arch!).
4. **`SLANT_CORP_TOWER`**: Cantilevered megacorp monolith with an **angled sloped crown cap** (keeping a solid flat sniper roof deck underneath!), vertical glowing spine ribs, and an upward searchlight beam.

### 10B-4. Distinct Per-Sector Architectural & Color Identities (`skills.ts`, `BuildingGrammar.ts`, `CityBuilder.ts`)
* **Sector 1 (`NEON DOWNTOWN`)**: High mega-billboard density, `L_SHAPE`, `PODIUM_OFFSET`, `TWIN_ARCH_GATE`, 2+ `GALLERY_DANCHI` · Cyan / Magenta / Warm Amber.
* **Sector 2 (`KOWLOON CANAL`)**: Dense overhanging `GALLERY_DANCHI` apartments flanking canal + `L_SHAPE` markets + glowing truss bridges · Warm Sodium Amber / Jade Cyan / Coral.
* **Sector 3 (`INDUSTRIAL INTERCHANGE`)**: Heavy `X_TRUSS_TOWER` exoskeletons + `PENCIL_TOWER` shafts + crossing expressways & tight shadow alleys · Crimson / Hazard Orange / Cold Steel.
* **Sector 4 (`MEGA-PLAZA OVERDRIVE`)**: Full Night-City skyline — `CYLINDER_RING_TOWER` + `TWIN_ARCH_GATE` + `STEPPED_SETBACK` + maximum L-corner Mega-Billboards · Full Multi-Hue Overdrive.
* **Sector 5 (`VALKYRIE CITADEL`)**: Ring of `SLANT_CORP_TOWER` & `X_TRUSS_TOWER` monoliths + blazing vertical crimson monolith blades framing the central boss scramble arena · Crimson / Pure White / Indigo.

---

## PHASE 10C — Hero Close-Up Procedural Models & Dense Street-Level Cyberpunk Furniture (`src/world/CityVehicles.ts`, `ProceduralTextures.ts`, `CityBuilder.ts`)

> [!IMPORTANT]
> **Mandatory Blueprint Reference**: Follow **`HERO_3D_MODELING_SPEC.md`** (§0–§3 & §6) strictly for `loftSymHull` cross-section station coordinates, multi-spoke wheels with brake rotors/calipers, recessed vending machine cavities, detailed street lamps, lanterns, umbrellas, ramen carts, bus-stop shelters, triangle caps, and silhouette unit tests!

**Goal**: Make every object the player inspects at close range (cars, vending machines, lamps, sidewalk curbs, low roofs, eatery streets) richly detailed with genuine AAA silhouette and surface complexity — at **only `+1` net draw call**!

### 10C-1. Hero 3-Variant Cyberpunk Vehicles (`src/world/CityVehicles.ts`, `+0` extra draw calls — replaces existing `cars[0..2]`)
Replace the simple side-extruded car blocks with sculpted, multi-component high-craft procedural vehicle meshes (using multi-profile faceted hulls, tapered cabins, wheel-well arches, multi-spoke rims, mirrors, spoilers, and grilles — vertex budget `~600–900` tris/variant, ultra-fast instanced!):
1. **Variant 0 — Cyber Supercar Coupe (Inspired by Lamborghini Aventador / Cyber-Wedge)**:
   - Tapered angular stealth hood with central crease, low front carbon chin splitter, **dual recessed angular front air intakes** with dark honeycomb mesh, **recessed Y-shaped bright LED headlights** inside dark housings.
   - **Tapered greenhouse cockpit** (narrower than wide sculpted wheel fenders), angled A-pillars, side wing mirrors on stalks, **deep carved side intake scoops** behind the doors, low side skirts.
   - **Elevated twin-strut rear carbon GT wing spoiler**, louvered rear engine deck slats, wrap-around red LED tail light bar, lower rear diffuser fins + quad exhaust pipes.
   - **Multi-spoke dark alloy wheels** (6–8 radial spokes + inner metallic brake disc rotor & crimson brake caliper visible behind spokes!).
2. **Variant 1 — Heavy Cyberpunk Pickup Truck (Inspired by Cyberpunk 2077 Foreground Truck)**:
   - Bold squared cyber-truck nose with **wide illuminated-rim mesh grille**, dual stacked quad-LED headlights, heavy front bumper with recessed **glowing blue/white license plate** & tow hooks.
   - Muscular flared wheel arches, high-clearance rugged multi-spoke tires, wide side mirrors, twin cabin roof markers, and an **open rear cargo bed** with steel roll-bar frame and strapped cargo crates!
3. **Variant 2 — Cyber Armored Utility / Cargo Van**:
   - Chamfered heavy armored cab with slit windshield visor, roof utility rack with amber strobe lightbar, armored side panel ribs & intake louvers, rugged rear double doors with heavy hinges, twin vertical tail LED bars, and heavy-duty multi-spoke wheels.
* **Enhanced Car Material**: Add subtle panel-seam bump & rain-droplet wet clearcoat sheen (`clearcoat`-like Fresnel highlight + weathered lower splash grime near wheel wells!).

### 10C-2. Hero Close-Up Vending Machines (`ProceduralTextures.ts`, `CityBuilder.ts`, `+0` extra draw calls — replaces existing `vending`)
* **Dedicated Procedural `512 × 512` Vending Display Atlas (`tex.vendingAtlas`, 4 brands: `NI-COLA`, `SYNTH-CAF`, `K-BOOST`, `ZERO-H2O`)**:
  - Paints 4 crisp rows of individually colored metallic cans, glowing energy bottles, tiny readable price-tag LED strips (`¥140`, `¥220`, `€$15`), condensation highlights, illuminated top brand header banner, and a glowing right-side touchscreen selection pad + NFC tap icon.
* **Detailed 3D Cabinet Geometry**:
  - Chamfered outer steel body (`1.10 m × 2.05 m × 0.78 m`), **recessed `0.12 m`-deep illuminated display window alcove** behind subtle glossy glass trim, protruding right-side bezel with glowing keypad & coin/card slot, **deep recessed bottom pickup chute flap** (`0.55 × 0.24 m`), protective steel corner bumpers, side ventilation louvers, and top backlit marquee hood!

### 10C-3. High-Density Cyberpunk Streetscape Details (From Cyberpunk 2077 References!)
1. **Glowing Sidewalk Curb LED Guide Strips (`+0` calls — merged into `G.strips` & `G.steel`)**:
   - Along major avenue curbs, embed periodic recessed **curb-edge LED guide bars** (`1.8 m` long every `5 m`, alternating cool cyan `#20D8FF`, warm white `#FFE0A8`, and muted crimson `#FF3050` at controlled luminance `0.95`) that cast rich colored reflections straight into the wet street gutters!
2. **Open-Frame Scaffold Neon Tube Signs (`OPEN 24H` Style — `+0` calls, merged into `G.steel` + `MegaBillboards`/`neonSigns`, 100% English)**:
   - Add dedicated open **steel lattice scaffolding frames** (`G.steel`) mounting bright glowing English tube-letter neon signs (`OPEN 24H`, `CYBER RAMEN`, `NIGHT BAR`, `MOTEL 09`) atop low rooftops, podium parapets, and projecting over avenue storefronts!
3. **Corrugated Sheet-Metal Low-Roof Shacks & Slum-Tech Extensions (`+0` calls — merged into `G.archPaint` & `G.steel`)**:
   - On low building podiums (`Y = 4–8 m`), alley corners, and `L_SHAPE` roofs, add compact **slanted corrugated sheet-metal roof huts/extensions** (`3–5 m` wide, dark rusted/gunmetal ribbed metal roofs with `aAo` catching vivid neon reflections from overhead signs + small exterior AC/pipe attachments).
4. **Overhead Steel Gantry / Sign-Truss Arches With Red Beacon Dots (`+0` calls — merged into `G.steel` & `aviation`)**:
   - Span `4–6` heavy industrial **open-truss steel overhead gantries** across avenues and between mid-rise roofs (`Y = 12–22 m`, grapple-able!), studded along their upper truss chords with tiny blinking **red warning beacon LEDs**!
5. **Upgraded Close-Up Street Lamps (`+0` calls — replaces existing `lamps`)**:
   - Bolted octagonal steel base flange, chest-height maintenance fuse box with tiny status LED, ribbed mounting collar brackets, hanging small neon-trimmed street banner flag on alternating avenue poles, and curved twin-arm luminaire heads!
6. **Hanging Paper Lantern Strings (`Chochin`) & Sidewalk Cafe Parasol Umbrellas (`StreetFurnishingsKit` `InstancedMesh`, `cap: 300`, `+1` draw call — designed with variants `0..3` so 10D ramen carts & bus shelters share the same draw call!)**:
   - Variant 0: **Festoon String of Glowing Red/Warm-Orange Cyberpunk Paper Lanterns** (`5` ribbed ovoid lanterns on a sagged wire with warm glowing cores) hung across `CYBER_EATERY` storefronts, narrow alleys, and Kowloon canal streets!
   - Variant 1: **Rain-Wet Sidewalk Cafe Parasol Umbrella** (`radius 1.25 m`, octagonal dark crimson/charcoal canopy on steel pole with warm underside lamp glow) tucked beside `CYBER_EATERY` terraces & sidewalk rails!

---

## PHASE 10D — Living Cyberpunk World Animations, Landmarks & Procedural Audio Immersion (`src/world/CityAtmosphere.ts`, `AudioEngine.ts`)

> [!IMPORTANT]
> **Authoritative Detailed AAA Spec**: See [`PHASE10D_SPEC.md`](PHASE10D_SPEC.md) for exact coordinates, lane math (including Sector 3 crossing anti-overlap & Sector 5 ring loop), `furnishingsAtlas` English signage, shader contracts, screenshot-audit visual fixes (tapered Coupe V-nose splitter, dual-lobe Mie `LampHalos`, richer covered market stalls), and unit tests. The section below is kept as a high-level summary.

### 10D-1. Elevated Highway Moving Cyber-Traffic (`CityAtmosphere.ts`, `ElevatedTraffic` `InstancedMesh`, `cap: 36`, `+1` draw call)
* Stream **24–36 stylized low-poly moving cyber-traffic vehicles** gliding smoothly along the elevated highways (and distant sky-lanes) at `18–28 m/s` on a deterministic loop (pure GPU/lightweight matrix update, zero allocations).
* Each car carries bright white/cyan headlights (`front`), blazing crimson taillight bars + **subtle elongated trailing red light ribbons** (`rear`), creating the iconic Cyberpunk 2077 flowing rivers of highway light!
* **Gameplay Safety**: Keep moving traffic smoothly phased on the **outer/dedicated traffic lanes** (non-lethal or gentle lateral bump away if the player steps directly into their path, never unfair instant death!).

### 10D-2. GPU-Animated Micro-Environment & Street Landmarks (`CityAtmosphere.ts`, `+1` net draw call!)
1. **`AnimatedEnvKit` (`InstancedMesh`, `cap: 220`, `+1` draw call, 100% GPU-animated via `uTime`!)**:
   - Variant 0 (**Spinning Industrial Exhaust Fans**): Circular steel vent housing with 6 angled fan blades rotating smoothly around local Z (`uTime * speed`) over a dim warm-orange/cyan backlit vent slit, mounted on `ALLEY_INFRA` / `CYBER_EATERY` walls and rooftop ducts!
   - Variant 1 (**Wind-Swaying Eatery `Noren` Curtains & Vertical Alley Banners**): Split fabric/vinyl shop curtain panels hanging under `CYBER_EATERY` awnings and narrow alley overhangs, gently rippling and billowing in the rainy night wind via vertex-shader sine displacement (`y`-pinned at top)!
   - Variant 2 (**Giant Slowly Spinning Rooftop Corporate Wireframe Holograms**): Crisp opaque thin-strut counter-rotating neon wireframe logo rings / cyber-emblems (`diameter 6.8 m`) hovering above tall flat `STEPPED_SETBACK` and `TOWER` rooftops (clearing `machineRooms` and excluding spire/slant caps; see `PHASE10D_SPEC.md` §10D-2)!
2. **Street Landmarks Added to Existing `StreetFurnishingsKit` (`+0` Extra Draw Calls!)**:
   - Variant 2 (**Steaming Cyberpunk Ramen Street-Vendor Cart**): Tucked into `L_SHAPE` courtyards and compact market pockets — wheeled stainless steel stall, glowing warm menu backboard, hanging canopy roof, stacked bowls, and anchored rising steam puff!
   - Variant 3 (**Illuminated Holographic Bus-Stop Shelter**): Placed along major avenue sidewalks (`2–4` per sector) — cantilevered dark steel & rain-streaked glass canopy, backlit glowing transit map panel, and integrated metal waiting bench!
3. **Alley Electrical Sparks & Canopy Rain Drips (`EffectsPool.ts`, `+0` extra draw calls)**:
   - Register `8–12` faulty alley breaker boxes / flickering neon signs that periodically emit tiny **blue-white electrical spark bursts** every `4–9 s` (plus subtle 3D crackle SE when within `14 m`, skipped beyond `52 m`).
   - Emit occasional crisp vertical rain-drip streaks falling off nearby storefront canopies when the player walks beneath them.

### 10D-3. Procedural Audio Immersion (`AudioEngine.ts`, `EnemyManager.ts`)
1. **Approaching `ALERT` Enemy Wet Footsteps**: When a grounded enemy in `ALERT` is walking toward `investigatePos` within `22 m` of the player, play subtle 3D HRTF-panned wet-pavement splash steps synced to its stride cycle so stealth players can HEAR an enemy coming around a dumpster!
2. **Synthetic Enemy Radio Vocoder Squelch**: Short, atmospheric garbled bandpass-modulated radio chirp bursts (`120–240 ms` squelch + formant sweep) when an enemy escalates `ALERT -> DETECTED` or broadcasts `COMBAT`.
3. **Speed-of-Sound Delayed Rolling Distant Thunder**: Hook into the existing `lightningAt(t)` sky lightning schedule — `1.5–3.0 s` after each distant lightning flash, trigger a deep, low-frequency rolling procedural thunder rumble (`lowpass pink noise 95 -> 38 Hz` over `3.2 s`, panned toward the lightning azimuth)!

---

## Strict Draw-Call Budget Audit Across ALL of Phase 10 (`<= 120 calls / frame`)

| Sub-Phase | Additions / Consolidations | Net Draw Call Delta |
| :--- | :--- | :---: |
| Phase 9B Baseline | Existing city, props, enemies, VFX, ViewModel, PostFX | `~96–104` |
| **Phase 10A** | `PropContactShadows` (`+1`), `MuzzleFlash` (`+1` transient), `BulletScorchDecals` (`+1`), `EnemyScannerCones` (`+1`) + Early Consolidation (`ClutterDebrisKit` `-1`, `SteelFixturesInstanced` `-2`) | **`+1`** |
| **Phase 10B** | `MegaBillboards` (`+1`), `BillboardMist` packed in `lampHalos` (`+0`), 4 Megastructures & filled lots (`+0` merged into `G.*`) | **`+1`** |
| **Phase 10C** | Hero 3 Cars / Vending / Lamps (`+0` replace), Curb LEDs/Scaffolds/Shacks/Gantries (`+0` merged), `StreetFurnishingsKit` (`+1`) | **`+1`** |
| **Phase 10D** | `ElevatedTraffic` (`+1`), `AnimatedEnvKit` (`+1`), Ramen Carts & Bus Shelters in `StreetFurnishingsKit` (`+0`), Sparks/Audio (`+0`) | **`+2`** |
| **GRAND TOTAL** | **Sector 4 Maximum Density (all 14 enemies + active combat)** | **`~101–109` (Hard Cap: `<= 120`!)** |

* **Safety Valve**: If Sector 4 ever exceeds `116` calls, merge `BillboardMist` into `lampHalos` (`-1`), merge `ClutterCardboard` + `ClutterTrashBins` via `aVariant` (`-1`), or merge `StreetLifeKit` + `StreetLandmarksKit` (`-1`).

---

## Per-Sub-Phase Verification Checklist
* **10A**: `npm run build` + `npm test` pass; MSAA `2`, half-res Bloom, `CITY_LIGHTS_MAX = 12`, pixel cap `<= 2.2M px`, late pre-render look sync, `shadows` & `showPerf` toggles; flat realistic wet asphalt (no mercury waves / X-seams); non-glow prop Bloom clamp (`<= 0.86`); weathered detail + city lights on props & steel; `PropContactShadows`; solid ramp abutment + T-piers; unit tests proving **zero floating neon signs** & **`>= 18 m` 360° blimp clearance**; 3D muzzle flash, cooling bullet scorches, sniper barrel steam/casings & 4x rangefinder; 5 live-preview screen filters; unit-tested mobile `ALERT` investigation movement + enemy flashlight scanner cones; top-left `136×136` circular pulse radar (Option C, zero 3D wallhack).
* **10B**: `npm run build` + `npm test` pass; **100% English-only signage verified** (zero Japanese characters anywhere in `ProceduralTextures.ts` signs/billboards/tickers/graffiti); `>= 92%` lot fill (zero barren empty lots/edges); `LockdownBarrier` invisible beyond `14 m`; `2048×1024` Mega-Billboards + 90° L-corner wrap-around screens + vertical monolith blades + colored rain-mist halos (strictly bound to `FaceSpan`s); all 4 megastructures (`X_TRUSS_TOWER`, `CYLINDER_RING_TOWER`, `TWIN_ARCH_GATE`, `SLANT_CORP_TOWER`) & 5 distinct sector identities verified.
* **10C**: `npm run build` + `npm test` pass; sculpted 3-variant hero vehicles (Supercar Coupe with splitter/scoops/GT wing/multi-spoke wheels, Pickup Truck with grille/plate/bed, Armored Van); high-detail recessed vending machines with `512×512` product/can atlas; glowing curb LED strips; open-frame English `OPEN 24H` roof/facade neon scaffolds; corrugated low-roof shacks; overhead steel gantries with red beacon dots; detailed street lamps; hanging lantern strings (`chochin`) & sidewalk cafe umbrellas; `+1` net draw call verified.
* **10D**: `npm run build` + `npm test` pass; flowing elevated highway cyber-traffic with headlight/taillight streaks; GPU-animated spinning exhaust fans, wind-swaying eatery `noren` curtains, and spinning rooftop corporate holograms; courtyard ramen carts & avenue bus-stop shelters; periodic alley junction sparks; 3D wet footsteps for approaching `ALERT` enemies, enemy radio vocoder squelch, and delayed rolling thunder synced to sky lightning; **`renderer.info.render.calls <= 120`** confirmed in Sector 4 at full density with smooth 60fps and zero WebGL warnings.
