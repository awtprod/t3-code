/**
 * WebSocket handlers for the Command Center RPC group (`cc.*` and Instagram
 * reel procedures).
 *
 * Kept out of `ws.ts` so the core handler object stays upstream's and so the
 * two groups are implemented in separate `toLayer` calls: one handler object
 * for every procedure exceeds the TypeScript instantiation budget. Scope
 * authorization runs in `RpcScopeAuthorization` (every RPC in `WsRpcGroup`
 * carries it); this module adds the Command Center readiness gate.
 */
import {
  ProjectId as CommandCenterProjectId,
  RepositoryId as CommandCenterRepositoryId,
  RunId as CommandCenterRunId,
  SpaceId as CommandCenterSpaceId,
  type SpaceId as CommandCenterSpaceIdType,
  ThreadId as CommandCenterThreadId,
} from "@command-center/core";
import {
  COMMAND_CENTER_SPACE_AGENT_ACTIVITY_MAX_LIMIT,
  COMMAND_CENTER_WS_METHODS,
  COMMAND_CENTER_YOUTUBE_ANALYTICS_FETCH_METHOD,
  CommandCenterError,
  CommandCenterEventStreamError,
  CommandCenterResponsibilityError,
  CommandCenterSprintPlanApplyImportResult,
  CommandCenterSprintPlanGetOriginalResult,
  CommandCenterSprintPlanGetResult,
  CommandCenterSprintPlanListHistoryResult,
  CommandCenterSprintPlanListResult,
  CommandCenterSprintPlanPatchTaskResult,
  CommandCenterSprintPlanPreviewImportResult,
  CommandCenterSprintPlanResolveDateConflictResult,
  INSTAGRAM_REEL_METHODS,
  WsCommandCenterRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { InstagramPublish } from "./publish/instagram/InstagramPublish.ts";
import * as CommandCenterService from "./Service.ts";
import * as CommandCenterInbox from "./Inbox.ts";
import * as SprintPlan from "./SprintPlan.ts";
import * as CommandCenterDigest from "./Digest.ts";
import * as CommandCenterEventStream from "./EventStream.ts";
import * as Observations from "./Observations.ts";
import { refreshCommandCenterConnection } from "./ConnectionRefresh.ts";
import * as AutomationDefinitionConfig from "./AutomationDefinitionConfig.ts";
import * as AutomationRuns from "./AutomationRuns.ts";
import * as Responsibilities from "./Responsibilities.ts";
import * as AutomationTriggerCoordinator from "./automation/TriggerCoordinator.ts";
import * as AutomationScheduleInterpreter from "./automation/ScheduleInterpreter.ts";
import * as MemorySearchIndex from "./MemorySearchIndex.ts";
import * as GoogleReadConnector from "./GoogleReadConnector.ts";
import * as WindowsMediaConnector from "./WindowsMediaConnector.ts";
import * as GoogleConnectionSetup from "./GoogleConnectionSetup.ts";
import * as PublishConnections from "./publish/PublishConnections.ts";
import * as YouTubeAnalytics from "./publish/youtube/YouTubeAnalytics.ts";
import { googleCapabilityForOperation } from "./GoogleCapabilities.ts";
import * as RunDispatcher from "./RunDispatcher.ts";
import * as SpaceActivity from "./SpaceActivity.ts";
import * as SpaceAgent from "./SpaceAgent.ts";
import * as SpaceAgentWaker from "./SpaceAgentWaker.ts";
import * as ReadinessGate from "./ReadinessGate.ts";
import { commandCenterProviderAvailability } from "./ProviderAvailability.ts";
import { commandCenterRpcRequiresReadiness } from "./RpcAuthorization.ts";
import * as OrchestrationBridge from "./OrchestrationBridge.ts";

export const layerCommandCenterWsRpc = (currentSession: EnvironmentAuth.AuthenticatedSession) =>
  WsCommandCenterRpcGroup.toLayer(
    Effect.gen(function* () {
      const orchestrationBridge = yield* OrchestrationBridge.OrchestrationBridge;
      const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
      const currentSessionId = currentSession.sessionId;
      const commandCenter = yield* CommandCenterService.CommandCenterService;
      const commandCenterInbox = yield* Effect.serviceOption(CommandCenterInbox.CommandCenterInbox);
      const sprintPlan = yield* Effect.serviceOption(SprintPlan.SprintPlanService);
      const commandCenterDigest = yield* Effect.serviceOption(
        CommandCenterDigest.CommandCenterDigest,
      );
      const commandCenterEvents = yield* CommandCenterEventStream.CommandCenterEventStream;
      const spaceAgent = yield* Effect.serviceOption(SpaceAgent.SpaceAgent);
      const withSpaceAgent = <A>(
        use: (service: SpaceAgent.SpaceAgentShape) => Effect.Effect<A, CommandCenterError>,
      ): Effect.Effect<A, CommandCenterError> =>
        Option.match(spaceAgent, {
          onNone: () =>
            Effect.fail(
              new CommandCenterError({
                reason: "config",
                message: "Space agents are unavailable in this environment.",
              }),
            ),
          onSome: use,
        });
      const spaceAgentWaker = yield* Effect.serviceOption(SpaceAgentWaker.SpaceAgentWaker);
      const withSpaceAgentWaker = <A>(
        use: (
          service: SpaceAgentWaker.SpaceAgentWakerShape,
        ) => Effect.Effect<A, CommandCenterError>,
      ): Effect.Effect<A, CommandCenterError> =>
        Option.match(spaceAgentWaker, {
          onNone: () =>
            Effect.fail(
              new CommandCenterError({
                reason: "config",
                message: "Space agent wakes are unavailable in this environment.",
              }),
            ),
          onSome: use,
        });
      const spaceActivity = yield* Effect.serviceOption(SpaceActivity.SpaceActivity);
      const withSpaceActivity = <A>(
        use: (service: SpaceActivity.SpaceActivityShape) => Effect.Effect<A, CommandCenterError>,
      ): Effect.Effect<A, CommandCenterError> =>
        Option.match(spaceActivity, {
          onNone: () =>
            Effect.fail(
              new CommandCenterError({
                reason: "config",
                message: "Space activity is unavailable in this environment.",
              }),
            ),
          onSome: use,
        });
      const observations = yield* Effect.serviceOption(Observations.ObservationService);
      const youtubeAnalytics = yield* Effect.serviceOption(YouTubeAnalytics.YouTubeAnalytics);
      const observationActor = { kind: "user", id: currentSession.sessionId } as const;
      const observationError = (cause: Observations.ObservationError) =>
        new CommandCenterError({
          reason: cause.reason === "not-found" ? "not_found" : cause.reason,
          message: cause.message,
          cause,
        });
      const withObservations = <A>(
        use: (
          service: Observations.ObservationServiceShape,
        ) => Effect.Effect<A, Observations.ObservationError>,
      ) =>
        Option.match(observations, {
          onNone: () =>
            Effect.fail(
              new CommandCenterError({
                reason: "config",
                message: "Observations are unavailable in this environment.",
              }),
            ),
          onSome: (service) => use(service).pipe(Effect.mapError(observationError)),
        });
      const automationDefinitionConfig =
        yield* AutomationDefinitionConfig.AutomationDefinitionConfig;
      const automationScheduleInterpreter = yield* Effect.serviceOption(
        AutomationScheduleInterpreter.AutomationScheduleInterpreter,
      );
      const commandCenterAutomationRuns = yield* AutomationRuns.AutomationRuns;
      const commandCenterResponsibilities = yield* Effect.serviceOption(
        Responsibilities.Responsibilities,
      );
      const responsibilityUnavailable = () =>
        new Responsibilities.ResponsibilityError({
          code: "config-unavailable",
          message: "Responsibility controls are unavailable in this environment.",
        });
      const responsibilityRpcError = (cause: Responsibilities.ResponsibilityError) =>
        new CommandCenterResponsibilityError({ code: cause.code, message: cause.message });
      const responsibilityCall = <A>(
        operation: (
          service: Responsibilities.ResponsibilitiesShape,
        ) => Effect.Effect<A, Responsibilities.ResponsibilityError>,
      ) =>
        Option.match(commandCenterResponsibilities, {
          onNone: () => Effect.fail(responsibilityUnavailable()),
          onSome: operation,
        }).pipe(Effect.mapError(responsibilityRpcError));
      const commandCenterAutomationTriggers = yield* AutomationTriggerCoordinator.make;
      const commandCenterMemorySearch = yield* MemorySearchIndex.MemorySearchIndex;
      const googleReadConnector = yield* GoogleReadConnector.GoogleReadConnector;
      const windowsMediaConnector = yield* WindowsMediaConnector.WindowsMediaConnector;
      const toWindowsMediaError = (cause: WindowsMediaConnector.WindowsMediaConnectorError) =>
        new CommandCenterError({
          reason:
            cause.reason === "invalid_path" || cause.reason === "forbidden"
              ? "validation"
              : cause.reason === "not_found"
                ? "not_found"
                : cause.reason === "disabled"
                  ? "config"
                  : "connector",
          message: cause.message,
          cause,
        });
      const googleConnectionSetup = yield* Effect.serviceOption(
        GoogleConnectionSetup.GoogleConnectionSetup,
      );
      const instagramPublish = yield* Effect.serviceOption(InstagramPublish);
      const withInstagramPublish = <A>(
        use: (service: InstagramPublish["Service"]) => Effect.Effect<A, CommandCenterError>,
      ) =>
        Option.match(instagramPublish, {
          onNone: () =>
            Effect.fail(
              new CommandCenterError({
                reason: "config",
                message: "Instagram publishing is unavailable.",
              }),
            ),
          onSome: use,
        });
      const publishConnections = yield* Effect.serviceOption(PublishConnections.PublishConnections);
      const withPublishConnections = <A>(
        use: (
          service: PublishConnections.PublishConnections["Service"],
        ) => Effect.Effect<A, CommandCenterError>,
      ) =>
        Option.match(publishConnections, {
          onNone: () =>
            Effect.fail(
              new CommandCenterError({
                reason: "connector",
                message: "Publishing connections are unavailable in this environment.",
              }),
            ),
          onSome: use,
        });
      const withCommandCenterInbox = <A>(
        use: (
          service: CommandCenterInbox.CommandCenterInbox["Service"],
        ) => Effect.Effect<A, CommandCenterError>,
      ) =>
        Option.match(commandCenterInbox, {
          onNone: () =>
            Effect.fail(
              new CommandCenterError({
                reason: "config",
                message: "Command Center Inbox is unavailable in this environment.",
              }),
            ),
          onSome: use,
        });
      const withVerifiedCommandCenterInbox = <A>(
        spaceId: CommandCenterSpaceIdType | undefined,
        use: (
          service: CommandCenterInbox.CommandCenterInbox["Service"],
        ) => Effect.Effect<A, CommandCenterError>,
      ) =>
        commandCenter
          .refreshInboxSpaceProjection(spaceId)
          .pipe(Effect.andThen(withCommandCenterInbox(use)));
      const toSprintPlanError = (cause: SprintPlan.SprintPlanServiceError) =>
        new CommandCenterError({
          reason: cause.reason === "not-found" ? "not_found" : cause.reason,
          message: cause.message,
          cause,
        });
      const invalidSprintPlanOutput = (cause: unknown) =>
        new CommandCenterError({
          reason: "persistence",
          message: "Stored sprint plan data did not match the wire contract.",
          cause,
        });
      const validateSprintPlanOutput = <A>(
        operation: Effect.Effect<unknown, SprintPlan.SprintPlanServiceError>,
        decode: (value: unknown) => Effect.Effect<A, unknown>,
      ) =>
        operation.pipe(
          Effect.flatMap(decode),
          Effect.mapError((cause) =>
            Schema.is(SprintPlan.SprintPlanServiceError)(cause)
              ? cause
              : invalidSprintPlanOutput(cause),
          ),
        );
      const withVerifiedSprintPlan = <A>(
        spaceId: string,
        use: (
          service: SprintPlan.SprintPlanService["Service"],
        ) => Effect.Effect<A, SprintPlan.SprintPlanServiceError | CommandCenterError>,
      ) =>
        commandCenter.refreshInboxSpaceProjection(spaceId).pipe(
          Effect.andThen(
            Option.match(sprintPlan, {
              onNone: () =>
                Effect.fail(
                  new CommandCenterError({
                    reason: "config",
                    message: "Sprint plans are unavailable in this environment.",
                  }),
                ),
              onSome: use,
            }),
          ),
          Effect.catchTags({
            SprintPlanServiceError: (cause) => Effect.fail(toSprintPlanError(cause)),
          }),
        );
      const sprintPlanActor: SprintPlan.SprintPlanActor = {
        id: currentSession.subject,
        kind: "user",
      };
      const withVerifiedCommandCenterDigest = <A>(
        use: (
          service: CommandCenterDigest.CommandCenterDigest["Service"],
          configTimezone: string | null,
        ) => Effect.Effect<A, CommandCenterError>,
      ) =>
        commandCenter.refreshInboxSpaceProjection(undefined).pipe(
          Effect.andThen(commandCenter.bootstrap),
          Effect.flatMap((snapshot) =>
            Option.match(commandCenterDigest, {
              onNone: () =>
                Effect.fail(
                  new CommandCenterError({
                    reason: "config",
                    message: "Command Center Digest is unavailable in this environment.",
                  }),
                ),
              onSome: (service) => use(service, snapshot.timezone ?? null),
            }),
          ),
        );
      const commandCenterReadiness = yield* ReadinessGate.CommandCenterReadinessGate;
      const refreshCommandCenterSpaceProjection = (spaceId?: CommandCenterSpaceIdType) =>
        commandCenter.querySpaces(spaceId === undefined ? {} : { spaceId }).pipe(
          Effect.asVoid,
          Effect.mapError(
            (cause) =>
              new CommandCenterEventStreamError({
                reason: "query",
                message: "Private configuration could not be verified for this event query.",
                cause,
              }),
          ),
        );
      const commandCenterUnavailable = (method: string) =>
        method === COMMAND_CENTER_WS_METHODS.eventsReplay ||
        method === COMMAND_CENTER_WS_METHODS.eventsSubscribe ||
        method === COMMAND_CENTER_WS_METHODS.timelineQuery
          ? new CommandCenterEventStreamError({
              reason: "query",
              message: "Command Center is temporarily unavailable.",
            })
          : new CommandCenterError({
              reason: "config",
              message: "Command Center is temporarily unavailable.",
            });
      const gateCommandCenterEffect = <A, E, R>(
        method: string,
        effect: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E, R> =>
        commandCenterRpcRequiresReadiness(method)
          ? commandCenterReadiness.requireReady.pipe(
              Effect.mapError(() => commandCenterUnavailable(method) as E),
              Effect.andThen(effect),
            )
          : effect;
      const gateCommandCenterStream = <A, E, R>(
        method: string,
        stream: Stream.Stream<A, E, R>,
      ): Stream.Stream<A, E, R> =>
        commandCenterRpcRequiresReadiness(method)
          ? Stream.unwrap(
              commandCenterReadiness.requireReady.pipe(
                Effect.mapError(() => commandCenterUnavailable(method) as E),
                Effect.as(stream),
              ),
            )
          : stream;
      const observeRpcEffect = <A, E, R>(
        method: string,
        effect: Effect.Effect<A, E, R>,
        traceAttributes?: Readonly<Record<string, unknown>>,
      ) =>
        Effect.annotateCurrentSpan(traceAttributes ?? {}).pipe(
          Effect.andThen(gateCommandCenterEffect(method, effect)),
        );
      const observeRpcStream = <A, E, R>(
        method: string,
        stream: Stream.Stream<A, E, R>,
        _traceAttributes?: Readonly<Record<string, unknown>>,
      ) => gateCommandCenterStream(method, stream);
      const observeRpcStreamEffect = <A, StreamError, StreamContext, EffectError, EffectContext>(
        method: string,
        effect: Effect.Effect<
          Stream.Stream<A, StreamError, StreamContext>,
          EffectError,
          EffectContext
        >,
        traceAttributes?: Readonly<Record<string, unknown>>,
      ) => observeRpcEffect(method, effect, traceAttributes);
      const dispatchCommandCenterRun = (runId: CommandCenterRunId) =>
        RunDispatcher.dispatchActiveRun({
          runId,
          dispatchCommand: orchestrationBridge.dispatchCommand,
        }).pipe(
          Effect.mapError(
            (cause) =>
              new CommandCenterError({
                reason:
                  cause.reason === "not-found"
                    ? "not_found"
                    : cause.reason === "persistence-failed"
                      ? "persistence"
                      : "routing",
                message: cause.message,
                cause,
              }),
          ),
        );

      const commandCenterHandlers = WsCommandCenterRpcGroup.of({
        [COMMAND_CENTER_WS_METHODS.bootstrap]: (_input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.bootstrap,
            Effect.all({
              snapshot: commandCenter.bootstrap,
              authoringHealth: automationDefinitionConfig.authoringHealth,
            }).pipe(
              Effect.map(({ snapshot, authoringHealth }) => ({
                ...snapshot,
                authoringHealth,
              })),
            ),
            {
              "rpc.aggregate": "command-center",
            },
          ),
        [COMMAND_CENTER_WS_METHODS.commandSubmit]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.commandSubmit,
            providerRegistry.getProviders.pipe(
              Effect.map(commandCenterProviderAvailability),
              Effect.flatMap((providers) => commandCenter.submitCommand(input, providers)),
            ),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.runStart]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.runStart,
            commandCenter.authorizeRunExecution({ runId: input.runId, actorKind: "user" }).pipe(
              Effect.andThen(dispatchCommandCenterRun(input.runId)),
              Effect.map((dispatched) => ({
                runId: dispatched.runId,
                projectId: CommandCenterProjectId.make(dispatched.projectId),
                threadId: CommandCenterThreadId.make(dispatched.threadId),
                status: dispatched.state,
                duplicate: dispatched.duplicate,
              })),
            ),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.spaceAgentList]: (_input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.spaceAgentList,
            withSpaceAgent((service) => service.list).pipe(Effect.map((agents) => ({ agents }))),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.spaceAgentWake]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.spaceAgentWake,
            withSpaceAgentWaker((service) =>
              service.deliverWake(input.spaceId, { kind: "manual" }),
            ).pipe(Effect.map(({ threadId }) => ({ spaceId: input.spaceId, threadId }))),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.spaceAgentSetPaused]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.spaceAgentSetPaused,
            withSpaceAgentWaker((service) => service.setPaused(input.spaceId, input.paused)).pipe(
              Effect.map(({ paused }) => ({ spaceId: input.spaceId, paused })),
            ),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.spaceAgentActivity]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.spaceAgentActivity,
            withSpaceActivity((service) =>
              service.recent({
                spaceId: input.spaceId,
                ...(input.limit === undefined ? {} : { limit: input.limit }),
                maxLimit: COMMAND_CENTER_SPACE_AGENT_ACTIVITY_MAX_LIMIT,
              }),
            ).pipe(Effect.map((entries) => ({ spaceId: input.spaceId, entries }))),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.eventsReplay]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.eventsReplay,
            refreshCommandCenterSpaceProjection(input.spaceId).pipe(
              Effect.andThen(commandCenterEvents.replay(input)),
            ),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.eventsSubscribe]: (input) =>
          observeRpcStream(
            COMMAND_CENTER_WS_METHODS.eventsSubscribe,
            Stream.unwrap(
              refreshCommandCenterSpaceProjection(input.spaceId).pipe(
                Effect.as(commandCenterEvents.changes(input)),
              ),
            ),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.timelineQuery]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.timelineQuery,
            refreshCommandCenterSpaceProjection(input.spaceId).pipe(
              Effect.andThen(commandCenterEvents.timeline(input)),
            ),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.spacesQuery]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.spacesQuery,
            commandCenter.querySpaces(input),
            {
              "rpc.aggregate": "command-center",
            },
          ),
        [COMMAND_CENTER_WS_METHODS.spacesSync]: (_input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.spacesSync,
            commandCenter.syncConfiguration({ force: true }).pipe(
              Effect.andThen(commandCenter.bootstrap),
              Effect.map((snapshot) => ({
                timezone: snapshot.timezone,
                spaces: snapshot.spaces,
                automations: snapshot.automations,
                connections: snapshot.connections,
                configHealth: snapshot.configHealth,
              })),
            ),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.itemsQuery]: (input) =>
          observeRpcEffect(COMMAND_CENTER_WS_METHODS.itemsQuery, commandCenter.queryItems(input), {
            "rpc.aggregate": "command-center",
          }),
        [COMMAND_CENTER_WS_METHODS.inboxQuery]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.inboxQuery,
            withVerifiedCommandCenterInbox(input.spaceId, (inbox) => inbox.query(input)),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.digestQuery]: (_input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.digestQuery,
            withVerifiedCommandCenterDigest((digest, configTimezone) =>
              digest.query({ recipientSubject: currentSession.subject, configTimezone }),
            ),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.digestPreferencesUpdate]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.digestPreferencesUpdate,
            withVerifiedCommandCenterDigest((digest, configTimezone) =>
              digest.updatePreferences({
                recipientSubject: currentSession.subject,
                configTimezone,
                preferences: input,
              }),
            ),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.digestMarkViewed]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.digestMarkViewed,
            withVerifiedCommandCenterDigest((digest) =>
              digest.markViewed({
                recipientSubject: currentSession.subject,
                snapshotId: input.snapshotId,
              }),
            ),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.inboxDetail]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.inboxDetail,
            withVerifiedCommandCenterInbox(input.spaceId, (inbox) => inbox.detail(input)),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.inboxComment]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.inboxComment,
            withVerifiedCommandCenterInbox(input.spaceId, (inbox) =>
              inbox.comment(input, { subject: currentSession.subject }),
            ),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.inboxRequestChanges]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.inboxRequestChanges,
            withVerifiedCommandCenterInbox(input.spaceId, (inbox) =>
              inbox.requestChanges(input, { subject: currentSession.subject }),
            ),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.inboxCandidateCreate]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.inboxCandidateCreate,
            withVerifiedCommandCenterInbox(input.spaceId, (inbox) =>
              inbox.createCandidate(
                { ...input, source: "direct" },
                { subject: currentSession.subject },
              ),
            ),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.inboxCandidateAccept]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.inboxCandidateAccept,
            withVerifiedCommandCenterInbox(input.spaceId, (inbox) =>
              inbox.acceptCandidate(input, { subject: currentSession.subject }),
            ),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.inboxAdjustmentApprove]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.inboxAdjustmentApprove,
            withVerifiedCommandCenterInbox(input.spaceId, (inbox) =>
              inbox.approveAdjustment(input, { subject: currentSession.subject }),
            ),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.inboxCandidateDiscard]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.inboxCandidateDiscard,
            withVerifiedCommandCenterInbox(input.spaceId, (inbox) =>
              inbox.discardCandidate(input, { subject: currentSession.subject }),
            ),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.inboxChangeRequestResolve]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.inboxChangeRequestResolve,
            withVerifiedCommandCenterInbox(input.spaceId, (inbox) =>
              inbox.resolveChangeRequest(input, { subject: currentSession.subject }),
            ),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.inboxSnooze]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.inboxSnooze,
            withVerifiedCommandCenterInbox(input.spaceId, (inbox) =>
              inbox.snooze(input, { subject: currentSession.subject }),
            ),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.inboxUnsnooze]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.inboxUnsnooze,
            withVerifiedCommandCenterInbox(input.spaceId, (inbox) =>
              inbox.unsnooze(input, { subject: currentSession.subject }),
            ),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.inboxDismiss]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.inboxDismiss,
            withVerifiedCommandCenterInbox(input.spaceId, (inbox) =>
              inbox.dismiss(input, { subject: currentSession.subject }),
            ),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.inboxReopen]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.inboxReopen,
            withVerifiedCommandCenterInbox(input.spaceId, (inbox) =>
              inbox.reopen(input, { subject: currentSession.subject }),
            ),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.sprintPlanList]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.sprintPlanList,
            withVerifiedSprintPlan(input.spaceId, (service) =>
              validateSprintPlanOutput(
                service.list(input),
                Schema.decodeUnknownEffect(CommandCenterSprintPlanListResult),
              ),
            ),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.sprintPlanPreviewImport]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.sprintPlanPreviewImport,
            withVerifiedSprintPlan(input.spaceId, (service) =>
              validateSprintPlanOutput(
                service.previewImport(input),
                Schema.decodeUnknownEffect(CommandCenterSprintPlanPreviewImportResult),
              ),
            ),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.sprintPlanApplyImport]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.sprintPlanApplyImport,
            withVerifiedSprintPlan(input.spaceId, (service) =>
              validateSprintPlanOutput(
                service.applyImport(input, sprintPlanActor),
                Schema.decodeUnknownEffect(CommandCenterSprintPlanApplyImportResult),
              ),
            ),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.sprintPlanGetCurrent]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.sprintPlanGetCurrent,
            withVerifiedSprintPlan(input.spaceId, (service) =>
              validateSprintPlanOutput(
                service.get(input),
                Schema.decodeUnknownEffect(CommandCenterSprintPlanGetResult),
              ),
            ),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.sprintPlanGetOriginal]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.sprintPlanGetOriginal,
            withVerifiedSprintPlan(input.spaceId, (service) =>
              validateSprintPlanOutput(
                service.getOriginal(input),
                Schema.decodeUnknownEffect(CommandCenterSprintPlanGetOriginalResult),
              ),
            ),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.sprintPlanPatchTask]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.sprintPlanPatchTask,
            withVerifiedSprintPlan(input.spaceId, (service) =>
              validateSprintPlanOutput(
                service.patchTask(input, sprintPlanActor),
                Schema.decodeUnknownEffect(CommandCenterSprintPlanPatchTaskResult),
              ),
            ),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.sprintPlanResolveDateConflict]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.sprintPlanResolveDateConflict,
            withVerifiedSprintPlan(input.spaceId, (service) =>
              validateSprintPlanOutput(
                service.resolveDateConflict(input, sprintPlanActor),
                Schema.decodeUnknownEffect(CommandCenterSprintPlanResolveDateConflictResult),
              ),
            ),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.sprintPlanListHistory]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.sprintPlanListHistory,
            withVerifiedSprintPlan(input.spaceId, (service) =>
              validateSprintPlanOutput(
                service.listHistory(input),
                Schema.decodeUnknownEffect(CommandCenterSprintPlanListHistoryResult),
              ),
            ),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.inboxDraftApprove]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.inboxDraftApprove,
            withVerifiedCommandCenterInbox(input.spaceId, () =>
              commandCenterAutomationRuns.approveInboxDraft(input, currentSession.subject),
            ),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.inboxDraftReceipt]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.inboxDraftReceipt,
            withVerifiedCommandCenterInbox(input.spaceId, () =>
              commandCenterAutomationRuns.getInboxDraftReceipt(input),
            ),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.runsQuery]: (input) =>
          observeRpcEffect(COMMAND_CENTER_WS_METHODS.runsQuery, commandCenter.queryRuns(input), {
            "rpc.aggregate": "command-center",
          }),
        [COMMAND_CENTER_WS_METHODS.automationsQuery]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.automationsQuery,
            commandCenter.queryAutomations(input),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.responsibilitiesList]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.responsibilitiesList,
            responsibilityCall((service) => service.list(input)).pipe(
              Effect.map((responsibilities) => ({ responsibilities })),
            ),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.responsibilityGet]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.responsibilityGet,
            responsibilityCall((service) => service.get(input)),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.responsibilityPause]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.responsibilityPause,
            responsibilityCall((service) =>
              service.setPause({ ...input, paused: true, actor: currentSessionId }),
            ),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.responsibilityResume]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.responsibilityResume,
            responsibilityCall((service) =>
              service.setPause({ ...input, paused: false, actor: currentSessionId }),
            ),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.automationDefinitionGet]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.automationDefinitionGet,
            automationDefinitionConfig.get(input),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.automationDefinitionCreate]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.automationDefinitionCreate,
            commandCenter
              .querySpaces({ spaceId: input.spaceId })
              .pipe(
                Effect.flatMap(() =>
                  automationDefinitionConfig.create(
                    input,
                    commandCenter.recordAutomationDefinitionCommit,
                  ),
                ),
              ),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.automationDefinitionSave]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.automationDefinitionSave,
            commandCenter
              .querySpaces({ spaceId: input.spaceId })
              .pipe(
                Effect.flatMap(() =>
                  automationDefinitionConfig.save(
                    input,
                    commandCenter.recordAutomationDefinitionCommit,
                  ),
                ),
              ),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.automationScheduleInterpret]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.automationScheduleInterpret,
            commandCenter.querySpaces({ spaceId: input.spaceId }).pipe(
              Effect.flatMap(() =>
                Option.match(automationScheduleInterpreter, {
                  onNone: () =>
                    Effect.fail(
                      new CommandCenterError({
                        reason: "routing",
                        message: "Schedule interpretation is unavailable in this environment.",
                      }),
                    ),
                  onSome: (interpreter) => interpreter.interpret(input),
                }),
              ),
            ),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.approvalsQuery]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.approvalsQuery,
            commandCenter.queryApprovals(input),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.artifactsQuery]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.artifactsQuery,
            commandCenter.queryArtifacts(input),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.connectionsQuery]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.connectionsQuery,
            commandCenter.queryConnections(input),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.connectionsRefresh]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.connectionsRefresh,
            refreshCommandCenterConnection(
              {
                queryConnections: commandCenter.queryConnections,
                verifyGoogle: googleReadConnector.verify,
              },
              input,
            ),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.googleConnectionSetupBegin]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.googleConnectionSetupBegin,
            Option.match(googleConnectionSetup, {
              onNone: () =>
                Effect.fail(
                  new CommandCenterError({
                    reason: "connector",
                    message: "Google account setup is unavailable in this environment.",
                  }),
                ),
              onSome: (setup) => setup.begin(input),
            }),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.googleConnectionSetupComplete]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.googleConnectionSetupComplete,
            Option.match(googleConnectionSetup, {
              onNone: () =>
                Effect.fail(
                  new CommandCenterError({
                    reason: "connector",
                    message: "Google account setup is unavailable in this environment.",
                  }),
                ),
              onSome: (setup) =>
                setup.complete(input).pipe(
                  Effect.tap(() => commandCenter.syncConfiguration({ force: true })),
                  Effect.tap((selection) =>
                    googleReadConnector.verify(selection).pipe(
                      Effect.mapError(
                        (cause) =>
                          new CommandCenterError({
                            reason: "connector",
                            message: "The Google account was connected but could not be verified.",
                            cause,
                          }),
                      ),
                    ),
                  ),
                  Effect.flatMap((selection) =>
                    commandCenter.queryConnections({ spaceId: selection.spaceId }).pipe(
                      Effect.flatMap(({ connections }) => {
                        const connection = connections.find(
                          (candidate) => candidate.id === selection.connectionId,
                        );
                        return connection === undefined
                          ? Effect.fail(
                              new CommandCenterError({
                                reason: "not_found",
                                message: "The connected Google account could not be loaded.",
                              }),
                            )
                          : Effect.succeed({ connection });
                      }),
                    ),
                  ),
                ),
            }),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.googleConnectionRemove]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.googleConnectionRemove,
            Option.match(googleConnectionSetup, {
              onNone: () =>
                Effect.fail(
                  new CommandCenterError({
                    reason: "connector",
                    message: "Google account removal is unavailable in this environment.",
                  }),
                ),
              onSome: (setup) =>
                setup
                  .remove(input)
                  .pipe(Effect.tap(() => commandCenter.syncConfiguration({ force: true }))),
            }),
            { "rpc.aggregate": "command-center" },
          ),
        [INSTAGRAM_REEL_METHODS.account]: () =>
          observeRpcEffect(
            INSTAGRAM_REEL_METHODS.account,
            withInstagramPublish((service) => service.account(currentSession)),
          ),
        [INSTAGRAM_REEL_METHODS.request]: (input) =>
          observeRpcEffect(
            INSTAGRAM_REEL_METHODS.request,
            withInstagramPublish((service) => service.request(input.binding, currentSession)),
          ),
        [INSTAGRAM_REEL_METHODS.query]: (input) =>
          observeRpcEffect(
            INSTAGRAM_REEL_METHODS.query,
            withInstagramPublish((service) => service.query(input.id, currentSession)),
          ),
        [INSTAGRAM_REEL_METHODS.approve]: (input) =>
          observeRpcEffect(
            INSTAGRAM_REEL_METHODS.approve,
            withInstagramPublish((service) =>
              service.approve(input.id, input.digest, currentSession),
            ),
          ),
        [INSTAGRAM_REEL_METHODS.cancel]: (input) =>
          observeRpcEffect(
            INSTAGRAM_REEL_METHODS.cancel,
            withInstagramPublish((service) => service.cancel(input.id, currentSession)),
          ),
        [COMMAND_CENTER_WS_METHODS.publishConnectionsQuery]: (_input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.publishConnectionsQuery,
            withPublishConnections((service) =>
              service.query.pipe(Effect.map((connections) => ({ connections }))),
            ),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.publishConnectionSetupBegin]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.publishConnectionSetupBegin,
            withPublishConnections((service) => service.begin(input)),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.publishConnectionSetupComplete]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.publishConnectionSetupComplete,
            withPublishConnections((service) =>
              service.complete(input).pipe(Effect.map((connection) => ({ connection }))),
            ),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.publishConnectionRemove]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.publishConnectionRemove,
            withPublishConnections((service) =>
              service.remove(input).pipe(Effect.map((connection) => ({ connection }))),
            ),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.memoryQuery]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.memoryQuery,
            commandCenter.queryMemories(input),
            {
              "rpc.aggregate": "command-center",
            },
          ),
        [COMMAND_CENTER_WS_METHODS.memorySearch]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.memorySearch,
            commandCenter.querySpaces({ spaceId: input.spaceId }).pipe(
              Effect.andThen(
                commandCenterMemorySearch.search({
                  query: input.query,
                  spaceId: input.spaceId,
                  ...(input.repositoryId === undefined
                    ? {}
                    : { repositoryRef: input.repositoryId }),
                  ...(input.includeArchives === undefined
                    ? {}
                    : { includeArchives: input.includeArchives }),
                  ...(input.limit === undefined ? {} : { limit: input.limit }),
                }),
              ),
              Effect.map((results) => ({
                results: results.map(({ repositoryRef, ...result }) => ({
                  ...result,
                  spaceId: CommandCenterSpaceId.make(result.spaceId),
                  ...(repositoryRef === undefined
                    ? {}
                    : { repositoryId: CommandCenterRepositoryId.make(repositoryRef) }),
                })),
              })),
              Effect.mapError(
                (cause) =>
                  new CommandCenterError({
                    reason: cause.reason === "invalid-query" ? "validation" : "persistence",
                    message: cause.message,
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.itemCreate]: (input) =>
          observeRpcEffect(COMMAND_CENTER_WS_METHODS.itemCreate, commandCenter.createItem(input), {
            "rpc.aggregate": "command-center",
          }),
        [COMMAND_CENTER_WS_METHODS.itemUpdate]: (input) =>
          observeRpcEffect(COMMAND_CENTER_WS_METHODS.itemUpdate, commandCenter.updateItem(input), {
            "rpc.aggregate": "command-center",
          }),
        [COMMAND_CENTER_WS_METHODS.memoryRemember]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.memoryRemember,
            commandCenter.remember(input),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.memoryPropose]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.memoryPropose,
            commandCenter.proposeMemory(input),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.memoryReview]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.memoryReview,
            commandCenter.reviewMemory(input),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.approvalDecide]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.approvalDecide,
            commandCenterAutomationRuns.decideApproval(input).pipe(
              Effect.flatMap(({ approval, automation }) =>
                !automation && approval.status === "approved"
                  ? commandCenter
                      .authorizeRunExecution({
                        runId: approval.runId,
                        actorKind: "user",
                      })
                      .pipe(
                        Effect.andThen(dispatchCommandCenterRun(approval.runId)),
                        Effect.as(approval),
                      )
                  : Effect.succeed(approval),
              ),
            ),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.automationRunStart]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.automationRunStart,
            commandCenterAutomationRuns.start(input),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.automationRunGet]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.automationRunGet,
            commandCenterAutomationRuns.get(input),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.automationWebhookAdmit]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.automationWebhookAdmit,
            commandCenterAutomationTriggers
              .admitWebhook({
                admissionSource: "paired-rpc",
                spaceId: input.spaceId,
                route: input.route,
                deliveryId: input.deliveryId,
                ...(input.payload === undefined ? {} : { payload: input.payload }),
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new CommandCenterError({
                      reason:
                        cause.reason === "not-found"
                          ? "not_found"
                          : cause.reason === "ambiguous-webhook"
                            ? "conflict"
                            : cause.reason === "start-failed"
                              ? "persistence"
                              : "validation",
                      message: cause.message,
                      cause,
                    }),
                ),
              ),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.googleRead]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.googleRead,
            Effect.gen(function* () {
              const requiredCapability = googleCapabilityForOperation(input.operation);
              const connections = (yield* commandCenter.queryConnections({})).connections;
              const accountIsConfigured = connections.some(
                (connection) =>
                  connection.kind === "google" &&
                  connection.id === input.connectionId &&
                  connection.spaceId === input.spaceId &&
                  connection.capabilities.includes(requiredCapability),
              );
              if (!accountIsConfigured) {
                return yield* new CommandCenterError({
                  reason: "validation",
                  message: "The requested Google connection is not available in this Space.",
                });
              }

              const toConnectorError = (cause: GoogleReadConnector.GoogleReadConnectorError) =>
                new CommandCenterError({
                  reason: "connector" as const,
                  message: cause.message,
                  cause,
                });
              if (input.operation !== "drive.export") {
                return yield* googleReadConnector
                  .read(input)
                  .pipe(Effect.mapError(toConnectorError));
              }

              const exported = yield* googleReadConnector
                .exportDrive(input)
                .pipe(Effect.mapError(toConnectorError));
              const artifact = yield* commandCenter
                .recordArtifact({
                  artifact: exported.artifact,
                  sizeBytes: exported.sizeBytes,
                  format: exported.format,
                })
                .pipe(Effect.tapError(() => googleReadConnector.discardExport(exported)));
              return {
                operation: "drive.export" as const,
                contentTrust: "untrusted-external" as const,
                artifact,
                sizeBytes: exported.sizeBytes,
              };
            }),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.observationsList]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.observationsList,
            withObservations((service) => service.list(input)),
          ),
        [COMMAND_CENTER_WS_METHODS.observationsGet]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.observationsGet,
            withObservations((service) => service.get(input)),
          ),
        [COMMAND_CENTER_WS_METHODS.observationsHistory]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.observationsHistory,
            withObservations((service) => service.history(input)),
          ),
        [COMMAND_CENTER_WS_METHODS.observationsCreateManual]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.observationsCreateManual,
            withObservations((service) => service.createManual(input, observationActor)),
          ),
        [COMMAND_CENTER_WS_METHODS.observationsImport]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.observationsImport,
            withObservations((service) =>
              service.importBatch(input.spaceId, input.request, observationActor),
            ),
          ),
        [COMMAND_CENTER_WS_METHODS.observationsCorrect]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.observationsCorrect,
            withObservations((service) => service.correct(input, observationActor)),
          ),
        [COMMAND_CENTER_WS_METHODS.observationsRetire]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.observationsRetire,
            withObservations((service) => service.retire(input, observationActor)),
          ),
        [COMMAND_CENTER_YOUTUBE_ANALYTICS_FETCH_METHOD]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_YOUTUBE_ANALYTICS_FETCH_METHOD,
            Option.match(youtubeAnalytics, {
              onNone: () =>
                Effect.fail(
                  new CommandCenterError({
                    reason: "config",
                    message: "YouTube Analytics is unavailable in this environment.",
                  }),
                ),
              onSome: (service) => service.fetch(input),
            }),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.windowsMediaRoots]: () =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.windowsMediaRoots,
            windowsMediaConnector.roots().pipe(Effect.mapError(toWindowsMediaError)),
            { "rpc.aggregate": "command-center" },
          ),
        [COMMAND_CENTER_WS_METHODS.windowsMediaList]: (input) =>
          observeRpcEffect(
            COMMAND_CENTER_WS_METHODS.windowsMediaList,
            windowsMediaConnector.list(input.path).pipe(Effect.mapError(toWindowsMediaError)),
            { "rpc.aggregate": "command-center" },
          ),
      });
      return commandCenterHandlers;
    }),
  );
