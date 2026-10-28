/**
 * Configuration de Libry — lecture PARESSEUSE et À CHAUD des réglages.
 *
 * Les getters relisent l'environnement à chaque appel (et consultent le fichier
 * de réglages `$LIBRY_DATA_DIR/config.json` en repli) : les tests peuvent donc
 * isoler chaque suite dans un répertoire de données temporaire sans recharger
 * les modules, et une valeur écrite via l'API d'administration est prise en
 * compte SANS redémarrage. Modèle de résolution : `env ?? fichier ?? défaut`.
 * Les variables propres à Libry sont préfixées LIBRY_* ; CHROMIUM_PATH et
 * WEBCLAW_* restent neutres (contrat inter-services).
 *
 * ⚠️ Réglages « redémarrage requis » (lus UNE fois au démarrage, hors getters) :
 * LIBRY_HOST, LIBRY_PORT, LIBRY_ALLOWED_ORIGINS, LIBRY_RATE_LIMIT_PER_MIN et
 * LIBRY_DATA_DIR. Tous les autres sont appliqués à chaud.
 */
import path from "path";
import { resolveSetting } from "./settings-store.js";

function readEnv(name: string, fallback: string): string {
  return resolveSetting(name, fallback);
}

export function getHost(): string {
  return readEnv("LIBRY_HOST", "0.0.0.0");
}

export function getPort(): number {
  const parsed = Number.parseInt(readEnv("LIBRY_PORT", "3007"), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3007;
}

/** Répertoire racine des données persistantes (volume) — envOnly, redémarrage requis. */
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

/** Origines CORS autorisées (liste). Vide = aucune origine cross-origin. Redémarrage requis. */
export function getAllowedOrigins(): string[] {
  return readEnv("LIBRY_ALLOWED_ORIGINS", "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

/** Limite de requêtes par minute (redémarrage requis : capturée au montage). */
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

// ── Liste blanche des adresses internes (anti-SSRF) ──

/**
 * Noms d'hôtes internes autorisés (`switchy,pi-web,*.holaf.lan`). Vide par
 * défaut : aucune adresse interne n'est joignable (politique historique).
 */
export function getSsrfAllowedHosts(): string[] {
  return readEnv("LIBRY_SSRF_ALLOWED_HOSTS", "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
}

/**
 * Plages d'adresses internes autorisées (`10.10.0.0/16,192.168.1.0/24`). Vide
 * par défaut. Les adresses lien-local (métadonnées cloud) restent TOUJOURS
 * bloquées, même si une plage les couvre.
 */
export function getSsrfAllowedCidrs(): string[] {
  return readEnv("LIBRY_SSRF_ALLOWED_CIDRS", "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
}

// ── Moteur web (Lot 6) ──

/**
 * Timeout par appel vers WebClaw (scrape/search/crawl/map/extract/batch), en ms.
 * Au dépassement, l'appel est abandonné (AbortSignal) et mappé en 504.
 */
export function getWebclawTimeoutMs(): number {
  const parsed = Number.parseInt(readEnv("LIBRY_WEBCLAW_TIMEOUT_MS", "15000"), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15000;
}

/** Timeout par appel vers l'API Tavily, en ms (défaut 15 s). */
export function getTavilyTimeoutMs(): number {
  const parsed = Number.parseInt(readEnv("LIBRY_TAVILY_TIMEOUT_MS", "15000"), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15000;
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
  const raw = readEnv("CHROMIUM_PATH", "");
  return raw !== "" ? raw : undefined;
}

/**
 * Repli `--no-sandbox` : à activer UNIQUEMENT si la sandbox Chromium échoue sur
 * le noyau hôte. Désactivé par défaut (l'image tourne en utilisateur non-root).
 */
export function getChromiumNoSandbox(): boolean {
  return readEnv("LIBRY_CHROMIUM_NO_SANDBOX", "false").toLowerCase() === "true";
}
