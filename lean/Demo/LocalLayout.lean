import Mathlib.Tactic

/-!
# Piccinini's local-layout navigation machine (arXiv:2603.27926, §6)

Memory landmarks live on the two-row track `ℤ × {0,1}`. A machine standing on a landmark
sees only its local *type* `A | B | C | D` and two fixed dictionaries telling it which
compass direction leads to the predecessor / successor landmark. The linear tape order
exists only in the metatheory, via the zig-zag enumeration `ρ` (Lemma 6.3).

Open this file with the Graspt map to see the proof of Lemma 6.3 as a topological graph:
one theorem goal, a four-way case split on `i % 4`, every branch grounded in the known.
-/

namespace Demo.LocalLayout

inductive Dir | N | S | E | W
  deriving DecidableEq, Repr

inductive LandmarkType | A | B | C | D
  deriving DecidableEq, Repr

def dirVec : Dir → ℤ × ℤ
  | .N => (0, 1)
  | .S => (0, -1)
  | .E => (1, 0)
  | .W => (-1, 0)

/-- Table 2: local predecessor direction. -/
def predDir : LandmarkType → Dir
  | .A => .W | .B => .S | .C => .W | .D => .N

/-- Table 2: local successor direction. -/
def succDir : LandmarkType → Dir
  | .A => .N | .B => .E | .C => .S | .D => .E

/-- Definition 6.1: the landmark type is a *local* property (parity of `x`, row `y`). -/
def landmarkType (p : ℤ × ℤ) : LandmarkType :=
  if p.1 % 2 = 0 then (if p.2 = 0 then .A else .B)
  else (if p.2 = 1 then .C else .D)

/-- One successor move, using only what is visible at the current landmark. -/
def stepSucc (p : ℤ × ℤ) : ℤ × ℤ :=
  p + dirVec (succDir (landmarkType p))

/-- One predecessor move, using only what is visible at the current landmark. -/
def stepPred (p : ℤ × ℤ) : ℤ × ℤ :=
  p + dirVec (predDir (landmarkType p))

/-- Lemma 6.3 (metatheory): the zig-zag enumeration of the track. -/
def ρ (i : ℤ) : ℤ × ℤ :=
  if i % 4 = 0 then (2 * (i / 4), 0)
  else if i % 4 = 1 then (2 * (i / 4), 1)
  else if i % 4 = 2 then (2 * (i / 4) + 1, 1)
  else (2 * (i / 4) + 1, 0)

/-- Lemma 6.3: following the purely local successor cue is `i ↦ i + 1` on the tape. -/
theorem stepSucc_ρ (i : ℤ) : stepSucc (ρ i) = ρ (i + 1) := by
  have h : i % 4 = 0 ∨ i % 4 = 1 ∨ i % 4 = 2 ∨ i % 4 = 3 := by omega
  rcases h with h | h | h | h
  · have h1 : (i + 1) % 4 = 1 := by omega
    have h2 : (i + 1) / 4 = i / 4 := by omega
    simp [stepSucc, ρ, landmarkType, succDir, dirVec, h, h1, h2, Int.mul_emod_right]
  · have h1 : (i + 1) % 4 = 2 := by omega
    have h2 : (i + 1) / 4 = i / 4 := by omega
    simp [stepSucc, ρ, landmarkType, succDir, dirVec, h, h1, h2, Int.mul_emod_right]
  · have h1 : (i + 1) % 4 = 3 := by omega
    have h2 : (i + 1) / 4 = i / 4 := by omega
    have h3 : (2 * (i / 4) + 1) % 2 = 1 := by omega
    simp [stepSucc, ρ, landmarkType, succDir, dirVec, h, h1, h2, h3]
  · have h1 : (i + 1) % 4 = 0 := by omega
    have h2 : (i + 1) / 4 = i / 4 + 1 := by omega
    have h3 : (2 * (i / 4) + 1) % 2 = 1 := by omega
    simp [stepSucc, ρ, landmarkType, succDir, dirVec, h, h1, h2, h3]
    ring

/-- Lemma 6.3, predecessor half. Left as a frontier for agent-assisted exploration. -/
theorem stepPred_ρ (i : ℤ) : stepPred (ρ i) = ρ (i - 1) := by
  have h : i % 4 = 0 ∨ i % 4 = 1 ∨ i % 4 = 2 ∨ i % 4 = 3 := by omega
  rcases h with h | h | h | h
  · sorry
  · sorry
  · sorry
  · sorry

end Demo.LocalLayout
