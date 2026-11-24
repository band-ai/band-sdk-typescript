import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { onTestFinished, vi } from "vitest";

import { createDeferred } from "../src/core/deferred";
import type { Logger } from "../src/core/logger";
import { canonicalPlatformIdentity } from "../src/runtime/journal/identity";
import { identityRoomFile, agentJournalDir, legacyAgentDir } from "../src/runtime/journal/records";
import { TurnJournal, type JournalGeneration } from "../src/runtime/journal/TurnJournal";
import { RoomJournal } from "../src/runtime/journal/RoomJournal";
import { tmpRoot } from "./testUtils";

/** The canonical platform identity the tests bind their journals to. */
export const IDENTITY = canonicalPlatformIdentity("https://band.example");

/** A second platform, for tests that bind a journal to the wrong identity. */
export const OTHER_IDENTITY = canonicalPlatformIdentity("https://other.example");

export const AGENT = "agent/one";
export const ROOM = "room/with:odd chars";

type AppendFile = (...args: unknown[]) => Promise<void>;

/** Replaces Node's `FileHandle[method]` with `replacement`, which gets the original; restored when the test ends. */
async function interceptFileHandle(method: "appendFile" | "writeFile", replacement: (original: AppendFile, self: unknown, args: unknown[]) => Promise<void>): Promise<void> {
  const probe = await open(path.join(tmpRoot(), "probe"), "w");
  const prototype = Object.getPrototypeOf(probe) as Record<typeof method, AppendFile>;
  await probe.close();
  const original = prototype[method];
  const spy = vi.spyOn(prototype, method).mockImplementation(function (this: unknown, ...args: unknown[]) {
    return replacement(original, this, args);
  });
  onTestFinished(() => spy.mockRestore());
}

/**
 * Replaces Node's `FileHandle.appendFile`, the fs boundary every journal write
 * goes through, with `append`, which gets the original; restored when the test ends.
 */
export function interceptJournalAppends(append: (original: AppendFile, self: unknown, args: unknown[]) => Promise<void>): Promise<void> {
  return interceptFileHandle("appendFile", append);
}

/** Holds the first whole-file journal write (a new file's header, a rewrite's copy) until `release()`. */
export async function holdJournalRewrite(): Promise<{ entered: Promise<void>; release: () => void }> {
  const entered = createDeferred();
  const released = createDeferred();
  onTestFinished(() => released.resolve());
  let held = false;
  await interceptFileHandle("writeFile", async (original, self, args) => {
    if (!held) {
      held = true;
      entered.resolve();
      await released.promise;
    }
    return original.apply(self, args);
  });
  return { entered: entered.promise, release: () => released.resolve() };
}

/**
 * Whole-file journal write faults: `failNext` fails the next write whose text
 * matches with a full disk. Nothing of it lands, so the files stand as a crash
 * at that write leaves them.
 */
export async function journalRewriteFaults(): Promise<{ failNext: (matches: (text: string) => boolean) => void }> {
  let armed: ((text: string) => boolean) | undefined;
  await interceptFileHandle("writeFile", async (original, self, args) => {
    if (armed !== undefined && typeof args[0] === "string" && armed(args[0])) {
      armed = undefined;
      throw diskFull();
    }
    return original.apply(self, args);
  });
  return {
    failNext: (matches) => {
      armed = matches;
    },
  };
}

/** Holds the first journal append whose line matches `matches` until `release()`; the others write as usual. */
export async function holdJournalAppend(matches: (line: string) => boolean): Promise<{ entered: Promise<void>; release: () => void }> {
  const entered = createDeferred();
  const released = createDeferred();
  onTestFinished(() => released.resolve());
  let held = false;
  await interceptJournalAppends(async (original, self, args) => {
    if (!held && typeof args[0] === "string" && matches(args[0])) {
      held = true;
      entered.resolve();
      await released.promise;
    }
    return original.apply(self, args);
  });
  return { entered: entered.promise, release: () => released.resolve() };
}

/** The path of `roomId`'s v2 journal file under `dir`, in `identity`'s directory. */
export function roomFile(
  dir: string,
  identity: string = IDENTITY,
  agentId: string = AGENT,
  roomId: string = ROOM,
): string {
  return identityRoomFile(agentJournalDir(dir, agentId), identity, roomId);
}

/** The file name a v1 process gave `roomId`'s journal: its id, percent-encoded. */
export const legacyRoomFile = (roomId: string = ROOM) => `${encodeURIComponent(roomId)}.jsonl`;

/** The records of a journal file, header excluded, in file order. */
export async function journalLines(file: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(file, "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line.t !== "header");
}

/** The record types in a journal file, in order. */
export async function recordTypes(file: string): Promise<string[]> {
  return (await journalLines(file)).map((line) => String(line.t));
}

/** One agent's journal under `dir`, on `clock` when given, activated under `identity`; its generation closes when the test ends. */
export async function generationIn(
  dir: string,
  options: { identity?: string; agentId?: string; logger?: Logger } = {},
): Promise<{ journals: TurnJournal; generation: JournalGeneration }> {
  const identity = options.identity ?? IDENTITY;
  const agentId = options.agentId ?? AGENT;
  const journals = new TurnJournal(dir, agentId, {
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  });
  const generation = await journals.activate(identity);
  onTestFinished(() => generation.close());
  return { journals, generation };
}

/** A room's journal opened directly against its file, under `identity`. */
export function roomJournalIn(
  dir: string,
  options: { identity?: string; agentId?: string; roomId?: string; logger?: Logger } = {},
): Promise<RoomJournal> {
  const identity = options.identity ?? IDENTITY;
  const agentId = options.agentId ?? AGENT;
  const roomId = options.roomId ?? ROOM;
  return RoomJournal.open(roomFile(dir, identity, agentId, roomId), {
    platformIdentity: identity,
    agentId,
    roomId,
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  });
}

/** Writes `lines` raw to the room's v2 file path (creating its identity directory). */
export async function writeRawFile(dir: string, identity: string, lines: string[]): Promise<string> {
  const file = roomFile(dir, identity);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, lines.join(""));
  return file;
}

/** Writes what a legacy (v1) process of `agentId` journaled, under the pre-v2 (percent-encoded) layout. */
export async function seedLegacyFile(dir: string, agentId: string, fileName: string, lines: string[]): Promise<string> {
  const agentDir = legacyAgentDir(dir, agentId);
  await mkdir(agentDir, { recursive: true });
  const file = path.join(agentDir, fileName);
  await writeFile(file, lines.map((line) => (line.endsWith("\n") ? line : `${line}\n`)).join(""));
  return file;
}

/** The error a full disk fails a write with. */
export function diskFull(): Error {
  return Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
}
/**
 * Settles once every queued microtask, and every one those queue, has run: a
 * macrotask runs only on an empty microtask queue. Proves an operation that
 * needs no I/O to finish is parked, never that I/O completed.
 */
export function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
