import { ADAPTER } from "../../toolkit/adapters";
import { withAdapters } from "../../toolkit/perAdapter";
import { CATEGORY, scenarioId } from "../../toolkit/registry";
import { addsHelperThroughMcp } from "../samples/mcpRoster";

withAdapters([ADAPTER.copilotAcp], scenarioId(CATEGORY.adapters, "copilotAcp"), async (cast) => {
  await addsHelperThroughMcp(cast);
});
