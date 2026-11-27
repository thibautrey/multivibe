const catalog: Record<string, string> = {
  "Security": "Sécurité",
  // PluginsTab — hero
  "Plugin ecosystem": "Écosystème de plugins",
  "Extend MultiVibe": "Étendez MultiVibe",
  "Discover community lifecycle plugins, install a reviewed commit, or submit your own public GitHub repository.":
    "Découvrez des plugins communautaires de cycle de vie, installez un commit validé ou soumettez votre propre dépôt GitHub public.",
  "Developer guide ↗": "Guide développeur ↗",
  "Submit a plugin": "Soumettre un plugin",
  "Close submission": "Fermer la soumission",

  // PluginsTab — submission form
  "Submit to this marketplace": "Soumettre à cette place de marché",
  "We validate the repository and read categories, tags and author from {file}.":
    "Nous validons le dépôt et lisons les catégories, les tags et l’auteur depuis {file}.",
  "Public GitHub HTTPS URL": "URL HTTPS GitHub publique",
  "Validating…": "Validation…",
  "Validate and submit": "Valider et soumettre",
  "Plugin submitted to the marketplace.": "Plugin soumis à la place de marché.",

  // PluginsTab — views
  "Plugin views": "Vues des plugins",
  "Marketplace": "Place de marché",
  "Installed": "Installé",
  "Audio plugin unavailable": "Plugin audio indisponible",
  "Restart MultiVibe to load the built-in audio plugin.":
    "Redémarrez MultiVibe pour charger le plugin audio intégré.",
  "Headroom plugin unavailable": "Plugin Headroom indisponible",
  "Restart MultiVibe to load the built-in Headroom extension.":
    "Redémarrez MultiVibe pour charger l’extension Headroom intégrée.",

  // PluginsTab — marketplace filters
  "Marketplace filters": "Filtres de la place de marché",
  "Search plugins, authors, tags…": "Rechercher des plugins, des auteurs, des tags…",
  "Categories": "Catégories",
  "All": "Tous",
  "Other": "Autre",
  "All plugins": "Tous les plugins",
  "1 result": "1 résultat",
  "{count} results": "{count} résultats",

  // PluginsTab — marketplace cards
  "Plugin marketplace": "Place de marché des plugins",
  "by {author}": "par {author}",
  "Details": "Détails",
  "Installing…": "Installation…",
  "Install": "Installer",
  "{name} installed. Restart MultiVibe, then enable it.":
    "{name} est installé. Redémarrez MultiVibe, puis activez-le.",
  "No plugins found": "Aucun plugin trouvé",
  "Try another search or category, or submit the first matching plugin.":
    "Essayez une autre recherche ou catégorie, ou soumettez le premier plugin correspondant.",

  // PluginsTab — installed list
  "Installed plugins": "Plugins installés",
  "Bundled": "Intégré",
  "Manifest will be loaded after restart.": "Le manifeste sera chargé après le redémarrage.",
  "1 hook": "1 hook",
  "{count} hooks": "{count} hooks",
  "Built into MultiVibe": "Intégré à MultiVibe",
  "Isolated runtime": "Runtime isolé",
  "Restart required": "Redémarrage requis",
  "Loaded": "Chargé",
  "Unavailable": "Indisponible",
  "Disabled": "Désactivé",
  "Settings": "Paramètres",
  "Disable": "Désactiver",
  "Enable": "Activer",
  "Updates with MultiVibe": "Mis à jour avec MultiVibe",
  "Update pinned. Restart MultiVibe to load it.":
    "Version épinglée mise à jour. Redémarrez MultiVibe pour la charger.",
  "Update": "Mettre à jour",
  "Disable before removing": "Désactivez avant de supprimer",
  "Remove": "Supprimer",
  "No installed plugins": "Aucun plugin installé",
  "Browse the marketplace to get started.": "Parcourez la place de marché pour commencer.",

  // PluginSettings
  "{name} settings": "Paramètres de {name}",
  "Send requests to multivibe/autorouter to opt into automatic routing. Explicit model selections are unchanged. Requires JavaScript inference. Choose a classifier and three difficulty tiers before enabling. Multi-turn routing requires a stable session ID; continuations retain their first selection to help reuse cached input. Classifier calls add cost and latency.":
    "Envoyez des requêtes à multivibe/autorouter pour activer le routage automatique. Les sélections de modèle explicites restent inchangées. Nécessite l’inférence JavaScript. Choisissez un classifieur et trois niveaux de difficulté avant d’activer. Le routage multi-tours nécessite un ID de session stable ; les continuations conservent leur première sélection pour favoriser la réutilisation de l’entrée en cache. Les appels au classifieur ajoutent du coût et de la latence.",
  "Enter valid JSON": "Saisissez un JSON valide",
  "Saving…": "Enregistrement…",
  "Save settings": "Enregistrer les paramètres",
  "Cancel": "Annuler",

  // PluginAnalytics
  "Plugin analytics": "Analyses du plugin",
  "Private data and analytics": "Données privées et analyses",
  "This plugin has its own SQLite database. Data survives updates, disabling, and restarts. Installed plugins cannot access each other’s storage.":
    "Ce plugin dispose de sa propre base SQLite. Les données survivent aux mises à jour, à la désactivation et aux redémarrages. Les plugins installés ne peuvent pas accéder au stockage les uns des autres.",
  "Could not load plugin analytics.": "Impossible de charger les analyses du plugin.",
  "Loading analytics…": "Chargement des analyses…",
  "No events recorded yet.": "Aucun événement enregistré pour le moment.",
  "Routing decisions": "Décisions de routage",
  "Sticky model reuses": "Réutilisations du modèle retenu",
  "Classifier calls": "Appels au classifieur",
  "Priced usage comparisons": "Comparaisons d’usage tarifées",
  "Estimated gross token-cost difference": "Différence brute estimée du coût des tokens",
  "Known classifier cost": "Coût connu du classifieur",
  "Estimated net difference (known costs)": "Différence nette estimée (coûts connus)",
  "Classifier calls without pricing": "Appels au classifieur sans tarification",
  "Not available": "Non disponible",
  "1 event": "1 événement",
  "{count} events": "{count} événements",
  "Estimates compare the same measured tokens and cache usage at the baseline and actual model rates. For multivibe/autorouter, the baseline is the configured advanced model. They are not invoice savings. Missing usage/prices and unmeasured failed calls are excluded; classifier overhead and failed-attempt costs are deducted only when known. Negative differences indicate higher cost.":
    "Les estimations comparent les mêmes tokens mesurés et le même usage du cache aux tarifs du modèle de référence et du modèle réel. Pour multivibe/autorouter, le modèle de référence est le modèle avancé configuré. Il ne s’agit pas d’économies de facture. Les usages et tarifs manquants ainsi que les appels échoués non mesurés sont exclus ; les coûts du classifieur et des tentatives échouées ne sont déduits que lorsqu’ils sont connus. Une différence négative indique un coût plus élevé.",
  "Rolling window of up to {count} events, not a lifetime total.":
    "Fenêtre glissante de {count} événements au maximum, et non un total cumulé.",
  "Refresh analytics": "Actualiser les analyses",

  // WidgetGrid
  "Widget layout saved for this browser.": "Disposition des widgets enregistrée pour ce navigateur.",
  "Could not save your layout. Browser storage is unavailable. Try again or cancel.":
    "Impossible d’enregistrer votre disposition. Le stockage du navigateur est indisponible. Réessayez ou annulez.",
  "{title} moved.": "{title} déplacé.",
  "Edit widgets": "Modifier les widgets",
  "Reorder, resize, or hide widgets.": "Réorganisez, redimensionnez ou masquez les widgets.",
  "Reset": "Réinitialiser",
  "Save changes": "Enregistrer les modifications",
  "Customize widgets": "Personnaliser les widgets",
  "Drag {title} to reorder": "Faites glisser {title} pour réorganiser",
  "Required": "Obligatoire",
  "Hide {title}": "Masquer {title}",
  "Hide": "Masquer",
  "Size": "Taille",
  "Size of {title}": "Taille de {title}",
  "Small": "Petit",
  "Medium": "Moyen",
  "Large": "Grand",
  "Move {title} earlier": "Déplacer {title} plus tôt",
  "Move {title} later": "Déplacer {title} plus tard",
  "Your space, your choice. Use Customize widgets to add metrics.":
    "Votre espace, votre choix. Utilisez Personnaliser les widgets pour ajouter des métriques.",
  "Widget gallery": "Galerie de widgets",
  "Hidden widgets": "Widgets masqués",
  "✓ Added": "✓ Ajouté",
  "+ Add widget": "+ Ajouter un widget",
  "Add {title}": "Ajouter {title}",
};

export default catalog;
