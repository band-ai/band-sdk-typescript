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
 * CHANGELOG, `.agents/`, and the migration notes under `docs/migrations/`.
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, join, basename } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..", "..");

// The guard's own assertion literals reference the forbidden strings; exclude it.
const EXCLUDE_PATH = /(^|\/)(CHANGELOG|\.agents\/|docs\/migrations\/|c6-no-stale-live-thenvoi\.test\.ts)/;
const ALLOW_MARKER = /legacy|escape hatch|back-compat|deprecat|fallback/i;
const HOST = /thenvoi\.com/;
const DOC_ENV = /THENVOI_[A-Z]/;
const RETAINED_ENV = /LINEAR_THENVOI_|\.linear-thenvoi/;

function scopedFiles(): string[] {
  return execSync("git ls-files", { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\n")
    .filter((f) => f && !EXCLUDE_PATH.test(f));
}

interface Violation {
  file: string;
  line: number;
  text: string;
}

describe("C6 stale-live-text guard", () => {
  const files = scopedFiles();

  it("finds a non-trivial file scope (sanity)", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("uses no `thenvoi.com` service host without a legacy/escape-hatch label", () => {
    const violations: Violation[] = [];
    for (const file of files) {
      const lines = readFileSync(join(REPO_ROOT, file), "utf8").split("\n");
      lines.forEach((text, i) => {
        if (HOST.test(text) && !ALLOW_MARKER.test(text)) {
          violations.push({ file, line: i + 1, text: text.trim() });
        }
      });
    }
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it("presents no live `THENVOI_*` env instruction in user-facing docs", () => {
    const docFiles = files.filter(
      (f) => f.endsWith(".md") || basename(f) === ".env.local.example",
    );
    const violations: Violation[] = [];
    for (const file of docFiles) {
      const lines = readFileSync(join(REPO_ROOT, file), "utf8").split("\n");
      lines.forEach((text, i) => {
        if (DOC_ENV.test(text) && !ALLOW_MARKER.test(text) && !RETAINED_ENV.test(text)) {
          violations.push({ file, line: i + 1, text: text.trim() });
        }
      });
    }
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
      join(REPO_ROOT, "packages/openclaw/tests/e2e/setup.ts"),
      "utf8",
    );
    expect(setup).toContain("real Band environment");
    expect(setup).not.toContain("real Thenvoi environment");

    const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
    expect(readme.split("\n")[0]).toBe("# Band TypeScript SDK");
    expect(readme).not.toContain("platform.thenvoi.com");
  });
});
