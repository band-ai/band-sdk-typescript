/**
 * OMP over ACP: an MCP roster change on one reused ACP session, and a
 * permission-gated delete that the client's resolver denies.
 */
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { PermissionOptionKind, RequestPermissionRequest, ToolKind } from "@agentclientprotocol/sdk";
import { expect } from "vitest";

import { DEFAULT_WORKSPACE_DIRECTORY } from "../../../../src/adapters/shared/roomWorkspace";
import { ACP_SESSION_EVENT } from "../../../../src/converters/acp-client";
import { ADAPTER, buildOmp, OMP_COMMAND, OMP_STATE_DIR } from "../../toolkit/adapters";
import { assertDeliveryStatus } from "../../toolkit/assertDelivery";
import { DELIVERY_STATUS, observeAgent } from "../../toolkit/observeDelivery";
import { MESSAGE_TYPE, observeRoom, type CapturedMessage } from "../../toolkit/observeMessages";
import { withAdapters } from "../../toolkit/perAdapter";
import { CATEGORY, scenarioId } from "../../toolkit/registry";
import { Rooms } from "../../toolkit/rooms";
import { scenarioEvidence } from "../../toolkit/scenarioEvidence";
import { readText } from "../samples/files";
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
 * The only built-in tools OMP gets in the permission scenario. OMP asks the
 * ACP client before `bash` and before an `edit` that deletes or moves a file,
 * but runs `eval`, file `write`s and content edits without asking, so with
 * those a model that works around a refusal changes the file without the gate
 * ever seeing it. The Band tools arrive over MCP and are not affected.
 */
const OMP_TOOLS = ["read", "bash"] as const;

type TranscriptPart = { type?: string; id?: string; name?: string; arguments?: unknown; text?: string };

/** The fields read from one line of an OMP session transcript. */
type OmpTranscriptLine = {
  message?: { role?: string; toolCallId?: string; isError?: boolean; content?: TranscriptPart[] };
};

/** One tool call from OMP's transcript, with its outcome once OMP recorded one. */
interface OmpToolCall {
  id: string;
  name: string;
  arguments: unknown;
  outcome?: "ok" | "error";
  result?: string;
}

const TOOL_RESULT_PREVIEW_LENGTH = 300;

/** One transcript line, or nothing for the torn last line of a transcript OMP is still writing. */
function parseTranscriptLine(line: string): OmpTranscriptLine {
  try {
    return JSON.parse(line) as OmpTranscriptLine;
  } catch {
    return {};
  }
}

/** OMP's own transcript of tool calls, including those it runs without asking, which the room never sees. */
async function ompToolCalls(workDir: string): Promise<OmpToolCall[]> {
  const sessions = join(workDir, OMP_STATE_DIR, "sessions");
  const files = (await readdir(sessions, { recursive: true }).catch(() => [])).filter((file) => file.endsWith(".jsonl"));
  const transcripts = await Promise.all(files.map((file) => readText(join(sessions, file))));
  const calls = new Map<string, OmpToolCall>();
  for (const line of transcripts.flatMap((transcript) => transcript.split("\n").filter(Boolean))) {
    const { message } = parseTranscriptLine(line);
    const parts = Array.isArray(message?.content) ? message.content : [];
    for (const part of parts) {
      if (part.type === "toolCall" && part.id) calls.set(part.id, { id: part.id, name: part.name ?? "", arguments: part.arguments });
    }
    const call = message?.role === "toolResult" && message.toolCallId ? calls.get(message.toolCallId) : undefined;
    if (message && call) {
      call.outcome = message.isError ? "error" : "ok";
      call.result = parts.map((part) => part.text ?? "").join(" ").slice(0, TOOL_RESULT_PREVIEW_LENGTH);
    }
  }
  return [...calls.values()];
}

/** One `session/request_permission` the gate answered. */
interface PermissionDecision {
  toolCallId: string;
  title: string | null | undefined;
  kind: ToolKind | null | undefined;
  targetsGuardedFile: boolean;
  allowed: boolean;
}

/**
 * Denies gated tool calls and any call that names the guarded file, allows the
 * rest, and records every decision. OMP sets `kind` only on `bash`, so a delete
 * can arrive kind-less.
 */
function permissionGate() {
  const decisions: PermissionDecision[] = [];
  let mismatch: string | null = null;
  const optionOf = (request: RequestPermissionRequest, kinds: PermissionOptionKind[]) =>
    kinds.map((kind) => request.options.find((option) => option.kind === kind)?.optionId).find(Boolean);

  return {
    decisions,
    get mismatch() {
      return mismatch;
    },
    resolvePermission: async (request: RequestPermissionRequest) => {
      const { toolCallId, title, kind } = request.toolCall;
      // `locations` names the file; `rawInput` is the fallback for an agent that leaves it out.
      const targetsGuardedFile =
        (request.toolCall.locations ?? []).some((location) => location.path.endsWith(GUARDED_FILE_NAME)) ||
        JSON.stringify(request.toolCall.rawInput ?? "").includes(GUARDED_FILE_NAME);
      const gated = targetsGuardedFile || (!!kind && GATED_TOOL_KINDS.has(kind));
      decisions.push({ toolCallId, title, kind, targetsGuardedFile, allowed: !gated });
      if (!gated) {
        return optionOf(request, [OPTION.allowOnce, OPTION.allowAlways]) ?? request.options[0]?.optionId;
      }
      const reject = optionOf(request, [OPTION.rejectOnce, OPTION.rejectAlways]);
      // Throwing here would be swallowed as a non-answer, so a mismatch is recorded and asserted later.
      if (!reject) mismatch = `gated request for kind "${kind ?? "none"}" offered no reject option`;
      return reject;
    },
  };
}

/** Each cell's gate, keyed by its working directory, so no run sees another's decisions. */
const gates = new Map<string, ReturnType<typeof permissionGate>>();

withAdapters(
  [ADAPTER.ompAcp],
  scenarioId(CATEGORY.adapters, "ompAcp.permissionGate"),
  async ({ agents: [omp], room, cells: [cell] }) => {
    const gate = gates.get(cell!.workDir)!;
    // OMP runs in this room's workspace, which it creates only on the room's first message.
    const workspace = join(cell!.workDir, DEFAULT_WORKSPACE_DIRECTORY, room.id);
    await mkdir(workspace, { recursive: true });
    const guardedFile = join(workspace, GUARDED_FILE_NAME);
    await writeFile(guardedFile, GUARDED_FILE_CONTENTS);

    const evidence = scenarioEvidence(room, omp!);
    await evidence.run(async () => {
      const sent = await Rooms.sendMention(
        room,
        omp!,
        `Delete the file named ${GUARDED_FILE_NAME} in your current working directory by running \`rm ${GUARDED_FILE_NAME}\` with bash as your first tool call, without checking for it first. If that is refused, do not remove, empty or change the file any other way; just say it was refused.`,
      );
      // Waiting on the turn, not on an exact reply, keeps a reworded refusal from timing out.
      const delivery = await observeAgent(omp!, room).untilProcessed(sent);
      // Read once the turn is processed, so every call OMP made has run; its transcript may still lag, so
      // the checks on it below fail only on a call it did record, never on one missing from it.
      const contents = await readText(guardedFile).catch(() => null);
      const calls = await ompToolCalls(cell!.workDir);
      evidence.record({ delivery, contents, decisions: gate.decisions, calls });

      // Ordered so the most specific cause fails first: an ignored denial, then the call that changed the file.
      assertDeliveryStatus(delivery, DELIVERY_STATUS.processed);
      expect(gate.mismatch).toBeNull();
      const denied = new Set(gate.decisions.filter((decision) => !decision.allowed).map((decision) => decision.toolCallId));
      const ran = calls.filter((call) => call.outcome === "ok");
      expect(ran.filter((call) => denied.has(call.id)), "OMP ran no call the gate denied").toEqual([]);
      const ranUndenied = ran.map(({ name, arguments: args }) => `${name} ${JSON.stringify(args)}`);
      expect(contents, `the file is intact; OMP ran, unasked or allowed: ${ranUndenied.join(" | ")}`).toBe(GUARDED_FILE_CONTENTS);
      expect(
        gate.decisions.some((decision) => decision.targetsGuardedFile && !decision.allowed),
        "the delete was routed through session/request_permission and denied",
      ).toBe(true);
    });
  },
  {
    // Never yolo: an auto-approve mode would bypass the gate under test.
    build: (_spec, options) => {
      const gate = permissionGate();
      gates.set(options.workDir, gate);
      return buildOmp(options, {
        command: [...OMP_COMMAND, "--tools", OMP_TOOLS.join(",")],
        resolvePermission: gate.resolvePermission,
      });
    },
  },
);
