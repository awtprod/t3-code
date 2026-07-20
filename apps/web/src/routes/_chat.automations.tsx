import { createFileRoute } from "@tanstack/react-router";
import { AutomationNodeId, SpaceId } from "@command-center/core";
import {
  CommandCenterAutomationSourceDefinition,
  type CommandCenterAutomationDefinitionSnapshot,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import { useCallback, useMemo, useState } from "react";

import { AutomationsScreen } from "../command-center/automation/AutomationsScreen";
import { resolveAutomationsScreenStatus } from "../command-center/automation/AutomationsScreen.logic";
import { validateAutomationEditorDefinition } from "../command-center/automation/logic";
import type { AutomationEditorDefinition } from "../command-center/automation/types";
import { commandCenterEnvironment } from "../state/commandCenter";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";

const decodeSourceDefinition = Schema.decodeUnknownSync(CommandCenterAutomationSourceDefinition);

interface AutomationDraft {
  readonly definition: AutomationEditorDefinition;
  readonly baseDigest: string;
  readonly configCommitSha: string;
  readonly dirty: boolean;
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
    : "The local automation config commit could not be created.";
}

function AutomationsRouteView() {
  const environmentId = usePrimaryEnvironmentId();
  const [selectedAutomationId, setSelectedAutomationId] = useState<string>();
  const [drafts, setDrafts] = useState<Readonly<Record<string, AutomationDraft>>>({});
  const [savingAutomationId, setSavingAutomationId] = useState<string>();
  const [isCreating, setIsCreating] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const bootstrapQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : commandCenterEnvironment.bootstrap({ environmentId, input: {} }),
  );
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
      savingAutomationId !== undefined
    ) {
      return;
    }
    const blockingIssues = validateAutomationEditorDefinition(activeDefinition).filter(
      (issue) => (issue.severity ?? "error") === "error",
    );
    if (blockingIssues.length > 0) {
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
    setSavingAutomationId(selectedAutomation.id);
    setSaveError(null);
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
        [selectedAutomation.id]: {
          definition: editorDefinition(result.value),
          baseDigest: result.value.definitionDigest,
          configCommitSha: result.value.configCommitSha,
          dirty: false,
        },
      }));
      definitionQuery.refresh();
      bootstrapQuery.refresh();
    } else {
      setSaveError(saveFailureMessage(squashAtomCommandFailure(result)));
    }
    setSavingAutomationId(undefined);
  }, [
    activeDefinition,
    activeDraft?.baseDigest,
    bootstrapQuery,
    definitionQuery,
    environmentId,
    saveDefinition,
    savingAutomationId,
    selectedAutomation,
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

  const refresh = useCallback(() => {
    if (selectedId !== undefined) {
      setDrafts((current) => {
        const { [selectedId]: _discarded, ...rest } = current;
        return rest;
      });
    }
    setSaveError(null);
    definitionQuery.refresh();
    bootstrapQuery.refresh();
  }, [bootstrapQuery, definitionQuery, selectedId]);

  return (
    <AutomationsScreen
      authoringHealth={definitionQuery.data?.authoringHealth}
      automations={bootstrap?.automations ?? []}
      configCommitSha={
        activeDraft?.configCommitSha ?? definitionQuery.data?.configCommitSha ?? undefined
      }
      editorDefinition={activeDefinition}
      editorError={saveError ?? definitionQuery.error}
      editorStatus={editorStatus}
      isDirty={activeDraft?.dirty ?? false}
      isCreating={isCreating}
      isSaving={savingAutomationId === selectedAutomation?.id}
      onDefinitionChange={changeDefinition}
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

export const Route = createFileRoute("/_chat/automations")({
  component: AutomationsRouteView,
});
