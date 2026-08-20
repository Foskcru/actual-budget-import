# Sumeria → Actual Budget · Import Web

Petite application web auto-hébergée pour importer automatiquement des relevés
**Sumeria** (ex-Lydia) dans **[Actual Budget](https://actualbudget.org/)**, compte par compte,
sans doublon — via l'API officielle d'Actual.

> Tu déposes tes relevés CSV bruts dans le navigateur → chaque fichier part dans le bon
> compte Actual. Fini les imports un par un dans l'interface d'Actual.

![License: MIT](https://img.shields.io/badge/license-MIT-green)

## Fonctionnalités

- 📥 **Glisser-déposer** de plusieurs relevés Sumeria (CSV bruts, aucun pré-traitement)
- 🏦 **Détection du compte** via la ligne `Nom du compte` du CSV (préfixe `SUM`/`BNP` toléré, singulier/pluriel accepté)
- 🔁 **Déduplication** par « Réf. interne » Sumeria → relançable sans créer de doublon
- 🧪 **Mode simulation** : voir ce qui serait importé sans rien écrire
- ♻️ **Remplacer l'existant** : réappliquer un nouveau format (supprime puis réimporte)
- 📅 Gère les **deux formats** d'export Sumeria (ancien et récent), dates `JJ/MM` → année déduite de la période
- 💶 Débits en négatif, crédits en positif ; libellé dans **Notes**, bénéficiaire laissé vide

## Déploiement (Docker / Dockge)

### Option A — image pré-construite (recommandé)

```yaml
services:
  sumeria-import:
    image: ghcr.io/VOTRE-USER-GITHUB/sumeria-actual-import:latest
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
git clone https://github.com/VOTRE-USER-GITHUB/sumeria-actual-import.git
cd sumeria-actual-import
# éditer docker-compose.yml (décommenter "build: .", remplir les variables)
docker compose up -d --build
```

Puis ouvre `http://IP-DU-NAS:8092`.

## Configuration (variables d'environnement)

| Variable | Obligatoire | Description |
|---|---|---|
| `ACTUAL_SERVER_URL` | ✅ | URL de ton serveur Actual |
| `ACTUAL_PASSWORD` | ✅ | Mot de passe du serveur Actual |
| `ACTUAL_SYNC_ID` | ✅* | ID de synchronisation du budget (*Paramètres → Avancé*) |
| `ACTUAL_BUDGET_NAME` | ✅* | Alternative à `SYNC_ID` : cibler par nom de budget |
| `ACTUAL_ALIASES` | — | JSON de correspondances de comptes, ex. `{"Anniversaire":"SUM Anniversaires"}` |
| `PORT` | — | Port interne (défaut `3000`) |
| `DATA_DIR` | — | Cache local du budget (défaut `/data`) |

\* Renseigner **`ACTUAL_SYNC_ID`** *ou* **`ACTUAL_BUDGET_NAME`**.

> ⚠️ La version de l'API (`@actual-app/api`) doit correspondre à celle de ton serveur Actual.
> Ce dépôt cible **26.8.1** — adapte `package.json` + rebuild si tu mets Actual à jour.

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
