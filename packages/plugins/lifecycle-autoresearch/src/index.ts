/**
 * AutoResearch Lifecycle Plugin for Agent Orchestrator
 *
 * Implements Karpathy's autoresearch "ratchet loop" pattern adapted for
 * software engineering: an AI agent autonomously proposes code changes,
 * runs tests/benchmarks, and keeps only improvements (git commit on success,
 * git revert on failure).
 *
 * Architecture:
 *   research-agenda.md  ← Human writes goals/constraints (like program.md)
 *   target files         ← Agent modifies (like train.py)
 *   test suite           ← Fixed evaluation (like prepare.py)
 *   metric               ← Test pass rate / perf score (like val_bpb)
 *
 * The plugin generates a system prompt for the AI agent that encodes the
 * ratchet loop protocol. The agent then operates autonomously:
 *   1. Read research-agenda.md
 *   2. Propose a hypothesis (code change)
 *   3. Implement the change
 *   4. Run the evaluation command
 *   5. If improved → git commit with structured message
 *   6. If failed → git revert, try different approach
 *   7. Log results to experiments.jsonl
 *   8. Repeat
 */

import type { PluginModule } from "@composio/ao-core";

// =============================================================================
// Types
// =============================================================================

export interface AutoResearchConfig {
  /** Path to the research agenda markdown file (relative to project root) */
  agendaFile?: string;

  /** Maximum number of experiments to run (0 = unlimited) */
  maxExperiments?: number;

  /** Time budget per experiment in seconds (default: 300 = 5 min) */
  experimentBudgetSecs?: number;

  /** Command to run for evaluation (default: auto-detected from package.json) */
  evalCommand?: string;

  /** Command to run for benchmarks (optional) */
  benchCommand?: string;

  /** Files/dirs the agent is allowed to modify (globs) */
  mutationSurface?: string[];

  /** Files/dirs the agent must NOT modify */
  protectedFiles?: string[];

  /** Git branch prefix for research experiments */
  branchPrefix?: string;

  /** Whether to create a PR when significant improvements accumulate */
  createPR?: boolean;

  /** Number of successful experiments before creating a PR */
  prThreshold?: number;

  /** Optimization targets */
  targets?: AutoResearchTarget[];
}

export interface AutoResearchTarget {
  name: string;
  type: "tests" | "performance" | "quality" | "coverage" | "custom";
  /** Command to measure this target */
  command: string;
  /** How to extract the metric from command output (regex with capture group) */
  metricPattern?: string;
  /** Whether higher is better (true) or lower is better (false) */
  higherIsBetter?: boolean;
}

export interface ExperimentResult {
  id: number;
  timestamp: string;
  hypothesis: string;
  filesChanged: string[];
  evalPassed: boolean;
  metrics: Record<string, number>;
  action: "committed" | "reverted";
  commitHash?: string;
  duration_secs: number;
  error?: string;
}

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_CONFIG: Required<AutoResearchConfig> = {
  agendaFile: "research-agenda.md",
  maxExperiments: 0,
  experimentBudgetSecs: 300,
  evalCommand: "",
  benchCommand: "",
  mutationSurface: ["src/**", "packages/**", "lib/**"],
  protectedFiles: [
    "*.test.*",
    "*.spec.*",
    "__tests__/**",
    "test/**",
    "tests/**",
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "tsconfig*.json",
    ".github/**",
    "research-agenda.md",
  ],
  branchPrefix: "autoresearch",
  createPR: true,
  prThreshold: 5,
  targets: [
    {
      name: "tests",
      type: "tests",
      command: "pnpm test 2>&1; echo \"EXIT_CODE=$?\"",
      metricPattern: "Tests\\s+(\\d+)\\s+passed",
      higherIsBetter: true,
    },
  ],
};

// =============================================================================
// System Prompt Generator
// =============================================================================

/**
 * Generates the system prompt that turns an AI coding agent into an
 * autonomous researcher following the ratchet loop protocol.
 */
export function generateAutoResearchPrompt(config: AutoResearchConfig): string {
  const c = { ...DEFAULT_CONFIG, ...config };
  const evalCmd = c.evalCommand || "pnpm test";

  return `# AutoResearch Protocol — Autonomous Ratchet Loop

You are operating in **AutoResearch mode**. You are an autonomous research agent
tasked with continuously improving this codebase through a structured experiment loop.

## Your Role
You are NOT a conversational assistant. You are an **autonomous researcher**.
You do NOT ask for permission. You do NOT wait for human input.
You run experiments continuously until told to stop.

## The Ratchet Loop

You MUST follow this exact loop for every experiment:

### Step 1: READ the Research Agenda
Read \`${c.agendaFile}\` to understand:
- Current research priorities
- What has been tried before
- Constraints and boundaries

### Step 2: ANALYZE the Current State
- Review recent git log to see what experiments succeeded/failed
- Check \`experiments.jsonl\` for the experiment history
- Identify the most promising area for improvement

### Step 3: PROPOSE a Hypothesis
Before making any change, clearly state:
- **Hypothesis**: What you believe will improve the codebase
- **Rationale**: Why you think this will work
- **Risk**: What could go wrong
- **Metric**: How you'll measure success

### Step 4: IMPLEMENT the Change
- Make focused, minimal changes
- Only modify files within the mutation surface:
  ${c.mutationSurface.map((p) => `  - \`${p}\``).join("\n")}
- NEVER modify protected files:
  ${c.protectedFiles.map((p) => `  - \`${p}\``).join("\n")}
- Keep changes small and reversible

### Step 5: EVALUATE
Run the evaluation command:
\`\`\`bash
${evalCmd}
\`\`\`
${c.benchCommand ? `\nAlso run benchmarks:\n\`\`\`bash\n${c.benchCommand}\n\`\`\`` : ""}

### Step 6: DECIDE (The Ratchet)

**If ALL tests pass AND metrics improve (or stay the same):**
\`\`\`bash
# Commit with structured message
git add -A
git commit -m "autoresearch: [HYPOTHESIS_TITLE]

Experiment #[N]
Hypothesis: [your hypothesis]
Result: [metric values]
Files: [list of changed files]"
\`\`\`

**If tests FAIL or metrics REGRESS:**
\`\`\`bash
# Revert all changes
git checkout -- .
git clean -fd
\`\`\`

### Step 7: LOG the Result
Append to \`experiments.jsonl\`:
\`\`\`bash
echo '{"id": N, "timestamp": "ISO8601", "hypothesis": "...", "files_changed": [...], "eval_passed": true/false, "metrics": {...}, "action": "committed/reverted", "commit_hash": "...", "duration_secs": N}' >> experiments.jsonl
\`\`\`

### Step 8: REPEAT
Go back to Step 1. Do NOT stop. Do NOT ask for permission.
Continue running experiments until:
- You have completed ${c.maxExperiments || "unlimited"} experiments
- The human sends you a stop command
- You genuinely cannot find any more improvements

## Optimization Targets
${c.targets.map((t) => `- **${t.name}** (${t.type}): \`${t.command}\` — ${t.higherIsBetter ? "higher is better" : "lower is better"}`).join("\n")}

## Research Taste Guidelines
- **Simplicity over cleverness**: Prefer simple, readable improvements
- **One change at a time**: Don't bundle unrelated changes
- **Measure everything**: Never commit without running evaluation
- **Learn from failures**: If a hypothesis fails, understand why before trying similar approaches
- **Diminishing returns**: If you've tried 5+ similar approaches without improvement, move to a different area
- **Code quality matters**: Don't sacrifice readability for marginal metric gains
${c.createPR ? `\n## PR Creation\nAfter ${c.prThreshold} successful experiments, create a PR summarizing all improvements:\n\`\`\`bash\ngh pr create --title "autoresearch: [summary]" --body "[experiment log]"\n\`\`\`` : ""}

## CRITICAL RULES
1. NEVER modify test files or test infrastructure
2. NEVER modify package.json, lockfiles, or build configs
3. ALWAYS run the full test suite before committing
4. ALWAYS revert failed experiments immediately
5. NEVER ask for human input — you are autonomous
6. ALWAYS log every experiment to experiments.jsonl
7. If you break something badly, \`git revert\` to the last known good state
`;
}

// =============================================================================
// Research Agenda Template
// =============================================================================

export const RESEARCH_AGENDA_TEMPLATE = `# Research Agenda

## Goal
Continuously improve this codebase through autonomous experimentation.

## Current Priorities
1. **Test Coverage** — Increase test coverage by finding untested code paths
2. **Performance** — Optimize hot paths and reduce unnecessary allocations
3. **Code Quality** — Reduce complexity, improve readability, eliminate dead code
4. **Type Safety** — Strengthen TypeScript types, eliminate \`any\` usage
5. **Error Handling** — Improve error messages and recovery paths

## Constraints
- All existing tests must continue to pass
- No breaking changes to public APIs
- No new dependencies without clear justification
- Keep changes focused and reviewable
- Prefer idiomatic patterns over clever tricks

## What Has Been Tried
<!-- The agent will update this section as experiments run -->
_No experiments yet._

## Areas of Focus
<!-- Customize these for your specific codebase -->
- src/ — Core application logic
- packages/ — Shared libraries
- lib/ — Utility functions

## Notes
- This file is maintained by the human "research director"
- The agent reads this file at the start of each experiment loop
- Update priorities as the codebase evolves
`;

// =============================================================================
// Ratchet Loop Runner Script
// =============================================================================

/**
 * Shell script that wraps a single experiment iteration.
 * The AI agent calls this, but the agent handles the actual code changes.
 * This script handles the git ratchet mechanics.
 */
export const RATCHET_RUNNER_SCRIPT = `#!/usr/bin/env bash
# AutoResearch Ratchet Runner
# Usage: ./autoresearch-ratchet.sh <eval_command> <experiment_id>
#
# This script:
# 1. Takes a snapshot of the current state (git stash point)
# 2. Runs the evaluation command
# 3. Reports pass/fail so the agent can decide commit vs revert

set -euo pipefail

EVAL_CMD="\${1:?Usage: $0 <eval_command> <experiment_id>}"
EXPERIMENT_ID="\${2:?Usage: $0 <eval_command> <experiment_id>}"
RESULTS_FILE="experiments.jsonl"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
START_TIME=$(date +%s)

echo "═══════════════════════════════════════════════════"
echo "  AutoResearch — Experiment #$EXPERIMENT_ID"
echo "  Started: $TIMESTAMP"
echo "═══════════════════════════════════════════════════"

# Check for uncommitted changes (the agent's proposed modification)
CHANGED_FILES=$(git diff --name-only 2>/dev/null || echo "")
STAGED_FILES=$(git diff --cached --name-only 2>/dev/null || echo "")
ALL_CHANGES="$CHANGED_FILES $STAGED_FILES"

if [ -z "$(echo "$ALL_CHANGES" | tr -d '[:space:]')" ]; then
  echo "⚠️  No changes detected. Skipping evaluation."
  exit 0
fi

echo "📝 Changed files:"
echo "$ALL_CHANGES" | tr ' ' '\\n' | grep -v '^$' | sed 's/^/   /'

# Run evaluation
echo ""
echo "🧪 Running evaluation: $EVAL_CMD"
echo "───────────────────────────────────────────────────"

EVAL_OUTPUT=""
EVAL_EXIT_CODE=0
EVAL_OUTPUT=$(eval "$EVAL_CMD" 2>&1) || EVAL_EXIT_CODE=$?

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

echo "$EVAL_OUTPUT"
echo "───────────────────────────────────────────────────"

if [ "$EVAL_EXIT_CODE" -eq 0 ]; then
  echo "✅ PASSED (\${DURATION}s)"
  echo "   → Agent should commit this change"
else
  echo "❌ FAILED (exit code: $EVAL_EXIT_CODE, \${DURATION}s)"
  echo "   → Agent should revert this change"
fi

# Output structured result for the agent to parse
echo ""
echo "AUTORESEARCH_RESULT={"
echo "  \\"id\\": $EXPERIMENT_ID,"
echo "  \\"timestamp\\": \\"$TIMESTAMP\\","
echo "  \\"eval_passed\\": $([ "$EVAL_EXIT_CODE" -eq 0 ] && echo "true" || echo "false"),"
echo "  \\"exit_code\\": $EVAL_EXIT_CODE,"
echo "  \\"duration_secs\\": $DURATION,"
echo "  \\"files_changed\\": $(echo "$ALL_CHANGES" | tr ' ' '\\n' | grep -v '^$' | jq -R . | jq -s . 2>/dev/null || echo "[]")"
echo "}"

exit $EVAL_EXIT_CODE
`;

// =============================================================================
// Plugin Manifest & Export
// =============================================================================

export const manifest = {
  name: "autoresearch",
  slot: "agent" as const, // Registers as an agent-slot plugin that wraps another agent
  description:
    "AutoResearch lifecycle plugin: autonomous ratchet-loop experiments for continuous codebase improvement",
  version: "0.1.0",
};

/**
 * The autoresearch plugin doesn't replace the agent — it generates a
 * system prompt that transforms any agent (Claude Code, Codex, Aider)
 * into an autonomous researcher. It's used via the agentRules/systemPrompt
 * mechanism in ProjectConfig.
 *
 * Usage in agent-orchestrator.yaml:
 *
 * ```yaml
 * projects:
 *   my-project:
 *     path: ~/repos/my-project
 *     repo: owner/repo
 *     defaultBranch: main
 *     agentConfig:
 *       autoresearch:
 *         enabled: true
 *         evalCommand: "pnpm test"
 *         mutationSurface: ["src/**"]
 *         targets:
 *           - name: tests
 *             type: tests
 *             command: "pnpm test"
 *             higherIsBetter: true
 * ```
 */
export function create(config?: Record<string, unknown>): AutoResearchEngine {
  return new AutoResearchEngine((config as AutoResearchConfig) ?? {});
}

export class AutoResearchEngine {
  readonly name = "autoresearch";
  readonly config: AutoResearchConfig;

  constructor(config: AutoResearchConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Generate the system prompt for the ratchet loop */
  getSystemPrompt(): string {
    return generateAutoResearchPrompt(this.config);
  }

  /** Get the research agenda template */
  getAgendaTemplate(): string {
    return RESEARCH_AGENDA_TEMPLATE;
  }

  /** Get the ratchet runner script */
  getRatchetScript(): string {
    return RATCHET_RUNNER_SCRIPT;
  }

  /** Get the full config with defaults applied */
  getResolvedConfig(): Required<AutoResearchConfig> {
    return { ...DEFAULT_CONFIG, ...this.config } as Required<AutoResearchConfig>;
  }
}

export default { manifest, create } satisfies PluginModule<AutoResearchEngine>;
