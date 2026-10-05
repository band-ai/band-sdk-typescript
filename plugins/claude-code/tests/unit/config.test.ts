/** Which agent a session connects as, and with which credentials. */
import { describe, expect } from "vitest";

import { agentCredentials, ENV_PREFIX, selectedAgentName, writeSavedAgents } from "../../src/config";
import { withDirs as it } from "../support/claudeCodeDirs";

const SESSION = "session-1";
const USER_CONFIG = { [`${ENV_PREFIX}AGENT_ID`]: "agent-main", [`${ENV_PREFIX}API_KEY`]: "key-main" };
const DOCS = { agentId: "agent-docs", apiKey: "key-docs", wsUrl: "wss://staging.band.ai/api/v1/socket", handle: "alex/docs" };

function credentialsFor(env: Record<string, string>) {
  return agentCredentials(selectedAgentName(env), env);
}

describe("the agent a session connects as", () => {
  it("is the plugin's configured agent when none is named", ({ dirs }) => {
    expect(credentialsFor({ ...dirs.env(SESSION), ...USER_CONFIG })).toEqual({ agentId: "agent-main", apiKey: "key-main" });
  });

  it("is the plugin's configured agent when the default is named", ({ dirs }) => {
    writeSavedAgents(dirs.dataDir, { docs: DOCS });

    expect(credentialsFor({ ...dirs.env(SESSION, "default"), ...USER_CONFIG })).toEqual({ agentId: "agent-main", apiKey: "key-main" });
  });

  it("is the saved agent the session names", ({ dirs }) => {
    writeSavedAgents(dirs.dataDir, { docs: DOCS });

    expect(credentialsFor({ ...dirs.env(SESSION, "docs"), ...USER_CONFIG })).toEqual({
      agentId: "agent-docs",
      apiKey: "key-docs",
      wsUrl: "wss://staging.band.ai/api/v1/socket",
    });
  });

  it("fails naming every agent when the named one isn't saved", ({ dirs }) => {
    writeSavedAgents(dirs.dataDir, { docs: DOCS });

    expect(() => credentialsFor(dirs.env(SESSION, "sdk"))).toThrow(
      'No Band agent named "sdk". Agents: default, docs. Add it with /band:agents add <agent_id> <api_key> sdk',
    );
  });

  it("fails for a name that is only a property every object has", ({ dirs }) => {
    writeSavedAgents(dirs.dataDir, { docs: DOCS });

    expect(() => credentialsFor(dirs.env(SESSION, "toString"))).toThrow('No Band agent named "toString".');
  });

  it("fails the same way before any agent is saved", ({ dirs }) => {
    expect(() => credentialsFor(dirs.env(SESSION, "docs"))).toThrow('No Band agent named "docs". Agents: default.');
  });
});
