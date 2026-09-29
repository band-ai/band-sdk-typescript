/**
 * The events an agent emits by calling the send-event tool, and the requests
 * that drive it to emit exactly those.
 */
import type { ChatEventType } from "../../../../src/contracts/chatEvents";
import { SEND_EVENT_TOOL_NAME } from "../../../../src/runtime/tools/schemas";
import { MESSAGE_TYPE } from "../../toolkit/observeMessages";

/** The event types a request can drive; `tool_call` and `tool_result` are the adapter's own reports. */
export const EMITTED_EVENT_TYPES = [MESSAGE_TYPE.Thought, MESSAGE_TYPE.Error, MESSAGE_TYPE.Task] as const satisfies readonly ChatEventType[];

export type EmittedEventType = (typeof EMITTED_EVENT_TYPES)[number];

export interface Emission {
  type: EmittedEventType;
  marker: string;
}

/** The request that has the agent send one event per emission, each carrying its marker, and do nothing else. */
export function emitEventsRequest(emissions: readonly Emission[]): string {
  const calls = emissions
    .map(({ type, marker }, index) => `(${index + 1}) message_type='${type}' with content that includes the exact token ${marker}, verbatim`)
    .join("; ");
  return (
    `Call the tool ${SEND_EVENT_TOOL_NAME} once for each of these: ${calls}. ` +
    `Those tool calls are your ONLY action -- do not reply with a chat message and do not call any other tool. ` +
    `A plain-text reply does not satisfy this; you must call ${SEND_EVENT_TOOL_NAME}.`
  );
}

/** The request that has the agent send one `type` event carrying `marker`. */
export function emitEventRequest(type: EmittedEventType, marker: string): string {
  return emitEventsRequest([{ type, marker }]);
}

/** The request that has the agent send one thought per marker. */
export function emitThoughtsRequest(markers: readonly string[]): string {
  return emitEventsRequest(markers.map((marker) => ({ type: MESSAGE_TYPE.Thought, marker })));
}
