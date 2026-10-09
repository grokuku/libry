import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { makeTestEnv, type TestEnv } from "./helpers.js";
import { createKey } from "../src/libry-auth.js";

let env: TestEnv;
let apiKey: string;

beforeEach(() => {
  env = makeTestEnv();
  apiKey = createKey("contract-test").key;
});

afterEach(() => env.cleanup());

describe("GET /health", () => {
  it("renvoie le contrat {service, status, version}", async () => {
    const res = await request(env.app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ service: "libry", status: "ok" });
    expect(typeof res.body.version).toBe("string");
    expect(res.body.version).not.toBe("");
  });
});

describe("GET /api/librarian/status (publique)", () => {
  it("accessible sans clé", async () => {
    const res = await request(env.app).get("/api/librarian/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ totalDocs: 0, lastUpdated: "", lastScan: "" });
  });
});

describe("auth requise sur les routes bibliothèque", () => {
  it("GET /library sans clé → 401 verbatim", async () => {
    const res = await request(env.app).get("/api/librarian/library");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Invalid or missing API key" });
  });

  it("POST /search sans clé → 401 verbatim", async () => {
    const res = await request(env.app).post("/api/librarian/search").send({ query: "x" });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Invalid or missing API key" });
  });
});

describe("POST /api/librarian/search", () => {
  it("400 verbatim si query absent", async () => {
    const res = await request(env.app).post("/api/librarian/search").set("X-API-Key", apiKey).send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Missing 'query' in body" });
  });

  it("200 avec la forme {results, archived} (miss local sans fournisseur web)", async () => {
    const res = await request(env.app)
      .post("/api/librarian/search")
      .set("X-API-Key", apiKey)
      .send({ query: "zzz introuvable xyz" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ results: [], archived: false });
  });
});

describe("GET /api/librarian/doc/:name", () => {
  it("404 verbatim si le doc n'existe pas", async () => {
    const res = await request(env.app).get("/api/librarian/doc/inconnu").set("X-API-Key", apiKey);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Doc not found" });
  });
});

describe("POST /api/librarian/archive", () => {
  it("400 verbatim si champs obligatoires manquants", async () => {
    const res = await request(env.app).post("/api/librarian/archive").set("X-API-Key", apiKey).send({ name: "a" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Missing required fields: name, version, content" });
  });

  it("400 verbatim si name/version contient un séparateur ou ..", async () => {
    const res = await request(env.app)
      .post("/api/librarian/archive")
      .set("X-API-Key", apiKey)
      .send({ name: "../evil", version: "1.0", content: { summary: "s" } });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "name and version must be valid path components (no slashes, no backslashes, no '..')",
    });
  });

  it("201 puis lecture via GET /doc et présence dans /library", async () => {
    const res = await request(env.app)
      .post("/api/librarian/archive")
      .set("X-API-Key", apiKey)
      .send({
        name: "webclaw",
        version: "0.6.23",
        type: "tool",
        content: { summary: "outil de scraping", keyPoints: ["scrape", "crawl"], rawContent: "contact me@x.io" },
      });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.entry.name).toBe("webclaw");
    expect(res.body.entry.filePath).toBe("tools/webclaw@0_6_23.json");

    const doc = await request(env.app).get("/api/librarian/doc/webclaw").set("X-API-Key", apiKey);
    expect(doc.status).toBe(200);
    expect(doc.body.summary).toBe("outil de scraping");
    expect(doc.body.rawContent).toBe("contact [email removed]");

    const lib = await request(env.app).get("/api/librarian/library").set("X-API-Key", apiKey);
    expect(lib.status).toBe(200);
    expect(lib.body.library).toHaveLength(1);
    expect(lib.body.lastUpdated).not.toBe("");
  });
});

describe("POST /api/librarian/update", () => {
  it("501 si aucune liste configurée", async () => {
    const res = await request(env.app).post("/api/librarian/update").set("X-API-Key", apiKey).send({});
    expect(res.status).toBe(501);
    expect(res.body.error).toContain("not configured");
  });

  it("501 (moteur non branché) avec une liste fournie", async () => {
    const res = await request(env.app)
      .post("/api/librarian/update")
      .set("X-API-Key", apiKey)
      .send({ cwds: ["/projects/demo"] });
    expect(res.status).toBe(501);
    expect(res.body.cwds).toEqual(["/projects/demo"]);
  });
});

describe("gestion des clés (/keys)", () => {
  it("POST sans name → 400 verbatim", async () => {
    const res = await request(env.app).post("/api/librarian/keys").send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "name is required" });
  });

  it("POST puis GET liste sans exposer le hash, DELETE inconnu → 404 verbatim", async () => {
    const created = await request(env.app).post("/api/librarian/keys").send({ name: "yuki" });
    expect(created.status).toBe(201);
    expect(created.body.key).toMatch(/^libry_[0-9a-f]{32}$/);

    const list = await request(env.app).get("/api/librarian/keys");
    expect(list.status).toBe(200);
    const ids = list.body.keys.map((k: any) => k.id);
    expect(ids).toContain(created.body.id);
    expect(JSON.stringify(list.body)).not.toContain("scrypt:");

    const del = await request(env.app).delete("/api/librarian/keys/libryk_inexistant");
    expect(del.status).toBe(404);
    expect(del.body).toEqual({ error: "Key not found" });

    const del2 = await request(env.app).delete(`/api/librarian/keys/${created.body.id}`);
    expect(del2.status).toBe(200);
    expect(del2.body).toEqual({ success: true });
  });
});
