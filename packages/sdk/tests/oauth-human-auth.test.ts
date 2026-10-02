import { createServer } from "node:http";

import { describe, expect, it, vi } from "vitest";

import {
  BandHumanClient,
  BAND_HUMAN_OAUTH_CALLBACK_PATH,
  MemoryOAuthCredentialStore,
  OAuth2ProtocolError,
  OAuth2Session,
  OAuth2SessionExpiredError,
  discoverOAuth2Server,
  startOAuth2Authorization,
} from "../src/auth";

const metadata = {
  issuer: "https://auth.example.com",
  authorization_endpoint: "https://auth.example.com/oauth2/authorize",
  token_endpoint: "https://auth.example.com/oauth2/token",
  jwks_uri: "https://auth.example.com/.well-known/jwks.json",
  response_types_supported: ["code", "token id_token"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
};

describe("OAuth discovery", () => {
  it("accepts a PKCE authorization server whose endpoints stay on the approved origin", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(metadata), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await discoverOAuth2Server({
      issuer: metadata.issuer,
      requireRefreshTokenGrant: true,
      fetch: send,
    });

    expect(result).toMatchObject({
      issuer: metadata.issuer,
      authorizationEndpoint: metadata.authorization_endpoint,
      tokenEndpoint: metadata.token_endpoint,
    });
    expect(send).toHaveBeenCalledWith(
      new URL("https://auth.example.com/.well-known/openid-configuration"),
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("rejects discovered token endpoints on an unapproved origin", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ ...metadata, token_endpoint: "https://attacker.example/token" }),
        { status: 200 },
      ),
    );

    await expect(
      discoverOAuth2Server({ issuer: metadata.issuer, fetch: send }),
    ).rejects.toThrow(OAuth2ProtocolError);
  });

  it("completes PKCE authorization against an explicitly local HTTP provider", async () => {
    const provider = createServer((request, response) => {
      if (request.method !== "POST" || request.url !== "/token") {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(
        JSON.stringify({
          access_token: "local-access-token",
          token_type: "Bearer",
          expires_in: 3600,
        }),
      );
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const address = provider.address();
    if (address === null || typeof address === "string") throw new Error("Local provider did not bind");
    const issuer = `http://127.0.0.1:${address.port}`;
    let attempt: Awaited<ReturnType<typeof startOAuth2Authorization>> | undefined;

    try {
      attempt = await startOAuth2Authorization({
        metadata: {
          issuer,
          authorizationEndpoint: `${issuer}/authorize`,
          tokenEndpoint: `${issuer}/token`,
          responseTypesSupported: ["code"],
          grantTypesSupported: ["authorization_code"],
          codeChallengeMethodsSupported: ["S256"],
        },
        clientId: "local-public-client",
        scopes: ["profile"],
        requireIdToken: false,
        requireRefreshToken: false,
      });
      const state = attempt.authorizationUrl.searchParams.get("state");
      expect(state).not.toBeNull();
      const callback = new URL(attempt.redirectUri);
      expect(callback.pathname).toBe(BAND_HUMAN_OAUTH_CALLBACK_PATH);
      expect(attempt.authorizationUrl.searchParams.get("redirect_uri")).toBe(attempt.redirectUri);
      callback.searchParams.set("code", "authorization-code");
      callback.searchParams.set("state", state!);
      await fetch(callback);

      await expect(attempt.result).resolves.toMatchObject({
        ok: true,
        accessToken: "local-access-token",
        scope: "profile",
      });
    } finally {
      attempt?.cancel();
      await new Promise<void>((resolve, reject) => {
        provider.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  });
});

describe("OAuth2Session", () => {
  it("does not reinstall a refreshed credential after sign-out wins the race", async () => {
    let markRequestStarted!: () => void;
    let releaseTokenResponse!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    const releaseResponse = new Promise<void>((resolve) => {
      releaseTokenResponse = resolve;
    });
    const provider = createServer((request, response) => {
      if (request.method !== "POST" || request.url !== "/token") {
        response.writeHead(404).end();
        return;
      }
      markRequestStarted();
      void releaseResponse.then(() => {
        response.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        response.end(
          JSON.stringify({
            access_token: "refreshed-access-token",
            refresh_token: "rotated-refresh-token",
            token_type: "Bearer",
            expires_in: 3600,
          }),
        );
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const address = provider.address();
    if (address === null || typeof address === "string") throw new Error("Local provider did not bind");
    const issuer = `http://127.0.0.1:${address.port}`;
    const store = new MemoryOAuthCredentialStore();
    const session = new OAuth2Session({ store, storeKey: "race" });

    try {
      await session.install({
        metadata: {
          issuer,
          authorizationEndpoint: `${issuer}/authorize`,
          tokenEndpoint: `${issuer}/token`,
          grantTypesSupported: ["authorization_code", "refresh_token"],
          codeChallengeMethodsSupported: ["S256"],
        },
        clientId: "local-public-client",
        scopes: ["profile"],
        authorization: {
          ok: true,
          accessToken: "initial-access-token",
          refreshToken: "initial-refresh-token",
          expiresAt: Date.now() + 3600_000,
          scope: "profile",
        },
      });
      session.invalidateAccessToken();
      const refreshing = session.getAccessToken();
      await requestStarted;
      await session.clear();
      releaseTokenResponse();

      await expect(refreshing).rejects.toThrow(OAuth2SessionExpiredError);
      await expect(store.get("race")).resolves.toBeUndefined();
    } finally {
      releaseTokenResponse();
      await new Promise<void>((resolve, reject) => {
        provider.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  });
});

describe("BandHumanClient", () => {
  it("renews a rejected bearer credential once before returning the profile", async () => {
    const tokens = ["expired-token", "fresh-token"];
    const getAccessToken = vi.fn(async () => tokens.shift() ?? "fresh-token");
    const invalidateAccessToken = vi.fn();
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { id: "person-1", handle: "nirs" } }), {
          status: 200,
        }),
      );
    const client = new BandHumanClient({
      platformOrigin: "https://app.band.ai",
      getAccessToken,
      invalidateAccessToken,
      fetch: send,
    });

    await expect(client.getProfile()).resolves.toEqual({ id: "person-1", handle: "nirs" });
    expect(invalidateAccessToken).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: "Bearer expired-token",
    });
    expect(send.mock.calls[1]?.[1]?.headers).toMatchObject({
      authorization: "Bearer fresh-token",
    });
  });
});
