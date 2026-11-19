import type {
  SourceControlDriver,
  SourceControlDriverInstance,
} from "@t3tools/source-control-core/server/driver";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as GitHubRequestPolicy from "@t3tools/source-control-github/server/GitHubRequestPolicy";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as GitHubProfileAuth from "./GitHubProfileAuth.ts";
import * as ServerSourceControlHost from "./ServerSourceControlHost.ts";
import { BUILT_IN_SOURCE_CONTROL_DRIVER_LIST } from "./sourceControlDefinitions.ts";

export interface SourceControlDriverEntry {
  readonly driver: Pick<SourceControlDriver, "kind" | "definition">;
  readonly instance: SourceControlDriverInstance;
}

/** Every driver's instance, in registry order. Everything that reads a host reads it here. */
export class SourceControlDrivers extends Context.Service<
  SourceControlDrivers,
  ReadonlyArray<SourceControlDriverEntry>
>()("@awtprod/command-center/sourceControl/builtInDrivers/SourceControlDrivers") {}

const make = Effect.gen(function* () {
  const profiles = yield* GitHubProfileAuth.GitHubProfileAuth;
  return yield* Effect.forEach(BUILT_IN_SOURCE_CONTROL_DRIVER_LIST, (driver) =>
    driver.make.pipe(
      Effect.provideService(GitHubRequestPolicy.BranchLookupCredential, ({ host, owner, name }) =>
        GitHubProfileAuth.forRepository({ host, repository: `${owner}/${name}` }).pipe(
          Effect.provideService(GitHubProfileAuth.GitHubProfileAuth, profiles),
        ),
      ),
      Effect.map((instance) => ({ driver, instance })),
    ),
  );
});

export const layer = Layer.effect(SourceControlDrivers, make).pipe(
  Layer.provideMerge(ServerSourceControlHost.layer),
  Layer.provideMerge(SourceControlRateLimit.layer),
  Layer.provide(GitHubProfileAuth.layer),
);
