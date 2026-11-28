# STRAND // PROTOCOL — Phase 12A Audit-Fix Specification (12A-Fix)

**Audited commit**: `9d5ac3e` (Phase 12A) on `claude/loving-bohr-lb0uj2`
**Verdict**: `FAIL` — 1 MUST-FIX (Priority #1 visual), 1 SHOULD-FIX (folded in, low risk)
**Spec review**: revised after an independent adversarial review (3 MUST-FIX + 9 SHOULD-FIX findings applied; the §A2 GLSL was compile-verified in headless Chrome / SwiftShader against the real road material)
**Budget**: `+0` draw calls, `+0` passes, `+0` textures. Zero per-frame allocations. Sector 4 HIGH stays at the 12A level (spawn preview 70–71 calls).
**Execution**: small patch spec — NO parallel fan-out. Run `/implement-spec PHASE12A_AUDIT_FIX_SPEC.md` on `claude/loving-bohr-lb0uj2`.

Everything else in 12A was audited clean (see §5) — do not touch it.

---

## 1. Evidence (director audit, real SwiftShader WebGL renders, 1280×720, rain hidden)

The 12A-2 Mega-Billboard "ribbons" render as **wide flat colour sheets** clipped by the puddle roughness mask, not as screen-width vertical streaks. Each measurement below renders the same frame twice, with `city.uMegaReflEnabled.value` = 0 and then = 1:

| View (camera → lookAt, world m) | Pixels brightened > 8/255 | Frame mean Δ | Horizontal span of the brightened pixels |
| :--- | :---: | :---: | :---: |
| S4 `(-41.55, 1.7, 31.4) → (-41.55, 5.05, 47.4)` (under the expressway) | **17.8 %** | **+8.9** | **81 % of frame width** |
| S3 `(35.9, 1.7, 65.55) → (57.9, 4.99, 65.55)` | 5.8 % | +1.95 | 33 % |
| S3 `(63.9, 1.7, 37.4) → (63.9, 4.99, 59.4)` | 0.6 % | +0.14 | 50 % |
| S1 `(39.4, 1.7, 65.55) → (61.4, 8.3, 65.55)` | 0.4 % | +0.08 | 10 % |

What it looks like: in the S4 view the wet asphalt under the deck is filled edge to edge with a uniform cyan sheet with hard, puddle-shaped borders. In the S3 view the whole intersection turns lime green. Neither reads as a reflection of a rectangular screen.

**Root cause** (in the spec formula, implemented faithfully, then made worse by a tuning change) — `CityBuilder.ts` `createRoadMaterial()` → `const megaRefl` (~L2138–2168):
1. `alignY = dot(normalize(sR.x, sR.y·0.35, sR.z), normalize(L.x, L.y·0.35, L.z))` followed by `pow(alignY, spread · mix(1.2, 0.45, r))`. For a large screen (`w/2 ≥ 8 m` → `spread = 10`) the exponent is ≈ 7–11, so the lobe's half-maximum is ≈ ±20–25°. That is roughly **twice the angular width of a 16 m screen seen from 40 m (±11°)**. The 0.35 vertical squash then makes almost every elevation line up, so the lobe also covers the whole depth of the road.
2. `MEGA_REFL.INTENSITY` was raised from the spec's 1.5 to 3.0 ("lead tune"), which turns the broad lobe into a saturated sheet.
3. Each L-corner group (all records sharing one `group`; set once per screen at `const g = ++signGroup;` ~L5745) is merged into ONE slot with an averaged diagonal normal and a half-width that spans both arms (`buildSector`, ~L9006–9061). There is no physical plane for a rectangle test, and the merged entry is two-sided.
   - **Note:** a CORNER group is **2 arms × n stacked tiers (n = 2..4)**, so it has 4–8 records (`for (let k = 0; k < n; k++) … for (const q of geo) addMegaBillboard({ kind: 'CORNER', … group: g })`, ~L5780-5786). The tiers of one arm share `x`, `z`, `w`, `nx` and `nz` exactly; only `y` differs.

---

## 2. MUST-FIX A — Analytic screen-rectangle wet reflections (`src/world/CityBuilder.ts` only)

### A1. Pool: one entry per physical planar screen (`buildSector`, ~L9006–9063)
Replace the diagonal group merge with **one pool entry per planar screen**. Only records with `r.kind !== 'RING' && r.y <= MEGA_REFL.MAX_Y_M` are eligible (checked per record).
- **AVENUE / PERIMETER / BLADE**: one entry per record.
  - `megaPos = (r.x, r.y, r.z)`
  - `megaSize = (r.w / 2, r.h / 2)`
  - `megaNrm = (r.nx, r.nz, r.kind === 'BLADE' ? 1 : 0)`
  - colour as today
  - `megaSrcIdx = i`
- **CORNER**: one entry per **(group, arm)**. The eligible records with the same `group` AND the same `(nx, nz)` are the stacked tiers of one arm; they share `x`, `z` and `w` exactly. Merge the tiers vertically:
  - `yMin = min(r.y − r.h/2)` and `yMax = max(r.y + r.h/2)` over the **eligible** tiers only
  - `megaPos = (r.x, (yMin + yMax) / 2, r.z)`
  - `megaSize = (r.w / 2, (yMax − yMin) / 2)`
  - `megaNrm = (r.nx, r.nz, 0)` (one-sided)
  - colour from the first eligible tier
  - `megaSrcIdx` = the index of the **lowest** eligible tier (smallest `r.y`)
  - The ~1 m gaps between tiers are bridged; this is invisible under the wet blur.
  - Result: a CORNER group occupies **at most 2 pool entries (2 slots)**, and the two have different normals.
- Allocation: build-time only (a small `Map<string, number>` keyed by `` `${group}:${nx}:${nz}` `` is fine inside `buildSector`). Delete the old `megaGroupSlot`, `megaArea`, diagonal-normal accumulation, and the second extent pass. The "two-sided L-corner" rule goes away.
- **Update the stale comments**: the pool comment ("Audit fix: pieces sharing a `group` … are ONE screen", ~L9007-9009) and the `megaRefl` sMegaH comment that mentions the "0.35 vertical squash" (~L2139-2140).
- Keep `megaSrcIdx`, `megaReflSrc`, `uMegaReflNrm` and the uniform layout:
  - `uMegaReflPos[i] = (centre.xyz, halfW)`
  - `uMegaReflCol[i] = (rgb, halfH)`
  - `uMegaReflNrm[i] = (nx, nz, twoSided, 0)`
- **Normal convention (verified by the reviewer for every record)**: `r.nx/r.nz` is the screen's **outward / viewing-side** unit, axis-aligned normal:
  - AVENUE / PERIMETER via `sf()` / `flatScreen` (~L5176)
  - CORNER via `nx: sx`, `nz: sz` (~L5752)
  - BLADE is perpendicular to its wall and two-sided
  
  Do not flip it. §4.1.2 locks it with a test.
- `update()` selector: leave the logic unchanged (nearest 8 within 90 m, facing or two-sided). It must stay allocation-free.

### A2. Shader: replace the `alignY` / `pow` lobe with a ray → rectangle test
Replace the body of the existing `if (uMegaReflEnabled > 0.5 && uMegaReflCount > 0 && sRibR < 0.42 && sMegaH > 0.0) { … }` block: delete `sRs`, `alignY`, `spread`, `lobe` and the old loop. Keep these unchanged:
- `sMegaH` (the 3 → 8 m camera-height fade)
- `sRibR`, `wetMask`, `sV`
- `sWorldN` (via `transformNormalByInverseViewMatrix(normal, viewMatrix)`)
- `sR`, `fres`
- the final `reflectedLight.indirectSpecular += ribbonSum * wetMask * fres * 0.65;`

**Indentation rule**: paste this GLSL inside the existing template literal indented by **at least 8 spaces** on every line. The test helper `methodSrc` (phase12a.test.ts ~L48) cuts the method source at the first `"\n  }\n"`, so a 2-space `  }` line would truncate it.

```glsl
vec3 ribbonSum = vec3(0.0);
if (sR.y > 0.02) {                                   // only rays leaving the asphalt upward can reach a screen
  // Loop-invariant roughness terms (hoisted).
  float rough = smoothstep(0.14, 0.42, sRibR);
  float softK = mix(0.004, 0.02, rough);
  float upK0 = mix(0.6, 2.4, rough);
  float upK1 = mix(0.02, 0.08, rough);
  for (int i = 0; i < ${MEGA_REFL.MAX}; i++) {
    if (i >= uMegaReflCount) break;
    vec3 toB = uMegaReflPos[i].xyz - vCityWorld;      // fragment → screen centre
    vec2 nB = uMegaReflNrm[i].xy;                     // outward screen normal (xz)
    bool twoSided = uMegaReflNrm[i].z > 0.5;
    if (!twoSided && dot(toB.xz, nB) > 0.0) continue; // fragment behind a one-sided screen
    float dist = length(toB);
    if (dist > 85.0) continue;
    float den = dot(sR.xz, nB);
    if (abs(den) < 1e-3) continue;                    // ray parallel to the screen plane
    float t = dot(toB.xz, nB) / den;                  // path length along sR (unit) to the plane
    if (t <= 0.0) continue;                           // (one-sided: t > 0 after the cull above implies a front-face hit)
    vec3 hp = vCityWorld + sR * t - uMegaReflPos[i].xyz;   // hit point relative to the screen centre
    float u = abs(hp.x * -nB.y + hp.z * nB.x);        // along the screen width (tangent = (-nz, nx))
    float v = hp.y;                                   // along the screen height
    float hw = uMegaReflPos[i].w;
    float hh = uMegaReflCol[i].w;
    // Rough-wet blur: horizontal edges stay tight (the screen width), vertical tolerance grows with
    // roughness and path length. Wet-street streaks run TOWARD THE VIEWER, and nearer asphalt sends
    // steeper rays that pass ABOVE the screen, so the long tolerance sits above the top edge (v > +hh).
    float softU = 0.12 + hw * 0.06 + t * softK;
    float upT   = hh * upK0 + t * upK1;
    float downT = 0.25 + t * 0.01;
    float mU = 1.0 - smoothstep(hw - softU, hw + softU, u);
    float mV = smoothstep(-hh - downT, -hh, v) * (1.0 - smoothstep(hh, hh + upT, v));
    // Streak tail fades with the vertical overshoot (no hard cut at hh + upT).
    float tail = v > hh ? 1.0 - 0.6 * clamp((v - hh) / max(upT, 1e-3), 0.0, 1.0) : 1.0;
    float atten = 1.0 / (1.0 + dist * dist * 0.0018);
    ribbonSum += uMegaReflCol[i].rgb * (mU * mV * tail * atten);
  }
}
```

Notes:
- No `pow`, no `normalize` inside the loop. The cost is about 35–40 ALU per slot, roughly the same as the old 2×normalize + pow loop. The loop bound, `uMegaReflCount` and the early-outs are unchanged.
- Bump the road `customProgramCacheKey` from `'strand-road-v15'` to `'strand-road-v16'`. It is static, so there are no runtime recompiles.
- The ripple and normal-map perturbation already in `normal` jitters `sR`, so streaks break up naturally. Do not add noise.
- `twoSided` (BLADE) screens accept hits from both sides (`den` of either sign).

### A3. Intensity
- Set `MEGA_REFL.INTENSITY` back to **`1.5`** (the original spec value). Fix the doc comment accordingly; remove the "Lead tune 1.5 → 3.0" note.
- If the screenshot gate (§4.3) shows the ribbons are too faint to read, you may raise it as far as `2.0` and no further. Record the final value in the commit message.

---

## 3. SHOULD-FIX B — Subtler sector fog tint (`src/engine/Renderer.ts`)

The 12% sRGB tint toward `palette[0]` lifts the skyline haze a lot. Pre-12A horizon frame means were S1 18.0, S4 15.9 and S3 18.2. At 0.12 they are 24.8, 23.3 and 20.1 (+38% / +47% in S1 / S4), so the towers lose their black-silhouette contrast. Measured sweep (S1 / S4 / S3 horizon mean): tint 0.05 → 20.4 / 18.5 / 18.7; tint 0.07 → 21.5 / 19.8 / 19.1.
- Set `SECTOR_FOG_TINT = 0.06` (Renderer.ts ~L58). One `sectorFogColor()` feeds the PMREM `abyss` (~L746), the scene fog (`setSectorAtmosphere`), the SkyDome `uHorizon`, the blimp `uFogColor` (both alias `uSkyHorizon`) and the height fog (live `fogColor`), so they stay in sync automatically.
- Update the leftover "12 %" text in Renderer.ts (~L61 and ~L915) and in the test comment and message (phase12a.test.ts ~L274-276).
- `tests/phase12a.test.ts` ~L275-277 hard-codes `0.12`. Import `SECTOR_FOG_TINT` from `../src/engine/Renderer` and use it there. The existing distinct-fog assertion (`seen.size === firsts.size`) still holds at 0.06.

---

## 4. Tests & Acceptance Gate

### 4.1 Update `tests/phase12a.test.ts` (keep everything else unchanged)
1. **Selector test** (~L100). Rebuild the `screens()` helper (~L86) to produce exactly the §A1 pool:
   - one entry per AVENUE / PERIMETER / BLADE eligible record;
   - one entry per CORNER (group, arm), with the merged `y` / half-height over the eligible tiers and `idx[0]` = the lowest eligible tier;
   - two-sided rule: `two = r.kind === 'BLADE'` ONLY. The old "merged L-corners are two-sided" rule must go.
   
   Keep the existing count / nearest-8 / 90 m / facing / AD_HUES checks, and replace the slot assertions with:
   - every slot maps to exactly one oracle entry, and `megaReflSrc[k] === entry.idx[0]`;
   - slot position, `uMegaReflPos.w` (half-width) and `uMegaReflCol.w` (half-height) each match the entry within `1e-3`. The pool is `Float32Array`, so never use exact equality;
   - no oracle entry appears twice;
   - each CORNER `group` appears in at most 2 slots, and when it has 2 they have different `(uMegaReflNrm.x, uMegaReflNrm.y)`.
2. **Normal convention**: for every non-BLADE, non-RING record in all 5 sectors × loops 0..2, test with `L.colliders` filtered to `kind === 'BUILDING'` (AABB containment):
   - `(r.x − 2·r.nx, r.y, r.z − 2·r.nz)` IS inside some BUILDING collider;
   - `(r.x + 2·r.nx, r.y, r.z + 2·r.nz)` is NOT.
   
   Use the screen height `r.y`, not ground level. Do **not** use `L.buildings` `halfW/halfD`: that is the ROOF rect of setback towers, and podium screens fall outside it. Screens stand 0.30 m proud of the wall (`standoff`), so any raycast variant needs a max distance ≥ 2.5 m.
3. **Road shader shape**:
   - `createRoadMaterial` source contains `float t = dot(toB.xz, nB) / den;` and `sR.y > 0.02`;
   - it does NOT contain `pow(alignY` or `sR.y * 0.35`;
   - `MEGA_REFL.INTENSITY <= 2.0`.
4. **Pure geometry reference**: export a TS helper from `CityBuilder.ts` so the geometry can be unit-tested.
   - Signature: `megaRibbonMask(frag: THREE.Vector3, rDir: THREE.Vector3, centre: THREE.Vector3, nx: number, nz: number, halfW: number, halfH: number, twoSided: boolean, roughR: number): number`
   - `rDir` is normalized inside the helper.
   - `(nx, nz)` is the 2-D outward normal.
   - `roughR` is the raw `sRibR`; the helper applies `smoothstep(0.14, 0.42, ·)` itself.
   - It must be zero-allocation (module scratch only).
   - It is a line-for-line mirror of the §A2 loop body and returns `mU * mV * tail`, with **no** `wetMask`, `fres`, `atten`, `dist > 85` cut or colour.
   
   Fixed test setup: a screen centred at `(0, 10, 0)` with normal `(nx, nz) = (0, 1)`, `halfW = 8`, `halfH = 6`, one-sided, and `roughR = 0.2`. Assert:
   - (a) fragment `(0, 0, 40)` with the ray aimed at `(0, 10, 0)` → mask ≥ 0.9;
   - (b) fragment `(0, 0, 40)` with the ray aimed at `(halfW + 2 + softU_max, 10, 0)` where `softU_max = 0.12 + 8·0.06 + 41·mix(0.004, 0.02, smoothstep(0.14, 0.42, 0.2))` → mask ≤ 0.02. Any lateral offset of `≥ 3.5 m` beyond `halfW` satisfies this;
   - (c) a ray with `rDir.y ≤ 0.02` → 0;
   - (d) fragment `(0, 0, −40)` (behind the one-sided screen), ray aimed at `(0, 10, 0)` → 0; the same with `twoSided = true` → mask ≥ 0.9;
   - (e) vertical bounds that hold for any t: with the ray aimed at `(0, 10 + halfH + 0.1·halfH, 0)` the mask is strictly between 0 and 1 (because `upT ≥ 0.6·halfH`); with the ray aimed at `(0, 10 − halfH − 3, 0)` and `t ≤ 100 m` the mask is 0 (because `downT ≤ 1.25`).
5. Fog: as §3 (use the constant).

### 4.2 Gates
- `npm run build` and `npm test` pass 100% (baseline 131, plus the new tests).
- Draw calls are unchanged (Sector 4 HIGH spawn preview 70–71). No new uniforms or textures.
- `update()` stays allocation-free (the existing regex test).

### 4.3 Mandatory screenshot gate (strand-auditor + lead)
Use real SwiftShader WebGL (`--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist --no-sandbox`). Build the sector via `window.__STRAND_DEBUG__.app.buildSector(s)`, set HIGH, and hide `app.effects.rain` (`visible = false`) so frames are comparable. Render each §1 view twice, with `app.city.uMegaReflEnabled.value` = 0 and then = 1, in the same page state:
- **S4 view must drop to ≤ 6 % brightened pixels (> 8/255) and frame mean Δ ≤ +3.0**. Every other §1 view: ≤ 6 % and ≤ +2.0.
- **Visual**: each visible ribbon is a vertical streak no wider than the screen's own on-screen width (plus soft edges), lying on the line under its screen and running toward the camera. No edge-to-edge colour sheets.
- Also capture S1 / S4 / S3 horizon views (camera `(spawn.x, 140, spawn.z)` → `(spawn.x + 100, 128, spawn.z + 30)`, rain hidden). Use these **absolute** frame-mean limits (the pre-12A means + 3.5): **S1 ≤ 21.5, S4 ≤ 19.4, S3 ≤ 21.7**.
  - Capture before/after at the same `simTime`, outside any lightning window (`__STRAND_DEBUG__.cityFx.lightningAt` is deterministic).
  - The S4 margin is thin (≈ 19.15 expected at 0.06). If S4 misses, use `SECTOR_FOG_TINT = 0.05`.
- Toggle `uMegaReflEnabled` AFTER any `setQuality` call, because `setQuality('HIGH')` re-sets it.
- Inspect every PNG with the Read tool. Keep scripts and PNGs out of git.

---

## 5. Audited clean in `9d5ac3e` (do NOT modify)
- **12A-1 per-sector PMREM**: one bake per sector change, persistent generator, previous target disposed.
- **12A-3 vehicleDetail**: 512² DataTextures with mipmaps, `normalMap === null`, no aliasing or "brickwork" at 2.5–4 m, cars visually clean.
- **12A-3 strandInterior** profiles and fwidth-AA glass streaks.
- **12A-4 RCAS**: no ringing; ON/OFF mean Δ < 1/255.
- **12A-4 anamorphic gating**, sharpen setting persistence, `SHADOW_FRUSTUM_HALF = 30`.
- **Phase 13 `applyStrandMaterialHooks`**: chaining, cache key, WeakSet guard.
- Draw calls identical to pre-12A in all 21 compared views (+0). 0 shader-compile errors. No CJK.
- **Pre-existing (NOT 12A, do not fix here)**: the S3 lime CORNER billboard blooms the whole frame in HIGH (frame mean 83 before and after 12A). Tracked for a later bloom/emissive pass.
