import type {
  ProviderDriverKind,
  ProviderInstanceId,
  ProjectId,
  ThreadId,
  TurnId,
  TurnUsageRecord,
  UsageQueryInput,
  UsageQueryResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export interface RecordTurnUsageInput {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly projectId: ProjectId | null;
  readonly providerInstanceId: ProviderInstanceId;
  readonly provider: ProviderDriverKind;
  readonly usage: TurnUsageRecord;
}

export interface ProjectionTurnUsageRepositoryShape {
  readonly record: (input: RecordTurnUsageInput) => Effect.Effect<void, ProjectionRepositoryError>;
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
