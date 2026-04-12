# Eval Fixture: clean-code

## Purpose

This fixture contains correct, well-written code with no bugs. It tests the
false positive rate — a good reviewer should report zero or near-zero findings.

Any findings reported against this code are hallucinations, measuring how much
noise the reviewers produce on clean code.

## What's in the code

A small user service module with:
- Parameterized SQL queries (no injection)
- Proper error handling with try/catch
- Input validation at the boundary
- No sensitive data exposure (explicit field selection)
- Async/await used correctly
- No hardcoded secrets (config-based)

## Expected Reviewer Behavior

Zero findings. Any finding is a false positive.
