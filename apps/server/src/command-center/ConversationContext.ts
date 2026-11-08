import { CommandSubmission, RouteDecision } from "@command-center/core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { latestAssistantText } from "./V2Transcript.ts";

export const loadConversationContext = Effect.fn("CommandCenter.loadConversationContext")(
  function* (input: {
    readonly runId: string;
    readonly spaceId: string;
    readonly repositoryId: string | null;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const candidates = yield* sql<{
      readonly threadId: string | null;
      readonly state: string;
      readonly routeJson: string;
      readonly inputJson: string;
    }>`
    SELECT previous.state, previous.thread_id AS "threadId", previous.route_json AS "routeJson", previous.input_json AS "inputJson"
    FROM command_center_runs previous JOIN command_center_runs current ON current.id = ${input.runId}
    WHERE previous.space_id = ${input.spaceId} AND current.space_id = ${input.spaceId}
      AND previous.id <> current.id
      AND current.conversation_id IS NOT NULL
      AND previous.conversation_id = current.conversation_id
      AND previous.conversation_turn < current.conversation_turn
      AND previous.state IN ('succeeded', 'failed', 'canceled')
    ORDER BY previous.conversation_turn DESC LIMIT 6`;
    const entries = yield* Effect.forEach(candidates, (candidate) =>
      Effect.gen(function* () {
        const route = yield* Schema.decodeEffect(Schema.fromJsonString(RouteDecision))(
          candidate.routeJson,
        );
        const command = yield* Schema.decodeEffect(Schema.fromJsonString(CommandSubmission))(
          candidate.inputJson,
        );
        if (route.repositoryId !== input.repositoryId) return undefined;
        const responseText =
          candidate.threadId === null
            ? null
            : yield* latestAssistantText({ threadId: candidate.threadId });
        return {
          commandText:
            candidate.state === "succeeded"
              ? command.text
              : `[Previous turn status: ${candidate.state}]\n${command.text}`,
          ...(responseText ? { responseText } : {}),
        };
      }),
    );
    return entries.filter((entry) => entry !== undefined);
  },
);
