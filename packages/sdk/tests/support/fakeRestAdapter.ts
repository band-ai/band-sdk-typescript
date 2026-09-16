import { BandClient } from "@band-ai/rest-client";

import { FernRestAdapter } from "../../src/client/rest/FernRestAdapter";
import type { FernBandClientLike } from "../../src/client/rest/types";
import { createFakeFetchServer, type FakeResponseSpec, type RecordedFetchCall } from "./fakeFetchServer";

/** A `FernRestAdapter` wired to a real generated `BandClient` over a fake `fetch`. */
export function buildFakeRestAdapter(
  responses: FakeResponseSpec[],
): { rest: FernRestAdapter; calls: RecordedFetchCall[] } {
  const { fetch, calls } = createFakeFetchServer(responses);
  const client = new BandClient({
    apiKey: "test-key",
    baseUrl: "http://fake-band.test",
    fetch,
  }) as unknown as FernBandClientLike;
  return { rest: new FernRestAdapter(client), calls };
}
