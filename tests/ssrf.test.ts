import { describe, it, expect } from "vitest";
import {
  validateHttpUrl,
  resolveHttpTarget,
  isPrivateIp,
  isLoopbackIp,
  isLinkLocalIp,
  effectiveIpv4,
  extractTransitionIpv4,
} from "../src/utils/ssrf.js";

describe("validateHttpUrl — IP littérales sensibles (refus)", () => {
  const blocked = [
    "http://127.0.0.1/",
    "http://127.1.2.3/",
    "http://[::1]/",
    "http://169.254.169.254/",
    "http://10.0.0.1/",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://192.168.1.1/",
    "http://0.0.0.0/",
    "http://[fe80::1]/",
  ];

  for (const url of blocked) {
    it(`refuse ${url}`, async () => {
      await expect(validateHttpUrl(url)).rejects.toThrow(/Blocked/);
    });
  }
});

describe("validateHttpUrl — schémas et identifiants", () => {
  it("refuse file:// (jamais exposé)", async () => {
    await expect(validateHttpUrl("file:///etc/passwd")).rejects.toThrow(/http\/https/);
  });

  it("refuse ftp://", async () => {
    await expect(validateHttpUrl("ftp://example.com/x")).rejects.toThrow(/http\/https/);
  });

  it("refuse une URL avec identifiants", async () => {
    await expect(validateHttpUrl("http://user:pass@1.1.1.1/")).rejects.toThrow(/credentials/);
  });

  it("refuse une URL invalide", async () => {
    await expect(validateHttpUrl("not a url")).rejects.toThrow(/Invalid URL/);
  });
});

describe("validateHttpUrl — formes de transition IPv6", () => {
  it("refuse 6to4 encapsulant 10.0.0.1", async () => {
    await expect(validateHttpUrl("http://[2002:0a00:0001::]")).rejects.toThrow(/Blocked/);
  });

  it("refuse IPv4-mapped loopback [::ffff:127.0.0.1]", async () => {
    await expect(validateHttpUrl("http://[::ffff:127.0.0.1]")).rejects.toThrow(/Blocked/);
  });
});

describe("validateHttpUrl — cible publique acceptée", () => {
  it("accepte une IP publique littérale et retourne l'URL normalisée", async () => {
    const out = await validateHttpUrl("https://1.1.1.1/");
    expect(out).toBe("https://1.1.1.1/");
  });

  it("resolveHttpTarget retourne hostname + IP épinglable", async () => {
    const t = await resolveHttpTarget("https://example.com/path");
    expect(t.hostname).toBe("example.com");
    expect(t.ips.length).toBeGreaterThan(0);
    expect(t.pinnedIp).toBe(t.ips[0]);
    expect(t.url).toBe("https://example.com/path");
  });

  it("une IP littérale n'a pas d'IP à épingler", async () => {
    const t = await resolveHttpTarget("https://1.1.1.1/");
    expect(t.pinnedIp).toBeNull();
  });
});

describe("prédicats d'adresses (unitaire)", () => {
  it("isLoopbackIp", () => {
    expect(isLoopbackIp("127.0.0.1")).toBe(true);
    expect(isLoopbackIp("::1")).toBe(true);
    expect(isLoopbackIp("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackIp("1.1.1.1")).toBe(false);
  });

  it("isPrivateIp (RFC1918 + 0.0.0.0/8 + fc00::/7)", () => {
    expect(isPrivateIp("10.1.2.3")).toBe(true);
    expect(isPrivateIp("172.16.0.1")).toBe(true);
    expect(isPrivateIp("172.31.0.1")).toBe(true);
    expect(isPrivateIp("172.32.0.1")).toBe(false);
    expect(isPrivateIp("192.168.10.1")).toBe(true);
    expect(isPrivateIp("0.0.0.0")).toBe(true);
    expect(isPrivateIp("fd00::1")).toBe(true);
    expect(isPrivateIp("8.8.8.8")).toBe(false);
  });

  it("isLinkLocalIp", () => {
    expect(isLinkLocalIp("169.254.169.254")).toBe(true);
    expect(isLinkLocalIp("fe80::1")).toBe(true);
    expect(isLinkLocalIp("1.1.1.1")).toBe(false);
  });

  it("effectiveIpv4 (mapped)", () => {
    expect(effectiveIpv4("::ffff:192.168.0.1")).toEqual([192, 168, 0, 1]);
    expect(effectiveIpv4("8.8.8.8")).toEqual([8, 8, 8, 8]);
  });

  it("extractTransitionIpv4 (6to4 / NAT64 / non-transition)", () => {
    expect(extractTransitionIpv4("2002:0a00:0001::")).toEqual([10, 0, 0, 1]);
    expect(extractTransitionIpv4("64:ff9b::a00:1")).toEqual([10, 0, 0, 1]);
    expect(extractTransitionIpv4("2001:db8::1")).toBeNull();
  });
});
