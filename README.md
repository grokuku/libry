# Libry

Service web central de l'écosystème **holaf** : bibliothèque de documents,
recherche et, à terme, lecture de page, crawl et capture d'écran.

Libry est l'extraction du « libraire » historiquement embarqué dans Pi-Web
(`/api/librarian/*`). Le **contrat d'API est conservé à vie** : Yuki le code en
dur, aucune route ni message d'erreur ne doit changer.

> Ce n'est **pas** une brique holaf. Les conventions communes de l'écosystème
> vivent dans `holaf-lib` ; voir [`AGENTS.md`](./AGENTS.md) pour le pointeur.

## État actuel (fondations + bibliothèque)

Prêt dans ce lot :

- Socle serveur Express, CORS par liste blanche, limitation de débit, `GET /health`.
- Contrat `/api/librarian/*` repris au caractère près (codes + messages d'erreur).
- Authentification à une seule couche : `Authorization: Bearer <clé>` **ou**
  `X-API-Key: <clé>`. `GET /api/librarian/status` est publique.
- Gestion des clés (`/api/librarian/keys`) réservée à la boucle locale ou à une
  clé marquée administrateur. Nouvelles clés `libry_…`, **clés historiques
  `lib-…` toujours valides**.
- Bibliothèque locale : index, archivage, recherche locale, lecture de document.
- Documentation du contrat réel : [`docs/api.md`](./docs/api.md).

Lots ultérieurs : recherche web (WebClaw/Tavily), crawl, capture d'écran,
image Docker / compose, bascule de Pi-Web en client.

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

## Structure

```
src/
  index.ts                 # serveur Express + /health + montage /api/librarian
  config.ts                # lecture des variables LIBRY_*
  library-store.ts         # stockage, recherche locale, archivage, types
  libry-auth.ts            # modèle de clés (hash scrypt, legacy, admin)
  middleware/
    auth.ts                # Bearer OU X-API-Key
    admin-only.ts          # boucle locale OU clé admin
  routes/
    librarian.ts           # contrat /api/librarian/*
  utils/
    secret-hash.ts         # scrypt (copie Pi-Web)
    request-identity.ts    # détection loopback non forgeable
tests/                     # contrat, auth, bibliothèque
docs/api.md                # contrat d'API réel
```
