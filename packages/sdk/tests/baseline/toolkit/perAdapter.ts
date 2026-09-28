/**
 * Fan-out: one scenario, one test per adapter, titled `<scenario> > <adapter>`.
 * Each test runs against a live cell — the adapter running as a fresh identity
 * in a fresh room the platform user speaks in — released on
 * every exit path by `await using`, independent of vitest's fixture cleanup.
 *
 * Parametrization only: recording outcomes is `scorecardReporter.ts`'s job.
 */
import { describe, it } from "vitest";

import { Agents, type AdapterCell, type AgentIdentity } from "./agents";
import "./adapters";
import { specs, unmetRequirements, type AdapterId, type AdapterSpec, type Capability, type ScenarioId } from "./registry";
import { ResourceStack } from "./resourceStack";
import { Rooms, type Room } from "./rooms";

const DEFAULT_PROMPT =
  "You are a helpful assistant in a chat room. When someone messages you, reply to them directly and briefly.";

export interface ScenarioCell {
  /** The adapter under test, running as its own identity. */
  agent: AgentIdentity;
  /** A room holding the user and the agent. */
  room: Room;
  /** The adapter's cell, for scenarios that run further identities or re-run one. */
  cell: AdapterCell;
}

export type ScenarioBody = (cell: ScenarioCell) => Promise<void>;

/** Acquires a scenario's cell; disposing it releases everything acquired. */
export type OpenCell = (spec: AdapterSpec, prompt: string) => Promise<ScenarioCell & AsyncDisposable>;

export interface ScenarioOptions {
  /** The adapter's steering prompt. */
  prompt?: string;
}

export interface PerAdapterOptions extends ScenarioOptions {
  supports?: readonly Capability[];
  without?: readonly Capability[];
  exclude?: readonly AdapterId[];
}

async function openLiveCell(spec: AdapterSpec, prompt: string): Promise<ScenarioCell & AsyncDisposable> {
  const stack = new ResourceStack();
  try {
    const cell = stack.use(await Agents.cell(spec, prompt));
    const running = stack.use(await cell.running());
    const room = stack.use(await Rooms.create());
    await Rooms.addParticipant(room, running.identity);
    return { agent: running.identity, room, cell, [Symbol.asyncDispose]: () => stack[Symbol.asyncDispose]() };
  } catch (error) {
    await stack[Symbol.asyncDispose]();
    throw error;
  }
}

/** One adapter's run of a scenario: fail loudly on unmet requirements, then run the body in a cell. */
export async function runScenario(spec: AdapterSpec, body: ScenarioBody, prompt: string, open: OpenCell = openLiveCell): Promise<void> {
  const unmet = unmetRequirements(spec);
  if (unmet.length > 0) {
    throw new Error(`${spec.id} cannot run: ${unmet.join("; ")}`);
  }
  await using cell = await open(spec, prompt);
  await body(cell);
}

function defineScenario(name: ScenarioId, chosen: AdapterSpec[], body: ScenarioBody, prompt = DEFAULT_PROMPT): void {
  if (chosen.length === 0) {
    throw new Error(`${name} selects no adapters; a scenario over nothing would pass vacuously`);
  }
  describe(name, () => {
    for (const spec of chosen) {
      it(spec.id, async ({ skip }) => {
        if (spec.pending) {
          skip(spec.pending);
        }
        await runScenario(spec, body, prompt);
      });
    }
  });
}

/** Runs `body` once per registered adapter, narrowed by `options`. Pending adapters show as skipped. */
export function perAdapter(name: ScenarioId, body: ScenarioBody, options: PerAdapterOptions = {}): void {
  const { prompt, ...filter } = options;
  defineScenario(name, specs({ ...filter, includePending: true }), body, prompt);
}

/** Runs `body` once for each of a fixed set of adapters. */
export function withAdapters(ids: readonly AdapterId[], name: ScenarioId, body: ScenarioBody, options: ScenarioOptions = {}): void {
  defineScenario(name, specs({ include: ids, includePending: true }), body, options.prompt);
}
