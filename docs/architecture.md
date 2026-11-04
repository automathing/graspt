# Architecture

```text
graspt [folder]
   │
   ▼
apps/cli ──► apps/server ──► packages/core ◄── lean/ (graspt-trace JSON)
                 │                ▲
                 ▼                │
            apps/web ─────────────┘  (start screen → map + egocentric strip + agent rail)
                 ▲
                 │ atlas (areas · landmarks · importance), built offline by setup
            lean/Graspt/AtlasMain.lean
```

| Layer | Path | Responsibility |
| :--- | :--- | :--- |
| CLI | `apps/cli/` | Parse folder/port, start server (default port 4174), open browser; `setup` (staged provisioning), `doctor`, `demo-ready` |
| Server | `apps/server/` | HTTP API: repos, atlas, proof, neighbourhood, walk, chat (`chat.ts`, `meta.ts`), verified tactic apply (`splice.ts`), scratch generation (`generate.ts`), folder/upload/clone ingestion (`ingest.ts`, `workspace.ts`), persistent per-file tracer (`trace-client.ts`), and staged provisioning (`setup.ts`, `atlas-cache.ts`). Read-only on user repos: verified splices live in session working copies (`sourceOverrides`); uploads and state live in `GRASPT_STORE`. |
| Web | `apps/web/` | React + Vite + Tailwind/shadcn UI: start screen (4 entry points: scratch, browser folder upload/dropzone, git clone, precomputed demos) → workspace (declaration sidebar, interactive SVG allocentric proof map, egocentric strip, and agent chat rail with one-click verified tactic `Try`). |
| Core | `packages/core/` | Pure, zero-I/O logic: trace contract (`types.ts`), canonical place keys (`Γ ⊢ T`) + loop closure + neighbourhood + `AREA_COLORS` (`nav.ts`), proof-map model (`model.ts`), stable per-repo layout (`layout.ts`), and agent citation guard (`agent-guard.ts`). |
| Lean | `lean/` | `graspt-trace` (single-shot and `--server` JSON Lines daemon with `HeaderCache`) and `graspt-atlas` (global Mathlib indexer: 446,916 declarations across 41 areas). |
| Fixtures | `fixtures/demo/` | Pre-indexed traces of 12 declarations from `lean/Demo/` for instant demo open without invoking Lean. |
| Tests | `tests/` | Contract and integration tests (`node:test`) covering `core`, `agent-guard`, `chat`, `generate`, `splice`, `ingest`, `upload`, `layout-store`, and `setup`. |

## Load-Bearing Invariants

- **Canonical place identity:** Goals are keyed by `canonicalGoalKey(target, pp)` (`Γ ⊢ T` with α-sorted, normalized hypotheses), never by Lean's transient `MVarId`. Re-tracing a file keeps existing places at their saved coordinates (`LayoutStore` namespaced per repo under `<store>/layout-host/<repoId>/`).
- **Landmark colour = Mathlib area only:** `AREA_COLORS` in `packages/core/nav.ts` is the single source of truth. Unmapped constants default to `Core` grey (`#94a3b8`); file-local declarations map to `Local` (`#1f8aa5`).
- **Lean disposes:** A `sorry` is always an open frontier, never a completion. Spliced tactics (`judgeApplication` in `splice.ts`) and scratch drafts (`checkTrace` in `generate.ts`) are accepted only when Lean reports zero error diagnostics and strictly reduces `sorry` steps (or reaches zero `sorry`s for scratch generation), rejecting escape hatches (`sorry`, `axiom`, `native_decide`, `unsafe`, `#eval`).
- **Untrusted agent output:** Chat responses (`api.meta.ai/v1/responses`, default `muse-wonder-1.0` via Vercel AI SDK) are validated by `validateCitations` against active graph node IDs (`g:...`, `lm:...`, `mv:...`, `known`).
- **Read-only boundary:** Opened folders and cloned repos are never modified on disk. Browser-uploaded folders are materialised into confined workspaces under `<store>/workspaces/upload-*/` (capped at 300 files / 10 MB) and traced via `lake env <graspt-trace-bin> <relFile>` (with automatic `lake exe cache get` when `.lake/packages` is absent).

## Provisioning

`graspt setup` is offline, staged, and idempotent (Lean toolchain `leanprover/lean4:v4.36.0-rc2` → Mathlib cache → global Atlas via `graspt-atlas`), run as one long job from a git clone. The atlas cache lives in the store dir (`GRASPT_STORE`, default `~/.graspt/store`), is fingerprinted (SHA-256 over toolchain + Mathlib revision + generator source, recorded in an atomically-written `setup-manifest.json`), and is trusted only after parse-and-count validation. `graspt demo-ready` reports each stage by name and never regenerates. The validated atlas/importance table is loaded at server boot and feeds proof-map landmark ranking.
