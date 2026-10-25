import type { ScheduledTask } from "@t3tools/contracts";
import {
  CalendarClockIcon,
  LoaderCircleIcon,
  MessageSquareTextIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import {
  relativeLabel,
  scheduleLabel,
  scheduledTaskStatusVariant,
} from "~/components/settings/scheduledTasksSettings.logic";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";

export interface ScheduledTaskDetailsProps {
  readonly task: ScheduledTask;
  readonly canOperate: boolean;
  readonly busy: boolean;
  readonly onRunNow?: ((task: ScheduledTask) => void) | undefined;
  readonly onSetEnabled?: ((task: ScheduledTask, enabled: boolean) => void) | undefined;
  readonly onOpenThread?: ((task: ScheduledTask) => void) | undefined;
  readonly onEdit?: ((task: ScheduledTask) => void) | undefined;
}

const STATUS_LABELS: Record<ScheduledTask["lastRunStatus"], string> = {
  never: "Not run yet",
  running: "Running",
  succeeded: "Last run succeeded",
  failed: "Last run failed",
};

const WORKSPACE_LABELS: Record<ScheduledTask["workspaceStrategy"]["type"], string> = {
  worktree: "New worktree each run",
  root: "Project checkout",
  existing_worktree: "Specific checkout",
};

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-2xs text-muted-foreground">{label}</dt>
      <dd className="truncate text-xs">{children}</dd>
    </div>
  );
}

/**
 * The scheduler stores whatever the failure printed, often a stack trace. The
 * first line is the message; the rest stays one click away for debugging.
 */
function LastRunError({ error }: { readonly error: string }) {
  const [message, ...rest] = error.split("\n");
  const details = rest.join("\n").trim();
  return (
    <div
      className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
      role="alert"
    >
      <p className="whitespace-pre-wrap">{message}</p>
      {details.length > 0 ? (
        <details className="mt-1">
          <summary className="cursor-pointer text-2xs text-destructive/80">Show details</summary>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-2xs">
            {details}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

/** What a scheduled task does, when it last ran, and the controls to run or pause it. */
export function ScheduledTaskDetails({
  task,
  canOperate,
  busy,
  onRunNow,
  onSetEnabled,
  onOpenThread,
  onEdit,
}: ScheduledTaskDetailsProps) {
  const isWebhook = task.schedule.type === "webhook";
  const nextRun = !task.enabled
    ? "Paused"
    : isWebhook
      ? "Listening for requests"
      : relativeLabel(task.nextRunAt);

  return (
    <article
      aria-label={`Scheduled task ${task.title}`}
      className="flex h-full min-h-[28rem] flex-col gap-4 rounded-lg border bg-card p-4"
      data-slot="scheduled-task-details"
    >
      <header className="flex items-start gap-2">
        <CalendarClockIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">{task.title}</h2>
          <p className="text-2xs text-muted-foreground">
            Scheduled task · {scheduleLabel(task.schedule)}
          </p>
        </div>
        <Badge variant={task.enabled ? scheduledTaskStatusVariant(task.lastRunStatus) : "outline"}>
          {task.enabled ? STATUS_LABELS[task.lastRunStatus] : "Paused"}
        </Badge>
      </header>

      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
        <Fact label="Next run">{nextRun}</Fact>
        <Fact label="Last run">
          {task.lastRunAt === null ? "Never" : relativeLabel(task.lastRunAt)}
        </Fact>
        <Fact label="Model">
          {task.modelSelection.model}
          <span className="text-muted-foreground"> · {task.modelSelection.instanceId}</span>
        </Fact>
        <Fact label="Access">{task.runtimeMode.replaceAll("-", " ")}</Fact>
        <Fact label="Runs so far">{task.runCount}</Fact>
        <Fact label="Runs in">
          {task.threadId === null
            ? WORKSPACE_LABELS[task.workspaceStrategy.type]
            : "Its own thread"}
        </Fact>
      </dl>

      {task.lastRunError ? <LastRunError error={task.lastRunError} /> : null}

      <section aria-label="Prompt" className="flex min-h-0 flex-1 flex-col">
        <h3 className="text-2xs font-medium text-muted-foreground">Prompt</h3>
        <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded-md border bg-background p-3 font-sans text-xs">
          {task.prompt}
        </pre>
      </section>

      <footer className="flex flex-wrap gap-2">
        {/* A webhook task runs from its URL; there is no request to run it with. */}
        {isWebhook ? null : (
          <Button
            disabled={!canOperate || busy || task.lastRunStatus === "running"}
            onClick={() => onRunNow?.(task)}
            size="sm"
          >
            {busy ? (
              <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" />
            ) : (
              <PlayIcon />
            )}
            Run now
          </Button>
        )}
        <Button
          disabled={!canOperate || busy}
          onClick={() => onSetEnabled?.(task, !task.enabled)}
          size="sm"
          variant="outline"
        >
          {task.enabled ? <PauseIcon /> : <PlayIcon />}
          {task.enabled ? "Pause" : "Resume"}
        </Button>
        {task.threadId !== null && onOpenThread ? (
          <Button onClick={() => onOpenThread(task)} size="sm" variant="outline">
            <MessageSquareTextIcon />
            Open thread
          </Button>
        ) : null}
        {onEdit ? (
          <Button onClick={() => onEdit(task)} size="sm" variant="ghost">
            <PencilIcon />
            Edit in Settings
          </Button>
        ) : null}
      </footer>
    </article>
  );
}
