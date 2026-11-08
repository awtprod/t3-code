import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const text = (max: number) =>
  Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(max),
    Schema.makeFilter((s) => s.trim().length > 0),
  );
const id = text(256);
const instant = Schema.String.check(
  Schema.isMinLength(24),
  Schema.isMaxLength(24),
  Schema.makeFilter((s) =>
    Option.match(DateTime.make(s), {
      onNone: () => false,
      onSome: (date) => DateTime.formatIso(date) === s,
    }),
  ),
);
const url = text(2048).check(
  Schema.makeFilter((s) => {
    try {
      const u = new URL(s);
      return (
        !/\s/u.test(s) &&
        (u.protocol === "https:" || u.protocol === "http:") &&
        !u.username &&
        !u.password
      );
    } catch {
      return false;
    }
  }),
);
export const CommandCenterKnowledgeScope = Schema.Struct({
  spaceId: id,
  repositoryId: Schema.NullOr(id),
});
export const CommandCenterKnowledgeDocument = Schema.Struct({
  sourceKind: text(64),
  bindingId: id,
  accountId: id,
  externalId: id,
  title: text(512),
  url: Schema.NullOr(url),
  sourceUpdatedAt: instant,
  text: text(65536).check(
    Schema.makeFilter((s) => new TextEncoder().encode(s).byteLength <= 65536),
  ),
});
export const CommandCenterKnowledgeCaptureInput = Schema.Struct({
  ...CommandCenterKnowledgeScope.fields,
  mutationId: id,
  documents: Schema.Array(CommandCenterKnowledgeDocument).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(8),
  ),
}).check(
  Schema.makeFilter((r) => new TextEncoder().encode(JSON.stringify(r)).byteLength <= 262144),
);
export const CommandCenterKnowledgeSearchInput = Schema.Struct({
  ...CommandCenterKnowledgeScope.fields,
  query: text(512).check(
    Schema.makeFilter((s) => {
      const terms = s.match(/[\p{L}\p{N}_]+/gu) ?? [];
      return terms.length > 0 && terms.length <= 16;
    }),
  ),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })),
});
export const CommandCenterKnowledgeGetInput = Schema.Struct({
  ...CommandCenterKnowledgeScope.fields,
  revisionId: id,
  chunk: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 63 })),
});
export const CommandCenterKnowledgeRetireInput = Schema.Struct({
  ...CommandCenterKnowledgeScope.fields,
  mutationId: id,
  sourceId: id,
  expectedRevisionId: id,
});
export const CommandCenterKnowledgeReceipt = Schema.Struct({
  mutationId: id,
  revisions: Schema.Array(Schema.Struct({ sourceId: id, revisionId: id })).check(
    Schema.isMaxLength(8),
  ),
});
// Chunk offsets index the original source string in UTF-16 code units.
export const CommandCenterKnowledgeEvidence = Schema.Struct({
  ...CommandCenterKnowledgeScope.fields,
  sourceId: id,
  revisionId: id,
  chunk: Schema.Int,
  start: Schema.Int,
  end: Schema.Int,
  excerpt: Schema.String.check(Schema.isMaxLength(2048)),
  title: text(512),
  url: Schema.NullOr(url),
  sourceKind: text(64),
  bindingId: id,
  accountId: id,
  externalId: id,
  sourceUpdatedAt: instant,
  capturedAt: instant,
  actorId: id,
  acquisition: Schema.Literals(["imported", "connected"]),
  contentTrust: Schema.Literal("untrusted-evidence"),
  status: Schema.Literals(["current", "superseded", "retired"]),
});
export const CommandCenterKnowledgeSearchResults = Schema.Array(
  CommandCenterKnowledgeEvidence,
).check(Schema.isMaxLength(20));
export type CommandCenterKnowledgeCaptureInput = typeof CommandCenterKnowledgeCaptureInput.Type;
export type CommandCenterKnowledgeReceipt = typeof CommandCenterKnowledgeReceipt.Type;
export type CommandCenterKnowledgeEvidence = typeof CommandCenterKnowledgeEvidence.Type;
