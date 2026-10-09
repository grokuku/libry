import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { readdirSync } from "fs";
import { tmpdir } from "os";
import { makeTestEnv, type TestEnv } from "./helpers.js";
import { createKey } from "../src/libry-auth.js";
import { setCaptureImplForTests } from "../src/screenshot.js";

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(120, 0x2a),
]);

let env: TestEnv;
let apiKey: string;

beforeEach(() => {
  env = makeTestEnv();
  apiKey = createKey("shot-test").key;
  setCaptureImplForTests(null);
});

afterEach(() => {
  setCaptureImplForTests(null);
  env.cleanup();
});

describe("POST /api/librarian/screenshot — auth et validation", () => {
  it("401 sans clé", async () => {
    const res = await request(env.app).post("/api/librarian/screenshot").send({ url: "https://example.com" });
    expect(res.status).toBe(401);
  });

  it("400 si aucune cible", async () => {
    const res = await request(env.app).post("/api/librarian/screenshot").set("X-API-Key", apiKey).send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Missing 'url' in body" });
  });

  it("400 si URL invalide", async () => {
    const res = await request(env.app)
      .post("/api/librarian/screenshot")
      .set("X-API-Key", apiKey)
      .send({ url: "not a url" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid URL" });
  });

  it("400 : HTML inline désactivé par défaut", async () => {
    const res = await request(env.app)
      .post("/api/librarian/screenshot")
      .set("X-API-Key", apiKey)
      .send({ inline: true, html: "<h1>mockup</h1>" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Inline HTML capture is disabled" });
  });
});

describe("POST /api/librarian/screenshot — SSRF AVANT spawn", () => {
  it("403 non fuyant sur 127.0.0.1, sans jamais appeler la capture", async () => {
    let called = false;
    setCaptureImplForTests(async () => {
      called = true;
      return { buffer: PNG, width: 1, height: 1, bytes: PNG.length };
    });
    const res = await request(env.app)
      .post("/api/librarian/screenshot")
      .set("X-API-Key", apiKey)
      .send({ url: "http://127.0.0.1/" });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "URL not allowed" });
    // Le message ne fuit NI l'IP résolue NI la nature du blocage.
    expect(JSON.stringify(res.body)).not.toMatch(/127|loopback|blocked|private|link-local|metadata/i);
    expect(called).toBe(false);
  });

  it("403 sur la metadata cloud 169.254.169.254", async () => {
    const res = await request(env.app)
      .post("/api/librarian/screenshot")
      .set("X-API-Key", apiKey)
      .send({ url: "http://169.254.169.254/latest/meta-data/" });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "URL not allowed" });
  });

  it("400 sur file:// (jamais exposé : cible non http/https)", async () => {
    const res = await request(env.app)
      .post("/api/librarian/screenshot")
      .set("X-API-Key", apiKey)
      .send({ url: "file:///etc/passwd" });
    // file:// n'est pas http/https → invalid target (400).
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid URL" });
  });
});

describe("POST /api/librarian/screenshot — succès + service de l'image", () => {
  it("200 puis GET /shot/:id.png sert le PNG", async () => {
    setCaptureImplForTests(async (opts) => ({
      buffer: PNG,
      width: opts.width ?? 1440,
      height: opts.height ?? 900,
      bytes: PNG.length,
    }));

    const res = await request(env.app)
      .post("/api/librarian/screenshot")
      .set("X-API-Key", apiKey)
      .send({ url: "https://example.com", width: 800, height: 600 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mimeType: "image/png", width: 800, height: 600, origin: "web" });
    expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.bytes).toBe(PNG.length);
    expect(res.body.url).toBe("https://example.com/");

    const img = await request(env.app)
      .get(`/api/librarian/shot/${res.body.id}.png`)
      .set("X-API-Key", apiKey);
    expect(img.status).toBe(200);
    expect(img.headers["content-type"]).toContain("image/png");
    expect(Buffer.compare(img.body, PNG)).toBe(0);
  });

  it("l'image reste protégée par l'auth (401 sans clé)", async () => {
    const res = await request(env.app).get("/api/librarian/shot/00000000-0000-0000-0000-000000000000.png");
    expect(res.status).toBe(401);
  });

  it("404 sur une image inconnue", async () => {
    const res = await request(env.app)
      .get("/api/librarian/shot/00000000-0000-0000-0000-000000000000.png")
      .set("X-API-Key", apiKey);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Shot not found" });
  });

  it("404 sur un id malformé (anti-traversal)", async () => {
    const res = await request(env.app)
      .get("/api/librarian/shot/..%2f..%2fetc%2fpasswd.png")
      .set("X-API-Key", apiKey);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/librarian/screenshot — concurrence bornée", () => {
  it("2 simultanées puis 429 + Retry-After quand la file est nulle", async () => {
    env.cleanup();
    env = makeTestEnv({ LIBRY_SHOT_CONCURRENCY: "2", LIBRY_SHOT_QUEUE_MAX: "0" });
    apiKey = createKey("shot-concurrency").key;

    setCaptureImplForTests(
      async () =>
        await new Promise((resolve) =>
          setTimeout(() => resolve({ buffer: PNG, width: 10, height: 10, bytes: PNG.length }), 800),
        ),
    );

    const post = () =>
      request(env.app)
        .post("/api/librarian/screenshot")
        .set("X-API-Key", apiKey)
        .send({ url: "https://example.com" });

    const [r1, r2, r3] = await Promise.all([post(), post(), post()]);
    const statuses = [r1.status, r2.status, r3.status].sort();
    expect(statuses).toEqual([200, 200, 429]);

    const rejected = [r1, r2, r3].find((r) => r.status === 429)!;
    expect(rejected.headers["retry-after"]).toBeDefined();
    expect(Number(rejected.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(rejected.body.error).toBe("Too many concurrent screenshot requests");
    expect(typeof rejected.body.retryAfterMs).toBe("number");
  }, 30_000);

  it("429 sur HTML inline : aucun dossier temporaire laissé dans /tmp", async () => {
    env.cleanup();
    env = makeTestEnv({ LIBRY_SHOT_CONCURRENCY: "1", LIBRY_SHOT_QUEUE_MAX: "0", LIBRY_SHOT_INLINE_HTML: "true" });
    apiKey = createKey("shot-inline-429").key;

    setCaptureImplForTests(
      async () =>
        await new Promise((resolve) =>
          setTimeout(() => resolve({ buffer: PNG, width: 10, height: 10, bytes: PNG.length }), 800),
        ),
    );

    const before = new Set(readdirSync(tmpdir()));
    const post = () =>
      request(env.app)
        .post("/api/librarian/screenshot")
        .set("X-API-Key", apiKey)
        .send({ inline: true, html: "<h1>mockup</h1>" });

    const [r1, r2] = await Promise.all([post(), post()]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 429]);

    // Le dossier `libry-shot-html-*` du premier appel doit avoir été nettoyé ;
    // le second (429) ne doit jamais en avoir créé.
    const leaked = readdirSync(tmpdir()).filter((n) => n.startsWith("libry-shot-html-") && !before.has(n));
    expect(leaked).toEqual([]);
  }, 30_000);
});
