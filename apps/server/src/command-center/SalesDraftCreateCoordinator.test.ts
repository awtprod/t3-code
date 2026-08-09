import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { withSalesDraftCreateLock } from "./SalesDraftCreateCoordinator.ts";

it.effect("serializes Gmail draft side effects for the same approved request", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const firstStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const secondStarted = yield* Deferred.make<void>();
      const key = { spaceId: "sales-space", requestId: "draft-request" };

      const first = yield* Effect.forkChild(
        withSalesDraftCreateLock(
          key,
          Deferred.succeed(firstStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseFirst)),
          ),
        ),
      );
      yield* Deferred.await(firstStarted);

      const second = yield* Effect.forkChild(
        withSalesDraftCreateLock(key, Deferred.succeed(secondStarted, undefined)),
      );
      expect(yield* Deferred.isDone(secondStarted)).toBe(false);

      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect(yield* Deferred.isDone(secondStarted)).toBe(true);
    }),
  ),
);
