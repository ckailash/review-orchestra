import type { Finding } from "./types.js";

/**
 * Tokenize text for fuzzy comparison.
 * Lowercases, strips all punctuation (non-alphanumeric non-whitespace),
 * splits on whitespace, and filters tokens with length <= 1.
 */
export function tokenize(text: string): Set<string> {
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "");
  const tokens = normalized.split(/\s+/).filter((t) => t.length > 1);
  return new Set(tokens);
}

/**
 * Compute Jaccard similarity between two token sets.
 * Returns |intersection| / |union|. Returns 0 if both sets are empty.
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;

  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }

  const union = a.size + b.size - intersection;
  if (union === 0) return 0;

  return intersection / union;
}

/**
 * Determine if two findings are fuzzy-matches (likely the same bug).
 * Returns true if ALL of:
 * 1. Same file
 * 2. Lines within 5
 * 3. EITHER Jaccard similarity of titles > 0.3,
 *    OR (same category AND lines within 3)
 */
export function isFuzzyMatch(a: Finding, b: Finding): boolean {
  if (a.file !== b.file) return false;
  if (Math.abs(a.line - b.line) > 5) return false;

  const titleSimilarity = jaccardSimilarity(tokenize(a.title), tokenize(b.title));
  if (titleSimilarity > 0.3) return true;

  if (a.category === b.category && Math.abs(a.line - b.line) <= 3) return true;

  return false;
}
