import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { DispatchModeLimit } from "../../../orchestration-v2/DispatchModeLimit.ts";
import * as Effect from "effect/Effect";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { TeammateRooms, RoomError } from "../../../command-center/TeammateRooms.ts";
import { TeammateToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(TeammateToolkit, {
  cc_room: McpToolAccess.writesWithCapability(({ request }) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      if (
        !scope.thread ||
        !(scope.role === "space-agent"
          ? scope.capabilities.has(
              request.operation === "read" ? "cc.items.read" : "cc.items.write",
            )
          : scope.capabilities.has("orchestration"))
      )
        return yield* new RoomError({ reason: "forbidden" });
      const rooms = yield* TeammateRooms;
      const threads = yield* ThreadManagementService;
      const caller = yield* threads
        .getThreadShell(scope.thread.threadId)
        .pipe(Effect.mapError((cause) => new RoomError({ reason: "unavailable", cause })));
      if (!caller) return yield* new RoomError({ reason: "forbidden" });
      return yield* rooms.request({ kind: "agent", threadId: scope.thread.threadId }, request).pipe(
        Effect.provideService(DispatchModeLimit, {
          runtimeMode: caller.runtimeMode,
          interactionMode: caller.interactionMode,
        }),
      );
    }),
  ),
});
