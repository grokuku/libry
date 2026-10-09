# AGENTS.md — Libry

Libry est un **service** de l'écosystème holaf, pas une brique holaf : il n'est
pas destiné à être copié dans `vendor/holaf` d'un projet.

Les conventions communes de l'écosystème (SDK Pi, façades, événements, erreurs
d'intégration, règles communes) sont la **source unique de vérité** et vivent
dans `holaf-lib`. **Ne jamais les recopier ici** : pointer vers le dossier.

- Index des conventions : `/projects/holaf-lib/docs/conventions/README.md`
- SDK Pi (notamment §7–§8, façade / événements / erreurs) :
  `/projects/holaf-lib/docs/conventions/pi-sdk.md`

Avant d'introduire ou de modifier un composant, une intégration ou un outil,
consulter d'abord ces documents. Toute règle commune nouvelle se discute dans
`holaf-lib`, jamais dans Libry.

## Spécificités de Libry

- `name`: `libry`, version `0.1.0`, `private: true`, ESM, Node ≥ 22.
- Dépendances runtime volontairement minimales (`express`, `express-rate-limit`).
  Pas de SDK Pi, pas de LLM, pas de `cors`, pas d'`uuid` (`crypto.randomUUID()`).
- Contrat `/api/librarian/*` **figé** (Yuki le code en dur) : ne jamais modifier
  un chemin, un code HTTP ou un message d'erreur.
- Écrit dans **son** répertoire de données (`LIBRY_DATA_DIR`). Ne touche jamais
  au volume de Pi-Web (`/app/.data`).
