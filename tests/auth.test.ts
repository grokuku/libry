import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { existsSync, readFileSync, statSync, mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import { makeTestEnv, type TestEnv } from "./helpers.js";
import {
  createKey,
  validateKey,
  revokeKey,
  isAdminKey,
  keyIdOf,
  loadKeys,
  resetAuthCaches,
} from "../src/libry-auth.js";
import { libryAdminOnly } from "../src/middleware/admin-only.js";
import { isLoopbackAddress, isTrustedLocalRequest } from "../src/utils/request-identity.js";

let env: TestEnv;

beforeEach(() => {
  env = makeTestEnv();
});

afterEach(() => env.cleanup());

function mockRes() {
  return {
    statusCode: 0,
    body: undefined as unknown,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
}

describe("format des clés", () => {
  it("nouvelle clé = libry_ + 32 hex, id = libryk_…", () => {
    const k = createKey("yuki");
    expect(k.key).toMatch(/^libry_[0-9a-f]{32}$/);
    expect(k.id).toMatch(/^libryk_[0-9a-f]{12}$/);
    expect(k.keyHash).toMatch(/^scrypt:/);
    expect(k.keyPreview).toBe(k.key.slice(0, 12) + "…");
  });

  it("validateKey accepte la clé créée, refuse une clé inconnue", () => {
    const k = createKey("yuki");
    expect(validateKey(k.key)).toBe(true);
    expect(validateKey("libry_deadbeef")).toBe(false);
  });

  it("revokeKey supprime par identifiant non secret", () => {
    const k = createKey("yuki");
    expect(revokeKey(k.id)).toBe(true);
    expect(validateKey(k.key)).toBe(false);
    expect(revokeKey(k.id)).toBe(false);
  });
});

describe("transport de la clé (Bearer / X-API-Key / les deux)", () => {
  let key: string;
  beforeEach(() => {
    key = createKey("transport").key;
  });

  it("Authorization: Bearer", async () => {
    const res = await request(env.app).get("/api/librarian/library").set("Authorization", `Bearer ${key}`);
    expect(res.status).toBe(200);
  });

  it("X-API-Key", async () => {
    const res = await request(env.app).get("/api/librarian/library").set("X-API-Key", key);
    expect(res.status).toBe(200);
  });

  it("les deux en-têtes (Bearer prioritaire)", async () => {
    const res = await request(env.app)
      .get("/api/librarian/library")
      .set("Authorization", `Bearer ${key}`)
      .set("X-API-Key", "invalide");
    expect(res.status).toBe(200);
  });

  it("clé invalide → 401 verbatim", async () => {
    const res = await request(env.app).get("/api/librarian/library").set("X-API-Key", "libry_0000");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Invalid or missing API key" });
  });

  it("/status reste public", async () => {
    const res = await request(env.app).get("/api/librarian/status");
    expect(res.status).toBe(200);
  });
});

describe("tolérance des clés historiques lib-…", () => {
  it("clé legacy stockée en clair dans le fichier → acceptée, puis re-hachée", async () => {
    mkdirSync(dirname(env.keysFile), { recursive: true });
    writeFileSync(
      env.keysFile,
      JSON.stringify([
        {
          id: "libk_legacy0001",
          name: "yuki-legacy",
          createdAt: "2026-01-01T00:00:00.000Z",
          keyPreview: "lib-deadbeef…",
          key: "lib-deadbeefdeadbeefdeadbeefdeadbeef",
        },
      ]),
      { mode: 0o600 },
    );
    resetAuthCaches();

    const res = await request(env.app).get("/api/librarian/library").set("X-API-Key", "lib-deadbeefdeadbeefdeadbeefdeadbeef");
    expect(res.status).toBe(200);

    // Migration transparente : le secret en clair a été remplacé par un hash.
    const stored = JSON.parse(readFileSync(env.keysFile, "utf-8"));
    expect(stored[0].key).toBeUndefined();
    expect(stored[0].keyHash).toMatch(/^scrypt:/);
    expect(stored[0].id).toBe("libk_legacy0001");
  });

  it("clé legacy déclarée par LIBRY_LEGACY_KEYS → acceptée sans fichier", async () => {
    env.cleanup();
    env = makeTestEnv({ LIBRY_LEGACY_KEYS: "lib-feedfacefeedfacefeedfacefeedface" });
    const res = await request(env.app)
      .get("/api/librarian/library")
      .set("Authorization", "Bearer lib-feedfacefeedfacefeedfacefeedface");
    expect(res.status).toBe(200);
    expect(validateKey("lib-feedfacefeedfacefeedfacefeedface")).toBe(true);
  });
});

describe("/keys réservé admin", () => {
  it("client externe sans clé admin → 403 verbatim", () => {
    const req: any = { socket: { remoteAddress: "10.0.0.5" }, headers: {} };
    const res = mockRes();
    let nextCalled = false;
    libryAdminOnly(req, res as any, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: "Key management is only available from localhost or an admin key" });
  });

  it("boucle locale → laisse passer", () => {
    const req: any = { socket: { remoteAddress: "127.0.0.1" }, headers: {} };
    const res = mockRes();
    let nextCalled = false;
    libryAdminOnly(req, res as any, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });

  it("clé admin d'environnement → laisse passer en externe", () => {
    const key = createKey("admin").key;
    process.env.LIBRY_ADMIN_KEYS = key;
    expect(isAdminKey(key)).toBe(true);
    const req: any = { socket: { remoteAddress: "10.0.0.5" }, headers: { "x-api-key": key } };
    const res = mockRes();
    let nextCalled = false;
    libryAdminOnly(req, res as any, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });
});

describe("permissions des fichiers", () => {
  it("fichier de clés en 0600, répertoire en 0700", () => {
    createKey("perm");
    expect(existsSync(env.keysFile)).toBe(true);
    expect(statSync(env.keysFile).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(env.keysFile)).mode & 0o777).toBe(0o700);
  });
});

describe("détection loopback non forgeable", () => {
  it("isLoopbackAddress reconnaît les formes locales et rejette le reste", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.0.0.2")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("10.0.0.5")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });

  it("isTrustedLocalRequest utilise la socket, pas X-Forwarded-For", () => {
    const spoofed: any = {
      socket: { remoteAddress: "10.0.0.5" },
      headers: { "x-forwarded-for": "127.0.0.1" },
    };
    expect(isTrustedLocalRequest(spoofed)).toBe(false);
    const local: any = { socket: { remoteAddress: "::1" }, headers: {} };
    expect(isTrustedLocalRequest(local)).toBe(true);
  });
});

describe("caches et cohérence", () => {
  it("keyIdOf retombe sur l'id dérivé pour une clé legacy sans id", () => {
    const k: any = { name: "x", createdAt: "", keyPreview: "", key: "lib-abc" };
    expect(keyIdOf(k)).toMatch(/^libryk_[0-9a-f]{12}$/);
  });

  it("loadKeys normalise les clés sans id", () => {
    mkdirSync(dirname(env.keysFile), { recursive: true });
    writeFileSync(env.keysFile, JSON.stringify([{ name: "x", createdAt: "", keyPreview: "", key: "lib-abc" }]), {
      mode: 0o600,
    });
    resetAuthCaches();
    const keys = loadKeys();
    expect(keys[0].id).toMatch(/^libryk_[0-9a-f]{12}$/);
  });
});
