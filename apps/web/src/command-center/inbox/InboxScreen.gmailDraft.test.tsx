import { Space } from "@command-center/core";
import { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { GMAIL_DRAFT_DETAIL } from "./InboxScreen.test-fixtures";

// Render the real Inbox detail pane for an accepted Gmail draft proposal. Only
// the data hooks are replaced: the detail query returns the fixture, the draft
// receipt query reports no draft yet, and commands are inert spies.
const approveDraftCalls = vi.hoisted(() => [] as unknown[]);
vi.mock("../../state/commandCenter", () => ({
  commandCenterEnvironment: new Proxy(
    {},
    { get: (_target, method) => (args: unknown) => ({ method: String(method), args }) },
  ),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (query: { readonly method: string } | null) => ({
    data: query?.method === "inboxDetail" ? GMAIL_DRAFT_DETAIL : null,
    error: null,
    isPending: false,
    refresh: () => undefined,
  }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => async (input: unknown) => {
    approveDraftCalls.push(input);
    return { _tag: "Success", value: null };
  },
}));

const { InboxDetailPane } = await import("./InboxScreen");

const space = Schema.decodeUnknownSync(Space)({
  id: GMAIL_DRAFT_DETAIL.state.spaceId,
  slug: "qa-space",
  displayName: "QA Space",
  kind: "personal",
  instructions: "Synthetic QA space.",
  policy: { allowedCapabilities: [], autoRunRiskLevels: ["low", "reversible"] },
  connectionIds: [],
  repositories: [],
  aliases: [],
  lifecycle: "active",
  createdAt: GMAIL_DRAFT_DETAIL.item.createdAt,
  updatedAt: GMAIL_DRAFT_DETAIL.item.createdAt,
});

const render = (canApprove: boolean) =>
  renderToStaticMarkup(
    <InboxDetailPane
      canApprove={canApprove}
      environmentId={EnvironmentId.make("qa-environment")}
      itemId={GMAIL_DRAFT_DETAIL.item.id}
      onBack={() => undefined}
      onChanged={() => undefined}
      runs={[]}
      space={space}
    />,
  );

const approveDraftButton = (html: string) => {
  const match = /<button[^>]*>(?:(?!<\/button>).)*Approve draft<\/button>/su.exec(html);
  if (match === null) throw new Error("Approve draft button was not rendered");
  return match[0];
};

describe("Inbox Gmail draft approval authority", () => {
  it("disables Approve draft and explains why when the session cannot approve", () => {
    const html = render(false);
    expect(html).toContain("Gmail draft approval");
    expect(html).toContain("This session lacks approval authority.");
    expect(approveDraftButton(html)).toMatch(/\sdisabled=""/u);
    expect(approveDraftCalls).toEqual([]);
  });

  it("enables Approve draft for the same proposal when the session can approve", () => {
    const html = render(true);
    expect(html).toContain("Gmail draft approval");
    expect(html).not.toContain("This session lacks approval authority.");
    expect(approveDraftButton(html)).not.toMatch(/\sdisabled=""/u);
  });
});
