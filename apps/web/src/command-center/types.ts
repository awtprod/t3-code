export type CommandCenterSpaceKind = "personal" | "business" | "system";

export interface CommandCenterSpace {
  readonly id: string;
  readonly name: string;
  readonly kind: CommandCenterSpaceKind;
  readonly description?: string | undefined;
  readonly unreadCount?: number | undefined;
}

export type CommandCenterConversationStatus = "idle" | "running" | "waiting" | "failed";

export interface CommandCenterConversation {
  readonly id: string;
  readonly spaceId: string;
  readonly projectId?: string | undefined;
  readonly threadId?: string | undefined;
  readonly title: string;
  readonly preview?: string | undefined;
  readonly updatedAtLabel: string;
  readonly status?: CommandCenterConversationStatus | undefined;
}

export interface CommandCenterProject {
  readonly id: string;
  readonly name: string;
  readonly repositoryName?: string | undefined;
  readonly repositoryId?: string | undefined;
  readonly spaceId?: string | undefined;
}

export type CommandCenterMessageAuthor = "user" | "assistant" | "system";

export interface CommandCenterMessage {
  readonly id: string;
  readonly author: CommandCenterMessageAuthor;
  readonly body: string;
  readonly createdAtLabel: string;
  readonly authorLabel?: string | undefined;
  readonly linkedRunId?: string | undefined;
  readonly linkedThreadId?: string | undefined;
  readonly receipt?: CommandCenterRouteReceipt | undefined;
}

export type CommandCenterRisk = "low" | "reversible" | "approval-required" | "blocked";
export type CommandCenterRouteStatus =
  | "ready"
  | "running"
  | "waiting-approval"
  | "complete"
  | "failed"
  | "blocked";

export type CommandCenterRouteSource =
  | "auto"
  | "explicit"
  | "policy"
  | "tier-policy"
  | "classifier"
  | "fallback"
  | "provider-default"
  | "unresolved";

export interface CommandCenterRouteSources {
  readonly space: CommandCenterRouteSource;
  readonly repository: CommandCenterRouteSource;
  readonly project: CommandCenterRouteSource;
  readonly provider: CommandCenterRouteSource;
  readonly model: CommandCenterRouteSource;
}

export interface CommandCenterRouteReceipt {
  readonly spaceName: string;
  readonly repositoryName?: string | undefined;
  readonly projectName?: string | undefined;
  readonly providerName: string;
  readonly modelName: string;
  readonly capabilities: readonly string[];
  readonly sources: CommandCenterRouteSources;
  readonly risk: CommandCenterRisk;
  readonly status: CommandCenterRouteStatus;
  readonly summary: string;
}

export interface CommandCenterNeedsYouItem {
  readonly id: string;
  readonly spaceId: string;
  readonly title: string;
  readonly spaceName: string;
  readonly reason: "approval" | "decision" | "review" | "blocked";
  readonly detail?: string | undefined;
  readonly action?:
    | {
        readonly kind: "approval";
        readonly approvalId: string;
        readonly proposal: string;
        readonly payloadDigest: string;
        readonly expiresAt?: string | undefined;
      }
    | {
        readonly kind: "memory";
        readonly memoryId: string;
        readonly spaceId: string;
        readonly repositoryId?: string | undefined;
        readonly content: string;
        readonly confidence: number;
      }
    | undefined;
}

export interface CommandCenterActiveRun {
  readonly id: string;
  readonly projectId?: string | undefined;
  readonly threadId?: string | undefined;
  readonly title: string;
  readonly spaceName: string;
  readonly status: "queued" | "running" | "waiting" | "failed";
  readonly detail?: string | undefined;
}

export interface CommandCenterTodayItem {
  readonly id: string;
  readonly spaceId: string;
  readonly title: string;
  readonly timeLabel: string;
  readonly kind: "calendar" | "task" | "automation";
}

export interface CommandCenterConnection {
  readonly id: string;
  readonly name: string;
  readonly status: "healthy" | "degraded" | "offline";
  readonly detail?: string | undefined;
}

export interface CommandCenterContext {
  readonly needsYou: readonly CommandCenterNeedsYouItem[];
  readonly activeRuns: readonly CommandCenterActiveRun[];
  readonly today: readonly CommandCenterTodayItem[];
  readonly connections: readonly CommandCenterConnection[];
}

export type CommandCenterRouteControl = "space" | "repository" | "project" | "provider" | "model";

export interface CommandCenterRouteSelection {
  readonly spaceId?: string | undefined;
  readonly repositoryId?: string | undefined;
  readonly projectId?: string | undefined;
  readonly providerId?: string | undefined;
  readonly modelId?: string | undefined;
}

export interface CommandCenterRouteOption {
  readonly id: string;
  readonly label: string;
  readonly detail?: string | undefined;
  readonly providerId?: string | undefined;
}

export interface CommandCenterRouteOptions {
  readonly repositories: readonly CommandCenterRouteOption[];
  readonly projects: readonly CommandCenterRouteOption[];
  readonly providers: readonly CommandCenterRouteOption[];
  readonly models: readonly CommandCenterRouteOption[];
}

export interface CommandCenterConfigNotice {
  readonly status: "missing" | "invalid";
  readonly message: string;
}

export interface CommandCenterShellProps {
  readonly spaces: readonly CommandCenterSpace[];
  readonly projects: readonly CommandCenterProject[];
  readonly conversations: readonly CommandCenterConversation[];
  readonly messages: readonly CommandCenterMessage[];
  readonly routeReceipt: CommandCenterRouteReceipt;
  readonly context: CommandCenterContext;
  readonly activeConversationId?: string | undefined;
  readonly selectedSpaceId?: string | undefined;
  readonly selectedProjectId?: string | undefined;
  readonly routeSelection: CommandCenterRouteSelection;
  readonly routeOptions: CommandCenterRouteOptions;
  readonly conversationTitle: string;
  readonly draft: string;
  readonly isSubmitting?: boolean | undefined;
  /**
   * True when a command cannot be dispatched right now (config not loaded,
   * bootstrap/timeline still pending, or no environment). Gates the send button
   * only — it must NOT disable the composer input, so the user can always type.
   */
  readonly commandUnavailable?: boolean | undefined;
  /**
   * Present when the Command Center configuration is missing or invalid, so the
   * shell can explain why sending is disabled instead of freezing silently.
   */
  readonly configNotice?: CommandCenterConfigNotice | null | undefined;
  readonly onDraftChange: (draft: string) => void;
  readonly onSubmit: (draft: string) => void;
  readonly onNewConversation?: (() => void) | undefined;
  readonly onClearTranscript?: (() => void) | undefined;
  readonly onSelectSpace?: ((spaceId: string) => void) | undefined;
  readonly onSelectProject?: ((projectId: string) => void) | undefined;
  readonly onSelectConversation?: ((conversationId: string) => void) | undefined;
  readonly onRouteSelectionChange?:
    | ((control: CommandCenterRouteControl, value: string | undefined) => void)
    | undefined;
  readonly onModelSelectionChange?: ((providerId: string, modelId: string) => void) | undefined;
  readonly onCapture?:
    | ((input: {
        readonly spaceId: string;
        readonly kind: "idea" | "task";
        readonly title: string;
      }) => Promise<boolean>)
    | undefined;
  readonly onOpenNeedsYouItem?: ((itemId: string) => void) | undefined;
  readonly onDismissNeedsYouItems?: ((itemIds: readonly string[]) => void) | undefined;
  readonly onDecideApproval?:
    | ((approvalId: string, payloadDigest: string, decision: "approved" | "declined") => void)
    | undefined;
  readonly onReviewMemory?:
    | ((
        memoryId: string,
        spaceId: string,
        repositoryId: string | undefined,
        decision: "approve" | "reject",
      ) => void)
    | undefined;
  readonly resolvingNeedsYouId?: string | undefined;
  readonly onOpenRun?: ((runId: string) => void) | undefined;
  readonly onOpenTodayItem?: ((itemId: string) => void) | undefined;
  readonly onOpenConnection?: ((connectionId: string) => void) | undefined;
  readonly onOpenLinkedThread?: ((threadId: string) => void) | undefined;
}
