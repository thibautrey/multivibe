const catalog: Record<string, string> = {
  // Host update status and policy
  "Not yet": "Pas encore",
  "Unknown": "Inconnu",
  "Host updates are unavailable": "Les mises à jour de l’hôte sont indisponibles",
  "This dashboard is not running from a managed native MultiVibe Host installation. Docker updates are managed by the host orchestrator.":
    "Ce tableau de bord ne s’exécute pas depuis une installation MultiVibe Host native gérée. Les mises à jour Docker sont gérées par l’orchestrateur de l’hôte.",
  "Loading update status…": "Chargement de l’état des mises à jour…",
  "Verified updates": "Mises à jour vérifiées",
  "idle": "inactif",
  "checking": "vérification",
  "available": "disponible",
  "downloading": "téléchargement",
  "downloaded": "téléchargée",
  "installing": "installation",
  "current": "à jour",
  "deferred": "reportée",
  "failed": "échec",
  "Installed version": "Version installée",
  "Current native bundle": "Paquet natif actuel",
  "Available": "Disponible",
  "Required security or compatibility update": "Mise à jour de sécurité ou de compatibilité obligatoire",
  "Eligible for this installation": "Éligible pour cette installation",
  "No eligible rollout": "Aucun déploiement éligible",
  "Next check": "Prochaine vérification",
  "Last check: {at}": "Dernière vérification : {at}",
  "Policy": "Politique",
  "Update behavior": "Comportement des mises à jour",
  "Mode": "Mode",
  "Install automatically overnight": "Installer automatiquement pendant la nuit",
  "Download automatically, install manually": "Télécharger automatiquement, installer manuellement",
  "Notify only": "Notifier uniquement",
  "Channel": "Canal",
  "Stable": "Stable",
  "Beta": "Bêta",
  "Automatic updates run between 02:00 and 06:00 in this machine’s local time, at a randomized time, after 30 minutes without requests. Busy or sleeping machines wait for a later night. No confirmation is needed.":
    "Les mises à jour automatiques s’exécutent entre 02:00 et 06:00 à l’heure locale de cette machine, à un moment aléatoire, après 30 minutes sans requête. Les machines occupées ou en veille attendent une nuit ultérieure. Aucune confirmation n’est nécessaire.",
  "Next automatic update window: {at}": "Prochaine fenêtre de mise à jour automatique : {at}",
  "Checking…": "Vérification…",
  "Check now": "Vérifier maintenant",
  "Queuing…": "Mise en file…",
  "Download queued for the background updater.":
    "Téléchargement mis en file pour le programme de mise à jour en arrière-plan.",
  "Download queued": "Téléchargement en file",
  "Download in background": "Télécharger en arrière-plan",
  "Installation queued. The separate background updater will drain, verify and restart MultiVibe Host safely.":
    "Installation mise en file. Le programme de mise à jour en arrière-plan, séparé, traitera la file, vérifiera l’installation puis redémarrera MultiVibe Host en toute sécurité.",
  "Installation queued": "Installation en file",
  "Install on next updater run": "Installer lors de la prochaine exécution du programme de mise à jour",

  // Release announcement and release notes
  "Read the release notes for MultiVibe version {version}":
    "Lire les notes de version de MultiVibe {version}",
  "MultiVibe updated": "MultiVibe a été mis à jour",
  "Version {version}": "Version {version}",
  "See what’s new": "Découvrir les nouveautés",
  "Hide the update notice for version {version}":
    "Masquer l’avis de mise à jour de la version {version}",
  "This release does not include additional notes.": "Cette version ne contient pas de notes supplémentaires.",
  "Close release notes": "Fermer les notes de version",
  "Update installed · Version {version}": "Mise à jour installée · Version {version}",
  "Released {date}": "Publiée le {date}",
  "Loading release notes from GitHub…": "Chargement des notes de version depuis GitHub…",
  "View release on GitHub": "Voir la version sur GitHub",
  "Done": "Terminé",
};

export default catalog;
