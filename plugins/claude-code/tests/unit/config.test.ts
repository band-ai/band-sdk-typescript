/** The credentials a session connects to Band with as a saved agent. */
import { describe, expect, it } from "vitest";

import { agentCredentials, WS_URL_ENV } from "../../src/config";

const DOCS = { agentId: "agent-docs", apiKey: "key-docs", handle: "alex/docs" };
const STAGING = "wss://staging.band.ai/api/v1/socket";

describe("a saved agent's credentials", () => {
  it("are on the Band the plugin is set to", () => {
    expect(agentCredentials(DOCS, { [WS_URL_ENV]: STAGING })).toEqual({ agentId: "agent-docs", apiKey: "key-docs", wsUrl: STAGING });
  });

  it("are on app.band.ai when the plugin's URL setting is left unset", () => {
    // Claude Code passes an unset setting through as its placeholder.
    expect(agentCredentials(DOCS, { [WS_URL_ENV]: "${user_config.ws_url}" })).not.toHaveProperty("wsUrl");
  });
});
