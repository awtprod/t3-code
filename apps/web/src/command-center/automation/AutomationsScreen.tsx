"use client";

import type { Automation, Space } from "@command-center/core";
import {
  ArrowLeftIcon,
  CheckCircle2Icon,
  Clock3Icon,
  CloudOffIcon,
  FileWarningIcon,
  LoaderCircleIcon,
  LockKeyholeIcon,
  PlusIcon,
  RefreshCwIcon,
  SaveIcon,
  WorkflowIcon,
  XIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

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
import { automationSpaceName, type AutomationsScreenStatus } from "./AutomationsScreen.logic";
import { validateAutomationEditorDefinition } from "./logic";
import type { AutomationEditorDefinition } from "./types";

export interface AutomationsScreenProps {
  readonly status: AutomationsScreenStatus;
  readonly automations: ReadonlyArray<Automation>;
  readonly spaces: ReadonlyArray<Space>;
  readonly onRefresh?: (() => void) | undefined;
  readonly onCreate?:
    | ((input: { readonly name: string; readonly spaceId: string }) => void)
    | undefined;
  readonly isCreating?: boolean | undefined;
  readonly selectedAutomationId?: string | undefined;
  readonly onSelectAutomation?: ((automationId: string) => void) | undefined;
  readonly editorDefinition?: AutomationEditorDefinition | null | undefined;
  readonly editorStatus?: "loading" | "ready" | "unavailable" | undefined;
  readonly editorError?: string | null | undefined;
  readonly isDirty?: boolean | undefined;
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
}

function triggerLabel(automation: Automation): string {
  switch (automation.trigger.type) {
    case "manual":
      return "Manual";
    case "schedule":
      return "Scheduled";
    case "webhook":
      return "Webhook";
  }
}

function AutomationsLoading() {
  return (
    <div
      aria-label="Loading automations"
      className="flex min-h-0 flex-1 flex-col gap-4 p-4 md:flex-row"
      data-slot="automations-loading"
      role="status"
    >
      <div className="w-full space-y-2 md:w-64">
        <Skeleton className="h-16 w-full rounded-xl" />
        <Skeleton className="h-16 w-full rounded-xl" />
        <Skeleton className="h-16 w-full rounded-xl" />
      </div>
      <Skeleton className="min-h-[28rem] flex-1 rounded-2xl" />
      <span className="sr-only">Loading committed automation definitions</span>
    </div>
  );
}

interface AutomationEmptyStateProps {
  readonly status: Exclude<AutomationsScreenStatus, "loading" | "ready"> | "empty";
  readonly onRefresh?: (() => void) | undefined;
  readonly onNew?: (() => void) | undefined;
}

function AutomationEmptyState({ status, onRefresh, onNew }: AutomationEmptyStateProps) {
  const content =
    status === "disconnected"
      ? {
          title: "Connect an environment",
          description: "Automations are loaded from the selected Command Center environment.",
          icon: CloudOffIcon,
        }
      : status === "config-unavailable"
        ? {
            title: "Private configuration is unavailable",
            description:
              "Connect a valid private configuration checkout to view committed automation definitions.",
            icon: LockKeyholeIcon,
          }
        : status === "empty"
          ? {
              title: "No committed automations yet",
              description:
                "Definitions will appear here after they are validated and committed in private configuration.",
              icon: WorkflowIcon,
            }
          : {
              title: "Automations could not be loaded",
              description: "The environment did not return its committed automation definitions.",
              icon: FileWarningIcon,
            };
  const Icon = content.icon;

  return (
    <Empty className="bg-background" data-slot={`automations-${status}`}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>{content.title}</EmptyTitle>
        <EmptyDescription>{content.description}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        {onNew && status === "empty" ? (
          <Button onClick={onNew} size="sm">
            <PlusIcon />
            New automation
          </Button>
        ) : null}
        {onRefresh && status !== "disconnected" ? (
          <Button onClick={onRefresh} size="sm" variant="outline">
            <RefreshCwIcon />
            Check again
          </Button>
        ) : null}
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
  onRefresh,
  onCreate,
  isCreating = false,
  selectedAutomationId: controlledSelectedAutomationId,
  onSelectAutomation,
  editorDefinition,
  editorStatus = "unavailable",
  editorError,
  isDirty = false,
  isSaving = false,
  onDefinitionChange,
  onSave,
  configCommitSha,
  authoringHealth,
}: AutomationsScreenProps) {
  const [localSelectedAutomationId, setLocalSelectedAutomationId] = useState<string>();
  const [showCreate, setShowCreate] = useState(false);
  const [newAutomationName, setNewAutomationName] = useState("New automation");
  const [newAutomationSpaceId, setNewAutomationSpaceId] = useState("");
  const selectedAutomationId = controlledSelectedAutomationId ?? localSelectedAutomationId;
  const selectedAutomation =
    automations.find((automation) => automation.id === selectedAutomationId) ?? automations[0];
  const blockingIssueCount = useMemo(
    () =>
      editorDefinition === null || editorDefinition === undefined
        ? 0
        : validateAutomationEditorDefinition(editorDefinition).filter(
            (issue) => (issue.severity ?? "error") === "error",
          ).length,
    [editorDefinition],
  );
  const editable =
    editorStatus === "ready" &&
    editorDefinition !== null &&
    editorDefinition !== undefined &&
    onDefinitionChange !== undefined;
  const authoringUnavailable = authoringHealth?.status === "unavailable";
  const saveDisabled =
    authoringUnavailable ||
    !editable ||
    !isDirty ||
    isSaving ||
    blockingIssueCount > 0 ||
    onSave === undefined;
  const effectiveNewSpaceId =
    newAutomationSpaceId ||
    spaces.find((space) => space.kind === "system")?.id ||
    spaces[0]?.id ||
    "";

  const selectAutomation = (automationId: string) => {
    setLocalSelectedAutomationId(automationId);
    onSelectAutomation?.(automationId);
  };

  return (
    <SidebarInset className="h-full min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
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
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-sm font-semibold">Automations</h1>
            </div>
            <span className="hidden items-center gap-1.5 text-[0.6875rem] text-muted-foreground sm:flex">
              <LockKeyholeIcon />
              Private config
            </span>
            {status === "ready" && onCreate && spaces.length > 0 ? (
              <Button
                disabled={authoringUnavailable}
                onClick={() => setShowCreate(true)}
                size="sm"
                title={
                  authoringUnavailable
                    ? "Creating automations isn't supported in this environment yet."
                    : undefined
                }
                variant="outline"
              >
                <PlusIcon />
                New automation
              </Button>
            ) : null}
            {selectedAutomation ? (
              <>
                <Badge variant={isDirty ? "warning" : "success"}>
                  {isDirty ? "Unsaved" : "Committed"}
                </Badge>
                <Button
                  aria-label="Save local automation config commit"
                  disabled={saveDisabled}
                  onClick={onSave}
                  size="sm"
                  title={
                    authoringUnavailable
                      ? "Saving automations isn't supported in this environment yet."
                      : undefined
                  }
                >
                  {isSaving ? (
                    <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" />
                  ) : (
                    <SaveIcon />
                  )}
                  {isSaving ? "Saving" : "Save local commit"}
                </Button>
              </>
            ) : null}
          </div>
          {authoringUnavailable ? (
            <p className="mt-2 text-xs text-warning" role="status">
              View and run only. Creating and saving automations isn&apos;t supported in this
              environment yet.
            </p>
          ) : null}
          {editorError ? (
            <p className="mt-2 text-xs text-destructive" role="alert">
              {editorError}
            </p>
          ) : configCommitSha ? (
            <p className="mt-1 truncate text-[0.6875rem] text-muted-foreground">
              Loaded from local config commit {configCommitSha.slice(0, 10)}
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

        {status === "loading" ? <AutomationsLoading /> : null}
        {status !== "loading" && status !== "ready" ? (
          <AutomationEmptyState onRefresh={onRefresh} status={status} />
        ) : null}
        {status === "ready" && automations.length === 0 ? (
          <main className="flex min-h-0 flex-1">
            <aside className="hidden w-60 shrink-0 border-r bg-sidebar md:block">
              <div className="border-b px-3 py-3">
                <div className="text-xs font-medium">Definitions</div>
                <p className="mt-0.5 text-[0.6875rem] text-muted-foreground">
                  Committed private configuration
                </p>
              </div>
            </aside>
            <AutomationEmptyState
              onNew={onCreate && spaces.length > 0 ? () => setShowCreate(true) : undefined}
              onRefresh={onRefresh}
              status="empty"
            />
          </main>
        ) : null}

        {status === "ready" && selectedAutomation ? (
          <main className="flex min-h-0 flex-1 flex-col md:flex-row">
            <aside className="max-h-52 w-full shrink-0 border-b bg-sidebar md:max-h-none md:w-60 md:border-b-0 md:border-r">
              <div className="border-b px-3 py-3">
                <div className="text-xs font-medium">Definitions</div>
                <p className="mt-0.5 text-[0.6875rem] text-muted-foreground">
                  {automations.length} committed automation{automations.length === 1 ? "" : "s"}
                </p>
              </div>
              <ScrollArea className="h-[calc(100%-3.875rem)]" scrollFade>
                <nav aria-label="Automation definitions" className="space-y-0.5 p-2">
                  {automations.map((automation) => {
                    const selected = automation.id === selectedAutomation.id;
                    return (
                      <button
                        aria-current={selected ? "page" : undefined}
                        className={cn(
                          "w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-sidebar-accent",
                          selected && "bg-sidebar-accent text-sidebar-accent-foreground",
                        )}
                        key={automation.id}
                        onClick={() => selectAutomation(automation.id)}
                        type="button"
                      >
                        <span className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-xs font-medium">
                            {automation.name}
                          </span>
                          {automation.enabled ? (
                            <CheckCircle2Icon
                              aria-label="Enabled"
                              className="size-3.5 shrink-0 text-success"
                            />
                          ) : null}
                        </span>
                        <span className="mt-1 flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
                          <Clock3Icon className="size-3" />
                          {triggerLabel(automation)} · {automationSpaceName(automation, spaces)}
                        </span>
                      </button>
                    );
                  })}
                </nav>
              </ScrollArea>
            </aside>

            <section
              aria-label="Selected automation definition"
              className="min-h-0 min-w-0 flex-1 p-2 sm:p-3"
            >
              {editorStatus === "loading" ? (
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
                  definition={editorDefinition}
                  onDefinitionChange={onDefinitionChange}
                  readOnly={authoringUnavailable}
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
              )}
            </section>
          </main>
        ) : null}
      </div>
    </SidebarInset>
  );
}
