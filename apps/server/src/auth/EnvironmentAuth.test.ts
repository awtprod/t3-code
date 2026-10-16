import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  authScopeResponse,
  AuthAdministrativeScopes,
  AuthStandardClientScopes,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PersistenceErrors from "../persistence/Errors.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PairingGrantStore from "./PairingGrantStore.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";

import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";

/** Pinned so dev-mode cookie tests can assert the port-scoped name. */
const TEST_SERVER_PORT = 13_773;
const isPairingCredentialIssueError = Schema.is(PairingGrantStore.PairingCredentialIssueError);
const isPersistenceSqlError = Schema.is(PersistenceErrors.PersistenceSqlError);

const layerServerConfig = (overrides?: Partial<ServerConfig.ServerConfig["Service"]>) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return {
        ...config,
        ...overrides,
        // Keep the test server deterministic even when the default test layer
        // changes its development port.
        port: TEST_SERVER_PORT,
      } satisfies ServerConfig.ServerConfig["Service"];
    }),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-server-test-" })));

const layerEnvironmentAuth = (overrides?: Partial<ServerConfig.ServerConfig["Service"]>) =>
  EnvironmentAuth.layer.pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(layerServerConfig(overrides)),
  );

const makeCookieRequest = (
  cookieName: string,
  sessionToken: string,
): Parameters<EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]>[0] =>
  ({
    cookies: {
      [cookieName]: sessionToken,
    },
    headers: {},
  }) as unknown as Parameters<
    EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]
  >[0];

const makeBearerRequest = (
  token: string,
): Parameters<EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]>[0] =>
  ({
    cookies: {},
    headers: {
      authorization: `Bearer ${token}`,
    },
  }) as unknown as Parameters<
    EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]
  >[0];

const requestMetadata = {
  deviceType: "desktop" as const,
  os: "macOS",
  browser: "Chrome",
  ipAddress: "192.168.1.23",
};

it.layer(NodeServices.layer)("EnvironmentAuth.layer", (it) => {
  it.effect("uses the reusable dev cookie without overriding a normal scoped cookie", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const token = "reusable-dev-auth-token-that-is-long-enough";
      const devExchange = yield* serverAuth.createBrowserSession(token, requestMetadata);
      const pairing = yield* serverAuth.issuePairingCredential({ scopes: ["orchestration:read"] });
      const scopedExchange = yield* serverAuth.createBrowserSession(
        pairing.credential,
        requestMetadata,
      );
      const request = {
        cookies: {
          [sessions.cookieName]: scopedExchange.sessionToken,
          [devExchange.cookieName ?? "missing"]: devExchange.sessionToken,
        },
        headers: {},
      } as unknown as Parameters<
        EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]
      >[0];

      const authenticated = yield* serverAuth.authenticateHttpRequest(request);
      expect(devExchange.cookieName).toMatch(/^t3_dev_session_/);
      expect(devExchange.expireNormalCookie).toBe(true);
      expect(devExchange.response).toMatchObject(authScopeResponse(AuthAdministrativeScopes));
      expect(authenticated.scopes).toEqual(["orchestration:read"]);
    }).pipe(
      Effect.provide(
        layerEnvironmentAuth({
          mode: "web",
          devUrl: new URL("http://127.0.0.1:5173"),
          devAuthToken: Redacted.make("reusable-dev-auth-token-that-is-long-enough"),
        }),
      ),
    ),
  );

  it.effect("does not fall back to the dev cookie after a normal cookie is rejected", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const token = "reusable-dev-auth-token-that-is-long-enough";
      const devExchange = yield* serverAuth.createBrowserSession(token, requestMetadata);
      const pairing = yield* serverAuth.issuePairingCredential({ scopes: ["orchestration:read"] });
      const scopedExchange = yield* serverAuth.createBrowserSession(
        pairing.credential,
        requestMetadata,
      );
      const scoped = yield* sessions.verify(scopedExchange.sessionToken);
      yield* sessions.revoke(scoped.sessionId);
      const request = {
        cookies: {
          [sessions.cookieName]: scopedExchange.sessionToken,
          [devExchange.cookieName ?? "missing"]: devExchange.sessionToken,
        },
        headers: {},
      } as unknown as Parameters<
        EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]
      >[0];

      const error = yield* Effect.flip(serverAuth.authenticateHttpRequest(request));
      expect(error._tag).toBe("ServerAuthInvalidCredentialError");
    }).pipe(
      Effect.provide(
        layerEnvironmentAuth({
          mode: "web",
          devUrl: new URL("http://127.0.0.1:5173"),
          devAuthToken: Redacted.make("reusable-dev-auth-token-that-is-long-enough"),
        }),
      ),
    ),
  );

  it.effect("does not use the dev cookie when Authorization is invalid or empty", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const token = "reusable-dev-auth-token-that-is-long-enough";
      const devExchange = yield* serverAuth.createBrowserSession(token, requestMetadata);
      for (const authorization of ["Bearer invalid", ""] as const) {
        const request = {
          cookies: { [devExchange.cookieName ?? "missing"]: devExchange.sessionToken },
          headers: { authorization },
        } as unknown as Parameters<
          EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]
        >[0];
        const error = yield* Effect.flip(serverAuth.authenticateHttpRequest(request));
        expect(EnvironmentAuth.isServerAuthCredentialError(error)).toBe(true);
      }
    }).pipe(
      Effect.provide(
        layerEnvironmentAuth({
          mode: "web",
          devUrl: new URL("http://127.0.0.1:5173"),
          devAuthToken: Redacted.make("reusable-dev-auth-token-that-is-long-enough"),
        }),
      ),
    ),
  );

  it.effect("exchanges the reusable dev token for a local scoped OAuth session", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const token = "reusable-dev-auth-token-that-is-long-enough";
      const exchanged = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        token,
        ["orchestration:read"],
        requestMetadata,
      );

      expect(exchanged.access_token).not.toBe(token);
      expect(exchanged.scope).toBe("orchestration:read");
      const dpop = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        token,
        ["orchestration:read"],
        requestMetadata,
        { proofKeyThumbprint: "test-proof-key" },
      );
      expect(dpop.access_token).not.toBe(token);
      expect(dpop.access_token).not.toBe(exchanged.access_token);
      expect(dpop.token_type).toBe("DPoP");
      expect(dpop.scope).toBe("orchestration:read");

      const secondBearer = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        token,
        ["orchestration:read"],
        requestMetadata,
      );
      const firstSession = yield* serverAuth.authenticateHttpRequest(
        makeBearerRequest(exchanged.access_token),
      );
      const secondSession = yield* serverAuth.authenticateHttpRequest(
        makeBearerRequest(secondBearer.access_token),
      );
      expect(firstSession.subject).toBe("reusable-dev-token-child");
      expect(secondSession.subject).toBe("reusable-dev-token-child");
      expect((yield* sessions.verify(token)).subject).toBe("reusable-dev-token");
      const before = yield* serverAuth.listClientSessions(firstSession.sessionId);
      const denied = yield* serverAuth
        .exchangeBootstrapCredentialForAccessToken(token, ["review:write"], requestMetadata)
        .pipe(Effect.flip);
      expect(denied._tag).toBe("ServerAuthScopeNotGrantedError");
      const empty = yield* serverAuth
        .exchangeBootstrapCredentialForAccessToken(token, [], requestMetadata)
        .pipe(Effect.flip);
      expect(empty._tag).toBe("ServerAuthScopeNotGrantedError");
      expect(yield* serverAuth.listClientSessions(firstSession.sessionId)).toEqual(before);
    }).pipe(
      Effect.provide(
        layerEnvironmentAuth({
          mode: "web",
          devUrl: new URL("http://127.0.0.1:5173"),
          devAuthToken: Redacted.make("reusable-dev-auth-token-that-is-long-enough"),
        }),
      ),
    ),
  );

  it.effect("uses a one-time startup credential after local dev token revocation", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const token = "reusable-dev-auth-token-that-is-long-enough";
      const initial = yield* serverAuth.issueStartupPairingCredential();
      const seeded = yield* sessions.verify(token);

      yield* sessions.revoke(seeded.sessionId);
      const recovery = yield* serverAuth.issueStartupPairingCredential();

      expect(initial.credential).toBe(token);
      expect(recovery.credential).not.toBe(token);
      expect((yield* Effect.flip(sessions.verify(token)))._tag).toBe("SessionTokenRevokedError");
      expect(
        (yield* serverAuth.createBrowserSession(recovery.credential, requestMetadata)).response,
      ).toMatchObject({ authenticated: true, ...authScopeResponse(AuthAdministrativeScopes) });
    }).pipe(
      Effect.provide(
        layerEnvironmentAuth({
          mode: "web",
          devUrl: new URL("http://127.0.0.1:5173"),
          devAuthToken: Redacted.make("reusable-dev-auth-token-that-is-long-enough"),
        }),
      ),
    ),
  );

  it.effect("keeps the pairing issue error as the immediate recovery failure", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const sql = yield* SqlClient.SqlClient;
      const token = "reusable-dev-auth-token-that-is-long-enough";
      const seeded = yield* sessions.verify(token);

      yield* sessions.revoke(seeded.sessionId);
      yield* sql`
        CREATE TRIGGER reject_startup_pairing_link
        BEFORE INSERT ON auth_pairing_links
        BEGIN
          SELECT RAISE(ABORT, 'startup pairing insert rejected');
        END
      `;

      const error = yield* Effect.flip(serverAuth.issueStartupPairingCredential());

      expect(error._tag).toBe("ServerAuthPairingLinkCreationError");
      expect(isPairingCredentialIssueError(error.cause)).toBe(true);
      if (isPairingCredentialIssueError(error.cause)) {
        expect(isPersistenceSqlError(error.cause.cause)).toBe(true);
      }
    }).pipe(
      Effect.provide(
        layerEnvironmentAuth({
          mode: "web",
          devUrl: new URL("http://127.0.0.1:5173"),
          devAuthToken: Redacted.make("reusable-dev-auth-token-that-is-long-enough"),
        }),
      ),
    ),
  );

  it.effect("classifies invalid bootstrap credential failures for the HTTP boundary", () =>
    Effect.sync(() => {
      const error = EnvironmentAuth.toBootstrapExchangeError(
        new PairingGrantStore.UnknownBootstrapCredentialError({}),
      );

      expect(error._tag).toBe("ServerAuthInvalidCredentialError");
    }),
  );

  it.effect("maps unexpected bootstrap failures to 500", () =>
    Effect.sync(() => {
      const cause = new PairingGrantStore.BootstrapCredentialConsumeError({
        cause: new Error("sqlite is unavailable"),
      });
      const error = EnvironmentAuth.toBootstrapExchangeError(cause);

      expect(error._tag).toBe("ServerAuthBootstrapCredentialValidationError");
      expect(error.message).toBe("Failed to validate bootstrap credential.");
      if (error._tag === "ServerAuthBootstrapCredentialValidationError") {
        expect(error.cause).toBe(cause);
      }
    }),
  );

  it.effect("issues standard pairing credentials by default", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;

      const pairingCredential = yield* serverAuth.issuePairingCredential();
      const exchanged = yield* serverAuth.createBrowserSession(
        pairingCredential.credential,
        requestMetadata,
      );
      const verified = yield* serverAuth.authenticateHttpRequest(
        makeCookieRequest(sessions.cookieName, exchanged.sessionToken),
      );

      expect(verified.sessionId.length).toBeGreaterThan(0);
      expect(verified.scopes).toEqual(AuthStandardClientScopes);
      expect(verified.subject).toBe("one-time-token");
    }).pipe(Effect.provide(layerEnvironmentAuth())),
  );

  it.effect("prefers a bearer token over a stale legacy cookie", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const bearer = yield* serverAuth.issueSession();
      const verified = yield* serverAuth.authenticateHttpRequest({
        cookies: { [sessions.legacyCookieName ?? "t3_session"]: "stale" },
        headers: { authorization: `Bearer ${bearer.token}` },
      } as never);

      expect(verified.sessionId).toBe(bearer.sessionId);
    }).pipe(Effect.provide(layerEnvironmentAuth({ mode: "web", host: "192.168.1.50" }))),
  );

  it.effect("preserves pairing grants after rejecting scopes they do not grant", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const pairingCredential = yield* serverAuth.issuePairingCredential();

      const error = yield* serverAuth
        .exchangeBootstrapCredentialForAccessToken(
          pairingCredential.credential,
          ["access:write"],
          requestMetadata,
        )
        .pipe(Effect.flip);

      expect(error._tag).toBe("ServerAuthScopeNotGrantedError");
      expect((yield* serverAuth.listPairingLinks()).map((link) => link.id)).toContain(
        pairingCredential.id,
      );
      expect(yield* serverAuth.listSessions()).toEqual([]);

      const token = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        pairingCredential.credential,
        ["orchestration:read"],
        requestMetadata,
      );
      const session = yield* serverAuth.authenticateHttpRequest(
        makeBearerRequest(token.access_token),
      );

      expect(token.scope).toBe("orchestration:read");
      expect(session.scopes).toEqual(["orchestration:read"]);
      expect((yield* serverAuth.listPairingLinks()).map((link) => link.id)).not.toContain(
        pairingCredential.id,
      );
      const reused = yield* serverAuth
        .exchangeBootstrapCredentialForAccessToken(
          pairingCredential.credential,
          ["orchestration:read"],
          requestMetadata,
        )
        .pipe(Effect.flip);
      expect(reused._tag).toBe("ServerAuthInvalidCredentialError");
    }).pipe(Effect.provide(layerEnvironmentAuth())),
  );

  it.effect.each([
    { label: "omits scope", requestedScopes: undefined },
    {
      label: "requests unsupported permissions alongside a granted one",
      requestedScopes: ["orchestration:read", "access:write"] as const,
    },
  ])("inherits a constrained pairing grant when token exchange $label", ({ requestedScopes }) =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const pairingCredential = yield* serverAuth.issuePairingCredential({
        scopes: ["orchestration:read"],
      });

      const token = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        pairingCredential.credential,
        requestedScopes,
        requestMetadata,
      );

      expect(token.scope).toBe("orchestration:read");
    }).pipe(Effect.provide(layerEnvironmentAuth())),
  );

  it.effect("narrows seeded desktop grants to the requested scopes", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const token = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        "desktop-bootstrap-token",
        ["orchestration:read"],
        requestMetadata,
      );
      const session = yield* serverAuth.authenticateHttpRequest(
        makeBearerRequest(token.access_token),
      );

      expect(token.scope).toBe("orchestration:read");
      expect(session.scopes).toEqual(["orchestration:read"]);
    }).pipe(
      Effect.provide(layerEnvironmentAuth({ desktopBootstrapToken: "desktop-bootstrap-token" })),
    ),
  );

  it.effect("rotates desktop bearer sessions without accumulating authorized clients", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const browser = yield* serverAuth.createBrowserSession(
        "desktop-bootstrap-token",
        requestMetadata,
      );
      const browserSession = yield* serverAuth.authenticateHttpRequest(
        makeCookieRequest(sessions.cookieName, browser.sessionToken),
      );
      const staleSessions = yield* Effect.forEach([1, 2, 3], () =>
        sessions.issue({ subject: "desktop-bootstrap", method: "bearer-access-token" }),
      );
      const pairing = yield* serverAuth.issuePairingCredential();
      const paired = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        pairing.credential,
        undefined,
        { ...requestMetadata, label: "T3 Code Desktop" },
      );
      const first = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        "desktop-bootstrap-token",
        undefined,
        requestMetadata,
      );
      const firstSession = yield* serverAuth.authenticateHttpRequest(
        makeBearerRequest(first.access_token),
      );
      const second = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        "desktop-bootstrap-token",
        undefined,
        requestMetadata,
      );

      const active = yield* serverAuth.listSessions();
      const firstError = yield* serverAuth
        .authenticateHttpRequest(makeBearerRequest(first.access_token))
        .pipe(Effect.flip);
      const secondSession = yield* serverAuth.authenticateHttpRequest(
        makeBearerRequest(second.access_token),
      );

      expect(active).toHaveLength(3);
      expect(active.map((entry) => entry.sessionId)).toContain(browserSession.sessionId);
      expect(active.map((entry) => entry.sessionId)).toContain(secondSession.sessionId);
      expect(active.map((entry) => entry.sessionId)).not.toContain(firstSession.sessionId);
      expect(firstError._tag).toBe("ServerAuthInvalidCredentialError");
      for (const stale of staleSessions) {
        const error = yield* sessions.verify(stale.token).pipe(Effect.flip);
        expect(error._tag).toBe("SessionTokenRevokedError");
      }
      const pairedSession = yield* serverAuth.authenticateHttpRequest(
        makeBearerRequest(paired.access_token),
      );
      expect(pairedSession.subject).toBe("one-time-token");
      expect(active.map((entry) => entry.sessionId)).toContain(pairedSession.sessionId);
    }).pipe(
      Effect.provide(
        layerEnvironmentAuth({
          desktopBootstrapToken: "desktop-bootstrap-token",
        }),
      ),
    ),
  );

  it.effect("keeps user-issued administrative pairing links manageable", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const pairingCredential = yield* serverAuth.issuePairingCredential({
        scopes: AuthAdministrativeScopes,
      });
      const listedPairingLinks = yield* serverAuth.listPairingLinks();

      expect(
        listedPairingLinks.find((pairingLink) => pairingLink.id === pairingCredential.id)?.subject,
      ).toBe("one-time-token");
    }).pipe(Effect.provide(layerEnvironmentAuth())),
  );

  it.effect("issues startup pairing URLs that bootstrap administrative sessions", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;

      const pairingUrl = yield* serverAuth.issueStartupPairingUrl("http://127.0.0.1:3773");
      const token = new URLSearchParams(new URL(pairingUrl).hash.slice(1)).get("token");
      const listedPairingLinks = yield* serverAuth.listPairingLinks();
      expect(token).toBeTruthy();
      expect(
        listedPairingLinks.some(
          (pairingLink) => pairingLink.subject === "administrative-bootstrap",
        ),
      ).toBe(false);

      const exchanged = yield* serverAuth.createBrowserSession(token ?? "", requestMetadata);
      const verified = yield* serverAuth.authenticateHttpRequest(
        makeCookieRequest(sessions.cookieName, exchanged.sessionToken),
      );

      expect(verified.scopes).toEqual(AuthAdministrativeScopes);
      expect(verified.subject).toBe("administrative-bootstrap");
    }).pipe(Effect.provide(layerEnvironmentAuth())),
  );

  it.effect(
    "lists pairing links and revokes other sessions while keeping the administrative session",
    () =>
      Effect.gen(function* () {
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;

        const administrativeExchange = yield* serverAuth.createBrowserSession(
          "desktop-bootstrap-token",
          requestMetadata,
        );
        const administrativeSession = yield* serverAuth.authenticateHttpRequest(
          makeCookieRequest(sessions.cookieName, administrativeExchange.sessionToken),
        );
        const pairingCredential = yield* serverAuth.issuePairingCredential({
          label: "Julius iPhone",
        });
        const listedPairingLinks = yield* serverAuth.listPairingLinks();
        const clientExchange = yield* serverAuth.createBrowserSession(
          pairingCredential.credential,
          {
            ...requestMetadata,
            deviceType: "mobile",
            os: "iOS",
            browser: "Safari",
            ipAddress: "192.168.1.88",
          },
        );
        const clientSession = yield* serverAuth.authenticateHttpRequest(
          makeCookieRequest(sessions.cookieName, clientExchange.sessionToken),
        );
        const clientsBeforeRevoke = yield* serverAuth.listClientSessions(
          administrativeSession.sessionId,
        );
        const revokedCount = yield* serverAuth.revokeOtherClientSessions(
          administrativeSession.sessionId,
        );
        const clientsAfterRevoke = yield* serverAuth.listClientSessions(
          administrativeSession.sessionId,
        );

        expect(listedPairingLinks.map((entry) => entry.id)).toContain(pairingCredential.id);
        expect(listedPairingLinks.find((entry) => entry.id === pairingCredential.id)?.label).toBe(
          "Julius iPhone",
        );
        expect(clientsBeforeRevoke).toHaveLength(2);
        expect(
          clientsBeforeRevoke.find((entry) => entry.sessionId === administrativeSession.sessionId)
            ?.current,
        ).toBe(true);
        expect(
          clientsBeforeRevoke.find((entry) => entry.sessionId === clientSession.sessionId)?.current,
        ).toBe(false);
        expect(
          clientsBeforeRevoke.find((entry) => entry.sessionId === clientSession.sessionId)?.client
            .label,
        ).toBe("Julius iPhone");
        expect(
          clientsBeforeRevoke.find((entry) => entry.sessionId === clientSession.sessionId)?.client
            .deviceType,
        ).toBe("mobile");
        expect(revokedCount).toBe(1);
        expect(clientsAfterRevoke).toHaveLength(1);
        expect(clientsAfterRevoke[0]?.sessionId).toBe(administrativeSession.sessionId);
      }).pipe(
        Effect.provide(
          layerEnvironmentAuth({
            desktopBootstrapToken: "desktop-bootstrap-token",
          }),
        ),
      ),
  );

  it.effect("accepts cookie sessions on socket upgrades only from the app's own origins", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const pairing = yield* serverAuth.issuePairingCredential();
      const exchanged = yield* serverAuth.createBrowserSession(pairing.credential, requestMetadata);
      const upgrade = (headers: Record<string, string>) =>
        serverAuth.authenticateWebSocketUpgrade({
          url: "/ws",
          cookies: { [sessions.cookieName]: exchanged.sessionToken },
          headers: { host: "192.168.1.50:3773", ...headers },
        } as never);

      // Same host, a proxy-reported host, a trusted app origin, or no browser at all.
      yield* upgrade({ origin: "http://192.168.1.50:3773" });
      yield* upgrade({
        origin: "https://box.tail1234.ts.net",
        "x-forwarded-host": "box.tail1234.ts.net",
      });
      yield* upgrade({ origin: "t3code://app" });
      yield* upgrade({ origin: "http://localhost:5733" });
      yield* upgrade({});

      // Another port on the same machine is the same site but not the app.
      const otherPort = yield* Effect.flip(upgrade({ origin: "http://192.168.1.50:8080" }));
      expect(otherPort._tag).toBe("ServerAuthInvalidCredentialError");
      const opaque = yield* Effect.flip(upgrade({ origin: "null" }));
      expect(opaque._tag).toBe("ServerAuthInvalidCredentialError");
    }).pipe(
      Effect.provide(
        layerEnvironmentAuth({
          mode: "web",
          host: "192.168.1.50",
          devUrl: new URL("http://localhost:5733"),
        }),
      ),
    ),
  );

  it.effect("accepts cookie sessions on HTTP requests only from the app's own origins", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const pairing = yield* serverAuth.issuePairingCredential();
      const exchanged = yield* serverAuth.createBrowserSession(pairing.credential, requestMetadata);
      const post = (headers: Record<string, string>) =>
        serverAuth.authenticateHttpRequest({
          cookies: { [sessions.cookieName]: exchanged.sessionToken },
          headers: { host: "localhost:13773", ...headers },
        } as never);

      // The dev proxy rewrites Host, so a LAN page relies on the browser's own verdict.
      yield* post({ origin: "http://192.168.1.50:5733", "sec-fetch-site": "same-origin" });
      yield* post({ origin: "http://localhost:13773" });

      const otherPort = yield* Effect.flip(
        post({ origin: "http://localhost:3000", "sec-fetch-site": "same-site" }),
      );
      expect(otherPort._tag).toBe("ServerAuthInvalidCredentialError");
      const state = yield* serverAuth.getSessionState({
        cookies: { [sessions.cookieName]: exchanged.sessionToken },
        headers: { host: "localhost:13773", origin: "http://localhost:3000" },
      } as never);
      expect(state.authenticated).toBe(false);
    }).pipe(Effect.provide(layerEnvironmentAuth({ mode: "web" }))),
  );

  it.effect("keeps bearer socket upgrades independent of the page origin", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const bearer = yield* serverAuth.issueSession();
      const verified = yield* serverAuth.authenticateWebSocketUpgrade({
        url: "/ws",
        cookies: {},
        headers: {
          host: "192.168.1.50:3773",
          origin: "http://192.168.1.50:8080",
          authorization: `Bearer ${bearer.token}`,
        },
      } as never);
      expect(verified.sessionId).toBe(bearer.sessionId);
    }).pipe(Effect.provide(layerEnvironmentAuth({ mode: "web", host: "192.168.1.50" }))),
  );
});

const makeRenewalLayer = () =>
  Layer.merge(
    makeEnvironmentAuthLayer({ desktopBootstrapToken: "desktop-bootstrap-token" }),
    TestClock.layer(),
  );

const renewalMetadata = {
  deviceType: "desktop" as const,
  os: "Windows",
  browser: "Electron",
  ipAddress: "192.168.1.77",
};

/** Pairs a client the way a saved remote connection does: pairing link, then OAuth exchange. */
const pairBearerClient = Effect.fn("test.pairBearerClient")(function* (input?: {
  readonly scopes?: ReadonlyArray<"orchestration:read" | "orchestration:operate">;
}) {
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const pairing = yield* serverAuth.issuePairingCredential({
    label: "Remote laptop",
    ...(input?.scopes ? { scopes: input.scopes } : {}),
  });
  const exchanged = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
    pairing.credential,
    undefined,
    requestMetadata,
  );
  const session = yield* serverAuth.authenticateHttpRequest(
    makeBearerRequest(exchanged.access_token),
  );
  return { token: exchanged.access_token, session };
});

it.layer(NodeServices.layer)("EnvironmentAuth bearer session renewal", (it) => {
  it.effect("answers without minting while the session is outside the renewal window", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const paired = yield* pairBearerClient();
      const before = yield* serverAuth.listSessions();

      yield* TestClock.adjust(Duration.days(19));
      const result = yield* serverAuth.renewBearerSession(
        makeBearerRequest(paired.token),
        renewalMetadata,
      );

      expect(result.renewed).toBe(false);
      expect(result.expiresAt.epochMilliseconds).toBe(paired.session.expiresAt?.epochMilliseconds);
      expect(yield* serverAuth.listSessions()).toHaveLength(before.length);
    }).pipe(Effect.provide(makeRenewalLayer())),
  );

  it.effect("mints a successor inside the window and leaves the old session to lapse", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const paired = yield* pairBearerClient({ scopes: ["orchestration:read"] });

      yield* TestClock.adjust(Duration.days(21));
      const now = yield* DateTime.now;
      const result = yield* serverAuth.renewBearerSession(
        makeBearerRequest(paired.token),
        renewalMetadata,
      );
      if (!result.renewed) {
        return expect.fail("expected the session to be renewed");
      }
      const renewed = yield* serverAuth.authenticateHttpRequest(
        makeBearerRequest(result.access_token),
      );
      const previous = yield* serverAuth.authenticateHttpRequest(makeBearerRequest(paired.token));
      const listed = yield* serverAuth.listSessions();
      const renewedListing = listed.find((entry) => entry.sessionId === renewed.sessionId);

      expect(result.token_type).toBe("Bearer");
      expect(result.scope).toBe("orchestration:read");
      expect(result.expiresAt.epochMilliseconds).toBe(
        now.epochMilliseconds + Duration.toMillis(Duration.days(30)),
      );
      expect(result.expires_in).toBe(Duration.toSeconds(Duration.days(30)));
      expect(renewed.sessionId).not.toBe(paired.session.sessionId);
      expect(renewed.subject).toBe(paired.session.subject);
      expect(renewed.subject).toBe("one-time-token");
      expect(renewed.scopes).toEqual(["orchestration:read"]);
      expect(renewed.method).toBe("bearer-access-token");
      expect(previous.sessionId).toBe(paired.session.sessionId);
      expect(renewedListing?.client.label).toBe("Remote laptop");
      expect(renewedListing?.client.os).toBe("Windows");
      expect(renewedListing?.client.ipAddress).toBe("192.168.1.77");

      // The renewed token is far from its own window, so renewing it again is a no-op.
      const again = yield* serverAuth.renewBearerSession(
        makeBearerRequest(result.access_token),
        renewalMetadata,
      );
      expect(again.renewed).toBe(false);

      yield* TestClock.adjust(Duration.days(10));
      const lapsed = yield* serverAuth
        .authenticateHttpRequest(makeBearerRequest(paired.token))
        .pipe(Effect.flip);
      expect(lapsed._tag).toBe("ServerAuthInvalidCredentialError");
      expect(
        (yield* serverAuth.authenticateHttpRequest(makeBearerRequest(result.access_token)))
          .sessionId,
      ).toBe(renewed.sessionId);
    }).pipe(Effect.provide(makeRenewalLayer())),
  );

  it.effect("keeps administrative scopes and subject of CLI-issued sessions", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const issued = yield* serverAuth.issueSession({
        subject: "headless-runner",
        label: "Build runner",
      });

      yield* TestClock.adjust(Duration.days(25));
      const result = yield* serverAuth.renewBearerSession(makeBearerRequest(issued.token), {
        deviceType: "unknown",
      });
      if (!result.renewed) {
        return expect.fail("expected the session to be renewed");
      }
      const renewed = yield* serverAuth.authenticateHttpRequest(
        makeBearerRequest(result.access_token),
      );
      const listing = (yield* serverAuth.listSessions()).find(
        (entry) => entry.sessionId === renewed.sessionId,
      );

      expect(renewed.subject).toBe("headless-runner");
      expect([...renewed.scopes].toSorted()).toEqual([...AuthAdministrativeScopes].toSorted());
      expect(listing?.client.label).toBe("Build runner");
      expect(listing?.client.deviceType).toBe("bot");
    }).pipe(Effect.provide(makeRenewalLayer())),
  );

  it.effect("never extends a short-lived session or lengthens a custom lifetime", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const shortLived = yield* serverAuth.issueSession({ ttl: Duration.days(2) });
      const custom = yield* serverAuth.issueSession({ ttl: Duration.days(14) });

      yield* TestClock.adjust(Duration.days(1));
      const shortResult = yield* serverAuth.renewBearerSession(
        makeBearerRequest(shortLived.token),
        renewalMetadata,
      );
      yield* TestClock.adjust(Duration.days(5));
      const now = yield* DateTime.now;
      const customResult = yield* serverAuth.renewBearerSession(
        makeBearerRequest(custom.token),
        renewalMetadata,
      );

      expect(shortResult.renewed).toBe(false);
      expect(customResult.renewed).toBe(true);
      expect(customResult.expiresAt.epochMilliseconds).toBe(
        now.epochMilliseconds + Duration.toMillis(Duration.days(14)),
      );
    }).pipe(Effect.provide(makeRenewalLayer())),
  );

  it.effect("rejects cookie sessions, cookie tokens sent as bearer, and missing credentials", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const browser = yield* serverAuth.createBrowserSession(
        "desktop-bootstrap-token",
        requestMetadata,
      );
      yield* TestClock.adjust(Duration.days(25));

      const cookieError = yield* serverAuth
        .renewBearerSession(
          makeCookieRequest(sessions.cookieName, browser.sessionToken),
          renewalMetadata,
        )
        .pipe(Effect.flip);
      const cookieAsBearerError = yield* serverAuth
        .renewBearerSession(makeBearerRequest(browser.sessionToken), renewalMetadata)
        .pipe(Effect.flip);
      const missingError = yield* serverAuth
        .renewBearerSession({ cookies: {}, headers: {} } as never, renewalMetadata)
        .pipe(Effect.flip);

      expect(cookieError).toMatchObject({
        _tag: "ServerAuthBearerSessionRequiredError",
        presented: "cookie",
      });
      expect(cookieAsBearerError).toMatchObject({
        _tag: "ServerAuthBearerSessionRequiredError",
        presented: "non-bearer-session",
      });
      expect(missingError._tag).toBe("ServerAuthMissingCredentialError");
    }).pipe(Effect.provide(makeRenewalLayer())),
  );

  it.effect("renews the Authorization bearer even when a browser cookie is also sent", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const browser = yield* serverAuth.createBrowserSession(
        "desktop-bootstrap-token",
        requestMetadata,
      );
      const paired = yield* pairBearerClient();
      yield* TestClock.adjust(Duration.days(25));

      const result = yield* serverAuth.renewBearerSession(
        {
          cookies: { [sessions.cookieName]: browser.sessionToken },
          headers: { authorization: `Bearer ${paired.token}` },
        } as never,
        renewalMetadata,
      );
      if (!result.renewed) {
        return expect.fail("expected the session to be renewed");
      }
      const renewed = yield* serverAuth.authenticateHttpRequest(
        makeBearerRequest(result.access_token),
      );
      expect(renewed.subject).toBe("one-time-token");
    }).pipe(Effect.provide(makeRenewalLayer())),
  );

  it.effect("rejects DPoP-bound sessions in either authorization scheme", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const dpop = yield* sessions.issue({
        method: "dpop-access-token",
        subject: "one-time-token",
        proofKeyThumbprint: "proof-key-thumbprint",
      });

      const dpopError = yield* serverAuth
        .renewBearerSession(
          { cookies: {}, headers: { authorization: `DPoP ${dpop.token}` } } as never,
          renewalMetadata,
        )
        .pipe(Effect.flip);
      const boundAsBearerError = yield* serverAuth
        .renewBearerSession(makeBearerRequest(dpop.token), renewalMetadata)
        .pipe(Effect.flip);

      expect(dpopError).toMatchObject({
        _tag: "ServerAuthBearerSessionRequiredError",
        presented: "dpop",
      });
      expect(boundAsBearerError).toMatchObject({
        _tag: "ServerAuthBearerSessionRequiredError",
        presented: "dpop-bound-bearer",
      });
    }).pipe(Effect.provide(makeRenewalLayer())),
  );

  it.effect("rejects expired, revoked, and websocket-ticket credentials", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const expiring = yield* pairBearerClient();
      const revoked = yield* pairBearerClient();
      const ticket = yield* serverAuth.issueWebSocketTicket(revoked.session);

      const ticketError = yield* serverAuth
        .renewBearerSession(makeBearerRequest(ticket.ticket), renewalMetadata)
        .pipe(Effect.flip);
      yield* TestClock.adjust(Duration.days(25));
      yield* serverAuth.revokeSession(revoked.session.sessionId);
      const revokedError = yield* serverAuth
        .renewBearerSession(makeBearerRequest(revoked.token), renewalMetadata)
        .pipe(Effect.flip);
      yield* TestClock.adjust(Duration.days(6));
      const expiredError = yield* serverAuth
        .renewBearerSession(makeBearerRequest(expiring.token), renewalMetadata)
        .pipe(Effect.flip);

      expect(ticketError._tag).toBe("ServerAuthInvalidCredentialError");
      expect(revokedError._tag).toBe("ServerAuthInvalidCredentialError");
      expect(expiredError._tag).toBe("ServerAuthInvalidCredentialError");
      expect(yield* serverAuth.listSessions()).toHaveLength(0);
    }).pipe(Effect.provide(makeRenewalLayer())),
  );
});

it.layer(NodeServices.layer)("EnvironmentAuth bearer session renewal lineage", (it) => {
  const renewOrFail = Effect.fn("test.renewOrFail")(function* (token: string) {
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const result = yield* serverAuth.renewBearerSession(makeBearerRequest(token), renewalMetadata);
    if (!result.renewed) {
      return yield* Effect.die(new Error(`expected a renewal, got ${result.reason ?? "none"}`));
    }
    return result.access_token;
  });

  const adminSessionId = Effect.fn("test.adminSessionId")(function* () {
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const sessions = yield* SessionStore.SessionStore;
    const browser = yield* serverAuth.createBrowserSession(
      "desktop-bootstrap-token",
      requestMetadata,
    );
    return (yield* serverAuth.authenticateHttpRequest(
      makeCookieRequest(sessions.cookieName, browser.sessionToken),
    )).sessionId;
  });

  it.effect("renews a session at most once, even when renewals race", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const paired = yield* pairBearerClient();
      yield* TestClock.adjust(Duration.days(25));

      const results = yield* Effect.all(
        Array.from({ length: 5 }, () =>
          serverAuth.renewBearerSession(makeBearerRequest(paired.token), renewalMetadata),
        ),
        { concurrency: "unbounded" },
      );
      const renewed = results.filter((result) => result.renewed);
      const declined = results.filter((result) => !result.renewed);

      expect(renewed).toHaveLength(1);
      expect(declined).toHaveLength(4);
      for (const result of declined) {
        expect(result).toMatchObject({ renewed: false, reason: "already_renewed" });
        expect(result.expiresAt.epochMilliseconds).toBe(
          paired.session.expiresAt?.epochMilliseconds,
        );
      }

      // A later retry with the old token still does not mint, and the old
      // token keeps working until its own expiry.
      const retry = yield* serverAuth.renewBearerSession(
        makeBearerRequest(paired.token),
        renewalMetadata,
      );
      expect(retry).toMatchObject({ renewed: false, reason: "already_renewed" });
      expect(
        (yield* serverAuth.authenticateHttpRequest(makeBearerRequest(paired.token))).sessionId,
      ).toBe(paired.session.sessionId);
      // One chain, one Settings entry.
      expect(yield* serverAuth.listSessions()).toHaveLength(1);
    }).pipe(Effect.provide(makeRenewalLayer())),
  );

  it.effect("lets the successor renew in turn, forming a chain", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const paired = yield* pairBearerClient();
      yield* TestClock.adjust(Duration.days(25));
      const second = yield* renewOrFail(paired.token);
      yield* TestClock.adjust(Duration.days(25));
      const third = yield* renewOrFail(second);
      const sessions = yield* SessionStore.SessionStore;
      const thirdSession = yield* serverAuth.authenticateHttpRequest(makeBearerRequest(third));

      expect(yield* sessions.listLineageIds(thirdSession.sessionId)).toHaveLength(3);
      expect(yield* serverAuth.listSessions()).toHaveLength(1);
    }).pipe(Effect.provide(makeRenewalLayer())),
  );

  for (const end of ["original", "successor"] as const) {
    it.effect(`revoking the ${end} revokes the whole renewal chain`, () =>
      Effect.gen(function* () {
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const admin = yield* adminSessionId();
        const paired = yield* pairBearerClient();
        const bystander = yield* pairBearerClient();
        yield* TestClock.adjust(Duration.days(25));
        const second = yield* renewOrFail(paired.token);
        yield* TestClock.adjust(Duration.days(1));
        const secondSession = yield* serverAuth.authenticateHttpRequest(makeBearerRequest(second));

        const target = end === "original" ? paired.session.sessionId : secondSession.sessionId;
        expect(yield* serverAuth.revokeClientSession(admin, target)).toBe(true);

        for (const token of [paired.token, second]) {
          const error = yield* serverAuth
            .authenticateHttpRequest(makeBearerRequest(token))
            .pipe(Effect.flip);
          expect(error._tag).toBe("ServerAuthInvalidCredentialError");
        }
        expect(
          (yield* serverAuth.authenticateHttpRequest(makeBearerRequest(bystander.token))).sessionId,
        ).toBe(bystander.session.sessionId);
        const remaining = (yield* serverAuth.listSessions()).map((entry) => entry.sessionId);
        expect(remaining).toContain(admin);
        expect(remaining).toContain(bystander.session.sessionId);
        expect(remaining).not.toContain(paired.session.sessionId);
        expect(remaining).not.toContain(secondSession.sessionId);
      }).pipe(Effect.provide(makeRenewalLayer())),
    );
  }

  it.effect("revokes a session renewed twice from its root", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const paired = yield* pairBearerClient();
      yield* TestClock.adjust(Duration.days(21));
      const second = yield* renewOrFail(paired.token);
      yield* TestClock.adjust(Duration.days(21));
      const third = yield* renewOrFail(second);

      // The root has expired by now, but its revocation still reaches the chain.
      expect(yield* serverAuth.revokeSession(paired.session.sessionId)).toBe(true);
      const error = yield* serverAuth
        .authenticateHttpRequest(makeBearerRequest(third))
        .pipe(Effect.flip);
      expect(error._tag).toBe("ServerAuthInvalidCredentialError");
    }).pipe(Effect.provide(makeRenewalLayer())),
  );

  it.effect("shows a renewed pair as one entry that follows the client's connection", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const paired = yield* pairBearerClient();
      yield* TestClock.adjust(Duration.days(25));
      // The client's socket is still on the previous token while it renews.
      yield* sessions.markConnected(paired.session.sessionId);
      const second = yield* renewOrFail(paired.token);
      const secondSession = yield* serverAuth.authenticateHttpRequest(makeBearerRequest(second));

      const listed = yield* serverAuth.listClientSessions(paired.session.sessionId);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        sessionId: secondSession.sessionId,
        connected: true,
        current: true,
      });
      expect(listed[0]?.lastConnectedAt).not.toBeNull();

      // Either token of the caller's own chain counts as the caller's session.
      const ownError = yield* serverAuth
        .revokeClientSession(paired.session.sessionId, secondSession.sessionId)
        .pipe(Effect.flip);
      expect(ownError._tag).toBe("ServerAuthForbiddenOperationError");

      yield* sessions.markDisconnected(paired.session.sessionId);
      const afterDisconnect = yield* serverAuth.listClientSessions(secondSession.sessionId);
      expect(afterDisconnect).toHaveLength(1);
      expect(afterDisconnect[0]).toMatchObject({ connected: false, current: true });
    }).pipe(Effect.provide(makeRenewalLayer())),
  );

  it.effect("keeps the caller's own renewal chain when revoking other clients", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const paired = yield* pairBearerClient();
      const other = yield* pairBearerClient();
      yield* TestClock.adjust(Duration.days(25));
      const second = yield* renewOrFail(paired.token);
      const secondSession = yield* serverAuth.authenticateHttpRequest(makeBearerRequest(second));

      expect(yield* serverAuth.revokeOtherClientSessions(secondSession.sessionId)).toBe(1);
      expect(
        (yield* serverAuth.authenticateHttpRequest(makeBearerRequest(paired.token))).sessionId,
      ).toBe(paired.session.sessionId);
      const otherError = yield* serverAuth
        .authenticateHttpRequest(makeBearerRequest(other.token))
        .pipe(Effect.flip);
      expect(otherError._tag).toBe("ServerAuthInvalidCredentialError");
    }).pipe(Effect.provide(makeRenewalLayer())),
  );

  it.effect("publishes a renewal as one replaced Settings entry", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const paired = yield* pairBearerClient();
      yield* TestClock.adjust(Duration.days(25));
      const changes = yield* Stream.runCollect(Stream.take(sessions.streamChanges, 2)).pipe(
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      const second = yield* renewOrFail(paired.token);
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const secondSession = yield* serverAuth.authenticateHttpRequest(makeBearerRequest(second));

      const events = [...(yield* Fiber.join(changes))];
      expect(events.map((event) => event.type)).toEqual(["clientRemoved", "clientUpserted"]);
      expect(events[0]).toMatchObject({ sessionId: paired.session.sessionId });
      expect(events[1]).toMatchObject({
        clientSession: { sessionId: secondSession.sessionId },
      });
    }).pipe(Effect.provide(makeRenewalLayer()), Effect.scoped),
  );
});
