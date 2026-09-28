import { withAdapters } from "../../toolkit/perAdapter";
import { addsHelperThroughMcp } from "../samples/mcpRoster";

withAdapters(["copilot-acp"], "adapters.copilotAcp", async (cast) => {
  await addsHelperThroughMcp(cast);
});
