/**
 * Multi-Metric Eval Suite
 *
 * Inspired by Deep Agents' "evals as behavioral vectors" philosophy.
 * Instead of a single pass/fail test command, experiments are scored
 * across multiple dimensions — each dimension measures a specific
 * behavioral capability.
 *
 * Key concepts:
 * - EvalCategory:  High-level grouping (file_operations, retrieval, etc.)
 * - EvalDimension: A single scored eval (name, command, metric extractor)
 * - EvalResult:    A vector of per-dimension scores for one experiment
 *
 * This lets the autoresearch agent understand WHERE improvements help
 * and WHERE regressions occur, enabling much smarter hypothesis selection.
 */

// =============================================================================
// Eval Category Taxonomy (inspired by Deep Agents)
// =============================================================================

/**
 * Behavioral categories for eval dimensions.
 * Borrowed from Deep Agents' taxonomy — each category groups related
 * capabilities so we can analyze agent performance by behavior type.
 */
export const EVAL_CATEGORIES = [
  "file_operations",    // Read, write, edit, search files
  "retrieval",          // Find information across codebase
  "code_generation",    // Write new code, implement features
  "refactoring",        // Restructure existing code
  "tool_use",           // Compose 5+ tool calls in sequence
  "type_analysis",      // TypeScript type safety, generics
  "error_handling",     // Error paths, recovery, messages
  "performance",        // Speed, memory, efficiency
  "test_quality",       // Test coverage, test reliability
  "custom",             // User-defined
] as const;

export type EvalCategory = (typeof EVAL_CATEGORIES)[number];

// =============================================================================
// Eval Dimension
// =============================================================================

/**
 * A single evaluation dimension — measures one specific aspect of code quality.
 *
 * Example:
 * ```ts
 * {
 *   name: "type-coverage",
 *   category: "type_analysis",
 *   description: "Percentage of code with explicit type annotations",
 *   command: "npx typescript-coverage-report --json",
 *   metricExtractor: /\"percentage\":\s*([\d.]+)/,
 *   weight: 1.5,
 *   higherIsBetter: true,
 *   baseline: 85
 * }
 * ```
 */
export interface EvalDimension {
  /** Human-readable name */
  name: string;
  /** Which behavioral category this falls under */
  category: EvalCategory;
  /** What this eval measures (included in agent docstring) */
  description: string;
  /** Shell command to run (must exit 0 on success) */
  command: string;
  /**
   * Regex to extract a numeric metric from command stdout.
   * Must contain exactly one capture group that yields a number.
   * If omitted, pass/fail (exit code 0 / non-0) is used.
   */
  metricExtractor?: RegExp;
  /** Weight for weighted average scoring (default: 1.0) */
  weight: number;
  /** True = higher metric is better; false = lower is better */
  higherIsBetter: boolean;
  /** Optional baseline value — used to compute improvement delta */
  baseline?: number;
}

// =============================================================================
// Eval Results
// =============================================================================

/** Result of running a single eval dimension */
export interface DimensionResult {
  dimension: string;
  category: EvalCategory;
  passed: boolean;
  /** Raw metric value extracted from command output (null if extraction failed) */
  rawValue: number | null;
  /**
   * Normalized score 0–100 relative to baseline.
   * 100 = at or above baseline, 0 = complete failure.
   */
  normalizedScore: number;
  /** Delta from baseline (positive = improvement) */
  delta: number;
  /** Duration in ms to run this dimension */
  durationMs: number;
  /** Error message if the command failed */
  error?: string;
}

/** Full eval result for one experiment — a vector of dimension scores */
export interface EvalResult {
  /** Overall weighted score (0–100) */
  overallScore: number;
  /** Did all pass/fail dimensions pass? */
  allPassed: boolean;
  /** Did the overall score improve vs baseline? */
  improved: boolean;
  /** Per-dimension results */
  dimensions: DimensionResult[];
  /** Per-category aggregate scores */
  categoryScores: Record<string, { score: number; count: number; passed: number }>;
  /** Total time to run all evals */
  totalDurationMs: number;
}

// =============================================================================
// Scoring Logic
// =============================================================================

/**
 * Score a single dimension result.
 * Converts raw metric + pass/fail into a normalized 0–100 score.
 */
export function scoreDimension(
  dim: EvalDimension,
  passed: boolean,
  rawValue: number | null,
  durationMs: number,
  error?: string,
): DimensionResult {
  let normalizedScore = 0;
  let delta = 0;

  if (!passed) {
    // Failed — score is 0
    normalizedScore = 0;
    delta = dim.baseline != null ? -dim.baseline : 0;
  } else if (rawValue != null && dim.baseline != null) {
    // We have a numeric value and a baseline — compute normalized score
    if (dim.higherIsBetter) {
      // Higher is better: score increases as rawValue exceeds baseline
      normalizedScore = dim.baseline > 0
        ? Math.min(100, (rawValue / dim.baseline) * 100)
        : rawValue > 0 ? 100 : 0;
      delta = rawValue - dim.baseline;
    } else {
      // Lower is better: score increases as rawValue falls below baseline
      normalizedScore = dim.baseline > 0
        ? Math.min(100, (dim.baseline / Math.max(0.001, rawValue)) * 100)
        : rawValue <= 0 ? 100 : 0;
      delta = dim.baseline - rawValue;
    }
    normalizedScore = Math.max(0, Math.min(100, normalizedScore));
  } else if (passed) {
    // Passed but no metric — full score
    normalizedScore = 100;
    delta = 0;
  }

  return {
    dimension: dim.name,
    category: dim.category,
    passed,
    rawValue,
    normalizedScore: Math.round(normalizedScore * 10) / 10,
    delta: Math.round(delta * 100) / 100,
    durationMs,
    error,
  };
}

/**
 * Aggregate dimension results into a full EvalResult.
 */
export function aggregateResults(
  dimensions: EvalDimension[],
  results: DimensionResult[],
): EvalResult {
  // Weighted average
  let totalWeight = 0;
  let weightedSum = 0;
  let allPassed = true;

  for (let i = 0; i < results.length; i++) {
    const dim = dimensions[i];
    const result = results[i];
    if (!dim || !result) continue;

    totalWeight += dim.weight;
    weightedSum += result.normalizedScore * dim.weight;
    if (!result.passed) allPassed = false;
  }

  const overallScore = totalWeight > 0
    ? Math.round((weightedSum / totalWeight) * 10) / 10
    : 0;

  // Category aggregation
  const categoryScores: EvalResult["categoryScores"] = {};
  for (const result of results) {
    const cat = result.category;
    const existing = categoryScores[cat] || { score: 0, count: 0, passed: 0 };
    existing.score += result.normalizedScore;
    existing.count++;
    if (result.passed) existing.passed++;
    categoryScores[cat] = existing;
  }
  // Average the scores per category
  for (const cat of Object.keys(categoryScores)) {
    const entry = categoryScores[cat];
    if (entry && entry.count > 0) {
      entry.score = Math.round((entry.score / entry.count) * 10) / 10;
    }
  }

  const totalDurationMs = results.reduce((sum, r) => sum + r.durationMs, 0);

  return {
    overallScore,
    allPassed,
    improved: overallScore >= 100, // At or above baseline
    dimensions: results,
    categoryScores,
    totalDurationMs,
  };
}

// =============================================================================
// Default Eval Dimensions
// =============================================================================

/**
 * Default eval dimensions for a TypeScript/Node.js project.
 * These cover the core behavioral categories from Deep Agents.
 */
export const DEFAULT_EVAL_DIMENSIONS: EvalDimension[] = [
  {
    name: "tests-pass",
    category: "code_generation",
    description: "All existing tests must pass",
    command: "pnpm test 2>&1; echo \"EXIT_CODE=$?\"",
    weight: 3.0, // Tests passing is critical — 3× weight
    higherIsBetter: true,
  },
  {
    name: "type-check",
    category: "type_analysis",
    description: "TypeScript compilation with strict mode (no errors)",
    command: "npx tsc --noEmit 2>&1; echo \"EXIT_CODE=$?\"",
    weight: 2.0,
    higherIsBetter: true,
  },
  {
    name: "lint-clean",
    category: "code_generation",
    description: "No new lint warnings or errors",
    command: "npx eslint . --max-warnings 0 2>&1; echo \"EXIT_CODE=$?\"",
    weight: 1.0,
    higherIsBetter: true,
  },
];

// =============================================================================
// Prompt Generation for Multi-Metric Evals
// =============================================================================

/**
 * Generate the eval section of the system prompt for multi-metric mode.
 */
export function generateEvalPromptSection(dimensions: EvalDimension[]): string {
  const lines: string[] = [];

  lines.push("## Multi-Metric Evaluation Suite");
  lines.push("");
  lines.push("Your experiments are scored across **multiple dimensions**, not just pass/fail.");
  lines.push("Each dimension measures a specific behavioral capability. Your goal is to improve");
  lines.push("the overall weighted score while keeping all dimensions passing.");
  lines.push("");
  lines.push("### Eval Dimensions");
  lines.push("");
  lines.push("| Dimension | Category | Weight | Direction | Description |");
  lines.push("|-----------|----------|--------|-----------|-------------|");

  for (const dim of dimensions) {
    const dir = dim.higherIsBetter ? "↑ higher" : "↓ lower";
    lines.push(`| ${dim.name} | ${dim.category} | ${dim.weight}× | ${dir} | ${dim.description} |`);
  }

  lines.push("");
  lines.push("### How Scoring Works");
  lines.push("- Each dimension produces a **normalized score** (0–100)");
  lines.push("- Scores are combined using a **weighted average**");
  lines.push("- An experiment is committed only if:");
  lines.push("  1. All pass/fail dimensions pass (exit code 0)");
  lines.push("  2. Overall weighted score ≥ previous score (ratchet — never go backwards)");
  lines.push("");
  lines.push("### Running Evals");
  lines.push("Run each dimension command and record the results:");
  lines.push("```bash");
  for (const dim of dimensions) {
    lines.push(`# ${dim.name} (${dim.category}, weight: ${dim.weight}×)`);
    lines.push(dim.command);
    lines.push("");
  }
  lines.push("```");
  lines.push("");
  lines.push("### Logging Eval Results");
  lines.push("When logging to experiments.jsonl, include dimension scores:");
  lines.push("```json");
  lines.push('{..."dimension_scores": {"tests-pass": 100, "type-check": 95.5, "lint-clean": 100}, "overall_score": 98.2}');
  lines.push("```");

  return lines.join("\n");
}

/**
 * Generate the eval category taxonomy documentation for the system prompt.
 */
export function generateCategoryTaxonomy(): string {
  const lines: string[] = [];

  lines.push("## Eval Category Taxonomy");
  lines.push("");
  lines.push("Categorize your experiments using this taxonomy (inspired by Deep Agents):");
  lines.push("");
  lines.push("| Category | What It Tests | Example Evals |");
  lines.push("|----------|---------------|---------------|");
  lines.push("| `file_operations` | File read, write, edit, search, navigation | read_file tool, glob patterns |");
  lines.push("| `retrieval` | Finding information across files/codebase | multi-file search, cross-reference |");
  lines.push("| `code_generation` | Writing new code, implementing features | function creation, API implementation |");
  lines.push("| `refactoring` | Restructuring existing code safely | extract function, inline variable |");
  lines.push("| `tool_use` | Composing 5+ tool calls in sequence | multi-step workflows |");
  lines.push("| `type_analysis` | TypeScript types, generics, inference | eliminate `any`, add generics |");
  lines.push("| `error_handling` | Error paths, recovery, messages | try-catch, Result types |");
  lines.push("| `performance` | Speed, memory, caching, efficiency | memoization, hot path optimization |");
  lines.push("| `test_quality` | Test coverage, reliability, assertions | untested paths, edge cases |");
  lines.push("| `custom` | Project-specific evals | - |");

  return lines.join("\n");
}
