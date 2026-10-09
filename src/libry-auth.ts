/**
 * Authentification de Libry — port de Pi-Web (backend/src/pi/librarian-auth.ts).
 *
 * Différences voulues par rapport à Pi-Web :
 *   - Nouvelles clés préfixées « libry_ » + 32 hex ; identifiant NON secret
 *     préfixé « libryk_ ».
 *   - Les clés historiques « lib-… » (et identifiants « libk_… ») RESTENT
 *     valides : soit présentes telles quelles dans le fichier de clés (champ
 *     hérité `key` en clair, re-haché à la première validation), soit déclarées
 *     par LIBRY_LEGACY_KEYS (clé de Yuki lors de la migration).
 *   - Plus de dépendance à l'UI Pi-Web (`isBrowserRequest`) : la gestion des
 *     clés est réservée à la boucle locale OU à une clé marquée administrateur
 *     (LIBRY_ADMIN_KEYS ou champ `admin` du fichier).
 *
 * Le fichier de clés et son répertoire sont créés avec des permissions
 * restrictives (respectivement 0600 et 0700).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, chmodSync, statSync } from "fs";
import path from "path";
import crypto from "crypto";
import { type Request } from "express";
import { hashSecret, verifySecretHash, safeEqualSecret } from "./utils/secret-hash.js";
import { getKeysFile, getLegacyKeys, getAdminKeys } from "./config.js";

// ── Types ──

export interface LibryKey {
  /** Identifiant NON secret et stable (exposé par l'API, utilisé pour la suppression). */
  id: string;
  name: string;
  createdAt: string;
  /** Aperçu non secret du secret (préfixe + « … »), figé à la création / migration. */
  keyPreview: string;
  /** Hash scrypt du secret — format de stockage courant. */
  keyHash?: string;
  /** Secret en clair — héritage uniquement ; re-haché puis retiré à la 1re validation. */
  key?: string;
  /** Clé marquée administrateur (accès à /keys sans boucle locale). */
  admin?: boolean;
}

/** Identité résolue d'un secret présenté (sans exposer le secret lui-même). */
export interface ResolvedIdentity {
  id: string;
  name: string;
  admin: boolean;
}

// ── Persistence ──

/** Répertoire du fichier de clés (créé si absent, permissions 0700). */
function ensureKeysDir(): string {
  const dir = path.dirname(getKeysFile());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  try {
    chmodSync(dir, 0o700);
  } catch {}
  return dir;
}

export function loadKeys(): LibryKey[] {
  try {
    ensureKeysDir();
    const keysFile = getKeysFile();
    if (existsSync(keysFile)) {
      // Invalide le cache mémo si le fichier a changé hors du process (édit externe).
      const stat = statSync(keysFile);
      if (stat.mtimeMs !== keysFileMtimeMs) {
        validationCache.clear();
        keysFileMtimeMs = stat.mtimeMs;
      }
      const raw = JSON.parse(readFileSync(keysFile, "utf-8")) as LibryKey[];
      return Array.isArray(raw) ? raw.map(normalizeKey) : [];
    }
  } catch (e) {
    console.error("[libry-auth] Failed to load keys:", e);
  }
  return [];
}

/**
 * Écriture atomique (tmp + rename) et permissions restrictives (0600).
 * Les secrets hérités encore en clair (champ `key`) restent tels quels jusqu'à
 * leur première validation réussie, puis sont remplacés par keyHash.
 */
export function saveKeys(keys: LibryKey[]): void {
  ensureKeysDir();
  const keysFile = getKeysFile();
  const tmpFile = `${keysFile}.tmp`;
  writeFileSync(tmpFile, JSON.stringify(keys, null, 2), { mode: 0o600 });
  renameSync(tmpFile, keysFile);
}

/** Nouvelle clé API : « libry_ » + 32 caractères hexadécimaux. */
function generateKeyString(): string {
  return "libry_" + crypto.randomBytes(16).toString("hex");
}

/** Préfixe d'identifiant NON secret des nouvelles clés Libry. */
const ID_PREFIX = "libryk_";

/** Masque un secret pour l'affichage (préserve le préfixe lisible). */
export function maskSecret(secret: string): string {
  return secret.slice(0, 12) + "…";
}

/**
 * Identifiant NON secret dérivé du secret (SHA-256 tronqué : préimage-résistant).
 * Utilisé pour les clés héritées sans `id` afin que listage et suppression
 * restent stables sans réécriture.
 */
export function deriveIdFromSecret(secret: string): string {
  return ID_PREFIX + crypto.createHash("sha256").update(secret).digest("hex").slice(0, 12);
}

/**
 * Identifiant stable d'une clé : explicite si présent, sinon dérivé du secret
 * hérité, du hash, sinon aléatoire (cas dégénéré jamais persisté).
 */
export function keyIdOf(k: LibryKey): string {
  if (k.id) return k.id;
  if (k.key) return deriveIdFromSecret(k.key);
  if (k.keyHash) return ID_PREFIX + crypto.createHash("sha256").update(k.keyHash).digest("hex").slice(0, 12);
  return ID_PREFIX + crypto.randomBytes(6).toString("hex");
}

/** Garantit un `id` sur une clé chargée depuis le disque (héritage sans id). */
function normalizeKey(k: LibryKey): LibryKey {
  if (!k.id) k.id = keyIdOf(k);
  return k;
}

/** Crée et persiste une nouvelle clé. Retourne le secret complet (affiché une fois). */
export function createKey(name: string, opts: { admin?: boolean } = {}): LibryKey & { key: string } {
  const keys = loadKeys();
  const secret = generateKeyString();
  const record: LibryKey = {
    id: ID_PREFIX + crypto.randomBytes(6).toString("hex"),
    keyHash: hashSecret(secret), // le secret en clair n'est JAMAIS persisté
    keyPreview: maskSecret(secret),
    name: name.trim(),
    createdAt: new Date().toISOString(),
    ...(opts.admin ? { admin: true } : {}),
  };
  keys.push(record);
  saveKeys(keys);
  return { ...record, key: secret };
}

// ── Validation (hash courant + héritage en clair + clés d'environnement) ──

/** Cache mémo (mémoire vive uniquement) : secret présenté → identité validée. */
const validationCache = new Map<string, ResolvedIdentity>();
const VALIDATION_CACHE_MAX = 500;
let keysFileMtimeMs = -1;

/** Retrouve la clé correspondant à un secret présenté (hash scrypt ou héritage en clair). */
function matchKey(secret: string, keys: LibryKey[]): LibryKey | null {
  for (const k of keys) {
    if (k.keyHash && verifySecretHash(secret, k.keyHash)) return k;
    if (k.key && safeEqualSecret(secret, k.key)) return k; // héritage en clair, comparaison à temps constant
  }
  return null;
}

/** Vrai si le secret figure dans une liste d'environnement (comparaison à temps constant). */
function matchesEnvList(secret: string, list: string[]): boolean {
  let match = false;
  for (const candidate of list) {
    if (safeEqualSecret(secret, candidate)) match = true; // pas de court-circuit
  }
  return match;
}

/**
 * Migration transparente d'une clé héritée en clair vers le format hashé.
 * L'identifiant (dérivé du secret avant destruction) est persisté pour rester stable.
 */
function migrateToHash(found: LibryKey): void {
  if (found.keyHash || !found.key) return;
  const updated: LibryKey = {
    id: found.id,
    name: found.name,
    createdAt: found.createdAt,
    keyPreview: found.keyPreview || maskSecret(found.key),
    keyHash: hashSecret(found.key),
    ...(found.admin ? { admin: true } : {}),
  };
  const keys = loadKeys();
  const idx = keys.findIndex((k) => k.id === found.id);
  if (idx < 0) return;
  keys[idx] = updated;
  saveKeys(keys);
  console.log(`[libry-auth] Legacy key "${found.name}" migrated to hashed storage (plaintext removed).`);
}

/** Résout un secret présenté en identité (fichier de clés + clés d'environnement). */
export function resolveIdentity(secret: string): ResolvedIdentity | null {
  const keys = loadKeys();
  const found = matchKey(secret, keys);
  if (found) {
    migrateToHash(found); // héritage en clair → hash (écriture unique, à la 1re utilisation)
    return {
      id: keyIdOf(found),
      name: found.name,
      admin: Boolean(found.admin) || matchesEnvList(secret, getAdminKeys()),
    };
  }
  // Clés historiques déclarées hors fichier (ex. clé de Yuki lors de la migration).
  if (matchesEnvList(secret, getLegacyKeys())) {
    return {
      id: deriveIdFromSecret(secret),
      name: "legacy",
      admin: matchesEnvList(secret, getAdminKeys()),
    };
  }
  return null;
}

/** Valide une clé API présentée (true si connue et active). */
export function validateKey(key: string): boolean {
  // Cache mémo : le scrypt (~100 ms) n'est payé qu'une fois par secret et par process.
  const cached = validationCache.get(key);
  if (cached) {
    const keys = loadKeys();
    if (keys.some((k) => keyIdOf(k) === cached.id)) return true;
    // Clé révoquée entre-temps, ou clé d'environnement (absente du fichier).
    if (matchesEnvList(key, getLegacyKeys())) return true;
    validationCache.delete(key);
  }
  const identity = resolveIdentity(key);
  if (!identity) return false;
  if (validationCache.size >= VALIDATION_CACHE_MAX) validationCache.clear();
  validationCache.set(key, identity);
  return true;
}

/** Indique si une clé présentée est marquée administrateur. */
export function isAdminKey(key: string): boolean {
  if (matchesEnvList(key, getAdminKeys())) return true;
  const keys = loadKeys();
  const found = matchKey(key, keys);
  return Boolean(found?.admin);
}

/**
 * Retrouve le NOM d'une clé API à partir de sa valeur (null si inconnue).
 * Permet de tagger l'origine d'une écriture externe (« external:<keyName> »).
 */
export function findKeyName(key: string): string | null {
  const keys = loadKeys();
  const found = matchKey(key, keys);
  if (found) return found.name;
  if (matchesEnvList(key, getLegacyKeys())) return "legacy";
  return null;
}

/** Réinitialise le cache de validation (outil de test). */
export function resetAuthCaches(): void {
  validationCache.clear();
  keysFileMtimeMs = -1;
}

/** Révoque (supprime) une clé par son identifiant NON secret. */
export function revokeKey(id: string): boolean {
  const keys = loadKeys();
  const filtered = keys.filter((k) => keyIdOf(k) !== id);
  if (filtered.length === keys.length) return false;
  saveKeys(filtered);
  return true;
}

// ── Extraction de clé présentée ──

/**
 * Extrait la clé d'une requête : en-tête `Authorization: Bearer <clé>` OU
 * `X-API-Key: <clé>`. Retourne null si aucune clé exploitable n'est présente.
 */
export function extractApiKey(req: Request): string | null {
  const authorization = req.headers["authorization"];
  if (typeof authorization === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match && match[1].trim()) return match[1].trim();
  }
  const apiKey = req.headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey.trim()) return apiKey.trim();
  return null;
}

