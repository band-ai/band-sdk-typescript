// Stands in for a stdio plugin whose host has exited: once stdin ends it tears
// down, logging every level through StderrLogger into a stderr nobody reads any
// more, then reports on stdout that teardown finished.
import { StderrLogger } from "../../src/core/logger";

export const TEARDOWN_DONE = "teardown done";

/** Resolves once stderr has finished every write queued so far, which on a closed pipe means it has failed it. */
function stderrFlushed(): Promise<void> {
  return new Promise((resolve) => process.stderr.write("", () => resolve()));
}

async function tearDown(): Promise<void> {
  const logger = new StderrLogger();
  for (const level of ["debug", "info", "warn", "error"] as const) {
    logger[level]("tearing down", { level });
    await stderrFlushed();
  }
  process.stdout.write(`${TEARDOWN_DONE}\n`);
}

if (process.argv[1] === import.meta.filename) {
  process.stdin.on("end", () => void tearDown());
  process.stdin.resume();
}
