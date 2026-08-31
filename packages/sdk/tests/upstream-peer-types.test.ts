import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SDK_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

/**
 * Each peer that used to be erased by a body-less ambient declaration, with a field the SDK
 * relies on and the upstream type that field resolves to. `wrong` is deliberately invalid,
 * so the compiler has to name `upstreamType` in its diagnostic. If the erasure ever comes
 * back, that import resolves to `any`, the assignment compiles, and this fails.
 */
const PEERS = [
  {
    packageName: "@anthropic-ai/sdk",
    importLine: 'import type { Message } from "@anthropic-ai/sdk/resources/messages";',
    field: 'Message["content"]',
    upstreamType: "ContentBlock",
  },
  {
    packageName: "openai",
    importLine: 'import type { ChatCompletion } from "openai/resources/chat/completions";',
    field: 'ChatCompletion["choices"][number]["message"]',
    upstreamType: "ChatCompletionMessage",
  },
  {
    packageName: "@google/genai",
    importLine: 'import type { FunctionCall } from "@google/genai";',
    field: "FunctionCall",
    upstreamType: "FunctionCall",
  },
  {
    packageName: "ai",
    importLine: 'import type { ModelMessage } from "ai";',
    field: "ModelMessage",
    upstreamType: "ModelMessage",
  },
  {
    packageName: "parlant-client",
    importLine: 'import type { ParlantClient } from "parlant-client";',
    field: "ParlantClient",
    upstreamType: "ParlantClient",
  },
  {
    packageName: "@letta-ai/letta-client",
    importLine: 'import type { ClientOptions } from "@letta-ai/letta-client";',
    field: "ClientOptions",
    upstreamType: "ClientOptions",
  },
  {
    packageName: "@langchain/core",
    importLine: 'import type { StructuredToolInterface } from "@langchain/core/tools";',
    field: "StructuredToolInterface",
    upstreamType: "StructuredToolInterface",
  },
  {
    packageName: "@langchain/langgraph",
    importLine: 'import type { createReactAgent } from "@langchain/langgraph/prebuilt";',
    field: "Parameters<typeof createReactAgent>[0]",
    upstreamType: "CreateReactAgentParams",
  },
] as const;

// The fixture lives under the package's node_modules so module resolution finds the
// installed peers, without putting a stray directory in front of lint or typecheck.
let fixtureDir: string;

function compile(filename: string, code: string): { status: number; output: string } {
  writeFileSync(join(fixtureDir, filename), code);
  writeFileSync(
    join(fixtureDir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        module: "esnext",
        moduleResolution: "bundler",
        target: "es2022",
        esModuleInterop: true,
        noEmit: true,
        skipLibCheck: true,
        types: [],
      },
      include: [filename],
    }),
  );
  // Invoked through node rather than the .bin shim so it also runs on Windows.
  const result = spawnSync(
    process.execPath,
    [join(SDK_ROOT, "node_modules/typescript/bin/tsc"), "-p", join(fixtureDir, "tsconfig.json")],
    { encoding: "utf8" },
  );
  return { status: result.status ?? 1, output: (result.stdout ?? "") + (result.stderr ?? "") };
}

describe("optional peer imports resolve to the upstream declarations", () => {
  beforeAll(() => {
    fixtureDir = mkdtempSync(join(SDK_ROOT, "node_modules", ".peer-types-"));
  }, 60_000);

  afterAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it("a fixture using each peer's real types compiles", () => {
    const code = [
      ...PEERS.map((peer) => peer.importLine),
      ...PEERS.map((peer, index) => `export type Used${index} = ${peer.field};`),
    ].join("\n");

    const result = compile("good.ts", `${code}\n`);
    expect(result.status, result.output).toBe(0);
  }, 120_000);

  it("assigning a wrong value to each peer-typed field fails and names the upstream type", () => {
    const code = [
      ...PEERS.map((peer) => peer.importLine),
      ...PEERS.map((peer, index) => `export const wrong${index}: ${peer.field} = 1;`),
    ].join("\n");

    const result = compile("bad.ts", `${code}\n`);
    expect(result.status, "the peer types are erased -- an invalid value compiled").not.toBe(0);

    for (const peer of PEERS) {
      expect(
        result.output,
        `no diagnostic naming ${peer.upstreamType} for ${peer.packageName}`,
      ).toContain(peer.upstreamType);
    }
  }, 120_000);
});
