import { describe, expect, it, vi } from "vitest";

import { FernRestAdapter } from "../src/client/rest/FernRestAdapter";

/**
 * removeContact and respondContactRequest each accept two mutually
 * exclusive request shapes (address by handle, or by id) and pick the wire
 * payload with a `request.target === "handle"` ternary — a broken condition
 * would silently send the wrong payload on whichever branch goes untested.
 */
describe("FernRestAdapter: contact request addressing modes", () => {
  it("removeContact sends { handle } when targeting by handle", async () => {
    const removeAgentContact = vi.fn(async () => ({ data: { status: "removed" } }));
    const adapter = new FernRestAdapter({
      agentContacts: { removeAgentContact },
    });

    await expect(
      adapter.removeContact({ target: "handle", handle: "@jane" }),
    ).resolves.toEqual({ status: "removed" });
    expect(removeAgentContact).toHaveBeenCalledWith({ handle: "@jane" }, expect.any(Object));
  });

  it("respondContactRequest sends { request_id } when targeting by requestId", async () => {
    const respondToAgentContactRequest = vi.fn(async () => ({ data: { status: "approved" } }));
    const adapter = new FernRestAdapter({
      agentContacts: { respondToAgentContactRequest },
    });

    await expect(
      adapter.respondContactRequest({ action: "approve", target: "requestId", requestId: "req-5" }),
    ).resolves.toEqual({ status: "approved" });
    expect(respondToAgentContactRequest).toHaveBeenCalledWith(
      { action: "approve", request_id: "req-5" },
      expect.any(Object),
    );
  });
});
