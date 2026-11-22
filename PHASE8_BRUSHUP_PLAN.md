# STRAND // PROTOCOL — Phase 8 Brush-Up Master Specification (8A & 8B)

**Target Implementer**: Claude (TypeScript / Three.js / WebGL2 / Web Audio API)  
**Target Codebase**: `strand-protocol/` (on top of Phase 7A/7B `df687c0`)  
**Master Spec Alignment**: `GAME_DESIGN_SPEC.md` v1.5 (now 100% English)  
**Hard Constraints (Zero Regression)**:
- Maintain `<= 120 draw calls / frame` (`renderer.info.render.calls`) and **zero per-frame heap allocations** in update/render loops.
- Preserve 100% procedural WebGL2 + Web Audio API (zero external assets).
- Preserve all Non-Negotiable Rules from `GAME_DESIGN_SPEC.md` §0 (exclusive gun⇄grapple switching with hanging allowed, 3-phase telegraph lines, 100 HP / 3.0s out-of-combat regen / 0.5s retry, zero shooting aim assist, airborne Bullet Time, pause/blur audio mute).
- **Split Execution Order**: Implement and verify **Phase 8A** cleanly (including `npm run build` and unit tests) before starting **Phase 8B**.

---

## PHASE 8A — Controls, Pistol + Single-Shot 4x Sniper Overhaul & 4-State Stealth-Combat AI

### 8A-1. Fix Inverted Wall-Run Camera Roll
* **Root Cause Confirmed** (`src/player/PlayerController.ts` ~L1185–1199):
  - `WALL_RUN_L` currently assigns `rollTarget = -CAMERA.WALLRUN_ROLL_DEG`, which is then negated (`-rollTarget`) into `+13.5°` CCW `camera.rotation.z`, tilting the top of the camera **left INTO the left wall** instead of leaning away from it.
* **Required Fix**:
  - Flip the wall-run roll signs:
    ```ts
    if (this.state === 'WALL_RUN_L') rollTarget = CAMERA.WALLRUN_ROLL_DEG;       // tilts clockwise (top-right), leaning AWAY from left wall
    else if (this.state === 'WALL_RUN_R') rollTarget = -CAMERA.WALLRUN_ROLL_DEG; // tilts counter-clockwise (top-left), leaning AWAY from right wall
    ```
  - Verify `WALL_RUN_L` produces `camera.rotation.z < 0` and `WALL_RUN_R` produces `camera.rotation.z > 0` (scaled by `settings.rollScale`).

### 8A-2. Lower Crouch & Slide Eye Height
* **File**: `src/config/constants.ts`, `src/player/PlayerController.ts`
* **Exact Constants**:
  - `PLAYER.CROUCH_EYE_HEIGHT`: `1.05` → **`0.78`** m (clearly low behind parked cars, dumpsters, and street barriers).
  - `PLAYER.SLIDE_EYE_HEIGHT`: `0.86` → **`0.68`** m.
  - `PLAYER.SLIDE_HEIGHT` (crouch & slide capsule height): update to **`0.94`** m (ensure `canStand()` ceiling clearance check uses `PLAYER.HEIGHT` smoothly when uncrouching).
  - `PHYSICS.CROUCH_SPEED`: **`4.4`** m/s (boosted by `SK_07` Shadow Step).

### 8A-3. Streamlined Weapon Roster: Suppressed Pistol + Single-Shot 4x Rail Sniper + Grapple
Remove **SMG** and **Shotgun** completely from configs, types, viewmodels, audio, HUD, and tests.
* **Slots & Keybinds** (`src/config/weapons.ts`, `src/engine/InputManager.ts`, `src/player/EquipmentManager.ts`, `src/ui/HudManager.ts`):
  - `export type GunId = 'PISTOL' | 'SNIPER';`
  - `export type SlotId = GunId | 'GRAPPLE';`
  - Key `[1]` → `PISTOL` (`slot: 1`)
  - Key `[2]` → `SNIPER` (`slot: 2`)
  - Key `[3]` or `[Q]` / `Mouse Side 4` → `GRAPPLE` (`slot: 3`; `Q` toggles between `GRAPPLE` and last active gun)
  - Mouse wheel cycles `[1 -> 2 -> 3]` seamlessly. Remove `[4]` slot references from HUD and bindings.

#### Weapon 1: `MK-IV RAIL PISTOL` (Suppressed Stealth Sidearm — `[1]`)
* **Stats**:
  - `damageBody: 55`, `headMultiplier: 2.5` (`137.5` HS), `rpm: 200` (`intervalMs: 300`), `magazine: 8`, `reloadS: 1.15`, `projectileSpeed: 260`, `range: 140`, `spreadDeg: 0`, `spreadBtDeg: 0`, `pellets: 1`, `automatic: false`, `shieldMultiplier: 1.0`.
  - **Acoustic Sound Radius**: `soundRadius: 14.0` m (suppressed — ideal for stealth alley takedowns without alerting distant patrols).
  - **Recoil**: `verticalDeg: 2.2`, `horizontalDeg: 0.25`, `recoverDegPerS: 14`, `recoilScale: 0.78` in ADS.
  - **ADS Zoom & Lower Sensitivity**:
    - `fovOffsetDeg: -14.0` (at base `84°` → `70°`).
    - **`sensitivity: 0.55`** (explicitly lowered from `0.72` for steadier precision aiming).
* **ViewModel Upgrade (`src/player/ViewModelRenderer.ts`)**:
  - Add a sleek procedural **integral suppressor cylinder** extending cleanly ahead of the pistol muzzle with subtle vented ports.
  - **Unified SMG-Size Open Holo Sight**: Replace the old tiny `0.030 × 0.025 × 0.026` sight with the **exact old SMG hood dimensions** (`w = 0.046`, `h = 0.037`, `depth = 0.042`).
  - **Non-Reciprocating Frame Bridge Mount**: Mount the holo sight onto a rigid tactical rail bridge attached to the static `hard` frame (NOT on the moving `slide`!), so the optic window stays rock-steady during firing blowback. Clear untinted lens, tiny glowing center dot only (no thick circles/rings).
* **Audio (`src/engine/AudioEngine.ts`)**:
  - Crisp damped suppressed rail thump: Triangle `900 -> 110 Hz` (`28 ms`) + soft WaveShaper + Bandpass pneumatic snap `1800 -> 500 Hz` (`65 ms`) + subtle high-tech slide click (`2400 Hz`, `18 ms`). Keep last-2-rounds metallic warning ping.

#### Weapon 2: `K-90 RAIL SNIPER` (Single-Shot 4x Precision Rifle — `[2]`)
* **Stats**:
  - `damageBody: 120`, `headMultiplier: 2.5` (**`300` HS**), `magazine: 1` (**strictly single-shot breech-loaded**), `reloadS: 1.35`, `intervalMs: 220` (immediately transitions to auto-reload after firing!), `projectileSpeed: 460`, `range: 280`, `spreadDeg: 0`, `spreadBtDeg: 0`, `pellets: 1`, `automatic: false`.
  - **Aegis Shield Non-Piercing 1-Shot Shatter Rule (CRITICAL)**:
    - `shieldMultiplier: 1.6` (`120 × 1.6 = 192 >= 180` Aegis shield HP).
    - **1 sniper hit to an Aegis frontal shield destroys the shield immediately (triggering the `85 ms` hitstop, 32 shatter shards, sub-bass drop, and `1.5 s` stagger), and consumes the projectile cleanly — ZERO bleed-through/piercing damage to the Aegis enemy behind the shield!**
    - Note on `SK_02` (Momentum Chamber): Keep standard Aegis shield rule consistent for Sniper (even with `SK_02`, a sniper shot hitting an active Aegis shield breaks the shield without double-killing through it; `SK_02` still grants enemy-body penetration & `+35%` velocity on unshielded targets).
  - **Auto Breech Reload After Every Shot**:
    - Immediately after the brief fire recoil beat (`~0.16 s`), since `ammo === 0` (`magazine: 1`), `EquipmentManager` automatically enters `RELOADING` (`1.35 s`, scaled by FLOW rank / `SK_14` Adrenaline Surge).
    - **Cancellation**: Switching to `PISTOL` or `GRAPPLE` immediately cancels reload (standard anti-frustration rule); switching back to an empty Sniper automatically resumes reload cleanly.
    - **`SK_09` Shield Piercer Synergy**: If the Sniper shot shatters an Aegis shield or `VALKYRIE-09` wing while `SK_09` is owned, **instantly refill chamber to `1/1`** (bypassing the reload so the player can immediately follow up on the staggered target!).
  - **Acoustic Sound Radius**: `soundRadius: 58.0` m (thunderous rail crack that puts enemies across nearby blocks into Alert).
  - **Recoil & Shake**: `verticalDeg: 4.8`, `horizontalDeg: 0.4`, `recoverDegPerS: 10`, `recoilScale: 0.70`, trauma `+0.44`.
  - **True 4x Magnification & Lower Precision ADS Sensitivity**:
    - Do **NOT** use a fixed `fovOffsetDeg` for Sniper — compute exact **4x optical magnification** dynamically from the player's current `baseFov`:
      ```ts
      // True 4x zoom magnification regardless of user base FOV (75°–100°):
      // At default baseFov = 84°, fovAds ≈ 24.22°
      const halfBaseRad = (baseFov * 0.5) * DEG2RAD;
      const fovAdsDeg = 2 * Math.atan(Math.tan(halfBaseRad) / 4.0) * RAD2DEG;
      ```
    - **ADS Mouse Sensitivity**: Multiply user mouse sensitivity by `0.80 * (Math.tan(fovAdsRad / 2) / Math.tan(halfBaseRad))` = **`0.20`** (i.e. exact 4x tan-FOV scaling `0.25x` multiplied by an additional `0.80x` tactical steadiness reduction as requested!).
    - **Scope Visuals (`ViewModelRenderer.ts`)**:
      - Use the **exact same open holo hood dimensions as Pistol / old SMG** (`w = 0.046`, `h = 0.037`, `depth = 0.042`), completely clear untinted lens (NO black full-screen sniper vignette overlay!).
      - Inside the clear lens shader/reticle (only on Sniper), render an **ultra-thin crisp glowing crosshair (`0.7px`-equivalent fine lines with open center dot + 3 tiny horizontal/vertical rangefinder mil-dot ticks)** at subtle opacity (`0.65`) so targets at 4x remain completely unobstructed and sharp.
* **High-Craft Procedural Sniper Model (`ViewModelRenderer.ts`)**:
  - Faceted heavy upper/lower railgun receiver with beveled side armor plates (`MeshKit` + `bevelBox`), extended cheek-rest tactical stock, long fluted heavy barrel with dual glowing cyan/energy electromagnetic rail-coil channels, heavy baffled rectangular muzzle brake, folded side bipod rails, and articulated right bolt/breech lever.
  - **Two-Hand Single-Round Breech Reload Animation (`1.35 s`)**:
    - `0.00–0.22`: Tilt rifle slightly left; right/left hand pulls breech bolt back (`BOLT_OPEN` SE) and ejects spent glowing rail cartridge casing to the right.
    - `0.22–0.68`: Left hand enters frame holding a fresh long cyan-tipped rail cartridge, guides it into the open breech chamber (`LOAD_ROUND` metallic clack SE + upward gun settle jolt).
    - `0.68–0.88`: Bolt slams forward & locks (`BOLT_CLOSE` crisp lock SE); rail coils pulse bright along the barrel.
    - `0.88–1.00`: Return cleanly to ready/ADS sight picture.
* **Audio (`AudioEngine.ts`)**:
  - Deep sub-bass shock (`Sine 150 -> 26 Hz`, `310 ms`, heavy drive) + electromagnetic whip-crack (`Sawtooth 2200 -> 140 Hz`, `55 ms`, WaveShaper `k=45`) + reverberant canyon boom (`Bandpass noise 1400 -> 320 Hz`, `380 ms`).
  - Distinct 3-beat breech reload SE (`BOLT_OPEN`, `LOAD_ROUND`, `BOLT_CLOSE`).

### 8A-4. Reworked Roguelite Skills (`src/config/skills.ts`)
Replace the two deleted-weapon skills cleanly:
* **`SK_07` — `SHADOW STEP` (`SHADOW_STEP`)**:
  - Category: `STEALTH`
  - Trigger: Crouching & enemy awareness detection
  - Effect (Lv.1 / Lv.2 / Lv.3): Crouch move speed **`+35%` / `+50%` / `+65%`** AND enemy Alert Gauge fill rate (both vision & proximity) **`-35%` / `-48%` / `-60%`**.
* **`SK_09` — `SHIELD PIERCER` (`SHIELD_PIERCER`)**:
  - Category: `WEAPON`
  - Trigger: Pistol or Sniper hitting an Aegis shield or `VALKYRIE-09` wing emitter
  - Effect (Lv.1 / Lv.2 / Lv.3): Shield & boss-wing damage **`+60%` / `+90%` / `+120%`**, AND **destroying a shield or wing emitter instantly refills the active weapon's chamber/magazine to full** (`1/1` on Sniper, `8/8` on Pistol).
* **`SK_03` (`SWING RELOADER`)** edge-case check: When refilling a `magazine: 1` Sniper (`Math.ceil(1 * ratio)`), always refill cleanly to `1/1` at Lv.1–3.

### 8A-5. 4-State Stealth / Alert / Detected / Combat Enemy AI System (`src/entities/EnemyManager.ts`, `src/config/enemies.ts`, `src/ui/HudManager.ts`, `src/engine/AudioEngine.ts`)

#### A. Unified Sector Deployment (No Mid-Fight Wave Pop-In for Sectors 1–4)
* Update `SECTORS` in `src/config/skills.ts`:
  - **Sector 1**: `waves: [{ count: 9 }]`, `roster: { ENFORCER: 7, VEIL: 2 }` (total `9`).
  - **Sector 2**: `waves: [{ count: 13 }]`, `roster: { ENFORCER: 5, AEGIS: 3, VEIL: 2, DRONE: 3 }` (total `13`).
  - **Sector 3**: `waves: [{ count: 14 }]`, `roster: { ENFORCER: 4, AEGIS: 3, VEIL: 3, PHANTOM: 2, DRONE: 2 }` (total `14`).
  - **Sector 4**: `waves: [{ count: 14 }]`, `roster: { ENFORCER: 3, AEGIS: 3, VEIL: 3, PHANTOM: 3, DRONE: 2 }` (total `14`).
  - **Sector 5 (`VALKYRIE-09`)**: Boss + Phase 2 reinforcements spawn directly in **`COMBAT`** mode.
  - On Endless Loop 2+ when scaled roster exceeds `14`, spawn `14` initially and only feed overflow replacements as enemies die so simultaneous active count never exceeds `14`.
* **Natural Guard & Patrol Spawn Orientation**:
  - Remove the old `e.yaw = Math.atan2(playerX - x, playerZ - z)` on spawn!
  - Ground/highway/bridge units spawn along natural patrol segments (2–3 connected waypoints on sidewalks, plazas, bridges, or alleys, moving at calm patrol speed `2.0–2.6 m/s` and pausing `1.5–3.0 s` at turns to scan left/right `±35°`).
  - Rooftop Veil Snipers spawn facing outward over the main street/avenue (scanning a slow `±40°` watch arc).
  - Hunter Drones fly calm oval/figure-8 patrol loops at `8–18 m` altitude.

#### B. Exact 4-State AI Machine & Constants (`AI_STEALTH` in `src/config/enemies.ts`)
```ts
export type AlertState = 'UNAWARE' | 'ALERT' | 'DETECTED' | 'COMBAT';

export const AI_STEALTH = {
  // Vision cones
  FOV_HALF_DEG: 52,            // Standard humanoids (104° cone)
  FOV_HALF_VEIL_DEG: 38,       // Veil Sniper narrow long-range cone
  VISION_RANGE: 52,            // Standard units
  VISION_RANGE_VEIL: 95,       // Veil Sniper
  VISION_RANGE_DRONE: 40,      // Drone downward 360° scan cone
  // Distance-scaled vision fill rate (pts/sec, gauge 0..100)
  FILL_MIN_PER_S: 18,
  FILL_MAX_PER_S: 115,
  FILL_DIST_EXP: 1.6,
  CROUCH_FILL_MULT: 0.72,
  // Out-of-FOV proximity sensing
  PROX_RADIUS_STAND: 5.5,      // m
  PROX_RADIUS_CROUCH: 3.5,     // m
  PROX_FILL_MIN_PER_S: 38,
  PROX_FILL_MAX_PER_S: 85,
  // Acoustic gunshot sensing (instant gauge impulse)
  GUNSHOT_IMPULSE_MIN: 25,
  GUNSHOT_IMPULSE_MAX: 75,
  // Decay while unseen
  DECAY_HOLD_S: 1.0,
  DECAY_PER_S: 14,
  // Escalation timers
  DETECTED_PROPAGATE_DELAY_S: 1.6,
  DETECTED_PROPAGATE_RADIUS: 22.0,
  DETECTED_TO_COMBAT_S: 3.5,
  COMBAT_GLOBAL_DELAY_S: 2.2,
  // De-escalation (Shared Last Known Position search)
  SEARCH_ARRIVE_DIST: 8.0,
  SEARCH_GIVE_UP_S: 4.5,
  DEESCALATE_ALERT_GAUGE: 65,
  // Suppressive fire when no LOS
  SUPPRESS_SPREAD_DEG: 8.0,
  SUPPRESS_CD_MULT: 1.35,
} as const;
```

#### C. Detailed Behavioral Rules (Every Bullet Point Verified)
1. **Individual Vision Cone & Alert Gauge (`0..100`)**:
   - Each enemy stores `alertState: AlertState`, `alertGauge: number`, `alertHoldTimer: number`, `detectedTimer: number`, `hasPlayerLos: boolean`, `investigatePos: THREE.Vector3`.
   - Vision check passes if `d <= visionRange`, horizontal angle between enemy forward vector and direction to player `<= fovHalfRad` (Drone uses 360° downward cone), and raycast LOS is unobstructed.
   - When vision check passes:
     - If `UNAWARE`, immediately enter `ALERT`.
     - Fill rate: `fill = clamp(18 + 95 * Math.pow(1 - d / visionRange, 1.6), 18, 115) * crouchMult * shadowStepMult`.
     - Increment `alertGauge = Math.min(100, alertGauge + fill * dt)`, reset `alertHoldTimer = AI_STEALTH.DECAY_HOLD_S`, update `investigatePos`.
2. **Proximity & Acoustic Triggers**:
   - **Proximity (even outside FOV)**: If `d <= (playerCrouching ? 3.5 : 5.5)` and unobstructed (not through solid wall), enter `ALERT` and add `lerp(38, 85, 1 - d / proxRadius) * shadowStepMult * dt` to `alertGauge`, setting `investigatePos` to player pos.
   - **Gunshots**: Expose `enemyManager.onPlayerGunshot(origin, soundRadius)` called from `EquipmentManager` on fire (`14 m` Pistol, `58 m` Sniper). For every living enemy within `d <= soundRadius` (in `UNAWARE` or `ALERT`), compute `t = 1 - d / soundRadius`, add `lerp(25, 75, t)` to `alertGauge`, set `investigatePos = origin`, and transition `UNAWARE -> ALERT` (or `-> DETECTED` if `alertGauge >= 100`).
3. **Decay in `ALERT`**:
   - If player is NOT in vision cone and NOT within proximity radius, decrement `alertHoldTimer`; once `<= 0`, decrement `alertGauge -= 14 * dt`.
   - When `alertGauge <= 0`, enemy returns to `UNAWARE` and resumes its patrol route.
4. **Escalation to `DETECTED` & Local Spread**:
   - When `alertGauge >= 100`, transition `ALERT -> DETECTED`, set `detectedTimer = 0`, set `sharedLastKnownPos` to player position, set `hasSharedLastKnown = true`, play `DETECTED` audio sting.
   - While in `DETECTED`, increment `detectedTimer += dt`.
   - Once `detectedTimer >= 1.6 s`, promote any `UNAWARE`/`ALERT` ally within `22.0 m` to `DETECTED` (setting their `alertGauge = 100`, `detectedTimer = 0`).
5. **Escalation to `COMBAT` & Sector-Wide Broadcast**:
   - Triggered for an enemy if:
     - `detectedTimer >= 3.5 s` in `DETECTED`, OR
     - **The enemy takes ANY damage from the player** (in ANY state: `UNAWARE`, `ALERT`, or `DETECTED`! Also immediately updates `sharedLastKnownPos` to the player's current position).
   - Maintain a sector-wide `combatBroadcastTimer`: while any enemy is in `COMBAT` and at least one enemy is not yet in `COMBAT`, accumulate `combatBroadcastTimer += dt`. Once `combatBroadcastTimer >= 2.2 s`, promote **ALL living enemies in the sector** to `COMBAT` and play the tactical radio alarm cue!
6. **Attacking Rules (`DETECTED` & `COMBAT` ONLY)**:
   - Enemies in `UNAWARE` and `ALERT` **NEVER** fire or show telegraph lines.
   - Enemies in `DETECTED` and `COMBAT` attack using the 3-phase telegraph system:
     - **With LOS (`hasPlayerLos === true`)**: Continuously update `sharedLastKnownPos` to player's exact position and aim/fire directly at the player as normal.
     - **Without LOS (`hasPlayerLos === false`)**: Advance/reposition toward `sharedLastKnownPos`. If the enemy has a clear sightline to `sharedLastKnownPos` (or a corner point near it within `45 m`), fire **rough suppressive bursts** aimed at `sharedLastKnownPos` plus random angular scatter (`±8°` yaw / `±4°` pitch, `1.35x` fire cooldown) so tracer fire visibly rakes the player's last known cover without cheating with wallhacks!
7. **Shared Last Known Position Search & Global De-escalation Back to `ALERT`**:
   - Track `anyEnemyHasLos = enemies.some(e => e.alive && (e.alertState === 'DETECTED' || e.alertState === 'COMBAT') && e.hasPlayerLos)`.
   - If `anyEnemyHasLos` is `true`, reset `searchClearTimer = 0` and `sharedLastKnownPos.copy(playerPos)`.
   - If `anyEnemyHasLos` is `false` AND at least one enemy in `DETECTED`/`COMBAT` is inspecting `sharedLastKnownPos` (distance to `sharedLastKnownPos <= 8.0 m` AND clear LOS from that enemy's eye to `sharedLastKnownPos`, confirming the player is not there — or a reasonable fallback if `sharedLastKnownPos` is an unreachable rooftop point and the closest searching enemy has waited near its projection for `6.0 s` without LOS):
     - Accumulate `searchClearTimer += dt`.
     - Once `searchClearTimer >= 4.5 s`, **revert ALL living enemies in `DETECTED` or `COMBAT` to `ALERT`** (set `alertGauge = 65`, `alertHoldTimer = 2.0`, `detectedTimer = 0`, `combatBroadcastTimer = 0`, `searchClearTimer = 0`, cancel active telegraphs)!
     - From `ALERT`, if the player stays hidden, their gauges decay naturally back to `0` → `UNAWARE`.
8. **Diegetic Visuals, HUD & Audio Feedback**:
   - **Enemy Visor & Fresnel Rim Color**: Dynamically reflects `alertState`:
     - `UNAWARE`: `#2A7A99` (dim cool cyan, emissive `1.2`)
     - `ALERT`: `#FFCC22` (amber yellow, emissive `2.8`)
     - `DETECTED`: `#FF6A1A` (bright orange pulsing, emissive `3.8`)
     - `COMBAT`: `#FF2244` (deep crimson, emissive `4.2`)
   - **Overhead Minimal State Indicator**: Reusable pooled canvas/sprite or tiny billboarded geometry (`InstancedMesh` or small DOM/HUD projected markers, zero per-frame allocations) above enemies in `ALERT` (thin amber progress bar showing `0..100%`), `DETECTED` (orange `!`), or `COMBAT` (small crimson chevron). Hidden when `UNAWARE`.
   - **HUD Directional Awareness Arcs (`HudManager.ts`)**: Around reticle (`radius 78 px`), show up to 4 subtle directional arcs pointing toward enemies actively filling Alert Gauge (amber fill proportional to gauge) or locking/detecting you (orange/crimson flash).
   - **Top-Center District Status Tag**: Compact badge beside `SECTOR XX // REMAINING: YY` displaying `STEALTH` (cool cyan), `ALERT` (amber), `DETECTED` (orange), or `COMBAT` (crimson).
   - **Stealth Kill Bonus**: Killing an `UNAWARE` or `ALERT` enemy awards `+120` FLOW bonus (`STEALTH KILL` / `STEALTH HS`).
   - **Adaptive BGM Stealth Ducking (`AudioEngine.ts`)**: When highest enemy state is `UNAWARE` or `ALERT`, smoothly duck BGM to Layer 1 + quiet filtered tension pulse; erupt smoothly to full FLOW layers when `DETECTED`/`COMBAT` begins.

---

## PHASE 8B — Gritty Cyberpunk City Overhaul (Alley Clutter, Graffiti, Wall Pipes, Steaming Manholes & Dense Neon)

**Goal**: Transform the streets, narrow alleys, underpasses, and building flanks from "clean wet concrete" into a **gritty, lived-in, rain-stained cyberpunk metropolis** while keeping total draw calls **`<= 120 calls / frame`** (strictly verify!).

### 8B-1. Alley & Sidewalk Micro-Clutter Kit (`src/world/CityBuilder.ts`)
Place natural **clutter clusters** tucked along narrow alley walls, behind buildings, beneath elevated highway piers, beside vending machines, and along sidewalk curbs. **Placement Safety Rule**: Keep a `>= 2.6 m` unobstructed walkable center lane through every narrow alley and keep all main road driving lanes and wall-run strips clear of collision snags. Small clutter props are non-blocking decorative meshes (or grouped simple AABB only for heavy dumpsters/barriers so players never snag on cardboard boxes!).

Implement via **2–3 `InstancedMesh` batches** (total `+3` to `+5` draw calls max, using per-instance vertex color / tint):
1. **Cardboard Box Piles** (`cap: 260`): Slightly tilted stacked corrugated boxes (warm faded brown/tan/wet-dark tones `#5A4634`–`#3C2E22` with taped seam crease texture or beveled multi-box merged cluster geometry).
2. **Trash Cans, Garbage Bags & Heavy Metal Dumpsters** (`cap: 180` bins/bags + `cap: 65` dumpsters):
   - Cylindrical street trash bins with slumped glossy black garbage bags clustered at the base.
   - Heavy angled-lid industrial metal dumpsters (weathered dark green `#1F3329`, rust `#4A2B20`, charcoal `#222730`) placed along alley walls and back doors (dumpsters register low AABB colliders `~1.8m × 1.15m × 1.1m` that work as crouch cover & jump stepping stones!).
3. **Weathered Benches & Urban Scrap / Barriers** (`cap: 110` benches + `cap: 180` scrap/barriers):
   - Slatted dark-metal/stained-wood street benches along sidewalks, plazas, and canal promenades.
   - Scrap clusters: wooden pallets, dented industrial oil drums, concrete jersey barriers with faded yellow/black hazard stripes, and reflective orange traffic cones near highway piers and alley entrances.

### 8B-2. Wall Graffiti & Torn Street Posters (`src/engine/ProceduralTextures.ts`, `src/world/CityBuilder.ts`)
* **Procedural 4×2 Canvas Atlas (`1024 × 512`, 8 unique designs with alpha mask)**:
  - Cells 0–3: **Cyberpunk Graffiti Tags & Stencils** — wildstyle neon-cyan/magenta/acid-lime/orange spray strokes, drips, stencil skulls/circuit glyphs, stylized katakana/cyber tags (`STRAND`, `NO SIGNAL`, `ZERO`, `09`).
  - Cells 4–7: **Weathered & Torn Posters / Caution Markings** — rain-stained corporate/cyber ad flyers with ripped diagonal corners, faded warning stencils (`RESTRICTED`, `HIGH VOLTAGE`, `ZONE 04`), and grimy drip streaks.
* **Single `InstancedMesh` Decal Batch (`cap: 320`, `1 draw call`)**:
  - Custom `onBeforeCompile` or `InstancedBufferAttribute` (`aUvOffset` `vec2`) selecting one of the 8 atlas cells per instance, rendered with `transparent: true`, `depthWrite: false`, `polygonOffset: true`, `polygonOffsetFactor: -2` at `+0.035 m` normal offset.
  - Placed heavily across **1F opaque shutters/concrete walls, narrow alley lower walls (`Y = 0.6–3.8 m`), elevated highway support pillars, and dumpster sides**.

### 8B-3. Heavy Building-Side Exposed Piping & Conduits (`src/world/CityBuilder.ts`)
* **Zero Extra Draw Calls**: Merge all new building-side industrial infrastructure directly into the existing merged building metal/dark geometry buffers (`G.steel` / `G.dark`)!
* **Architectural Additions across All 4 Building Archetypes (especially narrow-alley faces)**:
  - **Multi-Pipe Vertical Bundles**: 2- or 3-pipe parallel vertical runs (`radius 0.08–0.16 m`) bolted to building flanks from `Y = 0.4 m` up to `12–28 m`, punctuated by periodic horizontal **collar clamps** every `3.5 m` and **90° elbow joints** turning into the wall.
  - **Horizontal Utility Conduits & Junction Boxes**: Cross-facade conduit pipes at `Y = 3.8–4.5 m` (above 1F storefronts), wall-mounted steel electrical junction boxes with tiny glowing amber/red status indicator dots, and heavy recessed exhaust louvers.
  - **Dense Low-Alley Hanging Cables**: Increase sagged overhead utility cables across narrow alleys (`Y = 5.5–14 m`) with small insulator brackets so looking up in alleys frames layered wires + neon signs.

### 8B-4. Glowing Iron Manholes & Anchored Rising Steam Plumes (`src/engine/ProceduralTextures.ts`, `src/world/CityBuilder.ts`)
* **Physical Iron Manhole Grates (`InstancedMesh`, `cap: 55`, `1 draw call`)**:
  - Procedural cast-iron circular/square-framed grate texture (dark iron bars + recessed dark vent holes with subtle warm-amber `#FF7828` or toxic-cyan `#1CE8FF` subterranean under-glow glowing faintly through the slots).
  - Placed flush on streets (`Y = 0.015 m`) near curbs, intersections, and narrow alley centers.
* **Anchored Steam Plumes**:
  - Re-anchor the existing `this.steam` billboard/particle system so **steam emitters spawn directly above the physical manhole locations** (and select building exhaust vents), rising as concentrated, drifting backlit vertical steam columns (`2.5–6.0 m` tall) illuminated softly by nearby neon/streetlights—instead of generic unanchored floating haze!

### 8B-5. High-Density Layered Neon Signage & Alley Awnings (`src/world/CityBuilder.ts`)
* **Double+ Neon Density (`CAP.NEON: 420 -> 960`, 0 extra draw calls — same `InstancedMesh`)**:
  - Heavily saturate narrow alleys and 1F–5F street facades (`Y = 3.5–22 m`) with:
    - **Protruding perpendicular vertical blade signs** jutting `1.2–2.8 m` out into alleys at staggered heights.
    - **Overhead cross-alley horizontal neon bars & sign bridges** spanning between opposing alley buildings (`Y = 6.5–13 m`).
    - Rich mixed palette: electric cyan, hot magenta, acid amber, deep coral red, and occasional flickering/half-dead neon tubes for authentic urban decay!
* **Grimy Translucent Alley Awnings** (merged or `1 InstancedMesh`, `cap: 120`):
  - Slanted corrugated plastic/metal shop canopies overhanging 1F storefronts (`Y = 3.2–3.8 m`) in narrow alleys, catching neon glow from above and adding strong ground-level cyberpunk silhouette framing.

### 8B-6. Road & Alley Surface Grime + Oil-Slick Iridescence (`src/engine/ProceduralTextures.ts`, `src/world/CityBuilder.ts`)
* Enhance the wet road procedural roughness/albedo maps and shader (`onBeforeCompile`) with:
  - **Gutter & Alley Grime Streaks**: Darker stained patches along curb edges, around manholes, and in narrow alleys.
  - **Subtle Oil-Slick Thin-Film Iridescence**: Around wet puddles and manholes, add a low-intensity view-angle-dependent rainbow oil-sheen (`0.08–0.14` subtle specular tint — never cartoonish!) so glancing down wet alleys feels richly textured and dirty.

---

## Draw-Call Budget Audit (`<= 120 calls / frame`)
Verify total render calls remain strictly `<= 120` in all 5 sectors (including Sector 4 with maximum building/neon/clutter count):
* Phase 7B baseline: ~`82–96 calls / frame`.
* Phase 8B net additions:
  - Alley clutter batches (cardboard, trash/dumpsters, benches/scrap): `+3` to `+4` calls (`InstancedMesh`)
  - Wall graffiti & torn poster decals (4×2 atlas): `+1` call (`InstancedMesh`)
  - Cast-iron glowing manholes: `+1` call (`InstancedMesh`)
  - Alley corrugated awnings: `+1` call (`InstancedMesh`, or `0` if merged)
  - Building-side exposed pipe bundles & junction boxes: **`+0` calls** (merged into building steel)
  - Neon sign density boost (`420 -> 960`): **`+0` calls** (same `InstancedMesh`)
  - Overhead AI state indicator batch: `+1` call (or DOM/Canvas HUD overlay `+0` WebGL calls)
* **Projected Total**: ~`90–104 calls / frame` — safely within `<= 120` headroom!

---

## Verification Checklist (Run Before Reporting Done)
1. **Build & Tests**: `npm run build` succeeds with zero TypeScript errors; update & pass all unit tests for the new 2-gun + Grapple roster, single-shot Sniper reload, non-piercing shield break, reworked `SK_07`/`SK_09`, and 4-state Stealth AI transitions.
2. **Phase 8A Functional Checks**:
   - Wall-run left tilts camera clockwise (away from left wall); wall-run right tilts counter-clockwise (away from right wall).
   - Crouch visibly lowers eye height to `0.78 m` (clearly behind cars & dumpsters); slide drops to `0.68 m`.
   - Only `[1] PISTOL`, `[2] SNIPER`, `[3/Q] GRAPPLE` exist; zero leftover SMG/Shotgun UI/keybinds.
   - Pistol & Sniper both have the exact old SMG open holo hood size (`0.046 × 0.037 × 0.042`); Pistol sight stays rock-steady during recoil.
   - Sniper ADS zooms to true 4x (`~24.2°` at `84°` base FOV) with lower precision mouse sensitivity (`0.20x`); Pistol ADS sensitivity is `0.55x`.
   - Sniper fires 1 shot → auto-reloads with 2-hand breech animation; 1 shot destroys an Aegis shield WITHOUT damaging the Aegis behind it; with `SK_09`, breaking a shield/wing immediately refills `1/1`.
   - 4-State AI verified end-to-end: enemies patrol `UNAWARE` → FOV / close proximity / gunshot fills `ALERT` gauge (closer = faster; unseen decays to `0` → `UNAWARE`) → gauge `100` enters `DETECTED` & fires → after `1.6 s` nearby allies (`22 m`) enter `DETECTED` → after `3.5 s` or taking damage enters `COMBAT` → after `2.2 s` ALL enemies enter `COMBAT` → enemies fire directly with LOS and suppressively toward `sharedLastKnownPos` without LOS → after inspecting `sharedLastKnownPos` with 0 enemies seeing player for `4.5 s`, ALL enemies revert to `ALERT`.
   - Sector 5 Boss `VALKYRIE-09` starts immediately in `COMBAT`.
3. **Phase 8B Visual & Performance Checks**:
   - Narrow alleys visibly packed with cardboard boxes, dumpsters/trash cans, benches, scrap/barriers, wall graffiti/posters, corrugated awnings, overhanging neon signs, and building-side pipe bundles.
   - Physical iron manholes sit flush on streets/alleys with subtle subterranean glow and anchored rising steam columns.
   - Wet streets show subtle grime & oil-slick sheen near gutters/manholes.
   - `renderer.info.render.calls <= 120` verified in Sector 4 at full density with zero console warnings or per-frame GC spikes.
