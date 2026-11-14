import { PassThrough } from "node:stream";

import { createDeferred } from "../../src/core/deferred";
import type { ClaudeExitInfo, ClaudeProcessFactory, ClaudeProcessHandle, ClaudeProcessOptions } from "../../src/adapters/claude-cli";

type Frame = Record<string, unknown>;

/** The `initialize` answer Claude Code 2.1.319 writes, as the capture recorded it. */
/** The CLI's plain acceptance of a control request the host sent (interrupt, set-mode, …). */
export function controlSuccess(requestId: string): Frame {
  return { type: "control_response", response: { subtype: "success", request_id: requestId, response: {} } };
}

export function initResponse(requestId: string, cliVersion = "2.1.319"): Frame {
  return {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response: {
        claude_code_version: cliVersion,
        current_permission_mode: "default",
        capabilities: ["ui_surface_v1", "mcp_call_result_not_for_model_v1", "mcp_call_check_permissions_v1"],
      },
      pending_permission_requests: [],
      pending_user_dialog_requests: [],
    },
  };
}

/**
 * One Claude CLI process, in memory. It answers nothing on its own: the test
 * writes the frames the CLI would write, so a test can hold a turn open at any
 * point and see what the client does while it waits.
 */
export class FakeClaude {
  /** Every frame the client wrote, in order. */
  public readonly received: Frame[] = [];
  public stopped = false;
  public stdinEnded = false;
  /** A CLI that behaves leaves when its stdin closes; a stuck one does not. */
  public exitsOnEof = true;
  public exitCalls = 0;
  public hasExited = false;
  /** True while a test is keeping the process alive. */
  private exitHeld = false;
  public readonly exited = createDeferred<ClaudeExitInfo>();
  private readonly toClient = new PassThrough();
  private readonly fromClient = new PassThrough();
  private readonly waiters: Array<{ matches: (frame: Frame) => boolean; resolve: (frame: Frame) => void }> = [];
  private buffered = "";
  private stderrLines: string[] = [];

  public constructor(public readonly options: ClaudeProcessOptions) {
    this.fromClient.setEncoding("utf8");
    this.fromClient.on("data", (data: string) => {
      this.buffered += data;
      for (let newline = this.buffered.indexOf("\n"); newline !== -1; newline = this.buffered.indexOf("\n")) {
        const line = this.buffered.slice(0, newline);
        this.buffered = this.buffered.slice(newline + 1);
        if (!line.trim()) continue;
        const frame = JSON.parse(line) as Frame;
        this.received.push(frame);
        for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
          const waiter = this.waiters[index]!;
          if (waiter.matches(frame)) {
            this.waiters.splice(index, 1);
            waiter.resolve(frame);
          }
        }
      }
    });
  }

  public get handle(): ClaudeProcessHandle {
    return {
      stdin: this.fromClient,
      stdout: this.toClient,
      exited: this.exited.promise,
      endStdin: () => {
        this.stdinEnded = true;
        this.fromClient.end();
        if (this.exitsOnEof) this.settle({ code: 0, signal: null });
      },
      stderrTail: () => this.stderrLines.join("\n"),
      stop: async () => {
        this.stopped = true;
        this.exitCalls += 1;
        // A process the client had to stop is a process that never left on its
        // own: the fake only records the exit here when no exit() came first.
        this.settle({ code: null, signal: "SIGKILL" });
      },
    };
  }

  /**
   * Report the process gone. Held while a test says the process is still alive,
   * so a drain can be observed mid-flight and a caller that claims to have
   * finished closing can be caught doing so.
   */
  private settle(exit: ClaudeExitInfo): void {
    if (this.hasExited || this.exitHeld) {
      return;
    }
    this.hasExited = true;
    this.exited.resolve(exit);
    this.toClient.end();
  }

  /** Keep the process alive: its exit is reported only when the test releases it. */
  public holdExit(): void {
    this.exitHeld = true;
  }

  /** Let the held process go, as the OS finally taking it down would. */
  public releaseExit(code: number | null = 0): void {
    this.exitHeld = false;
    this.settle({ code, signal: null });
  }

  /** Writes frames to the client's stdout, as the CLI would. */
  public send(...frames: Frame[]): void {
    for (const frame of frames) {
      this.toClient.write(Buffer.from(`${JSON.stringify(frame)}\n`, "utf8"));
    }
  }

  /**
   * Script one turn's frames, but only once the CLI has been handed its prompt:
   * the real CLI writes no turn frame before it receives one, so a test cannot
   * script a turn early and have its frames land on an unsubscribed client.
   */
  public async scriptTurn(...frames: Frame[]): Promise<void> {
    await this.waitFor((frame) => frame.type === "user");
    this.send(...frames);
  }

  /**
   * Script one turn and hand back the prompt text the CLI was given for it: the
   * test checks what the adapter actually sent, not what it meant to send.
   */
  public async scriptTurnAndRead(...frames: Frame[]): Promise<string> {
    const prompt = await this.waitFor((frame) => frame.type === "user");
    this.send(...frames);
    const content = (prompt.message as { content?: Array<{ text?: string }> } | undefined)?.content ?? [];
    return content.map((block) => block.text ?? "").join("\n");
  }

  /** Writes raw bytes, so a test can split a frame where the OS might. */
  public sendRaw(chunk: string | Buffer): void {
    this.toClient.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
  }

  /** What the CLI wrote to stderr before dying. */
  public writeStderr(...lines: string[]): void {
    this.stderrLines.push(...lines);
  }

  /** The process exited; a turn still running ends with it. */
  public exit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.settle({ code, signal });
  }

  /** Resolves once the client has written a frame `matches` accepts. */
  public waitFor(matches: (frame: Frame) => boolean): Promise<Frame> {
    const seen = this.received.find(matches);
    if (seen) {
      return Promise.resolve(seen);
    }
    const waiter = createDeferred<Frame>();
    this.waiters.push({ matches, resolve: waiter.resolve });
    return waiter.promise;
  }

  /** The frame the client sent for `subtype`, waiting for it when needed. */
  public controlRequest(subtype: string): Promise<Frame> {
    return this.waitFor((frame) => frame.type === "control_request" && (frame.request as Frame)?.subtype === subtype);
  }
}

/**
 * A pool of fake processes. `nextPeer` hands the caller the process a start just
 * asked for, so a test can answer the handshake instead of racing it.
 */
export function fakeClaudeProcesses(
  onSpawn?: (peer: FakeClaude, options: ClaudeProcessOptions) => void,
): { processes: FakeClaude[]; spawnProcess: ClaudeProcessFactory; nextPeer(): Promise<FakeClaude> } {
  const processes: FakeClaude[] = [];
  const unclaimed: FakeClaude[] = [];
  const waiting: Array<(peer: FakeClaude) => void> = [];
  const spawnProcess: ClaudeProcessFactory = async (options) => {
    if (options.command.length === 0) {
      throw new Error("Claude CLI command is empty");
    }
    const peer = new FakeClaude(options);
    processes.push(peer);
    unclaimed.push(peer);
    onSpawn?.(peer, options);
    const waiter = waiting.shift();
    if (waiter) {
      waiter(unclaimed.shift()!);
    }
    return peer.handle;
  };
  const nextPeer = (): Promise<FakeClaude> => {
    const peer = unclaimed.shift();
    return peer ? Promise.resolve(peer) : new Promise((resolve) => waiting.push(resolve));
  };
  return { processes, spawnProcess, nextPeer };
}
