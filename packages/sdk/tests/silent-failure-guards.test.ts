import { readdirSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = resolve(fileURLToPath(new URL(".", import.meta.url)), "../src");

function sourceFiles(dir: string = SRC): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(full));
    } else if (entry.name.endsWith(".ts")) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Sites where discarding the rejection is the correct behaviour, each with the reason.
 * A new entry here is a deliberate, reviewable decision -- an unlisted one fails the build.
 */
const JUSTIFIED_DISCARDS: Record<string, string> = {
  "adapters/acp/BandACPServerAdapter.ts":
    "duplicate handle on a promise the enclosing Promise.race already surfaces",
};

describe("best-effort rejections are reported, not silently discarded", () => {
  it("no unjustified `.catch(() => undefined)` remains in src/", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      const rel = file.slice(SRC.length + 1).split(sep).join("/");
      if (!readFileSync(file, "utf-8").includes("catch(() => undefined)")) {
        continue;
      }
      if (!(rel in JUSTIFIED_DISCARDS)) {
        offenders.push(rel);
      }
    }

    expect(
      offenders,
      `these files discard a rejection with no logging and no entry in JUSTIFIED_DISCARDS:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("every justified discard still exists (the allowlist cannot go stale)", () => {
    for (const rel of Object.keys(JUSTIFIED_DISCARDS)) {
      const source = readFileSync(resolve(SRC, rel), "utf-8");
      expect(
        source.includes("catch(() => undefined)"),
        `${rel} is allowlisted but no longer discards a rejection -- remove the entry`,
      ).toBe(true);
    }
  });
});

describe("the silent-catch sites called out in the SDK review bind their error", () => {
  // Each of these logged nothing, or logged a message while dropping the error object.
  const FIXED_SITES: Array<[string, string]> = [
    ["runtime/rooms/AgentRuntime.ts", "agent_rooms / agent_contacts subscribe failures"],
    ["runtime/Execution.ts", "stale-message recovery and mark-failed"],
    ["agent/Agent.ts", "stop() after a failed start"],
    ["runtime/shutdown.ts", "forced exit when stop() throws"],
    ["mcp/server.ts", "MCP request handler 500s"],
    ["mcp/sse.ts", "SSE transport errors"],
  ];

  it.each(FIXED_SITES)("%s no longer uses an error-less catch (%s)", (rel) => {
    const source = readFileSync(resolve(SRC, rel), "utf-8");
    expect(source.includes("} catch {"), `${rel} still has an error-less catch`).toBe(false);
  });

  it("shutdown reports the reason before forcing an exit", () => {
    const source = readFileSync(resolve(SRC, "runtime/shutdown.ts"), "utf-8");
    // A process.exit(1) with no preceding log is the worst case: the agent dies on a
    // signal and the operator has nothing to go on.
    expect(source).toMatch(/logger\.error\([^)]*forcing exit/);
  });
});

describe("ExecutionContext composes ParticipantTracker rather than duplicating it", () => {
  it("routes add / remove / change-tracking through the tracker instance", async () => {
    const { ExecutionContext } = await import("../src/runtime/ExecutionContext");
    const { ParticipantTracker } = await import("../src/runtime/participantTracker");

    const context = new ExecutionContext({
      roomId: "room-1",
      link: {
        rest: { listChatParticipants: async () => [] },
        capabilities: {},
      } as unknown as ConstructorParameters<typeof ExecutionContext>[0]["link"],
      maxContextMessages: 10,
    });

    const tracker = (context as unknown as { participantTracker: unknown }).participantTracker;
    expect(tracker).toBeInstanceOf(ParticipantTracker);

    // Stub the composed instance and assert ExecutionContext delegates to it rather than
    // keeping a second copy of the same bookkeeping.
    const calls: string[] = [];
    const spy = tracker as Record<string, unknown>;
    const realUpsert = spy.upsert as (p: unknown) => void;
    const realRemove = spy.remove as (id: string) => boolean;
    const realMarkSent = spy.markSent as () => void;

    spy.upsert = function (p: unknown) { calls.push("upsert"); return realUpsert.call(this, p); };
    spy.remove = function (id: string) { calls.push("remove"); return realRemove.call(this, id); };
    spy.markSent = function () { calls.push("markSent"); return realMarkSent.call(this); };

    context.addParticipant({ id: "u1", name: "Jane", type: "User", handle: "@jane" });
    context.removeParticipant("u1");
    context.consumeParticipantsMessage();

    expect(calls).toContain("upsert");
    expect(calls).toContain("remove");
    expect(calls).toContain("markSent");
  });

  it("keeps the join/leave messages and change detection behaving as before", async () => {
    const { ExecutionContext } = await import("../src/runtime/ExecutionContext");

    const context = new ExecutionContext({
      roomId: "room-2",
      link: {
        rest: { listChatParticipants: async () => [] },
        capabilities: {},
      } as unknown as ConstructorParameters<typeof ExecutionContext>[0]["link"],
      maxContextMessages: 10,
    });

    context.addParticipant({ id: "u1", name: "Jane", type: "User", handle: "@jane" });
    const joined = context.consumeParticipantsMessage();
    expect(joined).toContain("Jane joined the room.");

    // Nothing changed since the last render: no message the second time.
    expect(context.consumeParticipantsMessage()).toBeNull();

    context.removeParticipant("u1");
    expect(context.consumeParticipantsMessage()).toContain("Jane left the room.");
  });
});
