/**
 * Dogfooding → Eval Pipeline
 *
 * Deep Agents converts every production error into a new eval.
 * This module does the analogous thing for autoresearch: every reverted
 * experiment is analyzed to see if it reveals a systematic weakness
 * that should become a new eval dimension.
 *
 * The pipeline:
 *   1. Reverted experiment + trace → `generateEvalFromRevert()`
 *   2. Multiple reverts → `detectRevertPatterns()` → groups of similar failures
 *   3. Patterns + history → `suggestEvals()` → eval definition suggestions
 *
 * Output is formatted as markdown so it can be reviewed by a human
 * before being added to the eval registry.
 */

import type { ExperimentTrace, TraceEntry } from "./trace.js";
import type { ExperimentLogEntry, AreaStats } from "./analytics.js";

// =============================================================================
// Types
// =============================================================================

/**
 * A pattern detected across multiple reverted experiments.
 */
export interface RevertPattern {
  /** What type of pattern this is */
  type: "tool_failure" | "file_toxicity" | "scope_creep" | "missing_read" | "area_exhaustion";
  /** Human-readable description */
  description: string;
  /** How many reverted experiments match this pattern */
  frequency: number;
  /** Confidence score 0–1 */
  confidence: number;
  /** Supporting evidence (experiment IDs) */
  experimentIds: number[];
  /** Suggested eval dimension to catch this pattern */
  suggestedEval?: EvalSuggestion;
}

/**
 * A suggested eval definition — not yet registered, pending human review.
 */
export interface EvalSuggestion {
  /** Suggested name for the eval */
  name: string;
  /** Which behavioral category */
  category: string;
  /** What it measures */
  description: string;
  /** Suggested command to run */
  command: string;
  /** Why this eval is suggested */
  rationale: string;
  /** Which revert pattern triggered this suggestion */
  sourcePattern: string;
  /** Confidence that this eval would be useful (0–1) */
  confidence: number;
}

// =============================================================================
// Single Revert → Eval Generation
// =============================================================================

/**
 * Analyze a single reverted experiment + its trace to generate an eval suggestion.
 *
 * The idea: if experiment N failed because of X, create an eval that would
 * catch X before it causes a revert.
 *
 * @param experiment The reverted experiment entry
 * @param trace Optional trace data for deeper analysis
 */
export function generateEvalFromRevert(
  experiment: ExperimentLogEntry,
  trace?: ExperimentTrace,
): EvalSuggestion | null {
  // Only analyze reverted experiments
  if (experiment.action !== "reverted") return null;

  // Determine failure mode from trace
  if (trace) {
    return analyzeTraceForEval(experiment, trace);
  }

  // Without a trace, we can still analyze the experiment metadata
  return analyzeExperimentForEval(experiment);
}

/**
 * Analyze a trace to find the root cause and suggest an eval.
 */
function analyzeTraceForEval(
  experiment: ExperimentLogEntry,
  trace: ExperimentTrace,
): EvalSuggestion | null {
  const failedCalls = trace.entries.filter((e) => !e.success);

  // Pattern: Command execution failures
  const failedCommands = failedCalls.filter((e) => e.tool === "run_command");
  if (failedCommands.length > 0) {
    const cmd = failedCommands[0]!;
    return {
      name: `guard-${sanitizeName(cmd.argsSummary)}`,
      category: "error_handling",
      description: `Guard against command failure: ${cmd.argsSummary.slice(0, 80)}`,
      command: cmd.argsSummary,
      rationale: `Experiment #${experiment.id} reverted because this command failed: ${cmd.error ?? cmd.resultSummary}`,
      sourcePattern: "tool_failure",
      confidence: 0.7,
    };
  }

  // Pattern: Too many edits (scope creep)
  const editCount = trace.entries.filter((e) => e.tool === "edit_file").length;
  if (editCount > 5) {
    return {
      name: "scope-guard",
      category: "code_generation",
      description: "Detect when an experiment modifies too many files (scope creep)",
      command: `test $(git diff --name-only | wc -l) -le 5`,
      rationale: `Experiment #${experiment.id} touched ${editCount} files and was reverted. Changes should be more focused.`,
      sourcePattern: "scope_creep",
      confidence: 0.6,
    };
  }

  // Pattern: Edits without prior reads
  const readFiles = new Set(
    trace.entries
      .filter((e) => e.tool === "read_file")
      .map((e) => e.argsSummary),
  );
  const editedFiles = trace.entries
    .filter((e) => e.tool === "edit_file")
    .map((e) => e.argsSummary);
  const blindEdits = editedFiles.filter((f) => !readFiles.has(f));

  if (blindEdits.length > 0) {
    return {
      name: "read-before-edit-guard",
      category: "file_operations",
      description: "Ensure files are read and understood before being edited",
      command: `echo "This is a process eval — check agent trace for read-before-edit pattern"`,
      rationale: `Experiment #${experiment.id} edited ${blindEdits.length} file(s) without reading them first: ${blindEdits.slice(0, 3).join(", ")}`,
      sourcePattern: "missing_read",
      confidence: 0.5,
    };
  }

  return null;
}

/**
 * Analyze experiment metadata (without trace) to suggest an eval.
 */
function analyzeExperimentForEval(experiment: ExperimentLogEntry): EvalSuggestion | null {
  // Pattern: Many files changed in a failed experiment
  if (experiment.files_changed.length > 3) {
    return {
      name: "change-scope-limit",
      category: "code_generation",
      description: `Limit experiments to ≤3 files to reduce revert risk`,
      command: `test $(git diff --name-only | wc -l) -le 3`,
      rationale: `Experiment #${experiment.id} modified ${experiment.files_changed.length} files and was reverted. Smaller changes are safer.`,
      sourcePattern: "scope_creep",
      confidence: 0.5,
    };
  }

  // Pattern: Specific error in the experiment
  if (experiment.error) {
    const errorKeyword = extractErrorKeyword(experiment.error);
    if (errorKeyword) {
      return {
        name: `guard-${sanitizeName(errorKeyword)}`,
        category: "error_handling",
        description: `Guard against: ${errorKeyword}`,
        command: `pnpm test 2>&1 | grep -v "${errorKeyword}" && exit 0 || exit 1`,
        rationale: `Experiment #${experiment.id} failed with: ${experiment.error.slice(0, 100)}`,
        sourcePattern: "tool_failure",
        confidence: 0.4,
      };
    }
  }

  return null;
}

// =============================================================================
// Multi-Revert Pattern Detection
// =============================================================================

/**
 * Detect patterns across multiple reverted experiments.
 * Groups similar failures to find systematic weaknesses.
 */
export function detectRevertPatterns(
  experiments: ExperimentLogEntry[],
  traces?: ExperimentTrace[],
): RevertPattern[] {
  const reverted = experiments.filter((e) => e.action === "reverted");
  if (reverted.length < 2) return [];

  const patterns: RevertPattern[] = [];
  const traceMap = new Map<number, ExperimentTrace>();
  if (traces) {
    for (const t of traces) {
      traceMap.set(t.experimentId, t);
    }
  }

  // Pattern 1: Repeated failures on the same file
  const fileFailureCounts = new Map<string, number[]>();
  for (const exp of reverted) {
    for (const file of exp.files_changed) {
      const existing = fileFailureCounts.get(file) ?? [];
      existing.push(exp.id);
      fileFailureCounts.set(file, existing);
    }
  }

  for (const [file, ids] of fileFailureCounts) {
    if (ids.length >= 2) {
      patterns.push({
        type: "file_toxicity",
        description: `File "${file}" appears in ${ids.length} reverted experiments`,
        frequency: ids.length,
        confidence: Math.min(0.9, ids.length / reverted.length),
        experimentIds: ids,
        suggestedEval: {
          name: `avoid-${sanitizeName(file)}`,
          category: "file_operations",
          description: `Avoid modifying ${file} — it has a high revert rate`,
          command: `! git diff --name-only | grep -q "${file}"`,
          rationale: `${file} was involved in ${ids.length} reverted experiments (out of ${reverted.length} total)`,
          sourcePattern: "file_toxicity",
          confidence: Math.min(0.9, ids.length / reverted.length),
        },
      });
    }
  }

  // Pattern 2: Tool failures from traces
  if (traces && traces.length > 0) {
    const toolFailures = new Map<string, number[]>();
    for (const trace of traces.filter((t) => t.outcome === "reverted")) {
      for (const entry of trace.entries.filter((e) => !e.success)) {
        const key = entry.tool;
        const existing = toolFailures.get(key) ?? [];
        existing.push(trace.experimentId);
        toolFailures.set(key, existing);
      }
    }

    for (const [tool, ids] of toolFailures) {
      if (ids.length >= 2) {
        patterns.push({
          type: "tool_failure",
          description: `Tool "${tool}" fails in ${ids.length} reverted experiments`,
          frequency: ids.length,
          confidence: Math.min(0.8, ids.length / reverted.length),
          experimentIds: [...new Set(ids)],
        });
      }
    }
  }

  // Pattern 3: Scope creep — reverted experiments tend to change many files
  const avgRevertedFiles =
    reverted.reduce((sum, e) => sum + e.files_changed.length, 0) / reverted.length;
  const committed = experiments.filter((e) => e.action === "committed");
  const avgCommittedFiles =
    committed.length > 0
      ? committed.reduce((sum, e) => sum + e.files_changed.length, 0) / committed.length
      : 0;

  if (avgRevertedFiles > avgCommittedFiles * 1.5 && avgRevertedFiles > 2) {
    patterns.push({
      type: "scope_creep",
      description: `Reverted experiments avg ${avgRevertedFiles.toFixed(1)} files vs ${avgCommittedFiles.toFixed(1)} for committed`,
      frequency: reverted.length,
      confidence: 0.7,
      experimentIds: reverted.map((e) => e.id),
      suggestedEval: {
        name: "scope-limit",
        category: "code_generation",
        description: "Limit file change count to reduce revert risk",
        command: `test $(git diff --name-only | wc -l) -le ${Math.ceil(avgCommittedFiles + 1)}`,
        rationale: `Reverted experiments modify ${avgRevertedFiles.toFixed(1)} files on avg, while committed ones modify ${avgCommittedFiles.toFixed(1)}`,
        sourcePattern: "scope_creep",
        confidence: 0.7,
      },
    });
  }

  // Sort by confidence (most confident first)
  patterns.sort((a, b) => b.confidence - a.confidence);

  return patterns;
}

// =============================================================================
// Suggest Evals — Full Pipeline
// =============================================================================

/**
 * Analyze experiment history and suggest new eval dimensions.
 * This is the main entry point for the dogfooding pipeline.
 *
 * @param experiments All experiment entries
 * @param traces Optional trace data
 * @param areaStats Optional area statistics from analytics
 * @returns Array of eval suggestions, sorted by confidence
 */
export function suggestEvals(
  experiments: ExperimentLogEntry[],
  traces?: ExperimentTrace[],
  areaStats?: AreaStats[],
): EvalSuggestion[] {
  const suggestions: EvalSuggestion[] = [];
  const seen = new Set<string>();

  // 1. Per-revert eval generation
  const reverted = experiments.filter((e) => e.action === "reverted");
  const traceMap = new Map<number, ExperimentTrace>();
  if (traces) {
    for (const t of traces) {
      traceMap.set(t.experimentId, t);
    }
  }

  for (const exp of reverted) {
    const trace = traceMap.get(exp.id);
    const suggestion = generateEvalFromRevert(exp, trace);
    if (suggestion && !seen.has(suggestion.name)) {
      suggestions.push(suggestion);
      seen.add(suggestion.name);
    }
  }

  // 2. Pattern-based suggestions
  const patterns = detectRevertPatterns(experiments, traces);
  for (const pattern of patterns) {
    if (pattern.suggestedEval && !seen.has(pattern.suggestedEval.name)) {
      suggestions.push(pattern.suggestedEval);
      seen.add(pattern.suggestedEval.name);
    }
  }

  // 3. Area exhaustion detection
  if (areaStats) {
    for (const area of areaStats) {
      if (area.consecutiveFailures >= 3 && area.total >= 5 && area.successRate < 30) {
        const name = `${area.area}-guard`;
        if (!seen.has(name)) {
          suggestions.push({
            name,
            category: mapAreaToCategory(area.area),
            description: `Guard for area "${area.area}" which has ${area.consecutiveFailures} consecutive failures`,
            command: `echo "Area ${area.area} is exhausted — try a different approach"`,
            rationale: `Area "${area.area}" has a ${area.successRate.toFixed(0)}% success rate with ${area.consecutiveFailures} consecutive failures`,
            sourcePattern: "area_exhaustion",
            confidence: 0.8,
          });
          seen.add(name);
        }
      }
    }
  }

  // Sort by confidence (highest first)
  suggestions.sort((a, b) => b.confidence - a.confidence);

  return suggestions;
}

// =============================================================================
// Markdown Output
// =============================================================================

/**
 * Format eval suggestions as a markdown document for human review.
 */
export function formatEvalSuggestionsMarkdown(suggestions: EvalSuggestion[]): string {
  if (suggestions.length === 0) {
    return "# Eval Suggestions\n\nNo eval suggestions at this time. More experiment data is needed.\n";
  }

  const lines: string[] = [];
  lines.push("# Eval Suggestions");
  lines.push("");
  lines.push(`Generated from experiment failure analysis. ${suggestions.length} suggestion(s) found.`);
  lines.push("");
  lines.push("Review each suggestion and add approved evals to your eval registry.");
  lines.push("");

  for (let i = 0; i < suggestions.length; i++) {
    const s = suggestions[i]!;
    const confidenceBar = "█".repeat(Math.round(s.confidence * 10)) + "░".repeat(10 - Math.round(s.confidence * 10));

    lines.push(`## ${i + 1}. ${s.name}`);
    lines.push("");
    lines.push(`| Property | Value |`);
    lines.push(`|----------|-------|`);
    lines.push(`| Category | \`${s.category}\` |`);
    lines.push(`| Confidence | ${confidenceBar} ${(s.confidence * 100).toFixed(0)}% |`);
    lines.push(`| Source | ${s.sourcePattern} |`);
    lines.push("");
    lines.push(`**Description**: ${s.description}`);
    lines.push("");
    lines.push(`**Rationale**: ${s.rationale}`);
    lines.push("");
    lines.push("**Command**:");
    lines.push("```bash");
    lines.push(s.command);
    lines.push("```");
    lines.push("");
  }

  return lines.join("\n");
}

// =============================================================================
// Helpers
// =============================================================================

function sanitizeName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);
}

function extractErrorKeyword(error: string): string | null {
  // Extract meaningful error keywords
  const patterns = [
    /TypeError:\s*(.+)/i,
    /SyntaxError:\s*(.+)/i,
    /ReferenceError:\s*(.+)/i,
    /Cannot find module\s+'([^']+)'/i,
    /Property '([^']+)' does not exist/i,
    /Type '([^']+)' is not assignable/i,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(error);
    if (match) {
      return match[1]?.slice(0, 50) ?? null;
    }
  }

  return null;
}

function mapAreaToCategory(area: string): string {
  const mapping: Record<string, string> = {
    "type-safety": "type_analysis",
    "error-handling": "error_handling",
    "code-quality": "refactoring",
    "performance": "performance",
    "edge-cases": "error_handling",
    "test-coverage": "test_quality",
    "documentation": "custom",
  };
  return mapping[area] ?? "custom";
}
