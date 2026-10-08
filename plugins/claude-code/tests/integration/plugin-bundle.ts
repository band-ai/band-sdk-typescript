/** Exercise exactly what npm ships, without workspace dependencies or provider credentials. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { BandRestPeer } from "../support/bandRestPeer";
import { agentsCommandAt } from "../support/agentsCommand";

const exec = promisify(execFile);
const pluginRoot = fileURLToPath(new URL("../..", import.meta.url));
const isolated = await mkdtemp(join(tmpdir(), "band-shipped-plugin-"));

try {
  const { stdout } = await exec("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: pluginRoot });
  const [packed] = JSON.parse(stdout) as [{ files: { path: string }[] }];
  for (const { path } of packed.files) {
    const target = join(isolated, path);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(pluginRoot, path), target);
  }

  const dataDir = join(isolated, "data");
  const projectDir = join(isolated, "project");
  const cli = join(isolated, "dist/agents.js");
  const context = ["--data-dir", dataDir, "--project-dir", projectDir];
  // No NODE_PATH or provider environment may rescue an accidental bundled peer import.
  const env = { PATH: process.env.PATH };
  const agents = (...args: string[]): Promise<string> => agentsCommandAt(cli, [...context, ...args], env);

  assert.match(await agents("status", "fixture-session"), /No agent saved yet/);

  await using band = await BandRestPeer.start([
    { id: "agent-fixture", apiKey: "fixture-key", name: "Fixture", handle: "fixture/docs" },
  ]);
  assert.match(await agents("add", "agent-fixture", "fixture-key", "docs", "--ws-url", band.wsUrl), /Saved "docs"/);
  assert.match(await agents("status", "fixture-session"), /docs\s+@fixture\/docs\s+free/);
  assert.match(await agents("use", "docs"), /This project now connects as "docs"/);
  const settings = JSON.parse(await readFile(join(projectDir, ".claude/settings.local.json"), "utf8")) as { env: { BAND_AGENT: string } };
  assert.equal(settings.env.BAND_AGENT, "docs");
  assert.match(await agents("remove", "docs"), /Removed "docs"/);
  assert.match(await agents("status", "fixture-session"), /No agent saved yet/);

  const server = await exec(process.execPath, [join(isolated, "dist/server.js")], {
    cwd: isolated,
    env: { ...env, CLAUDE_PLUGIN_DATA: join(isolated, "empty-data") },
    timeout: 10_000,
  }).then(
    () => { throw new Error("An unconfigured shipped server unexpectedly started"); },
    (error: { code: number; stderr: string }) => error,
  );
  assert.equal(server.code, 1);
  assert.match(server.stderr, /Band channel has no agent to connect as/);
  assert.match(server.stderr, /No Band agent is saved yet/);
  assert.doesNotMatch(server.stderr, /ERR_MODULE_NOT_FOUND|Cannot find (?:package|module)/);
  process.stdout.write("Shipped plugin: isolated agents lifecycle and unconfigured server verified\n");
} finally {
  await rm(isolated, { recursive: true, force: true });
}
