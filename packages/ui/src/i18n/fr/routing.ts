const catalog: Record<string, string> = {
  "schemaVersion 2 and rules[] are required": "schemaVersion 2 et rules[] sont requis",
  Alias: "Alias",
  Editing: "Modification",
  "Alias workspace sections": "Sections de l’espace Alias",
  "Smart routing policies": "Politiques de routage intelligentes",
  "Start a new routing policy": "Créer une politique de routage",
  "New policy": "Nouvelle politique",
  "The model name your applications send to the proxy.":
    "Le nom de modèle que vos applications envoient au proxy.",
  Rules: "Règles",
  "Rules are evaluated from top to bottom.": "Les règles sont évaluées de haut en bas.",
  Candidates: "Candidats",
  "Models available to this policy, in fallback order.":
    "Modèles disponibles pour cette politique, par ordre de repli.",
  Status: "Statut",
  Enabled: "Activé",
  Disabled: "Désactivé",
  "Open this policy in the editor": "Ouvrir cette politique dans l’éditeur",
  Edit: "Modifier",
  "Stop using this policy for new requests":
    "Ne plus utiliser cette politique pour les nouvelles requêtes",
  "Make this policy available for new requests":
    "Rendre cette politique disponible pour les nouvelles requêtes",
  Disable: "Désactiver",
  Enable: "Activer",
  "Permanently remove this policy": "Supprimer définitivement cette politique",
  Delete: "Supprimer",
  "No policy yet. Create one to redirect a model or add fallback routing.":
    "Aucune politique pour l’instant. Créez-en une pour rediriger un modèle ou ajouter un routage de repli.",
  "Edit {id}": "Modifier {id}",
  "Configure your policy": "Configurer votre politique",
  "Create a policy": "Créer une politique",
  "Rules run top to bottom. Candidate order breaks score ties.":
    "Les règles s’exécutent de haut en bas. L’ordre des candidats tranche les égalités de score.",
  "Discard this draft and choose a new goal":
    "Abandonner ce brouillon et choisir un nouvel objectif",
  "Start over": "Recommencer",
  "Edit the policy with form fields": "Modifier la politique avec des champs de formulaire",
  Visual: "Visuel",
  "Edit the complete schema v2 document directly":
    "Modifier directement le document schema v2 complet",
  JSON: "JSON",
  "Validated schema v2 JSON": "JSON schema v2 validé",
  "Use JSON when you need access to every supported routing option. Changes are checked while you type.":
    "Utilisez le JSON lorsque vous avez besoin d’accéder à toutes les options de routage prises en charge. Les modifications sont vérifiées pendant la saisie.",
  "The stable model name exposed to your applications. It cannot be changed after creation.":
    "Le nom de modèle stable exposé à vos applications. Il ne peut pas être modifié après la création.",
  Description: "Description",
  "A short note to help identify this policy in the list.":
    "Une courte note pour identifier cette politique dans la liste.",
  "Default priority": "Priorité par défaut",
  "Used when a request does not provide a priority that matches a rule.":
    "Utilisée lorsqu’une requête ne fournit pas de priorité correspondant à une règle.",
  "Legacy sync default": "Valeur par défaut de synchronisation héritée",
  "Disabled policies stay saved but are not selected for new requests.":
    "Les politiques désactivées restent enregistrées mais ne sont pas sélectionnées pour les nouvelles requêtes.",
  "Rule {number}": "Règle {number}",
  "A rule applies when all of its matching conditions are met.":
    "Une règle s’applique lorsque toutes ses conditions de correspondance sont remplies.",
  "Move rule earlier": "Déplacer la règle plus haut",
  "Move rule later": "Déplacer la règle plus bas",
  "Remove this rule": "Supprimer cette règle",
  Remove: "Supprimer",
  "Match conditions": "Conditions de correspondance",
  "These conditions decide whether a request enters this rule. Empty conditions match every request for that field.":
    "Ces conditions déterminent si une requête entre dans cette règle. Des conditions vides correspondent à toutes les requêtes pour ce champ.",
  "Rule id": "ID de règle",
  "An internal name for this rule. It is useful when reading simulation results.":
    "Un nom interne pour cette règle. Il est utile pour lire les résultats de simulation.",
  "Applications (comma-separated)": "Applications (séparées par des virgules)",
  "Only requests from one of these application names match. Leave empty to match every application.":
    "Seules les requêtes provenant de l’un de ces noms d’application correspondent. Laissez vide pour correspondre à toutes les applications.",
  "Reasoning efforts": "Efforts de raisonnement",
  "Match requests by their requested reasoning effort, such as low, medium, or high.":
    "Faire correspondre les requêtes selon leur effort de raisonnement demandé, par exemple low, medium ou high.",
  Priorities: "Priorités",
  "Hold Ctrl or Cmd to select multiple priorities. An empty selection matches every priority.":
    "Maintenez Ctrl ou Cmd pour sélectionner plusieurs priorités. Une sélection vide correspond à toutes les priorités.",
  "Execution modes": "Modes d’exécution",
  Modalities: "Modalités",
  Tools: "Outils",
  Any: "Indifférent",
  Required: "Obligatoire",
  Forbidden: "Interdit",
  "Minimum input tokens": "Tokens d’entrée minimum",
  "Maximum input tokens": "Tokens d’entrée maximum",
  "Time window start": "Début de la plage horaire",
  "Time window end": "Fin de la plage horaire",
  Timezone: "Fuseau horaire",
  "Days (0 Sunday–6 Saturday)": "Jours (0 dimanche–6 samedi)",
  "Allowed locations": "Emplacements autorisés",
  "Max predicted wait (ms)": "Attente maximale prévue (ms)",
  "Minimum context": "Contexte minimum",
  "Minimum quality": "Qualité minimum",
  "No capacity": "Aucune capacité",
  "Next rule": "Règle suivante",
  Queue: "File d’attente",
  Reject: "Rejeter",
  "Cloud budget USD": "Budget Cloud USD",
  "Budget period": "Période budgétaire",
  hour: "heure",
  day: "jour",
  month: "mois",
  "Score objectives": "Objectifs de score",
  "Set the relative importance of latency, cost, quality, and locality when ranking matching candidates.":
    "Définissez l’importance relative de la latence, du coût, de la qualité et de la localité lors du classement des candidats correspondants.",
  "Candidates are tried in this order after the rule matches. Add a fallback when the preferred model has no capacity.":
    "Les candidats sont essayés dans cet ordre une fois la règle correspondante. Ajoutez un repli lorsque le modèle préféré n’a plus de capacité.",
  "Add models in preference order. The first available candidate handles the request.":
    "Ajoutez des modèles par ordre de préférence. Le premier candidat disponible traite la requête.",
  "Model identifier used for this candidate":
    "Identifiant de modèle utilisé pour ce candidat",
  "Limit this candidate to a provider": "Limiter ce candidat à un fournisseur",
  "Any provider": "Tous les fournisseurs",
  "Limit this candidate to an execution location":
    "Limiter ce candidat à un emplacement d’exécution",
  "Account location": "Emplacement du compte",
  "Optional account IDs, separated by commas":
    "IDs de compte facultatifs, séparés par des virgules",
  "Account IDs, comma-separated": "IDs de compte, séparés par des virgules",
  Quality: "Qualité",
  "Input $/M": "Entrée $/M",
  "Output $/M": "Sortie $/M",
  Slots: "Emplacements",
  "Prefill tok/s": "Préremplissage tok/s",
  "Decode tok/s": "Décodage tok/s",
  Context: "Contexte",
  "Move candidate earlier in fallback order":
    "Déplacer le candidat plus tôt dans l’ordre de repli",
  "Move candidate later in fallback order":
    "Déplacer le candidat plus tard dans l’ordre de repli",
  "Remove this candidate": "Supprimer ce candidat",
  "Add at least one model candidate.": "Ajoutez au moins un modèle candidat.",
  "Add another rule after the current rules":
    "Ajouter une autre règle après les règles actuelles",
  "Add rule": "Ajouter une règle",
  "Save this policy and return to the policy list":
    "Enregistrer cette politique et revenir à la liste des politiques",
  "Saving…": "Enregistrement…",
  "Save policy": "Enregistrer la politique",
  "Create policy": "Créer la politique",
  "Discard unsaved changes and start over":
    "Abandonner les modifications non enregistrées et recommencer",
  Reset: "Réinitialiser",
  "Policy simulator": "Simulateur de politique",
  "Simulation does not send a real request. It shows which rule and candidate would be selected.":
    "La simulation n’envoie pas de vraie requête. Elle indique quelle règle et quel candidat seraient sélectionnés.",
  Application: "Application",
  "The application name used to test application-specific matching.":
    "Le nom d’application utilisé pour tester la correspondance spécifique aux applications.",
  Priority: "Priorité",
  "The priority used to find a matching rule.":
    "La priorité utilisée pour trouver une règle correspondante.",
  Effort: "Effort",
  "The reasoning effort used to test effort matching.":
    "L’effort de raisonnement utilisé pour tester la correspondance d’effort.",
  "Input tokens": "Tokens d'entrée",
  "Approximate input size used to test token limits and capacity.":
    "Taille d’entrée approximative utilisée pour tester les limites de tokens et la capacité.",
  "Tools required": "Outils requis",
  "Test a request that requires tool support.":
    "Tester une requête nécessitant la prise en charge des outils.",
  "Open or create a policy first": "Ouvrez ou créez d’abord une politique",
  "Evaluate the sample request": "Évaluer la requête d’exemple",
  Simulate: "Simuler",
  "Open a policy from the Policies tab before running a simulation.":
    "Ouvrez une politique depuis l’onglet Politiques avant de lancer une simulation.",
  "Capacity and queue": "Capacité et file d’attente",
  "This check reads current capacity and queue data for the policy alias.":
    "Cette vérification lit les données actuelles de capacité et de file d’attente pour l’alias de la politique.",
  "Capacity priority": "Priorité de capacité",
  "Refresh capacity and queue data":
    "Actualiser les données de capacité et de file d’attente",
  Refresh: "Actualiser",
  "{count} free slots": "{count} emplacements libres",
  "{wait} ms wait": "{wait} ms d’attente",
  "{count} queued": "{count} en file d’attente",
  "{confidence} confidence": "Confiance : {confidence}",
  "Select or draft a policy to inspect application-visible capacity.":
    "Sélectionnez ou rédigez une politique pour inspecter la capacité visible par l’application.",
  "Image request model": "Modèle pour les requêtes d’image",
  "Optionally route image requests to a specific model instead of the default.":
    "Acheminez éventuellement les requêtes d’image vers un modèle spécifique au lieu de celui par défaut.",
  "This override only affects image requests. Leave it empty to use the normal model selection.":
    "Cette dérogation ne concerne que les requêtes d’image. Laissez vide pour utiliser la sélection de modèle normale.",
  "Override model": "Modèle de remplacement",
  "The model that will handle image requests when an override is configured.":
    "Le modèle qui traitera les requêtes d’image lorsqu’une dérogation est configurée.",
  "Remove the image model override": "Supprimer la dérogation de modèle d’image",
  "Clear override": "Effacer la dérogation",
  "What do you want this alias to do?": "Que voulez-vous que cet alias fasse ?",
  "Choose this goal": "Choisir cet objectif",
  "Selected goal": "Objectif sélectionné",
  "Change goal": "Changer d’objectif",
  "Model name requested by your application":
    "Nom de modèle demandé par votre application",
  "Choose a different fallback model.": "Choisissez un autre modèle de repli.",
  "If every configured model is unavailable":
    "Si tous les modèles configurés sont indisponibles",
  "Wait in the queue": "Attendre dans la file d’attente",
  "Return an error immediately": "Renvoyer immédiatement une erreur",
  "This only applies after all choices above have been tried.":
    "Cela ne s’applique qu’après avoir essayé tous les choix ci-dessus.",
  optional: "facultatif",
  "Routing preview": "Aperçu du routage",
  "What will happen": "Ce qui va se passer",
  "Application requests": "Requêtes de l’application",
  "model name": "nom du modèle",
  "Local first": "Local d’abord",
  "Proxy uses": "Le proxy utilise",
  "if unavailable": "si indisponible",
  "Cloud overflow": "Débordement Cloud",
  "Then fallback": "Puis repli",
  "Your application only sends the requested model name. MultiVibe handles the redirection and fallback.":
    "Votre application envoie uniquement le nom de modèle demandé. MultiVibe gère la redirection et le repli.",
  "Open advanced settings": "Ouvrir les paramètres avancés",
  "Creating…": "Création…",
  "Policy creation progress": "Progression de la création de la politique",
  "Choose a goal": "Choisir un objectif",
  Configure: "Configurer",
  "Ready to create": "Prêt à créer",
  "Redirect an existing model name": "Rediriger un nom de modèle existant",
  "Prefer one model and fall back to another":
    "Préférer un modèle et basculer vers un autre",
  "Prefer local capacity and overflow to cloud":
    "Préférer la capacité locale et déborder vers le Cloud",
  "Route coding tasks to the primary model with a fast fallback.":
    "Achemine les tâches de développement vers le modèle principal avec un repli rapide.",
  "Defer documentation and support jobs to available capacity.":
    "Reporte les tâches de documentation et de support vers la capacité disponible.",

  // Alias workspace sections
  Policies: "Politiques",
  "Choose a policy to edit": "Choisissez une politique à modifier",
  Simulation: "Simulation",
  "Test routing and capacity": "Tester le routage et la capacité",
  Settings: "Paramètres",
  "Configure image requests": "Configurer les requêtes d’image",

  // Creation wizard: preset scenarios
  "Redirect a model name": "Rediriger un nom de modèle",
  "Keep the model name already used by your app and send its requests to another model.":
    "Conservez le nom de modèle déjà utilisé par votre application et envoyez ses requêtes vers un autre modèle.",
  "One requested name → one destination model": "Un nom demandé → un modèle de destination",
  Simplest: "Le plus simple",
  "Add a fallback model": "Ajouter un modèle de repli",
  "Use a preferred model first, then automatically try a second model when it is unavailable.":
    "Utilisez d’abord un modèle préféré, puis essayez automatiquement un second modèle lorsqu’il est indisponible.",
  "Primary model → fallback model": "Modèle principal → modèle de repli",
  "Prefer local, overflow to cloud": "Privilégier le local, déborder vers le Cloud",
  "Run on local capacity whenever possible and use a cloud model only when local capacity is unavailable.":
    "Exécutez sur la capacité locale autant que possible et n’utilisez un modèle Cloud que lorsque la capacité locale est indisponible.",
  "Local model → cloud model": "Modèle local → modèle Cloud",
  "Build a custom policy": "Créer une politique personnalisée",
  "Configure matching rules, priorities, budgets, scoring, capacity and execution modes yourself.":
    "Configurez vous-même les règles de correspondance, les priorités, les budgets, le score, la capacité et les modes d’exécution.",
  "Full routing policy editor": "Éditeur complet de politique de routage",
  Advanced: "Avancé",

  // Creation wizard: guided form
  "This is the model name your application already sends, for example gpt-5.4.":
    "C’est le nom de modèle que votre application envoie déjà, par exemple gpt-5.4.",
  "Destination model": "Modèle de destination",
  "Every request using the name above will be sent to this model.":
    "Chaque requête utilisant le nom ci-dessus sera envoyée à ce modèle.",
  "This stable name is what your application will send to the proxy.":
    "Votre application enverra ce nom stable au proxy.",
  "Preferred model": "Modèle préféré",
  "This model is used whenever it has available capacity.":
    "Ce modèle est utilisé dès qu’il dispose de capacité disponible.",
  "Fallback model": "Modèle de repli",
  "This model is tried when the preferred model has no available capacity.":
    "Ce modèle est essayé lorsque le modèle préféré n’a plus de capacité disponible.",
  "Local model": "Modèle local",
  "Only local accounts exposing this model are eligible for the first choice.":
    "Seuls les comptes locaux exposant ce modèle sont éligibles au premier choix.",
  "Cloud model": "Modèle Cloud",
  "Only cloud accounts exposing this model are eligible for overflow.":
    "Seuls les comptes Cloud exposant ce modèle sont éligibles au débordement.",
};

export default catalog;
