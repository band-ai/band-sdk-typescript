import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { MCP_SERVER_NAME } from "../../runtime/tools/schemas";

/** Cursor's project permission file, read by the agent running in that directory. */
export const CURSOR_PROJECT_CONFIG = join(".cursor", "cli.json");

/** Cursor's permission token for every tool on Band's own MCP server. */
export const BAND_MCP_PERMISSION = `Mcp(${MCP_SERVER_NAME}:*)`;

interface CursorProjectConfig {
  permissions?: { allow?: unknown; deny?: unknown; [key: string]: unknown };
  [key: string]: unknown;
}

/**
 * Lets Cursor call Band's own tools without asking the room each time
 * (https://cursor.com/docs/cli/reference/permissions). Every other permission
 * still reaches the room. An existing config keeps everything else it holds.
 */
export async function allowBandMcpTools(workspace: string): Promise<void> {
  const path = join(workspace, CURSOR_PROJECT_CONFIG);
  const config = await readConfig(path);
  const allow = permissionList(config, "allow", path);
  const deny = permissionList(config, "deny", path);
  // Cursor exits if either list is missing (https://cursor.com/docs/cli/reference/configuration).
  if (allow?.includes(BAND_MCP_PERMISSION) && deny) {
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  const allowed = allow?.includes(BAND_MCP_PERMISSION) ? allow : [...(allow ?? []), BAND_MCP_PERMISSION];
  const permissions = { ...config.permissions, allow: allowed, deny: deny ?? [] };
  await writeFile(path, `${JSON.stringify({ ...config, permissions }, null, 2)}\n`);
}

async function readConfig(path: string): Promise<CursorProjectConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  // A config we cannot read is the owner's to fix; overwriting it would lose their rules.
  try {
    return JSON.parse(text) as CursorProjectConfig;
  } catch (error) {
    throw new Error(`Cursor config ${path} is not valid JSON: ${(error as Error).message}`);
  }
}

function permissionList(config: CursorProjectConfig, key: "allow" | "deny", path: string): string[] | undefined {
  const list = config.permissions?.[key];
  if (list === undefined) return undefined;
  if (!Array.isArray(list) || !list.every((entry) => typeof entry === "string")) {
    throw new Error(`Cursor config ${path}: permissions.${key} must be a list of strings`);
  }
  return list;
}
