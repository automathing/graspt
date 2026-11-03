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
| CLI | `apps/cli/` | Parse folder/port, start server, open browser |
| Server | `apps/server/` | HTTP API (repos, atlas, proof, neighbourhood, walk, chat, ingest jobs). Read-only: no route writes to an opened repo |
| Web | `apps/web/` | Static atlas-first UI. No build step, no frontend dependencies |
| Core | `packages/core/` | Pure logic: trace contract (`types.ts`), canonical place keys + loop closure + neighbourhood (`nav.ts`), proof-map model (`model.ts`), stable layout (`layout.ts`), agent citation guard (`agent-guard.ts`) |
| Lean | `lean/` | `graspt-trace` / `graspt-atlas` executables; surface-independent, emits the frozen JSON contract |
| Fixtures | `fixtures/demo/` | Pre-indexed traces of `lean/Demo/` for instant demo open |
| Tests | `tests/` | Core + agent-guard tests (`node:test`) |
| Decisions | `docs/decisions/` | `sum_N.md` design/decision logs — the project's design history |

Invariants: places keyed by canonical `Γ ⊢ T` (never `MVarId`); landmark colour = Mathlib area only; agent output is untrusted until Lean or the citation guard validates it; layout/state persist only in the server store dir.
