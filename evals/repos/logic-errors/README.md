# Eval Fixture: logic-errors

## Planted Bugs

This fixture contains a small calculator/utility module with two logic errors:

1. **average() — off-by-one error**: The loop starts at `i = 1` instead of `i = 0`, skipping the first element. The sum is wrong but it still divides by the full `numbers.length`, producing an incorrect average. For a single-element array, it returns 0 instead of the element's value.

2. **filterRange() — wrong comparison operator**: Uses `item < max` instead of `item <= max`. The docstring says the range is inclusive `[min, max]`, but the upper bound is actually exclusive. Values exactly equal to `max` are incorrectly excluded.

## Correct Functions

- **clamp()** is correctly implemented (no bugs planted).
- **percentage()** is correctly implemented (no bugs planted).

## Expected Reviewer Behavior

Both bugs are functional/logic errors that a reviewer should catch with high confidence. The off-by-one is a classic pattern. The comparison operator bug is identifiable by reading the docstring contract vs. the implementation.
