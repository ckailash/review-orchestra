# Contributing to review-orchestra

## Development Setup

```bash
git clone https://github.com/ckailash/review-orchestra.git
cd review-orchestra
npm install
npm run build
review-orchestra setup
```

## Build & Test

```bash
npm run build    # Build with tsup (required before CLI testing)
npm test         # Run tests with Vitest
npm run lint     # Type-check with tsc --noEmit
```

The CLI binary (`dist/cli.js`) is a bundled file. Changes to `src/` are not reflected until you rebuild.

## Project Structure

- `src/` — TypeScript source
- `test/` — Vitest tests
- `config/` — Default configuration
- `skill/` — Claude Code skill definition
- `prompts/` — Review prompt templates
- `schemas/` — JSON schemas for structured output
- `evals/` — LLM eval harness

## Testing Approach

- **TDD** for deterministic components (scope detection, consolidator, config, state, parser)
- **Test-after** for LLM-facing components (reviewer adapters, orchestrator)
- **Evals** for review quality (`npm run eval`)

## Submitting Changes

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run `npm run build && npm test && npm run lint`
5. Submit a pull request

## Architecture

See `docs/plans/architecture.md` for design decisions and system overview.
