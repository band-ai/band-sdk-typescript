import { describe, expect, it } from "vitest";

import { FAILURE_EVENT_TYPE } from "../src/contracts/protocols";
import { RecoverableTurnError } from "../src/core/errors";
import { FakeTools } from "./testUtils";

/** What every case's delivery fails with, so one assertion can recognize it. */
export const DELIVERY_ERROR = "chat delivery failed";

export interface DeliveryCase {
  /** The delivery path under test, as it reads in the test name. */
  path: string;
  /**
   * Drives one turn in which the provider answered and only the delivery of
   * that answer fails. Build the adapter inside — a case runs once, and fakes
   * that spend their queued response cannot be reused.
   */
  turn: (tools: FakeTools) => Promise<void>;
}

/** Tools that answer every reply the way a room the agent has lost would. */
export function deliveryFailureTools(): FakeTools {
  return new FakeTools({
    failOn: ["sendMessage"],
    errorFactory: () => new Error(DELIVERY_ERROR),
  });
}

/**
 * The contract every adapter owes when the provider answered but Band would
 * not take the answer.
 *
 * Failing this in either direction is a real outage. Resolve, and the message
 * is marked processed with the reply lost. Reject with anything but a
 * `RecoverableTurnError`, and `Execution` stops the room and every other room
 * with it — an agent-wide outage in response to one failed post.
 */
export function describeDeliveryContract(cases: DeliveryCase[]): void {
  describe.each(cases)("delivery failure: $path", ({ turn }) => {
    it("fails the turn recoverably, and reports no provider failure", async () => {
      const tools = deliveryFailureTools();
      const outcome = await turn(tools).then(() => null, (error: unknown) => error);

      expect(outcome, "the turn resolved, so the message is marked processed and the reply is lost").not.toBeNull();
      expect(outcome, "not recoverable: this stops the room and every other room").toBeInstanceOf(RecoverableTurnError);
      expect((outcome as Error).message).toContain(DELIVERY_ERROR);
      expect(
        tools.events.filter((event) => event.messageType === FAILURE_EVENT_TYPE),
        "a Band-side delivery failure was reported as a provider failure",
      ).toEqual([]);
    });
  });
}
