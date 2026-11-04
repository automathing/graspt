# Graspt

**Stand on the map. Direct the agent. Lean tells the truth.**

Graspt turns Lean 4 theorem proving from writing symbolic code into navigating proved mathematics. You explore a stable map of goals and landmarks, stand on a place, and direct an AI agent in plain language. The agent drafts and edits Lean. The Lean kernel verifies every move. Nothing unverified is ever presented as proved.

```bash
git clone <this-repo> && cd graspt
npm ci
npx graspt setup        # one long offline job: Lean → Mathlib cache → global atlas
npx graspt demo-ready   # names any missing stage; never silently regenerates
npm start               # → open http://127.0.0.1:4174/ in your browser
```

For a first look with no setup at all, `npm start` opens the pre-indexed demo instantly — 12 Lean proofs, already traced, with open frontiers waiting to be closed live.

---

## The problem

AI agents can now write Lean. Almost nobody can steer them.

The barrier is not mathematical intelligence. It is **transcoding**: turning an idea in your head — *these two lemmas should combine here, this induction should split there* — into `rcases`, `refine`, and Mathlib incantations, and turning Lean's symbolic output back into an idea. That transcoding cost locks out the largest pool of mathematical talent: people with intuition and judgement who never paid the years-long syntax apprenticeship.

Existing interfaces make it worse. An editor shows you one goal at a time through a keyhole. You cannot see the shape of a proof, where you are in it, what is near you, or what a step is *for*. You are navigating a territory through a periscope, typing coordinates by hand.

Graspt's bet: **in the age of AI agents, the human's job in formal mathematics changes from encoding proofs to navigating and judging them.** Interfaces should be built for that job.

## The philosophy

Five commitments shape every part of this codebase. They are stated here as concepts because they *are* the product — the code is their crystallised form.

### 1. Mathematics is a territory, and places stay put

A proof is rendered as a topological map: goals are **places**, tactics are **moves** between places, named theorems are **landmarks**, and an unsolved goal is an open **frontier**. Two views of the same map are always present:

- the **allocentric map** — the whole territory seen from outside, world-fixed;
- the **egocentric view** — where you are standing: your current goal `Γ ⊢ T` in full, the trail that brought you here, and your nearest neighbours.

A map is only useful if places stay put. Every goal is therefore identified by a **canonical key built from its statement and context (`Γ ⊢ T`)** — never by Lean's transient internal IDs, which change on every elaboration. Re-trace a file and nothing moves. Clicking a neighbour walks you through the proof; your cursor, the map highlight, and the agent's context are always the same place.

### 2. Three jobs, three actors

- **The human** does the part humans compress well: pattern recognition over the map's shape. Choosing which frontier to attack, which landmarks to combine, which leap to trust.
- **The AI agent** does the rote symbolic labour: traversing the proof graph computationally, drafting tactic code, translating between grains of detail, repairing what Lean rejects.
- **Lean** disposes. It is the only voice allowed to say *true*. The agent proposes; the kernel decides.

This is a shared-autonomy loop, stated plainly: the human emits high-level intent, the agent handles low-level execution, and verified feedback closes the loop. The claim is falsifiable, and that is its strength — an amateur reaching a first verified proof faster through this loop than through raw Lean is a timed experiment, not a slogan.

### 3. Never predict provability — elaborate

Whether a tactic closes a goal is, in practice, computationally irreducible: there is no cheap static preview of unification, typeclass search, or definitional equality. Any interface that renders model confidence as reachability is lying.

So Graspt never guesses. A move is only drawn as real once Lean has produced it. A candidate tactic is drawn as a *suggestion* until Lean checks it — in a session working copy, off to the side, at ~0.1s per check through a persistent tracer. Accepted branches extend the map; rejected ones explain their diagnostics and leave the map untouched. Irreducibility is answered by execution, not by confidence scores.

### 4. One shared map for human and agent

The agent does not receive a prompt scraped from a text buffer. It receives the same place you see: the current goal, the branch-path trail, the neighbouring goals and landmarks, in the same frame of reference. Its answers must cite graph nodes that actually exist — citations are validated server-side, and fabricated ones are flagged as unverified. When you click, you are *pointing*, and the agent's world moves with your finger.

### 5. Grain is a steering wheel, not a setting

An expert's obvious single step is a learner's ten-step chasm. So the map adjusts fidelity dynamically: landmarks and non-trivial branching steps are surfaced, routine plumbing is collapsed into edges, and any leap can be unpacked when it looks too big. The agent's most valuable job is translating between grains on demand — so the human always works at the resolution their intuition can steer.

## The demo loop (90 seconds)

1. **Open the demo map.** Twelve pre-indexed Lean proofs — topology, algebra, number theory, induction, set theory — with 7 open frontiers.
2. **Click a frontier**, e.g. `two_dvd_mul_succ`: *2 divides n·(n+1), for every n* — stated, not yet proved.
3. **Ask the agent.** It answers in three parts: *Where you are* (in plain words), *What combines here* (the nearby landmarks and why), *My suggestion* (a tactic, marked unverified).
4. **Press “Try this — Lean checks it.”** The tactic is spliced into a session working copy and elaborated; if Lean rejects it, the agent and Lean loop with diagnostic-driven repair until a tactic either **closes** or **advances** the frontier — and **the map redraws itself around you** with every other place where you left it.
5. **Or start from scratch:** state a theorem in plain words, and watch a generated, Lean-verified proof appear as a map.

## Four ways in, one session

| Entry | What happens |
| :--- | :--- |
| **From scratch** | Plain-language intent → agent drafts whole-file Lean → tracer elaborates, diagnostics drive repair → only a verified proof becomes a map |
| **Local Lean folder** | Drag-and-drop or pick a folder in the browser; Lean sources are uploaded into a confined server workspace and traced read-only |
| **Remote repository** | Cloned into server scratch space, then traced the same way |
| **Precomputed demos** | The built-in traced proofs — instant open, no Lean run |

After entry, every session is identical: map, egocentric view, agent chat, and the same verified-action loop.

## How it works

```text
graspt [folder]
   │
   ▼
apps/cli ──► apps/server ──► packages/core ◄── lean/ (graspt-trace JSON)
                 │                ▲
                 ▼                │
            apps/web ────────────┘  (start screen → map + egocentric strip + agent rail)
                 ▲
                 │ atlas (areas · landmarks · importance), built offline by setup
            lean/Graspt/AtlasMain.lean
```

| Layer | What it does |
| :--- | :--- |
| `lean/` | The only Lean-facing code: `graspt-trace` elaborates files into goal/tactic graphs; `graspt-atlas` pre-maps all of Mathlib (446,916 declarations, 41 areas, 4,000 landmarks) |
| `packages/core/` | Pure, tested logic: canonical place identity, loop closure, proof-map model, stable layout, citation validation |
| `apps/server/` | HTTP API, ingestion, the persistent tracer, scratch generation, the verified apply action, staged provisioning |
| `apps/web/` | React + shadcn: start screen, proof map (SVG), egocentric strip, agent chat rail |
| `fixtures/demo/` | Pre-indexed traces so the demo opens instantly |

**Invariants an evaluator can check:** places keyed by canonical `Γ ⊢ T`, never internal IDs · landmark colour encodes Mathlib area only · a `sorry` is a frontier, never a completion · nothing unverified is drawn as proved · opened repositories are never written on disk (verified work lives in a session working copy; landing it is a separate, deliberate act).

## Reproducibility

Setup is offline provisioning, never part of the demo path. It is staged and idempotent — Lean toolchain → Mathlib cache → global atlas — each stage skipping itself when fresh. The atlas is fingerprinted (SHA-256 over toolchain + Mathlib revision + the generator's own source and parameters) and validated by parsing before anything trusts it. `graspt doctor` prints machine-readable status; `graspt demo-ready` names the missing stage and its remedy.

State lives in a persistent store (`GRASPT_STORE`, default `~/.graspt/store`). In a container, persist `~/.graspt` as a volume and start with `--no-open`. The supported reproduction path is a **git clone**; the npm tarball excludes the Lean tooling and is demo-grade only. A sandbox with no Lean and no network can still verify the product: typecheck, tests, and the fixture demo exercise it end to end.

Chat calls Meta AI directly via the Vercel AI SDK (`muse-wonder-1.0` by default). Paste your key (`MODEL_API_KEY`) behind the **API key** button in the chat rail; it is stored server-side only (`~/.graspt/`, mode `0600`) and never returned to the browser.

## Honest boundaries

A demo that hides its limits will be found out; these are ours:

- The verified apply action (`Try`) operates at **open frontiers** (`sorry`) with single-line tactics, looping with diagnostic-driven repair until a candidate either closes the frontier or advances it to a new verified subgoal. Arbitrary mid-proof refactoring of already-closed steps is not yet built.
- Scratch generation is whole-file drafting with a bounded repair loop, not a stepwise prover. Lean verifies the *proof*; whether the formalised statement matches your English is yours to judge on the map.
- One tracer process serves one file at a time (a fresh file pays a ~3s cold trace, then ~0.1s warm checks).
- What is *proved* here is the loop: point → explain → propose → kernel-verifies → map moves. The wider claims — that spatial navigation becomes transparent faster than syntax fluency — are the experiment this demo invites you to run.

## Verify

```bash
npm run typecheck && npm test   # the repo's CI gates
npx graspt demo-ready           # on a set-up machine: every stage, named
```

## Evaluating this repo in five minutes

1. `npm ci && npm start` — open the demo, close a frontier with Try, watch the map redraw.
2. Read `packages/core/` — the philosophy as pure functions, each with tests at the contract.
3. Read `apps/server/splice.ts` and `apps/server/generate.ts` — the two places agent output meets the kernel, and the exact conditions under which anything is believed.
4. Check the invariants above against the code. They are load-bearing, not decorative.
