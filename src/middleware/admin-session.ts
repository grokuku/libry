/**
 * Contrôle d'accès administrateur de Libry (Lot 4).
 *
 * `requireAdmin` autorise TROIS origines, dans cet ordre :
 *   1. la boucle locale RÉELLE, d'après l'adresse de SOCKET TCP
 *      (`isTrustedLocalRequest`, correctif SEC-02 — JAMAIS `X-Forwarded-For`) ;
 *   2. une clé API valide marquée administrateur (LIBRY_ADMIN_KEYS ou champ
 *      `admin` du fichier de clés) ;
 *   3. une session admin valide (cookie `libry_session` signé HMAC).
 *
 * `libryAdminOnly` (routes /keys historiques) DÉLÈGUE à `isAdminRequest` : le
 * comportement scripté (Yuki, curl local, clé admin) reste strictement identique,
 * une session valide s'y ajoute simplement.
 *
 * CSRF : les mutations autorisées par un cookie de session (auth « ambiante »)
 * exigent le double-submit `X-CSRF-Token` ; les appels scriptés (loopback / clé
 * en en-tête) ne sont pas concernés. `POST /login`, qui n'a pas encore de
 * session, utilise aussi le double-submit via le jeton anonyme de `GET /session`.
 *
 * Garde-fou mot de passe par défaut : tant que `passwordIsDefault` est vrai, une
 * action SENSIBLE demandée DEPUIS UNE SESSION est refusée en 403
 * `PASSWORD_NOT_CHANGED`. Les accès scriptés restent inchangés ; se connecter,
 * lire et changer le mot de passe restent permis.
 */
import { type Request, type Response, type NextFunction } from "express";
import { extractApiKey, validateKey, isAdminKey } from "../libry-auth.js";
import { isTrustedLocalRequest } from "../utils/request-identity.js";
import { getSessionFromRequest, hasSessionCookie, verifyCsrfToken, isPasswordDefault } from "../session-store.js";

/** Vrai si la requête est autorisée comme administrateur (local, clé admin ou session). */
export function isAdminRequest(req: Request): boolean {
  if (isTrustedLocalRequest(req)) return true;
  const provided = extractApiKey(req);
  if (provided && validateKey(provided) && isAdminKey(provided)) return true;
  return getSessionFromRequest(req) !== null;
}

/** Exige une origine administrateur ; 403 sinon. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (isAdminRequest(req)) {
    next();
    return;
  }
  res.status(403).json({ error: "Admin access required" });
}

/** Exige le double-submit CSRF (en-tête `X-CSRF-Token` == cookie `libry_csrf`). */
export function requireCsrf(req: Request, res: Response, next: NextFunction): void {
  if (!verifyCsrfToken(req)) {
    res.status(403).json({ error: "Invalid or missing CSRF token", code: "CSRF_FAILED" });
    return;
  }
  next();
}

/**
 * Exige le CSRF UNIQUEMENT quand l'authentification repose sur un cookie de
 * session (auth ambiante). Les appels scriptés (loopback / clé en en-tête) n'ont
 * pas de cookie : ils passent — leur contrat reste inchangé.
 */
export function requireCsrfForSession(req: Request, res: Response, next: NextFunction): void {
  if (hasSessionCookie(req)) {
    requireCsrf(req, res, next);
    return;
  }
  next();
}

/**
 * Garde-fou « mot de passe par défaut » : refuse une action sensible demandée
 * depuis une session tant que le mot de passe admin est resté le défaut.
 */
export function rejectDefaultPassword(req: Request, res: Response, next: NextFunction): void {
  if (getSessionFromRequest(req) !== null && isPasswordDefault()) {
    res.status(403).json({
      error: "The default admin password must be changed before performing this action",
      code: "PASSWORD_NOT_CHANGED",
    });
    return;
  }
  next();
}
