import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { readFileSync, existsSync, statSync } from "fs";
import { join } from "path";
import { makeTestEnv, type TestEnv } from "./helpers.js";
import { getLogLevel, getShotTtlHours, getShotInlineHtml } from "../src/config.js";
import { getWebclawConfig } from "../src/webclaw.js";
import { getTavilyConfig } from "../src/tavily.js";
import { resetSettingsCache } from "../src/settings-store.js";

let env: TestEnv;

beforeEach(() => {
  env = makeTestEnv();
  resetSettingsCache();
});

afterEach(() => {
  env.cleanup();
  // makeTestEnv n'efface pas les variables passées en `overrides` : on les retire.
  delete process.env.LIBRY_LOG_LEVEL;
  delete process.env.LIBRY_ALLOWED_ORIGINS;
  delete process.env.WEBCLAW_API_KEY;
});

function settingsFile(): string {
  return join(env.dir, "config.json");
}

/** Récupère une entrée de réglage par nom dans la réponse groupée. */
async function getSetting(name: string): Promise<any> {
  const res = await request(env.app).get("/api/admin/settings");
  expect(res.status).toBe(200);
  const flat = res.body.groups.flatMap((g: any) => g.settings);
  return flat.find((s: any) => s.name === name);
}

describe("GET /api/admin/settings — sources", () => {
  it("défaut : source « default »", async () => {
    const s = await getSetting("LIBRY_LOG_LEVEL");
    expect(s.source).toBe("default");
    expect(s.value).toBe("info");
    expect(s.editable).toBe(true);
  });

  it("env : source « env » et non éditable", async () => {
    env.cleanup();
    env = makeTestEnv({ LIBRY_LOG_LEVEL: "debug" });
    const s = await getSetting("LIBRY_LOG_LEVEL");
    expect(s.source).toBe("env");
    expect(s.value).toBe("debug");
    expect(s.editable).toBe(false);
  });

  it("fichier : source « file »", async () => {
    // Écrit un config.json pointant sur le répertoire de données du test.
    const put = await request(env.app)
      .put("/api/admin/settings")
      .send({ settings: { LIBRY_LOG_LEVEL: "warn" } });
    expect(put.status).toBe(200);
    const s = await getSetting("LIBRY_LOG_LEVEL");
    expect(s.source).toBe("file");
    expect(s.value).toBe("warn");
  });

  it("env prioritaire sur le fichier", async () => {
    // Fichier = warn, puis env = error → la source reste « env ».
    await request(env.app).put("/api/admin/settings").send({ settings: { LIBRY_LOG_LEVEL: "warn" } });
    process.env.LIBRY_LOG_LEVEL = "error";
    const s = await getSetting("LIBRY_LOG_LEVEL");
    expect(s.source).toBe("env");
    expect(s.value).toBe("error");
    delete process.env.LIBRY_LOG_LEVEL;
  });

  it("LIBRY_DATA_DIR est envOnly (source « env », non éditable)", async () => {
    const s = await getSetting("LIBRY_DATA_DIR");
    expect(s.source).toBe("env"); // makeTestEnv positionne LIBRY_DATA_DIR
    expect(s.editable).toBe(false);
    expect(s.restartRequired).toBe(true);
  });

  it("les réglages « redémarrage requis » sont marqués, les « à chaud » non", async () => {
    const host = await getSetting("LIBRY_HOST");
    const ttl = await getSetting("LIBRY_SHOT_TTL_HOURS");
    expect(host.restartRequired).toBe(true);
    expect(ttl.restartRequired).toBe(false);
  });
});

describe("PUT /api/admin/settings — écriture atomique et application à chaud", () => {
  it("écrit en 0600 et un getter « à chaud » reflète la valeur sans redémarrage", async () => {
    expect(getLogLevel()).toBe("info");
    const res = await request(env.app)
      .put("/api/admin/settings")
      .send({ settings: { LIBRY_LOG_LEVEL: "trace" } });
    expect(res.status).toBe(200);

    // Fichier réellement écrit, permissions restrictives.
    expect(existsSync(settingsFile())).toBe(true);
    expect(statSync(settingsFile()).mode & 0o777).toBe(0o600);
    const stored = JSON.parse(readFileSync(settingsFile(), "utf-8"));
    expect(stored.LIBRY_LOG_LEVEL).toBe("trace");

    // Application à chaud : le getter relit env + fichier à chaque appel.
    expect(getLogLevel()).toBe("trace");
  });

  it("répertoire de données en 0700", async () => {
    await request(env.app).put("/api/admin/settings").send({ settings: { LIBRY_LOG_LEVEL: "trace" } });
    expect(statSync(env.dir).mode & 0o777).toBe(0o700);
  });

  it("le moteur web relit la config web à chaud (WebClaw + Tavily)", async () => {
    await request(env.app)
      .put("/api/admin/settings")
      .send({ settings: { WEBCLAW_URL: "http://localhost:9999", LIBRY_TAVILY_API_KEY: "tvly-abc" } });
    expect(getWebclawConfig().url).toBe("http://localhost:9999");
    expect(getTavilyConfig().apiKey).toBe("tvly-abc");
  });

  it("nombre : borne respectée et reflétée à chaud", async () => {
    const ok = await request(env.app).put("/api/admin/settings").send({ settings: { LIBRY_SHOT_TTL_HOURS: "42" } });
    expect(ok.status).toBe(200);
    expect(getShotTtlHours()).toBe(42);

    const bad = await request(env.app).put("/api/admin/settings").send({ settings: { LIBRY_SHOT_TTL_HOURS: "0" } });
    expect(bad.status).toBe(400);
    expect(getShotTtlHours()).toBe(42); // inchangé
  });

  it("booléen : « true »/« false » seulement", async () => {
    const bad = await request(env.app)
      .put("/api/admin/settings")
      .send({ settings: { LIBRY_SHOT_INLINE_HTML: "yes" } });
    expect(bad.status).toBe(400);

    const ok = await request(env.app)
      .put("/api/admin/settings")
      .send({ settings: { LIBRY_SHOT_INLINE_HTML: "true" } });
    expect(ok.status).toBe(200);
    expect(getShotInlineHtml()).toBe(true);
  });

  it("champ vide = inchangé ; null = effacer (retour au défaut)", async () => {
    await request(env.app).put("/api/admin/settings").send({ settings: { LIBRY_LOG_LEVEL: "warn" } });

    // Champ vide → aucun changement.
    await request(env.app).put("/api/admin/settings").send({ settings: { LIBRY_LOG_LEVEL: "" } });
    expect(getLogLevel()).toBe("warn");

    // null → l'entrée disparaît du fichier.
    const res = await request(env.app).put("/api/admin/settings").send({ settings: { LIBRY_LOG_LEVEL: null } });
    expect(res.status).toBe(200);
    const stored = JSON.parse(readFileSync(settingsFile(), "utf-8"));
    expect(stored.LIBRY_LOG_LEVEL).toBeUndefined();
    expect(getLogLevel()).toBe("info");
  });

  it("nom inconnu → 400, aucune écriture", async () => {
    const res = await request(env.app).put("/api/admin/settings").send({ settings: { NOT_A_SETTING: "x" } });
    expect(res.status).toBe(400);
    expect(existsSync(settingsFile())).toBe(false);
  });
});

describe("PUT /api/admin/settings — verrouillage par l'environnement", () => {
  it("un réglage fourni par l'env est refusé (409)", async () => {
    env.cleanup();
    env = makeTestEnv({ LIBRY_ALLOWED_ORIGINS: "http://example.com" });
    const s = await getSetting("LIBRY_ALLOWED_ORIGINS");
    expect(s.source).toBe("env");
    expect(s.editable).toBe(false);

    const res = await request(env.app)
      .put("/api/admin/settings")
      .send({ settings: { LIBRY_ALLOWED_ORIGINS: "http://other.com" } });
    expect(res.status).toBe(409);
    expect(existsSync(settingsFile())).toBe(false);
  });

  it("LIBRY_DATA_DIR (envOnly) est refusé (409)", async () => {
    const res = await request(env.app)
      .put("/api/admin/settings")
      .send({ settings: { LIBRY_DATA_DIR: "/tmp/elsewhere" } });
    expect(res.status).toBe(409);
  });
});

describe("secrets — jamais réaffichés", () => {
  it("GET ne renvoie que {configured, preview} pour un secret", async () => {
    env.cleanup();
    env = makeTestEnv({ WEBCLAW_API_KEY: "super-secret-key" });
    const s = await getSetting("WEBCLAW_API_KEY");
    expect(s.sensitive).toBe(true);
    expect(s.configured).toBe(true);
    expect(s.preview).toBe("••••");
    expect(s.value).toBeUndefined();
    expect(JSON.stringify(s)).not.toContain("super-secret-key");
    expect(s.source).toBe("env");
    expect(s.editable).toBe(false);
  });

  it("PUT écrit un secret dans le fichier sans jamais le réafficher", async () => {
    const res = await request(env.app)
      .put("/api/admin/settings")
      .send({ settings: { LIBRY_TAVILY_API_KEY: "tvly-hidden" } });
    expect(res.status).toBe(200);

    const stored = JSON.parse(readFileSync(settingsFile(), "utf-8"));
    expect(stored.LIBRY_TAVILY_API_KEY).toBe("tvly-hidden");

    const after = await getSetting("LIBRY_TAVILY_API_KEY");
    expect(after.configured).toBe(true);
    expect(after.preview).toBe("••••");
    expect(JSON.stringify(res.body)).not.toContain("tvly-hidden");
  });

  it("null efface un secret (configured repasse à false)", async () => {
    await request(env.app).put("/api/admin/settings").send({ settings: { LIBRY_TAVILY_API_KEY: "tvly-x" } });
    await request(env.app).put("/api/admin/settings").send({ settings: { LIBRY_TAVILY_API_KEY: null } });
    const s = await getSetting("LIBRY_TAVILY_API_KEY");
    expect(s.configured).toBe(false);
  });
});
