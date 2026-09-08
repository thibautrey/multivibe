import React from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { TraceStats } from "../types";
import { formatTokenCount } from "../lib/ui";
import { runtimeIdentityForProvider } from "../lib/runtimeCatalog";

type Row = TraceStats["ttftByProviderModel"][number];

const seconds = (ms: number) => `${(ms / 1000).toFixed(2)} s`;
const cacheLabel = (row: Row) => row.cachedInputRatio === undefined ? "cache n/a" : `${Math.round(row.cachedInputRatio * 100)}% cached`;
const inputLabel = (row: Row) => row.medianInputTokens === undefined ? "—" : formatTokenCount(row.medianInputTokens);
const rowKey = (row: Row) => `${row.provider}:${row.model}:${row.inputTokenBucket}`;

function ModelLabel({ row }: { row: Row }) {
  const provider = runtimeIdentityForProvider(row.provider);
  return <div className="ttft-comparison-model">
    <strong>{row.model}</strong>
    <small><img src={provider.iconUrl} alt="" />{provider.label} · {row.samples.toLocaleString()} samples</small>
    <small>{cacheLabel(row)} · median input {inputLabel(row)}</small>
    <small>{row.confidence === "low" ? <span className="ttft-low-confidence">Low sample confidence</span> : row.rank ? `Rank ${row.rank}` : "Unranked"}</small>
  </div>;
}

export function TtftComparisonChart({ rows, scaleMax, view }: {
  rows: Row[];
  scaleMax: number;
  view: "range" | "line";
}) {
  const ticks = Array.from({ length: 5 }, (_, i) => scaleMax * i / 4);
  return <div className={`ttft-comparison ttft-comparison-${view}`}>
    <div className="ttft-comparison-legend">
      <span><i className="ttft-key-p50" />p50 · typical wait</span>
      <span><i className="ttft-key-p95" />p95 · 95% start within</span>
      <span>{view === "range" ? "← Faster" : "↓ Faster"}</span>
    </div>
    {view === "range" ? <div className="ttft-comparison-ranges">
      {rows.map((row) => <div className="ttft-comparison-row" key={rowKey(row)}>
        <ModelLabel row={row} />
        <div className="ttft-comparison-measure">
          <svg viewBox="0 0 100 24" preserveAspectRatio="none" role="img"
            aria-label={`${row.model}: p50 ${seconds(row.ttftP50Ms)}, p95 ${seconds(row.ttftP95Ms)}`}>
            {ticks.map((tick) => <line key={tick} x1={tick / scaleMax * 96 + 2} x2={tick / scaleMax * 96 + 2} y1="0" y2="24" stroke="var(--line)" vectorEffect="non-scaling-stroke" />)}
            <line x1={row.ttftP50Ms / scaleMax * 96 + 2} x2={row.ttftP95Ms / scaleMax * 96 + 2} y1="12" y2="12" stroke="var(--primary-soft)" strokeWidth="10" vectorEffect="non-scaling-stroke" />
            <line x1={row.ttftP50Ms / scaleMax * 96 + 2} x2={row.ttftP50Ms / scaleMax * 96 + 2} y1="12" y2="12" stroke="var(--chart-1)" strokeWidth="10" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            <line x1={row.ttftP95Ms / scaleMax * 96 + 2} x2={row.ttftP95Ms / scaleMax * 96 + 2} y1="8" y2="16" stroke="var(--chart-4)" strokeWidth="3" vectorEffect="non-scaling-stroke" />
          </svg>
          <div className="ttft-comparison-values"><span>p50 <strong>{seconds(row.ttftP50Ms)}</strong></span><span>p95 <strong>{seconds(row.ttftP95Ms)}</strong></span></div>
        </div>
      </div>)}
      <div className="ttft-comparison-axis"><div /> <div><div className="ttft-comparison-ticks">{ticks.map((tick) => <span key={tick}>{seconds(tick)}</span>)}</div><div className="ttft-axis-title">Time to first token (seconds)</div></div></div>
    </div> : <>
      <div className="ttft-line-scroll" role="region" aria-label="TTFT line chart; models ordered by p50" tabIndex={0}>
        <div style={{ minWidth: Math.max(320, rows.length * 150), height: 340 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={rows.map((row) => ({ ...row, key: rowKey(row) }))} margin={{ top: 24, right: 35, bottom: 35, left: 12 }} accessibilityLayer>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="key" interval={0} height={60} padding={{ left: 60, right: 60 }} tick={({ x, y, payload }) => {
                const row = rows.find((item) => rowKey(item) === payload.value);
                return <text x={x} y={Number(y) + 14} textAnchor="middle" fontSize={11}>
                  <tspan x={x}>{row?.model}</tspan><tspan x={x} dy="17">{row ? runtimeIdentityForProvider(row.provider).label : ""}</tspan>
                </text>;
              }} label={{ value: "Model · ordered by p50", position: "bottom", offset: 12 }} />
              <YAxis domain={[0, scaleMax]} ticks={ticks} width={55} tickFormatter={(value: number) => seconds(value)} />
              <Tooltip content={({ active, payload }) => {
                const row = payload?.[0]?.payload as Row | undefined;
                return active && row ? <div className="ttft-chart-tooltip"><ModelLabel row={row} /><p>p50 {seconds(row.ttftP50Ms)} · p95 {seconds(row.ttftP95Ms)}</p></div> : null;
              }} />
              <Line type="linear" dataKey="ttftP50Ms" name="p50" stroke="var(--chart-1)" strokeWidth={2} dot={{ r: 4 }} activeDot={{ r: 6 }} isAnimationActive={false} />
              <Line type="linear" dataKey="ttftP95Ms" name="p95" stroke="var(--chart-4)" strokeWidth={2} strokeDasharray="5 4" dot={{ r: 4 }} activeDot={{ r: 6 }} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
      <p className="muted ttft-line-note">{rows.length === 1 ? "One model in this bucket: each percentile is a single point." : "Model comparison; connecting lines are not a time trend."}</p>
      <div className="ttft-line-models">{rows.map((row) => <div key={rowKey(row)}><ModelLabel row={row} /><div className="ttft-comparison-values"><span>p50 {seconds(row.ttftP50Ms)}</span><span>p95 {seconds(row.ttftP95Ms)}</span></div></div>)}</div>
    </>}
  </div>;
}
