/**
 * Calculates the average of an array of numbers.
 * Returns 0 for empty arrays.
 */
export function average(numbers: number[]): number {
  if (numbers.length === 0) return 0;

  let sum = 0;
  // BUG: Off-by-one — starts at index 1, skips the first element
  for (let i = 1; i < numbers.length; i++) {
    sum += numbers[i];
  }
  return sum / numbers.length;
}

/**
 * Returns elements from the array that fall within the
 * inclusive range [min, max].
 */
export function filterRange(items: number[], min: number, max: number): number[] {
  // BUG: Wrong comparison operator — uses < instead of <= for max,
  // making the upper bound exclusive instead of inclusive
  return items.filter((item) => item >= min && item < max);
}

/**
 * Clamps a value to the given [min, max] range.
 */
export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Computes the percentage that `part` is of `total`.
 * Returns 0 if total is zero.
 */
export function percentage(part: number, total: number): number {
  if (total === 0) return 0;
  return (part / total) * 100;
}
