/**
 * Réservation des routes d'administration des clés (GET/POST/DELETE /keys).
 *
 * Deux origines autorisées :
 *   - la boucle locale RÉELLE, d'après l'adresse de la socket TCP
 *     (`isTrustedLocalRequest`, non forgeable via X-Forwarded-For) ;
 *   - une clé valide marquée administrateur (LIBRY_ADMIN_KEYS ou champ `admin`
 *     du fichier de clés).
 */
import { type Request, type Response, type NextFunction } from "express";
import { extractApiKey, validateKey, isAdminKey } from "../libry-auth.js";
import { isTrustedLocalRequest } from "../utils/request-identity.js";

export function libryAdminOnly(req: Request, res: Response, next: NextFunction): void {
  if (isTrustedLocalRequest(req)) {
    next();
    return;
  }
  const provided = extractApiKey(req);
  if (provided && validateKey(provided) && isAdminKey(provided)) {
    next();
    return;
  }
  res.status(403).json({ error: "Key management is only available from localhost or an admin key" });
}
