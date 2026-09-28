/**
 * Fan-out and fixed casts, as vitest tests titled `<scenario> > <adapter>`.
 *
 * - `perAdapter` runs a scenario once per registered adapter, each in its own
 *   room.
 * - `withAdapters` runs it once with a fixed set of adapters sharing one room,
 *   for scenarios about adapters working together.
 *
 * Each run gets a live cast — the adapters running as fresh identities in a
 * fresh room the platform user speaks in — released on every exit path by
 * `await using`, independent of vitest's fixture cleanup.
 *
 * Parametrization only: recording outcomes is `scorecardReporter.ts`'s job.
 */
import { describe, it } from "vitest";

import type { FrameworkAdapter } from "../../../src/contracts/protocols";
import { specs, type AdapterId, type RosterSpec } from "./adapters";
import { Agents, type AdapterCell, type AgentIdentity } from "./agents";
import {
  CAST_SEPARATOR,
  includePending,
  unmetRequirements,
  type BuildOptions,
  type Capability,
  type ScenarioId,
} from "./registry";
import { ResourceStack } from "./resourceStack";
import { Rooms, type Room } from "./rooms";

const DEFAULT_PROMPT =
  "You are a helpful assistant in a chat room. When someone messages you, reply to them directly and briefly.";

/** The adapters under test, each running as its own identity, in one room with the user. */
export interface Cast {
  agents: AgentIdentity[];
  room: Room;
  /** Each adapter's cell, for scenarios that run further identities or re-run one. */
  cells: AdapterCell[];
}

/** One adapter's cast, as a `perAdapter` scenario sees it. */
export interface ScenarioCell {
  agent: AgentIdentity;
  room: Room;
  cell: AdapterCell;
}

/** Builds an adapter for a scenario that needs other than its registered builder. */
export type ScenarioBuilder = (spec: RosterSpec, options: BuildOptions) => FrameworkAdapter;

export interface ScenarioOptions {
  /** The adapters' steering prompt. */
  prompt?: string;
  build?: ScenarioBuilder;
}

export interface PerAdapterOptions extends ScenarioOptions {
  supports?: readonly Capability[];
  without?: readonly Capability[];
  exclude?: readonly AdapterId[];
}

interface CastSetup {
  prompt: string;
  build?: ScenarioBuilder;
}

/** Acquires a cast; disposing it releases everything acquired. */
export type OpenCast = (chosen: RosterSpec[], setup: CastSetup) => Promise<Cast & AsyncDisposable>;

async function openLiveCast(chosen: RosterSpec[], { prompt, build }: CastSetup): Promise<Cast & AsyncDisposable> {
  const stack = new ResourceStack();
  try {
    const room = stack.use(await Rooms.create());
    const cells: AdapterCell[] = [];
    const agents: AgentIdentity[] = [];
    for (const spec of chosen) {
      const cell = stack.use(await Agents.cell(spec, prompt, build && ((options) => build(spec, options))));
      const running = stack.use(await cell.running());
      await Rooms.addParticipant(room, running.identity);
      cells.push(cell);
      agents.push(running.identity);
    }
    return { agents, room, cells, [Symbol.asyncDispose]: () => stack[Symbol.asyncDispose]() };
  } catch (error) {
    await stack[Symbol.asyncDispose]();
    throw error;
  }
}

/** One run of a scenario: fail loudly on unmet requirements, then run the body with its cast. */
export async function runScenario(
  chosen: RosterSpec[],
  body: (cast: Cast) => Promise<void>,
  setup: CastSetup,
  open: OpenCast = openLiveCast,
): Promise<void> {
  const unmet = chosen.flatMap((spec) => unmetRequirements(spec).map((reason) => `${spec.id}: ${reason}`));
  if (unmet.length > 0) {
    throw new Error(`cannot run: ${unmet.join("; ")}`);
  }
  await using cast = await open(chosen, setup);
  await body(cast);
}

/** Why `chosen` may not run yet, or null when all may. */
function pendingReason(chosen: RosterSpec[]): string | null {
  if (includePending()) {
    return null;
  }
  const pending = chosen.filter((spec) => spec.pending);
  return pending.length > 0 ? pending.map((spec) => `${spec.id}: ${spec.pending}`).join("; ") : null;
}

function defineRun(title: string, chosen: RosterSpec[], body: (cast: Cast) => Promise<void>, options: ScenarioOptions): void {
  it(title, async ({ skip }) => {
    const pending = pendingReason(chosen);
    if (pending) {
      skip(pending);
    }
    await runScenario(chosen, body, { prompt: options.prompt ?? DEFAULT_PROMPT, build: options.build });
  });
}

/** Runs `body` once per registered adapter, narrowed by `options`. Pending adapters show as skipped. */
export function perAdapter(name: ScenarioId, body: (cell: ScenarioCell) => Promise<void>, options: PerAdapterOptions = {}): void {
  const { prompt, build, ...filter } = options;
  const chosen = specs({ ...filter, includePending: true });
  if (chosen.length === 0) {
    throw new Error(`${name} selects no adapters; a scenario over nothing would pass vacuously`);
  }
  describe(name, () => {
    for (const spec of chosen) {
      defineRun(spec.id, [spec], ({ agents: [agent], room, cells: [cell] }) => body({ agent: agent!, room, cell: cell! }), {
        prompt,
        build,
      });
    }
  });
}

/** Runs `body` once, with every adapter in `ids` running in one shared room. */
export function withAdapters(
  ids: readonly AdapterId[],
  name: ScenarioId,
  body: (cast: Cast) => Promise<void>,
  options: ScenarioOptions = {},
): void {
  // In the order given: a cast's roles (e.g. who coordinates) follow it.
  const chosen = ids.flatMap((id) => specs({ include: [id], includePending: true }));
  describe(name, () => defineRun(ids.join(CAST_SEPARATOR), chosen, body, options));
}
