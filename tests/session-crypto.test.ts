import { describe, it, expect } from "vitest";
import {
  signSession,
  verifySessionToken,
  deriveCsrfToken,
  parseCookies,
  serializeCookie,
  type SessionPayload,
} from "../src/utils/session-crypto.js";
import { hashSecret, verifySecretHash, safeEqualSecret } from "../src/utils/secret-hash.js";

const SECRET = "a".repeat(64);
const OTHER_SECRET = "b".repeat(64);

function payload(overrides: Partial<SessionPayload> = {}): SessionPayload {
  return { sid: "sid-123", exp: Math.floor(Date.now() / 1000) + 3600, ep: 0, ...overrides };
}

describe("session-crypto — signature HMAC du jeton de session", () => {
  it("signe puis vérifie un payload (aller-retour)", () => {
    const p = payload();
    const token = signSession(p, SECRET);
    expect(token.split(".")).toHaveLength(2); // <payload>.<signature>
    expect(verifySessionToken(token, SECRET)).toEqual(p);
  });

  it("est déterministe : même payload + même secret → même jeton", () => {
    const p = payload();
    expect(signSession(p, SECRET)).toBe(signSession(p, SECRET));
  });

  it("rejette une signature falsifiée", () => {
    const token = signSession(payload(), SECRET);
    const [body, sig] = token.split(".");
    const tampered = `${body}.${sig.slice(0, -2)}xx`;
    expect(verifySessionToken(tampered, SECRET)).toBeNull();
  });

  it("rejette un payload falsifié (signature recalculée sans le bon secret)", () => {
    const forged = signSession(payload({ sid: "attaquant" }), OTHER_SECRET);
    expect(verifySessionToken(forged, SECRET)).toBeNull();
  });

  it("rejette un secret différent", () => {
    const token = signSession(payload(), SECRET);
    expect(verifySessionToken(token, OTHER_SECRET)).toBeNull();
  });

  it("rejette un jeton expiré", () => {
    const p = { sid: "s", exp: Math.floor(Date.now() / 1000) - 1, ep: 0 };
    const token = signSession(p, SECRET);
    expect(verifySessionToken(token, SECRET)).toBeNull();
    // Juste avant l'expiration, il reste valide.
    const alive = signSession({ sid: "s", exp: Math.floor(Date.now() / 1000) + 5, ep: 0 }, SECRET);
    expect(verifySessionToken(alive, SECRET)).not.toBeNull();
  });

  it("rejette un jeton malformé (structure, encodage, champs manquants)", () => {
    expect(verifySessionToken("", SECRET)).toBeNull();
    expect(verifySessionToken("pas-un-jeton", SECRET)).toBeNull();
    expect(verifySessionToken("a.b.c", SECRET)).toBeNull();
    expect(verifySessionToken("!!!.!!!", SECRET)).toBeNull();
    // Payload signé mais champs invalides → rejeté.
    const bad = signSession({ sid: "", exp: 9999999999, ep: 0 }, SECRET);
    expect(verifySessionToken(bad, SECRET)).toBeNull();
  });
});

describe("session-crypto — jeton CSRF et cookies", () => {
  it("dérive un jeton CSRF déterministe, distinct par session et par secret", () => {
    const a = deriveCsrfToken(SECRET, "sid-1");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(deriveCsrfToken(SECRET, "sid-1")).toBe(a);
    expect(deriveCsrfToken(SECRET, "sid-2")).not.toBe(a);
    expect(deriveCsrfToken(OTHER_SECRET, "sid-1")).not.toBe(a);
  });

  it("analyse un en-tête Cookie", () => {
    expect(parseCookies("libry_session=abc; libry_csrf=x.y")).toEqual({ libry_session: "abc", libry_csrf: "x.y" });
    expect(parseCookies("")).toEqual({});
    expect(parseCookies(undefined)).toEqual({});
  });

  it("sérialise un cookie avec ses attributs", () => {
    const c = serializeCookie("libry_session", "tok", { httpOnly: true, sameSite: "Strict", maxAge: 60, path: "/" });
    expect(c).toBe("libry_session=tok; Path=/; Max-Age=60; HttpOnly; SameSite=Strict");
    const secure = serializeCookie("x", "y", { secure: true, maxAge: 0 });
    expect(secure).toContain("Secure");
    expect(secure).toContain("Max-Age=0");
  });
});

describe("session-crypto — hachage scrypt des mots de passe", () => {
  it("hache puis vérifie un mot de passe", () => {
    const hash = hashSecret("s3cret-pw");
    expect(hash).toMatch(/^scrypt:[0-9a-f]+:[0-9a-f]+$/);
    expect(verifySecretHash("s3cret-pw", hash)).toBe(true);
    expect(verifySecretHash("mauvais", hash)).toBe(false);
  });

  it("rejette les hash malformés", () => {
    expect(verifySecretHash("x", "pas-un-hash")).toBe(false);
    expect(verifySecretHash("x", "scrypt:zz:zz")).toBe(false);
    expect(verifySecretHash("x", "bcrypt:aa:bb")).toBe(false);
  });

  it("safeEqualSecret est une comparaison exacte", () => {
    expect(safeEqualSecret("abc", "abc")).toBe(true);
    expect(safeEqualSecret("abc", "abcd")).toBe(false);
    expect(safeEqualSecret("abc", "abd")).toBe(false);
  });
});
