# STRAND // PROTOCOL — Phase 11 AAA Master Specification: Real Enterable Building Interiors, Deep Architectural Relief, Breach Doors, Destructible Glass & Small Props With Digital Disintegration (11A & 11B)

**Target Implementer**: Claude (TypeScript / Three.js r187 / WebGL2 / Web Audio API)  
**Target Codebase**: `strand-protocol/` (on top of Phase 10D)  
**Master Blueprints**: `HERO_3D_MODELING_SPEC.md` §4, §5.1, §5.2 & §6, `CLAUDE.md`  
**Execution Strategy (Token-Safe 2-Step Split)**: Implement, verify, and audit **Phase 11A** completely first; then implement, verify, and audit **Phase 11B**.

> [!IMPORTANT]
> **Hard AAA Engineering & Performance Ceilings**
> 1. **Draw-Call Budget**: Post-10D Sector 4 HIGH full-combat baseline is **`~84` calls**. Phase 11A adds strictly **`+4` calls** (`InteriorPropsKit`, `InteractiveDoors`, `DestructibleGlassPanes`, `DestructDebris` → `~88`). Phase 11B adds **`+0`** new pools and consolidates **`-1` call** (`RoofMechKit` merging `acUnits` + `ducts` inside `CityBuilder.ts`, keeping `CityPropMeshes` at 10 kits so `props.test.ts` stays 100% green!) to finish at **`~87` calls** (`33` calls below the `120` cap!).
> 2. **Zero Extra Static Draw Calls for Interiors & Architectural Relief**: ALL interior floors, walls, ceilings, counters, shelves, recessed window reveals, mid-tower refuge sky-notches, bay-window pods, and canopy tie-rods MUST merge into existing `G.concrete`, `G.archPaint`, `G.steel`, `G.bodies`, and `G.strips` static buckets (`+0` static calls, `+0` extra WebGL lights).
> 3. **Reuse Existing Phase 10A `PhysicsWorld` Spatial Grid (`O(1)`)**: `PhysicsWorld.ts:286` ALREADY implements the `12 m` CSR 2D spatial grid, DDA raycast, `BoxCollider.active?: boolean`, and `setColliderActive(index: number, active: boolean)`. Do **NOT** rebuild or duplicate the spatial grid — hook interactive doors and destructible glass directly into `setColliderActive()`.
> 4. **Zero Per-Frame Heap Allocations & Zero Mouse-Latency Regression**: Pre-allocate all scratch matrices/vectors/arrays; never block `consumeLook()`.
> 5. **Strict Modularity**: Extract **`src/world/InteriorBuilder.ts`** (hollow room planning, `G.bodies` + collider splitting, interior architecture, `InteriorPropsKit` geometry & placement) and **`src/entities/DestructibleManager.ts`** (`InteractiveDoors`, `DestructibleGlassPanes`, `8 m` static prop hash grid, zero-alloc instance hiding, stealth distraction, debris bridge).

---

## PHASE 11A — Real Enterable Building Interiors, Deep 3D Architectural Relief, Breach Doors & Shatterable Glass

### 11A-1. Real Hollow Building Interiors & Concave Pass-Through Arcades (`src/world/InteriorBuilder.ts`, `src/world/CityBuilder.ts`, `src/world/BuildingGrammar.ts`, `+0` Static Draw Calls)

Eliminate the "solid rectangular block" illusion by carving genuine walkable, fightable 3D hollow spaces into **6–10 hero buildings per sector** (Sectors 1–4; `4–6` perimeter buildings around the central plaza in Sector 5; never carving `CYLINDER_RING_TOWER`, `X_TRUSS_TOWER`, `TWIN_ARCH_GATE`, or `SLANT_CORP_TOWER` megastructures!).

#### 1.1 Build-Order Hoist, Per-Face Program Selection & Dual-Splitting Rule (CRITICAL!)
> [!CAUTION]
> **Live Codebase Invariants (`CityBuilder.ts:4901-4909`, `5694-5866`, `5881-6045`)**:
> 1. `CityBuilder.ts:4901-4909` currently emits `G.bodies` and `BUILDING` colliders ~1,000 lines BEFORE `gallery()` (`L5694`) and `assignPrograms()` (`L5855`).
> 2. `GroundProgram` (`CYBER_EATERY`, `TECH_APPAREL`, `CAPSULE_HOTEL`, `CYBER_APARTMENT`, `ALLEY_INFRA`) is assigned **per `FaceSpan`** (`BuildingGrammar.ts:945`), NOT per building!
> 3. `groundFace()` (`L5881-6045`) paints solid 1F bay fills (`PANEL`/`VITRINE`/`SHUTTER`/`GRILLE`), fake recessed doors (`L5999`), 1F `G.concrete` lintels (`y ∈ [3.60, 4.00]` at `L5892`), and `baySocket()` props (`L5906-5909`) directly across every 1F bay; `gallery()` (`L5748-5759`) emits solid fake doors and barred windows across 2F–3F corridor faces.

**Required Clean Architecture**:
1. **Hoist Program Assignment & Interior Planning**: Run `assignPrograms()` (which depends only on `buildings`, `streets`, `alleys`, and `b.plan.faces`) and `InteriorBuilder.planInteriors(...)` **BEFORE** the `CityBuilder.ts:4901` tower body/collider emission loop (or defer emitting `G.bodies` + `BUILDING` colliders for buildings with carved interiors until immediately after planning).
2. **Select Eligible FaceSpans & Clamp Room Footprints Safely**:
   - Lots can be as small as `10 m × 10 m` (`CityBuilder.ts:7854`) and `L_SHAPE` wings down to `6.5 m` (`BuildingGrammar.ts:77, 349`).
   - NEVER hardcode fixed room sizes that exceed the host `MassBox`! Filter host boxes so `boxW >= minW + 1.2 && boxD >= minD + 1.2` and clamp room footprint dynamically to `[minW .. min(maxW, boxW - 1.2)] × [minD .. min(maxD, boxD - 1.2)]`, preserving `>= 0.6 m` structural wall/core margin on non-open sides!
   - For `PODIUM_OFFSET`, carve strictly inside `boxes[0]` (`y ∈ [0, 8]`). For `L_SHAPE`, pick ONE wing `MassBox` whose opposing open faces lead onto street/alley/courtyard (never into the adjacent wing or lockdown barrier `±(H - 0.5)`!).
3. **Dual-Splitting — BOTH `G.bodies` Visual Mesh AND `BUILDING` Colliders**:
   When carving hollow volume `R = [rx0, rx1] × [ry0, ry1] × [rz0, rz1]` from `MassBox` `B = [bx0, bx1] × [by0, by1] × [bz0, bz1]`:
   - **Above Slab** (`y ∈ [ry1, by1]`): full footprint emitted into `G.bodies` (up to `top = by1 - 0.45`) and `colliders` (`BUILDING`).
   - **Below Slab** (for 2F–3F `INTERIOR_APARTMENT` where `ry0 > by0`, `y ∈ [by0, ry0]`): full footprint emitted into `G.bodies` and `colliders` (`BUILDING`).
   - **Solid Core Remainder on `[ry0, ry1]`**: subtract `[rx0..rx1] × [rz0..rz1]` from `[bx0..bx1] × [bz0..bz1]` into up to `4` non-overlapping axis-aligned solid sub-boxes (emitting each box only when thickness `>= 0.25 m`) for BOTH `G.bodies` and `BUILDING` colliders!
   - **Suppress Conflicting 1F & Gallery Overlays**:
     - Pass a `carvedBays` set/query into `groundFace()` (`L5881-6045`) and `gallery()` (`L5748-5759`).
     - On any 1F bay overlapped by a carved doorway, shopfront window, or arcade opening: **suppress** solid bay fills (`PANEL`/`VITRINE`/`SHUTTER`/`GRILLE`), fake recessed door leaves (`L5999`), conflicting `baySocket()` props inside the opening, and (for `PASS_ARCADE`) overlapping Type D canopies/lintels!
     - On any `GALLERY_DANCHI` 2F–3F apartment bay: **suppress** the fake corridor door (`L5748`) and exterior barred window (`L5755`), replacing them with the real `InteractiveDoor` and `DestructibleGlass` window!
     - **`phase10b2.test.ts:104, 140-154` Compliance**: Keep carved 1F street doorways recorded cleanly in `groundDoors` (maintaining `L.groundDoors.length >= 60` across all 5 sectors × Loops `0..2`), and recess dynamic `'DOOR'` colliders at **`d ∈ [-0.14, 0.02]`** (strictly `<= 0.02`, NEVER intruding into the `[0.05, 1.5]` outward clearance band asserted by `phase10b2.test.ts:140-154`!).
   - **Interior Room Envelope (`G.concrete`, `G.archPaint`, `G.steel`, `G.strips` — `+0` Draw Calls)**:
     - Floor slab (`thickness 0.16 m` flush at `y = ry0`, ground-edge `aAo = 0.55`).
     - Ceiling soffit (`thickness 0.18 m` at `y = ry1 - 0.18`, soffit `aAo = 0.50`) + recessed linear ceiling light troughs (`G.strips`, emissive `0.85–1.15`).
     - Interior perimeter walls (`thickness 0.30 m`, corner `aAo = 0.44`) split around exact openings:
       - **Doorways**: `width 1.15–1.80 m × height 2.25 m` (`y = ry0 .. ry0 + 2.25`), framed by dark-steel jambs & lintel header (`G.steel`). Blocked ONLY by dynamic `DOOR` collider (`active: true`).
       - **Windows**: `width 2.4–3.6 m × height 2.05–2.95 m` (sill `y = ry0 + 0.65` for eateries/apartments, floor-to-ceiling `y = ry0 + 0.10 .. ry0 + 3.05` for tech shops). Blocked ONLY by dynamic `GLASS` collider (`active: true`).
   - **Wall-Run Preservation**: Every carved building retains `>= 2` flush exterior `runFaces` (upper walls above `Y = 4.0 m` and uncarved faces stay 100% flush).
4. **Export `SectorLayout.interiors` (Shared With Phase 11B & Phase 12B!)**:
   ```ts
   export interface InteriorVolume {
     readonly id: number;
     readonly building: number;
     readonly template: 'EATERY' | 'TECH_SHOP' | 'PASS_ARCADE' | 'APARTMENT';
     readonly aabb: Aabb3;
     readonly floorY: number;
     readonly entryPoints: readonly THREE.Vector3[];
     readonly doorIds: readonly number[];
     readonly glassIds: readonly number[];
   }
   ```
   Expose `readonly interiors: readonly InteriorVolume[]` on `SectorLayout` (`CityBuilder.ts:273`) so Phase 12B-3 (ViewModel indoor drying) and 12B-4 (Spatial interior acoustics + broken-window rain rush!) query `layout.interiors` in `O(interiors.length <= 10)` with zero allocations!

#### 1.2 The 4 Authentic Cyberpunk Enterable Interior Templates (`+0` Static Draw Calls)
Each room registers `1–2` soft interior `addLight()` sources (`intensity 1.1–1.5`, color matched to template) so warm/neon interior light spills out through shopfront glass onto wet sidewalks:
1. **`INTERIOR_EATERY`** (`2` in S1–S4, `1` in S5; selected from `CYBER_EATERY` street-facing `FaceSpan`s; clamped footprint `6.4–8.0 m × 5.6–7.0 m`, clear height `3.50 m`):
   - Dark wet-tile floor (`G.concrete`), concrete + timber-slat walls (`G.archPaint`, corner `aAo = 0.42`), L-shaped noodle bar counter (`y = 0.0 -> 1.05 m`, solid `PROP` crouch-cover collider), recessed kitchen exhaust hood (`G.steel`), warm amber backlit menu strip (`G.strips`, `0.95`), ceiling pendant rods.
   - **Dual Access**: Front street `InteractiveDoor` + shootable `DestructibleGlass` storefront window + rear/side alley `InteractiveDoor` (genuine flanking route!).
   - Furnished with `InteriorPropsKit` `v0`, `v1`, `v7` + breakable stools.
2. **`INTERIOR_TECH_SHOP`** (`2` in S1–S4, `1` in S5; selected from `TECH_APPAREL` street-facing `FaceSpan`s; clamped footprint `7.0–10.0 m × 5.6–7.0 m`, clear height `3.50 m`):
   - Dark slate floor, **wide floor-to-ceiling `DestructibleGlass` street shopfront windows (`y = 0.10 .. 3.05 m`)** showing a real glowing 3D cyber-gear showroom from the avenue!
   - Recessed cyan/magenta wall display alcoves, central showcase counter (solid base `PROP` collider `y = 0..0.92`, shatterable top glass), ceiling light tracks, and rear/side service `InteractiveDoor`.
   - Furnished with `InteriorPropsKit` `v2` (cyber-helmet pedestals) & `v3` (tactical cyberpunk jacket racks).
3. **`INTERIOR_PASS_ARCADE`** (`2` in S1–S4, `1` in S5; carved through `CAPSULE_HOTEL` face / `PODIUM_OFFSET` `boxes[0]` / eligible `L_SHAPE` single wing; `4.5 m` wide × full wing depth × **`3.50 m` clear height**, clearing 1F `3.60 m` lintel & canopies cleanly!):
   - Genuine concave covered colonnade breezeway / hotel lobby slicing clean through a building from avenue to alley!
   - Chamfered concrete colonnade piers (`aAo = 0.45`), linear cyan/white ceiling light troughs, recessed lobby check-in alcove (`InteriorPropsKit` `v6`), and kickable `InteractiveDoor`s (or open archway + `DestructibleGlass` lobby partitions).
4. **`INTERIOR_APARTMENT`** (`2–3` in S1–S4, `1` in S5; carved into `GALLERY_DANCHI` 2F–3F `floorY` slices aligned to actual gallery deck elevation; clamped `5.2–6.0 m × 4.4–5.0 m × 3.50 m`):
   - Gritty concrete walls (`aAo = 0.40`), low steel-frame bed/futon platform (`PROP` collider `y = 0..0.46 m`), overhead caged fluorescent tube (`G.strips`), **kickable front `InteractiveDoor`** opening onto the exterior gallery corridor, AND a **`2.8 m × 2.0 m` `DestructibleGlass` street-facing window** (`sill y = floorY + 0.65 m`) so players can burst through the apartment, shoot out the street window, and grapple out into mid-air Bullet Time!
   - Furnished with `InteriorPropsKit` `v4` (dual-monitor terminal desk & swivel chair), `v5` (compact kitchenette), and `v7`.

---

### 11A-1b. Deep 3D Architectural Relief — True Concavity & Protrusion (`BuildingGrammar.ts`, `CityBuilder.ts`, `+0` Extra Draw Calls)

Break the "flat slab" silhouette across towers while strictly keeping **`>= 2` flush `runFaces` per tower** (`<= 0.22 m` max trim projection) AND keeping all existing `phase10a1` / `phase10b` sign-attachment invariants 100% green:
1. **Mid-Tower Concave Mechanical Refuge Sky-Notches (`roofY >= 36 m`, Non-Megastructure Towers)**:
   - **Floor-Grid Alignment (CRITICAL)**: Snap `yNotch` using **`floorTopY(b.arch, n)`** (`BuildingGrammar.ts:154-162`) so Type B (`ARCH_B`, `FLOOR_BASE_M = 2`, floors at `2 + 4n`: `22, 26, 30, 34 m`) NEVER has windows sliced in half!
   - **Zero Sign/Feature Collision**:
     - Skip sky-notches on towers/bands carrying Type B `balconyFaces`, Type C `escapeFaces` (`0..28 m`) / `ductFaces`, `PENCIL_TOWER` `spineFaces`, or within `4 m` of a `STEPPED_SETBACK` terrace seam.
     - **Split `b.plan.faces` / `buildingSpans` cleanly around `[yNotch, yNotch + 4.0]` BEFORE placing neon signs & Mega-Billboards** so `phase10a1.test.ts:437-502` and `phase10b.test.ts:150-227` never place a floating sign across a notch void!
   - **Geometry**: Split tower `G.bodies` & `BUILDING` collider into lower shaft (`y0 .. yNotch`), recessed mechanical core (`yNotch .. yNotch + 4.0`, inset `1.8–2.4 m`, louvered cladding `aAo = 0.38`), and upper shaft (`yNotch + 4.0 .. y1`). Add `4–8` perimeter structural steel columns (`G.steel`, `0.45 × 4.0 × 0.45 m`), walkable perimeter refuge concrete ledge (`aAo = 0.36` soffit shadow), `1.05 m` safety rail + thin amber/cyan rail strip (`G.strips`, `0.90`).
   - **Grapple Anchors**: Add `'LEDGE'` to `AnchorKind` union in `CityBuilder.ts:148` and mount `1–2` `GrappleAnchor`s (`kind: 'LEDGE'`) at notch outer corners!
2. **Deep `0.45–0.55 m` Recessed Upper-Floor Window Reveals & Sun-Breaker Fins (`2F–8F`, Non-Run Feature Faces)**:
   - Project `0.48 m`-deep vertical concrete structural piers (`G.concrete`, inner jamb `aAo = 0.38`) every `4.0 m` bay, `0.42 m` bevelled window sills, and `0.38 m` horizontal dark-steel sun-breaker louver fins (`G.steel`) above lintels — ending flat painted facades!
3. **Cantilevered Bay-Window & Exterior HVAC Service Pods (`Y = 8–32 m`, Non-Run Faces)**:
   - On `35–50%` of non-megastructure towers (strictly verifying adjacent corridor clearance `>= 2.4 m` and avoiding sign/billboard spans), mount `1–2` staggered protruding bay-window pods (`3.2 × 0.95 × 2.8 m`, supported by twin `45°` underside steel brackets with dark soffit `aAo = 0.38`, solid `BUILDING` collider) and exterior utility pods (`2.4 × 1.2 × 2.4 m`).
4. **Deeper Ground-Floor Vestibules & Diagonal Canopy Tie-Rods (`+0` Calls)**:
   - Deepen non-run 1F structural piers to `0.52 m` and recessed shop vestibules to `0.85–1.15 m`, and anchor projecting 1F storefront canopies back into upper facade columns with visible `45°` diagonal steel tension tie-rods (`G.steel`, `r = 0.032 m`).

---

### 11A-1c. High-Craft Close-Up `InteriorPropsKit` (`src/world/InteriorBuilder.ts`, `cap: 260`, `+1` Draw Call, `64 m` Vertex Cull)

One persistent `InstancedMesh` (`name = 'InteriorPropsKit'`, `cap = 260`, `+1` draw call) packing all `8` close-up variants (`aVar 0..7`) matching **`HERO_3D_MODELING_SPEC.md` §4**:
* **Hard Budgets**: Every variant `<= 360` tris (`<= 450` hard cap); every variant `|bbox.min.y| <= 0.02` (`v0` sits flush on counter top `y = floorY + 1.05 m`; `v1..v7` stand flush on `floorY`).
* **Shader Contract**: `MeshStandardMaterial` + `injectCityLights` + per-vertex `aPart`, `aAo`, `aVar` + per-instance `aProp (vec4: variant, tintIdx, emissiveScale, unused)`.
  - **Vertex-Shader `64 m` Distance Cull**: If `length(cameraPosition - instWorldPos) > 64.0 || abs(aVar - aProp.x) > 0.5`, collapse `transformed = vec3(0.0)` (zero distant interior overdraw!).
  - **Bloom Guard**: Non-emissive surfaces strictly `albedo <= 0.62`; monitors/bulbs/placards controlled at `0.85–1.15`.
* **Variants (`v0..v7` per `HERO_3D_MODELING_SPEC.md` §4)**: `v0` Eatery counter ramen place-settings · `v1` Kitchen boiler/ladle station · `v2` Tech shop illuminated cyber-helmet pedestal · `v3` Tech apparel tactical jacket rack (4 jackets) · `v4` Apartment dual-monitor cyber desk & swivel chair · `v5` Apartment mini-fridge/microwave kitchenette · `v6` Arcade/hotel reception console & lounge bench · `v7` Caged industrial pendant lamp + standing fan & storage totes.
* **Phase 11B Auto-Registration**: Export `readonly interiorProps: readonly InteriorPropRecord[]` on `SectorLayout` (`{ instIndex, variant, worldPos, halfExtents, floorY, tint, destructible }`, marking `v0, v2, v3, v4, v5, v7` destructible!).

---

### 11A-2. Kickable Breach Doors & Silent Stealth Opening (`src/entities/DestructibleManager.ts`, `ViewModelRenderer.ts`, `InputManager.ts`, `HudManager.ts`, `index.html`, `AudioEngine.ts`, `PhysicsWorld.ts`, `PlayerController.ts`)

Every carved interior doorway (`12–24` doors/sector) is a live **`InteractiveDoor`** rendered via ONE pooled `InstancedMesh` (`name = 'InteractiveDoors'`, `cap = 32`, **`+1` draw call**) built to **`HERO_3D_MODELING_SPEC.md` §5.2** (`~160` tris, `1.04 × 2.16 × 0.075 m` scaled per doorway, stamped panels, wire-glass slit, crash bar/lever, kickplate, lock status LED: amber closed / green quietly opened). Add per-instance `InstancedBufferAttribute('aDissolve', 4)` + `onBeforeCompile` scanline dissolve to `InteractiveDoors`' material (mirroring `DestructDebris`) so flying breached door panels digitally disintegrate with `+0` extra draw calls!

#### 2.1 Input Binding Conflict Resolution & Controls UI (`InputManager.ts`, `index.html`, `HudManager.ts`, `main.ts`)
> [!WARNING]
> In `d7ac480` (`InputManager.ts:51, 264-282`), `KeyF` is mapped to `'FULLSCREEN'`, `PREVENT` only calls `e.preventDefault()` when `this.locked` is true, and controls legends live in **`index.html:599, 606`** (with no Pause-screen Fullscreen button yet).
* **Exact Clean Wiring**:
  1. Add `'INTERACT'` to `DiscreteAction` (`InputManager.ts:22`); map BOTH **`KeyF`** and **`KeyE`** in `KEY_DISCRETE` to `'INTERACT'`; add `'KeyE'` and `'F11'` to `PREVENT`.
  2. Remap `'FULLSCREEN'` from `KeyF` to **`F11`**, AND call **`e.preventDefault()` unconditionally for `e.code === 'F11'`** (even when `!this.locked`, matching `Tab` at `InputManager.ts:265`) so Chrome's native `F11` fullscreen NEVER conflicts with `toggleFullscreen()`!
  3. Update **`index.html:599, 606`** controls legends to show **`[F / E] BREACH / OPEN`** and **`[F11] FULLSCREEN`**, add a clean **`FULLSCREEN`** button to the Pause menu in `index.html` / `HudManager.ts`, and add a compact contextual interact prompt element below the reticle in `index.html` / `HudManager.ts`:
     - Within `2.2 m` of a closed `InteractiveDoor` (view forward dot `>= 0.55`):
       - When **`player.state === 'CROUCHING'`**: **`[F] OPEN QUIETLY`**
       - Otherwise (standing/running/airborne): **`[F] BREACH KICK`**

#### 2.2 First-Person Cyber-Boot Kick Rig (`src/player/ViewModelRenderer.ts`, `HERO_3D_MODELING_SPEC.md` §5.1, `+0` Draw Calls)
* Build armored lower shin guard + twin chrome exo-ankle hydraulic pistons + lugged tactical cyber-boot (`~280` tris) via `ViewModelKit` (`MeshKit`, sharing `this.hardMat` & `this.gearMat` — **`+0` draw calls!**).
* **Parent Node (CRITICAL)**: Attach the kick rig group as a child of **`this.root`** (`ViewModelRenderer.ts:488-494`, NOT directly to `this.scene`) so `main.ts:840` (`viewModel.root.visible`) automatically hides it on Title and Photo Mode!
* **Kick Animation Arc (`0.22 s`, real-time `realDt`, never freezes camera look!)**:
  - `0.00–0.05 s`: chamber knee up (`y: -0.75 -> -0.22, z: -0.25`), weapon dips smoothly (`y: -0.14, rx: -0.28`, zero clipping!).
  - `0.05–0.12 s`: explosive extension forward (`z: -0.25 -> -0.74, y: -0.14`, sole pitched `+24°` impacting door!).
  - `0.12–0.22 s`: snap retraction back below frame while weapon returns to ready pose.
  - Camera punch: `kickPitch = -1.2°`, `kickZ = +0.06 m`, `trauma += 0.28`.

#### 2.3 `ColliderKind` Extensions, `PhysicsWorld` Fixes & Three Door Interaction Modes
* **`CityBuilder.ts:109-120` & `PhysicsWorld.ts`**:
  - Add **`'DOOR' | 'GLASS'`** to `ColliderKind`.
  - In `PhysicsWorld.findLedge()` (`L725`): skip `'DOOR'` and `'GLASS'` (players never auto-mantle thin doors or glass panes!).
  - In `PhysicsWorld.ts:1242` (`LOS_IGNORE`): include `'GLASS'` so enemies can see players through intact shopfront/apartment glass (while projectiles & grapple tests explicitly intersect active `'GLASS'` colliders!).
* **Three Door Modes**:
  1. **Breach Kick** (`[F]`/`[E]` when `player.state !== 'CROUCHING'`, OR automatic on **Slide / High-Speed Sprint Impact `horizSpeed >= 9.0 m/s`** pre-probed along `_delta` in `PlayerController.fixedUpdate()` before `movePlayer()` so momentum isn't snapped dead!):
     - Plays `0.22 s` boot-kick viewmodel animation + heavy metallic door-slam/latch-snap SE (`AudioEngine.doorBreach(pos)`).
     - Instant `O(1)` collider disable: `physics.setColliderActive(door.colliderIndex, false)`.
     - Door slab detaches and rockets inward at `11.0 m/s` (+ `1.8 m/s` lift + tumbling angular velocity), bounces off `door.floorY + 0.08`, rests `2.0 s`, then digitally disintegrates over `0.55 s` (`aDissolve`) before hiding (`_zeroMat`).
     - **Behind-Door Combat Payoff**: Enemies within `2.4 m` cone behind the breached door take **`40` damage**, **`1.5 s` stun**, and **`8.5 m/s` inward knockback** + `BREACH STUN` HUD event!
     - Emits `22 m` alert impulse (`enemies.onPlayerGunshot(door.pos, 22)`).
  2. **Silent Stealth Open** (`[F]`/`[E]` while **`player.state === 'CROUCHING'`**):
     - Immediately calls `physics.setColliderActive(door.colliderIndex, false)`.
     - Smoothly pivots door `105°` inward around hinge edge over `0.38 s`, turns lock LED emerald green, plays quiet oiled-hinge creak (`AudioEngine.doorCreak(pos)`), emits **`0 m` noise**!
  3. **Ballistic Breach (`EffectsPool.updateProjectiles()`)**:
     - `1` K-90 Sniper shot or `2` MK-IV Pistol shots hitting an active `'DOOR'` collider blast it inward identically to Breach Kick (including behind-door stun & `22 m` noise). **Skip `addScorch()` on `'DOOR'` colliders** so no floating scorch marks hang in mid-air after breaching!

---

### 11A-3. Shootable & Crash-Through Destructible Glass + Shared `DestructDebris` Pool (`src/entities/DestructibleManager.ts`, `EffectsPool.ts`, `PlayerController.ts`, `AudioEngine.ts`, `+2` Draw Calls)

* **`DestructibleGlassPanes` `InstancedMesh` (`cap = 48`, `+1` draw call)**:
  - Translucent tempered-glass material (`transparent: true, depthWrite: false, side: THREE.DoubleSide`, `renderOrder = 4`, `injectCityLights`): subtle rain-streaked Fresnel glints, dark-steel perimeter bezel + center mullion for wide panes (`> 2.2 m`), normal-incidence alpha **`0.18–0.32`** ramping to `0.65` at grazing angle so furnished 3D interiors look crystal clear from the street!
* **Break Triggers**:
  1. **Ballistic Pass-Through (`EffectsPool.updateProjectiles()`, `L1097-1155`)**: When a swept projectile hits an active `'GLASS'` collider, call `onGlassHit(colliderIndex, hitPos, dir)` → shatter pane + `setColliderActive(id, false)`, **do NOT stamp a scorch decal**, **do NOT set `pActive[i] = 0`**, and immediately re-sweep the remaining segment distance in the same fixed step with **`100%` damage preserved**!
  2. **Zero-Speed-Loss High-Speed Dive (`PlayerController.fixedUpdate()`)**: Pre-probe active `'GLASS'` colliders along `_delta` before `movePlayer()` whenever `horizSpeed >= 9.0 m/s` or `state === 'SLIDING'` or grappling (`GRAPPLE_SWING`/`GRAPPLE_PULL`): shatter every intersected glass pane and disable its collider BEFORE `movePlayer()` / `resolveVelocity()` runs so the player bursts clean through with **ZERO velocity loss (`100%` speed preserved!)**.
* **Shatter VFX, Audio & Stealth**:
  - Instant hide (`_zeroMat`) + `O(1)` `physics.setColliderActive(pane.colliderIndex, false)`.
  - Plays multi-layer tempered glass crash + crystalline shard tinkle SE (`AudioEngine.glassShatter(pos)`: `Highpass 4800 Hz` burst + `6` staggered sine/triangle chimes `2800–6400 Hz`).
  - Spawns **`22–30` glittering tumbling glass shards** into the shared `DestructDebris` pool (`+1` draw call introduced cleanly right here in 11A so glass & breached doors already bounce and digitally disintegrate, and Phase 11B plugs props straight into the same pool!).
  - Emits `26 m` acoustic alert impulse (`enemies.onPlayerGunshot(pane.pos, 26)`).

---

## PHASE 11B — Destructible Small Props, Tumbling Digital-Dissolve Debris & Draw-Call Consolidation

### 11B-1. Shootable & Slide-Breakable Street & Interior Props (`src/entities/DestructibleManager.ts`, `CityProps.ts`, `CityPropMeshes.ts`, `EffectsPool.ts`)

Turn small street, alley, corridor, and interior props into reactive physics targets — **zero geometry rebuilds, zero per-frame allocations**.

#### 1.1 Exact Destructible Prop Table (Verified Against Live `CityProps.ts:82-147` `PropId`s)
| Prop Category (Exact Live `PropId` / Kit Variant) | HP | Break Triggers | Debris Profile | Sound Distraction Radius |
| :--- | :---: | :--- | :--- | :---: |
| Cardboard Piles (`BOXES`, `BOX_TOWER`, `BOX_PILE`) | `1` | Bullet / Slide / Kick | `10` flat damp-brown corrugated flaps | `10 m` |
| Potted Plants (`POT_PLANT`, `PLANTER`, `PLANT_ON_BIN`, `SUCCULENTS`) | `1` | Bullet / Slide / Kick | `12` terracotta shards + dark-green leaves | `12 m` |
| Storage Crates & Buckets (`BINS`, `CRATES`, `TOTE_BUCKET`, `WIRE_RACK`) | `1` | Bullet / Slide / Kick | `10` tinted plastic/steel shards matching `tint` | `12 m` |
| Cones, Pallets, Stools, Umbrellas, Canisters (`CONES`, `PALLETS`, `STOOLS`, `UMBRELLA`, `CANISTERS`) | `1` | Bullet / Slide / Kick | `10` orange plastic / wood splinters / bent steel | `14 m` |
| Trash Bins & Bag Mounds (`BIN_BAGS`, `BAG_MOUND`) | `2` (`1` Sniper) | Bullet / Slide / Kick | `14` bent steel + glossy black scrap chunks | `16 m` |
| Oil Drums (`DRUMS`) | `2` (`1` Sniper) | Bullet / Kick | `14` rusted steel chunks + spark burst | `18 m` |
| Illuminated A-Frames (`AFRAME`) & Interior Props (`InteriorPropsKit` `v0, v2, v3, v4, v5, v7`) | `1` | Bullet / Slide / Kick | `14` glass/ceramic/plastic shards + cyan/amber sparks | `18 m` |

* **Indestructible Cover**: `DUMPSTER`, `DUMPSTER_OPEN`, `BENCH`, `JERSEY`, walls, vending machines, ramen carts, bus shelters, and vehicles remain solid tactical cover.

#### 1.2 `CityPropMeshes.commit()` Record Export, `8 m` Static Hash & Projectile-Swept Destruction
* Extend **`CityPropMeshes.commit()`** (`CityPropMeshes.ts:807`) to also emit a flat destructible-prop record array `{ propId, kitId, instanceIndex, shadowIndex, worldPos, halfExtents, floorY, tint }` (`shadowIndex === -1` for props like `POT_PLANT`/`AFRAME` that don't emit a `PropContactShadows` quad at `L872-892`, and exact shadow instance index for `DEBRIS`/`PALLETS`/`DRUMS`).
* Build a pre-allocated **`8 m` CSR 2D spatial hash grid** in `DestructibleManager` covering all destructible street props + `layout.interiorProps` (`v0, v2, v3, v4, v5, v7`).
* **Swept Projectile Integration (Bullet-Time Accurate!)**: Call `DestructibleManager.raycastProp(segStart, segDir, segLen, damage, isSniper)` inside **`EffectsPool.updateProjectiles()`** along each projectile's per-step swept segment (NOT at trigger-pull!) so Bullet Time tracers visibly strike and shatter distant bottles/monitors/crates at the exact moment of arrival! Light `1`-HP props let the bullet pass cleanly through without stopping.
* **Player Slide / Hard-Sprint Break**: Check `3×3` cells around the player in `DestructibleManager.checkPlayerSlideBreak(pos, vel, sliding)` when `sliding && speed >= 6.5` or `speed >= 10.5`, shattering slide-breakable props with zero player slowdown.
* **Zero-Alloc Hiding & Stealth Distraction**:
  - Write pre-allocated `_zeroMat` (scale `0,0,0`) to `mesh.setMatrixAt(entry.instanceIndex, _zeroMat)` (`needsUpdate = true`).
  - If `entry.shadowIndex >= 0`, write `_zeroMat` to `PropContactShadows` at `entry.shadowIndex` (`needsUpdate = true`).
  - Call `enemies.onPlayerGunshot(entry.pos, entry.noiseRadius)` **at the broken prop's impact position** (NOT the player's position!) so suppressed shots lure patrolling `UNAWARE`/`ALERT` enemies to inspect the shattered object!

---

### 11B-2. Tumbling Debris Physics & Signature Digital Scanline Disintegration (`src/entities/EffectsPool.ts`, `AudioEngine.ts`)

* **`DestructDebris` `InstancedMesh` (`cap = 200`, pre-allocated SoA ring buffer, introduced in 11A-3 & shared across doors, glass, street props, interior props, and Phase 12B-1 enemy armor plates!)**:
  - **Geometry**: Sculpted angular bevelled shard (`~20` tris), scaled non-uniformly per chunk (flat plates for cardboard/glass/monitors, chunky prisms for ceramic/metal, splinters for pallets).
  - **Physics (`simDt`, Bullet-Time Compatible)**: Initial velocity `3–11 m/s` along impact/kick/slide direction + cone spread, gravity `-22 m/s²`, tumble `6–16 rad/s`, bounce at `y = floorY` (`restitution = 0.35`, horizontal friction `0.62`, sleep `< 0.15 m/s`). Skip minor non-player debris beyond `52 m` from camera.
  - **Digital Scanline Dissolve Shader**: Per-instance `aDissolve (vec4: progress 0..1, isGlass 0|1, seed, glowBoost)` + `instanceColor`:
    - First `1.4–2.2 s`: solid PBR tumbling debris (`injectCityLights`; bright specular Fresnel sheen when `isGlass > 0.5`).
    - Final `0.55 s` (`progress: 0 -> 1`): crisp world-grid digital clip (`discard`) bordered by a glowing **cyan/amber scanline edge (`0.12` width, HDR `2.2`)**, emitting `1` tiny rising spark on vanish!
  - **Material-Matched Procedural Impact SE (`AudioEngine.ts`)**: `propBreak(pos, mat: 'CARDBOARD' | 'CERAMIC' | 'WOOD' | 'PLASTIC' | 'METAL' | 'ELECTRONIC')` (`3D` panned via `panner()`, max `6` overlapping voices).

---

### 11B-3. Draw-Call Consolidation & Final Phase 11 Performance Certification

1. **Verify `O(1)` Dynamic Colliders**: Confirm opening/breaching doors and shattering glass panes call `PhysicsWorld.setColliderActive(id, false)` in `O(1)` time without rebuilding the spatial grid, and verify `raycast()`, `lineOfSight()`, and **`PhysicsWorld.movePlayer()`** (`PhysicsWorld.ts:350`) strictly skip `c.active === false`.
2. **Safe Draw-Call Consolidation (`-1` Call Without Breaking `props.test.ts`!)**:
   - **Keep `CityPropMeshes` at 10 kits** so every assertion in `props.test.ts:305-325` (`meshes.length === 10`, exact names, `< 4000` verts/kit) stays 100% green!
   - Consolidate **`acUnits` + `ducts`** inside `CityBuilder.ts` (`L1319-1320, 2461-2472`) into ONE **`RoofMechKit`** `InstancedMesh` (`-1` call), using per-vertex `aPart` + per-instance `aInstVar (0 = AC unit, 1 = duct)` in `onBeforeCompile` (`v == 0` samples `machinery` PBR maps; `v == 1` uses untextured `0x4a525e`, `roughness 0.30, metalness 0.90`, preserving X-axis length scaling!).
3. **Final Draw-Call Budget Table (`<= 120` Hard Ceiling)**:

| System | Delta | Sector 4 HIGH Full-Combat Total |
| :--- | :---: | :---: |
| Phase 10D Post-Implementation Baseline | `—` | **`~84`** |
| 11A: Enterable Interiors (`G.*`) + Deep Relief + Cyber-Boot ViewModel | **`+0`** | `84` |
| 11A: `InteriorPropsKit`, `InteractiveDoors`, `DestructibleGlassPanes`, `DestructDebris` | **`+4`** | `88` |
| 11B: Destructible Prop Grid + Audio (`+0`), `RoofMechKit` (`acUnits` + `ducts`, `-1`) | **`-1`** | **`~87`** (`33` calls below `120` cap!) |

---

## Phase 13 Blender `.glb` Swap-Ready Contract (`HERO_3D_MODELING_SPEC.md` §7, `+0` Runtime Cost)

To keep all Phase 11 interior props, doors, and the first-person cyber-boot cleanly replaceable by Blender `.glb` models in Phase 13:
* Export `INTERIOR_PROP_BOUNDS` (`v0..v7` canonical envelopes) from `src/world/InteriorBuilder.ts` and `DOOR_DIMS = { w: 1.04, h: 2.16, d: 0.075, hingeX: -0.52 }` from `src/entities/DestructibleManager.ts` (door leaf centered at `x ∈ [-0.52, +0.52], y ∈ [0, 2.16]`, silent-open hinge rotation axis along local `x = -0.52`).
* Isolate procedural mesh construction into pure exported factories (`buildInteriorPropsKit()`, `buildInteractiveDoorGeometry()`) separate from placement/physics logic.
* Name the first-person cyber-boot group **`'BootKickRig'`** (child pivot **`'bootPivot'`**) under `ViewModelRenderer.root` so a rigged Blender `.glb` boot drops cleanly into the `0.22 s` kick arc!

---

## Mandatory Verification & Unit Tests (`tests/phase11a.test.ts`, `tests/phase11b.test.ts`)

### Phase 11A Tests (`strand-protocol/tests/phase11a.test.ts`)
1. **Zero Blocking Collider & Visual Opening Inside Carved Interiors**: Across Sectors 1–5 × Loops `0..2`, assert `interiors.length >= 6` (S1–S4) and `>= 4` (S5); assert NO active `BUILDING` collider overlaps any interior hollow `aabb` (inset `0.05 m`); assert NO `G.bodies` triangle blocks any carved doorway or shopfront/apartment window opening.
2. **Doorway Walkability, `phase10b2` Clearance & `O(1)` Breach**:
   - Raycast from `1.5 m` outside every enterable doorway into the room hits ONLY its `'DOOR'` collider; after breach/silent open (`setColliderActive(id, false)`), the exact same raycast passes clean into the room.
   - Assert `L.groundDoors.length >= 60` and zero `'DOOR'` colliders intrude into `[0.05, 1.5]` outward of `L.groundDoors`.
3. **Breach Mechanics, Stealth & Keybind Remap**:
   - Breach Kick damages/stuns behind-door enemies within `2.4 m` (`40 dmg`, `1.5 s`), emits `22 m` alert, and skips `addScorch()` on `'DOOR'`.
   - Crouched (`player.state === 'CROUCHING'`) `[F]` opens smoothly (`105°` over `0.38 s`) with `0 m` noise.
   - `InputManager` maps `KeyF` and `KeyE` to `'INTERACT'`, maps `F11` (with unconditional `preventDefault`) to `'FULLSCREEN'`.
4. **Glass Pass-Through, Zero-Speed-Loss Dive & Deep Relief**:
   - Swept projectile hitting `'GLASS'` shatters pane, disables collider (`O(1)`), preserves `100%` damage pass-through, emits `26 m` noise, stamps zero scorch decal.
   - Player moving `>= 9.0 m/s` through `'GLASS'` shatters pane with **`100%` velocity preserved**.
   - `InteriorPropsKit` all 8 variants `<= 360` tris, `|min.y| <= 0.02`; sky-notches satisfy `isOnFloorGrid(b.arch, yNotch)` for all archetypes (including Type B `2 + 4n`), every tower retains `>= 2` clean `runFaces`, and all existing `phase10a1`/`phase10b`/`phase10b2` sign/door tests pass!

### Phase 11B Tests (`strand-protocol/tests/phase11b.test.ts`)
1. **Spatial-Grid Equivalence & Dynamic Toggle**: `PhysicsWorld` spatial-grid `raycast`, `lineOfSight`, and `movePlayer` match brute-force scan across all 5 sectors, including after `setColliderActive(id, false)` on doors and glass.
2. **Zero-Alloc Prop Destruction, Shadow Sync & Stealth Distraction**:
   - Swept projectile breaking shadowed props (`BOXES`, `DRUMS`, `PALLETS`) zeroes their `instanceMatrix` determinant (`=== 0`) AND zeroes their `PropContactShadows` quad (`shadowIndex >= 0`); breaking non-shadowed props (`POT_PLANT`, `AFRAME`) and `InteriorPropsKit` `v4` zeroes their `instanceMatrix` cleanly (`shadowIndex === -1`); all spawn `DestructDebris` chunks completing digital dissolve (`0 -> 1`) and emit `onPlayerGunshot` at the **prop's impact coordinates**.
   - Indestructible cover (`DUMPSTER`, `JERSEY`, `BENCH`) ignores destruction damage.
3. **Draw-Call & Existing Test Certification**: All existing `props.test.ts` assertions pass unchanged (`10` prop kits), `RoofMechKit` saves `-1` call, `DestructDebris` cap `<= 200`, and Sector 4 HIGH full combat stays `<= 100` (hard ceiling `<= 120`).
