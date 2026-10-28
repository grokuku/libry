/**
 * Validation SSRF des URL fournies par l'appelant (port depuis
 * Pi-Web backend/src/utils/ssrf.ts — NE PAS modifier l'original, il sert aussi
 * à d'autres routes de Pi-Web).
 *
 * Règles (politique TOUT-OU-RIEN : une seule adresse sensible suffit à refuser) :
 *  - protocole http/https uniquement (donc file://, ftp://, data://… refusés) ;
 *  - identifiants dans l'URL refusés (http://user:pass@host/) ;
 *  - adresses lien-local (ex. 169.254.169.254, métadonnées cloud) TOUJOURS bloquées,
 *    même si une plage autorisée couvre 169.254.0.0/16 (garde absolue) ;
 *  - adresses loopback/privées/internes bloquées par défaut, SAUF si la cible est
 *    couverte par la LISTE BLANCHE explicite de l'administrateur
 *    (`LIBRY_SSRF_ALLOWED_HOSTS` / `LIBRY_SSRF_ALLOWED_CIDRS`, vide par défaut →
 *    comportement historique strictement inchangé).
 *
 * Liste blanche (voir `utils/allowlist.ts` pour la syntaxe) :
 *  - PLAGE CIDR (`10.10.0.0/16`) : autorise CES adresses, quel que soit le nom ;
 *  - NOM D'HÔTE (`switchy`) : autorise ce nom — et SEULEMENT lui — à joindre le
 *    réseau interne. Garde anti DNS-rebinding : si le nom autorisé résout vers
 *    une adresse NON interne (publique), la cible est REFUSÉE (une réponse
 *    publique pour un nom interne = rebinding / détournement de DNS).
 *  - Chaque autorisation réellement utilisée est journalisée (sans secret) dans
 *    un tampon circulaire consultable depuis l'interface (`getSsrfAuditLog`).
 *
 * La résolution DNS est faite au moment de la validation. Pour la capture
 * d'écran (anti DNS-rebinding), `resolveHttpTarget` retourne EN PLUS les IP
 * résolues afin que l'appelant puisse épingler la résolution côté Chromium
 * (`--host-resolver-rules`) : le nom résolu lors de la validation est celui
 * réellement contacté, sans seconde résolution DNS indépendante.
 */

import { lookup } from "dns/promises";
import { isIP } from "net";
import { getSsrfAllowedCidrs, getSsrfAllowedHosts } from "../config.js";
import { normalizeCidrList, normalizeHostList, parseCidrEntry } from "./allowlist.js";

/** Liste blanche des adresses internes (vide par défaut = politique stricte). */
export interface SsrfPolicy {
  /** Noms d'hôtes autorisés (`switchy`, `*.holaf.lan`), normalisés en minuscules. */
  hosts: string[];
  /** Plages CIDR autorisées (`10.10.0.0/16`), ou IP seules (= /32, /128). */
  cidrs: string[];
}

/** Autorisation effectivement appliquée à une cible (pour le journal). */
export interface SsrfGrant {
  /** `cidr` = autorisation par plage, `host` = autorisation par nom d'hôte. */
  kind: "cidr" | "host";
  /** Entrée de la liste blanche qui a autorisé la cible. */
  entry: string;
}

export interface SsrfOptions {
  /** Liste blanche explicite (prioritaire sur la configuration). */
  policy?: SsrfPolicy;
  /** Libellé d'appel (route) porté dans le journal des autorisations. */
  route?: string;
  /** Échappatoires historiques (aucun appelant : conservées pour compatibilité). */
  allowPrivate?: boolean;
  allowLoopback?: boolean;
}

/** Cible HTTP validée : URL normalisée + adresses résolues (pour l'épinglage). */
export interface ResolvedHttpTarget {
  /** URL normalisée (issue de `new URL(...).toString()`). */
  url: string;
  /** Nom d'hôte sans crochets IPv6. */
  hostname: string;
  /** Toutes les adresses résolues (au moins une), après validation. */
  ips: string[];
  /**
   * Adresse à épingler pour `--host-resolver-rules` (première IP validée),
   * ou null quand le nom d'hôte est déjà une IP littérale (aucun DNS à épingler).
   */
  pinnedIp: string | null;
  /** Autorisation liste blanche utilisée (`null` = cible publique, sans objet). */
  grant: SsrfGrant | null;
}

/** Retire les crochets d'une IPv6 renvoyée par URL.hostname. */
function stripBrackets(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

/**
 * Parse une IPv6 en tableau de 8 groupes 16 bits.
 * Gère la compression `::`, le suffixe de zone (`fe80::1%eth0`) et la queue
 * IPv4 pointée (`::ffff:127.0.0.1` → les 2 derniers groupes).
 * Retourne null si ce n'est pas une IPv6 valide.
 */
function parseIpv6Groups(ip: string): number[] | null {
  let addr = ip.split("%")[0].toLowerCase(); // retrait de la zone d'interface

  // Queue IPv4 pointée (ex. ::ffff:1.2.3.4) → 2 groupes hexadécimaux.
  const v4Tail = addr.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4Tail) {
    const parts = v4Tail[1].split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
    const g1 = ((parts[0] << 8) | parts[1]).toString(16);
    const g2 = ((parts[2] << 8) | parts[3]).toString(16);
    addr = addr.slice(0, addr.length - v4Tail[1].length) + g1 + ":" + g2;
  }

  const halves = addr.split("::");
  if (halves.length > 2) return null; // au plus un seul `::`
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const groupRe = /^[0-9a-f]{1,4}$/;
  if (!head.every((g) => groupRe.test(g)) || !tail.every((g) => groupRe.test(g))) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  return [
    ...head.map((g) => parseInt(g, 16)),
    ...Array(missing).fill(0),
    ...tail.map((g) => parseInt(g, 16)),
  ];
}

/** Convertit une IP (y compris IPv4-mapped IPv6) en octets IPv4, sinon null. */
function toIpv4(ip: string): number[] | null {
  // 1) Forme textuelle `::ffff:a.b.c.d` (reconnue par isIP). SEC-04 : la forme
  //    hexadécimale normalisée par Node (`::ffff:a9fe:a9fe` pour
  //    http://[::ffff:169.254.169.254]) est gérée par le parseur ci-dessous.
  const lower = ip.toLowerCase();
  const v4 = lower.startsWith("::ffff:") ? lower.slice(7) : lower;
  if (isIP(v4) === 4) {
    const parts = v4.split(".").map(Number);
    if (parts.length === 4 && parts.every((n) => !Number.isNaN(n) && n >= 0 && n <= 255)) {
      return parts;
    }
  }
  // 2) Formes hexadécimales : IPv4-mapped (::ffff:0:0/96) — 32 derniers bits
  //    = IPv4 embarquée. NB : la forme dépréciée IPv4-compatible (::w.x.y.z)
  //    n'est PAS traitée ici afin de préserver la sémantique de ::1 (loopback)
  //    et des options allow* (comportement inchangé sur l'usage).
  const groups = parseIpv6Groups(ip);
  if (!groups) return null;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return [(groups[6] >> 8) & 0xff, groups[6] & 0xff, (groups[7] >> 8) & 0xff, groups[7] & 0xff];
  }
  return null;
}

/**
 * Extrait l'IPv4 embarquée des plages de transition IPv6 (SEC-04) :
 *  - 6to4 (2002::/16) : IPv4 dans les groupes 1-2 ;
 *  - Teredo (2001:0::/32) : IPv4 client obfusquée (XOR 0xFFFF) dans les groupes 6-7 ;
 *  - NAT64 well-known (64:ff9b::/96) et local-use (64:ff9b:1::/96) : groupes 6-7.
 * Sinon null (pas une plage de transition).
 */
export function extractTransitionIpv4(ip: string): number[] | null {
  const g = parseIpv6Groups(ip);
  if (!g) return null;
  const byte = (h: number, l: number): number[] => [(h >> 8) & 0xff, h & 0xff, (l >> 8) & 0xff, l & 0xff];
  if (g[0] === 0x2002) {
    return byte(g[1], g[2]); // 6to4
  }
  if (g[0] === 0x2001 && g[1] === 0) {
    return byte(g[6] ^ 0xffff, g[7] ^ 0xffff); // Teredo (obfuscation XOR 0xFFFF, RFC 4380)
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    return byte(g[6], g[7]); // NAT64 well-known
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    return byte(g[6], g[7]); // NAT64 local-use (RFC 8215)
  }
  return null;
}

/**
 * IPv4 effective d'une adresse : extraction directe (mapped) puis plages de
 * transition. Utilisée par les vérifications de sensibilité ci-dessous.
 */
export function effectiveIpv4(ip: string): number[] | null {
  return toIpv4(ip) ?? extractTransitionIpv4(ip);
}

export function isLoopbackIp(ip: string): boolean {
  const v4 = effectiveIpv4(ip);
  if (v4) return v4[0] === 127;
  return ip.toLowerCase() === "::1";
}

export function isLinkLocalIp(ip: string): boolean {
  const v4 = effectiveIpv4(ip);
  if (v4) return v4[0] === 169 && v4[1] === 254;
  // fe80::/10 → fe80-febf
  return /^fe[89ab]/i.test(ip);
}

export function isPrivateIp(ip: string): boolean {
  const v4 = effectiveIpv4(ip);
  if (v4) {
    const [a, b] = v4;
    // RFC1918 + 0.0.0.0/8 (non routable)
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 0;
  }
  // fc00::/7 (adresses locales uniques IPv6)
  return /^f[cd]/i.test(ip);
}

/** Vrai si l'adresse (IPv4 ou IPv6) appartient au réseau interne/privé. */
export function isInternalAddress(ip: string): boolean {
  if (isLoopbackIp(ip) || isPrivateIp(ip)) return true;
  const v4 = effectiveIpv4(ip);
  // CGNAT 100.64.0.0/10 : plage interne des opérateurs / overlay Docker.
  return v4 !== null && v4[0] === 100 && v4[1] >= 64 && v4[1] <= 127;
}

/** Représentation binaire d'une adresse, utilisée pour la comparaison CIDR. */
function ipToBytes(ip: string): { bytes: number[]; family: 4 | 6 } | null {
  const v4 = effectiveIpv4(ip);
  if (v4) return { bytes: v4, family: 4 };
  const groups = parseIpv6Groups(ip);
  if (!groups) return null;
  const bytes: number[] = [];
  for (const group of groups) bytes.push((group >> 8) & 0xff, group & 0xff);
  return { bytes, family: 6 };
}

/** Vrai si `ip` appartient à la plage `entry` (CIDR ou IP seule). */
export function ipInCidr(ip: string, entry: string): boolean {
  const cidr = parseCidrEntry(entry);
  if (!cidr) return false;
  const address = ipToBytes(cidr.address);
  const candidate = ipToBytes(ip);
  if (!address || !candidate || address.family !== candidate.family) return false;

  let remaining = cidr.bits;
  for (let i = 0; i < address.bytes.length && remaining > 0; i++) {
    const take = Math.min(8, remaining);
    const mask = take === 8 ? 0xff : (0xff << (8 - take)) & 0xff;
    if ((address.bytes[i] & mask) !== (candidate.bytes[i] & mask)) return false;
    remaining -= take;
  }
  return true;
}

/** Première plage de la liste blanche qui couvre `ip`, ou `null`. */
function matchCidrEntry(ip: string, cidrs: string[]): string | null {
  for (const entry of cidrs) if (ipInCidr(ip, entry)) return entry;
  return null;
}

/**
 * Entrée de la liste blanche qui autorise `hostname` (correspondance EXACTE ou
 * joker de suffixe `*.domaine`), ou `null`. L'IP littérale d'une URL ne peut
 * pas être autorisée par nom : seules les plages couvrent les littéraux.
 */
export function matchHostEntry(hostname: string, hosts: string[]): string | null {
  const host = stripBrackets(hostname).toLowerCase().replace(/\.$/, "");
  if (host === "" || isIP(host) !== 0) return null;
  for (const entry of hosts) {
    const pattern = entry.toLowerCase();
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1); // `.holaf.lan`
      if (host.endsWith(suffix) && host.length > suffix.length) return entry;
      continue;
    }
    if (host === pattern) return entry;
  }
  return null;
}

/** Liste blanche effective : option explicite, sinon configuration `env ?? fichier`. */
export function resolveSsrfPolicy(options: SsrfOptions = {}): SsrfPolicy {
  if (options.policy) return options.policy;
  return {
    hosts: normalizeHostList(getSsrfAllowedHosts().join(",")),
    cidrs: normalizeCidrList(getSsrfAllowedCidrs().join(",")),
  };
}

// ── Journal des autorisations (tampon circulaire, sans secret) ──

/** Une autorisation utilisée : QUI (route) a ouvert QUOI (hôte → IP). */
export interface SsrfAuditEntry {
  at: string;
  route: string;
  hostname: string;
  ip: string;
  grant: SsrfGrant;
}

const AUDIT_MAX = 100;
const auditLog: SsrfAuditEntry[] = [];

/** Ajoute une autorisation au journal (les plus récentes en premier). */
function recordGrant(entry: SsrfAuditEntry): void {
  auditLog.unshift(entry);
  if (auditLog.length > AUDIT_MAX) auditLog.length = AUDIT_MAX;
}

/** Journal des autorisations utilisées (les plus récentes en premier). */
export function getSsrfAuditLog(limit = 50): SsrfAuditEntry[] {
  return auditLog.slice(0, Math.max(0, limit));
}

/** Vide le journal (outil de test). */
export function resetSsrfAuditLogForTests(): void {
  auditLog.length = 0;
}

/**
 * Valide une URL http/https et bloque toute adresse sensible (politique
 * tout-ou-rien). Retourne l'URL normalisée.
 */
export async function validateHttpUrl(rawUrl: string, options: SsrfOptions = {}): Promise<string> {
  const target = await resolveHttpTarget(rawUrl, options);
  return target.url;
}

/**
 * Variante de `validateHttpUrl` qui retourne AUSSI le nom d'hôte et les IP
 * résolues. Utilisée par la capture d'écran pour épingler la résolution
 * (`--host-resolver-rules`), empêchant un DNS-rebinding entre validation et spawn.
 */
export async function resolveHttpTarget(
  rawUrl: string,
  options: SsrfOptions = {},
): Promise<ResolvedHttpTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http/https URLs are allowed");
  }

  // Refus des identifiants dans l'URL (http://user:pass@host/) : ils ne
  // servent JAMAIS une capture légitime et masquent l'hôte réel dans les logs.
  if (url.username !== "" || url.password !== "") {
    throw new Error("URL must not include credentials");
  }

  const hostname = stripBrackets(url.hostname);
  if (!hostname) throw new Error("URL must include a hostname");

  let ips: string[];
  const direct = isIP(hostname);
  if (direct) {
    ips = [hostname];
  } else {
    try {
      const results = await lookup(hostname, { all: true });
      ips = results.map((r) => r.address);
    } catch {
      throw new Error(`DNS resolution failed for hostname: ${hostname}`);
    }
  }
  if (ips.length === 0) throw new Error(`DNS resolution failed for hostname: ${hostname}`);

  const policy = resolveSsrfPolicy(options);
  const hostGrant = matchHostEntry(hostname, policy.hosts);

  // Politique TOUT-OU-RIEN : la moindre adresse sensible non autorisée
  // invalide la cible.
  let grant: SsrfGrant | null = null;
  for (const ip of ips) {
    // Lien-local : refus ABSOLU (métadonnées cloud 169.254.169.254 incluses),
    // même si une plage autorisée couvre 169.254.0.0/16.
    if (isLinkLocalIp(ip)) {
      throw new Error(`Blocked link-local address: ${ip}`);
    }

    if (isInternalAddress(ip)) {
      const cidrEntry = matchCidrEntry(ip, policy.cidrs);
      if (cidrEntry) {
        grant = grant ?? { kind: "cidr", entry: cidrEntry };
        continue;
      }
      if (hostGrant) {
        grant = grant ?? { kind: "host", entry: hostGrant };
        continue;
      }
      if (isLoopbackIp(ip) && options.allowLoopback) continue;
      if (isPrivateIp(ip) && options.allowPrivate) continue;
      throw new Error(
        isLoopbackIp(ip) ? `Blocked loopback address: ${ip}` : `Blocked private address: ${ip}`,
      );
    }

    // Adresse PUBLIQUE (déjà acceptée avant la liste blanche). Si le nom est
    // autorisé par nom, une réponse publique est un signe de DNS-rebinding ou
    // de détournement : on refuse (un nom interne ne résout pas en public).
    if (hostGrant) {
      throw new Error(`Blocked public address for allow-listed hostname: ${ip}`);
    }
  }

  const target: ResolvedHttpTarget = {
    url: url.toString(),
    hostname,
    ips,
    pinnedIp: direct ? null : ips[0],
    grant,
  };

  if (grant) {
    const audit: SsrfAuditEntry = {
      at: new Date().toISOString(),
      route: options.route ?? "unknown",
      hostname,
      ip: ips[0],
      grant,
    };
    recordGrant(audit);
    // Trace serveur : QUI a ouvert QUOI (nom, IP, entrée de liste blanche).
    // Jamais d'URL complète (elle peut porter des paramètres sensibles).
    console.log(`[ssrf] internal access allowed route=${audit.route} host=${hostname} ip=${audit.ip} via=${grant.kind}:${grant.entry}`);
  }

  return target;
}

/**
 * Valide une CIBLE DE REDIRECTION (en-tête `Location`, absolu ou relatif) avec
 * la MÊME politique que la cible initiale. Lève `Blocked…` si la redirection
 * sort de la liste blanche — une cible autorisée ne peut pas rebondir vers une
 * adresse qui ne l'est pas.
 */
export async function assertRedirectAllowed(
  baseUrl: string,
  location: string,
  options: SsrfOptions = {},
): Promise<string> {
  let absolute: URL;
  try {
    absolute = new URL(location, baseUrl);
  } catch {
    throw new Error("Blocked redirect with an invalid target");
  }
  if (absolute.protocol !== "http:" && absolute.protocol !== "https:") {
    throw new Error(`Blocked redirect to a non-http(s) URL: ${absolute.protocol}`);
  }
  const target = await resolveHttpTarget(absolute.toString(), options);
  return target.url;
}
