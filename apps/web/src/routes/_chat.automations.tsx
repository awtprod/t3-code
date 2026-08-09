import { createFileRoute } from "@tanstack/react-router";
import { AutomationNodeId, SpaceId } from "@command-center/core";
import {
  CommandCenterAutomationSourceDefinition,
  type EnvironmentId,
  type CommandCenterAutomationDefinitionSnapshot,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  type AutomationEnvironmentOption,
  AutomationsScreen,
} from "../command-center/automation/AutomationsScreen";
import {
  type AutomationEditorDraft,
  readPreferredAutomationEnvironmentId,
  reconcileAutomationDraftAfterSave,
  rememberPreferredAutomationEnvironmentId,
  resolveAutomationEnvironmentId,
  resolveAutomationsScreenStatus,
  shouldAutosaveAutomationDraft,
} from "../command-center/automation/AutomationsScreen.logic";
import { validateAutomationEditorDefinition } from "../command-center/automation/logic";
import type { AutomationEditorDefinition } from "../command-center/automation/types";
import { commandCenterEnvironment } from "../state/commandCenter";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";

const decodeSourceDefinition = Schema.decodeUnknownSync(CommandCenterAutomationSourceDefinition);
const AUTOMATION_AUTOSAVE_DELAY_MS = 1_000;

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
  const [selectedAutomationId, setSelectedAutomationId] = useState<string>();
  const [drafts, setDrafts] = useState<Readonly<Record<string, AutomationEditorDraft>>>({});
  const [savingAutomationId, setSavingAutomationId] = useState<string>();
  const savingAutomationIdRef = useRef<string | undefined>(undefined);
  const [isCreating, setIsCreating] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
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
  const lastRefreshSequence = useRef(0);
  useEffect(() => {
    const sequence = eventQuery.data?.sequence;
    if (sequence === undefined || sequence <= lastRefreshSequence.current) return;
    lastRefreshSequence.current = sequence;
    bootstrapQuery.refresh();
  }, [bootstrapQuery.refresh, eventQuery.data?.sequence]);
  const bootstrap = bootstrapQuery.data;
  const selectedAutomation = useMemo(
    () =>
      bootstrap?.automations.find((automation) => automation.id === selectedAutomationId) ??
      bootstrap?.automations[0],
    [bootstrap?.automations, selectedAutomationId],
  );
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
  const activeBlockingIssueCount = useMemo(
    () =>
      activeDefinition === null
        ? 0
        : validateAutomationEditorDefinition(activeDefinition).filter(
            (issue) => (issue.severity ?? "error") === "error",
          ).length,
    [activeDefinition],
  );
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
    if (activeBlockingIssueCount > 0) {
      setSaveError("Fix the blocking graph validation issues before saving.");
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
    activeBlockingIssueCount,
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
        hasBlockingIssues: activeBlockingIssueCount > 0,
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
    activeBlockingIssueCount,
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
        setSelectedAutomationId(snapshot.automationId);
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

  return (
    <AutomationsScreen
      authoringHealth={definitionQuery.data?.authoringHealth ?? bootstrap?.authoringHealth}
      automations={bootstrap?.automations ?? []}
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
        throw squashAtomCommandFailure(result);
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
        throw squashAtomCommandFailure(result);
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
        throw squashAtomCommandFailure(result);
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
      onSelectAutomation={(automationId) => {
        setSelectedAutomationId(automationId);
        setSaveError(null);
      }}
      selectedAutomationId={selectedAutomation?.id}
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
