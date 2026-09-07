import { z } from "zod";

import {
  REALTIME_WORKING_AGENT_EXECUTION_MAX,
  type WorkingAgentExecution,
} from "./types";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function canonicalizeUuid(value: string): string | null {
  const canonical = value.trim().toLowerCase();
  return UUID_RE.test(canonical) ? canonical : null;
}

const workingAgentSchema = z.object({
  agent_id: z.string(),
  execution_id: z.string(),
  working: z.literal(true),
});

const snapshotSchema = z.object({
  working_agents: z.array(workingAgentSchema),
});

const startSchema = z.object({
  agent_id: z.string(),
  execution_id: z.string(),
  working: z.literal(true),
});

const stopSchema = z.object({
  agent_id: z.string(),
  execution_id: z.string(),
  working: z.literal(false),
});

export type ActivityDecode =
  | { kind: "ready"; snapshot: WorkingAgentExecution[] }
  | { kind: "unavailable" }
  | { kind: "drop" };

function tupleKey(entry: WorkingAgentExecution): string {
  return `${entry.agentId}\0${entry.executionId}`;
}

function toExecution(
  agentId: string,
  executionId: string,
): WorkingAgentExecution | null {
  const agent = canonicalizeUuid(agentId);
  const execution = canonicalizeUuid(executionId);
  if (!agent || !execution) {
    return null;
  }
  return { agentId: agent, executionId: execution };
}

export function decodeActivitySnapshot(payload: unknown): ActivityDecode {
  const parsed = snapshotSchema.safeParse(payload);
  if (!parsed.success) {
    return { kind: "unavailable" };
  }

  const snapshot: WorkingAgentExecution[] = [];
  const seen = new Set<string>();
  for (const entry of parsed.data.working_agents) {
    const execution = toExecution(entry.agent_id, entry.execution_id);
    if (!execution) {
      return { kind: "unavailable" };
    }
    const key = tupleKey(execution);
    if (seen.has(key)) {
      return { kind: "unavailable" };
    }
    seen.add(key);
    snapshot.push(execution);
  }

  if (snapshot.length > REALTIME_WORKING_AGENT_EXECUTION_MAX) {
    return { kind: "unavailable" };
  }
  return { kind: "ready", snapshot };
}

export function decodeActivityStart(
  payload: unknown,
): WorkingAgentExecution | null {
  const parsed = startSchema.safeParse(payload);
  if (!parsed.success) {
    return null;
  }
  return toExecution(parsed.data.agent_id, parsed.data.execution_id);
}

export function decodeActivityStop(
  payload: unknown,
): WorkingAgentExecution | null {
  const parsed = stopSchema.safeParse(payload);
  if (!parsed.success) {
    return null;
  }
  return toExecution(parsed.data.agent_id, parsed.data.execution_id);
}

export class ActivityState {
  private snapshot: WorkingAgentExecution[] | null = null;

  public clear(): void {
    this.snapshot = null;
  }

  public isReady(): boolean {
    return this.snapshot !== null;
  }

  public replace(snapshot: WorkingAgentExecution[]): WorkingAgentExecution[] {
    this.snapshot = [...snapshot];
    return this.snapshot;
  }

  public start(
    execution: WorkingAgentExecution,
  ): "started" | "noop" | "unavailable" {
    if (this.snapshot === null) {
      return "noop";
    }
    if (this.snapshot.some((item) => tupleKey(item) === tupleKey(execution))) {
      return "noop";
    }
    if (this.snapshot.length >= REALTIME_WORKING_AGENT_EXECUTION_MAX) {
      this.snapshot = null;
      return "unavailable";
    }
    this.snapshot = [...this.snapshot, execution];
    return "started";
  }

  public stop(execution: WorkingAgentExecution): "stopped" | "noop" {
    if (this.snapshot === null) {
      return "noop";
    }
    const next = this.snapshot.filter(
      (item) => tupleKey(item) !== tupleKey(execution),
    );
    if (next.length === this.snapshot.length) {
      return "noop";
    }
    this.snapshot = next;
    return "stopped";
  }
}
