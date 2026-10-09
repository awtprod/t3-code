import { vi } from "vite-plus/test";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";

import * as DesktopBackendPool from "./DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuth from "./DesktopLocalEnvironmentAuth.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopConnectionCatalogStore from "../app/DesktopConnectionCatalogStore.ts";

// All Electron services are injected; prevent loading a native runtime in unit tests.
vi.mock("electron", () => ({ net: {}, safeStorage: {} }));

const config = {
  executablePath: "/electron",
  entryPath: "/server/bin.mjs",
  cwd: "/server",
  env: {},
  bootstrap: {
    mode: "desktop",
    noBrowser: true,
    port: 3773,
    t3Home: "/tmp/t3",
    host: "127.0.0.1",
    desktopBootstrapToken: "desktop-bootstrap-token",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  },
  httpBaseUrl: new URL("http://127.0.0.1:3773"),
  captureOutput: true,
};

const encodedRemoteCatalog = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))({
  schemaVersion: 1,
  targets: [],
  profiles: [
    {
      _tag: "BearerConnectionProfile",
      connectionId: "bearer:remote",
      environmentId: "remote",
      label: "Remote",
      httpBaseUrl: "https://remote.example.test",
      wsBaseUrl: "wss://remote.example.test",
    },
  ],
  credentials: [
    {
      connectionId: "bearer:remote",
      credential: { _tag: "BearerConnectionCredential", token: "remote-token" },
    },
  ],
  remoteDpopTokens: [],
});

describe("DesktopLocalEnvironmentAuth", () => {
  it.effect("exchanges the desktop bootstrap credential only once", () =>
    Effect.gen(function* () {
      const requestCount = yield* Ref.make(0);
      const httpClientLayer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Ref.update(requestCount, (count) => count + 1).pipe(
            Effect.as(
              HttpClientResponse.fromWeb(
                request,
                new Response(
                  JSON.stringify({
                    access_token: "desktop-bearer-token",
                    issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
                    token_type: "Bearer",
                    expires_in: 3600,
                    scope: "orchestration:read",
                  }),
                  { status: 200, headers: { "content-type": "application/json" } },
                ),
              ),
            ),
          ),
        ),
      );
      const poolLayer = Layer.succeed(DesktopBackendPool.DesktopBackendPool, {
        list: Effect.succeed([
          {
            id: PRIMARY_LOCAL_ENVIRONMENT_ID,
            label: Effect.succeed("Windows"),
            currentConfig: Effect.succeed(Option.some(config)),
          },
        ]),
      } as unknown as DesktopBackendPool.DesktopBackendPool["Service"]);
      const settingsLayer = Layer.succeed(DesktopAppSettings.DesktopAppSettings, {
        get: Effect.succeed(DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS),
      } as unknown as DesktopAppSettings.DesktopAppSettings["Service"]);
      const catalogLayer = Layer.succeed(
        DesktopConnectionCatalogStore.DesktopConnectionCatalogStore,
        {
          get: Effect.succeed(Option.none()),
        } as unknown as DesktopConnectionCatalogStore.DesktopConnectionCatalogStore["Service"],
      );
      const testLayer = DesktopLocalEnvironmentAuth.layer.pipe(
        Layer.provide(Layer.mergeAll(poolLayer, httpClientLayer, settingsLayer, catalogLayer)),
      );

      const [first, second] = yield* Effect.gen(function* () {
        const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
        return yield* Effect.all([auth.getBearerToken, auth.getBearerToken]);
      }).pipe(Effect.provide(testLayer));

      assert.strictEqual(first, "desktop-bearer-token");
      assert.strictEqual(second, "desktop-bearer-token");
      assert.strictEqual(yield* Ref.get(requestCount), 1);
    }),
  );

  it.effect("reads the paired remote primary bearer from the encrypted catalog service", () =>
    Effect.gen(function* () {
      const poolLayer = DesktopBackendPool.layerTest([]);
      const settingsLayer = Layer.succeed(DesktopAppSettings.DesktopAppSettings, {
        get: Effect.succeed({
          ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
          primaryBackendMode: "remote",
          remoteBackendUrl: "https://remote.example.test/",
        }),
      } as unknown as DesktopAppSettings.DesktopAppSettings["Service"]);
      const catalogLayer = Layer.succeed(
        DesktopConnectionCatalogStore.DesktopConnectionCatalogStore,
        {
          get: Effect.succeed(Option.some(encodedRemoteCatalog)),
        } as unknown as DesktopConnectionCatalogStore.DesktopConnectionCatalogStore["Service"],
      );
      const httpClientLayer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("remote catalog bearer must not mint a local token")),
      );
      const testLayer = DesktopLocalEnvironmentAuth.layer.pipe(
        Layer.provide(Layer.mergeAll(poolLayer, settingsLayer, catalogLayer, httpClientLayer)),
      );
      const token = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth.pipe(
        Effect.flatMap((auth) => auth.getBearerToken),
        Effect.provide(testLayer),
      );
      assert.equal(token, "remote-token");
    }),
  );
});

const remoteSettings = {
  ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
  primaryBackendMode: "remote",
  remoteBackendUrl: "https://remote.example.test/",
} satisfies DesktopAppSettings.DesktopSettings;

const recoveryAuth = {
  policy: "remote-reachable",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["bearer-access-token", "browser-session-cookie"],
  sessionCookieName: "t3_session",
};

const validRecoverySession = {
  authenticated: true,
  auth: recoveryAuth,
  sessionMethod: "bearer-access-token",
  scopes: ["orchestration:read"],
  expiresAt: "2026-11-09T12:00:00.000Z",
};

function recoveryHarness(
  options: {
    catalog?: () => Option.Option<string>;
    settings?: () => DesktopAppSettings.DesktopSettings;
    environmentId?: string;
    session?: unknown;
    sessionStatus?: number;
    beforeSessionResponse?: () => void;
  } = {},
) {
  const requests: Array<{ method: string; url: string; authorization: string | undefined }> = [];
  const readCatalog = Effect.sync(options.catalog ?? (() => Option.some(encodedRemoteCatalog)));
  const catalogLayer = Layer.succeed(DesktopConnectionCatalogStore.DesktopConnectionCatalogStore, {
    get: readCatalog,
    getExisting: readCatalog,
    set: () => Effect.die("Recovery must not write credentials"),
    clear: Effect.die("Recovery must not remove credentials"),
  });
  const settingsLayer = Layer.succeed(DesktopAppSettings.DesktopAppSettings, {
    get: Effect.sync(options.settings ?? (() => remoteSettings)),
    set: () => Effect.die("Recovery must not change the primary"),
  } as unknown as DesktopAppSettings.DesktopAppSettings["Service"]);
  const httpClientLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push({
          method: request.method,
          url: request.url,
          authorization: request.headers.authorization,
        });
        const pathname = new URL(request.url).pathname;
        if (request.method !== "GET")
          throw new Error("Recovery must not create sessions or grants");
        if (pathname === "/.well-known/t3/environment") {
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              environmentId: options.environmentId ?? "remote",
              label: "Remote",
              platform: { os: "linux", arch: "x64" },
              serverVersion: "0.0.0-test",
              capabilities: { repositoryIdentity: true },
            }),
          );
        }
        if (pathname !== "/api/auth/session") throw new Error("Unexpected recovery endpoint");
        options.beforeSessionResponse?.();
        return HttpClientResponse.fromWeb(
          request,
          Response.json(options.session ?? validRecoverySession, {
            status: options.sessionStatus ?? 200,
          }),
        );
      }),
    ),
  );
  const layer = DesktopLocalEnvironmentAuth.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        DesktopBackendPool.layerTest([]),
        settingsLayer,
        catalogLayer,
        httpClientLayer,
      ),
    ),
  );
  return { layer, requests };
}

describe("saved remote primary recovery", () => {
  it.effect("validates the replacement saved bearer in two fresh desktop auth instances", () =>
    Effect.gen(function* () {
      const savedCatalog = encodedRemoteCatalog.replace("remote-token", "replacement-bearer");
      for (const _launch of [1, 2]) {
        const harness = recoveryHarness({ catalog: () => Option.some(savedCatalog) });
        yield* Effect.gen(function* () {
          const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
          assert.equal(yield* auth.getBearerToken, "replacement-bearer");
          const session = yield* auth.recoverRemotePrimarySession(remoteSettings.remoteBackendUrl);
          assert.isTrue(session.authenticated);
          assert.equal(session.sessionMethod, "bearer-access-token");
          assert.equal(harness.requests[1]?.authorization, "Bearer replacement-bearer");
          assert.deepEqual(
            harness.requests.map((request) => request.method),
            ["GET", "GET"],
          );
        }).pipe(Effect.provide(harness.layer));
      }
    }),
  );

  it.effect("reloads a newer saved bearer and validates it using only read-only requests", () => {
    let catalog = Option.some(encodedRemoteCatalog);
    const harness = recoveryHarness({ catalog: () => catalog });
    return Effect.gen(function* () {
      const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
      assert.equal(yield* auth.getBearerToken, "remote-token");
      catalog = Option.some(encodedRemoteCatalog.replace("remote-token", "new-saved-token"));
      const session = yield* auth.recoverRemotePrimarySession(remoteSettings.remoteBackendUrl);
      assert.isTrue(session.authenticated);
      assert.equal(session.sessionMethod, "bearer-access-token");
      assert.deepEqual(session.scopes, ["orchestration:read"]);
      assert.equal(yield* auth.getBearerToken, "new-saved-token");
      assert.deepEqual(harness.requests, [
        {
          method: "GET",
          url: "https://remote.example.test/.well-known/t3/environment",
          authorization: undefined,
        },
        {
          method: "GET",
          url: "https://remote.example.test/api/auth/session",
          authorization: "Bearer new-saved-token",
        },
      ]);
      assert.notProperty(session, "access_token");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("clears a stale bearer when the saved credential is absent", () => {
    let catalog = Option.some(encodedRemoteCatalog);
    const harness = recoveryHarness({ catalog: () => catalog });
    return Effect.gen(function* () {
      const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
      assert.equal(yield* auth.getBearerToken, "remote-token");
      catalog = Option.none();
      const error = yield* auth
        .recoverRemotePrimarySession(remoteSettings.remoteBackendUrl)
        .pipe(Effect.flip);
      assert.include(error.message, "No credential is saved");
      assert.isNull(yield* auth.getBearerToken);
      assert.deepEqual(harness.requests, []);
    }).pipe(Effect.provide(harness.layer));
  });

  for (const [label, catalog] of [
    [
      "missing matching profile",
      encodedRemoteCatalog.replace("https://remote.example.test", "https://other.example.test"),
    ],
    [
      "missing matching credential",
      encodedRemoteCatalog.replace(
        '"credentials":[{"connectionId":"bearer:remote","credential":{"_tag":"BearerConnectionCredential","token":"remote-token"}}]',
        '"credentials":[]',
      ),
    ],
    ["unreadable catalog", "not-json-with-private-data"],
  ] as const) {
    it.effect(`blocks a ${label} without making network requests`, () => {
      const harness = recoveryHarness({ catalog: () => Option.some(catalog) });
      return Effect.gen(function* () {
        const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
        const error = yield* auth
          .recoverRemotePrimarySession(remoteSettings.remoteBackendUrl)
          .pipe(Effect.flip);
        assert.equal(error._tag, "DesktopSavedEnvironmentRecoveryError");
        assert.notInclude(error.message, "private-data");
        assert.deepEqual(harness.requests, []);
      }).pipe(Effect.provide(harness.layer));
    });
  }

  it.effect("checks server identity before sending the saved bearer", () => {
    const harness = recoveryHarness({ environmentId: "different-server" });
    return Effect.gen(function* () {
      const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
      const error = yield* auth
        .recoverRemotePrimarySession(remoteSettings.remoteBackendUrl)
        .pipe(Effect.flip);
      assert.include(error.message, "does not match");
      assert.equal(harness.requests.length, 1);
      assert.isUndefined(harness.requests[0]?.authorization);
    }).pipe(Effect.provide(harness.layer));
  });

  for (const [label, session, sessionStatus] of [
    ["expired or revoked bearer", { authenticated: false, auth: recoveryAuth }, 200],
    [
      "cookie authentication",
      { ...validRecoverySession, sessionMethod: "browser-session-cookie" },
      200,
    ],
    [
      "HTTP rejection",
      { _tag: "EnvironmentAuthInvalidError", message: "synthetic-token-private" },
      401,
    ],
  ] as const) {
    it.effect(`keeps the gate closed after ${label}`, () => {
      const harness = recoveryHarness({ session, sessionStatus });
      return Effect.gen(function* () {
        const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
        const error = yield* auth
          .recoverRemotePrimarySession(remoteSettings.remoteBackendUrl)
          .pipe(Effect.flip);
        assert.equal(error._tag, "DesktopSavedEnvironmentRecoveryError");
        assert.notInclude(error.message, "synthetic-token-private");
        assert.notInclude(error.message, "No credential is saved");
        assert.include(
          error.message,
          sessionStatus === 200 ? "rejected the saved credential" : "could not be validated",
        );
        assert.deepEqual(
          harness.requests.map((request) => request.method),
          ["GET", "GET"],
        );
      }).pipe(Effect.provide(harness.layer));
    });
  }

  for (const [label, settings, endpoint] of [
    ["changed selected endpoint", remoteSettings, "https://other.example.test"],
    ["local primary", DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS, remoteSettings.remoteBackendUrl],
  ] as const) {
    it.effect(`blocks a ${label} without bootstrapping or changing settings`, () => {
      const harness = recoveryHarness({ settings: () => settings });
      return Effect.gen(function* () {
        const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
        const error = yield* auth.recoverRemotePrimarySession(endpoint).pipe(Effect.flip);
        assert.equal(error._tag, "DesktopSavedEnvironmentRecoveryError");
        assert.deepEqual(harness.requests, []);
      }).pipe(Effect.provide(harness.layer));
    });
  }

  it.effect("does not open the workspace if the primary changes during verification", () => {
    let settings: DesktopAppSettings.DesktopSettings = remoteSettings;
    const harness = recoveryHarness({
      settings: () => settings,
      beforeSessionResponse: () => {
        settings = { ...remoteSettings, remoteBackendUrl: "https://other.example.test" };
      },
    });
    return Effect.gen(function* () {
      const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
      const error = yield* auth
        .recoverRemotePrimarySession(remoteSettings.remoteBackendUrl)
        .pipe(Effect.flip);
      assert.include(error.message, "changed during verification");
      assert.equal(harness.requests.length, 2);
    }).pipe(Effect.provide(harness.layer));
  });
});
