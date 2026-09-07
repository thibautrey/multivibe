# Architecture actuelle de l'API Rust

Date : 7 septembre 2026.

## Architecture retenue

Dans le profil natif `MULTIVIBE_CONTROL_PLANE=true`, le port public `1455`
est servi par Rust/Axum. L'edge possède les requêtes d'inférence sous `/v1`
et leurs alias racine : authentification, catalogue, routage, conversions,
admission, retries, JSON, SSE, WebSocket, Realtime, jobs et capacité restent
dans le même processus Rust jusqu'au provider.

Node/Express écoute sur `127.0.0.1:1456` comme plan de contrôle. Il reste
responsable du dashboard, des assets, de l'administration, des flux
d'onboarding et callbacks OAuth, de l'édition du store, des modules et de la
coordination Host/provider-agent. L'edge lui transmet seulement les routes
qu'il ne possède pas. Node fournit aussi une route interne étroite pour
persister les tokens renouvelés par Rust avec une comparaison atomique.

Le profil `MULTIVIBE_CONTROL_PLANE=false` reste un mode historique en
processus unique dans lequel Express monte encore les routeurs d'inférence et
son runner de jobs. Il n'est pas utilisé sur le chemin public du profil natif.

## Composants

| Couche | Emplacement | Rôle dans le profil natif |
| --- | --- | --- |
| Edge HTTP public | `rust/v1-edge/src/lib.rs` | Routes d'inférence, auth, body limits, zstd, routage, transports, capacité, jobs et drain |
| Idempotence | `rust/v1-edge/src/idempotency.rs` | Réservations single-flight, conflits, replay et bornes mémoire |
| Inférence confidentielle | `rust/v1-edge/src/confidential.rs` | Attestation, politique de confiance, chiffrement et authentification des réponses |
| Refresh OAuth | `rust/v1-edge/src/token_refresh.rs` | Refresh single-flight OpenAI/OpenCode/xAI et retry après `401` |
| Bootstrap edge | `rust/v1-edge/src/main.rs` | Configuration, bind et arrêt du serveur |
| Plan de contrôle | `src/server.ts` | Dashboard, admin, OAuth, édition des comptes/politiques, modules et Host |
| Persistance CAS | `src/internal-v1-edge-routes.ts`, `src/store.ts` | Écriture conditionnelle des credentials renouvelés |
| Store partagé | `data/accounts.json` | Comptes, aliases, clés, politiques et webhooks |
| Jobs natifs | `V1_EDGE_JOBS_PATH` | État JSON autoritaire du dispatcher Rust |
| Migration jobs | `JOBS_DB_PATH` | Ancien SQLite lu et sauvegardé avant import |
| Runtime local | `provider-agent/`, `host/application/` | Agent Go et intégration des runtimes locaux |

## Routes possédées par Rust

| Fonction | Routes canoniques | Alias racine natifs |
| --- | --- | --- |
| Modèles | `GET /v1/models`, `GET /v1/models/:id` | `/models`, `/models/:id` |
| Compatibilité catalogue | — | `/api/v1/models`, `/api/v1/models/:id`, `/api/tags` |
| Compatibilité version | — | `/version` |
| Propriétés | `GET /v1/props` | `/props` |
| Responses | `POST /v1/responses`, `POST /v1/responses/compact` | `/responses`, `/responses/compact` |
| Responses WebSocket | upgrade `GET /v1/responses` | `/responses` |
| Chat Completions | `POST /v1/chat/completions` | `/chat/completions` |
| Anthropic Messages | `POST /v1/messages` | `/messages` |
| Realtime | `POST /v1/realtime/calls`, catalogues de voix | mêmes chemins sans `/v1` |
| Capacité | `GET /v1/capacity`, `GET /v1/capacity/events` | aucun |
| Jobs | `GET/DELETE /v1/jobs/*` | aucun |

Un chemin `/v1` inconnu est authentifié et renvoie `404` depuis Rust. Les
routes racine et de découverte listées ci-dessus sont résolues avant le
fallback et ne traversent donc pas Node. Les autres chemins hors `/v1`, dont
le dashboard et l'administration, sont relayés vers le plan de contrôle
loopback.

## Chemin d'une requête

```text
client :1455
  -> Rust/Axum
  -> limite de body, décompression et parsing
  -> authentification de l'application
  -> catalogue, alias, provider et comptes admissibles
  -> refresh OAuth éventuel
  -> acquisition d'une lease de capacité
  -> conversion et appel provider
  -> JSON, SSE ou WebSocket
  -> libération de la lease et trace native

route de contrôle non possédée
  -> Rust/Axum
  -> Node/Express :1456
```

Le store de comptes est relu avec un cache invalidé par sa date de
modification. Le catalogue est rafraîchi sous un verrou de déduplication.
L'affinité de session, lorsqu'elle est activée, est isolée par application,
session et provider, possède un TTL et une taille bornée, et oublie un compte
devenu inéligible.

## Idempotence et admission

Les requêtes JSON synchrones éligibles utilisent une clé isolée par
application et route normalisée. Une réservation atomique désigne un leader ;
les doublons en vol attendent son résultat et une réponse conservable peut
être rejouée pendant le TTL. La réutilisation de la clé avec une autre
empreinte renvoie `409`. Les statuts
`X-MultiVibe-Idempotency-Status` sont `created`, `coalesced`,
`replayed` et `bypass`.

Le cache borne les entrées, les octets, la taille d'une réponse et la durée
d'une réservation. Les flux, outils, contenus multimodaux, requêtes
conversationnelles, stockées ou en arrière-plan contournent volontairement ce
replay.

L'admission acquiert une lease par compte selon `maxConcurrent`. Elle la
conserve jusqu'à la fin réelle de la réponse, y compris lors d'un flux ou d'un
tour WebSocket, et la libère sur abandon du client. Une attente demandée par
`X-MultiVibe-Max-Wait-Ms` est bornée ; à défaut de capacité, Rust renvoie
`429 capacity_unavailable`. Les snapshots de capacité soustraient les
leases actives et comptent les waiters concernés.

## Jobs natifs

Le dispatcher Rust :

- ouvre une fenêtre batch de 22:00 à 07:00 selon `Europe/Paris` ;
- pondère les quatre priorités puis les applications de même priorité ;
- borne le nombre de jobs actifs ;
- applique les deadlines et jusqu'à trois tentatives par défaut ;
- récupère au redémarrage les jobs restés `running` ;
- conserve et rejoue jusqu'à 1 000 événements par job avec `Last-Event-ID` ;
- livre les résultats par webhook HMAC-SHA-256, sans redirect et avec backoff
  pendant une fenêtre maximale de 24 heures.

L'état courant est écrit en JSON dans `V1_EDGE_JOBS_PATH` via un fichier
temporaire et un renommage atomique. Au premier démarrage avec l'ancien
`JOBS_DB_PATH`, Rust ouvre SQLite en lecture seule, crée
`*.pre-rust-backup.sqlite`, puis importe et déduplique les jobs et
livraisons. Le runner TypeScript n'est pas démarré dans le profil natif.

## Refresh OAuth et plan de contrôle

Rust déduplique le renouvellement par compte, renouvelle un credential proche
de l'expiration et effectue au plus un refresh/retry forcé après `401`.
OpenAI, OpenCode et xAI sont pris en charge sur les chemins HTTP, Realtime et
WebSocket concernés.

La persistance reste une responsabilité du plan de contrôle, qui est l'écrivain
du store métier. Rust appelle la route interne authentifiée
`/internal/v1-edge/accounts/:id/token` avec l'ancien access token attendu.
Node applique le patch seulement si cette valeur est encore courante. En cas
de conflit, Rust relit le store et adopte le credential plus récent. Ce contrat
CAS empêche un refresh de remplacer une réauthentification administrative.

## Confidentialité, drain et modules

Le mode `confidential_verified` n'autorise que les comptes marqués avec le
même `privacyMode`. Rust vérifie l'attestation contre une politique locale,
dérive des clés distinctes pour la requête et la réponse, chiffre le payload et
authentifie la réponse. Il désactive les redirects et ne retombe jamais sur un
transport standard. Les traces excluent le body clair.

Le drain natif expose des routes internes `begin`, `status` et `resume`
protégées par le token interne. Il refuse le nouveau travail et suit les
requêtes, tours WebSocket et jobs actifs. Le contrôleur Host Node attend ces
compteurs et l'absence d'opération provider avant une mise à jour.

Les hooks JavaScript ne sont pas exécutés dans l'edge. Après le chargement du
catalogue de modules, le profil natif refuse son démarrage si un module chargé
et activé déclare des hooks. Cette barrière évite une activation où des
transformations configurées seraient ignorées.

## Configuration native

| Variable | Défaut | Usage |
| --- | --- | --- |
| `MULTIVIBE_CONTROL_PLANE` | `false` | Active le split Node loopback + edge Rust |
| `CONTROL_PLANE_PORT` | `1456` | Port Node interne |
| `V1_EDGE_HOST` | `0.0.0.0` | Adresse d'écoute Rust |
| `V1_EDGE_PORT` | `1455` | Port public Rust |
| `NODE_CONTROL_PLANE_URL` | `http://127.0.0.1:1456` | Plan de contrôle et persistance CAS |
| `V1_EDGE_BASE_URL` | `http://127.0.0.1:1455` | URL interne de l'edge |
| `V1_EDGE_INTERNAL_JOB_TOKEN` | généré par le launcher | Auth des routes internes Rust/Node |
| `V1_EDGE_JOBS_PATH` | voisin de `STORE_PATH` | Store JSON des jobs natifs |
| `JOBS_DB_PATH` | `/data/jobs.sqlite` | Source SQLite historique à sauvegarder/importer |
| `JOB_WORKER_CONCURRENCY` | `16` | Concurrence globale du dispatcher Rust |
| `MODELS_CACHE_MS` | `600000` | TTL du catalogue Rust |
| `CODEX_SESSION_AFFINITY` | `false` | Active l'affinité de session |
| `INFERENCE_IDEMPOTENCY_TTL_MS` | `300000` | Fenêtre de replay |
| `INFERENCE_IDEMPOTENCY_IN_FLIGHT_TIMEOUT_MS` | `300000` | Durée maximale d'une réservation |
| `MULTIVIBE_CONFIDENTIAL_INFERENCE_TRUST_POLICY` | vide | Politique de confiance du transport confidentiel |

Dans l'image Compose, seul `1455` est publié. Le launcher injecte le même
token interne dans les deux processus.

## Limites explicites

- La garantie confidentielle couvre Responses et Chat Completions. Messages et
  jobs confidentiels sont refusés. `stream=true` produit le format SSE après
  réception de la réponse scellée complète, sans flux progressif ; Realtime
  reste hors de cette surface vérifiée.
- La capacité a une confiance `declared` et ne garantit pas la disponibilité
  réelle du provider.
- Les routeurs TypeScript restent présents pour le profil historique
  `MULTIVIBE_CONTROL_PLANE=false`.
- Node, le provider-agent Go et les moteurs locaux restent nécessaires à leurs
  responsabilités respectives ; le produit déployé n'est pas un processus
  Rust unique.

## Validation

Depuis la branche intégrée :

```bash
cargo fmt --all -- --check
cargo check -p multivibe-v1-edge
cargo test -p multivibe-v1-edge
npm run build:api
npm test
docker compose config
```

La recette native doit vérifier qu'un serveur de contrôle simulé qui échoue sur
toute requête d'inférence n'affecte ni les routes `/v1` ni leurs alias
racine. Les mesures de charge doivent couvrir p50/p95/p99, débit, CPU, RSS,
erreurs et déconnexions du couple Rust + Node.
