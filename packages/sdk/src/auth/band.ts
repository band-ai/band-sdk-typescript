import { createHash } from "node:crypto";

import { z } from "zod";

import { readBoundedResponseText } from "./http";
import type { OAuthCredentialStore } from "./credentialStore";
import {
  discoverOAuth2Server,
  startOAuth2Authorization,
  type OAuth2AuthorizationAttempt,
  type OAuth2AuthorizationFailureReason,
  type OAuth2AuthorizationServerMetadata,
} from "./oauth2";
import { OAuth2Session, OAuth2SessionExpiredError } from "./session";

export const BAND_HUMAN_PLATFORM_ORIGIN = "https://app.band.ai";
export const BAND_HUMAN_OAUTH_ISSUER = "https://auth.band.ai";
export const BAND_HUMAN_OAUTH_CALLBACK_PATH = "/callback";
export const BAND_HUMAN_OAUTH_CLIENT_ID = "8b331314-a09c-485e-99dd-f4d26c7b39c7";
export const BAND_HUMAN_OAUTH_SCOPES = ["openid", "email", "profile", "offline_access"] as const;

const legacyBandDiscoveryIssuer = "thenvoi-prod.fusionauth.io";
const CUSTOM_DISCOVERY_PATH = "/api/v1/auth/discovery";
const HUMAN_PROFILE_PATH = "/api/v1/me/profile";
const HUMAN_AGENTS_PATH = "/api/v1/me/agents";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_CURSOR_PAGES = 100;
const UUID_SCHEMA = z.uuid().transform((value) => value.toLowerCase());

const CustomDiscoverySchema = z.object({
  data: z.object({
    oidc_url: z.url(),
    apps: z.object({
      jam: z.object({ client_id: z.string().min(1).max(256).regex(/^\S+$/) }),
    }),
  }),
});

const HumanProfileSchema = z.object({
  id: z.union([z.string().min(1).max(256), z.number().int().nonnegative()]),
  handle: z.string().min(1).max(30).optional(),
});

const HumanAgentSchema = z.object({
  id: UUID_SCHEMA,
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(100).nullable().optional(),
  is_external: z.literal(true),
});

const HumanAgentPageSchema = z.object({
  data: z.array(HumanAgentSchema),
  metadata: z.object({
    has_more: z.boolean(),
    next_cursor: z.string().nullable(),
    limit: z.number().int().min(1).max(100),
  }),
});

const AgentCredentialSchema = z.object({
  data: z.object({
    agent: z.object({ id: UUID_SCHEMA }),
    credentials: z.object({
      api_key: z.string().min(1).max(16_384).refine((value) => !/[\r\n\0]/.test(value)),
    }),
  }),
});

export interface BandHumanIdentity {
  id: string;
  handle?: string;
}

export interface BandOwnedAgent {
  id: string;
  name: string;
  slug: string | null;
}

export interface BandAgentCredential {
  agentId: string;
  apiKey: string;
}

export interface BandHumanAuthOptions {
  store: OAuthCredentialStore;
  platformUrl?: string;
  storeKey?: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

export interface BandHumanOAuthResolution {
  platformOrigin: string;
  oidcOrigin: string;
  clientId: string;
  metadata: OAuth2AuthorizationServerMetadata;
  compatibleCallbackIssuer?: string;
  idTokenIssuer?: string;
}

export type BandHumanSignInResult =
  | Readonly<{ ok: true; identity: BandHumanIdentity }>
  | Readonly<{
      ok: false;
      reason: OAuth2AuthorizationFailureReason | "profile_fetch_failed";
    }>;

export interface BandHumanSignInAttempt {
  authorizationUrl: URL;
  redirectUri: string;
  result: Promise<BandHumanSignInResult>;
  cancel(): void;
}

export class BandHumanApiError extends Error {
  public constructor(
    public readonly reason: "unauthorized" | "forbidden" | "not_found" | "conflict" | "unavailable" | "malformed",
    message: string,
  ) {
    super(message);
    this.name = "BandHumanApiError";
  }
}

export class BandHumanAuth {
  private readonly session: OAuth2Session;
  private identityValue: BandHumanIdentity | null = null;
  private readonly clientValue: BandHumanClient;
  private resolutionValue: BandHumanOAuthResolution | null = null;
  private activeSignIn: OAuth2AuthorizationAttempt | null = null;
  private beginSignInOperation: Promise<BandHumanSignInAttempt> | null = null;
  private signInGeneration = 0;

  public constructor(
    public readonly platformOrigin: string,
    private readonly options: BandHumanAuthOptions,
  ) {
    this.session = new OAuth2Session({
      store: options.store,
      storeKey: options.storeKey ?? bandHumanCredentialKey(platformOrigin),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    this.clientValue = new BandHumanClient({
      platformOrigin,
      getAccessToken: () => this.session.getAccessToken(),
      invalidateAccessToken: () => this.session.invalidateAccessToken(),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  }

  public get identity(): BandHumanIdentity | null {
    return this.identityValue;
  }

  public get client(): BandHumanClient {
    return this.clientValue;
  }

  public get resolution(): BandHumanOAuthResolution {
    if (this.resolutionValue === null) {
      throw new OAuth2SessionExpiredError("Band OAuth configuration has not been resolved");
    }
    return this.resolutionValue;
  }

  public async restore(): Promise<BandHumanIdentity | null> {
    this.identityValue = null;
    this.resolutionValue = null;
    const record = await this.session.restore();
    if (record === null) return null;
    const oidcOrigin = new URL(record.metadata.authorizationEndpoint).origin;
    const endpointsMatch =
      new URL(record.metadata.tokenEndpoint).origin === oidcOrigin &&
      record.metadata.jwksUri !== undefined &&
      new URL(record.metadata.jwksUri).origin === oidcOrigin;
    const canonicalConfiguration =
      this.platformOrigin !== BAND_HUMAN_PLATFORM_ORIGIN ||
      (record.clientId === BAND_HUMAN_OAUTH_CLIENT_ID &&
        oidcOrigin === BAND_HUMAN_OAUTH_ISSUER);
    if (!endpointsMatch || !canonicalConfiguration) {
      await this.session.clear();
      return null;
    }
    const legacyPair =
      this.platformOrigin === BAND_HUMAN_PLATFORM_ORIGIN &&
      record.metadata.issuer === legacyBandDiscoveryIssuer;
    this.resolutionValue = {
      platformOrigin: this.platformOrigin,
      oidcOrigin,
      clientId: record.clientId,
      metadata: record.metadata,
      ...(record.tokenIssuer !== undefined || legacyPair
        ? {
            idTokenIssuer: record.tokenIssuer ?? BAND_HUMAN_OAUTH_ISSUER,
            ...(legacyPair ? { compatibleCallbackIssuer: BAND_HUMAN_OAUTH_ISSUER } : {}),
          }
        : {}),
    };
    try {
      this.identityValue = await this.clientValue.getProfile();
      return this.identityValue;
    } catch (error) {
      if (error instanceof OAuth2SessionExpiredError) {
        this.identityValue = null;
        this.resolutionValue = null;
        return null;
      }
      throw error;
    }
  }

  public async beginSignIn(signal?: AbortSignal): Promise<BandHumanSignInAttempt> {
    if (this.beginSignInOperation !== null) return await this.beginSignInOperation;
    const operation = this.startSignIn(signal);
    this.beginSignInOperation = operation;
    try {
      return await operation;
    } finally {
      if (this.beginSignInOperation === operation) this.beginSignInOperation = null;
    }
  }

  private async startSignIn(signal?: AbortSignal): Promise<BandHumanSignInAttempt> {
    this.activeSignIn?.cancel();
    const generation = ++this.signInGeneration;
    const requestSignal = signal ?? this.options.signal;
    const resolution = await resolveBandHumanOAuth({
      platformUrl: this.platformOrigin,
      fetch: this.options.fetch,
      signal: requestSignal,
    });
    if (generation !== this.signInGeneration) {
      throw new OAuth2SessionExpiredError("Band sign-in was superseded");
    }
    this.resolutionValue = resolution;
    const attempt = await startOAuth2Authorization({
      metadata: resolution.metadata,
      clientId: resolution.clientId,
      scopes: BAND_HUMAN_OAUTH_SCOPES,
      callbackPath: BAND_HUMAN_OAUTH_CALLBACK_PATH,
      requireIdToken: true,
      requireRefreshToken: true,
      ...(resolution.compatibleCallbackIssuer === undefined
        ? {}
        : { compatibleCallbackIssuer: resolution.compatibleCallbackIssuer }),
      ...(resolution.idTokenIssuer === undefined
        ? {}
        : { idTokenIssuer: resolution.idTokenIssuer }),
      ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
      ...(requestSignal === undefined ? {} : { signal: requestSignal }),
    });
    if (generation !== this.signInGeneration) {
      attempt.cancel();
      throw new OAuth2SessionExpiredError("Band sign-in was superseded");
    }
    this.activeSignIn = attempt;
    const result = this.completeSignIn(attempt, resolution);
    const clearAttempt = (): void => {
      if (this.activeSignIn === attempt) this.activeSignIn = null;
    };
    void result.then(clearAttempt, clearAttempt);
    return {
      authorizationUrl: attempt.authorizationUrl,
      redirectUri: attempt.redirectUri,
      result,
      cancel: () => attempt.cancel(),
    };
  }

  public async signOut(): Promise<void> {
    this.activeSignIn?.cancel();
    this.signInGeneration += 1;
    this.activeSignIn = null;
    this.identityValue = null;
    this.resolutionValue = null;
    await this.session.clear();
  }

  private async completeSignIn(
    attempt: OAuth2AuthorizationAttempt,
    resolution: BandHumanOAuthResolution,
  ): Promise<BandHumanSignInResult> {
    const authorization = await attempt.result;
    if (!authorization.ok) return authorization;
    let identity: BandHumanIdentity;
    try {
      identity = await fetchBandProfile(
        this.platformOrigin,
        authorization.accessToken,
        this.options.fetch,
      );
    } catch {
      return { ok: false, reason: "profile_fetch_failed" };
    }
    if (this.activeSignIn !== attempt) return { ok: false, reason: "cancelled" };
    await this.session.install({
      metadata: resolution.metadata,
      clientId: resolution.clientId,
      ...(resolution.idTokenIssuer === undefined
        ? {}
        : { tokenIssuer: resolution.idTokenIssuer }),
      scopes: BAND_HUMAN_OAUTH_SCOPES,
      authorization,
    });
    if (this.activeSignIn !== attempt) {
      await this.session.clear();
      return { ok: false, reason: "cancelled" };
    }
    this.identityValue = identity;
    return { ok: true, identity };
  }
}

export async function createBandHumanAuth(
  options: BandHumanAuthOptions,
): Promise<BandHumanAuth> {
  const platformOrigin = normalizePlatformOrigin(
    options.platformUrl ?? BAND_HUMAN_PLATFORM_ORIGIN,
  );
  return new BandHumanAuth(platformOrigin, options);
}

export async function resolveBandHumanOAuth(input: {
  platformUrl?: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
} = {}): Promise<BandHumanOAuthResolution> {
  const platformOrigin = normalizePlatformOrigin(input.platformUrl ?? BAND_HUMAN_PLATFORM_ORIGIN);
  let oidcOrigin: string;
  let clientId: string;
  let acceptedIssuerValues: readonly string[] | undefined;
  if (platformOrigin === BAND_HUMAN_PLATFORM_ORIGIN) {
    oidcOrigin = BAND_HUMAN_OAUTH_ISSUER;
    clientId = BAND_HUMAN_OAUTH_CLIENT_ID;
    acceptedIssuerValues = [legacyBandDiscoveryIssuer];
  } else {
    const document = await boundedJsonRequest(
      `${platformOrigin}${CUSTOM_DISCOVERY_PATH}`,
      { method: "GET", signal: input.signal },
      input.fetch,
    );
    const parsed = CustomDiscoverySchema.parse(document);
    oidcOrigin = normalizePlatformOrigin(parsed.data.oidc_url);
    clientId = parsed.data.apps.jam.client_id;
  }
  const metadata = await discoverOAuth2Server({
    issuer: oidcOrigin,
    allowedEndpointOrigins: [oidcOrigin],
    ...(acceptedIssuerValues === undefined ? {} : { acceptedIssuerValues }),
    requirePkce: true,
    requireRefreshTokenGrant: true,
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (metadata.jwksUri === undefined) {
    throw new BandHumanApiError("malformed", "Band identity provider did not publish a JWKS endpoint");
  }
  const legacyPair =
    platformOrigin === BAND_HUMAN_PLATFORM_ORIGIN &&
    oidcOrigin === BAND_HUMAN_OAUTH_ISSUER &&
    metadata.issuer === legacyBandDiscoveryIssuer;
  return {
    platformOrigin,
    oidcOrigin,
    clientId,
    metadata,
    ...(legacyPair
      ? {
          compatibleCallbackIssuer: BAND_HUMAN_OAUTH_ISSUER,
          idTokenIssuer: BAND_HUMAN_OAUTH_ISSUER,
        }
      : {}),
  };
}

export function bandHumanCredentialKey(platformOrigin: string): string {
  const digest = createHash("sha256").update(normalizePlatformOrigin(platformOrigin)).digest("hex");
  return `human-${digest}`;
}

export class BandHumanClient {
  private readonly send: typeof fetch;

  public constructor(
    private readonly options: {
      platformOrigin: string;
      getAccessToken(): Promise<string>;
      invalidateAccessToken(): void;
      fetch?: typeof fetch;
    },
  ) {
    this.send = options.fetch ?? fetch;
  }

  public async getProfile(signal?: AbortSignal): Promise<BandHumanIdentity> {
    const value = await this.request(HUMAN_PROFILE_PATH, { method: "GET", signal });
    return parseProfile(value);
  }

  public async listAgents(signal?: AbortSignal): Promise<BandOwnedAgent[]> {
    const agents: BandOwnedAgent[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < MAX_CURSOR_PAGES; page += 1) {
      const url = new URL(HUMAN_AGENTS_PATH, this.options.platformOrigin);
      url.searchParams.set("is_external", "true");
      url.searchParams.set("limit", "100");
      if (cursor !== null) url.searchParams.set("cursor", cursor);
      const parsed = HumanAgentPageSchema.parse(
        await this.request(`${url.pathname}${url.search}`, { method: "GET", signal }),
      );
      for (const agent of parsed.data) {
        if (seen.has(agent.id)) throw new BandHumanApiError("malformed", "Duplicate agent in paginated response");
        seen.add(agent.id);
        agents.push({ id: agent.id, name: agent.name, slug: agent.slug ?? null });
      }
      if (!parsed.metadata.has_more) return agents;
      if (parsed.metadata.next_cursor === null || parsed.metadata.next_cursor.length === 0) {
        throw new BandHumanApiError("malformed", "Agent pagination cursor is missing");
      }
      cursor = parsed.metadata.next_cursor;
    }
    throw new BandHumanApiError("malformed", "Agent pagination exceeded its page limit");
  }

  public async registerAgent(
    input: { name: string; description: string },
    signal?: AbortSignal,
  ): Promise<BandAgentCredential> {
    if (
      input.name.trim().length === 0 ||
      input.name.length > 100 ||
      input.description.trim().length === 0 ||
      input.description.length > 10_000
    ) {
      throw new BandHumanApiError("malformed", "Agent name or description is invalid");
    }
    const value = await this.request(`${HUMAN_AGENTS_PATH}/register`, {
      method: "POST",
      signal,
      body: JSON.stringify({ agent: input }),
    });
    return parseAgentCredential(value);
  }

  public async regenerateAgentApiKey(
    agentId: string,
    signal?: AbortSignal,
  ): Promise<BandAgentCredential> {
    const id = UUID_SCHEMA.parse(agentId);
    const value = await this.request(`${HUMAN_AGENTS_PATH}/${id}/api-key/regenerate`, {
      method: "POST",
      signal,
    });
    return parseAgentCredential(value);
  }

  private async request(
    path: string,
    init: { method: "GET" | "POST"; signal?: AbortSignal; body?: string },
  ): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const accessToken = await this.options.getAccessToken();
      const response = await this.send(new URL(path, this.options.platformOrigin), {
        method: init.method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${accessToken}`,
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: init.body }),
        ...(init.signal === undefined ? {} : { signal: init.signal }),
        redirect: "error",
      });
      if (response.status === 401 && attempt === 0) {
        await response.body?.cancel();
        this.options.invalidateAccessToken();
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new BandHumanApiError(statusReason(response.status), `Band human API returned HTTP ${response.status}`);
      }
      return readBoundedJson(response);
    }
    throw new BandHumanApiError("unauthorized", "Band human session was rejected");
  }
}

async function fetchBandProfile(
  platformOrigin: string,
  accessToken: string,
  send: typeof fetch = fetch,
): Promise<BandHumanIdentity> {
  const response = await send(new URL(HUMAN_PROFILE_PATH, platformOrigin), {
    method: "GET",
    headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
    redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new BandHumanApiError(statusReason(response.status), `Band profile returned HTTP ${response.status}`);
  }
  return parseProfile(await readBoundedJson(response));
}

function parseProfile(value: unknown): BandHumanIdentity {
  const envelope = z.object({ data: HumanProfileSchema }).safeParse(value);
  const direct = HumanProfileSchema.safeParse(value);
  const parsed = envelope.success ? envelope.data.data : direct.success ? direct.data : null;
  if (parsed === null) throw new BandHumanApiError("malformed", "Band profile response is malformed");
  return {
    id: String(parsed.id),
    ...(parsed.handle === undefined ? {} : { handle: parsed.handle }),
  };
}

function parseAgentCredential(value: unknown): BandAgentCredential {
  const parsed = AgentCredentialSchema.safeParse(value);
  if (!parsed.success) {
    throw new BandHumanApiError("malformed", "Band agent credential response is malformed");
  }
  return {
    agentId: parsed.data.data.agent.id,
    apiKey: parsed.data.data.credentials.api_key,
  };
}

async function boundedJsonRequest(
  url: string,
  init: RequestInit,
  send: typeof fetch = fetch,
): Promise<unknown> {
  const response = await send(url, { ...init, headers: { accept: "application/json" }, redirect: "error" });
  if (!response.ok) {
    await response.body?.cancel();
    throw new BandHumanApiError(statusReason(response.status), `Band discovery returned HTTP ${response.status}`);
  }
  return readBoundedJson(response);
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const body = await readBoundedResponseText(
    response,
    MAX_RESPONSE_BYTES,
    () => new BandHumanApiError("malformed", "Band response is too large"),
  );
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new BandHumanApiError("malformed", "Band response is not valid JSON");
  }
}

function normalizePlatformOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BandHumanApiError("malformed", "Band platform URL is invalid");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (
    (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new BandHumanApiError("malformed", "Band platform URL must be a bare HTTPS origin");
  }
  return url.origin;
}

function statusReason(status: number): BandHumanApiError["reason"] {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  return status >= 500 || status === 429 ? "unavailable" : "malformed";
}
