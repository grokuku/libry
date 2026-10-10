/**
 * Indirection `fetch` — un SEUL point d'entrée réseau pour les clients web
 * (WebClaw, Tavily). Permet aux tests d'injecter un faux réseau et de garantir
 * qu'AUCUN appel réel ne part (les tests ne dépendent jamais du réseau).
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const realFetch: FetchLike = (input, init) => fetch(input, init);

let current: FetchLike = realFetch;

/** Injection d'une implémentation `fetch` (tests). `null` restaure la vraie. */
export function setFetchForTests(fake: FetchLike | null): void {
  current = fake ?? realFetch;
}

/** `fetch` effectif (délégué, injectable en test). */
export function httpFetch(input: string, init?: RequestInit): Promise<Response> {
  return current(input, init);
}
