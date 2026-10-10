/**
 * Moteur de recherche web de Libry — CASCADE complète, portée de Pi-Web
 * (backend/src/pi/librarian-service.ts).
 *
 * Ordre STRICT (identique à l'existant) :
 *   ① bibliothèque locale — gérée en amont par `searchAndArchive` (si ≥ 1 doc
 *      local, le fournisseur ci-dessous n'est JAMAIS appelé → aucun appel réseau) ;
 *   ② WebClaw `/v1/search` — en self-hosted sans SERPER, l'endpoint répond 501 :
 *      on bascule SANS erreur ;
 *   ③ Tavily, si configuré ;
 *   ④ repli DuckDuckGo : sa page HTML est scrapée via WebClaw `/v1/scrape`, puis
 *      les 3 premiers résultats sont scrapés (`content` ≤ 5000 caractères).
 *
 * ⚠️ Le repli DDG SCRAPE réellement les pages et renvoie `content` — contrairement
 * à ce qu'affirmait (à tort) la doc historique de Pi-Web (`docs/librarian-api.md`).
 *
 * Le moteur est branché sur `library-store` via `setWebSearchProvider`.
 */
import { setWebSearchProvider, sanitizeContent, type WebSearchResult } from "./library-store.js";
import { webclawSearch, webclawScrape, WebclawHttpError } from "./webclaw.js";
import { tavilySearch, getTavilyConfig } from "./tavily.js";

/** Nombre maximal de résultats web renvoyés (identique à Pi-Web). */
export const WEB_SEARCH_NUM = 5;

/** Longueur maximale du `content` d'un résultat scrapé (DDG). */
export const MAX_SCRAPE_CONTENT_CHARS = 5000;

/** Pause entre deux scrapes du repli DDG (ms). Injectable pour les tests. */
let scrapeDelayMs = 1000;

/** Injection du délai entre scrapes (tests : 0 pour ne pas ralentir). */
export function setScrapeDelayForTests(ms: number): void {
  scrapeDelayMs = ms;
}

function sanitizeResults(results: WebSearchResult[]): WebSearchResult[] {
  return results.map((r) => ({
    ...r,
    content: r.content ? sanitizeContent(r.content) : r.content,
  }));
}

/**
 * Repli DuckDuckGo : scrape la page de résultats DDG via WebClaw, extrait les
 * liens (résout les redirections `uddg=…`), déduplique, puis scrape le contenu
 * des 3 premiers résultats.
 */
async function duckDuckGoFallback(query: string, num: number): Promise<WebSearchResult[]> {
  const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const ddgResult = await webclawScrape(ddgUrl);

  const rawResults: WebSearchResult[] = [];
  const linkRegex = /\[([^\]]+)\]\(([^)\s]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(ddgResult.content)) !== null) {
    const title = match[1];
    let rawUrl = match[2];

    // DuckDuckGo encapsule les URLs : //duckduckgo.com/l/?uddg=<url_encodée>&rut=…
    const uddgMatch = rawUrl.match(/uddg=([^&]+)/);
    if (uddgMatch) {
      try {
        rawUrl = decodeURIComponent(uddgMatch[1]);
      } catch {
        continue;
      }
    }

    if (rawUrl.startsWith("//")) rawUrl = "https:" + rawUrl;
    if (!rawUrl.startsWith("http")) continue;
    if (rawUrl.includes("duckduckgo.com") || rawUrl.includes("duckduckgo.org")) continue;

    rawResults.push({ title, url: rawUrl, snippet: "" });
  }

  // Déduplication par URL (DDG renvoie souvent le même lien plusieurs fois).
  const seenUrls = new Set<string>();
  const results: WebSearchResult[] = [];
  for (const r of rawResults) {
    if (seenUrls.has(r.url)) continue;
    seenUrls.add(r.url);
    results.push(r);
    if (results.length >= num) break;
  }

  // Scrape le contenu des 3 premiers résultats (les échecs sont ignorés).
  const toScrape = Math.min(3, results.length);
  for (let i = 0; i < toScrape; i++) {
    try {
      const scraped = await webclawScrape(results[i].url);
      results[i].content = sanitizeContent(scraped.content.substring(0, MAX_SCRAPE_CONTENT_CHARS));
      results[i].snippet = scraped.description || scraped.content.substring(0, 200);
      if (scrapeDelayMs > 0) await new Promise((r) => setTimeout(r, scrapeDelayMs));
    } catch {
      // Page non scrapable : on passe au suivant.
    }
  }

  return sanitizeResults(results);
}

/**
 * Cascade de recherche web (les résultats locaux sont traités en amont).
 * Ne lève jamais : en dernier recours, renvoie une liste vide.
 */
export async function searchWeb(query: string, num: number = WEB_SEARCH_NUM): Promise<WebSearchResult[]> {
  // ② WebClaw /v1/search
  try {
    const remote = await webclawSearch(query, num);
    return sanitizeResults(remote.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet, content: r.content })));
  } catch (e) {
    if (e instanceof WebclawHttpError && e.status === 501) {
      // Self-hosted sans SERPER_API_KEY → bascule silencieuse (pas d'erreur).
    } else {
      console.error("[web-search] WebClaw search unavailable:", e instanceof Error ? e.message : e);
    }
  }

  // ③ Tavily (si configuré)
  if (getTavilyConfig().apiKey) {
    try {
      const tavily = await tavilySearch(query, num);
      if (tavily.length > 0) return sanitizeResults(tavily);
    } catch (e) {
      console.error("[web-search] Tavily unavailable:", e instanceof Error ? e.message : e);
    }
  }

  // ④ Repli DuckDuckGo (scrapé via WebClaw /v1/scrape)
  try {
    return await duckDuckGoFallback(query, num);
  } catch (e) {
    console.error("[web-search] DuckDuckGo fallback failed:", e instanceof Error ? e.message : e);
    return [];
  }
}

/** Enregistre la cascade comme fournisseur de `library-store` (idempotent). */
export function registerWebSearchProvider(): void {
  setWebSearchProvider(searchWeb);
}
