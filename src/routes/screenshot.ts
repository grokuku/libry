/**
 * Routes de capture d'écran de Libry (sous /api/librarian, clé obligatoire).
 *
 *   POST /api/librarian/screenshot   → produit un PNG, le persiste, renvoie ses métadonnées
 *   GET  /api/librarian/shot/:id.png → sert le PNG (auth requise)
 *
 * Sécurité :
 *   - SSRF OBLIGATOIRE avant tout spawn (`validateHttpUrl`/`resolveHttpTarget`) :
 *     403 avec message STABLE et NON fuyant (jamais l'IP résolue ni la cause) ;
 *   - liste blanche des adresses internes (`LIBRY_SSRF_ALLOWED_HOSTS` /
 *     `LIBRY_SSRF_ALLOWED_CIDRS`, vide par défaut) : quand elle autorise la
 *     cible, la chaîne de REDIRECTIONS est vérifiée avant le spawn (une
 *     redirection hors liste blanche reste refusée) et l'autorisation utilisée
 *     est journalisée ;
 *   - `file://`/`htmlPath` JAMAIS exposés ; le HTML inline n'est accepté que si
 *     LIBRY_SHOT_INLINE_HTML=true (désactivé par défaut) ;
 *   - la résolution DNS est épinglée (`--host-resolver-rules`) sur l'IP validée
 *     (anti DNS-rebinding) ;
 *   - concurrence bornée : 429 + Retry-After quand les slots ET la file sont pleins.
 *
 * Pi-Web conserve l'affichage : il télécharge l'image via GET /shot/:id.png et la
 * réinjecte dans ses pièces jointes (Libry ne pousse rien vers Pi-Web).
 */
import { Router, type Request, type Response } from "express";
import { randomUUID } from "crypto";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { libryAuth } from "../middleware/auth.js";
import { resolveHttpTarget, type ResolvedHttpTarget } from "../utils/ssrf.js";
import { probeRedirectChain } from "../utils/redirect-guard.js";
import { shotQueue, ShotQueueFullError } from "../shot-queue.js";
import {
  performCapture,
  buildResolverRule,
  detectChromium,
  ScreenshotError,
  ChromiumNotFoundError,
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  DEFAULT_TIMEOUT_MS,
} from "../screenshot.js";
import { saveShot, readShotPng, isValidShotId, type ShotMeta } from "../shot-store.js";
import { getChromiumNoSandbox, getShotInlineHtml, getShotTtlHours } from "../config.js";

const router = Router();

const MIN_DIM = 1;
const MAX_DIM = 10_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 60_000;

/** Entier borné, sinon la valeur par défaut (jamais d'exception). */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

// POST /api/librarian/screenshot
router.post("/screenshot", libryAuth, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const inline = body.inline === true;
  const urlRaw = typeof body.url === "string" ? body.url.trim() : "";
  const htmlRaw = typeof body.html === "string" ? body.html : "";

  // Cible : soit une URL (chemin normal), soit du HTML inline (opt-in explicite).
  // Aucun champ `fullPage` : le CLI Chromium ne capture que le viewport, la
  // hauteur effective est celle demandée (`height`).
  if (inline) {
    if (!getShotInlineHtml()) {
      return res.status(400).json({ error: "Inline HTML capture is disabled" });
    }
    if (!htmlRaw) return res.status(400).json({ error: "Missing 'html' in body" });
  } else if (!urlRaw) {
    return res.status(400).json({ error: "Missing 'url' in body" });
  }

  const width = clampInt(body.width, MIN_DIM, MAX_DIM, DEFAULT_WIDTH);
  const height = clampInt(body.height, MIN_DIM, MAX_DIM, DEFAULT_HEIGHT);
  const timeoutMs = clampInt(body.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);

  // Mode URL : cible résolue AVANT l'obtention du slot (SSRF d'abord).
  let targetUrl = "";
  let resolverRule: string | null = null;

  if (!inline) {
    // ── SSRF OBLIGATOIRE AVANT LE SPAWN ──
    let resolved: ResolvedHttpTarget;
    try {
      resolved = await resolveHttpTarget(urlRaw, { route: "screenshot" });
    } catch (e) {
      const message = e instanceof Error ? e.message : "";
      if (message.startsWith("Blocked")) {
        // Message STABLE et NON fuyant : ni l'IP résolue ni la nature du blocage.
        return res.status(403).json({ error: "URL not allowed" });
      }
      return res.status(400).json({ error: "Invalid URL" });
    }
    targetUrl = resolved.url;
    resolverRule = buildResolverRule(resolved);

    // Cible INTERNE autorisée : vérifier la chaîne de redirections AVANT le
    // spawn — une adresse non autorisée en fin de chaîne reste refusée.
    if (resolved.grant) {
      const probe = await probeRedirectChain(resolved.url, { route: "screenshot" });
      if (!probe.ok) return res.status(403).json({ error: "URL not allowed" });
    }
  }

  // ── Concurrence bornée : slot unique par capture ──
  const slotKey = `shot:${randomUUID()}`;
  try {
    await shotQueue.acquire(slotKey);
  } catch (e) {
    if (e instanceof ShotQueueFullError) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil(e.retryAfterMs / 1000))));
      return res.status(429).json({ error: "Too many concurrent screenshot requests", retryAfterMs: e.retryAfterMs });
    }
    throw e;
  }

  let tempHtmlDir: string | null = null;
  try {
    if (inline) {
      // Dossier temporaire créé APRÈS l'obtention du slot : le retour anticipé
      // 429 ci-dessus ne laisse aucun résidu dans /tmp.
      tempHtmlDir = mkdtempSync(path.join(tmpdir(), "libry-shot-html-"));
      const htmlPath = path.join(tempHtmlDir, "page.html");
      writeFileSync(htmlPath, htmlRaw, "utf-8");
      targetUrl = `file://${htmlPath}`;
    }

    if (!detectChromium()) {
      console.error("[screenshot] Chromium binary not found");
      return res.status(502).json({ error: "Chromium is not available" });
    }

    const capture = await performCapture({
      url: targetUrl,
      width,
      height,
      timeoutMs,
      resolverRule,
      noSandbox: getChromiumNoSandbox(),
    });

    const id = randomUUID();
    const createdAt = new Date();
    const meta: ShotMeta = {
      id,
      createdAt: createdAt.toISOString(),
      width: capture.width,
      height: capture.height,
      bytes: capture.bytes,
      expiresAt: new Date(createdAt.getTime() + getShotTtlHours() * 3_600_000).toISOString(),
      mimeType: "image/png",
      origin: "web",
      url: inline ? "inline" : targetUrl,
    };
    saveShot(id, capture.buffer, meta);

    return res.json({
      id,
      mimeType: "image/png",
      width: capture.width,
      height: capture.height,
      bytes: capture.bytes,
      url: meta.url,
      origin: "web",
    });
  } catch (e) {
    // Le client ne reçoit qu'un message générique (par conception) : la cause
    // détaillée (exit/signal + fin de stderr de Chromium) part dans les logs.
    if (e instanceof ChromiumNotFoundError) {
      console.error("[screenshot] Chromium binary not found");
      return res.status(502).json({ error: "Chromium is not available" });
    }
    if (e instanceof ScreenshotError && e.timedOut) {
      console.error("[screenshot] capture timed out");
      return res.status(504).json({ error: "Screenshot capture timed out" });
    }
    console.error("[screenshot] capture failed:", e instanceof Error ? e.message : e);
    return res.status(502).json({ error: "Screenshot capture failed" });
  } finally {
    shotQueue.release(slotKey);
    if (tempHtmlDir) {
      try {
        rmSync(tempHtmlDir, { recursive: true, force: true });
      } catch {
        /* déjà supprimé */
      }
    }
  }
});

// GET /api/librarian/shot/:id.png — sert le PNG (auth requise).
router.get("/shot/:id.png", libryAuth, (req: Request, res: Response) => {
  const id = String(req.params.id ?? "").replace(/\.png$/i, "");
  const png = isValidShotId(id) ? readShotPng(id) : null;
  if (!png) return res.status(404).json({ error: "Shot not found" });
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Content-Length", String(png.length));
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.send(png);
});

export default router;
