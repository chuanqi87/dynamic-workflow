import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

interface GitResult { code: number; stdout: string; stderr: string }

/** Run a git command, resolving (never rejecting) with its exit code + output. */
function git(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err
        ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1)
        : 0;
      resolve({ code, stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "" });
    });
  });
}

function sanitize(s: string): string {
  return s.replace(/[^\w.-]/g, "").slice(0, 64) || "wt";
}

/**
 * Create an isolated git worktree for an agent. On cleanup, an unchanged
 * worktree is removed; a dirty one is preserved (marked) for inspection. If
 * `baseDir` is not a git repo (or git is unavailable), degrades to running in
 * `baseDir` (no isolation) rather than failing the agent.
 */
export async function createWorktree(
  baseDir: string,
  id: string,
  log: (s: string) => void = () => {},
): Promise<{ dir: string; cleanup(): Promise<void> }> {
  const noIsolation = { dir: baseDir, cleanup: async () => {} };
  const isRepo = await git(["rev-parse", "--is-inside-work-tree"], baseDir)
    .then((r) => r.code === 0)
    .catch(() => false);
  if (!isRepo) {
    log("⚠ worktree isolation requested but the directory is not a git repo; running shared\n");
    return noIsolation;
  }
  const dir = join(baseDir, ".workflow", "worktrees", `wf-${sanitize(id)}`);
  const add = await git(["worktree", "add", "--detach", dir], baseDir);
  if (add.code !== 0) {
    log(`⚠ git worktree add failed (${add.stderr.trim()}); running shared\n`);
    return noIsolation;
  }
  return {
    dir,
    cleanup: async () => {
      const status = await git(["status", "--porcelain"], dir).catch(() => null);
      const dirty = !status || status.code !== 0 || status.stdout.trim() !== "";
      if (dirty) {
        await writeFile(join(dir, ".wf-preserved"), `${id}\n`).catch(() => undefined);
        log(`⚠ worktree ${dir} has changes — preserved for inspection\n`);
        return;
      }
      await git(["worktree", "remove", "--force", dir], baseDir).catch(() => undefined);
    },
  };
}
