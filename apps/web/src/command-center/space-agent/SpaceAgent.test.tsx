import type { CommandCenterSpaceAgentSummary } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  describeSpaceAgentError,
  enabledSpaceAgents,
  isSpaceAgentThreadId,
  spaceAgentThreadIds,
  spaceIdFromSpaceAgentThreadId,
} from "./SpaceAgent.logic";
import { SidebarProvider } from "../../components/ui/sidebar";
import { SpaceAgentsSidebarGroupView } from "./SpaceAgentsSidebarGroup";
import { SpaceAgentActivityList } from "./SpaceAgentThreadControls";

const agent = (overrides: Record<string, unknown>): CommandCenterSpaceAgentSummary =>
  ({
    spaceId: "acme",
    displayName: "Acme",
    enabled: true,
    paused: false,
    threadId: "cc-space-agent-acme",
    lastWakeAt: null,
    wakesToday: 0,
    pendingEvents: 0,
    ...overrides,
  }) as unknown as CommandCenterSpaceAgentSummary;

describe("SpaceAgent.logic", () => {
  it("recognises agent thread ids", () => {
    expect(isSpaceAgentThreadId("cc-space-agent-acme")).toBe(true);
    expect(isSpaceAgentThreadId("thread-1")).toBe(false);
    expect(spaceIdFromSpaceAgentThreadId("cc-space-agent-acme")).toBe("acme");
    expect(spaceIdFromSpaceAgentThreadId("thread-1")).toBeNull();
  });

  it("keeps only enabled agents, sorted, and collects their thread ids", () => {
    const agents = enabledSpaceAgents([
      agent({ spaceId: "zeta", displayName: "Zeta", threadId: null }),
      agent({ spaceId: "off", displayName: "Off", enabled: false }),
      agent({}),
    ]);
    expect(agents.map((a) => a.spaceId)).toEqual(["acme", "zeta"]);
    expect([...spaceAgentThreadIds(agents)]).toEqual(["cc-space-agent-acme"]);
  });

  it("explains a busy agent", () => {
    expect(describeSpaceAgentError({ reason: "conflict", message: "x" }, "failed")).toMatch(/busy/);
  });
});

describe("SpaceAgentsSidebarGroupView", () => {
  const noop = () => {};
  it("renders nothing without enabled agents", () => {
    expect(
      renderToStaticMarkup(
        <SpaceAgentsSidebarGroupView
          agents={[]}
          activeThreadId={null}
          pendingSpaceId={null}
          onOpen={noop}
          onWake={noop}
        />,
      ),
    ).toBe("");
  });

  it("shows paused state and Wake now for agents without a thread", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider>
        <SpaceAgentsSidebarGroupView
          agents={[
            agent({ paused: true }),
            agent({ spaceId: "example", displayName: "Example", threadId: null }),
          ]}
          activeThreadId={null}
          pendingSpaceId={null}
          onOpen={noop}
          onWake={noop}
        />
      </SidebarProvider>,
    );
    expect(html).toContain("Spaces");
    expect(html).toContain("Paused");
    expect(html).toContain("Wake now");
    expect(html).toContain("sidebar-space-agent-example");
  });
});

describe("SpaceAgentActivityList", () => {
  it("renders entries with PR links", () => {
    const html = renderToStaticMarkup(
      <SpaceAgentActivityList
        error={null}
        entries={[
          {
            occurredAt: new Date().toISOString(),
            title: "Fix login",
            status: "completed",
            summary: "",
            url: "https://github.com/acme/app/pull/1",
            sourceKind: "thread",
            sourceId: "t1",
          } as never,
        ]}
      />,
    );
    expect(html).toContain("Fix login");
    expect(html).toContain("acme/app/pull/1");
  });

  it("renders empty and error states", () => {
    expect(renderToStaticMarkup(<SpaceAgentActivityList error={null} entries={[]} />)).toContain(
      "No activity",
    );
    expect(renderToStaticMarkup(<SpaceAgentActivityList error="boom" entries={null} />)).toContain(
      "boom",
    );
  });
});
