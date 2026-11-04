# AGENTS.md

Operational guide and architectural contract for AI agents provisioning, developing, or verifying **Graspt** inside a VM, container, or sandbox.

---

## 1. First-Time Provisioning (VM / Container / Sandbox)

Provisioning is **offline, staged, and idempotent**: Lean toolchain (`leanprover/lean4:v4.36.0-rc2` via `elan`) → Mathlib cache (`lake exe cache get` in `lean/`) → global Mathlib Atlas (`graspt-atlas`, 446,916 declarations across 41 areas).

Choose the path matching your environment's network, disk, and Lean access:

### Path A — Full Provisioned Environment (VM or Container with Network + ~10 GB Disk)

Run these steps in order. Each stage skips itself when already fresh.

1. **Install Node dependencies and build:**
   ```bash
   npm ci
   npm run build
   ```
   *Completion criterion:* `dist/apps/cli/graspt.js` and `apps/web/dist/index.html` exist; `npm run typecheck && npm test` exits `0`.

2. **Configure persistent storage (Containers):**
   State and the global atlas live in `GRASPT_STORE` (default `~/.graspt/store`). In a container, mount a persistent volume at `~/.graspt` (or set `GRASPT_STORE=/path/to/volume`) and ensure `~/.elan/bin` is on `PATH`:
   ```bash
   export PATH="$HOME/.elan/bin:$PATH"
   ```

3. **Run staged provisioning as ONE long job:**
   ```bash
   npx graspt setup
   ```
   - **Stage 1 (`install-lean`):** Installs `elan` (if absent) and toolchain `leanprover/lean4:v4.36.0-rc2`.
   - **Stage 2 (`fetch-mathlib`):** Runs `lake exe cache get` inside `lean/` (~8 GB into `lean/.lake`).
   - **Stage 3 (`generate-atlas`):** Runs `lake exe graspt-atlas <store>/atlas Mathlib`. Imports all of Mathlib in a single pass (takes several minutes and ~8–12 GB RAM). Writes `atlas.json`, `importance.json`, and an atomic `setup-manifest.json` fingerprinted with SHA-256 over toolchain + Mathlib revision + `AtlasMain.lean` source.
   - *Note:* Run `npx graspt setup` without a short shell timeout. An interrupted stage safely restarts that stage on the next run.

4. **Build the persistent tracer binary (if not yet built):**
   ```bash
   (cd lean && lake build graspt-trace)
   ```
   *Completion criterion:* `lean/.lake/build/bin/graspt-trace` exists and is executable.

5. **Verify offline demo readiness:**
   ```bash
   npx graspt demo-ready
   ```
   *Completion criterion:* Exits `0` with `"ready": true` and `lean`, `mathlib`, `atlas`, and `fixtures` stages all `"ok": true`. (`npx graspt doctor` prints full machine-readable status JSON.)

### Path B — Restricted Sandbox (No Network or No Lean Toolchain)

When running in an isolated sandbox without `elan` or network access, you can still build, verify all pure contracts, and run the pre-indexed demo end-to-end:

1. **Build and verify gates:**
   ```bash
   npm ci
   npm run typecheck
   npm test
   ```
   *Completion criterion:* Zero TypeScript errors; all `node:test` suites in `dist/tests/*.test.js` pass.

2. **Start the server against pre-indexed fixtures:**
   ```bash
   node dist/apps/cli/graspt.js --port 4174 --no-open
   ```
   *Completion criterion:* `curl -s http://127.0.0.1:4174/api/repos` returns the `demo` repository with 12 pre-indexed declarations from `fixtures/demo/*.trace.json`.

### Starting the Server in Headless / Container Environments

Always pass `--no-open` in VMs, containers, and remote sandboxes so the CLI does not attempt to spawn `xdg-open`:

```bash
node dist/apps/cli/graspt.js --port 4174 --no-open
```

---

## 2. Core Product & Architectural Contract

These commitments govern every layer (`lean/`, `packages/core/`, `apps/server/`, `apps/web/`). Keep them intact when modifying code.

### One Mode: Navigate, Direct, Verify
- **Allocentric + Egocentric dual frame:** A proof is rendered as a topological map where goals are **places**, tactics are **moves**, named declarations are **landmarks**, and unsolved goals (`sorry` or unconsumed subgoals) are open **frontiers**. The allocentric map shows the whole proof territory; the egocentric strip shows the current goal `Γ ⊢ T`, the tactic trail from the root, and nearest neighbours (ranked by graph distance, then Mathlib `uses`, capped at 10).
- **Four entry points, one session shape:**
  1. *From scratch* (`POST /api/repos/scratch`): plain-language intent → whole-file Lean draft → tracer elaboration → bounded diagnostic repair (up to 3 attempts, with pre-verified starter fallbacks) → verified proof map.
  2. *Local Lean folder* (`POST /api/repos/upload` or `/api/repos/open`): browser folder picker / drag-and-drop materialises `.lean` and Lake configuration files into `<store>/workspaces/upload-*/` (capped at 300 files / 10 MB, path-confined) and traces them read-only.
  3. *Remote repository* (`POST /api/repos/clone`): shallow-cloned into `/tmp/graspt-clones/` and traced.
  4. *Precomputed demos* (`fixtures/demo/`): 12 built-in Lean proofs opening instantaneously without invoking Lean.

### Load-Bearing Invariants
1. **Canonical place identity (`Γ ⊢ T`, never `MVarId`):**
   Every goal's persistent identity is `canonicalGoalKey(target, pp)` in `packages/core/nav.ts`—an FNV-1a hash over normalized, α-sorted hypothesis types and target expression. Lean's internal `MVarId`s change on every elaboration; keying layout or loop closures by `MVarId` breaks spatial continuity.
2. **Spatial continuity across re-traces:**
   `resolvePositions` and `LayoutStore` (`packages/core/layout.ts`) keep existing places fixed at their saved coordinates when a file is re-traced. Newly spawned subgoals are placed relative to their parent. Layouts are namespaced per repo under `<store>/layout-host/<repoId>/`.
3. **Landmark colour = Mathlib area only:**
   `AREA_COLORS` and `areaColor()` in `packages/core/nav.ts` are the single source of truth for landmark colour. Unmapped constants default to `Core` grey (`#94a3b8`); file-local declarations map to `Local` (`#1f8aa5`). Selection, cursor, and frontier states use rings and badges, never landmark fill hue.
4. **Lean disposes (no unverified state presented as proved):**
   - A `sorry` is always an open frontier, never a completion.
   - Candidate tactics from chat carry an explicit **Try** action (`POST /api/repos/:id/apply`). `judgeApplication` (`apps/server/splice.ts`) accepts a splice only when re-elaboration produces **zero error messages** *and* **strictly fewer `sorry` steps** in the target declaration.
   - Escape hatches (`sorry`, `axiom`, `native_decide`, `unsafe`, `#eval`, `#print axioms`) are rejected by `cleanTactic` and `normaliseSource`.
5. **Untrusted agent output & citation guardrails:**
   Chat responses are validated by `validateCitations` (`packages/core/agent-guard.ts`) against the active graph's node IDs (`g:...`, `lm:...`, `mv:...`, `known`). Responses with fabricated node IDs or zero citations are flagged `verified: false` with the exact reason. Calls are bounded by `MAX_AGENT_CHARS` (8,000) and `AGENT_TIMEOUT_MS` (15,000 ms).
6. **Read-only boundary on user repositories:**
   The server never writes to an opened folder or cloned repository. Verified tactic splices live in in-memory `sourceOverrides` (`apps/server/server.ts`), uploaded folders live in `<store>/workspaces/`, and layout state lives in `GRASPT_STORE`.

---

## 3. Hard-Won Operational Facts

- **One persistent tracer process per file (`apps/server/trace-client.ts`):**
  `graspt-trace --server` speaks JSON Lines over stdin/stdout (`{"ready":true}` banner, then `{"id","file","content"}` requests) and caches the elaborated import header (`HeaderCache` keyed by the file's `import` lines). However, elaborating one file in a long-lived Lean process can pollute notation/environment state for a *different* file. `trace-client.ts` intentionally runs one process per file and restarts on file change (~3s cold trace, ~0.1s warm check). Keep this one-process-per-file lifecycle intact; kill any orphaned `graspt-trace --server` processes if freeing RAM on memory-constrained VMs.
- **Tracing external Lake projects (`apps/server/ingest.ts`):**
  External projects (clones or uploaded folders) do not declare `graspt-trace` in their `lakefile`. Always trace them by running Graspt's own compiled binary under the target project's environment:
  ```bash
  lake env <graspt-root>/lean/.lake/build/bin/graspt-trace <relFile>
  ```
  with `cwd` set to the target project's Lake root. Because `lake env` may emit build progress lines to stdout before the tracer's JSON payload, always parse stdout through `parseTraceOutput()`.
- **Uploaded workspaces lack `.lake/packages`:**
  Browser uploads exclude `.lake/`. When `ingestFolder` finds a Lake root without `.lake/packages`, it runs `lake exe cache get` before tracing so dependencies have compiled `.olean` files.
- **Meta AI credentials (`apps/server/meta.ts`):**
  Chat and scratch generation call `https://api.meta.ai/v1/responses` (default model `muse-wonder-1.0`) via the Vercel AI SDK. The API key is stored server-side at `~/.graspt/meta-key` with mode `0600` (or supplied via `MODEL_API_KEY` / `META_API_KEY` in the environment) and is never echoed to the browser or logs.

---

## 4. Verification Gates

Before reporting any change complete, run:

```bash
npm run typecheck && npm test
```

All tests in `tests/*.test.ts` must compile and pass, and live user-facing behaviour must be verified against the running server rather than assumed from static reading.
