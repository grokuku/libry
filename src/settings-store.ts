/**
 * Magasin de réglages de Libry — fichier `$LIBRY_DATA_DIR/config.json`.
 *
 * Modèle de résolution appliqué à TOUS les réglages exposés :
 *
 *     env ?? fichier ?? défaut
 *
 * — l'environnement reste PRIORITAIRE (un réglage fourni par l'env n'est jamais
 *   écrasé par le fichier et n'est pas éditable depuis l'UI) ;
 * — le fichier est le repli « à chaud » : comme les getters de `config.ts`
 *   relisent l'environnement à chaque appel, une valeur écrite ici est prise en
 *   compte sans redémarrage (sauf réglages dits « redémarrage requis ») ;
 * — le défaut est le dernier recours.
 *
 * Sécurité : `config.json` peut contenir des secrets (clés WebClaw, Tavily,
 * secrets de session à venir). Il est écrit en ATOMIQUE (tmp + rename) avec les
 * permissions 0600, et son répertoire est ramené en 0700 — même pattern que
 * `src/libry-auth.ts`.
 *
 * Les valeurs sont TOUJOURS stockées sous forme de chaînes (comme l'env) : les
 * getters appelants restent responsables de l'analyse (nombre, booléen, liste).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, chmodSync, statSync } from "fs";
import path from "path";
import {
  MAX_LIST_ENTRIES,
  normalizeCidrList,
  normalizeHostEntry,
  normalizeHostList,
  parseCidrEntry,
  splitList,
} from "./utils/allowlist.js";

// ── Emplacement (résolu depuis l'environnement SEUL) ──

/**
 * Répertoire de données, lu depuis l'environnement UNIQUEMENT. `LIBRY_DATA_DIR`
 * ne peut pas être fourni par `config.json` (qui vit précisément dans ce
 * répertoire) : c'est un réglage « envOnly » + « redémarrage requis ».
 */
function envDataDir(): string {
  const raw = process.env.LIBRY_DATA_DIR;
  return path.resolve(raw !== undefined && raw.trim() !== "" ? raw.trim() : "/app/data");
}

/** Chemin absolu du fichier de réglages. */
export function settingsFilePath(): string {
  return path.join(envDataDir(), "config.json");
}

// ── Lecture (mise en cache par mtime) ──

type SettingsObject = Record<string, string>;

let cache: { mtimeMs: number; data: SettingsObject } | null = null;

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** Ne conserve que les entrées non vides sous forme de chaîne (robustesse fichier). */
function sanitizeObject(raw: unknown): SettingsObject {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: SettingsObject = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
  }
  return out;
}

/** Contenu brut du fichier (objet plat, jamais `null`). Cache invalidé au mtime. */
export function readSettingsFile(): SettingsObject {
  const file = settingsFilePath();
  try {
    if (!existsSync(file)) {
      cache = null;
      return {};
    }
    const stat = statSync(file);
    if (cache && cache.mtimeMs === stat.mtimeMs) return cache.data;
    const data = sanitizeObject(JSON.parse(readFileSync(file, "utf-8")));
    cache = { mtimeMs: stat.mtimeMs, data };
    return data;
  } catch (e) {
    console.error("[settings] Failed to load config.json:", e);
    return {};
  }
}

/** Réinitialise le cache (outil de test). */
export function resetSettingsCache(): void {
  cache = null;
}

// ── Réglages non fournissables par le fichier ──

/** Réglages dont la valeur ne peut venir QUE de l'environnement. */
const ENV_ONLY = new Set<string>(["LIBRY_DATA_DIR"]);

function envValue(name: string): string | null {
  return nonEmptyString(process.env[name]);
}

// ── Résolution `env ?? fichier ?? défaut` ──

/** Valeur effective d'un réglage (chaîne), selon `env ?? fichier ?? défaut`. */
export function resolveSetting(name: string, defaultValue: string): string {
  const env = envValue(name);
  if (env !== null) return env;
  if (!ENV_ONLY.has(name)) {
    const fileValue = nonEmptyString(readSettingsFile()[name]);
    if (fileValue !== null) return fileValue;
  }
  return defaultValue;
}

/** Origine de la valeur effective, pour l'UI : « env », « fichier » ou « défaut ». */
export function getSettingSource(name: string): "env" | "file" | "default" {
  if (envValue(name) !== null) return "env";
  if (!ENV_ONLY.has(name) && nonEmptyString(readSettingsFile()[name]) !== null) return "file";
  return "default";
}

// ── Écriture atomique (tmp + rename), permissions restrictives ──

function ensureConfigDir(): string {
  const dir = path.dirname(settingsFilePath());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  try {
    chmodSync(dir, 0o700);
  } catch {}
  return dir;
}

/**
 * Applique des mises à jour au fichier de réglages. `null` EFFACE l'entrée
 * (retour à l'env / au défaut) ; une chaîne la définit. Écriture atomique 0600.
 */
export function writeSettings(updates: Record<string, string | null>): SettingsObject {
  ensureConfigDir();
  const file = settingsFilePath();
  const next: SettingsObject = { ...readSettingsFile() };
  for (const [name, value] of Object.entries(updates)) {
    if (value === null) delete next[name];
    else next[name] = value;
  }
  const sorted: SettingsObject = {};
  for (const key of Object.keys(next).sort()) sorted[key] = next[key];
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(sorted, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
  cache = null;
  return sorted;
}

// ── Catalogue déclaratif des réglages exposés ──

export type SettingType = "string" | "number" | "boolean" | "stringList" | "cidrList" | "hostList" | "path" | "secret";

/**
 * Groupe d'affichage « adresses internes » : rendu par une SECTION DÉDIÉE de
 * l'interface (ajout/suppression d'entrées + avertissement), pas par le
 * formulaire générique.
 */
export const INTERNAL_ACCESS_GROUP = "internal-access";

export interface SettingSpec {
  name: string;
  /** Groupe d'affichage dans l'UI. */
  group: string;
  type: SettingType;
  /** Défaut présenté (chaîne, comme l'env). */
  default: string;
  /** Lu une seule fois au démarrage → une modification prend effet au redémarrage. */
  restartRequired?: boolean;
  /** Ne peut être fourni QUE par l'environnement (jamais édité via le fichier). */
  envOnly?: boolean;
  /** Borne inférieure (type « number »). */
  min?: number;
  /** Borne supérieure (type « number »). */
  max?: number;
}

/**
 * Réglages exposés par l'API d'administration. Un réglage de type « secret »
 * n'est JAMAIS renvoyé en clair (voir `routes/admin.ts`).
 */
export const SETTINGS_SPEC: readonly SettingSpec[] = [
  // ── Serveur (redémarrage requis : lus au démarrage) ──
  { name: "LIBRY_HOST", group: "server", type: "string", default: "0.0.0.0", restartRequired: true },
  { name: "LIBRY_PORT", group: "server", type: "number", default: "3007", restartRequired: true, min: 1, max: 65535 },

  // ── Données ──
  { name: "LIBRY_DATA_DIR", group: "data", type: "path", default: "/app/data", restartRequired: true, envOnly: true },
  { name: "LIBRY_DOCS_DIR", group: "data", type: "path", default: "/app/data/docs" },
  { name: "LIBRY_KEYS_FILE", group: "data", type: "path", default: "/app/data/libry-keys.json" },
  { name: "LIBRY_SHOTS_DIR", group: "data", type: "path", default: "/app/data/shots" },

  // ── Sécurité / accès ──
  { name: "LIBRY_ALLOWED_ORIGINS", group: "security", type: "stringList", default: "", restartRequired: true },
  { name: "LIBRY_RATE_LIMIT_PER_MIN", group: "security", type: "number", default: "600", restartRequired: true, min: 1, max: 1_000_000 },
  { name: "LIBRY_SESSION_TTL_HOURS", group: "security", type: "number", default: "12", min: 1, max: 87_600 },
  { name: "LIBRY_LEGACY_KEYS", group: "security", type: "secret", default: "" },
  { name: "LIBRY_ADMIN_KEYS", group: "security", type: "secret", default: "" },
  { name: "LIBRY_UPDATE_CWDS", group: "security", type: "stringList", default: "" },

  // ── Adresses internes autorisées (section dédiée de l'interface) ──
  // Vide par défaut : Libry refuse TOUTES les adresses internes (comportement
  // historique). Une entrée autorise explicitement une cible interne.
  { name: "LIBRY_SSRF_ALLOWED_HOSTS", group: INTERNAL_ACCESS_GROUP, type: "hostList", default: "" },
  { name: "LIBRY_SSRF_ALLOWED_CIDRS", group: INTERNAL_ACCESS_GROUP, type: "cidrList", default: "" },

  // ── Journalisation ──
  { name: "LIBRY_LOG_LEVEL", group: "logging", type: "string", default: "info" },

  // ── Capture d'écran ──
  { name: "LIBRY_SHOT_CONCURRENCY", group: "screenshot", type: "number", default: "2", min: 1, max: 64 },
  { name: "LIBRY_SHOT_QUEUE_MAX", group: "screenshot", type: "number", default: "4", min: 0, max: 100_000 },
  { name: "LIBRY_SHOT_TTL_HOURS", group: "screenshot", type: "number", default: "168", min: 1, max: 87_600 },
  { name: "LIBRY_SHOT_INLINE_HTML", group: "screenshot", type: "boolean", default: "false" },

  // ── Moteur web ──
  { name: "WEBCLAW_URL", group: "web", type: "string", default: "http://localhost:3001" },
  { name: "WEBCLAW_API_KEY", group: "web", type: "secret", default: "" },
  { name: "LIBRY_TAVILY_API_KEY", group: "web", type: "secret", default: "" },
  { name: "LIBRY_WEBCLAW_TIMEOUT_MS", group: "web", type: "number", default: "15000", min: 1, max: 600_000 },
  { name: "LIBRY_TAVILY_TIMEOUT_MS", group: "web", type: "number", default: "15000", min: 1, max: 600_000 },

  // ── Chromium ──
  { name: "CHROMIUM_PATH", group: "chromium", type: "string", default: "" },
  { name: "LIBRY_CHROMIUM_NO_SANDBOX", group: "chromium", type: "boolean", default: "false" },
];

const SPEC_BY_NAME = new Map<string, SettingSpec>(SETTINGS_SPEC.map((s) => [s.name, s]));

/** Spécification d'un réglage exposé, ou `null` si le nom est inconnu. */
export function getSettingSpec(name: string): SettingSpec | null {
  return SPEC_BY_NAME.get(name) ?? null;
}

/** Vrai si le réglage est de type secret (jamais renvoyé en clair). */
export function isSecretSetting(spec: SettingSpec): boolean {
  return spec.type === "secret";
}

// ── Validation d'une valeur proposée ──

export type ValidationResult = { ok: true; value: string } | { ok: false; error: string };

/** Normalise et valide une valeur selon le type déclaré du réglage. */
export function validateSettingValue(spec: SettingSpec, raw: unknown): ValidationResult {
  if (typeof raw !== "string") {
    return { ok: false, error: `${spec.name}: value must be a string (or null to clear)` };
  }
  const trimmed = raw.trim();

  switch (spec.type) {
    case "number": {
      if (!/^-?\d+$/.test(trimmed)) return { ok: false, error: `${spec.name}: expected an integer` };
      const parsed = Number.parseInt(trimmed, 10);
      if (!Number.isFinite(parsed)) return { ok: false, error: `${spec.name}: not a valid number` };
      if (spec.min !== undefined && parsed < spec.min) return { ok: false, error: `${spec.name}: must be >= ${spec.min}` };
      if (spec.max !== undefined && parsed > spec.max) return { ok: false, error: `${spec.name}: must be <= ${spec.max}` };
      return { ok: true, value: String(parsed) };
    }
    case "boolean": {
      const lower = trimmed.toLowerCase();
      if (lower !== "true" && lower !== "false") return { ok: false, error: `${spec.name}: expected true or false` };
      return { ok: true, value: lower };
    }
    case "stringList": {
      const items = trimmed
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      return { ok: true, value: items.join(",") };
    }
    case "hostList": {
      // Chaque entrée doit être un nom d'hôte exploitable ; la normalisation
      // tolère une URL collée, un port, un point final ou un joker `*.domaine`.
      const items = splitList(trimmed);
      if (items.length > MAX_LIST_ENTRIES) {
        return { ok: false, error: `${spec.name}: too many entries (max ${MAX_LIST_ENTRIES})` };
      }
      const invalid = items.filter((item) => normalizeHostEntry(item) === null);
      if (invalid.length > 0) {
        return { ok: false, error: `${spec.name}: invalid hostname(s) — ${invalid.join(", ")}` };
      }
      return { ok: true, value: normalizeHostList(trimmed).join(",") };
    }
    case "cidrList": {
      const items = splitList(trimmed);
      if (items.length > MAX_LIST_ENTRIES) {
        return { ok: false, error: `${spec.name}: too many entries (max ${MAX_LIST_ENTRIES})` };
      }
      const invalid = items.filter((item) => parseCidrEntry(item) === null);
      if (invalid.length > 0) {
        return { ok: false, error: `${spec.name}: invalid CIDR or IP — ${invalid.join(", ")}` };
      }
      return { ok: true, value: normalizeCidrList(trimmed).join(",") };
    }
    case "secret":
    case "path":
    case "string":
    default:
      return { ok: true, value: trimmed };
  }
}
