import { describe, expect, expectTypeOf, it } from "vitest";
import { validateMemoryTypeForSystem } from "@band-ai/band-sdk-core";
import type { ValidationIssue } from "@band-ai/band-sdk-core";

import {
  isMemoryTypeForSystem,
  MEMORY_SYSTEM_TYPES,
  MEMORY_SYSTEMS,
  MEMORY_TYPES,
} from "../src/contracts/memory";
import type { MemorySystem, MemoryType } from "../src/contracts/memory";
import type { MemorySystem as DtoMemorySystem, MemoryType as DtoMemoryType } from "../src/contracts/dtos";

const INVALID_VALUE: ValidationIssue["code"] = "invalid_value";

type MemoryValidationError = Error & {
  issues: ValidationIssue[];
  traceContext: string | null;
};

function captureThrow(fn: () => void): MemoryValidationError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    return err as MemoryValidationError;
  }
  throw new Error("expected fn to throw");
}

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
    it("throws with a `type` issue and the given traceContext for a wrong-tier type", () => {
      const error = captureThrow(() => validateMemoryTypeForSystem("sensory", "semantic", "trace-123"));

      expect(error.traceContext).toBe("trace-123");
      expect(error.issues).toEqual([
        {
          path: "type",
          code: INVALID_VALUE,
          message: expect.stringContaining("not valid for system"),
        },
      ]);
    });

    it("reports system and type as independent issues, and defaults traceContext to null", () => {
      const error = captureThrow(() => validateMemoryTypeForSystem("nonsense-system", "nonsense-type"));

      expect(error.traceContext).toBeNull();
      expect(error.issues.map((issue) => issue.path)).toEqual(["system", "type"]);
      expect(error.issues.every((issue) => issue.code === INVALID_VALUE)).toBe(true);
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

    it("rethrows a non-validation error instead of collapsing it to false", () => {
      // A non-string `type` reaching this boundary (e.g. malformed tool-call
      // arguments) throws a plain Error with no `.issues`, unlike a real
      // system/type mismatch - that must surface, not read as "invalid pair".
      expect(() => isMemoryTypeForSystem("sensory", 42 as unknown as MemoryType)).toThrow();
    });
  });

  it("keeps MemorySystem/MemoryType re-exported from contracts/dtos in sync with band-sdk-core", () => {
    expectTypeOf<MemorySystem>().toEqualTypeOf<DtoMemorySystem>();
    expectTypeOf<MemoryType>().toEqualTypeOf<DtoMemoryType>();
  });
});
