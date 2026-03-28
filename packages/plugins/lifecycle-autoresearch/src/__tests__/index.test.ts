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
      expect(prompt).toContain("ALWAYS include the \"area\" field");
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
});
