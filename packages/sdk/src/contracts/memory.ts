// Single source of truth for the memory enums (systems, types, segments,
// scopes, statuses) and the system -> valid types relationship. The DTO types
// (re-exported from dtos.ts), the JSON-schema enums in tools/schemas.ts, and
// the validation guards in tools/AgentTools.ts all derive from these constants
// so they cannot drift.
export const MEMORY_SYSTEMS = ["sensory", "working", "long_term"] as const;
export const MEMORY_TYPES = [
  "iconic",
  "echoic",
  "haptic",
  "episodic",
  "semantic",
  "procedural",
] as const;
export const MEMORY_SEGMENTS = ["user", "agent", "tool", "guideline"] as const;
export const MEMORY_STORE_SCOPES = ["subject", "organization"] as const;
export const MEMORY_LIST_SCOPES = ["subject", "organization", "all"] as const;
export const MEMORY_STATUSES = ["active", "superseded", "archived", "all"] as const;

export type MemorySystem = (typeof MEMORY_SYSTEMS)[number];
export type MemoryType = (typeof MEMORY_TYPES)[number];
export type MemorySegment = (typeof MEMORY_SEGMENTS)[number];
export type MemoryStoreScope = (typeof MEMORY_STORE_SCOPES)[number];
export type MemoryScope = (typeof MEMORY_LIST_SCOPES)[number];
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];
export type MemoryVisibility = MemoryStoreScope;

// Which memory types are valid for each system. The `satisfies` clause keeps
// this in lock-step with MEMORY_SYSTEMS and MEMORY_TYPES: a missing system key
// or an unknown type becomes a compile error.
export const MEMORY_SYSTEM_TYPES = {
  sensory: ["iconic", "echoic", "haptic"],
  working: ["episodic", "semantic", "procedural"],
  long_term: ["episodic", "semantic", "procedural"],
} as const satisfies Record<MemorySystem, readonly MemoryType[]>;

export function isMemorySystem(value: string): value is MemorySystem {
  return (MEMORY_SYSTEMS as readonly string[]).includes(value);
}

export function isMemoryType(value: string): value is MemoryType {
  return (MEMORY_TYPES as readonly string[]).includes(value);
}

export function isMemorySegment(value: string): value is MemorySegment {
  return (MEMORY_SEGMENTS as readonly string[]).includes(value);
}

export function isMemoryStoreScope(value: string): value is MemoryStoreScope {
  return (MEMORY_STORE_SCOPES as readonly string[]).includes(value);
}

export function isMemoryListScope(value: string): value is MemoryScope {
  return (MEMORY_LIST_SCOPES as readonly string[]).includes(value);
}

export function isMemoryStatus(value: string): value is MemoryStatus {
  return (MEMORY_STATUSES as readonly string[]).includes(value);
}

export function expectedList(values: readonly string[]): string {
  return values.join(", ");
}
