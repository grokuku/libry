/**
 * Liste blanche « adresses internes » — normalisation et VALIDATION SYNTAXIQUE
 * des entrées saisies par l'administrateur (interface web → `config.json`).
 *
 * Deux familles d'entrées, stockées dans deux réglages distincts :
 *   - `LIBRY_SSRF_ALLOWED_HOSTS` : NOMS D'HÔTES (`switchy`, `pi-web`, `nas.lan`,
 *     `*.holaf.lan`) — un nom autorisé ne peut résoudre QUE vers le réseau
 *     interne (voir `ssrf.ts`, garde anti DNS-rebinding) ;
 *   - `LIBRY_SSRF_ALLOWED_CIDRS` : PLAGES d'adresses (`10.10.0.0/16`,
 *     `192.168.1.0/24`, `192.168.1.10/32`, `fd00::/8`).
 *
 * Ce module ne fait AUCUNE arithmétique d'adresses (elle vit dans `ssrf.ts`) :
 * il se limite à reconnaître une syntaxe valide et à normaliser la saisie, pour
 * que la validation de l'API et l'affichage de l'interface soient identiques.
 * Il n'importe que `net` (aucun cycle avec `settings-store` ni `config`).
 */
import { isIP } from "net";

/** Longueur maximale d'une entrée acceptée (garde-fou anti-abus). */
export const MAX_ENTRY_LENGTH = 253;

/** Nombre maximal d'entrées par liste (garde-fou anti-abus). */
export const MAX_LIST_ENTRIES = 200;

/**
 * Normalise un nom d'hôte saisi : tolère une URL complète collée par erreur
 * (`http://switchy:3007/chemin` → `switchy`), retire le port, les crochets
 * IPv6, le point final, et met en minuscules. Retourne `null` si le résultat
 * n'est pas un nom d'hôte exploitable.
 */
export function normalizeHostEntry(raw: string): string | null {
  if (typeof raw !== "string") return null;
  let value = raw.trim().toLowerCase();
  if (value === "" || value.length > MAX_ENTRY_LENGTH) return null;

  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // schéma
  value = value.split(/[/?#]/)[0]; // chemin / requête / ancre
  value = value.replace(/^[^@]*@/, ""); // identifiants (user:pass@)

  // [::1]:8080 → ::1 ; [::1] → ::1
  const bracketed = value.match(/^\[([^\]]+)\](?::\d{1,5})?$/);
  if (bracketed) value = bracketed[1];
  else if (value.split(":").length === 2) value = value.split(":")[0]; // hôte:port

  value = value.replace(/\.$/, ""); // point final (FQDN absolu)
  if (value === "") return null;

  // Un littéral IP n'a pas sa place dans la liste des NOMS (il irait dans les
  // plages) : on le refuse explicitement pour éviter les doublons ambigus.
  if (isIP(value) !== 0) return null;

  // Étiquette finale du nom : lettres/chiffres/tirets/soulignés, au moins une
  // lettre (un nom de service Docker comme `pi-web` reste valide).
  const labels = value.replace(/^\*\./, "").split(".");
  const validLabel = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;
  if (!labels.every((label) => validLabel.test(label))) return null;
  if (/^\*\./.test(value) && labels.length < 2) return null; // `*.lan` ok, `*.` non
  return value;
}

/** Vrai si l'entrée est une plage CIDR (ou une IP seule = /32, /128) valide. */
export function parseCidrEntry(raw: string): { address: string; bits: number } | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value === "" || value.length > MAX_ENTRY_LENGTH) return null;

  const slash = value.indexOf("/");
  const address = slash === -1 ? value : value.slice(0, slash);
  const family = isIP(address);
  if (family !== 4 && family !== 6) return null;

  const maxBits = family === 4 ? 32 : 128;
  if (slash === -1) return { address, bits: maxBits };

  const prefixRaw = value.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefixRaw)) return null;
  const bits = Number.parseInt(prefixRaw, 10);
  if (bits > maxBits) return null;
  return { address, bits };
}

/** Vrai si l'entrée CIDR est valide. */
export function isValidCidrEntry(raw: string): boolean {
  return parseCidrEntry(raw) !== null;
}

/** Découpe une valeur de réglage (`a,b , c`) en entrées non vides. */
export function splitList(value: string): string[] {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Normalise une liste de noms : dédoublonnage (ordre conservé), plafonnée. */
export function normalizeHostList(value: string): string[] {
  const out: string[] = [];
  for (const item of splitList(value)) {
    const host = normalizeHostEntry(item);
    if (host && !out.includes(host)) out.push(host);
    if (out.length >= MAX_LIST_ENTRIES) break;
  }
  return out;
}

/** Normalise une liste de plages : dédoublonnage (ordre conservé), plafonnée. */
export function normalizeCidrList(value: string): string[] {
  const out: string[] = [];
  for (const item of splitList(value)) {
    const cidr = parseCidrEntry(item);
    if (!cidr) continue;
    const text = cidr.bits === (isIP(cidr.address) === 4 ? 32 : 128) ? cidr.address : `${cidr.address}/${cidr.bits}`;
    if (!out.includes(text)) out.push(text);
    if (out.length >= MAX_LIST_ENTRIES) break;
  }
  return out;
}
