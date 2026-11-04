# Contributing

## Setup

```bash
npm ci
npm run typecheck
npm test
npm start -- ./lean   # Open http://127.0.0.1:4174/ in a browser
```

Node ≥ 20. The Lean tooling in `lean/` needs `elan` on PATH (`~/.elan/bin`); the website and tests do not.

## Ground rules

- **Read-only is a security boundary.** The server must never write into an opened repo. State and layout go to the server store dir only.
- **The agent is untrusted.** Anything it says is unverified until Lean checks it or the citation guard validates it against the graph.
- **Places are `Γ ⊢ T`.** Never key persistent state by `MVarId` — it changes on every re-elaboration.
- **Colour = Mathlib area only** for landmarks (`packages/core/nav.ts` `AREA_COLORS` is the single source).

## Decisions

Product and design decisions are settled with the maintainers before implementation. A change that contradicts a settled decision needs a new agreed decision saying why.

## Pull requests

Keep PRs scoped to one structure unit. `npm run typecheck && npm test` must pass; CI runs the same.
