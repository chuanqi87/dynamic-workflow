import type { CodexLike } from "./codex-sdk.js";

/**
 * Lazily import `@openai/codex-sdk` and wrap the real `Codex` class as a
 * {@link CodexLike}. The lazy import means the package builds and unit-tests
 * run without the SDK installed (it is a peer dependency).
 *
 * SDK reality check (@openai/codex-sdk@0.142.2):
 *   - `Codex.startThread(opts?)` returns a `Thread` synchronously.
 *   - `Codex.resumeThread(id, opts?)` returns a `Thread` synchronously.
 *   - `Thread.id` is `string | null`.
 *   - `Thread.runStreamed(input, opts?)` returns `Promise<{ events: AsyncGenerator<ThreadEvent> }>`.
 *
 * The real `Thread` already satisfies `ThreadLike` structurally, so this
 * factory is a near-trivial constructor wrapper — no field/method mapping needed.
 */
export async function createCodex(): Promise<CodexLike> {
  // Use a type-only import of the SDK to avoid hard dependency at build time.
  type CodexSdk = typeof import("@openai/codex-sdk");
  const mod = (await import("@openai/codex-sdk")) as CodexSdk;
  // The real `Codex` class satisfies `CodexLike` structurally (confirmed above).
  return new mod.Codex() as unknown as CodexLike;
}
