import * as Schema from "effect/Schema";

const id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160));
const reference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16000));
const sequence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const RoomRequest = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("agents"),
    spaceId: id,
    after: Schema.optional(reference),
  }),
  Schema.Struct({
    operation: Schema.Literal("link_work"),
    roomId: id,
    requestId: id,
    taskId: reference,
  }),
  Schema.Struct({
    operation: Schema.Literal("approve"),
    spaceId: id,
    requestId: id,
    agentId: id,
    name: id,
    job: text,
    enabled: Schema.Boolean,
  }),
  Schema.Struct({ operation: Schema.Literal("list"), spaceId: id, after: Schema.optional(id) }),
  Schema.Struct({ operation: Schema.Literal("create"), spaceId: id, requestId: id, title: id }),
  Schema.Struct({ operation: Schema.Literal("read"), roomId: id, after: sequence }),
  Schema.Struct({
    operation: Schema.Literal("post"),
    roomId: id,
    requestId: id,
    text,
    recipients: Schema.Array(reference).check(Schema.isMaxLength(8)),
    causeSequence: Schema.optional(sequence),
  }),
  Schema.Struct({
    operation: Schema.Literal("recruit"),
    roomId: id,
    requestId: id,
    agentId: reference,
  }),
]);
export type RoomRequest = typeof RoomRequest.Type;
