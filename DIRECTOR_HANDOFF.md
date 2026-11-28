# STRAND // PROTOCOL — Director Session Handoff

**Last Updated**: 2026-11-27  
**Repository**: `haruyashimadajp/3D-action` (`strand-protocol/`)  
**Active Branch**: `claude/loving-bohr-lb0uj2`  
**Latest Implementation Commit**: `32ea79c` — *Phase 11B: destructible street + interior props, material-matched debris, RoofMechKit (-1 call)* (**NOT YET AUDITED**)

---

## 1. Immediate Next Task (Start Here!)

Claude has just finished implementing and pushing **Phase 11B (`32ea79c`)**.  
**Do NOT skip auditing it.** Your very first task in the new session is:

1. Load the **`strand-director`** skill (`lookup_skill`).
2. **Audit Phase 11B (`32ea79c`)** thoroughly:
   - Run `npm run build && npm test` in `strand-protocol/` (verify all prior 116 tests + `props.test.ts` + new `tests/phase11b.test.ts` pass).
   - Inspect the `git show 32ea79c` diffs (`CityPropMeshes.ts`, `AudioEngine.ts`, `DestructibleManager.ts`, `CityBuilder.ts`, `EffectsPool.ts`, `main.ts`, `tests/phase11b.test.ts`).
   - Run an independent quantitative Node audit script (in your scratch dir, NOT in git) across **all 5 sectors × Loops `0..2` (15 districts)**:
     - Verify `CityPropMeshes` stayed strictly at **10 kits** (`props.test.ts` green).
     - Verify **`RoofMechKit`** consolidated `acUnits` + `ducts` (**`-1` draw call**, Sector 4 HIGH preview `~67–70`, full combat `~87 <= 120` ceiling).
     - Verify breaking shadowed props (`BOXES`, `DRUMS`, `PALLETS`) zeroes BOTH `instanceMatrix` AND `PropContactShadows` (`shadowIndex >= 0`), and breaking unshadowed props (`POT_PLANT`, `AFRAME`) & `InteriorPropsKit` (`v0, v2, v3, v4, v5, v7`) zeroes `instanceMatrix` cleanly (`shadowIndex === -1`).
     - Verify indestructible cover (`DUMPSTER`, `DUMPSTER_OPEN`, `BENCH`, `JERSEY`) ignores damage.
     - Verify swept projectile `raycastProp()` passes through 1-HP light props (Bullet-Time accurate), 2-HP bins/drums take 2 pistol / 1 sniper, slide/sprint break works with zero slowdown, and `onPlayerGunshot` fires at the **broken prop's coordinates** (stealth distraction).
     - Verify zero per-frame heap allocations & late `consumeLook()` untouched.
   - Capture & visually inspect **real headless Chrome WebGL screenshots** (`view_file`) using the proven SwiftShader recipe in §5:
     1. **Rooftop `RoofMechKit` close-up**: AC units retain machinery PBR textures; ducts retain dark metallic steel + exact X-axis length scaling (no squashing, floating, or missing textures).
     2. **Street & Interior prop destruction before/after**: broken props vanish cleanly WITH zero ghost contact shadows left behind, and tumbling debris chunks + cyan/amber digital scanline dissolve edge (`aDissolve`) render crisply.
3. Deliver the audit verdict to the user in **Japanese**:
   - **If `VERDICT: PASS`**: immediately provide the copy-pasteable English Claude prompt for **Phase 12A** (`PHASE12_AAA_RENDER_CINEMA_PLAN.md`, 3-parallel `strand-worker` fan-out, recommended **Opus 4.6 / Effort `high`**).
   - **If any `Must-Fix` is found**: draft `PHASE11B_AUDIT_FIX_SPEC.md`, run the **mandatory independent `research` subagent adversarial review** (`Role: "Adversarial Spec Reviewer"`), fix all valid findings, commit & push, and provide the English Claude fix prompt (`/implement-spec PHASE11B_AUDIT_FIX_SPEC.md`).

---

## 2. Progress Snapshot & Remaining Roadmap

| Phase | Status | Commit | Notes |
| :--- | :---: | :---: | :--- |
| Phases 1–10C + 10BC-Fix | **PASS** | `df80225` (spec upgrade) | All AAA specs upgraded (`10D`, `11A/B`, `12A/B`) + Phase 13 `.glb` contract (`HERO_3D_MODELING_SPEC.md` §7) |
| Phase 10D + 10D-Fix | **PASS** | `d8fb7d9` → `6d8559e` | 110/110 tests, grounded ramen cart open-frame rail, machine-floor fans, alley `BAY` noren (wall-run pillar preserved), highway traffic-lane enemy clearance |
| Phase 11A | **PASS** | `394d8fb` | 116/116 tests, 135 enterable rooms across 15 districts, 194/194 walkable doors, 0 blocked `LEDGE` anchors, dry interior shader mask (`GLSL_INDOOR`), 10 screenshots verified clean (`68–71` preview calls) |
| **Phase 11B** | **PENDING AUDIT** | **`32ea79c`** | **Audit FIRST in next session!** Destructible street & interior props, 6-material SE, debris dissolve, `RoofMechKit` (`-1` call) |
| **Phase 12A** | Ready (spec pushed) | `PHASE12_AAA_RENDER_CINEMA_PLAN.md` | 3-parallel `strand-worker` fan-out (PMREM IBL + `applyStrandMaterialHooks` for `.glb`, volumetric fog/god-rays, micro-normal wet reflections, etc.) |
| **Phase 12B** | Ready (spec pushed) | `PHASE12_AAA_RENDER_CINEMA_PLAN.md` | 3-parallel `strand-worker` fan-out (enemy armor destruction, procedural weapon motion, indoor ViewModel drying, spatial acoustics, cinematics) |
| **Phase 13 (User in Blender)** | Planned | `HERO_3D_MODELING_SPEC.md` §7 | After 12B, user will rebuild hero 3D models in Blender. **Option A** is locked: keep full AAA quality through 12B + preserve canonical pivots/sockets + `applyStrandMaterialHooks` in 12A |

---

## 3. Core User Preferences & Hard Rules (NEVER Violate)

1. **Priority #1 — Screenshot Visual Quality**: Grounded silhouettes (`|min.y| <= 0.02`), zero floating/buried/inverted/z-fighting geometry, 100% English in-world signage, `HERO_3D_MODELING_SPEC.md` §6 & §7 compliance. Always verify with real WebGL screenshots (`view_file`), never trust unit tests alone!
2. **Priority #2 — 60 FPS & Ultra-Low Mouse Latency**: Sector 4 HIGH full-combat `renderer.info.render.calls <= 120` (target trajectory: `11B ~87` → `12A ~87` → `12B ~87`), zero per-frame heap allocations, preserve late pre-render `consumeLook()`, half-res Bloom, `MSAA <= 2` (`0` in `lowLatency`), `<= 2.2M px` DPR cap, `CITY_LIGHTS_MAX <= 12`.
3. **Mandatory Anti-Bias Spec Review**: NEVER finalize/push any new or revised design/fix spec without invoking a fresh-context `research` subagent (`Role: "Adversarial Spec Reviewer"`) to verify every file path, line number, math/coordinate convention, draw-call impact, and test compatibility against the live codebase. Fix every valid `MUST-FIX` / `SHOULD-FIX` before pushing.
4. **Wall-Run Pillar**: Every tower must retain `>= 2` clean, unobstructed wall-run faces (`runFaces` / `runKeys`). Never place protruding noren, pods, or carved openings on protected wall-run faces.
5. **Parallel Claude Execution**: `.claude/agents/strand-worker.md` and `.claude/skills/implement-spec/SKILL.md` automatically run disjoint-file parallel `strand-worker` fan-out whenever a spec has a `Parallel Execution Plan` table. Both `PHASE12_AAA_RENDER_CINEMA_PLAN.md` (12A & 12B) already have verified 3-way parallel tables! Always remind Claude to run any **Pre-Fan-Out** shared-type step first and recommend **Opus 4.6 / Effort `high`**.
6. **Language Convention**: Chat with the user in **Japanese**; write all design specs and Claude prompts in **English** (saves Claude tokens).

---

## 4. Key Files Reference

- Director Skill: `strand-director` (load via `lookup_skill`)
- Active Specs:
  - `PHASE11_INTERIORS_DESTRUCTION_PLAN.md` (Phase 11A + 11B spec & tests)
  - `PHASE12_AAA_RENDER_CINEMA_PLAN.md` (Phase 12A + 12B spec, 3-way parallel tables, `applyStrandMaterialHooks` contract)
  - `HERO_3D_MODELING_SPEC.md` (§4–§6 hero standards + §7 Phase 13 Blender `.glb` swap contract)
- Claude Parallel Infrastructure:
  - `.claude/agents/strand-worker.md`
  - `.claude/skills/implement-spec/SKILL.md`
  - `CLAUDE.md`

---

## 5. Proven Headless Chrome WebGL Screenshot Recipe (SwiftShader)

Playwright's default `raf`-based `wait_for_function` times out under software WebGL (3–4 s/frame). Always use this proven pattern:

1. Start Vite preview as a daemon (`IsDaemon: true`, **kill via `manage_task` after capturing!**):
   ```bash
   npx vite preview --port 4175 --host 127.0.0.1 --strictPort
   ```
2. Launch `/usr/bin/google-chrome` in Python Playwright with:
   ```python
   args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox', '--disable-dev-shm-usage']
   ```
3. Navigate to `http://127.0.0.1:4175/?sector=1&quality=HIGH&debug=1` (switch sectors fast via `window.__STRAND_DEBUG__.app.buildSector(4)`).
4. Poll readiness via `time.sleep(1.0)` + `page.evaluate("() => Boolean(window.__STRAND_DEBUG__ && window.__STRAND_DEBUG__.app && window.__STRAND_DEBUG__.app.layout)")`.
5. Immediately freeze rAF & hide UI overlays:
   ```js
   window.requestAnimationFrame = () => 0;
   document.querySelectorAll('#title, #hud, #pause, #result, #loading').forEach(el => { if (el) el.style.display = 'none'; });
   ```
6. Note `__STRAND_DEBUG__` structure (`main.ts:683`): `app = window.__STRAND_DEBUG__.app`, `L = window.__STRAND_DEBUG__.layout()` (or `app.layout`), `R = app.renderer`, `cam = R.camera`.
7. For each shot: move `cam`, call `cam.updateMatrixWorld(); app.city.update(12.5, cam.position); app.destructibles.update(0.016, cam.position); app.effects.update(0.016, 0.016, cam.position, app.camVel, 12.5, R.viewportHeight); R.updateShadowFocus(cam.position); R.render();`, extract `R.renderer.domElement.toDataURL('image/png')` + `R.renderer.info.render.calls`, save PNG to the artifacts directory, and inspect every PNG with `view_file`.
8. Keep all temporary `.mjs`/`.py` audit scripts inside `<appDataDir>/brain/<conversation-id>/scratch/` so the git working tree stays 100% clean.
