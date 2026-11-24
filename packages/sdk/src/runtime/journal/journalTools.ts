import type { AdapterToolsProtocol } from "../../contracts/protocols";
import { BAND_TOOL_EFFECTS, NO_REPLY_TOOL_NAME, SEND_MESSAGE_TOOL_NAME } from "../../contracts/toolSchemas";
import type { BandToolName } from "@band-ai/band-sdk-core";
import { overrideTools } from "../../core/overrideTools";
import { Serializer } from "../../core/singleFlight";
import { bandToolOverrides } from "../../core/turn";
import { DeliveryUnknownError, isDeliveryUnknownOutput } from "../../core/deliveryFailedError";
import type { Logger } from "../../core/logger";
import { JournalPublicationError } from "./errors";

/**
 * A canonical publication call carrying an `operation_id`, on the field's
 * presence rather than its parsed value: a direct `sendMessage` carries it in
 * its options, a `band_no_reply` in its arguments. An explicit
 * `operation_id: undefined` stands as a supplied, invalid id.
 */
export function carriesOperationId(toolName: BandToolName, args: readonly unknown[]): boolean {
  if (toolName === SEND_MESSAGE_TOOL_NAME) {
    // A direct `sendMessage` carries the id in its options; the same call
    // through `executeToolCall` carries it in the arguments object.
    const options = args.length > 2 ? args[2] : undefined;
    if (typeof options === "object" && options !== null && Object.hasOwn(options, "operationId")) {
      return true;
    }
    const arguments_ = args[0];
    return typeof arguments_ === "object" && arguments_ !== null && Object.hasOwn(arguments_, "operation_id");
  }
  if (toolName !== NO_REPLY_TOOL_NAME) {
    return false;
  }
  const arguments_ = args[0];
  return typeof arguments_ === "object" && arguments_ !== null && Object.hasOwn(arguments_, "operation_id");
}

/**
 * The mark a keyed call's admission leaves on the turn it fences: the MCP
 * transport decorator resolves the turn's tools at the raw call and sets this
 * flag before the framework's validation, so a keyed call — valid or not —
 * fences the turn it was admitted on the same way a delivery-unknown reply
 * would, and the turn's closing text is never relayed as an unkeyed
 * replacement.
 */
export const KEYED_ADMISSION_FENCE = Symbol("band.keyedAdmissionFence");

/**
 * A keyed call whose admission could not be established: the accessor that
 * would fence the turn it stands on threw, so the call is refused before
 * dispatch — never dispatched unfenced.
 */
export class AdmissionGuardError extends Error {
  public constructor() {
    super("The keyed call's admission could not be established; the dispatch is refused rather than run unfenced");
    this.name = "AdmissionGuardError";
  }
}

/**
 * Fences the turn standing behind `tools`, when its wrappers carry the fence.
 * Answers whether the fence stood: an accessor that cannot be run has not
 * fenced, and the caller must refuse the dispatch rather than run it
 * unfenced.
 */
export function fenceTurnForKeyedAdmission(tools: unknown): boolean {
  let marker: { fence: () => void } | undefined;
  try {
    marker = (tools as { [KEYED_ADMISSION_FENCE]?: { fence: () => void } | undefined } | undefined)?.[KEYED_ADMISSION_FENCE];
  } catch {
    // The turn's fence could not be read: it did not stand.
    return false;
  }
  if (marker === undefined) {
    return false;
  }
  try {
    marker.fence();
  } catch {
    return false;
  }
  return true;
}

/**
 * Wraps the tools a turn runs on, keeping the turn's side of the runtime's
 * durable publications honest: a classified delivery-unknown (thrown, or
 * surfaced as a tool-executor error) fences this turn, so its later replies
 * and closing text are refused rather than posted beside a reply Band may
 * hold. Replies run one at a time, so one made while another is in flight
 * waits for its outcome. The fence stands on the wrapper itself — the
 * adapter's turn object reads it through `unknownDeliveryFenced` — so a late
 * result fences the turn it ran on and cannot reach a successor, which wraps
 * its own tools. A cut-short turn's calls are refused by the runtime's
 * `revokedOnStop` wrapper around this one.
 *
 * A canonical keyed call — a send or no-reply carrying an `operation_id`, on
 * the field's presence, valid or not — commits this wrapper's turn to keyed
 * delivery before any validation or capability check, whatever the call ends
 * up: the turn's closing text is never relayed as an unkeyed replacement on
 * top of it. A definite refusal blocks that relay and claims no possible
 * remote delivery; only a delivery that stands unknown does.
 *
 * The durable intent and settlement themselves live in the runtime's
 * publication engine, which the context's tools already carry; this wrapper
 * only owns the turn's own behavior around them. The turn's fences stand on
 * this wrapper alone — no room-level side channel — so a call made through a
 * completed turn's tools fences that turn and never a successor, and a call
 * made with no turn standing fences nothing.
 */
export function journalingTools<T extends AdapterToolsProtocol>(
  tools: T,
  logger?: Logger,
): T {
  // Set once this turn had a reply whose delivery stands unknown; the adapter's
  // turn reads it through the wrapper it runs on.
  let unknownFenced = false;
  // Set once this turn made a canonical keyed call, valid or not, accepted or
  // refused: its closing text is never relayed as an unkeyed replacement. A
  // definite refusal claims no possible remote delivery, so it stands here,
  // not in `unknownFenced`.
  let keyedFenced = false;
  // A turn's replies post one at a time, so each sees the fence the one before
  // it may have raised rather than post beside a reply still in doubt.
  const replies = new Serializer();

  const observe = (call: () => Promise<unknown>): Promise<unknown> => call().then(
    (result) => {
      if (isDeliveryUnknownOutput(result)) {
        unknownFenced = true;
      }
      return result;
    },
    (error: unknown) => {
      if (error instanceof DeliveryUnknownError) {
        unknownFenced = true;
      } else {
        logger?.debug("a turn's reply delivery failed", { error });
      }
      throw error;
    },
  );

  const reply = (call: () => Promise<unknown>): Promise<unknown> => replies.run(() => {
    if (unknownFenced) {
      throw new JournalPublicationError(
        "This turn already has a reply whose delivery is unknown; a replacement is refused rather than posted beside it",
        "fenced",
      );
    }
    return observe(call);
  });

  const overrides = bandToolOverrides(tools, (toolName, call, args) => {
    // A canonical publication call carrying an `operation_id` — on the field's
    // presence, not its parsed value — commits this wrapper's turn to keyed
    // delivery before any validation or capability check: whatever the call
    // ends up, accepted, refused, or unsupported, the turn's closing text is
    // not relayed as an unkeyed replacement on top of it. The stand is on the
    // wrapper itself, so a late call made through a completed turn's tools
    // fences that turn and never reaches a successor, which wraps its own
    // tools. The admission accessor is guarded: if it cannot run, the call is
    // refused before dispatch rather than run unfenced.
    let admitted: boolean;
    try {
      admitted = carriesOperationId(toolName, args);
    } catch {
      return Promise.reject(new AdmissionGuardError());
    }
    if (admitted) {
      keyedFenced = true;
    }
    const effect = BAND_TOOL_EFFECTS[toolName];
    if (effect === "reply") return reply(call);
    return effect === "decline" ? observe(call) : call();
  });

  return overrideTools(tools, {
    ...overrides,
    unknownDeliveryFenced: () => unknownFenced,
    relayProhibitedFenced: () => keyedFenced || unknownFenced,
    [KEYED_ADMISSION_FENCE]: { fence: () => { keyedFenced = true; } },
  } as unknown as Partial<T>);
}
