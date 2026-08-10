"use client";

import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApprovalId,
  CommandId,
  ItemId,
  MemoryId,
  RepositoryId,
  SpaceId,
} from "@command-center/core";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { SidebarInset } from "~/components/ui/sidebar";
import { newMessageId, newThreadId, randomUUID } from "~/lib/utils";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { useProjects } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useThreadDetail } from "~/state/queries";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { commandCenterEnvironment } from "~/state/commandCenter";

import { CommandCenterShell } from "./CommandCenterShell";
import {
  classifyCommandCenterExecutionTarget,
  resolveCommandCenterRouterEnvironmentId,
  resolveDesktopExecutionEnvironment,
  resolveDesktopWorkerModelSelection,
  resolveDesktopWorkerProject,
  type CommandCenterEnvironmentCandidate,
} from "./CommandCenterExecution.logic";
import {
  initialRouteReceipt,
  buildRouteOptions,
  commandRouteOverrides,
  defaultCommandCenterRouteSelection,
  mergeAuthoritativeMessages,
  projectBootstrap,
  projectEnvironmentProjects,
  routeReceiptFromResult,
  routeReceiptFromTimelineEntry,
  routeTimelineMessage,
  timelineMessages,
  visibleTimelineEntries,
  waitForRouteReceiptPaint,
} from "./CommandCenterHome.logic";
import type {
  CommandCenterConfigNotice,
  CommandCenterMessage,
  CommandCenterRouteReceipt,
  CommandCenterRouteSelection,
} from "./types";

const EMPTY_BOOTSTRAP_PROJECTION = {
  spaces: [],
  conversations: [],
  context: {
    needsYou: [],
    activeRuns: [],
    today: [],
    connections: [],
  },
} as const;

function currentTimeLabel(): string {
  return new Date().toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function blockedReceipt(summary: string): CommandCenterRouteReceipt {
  return {
    spaceName: "Unresolved",
    repositoryName: "Unresolved",
    projectName: "Unresolved",
    providerName: "Unavailable",
    modelName: "Unavailable",
    capabilities: [],
    sources: {
      space: "unresolved",
      repository: "unresolved",
      project: "unresolved",
      provider: "unresolved",
      model: "unresolved",
    },
    risk: "blocked",
    status: "blocked",
    summary,
  };
}

function failureMessage(failure: unknown): string {
  return failure instanceof Error && failure.message.trim().length > 0
    ? failure.message
    : "Command Center could not submit the command.";
}

interface LastRouteReceipt {
  readonly receipt: CommandCenterRouteReceipt;
  readonly runId?: string | undefined;
}

interface DelegatedDesktopRun {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly threadId: ThreadId;
}

export function CommandCenterHome() {
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const environmentProjects = useProjects();
  const environmentCandidates = useMemo<readonly CommandCenterEnvironmentCandidate[]>(
    () =>
      environments.map((environment) => ({
        id: environment.environmentId,
        label: environment.label,
        isPrimary: environment.entry.target._tag === "PrimaryConnectionTarget",
        platformOs: environment.serverConfig?.environment.platform.os ?? "unknown",
        connected: environment.connection.phase === "connected",
      })),
    [environments],
  );
  const environmentId = resolveCommandCenterRouterEnvironmentId({
    primaryEnvironmentId,
    environments: environmentCandidates,
  });
  const routerEnvironment = environments.find(
    (environment) => environment.environmentId === environmentId,
  );
  const providers = routerEnvironment?.serverConfig?.providers ?? [];
  const desktopEnvironment = resolveDesktopExecutionEnvironment(
    environmentCandidates,
    environmentId,
  );
  const [routeSelection, setRouteSelection] = useState<CommandCenterRouteSelection>({});
  const [conversationRoute, setConversationRoute] = useState<CommandCenterRouteSelection>({});
  const [spaceFilterId, setSpaceFilterId] = useState<string>();
  const [activeConversationId, setActiveConversationId] = useState<string>();
  const [selectedTranscriptRunId, setSelectedTranscriptRunId] = useState<string>();
  const [transcriptAfterSequence, setTranscriptAfterSequence] = useState<number | null>(null);
  const [optimisticMessages, setOptimisticMessages] = useState<CommandCenterMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [resolvingNeedsYouId, setResolvingNeedsYouId] = useState<string>();
  const [lastReceipt, setLastReceipt] = useState<LastRouteReceipt | null>(null);
  const [delegatedDesktopRun, setDelegatedDesktopRun] = useState<DelegatedDesktopRun | null>(null);
  const delegatedThread = useThreadDetail(
    delegatedDesktopRun?.environmentId ?? null,
    delegatedDesktopRun?.threadId ?? null,
  );
  const selectedSpaceId = spaceFilterId === undefined ? undefined : SpaceId.make(spaceFilterId);
  const bootstrapQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : commandCenterEnvironment.bootstrap({ environmentId, input: {} }),
  );
  const timelineQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : commandCenterEnvironment.timeline({
          environmentId,
          input: {
            limit: 200,
            ...(selectedSpaceId === undefined ? {} : { spaceId: selectedSpaceId }),
          },
        }),
  );
  const eventQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : commandCenterEnvironment.events({
          environmentId,
          input: {
            afterSequence: timelineQuery.data?.nextSequence ?? 0,
            batchSize: 200,
            ...(selectedSpaceId === undefined ? {} : { spaceId: selectedSpaceId }),
          },
        }),
  );
  const submitCommand = useAtomCommand(commandCenterEnvironment.submit, {
    reportFailure: false,
  });
  const startRun = useAtomCommand(commandCenterEnvironment.startRun, {
    reportFailure: false,
  });
  const decideApproval = useAtomCommand(commandCenterEnvironment.decideApproval, {
    reportFailure: false,
  });
  const reviewMemory = useAtomCommand(commandCenterEnvironment.reviewMemory, {
    reportFailure: false,
  });
  const createItem = useAtomCommand(commandCenterEnvironment.createItem, {
    reportFailure: false,
  });
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const updateItem = useAtomCommand(commandCenterEnvironment.updateItem, {
    reportFailure: false,
  });

  const eventSequence = eventQuery.data?.sequence;
  const eventScopeKey = `${environmentId ?? "disconnected"}:${selectedSpaceId ?? "all"}`;
  const lastRefreshedEvent = useRef({ scopeKey: eventScopeKey, sequence: 0 });
  useEffect(() => {
    if (lastRefreshedEvent.current.scopeKey !== eventScopeKey) {
      lastRefreshedEvent.current = { scopeKey: eventScopeKey, sequence: 0 };
    }
    if (eventSequence === undefined) return;
    if (eventSequence <= lastRefreshedEvent.current.sequence) return;
    lastRefreshedEvent.current = { scopeKey: eventScopeKey, sequence: eventSequence };
    timelineQuery.refresh();
    bootstrapQuery.refresh();
  }, [bootstrapQuery.refresh, eventScopeKey, eventSequence, timelineQuery.refresh]);

  const bootstrap = bootstrapQuery.data;
  const projects = useMemo(
    () =>
      projectEnvironmentProjects(
        environmentProjects.filter((project) => project.environmentId === environmentId),
        bootstrap,
      ),
    [bootstrap, environmentId, environmentProjects],
  );
  const routeOptions = useMemo(
    () => buildRouteOptions(bootstrap, projects, providers),
    [bootstrap, projects, providers],
  );
  useEffect(() => {
    if (routeSelection.providerId !== undefined && routeSelection.modelId !== undefined) return;
    const selection = defaultCommandCenterRouteSelection(routeOptions);
    if (selection !== null) setRouteSelection(selection);
  }, [routeOptions.models, routeSelection.modelId, routeSelection.providerId]);
  const routeDisplay = useMemo(
    () => ({ options: routeOptions, projects }),
    [projects, routeOptions],
  );
  const projection = useMemo(
    () => (bootstrap === null ? EMPTY_BOOTSTRAP_PROJECTION : projectBootstrap(bootstrap)),
    [bootstrap],
  );
  useEffect(() => {
    if (transcriptAfterSequence !== null || timelineQuery.data === null) return;
    setTranscriptAfterSequence(timelineQuery.data.nextSequence);
  }, [timelineQuery.data, transcriptAfterSequence]);
  const visibleTimeline = useMemo(
    () =>
      visibleTimelineEntries(
        timelineQuery.data?.entries ?? [],
        transcriptAfterSequence ?? Number.MAX_SAFE_INTEGER,
        selectedTranscriptRunId,
      ),
    [selectedTranscriptRunId, timelineQuery.data?.entries, transcriptAfterSequence],
  );
  const authoritativeMessages = useMemo(
    () => timelineMessages(visibleTimeline, bootstrap, routeDisplay),
    [bootstrap, routeDisplay, visibleTimeline],
  );
  const delegatedMessages = useMemo<readonly CommandCenterMessage[]>(
    () =>
      delegatedThread.data?.messages
        .filter((message) => message.role === "assistant")
        .map((message) => ({
          id: `desktop:${message.id}`,
          author: "assistant" as const,
          authorLabel: delegatedDesktopRun?.environmentLabel ?? "Desktop worker",
          body: message.text,
          createdAtLabel: new Date(message.createdAt).toLocaleTimeString(undefined, {
            hour: "numeric",
            minute: "2-digit",
          }),
          ...(delegatedDesktopRun === null
            ? {}
            : {
                linkedThreadId: delegatedDesktopRun.threadId,
                linkedEnvironmentId: delegatedDesktopRun.environmentId,
              }),
        })) ?? [],
    [delegatedDesktopRun, delegatedThread.data?.messages],
  );
  const messages = useMemo(
    () =>
      mergeAuthoritativeMessages(
        [...authoritativeMessages, ...delegatedMessages],
        optimisticMessages,
      ),
    [authoritativeMessages, delegatedMessages, optimisticMessages],
  );
  useEffect(() => {
    const thread = delegatedThread.data;
    const session = thread?.session;
    if (delegatedDesktopRun === null || thread === null || thread === undefined) return;
    const status =
      thread.latestTurn?.state === "error" || session?.status === "error"
        ? "failed"
        : thread.latestTurn?.state === "completed"
          ? "complete"
          : "running";
    setLastReceipt((current) =>
      current?.receipt.executionTargetName !== delegatedDesktopRun.environmentLabel
        ? current
        : {
            ...current,
            receipt: {
              ...current.receipt,
              status,
              summary:
                status === "complete"
                  ? `Desktop work completed on ${delegatedDesktopRun.environmentLabel}.`
                  : status === "failed"
                    ? (session?.lastError ?? "The desktop worker failed.")
                    : current.receipt.summary,
            },
          },
    );
  }, [delegatedDesktopRun, delegatedThread.data]);
  const routeReceipt = useMemo(() => {
    if (lastReceipt !== null) {
      const timelineEntry =
        lastReceipt.runId === undefined
          ? undefined
          : timelineQuery.data?.entries.find((entry) => entry.runId === lastReceipt.runId);
      return timelineEntry === undefined
        ? lastReceipt.receipt
        : routeReceiptFromTimelineEntry(timelineEntry, bootstrap, routeDisplay);
    }
    if (timelineQuery.error !== null || eventQuery.error !== null) {
      return blockedReceipt("The durable Command timeline is not available right now.");
    }
    if (bootstrapQuery.error !== null) {
      return blockedReceipt("The Command Center environment is not available right now.");
    }
    if (environmentId === null) {
      return blockedReceipt("Connect an environment before submitting a command.");
    }
    return initialRouteReceipt(bootstrap, routeSelection, routeDisplay);
  }, [
    bootstrap,
    bootstrapQuery.error,
    environmentId,
    eventQuery.error,
    lastReceipt,
    routeDisplay,
    routeSelection,
    timelineQuery.data?.entries,
    timelineQuery.error,
  ]);

  const changeModelSelection = useCallback((providerId: string, modelId: string) => {
    setRouteSelection({ providerId, modelId });
    setLastReceipt(null);
  }, []);

  const selectSpace = useCallback(
    (spaceId: string) => {
      setActiveConversationId(undefined);
      setSelectedTranscriptRunId(undefined);
      setTranscriptAfterSequence(timelineQuery.data?.nextSequence ?? 0);
      setOptimisticMessages([]);
      setLastReceipt(null);
      setDraft("");
      if (spaceId.length === 0) {
        setSpaceFilterId(undefined);
        setConversationRoute({});
        return;
      }
      if (!bootstrap?.spaces.some((space) => space.id === spaceId)) return;
      setSpaceFilterId(spaceId);
      setConversationRoute({ spaceId });
    },
    [bootstrap, timelineQuery.data?.nextSequence],
  );

  const selectProject = useCallback(
    (projectId: string) => {
      if (!projects.some((project) => project.id === projectId)) return;
      const project = projects.find((candidate) => candidate.id === projectId);
      if (project?.spaceId !== undefined) setSpaceFilterId(project.spaceId);
    },
    [projects],
  );

  const selectConversation = useCallback(
    (conversationId: string) => {
      setActiveConversationId(conversationId);
      setSelectedTranscriptRunId(conversationId);
      const run = bootstrap?.runs.find((candidate) => candidate.id === conversationId);
      if (run !== undefined) {
        if (environmentId !== null && run.threadId !== undefined) {
          void navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId, threadId: run.threadId },
          });
          return;
        }
        setSpaceFilterId(run.spaceId);
        setConversationRoute({
          spaceId: run.spaceId,
          repositoryId: run.repositoryId,
          projectId: run.projectId,
        });
        setRouteSelection({ providerId: run.providerId, modelId: run.modelId });
        setOptimisticMessages([]);
        setLastReceipt(null);
      }
    },
    [bootstrap, environmentId, navigate],
  );

  const openLinkedThread = useCallback(
    (threadId: string, linkedEnvironmentId?: string) => {
      const targetEnvironmentId =
        linkedEnvironmentId === undefined ? environmentId : (linkedEnvironmentId as EnvironmentId);
      if (targetEnvironmentId === null) return;
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: targetEnvironmentId, threadId },
      });
    },
    [environmentId, navigate],
  );

  const openRun = useCallback(
    (runId: string) => {
      const run = bootstrap?.runs.find((candidate) => candidate.id === runId);
      if (run?.threadId !== undefined) {
        openLinkedThread(run.threadId);
        return;
      }
      selectConversation(runId);
    },
    [bootstrap, openLinkedThread, selectConversation],
  );

  const openNeedsYouItem = useCallback(
    (itemId: string) => {
      const item = bootstrap?.needsYou.find((candidate) => candidate.id === itemId);
      if (item === undefined) return;
      const linkedRun = bootstrap?.runs.find(
        (candidate) => candidate.id === item.provenance.sourceRef,
      );
      if (linkedRun?.threadId !== undefined) {
        openLinkedThread(linkedRun.threadId);
        return;
      }
      selectSpace(item.spaceId);
      setDraft(`Help me resolve: ${item.title}`);
    },
    [bootstrap, openLinkedThread, selectSpace],
  );

  const openTodayItem = useCallback(
    (itemId: string) => {
      const item = bootstrap?.items.find((candidate) => candidate.id === itemId);
      if (item === undefined) return;
      selectSpace(item.spaceId);
      setDraft(`Help me with: ${item.title}`);
    },
    [bootstrap, selectSpace],
  );

  const recordNeedsYouFailure = useCallback((id: string, failure: unknown) => {
    setOptimisticMessages((current) => [
      ...current,
      {
        id: `${id}:resolution-failure:${Date.now()}`,
        author: "system",
        authorLabel: "Needs You",
        body: failureMessage(failure),
        createdAtLabel: currentTimeLabel(),
      },
    ]);
  }, []);

  const resolveApproval = useCallback(
    async (approvalId: string, payloadDigest: string, decision: "approved" | "declined") => {
      if (environmentId === null || resolvingNeedsYouId !== undefined) return;
      setResolvingNeedsYouId(approvalId);
      const result = await decideApproval({
        environmentId,
        input: {
          approvalId: ApprovalId.make(approvalId),
          payloadDigest,
          decision,
        },
      });
      if (result._tag === "Success") {
        bootstrapQuery.refresh();
        timelineQuery.refresh();
      } else {
        recordNeedsYouFailure(approvalId, squashAtomCommandFailure(result));
      }
      setResolvingNeedsYouId(undefined);
    },
    [
      bootstrapQuery,
      decideApproval,
      environmentId,
      recordNeedsYouFailure,
      resolvingNeedsYouId,
      timelineQuery,
    ],
  );

  const resolveMemory = useCallback(
    async (
      memoryId: string,
      spaceId: string,
      repositoryId: string | undefined,
      decision: "approve" | "reject",
    ) => {
      if (environmentId === null || resolvingNeedsYouId !== undefined) return;
      setResolvingNeedsYouId(memoryId);
      const result = await reviewMemory({
        environmentId,
        input: {
          memoryId: MemoryId.make(memoryId),
          spaceId: SpaceId.make(spaceId),
          ...(repositoryId === undefined ? {} : { repositoryId: RepositoryId.make(repositoryId) }),
          decision,
        },
      });
      if (result._tag === "Success") {
        bootstrapQuery.refresh();
      } else {
        recordNeedsYouFailure(memoryId, squashAtomCommandFailure(result));
      }
      setResolvingNeedsYouId(undefined);
    },
    [bootstrapQuery, environmentId, recordNeedsYouFailure, resolvingNeedsYouId, reviewMemory],
  );

  const newConversation = useCallback(() => {
    setActiveConversationId(undefined);
    setRouteSelection({});
    setConversationRoute({});
    setSpaceFilterId(undefined);
    setOptimisticMessages([]);
    setSelectedTranscriptRunId(undefined);
    setTranscriptAfterSequence(timelineQuery.data?.nextSequence ?? 0);
    setDraft("");
    setLastReceipt(null);
    setDelegatedDesktopRun(null);
  }, [timelineQuery.data?.nextSequence]);

  const dismissNeedsYouItems = useCallback(
    async (itemIds: readonly string[]) => {
      if (environmentId === null || resolvingNeedsYouId !== undefined) return;
      const items = itemIds.flatMap((itemId) => {
        const item = bootstrap?.needsYou.find((candidate) => candidate.id === itemId);
        return item === undefined ? [] : [item];
      });
      if (items.length === 0) return;
      setResolvingNeedsYouId(items.length === 1 ? items[0]!.id : "dismiss-all");
      for (const item of items) {
        const result = await updateItem({
          environmentId,
          input: {
            itemId: ItemId.make(item.id),
            spaceId: SpaceId.make(item.spaceId),
            expectedUpdatedAt: item.updatedAt,
            patch: { status: "canceled" },
          },
        });
        if (result._tag !== "Success") {
          recordNeedsYouFailure(item.id, squashAtomCommandFailure(result));
        }
      }
      bootstrapQuery.refresh();
      timelineQuery.refresh();
      setResolvingNeedsYouId(undefined);
    },
    [
      bootstrap,
      bootstrapQuery,
      environmentId,
      recordNeedsYouFailure,
      resolvingNeedsYouId,
      timelineQuery,
      updateItem,
    ],
  );

  const capture = useCallback(
    async (input: {
      readonly spaceId: string;
      readonly kind: "idea" | "task";
      readonly title: string;
    }) => {
      if (environmentId === null) return false;
      const result = await createItem({
        environmentId,
        input: {
          requestId: randomUUID(),
          spaceId: SpaceId.make(input.spaceId),
          kind: input.kind,
          priority: "normal",
          title: input.title,
        },
      });
      if (result._tag !== "Success") {
        recordNeedsYouFailure(`capture:${Date.now()}`, squashAtomCommandFailure(result));
        return false;
      }
      bootstrapQuery.refresh();
      timelineQuery.refresh();
      return true;
    },
    [bootstrapQuery, createItem, environmentId, recordNeedsYouFailure, timelineQuery],
  );

  const submit = useCallback(
    async (text: string) => {
      if (
        environmentId === null ||
        bootstrap === null ||
        bootstrap.configHealth.status !== "loaded" ||
        isSubmitting
      ) {
        return;
      }

      const commandId = CommandId.make(randomUUID());
      const createdAtLabel = currentTimeLabel();
      setIsSubmitting(true);
      setSelectedTranscriptRunId(undefined);
      setDraft("");
      setOptimisticMessages((current) => [
        ...current,
        {
          id: `${commandId}:user`,
          author: "user",
          body: text,
          createdAtLabel,
        },
      ]);

      const executionTarget = classifyCommandCenterExecutionTarget(text);
      if (executionTarget === "desktop") {
        if (desktopEnvironment === null) {
          const message =
            "This request needs the desktop, but no connected desktop environment is available.";
          setLastReceipt({ receipt: blockedReceipt(message) });
          setOptimisticMessages((current) => [
            ...current,
            {
              id: `${commandId}:desktop-unavailable`,
              author: "system",
              authorLabel: "Desktop unavailable",
              body: `${message} Connect the desktop and retry this command.`,
              createdAtLabel: currentTimeLabel(),
            },
          ]);
          setIsSubmitting(false);
          return;
        }

        const selectedProject = environmentProjects.find(
          (project) =>
            project.environmentId === environmentId && project.id === routeSelection.projectId,
        );
        const workerProject = resolveDesktopWorkerProject({
          desktopEnvironmentId: desktopEnvironment.id,
          projects: environmentProjects,
          ...(selectedProject === undefined ? {} : { selectedProject }),
        });
        const desktopProviders =
          environments.find((environment) => environment.environmentId === desktopEnvironment.id)
            ?.serverConfig?.providers ?? [];
        const modelSelection =
          workerProject === null
            ? null
            : resolveDesktopWorkerModelSelection({
                project: workerProject,
                providers: desktopProviders,
              });
        if (workerProject === null || modelSelection === null) {
          const message =
            workerProject === null
              ? "No desktop workspace is available for the local worker."
              : "No usable desktop agent provider is available for the local worker.";
          setLastReceipt({ receipt: blockedReceipt(message) });
          setOptimisticMessages((current) => [
            ...current,
            {
              id: `${commandId}:desktop-worker-unavailable`,
              author: "system",
              authorLabel: "Desktop worker unavailable",
              body: message,
              createdAtLabel: currentTimeLabel(),
            },
          ]);
          setIsSubmitting(false);
          return;
        }

        const threadId = newThreadId();
        const createdAt = new Date().toISOString();
        const title = text.length > 80 ? `${text.slice(0, 77)}...` : text;
        const createResult = await createThread({
          environmentId: desktopEnvironment.id,
          input: {
            threadId,
            projectId: workerProject.id,
            title,
            modelSelection,
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt,
          },
        });
        if (createResult._tag === "Failure") {
          const message = failureMessage(squashAtomCommandFailure(createResult));
          setLastReceipt({ receipt: blockedReceipt(message) });
          setOptimisticMessages((current) => [
            ...current,
            {
              id: `${commandId}:desktop-create-failed`,
              author: "system",
              authorLabel: "Desktop delegation failed",
              body: message,
              createdAtLabel: currentTimeLabel(),
            },
          ]);
          setIsSubmitting(false);
          return;
        }

        const receipt: CommandCenterRouteReceipt = {
          spaceName:
            bootstrap.spaces.find((space) => space.id === routeSelection.spaceId)?.displayName ??
            "Command Center",
          projectName: workerProject.title,
          providerName:
            desktopProviders.find((provider) => provider.instanceId === modelSelection.instanceId)
              ?.displayName ?? modelSelection.instanceId,
          modelName: modelSelection.model,
          executionTargetName: desktopEnvironment.label,
          capabilities: ["desktop.local"],
          sources: {
            space: routeSelection.spaceId === undefined ? "fallback" : "explicit",
            repository: "unresolved",
            project: selectedProject === undefined ? "fallback" : "classifier",
            provider: "provider-default",
            model: "provider-default",
          },
          risk: "low",
          status: "running",
          summary: `Command Center delegated this work to ${desktopEnvironment.label}.`,
        };
        setDelegatedDesktopRun({
          environmentId: desktopEnvironment.id,
          environmentLabel: desktopEnvironment.label,
          threadId,
        });
        setLastReceipt({ receipt });
        setOptimisticMessages((current) => [
          ...current,
          {
            id: `${commandId}:desktop-route`,
            author: "system",
            authorLabel: "Desktop worker started",
            body: `Running on ${desktopEnvironment.label}. Open the worker thread for full activity and approvals.`,
            createdAtLabel: currentTimeLabel(),
            linkedThreadId: threadId,
            linkedEnvironmentId: desktopEnvironment.id,
            receipt,
          },
        ]);
        const startResult = await startThreadTurn({
          environmentId: desktopEnvironment.id,
          input: {
            threadId,
            message: {
              messageId: newMessageId(),
              role: "user",
              text: `You are a desktop worker delegated by Command Center on OpenClaw. Work only on this desktop machine and its local resources. Complete the following request, asking for approval or clarification when appropriate:\n\n${text}`,
              attachments: [],
            },
            modelSelection,
            titleSeed: title,
            runtimeMode: "approval-required",
            interactionMode: "default",
            createdAt,
          },
        });
        if (startResult._tag === "Failure") {
          const message = failureMessage(squashAtomCommandFailure(startResult));
          setDelegatedDesktopRun(null);
          setLastReceipt({ receipt: { ...receipt, status: "failed", summary: message } });
          setOptimisticMessages((current) => [
            ...current,
            {
              id: `${commandId}:desktop-start-failed`,
              author: "system",
              authorLabel: "Desktop worker failed",
              body: message,
              createdAtLabel: currentTimeLabel(),
              linkedThreadId: threadId,
              linkedEnvironmentId: desktopEnvironment.id,
            },
          ]);
        }
        setIsSubmitting(false);
        return;
      }

      const result = await submitCommand({
        environmentId,
        input: {
          commandId,
          text,
          ...commandRouteOverrides(conversationRoute),
          ...commandRouteOverrides(routeSelection),
        },
      });

      if (result._tag === "Success") {
        const receipt = {
          ...routeReceiptFromResult(result.value, bootstrap, routeDisplay),
          ...(routerEnvironment === undefined
            ? {}
            : { executionTargetName: routerEnvironment.label }),
        };
        setLastReceipt({ receipt, runId: result.value.run.id });
        setActiveConversationId(result.value.run.id);
        setConversationRoute({
          ...(result.value.route.spaceId === null ? {} : { spaceId: result.value.route.spaceId }),
          ...(result.value.route.repositoryId === null
            ? {}
            : { repositoryId: result.value.route.repositoryId }),
          ...(result.value.route.projectId === null
            ? {}
            : { projectId: result.value.route.projectId }),
        });
        setOptimisticMessages((current) => [
          ...current,
          routeTimelineMessage(result.value, receipt, currentTimeLabel()),
        ]);
        timelineQuery.refresh();
        bootstrapQuery.refresh();
        if (result.value.route.status === "ready" && result.value.run.status === "queued") {
          await waitForRouteReceiptPaint();
          const started = await startRun({
            environmentId,
            input: { runId: result.value.run.id },
          });
          if (started._tag === "Failure") {
            setOptimisticMessages((current) => [
              ...current,
              {
                id: `${commandId}:start-deferred`,
                author: "system",
                authorLabel: "Run queued",
                body: `The route was accepted. Automatic recovery will retry starting it. ${failureMessage(
                  squashAtomCommandFailure(started),
                )}`,
                createdAtLabel: currentTimeLabel(),
              },
            ]);
          }
          timelineQuery.refresh();
          bootstrapQuery.refresh();
        }
      } else {
        const message = failureMessage(squashAtomCommandFailure(result));
        setLastReceipt({ receipt: blockedReceipt(message) });
        setOptimisticMessages((current) => [
          ...current,
          {
            id: `${commandId}:failure`,
            author: "system",
            authorLabel: "Command failed",
            body: message,
            createdAtLabel: currentTimeLabel(),
          },
        ]);
      }
      setIsSubmitting(false);
    },
    [
      bootstrap,
      conversationRoute,
      createThread,
      desktopEnvironment,
      environmentProjects,
      environments,
      bootstrapQuery,
      environmentId,
      isSubmitting,
      routeDisplay,
      routeSelection,
      routerEnvironment,
      startRun,
      startThreadTurn,
      submitCommand,
      timelineQuery,
    ],
  );

  const selectedModelAvailable = routeOptions.models.some(
    (model) =>
      model.id === routeSelection.modelId && model.providerId === routeSelection.providerId,
  );
  const commandUnavailable =
    isSubmitting ||
    bootstrapQuery.isPending ||
    timelineQuery.isPending ||
    environmentId === null ||
    bootstrap?.configHealth.status !== "loaded" ||
    !selectedModelAvailable;

  // Surface a missing/invalid configuration as an explicit setup notice so the
  // composer can explain why sending is disabled instead of freezing silently.
  // The input itself stays enabled (gated on `isSubmitting`, not this).
  const configHealth = bootstrap?.configHealth;
  const configNotice: CommandCenterConfigNotice | null =
    configHealth && configHealth.status !== "loaded"
      ? {
          status: configHealth.status,
          message:
            configHealth.message ??
            (configHealth.status === "missing"
              ? "No configuration was found in the Command Center config directory."
              : "The configuration file could not be parsed."),
        }
      : null;

  return (
    <SidebarInset className="h-full min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <CommandCenterShell
        activeConversationId={activeConversationId}
        context={projection.context}
        conversationTitle="Command"
        commandUnavailable={commandUnavailable}
        configNotice={configNotice}
        conversations={projection.conversations}
        draft={draft}
        isSubmitting={isSubmitting}
        messages={messages}
        onDraftChange={setDraft}
        onCapture={capture}
        onClearTranscript={newConversation}
        onNewConversation={newConversation}
        onDecideApproval={(approvalId, payloadDigest, decision) => {
          void resolveApproval(approvalId, payloadDigest, decision);
        }}
        onOpenLinkedThread={openLinkedThread}
        onOpenNeedsYouItem={openNeedsYouItem}
        onDismissNeedsYouItems={(itemIds) => {
          void dismissNeedsYouItems(itemIds);
        }}
        onOpenRun={openRun}
        onOpenProviderSettings={() => {
          void navigate({ to: "/settings/providers" });
        }}
        onOpenTodayItem={openTodayItem}
        onOpenConnection={() => {
          void navigate({ to: "/settings/connections" });
        }}
        onReviewMemory={(memoryId, spaceId, repositoryId, decision) => {
          void resolveMemory(memoryId, spaceId, repositoryId, decision);
        }}
        onModelSelectionChange={changeModelSelection}
        onSelectConversation={selectConversation}
        onSelectProject={selectProject}
        onSelectSpace={selectSpace}
        onSubmit={(command) => {
          void submit(command);
        }}
        projects={projects}
        routeReceipt={{
          ...routeReceipt,
          ...(routeReceipt.executionTargetName !== undefined || routerEnvironment === undefined
            ? {}
            : { executionTargetName: routerEnvironment.label }),
        }}
        routeOptions={routeOptions}
        routeSelection={routeSelection}
        resolvingNeedsYouId={resolvingNeedsYouId}
        selectedProjectId={routeSelection.projectId}
        selectedSpaceId={selectedSpaceId}
        spaces={projection.spaces}
      />
    </SidebarInset>
  );
}
