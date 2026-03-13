# Eval Fixture: mixed-severity

## Planted Bugs

This fixture contains a small Express API module with four issues across all severity levels:

1. **getUser() — sensitive data exposure [critical]**: The endpoint runs `SELECT *` and returns the entire user row to the client, including `password_hash` and `api_key`. Should select only safe fields or strip sensitive ones before responding.

2. **listUsers() — wrong pagination offset [functional]**: The offset is calculated as `page * pageSize` instead of `(page - 1) * pageSize`. Page 1 skips the first `pageSize` results entirely. Users never see the first page of data.

3. **deleteUser() — no error handling [quality]**: Database errors propagate as unhandled promise rejections. Should have a try/catch that returns a 500 response. Not a correctness bug per se, but a reliability/maintainability problem.

4. **max_retries constant — inconsistent naming [nitpick]**: Uses `snake_case` (`max_retries`) in a TypeScript codebase where the convention is `camelCase`. Should be `maxRetries`. This is purely stylistic.

## Expected Reviewer Behavior

A good reviewer should find all four and classify them at different severity levels. The critical and functional issues should be flagged with high confidence. The quality issue should be caught but might be classified as lower severity. The nitpick may or may not be reported depending on the reviewer's threshold.
