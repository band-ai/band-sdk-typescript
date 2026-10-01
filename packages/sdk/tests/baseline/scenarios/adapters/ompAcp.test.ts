/**
 * OMP over ACP: an MCP roster change on one reused ACP session, and a
 * permission-gated delete that the client's resolver denies.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { PermissionOptionKind, RequestPermissionRequest, ToolKind } from "@agentclientprotocol/sdk";
import { expect } from "vitest";

import { DEFAULT_WORKSPACE_DIRECTORY } from "../../../../src/adapters/shared/roomWorkspace";
import { ACP_SESSION_EVENT } from "../../../../src/converters/acp-client";
import { ADAPTER, buildOmp } from "../../toolkit/adapters";
import { assertDeliveryStatus } from "../../toolkit/assertDelivery";
import { assertReplied } from "../../toolkit/assertMessages";
import { DELIVERY_STATUS, observeAgent } from "../../toolkit/observeDelivery";
import { MESSAGE_TYPE, observeRoom, type CapturedMessage } from "../../toolkit/observeMessages";
import { withAdapters } from "../../toolkit/perAdapter";
import { CATEGORY, scenarioId } from "../../toolkit/registry";
import { Rooms } from "../../toolkit/rooms";
import { uniqueMarker } from "../samples/markers";
import { addsHelperThroughMcp } from "../samples/mcpRoster";

/** ACP's permission option kinds, named once. */
const OPTION = {
  allowOnce: "allow_once",
  allowAlways: "allow_always",
  rejectOnce: "reject_once",
  rejectAlways: "reject_always",
} as const satisfies Record<string, PermissionOptionKind>;

/** The ACP tool kinds that change something, so they must be asked about. */
const GATED_TOOL_KIND = {
  execute: "execute",
  edit: "edit",
  delete: "delete",
  move: "move",
} as const satisfies Record<string, ToolKind>;

const GATED_TOOL_KINDS: ReadonlySet<ToolKind> = new Set(Object.values(GATED_TOOL_KIND));

/** The platform's metadata keys on a tool event. */
const TOOL_EVENT = { callId: "tool_call_id", rawInput: "raw_input" } as const;

const GUARDED_FILE_NAME = "guarded.txt";
const GUARDED_FILE_CONTENTS = "do not touch\n";
const TEXT = "utf8";

const sessionIds = (events: CapturedMessage[]) =>
  events.filter((event) => event.content === ACP_SESSION_EVENT.content).map((event) => event.metadata[ACP_SESSION_EVENT.sessionIdKey]);

withAdapters([ADAPTER.ompAcp], scenarioId(CATEGORY.adapters, "ompAcp.mcpSession"), async (cast) => {
  const [omp] = cast.agents;
  const { helperName } = await addsHelperThroughMcp(cast);
  // The session event follows the reply; the turn's processed state follows both.
  const delivery = await observeAgent(omp!, cast.room).untilProcessed(cast.room.lastSent!);
  assertDeliveryStatus(delivery, DELIVERY_STATUS.processed);
  const history = observeRoom(cast.room);

  const tasks = (await history.history(MESSAGE_TYPE.Task)).filter((event) => event.senderId === omp!.id);
  expect(sessionIds(tasks), "both turns ran on one ACP session").toEqual([expect.any(String), expect.any(String)]);
  expect(new Set(sessionIds(tasks)).size).toBe(1);

  const call = (await history.history(MESSAGE_TYPE.ToolCall)).find((event) =>
    JSON.stringify(event.metadata[TOOL_EVENT.rawInput] ?? "").includes(helperName),
  );
  expect(call, "a band_add_participant tool_call naming the helper").toBeDefined();
  const results = await history.history(MESSAGE_TYPE.ToolResult);
  expect(
    results.some((result) => result.metadata[TOOL_EVENT.callId] === call!.metadata[TOOL_EVENT.callId]),
    "its tool_result",
  ).toBe(true);
});

/** Denies gated tool calls, allows the rest, and remembers whether the guarded file's delete was asked about. */
function permissionGate() {
  let deniedGuardedDelete = false;
  let mismatch: string | null = null;
  const optionOf = (request: RequestPermissionRequest, kinds: PermissionOptionKind[]) =>
    kinds.map((kind) => request.options.find((option) => option.kind === kind)?.optionId).find(Boolean);

  return {
    get deniedGuardedDelete() {
      return deniedGuardedDelete;
    },
    get mismatch() {
      return mismatch;
    },
    resolvePermission: async (request: RequestPermissionRequest) => {
      const { kind } = request.toolCall;
      if (!kind || !GATED_TOOL_KINDS.has(kind)) {
        return optionOf(request, [OPTION.allowOnce, OPTION.allowAlways]) ?? request.options[0]?.optionId;
      }
      // `locations` names the file; `rawInput` is the fallback for an agent that leaves it out.
      const targetsGuardedFile =
        (request.toolCall.locations ?? []).some((location) => location.path.endsWith(GUARDED_FILE_NAME)) ||
        JSON.stringify(request.toolCall.rawInput ?? "").includes(GUARDED_FILE_NAME);
      deniedGuardedDelete ||= targetsGuardedFile;
      const reject = optionOf(request, [OPTION.rejectOnce, OPTION.rejectAlways]);
      // Throwing here would be swallowed as a non-answer, so a mismatch is recorded and asserted later.
      if (!reject) mismatch = `gated request for kind "${kind}" offered no reject option`;
      return reject;
    },
  };
}

const gate = permissionGate();

withAdapters(
  [ADAPTER.ompAcp],
  scenarioId(CATEGORY.adapters, "ompAcp.permissionGate"),
  async ({ agents: [omp], room, cells: [cell] }) => {
    // OMP runs in this room's workspace, which it creates only on the room's first message.
    const workspace = join(cell!.workDir, DEFAULT_WORKSPACE_DIRECTORY, room.id);
    await mkdir(workspace, { recursive: true });
    const guardedFile = join(workspace, GUARDED_FILE_NAME);
    await writeFile(guardedFile, GUARDED_FILE_CONTENTS);
    const done = uniqueMarker("PERM");

    await Rooms.sendMention(
      room,
      omp!,
      `Delete the file named ${GUARDED_FILE_NAME} in your current working directory, then reply with exactly ${done} once you are done attempting it.`,
    );
    assertReplied(await observeRoom(room).untilReplyMatching(omp!, (message) => message.content.includes(done)));

    expect(gate.mismatch).toBeNull();
    expect(gate.deniedGuardedDelete, "the delete was routed through session/request_permission").toBe(true);
    expect(await readFile(guardedFile, TEXT), "the denied delete left the file intact").toBe(GUARDED_FILE_CONTENTS);
  },
  {
    // Never yolo: an auto-approve mode would bypass the gate under test.
    build: (_spec, options) => buildOmp(options, { resolvePermission: gate.resolvePermission }),
  },
);
