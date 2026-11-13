import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CLAUDE_PROTOCOL,
  ClaudeCliClient,
  ClaudeCliError,
  ClaudeProcessError,
  ClaudeVersionError,
  type ClaudeCliStartConfig,
  type ClaudeEvent,
  type ClaudeProcessFactory,
  type ClaudeProcessOptions,
} from "../src/adapters/claude-cli";
import type { Logger } from "../src/core/logger";
import { fakeClaudeProcesses, initResponse, type FakeClaude } from "./support/fakeClaudeCli";
import { addressed, captured, capturedStdin, turnFrames, type Frame } from "./support/claudeCaptures";
import { makeLoggerSpy, tmpRoot, type LoggerSpy } from "./testUtils";

function processOptions(logger: Logger): ClaudeProcessOptions {
  return { command: ["claude", "--print", "--input-format", "stream-json"], cwd: tmpRoot(), logger };
}

function toolUses(events: ClaudeEvent[]): Array<Extract<ClaudeEvent, { type: "tool_use" }>> {
  return events.filter((event): event is Extract<ClaudeEvent, { type: "tool_use" }> => event.type === "tool_use");
}

function toolResults(events: ClaudeEvent[]): Array<Extract<ClaudeEvent, { type: "tool_result" }>> {
  return events.filter((event): event is Extract<ClaudeEvent, { type: "tool_result" }> => event.type === "tool_result");
}

/** Starts a client and answers its `initialize`, as a CLI at the version floor would. */
async function online(
  rig: { spawnProcess: ClaudeProcessFactory; nextPeer(): Promise<FakeClaude> },
  logger: Logger,
  config: ClaudeCliStartConfig = {},
  cliVersion = "2.1.319",
): Promise<{ client: ClaudeCliClient; peer: FakeClaude }> {
  const pending = start(rig, logger, config);
  const peer = await pending.peer;
  await pending.answer(cliVersion);
  return { client: await pending.client, peer };
}

/** A start whose handshake the caller answers, so a test can also refuse to. */
function start(
  rig: { spawnProcess: ClaudeProcessFactory; nextPeer(): Promise<FakeClaude> },
  logger: Logger,
  config: ClaudeCliStartConfig = {},
): { peer: Promise<FakeClaude>; client: Promise<ClaudeCliClient>; answer(version?: string): Promise<void> } {
  const peer = rig.nextPeer();
  const client = ClaudeCliClient.start(rig.spawnProcess, processOptions(logger), config);
  client.catch(() => undefined); // observed here; the caller still awaits the same promise
  const answer = async (version = "2.1.319"): Promise<void> => {
    const process = await peer;
    const request = process.received.find((frame) => frame.type === "control_request");
    process.send(initResponse(String(request?.request_id ?? "band-1"), version));
  };
  return { peer, client, answer };
}

describe("ClaudeCliClient", () => {
  let log: LoggerSpy;
  let rig: ReturnType<typeof fakeClaudeProcesses>;

  beforeEach(() => {
    log = makeLoggerSpy();
    rig = fakeClaudeProcesses();
  });

  describe("initialize and the version floor", () => {
    it("sends initialize and reports the protocol and version the captured CLI answered", async () => {
      const pending = ClaudeCliClient.start(rig.spawnProcess, processOptions(log));
      const peer = await rig.nextPeer();
      const request = await peer.controlRequest("initialize");
      expect(request.request_id).toMatch(/^band-\d+$/);
      expect(request.request).toEqual({ subtype: "initialize" });
      // The real 2.1.319 handshake frame, not a hand-written one.
      peer.send(addressed(captured("initialize")[0]!, String(request.request_id)));

      const client = await pending;
      expect(client.claudeIdentity).toEqual({ protocol: CLAUDE_PROTOCOL, cliVersion: "2.1.319" });
      expect(client.initReport).toMatchObject({ permissionMode: "default" });
      expect(client.initReport?.capabilities).toContain("mcp_call_check_permissions_v1");
      expect(client.turnRunning).toBe(false);
      await client.close({ drainMs: 10 });
    });

    it("refuses a CLI older than the floor and stops the process it started", async () => {
      const pending = online(rig, log, {}, "2.0.9");
      await expect(pending).rejects.toBeInstanceOf(ClaudeVersionError);
      await expect(pending).rejects.toThrow(/2\.0\.9 is older than the 2\.1\.319/);
      const peer = rig.processes[0]!;
      expect(peer.stopped).toBe(true);
      expect(peer.hasExited).toBe(true);
    });

    it("refuses a CLI whose version it cannot read rather than assuming a new enough one", async () => {
      const pending = online(rig, log, {}, "nightly-build");
      await expect(pending).rejects.toBeInstanceOf(ClaudeVersionError);
      await expect(pending).rejects.toThrow(/cannot read the CLI version/);
      const peer = rig.processes[0]!;
      expect(peer.stopped).toBe(true);
    });

    it("stops the process when initialize never answers, so a failed start leaves nothing running", async () => {
      const pending = start(rig, log, { startTimeoutMs: 20 });
      await expect(pending.client).rejects.toBeInstanceOf(ClaudeProcessError);
      await expect(pending.client).rejects.toThrow(/did not initialize within 20ms/);
      const peer = await pending.peer;
      expect(peer.received.filter((frame) => frame.type === "control_request")).toHaveLength(1);
      expect(peer.stopped).toBe(true);
      expect(peer.hasExited).toBe(true);
    });

    it("propagates a missing executable as a failed start, with no client to clean up", async () => {
      const missing: ClaudeProcessFactory = async () => {
        throw new Error("spawn claude ENOENT");
      };
      await expect(ClaudeCliClient.start(missing, processOptions(log))).rejects.toThrow(/ENOENT/);
      expect(log.warn).not.toHaveBeenCalled();
    });
  });

  describe("framing", () => {
    it("reassembles a frame the CLI split across writes, including inside a multi-byte character", async () => {
      const { client, peer } = await online(rig, log);
      const events: ClaudeEvent[] = [];
      const turn = client.runTurn("hi", { onEvent: (event) => events.push(event) });

      const assistant = Buffer.from(
        `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "héllo" }] }, session_id: "S1" })}\n`,
        "utf8",
      );
      const split = assistant.indexOf(Buffer.from("é", "utf8")) + 1; // between the two bytes of one codepoint
      peer.sendRaw(assistant.subarray(0, split));
      peer.sendRaw(assistant.subarray(split));
      peer.send({ type: "result", subtype: "success", is_error: false, result: "héllo", session_id: "S1" });

      expect((await turn).result.result).toBe("héllo");
      expect(events.filter((event) => event.type === "text")).toEqual([{ type: "text", text: "héllo" }]);
      await client.close({ drainMs: 10 });
    });

    it("fails the transport on a frame over the bound, instead of buffering without end", async () => {
      const { client, peer } = await online(rig, log, { maxFrameBytes: 400 });
      const turn = client.runTurn("hi", { onEvent: () => undefined });
      peer.send({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "x".repeat(600) }] },
        session_id: "S1",
      });

      const failure = await client.failed;
      expect(failure).toBeInstanceOf(ClaudeProcessError);
      expect(failure.message).toMatch(/exceeds the 400 byte limit/);
      await expect(turn).rejects.toBeInstanceOf(ClaudeProcessError);
      await client.close({ drainMs: 10 });
    });

    it("bounds a frame that never ends, rather than growing one forever", async () => {
      const { client, peer } = await online(rig, log, { maxFrameBytes: 400 });
      peer.sendRaw(`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"${"y".repeat(600)}`);

      const failure = await client.failed;
      expect(failure.message).toMatch(/exceeds the 400 byte limit/);
      await client.close({ drainMs: 10 });
    });

    it("fails the transport on a line that is not a JSON object with a type", async () => {
      const { client, peer } = await online(rig, log);
      peer.sendRaw("this is not a frame\n");
      const failure = await client.failed;
      expect(failure.message).toMatch(/not a JSON object with a type/);
      await client.close({ drainMs: 10 });
    });

    it("keeps running when the CLI adds a frame type this client has never seen", async () => {
      const { client, peer } = await online(rig, log);
      const events: ClaudeEvent[] = [];
      const turn = client.runTurn("hi", { onEvent: (event) => events.push(event) });
      peer.send({ type: "some_future_event", detail: { nested: true }, session_id: "S1" });
      peer.send({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: "S1" });

      expect((await turn).result.result).toBe("ok");
      expect(events).toEqual([]);
      await client.close({ drainMs: 10 });
    });
  });

  describe("turns, replayed from the captures", () => {
    it("settles a turn on its terminal result and reports the events the CLI wrote, in order", async () => {
      const { client, peer } = await online(rig, log);
      const events: ClaudeEvent[] = [];
      const turn = client.runTurn("ping", { onEvent: (event) => events.push(event) });
      peer.send(...turnFrames("turn-basic"));

      const outcome = await turn;
      expect(outcome.result).toMatchObject({
        subtype: "success",
        isError: false,
        result: "PONG",
        numTurns: 1,
        terminalReason: "completed",
      });
      expect(outcome.sessionId).toBe("SESSION-1");
      expect(outcome.interrupted).toBe(false);
      expect(events.map((event) => event.type)).toEqual(["system_init", "text"]);
      expect(client.session).toBe("SESSION-1");
      await client.close({ drainMs: 10 });
    });

    it("writes the same envelopes the CLI was captured accepting", async () => {
      const { client, peer } = await online(rig, log);
      const prompt = "Reply with exactly this text and nothing else: PONG";
      const turn = client.runTurn(prompt, { onEvent: () => undefined });
      peer.send(...turnFrames("turn-basic"));
      await turn;

      // The request id is ours to mint; everything else must match the capture
      // byte for byte, or the real CLI would not accept what we write.
      const normalize = (frame: Frame): Frame =>
        typeof frame.request_id === "string" ? { ...frame, request_id: "minted" } : frame;
      const wanted = capturedStdin("turn-basic").map(normalize);
      expect(peer.received.map(normalize)).toEqual(wanted);
      await client.close({ drainMs: 10 });
    });

    it("keeps a tool use and its result correlated, and never turns a tool result into a reply", async () => {
      const { client, peer } = await online(rig, log);
      const events: ClaudeEvent[] = [];
      const turn = client.runTurn("use the tool", { onEvent: (event) => events.push(event) });
      peer.send(...turnFrames("tool-call"));
      await turn;

      const calls = toolUses(events);
      const results = toolResults(events);
      expect(calls.map((event) => event.name)).toEqual(["ToolSearch", "mcp__probe__echo"]);
      expect(results.map((event) => event.toolUseId)).toEqual(calls.map((event) => event.id));
      expect(results.every((event) => event.isError === false)).toBe(true);
      // Only the assistant's own text is a reply, and it is reported once.
      expect(events.filter((event) => event.type === "text")).toEqual([{ type: "text", text: "echo:ping-probe" }]);
      await client.close({ drainMs: 10 });
    });

    it("settles a cancelled turn with the error-shaped result the capture recorded", async () => {
      const { client, peer } = await online(rig, log);
      const frames = turnFrames("interrupt-pending-permission");
      const events: ClaudeEvent[] = [];
      const turn = client.runTurn("do the thing", { onEvent: (event) => events.push(event) });
      peer.send(frames[0]!, frames[1]!); // the system/init, then the assistant's Bash tool_use

      const interruptAccepted = client.interrupt();
      const request = await peer.controlRequest("interrupt");
      const answered = captured("interrupt-pending-permission").find(
        (frame) => (frame.response as Frame | undefined)?.request_id === "cap-interrupt-1",
      )!;
      peer.send(addressed(answered, String(request.request_id)));
      peer.send(...frames.slice(2));
      await interruptAccepted;

      const outcome = await turn;
      expect(outcome.interrupted).toBe(true);
      expect(outcome.result).toMatchObject({
        subtype: "error_during_execution",
        isError: true,
        terminalReason: "aborted_tools",
        permissionDenials: [{ toolName: "Bash", toolUseId: "toolu-1" }],
      });
      // A cancelled turn writes no reply text; the CLI names the reason instead.
      expect(outcome.result.result).toBeNull();
      expect(outcome.result.errors).toHaveLength(1);
      // The CLI's own notice is a notice: it must not be mistaken for the model's reply.
      expect(events.filter((event) => event.type === "notice")).toEqual([
        { type: "notice", text: "[Request interrupted by user for tool use]" },
      ]);
      expect(events.filter((event) => event.type === "text")).toEqual([]);
      await client.close({ drainMs: 10 });
    });

    it("reports a declined permission as the capture did: the tool never ran", async () => {
      const { client, peer } = await online(rig, log);
      const events: ClaudeEvent[] = [];
      const turn = client.runTurn("do the thing", { onEvent: (event) => events.push(event) });
      peer.send(...turnFrames("permission-deny"));

      const outcome = await turn;
      expect(outcome.result.permissionDenials).toEqual([{ toolName: "Bash", toolUseId: "toolu-1" }]);
      const results = toolResults(events);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ toolUseId: "toolu-1", isError: true });
      expect(JSON.stringify(results[0]?.content)).toContain("declined");
      await client.close({ drainMs: 10 });
    });

    it("refuses a second turn while one is running, so turns never share a process", async () => {
      const { client, peer } = await online(rig, log);
      const first = client.runTurn("one", { onEvent: () => undefined });
      await expect(client.runTurn("two", { onEvent: () => undefined })).rejects.toThrow(/already running/);
      peer.send({ type: "result", subtype: "success", is_error: false, result: "one", session_id: "S1" });
      await first;
      await client.close({ drainMs: 10 });
    });

    it("rejects a turn when the process dies before its result, so the caller is never left waiting", async () => {
      const { client, peer } = await online(rig, log);
      const turn = client.runTurn("hi", { onEvent: () => undefined });
      peer.exit(1);
      await expect(turn).rejects.toThrow(/exited with code 1/);
      await client.close({ drainMs: 10 });
    });

    it("carries the drained stderr with the exit it explains, when the CLI failed on stderr alone", async () => {
      const { client, peer } = await online(rig, log);
      const turn = client.runTurn("hi", { onEvent: () => undefined });
      peer.writeStderr("Error: Invalid MCP configuration:", "MCP config file not found: /tmp/x.json");
      peer.exit(1);

      await expect(turn).rejects.toBeInstanceOf(ClaudeProcessError);
      expect(log.warn).toHaveBeenCalledWith(
        "claude_cli.process_exited",
        expect.objectContaining({ code: 1, stderr: "Error: Invalid MCP configuration:\nMCP config file not found: /tmp/x.json" }),
      );
      await client.close({ drainMs: 10 });
    });
  });

  describe("control correlation", () => {
    it("resolves a request only on the response that names its id, and ignores one that names another", async () => {
      const { client, peer } = await online(rig, log);
      let answered = false;
      const turn = client.runTurn("hi", { onEvent: () => undefined });
      const interrupt = client.interrupt().then(() => {
        answered = true;
      });
      const request = await peer.controlRequest("interrupt");

      peer.send({ type: "control_response", response: { subtype: "success", request_id: "band-999", response: {} } });
      await vi.waitFor(() => expect(log.warn).toHaveBeenCalledWith("claude_cli.unmatched_response", { requestId: "band-999" }));
      expect(answered).toBe(false);

      peer.send({ type: "control_response", response: { subtype: "success", request_id: request.request_id, response: { still_queued: [] } } });
      await interrupt;
      expect(answered).toBe(true);
      peer.send({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: "S1" });
      await turn;
      await client.close({ drainMs: 10 });
    });

    it("rejects a request the CLI refused, keeping the process usable for the next turn", async () => {
      const { client, peer } = await online(rig, log);
      const refused = captured("control-error").find((frame) => (frame.response as Frame | undefined)?.request_id === "cap-bad-1")!;

      const pending = client.request("not_a_real_subtype");
      const request = await peer.waitFor((frame) => (frame.request as Frame | undefined)?.subtype === "not_a_real_subtype");
      peer.send(addressed(refused, String(request.request_id)));

      await expect(pending).rejects.toBeInstanceOf(ClaudeCliError);
      await expect(pending).rejects.toThrow(/Unsupported control request subtype/);
      const turn = client.runTurn("still usable", { onEvent: () => undefined });
      peer.send({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: "S1" });
      await expect(turn).resolves.toMatchObject({ result: { result: "ok" } });
      await client.close({ drainMs: 10 });
    });

    it("answers a control_request the CLI sends, so an unsupported one cannot hang the turn", async () => {
      const { client, peer } = await online(rig, log);
      const turn = client.runTurn("hi", { onEvent: () => undefined });
      peer.send({ type: "control_request", request_id: "cli-1", request: { subtype: "can_use_tool", tool_name: "Bash" } });

      const answer = await peer.waitFor((frame) => frame.type === "control_response");
      const reply = answer.response as Frame;
      expect(reply).toMatchObject({ subtype: "error", request_id: "cli-1" });
      expect(String(reply.error)).toMatch(/cannot handle can_use_tool/);

      peer.send({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: "S1" });
      await turn;
      await client.close({ drainMs: 10 });
    });
  });

  describe("session and content safety", () => {
    it("refuses a process that switches sessions mid-life", async () => {
      const { client, peer } = await online(rig, log);
      const turn = client.runTurn("hi", { onEvent: () => undefined });
      peer.send({ type: "system", subtype: "init", session_id: "SESSION-A", tools: [], mcp_servers: [], capabilities: [] });
      peer.send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "a" }] }, session_id: "SESSION-B" });

      const failure = await client.failed;
      expect(failure.message).toMatch(/switched sessions mid-process \(SESSION-A then SESSION-B\)/);
      await expect(turn).rejects.toBeInstanceOf(ClaudeProcessError);
      await client.close({ drainMs: 10 });
    });

    it("surfaces reasoning without the signature that attests it", async () => {
      const { client, peer } = await online(rig, log);
      const events: ClaudeEvent[] = [];
      const turn = client.runTurn("hi", { onEvent: (event) => events.push(event) });
      peer.send({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "the model's private reasoning", signature: "Eq8ClongBase64AttestingBlob" },
            { type: "text", text: "the reply" },
          ],
        },
        session_id: "S1",
      });
      peer.send({ type: "result", subtype: "success", is_error: false, result: "the reply", session_id: "S1" });
      await turn;

      expect(events).toEqual([
        { type: "reasoning", text: "the model's private reasoning" },
        { type: "text", text: "the reply" },
      ]);
      await client.close({ drainMs: 10 });
    });
  });

  describe("what the client may depend on", () => {
    it("loads without importing any Anthropic package", async () => {
      vi.resetModules();
      vi.doMock("@anthropic-ai/claude-agent-sdk", () => {
        throw new Error("the stream-json client must not import the Claude Agent SDK");
      });
      vi.doMock("@anthropic-ai/sdk", () => {
        throw new Error("the stream-json client must not import the Anthropic SDK");
      });

      const client = await import("../src/adapters/claude-cli/index");
      expect(typeof client.ClaudeCliClient).toBe("function");
      expect(client.CLAUDE_PROTOCOL).toBe("claude-stream-json");
    });
  });

  describe("bounded lifecycle", () => {
    it("drains a process that leaves after its stdin closes, without a signal", async () => {
      const leaving = fakeClaudeProcesses((peer) => {
        peer.exitsOnEof = true;
      });
      const { client, peer } = await online(leaving, log);
      const report = await client.close({ drainMs: 200 });
      expect(peer.stdinEnded).toBe(true);
      expect(report).toMatchObject({ drained: true, exitCode: 0, signalCode: null });
    });

    it("refuses to start a turn or a request on a process that already broke", async () => {
      const { client, peer } = await online(rig, log);
      peer.exit(1);
      const failure = await client.failed;
      // Both refusals name the break that caused them, rather than waiting forever.
      await expect(client.runTurn("too late", { onEvent: () => undefined })).rejects.toThrow(/exited with code 1/);
      await expect(client.interrupt()).rejects.toThrow(/exited with code 1/);
      expect(failure).toBeInstanceOf(ClaudeProcessError);
      await client.close({ drainMs: 10 });
    });

    it("stops a process that ignores stdin closing, and says it had to", async () => {
      const { client, peer } = await online(rig, log);
      const report = await client.close({ drainMs: 20 });
      expect(peer.stdinEnded).toBe(true);
      expect(peer.stopped).toBe(true);
      expect(report).toMatchObject({ drained: false, signalCode: "SIGKILL" });
    });
  });


  it("warns about, counts and drops a turn frame that arrives with no turn subscribed", async () => {
    const pending = ClaudeCliClient.start(rig.spawnProcess, processOptions(log));
    const peer = await rig.nextPeer();
    const request = await peer.controlRequest("initialize");
    peer.send(addressed(captured("initialize")[0]!, String(request.request_id)));
    const client = await pending;
    // The real CLI writes none of these before it is handed a prompt.
    peer.send(
      { type: "result", subtype: "success", result: "unasked", session_id: "SESSION-1", is_error: false },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "unasked" }] }, session_id: "SESSION-1" },
      { type: "rate_limit_event", session_id: "SESSION-1" },
    );
    await new Promise((resolve) => setImmediate(resolve));
    const warned = log.warn.mock.calls
      .filter(([message]) => message === "claude_cli.stray_turn_frame")
      .map(([, context]) => (context as { frameType?: string }).frameType);
    expect(warned).toEqual(["result", "assistant"]);
    expect(client.strayTurnFrameCount).toBe(2);
    // Dropped, not queued: there is no turn to settle, and the informational
    // frame beside them is ignored rather than counted.
    expect(client.turnRunning).toBe(false);
    await client.close({ drainMs: 10 });
  });
});
