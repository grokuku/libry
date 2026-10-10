/**
 * Client Tavily — configuration + recherche.
 *
 * Port de Pi-Web (backend/src/tavily.ts + `tavilySearch` de
 * backend/src/pi/librarian-service.ts), adapté à Libry :
 *   - clé propre à Libry : `LIBRY_TAVILY_API_KEY` (env PRIORITAIRE), fichier
 *     `$LIBRY_DATA_DIR/tavily-config.json` en repli ;
 *   - la clé ne quitte JAMAIS ce module vers les réponses d'erreur ;
 *   - timeout par appel via AbortSignal.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { getDataDir, getTavilyTimeoutMs } from "./config.js";
import { resolveSetting } from "./settings-store.js";
import { httpFetch } from "./utils/http.js";

export interface TavilyConfig {
  apiKey: string;
}

const TAVILY_ENDPOINT = "https://api.tavily.com/search";

function configFilePath(): string {
  return path.join(getDataDir(), "tavily-config.json");
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function readConfigFile(): Partial<TavilyConfig> {
  try {
    const filePath = configFilePath();
    if (!existsSync(filePath)) return {};
    const data = JSON.parse(readFileSync(filePath, "utf-8"));
    return data && typeof data === "object" ? (data as Partial<TavilyConfig>) : {};
  } catch (e) {
    console.error("[tavily] Failed to load config:", e);
    return {};
  }
}

/**
 * Clé effective : env `LIBRY_TAVILY_API_KEY` prioritaire, puis
 * `$LIBRY_DATA_DIR/config.json`, puis le fichier historique `tavily-config.json`.
 */
export function getTavilyConfig(): TavilyConfig {
  const legacy = readConfigFile();
  return { apiKey: resolveSetting("LIBRY_TAVILY_API_KEY", nonEmpty(legacy.apiKey) ?? "") };
}

/** Persiste la config (compat Pi-Web) dans `$LIBRY_DATA_DIR/tavily-config.json`. */
export function setTavilyConfig(config: Partial<TavilyConfig>): TavilyConfig {
  const dir = getDataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const current = getTavilyConfig();
  const next: TavilyConfig = {
    apiKey: config.apiKey !== undefined ? (nonEmpty(config.apiKey) ?? "") : current.apiKey,
  };
  writeFileSync(configFilePath(), JSON.stringify(next, null, 2));
  return next;
}

/** Erreur Tavily : `status` null = non configuré ou réseau, sinon statut HTTP. */
export class TavilyError extends Error {
  constructor(readonly status: number | null) {
    super(status === null ? "Tavily is unavailable" : `Tavily request failed (HTTP ${status})`);
    this.name = "TavilyError";
  }
}

export interface TavilySearchResult {
  title: string;
  url: string;
  snippet: string;
  content?: string;
}

/** Recherche Tavily. Lève `TavilyError` si non configuré / injoignable. */
export async function tavilySearch(
  query: string,
  num = 5,
  timeoutMs: number = getTavilyTimeoutMs(),
): Promise<TavilySearchResult[]> {
  const { apiKey } = getTavilyConfig();
  if (!apiKey) throw new TavilyError(null);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await httpFetch(TAVILY_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: num,
        search_depth: "basic",
        include_answer: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new TavilyError(res.status);
    const data: any = await res.json();
    return (Array.isArray(data?.results) ? data.results : []).map((r: any) => ({
      title: r?.title || "",
      url: r?.url || "",
      snippet: typeof r?.content === "string" ? r.content.substring(0, 200) : "",
      content: r?.content,
    }));
  } catch (e) {
    if (e instanceof TavilyError) throw e;
    // Détail INTERNE uniquement — jamais remonté au client.
    console.error("[tavily] search unavailable:", e instanceof Error ? e.message : e);
    throw new TavilyError(null);
  } finally {
    clearTimeout(timer);
  }
}
