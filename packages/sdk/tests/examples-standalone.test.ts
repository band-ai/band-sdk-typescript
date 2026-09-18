import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const EXAMPLES_DIR = path.resolve(process.cwd(), "examples");
/** Shared character prompts (Python `examples/prompts/`) — importable from any adapter folder. */
const SHARED_EXAMPLE_DIRS = new Set(["prompts"]);
const PROMPTS_DIR = path.join(EXAMPLES_DIR, "prompts");

async function listTypeScriptFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listTypeScriptFiles(absolute)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(absolute);
    }
  }

  return files;
}

function collectImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /from\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;

  for (const match of source.matchAll(pattern)) {
    const value = match[1] ?? match[2];
    if (!value) {
      continue;
    }

    specifiers.push(value);
  }

  return specifiers;
}

describe("examples", () => {
  it("are grouped into standalone folders without cross-folder dependencies", async () => {
    const entries = await readdir(EXAMPLES_DIR, { withFileTypes: true });
    const rootTsFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => entry.name);
    const exampleFolders = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    expect(rootTsFiles).toEqual([]);
    expect(exampleFolders.length).toBeGreaterThan(0);

    for (const folder of exampleFolders) {
      if (SHARED_EXAMPLE_DIRS.has(folder)) {
        continue;
      }

      const folderPath = path.join(EXAMPLES_DIR, folder);
      const tsFiles = await listTypeScriptFiles(folderPath);
      expect(tsFiles.length, `${folder} should contain at least one .ts file`).toBeGreaterThan(0);

      for (const fullPath of tsFiles) {
        const source = await readFile(fullPath, "utf8");
        const specifiers = collectImportSpecifiers(source);

        for (const specifier of specifiers) {
          if (!specifier.startsWith(".")) {
            continue;
          }

          const resolved = path.resolve(path.dirname(fullPath), specifier);
          if (!resolved.startsWith(EXAMPLES_DIR)) {
            continue;
          }

          if (resolved.startsWith(PROMPTS_DIR)) {
            continue;
          }

          expect(
            resolved.startsWith(folderPath),
            `${path.relative(EXAMPLES_DIR, fullPath)} imports ${specifier}, which leaves ${folder}/`,
          ).toBe(true);
        }
      }
    }
  });
});
