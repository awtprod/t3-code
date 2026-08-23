/**
 * Test helper for provisioning a sandbox the way production does.
 *
 * `SandboxRuntimeManagerShape.provision` takes the attempt token
 * `authorizeProvision` issued, and is admitted only while that token is still
 * the thread's current authorization. Every production entry point therefore
 * authorizes immediately before provisioning; a test that hand-rolled the pair
 * would be re-deriving that contract in every fixture, and one that skipped it
 * would be testing an admission path no caller uses.
 *
 * Tests about the admission rule itself -- a stale attempt, an attempt a stop
 * superseded -- call `authorizeProvision` and `provision` separately on
 * purpose, so they can keep the token and decide when to use it.
 *
 * @module sandbox/testUtils/authorizedProvision
 */
import type { SandboxRuntimeManagerShape } from "../SandboxRuntimeManager.ts";
import * as Effect from "effect/Effect";

export const provisionAuthorized = (
  manager: SandboxRuntimeManagerShape,
  input: Omit<Parameters<SandboxRuntimeManagerShape["provision"]>[0], "attempt">,
) =>
  Effect.gen(function* () {
    const attempt = yield* manager.authorizeProvision(input.bootstrap.threadId);
    return yield* manager.provision({ ...input, attempt });
  });
