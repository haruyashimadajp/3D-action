# STRAND // PROTOCOL — Phase 12 Master Specification: AAA Screen-Space Rendering (Half-Res SSR & GTAO), Shelter-Aware Lens Raindrops, Space-Warping Shockwaves, Sky-Drop Intro, Dynamic Storm Weather & Enemy/Boss Visual Spectacle (12A & 12B)

**Target Implementer**: Claude / Antigravity AI (TypeScript / Three.js / WebGL2 / Web Audio API)  
**Target Codebase**: `strand-protocol/` (on top of Phase 11B)  
**Master Spec Alignment**: `GAME_DESIGN_SPEC.md` v1.9  
**Execution Strategy (Token-Optimal 2-Step Split)**: Complete, build, and verify **Phase 12A** cleanly first; then implement and verify **Phase 12B**.

> [!IMPORTANT]
> **Hard Performance & Stability Guardrails (Zero Regression)**
> 1. **Locked 60fps & Zero-Lag Mouse Preserved**: All new screen-space passes (`SSR`, `GTAO`) run strictly at **half viewport resolution (`0.5×`)**, have independent Settings toggles (`SaveSettings.ssr`, `SaveSettings.gtao`), and automatically disable on `LOW` quality and when `lowLatency` is active.
> 2. **WebGL2 Depth-Texture Safety (CRITICAL)**: NEVER bind a multisampled (`samples > 0`) `DepthTexture` directly as a fragment sampler (causes `GL_INVALID_OPERATION` on WebGL2 / macOS Metal ANGLE). Whenever `ssr || gtao` is enabled, switch Pass 1's render target to `samples: 0` with a standard `THREE.DepthTexture` (`THREE.UnsignedIntType`) and enable crisp inline **FXAA** inside `KineticPostFX` (`+0` extra scene passes, faster on macOS Chrome, 100% WebGL2-compliant!). When both `ssr` and `gtao` are `false`, retain standard `MSAA 2x`.
> 3. **Draw-Call Cap**: Strictly `renderer.info.render.calls <= 120` in Sector 4 (and Sector 5 Boss arena), zero per-frame heap allocations, 100% procedural WebGL2 & Web Audio API.

---

## PHASE 12A — Half-Resolution Wet SSR, Optional Half-Resolution GTAO, Shelter-Aware Camera-Lens Raindrops & Space-Warping Shockwave Refraction

### 12A-1. Shared Scene Depth Pipeline + Half-Res Wet Screen-Space Reflections (`src/engine/Renderer.ts`, `src/config/skills.ts`, `src/ui/HudManager.ts`)
* **Settings Persistence (`SaveSettings`)**:
  - `ssr: boolean` (default `true` on `HIGH`, `false` on `MEDIUM`/`LOW`/`lowLatency`)
  - `gtao: boolean` (default `true` on `HIGH`, `false` on `MEDIUM`/`LOW`/`lowLatency`)
  - `lensRain: boolean` (default `true` — toggleable for players who prefer a clean lens)
  - Expose all 3 toggles cleanly in Settings UI (`HudManager.ts`) with instant 1-frame live preview while paused!
* **WebGL2-Safe Depth + Inline FXAA Pipeline (`Renderer.ts`)**:
  - When `ssr || gtao` is active: allocate the composer's main `HalfFloatType` target with `samples: 0` and `depthTexture: new THREE.DepthTexture(w, h)` (`THREE.DepthFormat`, `THREE.UnsignedIntType`), and activate a lightweight `5`-tap **FXAA** pass inside `KineticPostFX` (or `OutputPass`) so edges remain crisp with ZERO multisampled depth-resolve issues.
* **Half-Resolution Wet-Surface SSR (`SsrPass`, `+1` Half-Res Fullscreen Pass)**:
  - Runs strictly at `0.5×` resolution (`Math.max(128, Math.floor(w * 0.5))`, `Math.max(128, Math.floor(h * 0.5))`) between `HdrSanitize` and `UnrealBloomPass` (so reflected neon signs & car headlights naturally feed subtle wet reflections without breaking Bloom!).
  - **Fast Wet-Floor Masking (Zero Wasted Rays on Walls/Sky!)**:
    - Reconstruct view-space & world-space position `P` from `tDepth` and `uInvProj` / `uInvView`.
    - Reconstruct smooth geometric world normal `N` via `normalize(cross(dFdx(P), dFdy(P)))`.
    - Early-exit (`return vec4(0.0)`) unless `N.y > 0.85` (horizontal wet surfaces: wet avenues `Y ≈ 0`, canal `Y ≈ -2.4`, elevated highway `Y ≈ 9.5`, flat rooftops) AND view distance `d < 68.0 m`!
  - **Adaptive 18-Step Screen-Space Raymarch**:
    - Compute reflected direction `R = reflect(normalize(P - cameraPosition), N)`.
    - Jitter initial step offset with temporal interleaved-gradient noise (kills stair-step striping).
    - March `18` exponentially growing screen-space steps (`tStep` from `0.35 m` up to `4.5 m`, thickness tolerance `0.45 m` scaling with distance) + `3` binary refinement steps on hit!
    - Smoothly fade at screen borders (`smoothstep(0.0, 0.08, uv) * smoothstep(0.0, 0.08, 1.0 - uv)`), fade by distance (`52 -> 68 m`), and weight by realistic Schlick Fresnel (`0.04 + 0.55 * pow(1.0 - max(dot(N, -V), 0.0), 4.0)`) × procedural wet puddle mask (strongest on canal water & glossy asphalt puddles, subtle on damp concrete!).
    - Composite cleanly over `tColor` (`+` blended reflection clamped below firefly blowout) so **giant Mega-Billboards, glowing cybercars, warm eatery fronts, moving highway traffic, and muzzle flashes reflect upside-down in real time on wet streets and the canal!**

### 12A-2. Half-Resolution Ground-Truth Ambient Occlusion (`GtaoPass`, `src/engine/Renderer.ts`)
* Runs at **half viewport resolution (`0.5×`)** right before `SsrPass` (`+2` tiny half-res fullscreen passes: 1 raw GTAO + 1 separable/bilateral `5`-tap depth-aware blur):
  - **8-Sample Horizon-Based AO**: Reconstructs view-space `P` & `N` from `tDepth`, evaluates 4 rotated horizon pairs (world radius `1.35 m`, screen radius clamped `[4, 36]` px, interleaved-gradient rotation per pixel, fades out smoothly `34 -> 48 m`).
  - **Emissive Protection Rule (CRITICAL)**: Multiply scene color by `mix(0.46, 1.0, ao)` weighted by `1.0 - smoothstep(0.75, 1.15, lum)` so dark architectural corners, under-desk interior niches, alley dumpsters, and `GALLERY_DANCHI` corridor seams gain deep soft contact shadows while glowing neon signs, enemy visors, and telegraph lines stay 100% vibrant!

### 12A-3. Shelter-Aware Screen-Space Camera-Lens Raindrops (`src/engine/Renderer.ts`, `src/main.ts`)
* Executed inside `KineticPostFX` (`+0` extra draw calls, controlled by uniform `uRainLens ∈ [0, 1]`):
  - Two-layer procedural tiled raindrop field (medium sliding drops with gravity streak tails + fine stationary micro-beads), computing radial lens normal offsets (`dUv = dropNormal * 0.018 * uRainLens`) that realistically **refract bright neon lights & billboards behind each droplet**!
  - Looking upward (`cameraPitch > 0.2 rad`) gently boosts drop density (`+30%`); high speed (`> 14 m/s`) slightly stretches drops radially outward.
* **Smart Overhead Shelter Detection (`main.ts`)**:
  - Every `150 ms` (using the fast Phase 10A `PhysicsWorld` 2D spatial grid — zero allocations!), cast 1 upward vertical ray from `player.eye` (`+Y`, `24 m`).
  - **Exposed to Sky**: `uRainLens` ramps smoothly toward the current sector's `rainIntensity` (`+0.35 / s`).
  - **Sheltered (Under Elevated Highway, Storefront Canopy, `GALLERY_DANCHI` Ceiling, or Inside a Phase 11 Enterable Interior)**: `uRainLens` smoothly dries off (`-0.90 / s` → `0.0`) so stepping indoors or under an awning genuinely feels protected from the downpour!

### 12A-4. Space-Warping Shockwave Refraction Distortion (`src/engine/Renderer.ts`, `src/main.ts`, `src/entities/EffectsPool.ts`)
* Executed inside `KineticPostFX` (`+0` extra draw calls):
  - Uniform array `uShockwaves[4]` (`vec4(uvX, uvY, normRadius, strength)`), updated per frame from up to 4 active world-space shockwave pulses projected through `camera`!
  - Triggered by:
    1. **K-90 Rail Sniper shot** (brief crisp shockwave expanding from muzzle, `0.22 s`, `strength 0.55`)
    2. **Aegis Shield shatter / `VALKYRIE-09` wing break** (dramatic air-warping blast, `0.42 s`, `strength 1.0`)
    3. **Hunter Drone explosion** (`0.35 s`, `strength 0.75`)
    4. **Boss Phase-2 awakening / Dive slam** (`0.55 s`, `strength 1.15`)
    5. **Door Breach Kick** (`0.22 s`, `strength 0.45`)
  - Fragment distortion warps scene UVs radially along a thin expanding ring (`ring = exp(-pow((dist - radius) / 0.035, 2.0))`) with a tiny prismatic chromatic edge split (`±0.004`), making high-impact moments visibly bend the rainy night air!

---

## PHASE 12B — Seamless Sky-Drop Intro, Dynamic Per-Sector Weather & Boss Lightning Flash, Enemy Armor Stripping / Ragdoll Slide & `VALKYRIE-09` Spectacle

### 12B-1. Seamless High-Altitude Drop-In Sector Intro (`src/main.ts`, `src/player/PlayerController.ts`, `src/engine/AudioEngine.ts`)
* Triggered when deploying into a sector from Title or advancing through a Sector Gate (**NEVER** triggered on quick death retry — `500 ms` instant death respawn remains untouched!):
  - **`2.5 s` Seamless First-Person Insertion**:
    - Camera begins `52 m` directly above `playerSpawn` angled downward (`-42°` pitch) across the dense neon skyline, Mega-Billboards, and overhead blimps.
    - Smoothly accelerates into a fast rain-streaked vertical plunge (`uSpeedLines` pulsing, rushing wind-dive DSP + retro-brake whoosh at `Y = 4.5 m`), pitches up cleanly to horizon (`0°`), and touches down at `playerSpawn` with a crisp physical landing spring-dip + wet splash directly into live `PLAYING` control (`0` black cut!).
    - **Instant Skip**: Pressing `Space` or `Left Click` at any point during the `2.5 s` drop immediately snaps the player to grounded `playerSpawn` with full control!
    - Display a minimal crisp HUD overlay during the drop (`SECTOR 0X // INSERTION — [SPACE] SKIP`).

### 12B-2. Dynamic Per-Sector Weather Progression & Sector 5 Full-City Lightning Flash (`src/config/constants.ts`, `src/entities/EffectsPool.ts`, `src/engine/Renderer.ts`, `src/world/CityBuilder.ts`)
Define `SECTOR_WEATHER` profiles across Sectors 1–5 (zero extra draw calls!):
| Sector | Weather Mood | Rain Intensity & Wind Slant | Fog Density Mult | Lightning Period |
| :--- | :--- | :--- | :---: | :---: |
| **SECTOR 01** | Crisp Neon Drizzle | `0.72` · gentle slant (`windX: 0.8`) | `0.95×` | `26 s` |
| **SECTOR 02** | Humid Canal Fog | `0.78` · light slant (`windX: 1.4`) | `1.18×` | `22 s` |
| **SECTOR 03** | Crosswind Industrial Storm | `1.00` · sharp diagonal rain (`windX: 5.5`) | `1.05×` | `18 s` |
| **SECTOR 04** | Torrential Neon Downpour | `1.08` · heavy rain (`windX: 3.0`) | `1.00×` | `16 s` |
| **SECTOR 05** | **Full Boss Thunderstorm** | `1.18` · violent storm (`windX: 4.8`) | `0.98×` | **`11 s`** |

* **Sector 5 Full-City Lightning Illumination Flash**:
  - Sync `Renderer.moonLight` directly with `lightningAt(simTime)` in Sector 5 (and subtly at `0.35×` strength in Sectors 3–4): during the `120 ms` double-flash peak, spike `moonLight.intensity` (`0.72 -> 2.75`) and shift tint toward stark electric blue-white (`#D4ECFF`), briefly throwing dramatic stark highlights across the entire megastructure ring right before the delayed rolling thunder hits!
* **Wind-Slanted Rain Streaks (`EffectsPool.ts`)**: Pass `windX` into the existing `1800`-streak rain `InstancedMesh` so Sector 3 & Sector 5 rain visibly lashes diagonally across neon streetlights!

### 12B-3. Enemy Visual Overhaul: Visible Armor Stripping, Exposed Sparking Cyber-Skeleton & Wet-Asphalt Ragdoll Slide (`src/entities/EnemyManager.ts`, `src/entities/EffectsPool.ts`)
*(Follow **`HERO_3D_MODELING_SPEC.md`** §5.3 for exact inner titanium ribcage, glowing reactor core, clavicle conduits, and detachable chest/shoulder armor plates.)*
1. **Damage-Driven Armor Stripping & Glowing Endo-Skeleton Core (`+0` Extra Draw Calls!)**:
   - Inside the existing articulated humanoid rig (`ENFORCER`, `AEGIS`, `VEIL`, `PHANTOM`), tag left/right shoulder pauldrons & outer chest plate as strippable armor parts over a **pre-built recessed inner cyber-endo core** (dark ribbed titanium spine/ribs + exposed flickering orange/cyan power conduit tubes).
   - When an enemy drops below `60%` HP (or suffers an Aegis shield shatter / heavy non-lethal hit), detach `1–2` armor plates (hide on rig + launch matching dark armored plates into the existing `DestructDebris` pool!) and emit periodic tiny electrical micro-sparks from the exposed chest/shoulder conduits (`EffectsPool`, zero extra calls)!
2. **Momentum-Driven Wet-Asphalt Ragdoll Slide → Digital Disintegration**:
   - On lethal kill (storing the killing bullet/kick impulse direction & strength), transition the defeated enemy into a **`0.65 s` physical tumble/slide death pose** instead of instant pop-out:
     - Body pitches/rolls backward along the kill impulse (`4.5–10.5 m/s` horizontal slide velocity with wet-asphalt friction decay + gravity settle to floor), kicking up `3–5` water spray & spark puffs along the slide trail!
     - During the final `0.35 s` of the slide, sweep the signature bright cyan/crimson holographic scanline **digital disintegration** across the fallen rig into rising digital pixels!

### 12B-4. Boss `VALKYRIE-09` Wing Energy Ribbon Trails & Phase-2 Crimson Awakening (`src/entities/EnemyManager.ts`, `src/engine/AudioEngine.ts`, `src/engine/Renderer.ts`)
1. **Dual Dynamic Aerial Wing Energy Ribbon Trails (`+1` Draw Call in Sector 5 ONLY!)**:
   - Pre-allocated segmented triangle-strip mesh (`2` ribbons × `20` trail samples = `40` quads, zero per-frame allocations) updating smoothly behind `VALKYRIE-09`'s left & right wingtips as she streaks between skyscrapers.
   - Additive glowing plasma trail with tapered width & alpha falloff: **icy electric cyan-white (`#58F8FF`) in Phase 1**, erupting into **blazing crimson-magenta (`#FF1858`) in Phase 2**!
2. **Phase-2 Awakening Spectacle (`HP < 50%`)**:
   - When `VALKYRIE-09` crosses `50%` HP:
     - Trigger a **`0.75 s` cinematic slow-motion beat (`timeScale = 0.20`)** (mouse look remains `1.0x`),
     - Trigger a synchronized **sky lightning flash + expanding screen-space shockwave refraction ring** (`12A-4`) centered on `VALKYRIE-09`,
     - Burst radial crimson plasma embers + ignite crimson wing trails,
     - Play a deep multi-layer **synthetic turbine roar + sub-bass drop** (`AudioEngine.bossAwaken()`)!

---

## Draw-Call & GPU Budget Audit (`<= 120 calls / frame`)
* **Phase 12A**:
  - `SsrPass` (half-res): `+1` fullscreen quad (toggleable, `OFF` on MEDIUM/LOW/lowLatency)
  - `GtaoPass` (half-res + blur): `+2` half-res fullscreen quads (toggleable, `OFF` on MEDIUM/LOW/lowLatency)
  - Lens Raindrops & Shockwave Refraction: **`+0`** (folded into `KineticPostFX`)
  - Inline FXAA when `ssr || gtao`: **`+0`** (replaces MSAA 2x resolve, net GPU-neutral on macOS Metal!)
* **Phase 12B**:
  - Drop-in Intro, Dynamic Weather & Lightning Flash, Armor Stripping, Ragdoll Slide: **`+0`** draw calls!
  - `VALKYRIE-09` Wing Ribbons: **`+1`** draw call (Sector 5 ONLY, where building/prop count is lower!)
* **Projected Sector 4 Scene Draw Calls**: **`~102–111` (Strictly `<= 120`!)**

---

## Verification Checklist (Required Before Reporting Done)

### Phase 12A Verification
1. `npm run build` and `npm test` pass (add unit tests for `SaveSettings` persistence of `ssr`/`gtao`/`lensRain`, shelter raycast dry-off state machine, and shockwave screen-projection queue).
2. **Zero WebGL2 Errors**: Confirm switching `ssr`/`gtao` `ON` and `OFF` cleanly toggles non-MSAA `DepthTexture` + inline FXAA vs `MSAA 2x` with ZERO WebGL `GL_INVALID_OPERATION` errors or black frames.
3. **Visual Verification**: Confirm real upside-down billboard/car reflections appear on wet streets & canal when `ssr: true`, soft crevice contact shading appears in corners/interiors without darkening neon/visors when `gtao: true`, camera-lens raindrops refract neon outdoors and dry off cleanly under highways/canopies/interiors, and Sniper fire / Shield break visibly warps the background ring!

### Phase 12B Verification
1. `npm run build` and `npm test` pass (add unit tests for drop-in intro completion & instant skip, `SECTOR_WEATHER` profile lookup for Sectors 1–5, enemy armor-strip threshold & ragdoll-slide lifecycle, and `VALKYRIE-09` Phase-2 awakening trigger).
2. **Visual & Gameplay Checks**:
   - Sector start performs the `2.5 s` seamless sky-drop plunge into control (and skips immediately on `Space`/click; death retry stays instant `500 ms` with NO drop-in!).
   - Sector 3 & 5 show visibly wind-slanted rain; Sector 5 lightning flashes briefly illuminate the entire boss arena before rolling thunder hits.
   - Damaging humanoids strips armor plates to reveal sparking cyber-endo cores; killing them launches a wet-asphalt ragdoll slide → digital disintegration.
   - `VALKYRIE-09` trails glowing cyan ribbons in Phase 1 and erupts into crimson trails + shockwave + lightning awakening slow-mo at `50%` HP.
   - Confirm `renderer.info.render.calls <= 120` and locked 60fps in Sector 4 & Sector 5.
