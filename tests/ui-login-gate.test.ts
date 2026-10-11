/**
 * Porte d'entrée — l'écran de connexion est la SEULE chose affichée avant
 * authentification.
 *
 * 1. Vérifications STATIQUES : le markup porte `#login-screen` AVANT `#app`, le
 *    conteneur applicatif (`#app`) est masqué par défaut, le formulaire de
 *    connexion n'est pas dans l'application, le champ de changement de mot de
 *    passe reste dans les Réglages.
 * 2. Parcours RÉEL sous Chromium (CDP) : arrivée non authentifié → écran de
 *    connexion seul ; mauvais mot de passe → message d'erreur ; connexion →
 *    application ; déconnexion → retour à l'écran de connexion seul.
 *
 * Aucun accès réseau applicatif (makeTestEnv coupe le fetch sortant).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { spawn, type ChildProcess } from "child_process";
import { once } from "events";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AddressInfo } from "net";
import { detectChromium } from "../src/screenshot.js";
import { makeTestEnv, type TestEnv } from "./helpers.js";

const AS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

let env: TestEnv;

beforeEach(() => {
  env = makeTestEnv();
});

afterEach(() => env.cleanup());

describe("Porte d'entrée — markup (index.html)", () => {
  it("l'écran de connexion précède le conteneur applicatif, masqué par défaut", async () => {
    const html = (await request(env.app).get("/")).text;

    // Les deux racines existent.
    expect(html).toContain('id="login-screen"');
    expect(html).toContain('id="app"');

    // L'écran de connexion est AVANT l'application dans le document.
    expect(html.indexOf('id="login-screen"')).toBeLessThan(html.indexOf('id="app"'));

    // Le conteneur applicatif porte `hidden` (rien d'applicatif avant auth).
    expect(html).toMatch(/id="app"[^>]*hidden/);

    // L'écran de connexion, lui, est visible par défaut (pas de `hidden`).
    const loginTag = html.match(/<div class="login-screen" id="login-screen"([^>]*)>/);
    expect(loginTag).toBeTruthy();
    expect(loginTag![1]).not.toMatch(/\bhidden\b/);

    // Le formulaire de connexion vit DANS l'écran d'entrée, pas dans #app.
    const loginStart = html.indexOf('id="login-screen"');
    const appStart = html.indexOf('id="app"');
    const loginForm = html.indexOf('id="login-form"');
    expect(loginForm).toBeGreaterThan(loginStart);
    expect(loginForm).toBeLessThan(appStart);

    // L'ancien double usage `#login-view` a disparu.
    expect(html).not.toContain('id="login-view"');

    // Le changement de mot de passe reste dans les Réglages (donc dans #app).
    expect(html.indexOf('id="password-form"')).toBeGreaterThan(appStart);
    expect(html).toMatch(/id="session-view"[^>]*hidden/);
  });
});

describe("Porte d'entrée — câblage (app.js)", () => {
  it("bascule `#login-screen` / `#app` selon l'état de session", async () => {
    const js = (await request(env.app).get("/app.js")).text;
    expect(js).toContain('$("login-screen")');
    expect(js).toContain('$("app")');
    expect(js).toMatch(/loginScreen\.hidden\s*=\s*state\.authenticated/);
    expect(js).toMatch(/app\.hidden\s*=\s*!state\.authenticated/);
    // Message d'erreur en ligne de l'écran de connexion.
    expect(js).toContain("setLoginError");
    expect(js).toContain('"login-error"');
  });
});

// ── Parcours réel sous Chromium ──────────────────────────────────────────

/** Pilote minimal du protocole DevTools (CDP) sur une cible de page. */
class Cdp {
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private waiters = new Map<string, Array<(p: any) => void>>();

  constructor(private ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String((event as MessageEvent).data));
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        const list = this.waiters.get(msg.method) || [];
        this.waiters.set(msg.method, []);
        for (const fn of list) fn(msg.params);
      }
    });
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Résout à la prochaine occurrence de `method` (l'écouteur est posé AVANT le tir). */
  next(method: string): Promise<any> {
    return new Promise((resolve) => {
      this.waiters.set(method, [...(this.waiters.get(method) || []), resolve]);
    });
  }

  async evaluate(expression: string): Promise<any> {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.text || "évaluation impossible");
    }
    return r.result ? r.result.value : undefined;
  }

  async waitFor(expression: string, timeoutMs = 10000): Promise<void> {
    const start = Date.now();
    for (;;) {
      if (await this.evaluate(expression)) return;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Condition non satisfaite : ${expression}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

/** Lance Chromium headless en écoute CDP ; retourne le process et l'URL d'une page. */
async function launchChromium(bin: string): Promise<{ child: ChildProcess; wsUrl: string; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "libry-cdp-"));
  const child = spawn(
    bin,
    [
      "--headless=new",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      `--user-data-dir=${dir}`,
      ...(AS_ROOT ? ["--no-sandbox"] : []),
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  const portFile = join(dir, "DevToolsActivePort");
  const start = Date.now();
  while (!existsSync(portFile)) {
    if (Date.now() - start > 15000) throw new Error("Chromium n'a pas ouvert le port CDP.");
    await new Promise((r) => setTimeout(r, 100));
  }
  const port = readFileSync(portFile, "utf8").split("\n")[0].trim();
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t: any) => t.type === "page");
  if (!page) throw new Error("Aucune cible de page CDP.");
  return { child, wsUrl: page.webSocketDebuggerUrl, dir };
}

describe("Porte d'entrée — parcours réel (Chromium/CDP)", () => {
  it("écran de connexion seul → app après login → connexion seule après logout", async () => {
    const bin = detectChromium();
    expect(bin).toBeTruthy();

    const server = env.app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/`;

    let child: ChildProcess | undefined;
    let dir: string | undefined;
    let ws: WebSocket | undefined;
    try {
      const launched = await launchChromium(bin as string);
      child = launched.child;
      dir = launched.dir;
      ws = new WebSocket(launched.wsUrl);
      await once(ws, "open");
      const cdp = new Cdp(ws);
      await cdp.send("Page.enable");
      await cdp.send("Runtime.enable");

      // (a) Arrivée non authentifié : écran de connexion SEUL.
      const loaded = cdp.next("Page.loadEventFired");
      await cdp.send("Page.navigate", { url });
      await loaded;
      await cdp.waitFor("document.readyState === 'complete'");
      // Laisse le fetch de session se terminer.
      await cdp.waitFor("document.getElementById('login-screen').hidden === false");

      expect(await cdp.evaluate("document.getElementById('app').hidden")).toBe(true);
      expect(await cdp.evaluate("getComputedStyle(document.getElementById('app')).display")).toBe("none");
      expect(await cdp.evaluate("document.getElementById('login-screen').offsetHeight > 0")).toBe(true);
      // Rien d'applicatif visible non plus : pas d'onglets, pas de liste.
      // (`display` d'un descendant d'un ancêtre `display:none` reste « flex » :
      // on teste donc l'absence de rendu via offsetHeight === 0.)
      expect(await cdp.evaluate("document.querySelector('.tabs').offsetHeight === 0")).toBe(true);
      expect(await cdp.evaluate("document.getElementById('docs-list').offsetHeight === 0")).toBe(true);

      // Mauvais mot de passe → message d'erreur en ligne.
      await cdp.evaluate(`(() => {
        const input = document.getElementById('login-password');
        input.value = 'mauvais-mot-de-passe';
        document.getElementById('login-form').requestSubmit();
      })()`);
      await cdp.waitFor("document.getElementById('login-error').hidden === false");
      expect(await cdp.evaluate("document.getElementById('login-error').textContent")).toContain(
        "incorrect",
      );
      expect(await cdp.evaluate("document.getElementById('app').hidden")).toBe(true);

      // (b) Connexion (mot de passe par défaut de l'environnement de test).
      await cdp.evaluate(`(() => {
        const input = document.getElementById('login-password');
        input.value = 'admin';
        document.getElementById('login-form').requestSubmit();
      })()`);
      await cdp.waitFor("document.getElementById('app').hidden === false");
      expect(await cdp.evaluate("document.getElementById('login-screen').hidden")).toBe(true);
      expect(await cdp.evaluate("getComputedStyle(document.getElementById('app')).display")).not.toBe("none");
      expect(await cdp.evaluate("document.querySelector('.tabs').offsetHeight > 0")).toBe(true);

      // (c) Déconnexion : retour à l'écran de connexion seul.
      await cdp.evaluate("document.getElementById('logout-btn').click()");
      await cdp.waitFor("document.getElementById('login-screen').hidden === false");
      await cdp.waitFor("document.getElementById('app').hidden === true");
      expect(await cdp.evaluate("document.getElementById('login-error').hidden")).toBe(true);
      expect(await cdp.evaluate("document.getElementById('login-password').value")).toBe("");
    } finally {
      try {
        if (ws) ws.close();
      } catch {
        /* déjà fermé */
      }
      if (child) child.kill("SIGKILL");
      if (dir) rmSync(dir, { recursive: true, force: true });
      server.close();
      await once(server, "close");
    }
  }, 60000);
});
