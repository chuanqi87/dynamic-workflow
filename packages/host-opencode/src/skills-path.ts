import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Absolute path to the skills directory shipped inside this package, resolved
 * from this module's REAL location.
 *
 * `realpathSync` is required because opencode may load the plugin via a symlink
 * (e.g. `~/.config/opencode/plugins/<name>.js` → the real `dist/plugin-entry.js`);
 * Node ESM does not auto-resolve symlinks, so a naive `import.meta.url` would
 * point at the symlink and break the relative lookup. From either `dist/` (built)
 * or `src/` (tests run the TS directly), the parent of this module's dir is the
 * package root, where `skills/` lives — shipped via the package `files` field.
 */
const moduleDir = dirname(realpathSync(fileURLToPath(import.meta.url)));
export const PACKAGE_ROOT = dirname(moduleDir);
export const SKILLS_DIR = join(PACKAGE_ROOT, "skills");
