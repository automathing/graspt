import Mathlib.Tactic
import Mathlib.Data.Set.Basic
import Mathlib.Algebra.Order.Group.Abs

/-!
# Graspt demo: structure-shaped proofs across Mathlib areas

Set identities, an order inequality, and divisibility plumbing — each proof
leans on landmarks from a different continent of the atlas, so landmark
colours separate cleanly on the map.
-/

namespace Demo.Structures

/-- Set theory: intersection distributes over union. -/
theorem inter_union_distrib (s t u : Set ℕ) : s ∩ (t ∪ u) = (s ∩ t) ∪ (s ∩ u) := by
  ext x
  simp only [Set.mem_inter_iff, Set.mem_union]
  tauto

/-- Order/algebra: `2ab ≤ a² + b²` for reals, from the square being nonnegative. -/
theorem two_mul_le_add_sq (a b : ℝ) : 2 * a * b ≤ a ^ 2 + b ^ 2 := by
  have h : 0 ≤ (a - b) ^ 2 := sq_nonneg (a - b)
  nlinarith

/-- Number theory: divisibility is preserved under addition. -/
theorem dvd_add_of_dvd (a b c : ℕ) (hab : a ∣ b) (hac : a ∣ c) : a ∣ b + c := by
  exact Nat.dvd_add hab hac

/-- A frontier left open for exploration: any `n ≠ 1` has a prime divisor. -/
theorem exists_prime_dvd (n : ℕ) (hn : n ≠ 1) : ∃ p, Nat.Prime p ∧ p ∣ n := by
  sorry

end Demo.Structures
