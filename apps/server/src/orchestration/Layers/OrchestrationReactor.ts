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
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { SandboxLifecycleReactor } from "../Services/SandboxLifecycleReactor.ts";
import { SandboxSettleCleanupReactor } from "../Services/SandboxSettleCleanupReactor.ts";
import * as ThreadSettlementReactor from "../ThreadSettlementReactor.ts";
import * as AgentAwarenessRelay from "../../relay/AgentAwarenessRelay.ts";

export const makeOrchestrationReactor = Effect.gen(function* () {
  const providerRuntimeIngestion = yield* ProviderRuntimeIngestionService;
  const providerCommandReactor = yield* ProviderCommandReactor;
  const checkpointReactor = yield* CheckpointReactor;
  const threadDeletionReactor = yield* ThreadDeletionReactor;
  const engine = yield* OrchestrationEngineService;
  const sandboxLifecycleReactor = yield* SandboxLifecycleReactor;
  const sandboxSettleCleanupReactor = yield* SandboxSettleCleanupReactor;
  const threadSettlementReactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
  const agentAwarenessRelay = yield* AgentAwarenessRelay.AgentAwarenessRelay;

  const start: OrchestrationReactorShape["start"] = Effect.fn("start")(function* () {
    yield* providerRuntimeIngestion.start();
    yield* providerCommandReactor.start();
    yield* checkpointReactor.start();
    yield* threadDeletionReactor.start();
    yield* sandboxLifecycleReactor.start();
    yield* sandboxSettleCleanupReactor.start();
    yield* threadSettlementReactor.start();
    yield* agentAwarenessRelay.start();
  });

  const drain: OrchestrationReactorShape["drain"] = Effect.gen(function* () {
    yield* providerRuntimeIngestion.drain;
    yield* providerCommandReactor.drain;
    yield* checkpointReactor.drain;
    // Upstream replaced this reactor's unconditional drain with a
    // sequence-targeted one. The aggregate drain means "everything appended so
    // far has been handled", so the target is the log's head at call time.
    yield* threadDeletionReactor.drainThrough(yield* engine.latestSequence);
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
