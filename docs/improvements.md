# Future Improvements

## Eval Harness

### Statistical confidence (`--runs N`)
Run each fixture N times and report aggregate stats (mean, stddev, min/max) for precision, recall, and severity accuracy. LLM reviewers are non-deterministic — single-run point estimates don't tell you if 60% recall is typical or an outlier. A `--runs N` flag on `npm run eval` with aggregate reporting would close this gap.

### Larger synthetic repos
All current fixtures are small (12-50 lines per file, ~200 lines total). Real reviews cover diffs spanning hundreds of lines across dozens of files. Reviewer performance on trivial code doesn't predict production performance. Add at least one fixture with a realistic-sized codebase (500+ lines, 10+ files).

### Cross-file data flow fixtures
Current fixtures have bugs self-contained within single files. Add a fixture where the vulnerability requires tracing data from one file through another to a third — e.g., user input accepted in a controller, passed through a service layer, and used unsafely in a data access layer. This tests reviewer capability, not the harness, but having the fixture measures it.

### Broader bug categories
Current coverage is heavy on SQL injection and data exposure. Missing categories: ReDoS, prototype pollution, SSRF, auth/authz logic errors, async race conditions, type coercion bugs, null reference chains. Each new category is just a fixture + golden file — the harness is category-agnostic.

## Consolidator

### Semantic dedup for wide line gaps
The fuzzy dedup uses a 5-line proximity threshold. When two reviewers point at different parts of the same function (e.g., one at the query, one at the return statement 8 lines later), the same finding can survive dedup. Widening the threshold causes false merges in dense code. Options: function-aware grouping (needs a parser), or LLM-based dedup as a third pass after heuristic dedup.

## Reviewers

### Diff-in-prompt mode
Current approach sends file lists and reviewers read from disk. A future mode could inline the diff in the prompt for "dumb pipe" reviewers with no file access. See architecture.md "Future: Diff-in-prompt mode" for details.
