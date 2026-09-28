import * as Schema from "effect/Schema";

const Id = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200));
const Version = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const CandidateKind = Schema.Literals(["clip", "title", "thumbnail"]);

export const CommandCenterCcnBinding = Schema.Struct({
  id: Id,
  spaceId: Id,
  planId: Id,
  taskId: Id,
  candidateKind: CandidateKind,
  planVersion: Version,
  version: Version,
  performerId: Id,
  performerName: Id,
  recordingId: Id,
  recordingVersion: Id,
  rootId: Id,
  relativePath: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  sourceSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
});
export const CommandCenterCcnBindingGetInput = Schema.Struct({
  spaceId: Id,
  planId: Id,
  taskId: Id,
  candidateKind: CandidateKind,
});
export const CommandCenterCcnBindingGetResult = Schema.Struct({
  binding: Schema.NullOr(CommandCenterCcnBinding),
});
export const CommandCenterCcnBindingPutInput = Schema.Struct({
  ...CommandCenterCcnBindingGetInput.fields,
  expectedPlanVersion: Version,
  expectedBindingVersion: Version,
  performerId: Id,
  performerName: Id,
  recordingId: Id,
  recordingVersion: Id,
  rootId: Id,
  relativePath: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  sourceSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
});
export const CommandCenterCcnBindingPutResult = CommandCenterCcnBinding;
export const CommandCenterCcnScanInput = Schema.Struct({
  spaceId: Id,
  planId: Id,
  responsibilityId: Id,
  candidateKind: CandidateKind,
  taskIds: Schema.Array(Id).check(Schema.isNonEmpty(), Schema.isMaxLength(30)),
  today: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u)),
  windowDays: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 30 })),
});
export const CommandCenterCcnScanResult = Schema.Struct({
  planVersion: Version,
  candidates: Schema.Array(
    Schema.Struct({
      taskId: Id,
      workIdentity: Id,
      binding: CommandCenterCcnBinding,
      dueAt: Schema.String,
    }),
  ).check(Schema.isMaxLength(30)),
  blocked: Schema.Array(Schema.Struct({ taskId: Id, itemId: Id, cause: Schema.String })).check(
    Schema.isMaxLength(30),
  ),
});
export const CommandCenterCcnClipExportInput = Schema.Struct({
  spaceId: Id,
  planId: Id,
  taskId: Id,
  bindingId: Id,
  planVersion: Version,
  bindingVersion: Version,
  performerId: Id,
  runId: Id,
  requestId: Id,
  startSeconds: Schema.Number.check(Schema.isFinite()),
  endSeconds: Schema.Number.check(Schema.isFinite()),
});
export const CommandCenterCcnClipExportResult = Schema.Struct({
  artifactId: Id,
  contentDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  sizeBytes: Schema.Int.check(Schema.isGreaterThan(0)),
  semanticStatus: Schema.Literal("unverified"),
  duplicate: Schema.Boolean,
});
export const CommandCenterCcnPreviewUrlInput = Schema.Struct({
  spaceId: Id,
  artifactId: Id,
});
export const CommandCenterCcnPreviewUrlResult = Schema.Struct({
  relativeUrl: Schema.String,
  expiresAt: Schema.Number,
});
