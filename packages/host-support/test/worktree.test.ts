import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createWorktree } from "../src/worktree.js";

const run = promisify(execFile);
const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wf-wt-"));
  await run("git", ["init", "-q"], { cwd: dir });
  await run("git", ["config", "user.email", "t@t.dev"], { cwd: dir });
  await run("git", ["config", "user.name", "t"], { cwd: dir });
  await writeFile(join(dir, "README"), "hi\n");
  await run("git", ["add", "."], { cwd: dir });
  await run("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

describe("createWorktree", () => {
  test("creates an isolated worktree and removes it when unchanged", async () => {
    const repo = await initRepo();
    const wt = await createWorktree(repo, "agent-1");
    expect(wt.dir).not.toBe(repo);
    expect(await exists(wt.dir)).toBe(true);
    const inside = await run("git", ["rev-parse", "--is-inside-work-tree"], { cwd: wt.dir });
    expect(inside.stdout.trim()).toBe("true");

    await wt.cleanup();
    expect(await exists(wt.dir)).toBe(false); // unchanged → removed
  });

  test("preserves a dirty worktree on cleanup", async () => {
    const repo = await initRepo();
    const wt = await createWorktree(repo, "agent-2");
    await writeFile(join(wt.dir, "scratch.txt"), "work in progress\n");
    await wt.cleanup();
    expect(await exists(wt.dir)).toBe(true); // dirty → kept
    expect(await exists(join(wt.dir, ".wf-preserved"))).toBe(true);
  });

  test("degrades to the shared dir when not a git repo", async () => {
    const plain = await mkdtemp(join(tmpdir(), "wf-plain-"));
    const wt = await createWorktree(plain, "agent-3");
    expect(wt.dir).toBe(plain); // no isolation, no throw
    await wt.cleanup();
  });
});
