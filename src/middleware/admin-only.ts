/**
 * Réservation des routes d'administration des clés (GET/POST/DELETE /keys).
 *
 * DÉLÈGUE à la logique de `requireAdmin` (Lot 4) : boucle locale RÉELLE
 * (adresse de socket TCP, non forgeable via X-Forwarded-For) OU clé valide
 * marquée administrateur OU session admin valide. Le message d'erreur historique
 * est conservé pour ne pas modifier le contrat scripté.
 */
import { type Request, type Response, type NextFunction } from "express";
import { isAdminRequest } from "./admin-session.js";

export function libryAdminOnly(req: Request, res: Response, next: NextFunction): void {
  if (isAdminRequest(req)) {
    next();
    return;
  }
  res.status(403).json({ error: "Key management is only available from localhost or an admin key" });
}
