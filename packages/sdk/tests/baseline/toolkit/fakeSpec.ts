import { GenericAdapter } from "../../../src/adapters";
import type { AdapterId } from "./adapters";
import type { AdapterSpec } from "./registry";

/** A roster spec for the toolkit's own unit tests: nothing required or supported, and an adapter that does nothing. */
export const fakeSpec = (id: AdapterId, overrides: Partial<AdapterSpec<AdapterId>> = {}): AdapterSpec<AdapterId> => ({
  id,
  requires: [],
  supports: [],
  build: () => new GenericAdapter(async () => {}),
  ...overrides,
});
