/**
 * Memory scenario pieces: the tools' names, the requests that drive each
 * operation, and the two ways to read the outcome. The call layer is what the
 * agent asked for, read from its stored tool-call events; the store layer is
 * what the platform kept, read as the agent's own REST identity.
 */
import { Band } from "@band-ai/rest-client";
import { expect } from "vitest";
import { z } from "zod";

import type { ListMemoriesArgs, MemoryRecord, StoreMemoryArgs } from "../../../../src/contracts/dtos";
import { MEMORY_SEGMENT, MEMORY_STORE_SCOPE, MEMORY_SYSTEM, MEMORY_TYPE } from "../../../../src/contracts/memory";
import { MEMORY_TOOL_NAMES, type TOOL_MODELS } from "../../../../src/contracts/toolSchemas";
import type { AgentIdentity } from "../../toolkit/agents";
import { toolCalls, type ToolCallEvent } from "../../toolkit/observeMessages";
import type { PerAdapterOptions } from "../../toolkit/perAdapter";
import { CAPABILITY } from "../../toolkit/registry";
import type { Room } from "../../toolkit/rooms";
import { EXACT_TOOLS_PROMPT } from "./exactTools";

/** The memory tools' names, by what each does. */
export const MEMORY_TOOL = {
  store: "band_store_memory",
  list: "band_list_memories",
  get: "band_get_memory",
  supersede: "band_supersede_memory",
  archive: "band_archive_memory",
} as const satisfies Record<string, keyof typeof TOOL_MODELS>;

/** The `MemoryRecord` field the platform names when it rejects an organization-scoped request. */
export const ORGANIZATION_ID_FIELD = "organization_id" satisfies keyof MemoryRecord;

/** A persona that spells out no memory mechanics: how to scope and attribute a memory is left to the memory guidance. */
export const MEMORY_SECRETARY_PROMPT =
  "You are the user's personal secretary in a chat room. When the user shares something worth remembering, " +
  "save it with your memory tools so you can recall it later. Decide for yourself how to scope and attribute " +
  "each memory. Keep replies to one short sentence.";

const withMemory = (prompt: string): PerAdapterOptions => ({
  supports: [CAPABILITY.memory],
  prompt,
  build: (spec, options) => spec.build({ ...options, memory: true }),
});

/** Every adapter with memory tools, steered to make exactly the requested calls. */
export const WITH_MEMORY = withMemory(EXACT_TOOLS_PROMPT);

/** Every adapter with memory tools, as a secretary who decides for itself how to store. */
export const WITH_MEMORY_SECRETARY = withMemory(MEMORY_SECRETARY_PROMPT);

type StoreFields = Partial<Pick<StoreMemoryArgs, "system" | "type" | "segment" | "scope" | "subject_id">>;

/** A private, long-term, semantic note: the fields a scenario checks of one, in its store call and once stored. */
export const NOTE = {
  system: MEMORY_SYSTEM.long_term,
  type: MEMORY_TYPE.semantic,
  scope: MEMORY_STORE_SCOPE.agent,
} as const satisfies StoreFields;

/** What a request spells out for a note: `NOTE`, plus its segment. */
const NOTE_REQUEST = { ...NOTE, segment: MEMORY_SEGMENT.user } as const satisfies StoreFields;

/** The store call a request spells out: content carrying `marker`, the given `fields`, and a thought. */
function storeCall(marker: string, fields: StoreFields): string {
  const spelled = Object.entries(fields).map(([name, value]) => `${name}=${value}`).join(", ");
  return `${MEMORY_TOOL.store} with content including the exact token ${marker}, ${spelled}, and a brief thought`;
}

const NOTHING_ELSE = "Do not call any other tool.";

export function storeRequest(marker: string): string {
  return `Call ${storeCall(marker, NOTE_REQUEST)}, exactly once, without a subject_id. ${NOTHING_ELSE}`;
}

export function storeSubjectRequest(marker: string, subjectId: string): string {
  const about = { ...NOTE_REQUEST, segment: MEMORY_SEGMENT.agent, scope: MEMORY_STORE_SCOPE.subject, subject_id: subjectId };
  return `Call ${storeCall(marker, about)}, exactly once. ${NOTHING_ELSE}`;
}

/** A request that names neither the scope nor the subject: both are left for the agent to infer. */
export function inferredSubjectRequest(marker: string): string {
  return `Please remember this about me personally so you can recall it later: my project code phrase is ${marker}.`;
}

/** Stores a note, then applies `followUp` to the id the store call returns. */
function storeThen(marker: string, followUp: string): string {
  return `First call ${storeCall(marker, NOTE_REQUEST)}. Then ${followUp} ${NOTHING_ELSE}`;
}

const withStoredId = (tool: string) => `call ${tool} with memory_id set to the id returned by the store call.`;

export const storeThenSupersedeRequest = (marker: string) => storeThen(marker, withStoredId(MEMORY_TOOL.supersede));

export const storeThenArchiveRequest = (marker: string) => storeThen(marker, withStoredId(MEMORY_TOOL.archive));

export function storeListGetRequest(marker: string): string {
  return storeThen(
    marker,
    `call ${MEMORY_TOOL.list} with content_query=${marker} to find it. ` +
      `Then call ${MEMORY_TOOL.get} with memory_id set to the id of a memory the list returned.`,
  );
}

/** Two private notes under one marker, one per memory tier, so a single read returns both. */
export function storeTwoTiersRequest(marker: string): string {
  const tier = (system: string, type: string) => `system=${system}, type=${type}`;
  return (
    `Call ${MEMORY_TOOL.store} twice, both with content including the exact token ${marker} and a brief thought, ` +
    `both segment=${MEMORY_SEGMENT.user}, scope=${MEMORY_STORE_SCOPE.agent}. ` +
    `First store: ${tier(MEMORY_SYSTEM.long_term, MEMORY_TYPE.semantic)}. ` +
    `Second store: ${tier(MEMORY_SYSTEM.working, MEMORY_TYPE.episodic)}. ${NOTHING_ELSE}`
  );
}

/** Every memory-tool call `agent` made in `room`, oldest first. Read only after `untilProcessed`. */
export async function memoryCalls(room: Room, agent: AgentIdentity): Promise<ToolCallEvent[]> {
  const calls = await toolCalls(room, agent, { includeMemory: true });
  return calls.filter((call) => MEMORY_TOOL_NAMES.has(call.name));
}

/** The memories the platform holds for `agent` under `filter`, as the agent itself reads them. */
export async function storedMemories(agent: AgentIdentity, filter: ListMemoriesArgs): Promise<MemoryRecord[]> {
  const { data } = await agent.rest.listMemories(filter);
  return data;
}

/** A stored memory whose content carries `marker` and whose fields include `fields`. */
export const memoryLike = (marker: string, fields: Partial<MemoryRecord> = {}) =>
  expect.objectContaining({ ...fields, content: expect.stringContaining(marker) });

/** `details`, keyed by field, comes with a rejected store but not with a rejected list. */
const REJECTION_BODY = z.object({
  error: z.object({ code: z.string(), details: z.record(z.string(), z.unknown()).optional() }),
});

/** The `{ error: { code, details } }` body of a 422 the platform rejected a request with. */
export function rejection(error: unknown): z.infer<typeof REJECTION_BODY> {
  if (!(error instanceof Band.UnprocessableEntityError)) {
    throw new Error(`expected the request to be rejected with a 422, but it ended in: ${String(error)}`);
  }
  return REJECTION_BODY.parse(error.body);
}
