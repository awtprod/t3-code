import { ItemId, SpaceId, type Run, type Space } from "@command-center/core";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import type {
  CommandCenterInboxCursor,
  CommandCenterInboxDetail,
  CommandCenterInboxDiscussionEntry,
  CommandCenterInboxEvidenceIdentity,
  CommandCenterInboxProposalPayload,
  CommandCenterInboxRevision,
  CommandCenterInboxSummary,
  EnvironmentId,
} from "@t3tools/contracts";
import { COMMAND_CENTER_INBOX_MAX_PROPOSAL_BYTES } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AlertCircleIcon,
  ArchiveRestoreIcon,
  ArrowLeftIcon,
  CheckIcon,
  ChevronRightIcon,
  Clock3Icon,
  ExternalLinkIcon,
  InboxIcon,
  LoaderCircleIcon,
  MessageSquareIcon,
  PencilLineIcon,
  RefreshCwIcon,
  SendIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Option from "effect/Option";

import { WorkspacePageHeader } from "../../components/WorkspacePageHeader";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { cn, randomUUID } from "../../lib/utils";
import { commandCenterEnvironment } from "../../state/commandCenter";
import { useEnvironmentQuery } from "../../state/query";
import { usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  INBOX_COMMENT_MAX_CHARS,
  INBOX_HISTORY_PAGE_SIZE,
  INBOX_PAGE_SIZE,
  type InboxDraft,
  type InboxDraftScope,
  type InboxPendingReply,
  type InboxReplyIntent,
  type InboxTab,
  classifyInboxMutationResult,
  inboxDraftAfterAcknowledgedReply,
  inboxPendingReplyAfterAttempt,
  inboxPendingReplyForSubmit,
  jsonEditorValue,
  linkedItemIds,
  mergeHistoryById,
  parseJsonEditorValue,
  readInboxDraft,
  readInboxPendingReply,
  rebaseInboxPendingReply,
  resolveInboxDraftScopeId,
  writeInboxDraft,
  writeInboxPendingReply,
} from "./InboxScreen.logic";

export interface InboxEnvironmentOption {
  readonly id: EnvironmentId;
  readonly label: string;
}

interface InboxScreenProps {
  readonly environmentId: EnvironmentId;
  readonly environmentOptions: ReadonlyArray<InboxEnvironmentOption>;
  readonly draftScopeId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly runs: ReadonlyArray<Run>;
  readonly selectedSpaceId?: string | undefined;
  readonly spaces: ReadonlyArray<Space>;
  readonly tab: InboxTab;
  readonly onEnvironmentChange: (environmentId: EnvironmentId) => void;
  readonly onItemChange: (itemId?: string) => void;
  readonly onSelectItem: (spaceId: string, itemId: string) => void;
  readonly onSpaceChange: (spaceId?: string) => void;
  readonly onTabChange: (tab: InboxTab) => void;
}

const TAB_OPTIONS: ReadonlyArray<{ readonly label: string; readonly value: InboxTab }> = [
  { value: "actionable", label: "Actionable" },
  { value: "recent", label: "Recent" },
  { value: "snoozed", label: "Snoozed" },
];

function dateLabel(value: string | undefined): string {
  if (value === undefined) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Unknown";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function relativeFreshness(value: string | undefined): string {
  if (value === undefined) return "Observation time unavailable";
  const timestamp = new Date(value).valueOf();
  if (!Number.isFinite(timestamp)) return "Observation time unavailable";
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return "Observed just now";
  if (minutes < 60) return `Observed ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Observed ${hours}h ago`;
  return `Observed ${Math.floor(hours / 24)}d ago`;
}

function mutationError(failure: unknown): string {
  if (
    typeof failure !== "object" ||
    failure === null ||
    Reflect.get(failure, "_tag") !== "Failure" ||
    Reflect.get(failure, "cause") === undefined
  ) {
    return "The Inbox change returned an invalid response. Retry with the same request.";
  }
  const error = squashAtomCommandFailure(failure as never);
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (typeof error === "string" && error.trim().length > 0) return error;
  return "The Inbox change could not be saved.";
}

function isConflictMessage(message: string): boolean {
  return /conflict|version|stale|changed elsewhere/iu.test(message);
}

function inboxDraftStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function mergeSummaries(
  first: ReadonlyArray<CommandCenterInboxSummary>,
  second: ReadonlyArray<CommandCenterInboxSummary>,
): ReadonlyArray<CommandCenterInboxSummary> {
  const byId = new Map(first.map((summary) => [summary.item.id, summary]));
  for (const summary of second) byId.set(summary.item.id, summary);
  return [...byId.values()].sort(
    (left, right) =>
      new Date(right.state.updatedAt).valueOf() - new Date(left.state.updatedAt).valueOf(),
  );
}

interface InboxSpaceListProps {
  readonly environmentId: EnvironmentId;
  readonly refreshToken: number;
  readonly selectedItemId?: string | undefined;
  readonly space: Space;
  readonly tab: InboxTab;
  readonly onSelect: (summary: CommandCenterInboxSummary) => void;
}

function InboxSpaceList({
  environmentId,
  refreshToken,
  selectedItemId,
  space,
  tab,
  onSelect,
}: InboxSpaceListProps) {
  const [cursor, setCursor] = useState<CommandCenterInboxCursor>();
  const [previousItems, setPreviousItems] = useState<ReadonlyArray<CommandCenterInboxSummary>>([]);
  const query = useEnvironmentQuery(
    commandCenterEnvironment.inbox({
      environmentId,
      input: {
        spaceId: SpaceId.make(space.id),
        view: tab,
        limit: INBOX_PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      },
    }),
  );
  const scopeKey = `${environmentId}:${space.id}:${tab}`;
  const previousScopeRef = useRef(scopeKey);
  useEffect(() => {
    if (previousScopeRef.current === scopeKey) return;
    previousScopeRef.current = scopeKey;
    setCursor(undefined);
    setPreviousItems([]);
  }, [scopeKey]);
  const lastRefreshTokenRef = useRef(refreshToken);
  useEffect(() => {
    if (lastRefreshTokenRef.current === refreshToken) return;
    lastRefreshTokenRef.current = refreshToken;
    setCursor(undefined);
    setPreviousItems([]);
    query.refresh();
  }, [query.refresh, refreshToken]);
  const items = useMemo(
    () => mergeSummaries(previousItems, query.data?.items ?? []),
    [previousItems, query.data?.items],
  );

  return (
    <section aria-labelledby={`inbox-space-${space.id}`} className="flex flex-col gap-2">
      <div className="flex items-center justify-between px-1">
        <h2
          className="text-xs font-semibold tracking-[0.12em] text-muted-foreground uppercase"
          id={`inbox-space-${space.id}`}
        >
          {space.displayName}
        </h2>
        {items.length > 0 ? (
          <span className="text-xs tabular-nums text-muted-foreground">
            {items.length}
            {query.data?.nextCursor === undefined ? "" : "+"}
          </span>
        ) : null}
      </div>
      {query.error !== null ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive-foreground">
          <p>{query.error}</p>
          <Button className="mt-2" onClick={query.refresh} size="sm" variant="outline">
            <RefreshCwIcon /> Retry
          </Button>
        </div>
      ) : null}
      {query.isPending && items.length === 0 ? (
        <div className="flex items-center gap-2 rounded-xl border border-border/60 p-4 text-sm text-muted-foreground">
          <LoaderCircleIcon className="size-4 animate-spin motion-reduce:animate-none" /> Loading
          items…
        </div>
      ) : null}
      {!query.isPending && query.error === null && items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/70 px-4 py-6 text-sm text-muted-foreground">
          {`Nothing ${
            tab === "actionable"
              ? "needs attention"
              : tab === "snoozed"
                ? "is snoozed"
                : "is recent"
          } in this Space.`}
        </div>
      ) : null}
      {items.map((summary) => (
        <button
          aria-current={selectedItemId === summary.item.id ? "true" : undefined}
          className={cn(
            "group w-full rounded-xl border bg-card/35 p-4 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
            selectedItemId === summary.item.id
              ? "border-primary/55 bg-primary/6"
              : "border-border/65 hover:border-border hover:bg-accent/35",
          )}
          key={summary.item.id}
          onClick={() => onSelect(summary)}
          type="button"
        >
          <span className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className={cn(
                "mt-1.5 size-2 shrink-0 rounded-full",
                summary.item.priority === "urgent" || summary.item.priority === "high"
                  ? "bg-amber-400"
                  : "bg-emerald-300",
              )}
            />
            <span className="min-w-0 flex-1">
              <span className="flex items-center justify-between gap-3">
                <span className="text-xs font-semibold tracking-wide text-primary uppercase">
                  {summary.item.kind}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {dateLabel(summary.state.updatedAt)}
                </span>
              </span>
              <span className="mt-1 block font-semibold text-foreground">{summary.item.title}</span>
              {summary.item.description ? (
                <span className="mt-1 line-clamp-2 block text-sm leading-5 text-muted-foreground">
                  {summary.item.description}
                </span>
              ) : null}
              <span className="mt-3 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>
                  {summary.state.unresolvedChangeRequestCount > 0
                    ? `${summary.state.unresolvedChangeRequestCount} change request${summary.state.unresolvedChangeRequestCount === 1 ? "" : "s"} open`
                    : summary.state.candidateCount > 0
                      ? `${summary.state.candidateCount} revision candidate${summary.state.candidateCount === 1 ? "" : "s"}`
                      : tab === "actionable"
                        ? "Ready for review"
                        : tab === "snoozed"
                          ? `Wakes ${dateLabel(summary.state.snoozedUntil)}`
                          : summary.item.status === "done" || summary.item.status === "canceled"
                            ? "Completed"
                            : "Recently closed"}
                </span>
                <ChevronRightIcon className="size-4 transition-transform group-hover:translate-x-0.5" />
              </span>
            </span>
          </span>
        </button>
      ))}
      {query.data?.nextCursor !== undefined ? (
        <Button
          disabled={query.isPending}
          onClick={() => {
            setPreviousItems(items);
            setCursor(query.data?.nextCursor);
          }}
          size="sm"
          variant="outline"
        >
          {query.isPending ? (
            <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" />
          ) : null}
          Load more from {space.displayName}
        </Button>
      ) : null}
    </section>
  );
}

interface ProposalEditorProps {
  readonly current: CommandCenterInboxRevision;
  readonly disabled: boolean;
  readonly onCreate: (input: {
    readonly payload: CommandCenterInboxProposalPayload;
    readonly preview: CommandCenterInboxRevision["preview"];
  }) => Promise<boolean>;
}

function ProposalPayloadDetails({
  payload,
  label = "Authoritative structured effect",
}: {
  readonly payload: CommandCenterInboxProposalPayload;
  readonly label?: string;
}) {
  return (
    <div className="mt-3 rounded-xl border border-border/60 bg-background/55 p-3 text-sm">
      <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{label}</p>
      <dl className="mt-2 grid gap-2 sm:grid-cols-2">
        <div>
          <dt className="text-xs text-muted-foreground">Payload kind</dt>
          <dd className="font-mono text-xs">{payload.kind}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Target</dt>
          <dd className="font-mono text-xs break-all">
            {payload.target.kind} · {payload.target.id}
          </dd>
        </div>
        {payload.kind === "prepared-action" ? (
          <div className="sm:col-span-2">
            <dt className="text-xs text-muted-foreground">Prepared action kind</dt>
            <dd className="font-mono text-xs break-all">{payload.actionKind}</dd>
          </div>
        ) : null}
      </dl>
      <div className="mt-3 space-y-3">
        {payload.kind === "task-patch"
          ? payload.operations.map((operation, index) => (
              <div
                className="rounded-lg border border-border/60 p-3"
                key={`${operation.field}:${index}`}
              >
                <p className="font-mono text-xs font-semibold break-all">{operation.field}</p>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <div>
                    <p className="text-xs text-muted-foreground">Before</p>
                    <pre className="mt-1 overflow-auto whitespace-pre-wrap font-mono text-xs">
                      {jsonEditorValue(operation.before)}
                    </pre>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">After</p>
                    <pre className="mt-1 overflow-auto whitespace-pre-wrap font-mono text-xs">
                      {jsonEditorValue(operation.after)}
                    </pre>
                  </div>
                </div>
              </div>
            ))
          : Object.entries(payload.parameters).map(([name, value]) => (
              <div className="rounded-lg border border-border/60 p-3" key={name}>
                <p className="font-mono text-xs font-semibold break-all">{name}</p>
                <pre className="mt-2 overflow-auto whitespace-pre-wrap font-mono text-xs">
                  {jsonEditorValue(value)}
                </pre>
              </div>
            ))}
        {payload.kind === "prepared-action" && Object.keys(payload.parameters).length === 0 ? (
          <p className="text-xs text-muted-foreground">No parameters.</p>
        ) : null}
      </div>
    </div>
  );
}

function ProposalHumanContext({
  preview,
}: {
  readonly preview: CommandCenterInboxRevision["preview"];
}) {
  if (preview.before === undefined && preview.after === undefined) return null;
  return (
    <div className="mt-3 rounded-xl border border-border/60 bg-muted/15 p-3 text-sm">
      <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Human context (not the structured effect)
      </p>
      {preview.before !== undefined ? (
        <p className="mt-2 whitespace-pre-wrap">Before note: {preview.before}</p>
      ) : null}
      {preview.after !== undefined ? (
        <p className="mt-2 whitespace-pre-wrap">After note: {preview.after}</p>
      ) : null}
    </div>
  );
}

function ProposalEditor({ current, disabled, onCreate }: ProposalEditorProps) {
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState(current.preview.summary);
  const initialValues = useMemo(
    () =>
      current.payload.kind === "task-patch"
        ? current.payload.operations.map((operation) => jsonEditorValue(operation.after))
        : Object.values(current.payload.parameters).map(jsonEditorValue),
    [current],
  );
  const [values, setValues] = useState<ReadonlyArray<string>>(initialValues);
  const [validationError, setValidationError] = useState<string | null>(null);
  useEffect(() => {
    setSummary(current.preview.summary);
    setValues(initialValues);
    setValidationError(null);
  }, [current, initialValues]);

  const save = async () => {
    if (summary.trim().length === 0) {
      setValidationError("Add a short summary of the revision.");
      return;
    }
    const parsed = values.map(parseJsonEditorValue);
    const invalid = parsed.find((entry) => !entry.ok);
    if (invalid !== undefined && !invalid.ok) {
      setValidationError(invalid.message);
      return;
    }
    const parsedValues = parsed.map((entry) => (entry.ok ? entry.value : null));
    const payload: CommandCenterInboxProposalPayload =
      current.payload.kind === "task-patch"
        ? {
            ...current.payload,
            operations: current.payload.operations.map((operation, index) => ({
              ...operation,
              after: parsedValues[index] as never,
            })),
          }
        : {
            ...current.payload,
            parameters: Object.fromEntries(
              Object.keys(current.payload.parameters).map((key, index) => [
                key,
                parsedValues[index] as never,
              ]),
            ),
          };
    if (
      new TextEncoder().encode(JSON.stringify(payload)).byteLength >
      COMMAND_CENTER_INBOX_MAX_PROPOSAL_BYTES
    ) {
      setValidationError("This revision is too large. Shorten the changed values before saving.");
      return;
    }
    setValidationError(null);
    const saved = await onCreate({
      payload,
      preview: { summary: summary.trim() },
    });
    if (saved) setOpen(false);
  };

  if (!open) {
    return (
      <Button disabled={disabled} onClick={() => setOpen(true)} size="sm" variant="outline">
        <PencilLineIcon /> Edit proposal
      </Button>
    );
  }

  const entries: ReadonlyArray<{
    readonly label: string;
    readonly value: string;
    readonly before?: string;
  }> =
    current.payload.kind === "task-patch"
      ? current.payload.operations.map((operation, index) => ({
          label: operation.field,
          before: jsonEditorValue(operation.before),
          value: values[index] ?? "null",
        }))
      : Object.keys(current.payload.parameters).map((key, index) => ({
          label: key,
          value: values[index] ?? "null",
        }));

  return (
    <div className="mt-3 space-y-4 rounded-xl border border-primary/25 bg-primary/5 p-4">
      <div>
        <label className="mb-1.5 block text-sm font-medium" htmlFor="inbox-revision-summary">
          Human context summary
        </label>
        <Input
          id="inbox-revision-summary"
          maxLength={INBOX_COMMENT_MAX_CHARS}
          onChange={(event) => setSummary(event.target.value)}
          value={summary}
        />
      </div>
      {entries.map((entry, index) => (
        <div className="grid gap-2 sm:grid-cols-2" key={entry.label}>
          <div>
            <p className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              {entry.label} · before
            </p>
            <pre className="min-h-16 overflow-auto rounded-lg border border-border/60 bg-background/70 p-3 text-xs whitespace-pre-wrap">
              {entry.before ?? "Prepared action parameter"}
            </pre>
          </div>
          <div>
            <label
              className="mb-1.5 block text-xs font-semibold tracking-wide text-muted-foreground uppercase"
              htmlFor={`inbox-revision-value-${index}`}
            >
              {entry.label} · after
            </label>
            <Textarea
              aria-invalid={validationError !== null}
              id={`inbox-revision-value-${index}`}
              onChange={(event) =>
                setValues((currentValues) =>
                  currentValues.map((value, valueIndex) =>
                    valueIndex === index ? event.target.value : value,
                  ),
                )
              }
              size="sm"
              value={entry.value}
            />
          </div>
        </div>
      ))}
      {validationError ? (
        <p className="text-sm text-destructive-foreground">{validationError}</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button disabled={disabled} onClick={() => void save()} size="sm">
          Create candidate
        </Button>
        <Button disabled={disabled} onClick={() => setOpen(false)} size="sm" variant="ghost">
          Cancel
        </Button>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        This creates a reviewable candidate. Accepting it updates the proposal only; it does not run
        the action.
      </p>
    </div>
  );
}

function StarterProposalEditor({
  disabled,
  onCreate,
  target,
}: {
  readonly disabled: boolean;
  readonly onCreate: ProposalEditorProps["onCreate"];
  readonly target: CommandCenterInboxProposalPayload["target"];
}) {
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState("");
  const [field, setField] = useState("");
  const [before, setBefore] = useState("null");
  const [after, setAfter] = useState("null");
  const [validationError, setValidationError] = useState<string | null>(null);

  const save = async () => {
    const parsedBefore = parseJsonEditorValue(before);
    const parsedAfter = parseJsonEditorValue(after);
    if (summary.trim().length === 0 || field.trim().length === 0) {
      setValidationError("Add a summary and the exact field to change.");
      return;
    }
    if (!parsedBefore.ok || !parsedAfter.ok) {
      setValidationError("Before and after must each be valid JSON values.");
      return;
    }
    const payload: CommandCenterInboxProposalPayload = {
      kind: "task-patch",
      target,
      operations: [
        {
          field: field.trim(),
          before: parsedBefore.value as never,
          after: parsedAfter.value as never,
        },
      ],
    };
    if (
      new TextEncoder().encode(JSON.stringify(payload)).byteLength >
      COMMAND_CENTER_INBOX_MAX_PROPOSAL_BYTES
    ) {
      setValidationError("This revision is too large. Shorten the changed values before saving.");
      return;
    }
    setValidationError(null);
    if (await onCreate({ payload, preview: { summary: summary.trim() } })) setOpen(false);
  };

  if (!open) {
    return (
      <Button disabled={disabled} onClick={() => setOpen(true)} size="sm" variant="outline">
        <PencilLineIcon /> Create first candidate
      </Button>
    );
  }

  return (
    <div className="mt-3 space-y-4 rounded-xl border border-primary/25 bg-primary/5 p-4">
      <p className="text-sm text-muted-foreground">
        Target:{" "}
        <span className="font-mono">
          {target.kind} · {target.id}
        </span>
      </p>
      <div>
        <label className="mb-1.5 block text-sm font-medium" htmlFor="inbox-starter-summary">
          Human context summary
        </label>
        <Input
          id="inbox-starter-summary"
          maxLength={INBOX_COMMENT_MAX_CHARS}
          onChange={(event) => setSummary(event.target.value)}
          value={summary}
        />
      </div>
      <div>
        <label className="mb-1.5 block text-sm font-medium" htmlFor="inbox-starter-field">
          Field
        </label>
        <Input
          id="inbox-starter-field"
          maxLength={500}
          onChange={(event) => setField(event.target.value)}
          placeholder="For example: status or note"
          value={field}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1.5 block text-sm font-medium" htmlFor="inbox-starter-before">
            Before (JSON)
          </label>
          <Textarea
            id="inbox-starter-before"
            onChange={(event) => setBefore(event.target.value)}
            size="sm"
            value={before}
          />
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium" htmlFor="inbox-starter-after">
            After (JSON)
          </label>
          <Textarea
            id="inbox-starter-after"
            onChange={(event) => setAfter(event.target.value)}
            size="sm"
            value={after}
          />
        </div>
      </div>
      {validationError ? (
        <p className="text-sm text-destructive-foreground">{validationError}</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button disabled={disabled} onClick={() => void save()} size="sm">
          Create candidate
        </Button>
        <Button disabled={disabled} onClick={() => setOpen(false)} size="sm" variant="ghost">
          Cancel
        </Button>
      </div>
    </div>
  );
}

interface InboxDetailPaneProps {
  readonly environmentId: EnvironmentId;
  readonly draftScopeId?: string | undefined;
  readonly itemId: string;
  readonly runs: ReadonlyArray<Run>;
  readonly space: Space;
  readonly onBack: () => void;
  readonly onChanged: () => void;
}

function InboxDetailPane({
  environmentId,
  draftScopeId,
  itemId,
  runs,
  space,
  onBack,
  onChanged,
}: InboxDetailPaneProps) {
  const detailQuery = useEnvironmentQuery(
    commandCenterEnvironment.inboxDetail({
      environmentId,
      input: {
        spaceId: SpaceId.make(space.id),
        itemId: ItemId.make(itemId),
        historyLimit: INBOX_HISTORY_PAGE_SIZE,
      },
    }),
  );
  const [optimisticDetail, setOptimisticDetail] = useState<CommandCenterInboxDetail | null>(null);
  const detail =
    optimisticDetail !== null &&
    (detailQuery.data === null || optimisticDetail.state.version >= detailQuery.data.state.version)
      ? optimisticDetail
      : detailQuery.data;
  useEffect(() => {
    setOptimisticDetail(null);
  }, [environmentId, itemId, space.id]);
  useEffect(() => {
    if (
      optimisticDetail !== null &&
      detailQuery.data !== null &&
      detailQuery.data.state.version >= optimisticDetail.state.version
    ) {
      setOptimisticDetail(null);
    }
  }, [detailQuery.data, optimisticDetail]);

  const draftScope: InboxDraftScope | null =
    draftScopeId === undefined ? null : { environmentId, draftScopeId, spaceId: space.id, itemId };
  const [draft, setDraft] = useState<InboxDraft>(() =>
    draftScope === null
      ? { text: "", intent: "comment" }
      : readInboxDraft(inboxDraftStorage(), draftScope),
  );
  const [pendingReply, setPendingReply] = useState<InboxPendingReply | null>(() =>
    draftScope === null ? null : readInboxPendingReply(inboxDraftStorage(), draftScope),
  );
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const draftWriteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (draftWriteTimerRef.current !== null) clearTimeout(draftWriteTimerRef.current);
      if (draftScope !== null) writeInboxDraft(inboxDraftStorage(), draftScope, draftRef.current);
    },
    [draftScopeId, environmentId, itemId, space.id],
  );
  const updateDraft = useCallback(
    (next: InboxDraft) => {
      setDraft(next);
      draftRef.current = next;
      if (draftWriteTimerRef.current !== null) clearTimeout(draftWriteTimerRef.current);
      draftWriteTimerRef.current = setTimeout(() => {
        draftWriteTimerRef.current = null;
        if (draftScope !== null) writeInboxDraft(inboxDraftStorage(), draftScope, next);
      }, 200);
    },
    [draftScopeId, environmentId, itemId, space.id],
  );
  const updatePendingReply = useCallback(
    (next: InboxPendingReply | null) => {
      setPendingReply(next);
      if (draftScope !== null) writeInboxPendingReply(inboxDraftStorage(), draftScope, next);
    },
    [draftScopeId, environmentId, itemId, space.id],
  );

  const [submitting, setSubmitting] = useState<string | null>(null);
  const mutationInFlightRef = useRef(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [rejectedReply, setRejectedReply] = useState<InboxPendingReply | null>(null);
  const comment = useAtomCommand(commandCenterEnvironment.commentOnInboxItem, {
    reportFailure: false,
  });
  const requestChanges = useAtomCommand(commandCenterEnvironment.requestInboxChanges, {
    reportFailure: false,
  });
  const createCandidate = useAtomCommand(commandCenterEnvironment.createInboxCandidate, {
    reportFailure: false,
  });
  const acceptCandidate = useAtomCommand(commandCenterEnvironment.acceptInboxCandidate, {
    reportFailure: false,
  });
  const discardCandidate = useAtomCommand(commandCenterEnvironment.discardInboxCandidate, {
    reportFailure: false,
  });
  const resolveChangeRequest = useAtomCommand(commandCenterEnvironment.resolveInboxChangeRequest, {
    reportFailure: false,
  });
  const snooze = useAtomCommand(commandCenterEnvironment.snoozeInboxItem, { reportFailure: false });
  const unsnooze = useAtomCommand(commandCenterEnvironment.unsnoozeInboxItem, {
    reportFailure: false,
  });
  const dismiss = useAtomCommand(commandCenterEnvironment.dismissInboxItem, {
    reportFailure: false,
  });
  const reopen = useAtomCommand(commandCenterEnvironment.reopenInboxItem, { reportFailure: false });

  const applyResult = useCallback(
    (nextDetail: CommandCenterInboxDetail) => {
      setOptimisticDetail(nextDetail);
      setSaveError(null);
      onChanged();
      detailQuery.refresh();
    },
    [detailQuery.refresh, onChanged],
  );

  const runMutation = useCallback(
    async (
      label: string,
      operation: () => Promise<unknown>,
      onFailure?: (
        message: string,
        outcome: ReturnType<typeof classifyInboxMutationResult>,
      ) => void,
    ): Promise<boolean> => {
      if (mutationInFlightRef.current) return false;
      mutationInFlightRef.current = true;
      setSubmitting(label);
      setSaveError(null);
      try {
        const result = await operation();
        if (
          typeof result !== "object" ||
          result === null ||
          Reflect.get(result, "_tag") !== "Success" ||
          typeof Reflect.get(result, "value") !== "object" ||
          Reflect.get(result, "value") === null ||
          typeof Reflect.get(Reflect.get(result, "value"), "detail") !== "object" ||
          Reflect.get(Reflect.get(result, "value"), "detail") === null
        ) {
          const message = mutationError(result);
          setSaveError(message);
          onFailure?.(
            message,
            typeof result === "object" &&
              result !== null &&
              Reflect.get(result, "_tag") === "Success"
              ? "ambiguous"
              : classifyInboxMutationResult(result),
          );
          return false;
        }
        applyResult(
          Reflect.get(Reflect.get(result, "value"), "detail") as CommandCenterInboxDetail,
        );
        return true;
      } catch (failure) {
        const message = mutationError(failure);
        setSaveError(message);
        onFailure?.(message, "ambiguous");
        return false;
      } finally {
        mutationInFlightRef.current = false;
        setSubmitting(null);
      }
    },
    [applyResult],
  );

  const [olderRequest, setOlderRequest] = useState<
    | {
        readonly discussionBeforeSequence?: number;
        readonly revisionBeforeSequence?: number;
      }
    | undefined
  >(undefined);
  const [nextOlder, setNextOlder] = useState<
    | {
        readonly discussionBeforeSequence?: number;
        readonly revisionBeforeSequence?: number;
      }
    | undefined
  >(undefined);
  const [olderDiscussion, setOlderDiscussion] = useState<
    ReadonlyArray<CommandCenterInboxDiscussionEntry>
  >([]);
  const [olderRevisions, setOlderRevisions] = useState<ReadonlyArray<CommandCenterInboxRevision>>(
    [],
  );
  const olderQuery = useEnvironmentQuery(
    olderRequest === undefined
      ? null
      : commandCenterEnvironment.inboxDetail({
          environmentId,
          input: {
            spaceId: SpaceId.make(space.id),
            itemId: ItemId.make(itemId),
            historyLimit: INBOX_HISTORY_PAGE_SIZE,
            ...olderRequest,
          },
        }),
  );
  const processedHistoryRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    setOlderRequest(undefined);
    setNextOlder(undefined);
    setOlderDiscussion([]);
    setOlderRevisions([]);
    processedHistoryRef.current = undefined;
  }, [environmentId, itemId, space.id]);
  useEffect(() => {
    if (olderRequest === undefined || olderQuery.data === null) return;
    const requestKey = JSON.stringify(olderRequest);
    if (processedHistoryRef.current === requestKey) return;
    processedHistoryRef.current = requestKey;
    setOlderDiscussion((current) => mergeHistoryById(current, olderQuery.data!.discussion));
    setOlderRevisions((current) => mergeHistoryById(current, olderQuery.data!.revisions));
    const next = {
      ...(olderQuery.data.nextDiscussionBeforeSequence === undefined
        ? {}
        : { discussionBeforeSequence: olderQuery.data.nextDiscussionBeforeSequence }),
      ...(olderQuery.data.nextRevisionBeforeSequence === undefined
        ? {}
        : { revisionBeforeSequence: olderQuery.data.nextRevisionBeforeSequence }),
    };
    setNextOlder(Object.keys(next).length === 0 ? undefined : next);
  }, [olderQuery.data, olderRequest]);
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (detail === null || typeof window === "undefined") return;
    if (!window.matchMedia("(max-width: 1023px)").matches) return;
    const frame = window.requestAnimationFrame(() => detailHeadingRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [detail?.item.id]);

  if (detail === null) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-b border-border/60 p-3 lg:hidden">
          <Button onClick={onBack} size="sm" variant="ghost">
            <ArrowLeftIcon /> Back to Inbox
          </Button>
        </div>
        <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
          {detailQuery.error ? (
            <div className="max-w-sm text-center">
              <p>{detailQuery.error}</p>
              <Button className="mt-3" onClick={detailQuery.refresh} size="sm" variant="outline">
                <RefreshCwIcon /> Retry
              </Button>
            </div>
          ) : (
            <>
              <LoaderCircleIcon className="mr-2 size-4 animate-spin motion-reduce:animate-none" />{" "}
              Loading item…
            </>
          )}
        </div>
      </div>
    );
  }

  const currentRevision = detail.currentRevision;
  const starterEvidence = {
    source: detail.item.provenance.kind,
    subjectId: detail.item.provenance.sourceRef ?? detail.state.subject.id,
    version: detail.item.provenance.capturedAt,
    observedAt: detail.item.provenance.capturedAt,
  } satisfies CommandCenterInboxEvidenceIdentity;
  const candidates = mergeHistoryById(detail.revisions, olderRevisions).filter(
    (revision) => revision.status === "candidate",
  );
  const discussion = mergeHistoryById(detail.discussion, olderDiscussion);
  const allRevisions = mergeHistoryById(detail.revisions, olderRevisions);
  const linkedIds = linkedItemIds(detail.item.metadata);
  const linkedRun = runs.find(
    (run) => run.id === linkedIds.runId || run.id === detail.item.provenance.sourceRef,
  );
  const threadId = linkedIds.threadId ?? linkedRun?.threadId;
  const historyAvailable =
    olderRequest === undefined
      ? detail.nextDiscussionBeforeSequence !== undefined ||
        detail.nextRevisionBeforeSequence !== undefined
      : nextOlder !== undefined;
  const disabled = submitting !== null;
  const submitFeedback = async () => {
    if ((pendingReply === null && draft.text.trim().length === 0) || disabled) return;
    const submitted = inboxPendingReplyForSubmit({
      pending: pendingReply,
      draft,
      mutationId: `web:${randomUUID()}`,
      expectedVersion: detail.state.version,
    });
    if (pendingReply === null) updatePendingReply(submitted);
    const input = {
      spaceId: SpaceId.make(space.id),
      itemId: ItemId.make(itemId),
      mutationId: submitted.mutationId,
      expectedVersion: submitted.expectedVersion,
      text: submitted.text,
    };
    const succeeded = await runMutation(
      submitted.intent,
      async () =>
        (submitted.intent === "comment" ? comment : requestChanges)({ environmentId, input }),
      (_message, outcome) => {
        updatePendingReply(inboxPendingReplyAfterAttempt(submitted, outcome));
        if (outcome === "conflict") {
          setRejectedReply(submitted);
          detailQuery.refresh();
        }
      },
    );
    if (!succeeded) return;
    updatePendingReply(null);
    setRejectedReply(null);
    const nextDraft = inboxDraftAfterAcknowledgedReply(draftRef.current, submitted);
    if (nextDraft !== draftRef.current) updateDraft(nextDraft);
  };
  const simpleMutation = async (label: string, command: typeof unsnooze) =>
    runMutation(label, async () =>
      command({
        environmentId,
        input: {
          spaceId: SpaceId.make(space.id),
          itemId: ItemId.make(itemId),
          mutationId: `web:${randomUUID()}`,
          expectedVersion: detail.state.version,
        },
      }),
    );

  return (
    <article className="h-full overflow-y-auto" aria-labelledby="inbox-detail-title">
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-border/60 bg-background/92 px-4 py-3 backdrop-blur lg:hidden">
        <Button onClick={onBack} size="sm" variant="ghost">
          <ArrowLeftIcon /> Inbox
        </Button>
        <span className="truncate text-xs text-muted-foreground">{space.displayName}</span>
      </div>
      <div className="mx-auto flex max-w-3xl flex-col gap-5 p-4 pb-16 sm:p-6">
        <header>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge size="sm" variant="secondary">
              {space.displayName}
            </Badge>
            <span>{detail.item.kind}</span>
            <span aria-hidden="true">·</span>
            <span>{detail.item.status.replace("_", " ")}</span>
          </div>
          <h1
            className="mt-2 text-balance text-2xl font-semibold tracking-tight"
            id="inbox-detail-title"
            ref={detailHeadingRef}
            tabIndex={-1}
          >
            {detail.item.title}
          </h1>
          {detail.item.description ? (
            <p className="mt-2 leading-6 text-muted-foreground">{detail.item.description}</p>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            {threadId !== undefined ? (
              <Button
                render={
                  <Link to="/$environmentId/$threadId" params={{ environmentId, threadId }} />
                }
                size="sm"
                variant="outline"
              >
                <MessageSquareIcon /> Open thread <ExternalLinkIcon className="size-3" />
              </Button>
            ) : null}
            {linkedRun !== undefined ? (
              <Button
                render={
                  <Link to="/command" search={{ environment: environmentId, run: linkedRun.id }} />
                }
                size="sm"
                variant="outline"
              >
                Open Run <ExternalLinkIcon className="size-3" />
              </Button>
            ) : null}
          </div>
        </header>

        <section
          className="rounded-2xl border border-primary/25 bg-card/40 p-4 sm:p-5"
          aria-labelledby="inbox-reply-heading"
        >
          <div className="flex items-center gap-2">
            <MessageSquareIcon className="size-4 text-primary" />
            <h2 className="font-semibold" id="inbox-reply-heading">
              Reply or request changes
            </h2>
          </div>
          <label className="mt-4 block text-sm font-medium" htmlFor="inbox-reply">
            Your feedback
          </label>
          <Textarea
            className="mt-1.5"
            id="inbox-reply"
            maxLength={INBOX_COMMENT_MAX_CHARS}
            onChange={(event) => updateDraft({ ...draft, text: event.target.value })}
            placeholder="Add context or describe exactly what should change…"
            value={draft.text}
          />
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
            <label className="sr-only" htmlFor="inbox-reply-intent">
              Reply intent
            </label>
            <select
              className="h-9 rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              disabled={disabled}
              id="inbox-reply-intent"
              onChange={(event) =>
                updateDraft({ ...draft, intent: event.target.value as InboxReplyIntent })
              }
              value={draft.intent}
            >
              <option value="comment">Comment</option>
              <option value="request-changes">Request changes</option>
            </select>
            <Button
              disabled={
                disabled ||
                rejectedReply !== null ||
                (pendingReply === null && draft.text.trim().length === 0)
              }
              onClick={() => void submitFeedback()}
            >
              {submitting === (pendingReply?.intent ?? draft.intent) ? (
                <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" />
              ) : (
                <SendIcon />
              )}
              {pendingReply !== null
                ? `Retry submitted ${pendingReply.intent === "comment" ? "comment" : "change request"}`
                : draft.intent === "comment"
                  ? "Save comment"
                  : "Request changes"}
            </Button>
          </div>
          {pendingReply !== null ? (
            <div className="mt-3 rounded-lg border border-amber-500/35 bg-amber-500/8 p-3 text-sm">
              <p>
                {rejectedReply === null
                  ? "The previous response was not conclusive. Retry sends the exact same request ID, version, intent, and submitted text. Any newer text in the editor stays untouched."
                  : "The server rejected this version after confirming the original request did not save. Review the latest item before resubmitting the original text."}
              </p>
              <p className="mt-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                Pending {pendingReply.intent === "comment" ? "comment" : "change request"} · item
                version {pendingReply.expectedVersion}
              </p>
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-sm">
                {pendingReply.text}
              </pre>
              {rejectedReply !== null ? (
                <Button
                  className="mt-2"
                  disabled={disabled || detail.state.version <= rejectedReply.expectedVersion}
                  onClick={() => {
                    updatePendingReply(
                      rebaseInboxPendingReply(
                        rejectedReply,
                        detail.state.version,
                        `web:${randomUUID()}`,
                      ),
                    );
                    setRejectedReply(null);
                    setSaveError(null);
                  }}
                  size="sm"
                  variant="outline"
                >
                  Resubmit against latest version
                </Button>
              ) : null}
            </div>
          ) : null}
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            Comments preserve your exact message. Requesting changes also blocks the current
            proposal until the request is explicitly resolved.
            {draftScopeId === undefined
              ? " Secure draft persistence is unavailable from this server, so this draft stays in memory only."
              : " This authenticated session stores the draft locally for reloads."}
          </p>
        </section>

        {saveError !== null ? (
          <div
            className="rounded-xl border border-destructive/35 bg-destructive/5 p-4"
            role="alert"
          >
            <div className="flex gap-2 text-sm text-destructive-foreground">
              <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
              <p>
                {isConflictMessage(saveError)
                  ? "This item changed in another client. Your draft is safe. Reload the latest version, review it, then submit again."
                  : saveError}
              </p>
            </div>
            <Button className="mt-3" onClick={detailQuery.refresh} size="sm" variant="outline">
              <RefreshCwIcon /> Reload latest
            </Button>
          </div>
        ) : null}

        <section
          className="rounded-2xl border border-border/65 bg-card/30 p-4 sm:p-5"
          aria-labelledby="proposal-heading"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-semibold" id="proposal-heading">
              Current proposal
            </h2>
            {detail.state.unresolvedChangeRequestCount > 0 ? (
              <Badge variant="secondary">Revision needed</Badge>
            ) : null}
          </div>
          {currentRevision === undefined ? (
            <>
              <p className="mt-3 text-sm text-muted-foreground">
                No proposal is attached yet. Start a structured field change for this item, or
                continue with comments and lifecycle actions.
              </p>
              <StarterProposalEditor
                disabled={disabled}
                onCreate={async ({ payload, preview }) =>
                  runMutation("create-candidate", async () =>
                    createCandidate({
                      environmentId,
                      input: {
                        spaceId: SpaceId.make(space.id),
                        itemId: ItemId.make(itemId),
                        mutationId: `web:${randomUUID()}`,
                        expectedVersion: detail.state.version,
                        source: "direct",
                        payload,
                        preview,
                        evidence: starterEvidence,
                      },
                    }),
                  )
                }
                target={detail.state.subject}
              />
            </>
          ) : (
            <>
              <p className="mt-3 font-medium">{currentRevision.preview.summary}</p>
              <ProposalHumanContext preview={currentRevision.preview} />
              <ProposalPayloadDetails payload={currentRevision.payload} />
              <div className="mt-4 rounded-xl border border-border/60 bg-background/45 p-3 text-sm">
                <p>
                  <span className="text-muted-foreground">Evidence:</span>{" "}
                  {currentRevision.evidence.source} · {currentRevision.evidence.subjectId}
                </p>
                <p className="mt-1 text-muted-foreground">
                  {relativeFreshness(currentRevision.evidence.observedAt)} · version{" "}
                  {currentRevision.evidence.version}
                </p>
              </div>
              <ProposalEditor
                current={currentRevision}
                disabled={disabled}
                onCreate={async ({ payload, preview }) => {
                  return runMutation("create-candidate", async () =>
                    createCandidate({
                      environmentId,
                      input: {
                        spaceId: SpaceId.make(space.id),
                        itemId: ItemId.make(itemId),
                        mutationId: `web:${randomUUID()}`,
                        expectedVersion: detail.state.version,
                        source: "direct",
                        payload,
                        preview,
                        evidence: currentRevision.evidence,
                      },
                    }),
                  );
                }}
              />
            </>
          )}
          <div className="mt-4 rounded-xl border border-border/60 bg-muted/15 p-3 text-sm text-muted-foreground">
            {detail.state.approval.reason === "changes-requested"
              ? "Approval is blocked until every change request is resolved."
              : detail.state.approval.reason === "candidate-pending"
                ? "Review the pending candidate before the proposal can move forward."
                : detail.state.approval.reason === "no-current-proposal"
                  ? "There is no proposal to approve."
                  : "Execution is not available for this item. Comments and proposal revisions remain available."}
          </div>
        </section>

        {candidates.length > 0 ? (
          <section className="space-y-3" aria-labelledby="candidate-heading">
            <h2 className="font-semibold" id="candidate-heading">
              Revision candidates
            </h2>
            {candidates.map((candidate) => (
              <div
                className="rounded-xl border border-primary/25 bg-primary/5 p-4"
                key={candidate.id}
              >
                <p className="font-medium">{candidate.preview.summary}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Prepared {dateLabel(candidate.createdAt)} from {candidate.evidence.source}
                </p>
                <ProposalHumanContext preview={candidate.preview} />
                <ProposalPayloadDetails
                  label="Exact effect if accepted"
                  payload={candidate.payload}
                />
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    disabled={disabled}
                    onClick={() =>
                      void runMutation("accept-candidate", async () =>
                        acceptCandidate({
                          environmentId,
                          input: {
                            spaceId: SpaceId.make(space.id),
                            itemId: ItemId.make(itemId),
                            mutationId: `web:${randomUUID()}`,
                            expectedVersion: detail.state.version,
                            candidateRevisionId: candidate.id,
                          },
                        }),
                      )
                    }
                    size="sm"
                  >
                    <CheckIcon /> Accept revision
                  </Button>
                  <Button
                    disabled={disabled}
                    onClick={() =>
                      void runMutation("discard-candidate", async () =>
                        discardCandidate({
                          environmentId,
                          input: {
                            spaceId: SpaceId.make(space.id),
                            itemId: ItemId.make(itemId),
                            mutationId: `web:${randomUUID()}`,
                            expectedVersion: detail.state.version,
                            candidateRevisionId: candidate.id,
                          },
                        }),
                      )
                    }
                    size="sm"
                    variant="outline"
                  >
                    <XIcon /> Discard
                  </Button>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Accepting edits the proposal. It does not authorize or execute the action.
                </p>
              </div>
            ))}
          </section>
        ) : null}

        <section
          className="rounded-2xl border border-border/65 bg-card/30 p-4 sm:p-5"
          aria-labelledby="source-heading"
        >
          <h2 className="font-semibold" id="source-heading">
            Why this is here
          </h2>
          <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">Source</dt>
              <dd className="mt-1">
                {detail.item.provenance.originalLabel ?? detail.item.provenance.kind}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Captured</dt>
              <dd className="mt-1">{dateLabel(detail.item.provenance.capturedAt)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Subject</dt>
              <dd className="mt-1">
                {detail.state.subject.kind} · {detail.state.subject.id}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Last updated</dt>
              <dd className="mt-1">{dateLabel(detail.state.updatedAt)}</dd>
            </div>
          </dl>
        </section>

        <section
          className="rounded-2xl border border-border/65 bg-card/30 p-4 sm:p-5"
          aria-labelledby="lifecycle-heading"
        >
          <h2 className="font-semibold" id="lifecycle-heading">
            Item status
          </h2>
          {detail.state.lifecycle === "open" ? (
            <SnoozeAndDismiss
              disabled={disabled}
              submitting={submitting}
              onDismiss={() => void simpleMutation("dismiss", dismiss)}
              onSnooze={(wakeAt) =>
                void runMutation("snooze", async () =>
                  snooze({
                    environmentId,
                    input: {
                      spaceId: SpaceId.make(space.id),
                      itemId: ItemId.make(itemId),
                      mutationId: `web:${randomUUID()}`,
                      expectedVersion: detail.state.version,
                      wakeAt,
                    },
                  }),
                )
              }
            />
          ) : detail.state.lifecycle === "snoozed" ? (
            <div className="mt-3">
              <p className="mb-3 text-sm text-muted-foreground">
                Snoozed until {dateLabel(detail.state.snoozedUntil)}.
              </p>
              <Button
                disabled={disabled}
                onClick={() => void simpleMutation("unsnooze", unsnooze)}
                size="sm"
              >
                <ArchiveRestoreIcon /> Unsnooze
              </Button>
            </div>
          ) : (
            <div className="mt-3">
              <p className="mb-3 text-sm text-muted-foreground">
                Dismissed items remain in Recent and keep their discussion and proposal history.
              </p>
              <Button
                disabled={disabled}
                onClick={() => void simpleMutation("reopen", reopen)}
                size="sm"
              >
                <ArchiveRestoreIcon /> Reopen
              </Button>
            </div>
          )}
        </section>

        <section aria-labelledby="history-heading">
          <h2 className="font-semibold" id="history-heading">
            Discussion and revision history
          </h2>
          <div className="mt-3 space-y-3">
            {discussion.map((entry) => (
              <div className="rounded-xl border border-border/60 bg-card/25 p-4" key={entry.id}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Badge
                    size="sm"
                    variant={entry.kind === "change-request" ? "secondary" : "outline"}
                  >
                    {entry.kind === "change-request" ? "Change requested" : "Comment"}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {dateLabel(entry.createdAt)}
                  </span>
                </div>
                <p className="mt-2 text-sm whitespace-pre-wrap">{entry.text}</p>
                <p className="mt-2 text-xs text-muted-foreground">{entry.actor.subject}</p>
                {entry.kind === "change-request" && entry.resolvedAt === undefined ? (
                  <Button
                    className="mt-3"
                    disabled={disabled}
                    onClick={() =>
                      void runMutation("resolve-request", async () =>
                        resolveChangeRequest({
                          environmentId,
                          input: {
                            spaceId: SpaceId.make(space.id),
                            itemId: ItemId.make(itemId),
                            mutationId: `web:${randomUUID()}`,
                            expectedVersion: detail.state.version,
                            changeRequestId: entry.id,
                          },
                        }),
                      )
                    }
                    size="sm"
                    variant="outline"
                  >
                    <CheckIcon /> Mark request resolved
                  </Button>
                ) : entry.resolvedAt !== undefined ? (
                  <p className="mt-2 text-xs text-emerald-400">
                    Resolved {dateLabel(entry.resolvedAt)}
                  </p>
                ) : null}
              </div>
            ))}
            {allRevisions.map((revision) => (
              <div className="rounded-xl border border-border/60 bg-card/25 p-4" key={revision.id}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Badge size="sm" variant="outline">
                    Revision {revision.revision} · {revision.status}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {dateLabel(revision.createdAt)}
                  </span>
                </div>
                <p className="mt-2 text-sm">{revision.preview.summary}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {revision.actor.subject} · evidence {revision.evidence.source}/
                  {revision.evidence.subjectId} · version {revision.evidence.version}
                </p>
                <ProposalHumanContext preview={revision.preview} />
                <ProposalPayloadDetails payload={revision.payload} />
                {revision.acceptedAt !== undefined ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Accepted {dateLabel(revision.acceptedAt)} by{" "}
                    {revision.acceptedBy?.subject ?? "Unknown"}
                  </p>
                ) : null}
                {revision.discardedAt !== undefined ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Discarded {dateLabel(revision.discardedAt)} by{" "}
                    {revision.discardedBy?.subject ?? "Unknown"}
                  </p>
                ) : null}
              </div>
            ))}
            {discussion.length === 0 && allRevisions.length === 0 ? (
              <p className="text-sm text-muted-foreground">No history yet.</p>
            ) : null}
          </div>
          {historyAvailable ? (
            <Button
              className="mt-4"
              disabled={olderQuery.isPending}
              onClick={() => {
                const next =
                  olderRequest === undefined
                    ? {
                        ...(detail.nextDiscussionBeforeSequence === undefined
                          ? {}
                          : { discussionBeforeSequence: detail.nextDiscussionBeforeSequence }),
                        ...(detail.nextRevisionBeforeSequence === undefined
                          ? {}
                          : { revisionBeforeSequence: detail.nextRevisionBeforeSequence }),
                      }
                    : nextOlder;
                if (next !== undefined) setOlderRequest(next);
              }}
              size="sm"
              variant="outline"
            >
              {olderQuery.isPending ? (
                <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" />
              ) : null}{" "}
              Load earlier history
            </Button>
          ) : null}
        </section>
      </div>
    </article>
  );
}

function SnoozeAndDismiss({
  disabled,
  submitting,
  onDismiss,
  onSnooze,
}: {
  readonly disabled: boolean;
  readonly submitting: string | null;
  readonly onDismiss: () => void;
  readonly onSnooze: (wakeAt: string) => void;
}) {
  const defaultWake = useMemo(() => {
    const date = new Date(Date.now() + 24 * 60 * 60 * 1_000);
    date.setSeconds(0, 0);
    const local = new Date(date.valueOf() - date.getTimezoneOffset() * 60_000);
    return local.toISOString().slice(0, 16);
  }, []);
  const [wakeAt, setWakeAt] = useState(defaultWake);
  const validWake = new Date(wakeAt).valueOf() > Date.now();
  return (
    <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
      <div>
        <label className="mb-1.5 block text-sm text-muted-foreground" htmlFor="inbox-wake-time">
          Wake time
        </label>
        <Input
          id="inbox-wake-time"
          min={defaultWake}
          onChange={(event) => setWakeAt(event.target.value)}
          type="datetime-local"
          value={wakeAt}
        />
      </div>
      <Button
        disabled={disabled || !validWake}
        onClick={() => onSnooze(new Date(wakeAt).toISOString())}
        size="sm"
        variant="outline"
      >
        {submitting === "snooze" ? (
          <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" />
        ) : (
          <Clock3Icon />
        )}{" "}
        Snooze
      </Button>
      <Button disabled={disabled} onClick={onDismiss} size="sm" variant="ghost">
        Dismiss
      </Button>
    </div>
  );
}

export function InboxScreen({
  environmentId,
  environmentOptions,
  draftScopeId,
  itemId,
  runs,
  selectedSpaceId,
  spaces,
  tab,
  onEnvironmentChange,
  onItemChange,
  onSelectItem,
  onSpaceChange,
  onTabChange,
}: InboxScreenProps) {
  const [refreshToken, setRefreshToken] = useState(0);
  const preparedConnection = usePreparedConnection(environmentId);
  const relaySession = useAtomValue(managedRelaySessionAtom);
  const scopedDraftId = resolveInboxDraftScopeId({
    serverScopeId: draftScopeId,
    targetKind: Option.isSome(preparedConnection)
      ? preparedConnection.value.target._tag
      : undefined,
    relayAccountId: relaySession?.accountId,
  });
  const visibleSpaces =
    selectedSpaceId === undefined ? spaces : spaces.filter((space) => space.id === selectedSpaceId);
  const selectedSpace = spaces.find((space) => space.id === selectedSpaceId);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
      <WorkspacePageHeader className="border-b border-border/60 bg-background">
        <div className="flex min-w-0 items-center gap-2">
          <InboxIcon className="size-4 text-primary" />
          <span className="truncate text-sm font-semibold">Inbox</span>
        </div>
        <div className="ml-auto flex min-w-0 items-center gap-2">
          {environmentOptions.length > 1 ? (
            <>
              <label className="sr-only" htmlFor="inbox-environment">
                Environment
              </label>
              <select
                className="h-8 max-w-44 rounded-md border border-input bg-background px-2 text-xs"
                id="inbox-environment"
                onChange={(event) => onEnvironmentChange(event.target.value as EnvironmentId)}
                value={environmentId}
              >
                {environmentOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </>
          ) : null}
          <Button
            aria-label="Refresh Inbox"
            onClick={() => setRefreshToken((token) => token + 1)}
            size="icon-sm"
            variant="ghost"
          >
            <RefreshCwIcon />
          </Button>
        </div>
      </WorkspacePageHeader>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="border-b border-border/60 px-4 py-4 sm:px-6">
          <div className="mx-auto flex max-w-7xl flex-col gap-4">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
              <div>
                <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Inbox</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  Decisions, questions, and useful results that deserve a closer look.
                </p>
              </div>
              <div>
                <label className="sr-only" htmlFor="inbox-space">
                  Filter by Space
                </label>
                <select
                  className="h-9 min-w-44 rounded-lg border border-input bg-background px-3 text-sm"
                  id="inbox-space"
                  onChange={(event) => onSpaceChange(event.target.value || undefined)}
                  value={selectedSpaceId ?? ""}
                >
                  <option value="">All Spaces</option>
                  {spaces.map((space) => (
                    <option key={space.id} value={space.id}>
                      {space.displayName}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div aria-label="Inbox views" className="flex gap-1" role="tablist">
              {TAB_OPTIONS.map((option) => (
                <button
                  aria-selected={tab === option.value}
                  className={cn(
                    "rounded-lg px-3 py-2 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    tab === option.value
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  key={option.value}
                  onClick={() => onTabChange(option.value)}
                  role="tab"
                  type="button"
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="mx-auto grid min-h-0 w-full max-w-7xl flex-1 lg:grid-cols-[minmax(19rem,24rem)_minmax(0,1fr)]">
          <div
            className={cn(
              "min-h-0 overflow-y-auto border-r border-border/60 p-4 sm:p-5",
              itemId !== undefined && "hidden lg:block",
            )}
          >
            <div className="space-y-6">
              {visibleSpaces.map((space) => (
                <InboxSpaceList
                  environmentId={environmentId}
                  key={`${environmentId}:${space.id}:${tab}`}
                  onSelect={(summary) => onSelectItem(summary.state.spaceId, summary.item.id)}
                  refreshToken={refreshToken}
                  selectedItemId={itemId}
                  space={space}
                  tab={tab}
                />
              ))}
              {visibleSpaces.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border/70 p-6 text-center text-sm text-muted-foreground">
                  This environment has no Spaces. Inbox stays empty until a real Space and item
                  exist.
                </div>
              ) : null}
            </div>
          </div>
          <div className={cn("min-h-0", itemId === undefined && "hidden lg:block")}>
            {itemId !== undefined && selectedSpace !== undefined ? (
              <InboxDetailPane
                draftScopeId={scopedDraftId}
                environmentId={environmentId}
                itemId={itemId}
                key={`${environmentId}:${scopedDraftId ?? "memory-only"}:${selectedSpace.id}:${itemId}`}
                onBack={() => onItemChange(undefined)}
                onChanged={() => setRefreshToken((token) => token + 1)}
                runs={runs}
                space={selectedSpace}
              />
            ) : (
              <div className="flex h-full items-center justify-center p-8 text-center">
                <div className="max-w-sm">
                  <InboxIcon className="mx-auto size-8 text-muted-foreground/60" />
                  <h2 className="mt-4 font-semibold">Choose an Inbox item</h2>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">
                    Its reason, evidence, discussion, and exact proposal will appear here.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
