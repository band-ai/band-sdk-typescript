import { StderrLogger } from "@band-ai/sdk/core";

import { EXIT_FAILED, runChannel } from "./channel";
import { AGENT_SELECT_ENV, selectAgent, type SelectedAgent } from "./config";
import { SessionStatusFile } from "./sessions";

// stdout is the MCP pipe, so everything else goes to stderr.
const logger = new StderrLogger();

async function run(): Promise<number> {
  let agent: SelectedAgent;
  try {
    agent = selectAgent(process.env);
  } catch (error) {
    SessionStatusFile.open(process.env, process.env[AGENT_SELECT_ENV] || null, logger)?.failed(error);
    logger.error("Band channel has no agent to connect as", { error });
    return EXIT_FAILED;
  }
  const status = SessionStatusFile.open(process.env, agent.name, logger);
  return runChannel({ agentName: agent.name, credentials: agent.credentials, status, logger });
}

const exitCode = await run();
// Exit rather than wait on stdio handles, once stderr (asynchronous on a macOS pipe) has flushed the last log line.
process.stderr.write("", () => process.exit(exitCode));
