import { beforeAll, describe, expect, expectTypeOf, it } from "vitest";

import {
  Agent,
  BandLink,
  PlatformRuntime,
} from "../src/index";
import type { CustomToolDef as PublicCustomToolDef } from "../src/index";
import { AgentTools, Execution, RoomPresence } from "../src/runtime";
import { RestFacade, type RestApi } from "../src/rest";
import type { CustomToolDef as InternalCustomToolDef } from "../src/runtime/tools/customTools";
import { importDistEsm, readDistTypes, requireDistCjs, type Mod } from "./distSurface";

class ContractRestApi implements RestApi {
  public async getAgentMe() {
    return { id: "a1", name: "Agent", description: "desc" };
  }
  public async createChatMessage() {
    return { ok: true };
  }
  public async createChatEvent() {
    return { ok: true };
  }
  public async createChat() {
    return { id: "room" };
  }
  public async listChatParticipants() {
    return [];
  }
  public async addChatParticipant() {
    return { ok: true };
  }
  public async removeChatParticipant() {
    return { ok: true };
  }
  public async markMessageProcessing() {
    return { ok: true };
  }
  public async markMessageProcessed() {
    return { ok: true };
  }
  public async markMessageFailed() {
    return { ok: true };
  }
  public async listPeers() {
    return { data: [] };
  }
  public async listContacts() {
    return {
      data: [{ id: "contact-1", handle: "@jane", name: "Jane", type: "User" }],
      metadata: { page: 1, pageSize: 50, totalCount: 1, totalPages: 1 },
    };
  }
  public async addContact() {
    return { id: "request-1", status: "pending" };
  }
  public async removeContact() {
    return { status: "removed" };
  }
  public async listContactRequests() {
    return {
      received: [{ id: "request-1", from_handle: "@jane", status: "pending" }],
      sent: [{ id: "request-2", to_handle: "@weather", status: "approved" }],
      metadata: { page: 1, pageSize: 50, received: { total: 1 }, sent: { total: 1 } },
    };
  }
  public async respondContactRequest() {
    return { id: "request-1", status: "approved" };
  }
  public async listMemories() {
    return {
      data: [{
        id: "memory-1",
        content: "Jane likes tea",
        system: "long_term" as const,
        type: "semantic" as const,
        segment: "user" as const,
        status: "active" as const,
      }],
      metadata: { pageSize: 50, totalCount: 1 },
    };
  }
  public async storeMemory() {
    return {
      id: "memory-2",
      content: "Jane prefers tea",
      system: "long_term" as const,
      type: "semantic" as const,
      segment: "user" as const,
      status: "active" as const,
    };
  }
  public async getMemory(memoryId: string) {
    return {
      id: memoryId,
      content: "Jane likes tea",
      system: "long_term" as const,
      type: "semantic" as const,
      segment: "user" as const,
      status: "active" as const,
    };
  }
  public async supersedeMemory(memoryId: string) {
    return { id: memoryId, status: "superseded" };
  }
  public async archiveMemory(memoryId: string) {
    return { id: memoryId, status: "archived" };
  }
}

describe("sdk contract", () => {
  it("re-exports CustomToolDef from the root SDK entrypoint", () => {
    expectTypeOf<PublicCustomToolDef>().toEqualTypeOf<InternalCustomToolDef>();
  });

  it("exposes lifecycle methods", () => {
    expect(typeof Agent.prototype.start).toBe("function");
    expect(typeof Agent.prototype.stop).toBe("function");
    expect(typeof Agent.prototype.run).toBe("function");
    expect(typeof Agent.prototype.runForever).toBe("function");

    expect(typeof PlatformRuntime.prototype.initialize).toBe("function");
    expect(typeof PlatformRuntime.prototype.start).toBe("function");
    expect(typeof PlatformRuntime.prototype.stop).toBe("function");
    expect(typeof Execution.prototype.enqueue).toBe("function");
    expect(typeof RoomPresence.prototype.start).toBe("function");
    expect(typeof RoomPresence.prototype.stop).toBe("function");

    expect(typeof BandLink.prototype.markProcessing).toBe("function");
    expect(typeof BandLink.prototype.markProcessed).toBe("function");
    expect(typeof BandLink.prototype.markFailed).toBe("function");
  });

  it("exposes working contact and memory tools when REST adapter supports them", async () => {
    const tools = new AgentTools({
      roomId: "room-1",
      rest: new RestFacade({ api: new ContractRestApi() }),
      capabilities: {
        contacts: true,
        memory: true,
      },
    });

    await expect(tools.listContacts()).resolves.toMatchObject({
      data: [{ id: "contact-1", handle: "@jane" }],
    });
    await expect(tools.listContactRequests()).resolves.toMatchObject({
      received: [{ id: "request-1" }],
      sent: [{ id: "request-2" }],
    });
    await expect(
      tools.storeMemory({
        content: "Jane prefers tea",
        system: "long_term",
        type: "semantic",
        segment: "user",
        thought: "Useful preference",
      }),
    ).resolves.toMatchObject({
      id: "memory-2",
      status: "active",
    });
    await expect(tools.getMemory("memory-1")).resolves.toMatchObject({ id: "memory-1" });
    await expect(tools.supersedeMemory("memory-1")).resolves.toEqual({
      id: "memory-1",
      status: "superseded",
    });
    await expect(tools.archiveMemory("memory-1")).resolves.toEqual({
      id: "memory-1",
      status: "archived",
    });
  });
});

// Everything above is pinned against src. A consumer only ever sees dist, and the two can
// disagree: a class exported inside an `export type {}` block type-checks in src but has no
// runtime binding in the build. So pin the same symbols against the built entry for the
// subpath each one is documented under.
describe("every symbol this contract pins is also reachable from the built package", () => {
  const VALUE_EXPORTS_BY_SUBPATH: Record<string, readonly string[]> = {
    ".": ["Agent", "BandLink", "PlatformRuntime", "HistoryProvider"],
    "./runtime": ["AgentTools", "Execution", "RoomPresence"],
    "./rest": ["RestFacade"],
  };

  const TYPE_EXPORTS_BY_SUBPATH: Record<string, readonly string[]> = {
    ".": ["CustomToolDef"],
    "./rest": ["RestApi"],
  };

  const flatten = (bySubpath: Record<string, readonly string[]>) =>
    Object.entries(bySubpath).flatMap(([subpath, names]) =>
      names.map((name) => [subpath, name] as const),
    );

  const valueCases = flatten(VALUE_EXPORTS_BY_SUBPATH);
  const esm: Record<string, Mod> = {};

  beforeAll(async () => {
    for (const subpath of Object.keys(VALUE_EXPORTS_BY_SUBPATH)) {
      esm[subpath] = await importDistEsm(subpath);
    }
  });

  it.each(valueCases)(
    "%s exports %s as a constructable value from the built ESM entry",
    (subpath, name) => {
      expect(typeof esm[subpath]?.[name], `${name} missing from the ESM build of ${subpath}`)
        .toBe("function");
    },
  );

  it.each(valueCases)("%s exports %s from the built CJS entry too", (subpath, name) => {
    expect(typeof requireDistCjs(subpath)[name], `${name} missing from the CJS build of ${subpath}`)
      .toBe("function");
  });

  it.each(flatten(TYPE_EXPORTS_BY_SUBPATH))("%s declares the type %s in its built .d.ts", (subpath, name) => {
    // Types have no runtime binding, so the declaration file is the only place to look.
    expect(new RegExp(`\\b${name}\\b`).test(readDistTypes(subpath)),
      `${name} missing from the declarations of ${subpath}`).toBe(true);
  });
});
