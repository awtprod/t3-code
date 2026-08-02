"use client";

import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApprovalId,
  CommandId,
  MemoryId,
  RepositoryId,
  SalesDraftRequestId,
  SpaceId,
  type SalesDraftRequest,
  type SalesProspect,
  type SalesProspectStage,
} from "@command-center/core";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { SidebarInset } from "~/components/ui/sidebar";
import { randomUUID } from "~/lib/utils";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useProjects } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { primaryServerProvidersAtom } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { commandCenterEnvironment } from "~/state/commandCenter";

import { CommandCenterShell } from "./CommandCenterShell";
import { SalesPipelineBoard } from "./SalesPipelineBoard";
import {
  initialRouteReceipt,
  buildRouteOptions,
  commandRouteOverrides,
  mergeAuthoritativeMessages,
  nextRouteSelection,
  projectBootstrap,
  projectEnvironmentProjects,
  routeReceiptFromResult,
  routeReceiptFromTimelineEntry,
  routeTimelineMessage,
  timelineMessages,
  waitForRouteReceiptPaint,
} from "./CommandCenterHome.logic";
import type {
  CommandCenterConfigNotice,
  CommandCenterMessage,
  CommandCenterRouteControl,
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

export function CommandCenterHome() {
  const navigate = useNavigate();
  const environmentId = usePrimaryEnvironmentId();
  const environmentProjects = useProjects();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const [routeSelection, setRouteSelection] = useState<CommandCenterRouteSelection>({});
  const [activeConversationId, setActiveConversationId] = useState<string>();
  const [optimisticMessages, setOptimisticMessages] = useState<CommandCenterMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [resolvingNeedsYouId, setResolvingNeedsYouId] = useState<string>();
  const [lastReceipt, setLastReceipt] = useState<LastRouteReceipt | null>(null);
  const [destination, setDestination] = useState<"command" | "pipeline">("command");
  const [salesBusy, setSalesBusy] = useState(false);
  const [salesError, setSalesError] = useState<string>();
  const [salesStatus, setSalesStatus] = useState<string>();
  const selectedSpaceId =
    routeSelection.spaceId === undefined ? undefined : SpaceId.make(routeSelection.spaceId);
  const bootstrapQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : commandCenterEnvironment.bootstrap({ environmentId, input: {} }),
  );
  const selectedSpace = bootstrapQuery.data?.spaces.find((space) => space.id === selectedSpaceId);
  const salesEnabled = selectedSpace?.features?.salesPipeline === true;
  const salesQuery = useEnvironmentQuery(
    environmentId === null || selectedSpaceId === undefined || !salesEnabled
      ? null
      : commandCenterEnvironment.salesProspects({
          environmentId,
          input: { spaceId: selectedSpaceId },
        }),
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
  const updateSalesProspect = useAtomCommand(commandCenterEnvironment.updateSalesProspect, {
    reportFailure: false,
  });
  const importSalesProspects = useAtomCommand(commandCenterEnvironment.importSalesProspects, {
    reportFailure: false,
  });
  const requestSalesDraft = useAtomCommand(commandCenterEnvironment.requestSalesDraft, {
    reportFailure: false,
  });
  const decideSalesDraft = useAtomCommand(commandCenterEnvironment.decideSalesDraft, {
    reportFailure: false,
  });
  const createSalesDraft = useAtomCommand(commandCenterEnvironment.createSalesDraft, {
    reportFailure: false,
  });

  useEffect(() => {
    if (!salesEnabled) setDestination("command");
  }, [salesEnabled]);

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
    () => buildRouteOptions(bootstrap, projects, providers, routeSelection.providerId),
    [bootstrap, projects, providers, routeSelection.providerId],
  );
  const routeDisplay = useMemo(
    () => ({ options: routeOptions, projects }),
    [projects, routeOptions],
  );
  const projection = useMemo(
    () => (bootstrap === null ? EMPTY_BOOTSTRAP_PROJECTION : projectBootstrap(bootstrap)),
    [bootstrap],
  );
  const authoritativeMessages = useMemo(
    () => timelineMessages(timelineQuery.data?.entries ?? [], bootstrap, routeDisplay),
    [bootstrap, routeDisplay, timelineQuery.data?.entries],
  );
  const messages = useMemo(
    () => mergeAuthoritativeMessages(authoritativeMessages, optimisticMessages),
    [authoritativeMessages, optimisticMessages],
  );
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

  const changeRouteSelection = useCallback(
    (control: CommandCenterRouteControl, value: string | undefined) => {
      setRouteSelection((current) =>
        nextRouteSelection(current, control, value, projects, bootstrap, providers),
      );
      setOptimisticMessages([]);
      setLastReceipt(null);
    },
    [bootstrap, projects, providers],
  );

  const selectSpace = useCallback(
    (spaceId: string) => {
      if (!bootstrap?.spaces.some((space) => space.id === spaceId)) return;
      changeRouteSelection("space", spaceId);
    },
    [bootstrap, changeRouteSelection],
  );

  const selectProject = useCallback(
    (projectId: string) => {
      if (!projects.some((project) => project.id === projectId)) return;
      changeRouteSelection("project", projectId);
    },
    [changeRouteSelection, projects],
  );

  const selectConversation = useCallback(
    (conversationId: string) => {
      setActiveConversationId(conversationId);
      const run = bootstrap?.runs.find((candidate) => candidate.id === conversationId);
      if (run !== undefined) {
        if (environmentId !== null && run.threadId !== undefined) {
          void navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId, threadId: run.threadId },
          });
          return;
        }
        setRouteSelection({
          spaceId: run.spaceId,
          repositoryId: run.repositoryId,
          projectId: run.projectId,
          providerId: run.providerId,
          modelId: run.modelId,
        });
        setOptimisticMessages([]);
        setLastReceipt(null);
      }
    },
    [bootstrap, environmentId, navigate],
  );

  const openLinkedThread = useCallback(
    (threadId: string) => {
      if (environmentId === null) return;
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId },
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
    setOptimisticMessages([]);
    setDraft("");
    setLastReceipt(null);
  }, []);

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

      const result = await submitCommand({
        environmentId,
        input: {
          commandId,
          text,
          ...commandRouteOverrides(routeSelection),
        },
      });

      if (result._tag === "Success") {
        const receipt = routeReceiptFromResult(result.value, bootstrap, routeDisplay);
        setLastReceipt({ receipt, runId: result.value.run.id });
        setActiveConversationId(result.value.run.id);
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
      bootstrapQuery,
      environmentId,
      isSubmitting,
      routeDisplay,
      routeSelection,
      startRun,
      submitCommand,
      timelineQuery,
    ],
  );

  const commandUnavailable =
    isSubmitting ||
    bootstrapQuery.isPending ||
    timelineQuery.isPending ||
    environmentId === null ||
    bootstrap?.configHealth.status !== "loaded";

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

  const changeSalesStage = useCallback(
    async (prospect: SalesProspect, stage: SalesProspectStage) => {
      if (environmentId === null || salesBusy) return;
      setSalesBusy(true);
      setSalesError(undefined);
      const result = await updateSalesProspect({
        environmentId,
        input: {
          prospectId: prospect.id,
          spaceId: prospect.spaceId,
          expectedUpdatedAt: prospect.updatedAt,
          stage,
        },
      });
      if (result._tag === "Success") salesQuery.refresh();
      else setSalesError(failureMessage(squashAtomCommandFailure(result)));
      setSalesBusy(false);
    },
    [environmentId, salesBusy, salesQuery, updateSalesProspect],
  );

  const importReadySalesProspects = useCallback(async () => {
    if (environmentId === null || selectedSpaceId === undefined || salesBusy) return;
    setSalesBusy(true);
    setSalesError(undefined);
    setSalesStatus(undefined);
    const result = await importSalesProspects({
      environmentId,
      input: { spaceId: selectedSpaceId, limit: 10 },
    });
    setSalesBusy(false);
    if (result._tag === "Success") {
      const { inspected, proposed, duplicates } = result.value;
      setSalesStatus(
        proposed > 0
          ? `Imported ${proposed} ready prospect${proposed === 1 ? "" : "s"}.`
          : inspected === 0
            ? "No importable ready records have complete public-contact provenance yet."
            : `No new prospects imported; ${duplicates} already ${duplicates === 1 ? "exists" : "exist"}.`,
      );
      salesQuery.refresh();
      return;
    }
    setSalesError(failureMessage(squashAtomCommandFailure(result)));
  }, [environmentId, importSalesProspects, salesBusy, salesQuery, selectedSpaceId]);

  const prepareSalesDraft = useCallback(
    async (prospect: SalesProspect): Promise<SalesDraftRequest | undefined> => {
      if (environmentId === null || salesBusy || bootstrap === null) return undefined;
      const connection = bootstrap.connections.find(
        (candidate) =>
          candidate.spaceId === prospect.spaceId &&
          candidate.capabilities.includes("cc.connections.google.gmail.drafts.create"),
      );
      if (connection === undefined) {
        setSalesError(
          "Enable the Space's dedicated Gmail draft connection before preparing outreach.",
        );
        return undefined;
      }
      setSalesBusy(true);
      setSalesError(undefined);
      const result = await requestSalesDraft({
        environmentId,
        input: {
          requestId: SalesDraftRequestId.make(randomUUID()),
          prospectId: prospect.id,
          spaceId: prospect.spaceId,
          connectionId: connection.id,
          expectedUpdatedAt: prospect.updatedAt,
        },
      });
      setSalesBusy(false);
      if (result._tag === "Success") return result.value.request;
      setSalesError(failureMessage(squashAtomCommandFailure(result)));
      return undefined;
    },
    [bootstrap, environmentId, requestSalesDraft, salesBusy],
  );

  const decideDraft = useCallback(
    async (request: SalesDraftRequest, decision: "approved" | "declined") => {
      if (environmentId === null || salesBusy) return undefined;
      setSalesBusy(true);
      setSalesError(undefined);
      const result = await decideSalesDraft({
        environmentId,
        input: {
          requestId: request.id,
          spaceId: request.spaceId,
          payloadDigest: request.payloadDigest,
          decision,
        },
      });
      setSalesBusy(false);
      if (result._tag === "Success") return result.value.request;
      setSalesError(failureMessage(squashAtomCommandFailure(result)));
      return undefined;
    },
    [decideSalesDraft, environmentId, salesBusy],
  );

  const createDraft = useCallback(
    async (request: SalesDraftRequest) => {
      if (environmentId === null || salesBusy) return undefined;
      setSalesBusy(true);
      setSalesError(undefined);
      const result = await createSalesDraft({
        environmentId,
        input: {
          requestId: request.id,
          spaceId: request.spaceId,
          payloadDigest: request.payloadDigest,
        },
      });
      setSalesBusy(false);
      if (result._tag === "Success") {
        salesQuery.refresh();
        return result.value.request;
      }
      setSalesError(failureMessage(squashAtomCommandFailure(result)));
      return undefined;
    },
    [createSalesDraft, environmentId, salesBusy, salesQuery],
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      {salesEnabled ? (
        <nav
          className="absolute left-1/2 top-3 z-40 flex -translate-x-1/2 rounded-full border bg-background/85 p-1 shadow-sm backdrop-blur-md"
          aria-label="Command Center destinations"
        >
          <button
            className={`rounded-full px-3 py-1 text-xs ${destination === "command" ? "bg-foreground text-background" : "text-muted-foreground"}`}
            onClick={() => setDestination("command")}
            type="button"
          >
            Command
          </button>
          <button
            className={`rounded-full px-3 py-1 text-xs ${destination === "pipeline" ? "bg-foreground text-background" : "text-muted-foreground"}`}
            onClick={() => setDestination("pipeline")}
            type="button"
          >
            Pipeline
          </button>
        </nav>
      ) : null}
      {destination === "pipeline" && salesEnabled ? (
        <SalesPipelineBoard
          busy={salesBusy}
          error={
            salesError ?? (salesQuery.error === null ? null : failureMessage(salesQuery.error))
          }
          loading={salesQuery.isPending}
          onCreateDraft={createDraft}
          onDecideDraft={decideDraft}
          onImport={() => {
            void importReadySalesProspects();
          }}
          onRefresh={salesQuery.refresh}
          onRequestDraft={prepareSalesDraft}
          onStageChange={(prospect, stage) => {
            void changeSalesStage(prospect, stage);
          }}
          prospects={salesQuery.data?.prospects ?? []}
          status={salesStatus}
          draftRequests={salesQuery.data?.draftRequests ?? []}
        />
      ) : (
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
          onNewConversation={newConversation}
          onDecideApproval={(approvalId, payloadDigest, decision) => {
            void resolveApproval(approvalId, payloadDigest, decision);
          }}
          onOpenLinkedThread={openLinkedThread}
          onOpenNeedsYouItem={openNeedsYouItem}
          onOpenRun={openRun}
          onOpenTodayItem={openTodayItem}
          onOpenConnection={() => {
            void navigate({ to: "/settings/connections" });
          }}
          onReviewMemory={(memoryId, spaceId, repositoryId, decision) => {
            void resolveMemory(memoryId, spaceId, repositoryId, decision);
          }}
          onRouteSelectionChange={changeRouteSelection}
          onSelectConversation={selectConversation}
          onSelectProject={selectProject}
          onSelectSpace={selectSpace}
          onSubmit={(command) => {
            void submit(command);
          }}
          projects={projects}
          routeReceipt={routeReceipt}
          routeOptions={routeOptions}
          routeSelection={routeSelection}
          resolvingNeedsYouId={resolvingNeedsYouId}
          selectedProjectId={routeSelection.projectId}
          selectedSpaceId={selectedSpaceId}
          spaces={projection.spaces}
        />
      )}
    </SidebarInset>
  );
}
