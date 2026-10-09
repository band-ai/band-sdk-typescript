/** Reading another process's command line, as the channel check reads Claude Code's. */
import { spawn } from "node:child_process";
import { once } from "node:events";

import { expect, it, vi } from "vitest";

import { commandLine } from "../../src/processes";

// Longer than any terminal: Linux `ps` cuts its output to $COLUMNS unless told not to.
const LONG_PATH = `/opt/${"node_modules/".repeat(30)}cli.js`;
const BAND_FLAG = "--channels plugin:band@band-ai";

it("reads a command line longer than the terminal whole, even with COLUMNS set", async () => {
  vi.stubEnv("COLUMNS", "80");
  // Waits on its stdin, so it lives until the test closes it.
  const child = spawn(process.execPath, ["-e", "process.stdin.resume()", LONG_PATH, ...BAND_FLAG.split(" ")]);
  try {
    expect(commandLine(child.pid!)).toContain(`${LONG_PATH} ${BAND_FLAG}`);
  } finally {
    vi.unstubAllEnvs();
    child.stdin.end();
    await once(child, "exit");
  }
});
