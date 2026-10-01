/**
 * OMP over ACP: an MCP roster change on one reused ACP session, and a
 * permission-gated delete that the client's resolver denies.
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { PermissionOptionKind, RequestPermissionRequest, ToolKind } from "@agentclientprotocol/sdk";
import { expect } from "vitest";

import { DEFAULT_WORKSPACE_DIRECTORY } from "../../../../src/adapters/shared/roomWorkspace";
import { ACP_SESSION_EVENT } from "../../../../src/converters/acp-client";
import { ADAPTER, buildOmp } from "../../toolkit/adapters";
import { assertDeliveryStatus } from "../../toolkit/assertDelivery";
import { DELIVERY_STATUS, observeAgent } from "../../toolkit/observeDelivery";
import { MESSAGE_TYPE, observeRoom, type CapturedMessage } from "../../toolkit/observeMessages";
import { withAdapters } from "../../toolkit/perAdapter";
import { CATEGORY, scenarioId } from "../../toolkit/registry";
import { Rooms } from "../../toolkit/rooms";
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

/**
 * Every tool call and result in OMP's own session transcripts, which the room
 * never sees: OMP's `write` and non-destructive `edit` run without asking.
 */
async function ompToolLog(workDir: string): Promise<string[]> {
  const sessions = join(workDir, ".omp-state", "sessions");
  const files = (await readdir(sessions, { recursive: true }).catch(() => [])).filter((file) => file.endsWith(".jsonl"));
  const log: string[] = [];
  for (const file of files) {
    for (const line of (await readFile(join(sessions, file), TEXT)).split("\n").filter(Boolean)) {
      const message = (JSON.parse(line) as { message?: { role?: string; toolName?: string; isError?: boolean; content?: unknown } }).message;
      const parts = Array.isArray(message?.content) ? (message.content as { type?: string; name?: string; arguments?: unknown; text?: string }[]) : [];
      for (const part of parts) {
        if (part.type === "toolCall") log.push(`call ${part.name} ${JSON.stringify(part.arguments)}`);
      }
      if (message?.role === "toolResult") {
        log.push(`result ${message.toolName} ${message.isError ? "error" : "ok"}: ${parts.map((part) => part.text ?? "").join(" ").slice(0, 300)}`);
      }
    }
  }
  return log;
}

/**
 * Denies gated tool calls and any call that names the guarded file, allows the
 * rest, and remembers whether the guarded file was asked about. OMP sets `kind`
 * only on `bash`, so a kind-less request can still be a delete (`edit` with a
 * delete patch).
 */
function permissionGate() {
  let deniedGuardedFile = false;
  let mismatch: string | null = null;
  const optionOf = (request: RequestPermissionRequest, kinds: PermissionOptionKind[]) =>
    kinds.map((kind) => request.options.find((option) => option.kind === kind)?.optionId).find(Boolean);

  return {
    get deniedGuardedFile() {
      return deniedGuardedFile;
    },
    get mismatch() {
      return mismatch;
    },
    resolvePermission: async (request: RequestPermissionRequest) => {
      const { kind } = request.toolCall;
      // `locations` names the file; `rawInput` is the fallback for an agent that leaves it out.
      const targetsGuardedFile =
        (request.toolCall.locations ?? []).some((location) => location.path.endsWith(GUARDED_FILE_NAME)) ||
        JSON.stringify(request.toolCall.rawInput ?? "").includes(GUARDED_FILE_NAME);
      if (!targetsGuardedFile && !(kind && GATED_TOOL_KINDS.has(kind))) {
        return optionOf(request, [OPTION.allowOnce, OPTION.allowAlways]) ?? request.options[0]?.optionId;
      }
      deniedGuardedFile ||= targetsGuardedFile;
      const reject = optionOf(request, [OPTION.rejectOnce, OPTION.rejectAlways]);
      // Throwing here would be swallowed as a non-answer, so a mismatch is recorded and asserted later.
      if (!reject) mismatch = `gated request for kind "${kind ?? "none"}" offered no reject option`;
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

    // OMP never asks before `write` or a non-destructive `edit`, so the prompt rules out working around a refusal.
    const sent = await Rooms.sendMention(
      room,
      omp!,
      `Delete the file named ${GUARDED_FILE_NAME} in your current working directory. If the deletion is refused, do not remove, empty or change the file any other way; just say it was refused.`,
    );
    // Waiting on the turn, not on an exact reply, keeps a reworded refusal from timing out.
    const delivery = await observeAgent(omp!, room).untilProcessed(sent);
    try {
      assertDeliveryStatus(delivery, DELIVERY_STATUS.processed);
      expect(gate.mismatch).toBeNull();
      expect(gate.deniedGuardedFile, "the delete was routed through session/request_permission").toBe(true);
      expect(await readFile(guardedFile, TEXT), "the denied delete left the file intact").toBe(GUARDED_FILE_CONTENTS);
    } catch (error) {
      console.warn("ompAcp.permissionGate: OMP's tool calls", await ompToolLog(cell!.workDir));
      throw error;
    }
  },
  {
    // Never yolo: an auto-approve mode would bypass the gate under test.
    build: (_spec, options) => buildOmp(options, { resolvePermission: gate.resolvePermission }),
  },
);
