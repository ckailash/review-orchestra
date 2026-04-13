# Plan: Resolve symbolic git refs at parse time

**Status:** Not started
**Updated:** 2026-04-14

## Context

Session continuity breaks when users pass symbolic refs like `HEAD~N` as the scope. The first round captures `baseCommitSha` from the resolved ref (e.g., `617cb350...`), but if the user commits work between rounds, `HEAD~N` resolves to a different SHA. The session's `hasScopeBaseChanged` check then sees a different `baseCommitSha` and expires the session, so round 2 can't compare findings against round 1.

Real scenario that triggered this:
1. User runs `review-orchestra review HEAD~25 src/` on a 26-commit repo. Resolves to first commit.
2. Reviewer finds 15 issues, user fixes them and commits.
3. User re-runs `review-orchestra review HEAD~25 src/`. Now `HEAD~25` is commit #2 (because HEAD moved). Session expires, no cross-round comparison.

Workaround: users have to pass the literal SHA. That's a sharp edge for a feature that should Just Work.

## Approach

Resolve symbolic refs to concrete SHAs at CLI parse time, before session state sees them.

In `src/scope.ts` (wherever `commitRef` gets used to build the scope), add a normalisation step: if the incoming ref is symbolic (anything matching `HEAD`, `HEAD~N`, `HEAD^N`, branch name, tag name), run `git rev-parse <ref>` and use the resulting SHA. Store the SHA in the scope's `baseCommitSha`. Keep the original symbolic ref in `description` for human readability ("Changes since HEAD~25 (617cb350)").

This means:
- Round 1: user passes `HEAD~25` → resolves to `617cb350` → stored as baseCommitSha
- Round 2: user passes `HEAD~25` → resolves to `abc1234` (different) → CLI warns: "Scope ref `HEAD~25` now points to a different commit than round 1. Pass `617cb350` to continue the session, or reset."

Or silently pin to the round-1 SHA when the session is active and the user passes the same symbolic ref. The explicit warning is probably better UX — surprises around review scope are worse than a prompt.

## Files to touch

- `src/scope.ts` — resolve ref to SHA in `detectScope()`
- `src/parse-args.ts` — nothing (ref string already passed through)
- `src/state.ts` — optionally warn on symbolic-ref drift in `hasScopeBaseChanged`

## Testing

- Unit: `scope.test.ts` covering `HEAD~N`, branch names, tags, ranges (`abc..def`), bare SHAs (passthrough)
- Integration: two-round flow where a commit lands between rounds — should still compare findings round-over-round when user passes the same symbolic ref

## Out of scope

- Making `hasScopeBaseChanged` smarter about equivalent scopes (e.g., same files but described differently). Separate problem.
