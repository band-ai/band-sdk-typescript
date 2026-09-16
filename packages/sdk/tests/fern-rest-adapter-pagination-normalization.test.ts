import { describe, expect, it } from "vitest";

import { normalizeFernPaginatedResponse } from "../src/client/rest/FernRestAdapter";

/**
 * `normalizeFernPaginatedResponse` is shared by every list endpoint
 * (listPeers, listChats, listContacts, listMemories, listMessages,
 * getChatContext). A response that fails to unwrap to an object at all
 * (e.g. a bare array, or no body) must degrade to an empty page, not throw.
 */
describe("FernRestAdapter: normalizeFernPaginatedResponse against a non-object envelope", () => {
  it("returns an empty page instead of throwing when the response is not an object", () => {
    const response = normalizeFernPaginatedResponse(
      null,
      (item) => (typeof item.id === "string" ? item.id : null),
    );

    expect(response).toEqual({ data: [], metadata: {} });
  });
});
