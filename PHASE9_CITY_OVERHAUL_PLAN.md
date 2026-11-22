# STRAND // PROTOCOL — Phase 9 Master Specification: Realistic Cyberpunk Architecture, 5 Ground-Floor Programs, Baked Vertex AO & Individualized Urban Micro-Detail (9A & 9B)

**Target Implementer**: Claude (TypeScript / Three.js / WebGL2 / Web Audio API)  
**Target Codebase**: `strand-protocol/` (on top of Phase 8A `86a1026`)  
**Scope Note**: **Phase 8B is intentionally skipped and fully absorbed into Phase 9A & 9B** so building architecture, exposed wall piping, manholes, dense neon, alley clutter, graffiti, and per-door socket props are built ONCE onto a unified, realistic architectural grid with zero wasted rework.  
**Master Spec Alignment**: `GAME_DESIGN_SPEC.md` v1.6

> [!IMPORTANT]
> **Hard Non-Negotiable Constraints (Zero Regression)**
> 1. **Draw-Call Cap**: `renderer.info.render.calls <= 120` in ALL 5 sectors (strictly verified in Sector 4 at maximum density).
> 2. **Zero Per-Frame Heap Allocations** in update/render loops; 100% procedural WebGL2 + Web Audio API (zero external `.glb`/`.png`/`.mp3` files).
> 3. **Gameplay Readability & Mobility First**:
>    - Every building MUST retain `>= 2` clean vertical `runFaces` (plus narrow-alley facing walls) for uninterrupted parallel wall-running.
>    - Decorative 3D facade trim (`<= 0.35 m` relief), wall pipes, and small socket/alley clutter MUST NOT add snagging colliders.
>    - Every narrow alley MUST maintain a `>= 2.6 m` unobstructed center walkable lane; every 1F doorway MUST maintain a `1.8 m × 1.8 m` clear entry zone.
>    - Keep facade/storefront/prop albedo dark & rain-weathered (`0.06–0.28` linear) and frosted interior shop glow below Bloom (`<= 0.72` linear) so enemy visors (`UNAWARE/ALERT/DETECTED/COMBAT`), telegraphs, and gold anchors remain 100% readable at 100 m.
> 4. **Clean Modularity**: `CityBuilder.ts` is already ~4,800 lines — extract cleanly typed helper modules under `src/world/` (recommended: `src/world/BuildingGrammar.ts` for massing/programs/vertex-AO/galleries/pipes and `src/world/CityProps.ts` for socket props, alley clutter, graffiti decals, and manholes) instead of bloating a single file.
> 5. **Split Execution Order**: Complete, build, and test **Phase 9A** first; then implement and verify **Phase 9B**.

---

## Core Design Philosophy: Eliminating "Fake / Unnatural / Copy-Pasted" Buildings

Current buildings feel artificial for five exact geometric and shading reasons that Phase 9 fixes at the root:
1. **Sliced Floors & Missing Parapets**: Roof heights were quantized to arbitrary `0.5 m` increments (slicing windows in half) and lacked real rooftop parapet walls (`0.08 m` steel rim instead of `1.05 m` solid walls).
2. **Uniform Rectangular Boxes**: Nearly every building was a single extruded rectangle. Phase 9 introduces **5 distinct multi-box architectural massings** (including L-shaped courtyards, offset podium+towers, stepped setbacks, exterior-corridor cyberpunk apartments, and narrow pencil infill towers).
3. **Flat Texture-Only Ground Floors**: Only Type D had 3D ground bays; Types A/B/C were flat textured cubes with no human-scale (`1.05 m × 2.15 m`) recessed doors, piers, canopies, or urban function. Phase 9 introduces **5 cohesive Cyberpunk Ground-Floor Programs** sharing one unified `4.0 m` structural bay grammar so NO single building looks "more detailed" or stylistically mismatched next to another.
4. **Zero Crevice / Contact Occlusion (Floating Look)**: `steelMat`, `concreteMat`, and trim geometry had uniform unoccluded brightness where pillars met wet asphalt, under canopies, and inside doorway recesses. Phase 9 introduces **zero-cost per-vertex Baked Ambient Occlusion (`aAo`)** + weathered painted-metal/stained-concrete detail texturing across ALL architectural geometry.
5. **Cloned Doorways & Sterile Streets**: Every doorway, balcony, and alley looked identical and clean. Phase 9B attaches deterministic **Prop Sockets** to every apartment doorway, storefront bay, and balcony so **every single door/bay gets its own individualized micro-props** (potted plants, storage boxes, wire racks, room-number plaques, breaker boxes, delivery crates, stools, flyers) alongside dense gritty alley clutter, wall graffiti, exposed wall pipes, and steaming glowing manholes.

---

## PHASE 9A — Realistic Architectural Grammar, 5 Massings, 5 Cyberpunk Ground-Floor Programs, Baked Vertex AO & Urban Infrastructure

### 9A-1. Strict Floor-Grid Quantization & Rooftop Parapets (`src/world/CityBuilder.ts`, `src/world/BuildingGrammar.ts`)
* **Exact Floor-Grid Snapping (Zero Sliced Windows)**:
  - Keep `FACADE.FLOOR_H_M = 4.0` (matching `FacadeLighting.ts`, `ProceduralTextures.ts`, `FIRE_ESCAPE.LEVEL_H_M = 4`, and existing facade room census!).
  - Quantize **every building's `roofY` and `setbackY`** strictly to exact whole-floor heights:
    ```ts
    // Floor top elevation for archetype `arch` with integer floor count `floors`:
    // roofY = FACADE.FLOOR_BASE_M[arch] + floors * FACADE.FLOOR_H_M
    ```
  - Clamp `floors` so `roofY` stays inside `[Math.max(ARCHETYPE.MIN_H[arch], sector.heightMin), Math.min(ARCHETYPE.MAX_H[arch], sector.heightMax)]`.
  - Align ALL 3D upper-floor slab bands, balconies, exterior apartment walkways, fire-escape landings, and horizontal conduits to exact `y = FACADE.FLOOR_BASE_M[arch] + n * 4.0` elevations.
* **Real Rooftop Parapet Walls & Access Bulkheads (ALL Buildings & Setback Terraces)**:
  - Replace the old `0.08 m` rim with a real perimeter **parapet wall**: height **`1.05 m`**, thickness **`0.32 m`**, concrete body (`G.concrete`, darkened inner/base `aAo`), topped with a dark overhanging sheet-metal **coping cap** (`height 0.09 m`, `width 0.38 m` in `G.steel`).
  - **Fire-Escape Landing Gap Rule (CRITICAL)**: Where an exterior fire escape reaches the roof edge, leave a **`2.4 m` wide gap** in the parapet wall so the player steps smoothly onto the roof without collision snagging!
  - **Collider**: Add thin parapet AABBs (`height 1.05 m`, `thickness 0.32 m`, easily jumped over or auto-mantled, providing realistic low rooftop cover against Veil Snipers!).
  - **Rooftop Access Stairwell Bulkhead**: On buildings with roof footprint `>= 10 m × 10 m`, add a recessed metal rooftop access door (`1.0 m × 2.1 m`, in `G.archPaint`) on the side of the existing machine room / penthouse with a tiny caged bulkhead amber/cyan door light (`G.strips`).

### 9A-2. 5 Diverse Building Massings (Ending Rectangular Clones)
Extend `Building` (while preserving all existing `BuildingInfo` fields `index, cx, cz, halfW, halfD, roofY, arch` for backwards compatibility with `EnemyManager` and `facadeProbe`):

```ts
export type MassingKind =
  | 'L_SHAPE'         // L-footprint with recessed street/alley corner courtyard
  | 'PODIUM_OFFSET'   // Full-lot 2-floor (8 m) podium + asymmetrically offset upper tower
  | 'STEPPED_SETBACK' // Multi-tier tapered megatower (lower + mid + upper crown)
  | 'GALLERY_DANCHI'  // Cyberpunk exterior-corridor apartment block (walkable 2F–4F galleries)
  | 'PENCIL_TOWER';   // Slim vertical infill tower with external service shaft spine
```

* **Deterministic Assignment Rules** (per sector, using `arng` so streets/cars/lamps stay deterministic):
  1. **`STEPPED_SETBACK`** (Type A tall towers `>= 44 m`, ~65% of Type A): 2-tier or 3-tier stepped crown (lower block `0 -> setbackY1`, mid tier `setbackY1 -> setbackY2`, optional slim crown), structural corner fins, rooftop neon crown frame.
  2. **`PODIUM_OFFSET`** (Type A remainder & Type D commercial on lots `>= 14 m × 14 m`): Full-lot `8.0 m` (2-floor) ground podium with parapet terrace + asymmetrically **offset** upper tower (`60–72%` width/depth pushed cleanly flush to one corner/edge of the lot, leaving a playable L-shaped 2F terrace with AC units, parapet, and gold grapple anchor!).
  3. **`L_SHAPE`** (Type B & Type C on lots where BOTH `lotW >= 18 m` and `lotD >= 18 m`, ~45% of eligible lots): Carve out one non-alley street-corner quadrant (`38–44%` of width × `38–44%` of depth, leaving both wings `>= 10 m` wide!) into a **recessed ground-level courtyard/alcove** (`min 7 m × 7 m`), represented cleanly as **2 exact AABB sub-rects (`wingA`, `wingB`)**!
     - **CRITICAL Safety Rule for `L_SHAPE`**:
       - Register **both** sub-rect AABBs in `colliders` (so players can walk, crouch, and hide inside the carved courtyard!).
       - Keep `b.cx, b.cz, b.halfW, b.halfD` anchored to the larger `wingA` so all existing rooftop spawns (`roofSpawns`, `perchSpawns`), machine rooms, AC units, and fences sit 100% on solid roof — NEVER floating over the L-cutout!
  4. **`GALLERY_DANCHI`** (Type B residential towers on non-L lots, or `>= 2` guaranteed per sector):
     - **Signature Cyberpunk Apartment Architecture (Directly Inspired by Gritty East-Asian / Kowloon Concrete Walkways)**:
     - On 1 (or 2 non-alley) street-facing sides, floors **2F, 3F, and 4F** (`y = 4, 8, 12 m` or `6, 10, 14 m` matching `FACADE.FLOOR_BASE_M[ARCH_B]`) feature **continuous walkable `1.45 m`-deep cantilevered exterior open corridors** running the length of the facade (minus `0.8 m` end piers)!
     - Each exterior corridor has:
       - Concrete deck slab (`0.22 m` thick, walkable AABB collider, darkened underside `aAo = 0.45`) with subtle recessed floor drain channel strip along the outer railing edge.
       - Outer steel balustrade railing (`1.08 m` tall, top/bottom horizontal rails + vertical picket posts every `0.42 m`, `0.10 m` collider) + vertical structural columns at `4.0 m` intervals.
       - **Overhead Corridor Infrastructure** (merged into `G.steel` & `G.strips`, `+0` draw calls): longitudinal galvanized steel **ceiling cable tray ladder** (`width 0.45 m` running along the outer soffit), 2 parallel horizontal white/grey **conduit pipes** crossing overhead (`diameter 0.06 m`), and caged **linear fluorescent ceiling tubes** every `4.0 m` (soft warm/cool light glow `0.85` + subtle bounce).
       - **Individual 3D Recessed Apartment Doorways every `4.0 m` along the corridor** (merged into `G.archPaint`, `G.concrete`, `G.steel`):
         - Protruding beveled concrete/plaster door frame surround (`1.30 m` wide × `2.30 m` tall × `0.18 m` relief, stained concrete `aAo` dark at inner jambs).
         - Recessed weathered painted-steel fire door (`1.02 m × 2.15 m`, per-building muted cyberpunk palette: weathered olive-green `#2E3E35`, dark industrial slate `#272E38`, faded rust-ochre `#432D26`, or muted charcoal `#23272D`), split upper/lower panel seam, stainless push-bar/kickplate, peephole nub, and beside each door a **barred metal corridor window frame** (`1.15 m × 1.15 m` vertical grille bars over dark frosted glass).
         - **Socket Emission**: Every single apartment doorway emits **4 deterministic `PropSocket`s** (`FLOOR_L`, `FLOOR_R`, `WALL_SIDE`, `WALL_HIGH`) so Phase 9B populates each door with individualized room-number plaques, keypads, breaker boxes, potted plants, storage boxes, and wire racks!
       - Connect the 1F entrance to 2F via an external steel stair flight (or leave grapple/parkour climbable ledges + fire-escape style end-stair) so the player can both grapple AND run up into the apartment corridors!
  5. **`PENCIL_TOWER`** (Remaining narrower lots `<= 15 m` on either axis, Types C & D):
     - Full-lot vertical shaft with a distinct protruding **external service/elevator shaft spine** (`2.8 m × 0.85 m` relief on one non-run face) with vertical recessed cable chase, floor-marker vents, and dense stacked vertical neon blades.

### 9A-3. 3D Upper-Floor Structural Relief (Zero Flat Wallpaper Walls)
Across ALL building archetypes (keeping protrusions `<= 0.28 m` on `runFaces` with NO extra colliders so wall-running remains silky smooth!):
* **Horizontal Floor-Slab Spandrel Ledges**: Every `4.0 m` floor line (`y = base + n * 4.0`, up to `min(lowTop, 36 m)` where visible from street/mid-air) receives a crisp protruding concrete/metal slab drip-band (`height 0.24 m`, protrusion `0.16 m` on run faces / `0.26 m` on feature faces, underside vertex `aAo = 0.48`).
* **Vertical Structural Pier / Mullion Alignment**: Align vertical mullions (Type A, every `3.0 m`), concrete structural piers (Type B & D, every `4.0 m`), and steel H-beam ribs (Type C, every `6.0 m`) strictly to the `FACADE.ROOMS_PER_TILE` grid so columns NEVER cross through the middle of a window!

### 9A-4. 5 Cohesive Cyberpunk Ground-Floor Programs (100% Unified Density & Scale)
Every building's street-facing 1F (height `Y = 0.0 -> 4.0 m`, or `6.0 m` podium on Type B with `4.0 m` storefront bay + `2.0 m` mezzanine fascia) is assigned one of **5 Cyberpunk Programs** based on archetype + deterministic seed (guaranteeing **every sector mixes all 5 programs** cleanly across its avenues and side streets!):

```ts
export type GroundProgram =
  | 'CYBER_EATERY'    // Steaming noodle bar / midnight izakaya / street food counter
  | 'TECH_APPAREL'    // Cyberpunk apparel / cyberware & gear boutique
  | 'CAPSULE_HOTEL'   // Neon / capsule hotel entrance portico
  | 'CYBER_APARTMENT' // Danchi / residential block lobby + mailboxes + intercom
  | 'ALLEY_INFRA';    // Heavy roll-shutter substation / utility / loading bay
```

* **Universal Shared Architectural Grammar (Guarantees Zero Visual Mismatch Across All 5 Programs)**:
  - **Bay Module**: Split every street-facing 1F wall into clean `4.0 m` bays framed by protruding weathered concrete/stone piers (`width 0.48 m`, depth `0.36 m`, height `4.0 m`, dark steel kickplate `0.30 m` tall at base with `aAo = 0.42`).
  - **Recessed Human-Scale Doors**: Every program uses genuine human-scale doorways (`width 1.05–1.80 m`, `height 2.15–2.25 m`) recessed `0.32–0.80 m` inside beveled surrounds (NO giant 4m tall stretched cartoon doors, NO see-through hollow 1F glass voids!).
  - **Clear Entry Zone Registration**: Every doorway records a `doorClearZones` rect (`1.8 m` wide × `1.8 m` out from facade) that Phase 9B clutter/dumpsters/lamps strictly respect.
  - **Program-Specific 3D Details (All Merged into `G.concrete`, `G.steel`, `G.archPaint`, `G.strips` — Zero Extra Draw Calls per Building!)**:
    1. **`CYBER_EATERY`** (Type D & Type B street corners, ~22% of street faces):
       - Recessed dark weathered timber-composite / slate paneling (`0.38 m` reveal) + warm amber **frosted/ribbed opaque glass panels** (`emissive ~0.48` warm `#FF9B42`, never hollow transparent glass, faint horizontal slat ribs in front).
       - Projecting slanted corrugated metal/vinyl **shop awning** (`Y = 3.15 m`, depth `1.35 m`, dark weathered burgundy/teal/charcoal paint, underside warm downlight strip + vertex `aAo = 0.44` under soffit).
       - **Heavy Stainless Exhaust Hood & Grease Fume Vent**: External boxy sheet-metal exhaust duct (`0.55 m × 0.45 m`) exiting above the awning and climbing vertically to `Y = 12–20 m` with flanged clamps; registers a warm steam vent point for the steam system!
       - Sliding steel/frosted service door (`1.15 m × 2.15 m`) + exterior wall-mounted narrow metal counter shelf (`1.8 m × 0.35 m` at `Y = 1.05 m`) + glowing horizontal menu fascia box (`Y = 3.35–3.85 m`).
       - Emits `EATERY` sockets (`FLOOR_L`, `FLOOR_R`, `WALL_SIDE`).
    2. **`TECH_APPAREL`** (Type D & Type A retail podiums, ~22% of street faces):
       - Matte-black anodized aluminum shopfront frame (`0.42 m` reveal) with **half-lowered ribbed security roll shutter** (upper `38%` of bay) over sleek **opaque backlit display vitrines** (cool cyan `#38D8F0` or electric magenta `#E048B8` diffused vertical light panels at controlled luminance `0.42–0.58`, overlaid with dark silhouette display dividers — crisp cyber boutique feel with ZERO hollow-room artifacts!).
       - Sharp angular cantilevered metallic canopy (`Y = 3.35 m`, depth `1.45 m`) with razor-thin neon edge bar + vertical protruding neon brand sign above.
       - Reinforced brushed-steel double shop door (`1.45 m × 2.18 m`) with recessed pull handles and glowing biometric keypad.
       - Emits `TECH` sockets (`FLOOR_L`, `FLOOR_R`, `WALL_SIDE`).
    3. **`CAPSULE_HOTEL`** (Type A & Type B avenues, ~16% of street faces):
       - Symmetrical deep **recessed entry portico** (`0.80 m` deep alcove framed by dark fluted concrete piers and glowing vertical trim slits).
       - Wide cantilevered steel-and-ribbed-glass marquee canopy (`width 6.0–8.0 m`, depth `1.9 m`, `Y = 3.55 m`) with warm-amber & crimson edge neon strips and underside downlight bars (`aAo = 0.42` soffit).
       - Brushed steel double lobby doors (`1.80 m × 2.25 m`) + glowing horizontal room-status LED ticker fascia + **tall protruding vertical marquee neon sign** climbing `8–16 m` above the canopy!
       - Emits `HOTEL` sockets (`FLOOR_L`, `FLOOR_R`, `WALL_SIDE`).
    4. **`CYBER_APARTMENT`** (Type B & `GALLERY_DANCHI` 1F lobbies, ~22% of street faces):
       - Recessed concrete foyer entrance (`0.68 m` deep) with concrete eyebrow canopy (`Y = 2.85 m`, depth `1.15 m`, caged fluorescent tube underneath).
       - Heavy painted-steel fire lobby door (`1.12 m × 2.15 m`, weathered olive/slate/charcoal) with recessed **brushed-steel apartment mailbox bank** (`1.2 m × 0.85 m` gridded front beside the door), glowing blue/white intercom keypad, and wall-mounted steel utility meter cabinet.
       - Adjacent 1F ground-floor bays use opaque louvered utility grilles / closed steel storage doors (no weird glass living rooms on the sidewalk!).
       - Emits `APARTMENT` sockets (`FLOOR_L`, `FLOOR_R`, `WALL_SIDE`, `WALL_HIGH`).
    5. **`ALLEY_INFRA`** (Type C industrial & all back-alley 1F faces, ~18% of street faces + 100% of alley backs):
       - Heavy recessed corrugated steel **roll-up shutters** (`0.32 m` reveal, weathered gunmetal/dark-olive/rust), concrete curb bumper, yellow/black hazard bollard posts, wall-mounted **high-voltage transformer/substation box** with heat-sink fins and tiny glowing red/amber status LED, and heavy steel service door (`1.0 m × 2.1 m`) with overhead caged industrial light.
       - Emits `INFRA` sockets (`FLOOR_L`, `FLOOR_R`, `WALL_SIDE`, `WALL_HIGH`).

### 9A-5. Zero-Cost Baked Vertex Ambient Occlusion (`aAo`) & Weathered Paint Material (`src/engine/ProceduralTextures.ts`, `src/world/CityBuilder.ts`, `src/world/BuildingGrammar.ts`)
* **New Procedural Weathered Paint / Stained Architectural Detail Texture (`tex.archDetail`, `512 × 512`)**:
  - Generated once at startup in `ProceduralTextures.ts`: subtle vertical rain streaks, fine paint scuff scratches (like weathered painted steel doors), concrete stain mottling, and edge wear — producing `map` (neutral greyscale variation `0.78–1.05` multiplied by vertex color!), `roughnessMap` (`0.28–0.78` wet/scuffed variation), and `normalMap` (fine brushed/pitted relief).
* **1 New Merged Material (`this.archPaintMat`, `+1` draw call for `ArchFacadesTrim`)**:
  - `MeshStandardMaterial` with `vertexColors: true` (per-vertex RGB tint for olive doors, rusted trim, dark concrete frames, painted awnings, brushed mailboxes, warm frosted panels), `map/roughnessMap/normalMap = tex.archDetail`, `injectCityLights(shader)` for dynamic street/neon bounce, AND **`aAo` float vertex attribute**!
* **Inject `aAo` Multiplier into `this.concreteMat`, `this.steelMat`, `this.archPaintMat`, AND `this.buildingMat` (Ground Contact)**:
  - Vertex attribute `attribute float aAo;` (`default 1.0`) → `varying float vAo;` → in `#include <map_fragment>` or `#include <dithering_fragment>` / `outgoingLight`:
    - Multiply diffuse albedo AND indirect env/bounce lighting by `mix(0.32, 1.0, vAo)` (keeping direct emissives unattenuated!).
  - **Automatic Vertex-AO Helper (`aoBox`, `aoQuad` in `BuildingGrammar.ts`)**:
    - Every vertex automatically computes deterministic AO from simple geometric flags passed at build time (`aoBottom`, `aoTop`, `aoBack`, `aoFront`, `aoGroundContact`):
      - Vertices near `Y = 0.0 -> 0.55 m`: automatically multiply `aAo *= smoothstep(0.0, 0.55, y) * 0.58 + 0.42` (instant heavy grounded contact shadow along EVERY wall, pier, curb, and doorway!).
      - Undersides of canopies, awnings, slab ledges, balconies, and gallery ceilings: `aAo = 0.44`.
      - Back faces / inner corners of recessed doorways, shutters, and window reveals: `aAo = 0.38–0.52`.
      - Pipe/duct wall-facing sides: `aAo = 0.48`.

### 9A-6. Integrated Infrastructure (Absorbed from Skipped Phase 8B)
1. **Heavy Building-Side Exposed Piping & Conduits (`+0` extra draw calls — merged into `G.steel`)**:
   - On ALL building flanks (especially narrow-alley walls and `ALLEY_INFRA`/`CYBER_EATERY` sides):
     - **2- or 3-pipe parallel vertical riser bundles** (`radius 0.07–0.14 m`, low-poly 6-sided cylinders) running from `Y = 0.3 m` up to `12–28 m`, with horizontal steel **collar clamp brackets** every `3.5 m` and **90° elbow bends** turning into the facade.
     - Horizontal **utility conduit runs** at `Y = 3.85–4.4 m` (just above 1F awnings/fascias) + steel **wall junction boxes** with tiny amber/red/cyan status LED dots (`G.strips`).
     - Increase sagged cross-alley overhead utility cables (`Y = 5.5–16 m`) with bracket anchors so narrow alleys frame rich layered overhead cables + neon.
2. **Glowing Cast-Iron Street & Alley Manholes + Re-Anchored Steam Plumes (`+1` draw call)**:
   - Procedural **`tex.manhole` (`256 × 256`)** in `ProceduralTextures.ts`: cast-iron frame + recessed dark vent bars + emissive subterranean grate glow mask (subtle warm amber `#FF7828` or toxic cyan `#1CE8FF`).
   - `InstancedMesh` `manholes` (`cap: 55`, flush at `Y = 0.016 m`, subtle `polygonOffset`) placed along street curbs, intersections, and narrow alley centers (avoiding cars & crosswalks).
   - **Re-Anchor `this.steam`**: Spawn focused rising vertical steam columns (`2.5–6.0 m` tall, softly backlit by street/neon light) **directly above physical manhole coordinates and `CYBER_EATERY` exhaust vent positions** (plus low canal mist), replacing random floating unanchored street steam!
3. **High-Density Layered Neon Signage (`CAP.NEON: 420 -> 960`, `+0` extra draw calls)**:
   - Double+ neon capacity on the existing `this.neonSigns` `InstancedMesh`.
   - Saturate narrow alleys and 1F–5F street facades (`Y = 3.6–24 m`) with staggered protruding vertical blade signs (`1.2–2.8 m` reach), cross-alley hanging horizontal neon bars (`Y = 6.5–14 m`), Hotel vertical marquees, and ~12% subtly flickering/half-dead neon tubes (animated in shader via per-instance seed phase) for authentic cyberpunk grime!
4. **Wet-Road Gutter Grime & Subtle Oil-Slick Iridescence (`+0` extra draw calls)**:
   - Enhance `createRoadMaterial()` fragment shader with low-frequency world-space **gutter/alley dark grime patches** (darkening albedo `0.72–1.0` near building walls/manholes) and a subtle view-angle **thin-film rainbow oil-slick specular tint** (`0.08–0.13` intensity only inside ultra-glossy puddle regions `roughnessFactor < 0.16`) — dirty and photorealistic, never garish!

---

## PHASE 9B — Individualized Per-Door/Bay Socket Micro-Props, Gritty Alley Clutter & Wall Graffiti

**Goal**: Bring every apartment corridor, storefront bay, balcony, and narrow alley alive with **non-repeating human/cyberpunk clutter** (matching the lived-in micro-storytelling of the Blender reference) while strictly holding `renderer.info.render.calls <= 120` and `60 fps`.

### 9B-1. Deterministic Per-Door / Per-Bay Socket Micro-Prop System (`src/world/CityProps.ts`)
Every 1F bay (`CYBER_EATERY`, `TECH_APPAREL`, `CAPSULE_HOTEL`, `CYBER_APARTMENT`, `ALLEY_INFRA`), every `GALLERY_DANCHI` exterior apartment doorway (2F–4F), and every Type B balcony emitted `PropSocket` records during Phase 9A.

* **Individualization Rule (ZERO Cloned Doorways!)**:
  - For each doorway/bay, seed a local RNG from `socket.seed` (hash of building index, floor, bay index):
    - ~`15%` of doors stay intentionally **minimal/tidy** (only room-number plaque + keypad/intercom — contrast makes cluttered doors feel real!).
    - ~`85%` receive **1–3 distinct props** across their `FLOOR_L`, `FLOOR_R`, `WALL_SIDE`, and `WALL_HIGH` sockets with deterministic micro-jitter (`±0.06 m` lateral, `±12°` yaw, `0.88–1.12x` scale) so **two adjacent doors (`3-0805` vs `3-0806`) NEVER look alike**!
    - Example `GALLERY_DANCHI` corridor variety:
      - Door A (`3-0805`): Ceramic potted plant on plastic storage bin (`FLOOR_L`) + narrow 3-tier metal wire shelf loaded with cream/orange storage boxes (`FLOOR_R`) + wall breaker box & room plaque (`WALL_SIDE/HIGH`).
      - Door B (`3-0806`): Stacked folded cardboard boxes (`FLOOR_L`) + blue utility bucket & umbrella (`FLOOR_R`) + intercom keypad & room plaque.
      - Door C (`3-0807`): Clean doorway with wall meter cabinet + single small potted plant on the railing side.
      - Door D (`3-0808`): Stacked milk/plastic crates + wire shelf rack with canisters + glowing room plaque.
* **4 Tightly Packed `InstancedMesh` Micro-Prop Kits (`+4` draw calls total!)** using `aPart` material shading + `aVariant` vertex-shader variant selector (`0..3`, collapsing inactive variants to `vec3(0.0)`) + **vertex-shader distance cull (`uCullDist = 64.0 m`)** for zero long-range overdraw:
  1. **`SocketPottedPlants`** (`cap: 260`, `+1` call):
     - Variant 0: Terracotta/beige cylindrical pot + clustered dark-green broad leaf blades (sits cleanly on floor or storage bin).
     - Variant 1: Low rectangular concrete/metal planter box with twin dark-green cyber-fern tufts (for Hotel/Tech entrances & corridor railings).
     - Vertex `aAo` darkens pot base and inner foliage core; per-instance tint varies pot color (terracotta, off-white ceramic, matte slate) & subtle leaf shade.
  2. **`SocketStorageCrates`** (`cap: 360`, `+1` call):
     - Variant 0: **Narrow 3-Tier Open Metal Wire Rack** (`0.72 m × 1.45 m × 0.34 m`) holding staggered cream/orange/slate lidded storage bins & small canisters (signature corridor silhouette!).
     - Variant 1: **Stacked Lidded Plastic Storage Bins** (`2` slightly rotated bins, `0.48 m × 0.62 m`, off-white / safety-orange / dark-blue).
     - Variant 2: **Stacked Slotted Delivery Plastic Crates** (for `CYBER_EATERY` & `INFRA` bays, amber/teal/charcoal).
     - Variant 3: **Wall-Leaning Shipping Tote + Small Utility Bucket**.
  3. **`SocketWallFixtures`** (`cap: 420`, `+1` call):
     - Variant 0: **Illuminated Room-Number Plaque** (`0.30 m × 0.14 m`, dark anodized housing + glowing crisp digits from a procedural **`4 × 4` Canvas Atlas** displaying 16 realistic cyber apartment/suite numbers like `2-0401`, `3-0805`, `3-0806`, `4-1102`, `B-209`, etc.!).
     - Variant 1: **Wall Electrical Breaker / Meter Cabinet** (`0.42 m × 0.56 m × 0.18 m`, weathered grey/beige steel box with hinge latch, top conduit pipe stub, and tiny glowing green/amber status LED).
     - Variant 2: **Backlit Biometric Keypad / Intercom Panel** (`0.14 m × 0.28 m × 0.05 m`, dark casing + glowing cyan/blue keypad matrix grid).
     - Variant 3: **Caged Industrial Wall Bulkhead Light / Small Extinguisher Box** (muted crimson fire-box or amber wall sconce).
  4. **`SocketMiscProps`** (`cap: 220`, `+1` call):
     - Variant 0: **Eatery Folding Metal Stool Pair** (tucked under exterior counter shelves).
     - Variant 1: **Sidewalk Glowing A-Frame Street Menu / Promo Board** (for Eatery & Tech shops, angled wedge with soft backlit panel).
     - Variant 2: **Industrial Metal Oil Canister / Gas Bottle Cluster** (for Eatery backs & Infra bays).
     - Variant 3: **Umbrella Stand / Small Trash Basket** (for Apartment foyers & Hotels).

### 9B-2. Gritty Alley & Sidewalk Micro-Clutter Clusters (`src/world/CityProps.ts`, Absorbed from Phase 8B)
Placed in organic **clusters** along narrow alley walls, building recesses, `L_SHAPE` courtyards, elevated highway underpass piers, beside vending machines, and along sidewalk curbs — **strictly checking**:
- Not inside any `doorClearZones` (`1.8 m × 1.8 m` around every door)
- Not inside any `intersectionSquares`, `crosswalkZones`, `rampRects`, or parked car slots
- Preserves a **`>= 2.6 m` clear walkable center corridor** down every narrow alley!
- Zero collision snags on small debris (only heavy dumpsters and concrete jersey barriers add clean low crouch-cover AABBs!).

Implemented as **5 compact `InstancedMesh` batches (`+5` draw calls)**:
1. **`ClutterCardboard`** (`cap: 280`, `+1` call): 3 variants (via `aVariant`) of slightly tilted, damp-bottom stacked corrugated cardboard box clusters (`#5A4634`–`#3A2D21`, taped seam creases, darkened wet bottom `aAo = 0.42`, zero collider).
2. **`ClutterTrashBins`** (`cap: 200`, `+1` call): 2 variants — cylindrical vented metal street trash bin with overflowing glossy black garbage bags slumped beside its base, and standalone clustered wet garbage bag mounds (`roughness 0.18` glossy wet plastic bags catching neon reflections!, zero collider).
3. **`ClutterDumpsters`** (`cap: 65`, `+1` call): Heavy industrial steel **angled-lid dumpsters** (`1.80 m × 1.15 m × 1.10 m`, weathered dark-green `#1E3328`, rust-brown `#492A1F`, dark charcoal `#222730` with side lifting pockets & lid seams, darkened ground `aAo`). **Registers clean crouch-cover AABB collider (`1.80 × 1.15 × 1.10 m`)** — perfect stealth cover at `0.78 m` crouch eye height!
4. **`ClutterBenches`** (`cap: 110`, `+1` call): Slatted weathered-wood & dark cast-iron **street benches** (`1.85 m × 0.82 m × 0.62 m`) along sidewalks, canal promenades, plazas, and `L_SHAPE` courtyards (low seat AABB `0.48 m` high or non-snagging step-over).
5. **`ClutterScrapBarriers`** (`cap: 200`, `+1` call): 4 variants via `aVariant`:
   - Variant 0: Stacked weathered wooden pallets + scrap metal pipes
   - Variant 1: Dented rusted industrial oil drums (pair, dark rust/teal/hazard-yellow bands)
   - Variant 2: Concrete **jersey barrier** (`1.8 m × 0.85 m × 0.52 m`, faded yellow/black caution stripe, registers low crouch-cover AABB!)
   - Variant 3: Reflective safety-orange **traffic cones** (pair, near highway piers & alley mouths, zero collider)

### 9B-3. Wall Graffiti & Torn Street Posters (`src/engine/ProceduralTextures.ts`, `src/world/CityProps.ts`, `+1` draw call)
* **Procedural `4 × 2` Canvas Atlas (`1024 × 512`, 8 alpha-masked designs)**:
  - Cells `0–3`: **Cyberpunk Spray Graffiti Tags & Stencils** — multi-layered neon-cyan, hot-magenta, acid-lime, and coral-orange spray paint strokes with paint drips, stylized cyber glyphs/katakana (`STRAND`, `NO SIGNAL`, `ZERO`, `09`, glitch skull stencil).
  - Cells `4–7`: **Weathered Torn Posters & Industrial Stencils** — rain-stained corporate/cyber flyer collages with ripped diagonal corners & moisture grime, faded yellow/black caution stencils (`RESTRICTED`, `HIGH VOLTAGE`, `SECTOR 04`), and dripping rust marks.
* **Single `InstancedMesh` Decal Batch (`cap: 340`, `+1` draw call)**:
  - Per-instance `aCell` (`vec2` atlas offset) + `aTint` + `aFade` (distance fade at `95 m`), `transparent: true`, `depthWrite: false`, `polygonOffset: true`, `polygonOffsetFactor: -2`, placed flush at `+0.032 m` outward normal.
  - Placed densely on **1F roll shutters, `ALLEY_INFRA` concrete walls, narrow alley lower facades (`Y = 0.6–3.8 m`), elevated highway support piers, and dumpster flanks** — strictly skipping doorway openings and hotel marble/portico centers so placement always looks authentically motivated!

---

## Strict Draw-Call Budget Audit (`<= 120 calls / frame`)

| Category | Phase 8A Baseline | Phase 9A Delta | Phase 9B Delta | Projected Sector 4 Total |
| :--- | :---: | :---: | :---: | :---: |
| Static Merged City Meshes | `10` | `+1` (`ArchFacadesTrim`) | `+0` | `11` |
| Persistent City `InstancedMesh` + Sky/Gate | `28` | `+1` (`Manholes`) | `+10` (`4` Socket + `5` Clutter + `1` Graffiti) | `39` |
| Enemies (max 14), Effects, Rain, ViewModel, Bloom/PostFX | `~46–56` | `+0` | `+0` | `~46–56` |
| **TOTAL DRAW CALLS / FRAME** | **`84–94`** | **`+2`** | **`+10`** | **`96–106` (Hard Cap: `<= 120`)** |

* **Margin**: `14–24` draw calls of guaranteed headroom below the `120` hard cap!
* **If Sector 4 ever approaches `115+`**: Merge `ClutterCardboard` + `ClutterTrashBins` via `aVariant` (`-1` call) or merge `SocketPottedPlants` + `SocketMiscProps` via `aVariant` (`-1` call) before shipping.

---

## Verification Checklist (Required Before Reporting Done)

### Phase 9A Verification
1. `npm run build` succeeds with zero TypeScript errors; all existing + new unit tests pass (`npm test`).
2. **Zero Sliced Windows & Real Parapets**: Inspect/assert every building's `roofY` and `setbackY` satisfies `(y - FACADE.FLOOR_BASE_M[arch]) % FACADE.FLOOR_H_M === 0`; every roof & setback terrace has a `1.05 m` solid parapet wall (with a `2.4 m` gap at fire-escape landings).
3. **All 5 Massings & 5 Ground Programs Present**: Verify in Sector 1–4 layout stats (`layout.stats`) that `L_SHAPE`, `PODIUM_OFFSET`, `STEPPED_SETBACK`, `GALLERY_DANCHI`, and `PENCIL_TOWER` massings AND all 5 ground programs (`CYBER_EATERY`, `TECH_APPAREL`, `CAPSULE_HOTEL`, `CYBER_APARTMENT`, `ALLEY_INFRA`) generate with realistic proportions, human-scale recessed doors (`~1.0–1.8 m × 2.15 m`), and zero floating roof props over `L_SHAPE` cutouts.
4. **Exterior-Corridor Apartment Walkability**: Confirm player can walk/grapple onto `GALLERY_DANCHI` 2F–4F corridors, see ceiling cable trays, pipes, fluorescent tubes, railings, and recessed painted doors with barred side windows, and emit valid `PropSocket`s at exact floor/wall positions.
5. **Baked Vertex AO + Infrastructure**: Verify ground contact darkening (`Y = 0..0.55 m`), dark awning/corridor soffits, recessed door jamb darkening, 3-pipe building-side bundles, glowing iron manholes with steam plumes anchored directly above them, `CAP.NEON = 960` density, and subtle road grime/oil-slick sheen.
6. **Mobility & Stealth Intact**: Parallel wall-run still works cleanly on `>= 2` faces per tower and narrow alleys; enemy spawns and `facadeProbe` / `facadeRooms` census remain valid.

### Phase 9B Verification
1. `npm run build` and `npm test` pass cleanly (add unit tests validating socket diversity across adjacent doors, `doorClearZones` non-overlap, alley `>= 2.6 m` center clearance, and `L_SHAPE` roof-prop containment).
2. **Zero Cloned Doorways**: Verify adjacent `GALLERY_DANCHI` doors & adjacent 1F storefronts render distinct prop combinations (potted plants, wire racks, stacked storage bins, room-number plaques `3-0805` style, breaker boxes, keypads, eatery crates/stools, A-frame signs) sitting flush on slabs/walls with zero floating geometry.
3. **Gritty Alley Atmosphere**: Verify narrow alleys & highway underpasses contain organic clusters of cardboard boxes, trash bins & glossy garbage bags, crouch-cover dumpsters (`1.8 × 1.15 × 1.1 m`), weathered benches, pallets/oil drums/jersey barriers/cones, and `4 × 2` graffiti & torn-poster wall decals without blocking doors or wall-runs.
4. **Performance & Budget Gate**: Verify `renderer.info.render.calls <= 120` in Sector 4 (all props + enemies + VFX active), vertex-shader distance culling active on micro-props beyond `64 m`, zero WebGL warnings, and zero per-frame allocations.
