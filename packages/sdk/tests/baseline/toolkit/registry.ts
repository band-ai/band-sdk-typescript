/**
 * The baseline registry's vocabulary and mechanics: what an adapter spec is,
 * what it can require and support, and how a scenario selects specs. The
 * adapters themselves are registered in `adapters.ts`, whose registrations
 * are the roster.
 */
import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { FrameworkAdapter } from "../../../src/contracts/protocols";
import type { CustomToolDef } from "../../../src/runtime/tools/customTools";
import { cliProbeFailure } from "../../integration/support/liveHarness";

const SDK_NODE_MODULES = fileURLToPath(new URL("../../../node_modules/", import.meta.url));

/**
 * Directories under `src/adapters/` that are not framework adapters: shared
 * helpers, the tool-calling base class, and the protocol bridges, whose
 * coverage is defined separately from the adapter matrix.
 */
export const NON_ADAPTER_DIRS = ["shared", "tool-calling", "a2a", "a2a-gateway", "acp"] as const;

/** Joins a shared cast's adapter ids into its test title, e.g. `anthropic + google-adk`. */
export const CAST_SEPARATOR = " + ";

/** Scenario folders under `scenarios/`; a scenario id is namespaced by one. */
export const CATEGORY = {
  adapters: "adapters",
  behavior: "behavior",
  inspection: "inspection",
  platform: "platform",
} as const;

export type Category = (typeof CATEGORY)[keyof typeof CATEGORY];

export const CATEGORIES: readonly Category[] = Object.values(CATEGORY);

/** A scenario's scorecard key and test title, e.g. `platform.repliesToMention`. */
export type ScenarioId = `${Category}.${string}`;

/** A scenario id: its category folder, then its name. */
export function scenarioId(category: Category, name: string): ScenarioId {
  return `${category}.${name}`;
}

const SCENARIO_FILE_SUFFIX = ".test.ts";

/** `<category>.<stem>` from a path shaped like `…/<category>/<stem>.test.ts`. */
export function scenarioIdFromModulePath(relativeModuleId: string): string {
  return `${basename(dirname(relativeModuleId))}.${basename(relativeModuleId, SCENARIO_FILE_SUFFIX)}`;
}

/**
 * What an adapter can select on. Grows only as scenarios filter on it.
 * `roomWorkspaces`: runs a coding agent in each room's own workspace, and as
 * built here it edits files there without asking.
 */
export const CAPABILITY = { approvals: "approvals", customTools: "customTools", memory: "memory", roomWorkspaces: "roomWorkspaces" } as const;

export type Capability = (typeof CAPABILITY)[keyof typeof CAPABILITY];

const DEP_KIND = { envVar: "envVar", anyEnvVar: "anyEnvVar", peerPackage: "peerPackage", cli: "cli" } as const;

/** What an adapter needs before it can run. Built with `requires`. */
export type Dep =
  | { kind: typeof DEP_KIND.envVar; name: string }
  | { kind: typeof DEP_KIND.anyEnvVar; names: readonly string[] }
  | { kind: typeof DEP_KIND.peerPackage; name: string }
  | { kind: typeof DEP_KIND.cli; command: string };

export const requires = {
  envVar: (name: string): Dep => ({ kind: DEP_KIND.envVar, name }),
  /** Any one of `names`. */
  anyEnvVar: (...names: string[]): Dep => ({ kind: DEP_KIND.anyEnvVar, names }),
  peerPackage: (name: string): Dep => ({ kind: DEP_KIND.peerPackage, name }),
  cli: (command: string): Dep => ({ kind: DEP_KIND.cli, command }),
};

/** What a scenario hands a builder to shape the adapter it runs. */
export interface BuildOptions {
  /** The steering system prompt, routed to whichever option the framework uses. */
  prompt: string;
  /** A scratch working directory for adapters that drive a local coding agent. */
  workDir: string;
  /** Tools a scenario gives the agent; builders that support `CAPABILITY.customTools` report each call as a `tool_call` event. */
  customTools?: CustomToolDef[];
  /** Builders that support `CAPABILITY.memory` give the agent the Band memory tools and report their calls. */
  memory?: boolean;
  /** Builders that support `CAPABILITY.customTools` report every tool call, the Band tools' too, as a `tool_call` event. */
  reportToolCalls?: boolean;
}

export type AdapterBuilder = (options: BuildOptions) => FrameworkAdapter;

export interface AdapterSpec<Id extends string = string> {
  /** The adapter's directory under `src/adapters/`. */
  id: Id;
  requires: readonly Dep[];
  supports: readonly Capability[];
  build: AdapterBuilder;
  /**
   * Why a registered adapter does not run live yet — what it waits on.
   * `specs()` leaves pending adapters out unless asked.
   */
  pending?: string;
  /**
   * Why the adapter runs only in scenarios that name it (`withAdapters`),
   * never a fan-out. `specs()` leaves it out unless asked; a fan-out that
   * asks shows it as N/A with this reason.
   */
  bespokeOnly?: string;
}

export interface SpecFilter<Id extends string = string> {
  include?: readonly Id[];
  exclude?: readonly Id[];
  /** Keep adapters that support ALL of these. */
  supports?: readonly Capability[];
  /** Keep adapters that support NONE of these. */
  without?: readonly Capability[];
  includePending?: boolean;
  includeBespokeOnly?: boolean;
}

/** The value that turns an opt-in environment flag on, e.g. `BAND_E2E_INCLUDE_PENDING=1`. */
export const FLAG_ON = "1";

/** Set to `FLAG_ON` to run pending adapters too, where the local environment has what CI lacks. */
export const INCLUDE_PENDING_ENV = "BAND_E2E_INCLUDE_PENDING";

export function includePending(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[INCLUDE_PENDING_ENV] === FLAG_ON;
}

export class AdapterRegistry<Id extends string = string> {
  private readonly entries: ReadonlyMap<Id, AdapterSpec<Id>>;

  public constructor(specs: Iterable<AdapterSpec<Id>>) {
    const entries = new Map<Id, AdapterSpec<Id>>();
    for (const spec of specs) {
      if (entries.has(spec.id)) {
        throw new Error(`adapter "${spec.id}" is registered twice`);
      }
      entries.set(spec.id, spec);
    }
    this.entries = entries;
  }

  public ids(): Id[] {
    return [...this.entries.keys()].sort();
  }

  /** The spec registered as `id`, pending or not. */
  public get(id: Id): AdapterSpec<Id> {
    const spec = this.entries.get(id);
    if (!spec) {
      throw new Error(`adapter "${id}" is not registered`);
    }
    return spec;
  }

  /** The registered specs narrowed by `filter`, in stable id order. */
  public specs(filter: SpecFilter<Id> = {}): AdapterSpec<Id>[] {
    const { include, exclude, supports = [], without = [], includePending = false, includeBespokeOnly = false } = filter;
    return this.ids()
      .map((id) => this.get(id))
      .filter(
        (spec) =>
          (include === undefined || include.includes(spec.id)) &&
          !exclude?.includes(spec.id) &&
          (includeBespokeOnly || spec.bespokeOnly === undefined) &&
          (includePending || spec.pending === undefined) &&
          supports.every((capability) => spec.supports.includes(capability)) &&
          !without.some((capability) => spec.supports.includes(capability)),
      );
  }
}

/** Why `dep` is unavailable in this environment, or null when it is met. */
function unmetReason(dep: Dep): string | null {
  switch (dep.kind) {
    case DEP_KIND.envVar:
      return process.env[dep.name] ? null : `env var ${dep.name} is not set`;
    case DEP_KIND.anyEnvVar:
      return dep.names.some((name) => process.env[name]) ? null : `none of ${dep.names.join(", ")} is set`;
    case DEP_KIND.peerPackage:
      return existsSync(`${SDK_NODE_MODULES}${dep.name}`) ? null : `package ${dep.name} is not installed`;
    case DEP_KIND.cli: {
      const failure = cliProbeFailure(dep.command);
      return failure && `CLI ${dep.command} is unavailable: ${failure}`;
    }
  }
}

/** Every requirement of `spec` this environment does not meet, as a readable reason. */
export function unmetRequirements(spec: AdapterSpec): string[] {
  return spec.requires.map(unmetReason).filter((reason) => reason !== null);
}
