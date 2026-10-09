/**
 * Stockage des captures d'écran de Libry.
 *
 * Chaque capture produit deux fichiers dans LIBRY_SHOTS_DIR :
 *   - `<uuid>.png`  : l'image ;
 *   - `<uuid>.json` : les métadonnées (createdAt, width, height, bytes, expiresAt…).
 *
 * TTL : LIBRY_SHOT_TTL_HOURS (défaut 168 h = 7 jours). La purge est PUREMENT
 * locale (aucun LLM, aucun réseau) : à l'écriture, et périodiquement via
 * `startShotPurgeTimer()` (appelée par le point d'entrée en exécution directe).
 * Aucun accès en dehors de LIBRY_SHOTS_DIR : l'id est validé (UUID) avant tout
 * chemin, ce qui neutralise toute tentative de traversal via l'URL.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, renameSync, statSync } from "fs";
import path from "path";
import { getShotsDir, getShotTtlHours } from "./config.js";

export interface ShotMeta {
  id: string;
  createdAt: string;
  width: number;
  height: number;
  bytes: number;
  expiresAt: string;
  mimeType: "image/png";
  origin: "web";
  url: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Vrai si l'identifiant est un UUID v4 canonique (garde anti-traversal). */
export function isValidShotId(id: string): boolean {
  return UUID_RE.test(id);
}

export function ensureShotsDir(): string {
  const dir = getShotsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function pathsFor(id: string): { png: string; meta: string } {
  const dir = getShotsDir();
  return { png: path.join(dir, `${id}.png`), meta: path.join(dir, `${id}.json`) };
}

/** Écrit le PNG et ses métadonnées (atomique pour le JSON). Purge opportuniste. */
export function saveShot(id: string, png: Buffer, meta: ShotMeta): void {
  if (!isValidShotId(id)) throw new Error("Invalid shot id");
  ensureShotsDir();
  const { png: pngPath, meta: metaPath } = pathsFor(id);
  writeFileSync(pngPath, png, { mode: 0o600 });
  const tmp = `${metaPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(meta, null, 2), { mode: 0o600 });
  renameSync(tmp, metaPath);
  // Purge opportuniste : coût O(n) faible, aucune dépendance externe.
  purgeExpiredShots();
}

export function readShotMeta(id: string): ShotMeta | null {
  if (!isValidShotId(id)) return null;
  const { meta: metaPath } = pathsFor(id);
  if (!existsSync(metaPath)) return null;
  try {
    return JSON.parse(readFileSync(metaPath, "utf-8")) as ShotMeta;
  } catch {
    return null;
  }
}

/** Retourne le PNG si présent et NON expiré, sinon null (purge si expiré). */
export function readShotPng(id: string): Buffer | null {
  if (!isValidShotId(id)) return null;
  const meta = readShotMeta(id);
  if (!meta) return null;
  const expiresAt = Date.parse(meta.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    deleteShot(id);
    return null;
  }
  const { png: pngPath } = pathsFor(id);
  if (!existsSync(pngPath)) return null;
  try {
    return readFileSync(pngPath);
  } catch {
    return null;
  }
}

/** Supprime une capture (PNG + méta). Idempotent. */
export function deleteShot(id: string): void {
  if (!isValidShotId(id)) return;
  const { png, meta } = pathsFor(id);
  for (const file of [png, meta]) {
    try {
      rmSync(file, { force: true });
    } catch {
      /* déjà absent */
    }
  }
}

/** Supprime les captures expirées ET les JSON orphelins. Retourne le nombre purgé. */
export function purgeExpiredShots(now: number = Date.now()): number {
  const dir = getShotsDir();
  if (!existsSync(dir)) return 0;
  let purged = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json") || entry.endsWith(".json.tmp")) continue;
    const id = entry.slice(0, -5);
    if (!isValidShotId(id)) continue;
    const meta = readShotMeta(id);
    const expiresAt = meta ? Date.parse(meta.expiresAt) : NaN;
    const expired = !meta || !Number.isFinite(expiresAt) || expiresAt <= now;
    if (expired) {
      deleteShot(id);
      purged++;
    }
  }
  // PNG orphelins (sans méta) : supprimés au-delà du TTL (mtime).
  const ttlMs = getShotTtlHours() * 3_600_000;
  for (const entry of entries) {
    if (!entry.endsWith(".png")) continue;
    const id = entry.slice(0, -4);
    if (!isValidShotId(id)) continue;
    const { meta } = pathsFor(id);
    if (existsSync(meta)) continue;
    const pngPath = path.join(dir, entry);
    try {
      const mtime = statSync(pngPath).mtimeMs;
      if (now - mtime > ttlMs) {
        rmSync(pngPath, { force: true });
        purged++;
      }
    } catch {
      /* ignore */
    }
  }
  return purged;
}

/**
 * Démarre la purge périodique (défaut : toutes les heures). Le timer est
 * `unref()` pour ne jamais retenir le process. Retourne une fonction d'arrêt.
 */
export function startShotPurgeTimer(intervalMs: number = 3_600_000): () => void {
  const timer = setInterval(() => {
    try {
      purgeExpiredShots();
    } catch {
      /* la purge ne doit jamais faire tomber le process */
    }
  }, intervalMs);
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}
