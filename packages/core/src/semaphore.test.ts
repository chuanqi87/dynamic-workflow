import { describe, expect, test } from "bun:test";
import { Semaphore } from "./semaphore.js";

describe("Semaphore", () => {
  test("never exceeds the configured limit, even under bursty release/acquire", async () => {
    const limit = 3;
    const sem = new Semaphore(limit);
    let active = 0;
    let peak = 0;

    const work = () =>
      sem.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      });

    await Promise.all(Array.from({ length: 50 }, work));
    expect(peak).toBeLessThanOrEqual(limit);
    expect(active).toBe(0);
  });

  test("does not over-subscribe when a sync acquire races a release", async () => {
    const sem = new Semaphore(1);
    let active = 0;
    let peak = 0;
    const slot = () =>
      sem.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active--;
      });
    await Promise.all([slot(), slot(), slot(), slot()]);
    expect(peak).toBe(1);
  });

  test("rejects invalid limits", () => {
    expect(() => new Semaphore(0)).toThrow();
    expect(() => new Semaphore(-1)).toThrow();
  });
});
