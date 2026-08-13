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
