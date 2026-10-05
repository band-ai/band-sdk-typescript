/**
 * The packages this repo releases, in publish order — the one list every
 * release script and workflow step reads.
 *
 * - `key`: the `recover-package` choice in release.yml.
 * - `path`: the package's key in release-please-config.json and
 *   .release-please-manifest.json, and the prefix of its Release Please action
 *   outputs (`<path>--release_created`, `<path>--version`).
 * - `versionFiles`: files whose `version` must move with the manifest version.
 * - `contents`: the npm packlist floor and entries checked before packing.
 */
import { CORE_WASM_FILENAME } from "./copy-wasm.mjs";

export const RELEASE_PACKAGES = [
  {
    key: "sdk",
    path: "packages/sdk",
    name: "@band-ai/sdk",
    versionFiles: ["package.json"],
    contents: {
      minFiles: 75,
      required: ["dist/index.js", "dist/index.d.ts", "README.md", "package.json"],
    },
  },
  {
    key: "openclaw",
    path: "plugins/openclaw",
    name: "@band-ai/openclaw-channel-band",
    versionFiles: ["package.json", "openclaw.plugin.json"],
    contents: {
      minFiles: 55,
      required: [
        "dist/index.js",
        "dist/index.d.ts",
        `dist/${CORE_WASM_FILENAME}`,
        "openclaw.plugin.json",
        "package.json",
      ],
    },
  },
  {
    key: "claude-code",
    path: "plugins/claude-code",
    name: "@band-ai/claude-code-plugin",
    versionFiles: ["package.json", ".claude-plugin/plugin.json"],
    contents: {
      minFiles: 6,
      required: [
        "dist/server.js",
        `dist/${CORE_WASM_FILENAME}`,
        ".claude-plugin/plugin.json",
        ".mcp.json",
        "package.json",
      ],
    },
  },
];

export const STABLE_SEMANTIC_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function releasePackage(key) {
  const match = RELEASE_PACKAGES.find((candidate) => candidate.key === key);
  if (!match) {
    const keys = RELEASE_PACKAGES.map((candidate) => `"${candidate.key}"`).join(", ");
    throw new Error(`release package must be one of ${keys}, got "${key}"`);
  }
  return match;
}

/** Release Please's node strategy tags a package with its unscoped name. */
export function releaseTag(pkg, version) {
  return `${pkg.name.replace(/^@[^/]+\//, "")}-v${version}`;
}

/** The file name `npm pack` gives this package version. */
export function tarballName(pkg, version) {
  return `${pkg.name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
}
