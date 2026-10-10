/**
 * Routes web de Libry (sous /api/librarian, clé obligatoire).
 *
 *   POST /fetch   → lecture d'une page (équivalent REST de `webclawScrape`)
 *   POST /crawl   → pass-through contrôlé vers WebClaw /v1/crawl
 *   POST /map     → pass-through contrôlé vers WebClaw /v1/map
 *   POST /extract → pass-through contrôlé vers WebClaw /v1/extract (exige schema|prompt)
 *   POST /batch   → pass-through contrôlé vers WebClaw /v1/batch
 *   GET  /providers → état des moteurs (booléens seulement, aucun secret)
 *
 * Sécurité :
 *   - SSRF OBLIGATOIRE sur TOUTE URL cible (réutilise `src/utils/ssrf.ts`) :
 *     403 avec message STABLE et NON fuyant ;
 *   - bornes de taille sur les réponses renvoyées (pages, URLs, contenu) ;
 *   - timeout par appel (AbortSignal) → 504 ;
 *   - erreurs GÉNÉRIQUES : jamais l'URL ni la clé de WebClaw dans la réponse.
 */
import { Router, type Request, type Response } from "express";
import { libryAuth } from "../middleware/auth.js";
import { resolveHttpTarget } from "../utils/ssrf.js";
import {
  webclawScrape,
  webclawCrawl,
  webclawMap,
  webclawExtract,
  webclawBatch,
  isWebclawReachable,
  isWebclawConfigured,
  WebclawUnreachableError,
} from "../webclaw.js";
import { getTavilyConfig } from "../tavily.js";
import { getWebclawTimeoutMs } from "../config.js";

const router = Router();

// ── Bornes de taille (anti-abus / anti-saturation mémoire) ──
const MAX_BATCH_URLS = 25;
const MAX_CRAWL_PAGES = 50;
const MAX_MAP_URLS = 500;
const MAX_CONTENT_CHARS = 20_000;
const MAX_JSON_DEPTH = 6;
const MAX_ARRAY_ITEMS = 200;

// ── Validation SSRF d'une cible ──

type TargetOutcome = { ok: true; url: string } | { ok: false; status: 400 | 403; body: { error: string } };

async function validateTarget(rawUrl: unknown): Promise<TargetOutcome> {
  if (typeof rawUrl !== "string" || rawUrl.trim() === "") {
    return { ok: false, status: 400, body: { error: "Missing 'url' in body" } };
  }
  try {
    const target = await resolveHttpTarget(rawUrl.trim());
    return { ok: true, url: target.url };
  } catch (e) {
    const message = e instanceof Error ? e.message : "";
    if (message.startsWith("Blocked")) {
      // Message stable et non fuyant (ni IP résolue, ni cause du blocage).
      return { ok: false, status: 403, body: { error: "URL not allowed" } };
    }
    return { ok: false, status: 400, body: { error: "Invalid URL" } };
  }
}

type UrlsOutcome = { ok: true; urls: string[] } | { ok: false; status: 400 | 403; body: { error: string } };

async function validateUrlList(raw: unknown): Promise<UrlsOutcome> {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, status: 400, body: { error: "Missing 'urls' in body" } };
  }
  if (raw.length > MAX_BATCH_URLS) {
    return { ok: false, status: 400, body: { error: `Too many urls (max ${MAX_BATCH_URLS})` } };
  }
  const urls: string[] = [];
  for (const item of raw) {
    const outcome = await validateTarget(item);
    if (!outcome.ok) return outcome;
    urls.push(outcome.url);
  }
  return { ok: true, urls };
}

// ── Bornage récursif des réponses WebClaw ──

function boundDeep(value: unknown, maxChars: number, depth = 0): unknown {
  if (depth > MAX_JSON_DEPTH) return null;
  if (typeof value === "string") return value.length > maxChars ? value.slice(0, maxChars) : value;
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY_ITEMS).map((v) => boundDeep(v, maxChars, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = boundDeep(v, maxChars, depth + 1);
    }
    return out;
  }
  return value;
}

// ── Erreurs génériques ──

function failUpstream(res: Response, e: unknown, label: string): void {
  if (e instanceof WebclawUnreachableError && e.timedOut) {
    return void res.status(504).json({ error: `${label} timed out` });
  }
  return void res.status(502).json({ error: `${label} failed` });
}

// ── POST /fetch ──

router.post("/fetch", libryAuth, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const target = await validateTarget(body.url);
  if (!target.ok) return res.status(target.status).json(target.body);

  const format = typeof body.format === "string" && body.format.trim() ? body.format.trim() : "markdown";
  try {
    const scraped = await webclawScrape(target.url, { format, timeoutMs: getWebclawTimeoutMs() });
    const payload: Record<string, unknown> = {
      url: target.url,
      content: scraped.content.substring(0, MAX_CONTENT_CHARS),
      origin: "web",
    };
    if (scraped.title) payload.title = scraped.title;
    if (scraped.description) payload.description = scraped.description;
    if (scraped.contentType) payload.contentType = scraped.contentType;
    res.json(payload);
  } catch (e) {
    failUpstream(res, e, "Fetch");
  }
});

// ── POST /crawl ──

router.post("/crawl", libryAuth, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const target = await validateTarget(body.url);
  if (!target.ok) return res.status(target.status).json(target.body);

  const opts: Record<string, unknown> = {};
  if (typeof body.limit === "number" && body.limit > 0) opts.limit = Math.min(MAX_CRAWL_PAGES, Math.floor(body.limit));
  if (typeof body.maxDepth === "number" && body.maxDepth >= 0) opts.maxDepth = Math.min(10, Math.floor(body.maxDepth));

  try {
    const data = await webclawCrawl(target.url, opts, getWebclawTimeoutMs());
    const rawPages = Array.isArray(data?.pages) ? data.pages : [];
    const pages = rawPages.slice(0, MAX_CRAWL_PAGES).map((p: any) => ({
      url: p?.url ?? null,
      markdown: typeof p?.markdown === "string" ? p.markdown.slice(0, MAX_CONTENT_CHARS) : undefined,
      content: typeof p?.content === "string" ? p.content.slice(0, MAX_CONTENT_CHARS) : undefined,
    }));
    res.json({ url: target.url, origin: "web", pages, count: pages.length });
  } catch (e) {
    failUpstream(res, e, "Upstream request");
  }
});

// ── POST /map ──

router.post("/map", libryAuth, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const target = await validateTarget(body.url);
  if (!target.ok) return res.status(target.status).json(target.body);

  try {
    const data = await webclawMap(target.url, {}, getWebclawTimeoutMs());
    const urls = Array.isArray(data?.urls) ? data.urls.slice(0, MAX_MAP_URLS).map((u: unknown) => String(u)) : [];
    const count = typeof data?.count === "number" ? data.count : urls.length;
    res.json({ url: target.url, origin: "web", count, urls });
  } catch (e) {
    failUpstream(res, e, "Upstream request");
  }
});

// ── POST /extract ──

router.post("/extract", libryAuth, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const target = await validateTarget(body.url);
  if (!target.ok) return res.status(target.status).json(target.body);

  // Contrainte WebClaw : /v1/extract exige un `schema` OU un `prompt`.
  const hasSchema = body.schema !== undefined && body.schema !== null;
  const hasPrompt = typeof body.prompt === "string" && body.prompt.trim() !== "";
  if (!hasSchema && !hasPrompt) {
    return res.status(400).json({ error: "extract requires 'schema' or 'prompt'" });
  }

  const opts: Record<string, unknown> = {};
  if (hasSchema) opts.schema = body.schema;
  if (hasPrompt) opts.prompt = (body.prompt as string).slice(0, 4000);

  try {
    const data = await webclawExtract(target.url, opts, getWebclawTimeoutMs());
    const extracted = data && typeof data === "object" && "data" in data ? (data as any).data : data;
    res.json({ url: target.url, origin: "web", data: boundDeep(extracted, MAX_CONTENT_CHARS) });
  } catch (e) {
    failUpstream(res, e, "Upstream request");
  }
});

// ── POST /batch ──

router.post("/batch", libryAuth, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const list = await validateUrlList(body.urls);
  if (!list.ok) return res.status(list.status).json(list.body);

  try {
    const data = await webclawBatch(list.urls, {}, getWebclawTimeoutMs());
    const results = data && typeof data === "object" && "results" in data ? (data as any).results : data;
    res.json({ origin: "web", results: boundDeep(results, MAX_CONTENT_CHARS) });
  } catch (e) {
    failUpstream(res, e, "Upstream request");
  }
});

// ── GET /providers ──

router.get("/providers", libryAuth, async (_req: Request, res: Response) => {
  const tavilyConfigured = Boolean(getTavilyConfig().apiKey);
  const reachable = await isWebclawReachable();

  // Moteur réellement sollicité par la cascade : WebClaw si joignable, sinon
  // Tavily s'il est configuré, sinon le repli DuckDuckGo.
  const search: "webclaw" | "tavily" | "duckduckgo" = reachable
    ? "webclaw"
    : tavilyConfigured
      ? "tavily"
      : "duckduckgo";

  res.json({
    webclaw: { configured: isWebclawConfigured(), reachable },
    tavily: { configured: tavilyConfigured },
    search,
  });
});

export default router;
