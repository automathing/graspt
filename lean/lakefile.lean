import Lake
open Lake DSL

package graspt where
  leanOptions := #[⟨`autoImplicit, false⟩]

require mathlib from git
  "https://github.com/leanprover-community/mathlib4" @ "master"

/-- Graspt's own Lean tooling (proof tracer, Mathlib atlas extractor). -/
lean_lib Graspt where

/-- Demo theorems used in the hackathon walkthrough. -/
lean_lib Demo where

/-- `graspt-trace`: elaborates a Lean file and emits its tactic/goal graph as JSON. -/
lean_exe «graspt-trace» where
  root := `Graspt.TraceMain
  supportInterpreter := true

/-- `graspt-atlas`: pre-maps the imported environment (e.g. all of Mathlib) into a landmark atlas. -/
lean_exe «graspt-atlas» where
  root := `Graspt.AtlasMain
  supportInterpreter := true
