import { PassThrough } from "node:stream";

import type { OmpProcessFactory, OmpProcessOptions } from "../../src/adapters/omp-rpc";
import { createDeferred } from "../../src/core/deferred";

type Frame = Record<string, unknown>;

/** The `ready` OMP 18 writes first, unprompted. */
export const OMP_READY: Frame = {
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1024 * 1024,
  maxReassembledFrameBytes: 64 * 1024 * 1024,
};

/**
 * One OMP process, in memory: it answers the handshake, `get_state`,
 * `set_host_tools` and `abort` the way OMP does. A prompt's turn is played by
 * `onPrompt`, or by the test writing the turn's frames itself.
 */
export class FakeOmp {
  /** Every frame the adapter wrote, in order. */
  public readonly received: Frame[] = [];
  public stopped = false;
  public readonly exited = createDeferred<number | null>();
  private readonly toAdapter = new PassThrough();
  private readonly fromAdapter = new PassThrough();
  private readonly waiters: Array<{ matches: (frame: Frame) => boolean; resolve: (frame: Frame) => void }> = [];
  private buffered = "";

  public constructor(
    public readonly options: OmpProcessOptions,
    /** Plays a prompt's turn as soon as the prompt arrives, when set. */
    private readonly onPrompt?: (peer: FakeOmp, prompt: Frame) => void | Promise<void>,
  ) {
    this.fromAdapter.setEncoding("utf8");
    this.fromAdapter.on("data", (data: string) => {
      this.buffered += data;
      let newline = this.buffered.indexOf("\n");
      while (newline !== -1) {
        this.receive(JSON.parse(this.buffered.slice(0, newline)) as Frame);
        this.buffered = this.buffered.slice(newline + 1);
        newline = this.buffered.indexOf("\n");
      }
    });
  }

  public get handle() {
    return {
      stdin: this.fromAdapter,
      stdout: this.toAdapter,
      exited: this.exited.promise,
      stderrTail: () => "",
      stop: async () => {
        this.stopped = true;
        this.exited.resolve(null);
      },
    };
  }

  /** Writes frames to the adapter, as OMP's stdout. */
  public send(...frames: Frame[]): void {
    for (const frame of frames) this.toAdapter.write(`${JSON.stringify(frame)}\n`);
  }

  /** Writes raw bytes to the adapter. */
  public sendRaw(text: string): void {
    this.toAdapter.write(text);
  }

  /** The next frame the adapter writes that `matches`, including one already written. */
  public next(matches: (frame: Frame) => boolean): Promise<Frame> {
    const seen = this.received.find(matches);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve) => this.waiters.push({ matches, resolve }));
  }

  /** The adapter's next frame of `type` written after this call. */
  public nextOfType(type: string): Promise<Frame> {
    const after = this.received.length;
    return new Promise((resolve) => this.waiters.push({ matches: (frame) => frame.type === type && this.received.indexOf(frame) >= after, resolve }));
  }

  /** The prompts the adapter sent, in order. */
  public get prompts(): Frame[] {
    return this.received.filter((frame) => frame.type === "prompt");
  }

  /** Calls a host tool and resolves with the adapter's result frame. */
  public async callHostTool(id: string, toolName: string, args: Record<string, unknown>, toolCallId = `call-${id}`): Promise<Frame> {
    const result = this.next((frame) => frame.type === "host_tool_result" && frame.id === id);
    this.send({ type: "host_tool_call", id, toolCallId, toolName, arguments: args });
    return result;
  }

  /** Asks a dialog question and resolves with the adapter's answer frame. */
  public async ask(id: string, request: Frame): Promise<Frame> {
    const answer = this.next((frame) => frame.type === "extension_ui_response" && frame.id === id);
    this.send({ type: "extension_ui_request", id, ...request });
    return answer;
  }

  /** Ends prompt `id` with `status`, then settles the session, as OMP does. */
  public finish(promptId: unknown, status: "completed" | "error" | "aborted" = "completed", error?: Frame): void {
    this.send(
      { type: "prompt_result", id: promptId, agentInvoked: true, status, sessionSettled: true, ...(error ? { error } : {}) },
      { type: "session_settled" },
    );
  }

  /** The process dies on its own. */
  public die(code = 1): void {
    this.exited.resolve(code);
    this.toAdapter.end();
  }

  private receive(frame: Frame): void {
    this.received.push(frame);
    const { id, type } = frame;
    if (type === "negotiate_protocol") this.send({ type: "response", id, command: type, success: true, data: { protocolVersion: frame.protocolVersion } });
    if (type === "get_state") this.send({ type: "response", id, command: type, success: true, data: { sessionId: "omp-session-1", isSettled: true } });
    if (type === "set_host_tools") this.send({ type: "response", id, command: type, success: true, data: { toolNames: (frame.tools as Frame[]).map((tool) => tool.name) } });
    if (type === "prompt") {
      this.send({ type: "response", id, command: type, success: true });
      void this.onPrompt?.(this, frame);
    }
    if (type === "abort") this.send({ type: "response", id, command: type, success: true });
    for (const waiter of [...this.waiters]) {
      if (waiter.matches(frame)) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(frame);
      }
    }
  }
}

/** A process factory whose every process is a {@link FakeOmp} that writes `ready` at once. */
export function fakeOmpProcesses(options: { onPrompt?: (peer: FakeOmp, prompt: Frame) => void | Promise<void> } = {}) {
  const peers: FakeOmp[] = [];
  const spawned: Array<(peer: FakeOmp) => void> = [];
  const spawnProcess: OmpProcessFactory = async (processOptions) => {
    const peer = new FakeOmp(processOptions, options.onPrompt);
    peers.push(peer);
    peer.send(OMP_READY);
    for (const listener of spawned.splice(0)) listener(peer);
    return peer.handle;
  };
  return {
    spawnProcess,
    peers,
    /** Resolves with the next process started. */
    nextProcess: () => new Promise<FakeOmp>((resolve) => spawned.push(resolve)),
    /** Resolves with the next prompt any process receives, and that process. */
    async nextPrompt(peer?: FakeOmp): Promise<{ peer: FakeOmp; prompt: Frame }> {
      const target = peer ?? peers.at(-1) ?? await new Promise<FakeOmp>((resolve) => spawned.push(resolve));
      return { peer: target, prompt: await target.nextOfType("prompt") };
    },
  };
}
