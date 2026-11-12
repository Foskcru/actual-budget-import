# Sumeria → Actual Budget · Import Web

Petite application web auto-hébergée pour importer automatiquement des relevés
**Sumeria** (ex-Lydia) dans **[Actual Budget](https://actualbudget.org/)**, compte par compte,
sans doublon — via l'API officielle d'Actual.

> Tu déposes tes relevés CSV bruts dans le navigateur → chaque fichier part dans le bon
> compte Actual. Fini les imports un par un dans l'interface d'Actual.

![License: MIT](https://img.shields.io/badge/license-MIT-green)

## Fonctionnalités

- 🔐 **Comptes utilisateurs** (login/mot de passe, base SQLite) + **réglages Actual dans l'UI**
- 📥 **Glisser-déposer** de plusieurs relevés Sumeria (CSV bruts, aucun pré-traitement)
- 🏦 **Détection du compte** via la ligne `Nom du compte` du CSV (préfixe `SUM`/`BNP` toléré, singulier/pluriel accepté)
- 🔁 **Déduplication** par « Réf. interne » Sumeria → relançable sans créer de doublon
- 🧪 **Mode simulation** : voir ce qui serait importé sans rien écrire
- ♻️ **Remplacer l'existant** : réappliquer un nouveau format (supprime puis réimporte)
- 📅 Gère les **deux formats** d'export Sumeria (ancien et récent), dates `JJ/MM` → année déduite de la période
- 💶 Débits en négatif, crédits en positif ; **bénéficiaire** extrait proprement du libellé (commerçant), libellé complet conservé dans **Notes**
- 🏷️ **Catégorisation auto** : bouton pour créer un jeu de règles de départ, appliqué à chaque import
- 💡 **Suggestions de catégories** : pour les opérations sans catégorie, propose une catégorie d'après **ton historique** (même bénéficiaire, même libellé, mots proches), puis, en option, d'après une **IA locale installée sur ton PC** (Ollama / LM Studio). Tu valides, et tu peux transformer un choix en **règle Actual**.

## Déploiement (Docker / Dockge)

### Option A — image pré-construite (recommandé)

```yaml
services:
  sumeria-import:
    image: ghcr.io/foskcru/actual-budget-import:latest
    container_name: sumeria-import
    restart: unless-stopped
    ports:
      - "8092:3000"
    environment:
      ACTUAL_SERVER_URL: "https://actual.exemple.tld"
      ACTUAL_PASSWORD:   "motdepasse"
      ACTUAL_SYNC_ID:    "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
    volumes:
      - ./data:/data
```

### Option B — build local

```bash
git clone https://github.com/foskcru/actual-budget-import.git
cd actual-budget-import
# éditer docker-compose.yml (décommenter "build: .", remplir les variables)
docker compose up -d --build
```

Puis ouvre `http://IP-DU-NAS:8092`.

## Comptes & configuration (multi-utilisateurs)

- **1ʳᵉ visite** : création du **compte administrateur** (identifiant + mot de passe).
- Connexion obligatoire pour accéder à l'app.
- **Chaque utilisateur a sa PROPRE config Actual** (URL serveur, mot de passe, ID de synchro, chiffrement) via sa page **Paramètres** → il importe **dans son propre budget, isolé des autres**.
- L'admin peut créer **d'autres comptes** utilisateurs (chacun configure ensuite le sien).

Utilisateurs et réglages (par utilisateur) sont stockés dans une base **SQLite** (`app.db`) dans le volume `/data` — **pense à le persister**.

### Variables d'environnement (toutes optionnelles)
Elles servent seulement de **valeurs par défaut** au tout premier démarrage (pratique pour pré-remplir). Ensuite tout se gère dans l'UI.

| Variable | Description |
|---|---|
| `ACTUAL_SERVER_URL` | URL du serveur Actual (défaut de réglage) |
| `ACTUAL_PASSWORD` | Mot de passe du serveur Actual |
| `ACTUAL_SYNC_ID` | ID de synchronisation du budget (*Paramètres → Avancé*) |
| `ACTUAL_BUDGET_NAME` | Alternative à `SYNC_ID` : nom de budget |
| `ACTUAL_E2E_PASSWORD` | Mot de passe de chiffrement (budget *end-to-end encrypted*) |
| `ACTUAL_ALIASES` | JSON de correspondances, ex. `{"Anniversaire":"SUM Anniversaires"}` |
| `PORT` | Port interne (défaut `3000`) |
| `DATA_DIR` | Dossier de données : DB + cache budget (défaut `/data`) |
| `APP_SECRET` | **Recommandé** : clé qui chiffre les mots de passe Actual stockés en base (AES-256-GCM). À garder secrète, hors du volume `/data`. Sans elle, stockage en clair. |
| `COOKIE_SECURE` | `true` si l'app est servie en **HTTPS** (cookie `Secure` + HSTS). Laisser `false`/absent en HTTP local. |
| `NTFY_URL` | Optionnel : URL d'un topic **ntfy** pour être alerté quand un compte se bloque (8 échecs). |
| `NTFY_TOKEN` | Optionnel : jeton d'authentification ntfy (si le topic est protégé). |
| `AI_CONNECT_SRC` | Optionnel : adresses d'IA **en plus de `localhost`** que le navigateur a le droit d'appeler (CSP), séparées par des espaces. Ex. `http://192.168.1.20:11434` si l'IA tourne sur un autre PC du réseau. |

### Résumé sécurité
- Auth par session (scrypt + cookie `HttpOnly`/`SameSite=Lax`), rate-limiting des connexions, en-têtes CSP/anti-clickjacking.
- Mots de passe Actual **chiffrés au repos** si `APP_SECRET` est défini.
- Voir `../RAPPORT-SECURITE.md` pour l'analyse complète.

> ⚠️ La version de l'API (`@actual-app/api`) doit correspondre à celle de ton serveur Actual.
> Ce dépôt cible **26.11.0** — adapte `package.json` + rebuild si tu mets Actual à jour.

## Suggestions de catégories & IA locale

Carte **« Suggestions de catégories »** → **Analyser** : l'app lit les opérations déjà classées de ton budget
(24 mois), apprend tes habitudes et propose une catégorie pour chaque opération **sans catégorie** (ou rangée
dans le garde-fou « À vérifier »). Rien n'est écrit avant **« Appliquer la sélection »**. Les suggestions sûres
(≥ 80 %) sont cochées d'office.

**L'IA apprend de tes choix** : chaque catégorie validée rejoint l'historique, qui sert à la fois au moteur
de suggestions et d'**exemples** donnés à l'IA (ses opérations les plus proches dans *ton* historique).
Pas de réentraînement du modèle : c'est inutile ici, et ça tournerait mal sur un PC ordinaire.
Case **« Règle → créer »** : ajoute un mot-clé à la règle de la catégorie dans Actual, ce qui classe les prochaines opérations dès l'import.

**IA locale (facultative, sur le PC de chaque utilisateur, pas sur le NAS)** : c'est le navigateur qui
interroge l'IA à `http://localhost:11434`. Tes opérations ne quittent pas ton réseau.
1. Installe [Ollama](https://ollama.com/download), puis `ollama pull qwen2.5:3b` (≈ 2 Go, 8 Go de RAM suffisent).
2. Autorise l'app : `setx OLLAMA_ORIGINS "https://adresse-de-l-app"` (Windows), puis quitte et relance Ollama.
3. Dans l'app : **Paramètres → IA locale → Tester → choisir le modèle → Enregistrer**.
4. Carte Suggestions : **« 🤖 Demander à l'IA locale »** (traite ce que l'historique ne sait pas classer).

LM Studio marche aussi (serveur local, *Enable CORS*, adresse `http://localhost:1234`).

**« C'est quoi ? » (commerçants inconnus)** : sous chaque opération, un champ décrit le commerçant
(ex. *« Camargue Glaco : glacier à Aigues-Mortes »*). Il est rempli par ton IA à partir d'une **recherche web**
faite depuis le NAS (DuckDuckGo sans clé par défaut, **Brave Search** si tu mets une clé dans Paramètres → IA locale),
ou à la main. Une seule recherche par commerçant (cache). Seul le **nom nettoyé** du commerçant part sur internet
(`SUMUP *`, `PAYPAL *`, numéros… retirés) — jamais un montant, une date ou un compte.

Les propositions de l'IA ne sont **jamais cochées d'office** (sa « confiance » n'est pas fiable) ; les **virements
internes** probables (« Virement interne », porte-monnaie, livret…) sont signalés à part : à relier comme virement dans Actual.

## Sécurité

Cette page peut **écrire dans ton budget**. Ne l'expose pas en public sans protection :
garde-la en accès local / VPN, ou place une authentification (Authelia, mot de passe
du reverse-proxy…) devant le sous-domaine.

## Comment ça marche

1. Le CSV est analysé côté serveur (compte, dates, montants, réfs).
2. L'app se connecte à Actual via `@actual-app/api`, ouvre le budget (`downloadBudget`).
3. Pour chaque fichier, elle trouve le compte correspondant et appelle `importTransactions`
   (déduplication native par `imported_id` = Réf. interne Sumeria).

## Licence

MIT — voir [LICENSE](LICENSE).
