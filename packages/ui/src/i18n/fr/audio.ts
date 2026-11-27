const catalog: Record<string, string> = {
  // AudioPanel — model pickers
  "Not configured": "Non configuré",
  "Custom model…": "Modèle personnalisé…",
  "Model identifier": "Identifiant du modèle",
  "Reasoning model": "Modèle de raisonnement",
  "Answers after transcription, routed through MultiVibe.":
    "Réponses après transcription, routées via MultiVibe.",
  "Transcription": "Transcription",
  "Speech-to-text model.": "Modèle de reconnaissance vocale.",
  "Synthesis": "Synthèse",
  "Text-to-speech model.": "Modèle de synthèse vocale.",
  "Output voice": "Voix de sortie",
  "Default voice for spoken replies.": "Voix par défaut pour les réponses orales.",
  "Transcription language": "Langue de transcription",
  "Optional hint; automatic detection is the default.":
    "Indication facultative ; la détection automatique est utilisée par défaut.",
  "Turn detection": "Détection des tours de parole",
  "How the server decides the user finished speaking.":
    "Comment le serveur détermine que l’utilisateur a fini de parler.",

  // AudioPanel — hero and statuses
  "Loading audio settings…": "Chargement des paramètres audio…",
  "Audio & live voice": "Audio et voix en direct",
  "The audio plugin is unavailable.": "Le plugin audio est indisponible.",
  "Audio and live voice settings": "Paramètres audio et de voix en direct",
  "Audio": "Audio",
  "Live voice": "Voix en direct",
  "Configure the speech pipeline behind the local GPT-Live server.":
    "Configurez la chaîne de traitement vocal derrière le serveur GPT-Live local.",
  "Working…": "En cours…",

  // AudioPanel — advanced settings
  "Local GPT-Live server": "Serveur GPT-Live local",
  "Base URL used for the health check. The token stays in the host environment.":
    "URL de base utilisée pour le contrôle de santé. Le jeton reste dans l’environnement de l’hôte.",
  "Escalation model": "Modèle d’escalade",
  "Stronger model for voice turns that need more reasoning.":
    "Modèle plus puissant pour les tours vocaux nécessitant davantage de raisonnement.",
  "Escalation threshold": "Seuil d’escalade",
  "0..1; higher values keep more turns on the local model.":
    "0..1 ; des valeurs plus élevées conservent davantage de tours sur le modèle local.",
  "Escalate complex requests": "Escalader les requêtes complexes",
  "Publishes multivibe/voice with local-first routing.":
    "Publie multivibe/voice avec un routage local en priorité.",
  "Task delegation": "Délégation des tâches",
  "Responses API or a client callback.": "API Responses ou rappel client.",
  "Session limit (seconds)": "Limite de session (secondes)",

  // AudioPanel — actions, feedback and environment
  "Audio settings saved.": "Paramètres audio enregistrés.",
  "Audio plugin disabled.": "Plugin audio désactivé.",
  "Audio plugin enabled.": "Plugin audio activé.",
  "Testing…": "Test en cours…",
  "Test server": "Tester le serveur",
  "Reachable · {status} · {latency} ms": "Accessible · {status} · {latency} ms",
  "Unreachable · {error}": "Inaccessible · {error}",
  "Unreachable · HTTP {status}": "Inaccessible · HTTP {status}",
  "Server environment": "Environnement du serveur",
  "Copy": "Copier",
  "Start the local server with these values, or use them to verify its configuration.":
    "Démarrez le serveur local avec ces valeurs, ou utilisez-les pour vérifier sa configuration.",
};

export default catalog;
