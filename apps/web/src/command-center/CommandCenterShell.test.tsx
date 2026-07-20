import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { CommandCenterShell } from "./CommandCenterShell";
import type { CommandCenterShellProps } from "./types";

const FIXTURE: CommandCenterShellProps = {
  activeConversationId: "conversation-1",
  context: {
    activeRuns: [
      {
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
      author: "assistant",
      body: "I’ll review the current work and return a plan.",
      createdAtLabel: "10:30 AM",
      id: "message-2",
      linkedThreadId: "thread-1",
    },
  ],
  onDraftChange: vi.fn(),
  onDecideApproval: vi.fn(),
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
    models: [{ id: "balanced", label: "Balanced" }],
    projects: [{ id: "project-studio", label: "Studio Project", detail: "Studio App" }],
    providers: [{ id: "provider-example", label: "Example Provider", detail: "Ready" }],
    repositories: [{ id: "studio-repository", label: "Studio App", detail: "Studio" }],
  },
  routeSelection: {
    projectId: "project-studio",
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
  it("renders the three-pane command surface and visible route receipt", () => {
    const html = renderToStaticMarkup(<CommandCenterShell {...FIXTURE} />);

    expect(html).toContain('data-slot="command-center-shell"');
    expect(html).toContain('data-slot="command-center-navigation"');
    expect(html).toContain('data-slot="command-center-conversation"');
    expect(html).toContain('data-slot="command-center-context"');
    expect(html).toContain('aria-label="Current command route"');
    expect(html).toContain("Low risk");
    expect(html).toContain("Studio");
    expect(html).toContain("Studio App");
    expect(html).toContain("Studio Project");
    expect(html).toContain("Balanced");
    expect(html).toContain("cc.runs.start");
    expect(html).toContain("Open linked work");
    expect(html).toContain("Selected");
  });

  it("renders responsive controls and context summaries", () => {
    const html = renderToStaticMarkup(<CommandCenterShell {...FIXTURE} />);

    expect(html).toContain('aria-label="Open Spaces and conversations"');
    expect(html).toContain('aria-label="Open live context"');
    expect(html).toContain("Needs You");
    expect(html).toContain("Approve");
    expect(html).toContain("Decline");
    expect(html).toContain("Digest aaaaaaaaaaaa…");
    expect(html).toContain("Active runs");
    expect(html).toContain("Planning session");
    expect(html).toContain("Calendar");
    expect(html).toContain('aria-label="Space route selection"');
    expect(html).toContain('aria-label="Repo route selection"');
    expect(html).toContain('aria-label="Project route selection"');
    expect(html).toContain('aria-label="Provider route selection"');
    expect(html).toContain('aria-label="Model route selection"');
    expect(html).toContain("Explicit route");
  });

  it("disables submission while the composer is empty", () => {
    const html = renderToStaticMarkup(<CommandCenterShell {...FIXTURE} />);

    expect(html).toContain('aria-label="Send command"');
    expect(html).toMatch(/aria-label="Send command"[^>]*disabled=""/);
  });
});
