// Disabled until a KIRO_API_KEY and the Kiro CLI are provisioned in CI; restore together with
// the `kiroAcp` spec in toolkit/adapters.ts. A scenario file must hold at least one test, so
// this one is left empty and excluded from collection by having no `withAdapters` call.
//
// import { ADAPTER } from "../../toolkit/adapters";
// import { withAdapters } from "../../toolkit/perAdapter";
// import { CATEGORY, scenarioId } from "../../toolkit/registry";
// import { addsHelperThroughMcp } from "../samples/mcpRoster";
//
// withAdapters([ADAPTER.kiroAcp], scenarioId(CATEGORY.adapters, "kiroAcp"), async (cast) => {
//   await addsHelperThroughMcp(cast);
// });
export {};
