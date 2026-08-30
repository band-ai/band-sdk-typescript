import { asErrorMessage, UnsupportedFeatureError } from "../../core/errors";
import { LazyAsyncValue } from "../shared/lazyAsyncValue";

type ACPModule = typeof import("@agentclientprotocol/sdk");

export const acpModule = new LazyAsyncValue<ACPModule>({
  load: async () => {
    return await import("@agentclientprotocol/sdk").catch((error: unknown) => {
      throw new UnsupportedFeatureError(
        `ACP adapters require optional dependency "@agentclientprotocol/sdk". Install it with "pnpm add @agentclientprotocol/sdk". (${asErrorMessage(error)})`,
      )
    })
  },
});
