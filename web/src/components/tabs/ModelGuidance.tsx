import { OpenModelDiscovery } from './OpenModelDiscovery';
import { useMemo, useState } from 'react';
import type { CatalogEntry } from '../../lib/modelCatalog';
import { modelNeeds, recommendedChoices, relevantChoices, type ModelNeed } from '../../lib/modelGuidance';

const needPresentation: Record<ModelNeed, { icon: string; title: string; example: string }> = {
  writing: { icon: '✎', title: 'Chat and write', example: 'Emails, ideas, better wording' },
  coding: { icon: '</>', title: 'Code and troubleshoot', example: 'Understand code, fix a bug' },
  documents: { icon: '▤', title: 'Summarize and analyze', example: 'Documents, notes, meeting summaries' },
};

export function ModelGuidance({ view, catalog, cloudConnected, canConfigure, onUse, onConnectCloud, connecting, connectionError, onExpert }: {
  view: 'guided' | 'compare'; catalog: CatalogEntry[]; cloudConnected: boolean; canConfigure: boolean;
  onUse: (id: string) => void; onConnectCloud: () => Promise<void>; connecting: boolean; connectionError: string; onExpert: () => void;
}) {
  const [need, setNeed] = useState<ModelNeed>('writing');
  const [location, setLocation] = useState('all');
  const [cost, setCost] = useState('all');
  const choices = useMemo(() => relevantChoices(catalog, need), [catalog, need]);
  const displayed = view === 'guided' ? recommendedChoices(choices) : choices.filter(choice =>
    (location === 'all' || (location === 'local') === (choice.route.source === 'local')) && (cost !== 'known' || choice.cost.amount !== null));
  return <div className="models-guidance">
    <fieldset className="models-needs"><legend>What would you like to do?</legend>
      <div className="models-need-grid">{modelNeeds.map(item => <button className="models-need-card" aria-pressed={need === item.id} key={item.id} onClick={() => setNeed(item.id)}>
        <span className="models-need-icon" aria-hidden="true">{needPresentation[item.id].icon}</span>
        <span className="models-need-copy"><strong>{needPresentation[item.id].title}</strong><small>{needPresentation[item.id].example}</small></span>
        <span className="models-need-check" aria-hidden="true">{need === item.id ? '✓' : ''}</span>
      </button>)}</div>
    </fieldset>
    {view === 'compare' && <div className="models-compare-filters">
      <label>Runs on<select value={location} onChange={event => setLocation(event.target.value)}><option value="all">Anywhere</option><option value="local">Host computer</option><option value="remote">Remote service</option></select></label>
      <label>Cost<select value={cost} onChange={event => setCost(event.target.value)}><option value="all">All prices</option><option value="known">Known price</option></select></label>
      <span className="muted">Usable models · Capabilities matched to your task</span>
    </div>}
    {connectionError && <p role="alert">{connectionError}</p>}
    {displayed.length > 0 && <div className="models-selection-heading"><h3>{view === 'guided' ? 'Your selection' : 'Available models'}</h3><span>{displayed.length} option{displayed.length > 1 ? 's' : ''}</span></div>}
    <div className="models-choice-grid">{displayed.map((choice, index) => <article className={`models-choice${view === 'guided' && index === 0 ? ' models-choice-primary' : ''}`} key={`${choice.model.id}:${choice.route.accountId}`}>
      {view === 'guided' && <span className="models-choice-badge">{index === 0 ? 'Suggested choice' : 'Alternative'}</span>}
      <h3>{choice.model.name}</h3><p>{choice.reason}</p>
      <dl><div><dt>Cost</dt><dd>{choice.cost.label}</dd></div><div><dt>Data</dt><dd>{choice.data}</dd></div><div><dt>Speed</dt><dd>{choice.speed.label}</dd></div><div><dt>Dependency</dt><dd>{choice.dependency}</dd></div></dl>
      <button className="btn" onClick={() => onUse(choice.route.modelId)}>Chat<span className="sr-only"> with {choice.model.name}</span></button>
      <details><summary>Why this choice?</summary><p>This model supports your task and has a chat route. This is not a quality ranking.</p>
        <p>{choice.route.source === 'local' ? 'Host may be another computer. This does not install anything on your phone. Logs and extensions have their own privacy settings.' : `Processing depends on ${choice.route.label} and its terms. Open weights do not remove dependence on this service.`}</p>
        {need === 'documents' && <p>This selection covers text; it does not guarantee support for every file or its full length.</p>}
        <p>Comparable speed and cost evidence is unavailable. Equal evidence uses alphabetical order, with no cloud or local preference.</p>
        <a href={choice.evidence.source} target="_blank" rel="noreferrer">Documented capabilities</a><p className="muted">Selection {choice.evidence.version} · reviewed {choice.evidence.reviewedAt}</p>
      </details>
    </article>)}</div>
    {!displayed.length && <section className="models-guidance-empty" aria-labelledby="models-empty-title">
      <div className="models-empty-symbol" aria-hidden="true">{choices.length ? '⌕' : '◇'}</div>
      <div className="models-empty-copy"><h3 id="models-empty-title">{choices.length ? 'No models match these filters' : 'No ready-to-chat selection yet'}</h3>
        <p>{choices.length ? 'Broaden your filters to see available models.' : 'No connected model matches our reviewed selection. Explore public models below.'}</p>
        <div className="models-empty-actions">{choices.length
          ? <button className="btn" onClick={() => { setLocation('all'); setCost('all'); }}>Reset filters</button>
          : <><button className="btn" onClick={onExpert}>Explore my models <span aria-hidden="true">→</span></button>
            {!cloudConnected && canConfigure && <button className="btn ghost" disabled={connecting} onClick={() => void onConnectCloud()}>{connecting ? 'Connecting…' : 'Connect Cloud'}</button>}</>}
        </div>
      </div>
    </section>}
    <OpenModelDiscovery compact={view === 'guided'} />
    <details className="models-local-help"><summary>What about my computer?</summary><p>Automatic setup with consent and a test is not available here yet. No download will start. Existing installations stay unchanged.</p><p>On mobile, the model runs on Host, not on your phone.</p></details>
  </div>;
}
