/**
 * File d'attente bornée des captures d'écran.
 *
 * - `limit` : nombre de captures simultanées autorisées (LIBRY_SHOT_CONCURRENCY).
 * - `queueMax` : nombre de demandes pouvant attendre un slot
 *   (LIBRY_SHOT_QUEUE_MAX). 0 = pas d'attente : dès que la limite est
 *   atteinte, la nouvelle demande est rejetée (HTTP 429 côté route).
 *
 * L'identifiant de slot doit être UNIQUE par capture (ex. `shot:<uuid>`) : il
 * ne doit jamais s'agir d'une clé métier (deux captures du même hôte sont
 * indépendantes). La libération se fait dans un `finally`.
 */
import { getShotConcurrency, getShotQueueMax } from "./config.js";

/** Rejet par file pleine : la route répond 429 + en-tête Retry-After. */
export class ShotQueueFullError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super("Screenshot queue is full");
    this.name = "ShotQueueFullError";
    this.retryAfterMs = retryAfterMs;
  }
}

interface Waiter {
  slotKey: string;
  resolve: () => void;
}

export class ShotQueue {
  private readonly active = new Set<string>();
  private readonly waiting: Waiter[] = [];

  constructor(
    private readonly limit: () => number,
    private readonly queueMax: () => number,
    /** Estimation du délai avant libération d'un slot (pour Retry-After). */
    private readonly retryAfterMs: () => number = () => 5_000,
  ) {}

  get activeCount(): number {
    return this.active.size;
  }

  get queuedCount(): number {
    return this.waiting.length;
  }

  /**
   * Acquiert un slot. Résout immédiatement si un slot est libre, sinon attend
   * (FIFO) tant que la file n'est pas pleine. Lève `ShotQueueFullError` si la
   * file est pleine. La promesse résolue DOIT être suivie d'un `release`.
   */
  acquire(slotKey: string): Promise<void> {
    const limit = Math.max(1, this.limit());
    if (this.active.size < limit) {
      this.active.add(slotKey);
      return Promise.resolve();
    }
    if (this.waiting.length >= Math.max(0, this.queueMax())) {
      return Promise.reject(new ShotQueueFullError(this.retryAfterMs()));
    }
    return new Promise<void>((resolve) => {
      this.waiting.push({ slotKey, resolve });
    });
  }

  /** Libère un slot (no-op idempotent) et réveille la demande suivante. */
  release(slotKey: string): void {
    if (!this.active.delete(slotKey)) return;
    const next = this.waiting.shift();
    if (next) {
      this.active.add(next.slotKey);
      next.resolve();
    }
  }
}

/** Instance partagée du service (limites relues à chaud depuis la config). */
export const shotQueue = new ShotQueue(
  () => getShotConcurrency(),
  () => getShotQueueMax(),
);
