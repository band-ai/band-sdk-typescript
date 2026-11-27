import { normalizeMentionHandle as stripHandlePrefix } from "../../runtime/formatters";

export { stripHandlePrefix };

export function dedupeHandles(handles: Iterable<string>): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();

  for (const handle of handles) {
    const normalized = stripHandlePrefix(handle);
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    deduped.push(normalized);
  }

  return deduped;
}
