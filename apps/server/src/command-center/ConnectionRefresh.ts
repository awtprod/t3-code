import type { Connection as ConnectionType } from "@command-center/core";
import {
  CommandCenterError,
  type CommandCenterConnectionRefreshInput,
  type CommandCenterConnectionRefreshResult,
  type CommandCenterConnectionsQueryInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { GoogleReadConnectorError } from "./GoogleReadConnector.ts";
import { hasAnyGoogleReadCapability } from "./GoogleCapabilities.ts";

const publicVerificationMessage = (cause: GoogleReadConnectorError): string => {
  switch (cause.reason) {
    case "configuration":
      return "The Google connection is not available in this Space.";
    case "version":
      return "The pinned Google connector version is unavailable.";
    case "process":
    case "output":
      return "The read-only Google connection could not be verified.";
  }
};

export interface ConnectionRefreshDependencies {
  readonly queryConnections: (
    input: CommandCenterConnectionsQueryInput,
  ) => Effect.Effect<{ readonly connections: ReadonlyArray<ConnectionType> }, CommandCenterError>;
  readonly verifyGoogle: (input: {
    readonly spaceId: CommandCenterConnectionRefreshInput["spaceId"];
    readonly connectionId: CommandCenterConnectionRefreshInput["connectionId"];
  }) => Effect.Effect<void, GoogleReadConnectorError>;
}

const findExactConnection = Effect.fn("ConnectionRefresh.findExactConnection")(function* (
  deps: ConnectionRefreshDependencies,
  input: CommandCenterConnectionRefreshInput,
) {
  const { connections } = yield* deps.queryConnections({ spaceId: input.spaceId });
  const connection = connections.find(
    (candidate) => candidate.id === input.connectionId && candidate.spaceId === input.spaceId,
  );
  if (connection === undefined) {
    return yield* new CommandCenterError({
      reason: "not_found",
      message: "The connection was not found in the requested Space.",
    });
  }
  return connection;
});

/**
 * Refresh only non-secret connection health. The account selection remains
 * server-bound, and connector errors are returned as a health result so the
 * client can render the newly persisted degraded/disconnected projection.
 */
export const refreshCommandCenterConnection = Effect.fn(
  "ConnectionRefresh.refreshCommandCenterConnection",
)(function* (
  deps: ConnectionRefreshDependencies,
  input: CommandCenterConnectionRefreshInput,
): Effect.fn.Return<CommandCenterConnectionRefreshResult, CommandCenterError> {
  const configured = yield* findExactConnection(deps, input);
  if (configured.kind !== "google" || !hasAnyGoogleReadCapability(configured.capabilities)) {
    return yield* new CommandCenterError({
      reason: "validation",
      message: "This connection does not support read-only Google verification.",
    });
  }

  const verification = yield* deps
    .verifyGoogle({ spaceId: input.spaceId, connectionId: input.connectionId })
    .pipe(
      Effect.as({ verified: true as const }),
      Effect.catch((cause) =>
        Effect.succeed({
          verified: false as const,
          message: publicVerificationMessage(cause),
        }),
      ),
    );
  const connection = yield* findExactConnection(deps, input);
  return { connection, ...verification };
});
