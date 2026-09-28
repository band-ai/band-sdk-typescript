/**
 * The baseline adapter registry: the single source of truth for which
 * framework adapters the live suite fans out across, what each needs before it
 * can run, and how to build it. Scenarios never hard-code an adapter list —
 * they query `specs()`.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { FrameworkAdapter } from "../../../src/contracts/protocols";
import { cliProbeFailure } from "../../integration/support/liveHarness";

const SDK_NODE_MODULES = fileURLToPath(new URL("../../../node_modules/", import.meta.url));

/** Every framework adapter under `src/adapters/`, by directory name. */
export const ADAPTER_IDS = [
  "anthropic",
  "claude-sdk",
  "codex",
  "copilot-acp",
  "cursor-acp",
  "gemini",
  "google-adk",
  "kiro-acp",
  "langgraph",
  "letta",
  "omp-acp",
  "openai",
  "opencode",
  "parlant",
  "vercel-ai-sdk",
] as const;

export type AdapterId = (typeof ADAPTER_IDS)[number];

/**
 * Directories under `src/adapters/` that are not framework adapters: shared
 * helpers, the tool-calling base class, and the protocol bridges, whose
 * coverage is defined separately from the adapter matrix.
 */
export const NON_ADAPTER_DIRS = ["shared", "tool-calling", "a2a", "a2a-gateway", "acp"] as const;

/** Joins a shared cast's adapter ids into its test title, e.g. `anthropic + google-adk`. */
export const CAST_SEPARATOR = " + ";

/** Scenario folders under `scenarios/`; a scenario id is namespaced by one. */
export const CATEGORIES = ["adapters", "behavior", "inspection", "platform"] as const;

export type Category = (typeof CATEGORIES)[number];

/** A scenario's scorecard key and test title, e.g. `platform.repliesToMention`. */
export type ScenarioId = `${Category}.${string}`;

/** What an adapter needs before it can run. */
export type Dep =
  | { kind: "envVar"; name: string }
  | { kind: "anyEnvVar"; names: readonly string[] }
  | { kind: "peerPackage"; name: string }
  | { kind: "cli"; command: string };

/** What a scenario can select adapters on. Grows only as scenarios filter on it. */
export type Capability = "approvals";

/** What a scenario hands a builder to shape the adapter it runs. */
export interface BuildOptions {
  /** The steering system prompt, routed to whichever option the framework uses. */
  prompt: string;
  /** A scratch working directory for adapters that drive a local coding agent. */
  workDir: string;
}

export type AdapterBuilder = (options: BuildOptions) => FrameworkAdapter;

export interface AdapterSpec {
  id: AdapterId;
  requires: readonly Dep[];
  supports: readonly Capability[];
  build: AdapterBuilder;
  /**
   * Why a registered adapter does not run live yet — what it waits on.
   * `specs()` leaves pending adapters out unless asked.
   */
  pending?: string;
}

export interface SpecFilter {
  include?: readonly AdapterId[];
  exclude?: readonly AdapterId[];
  /** Keep adapters that support ALL of these. */
  supports?: readonly Capability[];
  /** Keep adapters that support NONE of these. */
  without?: readonly Capability[];
  includePending?: boolean;
}

/** Set to `1` to run pending adapters too, where the local environment has what CI lacks. */
export const INCLUDE_PENDING_ENV = "BAND_E2E_INCLUDE_PENDING";

export function includePending(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[INCLUDE_PENDING_ENV] === "1";
}

export class AdapterRegistry {
  private readonly entries = new Map<AdapterId, AdapterSpec>();

  public register(id: AdapterId, spec: Omit<AdapterSpec, "id">): void {
    if (this.entries.has(id)) {
      throw new Error(`adapter "${id}" is already registered`);
    }
    this.entries.set(id, { id, ...spec });
  }

  public ids(): AdapterId[] {
    return [...this.entries.keys()].sort();
  }

  /** The registered specs narrowed by `filter`, in stable id order. */
  public specs(filter: SpecFilter = {}): AdapterSpec[] {
    const { include, exclude, supports = [], without = [], includePending = false } = filter;
    return this.ids()
      .map((id) => this.entries.get(id) as AdapterSpec)
      .filter(
        (spec) =>
          (include === undefined || include.includes(spec.id)) &&
          !exclude?.includes(spec.id) &&
          (includePending || spec.pending === undefined) &&
          supports.every((capability) => spec.supports.includes(capability)) &&
          !without.some((capability) => spec.supports.includes(capability)),
      );
  }
}

export const registry = new AdapterRegistry();

export function registerAdapter(id: AdapterId, spec: Omit<AdapterSpec, "id">): void {
  registry.register(id, spec);
}

export function specs(filter?: SpecFilter): AdapterSpec[] {
  return registry.specs(filter);
}

/** Why `dep` is unavailable in this environment, or null when it is met. */
function unmetReason(dep: Dep): string | null {
  switch (dep.kind) {
    case "envVar":
      return process.env[dep.name] ? null : `env var ${dep.name} is not set`;
    case "anyEnvVar":
      return dep.names.some((name) => process.env[name]) ? null : `none of ${dep.names.join(", ")} is set`;
    case "peerPackage":
      return existsSync(`${SDK_NODE_MODULES}${dep.name}`) ? null : `package ${dep.name} is not installed`;
    case "cli": {
      const failure = cliProbeFailure(dep.command);
      return failure && `CLI ${dep.command} is unavailable: ${failure}`;
    }
  }
}

/** Every requirement of `spec` this environment does not meet, as a readable reason. */
export function unmetRequirements(spec: AdapterSpec): string[] {
  return spec.requires.map(unmetReason).filter((reason) => reason !== null);
}
