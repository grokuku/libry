/**
 * Capture d'écran Chromium headless — mécanique PORTÉE depuis
 * Pi-Web/extensions/web-screenshot/index.ts, avec les ajouts requis par Libry.
 *
 * Le binaire Chromium est lancé DIRECTEMENT via child_process.spawn (aucun
 * Puppeteer/Playwright) : moins de dépendances, image plus légère, contrôle
 * total des arguments. Détection : CHROMIUM_PATH puis `which` sur les candidats.
 * Essai `--headless=new` d'abord, repli `--headless` (ancien mode).
 *
 * Ajouts par rapport à Pi-Web :
 *  - `--disable-dev-shm-usage` (contraintes /dev/shm en conteneur) ;
 *  - `--user-data-dir` UNIQUE par capture (isolation, pas de verrou partagé) ;
 *  - `--no-first-run`, `--disable-extensions` ;
 *  - `--host-resolver-rules` pour ÉPINGLER la résolution DNS (anti DNS-rebinding),
 *    calculé depuis le résultat de la validation SSRF OBLIGATOIRE avant spawn ;
 *  - `--no-sandbox` UNIQUEMENT si `LIBRY_CHROMIUM_NO_SANDBOX=true` (repli).
 *
 * Le timeout tue le process avec SIGKILL pour ne jamais laisser d'orphelin.
 */
import { execFileSync, spawn } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { getChromiumPath, getChromiumNoSandbox } from "./config.js";
import type { ResolvedHttpTarget } from "./utils/ssrf.js";

export const DEFAULT_WIDTH = 1440;
export const DEFAULT_HEIGHT = 900;
export const DEFAULT_TIMEOUT_MS = 15_000;
export const VIRTUAL_TIME_BUDGET_MS = 5_000;

const CHROMIUM_CANDIDATES = [
  "chromium",
  "chromium-browser",
  "google-chrome",
  "google-chrome-stable",
];

/** Chromium introuvable (binaire absent de l'image) — erreur d'infrastructure. */
export class ChromiumNotFoundError extends Error {
  constructor() {
    super("Chromium binary not found");
    this.name = "ChromiumNotFoundError";
  }
}

/** Échec de capture ; `timedOut` distingue le dépassement (HTTP 504) du reste (502). */
export class ScreenshotError extends Error {
  readonly timedOut: boolean;

  constructor(message: string, timedOut: boolean) {
    super(message);
    this.name = "ScreenshotError";
    this.timedOut = timedOut;
  }
}

/**
 * Retourne le chemin du binaire Chromium, ou null si introuvable.
 * Priorité : env CHROMIUM_PATH, puis `which` sur les candidats usuels.
 */
export function detectChromium(): string | null {
  const fromEnv = getChromiumPath();
  if (fromEnv) return fromEnv;
  for (const candidate of CHROMIUM_CANDIDATES) {
    try {
      const out = execFileSync("which", [candidate], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (out) return out;
    } catch {
      // candidat absent — on continue
    }
  }
  return null;
}

export interface RunResult {
  code: number | null;
  signal: string | null;
  timedOut: boolean;
}

/**
 * Lance une commande avec un timeout. Au dépassement, le process est tué
 * (SIGKILL) pour ne jamais laisser un Chromium orphelin.
 */
export function runWithTimeout(cmd: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "ignore" });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* déjà terminé */
      }
    }, timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: -1, signal: null, timedOut });
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut });
    });
  });
}

/**
 * Construit la règle `--host-resolver-rules` épinglant le nom d'hôte vers
 * l'adresse RÉELLEMENT validée par la couche SSRF. Retourne null si l'hôte est
 * déjà une IP littérale (aucune résolution à épingler).
 */
export function buildResolverRule(target: ResolvedHttpTarget): string | null {
  if (!target.pinnedIp) return null;
  const ip = target.pinnedIp.includes(":") ? `[${target.pinnedIp}]` : target.pinnedIp;
  return `MAP ${target.hostname} ${ip}`;
}

export interface CaptureOptions {
  /** Cible déjà validée/normalisée par la couche SSRF (http/https). */
  url: string;
  width?: number;
  height?: number;
  timeoutMs?: number;
  /** Règle `--host-resolver-rules` (sans le préfixe), ou null. */
  resolverRule?: string | null;
  /** Repli sandbox (par défaut : config LIBRY_CHROMIUM_NO_SANDBOX). */
  noSandbox?: boolean;
}

export interface CaptureResult {
  buffer: Buffer;
  width: number;
  height: number;
  bytes: number;
}

/**
 * Capture un screenshot Chromium headless. Lève `ScreenshotError` si le PNG
 * n'a pas été produit (avec `timedOut` positionné au bon sens).
 */
export async function captureScreenshot(opts: CaptureOptions): Promise<CaptureResult> {
  const bin = detectChromium();
  if (!bin) throw new ChromiumNotFoundError();

  const width = opts.width && opts.width > 0 ? Math.floor(opts.width) : DEFAULT_WIDTH;
  const height = opts.height && opts.height > 0 ? Math.floor(opts.height) : DEFAULT_HEIGHT;
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? Math.floor(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const noSandbox = opts.noSandbox ?? getChromiumNoSandbox();

  const profileDir = mkdtempSync(path.join(tmpdir(), "libry-chromium-"));
  const outPath = path.join(profileDir, "screenshot.png");

  const baseArgs = [
    "--disable-gpu",
    "--hide-scrollbars",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--disable-extensions",
    `--user-data-dir=${profileDir}`,
    `--window-size=${width},${height}`,
    `--screenshot=${outPath}`,
    `--virtual-time-budget=${VIRTUAL_TIME_BUDGET_MS}`,
  ];
  if (noSandbox) baseArgs.push("--no-sandbox");
  if (opts.resolverRule) baseArgs.push(`--host-resolver-rules=${opts.resolverRule}`);

  try {
    // Essai 1 : mode headless=new (recommandé).
    const r1 = await runWithTimeout(bin, ["--headless=new", ...baseArgs, opts.url], timeoutMs);
    if (r1.timedOut) throw new ScreenshotError("Screenshot timed out", true);
    if (!(r1.code === 0 && existsSync(outPath))) {
      // Essai 2 : mode headless (ancien) — repli si le nouveau mode échoue.
      const r2 = await runWithTimeout(bin, ["--headless", ...baseArgs, opts.url], timeoutMs);
      if (r2.timedOut) throw new ScreenshotError("Screenshot timed out", true);
      if (!(r2.code === 0 && existsSync(outPath))) {
        throw new ScreenshotError(`Screenshot failed (exit=${r2.code}, signal=${r2.signal})`, false);
      }
    }

    const buffer = readFileSync(outPath);
    if (buffer.length === 0) throw new ScreenshotError("Screenshot produced an empty file", false);
    return { buffer, width, height, bytes: buffer.length };
  } finally {
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch {
      /* déjà supprimé */
    }
  }
}

// ── Indirection pour les tests ──
type CaptureImpl = (opts: CaptureOptions) => Promise<CaptureResult>;
let captureImpl: CaptureImpl = captureScreenshot;

/** Injection d'une implémentation de capture (tests). `null` restaure la vraie. */
export function setCaptureImplForTests(impl: CaptureImpl | null): void {
  captureImpl = impl ?? captureScreenshot;
}

/** Capture effective (déléguée, injectable en test). */
export function performCapture(opts: CaptureOptions): Promise<CaptureResult> {
  return captureImpl(opts);
}
