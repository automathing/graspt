# Changelog

All notable changes are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Changed
- Repository restructured into `apps/` (cli, server, web), `packages/core/`, `tests/`, `fixtures/`, and `docs/decisions/`. No behaviour change.
- Chat now calls the Meta AI API via the Vercel AI SDK (`ai` + `@ai-sdk/openai`, Responses API at `api.meta.ai`); pi and all other agent CLIs were removed.
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
- VS Code extension surface (`extension/`, VSIX packaging). Decision record: `docs/decisions/sum_9.md`–`sum_11.md`.
