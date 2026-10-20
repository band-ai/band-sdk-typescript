import { describe, expect, it } from "vitest";
import { trackNativeActivity, type NativeActivity } from "../src/runtime/workingState";
import { scopedActivity } from "./support/scopedActivity";

/** What a turn publishes as `steps` drive its native activity, each delivered before the next. */
async function published(steps: ReadonlyArray<(native: NativeActivity) => void>) {
  return (await shownAfterEach(steps)).reports;
}

/** Every report, and the activity shown once each step is delivered. */
async function shownAfterEach(steps: ReadonlyArray<(native: NativeActivity) => void>) {
  await using scope = await scopedActivity();
  const native = trackNativeActivity(scope.tools, new Set());
  const shown = [];
  for (const step of steps) {
    step(native);
    await scope.lease.flush();
    shown.push(scope.reports.entries.at(-1));
  }
  return { reports: [...scope.reports.entries], shown };
}

describe("native activity", () => {
  it("waits on a human while any decision is open", async () => {
    const { shown } = await shownAfterEach([
      (native) => native.wait("first"),
      (native) => native.wait("second"),
      (native) => native.endWait("first"),
      (native) => native.endWait("second"),
    ]);
    expect(shown).toEqual([{ kind: "permission" }, { kind: "permission" }, { kind: "permission" }, { kind: "reasoning" }]);
  });

  it("shows a running tool again once the wait over it ends", async () => {
    expect(await published([
      (native) => native.tool("call", "bash"),
      (native) => native.wait("ask"),
      (native) => native.endWait("ask"),
    ])).toEqual([{ kind: "reasoning" }, { kind: "tool_call", name: "bash" }, { kind: "permission" }, { kind: "tool_call", name: "bash" }]);
  });

  it("ignores the end of a wait it never opened", async () => {
    expect(await published([
      (native) => native.tool("call", "bash"),
      (native) => native.endWait("unknown"),
    ])).toEqual([{ kind: "reasoning" }, { kind: "tool_call", name: "bash" }]);
  });

  it("ends tools and waits at once, and reports nothing that arrives after", async () => {
    expect(await published([
      (native) => native.tool("call", "bash"),
      (native) => native.wait("ask"),
      (native) => native.endAll(),
      (native) => native.wait("late"),
      (native) => native.tool("later", "grep"),
      (native) => native.memory("compaction"),
    ])).toEqual([{ kind: "reasoning" }, { kind: "tool_call", name: "bash" }, { kind: "permission" }, { kind: "reasoning" }]);
  });
});
