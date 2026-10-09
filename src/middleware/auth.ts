/**
 * Authentification des routes bibliothèque de Libry.
 *
 * UNE SEULE COUCHE : accepte `Authorization: Bearer <clé>` OU `X-API-Key: <clé>`.
 * La couche `apiAuth` de Pi-Web (propre à son UI) n'est PAS portée. Aucune
 * exception locale implicite : `GET /status` est publique car montée avant ce
 * middleware, toutes les autres routes exigent une clé valide.
 */
import { type Request, type Response, type NextFunction } from "express";
import { extractApiKey, validateKey } from "../libry-auth.js";

export function libryAuth(req: Request, res: Response, next: NextFunction): void {
  const provided = extractApiKey(req);
  if (!provided || !validateKey(provided)) {
    res.status(401).json({ error: "Invalid or missing API key" });
    return;
  }
  next();
}
