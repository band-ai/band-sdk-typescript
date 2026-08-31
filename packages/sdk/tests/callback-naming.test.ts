import { describe, expectTypeOf, expect, it } from "vitest";

import type {
  ContactEventCallback as RootContactEventCallback,
  OnContactEventCallback as RootOnContactEventCallback,
} from "../src/index";
import type {
  ContactEventCallback as RuntimeContactEventCallback,
  ContactEventConfig,
  OnContactEventCallback as RuntimeOnContactEventCallback,
} from "../src/runtime";
import type {
  ExecutionContextFactory,
  OnBroadcastCallback,
  OnContactEventDispatchCallback,
  OnErrorCallback,
  OnExecuteCallback,
  OnHubEventCallback,
  OnHubInitCallback,
  OnParticipantAddedCallback,
  OnParticipantRemovedCallback,
  OnRoomJoinedCallback,
  OnRoomLeftCallback,
  OnSessionCleanupCallback,
  RoomFilter,
} from "../src/runtime/callbacks";

describe("the renamed contact-event callback type", () => {
  it("keeps the old name assignable to the new one, and back", () => {
    expectTypeOf<RootContactEventCallback>().toEqualTypeOf<RootOnContactEventCallback>();
    expectTypeOf<RuntimeContactEventCallback>().toEqualTypeOf<RuntimeOnContactEventCallback>();

    const viaOldName: RootContactEventCallback = async () => undefined;
    const viaNewName: RootOnContactEventCallback = viaOldName;
    const backAgain: RootContactEventCallback = viaNewName;
    expectTypeOf(backAgain).toEqualTypeOf<RootContactEventCallback>();
  });

  it("is the type the config field uses", () => {
    expectTypeOf<NonNullable<ContactEventConfig["onEvent"]>>()
      .toEqualTypeOf<RootOnContactEventCallback>();
  });

  it("is exported from both the root and the runtime subpath", async () => {
    // Type-only exports leave no runtime binding, so assert on the emitted declarations.
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    for (const entry of ["src/index.ts", "src/runtime/index.ts"]) {
      const source = readFileSync(resolve(__dirname, "..", entry), "utf-8");
      expect(source, `${entry} must export OnContactEventCallback`)
        .toContain("OnContactEventCallback");
      expect(source, `${entry} must keep exporting ContactEventCallback`)
        .toContain("ContactEventCallback");
    }
  });
});

describe("the runtime callback shapes", () => {
  it("describe the signatures the runtime options reference", () => {
    expectTypeOf<OnSessionCleanupCallback>().parameters.toEqualTypeOf<[string]>();
    expectTypeOf<OnRoomLeftCallback>().parameters.toEqualTypeOf<[string]>();
    expectTypeOf<OnRoomJoinedCallback>().parameters.toExtend<[string, object]>();
    expectTypeOf<OnParticipantRemovedCallback>().parameters.toEqualTypeOf<[string, string]>();
    expectTypeOf<RoomFilter>().returns.toEqualTypeOf<boolean>();
    expectTypeOf<OnBroadcastCallback>().parameters.toEqualTypeOf<[string]>();
    expectTypeOf<OnHubInitCallback>().parameters.toEqualTypeOf<[string, string]>();
    expectTypeOf<OnErrorCallback>().returns.toEqualTypeOf<void>();

    // Named only to prove they exist and are importable from one module.
    expectTypeOf<OnExecuteCallback>().toBeFunction();
    expectTypeOf<OnContactEventDispatchCallback>().toBeFunction();
    expectTypeOf<OnParticipantAddedCallback>().toBeFunction();
    expectTypeOf<OnHubEventCallback>().toBeFunction();
    expectTypeOf<ExecutionContextFactory>().toBeFunction();
  });
});
