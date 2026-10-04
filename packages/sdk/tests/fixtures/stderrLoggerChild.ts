// Stands in for a stdio plugin whose host has exited: once stdin ends it tears
// down, logging every level through StderrLogger into a stderr nobody reads any
// more, then reports on stdout that teardown finished.
import { setTimeout as sleep } from "node:timers/promises";

import { StderrLogger } from "../../src/core/logger";

export const TEARDOWN_DONE = "teardown done";
// Long enough for the closed pipe to fail a write before the next one.
const LOG_INTERVAL_MS = 20;

async function tearDown(): Promise<void> {
  const logger = new StderrLogger();
  for (const level of ["debug", "info", "warn", "error"] as const) {
    logger[level]("tearing down", { level });
    await sleep(LOG_INTERVAL_MS);
  }
  process.stdout.write(`${TEARDOWN_DONE}\n`);
}

if (process.argv[1] === import.meta.filename) {
  process.stdin.on("end", () => void tearDown());
  process.stdin.resume();
}
