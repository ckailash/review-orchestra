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
 * Returns true if:
 * 1. Same file AND lines within 5, AND
 * 2. EITHER Jaccard similarity of titles > 0.3,
 *    OR (same category AND lines within 3 AND at least one shared title token).
 *
 * The token-overlap requirement on the category-proximity branch avoids
 * collapsing unrelated bugs that happen to share a broad category and sit
 * within a few lines of each other (e.g. two distinct `logic` findings on
 * adjacent lines).
 */
export function isFuzzyMatch(a: Finding, b: Finding): boolean {
  if (a.file !== b.file) return false;
  if (Math.abs(a.line - b.line) > 5) return false;

  const titleTokensA = tokenize(a.title);
  const titleTokensB = tokenize(b.title);
  const titleSimilarity = jaccardSimilarity(titleTokensA, titleTokensB);
  if (titleSimilarity > 0.3) return true;

  if (
    a.category === b.category &&
    Math.abs(a.line - b.line) <= 3 &&
    titleSimilarity > 0
  ) {
    return true;
  }

  return false;
}
