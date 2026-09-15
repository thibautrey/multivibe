import { CartesianGrid, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from 'recharts';
import type { rankOpenModels } from '../../../../src/open-model-ranking';
import type { MemoryAvailability } from '../../../../src/model-recommendation-evidence';
type Row = ReturnType<typeof rankOpenModels>[number];
const colors = { compatible: 'var(--primary)', insufficient: '#d89038', unknown: 'var(--muted)' };
export function ModelBenchmarkChart({ rows, label, memory, onSelect }: { rows: Row[]; label: string; memory?: MemoryAvailability; onSelect: (id: string) => void }) {
  const points = rows.flatMap(row => row.benchmark && row.memory?.requiredMiB != null ? [{id:row.model.id, score:row.benchmark.score, gib:row.memory.requiredMiB/1024, row}] : []);
  const missingScore = rows.filter(row => !row.benchmark).length;
  const missingMemory = rows.filter(row => row.benchmark && row.memory?.requiredMiB == null).length;
  const shared = memory?.accelerator === 'metal' || memory?.accelerator === 'cpu';
  const limits = [memory?.budgetMiB, shared ? memory?.freeHostMiB : undefined].filter((n):n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0);
  const budget = limits.length ? Math.min(...limits)/1024 : undefined;
  return <section id="model-benchmark-chart" className="model-benchmark-chart" aria-label="Benchmark and memory comparison">
    <h3>Quality and memory, at a glance</h3>
    <p>{label} on X · Total runtime memory on Y · Lower and farther right means a higher score using less memory.</p>
    <div className="model-chart-legend"><span style={{color:colors.compatible}}>● Fits available memory</span><span style={{color:colors.insufficient}}>● Exceeds memory</span><span style={{color:colors.unknown}}>● Fit unknown</span></div>
    {points.length ? <div className="model-chart-canvas" role="img" aria-label={`${points.length} models plotted by ${label} and estimated memory. Equivalent values and selection buttons follow in the table.`}>
      <ResponsiveContainer width="100%" height={340}><ScatterChart margin={{top:24,right:28,bottom:30,left:24}}>
        <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
        <XAxis type="number" dataKey="score" name={label} domain={[0,100]} tick={{fill:'var(--muted)'}} label={{value:`${label} · higher is better`,position:'bottom',fill:'var(--muted)'}} />
        <YAxis type="number" dataKey="gib" name="Runtime memory" unit=" GiB" domain={[0,'auto']} tick={{fill:'var(--muted)'}} label={{value:'Memory (GiB)',angle:-90,position:'left',fill:'var(--muted)'}} />
        <Tooltip content={({active,payload}) => {const point = payload?.[0]?.payload as typeof points[number] | undefined; return active && point ? <div className="model-chart-tooltip"><strong>{point.id}</strong><p>{label}: {point.score}</p><p>{point.gib.toFixed(2)} GiB · {point.row.memory?.variant}</p><p>{point.row.benchmark?.sourceType} result · {point.row.benchmark?.verified ? 'Verified' : 'Unverified'}</p></div> : null;}} />
        {budget !== undefined && <ReferenceLine y={budget} ifOverflow="extendDomain" stroke="var(--primary)" strokeDasharray="5 5" label={{value:`Available limit ${budget.toFixed(1)} GiB`,fill:'var(--muted)',position:'insideTopRight'}} />}
        {(['compatible','insufficient','unknown'] as const).map(state => <Scatter key={state} name={state} fill={colors[state]} data={points.filter(point => point.row.compatibility === state)} onClick={(point: typeof points[number]) => onSelect(point.id)} cursor="pointer" />)}
      </ScatterChart></ResponsiveContainer>
    </div> : <p role="status">No models have both this benchmark and a runtime memory estimate yet. Benchmark collection runs in the background; memory estimates require a supported Host and downloaded variants.</p>}
    <p>{points.length} plotted · {missingScore} without this benchmark · {missingMemory} scored models without memory estimates. Memory includes weights, context and compute at 8,192 tokens. Discrete GPU fit also checks RAM and VRAM separately.</p>
    <details><summary>Model values and selection ({points.length})</summary><div className="model-chart-table"><table><thead><tr><th>Model</th><th>Score</th><th>Memory (GiB)</th><th>Fit</th></tr></thead><tbody>{points.map(point => <tr key={point.id}><td><button className="models-text-button" onClick={()=>onSelect(point.id)}>{point.id}</button></td><td>{point.score}</td><td>{point.gib.toFixed(2)}</td><td>{point.row.compatibility}</td></tr>)}</tbody></table></div></details>
    <p>Hugging Face evaluation records. Results can use different harnesses or settings; inspect the source notes before choosing. A parent-model score is a reference for its quantizations, not a measured score for each variant.</p>
  </section>;
}
