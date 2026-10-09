import { describe, it, expect } from "vitest";
import { ShotQueue, ShotQueueFullError } from "../src/shot-queue.js";

describe("ShotQueue — limite de concurrence", () => {
  it("2 slots simultanés puis rejet quand la file est nulle", async () => {
    const q = new ShotQueue(() => 2, () => 0);
    await q.acquire("shot:a");
    await q.acquire("shot:b");
    expect(q.activeCount).toBe(2);

    await expect(q.acquire("shot:c")).rejects.toBeInstanceOf(ShotQueueFullError);
    expect(q.activeCount).toBe(2);

    q.release("shot:a");
    expect(q.activeCount).toBe(1);
    // Un slot libéré peut être ré-acquis immédiatement.
    await q.acquire("shot:d");
    expect(q.activeCount).toBe(2);
  });

  it("file bornée : la demande suivante attend un slot, la N+1 est rejetée", async () => {
    const q = new ShotQueue(() => 1, () => 1);
    await q.acquire("shot:a");

    const queued = q.acquire("shot:b"); // en attente
    expect(q.queuedCount).toBe(1);
    await expect(q.acquire("shot:c")).rejects.toBeInstanceOf(ShotQueueFullError);

    q.release("shot:a");
    await queued; // b obtient le slot
    expect(q.activeCount).toBe(1);
    expect(q.queuedCount).toBe(0);
    q.release("shot:b");
  });

  it("release est idempotent (clé inconnue = no-op)", () => {
    const q = new ShotQueue(() => 1, () => 0);
    q.release("shot:inconnu");
    expect(q.activeCount).toBe(0);
  });

  it("l'erreur porte un retryAfterMs exploitable", async () => {
    const q = new ShotQueue(() => 1, () => 0, () => 7_000);
    await q.acquire("shot:a");
    try {
      await q.acquire("shot:b");
      throw new Error("aurait dû rejeter");
    } catch (e) {
      expect(e).toBeInstanceOf(ShotQueueFullError);
      expect((e as ShotQueueFullError).retryAfterMs).toBe(7_000);
    }
  });
});
