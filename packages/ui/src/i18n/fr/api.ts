const catalog: Record<string, string> = {
  "The action could not be completed.": "L’action n’a pas pu être effectuée.",
  "Create an API key": "Créer une clé API",
  "Use a short application name such as mobile, litellm, or staging-worker.":
    "Utilisez un nom d’application court, par exemple mobile, litellm ou staging-worker.",
  Application: "Application",
  "Also create a Cloudflare Access service token":
    "Créer aussi un jeton de service Cloudflare Access",
  "Cloudflare Access provisioning is not configured.":
    "Le provisionnement Cloudflare Access n’est pas configuré.",
  "No Access application is mapped for “{application}”.":
    "Aucune application Access n’est associée à « {application} ».",
  "One token per key, scoped to the mapped application.":
    "Un jeton par clé, limité à l’application associée.",
  "Creating...": "Création…",
  "Create secret key": "Créer la clé secrète",
  "Active keys": "Clés actives",
  "No application keys yet": "Aucune clé d’application pour le moment",
  "Proxy access is unrestricted until you create the first key.":
    "L’accès au proxy reste ouvert tant que vous n’avez pas créé la première clé.",
  "Create an application key to access the API.":
    "Créez une clé d’application pour accéder à l’API.",
  Key: "Clé",
  Created: "Créée",
  "Last used": "Dernière utilisation",
  "Managed by": "Géré par",
  "Fairness weight": "Poids d’équité",
  "Fairness weight for {application}": "Poids d’équité pour {application}",
  Dashboard: "Tableau de bord",
  Environment: "Environnement",
  Revoke: "Révoquer",
  "Revoking...": "Révocation…",
  "Cloudflare Access application {applicationId}":
    "Application Cloudflare Access {applicationId}",
  "Advanced: signed result webhooks": "Avancé : webhooks de résultats signés",
  "Register destinations for deferred results.":
    "Enregistrez les destinations des résultats différés.",
  Show: "Afficher",
  "Select application": "Sélectionner une application",
  "HTTPS endpoint": "Point de terminaison HTTPS",
  "Register webhook": "Enregistrer le webhook",
  Status: "Statut",
  Enabled: "Activé",
  Disabled: "Désactivé",
  Delete: "Supprimer",
  "Key created": "Clé créée",
  "Copy your secret key": "Copiez votre clé secrète",
  "This is the only time the full key for {application} will be displayed.":
    "C’est la seule fois où la clé complète de {application} sera affichée.",
  Copy: "Copier",
  Copied: "Copié",
  "Copy both headers": "Copier les deux en-têtes",
  "Copy the HMAC secret": "Copier le secret HMAC",
  "I have saved this key": "J’ai enregistré cette clé",
  "I have saved this secret": "J’ai enregistré ce secret",
  "Webhook registered": "Webhook enregistré",
  "This secret is shown once. Verify x-multivibe-signature before accepting an event.":
    "Ce secret n’est affiché qu’une fois. Vérifiez x-multivibe-signature avant d’accepter un événement.",
  "Service token for application {applicationId}. The client secret is shown only once.":
    "Jeton de service pour l’application {applicationId}. Le secret client n’est affiché qu’une seule fois.",
  "Service token for application {applicationId}. The client secret is shown only once. Expires {date}.":
    "Jeton de service pour l’application {applicationId}. Le secret client n’est affiché qu’une seule fois. Expire le {date}.",
  "Revoke the API key for {application}? Clients using it will immediately lose access.":
    "Révoquer la clé API de {application} ? Les clients qui l’utilisent perdront immédiatement l’accès.",
  "Revoke the API key for {application}? Clients using it will immediately lose access. This also deletes its Cloudflare Access service token ({clientId}).":
    "Révoquer la clé API de {application} ? Les clients qui l’utilisent perdront immédiatement l’accès. Cela supprime aussi son jeton de service Cloudflare Access ({clientId}).",
  "Set up your AI agents": "Configurez vos agents IA",
  "Copy this prompt and paste it into your AI agent. It will configure the main harnesses installed on this machine and test each connection with a minimal request.":
    "Copiez ce prompt et collez-le dans votre agent IA. Il configurera les principaux harnais installés sur cette machine et testera chaque connexion avec une requête minimale.",
  "Copy prompt": "Copier le prompt",
  "Prompt copied": "Prompt copié",
  "Show more": "Afficher plus",
  "Show less": "Afficher moins",
  "I just created an API key for MultiVibe, a multi-model AI platform with an OpenAI-compatible API.\n\nAPI base URL: {apiBaseUrl}\nAPI key: {apiKey}\n\nMain endpoints:\n- GET {apiBaseUrl}/models: list the available models.\n- POST {apiBaseUrl}/chat/completions: OpenAI Chat Completions.\n- POST {apiBaseUrl}/responses: OpenAI Responses API.\n- POST {apiBaseUrl}/messages: Anthropic Messages API, useful for Claude Code.\n\nPlease configure the AI coding harnesses already installed on this machine (for example Codex, Claude Code, OpenCode, Cline, Roo Code, Continue or any other compatible tool) to use this endpoint and this key. Reuse each harness's existing configuration files and environment variables, and do not install a harness that is not already present or change unrelated settings.\n\nThen test every harness you configured with one minimal request (a single short prompt such as \"Reply with OK\") using a model returned by GET {apiBaseUrl}/models. Report which harnesses are configured, which model each one used, and the exact result of each test. Never print the API key in your final answer.":
    "Je viens de créer une clé API pour MultiVibe, une plateforme IA multi-modèles dotée d’une API compatible OpenAI.\n\nURL de base de l’API : {apiBaseUrl}\nClé API : {apiKey}\n\nPoints d’entrée principaux :\n- GET {apiBaseUrl}/models : lister les modèles disponibles.\n- POST {apiBaseUrl}/chat/completions : Chat Completions compatible OpenAI.\n- POST {apiBaseUrl}/responses : API Responses compatible OpenAI.\n- POST {apiBaseUrl}/messages : API Messages d’Anthropic, utile pour Claude Code.\n\nConfigure les harnais de codage IA déjà installés sur cette machine (par exemple Codex, Claude Code, OpenCode, Cline, Roo Code, Continue ou tout autre outil compatible) pour qu’ils utilisent ce point de terminaison et cette clé. Réutilise les fichiers de configuration et les variables d’environnement existants de chaque harnais, n’installe aucun harnais qui n’est pas déjà présent et ne modifie pas de réglages sans rapport.\n\nTeste ensuite chaque harnais configuré avec une requête minimale (un seul prompt court comme « Réponds OK ») en utilisant un modèle renvoyé par GET {apiBaseUrl}/models. Indique quels harnais sont configurés, quel modèle chacun a utilisé et le résultat exact de chaque test. N’affiche jamais la clé API dans ta réponse finale.",
};

export default catalog;
