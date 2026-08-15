import * as Schema from "effect/Schema";

export const DatabaseToolErrorReason = Schema.Literals([
  "not-configured",
  "credential-missing",
  "read-only",
  "remote-unavailable",
  "remote-error",
]);
export type DatabaseToolErrorReason = typeof DatabaseToolErrorReason.Type;

export class DatabaseToolError extends Schema.TaggedErrorClass<DatabaseToolError>()(
  "DatabaseToolError",
  {
    reason: DatabaseToolErrorReason,
    message: Schema.String,
  },
) {}

export const SupabaseToolProxyResult = Schema.Struct({
  projectRef: Schema.String,
  readOnly: Schema.Boolean,
  result: Schema.Unknown,
});
export type SupabaseToolProxyResult = typeof SupabaseToolProxyResult.Type;
