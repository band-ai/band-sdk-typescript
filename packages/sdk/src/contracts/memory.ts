// Single source of truth for the memory system -> valid types relationship.
// MemorySystem and MemoryType (re-exported from dtos.ts) and the prompt's
// system->type map all derive from MEMORY_SYSTEM_TYPES so they cannot drift.
export const MEMORY_SYSTEM_TYPES = {
  sensory: ["iconic", "echoic", "haptic"],
  working: ["episodic", "semantic", "procedural"],
  long_term: ["episodic", "semantic", "procedural"],
} as const;

export type MemorySystem = keyof typeof MEMORY_SYSTEM_TYPES;
export type MemoryType = (typeof MEMORY_SYSTEM_TYPES)[MemorySystem][number];

export const MEMORY_SYSTEMS = Object.keys(MEMORY_SYSTEM_TYPES) as MemorySystem[];
