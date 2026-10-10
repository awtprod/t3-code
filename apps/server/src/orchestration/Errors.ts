import { ThreadId } from "@t3tools/contracts";
import * as SchemaIssue from "effect/SchemaIssue";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../persistence/Errors.ts";

/**
 * The `detail` the engine uses when a decider accepted a command but produced
 * no events.
 *
 * `OrchestrationCommandInvariantError` is raised for both benign and genuine
 * outcomes, so callers that want to treat "there was nothing to do" as success
 * cannot key off the tag alone — they would also swallow real failures that
 * share it. Matching this exact detail is how they tell the two apart, which
 * only works if the raise site and the match site agree; hence one constant
 * rather than two string literals.
 */
export const COMMAND_PRODUCED_NO_EVENTS_DETAIL = "Command produced no events.";

export class OrchestrationCommandInvariantError extends Schema.TaggedError<OrchestrationCommandInvariantError>()(
  "OrchestrationCommandInvariantError",
  {
    commandType: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Orchestration command invariant failed (${this.commandType}): ${this.detail}`;
  }
}

export class OrchestrationThreadSettleBlockedError extends Schema.TaggedError<OrchestrationThreadSettleBlockedError>()(
  "OrchestrationThreadSettleBlockedError",
  {
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return "This thread still needs attention. Resolve or interrupt it first, then try again.";
  }
}

export const OrchestrationCommandRejection = Schema.Union([
  OrchestrationCommandInvariantError,
  OrchestrationThreadSettleBlockedError,
]);
export type OrchestrationCommandRejection = typeof OrchestrationCommandRejection.Type;
export const isOrchestrationCommandRejection = Schema.is(OrchestrationCommandRejection);

export class OrchestrationCommandPreviouslyRejectedError extends Schema.TaggedError<OrchestrationCommandPreviouslyRejectedError>()(
  "OrchestrationCommandPreviouslyRejectedError",
  {
    commandId: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Command previously rejected (${this.commandId}): ${this.detail}`;
  }
}

export class OrchestrationCommandIdConflictError extends Schema.TaggedError<OrchestrationCommandIdConflictError>()(
  "OrchestrationCommandIdConflictError",
  {
    commandId: Schema.String,
    receiptAggregateKind: Schema.String,
    receiptAggregateId: Schema.String,
    commandAggregateKind: Schema.String,
    commandAggregateId: Schema.String,
  },
) {
  override get message(): string {
    return `Command id '${this.commandId}' already used for ${this.receiptAggregateKind} '${this.receiptAggregateId}'; refusing to replay its receipt for ${this.commandAggregateKind} '${this.commandAggregateId}'.`;
  }
}

export class OrchestrationProjectorDecodeError extends Schema.TaggedError<OrchestrationProjectorDecodeError>()(
  "OrchestrationProjectorDecodeError",
  {
    eventType: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Projector decode failed for ${this.eventType}: ${this.issue}`;
  }
}

export type OrchestrationDispatchError =
  | ProjectionRepositoryError
  | OrchestrationCommandRejection
  | OrchestrationCommandIdConflictError
  | OrchestrationCommandPreviouslyRejectedError
  | OrchestrationProjectorDecodeError;

export function toProjectorDecodeError(eventType: string) {
  return (error: Schema.SchemaError): OrchestrationProjectorDecodeError =>
    new OrchestrationProjectorDecodeError({
      eventType,
      issue: SchemaIssue.makeFormatterDefault()(error.issue),
      cause: error,
    });
}
