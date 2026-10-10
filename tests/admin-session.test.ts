import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { makeTestEnv, type TestEnv } from "./helpers.js";
import { resetLoginRateLimitForTests } from "../src/routes/admin.js";
import { setSessionTtlForTests } from "../src/session-store.js";
import { requireAdmin } from "../src/middleware/admin-session.js";
import { isTrustedLocalRequest } from "../src/utils/request-identity.js";

let env: TestEnv;

beforeEach(async () => {
  env = makeTestEnv();
  await resetLoginRateLimitForTests();
});

afterEach(() => {
  env.cleanup();
  delete process.env.LIBRY_SESSION_TTL_HOURS;
});

// ── Helpers ──

function setCookies(res: any): string[] {
  const raw = res.headers["set-cookie"];
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

/** Valeur du cookie nommé dans l'en-tête Set-Cookie (undefined si absent). */
function cookieValue(res: any, name: string): string | undefined {
  const prefix = `${name}=`;
  for (const c of setCookies(res)) {
    if (c.startsWith(prefix)) return c.slice(prefix.length).split(";")[0];
  }
  return undefined;
}

/** Cookie entier (avec attributs) portant `name`. */
function cookieHeader(res: any, name: string): string | undefined {
  return setCookies(res).find((c) => c.startsWith(`${name}=`));
}

/** Agent supertest : fait un GET /session (pose le cookie CSRF) puis se connecte. */
async function login(password: string) {
  const agent = request.agent(env.app);
  const first = await agent.get("/api/admin/session");
  const res = await agent.post("/api/admin/login").set("X-CSRF-Token", first.body.csrfToken).send({ password });
  return { agent, res };
}

interface MockRes {
  statusCode: number;
  body: any;
  status(c: number): MockRes;
  header(k: string, v: string): MockRes;
  json(b: any): MockRes;
}

function mockRes(): MockRes {
  const res: MockRes = {
    statusCode: 0,
    body: undefined,
    status(c) {
      this.statusCode = c;
      return this;
    },
    header() {
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
  };
  return res;
}

/** Requête factice avec une adresse de socket contrôlée (jamais 127.0.0.1 ici). */
function mockReq(remoteAddress: string, headers: Record<string, string> = {}): any {
  return { socket: { remoteAddress }, headers, secure: false, method: "GET", url: "/" };
}

// ── Login / logout ──

describe("POST /api/admin/login", () => {
  it("mauvais mot de passe (CSRF fourni) → 401", async () => {
    const { res } = await login("mauvais");
    expect(res.status).toBe(401);
    expect(res.body.error).toBeDefined();
    expect(cookieValue(res, "libry_session")).toBeUndefined();
  });

  it("login OK → cookie libry_session HttpOnly / SameSite=Strict, sans Secure en HTTP", async () => {
    const { res } = await login("admin");
    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(true);
    expect(res.body.passwordIsDefault).toBe(true);

    const session = cookieHeader(res, "libry_session");
    expect(session).toBeDefined();
    expect(session).toMatch(/HttpOnly/);
    expect(session).toMatch(/SameSite=Strict/);
    expect(session).not.toMatch(/Secure/); // requête HTTP → pas de Secure
    expect(session).toMatch(/Path=\//);

    const csrf = cookieHeader(res, "libry_csrf");
    expect(csrf).toBeDefined();
    expect(csrf).not.toMatch(/HttpOnly/); // lisible par le JS du site (double-submit)
  });

  it("sans en-tête CSRF → 403 CSRF_FAILED (mutation anonyme protégée)", async () => {
    const res = await request(env.app).post("/api/admin/login").send({ password: "admin" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("CSRF_FAILED");
  });
});

describe("GET /api/admin/session", () => {
  it("non authentifié → {authenticated:false, csrfToken} SANS divulguer passwordIsDefault", async () => {
    const res = await request(env.app).get("/api/admin/session");
    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(false);
    expect(typeof res.body.csrfToken).toBe("string");
    expect(res.body.csrfToken.length).toBeGreaterThan(0);
    expect("passwordIsDefault" in res.body).toBe(false);
    expect(res.headers["set-cookie"]).toBeDefined(); // pose le cookie CSRF
  });

  it("authentifié → {authenticated:true, passwordIsDefault:true, csrfToken}", async () => {
    const { agent } = await login("admin");
    const res = await agent.get("/api/admin/session");
    expect(res.body).toMatchObject({ authenticated: true, passwordIsDefault: true });
    expect(typeof res.body.csrfToken).toBe("string");
  });
});

describe("POST /api/admin/logout", () => {
  it("vide le cookie de session (Max-Age=0) et invalide la session côté client", async () => {
    const { agent } = await login("admin");
    const before = await agent.get("/api/admin/session");
    const csrf = before.body.csrfToken;

    const out = await agent.post("/api/admin/logout").set("X-CSRF-Token", csrf).send();
    expect(out.status).toBe(200);
    const cleared = cookieHeader(out, "libry_session");
    expect(cleared).toBeDefined();
    expect(cleared).toMatch(/Max-Age=0/);

    const after = await agent.get("/api/admin/session");
    expect(after.body.authenticated).toBe(false);
  });
});

// ── Expiration ──

describe("session expirée (TTL de test)", () => {
  it("un TTL nul rend la session immédiatement invalide", async () => {
    setSessionTtlForTests(0);
    const { agent, res } = await login("admin");
    expect(res.status).toBe(200);
    const probe = await agent.get("/api/admin/session");
    expect(probe.body.authenticated).toBe(false);
  });
});

// ── Mot de passe ──

describe("POST /api/admin/password", () => {
  it("change le mot de passe, incrémente l'époque et invalide l'ancien cookie", async () => {
    const { agent, res } = await login("admin");
    const csrf = res.body.csrfToken;
    const oldSession = cookieValue(res, "libry_session");
    expect(oldSession).toBeDefined();

    const change = await agent
      .post("/api/admin/password")
      .set("X-CSRF-Token", csrf)
      .send({ current: "admin", next: "s3cret" });
    expect(change.status).toBe(200);

    // Preuve d'invalidation par l'époque : on REJOUE l'ancien cookie de session.
    const replay = await request(env.app)
      .get("/api/admin/session")
      .set("Cookie", `libry_session=${oldSession}; libry_csrf=${csrf}`);
    expect(replay.body.authenticated).toBe(false);

    // L'ancien mot de passe ne marche plus, le nouveau oui.
    const probe = await agent.get("/api/admin/session");
    const bad = await agent.post("/api/admin/login").set("X-CSRF-Token", probe.body.csrfToken).send({ password: "admin" });
    expect(bad.status).toBe(401);
    const good = await agent
      .post("/api/admin/login")
      .set("X-CSRF-Token", probe.body.csrfToken)
      .send({ password: "s3cret" });
    expect(good.status).toBe(200);
  });

  it("refuse un mot de passe courant erroné (401)", async () => {
    const { agent, res } = await login("admin");
    const change = await agent
      .post("/api/admin/password")
      .set("X-CSRF-Token", res.body.csrfToken)
      .send({ current: "faux", next: "s3cret" });
    expect(change.status).toBe(401);
  });
});

// ── CSRF ──

describe("CSRF — double-submit sur les mutations", () => {
  it("mutation scriptée (loopback, sans session) : pas de CSRF exigé (contrat inchangé)", async () => {
    const res = await request(env.app).put("/api/admin/settings").send({ settings: { LIBRY_LOG_LEVEL: "warn" } });
    expect(res.status).toBe(200);
  });

  it("mutation depuis une session SANS en-tête CSRF → 403 CSRF_FAILED", async () => {
    const { agent } = await login("admin");
    const res = await agent.put("/api/admin/settings").send({ settings: { LIBRY_LOG_LEVEL: "warn" } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("CSRF_FAILED");
  });
});

// ── Garde-fou mot de passe par défaut ──

describe("garde-fou PASSWORD_NOT_CHANGED", () => {
  it("action sensible depuis une session avec le mot de passe par défaut → 403", async () => {
    const { agent, res } = await login("admin");
    const put = await agent
      .put("/api/admin/settings")
      .set("X-CSRF-Token", res.body.csrfToken)
      .send({ settings: { LIBRY_LOG_LEVEL: "warn" } });
    expect(put.status).toBe(403);
    expect(put.body.code).toBe("PASSWORD_NOT_CHANGED");
  });

  it("mais login, lecture et changement de mot de passe restent permis avec le défaut", async () => {
    const { agent, res } = await login("admin");
    expect(res.status).toBe(200); // se connecter

    const read = await agent.get("/api/admin/settings");
    expect(read.status).toBe(200); // lire

    const change = await agent
      .post("/api/admin/password")
      .set("X-CSRF-Token", res.body.csrfToken)
      .send({ current: "admin", next: "s3cret" }); // changer
    expect(change.status).toBe(200);
  });

  it("après changement de mot de passe, la mutation depuis la session est autorisée", async () => {
    const { agent, res } = await login("admin");
    const change = await agent
      .post("/api/admin/password")
      .set("X-CSRF-Token", res.body.csrfToken)
      .send({ current: "admin", next: "s3cret" });
    expect(change.status).toBe(200);

    const again = await login("s3cret");
    const put = await again.agent
      .put("/api/admin/settings")
      .set("X-CSRF-Token", again.res.body.csrfToken)
      .send({ settings: { LIBRY_LOG_LEVEL: "warn" } });
    expect(put.status).toBe(200);
    expect(put.body.success).toBe(true);
  });
});

// ── Rate-limit dédié du login ──

describe("rate-limit dédié du login", () => {
  it("bloque après 5 tentatives sur la même IP (429)", async () => {
    const agent = request.agent(env.app);
    const csrf = (await agent.get("/api/admin/session")).body.csrfToken;
    let last: any;
    for (let i = 0; i < 6; i++) {
      last = await agent.post("/api/admin/login").set("X-CSRF-Token", csrf).send({ password: "mauvais" });
    }
    expect(last.status).toBe(429);
  });
});

// ── Fichier de configuration ──

describe("config.json — permissions et secrets", () => {
  it("créé en 0600 après login, avec le secret de session mais jamais le mot de passe en clair", async () => {
    const { res } = await login("admin");
    expect(res.status).toBe(200);
    const file = join(env.dir, "config.json");
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);

    const raw = readFileSync(file, "utf-8");
    const stored = JSON.parse(raw);
    expect(typeof stored.LIBRY_SESSION_SECRET).toBe("string");
    expect(stored.LIBRY_SESSION_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(raw).not.toContain("admin"); // ni mot de passe par défaut, ni hash en clair
  });

  it("après changement, ne stocke qu'un hash scrypt (jamais le mot de passe)", async () => {
    const { agent, res } = await login("admin");
    await agent
      .post("/api/admin/password")
      .set("X-CSRF-Token", res.body.csrfToken)
      .send({ current: "admin", next: "s3cret" });

    const file = join(env.dir, "config.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const stored = JSON.parse(readFileSync(file, "utf-8"));
    expect(stored.LIBRY_ADMIN_PASSWORD_HASH).toMatch(/^scrypt:[0-9a-f]+:[0-9a-f]+$/);
    expect(readFileSync(file, "utf-8")).not.toContain("s3cret");
  });
});

// ── ⚠️ SÉCURITÉ CAPITALE : X-Forwarded-For ne donne PAS l'admin ──

describe("sécurité — la détection loopback utilise la socket brute, pas X-Forwarded-For", () => {
  it("une requête distante avec X-Forwarded-For: 127.0.0.1 est REFUSÉE", () => {
    const req = mockReq("203.0.113.9", { "x-forwarded-for": "127.0.0.1" });
    const res = mockRes();
    let nextCalled = false;
    requireAdmin(req, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it("idem avec X-Forwarded-For: ::1 — toujours 403", () => {
    const req = mockReq("203.0.113.9", { "x-forwarded-for": "::1" });
    const res = mockRes();
    let nextCalled = false;
    requireAdmin(req, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it("X-Forwarded-For n'influence jamais isTrustedLocalRequest", () => {
    expect(isTrustedLocalRequest(mockReq("203.0.113.9", { "x-forwarded-for": "127.0.0.1" }))).toBe(false);
    expect(isTrustedLocalRequest(mockReq("::1", { "x-forwarded-for": "203.0.113.9" }))).toBe(true);
  });

  it("un vrai loopback (socket ::1) reste autorisé, X-Forwarded-For ou non", () => {
    for (const headers of [{}, { "x-forwarded-for": "127.0.0.1" }, { "x-forwarded-for": "8.8.8.8" }]) {
      const res = mockRes();
      let nextCalled = false;
      requireAdmin(mockReq("::1", headers as Record<string, string>), res, () => {
        nextCalled = true;
      });
      expect(nextCalled).toBe(true);
    }
  });
});
