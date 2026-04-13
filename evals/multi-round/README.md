# Multi-Round Eval Fixture

Tests cross-round orchestration: state continuity, finding status transitions, ID preservation, resolved detection.

## Planted bugs (round 1)

1. **SQL injection in `getUser()`** — `userId` interpolated directly into SQL query
2. **Missing input validation in `createUser()`** — no validation on name/email params
3. **Hardcoded database password** — `DB_PASSWORD` constant with plaintext credential

## Patch (between rounds)

`patches/fix-round1.patch`:
- **Fixes** bug #1 (parameterizes the SQL query)
- **Introduces** bug #4: path traversal in new `exportUser()` function (user-controlled `filename` joined unsafely)

## Expected round 2 state

- Bug #1: resolved (with original r1 ID preserved)
- Bug #2: persisting (with original r1 ID, severity changes from functional→quality)
- Bug #3: persisting (with original r1 ID)
- Bug #4: new (with r2 ID)

## What this tests

- Round-scoped ID preservation for persisting findings
- Exact ID lineage on resolved findings (not just prefix check)
- Status transitions (new→persisting, new→resolved, regression=new)
- pre_existing tagging via real diff-based scope
- Metadata freshness on persisting findings (severity intentionally differs between rounds)
