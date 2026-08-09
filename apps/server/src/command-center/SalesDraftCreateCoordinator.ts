import * as Effect from "effect/Effect";
import * as PartitionedSemaphore from "effect/PartitionedSemaphore";

const createLocks = PartitionedSemaphore.makeUnsafe<string>({ permits: 1 });

export const withSalesDraftCreateLock = <A, E, R>(
  input: { readonly spaceId: string; readonly requestId: string },
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  createLocks.withPermit(`${input.spaceId}\u0000${input.requestId}`)(effect);
