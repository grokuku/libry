/**
 * Lot 6 — interface fonctionnelle (Documentation + Réglages).
 *
 * Vérifications STATIQUES (câblage des endpoints, garde-fous) et un test DOM
 * réel sous Chromium : la structure des deux onglets est servie, les cartes
 * Réglages sont masquées hors session et la liste des documents affiche son
 * état « connexion requise » sans qu'aucune erreur JS ne soit levée.
 *
 * Aucun accès réseau applicatif : makeTestEnv coupe le fetch sortant.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { spawn } from "child_process";
import { once } from "events";
import type { AddressInfo } from "net";
import { detectChromium } from "../src/screenshot.js";
import { makeTestEnv, type TestEnv } from "./helpers.js";

const AS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

/** Charge une URL dans Chromium headless et retourne le DOM APRÈS exécution du JS. */
function dumpDom(bin: string, url: string, timeoutMs = 30000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      bin,
      [
        "--headless=new",
        "--disable-gpu",
        "--virtual-time-budget=5000",
        ...(AS_ROOT ? ["--no-sandbox"] : []),
        "--dump-dom",
        url,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-2000);
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* déjà terminé */
      }
      reject(new Error("Chromium n'a pas répondu dans le délai imparti."));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`Chromium a échoué (code ${code}) : ${stderr}`));
    });
  });
}

let env: TestEnv;

beforeEach(() => {
  env = makeTestEnv();
});

afterEach(() => env.cleanup());

describe("Lot 6 — câblage de app.js", () => {
  it("utilise les bons endpoints et jamais POST /search (filtre côté client)", async () => {
    const res = await request(env.app).get("/app.js");
    expect(res.status).toBe(200);
    const js = res.text;

    // Documentation
    expect(js).toContain("/api/librarian/library");
    expect(js).toContain("/api/librarian/doc/");
    expect(js).toContain("/api/librarian/library/reindex");
    // Réglages
    expect(js).toContain("/api/admin/session");
    expect(js).toContain("/api/admin/login");
    expect(js).toContain("/api/admin/logout");
    expect(js).toContain("/api/admin/password");
    expect(js).toContain("/api/admin/settings");
    // Clés API
    expect(js).toContain("/api/librarian/keys");
    expect(js).toContain("/regenerate");

    // ⚠️ Le filtre est CLIENT : la cascade web ne doit JAMAIS être déclenchée.
    expect(js).not.toContain("/api/librarian/search");
    expect(js).not.toMatch(/["'`]\/search["'`]/);
  });

  it("gère les codes d'erreur de la conception (401, CSRF_FAILED, PASSWORD_NOT_CHANGED)", async () => {
    const res = await request(env.app).get("/app.js");
    const js = res.text;
    expect(js).toContain("CSRF_FAILED");
    expect(js).toContain("PASSWORD_NOT_CHANGED");
    expect(js).toContain("X-CSRF-Token");
    expect(js).toContain("credentials");
    // Confirmations destructives via la brique modal.
    expect(js).toContain("modal.confirm");
    // Secret affiché une seule fois.
    expect(js).toContain("showSecret");
    expect(js).toContain("clipboard");
  });
});

describe("Lot 6 — structure de index.html", () => {
  it("expose les conteneurs des deux onglets", async () => {
    const res = await request(env.app).get("/");
    const html = res.text;
    for (const id of [
      "docs-list",
      "docs-filter",
      "doc-detail",
      "docs-reindex",
      "default-password-banner",
      "login-form",
      "session-view",
      "password-form",
      "key-form",
      "keys-list",
      "settings-form",
      "settings-save",
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
    // Les cartes Réglages restent masquées hors session.
    expect(html).toMatch(/id="keys-card"[^>]*hidden/);
    expect(html).toMatch(/id="settings-card"[^>]*hidden/);
    expect(html).toMatch(/id="default-password-banner"[^>]*hidden/);
  });

  it("styles.css fournit les classes du Lot 6", async () => {
    const res = await request(env.app).get("/styles.css");
    const css = res.text;
    expect(css).toContain(".banner--danger");
    expect(css).toContain(".docs-list");
    expect(css).toContain(".setting-row");
    // Toujours aucun triplet RGB calculé côté hôte.
    expect(css).not.toContain("-rgb:");
  });
});

describe("Lot 6 — page réelle (Chromium headless)", () => {
  it("structure rendue, JS exécuté sans erreur, cartes masquées hors session", async () => {
    const bin = detectChromium();
    expect(bin).toBeTruthy();

    const server = env.app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    try {
      const dom = await dumpDom(bin as string, `http://127.0.0.1:${port}/`);
      const clean = dom.replace(/<!--[\s\S]*?-->/g, "");

      // app.js exécuté : le sélecteur de thème est démasqué et rempli (7 familles).
      const families = [...clean.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
      expect(families).toContain("neutre");

      // Le formulaire de connexion est présent, la carte des clés masquée.
      expect(clean).toContain('id="login-form"');
      expect(clean).toMatch(/id="keys-card"[^>]*hidden/);
      expect(clean).toMatch(/id="default-password-banner"[^>]*hidden/);

      // La liste des documents affiche son état « connexion requise ».
      expect(clean).toContain("Connectez-vous");

      // Le filtre et le bouton de réindexation sont rendus.
      expect(clean).toContain('id="docs-filter"');
      expect(clean).toContain('id="docs-reindex"');

      // Toujours aucun <style> injecté (CSP style-src 'self').
      expect(clean).not.toMatch(/<style[\s>]/);
    } finally {
      server.close();
      await once(server, "close");
    }
  }, 40000);
});
