/**
 * Opaque custom tools: each returns a value the model cannot guess, so
 * answering the request requires calling it, with the argument the request
 * names. The adapter never forces tool use, so opacity is what makes "the tool
 * fired, with this argument" deterministic.
 */
import { z } from "zod";

import { SEND_MESSAGE_TOOL_NAME } from "../../../../src/runtime/tools/schemas";
import type { CustomToolDef } from "../../../../src/runtime/tools/customTools";
import type { AgentIdentity } from "../../toolkit/agents";
import { toolCalls } from "../../toolkit/observeMessages";
import type { PerAdapterOptions } from "../../toolkit/perAdapter";
import { CAPABILITY } from "../../toolkit/registry";
import type { Room } from "../../toolkit/rooms";

/** The keys the scenarios look up, one per turn or room. */
export const KEY = { alpha: "alpha", beta: "beta" } as const;

/** The place the scenarios ask a forecast for. */
export const PLACE = "Zorath";

const ACCESS_CODES: Record<string, string> = { [KEY.alpha]: "ZX417", [KEY.beta]: "QM920" };
const NO_SUCH_CODE = "NO-SUCH-CODE";
const FORECAST = "ammonia rain at 400 K";

/** The access code the lookup tool returns for `key`. */
export function codeFor(key: string): string {
  return ACCESS_CODES[key.toLowerCase()] ?? NO_SUCH_CODE;
}

const LOOKUP_ARGS = z.object({ key: z.string().describe("The project key") });

export const LOOKUP_TOOL: CustomToolDef = {
  name: "lookup_access_code",
  description: "Look up the secret access code for a project key. The codes cannot be guessed.",
  schema: LOOKUP_ARGS,
  handler: (args) => codeFor(String(args.key)),
};

const FORECAST_ARGS = z.object({ place: z.string().describe("The place to forecast") });

export const FORECAST_TOOL: CustomToolDef = {
  name: "get_forecast",
  description: "Get today's forecast for a place. The forecasts cannot be guessed.",
  schema: FORECAST_ARGS,
  handler: () => FORECAST,
};

export const LOOKUP_PROMPT =
  `You have a tool \`${LOOKUP_TOOL.name}\` that returns the secret access code for a key. ` +
  `You do NOT know these codes yourself, so you MUST call \`${LOOKUP_TOOL.name}\` to get one. ` +
  `Then report the code in one short sentence using ${SEND_MESSAGE_TOOL_NAME}.`;

export const LOOKUP_AND_FORECAST_PROMPT =
  `You have two tools: \`${LOOKUP_TOOL.name}\` (the secret access code for a key) and ` +
  `\`${FORECAST_TOOL.name}\` (the forecast for a place). You do NOT know these values yourself, ` +
  `so you MUST call the matching tool for each request. Then report both results using ${SEND_MESSAGE_TOOL_NAME}.`;

/** The user's request that drives one lookup of `key`. */
export function lookupRequest(key: string): string {
  return `look up the access code for key '${key}'`;
}

/** The user's request that drives a lookup of `key` and a forecast for `place`, in one turn. */
export function lookupAndForecastRequest(key: string, place: string): string {
  return `${lookupRequest(key)} and get the forecast for '${place}'`;
}

const withTools = (prompt: string, ...customTools: CustomToolDef[]): PerAdapterOptions => ({
  supports: [CAPABILITY.customTools],
  prompt,
  build: (spec, options) => spec.build({ ...options, customTools }),
});

/** Every adapter that takes custom tools, given the lookup tool and steered to it. */
export const WITH_LOOKUP = withTools(LOOKUP_PROMPT, LOOKUP_TOOL);

/** Every adapter that takes custom tools, given the lookup and forecast tools and steered to both. */
export const WITH_LOOKUP_AND_FORECAST = withTools(LOOKUP_AND_FORECAST_PROMPT, LOOKUP_TOOL, FORECAST_TOOL);

/** One stored lookup call: its event id and the key it looked up. */
export interface LookupCall {
  id: string;
  key: string;
}

/** Every lookup `sender` made in `room`, oldest first. Read only after `untilProcessed`. */
export async function lookupCalls(room: Room, sender: AgentIdentity): Promise<LookupCall[]> {
  const calls = await toolCalls(room, sender);
  return calls.filter((call) => call.name === LOOKUP_TOOL.name).map((call) => ({ id: call.id, key: String(call.args.key) }));
}
