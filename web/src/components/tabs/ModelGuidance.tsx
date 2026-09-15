import { OpenModelDiscovery } from './OpenModelDiscovery';
import { useState } from 'react';
import type { CatalogEntry } from '../../lib/modelCatalog';
import { modelNeeds, type ModelNeed } from '../../lib/modelGuidance';

const needPresentation: Record<ModelNeed, { icon: string; title: string; example: string }> = {
  writing: { icon: '✎', title: 'Chat', example: 'Emails, ideas, better wording' },
  translation: { icon: '↔', title: 'Translate', example: 'Languages and wording' },
  coding: { icon: '</>', title: 'Code', example: 'Understand code, fix a bug' },
  documents: { icon: '▤', title: 'Analyze', example: 'Documents, notes, meeting summaries' },
};

export function ModelGuidance({ view, catalog, cloudConnected, canConfigure, onUse, onConnectCloud, connecting, connectionError, onExpert }: {
  view: 'guided' | 'compare'; catalog: CatalogEntry[]; cloudConnected: boolean; canConfigure: boolean;
  onUse: (id: string) => void; onConnectCloud: () => Promise<void>; connecting: boolean; connectionError: string; onExpert: () => void;
}) {
  const [need, setNeed] = useState<ModelNeed>(() => { try { const value=localStorage.getItem('multivibe.models.need.v1'); return modelNeeds.some(n=>n.id===value) ? value as ModelNeed : 'writing'; } catch {return 'writing';} });
  return <div className="models-guidance">
    <fieldset className="models-needs"><legend>What would you like to do?</legend>
      <div className="models-need-grid">{[...modelNeeds].sort((a, b) => ['writing', 'coding', 'documents', 'translation'].indexOf(a.id) - ['writing', 'coding', 'documents', 'translation'].indexOf(b.id)).map(item => <button className="models-need-card" aria-pressed={need === item.id} key={item.id} onClick={() => setNeed(item.id)}>
        <span className="models-need-icon" aria-hidden="true">{needPresentation[item.id].icon}</span>
        <span className="models-need-copy"><strong>{needPresentation[item.id].title}</strong><small>{needPresentation[item.id].example}</small></span>
        <span className="models-need-check" aria-hidden="true">{need === item.id ? '✓' : ''}</span>
      </button>)}</div>
    </fieldset>
    {connectionError && <p role="alert">{connectionError}</p>}
    <OpenModelDiscovery compact={view === 'guided'} need={need} connected={catalog} onUse={onUse} />
    <div className="models-empty-actions"><button className="btn ghost" onClick={onExpert}>My connected models</button>{!cloudConnected && canConfigure && <button className="btn ghost" disabled={connecting} onClick={()=>void onConnectCloud()}>{connecting?'Connecting…':'Connect Cloud'}</button>}</div>

  </div>;
}
