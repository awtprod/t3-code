"use client";

import {
  AlertCircleIcon,
  ArrowUpIcon,
  ArrowUpRightIcon,
  CalendarDaysIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  Clock3Icon,
  CommandIcon,
  InboxIcon,
  PanelRightIcon,
  SparklesIcon,
  TriangleAlertIcon,
  WifiIcon,
  WifiOffIcon,
  WorkflowIcon,
  XIcon,
} from "lucide-react";
import { useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger } from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { cn } from "~/lib/utils";

import type {
  CommandCenterActiveRun,
  CommandCenterConnection,
  CommandCenterContext,
  CommandCenterMessage,
  CommandCenterNeedsYouItem,
  CommandCenterRisk,
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

export function shouldSubmitCommandComposerOnKeyDown(input: {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly isComposing: boolean;
}): boolean {
  return input.key === "Enter" && !input.shiftKey && !input.isComposing;
}

const ROUTE_SOURCE_LABEL: Record<CommandCenterRouteSource, string> = {
  auto: "Auto",
  classifier: "Inferred",
  explicit: "Selected",
  fallback: "Fallback",
  "provider-default": "Default",
  policy: "Policy",
  "tier-policy": "Efficiency tier",
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
      className="group w-full min-w-0 overflow-hidden border-b border-border/55"
    >
      <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 py-3 text-sm text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
        <WorkflowIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium">
          {receipt.status === "blocked"
            ? "Routing blocked"
            : receipt.status === "waiting-approval"
              ? "Waiting for approval"
              : receipt.status === "complete"
                ? "Work complete"
                : receipt.status === "failed"
                  ? "Run failed"
                  : receipt.status === "running"
                    ? "Working"
                    : "Route ready"}
        </span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {receipt.executionTargetName !== undefined ? `${receipt.executionTargetName} · ` : ""}
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
              (receipt.status === "blocked" || receipt.status === "failed") && "bg-destructive",
            )}
          />
          {receipt.status === "blocked"
            ? "Blocked"
            : receipt.status === "waiting-approval"
              ? "Approval"
              : receipt.status === "complete"
                ? "Complete"
                : receipt.status === "failed"
                  ? "Failed"
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
        <div className="mt-2 grid min-w-0 grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-6">
          {receipt.executionTargetName !== undefined && (
            <RouteFact label="Runs on" source="classifier" value={receipt.executionTargetName} />
          )}
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

export function Messages({
  messages,
  receipt,
  onOpenLinkedThread,
  onClearTranscript,
  context,
  conversations,
  onOpenNeedsYouItem,
  onOpenRun,
  onOpenTodayItem,
  onUseSuggestion,
  selectedSpaceId,
  selectedSpaceName,
}: {
  readonly messages: readonly CommandCenterMessage[];
  readonly receipt: CommandCenterRouteReceipt;
  readonly onOpenLinkedThread?: ((threadId: string, environmentId?: string) => void) | undefined;
  readonly onClearTranscript?: (() => void) | undefined;
  readonly context?: CommandCenterContext | undefined;
  readonly conversations?: CommandCenterShellProps["conversations"] | undefined;
  readonly onOpenNeedsYouItem?: ((itemId: string) => void) | undefined;
  readonly onOpenRun?: ((runId: string) => void) | undefined;
  readonly onOpenTodayItem?: ((itemId: string) => void) | undefined;
  readonly onUseSuggestion?: ((prompt: string) => void) | undefined;
  readonly selectedSpaceId?: string | undefined;
  readonly selectedSpaceName?: string | undefined;
}) {
  if (messages.length === 0) {
    if (context !== undefined && conversations !== undefined) {
      return (
        <CommandCenterOverview
          context={context}
          conversations={conversations}
          onOpenNeedsYouItem={onOpenNeedsYouItem}
          onOpenRun={onOpenRun}
          onOpenTodayItem={onOpenTodayItem}
          onUseSuggestion={onUseSuggestion}
          selectedSpaceId={selectedSpaceId}
          selectedSpaceName={selectedSpaceName}
        />
      );
    }
    return (
      <div className="mx-auto flex h-full w-full min-w-0 max-w-lg flex-col items-center justify-center overflow-hidden px-6 text-center">
        <span className="mb-4 flex size-12 items-center justify-center rounded-2xl border bg-card shadow-sm">
          <SparklesIcon className="size-5 text-primary" />
        </span>
        <h2 className="max-w-full text-pretty font-heading text-lg font-semibold">
          {selectedSpaceName === undefined
            ? "What do you want to move forward?"
            : `${selectedSpaceName} is ready`}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {selectedSpaceName === undefined
            ? "Start with a question, a task, or an idea. Command Center will show where it plans to route the work before it begins."
            : "Your next command will be routed to this Space. Start with a question, task, or idea."}
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col px-5 pb-10 pt-7 sm:px-8">
      {onClearTranscript !== undefined ? (
        <div className="mb-4 flex justify-end">
          <Button
            aria-label="Clear command transcript"
            onClick={onClearTranscript}
            size="xs"
            type="button"
            variant="ghost"
          >
            <XIcon />
            Clear
          </Button>
        </div>
      ) : null}
      {messages.map((message) => {
        if (message.author === "user") {
          return (
            <article className="mb-8 flex justify-end" key={message.id}>
              <div className="max-w-[min(42rem,82%)] rounded-3xl border border-border/70 bg-muted/65 px-5 py-3 text-[0.9375rem] leading-6 shadow-xs sm:px-6 sm:py-3.5 sm:text-base">
                <p className="whitespace-pre-wrap">{message.body}</p>
              </div>
            </article>
          );
        }

        if (message.author === "system") {
          if (message.authorLabel === "Route receipt") {
            return (
              <div className="mb-8" key={message.id}>
                <RouteReceipt receipt={message.receipt ?? receipt} />
              </div>
            );
          }
          return (
            <details className="group mb-8 border-b border-border/55" key={message.id}>
              <summary className="flex cursor-pointer list-none items-center gap-2 py-3 text-sm text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
                <SparklesIcon className="size-3.5" />
                <span>{message.authorLabel ?? "Command Center"}</span>
                <span className="text-muted-foreground/65">{message.createdAtLabel}</span>
                <ChevronRightIcon className="size-3.5 transition-transform group-open:rotate-90" />
              </summary>
              <p className="pb-4 text-sm leading-6 text-foreground/80">{message.body}</p>
            </details>
          );
        }

        return (
          <article className="group/assistant mb-10 min-w-0" key={message.id}>
            <p className="whitespace-pre-wrap text-[0.9375rem] leading-7 text-foreground/90 sm:text-base">
              {message.body}
            </p>
            <div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground/70 opacity-0 transition-opacity focus-within:opacity-100 group-hover/assistant:opacity-100">
              <span>{message.createdAtLabel}</span>
              {message.linkedThreadId !== undefined && (
                <Button
                  onClick={() => {
                    if (message.linkedThreadId !== undefined) {
                      onOpenLinkedThread?.(message.linkedThreadId, message.linkedEnvironmentId);
                    }
                  }}
                  size="xs"
                  type="button"
                  variant="ghost"
                >
                  Open linked work
                  <ArrowUpRightIcon />
                </Button>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}

interface CommandCenterSuggestion {
  readonly label: string;
  readonly detail: string;
  readonly prompt: string;
}

export function buildCommandCenterSuggestions(input: {
  readonly needsYouCount: number;
  readonly activeRunCount: number;
  readonly todayCount: number;
  readonly failedRunCount: number;
  readonly unhealthyConnectionCount: number;
}): readonly CommandCenterSuggestion[] {
  const suggestions: CommandCenterSuggestion[] = [];
  if (input.needsYouCount > 0) {
    suggestions.push({
      label: `Prioritize ${input.needsYouCount} attention item${input.needsYouCount === 1 ? "" : "s"}`,
      detail: "Review what is blocked and recommend the best order to handle it.",
      prompt:
        "Review everything that needs my attention, prioritize it, and tell me what to handle first.",
    });
  }
  if (input.failedRunCount > 0) {
    suggestions.push({
      label: `Recover ${input.failedRunCount} failed run${input.failedRunCount === 1 ? "" : "s"}`,
      detail: "Diagnose what failed and propose the safest recovery path.",
      prompt:
        "Review my failed Command Center runs, explain the likely causes, and offer recovery options.",
    });
  }
  if (input.activeRunCount > 0) {
    suggestions.push({
      label: "Summarize active work",
      detail: "Get a concise progress report and identify anything stalled.",
      prompt:
        "Give me a concise status update on active work and flag anything that looks stalled.",
    });
  }
  if (input.todayCount > 0) {
    suggestions.push({
      label: "Plan the rest of today",
      detail: "Turn today’s commitments into a realistic order of operations.",
      prompt: "Review what is scheduled or due today and help me make a practical plan.",
    });
  }
  if (input.unhealthyConnectionCount > 0) {
    suggestions.push({
      label: "Check connection health",
      detail: "Identify degraded integrations and what they may be blocking.",
      prompt: "Check my Command Center connections, explain what is unhealthy, and suggest fixes.",
    });
  }

  const evergreen: readonly CommandCenterSuggestion[] = [
    {
      label: "Recommend my next move",
      detail: "Review current context and identify the highest-value next action.",
      prompt:
        "Review my current Command Center context and recommend the most valuable thing to do next.",
    },
    {
      label: "Find something to automate",
      detail: "Look for recurring work that could run without manual effort.",
      prompt: "Review my current work and suggest one useful recurring task I should automate.",
    },
    {
      label: "Run a quick health check",
      detail: "Look for stale work, failures, or configuration that deserves attention.",
      prompt: "Run a quick Command Center health check and surface anything I should know about.",
    },
  ];
  for (const suggestion of evergreen) {
    if (suggestions.length >= 3) break;
    suggestions.push(suggestion);
  }
  return suggestions.slice(0, 3);
}

function OverviewList({
  empty,
  items,
  onOpen,
  title,
}: {
  readonly empty: string;
  readonly items: readonly {
    readonly id: string;
    readonly title: string;
    readonly detail: string;
  }[];
  readonly onOpen?: ((id: string) => void) | undefined;
  readonly title: string;
}) {
  return (
    <section className="min-w-0 rounded-2xl border border-border/70 bg-card/45 p-4">
      <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {title}
      </h3>
      {items.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <div className="mt-2 space-y-1">
          {items.slice(0, 3).map((item) => (
            <button
              className="group flex w-full items-start gap-2 rounded-xl px-2 py-2 text-left hover:bg-accent"
              key={item.id}
              onClick={() => onOpen?.(item.id)}
              type="button"
            >
              <span className="min-w-0 flex-1">
                <span className="line-clamp-1 block text-sm font-medium">{item.title}</span>
                <span className="mt-0.5 line-clamp-1 block text-xs text-muted-foreground">
                  {item.detail}
                </span>
              </span>
              <ChevronRightIcon className="mt-1 size-3.5 shrink-0 text-muted-foreground opacity-50 group-hover:opacity-100" />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function CommandCenterOverview({
  context,
  conversations,
  onOpenNeedsYouItem,
  onOpenRun,
  onOpenTodayItem,
  onUseSuggestion,
  selectedSpaceId,
  selectedSpaceName,
}: {
  readonly context: CommandCenterContext;
  readonly conversations: CommandCenterShellProps["conversations"];
  readonly onOpenNeedsYouItem?: ((itemId: string) => void) | undefined;
  readonly onOpenRun?: ((runId: string) => void) | undefined;
  readonly onOpenTodayItem?: ((itemId: string) => void) | undefined;
  readonly onUseSuggestion?: ((prompt: string) => void) | undefined;
  readonly selectedSpaceId?: string | undefined;
  readonly selectedSpaceName?: string | undefined;
}) {
  const needsYou = context.needsYou.filter(
    (item) => selectedSpaceId === undefined || item.spaceId === selectedSpaceId,
  );
  const activeRuns = context.activeRuns.filter(
    (run) => selectedSpaceName === undefined || run.spaceName === selectedSpaceName,
  );
  const today = context.today.filter(
    (item) => selectedSpaceId === undefined || item.spaceId === selectedSpaceId,
  );
  const failedRunCount = conversations.filter(
    (conversation) =>
      conversation.status === "failed" &&
      (selectedSpaceId === undefined || conversation.spaceId === selectedSpaceId),
  ).length;
  const suggestions = buildCommandCenterSuggestions({
    needsYouCount: needsYou.length,
    activeRunCount: activeRuns.length,
    todayCount: today.length,
    failedRunCount,
    unhealthyConnectionCount: context.connections.filter(
      (connection) => connection.status !== "healthy",
    ).length,
  });

  return (
    <div className="mx-auto w-full max-w-5xl px-5 pb-10 pt-7 sm:px-8">
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium text-muted-foreground">
            {selectedSpaceName ?? "Across all Spaces"}
          </p>
          <h2 className="mt-1 font-heading text-xl font-semibold">A useful place to start</h2>
        </div>
        <span className="hidden text-xs text-muted-foreground sm:block">
          Updated from live context
        </span>
      </div>

      <section className="mt-5 rounded-2xl border border-primary/20 bg-primary/[0.035] p-4">
        <div className="flex items-center gap-2">
          <SparklesIcon className="size-4 text-primary" />
          <h3 className="text-sm font-semibold">Suggested by Command</h3>
        </div>
        <div className="mt-3 grid gap-2 md:grid-cols-3">
          {suggestions.map((suggestion) => (
            <button
              className="rounded-xl border border-border/70 bg-background/70 p-3 text-left transition-colors hover:bg-accent"
              key={suggestion.label}
              onClick={() => onUseSuggestion?.(suggestion.prompt)}
              type="button"
            >
              <span className="block text-sm font-medium">{suggestion.label}</span>
              <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                {suggestion.detail}
              </span>
            </button>
          ))}
        </div>
      </section>

      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <OverviewList
          empty="Nothing needs your attention."
          items={needsYou.map((item) => ({
            id: item.id,
            title: item.title,
            detail: `${item.spaceName} · ${item.detail ?? item.reason}`,
          }))}
          onOpen={onOpenNeedsYouItem}
          title={`Needs you · ${needsYou.length}`}
        />
        <OverviewList
          empty="No work is currently running."
          items={activeRuns.map((run) => ({
            id: run.id,
            title: run.title,
            detail: `${run.spaceName} · ${run.detail ?? run.status}`,
          }))}
          onOpen={onOpenRun}
          title={`In progress · ${activeRuns.length}`}
        />
        <OverviewList
          empty="Nothing else is scheduled today."
          items={today.map((item) => ({
            id: item.id,
            title: item.title,
            detail: item.timeLabel,
          }))}
          onOpen={onOpenTodayItem}
          title={`Today · ${today.length}`}
        />
      </div>
    </div>
  );
}

function Composer({
  draft,
  isSubmitting,
  commandUnavailable,
  configNotice,
  routeOptions,
  routeSelection,
  onDraftChange,
  onModelSelectionChange,
  onOpenProviderSettings,
  onSubmit,
  inputRef,
}: Pick<
  CommandCenterShellProps,
  | "draft"
  | "isSubmitting"
  | "commandUnavailable"
  | "configNotice"
  | "onDraftChange"
  | "onSubmit"
  | "onModelSelectionChange"
  | "onOpenProviderSettings"
  | "routeOptions"
  | "routeSelection"
> & {
  readonly inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const selectedModel = routeOptions.models.find(
    (model) =>
      model.id === routeSelection.modelId &&
      (model.providerId === undefined || model.providerId === routeSelection.providerId),
  );
  const modelValue =
    routeSelection.providerId !== undefined && routeSelection.modelId !== undefined
      ? `${routeSelection.providerId}\u0000${routeSelection.modelId}`
      : null;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const command = draft.trim();
    if (!command || isSubmitting || commandUnavailable) return;
    onSubmit(command);
  };

  return (
    <div className="min-w-0 shrink-0 bg-gradient-to-t from-background via-background via-80% to-transparent px-5 pb-5 pt-6 sm:px-8 sm:pb-6">
      {configNotice ? (
        <div
          className="mx-auto mb-3 flex w-full min-w-0 max-w-5xl items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
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
        className="chat-composer-glass mx-auto w-full min-w-0 max-w-5xl rounded-3xl border border-border/80 p-2 shadow-[0_18px_52px_-28px_rgba(0,0,0,0.34)] transition-[border-color,box-shadow] focus-within:border-ring/65 focus-within:shadow-[0_18px_58px_-26px_rgba(37,99,235,0.2)]"
        onSubmit={submit}
      >
        <Textarea
          aria-label="Ask Command Center"
          className="w-full min-w-0 border-0 bg-transparent px-3 pt-2 text-base shadow-none before:hidden focus-within:ring-0 sm:min-h-20 sm:px-4 sm:pt-2.5 dark:bg-transparent"
          disabled={isSubmitting}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (
              !shouldSubmitCommandComposerOnKeyDown({
                key: event.key,
                shiftKey: event.shiftKey,
                isComposing: event.nativeEvent.isComposing,
              })
            ) {
              return;
            }
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }}
          placeholder="Ask anything, @tag files/folders, $use skills, or / for commands"
          ref={inputRef}
          rows={2}
          unstyled
          value={draft}
        />
        <div className="flex items-end justify-between gap-3 px-2 pb-2 sm:px-3 sm:pb-3">
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-visible">
            {routeOptions.models.length === 0 ? (
              <Button
                aria-label="Set up Codex provider"
                className="h-8 min-h-8 rounded-lg px-2.5 text-xs font-medium"
                onClick={onOpenProviderSettings}
                type="button"
                variant="outline"
              >
                Codex unavailable
              </Button>
            ) : (
              <Select
                disabled={onModelSelectionChange === undefined}
                modal={false}
                onValueChange={(value) => {
                  if (value === null) return;
                  const separator = value.indexOf("\u0000");
                  if (separator <= 0) return;
                  onModelSelectionChange?.(value.slice(0, separator), value.slice(separator + 1));
                }}
                value={modelValue}
              >
                <SelectTrigger
                  aria-label="Model selection"
                  className="h-8 min-h-8 w-auto max-w-64 gap-1.5 rounded-lg px-2.5 text-xs font-medium"
                  size="xs"
                >
                  <span className="truncate">{selectedModel?.label ?? "Choose model"}</span>
                </SelectTrigger>
                <SelectPopup align="start" alignItemWithTrigger={false} className="min-w-64">
                  {routeOptions.models.map((model) => {
                    const providerId = model.providerId ?? routeSelection.providerId;
                    if (providerId === undefined) return null;
                    return (
                      <SelectItem
                        disabled={model.disabled}
                        key={`${providerId}:${model.id}`}
                        value={`${providerId}\u0000${model.id}`}
                      >
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate">{model.label}</span>
                          {model.detail !== undefined ? (
                            <span className="truncate text-[0.6875rem] text-muted-foreground">
                              {model.detail}
                            </span>
                          ) : null}
                        </span>
                      </SelectItem>
                    );
                  })}
                </SelectPopup>
              </Select>
            )}
          </div>
          <Button
            aria-label={isSubmitting ? "Sending command" : "Send command"}
            disabled={!draft.trim() || isSubmitting || commandUnavailable}
            className="rounded-full"
            size="icon-lg"
            type="submit"
          >
            <ArrowUpIcon />
          </Button>
        </div>
      </form>
    </div>
  );
}

function CommandCenterShortcuts({
  context,
  onCapture,
  onCommand,
  onSelectSpace,
  selectedSpaceId,
  spaces,
}: Pick<
  CommandCenterShellProps,
  "context" | "onCapture" | "onSelectSpace" | "selectedSpaceId" | "spaces"
> & { readonly onCommand: () => void }) {
  const [captureOpen, setCaptureOpen] = useState(false);
  const [captureKind, setCaptureKind] = useState<"idea" | "task">("idea");
  const [captureSpaceId, setCaptureSpaceId] = useState(selectedSpaceId ?? spaces[0]?.id ?? "");
  const [captureTitle, setCaptureTitle] = useState("");
  const [capturing, setCapturing] = useState(false);

  const submitCapture = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const title = captureTitle.trim();
    if (!title || !captureSpaceId || onCapture === undefined || capturing) return;
    setCapturing(true);
    const saved = await onCapture({ kind: captureKind, spaceId: captureSpaceId, title });
    setCapturing(false);
    if (!saved) return;
    setCaptureTitle("");
    setCaptureOpen(false);
  };

  return (
    <section
      aria-label="Command Center shortcuts"
      className="shrink-0 border-b border-border/65 bg-background px-4 pb-3 pt-14 sm:px-6"
    >
      <div className="mx-auto w-full max-w-5xl">
        <div className="flex items-center gap-2">
          <Button onClick={onCommand} size="sm" type="button" variant="outline">
            <CommandIcon />
            Command
          </Button>
          <Button
            aria-expanded={captureOpen}
            disabled={spaces.length === 0 || onCapture === undefined}
            onClick={() =>
              setCaptureOpen((open) => {
                if (!open) setCaptureSpaceId(selectedSpaceId ?? spaces[0]?.id ?? "");
                return !open;
              })
            }
            size="sm"
            type="button"
            variant="outline"
          >
            <InboxIcon />
            Capture
          </Button>
        </div>

        <div
          aria-label="Space shortcuts"
          className="mt-3 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <button
            aria-pressed={selectedSpaceId === undefined}
            className={cn(
              "shrink-0 rounded-xl border px-3 py-2 text-left transition-colors hover:bg-accent",
              selectedSpaceId === undefined && "border-foreground/25 bg-accent",
            )}
            onClick={() => onSelectSpace?.("")}
            type="button"
          >
            <span className="block text-xs font-semibold">All Spaces</span>
            <span className="mt-0.5 block text-[0.6875rem] text-muted-foreground">
              {context.needsYou.length} need you · {context.activeRuns.length} active
            </span>
          </button>
          {spaces.map((space) => {
            const activeCount = context.activeRuns.filter(
              (run) => run.spaceName === space.name,
            ).length;
            return (
              <button
                aria-pressed={selectedSpaceId === space.id}
                className={cn(
                  "min-w-36 shrink-0 rounded-xl border px-3 py-2 text-left transition-colors hover:bg-accent",
                  selectedSpaceId === space.id && "border-foreground/25 bg-accent",
                )}
                key={space.id}
                onClick={() => onSelectSpace?.(space.id)}
                type="button"
              >
                <span className="block truncate text-xs font-semibold">{space.name}</span>
                <span className="mt-0.5 block text-[0.6875rem] text-muted-foreground">
                  {space.unreadCount ?? 0} need you · {activeCount} active
                </span>
              </button>
            );
          })}
        </div>

        {captureOpen ? (
          <form
            aria-label="Quick capture"
            className="mt-3 grid gap-2 rounded-xl border bg-card p-3 sm:grid-cols-[8rem_10rem_1fr_auto]"
            onSubmit={(event) => void submitCapture(event)}
          >
            <select
              aria-label="Capture type"
              className="h-9 rounded-lg border bg-background px-2 text-xs"
              onChange={(event) => setCaptureKind(event.target.value as "idea" | "task")}
              value={captureKind}
            >
              <option value="idea">Idea</option>
              <option value="task">Task</option>
            </select>
            <select
              aria-label="Capture Space"
              className="h-9 rounded-lg border bg-background px-2 text-xs"
              onChange={(event) => setCaptureSpaceId(event.target.value)}
              value={captureSpaceId}
            >
              {spaces.map((space) => (
                <option key={space.id} value={space.id}>
                  {space.name}
                </option>
              ))}
            </select>
            <input
              aria-label="Capture title"
              autoFocus
              className="h-9 min-w-0 rounded-lg border bg-background px-3 text-sm outline-none focus:border-ring"
              onChange={(event) => setCaptureTitle(event.target.value)}
              placeholder={captureKind === "idea" ? "Capture an idea" : "Capture a task"}
              value={captureTitle}
            />
            <Button
              disabled={!captureTitle.trim() || !captureSpaceId || capturing}
              size="sm"
              type="submit"
            >
              {capturing ? "Saving…" : "Save"}
            </Button>
          </form>
        ) : null}
      </div>
    </section>
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

export function NeedsYouRows({
  items,
  onOpen,
  onDismissNeedsYouItems,
  onDecideApproval,
  onReviewMemory,
  resolvingId,
}: {
  readonly items: readonly CommandCenterNeedsYouItem[];
  readonly onOpen?: ((itemId: string) => void) | undefined;
  readonly onDismissNeedsYouItems?: CommandCenterShellProps["onDismissNeedsYouItems"];
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
        <article className="rounded-xl hover:bg-accent" key={item.id}>
          <button
            className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left"
            onClick={() => onOpen?.(item.id)}
            type="button"
          >
            {content}
          </button>
          <div className="flex justify-end px-3 pb-2.5">
            <Button
              disabled={resolvingId === item.id || resolvingId === "dismiss-all"}
              onClick={() => onDismissNeedsYouItems?.([item.id])}
              size="xs"
              type="button"
              variant="ghost"
            >
              Dismiss
            </Button>
          </div>
        </article>
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
  readonly onClose?: (() => void) | undefined;
  readonly onDecideApproval?: CommandCenterShellProps["onDecideApproval"];
  readonly onOpenNeedsYouItem?: ((itemId: string) => void) | undefined;
  readonly onDismissNeedsYouItems?: CommandCenterShellProps["onDismissNeedsYouItems"];
  readonly onOpenRun?: ((runId: string) => void) | undefined;
  readonly onOpenTodayItem?: ((itemId: string) => void) | undefined;
  readonly onOpenConnection?: ((connectionId: string) => void) | undefined;
  readonly onReviewMemory?: CommandCenterShellProps["onReviewMemory"];
  readonly resolvingNeedsYouId?: string | undefined;
}

export function ContextRail({
  context,
  onClose,
  onDecideApproval,
  onOpenNeedsYouItem,
  onDismissNeedsYouItems,
  onOpenRun,
  onOpenTodayItem,
  onOpenConnection,
  onReviewMemory,
  resolvingNeedsYouId,
}: ContextRailProps) {
  const [activeView, setActiveView] = useState<"needs-you" | "runs" | "context">("needs-you");
  const dismissibleNeedsYouIds = context.needsYou
    .filter((item) => item.action === undefined)
    .map((item) => item.id);
  return (
    <div className="flex h-full min-h-0 flex-col bg-card text-card-foreground">
      <div className="drag-region flex h-[var(--workspace-topbar-height)] shrink-0 items-end border-b px-2">
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
        {onClose ? (
          <Button
            aria-label="Close live context"
            className="mb-1 ml-auto"
            onClick={onClose}
            size="icon-sm"
            variant="ghost"
          >
            <XIcon />
          </Button>
        ) : null}
      </div>
      <ScrollArea className="min-h-0 flex-1" scrollFade>
        <div className="p-2">
          <div
            aria-label="Needs You"
            hidden={activeView !== "needs-you"}
            id="command-center-context-needs-you"
            role="tabpanel"
          >
            {dismissibleNeedsYouIds.length > 1 ? (
              <div className="mb-1 flex items-center justify-between px-3 py-2">
                <span className="text-[0.6875rem] text-muted-foreground">
                  {dismissibleNeedsYouIds.length} dismissible items
                </span>
                <Button
                  disabled={resolvingNeedsYouId !== undefined}
                  onClick={() => onDismissNeedsYouItems?.(dismissibleNeedsYouIds)}
                  size="xs"
                  type="button"
                  variant="ghost"
                >
                  Dismiss all
                </Button>
              </div>
            ) : null}
            <NeedsYouRows
              items={context.needsYou}
              onDismissNeedsYouItems={onDismissNeedsYouItems}
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
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const hasExplicitRoute = Object.values(props.routeSelection).some((value) => value !== undefined);
  const selectedSpaceName = props.spaces.find((space) => space.id === props.selectedSpaceId)?.name;

  return (
    <div
      className="relative flex h-full min-h-0 w-full overflow-hidden bg-background text-foreground"
      data-slot="command-center-shell"
    >
      <main
        className="flex h-full min-h-0 min-w-0 flex-1 flex-col"
        data-slot="command-center-conversation"
      >
        <header className="drag-region pointer-events-none absolute inset-x-0 top-0 z-30 flex h-14 items-center justify-between px-3 sm:px-5">
          <div className="pointer-events-auto rounded-xl bg-background/70 backdrop-blur-md [&_[data-slot=popover-trigger]>span]:hidden [&_[data-slot=popover-trigger]]:size-8 [&_[data-slot=popover-trigger]]:px-0">
            <CommandCenterHistoryMenu
              activeConversationId={props.activeConversationId}
              conversations={props.conversations}
              onNewConversation={props.onNewConversation}
              onSelectConversation={props.onSelectConversation}
            />
          </div>
          <span className="sr-only">
            {props.conversationTitle}. Command is ready.{" "}
            {hasExplicitRoute ? "Explicit route" : "Auto route"}
          </span>
          <Button
            aria-expanded={contextOpen}
            aria-label={contextOpen ? "Close live context" : "Open live context"}
            className="pointer-events-auto rounded-full bg-background/70 backdrop-blur-md"
            onClick={() => setContextOpen((open) => !open)}
            size="icon-sm"
            variant="ghost"
          >
            <PanelRightIcon />
            {props.context.needsYou.length > 0 && (
              <span className="absolute right-0.5 top-0.5 size-2 rounded-full border border-background bg-warning" />
            )}
          </Button>
        </header>

        <CommandCenterShortcuts
          context={props.context}
          onCapture={props.onCapture}
          onCommand={() => {
            props.onNewConversation?.();
            requestAnimationFrame(() => composerInputRef.current?.focus());
          }}
          onSelectSpace={props.onSelectSpace}
          selectedSpaceId={props.selectedSpaceId}
          spaces={props.spaces}
        />

        <ScrollArea className="min-h-0 flex-1" scrollFade>
          <Messages
            context={props.context}
            conversations={props.conversations}
            messages={props.messages}
            onClearTranscript={props.onClearTranscript}
            onOpenLinkedThread={props.onOpenLinkedThread}
            onOpenNeedsYouItem={props.onOpenNeedsYouItem}
            onOpenRun={props.onOpenRun}
            onOpenTodayItem={props.onOpenTodayItem}
            onUseSuggestion={(prompt) => {
              props.onDraftChange(prompt);
              requestAnimationFrame(() => composerInputRef.current?.focus());
            }}
            receipt={props.routeReceipt}
            selectedSpaceId={props.selectedSpaceId}
            selectedSpaceName={selectedSpaceName}
          />
        </ScrollArea>

        <Composer
          commandUnavailable={props.commandUnavailable}
          configNotice={props.configNotice}
          draft={props.draft}
          isSubmitting={props.isSubmitting}
          onDraftChange={props.onDraftChange}
          onModelSelectionChange={props.onModelSelectionChange}
          onOpenProviderSettings={props.onOpenProviderSettings}
          onSubmit={props.onSubmit}
          inputRef={composerInputRef}
          routeOptions={props.routeOptions}
          routeSelection={props.routeSelection}
        />
      </main>

      {contextOpen ? (
        <aside
          aria-label="Live context"
          className="absolute inset-y-0 right-0 z-40 h-full w-[min(24rem,100%)] shrink-0 border-l bg-card shadow-xl md:static md:z-auto md:w-96 md:shadow-none"
          data-slot="command-center-context"
        >
          <ContextRail
            context={props.context}
            onDismissNeedsYouItems={props.onDismissNeedsYouItems}
            onClose={() => setContextOpen(false)}
            onDecideApproval={props.onDecideApproval}
            onOpenConnection={props.onOpenConnection}
            onOpenNeedsYouItem={props.onOpenNeedsYouItem}
            onOpenRun={props.onOpenRun}
            onOpenTodayItem={props.onOpenTodayItem}
            onReviewMemory={props.onReviewMemory}
            resolvingNeedsYouId={props.resolvingNeedsYouId}
          />
        </aside>
      ) : null}
    </div>
  );
}
