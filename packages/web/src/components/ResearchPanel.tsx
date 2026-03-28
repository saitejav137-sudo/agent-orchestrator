"use client";

import { useState, useEffect } from "react";

// =============================================================================
// Types (matching analytics engine output)
// =============================================================================

interface AreaStats {
  area: string;
  total: number;
  committed: number;
  reverted: number;
  successRate: number;
  avgDuration: number;
  consecutiveFailures: number;
}

interface FileStats {
  file: string;
  totalTouches: number;
  inCommits: number;
  inReverts: number;
  successRate: number;
}

interface TrendData {
  direction: "improving" | "declining" | "stable";
  earlyRate: number;
  lateRate: number;
  delta: number;
}

interface StreakInfo {
  longestCommitStreak: number;
  longestRevertStreak: number;
  currentStreak: { type: "committed" | "reverted"; length: number };
}

interface ResearchAnalytics {
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
  elapsedMins: number;
  timeSinceLastMins: number;
  totalFilesTouched: number;
}

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

interface ResearchData {
  analytics: ResearchAnalytics;
  experiments: ExperimentEntry[];
}

// =============================================================================
// ResearchPanel Component
// =============================================================================

export function ResearchPanel({ projectId }: { projectId: string }) {
  const [data, setData] = useState<ResearchData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Auto-refresh every 10 seconds
  useEffect(() => {
    let mounted = true;

    async function fetchData() {
      try {
        const res = await fetch(`/api/research?project=${encodeURIComponent(projectId)}`);
        if (!res.ok) {
          if (mounted) setError("Failed to load research data");
          return;
        }
        const json = await res.json();
        if (mounted) {
          setData(json);
          setError(null);
        }
      } catch {
        if (mounted) setError("Failed to fetch research data");
      } finally {
        if (mounted) setLoading(false);
      }
    }

    fetchData();
    const interval = setInterval(fetchData, 10_000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [projectId]);

  if (loading) {
    return (
      <div className="rounded-[8px] border border-[var(--color-border-default)] bg-[var(--color-bg-subtle)] p-6">
        <div className="flex items-center gap-2 text-[13px] text-[var(--color-text-muted)]">
          <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
          Loading research data…
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="rounded-[8px] border border-[rgba(239,68,68,0.3)] bg-[rgba(239,68,68,0.05)] p-4 text-[12px] text-[var(--color-status-error)]">
        {error || "No research data available"}
      </div>
    );
  }

  const { analytics, experiments } = data;

  if (analytics.totalExperiments === 0) {
    return (
      <div className="rounded-[8px] border border-[var(--color-border-default)] bg-[var(--color-bg-subtle)] p-6 text-center text-[13px] text-[var(--color-text-muted)]">
        No autoresearch experiments recorded yet.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Stats Bar */}
      <StatsBar analytics={analytics} />

      {/* Experiment Timeline */}
      <ExperimentTimeline experiments={experiments.slice(-40)} />

      {/* Two-column layout: Areas + Hot Files */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <AreaBreakdown areas={analytics.areaStats} />
        <HotFiles files={analytics.fileStats.slice(0, 10)} />
      </div>

      {/* Recent Experiments */}
      <RecentExperiments experiments={experiments.slice(-15).reverse()} />
    </div>
  );
}

// =============================================================================
// Stats Bar
// =============================================================================

function StatsBar({ analytics }: { analytics: ResearchAnalytics }) {
  const trendIcon =
    analytics.trend.direction === "improving"
      ? "↑"
      : analytics.trend.direction === "declining"
        ? "↓"
        : "→";
  const trendColor =
    analytics.trend.direction === "improving"
      ? "var(--color-status-ready)"
      : analytics.trend.direction === "declining"
        ? "var(--color-status-error)"
        : "var(--color-text-muted)";

  return (
    <div className="flex flex-wrap gap-4 rounded-[8px] border border-[var(--color-border-default)] bg-[var(--color-bg-subtle)] px-5 py-4">
      <StatItem
        label="Experiments"
        value={String(analytics.totalExperiments)}
        color="var(--color-text-primary)"
      />
      <StatItem
        label="Committed"
        value={`${analytics.totalCommitted} (${analytics.successRate.toFixed(0)}%)`}
        color="var(--color-status-ready)"
      />
      <StatItem
        label="Reverted"
        value={String(analytics.totalReverted)}
        color="var(--color-status-error)"
      />
      <StatItem
        label="Rate"
        value={`${analytics.experimentsPerHour}/hr`}
        color="var(--color-text-secondary)"
      />
      <StatItem
        label="Trend"
        value={`${trendIcon} ${analytics.trend.direction}`}
        color={trendColor}
      />
      <StatItem
        label="Run Time"
        value={`${analytics.totalDurationMins}m`}
        color="var(--color-text-muted)"
      />
      {analytics.diminishingReturns && (
        <div className="flex items-center gap-1.5 rounded border border-[rgba(245,158,11,0.3)] bg-[rgba(245,158,11,0.08)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-status-attention)]">
          ⚠ Diminishing returns
        </div>
      )}
    </div>
  );
}

function StatItem({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="flex flex-col items-start">
      <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
        {label}
      </span>
      <span className="text-[16px] font-bold tabular-nums" style={{ color }}>
        {value}
      </span>
    </div>
  );
}

// =============================================================================
// Experiment Timeline (visual dots)
// =============================================================================

function ExperimentTimeline({ experiments }: { experiments: ExperimentEntry[] }) {
  if (experiments.length === 0) return null;

  return (
    <div className="rounded-[8px] border border-[var(--color-border-default)] bg-[var(--color-bg-subtle)] px-4 py-3">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
        Experiment Timeline
      </div>
      <div className="flex flex-wrap gap-[3px]">
        {experiments.map((exp) => (
          <div
            key={exp.id}
            title={`#${exp.id}: ${exp.hypothesis.substring(0, 80)} (${exp.action})`}
            className="h-3 w-3 rounded-[2px] transition-transform hover:scale-150"
            style={{
              backgroundColor:
                exp.action === "committed"
                  ? "var(--color-status-ready)"
                  : "var(--color-status-error)",
              opacity: exp.action === "committed" ? 0.9 : 0.6,
            }}
          />
        ))}
      </div>
      <div className="mt-1.5 flex items-center gap-3 text-[10px] text-[var(--color-text-muted)]">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-[1px]" style={{ backgroundColor: "var(--color-status-ready)", opacity: 0.9 }} />
          committed
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-[1px]" style={{ backgroundColor: "var(--color-status-error)", opacity: 0.6 }} />
          reverted
        </span>
      </div>
    </div>
  );
}

// =============================================================================
// Area Breakdown
// =============================================================================

function AreaBreakdown({ areas }: { areas: AreaStats[] }) {
  if (areas.length === 0) return null;

  const maxTotal = Math.max(...areas.map((a) => a.total));

  return (
    <div className="rounded-[8px] border border-[var(--color-border-default)] bg-[var(--color-bg-subtle)] px-4 py-3">
      <div className="mb-3 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
        Focus Areas
      </div>
      <div className="space-y-2">
        {areas.map((area) => (
          <div key={area.area} className="flex items-center gap-3">
            <span className="w-[100px] truncate text-[11px] font-medium text-[var(--color-text-secondary)]">
              {area.area}
            </span>
            <div className="relative h-4 flex-1 overflow-hidden rounded-[3px] bg-[var(--color-bg-default)]">
              {/* Total bar (background) */}
              <div
                className="absolute inset-y-0 left-0 rounded-[3px] bg-[rgba(239,68,68,0.25)]"
                style={{ width: `${(area.total / maxTotal) * 100}%` }}
              />
              {/* Success bar */}
              <div
                className="absolute inset-y-0 left-0 rounded-[3px]"
                style={{
                  width: `${(area.committed / maxTotal) * 100}%`,
                  backgroundColor: "var(--color-status-ready)",
                  opacity: 0.7,
                }}
              />
            </div>
            <span className="w-[40px] text-right text-[11px] tabular-nums text-[var(--color-text-muted)]">
              {area.successRate.toFixed(0)}%
            </span>
            {area.consecutiveFailures >= 3 && (
              <span className="text-[10px] text-[var(--color-status-attention)]" title="On cooldown: 3+ consecutive failures">
                🛑
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// =============================================================================
// Hot Files
// =============================================================================

function HotFiles({ files }: { files: FileStats[] }) {
  if (files.length === 0) return null;

  return (
    <div className="rounded-[8px] border border-[var(--color-border-default)] bg-[var(--color-bg-subtle)] px-4 py-3">
      <div className="mb-3 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
        Hot Files
      </div>
      <div className="space-y-1.5">
        {files.map((file) => {
          const basename = file.file.split("/").pop() || file.file;
          const dir = file.file.split("/").slice(0, -1).join("/");
          return (
            <div key={file.file} className="flex items-center gap-2 text-[11px]">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{
                  backgroundColor:
                    file.successRate >= 60
                      ? "var(--color-status-ready)"
                      : file.successRate >= 30
                        ? "var(--color-status-attention)"
                        : "var(--color-status-error)",
                }}
              />
              <span className="min-w-0 flex-1 truncate" title={file.file}>
                <span className="text-[var(--color-text-muted)]">{dir}/</span>
                <span className="font-medium text-[var(--color-text-secondary)]">{basename}</span>
              </span>
              <span className="shrink-0 tabular-nums text-[var(--color-text-muted)]">
                {file.totalTouches}×
              </span>
              <span className="w-[32px] shrink-0 text-right tabular-nums text-[var(--color-text-muted)]">
                {file.successRate.toFixed(0)}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// =============================================================================
// Recent Experiments List
// =============================================================================

function RecentExperiments({ experiments }: { experiments: ExperimentEntry[] }) {
  if (experiments.length === 0) return null;

  return (
    <div className="rounded-[8px] border border-[var(--color-border-default)] bg-[var(--color-bg-subtle)] px-4 py-3">
      <div className="mb-3 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
        Recent Experiments
      </div>
      <div className="space-y-1">
        {experiments.map((exp) => {
          const time = new Date(exp.timestamp).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          });
          return (
            <div
              key={exp.id}
              className="flex items-start gap-2 rounded px-1.5 py-1 transition-colors hover:bg-[var(--color-bg-default)]"
            >
              <span
                className="mt-0.5 h-3.5 w-3.5 shrink-0 text-center text-[11px] font-bold leading-[14px]"
                style={{
                  color:
                    exp.action === "committed"
                      ? "var(--color-status-ready)"
                      : "var(--color-status-error)",
                }}
              >
                {exp.action === "committed" ? "✓" : "✗"}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-[11px] font-medium tabular-nums text-[var(--color-text-muted)]">
                    #{exp.id}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--color-text-secondary)]">
                    {exp.hypothesis}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2 text-[10px] text-[var(--color-text-muted)]">
                  <span>{time}</span>
                  <span>{exp.duration_secs}s</span>
                  {exp.area && <span className="rounded bg-[var(--color-bg-default)] px-1">{exp.area}</span>}
                  {exp.files_changed?.length > 0 && (
                    <span>{exp.files_changed.length} file{exp.files_changed.length > 1 ? "s" : ""}</span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
