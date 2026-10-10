/**
 * Client WebClaw — configuration + appels REST.
 *
 * Port de Pi-Web (backend/src/webclaw.ts + les appels de
 * backend/src/pi/librarian-service.ts), adapté à Libry :
 *   - configuration propre à Libry : `WEBCLAW_URL` / `WEBCLAW_API_KEY`
 *     (env PRIORITAIRE, fichier `$LIBRY_DATA_DIR/webclaw-config.json` en repli) ;
 *   - WebClaw reste un service TIERS INTOUCHABLE : son URL et sa clé ne
 *     quittent JAMAIS ce module vers les réponses d'erreur ;
 *   - auth `Authorization: Bearer <clé>` (seul mode accepté par WebClaw) ;
 *   - timeout par appel via AbortSignal.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { getDataDir, getWebclawTimeoutMs } from "./config.js";
import { resolveSetting, getSettingSource } from "./settings-store.js";
import { httpFetch } from "./utils/http.js";

// ── Configuration ──

export interface WebclawConfig {
  url: string;
  apiKey: string;
}

/** Défaut hors conteneur (le compose Libry force http://webclaw:3000). */
const DEFAULT_WEBCLAW_URL = "http://localhost:3001";

function configFilePath(): string {
  return path.join(getDataDir(), "webclaw-config.json");
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function readConfigFile(): Partial<WebclawConfig> {
  try {
    const filePath = configFilePath();
    if (!existsSync(filePath)) return {};
    const data = JSON.parse(readFileSync(filePath, "utf-8"));
    return data && typeof data === "object" ? (data as Partial<WebclawConfig>) : {};
  } catch (e) {
    console.error("[webclaw] Failed to load config:", e);
    return {};
  }
}

/**
 * Config effective : env prioritaire, puis `$LIBRY_DATA_DIR/config.json`, puis le
 * fichier historique `webclaw-config.json` (compat Pi-Web), puis le défaut.
 */
export function getWebclawConfig(): WebclawConfig {
  const legacy = readConfigFile();
  return {
    url: resolveSetting("WEBCLAW_URL", nonEmpty(legacy.url) ?? DEFAULT_WEBCLAW_URL),
    apiKey: resolveSetting("WEBCLAW_API_KEY", nonEmpty(legacy.apiKey) ?? ""),
  };
}

/** Persiste la config (compat Pi-Web) dans `$LIBRY_DATA_DIR/webclaw-config.json`. */
export function setWebclawConfig(config: Partial<WebclawConfig>): WebclawConfig {
  const dir = getDataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const current = getWebclawConfig();
  const next: WebclawConfig = {
    url: nonEmpty(config.url) ?? current.url,
    apiKey: config.apiKey !== undefined ? (nonEmpty(config.apiKey) ?? "") : current.apiKey,
  };
  writeFileSync(configFilePath(), JSON.stringify(next, null, 2));
  return next;
}

/** Vrai si WebClaw a une configuration EXPLICITE (env ou fichier). Booléen, sans secret. */
export function isWebclawConfigured(): boolean {
  if (getSettingSource("WEBCLAW_URL") !== "default" || getSettingSource("WEBCLAW_API_KEY") !== "default") return true;
  return existsSync(configFilePath());
}

// ── Erreurs ──

/** Réponse HTTP non-2xx renvoyée par WebClaw (statut conservé, message neutre). */
export class WebclawHttpError extends Error {
  constructor(readonly status: number) {
    super(`WebClaw request failed (HTTP ${status})`);
    this.name = "WebclawHttpError";
  }
}

/** WebClaw injoignable (réseau) ou appel abandonné (timeout). Message JAMAIS fuyant. */
export class WebclawUnreachableError extends Error {
  constructor(readonly timedOut: boolean) {
    super(timedOut ? "WebClaw request timed out" : "WebClaw is unreachable");
    this.name = "WebclawUnreachableError";
  }
}

// ── Appel bas niveau ──

interface WebclawResponse {
  status: number;
  data: any;
}

/**
 * POST JSON vers WebClaw. Lève `WebclawUnreachableError` sur erreur réseau/timeout ;
 * sinon retourne le statut et le corps parsé (même non-2xx, à charge de l'appelant).
 */
async function webclawRequest(endpoint: string, body: unknown, timeoutMs: number): Promise<WebclawResponse> {
  const { url, apiKey } = getWebclawConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await httpFetch(`${url}${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let data: any = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { status: res.status, data };
  } catch (e) {
    // Détail INTERNE (logs serveur) — jamais remonté au client.
    const timedOut = controller.signal.aborted;
    console.error(`[webclaw] ${endpoint} unavailable:`, timedOut ? "timeout" : e instanceof Error ? e.message : e);
    throw new WebclawUnreachableError(timedOut);
  } finally {
    clearTimeout(timer);
  }
}

// ── API ──

export interface WebclawSearchResult {
  title: string;
  url: string;
  snippet: string;
  content?: string;
}

/**
 * WebClaw `/v1/search`. En self-hosted sans SERPER, l'endpoint répond **501** :
 * on le signale par `WebclawHttpError(501)` pour que l'appelant bascule sans erreur.
 */
export async function webclawSearch(
  query: string,
  num = 5,
  timeoutMs: number = getWebclawTimeoutMs(),
): Promise<WebclawSearchResult[]> {
  const { status, data } = await webclawRequest("/v1/search", { query, num, scrape: true }, timeoutMs);
  if (status < 200 || status >= 300) throw new WebclawHttpError(status);
  return Array.isArray(data?.results) ? (data.results as WebclawSearchResult[]) : [];
}

export interface WebclawScrapeResult {
  content: string;
  title?: string;
  description?: string;
  contentType?: string;
}

/** WebClaw `/v1/scrape` — lecture d'une page (markdown par défaut). */
export async function webclawScrape(
  url: string,
  opts: { format?: string; timeoutMs?: number } = {},
): Promise<WebclawScrapeResult> {
  const { status, data } = await webclawRequest(
    "/v1/scrape",
    { url, format: opts.format || "markdown" },
    opts.timeoutMs ?? getWebclawTimeoutMs(),
  );
  if (status < 200 || status >= 300) throw new WebclawHttpError(status);
  return {
    content: data?.content || data?.markdown || "",
    title: data?.title || data?.metadata?.title,
    description: data?.description || data?.metadata?.description,
    contentType: data?.contentType || data?.metadata?.contentType,
  };
}

/** Pass-through contrôlé : `/v1/crawl`. Réponse brute (bornée par l'appelant). */
export async function webclawCrawl(
  url: string,
  opts: Record<string, unknown> = {},
  timeoutMs: number = getWebclawTimeoutMs(),
): Promise<any> {
  const { status, data } = await webclawRequest("/v1/crawl", { url, ...opts }, timeoutMs);
  if (status < 200 || status >= 300) throw new WebclawHttpError(status);
  return data;
}

/** Pass-through contrôlé : `/v1/map`. Réponse brute (bornée par l'appelant). */
export async function webclawMap(
  url: string,
  opts: Record<string, unknown> = {},
  timeoutMs: number = getWebclawTimeoutMs(),
): Promise<any> {
  const { status, data } = await webclawRequest("/v1/map", { url, ...opts }, timeoutMs);
  if (status < 200 || status >= 300) throw new WebclawHttpError(status);
  return data;
}

/** Pass-through contrôlé : `/v1/extract` (exige `schema` ou `prompt` côté WebClaw). */
export async function webclawExtract(
  url: string,
  opts: Record<string, unknown> = {},
  timeoutMs: number = getWebclawTimeoutMs(),
): Promise<any> {
  const { status, data } = await webclawRequest("/v1/extract", { url, ...opts }, timeoutMs);
  if (status < 200 || status >= 300) throw new WebclawHttpError(status);
  return data;
}

/** Pass-through contrôlé : `/v1/batch` (exige `urls`). Réponse brute (bornée). */
export async function webclawBatch(
  urls: string[],
  opts: Record<string, unknown> = {},
  timeoutMs: number = getWebclawTimeoutMs(),
): Promise<any> {
  const { status, data } = await webclawRequest("/v1/batch", { urls, ...opts }, timeoutMs);
  if (status < 200 || status >= 300) throw new WebclawHttpError(status);
  return data;
}

/** Sonde `GET /health` (booléen seulement — jamais d'erreur remontée). */
export async function isWebclawReachable(timeoutMs = 2000): Promise<boolean> {
  const { url } = getWebclawConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await httpFetch(`${url}/health`, { method: "GET", signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
