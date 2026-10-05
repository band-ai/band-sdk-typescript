/** Which saved agent a session connects as, and with which credentials. */
import { describe, expect } from "vitest";

import { selectAgent, WS_URL_ENV, writeSavedAgents } from "../../src/config";
import { withDirs as it } from "../support/claudeCodeDirs";

const SESSION = "session-1";
const MAIN = { agentId: "agent-main", apiKey: "key-main", handle: "alex/main" };
const DOCS = { agentId: "agent-docs", apiKey: "key-docs", handle: "alex/docs" };
const STAGING = "wss://staging.band.ai/api/v1/socket";

describe("the agent a session connects as", () => {
  it("is the only one saved when the project names none", ({ dirs }) => {
    writeSavedAgents(dirs.dataDir, { main: MAIN });

    expect(selectAgent(dirs.env(SESSION))).toEqual({ name: "main", credentials: { agentId: "agent-main", apiKey: "key-main" } });
  });

  it("is the saved agent the project names, on the Band the plugin is set to", ({ dirs }) => {
    writeSavedAgents(dirs.dataDir, { main: MAIN, docs: DOCS });

    expect(selectAgent({ ...dirs.env(SESSION, "docs"), [WS_URL_ENV]: STAGING })).toEqual({
      name: "docs",
      credentials: { agentId: "agent-docs", apiKey: "key-docs", wsUrl: STAGING },
    });
  });

  it("is on app.band.ai when the plugin's URL setting is left unset", ({ dirs }) => {
    writeSavedAgents(dirs.dataDir, { main: MAIN });

    // Claude Code passes an unset setting through as its placeholder.
    expect(selectAgent({ ...dirs.env(SESSION), [WS_URL_ENV]: "${user_config.ws_url}" }).credentials).not.toHaveProperty("wsUrl");
  });

  it("is none before any agent is saved, pointing at /band:agents", ({ dirs }) => {
    expect(() => selectAgent(dirs.env(SESSION))).toThrow("No Band agent is saved yet: add one with /band:agents.");
  });

  it("is none when several are saved and the project picks none", ({ dirs }) => {
    writeSavedAgents(dirs.dataDir, { main: MAIN, docs: DOCS });

    expect(() => selectAgent(dirs.env(SESSION))).toThrow("Band agents main, docs are saved, and this project picks none: pick one with /band:agents.");
  });

  it("fails naming every saved agent when the named one isn't saved", ({ dirs }) => {
    writeSavedAgents(dirs.dataDir, { docs: DOCS });

    expect(() => selectAgent(dirs.env(SESSION, "sdk"))).toThrow(
      'No Band agent named "sdk". Saved: docs. Add it with /band:agents add <agent_id> <api_key> sdk',
    );
  });

  it("fails for a name that is only a property every object has", ({ dirs }) => {
    writeSavedAgents(dirs.dataDir, { docs: DOCS });

    expect(() => selectAgent(dirs.env(SESSION, "toString"))).toThrow('No Band agent named "toString".');
  });
});
