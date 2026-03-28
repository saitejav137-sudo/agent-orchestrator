import { describe, it, expect } from "vitest";
import {
  createEvalRegistry,
  DEFAULT_EVAL_DEFINITIONS,
  EVAL_CATEGORIES,
} from "../eval-registry.js";
import type { EvalDefinition } from "../eval-registry.js";

// =============================================================================
// Test Fixtures
// =============================================================================

function makeEvalDef(overrides: Partial<EvalDefinition> = {}): EvalDefinition {
  return {
    name: "test-eval",
    category: "code_generation",
    description: "Test eval definition",
    command: "pnpm test",
    weight: 1.0,
    higherIsBetter: true,
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("Eval Registry", () => {
  describe("createEvalRegistry()", () => {
    it("creates an empty registry", () => {
      const registry = createEvalRegistry();
      expect(registry.size()).toBe(0);
      expect(registry.list()).toEqual([]);
    });
  });

  describe("register()", () => {
    it("registers an eval definition", () => {
      const registry = createEvalRegistry();
      registry.register(makeEvalDef({ name: "my-eval" }));
      expect(registry.size()).toBe(1);
      expect(registry.get("my-eval")).not.toBeNull();
    });

    it("overwrites existing eval with same name", () => {
      const registry = createEvalRegistry();
      registry.register(makeEvalDef({ name: "my-eval", description: "v1" }));
      registry.register(makeEvalDef({ name: "my-eval", description: "v2" }));
      expect(registry.size()).toBe(1);
      expect(registry.get("my-eval")!.description).toBe("v2");
    });

    it("throws for empty name", () => {
      const registry = createEvalRegistry();
      expect(() => registry.register(makeEvalDef({ name: "" }))).toThrow("non-empty name");
    });

    it("throws for invalid category", () => {
      const registry = createEvalRegistry();
      expect(() =>
        registry.register(makeEvalDef({ category: "invalid_category" as any })),
      ).toThrow("Invalid eval category");
    });

    it("throws for empty command", () => {
      const registry = createEvalRegistry();
      expect(() =>
        registry.register(makeEvalDef({ command: "" })),
      ).toThrow("non-empty command");
    });
  });

  describe("registerBatch()", () => {
    it("registers multiple evals at once", () => {
      const registry = createEvalRegistry();
      registry.registerBatch([
        makeEvalDef({ name: "eval-1" }),
        makeEvalDef({ name: "eval-2" }),
        makeEvalDef({ name: "eval-3" }),
      ]);
      expect(registry.size()).toBe(3);
    });
  });

  describe("get()", () => {
    it("returns null for non-existent eval", () => {
      const registry = createEvalRegistry();
      expect(registry.get("non-existent")).toBeNull();
    });

    it("returns the eval definition", () => {
      const registry = createEvalRegistry();
      registry.register(makeEvalDef({ name: "my-eval", description: "test" }));
      const result = registry.get("my-eval");
      expect(result).not.toBeNull();
      expect(result!.name).toBe("my-eval");
      expect(result!.description).toBe("test");
    });
  });

  describe("list()", () => {
    it("returns all registered evals", () => {
      const registry = createEvalRegistry();
      registry.register(makeEvalDef({ name: "a" }));
      registry.register(makeEvalDef({ name: "b" }));
      const all = registry.list();
      expect(all).toHaveLength(2);
      expect(all.map((e) => e.name).sort()).toEqual(["a", "b"]);
    });
  });

  describe("filterByCategory()", () => {
    it("filters evals by category", () => {
      const registry = createEvalRegistry();
      registry.register(makeEvalDef({ name: "a", category: "code_generation" }));
      registry.register(makeEvalDef({ name: "b", category: "type_analysis" }));
      registry.register(makeEvalDef({ name: "c", category: "code_generation" }));

      const codeGen = registry.filterByCategory("code_generation");
      expect(codeGen).toHaveLength(2);
      expect(codeGen.map((e) => e.name).sort()).toEqual(["a", "c"]);
    });

    it("returns empty for category with no evals", () => {
      const registry = createEvalRegistry();
      registry.register(makeEvalDef({ name: "a", category: "code_generation" }));
      expect(registry.filterByCategory("performance")).toHaveLength(0);
    });
  });

  describe("filterBySource()", () => {
    it("filters evals by source", () => {
      const registry = createEvalRegistry();
      registry.register(makeEvalDef({ name: "a", source: "plugin-a" }));
      registry.register(makeEvalDef({ name: "b", source: "plugin-b" }));
      registry.register(makeEvalDef({ name: "c", source: "plugin-a" }));

      const fromA = registry.filterBySource("plugin-a");
      expect(fromA).toHaveLength(2);
    });
  });

  describe("remove()", () => {
    it("removes an eval by name", () => {
      const registry = createEvalRegistry();
      registry.register(makeEvalDef({ name: "to-remove" }));
      expect(registry.size()).toBe(1);
      const removed = registry.remove("to-remove");
      expect(removed).toBe(true);
      expect(registry.size()).toBe(0);
    });

    it("returns false when eval does not exist", () => {
      const registry = createEvalRegistry();
      expect(registry.remove("non-existent")).toBe(false);
    });
  });

  describe("clear()", () => {
    it("clears all evals", () => {
      const registry = createEvalRegistry();
      registry.registerBatch([
        makeEvalDef({ name: "a" }),
        makeEvalDef({ name: "b" }),
      ]);
      expect(registry.size()).toBe(2);
      registry.clear();
      expect(registry.size()).toBe(0);
    });
  });

  describe("summary()", () => {
    it("returns a summary grouped by category", () => {
      const registry = createEvalRegistry();
      registry.register(makeEvalDef({ name: "a", category: "code_generation" }));
      registry.register(makeEvalDef({ name: "b", category: "code_generation" }));
      registry.register(makeEvalDef({ name: "c", category: "type_analysis" }));

      const summary = registry.summary();
      expect(summary["code_generation"]).toBeDefined();
      expect(summary["code_generation"]!.count).toBe(2);
      expect(summary["code_generation"]!.names).toEqual(["a", "b"]);
      expect(summary["type_analysis"]!.count).toBe(1);
    });
  });

  describe("EVAL_CATEGORIES", () => {
    it("includes all expected categories", () => {
      expect(EVAL_CATEGORIES).toContain("file_operations");
      expect(EVAL_CATEGORIES).toContain("retrieval");
      expect(EVAL_CATEGORIES).toContain("code_generation");
      expect(EVAL_CATEGORIES).toContain("refactoring");
      expect(EVAL_CATEGORIES).toContain("tool_use");
      expect(EVAL_CATEGORIES).toContain("type_analysis");
      expect(EVAL_CATEGORIES).toContain("error_handling");
      expect(EVAL_CATEGORIES).toContain("performance");
      expect(EVAL_CATEGORIES).toContain("test_quality");
      expect(EVAL_CATEGORIES).toContain("custom");
    });
  });

  describe("DEFAULT_EVAL_DEFINITIONS", () => {
    it("has at least 3 definitions", () => {
      expect(DEFAULT_EVAL_DEFINITIONS.length).toBeGreaterThanOrEqual(3);
    });

    it("all have valid categories", () => {
      for (const def of DEFAULT_EVAL_DEFINITIONS) {
        expect(EVAL_CATEGORIES).toContain(def.category);
      }
    });

    it("all have non-empty commands", () => {
      for (const def of DEFAULT_EVAL_DEFINITIONS) {
        expect(def.command.length).toBeGreaterThan(0);
      }
    });

    it("can be registered in a registry", () => {
      const registry = createEvalRegistry();
      registry.registerBatch(DEFAULT_EVAL_DEFINITIONS);
      expect(registry.size()).toBe(DEFAULT_EVAL_DEFINITIONS.length);
    });
  });
});
