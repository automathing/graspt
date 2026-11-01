import Graspt.Trace

/-!
`graspt-trace` entry point.

* `graspt-trace FILE.lean`   – trace one file, print JSON.
* `graspt-trace --server`    – read JSON requests `{"file": ..., "content"?: ...}` line by
  line on stdin and answer with one JSON line each. Elaborated headers are cached, so
  only the first request pays for `import Mathlib`.
-/

open Lean Graspt

def handle (cache : IO.Ref HeaderCache) (file : String) (content? : Option String) : IO Json := do
  try
    let input ← match content? with
      | some c => pure c
      | none => IO.FS.readFile file
    let r ← traceInput file input cache
    return toJson r
  catch e =>
    return Json.mkObj [("file", file), ("error", toString e)]

unsafe def main (args : List String) : IO UInt32 := do
  initSearchPath (← findSysroot)
  enableInitializersExecution
  let cache ← IO.mkRef ({} : HeaderCache)
  match args with
  | ["--server"] =>
    let stdin ← IO.getStdin
    let stdout ← IO.getStdout
    stdout.putStrLn (Json.compress (Json.mkObj [("ready", true)]))
    stdout.flush
    repeat
      let line ← stdin.getLine
      if line.isEmpty then break
      let line := line.trimAscii.toString
      if line.isEmpty then continue
      let out ← match Json.parse line with
        | .error err => pure (Json.mkObj [("error", s!"bad request: {err}")])
        | .ok j =>
          let id := j.getObjValD "id"
          let file := (j.getObjValAs? String "file").toOption.getD ""
          let content := (j.getObjValAs? String "content").toOption
          let r ← handle cache file content
          pure (r.setObjVal! "id" id)
      stdout.putStrLn (Json.compress out)
      stdout.flush
    return 0
  | [file] =>
    let r ← handle cache file none
    IO.println (Json.compress r)
    return 0
  | _ =>
    IO.eprintln "usage: graspt-trace FILE.lean | graspt-trace --server"
    return 1
