// @effect-diagnostics preferSchemaOverJson:off
import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "@effect/vitest";

import {
  createYouTubeAuthorizationRequest,
  emailFromIdToken,
  exchangeYouTubeAuthorizationCode,
  grantsYouTubeUpload,
  refreshYouTubeAccessToken,
  resolveYouTubeOAuthClient,
  YOUTUBE_UPLOAD_SCOPE,
  YouTubeOAuthError,
  type FetchLike,
} from "./YouTubeOAuth.ts";

const CLIENT = { clientId: "yt-client.apps.googleusercontent.com", clientSecret: "yt-secret" };

const tokenEndpoint = (status: number, body: unknown) => {
  const calls: Array<{ url: string; form: URLSearchParams; method: string | undefined }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    calls.push({
      url: String(input),
      form: new URLSearchParams(String(init?.body ?? "")),
      method: init?.method,
    });
    return new Response(JSON.stringify(body), { status });
  };
  return { calls, fetchImpl };
};

const fakeIdToken = (claims: Record<string, unknown>) =>
  ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");

describe("YouTubeOAuth", () => {
  it("builds an offline, consent-forcing PKCE authorization URL on the loopback redirect", () => {
    const request = createYouTubeAuthorizationRequest(CLIENT);
    const url = new URL(request.authUrl);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: CLIENT.clientId,
      redirect_uri: "http://127.0.0.1/oauth2/callback",
      response_type: "code",
      access_type: "offline",
      prompt: "consent",
      state: request.state,
      code_challenge_method: "S256",
    });
    expect(url.searchParams.get("scope")?.split(" ")).toContain(YOUTUBE_UPLOAD_SCOPE);
    expect(url.searchParams.get("code_challenge")).toBe(
      NodeCrypto.createHash("sha256").update(request.codeVerifier).digest("base64url"),
    );
    expect(request.authUrl).not.toContain(CLIENT.clientSecret);
    expect(createYouTubeAuthorizationRequest(CLIENT).state).not.toBe(request.state);
  });

  it("exchanges the authorization code with the PKCE verifier", async () => {
    const { calls, fetchImpl } = tokenEndpoint(200, {
      access_token: "ya29.access",
      expires_in: 3599,
      refresh_token: "1//refresh",
      scope: `openid ${YOUTUBE_UPLOAD_SCOPE} https://www.googleapis.com/auth/userinfo.email`,
      id_token: fakeIdToken({ email: "andrew@example.com" }),
      token_type: "Bearer",
    });
    const grant = await exchangeYouTubeAuthorizationCode({
      client: CLIENT,
      code: "4/code",
      codeVerifier: "verifier",
      redirectUri: "http://127.0.0.1/oauth2/callback",
      fetchImpl,
    });
    expect(grant).toMatchObject({
      accessToken: "ya29.access",
      expiresInSeconds: 3599,
      refreshToken: "1//refresh",
    });
    expect(grantsYouTubeUpload(grant.scope)).toBe(true);
    expect(emailFromIdToken(grant.idToken)).toBe("andrew@example.com");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://oauth2.googleapis.com/token");
    expect(calls[0]?.method).toBe("POST");
    expect(Object.fromEntries(calls[0]?.form ?? [])).toEqual({
      grant_type: "authorization_code",
      code: "4/code",
      code_verifier: "verifier",
      redirect_uri: "http://127.0.0.1/oauth2/callback",
      client_id: CLIENT.clientId,
      client_secret: CLIENT.clientSecret,
    });
  });

  it("refreshes an access token from the stored refresh token", async () => {
    const { calls, fetchImpl } = tokenEndpoint(200, {
      access_token: "ya29.fresh",
      expires_in: 3600,
      scope: YOUTUBE_UPLOAD_SCOPE,
    });
    const grant = await refreshYouTubeAccessToken({
      client: CLIENT,
      refreshToken: "1//refresh",
      fetchImpl,
    });
    expect(grant.accessToken).toBe("ya29.fresh");
    expect(grant.refreshToken).toBeUndefined();
    expect(Object.fromEntries(calls[0]?.form ?? [])).toEqual({
      grant_type: "refresh_token",
      refresh_token: "1//refresh",
      client_id: CLIENT.clientId,
      client_secret: CLIENT.clientSecret,
    });
  });

  it("maps invalid_grant to a reconnect message without leaking the token", async () => {
    const { fetchImpl } = tokenEndpoint(400, {
      error: "invalid_grant",
      error_description: "Token has been expired or revoked.",
    });
    const error = await refreshYouTubeAccessToken({
      client: CLIENT,
      refreshToken: "1//secret-refresh",
      fetchImpl,
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(YouTubeOAuthError);
    expect((error as YouTubeOAuthError).code).toBe("invalid_grant");
    expect((error as YouTubeOAuthError).message).toContain("Connect YouTube again");
    expect((error as YouTubeOAuthError).message).not.toContain("secret-refresh");
  });

  it("rejects a token response without an access token", async () => {
    const { fetchImpl } = tokenEndpoint(200, { token_type: "Bearer" });
    await expect(
      refreshYouTubeAccessToken({ client: CLIENT, refreshToken: "r", fetchImpl }),
    ).rejects.toThrow("unexpected response");
  });

  it("resolves the OAuth client from env first, else from the downloaded client JSON", () => {
    expect(
      resolveYouTubeOAuthClient({
        env: {
          COMMAND_CENTER_YOUTUBE_OAUTH_CLIENT_ID: " env-id ",
          COMMAND_CENTER_YOUTUBE_OAUTH_CLIENT_SECRET: "env-secret",
        },
        clientJson: JSON.stringify({ installed: { client_id: "json-id", client_secret: "s" } }),
      }),
    ).toEqual({ clientId: "env-id", clientSecret: "env-secret" });
    expect(
      resolveYouTubeOAuthClient({
        env: { COMMAND_CENTER_YOUTUBE_OAUTH_CLIENT_ID: "only-id" },
        clientJson: JSON.stringify({
          installed: { client_id: "json-id", client_secret: "json-secret" },
        }),
      }),
    ).toEqual({ clientId: "json-id", clientSecret: "json-secret" });
    expect(resolveYouTubeOAuthClient({ env: {}, clientJson: "not json" })).toBeUndefined();
    expect(resolveYouTubeOAuthClient({ env: {}, clientJson: undefined })).toBeUndefined();
  });
});
