import type {
  SessionConfigOption,
  SessionConfigSelect,
  SessionConfigSelectOption,
  SessionConfigSelectOptions,
} from "@agentclientprotocol/sdk";

import { AgentFailure } from "@band-ai/band-sdk-core";

import { asErrorMessage, asOptionalRecord } from "../shared/coercion";
import { withTimeout } from "../shared/withTimeout";
import { agentFailure } from "../../core/providerFailure";

/** Structured Band failure code when an ACP session config selection cannot be applied. */
export const FAILURE_CODE_SESSION_CONFIG = "session_config";

export type ACPConfigSelections = Readonly<Record<string, string | undefined>>;

/**
 * Deterministic failure applying ACP session configuration. Carries provider,
 * option id, and optional ACP JSON-RPC code so callers can report a structured
 * Band failure instead of silently skipping the selection.
 */
export class AcpSessionConfigError extends Error {
  public readonly provider: string;
  public readonly sessionId: string;
  public readonly optionId: string;
  public readonly selectedValue: string | undefined;
  public readonly acpCode: number | undefined;
  public readonly detail: unknown;

  public constructor(input: {
    provider: string;
    sessionId: string;
    optionId: string;
    message: string;
    selectedValue?: string;
    acpCode?: number;
    detail?: unknown;
    cause?: unknown;
  }) {
    super(input.message, input.cause !== undefined ? { cause: input.cause } : undefined);
    this.name = "AcpSessionConfigError";
    this.provider = input.provider;
    this.sessionId = input.sessionId;
    this.optionId = input.optionId;
    this.selectedValue = input.selectedValue;
    this.acpCode = input.acpCode;
    this.detail = input.detail;
  }

  public toAgentFailure(): AgentFailure {
    return agentFailure(
      this.provider,
      this.message,
      this.acpCode !== undefined ? String(this.acpCode) : FAILURE_CODE_SESSION_CONFIG,
      {
        sessionId: this.sessionId,
        optionId: this.optionId,
        selectedValue: this.selectedValue,
        detail: this.detail,
      },
    );
  }
}

export type SessionConfigOptionSetter = (params: {
  sessionId: string;
  configId: string;
  value: string;
}) => Promise<{ configOptions?: readonly SessionConfigOption[] | null }>;

export interface ApplySessionConfigSelectionsInput {
  provider: string;
  sessionId: string;
  catalog: readonly SessionConfigOption[];
  selections: ACPConfigSelections;
  setOption: SessionConfigOptionSetter;
  timeoutMs: number;
}

export interface ApplySessionConfigSelectionsResult {
  catalog: readonly SessionConfigOption[];
}

/**
 * Applies ACP config selections in caller order. Each successful
 * `session/set_config_option` response replaces the live catalog used to
 * validate the next selection. Invalid or rejected selections throw
 * {@link AcpSessionConfigError} — never silently skip or default.
 */
export async function applySessionConfigSelections(
  input: ApplySessionConfigSelectionsInput,
): Promise<ApplySessionConfigSelectionsResult> {
  let catalog: readonly SessionConfigOption[] = input.catalog;

  for (const configId of Object.keys(input.selections)) {
    const selectedValue = input.selections[configId];
    if (selectedValue === undefined) {
      continue;
    }

    const option = catalog.find((entry) => entry?.id === configId);
    if (!option || !isSessionConfigSelect(option)) {
      throw new AcpSessionConfigError({
        provider: input.provider,
        sessionId: input.sessionId,
        optionId: configId,
        selectedValue,
        message: `Session config option "${configId}" is not available after prior selections.`,
      });
    }

    if (selectedValue === option.currentValue) {
      continue;
    }

    const availableValues = flattenConfigSelectOptions(option.options).map((entry) => entry.value);
    if (!availableValues.includes(selectedValue)) {
      throw new AcpSessionConfigError({
        provider: input.provider,
        sessionId: input.sessionId,
        optionId: configId,
        selectedValue,
        message: `Session config value "${selectedValue}" is not advertised for option "${configId}".`,
        detail: { availableValues },
      });
    }

    try {
      const response = await withTimeout(
        input.setOption({ sessionId: input.sessionId, configId, value: selectedValue }),
        input.timeoutMs,
        `setSessionConfigOption did not respond within ${input.timeoutMs}ms`,
      );
      if (!Array.isArray(response?.configOptions)) {
        throw new AcpSessionConfigError({
          provider: input.provider,
          sessionId: input.sessionId,
          optionId: configId,
          selectedValue,
          message: `Session config option "${configId}" response did not include a refreshed catalog.`,
          detail: { reason: "missing_config_options" },
        });
      }
      catalog = response.configOptions;
    } catch (error) {
      if (error instanceof AcpSessionConfigError) {
        throw error;
      }
      const acpError = asAcpJsonRpcError(error);
      throw new AcpSessionConfigError({
        provider: input.provider,
        sessionId: input.sessionId,
        optionId: configId,
        selectedValue,
        acpCode: acpError?.code,
        detail: acpError?.data,
        message: acpError?.message ?? asErrorMessage(error),
        cause: error,
      });
    }
  }

  return { catalog };
}

export function isSessionConfigSelect(
  option: SessionConfigOption,
): option is SessionConfigOption & SessionConfigSelect & { type: "select" } {
  return option?.type === "select";
}

export function flattenConfigSelectOptions(
  options: SessionConfigSelectOptions | null | undefined,
): SessionConfigSelectOption[] {
  if (!Array.isArray(options)) {
    return [];
  }

  return options.flatMap((entry) => {
    if (!asOptionalRecord(entry)) {
      return [];
    }

    if ("group" in entry) {
      return Array.isArray(entry.options) ? entry.options : [];
    }

    return [entry];
  });
}

// Structural guard, not `instanceof RequestError`: ACP client RPC rejects with
// the plain deserialized wire object (`{code, message, data?}`), never
// re-wrapped into a `RequestError` instance (that class is only used on the
// agent side to *construct* an outgoing error response). Some stacks wrap that
// payload as `{ error: { code, message, data? } }`.
function isAcpErrorResponse(error: unknown): error is { code: number; message: string; data?: unknown } {
  return typeof error === "object" && error !== null
    && typeof (error as { code?: unknown }).code === "number"
    && typeof (error as { message?: unknown }).message === "string";
}

export function asAcpJsonRpcError(error: unknown): { code: number; message: string; data?: unknown } | undefined {
  if (isAcpErrorResponse(error)) {
    return error;
  }
  const nested = asOptionalRecord(error)?.error;
  return isAcpErrorResponse(nested) ? nested : undefined;
}
