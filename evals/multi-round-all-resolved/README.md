# Multi-Round All-Resolved Eval Fixture

Edge case: patch fixes all bugs, round 2 has zero current findings.

## Planted bugs (round 1)

1. **SQL injection in `getUser()`** — `userId` interpolated directly into SQL query
2. **Hardcoded API secret** — `API_SECRET` constant with plaintext credential

## Patch (between rounds)

`patches/fix-all.patch`:
- Fixes bug #1 (parameterizes the SQL query)
- Fixes bug #2 (moves secret to environment variable)
- Introduces no new bugs

## Expected round 2 state

- Zero current findings
- Both bugs resolved (with original r1 IDs preserved)

## What this tests

- The `currentFindings.length === 0` short-circuit in `compareFindings()`
- All-resolved scenario returns correct resolved list
