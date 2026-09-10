import { CommandId, IsoDateTime, MessageId, NonNegativeInt, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ReserveProviderRestartRecoveryInput = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  originalRequestSequence: NonNegativeInt,
  reservedAt: IsoDateTime,
});
export type ReserveProviderRestartRecoveryInput = typeof ReserveProviderRestartRecoveryInput.Type;

export const CompleteProviderRestartRecoveryInput = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  originalRequestSequence: NonNegativeInt,
  replacementRequestSequence: NonNegativeInt,
  dispatchedAt: IsoDateTime,
});
export type CompleteProviderRestartRecoveryInput = typeof CompleteProviderRestartRecoveryInput.Type;

export interface ProviderRestartRecoveryReservation {
  readonly attempt: number;
  readonly commandId: CommandId;
  readonly reservedAt: string;
}

export type ProviderRestartRecoveryReservationOutcome =
  | { readonly _tag: "reserved"; readonly reservation: ProviderRestartRecoveryReservation }
  | { readonly _tag: "ineligible" };

export interface ProviderRestartRecoveryRepositoryShape {
  /**
   * Atomically reserve one bounded restart recovery for an exact pending request.
   * A repeated call for the same request returns the same command identity.
   */
  readonly reserve: (
    input: ReserveProviderRestartRecoveryInput,
  ) => Effect.Effect<ProviderRestartRecoveryReservationOutcome, ProjectionRepositoryError>;

  /** Records the durable turn-start event created by the reserved command. */
  readonly complete: (
    input: CompleteProviderRestartRecoveryInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProviderRestartRecoveryRepository extends Context.Service<
  ProviderRestartRecoveryRepository,
  ProviderRestartRecoveryRepositoryShape
>()(
  "@awtprod/command-center/persistence/Services/ProviderRestartRecovery/ProviderRestartRecoveryRepository",
) {}
