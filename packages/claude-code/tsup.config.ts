import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "esbuild";
import { defineConfig } from "tsup";

/**
 * Resolve the SDK package.json from the workspace.
 * In a pnpm workspace, the SDK is linked via node_modules/@band-ai/sdk.
 */
function loadSdkPackageJson(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync("node_modules/@band-ai/sdk/package.json", "utf-8"));
  } catch {
    // Fallback: read directly from the workspace sibling
    return JSON.parse(readFileSync("../sdk/package.json", "utf-8"));
  }
}

const sdkPkg = loadSdkPackageJson();
const sdkPeerMeta: Record<string, { optional?: boolean }> =
  (sdkPkg.peerDependenciesMeta as Record<string, { optional?: boolean }>) ?? {};
// @modelcontextprotocol/sdk is a real dependency of this plugin (there is no
// host process to provide it, unlike OpenClaw's channel-plugin host) — it
// must be bundled, not stubbed out like the SDK's other optional peers.
const sdkOptionalPeers = Object.keys(sdkPeerMeta).filter(
  (dep) => sdkPeerMeta[dep].optional && dep !== "@modelcontextprotocol/sdk",
);

/**
 * Scan the SDK's compiled ESM files to discover which named exports each
 * optional peer dependency needs. esbuild validates static named imports at
 * build time, so our stub modules must re-export matching names.
 */
function discoverNamedImports(peers: string[]): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();

  // Try workspace-linked path first, then sibling path
  let sdkDistDir = "node_modules/@band-ai/sdk/dist";
  try {
    readdirSync(sdkDistDir);
  } catch {
    sdkDistDir = "../sdk/dist";
  }

  const importPattern =
    /import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']\s*;?/g;

  const peerSet = new Set(peers);
  function matchingPeer(specifier: string): string | undefined {
    if (peerSet.has(specifier)) return specifier;
    for (const peer of peers) {
      if (specifier.startsWith(peer + "/")) return specifier;
    }
    return undefined;
  }

  let files: string[];
  try {
    files = readdirSync(sdkDistDir).filter((f) => f.endsWith(".js"));
  } catch {
    return result;
  }

  for (const file of files) {
    const content = readFileSync(join(sdkDistDir, file), "utf-8");
    let match: RegExpExecArray | null;
    while ((match = importPattern.exec(content)) !== null) {
      const names = match[1];
      const specifier = match[2];
      const key = matchingPeer(specifier);
      if (!key) continue;
      const set = result.get(key) ?? new Set<string>();
      for (const part of names.split(",")) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const asMatch = trimmed.match(/^(\S+)\s+as\s+/);
        set.add(asMatch ? asMatch[1] : trimmed);
      }
      result.set(key, set);
    }
  }

  return result;
}

const namedImportsPerPeer = discoverNamedImports(sdkOptionalPeers);

if (sdkOptionalPeers.length > 0 && namedImportsPerPeer.size === 0) {
  throw new Error(
    `[tsup] Found ${sdkOptionalPeers.length} optional peers but discovered zero named imports. ` +
    "The SDK must be built before building the plugin. Run: pnpm --filter @band-ai/sdk build",
  );
}

/**
 * esbuild plugin that replaces SDK optional peer dep imports with empty
 * modules — every optional peer EXCEPT @modelcontextprotocol/sdk, which this
 * plugin actually needs bundled (see sdkOptionalPeers above).
 *
 * The SDK's barrel export pulls in adapter code (Claude Agent SDK, LangChain,
 * A2A, etc.) that this plugin never uses. Without this plugin those imports
 * would remain as external `import from "…"` statements and fail at runtime
 * wherever those packages aren't installed.
 */
function stubOptionalPeers(peers: string[]): Plugin {
  return {
    name: "stub-optional-peers",
    setup(build) {
      const filter = new RegExp(
        "^(" + peers.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")(/.*)?$"
      );
      build.onResolve({ filter }, (args) => ({
        path: args.path,
        namespace: "stub-optional-peer",
      }));
      build.onLoad({ filter: /.*/, namespace: "stub-optional-peer" }, (args) => {
        const names = namedImportsPerPeer.get(args.path);
        if (names && names.size > 0) {
          const stubs = [...names]
            .map((n) => `export const ${n} = undefined;`)
            .join("\n");
          return { contents: stubs, loader: "js" };
        }
        return { contents: "export {};", loader: "js" };
      });
    },
  };
}

export default defineConfig({
  entry: ["src/server.ts"],
  format: ["esm"],
  sourcemap: true,
  clean: true,
  shims: true,
  target: "node22",
  outDir: "dist",
  // node:sqlite has no bare-specifier alias, unlike older Node built-ins.
  removeNodeProtocol: false,
  // ESM output bundles CJS deps (phoenix/ws) that call require("events") etc.
  // Provide a real require via createRequire so esbuild's __require shim resolves
  // node built-ins at runtime instead of throwing "Dynamic require ... not supported".
  banner: {
    js: "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);",
  },
  // No host process provides anything here — this is a standalone stdio MCP
  // server Claude Code spawns directly, so everything it needs is bundled.
  noExternal: [
    "phoenix",
    "@band-ai/sdk",
    "@band-ai/rest-client",
    "@modelcontextprotocol/sdk",
    "zod",
    "ws",
    "js-yaml",
  ],
  esbuildPlugins: [stubOptionalPeers(sdkOptionalPeers)],
  // tsup clean:true wipes dist/ on every build/watch rebuild; copy the wasm the
  // inlined band-sdk-core glue expects beside the emitted JS (build and dev).
  async onSuccess() {
    try {
      const { copyWasm } = await import("./scripts/copy-wasm.mjs");
      copyWasm();
    } catch (error) {
      // clean:true already wiped any prior wasm; do not leave JS-only dist for watch.
      console.error("[copy-wasm] failed to restore band_sdk_core_bg.wasm after build:", error);
      process.exit(1);
    }
  },
});
