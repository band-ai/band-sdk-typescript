/** Reading another process's command line, as the channel check reads Claude Code's. */
import { spawn } from "node:child_process";
import { once } from "node:events";

import { expect, it, vi } from "vitest";

import { bandChannelOn } from "../../src/channelFlag";
import { processArgs } from "../../src/processes";

// Pin the full argv contract beyond the truncation limit of Linux ps.
const LONG_PATH = `/opt/${"node_modules/".repeat(30)}cli.js`;
const BAND_FLAG = "--channels plugin:band@band-ai";
const NATIVE_ARGS = process.platform === "linux" || process.platform === "darwin";

it("reads a command line longer than the terminal whole, even with COLUMNS set", async () => {
  vi.stubEnv("COLUMNS", "80");
  // Waits on its stdin, so it lives until the test closes it.
  const child = spawn(process.execPath, ["-e", "process.stdin.resume()", LONG_PATH, ...BAND_FLAG.split(" ")]);
  try {
    expect(processArgs(child.pid!)).toEqual(NATIVE_ARGS ? [process.execPath, "-e", "process.stdin.resume()", LONG_PATH, ...BAND_FLAG.split(" ")] : undefined);
  } finally {
    vi.unstubAllEnvs();
    child.stdin.end();
    await once(child, "exit");
  }
});

it.each([
  ["a prompt mentioning the channel option", ["Explain --channels plugin:band@band-ai"], false],
  ["an interactive prompt mentioning print mode", ["--dangerously-load-development-channels=plugin:band@band-ai", "Explain -p"], true],
  ["a required option value resembling the channel flag", ["--system-prompt", "--channels", "plugin:band@band-ai"], false],
  ["a required option value resembling print mode", ["--dangerously-load-development-channels=plugin:band@band-ai", "--append-system-prompt", "-p"], true],
] as const)("preserves argument boundaries for %s", async (_, args, expected) => {
  const child = spawn(process.execPath, ["-e", "process.stdin.resume()", "claude", ...args]);
  try {
    const command = processArgs(child.pid!);
    expect(command).toEqual(NATIVE_ARGS ? [process.execPath, "-e", "process.stdin.resume()", "claude", ...args] : undefined);
    expect(bandChannelOn(command, {})).toBe(NATIVE_ARGS ? expected : true);
  } finally {
    child.stdin.end();
    await once(child, "exit");
  }
});

it("uses the unreadable-parent fallback after the process has exited", async () => {
  const child = spawn(process.execPath, ["-e", ""]);
  await once(child, "exit");
  const args = processArgs(child.pid!);
  expect(args).toBeUndefined();
  expect(bandChannelOn(args, {})).toBe(true);
});
