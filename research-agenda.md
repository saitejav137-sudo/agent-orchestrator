# Research Agenda — Agent Orchestrator

## Goal
Continuously improve the agent-orchestrator codebase through autonomous experimentation.
Focus on code quality, type safety, and robustness — the 330-test suite is the safety net.

## Current Priorities

1. **Type Safety** — Eliminate `any` usage, strengthen generic types, add missing type annotations
2. **Error Handling** — Improve error messages with actionable context, add proper error classes
3. **Code Quality** — Reduce function complexity, extract helpers, eliminate dead code
4. **Edge Cases** — Handle null/undefined more gracefully, add defensive checks
5. **Performance** — Optimize hot paths in session-manager and lifecycle-manager (they poll frequently)

## Constraints
- All 330 existing tests must continue to pass
- No breaking changes to plugin interfaces (types.ts)
- No new runtime dependencies
- Keep changes focused — one improvement per experiment
- Prefer idiomatic TypeScript patterns
- Do NOT modify test files

## What Has Been Tried
<!-- The agent will update this section as experiments run -->
_No experiments yet._

## Areas of Focus

### High Priority
- `packages/core/src/session-manager.ts` — 1156 lines, complex spawn/restore/cleanup logic
- `packages/core/src/lifecycle-manager.ts` — 612 lines, polling loop with many state transitions
- `packages/core/src/metadata.ts` — File-based metadata with key=value parsing

### Medium Priority
- `packages/core/src/paths.ts` — Hash-based directory management
- `packages/core/src/prompt-builder.ts` — Prompt composition
- `packages/core/src/utils.ts` — Shared utilities

### Lower Priority (but still valuable)
- `packages/plugins/agent-claude-code/src/index.ts` — 833 lines, complex JSONL parsing
- `packages/plugins/lifecycle-autoresearch/src/index.ts` — Improve itself!

## Anti-Patterns to Fix
- Functions over 50 lines → extract helper functions
- Nested try/catch blocks → use Result types or early returns
- String concatenation for paths → use path.join consistently
- Magic numbers → extract as named constants
- `catch {}` (empty catches) → at minimum log or comment why

## Notes
- The test suite runs in ~3 seconds — fast feedback loop
- Use `pnpm --filter @composio/ao-core test` for core tests
- The monorepo uses pnpm workspaces with TypeScript project references
