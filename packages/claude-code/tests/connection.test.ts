import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  BandHumanAuth,
  BandHumanSignInResult,
  OAuthCredentialStore,
} from "@band-ai/sdk/auth";
import { NoopLogger } from "@band-ai/sdk/core";
import type { ElicitRequestURLParams } from "@modelcontextprotocol/sdk/types.js";

import { BandConnectionController } from "../src/connection";
import type { PluginStateStore } from "../src/state";

const controllers: BandConnectionController[] = [];

function createController(auth: BandHumanAuth): BandConnectionController {
  const controller = new BandConnectionController({
    auth,
    credentials: {
      get: async () => undefined,
      set: async () => undefined,
      delete: async () => undefined,
    } satisfies OAuthCredentialStore,
    state: {} as PluginStateStore,
    context: {
      sessionId: "00000000-0000-4000-8000-000000000001",
      projectRoot: "/projects/one",
    },
    startRuntime: async () => {
      throw new Error("unexpected runtime start");
    },
    logger: new NoopLogger(),
  });
  controllers.push(controller);
  return controller;
}

afterEach(async () => {
  await Promise.all(controllers.splice(0).map((controller) => controller.stop()));
});

describe("BandConnectionController startup authentication", () => {
  it("prompts once after initialization when URL elicitation is supported", async () => {
    let finishSignIn: ((result: BandHumanSignInResult) => void) | undefined;
    const signInResult = new Promise<BandHumanSignInResult>((resolve) => {
      finishSignIn = resolve;
    });
    const cancel = vi.fn(() => finishSignIn?.({ ok: false, reason: "cancelled" }));
    const restore = vi.fn(async () => null);
    const beginSignIn = vi.fn(async () => ({
      authorizationUrl: new URL(
        "https://auth.band.ai/oauth2/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A49184%2Fcallback",
      ),
      redirectUri: "http://127.0.0.1:49184/callback",
      result: signInResult,
      cancel,
    }));
    const auth = {
      platformOrigin: "https://app.band.ai",
      restore,
      beginSignIn,
    } as unknown as BandHumanAuth;
    const controller = createController(auth);
    let elicitation: ElicitRequestURLParams | undefined;
    const notifyComplete = vi.fn(async () => undefined);
    controller.attachHost({
      supportsUrlElicitation: () => true,
      elicitInput: vi.fn(async (params) => {
        elicitation = params;
        return { action: "decline" as const };
      }),
      createElicitationCompletionNotifier: () => notifyComplete,
    });

    await Promise.all([
      controller.promptForAuthentication(),
      controller.initialize(),
    ]);

    expect(restore).toHaveBeenCalledOnce();
    expect(beginSignIn).toHaveBeenCalledOnce();
    expect(elicitation).toMatchObject({
      mode: "url",
      url: expect.stringContaining("redirect_uri=http%3A%2F%2F127.0.0.1%3A49184%2Fcallback"),
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(notifyComplete).toHaveBeenCalledOnce();
  });

  it("does not start an invisible browser flow when URL elicitation is unsupported", async () => {
    const beginSignIn = vi.fn();
    const auth = {
      platformOrigin: "https://app.band.ai",
      restore: vi.fn(async () => null),
      beginSignIn,
    } as unknown as BandHumanAuth;
    const controller = createController(auth);
    controller.attachHost({
      supportsUrlElicitation: () => false,
      elicitInput: vi.fn(),
      createElicitationCompletionNotifier: vi.fn(),
    });

    await controller.promptForAuthentication();

    expect(beginSignIn).not.toHaveBeenCalled();
  });
});
