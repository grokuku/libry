/**
 * Authentification des routes bibliothèque de Libry.
 *
 * Accepte `Authorization: Bearer <clé>` OU `X-API-Key: <clé>`, ET — en plus, Lot 4
 * — une session admin valide (cookie `libry_session`), pour que le navigateur
 * connecté lise `/library` et `/doc/:name`. Le contrat API reste INCHANGÉ : sans
 * clé ni session, la réponse est le 401 verbatim `{error: "Invalid or missing API
 * key"}`. `GET /status` est publique car montée avant ce middleware.
 */
import { type Request, type Response, type NextFunction } from "express";
import { extractApiKey, validateKey } from "../libry-auth.js";
import { getSessionFromRequest } from "../session-store.js";

export function libryAuth(req: Request, res: Response, next: NextFunction): void {
  if (getSessionFromRequest(req) !== null) {
    next();
    return;
  }
  const provided = extractApiKey(req);
  if (!provided || !validateKey(provided)) {
    res.status(401).json({ error: "Invalid or missing API key" });
    return;
  }
  next();
}
