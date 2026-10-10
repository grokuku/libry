import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { makeTestEnv, type TestEnv } from "./helpers.js";
import {
  createKey,
  validateKey,
  keyIdOf,
  deriveIdFromSecret,
  loadKeys,
  resetAuthCaches,
} from "../src/libry-auth.js";
import { resetLoginRateLimitForTests } from "../src/routes/admin.js";

let env: TestEnv;

beforeEach(async () => {
  env = makeTestEnv();
  await resetLoginRateLimitForTests();
});

afterEach(() => {
  env.cleanup();
  delete process.env.LIBRY_LEGACY_KEYS;
});

// ── Helpers ──

function setCookies(res: any): string[] {
  const raw = res.headers["set-cookie"];
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

/** Agent supertest connecté (GET /session pour le CSRF, puis POST /login). */
async function login(password: string) {
  const agent = request.agent(env.app);
  const first = await agent.get("/api/admin/session");
  const res = await agent
    .post("/api/admin/login")
    .set("X-CSRF-Token", first.body.csrfToken)
    .send({ password });
  return { agent, res };
}

/** Archive un document via l'API (nécessite une clé). */
async function archive(apiKey: string, name: string, version: string, summary = "résumé"): Promise<void> {
  const res = await request(env.app)
    .post("/api/librarian/archive")
    .set("X-API-Key", apiKey)
    .send({ name, version, type: "tool", content: { summary, keyPoints: [name] } });
  expect(res.status).toBe(201);
}

// ── Création / liste / masquage ──

describe("POST /api/librarian/keys", () => {
  it("crée une clé non-admin : secret affiché une fois, id non secret", async () => {
    const res = await request(env.app).post("/api/librarian/keys").send({ name: "yuki" });
    expect(res.status).toBe(201);
    expect(res.body.key).toMatch(/^libry_[0-9a-f]{32}$/);
    expect(res.body.id).toMatch(/^libryk_[0-9a-f]{12}$/);
    expect(res.body.admin).toBeUndefined();
    expect(validateKey(res.body.key)).toBe(true);
  });

  it("crée une clé admin:true (champ optionnel désormais transmis)", async () => {
    const res = await request(env.app).post("/api/librarian/keys").send({ name: "boss", admin: true });
    expect(res.status).toBe(201);
    expect(res.body.admin).toBe(true);

    const list = await request(env.app).get("/api/librarian/keys");
    const found = list.body.keys.find((k: any) => k.id === res.body.id);
    expect(found).toBeDefined();
    expect(found.admin).toBe(true);
  });

  it("admin non booléen → ignoré (jamais truthy accidentel)", async () => {
    const res = await request(env.app).post("/api/librarian/keys").send({ name: "x", admin: "yes" });
    expect(res.status).toBe(201);
    expect(res.body.admin).toBeUndefined();
  });

  it("sans name → 400 verbatim (contrat inchangé)", async () => {
    const res = await request(env.app).post("/api/librarian/keys").send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "name is required" });
  });
});

describe("GET /api/librarian/keys", () => {
  it("liste masquée : ni hash ni secret en clair", async () => {
    const created = await request(env.app).post("/api/librarian/keys").send({ name: "yuki" });
    const list = await request(env.app).get("/api/librarian/keys");
    expect(list.status).toBe(200);
    const found = list.body.keys.find((k: any) => k.id === created.body.id);
    expect(found).toBeDefined();
    expect(found.key).toBe(created.body.key.slice(0, 12) + "…");
    expect(JSON.stringify(list.body)).not.toContain(created.body.key);
    expect(JSON.stringify(list.body)).not.toContain("scrypt:");
  });
});

// ── Régénération ──

describe("POST /api/librarian/keys/:id/regenerate", () => {
  it("même id/name/createdAt/admin, nouveau secret, l'ancien cesse de valider", async () => {
    const created = await request(env.app).post("/api/librarian/keys").send({ name: "yuki", admin: true });
    const oldKey = created.body.key;

    const regen = await request(env.app).post(`/api/librarian/keys/${created.body.id}/regenerate`).send();
    expect(regen.status).toBe(201);
    expect(regen.body.id).toBe(created.body.id);
    expect(regen.body.name).toBe(created.body.name);
    expect(regen.body.createdAt).toBe(created.body.createdAt);
    expect(regen.body.admin).toBe(true);
    expect(regen.body.key).toMatch(/^libry_[0-9a-f]{32}$/);
    expect(regen.body.key).not.toBe(oldKey);

    // L'ancien secret ne vaut plus rien, le nouveau oui.
    expect(validateKey(oldKey)).toBe(false);
    expect(validateKey(regen.body.key)).toBe(true);
  });

  it("HTTP : ancien secret → 401, nouveau secret → 200 (même /library)", async () => {
    const created = await request(env.app).post("/api/librarian/keys").send({ name: "yuki" });
    const regen = await request(env.app).post(`/api/librarian/keys/${created.body.id}/regenerate`).send();

    const old = await request(env.app).get("/api/librarian/library").set("X-API-Key", created.body.key);
    expect(old.status).toBe(401);
    const fresh = await request(env.app).get("/api/librarian/library").set("X-API-Key", regen.body.key);
    expect(fresh.status).toBe(200);
  });

  it("id inconnu → 404 verbatim", async () => {
    const res = await request(env.app).post("/api/librarian/keys/libryk_inexistant/regenerate").send();
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Key not found" });
  });

  it("ne touche JAMAIS une clé legacy d'environnement (id dérivé → 404)", async () => {
    const legacy = "lib-feedfacefeedfacefeedfacefeedface";
    env.cleanup();
    env = makeTestEnv({ LIBRY_LEGACY_KEYS: legacy });
    const derivedId = deriveIdFromSecret(legacy);

    const res = await request(env.app).post(`/api/librarian/keys/${derivedId}/regenerate`).send();
    expect(res.status).toBe(404);
    // La clé legacy reste valide (jamais régénérée, jamais supprimée).
    expect(validateKey(legacy)).toBe(true);
  });

  it("une clé héritée sans id persisté conserve EXACTEMENT le même id après régénération", async () => {
    // Clé legacy dans le FICHIER (secret en clair), sans champ id.
    const plaintext = "lib-deadbeefdeadbeefdeadbeefdeadbeef";
    mkdirSync(join(env.dir), { recursive: true });
    writeFileSync(
      env.keysFile,
      JSON.stringify([{ name: "legacy-file", createdAt: "2026-01-01T00:00:00.000Z", keyPreview: "lib-dead…", key: plaintext }]),
      { mode: 0o600 },
    );
    resetAuthCaches();

    const before = keyIdOf(loadKeys()[0]);
    expect(before).toBe(deriveIdFromSecret(plaintext));

    const regen = await request(env.app).post(`/api/librarian/keys/${before}/regenerate`).send();
    expect(regen.status).toBe(201);
    expect(regen.body.id).toBe(before);
    // L'id est désormais persisté explicitement et stable.
    expect(loadKeys()[0].id).toBe(before);
    expect(validateKey(plaintext)).toBe(false);
    expect(validateKey(regen.body.key)).toBe(true);
  });
});

// ── Révocation ──

describe("DELETE /api/librarian/keys/:id", () => {
  it("révoque par id non secret ; seconde fois → 404", async () => {
    const created = await request(env.app).post("/api/librarian/keys").send({ name: "yuki" });
    const del = await request(env.app).delete(`/api/librarian/keys/${created.body.id}`);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ success: true });
    expect(validateKey(created.body.key)).toBe(false);

    const again = await request(env.app).delete(`/api/librarian/keys/${created.body.id}`);
    expect(again.status).toBe(404);
    expect(again.body).toEqual({ error: "Key not found" });
  });
});

// ── Suppression de documents + réindexation ──

describe("DELETE /api/librarian/doc/:name", () => {
  it("supprime le fichier et l'entrée d'index ; doc introuvable → 404", async () => {
    const apiKey = createKey("docs").key;
    await archive(apiKey, "webclaw", "0.6.23");

    const file = join(env.docsDir, "tools", "webclaw@0_6_23.json");
    expect(existsSync(file)).toBe(true);

    const del = await request(env.app).delete("/api/librarian/doc/webclaw").query({ version: "0.6.23" });
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ success: true, deleted: 1 });

    expect(existsSync(file)).toBe(false);
    const doc = await request(env.app).get("/api/librarian/doc/webclaw").set("X-API-Key", apiKey);
    expect(doc.status).toBe(404);
    const lib = await request(env.app).get("/api/librarian/library").set("X-API-Key", apiKey);
    expect(lib.body.library).toHaveLength(0);

    const missing = await request(env.app).delete("/api/librarian/doc/inconnu");
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: "Doc not found" });
  });

  it("nom dangereux (traversée) → jamais trouvé (404, aucun fichier hors zone)", async () => {
    const res = await request(env.app).delete("/api/librarian/doc/..%2Fevil");
    expect(res.status).toBe(404);
  });
});

describe("POST /api/librarian/library/reindex", () => {
  it("reconstruit index.json depuis docs/tools/*.json", async () => {
    const toolsDir = join(env.docsDir, "tools");
    mkdirSync(toolsDir, { recursive: true });
    const content = {
      meta: { name: "manuel", version: "1.2.3", type: "tool", updatedAt: "2026-02-02T00:00:00.000Z" },
      summary: "import manuel",
      keyPoints: ["import", "manuel"],
      api: [],
      examples: [],
    };
    writeFileSync(join(toolsDir, "manuel@1.2.3.json"), JSON.stringify(content));
    // Fichier illisible → ignoré sans faire échouer la réindexation.
    writeFileSync(join(toolsDir, "corrompu.json"), "{ pas du json");

    const res = await request(env.app).post("/api/librarian/library/reindex").send();
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.totalDocs).toBe(1);

    const lib = res.body.index.library;
    expect(lib).toHaveLength(1);
    expect(lib[0]).toMatchObject({ name: "manuel", version: "1.2.3", filePath: "tools/manuel@1.2.3.json" });

    // L'index persisté est bien relu par /library.
    const apiKey = createKey("after-reindex").key;
    const read = await request(env.app).get("/api/librarian/library").set("X-API-Key", apiKey);
    expect(read.body.library).toHaveLength(1);
    expect(readFileSync(join(env.docsDir, "index.json"), "utf-8")).toContain("manuel");
  });
});

// ── Garde-fous (session) : CSRF + mot de passe par défaut ──

describe("garde-fous session sur les actions sensibles", () => {
  it("session, mot de passe par défaut → 403 PASSWORD_NOT_CHANGED (créer/régénérer/supprimer/réindexer)", async () => {
    const { agent, res: loginRes } = await login("admin");
    const csrf = loginRes.body.csrfToken;

    const create = await agent.post("/api/librarian/keys").set("X-CSRF-Token", csrf).send({ name: "x" });
    expect(create.status).toBe(403);
    expect(create.body.code).toBe("PASSWORD_NOT_CHANGED");

    const regen = await agent.post("/api/librarian/keys/libryk_quelconque/regenerate").set("X-CSRF-Token", csrf).send();
    expect(regen.status).toBe(403);
    expect(regen.body.code).toBe("PASSWORD_NOT_CHANGED");

    const delKey = await agent.delete("/api/librarian/keys/libryk_quelconque").set("X-CSRF-Token", csrf);
    expect(delKey.status).toBe(403);
    expect(delKey.body.code).toBe("PASSWORD_NOT_CHANGED");

    const delDoc = await agent.delete("/api/librarian/doc/peu-importe").set("X-CSRF-Token", csrf);
    expect(delDoc.status).toBe(403);
    expect(delDoc.body.code).toBe("PASSWORD_NOT_CHANGED");

    const reindex = await agent.post("/api/librarian/library/reindex").set("X-CSRF-Token", csrf);
    expect(reindex.status).toBe(403);
    expect(reindex.body.code).toBe("PASSWORD_NOT_CHANGED");
  });

  it("session sans en-tête CSRF → 403 CSRF_FAILED", async () => {
    const { agent } = await login("admin");
    const res = await agent.post("/api/librarian/keys").send({ name: "x" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("CSRF_FAILED");
  });

  it("après changement de mot de passe, la création depuis la session est autorisée", async () => {
    const { agent, res: loginRes } = await login("admin");
    const change = await agent
      .post("/api/admin/password")
      .set("X-CSRF-Token", loginRes.body.csrfToken)
      .send({ current: "admin", next: "s3cret" });
    expect(change.status).toBe(200);

    const again = await login("s3cret");
    const ok = await again.agent
      .post("/api/librarian/keys")
      .set("X-CSRF-Token", again.res.body.csrfToken)
      .send({ name: "post-change" });
    expect(ok.status).toBe(201);
  });
});

// ── Contrat scripté inchangé ──

describe("contrat scripté (loopback / clé en en-tête)", () => {
  it("actions sensibles SANS session : ni CSRF ni garde-fou (comportement inchangé)", async () => {
    const create = await request(env.app).post("/api/librarian/keys").send({ name: "scripted" });
    expect(create.status).toBe(201);
    const del = await request(env.app).delete(`/api/librarian/keys/${create.body.id}`);
    expect(del.status).toBe(200);
  });

  it("clé admin en en-tête toujours fonctionnelle sur /api/librarian/*", async () => {
    const adminKey = createKey("admin", { admin: true }).key;
    // Authentifie les routes bibliothèque standard.
    const lib = await request(env.app).get("/api/librarian/library").set("X-API-Key", adminKey);
    expect(lib.status).toBe(200);
    // Authentifie la gestion des clés (admin).
    const keys = await request(env.app).get("/api/librarian/keys").set("Authorization", `Bearer ${adminKey}`);
    expect(keys.status).toBe(200);
  });

  it("les clés legacy lib-… restent acceptées ; la régénération ne les concerne pas", async () => {
    const legacy = "lib-feedfacefeedfacefeedfacefeedface";
    env.cleanup();
    env = makeTestEnv({ LIBRY_LEGACY_KEYS: legacy });

    const res = await request(env.app).get("/api/librarian/library").set("X-API-Key", legacy);
    expect(res.status).toBe(200);
  });
});
