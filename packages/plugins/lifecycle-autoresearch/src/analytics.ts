/**
 * AutoResearch Analytics Engine
 *
 * Reads experiment history from experiments.jsonl and computes
 * insights: success rates, trends, diminishing returns detection,
 * focus-area breakdowns, hot files, and actionable suggestions.
 */

// =============================================================================
// Types
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
  error?: string;
}

export interface AreaStats {
  area: string;
  total: number;
  committed: number;
  reverted: number;
  successRate: number;
  avgDuration: number;
  lastExperimentId: number;
  consecutiveFailures: number;
}

export interface FileStats {
  file: string;
  totalTouches: number;
  inCommits: number;
  inReverts: number;
  successRate: number;
}

export interface TrendData {
  direction: "improving" | "declining" | "stable";
  /** Success rate of the first half of the window */
  earlyRate: number;
  /** Success rate of the second half of the window */
  lateRate: number;
  /** Magnitude of change (percentage points) */
  delta: number;
}

export interface StreakInfo {
  longestCommitStreak: number;
  longestRevertStreak: number;
  currentStreak: { type: "committed" | "reverted"; length: number };
}

export interface ResearchAnalytics {
  totalExperiments: number;
  totalCommitted: number;
  totalReverted: number;
  successRate: number;
  avgDurationSecs: number;
  totalDurationMins: number;
  experimentsPerHour: number;
  areaStats: AreaStats[];
  fileStats: FileStats[];
  trend: TrendData;
  streaks: StreakInfo;
  diminishingReturns: boolean;
  /** Elapsed time since first experiment in minutes */
  elapsedMins: number;
  /** Time since last experiment in minutes */
  timeSinceLastMins: number;
  /** Estimated total lines impacted (sum of files changed across commits) */
  totalFilesTouched: number;
}

// =============================================================================
// Focus Area Detection
// =============================================================================

/**
 * Heuristically detect the focus area of an experiment from its hypothesis.
 * Maps common keywords to canonical area names.
 */
const AREA_PATTERNS: Array<{ area: string; patterns: RegExp[] }> = [
  {
    area: "type-safety",
    patterns: [/type\s*safe/i, /\bany\b/i, /generic/i, /type\s*annot/i, /typescript/i, /\btype\b/i],
  },
  {
    area: "error-handling",
    patterns: [/error\s*handl/i, /try[\s-]*catch/i, /throw/i, /\berror\b/i, /exception/i, /fault/i],
  },
  {
    area: "code-quality",
    patterns: [
      /refactor/i,
      /simplif/i,
      /extract\s*(?:function|helper|method)/i,
      /dead\s*code/i,
      /complex/i,
      /readab/i,
      /clean/i,
    ],
  },
  {
    area: "performance",
    patterns: [/perf/i, /optimi[sz]/i, /cache/i, /memo/i, /hot\s*path/i, /alloc/i, /speed/i, /fast/i],
  },
  {
    area: "edge-cases",
    patterns: [/edge\s*case/i, /null/i, /undefined/i, /defensive/i, /guard/i, /boundary/i, /empty/i],
  },
  {
    area: "test-coverage",
    patterns: [/test/i, /coverage/i, /untested/i, /assertion/i],
  },
  {
    area: "documentation",
    patterns: [/doc/i, /comment/i, /jsdoc/i, /readme/i],
  },
];

export function detectArea(hypothesis: string): string {
  for (const { area, patterns } of AREA_PATTERNS) {
    for (const pattern of patterns) {
      if (pattern.test(hypothesis)) {
        return area;
      }
    }
  }
  return "other";
}

// =============================================================================
// Core Analytics
// =============================================================================

/**
 * Compute comprehensive analytics from experiment history.
 */
export function analyzeExperiments(entries: ExperimentLogEntry[]): ResearchAnalytics {
  if (entries.length === 0) {
    return emptyAnalytics();
  }

  const committed = entries.filter((e) => e.action === "committed");
  const reverted = entries.filter((e) => e.action === "reverted");
  const totalDuration = entries.reduce((sum, e) => sum + (e.duration_secs || 0), 0);

  // Time calculations
  const firstTs = new Date(entries[0]!.timestamp).getTime();
  const lastTs = new Date(entries[entries.length - 1]!.timestamp).getTime();
  const elapsedMs = lastTs - firstTs;
  const elapsedMins = Math.max(1, elapsedMs / 60_000);
  const timeSinceLastMins = (Date.now() - lastTs) / 60_000;
  const experimentsPerHour = entries.length / Math.max(1, elapsedMins / 60);

  // Area stats
  const areaMap = new Map<string, { total: number; committed: number; durations: number[]; lastId: number; entries: ExperimentLogEntry[] }>();
  for (const entry of entries) {
    const area = detectArea(entry.hypothesis);
    const existing = areaMap.get(area) || { total: 0, committed: 0, durations: [], lastId: 0, entries: [] };
    existing.total++;
    if (entry.action === "committed") existing.committed++;
    existing.durations.push(entry.duration_secs || 0);
    existing.lastId = entry.id;
    existing.entries.push(entry);
    areaMap.set(area, existing);
  }

  const areaStats: AreaStats[] = Array.from(areaMap.entries())
    .map(([area, data]) => {
      // Count consecutive failures at the end
      let consecutiveFailures = 0;
      for (let i = data.entries.length - 1; i >= 0; i--) {
        if (data.entries[i]!.action === "reverted") {
          consecutiveFailures++;
        } else {
          break;
        }
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
        lastExperimentId: data.lastId,
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

  const fileStats: FileStats[] = Array.from(fileMap.entries())
    .map(([file, data]) => ({
      file,
      totalTouches: data.total,
      inCommits: data.inCommits,
      inReverts: data.inReverts,
      successRate: data.total > 0 ? (data.inCommits / data.total) * 100 : 0,
    }))
    .sort((a, b) => b.totalTouches - a.totalTouches);

  // Total unique files touched in commits
  const commitFiles = new Set<string>();
  for (const entry of committed) {
    for (const file of entry.files_changed || []) {
      commitFiles.add(file);
    }
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
    fileStats: fileStats.slice(0, 20), // Top 20 files
    trend: computeTrend(entries),
    streaks: computeStreaks(entries),
    diminishingReturns: detectDiminishingReturns(entries),
    elapsedMins: Math.round(elapsedMins),
    timeSinceLastMins: Math.round(timeSinceLastMins),
    totalFilesTouched: commitFiles.size,
  };
}

// =============================================================================
// Trend Detection
// =============================================================================

/**
 * Detect whether the success rate is improving, declining, or stable
 * over a sliding window.
 */
export function computeTrend(entries: ExperimentLogEntry[], windowSize = 10): TrendData {
  if (entries.length < 4) {
    return { direction: "stable", earlyRate: 0, lateRate: 0, delta: 0 };
  }

  const recent = entries.slice(-Math.min(windowSize, entries.length));
  const mid = Math.floor(recent.length / 2);
  const firstHalf = recent.slice(0, mid);
  const secondHalf = recent.slice(mid);

  const earlyRate = firstHalf.length > 0
    ? (firstHalf.filter((e) => e.action === "committed").length / firstHalf.length) * 100
    : 0;
  const lateRate = secondHalf.length > 0
    ? (secondHalf.filter((e) => e.action === "committed").length / secondHalf.length) * 100
    : 0;

  const delta = lateRate - earlyRate;
  const THRESHOLD = 15; // percentage points

  let direction: TrendData["direction"] = "stable";
  if (delta > THRESHOLD) direction = "improving";
  else if (delta < -THRESHOLD) direction = "declining";

  return { direction, earlyRate: Math.round(earlyRate * 10) / 10, lateRate: Math.round(lateRate * 10) / 10, delta: Math.round(delta * 10) / 10 };
}

// =============================================================================
// Streak Detection
// =============================================================================

export function computeStreaks(entries: ExperimentLogEntry[]): StreakInfo {
  if (entries.length === 0) {
    return {
      longestCommitStreak: 0,
      longestRevertStreak: 0,
      currentStreak: { type: "committed", length: 0 },
    };
  }

  let longestCommit = 0;
  let longestRevert = 0;
  let currentType = entries[0]!.action;
  let currentLen = 1;

  for (let i = 1; i < entries.length; i++) {
    if (entries[i]!.action === currentType) {
      currentLen++;
    } else {
      if (currentType === "committed") longestCommit = Math.max(longestCommit, currentLen);
      else longestRevert = Math.max(longestRevert, currentLen);
      currentType = entries[i]!.action;
      currentLen = 1;
    }
  }
  // Final streak
  if (currentType === "committed") longestCommit = Math.max(longestCommit, currentLen);
  else longestRevert = Math.max(longestRevert, currentLen);

  return {
    longestCommitStreak: longestCommit,
    longestRevertStreak: longestRevert,
    currentStreak: { type: currentType, length: currentLen },
  };
}

// =============================================================================
// Diminishing Returns Detection
// =============================================================================

/**
 * Detect if the research loop is hitting diminishing returns.
 * Returns true if:
 * - Last N experiments have < 20% success rate
 * - OR success rate is declining AND below 30%
 */
export function detectDiminishingReturns(
  entries: ExperimentLogEntry[],
  windowSize = 10,
): boolean {
  if (entries.length < windowSize) return false;

  const recent = entries.slice(-windowSize);
  const recentSuccess = recent.filter((e) => e.action === "committed").length / recent.length;

  if (recentSuccess < 0.2) return true;

  const trend = computeTrend(entries, windowSize);
  if (trend.direction === "declining" && trend.lateRate < 30) return true;

  return false;
}

// =============================================================================
// Next Area Suggestion
// =============================================================================

/**
 * Suggest the next focus area based on experiment history and agenda.
 * Prioritizes areas with high success rates that haven't been tried recently,
 * and avoids areas with high consecutive failure counts.
 */
export function suggestNextArea(
  entries: ExperimentLogEntry[],
  agenda: string,
): string {
  if (entries.length === 0) {
    // Parse first priority from agenda
    const match = agenda.match(/\d+\.\s+\*\*([^*]+)\*\*/);
    return match?.[1]?.trim() ?? "code-quality";
  }

  const analytics = analyzeExperiments(entries);
  const areas = analytics.areaStats;

  // Filter out areas with 3+ consecutive failures (on cooldown)
  const available = areas.filter((a) => a.consecutiveFailures < 3);

  if (available.length === 0) {
    // All areas exhausted — find the one with highest overall success rate
    const best = areas.reduce((a, b) => (a.successRate > b.successRate ? a : b));
    return best.area;
  }

  // Score areas: higher success rate + less recently tried = better
  const maxId = entries[entries.length - 1]?.id ?? 0;
  const scored = available.map((a) => ({
    area: a.area,
    // Weighted score: 60% success rate, 40% recency gap
    score: a.successRate * 0.6 + ((maxId - a.lastExperimentId) / Math.max(1, maxId)) * 100 * 0.4,
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.area ?? "code-quality";
}

// =============================================================================
// Report Formatter
// =============================================================================

/**
 * Format analytics into a rich terminal-friendly report.
 */
export function formatAnalyticsReport(analytics: ResearchAnalytics): string {
  const lines: string[] = [];

  const trendArrow =
    analytics.trend.direction === "improving"
      ? "↑"
      : analytics.trend.direction === "declining"
        ? "↓"
        : "→";

  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("  🔬 AutoResearch Analytics Report");
  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("");

  // Overview
  lines.push("  Overview");
  lines.push("  ─────────────────────────────────────────────────────────────");
  lines.push(`  Total Experiments:     ${analytics.totalExperiments}`);
  lines.push(`  ✅ Committed:          ${analytics.totalCommitted} (${analytics.successRate.toFixed(1)}%)`);
  lines.push(`  ❌ Reverted:           ${analytics.totalReverted} (${(100 - analytics.successRate).toFixed(1)}%)`);
  lines.push(`  ⏱  Total Time:         ${analytics.totalDurationMins} minutes`);
  lines.push(`  📊 Rate:               ${analytics.experimentsPerHour} experiments/hour`);
  lines.push(`  📈 Trend:              ${trendArrow} ${analytics.trend.direction} (${analytics.trend.earlyRate}% → ${analytics.trend.lateRate}%)`);
  lines.push(`  📁 Files Impacted:     ${analytics.totalFilesTouched}`);

  if (analytics.diminishingReturns) {
    lines.push("");
    lines.push("  ⚠️  DIMINISHING RETURNS DETECTED — consider changing research priorities");
  }

  // Streaks
  lines.push("");
  lines.push("  Streaks");
  lines.push("  ─────────────────────────────────────────────────────────────");
  lines.push(`  Longest commit streak: ${analytics.streaks.longestCommitStreak}`);
  lines.push(`  Longest revert streak: ${analytics.streaks.longestRevertStreak}`);
  lines.push(`  Current:               ${analytics.streaks.currentStreak.length}× ${analytics.streaks.currentStreak.type}`);

  // Area breakdown
  if (analytics.areaStats.length > 0) {
    lines.push("");
    lines.push("  Focus Areas");
    lines.push("  ─────────────────────────────────────────────────────────────");
    lines.push("  Area                Total  ✅  ❌  Rate    Avg Time");
    lines.push("  ─────────────────── ─────  ──  ──  ──────  ────────");
    for (const area of analytics.areaStats) {
      const name = area.area.padEnd(20);
      const total = String(area.total).padStart(4);
      const committed = String(area.committed).padStart(3);
      const reverted = String(area.reverted).padStart(3);
      const rate = `${area.successRate.toFixed(0)}%`.padStart(5);
      const dur = `${Math.round(area.avgDuration)}s`.padStart(6);
      const cooldown = area.consecutiveFailures >= 3 ? " 🛑" : "";
      lines.push(`  ${name} ${total}  ${committed}  ${reverted}  ${rate}   ${dur}${cooldown}`);
    }
  }

  // Hot files
  if (analytics.fileStats.length > 0) {
    lines.push("");
    lines.push("  Hot Files (Top 10)");
    lines.push("  ─────────────────────────────────────────────────────────────");
    for (const file of analytics.fileStats.slice(0, 10)) {
      const name = file.file.length > 50 ? "…" + file.file.slice(-49) : file.file;
      const bar = makeBar(file.successRate, 10);
      lines.push(`  ${bar} ${file.successRate.toFixed(0).padStart(3)}%  ${name} (${file.totalTouches}×)`);
    }
  }

  lines.push("");
  lines.push("═══════════════════════════════════════════════════════════════");

  return lines.join("\n");
}

/** Simple ASCII bar chart */
function makeBar(pct: number, width: number): string {
  const filled = Math.round((pct / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

// =============================================================================
// Helpers
// =============================================================================

function emptyAnalytics(): ResearchAnalytics {
  return {
    totalExperiments: 0,
    totalCommitted: 0,
    totalReverted: 0,
    successRate: 0,
    avgDurationSecs: 0,
    totalDurationMins: 0,
    experimentsPerHour: 0,
    areaStats: [],
    fileStats: [],
    trend: { direction: "stable", earlyRate: 0, lateRate: 0, delta: 0 },
    streaks: { longestCommitStreak: 0, longestRevertStreak: 0, currentStreak: { type: "committed", length: 0 } },
    diminishingReturns: false,
    elapsedMins: 0,
    timeSinceLastMins: 0,
    totalFilesTouched: 0,
  };
}
