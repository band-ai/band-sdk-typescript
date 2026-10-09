import { ensureHandlePrefix } from "@band-ai/sdk/runtime";

/** How many candidates an error lists before "and N more". */
export const CANDIDATE_LIST_LIMIT = 20;

/** Band's participant type for agents; only agents' descriptions are searched. */
export const AGENT_TYPE = "Agent";

/** Someone a name can resolve to: a peer or a room participant. */
export interface Candidate {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly handle?: string | null;
  readonly description?: string | null;
}

export type Resolution =
  | { readonly kind: "match"; readonly candidate: Candidate }
  | { readonly kind: "ambiguous"; readonly candidates: readonly Candidate[] }
  | { readonly kind: "unknown" };

/** A name or handle as compared: no leading `@`s, any case. */
export function normalizeHandle(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/^@+/, "").toLowerCase();
}

/** How results and lists name someone: the handle, or the name when Band has none. */
export function handleOf({ handle, name }: Pick<Candidate, "handle" | "name">): string {
  return ensureHandlePrefix(handle) ?? name;
}

/** A saved agent as the user knows it: its name, and its Band handle when known. */
export function agentLabel(name: string, handle: string | null | undefined): string {
  const at = ensureHandlePrefix(handle);
  return at ? `${name} (${at})` : name;
}

/** An exact id or handle wins; otherwise every word of `entry` must appear in the handle, name or an agent's description. */
export function resolveName(entry: string, candidates: readonly Candidate[]): Resolution {
  const exact = candidates.find(({ id, handle }) => id === entry.trim() || (handle && normalizeHandle(handle) === normalizeHandle(entry)));
  if (exact) {
    return { kind: "match", candidate: exact };
  }
  const matches = candidates.filter((candidate) => matchesWords(candidate, entry));
  if (matches.length === 1) {
    return { kind: "match", candidate: matches[0] };
  }
  return matches.length > 1 ? { kind: "ambiguous", candidates: matches } : { kind: "unknown" };
}

/** Whether every word of `query` appears in the candidate's handle, name or, for an agent, description; a blank query matches no one. */
export function matchesWords(candidate: Candidate, query: string): boolean {
  const words = normalizeHandle(query).split(/\s+/).filter(Boolean);
  const fields = [candidate.handle, candidate.name, candidate.type === AGENT_TYPE ? candidate.description : null]
    .map((field) => (field ?? "").toLowerCase());
  return words.length > 0 && words.every((word) => fields.some((field) => field.includes(word)));
}

/**
 * Resolves every entry against `pool`, or throws the error Claude acts on: the candidates to
 * pick from with AskUserQuestion, or who `pool` holds. `poolName` says who that is.
 */
export function resolveAll(entries: readonly string[], pool: readonly Candidate[], poolName: string): Candidate[] {
  return entries.map((entry) => {
    const resolution = resolveName(entry, pool);
    if (resolution.kind === "match") {
      return resolution.candidate;
    }
    throw new Error(resolution.kind === "ambiguous"
      ? `"${entry}" matches several; nothing was done. Let the user pick one with AskUserQuestion, then call again with its handle:\n${listCandidates(resolution.candidates)}`
      : `Nobody matches "${entry}"; nothing was done. ${poolName}:\n${listCandidates(pool)}`);
  });
}

/** One `@handle — description` line each, the first `CANDIDATE_LIST_LIMIT`, then "and N more". */
export function listCandidates(candidates: readonly Candidate[]): string {
  if (candidates.length === 0) {
    return "(nobody)";
  }
  const lines = candidates.slice(0, CANDIDATE_LIST_LIMIT).map((candidate) =>
    candidate.description ? `${handleOf(candidate)} — ${candidate.description}` : handleOf(candidate));
  const more = candidates.length - CANDIDATE_LIST_LIMIT;
  return [...lines, ...(more > 0 ? [`and ${more} more`] : [])].join("\n");
}
