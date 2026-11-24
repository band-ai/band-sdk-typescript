import type { AdapterToolsProtocol } from "../../contracts/protocols";
import {
  BAND_TOOL_EFFECTS,
  KEYED_OPERATION_TOOL_NAMES,
  SEND_MESSAGE_TOOL_NAME,
  carriesOperationIdArg,
  carriesOperationIdOption,
} from "../../contracts/toolSchemas";
import type { BandToolName } from "@band-ai/band-sdk-core";
import { overrideTools } from "../../core/overrideTools";
import { Serializer } from "../../core/singleFlight";
import { bandToolOverrides } from "../../core/turn";
import { DeliveryUnknownError, isDeliveryUnknownOutput } from "../../core/deliveryFailedError";
import type { Logger } from "../../core/logger";
import { JournalPublicationError } from "./errors";

/**
 * A canonical publication call keyed by an operation id: a direct
 * `sendMessage` carries it in its options, a call by name in its arguments.
 */
function carriesOperationId(toolName: BandToolName, args: readonly unknown[]): boolean {
  if (toolName === SEND_MESSAGE_TOOL_NAME && carriesOperationIdOption(args[2])) return true;
  return KEYED_OPERATION_TOOL_NAMES.has(toolName) && carriesOperationIdArg(args[0]);
}

/** A keyed call whose admission could not be read: it is refused rather than dispatched unfenced. */
export class AdmissionGuardError extends Error {
  public constructor() {
    super("The keyed call's admission could not be established; the dispatch is refused rather than run unfenced");
    this.name = "AdmissionGuardError";
  }
}

/**
 * Fences the turn standing behind `tools`, and answers whether the fence
 * stood; when it did not, the caller refuses the dispatch.
 */
export function fenceTurnForKeyedAdmission(tools: AdapterToolsProtocol): boolean {
  try {
    const fence = tools.keyedAdmissionFence;
    if (fence === undefined) return false;
    fence();
    return true;
  } catch {
    return false;
  }
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
 * A keyed call (an `operation_id` present, valid or not) commits the turn to
 * keyed delivery before any validation: its closing text is never relayed as
 * an unkeyed replacement. Only a delivery that stands unknown claims the
 * reply may be in the room. The fences live on this wrapper alone, so a late
 * call through a finished turn's tools never fences a successor.
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
  // Logged once: an operator can tell the turn's closing text was withheld, not absent.
  const fenceKeyed = (context: { toolName?: string }): void => {
    if (!keyedFenced) logger?.debug("a keyed call commits this turn to keyed delivery; its closing text will not be relayed", context);
    keyedFenced = true;
  };

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
    // A keyed call commits this wrapper's turn before any validation, whatever
    // it ends up as; an arguments object that cannot be read refuses the call.
    let admitted: boolean;
    try {
      admitted = carriesOperationId(toolName, args);
    } catch {
      return Promise.reject(new AdmissionGuardError());
    }
    if (admitted) fenceKeyed({ toolName });
    // Only a reply's unknown may stand in the room; a decline posts nothing, and its keyed fence already bars the relay.
    return BAND_TOOL_EFFECTS[toolName] === "reply" ? reply(call) : call();
  });

  return overrideTools(tools, {
    ...overrides,
    unknownDeliveryFenced: () => unknownFenced,
    relayProhibitedFenced: () => keyedFenced || unknownFenced,
    keyedAdmissionFence: () => fenceKeyed({}),
  } as Partial<T>);
}
