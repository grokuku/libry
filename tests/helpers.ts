import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Express } from "express";
import { createApp } from "../src/index.js";
import { resetAuthCaches } from "../src/libry-auth.js";

export interface TestEnv {
  app: Express;
  dir: string;
  docsDir: string;
  keysFile: string;
  cleanup: () => void;
}

/**
 * Prépare un environnement de test isolé : répertoire de données temporaire,
 * variables LIBRY_* nettoyées, caches d'auth réinitialisés. Retourne l'app
 * Express prête pour supertest.
 */
export function makeTestEnv(overrides: Record<string, string> = {}): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), "libry-test-"));
  const docsDir = join(dir, "docs");
  const keysFile = join(dir, "libry-keys.json");

  process.env.LIBRY_DATA_DIR = dir;
  process.env.LIBRY_DOCS_DIR = docsDir;
  process.env.LIBRY_KEYS_FILE = keysFile;
  delete process.env.LIBRY_LEGACY_KEYS;
  delete process.env.LIBRY_ADMIN_KEYS;
  delete process.env.LIBRY_UPDATE_CWDS;
  delete process.env.LIBRY_ALLOWED_ORIGINS;
  delete process.env.LIBRY_SHOTS_DIR;
  delete process.env.LIBRY_SHOT_CONCURRENCY;
  delete process.env.LIBRY_SHOT_QUEUE_MAX;
  delete process.env.LIBRY_SHOT_TTL_HOURS;
  delete process.env.LIBRY_SHOT_INLINE_HTML;
  delete process.env.LIBRY_CHROMIUM_NO_SANDBOX;
  delete process.env.CHROMIUM_PATH;
  for (const [k, v] of Object.entries(overrides)) process.env[k] = v;

  resetAuthCaches();

  return {
    app: createApp(),
    dir,
    docsDir,
    keysFile,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
