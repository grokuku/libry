/**
 * Socle statique (dossier `public/`) : index, fichiers, absence de fallback
 * SPA, traversée de chemin refusée, et non-capture de l'API existante.
 * Aucun accès réseau : l'environnement de test est isolé (makeTestEnv).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { makeTestEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;

beforeEach(() => {
  env = makeTestEnv();
});

afterEach(() => env.cleanup());

describe("socle statique — index", () => {
  it("GET / → 200 text/html (les deux onglets sont présents)", async () => {
    const res = await request(env.app).get("/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/html\b/);
    expect(res.text).toContain("Documentation");
    expect(res.text).toContain("Réglages");
    expect(res.text).toContain("app.js");
  });
});

describe("socle statique — fichiers", () => {
  it("GET /styles.css → 200 text/css", async () => {
    const res = await request(env.app).get("/styles.css");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/css\b/);
    expect(res.text).toContain("--libry-bg");
  });

  it("GET /app.js → 200 javascript", async () => {
    const res = await request(env.app).get("/app.js");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^(text|application)\/javascript\b/);
    expect(res.text).toContain("activate");
  });
});

describe("socle statique — pas de fallback SPA", () => {
  it("route inconnue → 404 (pas d'index servi)", async () => {
    const res = await request(env.app).get("/nimportequoi");
    expect(res.status).toBe(404);
    expect(res.text).not.toContain("Documentation");
  });

  it("chemin profond inconnu → 404", async () => {
    const res = await request(env.app).get("/sous/dossier/inconnu");
    expect(res.status).toBe(404);
  });
});

describe("socle statique — traversée de chemin", () => {
  it("..%2f encodé → 403 ou 404, jamais package.json", async () => {
    const res = await request(env.app).get("/..%2fpackage.json");
    expect([403, 404]).toContain(res.status);
    expect(res.text).not.toContain('"name": "libry"');
  });

  it("../ littéral → 403 ou 404, jamais src/index.ts", async () => {
    const res = await request(env.app).get("/../src/index.ts");
    expect([403, 404]).toContain(res.status);
    expect(res.text).not.toContain("createApp");
  });
});

describe("API existante intacte (non capturée par le statique)", () => {
  it("GET /health → 200 {service, status}", async () => {
    const res = await request(env.app).get("/health");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toMatchObject({ service: "libry", status: "ok" });
  });

  it("GET /api/librarian/status → 200 public, forme inchangée", async () => {
    const res = await request(env.app).get("/api/librarian/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ totalDocs: 0, lastUpdated: "", lastScan: "" });
  });

  it("GET /api/librarian/library sans identité → 401 contrat figé", async () => {
    const res = await request(env.app).get("/api/librarian/library");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Invalid or missing API key" });
  });
});
