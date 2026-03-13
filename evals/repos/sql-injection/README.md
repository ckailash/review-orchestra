# Eval Fixture: sql-injection

## Planted Bugs

This fixture contains a small authentication module with three SQL injection vulnerabilities:

1. **login()** — `username` is interpolated directly into a SELECT query via template literal. An attacker can bypass authentication with input like `' OR '1'='1`.

2. **register()** — Both `username` and `passwordHash` are interpolated into an INSERT query. While the hash is not user-controlled, the username is.

3. **findUsersByRole()** — `role` parameter is interpolated into a SELECT query. Less obvious since "role" sounds like an internal value, but it could come from user input depending on the caller.

All three should use parameterized queries (e.g., `db.query('SELECT ... WHERE username = $1', [username])`).

## Expected Reviewer Behavior

A competent reviewer should flag all three as critical/verified SQL injection vulnerabilities. The `login()` case is the most dangerous since it directly enables auth bypass.
