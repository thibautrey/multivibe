import publisherIcons from './publisher-icons.json';
import { ModelVariantsTable } from './ModelVariantsTable';
import type { rankOpenModels } from '../../../../src/open-model-ranking';
import type { MemoryAvailability } from '../../../../src/model-recommendation-evidence';
import type { GuidedChoice } from '../../../../src/model-guidance';
type Row = ReturnType<typeof rankOpenModels>[number];
export function ModelDetailPanel({row,memory,supported,ready,onUse,onPrepare}:{row:Row;memory?:MemoryAvailability;supported:boolean;ready?:GuidedChoice;onUse?:(id:string)=>void;onPrepare:(id:string)=>void}) {
 const name=row.model.id.split('/').pop()?.replace(/[-_]/g,' ');
 const icon=(publisherIcons as Record<string,string>)[row.model.id.split('/')[0].toLowerCase()];
 return <article className="model-detail-panel" aria-label={`${name} details`}>
  <header className="model-detail-heading">{icon && <img src={icon} alt="" width="56" height="56"/>}<div><h3>{name}</h3><p>{row.model.id}</p></div></header>
  <div className="model-detail-stats">{row.model.downloads!==null && <span title="Repository downloads">↓ {new Intl.NumberFormat('en',{notation:'compact'}).format(row.model.downloads)}</span>}<span>{row.model.license}</span>{row.benchmark && <span>{row.benchmark.label} <strong>{row.benchmark.score}</strong></span>}</div>
  <div className="model-detail-actions">{ready && onUse && <button className="btn primary" onClick={()=>onUse(ready.model.id)}>Use model →</button>}<a className="btn ghost" href={row.model.url} target="_blank" rel="noreferrer">{row.model.gated?'Review access':'Hugging Face'} ↗</a></div>
  {row.familyStatus==='unresolved' ? <p className="muted">Original model not confirmed.</p> : <ModelVariantsTable key={row.model.id} row={row} memory={memory} supported={supported} onPrepare={onPrepare} />}
  <section className="model-detail-section"><h4>Details</h4><dl className="model-detail-facts"><div><dt>Architecture</dt><dd>{row.model.architecture ?? 'Unknown'}</dd></div><div><dt>Context</dt><dd>{row.model.context?.toLocaleString('en') ?? 'Unknown'}</dd></div><div><dt>Formats</dt><dd>{[...new Set(row.variants.flatMap(v=>v.model.formats))].join(' · ') || 'Unknown'}</dd></div></dl></section>
  <details className="model-detail-notes"><summary>Benchmark & memory notes</summary>{row.benchmark && <><p>{row.benchmark.label}: {row.benchmark.score}/100 · {row.benchmark.verified?'Verified':'Unverified'} {row.benchmark.sourceType} result.</p><p>{row.benchmark.notes}</p><p>Original-model scores are references for quantizations, not measurements of each variant.</p>{row.benchmark.sourceUrl && /^https?:\/\//.test(row.benchmark.sourceUrl) && <a href={row.benchmark.sourceUrl} target="_blank" rel="noreferrer">Benchmark source ↗</a>}</>}<p>Memory estimates cover text generation at 8,192 tokens. Download size is not RAM. Host checks confirm runtime compatibility before installation.</p>{row.memory && <p>Estimate shown: {row.memory.variant} · {row.memory.artifact} · {row.memory.source==='metadata'?'Pre-download estimate':'Runtime estimate'}.</p>}</details>
  {row.recommendationSources.length>0 && <details className="model-detail-notes"><summary>Sources</summary>{row.recommendationSources.map(source=><p key={source.id}><a href={source.url} target="_blank" rel="noreferrer">{source.label} ↗</a> · {source.kind==='quantization'?'Variant publisher':source.kind==='publisher'?'Original publisher':'Public catalog'} · Checked {source.checkedAt.slice(0,10)}</p>)}</details>}
  <details className="model-detail-notes"><summary>Cost & privacy</summary><dl className="model-detail-facts"><div><dt>Cost</dt><dd>{ready?.cost.label ?? 'Hardware and electricity'}</dd></div><div><dt>Data</dt><dd>{ready?.data ?? 'On Host when run locally'}</dd></div><div><dt>Runs on</dt><dd>{ready?.dependency ?? 'Your Host'}</dd></div></dl></details>
 </article>;
}
