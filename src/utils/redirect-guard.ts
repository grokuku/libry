/**
 * Garde-fou des REDIRECTIONS pour les cibles autorisées par la liste blanche.
 *
 * Libry ne suit pas lui-même les redirections (c'est WebClaw ou Chromium qui
 * les suit). Quand une cible interne a été explicitement autorisée, on vérifie
 * donc AVANT la capture que la chaîne de redirections ne sort pas de la liste
 * blanche : une cible autorisée ne doit pas pouvoir rebondir vers une adresse
 * qui ne l'est pas.
 *
 * Choix de conception :
 *   - sonde `HEAD` avec `redirect: "manual"` (aucun corps téléchargé) ;
 *   - chaque `Location` est revalidé par `assertRedirectAllowed` avec la MÊME
 *     politique que la cible initiale ;
 *   - une sonde qui échoue (réseau, HEAD refusé par le serveur) n'est PAS une
 *     preuve de redirection : on laisse la capture décider (pas de faux refus) ;
 *   - toute redirection observée vers une cible non autorisée → refus.
 *
 * `httpFetch` est le point d'entrée réseau injectable (`utils/http.ts`) : les
 * tests n'ouvrent AUCUNE connexion réelle.
 */
import { assertRedirectAllowed, type SsrfOptions } from "./ssrf.js";
import { httpFetch } from "./http.js";

/** Nombre maximal de redirections inspectées. */
export const MAX_REDIRECT_HOPS = 3;

/** Délai maximal de la sonde (ms). */
export const PROBE_TIMEOUT_MS = 5_000;

export type RedirectProbeResult =
  | { ok: true }
  | { ok: false; reason: "redirect-not-allowed" | "invalid-location" };

export interface RedirectProbeOptions extends SsrfOptions {
  maxHops?: number;
  timeoutMs?: number;
}

/**
 * Inspecte la chaîne de redirections d'une URL DÉJÀ validée. Ne lève jamais :
 * retourne `{ok:false}` seulement si une redirection observée est refusée.
 */
export async function probeRedirectChain(
  rawUrl: string,
  options: RedirectProbeOptions = {},
): Promise<RedirectProbeResult> {
  const maxHops = options.maxHops ?? MAX_REDIRECT_HOPS;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const { maxHops: _maxHops, timeoutMs: _timeoutMs, ...ssrfOptions } = options;

  let current = rawUrl;
  for (let hop = 0; hop <= maxHops; hop++) {
    let status: number;
    let location: string | null;
    try {
      const res = await httpFetch(current, {
        method: "HEAD",
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = res.status;
      location = res.headers.get("location");
    } catch {
      // Réseau indisponible / HEAD refusé : aucune preuve → on n'entrave pas.
      return { ok: true };
    }

    if (status < 300 || status >= 400) return { ok: true };
    if (!location) return { ok: true };

    try {
      current = await assertRedirectAllowed(current, location, ssrfOptions);
    } catch {
      return { ok: false, reason: "redirect-not-allowed" };
    }
  }

  // Chaîne plus longue que la borne : pas de preuve d'infraction, on arrête.
  return { ok: true };
}
