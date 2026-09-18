import type {
  SessionConfigOption,
  SessionConfigSelect,
  SessionConfigSelectOption,
  SessionConfigSelectOptions,
} from "@agentclientprotocol/sdk";

import type { AgentFailure } from "@band-ai/band-sdk-core";

import { asErrorMessage, asOptionalRecord } from "../shared/coercion";
import { withTimeout } from "../shared/withTimeout";
import { agentFailure } from "../../core/providerFailure";

/** Structured Band failure code when an ACP session config selection cannot be applied. */
export const FAILURE_CODE_SESSION_CONFIG = "session_config";

/** Reason when a successful setter omits an array `configOptions` catalog. */
export const MISSING_CONFIG_OPTIONS_REASON = "missing_config_options";

class AcpSessionConfigTimeoutError extends Error {}

export interface ACPConfigSelection {
  configId: string;
  value: string | undefined;
}

/**
 * Session configuration selected by a caller. Use an array when the order is
 * significant: JavaScript object enumeration sorts array-index property names.
 * The record form remains supported for existing callers.
 */
export type ACPConfigSelections =
  | readonly ACPConfigSelection[]
  | Readonly<Record<string, string | undefined>>;

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
  public readonly timedOut: boolean;

  public constructor(input: {
    provider: string;
    sessionId: string;
    optionId: string;
    message: string;
    selectedValue?: string;
    acpCode?: number;
    detail?: unknown;
    cause?: unknown;
    timedOut?: boolean;
  }) {
    super(input.message, input.cause !== undefined ? { cause: input.cause } : undefined);
    this.name = "AcpSessionConfigError";
    this.provider = input.provider;
    this.sessionId = input.sessionId;
    this.optionId = input.optionId;
    this.selectedValue = input.selectedValue;
    this.acpCode = input.acpCode;
    this.detail = input.detail;
    this.timedOut = input.timedOut ?? false;
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

  for (const { configId, value: selectedValue } of sessionConfigSelectionEntries(input.selections)) {
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

    const timeoutMessage = `setSessionConfigOption did not respond within ${input.timeoutMs}ms`;
    try {
      const response = await withTimeout(
        input.setOption({ sessionId: input.sessionId, configId, value: selectedValue }),
        input.timeoutMs,
        () => new AcpSessionConfigTimeoutError(timeoutMessage),
      );
      if (!Array.isArray(response?.configOptions)) {
        throw new AcpSessionConfigError({
          provider: input.provider,
          sessionId: input.sessionId,
          optionId: configId,
          selectedValue,
          message: `Session config option "${configId}" response did not include a refreshed catalog.`,
          detail: { reason: MISSING_CONFIG_OPTIONS_REASON },
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
        timedOut: error instanceof AcpSessionConfigTimeoutError,
      });
    }
  }

  return { catalog };
}

function sessionConfigSelectionEntries(selections: ACPConfigSelections): readonly ACPConfigSelection[] {
  if (isOrderedSessionConfigSelections(selections)) {
    return selections;
  }

  return Object.keys(selections).map((configId) => ({ configId, value: selections[configId] }));
}

function isOrderedSessionConfigSelections(
  selections: ACPConfigSelections,
): selections is readonly ACPConfigSelection[] {
  return Array.isArray(selections);
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
