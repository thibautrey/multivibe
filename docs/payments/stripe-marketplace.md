# Paiements Stripe Connect : marketplace multi-instances

Plan de réimplémentation du mécanisme Toulousecraft dans MultiVibe : chaque
personne qui installe son propre serveur peut encaisser les paiements de ses
utilisateurs via notre plateforme Stripe Connect, et nous prélevons une
commission.

Statut : proposition, aucune ligne de code de paiement n'est encore écrite.

---

## 1. Objectif

- N'importe quelle instance MultiVibe (auto-hébergée, derrière NAT, en HTTP sur
  un LAN) peut activer la facturation en quelques clics.
- L'admin de l'instance fixe ses prix (packs de crédit, éventuellement tarifs
  par modèle déjà en place), encaisse sur **son** compte Stripe Connect, et voit
  ses revenus.
- La plateforme MultiVibe garde une commission par transaction, sans jamais
  manipuler l'argent des utilisateurs finaux.
- Un membre achète du crédit depuis l'instance, paie sur Stripe Checkout, et son
  solde est crédité de façon fiable et idempotente.
- Aucune clé Stripe secrète n'est distribuée aux self-hosters.

## 2. Ce que fait Toulousecraft (référence)

Le dépôt `~/gitRepo/toulousecraft` contient un service central
`stripe-service/index.js` (Express + SDK Stripe) et un client Java.

Mécanique réellement implémentée :

1. **Compte connecté Express** créé par la plateforme pour chaque admin :
   `stripe.accounts.create({ type: "express", country: "FR", capabilities: {
   card_payments, transfers }, metadata: { admin_id } })`.
2. **Onboarding hébergé** : `accountLinks.create({ type:
   "account_onboarding", return_url, refresh_url })` ; le client ouvre l'URL
   Stripe.
3. **Checkout en destination charge** :
   `checkout.sessions.create` avec
   `payment_intent_data.application_fee_amount = amount *
   PLATFORM_FEE_PERCENT / 100` et
   `transfer_data.destination = acct_...`. L'admin reçoit le net, la plateforme
   garde la commission.
4. **Webhook global** `/webhook` en `express.raw` +
   `stripe.webhooks.constructEvent`, events `checkout.session.completed`,
   `account.updated`, `payment_intent.succeeded`.
5. **Commission globale** via `PLATFORM_FEE_PERCENT` (défaut 20).
6. **Authentification du client** par JWT signé par la plateforme.

Limites à ne pas reproduire :

- Le crédit joueur est un `TODO` dans le webhook : aucun crédit fiable.
- Le webhook n'est pas persisté, pas idempotent, pas rejouable.
- Un serveur auto-hébergé derrière NAT ne peut pas recevoir de webhook, et
  Stripe refuse les URLs de retour non HTTPS : le retour navigateur casse.
- Une seule commission globale, non snapshotée par paiement.
- Pas de remboursements, pas de litiges, pas de ledger, pas de réconciliation.
- Secrets chiffrés/obfusqués dans le client Java : sécurité par obscurité, et
  le service central détient la clé secrète de la plateforme pour tous.

## 3. Architecture cible

```
Navigateur du membre
   │  1. achat
   ▼
Instance MultiVibe (Node)  ──2. POST /checkout (HMAC)──►  Broker marketplace (notre service)
   │   ▲                                                     │  3. Checkout Session
   │   └────────────── 6. événement signé / poll ────────────┤
   │                                                         ▼
   └── 7. crédit wallet (idempotent)                    Stripe Connect
                                                             │
                                                             └── compte connecté de l'instance

Navigateur ──4. paiement──► Stripe Checkout ──5. webhook──► Broker
```

- **Instance** : source de vérité du solde utilisateur, ne détient que son
  secret d'instance. Elle ne parle jamais directement à Stripe.
- **Broker** : notre service. Crée et gère les comptes connectés (dashboard
  Express), les sessions Checkout, les commissions, les remboursements, le
  ledger des paiements et un journal d'événements par instance.
- **Stripe** : KYC, encaissement, payouts, Radar, TVA optionnelle.

Ce découpage est nécessaire parce qu'une instance peut être injoignable
(derrière NAT) et en HTTP. Le broker est le point durable ; l'instance tire les
événements.

## 4. Modèle économique

### 4.1 Type de charge : direct charges recommandées

Toulousecraft utilisait des **destination charges**. C'est le plus simple à
brancher (une seule clé, celle de la plateforme), mais ce n'est pas le bon
modèle pour une marketplace auto-hébergée :

- la plateforme est débitée des frais Stripe, des remboursements et des
  litiges, même avec `on_behalf_of` ;
- les comptes connectés ne peuvent pas gérer eux-mêmes remboursements ni
  litiges ;
- la plateforme porte les soldes négatifs ;
- la commission doit couvrir les frais de traitement, donc être artificiellement
  élevée.

Recommandé : **direct charges** sur des comptes Connect v2 configurés en
équivalent Express.

```
stripe.accounts.create({
  dashboard: "express",
  fees_collector: "stripe",        // le compte connecté paie les frais Stripe
  losses_collector: "stripe",      // Stripe porte les soldes négatifs
  requirements_collector: "stripe",
  configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
  metadata: { instance_id, platform: "multivibe" },
})
```

Puis la session Checkout est créée **sur le compte connecté**
(`stripe.checkout.sessions.create(params, { stripeAccount: acct_... })`) avec
`payment_intent_data.application_fee_amount`.

Conséquences :

- le compte connecté est marchand de règlement : relevé bancaire, TVA,
  remboursements et litiges lui appartiennent ;
- Stripe débite ses frais du compte connecté, pas du nôtre ;
- notre commission est du revenu net, sans devoir couvrir le processing ;
- les soldes négatifs et les chargebacks sont portés par Stripe
  (`losses_collector: stripe`), pas par la plateforme ;
- l'admin peut rembourser depuis son dashboard Express ou via le broker.

Formule :

```
feeCents = round(amountCents * commissionBps / 10000)
netCents = amountCents - feeCents - stripeFees   // payés par le compte connecté
```

La commission peut donc être faible (5 % par exemple) sans perte.

**Repli destination charges** si les direct charges ne sont pas disponibles
(pays non couvert, compte v1 `type=express` legacy, ou contrainte Stripe) :

- `checkout.sessions.create` sur le compte plateforme avec
  `payment_intent_data.application_fee_amount` +
  `transfer_data.destination` + `on_behalf_of` ;
- notre solde paie les frais Stripe, les remboursements et les litiges ;
- la commission minimale doit couvrir ~2,9 % + 0,30 dans la devise, sinon la
  plateforme perd de l'argent ;
- les comptes connectés ne peuvent pas rembourser : tout passe par le broker.

Le broker choisit le mode par instance (`chargeMode: "direct" | "destination"`)
et le fige à la création du compte ; il ne se mélange pas en cours de vie.

### 4.2 Alternative BYO Stripe (phase 2)

Mode `byo-stripe` : l'admin colle ses propres clés (compte Standard ou v2 dont
il est propriétaire), l'instance parle directement à Stripe, aucune commission.
Utile aux entreprises qui refusent la marketplace, et cela dérisque l'activation
du compte Connect plateforme.

### 4.3 TVA et conformité

- La vente de crédit est faite par l'admin de l'instance : sa responsabilité
  fiscale, son compte Stripe, sa TVA.
- La commission est une prestation B2B de la plateforme : à facturer par nous
  (Stripe Tax sur le compte plateforme, ou facturation annuelle).
- Le broker doit publier des CGU marketplace (interdictions, remboursements,
  litiges) et Stripe doit approuver l'usage Connect/marketplace.
- En direct charge, le compte connecté est marchand de règlement : c'est lui
  qui apparaît sur le relevé du client final.

## 5. Enrollment sans OAuth redirect (compatible NAT)

Un flux OAuth classique exige une `redirect_uri` publique HTTPS. On utilise donc
un **device code** :

1. Admin → Réglages → Paiements → « Connecter Stripe ».
2. `POST {broker}/v1/enrollments` → `{ code, verificationUrl, expiresAt }`
   (code court, 10 minutes, à usage unique).
3. L'UI affiche le code et le lien. L'admin l'ouvre sur son téléphone ou un
   autre navigateur, se connecte à son compte marketplace (email + magic link
   ou passkey, réutiliser l'identité MultiVibe Cloud), saisit le code et nomme
   l'instance.
4. L'instance interroge `GET /v1/enrollments/{code}` (ou reçoit un push SSE) et
   obtient une seule fois `{ instanceId, instanceSecret }`.
5. Le secret est stocké côté instance dans un fichier `0600` (ou un champ
   dédié du store avec permissions restrictives) ; le broker ne garde qu'un
   hash.

Variante acceptée : si l'instance a déjà une connexion MultiVibe Cloud, le
broker peut réutiliser cette identité pour pré-remplir l'étape 3.

## 6. Onboarding Stripe Connect

- `POST /v1/instances/{id}/connect/onboarding` (auth secret d'instance) :
  - crée le compte v2 si absent, avec la configuration du §4.1
    (`dashboard: "express"`, `fees_collector: "stripe"`,
    `losses_collector: "stripe"`, `requirements_collector: "stripe"`,
    capability `card_payments`), pays de l'admin, email,
    `metadata: { instance_id, platform: "multivibe" }` ;
  - crée un `accountLink` `account_onboarding`.
- `return_url` et `refresh_url` pointent vers des pages **du broker**
  (`/connect/return?instance=...`), qui affichent « Revenir à votre serveur »
  avec un deep link. Stripe ne voit jamais une URL HTTP locale.
- `GET /v1/instances/{id}/connect` renvoie
  `{ status: not_connected | pending | restricted | active, chargesEnabled,
  payoutsEnabled, requirementsDue, dashboardUrl? }`.
- `account.updated` et les événements de capability mettent à jour le broker et
  émettent un événement `connect.updated`.
- Bouton « Tableau de bord Stripe » : `accounts.createLoginLink` (Express) pour
  que l'admin voie ses paiements et payouts.
- Un compte = un pays et une devise de règlement. Changer de pays plus tard
  impose un nouveau compte : à afficher à l'onboarding.
- Vérifier avant tout checkout : `charges_enabled` et capability
  `card_payments` active.

## 7. Checkout et crédit

### 7.1 Packs définis par l'instance

```json
{
  "id": "pack_10",
  "label": "10 € de crédit",
  "amountCents": 1000,
  "currency": "EUR",
  "creditUsd": 10,
  "bonusUsd": 0
}
```

L'admin choisit une devise de vente unique par instance. Le crédit est exprimé
en USD (unité interne de MultiVibe) et fixé par pack : pas de conversion
implicite ni de taux de change caché.

### 7.2 Création de session

`POST /v1/instances/{id}/checkout` avec `Idempotency-Key` :

```json
{
  "packId": "pack_10",
  "amountCents": 1000,
  "currency": "EUR",
  "creditUsd": 10,
  "userRef": "usr_...",
  "customerEmail": "membre@example.com",
  "successUrl": "https://instance.example/billing/return",
  "cancelUrl": "https://instance.example/billing"
}
```

Le broker valide : instance active, `chargesEnabled`, devise autorisée, montant
entier dans `[minCharge, maxCharge]`, `creditUsd` positif et plafonné. Il ne
connaît pas les prix de l'instance et ne peut pas les vérifier : l'admin est le
marchand, le risque est le sien.

Stripe (mode direct, recommandé) :

- `stripe.checkout.sessions.create(params, { stripeAccount: acct_... })` ;
- `mode: "payment"`, `line_items` construits depuis le pack ;
- `client_reference_id = userRef` ;
- `payment_intent_data: { application_fee_amount: feeCents, metadata: {...} }` ;
- `success_url = {broker}/checkout/return?session_id={CHECKOUT_SESSION_ID}` ;
- le broker redirige ensuite vers le `successUrl` de l'instance en ajoutant
  `session_id`.

En mode destination (repli), la session est créée sur le compte plateforme avec
`payment_intent_data.transfer_data.destination` et `on_behalf_of` en plus.

Réponse : `{ url, sessionId, amountCents, feeCents, netCents, currency,
chargeMode, expiresAt }`.

### 7.3 Crédit fiable

- L'instance ne crédite **jamais** sur la seule redirection navigateur.
- Elle appelle `GET /v1/instances/{id}/payments/{sessionId}` ou attend
  l'événement `payment.succeeded`.
- Le crédit est idempotent : `paymentId`/`sessionId` unique dans le ledger
  local (`creditLedger`), rejouer ne double pas.
- Le crédit ajoute `creditUsd + bonusUsd` au wallet de l'utilisateur, avec une
  entrée `topup` contenant `paymentId`, montant payé, devise, commission, date.

### 7.4 Retour, expiration, abandon

- Session expirée → événement `checkout.expired` (ou statut `unpaid` au poll),
  aucun crédit.
- Paiement en attente (moyens asynchrones) → `processing`, crédit seulement à
  `paid`.
- L'instance affiche un état « paiement en cours de vérification » plutôt qu'un
  faux succès.

## 8. Événements et fiabilité

C'est le point qui manque à Toulousecraft.

- Webhooks Stripe → broker uniquement, en `raw` body,
  `stripe.webhooks.constructEvent`, avec **deux endpoints et deux secrets** :
  - « votre compte » (`connect: false`) : événements plateforme ;
  - « comptes connectés » (`connect: true`) : événements des direct charges
    (`event.account` renseigné).
- Vérifier `event.livemode` et le mettre en correspondance avec le mode de
  l'instance. Pour un objet d'un direct charge, le récupérer **en tant que
  compte connecté** (`stripeAccount: event.account`), sinon Stripe répond
  « No such… ».
- Le broker persiste chaque événement dans `stripe_events` (clé
  `stripe_event_id`, idempotence) puis dans un **outbox par instance** :
  `instance_events(instance_id, seq, type, payload, created_at)`.
- L'instance tire `GET /v1/instances/{id}/events?after={cursor}&limit=100`,
  applique chaque événement, puis avance son curseur **dans le même flush** que
  le crédit. Un doublon est ignoré par `stripeEventId`.
- Polling : au démarrage, toutes les 60 s quand la facturation est active, et
  juste après un retour de checkout. Aucun besoin d'être joignable.
- Push optionnel plus tard (SSE ou webhook sortant signé) pour la latence,
  jamais comme source unique.
- Rétention 90 jours ; au-delà, la réconciliation se fait via
  `GET /v1/instances/{id}/payments?since=`.
- Réconciliation quotidienne côté instance : sessions des 7 derniers jours
  comparées au ledger local.

Types d'événements : `payment.succeeded`, `payment.refunded`,
`payment.disputed`, `connect.updated`, `checkout.expired`.

## 9. Remboursements, litiges, chargebacks

Direct charges (recommandé) :

- `POST /v1/instances/{id}/refunds` (admin de l'instance, ou depuis son
  dashboard Express) : le broker exécute `refunds.create` sur le compte
  connecté et émet `payment.refunded`.
- La commission peut être restituée avec `refund_application_fee: true` selon
  la politique commerciale. Stripe ne le fait jamais automatiquement.
- Les litiges sont débités du compte connecté ; Stripe est responsable des
  soldes négatifs (`losses_collector: stripe`). Le broker émet
  `payment.disputed` et gèle le crédit lié.
- L'instance débite le wallet du montant crédité, clampe à 0, journalise, et
  gèle le compte si le solde devient négatif au-delà d'un seuil configurable.
- Pas de remboursement libre-service côté membre en v1 : cela permettrait de
  blanchir du crédit déjà consommé.

Destination charges (repli) :

- Les remboursements et litiges sont débités du **solde plateforme** ;
- les comptes connectés ne peuvent pas rembourser eux-mêmes : tout passe par
  le broker, qui doit surveiller son solde et suspendre les instances à risque ;
- `refund_application_fee` n'existe pas dans ce mode : la commission est
  reprise par un remboursement manuel ou une écriture d'ajustement.

## 10. Comptabilité du crédit dans MultiVibe

État actuel :

- `User.quota.creditUsd` = allocation de la période (mois/jour/total), remise à
  zéro par `rollUsagePeriod`.
- `User.usage.costUsd` = coût cumulé de la période.
- Enforcement : `user_access()` dans `rust/v1-edge/src/lib.rs` et
  `reasonsFor()` / `remainingFor()` dans `src/users.ts`.
- Le coût est enregistré par `store.recordUserUsage()` depuis le callback
  `onCompleted` de `createTraceManager` (`src/server.ts`).

Ajouts :

```ts
type CreditEntry = {
  id: string;
  kind: "allowance" | "topup" | "adjust" | "refund" | "debit";
  amountUsd: number;          // signé
  balanceAfterUsd: number;    // wallet après l'écriture
  at: number;
  actor?: string;             // admin ou "system"
  paymentId?: string;         // référence Stripe côté broker
  note?: string;
};

type User = {
  // ...
  /** Crédit acheté, persiste d'une période à l'autre. */
  walletUsd?: number;
  /** Part du coût de la période couverte par l'allocation quota. */
  usage: UserUsage & { grantedCostUsd?: number };
  /** Journal borné (500 dernières entrées). */
  creditLedger?: CreditEntry[];
};
```

Règles d'imputation dans `recordUserUsage` :

```
if quota.creditUsd === undefined:
    // crédit illimité : le wallet n'est pas débité
    usage.grantedCostUsd += cost
else:
    grantedRemaining = max(0, quota.creditUsd - usage.grantedCostUsd)
    covered          = min(cost, grantedRemaining)
    usage.grantedCostUsd += covered
    walletUsd       -= (cost - covered)
```

- Crédit illimité (`creditUsd` absent) : aucun débit du wallet, sinon un compte
  sans plafond viderait un porte-monnaie acheté sans raison.
- L'allocation de période est consommée d'abord, puis le wallet.
- `rollUsagePeriod` remet `grantedCostUsd` à 0 et **ne touche pas** au wallet.
- Une requête déjà partie ne peut pas être arrêtée en cours : le solde peut donc
  devenir négatif du coût de cette dernière requête. On ne clampe pas (ce serait
  perdre la dette réelle) ; le compte est bloqué dès que le solde est ≤ 0.
  Décision validée : le léger dépassement est autorisé et un solde négatif est
  conservé tel quel, visible dans le dashboard, jusqu'au prochain rechargement.
- Enforcement : épuisé si
  `usage.grantedCostUsd >= quota.creditUsd && walletUsd <= 0`, ou caps
  tokens/requêtes atteints.
- Compatibilité ascendante Rust : si `walletUsd` ou `grantedCostUsd` sont
  absents (ancien `accounts.json`), retomber sur le calcul actuel
  `usage.costUsd >= quota.creditUsd`.
- `POST /admin/users/:id/credit` (existant) continue d'augmenter
  `quota.creditUsd` et journalise une entrée `allowance`.
- Une édition directe du plafond dans le formulaire utilisateur est journalisée
  de la même façon (delta seulement).
- `POST /admin/users/:id/wallet` crédite ou débite le solde prépayé
  (geste commercial, remboursement), journalisé, avec note optionnelle.
- `GET /admin/users/:id/credits` renvoie `{ walletUsd, ledger }` pour l'onglet
  **Users** (solde, formulaire, huit derniers mouvements).
- Onglet membre **Credit** : `GET /admin/me` suffit, il expose déjà
  `walletUsd` et `usage.remainingCreditUsd`; aucune fuite des autres membres.
- Solde affiché au membre :
  `max(0, creditUsd - grantedCostUsd) + max(0, walletUsd)`.

Ne pas débiter `usage.costUsd` directement : il se réinitialise, donc le crédit
acheté redeviendrait dépensable à chaque période.

## 11. API du broker

Auth instance : `Authorization: Bearer <instanceSecret>` +
`X-Multivibe-Timestamp` + `X-Multivibe-Signature =
HMAC-SHA256(secret, timestamp + "." + method + path + sha256(body))`,
fenêtre de 5 minutes, `Idempotency-Key` obligatoire sur les écritures. Le
`instanceId` est toujours déduit du secret, jamais lu dans le corps.

| Méthode | Route | Rôle |
| --- | --- | --- |
| POST | `/v1/enrollments` | démarrer un device code |
| GET | `/v1/enrollments/{code}` | récupérer l'identité (une fois) |
| POST | `/v1/enrollments/{code}/claim` | approuver côté navigateur |
| GET | `/v1/instance` | nom, statut, commission, devise |
| POST | `/v1/connect/onboarding` | créer le compte v2 + lien |
| GET | `/v1/connect` | statut KYC, capabilities, dashboard |
| POST | `/v1/checkout` | créer une session Checkout (sur le compte connecté en mode direct) |
| GET | `/v1/payments/{sessionId}` | statut vérifié d'un paiement |
| GET | `/v1/payments?since=&limit=` | réconciliation |
| GET | `/v1/events?after=&limit=` | outbox signé |
| POST | `/v1/refunds` | rembourser |
| GET | `/v1/earnings` | brut, commission, net, prochains payouts |
| POST | `/v1/secret/rotate` | rotation sans downtime |

API plateforme (notre dashboard, auth opérateur) :

- lister les instances (GMV, commission, statut KYC, pays) ;
- changer `commissionBps` (snapshot par paiement, jamais rétroactif) ;
- suspendre une instance (fraude, chargebacks) ;
- voir les paiements, remboursements, litiges ;
- exports comptables.

## 12. Modèle de données du broker

Postgres recommandé ; SQLite acceptable en mono-instance.

- `platform_users(id, email, passkey…, created_at)`
- `instances(id, owner_id, name, secret_hash, status, commission_bps,
  charge_mode, default_currency, country, created_at, suspended_at)`
- `connect_accounts(instance_id, stripe_account_id UNIQUE, charge_mode,
  charges_enabled, payouts_enabled, requirements JSONB, country,
  livemode, updated_at)`
- `checkout_intents(id, instance_id, stripe_session_id UNIQUE,
  payment_intent_id, amount_cents, fee_cents, currency, credit_usd, user_ref,
  pack_id, charge_mode, livemode, status, idempotency_key UNIQUE, created_at,
  paid_at)`
- `stripe_events(stripe_event_id PK, type, payload JSONB, received_at,
  processed_at)`
- `instance_events(id BIGSERIAL, instance_id, seq, type, payload JSONB,
  created_at)` + index `(instance_id, seq)`
- `refunds(id, checkout_id, stripe_refund_id, amount_cents, reason, status,
  created_at)`
- `audit_log(actor, action, target, metadata, at)`

## 13. Modifications dans MultiVibe

### Backend Node

- `src/types.ts` : `StoreSettings.payments`, `PaymentPack`, `PaymentsSettings`,
  `User.walletUsd`, `User.creditLedger`, `CreditEntry`, `AppliedPayment`.
- `src/payments/` (nouveau) :
  - `broker-client.ts` : HTTP signé (HMAC + horodatage), vérification de la
    signature des réponses, timeouts, `Idempotency-Key`, erreurs typées.
  - `credentials.ts` : fichier `data/payments-credentials.json` en `0600`
    (instance id, secret, enrollment en cours), jamais dans `accounts.json`.
  - `service.ts` : enrollment, statut Connect, onboarding, checkout,
    synchronisation de l'outbox, crédit idempotent, remboursements,
    réconciliation quotidienne, `startPaymentsPoller` (`unref()`).
  - `signing.ts` : HMAC et comparaison à temps constant, partagés avec le
    format wire du broker.
  - `test-broker.ts` : faux broker `node:http` signé pour les tests.
- `src/routes/admin/payments.ts` : réglages, enrollment, Connect, packs,
  remboursements, revenus, synchronisation, déconnexion.
- `src/routes/billing.ts` : côté membre — solde, packs, checkout, vérification
  du retour, historique.
- `src/server.ts` : init du service, démarrage du poller, montage de
  `/admin/payments` et `/admin/billing`, arrêt propre.
- `src/store.ts` : `creditWalletFromPayment` et `refundWalletFromPayment`
  (idempotents par `paymentId`, remboursement proportionnel au crédit),
  `paymentAwards` borné, `recordUserUsage` (imputation granted/wallet).
- `src/users.ts` : `reasonsFor` / `remainingFor` incluent wallet et
  `grantedCostUsd`.
- `src/config.ts` : `MULTIVIBE_MARKETPLACE_URL` (défaut
  `https://marketplace.multivibe.cloud`, une valeur vide désactive
  l'enrollment), `MULTIVIBE_MARKETPLACE_SECRET_PATH`,
  `MULTIVIBE_MARKETPLACE_POLL_INTERVAL_MS`,
  `MULTIVIBE_MARKETPLACE_REQUEST_TIMEOUT_MS`.
- `rust/v1-edge/src/lib.rs` : `user_access` lit `walletUsd` /
  `usage.grantedCostUsd` (fallback legacy), motif `payment_required`.

### UI

- `packages/ui/src/components/tabs/BillingTab.tsx` (membre) : solde,
  consommation de la période, packs, achat, retour Stripe vérifié, historique.
- `packages/ui/src/components/tabs/PaymentsPanel.tsx` (admin) : enrollment,
  état Stripe Connect, onboarding, commission, packs (CRUD), revenus,
  remboursements, synchronisation.
- `packages/ui/src/App.tsx` : onglet membre « Credit », onglet admin
  « Payments » (groupe Advanced).
- `packages/ui/src/types.ts` : types dashboard (`DashboardMemberBilling`,
  `DashboardPaymentsOverview`, `DashboardConnectStatus`…).
- `packages/ui/src/i18n/fr/users.ts` : catalogues FR.

### Réglages

```ts
type PaymentsSettings = {
  enabled: boolean;
  brokerUrl?: string;
  instanceId?: string;
  commissionBps?: number;       // informatif, figé par le broker
  chargeMode?: "direct" | "destination";
  currency: string;
  packs: PaymentPack[];         // id, label, amountCents, currency, creditUsd, bonusUsd
  lastEventCursor?: number;
  lastSyncAt?: number;
  connect?: {
    status: "not_connected" | "pending" | "restricted" | "active";
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    requirementsDue: string[];
    accountId?: string;
    updatedAt?: number;
  };
};
```

Le secret d'instance n'est pas dans `accounts.json` : fichier
`data/payments-credentials.json` en `0600` (chemin surchargé par
`MULTIVIBE_MARKETPLACE_SECRET_PATH`).

## 14. Service broker (notre infra)

État livré :

- `services/marketplace/` dans ce dépôt (TypeScript/Express), image Docker
  multi-stage, `docker-compose.yml` dédié, store JSON mono-processus (l'adaptateur
  Postgres reste à faire).
- Pages présentes : code d'enrollment (`/enroll`), retours Connect et Checkout,
  API opérateur (`/api/*`), `GET /health`.
- Déploiement actuel : conteneur `multivibe-marketplace` sur le même hôte que
  l'instance, port `1460` en LAN, état dans `services/marketplace/data/`, secrets
  dans `services/marketplace/.env` (0600). L'instance le joint par le gateway
  Docker (`http://172.24.0.1:1460`).
- Reste à faire pour la production : nom public HTTPS
  (`marketplace.multivibe.cloud`) devant ce port pour que Stripe atteigne les
  deux webhooks, sauvegardes du store, logs sans PII.
- Dev : clés Stripe test + `stripe listen --forward-to
  localhost:PORT/webhooks/stripe` et
  `localhost:PORT/webhooks/stripe/connect`.
- Prod : deux endpoints webhook (compte + comptes connectés), clés live,
  alerte sur les événements en échec.

## 15. Sécurité

- Aucune clé Stripe chez les self-hosters ; le broker est le seul à parler à
  Stripe.
- Secret d'instance hashé (scrypt/argon2), rotation possible avec double secret
  pendant 24 h.
- HMAC + timestamp + idempotence sur chaque appel ; anti-replay.
- Jamais de crédit sur la redirection navigateur.
- Validation stricte : montants, devises autorisées, plafonds, rate limit par
  instance.
- `instanceId` déduit du secret, jamais du corps de requête.
- Logs : pas de secret, pas de PII carte (Stripe ne la transmet pas),
  `userRef` opaque.
- Le checkout exige une session membre active (CSRF déjà couvert par l'auth
  existante).
- Un admin d'instance compromis ne peut nuire qu'à son propre compte : il est
  le marchand. Un secret volé ne permet pas de créer des paiements pour une
  autre instance.
- En direct charge, le risque de solde négatif et de litige est porté par le
  compte connecté et par Stripe (`losses_collector: stripe`) ; la plateforme
  reste exposée si sa configuration est incorrecte.
- Stripe Radar s'applique au compte connecté ; nouvelles instances
  éventuellement en revue manuelle avant activation.
- Surveiller le blanchiment : packs à très forte valeur, cartes volées,
  remboursements anormaux, plusieurs instances sur la même carte.
- Ne jamais accepter un `stripeAccount` fourni par l'instance : le broker le
  résout depuis sa base.

## 16. Cas limites

- Instance hors ligne au paiement → événement conservé, crédit au prochain poll.
- Paiement réussi mais instance supprimée ou secret perdu → ledger broker
  conservé, support manuel.
- Double clic / double webhook → idempotence par `session_id`.
- Devises à zéro décimale (JPY) et minimum Stripe (~0,50) → validation.
- Remboursement partiel, litige, chargeback → wallet négatif ou gel ; en direct
  charge, le débit est sur le compte connecté.
- Changement de domaine de l'instance → URLs stockées par paiement, aucune
  dépendance.
- Rotation de secret sans downtime.
- Plusieurs admins par instance → rôles owner/admin et audit.
- Changement de commission → snapshot par paiement, jamais rétroactif.
- Test mode vs live → flag par instance, jamais mélanger les ledgers ;
  vérifier `event.livemode`.
- Compte Connect bloqué (`requirementsDue`) → checkout refusé avec un message
  clair, pas une erreur Stripe brute.
- Événement de direct charge livré dans le scope « comptes connectés » :
  toujours lire `event.account` et requêter avec `stripeAccount`.

## 17. Livraison

| Phase | Contenu | Estimation |
| --- | --- | --- |
| 0 | Décisions, compte Connect plateforme, CGU, TVA | 0,5 j + délais Stripe |
| 1 | Wallet local sans Stripe, ledger, enforcement Node/Rust, UI solde | **fait** |
| 2 | Broker MVP : device code, Connect, checkout crédit + abonnement, webhook, outbox, refunds | **fait** |
| 3 | Intégration instance : client signé, poller, routes, crédit, réconciliation | **fait** |
| 4 | Ops et durcissement : dashboard, métriques, e2e test mode, docs, i18n | 2–3 j |

Total indicatif : 11–15 jours ouvrés, hors activation Stripe Connect et
vérification d'entreprise.

La phase 1 est livrée : `walletUsd`, `usage.grantedCostUsd`, le ledger borné
`creditLedger`, l'enforcement Node et Rust (avec repli sur les anciens
enregistrements), les routes `/admin/users/:id/wallet` et
`/admin/users/:id/credits`, l'onglet **Users** (solde, crédit/débit, journal) et
un onglet membre **Credit**. Le crédit prépayé est donc utilisable dès
aujourd'hui avec des grants manuels, sans aucune dépendance Stripe.

Les phases 2 et 3 sont livrées : le broker TypeScript de
`services/marketplace` (accounts Connect v2, checkout, webhooks Stripe et
Connect, outbox signée, remboursements, litiges, revenus, idempotence) et son
intégration dans l'instance (`src/payments/`). L'instance conserve son secret
dans `data/payments-credentials.json` (0600), signe chaque appel HMAC, vérifie
la signature de chaque réponse, et crédite le wallet par `paymentId` — le même
garde-fou couvre le poller, le retour navigateur vérifié et la réconciliation
quotidienne. Les onglets admin **Payments** et membre **Credit** exposent
l'enrollment, l'onboarding Stripe, les packs, la synchronisation, les revenus,
les remboursements et l'historique des achats.

Reste avant une mise en production publique : un adaptateur SQL partagé (le
store JSON est mono-processus), une identité opérateur réelle à la place de
`MARKETPLACE_OPERATOR_TOKEN`, la vente d'abonnements depuis l'UI membre (le
broker accepte déjà `kind: subscription`), et un passage E2E complet en mode
test Stripe avec `stripe listen`.

## 18. Tests

- Unitaires : imputation granted/wallet, rollover, caps, ledger idempotent,
  signature HMAC, anti-replay, validation des montants et devises.
- Contrat : stub broker local (`node:http`) avec fixtures Stripe
  (paid / unpaid / expired / refunded / disputed) — aucun appel réseau dans
  `npm test`.
- Intégration instance + broker stub : checkout → retour → crédit, double
  livraison, panne réseau, reprise par curseur, réconciliation.
- Rust : `user_access` avec wallet, fallback legacy, message
  `payment_required`.
- E2E manuel : Stripe test mode, `stripe listen`, carte 4242, onboarding
  Express test, remboursement, litige simulé.
- Non-régression : suite existante ; les 3 échecs `decision-spark` préexistants
  restent attendus.

## 19. Décisions validées

1. **Type de compte** : compte v2 « Express » créé par notre plateforme
   (« un clic »). Standard/OAuth reste hors périmètre v1.
2. **Type de charge** : direct charges + `application_fee_amount`. L'admin de
   l'instance est marchand, paie les frais Stripe, gère litiges et
   remboursements. Destination charges + `on_behalf_of` documenté comme repli
   uniquement.
3. **Commission** : 5 % par défaut, par instance, historisée par paiement. En
   direct charge elle n'a pas à couvrir les frais Stripe ; en destination,
   prévoir une commission minimale.
4. **Produit vendu** : les deux. Crédit prépayé (phase 1, livré) et abonnements
   ou plans payants via Checkout, avec les mêmes fenêtres glissantes que les
   plans actuels.
5. **Remboursements** : admin de l'instance uniquement. Pas de libre-service
   membre, pour éviter de blanchir du crédit déjà consommé.
6. **Broker** : hébergé sur notre infra, enrollment réutilisant l'identité
   MultiVibe Cloud.
7. **Devises** : EUR par défaut, USD en option, une seule devise de vente par
   instance.

## 20. Ce qu'on ne reprend pas de Toulousecraft

- Configuration chiffrée/obfusquée dans le client distribué.
- Commission globale unique non historisée.
- Webhook non persistant et non idempotent.
- Crédit laissé en `TODO`.
- Retour navigateur comme preuve de paiement.
- Absence de remboursements, litiges, réconciliation et ledger.
