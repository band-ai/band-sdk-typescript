import { UnsupportedFeatureError } from "../core/errors";
import type { AgentToolsCapabilities } from "./protocols";

type CapabilityName = keyof AgentToolsCapabilities;

const CAPABILITY_LABELS: Record<CapabilityName, string> = {
  peers: "Peer lookup",
  contacts: "Contacts",
  memory: "Memory",
  tasks: "Tasks",
};

export function assertCapability(
  capabilities: AgentToolsCapabilities,
  capability: CapabilityName,
  label = CAPABILITY_LABELS[capability],
): void {
  if (!capabilities[capability]) {
    throw new UnsupportedFeatureError(`${label} is disabled by runtime capabilities`);
  }
}

/** Tenant features gating optional runtime capabilities. Missing flags mean off. */
export const CAPABILITY_FEATURE_FLAGS: Partial<Record<CapabilityName, string>> = { tasks: "ff_room_tasks" };

export function supportsCapability(
  featureFlags: Readonly<Record<string, boolean>> | undefined,
  capability: CapabilityName,
): boolean {
  const flag = CAPABILITY_FEATURE_FLAGS[capability];
  return flag === undefined || featureFlags?.[flag] === true;
}

export function pruneUnsupported(
  capabilities: AgentToolsCapabilities,
  featureFlags?: Readonly<Record<string, boolean>>,
): AgentToolsCapabilities {
  return Object.fromEntries(
    Object.entries(capabilities).map(([name, enabled]) => [
      name,
      enabled && supportsCapability(featureFlags, name as CapabilityName),
    ]),
  ) as unknown as AgentToolsCapabilities;
}
