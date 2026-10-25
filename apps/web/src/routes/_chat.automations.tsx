import { useAtomValue } from "@effect/atom-react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AutomationNodeId, SpaceId } from "@command-center/core";
import {
  AuthOrchestrationOperateScope,
  CommandCenterAutomationSourceDefinition,
  type EnvironmentId,
  type CommandCenterAutomationDefinitionSnapshot,
  type ScheduledTask,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  type AutomationEnvironmentOption,
  AutomationsScreen,
  type ScheduledTasksStatus,
} from "../command-center/automation/AutomationsScreen";
import {
  type AutomationEditorDraft,
  type AutomationsSelection,
  readPreferredAutomationEnvironmentId,
  reconcileAutomationDraftAfterSave,
  rememberPreferredAutomationEnvironmentId,
  resolveAutomationEnvironmentId,
  resolveAutomationsScreenStatus,
  resolveAutomationsSelection,
  shouldAutosaveAutomationDraft,
} from "../command-center/automation/AutomationsScreen.logic";
import type { AutomationEditorDefinition } from "../command-center/automation/types";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { commandCenterEnvironment } from "../state/commandCenter";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { readEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";

const decodeSourceDefinition = Schema.decodeUnknownSync(CommandCenterAutomationSourceDefinition);
const AUTOMATION_AUTOSAVE_DELAY_MS = 1_000;
const EMPTY_SCHEDULED_TASKS: ReadonlyArray<ScheduledTask> = [];

function automationCommandError(cause: unknown, fallback: string): Error {
  if (cause instanceof Error && cause.message.trim().length > 0) return cause;
  if (typeof cause === "string" && cause.trim().length > 0) return new Error(cause);
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string" &&
    cause.message.trim().length > 0
  ) {
    return new Error(cause.message);
  }
  return new Error(fallback);
}

let automationCreateRequestSequence = 0;
function nextAutomationCreateRequestId(): string {
  automationCreateRequestSequence += 1;
  return `ui:${Date.now().toString(36)}:${automationCreateRequestSequence.toString(36)}`;
}

function editorDefinition(
  snapshot: CommandCenterAutomationDefinitionSnapshot,
): AutomationEditorDefinition {
  return JSON.parse(JSON.stringify(snapshot.definition)) as AutomationEditorDefinition;
}

function saveFailureMessage(failure: unknown): string {
  return failure instanceof Error && failure.message.trim().length > 0
    ? failure.message
    : "The automation config commit could not be created on the selected environment.";
}

function reportScheduledTaskFailure(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : String(error),
    }),
  );
}

interface AutomationsEnvironmentRouteViewProps {
  readonly environmentId: EnvironmentId | null;
  readonly environmentOptions: ReadonlyArray<AutomationEnvironmentOption>;
  readonly onEnvironmentChange: (environmentId: EnvironmentId) => void;
}

function AutomationsEnvironmentRouteView({
  environmentId,
  environmentOptions,
  onEnvironmentChange,
}: AutomationsEnvironmentRouteViewProps) {
  const navigate = useNavigate();
  const [selection, setSelection] = useState<AutomationsSelection>();
  const [drafts, setDrafts] = useState<Readonly<Record<string, AutomationEditorDraft>>>({});
  const [savingAutomationId, setSavingAutomationId] = useState<string>();
  const savingAutomationIdRef = useRef<string | undefined>(undefined);
  const [isCreating, setIsCreating] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [busyScheduledTaskId, setBusyScheduledTaskId] = useState<string | null>(null);
  const bootstrapQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : commandCenterEnvironment.bootstrap({ environmentId, input: {} }),
  );
  const eventQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : commandCenterEnvironment.events({
          environmentId,
          input: { afterSequence: 0, batchSize: 200 },
        }),
  );
  // Live: the scheduler pushes run status and next-run changes as they happen.
  const scheduledTasksQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  const canOperateScheduledTasks = useAtomValue(
    serverEnvironment.runScheduledTaskNow.permissionAtom(environmentId),
  );
  const lastRefreshSequence = useRef(0);
  useEffect(() => {
    const sequence = eventQuery.data?.sequence;
    if (sequence === undefined || sequence <= lastRefreshSequence.current) return;
    lastRefreshSequence.current = sequence;
    bootstrapQuery.refresh();
  }, [bootstrapQuery.refresh, eventQuery.data?.sequence]);
  const bootstrap = bootstrapQuery.data;
  const automations = bootstrap?.automations;
  const runs = bootstrap?.runs;
  const scheduledTasks = scheduledTasksQuery.data?.tasks ?? EMPTY_SCHEDULED_TASKS;
  const scheduledTasksStatus: ScheduledTasksStatus =
    scheduledTasksQuery.data !== null
      ? "ready"
      : scheduledTasksQuery.error !== null
        ? "unavailable"
        : "loading";
  const resolvedSelection = useMemo(
    () =>
      resolveAutomationsSelection(selection, {
        tasks: scheduledTasks,
        automations: automations ?? [],
        runs: runs ?? [],
      }),
    [automations, runs, scheduledTasks, selection],
  );
  const selectedAutomation = useMemo(
    () =>
      resolvedSelection?.kind === "automation"
        ? automations?.find((automation) => automation.id === resolvedSelection.id)
        : undefined,
    [automations, resolvedSelection],
  );
  // Pin whatever the page opened on. The live task list changes health under the
  // user, and a fallback that kept re-resolving would swap the open item mid-read
  // or mid-edit. Only an empty selection is pinned: a chosen item that is briefly
  // absent (an automation created a moment ago, until the bootstrap refresh lists
  // it) shows the fallback meanwhile and is opened as soon as it appears. Setting
  // state during render is React's pattern for deriving state from data; it
  // re-renders once and cannot loop, since the selection is non-empty afterwards.
  if (selection === undefined && resolvedSelection !== undefined) {
    setSelection(resolvedSelection);
  }
  const definitionQuery = useEnvironmentQuery(
    environmentId === null || selectedAutomation === undefined
      ? null
      : commandCenterEnvironment.automationDefinition({
          environmentId,
          input: {
            automationId: selectedAutomation.id,
            spaceId: selectedAutomation.spaceId,
          },
        }),
  );
  const saveDefinition = useAtomCommand(commandCenterEnvironment.saveAutomationDefinition, {
    reportFailure: false,
  });
  const createDefinition = useAtomCommand(commandCenterEnvironment.createAutomationDefinition, {
    reportFailure: false,
  });
  const interpretSchedule = useAtomCommand(commandCenterEnvironment.interpretAutomationSchedule, {
    reportFailure: false,
  });
  const beginGoogleConnectionSetup = useAtomCommand(
    commandCenterEnvironment.beginGoogleConnectionSetup,
    { reportFailure: false },
  );
  const completeGoogleConnectionSetup = useAtomCommand(
    commandCenterEnvironment.completeGoogleConnectionSetup,
    { reportFailure: false },
  );
  const removeGoogleConnection = useAtomCommand(commandCenterEnvironment.removeGoogleConnection, {
    reportFailure: false,
  });
  const syncSpaces = useAtomCommand(commandCenterEnvironment.syncSpaces, { reportFailure: false });
  const setScheduledTaskEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "automations scheduled task toggle",
  });
  const runScheduledTaskNow = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "automations scheduled task run now",
  });
  const status = resolveAutomationsScreenStatus({
    connected: environmentId !== null,
    isPending: bootstrapQuery.isPending,
    hasData: bootstrap !== null,
    hasError: bootstrapQuery.error !== null,
    ...(bootstrap === null ? {} : { configStatus: bootstrap.configHealth.status }),
  });
  const selectedId = selectedAutomation?.id;
  const activeDraft = selectedId === undefined ? undefined : drafts[selectedId];
  const activeDefinition =
    activeDraft?.definition ??
    (definitionQuery.data === null ? null : editorDefinition(definitionQuery.data));
  const editorStatus =
    selectedAutomation === undefined
      ? "unavailable"
      : definitionQuery.data !== null
        ? "ready"
        : definitionQuery.isPending
          ? "loading"
          : "unavailable";
  const authoringUnavailable =
    (definitionQuery.data?.authoringHealth ?? bootstrap?.authoringHealth)?.status === "unavailable";

  const changeDefinition = useCallback(
    (definition: AutomationEditorDefinition) => {
      if (selectedId === undefined || definitionQuery.data === null) return;
      setDrafts((current) => ({
        ...current,
        [selectedId]: {
          definition,
          baseDigest: current[selectedId]?.baseDigest ?? definitionQuery.data!.definitionDigest,
          configCommitSha:
            current[selectedId]?.configCommitSha ?? definitionQuery.data!.configCommitSha,
          dirty: true,
          revision: (current[selectedId]?.revision ?? 0) + 1,
        },
      }));
      setSaveError(null);
    },
    [definitionQuery.data, selectedId],
  );

  const save = useCallback(async () => {
    if (
      environmentId === null ||
      selectedAutomation === undefined ||
      activeDefinition === null ||
      definitionQuery.data === null ||
      savingAutomationIdRef.current !== undefined
    ) {
      return;
    }
    let sourceDefinition: CommandCenterAutomationSourceDefinition;
    try {
      sourceDefinition = decodeSourceDefinition(activeDefinition);
    } catch (cause) {
      setSaveError(saveFailureMessage(cause));
      return;
    }

    const baseDigest = activeDraft?.baseDigest ?? definitionQuery.data.definitionDigest;
    const submittedRevision = activeDraft?.revision ?? 0;
    savingAutomationIdRef.current = selectedAutomation.id;
    setSavingAutomationId(selectedAutomation.id);
    setSaveError(null);
    try {
      const result = await saveDefinition({
        environmentId,
        input: {
          automationId: selectedAutomation.id,
          spaceId: selectedAutomation.spaceId,
          expectedDefinitionDigest: baseDigest,
          definition: sourceDefinition,
        },
      });
      if (result._tag === "Success") {
        setDrafts((current) => ({
          ...current,
          [selectedAutomation.id]: reconcileAutomationDraftAfterSave({
            currentDraft: current[selectedAutomation.id],
            submittedRevision,
            savedDefinition: editorDefinition(result.value),
            savedDefinitionDigest: result.value.definitionDigest,
            savedConfigCommitSha: result.value.configCommitSha,
          }),
        }));
        definitionQuery.refresh();
        bootstrapQuery.refresh();
      } else {
        setSaveError(saveFailureMessage(squashAtomCommandFailure(result)));
      }
    } catch (cause) {
      setSaveError(saveFailureMessage(cause));
    } finally {
      savingAutomationIdRef.current = undefined;
      setSavingAutomationId(undefined);
    }
  }, [
    activeDefinition,
    activeDraft?.baseDigest,
    activeDraft?.revision,
    bootstrapQuery.refresh,
    definitionQuery.data,
    definitionQuery.refresh,
    environmentId,
    saveDefinition,
    selectedAutomation,
  ]);

  useEffect(() => {
    if (
      !shouldAutosaveAutomationDraft({
        dirty: activeDraft?.dirty ?? false,
        isSaving: savingAutomationId !== undefined,
        hasSaveError: saveError !== null,
        authoringUnavailable,
      })
    ) {
      return;
    }
    const timeout = window.setTimeout(() => {
      void save();
    }, AUTOMATION_AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [
    activeDraft?.dirty,
    activeDraft?.revision,
    authoringUnavailable,
    save,
    saveError,
    savingAutomationId,
  ]);

  const create = useCallback(
    async (input: { readonly name: string; readonly spaceId: string }) => {
      if (environmentId === null || isCreating) return;
      setIsCreating(true);
      setSaveError(null);
      const requestId = nextAutomationCreateRequestId();
      const result = await createDefinition({
        environmentId,
        input: {
          requestId,
          spaceId: SpaceId.make(input.spaceId),
          name: input.name,
          enabled: false,
          trigger: { kind: "manual" },
          nodes: [
            {
              id: AutomationNodeId.make("start"),
              kind: "transform",
              config: { template: "Describe this automation's first step" },
            },
          ],
          edges: [],
          layout: { nodes: { start: { x: 80, y: 120 } } },
        },
      });
      if (result._tag === "Success") {
        const snapshot = result.value;
        setSelection({ kind: "automation", id: snapshot.automationId });
        setDrafts((current) => ({
          ...current,
          [snapshot.automationId]: {
            definition: editorDefinition(snapshot),
            baseDigest: snapshot.definitionDigest,
            configCommitSha: snapshot.configCommitSha,
            dirty: false,
            revision: 0,
          },
        }));
        bootstrapQuery.refresh();
      } else {
        setSaveError(saveFailureMessage(squashAtomCommandFailure(result)));
      }
      setIsCreating(false);
    },
    [bootstrapQuery, createDefinition, environmentId, isCreating],
  );

  const refresh = useCallback(async () => {
    if (isRefreshing || environmentId === null) return;
    setIsRefreshing(true);
    setRefreshError(null);
    const result = await syncSpaces({ environmentId, input: {} });
    if (result._tag !== "Success") {
      setRefreshError(
        "Could not recheck the private configuration. Try again after the environment is reachable.",
      );
      setIsRefreshing(false);
      return;
    }
    if (selectedId !== undefined) {
      setDrafts((current) => {
        const { [selectedId]: _discarded, ...rest } = current;
        return rest;
      });
    }
    setSaveError(null);
    definitionQuery.refresh();
    bootstrapQuery.refresh();
    setIsRefreshing(false);
  }, [bootstrapQuery, definitionQuery, environmentId, isRefreshing, selectedId, syncSpaces]);

  const operateScheduledTask = useCallback(
    async (
      task: ScheduledTask,
      action: { readonly kind: "run" } | { readonly kind: "enable"; readonly enabled: boolean },
    ) => {
      if (
        environmentId === null ||
        busyScheduledTaskId !== null ||
        !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
      ) {
        return;
      }
      setBusyScheduledTaskId(task.id);
      // Partial update: only the enabled flag changes, so a toggle can never
      // revert concurrent edits made to the task elsewhere.
      const result =
        action.kind === "run"
          ? await runScheduledTaskNow({ environmentId, input: { id: task.id } })
          : await setScheduledTaskEnabled({
              environmentId,
              input: { id: task.id, enabled: action.enabled },
            });
      setBusyScheduledTaskId(null);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        reportScheduledTaskFailure(
          action.kind === "run" ? "Could not run the task" : "Could not update the task",
          squashAtomCommandFailure(result),
        );
      }
    },
    [busyScheduledTaskId, environmentId, runScheduledTaskNow, setScheduledTaskEnabled],
  );

  return (
    <AutomationsScreen
      authoringHealth={definitionQuery.data?.authoringHealth ?? bootstrap?.authoringHealth}
      automations={automations ?? []}
      busyScheduledTaskId={busyScheduledTaskId}
      canOperateScheduledTasks={canOperateScheduledTasks}
      connections={bootstrap?.connections ?? []}
      configCommitSha={
        activeDraft?.configCommitSha ?? definitionQuery.data?.configCommitSha ?? undefined
      }
      editorDefinition={activeDefinition}
      editorError={saveError ?? definitionQuery.error}
      editorStatus={editorStatus}
      environmentId={environmentId}
      environmentTimezone={bootstrap?.timezone}
      environmentOptions={environmentOptions}
      hasUnsavedChanges={Object.values(drafts).some(({ dirty }) => dirty)}
      isDirty={activeDraft?.dirty ?? false}
      isCreating={isCreating}
      isSaving={savingAutomationId === selectedAutomation?.id}
      isRefreshing={isRefreshing}
      refreshError={refreshError}
      runs={runs}
      scheduledTasks={scheduledTasks}
      scheduledTasksError={scheduledTasksQuery.error}
      scheduledTasksStatus={scheduledTasksStatus}
      onDefinitionChange={changeDefinition}
      onBeginGoogleConnectionSetup={async (input) => {
        if (environmentId === null || selectedAutomation === undefined) {
          throw new Error("Choose an automation environment before connecting Google.");
        }
        const result = await beginGoogleConnectionSetup({
          environmentId,
          input: { ...input, spaceId: selectedAutomation.spaceId },
        });
        if (result._tag === "Success") return result.value;
        throw automationCommandError(
          squashAtomCommandFailure(result),
          "Google setup could not be started.",
        );
      }}
      onCompleteGoogleConnectionSetup={async (input) => {
        if (environmentId === null) {
          throw new Error("Choose an automation environment before connecting Google.");
        }
        const result = await completeGoogleConnectionSetup({ environmentId, input });
        if (result._tag === "Success") {
          bootstrapQuery.refresh();
          return result.value;
        }
        throw automationCommandError(
          squashAtomCommandFailure(result),
          "Google authorization could not finish.",
        );
      }}
      onRemoveGoogleConnection={async (input) => {
        if (environmentId === null || selectedAutomation === undefined) {
          throw new Error("Choose an automation environment before removing Google.");
        }
        const result = await removeGoogleConnection({
          environmentId,
          input: { ...input, spaceId: selectedAutomation.spaceId },
        });
        if (result._tag === "Success") {
          bootstrapQuery.refresh();
          return result.value;
        }
        throw automationCommandError(
          squashAtomCommandFailure(result),
          "The Google account could not be removed.",
        );
      }}
      onEnvironmentChange={onEnvironmentChange}
      onInterpretSchedule={async ({ text, timezone }) => {
        if (environmentId === null || selectedAutomation === undefined) {
          throw new Error("Choose an automation environment before interpreting a schedule.");
        }
        const result = await interpretSchedule({
          environmentId,
          input: { spaceId: selectedAutomation.spaceId, text, timezone },
        });
        if (result._tag === "Success") return result.value;
        throw squashAtomCommandFailure(result);
      }}
      onCreate={(input) => {
        void create(input);
      }}
      onRefresh={refresh}
      onSave={() => {
        void save();
      }}
      onSelect={(next) => {
        setSelection(next);
        setSaveError(null);
      }}
      onRunScheduledTaskNow={(task) => {
        void operateScheduledTask(task, { kind: "run" });
      }}
      onSetScheduledTaskEnabled={(task, enabled) => {
        void operateScheduledTask(task, { kind: "enable", enabled });
      }}
      onOpenScheduledTaskThread={(task) => {
        if (environmentId === null || task.threadId === null) return;
        void navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId, threadId: task.threadId },
        });
      }}
      onEditScheduledTask={(task) => {
        if (environmentId === null) return;
        void navigate({
          to: "/settings/scheduled-tasks",
          search: { environmentId, taskId: task.id },
        });
      }}
      onOpenScheduledTasksSettings={() => {
        void navigate({
          to: "/settings/scheduled-tasks",
          search: environmentId === null ? {} : { environmentId },
        });
      }}
      selection={resolvedSelection}
      spaces={bootstrap?.spaces ?? []}
      status={status}
    />
  );
}

function AutomationsRouteView() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const [requestedEnvironmentId, setRequestedEnvironmentId] = useState(
    readPreferredAutomationEnvironmentId,
  );
  const environmentOptions = useMemo<ReadonlyArray<AutomationEnvironmentOption>>(
    () =>
      environments
        .map((environment) => ({
          id: environment.environmentId,
          label: environment.label,
          isPrimary: environment.entry.target._tag === "PrimaryConnectionTarget",
          platformOs: environment.serverConfig?.environment.platform.os ?? "unknown",
        }))
        .sort(
          (left, right) =>
            Number(left.isPrimary) - Number(right.isPrimary) ||
            left.label.localeCompare(right.label),
        ),
    [environments],
  );
  const environmentId = resolveAutomationEnvironmentId({
    requestedEnvironmentId,
    primaryEnvironmentId,
    environments: environmentOptions,
  });
  const selectEnvironment = useCallback((nextEnvironmentId: EnvironmentId) => {
    setRequestedEnvironmentId(nextEnvironmentId);
    rememberPreferredAutomationEnvironmentId(nextEnvironmentId);
  }, []);

  return (
    <AutomationsEnvironmentRouteView
      environmentId={environmentId}
      environmentOptions={environmentOptions}
      key={environmentId ?? "no-environment"}
      onEnvironmentChange={selectEnvironment}
    />
  );
}

export const Route = createFileRoute("/_chat/automations")({
  component: AutomationsRouteView,
});
