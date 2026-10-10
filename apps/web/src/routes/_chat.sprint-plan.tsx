import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { SPRINT_PLAN_IMPORT_LIMITS } from "@command-center/core";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  CommandCenterSprintPlanConflictDecision,
  CommandCenterSprintPlanPreviewImportResult,
  CommandCenterSprintPlanSnapshot,
  EnvironmentId,
} from "@t3tools/contracts";
import { ArrowRightIcon, RefreshCwIcon, UploadIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { SidebarInset } from "../components/ui/sidebar";
import { Textarea } from "../components/ui/textarea";
import {
  completeImportDecisions,
  conflictDecisionKey,
  nextPlanWeeks,
  planCarryovers,
  planOwners,
  planProgress,
  taskAnchor,
  visiblePlanTasks,
  type Task,
} from "../command-center/sprint-plan/SprintPlan.logic";
import { commandCenterEnvironment } from "../state/commandCenter";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { randomUUID } from "../lib/utils";

type PlanView = "current" | "original";
type EditableField = "note" | "day" | "done";

function errorMessage(failure: unknown): string {
  const message = failure instanceof Error ? failure.message : String(failure);
  return message.trim() || "The sprint plan request failed. Try again.";
}

function nextMutationId(): string {
  return `plan-ui:${randomUUID()}`;
}

function StateCard({ children }: { readonly children: ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card p-5 text-sm">{children}</section>
  );
}

function ImportDecisionHistory({ after }: { readonly after: unknown }) {
  if (after === null || typeof after !== "object" || Array.isArray(after)) return null;
  const record = after as Record<string, unknown>;
  const count = record.decisionCount;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1) return null;
  const choices = Array.isArray(record.decisions) ? record.decisions : [];
  return (
    <div className="mt-1 text-muted-foreground">
      <p>
        {count} reviewed conflict decision{count === 1 ? "" : "s"}
      </p>
      {choices.length > 0 && (
        <ul className="mt-1 list-inside list-disc">
          {choices.map((choice) => {
            if (choice === null || typeof choice !== "object") return null;
            const item = choice as Record<string, unknown>;
            if (
              typeof item.taskId !== "string" ||
              typeof item.field !== "string" ||
              (item.decision !== "keep-current" && item.decision !== "use-incoming")
            )
              return null;
            return (
              <li key={conflictDecisionKey(item.taskId, item.field)}>
                {item.taskId}.{item.field}:{" "}
                {item.decision === "keep-current" ? "kept current" : "used incoming"}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function TaskEditor({
  task,
  snapshot,
  isSaving,
  onSave,
  onCancel,
}: {
  readonly task: Task;
  readonly snapshot: CommandCenterSprintPlanSnapshot;
  readonly isSaving: boolean;
  readonly onSave: (field: EditableField, after: string | boolean, reason: string) => void;
  readonly onCancel: () => void;
}) {
  const [field, setField] = useState<EditableField>("note");
  const [note, setNote] = useState(task.note);
  const [day, setDay] = useState(task.day);
  const [done, setDone] = useState(task.done);
  const [reason, setReason] = useState("");
  const changed =
    field === "note" ? note !== task.note : field === "day" ? day !== task.day : done !== task.done;

  return (
    <div className="mt-4 rounded-lg border border-border bg-muted/25 p-4">
      <p className="text-sm font-semibold">Edit this task</p>
      <p className="mt-1 text-sm text-muted-foreground">
        Saving checks plan version {snapshot.version} and the exact current field value. If another
        edit lands first, refresh and review it before retrying.
      </p>
      <div className="mt-3 flex flex-wrap gap-2" aria-label="Task field">
        {(["note", "day", "done"] as const).map((choice) => (
          <Button
            aria-pressed={field === choice}
            key={choice}
            onClick={() => setField(choice)}
            size="sm"
            variant={field === choice ? "default" : "outline"}
          >
            {choice === "done" ? "Completion" : choice === "day" ? "Day" : "Note"}
          </Button>
        ))}
      </div>
      {field === "note" ? (
        <label className="mt-4 block text-sm font-medium">
          Note
          <Textarea
            className="mt-1 min-h-24"
            maxLength={8_192}
            onChange={(event) => setNote(event.target.value)}
            value={note}
          />
        </label>
      ) : field === "day" ? (
        <label className="mt-4 block text-sm font-medium">
          Day label
          <Input
            className="mt-1 min-h-11 sm:min-h-8"
            maxLength={8_192}
            onChange={(event) => setDay(event.target.value)}
            value={day}
          />
        </label>
      ) : (
        <label className="mt-4 flex min-h-11 items-center gap-3 text-sm font-medium">
          <input
            checked={done}
            className="size-5 accent-primary"
            onChange={(event) => setDone(event.target.checked)}
            type="checkbox"
          />
          Completed
        </label>
      )}
      <label className="mt-4 block text-sm font-medium">
        Reason for this change
        <Textarea
          className="mt-1 min-h-20"
          maxLength={4_096}
          onChange={(event) => setReason(event.target.value)}
          placeholder="What changed, or why are you reversing completion?"
          value={reason}
        />
      </label>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          disabled={
            !changed ||
            reason.trim().length === 0 ||
            (field === "day" && day.trim().length === 0) ||
            isSaving
          }
          onClick={() =>
            onSave(field, field === "note" ? note : field === "day" ? day : done, reason.trim())
          }
        >
          {isSaving ? "Saving…" : "Save exact field"}
        </Button>
        <Button disabled={isSaving} onClick={onCancel} variant="outline">
          Cancel
        </Button>
      </div>
    </div>
  );
}

function SprintPlanRouteView() {
  const navigate = useNavigate();
  const search = Route.useSearch();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const environmentId: EnvironmentId | null =
    primaryEnvironmentId ??
    environments.find((environment) => environment.connection.phase === "connected")
      ?.environmentId ??
    null;
  const bootstrap = useEnvironmentQuery(
    environmentId === null
      ? null
      : commandCenterEnvironment.bootstrap({ environmentId, input: {} }),
  );
  const spaceId = bootstrap.data?.spaces.some((space) => space.id === search.spaceId)
    ? search.spaceId!
    : bootstrap.data?.spaces[0]?.id;
  const [cursor, setCursor] = useState<{ updatedAt: string; planId: string }>();
  const [priorCursors, setPriorCursors] = useState<
    readonly ({ updatedAt: string; planId: string } | undefined)[]
  >([]);
  const list = useEnvironmentQuery(
    environmentId === null || spaceId === undefined
      ? null
      : commandCenterEnvironment.sprintPlans({
          environmentId,
          input: { spaceId, limit: 25, ...(cursor === undefined ? {} : { cursor }) },
        }),
  );
  const planId = search.planId ?? list.data?.plans[0]?.id;
  const current = useEnvironmentQuery(
    environmentId === null || spaceId === undefined || planId === undefined
      ? null
      : commandCenterEnvironment.sprintPlanCurrent({ environmentId, input: { spaceId, planId } }),
  );
  const view: PlanView = search.view === "original" ? "original" : "current";
  const original = useEnvironmentQuery(
    environmentId === null || spaceId === undefined || planId === undefined || view !== "original"
      ? null
      : commandCenterEnvironment.sprintPlanOriginal({ environmentId, input: { spaceId, planId } }),
  );
  const [historyCursor, setHistoryCursor] = useState<number>();
  const history = useEnvironmentQuery(
    environmentId === null || spaceId === undefined || planId === undefined
      ? null
      : commandCenterEnvironment.sprintPlanHistory({
          environmentId,
          input: {
            spaceId,
            planId,
            limit: 25,
            ...(historyCursor === undefined ? {} : { beforeSequence: historyCursor }),
          },
        }),
  );
  const source = view === "original" ? original.data?.original : current.data?.current;
  const [weekId, setWeekId] = useState("all");
  const [owner, setOwner] = useState("all");
  const [taskPage, setTaskPage] = useState(0);
  const [editingTaskId, setEditingTaskId] = useState<string>();
  const [savingTaskId, setSavingTaskId] = useState<string>();
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [showSourceJson, setShowSourceJson] = useState(false);
  const [importFileName, setImportFileName] = useState("");
  const [importPlanId, setImportPlanId] = useState("");
  const [importJson, setImportJson] = useState("");
  const [preview, setPreview] = useState<CommandCenterSprintPlanPreviewImportResult | null>(null);
  const [conflictDecisions, setConflictDecisions] = useState<
    Record<string, CommandCenterSprintPlanConflictDecision["decision"]>
  >({});
  const [importBusy, setImportBusy] = useState(false);
  const inFlight = useRef(false);
  const importRevision = useRef(0);
  const importScope = JSON.stringify([spaceId, planId]);
  const priorImportScope = useRef(importScope);
  const previewImport = useAtomCommand(commandCenterEnvironment.previewSprintPlanImport, {
    reportFailure: false,
  });
  const applyImport = useAtomCommand(commandCenterEnvironment.applySprintPlanImport, {
    reportFailure: false,
  });
  const patchTask = useAtomCommand(commandCenterEnvironment.patchSprintPlanTask, {
    reportFailure: false,
  });
  const resolveDate = useAtomCommand(commandCenterEnvironment.resolveSprintPlanDateConflict, {
    reportFailure: false,
  });
  const today = new Date().toISOString().slice(0, 10);
  const tasks = useMemo(
    () => (source === undefined ? [] : visiblePlanTasks(source, weekId, owner)),
    [source, weekId, owner],
  );
  const pageTasks = tasks.slice(taskPage * 100, (taskPage + 1) * 100);
  const selectedTask = source?.weeks
    .flatMap((week) => week.tasks)
    .find((task) => task.id === search.taskId);
  const conflictIds = new Set(
    current.data?.baselineNormalized.dateConflicts.map((conflict) => conflict.taskId),
  );
  const dateResolutions = new Map(
    current.data?.dateResolutions.map((resolution) => [resolution.taskId, resolution]),
  );

  useEffect(() => {
    if (priorImportScope.current === importScope) return;
    priorImportScope.current = importScope;
    importRevision.current++;
    setPreview(null);
    setConflictDecisions({});
  }, [importScope]);

  useEffect(() => {
    if (tasks.length > 0 && taskPage * 100 >= tasks.length) {
      setTaskPage(Math.floor((tasks.length - 1) / 100));
    }
  }, [tasks.length, taskPage]);

  useEffect(() => {
    if (search.taskId === undefined || source === undefined) return;
    const task = source.weeks
      .flatMap((week) => week.tasks)
      .find((entry) => entry.id === search.taskId);
    if (task === undefined) return;
    if (
      (weekId !== "all" &&
        !source.weeks.some(
          (week) => week.id === weekId && week.tasks.some((entry) => entry.id === task.id),
        )) ||
      (owner !== "all" && owner !== task.owner)
    ) {
      setWeekId("all");
      setOwner("all");
      return;
    }
    const index = tasks.findIndex(({ task: entry }) => entry.id === task.id);
    const targetPage = Math.floor(index / 100);
    if (targetPage !== taskPage) {
      setTaskPage(targetPage);
      return;
    }
    const target = document.getElementById(taskAnchor(search.taskId));
    target?.scrollIntoView({ block: "center" });
    target?.focus({ preventScroll: true });
  }, [search.taskId, source, weekId, owner, tasks, taskPage]);

  const select = (change: Partial<typeof search>) => {
    void navigate({ to: "/sprint-plan", search: { ...search, ...change }, replace: true });
  };
  const refresh = () => {
    setActionError(null);
    bootstrap.refresh();
    list.refresh();
    current.refresh();
    original.refresh();
    history.refresh();
  };
  const chooseSpace = (next: string) => {
    setCursor(undefined);
    setPriorCursors([]);
    setHistoryCursor(undefined);
    setWeekId("all");
    setOwner("all");
    setTaskPage(0);
    setPreview(null);
    setConflictDecisions({});
    setImportPlanId("");
    importRevision.current++;
    select({ spaceId: next, planId: undefined, taskId: undefined });
  };
  const choosePlan = (next: string) => {
    setHistoryCursor(undefined);
    setWeekId("all");
    setOwner("all");
    setTaskPage(0);
    setPreview(null);
    setConflictDecisions({});
    setImportPlanId(next);
    importRevision.current++;
    select({ planId: next, taskId: undefined });
  };

  const readFile = async (file: File | undefined) => {
    const revision = ++importRevision.current;
    setPreview(null);
    setConflictDecisions({});
    setActionError(null);
    setImportJson("");
    setImportFileName("");
    if (file === undefined) return;
    if (file.size > SPRINT_PLAN_IMPORT_LIMITS.bytes) {
      setActionError(
        `Source exceeds the ${Math.round(SPRINT_PLAN_IMPORT_LIMITS.bytes / 1024)} KB import limit.`,
      );
      return;
    }
    try {
      const value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        await file.arrayBuffer(),
      );
      if (new TextEncoder().encode(value).byteLength > SPRINT_PLAN_IMPORT_LIMITS.bytes)
        throw new Error("Source exceeds the import limit.");
      if (importRevision.current === revision) {
        setImportJson(value);
        setImportFileName(file.name);
      }
    } catch (failure) {
      if (importRevision.current === revision) setActionError(errorMessage(failure));
    }
  };
  const previewSource = async () => {
    if (
      environmentId === null ||
      spaceId === undefined ||
      importJson.length === 0 ||
      inFlight.current
    )
      return;
    inFlight.current = true;
    setImportBusy(true);
    setActionError(null);
    setPreview(null);
    setConflictDecisions({});
    const revision = importRevision.current;
    try {
      const result = await previewImport({
        environmentId,
        input: {
          spaceId,
          planId: importPlanId.trim() || planId || `plan:${spaceId}`,
          sourceJson: importJson,
        },
      });
      if (result._tag !== "Success") throw squashAtomCommandFailure(result);
      if (importRevision.current === revision) setPreview(result.value);
    } catch (failure) {
      if (importRevision.current === revision) setActionError(errorMessage(failure));
    } finally {
      inFlight.current = false;
      setImportBusy(false);
    }
  };
  const applySource = async () => {
    const choices =
      preview === null ? null : completeImportDecisions(preview.conflicts, conflictDecisions);
    if (
      environmentId === null ||
      spaceId === undefined ||
      preview === null ||
      choices === null ||
      preview.unchangedSource ||
      inFlight.current
    )
      return;
    inFlight.current = true;
    setImportBusy(true);
    setActionError(null);
    try {
      const safeFileName =
        importFileName.length <= 240 &&
        importFileName.trim() === importFileName &&
        importFileName !== "." &&
        importFileName !== ".." &&
        !/[\\/]/.test(importFileName) &&
        [...importFileName].every((character) => {
          const code = character.charCodeAt(0);
          return code > 31 && code !== 127;
        })
          ? importFileName
          : "";
      const result = await applyImport({
        environmentId,
        input: {
          spaceId,
          planId: preview.planId,
          sourceJson: importJson,
          provenance: {
            sourceRef: "upload:sprint-plan-json",
            ...(safeFileName === "" ? {} : { originalFileName: safeFileName }),
          },
          expectedVersion: preview.existingVersion ?? 0,
          mutationId: nextMutationId(),
          conflictDecisions: choices,
        },
      });
      if (result._tag !== "Success") throw squashAtomCommandFailure(result);
      setActionNotice(`Imported source at plan version ${result.value.version}.`);
      setPreview(null);
      setConflictDecisions({});
      setImportOpen(false);
      setHistoryCursor(undefined);
      select({ planId: result.value.id, view: "current" });
      refresh();
    } catch (failure) {
      setActionError(errorMessage(failure));
      setPreview(null);
      setConflictDecisions({});
    } finally {
      inFlight.current = false;
      setImportBusy(false);
    }
  };
  const saveTask = async (
    task: Task,
    field: EditableField,
    after: string | boolean,
    reason: string,
  ) => {
    if (
      environmentId === null ||
      spaceId === undefined ||
      current.data === null ||
      inFlight.current
    )
      return;
    inFlight.current = true;
    setSavingTaskId(task.id);
    setActionError(null);
    try {
      const base = {
        planId: current.data.id,
        spaceId,
        taskId: task.id,
        expectedVersion: current.data.version,
        mutationId: nextMutationId(),
        provenance: { kind: "manual" as const, sourceRef: "sprint-plan-web" },
        reason,
      };
      const input =
        field === "done"
          ? { ...base, field, before: task.done, after: after as boolean }
          : field === "day"
            ? { ...base, field, before: task.day, after: after as string }
            : { ...base, field, before: task.note, after: after as string };
      const result = await patchTask({ environmentId, input });
      if (result._tag !== "Success") throw squashAtomCommandFailure(result);
      setEditingTaskId(undefined);
      setHistoryCursor(undefined);
      setActionNotice(`Saved ${field} for ${task.id}.`);
      refresh();
    } catch (failure) {
      setActionError(errorMessage(failure));
      current.refresh();
    } finally {
      inFlight.current = false;
      setSavingTaskId(undefined);
    }
  };
  const resolveConflict = async (taskId: string, resolvedDate: string, reason: string) => {
    if (
      environmentId === null ||
      spaceId === undefined ||
      current.data === null ||
      inFlight.current
    )
      return;
    inFlight.current = true;
    setSavingTaskId(taskId);
    setActionError(null);
    try {
      const result = await resolveDate({
        environmentId,
        input: {
          planId: current.data.id,
          spaceId,
          taskId,
          resolvedDate,
          reason,
          expectedVersion: current.data.version,
          mutationId: nextMutationId(),
          provenance: { kind: "manual", sourceRef: "sprint-plan-web" },
        },
      });
      if (result._tag !== "Success") throw squashAtomCommandFailure(result);
      setActionNotice(`Recorded date clarification for ${taskId}.`);
      setHistoryCursor(undefined);
      refresh();
    } catch (failure) {
      setActionError(errorMessage(failure));
      current.refresh();
    } finally {
      inFlight.current = false;
      setSavingTaskId(undefined);
    }
  };

  return (
    <SidebarInset className="h-full min-h-0 overflow-auto">
      <main className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 pt-14 pb-12 sm:px-6 sm:pt-5">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-muted-foreground">Command Center</p>
            <h1 className="text-2xl font-semibold tracking-tight">Sprint plan</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Source, current work, and deliberate changes in one Space.
            </p>
          </div>
          <Button onClick={refresh} variant="outline">
            <RefreshCwIcon /> Refresh
          </Button>
        </header>
        {actionError !== null && (
          <StateCard>
            <p className="text-destructive" role="alert">
              {actionError}
            </p>
            <Button className="mt-3" onClick={refresh} variant="outline">
              Refresh and retry
            </Button>
          </StateCard>
        )}
        {actionNotice !== null && (
          <p className="rounded-lg border border-border bg-muted/40 p-3 text-sm" role="status">
            {actionNotice}
          </p>
        )}
        {environmentId === null ? (
          <StateCard>Connect an environment to view sprint plans.</StateCard>
        ) : bootstrap.error !== null ? (
          <StateCard>{bootstrap.error}</StateCard>
        ) : bootstrap.isPending || bootstrap.data === null ? (
          <StateCard>Loading Spaces…</StateCard>
        ) : bootstrap.data.spaces.length === 0 ? (
          <StateCard>No active Spaces are configured.</StateCard>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex min-w-48 flex-col gap-1 text-sm font-medium">
                Space
                <select
                  aria-label="Sprint plan Space"
                  className="min-h-11 rounded-md border border-input bg-background px-3 text-base sm:min-h-9 sm:text-sm"
                  onChange={(event) => chooseSpace(event.target.value)}
                  value={spaceId ?? ""}
                >
                  {bootstrap.data.spaces.map((space) => (
                    <option key={space.id} value={space.id}>
                      {space.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex min-w-48 flex-col gap-1 text-sm font-medium">
                Plan
                <select
                  aria-label="Sprint plan"
                  className="min-h-11 rounded-md border border-input bg-background px-3 text-base sm:min-h-9 sm:text-sm"
                  disabled={
                    list.isPending || (list.data?.plans.length === 0 && planId === undefined)
                  }
                  onChange={(event) => choosePlan(event.target.value)}
                  value={planId ?? ""}
                >
                  {planId !== undefined && !list.data?.plans.some((plan) => plan.id === planId) && (
                    <option value={planId}>{planId} (linked plan)</option>
                  )}
                  {(list.data?.plans ?? []).map((plan) => (
                    <option key={plan.id} value={plan.id}>
                      {plan.id}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                onClick={() => {
                  importRevision.current++;
                  setPreview(null);
                  setConflictDecisions({});
                  setImportOpen((open) => !open);
                }}
                variant="outline"
              >
                <UploadIcon /> {importOpen ? "Close import" : "Import JSON"}
              </Button>
            </div>
            {list.error !== null && <StateCard>{list.error}</StateCard>}
            {list.isPending && <StateCard>Loading plans…</StateCard>}
            {(list.data?.nextCursor !== undefined || priorCursors.length > 0) && (
              <div className="flex gap-2">
                <Button
                  disabled={priorCursors.length === 0}
                  onClick={() => {
                    const previous = priorCursors.at(-1);
                    setCursor(previous);
                    setPriorCursors(priorCursors.slice(0, -1));
                    setHistoryCursor(undefined);
                    setTaskPage(0);
                    setPreview(null);
                    setConflictDecisions({});
                    importRevision.current++;
                    select({ planId: undefined, taskId: undefined });
                  }}
                  size="sm"
                  variant="outline"
                >
                  Previous plans
                </Button>
                <Button
                  disabled={list.data?.nextCursor === undefined}
                  onClick={() => {
                    setPriorCursors([...priorCursors, cursor]);
                    setCursor(list.data!.nextCursor);
                    setHistoryCursor(undefined);
                    setTaskPage(0);
                    setPreview(null);
                    setConflictDecisions({});
                    importRevision.current++;
                    select({ planId: undefined, taskId: undefined });
                  }}
                  size="sm"
                  variant="outline"
                >
                  Next plans <ArrowRightIcon />
                </Button>
              </div>
            )}
            {importOpen && (
              <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
                <h2 className="text-lg font-semibold">Import or reimport source</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Select a JSON file up to 1 MB. Preview checks the source before any plan change.
                  The exact applied bytes are preserved.
                </p>
                <label className="mt-3 block max-w-sm text-sm font-medium">
                  Plan ID
                  <Input
                    className="mt-1 min-h-11 sm:min-h-8"
                    maxLength={256}
                    onChange={(event) => {
                      importRevision.current++;
                      setImportPlanId(event.target.value);
                      setPreview(null);
                      setConflictDecisions({});
                    }}
                    placeholder={planId ?? `plan:${spaceId}`}
                    value={importPlanId}
                  />
                </label>
                <input
                  accept=".json,application/json"
                  aria-label="Sprint plan JSON file"
                  className="mt-3 block w-full text-sm file:mr-3 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-2"
                  onChange={(event) => void readFile(event.target.files?.[0])}
                  type="file"
                />
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    disabled={importBusy || importJson.length === 0}
                    onClick={() => void previewSource()}
                    variant="outline"
                  >
                    {importBusy ? "Checking…" : "Preview source"}
                  </Button>
                  {preview !== null && (
                    <Button
                      disabled={
                        importBusy ||
                        preview.unchangedSource ||
                        completeImportDecisions(preview.conflicts, conflictDecisions) === null
                      }
                      onClick={() => void applySource()}
                    >
                      Apply reviewed import
                    </Button>
                  )}
                </div>
                {preview !== null && (
                  <div className="mt-4 space-y-3 text-sm">
                    <p>
                      {preview.taskCount} tasks · source version {preview.sourceVersion} ·{" "}
                      {preview.unchangedSource
                        ? "same source as current baseline"
                        : preview.existingVersion === null
                          ? "new plan"
                          : `plan version ${preview.existingVersion} will be checked`}
                    </p>
                    <p className="break-all text-xs text-muted-foreground">
                      SHA-256 {preview.sourceSha256}
                    </p>
                    {preview.sourceDateConflicts.length > 0 && (
                      <div className="rounded-lg border border-warning/40 bg-warning/5 p-3">
                        <p className="font-medium">
                          {preview.sourceDateConflicts.length} source date clarification
                          {preview.sourceDateConflicts.length === 1 ? "" : "s"}
                        </p>
                        <ul className="mt-2 list-inside list-disc space-y-1">
                          {preview.sourceDateConflicts.map((conflict) => (
                            <li key={conflict.taskId}>
                              {conflict.taskId}: {conflict.reason.replaceAll("-", " ")} (
                              {conflict.sourceDay} / {conflict.textDateReference})
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {preview.conflicts.length > 0 && (
                      <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3">
                        <p className="font-medium">
                          Review {preview.conflicts.length} field conflict
                          {preview.conflicts.length === 1 ? "" : "s"}
                        </p>
                        <p className="mt-1 text-muted-foreground">
                          Choose how to resolve each field. Apply checks the current plan version
                          and all conflicts together; the uploaded JSON stays exact.
                        </p>
                        <ul className="mt-2 space-y-2">
                          {preview.conflicts.map((conflict) => (
                            <li
                              className="rounded-lg border border-border bg-background p-3"
                              key={`${conflict.taskId}:${conflict.field}`}
                            >
                              <strong>
                                {conflict.taskId}.{conflict.field}
                              </strong>{" "}
                              · baseline: {String(conflict.baseline)} · current:{" "}
                              {String(conflict.current)} · incoming:{" "}
                              {conflict.incoming === undefined
                                ? "task removed"
                                : String(conflict.incoming)}
                              <div className="mt-3 flex flex-wrap gap-2">
                                <Button
                                  aria-pressed={
                                    conflictDecisions[
                                      conflictDecisionKey(conflict.taskId, conflict.field)
                                    ] === "keep-current"
                                  }
                                  disabled={conflict.reason === "locally-edited-task-removed"}
                                  onClick={() =>
                                    setConflictDecisions((prior) => ({
                                      ...prior,
                                      [conflictDecisionKey(conflict.taskId, conflict.field)]:
                                        "keep-current",
                                    }))
                                  }
                                  size="sm"
                                  variant={
                                    conflictDecisions[
                                      conflictDecisionKey(conflict.taskId, conflict.field)
                                    ] === "keep-current"
                                      ? "default"
                                      : "outline"
                                  }
                                >
                                  Keep current
                                </Button>
                                <Button
                                  aria-pressed={
                                    conflictDecisions[
                                      conflictDecisionKey(conflict.taskId, conflict.field)
                                    ] === "use-incoming"
                                  }
                                  onClick={() =>
                                    setConflictDecisions((prior) => ({
                                      ...prior,
                                      [conflictDecisionKey(conflict.taskId, conflict.field)]:
                                        "use-incoming",
                                    }))
                                  }
                                  size="sm"
                                  variant={
                                    conflictDecisions[
                                      conflictDecisionKey(conflict.taskId, conflict.field)
                                    ] === "use-incoming"
                                      ? "default"
                                      : "outline"
                                  }
                                >
                                  Use incoming
                                </Button>
                              </div>
                              {conflict.reason === "locally-edited-task-removed" && (
                                <p className="mt-2 text-muted-foreground">
                                  The incoming source removed this task. To retain it, correct the
                                  source and preview again.
                                </p>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </section>
            )}
            {planId === undefined ? (
              <StateCard>
                No sprint plan in this Space yet. Import a JSON source to begin.
              </StateCard>
            ) : current.error !== null || (view === "original" && original.error !== null) ? (
              <StateCard>{current.error ?? original.error}</StateCard>
            ) : current.isPending ||
              current.data === null ||
              (view === "original" && (original.isPending || original.data === null)) ? (
              <StateCard>Loading plan…</StateCard>
            ) : source !== undefined ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm text-muted-foreground">
                      Plan version {current.data.version} · imported source version{" "}
                      {current.data.sourceVersion}
                    </p>
                    <p className="text-sm font-medium">
                      {planProgress(current.data.current).done} of{" "}
                      {planProgress(current.data.current).total} tasks completed
                    </p>
                  </div>
                  <div aria-label="Plan version" className="flex gap-2" role="tablist">
                    {(["current", "original"] as const).map((choice) => (
                      <Button
                        aria-selected={view === choice}
                        key={choice}
                        onClick={() => {
                          setWeekId("all");
                          setOwner("all");
                          setTaskPage(0);
                          select({ view: choice, taskId: undefined });
                        }}
                        role="tab"
                        variant={view === choice ? "default" : "outline"}
                      >
                        {choice === "current" ? "Current" : "Original"}
                      </Button>
                    ))}
                  </div>
                </div>
                {view === "original" && (
                  <StateCard>
                    Original source imported {original.data!.importedAt}. This view is read-only and
                    remains unchanged by edits or reimports.
                  </StateCard>
                )}
                <details
                  className="rounded-xl border border-border bg-card p-4"
                  onToggle={(event) => setShowSourceJson(event.currentTarget.open)}
                >
                  <summary className="cursor-pointer text-base font-semibold">
                    Exact imported JSON
                  </summary>
                  <p className="mt-2 text-sm text-muted-foreground">
                    This is the stored {view === "original" ? "first" : "latest"} imported source,
                    including metadata outside the task view.
                  </p>
                  {showSourceJson && (
                    <div className="mt-3 font-mono">
                      <Textarea
                        className="h-64"
                        readOnly
                        value={
                          view === "original" ? original.data!.sourceJson : current.data.sourceJson
                        }
                      />
                    </div>
                  )}
                </details>
                <details className="rounded-xl border border-border bg-card p-4" open={false}>
                  <summary className="cursor-pointer text-base font-semibold">
                    Goals · {source.score.length}
                  </summary>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {source.score.map((goal) => (
                      <article className="rounded-lg border border-border p-3" key={goal.id}>
                        <h2 className="font-medium">{goal.label}</h2>
                        <dl className="mt-2 grid grid-cols-3 gap-2 text-sm">
                          <div>
                            <dt className="text-muted-foreground">Start</dt>
                            <dd>{goal.start || "Unknown"}</dd>
                          </div>
                          <div>
                            <dt className="text-muted-foreground">Now</dt>
                            <dd>{goal.now || "Unknown"}</dd>
                          </div>
                          <div>
                            <dt className="text-muted-foreground">Target</dt>
                            <dd>{goal.target || "Unresolved"}</dd>
                          </div>
                        </dl>
                      </article>
                    ))}
                  </div>
                </details>
                <div className="grid gap-3 sm:grid-cols-3">
                  <StateCard>
                    <strong>Carryovers</strong>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {planCarryovers(current.data.current, today).length} unfinished tasks from
                      past weeks remain open.
                    </p>
                  </StateCard>
                  <StateCard>
                    <strong>Upcoming weeks</strong>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {nextPlanWeeks(current.data.current, today)
                        .map((week) => `Week ${week.num}`)
                        .join(", ") || "No upcoming week"}
                    </p>
                  </StateCard>
                  <StateCard>
                    <strong>Plan span</strong>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {source.weeks.length === 0
                        ? "No weeks"
                        : `${source.weeks[0]!.range} to ${source.weeks.at(-1)!.range}`}
                    </p>
                  </StateCard>
                </div>
                {view === "current" && current.data.baselineNormalized.dateConflicts.length > 0 && (
                  <section className="rounded-xl border border-warning/40 bg-warning/5 p-4">
                    <h2 className="font-semibold">Source date clarifications</h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      A conflict leaves the imported wording intact. Record a reviewed date
                      separately.
                    </p>
                    <div className="mt-3 space-y-3">
                      {current.data.baselineNormalized.dateConflicts.map((conflict) => (
                        <DateConflictEditor
                          conflict={conflict}
                          disabled={savingTaskId !== undefined}
                          key={`${conflict.taskId}:${dateResolutions.get(conflict.taskId)?.resolvedDate ?? ""}`}
                          onResolve={resolveConflict}
                          resolvedDate={dateResolutions.get(conflict.taskId)?.resolvedDate}
                        />
                      ))}
                    </div>
                  </section>
                )}
                <div className="flex flex-wrap gap-3">
                  <label className="flex min-w-40 flex-col gap-1 text-sm font-medium">
                    Week
                    <select
                      aria-label="Filter week"
                      className="min-h-11 rounded-md border border-input bg-background px-3 text-base sm:min-h-9 sm:text-sm"
                      onChange={(event) => {
                        setWeekId(event.target.value);
                        setTaskPage(0);
                        select({ taskId: undefined });
                      }}
                      value={weekId}
                    >
                      <option value="all">All weeks</option>
                      {source.weeks.map((week) => (
                        <option key={week.id} value={week.id}>
                          Week {week.num} · {week.range}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex min-w-40 flex-col gap-1 text-sm font-medium">
                    Owner
                    <select
                      aria-label="Filter owner"
                      className="min-h-11 rounded-md border border-input bg-background px-3 text-base sm:min-h-9 sm:text-sm"
                      onChange={(event) => {
                        setOwner(event.target.value);
                        setTaskPage(0);
                        select({ taskId: undefined });
                      }}
                      value={owner}
                    >
                      <option value="all">All owners</option>
                      {planOwners(source).map((choice) => (
                        <option key={choice} value={choice}>
                          {choice}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {search.taskId !== undefined && selectedTask === undefined && (
                  <StateCard>Task {search.taskId} is not in this plan.</StateCard>
                )}
                {tasks.length === 0 ? (
                  <StateCard>No tasks match these filters.</StateCard>
                ) : (
                  <div className="space-y-3">
                    {pageTasks.map(({ task, week }) => (
                      <article
                        className="scroll-mt-20 rounded-xl border border-border bg-card p-4 focus-visible:outline-2 focus-visible:outline-primary"
                        id={taskAnchor(task.id)}
                        key={task.id}
                        tabIndex={-1}
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                              Week {week.num} · {task.owner} · {task.day}
                            </p>
                            <h2 className="mt-1 text-base font-semibold">{task.text}</h2>
                            <p className="mt-1 text-sm text-muted-foreground">
                              {task.note || "No note"}
                            </p>
                            <div className="mt-2 flex flex-wrap gap-2 text-xs">
                              <span className="rounded bg-muted px-2 py-1">
                                {task.done ? "Completed" : "Open"}
                              </span>
                              {conflictIds.has(task.id) && (
                                <span className="rounded bg-warning/10 px-2 py-1 text-warning-foreground">
                                  Source date needs clarification
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="flex gap-2">
                            <Button
                              onClick={() => select({ taskId: task.id })}
                              size="sm"
                              variant="ghost"
                            >
                              Link
                            </Button>
                            {view === "current" && (
                              <Button
                                onClick={() => {
                                  setEditingTaskId(editingTaskId === task.id ? undefined : task.id);
                                  select({ taskId: task.id });
                                }}
                                size="sm"
                                variant="outline"
                              >
                                {editingTaskId === task.id ? "Close edit" : "Edit"}
                              </Button>
                            )}
                          </div>
                        </div>
                        {view === "current" && editingTaskId === task.id && (
                          <TaskEditor
                            key={`${task.id}:${current.data!.version}`}
                            task={task}
                            snapshot={current.data!}
                            isSaving={savingTaskId === task.id}
                            onCancel={() => setEditingTaskId(undefined)}
                            onSave={(field, after, reason) =>
                              void saveTask(task, field, after, reason)
                            }
                          />
                        )}
                      </article>
                    ))}
                    {tasks.length > 100 && (
                      <div className="flex flex-wrap items-center gap-2 pt-2 text-sm">
                        <Button
                          disabled={taskPage === 0}
                          onClick={() => setTaskPage(taskPage - 1)}
                          size="sm"
                          variant="outline"
                        >
                          Previous tasks
                        </Button>
                        <span>
                          {taskPage * 100 + 1}–{Math.min((taskPage + 1) * 100, tasks.length)} of{" "}
                          {tasks.length}
                        </span>
                        <Button
                          disabled={(taskPage + 1) * 100 >= tasks.length}
                          onClick={() => setTaskPage(taskPage + 1)}
                          size="sm"
                          variant="outline"
                        >
                          Next tasks
                        </Button>
                      </div>
                    )}
                  </div>
                )}
                <section className="rounded-xl border border-border bg-card p-4">
                  <h2 className="text-base font-semibold">Change history</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Each accepted edit and import keeps its actor, reason, and prior value.
                  </p>
                  {history.error !== null ? (
                    <p className="mt-3 text-sm text-destructive">{history.error}</p>
                  ) : history.isPending ? (
                    <p className="mt-3 text-sm">Loading history…</p>
                  ) : (
                    <>
                      <ol className="mt-3 space-y-2">
                        {(history.data?.entries ?? []).map((entry) => (
                          <li
                            className="rounded-lg border border-border p-3 text-sm"
                            key={entry.sequence}
                          >
                            <span className="font-medium">
                              {entry.operation.replaceAll("-", " ")}
                            </span>
                            {entry.taskId && (
                              <span>
                                {" "}
                                · {entry.taskId}
                                {entry.field ? `.${entry.field}` : ""}
                              </span>
                            )}
                            <p className="text-muted-foreground">
                              Version {entry.planVersion} · {entry.actor.id} · {entry.occurredAt}
                            </p>
                            {entry.reason && <p>{entry.reason}</p>}
                            {entry.operation === "task-patch" && (
                              <p className="break-words text-muted-foreground">
                                {String(entry.before)} → {String(entry.after)}
                              </p>
                            )}
                            {entry.operation === "import" && (
                              <ImportDecisionHistory after={entry.after} />
                            )}
                          </li>
                        ))}
                      </ol>
                      {history.data?.nextBeforeSequence !== undefined && (
                        <Button
                          className="mt-3"
                          onClick={() => setHistoryCursor(history.data!.nextBeforeSequence)}
                          size="sm"
                          variant="outline"
                        >
                          Older changes
                        </Button>
                      )}
                      {historyCursor !== undefined && (
                        <Button
                          className="mt-3 ml-2"
                          onClick={() => setHistoryCursor(undefined)}
                          size="sm"
                          variant="outline"
                        >
                          Latest changes
                        </Button>
                      )}
                    </>
                  )}
                </section>
              </>
            ) : null}
          </>
        )}
      </main>
    </SidebarInset>
  );
}

function DateConflictEditor({
  conflict,
  resolvedDate,
  disabled,
  onResolve,
}: {
  readonly conflict: CommandCenterSprintPlanSnapshot["baselineNormalized"]["dateConflicts"][number];
  readonly resolvedDate: string | undefined;
  readonly disabled: boolean;
  readonly onResolve: (taskId: string, date: string, reason: string) => void;
}) {
  const [date, setDate] = useState(resolvedDate ?? conflict.dayDate ?? "");
  const [reason, setReason] = useState("");
  return (
    <div className="rounded-lg border border-border bg-background p-3 text-sm">
      <p className="font-medium">
        {conflict.taskId} · {conflict.reason.replaceAll("-", " ")}
        {resolvedDate === undefined ? "" : ` · clarified as ${resolvedDate}`}
      </p>
      <p className="mt-1 text-muted-foreground">
        Day: {conflict.sourceDay} · Text: {conflict.textDateReference}
      </p>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          Reviewed date
          <Input
            className="min-h-11 sm:min-h-8"
            onChange={(event) => setDate(event.target.value)}
            type="date"
            value={date}
          />
        </label>
        <label className="flex min-w-48 flex-1 flex-col gap-1">
          Reason
          <Input
            className="min-h-11 sm:min-h-8"
            maxLength={4_096}
            onChange={(event) => setReason(event.target.value)}
            value={reason}
          />
        </label>
        <Button
          disabled={disabled || date.length === 0 || reason.trim().length === 0}
          onClick={() => onResolve(conflict.taskId, date, reason.trim())}
          size="sm"
          variant="outline"
        >
          {resolvedDate === undefined ? "Record clarification" : "Update clarification"}
        </Button>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/_chat/sprint-plan")({
  validateSearch: (search: Record<string, unknown>) => ({
    spaceId: typeof search.spaceId === "string" ? search.spaceId : undefined,
    planId: typeof search.planId === "string" ? search.planId : undefined,
    taskId: typeof search.taskId === "string" ? search.taskId : undefined,
    view: search.view === "original" ? ("original" as const) : ("current" as const),
  }),
  component: SprintPlanRouteView,
});
