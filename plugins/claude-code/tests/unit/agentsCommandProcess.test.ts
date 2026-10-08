import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { agentsCommandAt } from "../support/agentsCommand";

it("keeps the add command's API key out of failed process diagnostics while retaining the error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "band-command-error-"));
  try {
    const cli = join(dir, "agents.mjs");
    await writeFile(cli, 'process.stderr.write(`rejected ${process.argv[4]}`); process.exitCode = 1;');
    const secret = "fixture-secret-without-provider-prefix";
    const error = await agentsCommandAt(cli, ["add", "agent-id", secret]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("Band agents command failed (1): rejected");
    expect(String(error)).not.toContain(secret);
    expect((error as Error).stack).not.toContain(secret);
    expect((error as Error).cause).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
