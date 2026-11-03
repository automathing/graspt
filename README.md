# Graspt

**Allocentric topological proof navigation for Lean 4 + Mathlib — an npm CLI that launches a localhost website.**

> *"A geometric and topological metaphor for the space of what humanity already knows, and what can be reached just by combining existing ideas."*

Graspt is for people with mathematical intuition who are blocked by transcoding between ideas and Lean's symbolic language (see [sum_7.md](docs/decisions/sum_7.md), [sum_10.md](docs/decisions/sum_10.md)). Humans navigate and judge; the agent proposes from the same map; Lean verifies. The current surface is **read-only exploration**: contribution appears only as Lean-verified ghost previews, and the server has no code path that writes to your repo.

## Run it

```bash
npm install
npx graspt setup             # provision Lean (elan + toolchain) and the Mathlib cache
npm start -- ./lean          # or: npx graspt ./lean, or npx graspt https://github.com/owner/repo.git
# → Open this URL in your browser: http://127.0.0.1:4173/
```

Setup is explicit (Lean + Mathlib are gigabytes, so nothing downloads silently at install time): `graspt setup` installs the elan Lean toolchain `leanprover/lean4:v4.36.0-rc2` and the Mathlib cache of the bundled `lean/` project — skipping whatever is already present. Chat needs no installation: it calls the Meta AI API via the Vercel AI SDK (`ai` + `@ai-sdk/openai` pointed at `https://api.meta.ai/v1`, Responses API, model `muse-wonder-1.0` by default, selectable next to the chatbox). Paste your Meta API key (`MODEL_API_KEY`) next to the chatbox; it is stored on the server only (`~/.graspt/`, mode `0600`) and never sent back to the browser.

Opening sources: a local folder, or a git URL — remotes are cloned into `/tmp/graspt-clones/` (server scratch space) and ingested from there. Note the browser itself cannot see `/tmp` (or any filesystem); the Node server running on the same machine reads folders/clones and serves only the map API, which is why `/tmp/...` paths work in the UI.

Pre-indexed demo traces ship in `fixtures/demo/`, so the atlas opens instantly with no Lean run. To open another folder, paste its path in the header bar (ingestion runs as a visible job; a lake project is traced with `graspt-trace`, ≤3 files), or precompute `<folder>/.graspt/trace.json`.

## What you see

1. **Atlas first** — the repo territory: areas, landmarks (coloured by Mathlib area only), and declarations.
2. **Proof map** — click a declaration: goals, moves (tactics as `Goal → List Goal`), landmarks, frontiers, `≡` loop closures. Places are keyed by canonical `Γ ⊢ T`, never `MVarId`, so re-traces don't move nodes.
3. **Egocentric panel** — click any goal: its full context plus up to 10 nearest neighbours. Click through them to walk the proof mouse-only.
4. **Chat + navigator walk** — answers cite graph node IDs and are validated server-side (bad citations are marked unverified); the walk replays tactics Lean actually elaborated. Agent output can never mutate the graph or your files.

## Layout

| Path | What |
| :--- | :--- |
| `apps/cli/` | CLI: parse folder, start server, open browser |
| `apps/server/` | HTTP API (repos, atlas, proof, neighbourhood, walk, chat, ingest jobs); layout/state live in a server store dir, never in the opened repo |
| `apps/web/` | Atlas + proof map + egocentric panel + chat (no build step) |
| `packages/core/` | Pure logic: canonical place keys, loop closure, proof-map model, stable layout, agent citation guard |
| `lean/` | Lake project: `graspt-trace` / `graspt-atlas` Lean tooling (unchanged) |
| `fixtures/demo/` | Pre-indexed traces of `lean/Demo/` for instant demo open |
| `tests/` | Core + agent-guard tests (`npm test`) |
| `docs/` | [Architecture](docs/architecture.md) and [decision logs](docs/decisions/README.md) |

## Verify

```bash
npm run typecheck && npm test
```

## Demo note (hackathon)

Demo runs in a GitHub Codespace (AMD EPYC, 4 cores) and is delivered as a recorded video. Pre-warm with `npm start` and the bundled demo repo; live ingestion is shown as a job, never waited on.
