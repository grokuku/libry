/**
 * Bibliothèque de Libry — port de la partie stockage / recherche locale de
 * Pi-Web (backend/src/pi/librarian-service.ts).
 *
 * Le moteur web (WebClaw, Tavily) n'est PAS porté dans ce lot : la recherche
 * web est isolée derrière l'interface WebSearchProvider, à brancher dans un lot
 * ultérieur. Tant qu'aucun fournisseur n'est enregistré, POST /search renvoie
 * les résultats locaux, ou une liste vide sur un miss local — le contrat de
 * réponse reste inchangé.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { getDocsDir } from "./config.js";

// ── Types ──

export interface DocEntry {
  name: string;
  version: string;
  type: string;
  description: string;
  filePath: string;
  keywords: string[];
  updatedAt: string;
  sourceUrl?: string;
}

export interface DocIndex {
  lastUpdated: string;
  lastScan: string;
  library: DocEntry[];
}

export interface DocContent {
  meta: {
    name: string;
    version: string;
    type: string;
    sourceUrl?: string;
    updatedAt: string;
  };
  summary: string;
  keyPoints: string[];
  api: Array<{ signature: string; description: string }>;
  examples: Array<{ title: string; code: string }>;
  breakingChanges?: string[];
  rawContent?: string;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  content?: string;
}

/** Fournisseur de recherche web, branché dans un lot ultérieur (WebClaw/Tavily). */
export type WebSearchProvider = (query: string, num: number) => Promise<WebSearchResult[]>;

// ── Stockage ──

/** Crée le répertoire de la bibliothèque (docs/ + docs/tools) si nécessaire. */
export function ensureDocsDir(): void {
  const docsDir = getDocsDir();
  if (!existsSync(docsDir)) mkdirSync(docsDir, { recursive: true });
  const toolsDir = join(docsDir, "tools");
  if (!existsSync(toolsDir)) mkdirSync(toolsDir, { recursive: true });
}

export function loadIndex(): DocIndex {
  ensureDocsDir();
  const indexPath = join(getDocsDir(), "index.json");
  if (!existsSync(indexPath)) {
    return { lastUpdated: "", lastScan: "", library: [] };
  }
  return JSON.parse(readFileSync(indexPath, "utf-8"));
}

export function saveIndex(index: DocIndex): void {
  ensureDocsDir();
  const indexPath = join(getDocsDir(), "index.json");
  writeFileSync(indexPath, JSON.stringify(index, null, 2));
}

function loadDoc(filePath: string): DocContent | null {
  const fullPath = join(getDocsDir(), filePath);
  if (!existsSync(fullPath)) return null;
  return JSON.parse(readFileSync(fullPath, "utf-8"));
}

function saveDoc(filePath: string, doc: DocContent): void {
  ensureDocsDir();
  const fullPath = join(getDocsDir(), filePath);
  const dir = dirname(fullPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(fullPath, JSON.stringify(doc, null, 2));
}

// ── Recherche web (isolée — fournisseur à brancher plus tard) ──

let webSearchProvider: WebSearchProvider | null = null;

/** Enregistre le fournisseur de recherche web (null pour le retirer). */
export function setWebSearchProvider(provider: WebSearchProvider | null): void {
  webSearchProvider = provider;
}

export function getWebSearchProvider(): WebSearchProvider | null {
  return webSearchProvider;
}

// ── Utilitaires ──

/**
 * Nettoie un nom ou une version pour construire un chemin de fichier sûr.
 * Caractères autorisés [a-zA-Z0-9_-] ; séparateurs de chemin et traversées
 * (`/`, `\`, `..`) sont refusés.
 */
export function sanitizeDocPathComponent(value: string, maxLength = 50): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value === "." ||
    value === ".." ||
    value.includes("..")
  ) {
    return null;
  }

  const safe = value.replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, maxLength);
  return safe.length > 0 ? safe : null;
}

/**
 * Nettoie le contenu pour retirer toute information personnelle avant archivage.
 */
export function sanitizeContent(content: string): string {
  let cleaned = content;
  // Emails
  cleaned = cleaned.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[email removed]");
  // API keys (sk-xxx, tvly-xxx, Bearer xxx)
  cleaned = cleaned.replace(/(?:sk-[A-Za-z0-9]{20,})|(?:tvly-[A-Za-z0-9]{20,})|(?:Bearer\s+[A-Za-z0-9._-]+)/gi, "[key removed]");
  // Chemins personnels (/home/user, /Users/name)
  cleaned = cleaned.replace(/\/(?:home|Users)\/[^\/\s]+/g, "[path removed]");
  cleaned = cleaned.replace(/C:\\\\Users\\[^\\\s]+/gi, "[path removed]");
  // Numéros de téléphone (format international et US)
  cleaned = cleaned.replace(/\b\+?\d{1,3}[-.\s]?\d{3}[-.\s]?\d{3,4}[-.\s]?\d{0,4}\b/g, "[phone removed]");
  return cleaned;
}

/** Formate un doc en texte pour un LLM. */
export function formatDocAsText(doc: DocContent): string {
  let text = `# ${doc.meta.name} v${doc.meta.version}\n\n`;
  text += `## Summary\n${doc.summary}\n\n`;
  if (doc.keyPoints.length > 0) {
    text += `## Key Points\n`;
    doc.keyPoints.forEach((p) => (text += `- ${p}\n`));
    text += "\n";
  }
  if (doc.api.length > 0) {
    text += `## API\n`;
    doc.api.forEach((a) => (text += `- **${a.signature}**: ${a.description}\n`));
    text += "\n";
  }
  if (doc.examples.length > 0) {
    text += `## Examples\n`;
    doc.examples.forEach((ex) => {
      text += `### ${ex.title}\n\`\`\`\n${ex.code}\n\`\`\`\n\n`;
    });
  }
  if (doc.breakingChanges && doc.breakingChanges.length > 0) {
    text += `## Breaking Changes\n`;
    doc.breakingChanges.forEach((c) => (text += `- ${c}\n`));
  }
  return text;
}

// ── API publique ──

/** Mots trop courants pour être pertinents seuls. */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "are", "was", "how", "what", "when", "why",
  "who", "use", "using", "into", "your", "have", "has", "not", "but", "can", "all", "any", "get",
  "set", "new", "old", "des", "les", "une", "sur", "dan", "par", "pas", "pour", "avec", "tout",
  "sont", "comment", "cette", "cela",
]);

/** Recherche dans la bibliothèque locale. */
export function searchLocalDocs(query: string): DocEntry[] {
  const index = loadIndex();
  const queryLower = query.toLowerCase();
  const allTerms = queryLower.split(/\s+/);
  // Filtrer : termes de 4+ chars qui ne sont pas des stopwords
  const terms = allTerms.filter((t) => t.length >= 4 && !STOPWORDS.has(t));

  if (terms.length === 0) return [];

  // Scorer chaque doc par le nombre de termes qui matchent
  const scored = index.library
    .map((entry) => {
      const searchable = (entry.name + " " + entry.description + " " + entry.keywords.join(" ")).toLowerCase();
      let matchCount = 0;
      for (const term of terms) {
        if (searchable.includes(term)) matchCount++;
      }
      return { entry, score: matchCount };
    })
    .filter((item) => {
      // Au moins 2 termes doivent matcher, OU au moins 50 % des termes
      const minMatches = Math.max(2, Math.ceil(terms.length * 0.5));
      return item.score >= minMatches;
    })
    .sort((a, b) => b.score - a.score);

  return scored.map((item) => item.entry);
}

/** Récupère le contenu d'un doc (null si absent). */
export function getDocContent(name: string, version?: string): DocContent | null {
  const index = loadIndex();
  const entry = index.library.find((e) => e.name === name && (!version || e.version === version));
  if (!entry) return null;
  return loadDoc(entry.filePath);
}

/**
 * Recherche locale puis web. L'archivage automatique reste désactivé
 * (`archived: false`), comme dans Pi-Web.
 */
export async function searchAndArchive(query: string): Promise<{ results: WebSearchResult[]; archived: boolean }> {
  // 1. Chercher d'abord dans la bibliothèque locale
  const local = searchLocalDocs(query);
  if (local.length > 0) {
    const docs = local.map((entry) => {
      const content = loadDoc(entry.filePath);
      return {
        title: `${entry.name} v${entry.version}`,
        url: entry.sourceUrl || "",
        snippet: content?.summary || entry.description,
        content: content ? formatDocAsText(content) : undefined,
      };
    });
    return { results: docs, archived: false };
  }

  // 2. Sinon, recherche web via le fournisseur branché plus tard (WebClaw/Tavily).
  //    Sans fournisseur enregistré, on renvoie une liste vide sans casser le contrat.
  const provider = getWebSearchProvider();
  if (!provider) return { results: [], archived: false };

  const webResults = await provider(query, 5);
  return { results: webResults, archived: false };
}

/** Archive un document dans la bibliothèque. */
export function archiveDoc(entry: DocEntry, content: DocContent): void {
  // Sanitize content before persisting
  const sanitizedContent: DocContent = {
    ...content,
    rawContent: content.rawContent ? sanitizeContent(content.rawContent) : undefined,
  };

  ensureDocsDir();
  saveDoc(entry.filePath, sanitizedContent);

  const index = loadIndex();
  const existingIdx = index.library.findIndex((e) => e.name === entry.name && e.version === entry.version);
  if (existingIdx >= 0) {
    index.library[existingIdx] = entry;
  } else {
    index.library.push(entry);
  }
  index.lastUpdated = new Date().toISOString();
  saveIndex(index);
}

/** Liste toute la bibliothèque. */
export function listLibrary(): DocIndex {
  return loadIndex();
}

/** Statut de la bibliothèque. */
export function getLibraryStatus(): { totalDocs: number; lastUpdated: string; lastScan: string } {
  const index = loadIndex();
  return {
    totalDocs: index.library.length,
    lastUpdated: index.lastUpdated,
    lastScan: index.lastScan,
  };
}
