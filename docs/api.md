# Contrat d'API — Libry

Préfixe **`/api/librarian/*`**, conservé à vie (Yuki le code en dur). Codes HTTP
et messages d'erreur sont **figés** et repris au caractère près de Pi-Web.

Base par défaut : `http://<hôte>:3007`.

## Authentification

- `GET /api/librarian/status` : **publique**, aucune clé.
- Toutes les autres routes : clé obligatoire, fournie indifféremment par
  - `Authorization: Bearer <clé>`, ou
  - `X-API-Key: <clé>`.
- Clé absente ou invalide → `401` `{ "error": "Invalid or missing API key" }`.
- Nouvelles clés : `libry_` + 32 caractères hexadécimaux. Les clés historiques
  `lib-…` restent valides.

## Routes

### `GET /health` (hors préfixe)

Liveness, aligné sur WebClaw.

```json
{ "service": "libry", "status": "ok", "version": "0.1.0" }
```

### `GET /api/librarian/status` — publique

```json
{ "totalDocs": 0, "lastUpdated": "", "lastScan": "" }
```

### `GET /api/librarian/library` — clé requise

Renvoie l'index complet.

```json
{
  "lastUpdated": "2026-10-09T20:00:00.000Z",
  "lastScan": "",
  "library": [
    {
      "name": "webclaw",
      "version": "0.6.23",
      "type": "tool",
      "description": "…",
      "filePath": "tools/webclaw@0.6.23.json",
      "keywords": ["webclaw", "…"],
      "updatedAt": "2026-10-09T20:00:00.000Z",
      "sourceUrl": "https://example.com"
    }
  ]
}
```

### `POST /api/librarian/search` — clé requise

Corps : `{ "query": "..." }`.

Réponse : `{ "results": [ { "title", "url", "snippet", "content?", "origin" } ], "archived": false }`.

- `400` si `query` absent : `{ "error": "Missing 'query' in body" }` (verbatim).
- `origin` (champ additif) : `"local"` pour un résultat de la bibliothèque,
  `"web"` pour un résultat du web. Les clients qui l'ignorent ne cassent pas.

**Cascade réelle** (identique à Pi-Web), dans cet ordre :

1. **Bibliothèque locale** (`searchLocalDocs`) — si ≥ 1 document local correspond,
   on renvoie **uniquement** le local : **aucun appel réseau** n'est effectué.
   Le seuil exige **1 correspondance** pour une requête à un seul terme
   (4+ lettres) et ≥ 2 termes (ou 50 %) au-delà — une requête mono-mot comme
   `docker` peut donc matcher le doc `docker`.
2. **WebClaw `/v1/search`** — en self-hosted sans `SERPER_API_KEY`, l'endpoint
   répond **501** : Libry **détecte le 501 et bascule sans erreur**.
3. **Tavily** — si une clé Tavily est configurée (`LIBRY_TAVILY_API_KEY` ou
   `$LIBRY_DATA_DIR/tavily-config.json`).
4. **Repli DuckDuckGo** — la page HTML de résultats DDG est **scrapée via
   WebClaw `/v1/scrape`**, puis les **3 premiers** résultats sont scrapés et
   renvoyés avec `content` **≤ 5000 caractères**.

- ⚠️ **Correction d'une erreur de la doc historique de Pi-Web**
  (`docs/librarian-api.md`) : celle-ci affirmait « pas de scraping en /search,
  `content` absent ». **C'est FAUX.** Le repli DuckDuckGo **scrape réellement**
  les pages et **renvoie `content`** (jusqu'à 5000 caractères par résultat). Le
  comportement réel est conservé ici ; la doc décrit désormais ce qui se passe.
- Le moteur est branché sur la bibliothèque via `setWebSearchProvider`
  (`src/web-search.ts`) : un miss local déclenche la cascade ci-dessus. Si tous
  les moteurs sont indisponibles, la route répond `200` avec `results: []`
  (jamais d'exception). ⚠️ **Clé WebClaw absente/fausse** : chaque appel
  `/v1/*` répond `401` — la cascade entière (search, Tavily absent, repli DDG
  via `/v1/scrape`) tombe alors et `results` est vide ; le journal serveur le
  trace (`[web-search] WebClaw search unavailable: WebClaw request failed
  (HTTP 401)` puis `DuckDuckGo fallback failed: ... (HTTP 401)`). Vérifier
  `GET /providers` → `webclaw.apiKey`.

### `GET /api/librarian/doc/:name?version=` — clé requise

Renvoie le contenu du document. `404` `{ "error": "Doc not found" }` si absent.

```json
{
  "meta": { "name": "webclaw", "version": "0.6.23", "type": "tool", "updatedAt": "…" },
  "summary": "…",
  "keyPoints": ["…"],
  "api": [{ "signature": "…", "description": "…" }],
  "examples": [{ "title": "…", "code": "…" }],
  "breakingChanges": [],
  "rawContent": "…"
}
```

### `POST /api/librarian/archive` — clé requise

Archive un document fourni par un agent externe.

Corps minimal : `{ "name", "version", "content" }` (`content` obligatoire).

- `400` si champ manquant :
  `{ "error": "Missing required fields: name, version, content" }` (verbatim).
- `400` si `name` ou `version` contient `/`, `\`, `..` (ou est vide) :
  `{ "error": "name and version must be valid path components (no slashes, no backslashes, no '..')" }` (verbatim).
- Succès : `201` `{ "success": true, "entry": { … } }`.

### `POST /api/librarian/update` — clé requise

Corps optionnel : `{ "cwds": string[] }` (liste blanche de chemins).

- Aucune liste configurée (ni corps, ni `LIBRY_UPDATE_CWDS`) → `501`
  `{ "error": "Library update is not configured (set LIBRY_UPDATE_CWDS or pass {cwds:[...]})" }`.
- ⚠️ **Aucune synthèse LLM dans Libry** : la rédaction intelligente reste chez
  les clients. Libry peut scanner et récupérer le brut, jamais appeler un LLM.
- Dans ce lot, le moteur de scan/crawl n'est pas branché : avec une liste
  configurée, la route répond `501`
  `{ "error": "Library update engine is not available yet (web/crawl lot pending)", "cwds": [...] }`.

### `GET /api/librarian/keys` — admin

Réservé à la **boucle locale** ou à une **clé administrateur**. Renvoie les
identifiants **non secrets** :

```json
{ "keys": [ { "id": "libryk_ab12cd34ef56", "name": "yuki", "createdAt": "…", "key": "libry_abc12345…" } ] }
```

### `POST /api/librarian/keys` — admin

Corps : `{ "name": "..." }`. `400` `{ "error": "name is required" }` si nom
absent. Succès `201` : renvoie la clé **complète, une seule fois**
(`{ id, name, createdAt, keyPreview, keyHash?, key }`).

### `DELETE /api/librarian/keys/:id` — admin

Révoque par identifiant non secret. `404` `{ "error": "Key not found" }` si
inconnu, sinon `{ "success": true }`.

## Accès admin

`/keys` accepte :

- une requête issue de la boucle locale — adresse **réelle** de la socket TCP
  (`127.0.0.0/8`, `::1`, `::ffff:127.0.0.1`), jamais `X-Forwarded-For` (non
  forgeable) ;
- une clé valide marquée administrateur (`LIBRY_ADMIN_KEYS`, ou champ `admin`
  du fichier de clés).

Sinon → `403`
`{ "error": "Key management is only available from localhost or an admin key" }`.

## Stockage & permissions

- Index et documents : `LIBRY_DOCS_DIR` (`index.json`, `tools/<name>@<version>.json`).
- Clés : `LIBRY_KEYS_FILE` (`libry-keys.json`), secrets **hachés scrypt** (jamais
  en clair). Fichier `0600`, répertoire `0700`.
- Libry n'écrit que dans `LIBRY_DATA_DIR` ; il ne touche jamais aux données de
  Pi-Web.

## Capture d'écran (Lot 5)

Routes sous `/api/librarian`, **clé requise**. Chromium headless lancé
directement (aucun Puppeteer/Playwright).

### `POST /api/librarian/screenshot`

Corps : `{ "url": "https://example.com", "width?": 1440, "height?": 900, "timeoutMs?": 15000, "inline?": false }`.

Succès `200` :

```json
{ "id": "<uuid>", "mimeType": "image/png", "width": 1440, "height": 900, "bytes": 50662, "url": "https://example.com/", "origin": "web" }
```

Erreurs (messages stables) :

- `400` `{ "error": "Missing 'url' in body" }` — aucune cible.
- `400` `{ "error": "Invalid URL" }` — URL malformée, non résolvable, ou schéma
  autre que http/https (`file://`/`ftp://` compris).
- `400` `{ "error": "Inline HTML capture is disabled" }` — `inline: true` alors
  que `LIBRY_SHOT_INLINE_HTML` n'est pas `true` (défaut).
- `403` `{ "error": "URL not allowed" }` — cible bloquée par la protection SSRF
  (loopback, privée, lien-local/métadonnées cloud, tout-ou-rien). Message
  **volontairement non fuyant** : ni l'IP résolue ni la cause du blocage.
- `429` `{ "error": "Too many concurrent screenshot requests", "retryAfterMs": 5000 }`
  + en-tête `Retry-After` (secondes) — concurrence (`LIBRY_SHOT_CONCURRENCY`,
  défaut 2) et file (`LIBRY_SHOT_QUEUE_MAX`, défaut 4) saturées.
- `502` `{ "error": "Screenshot capture failed" }` — échec technique (dont
  Chromium absent). La cause détaillée (exit/signal + fin de stderr Chromium) est
  **journalisée** : `[screenshot] capture failed: Screenshot failed (exit=1,
  signal=null): No usable sandbox! ...` (`docker compose logs libry`).
- `504` `{ "error": "Screenshot capture timed out" }` — dépassement du timeout
  (le process Chromium est tué en SIGKILL).

Sécurité : la résolution DNS est **épinglée** sur l'IP validée
(`--host-resolver-rules`, anti DNS-rebinding) ; `--no-sandbox` n'est PAS passé
par défaut (utilisateur non-root), il n'est réactivé que par
`LIBRY_CHROMIUM_NO_SANDBOX=true`.

⚠️ **Sous Docker, le sandbox Chromium est inexploitable par défaut** : le
profil seccomp de Docker refuse `unshare`/`clone(CLONE_NEW*)` aux processus
sans `CAP_SYS_ADMIN` (EPERM), et l'image n'embarque pas de helper SUID
(`chromium-sandbox`) → **toute capture échoue** en `502` avec au journal
`[screenshot] capture failed: Screenshot failed (...): No usable sandbox! …`.
Deux remèdes (vérifiés sur le serveur) : `LIBRY_CHROMIUM_NO_SANDBOX=true`
(navigateur sans sandbox interne — compromis) **ou** `security_opt:
[seccomp=unconfined]` dans `docker-compose.yml` (le sandbox interne de Chromium
fonctionne alors à nouveau ; le filtre seccomp Docker du conteneur est retiré).

### `GET /api/librarian/shot/:id.png` — clé requise

Sert le PNG capturé (`Content-Type: image/png`). `404` `{ "error": "Shot not found" }`
si l'image est absente ou expirée (TTL `LIBRY_SHOT_TTL_HOURS`, défaut 168 h).

Stockage : `LIBRY_SHOTS_DIR` (défaut `$LIBRY_DATA_DIR/shots`), `<uuid>.png` +
`<uuid>.json`. Purge périodique locale, **sans LLM**. Pi-Web conserve
l'affichage : il télécharge l'image et la réinjecte dans ses pièces jointes.

## Moteur web (Lot 6)

Routes sous `/api/librarian`, **clé requise**. Elles exposent les capacités de
WebClaw (service tiers) **sans jamais divulguer son URL ni sa clé** : les
erreurs renvoyées sont **génériques**, le détail reste dans les logs serveur.

Configuration : `WEBCLAW_URL` (défaut `http://localhost:3001` ; en docker-compose
`http://webclaw:3000`), `WEBCLAW_API_KEY` (secret), `LIBRY_TAVILY_API_KEY`
(secret). Env **prioritaire**, repli fichier `$LIBRY_DATA_DIR/webclaw-config.json`
et `$LIBRY_DATA_DIR/tavily-config.json`.

### `POST /api/librarian/fetch` — clé requise

Lecture d'une page (équivalent REST de `webclawScrape`).

Corps : `{ "url": "https://…", "format?": "markdown" }`.

Succès `200` :

```json
{ "url": "https://example.com/", "title": "…", "description": "…", "content": "…", "contentType": "text/html", "origin": "web" }
```

Erreurs (messages stables, sans URL/clé WebClaw) :

- `400` `{ "error": "Missing 'url' in body" }` — cible absente.
- `400` `{ "error": "Invalid URL" }` — URL malformée ou non http/https
  (`file://` compris).
- `403` `{ "error": "URL not allowed" }` — cible bloquée par la protection
  **SSRF** (loopback, privée, lien-local/métadonnées cloud). Message volontairement
  **non fuyant** (ni IP résolue, ni cause).
- `502` `{ "error": "Fetch failed" }` — WebClaw injoignable ou réponse non-2xx.
- `504` `{ "error": "Fetch timed out" }` — dépassement du timeout
  (`LIBRY_WEBCLAW_TIMEOUT_MS`).

### `POST /api/librarian/crawl|/map|/extract|/batch` — clé requise

**Pass-through contrôlé** vers WebClaw (`/v1/crawl`, `/v1/map`, `/v1/extract`,
`/v1/batch`). Toute URL cible passe la **validation SSRF** (sinon `403`/`400`),
les réponses sont **bornées** (pages, URLs, taille du contenu) et chaque appel a
un **timeout** (`504` au dépassement). Erreurs génériques :
`502 { "error": "Upstream request failed" }` / `504 { "error": "Upstream request timed out" }`.

- `POST /crawl` : corps `{ "url", "limit?", "maxDepth?" }` →
  `{ "url", "origin": "web", "pages": [ { "url", "markdown?", "content?" } ], "count" }`.
- `POST /map` : corps `{ "url" }` → `{ "url", "origin": "web", "count", "urls": [...] }`.
- `POST /extract` : corps `{ "url", "schema?", "prompt?" }` — **exige `schema`
  ou `prompt`** (contrainte WebClaw) ; sinon `400`
  `{ "error": "extract requires 'schema' or 'prompt'" }` →
  `{ "url", "origin": "web", "data": … }`.
- `POST /batch` : corps `{ "urls": ["https://…"] }` (max 25 URLs) ; sinon `400`
  `{ "error": "Missing 'urls' in body" }` → `{ "origin": "web", "results": … }`.

### `GET /api/librarian/providers` — clé requise

État des moteurs — **booléens seulement, aucun secret** :

```json
{ "webclaw": { "configured": true, "apiKey": true, "reachable": true }, "tavily": { "configured": false }, "search": "webclaw" }
```

- `webclaw.configured` : configuration **explicite** présente (env `WEBCLAW_*` ou fichier).
- `webclaw.apiKey` : présence d'une clé WebClaw (booléen, **jamais la valeur**).
  Si `false`, tous les appels `/v1/*` répondront 401 et la recherche web sera
  muette : c'est le premier point à vérifier.
- `webclaw.reachable` : sonde `GET /health` (booléen).
- `search` : moteur sollicité par la cascade — `webclaw` si joignable, sinon
  `tavily` s'il est configuré, sinon `duckduckgo`.

### Note — capacités WebClaw (outil tiers, non modifiable)

WebClaw (v0.6.23) expose `scrape`, `search`, `crawl`, `map`, `extract`,
`summarize`, `batch`. `/v1/search` répond **501** tant que `SERPER_API_KEY`
n'est pas fourni **côté WebClaw**. WebClaw **n'exécute pas le JavaScript** et
n'expose **aucun endpoint de capture** (fonctions cloud volontairement fermées) :
la capture d'écran reste assurée par Libry (Chromium, Lot 5).
