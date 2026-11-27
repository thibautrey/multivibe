const catalog: Record<string, string> = {
  // Trace range picker + date validation
  "Time range": "Plage de temps",
  "Trace time range": "Plage de temps des traces",
  "Last 24 hours": "Dernières 24 heures",
  "Last 7 days": "7 derniers jours",
  "Last 30 days": "30 derniers jours",
  "All time": "Depuis le début",
  "Custom date range": "Plage de dates personnalisée",
  "Start date": "Date de début",
  "End date": "Date de fin",
  "Apply": "Appliquer",
  "Includes both dates · local time": "Inclut les deux dates · heure locale",
  "Choose valid dates with the end date on or after the start date.":
    "Choisissez des dates valides, avec une date de fin égale ou postérieure à la date de début.",

  // TTFT comparison chart
  "{percent}% cached": "{percent} % en cache",
  "cache unavailable": "cache indisponible",
  "{count} samples": "{count} échantillons",
  "{cache} · median input {input}": "{cache} · entrée médiane {input}",
  "Low sample confidence": "Échantillon peu fiable",
  "Rank {rank}": "Rang {rank}",
  "Unranked": "Non classé",
  "p50 · typical wait": "p50 · attente typique",
  "p95 · 95% start within": "p95 · 95 % des réponses démarrent en deçà",
  "← Faster": "← Plus rapide",
  "↓ Faster": "↓ Plus rapide",
  "{model}: p50 {p50}, p95 {p95}": "{model} : p50 {p50}, p95 {p95}",
  "Time to first token (seconds)": "Temps jusqu'au premier token (secondes)",
  "TTFT line chart; models ordered by p50": "Graphique en courbes TTFT ; modèles classés par p50",
  "Model · ordered by p50": "Modèle · classés par p50",
  "p50 {p50} · p95 {p95}": "p50 {p50} · p95 {p95}",
  "One model in this bucket: each percentile is a single point.":
    "Un seul modèle dans cette tranche : chaque percentile est un point unique.",
  "Model comparison; connecting lines are not a time trend.":
    "Comparaison de modèles ; les lignes de liaison ne représentent pas une évolution temporelle.",

  // Session metrics widgets
  "Session metrics": "Métriques de session",
  "Sessions": "Sessions",
  "{count} turns in this range": "{count} tours dans cette plage",
  "Session coverage": "Couverture des sessions",
  "{identified}/{total} attempts carry a session id":
    "{identified}/{total} tentatives portent un identifiant de session",
  "Median initial context": "Contexte initial médian",
  "First turn input tokens": "Tokens d'entrée du premier tour",
  "Turns / session": "Tours / session",
  "Median interactions per session": "Interactions médianes par session",
  "Cache reads": "Lectures cache",
  "{tokens} cached input tokens": "{tokens} tokens d'entrée en cache",
  "Cache savings": "Économies de cache",
  "{tokens} tokens written to cache": "{tokens} tokens écrits dans le cache",

  // Initial context + token composition charts
  "Initial context size": "Taille du contexte initial",
  "Sessions by first-turn input tokens.": "Sessions selon les tokens d'entrée du premier tour.",
  "sessions": "sessions",
  "Input token composition": "Composition des tokens d'entrée",
  "How prompts were served across sessions.": "Comment les prompts ont été servis au fil des sessions.",
  "tokens": "jetons",
  "Uncached": "Hors cache",
  "Cache read": "Lecture cache",
  "Cache write": "Écriture cache",

  // Sessions table
  "Sessions are grouped by the id sent by the harness. Requests without one are excluded from this view.":
    "Les sessions sont regroupées par l'identifiant transmis par le harnais. Les requêtes sans identifiant sont exclues de cette vue.",
  "{identified}/{total} attributed": "{identified}/{total} attribuées",
  "Session": "Session",
  "Project": "Projet",
  "Models": "Modèles",
  "Turns": "Tours",
  "Initial context": "Contexte initial",
  "Median input": "Entrée médiane",
  "Growth": "Croissance",
  "Output / turn": "Sortie / tour",
  "Cache turns": "Tours en cache",
  "Cost": "Coût",
  "Savings": "Économies",
  "Duration": "Durée",
  "Details": "Détails",
  "Unknown harness": "Harnais inconnu",
  "Unknown": "Inconnu",
  "{count} failed turns": "{count} tours en échec",
  "{tokens} output": "{tokens} en sortie",
  "Hide": "Masquer",
  "Inspect": "Inspecter",
  "Session detail": "Détail de la session",
  "{count} turns · {time}": "{count} tours · {time}",
  "No session-attributed traffic in this range.": "Aucun trafic rattaché à une session dans cette plage.",
  "{identified} of {total} provider attempts carried a session id.":
    "{identified} tentatives du fournisseur sur {total} portaient un identifiant de session.",

  // Session turns detail
  "Loading session turns...": "Chargement des tours de la session…",
  "No turns recorded for this session in the selected range.":
    "Aucun tour enregistré pour cette session dans la plage sélectionnée.",
  "New tokens per turn (avg)": "Nouveaux tokens par tour (moy.)",
  "Cache written": "Écriture cache",
  "input": "entrée",
  "cached input": "entrée en cache",
  "output": "sortie",
  "Time": "Heure",
  "Model": "Modèle",
  "Input": "Entrée",
  "Cached": "En cache",
  "Output": "Sortie",
  "Δ context": "Δ contexte",
  "Latency": "Latence",
  "Attempts": "Tentatives",
  "Status": "Statut",
  "Previous turns": "Tours précédents",
  "Turns {from}–{to} of {total}": "Tours {from}–{to} sur {total}",
  "Next turns": "Tours suivants",

  // Durations
  "{value} min": "{value} min",
  "{value} h": "{value} h",
  "{value} d": "{value} j",
};

export default catalog;
