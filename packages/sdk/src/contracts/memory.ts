/** Canonical memory enums; DTOs, tool schemas, and validation derive from these constants. */

const SENSORY_MEMORY_TYPES = [
  "iconic", // Visual input
  "echoic", // Auditory input
  "haptic", // Tactile input
] as const;

const COGNITIVE_MEMORY_TYPES = [
  "episodic", // Events that occurred
  "semantic", // Facts, preferences, learned knowledge
  "procedural", // How to perform tasks
] as const;

/** Which memory types are valid for each memory tier. */
export const MEMORY_SYSTEM_TYPES = {
  sensory: SENSORY_MEMORY_TYPES, // Brief sensory inputs
  working: COGNITIVE_MEMORY_TYPES, // Short-term session context
  long_term: COGNITIVE_MEMORY_TYPES, // Persistent cross-conversation memory
} as const;

export type MemorySystem = keyof typeof MEMORY_SYSTEM_TYPES;
export type MemoryType = (typeof MEMORY_SYSTEM_TYPES)[MemorySystem][number];

/** Memory tier; constrains valid `type` values via {@link MEMORY_SYSTEM_TYPES}. */
export const MEMORY_SYSTEMS = Object.keys(MEMORY_SYSTEM_TYPES) as readonly MemorySystem[];

/** Content kind; must match the chosen {@link MemorySystem}. */
export const MEMORY_TYPES = [
  ...SENSORY_MEMORY_TYPES,
  ...COGNITIVE_MEMORY_TYPES,
] as const satisfies readonly MemoryType[];
/** Logical subject category (user/agent/tool/guideline); not scope `subject` or `subject_id`. */
export const MEMORY_SEGMENTS = [
  "user", // User preferences or profile info
  "agent", // Facts or events about agents/entities
  "tool", // Tool usage or task procedures
  "guideline", // Behavioral rules or policies
] as const;
/** Visibility scope for `thenvoi_store_memory`. */
export const MEMORY_STORE_SCOPES = [
  "subject", // About one person/agent; requires subject_id
  "organization", // Shared org-wide
] as const;
/** Scope filter for `thenvoi_list_memories`. */
export const MEMORY_LIST_SCOPES = [
  "subject", // Subject-scoped memories only
  "organization", // Organization-scoped memories only
  "all", // Both scopes (no scope filter)
] as const;
/** Lifecycle state; list filter and set by supersede/archive tools. */
export const MEMORY_STATUSES = [
  "active", // Normal, visible memories
  "superseded", // Outdated; soft-deleted via thenvoi_supersede_memory
  "archived", // Hidden but preserved via thenvoi_archive_memory
  "all", // Any status (no filter)
] as const;

/** Logical subject category (user/agent/tool/guideline); not scope `subject` or `subject_id`. */
export type MemorySegment = (typeof MEMORY_SEGMENTS)[number];
export type MemoryStoreScope = (typeof MEMORY_STORE_SCOPES)[number];
export type MemoryScope = (typeof MEMORY_LIST_SCOPES)[number];
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];
/** Alias for {@link MemoryStoreScope} on store/write DTOs. */
export type MemoryVisibility = MemoryStoreScope;

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
