import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  OrchestrationReactor,
  type OrchestrationReactorShape,
} from "../Services/OrchestrationReactor.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import { SandboxLifecycleReactor } from "../Services/SandboxLifecycleReactor.ts";
import { SandboxSettleCleanupReactor } from "../Services/SandboxSettleCleanupReactor.ts";
import * as AgentAwarenessRelay from "../../relay/AgentAwarenessRelay.ts";

export const makeOrchestrationReactor = Effect.gen(function* () {
  const providerRuntimeIngestion = yield* ProviderRuntimeIngestionService;
  const providerCommandReactor = yield* ProviderCommandReactor;
  const checkpointReactor = yield* CheckpointReactor;
  const threadDeletionReactor = yield* ThreadDeletionReactor;
  const sandboxLifecycleReactor = yield* SandboxLifecycleReactor;
  const sandboxSettleCleanupReactor = yield* SandboxSettleCleanupReactor;
  const agentAwarenessRelay = yield* AgentAwarenessRelay.AgentAwarenessRelay;

  const start: OrchestrationReactorShape["start"] = Effect.fn("start")(function* () {
    yield* providerRuntimeIngestion.start();
    yield* providerCommandReactor.start();
    yield* checkpointReactor.start();
    yield* threadDeletionReactor.start();
    yield* sandboxLifecycleReactor.start();
    yield* sandboxSettleCleanupReactor.start();
    yield* agentAwarenessRelay.start();
  });

  const drain: OrchestrationReactorShape["drain"] = Effect.gen(function* () {
    yield* providerRuntimeIngestion.drain;
    yield* providerCommandReactor.drain;
    yield* checkpointReactor.drain;
    yield* threadDeletionReactor.drain;
    yield* sandboxLifecycleReactor.drain;
    yield* sandboxSettleCleanupReactor.drain;
  });

  return {
    start,
    drain,
    reconcileOrphanedTurns: providerRuntimeIngestion.reconcileOrphanedTurns,
  } satisfies OrchestrationReactorShape;
});

export const OrchestrationReactorLive = Layer.effect(
  OrchestrationReactor,
  makeOrchestrationReactor,
);
