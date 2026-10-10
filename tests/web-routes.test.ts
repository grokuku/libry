import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { makeTestEnv, installMockFetch, jsonResponse, type TestEnv } from "./helpers.js";
import { createKey } from "../src/libry-auth.js";
import { setFetchForTests } from "../src/utils/http.js";

let env: TestEnv;
let apiKey: string;

/** Cible PUBLIQUE littérale (aucune résolution DNS → tests sans réseau). */
const PUBLIC_URL = "http://8.8.8.8/";

beforeEach(() => {
  env = makeTestEnv();
  apiKey = createKey("web-routes").key;
});

afterEach(() => env.cleanup());

const AUTH_ROUTES: Array<[string, string]> = [
  ["post", "/api/librarian/fetch"],
  ["post", "/api/librarian/crawl"],
  ["post", "/api/librarian/map"],
  ["post", "/api/librarian/extract"],
  ["post", "/api/librarian/batch"],
];

describe("routes web — auth", () => {
  it("401 sans clé sur toutes les routes web", async () => {
    for (const [method, path] of AUTH_ROUTES) {
      const res = await (request(env.app) as any)[method](path).send({});
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "Invalid or missing API key" });
    }
    const providers = await request(env.app).get("/api/librarian/providers");
    expect(providers.status).toBe(401);
  });
});

describe("POST /api/librarian/fetch", () => {
  it("400 si url absente", async () => {
    const res = await request(env.app).post("/api/librarian/fetch").set("X-API-Key", apiKey).send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Missing 'url' in body" });
  });

  it("403 non fuyant sur 127.0.0.1 (SSRF), sans appel réseau", async () => {
    const { calls } = installMockFetch(() => jsonResponse({}, 200));
    const res = await request(env.app)
      .post("/api/librarian/fetch")
      .set("X-API-Key", apiKey)
      .send({ url: "http://127.0.0.1/secret" });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "URL not allowed" });
    expect(calls).toHaveLength(0);
  });

  it("400 sur file:// (jamais exposé)", async () => {
    const res = await request(env.app)
      .post("/api/librarian/fetch")
      .set("X-API-Key", apiKey)
      .send({ url: "file:///etc/passwd" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid URL" });
  });

  it("200 avec {url, title?, description?, content, contentType?, origin:'web'} (mocké)", async () => {
    installMockFetch((req) => {
      if (req.url.includes("/v1/scrape")) {
        return jsonResponse({ content: "# Page", title: "Titre", description: "Desc", contentType: "text/html" });
      }
      return jsonResponse({}, 404);
    });
    const res = await request(env.app)
      .post("/api/librarian/fetch")
      .set("X-API-Key", apiKey)
      .send({ url: PUBLIC_URL });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      url: PUBLIC_URL,
      content: "# Page",
      title: "Titre",
      description: "Desc",
      contentType: "text/html",
      origin: "web",
    });
  });

  it("502 si WebClaw est injoignable (aucun secret divulgué)", async () => {
    env.cleanup();
    env = makeTestEnv({ WEBCLAW_API_KEY: "super-secret-key" });
    apiKey = createKey("web-502").key;
    // Aucun mock : réseau coupé → WebClaw injoignable.
    const res = await request(env.app)
      .post("/api/librarian/fetch")
      .set("X-API-Key", apiKey)
      .send({ url: PUBLIC_URL });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "Fetch failed" });
    expect(JSON.stringify(res.body)).not.toContain("super-secret-key");
    expect(JSON.stringify(res.body)).not.toContain("localhost");
  });

  it("504 quand WebClaw dépasse le timeout", async () => {
    env.cleanup();
    env = makeTestEnv({ LIBRY_WEBCLAW_TIMEOUT_MS: "30" });
    apiKey = createKey("web-504").key;
    setFetchForTests(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
    );
    const res = await request(env.app)
      .post("/api/librarian/fetch")
      .set("X-API-Key", apiKey)
      .send({ url: PUBLIC_URL });
    expect(res.status).toBe(504);
    expect(res.body).toEqual({ error: "Fetch timed out" });
  });
});

describe("pass-through /crawl | /map | /extract | /batch", () => {
  it("/crawl 200 normalisé (mocké)", async () => {
    installMockFetch((req) => {
      if (req.url.includes("/v1/crawl")) return jsonResponse({ pages: [{ url: "https://a.example/", markdown: "# A" }] });
      return jsonResponse({}, 404);
    });
    const res = await request(env.app).post("/api/librarian/crawl").set("X-API-Key", apiKey).send({ url: PUBLIC_URL });
    expect(res.status).toBe(200);
    expect(res.body.origin).toBe("web");
    expect(res.body.pages[0].markdown).toBe("# A");
    expect(res.body.count).toBe(1);
  });

  it("/map 200 normalisé (mocké)", async () => {
    installMockFetch((req) => {
      if (req.url.includes("/v1/map")) return jsonResponse({ count: 2, urls: ["https://a.example/", "https://b.example/"] });
      return jsonResponse({}, 404);
    });
    const res = await request(env.app).post("/api/librarian/map").set("X-API-Key", apiKey).send({ url: PUBLIC_URL });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      url: PUBLIC_URL,
      origin: "web",
      count: 2,
      urls: ["https://a.example/", "https://b.example/"],
    });
  });

  it("/extract 400 clair sans schema ni prompt", async () => {
    const res = await request(env.app).post("/api/librarian/extract").set("X-API-Key", apiKey).send({ url: PUBLIC_URL });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "extract requires 'schema' or 'prompt'" });
  });

  it("/extract 200 avec prompt (mocké)", async () => {
    installMockFetch((req) => {
      if (req.url.includes("/v1/extract")) return jsonResponse({ data: { titre: "Extrait" } });
      return jsonResponse({}, 404);
    });
    const res = await request(env.app)
      .post("/api/librarian/extract")
      .set("X-API-Key", apiKey)
      .send({ url: PUBLIC_URL, prompt: "extrait le titre" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: PUBLIC_URL, origin: "web", data: { titre: "Extrait" } });
  });

  it("/batch 400 sans urls", async () => {
    const res = await request(env.app).post("/api/librarian/batch").set("X-API-Key", apiKey).send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Missing 'urls' in body" });
  });

  it("/batch 200 normalisé (mocké)", async () => {
    installMockFetch((req) => {
      if (req.url.includes("/v1/batch")) return jsonResponse({ results: [{ url: PUBLIC_URL, markdown: "# B" }] });
      return jsonResponse({}, 404);
    });
    const res = await request(env.app)
      .post("/api/librarian/batch")
      .set("X-API-Key", apiKey)
      .send({ urls: [PUBLIC_URL] });
    expect(res.status).toBe(200);
    expect(res.body.origin).toBe("web");
    expect(res.body.results[0].markdown).toBe("# B");
  });

  it("SSRF sur une URL cible refusée → 403, sans appel réseau", async () => {
    const { calls } = installMockFetch(() => jsonResponse({}, 200));
    const res = await request(env.app)
      .post("/api/librarian/map")
      .set("X-API-Key", apiKey)
      .send({ url: "http://169.254.169.254/latest/meta-data/" });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "URL not allowed" });
    expect(calls).toHaveLength(0);
  });

  it("502 quand WebClaw est injoignable", async () => {
    const res = await request(env.app).post("/api/librarian/crawl").set("X-API-Key", apiKey).send({ url: PUBLIC_URL });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "Upstream request failed" });
  });
});

describe("GET /api/librarian/providers", () => {
  it("booléens seulement, aucun secret quand rien n'est configuré", async () => {
    installMockFetch(() => jsonResponse({}, 502));
    const res = await request(env.app).get("/api/librarian/providers").set("X-API-Key", apiKey);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      webclaw: { configured: false, apiKey: false, reachable: false },
      tavily: { configured: false },
      search: "duckduckgo",
    });
  });

  it("configured/reachable vrais et search='webclaw' (aucune fuite de clé)", async () => {
    env.cleanup();
    env = makeTestEnv({ WEBCLAW_API_KEY: "super-secret-key", LIBRY_TAVILY_API_KEY: "tvly-secret" });
    apiKey = createKey("web-providers").key;
    installMockFetch((req) => {
      if (req.url.includes("/health")) return jsonResponse({ status: "ok" }, 200);
      return jsonResponse({}, 404);
    });
    const res = await request(env.app).get("/api/librarian/providers").set("X-API-Key", apiKey);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      webclaw: { configured: true, apiKey: true, reachable: true },
      tavily: { configured: true },
      search: "webclaw",
    });
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain("super-secret-key");
    expect(serialized).not.toContain("tvly-secret");
  });
});
