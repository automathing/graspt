import Mathlib.Tactic
import Mathlib.Algebra.BigOperators.Group.Finset.Basic

/-!
# Graspt demo: induction-shaped proofs

Three different induction arguments — over sums, divisibility, and lists —
so the map shows branching case splits grounded step by step in the known.
-/

namespace Demo.Induction

/-- The sum of the first `n` odd numbers is `n ^ 2`. -/
theorem sum_odds (n : ℕ) : ∑ i ∈ Finset.range n, (2 * i + 1) = n ^ 2 := by
  induction n with
  | zero => simp
  | succ n ih =>
    rw [Finset.sum_range_succ, ih]
    ring

/-- `n * (n + 1)` is always even — the proved version of the Basics frontier. -/
theorem two_dvd_mul_succ_proved (n : ℕ) : 2 ∣ n * (n + 1) := by
  induction n with
  | zero => exact dvd_zero 2
  | succ n ih =>
    obtain ⟨k, hk⟩ := ih
    refine ⟨k + (n + 1), ?_⟩
    have h : (n + 1) * (n + 1 + 1) = n * (n + 1) + 2 * (n + 1) := by ring
    rw [h, hk]
    ring

/-- Reversing a list twice gives the list back. -/
theorem reverse_reverse (xs : List ℕ) : xs.reverse.reverse = xs := by
  induction xs with
  | nil => rfl
  | cons a xs ih => simp [List.reverse_cons, ih]

end Demo.Induction
