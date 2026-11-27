---
name: implement-spec
description: Implement a STRAND // PROTOCOL English design spec end-to-end with parallel disjoint-file worker fan-out (when defined in the spec), mandatory build/test verification, independent strand-auditor subagent review, remediation loop, and clean commit/push.
argument-hint: <SPEC_FILE.md>
---

Execute the target design specification `$ARGUMENTS` on the active git branch (`git rev-parse --abbrev-ref HEAD`) using this strict 5-stage pipeline:

## Stage 1 — Read Spec & Baseline
1. Run `git status` and read `CLAUDE.md` plus the entire target spec `$ARGUMENTS` (and `HERO_3D_MODELING_SPEC.md` if referenced).
2. Confirm the exact bounded file list, hard draw-call budget (`<= 120` in Sector 4), mouse-latency constraints, required unit tests, and whether `$ARGUMENTS` includes a **`Parallel Execution Plan`**.

## Stage 2 — Implement (Parallel Worker Fan-Out When Supported) & Add Tests
1. **If `$ARGUMENTS` defines a `Parallel Execution Plan` with 2+ disjoint workers**:
   - First agree on exact shared TypeScript interfaces (or create tiny shared types if needed).
   - Launch all disjoint **`strand-worker`** subagents **in parallel in a single turn**, giving each worker ONLY its assigned files and exact spec sections (never overlapping file ownership!).
   - Once all parallel workers return, perform the **Lead Integration** sequentially on shared hub files (`CityBuilder.ts`, `main.ts`, etc.) and add all mandated unit/regression tests.
2. **If `$ARGUMENTS` is a small patch spec (no parallel table)**:
   - Implement cleanly in the main session within the bounded file list and add all mandated unit/regression tests.
3. Preserve zero per-frame heap allocations in update/render paths, 100% English in-world signage, and all existing comments unrelated to your changes.

## Stage 3 — Local Build & Test Gate
1. Inside `strand-protocol/`, run `npm run build` and `npm test`.
2. Fix any TypeScript, Vite, or test failure before invoking the auditor.

## Stage 4 — Mandatory Independent Subagent Audit (`strand-auditor`)
1. Invoke the **`strand-auditor`** subagent in a fresh context, passing:
   - Target spec path: `$ARGUMENTS`
   - Scope: `git diff` (staged/unstaged working changes)
   - Explicit reminder to prioritize: (1) real rendered screenshots if Chrome/Playwright is available + quantitative 3D geometry/normal/loop 0–2 checks, and (2) performance & mouse-look latency (`<= 120` draw calls, zero per-frame allocs, no GPU fill-rate regressions).
2. Read the auditor's `VERDICT` and every `MUST-FIX` / `SHOULD-FIX` item carefully.

## Stage 5 — Remediate, Re-Verify & Push
1. If `VERDICT: FAIL` (any `MUST-FIX` item):
   - Fix **every** `MUST-FIX` item (and low-risk `SHOULD-FIX` items).
   - Re-run `npm run build && npm test`.
   - Re-invoke `strand-auditor` once more to confirm `VERDICT: PASS` (hard cap: **max 2 audit loops**; if still failing after 2 loops, stop and report the blocker to the user without pushing broken code).
2. Ensure no temporary files, scratch scripts, or debug PNGs remain untracked (`git status`).
3. Update `PHASE10_PROGRESS.md` if required by `$ARGUMENTS`.
4. Commit all changes in one clean commit with a clear summary message and push to `origin` on the active branch.
5. Report to the user: commit hash, test pass count, draw-call delta, screenshot check status, and what `strand-auditor` caught & fixed.
