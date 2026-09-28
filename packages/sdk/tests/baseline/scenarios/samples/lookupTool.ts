/**
 * An opaque custom tool: it returns a secret access code the model cannot
 * guess, so answering the request requires calling it, with the key as its
 * argument. The adapter never forces tool use, so opacity is what makes
 * "the tool fired, with this key" deterministic.
 */
import { z } from "zod";

import { parseToolCall } from "../../../../src/converters/shared";
import { SEND_MESSAGE_TOOL_NAME } from "../../../../src/runtime/tools/schemas";
import type { CustomToolDef } from "../../../../src/runtime/tools/customTools";
import type { AgentIdentity } from "../../toolkit/agents";
import { MESSAGE_TYPE, observeRoom } from "../../toolkit/observeMessages";
import type { Room } from "../../toolkit/rooms";

/** The keys the scenarios look up, one per turn or room. */
export const KEY = { alpha: "alpha", beta: "beta" } as const;

const ACCESS_CODES: Record<string, string> = { [KEY.alpha]: "ZX417", [KEY.beta]: "QM920" };
const NO_SUCH_CODE = "NO-SUCH-CODE";

const LOOKUP_ARGS = z.object({ key: z.string().describe("The project key") });

type LookupArgs = z.infer<typeof LOOKUP_ARGS>;

export const LOOKUP_TOOL: CustomToolDef = {
  name: "lookup_access_code",
  description: "Look up the secret access code for a project key. The codes cannot be guessed.",
  schema: LOOKUP_ARGS,
  handler: (args) => ACCESS_CODES[(args as LookupArgs).key.toLowerCase()] ?? NO_SUCH_CODE,
};

export const LOOKUP_PROMPT =
  `You have a tool \`${LOOKUP_TOOL.name}\` that returns the secret access code for a key. ` +
  `You do NOT know these codes yourself, so you MUST call \`${LOOKUP_TOOL.name}\` to get one. ` +
  `Then report the code in one short sentence using ${SEND_MESSAGE_TOOL_NAME}.`;

/** The user's request that drives one lookup of `key`. */
export function lookupRequest(key: string): string {
  return `look up the access code for key '${key}'`;
}

/** A lookup `sender` made in `room`, read from the room's stored tool-call events. */
export interface LookupCall {
  id: string;
  key: string;
}

/** Every lookup `sender` made in `room`, oldest first. Read only after `untilProcessed`. */
export async function lookupCalls(room: Room, sender: AgentIdentity): Promise<LookupCall[]> {
  const events = (await observeRoom(room).history(MESSAGE_TYPE.ToolCall)).filter((event) => event.senderId === sender.id);
  return events.flatMap((event) => {
    const call = parseToolCall(event.content);
    return call?.name === LOOKUP_TOOL.name ? [{ id: event.id, key: String((call.args as Partial<LookupArgs>).key) }] : [];
  });
}
