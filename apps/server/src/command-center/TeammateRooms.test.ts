import { Space } from "@command-center/core";
import * as Schema from "effect/Schema";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  ThreadId,
  RunId,
  ProjectId,
  ProviderInstanceId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import subagentsMigration from "../persistence/Migrations/OrchestrationV2/Subagents.ts";
import migration from "../persistence/Migrations/116_TeammateRooms.ts";
import { TeammateRooms, layer } from "./TeammateRooms.ts";
import { CommandCenterService } from "./Service.ts";
import { SpaceAgent } from "./SpaceAgent.ts";
import {
  ThreadManagementService,
  type ThreadManagementSendResult,
} from "../orchestration-v2/ThreadManagementService.ts";
import { ThreadLaunchService } from "../orchestration-v2/ThreadLaunchService.ts";
import { OrchestrationBridge } from "./OrchestrationBridge.ts";

const dependencies = Layer.mergeAll(
  NodeServices.layer,
  Layer.mock(CommandCenterService)({
    getConfiguredSpace: () =>
      Effect.succeed(
        Schema.decodeSync(Space)({
          id: "space",
          slug: "space",
          displayName: "Space",
          kind: "system",
          instructions: "",
          policy: {
            allowedCapabilities: ["cc.items.read", "cc.items.write"],
            autoRunRiskLevels: ["low"],
          },
          agent: { enabled: true, dailyWakeLimit: 12, debounceMinutes: 10 },
          connectionIds: [],
          repositories: [],
          aliases: [],
          lifecycle: "active",
          createdAt: "2026-11-15T00:00:00Z",
          updatedAt: "2026-11-15T00:00:00Z",
        }),
      ),
  }),
  Layer.mock(SpaceAgent)({}),
  Layer.mock(ThreadManagementService)({ hasReceipt: () => Effect.succeed(false) }),
  Layer.mock(ThreadLaunchService)({}),
  Layer.mock(OrchestrationBridge)({}),
);
const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE command_center_spaces(id TEXT PRIMARY KEY)`;
  yield* sql`INSERT INTO command_center_spaces(id) VALUES('space')`;
  yield* migration;
  yield* subagentsMigration;
  yield* sql`CREATE TABLE orchestration_v2_projection_runs(run_id TEXT PRIMARY KEY,status TEXT)`;
  yield* sql`INSERT INTO teammate_rooms(id,space_id,title) VALUES('room','space','Planning')`;
  yield* sql`INSERT INTO teammate_agents(id,space_id,name,job,enabled,role,thread_id,project_id,model_json) VALUES('main:space','space','Main','Plan',1,'main','main-thread','project','{}')`;
  yield* sql`INSERT INTO teammate_members(room_id,agent_id) VALUES('room','main:space')`;
});
const owner = { kind: "owner", id: "owner" } as const;
const post = (requestId: string, text = "Hello") => ({
  operation: "post",
  roomId: "room",
  requestId,
  text,
  recipients: ["main:space"],
});
describe("Teammate rooms", () => {
  it.effect(
    "atomically orders concurrent posts, retries identical requests, and rejects conflicting payloads",
    () =>
      Effect.gen(function* () {
        yield* setup;
        const rooms = yield* TeammateRooms;
        const first = yield* rooms.request(owner, post("one"));
        assert.deepStrictEqual(yield* rooms.request(owner, post("one")), first);
        assert.strictEqual(
          (yield* rooms.request(owner, post("one", "changed")).pipe(Effect.result))._tag,
          "Failure",
        );
        yield* Effect.all(
          [rooms.request(owner, post("two")), rooms.request(owner, post("three"))],
          { concurrency: "unbounded" },
        );
        const sql = yield* SqlClient.SqlClient;
        assert.deepStrictEqual(
          (yield* sql<{
            sequence: number;
          }>`SELECT sequence FROM teammate_events ORDER BY sequence`).map((x) => x.sequence),
          [1, 2, 3],
        );
        assert.strictEqual(
          (yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM teammate_deliveries`)[0]?.n,
          3,
        );
      }).pipe(
        Effect.provide(
          layer.pipe(
            Layer.provide(dependencies),
            Layer.provideMerge(NodeSqliteClient.layerMemory()),
          ),
        ),
      ),
  );
  it.effect("rejects spoofed and disabled authors and bounds delivery failure", () =>
    Effect.gen(function* () {
      yield* setup;
      const rooms = yield* TeammateRooms;
      assert.strictEqual(
        (yield* rooms
          .request(
            { kind: "agent", threadId: ThreadId.make("stranger") },
            { operation: "read", roomId: "room", after: 0 },
          )
          .pipe(Effect.result))._tag,
        "Failure",
      );
      yield* rooms.request(owner, post("one"));
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE teammate_agents SET enabled=0`;
      assert.strictEqual(
        (yield* rooms
          .request(
            { kind: "agent", threadId: ThreadId.make("main-thread") },
            { operation: "read", roomId: "room", after: 0 },
          )
          .pipe(Effect.result))._tag,
        "Failure",
      );
      yield* sql`UPDATE teammate_deliveries SET attempts=3`;
      yield* rooms.drain;
      assert.strictEqual(
        (yield* sql<{ state: string }>`SELECT state FROM teammate_deliveries`)[0]?.state,
        "failed",
      );
    }).pipe(
      Effect.provide(
        layer.pipe(Layer.provide(dependencies), Layer.provideMerge(NodeSqliteClient.layerMemory())),
      ),
    ),
  );
  it.effect(
    "recovers an accepted dispatch after losing its outbox acknowledgement, even at the retry deadline",
    () => {
      const shell = {
        id: ThreadId.make("main-thread"),
        projectId: ProjectId.make("project"),
        deletedAt: null,
        archivedAt: null,
        runtimeMode: "auto",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
      } as OrchestrationV2ThreadShell;
      let calls = 0;
      const recovered = Layer.mock(ThreadManagementService)({
        hasReceipt: () => Effect.succeed(true),
        getThreadShell: () => Effect.succeed(shell),
        sendToThread: (input) =>
          Effect.sync(() => {
            calls++;
            assert.match(String(input.commandId), /^room-delivery:/);
            assert.strictEqual(String(input.commandId), String(input.messageId));
            return {
              run: { id: RunId.make("accepted-run") },
              delivery: "queued",
            } as ThreadManagementSendResult;
          }),
      });
      return Effect.gen(function* () {
        yield* setup;
        const rooms = yield* TeammateRooms;
        yield* rooms.request(owner, post("recover"));
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE teammate_deliveries SET attempts=3,deadline='1970-01-01T00:00:00.000Z'`;
        yield* rooms.drain;
        yield* rooms.drain;
        assert.strictEqual(calls, 1);
        assert.deepStrictEqual(yield* sql`SELECT state,run_id FROM teammate_deliveries`, [
          { state: "accepted", run_id: "accepted-run" },
        ]);
      }).pipe(
        Effect.provide(
          layer.pipe(
            Layer.provide(Layer.mergeAll(dependencies, recovered)),
            Layer.provideMerge(NodeSqliteClient.layerMemory()),
          ),
        ),
      );
    },
  );
  it.effect("links only member-owned work and publishes its actual terminal result once", () =>
    Effect.gen(function* () {
      yield* setup;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_v2_projection_subagents(subagent_id,thread_id,parent_node_id,provider,origin,status,updated_at,payload_json) VALUES('task','main-thread','parent','codex','app_owned','running','2026-11-15T00:00:00Z','{}')`;
      const rooms = yield* TeammateRooms;
      yield* rooms.request(owner, {
        operation: "link_work",
        roomId: "room",
        requestId: "link",
        taskId: "task",
      });
      assert.strictEqual(
        (yield* rooms
          .request(owner, {
            operation: "link_work",
            roomId: "room",
            requestId: "bad",
            taskId: "missing",
          })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      yield* sql`UPDATE orchestration_v2_projection_subagents SET status='completed',payload_json='{"result":"Evidence: proof.txt"}' WHERE subagent_id='task'`;
      yield* rooms.drain;
      yield* rooms.drain;
      const events = yield* sql<{
        kind: string;
        text: string;
      }>`SELECT kind,text FROM teammate_events ORDER BY sequence`;
      assert.deepStrictEqual(
        events.map((event) => event.kind),
        ["work-linked", "result"],
      );
      assert.include(events[1]!.text, "Evidence: proof.txt");
    }).pipe(
      Effect.provide(
        layer.pipe(Layer.provide(dependencies), Layer.provideMerge(NodeSqliteClient.layerMemory())),
      ),
    ),
  );
  it.effect(
    "preserves history on service recovery and refuses cross-Space access and unbounded causal exchanges",
    () =>
      Effect.gen(function* () {
        yield* setup;
        const rooms = yield* TeammateRooms;
        yield* rooms.request(owner, post("root"));
        const caller = { kind: "agent", threadId: ThreadId.make("main-thread") } as const;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO command_center_spaces(id) VALUES('other')`;
        yield* sql`INSERT INTO teammate_rooms(id,space_id,title) VALUES('other-room','other','Other')`;
        assert.strictEqual(
          (yield* rooms
            .request(caller, { operation: "read", roomId: "other-room", after: 0 })
            .pipe(Effect.result))._tag,
          "Failure",
        );
        for (let i = 0; i < 11; i++)
          yield* rooms.request(caller, { ...post(`reply-${i}`), causeSequence: 1 });
        assert.strictEqual(
          (yield* rooms
            .request(caller, { ...post("over-budget"), causeSequence: 1 })
            .pipe(Effect.result))._tag,
          "Failure",
        );
        assert.strictEqual(
          (yield* rooms.request(caller, post("no-cause")).pipe(Effect.result))._tag,
          "Failure",
        );
        const before = yield* rooms.request(owner, { operation: "read", roomId: "room", after: 0 });
        const after = yield* Effect.gen(function* () {
          const recovered = yield* TeammateRooms;
          assert.deepStrictEqual(yield* recovered.request(owner, post("root")), {
            roomId: "room",
            sequence: 1,
            status: "accepted",
            queuedRecipients: ["main:space"],
          });
          return yield* recovered.request(owner, { operation: "read", roomId: "room", after: 0 });
        }).pipe(Effect.provide(Layer.fresh(layer).pipe(Layer.provide(dependencies))));
        assert.deepStrictEqual(after, before);
      }).pipe(
        Effect.provide(
          layer.pipe(
            Layer.provide(dependencies),
            Layer.provideMerge(NodeSqliteClient.layerMemory()),
          ),
        ),
      ),
  );
});
