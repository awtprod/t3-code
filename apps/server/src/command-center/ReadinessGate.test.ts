import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { CommandCenterNotReadyError, makeCommandCenterReadinessGate } from "./ReadinessGate.ts";

it.effect("denies external work while readiness is pending", () =>
  Effect.gen(function* () {
    const gate = yield* makeCommandCenterReadinessGate;
    const error = yield* Effect.flip(gate.requireReady);

    assert.instanceOf(error, CommandCenterNotReadyError);
    assert.equal(error.state, "pending");
  }),
);

it.effect("opens only after startup succeeds and cannot reopen after failure", () =>
  Effect.gen(function* () {
    const ready = yield* makeCommandCenterReadinessGate;
    yield* ready.markReady;
    yield* ready.requireReady;
    assert.equal(yield* ready.state, "ready");

    const failed = yield* makeCommandCenterReadinessGate;
    yield* failed.markFailed;
    yield* failed.markReady;
    const error = yield* Effect.flip(failed.requireReady);

    assert.equal(error.state, "failed");
    assert.equal(yield* failed.state, "failed");
  }),
);
