/**
 * C6 stale-live-text guard.
 *
 * Fails when a stale Thenvoi *live instruction* regresses into published docs,
 * runtime/error text, examples, or operational setup:
 *   - the `thenvoi.com` service host used anywhere without a legacy/escape-hatch label
 *   - a `THENVOI_*` env variable presented as a live instruction in user-facing
 *     docs (markdown + the .env example) without a legacy label
 *
 * Out of scope by design: C7 tool/MCP names (`thenvoi_*`, the MCP server name),
 * retained physical identifiers (`LINEAR_THENVOI_*` env, `.linear-thenvoi-*`
 * files, `thenvoi_room_id`/`thenvoiRoomId`, `thenvoiRestUrl` metadata), the
 * CHANGELOG, `.agents/`, and the migration fixtures under `tests/fixtures/migrations/`.
 *
 * The guard reads the working tree (`git grep` without `--cached`), not the
 * git index: it judges the artifact as it stands in this checkout — what the
 * build publishes from it — never a staged copy the index may still hold of
 * an older one. A file the branch deletes is gone from the tree, and so from
 * the guard; and a `git grep` failure (exit 2) fails the guard, it is not
 * read as "no match".
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, join, basename } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..", "..");

// The guard's own assertion literals reference the forbidden strings; exclude it.
const EXCLUDE_PATH = /(^|\/)(CHANGELOG|\.agents\/|packages\/sdk\/tests\/fixtures\/migrations\/|c6-no-stale-live-thenvoi\.test\.ts)/;
const ALLOW_MARKER = /legacy|escape hatch|back-compat|deprecat|fallback/i;
const HOST = "thenvoi\\.com";
const DOC_ENV = "THENVOI_[A-Z]";
const RETAINED_ENV = /LINEAR_THENVOI_|\.linear-thenvoi/;

/** The tracked paths in scope, for the sanity check; the scans themselves read the working tree. */
function scopedFiles(): string[] {
  return execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\n")
    .filter((f) => f && !EXCLUDE_PATH.test(f));
}

type Hit = { file: string; line: number; text: string };

/** Every working-tree line `pattern` stands in, outside the guard's own excluded paths. */
function matchedLines(pattern: string): Hit[] {
  return scannedLines(pattern).filter((hit) => !EXCLUDE_PATH.test(hit.file));
}

/** Every working-tree line `pattern` stands in. No shell: the pattern reaches git as written. */
function scannedLines(pattern: string): Hit[] {
  let out: string;
  try {
    out = execFileSync("git", ["grep", "-I", "-n", "-e", pattern], { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (error) {
    // `git grep` exits 1 when nothing matches: that is the pass. Any other
    // exit status is an error the guard must not launder into an empty result.
    const status = (error as { status?: unknown })?.status;
    if (status === 1) return [];
    throw new Error(`git grep failed for pattern ${pattern} (exit ${String(status)}): ${error instanceof Error ? error.message : String(error)}`);
  }
  const hits: Hit[] = [];
  for (const record of out.split("\n")) {
    if (record === "") continue;
    const at = record.indexOf(":");
    const rest = record.indexOf(":", at + 1);
    if (at === -1 || rest === -1) continue;
    const file = record.slice(0, at);
    hits.push({ file, line: Number(record.slice(at + 1, rest)), text: record.slice(rest + 1) });
  }
  return hits;
}

describe("C6 stale-live-text guard", () => {
  const files = scopedFiles();

  it("finds a non-trivial file scope (sanity)", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("scans for both patterns (positive control: it finds this guard's own excluded lines)", () => {
    const self = "packages/sdk/tests/c6-no-stale-live-thenvoi.test.ts";
    expect(scannedLines(HOST).map((hit) => hit.file)).toContain(self);
    expect(scannedLines(DOC_ENV).map((hit) => hit.file)).toContain(self);
  });

  it("uses no `thenvoi.com` service host without a legacy/escape-hatch label", () => {
    const violations = matchedLines(HOST).filter((hit) => !ALLOW_MARKER.test(hit.text));
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it("presents no live `THENVOI_*` env instruction in user-facing docs", () => {
    const violations = matchedLines(DOC_ENV).filter(
      (hit) => (hit.file.endsWith(".md") || basename(hit.file) === ".env.local.example") && !ALLOW_MARKER.test(hit.text) && !RETAINED_ENV.test(hit.text),
    );
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it("names the flagged runtime/doc surfaces in Band terms", () => {
    const acp = readFileSync(
      join(REPO_ROOT, "packages/sdk/src/adapters/acp/ACPServer.ts"),
      "utf8",
    );
    // Default auth method authenticates with the Band env var (legacy noted, not the live instruction).
    expect(acp).toContain("Authenticate with BAND_API_KEY");
    expect(acp).not.toContain("Authenticate with THENVOI_API_KEY.");

    const setup = readFileSync(
      join(REPO_ROOT, "plugins/openclaw/tests/e2e/setup.ts"),
      "utf8",
    );
    expect(setup).toContain("real Band environment");
    expect(setup).not.toContain("real Thenvoi environment");

    expect(readFileSync(join(REPO_ROOT, "README.md"), "utf8").split(/\r?\n/)[0]).toBe("# Band TypeScript SDK");
    expect(readFileSync(join(REPO_ROOT, "README.md"), "utf8")).not.toContain("platform.thenvoi.com");
  });
});
