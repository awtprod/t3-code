import { Connection } from "@command-center/core";
import { CommandCenterConnectionRefreshInput } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { refreshCommandCenterConnection } from "./ConnectionRefresh.ts";
import { GoogleReadConnectorError } from "./GoogleReadConnector.ts";

const decodeConnection = Schema.decodeUnknownSync(Connection);
const decodeInput = Schema.decodeUnknownSync(CommandCenterConnectionRefreshInput);

const input = decodeInput({
  spaceId: "example-personal",
  connectionId: "google-primary",
});

const configured = decodeConnection({
  id: input.connectionId,
  spaceId: input.spaceId,
  kind: "google",
  label: "Example account",
  capabilities: ["cc.connections.google.read"],
  health: "disconnected",
});

it.effect("refreshes only the exact configured connection and returns no credentials", () => {
  let connection = configured;
  let verifyCalls = 0;
  return Effect.gen(function* () {
    const result = yield* refreshCommandCenterConnection(
      {
        queryConnections: ({ spaceId }) =>
          Effect.succeed({
            connections: connection.spaceId === spaceId ? [connection] : [],
          }),
        verifyGoogle: (selection) => {
          verifyCalls += 1;
          connection = decodeConnection({
            ...connection,
            health: "connected",
            lastCheckedAt: "2026-01-02T00:00:00.000Z",
          });
          return Effect.succeed(selection).pipe(Effect.asVoid);
        },
      },
      input,
    );

    expect(result).toEqual({ connection, verified: true });
    expect(result.connection).not.toHaveProperty("credentials");
    expect(
      yield* refreshCommandCenterConnection(
        {
          queryConnections: ({ spaceId }) =>
            Effect.succeed({
              connections: connection.spaceId === spaceId ? [connection] : [],
            }),
          verifyGoogle: (selection) => {
            verifyCalls += 1;
            return Effect.succeed(selection).pipe(Effect.asVoid);
          },
        },
        input,
      ),
    ).toEqual(result);
    expect(verifyCalls).toBe(2);
  });
});

it.effect("denies a cross-Space connection selection before verification", () => {
  let verifyCalls = 0;
  return Effect.gen(function* () {
    const error = yield* refreshCommandCenterConnection(
      {
        queryConnections: ({ spaceId }) =>
          Effect.succeed({ connections: configured.spaceId === spaceId ? [configured] : [] }),
        verifyGoogle: () => {
          verifyCalls += 1;
          return Effect.void;
        },
      },
      decodeInput({ ...input, spaceId: "example-other" }),
    ).pipe(Effect.flip);

    expect(error.reason).toBe("not_found");
    expect(verifyCalls).toBe(0);
  });
});

it.effect("returns the persisted degraded health on a verifier failure", () => {
  let connection = configured;
  return Effect.gen(function* () {
    const result = yield* refreshCommandCenterConnection(
      {
        queryConnections: () => Effect.succeed({ connections: [connection] }),
        verifyGoogle: () => {
          connection = decodeConnection({
            ...connection,
            health: "degraded",
            lastCheckedAt: "2026-01-02T00:00:00.000Z",
          });
          return Effect.fail(
            new GoogleReadConnectorError({
              reason: "version",
              message: "The pinned connector version is unavailable.",
            }),
          );
        },
      },
      input,
    );

    expect(result).toMatchObject({
      verified: false,
      message: "The pinned Google connector version is unavailable.",
      connection: { health: "degraded" },
    });
  });
});
