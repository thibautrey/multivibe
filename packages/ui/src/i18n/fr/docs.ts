const catalog: Record<string, string> = {
  // Page shell, catalog and filters
  "API explorer": "Explorateur d’API",
  "Choose an endpoint and test a request.": "Choisissez un point de terminaison et testez une requête.",
  "Base URL": "URL de base",
  "Copy base URL": "Copier l’URL de base",
  "Uses your dashboard session": "Utilise votre session du tableau de bord",
  "Choose an endpoint": "Choisir un point de terminaison",
  "Close": "Fermer",
  "Browse": "Parcourir",
  "API endpoint catalog": "Catalogue des points de terminaison de l’API",
  "Search endpoints": "Rechercher un point de terminaison",
  "Search API endpoints": "Rechercher dans les points de terminaison de l’API",
  "Clear endpoint search": "Effacer la recherche de points de terminaison",
  "Endpoint group": "Groupe de points de terminaison",
  "All endpoints": "Tous les points de terminaison",
  "1 endpoint": "1 point de terminaison",
  "{count} endpoints": "{count} points de terminaison",
  "Clear filters": "Effacer les filtres",
  "No endpoint found": "Aucun point de terminaison trouvé",
  "Try a path, method or broader keyword.": "Essayez un chemin, une méthode ou un mot-clé plus général.",

  // Endpoint groups (display labels only; the stored values stay English)
  Models: "Modèles",
  Inference: "Inférence",
  "Smart routing": "Routage intelligent",
  Observability: "Observabilité",
  Configuration: "Configuration",

  // Reference view
  "Endpoint view": "Vue du point de terminaison",
  "Try a request": "Essayer une requête",
  Documentation: "Documentation",
  "Overview": "Vue d’ensemble",
  Reference: "Référence",
  Parameters: "Paramètres",
  "Admin authentication": "Authentification administrateur",
  "Application authentication": "Authentification applicative",
  "The interactive console uses your secure dashboard session. External clients should send x-admin-token or a Bearer admin token.":
    "La console interactive utilise votre session sécurisée du tableau de bord. Les clients externes doivent envoyer x-admin-token ou un jeton administrateur Bearer.",
  "The interactive console uses your secure dashboard session. External clients should send a proxy API key as Bearer or x-api-key.":
    "La console interactive utilise votre session sécurisée du tableau de bord. Les clients externes doivent envoyer une clé d’API du proxy en Bearer ou x-api-key.",
  Required: "Obligatoire",
  Optional: "Facultatif",
  "Good to know": "Bon à savoir",
  Example: "Exemple",
  Response: "Réponse",
  Copied: "Copié",
  Copy: "Copier",

  // Request builder
  "Request builder": "Constructeur de requête",
  "Edit the example and send when ready": "Modifiez l’exemple et envoyez quand vous êtes prêt",
  "Dashboard session": "Session du tableau de bord",
  "Path parameters": "Paramètres de chemin",
  "Query parameters": "Paramètres de requête",
  "JSON body": "Corps JSON",
  "Format JSON": "Formater le JSON",
  "Reset example": "Réinitialiser l’exemple",
  "JSON request body": "Corps de requête JSON",
  "Cancel request": "Annuler la requête",
  "Send request": "Envoyer la requête",
  "This endpoint changes server state. You’ll confirm before sending.":
    "Ce point de terminaison modifie l’état du serveur. Une confirmation vous sera demandée avant l’envoi.",
  "Sent to this server using your dashboard session.":
    "Envoyé à ce serveur avec votre session du tableau de bord.",
  "Sending request…": "Envoi de la requête…",
  "Run the request to inspect its response here.":
    "Lancez la requête pour inspecter sa réponse ici.",
  "Use in your terminal · cURL": "À utiliser dans votre terminal · cURL",

  // Errors and status
  "Request not sent": "Requête non envoyée",
  "{name} is required.": "{name} est obligatoire.",
  "Invalid JSON": "JSON invalide",
  Success: "Succès",
  "Request failed": "Échec de la requête",
  "No response body.": "Aucun corps de réponse.",
  Cancelled: "Annulée",
  "Network error": "Erreur réseau",
  "The request was cancelled.": "La requête a été annulée.",
  "Send {method} {path}? This request changes server state.":
    "Envoyer {method} {path} ? Cette requête modifie l’état du serveur.",

  // Endpoint catalog: Models
  "List models": "Lister les modèles",
  "Retrieve a model": "Récupérer un modèle",
  "Discover every model and alias currently exposed by the proxy.":
    "Découvrez tous les modèles et alias actuellement exposés par le proxy.",
  "Inspect one model by its exposed identifier.":
    "Inspectez un modèle à partir de son identifiant exposé.",
  "Returns an OpenAI-compatible model collection enriched with provider capabilities and alias metadata.":
    "Renvoie une collection de modèles compatible OpenAI, enrichie des capacités des fournisseurs et des métadonnées d’alias.",
  "Returns the same capability metadata as the list endpoint for a single model or alias.":
    "Renvoie, pour un modèle ou un alias, les mêmes métadonnées de capacités que le point de terminaison de liste.",
  "Exposed model or alias identifier.": "Identifiant de modèle ou d’alias exposé.",

  // Endpoint catalog: Inference
  "Create a response": "Créer une réponse",
  "Create a chat completion": "Créer une complétion de chat",
  "Create an Anthropic message": "Créer un message Anthropic",
  "Compact a conversation": "Compacter une conversation",
  "Generate text or tool calls through the Responses API.":
    "Générez du texte ou des appels d’outils via l’API Responses.",
  "Use the familiar OpenAI Chat Completions contract.":
    "Utilisez le contrat OpenAI Chat Completions que vous connaissez.",
  "Call the proxy with the Anthropic Messages format.":
    "Appelez le proxy au format Anthropic Messages.",
  "Reduce conversation context while preserving relevant state.":
    "Réduisez le contexte de la conversation tout en conservant l’état pertinent.",
  "The recommended interface for new integrations. Requests are routed to an eligible provider while preserving the OpenAI Responses shape.":
    "L’interface recommandée pour les nouvelles intégrations. Les requêtes sont routées vers un fournisseur éligible tout en conservant la structure OpenAI Responses.",
  "Accepts role-based messages and bridges them to the selected upstream interface when necessary.":
    "Accepte des messages basés sur des rôles et les convertit vers l’interface amont sélectionnée si nécessaire.",
  "Provides an Anthropic-compatible envelope while keeping MultiVibe routing, attribution and tracing.":
    "Fournit une enveloppe compatible Anthropic tout en conservant le routage, l’attribution et le traçage de MultiVibe.",
  "Creates a compacted context item suitable for continuing a long-running Responses conversation.":
    "Crée un élément de contexte compacté adapté à la poursuite d’une longue conversation Responses.",
  "Set stream to true for server-sent events. The console defaults to false so the complete JSON response remains easy to inspect.":
    "Définissez stream sur true pour les événements envoyés par le serveur. La console utilise false par défaut afin que la réponse JSON complète reste facile à inspecter.",

  // Endpoint catalog: Smart routing
  "Inspect capacity": "Inspecter la capacité",
  "List deferred jobs": "Lister les tâches différées",
  "Retrieve a job": "Récupérer une tâche",
  "Retrieve a job result": "Récupérer le résultat d’une tâche",
  "Cancel a job": "Annuler une tâche",
  "Preview admission capacity for a model and priority.":
    "Prévisualisez la capacité d’admission pour un modèle et une priorité.",
  "List jobs belonging to the authenticated application.":
    "Listez les tâches de l’application authentifiée.",
  "Read the current state and metadata for one deferred job.":
    "Consultez l’état courant et les métadonnées d’une tâche différée.",
  "Fetch the completed inference payload for a deferred job.":
    "Récupérez la charge d’inférence terminée d’une tâche différée.",
  "Cancel a queued or running deferred job.":
    "Annulez une tâche différée en file d’attente ou en cours d’exécution.",
  "Returns a point-in-time capacity snapshot. The request-time admission decision remains authoritative.":
    "Renvoie un instantané de capacité à un instant donné. La décision d’admission prise au moment de la requête reste la référence.",
  "Returns deferred inference jobs in reverse chronological order with their lifecycle state.":
    "Renvoie les tâches d’inférence différées par ordre chronologique inverse, avec leur état de cycle de vie.",
  "The job must belong to the application resolved from the current authentication context.":
    "La tâche doit appartenir à l’application résolue à partir du contexte d’authentification courant.",
  "Returns the original inference response once the job reaches a completed state.":
    "Renvoie la réponse d’inférence d’origine dès que la tâche atteint un état terminé.",
  "Cancellation is scoped to the authenticated application. The console asks for confirmation before sending.":
    "L’annulation est limitée à l’application authentifiée. La console demande une confirmation avant l’envoi.",
  "Model or smart alias to evaluate.": "Modèle ou alias intelligent à évaluer.",
  "critical, interactive, standard or batch.":
    "critical, interactive, standard ou batch.",
  "Maximum number of jobs to return.": "Nombre maximal de tâches à renvoyer.",
  "Deferred job identifier.": "Identifiant de tâche différée.",
  "Completed deferred job identifier.":
    "Identifiant de tâche différée terminée.",

  // Endpoint catalog: Observability
  "List traces": "Lister les traces",
  "Get usage statistics": "Obtenir les statistiques d’utilisation",
  "Get trace statistics": "Obtenir les statistiques des traces",
  "List Codex projects": "Lister les projets Codex",
  "List Codex sessions": "Lister les sessions Codex",
  "Inspect paginated request traces captured by the proxy.":
    "Inspectez les traces de requêtes paginées capturées par le proxy.",
  "Aggregate requests, tokens, latency and cost by dimension.":
    "Agrégez requêtes, jetons, latence et coût par dimension.",
  "Read historical time-series and model-level trace metrics.":
    "Consultez les séries temporelles historiques et les métriques de traces par modèle.",
  "List projects discovered through Codex session attribution.":
    "Listez les projets découverts via l’attribution des sessions Codex.",
  "Inspect session-to-project attribution records.":
    "Inspectez les enregistrements d’attribution des sessions aux projets.",
  "Returns lightweight trace rows with route, model, status, latency, token and cost information.":
    "Renvoie des lignes de trace légères avec la route, le modèle, le statut, la latence, les jetons et le coût.",
  "Combine filters to analyze a provider account, route, application or registered project over a time range.":
    "Combinez les filtres pour analyser un compte fournisseur, une route, une application ou un projet enregistré sur une période.",
  "Provides dashboard-ready totals, latency distributions, cost estimates and account-selection statistics.":
    "Fournit des totaux prêts pour le tableau de bord, des distributions de latence, des estimations de coût et des statistiques de sélection de compte.",
  "Returns normalized project identity, repository metadata and the number of registered sessions.":
    "Renvoie l’identité normalisée du projet, les métadonnées du dépôt et le nombre de sessions enregistrées.",
  "Useful for diagnosing which Codex sessions contribute to project-level usage statistics.":
    "Utile pour déterminer quelles sessions Codex contribuent aux statistiques d’utilisation par projet.",
  "One-based page number.": "Numéro de page commençant à 1.",
  "Rows per page.": "Nombre de lignes par page.",
  "Optional inclusive start time.": "Heure de début incluse (facultatif).",
  "Optional inclusive end time.": "Heure de fin incluse (facultatif).",
  "Inclusive start time.": "Heure de début incluse.",
  "Inclusive end time.": "Heure de fin incluse.",
  "Filter by provider account.": "Filtrer par compte fournisseur.",
  "Filter by recorded route.": "Filtrer par route enregistrée.",
  "Filter by proxy-key application.":
    "Filtrer par application associée à une clé de proxy.",
  "Filter by registered Codex project.":
    "Filtrer par projet Codex enregistré.",

  // Endpoint catalog: Configuration
  "List provider accounts": "Lister les comptes fournisseurs",
  "List model aliases": "Lister les alias de modèles",
  "List application API keys": "Lister les clés d’API des applications",
  "List application policies": "Lister les politiques applicatives",
  "Get proxy settings": "Obtenir les paramètres du proxy",
  "Get runtime capabilities": "Obtenir les capacités d’exécution",
  "Read configured provider accounts and their live quota state.":
    "Consultez les comptes fournisseurs configurés et l’état de leur quota en temps réel.",
  "Read smart routing rules and fallback candidates.":
    "Consultez les règles de routage intelligent et les candidats de repli.",
  "List key metadata without exposing stored secrets.":
    "Listez les métadonnées des clés sans exposer les secrets stockés.",
  "Inspect fairness weights and registered result webhooks.":
    "Inspectez les poids d’équité et les webhooks de résultat enregistrés.",
  "Read persisted routing, passthrough and anonymous-demand settings.":
    "Consultez les paramètres persistés de routage, de passthrough et de demande anonyme.",
  "Read non-secret runtime configuration used by the dashboard.":
    "Consultez la configuration d’exécution non sensible utilisée par le tableau de bord.",
  "Sensitive credentials are omitted. The result includes routing state, identity and cached usage data.":
    "Les identifiants sensibles sont omis. Le résultat inclut l’état de routage, l’identité et les données d’utilisation en cache.",
  "Returns versioned alias definitions, matching constraints, objectives and ordered provider candidates.":
    "Renvoie des définitions d’alias versionnées, les contraintes de correspondance, les objectifs et les candidats fournisseurs ordonnés.",
  "Dashboard-created and environment-provided keys are returned with masked previews and source metadata.":
    "Les clés créées dans le tableau de bord et fournies par l’environnement sont renvoyées avec un aperçu masqué et les métadonnées de source.",
  "Policies are keyed by application and control admission fairness plus deferred-job webhook delivery.":
    "Les politiques sont indexées par application et contrôlent l’équité d’admission ainsi que l’envoi des webhooks des tâches différées.",
  "Returns operator-managed defaults such as passthrough-account and image-routing overrides.":
    "Renvoie les valeurs par défaut gérées par l’opérateur, comme les remplacements du compte passthrough et du routage des images.",
  "Includes OAuth availability, storage information and proxy capability flags without returning credentials.":
    "Inclut la disponibilité OAuth, les informations de stockage et les indicateurs de capacités du proxy, sans renvoyer d’identifiants.",
};

export default catalog;
