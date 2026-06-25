import { homedir } from "node:os";
import { join } from "node:path";
import { resolveSourceFrom, type SourceInput } from "@workflow/host-support";

export type { SourceInput };

const registryDirs = (directory: string): string[] => [
  join(directory, ".opencode", "workflows"),
  join(homedir(), ".config", "opencode", "workflows"),
];

export function resolveSource(input: SourceInput, directory: string): Promise<string> {
  return resolveSourceFrom(input, directory, registryDirs(directory));
}
