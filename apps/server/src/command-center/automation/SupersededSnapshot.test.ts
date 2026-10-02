import * as NodeServices from "@effect/platform-node/NodeServices";
import { Automation, AutomationNodeId, SpaceId } from "@command-center/core";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { AutomationRuns, layer as automationRunsLayer } from "../AutomationRuns.ts";
import * as InboxGmailDrafts from "../InboxGmailDrafts.ts";
import { CommandCenterService, type CommandCenterServiceShape } from "../Service.ts";
import { canonicalJson } from "./Digest.ts";
import { layer as runtimeLayer } from "./Runtime.ts";

// A snapshot the projection reports as superseded (a newer runtime write
// already exists) is audited but must not project an approval gate; the
// writer of the current row does that.

const now = "2026-07-20T12:00:00.000Z";
const commitSha = "1234567890abcdef1234567890abcdef12345678";
const definitionDigest = `sha256:${"a".repeat(64)}`;
const automation = Schema.decodeUnknownSync(Automation)({
  id: "gate",
  spaceId: "space-a",
  name: "gate",
  version: 1,
  enabled: true,
  trigger: { type: "manual" },
  nodes: [
    {
      id: AutomationNodeId.make("review"),
      kind: "approval",
      config: { approvalKey: "review" },
      position: { x: 0, y: 0 },
    },
  ],
  edges: [],
  definitionDigest,
  configCommit: commitSha,
  createdAt: now,
  updatedAt: now,
});

const unusedDrafts = InboxGmailDrafts.InboxGmailDrafts.of({
  approve: () => Effect.die("unused"),
  receipt: () => Effect.die("unused"),
  loadForExecution: () => Effect.die("unused"),
  claim: () => Effect.die("unused"),
  complete: () => Effect.die("unused"),
  uncertain: () => Effect.die("unused"),
});

function testLayer(projected: boolean, ensured: Array<string>) {
  let nextId = 0;
  const commandCenter = CommandCenterService.of({
    queryAutomations: () => Effect.succeed({ automations: [automation] }),
    queryApprovals: () => Effect.succeed({ approvals: [] }),
    recordAutomationEvent: () => Effect.succeed({ projected }),
    getAutomationApprovalBinding: () => Effect.succeed(null),
    ensureAutomationApproval: (input: { readonly nodeId: string }) =>
      Effect.sync(() => {
        ensured.push(input.nodeId);
        return {} as never;
      }),
  } as unknown as CommandCenterServiceShape);
  return automationRunsLayer.pipe(
    Layer.provideMerge(Layer.succeed(InboxGmailDrafts.InboxGmailDrafts, unusedDrafts)),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(CommandCenterService, commandCenter),
        runtimeLayer({
          executeNode: () => Effect.die("approval nodes are not executed"),
          now: Effect.succeed(now),
          randomUUID: Effect.sync(() => `execution-${++nextId}`),
          defaultMaxAttempts: 1,
        }),
      ),
    ),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  );
}

const seedAndStart = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO command_center_spaces (id, slug, name, kind, created_at, updated_at)
    VALUES ('space-a', 'space-a', 'Space A', 'business', ${now}, ${now})
  `;
  yield* sql`
    INSERT INTO command_center_automations (
      id, space_id, name, enabled, commit_sha, definition_digest, definition_json, last_loaded_at
    ) VALUES (
      ${automation.id}, ${automation.spaceId}, ${automation.name}, 1, ${commitSha},
      ${definitionDigest}, ${canonicalJson(automation as Schema.Json)}, ${now}
    )
  `;
  const runs = yield* AutomationRuns;
  return yield* runs.start({
    automationId: automation.id,
    spaceId: SpaceId.make("space-a"),
    idempotencyKey: "gate-1",
    expectedConfigCommitSha: commitSha,
    expectedDefinitionDigest: definitionDigest,
  });
});

{
  const ensured: Array<string> = [];
  it.effect("does not project an approval gate from a superseded snapshot", () =>
    Effect.gen(function* () {
      const started = yield* seedAndStart;
      expect(started.state).toBe("waiting_approval");
      yield* (yield* AutomationRuns).get({
        executionId: started.id,
        spaceId: SpaceId.make("space-a"),
      });
      expect(ensured).toEqual([]);
    }).pipe(Effect.provide(testLayer(false, ensured))),
  );
}

{
  const ensured: Array<string> = [];
  it.effect("projects the approval gate from a current snapshot", () =>
    Effect.gen(function* () {
      const started = yield* seedAndStart;
      expect(started.state).toBe("waiting_approval");
      expect(ensured.length).toBeGreaterThan(0);
      expect(new Set(ensured)).toEqual(new Set(["review"]));
    }).pipe(Effect.provide(testLayer(true, ensured))),
  );
}
