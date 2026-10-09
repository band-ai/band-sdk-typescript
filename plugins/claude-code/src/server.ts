import { StderrLogger } from "@band-ai/sdk/core";

import { runChannel } from "./channel";
import { processArgs } from "./processes";

// stdout is the MCP pipe, so everything else goes to stderr.
const logger = new StderrLogger();

// Claude Code stops its servers with SIGINT, then SIGTERM: either ends the session cleanly instead of killing the process.
const STOP_SIGNALS = ["SIGINT", "SIGTERM"] as const;
const interrupted = new Promise<void>((resolve) => {
  for (const signal of STOP_SIGNALS) {
    process.once(signal, () => {
      resolve();
    });
  }
});

const exitCode = await runChannel({ parentArgs: processArgs(process.ppid), env: process.env, interrupted, logger });
// Exit rather than wait on stdio handles, once stderr (asynchronous on a macOS pipe) has flushed the last log line.
process.stderr.write("", () => process.exit(exitCode));
