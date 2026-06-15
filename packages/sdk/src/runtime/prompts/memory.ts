import { MEMORY_SYSTEM_TYPES } from "../../contracts/memory";
import { TOOL_MODELS } from "../tools/schemas";

const MEMORY_INTRO = `## Memory Tools

You have access to memory tools for storing and retrieving information
across conversations. Use \`thenvoi_store_memory\` to persist important
information and \`thenvoi_list_memories\` / \`thenvoi_get_memory\` to recall it.
Use \`thenvoi_supersede_memory\` to mark outdated memories and
\`thenvoi_archive_memory\` to hide memories that should be preserved.`;

const MEMORY_COMMON_PATTERNS = `Common patterns:
- Facts learned about a specific agent/entity: \`system="long_term"\`, \`type="semantic"\`, \`segment="agent"\`, \`scope="subject"\`
- Events involving a specific person/agent: \`system="long_term"\`, \`type="episodic"\`, \`segment="agent"\`, \`scope="subject"\`
- A user's preferences or profile info: \`system="long_term"\`, \`type="semantic"\`, \`segment="user"\`, \`scope="subject"\`
- Org-wide knowledge or how to perform a task: \`system="long_term"\`, \`type="procedural"\`, \`segment="tool"\`, \`scope="organization"\``;

const MEMORY_SCOPE_GUIDANCE = `Prefer \`scope="subject"\` whenever the memory is about a specific person or agent, so it
stays attached to that subject rather than leaking org-wide. Storing with \`scope="subject"\` requires a
real \`subject_id\` UUID, so resolve it first via \`thenvoi_lookup_peers\` or the participant list.
Reserve \`scope="organization"\` for knowledge that is genuinely shared across the whole organization and
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
