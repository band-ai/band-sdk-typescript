import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { expect, onTestFinished } from "vitest";

/** How much of a child's stderr a failure carries: enough for its last stack. */
const STDERR_TAIL_CHARS = 4000;

/** What a child runtime reports over its IPC pipe. */
interface ChildMessage {
  type: "boundary" | "failure";
  name?: string;
  message?: string;
}

export interface ChildRun {
  child: ChildProcess;
  /** Resolves once the child reports `name`; rejects if it fails or exits first. */
  boundary: (name: string) => Promise<void>;
  send: (message: { type: string }) => void;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/**
 * Starts `script` through tsx with an IPC pipe and watches it for its boundary
 * messages. The pipe is the child's liveness anchor: a boundary it reports is
 * one a still-living process reached.
 */
export function startChild(script: string, args: readonly string[]): ChildRun {
  const child = spawn(process.execPath, ["--import", "tsx", script, ...args], {
    cwd: path.join(__dirname, "..", ".."),
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: process.env,
  });
  // Drained so a chatty child never blocks on a full pipe; its tail explains an early exit.
  let stderrTail = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
  });
  const seen: string[] = [];
  const waiters: Array<{ name: string; resolve: () => void }> = [];
  const failers: Array<(error: Error) => void> = [];
  let failed: Error | undefined;
  const fail = (error: Error): void => {
    failed ??= error;
    for (const failer of failers.splice(0)) failer(failed);
  };
  child.on("message", (message: ChildMessage) => {
    if (message.type === "failure") {
      fail(new Error(`the child failed: ${message.message ?? "no message"}`));
      return;
    }
    if (message.type !== "boundary" || message.name === undefined) return;
    seen.push(message.name);
    for (const [index, waiter] of [...waiters.entries()].reverse()) {
      if (waiter.name === message.name) {
        waiters.splice(index, 1);
        waiter.resolve();
      }
    }
  });
  child.on("error", fail);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    // "close" follows the stdio streams' end, so the stderr tail is complete.
    child.once("close", (code, signal) => {
      fail(new Error(`the child exited (${signal ?? code}) before its boundary${stderrTail === "" ? "" : `; stderr:\n${stderrTail}`}`));
      resolve({ code, signal });
    });
  });
  // A child that exits or fails before reporting rejects the wait; the test's own timeout bounds a hung one.
  const boundary = (name: string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (seen.includes(name)) return resolve();
      if (failed !== undefined) return reject(failed);
      waiters.push({ name, resolve });
      failers.push(reject);
    });
  return { child, boundary, send: (message) => child.send(message), exited };
}

/**
 * Runs `script` to the boundary `reach` awaits, SIGKILLs it there, and reads the
 * state it wrote at that boundary. The child was alive at the kill, so only the
 * OS released its locks afterwards.
 */
export async function driveChild<S>(script: string, args: readonly string[], stateFile: string, reach: (run: ChildRun) => Promise<void>): Promise<S> {
  const run = startChild(script, args);
  onTestFinished(() => {
    if (run.child.exitCode === null && !run.child.killed) run.child.kill("SIGKILL");
  });
  await reach(run);
  run.child.kill("SIGKILL");
  const exit = await run.exited;
  expect(exit.signal, `the child was alive at its boundary, so its death is the SIGKILL's: got code=${exit.code} signal=${exit.signal}`).toBe("SIGKILL");
  expect(exit.code).toBe(null);
  return JSON.parse(await readFile(stateFile, "utf8")) as S;
}
