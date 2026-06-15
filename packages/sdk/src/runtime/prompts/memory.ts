import {
  MEMORY_SEGMENT,
  MEMORY_STORE_SCOPE,
  MEMORY_SYSTEM,
  MEMORY_SYSTEM_TYPES,
  MEMORY_TYPE,
  type MemorySegment,
  type MemoryStoreScope,
  type MemorySystem,
} from "../../contracts/memory";
import { TOOL_MODELS } from "../tools/schemas";

const MEMORY_INTRO = `## Memory Tools

You have access to memory tools for storing and retrieving information
across conversations. Use \`thenvoi_store_memory\` to persist important
information and \`thenvoi_list_memories\` / \`thenvoi_get_memory\` to recall it.
Use \`thenvoi_supersede_memory\` to mark outdated memories and
\`thenvoi_archive_memory\` to hide memories that should be preserved.`;

type MemoryTypeForSystem<S extends MemorySystem> = (typeof MEMORY_SYSTEM_TYPES)[S][number];

type MemoryPattern<S extends MemorySystem> = {
  label: string;
  system: S;
  type: MemoryTypeForSystem<S>;
  segment: MemorySegment;
  scope: MemoryStoreScope;
};

function longTermPattern(
  label: string,
  type: MemoryTypeForSystem<typeof MEMORY_SYSTEM.long_term>,
  segment: MemorySegment,
  scope: MemoryStoreScope,
): MemoryPattern<typeof MEMORY_SYSTEM.long_term> {
  return {
    label,
    system: MEMORY_SYSTEM.long_term,
    type,
    segment,
    scope,
  };
}

const COMMON_MEMORY_PATTERNS = [
  longTermPattern("Facts learned about a specific agent/entity", MEMORY_TYPE.semantic, MEMORY_SEGMENT.agent, MEMORY_STORE_SCOPE.subject),
  longTermPattern("Events involving a specific person/agent", MEMORY_TYPE.episodic, MEMORY_SEGMENT.agent, MEMORY_STORE_SCOPE.subject),
  longTermPattern("A user's preferences or profile info", MEMORY_TYPE.semantic, MEMORY_SEGMENT.user, MEMORY_STORE_SCOPE.subject),
  longTermPattern("Org-wide knowledge or how to perform a task", MEMORY_TYPE.procedural, MEMORY_SEGMENT.tool, MEMORY_STORE_SCOPE.organization),
] as const;

function renderMemoryPattern(pattern: MemoryPattern<MemorySystem>): string {
  return `- ${pattern.label}: \`system="${pattern.system}"\`, \`type="${pattern.type}"\`, \`segment="${pattern.segment}"\`, \`scope="${pattern.scope}"\``;
}

const MEMORY_COMMON_PATTERNS = [
  "Common patterns:",
  ...COMMON_MEMORY_PATTERNS.map(renderMemoryPattern),
].join("\n");

const MEMORY_SCOPE_GUIDANCE = `Prefer \`scope="${MEMORY_STORE_SCOPE.subject}"\` whenever the memory is about a specific person or agent, so it
stays attached to that subject rather than leaking org-wide. Storing with \`scope="${MEMORY_STORE_SCOPE.subject}"\` requires a
real \`subject_id\` UUID, so resolve it first via \`thenvoi_lookup_peers\` or the participant list.
Reserve \`scope="${MEMORY_STORE_SCOPE.organization}"\` for knowledge that is genuinely shared across the whole organization and
is not about any one subject.`;

function quoteChoices(values: readonly string[]): string {
  return values.map((value) => `\`"${value}"\``).join(" | ");
}

function memoryTypeLines(): string {
  return Object.entries(MEMORY_SYSTEM_TYPES)
    .map(([system, types]) => `  - ${system}: ${quoteChoices(types)}`)
    .join("\n");
}

function buildMemorySection(): string {
  const storeMemoryProps = TOOL_MODELS.thenvoi_store_memory.properties;
  const systems = storeMemoryProps.system.enum as readonly string[];
  const segments = storeMemoryProps.segment.enum as readonly string[];
  const scopes = storeMemoryProps.scope.enum as readonly string[];

  const fieldRules = `When calling \`thenvoi_store_memory\`, the \`system\`, \`type\`, \`segment\`, and \`scope\` fields
must use these exact values (case-sensitive):

- **system**: ${quoteChoices(systems)}
- **type** (must match the chosen system):
${memoryTypeLines()}
- **segment**: ${quoteChoices(segments)}
- **scope**: ${quoteChoices(scopes)}`;

  return [MEMORY_INTRO, fieldRules, MEMORY_COMMON_PATTERNS, MEMORY_SCOPE_GUIDANCE].join("\n\n");
}

export const MEMORY_SECTION = buildMemorySection();
