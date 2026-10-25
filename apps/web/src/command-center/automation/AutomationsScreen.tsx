"use client";

import type { Automation, Connection, Run, Space } from "@command-center/core";
import type {
  CommandCenterAutomationScheduleInterpretResult,
  EnvironmentId,
  ExecutionEnvironmentPlatformOs,
  ScheduledTask,
} from "@t3tools/contracts";
import {
  ArrowLeftIcon,
  CalendarClockIcon,
  CloudOffIcon,
  FileWarningIcon,
  LoaderCircleIcon,
  LockKeyholeIcon,
  type LucideIcon,
  PlusIcon,
  RefreshCwIcon,
  SaveIcon,
  ServerIcon,
  Settings2Icon,
  WorkflowIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { relativeLabel, scheduleLabel } from "~/components/settings/scheduledTasksSettings.logic";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { ScrollArea } from "~/components/ui/scroll-area";
import { SidebarInset } from "~/components/ui/sidebar";
import { Skeleton } from "~/components/ui/skeleton";
import { cn } from "~/lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";

import { AutomationEditor } from "./AutomationEditor";
import {
  type AutomationsScreenStatus,
  type AutomationsSelection,
  type RecurringHealth,
  automationHealth,
  automationSpaceName,
  describeAutomationTrigger,
  latestAutomationRun,
  resolveAutomationsSelection,
  scheduledTaskHealth,
  sortByHealth,
  summarizeRecurringHealth,
} from "./AutomationsScreen.logic";
import { ScheduledTaskDetails } from "./ScheduledTaskDetails";
import type { AutomationEditorDefinition, AutomationEditorProps } from "./types";

export interface AutomationEnvironmentOption {
  readonly id: EnvironmentId;
  readonly label: string;
  readonly isPrimary?: boolean;
  readonly platformOs?: ExecutionEnvironmentPlatformOs;
}

const EMPTY_AUTOMATION_ENVIRONMENT_OPTIONS: ReadonlyArray<AutomationEnvironmentOption> = [];
const EMPTY_SCHEDULED_TASKS: ReadonlyArray<ScheduledTask> = [];
const EMPTY_RUNS: ReadonlyArray<Run> = [];

export type ScheduledTasksStatus = "loading" | "ready" | "unavailable";

export interface AutomationsScreenProps {
  /** State of the committed automations (private configuration) half of the page. */
  readonly status: AutomationsScreenStatus;
  readonly automations: ReadonlyArray<Automation>;
  readonly spaces: ReadonlyArray<Space>;
  /** Command Center runs; the latest per automation tells its health. */
  readonly runs?: ReadonlyArray<Run> | undefined;
  readonly scheduledTasks?: ReadonlyArray<ScheduledTask> | undefined;
  readonly scheduledTasksStatus?: ScheduledTasksStatus | undefined;
  readonly scheduledTasksError?: string | null | undefined;
  readonly canOperateScheduledTasks?: boolean | undefined;
  readonly busyScheduledTaskId?: string | null | undefined;
  readonly onRunScheduledTaskNow?: ((task: ScheduledTask) => void) | undefined;
  readonly onSetScheduledTaskEnabled?:
    | ((task: ScheduledTask, enabled: boolean) => void)
    | undefined;
  readonly onOpenScheduledTaskThread?: ((task: ScheduledTask) => void) | undefined;
  readonly onEditScheduledTask?: ((task: ScheduledTask) => void) | undefined;
  readonly onOpenScheduledTasksSettings?: (() => void) | undefined;
  readonly connections?: ReadonlyArray<Connection> | undefined;
  readonly environmentTimezone?: string | null | undefined;
  readonly onInterpretSchedule?:
    | ((input: {
        readonly text: string;
        readonly timezone: string;
      }) => Promise<CommandCenterAutomationScheduleInterpretResult>)
    | undefined;
  readonly onBeginGoogleConnectionSetup?: AutomationEditorProps["onBeginGoogleConnectionSetup"];
  readonly onCompleteGoogleConnectionSetup?: AutomationEditorProps["onCompleteGoogleConnectionSetup"];
  readonly onRemoveGoogleConnection?: AutomationEditorProps["onRemoveGoogleConnection"];
  readonly onRefresh?: (() => void) | undefined;
  readonly isRefreshing?: boolean | undefined;
  readonly refreshError?: string | null | undefined;
  readonly onCreate?:
    | ((input: { readonly name: string; readonly spaceId: string }) => void)
    | undefined;
  readonly isCreating?: boolean | undefined;
  /** Omitted: the page opens whatever needs the user most. */
  readonly selection?: AutomationsSelection | undefined;
  readonly onSelect?: ((selection: AutomationsSelection) => void) | undefined;
  readonly editorDefinition?: AutomationEditorDefinition | null | undefined;
  readonly editorStatus?: "loading" | "ready" | "unavailable" | undefined;
  readonly editorError?: string | null | undefined;
  readonly isDirty?: boolean | undefined;
  readonly hasUnsavedChanges?: boolean | undefined;
  readonly isSaving?: boolean | undefined;
  readonly onDefinitionChange?: ((definition: AutomationEditorDefinition) => void) | undefined;
  readonly onSave?: (() => void) | undefined;
  readonly configCommitSha?: string | undefined;
  readonly authoringHealth?:
    | {
        readonly status: "available" | "unavailable";
        readonly message?: string | undefined;
      }
    | undefined;
  readonly environmentId?: EnvironmentId | null | undefined;
  readonly environmentOptions?: ReadonlyArray<AutomationEnvironmentOption> | undefined;
  readonly onEnvironmentChange?: ((environmentId: EnvironmentId) => void) | undefined;
}

const HEALTH_DOT_CLASS: Record<RecurringHealth, string> = {
  failing: "bg-destructive",
  running: "bg-sky-500",
  ok: "bg-emerald-500",
  idle: "bg-muted-foreground/40",
  paused: "bg-muted-foreground/40",
};

/** Relative labels ("in 3h", "2m ago") drift; re-render once a minute so they stay honest. */
function useMinuteTick() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((tick) => tick + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);
}

function scheduledTaskRowLabels(task: ScheduledTask): {
  readonly health: RecurringHealth;
  readonly primary: string;
  readonly secondary: string;
} {
  const health = scheduledTaskHealth(task);
  const primary =
    health === "paused"
      ? "Paused"
      : health === "failing"
        ? `Failed ${relativeLabel(task.lastRunAt)}`
        : health === "running"
          ? "Running now"
          : health === "ok"
            ? `OK ${relativeLabel(task.lastRunAt)}`
            : "Not run yet";
  const secondary =
    task.enabled && task.schedule.type !== "webhook" && task.nextRunAt !== null
      ? `next ${relativeLabel(task.nextRunAt)}`
      : scheduleLabel(task.schedule);
  return { health, primary, secondary };
}

function automationRowLabels(
  automation: Automation,
  runs: ReadonlyArray<Run>,
  spaces: ReadonlyArray<Space>,
): { readonly health: RecurringHealth; readonly primary: string; readonly secondary: string } {
  const health = automationHealth(automation, runs);
  const latest = latestAutomationRun(automation, runs);
  const at =
    latest === undefined
      ? ""
      : relativeLabel(latest.finishedAt ?? latest.startedAt ?? latest.createdAt);
  const primary =
    health === "paused"
      ? "Paused"
      : health === "failing"
        ? `Failed ${at}`
        : health === "running"
          ? "Running now"
          : health === "ok"
            ? `OK ${at}`
            : latest === undefined
              ? "No runs yet"
              : `Canceled ${at}`;
  return {
    health,
    primary,
    secondary: `${describeAutomationTrigger(automation.trigger)} · ${automationSpaceName(automation, spaces)}`,
  };
}

interface RecurringRowProps {
  readonly icon: LucideIcon;
  readonly health: RecurringHealth;
  readonly title: string;
  readonly primary: string;
  readonly secondary: string;
  readonly selected: boolean;
  readonly onSelect: () => void;
}

function RecurringRow({
  icon: Icon,
  health,
  title,
  primary,
  secondary,
  selected,
  onSelect,
}: RecurringRowProps) {
  return (
    <button
      aria-current={selected ? "page" : undefined}
      className={cn(
        "w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent",
        selected && "bg-accent text-accent-foreground",
      )}
      onClick={onSelect}
      type="button"
    >
      <span className="flex items-center gap-2">
        <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
          <Icon className="size-3.5 text-muted-foreground" />
          <span
            aria-hidden
            className={cn(
              "absolute -top-0.5 -right-0.5 size-1.5 rounded-full",
              HEALTH_DOT_CLASS[health],
            )}
          />
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{title}</span>
      </span>
      <span
        className={cn(
          "mt-0.5 block truncate pl-6 text-2xs",
          health === "failing" ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {primary} · {secondary}
      </span>
    </button>
  );
}

interface SectionNoticeProps {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly description: string;
  readonly slot?: string | undefined;
  readonly tone?: "default" | "error" | undefined;
  readonly actions?: ReactNode;
}

/** An inline state for one half of the list, so the other half stays usable. */
function SectionNotice({
  icon: Icon,
  title,
  description,
  slot,
  tone,
  actions,
}: SectionNoticeProps) {
  return (
    <div className="px-3 pb-3" data-slot={slot}>
      <p
        className={cn(
          "flex items-center gap-1.5 text-xs font-medium",
          tone === "error" && "text-destructive",
        )}
      >
        <Icon className="size-3.5 shrink-0" />
        {title}
      </p>
      <p className="mt-0.5 text-2xs text-muted-foreground">{description}</p>
      {actions ? <div className="mt-2 flex flex-wrap gap-1.5">{actions}</div> : null}
    </div>
  );
}

function SectionSkeleton({ label }: { readonly label: string }) {
  return (
    <div aria-label={label} className="space-y-1.5 px-2 pb-3" role="status">
      <Skeleton shape="card" className="h-10 w-full" />
      <Skeleton shape="card" className="h-10 w-full" />
      <span className="sr-only">{label}</span>
    </div>
  );
}

function RefreshButton({
  onRefresh,
  isRefreshing,
}: {
  readonly onRefresh: () => void;
  readonly isRefreshing: boolean;
}) {
  return (
    <Button disabled={isRefreshing} onClick={onRefresh} size="sm" variant="outline">
      <RefreshCwIcon
        className={isRefreshing ? "animate-spin motion-reduce:animate-none" : undefined}
      />
      {isRefreshing ? "Checking" : "Check again"}
    </Button>
  );
}

function DisconnectedState() {
  return (
    <Empty data-slot="automations-disconnected">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <CloudOffIcon />
        </EmptyMedia>
        <EmptyTitle>Connect an environment</EmptyTitle>
        <EmptyDescription>
          Scheduled tasks and automations are loaded from the selected Command Center environment.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button render={<a href="/" />} size="sm" variant="ghost">
          <ArrowLeftIcon />
          Back to Command
        </Button>
      </EmptyContent>
    </Empty>
  );
}

export function AutomationsScreen({
  status,
  automations,
  spaces,
  runs = EMPTY_RUNS,
  scheduledTasks = EMPTY_SCHEDULED_TASKS,
  scheduledTasksStatus = "ready",
  scheduledTasksError,
  canOperateScheduledTasks = false,
  busyScheduledTaskId = null,
  onRunScheduledTaskNow,
  onSetScheduledTaskEnabled,
  onOpenScheduledTaskThread,
  onEditScheduledTask,
  onOpenScheduledTasksSettings,
  connections,
  environmentTimezone,
  onInterpretSchedule,
  onBeginGoogleConnectionSetup,
  onCompleteGoogleConnectionSetup,
  onRemoveGoogleConnection,
  onRefresh,
  isRefreshing = false,
  refreshError,
  onCreate,
  isCreating = false,
  selection: controlledSelection,
  onSelect,
  editorDefinition,
  editorStatus = "unavailable",
  editorError,
  isDirty = false,
  hasUnsavedChanges = isDirty,
  isSaving = false,
  onDefinitionChange,
  onSave,
  configCommitSha,
  authoringHealth,
  environmentId,
  environmentOptions = EMPTY_AUTOMATION_ENVIRONMENT_OPTIONS,
  onEnvironmentChange,
}: AutomationsScreenProps) {
  useMinuteTick();
  const [localSelection, setLocalSelection] = useState<AutomationsSelection>();
  const [showCreate, setShowCreate] = useState(false);
  const [newAutomationName, setNewAutomationName] = useState("New automation");
  const [newAutomationSpaceId, setNewAutomationSpaceId] = useState("");
  const recurring = { tasks: scheduledTasks, automations, runs };
  const selection = resolveAutomationsSelection(controlledSelection ?? localSelection, recurring);
  const selectedAutomation =
    selection?.kind === "automation"
      ? automations.find((automation) => automation.id === selection.id)
      : undefined;
  const selectedTask =
    selection?.kind === "scheduled-task"
      ? scheduledTasks.find((task) => task.id === selection.id)
      : undefined;
  const summary = summarizeRecurringHealth(recurring);
  const sortedTasks = sortByHealth(scheduledTasks, scheduledTaskHealth);
  const sortedAutomations = sortByHealth(automations, (automation) =>
    automationHealth(automation, runs),
  );
  const editable =
    editorStatus === "ready" &&
    editorDefinition !== null &&
    editorDefinition !== undefined &&
    onDefinitionChange !== undefined;
  const authoringUnavailable = authoringHealth?.status === "unavailable";
  const saveDisabled =
    authoringUnavailable || !editable || !isDirty || isSaving || onSave === undefined;
  const saveStatus = isSaving
    ? { label: "Saving", variant: "warning" as const }
    : !isDirty
      ? { label: "Saved", variant: "success" as const }
      : { label: "Autosave pending", variant: "warning" as const };
  const effectiveNewSpaceId =
    newAutomationSpaceId ||
    spaces.find((space) => space.kind === "system")?.id ||
    spaces[0]?.id ||
    "";
  const selectedEnvironment = environmentOptions.find(({ id }) => id === environmentId);
  const canCreate = status === "ready" && onCreate !== undefined && spaces.length > 0;

  const select = (next: AutomationsSelection) => {
    setLocalSelection(next);
    onSelect?.(next);
  };

  if (status === "disconnected") {
    return (
      <SidebarInset className="h-full min-h-0 overflow-hidden overscroll-y-none">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-slot="automations-screen">
          <DisconnectedState />
        </div>
      </SidebarInset>
    );
  }

  return (
    <SidebarInset className="h-full min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-slot="automations-screen">
        <header
          className={cn(
            "drag-region flex min-h-[var(--workspace-topbar-height)] shrink-0 flex-col justify-center border-b bg-background px-3 py-2 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5",
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
        >
          <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-2">
            <Button
              aria-label="Back to Command"
              render={<a href="/" />}
              size="icon-sm"
              variant="ghost"
            >
              <ArrowLeftIcon />
            </Button>
            {/* The title never shrinks; on a phone the controls wrap under it instead. */}
            <div className="min-w-fit flex-1">
              <h1 className="text-sm font-semibold">Automations</h1>
            </div>
            {summary.total > 0 ? (
              <span
                className="flex items-center gap-1.5 text-2xs text-muted-foreground"
                data-slot="automations-summary"
              >
                <span className="hidden sm:inline">{summary.total} recurring</span>
                {summary.failing > 0 ? (
                  <Badge size="sm" variant="destructive">
                    {summary.failing} failing
                  </Badge>
                ) : null}
                {summary.running > 0 ? (
                  <Badge size="sm" variant="info">
                    {summary.running} running
                  </Badge>
                ) : null}
                {summary.paused > 0 ? (
                  <span className="hidden sm:inline">· {summary.paused} paused</span>
                ) : null}
              </span>
            ) : null}
            <span className="hidden items-center gap-1.5 text-2xs text-muted-foreground sm:flex">
              <LockKeyholeIcon />
              Private config
            </span>
            {environmentId !== null &&
            environmentId !== undefined &&
            environmentOptions.length > 0 ? (
              <label className="flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground [-webkit-app-region:no-drag]">
                <ServerIcon className="size-3.5 shrink-0" />
                <span className="hidden sm:inline">Runs on</span>
                <select
                  aria-label="Automation runtime environment"
                  className="h-8 min-w-0 max-w-48 rounded-lg border border-input bg-background px-2 text-xs text-foreground"
                  disabled={
                    onEnvironmentChange === undefined ||
                    environmentOptions.length < 2 ||
                    isCreating ||
                    isSaving
                  }
                  onChange={(event) => {
                    const nextEnvironmentId = event.currentTarget.value as EnvironmentId;
                    if (
                      hasUnsavedChanges &&
                      !window.confirm("Discard unsaved automation changes and switch environments?")
                    ) {
                      event.currentTarget.value = environmentId;
                      return;
                    }
                    onEnvironmentChange?.(nextEnvironmentId);
                  }}
                  aria-description={
                    hasUnsavedChanges
                      ? "Switching environments will ask before discarding unsaved changes"
                      : "Automations are stored and run by this environment"
                  }
                  value={environmentId}
                >
                  {environmentOptions.map((environment) => (
                    <option key={environment.id} value={environment.id}>
                      {environment.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <Button render={<a href="/settings/connections" />} size="sm" variant="outline">
              <PlusIcon />
              Add environment
            </Button>
            {canCreate ? (
              <Button
                disabled={authoringUnavailable}
                onClick={() => setShowCreate(true)}
                size="sm"
                title={
                  authoringUnavailable
                    ? "Creating automations isn't supported in this environment yet."
                    : `Create on ${selectedEnvironment?.label ?? "the selected environment"}`
                }
                variant="outline"
              >
                <PlusIcon />
                New automation
              </Button>
            ) : null}
            {selectedAutomation ? (
              <>
                <Badge variant={saveStatus.variant}>{saveStatus.label}</Badge>
                <Button
                  aria-label={`Save automation config commit on ${selectedEnvironment?.label ?? "the selected environment"}`}
                  disabled={saveDisabled}
                  onClick={onSave}
                  size="sm"
                  title={
                    authoringUnavailable
                      ? "Saving automations isn't supported in this environment yet."
                      : `Save immediately on ${selectedEnvironment?.label ?? "the selected environment"}; changes also save automatically`
                  }
                >
                  {isSaving ? (
                    <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" />
                  ) : (
                    <SaveIcon />
                  )}
                  {isSaving ? "Saving" : "Save now"}
                </Button>
              </>
            ) : null}
          </div>
          {authoringUnavailable ? (
            <p className="mt-2 text-xs text-warning" role="status">
              {selectedEnvironment?.label ?? "This environment"} is view and run only. Under Runs
              on, choose a Linux environment configured for automation authoring to create or save.
            </p>
          ) : null}
          {editorError && selectedAutomation ? (
            <p className="mt-2 text-xs text-destructive" role="alert">
              {editorError}
            </p>
          ) : configCommitSha && selectedAutomation ? (
            <p className="mt-1 truncate text-2xs text-muted-foreground">
              Loaded from config commit {configCommitSha.slice(0, 10)} on{" "}
              {selectedEnvironment?.label ?? "the selected environment"}
            </p>
          ) : null}
          {refreshError ? (
            <p className="mt-2 text-xs text-destructive" role="alert">
              {refreshError}
            </p>
          ) : null}
          {showCreate && onCreate ? (
            <div
              aria-label="New automation"
              className="mt-3 grid gap-2 rounded-xl border bg-background p-3 sm:grid-cols-[minmax(12rem,1fr)_minmax(10rem,14rem)_auto_auto]"
            >
              <label className="text-xs font-medium">
                Name
                <Input
                  aria-label="New automation name"
                  className="mt-1"
                  disabled={isCreating}
                  nativeInput
                  onChange={(event) => setNewAutomationName(event.currentTarget.value)}
                  size="sm"
                  value={newAutomationName}
                />
              </label>
              <label className="text-xs font-medium">
                Space
                <select
                  aria-label="New automation Space"
                  className="mt-1 h-8 w-full rounded-lg border border-input bg-background px-2 text-xs"
                  disabled={isCreating}
                  onChange={(event) => setNewAutomationSpaceId(event.currentTarget.value)}
                  value={effectiveNewSpaceId}
                >
                  {spaces.map((space) => (
                    <option key={space.id} value={space.id}>
                      {space.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                className="self-end"
                disabled={
                  isCreating ||
                  newAutomationName.trim().length === 0 ||
                  effectiveNewSpaceId.length === 0
                }
                onClick={() =>
                  onCreate({
                    name: newAutomationName.trim(),
                    spaceId: effectiveNewSpaceId,
                  })
                }
                size="sm"
              >
                {isCreating ? (
                  <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" />
                ) : (
                  <PlusIcon />
                )}
                {isCreating ? "Creating" : "Create local draft"}
              </Button>
              <Button
                aria-label="Close new automation form"
                className="self-end"
                disabled={isCreating}
                onClick={() => setShowCreate(false)}
                size="icon-sm"
                variant="ghost"
              >
                <XIcon />
              </Button>
            </div>
          ) : null}
        </header>

        <main className="flex min-h-0 flex-1 flex-col md:flex-row">
          <aside className="max-h-72 w-full shrink-0 border-b bg-sidebar md:max-h-none md:w-72 md:border-r md:border-b-0">
            <ScrollArea className="h-full" scrollFade>
              <section aria-labelledby="automations-scheduled-tasks-heading" className="pt-3">
                <div className="px-3 pb-2">
                  <h2 className="text-xs font-medium" id="automations-scheduled-tasks-heading">
                    Scheduled tasks
                  </h2>
                  <p className="mt-0.5 text-2xs text-muted-foreground">
                    Run by this environment's scheduler
                  </p>
                </div>
                {scheduledTasksStatus === "loading" ? (
                  <SectionSkeleton label="Loading scheduled tasks" />
                ) : scheduledTasksStatus === "unavailable" ? (
                  <SectionNotice
                    description={
                      scheduledTasksError ?? "The environment did not return its scheduled tasks."
                    }
                    icon={FileWarningIcon}
                    slot="scheduled-tasks-unavailable"
                    title="Scheduled tasks could not be loaded"
                    tone="error"
                  />
                ) : sortedTasks.length === 0 ? (
                  <SectionNotice
                    actions={
                      onOpenScheduledTasksSettings ? (
                        <Button onClick={onOpenScheduledTasksSettings} size="sm" variant="outline">
                          <Settings2Icon />
                          Scheduled tasks settings
                        </Button>
                      ) : undefined
                    }
                    description="Create one under Settings → Scheduled tasks, or ask an agent to schedule a task."
                    icon={CalendarClockIcon}
                    slot="scheduled-tasks-empty"
                    title="No scheduled tasks yet"
                  />
                ) : (
                  <nav aria-label="Scheduled tasks" className="space-y-0.5 px-2 pb-3">
                    {sortedTasks.map((task) => {
                      const labels = scheduledTaskRowLabels(task);
                      return (
                        <RecurringRow
                          health={labels.health}
                          icon={CalendarClockIcon}
                          key={task.id}
                          onSelect={() => select({ kind: "scheduled-task", id: task.id })}
                          primary={labels.primary}
                          secondary={labels.secondary}
                          selected={selectedTask?.id === task.id}
                          title={task.title}
                        />
                      );
                    })}
                  </nav>
                )}
              </section>

              <section aria-labelledby="automations-definitions-heading" className="border-t pt-3">
                <div className="px-3 pb-2">
                  <h2 className="text-xs font-medium" id="automations-definitions-heading">
                    Config automations
                  </h2>
                  <p className="mt-0.5 text-2xs text-muted-foreground">
                    Committed private configuration
                  </p>
                </div>
                {status === "loading" ? (
                  <div data-slot="automations-loading">
                    <SectionSkeleton label="Loading committed automation definitions" />
                  </div>
                ) : status === "unavailable" ? (
                  <SectionNotice
                    actions={
                      onRefresh ? (
                        <RefreshButton isRefreshing={isRefreshing} onRefresh={onRefresh} />
                      ) : undefined
                    }
                    description="The environment did not return its committed automation definitions."
                    icon={FileWarningIcon}
                    slot="automations-unavailable"
                    title="Automations could not be loaded"
                    tone="error"
                  />
                ) : status === "config-unavailable" ? (
                  <SectionNotice
                    actions={
                      onRefresh ? (
                        <RefreshButton isRefreshing={isRefreshing} onRefresh={onRefresh} />
                      ) : undefined
                    }
                    description="Connect a valid private configuration checkout to view committed automation definitions."
                    icon={LockKeyholeIcon}
                    slot="automations-config-unavailable"
                    title="Private configuration is unavailable"
                  />
                ) : sortedAutomations.length === 0 ? (
                  <SectionNotice
                    actions={
                      <>
                        {canCreate ? (
                          <Button
                            disabled={authoringUnavailable}
                            onClick={() => setShowCreate(true)}
                            size="sm"
                          >
                            <PlusIcon />
                            New automation
                          </Button>
                        ) : null}
                        {onRefresh ? (
                          <RefreshButton isRefreshing={isRefreshing} onRefresh={onRefresh} />
                        ) : null}
                      </>
                    }
                    description="Definitions appear here after they are validated and committed in private configuration."
                    icon={WorkflowIcon}
                    slot="automations-empty"
                    title="No committed automations yet"
                  />
                ) : (
                  <nav aria-label="Automation definitions" className="space-y-0.5 px-2 pb-3">
                    {sortedAutomations.map((automation) => {
                      const labels = automationRowLabels(automation, runs, spaces);
                      return (
                        <RecurringRow
                          health={labels.health}
                          icon={WorkflowIcon}
                          key={automation.id}
                          onSelect={() => select({ kind: "automation", id: automation.id })}
                          primary={labels.primary}
                          secondary={labels.secondary}
                          selected={selectedAutomation?.id === automation.id}
                          title={automation.name}
                        />
                      );
                    })}
                  </nav>
                )}
              </section>
            </ScrollArea>
          </aside>

          <section
            aria-label={
              selectedTask
                ? "Selected scheduled task"
                : selectedAutomation
                  ? "Selected automation definition"
                  : "Nothing selected"
            }
            className="min-h-0 min-w-0 flex-1 p-2 sm:p-3"
          >
            {selectedTask ? (
              <ScheduledTaskDetails
                busy={busyScheduledTaskId === selectedTask.id}
                canOperate={canOperateScheduledTasks}
                onEdit={onEditScheduledTask}
                onOpenThread={onOpenScheduledTaskThread}
                onRunNow={onRunScheduledTaskNow}
                onSetEnabled={onSetScheduledTaskEnabled}
                task={selectedTask}
              />
            ) : selectedAutomation ? (
              editorStatus === "loading" ? (
                <div
                  className="flex h-full min-h-[28rem] items-center justify-center rounded-lg border bg-card text-sm text-muted-foreground"
                  data-slot="automation-definition-loading"
                  role="status"
                >
                  <LoaderCircleIcon className="mr-2 size-4 animate-spin motion-reduce:animate-none" />
                  Loading exact committed source
                </div>
              ) : editorStatus === "ready" && editorDefinition && onDefinitionChange ? (
                <AutomationEditor
                  className="h-full min-h-[28rem]"
                  connections={connections}
                  definition={editorDefinition}
                  environmentTimezone={environmentTimezone}
                  onDefinitionChange={onDefinitionChange}
                  onBeginGoogleConnectionSetup={onBeginGoogleConnectionSetup}
                  onCompleteGoogleConnectionSetup={onCompleteGoogleConnectionSetup}
                  onRemoveGoogleConnection={onRemoveGoogleConnection}
                  onInterpretSchedule={onInterpretSchedule}
                  readOnly={authoringUnavailable}
                  selectedSpace={spaces.find((space) => space.id === editorDefinition.spaceId)}
                />
              ) : (
                <div
                  className="flex h-full min-h-[28rem] flex-col items-center justify-center rounded-lg border bg-card px-6 text-center"
                  data-slot="automation-definition-unavailable"
                >
                  <FileWarningIcon className="size-5 text-muted-foreground" />
                  <p className="mt-2 text-sm font-medium">Exact source is unavailable</p>
                  <p className="mt-1 max-w-md text-xs text-muted-foreground">
                    Reload the private checkout before editing this automation.
                  </p>
                </div>
              )
            ) : (
              <div
                className="flex h-full min-h-[28rem] flex-col rounded-lg border bg-card"
                data-slot="automations-nothing-recurring"
              >
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <CalendarClockIcon />
                    </EmptyMedia>
                    <EmptyTitle>Nothing recurring yet</EmptyTitle>
                    <EmptyDescription>
                      Every scheduled task and committed automation this environment runs will be
                      listed here with its last and next run, failures first.
                    </EmptyDescription>
                  </EmptyHeader>
                  <EmptyContent>
                    {onOpenScheduledTasksSettings ? (
                      <Button onClick={onOpenScheduledTasksSettings} size="sm" variant="outline">
                        <Settings2Icon />
                        Scheduled tasks settings
                      </Button>
                    ) : null}
                    {canCreate ? (
                      <Button
                        disabled={authoringUnavailable}
                        onClick={() => setShowCreate(true)}
                        size="sm"
                        variant="outline"
                      >
                        <PlusIcon />
                        New automation
                      </Button>
                    ) : null}
                  </EmptyContent>
                </Empty>
              </div>
            )}
          </section>
        </main>
      </div>
    </SidebarInset>
  );
}
