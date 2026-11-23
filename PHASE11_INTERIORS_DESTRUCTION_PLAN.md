# STRAND // PROTOCOL — Phase 11 Master Specification: Real Enterable Building Interiors, Kickable Breach Doors, Destructible Glass & Small Props With Digital Disintegration + Engine-Wide Optimization Pass (11A & 11B)

**Target Implementer**: Claude (TypeScript / Three.js / WebGL2 / Web Audio API)  
**Target Codebase**: `strand-protocol/` (on top of Phase 10D)  
**Master Spec Alignment**: `GAME_DESIGN_SPEC.md` v1.8  
**Execution Strategy (Token-Safe 2-Step Split)**: Complete, build, and test **Phase 11A** cleanly first; then implement and verify **Phase 11B** (including the engine-wide optimization & draw-call consolidation pass).

> [!IMPORTANT]
> **Hard Performance & Quality Targets (Faster Than Phase 10D!)**
> 1. **Net Performance Win**: Even with enterable 3D interiors, interactive breach doors, shatterable glass, and destructible props, Phase 11 MUST finish with **FEWER draw calls (`<= 104 calls / frame` in Sector 4, hard ceiling `<= 120`)** and **faster CPU frame times** than Phase 10D via `PhysicsWorld` 2D spatial-grid broadphase and `InstancedMesh` kit consolidation (`11B-3`).
> 2. **Zero Extra Static Draw Calls for Interiors**: All interior walls, floors, ceilings, counters, tables, beds, shelves, and interior lights MUST merge into existing `G.concrete`, `G.archPaint`, `G.steel`, and `G.strips` buckets (`+0` extra static calls, `+0` extra WebGL lights).
> 3. **Zero Per-Frame Heap Allocations** & 100% procedural WebGL2 + Web Audio API.
> 4. **Clean Modularity**: Extract `src/world/InteriorBuilder.ts` (hollow room carving, interior furnishings, collider splitting) and `src/entities/DestructibleManager.ts` (interactive doors, glass panes, destructible prop spatial grid, tumbling debris + digital disintegration).

---

## PHASE 11A — Real Enterable Building Interiors, Pass-Through Arcades, Kickable Breach Doors & Destructible Glass

### 11A-1. Real Hollow Building Interiors & Concave Pass-Through Arcades (`src/world/InteriorBuilder.ts`, `src/world/BuildingGrammar.ts`, `src/world/CityBuilder.ts`)
Eliminate the "solid rectangular block" illusion by carving genuine walkable 3D hollow spaces into **6–10 hero buildings per sector** (Sectors 1–4; 4–6 around the perimeter ring of Sector 5):

* **Zero-Breakage Collider Splitting Rule (CRITICAL)**:
  - When a building receives an enterable 1F room or pass-through arcade (`Y = 0.0 -> 3.85 m`, leaving the upper building solid from `Y = 4.0 -> roofY`):
    - **NEVER** register one solid `0 -> roofY` box collider across the carved room!
    - Split the building's `BUILDING` colliders cleanly into:
      1. Upper solid slab (`Y = 4.0 -> lowTop`)
      2. Solid 1F core behind/beside the room (`Y = 0 -> 4.0`, exact non-overlapping sub-AABBs)
      3. Interior room perimeter walls (`thickness 0.30 m`) with exact **doorway openings (`width 1.15–1.80 m × height 2.25 m`)** and **window openings (`width 2.4–3.6 m × height 2.15 m`, sill at `Y = 0.65 m` or floor-to-ceiling `Y = 0.10 m`)**!
      4. Ensure the building's `runFaces` (exterior wall-run faces above `Y = 4.0 m` and solid side walls) remain 100% flush and uninterrupted!
  - Similarly for enterable `GALLERY_DANCHI` 2F–3F apartments (`Y = floorY -> floorY + 3.80 m`): split that floor slice around the `6.0 m × 5.0 m` carved apartment box, keeping upper/lower floors solid and opening both the **corridor entry doorway** and a **destructible street-facing apartment window** (so the player can shoot out the window and grapple straight out into mid-air Bullet Time!).
* **4 Authentic Cyberpunk Enterable Interior Templates (All Merged into `G.concrete`, `G.archPaint`, `G.steel`, `G.strips` — `+0` Extra Draw Calls!)**:
  1. **`INTERIOR_EATERY`** (`2` per sector, carved into `CYBER_EATERY` ground floors, `8 m × 7 m × 3.8 m`):
     - Dark wet-tile floor (`G.concrete`), concrete/timber-slat walls with baked corner `aAo`, long **L-shaped stainless/wood noodle counter** (`Y = 0.0 -> 1.05 m`, collider!), recessed back kitchen hood & glowing amber menu board (`G.strips`), hanging warm pendant lamp shades (`Y = 2.6 m`), dining stools & small counter bowls/bottles (registered as Phase 11B destructible props!).
     - **Front street entrance** (kickable door + shootable frosted/clear storefront glass window) + **rear alley exit door** (creating a genuine stealth flanking route right through the noodle bar!).
  2. **`INTERIOR_TECH_SHOP`** (`2` per sector, carved into `TECH_APPAREL` ground floors, `10 m × 7 m × 3.8 m`):
     - Sleek dark slate floor, **large floor-to-ceiling destructible street glass shopfront windows** (now looking straight into a REAL furnished 3D shop interior from the street!), glowing cyan/magenta wall display alcoves with cyber-gear silhouettes, central **glass display counter** (destructible top!), illuminated ceiling light tracks, and side/rear service exit door!
  3. **`INTERIOR_PASS_ARCADE`** (`2` per sector, carved through `CAPSULE_HOTEL` / `PODIUM_OFFSET` / `L_SHAPE` ground floors, `4.5 m` wide × full building depth × `4.0 m` high):
     - Genuine **concave covered colonnade breezeway / hotel lobby passage** cutting all the way through a building base from avenue to back alley!
     - Heavy concrete colonnade piers (`aAo` ground contact), glowing ceiling linear strips, recessed lobby reception desk or vending kiosk alcove along one side, and kickable double lobby doors (or open archway + glass side partitions). Breaks up solid convex blocks both visually and tactically!
  4. **`INTERIOR_APARTMENT`** (`2–3` per sector, carved behind select 2F–3F doors of `GALLERY_DANCHI` blocks, `6.0 m × 5.0 m × 3.8 m`):
     - Gritty compact cyberpunk apartment unit: weathered concrete walls with dark corner `aAo`, low steel-frame bed/futon platform, corner desk with glowing cyan cyber-terminal monitor (destructible!), wall storage shelf, overhead caged fluorescent tube (`G.strips`), kickable front apartment door opening onto the exterior gallery corridor, and a **large destructible street-view window**!

### 11A-2. Kickable Breach Doors & Silent Stealth Opening (`src/entities/DestructibleManager.ts`, `src/player/PlayerController.ts`, `src/player/ViewModelRenderer.ts`, `src/engine/InputManager.ts`, `src/engine/AudioEngine.ts`)
Every doorway leading into/out of an enterable interior (`12–22` interactive doors per sector) is a real **`InteractiveDoor`** rendered via a single pooled `InstancedMesh` (`InteractiveDoors`, `cap: 32`, `+1` draw call — weathered painted steel door with handle, peephole/glass slit, and subtle frame lock LED!):
* **Input & Keybind (`InputManager.ts`, `HudManager.ts`)**:
  - Bind **`[F]`** (and **`[E]`** as secondary alias) to `INTERACT`.
  - When within `2.2 m` facing a closed door, show a crisp tiny contextual HUD prompt right below the reticle:
    - Standing/Running: `[F] BREACH KICK`
    - Crouching: `[F] OPEN QUIETLY`
* **3 Ways to Open / Breach a Door**:
  1. **Breach Kick (Standing/Running `[F]` OR Automatic on Slide / High-Speed Sprint Impact `speed >= 9.0 m/s` into Closed Door!)**:
     - Triggers a punchy **`0.22 s` First-Person Cyber-Boot Kick Animation** in `ViewModelRenderer.ts` (articulated armored tactical boot & lower shin swings decisively across the lower-center frame in Pass 2!) + forward camera lunge punch (`kickPitch -1.2°`, `kickZ +0.06 m`, `trauma +0.28`) + heavy metallic slam/latch-snap SE!
     - **Physics & Combat Payoff**: Immediately removes the door's blocking collider; the door panel detaches/blasts inward at `11 m/s` with tumbling spin (`DestructibleManager`), **knocks back & stuns (`1.5 s`, `40` dmg) any enemy standing within `2.4 m` behind the door**, emits a `22 m` acoustic alert impulse (`onPlayerGunshot(doorPos, 22)`), and after `2.2 s` on the floor **digitally disintegrates** into glowing cyan/amber scanline sparks!
  2. **Silent Stealth Open (Crouching `[F]`)**:
     - Smoothly swings the door `105°` open on its hinge over `0.38 s` (quiet oiled-hinge creak SE, **`0 m` enemy noise radius** — pure stealth infiltration!). Removes blocking collider immediately as it swings clear.
  3. **Ballistic Breach (Shooting Door Lock / Sniper Shot)**:
     - `1` K-90 Sniper shot (or `2` Pistol shots) hitting a closed door blasts it violently inward just like a Breach Kick (including behind-door enemy stun and digital disintegration!).

### 11A-3. Shootable & Crash-Through Destructible Glass (`src/entities/DestructibleManager.ts`, `src/entities/EffectsPool.ts`, `src/engine/AudioEngine.ts`)
Every enterable shopfront window, interior display case, and enterable apartment street window is a real **`DestructibleGlass`** pane rendered via a single pooled `InstancedMesh` (`DestructibleGlassPanes`, `cap: 48`, `+1` draw call, subtle rain-streaked reflective translucent tempered glass with dark steel perimeter bezel & thin mullions — transparent enough to clearly admire the real 3D furnished interior behind it!):
* **Break Triggers**:
  - `1` shot from Pistol or Sniper (bullet continues cleanly through after shattering — zero damage reduction so you can snipe an enemy right through a shop or apartment window!)
  - **High-speed player crash-through**: Sprinting (`>= 9.0 m/s`), sliding, jumping, or grapple-swinging directly into a glass pane shatters it automatically on contact with zero speed loss (pure action-movie window dive!).
* **Shatter VFX, Audio & Stealth**:
  - Instantly hides the pane instance (`scale -> 0`) and disables its collider (`O(1)` spatial grid removal).
  - Plays multi-layer Web Audio **tempered glass crash + crystalline shard tinkle SE** (`Highpass noise 4800Hz` + randomized high sine/triangle chimes `2800–6400Hz`).
  - Spawns **`22–30` glittering tumbling glass shards** (`DestructDebris` pool) blasting outward along bullet/player velocity, bouncing off wet asphalt/floors, then **digitally disintegrating** into cyan sparks after `1.6–2.4 s`!
  - Emits a `26 m` acoustic alert impulse to nearby enemies.

---

## PHASE 11B — Destructible Small Objects With Tumbling Debris & Digital Disintegration + Engine-Wide Lightweight Optimization Pass

### 11B-1. Shootable & Slide-Breakable Small Objects (`src/entities/DestructibleManager.ts`, `src/world/CityProps.ts`, `src/world/CityPropMeshes.ts`)
Turn small street, alley, corridor, and interior props into physically reactive destructible targets — with **zero geometry rebuilds and zero per-frame allocations**:
* **Destructible Prop Table** (registered automatically during `CityProps` & `InteriorBuilder` generation into an **`8 m` static 2D spatial hash grid**):
  | Prop Category | HP (Hits) | Impulse / Slide Break | Debris Color & Shape Profile | Acoustic Distraction Radius |
  | :--- | :---: | :--- | :--- | :---: |
  | Cardboard Box Piles (`BOXES`, `BOX_TOWER`, `BOX_PILE`) | `1` | Bullet or Slide | Flat damp-brown corrugated flaps (`10` pcs) | `10 m` |
  | Potted Plants & Planters (`POT_PLANT`, `PLANTER`, `PLANT_ON_BIN`, `SUCCULENTS`) | `1` | Bullet or Slide | Terracotta shards + dark-green leaf blades (`12` pcs) | `12 m` |
  | Storage Bins, Delivery Crates, Buckets (`BINS`, `CRATES`, `TOTE_BUCKET`) | `1` | Bullet or Slide | Tinted plastic shards matching prop `tint` (`10` pcs) | `12 m` |
  | Traffic Cones, Wooden Pallets, Eatery Stools, Umbrellas (`CONES`, `PALLETS`, `STOOLS`, `UMBRELLA`) | `1` | Bullet or Slide | Orange plastic / splintered wood / bent metal (`10` pcs) | `14 m` |
  | Street Trash Bins & Garbage Bags (`BIN_BAGS`, `BAG_MOUND`) | `2` (`1` Sniper) | Bullet or Slide | Bent metal + glossy black scrap chunks (`14` pcs) | `16 m` |
  | Industrial Oil Drums (`DRUMS`) | `2` (`1` Sniper) | Bullet | Rusted steel chunks + spark burst (`14` pcs) | `18 m` |
  | Glowing A-Frame Boards, Vending Glass Fronts & Interior Monitors/Bowls (`AFRAME`, interior props) | `1` | Bullet or Slide | Glass shards + cyan/amber electric sparks (`14` pcs) | `18 m` |
  * *(Heavy structural cover — `DUMPSTER`, `JERSEY`, `BENCH`, walls — remain solid reliable cover!)*
* **Zero-Allocation Instance Hiding**:
  - Each destructible prop stores `{ kitId, instanceIndex, hp, tint, aabb, pos }`.
  - On destruction: zero the prop's 16-float matrix scale (`_zeroMat`) at `instanceIndex` inside its existing `InstancedMesh` and set `instanceMatrix.needsUpdate = true` — **1 matrix write, 0 allocations, 0 buffer rebuilds!**
  - Also hide its corresponding `PropContactShadows` quad if it had one!
  - **Stealth Distraction Synergy**: Shooting a distant bottle, crate, or monitor with the suppressed Pistol creates a localized `12–18 m` sound stimulus at the **impact point**, luring patrolling `UNAWARE`/`ALERT` enemies away from their post to walk over and inspect the broken object!

### 11B-2. Tumbling Physics Debris + Signature Enemy-Style Digital Disintegration (`src/entities/EffectsPool.ts`)
* **Single Pooled `DestructDebris` `InstancedMesh` (`cap: 200`, `+1` draw call)**:
  - Pre-allocated ring buffer of `200` rigid-body debris chunks (mixed angular facet geometry scaled non-uniformly per piece: flat panels for cardboard/glass, chunky shards for ceramic/wood/metal).
  - **Physics**: Initial burst velocity along bullet/kick/slide direction + randomized cone spread (`3–11 m/s`), gravity (`-22 m/s²`), tumbling angular velocity, simple floor bounce at `y = floorY` (`restitution 0.35`, horizontal friction `0.62`, settles cleanly on the ground!).
  - **Signature Digital Disintegration Shader (Matching Enemy Core Dissolve!)**:
    - Per-instance attribute `aDissolve` (`x = dissolveProgress 0..1`, `y = isGlass 0|1`, `z = seed`, `w = glowBoost`).
    - First `1.4–2.2 s`: solid tumbling material-matched debris (tinted to exact broken object color; glittering specular translucent sheen if `isGlass > 0.5`).
    - Final `0.55 s` (`dissolveProgress: 0 -> 1`): bright **cyberpunk cyan/amber holographic scanline edge sweeps up the chunk**, pixels clip away in a crisp digital grid pattern (`discard` noise threshold), emitting `1–2` tiny rising digital sparks before vanishing cleanly at `dissolveProgress >= 1.0`!
  - **Material-Matched Procedural Impact SE (`AudioEngine.ts`)**: Distinct compact Web Audio impacts for cardboard thump, ceramic pot shatter, wooden splinter, plastic clatter, metallic drum clang, and electronic monitor spark pop!

### 11B-3. Engine-Wide Lightweight Optimization & Draw-Call Consolidation Pass (CRITICAL USER REQUIREMENT!)
Explicitly profile and lighten the entire engine so **Phase 11 runs FASTER and uses FEWER draw calls than Phase 10D**:
1. **Static 2D Spatial-Grid Broadphase in `PhysicsWorld.ts` (`cellSize = 12 m`)**:
   - Currently `PhysicsWorld` linearly scans all `300–600+` AABB colliders on every `movePlayer`, `raycast`, `lineOfSight`, and `findWallFaces` call (multiplied by 14 stealth enemies checking vision/LOS + bullets + 120Hz physics!).
   - Build a flat pre-allocated 2D uniform grid (`Int32Array` cell offsets + collider index list) once per `loadLevel()` (and update dynamically in `O(1)` when a door/glass collider toggles inactive!).
   - Use DDA grid traversal for `raycast` / `lineOfSight` and grid-cell AABB lookup for `movePlayer` / `findWallFaces` (with a `queryStamp` integer deduplication array — **zero allocations!**).
   - **Expected CPU Win**: Cuts `PhysicsWorld` raycast & LOS CPU time by **`70–85%`**, eliminating micro-stutters during heavy 14-enemy combat & stealth sweeps!
2. **Aggressive `InstancedMesh` Kit Consolidation (`-5` to `-6` Draw Calls!)**:
   - Consolidate compatible instanced batches using `aVariant` / per-instance attributes so total Sector 4 draw calls drop **below `104` (well under the `120` cap!)**:
     1. Merge `ClutterCardboard` + `ClutterTrashBins` → single `ClutterDebrisKit` (`-1` call).
     2. Merge `StreetLifeKit` (lanterns/umbrellas) + `StreetLandmarksKit` (ramen carts/bus shelters) → single `StreetFurnishingsKit` (`-1` call).
     3. Pack `BillboardMist` into `lampHalos` (using per-instance `aRadius` & `aColor`) (`-1` call).
     4. Merge `guardrails` + `fences` + `antennas` (all share `steelMat`!) into a single `SteelFixturesInstanced` kit via `aVariant` (`-2` calls).
     5. Merge `acUnits` + `ducts` (if compatible PBR) or keep tight bounding spheres (`-1` call optional).
3. **True Frustum Culling (`frustumCulled = true`) & Tight Bounding Spheres**:
   - Compute tight exact `boundingSphere` on all committed static meshes and non-global instanced meshes where safe (and keep `64 m` vertex-shader distance culling on all socket micro-props and interior small furnishings so distant buildings incur zero interior overdraw!).
4. **Adaptive Particle & Debris Cap Guard**:
   - Automatically skip spawning non-essential ambient sparks/rain-drips/minor debris beyond `52 m` from the camera, and enforce the `200`-piece ring-buffer ceiling on `DestructDebris` so rapid gunfire through a cluttered shop NEVER causes a frame drop.

---

## Draw-Call Budget Audit (Phase 11 Net Savings!)

| Category | Phase 10D Total | Phase 11A Delta | Phase 11B Delta | Final Phase 11 Sector 4 Total |
| :--- | :---: | :---: | :---: | :---: |
| Static City + Enterable Interiors | `11` | **`+0`** (merged!) | `+0` | `11` |
| Interactive Doors + Destructible Glass | `0` | `+2` (`Doors`, `Glass`) | `+0` | `2` |
| `DestructDebris` Digital Dissolve Pool | `0` | `+0` | `+1` | `1` |
| Instanced City Kit Consolidation (`11B-3`) | `~44` | `+0` | **`-5` to `-6`** | **`~38–39`** |
| Enemies (14), Effects, Rain, ViewModel, PostFX | `~50–58` | `+0` | `+0` | `~50–58` |
| **TOTAL DRAW CALLS / FRAME** | **`105–114`** | **`+2`** | **`-4` to `-5`** | **`102–111` (Net LOWER than 10D, strictly `<= 120`!)** |

---

## Verification Checklist (Required Before Reporting Done)

### Phase 11A Verification
1. `npm run build` and `npm test` pass (add unit tests verifying: carved enterable rooms have ZERO blocking solid building collider inside the room volume; every enterable room connects cleanly to its street/corridor doorway; Breach Kick removes door collider, damages/stuns an enemy behind it, and triggers `22 m` alert; Crouched `[F]` opens quietly with `0 m` noise; Glass breaks on bullet OR high-speed slide/sprint and removes collider).
2. Visually inspect enterable Eatery, Tech Shop (seeing real interior through street glass!), Pass-Through Arcade, and `GALLERY_DANCHI` 2F–3F Apartment (including shooting out the street window and grappling out!).
3. Verify first-person boot-kick animation plays smoothly on Breach Kick without clipping the weapon viewmodel.

### Phase 11B Verification
1. `npm run build` and `npm test` pass (add unit tests verifying: `PhysicsWorld` 2D spatial-grid `raycast` & `lineOfSight` return **bit-identical** results to brute-force scan across all 5 sectors; breaking a destructible prop zeroes its instance matrix, spawns debris, removes its contact shadow, and emits stealth distraction sound at impact point).
2. Visually confirm shooting/sliding through cardboard boxes, potted plants, crates, cones, pallets, trash bins, oil drums, A-frames, and interior monitors blasts color-matched tumbling debris that bounces and **digitally disintegrates** with glowing scanline dissolve!
3. **Optimization Proof**: Measure and report before/after `PhysicsWorld` raycast speed, Sector 4 `renderer.info.render.calls` (confirming **net reduction vs 10D** and strictly `<= 120`), zero per-frame allocations, and locked 60fps in Sector 4!
