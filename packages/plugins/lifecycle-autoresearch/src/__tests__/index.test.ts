import { describe, it, expect } from "vitest";
import {
  AutoResearchEngine,
  generateAutoResearchPrompt,
  RESEARCH_AGENDA_TEMPLATE,
  RATCHET_RUNNER_SCRIPT,
  manifest,
  create,
  // Analytics re-exports
  analyzeExperiments,
  detectDiminishingReturns,
  suggestNextArea,
  formatAnalyticsReport,
  computeTrend,
  computeStreaks,
  detectArea,
  // Eval suite re-exports
  scoreDimension,
  aggregateResults,
  generateEvalPromptSection,
  generateCategoryTaxonomy,
  DEFAULT_EVAL_DIMENSIONS,
  EVAL_CATEGORIES,
  // Trace re-exports
  parseAgentLog,
  traceToSummary,
  buildTrace,
  batchTraceSummary,
  generateTracePromptSection,
  // Dogfood re-exports
  generateEvalFromRevert,
  detectRevertPatterns,
  suggestEvals,
  formatEvalSuggestionsMarkdown,
} from "../index.js";

import type {
  EvalDimension,
  TraceEntry,
  ExperimentTrace,
} from "../index.js";

// =============================================================================
// Test Fixtures
// =============================================================================

function makeEntry(overrides: Partial<Parameters<typeof analyzeExperiments>[0][number]> = {}) {
  return {
    id: 1,
    timestamp: "2026-03-28T10:00:00Z",
    hypothesis: "Improve error handling in session manager",
    files_changed: ["packages/core/src/session-manager.ts"],
    eval_passed: true,
    metrics: {},
    action: "committed" as const,
    commit_hash: "abc123",
    duration_secs: 45,
    ...overrides,
  };
}

function makeEntries(count: number, successRate = 0.5) {
  const entries = [];
  for (let i = 0; i < count; i++) {
    const isCommit = i / count < successRate;
    entries.push(
      makeEntry({
        id: i + 1,
        timestamp: new Date(Date.now() - (count - i) * 60_000).toISOString(),
        hypothesis: `Experiment ${i + 1}: ${isCommit ? "simplify error handling" : "optimize performance cache"}`,
        action: isCommit ? "committed" : "reverted",
        eval_passed: isCommit,
        duration_secs: 30 + Math.floor(Math.random() * 60),
        files_changed: [`packages/core/src/file-${i % 5}.ts`],
      }),
    );
  }
  return entries;
}

function makeTraceEntry(overrides: Partial<TraceEntry> = {}): TraceEntry {
  return {
    tool: "read_file",
    argsSummary: "src/index.ts",
    resultSummary: "File read successfully",
    durationMs: 150,
    timestamp: "2026-03-28T10:00:00Z",
    success: true,
    ...overrides,
  };
}

function makeTrace(overrides: Partial<ExperimentTrace> = {}): ExperimentTrace {
  return {
    experimentId: 1,
    startedAt: "2026-03-28T10:00:00Z",
    endedAt: "2026-03-28T10:01:00Z",
    totalDurationMs: 60000,
    entries: [
      makeTraceEntry({ tool: "read_file", argsSummary: "src/index.ts" }),
      makeTraceEntry({ tool: "edit_file", argsSummary: "src/index.ts" }),
      makeTraceEntry({ tool: "run_command", argsSummary: "pnpm test" }),
    ],
    hypothesis: "Fix error handling",
    outcome: "committed",
    toolCallCount: 3,
    failedToolCalls: 0,
    filesRead: ["src/index.ts"],
    filesEdited: ["src/index.ts"],
    commandsRun: ["pnpm test"],
    ...overrides,
  };
}

// =============================================================================
// Plugin Manifest & Factory Tests
// =============================================================================

describe("AutoResearch Plugin", () => {
  describe("manifest", () => {
    it("has correct name and slot", () => {
      expect(manifest.name).toBe("autoresearch");
      expect(manifest.slot).toBe("agent");
      expect(manifest.version).toBe("0.1.0");
    });
  });

  describe("create()", () => {
    it("creates an AutoResearchEngine with default config", () => {
      const engine = create();
      expect(engine).toBeInstanceOf(AutoResearchEngine);
      expect(engine.name).toBe("autoresearch");
    });

    it("creates an engine with custom config", () => {
      const engine = create({
        evalCommand: "npm test",
        maxExperiments: 50,
        mutationSurface: ["src/**"],
      });
      const resolved = engine.getResolvedConfig();
      expect(resolved.evalCommand).toBe("npm test");
      expect(resolved.maxExperiments).toBe(50);
      expect(resolved.mutationSurface).toEqual(["src/**"]);
    });
  });

  // ===========================================================================
  // System Prompt Tests (including new adaptive features)
  // ===========================================================================

  describe("generateAutoResearchPrompt()", () => {
    it("generates a non-empty system prompt", () => {
      const prompt = generateAutoResearchPrompt({});
      expect(prompt).toBeTruthy();
      expect(prompt.length).toBeGreaterThan(100);
    });

    it("includes the ratchet loop steps", () => {
      const prompt = generateAutoResearchPrompt({});
      expect(prompt).toContain("Step 1: READ");
      expect(prompt).toContain("Step 2: ANALYZE");
      expect(prompt).toContain("Step 3: PROPOSE");
      expect(prompt).toContain("Step 4: IMPLEMENT");
      expect(prompt).toContain("Step 5: EVALUATE");
      expect(prompt).toContain("Step 6: DECIDE");
      expect(prompt).toContain("Step 7: LOG");
      expect(prompt).toContain("Step 8: SELF-REFLECT");
      expect(prompt).toContain("Step 9: REPEAT");
    });

    it("includes the eval command", () => {
      const prompt = generateAutoResearchPrompt({ evalCommand: "yarn test:ci" });
      expect(prompt).toContain("yarn test:ci");
    });

    it("includes mutation surface", () => {
      const prompt = generateAutoResearchPrompt({
        mutationSurface: ["src/core/**", "lib/utils/**"],
      });
      expect(prompt).toContain("src/core/**");
      expect(prompt).toContain("lib/utils/**");
    });

    it("includes protected files", () => {
      const prompt = generateAutoResearchPrompt({
        protectedFiles: ["critical.ts", "config/**"],
      });
      expect(prompt).toContain("critical.ts");
      expect(prompt).toContain("config/**");
    });

    it("includes the agenda file path", () => {
      const prompt = generateAutoResearchPrompt({ agendaFile: "my-agenda.md" });
      expect(prompt).toContain("my-agenda.md");
    });

    it("includes maxExperiments when set", () => {
      const prompt = generateAutoResearchPrompt({ maxExperiments: 100 });
      expect(prompt).toContain("100");
    });

    it("includes critical rules", () => {
      const prompt = generateAutoResearchPrompt({});
      expect(prompt).toContain("CRITICAL RULES");
      expect(prompt).toContain("NEVER modify test files");
      expect(prompt).toContain("ALWAYS run the full test suite");
      expect(prompt).toContain("ALWAYS revert failed experiments");
    });

    it("mentions PR creation when enabled", () => {
      const prompt = generateAutoResearchPrompt({ createPR: true, prThreshold: 10 });
      expect(prompt).toContain("PR Creation");
      expect(prompt).toContain("10");
    });

    it("omits PR section when disabled", () => {
      const prompt = generateAutoResearchPrompt({ createPR: false });
      expect(prompt).not.toContain("PR Creation");
    });

    it("includes benchmark command when provided", () => {
      const prompt = generateAutoResearchPrompt({ benchCommand: "pnpm bench" });
      expect(prompt).toContain("pnpm bench");
    });

    it("includes optimization targets", () => {
      const prompt = generateAutoResearchPrompt({
        targets: [
          {
            name: "latency",
            type: "performance",
            command: "pnpm bench:latency",
            higherIsBetter: false,
          },
        ],
      });
      expect(prompt).toContain("latency");
      expect(prompt).toContain("pnpm bench:latency");
      expect(prompt).toContain("lower is better");
    });

    // New adaptive features
    it("includes adaptive strategy rules", () => {
      const prompt = generateAutoResearchPrompt({});
      expect(prompt).toContain("Adaptive Strategy Rules");
      expect(prompt).toContain("Area Cooldown");
      expect(prompt).toContain("Diminishing Returns");
      expect(prompt).toContain("Hot File Avoidance");
      expect(prompt).toContain("Progressive Boldness");
    });

    it("includes self-reflection step", () => {
      const prompt = generateAutoResearchPrompt({});
      expect(prompt).toContain("SELF-REFLECT");
      expect(prompt).toContain("every 5th experiment");
    });

    it("includes cooldown rule in analysis step", () => {
      const prompt = generateAutoResearchPrompt({});
      expect(prompt).toContain("Cooldown rule");
      expect(prompt).toContain("3+ consecutive reverts");
    });

    it("includes Focus Area in hypothesis step", () => {
      const prompt = generateAutoResearchPrompt({});
      expect(prompt).toContain("**Focus Area**");
    });

    it("includes area field in log format", () => {
      const prompt = generateAutoResearchPrompt({});
      expect(prompt).toContain('"area"');
      expect(prompt).toContain('ALWAYS include the "area" field');
    });

    it("includes budget awareness for limited experiments", () => {
      const prompt = generateAutoResearchPrompt({ maxExperiments: 50 });
      expect(prompt).toContain("budget of **50 experiments**");
      expect(prompt).toContain("be bolder");
    });

    it("includes unlimited budget message when no limit", () => {
      const prompt = generateAutoResearchPrompt({ maxExperiments: 0 });
      expect(prompt).toContain("unlimited experiments");
      expect(prompt).toContain("Pace yourself");
    });

    // Multi-metric eval prompt integration
    it("includes multi-metric eval section when evalDimensions are configured", () => {
      const dims: EvalDimension[] = [
        {
          name: "tests-pass",
          category: "code_generation",
          description: "All tests must pass",
          command: "pnpm test",
          weight: 3.0,
          higherIsBetter: true,
        },
        {
          name: "type-check",
          category: "type_analysis",
          description: "TypeScript compilation",
          command: "npx tsc --noEmit",
          weight: 2.0,
          higherIsBetter: true,
        },
      ];
      const prompt = generateAutoResearchPrompt({ evalDimensions: dims });
      expect(prompt).toContain("Multi-Metric Evaluation Suite");
      expect(prompt).toContain("tests-pass");
      expect(prompt).toContain("type-check");
      expect(prompt).toContain("Eval Category Taxonomy");
      expect(prompt).toContain("weighted average");
    });

    it("does NOT include multi-metric section when no evalDimensions", () => {
      const prompt = generateAutoResearchPrompt({});
      expect(prompt).not.toContain("Multi-Metric Evaluation Suite");
    });

    // Trace logging prompt integration
    it("includes trace logging section when enableTracing is true", () => {
      const prompt = generateAutoResearchPrompt({ enableTracing: true });
      expect(prompt).toContain("Trace Logging");
      expect(prompt).toContain("traces.jsonl");
    });

    it("does NOT include trace section when enableTracing is false", () => {
      const prompt = generateAutoResearchPrompt({ enableTracing: false });
      expect(prompt).not.toContain("Trace Logging");
    });
  });

  // ===========================================================================
  // Template & Script Tests
  // ===========================================================================

  describe("RESEARCH_AGENDA_TEMPLATE", () => {
    it("is a non-empty markdown template", () => {
      expect(RESEARCH_AGENDA_TEMPLATE).toBeTruthy();
      expect(RESEARCH_AGENDA_TEMPLATE).toContain("# Research Agenda");
      expect(RESEARCH_AGENDA_TEMPLATE).toContain("## Goal");
      expect(RESEARCH_AGENDA_TEMPLATE).toContain("## Current Priorities");
      expect(RESEARCH_AGENDA_TEMPLATE).toContain("## Constraints");
    });
  });

  describe("RATCHET_RUNNER_SCRIPT", () => {
    it("is a valid bash script", () => {
      expect(RATCHET_RUNNER_SCRIPT).toContain("#!/usr/bin/env bash");
      expect(RATCHET_RUNNER_SCRIPT).toContain("set -euo pipefail");
    });

    it("includes git operations", () => {
      expect(RATCHET_RUNNER_SCRIPT).toContain("git diff");
      expect(RATCHET_RUNNER_SCRIPT).toContain("AUTORESEARCH_RESULT");
    });
  });

  // ===========================================================================
  // AutoResearchEngine Class Tests
  // ===========================================================================

  describe("AutoResearchEngine", () => {
    it("returns correct system prompt", () => {
      const engine = new AutoResearchEngine({ evalCommand: "make test" });
      const prompt = engine.getSystemPrompt();
      expect(prompt).toContain("make test");
      expect(prompt).toContain("AutoResearch Protocol");
    });

    it("returns the agenda template", () => {
      const engine = new AutoResearchEngine({});
      expect(engine.getAgendaTemplate()).toBe(RESEARCH_AGENDA_TEMPLATE);
    });

    it("returns the ratchet script", () => {
      const engine = new AutoResearchEngine({});
      expect(engine.getRatchetScript()).toBe(RATCHET_RUNNER_SCRIPT);
    });

    it("resolves config with defaults", () => {
      const engine = new AutoResearchEngine({ evalCommand: "pytest" });
      const resolved = engine.getResolvedConfig();
      expect(resolved.evalCommand).toBe("pytest");
      expect(resolved.agendaFile).toBe("research-agenda.md");
      expect(resolved.experimentBudgetSecs).toBe(300);
      expect(resolved.branchPrefix).toBe("autoresearch");
    });

    it("hasAdaptiveStrategy returns true for default config", () => {
      const engine = new AutoResearchEngine({});
      expect(engine.hasAdaptiveStrategy()).toBe(true);
    });

    it("resolves evalDimensions and enableTracing defaults", () => {
      const engine = new AutoResearchEngine({});
      const resolved = engine.getResolvedConfig();
      expect(resolved.evalDimensions).toEqual([]);
      expect(resolved.enableTracing).toBe(false);
    });
  });

  // ===========================================================================
  // Analytics Engine Tests
  // ===========================================================================

  describe("detectArea()", () => {
    it("detects type-safety hypotheses", () => {
      expect(detectArea("Eliminate any usage in session-manager")).toBe("type-safety");
      expect(detectArea("Add type annotations to utils")).toBe("type-safety");
      expect(detectArea("Strengthen generic types")).toBe("type-safety");
    });

    it("detects error-handling hypotheses", () => {
      expect(detectArea("Improve error handling in lifecycle")).toBe("error-handling");
      expect(detectArea("Add proper error classes for failures")).toBe("error-handling");
    });

    it("detects performance hypotheses", () => {
      expect(detectArea("Optimize the hot path in session polling")).toBe("performance");
      expect(detectArea("Add memoization for repeated lookups")).toBe("performance");
    });

    it("detects code-quality hypotheses", () => {
      expect(detectArea("Refactor complex function into helpers")).toBe("code-quality");
      expect(detectArea("Remove dead code in prompt-builder")).toBe("code-quality");
      expect(detectArea("Simplify nested conditionals")).toBe("code-quality");
    });

    it("detects edge-case hypotheses", () => {
      expect(detectArea("Handle null array gracefully")).toBe("edge-cases");
      expect(detectArea("Add guard for undefined config")).toBe("edge-cases");
    });

    it("returns other for unrecognized hypotheses", () => {
      expect(detectArea("Rearrange import statements alphabetically")).toBe("other");
    });
  });

  describe("analyzeExperiments()", () => {
    it("returns empty analytics for no entries", () => {
      const result = analyzeExperiments([]);
      expect(result.totalExperiments).toBe(0);
      expect(result.successRate).toBe(0);
      expect(result.areaStats).toEqual([]);
    });

    it("computes correct success rate", () => {
      const entries = [
        makeEntry({ id: 1, action: "committed" }),
        makeEntry({ id: 2, action: "reverted", eval_passed: false }),
        makeEntry({ id: 3, action: "committed" }),
      ];
      const result = analyzeExperiments(entries);
      expect(result.totalExperiments).toBe(3);
      expect(result.totalCommitted).toBe(2);
      expect(result.totalReverted).toBe(1);
      expect(result.successRate).toBeCloseTo(66.67, 0);
    });

    it("computes area stats", () => {
      const entries = [
        makeEntry({ id: 1, hypothesis: "Fix error handling", action: "committed" }),
        makeEntry({ id: 2, hypothesis: "Improve error messages", action: "reverted" }),
        makeEntry({ id: 3, hypothesis: "Optimize cache lookup", action: "committed" }),
      ];
      const result = analyzeExperiments(entries);
      expect(result.areaStats.length).toBeGreaterThan(0);
      const errorArea = result.areaStats.find((a) => a.area === "error-handling");
      expect(errorArea).toBeDefined();
      expect(errorArea!.total).toBe(2);
      expect(errorArea!.committed).toBe(1);
    });

    it("computes file stats", () => {
      const entries = [
        makeEntry({ id: 1, files_changed: ["a.ts", "b.ts"], action: "committed" }),
        makeEntry({ id: 2, files_changed: ["a.ts"], action: "reverted" }),
      ];
      const result = analyzeExperiments(entries);
      const aFile = result.fileStats.find((f) => f.file === "a.ts");
      expect(aFile).toBeDefined();
      expect(aFile!.totalTouches).toBe(2);
      expect(aFile!.inCommits).toBe(1);
      expect(aFile!.inReverts).toBe(1);
    });

    it("computes experiments per hour", () => {
      const now = Date.now();
      const entries = [
        makeEntry({ id: 1, timestamp: new Date(now - 3600_000).toISOString() }),
        makeEntry({ id: 2, timestamp: new Date(now - 1800_000).toISOString() }),
        makeEntry({ id: 3, timestamp: new Date(now).toISOString() }),
      ];
      const result = analyzeExperiments(entries);
      expect(result.experimentsPerHour).toBeGreaterThan(0);
    });

    it("detects consecutive failures per area", () => {
      const entries = [
        makeEntry({ id: 1, hypothesis: "Fix error handling", action: "committed" }),
        makeEntry({ id: 2, hypothesis: "Better error messages", action: "reverted" }),
        makeEntry({ id: 3, hypothesis: "Error class refactor", action: "reverted" }),
        makeEntry({ id: 4, hypothesis: "Error recovery paths", action: "reverted" }),
      ];
      const result = analyzeExperiments(entries);
      const errorArea = result.areaStats.find((a) => a.area === "error-handling");
      expect(errorArea!.consecutiveFailures).toBe(3);
    });

    // New: dimension analytics
    it("computes dimension analytics when entries have dimension_scores", () => {
      const entries = [
        makeEntry({
          id: 1,
          action: "committed",
          dimension_scores: { "tests-pass": 100, "type-check": 90, "lint-clean": 85 },
        }),
        makeEntry({
          id: 2,
          action: "committed",
          dimension_scores: { "tests-pass": 100, "type-check": 95, "lint-clean": 90 },
        }),
        makeEntry({
          id: 3,
          action: "reverted",
          dimension_scores: { "tests-pass": 0, "type-check": 80, "lint-clean": 100 },
        }),
      ];
      const result = analyzeExperiments(entries);

      expect(result.dimensionAnalytics).toBeDefined();
      expect(result.dimensionAnalytics!.dimensions["tests-pass"]).toBeDefined();
      expect(result.dimensionAnalytics!.dimensions["tests-pass"]!.count).toBe(3);
      expect(result.dimensionAnalytics!.dimensions["tests-pass"]!.avgScore).toBeCloseTo(66.7, 0);
    });

    it("computes category breakdown from dimension scores", () => {
      const entries = [
        makeEntry({
          id: 1,
          dimension_scores: { "tests-pass": 100, "type-check": 90 },
        }),
        makeEntry({
          id: 2,
          dimension_scores: { "tests-pass": 95, "type-check": 85 },
        }),
      ];
      const result = analyzeExperiments(entries);

      expect(result.categoryBreakdown).toBeDefined();
      expect(Object.keys(result.categoryBreakdown!.categories).length).toBeGreaterThan(0);
    });

    it("does not include dimension analytics when no dimension_scores", () => {
      const entries = [makeEntry({ id: 1 }), makeEntry({ id: 2 })];
      const result = analyzeExperiments(entries);
      expect(result.dimensionAnalytics).toBeUndefined();
      expect(result.categoryBreakdown).toBeUndefined();
    });
  });

  describe("computeTrend()", () => {
    it("returns stable for few entries", () => {
      const entries = [makeEntry({ id: 1 }), makeEntry({ id: 2 })];
      const trend = computeTrend(entries);
      expect(trend.direction).toBe("stable");
    });

    it("detects improving trend", () => {
      const entries = [
        ...Array.from({ length: 5 }, (_, i) => makeEntry({ id: i + 1, action: "reverted" })),
        ...Array.from({ length: 5 }, (_, i) => makeEntry({ id: i + 6, action: "committed" })),
      ];
      const trend = computeTrend(entries);
      expect(trend.direction).toBe("improving");
      expect(trend.delta).toBeGreaterThan(0);
    });

    it("detects declining trend", () => {
      const entries = [
        ...Array.from({ length: 5 }, (_, i) => makeEntry({ id: i + 1, action: "committed" })),
        ...Array.from({ length: 5 }, (_, i) => makeEntry({ id: i + 6, action: "reverted" })),
      ];
      const trend = computeTrend(entries);
      expect(trend.direction).toBe("declining");
      expect(trend.delta).toBeLessThan(0);
    });
  });

  describe("computeStreaks()", () => {
    it("returns zeros for empty entries", () => {
      const result = computeStreaks([]);
      expect(result.longestCommitStreak).toBe(0);
      expect(result.longestRevertStreak).toBe(0);
    });

    it("detects longest commit streak", () => {
      const entries = [
        makeEntry({ id: 1, action: "committed" }),
        makeEntry({ id: 2, action: "committed" }),
        makeEntry({ id: 3, action: "committed" }),
        makeEntry({ id: 4, action: "reverted" }),
        makeEntry({ id: 5, action: "committed" }),
      ];
      const result = computeStreaks(entries);
      expect(result.longestCommitStreak).toBe(3);
      expect(result.currentStreak).toEqual({ type: "committed", length: 1 });
    });

    it("detects current revert streak", () => {
      const entries = [
        makeEntry({ id: 1, action: "committed" }),
        makeEntry({ id: 2, action: "reverted" }),
        makeEntry({ id: 3, action: "reverted" }),
      ];
      const result = computeStreaks(entries);
      expect(result.currentStreak).toEqual({ type: "reverted", length: 2 });
    });
  });

  describe("detectDiminishingReturns()", () => {
    it("returns false for few entries", () => {
      const entries = makeEntries(5, 0.1);
      expect(detectDiminishingReturns(entries)).toBe(false);
    });

    it("returns true when recent success rate is very low", () => {
      // 10 entries, all reverted
      const entries = Array.from({ length: 10 }, (_, i) =>
        makeEntry({
          id: i + 1,
          action: "reverted",
          timestamp: new Date(Date.now() - (10 - i) * 60_000).toISOString(),
        }),
      );
      expect(detectDiminishingReturns(entries)).toBe(true);
    });

    it("returns false when success rate is healthy", () => {
      // 10 entries, 70% committed
      const entries = Array.from({ length: 10 }, (_, i) =>
        makeEntry({
          id: i + 1,
          action: i < 7 ? "committed" : "reverted",
          timestamp: new Date(Date.now() - (10 - i) * 60_000).toISOString(),
        }),
      );
      expect(detectDiminishingReturns(entries)).toBe(false);
    });
  });

  describe("suggestNextArea()", () => {
    it("returns first agenda priority with no entries", () => {
      const agenda = "## Priorities\n1. **Type Safety** — fix any types";
      expect(suggestNextArea([], agenda)).toBe("Type Safety");
    });

    it("returns a string for entries with data", () => {
      const entries = [
        makeEntry({ id: 1, hypothesis: "Fix error handling", action: "committed" }),
        makeEntry({ id: 2, hypothesis: "Optimize performance", action: "reverted" }),
      ];
      const result = suggestNextArea(entries, "");
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe("formatAnalyticsReport()", () => {
    it("formats a non-empty report", () => {
      const entries = makeEntries(10, 0.6);
      const analytics = analyzeExperiments(entries);
      const report = formatAnalyticsReport(analytics);
      expect(report).toContain("AutoResearch Analytics Report");
      expect(report).toContain("Total Experiments");
      expect(report).toContain("Committed");
      expect(report).toContain("Focus Areas");
    });

    it("includes diminishing returns warning when applicable", () => {
      const entries = Array.from({ length: 10 }, (_, i) =>
        makeEntry({
          id: i + 1,
          action: "reverted",
          timestamp: new Date(Date.now() - (10 - i) * 60_000).toISOString(),
        }),
      );
      const analytics = analyzeExperiments(entries);
      const report = formatAnalyticsReport(analytics);
      expect(report).toContain("DIMINISHING RETURNS");
    });
  });

  // ===========================================================================
  // Eval Suite Tests (Component 1)
  // ===========================================================================

  describe("Eval Suite", () => {
    const testDim: EvalDimension = {
      name: "test-coverage",
      category: "test_quality",
      description: "Test coverage percentage",
      command: "pnpm test:coverage",
      metricExtractor: /coverage:\s*([\d.]+)%/,
      weight: 2.0,
      higherIsBetter: true,
      baseline: 80,
    };

    describe("EVAL_CATEGORIES", () => {
      it("contains expected categories", () => {
        expect(EVAL_CATEGORIES).toContain("code_generation");
        expect(EVAL_CATEGORIES).toContain("type_analysis");
        expect(EVAL_CATEGORIES).toContain("performance");
        expect(EVAL_CATEGORIES).toContain("error_handling");
        expect(EVAL_CATEGORIES).toContain("custom");
      });
    });

    describe("DEFAULT_EVAL_DIMENSIONS", () => {
      it("has at least 3 default dimensions", () => {
        expect(DEFAULT_EVAL_DIMENSIONS.length).toBeGreaterThanOrEqual(3);
      });

      it("includes tests-pass with highest weight", () => {
        const testsPass = DEFAULT_EVAL_DIMENSIONS.find((d) => d.name === "tests-pass");
        expect(testsPass).toBeDefined();
        expect(testsPass!.weight).toBe(3.0);
      });
    });

    describe("scoreDimension()", () => {
      it("scores a passed dimension with value above baseline at 100", () => {
        const result = scoreDimension(testDim, true, 85, 200);
        expect(result.passed).toBe(true);
        expect(result.normalizedScore).toBeGreaterThan(100 * 0.9); // ~106.25, capped at 100
        expect(result.delta).toBe(5); // 85 - 80
      });

      it("scores a passed dimension at 100%", () => {
        const result = scoreDimension(testDim, true, 80, 200);
        expect(result.normalizedScore).toBe(100);
      });

      it("scores a failed dimension at 0", () => {
        const result = scoreDimension(testDim, false, null, 200);
        expect(result.passed).toBe(false);
        expect(result.normalizedScore).toBe(0);
      });

      it("scores a passed dimension with no metric at 100", () => {
        const dimNoMetric = { ...testDim, baseline: undefined };
        const result = scoreDimension(dimNoMetric, true, null, 200);
        expect(result.normalizedScore).toBe(100);
      });

      it("includes error message when provided", () => {
        const result = scoreDimension(testDim, false, null, 200, "Tests failed");
        expect(result.error).toBe("Tests failed");
      });

      it("correctly handles lower-is-better dimensions", () => {
        const lowerDim: EvalDimension = {
          ...testDim,
          higherIsBetter: false,
          baseline: 100, // 100ms latency baseline
        };
        const result = scoreDimension(lowerDim, true, 50, 200);
        expect(result.normalizedScore).toBe(100); // Capped at 100 (50 is better than 100ms baseline)
        expect(result.delta).toBe(50); // baseline - rawValue = improvement
      });
    });

    describe("aggregateResults()", () => {
      it("computes weighted average correctly", () => {
        const dims: EvalDimension[] = [
          { ...testDim, name: "a", weight: 2.0 },
          { ...testDim, name: "b", weight: 1.0 },
        ];
        const results = [
          scoreDimension(dims[0]!, true, 80, 100),
          scoreDimension(dims[1]!, true, 80, 100),
        ];
        const aggregate = aggregateResults(dims, results);
        expect(aggregate.overallScore).toBe(100); // Both at baseline → 100
        expect(aggregate.allPassed).toBe(true);
      });

      it("detects when not all dimensions pass", () => {
        const dims: EvalDimension[] = [
          { ...testDim, name: "a", weight: 2.0 },
          { ...testDim, name: "b", weight: 1.0 },
        ];
        const results = [
          scoreDimension(dims[0]!, true, 80, 100),
          scoreDimension(dims[1]!, false, null, 100),
        ];
        const aggregate = aggregateResults(dims, results);
        expect(aggregate.allPassed).toBe(false);
      });

      it("computes category scores", () => {
        const dims: EvalDimension[] = [
          { ...testDim, name: "a", category: "code_generation" },
          { ...testDim, name: "b", category: "code_generation" },
          { ...testDim, name: "c", category: "type_analysis" },
        ];
        const results = dims.map((d) => scoreDimension(d, true, 80, 100));
        const aggregate = aggregateResults(dims, results);
        expect(aggregate.categoryScores["code_generation"]).toBeDefined();
        expect(aggregate.categoryScores["code_generation"]!.count).toBe(2);
        expect(aggregate.categoryScores["type_analysis"]).toBeDefined();
      });

      it("computes total duration", () => {
        const dims: EvalDimension[] = [
          { ...testDim, name: "a" },
          { ...testDim, name: "b" },
        ];
        const results = [
          scoreDimension(dims[0]!, true, 80, 300),
          scoreDimension(dims[1]!, true, 80, 200),
        ];
        const aggregate = aggregateResults(dims, results);
        expect(aggregate.totalDurationMs).toBe(500);
      });
    });

    describe("generateEvalPromptSection()", () => {
      it("generates a prompt section with dimension table", () => {
        const section = generateEvalPromptSection([testDim]);
        expect(section).toContain("Multi-Metric Evaluation Suite");
        expect(section).toContain("test-coverage");
        expect(section).toContain("2×"); // weight
        expect(section).toContain("↑ higher");
        expect(section).toContain("weighted average");
      });
    });

    describe("generateCategoryTaxonomy()", () => {
      it("generates a taxonomy table", () => {
        const taxonomy = generateCategoryTaxonomy();
        expect(taxonomy).toContain("Eval Category Taxonomy");
        expect(taxonomy).toContain("file_operations");
        expect(taxonomy).toContain("code_generation");
        expect(taxonomy).toContain("type_analysis");
      });
    });
  });

  // ===========================================================================
  // Trace Logging Tests (Component 2)
  // ===========================================================================

  describe("Trace Logging", () => {
    describe("parseAgentLog()", () => {
      it("parses structured TRACE: JSON lines", () => {
        const log = `
Starting experiment...
TRACE: {"tool":"read_file","argsSummary":"src/index.ts","resultSummary":"ok","durationMs":150,"timestamp":"2026-03-28T10:00:00Z","success":true}
TRACE: {"tool":"edit_file","argsSummary":"src/index.ts","resultSummary":"edited","durationMs":200,"timestamp":"2026-03-28T10:00:01Z","success":true}
Done.
        `;
        const entries = parseAgentLog(log);
        expect(entries).toHaveLength(2);
        expect(entries[0]!.tool).toBe("read_file");
        expect(entries[1]!.tool).toBe("edit_file");
        expect(entries[0]!.durationMs).toBe(150);
      });

      it("parses natural-language tool usage", () => {
        const log = `
Read file "src/utils.ts"
Edit file "src/utils.ts" to fix bug
Run command \`pnpm test\`
Search for "handleError" in codebase
        `;
        const entries = parseAgentLog(log);
        expect(entries.length).toBeGreaterThanOrEqual(3);

        const readEntry = entries.find((e) => e.tool === "read_file");
        expect(readEntry).toBeDefined();
        expect(readEntry!.argsSummary).toContain("src/utils.ts");

        const runEntry = entries.find((e) => e.tool === "run_command");
        expect(runEntry).toBeDefined();
      });

      it("returns empty array for unrecognized text", () => {
        const entries = parseAgentLog("Just some random text with no tool usage");
        expect(entries).toHaveLength(0);
      });

      it("detects errors in natural-language output", () => {
        const log = `Read file "src/missing.ts" — error: not found`;
        const entries = parseAgentLog(log);
        expect(entries.length).toBeGreaterThanOrEqual(1);
        expect(entries[0]!.success).toBe(false);
      });
    });

    describe("buildTrace()", () => {
      it("builds a complete trace from entries", () => {
        const entries: TraceEntry[] = [
          makeTraceEntry({ tool: "read_file", argsSummary: "src/a.ts" }),
          makeTraceEntry({ tool: "edit_file", argsSummary: "src/a.ts" }),
          makeTraceEntry({ tool: "run_command", argsSummary: "pnpm test" }),
        ];

        const trace = buildTrace(
          1,
          "Fix error handling",
          "committed",
          entries,
          "2026-03-28T10:00:00Z",
          "2026-03-28T10:01:00Z",
        );

        expect(trace.experimentId).toBe(1);
        expect(trace.hypothesis).toBe("Fix error handling");
        expect(trace.outcome).toBe("committed");
        expect(trace.toolCallCount).toBe(3);
        expect(trace.failedToolCalls).toBe(0);
        expect(trace.filesRead).toContain("src/a.ts");
        expect(trace.filesEdited).toContain("src/a.ts");
        expect(trace.commandsRun).toContain("pnpm test");
      });

      it("counts failed tool calls", () => {
        const entries: TraceEntry[] = [
          makeTraceEntry({ tool: "read_file", success: true }),
          makeTraceEntry({ tool: "edit_file", success: false, error: "Permission denied" }),
        ];

        const trace = buildTrace(
          1,
          "Test",
          "reverted",
          entries,
          "2026-03-28T10:00:00Z",
          "2026-03-28T10:01:00Z",
        );

        expect(trace.failedToolCalls).toBe(1);
      });
    });

    describe("traceToSummary()", () => {
      it("generates a summary for a committed experiment", () => {
        const trace = makeTrace({ outcome: "committed" });
        const summary = traceToSummary(trace);
        expect(summary).toContain("COMMITTED");
        expect(summary).toContain("Experiment #1");
        expect(summary).toContain("Fix error handling");
      });

      it("generates failure analysis for a reverted experiment", () => {
        const trace = makeTrace({
          outcome: "reverted",
          entries: [
            makeTraceEntry({ tool: "read_file", success: true }),
            makeTraceEntry({ tool: "edit_file", success: true }),
            makeTraceEntry({ tool: "run_command", success: false, error: "Tests failed" }),
          ],
          failedToolCalls: 1,
        });
        const summary = traceToSummary(trace);
        expect(summary).toContain("REVERTED");
        expect(summary).toContain("Failure Analysis");
        expect(summary).toContain("run_command");
      });

      it("warns about edits without reads", () => {
        const trace = makeTrace({
          outcome: "reverted",
          filesRead: [],
          filesEdited: ["src/index.ts"],
          entries: [
            makeTraceEntry({ tool: "edit_file", argsSummary: "src/index.ts" }),
          ],
          failedToolCalls: 0,
        });
        const summary = traceToSummary(trace);
        expect(summary).toContain("without reading");
      });

      it("warns about too many edits", () => {
        const trace = makeTrace({
          outcome: "reverted",
          entries: Array.from({ length: 7 }, (_, i) =>
            makeTraceEntry({ tool: "edit_file", argsSummary: `src/file-${i}.ts` }),
          ),
          failedToolCalls: 0,
        });
        const summary = traceToSummary(trace);
        expect(summary).toContain("too broad");
      });
    });

    describe("batchTraceSummary()", () => {
      it("returns a message for empty traces", () => {
        const summary = batchTraceSummary([]);
        expect(summary).toContain("No traces available");
      });

      it("includes per-experiment summaries", () => {
        const traces = [
          makeTrace({ experimentId: 1, outcome: "committed" }),
          makeTrace({ experimentId: 2, outcome: "reverted" }),
        ];
        const summary = batchTraceSummary(traces);
        expect(summary).toContain("Experiment #1");
        expect(summary).toContain("Experiment #2");
        expect(summary).toContain("Committed: 1");
        expect(summary).toContain("Reverted: 1");
      });

      it("detects cross-experiment failure patterns", () => {
        const traces = [
          makeTrace({
            experimentId: 1,
            outcome: "reverted",
            entries: [
              makeTraceEntry({ tool: "run_command", success: false, error: "Failed" }),
            ],
            failedToolCalls: 1,
          }),
          makeTrace({
            experimentId: 2,
            outcome: "reverted",
            entries: [
              makeTraceEntry({ tool: "run_command", success: false, error: "Failed" }),
            ],
            failedToolCalls: 1,
          }),
          makeTrace({
            experimentId: 3,
            outcome: "committed",
          }),
        ];
        const summary = batchTraceSummary(traces);
        expect(summary).toContain("Failure Patterns");
        expect(summary).toContain("run_command");
      });
    });

    describe("generateTracePromptSection()", () => {
      it("generates instructions for trace logging", () => {
        const section = generateTracePromptSection();
        expect(section).toContain("Trace Logging");
        expect(section).toContain("traces.jsonl");
        expect(section).toContain("experimentId");
      });
    });
  });

  // ===========================================================================
  // Dogfooding Pipeline Tests (Component 4)
  // ===========================================================================

  describe("Dogfooding Pipeline", () => {
    describe("generateEvalFromRevert()", () => {
      it("returns null for committed experiments", () => {
        const exp = makeEntry({ action: "committed" });
        expect(generateEvalFromRevert(exp)).toBeNull();
      });

      it("generates an eval from a reverted experiment with many files", () => {
        const exp = makeEntry({
          action: "reverted",
          files_changed: ["a.ts", "b.ts", "c.ts", "d.ts"],
        });
        const suggestion = generateEvalFromRevert(exp);
        expect(suggestion).not.toBeNull();
        expect(suggestion!.sourcePattern).toBe("scope_creep");
      });

      it("generates an eval from a reverted experiment with trace", () => {
        const exp = makeEntry({ id: 5, action: "reverted" });
        const trace = makeTrace({
          experimentId: 5,
          outcome: "reverted",
          entries: [
            makeTraceEntry({ tool: "run_command", success: false, error: "Tests failed" }),
          ],
          failedToolCalls: 1,
        });
        const suggestion = generateEvalFromRevert(exp, trace);
        expect(suggestion).not.toBeNull();
        expect(suggestion!.category).toBe("error_handling");
      });

      it("generates an eval for blind edits (no reads)", () => {
        const exp = makeEntry({ id: 3, action: "reverted" });
        const trace = makeTrace({
          experimentId: 3,
          outcome: "reverted",
          entries: [
            makeTraceEntry({ tool: "edit_file", argsSummary: "src/index.ts" }),
          ],
          failedToolCalls: 0,
        });
        const suggestion = generateEvalFromRevert(exp, trace);
        expect(suggestion).not.toBeNull();
        expect(suggestion!.sourcePattern).toBe("missing_read");
      });

      it("returns null when no clear failure pattern", () => {
        const exp = makeEntry({
          action: "reverted",
          files_changed: ["a.ts"],
        });
        expect(generateEvalFromRevert(exp)).toBeNull();
      });
    });

    describe("detectRevertPatterns()", () => {
      it("returns empty for less than 2 reverts", () => {
        const experiments = [
          makeEntry({ id: 1, action: "committed" }),
          makeEntry({ id: 2, action: "reverted" }),
        ];
        expect(detectRevertPatterns(experiments)).toHaveLength(0);
      });

      it("detects file toxicity patterns", () => {
        const experiments = [
          makeEntry({ id: 1, action: "reverted", files_changed: ["toxic-file.ts"] }),
          makeEntry({ id: 2, action: "reverted", files_changed: ["toxic-file.ts"] }),
          makeEntry({ id: 3, action: "committed", files_changed: ["good-file.ts"] }),
        ];
        const patterns = detectRevertPatterns(experiments);
        const filePattern = patterns.find((p) => p.type === "file_toxicity");
        expect(filePattern).toBeDefined();
        expect(filePattern!.description).toContain("toxic-file.ts");
      });

      it("detects scope creep pattern", () => {
        const experiments = [
          // Committed with 1 file
          makeEntry({ id: 1, action: "committed", files_changed: ["a.ts"] }),
          // Reverted with many files
          makeEntry({ id: 2, action: "reverted", files_changed: ["a.ts", "b.ts", "c.ts", "d.ts"] }),
          makeEntry({ id: 3, action: "reverted", files_changed: ["e.ts", "f.ts", "g.ts", "h.ts", "i.ts"] }),
        ];
        const patterns = detectRevertPatterns(experiments);
        const scopePattern = patterns.find((p) => p.type === "scope_creep");
        expect(scopePattern).toBeDefined();
      });
    });

    describe("suggestEvals()", () => {
      it("returns empty for all-committed experiments", () => {
        const experiments = [
          makeEntry({ id: 1, action: "committed" }),
          makeEntry({ id: 2, action: "committed" }),
        ];
        expect(suggestEvals(experiments)).toHaveLength(0);
      });

      it("generates suggestions from reverted experiments", () => {
        const experiments = [
          makeEntry({ id: 1, action: "reverted", files_changed: ["a.ts", "b.ts", "c.ts", "d.ts"] }),
          makeEntry({ id: 2, action: "reverted", files_changed: ["a.ts", "c.ts"] }),
          makeEntry({ id: 3, action: "committed", files_changed: ["x.ts"] }),
        ];
        const suggestions = suggestEvals(experiments);
        expect(suggestions.length).toBeGreaterThan(0);
      });

      it("sorts suggestions by confidence", () => {
        const experiments = [
          makeEntry({ id: 1, action: "reverted", files_changed: ["a.ts", "b.ts", "c.ts", "d.ts"] }),
          makeEntry({ id: 2, action: "reverted", files_changed: ["a.ts"] }),
          makeEntry({ id: 3, action: "reverted", files_changed: ["a.ts"] }),
        ];
        const suggestions = suggestEvals(experiments);
        for (let i = 1; i < suggestions.length; i++) {
          expect(suggestions[i]!.confidence).toBeLessThanOrEqual(suggestions[i - 1]!.confidence);
        }
      });

      it("detects area exhaustion from areaStats", () => {
        const experiments = [
          makeEntry({ id: 1, action: "committed" }),
          makeEntry({ id: 2, action: "reverted" }),
        ];
        const areaStats = [
          {
            area: "type-safety",
            total: 10,
            committed: 2,
            reverted: 8,
            successRate: 20,
            avgDuration: 30,
            lastExperimentId: 10,
            consecutiveFailures: 4,
          },
        ];
        const suggestions = suggestEvals(experiments, undefined, areaStats);
        const exhaustionSuggestion = suggestions.find((s) => s.sourcePattern === "area_exhaustion");
        expect(exhaustionSuggestion).toBeDefined();
      });
    });

    describe("formatEvalSuggestionsMarkdown()", () => {
      it("formats empty suggestions", () => {
        const md = formatEvalSuggestionsMarkdown([]);
        expect(md).toContain("No eval suggestions");
      });

      it("formats suggestions as markdown", () => {
        const suggestions = [
          {
            name: "scope-guard",
            category: "code_generation",
            description: "Limit file changes",
            command: "test $(git diff | wc -l) -le 5",
            rationale: "Too many files changed",
            sourcePattern: "scope_creep",
            confidence: 0.7,
          },
        ];
        const md = formatEvalSuggestionsMarkdown(suggestions);
        expect(md).toContain("scope-guard");
        expect(md).toContain("70%");
        expect(md).toContain("code_generation");
        expect(md).toContain("```bash");
      });
    });
  });
});
