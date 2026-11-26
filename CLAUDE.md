# STRAND // PROTOCOL — Claude Implementation Constitution

Target codebase: `strand-protocol/` (TypeScript + Three.js + WebGL2 + Web Audio API, 100% procedural — zero external `.glb`/`.png`/`.mp3` assets).

## Non-Negotiable Priorities (In Order)

### 1. Visual Quality First (Screenshot-Verified)
- Every rendered surface must look intentional, grounded, and readable up close and from skyline distance.
- Zero floating geometry (every post, bracket, anchor stub, trim, and sign must have a physical load path to ground, roof, parapet, or solid `FaceSpan`).
- Zero buried, inverted, or z-fighting geometry (double-check `LatheGeometry` point order for inward vs outward normals, `PlaneGeometry` vertical tilt `atan2(dz, dy)`, `'YXZ'` vs `'XYZ'` Euler order, wall normal axis `span.ax` vs along/gap axis, and concrete curb/wall bounds).
- **100% English in-world signage**: zero Japanese characters or CJK font fallbacks in any 3D texture, billboard, ticker, vending atlas, scaffold, or graffiti (`src/engine/ProceduralTextures.ts` and world geometry).
- Follow `HERO_3D_MODELING_SPEC.md` (§0–§6) for all hero assets (`cars <= 1,100` tris, `vending/lamp <= 450` tris, `StreetFurnishingsKit` variants `<= 380` tris, ground contact `|min.y| <= 0.02`).
- Whenever headless Chrome / Chromium / Playwright is available, verify changes with real rendered screenshots via `?sector=N&quality=HIGH&debug=1&view=x,y,z,yawDeg,pitchDeg` (or `?view=spawn`).

### 2. Performance & Ultra-Low Mouse Latency Second (Hard Guardrails)
- **Draw calls**: `renderer.info.render.calls <= 120` in **Sector 4 HIGH** at full density / active combat. Never add unbudgeted meshes or `InstancedMesh` draws.
- **Zero per-frame heap allocations** in update/step/render loops (reuse module-scoped `THREE.Vector3` / `Matrix4` / `Quaternion` / `Color` scratch objects; no `.clone()` or array/closure allocations per frame).
- **Mouse-look latency is sacred**: preserve `requestPointerLock({ unadjustedMovement: true })`, late pre-render `input.consumeLook()` sync in `src/main.ts`, half-res `UnrealBloomPass`, `MSAA <= 2` (`0` in `lowLatency`), `<= 2.2M px` DPR cap, `CITY_LIGHTS_MAX <= 12`, and fragment-shader fill-rate discipline (never add unguarded full-screen passes, heavy translucent overdraw, or unbounded per-pixel light loops).

### 3. Core Gameplay Pillars & Verification Gate
- Preserve exclusive gun⇄grapple switching (hanging allowed), 3-phase telegraphs, 100 HP / 3.0s regen / 0.5s retry, zero shooting aim assist, airborne Bullet Time, 4-state stealth AI, and `>= 2` clean parallel wall-run faces per tower.
- Before committing: `npm run build` (`tsc --noEmit && vite build`) and `npm test` MUST pass 100% inside `strand-protocol/`.
- For spec-driven work, use the `/implement-spec` skill so `strand-auditor` independently reviews the diff before push.
