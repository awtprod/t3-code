import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  CommandCenterShell,
  ContextRail,
  Messages,
  NeedsYouRows,
  buildCommandCenterSuggestions,
  shouldSubmitCommandComposerOnKeyDown,
} from "./CommandCenterShell";
import type {
  CommandCenterMessage,
  CommandCenterRouteReceipt,
  CommandCenterShellProps,
} from "./types";

const FIXTURE: CommandCenterShellProps = {
  activeConversationId: "conversation-1",
  context: {
    activeRuns: [
      {
        agentKind: "coding",
        detail: "Reviewing changes",
        id: "run-1",
        spaceName: "Studio",
        status: "running",
        title: "Prepare the release notes",
      },
    ],
    connections: [
      {
        detail: "Read-only",
        id: "connection-1",
        name: "Calendar",
        status: "healthy",
      },
    ],
    needsYou: [
      {
        detail: "Confirm before publishing",
        id: "decision-1",
        reason: "approval",
        spaceId: "studio",
        spaceName: "Studio",
        title: "Review the proposed release",
        action: {
          kind: "approval",
          approvalId: "approval-1",
          proposal: "Command: publish the reviewed release\nTarget: public registry",
          payloadDigest: "a".repeat(64),
        },
      },
    ],
    today: [
      {
        id: "today-1",
        kind: "calendar",
        spaceId: "studio",
        timeLabel: "2:00 PM",
        title: "Planning session",
      },
    ],
  },
  conversationTitle: "Command",
  conversations: [
    {
      agentKind: "assistant",
      id: "conversation-1",
      preview: "Draft is ready for review",
      spaceId: "studio",
      status: "running",
      title: "Prepare the release",
      updatedAtLabel: "Now",
    },
  ],
  draft: "",
  messages: [
    {
      author: "user",
      body: "Prepare a concise release plan.",
      createdAtLabel: "10:30 AM",
      id: "message-1",
    },
    {
      author: "system",
      authorLabel: "Route receipt",
      body: "The route is active.",
      createdAtLabel: "10:30 AM",
      id: "message-route-1",
    },
    {
      author: "assistant",
      body: "I’ll review the current work and return a plan.",
      createdAtLabel: "10:30 AM",
      id: "message-2",
      linkedThreadId: "thread-1",
    },
  ],
  onDraftChange: vi.fn(),
  onCapture: vi.fn(async () => true),
  onClearTranscript: vi.fn(),
  onDecideApproval: vi.fn(),
  onDismissNeedsYouItems: vi.fn(),
  onModelSelectionChange: vi.fn(),
  onOpenLinkedThread: vi.fn(),
  onSubmit: vi.fn(),
  projects: [
    {
      id: "project-studio",
      name: "Studio Project",
      repositoryId: "studio-repository",
      repositoryName: "Studio App",
      spaceId: "studio",
    },
  ],
  routeReceipt: {
    capabilities: ["cc.runs.start"],
    modelName: "Balanced",
    providerName: "Auto",
    projectName: "Studio Project",
    repositoryName: "Studio App",
    risk: "low",
    sources: {
      model: "provider-default",
      project: "explicit",
      provider: "fallback",
      repository: "explicit",
      space: "explicit",
    },
    spaceName: "Studio",
    status: "running",
    summary: "Review the project and prepare a reversible local draft.",
  },
  routeOptions: {
    models: [
      {
        id: "balanced",
        label: "Balanced",
        detail: "Example Provider",
        providerId: "provider-example",
      },
    ],
    projects: [{ id: "project-studio", label: "Studio Project", detail: "Studio App" }],
    providers: [{ id: "provider-example", label: "Example Provider", detail: "Ready" }],
    repositories: [{ id: "studio-repository", label: "Studio App", detail: "Studio" }],
  },
  routeSelection: {
    modelId: "balanced",
    projectId: "project-studio",
    providerId: "provider-example",
    repositoryId: "studio-repository",
    spaceId: "studio",
  },
  selectedProjectId: "project-studio",
  selectedSpaceId: "studio",
  spaces: [
    {
      description: "Product and design work",
      id: "studio",
      kind: "business",
      name: "Studio",
      unreadCount: 1,
    },
    {
      description: "Command Center settings",
      id: "operations",
      kind: "system",
      name: "Operations",
    },
  ],
};

describe("CommandCenterShell", () => {
  it("submits on Enter but preserves Shift+Enter for a newline", () => {
    expect(
      shouldSubmitCommandComposerOnKeyDown({
        key: "Enter",
        shiftKey: false,
        isComposing: false,
      }),
    ).toBe(true);
    expect(
      shouldSubmitCommandComposerOnKeyDown({
        key: "Enter",
        shiftKey: true,
        isComposing: false,
      }),
    ).toBe(false);
    expect(
      shouldSubmitCommandComposerOnKeyDown({
        key: "Enter",
        shiftKey: false,
        isComposing: true,
      }),
    ).toBe(false);
    expect(
      shouldSubmitCommandComposerOnKeyDown({
        key: "a",
        shiftKey: false,
        isComposing: false,
      }),
    ).toBe(false);
  });

  it("renders each historical route receipt from its own message state", () => {
    const completeReceipt: CommandCenterRouteReceipt = {
      ...FIXTURE.routeReceipt,
      spaceName: "Completed Space",
      status: "complete",
      summary: "The completed run settled successfully.",
    };
    const runningReceipt: CommandCenterRouteReceipt = {
      ...FIXTURE.routeReceipt,
      spaceName: "Running Space",
      status: "running",
      summary: "The current run is still active.",
    };
    const messages: readonly CommandCenterMessage[] = [
      {
        id: "completed-route",
        author: "system",
        authorLabel: "Route receipt",
        body: "The run completed.",
        createdAtLabel: "10:30 AM",
        receipt: completeReceipt,
      },
      {
        id: "running-route",
        author: "system",
        authorLabel: "Route receipt",
        body: "The route is active.",
        createdAtLabel: "10:31 AM",
        receipt: runningReceipt,
      },
    ];

    const html = renderToStaticMarkup(<Messages messages={messages} receipt={runningReceipt} />);
    const runningRowStart = html.indexOf(">Working<");
    const completedRow = html.slice(0, runningRowStart);
    const runningRow = html.slice(runningRowStart);

    expect(runningRowStart).toBeGreaterThan(-1);
    expect(completedRow).toContain(">Work complete<");
    expect(completedRow).toContain(">Complete<");
    expect(completedRow).toContain("Completed Space");
    expect(completedRow).not.toContain(">Working<");
    expect(completedRow).not.toContain(">Running<");
    expect(runningRow).toContain(">Working<");
    expect(runningRow).toContain(">Running<");
    expect(runningRow).toContain("Running Space");
  });

  it("renders failed route receipts as destructive and inactive", () => {
    const failedReceipt: CommandCenterRouteReceipt = {
      ...FIXTURE.routeReceipt,
      status: "failed",
      summary: "The run stopped with an error.",
    };
    const html = renderToStaticMarkup(
      <Messages
        messages={[
          {
            id: "failed-route",
            author: "system",
            authorLabel: "Route receipt",
            body: "The run failed.",
            createdAtLabel: "10:30 AM",
            receipt: failedReceipt,
          },
        ]}
        receipt={FIXTURE.routeReceipt}
      />,
    );

    expect(html).toContain(">Run failed<");
    expect(html).toContain(">Failed<");
    expect(html).toContain("bg-destructive");
    expect(html).not.toContain("animate-pulse");
  });

  it("renders the T3 command surface and visible route receipt", () => {
    const html = renderToStaticMarkup(<CommandCenterShell {...FIXTURE} />);

    expect(html).toContain('data-slot="command-center-shell"');
    expect(html).not.toContain('data-slot="command-center-navigation"');
    expect(html).toContain('data-slot="command-center-conversation"');
    expect(html).toContain('aria-label="Current command route"');
    expect(html).toContain("Low risk");
    expect(html).toContain("Studio");
    expect(html).toContain("Studio App");
    expect(html).toContain("Studio Project");
    expect(html).toContain("Balanced");
    expect(html).toContain("cc.runs.start");
    expect(html).toContain("Open linked work");
    expect(html).toContain("Selected");
    expect(html).toContain("max-w-5xl");
    expect(html).toContain("justify-end");
  });

  it("renders persistent shortcuts and a model-only composer", () => {
    const html = renderToStaticMarkup(<CommandCenterShell {...FIXTURE} />);

    expect(html).toContain('aria-label="Open recent Command Center conversations"');
    expect(html).toContain('aria-label="Open live context"');
    expect(html).toContain('aria-label="Command Center shortcuts"');
    expect(html).toContain('aria-label="Space shortcuts"');
    expect(html).toContain("All Spaces");
    expect(html).toContain("Command");
    expect(html).toContain("Capture");
    expect(html).toContain('aria-label="Clear command transcript"');
    expect(html).toContain('aria-label="Model selection"');
    expect(html).not.toContain('aria-label="Space route selection"');
    expect(html).not.toContain('aria-label="Provider route selection"');
    expect(html).not.toContain("Route this command");
    expect(html).toContain("chat-composer-glass");
    expect(html).toContain("Explicit route");
    expect(html).toContain("Ask anything, @tag files/folders, $use skills, or / for commands");
  });

  it("offers dismissal for generic attention items", () => {
    const genericItems = ["one", "two"].map((id) => ({
      id,
      reason: "blocked" as const,
      spaceId: "studio",
      spaceName: "Studio",
      title: `Blocked item ${id}`,
    }));
    const html = renderToStaticMarkup(
      <NeedsYouRows items={genericItems} onDismissNeedsYouItems={FIXTURE.onDismissNeedsYouItems} />,
    );

    expect(html.match(/>Dismiss<\/button>/g)).toHaveLength(2);

    const railHtml = renderToStaticMarkup(
      <ContextRail
        context={{ ...FIXTURE.context, needsYou: genericItems }}
        onDismissNeedsYouItems={FIXTURE.onDismissNeedsYouItems}
      />,
    );
    expect(railHtml).toContain("Dismiss all");
  });

  it("renders a useful, Space-scoped briefing when the transcript is empty", () => {
    const html = renderToStaticMarkup(<CommandCenterShell {...FIXTURE} messages={[]} />);

    expect(html).toContain("A useful place to start");
    expect(html).toContain("Suggested by Command");
    expect(html).toContain("Studio");
    expect(html).toContain("Needs you · 1");
    expect(html).toContain("In progress · 1");
    expect(html).toContain("Today · 1");
  });

  it("fills proactive suggestions from live context and evergreen opportunities", () => {
    const suggestions = buildCommandCenterSuggestions({
      needsYouCount: 2,
      activeRunCount: 0,
      todayCount: 0,
      failedRunCount: 1,
      unhealthyConnectionCount: 0,
    });

    expect(suggestions).toHaveLength(3);
    expect(suggestions.map((suggestion) => suggestion.label)).toEqual([
      "Prioritize 2 attention items",
      "Recover 1 failed run",
      "Recommend my next move",
    ]);
  });

  it("disables submission while the composer is empty", () => {
    const html = renderToStaticMarkup(<CommandCenterShell {...FIXTURE} />);

    expect(html).toContain('aria-label="Send command"');
    expect(html).toMatch(/aria-label="Send command"[^>]*disabled=""/);
  });

  it("keeps the composer input typeable but disables sending when config is missing", () => {
    const html = renderToStaticMarkup(
      <CommandCenterShell
        {...FIXTURE}
        commandUnavailable
        configNotice={{
          status: "missing",
          message: "No configuration was found in the Command Center config directory.",
        }}
        draft="ship the release"
      />,
    );

    // The setup notice explains why sending is disabled.
    expect(html).toContain('data-slot="command-center-config-notice"');
    expect(html).toContain("No configuration was found");

    // The textarea is NOT disabled — the user can always draft a command.
    expect(html).toMatch(/aria-label="Ask Command Center"(?![^>]*disabled)/);

    // Sending is disabled despite a non-empty draft, because the command is unavailable.
    expect(html).toMatch(/aria-label="Send command"[^>]*disabled=""/);
  });

  it("omits the config notice when the configuration is loaded", () => {
    const html = renderToStaticMarkup(<CommandCenterShell {...FIXTURE} draft="ready" />);

    expect(html).not.toContain('data-slot="command-center-config-notice"');
    // With config loaded and a draft present, sending is enabled.
    expect(html).not.toMatch(/aria-label="Send command"[^>]*disabled=""/);
  });
});
