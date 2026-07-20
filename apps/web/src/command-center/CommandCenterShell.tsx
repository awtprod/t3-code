"use client";

import {
  AlertCircleIcon,
  ArrowUpIcon,
  ArrowUpRightIcon,
  BotIcon,
  CalendarDaysIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleIcon,
  Clock3Icon,
  PanelRightIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  TriangleAlertIcon,
  UserRoundIcon,
  WifiIcon,
  WifiOffIcon,
  WorkflowIcon,
} from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger } from "~/components/ui/select";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPopup,
  SheetTitle,
} from "~/components/ui/sheet";
import { Textarea } from "~/components/ui/textarea";
import { cn } from "~/lib/utils";

import type {
  CommandCenterActiveRun,
  CommandCenterConnection,
  CommandCenterContext,
  CommandCenterMessage,
  CommandCenterNeedsYouItem,
  CommandCenterRisk,
  CommandCenterRouteControl,
  CommandCenterRouteOption,
  CommandCenterRouteReceipt,
  CommandCenterRouteSource,
  CommandCenterShellProps,
  CommandCenterTodayItem,
} from "./types";
import { CommandCenterHistoryMenu } from "./CommandCenterHistoryMenu";

const STATUS_DOT_CLASS = {
  failed: "bg-destructive",
  idle: "bg-muted-foreground/40",
  queued: "bg-muted-foreground/40",
  running: "bg-info",
  waiting: "bg-warning",
} as const;

const RISK_LABEL: Record<CommandCenterRisk, string> = {
  "approval-required": "Approval required",
  blocked: "Blocked",
  low: "Low risk",
  reversible: "Reversible",
};

const RISK_VARIANT: Record<CommandCenterRisk, "error" | "success" | "warning"> = {
  "approval-required": "error",
  blocked: "error",
  low: "success",
  reversible: "warning",
};

const AUTO_ROUTE_VALUE = "__command_center_auto__";

const ROUTE_SOURCE_LABEL: Record<CommandCenterRouteSource, string> = {
  auto: "Auto",
  classifier: "Inferred",
  explicit: "Selected",
  fallback: "Fallback",
  "provider-default": "Default",
  policy: "Policy",
  unresolved: "Unresolved",
};

function RouteFact({
  label,
  source,
  value,
}: {
  readonly label: string;
  readonly source: CommandCenterRouteSource;
  readonly value: string;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-border/70 bg-background/65 px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[0.625rem] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
          {label}
        </span>
        <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[0.5625rem] font-medium text-muted-foreground">
          {ROUTE_SOURCE_LABEL[source]}
        </span>
      </div>
      <div className="mt-1 truncate text-xs font-medium" title={value}>
        {value}
      </div>
    </div>
  );
}

function RouteReceipt({ receipt }: { readonly receipt: CommandCenterRouteReceipt }) {
  const isActive = receipt.status === "ready" || receipt.status === "running";

  return (
    <details
      aria-label="Current command route"
      className="group mx-auto w-full min-w-0 max-w-3xl overflow-hidden border-b border-border/60"
    >
      <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 px-1 py-2.5 text-xs [&::-webkit-details-marker]:hidden">
        <WorkflowIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium">Route</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {receipt.spaceName}
          {receipt.repositoryName ? ` / ${receipt.repositoryName}` : ""} · {receipt.providerName} ·{" "}
          {receipt.modelName}
        </span>
        <span className="hidden shrink-0 items-center gap-1 text-[0.6875rem] text-muted-foreground min-[26rem]:inline-flex">
          <span
            className={cn(
              "size-1.5 rounded-full",
              isActive ? "animate-pulse bg-info" : "bg-success",
              receipt.status === "waiting-approval" && "bg-warning",
              receipt.status === "blocked" && "bg-destructive",
            )}
          />
          {receipt.status === "blocked"
            ? "Blocked"
            : receipt.status === "waiting-approval"
              ? "Approval"
              : receipt.status === "complete"
                ? "Complete"
                : receipt.status === "running"
                  ? "Running"
                  : "Ready"}
        </span>
        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="pb-3 pl-6 pr-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">{receipt.summary}</span>
          <Badge size="sm" variant={RISK_VARIANT[receipt.risk]}>
            {RISK_LABEL[receipt.risk]}
          </Badge>
        </div>
        <div className="mt-2 grid min-w-0 grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-5">
          <RouteFact label="Space" source={receipt.sources.space} value={receipt.spaceName} />
          {receipt.repositoryName !== undefined && (
            <RouteFact
              label="Repository"
              source={receipt.sources.repository}
              value={receipt.repositoryName}
            />
          )}
          {receipt.projectName !== undefined && (
            <RouteFact
              label="Project"
              source={receipt.sources.project}
              value={receipt.projectName}
            />
          )}
          <RouteFact
            label="Provider"
            source={receipt.sources.provider}
            value={receipt.providerName}
          />
          <RouteFact label="Model" source={receipt.sources.model} value={receipt.modelName} />
        </div>
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="mr-0.5 text-[0.625rem] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
            Capabilities
          </span>
          {receipt.capabilities.length === 0 ? (
            <span className="text-[0.6875rem] text-muted-foreground">None selected</span>
          ) : (
            receipt.capabilities.map((capability) => (
              <Badge key={capability} size="sm" variant="secondary">
                {capability}
              </Badge>
            ))
          )}
        </div>
      </div>
    </details>
  );
}

function MessageAvatar({ author }: Pick<CommandCenterMessage, "author">) {
  return (
    <span
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-lg border",
        author === "assistant" && "border-primary/20 bg-primary/8 text-primary",
        author === "user" && "border-border bg-muted text-muted-foreground",
        author === "system" && "border-info/20 bg-info/8 text-info-foreground",
      )}
    >
      {author === "assistant" ? (
        <BotIcon className="size-3.5" />
      ) : author === "user" ? (
        <UserRoundIcon className="size-3.5" />
      ) : (
        <SparklesIcon className="size-3.5" />
      )}
    </span>
  );
}

function Messages({
  messages,
  onOpenLinkedThread,
}: {
  readonly messages: readonly CommandCenterMessage[];
  readonly onOpenLinkedThread?: ((threadId: string) => void) | undefined;
}) {
  if (messages.length === 0) {
    return (
      <div className="mx-auto flex h-full w-full min-w-0 max-w-lg flex-col items-center justify-center overflow-hidden px-6 text-center">
        <span className="mb-4 flex size-12 items-center justify-center rounded-2xl border bg-card shadow-sm">
          <SparklesIcon className="size-5 text-primary" />
        </span>
        <h2 className="max-w-full text-pretty font-heading text-lg font-semibold">
          What do you want to move forward?
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Start with a question, a task, or an idea. Command Center will show where it plans to
          route the work before it begins.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6">
      {messages.map((message) => (
        <article className="flex items-start gap-3" key={message.id}>
          <MessageAvatar author={message.author} />
          <div className="min-w-0 flex-1 pt-0.5">
            <div className="flex items-baseline gap-2">
              <span className="text-xs font-semibold">
                {message.authorLabel ??
                  (message.author === "assistant"
                    ? "Command Center"
                    : message.author === "user"
                      ? "You"
                      : "System")}
              </span>
              <span className="text-[0.6875rem] text-muted-foreground">
                {message.createdAtLabel}
              </span>
            </div>
            <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-foreground/90">
              {message.body}
            </p>
            {message.linkedThreadId !== undefined && (
              <Button
                className="mt-2"
                onClick={() => {
                  if (message.linkedThreadId !== undefined) {
                    onOpenLinkedThread?.(message.linkedThreadId);
                  }
                }}
                size="xs"
                type="button"
                variant="outline"
              >
                Open linked work
                <ArrowUpRightIcon />
              </Button>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}

function RouteSelector({
  control,
  label,
  onChange,
  options,
  value,
}: {
  readonly control: CommandCenterRouteControl;
  readonly label: string;
  readonly onChange?:
    | ((control: CommandCenterRouteControl, value: string | undefined) => void)
    | undefined;
  readonly options: readonly CommandCenterRouteOption[];
  readonly value?: string | undefined;
}) {
  const selected = options.find((option) => option.id === value);
  return (
    <Select
      disabled={onChange === undefined}
      modal={false}
      onValueChange={(nextValue) =>
        onChange?.(
          control,
          nextValue === null || nextValue === AUTO_ROUTE_VALUE ? undefined : nextValue,
        )
      }
      value={value ?? AUTO_ROUTE_VALUE}
    >
      <SelectTrigger
        aria-label={`${label} route selection`}
        className="h-7 min-h-7 w-auto max-w-full min-w-0 gap-1 rounded-md px-2 text-[0.6875rem] font-medium"
        size="xs"
      >
        <span className="truncate text-muted-foreground">{label}:</span>
        <span className="max-w-28 truncate">{selected?.label ?? "Auto"}</span>
      </SelectTrigger>
      <SelectPopup align="start" alignItemWithTrigger={false} className="min-w-56">
        <SelectItem value={AUTO_ROUTE_VALUE}>
          <span className="flex flex-col">
            <span>Auto</span>
            <span className="text-[0.6875rem] text-muted-foreground">Use routing policy</span>
          </span>
        </SelectItem>
        {options.map((option) => (
          <SelectItem key={option.id} value={option.id}>
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{option.label}</span>
              {option.detail !== undefined && (
                <span className="truncate text-[0.6875rem] text-muted-foreground">
                  {option.detail}
                </span>
              )}
            </span>
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function Composer({
  draft,
  isSubmitting,
  commandUnavailable,
  configNotice,
  routeOptions,
  routeSelection,
  receipt,
  spaces,
  onDraftChange,
  onRouteSelectionChange,
  onSubmit,
}: Pick<
  CommandCenterShellProps,
  | "draft"
  | "isSubmitting"
  | "commandUnavailable"
  | "configNotice"
  | "onDraftChange"
  | "onSubmit"
  | "onRouteSelectionChange"
  | "routeOptions"
  | "routeSelection"
  | "spaces"
> & { readonly receipt: CommandCenterRouteReceipt }) {
  const selectedSpace = spaces.find((space) => space.id === routeSelection.spaceId);
  const selectedProvider = routeOptions.providers.find(
    (provider) => provider.id === routeSelection.providerId,
  );
  const selectedModel = routeOptions.models.find((model) => model.id === routeSelection.modelId);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const command = draft.trim();
    if (!command || isSubmitting || commandUnavailable) return;
    onSubmit(command);
  };

  return (
    <div className="min-w-0 shrink-0 bg-gradient-to-t from-background via-background to-transparent px-3 pb-3 pt-5 sm:px-5 sm:pb-5">
      {configNotice ? (
        <div
          className="mx-auto mb-2 flex w-full min-w-0 max-w-3xl items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
          data-slot="command-center-config-notice"
          role="status"
        >
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0">
            {configNotice.status === "missing"
              ? "Command Center configuration hasn't been loaded yet. "
              : "Command Center configuration is invalid. "}
            {configNotice.message} You can still draft a command, but sending is disabled until the
            configuration loads.
          </span>
        </div>
      ) : null}
      <form
        aria-label="Command composer"
        className="chat-composer-glass mx-auto w-full min-w-0 max-w-3xl rounded-[20px] border border-border p-2 focus-within:border-ring/45"
        onSubmit={submit}
      >
        <Textarea
          aria-label="Ask Command Center"
          className="w-full min-w-0 border-0 bg-transparent shadow-none before:hidden focus-within:ring-0 dark:bg-transparent"
          disabled={isSubmitting}
          onChange={(event) => onDraftChange(event.target.value)}
          placeholder="Ask, plan, build, or automate anything…"
          rows={2}
          unstyled
          value={draft}
        />
        <div className="flex items-end justify-between gap-2 px-1 pb-1">
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-visible">
            <details className="group/route relative">
              <summary className="flex h-7 cursor-pointer list-none items-center gap-1.5 rounded-md px-2 text-[0.6875rem] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&::-webkit-details-marker]:hidden">
                <SlidersHorizontalIcon className="size-3.5" />
                <span>{selectedSpace?.name ?? "Auto route"}</span>
                <ChevronDownIcon className="size-3 transition-transform group-open/route:rotate-180" />
              </summary>
              <div className="absolute bottom-9 left-0 z-30 w-[min(30rem,calc(100vw-3rem))] rounded-xl border bg-popover p-2 text-popover-foreground shadow-lg">
                <div className="px-1 pb-2 text-xs font-medium">Route this command</div>
                <div className="flex flex-wrap gap-1">
                  <RouteSelector
                    control="space"
                    label="Space"
                    onChange={onRouteSelectionChange}
                    options={spaces.map((space) => ({ id: space.id, label: space.name }))}
                    value={routeSelection.spaceId}
                  />
                  <RouteSelector
                    control="repository"
                    label="Repo"
                    onChange={onRouteSelectionChange}
                    options={routeOptions.repositories}
                    value={routeSelection.repositoryId}
                  />
                  <RouteSelector
                    control="project"
                    label="Project"
                    onChange={onRouteSelectionChange}
                    options={routeOptions.projects}
                    value={routeSelection.projectId}
                  />
                  <RouteSelector
                    control="provider"
                    label="Provider"
                    onChange={onRouteSelectionChange}
                    options={routeOptions.providers}
                    value={routeSelection.providerId}
                  />
                  <RouteSelector
                    control="model"
                    label="Model"
                    onChange={onRouteSelectionChange}
                    options={routeOptions.models}
                    value={routeSelection.modelId}
                  />
                </div>
              </div>
            </details>
            <span className="hidden min-w-0 truncate text-[0.6875rem] text-muted-foreground sm:block">
              {selectedProvider?.label ?? receipt.providerName} ·{" "}
              {selectedModel?.label ?? receipt.modelName}
            </span>
            <Badge className="hidden md:inline-flex" size="sm" variant={RISK_VARIANT[receipt.risk]}>
              {RISK_LABEL[receipt.risk]}
            </Badge>
          </div>
          <Button
            aria-label={isSubmitting ? "Sending command" : "Send command"}
            disabled={!draft.trim() || isSubmitting || commandUnavailable}
            size="icon"
            type="submit"
          >
            <ArrowUpIcon />
          </Button>
        </div>
      </form>
      <p className="mx-auto mt-2 max-w-3xl text-center text-[0.625rem] text-muted-foreground/70">
        High-impact actions pause for approval
      </p>
    </div>
  );
}

function EmptyContext({ children }: { readonly children: ReactNode }) {
  return <p className="px-3 py-4 text-xs leading-relaxed text-muted-foreground">{children}</p>;
}

function ContextButton({
  children,
  onClick,
}: {
  readonly children: ReactNode;
  readonly onClick?: (() => void) | undefined;
}) {
  return (
    <button
      className="group flex w-full items-start gap-2.5 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-accent"
      onClick={onClick}
      type="button"
    >
      {children}
      <ChevronRightIcon className="mt-1 size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  );
}

function NeedsYouRows({
  items,
  onOpen,
  onDecideApproval,
  onReviewMemory,
  resolvingId,
}: {
  readonly items: readonly CommandCenterNeedsYouItem[];
  readonly onOpen?: ((itemId: string) => void) | undefined;
  readonly onDecideApproval?: CommandCenterShellProps["onDecideApproval"];
  readonly onReviewMemory?: CommandCenterShellProps["onReviewMemory"];
  readonly resolvingId?: string | undefined;
}) {
  if (items.length === 0) return <EmptyContext>You are all caught up.</EmptyContext>;

  return items.map((item) => {
    const content = (
      <>
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-lg bg-warning/10 text-warning-foreground">
          <AlertCircleIcon className="size-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 block text-xs font-medium leading-relaxed">
            {item.title}
          </span>
          <span className="mt-0.5 block truncate text-[0.6875rem] text-muted-foreground">
            {item.spaceName} · {item.detail ?? item.reason}
          </span>
        </span>
      </>
    );
    if (item.action === undefined) {
      return (
        <ContextButton key={item.id} onClick={() => onOpen?.(item.id)}>
          {content}
        </ContextButton>
      );
    }

    const action = item.action;
    const resolving =
      resolvingId === (action.kind === "approval" ? action.approvalId : action.memoryId);
    return (
      <article className="rounded-xl hover:bg-accent" key={item.id}>
        <button
          className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left"
          onClick={() => onOpen?.(item.id)}
          type="button"
        >
          {content}
        </button>
        <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2.5 pl-11">
          {action.kind === "approval" ? (
            <>
              <p className="mb-1 w-full whitespace-pre-wrap break-words rounded-lg bg-background/70 p-2 text-[0.6875rem] leading-relaxed text-foreground">
                {action.proposal}
              </p>
              <span
                className="mr-auto max-w-full truncate font-mono text-[0.625rem] text-muted-foreground"
                title={action.payloadDigest}
              >
                Digest {action.payloadDigest.slice(0, 12)}…
              </span>
              <Button
                disabled={resolving}
                onClick={() =>
                  onDecideApproval?.(action.approvalId, action.payloadDigest, "declined")
                }
                size="xs"
                variant="outline"
              >
                Decline
              </Button>
              <Button
                disabled={resolving}
                onClick={() =>
                  onDecideApproval?.(action.approvalId, action.payloadDigest, "approved")
                }
                size="xs"
              >
                Approve
              </Button>
            </>
          ) : (
            <>
              <span className="mr-auto text-[0.625rem] text-muted-foreground">
                {Math.round(action.confidence * 100)}% confidence
              </span>
              <Button
                disabled={resolving}
                onClick={() =>
                  onReviewMemory?.(action.memoryId, action.spaceId, action.repositoryId, "reject")
                }
                size="xs"
                variant="outline"
              >
                Discard
              </Button>
              <Button
                disabled={resolving}
                onClick={() =>
                  onReviewMemory?.(action.memoryId, action.spaceId, action.repositoryId, "approve")
                }
                size="xs"
              >
                Keep
              </Button>
            </>
          )}
        </div>
      </article>
    );
  });
}

function ActiveRunRows({
  runs,
  onOpen,
}: {
  readonly runs: readonly CommandCenterActiveRun[];
  readonly onOpen?: ((runId: string) => void) | undefined;
}) {
  if (runs.length === 0) return <EmptyContext>No work is running right now.</EmptyContext>;

  return runs.map((run) => (
    <ContextButton key={run.id} onClick={() => onOpen?.(run.id)}>
      <span className="mt-1 flex size-6 shrink-0 items-center justify-center">
        <span className={cn("size-2 rounded-full", STATUS_DOT_CLASS[run.status])} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 block text-xs font-medium leading-relaxed">{run.title}</span>
        <span className="mt-0.5 block truncate text-[0.6875rem] text-muted-foreground">
          {run.spaceName} · {run.detail ?? run.status}
        </span>
      </span>
    </ContextButton>
  ));
}

function TodayRows({
  items,
  onOpen,
}: {
  readonly items: readonly CommandCenterTodayItem[];
  readonly onOpen?: ((itemId: string) => void) | undefined;
}) {
  if (items.length === 0) return <EmptyContext>Nothing else is scheduled today.</EmptyContext>;

  return items.map((item) => (
    <ContextButton key={item.id} onClick={() => onOpen?.(item.id)}>
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-lg bg-info/8 text-info-foreground">
        {item.kind === "automation" ? (
          <WorkflowIcon className="size-3.5" />
        ) : item.kind === "task" ? (
          <CheckCircle2Icon className="size-3.5" />
        ) : (
          <CalendarDaysIcon className="size-3.5" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 block text-xs font-medium leading-relaxed">{item.title}</span>
        <span className="mt-0.5 block text-[0.6875rem] text-muted-foreground">
          {item.timeLabel}
        </span>
      </span>
    </ContextButton>
  ));
}

function ConnectionRows({
  connections,
  onOpen,
}: {
  readonly connections: readonly CommandCenterConnection[];
  readonly onOpen?: ((connectionId: string) => void) | undefined;
}) {
  if (connections.length === 0) return <EmptyContext>No connections configured.</EmptyContext>;

  return connections.map((connection) => (
    <ContextButton key={connection.id} onClick={() => onOpen?.(connection.id)}>
      <span
        className={cn(
          "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-lg",
          connection.status === "healthy" && "bg-success/8 text-success-foreground",
          connection.status === "degraded" && "bg-warning/8 text-warning-foreground",
          connection.status === "offline" && "bg-destructive/8 text-destructive-foreground",
        )}
      >
        {connection.status === "offline" ? (
          <WifiOffIcon className="size-3.5" />
        ) : (
          <WifiIcon className="size-3.5" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium">{connection.name}</span>
        <span className="mt-0.5 block truncate text-[0.6875rem] capitalize text-muted-foreground">
          {connection.detail ?? connection.status}
        </span>
      </span>
    </ContextButton>
  ));
}

function ContextSection({
  icon,
  title,
  count,
  children,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly count?: number;
  readonly children: ReactNode;
}) {
  return (
    <section className="border-b py-2 last:border-b-0">
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="text-muted-foreground">{icon}</span>
        <h2 className="text-xs font-semibold">{title}</h2>
        {typeof count === "number" && count > 0 && (
          <Badge className="ml-auto" size="sm" variant="secondary">
            {count}
          </Badge>
        )}
      </div>
      <div>{children}</div>
    </section>
  );
}

interface ContextRailProps {
  readonly context: CommandCenterContext;
  readonly onDecideApproval?: CommandCenterShellProps["onDecideApproval"];
  readonly onOpenNeedsYouItem?: ((itemId: string) => void) | undefined;
  readonly onOpenRun?: ((runId: string) => void) | undefined;
  readonly onOpenTodayItem?: ((itemId: string) => void) | undefined;
  readonly onOpenConnection?: ((connectionId: string) => void) | undefined;
  readonly onReviewMemory?: CommandCenterShellProps["onReviewMemory"];
  readonly resolvingNeedsYouId?: string | undefined;
}

function ContextRail({
  context,
  onDecideApproval,
  onOpenNeedsYouItem,
  onOpenRun,
  onOpenTodayItem,
  onOpenConnection,
  onReviewMemory,
  resolvingNeedsYouId,
}: ContextRailProps) {
  const [activeView, setActiveView] = useState<"needs-you" | "runs" | "context">("needs-you");
  return (
    <div className="flex h-full min-h-0 flex-col bg-card text-card-foreground">
      <div className="flex h-[var(--workspace-topbar-height)] shrink-0 items-end border-b px-2">
        <div
          aria-label="Context views"
          className="flex min-w-0 items-center gap-0.5"
          role="tablist"
        >
          {(
            [
              ["needs-you", "Needs You", context.needsYou.length],
              ["runs", "Runs", context.activeRuns.length],
              ["context", "Context", 0],
            ] as const
          ).map(([id, label, count]) => (
            <button
              aria-selected={activeView === id}
              aria-controls={`command-center-context-${id}`}
              className={cn(
                "relative flex h-9 items-center gap-1.5 px-2 text-xs text-muted-foreground transition-colors hover:text-foreground",
                activeView === id &&
                  "text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-px after:bg-foreground",
              )}
              key={id}
              onClick={() => setActiveView(id)}
              role="tab"
              type="button"
            >
              {label}
              {count > 0 ? (
                <span className="rounded-full bg-muted px-1.5 text-[0.625rem]">{count}</span>
              ) : null}
            </button>
          ))}
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1" scrollFade>
        <div className="p-2">
          <div
            aria-label="Needs You"
            hidden={activeView !== "needs-you"}
            id="command-center-context-needs-you"
            role="tabpanel"
          >
            <NeedsYouRows
              items={context.needsYou}
              onDecideApproval={onDecideApproval}
              onOpen={onOpenNeedsYouItem}
              onReviewMemory={onReviewMemory}
              resolvingId={resolvingNeedsYouId}
            />
          </div>
          <div
            aria-label="Active runs"
            hidden={activeView !== "runs"}
            id="command-center-context-runs"
            role="tabpanel"
          >
            <ActiveRunRows onOpen={onOpenRun} runs={context.activeRuns} />
          </div>
          <div
            aria-label="Today and connections"
            hidden={activeView !== "context"}
            id="command-center-context-context"
            role="tabpanel"
          >
            <>
              <ContextSection icon={<Clock3Icon className="size-3.5" />} title="Today">
                <TodayRows items={context.today} onOpen={onOpenTodayItem} />
              </ContextSection>
              <ContextSection icon={<WifiIcon className="size-3.5" />} title="Connections">
                <ConnectionRows connections={context.connections} onOpen={onOpenConnection} />
              </ContextSection>
            </>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}

export function CommandCenterShell(props: CommandCenterShellProps) {
  const [contextOpen, setContextOpen] = useState(false);
  const hasExplicitRoute = Object.values(props.routeSelection).some((value) => value !== undefined);

  return (
    <div
      className="grid h-full min-h-0 w-full grid-cols-1 overflow-hidden bg-background text-foreground 2xl:grid-cols-[minmax(0,1fr)_19rem]"
      data-slot="command-center-shell"
    >
      <main className="flex min-h-0 min-w-0 flex-col" data-slot="command-center-conversation">
        <header className="flex h-[var(--workspace-topbar-height)] shrink-0 items-center gap-3 border-b bg-background/90 px-3 backdrop-blur-sm sm:px-4">
          <CommandCenterHistoryMenu
            activeConversationId={props.activeConversationId}
            conversations={props.conversations}
            onNewConversation={props.onNewConversation}
            onSelectConversation={props.onSelectConversation}
          />
          <div className="min-w-0 flex-1">
            <h1 className="truncate font-heading text-sm font-semibold">
              {props.conversationTitle}
            </h1>
            <div className="mt-0.5 flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
              <CircleIcon className="size-1.5 fill-success text-success" />
              Command is ready
            </div>
          </div>
          <span className="hidden text-[0.6875rem] text-muted-foreground sm:inline">
            {hasExplicitRoute ? "Explicit route" : "Auto route"}
          </span>
          <Button
            aria-label="Open live context"
            className="2xl:hidden"
            onClick={() => setContextOpen(true)}
            size="icon-sm"
            variant="ghost"
          >
            <PanelRightIcon />
            {props.context.needsYou.length > 0 && (
              <span className="absolute right-0.5 top-0.5 size-2 rounded-full border border-background bg-warning" />
            )}
          </Button>
        </header>

        <div className="shrink-0 px-3 sm:px-5">
          <RouteReceipt receipt={props.routeReceipt} />
        </div>

        <ScrollArea className="min-h-0 flex-1" scrollFade>
          <Messages messages={props.messages} onOpenLinkedThread={props.onOpenLinkedThread} />
        </ScrollArea>

        <Composer
          commandUnavailable={props.commandUnavailable}
          configNotice={props.configNotice}
          draft={props.draft}
          isSubmitting={props.isSubmitting}
          onDraftChange={props.onDraftChange}
          onRouteSelectionChange={props.onRouteSelectionChange}
          onSubmit={props.onSubmit}
          receipt={props.routeReceipt}
          routeOptions={props.routeOptions}
          routeSelection={props.routeSelection}
          spaces={props.spaces}
        />
      </main>

      <aside className="hidden min-h-0 border-l 2xl:block" data-slot="command-center-context">
        <ContextRail
          context={props.context}
          onDecideApproval={props.onDecideApproval}
          onOpenConnection={props.onOpenConnection}
          onOpenNeedsYouItem={props.onOpenNeedsYouItem}
          onOpenRun={props.onOpenRun}
          onOpenTodayItem={props.onOpenTodayItem}
          onReviewMemory={props.onReviewMemory}
          resolvingNeedsYouId={props.resolvingNeedsYouId}
        />
      </aside>

      <Sheet onOpenChange={setContextOpen} open={contextOpen}>
        <SheetPopup className="max-w-sm p-0" showCloseButton={false} side="right">
          <SheetHeader className="sr-only">
            <SheetTitle>Live context</SheetTitle>
            <SheetDescription>
              Review decisions, active work, today, and connections.
            </SheetDescription>
          </SheetHeader>
          <ContextRail
            context={props.context}
            onDecideApproval={props.onDecideApproval}
            onOpenConnection={props.onOpenConnection}
            onOpenNeedsYouItem={props.onOpenNeedsYouItem}
            onOpenRun={props.onOpenRun}
            onOpenTodayItem={props.onOpenTodayItem}
            onReviewMemory={props.onReviewMemory}
            resolvingNeedsYouId={props.resolvingNeedsYouId}
          />
        </SheetPopup>
      </Sheet>
    </div>
  );
}
