import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { makeTestEnv, installMockFetch, jsonResponse, type TestEnv } from "./helpers.js";
import { createKey } from "../src/libry-auth.js";
import { archiveDoc, type DocEntry, type DocContent } from "../src/library-store.js";

let env: TestEnv;
let apiKey: string;

beforeEach(() => {
  env = makeTestEnv();
  apiKey = createKey("web-engine").key;
});

afterEach(() => env.cleanup());

function archiveWebclawDoc(): void {
  const entry: DocEntry = {
    name: "webclaw",
    version: "0.6.23",
    type: "tool",
    description: "web scraping and crawl tool",
    filePath: "tools/webclaw@0.6.23.json",
    keywords: ["webclaw", "scrape", "crawl", "markdown"],
    updatedAt: new Date().toISOString(),
  };
  const content: DocContent = {
    meta: { name: "webclaw", version: "0.6.23", type: "tool", updatedAt: new Date().toISOString() },
    summary: "outil de scraping web",
    keyPoints: [],
    api: [],
    examples: [],
  };
  archiveDoc(entry, content);
}

const DDG_MARKDOWN = [
  "[Résultat A](https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=1)",
  "[Résultat B](https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fb&rut=2)",
  "[Résultat C](https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fc&rut=3)",
  "[Résultat D](https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fd&rut=4)",
].join("\n");

describe("cascade /search — ① bibliothèque locale d'abord", () => {
  it("renvoie le local et n'effectue AUCUN appel réseau", async () => {
    archiveWebclawDoc();
    const { calls } = installMockFetch(() => jsonResponse({}, 500));
    const res = await request(env.app)
      .post("/api/librarian/search")
      .set("X-API-Key", apiKey)
      .send({ query: "webclaw scraping" });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].origin).toBe("local");
    expect(calls).toHaveLength(0);
  });
});

describe("cascade /search — ② WebClaw /v1/search", () => {
  it("utilise les résultats de /v1/search quand il répond 200", async () => {
    const { calls } = installMockFetch((req) => {
      if (req.url.includes("/v1/search")) {
        return jsonResponse({ results: [{ title: "Remote", url: "https://remote.example/", snippet: "s" }] });
      }
      return jsonResponse({}, 404);
    });
    const res = await request(env.app)
      .post("/api/librarian/search")
      .set("X-API-Key", apiKey)
      .send({ query: "requete introuvable zzqxx" });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0]).toMatchObject({ title: "Remote", origin: "web" });
    // Aucun repli : /v1/search a suffi.
    expect(calls.every((c) => c.url.includes("/v1/search"))).toBe(true);
  });

  it("bascule sur 501 sans erreur (repli DuckDuckGo)", async () => {
    const { calls } = installMockFetch((req) => {
      if (req.url.includes("/v1/search")) {
        return jsonResponse({ error: "search is not configured: start the server with SERPER_API_KEY" }, 501);
      }
      if (req.url.includes("/v1/scrape")) {
        if (req.body?.url?.includes("duckduckgo.com")) return jsonResponse({ content: DDG_MARKDOWN, markdown: DDG_MARKDOWN });
        return jsonResponse({ content: `contenu de ${req.body?.url}`, description: "desc" });
      }
      return jsonResponse({}, 404);
    });

    const res = await request(env.app)
      .post("/api/librarian/search")
      .set("X-API-Key", apiKey)
      .send({ query: "zzqxx zzqyy" });
    expect(res.status).toBe(200);
    expect(res.body.archived).toBe(false);
    expect(res.body.results.length).toBeGreaterThan(0);
    expect(res.body.results[0]).toMatchObject({ url: "https://example.com/a", origin: "web" });
    // Le repli DDG SCRAPE réellement les 3 premiers résultats : content présent.
    expect(res.body.results[0].content).toContain("contenu de https://example.com/a");
    // 1 appel /v1/search + scrapes.
    expect(calls.some((c) => c.url.includes("/v1/search"))).toBe(true);
    expect(calls.filter((c) => c.url.includes("/v1/scrape")).length).toBeGreaterThanOrEqual(4);
  });
});

describe("cascade /search — ③ Tavily si configuré", () => {
  it("utilise Tavily quand /v1/search est 501 et que Tavily est configuré", async () => {
    env.cleanup();
    env = makeTestEnv({ LIBRY_TAVILY_API_KEY: "tvly-secret-123" });
    apiKey = createKey("web-tavily").key;

    const { calls } = installMockFetch((req) => {
      if (req.url.includes("/v1/search")) return jsonResponse({ error: "not configured" }, 501);
      if (req.url.includes("api.tavily.com")) {
        return jsonResponse({ results: [{ title: "Tavily Hit", url: "https://tavily.example/", content: "corps tavily" }] });
      }
      return jsonResponse({}, 404);
    });

    const res = await request(env.app)
      .post("/api/librarian/search")
      .set("X-API-Key", apiKey)
      .send({ query: "zzqxx zzqyy" });
    expect(res.status).toBe(200);
    expect(res.body.results[0]).toMatchObject({ title: "Tavily Hit", origin: "web" });
    // Le repli DDG n'est PAS sollicité quand Tavily répond.
    expect(calls.some((c) => c.url.includes("/v1/scrape"))).toBe(false);
  });
});

describe("cascade /search — robustesse", () => {
  it("WebClaw injoignable → 200 avec liste vide (jamais d'exception)", async () => {
    // Aucun mock : le faux fetch par défaut échoue (réseau coupé).
    const res = await request(env.app)
      .post("/api/librarian/search")
      .set("X-API-Key", apiKey)
      .send({ query: "zzqxx zzqyy" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ results: [], archived: false });
  });

  it("sanitize le contenu web (email retiré)", async () => {
    installMockFetch((req) => {
      if (req.url.includes("/v1/search")) return jsonResponse({ error: "not configured" }, 501);
      if (req.url.includes("/v1/scrape")) {
        if (req.body?.url?.includes("duckduckgo.com")) {
          return jsonResponse({ content: "[A](https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa)", markdown: "" });
        }
        return jsonResponse({ content: "contact a@b.co maintenant" });
      }
      return jsonResponse({}, 404);
    });
    const res = await request(env.app)
      .post("/api/librarian/search")
      .set("X-API-Key", apiKey)
      .send({ query: "zzqxx zzqyy" });
    expect(res.body.results[0].content).toContain("[email removed]");
  });
});
