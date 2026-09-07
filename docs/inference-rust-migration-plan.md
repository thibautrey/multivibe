# Audit et plan de migration de l’inférence vers Rust

Date : 7 septembre 2026. Référence analysée : `a4a4ba0528b93c470a7d8a1ef75360ca47bf2f9b`.
Audit statique du code ; aucune implémentation ni mesure de production réalisée.

## Conclusion et périmètre

Le transport et l’orchestration d’inférence encore en TypeScript peuvent devenir
entièrement Rust. Une grande partie existe déjà dans `rust/v1-edge/src/lib.rs` :
il faut terminer la parité puis supprimer le parcours historique, plutôt que
réécrire une troisième implémentation. Cela ne signifie pas migrer le calcul
des modèles : les runtimes et le provider-agent Go sont des sous-systèmes distincts.

`src/server.ts:749` réserve le montage `/v1` Express au mode non natif, mais
`src/server.ts:761` monte toujours les routes racine. Le fallback Rust
(`rust/v1-edge/src/lib.rs:7459`) relaie les routes hors `/v1` vers Node.
Le mode natif n’élimine donc pas tout passage d’inférence par JavaScript.
Ce constat concerne le code et ses profils, pas la configuration actuellement déployée.

Le JavaScript `.mjs` de benchmark/build n’est pas un moteur d’inférence à migrer.
Les wrappers natifs éventuels sont à retirer seulement après recherche de leurs
consommateurs restants ; déplacer de petites fonctions via N-API n’est pas la cible.
Les benchmarks `docs/protocol-conversion-benchmark.json` et
`docs/raw-protocol-conversion-benchmark.json` montrent précisément que le coût du
passage JS/Rust peut annuler le bénéfice de la conversion.

## Inventaire des migrations définitives possibles

« Définitive » signifie : Rust devient le propriétaire de la fonction et la
version TypeScript d’inférence est supprimée après validation de parité.
Cela n’autorise pas la suppression globale d’un fichier partagé avec l’administration.

| Bloc et sources TypeScript | État Rust constaté | Travail restant / destination proposée |
| --- | --- | --- |
| Routage HTTP : `src/routes/proxy/index.ts`, branchement dans `src/server.ts` | `/v1` natif dans `build_router` | Prendre aussi les alias racine en charge ; préserver auth, méthodes, erreurs et compatibilité ; retirer les routeurs Express d’inférence et le profil concurrent en fin de migration. |
| Conversions : `src/responses-bridge.ts`, `src/responses/{converters,payloads,sanitizers,helpers,upstream-payload-serializer,payload-inspection}.ts`, `src/anthropic-compat.ts` | Conversions Chat/Responses/Anthropic, sanitation et SSE déjà présentes dans l’edge ; noyau `rust/proxy-core` existant | Consolider le code pur dans le noyau, compléter les cas outils personnalisés, arguments imbriqués, images, reasoning, sorties vides et paramètres provider par fixtures différentielles. Ne pas déclarer la parité sur le seul nom des fonctions. |
| Streaming et transports : `src/websocket-responses.ts`, `src/realtime-proxy.ts`, `src/responses/{websocket-sse-relay,sse-stream-tap,stream-diagnostics}.ts` | SSE, WebSocket Responses et négociation realtime/voix déjà natives | Vérifier ordre des événements, fragments UTF-8, EOF incomplet, annulation, clients lents, erreurs après début du flux, auth et reconnexion ; retirer les relais JS après recette. |
| Sélection comptes/providers : `src/routes/proxy/index.ts`, `src/quota.ts`, `src/session-affinity.ts` | Sélection quota-aware, blocages et affinité Rust existants | Porter les écarts de politique, choix image et failover ; séparer décision pure et accès réseau. `image_request_model_override` est désérialisé en Rust mais aucun usage de cette valeur n’a été trouvé dans le fichier edge. |
| Résilience : `src/upstream-retry.ts`, correction de paramètres et boucles de reprise dans `src/routes/proxy/index.ts` | Rotation et classification de statuts existantes | Aligner retry sur même compte, Retry-After/backoff/jitter, rotation immédiate pour quota, attente bornée, correction des valeurs non supportées et reprise sur sortie vide. Ne jamais rejouer une génération après émission au client sans contrat explicite. |
| Idempotence : `src/inference-idempotency.ts` | Cache des réponses terminées | Porter réservation atomique, attente des doublons en vol, conflit même clé/autre payload, expiration des requêtes en vol, bornes globales en entrées/octets, règles d’éligibilité et headers de statut. |
| Admission et capacité : `src/smart-routing.ts`, `src/smart-routing-routes.ts`, presets d’alias | Routage et endpoint capacité simplifiés | Porter politiques d’alias, modalités, fenêtres horaires, priorités, budgets/deadlines, attente et report automatique, leases, libération sur annulation et mesures de santé. Conserver côté Node les écrans et l’édition des politiques. |
| Jobs : `src/jobs.ts`, exécuteur dans `src/server.ts` | Jobs JSON persistés et lancement Tokio | Porter scheduler équitable, concurrence bornée, leases/reprise, retries, fenêtres batch, idempotence et webhooks signés ; unifier la propriété et le stockage. Prévoir migration du SQLite TS et du JSON Rust avec sauvegarde et retour arrière. |
| Catalogue/usage : découverte dans `src/routes/proxy/index.ts`, `src/async-refresh.ts`, `src/usage-refresh.ts`, `src/usage-refresh-monitor.ts` | Catalogue caché, rafraîchissement dédupliqué et conservation de données antérieures | Porter les sémantiques stale-while-revalidate restantes et les observations nécessaires au routage. Exposer les snapshots à l’admin pour éviter deux caches contradictoires. Les tâches d’administration sans rôle d’inférence peuvent rester TS. |
| Tokens : portion de `src/account-utils.ts` appelée par proxy/realtime, support OAuth | Credentials lus par Rust ; champ refresh token présent mais pas de flux de renouvellement trouvé dans l’edge | Porter renouvellement automatique et reprise après 401, déduplication par compte et persistance sans écraser les modifications admin. L’onboarding et les callbacks OAuth peuvent rester Node. |
| Confidentialité : `src/confidential-inference.ts`, intégration dans proxy/admission | Aucun traitement `confidential_verified` trouvé dans l’edge inspecté | Porter validation d’attestation, JSON canonique, vérification cryptographique, échange de clés, chiffrement/déchiffrement et restrictions de routage ; utiliser des bibliothèques éprouvées et les vecteurs TS. Refuser explicitement ce mode tant que le contrat natif n’est pas implémenté. |
| Télémétrie d’inférence : `src/request-tracing.ts`, `src/trace-headers.ts`, diagnostics SSE et fonctions de coût/usage | `TraceSink`, diagnostics, usage/coût et événements Rust déjà substantiels | Aligner les champs et la redaction, terminer l’observation de capacité ; laisser lecture historique, agrégation et UI en Node si utile. Il ne s’agit pas d’une migration de télémétrie depuis zéro. |
| Drain host : portion inférence de `src/host/update-controller.ts` | Compteurs et admission host branchés sur Express et son WebSocket | Donner à Rust la propriété des requêtes, tours WS et jobs actifs ; exposer begin-drain/status au contrôleur host. Le lanceur/updater lui-même n’a pas besoin d’être réécrit. |

## Écarts qui empêchent une suppression immédiate

1. **Idempotence** : `rust/v1-edge/src/lib.rs:5614` inclut le digest du body
   dans la clé du cache. Deux payloads différents utilisant une même clé
   deviennent deux entrées, contrairement au conflit détecté par
   `src/inference-idempotency.ts:562`. Le cache Rust (`:3647`) ne réserve pas
   de requête en vol et n’applique pas les plafonds globaux du cache TS.
2. **Capacité** : `rust/v1-edge/src/lib.rs:6507` additionne les maximums
   déclarés, expose `queueDepth: 0`, sans soustraire de leases actives.
   Le TypeScript acquiert et libère une réservation dans
   `src/smart-routing-routes.ts:764`. Les deux endpoints ne représentent pas
   aujourd’hui la même notion de capacité libre.
3. **Exécution différée** : le handler natif (`:5726`) crée un job puis lance
   directement `tokio::spawn`. `run_job` (`:5575`) ne reproduit pas le scheduler
   équitable ni les livraisons webhook de `src/jobs.ts`. `auto` est accepté
   dans le handler mais n’y possède pas le parcours admission/report du TS.
4. **Deux exécuteurs** : `src/server.ts:798` construit toujours le JobRunner
   TS, puis le démarre ; en mode natif il soumet ses jobs à l’edge. Il faut
   inventorier et reprendre les deux stocks de jobs avant de retirer ce runner.
5. **Fonctions de confiance et disponibilité** : les chemins TS de refresh
   token, confidentialité et drain ne deviennent pas natifs simplement parce
   que `/v1` est maintenant servi par Axum.

## Cas qui nécessite une décision de compatibilité

`src/module-sdk.ts` définit des hooks JavaScript capables de remplacer une
requête, répondre directement, transformer une réponse et appliquer une politique
d’échec. `src/routes/proxy/index.ts` invoque notamment `request.received`,
`request.beforeUpstream`, `response.received` et `response.beforeClient`.

Ces modules tiers ne peuvent pas être convertis automatiquement en Rust en
préservant une API JavaScript arbitraire. Cible recommandée : hooks déclaratifs
pour les politiques simples, contrat versionné Rust/WASM pour les transformations.
Un pont Node peut assurer une transition, mais il maintient JavaScript dans
l’inférence des requêtes concernées. Ne retirer le SDK actuel qu’après inventaire
des modules réellement utilisés et portage/remplacement de chacun. Ne jamais
ignorer silencieusement un module configuré comme obligatoire.

## Plan d’implémentation ordonné

### Lot 0 — Figer les contrats avant portage

- Constituer une matrice route × profil × provider × protocole × streaming.
- Réutiliser les fixtures et tests TS/Rust existants ; ajouter un harnais
  différentiel avec upstreams simulés, horloge contrôlée et résultats normalisés.
- Comparer statuts, erreurs, headers, choix compte/modèle, body et événements,
  y compris refus de confidentialité et modules obligatoires non supportés.
- Inventorier imports partagés avec l’admin, modules actifs, profils de packaging
  et données des deux runners. Définir le protocole d’état partagé et son écrivain.

Sortie : liste exhaustive des écarts testables et critères de suppression par bloc.

### Lot 1 — Structurer et compléter le moteur Rust

Extraire progressivement le grand `lib.rs` en modules transport, protocoles,
providers, routage, idempotence, jobs et télémétrie, sans changement de comportement.
Réutiliser `proxy-core` pour les fonctions pures compatibles avec son contrat.
Compléter conversions/résilience et idempotence atomique avec mémoire bornée.

Sortie : mêmes résultats sur fixtures, un seul appel upstream pour des doublons
simultanés éligibles, conflit de payload conforme et arrêt effectif à l’annulation.

### Lot 2 — Donner à Rust la propriété des décisions et de l’état actif

Porter admission, politiques, réservations, compteurs, attente et capacité SSE.
Ajouter le renouvellement de tokens, les caches nécessaires et le contrat de drain.
Node reste propriétaire des modifications administratives ; Rust publie les
observations et persiste les tokens via un mécanisme versionné/atomique convenu.
Éviter deux écrivains indépendants remplaçant le même snapshot de comptes.

Sortie : pas de sur-admission sous concurrence, libération sur toutes les sorties,
équivalence de routage, refresh unique et drain qui attend réellement les flux actifs.

### Lot 3 — Unifier les jobs

Implémenter dans Rust le contrat durable TS, de préférence sur SQLite pour
conserver ses transactions et faciliter la reprise du schéma existant, sous réserve
de revue du schéma. Ajouter import du JSON natif, migrations versionnées et exercice
de restauration. Basculer les producteurs/admin vers le service de jobs Rust,
puis arrêter le runner TS. Ne pas faire fonctionner deux consommateurs sans
mécanisme commun de claim/lease.

Sortie : reprise après crash, annulation/deadline, fairness, unicité d’exécution
selon le contrat, signatures et retries webhook vérifiés sur serveur local simulé.

### Lot 4 — Fermer les écarts spécialisés

Porter le client confidentiel avec vecteurs croisés, tests de rejet et absence de
sortie en clair. Implémenter le contrat de modules choisi et migrer les extensions.
Finaliser la parité traces/usage et realtime. Ce lot bloque le retrait de TS pour
les fonctionnalités concernées ; ne pas les présenter comme déjà compatibles.

### Lot 5 — Basculer les routes et retirer le code historique

Monter les alias racine explicitement dans Rust, sans redirection HTTP des POST,
avec normalisation du chemin et conservation des contrats auth/idempotence.
Faire du lancement Rust + control plane le profil de développement/support commun.
Mettre à jour packaging et tests de démarrage, puis retirer les routeurs,
converters, middlewares et wrappers TS devenus inutiles. Garder les helpers
encore importés par l’admin, ou les remplacer par des lectures du service Rust.
Supprimer dépendances et options de fallback seulement après inventaire final.

Sortie : toutes les routes d’inférence supportées, avec et sans `/v1`, restent
traitées dans Rust ; un control plane simulé échouant sur toute requête d’inférence
ne fait échouer aucun scénario de recette. Les échanges de contrôle explicitement
prévus restent distincts du transport des prompts et réponses.

## Validation à exécuter lors de l’implémentation

- Dans les worktrees : revue ciblée et `git diff --check` ; pas de réparation des
  dépendances absentes. Intégrer les commits dans `main` avant validation dépendante.
- Sur `main` : `cargo fmt --all -- --check`, `cargo check -p multivibe-v1-edge`,
  `cargo test -p multivibe-proxy-core`, `cargo test -p multivibe-v1-edge`,
  `npm run build:api`, `npm test`. Tests N-API tant que ce pont existe ; tests host
  et packaging lorsque leur contrat de démarrage/drain change.
- Recette différentielle HTTP/SSE/WS/realtime ; scénarios concurrence,
  déconnexions, quota/401/429/5xx, outils/images, reprise jobs et isolement application.
- Mesurer avant/après TTFT, p50/p95/p99, débit, erreurs, CPU et RSS total
  Rust + Node sur mêmes payloads, providers simulés et charges lentes/rapides.
  Fixer les budgets d’acceptation sur cette baseline ; aucun gain chiffré n’est
  déduit du langage ou des seuls micro-benchmarks existants.
- Déploiement progressif et retour arrière couvrant également les formats persistés.

## Hors du chantier

Dashboard/web, administration, onboarding OAuth, catalogue commercial, scripts
de build/benchmark, agent Go et moteurs locaux restent hors migration Rust
de l’inférence. La suppression de Node du produit entier serait un autre chantier.

Validation de ce livrable : audit statique et contrôle de diff uniquement.
Aucun build/test applicatif exécuté pour cette modification documentaire.
