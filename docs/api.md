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

Réponse : `{ "results": [ { "title", "url", "snippet", "content?" } ], "archived": false }`.

- `400` si `query` absent : `{ "error": "Missing 'query' in body" }` (verbatim).
- La recherche interroge **d'abord la bibliothèque locale**. Sur un miss local,
  elle interroge le **web** et **peut renvoyer du contenu de page scrapé** dans
  `content` (jusqu'à 5000 caractères par résultat).
- ⚠️ **Correction d'une erreur de la doc historique de Pi-Web**
  (`docs/librarian-api.md`) : celle-ci affirmait « pas de scraping en /search,
  `content` absent ». C'est **faux** : le repli web (DuckDuckGo) scrape
  réellement les pages et renvoie `content`. Le comportement réel est conservé
  ici.
- Dans ce lot, le moteur web n'est pas encore branché : un miss local renvoie
  `{ "results": [], "archived": false }`. Le fournisseur web sera branché via
  `setWebSearchProvider` dans un lot ultérieur, sans changer le contrat.

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
  Chromium absent).
- `504` `{ "error": "Screenshot capture timed out" }` — dépassement du timeout
  (le process Chromium est tué en SIGKILL).

Sécurité : la résolution DNS est **épinglée** sur l'IP validée
(`--host-resolver-rules`, anti DNS-rebinding) ; `--no-sandbox` n'est PAS passé
par défaut (utilisateur non-root), il n'est réactivé que par
`LIBRY_CHROMIUM_NO_SANDBOX=true`.

### `GET /api/librarian/shot/:id.png` — clé requise

Sert le PNG capturé (`Content-Type: image/png`). `404` `{ "error": "Shot not found" }`
si l'image est absente ou expirée (TTL `LIBRY_SHOT_TTL_HOURS`, défaut 168 h).

Stockage : `LIBRY_SHOTS_DIR` (défaut `$LIBRY_DATA_DIR/shots`), `<uuid>.png` +
`<uuid>.json`. Purge périodique locale, **sans LLM**. Pi-Web conserve
l'affichage : il télécharge l'image et la réinjecte dans ses pièces jointes.
