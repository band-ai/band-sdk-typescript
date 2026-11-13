import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** One JSON object per line, as the CLI wrote it. */
export type Frame = Record<string, unknown>;

export const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "claude-cli");

/** The scenarios captured from a real CLI, each in its own directory. */
export function listScenarios(): string[] {
  return readdirSync(fixturesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** The frames one scenario's CLI wrote, in the order it wrote them. */
export function captured(scenario: string): Frame[] {
  return readLines(join(fixturesRoot, scenario, "stdout.ndjson"));
}

/** The frames the host wrote to the CLI in that scenario. */
export function capturedStdin(scenario: string): Frame[] {
  return readLines(join(fixturesRoot, scenario, "stdin.ndjson"));
}

/** The JSON-RPC that scenario's CLI exchanged with the MCP probe, if it had one. */
export function capturedMcp(scenario: string): Array<{ direction: string; msg: Frame }> {
  try {
    return readLines(join(fixturesRoot, scenario, "mcp.ndjson")) as Array<{ direction: string; msg: Frame }>;
  } catch {
    return []; // an MCP log exists only where a probe was configured
  }
}

export function capturedMeta(scenario: string): { cliVersion: string; invocation: string[]; exit: { code: number | null } } {
  return JSON.parse(readFileSync(join(fixturesRoot, scenario, "meta.json"), "utf8")) as {
    cliVersion: string;
    invocation: string[];
    exit: { code: number | null };
  };
}

/** The frames a scenario's CLI wrote for its turn; its handshake answers our own request. */
export function turnFrames(scenario: string): Frame[] {
  return captured(scenario).filter((frame) => frame.type !== "control_response");
}

/** A captured control_response, addressed to the id this client actually used. */
export function addressed(frame: Frame, requestId: string): Frame {
  const clone = JSON.parse(JSON.stringify(frame)) as { response?: Record<string, unknown> };
  if (clone.response) {
    clone.response.request_id = requestId;
  }
  return clone as Frame;
}

function readLines(path: string): Frame[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Frame);
}
