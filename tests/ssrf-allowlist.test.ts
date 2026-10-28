/**
 * Liste blanche des adresses internes (anti-SSRF) — AUCUN réseau réel.
 *
 * DNS est simulé par `vi.mock("dns/promises")` et le seul `fetch` possible passe
 * par le point d'entrée injectable `utils/http.ts` (remplacé par un faux).
 *
 * Couverture :
 *   - liste vide → comportement historique STRICTEMENT inchangé ;
 *   - autorisation par nom d'hôte et par plage CIDR ;
 *   - garde anti DNS-rebinding (nom autorisé → résolution publique = refus) ;
 *   - redirection vers une adresse non autorisée → refusée ;
 *   - `file://` et métadonnées cloud (169.254.169.254) TOUJOURS refusés ;
 *   - journal des autorisations (sans secret) ;
 *   - persistance de la configuration via l'UI (PUT /api/admin/settings).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { makeTestEnv, installMockFetch, jsonResponse, type TestEnv } from "./helpers.js";
import { createKey } from "../src/libry-auth.js";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { resetSettingsCache } from "../src/settings-store.js";
import { setFetchForTests } from "../src/utils/http.js";
import { setCaptureImplForTests } from "../src/screenshot.js";
import { resetSsrfAuditLogForTests } from "../src/utils/ssrf.js";

// DNS simulé : chaque nom interne a une adresse interne connue.
vi.mock("dns/promises", () => ({
  lookup: vi.fn(async (hostname: string) => {
    switch (hostname) {
      case "switchy": // service Docker interne
        return [{ address: "10.10.0.5", family: 4 }];
      case "pi-web":
        return [{ address: "10.10.0.4", family: 4 }];
      case "rebind.test": // nom autorisé qui se met à résoudre en PUBLIC
        return [{ address: "93.184.216.34", family: 4 }];
      case "internal.test": // nom interne non autorisé
        return [{ address: "10.10.0.9", family: 4 }];
      case "public.test":
        return [{ address: "93.184.216.34", family: 4 }];
      default:
        throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    }
  }),
}));

const { validateHttpUrl, resolveHttpTarget, getSsrfAuditLog, assertRedirectAllowed, ipInCidr, matchHostEntry } =
  await import("../src/utils/ssrf.js");
const { probeRedirectChain } = await import("../src/utils/redirect-guard.js");
const { normalizeHostEntry, parseCidrEntry } = await import("../src/utils/allowlist.js");

// ── 1. Liste vide : aucun changement de comportement ──

describe("liste blanche VIDE — comportement historique inchangé", () => {
  it("refuse une IP privée littérale", async () => {
    await expect(validateHttpUrl("http://10.10.0.5/")).rejects.toThrow(/Blocked/);
  });

  it("refuse un nom interne non autorisé", async () => {
    await expect(validateHttpUrl("http://switchy/")).rejects.toThrow(/Blocked private address/);
  });

  it("refuse loopback et lien-local", async () => {
    await expect(validateHttpUrl("http://127.0.0.1/")).rejects.toThrow(/Blocked/);
    await expect(validateHttpUrl("http://169.254.169.254/")).rejects.toThrow(/Blocked/);
  });

  it("accepte toujours une cible publique", async () => {
    await expect(validateHttpUrl("http://public.test/")).resolves.toBe("http://public.test/");
  });

  it("aucune autorisation journalisée", async () => {
    resetSsrfAuditLogForTests();
    await validateHttpUrl("http://public.test/");
    expect(getSsrfAuditLog()).toEqual([]);
  });
});

// ── 2. Autorisation par nom d'hôte ──

describe("autorisation PAR NOM D'HÔTE", () => {
  it("accepte le nom autorisé (résolution interne)", async () => {
    const target = await resolveHttpTarget("http://switchy/", { policy: { hosts: ["switchy"], cidrs: [] } });
    expect(target.url).toBe("http://switchy/");
    expect(target.ips).toEqual(["10.10.0.5"]);
    expect(target.pinnedIp).toBe("10.10.0.5");
    expect(target.grant).toEqual({ kind: "host", entry: "switchy" });
  });

  it("refuse un AUTRE nom interne non autorisé", async () => {
    await expect(
      resolveHttpTarget("http://internal.test/", { policy: { hosts: ["switchy"], cidrs: [] } }),
    ).rejects.toThrow(/Blocked private address/);
  });

  it("refuse l'IP littérale de la même plage (nom ≠ IP)", async () => {
    await expect(
      resolveHttpTarget("http://10.10.0.5/", { policy: { hosts: ["switchy"], cidrs: [] } }),
    ).rejects.toThrow(/Blocked private address/);
  });

  it("joker de suffixe `*.holaf.lan`", async () => {
    expect(matchHostEntry("nas.holaf.lan", ["*.holaf.lan"])).toBe("*.holaf.lan");
    expect(matchHostEntry("holaf.lan", ["*.holaf.lan"])).toBeNull();
    expect(matchHostEntry("nas.autre.lan", ["*.holaf.lan"])).toBeNull();
  });

  it("garde ANTI DNS-REBINDING : nom autorisé résolvant en public → refusé", async () => {
    await expect(
      resolveHttpTarget("http://rebind.test/", { policy: { hosts: ["rebind.test"], cidrs: [] } }),
    ).rejects.toThrow(/Blocked public address for allow-listed hostname/);
  });

  it("le nom autorisé reste journalisé (route + hôte + IP, sans secret)", async () => {
    resetSsrfAuditLogForTests();
    await resolveHttpTarget("http://pi-web/admin?token=SECRET", {
      policy: { hosts: ["pi-web"], cidrs: [] },
      route: "fetch",
    });
    const log = getSsrfAuditLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ route: "fetch", hostname: "pi-web", ip: "10.10.0.4" });
    // L'URL (et donc ses paramètres) n'est JAMAIS journalisée.
    expect(JSON.stringify(log)).not.toContain("SECRET");
    expect(JSON.stringify(log)).not.toContain("admin");
  });
});

// ── 3. Autorisation par plage CIDR ──

describe("autorisation PAR PLAGE CIDR", () => {
  it("accepte une IP littérale couverte", async () => {
    const target = await resolveHttpTarget("http://10.10.7.8/", { policy: { hosts: [], cidrs: ["10.10.0.0/16"] } });
    expect(target.grant).toEqual({ kind: "cidr", entry: "10.10.0.0/16" });
  });

  it("accepte un nom résolvant dans la plage (autorisation par plage, pas par nom)", async () => {
    const target = await resolveHttpTarget("http://switchy/", { policy: { hosts: [], cidrs: ["10.10.0.0/16"] } });
    expect(target.grant).toEqual({ kind: "cidr", entry: "10.10.0.0/16" });
  });

  it("refuse une IP hors plage", async () => {
    await expect(
      resolveHttpTarget("http://192.168.5.5/", { policy: { hosts: [], cidrs: ["10.10.0.0/16"] } }),
    ).rejects.toThrow(/Blocked private address/);
  });

  it("ipInCidr : bornes exactes, IPv4 et IPv6", () => {
    expect(ipInCidr("10.10.0.1", "10.10.0.0/16")).toBe(true);
    expect(ipInCidr("10.10.255.255", "10.10.0.0/16")).toBe(true);
    expect(ipInCidr("10.11.0.1", "10.10.0.0/16")).toBe(false);
    expect(ipInCidr("192.168.1.20", "192.168.1.20")).toBe(true);
    expect(ipInCidr("192.168.1.21", "192.168.1.20")).toBe(false);
    expect(ipInCidr("fd00::5", "fd00::/8")).toBe(true);
    expect(ipInCidr("fe00::5", "fd00::/8")).toBe(false);
    // Une IPv4-mapped est comparée comme une IPv4.
    expect(ipInCidr("::ffff:10.10.0.5", "10.10.0.0/16")).toBe(true);
  });
});

// ── 4. Protections CONSERVÉES ──

describe("protections conservées même avec une liste blanche large", () => {
  const wide = { hosts: ["switchy", "rebind.test"], cidrs: ["0.0.0.0/0", "::/0"] };

  it("file:// reste refusé", async () => {
    await expect(validateHttpUrl("file:///etc/passwd", { policy: wide })).rejects.toThrow(/http\/https/);
  });

  it("métadonnées cloud 169.254.169.254 TOUJOURS refusées", async () => {
    await expect(validateHttpUrl("http://169.254.169.254/latest/meta-data/", { policy: wide })).rejects.toThrow(
      /Blocked link-local/,
    );
    // Même en IPv4-mapped.
    await expect(validateHttpUrl("http://[::ffff:169.254.169.254]/", { policy: wide })).rejects.toThrow(
      /Blocked link-local/,
    );
  });

  it("identifiants dans l'URL toujours refusés", async () => {
    await expect(validateHttpUrl("http://user:pass@10.10.0.5/", { policy: wide })).rejects.toThrow(/credentials/);
  });

  it("un nom autorisé résolvant en public reste refusé malgré une plage 0.0.0.0/0", async () => {
    await expect(
      resolveHttpTarget("http://rebind.test/", { policy: { hosts: ["rebind.test"], cidrs: [] } }),
    ).rejects.toThrow(/Blocked public address/);
  });
});

// ── 5. Redirections ──

describe("redirections — une cible autorisée ne rebondit pas hors liste", () => {
  it("assertRedirectAllowed accepte une redirection DANS la liste", async () => {
    const out = await assertRedirectAllowed("http://switchy/", "/admin", {
      policy: { hosts: ["switchy"], cidrs: [] },
    });
    expect(out).toBe("http://switchy/admin");
  });

  it("assertRedirectAllowed refuse une redirection HORS liste (nom non autorisé)", async () => {
    await expect(
      assertRedirectAllowed("http://switchy/", "http://internal.test/secret", {
        policy: { hosts: ["switchy"], cidrs: [] },
      }),
    ).rejects.toThrow(/Blocked/);
  });

  it("assertRedirectAllowed refuse une redirection vers une IP privée littérale", async () => {
    await expect(
      assertRedirectAllowed("http://switchy/", "http://10.10.0.99/", { policy: { hosts: ["switchy"], cidrs: [] } }),
    ).rejects.toThrow(/Blocked/);
  });

  it("assertRedirectAllowed refuse un protocole non http(s)", async () => {
    await expect(
      assertRedirectAllowed("http://switchy/", "file:///etc/passwd", { policy: { hosts: ["switchy"], cidrs: [] } }),
    ).rejects.toThrow(/Blocked redirect/);
  });

  it("probeRedirectChain : chaîne autorisée → ok", async () => {
    installMockFetch((req) => {
      if (req.url === "http://switchy/") {
        return new Response("", { status: 302, headers: { Location: "/admin" } });
      }
      return new Response("", { status: 200 });
    });
    const probe = await probeRedirectChain("http://switchy/", { policy: { hosts: ["switchy"], cidrs: [] } });
    expect(probe).toEqual({ ok: true });
    setFetchForTests(null);
  });

  it("probeRedirectChain : redirection hors liste → refusée", async () => {
    installMockFetch((req) => {
      if (req.url === "http://switchy/") {
        return new Response("", { status: 302, headers: { Location: "http://internal.test/secret" } });
      }
      return new Response("", { status: 200 });
    });
    const probe = await probeRedirectChain("http://switchy/", { policy: { hosts: ["switchy"], cidrs: [] } });
    expect(probe).toEqual({ ok: false, reason: "redirect-not-allowed" });
    setFetchForTests(null);
  });
});

// ── 6. Syntaxe des entrées (miroir de la validation de l'API) ──

describe("normalisation / validation des entrées", () => {
  it("tolère une URL collée, un port et un point final", () => {
    expect(normalizeHostEntry("http://Switchy:3007/x?y=1")).toBe("switchy");
    expect(normalizeHostEntry("nas.lan.")).toBe("nas.lan");
    expect(normalizeHostEntry("*.holaf.lan")).toBe("*.holaf.lan");
  });

  it("refuse une IP dans la liste des noms", () => {
    expect(normalizeHostEntry("10.10.0.5")).toBeNull();
    expect(normalizeHostEntry("http://10.10.0.5:3007/")).toBeNull();
  });

  it("parseCidrEntry : plages valides et invalides", () => {
    expect(parseCidrEntry("10.10.0.0/16")).toEqual({ address: "10.10.0.0", bits: 16 });
    expect(parseCidrEntry("192.168.1.20")).toEqual({ address: "192.168.1.20", bits: 32 });
    expect(parseCidrEntry("fd00::/8")).toEqual({ address: "fd00::", bits: 8 });
    expect(parseCidrEntry("10.10.0.0/33")).toBeNull();
    expect(parseCidrEntry("switchy")).toBeNull();
  });
});

// ── 7. Configuration via l'INTERFACE (route API + persistance) ──

describe("configuration depuis l'interface web", () => {
  let env: TestEnv;

  beforeEach(() => {
    env = makeTestEnv();
    resetSettingsCache();
  });

  afterEach(() => {
    env.cleanup();
  });

  it("GET /api/admin/settings expose le groupe « internal-access » VIDE par défaut", async () => {
    const res = await request(env.app).get("/api/admin/settings");
    expect(res.status).toBe(200);
    const group = res.body.groups.find((g: any) => g.id === "internal-access");
    expect(group).toBeDefined();
    const hosts = group.settings.find((s: any) => s.name === "LIBRY_SSRF_ALLOWED_HOSTS");
    const cidrs = group.settings.find((s: any) => s.name === "LIBRY_SSRF_ALLOWED_CIDRS");
    expect(hosts).toMatchObject({ value: "", source: "default", editable: true, type: "hostList" });
    expect(cidrs).toMatchObject({ value: "", source: "default", editable: true, type: "cidrList" });
  });

  it("PUT persiste les entrées (normalisées) et les applique à chaud", async () => {
    const put = await request(env.app)
      .put("/api/admin/settings")
      .send({
        settings: {
          LIBRY_SSRF_ALLOWED_HOSTS: "Switchy, http://pi-web:3007/",
          LIBRY_SSRF_ALLOWED_CIDRS: "192.168.1.0/24",
        },
      });
    expect(put.status).toBe(200);
    expect(put.body.updated).toEqual(["LIBRY_SSRF_ALLOWED_HOSTS", "LIBRY_SSRF_ALLOWED_CIDRS"]);

    const group = put.body.groups.find((g: any) => g.id === "internal-access");
    const hosts = group.settings.find((s: any) => s.name === "LIBRY_SSRF_ALLOWED_HOSTS");
    expect(hosts.value).toBe("switchy,pi-web"); // normalisé (minuscules, port/URL retirés)
    expect(hosts.source).toBe("file");

    // Persistance réelle dans config.json du répertoire de données.
    const onDisk = JSON.parse(readFileSync(join(env.dir, "config.json"), "utf-8"));
    expect(onDisk.LIBRY_SSRF_ALLOWED_HOSTS).toBe("switchy,pi-web");

    // Effet immédiat, sans redémarrage : la cible interne est acceptée.
    resetSettingsCache();
    const target = await resolveHttpTarget("http://switchy/", { route: "fetch" });
    expect(target.grant).toEqual({ kind: "host", entry: "switchy" });
  });

  it("l'environnement reste PRIORITAIRE sur le fichier (env ?? fichier ?? défaut)", async () => {
    await request(env.app).put("/api/admin/settings").send({ settings: { LIBRY_SSRF_ALLOWED_CIDRS: "10.10.0.0/16" } });
    process.env.LIBRY_SSRF_ALLOWED_CIDRS = "192.168.1.0/24";
    try {
      const s = await request(env.app).get("/api/admin/settings");
      const group = s.body.groups.find((g: any) => g.id === "internal-access");
      const cidrs = group.settings.find((x: any) => x.name === "LIBRY_SSRF_ALLOWED_CIDRS");
      expect(cidrs).toMatchObject({ value: "192.168.1.0/24", source: "env", editable: false });
      resetSettingsCache();
      await expect(resolveHttpTarget("http://10.10.0.5/")).rejects.toThrow(/Blocked/);
      await expect(resolveHttpTarget("http://192.168.1.5/")).resolves.toMatchObject({ hostname: "192.168.1.5" });
    } finally {
      delete process.env.LIBRY_SSRF_ALLOWED_CIDRS;
    }
  });

  it("PUT refuse une entrée CIDR invalide (400) et n'écrit RIEN", async () => {
    const res = await request(env.app)
      .put("/api/admin/settings")
      .send({ settings: { LIBRY_SSRF_ALLOWED_CIDRS: "10.10.0.0/99" } });
    expect(res.status).toBe(400);
    expect(res.body.errors.join(" ")).toMatch(/invalid CIDR/);

    const after = await request(env.app).get("/api/admin/settings");
    const group = after.body.groups.find((g: any) => g.id === "internal-access");
    expect(group.settings.find((s: any) => s.name === "LIBRY_SSRF_ALLOWED_CIDRS").value).toBe("");
    expect(existsSync(join(env.dir, "config.json"))).toBe(false);
  });

  it("PUT refuse un nom d'hôte invalide (400)", async () => {
    const res = await request(env.app)
      .put("/api/admin/settings")
      .send({ settings: { LIBRY_SSRF_ALLOWED_HOSTS: "pas un hôte!" } });
    expect(res.status).toBe(400);
    expect(res.body.errors.join(" ")).toMatch(/invalid hostname/);
  });

  it("PUT null efface l'entrée (retour au défaut : aucune adresse interne)", async () => {
    await request(env.app).put("/api/admin/settings").send({ settings: { LIBRY_SSRF_ALLOWED_HOSTS: "switchy" } });
    const cleared = await request(env.app)
      .put("/api/admin/settings")
      .send({ settings: { LIBRY_SSRF_ALLOWED_HOSTS: null } });
    expect(cleared.status).toBe(200);
    const group = cleared.body.groups.find((g: any) => g.id === "internal-access");
    expect(group.settings.find((s: any) => s.name === "LIBRY_SSRF_ALLOWED_HOSTS")).toMatchObject({
      value: "",
      source: "default",
    });
    resetSettingsCache();
    await expect(resolveHttpTarget("http://switchy/")).rejects.toThrow(/Blocked/);
  });

  it("GET /api/admin/ssrf-log expose le journal des autorisations", async () => {
    resetSsrfAuditLogForTests();
    await resolveHttpTarget("http://switchy/", { policy: { hosts: ["switchy"], cidrs: [] }, route: "screenshot" });
    const res = await request(env.app).get("/api/admin/ssrf-log");
    expect(res.status).toBe(200);
    expect(res.body.entries[0]).toMatchObject({ route: "screenshot", hostname: "switchy", ip: "10.10.0.5" });
  });
});

// ── 8. Non-régression des routes (SSRF toujours appliqué) ──

describe("routes HTTP — liste blanche vide = refus comme avant", () => {
  let env: TestEnv;
  let apiKey: string;

  beforeEach(() => {
    env = makeTestEnv();
    apiKey = createKey("allowlist-routes").key;
    setCaptureImplForTests(null);
  });

  afterEach(() => {
    setCaptureImplForTests(null);
    env.cleanup();
  });

  it("/fetch refuse une cible interne (403 non fuyant)", async () => {
    const res = await request(env.app)
      .post("/api/librarian/fetch")
      .set("X-API-Key", apiKey)
      .send({ url: "http://switchy/" });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "URL not allowed" });
  });

  it("/fetch accepte une cible interne AUTORISÉE par l'environnement", async () => {
    env.cleanup();
    env = makeTestEnv({ LIBRY_SSRF_ALLOWED_HOSTS: "switchy" });
    apiKey = createKey("allowlist-routes-env").key;
    installMockFetch(() => jsonResponse({ content: "ok", title: "Interne" }));

    const res = await request(env.app)
      .post("/api/librarian/fetch")
      .set("X-API-Key", apiKey)
      .send({ url: "http://switchy/doc" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ url: "http://switchy/doc", content: "ok" });
  });

  it("/crawl et /batch refusent toujours une cible interne non autorisée", async () => {
    const crawl = await request(env.app)
      .post("/api/librarian/crawl")
      .set("X-API-Key", apiKey)
      .send({ url: "http://10.10.0.5/" });
    expect(crawl.status).toBe(403);

    const batch = await request(env.app)
      .post("/api/librarian/batch")
      .set("X-API-Key", apiKey)
      .send({ urls: ["https://public.test/", "http://10.10.0.5/"] });
    expect(batch.status).toBe(403);
    expect(batch.body).toEqual({ error: "URL not allowed" });
  });

  it("/screenshot refuse une cible interne non autorisée SANS spawn", async () => {
    let called = false;
    setCaptureImplForTests(async () => {
      called = true;
      return { buffer: Buffer.from([0x89]), width: 1, height: 1, bytes: 1 };
    });
    const res = await request(env.app)
      .post("/api/librarian/screenshot")
      .set("X-API-Key", apiKey)
      .send({ url: "http://switchy/" });
    expect(res.status).toBe(403);
    expect(called).toBe(false);
  });

  it("/screenshot d'une cible interne AUTORISÉE : capture acceptée + journal", async () => {
    env.cleanup();
    env = makeTestEnv({ LIBRY_SSRF_ALLOWED_HOSTS: "switchy" });
    apiKey = createKey("allowlist-shot").key;
    let captured: any = null;
    setCaptureImplForTests(async (opts) => {
      captured = opts;
      return { buffer: Buffer.from([0x89, 0x50]), width: 10, height: 10, bytes: 2 };
    });
    // Sonde de redirection : aucune redirection.
    installMockFetch(() => new Response("", { status: 200 }));

    const res = await request(env.app)
      .post("/api/librarian/screenshot")
      .set("X-API-Key", apiKey)
      .send({ url: "http://switchy/", width: 10, height: 10 });
    expect(res.status).toBe(200);
    expect(captured?.resolverRule).toBe("MAP switchy 10.10.0.5"); // anti DNS-rebinding (épinglage)
    expect(getSsrfAuditLog()[0]).toMatchObject({ route: "screenshot", hostname: "switchy", ip: "10.10.0.5" });
  });

  it("/screenshot d'une cible interne autorisée dont la redirection sort de la liste → 403", async () => {
    env.cleanup();
    env = makeTestEnv({ LIBRY_SSRF_ALLOWED_HOSTS: "switchy" });
    apiKey = createKey("allowlist-shot-redirect").key;
    let called = false;
    setCaptureImplForTests(async () => {
      called = true;
      return { buffer: Buffer.from([0x89]), width: 1, height: 1, bytes: 1 };
    });
    installMockFetch((req) => {
      if (req.url === "http://switchy/") {
        return new Response("", { status: 302, headers: { Location: "http://10.10.0.99/secret" } });
      }
      return new Response("", { status: 200 });
    });

    const res = await request(env.app)
      .post("/api/librarian/screenshot")
      .set("X-API-Key", apiKey)
      .send({ url: "http://switchy/" });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "URL not allowed" });
    expect(called).toBe(false);
  });
});
