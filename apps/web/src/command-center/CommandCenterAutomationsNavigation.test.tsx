import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { CommandCenterShell } from "./CommandCenterShell";

describe("Command Center automation navigation", () => {
  it("links the primary command rail to the Automations screen", () => {
    const html = renderToStaticMarkup(
      <CommandCenterShell
        context={{ activeRuns: [], connections: [], needsYou: [], today: [] }}
        conversationTitle="Command"
        conversations={[]}
        draft=""
        messages={[]}
        onDraftChange={vi.fn()}
        onSubmit={vi.fn()}
        projects={[]}
        routeReceipt={{
          capabilities: [],
          modelName: "Auto",
          providerName: "Auto",
          projectName: "Auto",
          repositoryName: "Auto",
          risk: "low",
          sources: {
            model: "auto",
            project: "auto",
            provider: "auto",
            repository: "auto",
            space: "auto",
          },
          spaceName: "Unscoped",
          status: "ready",
          summary: "Choose where to start.",
        }}
        routeOptions={{ models: [], projects: [], providers: [], repositories: [] }}
        routeSelection={{}}
        spaces={[]}
      />,
    );

    expect(html).toContain('aria-label="Command Center navigation"');
    expect(html).toMatch(/href="\/automations"[^>]*>.*Automations/s);
  });
});
