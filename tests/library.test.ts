import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "fs";
import { join } from "path";
import { makeTestEnv, type TestEnv } from "./helpers.js";
import {
  ensureDocsDir,
  archiveDoc,
  searchLocalDocs,
  getDocContent,
  listLibrary,
  getLibraryStatus,
  sanitizeDocPathComponent,
  sanitizeContent,
  formatDocAsText,
  type DocEntry,
  type DocContent,
} from "../src/library-store.js";

let env: TestEnv;

beforeEach(() => {
  env = makeTestEnv();
});

afterEach(() => env.cleanup());

function makeContent(name: string, version: string, summary: string, extra: Partial<DocContent> = {}): DocContent {
  return {
    meta: { name, version, type: "tool", updatedAt: new Date().toISOString() },
    summary,
    keyPoints: [],
    api: [],
    examples: [],
    ...extra,
  };
}

function makeEntry(name: string, version: string, description: string, keywords: string[]): DocEntry {
  return {
    name,
    version,
    type: "tool",
    description,
    filePath: `tools/${name}@${version}.json`,
    keywords,
    updatedAt: new Date().toISOString(),
  };
}

describe("ensureDocsDir", () => {
  it("crée le répertoire de la bibliothèque et docs/tools", () => {
    ensureDocsDir();
    expect(existsSync(env.docsDir)).toBe(true);
    expect(existsSync(join(env.docsDir, "tools"))).toBe(true);
  });
});

describe("searchLocalDocs", () => {
  beforeEach(() => {
    archiveDoc(
      makeEntry("webclaw", "0.6.23", "web scraping and crawl tool", ["scrape", "crawl", "markdown"]),
      makeContent("webclaw", "0.6.23", "outil de scraping web"),
    );
    archiveDoc(
      makeEntry("tavily", "1.0.0", "search api service", ["search", "api"]),
      makeContent("tavily", "1.0.0", "service de recherche"),
    );
  });

  it("retourne le doc pertinent et élague le reste", () => {
    const res = searchLocalDocs("webclaw scraping");
    expect(res.map((e) => e.name)).toEqual(["webclaw"]);
  });

  it("ne retourne rien pour une requête de stopwords ou trop courte", () => {
    expect(searchLocalDocs("the and")).toEqual([]);
    expect(searchLocalDocs("a b")).toEqual([]);
  });
});

describe("archiveDoc / getDocContent / listLibrary", () => {
  it("persiste le document, l'indexe et le relit (avec filtre de version)", () => {
    archiveDoc(
      makeEntry("demo", "1.0.0", "demo tool", ["demo"]),
      makeContent("demo", "1.0.0", "résumé", { rawContent: "ligne" }),
    );

    expect(existsSync(join(env.docsDir, "tools", "demo@1.0.0.json"))).toBe(true);

    const doc = getDocContent("demo");
    expect(doc?.summary).toBe("résumé");
    expect(getDocContent("demo", "1.0.0")?.meta.version).toBe("1.0.0");
    expect(getDocContent("demo", "9.9.9")).toBeNull();
    expect(getDocContent("inconnu")).toBeNull();

    expect(listLibrary().library).toHaveLength(1);
    expect(getLibraryStatus().totalDocs).toBe(1);
  });

  it("ré-archiver même name+version remplace l'entrée (pas de doublon)", () => {
    archiveDoc(makeEntry("demo", "1.0.0", "v1", ["demo"]), makeContent("demo", "1.0.0", "un"));
    archiveDoc(makeEntry("demo", "1.0.0", "v2", ["demo"]), makeContent("demo", "1.0.0", "deux"));
    const lib = listLibrary();
    expect(lib.library).toHaveLength(1);
    expect(lib.library[0].description).toBe("v2");
  });

  it("sanitize le rawContent avant persistance", () => {
    archiveDoc(
      makeEntry("demo", "1.0.0", "demo", ["demo"]),
      makeContent("demo", "1.0.0", "s", { rawContent: "contact user@example.com" }),
    );
    expect(getDocContent("demo")?.rawContent).toBe("contact [email removed]");
  });
});

describe("sanitizeDocPathComponent", () => {
  it("refuse séparateurs et traversées", () => {
    expect(sanitizeDocPathComponent("a/b")).toBeNull();
    expect(sanitizeDocPathComponent("a\\b")).toBeNull();
    expect(sanitizeDocPathComponent("..")).toBeNull();
    expect(sanitizeDocPathComponent("a..b")).toBeNull();
    expect(sanitizeDocPathComponent(".")).toBeNull();
    expect(sanitizeDocPathComponent("")).toBeNull();
  });

  it("accepte et normalise les composants valides", () => {
    expect(sanitizeDocPathComponent("webclaw")).toBe("webclaw");
    expect(sanitizeDocPathComponent("my tool")).toBe("my_tool");
    expect(sanitizeDocPathComponent("a".repeat(80))?.length).toBe(50);
  });
});

describe("sanitizeContent", () => {
  it("retire emails, clés, chemins personnels et téléphones", () => {
    const out = sanitizeContent("mail a@b.co key sk-abcdefghijklmnopqrstuvwxyz Bearer abc.def home /home/alice tel 555 123 4567");
    expect(out).toContain("[email removed]");
    expect(out).toContain("[key removed]");
    expect(out).toContain("[path removed]");
    expect(out).toContain("[phone removed]");
  });
});

describe("formatDocAsText", () => {
  it("produit les sections attendues", () => {
    const text = formatDocAsText(
      makeContent("demo", "1.0.0", "résumé", {
        keyPoints: ["point"],
        api: [{ signature: "f()", description: "fait" }],
        examples: [{ title: "ex", code: "f();" }],
        breakingChanges: ["cassé"],
      }),
    );
    expect(text).toContain("# demo v1.0.0");
    expect(text).toContain("## Summary");
    expect(text).toContain("## Key Points");
    expect(text).toContain("## API");
    expect(text).toContain("## Examples");
    expect(text).toContain("## Breaking Changes");
  });
});
