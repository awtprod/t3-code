import type { UsageQueryInput, UsageQueryResult } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

/** Command Center usage analytics, read from orchestration v2 provider turns. */
export interface ProjectionTurnUsageRepositoryShape {
  readonly query: (
    input: UsageQueryInput,
  ) => Effect.Effect<UsageQueryResult, ProjectionRepositoryError>;
}

export class ProjectionTurnUsageRepository extends Context.Service<
  ProjectionTurnUsageRepository,
  ProjectionTurnUsageRepositoryShape
>()(
  "@awtprod/command-center/persistence/Services/ProjectionTurnUsage/ProjectionTurnUsageRepository",
) {}
