import { refreshTokenGrant, ResponseBodyError } from "openid-client";
import { z } from "zod";

import type { OAuthCredentialStore } from "./credentialStore";
import {
  createOAuth2Configuration,
  type OAuth2AuthorizationResult,
  type OAuth2AuthorizationServerMetadata,
  type OAuth2ClientAuthentication,
} from "./oauth2";

const REFRESH_AHEAD_MS = 60_000;
const MAX_TOKEN_LIFETIME_SECONDS = 24 * 60 * 60;

const OAuth2ServerMetadataSchema = z.object({
  issuer: z.string().min(1).max(4_096),
  authorizationEndpoint: z.url(),
  tokenEndpoint: z.url(),
  jwksUri: z.url().optional(),
  responseTypesSupported: z.array(z.string().min(1)).optional(),
  grantTypesSupported: z.array(z.string().min(1)).optional(),
  codeChallengeMethodsSupported: z.array(z.string().min(1)).optional(),
}).strict();

const OAuth2SessionRecordSchema = z.object({
  version: z.literal(1),
  metadata: OAuth2ServerMetadataSchema,
  clientId: z.string().min(1).max(512),
  tokenIssuer: z.string().min(1).max(4_096).optional(),
  scopes: z.array(z.string().min(1).max(2_048)).min(1),
  refreshToken: z.string().min(1).max(64 * 1024),
  subject: z.string().min(1).max(4_096).optional(),
}).strict();

export type OAuth2SessionRecord = z.infer<typeof OAuth2SessionRecordSchema>;

export interface OAuth2SessionOptions {
  store: OAuthCredentialStore;
  storeKey: string;
  clientAuthentication?: OAuth2ClientAuthentication;
  fetch?: typeof fetch;
  refreshAheadMs?: number;
  maxTokenLifetimeSeconds?: number;
}

export class OAuth2SessionExpiredError extends Error {
  public constructor(message = "The OAuth session is no longer authorized") {
    super(message);
    this.name = "OAuth2SessionExpiredError";
  }
}

export class OAuth2Session {
  private record: OAuth2SessionRecord | null = null;
  private access: { token: string; expiresAt: number } | null = null;
  private refreshOperation: Promise<string> | null = null;
  private mutationTail: Promise<void> = Promise.resolve();

  public constructor(private readonly options: OAuth2SessionOptions) {}

  public get snapshot(): OAuth2SessionRecord | null {
    return this.record;
  }

  public async restore(): Promise<OAuth2SessionRecord | null> {
    return await this.mutate(async () => {
      const stored = await this.options.store.get(this.options.storeKey);
      if (stored === undefined) {
        this.record = null;
        this.access = null;
        return null;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(stored) as unknown;
      } catch {
        await this.options.store.delete(this.options.storeKey);
        this.record = null;
        this.access = null;
        return null;
      }
      const result = OAuth2SessionRecordSchema.safeParse(parsed);
      if (!result.success) {
        await this.options.store.delete(this.options.storeKey);
        this.record = null;
        this.access = null;
        return null;
      }
      this.record = result.data;
      this.access = null;
      return this.record;
    });
  }

  public async install(input: {
    metadata: OAuth2AuthorizationServerMetadata;
    clientId: string;
    tokenIssuer?: string;
    scopes: readonly string[];
    authorization: Extract<OAuth2AuthorizationResult, { ok: true }>;
  }): Promise<OAuth2SessionRecord> {
    if (input.authorization.refreshToken === undefined) {
      throw new OAuth2SessionExpiredError("The authorization server did not issue a refresh token");
    }
    const parsed = OAuth2SessionRecordSchema.parse({
      version: 1,
      metadata: input.metadata,
      clientId: input.clientId,
      ...(input.tokenIssuer === undefined ? {} : { tokenIssuer: input.tokenIssuer }),
      scopes: [...input.scopes],
      refreshToken: input.authorization.refreshToken,
      ...(input.authorization.subject === undefined ? {} : { subject: input.authorization.subject }),
    });
    return await this.mutate(async () => {
      await this.options.store.set(this.options.storeKey, JSON.stringify(parsed));
      this.record = parsed;
      this.access = {
        token: input.authorization.accessToken,
        expiresAt: input.authorization.expiresAt,
      };
      return parsed;
    });
  }

  public async getAccessToken(): Promise<string> {
    const refreshAheadMs = this.options.refreshAheadMs ?? REFRESH_AHEAD_MS;
    if (this.access !== null && this.access.expiresAt - Date.now() > refreshAheadMs) {
      return this.access.token;
    }
    if (this.record === null) {
      await this.restore();
    }
    if (this.record === null) {
      throw new OAuth2SessionExpiredError("No OAuth session is installed");
    }
    if (this.refreshOperation === null) {
      const operation = this.refresh();
      this.refreshOperation = operation;
      void operation.then(
        () => {
          if (this.refreshOperation === operation) this.refreshOperation = null;
        },
        () => {
          if (this.refreshOperation === operation) this.refreshOperation = null;
        },
      );
    }
    return this.refreshOperation;
  }

  public invalidateAccessToken(): void {
    this.access = null;
  }

  public async clear(): Promise<void> {
    await this.mutate(async () => {
      this.record = null;
      this.access = null;
      await this.options.store.delete(this.options.storeKey);
    });
  }

  private async refresh(): Promise<string> {
    const current = this.record;
    if (current === null) throw new OAuth2SessionExpiredError("No OAuth session is installed");
    const config = createOAuth2Configuration({
      metadata: {
        ...current.metadata,
        issuer: current.tokenIssuer ?? current.metadata.issuer,
      },
      clientId: current.clientId,
      ...(this.options.clientAuthentication === undefined
        ? {}
        : { clientAuthentication: this.options.clientAuthentication }),
      ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
    });

    let tokens;
    try {
      tokens = await refreshTokenGrant(config, current.refreshToken);
    } catch (error) {
      if (error instanceof ResponseBodyError && error.error === "invalid_grant") {
        await this.clear();
        throw new OAuth2SessionExpiredError();
      }
      throw error;
    }
    if (
      typeof tokens.access_token !== "string" ||
      tokens.access_token.length === 0 ||
      tokens.token_type?.toLowerCase() !== "bearer"
    ) {
      await this.clear();
      throw new OAuth2SessionExpiredError("The refreshed OAuth session is unusable");
    }
    const lifetime = tokens.expires_in;
    const maximum = this.options.maxTokenLifetimeSeconds ?? MAX_TOKEN_LIFETIME_SECONDS;
    if (
      typeof lifetime !== "number" ||
      !Number.isFinite(lifetime) ||
      lifetime <= 0 ||
      lifetime > maximum
    ) {
      await this.clear();
      throw new OAuth2SessionExpiredError("The refreshed OAuth token lifetime is invalid");
    }
    const claims = tokens.claims();
    if (
      current.subject !== undefined &&
      claims !== undefined &&
      typeof claims.sub === "string" &&
      claims.sub !== current.subject
    ) {
      await this.clear();
      throw new OAuth2SessionExpiredError("The refreshed OAuth subject changed");
    }
    const next: OAuth2SessionRecord = {
      ...current,
      refreshToken:
        typeof tokens.refresh_token === "string" && tokens.refresh_token.length > 0
          ? tokens.refresh_token
          : current.refreshToken,
    };
    return await this.mutate(async () => {
      if (this.record !== current) {
        throw new OAuth2SessionExpiredError("The OAuth session changed while it was refreshing");
      }
      if (next.refreshToken !== current.refreshToken) {
        await this.options.store.set(this.options.storeKey, JSON.stringify(next));
      }
      this.record = next;
      this.access = {
        token: tokens.access_token,
        expiresAt: Date.now() + Math.floor(lifetime * 1_000),
      };
      return this.access.token;
    });
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }
}
