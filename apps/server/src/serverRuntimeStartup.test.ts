import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_MODEL,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";

import { makeCommandCenterAuditLog } from "./command-center/AuditLog.ts";
import * as ServerConfig from "./config.ts";
import { layerMemory as SqlitePersistenceMemory } from "./persistence/Sqlite.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";

const commandCenterAuditStartupLayer = Layer.mergeAll(SqlitePersistenceMemory, NodeServices.layer);

it.effect("verifies every configured Google connection before command readiness", () =>
  Effect.gen(function* () {
    const verified = yield* Ref.make<ReadonlyArray<string>>([]);

    yield* ServerRuntimeStartup.verifyConfiguredGoogleConnections(
      {
        queryConnections: () =>
          Effect.succeed({
            connections: [
              { id: "google-a", spaceId: "space-a", kind: "google" },
              { id: "google-b", spaceId: "space-b", kind: "google" },
              { id: "github-a", spaceId: "space-a", kind: "github" },
            ] as never,
          }),
      },
      {
        verify: ({ connectionId }) =>
          Ref.update(verified, (current) => [...current, connectionId]).pipe(
            Effect.flatMap(() =>
              connectionId === "google-b"
                ? Effect.fail({ reason: "process" } as never)
                : Effect.void,
            ),
          ),
      },
    );

    // Both Google connections are checked (one failure does not stop the
    // other) and non-Google connections are not.
    assert.deepStrictEqual([...(yield* Ref.get(verified))].sort(), ["google-a", "google-b"]);
  }),
);

it.effect("starts Command Center workers only after valid audit history is verified", () =>
  Effect.gen(function* () {
    const auditLog = yield* makeCommandCenterAuditLog;
    const startedWorkers = yield* Ref.make<ReadonlyArray<string>>([]);
    yield* auditLog.append({
      eventId: "startup-valid",
      actorKind: "system",
      action: "fixture.startup.valid",
      payload: { valid: true },
      occurredAt: "2026-01-01T00:00:00.000Z",
    });

    yield* ServerRuntimeStartup.startCommandCenterWorkersAfterAuditVerification(
      auditLog.verify,
      Ref.set(startedWorkers, ["schedule", "automation-recovery", "run-recovery"]),
    );

    assert.deepStrictEqual(yield* Ref.get(startedWorkers), [
      "schedule",
      "automation-recovery",
      "run-recovery",
    ]);
  }).pipe(Effect.provide(commandCenterAuditStartupLayer)),
);

it.effect("runs projection-writing connector startup only after audit verification", () =>
  Effect.gen(function* () {
    const order = yield* Ref.make<ReadonlyArray<string>>([]);

    yield* ServerRuntimeStartup.startCommandCenterWorkersAfterAuditVerification(
      Ref.update(order, (current) => [...current, "audit"]).pipe(
        Effect.as({
          valid: true,
          eventCount: 0,
          headSequence: null,
          headHash: null,
        }),
      ),
      Effect.gen(function* () {
        yield* Ref.update(order, (current) => [...current, "google-health"]);
        yield* Ref.update(order, (current) => [...current, "workers"]);
      }),
    );

    assert.deepStrictEqual(yield* Ref.get(order), ["audit", "google-health", "workers"]);
  }),
);

it.effect("fails closed before Command Center workers start when audit history is tampered", () =>
  Effect.gen(function* () {
    const auditLog = yield* makeCommandCenterAuditLog;
    const sql = yield* SqlClient.SqlClient;
    const startedWorkers = yield* Ref.make(0);
    yield* auditLog.append({
      eventId: "startup-tampered",
      actorKind: "system",
      action: "fixture.startup.tampered",
      payload: { valid: true },
      occurredAt: "2026-01-01T00:00:00.000Z",
    });

    // Simulate historical storage corruption that bypassed the normal
    // append-only database protections.
    yield* sql`DROP TRIGGER command_center_audit_events_no_update`;
    yield* sql`
      UPDATE command_center_audit_events
      SET payload_json = '{"valid":false}'
      WHERE event_id = 'startup-tampered'
    `;

    const error = yield* ServerRuntimeStartup.startCommandCenterWorkersAfterAuditVerification(
      auditLog.verify,
      Ref.update(startedWorkers, (count) => count + 1),
    ).pipe(Effect.flip);

    assert.instanceOf(error, ServerRuntimeStartup.CommandCenterAuditIntegrityError);
    assert.equal(error.reason, "event-hash");
    assert.equal(error.invalidSequence, 1);
    assert.equal(yield* Ref.get(startedWorkers), 0);
  }).pipe(Effect.provide(commandCenterAuditStartupLayer)),
);

it("uses the canonical Codex model for auto-bootstrap", () => {
  assert.deepEqual(ServerRuntimeStartup.getAutoBootstrapThreadModelSelection(), {
    instanceId: ProviderInstanceId.make("codex"),
    model: DEFAULT_MODEL,
  });
});

it.effect("starts without scanning or rebuilding projection history", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    const record = (label: string) => Ref.update(calls, (current) => [...current, label]);

    const result = yield* ServerRuntimeStartup.runOrderedV2StartupPhases({
      importLegacyShells: record("import"),
      recover: record("recover").pipe(Effect.as({ closedRequests: 2 })),
      recoverDelegatedTasks: record("delegated"),
      startEffectWorker: record("worker"),
      autoBootstrap: record("bootstrap").pipe(Effect.as({ projectId: "project-1" })),
    });

    // Delegated recovery reads the runs recovery terminalizes, and settles them
    // before the worker runs restart continuations that would otherwise race it.
    assert.deepEqual(yield* Ref.get(calls), [
      "import",
      "recover",
      "delegated",
      "worker",
      "bootstrap",
    ]);
    assert.deepEqual(result, {
      recovery: { closedRequests: 2 },
      bootstrap: { projectId: "project-1" },
    });
  }),
);

it.effect("interrupts the effect worker when awareness relay startup fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const workerInterrupted = yield* Ref.make(false);
      const workerFiberRef = yield* Ref.make<Fiber.Fiber<void, never> | null>(null);

      const exit = yield* ServerRuntimeStartup.startEffectWorkerWithRelay({
        runWorker: Effect.never.pipe(Effect.ensuring(Ref.set(workerInterrupted, true))),
        startRelay: Effect.yieldNow.pipe(
          Effect.andThen(Effect.die("awareness relay startup failed")),
        ),
        workerFiberRef,
      }).pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(exit));
      assert.isTrue(yield* Ref.get(workerInterrupted));
      assert.isNull(yield* Ref.get(workerFiberRef));
    }),
  ),
);

it.effect("queues commands until startup signals readiness", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const gate = yield* ServerRuntimeStartup.makeCommandGate;
      const count = yield* Ref.make(0);
      const queued = yield* gate
        .enqueueCommand(Ref.updateAndGet(count, (value) => value + 1))
        .pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      assert.equal(yield* Ref.get(count), 0);
      yield* gate.signalCommandReady;
      assert.equal(yield* Fiber.join(queued), 1);
    }),
  ),
);

it.effect("enqueueCommand fails queued work when readiness fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const commandGate = yield* ServerRuntimeStartup.makeCommandGate;
      const failure = yield* Deferred.make<void, never>();

      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(Deferred.await(failure).pipe(Effect.as("should-not-run")))
        .pipe(Effect.forkScoped);

      yield* commandGate.failCommandReady(
        new ServerRuntimeStartup.ServerRuntimeStartupError({
          mode: "web",
          host: "127.0.0.1",
          port: 3773,
          cause: new Error("test startup failure"),
        }),
      );

      const error = yield* Effect.flip(Fiber.join(queuedCommandFiber));
      assert.equal(error.message, "Server runtime startup failed before command readiness.");
    }),
  ),
);

it.effect("resolveWelcomeBase derives cwd and project name from server config", () =>
  Effect.gen(function* () {
    const welcome = yield* ServerRuntimeStartup.resolveWelcomeBase.pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
      } as never),
    );

    assert.deepStrictEqual(welcome, {
      cwd: "/tmp/startup-project",
      projectName: "startup-project",
    });
  }),
);

it.effect("automatic pull only updates enabled, behind, clean default-branch checkouts", () =>
  Effect.gen(function* () {
    const pulled: string[] = [];
    const git = {
      statusDetails: (cwd: string) =>
        Effect.succeed({
          isRepo: true,
          isDefaultBranch: cwd !== "/feature",
          hasUpstream: true,
          hasWorkingTreeChanges: cwd === "/dirty",
          aheadCount: cwd === "/ahead" ? 1 : 0,
          behindCount: cwd === "/current" ? 0 : 1,
        } as never),
      pullCurrentBranch: (cwd: string) =>
        Effect.sync(() => {
          pulled.push(cwd);
          return {
            status: "pulled" as const,
            refName: "main",
            upstreamRef: "origin/main",
          };
        }),
    } as unknown as GitVcsDriver.GitVcsDriver["Service"];
    const project = (workspaceRoot: string) =>
      ({ id: ProjectId.make(workspaceRoot), workspaceRoot }) as never;
    const overrides = (entries: Record<string, boolean>) => ({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: Object.fromEntries(
        Object.entries(entries).map(([root, defaultAutoPull]) => [
          ProjectId.make(root),
          { defaultAutoPull },
        ]),
      ),
    });

    yield* ServerRuntimeStartup.autoPullProjects(
      [
        project("/clean"),
        project("/current"),
        project("/dirty"),
        project("/ahead"),
        project("/feature"),
        project("/disabled"),
      ],
      overrides({
        "/clean": true,
        "/current": true,
        "/dirty": true,
        "/ahead": true,
        "/feature": true,
        "/disabled": false,
      }),
    ).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, git));

    assert.deepStrictEqual(pulled, ["/clean"]);

    pulled.length = 0;
    yield* ServerRuntimeStartup.autoPullProjects(
      [project("/inherited"), project("/opted-out"), project("/dirty")],
      { ...overrides({ "/opted-out": false }), defaultAutoPull: true },
    ).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, git));
    assert.deepStrictEqual(pulled, ["/inherited"]);
  }),
);
