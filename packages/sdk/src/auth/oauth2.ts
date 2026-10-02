import { createServer } from "node:http";

import {
  allowInsecureRequests,
  authorizationCodeGrant,
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  ClientSecretBasic,
  ClientSecretPost,
  Configuration,
  customFetch,
  enableNonRepudiationChecks,
  None,
  randomNonce,
  randomPKCECodeVerifier,
  randomState,
  ResponseBodyError,
} from "openid-client";
import { z } from "zod";
import { readBoundedResponseText } from "./http";

const DISCOVERY_MAX_BYTES = 256 * 1024;
const DEFAULT_CALLBACK_PATH = "/callback";
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_TOKEN_LIFETIME_SECONDS = 24 * 60 * 60;
const MAX_TIMEOUT_MS = 30 * 60_000;

const OAuthDiscoveryDocumentSchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  jwks_uri: z.string().optional(),
  response_types_supported: z.array(z.string()).optional(),
  grant_types_supported: z.array(z.string()).optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
});
const OAuthCapabilityListSchema = z.array(
  z.string().min(1).max(2_048).refine((value) => !/[\r\n\0]/.test(value)),
);

export interface OAuth2AuthorizationServerMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri?: string;
  responseTypesSupported?: readonly string[];
  grantTypesSupported?: readonly string[];
  codeChallengeMethodsSupported?: readonly string[];
}

export type OAuth2ClientAuthentication =
  | Readonly<{ method: "none" }>
  | Readonly<{ method: "client_secret_basic"; clientSecret: string }>
  | Readonly<{ method: "client_secret_post"; clientSecret: string }>;

export interface DiscoverOAuth2ServerOptions {
  issuer: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  allowedEndpointOrigins?: readonly string[];
  acceptedIssuerValues?: readonly string[];
  timeoutMs?: number;
  requirePkce?: boolean;
  requireRefreshTokenGrant?: boolean;
}

export type OAuth2AuthorizationFailureReason =
  | "authorization_denied"
  | "invalid_callback"
  | "token_exchange_failed"
  | "missing_access_token"
  | "missing_refresh_token"
  | "unsupported_token_type"
  | "invalid_expiry"
  | "cancelled"
  | "timeout";

export type OAuth2AuthorizationResult =
  | Readonly<{
      ok: true;
      accessToken: string;
      refreshToken?: string;
      expiresAt: number;
      scope: string;
      subject?: string;
    }>
  | Readonly<{ ok: false; reason: OAuth2AuthorizationFailureReason }>;

export interface OAuth2AuthorizationAttempt {
  authorizationUrl: URL;
  redirectUri: string;
  result: Promise<OAuth2AuthorizationResult>;
  cancel(): void;
}

export interface StartOAuth2AuthorizationOptions {
  metadata: OAuth2AuthorizationServerMetadata;
  clientId: string;
  scopes: readonly string[];
  clientAuthentication?: OAuth2ClientAuthentication;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  callbackPath?: string;
  requireIdToken?: boolean;
  requireRefreshToken?: boolean;
  compatibleCallbackIssuer?: string;
  idTokenIssuer?: string;
  maxTokenLifetimeSeconds?: number;
  authorizationParameters?: Readonly<Record<string, string>>;
}

export class OAuth2ProtocolError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "OAuth2ProtocolError";
  }
}

export async function discoverOAuth2Server(
  options: DiscoverOAuth2ServerOptions,
): Promise<OAuth2AuthorizationServerMetadata> {
  const issuer = parseSecureUrl(options.issuer, "issuer");
  const discoveryUrl = oidcDiscoveryUrl(issuer);
  const timeout = AbortSignal.timeout(
    boundedTimeout(options.timeoutMs, 15_000, "discovery timeout"),
  );
  const signal = options.signal === undefined
    ? timeout
    : AbortSignal.any([options.signal, timeout]);
  const send = options.fetch ?? fetch;
  const response = await send(discoveryUrl, {
    method: "GET",
    headers: { accept: "application/json" },
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new OAuth2ProtocolError(`OAuth discovery failed with HTTP ${response.status}`);
  }
  const body = await readBoundedResponseText(
    response,
    DISCOVERY_MAX_BYTES,
    () => new OAuth2ProtocolError("OAuth discovery response is too large"),
  );

  let rawDocument: unknown;
  try {
    rawDocument = JSON.parse(body) as unknown;
  } catch {
    throw new OAuth2ProtocolError("OAuth discovery response is not valid JSON");
  }
  const parsedDocument = OAuthDiscoveryDocumentSchema.safeParse(rawDocument);
  if (!parsedDocument.success) {
    throw new OAuth2ProtocolError("OAuth discovery response is malformed");
  }
  const document = parsedDocument.data;

  const discoveredIssuer = requiredString(document.issuer, "issuer");
  const acceptedIssuers = options.acceptedIssuerValues ?? [];
  if (
    discoveredIssuer !== issuer.toString().replace(/\/$/, "") &&
    !acceptedIssuers.includes(discoveredIssuer)
  ) {
    throw new OAuth2ProtocolError("OAuth discovery issuer does not match the requested issuer");
  }

  const allowedOrigins = new Set(
    (options.allowedEndpointOrigins ?? [issuer.origin]).map((origin) =>
      parseSecureUrl(origin, "allowed endpoint origin").origin,
    ),
  );
  const authorizationEndpoint = endpoint(document.authorization_endpoint, "authorization endpoint", allowedOrigins);
  const tokenEndpoint = endpoint(document.token_endpoint, "token endpoint", allowedOrigins);
  const jwksUri = optionalEndpoint(document.jwks_uri, "JWKS endpoint", allowedOrigins);
  const responseTypesSupported = optionalStringArray(document.response_types_supported);
  const grantTypesSupported = optionalStringArray(document.grant_types_supported);
  const codeChallengeMethodsSupported = optionalStringArray(document.code_challenge_methods_supported);

  if (options.requirePkce !== false && !codeChallengeMethodsSupported?.includes("S256")) {
    throw new OAuth2ProtocolError("OAuth server does not advertise S256 PKCE support");
  }
  if (responseTypesSupported !== undefined && !responseTypesSupported.includes("code")) {
    throw new OAuth2ProtocolError("OAuth server does not advertise authorization code responses");
  }
  if (grantTypesSupported !== undefined && !grantTypesSupported.includes("authorization_code")) {
    throw new OAuth2ProtocolError("OAuth server does not advertise the authorization code grant");
  }
  if (options.requireRefreshTokenGrant && !grantTypesSupported?.includes("refresh_token")) {
    throw new OAuth2ProtocolError("OAuth server does not advertise the refresh token grant");
  }

  return {
    issuer: discoveredIssuer,
    authorizationEndpoint,
    tokenEndpoint,
    ...(jwksUri === undefined ? {} : { jwksUri }),
    ...(responseTypesSupported === undefined ? {} : { responseTypesSupported }),
    ...(grantTypesSupported === undefined ? {} : { grantTypesSupported }),
    ...(codeChallengeMethodsSupported === undefined ? {} : { codeChallengeMethodsSupported }),
  };
}

export async function startOAuth2Authorization(
  options: StartOAuth2AuthorizationOptions,
): Promise<OAuth2AuthorizationAttempt> {
  assertClientId(options.clientId);
  if (options.scopes.length === 0 || options.scopes.some((scope) => !isToken(scope))) {
    throw new OAuth2ProtocolError("OAuth scopes must be non-empty tokens");
  }
  const timeoutMs = boundedTimeout(options.timeoutMs, DEFAULT_TIMEOUT_MS, "authorization timeout");
  const callbackPath = validateCallbackPath(options.callbackPath ?? DEFAULT_CALLBACK_PATH);
  const callback = await startLoopbackCallback(timeoutMs, callbackPath);
  const state = randomState();
  const nonce = options.requireIdToken === false ? undefined : randomNonce();
  const codeVerifier = randomPKCECodeVerifier();
  const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);
  const config = createConfiguration(options.metadata, options.clientId, options.clientAuthentication, options.fetch);
  const exchangeConfig = options.idTokenIssuer === undefined
    ? config
    : createConfiguration(
        { ...options.metadata, issuer: options.idTokenIssuer },
        options.clientId,
        options.clientAuthentication,
        options.fetch,
      );
  const authorizationUrl = buildAuthorizationUrl(config, {
    ...options.authorizationParameters,
    redirect_uri: callback.redirectUri,
    response_type: "code",
    scope: options.scopes.join(" "),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    ...(nonce === undefined ? {} : { nonce }),
  });

  let terminal: OAuth2AuthorizationResult | undefined;
  let callbackClaimed = false;
  let settle!: (value: OAuth2AuthorizationResult) => void;
  const result = new Promise<OAuth2AuthorizationResult>((resolve) => {
    settle = resolve;
  });
  const finish = (value: OAuth2AuthorizationResult): void => {
    if (terminal !== undefined) return;
    terminal = value;
    callback.close();
    settle(value);
  };
  callback.onCallback(async (url, respond) => {
    if (terminal !== undefined) {
      respond(410, callbackPage("This sign-in attempt is no longer active."));
      return;
    }
    if (!single(url, "state") || url.searchParams.get("state") !== state) {
      respond(400, callbackPage("This sign-in response did not match the active request."));
      return;
    }
    const callbackIssuer = url.searchParams.get("iss");
    if (
      callbackIssuer !== null &&
      callbackIssuer !== options.metadata.issuer &&
      callbackIssuer !== options.compatibleCallbackIssuer
    ) {
      respond(400, callbackPage("The identity provider did not match this sign-in request."));
      return;
    }
    if (!single(url, "error")) {
      respond(400, callbackPage("The identity provider returned an invalid error response."));
      finish({ ok: false, reason: "invalid_callback" });
      return;
    }
    const providerError = url.searchParams.get("error");
    if (providerError !== null) {
      respond(200, callbackPage("Band sign-in was not approved. You can close this window."));
      finish({ ok: false, reason: providerError === "access_denied" ? "authorization_denied" : "invalid_callback" });
      return;
    }
    if (!single(url, "code") || !single(url, "iss") || url.searchParams.get("code") === null) {
      respond(400, callbackPage("The identity provider returned an incomplete sign-in response."));
      finish({ ok: false, reason: "invalid_callback" });
      return;
    }
    if (callbackClaimed) {
      respond(409, callbackPage("This sign-in response is already being processed."));
      return;
    }
    callbackClaimed = true;
    try {
      const tokens = await authorizationCodeGrant(exchangeConfig, url, {
        expectedState: state,
        ...(nonce === undefined ? {} : { expectedNonce: nonce }),
        pkceCodeVerifier: codeVerifier,
        idTokenExpected: options.requireIdToken !== false,
      });
      const parsed = normalizeTokenResponse(tokens, {
        requireRefreshToken: options.requireRefreshToken ?? false,
        maxLifetimeSeconds: options.maxTokenLifetimeSeconds ?? DEFAULT_MAX_TOKEN_LIFETIME_SECONDS,
        scope: options.scopes.join(" "),
      });
      respond(
        parsed.ok ? 200 : 400,
        callbackPage(parsed.ok
          ? "Sign-in complete. You can close this window and return to your application."
          : "The identity provider returned an unusable session."),
      );
      finish(parsed);
    } catch (error) {
      respond(400, callbackPage("The authorization code could not be exchanged."));
      finish({
        ok: false,
        reason: error instanceof ResponseBodyError && error.error === "access_denied"
          ? "authorization_denied"
          : "token_exchange_failed",
      });
    }
  });

  const timeout = setTimeout(() => finish({ ok: false, reason: "timeout" }), timeoutMs);
  timeout.unref?.();
  void result.finally(() => clearTimeout(timeout));

  const onAbort = (): void => finish({ ok: false, reason: "cancelled" });
  if (options.signal?.aborted) {
    onAbort();
  } else {
    options.signal?.addEventListener("abort", onAbort, { once: true });
  }
  void result.finally(() => options.signal?.removeEventListener("abort", onAbort));

  return {
    authorizationUrl,
    redirectUri: callback.redirectUri,
    result,
    cancel: () => finish({ ok: false, reason: "cancelled" }),
  };
}

export function createOAuth2Configuration(input: {
  metadata: OAuth2AuthorizationServerMetadata;
  clientId: string;
  clientAuthentication?: OAuth2ClientAuthentication;
  fetch?: typeof fetch;
}): Configuration {
  return createConfiguration(input.metadata, input.clientId, input.clientAuthentication, input.fetch);
}

function createConfiguration(
  metadata: OAuth2AuthorizationServerMetadata,
  clientId: string,
  authentication: OAuth2ClientAuthentication | undefined,
  send: typeof fetch | undefined,
): Configuration {
  const config = new Configuration(
    {
      issuer: metadata.issuer,
      authorization_endpoint: metadata.authorizationEndpoint,
      token_endpoint: metadata.tokenEndpoint,
      ...(metadata.jwksUri === undefined ? {} : { jwks_uri: metadata.jwksUri }),
      ...(metadata.responseTypesSupported === undefined
        ? {}
        : { response_types_supported: [...metadata.responseTypesSupported] }),
      ...(metadata.grantTypesSupported === undefined
        ? {}
        : { grant_types_supported: [...metadata.grantTypesSupported] }),
      ...(metadata.codeChallengeMethodsSupported === undefined
        ? {}
        : { code_challenge_methods_supported: [...metadata.codeChallengeMethodsSupported] }),
    },
    clientId,
    undefined,
    clientAuthentication(authentication),
  );
  if (
    [metadata.authorizationEndpoint, metadata.tokenEndpoint, metadata.jwksUri]
      .filter((value): value is string => value !== undefined)
      .some((value) => new URL(value).protocol === "http:")
  ) {
    allowInsecureRequests(config);
  }
  if (send !== undefined) {
    config[customFetch] = (url, init) =>
      send(url, init as unknown as RequestInit);
  }
  if (metadata.jwksUri !== undefined) enableNonRepudiationChecks(config);
  return config;
}

function clientAuthentication(value: OAuth2ClientAuthentication | undefined) {
  if (value === undefined || value.method === "none") return None();
  return value.method === "client_secret_basic"
    ? ClientSecretBasic(value.clientSecret)
    : ClientSecretPost(value.clientSecret);
}

interface OAuthTokenEndpointResponse {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  claims(): Readonly<Record<string, unknown>> | undefined;
}

function normalizeTokenResponse(
  tokens: OAuthTokenEndpointResponse,
  options: { requireRefreshToken: boolean; maxLifetimeSeconds: number; scope: string },
): OAuth2AuthorizationResult {
  if (typeof tokens.access_token !== "string" || tokens.access_token.length === 0) {
    return { ok: false, reason: "missing_access_token" };
  }
  if (tokens.token_type?.toLowerCase() !== "bearer") {
    return { ok: false, reason: "unsupported_token_type" };
  }
  const lifetime = tokens.expires_in;
  if (
    typeof lifetime !== "number" ||
    !Number.isFinite(lifetime) ||
    lifetime <= 0 ||
    lifetime > options.maxLifetimeSeconds
  ) {
    return { ok: false, reason: "invalid_expiry" };
  }
  if (
    options.requireRefreshToken &&
    (typeof tokens.refresh_token !== "string" || tokens.refresh_token.length === 0)
  ) {
    return { ok: false, reason: "missing_refresh_token" };
  }
  const claims = tokens.claims();
  return {
    ok: true,
    accessToken: tokens.access_token,
    ...(typeof tokens.refresh_token === "string" && tokens.refresh_token.length > 0
      ? { refreshToken: tokens.refresh_token }
      : {}),
    expiresAt: Date.now() + Math.floor(lifetime * 1_000),
    scope: typeof tokens.scope === "string" ? tokens.scope : options.scope,
    ...(claims !== undefined && typeof claims.sub === "string" ? { subject: claims.sub } : {}),
  };
}

function oidcDiscoveryUrl(issuer: URL): URL {
  const path = issuer.pathname === "/" ? "" : issuer.pathname.replace(/\/$/, "");
  return new URL(`/.well-known/openid-configuration${path}`, issuer.origin);
}

function endpoint(value: unknown, label: string, allowedOrigins: ReadonlySet<string>): string {
  const parsed = parseSecureUrl(requiredString(value, label), label);
  if (!allowedOrigins.has(parsed.origin)) {
    throw new OAuth2ProtocolError(`OAuth ${label} is on an untrusted origin`);
  }
  return parsed.toString();
}

function optionalEndpoint(
  value: unknown,
  label: string,
  allowedOrigins: ReadonlySet<string>,
): string | undefined {
  return value === undefined ? undefined : endpoint(value, label, allowedOrigins);
}

function parseSecureUrl(value: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new OAuth2ProtocolError(`OAuth ${label} is not a URL`);
  }
  const local = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) {
    throw new OAuth2ProtocolError(`OAuth ${label} must use HTTPS`);
  }
  if (parsed.username !== "" || parsed.password !== "" || parsed.hash !== "") {
    throw new OAuth2ProtocolError(`OAuth ${label} contains unsupported URL components`);
  }
  return parsed;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096 || /[\r\n\0]/.test(value)) {
    throw new OAuth2ProtocolError(`OAuth ${label} is missing or invalid`);
  }
  return value;
}

function optionalStringArray(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  const parsed = OAuthCapabilityListSchema.safeParse(value);
  if (!parsed.success) {
    throw new OAuth2ProtocolError("OAuth discovery capability list is malformed");
  }
  return parsed.data;
}

function assertClientId(value: string): void {
  if (!isToken(value) || value.length > 512) {
    throw new OAuth2ProtocolError("OAuth client ID is invalid");
  }
}

function isToken(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 2_048 && !/[\s\r\n\0]/.test(value);
}


function boundedTimeout(value: number | undefined, fallback: number, label: string): number {
  const timeout = value ?? fallback;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_MS) {
    throw new OAuth2ProtocolError(`OAuth ${label} is invalid`);
  }
  return timeout;
}

function single(url: URL, name: string): boolean {
  return url.searchParams.getAll(name).length <= 1;
}

function validateCallbackPath(value: string): string {
  if (
    value.length === 0 ||
    value.length > 256 ||
    !/^\/[A-Za-z0-9._~/-]*$/u.test(value)
  ) {
    throw new OAuth2ProtocolError("OAuth callback path is invalid");
  }
  return value;
}

function callbackPage(message: string): string {
  const escaped = message.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<!doctype html><meta charset="utf-8"><title>Sign-in</title><body><p>${escaped}</p></body>`;
}

async function startLoopbackCallback(timeoutMs: number, callbackPath: string): Promise<{
  redirectUri: string;
  onCallback(
    handler: (url: URL, respond: (status: number, body: string) => void) => void | Promise<void>,
  ): void;
  close(): void;
}> {
  let callbackHandler:
    | ((url: URL, respond: (status: number, body: string) => void) => void | Promise<void>)
    | undefined;
  const server = createServer((request, response) => {
    const address = server.address();
    if (typeof address === "string" || address === null) {
      response.writeHead(503).end();
      return;
    }
    const expectedHost = `127.0.0.1:${address.port}`;
    if (request.method !== "GET" || request.headers.host !== expectedHost) {
      response.writeHead(404).end();
      return;
    }
    const url = new URL(request.url ?? "/", `http://${expectedHost}`);
    if (url.pathname !== callbackPath || callbackHandler === undefined) {
      response.writeHead(404).end();
      return;
    }
    const respond = (status: number, body: string): void => {
      response.writeHead(status, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
        "x-content-type-options": "nosniff",
      });
      response.end(body);
    };
    void Promise.resolve(callbackHandler(url, respond)).catch(() => {
      if (!response.headersSent) {
        respond(500, callbackPage("The sign-in callback could not be processed."));
      }
    });
  });
  server.requestTimeout = timeoutMs;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (typeof address === "string" || address === null) {
    server.close();
    throw new OAuth2ProtocolError("OAuth callback listener did not bind a TCP port");
  }
  return {
    redirectUri: `http://127.0.0.1:${address.port}${callbackPath}`,
    onCallback(handler) {
      callbackHandler = handler;
    },
    close() {
      server.close();
    },
  };
}
