/**
 * Eval Registry — Core Module
 *
 * Central registry for behavioral eval definitions. Any plugin can register
 * eval definitions describing what behavioral dimensions it tests. The
 * autoresearch plugin consumes these to build its multi-metric eval suite.
 *
 * Inspired by Deep Agents' catalog of behavioral evals grouped by category.
 *
 * Usage:
 *   const registry = createEvalRegistry();
 *   registry.register(evalDef);
 *   const codeGenEvals = registry.filterByCategory("code_generation");
 */

// =============================================================================
// Types
// =============================================================================

/**
 * Behavioral categories for grouping eval dimensions.
 * Matches the taxonomy from Deep Agents.
 */
export const EVAL_CATEGORIES = [
  "file_operations",
  "retrieval",
  "code_generation",
  "refactoring",
  "tool_use",
  "type_analysis",
  "error_handling",
  "performance",
  "test_quality",
  "custom",
] as const;

export type EvalCategory = (typeof EVAL_CATEGORIES)[number];

/**
 * A behavioral eval definition — describes one dimension that can be measured.
 * Plugins register these when they load; the autoresearch engine consumes them.
 */
export interface EvalDefinition {
  /** Unique name, e.g. "type-coverage", "test-pass-rate" */
  name: string;
  /** Which behavioral category this falls under */
  category: EvalCategory;
  /** Human-readable description of what this eval measures */
  description: string;
  /** Shell command to run the eval */
  command: string;
  /**
   * Regex pattern (as string) to extract a numeric metric from command output.
   * Must contain exactly one capture group that yields a number.
   * If omitted, pass/fail (exit code 0 / non-0) is used.
   */
  metricPattern?: string;
  /** Weight for weighted scoring (default: 1.0) */
  weight: number;
  /** True = higher metric is better; false = lower is better */
  higherIsBetter: boolean;
  /** Which plugin registered this eval */
  source?: string;
}

// =============================================================================
// Eval Registry
// =============================================================================

export interface EvalRegistry {
  /**
   * Register an eval definition.
   * Overwrites any existing eval with the same name.
   */
  register(evalDef: EvalDefinition): void;

  /**
   * Register multiple eval definitions at once.
   */
  registerBatch(evalDefs: EvalDefinition[]): void;

  /**
   * Get an eval by name, or null if not found.
   */
  get(name: string): EvalDefinition | null;

  /**
   * List all registered eval definitions.
   */
  list(): EvalDefinition[];

  /**
   * Filter evals by category.
   */
  filterByCategory(category: EvalCategory): EvalDefinition[];

  /**
   * Filter evals by source plugin.
   */
  filterBySource(source: string): EvalDefinition[];

  /**
   * Remove an eval by name.
   * Returns true if it was found and removed.
   */
  remove(name: string): boolean;

  /**
   * Clear all registered evals.
   */
  clear(): void;

  /**
   * Get a summary of registered evals grouped by category.
   */
  summary(): Record<string, { count: number; names: string[] }>;

  /**
   * Total number of registered evals.
   */
  size(): number;
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Create a new EvalRegistry instance.
 */
export function createEvalRegistry(): EvalRegistry {
  const evals = new Map<string, EvalDefinition>();

  return {
    register(evalDef: EvalDefinition): void {
      // Validate the definition
      if (!evalDef.name || evalDef.name.trim() === "") {
        throw new Error("Eval definition must have a non-empty name");
      }
      if (!EVAL_CATEGORIES.includes(evalDef.category)) {
        throw new Error(
          `Invalid eval category "${evalDef.category}". Valid categories: ${EVAL_CATEGORIES.join(", ")}`,
        );
      }
      if (!evalDef.command || evalDef.command.trim() === "") {
        throw new Error(`Eval "${evalDef.name}" must have a non-empty command`);
      }

      evals.set(evalDef.name, { ...evalDef });
    },

    registerBatch(evalDefs: EvalDefinition[]): void {
      for (const def of evalDefs) {
        this.register(def);
      }
    },

    get(name: string): EvalDefinition | null {
      return evals.get(name) ?? null;
    },

    list(): EvalDefinition[] {
      return Array.from(evals.values());
    },

    filterByCategory(category: EvalCategory): EvalDefinition[] {
      return Array.from(evals.values()).filter((e) => e.category === category);
    },

    filterBySource(source: string): EvalDefinition[] {
      return Array.from(evals.values()).filter((e) => e.source === source);
    },

    remove(name: string): boolean {
      return evals.delete(name);
    },

    clear(): void {
      evals.clear();
    },

    summary(): Record<string, { count: number; names: string[] }> {
      const result: Record<string, { count: number; names: string[] }> = {};
      for (const evalDef of evals.values()) {
        const cat = evalDef.category;
        const existing = result[cat] ?? { count: 0, names: [] };
        existing.count++;
        existing.names.push(evalDef.name);
        result[cat] = existing;
      }
      return result;
    },

    size(): number {
      return evals.size;
    },
  };
}

// =============================================================================
// Default Eval Definitions
// =============================================================================

/**
 * Default eval definitions for a TypeScript/Node.js project.
 * Plugins can use these as a starting point and add their own.
 */
export const DEFAULT_EVAL_DEFINITIONS: EvalDefinition[] = [
  {
    name: "tests-pass",
    category: "code_generation",
    description: "All existing tests must pass",
    command: "pnpm test 2>&1; echo \"EXIT_CODE=$?\"",
    weight: 3.0,
    higherIsBetter: true,
    source: "core",
  },
  {
    name: "type-check",
    category: "type_analysis",
    description: "TypeScript compilation with strict mode (no errors)",
    command: "npx tsc --noEmit 2>&1; echo \"EXIT_CODE=$?\"",
    weight: 2.0,
    higherIsBetter: true,
    source: "core",
  },
  {
    name: "lint-clean",
    category: "code_generation",
    description: "No new lint warnings or errors",
    command: "npx eslint . --max-warnings 0 2>&1; echo \"EXIT_CODE=$?\"",
    weight: 1.0,
    higherIsBetter: true,
    source: "core",
  },
  {
    name: "build-success",
    category: "code_generation",
    description: "Production build completes without errors",
    command: "pnpm build 2>&1; echo \"EXIT_CODE=$?\"",
    weight: 2.5,
    higherIsBetter: true,
    source: "core",
  },
];
