# STRAND // PROTOCOL — Hero Close-Up Procedural 3D Modeling Blueprint Specification

**Purpose**: Precision procedural 3D CAD-style geometry recipes for every close-up hero asset across **Phases 10C, 10D, 11A, and 12B** so the implementation AI builds authentic, beveled, multi-part AAA silhouettes instead of plain box primitives.  
**Referenced By**: `PHASE10_OVERHAUL_PLAN.md` (10C, 10D), `PHASE11_INTERIORS_DESTRUCTION_PLAN.md` (11A-1c, 11A-2), `PHASE12_AAA_RENDER_CINEMA_PLAN.md` (12B-3).  
**Coordinate Convention**: Right-handed Y-up (`+Y` up, `+Z` forward/front face, `+X` right). Ground contact strictly at `y = 0.000`. All dimensions in **meters (`m`)**.

---

## 0. Shared Procedural Modeling Primitives & Rules

Reuse the existing geometric builders from `src/player/ViewModelKit.ts` (`bevelBox`, `profile`, `frontPlate`, `roundRect`, `lathe`, `tube`, `capsule`, `cylinder`, `torus`, `at`) PLUS add one new reusable hull builder in `src/world/CityVehicles.ts`:

### `loftSymHull(stations, smoothCreaseDeg = 35)` (Mandatory for Cars & Sculpted Hulls!)
> [!CAUTION]
> **NEVER** build a supercar or truck body by extruding a single 2D side profile across X (`ExtrudeGeometry`) — that creates flat rectangular brick hoods and vertical slab sides!
* Instead, define each sculpted vehicle body as a sequence of **cross-section stations along Z** (`z_0 > z_1 > ... > z_k`, front `+Z` to rear `-Z`), where every station specifies the same count of symmetric right-half profile points `(x >= 0, y)` ordered from **bottom centerline `(0, yBot)` → rocker/lower edge → wide fender beltline → shoulder crease → top centerline `(0, yTop)`** (mirrored automatically to `-x` for the left half, capped cleanly at front & rear!).
* Triangulate adjacent station rings into crisp quad strips; split hard architectural crease edges where dihedral angle `> smoothCreaseDeg` (`35°`) and average vertex normals across smooth curves!
* **Vertex Budget Rule**: Every instanced hero model MUST stay within its stated triangle ceiling (`<= 1,100` tris for hero vehicles, `<= 450` tris for vending/furniture/interior variants) so instancing 30–200 copies holds locked 60fps.
* **Baked Ground-Contact AO**: Every vertex with `y < 0.30` on ground-resting models applies `aAo *= 0.45 + 0.55 * (y / 0.30)`; recessed cavities (air intakes, wheel wells, vending display interior, pickup bed, door recesses) set `aAo = 0.35–0.50`.

---

## 1. Hero Parked Vehicles (`src/world/CityVehicles.ts` — Phase 10C-1)

All 3 vehicle variants share the upgraded `createCarMaterial()` with per-vertex `aPart`:
- `0`: Main painted clearcoat body (tinted by `aPaint`, clearcoat Fresnel sheen + lower road-grime darkening `y < 0.38`)
- `1`: Dark tinted canopy glass (`roughness 0.05`, `metalness 0.90`, `#070b12`)
- `2`: Front LED headlights / DRL (emissive white/cyan, or blinking amber on hazard)
- `3`: Rear LED taillight bar (emissive crimson `#FF1830`)
- `4`: Matte carbon fiber / rubber tires / dark intake honeycomb mesh (`roughness 0.72`, `metalness 0.15`, `#111318`)
- `5`: Cyber-taxi amber roof sign (shown only on taxi paint, as existing)
- `6`: Brushed alloy metal (wheel spokes, exhaust tips, brake discs, chrome grille bars, roll-bar: `roughness 0.24`, `metalness 0.92`, `#8d95a0`)
- `7`: Crimson painted brake calipers / tow-hook accents (`roughness 0.32`, `metalness 0.40`, `#b81828`)
- `8`: Glowing rear/front cyber license plate (`emissive` soft cool white/blue `0.85`, below harsh Bloom)

### 1.1 Shared Multi-Spoke Hero Wheel Assembly (`buildHeroWheel(radius, width, x, y, z, sideSign)`)
Used on all 4 corners of every vehicle (~95 tris/wheel, placed inside real carved wheel-arch recesses):
1. **Rubber Tire (`aPart = 4`)**: `lathe` profile (`14` radial segments) with chamfered sidewall shoulders (`rInner = radius * 0.62`, `rOuter = radius`, width `width`), slight outer sidewall crown.
2. **Deep-Dish Alloy Rim Barrel (`aPart = 6`)**: Recessed inner cylinder (`r = radius * 0.63`, depth `width * 0.65`) + outer thin lip ring (`torus` `r = radius * 0.62, tube = 0.016`).
3. **7-Spoke Y-Split Alloy Face (`aPart = 6`)**: Central hub cap (`r = radius * 0.16`) + `7` angled radial spoke struts (`bevelBox` `0.022 × radius * 0.46 × 0.018`, pitched `±8°` into deep-dish center) so wheel openings clearly show depth!
4. **Inner Brake Rotor & Crimson Caliper (`aPart = 6` & `7`)**: Recessed metallic disc (`r = radius * 0.46`, inset `0.04 m` behind spokes) + curved crimson brake caliper block (`0.06 × 0.14 × 0.05 m`, `aPart = 7`) mounted at the rear-upper quadrant (`+40°`) of the rotor!

### 1.2 Variant 0 — Aventador-Style Cyber Supercar Coupe (`~980` tris)
* **Overall Envelope**: Length `4.66 m` (`z ∈ [-2.33, +2.33]`), Width `2.06 m` (`halfW = 1.03`), Height `1.16 m`, Ground Clearance `0.15 m`, Wheelbase `2.74 m` (`zFront = +1.36`, `zRear = -1.38`), Wheel `r = 0.34 m`, `width = 0.29 m` (rear `0.33 m` wider!).
* **Sculpted Lofted Main Body (`aPart = 0`, 8 Z-Stations via `loftSymHull`)**:
  Each station gives right-half `(x, y)` from bottom centerline → rocker → lower flare → fender peak/beltline → hood/deck crease → top centerline:
  - `z = +2.33` (pointed V-nose tip): `(0, 0.20), (0.34, 0.21), (0.56, 0.32), (0.64, 0.44), (0.40, 0.47), (0, 0.45)`
  - `z = +2.05` (front bumper intakes): `(0, 0.18), (0.76, 0.19), (0.94, 0.36), (0.97, 0.56), (0.62, 0.60), (0, 0.54)` *(central hood crease dips `0.06 m` lower than fender peaks!)*
  - `z = +1.36` (front wheel arch peak): `(0, 0.16), (0.86, 0.17), (1.01, 0.44), (1.02, 0.72), (0.68, 0.76), (0, 0.70)`
  - `z = +0.72` (base of windshield): `(0, 0.16), (0.88, 0.17), (0.97, 0.46), (0.96, 0.78), (0.70, 0.80), (0, 0.78)`
  - `z = -0.15` (pinched door waist / intake mouth): `(0, 0.16), (0.86, 0.17), (0.92, 0.45), (0.94, 0.82), (0.72, 0.84), (0, 0.82)`
  - `z = -1.05` (flared rear haunches): `(0, 0.17), (0.92, 0.18), (1.03, 0.50), (1.03, 0.88), (0.74, 0.90), (0, 0.88)`
  - `z = -1.85` (rear fender taper): `(0, 0.20), (0.90, 0.22), (1.00, 0.54), (0.98, 0.90), (0.70, 0.91), (0, 0.89)`
  - `z = -2.33` (chopped Kammback tail): `(0, 0.28), (0.80, 0.30), (0.92, 0.56), (0.90, 0.86), (0.62, 0.88), (0, 0.86)`
* **Tapered Teardrop Greenhouse Cockpit (`aPart = 1`, 5 Z-Stations via `loftSymHull`)**:
  Sits cleanly atop the body (`z = +0.80 -> -1.25`), **markedly narrower than the fenders** (crucial for authentic supercar stance!):
  - `z = +0.80`: `(0, 0.78), (0.68, 0.78), (0.62, 0.81), (0, 0.82)`
  - `z = +0.20` (windshield top): `(0, 0.80), (0.70, 0.82), (0.54, 1.13), (0, 1.16)`
  - `z = -0.45` (roof peak): `(0, 0.82), (0.69, 0.84), (0.53, 1.13), (0, 1.15)`
  - `z = -1.25` (fastback engine bay taper): `(0, 0.86), (0.58, 0.88), (0.44, 0.94), (0, 0.95)`
  - Add angled painted A-pillars (`bevelBox` `0.045 × 0.045 × 0.78 m`, `aPart = 0`) framing the windshield + matte carbon roof scoop accent (`aPart = 4`).
* **Signature Supercar Details**:
  1. **Front Carbon Splitter & Dual Angular Air Intakes (`aPart = 4`)**: Low chin lip (`1.92 × 0.045 × 0.42 m` at `y = 0.16, z = +2.14`) + twin trapezoidal recessed dark intake pockets (`x = ±0.56, y = 0.30, z = +2.16`, `aAo = 0.35`) with angled vertical carbon strakes.
  2. **Recessed Angular Y-Beam Headlights (`aPart = 4` housing + `aPart = 2` LED)**: Dark recessed triangular housing at `x = ±0.66, y = 0.54, z = +1.96` (pitched `-16°`, yawed `±18°`) containing sharp glowing Y-shaped DRL blades (`0.024 m` thin LED strips!).
  3. **Deep Sculpted Side Air Intake Scoops (`aPart = 4`)**: Behind doors (`x = ±0.96, y = 0.58, z = -0.62`), dark recessed wedge pocket (`0.14 × 0.36 × 0.58 m`, `aAo = 0.35`) framed by an angled carbon intake splitter vane.
  4. **Lower Carbon Side Skirts (`aPart = 4`)**: Running between wheel arches (`x = ±0.94, y = 0.18, z = 0.0`, `length 1.96 m`).
  5. **Wing Mirrors on Angled Stalks (`aPart = 4` stalk + `aPart = 0` cap)**: Mounted at `x = ±0.84, y = 0.84, z = +0.45`, projecting cleanly to `x = ±1.06`.
  6. **Elevated Twin-Strut Rear GT Carbon Wing Spoiler (`aPart = 4`)**: Twin swan-neck upright pylons (`x = ±0.46, y = 0.90..1.16, z = -2.12`) holding an arched aerodynamic wing airfoil (`width 1.88 m, chord 0.28 m, thickness 0.035 m` at `y = 1.18, z = -2.18`, pitched `+6°`) with vertical trapezoidal endplates (`0.025 × 0.16 × 0.32 m`)!
  7. **Louvered Rear Engine Deck & Quad Diffuser Tail**: `4` angled matte-carbon engine slats (`z = -1.25..-1.95, y = 0.90..0.95`), full-width recessed dark tail fascia (`z = -2.32`) with sharp twin Y-branch red LED tail bars (`aPart = 3`), lower 4-fin carbon diffuser (`y = 0.24`), glowing rear license plate (`aPart = 8`), and **4 metallic exhaust tips** (`aPart = 6`, `r = 0.048 m` cylinders at `x = ±0.16, ±0.30, y = 0.30, z = -2.35`).

### 1.3 Variant 1 — Cyberpunk 2077 Heavy Pickup Truck (`~920` tris)
* **Overall Envelope**: Length `5.10 m` (`z ∈ [-2.55, +2.55]`), Width `2.12 m` (`halfW = 1.06`), Height `1.88 m`, Ground Clearance `0.30 m`, Wheel `r = 0.43 m`, `width = 0.34 m`, `zFront = +1.58`, `zRear = -1.48`.
* **Sculpted Front & Crew Cab (`loftSymHull`, `aPart = 0`)**:
  - Bold high-hood nose (`y = 0.42..1.18` at `z = +2.50`, central power-bulge dome `+0.06 m`), tapered windshield & double-cab greenhouse (`z = +0.90..-0.45`, roof `y = 1.84`, roof half-width `0.82 m` vs body `1.04 m`).
  - **Wide Front Illuminated-Rim Mesh Grille (`z = +2.52, y = 0.76`)**: Recessed dark metallic mesh (`1.36 × 0.42 m`, `aPart = 4`, `aAo = 0.38`) crossed by `3` horizontal chrome bars (`aPart = 6`), flanked by **stacked twin-tier quad LED headlight bars** (`aPart = 2`, `x = ±0.82`).
  - **Heavy Armored Bumper (`aPart = 4`)**: Protruding chin bumper (`2.10 × 0.26 × 0.24 m`, `y = 0.44, z = +2.56`), center **glowing cyber license plate (`0.36 × 0.16 m`, `aPart = 8`)**, and **twin red tow hooks (`aPart = 7`, `x = ±0.56`)**.
  - **Flared Trapezoidal Fender Arches (`aPart = 4`)** + tubular side running boards (`y = 0.34, x = ±1.06`) + heavy square truck mirrors (`x = ±1.14, y = 1.36, z = +0.58`) + `3` amber cab-roof marker LEDs (`aPart = 2`, `y = 1.87`).
* **Real Hollow Rear Cargo Bed (`z = -0.48..-2.50`)**:
  - Build left/right bed side walls (`thickness 0.16 m`, `y = 0.56..1.18`) + tailgate (`z = -2.50`) around an **open recessed bed floor (`y = 0.62`, `aPart = 4`, `aAo = 0.42`)**!
  - Add a **tubular metallic roll-bar rack (`aPart = 6`, `tube` `r = 0.045 m`)** rising behind the cab (`z = -0.56`, up to `y = 1.82`) with `2` rear work-light pods + `2` strapped cargo crates (`aPart = 4/0`) sitting inside the bed!
  - Rear bumper, vertical red LED tail clusters (`aPart = 3`), glowing rear plate (`aPart = 8`), and dual side-exit exhaust pipes (`aPart = 6`).

### 1.4 Variant 2 — Cyber Armored Cargo Van (`~820` tris)
* **Overall Envelope**: Length `4.95 m`, Width `2.08 m`, Height `2.08 m`, Ground Clearance `0.26 m`, Wheel `r = 0.39 m`.
* **Sculpted Lofted Hull (`loftSymHull`)**: Angled armored wedge nose (`z = +2.46 -> +1.55`), narrow slit windshield (`aPart = 1`) beneath an overhanging steel visor brow, beveled side armor ribs (`3` horizontal raised ribs per flank), recessed wheel wells + rugged flares, sliding side door groove seam, roof utility cargo rack (`aPart = 6`) with low amber strobe bar (`aPart = 2`), split rear armored double doors with `4` heavy hinge knuckles, and twin vertical red LED tail columns (`aPart = 3`).

---

## 2. Hero Close-Up Vending Machine (`Phase 10C-2`, `~340` tris)

* **Overall Envelope**: Width `1.10 m` (`x ∈ [-0.55, +0.55]`), Height `2.05 m` (`y ∈ [0.0, 2.05]`), Depth `0.78 m` (`z ∈ [-0.39, +0.39]`, front = `+Z`).
* **Exact Multi-Part Construction** (replaces flat box cabinet in `CityBuilder.ts`):
  1. **Base Plinth & Leveling Feet**: Recessed dark steel kick-base (`1.04 × 0.12 × 0.72 m`, `y = 0.06`, `aAo = 0.42`).
  2. **Outer Chamfered Cabinet Shell**: Left/right side panels (`thickness 0.08 m`), solid back, top cantilevered illuminated marquee hood (`y = 1.86..2.05`, projecting `+0.06 m` forward to `z = +0.45` with underside white downlight strip!).
  3. **Real `0.14 m`-Deep Recessed Illuminated Display Bay (`x ∈ [-0.47, +0.24], y ∈ [0.68, 1.82], z = +0.24..+0.38`)**:
     - Recessed inner back display plane at `z = +0.25` textured with **`tex.vendingAtlas` (`512 × 512`, 4 brands: `NI-COLA`, `SYNTH-CAF`, `K-BOOST`, `ZERO-H2O`, 100% English + `$2.50` / `€$15` digital price LEDs, colorful cans/bottles!)**.
     - `3` real protruding horizontal metallic shelf lip rails inside the recess (`z = +0.26..+0.34` at `y = 0.94, 1.22, 1.50`) + thin glossy glass cover sheet at `z = +0.365` framed by beveled anodized bezel trim!
  4. **Protruding Right-Side Control Bezel (`x ∈ [+0.26, +0.49], y ∈ [0.68, 1.82], z = +0.39..+0.42`)**:
     - Glowing blue/cyan touchscreen keypad (`0.16 × 0.24 m` at `y = 1.32`), backlit NFC tap icon ring (`y = 1.08`), recessed coin/card slot (`y = 0.92`), and tiny status LEDs.
  5. **Real `0.18 m`-Deep Bottom Pickup Chute (`x ∈ [-0.45, +0.24], y ∈ [0.16, 0.56], z = +0.20..+0.39`)**:
     - Recessed dark cavity (`aAo = 0.34`) with a tilted brushed-steel hinged push flap (`rx = +0.18 rad`) and rubber bumper edge!
  6. **Exterior Armor Details**: Vertical ribbed ventilation louvers on left/right side flanks (`5` slanted slats), heavy dark rubber corner bumper rails (`y = 0.14..1.84`), and top heat-exhaust grate.

---

## 3. Hero Close-Up Street Furniture & Landmarks (`Phase 10C-3` & `10D-2`)

### 3.1 Detailed Street Lamp (`~220` tris, replaces `createLampGeometry()`)
* **Height**: `6.6 m`.
* Octagonal flanged cast-iron base plate (`r = 0.24 m`, `h = 0.08 m`) + `4` hex anchor bolts + stepped collar plinth (`y = 0.08..0.55`).
* Tapered shaft (`r = 0.11 -> 0.075 m`), chest-height latched steel electrical service cabinet (`0.22 × 0.42 × 0.16 m` at `y = 1.35`, tiny green status LED).
* Mid-pole protruding twin banner arms (`y = 3.2, 4.4`, `length 0.55 m`) carrying a subtle weathered cyber-district flag/accent light ring.
* Sweeping curved gooseneck luminaire arm (`tube` along 6-point arc from `(0, 5.8, 0)` → `(0, 6.65, 1.0)` → `(0, 6.50, 2.05)`) ending in a sculpted ribbed-heatsink luminaire head (`0.46 × 0.15 × 0.96 m`) with recessed glowing LED lens array (`aPart = 1`).

### 3.2 `StreetFurnishingsKit` Variants (`0..3`, `10C-3` & `10D-2`, `<= 380` tris/variant)
* **v0 — Hanging Cyber Paper Lantern String (`Chochin`, span `4.2 m`)**:
  - Sagged 6-segment catenary wire (`tube`, `r = 0.012 m`, `sag = 0.35 m`).
  - `5` lathed ribbed ovoid lanterns (`lathe` `8` radial × `7` vertical pts, `r = 0.14 m`, `h = 0.34 m`) with dark wood top/bottom rings (`h = 0.025 m`), `3` thin horizontal dark wire ribs, and warm red/orange glowing core (`emissive 1.35`, below harsh blowout).
* **v1 — Rain-Wet Sidewalk Cafe Parasol Umbrella (`h = 2.45 m, r = 1.28 m`)**:
  - Weighted octagonal cast-iron base (`r = 0.28 m`, `h = 0.08 m`), steel center pole (`r = 0.028 m`), `8`-sided gently drooped umbrella canopy (`lathe` with slight scalloped valance skirt at `y = 2.02..2.12`, peak `y = 2.45`, dark wet crimson/charcoal), `8` visible underside radial support ribs (`aAo = 0.45`), and a tiny warm hanging cage bulb under the hub (`y = 2.06`).
* **v2 — Steaming Cyberpunk Ramen Street-Vendor Cart (`2.20 × 2.35 × 1.15 m`, `10D-2`)**:
  - `4` steel caster wheels (`r = 0.09 m`) under a stainless-steel cart chassis (`1.85 × 0.92 × 0.85 m`), side tubular push-handle bar (`x = -1.02`), dark slatted timber front skirt + cantilevered customer counter lip (`depth +0.28 m` at `y = 0.94`).
  - Countertop recessed stainless noodle-boiler vat (`0.48 × 0.36 m` emitting rising steam anchor!), glass sneeze-guard hood (`y = 0.95..1.38`), `3` stacked ceramic bowls & condiment bottle cluster.
  - `4` corner square steel roof posts (`y = 0.92..2.22`) supporting a slanted corrugated metal awning (`2.30 × 1.35 m`, `y = 2.18..2.35`), hanging front glowing English menu sign (`SYNTH RAMEN`, `1.45 × 0.28 m`), `3` short hanging fabric valance flaps, and `2` small glowing corner lanterns!
* **v3 — Holographic Bus-Stop Shelter (`3.60 × 2.55 × 1.45 m`, `10D-2`)**:
  - `3` heavy angled dark-steel cantilevered C-frame structural ribs (`x = -1.75, 0.0, +1.75`) holding a chamfered steel/glass rain roof (`3.70 × 0.14 × 1.55 m` at `y = 2.48`) with recessed linear cyan/white underside ceiling LED strip.
  - Translucent rain-streaked rear glass wind-screen panels (`y = 0.22..2.35`) framed in matte black aluminum mullions.
  - Right-side backlit double-sided **transit map & ad lightbox kiosk (`0.18 × 2.15 × 1.25 m` at `x = +1.75`)** glowing softly (`0.95` controlled emissive).
  - Integrated slatted steel waiting bench (`1.85 m` wide, seat `y = 0.46`, angled backrest `y = 0.84`, `3` curved armrests).

---

## 4. Hero Close-Up Interior Micro-Props (`InteriorPropsKit` — Phase 11A-1c, `<= 360` tris/variant)

Every variant sits cleanly at local `y = 0.0` (tabletop variants sit on counter height or include their own counter/desk base so zero floating misalignment!):
* **v0 — Eatery Counter Place-Setting Cluster (`0.85 × 0.36 × 0.45 m`, sits atop counter)**:
  - `2` lathed ceramic ramen bowls (`r = 0.105 m`, `h = 0.085 m`, outer matte black/red rim, inner warm broth disc) with a pair of angled bamboo chopsticks resting across one rim (`cylinder` `r = 0.004 m, len = 0.23 m`).
  - Stack of `3` nested spare bowls, `2` lathed condiment squeeze/glass bottles (`h = 0.16 m` with red/amber caps), brushed-steel napkin dispenser box (`0.11 × 0.14 × 0.07 m`), and a tiny backlit tabletop acrylic menu tent (`0.12 × 0.18 m`, subtle warm glow).
* **v1 — Kitchen Back-Counter Appliance Station (`1.60 × 1.95 × 0.72 m`, floor-standing)**:
  - Stainless-steel prep cabinet (`y = 0.0..0.90`) with recessed twin noodle-boiler vats, `2` wire strainer baskets with hooked handles resting on the rim, stacked stainless prep trays, and overhead wall-mounted rail (`y = 1.68`) holding `3` hanging ladles + glowing red digital temp readout (`0.18 × 0.08 m`).
* **v2 — Tech Shop Illuminated Cyber-Gear Pedestal (`0.72 × 1.48 × 0.72 m`, floor-standing)**:
  - Tapered matte-black beveled monolith plinth (`0.68 × 0.92 × 0.68 m`) with glowing cyan base collar strip + top acrylic showcase frame (`y = 0.92..1.44`, thin corner posts).
  - Inside the showcase: a **sculpted futuristic cyber-visor helmet** (`lathe`/beveled cranial shell + wrap-around glowing cyan optical visor strip + side ear-comm pods resting on a chrome neck cradle!) + angled holographic spec placard at front lip.
* **v3 — Tech Apparel Tactical Jacket Rack (`1.45 × 1.62 × 0.56 m`, floor-standing)**:
  - Matte-black tubular steel A-frame garment rack (`tube` `r = 0.018 m`, bottom shoe shelf with `2` storage boxes).
  - `4` individual stylized hanging cyberpunk jackets (beveled shoulder yoke, draped tapered torso shell, **high upturned tech collar**, sleeves, and thin glowing cyan/magenta shoulder piping strips, each subtly yawed `±6°` for organic cloth look!).
* **v4 — Cyber Apartment Desk & Dual-Monitor Terminal Rig (`1.45 × 1.38 × 0.95 m`, floor-standing)**:
  - Industrial steel-frame desk (`1.40 × 0.76 × 0.68 m`, tubular legs + lower cross-bar + side PC tower box with glowing cyan fan slit under right side).
  - **Curved Dual-Monitor Terminal**: `2` thin beveled monitor slabs (`0.54 × 0.34 × 0.025 m`, yawed `±14°` inward on articulated stand arms) with glowing cyan/teal UI screens (`emissive 0.85`), low angled mechanical keyboard (`0.42 × 0.025 × 0.15 m`), mouse, ceramic coffee mug (`lathe` + handle), articulated swing-arm desk lamp (`y = 0.76..1.22` with warm bulb), and **tucked ergonomic swivel chair** (5-star wheeled base, pneumatic cylinder, curved mesh backrest & armrests, rotated `22°`!).
* **v5 — Apartment Compact Kitchenette (`1.15 × 1.52 × 0.62 m`, floor-standing)**:
  - Compact weathered cyber mini-fridge (`0.58 × 0.96 × 0.58 m`, recessed door grip, vertical glowing blue temp strip, magnets/sticker), countertop microwave box (`0.48 × 0.28 × 0.36 m` with dark glass window & green LED clock), plus side shelf holding `3` instant-noodle cups and stacked magazines.
* **v6 — Hotel / Arcade Lobby Check-In Console & Lounge (`2.20 × 1.15 × 0.95 m`, floor-standing)**:
  - Faceted dark-slate & brushed-brass reception counter (`1.85 × 1.05 × 0.72 m`) with recessed glowing front kick-strip, twin angled check-in glass holographic terminals on top, and beside it a low modern segmented cyber-lounge bench (`1.1 m`) with dark leather cushions.
* **v7 — Interior Industrial Caged Pendant Lamp, Framed Wall Poster & Standing Fan (`0.95 × 2.35 × 0.65 m`)**:
  - Overhead drop rod (`y = 2.35 -> 1.85`) holding a lathed matte-black enameled dome shade (`r = 0.22 m`), protective circular wire guard cage, and warm glowing Edison-style bulb.
  - Floor-standing oscillating electric fan (`r = 0.20 m` circular mesh guard, 3 hub blades, telescoping chrome stand, weighted base) + `2` stacked storage crates beside it.

---

## 5. First-Person Breach Boot, Interactive Door & Humanoid Endo-Core (`Phases 11A-2` & `12B-3`)

### 5.1 First-Person Cyber-Boot Kick Rig (`ViewModelRenderer.ts` — Phase 11A-2, `~280` tris)
Built with `ViewModelKit` (`MeshKit` + `bevelBox` + `cylinder`, sharing existing `gearMat` & `hardMat` — **`+0` extra draw calls!**):
* **Armored Lower Shin Guard**: Tapered dark ballistic shin plate (`0.11 × 0.34 × 0.12 m`) with `2` buckled calf straps and twin external matte-chrome **exo-ankle hydraulic piston rods** flanking the ankle joint (`r = 0.010 m`).
* **Sculpted Tactical Cyber-Boot**: Heavy lugged rubber sole (`0.125 × 0.042 × 0.31 m` with `5` visible underside tread cleats — clearly seen as the sole strikes the door!), beveled carbon-armored toe cap, laced mid-foot vamp, metallic heel counter, and a crisp thin **cyan heel/ankle accent fiber** (`glow`).
* **Animation Arc (`0.22 s`)**: `0.00–0.05 s` chamber knee rapidly up from below frame (`y: -0.75 -> -0.22, z: -0.25`) → `0.05–0.12 s` explosive extension forward (`z: -0.25 -> -0.74, y: -0.14`, sole pitched upward `+24°` impacting center-door!) → `0.12–0.22 s` crisp snap retraction back below frame while weapon smoothly lowers/returns.

### 5.2 Interactive Breach Door Panel (`InteractiveDoors` — Phase 11A-2, `~160` tris)
* Standard dimensions: `1.04 m × 2.16 m × 0.075 m` (scaled cleanly per doorway width).
* Beveled outer steel door leaf (`withTint` weathered olive/slate/charcoal), **2 recessed stamped structural panels** (upper `0.74 × 0.88 m`, lower `0.74 × 0.72 m`, inner bevel AO `0.55`), narrow armored wire-glass vision slit (`0.18 × 0.44 m` at `y = 1.55`), horizontal brushed-steel **crash push-bar** on interior / heavy lever handle + armored lock escutcheon on exterior (`x = +0.38, y = 1.02`), bottom stainless kickplate (`h = 0.24 m`), and tiny **glowing lock status LED** (amber when closed/kickable, green while quietly unlocked).

### 5.3 Humanoid Strippable Armor & Inner Cyber-Endo Core (`EnemyManager.ts` — Phase 12B-3, `+0` extra draw calls!)
Inside every humanoid torso/shoulder hierarchy (`ENFORCER`, `AEGIS`, `VEIL`, `PHANTOM`):
* **Inner Cyber-Endo Core (Always Built Inside Torso, Revealed on Strip)**:
  - Dark ribbed titanium sternum & `3` curved horizontal ribcage struts (`bevelBox`, `#2b323c`, `metalness 0.88`), recessed central **pulsing glowing power reactor cell** (`cylinder` `r = 0.065 m`, emissive orange/cyan), exposed braided neck/clavicle power conduit cables, and machined metallic shoulder ball-socket joints (`r = 0.07 m`).
* **Outer Detachable Armor Plates (Tagged `armorLeftShoulder`, `armorRightShoulder`, `armorChestPlate`)**:
  - Fit snugly (`+0.025 m`) over the inner endo-core so intact enemies look sleek and armored; when `HP < 60%` (or on heavy hit/shield break), toggle `visible = false` on `1–2` plates and eject matching beveled dark plates into `DestructDebris` while sparking continuously from the revealed power conduits!

---

## 6. Model Quality Self-Check Assertions (Unit-Testable!)
Before completing 10C, 10D, 11A, or 12B, assert in unit tests:
1. **Non-Brick Car Silhouette Check**: For Variant 0 Supercar Coupe, assert front nose width (`|x|` at `z > 2.2`) is `< 0.70 ×` rear fender width (`|x|` at `z ∈ [-1.2, -0.9]`), greenhouse roof width (`|x|` at `y > 1.05`) is `< 0.65 ×` body fender width, and `aPart` includes ALL required material IDs (`0, 1, 2, 3, 4, 6, 7, 8`).
2. **Ground Contact Check**: Every floor-resting hero model's geometry bounding box satisfies `Math.abs(bbox.min.y) <= 0.02` (zero floating wheels, vending feet, carts, desks, or racks!).
3. **Triangle Budget Check**: Every hero vehicle variant `<= 1,100` tris; every vending/furnishing/interior variant `<= 450` tris (keeping 60fps locked across all 5 sectors!).
