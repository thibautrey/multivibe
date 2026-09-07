# État de la migration de l'inférence vers Rust

Date : 7 septembre 2026.

Ce document décrit l'implémentation présente dans le profil natif
`MULTIVIBE_CONTROL_PLANE=true`. Il remplace le plan par lots rédigé avant le
portage.

## Conclusion

Le chemin public d'inférence du profil natif appartient désormais à
`rust/v1-edge`. Axum reçoit les routes canoniques `/v1` et leurs alias
racine, authentifie l'application, choisit le modèle, le provider et le compte,
applique l'admission, convertit les protocoles, relaie JSON, SSE ou WebSocket et
exécute les jobs différés. Une requête d'inférence servie par ce profil ne
traverse plus Express.

Node reste volontairement lancé sur `127.0.0.1:1456` comme plan de contrôle.
Il sert le dashboard et les assets, les routes d'administration, l'onboarding
et les callbacks OAuth, la gestion des comptes, clés, alias, politiques,
webhooks et modules, ainsi que la coordination du Host. Rust relaie vers ce
plan de contrôle les surfaces qu'il ne possède pas. Le provider-agent Go et les
runtimes de modèles restent aussi des sous-systèmes distincts.

Le profil historique en processus unique
`MULTIVIBE_CONTROL_PLANE=false` conserve les routeurs d'inférence Express
pour le développement et la compatibilité. Leur présence dans le dépôt ne
signifie donc pas qu'ils participent au chemin natif.

## Surface publique possédée par Rust

Les routes suivantes terminent dans le même handler Rust avec ou sans le
préfixe `/v1` :

| Méthode | Route canonique | Alias racine |
| --- | --- | --- |
| `GET` | `/v1/models`, `/v1/models/:id` | `/models`, `/models/:id` |
| `GET` | compatibilité catalogue | `/api/v1/models`, `/api/v1/models/:id`, `/api/tags` |
| `GET` | compatibilité version | `/version` |
| `GET` | `/v1/props` | `/props` |
| `POST` | `/v1/responses` | `/responses` |
| `GET` avec upgrade | `/v1/responses` | `/responses` |
| `POST` | `/v1/responses/compact` | `/responses/compact` |
| `POST` | `/v1/chat/completions` | `/chat/completions` |
| `POST` | `/v1/messages` | `/messages` |
| `POST` | `/v1/realtime/calls` | `/realtime/calls` |
| `GET` | `/v1/realtime/voices`, `/v1/settings/voices` | `/realtime/voices`, `/settings/voices` |

La capacité et les jobs restent exposés uniquement sous `/v1`. Un chemin
`/v1` inconnu est authentifié puis reçoit un `404` Rust ; il n'est jamais
transmis à Node. Les compatibilités de découverte `/api/tags`,
`/api/v1/models` et `/version` sont elles aussi résolues par Rust et ne
transportent pas de prompt.

## Fonctions d'inférence maintenant natives

| Bloc | Implémentation effective |
| --- | --- |
| Protocoles et transport | Responses, Chat Completions et Anthropic Messages, conversions provider, JSON, SSE, Responses WebSocket, Realtime et zstd sont traités dans Rust. |
| Routage | Le catalogue, les alias, le filtrage quota/policy, la rotation de comptes, les retries upstream et l'affinité de session facultative sont appliqués dans l'edge. |
| Idempotence synchrone | Le cache `rust/v1-edge/src/idempotency.rs` réserve atomiquement une clé avant l'appel upstream et partage le résultat avec les doublons simultanés. |
| Admission et capacité | Les limites `maxConcurrent` sont matérialisées par des leases par compte ; les attentes sont bornées et les snapshots soustraient les leases actives. |
| Jobs différés | Le dispatcher Tokio possède la concurrence, la fenêtre batch, la fairness, les deadlines, les retries, la reprise après redémarrage et les webhooks. Le runner TypeScript n'est pas démarré dans le profil natif. |
| Refresh OAuth | Rust renouvelle les tokens OpenAI, OpenCode et xAI avant expiration ou une fois après `401`, avec single-flight par compte et persistance CAS via le plan de contrôle. |
| Confidentialité | La vérification d'attestation, la politique de confiance locale, l'échange X25519/HKDF, les enveloppes AES-256-GCM et l'authentification de la réponse sont natifs. |
| Drain | Rust refuse le nouveau travail pendant un drain et compte séparément les requêtes, tours WebSocket et jobs actifs pour le contrôleur Host. |
| Traces | Les traces d'inférence, de tentatives upstream, de flux et d'usage sont produites dans Rust ; le dashboard et les agrégations restent dans le plan de contrôle. |

## Garanties de l'idempotence

L'idempotence synchrone est isolée par application, route normalisée et clé.
Une même clé avec une empreinte de requête différente renvoie `409
idempotency_key_reused`. Pour une requête identique :

- le premier appel reçoit le statut `created` ;
- les appels concurrents attendent la réservation en vol et reçoivent
  `coalesced` sans lancer une seconde génération ;
- une réponse terminée et conservable est renvoyée avec `replayed` pendant
  le TTL ;
- une requête non éligible ou un cache saturé sans entrée évictable reçoit
  `bypass`.

Le nombre d'entrées, le total d'octets, la taille d'une réponse, le TTL et la
durée maximale d'une réservation en vol sont bornés par configuration. Une
réponse trop grande ou non conservable peut être livrée aux followers déjà en
attente, puis la clé reste seulement marquée comme vue afin d'empêcher un
rejeu ambigu. Le cache volontairement exclut les flux, outils, contenus
multimodaux, conversations liées et requêtes stockées ou en arrière-plan.

## Admission et capacité

L'admission acquiert une lease sur un compte admissible avant l'appel provider.
La lease reste détenue jusqu'à la fin du JSON, du flux SSE, du tour WebSocket
ou du job ; son `Drop` la libère aussi lors d'une annulation ou d'une
déconnexion client. `X-MultiVibe-Max-Wait-Ms` permet d'attendre un changement
de capacité jusqu'à une durée bornée à 24 heures. Sans capacité à l'expiration,
l'edge renvoie `429 capacity_unavailable`.

`GET /v1/capacity` calcule `freeSlots` à partir des limites déclarées moins
les leases actives et `queueDepth` à partir des waiters visant les mêmes
comptes. Chaque acquisition, libération ou changement de file incrémente la
version de capacité. La confiance du snapshot reste `declared` : il décrit
l'admission locale, pas une garantie temps réel du provider distant.

## Jobs, migration et webhooks

Le store natif autoritaire est le fichier JSON désigné par
`V1_EDGE_JOBS_PATH`, écrit via un fichier temporaire, un renommage atomique
et des permissions `0600` sous Unix. Au démarrage, Rust récupère un job resté
`running` en le remettant en file si des tentatives restent, ou en le
terminant en échec si son budget est épuisé. Les deadlines déjà dépassées
deviennent `expired`.

Lorsque `JOBS_DB_PATH` pointe vers l'ancien SQLite TypeScript, Rust :

1. ouvre la base source en lecture seule ;
2. crée une sauvegarde SQLite cohérente
   `*.pre-rust-backup.sqlite` si elle n'existe pas déjà ;
3. importe les jobs et livraisons webhook dans le store JSON ;
   l'historique d'événements disponible est également repris ;
4. déduplique les redémarrages par identifiant de job, ou par application et
   clé d'idempotence.

La base SQLite reste intacte et sert de source de migration/retour arrière ;
elle n'est plus le store d'exécution du runner natif.

Les jobs `batch` créés entre 07:00 et 22:00 attendent 22:00 selon
`Europe/Paris`, avec prise en charge des changements d'heure. Le dispatcher
pondère les priorités `critical`, `interactive`, `standard`, `batch`,
puis les applications de même priorité. Il borne la concurrence globale,
applique les deadlines et retente les erreurs transitoires jusqu'au maximum du
job.

Un webhook de résultat est résolu dans la politique de l'application au moment
de la livraison. Rust signe les octets exacts du JSON avec HMAC-SHA-256,
envoie `X-MultiVibe-Event-Id` et
`X-MultiVibe-Signature: sha256=<hex>`, refuse les redirections et applique
un timeout de dix secondes. Une réponse hors `2xx`, une erreur réseau ou un
timeout déclenche un backoff exponentiel plafonné à une heure ; les tentatives
restent éligibles pendant 24 heures.

Chaque job conserve jusqu'à 1 000 événements dans le même store. Le flux
`/v1/jobs/:id/events` rejoue les événements postérieurs à `Last-Event-ID`,
reste abonné aux nouveaux événements et envoie un heartbeat toutes les quinze
secondes. Si le canal en mémoire prend du retard, il se recale sur l'historique
persisté.

## Refresh OAuth avec écriture CAS

Le manager Rust déduplique les refresh concurrents avec un mutex par compte.
Il renouvelle proactivement un token arrivant dans sa marge d'expiration et
peut forcer un unique refresh/retry après `401`, y compris pour Realtime.
Après attente du verrou, il recharge d'abord le store et réutilise un token
déjà renouvelé par une autre requête.

Rust transmet ensuite le nouveau credential à la route interne Node
`/internal/v1-edge/accounts/:id/token`, authentifiée par
`V1_EDGE_INTERNAL_JOB_TOKEN`. La requête contient l'ancien access token
attendu. Le store Node n'applique le patch que si ce token est encore courant ;
un `409` fait relire et adopter la version plus récente. Cette petite écriture
de contrôle évite que Rust écrase une réauthentification ou une modification
administrative concurrente.

## Inférence confidentielle

Le mode `confidential_verified` filtre les comptes sur leur
`privacyMode` et ne retombe jamais sur un compte standard. Avant d'envoyer
le prompt, Rust récupère une attestation liée à un challenge, au modèle et à
une politique de confiance locale Ed25519. Il dérive des clés de requête et de
réponse distinctes, chiffre une enveloppe authentifiée et vérifie le lien de
la réponse avec la requête et l'attestation.

Un échec avant l'envoi est signalé comme `not_sent`; une rupture après un
envoi potentiel est signalée comme résultat incertain et ne provoque pas de
fallback ordinaire. Les redirects sont désactivés pour ce transport. Les
traces n'enregistrent jamais le body clair d'une requête confidentielle, même
si `TRACE_INCLUDE_BODY=true`.

Cette garantie porte sur Responses et Chat Completions. Anthropic Messages et
les jobs différés confidentiels sont refusés explicitement. Une requête HTTP
avec `stream=true` reste scellée jusqu'à la réponse complète, puis Rust produit
le format SSE demandé ; elle ne fournit donc pas un flux confidentiel
progressif. Realtime n'appartient pas à cette surface vérifiée.

## Drain et modules JavaScript

Les routes internes Rust `begin`, `status` et `resume` sont protégées par
le token interne. `begin` ferme l'admission aux nouvelles requêtes, nouveaux
tours WebSocket et nouveaux jobs. Le statut devient prêt quand les trois
compteurs actifs atteignent zéro. Le contrôleur Host Node combine cet état avec
les opérations actives du provider-agent avant une mise à jour et réactive
l'admission si le drain doit être annulé.

Après l'initialisation du gestionnaire de modules, le profil natif refuse de
démarrer lorsqu'un module JavaScript chargé et activé déclare des hooks. Aucun
hook d'inférence n'est donc ignoré silencieusement. Les modules doivent être
désactivés, remplacés par une politique native ou utilisés avec le profil
historique Express.

## Limites restantes et périmètre conservé

- Les jobs natifs persistent en JSON. SQLite est uniquement la source
  historique importée et sauvegardée.
- Les politiques et limites de capacité sont des déclarations locales ; elles
  ne remplacent pas les quotas et erreurs renvoyés par le provider.
- Le code TypeScript d'inférence reste requis par le profil
  `MULTIVIBE_CONTROL_PLANE=false`. Sa suppression physique demanderait de
  retirer explicitement ce profil.
- Dashboard, administration, OAuth onboarding/callbacks, édition du store,
  modules, updater Host, provider-agent Go et runtimes locaux restent hors du
  chantier Rust de l'inférence.

## Validation

La couverture du dépôt comprend des tests Rust ciblés pour les alias racine
sans fallback Node, le single-flight et les conflits d'idempotence, les leases
d'admission, la libération des flux, la fenêtre `Europe/Paris`, la reprise et
l'import SQLite, les webhooks signés, le refresh OAuth et le drain. Les tests
TypeScript couvrent l'écriture CAS, le refus des modules actifs et la
coordination du contrôleur Host.

Avant livraison, exécuter depuis la branche intégrée :

```bash
cargo fmt --all -- --check
cargo check -p multivibe-v1-edge
cargo test -p multivibe-v1-edge
npm run build:api
npm test
docker compose config
```

Une recette de déploiement doit encore mesurer p50/p95/p99, débit, erreurs,
CPU et RSS du couple Rust + Node sur des providers simulés puis réels.
