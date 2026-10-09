/**
 * Identité réseau d'une requête HTTP — détection « localhost » NON forgeable.
 *
 * Reprise de Pi-Web (backend/src/utils/request-identity.ts, correctif SEC-02) :
 * on n'utilise QUE l'adresse de la socket TCP (`req.socket.remoteAddress`), qui
 * reflète la connexion réelle et n'est pas influencée par les en-têtes HTTP
 * (notamment X-Forwarded-For). Un client ne peut donc pas se faire passer pour
 * la boucle locale en forgeant un en-tête.
 */
import { type Request } from "express";

/**
 * Vrai si l'adresse est une adresse de boucle locale :
 *   - IPv6 `::1` ;
 *   - IPv4 `127.0.0.0/8` (ex. 127.0.0.1, 127.0.0.2) ;
 *   - IPv4-mapped IPv6 `::ffff:127.0.0.0/8` (ex. `::ffff:127.0.0.1`).
 *
 * Le suffixe de zone IPv6 (ex. `::1%lo0`) et la casse sont normalisés.
 */
export function isLoopbackAddress(address: string | undefined | null): boolean {
  if (!address) return false;

  const normalized = address.trim().toLowerCase().replace(/%.*$/, "");
  if (normalized === "::1") return true;

  // Déballe la forme IPv4-mapped IPv6 (`::ffff:a.b.c.d`).
  const ipv4 = normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;

  const octets = ipv4.split(".");
  if (octets.length !== 4) return false;
  if (!octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255)) return false;
  return octets[0] === "127";
}

/**
 * Vrai si la requête provient RÉELLEMENT de la boucle locale, d'après l'adresse
 * de la socket TCP. Ne consulte JAMAIS `req.ip` (dérivé de X-Forwarded-For,
 * donc forgeable).
 */
export function isTrustedLocalRequest(req: Request): boolean {
  return isLoopbackAddress(req.socket?.remoteAddress);
}
