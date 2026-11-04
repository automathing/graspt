import Lean

/-!
# Graspt proof tracer

Elaborates a Lean file with info trees enabled and extracts, for every declaration,
the *topological proof graph*:

* **goal nodes** – every metavariable goal seen during elaboration (identified by its
  `MVarId`, so identity is exact rather than textual);
* **tactic edges** – every source-level tactic, with the goals it consumed (`before`),
  the goals it produced (`after`), its nesting depth/parent (for coarse-graining), the
  constants it names explicitly, and the constants that appear in the proof term it
  assigned (its "landmarks").

The VS Code extension turns this into the allocentric map.
-/

open Lean Elab Meta

namespace Graspt

structure GoalView where
  id : String
  pp : String
  target : String
  deriving ToJson

structure Step where
  idx : Nat
  tactic : String
  kind : String
  depth : Nat
  parent : Option Nat
  startLine : Nat
  startCol : Nat
  endLine : Nat
  endCol : Nat
  before : Array String
  after : Array String
  constants : Array String
  used : Array String
  deriving ToJson

structure DeclTrace where
  name : String
  startLine : Nat
  endLine : Nat
  steps : Array Step
  goals : Array GoalView
  deriving ToJson

structure Msg where
  severity : String
  line : Nat
  col : Nat
  endLine : Nat
  endCol : Nat
  text : String
  deriving ToJson

structure TraceResult where
  file : String
  decls : Array DeclTrace
  messages : Array Msg
  elapsedMs : Nat
  headerCached : Bool
  deriving ToJson

/-- Tactic syntax kinds that are pure structure (sequences, `by`), not navigation moves. -/
def structuralKinds : List Name :=
  [`Lean.Parser.Tactic.tacticSeq, `Lean.Parser.Tactic.tacticSeq1Indented,
   `Lean.Parser.Tactic.tacticSeqBracketed, `Lean.Parser.Term.byTactic, `null,
   `Lean.Parser.Tactic.seq1]

/-- Is this constant worth showing as a landmark (not compiler plumbing)? -/
def isLandmarkCandidate (env : Environment) (n : Name) : Bool :=
  !n.isInternal && !n.hasMacroScopes && !isAuxRecursor env n && !isNoConfusion env n &&
  !(`Eq.mpr == n || `Eq.mp == n || `id == n || `of_eq_true == n || `Eq.refl == n ||
    `rfl == n || `congrArg == n || `Eq.trans == n || `eq_self == n || `Eq.symm == n ||
    `True.intro == n || `trivial == n) &&
  match env.find? n with
  | some (.thmInfo _) => true
  | some (.defnInfo _) => true
  | some (.inductInfo _) => true
  | some (.ctorInfo _) => true
  | some (.axiomInfo _) => true
  | _ => false

partial def collectIdentsAux (s : Syntax) (acc : Array Name) : Array Name :=
  let acc := match s with
    | .ident _ _ n _ => if acc.contains n then acc else acc.push n
    | _ => acc
  s.getArgs.foldl (fun a child => collectIdentsAux child a) acc

def collectIdents (stx : Syntax) : Array Name :=
  collectIdentsAux stx #[]

structure WalkState where
  steps : Array Step := #[]
  goals : Std.HashMap String GoalView := {}
  goalOrder : Array String := #[]

abbrev WalkM := StateT WalkState IO

def ppGoalView (ctx : ContextInfo) (mctx : MetavarContext) (g : MVarId) : IO GoalView := do
  let ctx := { ctx with mctx := mctx }
  try
    ctx.runMetaM {} do
      let some decl := (← getMCtx).findDecl? g | return { id := toString g.name, pp := "?", target := "?" }
      withLCtx decl.lctx decl.localInstances do
        let pp ← ppGoal g
        let t ← ppExpr (← instantiateMVars decl.type)
        return { id := toString g.name, pp := pp.pretty 100, target := t.pretty 100 }
  catch _ => return { id := toString g.name, pp := "?", target := "?" }

def recordGoals (ctx : ContextInfo) (mctx : MetavarContext) (gs : List MVarId) : WalkM (Array String) := do
  let mut ids := #[]
  for g in gs do
    let id := toString g.name
    ids := ids.push id
    unless (← get).goals.contains id do
      let v ← ppGoalView ctx mctx g
      modify fun s => { s with goals := s.goals.insert id v, goalOrder := s.goalOrder.push id }
  return ids

def explicitConstants (ctx : ContextInfo) (stx : Syntax) : IO (Array String) := do
  let ids := collectIdents stx
  try
    ctx.runMetaM {} do
      let mut out := #[]
      for id in ids do
        let cands ← try resolveGlobalConst (mkIdent id) catch _ => pure []
        for c in cands do
          if isLandmarkCandidate (← getEnv) c && !out.contains (toString c) then
            out := out.push (toString c)
      return out
  catch _ => return #[]

def usedConstants (ctx : ContextInfo) (ti : TacticInfo) : IO (Array String) := do
  let some g := ti.goalsBefore.head? | return #[]
  let ctx := { ctx with mctx := ti.mctxAfter }
  try
    ctx.runMetaM {} do
      unless (← g.isAssigned) || (← g.isDelayedAssigned) do return #[]
      let e ← instantiateMVars (mkMVar g)
      let env ← getEnv
      let cs := e.getUsedConstants.filter (isLandmarkCandidate env)
      return (cs.toList.take 40).toArray.map toString
  catch _ => return #[]

partial def walk (fileMap : FileMap) (ctx? : Option ContextInfo) (parent : Option Nat)
    (parentRange : Option (String.Pos.Raw × String.Pos.Raw)) (depth : Nat) : InfoTree → WalkM Unit
  | .context pci t => walk fileMap (pci.mergeIntoOuter? ctx?) parent parentRange depth t
  | .hole _ => pure ()
  | .node info children => do
    match ctx?, info with
    | some ctx, .ofTacticInfo ti =>
      let stx := ti.stx
      let k := stx.getKind
      match stx.getPos? (canonicalOnly := true), stx.getTailPos? (canonicalOnly := true) with
      | some s, some e =>
        if structuralKinds.contains k || ti.goalsBefore.isEmpty || parentRange == some (s, e) then
          for c in children do walk fileMap ctx? parent parentRange depth c
        else
          let before ← recordGoals ctx ti.mctxBefore ti.goalsBefore
          let after ← recordGoals ctx ti.mctxAfter ti.goalsAfter
          let consts ← explicitConstants ctx stx
          let used ← usedConstants ctx ti
          let sp := fileMap.toPosition s
          let ep := fileMap.toPosition e
          let idx := (← get).steps.size
          let txt := (stx.reprint.getD (toString stx)).trimAscii.toString
          let step : Step := {
            idx, tactic := txt, kind := toString k, depth, parent,
            startLine := sp.line, startCol := sp.column, endLine := ep.line, endCol := ep.column,
            before, after, constants := consts, used }
          modify fun st => { st with steps := st.steps.push step }
          for c in children do walk fileMap ctx? (some idx) (some (s, e)) (depth + 1) c
      | _, _ =>
        for c in children do walk fileMap ctx? parent parentRange depth c
    | _, _ =>
      for c in children do walk fileMap ctx? parent parentRange depth c

/-- Find a declaration name inside a command's syntax. -/
partial def declNameOf (stx : Syntax) : Option Name :=
  if stx.getKind == `Lean.Parser.Command.declId then
    match stx[0] with
    | .ident _ _ n _ => some n
    | _ => none
  else
    stx.getArgs.findSome? declNameOf

def traceTree (fileMap : FileMap) (t : InfoTree) : IO (Option DeclTrace) := do
  -- locate the command syntax at the root
  let rec findCmd : InfoTree → Option Syntax
    | .context _ t => findCmd t
    | .node (.ofCommandInfo ci) _ => some ci.stx
    | _ => none
  let some cmd := findCmd t | return none
  let (_, st) ← (walk fileMap none none none 0 t).run {}
  if st.steps.isEmpty then return none
  let some s := cmd.getPos? | return none
  let e := cmd.getTailPos?.getD s
  let name := (declNameOf cmd).map toString |>.getD s!"example@{(fileMap.toPosition s).line}"
  return some {
    name, startLine := (fileMap.toPosition s).line, endLine := (fileMap.toPosition e).line,
    steps := st.steps, goals := st.goalOrder.filterMap (st.goals.get? ·) }

/-- Cache of elaborated headers keyed by the import list, so repeated traces of files
that `import Mathlib` only pay the import cost once (server mode). -/
structure HeaderCache where
  key : String := ""
  env? : Option Environment := none

def severityStr : MessageSeverity → String
  | .error => "error" | .warning => "warning" | .information => "info"

/-- Cache key = the file's actual import list. (Keying on the header
syntax's reprint collided across different import lists, so a file traced
after a warmup file was elaborated with the warmup file's environment and
its notation failed to parse.) -/
def headerKey (input : String) : String :=
  let lines := input.splitOn "\n" |>.map (·.trimAscii.toString)
  let imports := lines.filter (fun l => l.startsWith "import " || l.startsWith "public import ")
  " ".intercalate imports

def traceInput (file : String) (input : String) (cache : IO.Ref HeaderCache) : IO TraceResult := do
  let t0 ← IO.monoMsNow
  let inputCtx := Parser.mkInputContext input file
  let (header, parserState, messages) ← Parser.parseHeader inputCtx
  let key := headerKey input
  let c ← cache.get
  let (env, messages, cached) ← match c.env? with
    | some env => if c.key == key then pure (env, messages, true) else do
        let (env, msgs) ← processHeader header {} messages inputCtx
        cache.set { key, env? := some env }
        pure (env, msgs, false)
    | none => do
        let (env, msgs) ← processHeader header {} messages inputCtx
        cache.set { key, env? := some env }
        pure (env, msgs, false)
  let env := env.setMainModule `GrasptTrace
  let cmdState := Command.mkState env messages {}
  let cmdState := { cmdState with infoState := { enabled := true } }
  let s ← IO.processCommands inputCtx parserState cmdState
  let fileMap := inputCtx.fileMap
  let mut decls := #[]
  for t in s.commandState.infoState.trees do
    if let some d ← traceTree fileMap t then decls := decls.push d
  let mut msgs := #[]
  for m in s.commandState.messages.toList do
    let txt ← m.data.toString
    let ep := m.endPos.getD m.pos
    msgs := msgs.push { severity := severityStr m.severity, line := m.pos.line, col := m.pos.column,
                        endLine := ep.line, endCol := ep.column, text := txt }
  let t1 ← IO.monoMsNow
  return { file, decls, messages := msgs, elapsedMs := t1 - t0, headerCached := cached }

end Graspt
