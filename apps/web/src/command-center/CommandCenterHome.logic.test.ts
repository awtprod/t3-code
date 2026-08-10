import type {
  CommandCenterBootstrap,
  CommandCenterCommandSubmitResult,
  CommandCenterTimelineEntry,
  ServerProvider,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { describe, expect, it } from "vite-plus/test";

import {
  buildRouteOptions,
  commandRouteOverrides,
  defaultCommandCenterRouteSelection,
  initialRouteReceipt,
  mergeAuthoritativeMessages,
  nextRouteSelection,
  projectBootstrap,
  projectEnvironmentProjects,
  routeReceiptFromResult,
  routeReceiptFromRoute,
  routeReceiptFromTimelineEntry,
  routeTimelineMessage,
  timelineMessages,
  visibleTimelineEntries,
  waitForRouteReceiptPaint,
} from "./CommandCenterHome.logic";

const BOOTSTRAP = {
  spaces: [
    {
      id: "studio",
      slug: "studio",
      displayName: "Studio",
      kind: "business",
      instructions: "Product work",
      policy: { allowedCapabilities: [], autoRunRiskLevels: ["low"] },
      connectionIds: ["calendar"],
      repositories: [
        {
          id: "studio-repository",
          displayName: "Studio App",
          aliases: ["studio-app"],
          remoteRef: "example/studio-app",
          projectId: "project-studio",
        },
      ],
      aliases: [],
      lifecycle: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  items: [
    {
      id: "review-item",
      spaceId: "studio",
      kind: "task",
      status: "review",
      priority: "high",
      title: "Review the draft",
      dueAt: "2026-01-15T16:00:00.000Z",
      artifactIds: [],
      provenance: {
        kind: "agent",
        sourceRef: "run-1",
        capturedAt: "2026-01-15T09:00:00.000Z",
      },
      metadata: {},
      createdAt: "2026-01-15T09:00:00.000Z",
      updatedAt: "2026-01-15T09:00:00.000Z",
    },
  ],
  needsYou: [
    {
      id: "review-item",
      spaceId: "studio",
      kind: "task",
      status: "review",
      priority: "high",
      title: "Review the draft",
      artifactIds: [],
      provenance: {
        kind: "agent",
        sourceRef: "run-1",
        capturedAt: "2026-01-15T09:00:00.000Z",
      },
      metadata: {},
      createdAt: "2026-01-15T09:00:00.000Z",
      updatedAt: "2026-01-15T09:00:00.000Z",
    },
  ],
  runs: [
    {
      id: "run-1",
      spaceId: "studio",
      kind: "agent",
      status: "running",
      providerId: "provider-1",
      modelId: "model-1",
      projectId: "project-studio",
      threadId: "thread-1",
      artifactIds: [],
      createdAt: "2026-01-15T09:55:00.000Z",
    },
  ],
  approvals: [
    {
      id: "approval-1",
      spaceId: "studio",
      runId: "run-1",
      status: "requested",
      actionKind: "publish",
      risk: "approval-required",
      summary: "Approve publication",
      proposal: "Command: publish the reviewed release\nAction: publish",
      payloadDigest: "a".repeat(64),
      idempotencyKey: "approval:command-1",
      requestedAt: "2026-01-15T09:55:00.000Z",
    },
  ],
  automations: [],
  connections: [
    {
      id: "calendar",
      spaceId: "studio",
      kind: "google",
      label: "Calendar",
      capabilities: ["cc.connections.google.read"],
      health: "connected",
    },
  ],
  memories: [],
  configHealth: { status: "loaded", configDirectory: "runtime-config" },
} as unknown as CommandCenterBootstrap;

const RESULT = {
  run: {
    id: "run-1",
    spaceId: "studio",
    kind: "agent",
    status: "waiting_approval",
    providerId: "provider-1",
    modelId: "model-1",
    threadId: "thread-1",
    artifactIds: [],
    createdAt: "2026-01-15T10:00:00.000Z",
  },
  route: {
    commandId: "command-1",
    status: "approval-required",
    intent: "repository",
    spaceId: "studio",
    repositoryId: "studio-repository",
    projectId: "project-studio",
    providerId: "provider-1",
    modelId: "model-1",
    capabilities: ["cc.runs.start"],
    actionKind: "git.push",
    risk: "approval-required",
    approvalRequired: true,
    sources: {
      space: "explicit",
      repository: "explicit",
      project: "explicit",
      provider: "fallback",
      model: "provider-default",
    },
    reasons: ["A high-impact action must be approved."],
  },
  duplicate: false,
} as unknown as CommandCenterCommandSubmitResult;

const PROJECTS = [
  {
    id: "project-studio",
    environmentId: "environment-primary",
    title: "Studio Project",
    workspaceRoot: "/workspace/studio",
    repositoryIdentity: {
      canonicalKey: "example/studio-app",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://example.test/example/studio-app.git",
      },
    },
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "command-center:system",
    environmentId: "environment-primary",
    title: "Internal Command workspace",
    workspaceRoot: "/runtime/system",
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
] as unknown as readonly EnvironmentProject[];

const PROVIDERS = [
  {
    instanceId: "provider-1",
    driver: "example-provider",
    displayName: "Example Provider",
    enabled: true,
    installed: true,
    status: "ready",
    availability: "available",
    models: [
      {
        slug: "model-1",
        name: "Example Model",
        isCustom: false,
        capabilities: null,
      },
    ],
  },
] as unknown as readonly ServerProvider[];

describe("CommandCenterHome projection", () => {
  it("defaults the router to Terra while preserving the provider instance", () => {
    expect(
      defaultCommandCenterRouteSelection({
        models: [
          { id: "gpt-5.6-sol", label: "Sol", providerId: "codex-work" },
          { id: "gpt-5.6-terra", label: "Terra", providerId: "codex-personal" },
        ],
        projects: [],
        providers: [],
        repositories: [],
      }),
    ).toEqual({ providerId: "codex-personal", modelId: "gpt-5.6-terra" });
  });

  it("projects bootstrap data into live shell context", () => {
    const projection = projectBootstrap(BOOTSTRAP, new Date("2026-01-15T10:00:00.000Z"));

    expect(projection.spaces).toMatchObject([{ id: "studio", name: "Studio", unreadCount: 1 }]);
    expect(projection.conversations[0]).toMatchObject({
      id: "run-1",
      status: "running",
      threadId: "thread-1",
    });
    expect(projection.context.needsYou[0]).toMatchObject({ reason: "review" });
    expect(projection.context.needsYou[0]?.action).toMatchObject({
      kind: "approval",
      approvalId: "approval-1",
    });
    expect(projection.context.activeRuns[0]).toMatchObject({ spaceName: "Studio" });
    expect(projection.context.connections[0]).toMatchObject({
      status: "healthy",
      detail: "Read-only",
    });
    expect(projection.context.today).toHaveLength(1);
  });

  it("does not count failed runs as active work", () => {
    const failedBootstrap = {
      ...BOOTSTRAP,
      runs: BOOTSTRAP.runs.map((run) => ({ ...run, status: "failed" })),
    } as unknown as CommandCenterBootstrap;

    expect(projectBootstrap(failedBootstrap).context.activeRuns).toEqual([]);
  });

  it("hides old transcript entries until History explicitly selects a run", () => {
    const entries = [
      { sequence: 4, runId: "old-run" },
      { sequence: 6, runId: "new-run" },
    ] as unknown as readonly CommandCenterTimelineEntry[];

    expect(visibleTimelineEntries([...entries], 4).map((entry) => entry.runId)).toEqual([
      "new-run",
    ]);
    expect(visibleTimelineEntries([...entries], 99, "old-run").map((entry) => entry.runId)).toEqual(
      ["old-run"],
    );
  });

  it("surfaces private configuration health without exposing its path", () => {
    const missing = {
      ...BOOTSTRAP,
      configHealth: {
        status: "missing" as const,
        configDirectory: "hidden-config-location",
      },
    };

    const receipt = initialRouteReceipt(missing);

    expect(receipt.status).toBe("blocked");
    expect(receipt.summary).not.toContain("hidden-config-location");
  });

  it("projects linked T3 projects while hiding the system Command workspace", () => {
    const projects = projectEnvironmentProjects(PROJECTS, BOOTSTRAP);

    expect(projects).toEqual([
      {
        id: "project-studio",
        name: "Studio Project",
        repositoryId: "studio-repository",
        repositoryName: "Studio App",
        spaceId: "studio",
      },
    ]);
  });

  it("turns explicit route controls into command overrides with project linkage", () => {
    const projects = projectEnvironmentProjects(PROJECTS, BOOTSTRAP);
    const projectSelection = nextRouteSelection(
      {},
      "project",
      "project-studio",
      projects,
      BOOTSTRAP,
      PROVIDERS,
    );
    const providerSelection = nextRouteSelection(
      projectSelection,
      "provider",
      "provider-1",
      projects,
      BOOTSTRAP,
      PROVIDERS,
    );
    const selection = nextRouteSelection(
      providerSelection,
      "model",
      "model-1",
      projects,
      BOOTSTRAP,
      PROVIDERS,
    );

    expect(commandRouteOverrides(selection)).toEqual({
      spaceId: "studio",
      repositoryId: "studio-repository",
      projectId: "project-studio",
      providerId: "provider-1",
      modelId: "model-1",
    });
  });

  it("keeps Auto visible and builds selectable healthy provider models", () => {
    const projects = projectEnvironmentProjects(PROJECTS, BOOTSTRAP);
    const options = buildRouteOptions(BOOTSTRAP, projects, PROVIDERS);
    const receipt = initialRouteReceipt(
      BOOTSTRAP,
      { projectId: "project-studio", providerId: "provider-1", modelId: "model-1" },
      { projects, options },
    );

    expect(options.providers).toMatchObject([{ id: "provider-1", label: "Example Provider" }]);
    expect(options.models).toMatchObject([{ id: "model-1", label: "Example Model" }]);
    expect(receipt).toMatchObject({
      projectName: "Studio Project",
      providerName: "Example Provider",
      modelName: "Example Model",
      sources: { space: "auto", project: "explicit", provider: "explicit", model: "explicit" },
    });
  });

  it("turns a submit result into a visible route receipt and timeline event", () => {
    const projects = projectEnvironmentProjects(PROJECTS, BOOTSTRAP);
    const options = buildRouteOptions(BOOTSTRAP, projects, PROVIDERS);
    const receipt = routeReceiptFromResult(RESULT, BOOTSTRAP, { projects, options });
    const message = routeTimelineMessage(RESULT, receipt, "10:00 AM");

    expect(receipt).toMatchObject({
      spaceName: "Studio",
      repositoryName: "Studio App",
      projectName: "Studio Project",
      providerName: "Example Provider",
      modelName: "Example Model",
      capabilities: ["cc.runs.start"],
      risk: "approval-required",
      status: "waiting-approval",
    });
    expect(message.body).toContain("waiting for approval");
    expect(message.body).toContain("Studio · Studio App · Studio Project");
    expect(message.body).toContain("Example Provider · Example Model");
    expect(message.body).toContain("Capabilities: cc.runs.start");
    expect(message).toMatchObject({ linkedRunId: "run-1", linkedThreadId: "thread-1" });
  });

  it("maps a persisted approval-required route from its authoritative run status", () => {
    const projects = projectEnvironmentProjects(PROJECTS, BOOTSTRAP);
    const options = buildRouteOptions(BOOTSTRAP, projects, PROVIDERS);
    const display = { projects, options };
    const route = RESULT.route;

    expect(route.approvalRequired).toBe(true);
    expect(routeReceiptFromRoute(route, "waiting_approval", BOOTSTRAP, display).status).toBe(
      "waiting-approval",
    );
    expect(routeReceiptFromRoute(route, "running", BOOTSTRAP, display).status).toBe("running");
    expect(routeReceiptFromRoute(route, "succeeded", BOOTSTRAP, display).status).toBe("complete");
    expect(routeReceiptFromRoute(route, "failed", BOOTSTRAP, display).status).toBe("failed");
    expect(routeReceiptFromRoute(route, "canceled", BOOTSTRAP, display).status).toBe("failed");
    expect(routeReceiptFromRoute(route, "waiting", BOOTSTRAP, display).status).toBe(
      "waiting-approval",
    );
    expect(routeReceiptFromRoute(route, "queued", BOOTSTRAP, display).status).toBe("running");

    const entry = { route } as unknown as CommandCenterTimelineEntry;
    expect(
      routeReceiptFromTimelineEntry({ ...entry, status: "succeeded" }, BOOTSTRAP, display).status,
    ).toBe("complete");
    expect(
      routeReceiptFromTimelineEntry({ ...entry, status: "failed" }, BOOTSTRAP, display).status,
    ).toBe("failed");
    expect(
      routeReceiptFromTimelineEntry({ ...entry, status: "running" }, BOOTSTRAP, display).status,
    ).toBe("running");
  });

  it("waits through a complete browser paint boundary before starting work", async () => {
    const frames: Array<() => void> = [];
    const waiting = waitForRouteReceiptPaint((callback) => frames.push(callback));

    expect(frames).toHaveLength(1);
    frames.shift()?.();
    expect(frames).toHaveLength(1);
    let completed = false;
    void waiting.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);

    frames.shift()?.();
    await waiting;
    expect(completed).toBe(true);
  });

  it("reconstructs the global Command conversation from durable timeline entries", () => {
    const entry = {
      sequence: 8,
      runId: "run-durable",
      commandId: "command-durable",
      text: "Review the durable example",
      spaceId: "studio",
      repositoryId: null,
      projectId: "project-durable",
      threadId: "thread-durable",
      status: "running",
      route: {
        ...RESULT.route,
        commandId: "command-durable",
        status: "ready",
        risk: "low",
        approvalRequired: false,
        reasons: [],
      },
      response: {
        kind: "assistant",
        text: "The durable review is complete.",
        createdAt: "2026-01-15T10:01:00.000Z",
      },
      artifacts: [
        {
          id: "artifact-durable",
          spaceId: "studio",
          runId: "run-durable",
          kind: "report",
          name: "Review report",
          locator: "cc-artifact://artifact-durable",
          contentDigest: `sha256:${"a".repeat(64)}`,
          provenance: {
            kind: "agent",
            sourceRef: "thread-durable",
            capturedAt: "2026-01-15T10:01:00.000Z",
          },
          createdAt: "2026-01-15T10:01:00.000Z",
        },
      ],
      startedAt: "2026-01-15T10:00:00.000Z",
      finishedAt: null,
    } as unknown as CommandCenterTimelineEntry;

    const messages = timelineMessages([entry], BOOTSTRAP);

    expect(messages).toHaveLength(4);
    expect(messages[0]).toMatchObject({
      id: "command-durable:user",
      author: "user",
      body: "Review the durable example",
    });
    expect(messages[1]).toMatchObject({
      id: "run-durable:route",
      author: "system",
      authorLabel: "Route receipt",
      linkedThreadId: "thread-durable",
      receipt: {
        providerName: "provider-1",
        modelName: "model-1",
        status: "running",
      },
    });
    expect(messages[1]?.body).toContain("Studio App · project-studio");
    expect(messages[1]?.body).toContain("provider-1 · model-1");
    expect(messages[2]).toMatchObject({
      id: "run-durable:response",
      author: "assistant",
      body: "The durable review is complete.",
      linkedThreadId: "thread-durable",
    });
    expect(messages[3]).toMatchObject({
      id: "run-durable:artifacts",
      authorLabel: "Artifact",
      body: "Review report",
    });
  });

  it("keeps optimistic failures while replacing persisted optimistic messages", () => {
    const authoritative = [
      { id: "command-1:user", author: "user" as const, body: "Saved", createdAtLabel: "Now" },
    ];
    const optimistic = [
      { id: "command-1:user", author: "user" as const, body: "Pending", createdAtLabel: "Now" },
      {
        id: "command-2:failure",
        author: "system" as const,
        body: "Needs attention",
        createdAtLabel: "Now",
      },
    ];

    expect(mergeAuthoritativeMessages(authoritative, optimistic)).toEqual([
      authoritative[0],
      optimistic[1],
    ]);
  });
});
