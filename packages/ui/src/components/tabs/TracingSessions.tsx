import React from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { TTFT_BUCKET_ORDER, TTFT_CONTEXT_LABELS, fmt, formatTokenCount, pct, usd } from "../../lib/ui";
import { Metric } from "../Metric";
import { WidgetGrid } from "../WidgetGrid";
import type { SessionTurn, SessionsResponse } from "../../types";

type Props = {
  sessionStats: SessionsResponse;
  sessionStatsLoading: boolean;
  expandedSessionKey: string | null;
  sessionTurns: SessionTurn[];
  sessionTurnsLoading: boolean;
  toggleSession: (sessionKey: string) => void;
};

const TOKEN_CHART_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)"];

function formatTtftDuration(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value >= 10_000) return `${(value / 1000).toFixed(value >= 100_000 ? 0 : 1)}s`;
  return `${Math.round(value)}ms`;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)} h`;
  return `${(ms / 86_400_000).toFixed(1)} d`;
}

function formatSignedTokens(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${formatTokenCount(value)}`;
}

function modelLabel(models: string[]): string {
  if (!models.length) return "—";
  if (models.length === 1) return models[0];
  return `${models[0]} +${models.length - 1}`;
}

function average(values: number[]): number | undefined {
  if (!values.length) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function SessionTurnDetails({ turns, loading }: { turns: SessionTurn[]; loading: boolean }) {
  if (loading) return <div className="muted trace-loading">Loading session turns...</div>;
  if (!turns.length) return <div className="muted trace-loading">No turns recorded for this session in the selected range.</div>;
  let previousInput: number | undefined;
  const chartRows = turns.map((turn, index) => {
    const growth = index === 0 || typeof previousInput !== "number" ? undefined : turn.inputTokens - previousInput;
    previousInput = turn.inputTokens;
    return {
      ...turn,
      turnNumber: index + 1,
      growth,
      label: `#${index + 1}`,
    };
  });
  const growthSamples = chartRows.map((row) => row.growth).filter((value): value is number => typeof value === "number");
  const averageGrowth = average(growthSamples);
  return (
    <>
      <div className="session-turn-summary">
        <span>New tokens per turn (avg) <strong>{formatSignedTokens(averageGrowth)}</strong></span>
        <span>Cache read <strong>{formatTokenCount(turns.reduce((sum, turn) => sum + turn.cachedInputTokens, 0))}</strong></span>
        <span>Cache written <strong>{formatTokenCount(turns.reduce((sum, turn) => sum + turn.cacheWriteTokens, 0))}</strong></span>
      </div>
      <div className="chart-wrap session-turn-chart">
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={chartRows}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
            <XAxis dataKey="label" minTickGap={16} />
            <YAxis tickFormatter={(value: any) => formatTokenCount(Number(value) || 0)} />
            <Tooltip formatter={(value: any, name: any) => [formatTokenCount(Number(value) || 0), name]} />
            <Legend />
            <Line isAnimationActive={false} type="monotone" dataKey="inputTokens" name="input" stroke={TOKEN_CHART_COLORS[0]} strokeWidth={2} dot={false} />
            <Line isAnimationActive={false} type="monotone" dataKey="cachedInputTokens" name="cached input" stroke={TOKEN_CHART_COLORS[1]} strokeWidth={2} dot={false} />
            <Line isAnimationActive={false} type="monotone" dataKey="outputTokens" name="output" stroke={TOKEN_CHART_COLORS[2]} strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="table-wrap">
        <table className="data-table session-turn-table">
          <thead>
            <tr><th>#</th><th>Time</th><th>Model</th><th>Input</th><th>Cached</th><th>Cache write</th><th>Output</th><th>Δ context</th><th>TTFT</th><th>Latency</th><th>Attempts</th><th>Status</th></tr>
          </thead>
          <tbody>
            {chartRows.map((turn) => (
              <tr key={`${turn.clientRequestId}-${turn.at}`} className={turn.isError ? "trace-row-error" : ""}>
                <td>{turn.turnNumber}</td>
                <td className="mono">{fmt(turn.at)}</td>
                <td className="mono">{turn.model ?? "—"}</td>
                <td>{formatTokenCount(turn.inputTokens)}</td>
                <td>{formatTokenCount(turn.cachedInputTokens)}</td>
                <td>{formatTokenCount(turn.cacheWriteTokens)}</td>
                <td>{formatTokenCount(turn.outputTokens)}</td>
                <td>{formatSignedTokens(turn.growth)}</td>
                <td>{typeof turn.ttftMs === "number" ? formatTtftDuration(turn.ttftMs) : "—"}</td>
                <td>{Math.round(turn.latencyMs)}ms</td>
                <td>{turn.upstreamAttempts}</td>
                <td><span className={`badge ${turn.isError ? "badge-warn" : "badge-live"}`}>{turn.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function TracingSessions({
  sessionStats,
  sessionStatsLoading,
  expandedSessionKey,
  sessionTurns,
  sessionTurnsLoading,
  toggleSession,
}: Props) {
  const summary = sessionStats.summary;
  const sessions = sessionStats.sessions;
  const coverage = sessionStats.coverage;
  const initialContextRows = TTFT_BUCKET_ORDER.map((bucket) => ({
    bucket,
    label: TTFT_CONTEXT_LABELS[bucket],
    sessions: summary.initialInputTokenBuckets[bucket] ?? 0,
  })).filter((row) => row.sessions > 0);
  const tokenComposition = [
    { label: "Cache read", tokens: summary.cachedInputTokens },
    { label: "Cache write", tokens: summary.cacheWriteTokens },
    { label: "Uncached", tokens: Math.max(0, summary.inputTokens - summary.cachedInputTokens - summary.cacheWriteTokens) },
  ];

  return (
    <>
      <WidgetGrid storageKey="activity-sessions" label="Session metrics">
        <Metric loading={sessionStatsLoading} widgetId="sessions" title="Sessions" value={`${summary.sessions}`} detail={`${summary.turns} turns in this range`} />
        <Metric loading={sessionStatsLoading} widgetId="session-coverage" title="Session coverage" value={pct(summary.coverage)} detail={`${coverage.identifiedAttempts}/${coverage.totalAttempts} attempts carry a session id`} tone={summary.coverage < 0.5 ? "warning" : "default"} />
        <Metric loading={sessionStatsLoading} widgetId="initial-context" title="Median initial context" value={summary.initialInputTokensMedian === undefined ? "—" : formatTokenCount(summary.initialInputTokensMedian)} detail="First turn input tokens" />
        <Metric loading={sessionStatsLoading} widgetId="turns-per-session" title="Turns / session" value={summary.turnsPerSessionMedian ? summary.turnsPerSessionMedian.toFixed(1) : "—"} detail="Median interactions per session" />
        <Metric loading={sessionStatsLoading} widgetId="cache-reads" title="Cache reads" value={summary.cachedInputRatio === undefined ? "—" : pct(summary.cachedInputRatio)} detail={`${formatTokenCount(summary.cachedInputTokens)} cached input tokens`} />
        <Metric loading={sessionStatsLoading} widgetId="cache-savings" title="Cache savings" value={usd(summary.cacheSavingsUsd)} detail={`${formatTokenCount(summary.cacheWriteTokens)} tokens written to cache`} />
      </WidgetGrid>

      <section className="grid cards2 trace-chart-grid">
        <section className="panel">
          <div className="section-split-header">
            <div><h2>Initial context size</h2><p className="muted">Sessions by first-turn input tokens.</p></div>
            <span className="badge">sessions</span>
          </div>
          <div className="chart-wrap">
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={initialContextRows}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                <XAxis dataKey="label" interval={0} />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Bar isAnimationActive={false} dataKey="sessions" name="sessions" fill="var(--chart-1)" radius={[5, 5, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>
        <section className="panel">
          <div className="section-split-header">
            <div><h2>Input token composition</h2><p className="muted">How prompts were served across sessions.</p></div>
            <span className="badge">tokens</span>
          </div>
          <div className="chart-wrap">
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={tokenComposition} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                <XAxis type="number" tickFormatter={(value: any) => formatTokenCount(Number(value) || 0)} />
                <YAxis type="category" dataKey="label" width={100} />
                <Tooltip formatter={(value: any) => formatTokenCount(Number(value) || 0)} />
                <Bar isAnimationActive={false} dataKey="tokens" name="tokens" radius={[0, 5, 5, 0]}>
                  {tokenComposition.map((entry, index) => (
                    <Cell key={entry.label} fill={TOKEN_CHART_COLORS[index % TOKEN_CHART_COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>
      </section>

      <section className="panel session-table-panel">
        <div className="section-split-header">
          <div>
            <h2>Sessions</h2>
            <p className="muted">Sessions are grouped by the id sent by the harness. Requests without one are excluded from this view.</p>
          </div>
          <span className={`badge ${summary.coverage === 1 ? "badge-live" : "badge-warn"}`}>
            {coverage.identifiedAttempts}/{coverage.totalAttempts} attributed
          </span>
        </div>
        <div className="table-wrap">
          <table className="data-table session-table">
            <thead>
              <tr>
                <th>Session</th><th>Project</th><th>Models</th><th>Turns</th><th>Initial context</th><th>Median input</th><th>Growth</th><th>Output / turn</th><th>Cache read</th><th>Cache turns</th><th>Cache write</th><th>Cost</th><th>Savings</th><th>Duration</th><th><span className="sr-only">Details</span></th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => {
                const isExpanded = expandedSessionKey === session.sessionKey;
                return (
                  <React.Fragment key={session.sessionKey}>
                    <tr className={session.errorTurns > 0 ? "trace-row-error" : ""}>
                      <td>
                        <div className="trace-cell-stack">
                          <strong className="mono">{session.sessionKey.slice(0, 8)}</strong>
                          <span className="muted">{session.application ?? "Unknown harness"}</span>
                        </div>
                      </td>
                      <td>{session.projectId ? session.projectName ?? session.projectId : "—"}</td>
                      <td className="mono">{modelLabel(session.models)}</td>
                      <td>{session.turns}</td>
                      <td>
                        <div className="trace-cell-stack">
                          <strong>{session.initialInputTokens === undefined ? "—" : formatTokenCount(session.initialInputTokens)}</strong>
                          <span className="muted">{TTFT_CONTEXT_LABELS[session.initialInputTokenBucket] ?? "Unknown"}</span>
                        </div>
                      </td>
                      <td>{session.medianInputTokens === undefined ? "—" : formatTokenCount(session.medianInputTokens)}</td>
                      <td>{formatSignedTokens(session.contextGrowthTokens)}</td>
                      <td>{session.medianOutputTokens === undefined ? "—" : formatTokenCount(session.medianOutputTokens)}</td>
                      <td>{session.cachedInputRatio === undefined ? "—" : pct(session.cachedInputRatio)}</td>
                      <td>{session.cacheHitTurns}/{session.turns}</td>
                      <td>{formatTokenCount(session.cacheWriteTokens)}</td>
                      <td>
                        <div className="trace-cell-stack">
                          <strong>{usd(session.costUsd)}</strong>
                          <span className="muted">{session.errorTurns > 0 ? `${session.errorTurns} failed turns` : `${formatTokenCount(session.outputTokens)} output`}</span>
                        </div>
                      </td>
                      <td>{usd(session.cacheSavingsUsd)}</td>
                      <td>{formatDuration(session.durationMs)}</td>
                      <td><button type="button" className="trace-expand-button" onClick={() => toggleSession(session.sessionKey)} aria-expanded={isExpanded}>{isExpanded ? "Hide" : "Inspect"}</button></td>
                    </tr>
                    {isExpanded && (
                      <tr className="trace-expanded-row">
                        <td colSpan={15}>
                          <div className="expanded-trace session-expanded">
                            <div className="expanded-trace-heading">
                              <div><span className="eyebrow">Session detail</span><strong className="mono">{session.sessionKey}</strong></div>
                              <span className="badge">{session.turns} turns · {fmt(session.firstAt)}</span>
                            </div>
                            <SessionTurnDetails turns={sessionTurns} loading={sessionTurnsLoading} />
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
              {!sessions.length && (
                <tr>
                  <td colSpan={15} className="trace-empty-state">
                    No session-attributed traffic in this range. {coverage.totalAttempts > 0 ? `${coverage.identifiedAttempts} of ${coverage.totalAttempts} provider attempts carried a session id.` : ""}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
