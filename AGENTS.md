# Graspt — Agent Protocol 

You are operating inside **Graspt**, an allocentric topological proof navigation environment for **Lean 4 + Mathlib**.

## Workspace Layout
- `lean/` — Lake project with **Lean 4 (`v4.36.0-rc2`)** and **Mathlib** pre-cached:
  - `lean/Graspt/Trace.lean` & `lean/Graspt/TraceMain.lean` — `graspt-trace` executable (elaborates `.lean` files and outputs the exact metavariable goal & tactic DAG as JSON; supports `--server` mode with in-memory header caching).
  - `lean/Graspt/AtlasMain.lean` — `graspt-atlas` executable (pre-maps 253,000+ Mathlib declarations into continents/areas, landmark rankings, and dependency edges in `lean/.graspt/atlas/`).
  - `lean/Demo/LocalLayout.lean` — Formalization of Piccinini's Local-Layout 2D Allocentric Navigation Machine ([arXiv:2603.27926](https://arxiv.org/abs/2603.27926), Section 6, Lemma 6.3).
  - `lean/Demo/Basics.lean` — Cross-Mathlib showcase theorems (Topology, Algebra, Number Theory).
- `extension/` — VS Code Extension (`graspt.graspt`):
  - `extension/src/model.ts` — Multi-resolution topological proof map builder (L1 Micro, L2 Meso, L3 Macro coarse-graining, Unpack, Chunk).
  - `extension/src/doctor.ts` — Dependency doctor checking `leanprover.lean4`, `elan`/`lake`, `Mathlib` cache, `graspt-trace`/`graspt-atlas`, `atlas.json`, `pi.dev`, and `git worktree`.
  - `extension/src/worktree.ts` — Parallel candidate branch verifier using `.graspt/worktrees/` (with symlinked `.lake`) + persistent `TracePool`.
  - `extension/src/agent.ts` — Universal CLI agent bridge (`pi`, `claude`, `codex`, `opencode`) + built-in tactic sweep.
  - `extension/webview/main.ts` — Cytoscape topological Convex-Hull visualization + Minimalistic Floating Agent Chatbar.

## Useful Commands
- Trace a Lean file into JSON:
  ```bash
  cd /workspaces/graspt/lean && ~/.elan/bin/lake exe graspt-trace Demo/LocalLayout.lean
  ```
- Rebuild the VS Code extension:
  ```bash
  cd /workspaces/graspt/extension && npm run build
  ```
