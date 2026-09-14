import { useMemo, useState } from 'react';
import type { CatalogEntry } from '../../lib/modelCatalog';
import { modelNeeds, recommendedChoices, relevantChoices, type ModelNeed } from '../../lib/modelGuidance';

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
    <fieldset className="models-needs"><legend>Que souhaitez-vous faire ?</legend>{modelNeeds.map(item => <button className="btn ghost" aria-pressed={need === item.id} key={item.id} onClick={() => setNeed(item.id)}>{item.label}</button>)}</fieldset>
    {view === 'compare' && <div className="models-compare-filters">
      <label>Exécution<select value={location} onChange={event => setLocation(event.target.value)}><option value="all">Partout</option><option value="local">Machine Host</option><option value="remote">Service distant</option></select></label>
      <label>Coût<select value={cost} onChange={event => setCost(event.target.value)}><option value="all">Tous les tarifs</option><option value="known">Tarif connu</option></select></label>
      <span className="muted">Modèles utilisables · Capacités selon le besoin choisi</span>
    </div>}
    {connectionError && <p role="alert">{connectionError}</p>}
    <div className="models-choice-grid">{displayed.map((choice, index) => <article className="models-choice" key={`${choice.model.id}:${choice.route.accountId}`}>
      {view === 'guided' && <span className="muted">{index === 0 ? 'Choix proposé' : 'Alternative'}</span>}
      <h3>{choice.model.name}</h3><p>{choice.reason}</p>
      <dl><div><dt>Coût</dt><dd>{choice.cost.label}</dd></div><div><dt>Données</dt><dd>{choice.data}</dd></div><div><dt>Vitesse</dt><dd>{choice.speed.label}</dd></div><div><dt>Dépendance</dt><dd>{choice.dependency}</dd></div></dl>
      <button className="btn" onClick={() => onUse(choice.route.modelId)}>Discuter<span className="sr-only"> avec {choice.model.name}</span></button>
      <details><summary>Pourquoi ce choix ?</summary><p>Ce modèle correspond au besoin choisi et dispose d’une route de chat. Ce n’est pas un classement de qualité.</p>
        <p>{choice.route.source === 'local' ? 'La machine Host peut être un autre ordinateur. Ce choix n’installe rien sur votre téléphone. Les journaux et extensions ont leurs propres réglages de confidentialité.' : `Le traitement dépend de ${choice.route.label} et de ses conditions. Un modèle ouvert ne rend pas ce service indépendant.`}</p>
        {need === 'documents' && <p>Cette sélection concerne le texte ; elle ne garantit pas la lecture de tous les fichiers ni de toute leur longueur.</p>}
        <p>Aucune mesure de vitesse ni de coût comparable disponible. À preuves égales, ordre alphabétique, sans priorité au Cloud ou au local.</p>
        <a href={choice.evidence.source} target="_blank" rel="noreferrer">Capacités documentées</a><p className="muted">Sélection {choice.evidence.version} · vérifiée le {choice.evidence.reviewedAt}</p>
      </details>
    </article>)}</div>
    {!displayed.length && <div className="models-empty"><h3>Aucune recommandation vérifiée pour ce besoin</h3><p className="muted">Vos autres modèles restent accessibles dans la vue Expert.</p>{!cloudConnected && canConfigure && <button className="btn" disabled={connecting} onClick={() => void onConnectCloud()}>{connecting ? 'Connexion…' : 'Connecter le service Cloud'}</button>}<button className="btn ghost" onClick={onExpert}>Voir mes modèles</button></div>}
    <details className="models-local-help"><summary>Utiliser un modèle sur une machine Host</summary><p>La préparation automatique avec accord et essai n’est pas encore disponible ici. Aucun téléchargement ne sera lancé. Les installations existantes restent inchangées.</p><p>Sur téléphone, le modèle s’exécute sur Host, pas sur le téléphone.</p></details>
  </div>;
}
