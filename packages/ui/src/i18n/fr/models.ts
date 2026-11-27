// Models catalog: headings, filters, availability, actions, empty states, pagination.
const catalog: Record<string, string> = {
  "Model pricing": "Tarification des modèles",
  "Set the amount users are billed per million tokens. Cached input can be cheaper than fresh input. Unlisted models keep the upstream estimate.":
    "Fixez le montant facturé aux utilisateurs par million de jetons. L’entrée en cache peut être moins chère que l’entrée fraîche. Les modèles non listés conservent l’estimation du fournisseur.",
  "Model": "Modèle",
  "Choose or type a model id": "Choisissez ou saisissez un identifiant de modèle",
  "Input $/1M": "Entrée $/1M",
  "Output $/1M": "Sortie $/1M",
  "Cached input $/1M": "Entrée en cache $/1M",
  "Same as input": "Identique à l’entrée",
  "Save price": "Enregistrer le prix",
  "Update price": "Mettre à jour le prix",
  "Clear": "Effacer",
  "No custom prices yet.": "Aucun prix personnalisé pour l’instant.",
  "Price saved.": "Prix enregistré.",
  "Price removed. The upstream rate applies again.": "Prix supprimé. Le tarif du fournisseur s’applique de nouveau.",
  "The price could not be saved.": "Le prix n’a pas pu être enregistré.",
  "The price could not be removed.": "Le prix n’a pas pu être supprimé.",
  "Enter a model and non-negative prices per million tokens.": "Saisissez un modèle et des prix positifs ou nuls par million de jetons.",
  "Off-peak input $/1M": "Entrée heures creuses $/1M",
  "Off-peak output $/1M": "Sortie heures creuses $/1M",
  "Off-peak cached input $/1M": "Entrée en cache heures creuses $/1M",
  "Same as standard": "Identique au tarif normal",
  "Same as off-peak input": "Identique à l’entrée heures creuses",
  "Off-peak $/1M": "Heures creuses $/1M",
  "None": "Aucun",
  "Off-peak rates need an input and an output price.": "Les tarifs heures creuses nécessitent un prix d’entrée et de sortie.",
  "Off-peak hours": "Heures creuses",
  "Inside these windows, models with off-peak rates are billed at those rates. Times use the selected timezone. A range whose end is before its start continues into the next day.":
    "Dans ces tranches, les modèles dotés de tarifs heures creuses sont facturés à ces tarifs. Les horaires utilisent le fuseau horaire sélectionné. Une tranche dont la fin précède le début se poursuit le lendemain.",
  "Enable off-peak pricing": "Activer la tarification heures creuses",
  "Timezone": "Fuseau horaire",
  "Off-peak pricing is enabled.": "La tarification heures creuses est activée.",
  "Off-peak pricing is disabled.": "La tarification heures creuses est désactivée.",
  "Add range": "Ajouter une tranche",
  "No off-peak range": "Aucune tranche heures creuses",
  "Start time": "Heure de début",
  "End time": "Heure de fin",
  "Save schedule": "Enregistrer le planning",
  "Off-peak schedule saved.": "Planning heures creuses enregistré.",
  "The off-peak schedule could not be saved. Check the times and the timezone.":
    "Le planning heures creuses n’a pas pu être enregistré. Vérifiez les horaires et le fuseau horaire.",
  "Each off-peak range needs a start and an end that differ.":
    "Chaque tranche heures creuses doit avoir un début et une fin différents.",
  "Monday": "Lundi",
  "Tuesday": "Mardi",
  "Wednesday": "Mercredi",
  "Thursday": "Jeudi",
  "Friday": "Vendredi",
  "Saturday": "Samedi",
  "Sunday": "Dimanche",
  "Edit": "Modifier",
  // Sources
  "All sources": "Toutes les sources",
  "Providers": "Fournisseurs",
  "Personal connections": "Connexions personnelles",
  "Team": "Équipe",

  // Page heading
  "Models": "Modèles",
  "Find the right model": "Trouvez le modèle adapté",
  "Explore your connected providers and MultiVibe Cloud models.":
    "Explorez vos fournisseurs connectés et les modèles MultiVibe Cloud.",

  // Cloud access notice
  "Checking your Cloud access…": "Vérification de votre accès Cloud…",
  "No models exposed for your Cloud account.":
    "Aucun modèle n'est exposé pour votre compte Cloud.",
  "Cloud exposes models, but no matching chat route is available here.":
    "Le Cloud expose des modèles, mais aucune route de conversation correspondante n'est disponible ici.",
  "Cloud catalog verified for your account.":
    "Catalogue Cloud vérifié pour votre compte.",
  "Cloud access denied or expired. Check your connection.":
    "Accès Cloud refusé ou expiré. Vérifiez votre connexion.",
  "Cloud account disconnected.": "Compte Cloud déconnecté.",
  "Could not verify your Cloud access.": "Impossible de vérifier votre accès Cloud.",
  "Check again": "Vérifier à nouveau",

  // Filters
  "Filters": "Filtres",
  "Filters · Active filters": "Filtres · Filtres actifs",
  "Model filters": "Filtres des modèles",
  "Reset": "Réinitialiser",
  "Source": "Source",
  "Availability": "Disponibilité",
  "Ready to use": "Prêt à l'emploi",
  "Models with a connected, available account.":
    "Modèles associés à un compte connecté et disponible.",
  "Provider": "Fournisseur",
  "All providers": "Tous les fournisseurs",
  "Cloud access depends on your plan and available capacity.":
    "L'accès Cloud dépend de votre offre et de la capacité disponible.",
  "Connecting…": "Connexion…",
  "Connect Cloud": "Connecter Cloud",

  // Catalog errors
  "MultiVibe Cloud discovery catalog could not be loaded.":
    "Le catalogue de découverte MultiVibe Cloud n'a pas pu être chargé.",
  "Provider discovery catalog could not be loaded.":
    "Le catalogue de découverte des fournisseurs n'a pas pu être chargé.",
  "Retry catalogs": "Réessayer les catalogues",
  "The catalog did not advance. Refresh it before trying again.":
    "Le catalogue n'a pas progressé. Actualisez-le avant de réessayer.",
  "More models could not be loaded. Try again.":
    "Les modèles supplémentaires n'ont pas pu être chargés. Réessayez.",
  "Try again": "Réessayer",
  "Loading more…": "Chargement en cours…",
  "Load more models": "Charger plus de modèles",
  "Could not connect to MultiVibe Cloud. Please try again.":
    "Impossible de se connecter à MultiVibe Cloud. Veuillez réessayer.",

  // Search and sort
  "Search models": "Rechercher des modèles",
  "Search models or providers…": "Rechercher des modèles ou des fournisseurs…",
  "Sort models": "Trier les modèles",
  "Ready to use first": "Prêts à l'emploi en premier",
  "Name: A–Z": "Nom : A–Z",
  "Name: Z–A": "Nom : Z–A",

  // Result summary
  "models · Updating catalogs…": "modèles · Mise à jour des catalogues…",
  "model · Updating catalogs…": "modèle · Mise à jour des catalogues…",
  "models · Showing {from}–{to}": "modèles · Affichage de {from} à {to}",
  "model · Showing {from}–{to}": "modèle · Affichage de {from} à {to}",
  "models": "modèles",
  "model": "modèle",
  "Clear filters": "Effacer les filtres",
  "Model / provider": "Modèle / fournisseur",

  // Model rows
  "Details": "Détails",
  "Details: {name}": "Détails : {name}",
  "{action}: {name}": "{action} : {name}",
  "View {count} connection options": "Voir {count} options de connexion",
  "Local": "Local",
  "Cloud": "Cloud",
  "Unavailable": "Indisponible",

  // Row actions
  "Use model": "Utiliser le modèle",
  "Ask your admin": "Demandez à votre administrateur",
  "View access": "Voir l'accès",
  "Set up": "Configurer",

  // Empty states
  "Loading your model library…": "Chargement de votre bibliothèque de modèles…",
  "No models match your filters": "Aucun modèle ne correspond à vos filtres",
  "Your model library is empty": "Votre bibliothèque de modèles est vide",
  "Connected models will appear as catalogs become available.":
    "Les modèles connectés apparaîtront dès que les catalogues seront disponibles.",
  "Try a different search, source, or provider.":
    "Essayez une autre recherche, une autre source ou un autre fournisseur.",
  "Connect a provider or refresh the catalog to get started.":
    "Connectez un fournisseur ou actualisez le catalogue pour commencer.",

  // Pagination
  "Model pages": "Pages de modèles",
  "← Previous": "← Précédent",
  "Page": "Page",
  "Go to page": "Aller à la page",
  "of {total}": "sur {total}",
  "Next →": "Suivant →",

  // lib/modelCatalog route labels
  "Routing alias": "Alias de routage",
  "MultiVibe Cloud network": "Réseau MultiVibe Cloud",
  "MultiVibe Cloud catalog": "Catalogue MultiVibe Cloud",

  // lib/runtimeCatalog fallbacks
  "Cloud provider": "Fournisseur cloud",
};

export default catalog;
