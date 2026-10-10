/**
 * Point d'entrée du service Libry.
 *
 * Express : CORS (selon LIBRY_ALLOWED_ORIGINS), limitation de débit, route de
 * santé `/health` (alignée sur WebClaw) et montage du contrat historique
 * `/api/librarian/*`. `createApp()` est exporté pour les tests ; le serveur
 * n'écoute que si le fichier est exécuté directement.
 */
import express, { type Request, type Response, type NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { readFileSync } from "fs";
import { fileURLToPath, pathToFileURL } from "url";
import { getHost, getPort, getAllowedOrigins, getRateLimitPerMin } from "./config.js";
import librarianRouter from "./routes/librarian.js";
import screenshotRouter from "./routes/screenshot.js";
import webRouter from "./routes/web.js";
import adminRouter from "./routes/admin.js";
import { registerWebSearchProvider } from "./web-search.js";
import { startShotPurgeTimer } from "./shot-store.js";

/** Version du package, lue à côté du point d'entrée (src/ comme dist/). */
export const version: string = (() => {
  try {
    const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

export function createApp(): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "5mb" }));

  // ── Moteur de recherche web (cascade WebClaw → Tavily → DuckDuckGo) ──
  // Branché sur library-store via son point d'injection : POST /search interroge
  // la bibliothèque locale d'abord, puis la cascade web sur un miss local.
  registerWebSearchProvider();

  // ── CORS (sans dépendance : uniquement les origines déclarées) ──
  const allowedOrigins = getAllowedOrigins();
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (typeof origin === "string" && allowedOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-API-Key, X-CSRF-Token");
      res.setHeader("Access-Control-Max-Age", "600");
    }
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // ── Limitation de débit ──
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: getRateLimitPerMin(),
      standardHeaders: "draft-7",
      legacyHeaders: false,
    }),
  );

  // ── Santé (liveness, aligné WebClaw) ──
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ service: "libry", status: "ok", version });
  });

  // ── Contrat historique (Yuki le code en dur) ──
  app.use("/api/librarian", librarianRouter);

  // ── Capture d'écran (même préfixe, clé requise, chemins distincts) ──
  app.use("/api/librarian", screenshotRouter);

  // ── Moteur web (même préfixe, clé requise, chemins distincts) ──
  app.use("/api/librarian", webRouter);

  // ── Administration (préfixe NEUF, hors contrat /api/librarian) ──
  // Lot 4 : authentification admin (login/session) + garde-fou mot de passe par
  // défaut, branchés sur GET/PUT /settings (Lot 3) sans changer le préfixe.
  app.use("/api/admin", adminRouter);

  // ── Interface web statique (documentation, réglages) ──
  // Montée après le rate-limit ET après /health et /api/* : l'API garde la
  // priorité, jamais capturée. `public/` est embarqué par le Dockerfile
  // (COPY public) ; résolu depuis src/ comme depuis dist/.
  // Sans fallback SPA : une route inconnue retombe sur le 404 d'Express.
  const publicDir = fileURLToPath(new URL("../public", import.meta.url));
  app.use(express.static(publicDir));

  return app;
}

export const app = createApp();

// N'écoute que si exécuté directement (`node dist/index.js`), pas à l'import.
const isDirectRun = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isDirectRun) {
  const port = getPort();
  const host = getHost();
  // Purge périodique des captures expirées (TTL LIBRY_SHOT_TTL_HOURS), sans LLM.
  startShotPurgeTimer();
  app.listen(port, host, () => {
    console.log(`[libry] listening on http://${host}:${port} (version ${version})`);
  });
}
