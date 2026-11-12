import type { ToolSchemaProvider } from "../contracts/protocols";
import { RuntimeStateError } from "../core/errors";
import { guardedTools } from "../core/overrideTools";

/**
 * Tool members that only describe the tools and reach nothing, so a cut-short
 * turn may still read them. Keyed by the whole interface, so a new describing
 * member fails typecheck until it is listed here.
 */
const DESCRIBING_TOOLS: ReadonlySet<PropertyKey> = new Set(Object.keys({
  getToolSchemas: true,
  getAnthropicToolSchemas: true,
  getOpenAIToolSchemas: true,
} satisfies Record<keyof ToolSchemaProvider, true>));

/**
 * `tools`, refusing every call that acts once `stopped` aborts, with a
 * rejected promise as an async tool fails. A turn a pause or an interrupt
 * cut short may keep running in an adapter that cannot cancel it; nothing it
 * does after that reaches Band, so a room that resumes never holds both its
 * reply and the replay's.
 */
export function revokedOnStop<T extends object>(tools: T, stopped: AbortSignal): T {
  return guardedTools(tools, (key) => (DESCRIBING_TOOLS.has(key) ? null : cutShort(stopped)));
}

/** The error a cut-short turn's call is refused with, or null while the turn runs. */
export function cutShort(stopped: AbortSignal): RuntimeStateError | null {
  return stopped.aborted ? new RuntimeStateError(`This turn was cut short (${String(stopped.reason)}); its tools no longer act`) : null;
}
