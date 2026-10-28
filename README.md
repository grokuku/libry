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
  `X-API-Key: <clé>` — au moins une des deux valide suffit (un `Bearer` inconnu
  ne bloque pas une `X-API-Key` valide). `GET /api/librarian/status` est publique.
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
| `npm run check:vendor` | Empreintes des briques holaf vendorisées (CI, hors réseau). |

## Interface web & briques holaf-lib

`public/` — l'interface (vanilla, servie sans build) — consomme cinq briques de
holaf-lib, copiées **verbatim** par le CLI de la librairie dans
`public/vendor/holaf/` :

| Brique | Rôle côté Libry | Version pinnée |
| --- | --- | --- |
| `tokens` | SEULE à poser les variables `--holaf-*` ; `styles.css` les aliase avec repli hex | 0.6.0 |
| `icons` | icônes SVG (bascule clair/sombre) | 0.1.6 |
| `modal` | modale autonome (CSS extrait en fichier) | 0.7.0 |
| `toast` | notifications (CSS extrait en fichier) | 0.8.0 |
| `fetch` | client HTTP | 0.2.0 |

Source de vérité : `/projects/holaf-lib` — ne JAMAIS éditer
`public/vendor/holaf/*.js` à la main.

### Procédure d'upgrade d'une brique

1. `printf 'y\n' | /projects/holaf-lib/scripts/holaf upgrade <brique> /projects/Libry/public`
   (le CLI cible toujours `<DEST>/vendor/holaf`).
2. `node scripts/extract-holaf-css.mjs` — ré-extraie `holaf-modal.css` /
   `holaf-toast.css` via `getCss()` (le CLI ne copie jamais les CSS).
3. `node scripts/generate-holaf-checksums.mjs` — refige les empreintes SHA-256.
4. `npm run check:vendor` puis `npm test`. La CI exécute `check:vendor` : le
   CLI holaf n'existe pas sur GitHub, ces empreintes sont l'invariant.

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

   ⚠️ Configurer aussi le `.env` **du serveur** (fichier gitignoré, non livré avec
   le dépôt — modèle dans `.env.example`) : au minimum `WEBCLAW_API_KEY` (sans
   elle, `POST /search` ne renvoie plus rien côté web : les appels WebClaw
   répondent 401 et le journal le trace) et, pour que les captures d'écran
   fonctionnent sous Docker, `LIBRY_CHROMIUM_NO_SANDBOX=true` (voir
   `docs/api.md` §Capture d'écran pour le compromis de sécurité).

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
| `LIBRY_SSRF_ALLOWED_HOSTS` | *(vide)* | **Noms d'hôtes du réseau interne** que Libry a le droit d'atteindre (ex. `switchy,pi-web,*.holaf.lan`). Vide = aucune adresse interne (protection anti-SSRF). Éditable dans l'interface, onglet **Réglages → Adresses internes autorisées**. |
| `LIBRY_SSRF_ALLOWED_CIDRS` | *(vide)* | **Plages d'adresses** autorisées (ex. `10.10.0.0/16,192.168.1.20/32`). Éditable dans l'interface. |
| `WEBCLAW_URL` | `http://localhost:3001` | URL de WebClaw (compose : `http://webclaw:3000`). |
| `WEBCLAW_API_KEY` | *(vide)* | Clé WebClaw (secret, en-tête Bearer). **Requise pour la recherche web** : sans elle, `/v1/*` répond 401 et `/search` reste silencieusement vide côté web (le journal serveur l'indique). |
| `LIBRY_TAVILY_API_KEY` | *(vide)* | Clé Tavily (secret, 2e étage de la cascade). |
| `LIBRY_CHROMIUM_NO_SANDBOX` | `false` | `true` = Chromium lancé **sans sandbox**. Nécessaire sous Docker (seccomp par défaut interdit les namespaces du sandbox) — compromis détaillé dans `.env.example`. |

## Dépannage

Journal du service : `docker compose logs libry` (Libry ne renvoie au client que
des messages génériques ; la cause réelle est **toujours** journalisée).

### Adresses internes (anti-SSRF)

Par défaut, Libry **refuse toute adresse interne** (loopback, RFC1918 `10/8`,
`172.16/12`, `192.168/16`, CGNAT `100.64/10`, ULA `fc00::/7`) et toute adresse
lien-local (`169.254.0.0/16`, dont les métadonnées cloud `169.254.169.254`).

Pour autoriser **certaines** cibles internes, utilisez l'onglet **Réglages →
Adresses internes autorisées** (aucune édition de fichier nécessaire) :

- **Noms d'hôtes** (recommandé) : `switchy`, `pi-web`, `nas.lan`, `*.holaf.lan`.
  Un nom autorisé ne peut résoudre que vers une adresse **interne** ; s'il se met
  à résoudre vers Internet, la cible est refusée (garde anti DNS-rebinding). Pour
  la capture d'écran, la résolution validée est **épinglée**
  (`--host-resolver-rules`).
- **Plages CIDR** : `10.10.0.0/16`, `192.168.1.20/32`. Une plage ouvre **toutes**
  les adresses qu'elle contient — à réserver aux cas où le nom ne suffit pas.

Protections **jamais** désactivées, même avec une liste large : `file://`,
identifiants dans l'URL, adresses lien-local/métadonnées cloud, et redirections
vers une adresse non autorisée. Chaque autorisation utilisée est journalisée
(`[ssrf] internal access allowed route=… host=… ip=… via=…`, jamais l'URL
complète) et visible dans l'interface (« Autorisations utilisées récemment »).

| Symptôme | Cause réelle | Action |
| --- | --- | --- |
| `POST /search` → `{"results":[],"archived":false}` avec au journal `[web-search] ... (HTTP 401)` | `WEBCLAW_API_KEY` absente ou fausse dans le conteneur | renseigner la clé dans le `.env` du serveur, puis `docker compose up -d`. Vérifier avec `GET /api/librarian/providers` (`webclaw.apiKey` doit valoir `true`). |
| `POST /screenshot` → `{"error":"Screenshot capture failed"}` en moins d'une seconde, journal `[screenshot] capture failed: Screenshot failed (...): No usable sandbox! ...` | sandbox Chromium impossible dans un conteneur Docker par défaut (seccomp refuse `unshare`/namespaces ; l'image n'embarque pas de helper SUID) | `LIBRY_CHROMIUM_NO_SANDBOX=true` **ou** décommenter `security_opt: seccomp=unconfined` dans `docker-compose.yml` (garde alors le sandbox interne de Chromium). |
| `/search` vide web compris alors que la clé WebClaw est valide | WebClaw `/v1/search` répond 501 sans `SERPER_API_KEY` ; Tavily non configuré ; le repli DuckDuckGo, lui, fonctionne via `/v1/scrape` | aucun correctif Libry ; poser `SERPER_API_KEY` sur WebClaw (machine à part) ou une clé Tavily pour la recherche directe |
| Une recherche **d'un seul mot** ne trouvait rien localement | seuil hérité exigeant ≥ 2 correspondances | corrigé (≥ 1 correspondance pour un terme unique) |

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
