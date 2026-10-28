/**
 * Routes d'administration de Libry — préfixe `/api/admin/*` (Lot 3 + Lot 4).
 *
 * Authentification / session :
 *   POST /login    → vérifie le mot de passe admin, émet la session (cookie
 *                    `libry_session` HttpOnly/SameSite=Strict) et le jeton CSRF.
 *                    Rate-limit DÉDIÉ anti-brute-force (5/min/IP). CSRF requis.
 *   POST /logout   → vide le cookie de session.
 *   GET  /session  → `{authenticated, csrfToken}` ; `passwordIsDefault` n'est
 *                    révélé QUE dans une session valide (jamais à un anonyme).
 *   POST /password → change le mot de passe admin (vérifie `current`) et
 *                    incrémente l'époque → invalide TOUTES les sessions.
 *
 * Réglages (Lot 3, gardés par `requireAdmin`) :
 *   GET  /settings → réglages groupés (valeur effective OU secret masqué).
 *   PUT  /settings → écrit `$LIBRY_DATA_DIR/config.json` (validation, verrous env).
 *                    CSRF (si session) + garde-fou mot de passe par défaut.
 *   GET  /ssrf-log → journal des AUTORISATIONS d'adresses internes utilisées
 *                    (nom, IP, entrée de liste blanche, route) — sans secret.
 *
 * Aucun secret n'est JAMAIS renvoyé en clair : seuls `{configured, preview:"••••"}`.
 */
import { Router, type Request, type Response } from "express";
import rateLimit, { MemoryStore } from "express-rate-limit";
import { requireAdmin, requireCsrf, requireCsrfForSession, rejectDefaultPassword } from "../middleware/admin-session.js";
import {
  issueSession,
  verifyAdminPassword,
  setAdminPassword,
  getSessionFromRequest,
  isPasswordDefault,
  csrfTokenForRequest,
  getSessionTtlSeconds,
  sessionCookieHeader,
  clearSessionCookieHeader,
  csrfCookieHeader,
} from "../session-store.js";
import {
  SETTINGS_SPEC,
  getSettingSpec,
  getSettingSource,
  resolveSetting,
  validateSettingValue,
  writeSettings,
  type SettingSpec,
} from "../settings-store.js";
import { getSsrfAuditLog } from "../utils/ssrf.js";

const router = Router();

// ── Rate-limit DÉDIÉ du login (anti-brute-force) ──
// 5 tentatives/min/IP. Store dédié, réinitialisable en test.
const LOGIN_RATE_LIMIT = 5;
const loginStore = new MemoryStore();
const loginRateLimiter = rateLimit({
  store: loginStore,
  windowMs: 60_000,
  limit: LOGIN_RATE_LIMIT,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many login attempts, try again later", code: "LOGIN_RATE_LIMITED" },
});

/** Réinitialise le compteur du rate-limit de login (outil de test). */
export async function resetLoginRateLimitForTests(): Promise<void> {
  await loginStore.resetAll();
}

/** Durée de vie (secondes) du cookie CSRF, alignée sur la session. */
function csrfMaxAge(): number {
  return getSessionTtlSeconds() || 12 * 3600;
}

// ── Authentification / session ──

// POST /api/admin/login — connexion (rate-limit dédié, CSRF double-submit).
router.post("/login", loginRateLimiter, requireCsrf, (req: Request, res: Response) => {
  const { password } = (req.body ?? {}) as { password?: unknown };
  if (typeof password !== "string" || password === "") {
    return res.status(400).json({ error: "password is required" });
  }
  if (!verifyAdminPassword(password)) {
    return res.status(401).json({ error: "Invalid password" });
  }
  const session = issueSession();
  const ttl = getSessionTtlSeconds();
  res.setHeader("Set-Cookie", [
    sessionCookieHeader(req, session.token, ttl),
    csrfCookieHeader(req, session.csrfToken, csrfMaxAge()),
  ]);
  res.json({ authenticated: true, passwordIsDefault: isPasswordDefault(), csrfToken: session.csrfToken });
});

// POST /api/admin/logout — déconnexion (vide le cookie de session).
router.post("/logout", requireCsrfForSession, (req: Request, res: Response) => {
  res.setHeader("Set-Cookie", clearSessionCookieHeader(req));
  res.json({ success: true });
});

// GET /api/admin/session — état de session + jeton CSRF.
// `passwordIsDefault` n'apparaît QUE pour une session valide (jamais anonyme).
router.get("/session", (req: Request, res: Response) => {
  const session = getSessionFromRequest(req);
  const csrfToken = csrfTokenForRequest(req);
  res.setHeader("Set-Cookie", csrfCookieHeader(req, csrfToken, csrfMaxAge()));
  if (session) {
    res.json({ authenticated: true, passwordIsDefault: isPasswordDefault(), csrfToken });
  } else {
    res.json({ authenticated: false, csrfToken });
  }
});

// POST /api/admin/password — change le mot de passe admin (invalide les sessions).
router.post("/password", requireAdmin, requireCsrfForSession, (req: Request, res: Response) => {
  const { current, next } = (req.body ?? {}) as { current?: unknown; next?: unknown };
  if (typeof current !== "string" || typeof next !== "string") {
    return res.status(400).json({ error: "current and next are required" });
  }
  if (next.trim().length < 4) {
    return res.status(400).json({ error: "next password must be at least 4 characters" });
  }
  if (!verifyAdminPassword(current)) {
    return res.status(401).json({ error: "Current password is incorrect" });
  }
  setAdminPassword(next);
  // L'époque a changé : le cookie courant est désormais invalide, on le vide.
  res.setHeader("Set-Cookie", clearSessionCookieHeader(req));
  res.json({ success: true });
});

// ── Réglages ──

/** Vue NON secrète d'un réglage pour l'API (jamais de secret en clair). */
function describeSetting(spec: SettingSpec): Record<string, unknown> {
  const source = getSettingSource(spec.name);
  const editable = source !== "env" && !spec.envOnly;
  const base: Record<string, unknown> = {
    name: spec.name,
    group: spec.group,
    type: spec.type,
    source,
    editable,
    restartRequired: Boolean(spec.restartRequired),
    sensitive: spec.type === "secret",
  };
  if (spec.type === "secret") {
    // Secret : on n'expose JAMAIS la valeur, seulement « configuré ou non ».
    return { ...base, configured: resolveSetting(spec.name, "") !== "", preview: "••••" };
  }
  return { ...base, value: resolveSetting(spec.name, spec.default) };
}

/** Liste groupée des réglages (ordre de SETTINGS_SPEC). */
function buildGroups(): { id: string; settings: Record<string, unknown>[] }[] {
  const groups: { id: string; settings: Record<string, unknown>[] }[] = [];
  const index = new Map<string, number>();
  for (const spec of SETTINGS_SPEC) {
    let at = index.get(spec.group);
    if (at === undefined) {
      at = groups.length;
      index.set(spec.group, at);
      groups.push({ id: spec.group, settings: [] });
    }
    groups[at].settings.push(describeSetting(spec));
  }
  return groups;
}

// GET /api/admin/settings — réglages groupés, sources et drapeaux (lecture seule).
router.get("/settings", requireAdmin, (_req: Request, res: Response) => {
  res.json({ groups: buildGroups() });
});

// PUT /api/admin/settings — met à jour `$LIBRY_DATA_DIR/config.json`.
// CSRF si session ; refusé tant que le mot de passe par défaut n'a pas changé
// POUR UNE SESSION (les accès scriptés restent inchangés).
router.put("/settings", requireAdmin, requireCsrfForSession, rejectDefaultPassword, (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { settings?: unknown };
  const incoming = body.settings;
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
    return res.status(400).json({ error: "Body must be { settings: { NAME: value | null } }" });
  }

  const updates: Record<string, string | null> = {};
  const lockedErrors: string[] = [];
  const invalidErrors: string[] = [];

  for (const [name, raw] of Object.entries(incoming as Record<string, unknown>)) {
    const spec = getSettingSpec(name);
    if (!spec) {
      invalidErrors.push(`${name}: unknown setting`);
      continue;
    }
    if (spec.envOnly || getSettingSource(name) === "env") {
      lockedErrors.push(`${name}: managed by the environment and cannot be edited`);
      continue;
    }
    if (raw === null) {
      updates[name] = null; // sentinelle : efface l'entrée (retour à l'env / au défaut)
      continue;
    }
    if (typeof raw === "string" && raw.trim() === "") continue; // champ vide = inchangé
    const result = validateSettingValue(spec, raw);
    if (!result.ok) {
      invalidErrors.push(result.error);
      continue;
    }
    updates[name] = result.value;
  }

  // Écriture ATOMIQUE : aucune modification si une clé est refusée.
  if (lockedErrors.length > 0) {
    return res.status(409).json({ error: "Some settings are locked by the environment", errors: lockedErrors });
  }
  if (invalidErrors.length > 0) {
    return res.status(400).json({ error: "Invalid settings", errors: invalidErrors });
  }

  const changed = Object.keys(updates);
  if (changed.length > 0) writeSettings(updates);
  res.json({ success: true, updated: changed, groups: buildGroups() });
});

// GET /api/admin/ssrf-log — journal des autorisations d'adresses internes.
// Ne contient AUCUN secret : nom d'hôte, IP contactée, entrée de liste
// blanche utilisée et route appelante (l'URL complète n'est jamais exposée).
router.get("/ssrf-log", requireAdmin, (_req: Request, res: Response) => {
  res.json({ entries: getSsrfAuditLog(50) });
});

export default router;