import { ConnectionId, SalesProspectId, SpaceId } from "@command-center/core";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";

import * as CommandCenterService from "../Service.ts";
import * as ExternalProspectorConnector from "../ExternalProspectorConnector.ts";
import * as GoogleReadConnector from "../GoogleReadConnector.ts";
import { withSalesDraftCreateLock } from "../SalesDraftCreateCoordinator.ts";
import * as SalesPipeline from "../SalesPipeline.ts";
import * as SalesProspectorRunner from "../SalesProspectorRunner.ts";

type JsonObject = Readonly<Record<string, Schema.Json>>;

export interface SalesAutomationActionRequest {
  readonly operation: string;
  readonly spaceId: string;
  readonly config: JsonObject;
}

export type SalesAutomationActionExecutor = (
  input: SalesAutomationActionRequest,
) => Effect.Effect<Schema.Json, string>;

export interface SalesAutomationActionDependencies {
  readonly commandCenter: CommandCenterService.CommandCenterServiceShape;
  readonly google: GoogleReadConnector.GoogleReadConnectorShape;
  readonly sales: SalesPipeline.SalesPipelineShape;
  readonly prospector: ExternalProspectorConnector.ExternalProspectorConnectorShape;
  readonly runner: SalesProspectorRunner.SalesProspectorRunnerShape;
}

const boundedInt = (value: unknown, fallback: number, maximum: number): number =>
  typeof value === "number" && Number.isInteger(value) && value > 0
    ? Math.min(value, maximum)
    : fallback;

const requiredString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const asRecord = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;

const toFailure = (cause: unknown): string =>
  cause instanceof Error
    ? cause.message
    : typeof cause === "string"
      ? cause
      : "Sales action failed.";

/** Strip optional undefined fields before data crosses the automation boundary. */
const toJson = (value: unknown): Schema.Json => JSON.parse(JSON.stringify(value)) as Schema.Json;

const gmailEvidenceIds = (
  value: unknown,
): { readonly messageId?: string; readonly threadId?: string } => {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = gmailEvidenceIds(entry);
      if (found.messageId !== undefined || found.threadId !== undefined) return found;
    }
    return {};
  }
  const record = asRecord(value);
  if (record === undefined) return {};
  const messageId =
    typeof record.messageId === "string"
      ? record.messageId
      : typeof record.id === "string"
        ? record.id
        : undefined;
  const threadId = typeof record.threadId === "string" ? record.threadId : undefined;
  if (messageId !== undefined || threadId !== undefined) {
    return {
      ...(messageId === undefined ? {} : { messageId }),
      ...(threadId === undefined ? {} : { threadId }),
    };
  }
  for (const entry of Object.values(record)) {
    const found = gmailEvidenceIds(entry);
    if (found.messageId !== undefined || found.threadId !== undefined) return found;
  }
  return {};
};

interface GeneratedDraft {
  readonly prospectId: string;
  readonly subject: string;
  readonly body: string;
  readonly evidenceReferences: ReadonlyArray<string>;
}

/** Accept only the narrow JSON envelope produced by the copywriting agent. */
const generatedDrafts = (value: unknown): ReadonlyArray<GeneratedDraft> | undefined => {
  const decoded =
    typeof value === "string"
      ? (() => {
          try {
            const trimmed = value.trim();
            const json =
              trimmed.startsWith("```") && trimmed.endsWith("```")
                ? trimmed.replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "")
                : trimmed;
            return JSON.parse(json) as unknown;
          } catch {
            return undefined;
          }
        })()
      : value;
  const record = asRecord(decoded);
  const rawDrafts = record?.drafts;
  if (!Array.isArray(rawDrafts) || rawDrafts.length > 15) return undefined;
  const drafts: GeneratedDraft[] = [];
  for (const candidate of rawDrafts) {
    const entry = asRecord(candidate);
    const prospectId = requiredString(entry?.prospectId);
    const subject = requiredString(entry?.subject);
    const body = requiredString(entry?.body);
    const evidenceReferences = Array.isArray(entry?.evidenceReferences)
      ? entry!.evidenceReferences.filter(
          (reference): reference is string => requiredString(reference) !== undefined,
        )
      : [];
    if (
      prospectId === undefined ||
      subject === undefined ||
      body === undefined ||
      evidenceReferences.length === 0
    ) {
      return undefined;
    }
    drafts.push({ prospectId, subject, body, evidenceReferences });
  }
  return drafts;
};

const dedicatedDraftConnection = Effect.fn("SalesAutomationActions.dedicatedDraftConnection")(
  function* (commandCenter: CommandCenterService.CommandCenterServiceShape, spaceId: string) {
    const candidates = (yield* commandCenter.queryConnections({
      spaceId: SpaceId.make(spaceId),
    })).connections.filter((connection) =>
      connection.capabilities.includes("cc.connections.google.gmail.drafts.create"),
    );
    if (candidates.length !== 1) {
      return yield* Effect.fail(
        "The sales Space must have exactly one enabled Gmail draft connection.",
      );
    }
    return candidates[0]!;
  },
);

const createDrafts = Effect.fn("SalesAutomationActions.createDrafts")(function* (
  dependencies: SalesAutomationActionDependencies,
  input: SalesAutomationActionRequest,
) {
  const drafts = generatedDrafts(input.config.drafts);
  const campaignVersion = requiredString(input.config.campaignVersion);
  if (drafts === undefined || campaignVersion === undefined) {
    return yield* Effect.fail(
      "The copywriting step did not return the required draft JSON envelope.",
    );
  }
  const connection = yield* dedicatedDraftConnection(dependencies.commandCenter, input.spaceId);
  let created = 0;
  let reconciled = 0;
  let skipped = 0;
  const failures: string[] = [];
  for (const draft of drafts) {
    const outcome = yield* withSalesDraftCreateLock(
      { spaceId: input.spaceId, requestId: `initial:${draft.prospectId}:${campaignVersion}` },
      Effect.gen(function* () {
        const prepared = yield* dependencies.sales.prepareAutomatedDraft({
          spaceId: SpaceId.make(input.spaceId),
          prospectId: SalesProspectId.make(draft.prospectId),
          subject: draft.subject,
          body: draft.body,
          evidenceReferences: draft.evidenceReferences,
          campaignStep: 0,
          campaignVersion,
          idempotencyKey: `initial:${draft.prospectId}:${campaignVersion}`,
          connectionId: connection.id,
        });
        if (prepared.request.status === "created") return { status: "reconciled" as const };
        const existing = yield* dependencies.google.findSalesDraft(prepared.request);
        const result =
          existing === undefined
            ? yield* dependencies.google.createSalesDraft(prepared.request)
            : { draftId: existing };
        yield* dependencies.sales.completeDraftCreate({
          requestId: prepared.request.id,
          spaceId: prepared.request.spaceId,
          payloadDigest: prepared.request.payloadDigest,
          draftId: result.draftId,
          reconciled: existing !== undefined,
        });
        return { status: existing === undefined ? ("created" as const) : ("reconciled" as const) };
      }).pipe(
        Effect.match({
          onFailure: (failure) => ({ status: "skipped" as const, failure: toFailure(failure) }),
          onSuccess: (value) => value,
        }),
      ),
    );
    if (outcome.status === "skipped") {
      skipped += 1;
      failures.push(outcome.failure);
    } else if (outcome.status === "reconciled") reconciled += 1;
    else created += 1;
  }
  return { attempted: drafts.length, created, reconciled, skipped, failures };
});

const reconcileGmail = Effect.fn("SalesAutomationActions.reconcileGmail")(function* (
  dependencies: SalesAutomationActionDependencies,
  input: SalesAutomationActionRequest,
) {
  const connectionId = requiredString(input.config.connectionId);
  if (connectionId === undefined)
    return yield* Effect.fail("Gmail reconciliation requires a connectionId.");
  const connections = (yield* dependencies.commandCenter.queryConnections({
    spaceId: SpaceId.make(input.spaceId),
  })).connections;
  if (
    !connections.some(
      (connection) =>
        connection.id === connectionId &&
        connection.capabilities.includes("cc.connections.google.gmail.read"),
    )
  ) {
    return yield* Effect.fail("The Gmail read connection is not enabled for this Space.");
  }

  // Bootstrap is deliberately part of deterministic reconciliation so the
  // historical Prospector drafts are preserved before any lifecycle decision.
  const current = yield* dependencies.sales.query({
    spaceId: SpaceId.make(input.spaceId),
    limit: 500,
  });
  const importedIds = new Set<string>(current.draftRequests.map((request) => request.id));
  const historical = yield* dependencies.prospector.loadHistoricalDrafts({
    spaceId: SpaceId.make(input.spaceId),
  });
  for (const record of historical) {
    if (importedIds.has(`prospector-send-${record.sourceSendId}`)) continue;
    const wasSent =
      record.sentAt !== undefined ||
      record.gmailMessageId !== undefined ||
      ["sent", "delivered", "opened", "replied", "bounced"].includes(record.status);
    const draftExists =
      !wasSent && record.gmailDraftId !== undefined
        ? yield* dependencies.google.salesDraftExists(
            { spaceId: SpaceId.make(input.spaceId), connectionId: ConnectionId.make(connectionId) },
            record.gmailDraftId,
          )
        : false;
    yield* dependencies.sales.importHistoricalDraft({
      ...record,
      proposal: { ...record.proposal, spaceId: SpaceId.make(input.spaceId) },
      connectionId,
      state: wasSent ? "contacted" : draftExists ? "drafted" : "declined",
    });
  }

  const snapshot = yield* dependencies.sales.query({
    spaceId: SpaceId.make(input.spaceId),
    stages: ["drafted", "contacted"],
    limit: 500,
  });
  const observedAt = DateTime.formatIso(yield* DateTime.now);
  let contacted = 0;
  let replied = 0;
  let bounced = 0;
  let deleted = 0;
  let followUpDrafted = 0;
  for (const prospect of snapshot.prospects) {
    if (prospect.contactEmail === undefined) continue;
    const latest = snapshot.draftRequests.find(
      (request) => request.prospectId === prospect.id && request.status === "created",
    );
    if (latest === undefined) continue;
    const safeSubject = latest.subject.replaceAll('"', "");
    const sentResult = yield* dependencies.google.read({
      operation: "gmail.search",
      spaceId: prospect.spaceId,
      connectionId: ConnectionId.make(connectionId),
      query: `in:sent to:${prospect.contactEmail} subject:"${safeSubject}" newer_than:30d`,
      limit: 10,
    });
    const sentEvidence = gmailEvidenceIds("data" in sentResult ? sentResult.data : undefined);
    const replyResult = yield* dependencies.google.read({
      operation: "gmail.search",
      spaceId: prospect.spaceId,
      connectionId: ConnectionId.make(connectionId),
      query: `in:inbox from:${prospect.contactEmail} newer_than:30d`,
      limit: 10,
    });
    const replyEvidence = gmailEvidenceIds("data" in replyResult ? replyResult.data : undefined);
    const bounceResult =
      prospect.stage === "contacted"
        ? yield* dependencies.google.read({
            operation: "gmail.search",
            spaceId: prospect.spaceId,
            connectionId: ConnectionId.make(connectionId),
            query: `in:anywhere (from:mailer-daemon OR from:postmaster) "${prospect.contactEmail}" newer_than:30d`,
            limit: 10,
          })
        : undefined;
    const bounceEvidence =
      bounceResult === undefined
        ? {}
        : gmailEvidenceIds("data" in bounceResult ? bounceResult.data : undefined);
    const draftStillExists =
      latest.gmailDraftId === undefined
        ? true
        : yield* dependencies.google.salesDraftExists(
            { spaceId: prospect.spaceId, connectionId: ConnectionId.make(connectionId) },
            latest.gmailDraftId,
          );
    const evidenceMessageId = replyEvidence.messageId ?? sentEvidence.messageId;
    const evidenceThreadId = replyEvidence.threadId ?? sentEvidence.threadId;
    const reconciled = yield* dependencies.sales.reconcileGmailEvidence({
      prospectId: prospect.id,
      spaceId: prospect.spaceId,
      sent: sentEvidence.messageId !== undefined || sentEvidence.threadId !== undefined,
      replied: replyEvidence.messageId !== undefined || replyEvidence.threadId !== undefined,
      bounced: bounceEvidence.messageId !== undefined || bounceEvidence.threadId !== undefined,
      deleted:
        !draftStillExists &&
        sentEvidence.messageId === undefined &&
        sentEvidence.threadId === undefined,
      draftRequestId: latest.id,
      campaignStep: latest.campaignStep,
      ...(evidenceMessageId === undefined ? {} : { messageId: evidenceMessageId }),
      ...(evidenceThreadId === undefined ? {} : { threadId: evidenceThreadId }),
      observedAt,
    });
    if (prospect.stage === "drafted" && reconciled.prospect.stage === "contacted") contacted += 1;
    if (prospect.stage === "contacted" && reconciled.prospect.stage === "replied") replied += 1;
    if (reconciled.prospect.bouncedAt !== undefined && prospect.bouncedAt === undefined)
      bounced += 1;
    if (reconciled.prospect.draftDeletedAt !== undefined && prospect.draftDeletedAt === undefined)
      deleted += 1;
    const refreshed = yield* dependencies.sales.query({
      spaceId: prospect.spaceId,
      stages: [reconciled.prospect.stage],
      limit: 500,
    });
    const dueFollowUps = refreshed.draftRequests.filter(
      (request) =>
        request.prospectId === prospect.id &&
        request.campaignStep > 0 &&
        request.status === "creating",
    );
    for (const request of dueFollowUps) {
      yield* withSalesDraftCreateLock(
        { spaceId: request.spaceId, requestId: request.id },
        Effect.gen(function* () {
          const existing = yield* dependencies.google.findSalesDraft(request);
          const result =
            existing === undefined
              ? yield* dependencies.google.createSalesDraft(request)
              : { draftId: existing };
          yield* dependencies.sales.completeDraftCreate({
            requestId: request.id,
            spaceId: request.spaceId,
            payloadDigest: request.payloadDigest,
            draftId: result.draftId,
            reconciled: existing !== undefined,
          });
        }),
      );
      followUpDrafted += 1;
    }
  }
  return {
    inspected: snapshot.prospects.length,
    contacted,
    replied,
    bounced,
    deleted,
    followUpDrafted,
  };
});

/**
 * Fixed-purpose actions for an opted-in sales workflow. The definition can
 * select an operation and bounded parameters, but it never supplies a command,
 * filesystem path, recipient, Gmail account, or send capability.
 */
export const makeSalesAutomationActionExecutor =
  (dependencies: SalesAutomationActionDependencies): SalesAutomationActionExecutor =>
  (input: SalesAutomationActionRequest) =>
    Effect.gen(function* () {
      switch (input.operation) {
        case "prospector.cycle": {
          const discoveryLimit = boundedInt(input.config.discoveryLimit, 20, 50);
          const qualificationLimit = boundedInt(input.config.qualificationLimit, 50, 50);
          const runnerResult = yield* dependencies.runner.cycle({
            spaceId: SpaceId.make(input.spaceId),
            discoveryLimit,
            qualificationLimit,
          });
          const imported = yield* ExternalProspectorConnector.importReadyProspects(
            dependencies.prospector,
            dependencies.sales,
            { spaceId: SpaceId.make(input.spaceId), limit: qualificationLimit },
          );
          return toJson(SalesProspectorRunner.completeCycleResult(runnerResult, imported));
        }
        case "prospects.list": {
          const minimumScore =
            typeof input.config.minimumScore === "number" &&
            Number.isInteger(input.config.minimumScore) &&
            input.config.minimumScore >= 0 &&
            input.config.minimumScore <= 100
              ? input.config.minimumScore
              : 75;
          return toJson(
            yield* dependencies.sales.query({
              spaceId: SpaceId.make(input.spaceId),
              stages: ["qualified"],
              minimumScore,
              withoutActiveDraft: true,
              limit: boundedInt(input.config.limit, 15, 15),
            }),
          );
        }
        case "gmail.drafts.create":
          return toJson(yield* createDrafts(dependencies, input));
        case "gmail.reconcile":
          return toJson(yield* reconcileGmail(dependencies, input));
        default:
          return yield* Effect.fail(`Unsupported sales action '${input.operation}'.`);
      }
    }).pipe(Effect.mapError(toFailure));
