import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..", "src");
const SCANNED = ["adapters", "core"];

// A post that counts as the turn's reply: `x.sendMessage(...)`, `deliverReply(...)` or `relayReply(...)`, not a declaration.
const REPLY_CALL = /\.sendMessage\(|(?<!function )\b(?:deliverReply|relayReply)\(/g;
// Comments, so a comment that quotes a call is not one.
const COMMENT = /\/\*[\s\S]*?\*\/|\/\/.*$/gm;

/**
 * Every file allowed to post a reply, with its exact call count and why. Text
 * the adapter writes itself (a prompt, a busy or status note) goes through
 * `sendNotice` / `deliverNotice` instead.
 */
const ALLOWED: Record<string, { calls: number; why: string }> = {
  "core/deliveryFailedError.ts": { calls: 1, why: "deliverReply itself" },
  "core/turn.ts": { calls: 1, why: "relayReply posts the model's closing text" },
  "adapters/GenericAdapter.ts": { calls: 1, why: "a handler's send is its reply" },
  "adapters/acp/ACPRoomAgent.ts": { calls: 1, why: "flushChunks relays the model's text" },
  "adapters/a2a/A2AAdapter.ts": { calls: 5, why: "relays the remote agent's answer; one is the A2A client's own sendMessage" },
  "adapters/claude-sdk/ClaudeSDKAdapter.ts": { calls: 2, why: "relays the model's closing text, on success and alongside a result failure" },
  "adapters/codex/CodexRoomAgent.ts": { calls: 1, why: "relays the model's closing text" },
  "adapters/google-adk/GoogleADKAdapter.ts": { calls: 1, why: "relays the model's closing text" },
  "adapters/langgraph/LangGraphAdapter.ts": { calls: 1, why: "relays the model's closing text" },
  "adapters/letta/LettaAdapter.ts": { calls: 1, why: "relays the model's closing text" },
  "adapters/opencode/OpencodeAdapter.ts": { calls: 1, why: "relays the model's closing text" },
  "adapters/tool-calling/ToolCallingAdapter.ts": { calls: 1, why: "relays the model's closing text" },
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("reply boundary", () => {
  it("posts a reply only where one is allowed, so adapter-written text never counts as the turn's answer", () => {
    const counts: Record<string, number> = {};
    for (const file of SCANNED.flatMap((dir) => sourceFiles(join(SRC, dir)))) {
      const calls = readFileSync(file, "utf8").replace(COMMENT, "").match(REPLY_CALL)?.length ?? 0;
      if (calls > 0) {
        counts[relative(SRC, file)] = calls;
      }
    }

    const allowed = Object.fromEntries(Object.entries(ALLOWED).map(([file, { calls }]) => [file, calls]));
    expect(
      counts,
      "A new reply post. Text the adapter writes itself must go through sendNotice/deliverNotice, never relayReply: "
        + "posted as a reply, it suppresses the relay of the model's real answer and hides a missing reply.",
    ).toEqual(allowed);
  });
});
