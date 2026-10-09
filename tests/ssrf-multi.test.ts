import { describe, it, expect, vi } from "vitest";

// DNS simulé : permet de tester la politique TOUT-OU-RIEN (une IP sensible
// parmi des IP publiques doit suffire à refuser la cible).
vi.mock("dns/promises", () => ({
  lookup: vi.fn(async (hostname: string) => {
    if (hostname === "mixed.test") {
      return [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.5", family: 4 },
      ];
    }
    if (hostname === "allpublic.test") {
      return [
        { address: "93.184.216.34", family: 4 },
        { address: "1.1.1.1", family: 4 },
      ];
    }
    throw new Error("ENOTFOUND");
  }),
}));

const { validateHttpUrl, resolveHttpTarget } = await import("../src/utils/ssrf.js");

describe("validateHttpUrl — politique tout-ou-rien sur résolution multiple", () => {
  it("refuse un hôte résolvant vers une IP privée ET des IP publiques", async () => {
    await expect(validateHttpUrl("http://mixed.test/")).rejects.toThrow(/Blocked/);
  });

  it("accepte un hôte dont TOUTES les IP sont publiques", async () => {
    const out = await validateHttpUrl("http://allpublic.test/");
    expect(out).toBe("http://allpublic.test/");
  });

  it("resolveHttpTarget expose toutes les IP validées", async () => {
    const t = await resolveHttpTarget("http://allpublic.test/");
    expect(t.ips).toEqual(["93.184.216.34", "1.1.1.1"]);
    expect(t.pinnedIp).toBe("93.184.216.34");
  });

  it("refuse un hôte non résolvable", async () => {
    await expect(validateHttpUrl("http://nope.test/")).rejects.toThrow(/DNS resolution failed/);
  });
});
