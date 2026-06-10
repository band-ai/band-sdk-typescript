import { describe, expect, it } from "vitest";

import {
  MEMORY_SYSTEM_TYPE_MAP,
  TOOL_MODELS,
  getStoreMemoryPropertyEnum,
} from "../src/runtime/tools/schemas";

describe("memory schema", () => {
  it("keeps MEMORY_SYSTEM_TYPE_MAP in sync with store_memory schema enums", () => {
    const schemaSystems = new Set(getStoreMemoryPropertyEnum("system"));
    const schemaTypes = new Set(getStoreMemoryPropertyEnum("type"));
    const mappedSystems = new Set(Object.keys(MEMORY_SYSTEM_TYPE_MAP));
    const mappedTypes = new Set(Object.values(MEMORY_SYSTEM_TYPE_MAP).flat());

    expect(mappedSystems).toEqual(schemaSystems);
    expect(mappedTypes).toEqual(schemaTypes);
  });

  it("documents valid store_memory type pairings in the tool schema", () => {
    expect(TOOL_MODELS.thenvoi_store_memory.properties.type.description).toContain(
      "sensory=iconic/echoic/haptic",
    );
    expect(TOOL_MODELS.thenvoi_store_memory.properties.type.description).toContain(
      "working|long_term=episodic/semantic/procedural",
    );
  });
});
