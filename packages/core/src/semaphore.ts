/**
 * A minimal FIFO concurrency limiter.
 *
 * Only {@link AgentRunner} acquires the semaphore — `parallel`/`pipeline`
 * deliberately do NOT, so that wrapping a single `agent()` call in a thunk
 * cannot deadlock by double-queuing.
 *
 * Slots are *handed over* on release rather than decrement-then-reacquire,
 * which avoids a window where a synchronous `acquire()` could over-subscribe
 * before a woken waiter's microtask runs.
 */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`Semaphore limit must be a positive integer, got ${limit}`);
    }
  }

  /** Run `thunk` once a slot is free; always releases the slot afterwards. */
  async run<T>(thunk: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await thunk();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    // Slot is not incremented here; it is handed over directly in release().
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Hand the held slot directly to the next waiter — `active` unchanged.
      next();
    } else {
      this.active--;
    }
  }
}
