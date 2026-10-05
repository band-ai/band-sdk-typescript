import { loadAgentConfigFromEnv } from "@band-ai/sdk/config";
import { StderrLogger } from "@band-ai/sdk/core";

import { EXIT_FAILED, runChannel } from "./channel";

/** An exact prefix: the user's own BAND_* and THENVOI_* variables never reach the plugin. */
const ENV_PREFIX = "BAND_CHANNEL_";

// stdout is the MCP pipe, so everything else goes to stderr.
const logger = new StderrLogger();

async function run(): Promise<number> {
  try {
    return await runChannel({ credentials: loadAgentConfigFromEnv({ prefix: ENV_PREFIX }), logger });
  } catch (error) {
    logger.error("Band channel failed to start", { error });
    return EXIT_FAILED;
  }
}

const exitCode = await run();
// Exit rather than wait on stdio handles, once stderr (asynchronous on a macOS pipe) has flushed the last log line.
process.stderr.write("", () => process.exit(exitCode));
