import { StderrLogger } from "@band-ai/sdk/core";

import { EXIT_FAILED, runChannel } from "./channel";
import { agentCredentials, selectedAgentName } from "./config";
import { SessionStatusFile } from "./sessions";

// stdout is the MCP pipe, so everything else goes to stderr.
const logger = new StderrLogger();

async function run(): Promise<number> {
  const agentName = selectedAgentName(process.env);
  const status = SessionStatusFile.open(process.env, agentName);
  try {
    return await runChannel({ agentName, credentials: agentCredentials(agentName, process.env), status, logger });
  } catch (error) {
    status?.failed(error);
    logger.error("Band channel failed to start", { error });
    return EXIT_FAILED;
  }
}

const exitCode = await run();
// Exit rather than wait on stdio handles, once stderr (asynchronous on a macOS pipe) has flushed the last log line.
process.stderr.write("", () => process.exit(exitCode));
