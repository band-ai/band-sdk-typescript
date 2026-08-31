import { readdirSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SDK_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const SRC = resolve(SDK_ROOT, "src");

const SUPPRESSION = /@ts-(?:ignore|expect-error|nocheck)/;

function readSources(dir: string = SRC): Array<readonly [string, string]> {
  const found: Array<readonly [string, string]> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...readSources(full));
    } else if (entry.name.endsWith(".ts")) {
      found.push([full.slice(SRC.length + 1).split(sep).join("/"), readFileSync(full, "utf-8")]);
    }
  }
  return found;
}

const SOURCES = readSources();

const tsconfig = JSON.parse(readFileSync(resolve(SDK_ROOT, "tsconfig.json"), "utf-8")) as {
  compilerOptions: Record<string, unknown>;
};

const pkg = JSON.parse(readFileSync(resolve(SDK_ROOT, "package.json"), "utf-8")) as {
  peerDependencies: Record<string, string>;
  peerDependenciesMeta: Record<string, { optional?: boolean }>;
  devDependencies: Record<string, string>;
};

describe("the compiler runs with every strictness flag the package claims", () => {
  it.each([
    "strict",
    "noImplicitOverride",
    "noImplicitReturns",
    "noFallthroughCasesInSwitch",
    "noUnusedLocals",
    "noUnusedParameters",
    "noUncheckedIndexedAccess",
  ])("%s is enabled", (flag) => {
    expect(tsconfig.compilerOptions[flag]).toBe(true);
  });
});

describe("type errors are fixed, not suppressed", () => {
  // The strict flags above were enabled by fixing what they reported, not by silencing
  // it: src/ carries no compiler-directive comment at all, and this asserts it stays so.
  it("no compiler-directive comment is used to silence an error anywhere in src/", () => {
    const offenders = SOURCES
      .filter(([, source]) => SUPPRESSION.test(source))
      .map(([rel]) => rel);
    expect(offenders).toEqual([]);
  });
});

describe("optional peers are typed by their own declarations", () => {
  const optionalDeps = readFileSync(resolve(SRC, "optional-deps.d.ts"), "utf-8");
  const googleAdk = readFileSync(resolve(SRC, "types/google-adk.d.ts"), "utf-8");

  const declaredModules = (source: string): string[] =>
    [...source.matchAll(/declare module "([^"]+)"/g)].map((match) => match[1] ?? "");

  it("only the packages that ship no usable types keep an ambient declaration", () => {
    expect(declaredModules(optionalDeps)).toEqual([
      "@a2a-js/sdk",
      "@a2a-js/sdk/client",
      "@a2a-js/sdk/server",
      "@a2a-js/sdk/server/express",
    ]);
    expect(declaredModules(googleAdk)).toEqual(["@google/adk"]);
  });

  it("each surviving ambient declaration says why it survives", () => {
    expect(optionalDeps).toMatch(/^\/\/ /);
    expect(optionalDeps).toContain("devDependencies");
    expect(googleAdk).toMatch(/^\/\/ /);
  });

  /**
   * These are the peers whose ambient declarations were deleted. A devDependency is what
   * makes `import type` resolve to the upstream declaration instead of `any`, so losing one
   * silently reintroduces the erasure the ambient declarations used to cause.
   */
  const TYPED_PEERS = [
    "@anthropic-ai/sdk",
    "@google/genai",
    "@langchain/core",
    "@langchain/langgraph",
    "@letta-ai/letta-client",
    "ai",
    "openai",
    "parlant-client",
  ] as const;

  it.each(TYPED_PEERS)("%s is installed at a version its peer range accepts", (name) => {
    expect(Object.keys(pkg.devDependencies)).toContain(name);

    const range = pkg.peerDependencies[name] ?? "";
    const minimum = /^>=\s*(\d+)\.(\d+)\.(\d+)/.exec(range);
    expect(minimum, `unexpected peer range for ${name}: ${range}`).not.toBeNull();

    const installed = JSON.parse(
      readFileSync(resolve(SDK_ROOT, "node_modules", name, "package.json"), "utf-8"),
    ) as { version: string };

    const rank = (version: string): number => {
      const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
      return major * 1_000_000 + minor * 1_000 + patch;
    };
    expect(
      rank(installed.version) >= rank(`${minimum?.[1]}.${minimum?.[2]}.${minimum?.[3]}`),
      `${name}@${installed.version} does not satisfy ${range}`,
    ).toBe(true);
  });
});

describe("consumer install behaviour is unchanged", () => {
  /**
   * Adding the peers to devDependencies must not touch what a consumer installs, so the two
   * blocks are compared byte for byte -- key order and formatting included -- against the
   * snapshot taken before they were added.
   */
  it("peerDependencies and peerDependenciesMeta match the committed snapshot byte for byte", () => {
    const manifest = readFileSync(resolve(SDK_ROOT, "package.json"), "utf-8").replace(/\r\n/g, "\n");
    const snapshot = readFileSync(
      resolve(SDK_ROOT, "tests/fixtures/peer-dependencies-snapshot.txt"),
      "utf-8",
    ).replace(/\r\n/g, "\n");

    const start = manifest.indexOf('  "peerDependencies": {');
    const end = manifest.indexOf('  "devDependencies": {');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    expect(`${manifest.slice(start, end).trimEnd().slice(0, -1)}\n`).toBe(snapshot);
  });

  it("every peer is still declared optional", () => {
    for (const name of Object.keys(pkg.peerDependencies)) {
      expect(pkg.peerDependenciesMeta[name]?.optional, `${name} is not optional`).toBe(true);
    }
  });
});
