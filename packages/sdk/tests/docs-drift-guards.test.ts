import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import pkg from "../package.json" with { type: "json" };

const SDK_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const REPO_ROOT = resolve(SDK_ROOT, "../..");
const EXAMPLES_DIR = resolve(SDK_ROOT, "examples");

function exampleFolders(): string[] {
  return readdirSync(EXAMPLES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

describe("examples/README.md matches what is on disk", () => {
  const listed = [...readFileSync(resolve(EXAMPLES_DIR, "README.md"), "utf-8")
    .matchAll(/^- `([^`]+)\/`$/gm)].map((m) => m[1]!).sort();

  it("lists every folder that exists", () => {
    expect(exampleFolders().filter((f) => !listed.includes(f))).toEqual([]);
  });

  it("lists no folder that does not exist", () => {
    // `dog-landing-page/` was listed here long after the folder was deleted.
    expect(listed.filter((f) => !exampleFolders().includes(f))).toEqual([]);
  });
});

describe("the root README's Examples table matches what is on disk", () => {
  const readme = readFileSync(resolve(REPO_ROOT, "README.md"), "utf-8");
  const tabled = [...readme.matchAll(/^\| `examples\/([^`/]+)\/` \|/gm)].map((m) => m[1]!).sort();

  it("has a row for every example folder", () => {
    expect(exampleFolders().filter((f) => !tabled.includes(f))).toEqual([]);
  });

  it("has no row for a folder that does not exist", () => {
    expect(tabled.filter((f) => !exampleFolders().includes(f))).toEqual([]);
  });
});

describe("the root README's Subpath Exports table matches package.json#exports", () => {
  const readme = readFileSync(resolve(REPO_ROOT, "README.md"), "utf-8");
  const tabled = new Set(
    [...readme.matchAll(/^\| `(@band-ai\/sdk(?:\/[^`]+)?)` \|/gm)].map((m) => m[1]!),
  );

  const exported = Object.keys(pkg.exports as Record<string, unknown>)
    .map((key) => (key === "." ? "@band-ai/sdk" : `@band-ai/sdk${key.slice(1)}`));

  it.each(exported)("%s has a row in the table", (name) => {
    expect(tabled.has(name), `${name} is exported but missing from the README table`).toBe(true);
  });

  it("has no row for a subpath that is not exported", () => {
    const extra = [...tabled].filter((name) => !exported.includes(name));
    expect(extra, `documented but not exported: ${extra.join(", ")}`).toEqual([]);
  });
});

describe("changelogs are not stale or self-duplicating", () => {
  it("the SDK changelog's newest entry matches the package version", () => {
    const changelog = readFileSync(resolve(SDK_ROOT, "CHANGELOG.md"), "utf-8");
    const newest = /^## \[(\d+\.\d+\.\d+)\]/m.exec(changelog)?.[1];
    expect(newest).toBe(pkg.version);
  });

  it("no release body appears more than once in the SDK changelog", () => {
    const changelog = readFileSync(resolve(SDK_ROOT, "CHANGELOG.md"), "utf-8");
    const bodies = changelog
      .split(/^## \[/m)
      .slice(1)
      .map((section) => section.split("\n").slice(1).join("\n").trim())
      .filter((body) => body.length > 0 && !body.startsWith("No changes of its own"));

    const seen = new Set<string>();
    const duplicated: string[] = [];
    for (const body of bodies) {
      if (seen.has(body)) {
        duplicated.push(body.slice(0, 80));
      }
      seen.add(body);
    }

    expect(duplicated, `duplicated release bodies:\n${duplicated.join("\n")}`).toEqual([]);
  });

  it("the root changelog points at the per-package ones instead of going stale", () => {
    const root = readFileSync(resolve(REPO_ROOT, "CHANGELOG.md"), "utf-8");
    expect(root).toContain("packages/sdk/CHANGELOG.md");
  });
});
