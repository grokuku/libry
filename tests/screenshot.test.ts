import { describe, it, expect, afterAll } from "vitest";
import {
  detectChromium,
  runWithTimeout,
  captureScreenshot,
  buildResolverRule,
  ScreenshotError,
} from "../src/screenshot.js";
import type { ResolvedHttpTarget } from "../src/utils/ssrf.js";

// Les tests tournent en root dans cet environnement : la sandbox Chromium
// refuserait de démarrer. On force donc le repli `--no-sandbox` ICI uniquement
// (le défaut du service reste SANS --no-sandbox).
const AS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;
const noSandbox = AS_ROOT;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("détection du binaire Chromium", () => {
  it("trouve un binaire (CHROMIUM_PATH ou which)", () => {
    const bin = detectChromium();
    expect(bin).toBeTruthy();
  });

  it("respecte CHROMIUM_PATH", () => {
    const prev = process.env.CHROMIUM_PATH;
    process.env.CHROMIUM_PATH = "/usr/bin/chromium";
    try {
      expect(detectChromium()).toBe("/usr/bin/chromium");
    } finally {
      if (prev === undefined) delete process.env.CHROMIUM_PATH;
      else process.env.CHROMIUM_PATH = prev;
    }
  });
});

describe("runWithTimeout — jamais d'orphelin", () => {
  it("tue le process avec SIGKILL au dépassement du timeout", async () => {
    const start = Date.now();
    const r = await runWithTimeout("sleep", ["30"], 400);
    const elapsed = Date.now() - start;
    expect(r.timedOut).toBe(true);
    expect(r.signal).toBe("SIGKILL");
    expect(elapsed).toBeLessThan(5_000);
  });

  it("laisse un process court se terminer normalement", async () => {
    const r = await runWithTimeout("sleep", ["0"], 5_000);
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(0);
  });
});

describe("buildResolverRule", () => {
  const base: ResolvedHttpTarget = {
    url: "https://example.com/",
    hostname: "example.com",
    ips: ["93.184.216.34"],
    pinnedIp: "93.184.216.34",
  };

  it("épingle le nom vers l'IP validée", () => {
    expect(buildResolverRule(base)).toBe("MAP example.com 93.184.216.34");
  });

  it("met l'IPv6 entre crochets", () => {
    expect(buildResolverRule({ ...base, ips: ["2606:2800::1"], pinnedIp: "2606:2800::1" })).toBe(
      "MAP example.com [2606:2800::1]",
    );
  });

  it("null pour une IP littérale", () => {
    expect(buildResolverRule({ ...base, hostname: "1.1.1.1", pinnedIp: null })).toBeNull();
  });
});

describe("captureScreenshot — capture réelle", () => {
  it("produit un PNG valide pour https://example.com", async () => {
    const res = await captureScreenshot({
      url: "https://example.com",
      width: 800,
      height: 600,
      timeoutMs: 30_000,
      noSandbox,
    });
    expect(res.width).toBe(800);
    expect(res.height).toBe(600);
    expect(res.bytes).toBeGreaterThan(1000);
    expect(res.buffer.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  }, 45_000);

  it("timeout sur une cible injoignable → ScreenshotError(timedOut) + SIGKILL", async () => {
    // 192.0.2.1 (TEST-NET-1, RFC 5737) est routable mais noire : la connexion
    // reste en attente, donc seul le timeout peut terminer la capture.
    try {
      await captureScreenshot({ url: "http://192.0.2.1/", timeoutMs: 1_500, noSandbox });
      throw new Error("la capture aurait dû expirer");
    } catch (e) {
      expect(e).toBeInstanceOf(ScreenshotError);
      expect((e as ScreenshotError).timedOut).toBe(true);
    }
  }, 30_000);
});

afterAll(() => {
  // Rien à nettoyer : les répertoires temporaires sont supprimés par la capture.
});
