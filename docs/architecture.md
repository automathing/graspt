# Architecture

```text
graspt [folder]
   │
   ▼
apps/cli ──► apps/server ──► packages/core ◄── lean/ (graspt-trace JSON)
                 │                ▲
                 ▼                │
            apps/web ─────────────┘  (atlas → proof map → egocentric panel)
```

| Layer | Path | Responsibility |
| :--- | :--- | :--- |
| CLI | `apps/cli/` | Parse folder/port, start server, open browser; `setup` (staged provisioning), `doctor`, `demo-ready` |
| Server | `apps/server/` | HTTP API (repos, atlas, proof, neighbourhood, walk, chat, ingest/setup jobs). Read-only: no route writes to an opened repo. Provisioning in `setup.ts` (Lean → Mathlib → Atlas, skip-if-fresh), atlas fingerprint/validation in `atlas-cache.ts` |
| Web | `apps/web/` | Static atlas-first UI. No build step, no frontend dependencies |
| Core | `packages/core/` | Pure logic: trace contract (`types.ts`), canonical place keys + loop closure + neighbourhood (`nav.ts`), proof-map model (`model.ts`), stable layout (`layout.ts`), agent citation guard (`agent-guard.ts`) |
| Lean | `lean/` | `graspt-trace` / `graspt-atlas` executables; surface-independent, emits the frozen JSON contract |
| Fixtures | `fixtures/demo/` | Pre-indexed traces of `lean/Demo/` for instant demo open |
| Tests | `tests/` | Core + agent-guard tests (`node:test`) |

Invariants: places keyed by canonical `Γ ⊢ T` (never `MVarId`); landmark colour = Mathlib area only; agent output is untrusted until Lean or the citation guard validates it; layout/state persist only in the server store dir.

Provisioning: `graspt setup` is offline, staged, and idempotent (Lean toolchain → Mathlib cache → global Atlas via `graspt-atlas`), run as one long job from a git clone. The atlas cache lives in the store dir (`GRASPT_STORE`, default `~/.graspt/store`), is fingerprinted (SHA-256 over toolchain + Mathlib revision + generator source + parameters, recorded in an atomically-written `setup-manifest.json`), and is trusted only after parse-and-count validation. `graspt demo-ready` reports each stage by name and never regenerates. The validated atlas/importance table is loaded at server boot and feeds proof-map landmark ranking.
