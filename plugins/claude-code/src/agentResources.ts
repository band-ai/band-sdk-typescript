import type { McpResourceSource } from "@band-ai/sdk/mcp";
import { McpError, type Resource } from "@modelcontextprotocol/sdk/types.js";

import { AGENT_TYPE, normalizeHandle, type Candidate } from "./names";

const AGENT_URI_PREFIX = "band://agent/";
const RESOURCE_NOT_FOUND = -32002;
const MIME_TYPE = "text/plain";

export function agentResourceUri(handle: string): string {
  return AGENT_URI_PREFIX + normalizeHandle(handle).split("/").map(encodeURIComponent).join("/");
}

interface Entry {
  readonly resource: Resource;
  readonly handle: string;
  readonly name: string;
  readonly description: string | null;
}

/** Only the current connection's advertised metadata, with no lookup on read. */
export class AgentResources implements McpResourceSource {
  public readonly name = "Band agents";
  public readonly uriTemplate = `${AGENT_URI_PREFIX}{+handle}`;
  public readonly exposeTemplate = false;
  private entries = new Map<string, Entry>();

  public list(): Resource[] {
    return [...this.entries.values()].map(({ resource }) => resource);
  }

  public read(uri: URL): ReturnType<McpResourceSource["read"]> {
    const entry = this.entries.get(uri.href);
    if (!entry) {
      throw new McpError(RESOURCE_NOT_FOUND, "Unknown Band agent resource");
    }
    const { handle, name, description } = entry;
    return { contents: [{ uri: uri.href, mimeType: MIME_TYPE, text: JSON.stringify({ handle, name, description }) }] };
  }

  public replace(peers: readonly Candidate[]): boolean {
    const next = new Map<string, Entry>();
    for (const peer of peers) {
      const handle = normalizeHandle(peer.handle);
      if (peer.type !== AGENT_TYPE || !handle) {
        continue;
      }
      const uri = agentResourceUri(handle);
      const description = peer.description?.trim() ? peer.description : null;
      next.set(uri, { handle, name: peer.name, description, resource: {
        uri, name: `@${handle}`, description: description ?? peer.name, mimeType: MIME_TYPE,
      } });
    }
    const changed = next.size !== this.entries.size || [...next].some(([uri, entry]) => {
      const previous = this.entries.get(uri);
      return !previous || entry.handle !== previous.handle || entry.name !== previous.name || entry.description !== previous.description
        || entry.resource.name !== previous.resource.name || entry.resource.description !== previous.resource.description
        || entry.resource.mimeType !== previous.resource.mimeType;
    });
    this.entries = new Map([...next].sort(([left], [right]) => left.localeCompare(right)));
    return changed;
  }
}
