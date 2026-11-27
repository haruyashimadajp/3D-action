# STRAND // PROTOCOL — Phase 12 AAA Master Specification: Next-Gen Procedural Rendering, Wet Billboard Reflections, Combat Cinematics, Living Soundscape & Photo Mode (12A & 12B)

**Target Implementer**: Claude (TypeScript / Three.js r187 / WebGL2 / Web Audio API)  
**Target Codebase**: `strand-protocol/` (on top of Phase 11B)  
**Master Blueprints**: `HERO_3D_MODELING_SPEC.md` §5.3 & §6, `CLAUDE.md`  
**Execution Strategy (Token-Safe 2-Step Split)**: Complete, build, verify, and screenshot-audit **Phase 12A** (AAA Visual & Rendering Upgrade) first; then implement and verify **Phase 12B** (Combat Cinematics, Strippable Endo-Core, ViewModel Polish, Spatial Acoustics & Photo Mode).

> [!IMPORTANT]
> **Hard AAA Ceilings — Zero Draw-Call & Zero Latency Tax!**
> 1. **Strictly `+0` Net Draw Calls & `+0` Extra Fullscreen Passes**: Every single Phase 12A and 12B visual upgrade executes inside existing instanced/batched meshes (`CityBuilder`, `EnemyManager`, `ViewModelRenderer`, `EquipmentManager`, `EffectsPool`) and the existing `KineticPostFX` pass (`Renderer.ts:186`). Sector 4 HIGH full-combat total MUST remain **`~87` calls** (`<= 100` target, hard ceiling `<= 120`!).
> 2. **Ultra-Low Mouse Latency Guarantee**: NEVER add extra render passes, NEVER raise `MSAA` (`<= 2`, `0` in `lowLatency`), NEVER raise `CITY_LIGHTS_MAX` (`<= 12`), NEVER raise DPR pixel cap (`<= 2.2M px`), and NEVER allow any hit-stop or boss slow-mo to delay `InputManager.consumeLook()` (`PlayerController.ts:403`). All heavy fragment effects (billboard reflections, parallax glass raindrops, anamorphic streak, RCAS sharpen) MUST respect `LOW` / `lowLatency` / `#ifndef LITE` / `#ifndef STRAND_LITE` gates!
> 3. **Build on Existing Code — Zero Duplication**:
>    - `strandInterior` 3D parallax rooms and `uTime` ALREADY exist in `CityBuilder.ts:1502, 1523, 1568, 1678-1691` — **enhance** them in place.
>    - `uWetTime` / `uBarrelHeat` / `uBarColor` ALREADY exist in `ViewModelKit.ts:223-328` — **enhance** them in place.
>    - Directional flinch (`flinchX`/`flinchZ`), `GameClock.hitstop(def)`, `HITSTOP.*`, and `audio.bossKill(pos)` ALREADY exist — **extend** them in place!
>    - World grapple strand (`ropeMesh`, `drawRope()`, `BURST.HOOK`) lives in **`src/player/EquipmentManager.ts:172, 702, 825-845`**.
>    - `EnemyManager` ALREADY uses two `THREE.BatchedMesh` draws (`armor` + `glow`, `EnemyManager.ts:1281-1285`) — pack strippable plates + endo-core directly into them!

---

## PHASE 12A — AAA Procedural Rendering, Reflections, Close-Up PBR & Cinema PostFX (`+0` Draw Calls, `+0` Passes)

### 12A-1. Per-Sector Procedural `256` PMREM IBL Environment Baking (`src/engine/Renderer.ts`, `src/main.ts`, `+0` Per-Frame GPU Cost)

Upgrade `Renderer.buildEnvironment()` (`Renderer.ts:625-751`) from one static startup cube to a per-sector one-shot bake so every wet road, chrome trim, supercar clearcoat, rain-slicked weapon bevel, and glass tower reflects the active district's authentic neon palette!

* **API**: Change `private buildEnvironment()` to `public buildEnvironment(sectorPalette?: readonly number[], sectorIndex = 1): void` called in constructor (default Sector 1) and from `main.ts:buildSector()` whenever `sectorIndex` changes.
* **Leak-Free Disposal**: Dispose previous `this.envTarget?.dispose()` BEFORE replacing `this.scene.environment` and `this.viewModelScene.environment` (zero GPU texture leaks across endless loops!).
* **District Mood Tuning**:
  - Replace hardcoded `neonColors` (`Renderer.ts:680`) with `[palette[0], palette[1], palette[2], COLORS.WINDOW_COOL]`, weighting `palette[0]` and `palette[1]` stronger so every sector has a distinct reflective color signature.
  - Tint `horizon` (`mix(0x1a2444, palette[0], 0.16)`) and `below` (`mix(0x2a1a55, palette[1], 0.20)`) subtly, and re-seed the silhouette skyline (`seed = 1337 + sectorIndex * 7919`).
  - Keep `RENDER.ENV_CUBE_SIZE = 256` (`< 6 ms` one-shot during sector load, **`0.00 ms` per-frame GPU cost!**).

---

### 12A-2. Projected Mega-Billboard Wet-Street Reflection Ribbons & Gutter Puddles (`src/world/CityBuilder.ts`, `src/main.ts`, `+0` Draw Calls, `+0` Passes)

In `d7ac480`, wet asphalt only reflects `uCityLightPos[12]` point lights and the static PMREM cube — massive Mega-Billboards cast no elongated neon color ribbons down the rain-soaked avenues.

* **Zero-Allocation Nearest-8 Billboard Selector (`CityBuilder.ts`)**:
  - Add pre-allocated uniforms on `CityBuilder`:
    - `uMegaReflPos`: `THREE.Vector4[8]` (`xyz` = billboard center, `w` = half-width in meters)
    - `uMegaReflCol`: `THREE.Vector4[8]` (`rgb` = linear `AD_HUES[r.cell]` color × intensity, `w` = half-height in meters)
    - `uMegaReflCount`: `{ value: 0 }`
    - `uMegaReflEnabled`: `{ value: 1.0 }` (avoids mid-game shader recompile stutter! Set to `0.0` in `CityBuilder.setQuality('LOW')` AND via new `CityBuilder.setLowLatency(on: boolean)` wired in `main.ts:727`!).
  - During `buildSector()`, cache flat typed arrays (`megaPos`, `megaCol`, `megaSize`, `megaDist`, `megaCount`) from `megaRecords` (resolving color cleanly via `AD_HUES[r.cell]` and skipping sky-high `RING` billboards `y > 42 m`).
  - Inside `CityBuilder.update(simTime, cameraPos)` (`CityBuilder.ts:7975`), run the exact same allocation-free partial-selection loop used for `uCityLightPos` (picking up to `8` nearest billboards within `90 m`).
* **Anisotropic Wet-Ribbon Reflection Shader (`createRoadMaterial()`, `CityBuilder.ts:1826`)**:
  - Inside `#include <lights_fragment_end>` on wet road surfaces (gated by `uMegaReflEnabled > 0.5 && roughnessFactor < 0.42`):
    ```glsl
    if (uMegaReflEnabled > 0.5 && roughnessFactor < 0.42) {
      float wetMask = 1.0 - smoothstep(0.14, 0.42, roughnessFactor);
      vec3 sV = normalize(cameraPosition - vCityWorld);
      // Exact world-space normal combining BOTH road normalMap AND puddle ripples (same helper as CityBuilder.ts:1042, 1053!):
      vec3 sWorldN = normalize(transformNormalByInverseViewMatrix(normal, viewMatrix));
      vec3 sR = reflect(-sV, sWorldN);
      float fres = 0.04 + 0.96 * pow(1.0 - clamp(dot(sWorldN, sV), 0.0, 1.0), 4.0);
      vec3 ribbonSum = vec3(0.0);
      for (int i = 0; i < 8; i++) {
        if (i >= uMegaReflCount) break;
        vec3 toB = uMegaReflPos[i].xyz - vCityWorld;
        float dist = length(toB);
        if (dist > 85.0) continue;
        vec3 Ldir = toB / max(dist, 1e-3);
        // Anisotropic stretch: tight horizontally (billboard width), elongated vertically along wet asphalt!
        float alignY = max(dot(normalize(vec3(sR.x, sR.y * 0.35, sR.z)), normalize(vec3(Ldir.x, Ldir.y * 0.35, Ldir.z))), 0.0);
        float spread = mix(42.0, 10.0, clamp(uMegaReflPos[i].w / 8.0, 0.0, 1.0));
        float lobe = pow(alignY, spread * mix(1.2, 0.45, roughnessFactor));
        float atten = 1.0 / (1.0 + dist * dist * 0.0018);
        ribbonSum += uMegaReflCol[i].rgb * lobe * atten;
      }
      reflectedLight.indirectSpecular += ribbonSum * wetMask * fres * 0.65;
    }
    ```
  - **Curb Gutter Puddles & Tire-Track Roughness (`createRoadMaterial()`, `CityBuilder.ts:1812-1818`)**: Modulate `roughnessFactor` with subtle longitudinal tire-track wear (`sin(fract(vTileUv.x) * 6.2832 * 2.0)`) and glossy gutter puddle strips (`roughness 0.08–0.14`) along curb edges (`abs(fract(vTileUv.x) - 0.5) > 0.38`) so curb LEDs and billboard ribbons mirror vividly in the gutters!

---

### 12A-3. Close-Up Automotive PBR Detail Texture & Enhanced 3D Parallax Interiors (`ProceduralTextures.ts`, `CityBuilder.ts`, `+0` Draw Calls)

1. **Dedicated `512 × 512` `vehicleDetail` Procedural Texture (`ProceduralTextures.ts`, `createCarMaterial()`)**:
   - Add an **optional** field `vehicleDetail?: { readonly normalMap: THREE.Texture; readonly roughnessMap: THREE.Texture }` on `ProceduralTextureLibrary` (`ProceduralTextures.ts:40-73`, optional & typed as `THREE.Texture` so headless Node fallback and `mockTextures()` in `phase10a1/10b/10b2/10c.test.ts` never break!).
   - Encode 4 crisp `256 × 256` repeating quadrants:
     - **Q0 (`[0..0.5, 0..0.5]`, `sPart == 4` carbon splitters/wings/skirts)**: `45°` 2×2 diagonal carbon-fiber twill weave normal + alternating sheen!
     - **Q1 (`[0.5..1, 0..0.5]`, `sPart == 4` front recessed air intakes & pickup/van grilles — detected cleanly via `abs(vLocalN.z) > 0.7 && vLocal.z > 0.5` so `aPart === 4` stays untouched for `phase10c.test.ts:183-194`!)**: sharp hexagonal dark honeycomb mesh relief!
     - **Q2 (`[0..0.5, 0.5..1]`, `sPart == 6` alloy rims / brake discs / exhausts)**: fine brushed-metal radial grooves!
     - **Q3 (`[0.5..1, 0.5..1]`, `sPart == 0` clearcoat paint & `sPart == 1` canopy glass)**: subtle rain-beading clearcoat micro-normals catching streetlights & billboard reflections!
   - **Zero-UV Shader Injection (CRITICAL — `CityVehicles.ts:206, 449` strips `uv`!)**:
     - Do **NOT** assign `mat.normalMap` or `mat.roughnessMap` to `MeshStandardMaterial` (that crashes GLSL with `uv` undefined!).
     - Instead pass `uDetailNormal`, `uDetailRough`, and `uHasVehicleDetail` (`0.0 | 1.0`) as custom uniforms in `createCarMaterial().onBeforeCompile` (`CityBuilder.ts:1992-2074`), pass `varying vec3 vLocalN` (`normal` in object space), pick local 2D UV (`abs(vLocalN.y) > 0.5 ? vLocal.xz : (abs(vLocalN.z) > 0.5 ? vLocal.xy : vLocal.zy)`), sample the active quadrant with **`textureGrad(uDetailNormal, qOrigin + 0.008 + fract(uvDet) * 0.484, dFdx(uvDet) * 0.484, dFdy(uvDet) * 0.484)`** (exact anti-mip-bleed pattern from `ViewModelKit.ts:299-302`!), and perturb view-space `normal` via local tangent basis / `dFdx` (exact pattern from `CityPropMeshes.ts:595-601`).
2. **Enhanced `strandInterior` Parallax Rooms & Close-Up Glass Rain Streaks (`CityBuilder.ts:1523, 1678-1691`, `#ifndef STRAND_LITE`)**:
   - Upgrade `strandInterior(vec2 cell, vec3 rd, vec3 light, float drift, int col)` in place (`uTime` is ALREADY declared and bound at `L1502, 1568`!):
     - **4 Distinct Room Profiles** keyed cleanly on `col` (`0..3`) & `drift`:
       1. *Corporate Office*: suspended ceiling grid, glowing cyan/teal mid-depth desk monitors, dark filing silhouettes.
       2. *Server Vault / Data Floor* (`col == 0 || col == 2`): tall dark server racks with **slow-blinking vertical rows of cyan/emerald/red LEDs** computed using the existing **`strandHash(int(floor(cell.x * 8.0)), int(floor(cell.y * 8.0)), int(floor(uTime * 2.0)))`** (never calling undefined `hash()`!).
       3. *Cyber Residential*: warm tungsten pendant cone, horizontal venetian blind slats across upper pane, silhouetted bookshelf.
       4. *Neon Loft / Workshop*: angled cyan/magenta accent strip, industrial ceiling beam silhouette.
     - **Close-Range Window Raindrop Streaks (`sDist < 22.0`)**: Inside `#ifndef STRAND_LITE` when `sMask > 0.5 && sDist < 22.0`, add animated vertical raindrop streak refraction (using `strandHash` or injecting `GLSL_HASH` `sHash12`) fading out smoothly `18 -> 22 m` so distant skyscrapers pay zero extra ALU!

---

### 12A-4. Cinema PostFX Inside `KineticPostFX`, Aerial Perspective & Shadow Refinement (`src/engine/Renderer.ts`, `CityBuilder.ts`, `src/config/skills.ts`, `index.html`, `HudManager.ts`, `main.ts`, `+0` Passes)

Execute inside the EXISTING `KineticPostFXShader` fragment shader (`Renderer.ts:186-442`, zero extra render passes!):
1. **5-Tap RCAS Contrast-Adaptive Sharpening (`#ifndef LITE`, Settings toggle `Sharpen` default ON in HIGH/MEDIUM, OFF in LOW)**:
   - Execute **immediately after the initial `tDiffuse` fetch (`Renderer.ts:338`, BEFORE bullet-time, vignettes, grading, and grain)** so all 4 neighbor taps (`±(1,0)/uResolution`, `±(0,1)/uResolution`) sample raw `tDiffuse` cleanly in the exact same color space!
   - Compress center + 4 neighbors via Reinhard (`c / (1.0 + max(c.r, max(c.g, c.b)))`) so HDR neon pixels don't skew sharpen weights, apply AMD FidelityFX RCAS anti-ringing sharpen (`uSharpen = 0.28`, strictly clamped inside `[min4, max4]`), then invert Reinhard back to linear HDR!
   - Wire persistent `sharpen: boolean` toggle in **`src/config/skills.ts`** (`SaveSettings`, `defaultSave`, `sanitizeSave`), **`index.html`**, **`HudManager.ts`**, and **`main.ts:744`** (`applyAllSettings`).
2. **Gated Subtle Horizontal Anamorphic Neon Streak (`#ifndef LITE`, off when `lowLatency === true` or `LOW`)**:
   - Uniform `uAnamorphic: { value: 0.14 }` (`0.0` automatically in `LOW` or `lowLatency`).
   - Right after RCAS (reading raw `tDiffuse` before grading): perform **4 cheap symmetric horizontal taps** (`±3.0 / uResolution.x`, `±7.0 / uResolution.x`), extracting only bright HDR neon/headlights (`max(0.0, lum - 1.45)`), tinting cool cinema cyan (`vec3(0.75, 0.92, 1.15)`), and adding `streak * uAnamorphic`!
3. **Seamless Sector-Tinted Aerial Perspective & Shadow Frustum Density**:
   - Add **`Renderer.setSectorAtmosphere(palette: readonly number[])`** blending `12%` of `palette[0]` into `COLORS.FOG_ABYSS` on `this.scene.fog.color`, AND add **`CityBuilder.setSkyHorizon(fogColor: THREE.Color)`** updating `SkyDome`'s `uHorizon` uniform (`CityBuilder.ts:2295, 2319`) to the **EXACT same fog color** (called together in `main.ts:buildSector()` — zero hard horizon seam behind fogged towers!).
   - Tighten optional player-centered shadow frustum **`RENDER.SHADOW_FRUSTUM_HALF`** (`constants.ts:448`) from `36 -> 30 m` (`1024×1024` PCFSoft, `5.8 cm/texel` crisp close-up shadows!) and enable `receiveShadow = true` on interior floors & `StreetFurnishingsKit`.

---

## PHASE 12B — Combat Cinematics, Strippable Endo-Core, ViewModel Polish, Spatial Acoustics & Photo Mode (`+0` Net Draw Calls)

### 12B-1. Humanoid Strippable Armor Plates & Glowing Inner Cyber-Endo Core (`src/entities/EnemyManager.ts`, `HERO_3D_MODELING_SPEC.md` §5.3, `+0` Draw Calls)

Bring dramatic visual battle damage to regular humanoids (`ENFORCER`, `AEGIS`, `VEIL`, `PHANTOM` — strictly `!e.isBoss`, since `VALKYRIE` calls `buildHumanoidBody()` at `L688` and uses its own wing-break spectacle!) inside the EXISTING two `THREE.BatchedMesh` draws (`this.armor` + `this.glow`, **`+0` draw calls!**):

* **BatchedMesh Budget Bump (`EnemyManager.ts:1129-1130`)**:
  - Increase `ARMOR_INSTANCES` `2400 -> 3600` and `GLOW_INSTANCES` `1500 -> 2100` (reusing existing `GEO_NAMES` primitives so `verts + 64` / `indices + 256` remain completely sufficient).
* **Recessed Torso Cavity & Inner Endo-Core (`buildHumanoidBody()`, `EnemyManager.ts:502-575`)**:
  - Extend `PartRole` with `'ENDO' | 'STRIP_CHEST' | 'STRIP_SHOULDER_L' | 'STRIP_SHOULDER_R'`.
  - **No Solid-Torso Occlusion (CRITICAL!)**: Recess the main rear/side torso `taper` (`L516`) to the back/spine half (`z ∈ [-0.16, +0.02]`), carving an authentic open front chest cavity!
  - Inside that front cavity (`j.torso`): build dark ribbed titanium sternum (`0.10 × 0.28 × 0.12 m`, `#2b323c`, `'ENDO'`), `3` horizontal ribcage struts (`0.26 × 0.03 × 0.14 m`, `'ENDO'`), twin clavicle power conduits (`'ENDO'`), and recessed pulsing central **inner power reactor cell** (`cyl r = 0.065 m`, `glow = true`, warm orange/cyan, `'CORE'`). Inside `j.armL`/`j.armR` root: machined metallic shoulder ball-socket joint (`sphere r = 0.072 m`, `#36404d`, `'ENDO'`).
  - Tag the outer front chest shell (`L517` **AND** its exterior front accent strip `L520` so `L520` never floats detached!) as **`'STRIP_CHEST'`**, and tag outer left/right shoulder pauldrons (`L542` + accent strip `L543`) as **`'STRIP_SHOULDER_L'`** / **`'STRIP_SHOULDER_R'`**.
* **Runtime Stripping & Exact `BatchedMesh` Hiding (CRITICAL!)**:
  - Track `armorStrippedMask: number` per enemy (reset to `0` on spawn/reset!).
  - When `!e.isBoss && e.hp / e.maxHp < 0.60` (or on heavy sniper body hit / AEGIS shield break), strip `1` unstripped plate (2nd plate below `30%` HP):
    1. Set `rig.dDetached[k] = 2` **AND** immediately call **`(p.glow ? this.glow : this.armor).setVisibleAt(p.inst, false)`** (because `writeRig()` at `EnemyManager.ts:3898` skips `dDetached[k]` without zeroing the matrix!).
    2. Guard `detachPart()` (`L4450`) and `updateDebris()` with `if (rig.dDetached[k]) return;` so already-stripped plates NEVER reappear on death (respawn cleanly restores visibility via `setRigVisible(rig, true)` at `L1945`).
    3. Eject a matching beveled dark plate from the part's world transform into `EffectsPool.spawnDebris(...)` (`DestructDebris`, tumbling + scanline dissolve!) + metallic plate-shear crunch SE + sparks!
  - While `e.alive && e.armorStrippedMask !== 0`, emit `1–2` orange/cyan conduit sparks from exposed torso/shoulder every `0.35–0.65 s` (culled beyond `40 m`, zero allocations!).

---

### 12B-2. AAA Combat Feedback & VALKYRIE-09 Boss Spectacle (`EnemyManager.ts`, `EffectsPool.ts`, `CityBuilder.ts`, `AudioEngine.ts`, `constants.ts`, `skills.ts`, `main.ts`, `+0` Calls)

1. **Enhance Existing Directional Hit-Flinch (`EnemyManager.ts:979-982, 3814, 4350-4355`)**:
   - Do **NOT** add duplicate flinch fields! Extend the existing `flinchX`/`flinchZ`/`flinchVX`/`flinchVZ` spring (which already drives `j.torso.rotation`) to also apply coupled head snap (`j.head.rotation.x += e.flinchX * 0.85; j.head.rotation.z += e.flinchZ * 0.6`) and boost impulse `1.35×` on headshots!
2. **Mouse-Safe `Micro Hit-Stop` Settings Toggle & Preserved `HITSTOP` Table**:
   - Add persistent Settings toggle **`microHitstop: boolean`** (default `true`, wired in `skills.ts`, `index.html`, `HudManager.ts`, `main.ts:744`) gating `GameClock.hitstop()`.
   - **Preserve** existing `HITSTOP.BODY_KILL` (`30 ms, 0.08`), `HEADSHOT_KILL` (`52 ms, 0.05`), and `BT_AIR_HEADSHOT_KILL` (`65 ms, 0.04`) in `constants.ts:54-58` (NEVER downgrade headshots!); add **`HITSTOP.BREACH_STUN`** (`26 ms, 0.08`) for Phase 11A behind-door stuns; upgrade **`HITSTOP.BOSS_KILL`** (`constants.ts:57`) to **`{ durationMs: 450, timeScale: 0.18 }`**.
   - Strictly preserve `PlayerController.ts:403` real-time `consumeLook()` so mouse look stays 100% locked-zero-lag even during `450 ms` boss slow-mo!
3. **VALKYRIE-09 Boss Spectacle & `SkyDome` Real-Time Lightning Override**:
   - Add uniform **`uLightningOverride (vec4: startTime, duration, azimuth, active)`** + `uRealTime` to `CityBuilder.createSky()` (`L2337-2350`) and method `CityBuilder.triggerLightningOverride(azimuth: number, duration = 0.45): void` (driven by `realTime` so BOTH boss events AND Photo Mode `[L]` flash even when `simTime` is frozen!).
   - **Wing-Break Event**: Spawn twin concentric `EffectsPool.spawnRing()` shockwaves (`r0 = 0.6 -> r1 = 14 m`, crimson + cyan, `0.48 s`), eject `24` metallic debris plates into `DestructDebris`, and call `city.triggerLightningOverride(azimuth, 0.45)` + immediate thunder crack!
   - **Final Boss Kill (`EnemyManager.ts:4459-4486`)**: Upgrade existing `bossKilled` shockwaves with a dramatic 3rd gold-crimson radial ring (`r1 = 22 m`), `city.triggerLightningOverride()`, `450 ms` slow-mo (`HITSTOP.BOSS_KILL`), and enrich existing **`AudioEngine.bossKill(pos)`** (`AudioEngine.ts:1023`) with a deeper sub-bass drop & shimmering harmonic sustain (no duplicate method!).

---

### 12B-3. First-Person ViewModel & Grapple AAA Polish (`ViewModelKit.ts`, `ViewModelRenderer.ts`, `EquipmentManager.ts`, `main.ts`, `+0` Calls)

Build directly on existing `ViewModelKit.ts:223-328` uniforms and `EquipmentManager.ts:702, 825-845`:
1. **Valid-GLSL Sliding Raindrop Streaks & Smooth Indoor Drying (`uWetAmount`)**:
   - Add uniform `uWetAmount: { value: 1.0 }` to `ViewModelKit.ts` (`hardU` and `gearU`).
   - In `main.ts`, check if `camera.position` lies inside any `layout.interiors` AABB (`indoor: boolean`, `O(interiors.length <= 10)`, zero allocations) and pass `indoor` inside `ViewModelFrame`.
   - In `ViewModelRenderer.update()`: smoothly ramp `this.wetAmount` toward `0.0` (`0.45/s`) indoors and back to `1.0` (`1.2/s`) outdoors, driving `hardU.uWetAmount.value`, `gearU.uWetAmount.value`, AND `renderer.postFx.rainDrops` (`0.6 -> 0.0` indoors; reset `renderer.postFx.rainDrops = 0.6` in `main.ts:returnToTitle()`!).
   - Upgrade `ViewModelKit.ts:309-329` raindrop shader with **strictly valid GLSL ES 3.00 (`edge0 < edge1`), trailing `+df.y` tail, `step(0.93, dh)` gating, and widened side-slide wetness mask**:
     ```glsl
     float kWetSide = smoothstep(-0.15, 0.45, dot(normalize(vNormal), uUpView));
     float streak = step(0.93, dh)
       * (1.0 - smoothstep(0.01, 0.045, abs(df.x)))
       * smoothstep(0.02, 0.14, df.y)
       * (1.0 - smoothstep(0.14, 0.42, df.y));
     // Multiply by existing kWetMat so leather/cloth glove zones never pick up metallic water streaks (and flip legacy drop smoothstep to 1.0 - smoothstep(0.02, 0.12, length(df))):
     float wetVis = (drop + streak * 0.65) * kWetSide * kWetMat * uWetAmount;
     ```
2. **Diegetic Weapon Feedback Polish (`ViewModelKit.ts`, `ViewModelRenderer.ts`)**:
   - **K-90 Rail Sniper**: Export `varying float vLocalZ` (`transformed.z`) from `ViewModelKit` vertex shader and modulate coil glow along muzzle-ward `-Z`: `0.78 + 0.22 * sin(-vLocalZ * 26.0 - uWetTime * 11.0)` scaled by `uCharge`, flaring white-hot via `uBarrelHeat` on discharge!
   - **MK-IV Tactical Pistol**: Transition `uBarColor` from cyan (`> 30%`) → amber (`<= 30%`) → pulsing crimson (`<= 15%`). When **`f.ammo <= 0`**, hold `uAmmo = 0.22` (visible bar stub instead of `0` collapse!) while pulsing `uBarColor` bright crimson (`0.5 + 0.5 * sin(time * 12.0)`) so empty-mag state is unmistakable on the slide!
3. **Grapple Anchor Latch ShockRing & `0.25 s` Damped Cable Whip (`src/player/EquipmentManager.ts:702, 825-845`)**:
   - Alongside existing `BURST.HOOK` sparks at `EquipmentManager.ts:702`, emit a crisp gold-cyan `EffectsPool.spawnRing()` (`r0 = 0.08 -> r1 = 0.65 m`, `0.22 s`) at the world grapple anchor!
   - Record `whipT = 0.25` on latch; inside **`EquipmentManager.drawRope()`** (`L825-845`, `16`-segment instanced strand), displace interior segments (`u ∈ (0, 1)`) transversely by `0.14 * exp(-(0.25 - whipT) * 14.0) * sin((0.25 - whipT) * 52.0) * sin(Math.PI * u)` so the grapple wire visibly whips and snaps razor-taut as tension engages!

---

### 12B-4. Spatial Interior Acoustics, Dystopian PA Soundscape & Pause Photo Mode (`AudioEngine.ts`, `HudManager.ts`, `InputManager.ts`, `index.html`, `main.ts`)

1. **Spatial Interior Acoustics (`src/engine/AudioEngine.ts`)**:
   - Route `startRain()` (`L338`) and `startWind()` (`L357`) through a shared `outdoorFilter: BiquadFilterNode` (`lowpass`, `22000 Hz`) → `outdoorGain: GainNode` (`1.0`) → `this.seFilter`.
   - Promote local `convolver` (`AudioEngine.ts:233`) to **`private convolver!: ConvolverNode`** so distant PA broadcasts can route `70%` wet directly into city reverb!
   - Add compact procedural interior reverb (`roomReverb: ConvolverNode`, `0.42 s` early-reflection metallic/tile IR) with `roomSend: GainNode` connected **`this.seBus → this.roomSend → this.roomReverb → this.worldOut`**.
   - Expose **`audio.setIndoorAcoustics(indoor: number, brokenWindowOpenness: number)`** (smooth `0.25 s` `setTargetAtTime`):
     - Outdoors (`indoor = 0`): `outdoorFilter = 22000 Hz`, `outdoorGain = 1.0`, `roomSend = 0.0`.
     - Intact Interior (`indoor = 1, openness = 0`): `outdoorFilter = 1400 Hz`, `outdoorGain = 0.50` (`-6 dB`), `roomSend = 0.24`.
     - **Shattered-Window Rain Rush (`openness = 1`)**: If any `DestructibleGlass` pane or `InteractiveDoor` in the player's current `InteriorVolume` (`doorIds` / `glassIds`) is broken/open, open `outdoorFilter` to `3600 Hz` and `outdoorGain` to `0.72` — breaking a window audibly lets the night rain rush inside!
2. **Distant Muffled Dystopian PA Announcements (`AudioEngine.ts`)**:
   - Every `28–45 s` during calm/stealth exploration (`!inCombat && !isBossSector && state === 'PLAYING'`), play a distant procedural megaphone PA cadence: 3-note cyber chime (`C5 -> G4 -> E5`) → `3–4` formant-filtered synthetic megaphone phrases (`bandpass 650–2100 Hz`, soft waveshaper clip, `70%` wet into `this.convolver` city reverb). Zero audio files!
3. **Pause-Menu Photo Mode / Free-Cam (`main.ts`, `HudManager.ts`, `index.html`, `Renderer.ts`)**:
   - Add `'PHOTO'` to `AppState` union (`main.ts`). Triggered from Pause menu **`PHOTO MODE`** button or pressing **`[P]`** while `PAUSED`.
   - **Exact State-Machine Wiring (CRITICAL!)**:
     - In `main.ts:setState(s)`:
       - `audio.setPaused(s === 'PAUSED' || s === 'RESULT' || s === 'TITLE' || s === 'PHOTO')`
       - `hud.setVisible(s !== 'TITLE' && s !== 'PHOTO')`
       - `viewModel.root.visible = s !== 'TITLE' && s !== 'PHOTO'`
     - In `main.ts:tick()` (`L1323-1391`): add explicit **`else if (this.state === 'PHOTO')`** branch that updates the Photo Mode free-cam, skips `player.updateCamera()` and `updateHud()`, updates `city.update(this.clock.simTime, cam.position, this.clock.realTime)` (`main.ts:1408` — frozen `simTime`, live `realTime` for `[L]` lightning!), passes `0` `simDt` to `effects.update()`, and renders normally!
   - **Controls & Synchronous Capture**:
     - Save exact player camera `(pos, quat, fov)` on entry; restore verbatim on `Esc` / `[P]` exit back to `PAUSED`.
     - Free-fly via `WASD` + `Q/E` vertical + `Shift` fast / `Ctrl` slow + **direct canvas mouse-drag look** (no pointer-lock conflict with `Esc`!), clamped inside `[-H, +H]` & `y ∈ [0.6, 110]`.
     - Live controls (compact toggleable `[H]` overlay strip):
       - **`[ / ]` or Wheel**: FOV (`35° – 105°`).
       - **`1 – 5`**: Cycle exact live `ScreenFilterId`s (`skills.ts:526-533`): **`CYBER_NOIR`, `NEON_OVERDRIVE`, `COLD_STEEL`, `AMBER_DUST`, `RAW`**!
       - **`Z / X` (`C` reset)**: Camera roll (`-25° .. +25°`).
       - **`L`**: Call `city.triggerLightningOverride(camYaw, 0.45)` for instant dramatic sky-lightning capture!
       - **`SPACE` / `CAPTURE PNG`**: Call **`this.renderer.render()` synchronously** immediately followed by `canvas.toDataURL('image/png')` download (`preserveDrawingBuffer: false` requires synchronous read right after `render()`!).

---

## Final Draw-Call & Latency Certification Table

| Phase | Net Delta | Sector 4 HIGH Full Combat | Mouse Latency Impact |
| :--- | :---: | :---: | :--- |
| Phase 11B Post-Consolidation | `—` | **`~87`** | Baseline (late `consumeLook`, MSAA 2, half-res Bloom) |
| **Phase 12A** (Per-Sector PMREM, Mega-Billboard Reflections, Car PBR Detail, Enhanced Parallax, RCAS + Anamorphic in `KineticPostFX`) | **`+0`** | **`~87`** | **Zero extra passes**; heavy taps disabled in `LOW` / `lowLatency` |
| **Phase 12B** (Strippable Endo-Core in `BatchedMesh`, Hit-React/Boss Spectacle, ViewModel Streaks/Indoor Dry, Spatial Acoustics, Photo Mode) | **`+0`** | **`~87`** (`33` calls below `120` cap!) | **Zero**: `hitstop` / boss slow-mo never freeze real-time mouse look! |

---

## Phase 13 Blender `.glb` Swap-Ready Rendering & Rig Contract (`HERO_3D_MODELING_SPEC.md` §7, `+0` Runtime Cost)

Because Phase 13 will replace procedural hero assets (vehicles, street landmarks, interior props, weapons, enemies) with Blender glTF 2.0 `.glb` PBR models, Phase 12 leaves two tiny, zero-overhead extension hooks in place:
1. **Standard PBR Material Hook (`CityBuilder.applyStrandMaterialHooks(mat, opts?)`, Phase 12A)**:
   - Expose a clean public method on `CityBuilder` that accepts ANY standard UV-mapped `THREE.MeshStandardMaterial` (such as materials emitted by `GLTFLoader` from Blender `.glb` exports), chains any previous `mat.onBeforeCompile`, injects `this.injectCityLights(shader)` + optional rain-wet clearcoat Fresnel (`opts?.wetClearcoat` inside `#include <emissivemap_fragment>`) — **requiring zero custom `aPart` vertex attributes** — and sets a unique `mat.customProgramCacheKey` (`${prevKey}-strand-glb${opts?.wetClearcoat ? '-wet' : ''}`) so Three.js r187 never collides program cache keys with unhooked materials!
   - Combined with Phase 12A-1 per-sector `256` PMREM `scene.environment`, any imported Blender `.glb` asset automatically receives authentic 12-light neon reflections, wet night-rain speculars, and sector-matched IBL on load!
2. **Canonical Enemy Bone & Strip-Role Names (`EnemyManager.ts`, Phase 12B-1)**:
   - Preserve exact canonical joint names (`pelvis`, `torso`, `head`, `armL`, `foreL`, `armR`, `foreR`, `weapon`, `legL`, `shinL`, `legR`, `shinR`, `wingL`, `wingR`) and detachable armor role tags (`'ENDO'`, `'STRIP_CHEST'`, `'STRIP_SHOULDER_L'`, `'STRIP_SHOULDER_R'`) so Blender-rigged humanoid `.glb` meshes plug straight into directional flinch, hitboxes, and armor stripping!

---

## Parallel Execution Plan (Disjoint File Ownership for `strand-worker` Fan-Out)

Use `/implement-spec PHASE12_AAA_RENDER_CINEMA_PLAN.md` (separately for **12A**, then **12B**) with parallel `strand-worker` subagents on strictly non-overlapping files before lead integration:

### Phase 12A Parallel Fan-Out
> **Pre-Fan-Out Step (Lead, 1 min)**: Add optional `vehicleDetail?: { readonly normalMap: THREE.Texture; readonly roughnessMap: THREE.Texture }` to `ProceduralTextureLibrary` (`ProceduralTextures.ts:68`) before launching Workers A/B/C so Worker C's `CityBuilder.ts` compiles cleanly in parallel!

| Agent | Exclusive Files Owned | Scope |
| :--- | :--- | :--- |
| **`strand-worker` A** | `src/engine/Renderer.ts`, `src/config/constants.ts`, `src/config/skills.ts`, `src/ui/HudManager.ts`, `index.html` | Per-sector `256` PMREM `buildEnvironment(palette, idx)`, `setSectorAtmosphere()`, `KineticPostFX` 5-tap Reinhard RCAS + 4-tap gated anamorphic streak, `SHADOW_FRUSTUM_HALF = 30`, persistent `sharpen` toggle |
| **`strand-worker` B** | `src/engine/ProceduralTextures.ts` | Dedicated `512 × 512` 4-quadrant `vehicleDetail` (`normalMap`, `roughnessMap`) optional on `ProceduralTextureLibrary` |
| **`strand-worker` C** | `src/world/CityBuilder.ts` | Nearest-8 Mega-Billboard road reflection ribbons (`uMegaReflPos[8]`, `uMegaReflEnabled`, `setLowLatency`), zero-UV `uDetailNormal` car shader, upgraded `strandInterior` + close glass rain streaks, `setSkyHorizon()`, `applyStrandMaterialHooks()` |
| **Lead Integrator** *(sequential after A/B/C)* | `src/main.ts`, `tests/phase12a.test.ts` | Wire per-sector PMREM, `setSectorAtmosphere` + `setSkyHorizon`, `city.setLowLatency`, `sharpen` apply, tests + `strand-auditor` |

### Phase 12B Parallel Fan-Out
| Agent | Exclusive Files Owned | Scope |
| :--- | :--- | :--- |
| **`strand-worker` A** | `src/entities/EnemyManager.ts`, `src/config/constants.ts` | Recessed torso cavity + Endo-Core + `STRIP_*` roles in `BatchedMesh` (`setVisibleAt` + `detachPart` guards), coupled head flinch, `HITSTOP.BREACH_STUN`/`BOSS_KILL`, VALKYRIE wing-break/kill spectacle |
| **`strand-worker` B** | `src/player/ViewModelKit.ts`, `src/player/ViewModelRenderer.ts`, `src/player/EquipmentManager.ts` | Valid-GLSL rain streaks + `kWetMat` + `uWetAmount` indoor drying, `-vLocalZ` K-90 wave, empty pistol `uAmmo = 0.22` pulse, grapple anchor `ShockRing` + `0.25 s` `drawRope()` whip wave |
| **`strand-worker` C** | `src/engine/AudioEngine.ts` | Promoted `this.convolver`, `outdoorFilter`/`outdoorGain`, `roomReverb`/`roomSend`, `setIndoorAcoustics(indoor, openness)`, dystopian PA broadcasts, enriched `bossKill()` |
| **Lead Integrator** *(sequential after A/B/C)* | `src/world/CityBuilder.ts`, `src/config/skills.ts`, `src/ui/HudManager.ts`, `index.html`, `src/main.ts`, `tests/phase12b.test.ts` | `SkyDome` `uLightningOverride` / `uRealTime`, `microHitstop` setting, `'PHOTO'` state free-cam / exact `ScreenFilterId`s / synchronous PNG capture, indoor query wiring + tests + `strand-auditor` |

---

## Mandatory Verification & Unit Tests (`tests/phase12a.test.ts`, `tests/phase12b.test.ts`)

### Phase 12A Tests (`strand-protocol/tests/phase12a.test.ts`)
1. **Per-Sector PMREM, Billboard Reflection Uniforms & `lowLatency` Gate**:
   - Assert `uMegaReflCount <= 8` across all 5 sectors × Loops `0..2`, every selected billboard lies within `90 m`, colors resolve cleanly via `AD_HUES[r.cell]`, and `setQuality('LOW')` / `setLowLatency(true)` sets `uMegaReflEnabled === 0`.
   - Assert `createRoadMaterial()` uses `transformNormalByInverseViewMatrix(normal, viewMatrix)` (never undefined `sRipGrad`).
2. **Automotive PBR & Parallax Guards**:
   - Verify `vehicleDetail` generates valid `512 × 512` `normalMap` and `roughnessMap`, `createCarMaterial()` leaves `mat.normalMap === null` (zero-UV safe!), and `phase10c.test.ts` passes unchanged.
   - Verify `strandInterior` uses `col` & `strandHash` (zero undefined `hash()`), and `SkyDome` `uHorizon` matches `scene.fog.color` after `setSectorAtmosphere()`.
3. **RCAS & Anamorphic Gating**:
   - Assert `KineticPostFXShader` runs RCAS on `tDiffuse` before grading, sets `uAnamorphic === 0` in `LOW` / `lowLatency`, and Settings persist `sharpen` cleanly.

### Phase 12B Tests (`strand-protocol/tests/phase12b.test.ts`)
1. **Strippable Armor & Endo-Core (`+0` Draw Calls)**:
   - Assert `EnemyManager` still uses strictly `2` `BatchedMesh` draws (`EnemyArmour`, `EnemyGlow`); humanoid rigs contain `'ENDO'`, `'STRIP_CHEST'`, `'STRIP_SHOULDER_L'`, `'STRIP_SHOULDER_R'`.
   - Assert damaging an `ENFORCER` below `60%` HP sets `armorStrippedMask !== 0`, calls `setVisibleAt(p.inst, false)` on stripped parts, skips them in `startDeath()`, and resets visibility cleanly on respawn / `resetSector()`.
   - Assert `VALKYRIE` (`isBoss === true`) does NOT trigger humanoid chest stripping.
2. **Hit-React, Mouse-Safe Hitstop & Boss Spectacle**:
   - Assert existing `HITSTOP.HEADSHOT_KILL` (`52 ms`) and `BT_AIR_HEADSHOT_KILL` (`65 ms`) remain intact, `HITSTOP.BREACH_STUN` (`26 ms`) & `HITSTOP.BOSS_KILL` (`450 ms`) exist, `microHitstop === false` suppresses hitstop cleanly, and `consumeLook()` remains 100% real-time unscaled.
   - Assert VALKYRIE wing break triggers shockwaves + `triggerLightningOverride()`.
3. **ViewModel Streaks, Indoor Drying, Spatial Acoustics & Photo Mode**:
   - Assert player inside `layout.interiors[0].aabb` sets `indoor === true` (ViewModel `wetAmount` decays toward `0`, `AudioEngine` lowpass targets `1400 Hz` / `-6 dB`, and rises to `3600 Hz` when a room window is shattered!).
   - Assert `EquipmentManager.drawRope()` applies `0.25 s` damped whip wave on latch and spawns anchor `ShockRing`.
   - Assert Photo Mode mutes audio, hides HUD & ViewModel, skips `player.updateCamera()`, cycles all 5 exact `ScreenFilterId`s (`CYBER_NOIR`, `NEON_OVERDRIVE`, `COLD_STEEL`, `AMBER_DUST`, `RAW`), clamps free-cam inside `[-H, +H]`, and restores exact player camera transform on exit.
4. **Final 5-Sector AAA Certification**:
   - `npm run build` + `npm test` (100% pass), live headless Chrome WebGL screenshots verified across all 5 sectors, and Sector 4 HIGH full combat `renderer.info.render.calls <= 100` (hard ceiling `<= 120`!).
