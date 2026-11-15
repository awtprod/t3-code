import { Space } from "@command-center/core";
import * as Schema from "effect/Schema";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
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
  ThreadManagementThreadNotFoundError,
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
  it.effect("removes retired members without reviving queued deliveries or losing authors", () =>
    Effect.gen(function* () {
      yield* setup;
      const sql = yield* SqlClient.SqlClient;
      const rooms = yield* TeammateRooms;
      for (let i = 0; i < 7; i++) {
        yield* sql`INSERT INTO teammate_agents(id,space_id,name,job,enabled,role,thread_id,project_id,model_json) VALUES(${`s${i}`},'space',${`Specialist ${i}`},'Work',1,'specialist',${`s-thread${i}`},'project','{}')`;
        yield* sql`INSERT INTO teammate_members(room_id,agent_id) VALUES('room',${`s${i}`})`;
      }
      yield* sql`UPDATE teammate_agents SET model_json='{"instanceId":"codex","model":"test"}'`;
      yield* sql`INSERT INTO teammate_agents(id,space_id,name,job,enabled,role,thread_id,project_id,model_json) VALUES('extra','space','Extra','Work',1,'specialist','extra-thread','project','{"instanceId":"codex","model":"test"}')`;
      const recruit = {
        operation: "recruit",
        roomId: "room",
        requestId: "extra",
        agentId: "extra",
      };
      assert.strictEqual(
        (yield* rooms.request(owner, recruit).pipe(Effect.result))._tag,
        "Failure",
      );
      yield* rooms.request(owner, { ...post("target"), recipients: ["s0"] });
      const caller = { kind: "agent", threadId: ThreadId.make("s-thread0") } as const;
      yield* rooms.request(caller, { ...post("source"), causeSequence: 1 });
      const remove = { operation: "remove", roomId: "room", requestId: "remove", agentId: "s0" };
      assert.strictEqual(
        (yield* rooms.request(caller, remove).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.strictEqual(
        (yield* rooms.request(owner, { ...remove, agentId: "main:space" }).pipe(Effect.result))
          ._tag,
        "Failure",
      );
      yield* sql`UPDATE teammate_agents SET enabled=0 WHERE id='s0'`;
      yield* sql`INSERT INTO command_center_spaces(id) VALUES('other')`;
      yield* sql`INSERT INTO teammate_rooms(id,space_id,title) VALUES('other-room','other','Other')`;
      assert.strictEqual(
        (yield* rooms.request(owner, { ...remove, roomId: "other-room" }).pipe(Effect.result))._tag,
        "Failure",
      );
      const receipt = yield* rooms.request(owner, remove);
      assert.deepStrictEqual(yield* rooms.request(owner, remove), receipt);
      assert.strictEqual(
        (yield* rooms.request(owner, { ...remove, agentId: "s1" }).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.strictEqual(
        (yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM teammate_members`)[0]?.n,
        7,
      );
      assert.strictEqual(
        (yield* rooms
          .request(caller, { operation: "read", roomId: "room", after: 0 })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      yield* rooms.request(owner, recruit);
      assert.strictEqual(
        (yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM teammate_members`)[0]?.n,
        8,
      );
      yield* rooms.request(owner, { ...remove, requestId: "remove-extra", agentId: "extra" });
      // Rejoining cannot revive delivery or reply authority from before removal.
      yield* sql`UPDATE teammate_agents SET enabled=1 WHERE id='s0'`;
      assert.strictEqual(
        (yield* rooms
          .request(caller, { operation: "read", roomId: "room", after: 0 })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      yield* rooms.request(owner, { ...recruit, requestId: "rejoin", agentId: "s0" });
      assert.strictEqual(
        (yield* rooms.request(caller, { ...post("stale"), causeSequence: 1 }).pipe(Effect.result))
          ._tag,
        "Failure",
      );
      yield* rooms.drain;
      assert.deepStrictEqual(
        yield* sql`SELECT state,error FROM teammate_deliveries ORDER BY sequence`,
        [
          { state: "failed", error: "membership removed" },
          { state: "failed", error: "membership removed" },
        ],
      );
      const history = yield* rooms.request(owner, { operation: "read", roomId: "room", after: 0 });
      assert.include(JSON.stringify(history), '"author_name":"Specialist 0"');
      assert.strictEqual(
        (yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM teammate_events`)[0]?.n,
        6,
      );
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              dependencies,
              Layer.mock(OrchestrationBridge)({ admitThread: () => Effect.void }),
              Layer.mock(ThreadManagementService)({
                hasReceipt: () => Effect.succeed(false),
                getThreadShell: () =>
                  Effect.succeed({
                    id: ThreadId.make("main-thread"),
                    projectId: ProjectId.make("project"),
                    deletedAt: null,
                    archivedAt: null,
                  } as OrchestrationV2ThreadShell),
              }),
            ),
          ),
          Layer.provideMerge(NodeSqliteClient.layerMemory()),
        ),
      ),
    ),
  );
  it.effect.each(["receipt", "admission", "send-success", "send-failure"] as const)(
    "serves corrections during stalled %s and guards late drain results",
    (stall) =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let held = false;
        let sends = 0;
        const pause = Effect.gen(function* () {
          if (held) return;
          held = true;
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
        });
        const shell = {
          id: ThreadId.make("ada-thread"),
          projectId: ProjectId.make("project"),
          deletedAt: null,
          archivedAt: null,
          runtimeMode: "auto",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
        } as OrchestrationV2ThreadShell;
        const transport = Layer.mock(ThreadManagementService)({
          hasReceipt: () => (stall === "receipt" ? pause : Effect.void).pipe(Effect.as(false)),
          getThreadShell: () => Effect.succeed(shell),
          sendToThread: () =>
            Effect.gen(function* () {
              sends++;
              if (stall.startsWith("send")) yield* pause;
              if (stall === "send-failure")
                return yield* new ThreadManagementThreadNotFoundError({
                  projectId: shell.projectId,
                  threadId: shell.id,
                });
              return {
                run: { id: RunId.make("late-run") },
                delivery: "queued",
              } as ThreadManagementSendResult;
            }),
        });
        yield* Effect.gen(function* () {
          yield* setup;
          const sql = yield* SqlClient.SqlClient;
          const rooms = yield* TeammateRooms;
          yield* sql`INSERT INTO teammate_agents(id,space_id,name,job,enabled,role,thread_id,project_id,model_json) VALUES('ada','space','Ada','Work',1,'specialist','ada-thread','project','{"instanceId":"codex","model":"test"}')`;
          yield* sql`INSERT INTO teammate_members(room_id,agent_id) VALUES('room','ada')`;
          yield* rooms.request(owner, { ...post("stalled"), recipients: ["ada"] });
          yield* rooms.request(
            { kind: "agent", threadId: ThreadId.make("ada-thread") },
            { ...post("source-before-removal"), causeSequence: 1 },
          );
          yield* sql`INSERT INTO orchestration_v2_projection_subagents(subagent_id,thread_id,parent_node_id,provider,origin,status,updated_at,payload_json) VALUES('task','main-thread','parent','codex','app_owned','completed','2026-11-15T00:00:00Z','{}')`;
          yield* rooms.request(owner, {
            operation: "link_work",
            roomId: "room",
            requestId: "link",
            taskId: "task",
          });
          const first = yield* rooms.drain.pipe(Effect.forkChild({ startImmediately: true }));
          yield* Effect.raceFirst(
            Deferred.await(entered),
            Fiber.join(first).pipe(Effect.andThen(Effect.die("drain finished before stall"))),
          );
          const second = yield* rooms.drain.pipe(Effect.forkChild({ startImmediately: true }));
          const correction = yield* Effect.gen(function* () {
            yield* rooms.request(owner, { operation: "read", roomId: "room", after: 0 });
            yield* rooms.request(owner, { ...post("correction"), recipients: [] });
            yield* rooms.request(owner, {
              operation: "remove",
              roomId: "room",
              requestId: "remove",
              agentId: "ada",
            });
            yield* rooms.request(owner, {
              operation: "recruit",
              roomId: "room",
              requestId: "rejoin",
              agentId: "ada",
            });
          }).pipe(
            Effect.timeout("1 second"),
            Effect.result,
            Effect.forkChild({ startImmediately: true }),
          );
          yield* TestClock.adjust("1 second");
          assert.strictEqual((yield* Fiber.join(correction))._tag, "Success");
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(first);
          yield* Fiber.join(second);
          assert.strictEqual(sends, stall.startsWith("send") ? 1 : 0);
          const rows =
            yield* sql`SELECT state,error,run_id FROM teammate_deliveries ORDER BY sequence`;
          assert.deepStrictEqual(rows, [
            {
              state: stall === "send-success" ? "accepted" : "failed",
              error: "membership removed",
              run_id: stall === "send-success" ? "late-run" : null,
            },
            { state: "failed", error: "membership removed", run_id: null },
          ]);
          assert.strictEqual(
            (yield* sql<{
              n: number;
            }>`SELECT COUNT(*) AS n FROM teammate_events WHERE kind='result'`)[0]?.n,
            1,
          );
          assert.strictEqual(
            (yield* sql<{
              n: number;
            }>`SELECT COUNT(*) AS n FROM teammate_members WHERE agent_id='ada'`)[0]?.n,
            1,
          );
        }).pipe(
          Effect.provide(
            layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  dependencies,
                  transport,
                  Layer.mock(OrchestrationBridge)({
                    admitThread: () => (stall === "admission" ? pause : Effect.void),
                  }),
                ),
              ),
              Layer.provideMerge(NodeSqliteClient.layerMemory()),
            ),
          ),
        );
      }),
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
            if (calls === 1)
              assert.include(
                input.text,
                "Route implementation to approved specialists with cc_room recruit/post",
              );
            if (calls === 1) assert.notInclude(input.text, "Use delegate_task for implementation");
            else assert.include(input.text, "only within your existing orchestration grants");
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
        yield* sql`INSERT INTO teammate_agents(id,space_id,name,job,enabled,role,thread_id,project_id,model_json) VALUES('ada','space','Ada','Work',1,'specialist','ada-thread','project','{}')`;
        yield* sql`INSERT INTO teammate_members(room_id,agent_id) VALUES('room','ada')`;
        yield* rooms.request(owner, { ...post("ada"), recipients: ["ada"] });
        yield* rooms.request(owner, {
          operation: "remove",
          roomId: "room",
          requestId: "remove-ada",
          agentId: "ada",
        });
        yield* rooms.drain;
        assert.strictEqual(calls, 2);
        assert.deepStrictEqual(
          yield* sql`SELECT state,run_id FROM teammate_deliveries WHERE agent_id='ada'`,
          [{ state: "accepted", run_id: "accepted-run" }],
        );
        assert.deepStrictEqual(yield* sql`SELECT * FROM teammate_members WHERE agent_id='ada'`, []);
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
