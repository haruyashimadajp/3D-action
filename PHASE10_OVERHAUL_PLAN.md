# STRAND // PROTOCOL — Phase 10 Master Specification: Visual Realism Fixes, Zero-Lag 60fps Pipeline, Muzzle Flash, Screen Filters, Investigation AI, Pulse Radar, Zero Empty Lots, Giant Mega-Billboards & Iconic Cyber Megastructures (10A & 10B)

**Target Implementer**: Claude (TypeScript / Three.js / WebGL2 / Web Audio API)  
**Target Codebase**: `strand-protocol/` (on top of Phase 9B `7fdf96c`)  
**Master Spec Alignment**: `GAME_DESIGN_SPEC.md` v1.7

> [!IMPORTANT]
> **Hard Non-Negotiable Constraints (Zero Regression)**
> 1. **Locked 60fps & Ultra-Low Mouse Latency FIRST**: Every visual addition MUST preserve smooth 60fps on macOS Chrome Retina (`renderer.info.render.calls <= 120` in ALL 5 sectors, zero per-frame heap allocations).
> 2. **100% Procedural WebGL2 + Web Audio API**: Zero external image/model/audio files.
> 3. **Preserve Core Pillars**: Exclusive gun⇄grapple switching (hanging allowed), 3-phase telegraph lines, 100 HP / 3.0s regen / 0.5s retry, zero shooting aim assist, airborne Bullet Time, 4-state stealth AI, and clean parallel wall-run faces (`>= 2` per tower + narrow alleys).
> 4. **Split Execution Order**: Implement, build, and test **Phase 10A** completely first; then implement and verify **Phase 10B**.

---

## PHASE 10A — Zero-Lag Mouse & 60fps Pipeline, Critical Visual Bug Fixes, Muzzle Flash, Selectable Filters, ALERT Investigation AI & Circular Pulse Radar

### 10A-1. Root-Cause Mouse Lag & GPU Fill-Rate Optimization (`src/engine/Renderer.ts`, `src/main.ts`, `src/world/CityBuilder.ts`, `src/config/constants.ts`)
Live testing on macOS Chrome Retina revealed noticeable mouse lag caused by GPU frame-queue saturation (`DPR 1.5` × `MSAA 4x HalfFloat` × full-res `UnrealBloomPass` × `20` per-fragment dynamic point lights). Fix this at the pipeline root:
1. **Halve Bloom Fill-Rate (`Renderer.ts`)**:
   - Initialize and resize `UnrealBloomPass` at **half resolution** (`Math.max(128, Math.floor(w * 0.5)), Math.max(128, Math.floor(h * 0.5))`). Bloom is inherently blurred, so half-res Bloom looks virtually identical while cutting Bloom GPU time by ~75%.
2. **Smart MSAA & Pixel Budget Cap (`Renderer.ts`, `constants.ts`)**:
   - Change `RENDER.MSAA_SAMPLES` from `4` → **`2`** on `HIGH` (and `0` on `MEDIUM`/`LOW` and when `lowLatency` is enabled).
   - Cap effective pixel budget on `HIGH` so `width * height * dpr * dpr <= 2_200_000` (e.g., `dpr = Math.min(window.devicePixelRatio, 1.25, Math.sqrt(2_200_000 / Math.max(1, w * h)))`), keeping Retina screens razor-sharp without choking Metal/ANGLE compositing.
   - Pass `desynchronized: true` (safely wrapped / optional fallback) when creating the WebGL2 context if `lowLatency` is enabled, or default `powerPreference: 'high-performance'`.
3. **Faster Dynamic City Lights (`CityBuilder.ts`, `constants.ts`)**:
   - Reduce `RENDER.CITY_LIGHTS_MAX` from `20` → **`12`** (nearest 12 lights sorted around camera).
   - In `GLSL_CITY_LIGHTS`, add a fast **squared-distance early-out** (`float d2 = dot(Lv, Lv); if (d2 > R2) continue;`) BEFORE `sqrt`/`normalize`/`GGX` so distant lights cost almost zero ALU cycles.
   - Skip `strandCityLights` evaluation in `CityPropMeshes.ts` beyond `28 m` from `cameraPosition`.
4. **Late-Frame Pre-Render Mouse Look Flush (`src/main.ts`)**:
   - Keep `requestPointerLock({ unadjustedMovement: true })` in `InputManager.ts`.
   - In `main.ts`, right BEFORE `this.player.updateCamera(...)` and `this.renderer.render(...)`, call `this.input.consumeLook(_lookDelta)` a second time (after fixed simulation steps finish) and apply any fresh mouse delta that arrived during physics/AI work directly to `this.player.applyLook(...)` so rendered camera pose is always 0-frame fresh!
5. **Optional Lightweight Player-Centered Shadows Setting (`SaveSettings.shadows: boolean`, default `false`)**:
   - Add `shadows: boolean` to `SaveSettings` (default `false` to guarantee locked 60fps).
   - When toggled `ON` in Settings: enable `renderer.shadowMap.enabled = true` (`THREE.PCFSoftShadowMap`, `1024 × 1024`), attach a lightweight `±36 m` frustum centered on the player (snapped to texel grid every frame to avoid shimmer) on `moonLight`, casting shadows from main towers, highways, and dumpsters. When `OFF`, `shadowMap.enabled = false` with zero cost.

### 10A-2. Critical Visual Bug Fixes (Verified From Live Screenshots!)
1. **Fix "Melted Silver Mercury / Lumpy Plastic" Wet Road & Alley Floor (`CityBuilder.ts`, `ProceduralTextures.ts`)**:
   - Live screenshots showed `GLSL_PUDDLE_RIPPLES` (`0.32 + 0.22`) combined with ultra-low puddle roughness (`0.06`) turning roads and narrow alleys into glossy lumpy wax/mercury waves, plus visible dark X-seam cracks in alleys.
   - **Exact Fixes**:
     - Reduce `GLSL_PUDDLE_RIPPLES` normal perturbation amplitude to **`0.055`** (octave 1, high-frequency `vCityWorld.xz * 4.5`) + **`0.035`** (octave 2, `vCityWorld.xz * 7.8`), producing crisp delicate raindrop micro-rings on a **flat** wet asphalt plane instead of undulating waves!
     - Raise minimum wet road/alley puddle roughness from `0.06` → **`0.13`** (dry damp asphalt `0.36–0.48`) and reduce `RENDER.STREAK_GAIN` slightly from `1.0` → **`0.72`** so wet reflections look like realistic rain-soaked asphalt, NOT chrome liquid.
     - Remove any harsh dark X-intersecting seam lines from the narrow alley concrete/road texture tile in `ProceduralTextures.ts` (replace with fine longitudinal pavement seams & subtle dark rain stains).
2. **Tone Down Over-Bloomed Highway Underside Neon Strip (`constants.ts`, `CityBuilder.ts`)**:
   - Live screenshots showed the highway underside cyan light strip blooming into a blinding turquoise laser beam across the screen.
   - Reduce `NEON_BLOOM.UNDERSIDE_STRIP` by ~`45%` (to `~0.85` — glowing cleanly right below harsh Bloom blowout) and narrow the strip width (`0.14 m` → `0.09 m`), preserving moody industrial underpass illumination without washing out the screen.
3. **Fix Blinding White Glowing `WIRE_RACK`, Over-Bright Props & Flat Untextured Materials (`CityPropMeshes.ts`, `CityBuilder.ts`)**:
   - **Root Cause Found**: `WIRE_RACK` metal bars (`0xa8aeb4`, `roughness 0.36`) + un-clamped city-light specular + bright matte props (`JERSEY 0xb8b4aa`, bright yellow/cream bins) exceeded the `0.92` Bloom threshold or stood out as flat untextured Roblox/Lego blocks!
   - **Exact Fixes**:
     - **Wire Rack & Prop Palette Calibration**: Darken `WIRE_RACK` frame steel to matte gunmetal (`0x3c424a`, `roughness 0.58`), dampen bright prop tints by ~`35–45%` into authentic rain-soaked night values (weathered dark concrete jersey barriers `0x4e5258`, damp brown cardboard `0x3e3024`, muted bins/crates, weathered dark-olive/charcoal doors).
     - **Strict Bloom Guard on Non-Emissive Props**: In `CityPropMeshes.ts` fragment shader (`#include <dithering_fragment>` or right after `strandCityLights`), clamp `outgoingLight` on non-emissive prop parts (`strandP != 3.0 && strandP != 5.0 && strandP != 8.0`) to `min(outgoingLight, vec3(0.86))` so NO metal rack, concrete barrier, or plastic bin EVER accidentally triggers white Bloom glow!
     - **Bind Procedural Surface Detail to ALL Props (`CityPropMeshes.ts`) AND Steel (`steelMat`)**:
       - Pass `tex.archDetail` (weathered paint scuffs, rust mottling, normal bump, roughness variation) into BOTH `createKitMaterial` (sampled via world-space triplanar-lite `vCityWorld` UV at `1.2 m` tile — zero extra vertex UVs needed!) AND `this.steelMat`!
       - Also call `this.injectCityLights(shader)` on `this.steelMat` so all wet building pipes, fire escapes, exterior apartment railings, and overhead cable racks catch realistic wet neon sheen instead of flat dead grey!
     - **Fix Flat Cyan-Green Apartment/Shop Wall Panels**: In `BuildingGrammar.ts`, reduce the frosted/backlit display panel emissive luminance (`0.48` → `0.24`) and overlay crisp recessed dark vertical frame mullions + subtle grime gradient so `GALLERY_DANCHI` corridors & `TECH_APPAREL` vitrines look deeply architectural instead of flat neon green rectangles.
4. **Cheap Ground Contact Shadow Decals (`CityPropMeshes.ts`, `+1` draw call)**:
   - Add a single pooled `InstancedMesh` (`PropContactShadows`, `cap: 420`, `+1` call) rendering soft radial dark multiply/alpha shadow quads flush at `Y = 0.012 m` (`depthWrite: false`, `polygonOffset`) directly beneath every dumpster, jersey barrier, bench, trash-bin cluster, vending kiosk, and parked car. Instantly eliminates the "floating prop" look at virtually zero GPU cost even with real shadows `OFF`!

### 10A-3. First-Person 3D Gunshot Muzzle Flash (`src/player/ViewModelRenderer.ts`, `src/engine/Renderer.ts`)
Add crisp, weapon-specific procedural 3D muzzle flash meshes parented directly to each gun's `muzzle` `Object3D` in the first-person viewmodel scene (`+1` shared additive material, `0` per-frame allocations):
* **Geometry**: Crossed 3-plane star burst + tapered forward plasma jet cone + dual small lateral muzzle-brake vent jets (visible only on Sniper). Randomly rolls around Z (`0..2π`) and micro-scales (`0.85–1.18x`) on every shot for organic variety!
* **MK-IV Suppressed Rail Pistol**:
  - Compact, tight, high-tech suppressed muzzle flash (`length ~0.09 m`, `radius ~0.045 m`, duration `45 ms`, bright cyan-white core `#C8FFFF` → `#38F8FF` outer fringe) — visually snappy and gratifying WITHOUT obscuring the open holo sight!
* **K-90 Rail Sniper**:
  - Dramatic high-energy electromagnetic rail flash (`length ~0.24 m`, `radius ~0.11 m` + blazing **lateral muzzle-brake side vents** `±0.10 m` wide, duration `75 ms`, hot white-cyan core `#FFFFFF` → electric cyan `#38F8FF` / violet-blue outer edge) + intense `70 ms` dynamic muzzle `PointLight` illuminating the receiver, hands, and nearby alley walls!

### 10A-4. 5 Selectable Atmospheric Full-Screen Filters (`src/engine/Renderer.ts`, `src/config/skills.ts`, `src/ui/HudManager.ts`)
Give the player a **Visual Filter (`FILTER`)** selector in the Settings menu (persisted in `SaveSettings.filter` inside `strand_protocol_save_v1`, `+0` extra draw calls — executed inside the existing `KineticPostFX` fragment shader!):

```ts
export type ScreenFilterId = 'CYBER_NOIR' | 'NEON_OVERDRIVE' | 'COLD_STEEL' | 'AMBER_DUST' | 'RAW';
```

| Filter ID | Display Label | Visual Signature (Pre-Output Grading in `KineticPostFX`) |
| :--- | :--- | :--- |
| **`CYBER_NOIR`** *(Default)* | `CYBER NOIR` | Deep rain-soaked teal-indigo shadows, slightly deepened blacks (fixes washed-out grey haze), crisp warm-amber/cyan neon highlights, cinematic S-curve `0.16`, gentle vignette `0.18`. |
| **`NEON_OVERDRIVE`** | `NEON OVERDRIVE` | Rich high-contrast cyberpunk saturation (`+22%` vibrance), deep purple-blue shadows, punchy magenta/cyan mid-high boost, strong night-city arcade pop. |
| **`COLD_STEEL`** | `COLD STEEL` | Clinical Ghost-in-the-Shell / Matrix cool blue-slate desaturation (`saturation 0.72`), crisp contrast — makes crimson enemy visors & amber alert icons pop brutally. |
| **`AMBER_DUST`** | `AMBER DUST` | Blade Runner 2049 atmospheric sodium-amber smog warmth in mids/highlights paired with deep charcoal-brown shadows and soft film grain. |
| **`RAW`** | `RAW (OFF)` | Pure neutral ACES Filmic pass-through with zero stylistic tint. |

### 10A-5. Fix `ALERT` Enemy Investigation Behavior (`src/entities/EnemyManager.ts`, `src/config/enemies.ts`)
Live playtesting showed mobile enemies entering `ALERT` stopped walking to inspect where they spotted/heard the player whenever the player was slightly elevated (`dy >= 2.5 m`) or gauge decay pulled them back to `UNAWARE` before arriving.
* **Required Exact Behavior**:
  1. Applies to all **mobile enemies**: `ENFORCER`, `AEGIS`, `PHANTOM`, and `DRONE`. (`VEIL` rooftop snipers remain perched and sweep their gaze toward `investigatePos`.)
  2. Whenever a mobile enemy enters `ALERT` (from vision, proximity, or gunshot) or receives an updated stimulus while in `ALERT`:
     - Store `e.investigatePos` AND compute a **ground-reachable horizontal approach point** (`investigateGoal`: same `(x, z)` at enemy's walkable floor `y` for ground units — NEVER abort investigation solely because `Math.abs(investigatePos.y - e.pos.y) >= 2.5`! For `DRONE`, fly directly to `investigatePos + (0, 3.5, 0)`).
     - Set `e.investigating = true`, `e.investigateScanT = 0`, `e.investigateWalkT = 0`.
  3. **Pause Gauge Decay While En Route**:
     - While `e.alertState === 'ALERT'` and `e.investigating === true` (actively moving toward `investigateGoal`), **freeze `alertGauge` decay** (clamp floor at `Math.max(e.alertGauge, 25)`) so the enemy ALWAYS finishes walking over to check the spot instead of turning back halfway!
     - Move toward `investigateGoal` at brisk alert speed (`0.80 × combatSpeed`, avoiding obstacles cleanly).
  4. **Inspect & Resume Decay**:
     - Once the enemy arrives within `<= 2.2 m` horizontally of `investigateGoal` (OR hits a `7.0 s` movement-stall safety timeout `investigateWalkT >= 7.0` if blocked by an unreachable wall/courtyard):
       - Stop and sweep its head/body gaze left-and-right (`±60°` while looking up slightly if `investigatePos.y > e.pos.y + 1.5`) for **`2.0 s`** (`investigateScanT`).
       - After the `2.0 s` inspection sweep finishes without spotting the player, set `e.investigating = false` and **resume normal `alertGauge` decay (`-14 pt/s`) down to `0 -> UNAWARE`**, then return to patrol!

### 10A-6. Minimal Circular Pulse-Scan Mini-Radar (`src/ui/HudManager.ts`, `src/main.ts`, `index.html`)
**Option C strictly**: Top-left corner circular pulse-scan mini-radar ONLY (**NO** 3D wallhack markers floating in world space!).
* **Placement & Style**:
  - Top-left (`left: 24px, top: 24px`, diameter **`136 px`**, lightweight HTML5 `<canvas>` overlay — `+0` WebGL draw calls!).
  - Sleek dark translucent circular housing (`rgba(6, 12, 22, 0.62)`), thin `1px` cyan rim (`#00F0FF` at `0.35` alpha), subtle concentric range rings (`25 m` / `50 m` / `75 m`), forward FOV cone wedge, and player center chevron always pointing UP (player-relative rotation using `-player.yaw`).
* **Periodic Pulse-Scan Mechanics (Exact Spec)**:
  - Radar range: **`75.0 m`** (enemies beyond `75 m` clamp as faint edge ticks on the outer ring during a sweep so the player NEVER wastes time hunting a stray last enemy!).
  - **Sweep Period**: Every **`3.5 s`**, a crisp rotating/expanding cyan pulse ring sweeps from center (`0 m`) to outer rim (`75 m`) over `0.65 s` (accompanied by a very subtle, low-volume high-tech sonar ping SE in `AudioEngine.ts` when enemies are alive — muted during pause).
  - **Ping Snapshot & Fade**: When the pulse wave crosses an enemy's distance, its blip position `(x, y, z)` and state snapshot refresh to `alpha = 1.0`, then **smoothly fade over `3.2 s`** down to `alpha = 0.18` until the next pulse refreshes it (giving authentic tactical "periodic radar scan" feel rather than cheap constant GPS tracking!).
  - **Color & Elevation Coding**:
    - `UNAWARE`: cool cyan (`#38F8FF`)
    - `ALERT`: amber yellow (`#FFCC22`)
    - `DETECTED`: bright orange (`#FF6A1A`)
    - `COMBAT`: crimson red (`#FF2244`, slight pulse)
    - **Verticality Indicator**: If enemy `y - player.y >= 3.5 m`, draw a tiny `▲` above the blip; if `y - player.y <= -3.5 m`, draw a tiny `▼` below the blip!

---

## PHASE 10B — Zero Empty Lots, Giant Reference-Grade Mega-Billboards, 4 Iconic Cyber Megastructures & Distinct Sector Identities

**Goal**: Close the remaining gap toward the two target reference aesthetics (`neon-cyberpunk-city-stockcake.jpg` & `art-intro@2x-9cab572b.jpg`) — **dense wall-to-wall skyscrapers with ZERO barren empty lots, massive avenue-facing & L-corner wrap-around illuminated digital billboards, unmistakable non-rectangular megastructure silhouettes, and distinct visual identities across Sectors 1–5** — while holding `renderer.info.render.calls <= 120` and locked 60fps!

### 10B-1. Eliminate Barren Empty Lots & Barren Perimeter Edges (`src/world/CityBuilder.ts`, `src/config/skills.ts`)
Live Screenshot 3 revealed huge barren empty concrete lots in the middle and edges because `CityBuilder` stopped placing buildings at `sector.buildingCount` (`14–22`) and left all remaining lots as empty `plazas`.
* **Exact Fixes**:
  1. **Build on `>= 92%` of ALL Generated Lots**:
     - Remove the hard truncation `chosen = ...slice(0, sector.buildingCount)` that discarded spare lots!
     - Use `sector.buildingCount` as a **minimum**, and fill **ALL remaining valid lots** (`lotW >= 10 m && lotD >= 10 m`) with real buildings (a lively mix of low-rise `16–28 m` infill commercial blocks, mid-rise `28–48 m` apartments, and tall `50–95 m` towers — while still capping extreme-edge parking pockets to at most `1` small compact plaza per sector, NEVER empty fields!).
  2. **Dense Micro-Fill for Any Remaining Tiny Pocket (`< 10 m` or the single compact courtyard)**:
     - Never leave a bare concrete slab with 2 benches! Any single small open pocket becomes a **dense covered cyber street-market / compact multi-tier parking bay** with overhanging overhead neon canopies, illuminated kiosk clusters, parked cybercars, jersey barriers, steaming manholes, and cross-strung cables.
  3. **Tighten Perimeter Skyline Framing**:
     - Ensure perimeter lots right along `±H` ALWAYS receive full-height towers (`>= 36 m`) + mega-billboards facing inward toward the district so the player never sees barren flat ground leaking out to the horizon!
     - Bring the closest ring of `farTowers` tighter (`115–220 m` radius instead of distant gaps) with varied heights (`55–180 m`) so the skyline feels like an endless canyon of megastructures from every street angle.

### 10B-2. Giant Avenue-Facing Mega-Billboards & 90° L-Corner Wrap-Around Screens (`src/engine/ProceduralTextures.ts`, `src/world/CityBuilder.ts`, `+1` draw call)
Inspired directly by the reference images (`NEO-TOKYO REALTY`, `CYBERNETICS NOW`, `DATA FLOW`, `BELOW DECK`, towering vertical neon monoliths):
* **New Procedural Mega-Billboard Texture Atlas (`tex.megaBillboard`, `2048 × 1024`, `4 × 2` = 8 distinct high-craft screens)**:
  - Each `512 × 512` cell is painted with rich, unmistakable cyberpunk graphic design (NOT tiny unreadable strips!):
    - Cell 0 (**Cyan/White Corp Banner**): `NEO-TOKYO REALTY` bold wide sans typography + blueprint grid lines + architectural wireframe silhouette + bright cyan border frame.
    - Cell 1 (**Magenta/Violet Hologram Data**): `DATA FLOW // 09` bold diagonal tech bars + cascading matrix/code data columns + glowing magenta scanlines.
    - Cell 2 (**Acid-Lime/Yellow Cyberware Ad**): `CYBERNETICS NOW` bold stencil header + glowing bionic eye/circuit emblem + technical spec bars.
    - Cell 3 (**Vertical Tall Portrait / Cyber Idol Screen** — for tall vertical `1:3` billboards like Ref 6!): Stylized glowing neon portrait silhouette (warm coral/magenta/gold halftone scanline face + `BELOW DECK` bold footer logo!).
    - Cell 4 (**Crimson Vertical Monolith Emblem** — like Ref 6 center red tower!): High-contrast blazing crimson geometric hexagon sigil + vertical Japanese katakana column (`サイバー・プロトコル // 禁区`).
    - Cell 5 (**Teal/Cyan Optics Ad**): `KIROSHI // OPTICS` + concentric target reticle rings + katakana subhead (`その目で未来を`).
    - Cell 6 (**Warm Orange Ramen/Street-Food Mega Sign**): Stylized glowing neon noodle bowl emblem + `SYNTH NOODLES // 24H` + diagonal hazard corner accents.
    - Cell 7 (**Deep Blue Tech Corp**): `SOFTSYS // CORE` + isometric server-rack wireframe + scrolling telemetry bar graphics.
* **Single `InstancedMesh` (`MegaBillboards`, `cap: 140`, `+1` draw call)**:
  - Custom shader with crisp subtle LCD pixel-grid/scanlines, animated vertical scroll shimmer on data panels, controlled emissive HDR (`1.15–1.55` so screens glow vibrantly with Bloom halos without blowing out into solid white rectangles!), and soft backlit haze frame.
  - **3 Placement Formats**:
    1. **Giant Avenue-Facing Wall Screens**: Width `10–20 m` × Height `10–34 m` mounted proudly (`+0.35 m` steel mounting truss frame merged into `G.steel`) on major avenue-facing buildings at `Y = 12–60 m`.
    2. **90° L-Corner Wrap-Around Screens (Reference Image 5 Signature!)**: On prominent street-corner towers, pair TWO synchronized billboard instances meeting flush at the `90°` corner edge (`Y = 10–44 m`, 2–4 stacked tiers per hero corner tower!) with a dark steel corner trim spine, creating authentic wrap-around illuminated corner billboards!
    3. **Towering Vertical Neon Monolith Blades (Reference Image 6 Signature!)**: Narrow ultra-tall protruding monolith signs (`width 3.2–4.5 m × height 18–38 m`) mounted off upper tower edges/roofs in blazing crimson, electric cyan, or hot magenta!

### 10B-3. 4 Iconic Cyber-Megastructure Silhouettes (`src/world/BuildingGrammar.ts`, `src/world/CityBuilder.ts`)
Extend `MassingKind` with **4 unmistakable skyline-defining cyber megastructures** (in addition to Phase 9's `L_SHAPE`, `PODIUM_OFFSET`, `STEPPED_SETBACK`, `GALLERY_DANCHI`, `PENCIL_TOWER`) so NO sector ever looks like "a bunch of identical vertical boxes":
1. **`X_TRUSS_TOWER`** (Ref 6 left tower):
   - Heavy industrial corporate tower (`44–92 m`) wrapped on its upper shaft (`Y = 8 m -> roofY`) with bold protruding **external diagonal X-brace steel exoskeleton trusses** (`beam thickness 0.45 m` in `G.steel`, 12 m vertical bays, zero extra draw calls!) + cantilevered stepped overhang crown + glowing corner corp logo sign.
2. **`CYLINDER_RING_TOWER`** (Ref 6 far-right tower):
   - **12-sided cylindrical/faceted tower shaft** (`radius 6.5–9.5 m`, height `38–84 m`, sitting on a square 1F–2F `8 m` podium so street-level 5-program storefronts remain flush and grounded!) wrapped with **3–4 tiered protruding circular neon advertisement rings** (`G.strips` + `MegaBillboards` curved/faceted bands) and a blazing crimson/cyan **crown halo + tall radio spire**!
   - Clean inscribed box collider (plus podium collider) so navigation & grapple work seamlessly.
3. **`TWIN_ARCH_GATE`** (Ref 6 right-center arch):
   - On a wide lot (`>= 22 m` long side) or paired across a narrow alley: split the upper tower above `Y = 8 m` into **two twin vertical slabs** separated by a `6–8 m` dramatic vertical void, joined near the top (`Y = roofY - 12 m -> roofY`) by a **monumental neon-framed sky-arch bridge truss** with glowing vertical magenta/cyan inner-void edge strips! Players can grapple right through the sky-arch gap!
4. **`SLANT_CORP_TOWER`**:
   - Bold cantilevered megacorp tower featuring an **angled sloped top crown** (stepped diagonal roof terrace + dramatic beveled slant cap in `G.steel` / `G.concrete`, keeping main playable roof deck flat and solid for sniper perches!), vertical glowing spine ribs, and a dedicated upward searchlight beam.

### 10B-4. Distinct Sector Visual Identities (`src/config/skills.ts`, `src/world/BuildingGrammar.ts`, `src/world/CityBuilder.ts`)
Give each of the 5 sectors a clear, unmistakable architectural & atmospheric personality (while preserving all gameplay layouts, canals, highways, and combat readability):

| Sector | District Theme | Signature Massing Bias | Neon & Mega-Billboard Accent Palette |
| :--- | :--- | :--- | :--- |
| **SECTOR 01** | `NEON DOWNTOWN` | High mega-billboard density, `L_SHAPE`, `PODIUM_OFFSET`, `TWIN_ARCH_GATE`, 2+ `GALLERY_DANCHI` | Electric Cyan + Hot Magenta + Warm Eatery Amber |
| **SECTOR 02** | `KOWLOON CANAL` | Dense overhanging `GALLERY_DANCHI` apartments flanking canal + `L_SHAPE` markets + glowing truss bridges | Warm Sodium Amber + Jade Cyan + Steaming Coral Lanterns |
| **SECTOR 03** | `INDUSTRIAL INTERCHANGE` | Heavy `X_TRUSS_TOWER` exoskeletons + `PENCIL_TOWER` shafts + crossing expressways & tight shadow alleys | Crimson Red + Industrial Hazard Orange + Cold Steel Blue |
| **SECTOR 04** | `MEGA-PLAZA OVERDRIVE` | Full Ref Image 6 skyline: `CYLINDER_RING_TOWER` + `TWIN_ARCH_GATE` + `STEPPED_SETBACK` + maximum L-corner Mega-Billboards | Full Multi-Hue Cyber Overdrive (Cyan / Magenta / Acid Lime / Crimson) |
| **SECTOR 05** | `VALKYRIE CITADEL` | Dramatic ring of `SLANT_CORP_TOWER` & `X_TRUSS_TOWER` monoliths + vertical crimson monolith blades framing the Boss Scramble Arena | Blazing Crimson + Pure White + Deep Royal Indigo |

---

## Draw-Call Budget Verification (`<= 120 calls / frame`)
* Phase 9B baseline: `~96–106 calls / frame`.
* Phase 10A delta:
  - `PropContactShadows` (`InstancedMesh`): `+1` call
  - First-person `MuzzleFlash` (in Pass 2): `+1` call (only visible for `45–75 ms` on shot)
  - Screen Filters (`KineticPostFX`): `+0` calls
  - Circular Mini-Radar (2D HTML `<canvas>`): `+0` WebGL calls
* Phase 10B delta:
  - `MegaBillboards` (`InstancedMesh`): `+1` call
  - All 4 new megastructures (`X_TRUSS_TOWER`, `CYLINDER_RING_TOWER`, `TWIN_ARCH_GATE`, `SLANT_CORP_TOWER`) & extra filled-lot buildings: **`+0` calls** (merged into existing `G.bodies`, `G.steel`, `G.concrete`, `G.strips`!)
* **Projected Sector 4 Total**: **`~99–109 calls / frame`** (strictly `<= 120`!) — AND significantly **faster GPU frame times** than Phase 9B thanks to 10A-1 (`MSAA 2x`, half-res Bloom, `CITY_LIGHTS_MAX = 12`, pixel cap)!

---

## Verification Checklist (Required Before Reporting Done)

### Phase 10A Verification
1. `npm run build` and `npm test` pass with zero errors.
2. **Zero-Lag Mouse & Smooth Frame Pacing**: Verify `MSAA = 2` (HIGH), half-res Bloom, `CITY_LIGHTS_MAX = 12` with squared-distance early-out, pixel cap `<= 2.2M px`, and pre-render late look delta application; optional `shadows` toggle defaults `false` and works cleanly when toggled `ON`.
3. **Screenshot Bug Fixes Confirmed**:
   - Wet streets & alleys look like flat, crisp rain-soaked asphalt with subtle micro-ripples (NO wavy silver mercury plastic look, NO dark X-seams).
   - Highway underside strip glows cleanly without blinding laser blowout.
   - `WIRE_RACK` and all non-glow props never blow out into white Bloom; all props (`CityPropMeshes`) and steel (`steelMat`) display weathered surface detail and catch city light reflections; ground contact shadows anchor dumpsters, cars, benches, and kiosks.
4. **Muzzle Flash**: Both Suppressed Pistol (compact cyan-white burst) and K-90 Sniper (dramatic plasma burst + lateral brake vents + dynamic receiver light) visibly flash on every shot without blocking the holo sight.
5. **5 Screen Filters**: Settings menu cycles `CYBER NOIR` / `NEON OVERDRIVE` / `COLD STEEL` / `AMBER DUST` / `RAW`, immediately updating the screen look and persisting across reloads.
6. **ALERT Investigation AI**: Unit test + live check proving that when an `ENFORCER`/`AEGIS`/`PHANTOM`/`DRONE` enters `ALERT` (including when player is elevated on a car/ledge), it pauses gauge decay, physically moves to inspect `investigatePos`, sweeps gaze for `2.0 s`, and ONLY THEN decays back to `UNAWARE`.
7. **Circular Pulse Radar (Option C)**: Top-left `136×136` circular radar sweeps every `3.5 s`, refreshes & fades enemy blips by state color + `▲`/`▼` verticality ticks, clamps far enemies as subtle edge ticks, and shows ZERO 3D wallhack markers.

### Phase 10B Verification
1. `npm run build` and `npm test` pass (add unit tests asserting `>= 90%` lot building coverage / zero large barren plazas, mega-billboard placement on avenue/corner faces, all 4 new megastructure kinds generating cleanly with valid colliders, and distinct per-sector theme palettes).
2. **Visual Density & Skyline**: Zero barren empty fields in center or perimeter edges; prominent avenue-facing giant billboards, 90° L-corner wrap-around screens, and towering vertical neon monolith blades clearly visible from street level.
3. **Distinct Sectors & Silhouettes**: `X_TRUSS_TOWER`, `CYLINDER_RING_TOWER`, `TWIN_ARCH_GATE`, and `SLANT_CORP_TOWER` visibly break up the skyline and differentiate Sectors 1–5.
4. **Performance Gate**: Verify `renderer.info.render.calls <= 120` in Sector 4 at full building/billboard density with zero WebGL errors or per-frame allocations.
