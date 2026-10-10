# Libry

Service web central de l'écosystème **holaf** : bibliothèque de documents,
recherche (locale puis web), lecture de page, crawl et capture d'écran.

Libry est l'extraction du « libraire » historiquement embarqué dans Pi-Web
(`/api/librarian/*`). Le **contrat d'API est conservé à vie** : Yuki le code en
dur, aucune route ni message d'erreur ne doit changer.

> Ce n'est **pas** une brique holaf. Les conventions communes de l'écosystème
> vivent dans `holaf-lib` ; voir [`AGENTS.md`](./AGENTS.md) pour le pointeur.

## État actuel (bibliothèque + moteur web + capture)

Prêt dans ce lot :

- Socle serveur Express, CORS par liste blanche, limitation de débit, `GET /health`.
- Contrat `/api/librarian/*` repris au caractère près (codes + messages d'erreur).
- Authentification à une seule couche : `Authorization: Bearer <clé>` **ou**
  `X-API-Key: <clé>`. `GET /api/librarian/status` est publique.
- Gestion des clés (`/api/librarian/keys`) réservée à la boucle locale ou à une
  clé marquée administrateur. Nouvelles clés `libry_…`, **clés historiques
  `lib-…` toujours valides**.
- Bibliothèque locale : index, archivage, recherche locale, lecture de document.
- **Moteur web** (`POST /search`) : cascade bibliothèque locale → WebClaw
  `/v1/search` (bascule sans erreur sur le 501) → Tavily (si configuré) → repli
  DuckDuckGo scrapé via WebClaw `/v1/scrape`. Champ `origin` sur les résultats.
- **Routes web** : `POST /fetch`, `POST /crawl|/map|/extract|/batch`
  (pass-through contrôlé), `GET /providers` (état des moteurs, sans secret).
- **Capture d'écran** : `POST /screenshot` (Chromium headless, SSRF obligatoire)
  et `GET /shot/:id.png`.
- Image Docker **publiée par GitHub Actions sur GHCR** — le `docker-compose.yml`
  la **tire** (`docker compose pull`), il ne la reconstruit pas en production.
- Documentation du contrat réel : [`docs/api.md`](./docs/api.md).

À venir : `POST /update` (scan local + archivage), puis bascule de Pi-Web en client.

## Démarrage

```bash
npm install
cp .env.example .env      # adapter si besoin
npm run dev               # tsx watch (défaut : 0.0.0.0:3007)
```

## Scripts

| Script | Rôle |
| --- | --- |
| `npm run dev` | Serveur en développement (`tsx watch`). |
| `npm run build` | Compilation TypeScript vers `dist/`. |
| `npm start` | Démarre le serveur compilé (`node dist/index.js`). |
| `npm test` | Tests (vitest). |
| `npm run typecheck` | Vérification de types sans émission. |

## Déploiement (serveur)

En production, Libry **ne se reconstruit pas sur le serveur** : il **tire**
l'image que GitHub Actions a construite, testée et publiée sur GHCR
(`ghcr.io/grokuku/libry`). L'**ordre** des étapes est important :

1. **Pousser le code sur GitHub** (`main`). Le workflow `ci.yml` construit et
   publie une image de test (`:test`, `:sha-<court>`).
2. **Lancer la release** : onglet *Actions* → *Release image* → *Run workflow*.
   `release.yml` publie `ghcr.io/grokuku/libry:0.1.0` (version lue dans
   `package.json`) + `:latest`. ⚠️ **Tant que cette étape n'a pas été faite, le
   tag `0.1.0` n'existe pas sur GHCR** : `docker compose pull` échouerait, car
   aucun tag ne peut exister sans qu'un workflow l'ait publié. Pour démarrer
   avant la première release, utiliser `:test` (publié par la CI à chaque push
   sur `main`) dans `docker-compose.yml`.
3. **Sur le serveur**, tirer l'image publiée puis relancer le service :

   ```bash
   docker compose pull   # télécharge l'image de GHCR — ne compile rien
   docker compose up -d
   ```

Tags disponibles (une seule ligne à changer dans `docker-compose.yml`) :

| Tag | Ce qu'il suit | Quand l'utiliser |
| --- | --- | --- |
| `:0.1.0` (épinglé, utilisé) | La version `0.1.0`, figée. | Déploiement stable ; aucune mise à jour surprise. |
| `:latest` | La dernière release. | Suivre les releases sans changer le compose. |
| `:test` | La dernière CI de `main`. | Tester un correctif fraîchement poussé. |
| `:sha-<court>` | Un commit précis. | Traçabilité / retour en arrière. |

Pour mettre à jour plus tard : relancer *Release image* (publiée sous le
nouveau numéro de version), puis changer le numéro dans le compose et faire
`docker compose pull && docker compose up -d`.

Le paquet GHCR est **public** aujourd'hui (téléchargement possible sans
compte — vérifié). S'il devient privé, s'authentifier une fois sur le serveur
avec un jeton ayant la permission `read:packages` :

```bash
echo "<jeton>" | docker login ghcr.io -u <utilisateur> --password-stdin
```

### Développement local : reconstruire l'image

`docker compose build` est réservé au **développement** : dans
`docker-compose.yml`, commenter la ligne `image:` et décommenter `build:` —
l'image est alors construite sur la machine. Le serveur, lui, reste sur
`docker compose pull`.

## Configuration

Toutes les variables propres à Libry sont préfixées `LIBRY_*` (voir
`.env.example`). `CHROMIUM_PATH` et `WEBCLAW_*` restent neutres (contrat
inter-services).

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `LIBRY_HOST` | `0.0.0.0` | Interface d'écoute. |
| `LIBRY_PORT` | `3007` | Port (Pi-Web 3000/3005, WebClaw 3006). |
| `LIBRY_DATA_DIR` | `/app/data` | Répertoire de données persistant. |
| `LIBRY_DOCS_DIR` | `$LIBRY_DATA_DIR/docs` | Bibliothèque (index + documents). |
| `LIBRY_KEYS_FILE` | `$LIBRY_DATA_DIR/libry-keys.json` | Fichier des clés API. |
| `LIBRY_ALLOWED_ORIGINS` | *(vide)* | Origines CORS autorisées (séparées par des virgules). |
| `LIBRY_RATE_LIMIT_PER_MIN` | `600` | Requêtes/minute/IP. |
| `LIBRY_LOG_LEVEL` | `info` | Niveau de journalisation. |
| `LIBRY_LEGACY_KEYS` | *(vide)* | Clés historiques `lib-…` acceptées hors fichier de clés. |
| `LIBRY_ADMIN_KEYS` | *(vide)* | Clés marquées administrateur. |
| `LIBRY_UPDATE_CWDS` | *(vide)* | Liste blanche de chemins pour `POST /update`. |
| `WEBCLAW_URL` | `http://localhost:3001` | URL de WebClaw (compose : `http://webclaw:3000`). |
| `WEBCLAW_API_KEY` | *(vide)* | Clé WebClaw (secret, en-tête Bearer). |
| `LIBRY_TAVILY_API_KEY` | *(vide)* | Clé Tavily (secret, 2e étage de la cascade). |

## Structure

```
src/
  index.ts                 # serveur Express + /health + montage /api/librarian
  config.ts                # lecture des variables LIBRY_*
  library-store.ts         # stockage, recherche locale, archivage, types
  libry-auth.ts            # modèle de clés (hash scrypt, legacy, admin)
  webclaw.ts               # client WebClaw (config + endpoints REST)
  tavily.ts                # client Tavily (config + recherche)
  web-search.ts            # cascade de recherche web (branchée sur library-store)
  screenshot.ts            # capture Chromium headless
  shot-queue.ts            # concurrence bornée des captures
  shot-store.ts            # persistance PNG + méta (TTL)
  middleware/
    auth.ts                # Bearer OU X-API-Key
    admin-only.ts          # boucle locale OU clé admin
  routes/
    librarian.ts           # contrat /api/librarian/*
    web.ts                 # /fetch, /crawl, /map, /extract, /batch, /providers
    screenshot.ts          # /screenshot, /shot/:id.png
  utils/
    secret-hash.ts         # scrypt (copie Pi-Web)
    request-identity.ts    # détection loopback non forgeable
    ssrf.ts                # validation SSRF des URL appelantes
    http.ts                # indirection fetch (mocks de test)
tests/                     # contrat, auth, bibliothèque, moteur web, routes web, capture
docs/api.md                # contrat d'API réel
```
