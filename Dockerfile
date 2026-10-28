# ─── Libry — image de service (capture d'écran Chromium incluse) ───
#
# Image de base tirée du MIROIR PUBLIC GOOGLE (mirror.gcr.io) : contenu
# identique à docker.io/library/node:22-slim, seule la provenance change — et
# ce miroir n'applique pas de quota de pulls anonymes.
#
# Pourquoi PAS public.ecr.aws (utilisé avant) : ECR Public limite les pulls
# ANONYMES par adresse IP ; les runners GitHub partagent leurs IP, d'où l'échec
# « 429 Too Many Requests · toomanyrequests: Data limit exceeded » observé en CI.
# Pourquoi PAS docker.io en direct : Docker Hub rate-limite aussi les anonymes.
#
# Empreintes MESURÉES le 2026-10-28 sur mirror.gcr.io (figées ici en
# commentaire, le tag reste utilisé : un digest épinglé casse le build si le
# miroir resynchronise le tag) :
#   index multi-arch  : sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da
#   linux/amd64       : sha256:9f0dde62d10e7ff7a310ecaebd66225f6b46c17e6cb778449a77b05d3541bea2
#
# Build en DEUX étapes : la compilation TypeScript a besoin des devDependencies
# (typescript, @types/*), l'exécution NON. L'étape finale n'embarque que le
# runtime + Chromium.

# ─── Étape 1 : compilation TypeScript ───
FROM mirror.gcr.io/library/node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ─── Étape 2 : exécution ───
FROM mirror.gcr.io/library/node:22-slim
ENV DEBIAN_FRONTEND=noninteractive

# Chromium + polices : rendu texte/emoji correct des captures.
# --no-install-recommends : les dépendances headless (libnss3, libgbm1…) sont
# fournies en Depends du paquet chromium. Bloc isolé pour préserver le cache.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      fonts-liberation \
      fonts-noto-core \
      fonts-noto-color-emoji \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Chemin explicite du binaire (détection sinon par `which`).
ENV CHROMIUM_PATH=/usr/bin/chromium
ENV NODE_ENV=production
ENV LIBRY_DATA_DIR=/app/data
ENV LIBRY_HOST=0.0.0.0
ENV LIBRY_PORT=3007

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Interface web statique (HTML/CSS/JS, sans étape de build) : copiée AVANT le
# chown pour que l'utilisateur non-root puisse la lire.
COPY public ./public

# Utilisateur NON-ROOT (uid fixe). Le répertoire de données lui appartient :
# Libry n'écrit que dans SON volume, jamais dans celui de Pi-Web.
RUN useradd -u 10001 -m -s /usr/sbin/nologin libry \
 && mkdir -p /app/data \
 && chown -R libry:libry /app
USER libry

EXPOSE 3007

# Liveness aligné sur le contrat GET /health = {"service":"libry","status":"ok"}.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.LIBRY_PORT||3007)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
