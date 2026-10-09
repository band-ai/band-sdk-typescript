/** Exercise exactly what npm ships, without workspace dependencies or provider credentials. */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
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
  const cli = join(isolated, "dist/agents.js");
  const context = ["--data-dir", dataDir];
  // No NODE_PATH or provider environment may rescue an accidental bundled peer import.
  const env = { PATH: process.env.PATH };
  const agents = (...args: string[]): Promise<string> => agentsCommandAt(cli, [...context, ...args], env);

  assert.match(await agents("status", "fixture-session"), /No Band server runs in this session/);

  await using band = await BandRestPeer.start([
    { id: "agent-fixture", apiKey: "fixture-key", name: "Fixture", handle: "fixture/docs" },
  ]);
  assert.match(await agents("add", "agent-fixture", "fixture-key", "docs", "--ws-url", band.wsUrl), /Saved docs \(@fixture\/docs\)/);
  assert.match(await agents("remove", "docs"), /Removed "docs"/);

  // Started without Band's channel, the server stays up, off, until Claude Code's end of the pipe closes.
  const server = spawn(process.execPath, [join(isolated, "dist/server.js")], { cwd: isolated, env: { ...env, CLAUDE_PLUGIN_DATA: dataDir } });
  let stderr = "";
  server.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  server.stdin.end();
  const [code] = await once(server, "exit");
  assert.equal(code, 0, stderr);
  assert.doesNotMatch(stderr, /ERR_MODULE_NOT_FOUND|Cannot find (?:package|module)/);
  process.stdout.write("Shipped plugin: isolated agents lifecycle and channel-less server verified\n");
} finally {
  await rm(isolated, { recursive: true, force: true });
}
