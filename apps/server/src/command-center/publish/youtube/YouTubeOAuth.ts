// @effect-diagnostics globalFetch:off preferSchemaOverJson:off
/**
 * Dependency-free Google OAuth for the YouTube publishing connection.
 *
 * gog (used by GoogleConnectionSetup) only carries Gmail/Calendar/Drive scopes, so YouTube runs its
 * own installed-app ("Desktop") OAuth flow in process with the same paste-the-127.0.0.1-address UX:
 * the user opens the authorization URL, approves, and pastes the address the browser lands on.
 * PKCE (S256) + `state` guard the exchange; `access_type=offline` + `prompt=consent` force a
 * refresh token.
 *
 * Endpoints (https://developers.google.com/identity/protocols/oauth2/native-app):
 *   authorize  https://accounts.google.com/o/oauth2/v2/auth
 *   token      https://oauth2.googleapis.com/token  (authorization_code | refresh_token)
 *   revoke     https://oauth2.googleapis.com/revoke
 *
 * SECURITY: tokens and the client secret are never included in an error message.
 */
import * as NodeCrypto from "node:crypto";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export const YOUTUBE_UPLOAD_SCOPE = "https://www.googleapis.com/auth/youtube.upload";
export const YOUTUBE_ANALYTICS_SCOPE = "https://www.googleapis.com/auth/yt-analytics.readonly";
export const YOUTUBE_READ_SCOPE = "https://www.googleapis.com/auth/youtube.readonly";
/** `openid email` lets the connection show which Google account authorized it. */
const YOUTUBE_OAUTH_SCOPES = [
  YOUTUBE_UPLOAD_SCOPE,
  YOUTUBE_ANALYTICS_SCOPE,
  YOUTUBE_READ_SCOPE,
  "openid",
  "email",
] as const;
const YOUTUBE_OAUTH_REDIRECT_URI = "http://127.0.0.1/oauth2/callback";

const GOOGLE_AUTHORIZE_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

/** Env vars carrying the dedicated YouTube Desktop OAuth client. */
export const YOUTUBE_OAUTH_CLIENT_ID_ENV = "COMMAND_CENTER_YOUTUBE_OAUTH_CLIENT_ID";
export const YOUTUBE_OAUTH_CLIENT_SECRET_ENV = "COMMAND_CENTER_YOUTUBE_OAUTH_CLIENT_SECRET";
/**
 * Alternative to the env vars: the client JSON exactly as downloaded from Google Cloud Console
 * (`{"installed":{"client_id":...,"client_secret":...}}`), stored as this ServerSecretStore secret
 * (file `<secretsDir>/command-center-youtube-oauth-client.bin`).
 */
export const YOUTUBE_OAUTH_CLIENT_SECRET_NAME = "command-center-youtube-oauth-client";

export interface YouTubeOAuthClient {
  readonly clientId: string;
  readonly clientSecret: string;
}

export class YouTubeOAuthError extends Error {
  /** Google's `error` code (e.g. `invalid_grant`), when it returned one. */
  readonly code: string | undefined;
  readonly status: number | undefined;
  constructor(message: string, options: { code?: string; status?: number } = {}) {
    super(message);
    this.name = "YouTubeOAuthError";
    this.code = options.code;
    this.status = options.status;
  }
}

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/** Resolve the OAuth client from env, else from a Google-downloaded client JSON. */
export function resolveYouTubeOAuthClient(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly clientJson: string | undefined;
}): YouTubeOAuthClient | undefined {
  const envId = input.env[YOUTUBE_OAUTH_CLIENT_ID_ENV]?.trim();
  const envSecret = input.env[YOUTUBE_OAUTH_CLIENT_SECRET_ENV]?.trim();
  if (nonEmpty(envId) && nonEmpty(envSecret)) return { clientId: envId, clientSecret: envSecret };
  if (input.clientJson === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(input.clientJson);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    const inner = (record.installed ?? record.web ?? record) as Record<string, unknown>;
    return nonEmpty(inner.client_id) && nonEmpty(inner.client_secret)
      ? { clientId: inner.client_id.trim(), clientSecret: inner.client_secret.trim() }
      : undefined;
  } catch {
    return undefined;
  }
}

const base64Url = (bytes: Buffer) => bytes.toString("base64url");

export interface YouTubeAuthorizationRequest {
  readonly authUrl: string;
  readonly state: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
}

/** Build the consent URL plus the server-side state/PKCE verifier that `complete` must check. */
export function createYouTubeAuthorizationRequest(
  client: Pick<YouTubeOAuthClient, "clientId">,
  random: (size: number) => Buffer = NodeCrypto.randomBytes,
): YouTubeAuthorizationRequest {
  const state = base64Url(random(24));
  const codeVerifier = base64Url(random(48));
  const codeChallenge = base64Url(NodeCrypto.createHash("sha256").update(codeVerifier).digest());
  const url = new URL(GOOGLE_AUTHORIZE_ENDPOINT);
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", YOUTUBE_OAUTH_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", YOUTUBE_OAUTH_SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return { authUrl: url.toString(), state, codeVerifier, redirectUri: YOUTUBE_OAUTH_REDIRECT_URI };
}

export interface YouTubeTokenGrant {
  readonly accessToken: string;
  readonly expiresInSeconds: number;
  readonly refreshToken: string | undefined;
  readonly scope: string | undefined;
  readonly idToken: string | undefined;
}

const TOKEN_FAILURE_MESSAGES: Record<string, string> = {
  invalid_grant:
    "Google rejected the authorization (it expired, was already used, or access was revoked). Connect YouTube again.",
  invalid_client:
    "Google rejected the YouTube OAuth client. Check the configured client id and secret.",
  unauthorized_client:
    "This OAuth client is not allowed to use this flow. Use a Desktop app client.",
};

async function postTokenForm(
  fetchImpl: FetchLike,
  params: Record<string, string>,
  endpoint: string,
): Promise<YouTubeTokenGrant> {
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
  } catch {
    throw new YouTubeOAuthError("Google's token endpoint could not be reached.");
  }
  const body: unknown = await response.json().catch(() => undefined);
  const record = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (!response.ok) {
    const code = typeof record.error === "string" ? record.error : undefined;
    throw new YouTubeOAuthError(
      (code && TOKEN_FAILURE_MESSAGES[code]) ??
        `Google's token endpoint returned HTTP ${response.status}${code ? ` (${code})` : ""}.`,
      { ...(code === undefined ? {} : { code }), status: response.status },
    );
  }
  const expiresIn = record.expires_in;
  if (!nonEmpty(record.access_token) || typeof expiresIn !== "number" || !(expiresIn > 0)) {
    throw new YouTubeOAuthError("Google's token endpoint returned an unexpected response.");
  }
  return {
    accessToken: record.access_token,
    expiresInSeconds: expiresIn,
    refreshToken: nonEmpty(record.refresh_token) ? record.refresh_token : undefined,
    scope: typeof record.scope === "string" ? record.scope : undefined,
    idToken: nonEmpty(record.id_token) ? record.id_token : undefined,
  };
}

/** Exchange the authorization code from the pasted callback address. */
export function exchangeYouTubeAuthorizationCode(input: {
  readonly client: YouTubeOAuthClient;
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly fetchImpl?: FetchLike;
  readonly tokenEndpoint?: string;
}): Promise<YouTubeTokenGrant> {
  return postTokenForm(
    input.fetchImpl ?? fetch,
    {
      grant_type: "authorization_code",
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
      client_id: input.client.clientId,
      client_secret: input.client.clientSecret,
    },
    input.tokenEndpoint ?? GOOGLE_TOKEN_ENDPOINT,
  );
}

/** Trade the stored refresh token for a fresh short-lived access token. */
export function refreshYouTubeAccessToken(input: {
  readonly client: YouTubeOAuthClient;
  readonly refreshToken: string;
  readonly fetchImpl?: FetchLike;
  readonly tokenEndpoint?: string;
}): Promise<YouTubeTokenGrant> {
  return postTokenForm(
    input.fetchImpl ?? fetch,
    {
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      client_id: input.client.clientId,
      client_secret: input.client.clientSecret,
    },
    input.tokenEndpoint ?? GOOGLE_TOKEN_ENDPOINT,
  );
}

/** Best-effort revoke on disconnect. Resolves false instead of throwing. */
export async function revokeYouTubeToken(input: {
  readonly token: string;
  readonly fetchImpl?: FetchLike;
  readonly revokeEndpoint?: string;
}): Promise<boolean> {
  try {
    const response = await (input.fetchImpl ?? fetch)(
      input.revokeEndpoint ?? GOOGLE_REVOKE_ENDPOINT,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: input.token }).toString(),
      },
    );
    return response.ok;
  } catch {
    return false;
  }
}

/** True when the space-delimited granted scope list includes youtube.upload. */
export function grantsYouTubeUpload(scope: string | undefined): boolean {
  return scope === undefined ? false : scope.split(/\s+/u).includes(YOUTUBE_UPLOAD_SCOPE);
}

export function grantsYouTubeAnalytics(scope: string | undefined): boolean {
  const granted = new Set(scope?.split(/\s+/u) ?? []);
  return granted.has(YOUTUBE_ANALYTICS_SCOPE) && granted.has(YOUTUBE_READ_SCOPE);
}

/**
 * Read the `email` claim from the id_token Google returned in the same TLS response as the
 * tokens. It is only used as a display label, so the signature is not verified.
 */
export function emailFromIdToken(idToken: string | undefined): string | undefined {
  const payload = idToken?.split(".")[1];
  if (payload === undefined) return undefined;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof claims !== "object" || claims === null) return undefined;
    const email = (claims as Record<string, unknown>).email;
    return nonEmpty(email) ? email.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Extract the authorization code from a pasted callback address already validated for state. */
export function authorizationCodeFromCallback(callbackAddress: string): string | undefined {
  try {
    return new URL(callbackAddress.trim()).searchParams.get("code")?.trim() || undefined;
  } catch {
    return undefined;
  }
}
