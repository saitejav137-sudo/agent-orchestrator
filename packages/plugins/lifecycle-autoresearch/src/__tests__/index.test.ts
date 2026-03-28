import { describe, it, expect } from "vitest";
import {
  AutoResearchEngine,
  generateAutoResearchPrompt,
  RESEARCH_AGENDA_TEMPLATE,
  RATCHET_RUNNER_SCRIPT,
  manifest,
  create,
} from "../index.js";

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
      expect(prompt).toContain("Step 8: REPEAT");
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
  });

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
  });
});
