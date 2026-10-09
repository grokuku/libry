/**
 * Configuration de Libry — lecture PARESSEUSE des variables d'environnement.
 *
 * Les getters relisent l'environnement à chaque appel : les tests peuvent donc
 * isoler chaque suite dans un répertoire de données temporaire sans recharger
 * les modules. Les variables propres à Libry sont préfixées LIBRY_* ;
 * CHROMIUM_PATH et WEBCLAW_* restent neutres (contrat inter-services).
 */
import path from "path";

function readEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw !== undefined && raw.trim() !== "" ? raw.trim() : fallback;
}

export function getHost(): string {
  return readEnv("LIBRY_HOST", "0.0.0.0");
}

export function getPort(): number {
  const parsed = Number.parseInt(readEnv("LIBRY_PORT", "3007"), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3007;
}

/** Répertoire racine des données persistantes (volume). */
export function getDataDir(): string {
  return path.resolve(readEnv("LIBRY_DATA_DIR", "/app/data"));
}

/** Répertoire de la bibliothèque (index.json + tools/*.json). */
export function getDocsDir(): string {
  return path.resolve(readEnv("LIBRY_DOCS_DIR", path.join(getDataDir(), "docs")));
}

/** Fichier JSON des clés API. */
export function getKeysFile(): string {
  return path.resolve(readEnv("LIBRY_KEYS_FILE", path.join(getDataDir(), "libry-keys.json")));
}

/** Origines CORS autorisées (liste). Vide = aucune origine cross-origin. */
export function getAllowedOrigins(): string[] {
  return readEnv("LIBRY_ALLOWED_ORIGINS", "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

export function getRateLimitPerMin(): number {
  const parsed = Number.parseInt(readEnv("LIBRY_RATE_LIMIT_PER_MIN", "600"), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 600;
}

/** Clés historiques (préfixe « lib-… ») acceptées hors fichier de clés. */
export function getLegacyKeys(): string[] {
  return readEnv("LIBRY_LEGACY_KEYS", "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

/** Clés marquées administrateur. */
export function getAdminKeys(): string[] {
  return readEnv("LIBRY_ADMIN_KEYS", "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

/** Liste blanche de chemins scannés par POST /update. */
export function getUpdateCwds(): string[] {
  return readEnv("LIBRY_UPDATE_CWDS", "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
}

export function getLogLevel(): string {
  return readEnv("LIBRY_LOG_LEVEL", "info");
}

// ── Capture d'écran (Lot 5) ──

/** Répertoire des captures (PNG + méta JSON). */
export function getShotsDir(): string {
  return path.resolve(readEnv("LIBRY_SHOTS_DIR", path.join(getDataDir(), "shots")));
}

/** Captures simultanées autorisées (défaut 2). */
export function getShotConcurrency(): number {
  const parsed = Number.parseInt(readEnv("LIBRY_SHOT_CONCURRENCY", "2"), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 2;
}

/**
 * Taille de la file d'attente des captures (défaut 4). 0 = aucune attente :
 * dès que les slots sont occupés, la nouvelle demande répond 429.
 */
export function getShotQueueMax(): number {
  const parsed = Number.parseInt(readEnv("LIBRY_SHOT_QUEUE_MAX", "4"), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 4;
}

/** Durée de vie des captures en heures (défaut 168 h = 7 jours). */
export function getShotTtlHours(): number {
  const parsed = Number.parseInt(readEnv("LIBRY_SHOT_TTL_HOURS", "168"), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 168;
}

/** Autorise la capture de HTML inline (`file://`). Désactivé par défaut. */
export function getShotInlineHtml(): boolean {
  return readEnv("LIBRY_SHOT_INLINE_HTML", "false").toLowerCase() === "true";
}

/** Chemin explicite du binaire Chromium (sinon détection par `which`). */
export function getChromiumPath(): string | undefined {
  const raw = process.env.CHROMIUM_PATH;
  return raw !== undefined && raw.trim() !== "" ? raw.trim() : undefined;
}

/**
 * Repli `--no-sandbox` : à activer UNIQUEMENT si la sandbox Chromium échoue sur
 * le noyau hôte. Désactivé par défaut (l'image tourne en utilisateur non-root).
 */
export function getChromiumNoSandbox(): boolean {
  return readEnv("LIBRY_CHROMIUM_NO_SANDBOX", "false").toLowerCase() === "true";
}
