# Graspt — Agent Protocol

You are operating inside **Graspt**, an allocentric topological proof navigation environment for **Lean 4 + Mathlib**. The product surface is an **npm CLI + localhost website** (the VS Code extension was retired per [docs/decisions/sum_9.md](docs/decisions/sum_9.md)–[docs/decisions/sum_10.md](docs/decisions/sum_10.md)). Read-only exploration; agent output is untrusted and Lean-verified only; the server never writes to an opened repo.

## Workspace Layout
- `lean/` — Lake project with **Lean 4 (`v4.36.0-rc2`)** and **Mathlib** pre-cached:
  - `lean/Graspt/Trace.lean` & `lean/Graspt/TraceMain.lean` — `graspt-trace` executable (elaborates `.lean` files and outputs the exact metavariable goal & tactic DAG as JSON; supports `--server` mode).
  - `lean/Graspt/AtlasMain.lean` — `graspt-atlas` executable (pre-maps Mathlib declarations into areas, landmark rankings, and dependency edges).
  - `lean/Demo/LocalLayout.lean` — Formalization of Piccinini's Local-Layout 2D Allocentric Navigation Machine ([arXiv:2603.27926](https://arxiv.org/abs/2603.27926), Section 6, Lemma 6.3).
  - `lean/Demo/Basics.lean` — Cross-Mathlib showcase theorems (Topology, Algebra, Number Theory).
- `packages/core/` — Pure, tested graph logic ported from the retired extension: `types.ts` (frozen trace contract), `nav.ts` (canonical `Γ ⊢ T` place keys, loop closure, `neighbourhood()`, area colours), `model.ts` (trace → proof map), `layout.ts` (stable positions by canonical key), `agent-guard.ts` (citation validation, timeouts).
- `apps/server/` — Dependency-light Node HTTP API: repos, atlas, proof, neighbourhood, navigator walk, citation-validated chat, ingestion jobs. State/layout live in a server store dir, never in the opened repo.
- `apps/web/` — Atlas-first UI (territory → proof map → egocentric panel + chat). Plain HTML/CSS/JS, no build step.
- `apps/cli/graspt.ts` — CLI entry (`graspt [folder] [--port N] [--no-open]`).
- `fixtures/demo/` — Pre-indexed traces of `lean/Demo/` so the site opens instantly.
- `docs/decisions/` — `sum_N.md` design/decision logs; `docs/architecture.md` — layer map.

## Useful Commands
- Run the website:
  ```bash
  cd /workspaces/graspt && npm install && npm start -- ./lean
  # Open http://127.0.0.1:4173/ in a browser
  ```
- Trace a Lean file into JSON:
  ```bash
  cd /workspaces/graspt/lean && ~/.elan/bin/lake exe graspt-trace Demo/LocalLayout.lean
  ```
- Verify:
  ```bash
  cd /workspaces/graspt && npm run typecheck && npm test
  ```
