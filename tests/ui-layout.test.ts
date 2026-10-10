/**
 * Mise en page — pleine largeur + blocs de texte brut.
 *
 * Vérifications statiques du CSS servi (pas de navigateur) :
 *  - `.content` ne borne plus la largeur (ancien `max-width: 1080px` centré,
 *    qui laissait d'énormes marges vides sur écran large) ;
 *  - les blocs de texte brut / code (exemples ET « Contenu brut » du
 *    `<details>`) reviennent à la ligne au lieu d'être coupés.
 *
 * Les règles sont extraites par bloc `sélecteur { … }` : le test reste vert
 * tant que les déclarations attendues sont présentes, sans figer l'ordre ni
 * le formatage du fichier.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { makeTestEnv, type TestEnv } from "./helpers.js";

/** Retourne les déclarations du (ou des) bloc(s) dont la liste de sélecteurs contient `selector`. */
function declarationsFor(css: string, selector: string): string {
  // Les commentaires CSS peuvent précéder un sélecteur : on les retire d'abord.
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const bodies: string[] = [];
  for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].split(",").map((s) => s.trim());
    if (selectors.includes(selector)) bodies.push(m[2]);
  }
  return bodies.join("\n");
}

describe("Mise en page — pleine largeur", () => {
  let env: TestEnv;

  beforeEach(() => {
    env = makeTestEnv();
  });

  afterEach(() => {
    env.cleanup();
  });

  it("`.content` occupe toute la largeur (aucun max-width centré)", async () => {
    const css = (await request(env.app).get("/styles.css")).text;
    const content = declarationsFor(css, ".content");
    expect(content).toMatch(/width:\s*100%/);
    expect(content).not.toMatch(/max-width/);
  });

  it("les blocs de texte brut reviennent à la ligne (exemples + Contenu brut)", async () => {
    const css = (await request(env.app).get("/styles.css")).text;

    // Exemples / API du détail…
    const detailPre = declarationsFor(css, ".detail-section pre");
    expect(detailPre).toMatch(/white-space:\s*pre-wrap/);
    expect(detailPre).toMatch(/overflow-wrap:\s*anywhere/);

    // …et « Contenu brut » du <details> (pre qui n'était couvert par aucune règle).
    const rawPre = declarationsFor(css, ".disclosure pre");
    expect(rawPre).toMatch(/white-space:\s*pre-wrap/);
    expect(rawPre).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rawPre).not.toMatch(/overflow:\s*hidden/);
  });
});
