/**
 * Routes du libraire de Libry.
 *
 * Contrat d'API REPRIS AU CARACTÈRE PRÈS depuis Pi-Web
 * (backend/src/routes/librarian.ts) : même préfixe (/api/librarian/*), mêmes
 * chemins, mêmes codes HTTP et MÊMES MESSAGES D'ERREUR. Yuki code ce contrat en
 * dur ; la moindre divergence serait une régression.
 *
 * Seule adaptation : POST /update. Pi-Web déclenchait son CRON local ; Libry
 * accepte un corps optionnel `{cwds: string[]}` (liste blanche de chemins) et
 * répond 501 sans liste configurée. Aucun appel LLM n'est effectué.
 */
import { Router, type Request, type Response } from "express";
import {
  getDocContent,
  listLibrary,
  getLibraryStatus,
  searchAndArchive,
  archiveDoc,
  sanitizeDocPathComponent,
  type DocEntry,
  type DocContent,
} from "../library-store.js";
import { loadKeys, createKey, revokeKey, keyIdOf, maskSecret } from "../libry-auth.js";
import { libryAuth } from "../middleware/auth.js";
import { libryAdminOnly } from "../middleware/admin-only.js";
import { getUpdateCwds } from "../config.js";

const router = Router();

// ── Key management routes (admin only — localhost ou clé admin) ──
// Montées AVANT libryAuth : elles utilisent leur propre contrôle admin.

// GET /api/librarian/keys — list all keys (admin only)
router.get("/keys", libryAdminOnly, (_req: Request, res: Response) => {
  const keys = loadKeys();
  // Expose l'identifiant NON secret (id) utilisé par l'UI pour la suppression.
  // Le hash (keyHash) et le secret ne quittent JAMAIS le serveur via cette route.
  res.json({
    keys: keys.map((k) => ({
      id: keyIdOf(k),
      name: k.name,
      createdAt: k.createdAt,
      key: k.keyPreview ?? (k.key ? maskSecret(k.key) : ""),
    })),
  });
});

// POST /api/librarian/keys — create a new key (admin only)
router.post("/keys", libryAdminOnly, (req: Request, res: Response) => {
  try {
    const { name } = req.body;
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "name is required" });
    }
    const key = createKey(name);
    // Return the full key value only on creation
    res.status(201).json(key);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/librarian/keys/:id — revoke a key by its NON-secret id (admin only)
router.delete("/keys/:id", libryAdminOnly, (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const deleted = revokeKey(id);
    if (!deleted) return res.status(404).json({ error: "Key not found" });
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Public route (no auth) ──

// GET /api/librarian/status — Statut de la bibliothèque (health check)
router.get("/status", (_req: Request, res: Response) => {
  res.json(getLibraryStatus());
});

// ── Authenticated routes (libryAuth : Bearer ou X-API-Key) ──

// GET /api/librarian/library — Liste toute la bibliothèque
router.get("/library", libryAuth, (_req: Request, res: Response) => {
  res.json(listLibrary());
});

// POST /api/librarian/search — Recherche (bibliothèque locale puis web)
router.post("/search", libryAuth, async (req: Request, res: Response) => {
  try {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: "Missing 'query' in body" });
    const result = await searchAndArchive(query);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/librarian/doc/:name — Récupère un doc spécifique
router.get("/doc/:name", libryAuth, (req: Request, res: Response) => {
  const { name } = req.params;
  const version = req.query.version as string | undefined;
  const doc = getDocContent(name, version);
  if (!doc) return res.status(404).json({ error: "Doc not found" });
  res.json(doc);
});

// POST /api/librarian/archive — Archive un document fourni par un agent externe
router.post("/archive", libryAuth, (req: Request, res: Response) => {
  try {
    const { name, version, type, sourceUrl, content } = req.body;
    if (!name || !version || !content) {
      return res.status(400).json({ error: "Missing required fields: name, version, content" });
    }

    // Neutralise tout path traversal dans name/version avant construction du chemin.
    const safeName = sanitizeDocPathComponent(name);
    const safeVersion = sanitizeDocPathComponent(version);
    if (!safeName || !safeVersion) {
      return res.status(400).json({
        error: "name and version must be valid path components (no slashes, no backslashes, no '..')",
      });
    }

    const docContent: DocContent = {
      meta: {
        name: safeName,
        version: safeVersion,
        type: type || "tool",
        sourceUrl,
        updatedAt: new Date().toISOString(),
      },
      summary: content.summary || "",
      keyPoints: content.keyPoints || [],
      api: content.api || [],
      examples: content.examples || [],
      breakingChanges: content.breakingChanges,
      rawContent: content.rawContent,
    };

    const filePath = `tools/${safeName}@${safeVersion}.json`;
    const entry: DocEntry = {
      name: safeName,
      version: safeVersion,
      type: type || "tool",
      description: (content.summary || "").substring(0, 200),
      filePath,
      keywords: [safeName, ...(content.keyPoints || []).slice(0, 5)],
      updatedAt: new Date().toISOString(),
      sourceUrl,
    };

    archiveDoc(entry, docContent);
    res.status(201).json({ success: true, entry });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/librarian/update — Mise à jour de la bibliothèque (cron).
// Corps optionnel `{cwds: string[]}` = liste blanche de chemins. Sans liste
// configurée (ni corps, ni LIBRY_UPDATE_CWDS) → 501. Aucun appel LLM.
router.post("/update", libryAuth, async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as { cwds?: unknown };
    const bodyCwds = Array.isArray(body.cwds)
      ? body.cwds.filter((c): c is string => typeof c === "string" && c.trim() !== "").map((c) => c.trim())
      : [];
    const configured = getUpdateCwds();
    const whitelist = bodyCwds.length > 0 ? bodyCwds : configured;

    if (whitelist.length === 0) {
      return res.status(501).json({
        error: "Library update is not configured (set LIBRY_UPDATE_CWDS or pass {cwds:[...]})",
      });
    }

    // Le moteur de scan/crawl est branché dans un lot ultérieur. Tant qu'il
    // n'est pas disponible, la route répond 501 — le contrat (501 sans liste
    // configurée) est respecté et aucune synthèse LLM n'est effectuée ici.
    return res.status(501).json({
      error: "Library update engine is not available yet (web/crawl lot pending)",
      cwds: whitelist,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
