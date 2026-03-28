/**
 * GET /api/research — Return experiment analytics for a project.
 *
 * Query params:
 *   project=<projectId>  — required, project ID from config
 *
 * Returns:
 *   { analytics: ResearchAnalytics, experiments: ExperimentLogEntry[] }
 */

import { NextResponse } from "next/server";
import { loadConfig } from "@composio/ao-core";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// We inline a lightweight analysis here instead of importing the plugin package
// to avoid webpack bundling issues with Next.js server components.
// The analytics logic mirrors what's in the plugin package.

interface ExperimentEntry {
  id: number;
  timestamp: string;
  hypothesis: string;
  area?: string;
  files_changed: string[];
  eval_passed: boolean;
  action: "committed" | "reverted";
  commit_hash?: string;
  duration_secs: number;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get("project");

    if (!projectId) {
      return NextResponse.json({ error: "Missing 'project' query param" }, { status: 400 });
    }

    const config = loadConfig();
    const project = config.projects[projectId];

    if (!project) {
      return NextResponse.json(
        { error: `Unknown project: ${projectId}` },
        { status: 404 },
      );
    }

    const projectPath = resolve(project.path.replace(/^~/, process.env["HOME"] || ""));
    const expPath = join(projectPath, "experiments.jsonl");

    if (!existsSync(expPath)) {
      return NextResponse.json({
        analytics: emptyAnalytics(),
        experiments: [],
      });
    }

    const content = readFileSync(expPath, "utf-8");
    const experiments: ExperimentEntry[] = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        experiments.push(JSON.parse(trimmed));
      } catch {
        // Skip malformed lines
      }
    }

    const analytics = analyzeExperiments(experiments);

    return NextResponse.json({ analytics, experiments });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load research data" },
      { status: 500 },
    );
  }
}

// =============================================================================
// Inline Analytics (lightweight server-side version)
// =============================================================================

function analyzeExperiments(entries: ExperimentEntry[]) {
  if (entries.length === 0) return emptyAnalytics();

  const committed = entries.filter((e) => e.action === "committed");
  const reverted = entries.filter((e) => e.action === "reverted");
  const totalDuration = entries.reduce((sum, e) => sum + (e.duration_secs || 0), 0);

  const firstEntry = entries[0];
  const lastEntry = entries[entries.length - 1];
  const firstTs = firstEntry ? new Date(firstEntry.timestamp).getTime() : Date.now();
  const lastTs = lastEntry ? new Date(lastEntry.timestamp).getTime() : Date.now();
  const elapsedMs = lastTs - firstTs;
  const elapsedMins = Math.max(1, elapsedMs / 60_000);
  const timeSinceLastMins = (Date.now() - lastTs) / 60_000;
  const experimentsPerHour = entries.length / Math.max(1, elapsedMins / 60);

  // Area stats
  const areaMap = new Map<string, { total: number; committed: number; durations: number[]; entries: ExperimentEntry[] }>();
  for (const entry of entries) {
    const area = entry.area || detectArea(entry.hypothesis);
    const existing = areaMap.get(area) || { total: 0, committed: 0, durations: [], entries: [] };
    existing.total++;
    if (entry.action === "committed") existing.committed++;
    existing.durations.push(entry.duration_secs || 0);
    existing.entries.push(entry);
    areaMap.set(area, existing);
  }

  const areaStats = Array.from(areaMap.entries())
    .map(([area, data]) => {
      let consecutiveFailures = 0;
      for (let i = data.entries.length - 1; i >= 0; i--) {
        const entry = data.entries[i];
        if (entry && entry.action === "reverted") consecutiveFailures++;
        else break;
      }
      return {
        area,
        total: data.total,
        committed: data.committed,
        reverted: data.total - data.committed,
        successRate: data.total > 0 ? (data.committed / data.total) * 100 : 0,
        avgDuration: data.durations.length > 0
          ? data.durations.reduce((a, b) => a + b, 0) / data.durations.length
          : 0,
        consecutiveFailures,
      };
    })
    .sort((a, b) => b.total - a.total);

  // File stats
  const fileMap = new Map<string, { total: number; inCommits: number; inReverts: number }>();
  for (const entry of entries) {
    for (const file of entry.files_changed || []) {
      const existing = fileMap.get(file) || { total: 0, inCommits: 0, inReverts: 0 };
      existing.total++;
      if (entry.action === "committed") existing.inCommits++;
      else existing.inReverts++;
      fileMap.set(file, existing);
    }
  }

  const fileStats = Array.from(fileMap.entries())
    .map(([file, data]) => ({
      file,
      totalTouches: data.total,
      inCommits: data.inCommits,
      inReverts: data.inReverts,
      successRate: data.total > 0 ? (data.inCommits / data.total) * 100 : 0,
    }))
    .sort((a, b) => b.totalTouches - a.totalTouches)
    .slice(0, 20);

  // Trend
  const trend = computeTrend(entries);

  // Streaks
  const streaks = computeStreaks(entries);

  // Diminishing returns
  const windowSize = 10;
  let diminishingReturns = false;
  if (entries.length >= windowSize) {
    const recent = entries.slice(-windowSize);
    const recentSuccess = recent.filter((e) => e.action === "committed").length / recent.length;
    if (recentSuccess < 0.2) diminishingReturns = true;
    else if (trend.direction === "declining" && trend.lateRate < 30) diminishingReturns = true;
  }

  const commitFiles = new Set<string>();
  for (const entry of committed) {
    for (const file of entry.files_changed || []) commitFiles.add(file);
  }

  return {
    totalExperiments: entries.length,
    totalCommitted: committed.length,
    totalReverted: reverted.length,
    successRate: (committed.length / entries.length) * 100,
    avgDurationSecs: totalDuration / entries.length,
    totalDurationMins: Math.round(totalDuration / 60),
    experimentsPerHour: Math.round(experimentsPerHour * 10) / 10,
    areaStats,
    fileStats,
    trend,
    streaks,
    diminishingReturns,
    elapsedMins: Math.round(elapsedMins),
    timeSinceLastMins: Math.round(timeSinceLastMins),
    totalFilesTouched: commitFiles.size,
  };
}

function computeTrend(entries: ExperimentEntry[]) {
  if (entries.length < 4) return { direction: "stable" as const, earlyRate: 0, lateRate: 0, delta: 0 };
  const recent = entries.slice(-10);
  const mid = Math.floor(recent.length / 2);
  const first = recent.slice(0, mid);
  const second = recent.slice(mid);
  const earlyRate = first.length > 0 ? (first.filter((e) => e.action === "committed").length / first.length) * 100 : 0;
  const lateRate = second.length > 0 ? (second.filter((e) => e.action === "committed").length / second.length) * 100 : 0;
  const delta = lateRate - earlyRate;
  const direction = delta > 15 ? "improving" as const : delta < -15 ? "declining" as const : "stable" as const;
  return { direction, earlyRate: Math.round(earlyRate * 10) / 10, lateRate: Math.round(lateRate * 10) / 10, delta: Math.round(delta * 10) / 10 };
}

function computeStreaks(entries: ExperimentEntry[]) {
  if (entries.length === 0) {
    return { longestCommitStreak: 0, longestRevertStreak: 0, currentStreak: { type: "committed" as const, length: 0 } };
  }
  let longestCommit = 0, longestRevert = 0;
  const firstEntry = entries[0];
  let currentType = firstEntry ? firstEntry.action : ("committed" as const);
  let currentLen = 1;
  for (let i = 1; i < entries.length; i++) {
    const entry = entries[i];
    if (entry && entry.action === currentType) { currentLen++; }
    else {
      if (currentType === "committed") longestCommit = Math.max(longestCommit, currentLen);
      else longestRevert = Math.max(longestRevert, currentLen);
      currentType = entry ? entry.action : currentType;
      currentLen = 1;
    }
  }
  if (currentType === "committed") longestCommit = Math.max(longestCommit, currentLen);
  else longestRevert = Math.max(longestRevert, currentLen);
  return { longestCommitStreak: longestCommit, longestRevertStreak: longestRevert, currentStreak: { type: currentType, length: currentLen } };
}

const AREA_PATTERNS: Array<{ area: string; patterns: RegExp[] }> = [
  { area: "type-safety", patterns: [/type\s*safe/i, /\bany\b/i, /generic/i, /\btype\b/i] },
  { area: "error-handling", patterns: [/error\s*handl/i, /try[\s-]*catch/i, /\berror\b/i] },
  { area: "code-quality", patterns: [/refactor/i, /simplif/i, /extract/i, /dead\s*code/i, /complex/i] },
  { area: "performance", patterns: [/perf/i, /optimi[sz]/i, /cache/i, /memo/i] },
  { area: "edge-cases", patterns: [/edge\s*case/i, /null/i, /undefined/i, /guard/i] },
];

function detectArea(hypothesis: string): string {
  for (const { area, patterns } of AREA_PATTERNS) {
    for (const p of patterns) {
      if (p.test(hypothesis)) return area;
    }
  }
  return "other";
}

function emptyAnalytics() {
  return {
    totalExperiments: 0, totalCommitted: 0, totalReverted: 0, successRate: 0,
    avgDurationSecs: 0, totalDurationMins: 0, experimentsPerHour: 0,
    areaStats: [], fileStats: [],
    trend: { direction: "stable" as const, earlyRate: 0, lateRate: 0, delta: 0 },
    streaks: { longestCommitStreak: 0, longestRevertStreak: 0, currentStreak: { type: "committed" as const, length: 0 } },
    diminishingReturns: false, elapsedMins: 0, timeSinceLastMins: 0, totalFilesTouched: 0,
  };
}
