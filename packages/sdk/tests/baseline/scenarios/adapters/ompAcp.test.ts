/**
 * OMP over ACP: an MCP roster change on one reused ACP session, and a
 * permission-gated delete that the client's resolver denies.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { RequestPermissionRequest, ToolKind } from "@agentclientprotocol/sdk";
import { expect } from "vitest";

import { OmpACPAdapter } from "../../../../src/adapters";
import { OMP_COMMAND, ompStateEnv } from "../../toolkit/adapters";
import { assertDeliveryStatus } from "../../toolkit/assertDelivery";
import { assertReplied } from "../../toolkit/assertMessages";
import { observeAgent } from "../../toolkit/observeDelivery";
import { observeRoom, type CapturedMessage } from "../../toolkit/observeMessages";
import { withAdapters } from "../../toolkit/perAdapter";
import { Rooms } from "../../toolkit/rooms";
import { uniqueMarker } from "../samples/markers";
import { addsHelperThroughMcp } from "../samples/mcpRoster";

const SESSION_EVENT = "ACP client session";
const GATED_TOOL_KINDS: ReadonlySet<ToolKind> = new Set<ToolKind>(["execute", "edit", "delete", "move"]);
const GUARDED_FILE_NAME = "guarded.txt";
const GUARDED_FILE_CONTENTS = "do not touch\n";

const sessionIds = (events: CapturedMessage[]) =>
  events.filter((event) => event.content === SESSION_EVENT).map((event) => event.metadata.acp_client_session_id);

withAdapters(["omp-acp"], "adapters.ompAcp.mcpSession", async (cast) => {
  const { helperName } = await addsHelperThroughMcp(cast);
  // The session event follows the reply; the turn's processed state follows both.
  assertDeliveryStatus(await observeAgent(cast.agents[0]!, cast.room).untilProcessed(cast.room.lastSent!), "processed");
  const history = observeRoom(cast.room);

  const tasks = (await history.history("task")).filter((event) => event.senderId === cast.agents[0]!.id);
  expect(sessionIds(tasks), "both turns ran on one ACP session").toEqual([expect.any(String), expect.any(String)]);
  expect(new Set(sessionIds(tasks)).size).toBe(1);

  const call = (await history.history("tool_call")).find((event) => JSON.stringify(event.metadata.raw_input ?? "").includes(helperName));
  expect(call, "a band_add_participant tool_call naming the helper").toBeDefined();
  const results = await history.history("tool_result");
  expect(results.some((result) => result.metadata.tool_call_id === call!.metadata.tool_call_id), "its tool_result").toBe(true);
});

/** Denies gated tool calls, allows the rest, and remembers whether the guarded file's delete was asked about. */
function permissionGate() {
  let deniedGuardedDelete = false;
  let mismatch: string | null = null;
  const optionOf = (request: RequestPermissionRequest, kinds: string[]) =>
    kinds.map((kind) => request.options.find((option) => option.kind === kind)?.optionId).find(Boolean);

  return {
    get deniedGuardedDelete() {
      return deniedGuardedDelete;
    },
    get mismatch() {
      return mismatch;
    },
    resolvePermission: async (request: RequestPermissionRequest) => {
      const gated = request.toolCall.kind !== undefined && request.toolCall.kind !== null && GATED_TOOL_KINDS.has(request.toolCall.kind);
      if (!gated) {
        return optionOf(request, ["allow_once", "allow_always"]) ?? request.options[0]?.optionId;
      }
      // `locations` names the file; `rawInput` is the fallback for an agent that leaves it out.
      const targetsGuardedFile =
        (request.toolCall.locations ?? []).some((location) => location.path.endsWith(GUARDED_FILE_NAME)) ||
        JSON.stringify(request.toolCall.rawInput ?? "").includes(GUARDED_FILE_NAME);
      deniedGuardedDelete ||= targetsGuardedFile;
      const reject = optionOf(request, ["reject_once", "reject_always"]);
      // Throwing here would be swallowed as a non-answer, so a mismatch is recorded and asserted later.
      if (!reject) mismatch = `gated request for kind "${request.toolCall.kind}" offered no reject option`;
      return reject;
    },
  };
}

const gate = permissionGate();

withAdapters(
  ["omp-acp"],
  "adapters.ompAcp.permissionGate",
  async ({ agents: [omp], room, cells: [cell] }) => {
    const guardedFile = join(cell!.workDir, GUARDED_FILE_NAME);
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
    expect(await readFile(guardedFile, "utf8"), "the denied delete left the file intact").toBe(GUARDED_FILE_CONTENTS);
  },
  {
    // Never yolo: an auto-approve mode would bypass the gate under test.
    build: (_spec, { prompt, workDir }) =>
      new OmpACPAdapter({ command: OMP_COMMAND, cwd: workDir, customSection: prompt, env: ompStateEnv(workDir), resolvePermission: gate.resolvePermission }),
  },
);
