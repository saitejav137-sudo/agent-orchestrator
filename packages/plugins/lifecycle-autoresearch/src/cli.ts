/**
 * ao research — CLI command for managing AutoResearch sessions.
 *
 * Commands:
 *   ao research init <project>        — Initialize autoresearch in a project
 *   ao research start <project>       — Start an autoresearch session
 *   ao research status [project]      — Show autoresearch experiment status
 *   ao research log [project]         — Show experiment history
 *   ao research stop <session-id>     — Stop an autoresearch session
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  RESEARCH_AGENDA_TEMPLATE,
  RATCHET_RUNNER_SCRIPT,
  generateAutoResearchPrompt,
  type AutoResearchConfig,
} from "@composio/ao-plugin-lifecycle-autoresearch";

// =============================================================================
// Init Command
// =============================================================================

export interface ResearchInitOptions {
  projectPath: string;
  evalCommand?: string;
  mutationSurface?: string[];
  targets?: string[];
}

/**
 * Initialize autoresearch in a project directory.
 * Creates research-agenda.md, autoresearch-ratchet.sh, and .autoresearch/ dir.
 */
export async function initAutoResearch(options: ResearchInitOptions): Promise<void> {
  const { projectPath } = options;

  // 1. Create research-agenda.md if it doesn't exist
  const agendaPath = join(projectPath, "research-agenda.md");
  if (!existsSync(agendaPath)) {
    await writeFile(agendaPath, RESEARCH_AGENDA_TEMPLATE, "utf-8");
    console.log("✅ Created research-agenda.md");
  } else {
    console.log("ℹ️  research-agenda.md already exists, skipping");
  }

  // 2. Create autoresearch-ratchet.sh
  const ratchetPath = join(projectPath, "autoresearch-ratchet.sh");
  await writeFile(ratchetPath, RATCHET_RUNNER_SCRIPT, { mode: 0o755 });
  console.log("✅ Created autoresearch-ratchet.sh");

  // 3. Create .autoresearch/ directory for experiment logs
  const autoresearchDir = join(projectPath, ".autoresearch");
  await mkdir(autoresearchDir, { recursive: true });
  console.log("✅ Created .autoresearch/ directory");

  // 4. Create experiments.jsonl if it doesn't exist
  const experimentsPath = join(projectPath, "experiments.jsonl");
  if (!existsSync(experimentsPath)) {
    await writeFile(experimentsPath, "", "utf-8");
    console.log("✅ Created experiments.jsonl");
  }

  // 5. Create autoresearch config
  const config: AutoResearchConfig = {
    agendaFile: "research-agenda.md",
    evalCommand: options.evalCommand || "pnpm test",
    mutationSurface: options.mutationSurface || ["src/**", "packages/**"],
    protectedFiles: [
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
    ],
    maxExperiments: 0,
    experimentBudgetSecs: 300,
    createPR: true,
    prThreshold: 5,
    targets: [
      {
        name: "tests",
        type: "tests",
        command: options.evalCommand || "pnpm test",
        higherIsBetter: true,
      },
    ],
  };

  const configPath = join(autoresearchDir, "config.json");
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  console.log("✅ Created .autoresearch/config.json");

  // 6. Update .gitignore if needed
  const gitignorePath = join(projectPath, ".gitignore");
  const gitignoreEntry = "\n# AutoResearch\nexperiments.jsonl\n.autoresearch/\nautoresearch-ratchet.sh\n";
  if (existsSync(gitignorePath)) {
    const content = await readFile(gitignorePath, "utf-8");
    if (!content.includes("AutoResearch")) {
      await writeFile(gitignorePath, content + gitignoreEntry, "utf-8");
      console.log("✅ Updated .gitignore");
    }
  } else {
    await writeFile(gitignorePath, gitignoreEntry.trim() + "\n", "utf-8");
    console.log("✅ Created .gitignore");
  }

  // 7. Generate and display the system prompt
  const systemPrompt = generateAutoResearchPrompt(config);
  const promptPath = join(autoresearchDir, "system-prompt.md");
  await writeFile(promptPath, systemPrompt, "utf-8");
  console.log("✅ Generated system prompt → .autoresearch/system-prompt.md");

  console.log("\n═══════════════════════════════════════════════════");
  console.log("  🔬 AutoResearch initialized!");
  console.log("═══════════════════════════════════════════════════");
  console.log("");
  console.log("Next steps:");
  console.log("  1. Edit research-agenda.md with your research priorities");
  console.log("  2. Run: ao research start <project-id>");
  console.log("     Or: ao spawn <project-id> --mode autoresearch");
  console.log("");
  console.log("The agent will autonomously:");
  console.log("  • Propose code improvements");
  console.log("  • Run tests to validate");
  console.log("  • Commit successes, revert failures");
  console.log("  • Log all experiments to experiments.jsonl");
  console.log("");
}

// =============================================================================
// Status Command
// =============================================================================

export interface ExperimentLogEntry {
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

/**
 * Parse experiments.jsonl and return structured results
 */
export async function getExperimentLog(projectPath: string): Promise<ExperimentLogEntry[]> {
  const logPath = join(projectPath, "experiments.jsonl");
  if (!existsSync(logPath)) return [];

  const content = await readFile(logPath, "utf-8");
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

/**
 * Get a formatted status summary of autoresearch experiments
 */
export async function getResearchStatus(projectPath: string): Promise<string> {
  const entries = await getExperimentLog(projectPath);

  if (entries.length === 0) {
    return "No experiments recorded yet.";
  }

  const committed = entries.filter((e) => e.action === "committed");
  const reverted = entries.filter((e) => e.action === "reverted");
  const totalDuration = entries.reduce((sum, e) => sum + (e.duration_secs || 0), 0);

  const lines: string[] = [
    "═══════════════════════════════════════════════════",
    "  🔬 AutoResearch Status",
    "═══════════════════════════════════════════════════",
    "",
    `  Total Experiments:  ${entries.length}`,
    `  ✅ Committed:       ${committed.length} (${((committed.length / entries.length) * 100).toFixed(1)}%)`,
    `  ❌ Reverted:        ${reverted.length} (${((reverted.length / entries.length) * 100).toFixed(1)}%)`,
    `  ⏱️  Total Time:      ${Math.round(totalDuration / 60)} minutes`,
    "",
  ];

  // Show last 5 experiments
  const recent = entries.slice(-5);
  if (recent.length > 0) {
    lines.push("  Recent Experiments:");
    lines.push("  ─────────────────────────────────────────────");
    for (const exp of recent) {
      const icon = exp.action === "committed" ? "✅" : "❌";
      const time = new Date(exp.timestamp).toLocaleTimeString();
      lines.push(`  ${icon} #${exp.id} [${time}] ${exp.hypothesis.substring(0, 60)}`);
    }
  }

  return lines.join("\n");
}
