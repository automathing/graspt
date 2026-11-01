import Lean

/-!
# Graspt atlas extractor ("pre-mapping Mathlib")

Imports an environment (default: all of `Mathlib`) and computes a topological atlas:

* **areas** – coarse regions of knowledge (`Mathlib.Topology`, `Mathlib.Algebra`, ...),
  i.e. the continents of the map, with weighted dependency edges between them;
* **landmarks** – the most-used declarations (in-degree in the global dependency graph),
  i.e. the "nails in the board" spanning the convex hull of known mathematics;
* **importance** – a name ↦ (uses, area) table for every reasonably used declaration, so the
  extension can decide in O(1) whether a constant in a proof is a landmark or plumbing.

Output is plain JSON so any tool (VS Code webview, agents, notebooks) can read it.
-/

open Lean Meta

namespace Graspt.Atlas

def keep (env : Environment) (n : Name) (ci : ConstantInfo) : Bool :=
  !n.isInternal && !n.hasMacroScopes && !isAuxRecursor env n && !isNoConfusion env n &&
  !n.isInternalDetail &&
  match ci with
  | .thmInfo _ | .defnInfo _ | .inductInfo _ | .axiomInfo _ | .opaqueInfo _ => true
  | _ => false

def kindOf : ConstantInfo → String
  | .thmInfo _ => "theorem" | .defnInfo _ => "def" | .inductInfo _ => "inductive"
  | .axiomInfo _ => "axiom" | .opaqueInfo _ => "opaque" | .ctorInfo _ => "ctor"
  | _ => "other"

/-- Area = first `depth` components of the module name below `Mathlib`;
everything outside Mathlib is grouped as `Core` (Init/Std/Lean/Batteries). -/
def areaOf (mod : Name) (depth : Nat) : String :=
  let cs := mod.components.map toString
  match cs with
  | "Mathlib" :: rest => "Mathlib." ++ ".".intercalate (rest.take depth)
  | root :: _ => if root == "Init" || root == "Std" || root == "Lean" then "Core" else root
  | [] => "Core"

structure Entry where
  name : Name
  kind : String
  module : Name
  area : String
  deps : Array Name
  deriving Inhabited

end Graspt.Atlas

open Graspt.Atlas

unsafe def main (args : List String) : IO UInt32 := do
  let outDir : System.FilePath := args.headD ".graspt/atlas"
  let roots := match args.drop 1 with
    | [] => [`Mathlib]
    | ms => ms.map String.toName
  let topN := 4000
  initSearchPath (← findSysroot)
  enableInitializersExecution
  IO.eprintln s!"[graspt-atlas] importing {roots} ..."
  let t0 ← IO.monoMsNow
  let env ← importModules (roots.toArray.map fun m => { module := m }) {} (trustLevel := 1024) (loadExts := true)
  IO.eprintln s!"[graspt-atlas] imported in {(← IO.monoMsNow) - t0} ms; scanning constants ..."
  let modNames := env.header.moduleNames
  -- 1. collect entries
  let mut entries : Array Entry := #[]
  let mut index : Std.HashMap Name Nat := {}
  for (n, ci) in env.constants.map₁.toList do
    unless keep env n ci do continue
    let some midx := env.getModuleIdxFor? n | continue
    let mod := modNames[midx.toNat]!
    let mut deps := ci.type.getUsedConstants
    if let some v := ci.value? (allowOpaque := true) then
      deps := deps ++ v.getUsedConstants
    index := index.insert n entries.size
    entries := entries.push { name := n, kind := kindOf ci, module := mod, area := areaOf mod 1, deps }
  IO.eprintln s!"[graspt-atlas] {entries.size} declarations"
  -- 2. in-degree (uses) and area graph
  let mut uses : Array Nat := Array.replicate entries.size 0
  let mut areaEdges : Std.HashMap (String × String) Nat := {}
  let mut areaCount : Std.HashMap String Nat := {}
  for e in entries do
    areaCount := areaCount.insert e.area (areaCount.getD e.area 0 + 1)
    let mut seen : Std.HashSet Nat := {}
    for d in e.deps do
      if let some j := index.get? d then
        if seen.contains j || entries[j]!.name == e.name then continue
        seen := seen.insert j
        uses := uses.modify j (· + 1)
        let a := entries[j]!.area
        if a != e.area then
          areaEdges := areaEdges.insert (e.area, a) (areaEdges.getD (e.area, a) 0 + 1)
  -- 3. landmarks: top-N by uses
  let order := (Array.range entries.size).qsort fun i j => uses[i]! > uses[j]!
  let top := order.extract 0 topN
  let topSet : Std.HashSet Nat := top.foldl (·.insert ·) {}
  let ctx : Core.Context := { fileName := "<graspt-atlas>", fileMap := default, maxHeartbeats := 0 }
  let cstate : Core.State := { env }
  let mut landmarks : Array Json := #[]
  for i in top do
    let e := entries[i]!
    let ty ← try
        let (fmt, _) ← (MetaM.run' (do ppExpr (← getConstInfo e.name).type)).toIO ctx cstate
        pure (fmt.pretty 120)
      catch _ => pure ""
    let ty := if ty.length > 400 then (ty.take 400).toString ++ " …" else ty
    let landmarkDeps := (e.deps.filterMap fun d => (index.get? d).filter topSet.contains)
      |>.toList.eraseDups.take 12 |>.map (fun j => toString entries[j]!.name)
    landmarks := landmarks.push <| Json.mkObj [
      ("name", toString e.name), ("kind", e.kind), ("module", toString e.module),
      ("area", e.area), ("uses", uses[i]!), ("type", ty), ("deps", toJson landmarkDeps)]
  -- 4. importance table (uses ≥ 2) : name ↦ [uses, area]
  let areas : Array String := (areaCount.toList.map (·.1)).toArray.qsort (· < ·)
  let areaIdx : Std.HashMap String Nat := (areas.zipIdx).foldl (fun m (a, i) => m.insert a i) {}
  let mut imp : Array (String × Json) := #[]
  for i in order do
    if uses[i]! < 2 then break
    let e : Entry := entries[i]!
    imp := imp.push (toString e.name, toJson [uses[i]!, areaIdx.getD e.area 0])
  let areaJson : Array Json := areas.map fun (a : String) => Json.mkObj [("id", a), ("decls", areaCount.getD a 0)]
  let edgeJson := (areaEdges.toList.filter (·.2 ≥ 20)).toArray.map fun ((s, t), w) =>
    Json.mkObj [("source", s), ("target", t), ("weight", w)]
  IO.FS.createDirAll outDir
  let atlas := Json.mkObj [
    ("roots", toJson (roots.map toString)), ("declarations", entries.size),
    ("areas", toJson areaJson), ("areaEdges", toJson edgeJson), ("landmarks", toJson landmarks)]
  IO.FS.writeFile (outDir / "atlas.json") (Json.compress atlas)
  IO.FS.writeFile (outDir / "importance.json") (Json.compress (Json.mkObj [
    ("areas", toJson areas), ("table", Json.mkObj imp.toList)]))
  IO.eprintln s!"[graspt-atlas] wrote {outDir} in {(← IO.monoMsNow) - t0} ms ({landmarks.size} landmarks, {imp.size} ranked names)"
  return 0
