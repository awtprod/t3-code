import { EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("@t3tools/client-runtime/relay", () => ({ managedRelaySessionAtom: {} }));
vi.mock("../../state/commandCenter", () => ({
  commandCenterEnvironment: new Proxy(
    {},
    { get: (_target, method) => (args: unknown) => ({ method: String(method), args }) },
  ),
}));

const title = "A long decision title that must stay readable without making the row enormous";
const description =
  "This is the complete description retained for assistive context even though the visual list preview is limited to two lines.";

vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (query: { readonly method?: string } | null) => ({
    data:
      query?.method === "inbox"
        ? {
            items: [
              {
                item: {
                  id: "item-1",
                  title,
                  description,
                  kind: "decision",
                  priority: "normal",
                  status: "ready",
                },
                state: {
                  spaceId: "space-1",
                  updatedAt: "2026-10-20T12:00:00.000Z",
                  unresolvedChangeRequestCount: 0,
                  candidateCount: 0,
                },
              },
            ],
            nextCursor: undefined,
          }
        : null,
    error: null,
    isPending: false,
    refresh: vi.fn(),
  }),
}));
vi.mock("../../state/session", () => ({
  usePreparedConnection: () => ({ _tag: "None" }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));

const { InboxScreen } = await import("./InboxScreen");
let renderer: ReactTestRenderer | null = null;

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = null;
});

describe("InboxScreen layout", () => {
  it("renders one page heading and keeps complete text behind two-line list previews", async () => {
    await act(() => {
      renderer = create(
        <InboxScreen
          canApprove={false}
          environmentId={EnvironmentId.make("server")}
          environmentOptions={[]}
          onEnvironmentChange={() => undefined}
          onItemChange={() => undefined}
          onSelectItem={() => undefined}
          onSpaceChange={() => undefined}
          onTabChange={() => undefined}
          runs={[]}
          spaces={[
            {
              id: "space-1",
              displayName: "Command Center",
            } as never,
          ]}
          tab="actionable"
        />,
      );
    });

    const headings = renderer!.root.findAllByType("h1");
    expect(headings).toHaveLength(1);
    expect(headings[0]?.children).toEqual(["Inbox"]);

    const titlePreview = renderer!.root.find(
      (node) => node.type === "span" && node.children.join("") === title,
    );
    const descriptionPreview = renderer!.root.find(
      (node) => node.type === "span" && node.children.join("") === description,
    );
    expect(titlePreview.children).toEqual([title]);
    expect(descriptionPreview.children).toEqual([description]);
    expect(titlePreview.props.className).toContain("line-clamp-2");
    expect(descriptionPreview.props.className).toContain("line-clamp-2");
    expect(descriptionPreview.props.className).not.toMatch(/(?:^|\s)block(?:\s|$)/u);
  });
});
