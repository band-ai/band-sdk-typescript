/**
 * Agent CRUD: provision a disposable Band identity, run an adapter as it, and
 * a minimal adapter cell for scenarios that own the lifecycle (e.g. stop and
 * re-run one identity to prove platform rehydration). Every handle is released
 * by `await using`; release never throws.
 */
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent, type AgentCreateOptions } from "../../../src/agent/Agent";
import type { FrameworkAdapter } from "../../../src/contracts/protocols";
import { BandLink } from "../../../src/platform/BandLink";
import { withTimeout } from "../../../src/adapters/shared/withTimeout";
import { agentRest, NAME_PREFIX, provisionAgent, reapProvisioned } from "../../integration/support/liveHarness";
import { liveRun, warnTeardown } from "./liveRun";
import type { RosterSpec } from "./adapters";
import type { AdapterBuilder } from "./registry";

import type { FernRestAdapter } from "../../../src/rest";

/** The naming convention `provisionAgent` builds and `sweepOrphans` matches on. */
export type ProvisionedName = `${typeof NAME_PREFIX}${string}`;

const AGENT_STOP_TIMEOUT_MS = 10_000;

/** Runtime options a scenario may set on a running agent. */
export type RunOptions = Pick<AgentCreateOptions, "sessionConfig" | "contactConfig">;

/** A provisioned Band agent identity, reaped when its scope ends. */
export class AgentIdentity implements AsyncDisposable {
  /** A REST client acting as this agent. */
  public readonly rest: FernRestAdapter;

  public constructor(
    public readonly id: string,
    public readonly name: ProvisionedName,
    public readonly apiKey: string,
    restUrl: string,
  ) {
    this.rest = agentRest(restUrl, apiKey);
  }

  /** The platform handle (`owner/agent`) others address this agent by. */
  public async handle(): Promise<string> {
    const { handle } = await this.rest.getAgentMe();
    if (!handle) {
      throw new Error(`agent ${this.name} has no handle`);
    }
    return handle;
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    const { env } = await liveRun();
    await reapProvisioned(env.userClient, env.restUrl, env.userApiKey, [this], [], `reap ${this.name}`).catch(
      warnTeardown(`reap agent ${this.name}`),
    );
  }
}

/** An adapter running as an identity on the live platform, stopped when its scope ends. */
export class RunningAgent implements AsyncDisposable {
  public constructor(
    public readonly identity: AgentIdentity,
    private readonly agent: Agent,
  ) {}

  public async [Symbol.asyncDispose](): Promise<void> {
    // A managed CLI child can hang stop; never let that block the rest of teardown.
    const stopped = this.agent.stop(AGENT_STOP_TIMEOUT_MS);
    await withTimeout(stopped, AGENT_STOP_TIMEOUT_MS * 2, `agent.stop did not settle`).catch(
      warnTeardown(`stop agent ${this.identity.name}`),
    );
  }
}

async function provision(testName: string, label: string): Promise<AgentIdentity> {
  const { env, runId } = await liveRun();
  const agent = await provisionAgent(env.userClient, runId, testName, label);
  return new AgentIdentity(agent.id, agent.name as ProvisionedName, agent.apiKey, env.restUrl);
}

async function runAs(identity: AgentIdentity, adapter: FrameworkAdapter, options: RunOptions = {}): Promise<RunningAgent> {
  const { env } = await liveRun();
  const agent = Agent.create({
    adapter,
    agentId: identity.id,
    apiKey: identity.apiKey,
    wsUrl: env.wsUrl,
    linkOptions: { restApi: identity.rest },
    agentConfig: { autoSubscribeExistingRooms: true },
    ...options,
  });
  const running = new RunningAgent(identity, agent);
  try {
    await agent.start();
  } catch (error) {
    await running[Symbol.asyncDispose]();
    throw error;
  }
  return running;
}

/** A provisioned identity with the cell's adapter running as it; stops, then reaps. */
export class CellAgent implements AsyncDisposable {
  public constructor(public readonly running: RunningAgent) {}

  public get identity(): AgentIdentity {
    return this.running.identity;
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    await this.running[Symbol.asyncDispose]();
    await this.identity[Symbol.asyncDispose]();
  }
}

/** One adapter under test: build it, provision identities for it, and run it as them. */
export class AdapterCell implements AsyncDisposable {
  private constructor(
    public readonly spec: RosterSpec,
    private readonly prompt: string,
    /** The adapter's scratch working directory, for scenarios that check what it did there. */
    public readonly workDir: string,
    private readonly builder: AdapterBuilder,
  ) {}

  /** A cell for `spec`, built by `build` when a scenario needs other than the registered builder. */
  public static async create(spec: RosterSpec, prompt: string, build: AdapterBuilder = spec.build): Promise<AdapterCell> {
    return new AdapterCell(spec, prompt, await realpath(await mkdtemp(join(tmpdir(), `band-baseline-${spec.id}-`))), build);
  }

  /** A fresh adapter instance: no in-memory state carries over from an earlier build. */
  public build(prompt = this.prompt): FrameworkAdapter {
    return this.builder({ prompt, workDir: this.workDir });
  }

  public provision(label: string = this.spec.id): Promise<AgentIdentity> {
    return provision(this.spec.id, label);
  }

  /** Runs a fresh build as `identity`; run twice under one identity to exercise rehydration. */
  public runAs(identity: AgentIdentity, prompt?: string): Promise<RunningAgent> {
    return runAs(identity, this.build(prompt));
  }

  public async running(label?: string): Promise<CellAgent> {
    const identity = await this.provision(label);
    try {
      return new CellAgent(await this.runAs(identity));
    } catch (error) {
      await identity[Symbol.asyncDispose]();
      throw error;
    }
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    await rm(this.workDir, { recursive: true, force: true }).catch(warnTeardown(`remove ${this.workDir}`));
  }
}

/** An agent's own platform connection — the SDK link itself — disconnected when its scope ends. */
export class AgentLink implements AsyncDisposable {
  public constructor(public readonly link: BandLink) {}

  public async [Symbol.asyncDispose](): Promise<void> {
    await this.link.disconnect().catch(warnTeardown(`disconnect link of ${this.link.agentId}`));
  }
}

async function connect(identity: AgentIdentity): Promise<AgentLink> {
  const { env } = await liveRun();
  const link = new AgentLink(new BandLink({ agentId: identity.id, apiKey: identity.apiKey, wsUrl: env.wsUrl, restApi: identity.rest }));
  try {
    await link.link.connect();
  } catch (error) {
    await link[Symbol.asyncDispose]();
    throw error;
  }
  return link;
}

/** Sends a contact request from `from` to `to`. */
async function requestContact(from: AgentIdentity, to: AgentIdentity): Promise<void> {
  await from.rest.addContact({ handle: await to.handle() });
}

export const Agents = {
  provision,
  runAs,
  connect,
  requestContact,
  cell: AdapterCell.create,
};
