/**
 * ao research — CLI command for managing AutoResearch sessions.
 *
 * Subcommands:
 *   ao research init <project>        — Initialize autoresearch in a project
 *   ao research start <project>       — Start an autoresearch session
 *   ao research status [project]      — Show autoresearch experiment status
 *   ao research log [project]         — Show experiment history
 */

import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import { loadConfig, type OrchestratorConfig } from "@composio/ao-core";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { getSessionManager } from "../lib/create-session-manager.js";
import { banner } from "../lib/format.js";
import { preflight } from "../lib/preflight.js";
import {
  analyzeExperiments,
  formatAnalyticsReport,
  suggestNextArea,
  type AnalyticsExperimentEntry,
} from "@composio/ao-plugin-lifecycle-autoresearch";

// =============================================================================
// Research Agenda Template (inline to avoid cross-package import at CLI level)
// =============================================================================

const RESEARCH_AGENDA_TEMPLATE = `# Research Agenda

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
// AutoResearch System Prompt Generator
// =============================================================================

interface AutoResearchOpts {
  agendaFile: string;
  evalCommand: string;
  benchCommand?: string;
  mutationSurface: string[];
  protectedFiles: string[];
  maxExperiments: number;
  createPR: boolean;
  prThreshold: number;
}

function generateAutoResearchPrompt(opts: AutoResearchOpts): string {
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
Read \`${opts.agendaFile}\` to understand:
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
${opts.mutationSurface.map((p) => `  - \`${p}\``).join("\n")}
- NEVER modify protected files:
${opts.protectedFiles.map((p) => `  - \`${p}\``).join("\n")}
- Keep changes small and reversible

### Step 5: EVALUATE
Run the evaluation command:
\`\`\`bash
${opts.evalCommand}
\`\`\`
${opts.benchCommand ? `\nAlso run benchmarks:\n\`\`\`bash\n${opts.benchCommand}\n\`\`\`` : ""}

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
- You have completed ${opts.maxExperiments || "unlimited"} experiments
- The human sends you a stop command
- You genuinely cannot find any more improvements

## Research Taste Guidelines
- **Simplicity over cleverness**: Prefer simple, readable improvements
- **One change at a time**: Don't bundle unrelated changes
- **Measure everything**: Never commit without running evaluation
- **Learn from failures**: If a hypothesis fails, understand why before trying similar approaches
- **Diminishing returns**: If you've tried 5+ similar approaches without improvement, move to a different area
- **Code quality matters**: Don't sacrifice readability for marginal metric gains
${opts.createPR ? `\n## PR Creation\nAfter ${opts.prThreshold} successful experiments, create a PR summarizing all improvements:\n\`\`\`bash\ngh pr create --title "autoresearch: [summary]" --body "[experiment log]"\n\`\`\`` : ""}

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
// Init Subcommand
// =============================================================================

async function handleInit(
  projectId: string,
  opts: { eval?: string; bench?: string; surface?: string },
): Promise<void> {
  const config = loadConfig();
  const project = config.projects[projectId];

  if (!project) {
    console.error(
      chalk.red(
        `Unknown project: ${projectId}\nAvailable: ${Object.keys(config.projects).join(", ")}`,
      ),
    );
    process.exit(1);
  }

  const projectPath = resolve(project.path.replace(/^~/, process.env["HOME"] || ""));
  console.log(banner("AUTORESEARCH INIT"));
  console.log();
  console.log(`  Project: ${chalk.bold(projectId)}`);
  console.log(`  Path:    ${chalk.dim(projectPath)}`);
  console.log();

  // Default config
  const evalCommand = opts.eval || "pnpm test";
  const benchCommand = opts.bench;
  const mutationSurface = opts.surface
    ? opts.surface.split(",").map((s) => s.trim())
    : ["src/**", "packages/**", "lib/**"];
  const protectedFiles = [
    "*.test.*",
    "*.spec.*",
    "__tests__/**",
    "test/**",
    "tests/**",
    "package.json",
    "pnpm-lock.yaml",
    "tsconfig*.json",
    ".github/**",
    "research-agenda.md",
  ];

  // 1. Create research-agenda.md
  const agendaPath = join(projectPath, "research-agenda.md");
  if (!existsSync(agendaPath)) {
    writeFileSync(agendaPath, RESEARCH_AGENDA_TEMPLATE, "utf-8");
    console.log(chalk.green("  ✓ Created research-agenda.md"));
  } else {
    console.log(chalk.dim("  ○ research-agenda.md already exists"));
  }

  // 2. Create .autoresearch/ directory
  const arDir = join(projectPath, ".autoresearch");
  mkdirSync(arDir, { recursive: true });
  console.log(chalk.green("  ✓ Created .autoresearch/ directory"));

  // 3. Create experiments.jsonl
  const expPath = join(projectPath, "experiments.jsonl");
  if (!existsSync(expPath)) {
    writeFileSync(expPath, "", "utf-8");
    console.log(chalk.green("  ✓ Created experiments.jsonl"));
  }

  // 4. Write config
  const arConfig = {
    agendaFile: "research-agenda.md",
    evalCommand,
    benchCommand: benchCommand || "",
    mutationSurface,
    protectedFiles,
    maxExperiments: 0,
    createPR: true,
    prThreshold: 5,
  };
  writeFileSync(join(arDir, "config.json"), JSON.stringify(arConfig, null, 2) + "\n", "utf-8");
  console.log(chalk.green("  ✓ Created .autoresearch/config.json"));

  // 5. Generate system prompt
  const systemPrompt = generateAutoResearchPrompt(arConfig);
  writeFileSync(join(arDir, "system-prompt.md"), systemPrompt, "utf-8");
  console.log(chalk.green("  ✓ Generated system prompt"));

  // 6. Update .gitignore
  const gitignorePath = join(projectPath, ".gitignore");
  const gitignoreEntry =
    "\n# AutoResearch\nexperiments.jsonl\n.autoresearch/\nautoresearch-ratchet.sh\n";
  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, "utf-8");
    if (!content.includes("AutoResearch")) {
      writeFileSync(gitignorePath, content + gitignoreEntry, "utf-8");
      console.log(chalk.green("  ✓ Updated .gitignore"));
    }
  }

  console.log();
  console.log(chalk.bold.green("  🔬 AutoResearch initialized!"));
  console.log();
  console.log("  Next steps:");
  console.log(`    1. Edit ${chalk.cyan("research-agenda.md")} with your priorities`);
  console.log(`    2. Run: ${chalk.cyan(`ao research start ${projectId}`)}`);
  console.log(`       Or:  ${chalk.cyan(`ao spawn ${projectId} --mode autoresearch`)}`);
  console.log();
}

// =============================================================================
// Start Subcommand
// =============================================================================

async function handleStart(
  projectId: string,
  opts: { open?: boolean; experiments?: string },
): Promise<void> {
  const config = loadConfig();
  const project = config.projects[projectId];

  if (!project) {
    console.error(
      chalk.red(
        `Unknown project: ${projectId}\nAvailable: ${Object.keys(config.projects).join(", ")}`,
      ),
    );
    process.exit(1);
  }

  const projectPath = resolve(project.path.replace(/^~/, process.env["HOME"] || ""));
  const arConfigPath = join(projectPath, ".autoresearch", "config.json");
  const promptPath = join(projectPath, ".autoresearch", "system-prompt.md");

  if (!existsSync(arConfigPath)) {
    console.error(
      chalk.red(`AutoResearch not initialized for ${projectId}.\nRun: ao research init ${projectId}`),
    );
    process.exit(1);
  }

  console.log(banner("AUTORESEARCH START"));
  console.log();
  console.log(`  Project: ${chalk.bold(projectId)}`);
  console.log(`  Mode:    ${chalk.cyan("Autonomous Ratchet Loop")}`);
  console.log();

  // Pre-flight checks
  const runtime = project.runtime ?? config.defaults.runtime;
  if (runtime === "tmux") {
    await preflight.checkTmux();
  }

  const spinner = ora("Starting autoresearch session").start();

  try {
    const sm = await getSessionManager(config);

    // Read autoresearch system prompt and pass as the session prompt
    let systemPrompt = "";
    if (existsSync(promptPath)) {
      systemPrompt = readFileSync(promptPath, "utf-8");
    }

    const maxExp = opts.experiments ? parseInt(opts.experiments, 10) : 0;
    if (maxExp > 0) {
      systemPrompt = systemPrompt.replace(/unlimited/g, String(maxExp));
    }

    const session = await sm.spawn({
      projectId,
      branch: `autoresearch/${new Date().toISOString().slice(0, 10)}`,
      prompt: systemPrompt,
    });

    spinner.succeed(`AutoResearch session ${chalk.green(session.id)} created`);

    console.log(`  Worktree: ${chalk.dim(session.workspacePath ?? "-")}`);
    if (session.branch) console.log(`  Branch:   ${chalk.dim(session.branch)}`);

    const tmuxTarget = session.runtimeHandle?.id ?? session.id;
    console.log(`  Attach:   ${chalk.dim(`tmux attach -t ${tmuxTarget}`)}`);
    console.log();

    console.log(chalk.bold("  The agent is now running autonomously."));
    console.log(chalk.dim("  It will propose → test → commit/revert in a loop."));
    console.log(chalk.dim("  Check status: ao research status " + projectId));
    console.log(chalk.dim("  View logs:    ao research log " + projectId));
    console.log(chalk.dim("  Stop:         ao session kill " + session.id));
    console.log();

    console.log(`SESSION=${session.id}`);
  } catch (err) {
    spinner.fail("Failed to start autoresearch session");
    console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }
}

// =============================================================================
// Status Subcommand
// =============================================================================

interface ExperimentLogEntry {
  id: number;
  timestamp: string;
  hypothesis: string;
  files_changed: string[];
  eval_passed: boolean;
  metrics: Record<string, number>;
  action: "committed" | "reverted";
  commit_hash?: string;
  duration_secs: number;
}

async function handleStatus(projectId: string): Promise<void> {
  const config = loadConfig();
  const project = config.projects[projectId];

  if (!project) {
    console.error(
      chalk.red(
        `Unknown project: ${projectId}\nAvailable: ${Object.keys(config.projects).join(", ")}`,
      ),
    );
    process.exit(1);
  }

  const projectPath = resolve(project.path.replace(/^~/, process.env["HOME"] || ""));
  const expPath = join(projectPath, "experiments.jsonl");

  console.log(banner("AUTORESEARCH STATUS"));
  console.log();

  if (!existsSync(expPath)) {
    console.log(
      chalk.dim("  No experiments recorded yet. Run: ao research start " + projectId),
    );
    return;
  }

  const entries = parseExperimentsFile(expPath);

  if (entries.length === 0) {
    console.log(chalk.dim("  No experiments recorded yet."));
    return;
  }

  // Use analytics engine for richer stats
  const analytics = analyzeExperiments(entries);

  const trendArrow =
    analytics.trend.direction === "improving"
      ? chalk.green("↑")
      : analytics.trend.direction === "declining"
        ? chalk.red("↓")
        : chalk.dim("→");

  console.log(`  Total Experiments:  ${chalk.bold(String(analytics.totalExperiments))}`);
  console.log(`  ${chalk.green("✓")} Committed:       ${chalk.green(String(analytics.totalCommitted))} (${analytics.successRate.toFixed(1)}%) ${trendArrow}`);
  console.log(`  ${chalk.red("✗")} Reverted:        ${chalk.red(String(analytics.totalReverted))} (${(100 - analytics.successRate).toFixed(1)}%)`);
  console.log(`  ⏱  Total Time:      ${chalk.dim(analytics.totalDurationMins + " minutes")}`);
  console.log(`  📊 Rate:            ${chalk.dim(analytics.experimentsPerHour + " experiments/hour")}`);
  if (analytics.timeSinceLastMins < 60) {
    console.log(`  🕐 Last experiment: ${chalk.dim(analytics.timeSinceLastMins + " minutes ago")}`);
  } else {
    console.log(`  🕐 Last experiment: ${chalk.dim(Math.round(analytics.timeSinceLastMins / 60) + " hours ago")}`);
  }

  if (analytics.diminishingReturns) {
    console.log();
    console.log(chalk.yellow("  ⚠️  Diminishing returns detected — consider updating research-agenda.md"));
  }

  console.log();

  // Show last 10 experiments
  const recent = entries.slice(-10);
  console.log(chalk.bold("  Recent Experiments:"));
  console.log(chalk.dim("  ─────────────────────────────────────────────────────────────"));
  for (const exp of recent) {
    const icon = exp.action === "committed" ? chalk.green("✓") : chalk.red("✗");
    const time = new Date(exp.timestamp).toLocaleTimeString();
    const hypothesis = exp.hypothesis.length > 55 ? exp.hypothesis.substring(0, 55) + "…" : exp.hypothesis;
    console.log(`  ${icon} #${String(exp.id).padStart(3)} [${chalk.dim(time)}] ${hypothesis}`);
  }
  console.log();
}

// =============================================================================
// Log Subcommand
// =============================================================================

async function handleLog(projectId: string, opts: { json?: boolean; last?: string }): Promise<void> {
  const config = loadConfig();
  const project = config.projects[projectId];

  if (!project) {
    console.error(
      chalk.red(
        `Unknown project: ${projectId}\nAvailable: ${Object.keys(config.projects).join(", ")}`,
      ),
    );
    process.exit(1);
  }

  const projectPath = resolve(project.path.replace(/^~/, process.env["HOME"] || ""));
  const expPath = join(projectPath, "experiments.jsonl");

  if (!existsSync(expPath)) {
    console.log(chalk.dim("No experiment log found."));
    return;
  }

  const entries = parseExperimentsFile(expPath);
  const count = opts.last ? parseInt(opts.last, 10) : entries.length;
  const display = entries.slice(-count);

  if (opts.json) {
    console.log(JSON.stringify(display, null, 2));
    return;
  }

  console.log(banner("AUTORESEARCH LOG"));
  console.log();

  for (const exp of display) {
    const icon = exp.action === "committed" ? chalk.green("✓ COMMITTED") : chalk.red("✗ REVERTED");
    console.log(`  ${chalk.bold(`Experiment #${exp.id}`)} — ${icon}`);
    console.log(`  ${chalk.dim(exp.timestamp)}`);
    console.log(`  Hypothesis: ${exp.hypothesis}`);
    if (exp.files_changed?.length > 0) {
      console.log(`  Files: ${exp.files_changed.join(", ")}`);
    }
    if (exp.commit_hash) {
      console.log(`  Commit: ${chalk.dim(exp.commit_hash)}`);
    }
    console.log(`  Duration: ${exp.duration_secs}s`);
    console.log();
  }
}

// =============================================================================
// Report Subcommand
// =============================================================================

async function handleReport(projectId: string, opts: { json?: boolean }): Promise<void> {
  const config = loadConfig();
  const project = config.projects[projectId];

  if (!project) {
    console.error(
      chalk.red(
        `Unknown project: ${projectId}\nAvailable: ${Object.keys(config.projects).join(", ")}`,
      ),
    );
    process.exit(1);
  }

  const projectPath = resolve(project.path.replace(/^~/, process.env["HOME"] || ""));
  const expPath = join(projectPath, "experiments.jsonl");

  if (!existsSync(expPath)) {
    console.log(chalk.dim("No experiment log found. Run: ao research start " + projectId));
    return;
  }

  const entries = parseExperimentsFile(expPath);

  if (entries.length === 0) {
    console.log(chalk.dim("No experiments recorded yet."));
    return;
  }

  const analytics = analyzeExperiments(entries);

  if (opts.json) {
    console.log(JSON.stringify(analytics, null, 2));
    return;
  }

  // Print the formatted report
  console.log(formatAnalyticsReport(analytics));

  // Suggest next area
  const agendaPath = join(projectPath, "research-agenda.md");
  const agenda = existsSync(agendaPath) ? readFileSync(agendaPath, "utf-8") : "";
  const suggestion = suggestNextArea(entries, agenda);
  console.log(`  💡 Suggested next area: ${chalk.cyan.bold(suggestion)}`);
  console.log();
}

// =============================================================================
// Helpers
// =============================================================================

function parseExperimentsFile(expPath: string): ExperimentLogEntry[] {
  const content = readFileSync(expPath, "utf-8");
  const entries: ExperimentLogEntry[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as ExperimentLogEntry);
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}

// =============================================================================
// Register Command
// =============================================================================

export function registerResearch(program: Command): void {
  const research = program
    .command("research")
    .description("Manage AutoResearch sessions — autonomous ratchet-loop experiments");

  research
    .command("init")
    .description("Initialize autoresearch in a project")
    .argument("<project>", "Project ID from config")
    .option("--eval <command>", "Evaluation command", "pnpm test")
    .option("--bench <command>", "Benchmark command")
    .option("--surface <globs>", "Comma-separated mutation surface globs", "src/**,packages/**,lib/**")
    .action(async (projectId: string, opts: { eval?: string; bench?: string; surface?: string }) => {
      await handleInit(projectId, opts);
    });

  research
    .command("start")
    .description("Start an autoresearch session")
    .argument("<project>", "Project ID from config")
    .option("--open", "Open session in terminal tab")
    .option("--experiments <n>", "Max experiments to run (default: unlimited)")
    .action(async (projectId: string, opts: { open?: boolean; experiments?: string }) => {
      await handleStart(projectId, opts);
    });

  research
    .command("status")
    .description("Show autoresearch experiment status")
    .argument("<project>", "Project ID from config")
    .action(async (projectId: string) => {
      await handleStatus(projectId);
    });

  research
    .command("log")
    .description("Show experiment history")
    .argument("<project>", "Project ID from config")
    .option("--json", "Output as JSON")
    .option("--last <n>", "Show last N experiments")
    .action(async (projectId: string, opts: { json?: boolean; last?: string }) => {
      await handleLog(projectId, opts);
    });

  research
    .command("report")
    .description("Show detailed analytics report with trends, area breakdown, and hot files")
    .argument("<project>", "Project ID from config")
    .option("--json", "Output analytics as JSON")
    .action(async (projectId: string, opts: { json?: boolean }) => {
      await handleReport(projectId, opts);
    });
}
