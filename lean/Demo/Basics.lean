import Mathlib.Topology.Compactness.Compact
import Mathlib.Topology.Separation.Hausdorff
import Mathlib.Algebra.Group.Even
import Mathlib.Tactic

/-!
# Graspt demo: small proofs across different regions of Mathlib

Each theorem touches a different "continent" of the atlas (topology, algebra, number
theory), so the map shows where in the convex hull of known mathematics the proof lives.
-/

namespace Demo.Basics

/-- Topology: a continuous image of a compact set in a Hausdorff space is closed. -/
theorem compact_image_closed {X Y : Type*} [TopologicalSpace X] [TopologicalSpace Y]
    [T2Space Y] {s : Set X} {f : X → Y} (hs : IsCompact s) (hf : Continuous f) :
    IsClosed (f '' s) := by
  have h : IsCompact (f '' s) := hs.image hf
  exact h.isClosed

/-- Algebra: the sum of two even naturals is even. -/
theorem even_add_even (a b : ℕ) (ha : Even a) (hb : Even b) : Even (a + b) := by
  obtain ⟨x, hx⟩ := ha
  obtain ⟨y, hy⟩ := hb
  refine ⟨x + y, ?_⟩
  rw [hx, hy]
  ring

/-- Number theory: `n (n+1)` is always even. A frontier left open for exploration. -/
theorem two_dvd_mul_succ (n : ℕ) : 2 ∣ n * (n + 1) := by
  sorry

end Demo.Basics
