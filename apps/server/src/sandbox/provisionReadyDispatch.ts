import type { ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

/**
 * Dispatch a `sandbox.provision.ready` and tear the sandbox down if the
 * decider refuses it.
 *
 * The decider accepts readiness only from a `provisioning` lifecycle. Every
 * other state rejects it -- and the state that matters is `stopping`/`deleted`,
 * reached by a stop that landed between the reactor's `sandbox.provision`
 * dispatch and the runtime manager actually building anything. The provision
 * still ran to completion, the rejection was the only signal that it should not
 * have, and no caller acted on it: the container, its sidecars, its network,
 * and its volumes stayed up with nothing left holding a reference to them --
 * not even reconcile, which counts a terminal thread's containers as orphans
 * only after it next runs, and never at all while the record names a thread the
 * projection has already accounted for as gone.
 *
 * So a refused readiness is treated as a failed provision: whatever was just
 * created is destroyed, and the original dispatch error is re-raised so the
 * caller's own failure handling still runs. The teardown's own failure is
 * logged rather than propagated -- it must not replace the error that says why
 * the thread is not ready.
 *
 * `teardown` must name the PROVISION ATTEMPT whose readiness was refused, not
 * the thread -- `SandboxRuntimeManagerShape.stopProvisionAttempt` is what
 * callers pass. A refused readiness means a stop landed mid-provision, and a
 * stop is exactly what a re-provision follows: a teardown that destroyed
 * "whatever this thread has now" would destroy the container the NEXT attempt
 * had already published and accepted, leaving the projection reporting `ready`
 * over a sandbox that no longer exists.
 *
 * Interruption is deliberately excluded: a shutdown leaves the containers for
 * the next reconcile pass to adopt or reap, and tearing them down here would
 * destroy a live thread's workspace volume on every server restart.
 */
export const dispatchProvisionReadyOrTearDown = <A, E, R, E2, R2>(input: {
  readonly threadId: ThreadId;
  readonly dispatch: Effect.Effect<A, E, R>;
  /**
   * Tears down the sandbox THIS attempt published, and nothing else. A thunk,
   * so the accepted path -- which is every provision that is not racing a stop
   * -- never builds it at all.
   */
  readonly teardown: () => Effect.Effect<unknown, E2, R2>;
}): Effect.Effect<A, E, R | R2> =>
  input.dispatch.pipe(
    Effect.onError((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : Effect.gen(function* () {
            yield* Effect.logWarning(
              "sandbox readiness was refused; tearing down the sandbox it would have published",
              { threadId: input.threadId, cause: Cause.pretty(cause) },
            );
            yield* input
              .teardown()
              .pipe(
                Effect.catchCause((teardownCause) =>
                  Effect.logWarning(
                    "could not tear down the sandbox whose readiness was refused; its containers may survive until the next reconcile",
                    { threadId: input.threadId, cause: Cause.pretty(teardownCause) },
                  ),
                ),
              );
          }),
    ),
  );
