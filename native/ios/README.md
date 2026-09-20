# MultiVibe Chat — iOS natif

Application SwiftUI pour iPhone et iPad, iOS 18 minimum, Swift 6. Le projet
Xcode est versionné : aucune installation de dépendances ni génération XcodeGen
n'est nécessaire pour l'ouvrir.

## Ouvrir et lancer

Depuis la racine du dépôt :

```sh
open native/ios/MultiVibeChat.xcodeproj
```

Choisir le schéma **MultiVibeChat**, puis un simulateur iPhone ou iPad. La dernière
validation a utilisé Xcode beta installé dans `/Applications/Xcode-beta.app` et
un simulateur iPhone 17 / iOS 27. Consulter `IMPLEMENTATION-STATUS.md` pour les
résultats exacts et les limites de validation.

Pour un appareil physique, sélectionner une équipe de développement réelle dans
Signing & Capabilities. Le dépôt ne fournit ni équipe, ni certificat, ni profil.
L'identifiant de bundle est `cloud.multivibe.chat`. La compilation simulateur ne
prouve pas les droits de signature, les liens universels ou l'exécution Siri.

## Authentification et environnement

L'application cible explicitement les services MultiVibe :

- API applicative : `https://app.multivibe.cloud` ;
- OAuth : `https://auth.multivibe.cloud` ;
- retour SSO : `https://auth.multivibe.cloud/oauth/callback/ios`.

Ces destinations sont définies dans le code ; il n'existe pas de sélecteur
serveur ou de mode démo. Ne pas supposer qu'un lancement local rend disponibles
les nouvelles routes : les modifications du backend frère `multivibe-cloud`
n'ont pas été déployées par cette tâche.

L'email/mot de passe, l'inscription, le TOTP et la récupération utilisent des
écrans natifs. Le SSO utilise la session d'authentification système, avec PKCE
et vérification d'état, et non une saisie du mot de passe fournisseur dans l'app.
Le bouton SSO générique ne garantit pas qu'Apple soit activé côté serveur.

Avant un essai réel : configurer les identifiants Apple côté backend, signer
l'application et publier l'association de domaine pour l'équipe réelle. Ne
jamais placer une clé fournisseur, une clé Apple privée ou un secret OAuth dans
l'application. Voir aussi `docs/apple-oauth-grant-retention.md` du backend.

## Raccourcis et voix

Quatre App Intents ouvrent l'application après authentification locale : nouvelle
conversation, dictée, préparation d'un brouillon et conversation vocale. Un
brouillon ou une dictée n'envoie aucun message automatiquement.

Le mode vocal implémenté est **dictée locale → relecture → Envoyer → lecture de
la réponse**. Ce n'est pas une conversation temps réel en duplex intégral.
Le chemin assistant spécial est désactivé à la compilation par défaut ; ne pas
activer `MULTIVIBE_SIDE_BUTTON_ASSISTANT` comme substitut à une autorisation,
une signature ou une vérification d'éligibilité Apple.

## Recette avant diffusion

Utiliser un compte de test autorisé et vérifier séparément :

- inscription, connexion, challenge TOTP, récupération et déconnexion ;
- retour SSO sur appareil signé, refus/annulation et changement de compte ;
- choix du modèle, réponse en streaming, interruption réseau et reprise ;
- historique local puis synchronisation explicitement acceptée, avec conflits
  depuis un second appareil sans écrasement silencieux ;
- refus d'accès au microphone, interruption audio et fonctionnement des quatre
  raccourcis sur appareil ;
- VoiceOver, grandes tailles de texte, clavier, orientation et affichage iPad.

Ces vérifications ne sont pas déclarées réussies par cette liste. La suppression
de compte, la finalisation de la révocation Apple, la validation visuelle et
physique, ainsi que la configuration de production restent ouvertes. L'état
faisant autorité est `IMPLEMENTATION-STATUS.md` : **non prêt pour publication**.

## Apple Foundation Local

The iOS app offers `apple-foundation-local` alongside the account model catalog.
It uses Apple's on-device `SystemLanguageModel` on iOS 26+ with Apple Intelligence
available and its model downloaded. The app still supports iOS 18 for remote chat.
Local inference is available without creating or signing into a MultiVibe account;
it does not send completion requests or require a valid access token. There is no
implicit remote fallback.

The native model/tool loop can search saved conversations, list/read imported
UTF-8 text documents (100 KB each), perform arithmetic, obtain the current date,
and create new local text documents that can be inspected/shared from Documents
locaux. Tool calls share a 12-call and 120-second budget. Context overflow can
restart with bounded successful tool observations twice, without resetting the
budget. Created documents are deduplicated by title and contents. This is an
app-scoped workspace, not access to arbitrary iPhone files, apps or web browsing.

History is written atomically with complete file protection and excluded from
backups. Guest storage is separate from hashed account storage. Sign-in does not
import guest data implicitly; Importer les conversations invitées copies it into
the signed-in account without deleting the guest originals. Documents remain
local; conversation text, including quotations from documents, is synchronized.

After enabling automatic history synchronization, connectivity restoration and
foregrounding trigger the existing account-scoped revision-checked history API.
Transient failures receive bounded retries. Concurrent edits require preserving
both versions explicitly; the app never silently overwrites another device.
Suspension stops local generation and retains the partial conversation/tool trace;
Réessayer explicitly restarts the request with the current local workspace.
There is no promise of continuous background inference on iOS.
