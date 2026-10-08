import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, it } from "vitest";

const execute = promisify(execFile);
const cli = join(dirname(fileURLToPath(import.meta.resolve("vitest/package.json"))), "vitest.mjs");
const support = fileURLToPath(new URL("./baseline/toolkit/", import.meta.url));

it("flushes sanitized evidence before timeout cleanup and before ordinary failure disposal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "band-evidence-fixture-"));
  try {
    const output = join(directory, "diagnostics");
    await writeFile(join(directory, "vitest.config.mts"), `export default {test:{root:${JSON.stringify(directory)},include:['*.test.ts'],maxWorkers:1}}`);
    await writeFile(join(directory, "capture.test.ts"), `
import { it, expect } from ${JSON.stringify(fileURLToPath(import.meta.resolve("vitest")))};
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { failureEvidence } from ${JSON.stringify(join(support, "failureEvidence.ts"))};
import { releasedWithTest } from ${JSON.stringify(join(support, "liveRun.ts"))};
const output = ${JSON.stringify(output)};
const resource = (name) => releasedWithTest({async [Symbol.asyncDispose]() {
  const files = await readdir(output);
  const evidence = await Promise.all(files.map(file => readFile(output+'/'+file,'utf8')));
  await writeFile(${JSON.stringify(directory)}+'/'+name+'.json', JSON.stringify(evidence));
}});
it('ordinary failure', async () => {
  await using acquired = resource('ordinary');
  const evidence = failureEvidence(async () => ({ request:'keep pineapple', apiKey:'private', result:'cannot_mention_self' }));
  await evidence.run(async () => { expect(false).toBe(true); });
});
it('timed out request', async () => {
  await using acquired = resource('timeout');
  const evidence = failureEvidence(async () => ({providerTrace:[{request:'in-flight request'}]}));
  await evidence.run(async () => { await new Promise(() => {}); });
}, 100);
`);
    const result = await execute(process.execPath, [cli, "run", "--config", join(directory, "vitest.config.mts")], {
      env: { ...process.env, BAND_E2E_DIAGNOSTICS_DIR: output }, timeout: 30_000,
    }).then(() => 0, (error: { code?: number; stderr?: string }) => {
      if (error.code !== 1) throw error;
      return error.code;
    });
    expect(result).toBe(1);
    const artifacts = await Promise.all((await readdir(output)).map((file) => readFile(join(output, file), "utf8")));
    expect(artifacts).toHaveLength(2);
    expect(artifacts.join("\n")).toContain("in-flight request");
    expect(artifacts.join("\n")).toContain("cannot_mention_self");
    expect(artifacts.join("\n")).not.toContain('"private"');
    expect(JSON.parse(await readFile(join(directory, "ordinary.json"), "utf8"))).toHaveLength(1);
    expect(JSON.parse(await readFile(join(directory, "timeout.json"), "utf8"))).toHaveLength(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 40_000);
