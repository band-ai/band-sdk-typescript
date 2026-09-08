import { describe, expect, expectTypeOf, it } from "vitest";
import { validateMemoryTypeForSystem } from "@band-ai/band-sdk-core";

import {
  isMemoryTypeForSystem,
  MEMORY_SYSTEM_TYPES,
  MEMORY_SYSTEMS,
  MEMORY_TYPES,
} from "../src/contracts/memory";
import type { MemorySystem, MemoryType } from "../src/contracts/memory";
import type { MemorySystem as DtoMemorySystem, MemoryType as DtoMemoryType } from "../src/contracts/dtos";

describe("contracts/memory", () => {
  describe("MEMORY_SYSTEM_TYPES parity with band-sdk-core's own validation", () => {
    for (const system of MEMORY_SYSTEMS) {
      for (const type of MEMORY_TYPES) {
        const expectedValid = (MEMORY_SYSTEM_TYPES[system] as readonly string[]).includes(type);

        it(`"${system}" + "${type}" is ${expectedValid ? "accepted" : "rejected"} by validateMemoryTypeForSystem`, () => {
          if (expectedValid) {
            expect(() => validateMemoryTypeForSystem(system, type)).not.toThrow();
          } else {
            expect(() => validateMemoryTypeForSystem(system, type)).toThrow();
          }
        });
      }
    }
  });

  describe("validateMemoryTypeForSystem", () => {
    it("accepts every type paired with its own system, and passes traceContext through as null when omitted", () => {
      expect(() => validateMemoryTypeForSystem("sensory", "iconic")).not.toThrow();
      expect(() => validateMemoryTypeForSystem("working", "episodic")).not.toThrow();
      expect(() => validateMemoryTypeForSystem("long_term", "semantic")).not.toThrow();
    });

    it("throws with a `type` issue and the given traceContext for a wrong-tier type", () => {
      let caught: unknown;
      try {
        validateMemoryTypeForSystem("sensory", "semantic", "trace-123");
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(Error);
      const error = caught as Error & { issues: Array<{ path: string; code: string; message: string }>; traceContext: string | null };
      expect(error.traceContext).toBe("trace-123");
      expect(error.issues).toEqual([
        {
          path: "type",
          code: "invalid_value",
          message: expect.stringContaining("not valid for system"),
        },
      ]);
    });

    it("reports system and type as independent issues, and defaults traceContext to null", () => {
      let caught: unknown;
      try {
        validateMemoryTypeForSystem("nonsense-system", "nonsense-type");
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(Error);
      const error = caught as Error & { issues: Array<{ path: string; code: string }>; traceContext: string | null };
      expect(error.traceContext).toBeNull();
      expect(error.issues.map((issue) => issue.path)).toEqual(["system", "type"]);
      expect(error.issues.every((issue) => issue.code === "invalid_value")).toBe(true);
    });
  });

  describe("isMemoryTypeForSystem", () => {
    it("translates a successful validation into true", () => {
      expect(isMemoryTypeForSystem("sensory", "iconic")).toBe(true);
      expect(isMemoryTypeForSystem("working", "procedural")).toBe(true);
    });

    it("translates a thrown validation error into false rather than propagating it", () => {
      expect(isMemoryTypeForSystem("sensory", "semantic")).toBe(false);
      expect(isMemoryTypeForSystem("long_term", "iconic")).toBe(false);
    });
  });

  it("keeps MemorySystem/MemoryType re-exported from contracts/dtos in sync with band-sdk-core", () => {
    expectTypeOf<MemorySystem>().toEqualTypeOf<DtoMemorySystem>();
    expectTypeOf<MemoryType>().toEqualTypeOf<DtoMemoryType>();
  });
});
