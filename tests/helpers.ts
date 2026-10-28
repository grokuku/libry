import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Express } from "express";
import { createApp } from "../src/index.js";
import { resetAuthCaches } from "../src/libry-auth.js";
import { resetSettingsCache } from "../src/settings-store.js";
import { setSessionTtlForTests } from "../src/session-store.js";
import { setFetchForTests, type FetchLike } from "../src/utils/http.js";
import { setScrapeDelayForTests } from "../src/web-search.js";
import { resetSsrfAuditLogForTests } from "../src/utils/ssrf.js";

export interface TestEnv {
  app: Express;
  dir: string;
  docsDir: string;
  keysFile: string;
  cleanup: () => void;
}

/** Réponse JSON factice (helper de mock réseau). */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Requête interceptée par le faux réseau. */
export interface MockRequest {
  url: string;
  method: string;
  body: any;
  signal?: AbortSignal;
}

/**
 * Installe un faux `fetch` piloté par un handler, enregistre les requêtes.
 * `req.body` est le JSON désérialisé (null si absent/illisible).
 */
export function installMockFetch(
  handler: (req: MockRequest) => Response | Promise<Response>,
): { calls: MockRequest[] } {
  const calls: MockRequest[] = [];
  setFetchForTests(async (input, init) => {
    let body: any = null;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : null;
    } catch {
      body = null;
    }
    const req: MockRequest = {
      url: input,
      method: init?.method ?? "GET",
      body,
      signal: init?.signal ?? undefined,
    };
    calls.push(req);
    return handler(req);
  });
  return { calls };
}

/**
 * Faux `fetch` par défaut : AUCUN accès réseau. Toute requête échoue, ce qui
 * simule un WebClaw injoignable — les tests qui ont besoin d'un comportement
 * précis appellent `setFetchForTests(...)`.
 */
const unreachableFetch: FetchLike = async () => {
  throw new TypeError("network disabled in tests");
};

/**
 * Prépare un environnement de test isolé : répertoire de données temporaire,
 * variables LIBRY_* nettoyées, caches d'auth réinitialisés, réseau coupé.
 * Retourne l'app Express prête pour supertest.
 */
export function makeTestEnv(overrides: Record<string, string> = {}): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), "libry-test-"));
  const docsDir = join(dir, "docs");
  const keysFile = join(dir, "libry-keys.json");

  process.env.LIBRY_DATA_DIR = dir;
  process.env.LIBRY_DOCS_DIR = docsDir;
  process.env.LIBRY_KEYS_FILE = keysFile;
  delete process.env.LIBRY_LEGACY_KEYS;
  delete process.env.LIBRY_ADMIN_KEYS;
  delete process.env.LIBRY_UPDATE_CWDS;
  delete process.env.LIBRY_ALLOWED_ORIGINS;
  delete process.env.LIBRY_SHOTS_DIR;
  delete process.env.LIBRY_SHOT_CONCURRENCY;
  delete process.env.LIBRY_SHOT_QUEUE_MAX;
  delete process.env.LIBRY_SHOT_TTL_HOURS;
  delete process.env.LIBRY_SHOT_INLINE_HTML;
  delete process.env.LIBRY_CHROMIUM_NO_SANDBOX;
  delete process.env.CHROMIUM_PATH;
  delete process.env.LIBRY_SESSION_TTL_HOURS;
  // Liste blanche des adresses internes : VIDE par défaut (politique historique).
  delete process.env.LIBRY_SSRF_ALLOWED_HOSTS;
  delete process.env.LIBRY_SSRF_ALLOWED_CIDRS;
  // Moteur web : configuration neutralisée + réseau coupé.
  delete process.env.WEBCLAW_URL;
  delete process.env.WEBCLAW_API_KEY;
  delete process.env.LIBRY_TAVILY_API_KEY;
  delete process.env.LIBRY_WEBCLAW_TIMEOUT_MS;
  delete process.env.LIBRY_TAVILY_TIMEOUT_MS;
  for (const [k, v] of Object.entries(overrides)) process.env[k] = v;

  resetAuthCaches();
  resetSettingsCache();
  resetSsrfAuditLogForTests();
  setSessionTtlForTests(null);
  setFetchForTests(unreachableFetch);
  setScrapeDelayForTests(0);

  return {
    app: createApp(),
    dir,
    docsDir,
    keysFile,
    cleanup: () => {
      setFetchForTests(null);
      setScrapeDelayForTests(1000);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
