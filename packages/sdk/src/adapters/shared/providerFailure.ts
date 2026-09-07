import { AgentFailure } from "@band-ai/band-sdk-core";

import type { MessagingTools } from "../../contracts/protocols";
import { RecoverableTurnError } from "../../core/errors";
import type { Logger } from "../../core/logger";

/**
 * `AgentFailure.code` for a provider that failed to respond before its own
 * turn timeout. One constant so every adapter's timeout path reports the
 * same code instead of retyping the literal.
 */
export const FAILURE_CODE_TIMEOUT = "timeout";

/**
 * A provider failure that has already been reported to the room.
 *
 * Thrown, not returned, so the turn still *fails*: `PlatformRuntime` marks a
 * message failed only when `onEvent` throws, and the platform re-syncs failed
 * messages rather than processed ones. Returning here would flip a failed turn
 * to `processed` and drop its retry along with it.
 *
 * `RecoverableTurnError` is what changes: the turn fails, the room and every
 * other room keep running. Reporting a provider error must not take the agent
 * down, which is what an ordinary throw from here used to do.
 */
export class ProviderTurnFailedError extends RecoverableTurnError {
  public constructor(public readonly failure: AgentFailure) {
    super(failure.message);
    this.name = "ProviderTurnFailedError";
  }
}

/** Reports a terminal provider failure, then fails the turn that hit it. */
export async function reportTurnFailure(
  tools: MessagingTools,
  failure: AgentFailure,
): Promise<never> {
  // A rejecting sendFailure must not replace the ProviderTurnFailedError below
  // with a raw, unrecognized rejection — that would escalate past the turn
  // and take the whole runtime down instead of just failing this turn.
  await tools.sendFailure(failure).catch(() => undefined);
  throw new ProviderTurnFailedError(failure);
}

/**
 * Call first in any catch that would otherwise report a provider failure a
 * second time. `reportTurnFailure`/`ProviderTurnFailedError` already reported
 * this incident before throwing; rethrowing intact — rather than rebuilding
 * and reporting a fresh `AgentFailure` from its message — is what keeps a
 * terminal-failure branch nested inside a broader try from double-posting.
 */
export function rethrowIfProviderTurnFailure(error: unknown): void {
  if (error instanceof ProviderTurnFailedError) {
    throw error;
  }
}

/**
 * Reports a failure without letting `sendFailure` itself take the turn down.
 *
 * `sendFailure` is not unconditionally non-throwing (see `MessagingTools`),
 * so a caller reporting from a failure path — one that can't afford a new
 * throw here to replace the failure it's reporting — swallows and logs it
 * instead. One shared guard rather than a copy of this try/catch per adapter.
 */
export async function safeSendFailure(
  tools: MessagingTools,
  failure: AgentFailure,
  logger: Logger,
  logContext?: Record<string, unknown>,
): Promise<void> {
  try {
    await tools.sendFailure(failure);
  } catch (error) {
    logger.warn("provider_failure.report_failed", {
      provider: failure.provider,
      code: failure.code,
      ...logContext,
      error,
    });
  }
}

/**
 * Builds an `AgentFailure` whose `detail` cannot make the constructor throw.
 *
 * `detail` carries raw provider payloads — an HTTP body, an RPC error object —
 * and the constructor rejects anything it cannot serialize: a `Buffer`, a
 * function-valued property, a cycle. It is built on failure paths, often as an
 * argument outside the enclosing guard, where a throw would replace the very
 * failure being reported. An unusable detail is dropped instead; the provider,
 * message and code are typed as strings, so only `detail` can be exotic.
 */
export function agentFailure(
  provider: string,
  message: string,
  code?: string,
  detail?: unknown,
): AgentFailure {
  if (detail === undefined) {
    return new AgentFailure(provider, message, code);
  }
  try {
    return new AgentFailure(provider, message, code, detail);
  } catch {
    return new AgentFailure(provider, message, code);
  }
}
