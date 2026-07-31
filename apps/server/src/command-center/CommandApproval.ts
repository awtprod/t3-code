import {
  CommandSubmission,
  type CommandSubmission as CommandSubmissionType,
  RouteDecision,
  type RouteDecision as RouteDecisionType,
} from "@command-center/core";
import * as Schema from "effect/Schema";

export const CommandApprovalPayload = Schema.Struct({
  kind: Schema.Literal("command-action"),
  version: Schema.Literal(1),
  summary: Schema.String,
  proposal: Schema.String,
  command: CommandSubmission,
  route: RouteDecision,
});
export type CommandApprovalPayload = typeof CommandApprovalPayload.Type;

function selected(value: string | null | undefined): string {
  return value ?? "none";
}

export function renderCommandApprovalProposal(input: {
  readonly command: CommandSubmissionType;
  readonly route: RouteDecisionType;
}): string {
  const attachments = input.command.attachments ?? [];
  return [
    `Command: ${input.command.text}`,
    `Action: ${input.route.actionKind}`,
    `Risk: ${input.route.risk}`,
    `Space: ${selected(input.route.spaceId)}`,
    `Repository: ${selected(input.route.repositoryId)}`,
    `Project: ${selected(input.route.projectId)}`,
    `Provider: ${selected(input.route.providerId)}`,
    `Model: ${selected(input.route.modelId)}`,
    `Capabilities: ${input.route.capabilities.join(", ") || "none"}`,
    attachments.length === 0
      ? "Attachments: none"
      : `Attachments (content is included in the digest): ${attachments
          .map((attachment) => `${attachment.name} [${attachment.mimeType}; ${attachment.id}]`)
          .join(", ")}`,
  ].join("\n");
}

export function makeCommandApprovalPayload(input: {
  readonly command: CommandSubmissionType;
  readonly route: RouteDecisionType;
}): CommandApprovalPayload {
  return {
    kind: "command-action",
    version: 1,
    summary: `Review action: ${input.route.actionKind}`,
    proposal: renderCommandApprovalProposal(input),
    command: input.command,
    route: input.route,
  };
}
