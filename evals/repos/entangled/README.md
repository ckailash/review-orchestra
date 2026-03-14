# entangled fixture

Multi-file fixture designed to test the fix→re-review loop. Contains 12 planted bugs
across 4 files with cross-file dependencies that make single-pass fixing difficult.

## Design goals

1. **Cross-file root cause**: `db.ts` lacks parameterized queries. This is the root cause
   of SQL injection in `users.ts` and `session.ts`. A fixer that patches call sites without
   fixing `db.ts` leaves the systemic issue in place. A fixer that fixes `db.ts` must also
   update `transaction()` and all call sites.

2. **Naive fix traps**: `uploads.ts` has a path traversal bug where the obvious fix
   (`filename.includes('..')`) is insufficient. A good fixer uses `path.resolve()` +
   `startsWith()`. A weak fixer uses string matching. Round 2 should catch the weak fix.

3. **Intertwined bugs**: `session.ts` has a session expiry bug (born expired) that interacts
   with the expiry check. Fixing the expiry without understanding the check could invert
   the logic.

## Planted bugs

| # | File | Bug | Severity | Multi-round trigger? |
|---|------|-----|----------|---------------------|
| 1 | users.ts | SQL injection in getUser (root: db.ts) | P0 | Yes — systemic fix needed |
| 2 | users.ts | Sensitive data exposure (returns password_hash, api_key) | P0 | No |
| 3 | users.ts | SQL injection in searchUsers + unescaped LIKE wildcards | P0 | Yes — systemic fix needed |
| 4 | users.ts | SQL injection in updateUserRole via transaction() | P0 | Yes — transaction() also needs params |
| 5 | users.ts | Timing side-channel in password comparison | P1 | No |
| 6 | uploads.ts | Path traversal in saveUpload | P0 | Yes — naive fix is insufficient |
| 7 | uploads.ts | No file size limit | P2 | No |
| 8 | uploads.ts | TOCTOU race in saveUploadExclusive | P1 | No |
| 9 | session.ts | Insecure token generation (Math.random) | P0 | No |
| 10 | session.ts | Session born expired (subtraction instead of addition) | P1 | No |
| 11 | session.ts | SQL injection in audit logging | P0 | Yes — same db.ts root cause |
| 12 | session.ts | Synchronous session cleanup blocks event loop | P2 | No |

## Expected multi-round behavior

**Round 1**: Reviewers find most/all bugs. Fixer attempts fixes.
**Likely round 1 fix issues**:
- Fixer patches SQL injection at call sites (escaping) instead of fixing db.ts → round 2 catches systemic issue
- Fixer adds weak path traversal check (string contains "..") → round 2 catches insufficient mitigation
- Fixer updates db.query() for parameterized queries but misses transaction() → round 2 catches remaining injection

**Round 2**: Re-review catches incomplete/weak fixes from round 1.
