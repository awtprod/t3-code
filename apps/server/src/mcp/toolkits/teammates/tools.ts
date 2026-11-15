import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import { RoomRequest } from "../../../../../../packages/contracts/src/teammateRooms.ts";
import { TeammateRooms, RoomError } from "../../../command-center/TeammateRooms.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";

export const TeammateToolkit = Toolkit.make(
  Tool.make("cc_room", {
    description:
      "Read shared room history, recruit an owner-approved specialist, or post a message to explicit member agent IDs. Mutations require a stable requestId; reuse it only for identical retries. link_work attaches your existing delegate_task taskId so its result appears here. Your identity comes from your thread credential. Agent posts require causeSequence from a room event delivered to you; at most 12 deliveries follow one owner message. An empty recipients list publishes without waking anyone. Recruiting never sends a greeting. Accepted means persisted, not read.",
    parameters: Schema.Struct({ request: RoomRequest }),
    success: Schema.Json,
    failure: Schema.Union([RoomError, OrchestratorMcpFailure]),
    dependencies: [TeammateRooms, McpInvocationContext, ThreadManagementService],
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true),
);
