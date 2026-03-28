/**
 * Agent Trace Logging
 *
 * Inspired by Deep Agents' approach of tracing every tool call for failure
 * analysis. Instead of only capturing outcomes (pass/fail), we capture
 * structured traces of each tool invocation so the autoresearch loop can:
 *
 *   1. Understand WHY an experiment failed (not just that it did)
 *   2. Detect patterns in failure modes across experiments
 *   3. Generate richer self-reflection prompts with trace context
 *
 * Traces are stored as `traces.jsonl` alongside `experiments.jsonl`.
 */

// =============================================================================
// Types
// =============================================================================

/**
 * A single trace entry — represents one tool call or significant action
 * taken by the agent during an experiment.
 */
export interface TraceEntry {
  /** Tool name (e.g., "read_file", "edit_file", "run_command") */
  tool: string;
  /** Brief summary of the arguments (not full content to save space) */
  argsSummary: string;
  /** Brief summary of the result */
  resultSummary: string;
  /** Duration of this tool call in ms */
  durationMs: number;
  /** ISO timestamp when this call started */
  timestamp: string;
  /** Whether this tool call succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
}

/**
 * Full trace for one experiment — an ordered list of tool calls
 * plus metadata linking it back to the experiment.
 */
export interface ExperimentTrace {
  /** Experiment ID (matches experiments.jsonl) */
  experimentId: number;
  /** ISO timestamp when the experiment started */
  startedAt: string;
  /** ISO timestamp when the experiment ended */
  endedAt: string;
  /** Total duration of the experiment in ms */
  totalDurationMs: number;
  /** Ordered list of tool calls */
  entries: TraceEntry[];
  /** Hypothesis being tested */
  hypothesis: string;
  /** Outcome: committed or reverted */
  outcome: "committed" | "reverted";
  /** Number of tool calls */
  toolCallCount: number;
  /** Number of failed tool calls */
  failedToolCalls: number;
  /** Files that were read */
  filesRead: string[];
  /** Files that were edited */
  filesEdited: string[];
  /** Commands that were run */
  commandsRun: string[];
}

// =============================================================================
// Trace Parsing — Claude Code format
// =============================================================================

/**
 * Known tool names from Claude Code's output format.
 * Used by parseAgentLog() to identify tool call boundaries.
 */
const TOOL_PATTERNS: Array<{ tool: string; pattern: RegExp }> = [
  { tool: "read_file", pattern: /Read\s+(?:file\s+)?["']?([^"'\n]+)["']?/i },
  { tool: "edit_file", pattern: /(?:Edit|Write|Update)\s+(?:file\s+)?["']?([^"'\n]+)["']?/i },
  { tool: "run_command", pattern: /(?:Run|Execute)\s+(?:command\s+)?[`"]([^`"\n]+)[`"]/i },
  { tool: "search", pattern: /(?:Search|Grep|Find)\s+(?:for\s+)?["']?([^"'\n]+)["']?/i },
  { tool: "list_files", pattern: /(?:List|Ls)\s+(?:files?\s+(?:in\s+)?)?["']?([^"'\n]+)["']?/i },
  { tool: "create_file", pattern: /Create\s+(?:file\s+)?["']?([^"'\n]+)["']?/i },
  { tool: "delete_file", pattern: /Delete\s+(?:file\s+)?["']?([^"'\n]+)["']?/i },
];

/**
 * Parse structured trace entries from agent output text.
 *
 * This handles multiple formats:
 * 1. Structured JSON trace lines (preferred — agent logs `TRACE:` prefix)
 * 2. Claude Code's natural-language tool usage output
 *
 * @param logText Raw agent output (terminal capture)
 * @returns Array of parsed trace entries
 */
export function parseAgentLog(logText: string): TraceEntry[] {
  const entries: TraceEntry[] = [];

  // Strategy 1: Look for structured TRACE: JSON lines
  const traceLinePattern = /^TRACE:\s*(\{.+\})$/gm;
  let match: RegExpExecArray | null;

  while ((match = traceLinePattern.exec(logText)) !== null) {
    try {
      const parsed = JSON.parse(match[1]!) as Partial<TraceEntry>;
      entries.push({
        tool: parsed.tool ?? "unknown",
        argsSummary: parsed.argsSummary ?? "",
        resultSummary: parsed.resultSummary ?? "",
        durationMs: parsed.durationMs ?? 0,
        timestamp: parsed.timestamp ?? new Date().toISOString(),
        success: parsed.success ?? true,
        error: parsed.error,
      });
    } catch {
      // Malformed JSON — skip
    }
  }

  // If we found structured traces, return them
  if (entries.length > 0) return entries;

  // Strategy 2: Parse natural-language tool usage
  const lines = logText.split("\n");
  let currentTimestamp = new Date().toISOString();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Check for timestamp markers
    const tsMatch = trimmed.match(/\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\]/);
    if (tsMatch) {
      currentTimestamp = tsMatch[1]!;
    }

    // Check each tool pattern
    for (const { tool, pattern } of TOOL_PATTERNS) {
      const toolMatch = pattern.exec(trimmed);
      if (toolMatch) {
        const isError = /error|fail|not found|permission denied/i.test(trimmed);
        entries.push({
          tool,
          argsSummary: toolMatch[1] ?? trimmed.slice(0, 100),
          resultSummary: trimmed.slice(0, 150),
          durationMs: 0, // Can't determine from natural language
          timestamp: currentTimestamp,
          success: !isError,
          error: isError ? trimmed : undefined,
        });
        break; // Only match one pattern per line
      }
    }
  }

  return entries;
}

// =============================================================================
// Trace to Summary — Failure Analysis
// =============================================================================

/**
 * Compress a full experiment trace into a human-readable failure analysis.
 *
 * This is designed to be included in the self-reflection prompt (Step 8)
 * so the agent can learn from its mistakes.
 */
export function traceToSummary(trace: ExperimentTrace): string {
  const lines: string[] = [];

  lines.push(`### Experiment #${trace.experimentId}: ${trace.outcome.toUpperCase()}`);
  lines.push(`**Hypothesis**: ${trace.hypothesis}`);
  lines.push(`**Duration**: ${(trace.totalDurationMs / 1000).toFixed(1)}s`);
  lines.push(`**Tool calls**: ${trace.toolCallCount} (${trace.failedToolCalls} failed)`);
  lines.push("");

  // Files touched
  if (trace.filesRead.length > 0) {
    lines.push(`**Files read** (${trace.filesRead.length}): ${trace.filesRead.slice(0, 5).join(", ")}${trace.filesRead.length > 5 ? "..." : ""}`);
  }
  if (trace.filesEdited.length > 0) {
    lines.push(`**Files edited** (${trace.filesEdited.length}): ${trace.filesEdited.join(", ")}`);
  }
  if (trace.commandsRun.length > 0) {
    lines.push(`**Commands run** (${trace.commandsRun.length}): ${trace.commandsRun.slice(0, 3).map((c) => "`" + c.slice(0, 60) + "`").join(", ")}`);
  }

  // Failure analysis
  if (trace.outcome === "reverted") {
    lines.push("");
    lines.push("**Failure Analysis**:");

    const failedCalls = trace.entries.filter((e) => !e.success);
    if (failedCalls.length > 0) {
      lines.push(`- ${failedCalls.length} tool call(s) failed:`);
      for (const call of failedCalls.slice(0, 3)) {
        lines.push(`  - \`${call.tool}\`: ${call.error ?? call.resultSummary}`);
      }
    }

    // Look for patterns
    const editCount = trace.entries.filter((e) => e.tool === "edit_file").length;
    const readCount = trace.entries.filter((e) => e.tool === "read_file").length;

    if (editCount === 0) {
      lines.push("- ⚠️ No file edits detected — experiment may have stalled");
    }
    if (readCount === 0 && editCount > 0) {
      lines.push("- ⚠️ Edited files without reading them first — may have caused issues");
    }
    if (editCount > 5) {
      lines.push(`- ⚠️ Made ${editCount} edits — change was too broad, try smaller scope`);
    }
  }

  return lines.join("\n");
}

// =============================================================================
// Trace Construction
// =============================================================================

/**
 * Build a full ExperimentTrace from raw entries and experiment metadata.
 */
export function buildTrace(
  experimentId: number,
  hypothesis: string,
  outcome: "committed" | "reverted",
  entries: TraceEntry[],
  startedAt: string,
  endedAt: string,
): ExperimentTrace {
  const filesRead = new Set<string>();
  const filesEdited = new Set<string>();
  const commandsRun: string[] = [];

  for (const entry of entries) {
    switch (entry.tool) {
      case "read_file":
      case "search":
      case "list_files":
        filesRead.add(entry.argsSummary);
        break;
      case "edit_file":
      case "create_file":
        filesEdited.add(entry.argsSummary);
        break;
      case "run_command":
        commandsRun.push(entry.argsSummary);
        break;
    }
  }

  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();

  return {
    experimentId,
    startedAt,
    endedAt,
    totalDurationMs: end - start,
    entries,
    hypothesis,
    outcome,
    toolCallCount: entries.length,
    failedToolCalls: entries.filter((e) => !e.success).length,
    filesRead: Array.from(filesRead),
    filesEdited: Array.from(filesEdited),
    commandsRun,
  };
}

// =============================================================================
// Batch Trace Analysis
// =============================================================================

/**
 * Summarize multiple experiment traces for the self-reflection step.
 * Highlights patterns across experiments, not just individual failures.
 */
export function batchTraceSummary(traces: ExperimentTrace[]): string {
  if (traces.length === 0) return "No traces available for analysis.";

  const lines: string[] = [];
  const committed = traces.filter((t) => t.outcome === "committed");
  const reverted = traces.filter((t) => t.outcome === "reverted");

  lines.push(`## Trace Analysis (last ${traces.length} experiments)`);
  lines.push(`Committed: ${committed.length} | Reverted: ${reverted.length}`);
  lines.push("");

  // Per-experiment summaries
  for (const trace of traces) {
    lines.push(traceToSummary(trace));
    lines.push("");
  }

  // Cross-experiment patterns
  if (reverted.length > 0) {
    lines.push("## Failure Patterns");

    // Tool failure frequency
    const toolFailures = new Map<string, number>();
    for (const trace of reverted) {
      for (const entry of trace.entries.filter((e) => !e.success)) {
        toolFailures.set(entry.tool, (toolFailures.get(entry.tool) ?? 0) + 1);
      }
    }
    if (toolFailures.size > 0) {
      lines.push("**Most frequently failing tools**:");
      for (const [tool, count] of Array.from(toolFailures.entries()).sort((a, b) => b[1] - a[1])) {
        lines.push(`- \`${tool}\`: ${count} failures`);
      }
    }

    // Files that appear in reverts but not commits
    const revertedFiles = new Set(reverted.flatMap((t) => t.filesEdited));
    const committedFiles = new Set(committed.flatMap((t) => t.filesEdited));
    const toxicFiles = Array.from(revertedFiles).filter((f) => !committedFiles.has(f));
    if (toxicFiles.length > 0) {
      lines.push("");
      lines.push("**Files only touched in reverted experiments** (avoid these):");
      for (const file of toxicFiles.slice(0, 5)) {
        lines.push(`- \`${file}\``);
      }
    }

    // Average tool call count comparison
    const avgRevertedCalls =
      reverted.reduce((sum, t) => sum + t.toolCallCount, 0) / reverted.length;
    const avgCommittedCalls =
      committed.length > 0
        ? committed.reduce((sum, t) => sum + t.toolCallCount, 0) / committed.length
        : 0;

    if (avgCommittedCalls > 0) {
      lines.push("");
      lines.push(
        `**Avg tool calls**: committed=${avgCommittedCalls.toFixed(0)}, reverted=${avgRevertedCalls.toFixed(0)}`,
      );
      if (avgRevertedCalls > avgCommittedCalls * 1.5) {
        lines.push("- ⚠️ Reverted experiments use significantly more tool calls — try simpler changes");
      }
    }
  }

  return lines.join("\n");
}

// =============================================================================
// Prompt Integration
// =============================================================================

/**
 * Generate the trace logging instructions for the system prompt.
 * This tells the agent HOW to log traces alongside experiments.
 */
export function generateTracePromptSection(): string {
  return `## Trace Logging

For each experiment, log structured traces to \`traces.jsonl\`.
Each tool call you make should be logged as a trace entry:

\`\`\`bash
# After each significant tool call:
echo '{"experimentId":N,"tool":"TOOL_NAME","argsSummary":"BRIEF_ARGS","resultSummary":"BRIEF_RESULT","durationMs":MS,"timestamp":"ISO_TS","success":true}' >> traces.jsonl
\`\`\`

At minimum, log these tool calls:
- File reads/edits (which files and whether they succeeded)
- Commands run (what command and exit code)
- Search operations (what was searched and whether results were found)

This trace data helps with failure analysis during self-reflection.`;
}
