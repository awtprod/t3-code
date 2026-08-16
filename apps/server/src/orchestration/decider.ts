import {
  DEFAULT_SANDBOX_DESKTOP_CONFIG,
  DEFAULT_SANDBOX_RESOURCE_LIMITS,
  EventId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type SandboxEvent,
  type SandboxState,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import {
  listThreadsByProjectId,
  requireActiveProjectWorkspaceRootAbsent,
  requireProject,
  requireProjectAbsent,
  requireThread,
  requireThreadArchived,
  requireThreadAbsent,
  requireThreadNotArchived,
} from "./commandInvariants.ts";
import { projectEvent } from "./projector.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const sandboxInvariant = (commandType: string, detail: string) =>
  new OrchestrationCommandInvariantError({ commandType, detail });

// Session adoption takes seconds; a user message still unadopted after this
// window is a failed/stale start, not pending work. Mirrors the client's
// QUEUED_TURN_START_GRACE_MS in client-runtime threadSettled.ts.
const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;

/**
 * Blocked-on-you work derived from the thread's retained activities: an
 * approval or user-input request with no later resolution for the same
 * requestId. The server-side twin of the shell's hasPendingApprovals /
 * hasPendingUserInput flags, which the decider read model does not carry.
 * The clearing rules MUST match ProjectionPipeline's pending accounting —
 * resolved activities always clear, respond.failed clears only when the
 * failure detail marks the request stale/unknown — or settle would be
 * rejected on threads whose shell flags read as clear.
 */
function isStaleRequestFailureDetail(payload: Record<string, unknown> | null): boolean {
  const detail = typeof payload?.detail === "string" ? payload.detail.toLowerCase() : null;
  if (detail === null) return false;
  return (
    detail.includes("stale pending approval request") ||
    detail.includes("unknown pending approval request") ||
    detail.includes("unknown pending permission request") ||
    detail.includes("stale pending user-input request") ||
    detail.includes("unknown pending user-input request") ||
    detail.includes("unknown pending user input request") ||
    detail.includes("unknown pending codex user input request")
  );
}

// Scans the read model's activities, which the projector caps at the most
// recent 500. That bound is safe here: an OPEN approval/user-input request
// blocks its turn, so the thread cannot accumulate hundreds of later
// activities while one is outstanding — a request that has scrolled out of
// the window is one whose turn kept running, i.e. it was resolved or went
// stale. (The projection pipeline's pendingApprovalCount reads the same
// capped stream and stays consistent with this view.)
function hasOpenBlockingRequest(thread: {
  readonly activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>;
}): boolean {
  const openRequestIds = new Set<string>();
  for (const activity of thread.activities) {
    const payload =
      typeof activity.payload === "object" && activity.payload !== null
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : null;
    if (requestId === null) continue;
    if (activity.kind === "approval.requested" || activity.kind === "user-input.requested") {
      openRequestIds.add(requestId);
    } else if (activity.kind === "approval.resolved" || activity.kind === "user-input.resolved") {
      openRequestIds.delete(requestId);
    } else if (
      (activity.kind === "provider.approval.respond.failed" ||
        activity.kind === "provider.user-input.respond.failed") &&
      isStaleRequestFailureDetail(payload)
    ) {
      openRequestIds.delete(requestId);
    }
  }
  return openRequestIds.size > 0;
}

/**
 * A queued turn start — a user message no turn has picked up yet — is work
 * in flight even though session is still null (turn.start emits
 * message-sent + turn-start-requested; the session arrives later). Detection
 * mirrors the client's hasQueuedTurnStart: the newest user message is
 * strictly newer than every latestTurn timestamp (adoption stamps the new
 * turn's requestedAt with the message time, clearing this), and only within
 * the adoption grace window — historical threads whose last user message
 * postdates their turn timestamps (older-server data, mid-turn messages)
 * must not be blocked forever. A failed session start (status "error")
 * clears the block immediately.
 *
 * The age check is bounded on BOTH sides: message timestamps are
 * client-supplied, so a client clock ahead of the server yields a negative
 * age. Without the lower bound that negative age satisfies `<= grace` for
 * as long as the skew lasts, extending the block far past the intended two
 * minutes.
 */
function threadHasQueuedTurnStart(
  thread: {
    readonly messages: ReadonlyArray<{ readonly role: string; readonly createdAt: string }>;
    readonly latestTurn: {
      readonly requestedAt: string;
      readonly startedAt: string | null;
      readonly completedAt: string | null;
    } | null;
    readonly session: { readonly status: string } | null;
  },
  occurredAt: string,
): boolean {
  const latestUserMessageAtMs = thread.messages.reduce(
    (latest, message) =>
      message.role === "user" ? Math.max(latest, Date.parse(message.createdAt)) : latest,
    Number.NEGATIVE_INFINITY,
  );
  const latestTurnAtMs =
    thread.latestTurn === null
      ? Number.NEGATIVE_INFINITY
      : Math.max(
          ...[
            thread.latestTurn.requestedAt,
            thread.latestTurn.startedAt,
            thread.latestTurn.completedAt,
          ].map((candidate) =>
            candidate == null ? Number.NEGATIVE_INFINITY : Date.parse(candidate),
          ),
        );
  const queuedAgeMs = Date.parse(occurredAt) - latestUserMessageAtMs;
  return (
    thread.session?.status !== "error" &&
    Number.isFinite(latestUserMessageAtMs) &&
    latestUserMessageAtMs > latestTurnAtMs &&
    Math.abs(queuedAgeMs) <= QUEUED_TURN_START_GRACE_MS
  );
}

function withEventBase(
  input: Pick<OrchestrationCommand, "commandId"> & {
    readonly aggregateKind: OrchestrationEvent["aggregateKind"];
    readonly aggregateId: OrchestrationEvent["aggregateId"];
    readonly occurredAt: string;
    readonly metadata?: OrchestrationEvent["metadata"];
  },
): Effect.Effect<
  Omit<OrchestrationEvent, "sequence" | "type" | "payload">,
  PlatformError.PlatformError,
  Crypto.Crypto
> {
  return Crypto.Crypto.pipe(
    Effect.flatMap((crypto) =>
      crypto.randomUUIDv4.pipe(
        Effect.map((eventId) => ({
          eventId: EventId.make(eventId),
          aggregateKind: input.aggregateKind,
          aggregateId: input.aggregateId,
          occurredAt: input.occurredAt,
          commandId: input.commandId,
          causationEventId: null,
          correlationId: input.commandId,
          metadata: input.metadata ?? {},
        })),
      ),
    ),
  );
}

type PlannedOrchestrationEvent = Omit<OrchestrationEvent, "sequence">;

type DecideOrchestrationCommandResult =
  | PlannedOrchestrationEvent
  | ReadonlyArray<PlannedOrchestrationEvent>;

const decideCommandSequence = Effect.fn("decideCommandSequence")(function* ({
  commands,
  readModel,
}: {
  readonly commands: ReadonlyArray<OrchestrationCommand>;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  ReadonlyArray<PlannedOrchestrationEvent>,
  OrchestrationCommandInvariantError | PlatformError.PlatformError,
  Crypto.Crypto
> {
  let nextReadModel = readModel;
  let nextSequence = readModel.snapshotSequence;
  const plannedEvents: PlannedOrchestrationEvent[] = [];

  for (const nextCommand of commands) {
    const decided = yield* decideOrchestrationCommand({
      command: nextCommand,
      readModel: nextReadModel,
    });
    const nextEvents = Array.isArray(decided) ? decided : [decided];
    for (const nextEvent of nextEvents) {
      plannedEvents.push(nextEvent);
      nextSequence += 1;
      nextReadModel = yield* projectEvent(nextReadModel, {
        ...nextEvent,
        sequence: nextSequence,
      }).pipe(Effect.orDie);
    }
  }

  return plannedEvents;
});

export const decideOrchestrationCommand = Effect.fn("decideOrchestrationCommand")(function* ({
  command,
  readModel,
}: {
  readonly command: OrchestrationCommand;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  DecideOrchestrationCommandResult,
  OrchestrationCommandInvariantError | PlatformError.PlatformError,
  Crypto.Crypto
> {
  const sandboxTransition = Effect.fn("sandboxTransition")(function* (
    threadId: SandboxEvent["threadId"],
    commandId: OrchestrationCommand["commandId"],
    type: SandboxEvent["type"],
    event: SandboxEvent,
    sandbox: SandboxState,
  ) {
    return {
      ...(yield* withEventBase({
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: event.occurredAt,
        commandId,
      })),
      type,
      payload: { threadId, event, sandbox },
    } as PlannedOrchestrationEvent;
  });
  switch (command.type) {
    case "project.create": {
      yield* requireProjectAbsent({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireActiveProjectWorkspaceRootAbsent({
        readModel,
        command,
        workspaceRoot: command.workspaceRoot,
        exceptProjectId: command.projectId,
      });

      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "project.created",
        payload: {
          projectId: command.projectId,
          title: command.title,
          workspaceRoot: command.workspaceRoot,
          defaultModelSelection: command.defaultModelSelection ?? null,
          faviconPath: null,
          scripts: [],
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "project.meta.update": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      if (command.workspaceRoot !== undefined) {
        yield* requireActiveProjectWorkspaceRootAbsent({
          readModel,
          command,
          workspaceRoot: command.workspaceRoot,
          exceptProjectId: command.projectId,
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "project.meta-updated",
        payload: {
          projectId: command.projectId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.workspaceRoot !== undefined ? { workspaceRoot: command.workspaceRoot } : {}),
          ...(command.defaultModelSelection !== undefined
            ? { defaultModelSelection: command.defaultModelSelection }
            : {}),
          ...(command.defaultThreadEnvMode !== undefined
            ? { defaultThreadEnvMode: command.defaultThreadEnvMode }
            : {}),
          ...(command.faviconPath !== undefined ? { faviconPath: command.faviconPath } : {}),
          ...(command.scripts !== undefined ? { scripts: command.scripts } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "project.delete": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const activeThreads = listThreadsByProjectId(readModel, command.projectId).filter(
        (thread) => thread.deletedAt === null,
      );
      if (activeThreads.length > 0 && command.force !== true) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Project '${command.projectId}' is not empty and cannot be deleted without force=true.`,
        });
      }
      if (activeThreads.length > 0) {
        return yield* decideCommandSequence({
          readModel,
          commands: [
            ...activeThreads.map(
              (thread): Extract<OrchestrationCommand, { type: "thread.delete" }> => ({
                type: "thread.delete",
                commandId: command.commandId,
                threadId: thread.id,
              }),
            ),
            {
              type: "project.delete",
              commandId: command.commandId,
              projectId: command.projectId,
            },
          ],
        });
      }

      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "project.deleted" as const,
        payload: {
          projectId: command.projectId,
          deletedAt: occurredAt,
        },
      };
    }

    case "thread.create": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });
      const sandbox =
        command.sandbox ??
        (command.sandboxBranch
          ? {
              lifecycle: "unprovisioned" as const,
              branch: command.sandboxBranch,
              limits: command.sandboxConfig?.limits ?? DEFAULT_SANDBOX_RESOURCE_LIMITS,
              desktop: {
                status: "unavailable" as const,
                resolution: command.sandboxConfig?.desktop ?? DEFAULT_SANDBOX_DESKTOP_CONFIG,
              },
              services: [],
              controller: { kind: "none" as const },
              createdAt: command.createdAt,
              lastActiveAt: command.createdAt,
            }
          : null);
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.created",
        payload: {
          threadId: command.threadId,
          projectId: command.projectId,
          title: command.title,
          modelSelection: command.modelSelection,
          routingMode: command.routingMode,
          ...(command.efficiencyTier === undefined
            ? {}
            : { efficiencyTier: command.efficiencyTier }),
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          branch: command.branch,
          worktreePath: command.worktreePath,
          sandboxConfig: command.sandboxConfig,
          sandboxBranch: command.sandboxBranch,
          sandbox,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.delete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.deleted",
        payload: {
          threadId: command.threadId,
          deletedAt: occurredAt,
        },
      };
    }

    case "thread.archive": {
      yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.archived",
        payload: {
          threadId: command.threadId,
          archivedAt: occurredAt,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.unarchive": {
      yield* requireThreadArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unarchived",
        payload: {
          threadId: command.threadId,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.settle": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Server-side twin of the client's canSettle session check: a stale
      // or raced client must not settle a thread whose session is coming
      // alive or working.
      if (thread.session?.status === "starting" || thread.session?.status === "running") {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} has an active session and cannot be settled`,
          }),
        );
      }
      // Pending approval / user-input requests are blocked-on-you work: a
      // raced or stale client must not park them behind a settled override
      // that would surface only after the request resolves.
      if (hasOpenBlockingRequest(thread)) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} has a pending approval or user-input request and cannot be settled`,
          }),
        );
      }
      const occurredAt = yield* nowIso;
      // Settling inside the adoption window would hide just-requested work.
      if (threadHasQueuedTurnStart(thread, occurredAt)) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} has a queued turn start and cannot be settled`,
          }),
        );
      }
      // Settling an already-settled thread re-emits with the original
      // settledAt: the engine rejects zero-event commands, and bulk-settle /
      // double-click must stay silent no-ops rather than surface errors.
      const alreadySettled = thread.settledOverride === "settled" && thread.settledAt !== null;
      const settledEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.settled" as const,
        payload: {
          threadId: command.threadId,
          settledAt: alreadySettled ? thread.settledAt : occurredAt,
          // A re-emission is a projected no-op: keep the existing updatedAt
          // so duplicate settles neither rewind nor churn ordering. A fresh
          // settle stamps the command time.
          updatedAt: alreadySettled ? thread.updatedAt : occurredAt,
        },
      };
      // Settling is "I'm done with this": clear states that would keep the
      // row pinned or snoozed instead of showing the new settled state.
      const companionEvents: Array<Omit<OrchestrationEvent, "sequence">> = [];
      if (thread.pinnedAt != null) {
        companionEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.unpinned" as const,
          payload: {
            threadId: command.threadId,
            updatedAt: occurredAt,
          },
        });
      }
      if (thread.snoozedUntil != null) {
        companionEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.unsnoozed",
          payload: {
            threadId: command.threadId,
            reason: "user",
            updatedAt: occurredAt,
          },
        });
      }
      return companionEvents.length > 0 ? [settledEvent, ...companionEvents] : settledEvent;
    }

    case "thread.unsettle": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Idempotent by re-emission (see thread.settle): reducing the event a
      // second time lands on the same override state. A re-emission keeps
      // the existing updatedAt so duplicates do not churn ordering.
      const alreadyPinnedActive = thread.settledOverride === "active";
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unsettled",
        payload: {
          threadId: command.threadId,
          reason: command.reason,
          updatedAt: alreadyPinnedActive ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.snooze": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      // A wake time in the past would create a thread that is snoozed and
      // woken at once — the row would never leave the inbox but still carry
      // snooze state. Reject instead of silently normalizing. The negated
      // comparison also catches unparseable wake times (IsoDateTime is
      // structurally just a string): NaN fails every comparison, and an
      // unparseable snoozedUntil must never persist.
      if (!(Date.parse(command.snoozedUntil) > Date.parse(occurredAt))) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} snooze wake time ${command.snoozedUntil} is not in the future`,
          }),
        );
      }
      // Blocked-on-you work must not be snoozed away: a pending approval or
      // user-input request is the agent waiting on the user, and hiding it
      // defeats the request. (A running session IS snoozable — snooze only
      // affects visibility, never the agent.)
      if (hasOpenBlockingRequest(thread)) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} has a pending approval or user-input request and cannot be snoozed`,
          }),
        );
      }
      // A queued turn start — a user message no turn has adopted yet — is
      // invisible pending work: no session, no pending flags. Snoozing in
      // that window would hide a just-requested turn exactly the way settle
      // would.
      if (threadHasQueuedTurnStart(thread, occurredAt)) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} has a queued turn start and cannot be snoozed`,
          }),
        );
      }
      // Re-snoozing an already-snoozed thread to the SAME wake time is a
      // duplicate (double-click, raced clients): re-emit with the original
      // timestamps so the projection is a no-op. A different wake time is a
      // real change and stamps fresh.
      const existingSnoozedAt =
        thread.snoozedUntil === command.snoozedUntil && thread.snoozedAt != null
          ? thread.snoozedAt
          : null;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.snoozed",
        payload: {
          threadId: command.threadId,
          snoozedUntil: command.snoozedUntil,
          snoozedAt: existingSnoozedAt ?? occurredAt,
          updatedAt: existingSnoozedAt !== null ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.unsnooze": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Idempotent by re-emission (see thread.settle): waking a thread that
      // is not snoozed lands on the same null state without churning
      // updatedAt.
      const alreadyAwake = thread.snoozedUntil == null;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unsnoozed",
        payload: {
          threadId: command.threadId,
          reason: command.reason,
          updatedAt: alreadyAwake ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.pin": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      // Re-pinning an already-pinned thread is a duplicate (double-click,
      // raced clients): re-emit with the original timestamps so the
      // projection is a no-op. Pinning has no lifecycle invariants — a pin
      // only ever promotes visibility, so it can never hide pending work.
      const existingPinnedAt = thread.pinnedAt ?? null;
      const pinnedEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.pinned" as const,
        payload: {
          threadId: command.threadId,
          pinnedAt: existingPinnedAt ?? occurredAt,
          // A fresh pin takes the client's slot in the arranged order; on a
          // re-pin the existing key wins so raced duplicates cannot move a
          // thread the user already placed.
          ...(existingPinnedAt === null && command.orderKey !== undefined
            ? { pinOrderKey: command.orderKey }
            : {}),
          updatedAt: existingPinnedAt !== null ? thread.updatedAt : occurredAt,
        },
      };
      // Pinning is a promotion: it clears the parked states rather than
      // silently outranking them. An explicit settle un-settles (reason
      // "user", same override the un-settle button stamps), and a snooze's
      // return ticket is spent — the thread is on top NOW, not on Tuesday.
      const promotionEvents: Array<Omit<OrchestrationEvent, "sequence">> = [];
      if (thread.settledOverride === "settled") {
        promotionEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.unsettled",
          payload: {
            threadId: command.threadId,
            reason: "user",
            updatedAt: occurredAt,
          },
        });
      }
      if (thread.snoozedUntil != null) {
        promotionEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.unsnoozed",
          payload: {
            threadId: command.threadId,
            reason: "user",
            updatedAt: occurredAt,
          },
        });
      }
      return promotionEvents.length > 0 ? [pinnedEvent, ...promotionEvents] : pinnedEvent;
    }

    case "thread.unpin": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Idempotent by re-emission (see thread.settle): unpinning a thread
      // that is not pinned lands on the same null state without churning
      // updatedAt.
      const alreadyUnpinned = thread.pinnedAt == null;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unpinned",
        payload: {
          threadId: command.threadId,
          updatedAt: alreadyUnpinned ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.pin.reorder": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Only pinned threads have a slot in the arranged order. Rejecting
      // (rather than silently pinning) keeps a raced reorder-after-unpin
      // from resurrecting a pin the user just cleared.
      if (thread.pinnedAt == null) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} is not pinned and cannot be reordered`,
          }),
        );
      }
      // Idempotent by re-emission (see thread.settle): a duplicate drop on
      // the same slot keeps the existing updatedAt so it projects as a no-op.
      const keyUnchanged = thread.pinOrderKey === command.orderKey;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.pin-reordered",
        payload: {
          threadId: command.threadId,
          orderKey: command.orderKey,
          updatedAt: keyUnchanged ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.meta.update": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const branch =
        command.branch !== undefined &&
        command.expectedBranch !== undefined &&
        thread.branch !== command.expectedBranch
          ? thread.branch
          : command.branch;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.regenerateTitle === true
            ? {
                regenerateTitle: true as const,
                previousTitle: thread.title,
                titleRegeneration: {
                  requestId: command.commandId,
                  startedAt: occurredAt,
                },
              }
            : {}),
          ...(command.title !== undefined && thread.titleRegeneration != null
            ? { titleRegeneration: null }
            : {}),
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.routingMode !== undefined
            ? { routingMode: command.routingMode }
            : command.modelSelection !== undefined
              ? { routingMode: "manual" as const }
              : {}),
          ...(command.efficiencyTier !== undefined
            ? { efficiencyTier: command.efficiencyTier }
            : {}),
          ...(branch !== undefined ? { branch } : {}),
          ...(command.worktreePath !== undefined ? { worktreePath: command.worktreePath } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.title.regeneration.complete": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const requestIsCurrent = thread.titleRegeneration?.requestId === command.requestId;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          ...(requestIsCurrent && command.title !== undefined ? { title: command.title } : {}),
          ...(requestIsCurrent ? { titleRegeneration: null } : {}),
          updatedAt: requestIsCurrent ? occurredAt : thread.updatedAt,
        },
      };
    }

    case "thread.runtime-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.runtime-mode-set",
        payload: {
          threadId: command.threadId,
          runtimeMode: command.runtimeMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.interaction-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.interaction-mode-set",
        payload: {
          threadId: command.threadId,
          interactionMode: command.interactionMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.turn.start": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (targetThread.sandbox?.controller.kind === "human") {
        return yield* sandboxInvariant(
          command.type,
          `thread ${command.threadId} is controlled by an active human takeover lease`,
        );
      }
      if (
        targetThread.sandbox != null &&
        !["unprovisioned", "ready", "failed"].includes(targetThread.sandbox.lifecycle)
      ) {
        return yield* sandboxInvariant(
          command.type,
          `thread ${command.threadId} sandbox is ${targetThread.sandbox.lifecycle}`,
        );
      }
      const sourceProposedPlan = command.sourceProposedPlan;
      const sourceThread = sourceProposedPlan
        ? yield* requireThread({
            readModel,
            command,
            threadId: sourceProposedPlan.threadId,
          })
        : null;
      const sourcePlan =
        sourceProposedPlan && sourceThread
          ? sourceThread.proposedPlans.find((entry) => entry.id === sourceProposedPlan.planId)
          : null;
      if (sourceProposedPlan && !sourcePlan) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan.planId}' does not exist on thread '${sourceProposedPlan.threadId}'.`,
        });
      }
      if (sourceThread && sourceThread.projectId !== targetThread.projectId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan?.planId}' belongs to thread '${sourceThread.id}' in a different project.`,
        });
      }
      const userMessageEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          role: "user",
          text: command.message.text,
          attachments: command.message.attachments,
          turnId: null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const turnStartRequestedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        causationEventId: userMessageEvent.eventId,
        type: "thread.turn-start-requested",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.routingMode !== undefined ? { routingMode: command.routingMode } : {}),
          ...(command.efficiencyTier !== undefined
            ? { efficiencyTier: command.efficiencyTier }
            : {}),
          ...(command.efficiencyDecision !== undefined
            ? { efficiencyDecision: command.efficiencyDecision }
            : {}),
          ...(command.retryOfTurnId !== undefined ? { retryOfTurnId: command.retryOfTurnId } : {}),
          ...(command.titleSeed !== undefined ? { titleSeed: command.titleSeed } : {}),
          runtimeMode: targetThread.runtimeMode,
          interactionMode: targetThread.interactionMode,
          ...(sourceProposedPlan !== undefined ? { sourceProposedPlan } : {}),
          createdAt: command.createdAt,
        },
      };
      // Real activity resets ANY override: it wakes an explicitly settled
      // thread, and it clears a keep-active pin back to neutral so the
      // thread can auto-settle again after this burst of work goes stale.
      // A snooze clears the same way — sending a message to a snoozed
      // thread is the user re-engaging, so the return ticket is spent.
      const lifecycleResetEvents: Array<Omit<OrchestrationEvent, "sequence">> = [];
      if (targetThread.settledOverride !== null) {
        lifecycleResetEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "thread.unsettled",
          payload: {
            threadId: command.threadId,
            reason: "activity",
            updatedAt: command.createdAt,
          },
        });
      }
      if (targetThread.snoozedUntil != null) {
        lifecycleResetEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "thread.unsnoozed",
          payload: {
            threadId: command.threadId,
            reason: "activity",
            updatedAt: command.createdAt,
          },
        });
      }
      return [...lifecycleResetEvents, userMessageEvent, turnStartRequestedEvent];
    }

    case "thread.turn.resume": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Re-issue an interrupted turn for the existing user message (no duplicate
      // `thread.message-sent`). No-op if the referenced message is gone or is not a
      // user message — auto-resume should only continue a genuine user turn.
      const userMessage = targetThread.messages.find(
        (message) => message.id === command.messageId && message.role === "user",
      );
      if (!userMessage) {
        return [];
      }
      const resumeTurnStartRequestedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.turn-start-requested",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          // Carry the interrupted turn's model selection so the restarted session
          // resolves to the same provider instance/model and recovers its cursor.
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          // Carry the interrupted turn's source proposed-plan reference so a
          // resumed plan-implementation turn re-associates with its plan (the
          // reactor's turn.started marks the plan implemented from this field).
          ...(command.sourceProposedPlan !== undefined
            ? { sourceProposedPlan: command.sourceProposedPlan }
            : {}),
          runtimeMode: targetThread.runtimeMode,
          interactionMode: targetThread.interactionMode,
          createdAt: command.createdAt,
        },
      };
      return [resumeTurnStartRequestedEvent];
    }

    case "thread.turn.interrupt": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Resolve the turn to mark interrupted to the thread's active turn,
      // preferring it over any client-supplied turnId. The provider reactor
      // interrupts strictly by session ("orchestration turn ids are not provider
      // turn ids, so interrupt by session"), i.e. whichever turn is currently
      // running — never the id in the command. A web/mobile client sends the
      // activeTurnId from its latest snapshot, which can be stale if a steer
      // started a newer turn before this command was processed; honoring that
      // stale id would mark the wrong (already-finished) turn interrupted while
      // the running turn's row stays `running`, so the ensuing session exit would
      // auto-resume a turn the user actually interrupted. Falling back to the
      // command's turnId only when the session has no active turn keeps the
      // contract's id-less interrupt ("interrupt whatever is running") working;
      // left unresolved the event carries no turnId and ProjectionPipeline
      // ignores it (its handler returns early on `turnId === undefined`).
      const resolvedTurnId = thread.session?.activeTurnId ?? command.turnId ?? undefined;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.turn-interrupt-requested",
        payload: {
          threadId: command.threadId,
          ...(resolvedTurnId !== undefined ? { turnId: resolvedTurnId } : {}),
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.approval.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        })),
        type: "thread.approval-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          decision: command.decision,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.user-input.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        })),
        type: "thread.user-input-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          answers: command.answers,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.checkpoint.revert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.checkpoint-revert-requested",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.stop": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Settle-cleanup stops are conditional: between the settle landing and
      // this command, another client may have re-engaged the thread (a turn
      // start unsettles it and brings the session alive). Commands are
      // decided serially against this read model, so checking here — not in
      // the dispatcher's pre-settle snapshot — closes that race.
      if (command.onlyIfSettled === true) {
        const sessionComingAlive =
          thread.session?.status === "starting" || thread.session?.status === "running";
        if (
          thread.settledOverride !== "settled" ||
          sessionComingAlive ||
          threadHasQueuedTurnStart(thread, command.createdAt)
        ) {
          return yield* Effect.fail(
            new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: `thread ${command.threadId} was re-engaged after settle; skipping session stop`,
            }),
          );
        }
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.session-stop-requested",
        payload: {
          threadId: command.threadId,
          // Carried through rather than defaulted to this event's own sequence,
          // because the two coincide only for a stop the user pressed. An
          // escalated stop must keep the narrower cutoff it was handed; see
          // `ThreadSessionStopCommand.canceledThroughSequence`.
          ...(command.canceledThroughSequence !== undefined
            ? { canceledThroughSequence: command.canceledThroughSequence }
            : {}),
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.set": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const pendingTurnStartAdoption =
        command.pendingTurnStartAdoption ??
        (command.turnRequestSequence !== undefined ? "exact" : "none");
      const terminalTurnTransition =
        command.terminalTurnTransition ??
        (command.settledTurnId === undefined
          ? undefined
          : (() => {
              switch (command.session.status) {
                case "idle":
                case "ready":
                  return { turnId: command.settledTurnId, state: "completed" } as const;
                case "error":
                  return { turnId: command.settledTurnId, state: "error" } as const;
                case "interrupted":
                case "stopped":
                  return { turnId: command.settledTurnId, state: "interrupted" } as const;
                case "starting":
                case "running":
                  return undefined;
              }
            })());
      const sessionSetEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {},
        })),
        type: "thread.session-set",
        payload: {
          threadId: command.threadId,
          session: command.session,
          pendingTurnStartAdoption,
          ...(command.turnRequestSequence !== undefined
            ? { turnRequestSequence: command.turnRequestSequence }
            : {}),
          ...(command.settledTurnId !== undefined ? { settledTurnId: command.settledTurnId } : {}),
          ...(terminalTurnTransition !== undefined ? { terminalTurnTransition } : {}),
          ...(command.terminalTurnTransitions !== undefined
            ? { terminalTurnTransitions: command.terminalTurnTransitions }
            : {}),
        },
      };
      const isSessionActivity =
        command.session.status === "starting" || command.session.status === "running";
      if (thread.settledOverride === null || !isSessionActivity) {
        return sessionSetEvent;
      }
      const unsettledEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.unsettled",
        payload: {
          threadId: command.threadId,
          reason: "activity",
          updatedAt: command.createdAt,
        },
      };
      return [unsettledEvent, sessionSetEvent];
    }

    case "thread.turn-start.fold": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.turn-start-folded",
        payload: {
          threadId: command.threadId,
          turnRequestSequence: command.turnRequestSequence,
          turnId: command.turnId,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.message.assistant.delta": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: command.delta,
          turnId: command.turnId ?? null,
          streaming: true,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.message.assistant.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: "",
          turnId: command.turnId ?? null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.proposed-plan.upsert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.proposed-plan-upserted",
        payload: {
          threadId: command.threadId,
          proposedPlan: command.proposedPlan,
        },
      };
    }

    case "thread.turn.diff.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.turn-diff-completed",
        payload: {
          threadId: command.threadId,
          turnId: command.turnId,
          checkpointTurnCount: command.checkpointTurnCount,
          checkpointRef: command.checkpointRef,
          status: command.status,
          files: command.files,
          assistantMessageId: command.assistantMessageId ?? null,
          completedAt: command.completedAt,
        },
      };
    }

    case "thread.revert.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.reverted",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
        },
      };
    }

    case "thread.activity.append": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const requestId =
        typeof command.activity.payload === "object" &&
        command.activity.payload !== null &&
        "requestId" in command.activity.payload &&
        typeof (command.activity.payload as { requestId?: unknown }).requestId === "string"
          ? ((command.activity.payload as { requestId: string })
              .requestId as OrchestrationEvent["metadata"]["requestId"])
          : undefined;
      const activityAppendedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          ...(requestId !== undefined ? { metadata: { requestId } } : {}),
        })),
        type: "thread.activity-appended",
        payload: {
          threadId: command.threadId,
          activity: command.activity,
        },
      };
      // An approval or user-input request is blocked-on-you work — it must
      // never stay hidden inside a settled slim row.
      const wakesSettledThread =
        command.activity.kind === "approval.requested" ||
        command.activity.kind === "user-input.requested";
      // Real activity resets ANY override (settled wakes, active unpins).
      if (thread.settledOverride === null || !wakesSettledThread) {
        return activityAppendedEvent;
      }
      const unsettledEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.unsettled",
        payload: {
          threadId: command.threadId,
          reason: "activity",
          updatedAt: command.createdAt,
        },
      };
      return [unsettledEvent, activityAppendedEvent];
    }

    case "sandbox.branch-export": {
      const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
      if (thread.sandbox === null || thread.sandbox === undefined) {
        return yield* sandboxInvariant(command.type, `thread ${command.threadId} has no sandbox`);
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "sandbox.branch-export-requested",
        payload: { threadId: command.threadId },
      };
    }

    case "sandbox.worker.spawn": {
      yield* requireThread({ readModel, command, threadId: command.parentThreadId });
      yield* requireThreadAbsent({ readModel, command, threadId: command.childThreadId });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.parentThreadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "sandbox.worker-spawn-requested",
        payload: {
          parentThreadId: command.parentThreadId,
          childThreadId: command.childThreadId,
          task: command.task,
          inheritedCommit: command.inheritedCommit,
          ...(command.inheritedPatch === undefined
            ? {}
            : { inheritedPatch: command.inheritedPatch }),
          ...(command.config === undefined ? {} : { config: command.config }),
          branchName: command.branchName,
        },
      };
    }

    case "sandbox.worker.status":
    case "sandbox.worker.message":
    case "sandbox.worker.stop": {
      yield* requireThread({ readModel, command, threadId: command.parentThreadId });
      const child = yield* requireThread({ readModel, command, threadId: command.childThreadId });
      if (child.sandboxBranch?.parentThreadId !== command.parentThreadId) {
        return yield* sandboxInvariant(
          command.type,
          `thread ${command.childThreadId} is not a worker of ${command.parentThreadId}`,
        );
      }
      const suffix = command.type.slice("sandbox.worker.".length);
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.parentThreadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: `sandbox.worker-${suffix}-requested` as
          | "sandbox.worker-status-requested"
          | "sandbox.worker-message-requested"
          | "sandbox.worker-stop-requested",
        payload: {
          parentThreadId: command.parentThreadId,
          childThreadId: command.childThreadId,
          ...(command.type === "sandbox.worker.message" ? { message: command.message } : {}),
          ...(command.type === "sandbox.worker.stop" && command.reason !== undefined
            ? { reason: command.reason }
            : {}),
        },
      };
    }

    case "sandbox.provision": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const current = thread.sandbox ?? null;
      if (current !== null && current.lifecycle !== "unprovisioned") {
        return yield* sandboxInvariant(
          command.type,
          `thread ${command.threadId} sandbox is not unprovisioned`,
        );
      }
      const branch = current?.branch ?? command.branch;
      if (branch === undefined) {
        return {
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "sandbox.provision-requested",
          payload: {
            threadId: command.threadId,
            ...(command.config === undefined ? {} : { config: command.config }),
          },
        };
      }
      const config = command.config ?? thread.sandboxConfig ?? {};
      const currentWithoutFailure =
        current === null
          ? {
              branch,
              limits: config.limits ?? DEFAULT_SANDBOX_RESOURCE_LIMITS,
              desktop: {
                status: "unavailable" as const,
                resolution: config.desktop ?? DEFAULT_SANDBOX_DESKTOP_CONFIG,
              },
              services: [],
              controller: { kind: "none" as const },
              createdAt: command.createdAt,
              lastActiveAt: command.createdAt,
            }
          : (({ failure: _failure, ...rest }) => rest)(current);
      const sandbox: SandboxState = {
        ...currentWithoutFailure,
        lifecycle: "provisioning",
        runtime: config.runtime ?? "docker",
        limits: config.limits ?? currentWithoutFailure.limits,
        desktop: {
          status: "starting",
          resolution:
            config.desktop ??
            currentWithoutFailure.desktop.resolution ??
            DEFAULT_SANDBOX_DESKTOP_CONFIG,
        },
        lastActiveAt: command.createdAt,
      };
      const event: SandboxEvent = {
        type: "sandbox.provisioning-started",
        threadId: command.threadId,
        occurredAt: command.createdAt,
      };
      return yield* sandboxTransition(
        command.threadId,
        command.commandId,
        event.type,
        event,
        sandbox,
      );
    }

    case "sandbox.provision.ready": {
      const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
      const current = thread.sandbox ?? null;
      if (current?.lifecycle !== "provisioning") {
        return yield* sandboxInvariant(
          command.type,
          `thread ${command.threadId} sandbox is not provisioning`,
        );
      }
      const { failure: _failure, ...currentWithoutFailure } = current;
      const sandbox: SandboxState = {
        ...currentWithoutFailure,
        lifecycle: "ready",
        sandboxId: command.sandboxId,
        runtime: command.runtime,
        runtimeRef: command.runtimeRef,
        desktop: { ...current.desktop, status: "ready", readyAt: command.createdAt },
        lastActiveAt: command.createdAt,
      };
      const event: SandboxEvent = {
        type: "sandbox.ready",
        threadId: command.threadId,
        occurredAt: command.createdAt,
        sandboxId: command.sandboxId,
        runtime: command.runtime,
        runtimeRef: command.runtimeRef,
      };
      return yield* sandboxTransition(
        command.threadId,
        command.commandId,
        event.type,
        event,
        sandbox,
      );
    }

    case "sandbox.operation.fail": {
      const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
      const current = thread.sandbox ?? null;
      if (current === null || ["stopped", "expired", "deleted"].includes(current.lifecycle)) {
        return yield* sandboxInvariant(
          command.type,
          `thread ${command.threadId} sandbox cannot fail from its current lifecycle`,
        );
      }
      const sandbox: SandboxState = {
        ...current,
        lifecycle: "failed",
        failure: command.failure,
        lastActiveAt: command.createdAt,
      };
      const event: SandboxEvent = {
        type: "sandbox.failed",
        threadId: command.threadId,
        occurredAt: command.createdAt,
        failure: command.failure,
      };
      return yield* sandboxTransition(
        command.threadId,
        command.commandId,
        event.type,
        event,
        sandbox,
      );
    }

    case "sandbox.pause": {
      const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
      const current = thread.sandbox ?? null;
      if (current?.lifecycle !== "ready" || current.controller.kind === "human") {
        return yield* sandboxInvariant(
          command.type,
          `thread ${command.threadId} sandbox cannot be paused`,
        );
      }
      const sandbox: SandboxState = {
        ...current,
        lifecycle: "paused",
        pauseReason: command.reason,
        controller: { kind: "none" },
        lastActiveAt: command.createdAt,
      };
      const event: SandboxEvent = {
        type: "sandbox.paused",
        threadId: command.threadId,
        occurredAt: command.createdAt,
        reason: command.reason,
      };
      return yield* sandboxTransition(
        command.threadId,
        command.commandId,
        event.type,
        event,
        sandbox,
      );
    }

    case "sandbox.takeover": {
      const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
      const current = thread.sandbox ?? null;
      if (current === null || !["ready", "paused"].includes(current.lifecycle)) {
        return yield* sandboxInvariant(
          command.type,
          `thread ${command.threadId} sandbox is not available for takeover`,
        );
      }
      if (current.controller.kind === "human") {
        return yield* sandboxInvariant(
          command.type,
          `thread ${command.threadId} already has an active human takeover lease`,
        );
      }
      const sandbox: SandboxState = {
        ...current,
        lifecycle: "pausing",
        pauseReason: "human-takeover",
        controller: { kind: "none" },
        lastActiveAt: command.createdAt,
      };
      const event: SandboxEvent = {
        type: "sandbox.takeover-requested",
        threadId: command.threadId,
        occurredAt: command.createdAt,
        sessionId: command.sessionId,
      };
      return yield* sandboxTransition(
        command.threadId,
        command.commandId,
        event.type,
        event,
        sandbox,
      );
    }

    case "sandbox.takeover.complete": {
      const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
      const current = thread.sandbox ?? null;
      if (current?.lifecycle !== "pausing" || current.pauseReason !== "human-takeover") {
        return yield* sandboxInvariant(
          command.type,
          `thread ${command.threadId} sandbox is not awaiting takeover`,
        );
      }
      const controller = {
        kind: "human" as const,
        leaseId: String(command.commandId),
        sessionId: command.sessionId,
        acquiredAt: command.createdAt,
      };
      const sandbox: SandboxState = {
        ...current,
        lifecycle: "paused",
        controller,
        lastActiveAt: command.createdAt,
      };
      const event: SandboxEvent = {
        type: "sandbox.takeover-acquired",
        threadId: command.threadId,
        occurredAt: command.createdAt,
        controller,
      };
      return yield* sandboxTransition(
        command.threadId,
        command.commandId,
        event.type,
        event,
        sandbox,
      );
    }

    case "sandbox.resume": {
      const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
      const current = thread.sandbox ?? null;
      if (current?.lifecycle !== "paused") {
        return yield* sandboxInvariant(
          command.type,
          `thread ${command.threadId} sandbox is not paused`,
        );
      }
      if (current.controller.kind === "human" && command.leaseId !== current.controller.leaseId) {
        return yield* sandboxInvariant(
          command.type,
          `thread ${command.threadId} resume does not hold the active takeover lease`,
        );
      }
      const summary = command.takeoverSummary ?? "Sandbox resumed without manual changes.";
      const { pauseReason: _pauseReason, ...currentWithoutPauseReason } = current;
      const sandbox: SandboxState = {
        ...currentWithoutPauseReason,
        lifecycle: "ready",
        controller: { kind: "none" },
        lastActiveAt: command.createdAt,
      };
      const event: SandboxEvent = {
        type: "sandbox.resumed",
        threadId: command.threadId,
        occurredAt: command.createdAt,
        summary,
      };
      return yield* sandboxTransition(
        command.threadId,
        command.commandId,
        event.type,
        event,
        sandbox,
      );
    }

    case "sandbox.expire":
    case "sandbox.stop": {
      const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
      const current = thread.sandbox ?? null;
      if (current === null || ["stopped", "expired", "deleted"].includes(current.lifecycle)) {
        return yield* sandboxInvariant(
          command.type,
          `thread ${command.threadId} sandbox is already terminal`,
        );
      }
      if (current.controller.kind === "human" && command.type !== "sandbox.expire") {
        return yield* sandboxInvariant(
          command.type,
          `thread ${command.threadId} sandbox has an active takeover lease`,
        );
      }
      const expired = command.type === "sandbox.expire";
      const sandbox: SandboxState = {
        ...current,
        lifecycle: "stopping",
        controller: { kind: "none" },
        lastActiveAt: command.createdAt,
      };
      const event: SandboxEvent = {
        type: "sandbox.stopping",
        threadId: command.threadId,
        occurredAt: command.createdAt,
        expired,
      };
      return yield* sandboxTransition(
        command.threadId,
        command.commandId,
        event.type,
        event,
        sandbox,
      );
    }

    case "sandbox.stop.complete": {
      const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
      const current = thread.sandbox ?? null;
      if (current?.lifecycle !== "stopping") {
        return yield* sandboxInvariant(
          command.type,
          `thread ${command.threadId} sandbox is not stopping`,
        );
      }
      const sandbox: SandboxState = {
        ...current,
        lifecycle: command.expired ? "expired" : "stopped",
        lastActiveAt: command.createdAt,
      };
      const event: SandboxEvent = {
        type: command.expired ? "sandbox.expired" : "sandbox.stopped",
        threadId: command.threadId,
        occurredAt: command.createdAt,
      };
      return yield* sandboxTransition(
        command.threadId,
        command.commandId,
        event.type,
        event,
        sandbox,
      );
    }

    case "sandbox.reconcile.result": {
      yield* requireThread({ readModel, command, threadId: command.threadId });
      const event: SandboxEvent = {
        type: "sandbox.reconciled",
        threadId: command.threadId,
        occurredAt: command.createdAt,
        disposition: command.disposition,
      };
      return yield* sandboxTransition(
        command.threadId,
        command.commandId,
        event.type,
        event,
        command.sandbox,
      );
    }

    case "sandbox.branch-export.result": {
      const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
      const current = thread.sandbox ?? null;
      if (current === null)
        return yield* sandboxInvariant(command.type, `thread ${command.threadId} has no sandbox`);
      const event: SandboxEvent = {
        type: "sandbox.branch-exported",
        threadId: command.threadId,
        occurredAt: command.createdAt,
        branchName: command.branchName,
        headCommit: command.headCommit,
        artifactId: command.artifactId,
        bundleSha256: command.bundleSha256,
      };
      return yield* sandboxTransition(command.threadId, command.commandId, event.type, event, {
        ...current,
        lastActiveAt: command.createdAt,
      });
    }

    default: {
      command satisfies never;
      const fallback = command as never as { type: string };
      return yield* new OrchestrationCommandInvariantError({
        commandType: fallback.type,
        detail: `Unknown command type: ${fallback.type}`,
      });
    }
  }
});
