export {
  createSystemCredentialStore,
  MemoryOAuthCredentialStore,
  OAuthCredentialStoreUnavailableError,
} from "./credentialStore";
export type {
  OAuthCredentialStore,
  SystemCredentialStoreOptions,
} from "./credentialStore";

export {
  createOAuth2Configuration,
  discoverOAuth2Server,
  OAuth2ProtocolError,
  startOAuth2Authorization,
} from "./oauth2";
export type {
  DiscoverOAuth2ServerOptions,
  OAuth2AuthorizationAttempt,
  OAuth2AuthorizationFailureReason,
  OAuth2AuthorizationResult,
  OAuth2AuthorizationServerMetadata,
  OAuth2ClientAuthentication,
  StartOAuth2AuthorizationOptions,
} from "./oauth2";

export {
  OAuth2Session,
  OAuth2SessionExpiredError,
} from "./session";
export type {
  OAuth2SessionOptions,
  OAuth2SessionRecord,
} from "./session";

export {
  BAND_HUMAN_OAUTH_CLIENT_ID,
  BAND_HUMAN_OAUTH_CALLBACK_PATH,
  BAND_HUMAN_OAUTH_ISSUER,
  BAND_HUMAN_OAUTH_SCOPES,
  BAND_HUMAN_PLATFORM_ORIGIN,
  BandHumanApiError,
  BandHumanAuth,
  BandHumanClient,
  bandHumanCredentialKey,
  createBandHumanAuth,
  resolveBandHumanOAuth,
} from "./band";
export type {
  BandAgentCredential,
  BandHumanAuthOptions,
  BandHumanIdentity,
  BandHumanOAuthResolution,
  BandHumanSignInAttempt,
  BandHumanSignInResult,
  BandOwnedAgent,
} from "./band";
