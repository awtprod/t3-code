import type { CommandCenterInboxDetail, CommandCenterInboxDraftReceipt } from "@t3tools/contracts";

export const INBOX_PAGE_SIZE = 25;
export const INBOX_HISTORY_PAGE_SIZE = 30;
export const INBOX_COMMENT_MAX_CHARS = 20_000;

export type InboxTab = "actionable" | "recent" | "snoozed";
export type InboxReplyIntent = "comment" | "request-changes";

export interface InboxSearch {
  readonly environment?: string | undefined;
  readonly space?: string | undefined;
  readonly item?: string | undefined;
  readonly tab: InboxTab;
}

export interface InboxDraft {
  readonly text: string;
  readonly intent: InboxReplyIntent;
}

export interface InboxDraftScope {
  readonly environmentId: string;
  readonly draftScopeId: string;
  readonly spaceId: string;
  readonly itemId: string;
}

export interface InboxPendingReply {
  readonly mutationId: string;
  readonly expectedVersion: number;
  readonly text: string;
  readonly intent: InboxReplyIntent;
}

export type InboxMutationOutcome = "success" | "conflict" | "rejected" | "ambiguous";

const MAX_ROUTE_VALUE_CHARS = 200;
const DRAFT_STORAGE_PREFIX = "t3.commandCenter.inboxDraft.v1";
const PENDING_REPLY_STORAGE_PREFIX = "t3.commandCenter.inboxPendingReply.v1";
const MUTATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;

function boundedRouteValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed.slice(0, MAX_ROUTE_VALUE_CHARS);
}

export function validateInboxSearch(raw: Record<string, unknown>): InboxSearch {
  return {
    tab: raw.tab === "recent" || raw.tab === "snoozed" ? raw.tab : "actionable",
    ...(boundedRouteValue(raw.environment) === undefined
      ? {}
      : { environment: boundedRouteValue(raw.environment) }),
    ...(boundedRouteValue(raw.space) === undefined ? {} : { space: boundedRouteValue(raw.space) }),
    ...(boundedRouteValue(raw.item) === undefined ? {} : { item: boundedRouteValue(raw.item) }),
  };
}

export function resolveInboxEnvironmentId(input: {
  readonly requestedEnvironmentId?: string | undefined;
  readonly activeEnvironmentId?: string | null | undefined;
  readonly primaryEnvironmentId?: string | null | undefined;
  readonly environmentIds: ReadonlyArray<string>;
}): string | null {
  if (input.requestedEnvironmentId !== undefined) return input.requestedEnvironmentId;
  return (
    input.environmentIds.find((id) => id === input.activeEnvironmentId) ??
    input.environmentIds.find((id) => id === input.primaryEnvironmentId) ??
    input.environmentIds[0] ??
    null
  );
}

export function resolveInboxDraftScopeId(input: {
  readonly serverScopeId?: string | undefined;
  readonly targetKind?:
    | "PrimaryConnectionTarget"
    | "BearerConnectionTarget"
    | "RelayConnectionTarget"
    | "SshConnectionTarget"
    | undefined;
  readonly relayAccountId?: string | undefined;
}): string | undefined {
  if (input.serverScopeId === undefined || input.targetKind === undefined) return undefined;
  if (input.targetKind !== "RelayConnectionTarget") return input.serverScopeId;
  return input.relayAccountId === undefined
    ? undefined
    : JSON.stringify(["relay", input.serverScopeId, input.relayAccountId]);
}

export function inboxDraftStorageKey(scope: InboxDraftScope): string {
  return `${DRAFT_STORAGE_PREFIX}:${[
    scope.environmentId,
    scope.draftScopeId,
    scope.spaceId,
    scope.itemId,
  ]
    .map(encodeURIComponent)
    .join(":")}`;
}

export function inboxPendingReplyStorageKey(scope: InboxDraftScope): string {
  return `${PENDING_REPLY_STORAGE_PREFIX}:${[
    scope.environmentId,
    scope.draftScopeId,
    scope.spaceId,
    scope.itemId,
  ]
    .map(encodeURIComponent)
    .join(":")}`;
}

export function readInboxPendingReply(
  storage: Storage | null,
  scope: InboxDraftScope,
): InboxPendingReply | null {
  if (storage === null) return null;
  try {
    const raw: unknown = JSON.parse(storage.getItem(inboxPendingReplyStorageKey(scope)) ?? "null");
    if (typeof raw !== "object" || raw === null) return null;
    const mutationId = Reflect.get(raw, "mutationId");
    const expectedVersion = Reflect.get(raw, "expectedVersion");
    const text = Reflect.get(raw, "text");
    const intent = Reflect.get(raw, "intent");
    if (
      typeof mutationId !== "string" ||
      !MUTATION_ID_PATTERN.test(mutationId) ||
      typeof expectedVersion !== "number" ||
      !Number.isSafeInteger(expectedVersion) ||
      expectedVersion < 0 ||
      typeof text !== "string" ||
      text.length > INBOX_COMMENT_MAX_CHARS ||
      text.trim().length === 0 ||
      (intent !== "comment" && intent !== "request-changes")
    ) {
      return null;
    }
    return { mutationId, expectedVersion, text, intent };
  } catch {
    return null;
  }
}

export function writeInboxPendingReply(
  storage: Storage | null,
  scope: InboxDraftScope,
  pending: InboxPendingReply | null,
): void {
  if (storage === null) return;
  try {
    const key = inboxPendingReplyStorageKey(scope);
    if (pending === null) {
      storage.removeItem(key);
      return;
    }
    storage.setItem(key, JSON.stringify(pending));
  } catch {
    // Pending request persistence is best-effort when browser storage is blocked.
  }
}

export function inboxPendingReplyForSubmit(input: {
  readonly pending: InboxPendingReply | null;
  readonly draft: InboxDraft;
  readonly expectedVersion: number;
  readonly mutationId: string;
}): InboxPendingReply {
  return (
    input.pending ?? {
      mutationId: input.mutationId,
      expectedVersion: input.expectedVersion,
      text: input.draft.text,
      intent: input.draft.intent,
    }
  );
}

export function inboxDraftAfterAcknowledgedReply(
  current: InboxDraft,
  submitted: Pick<InboxPendingReply, "text" | "intent">,
): InboxDraft {
  return current.text === submitted.text && current.intent === submitted.intent
    ? { text: "", intent: "comment" }
    : current;
}

export function classifyInboxMutationResult(result: unknown): InboxMutationOutcome {
  if (typeof result !== "object" || result === null) return "ambiguous";
  if (Reflect.get(result, "_tag") === "Success") return "success";
  if (Reflect.get(result, "_tag") !== "Failure") return "ambiguous";
  const cause = Reflect.get(result, "cause");
  if (typeof cause !== "object" || cause === null) return "ambiguous";
  const reasons = Reflect.get(cause, "reasons");
  if (!Array.isArray(reasons) || reasons.length === 0) return "ambiguous";
  const failures = reasons.flatMap((reason: unknown) => {
    if (typeof reason !== "object" || reason === null || Reflect.get(reason, "_tag") !== "Fail") {
      return [];
    }
    return [Reflect.get(reason, "error")];
  });
  if (failures.length !== reasons.length) return "ambiguous";
  if (failures.some((failure) => typeof failure !== "object" || failure === null)) {
    return "ambiguous";
  }
  const tags = failures.map((failure) => Reflect.get(failure as object, "_tag"));
  if (tags.every((tag) => tag === "CommandCenterError")) {
    const reasons = failures.map((failure) => Reflect.get(failure as object, "reason"));
    if (reasons.every((reason) => reason === "conflict")) return "conflict";
    if (reasons.every((reason) => reason === "validation" || reason === "not_found")) {
      return "rejected";
    }
  }
  return tags.every((tag) => tag === "EnvironmentAuthorizationError") ? "rejected" : "ambiguous";
}

export function inboxPendingReplyAfterAttempt(
  submitted: InboxPendingReply,
  outcome: InboxMutationOutcome,
): InboxPendingReply | null {
  return outcome === "ambiguous" || outcome === "conflict" ? submitted : null;
}

export function rebaseInboxPendingReply(
  rejected: InboxPendingReply,
  expectedVersion: number,
  mutationId: string,
): InboxPendingReply {
  return { ...rejected, expectedVersion, mutationId };
}

export function readInboxDraft(storage: Storage | null, scope: InboxDraftScope): InboxDraft {
  if (storage === null) return { text: "", intent: "comment" };
  try {
    const raw: unknown = JSON.parse(storage.getItem(inboxDraftStorageKey(scope)) ?? "null");
    if (typeof raw !== "object" || raw === null) return { text: "", intent: "comment" };
    const text = Reflect.get(raw, "text");
    const intent = Reflect.get(raw, "intent");
    return {
      text: typeof text === "string" ? text.slice(0, INBOX_COMMENT_MAX_CHARS) : "",
      intent: intent === "request-changes" ? "request-changes" : "comment",
    };
  } catch {
    return { text: "", intent: "comment" };
  }
}

export function writeInboxDraft(
  storage: Storage | null,
  scope: InboxDraftScope,
  draft: InboxDraft,
): void {
  if (storage === null) return;
  try {
    const key = inboxDraftStorageKey(scope);
    if (draft.text.length === 0 && draft.intent === "comment") {
      storage.removeItem(key);
      return;
    }
    storage.setItem(
      key,
      JSON.stringify({
        text: draft.text.slice(0, INBOX_COMMENT_MAX_CHARS),
        intent: draft.intent,
      }),
    );
  } catch {
    // Draft persistence is best-effort when browser storage is blocked.
  }
}

export function jsonEditorValue(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "null";
}

export function parseJsonEditorValue(
  value: string,
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string } {
  try {
    return { ok: true, value: JSON.parse(value) as unknown };
  } catch {
    return { ok: false, message: "Enter a valid JSON value." };
  }
}

export function linkedItemIds(metadata: Readonly<Record<string, unknown>>): {
  readonly runId?: string;
  readonly threadId?: string;
} {
  const runId = boundedRouteValue(metadata.runId);
  const threadId = boundedRouteValue(metadata.threadId);
  return {
    ...(runId === undefined ? {} : { runId }),
    ...(threadId === undefined ? {} : { threadId }),
  };
}

export function mergeHistoryById<T extends { readonly id: string; readonly sequence: number }>(
  ...pages: ReadonlyArray<ReadonlyArray<T>>
): ReadonlyArray<T> {
  const entries = new Map<string, T>();
  for (const page of pages) {
    for (const entry of page) entries.set(entry.id, entry);
  }
  return [...entries.values()].sort((left, right) => right.sequence - left.sequence);
}

/**
 * Why the current Gmail draft proposal cannot be approved, or null when the
 * Approve draft control may be used. Specific Item and evidence blockers win
 * over missing approval authority; a receipt that is already creating,
 * created or uncertain never shows the authority message.
 */
export function gmailDraftApprovalBlockedReason(input: {
  readonly canApprove: boolean;
  readonly detail: CommandCenterInboxDetail;
  readonly receipt: CommandCenterInboxDraftReceipt | null;
}): string | null {
  const { canApprove, detail, receipt } = input;
  const currentRevision = detail.currentRevision;
  const isGmailDraft =
    currentRevision?.payload.kind === "prepared-action" &&
    currentRevision.payload.actionKind === "gmail.draft.create";
  return !isGmailDraft || currentRevision === undefined
    ? null
    : detail.state.lifecycle !== "open"
      ? "Reopen this item before approving its draft."
      : detail.item.status === "done" || detail.item.status === "canceled"
        ? "This Item is closed."
        : receipt?.status === "approved" && receipt.expectedVersion !== detail.state.version
          ? "This Item changed after draft approval. Review the latest proposal."
          : detail.state.unresolvedChangeRequestCount > 0 || detail.state.candidateCount > 0
            ? "Resolve change requests and review pending candidates first."
            : currentRevision.evidence.source !== "command-center-item" ||
                currentRevision.evidence.subjectId !== detail.item.id ||
                currentRevision.evidence.version !== detail.item.updatedAt
              ? "This draft needs current local Item evidence before approval."
              : currentRevision.payload.target.kind !== detail.state.subject.kind ||
                  currentRevision.payload.target.id !== detail.state.subject.id
                ? "The draft target no longer matches this Inbox subject."
                : !canApprove && (receipt === null || receipt.status === "approved")
                  ? "This session lacks approval authority."
                  : null;
}
