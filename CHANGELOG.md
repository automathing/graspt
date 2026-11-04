# Changelog

All notable changes are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Added
- React + Tailwind/shadcn web UI with one-mode unified workspace: collapsible horizontal declaration strip, SVG allocentric proof map with backtrace path highlighting, egocentric (`Γ ⊢ T`) step-back bar + categorized neighbour compass, and agent chat rail with one-click quick prompts.
- Verified tactic loop (`POST /api/repos/:id/apply`): pressing **Try** checks whether the candidate tactic closes the frontier or advances it to a new verified subgoal, looping with diagnostic-driven agent repair (up to 4 rounds) and recording the full attempt trail.
- Scratch proof generation (`POST /api/repos/scratch`): plain-language intent → whole-file Lean draft → tracer elaboration → diagnostic repair (with maintained starter fallbacks).
- Browser folder upload (`POST /api/repos/upload`): drag-and-drop or folder picker materialises `.lean` and Lake files into a path-confined server workspace (`<store>/workspaces/upload-*/`).
- Reproducible offline provisioning (`npm run setup`, `npm run doctor`, `npm run demo-ready`) with SHA-256 fingerprinted global Mathlib atlas (`446,916` declarations across `41` areas) and `AGENTS.md` operational guide.

### Changed
- Repository restructured into `apps/` (cli, server, web), `packages/core/`, `tests/`, `fixtures/`, and `docs/`. No behaviour change.
- Chat now calls the Meta AI API via the Vercel AI SDK (`ai` + `@ai-sdk/openai`, Responses API at `api.meta.ai`); pi and all other agent CLIs were removed.
- External repository tracing uses `lake env <graspt-trace-bin>` with smart theorem-file ranking and automatic bundled Mathlib fallback on toolchain skew.
- API key UX: key prompt hides once a key is saved; a pasted curl/Bearer header has its token (and model) extracted; placeholder pastes (`$MODEL_API_KEY`) are rejected with a specific message instead of silently storing garbage.

### Fixed
- Layout positions no longer leak between two opened repos that share a declaration name (cache key and server store are per-repo).
- Server hardening: static-file path traversal via encoded dot segments, invalid JSON bodies now return 400 (oversized: 413), layout payloads are validated (finite points, ≤5000), and responses carry CSP/nosniff/referrer headers.
- Move and "known" nodes on the proof map are now clickable and show their tactic detail instead of being dead ends.

## [0.2.0] — 2026-11-03

### Added
- npm CLI (`graspt [folder]`) launching a read-only localhost website, atlas-first.
- Ported proof-map core: canonical `Γ ⊢ T` place keys, loop closure, stable layout, egocentric `neighbourhood()`.
- Citation-validated agent responder, navigator walk over Lean-elaborated tactics, folder-ingestion jobs, pre-indexed demo fixtures.

### Removed
- VS Code extension surface (`extension/`, VSIX packaging).
