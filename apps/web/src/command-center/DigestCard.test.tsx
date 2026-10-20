// @vitest-environment jsdom

import { EnvironmentId } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { readonly children?: ReactNode }) => <a>{children}</a>,
}));
vi.mock("~/state/commandCenter", () => ({
  commandCenterEnvironment: new Proxy(
    {},
    { get: (_target, method) => (args: unknown) => ({ method: String(method), args }) },
  ),
}));

const digest = {
  recipientSubject: "one-time-token",
  preferences: {
    timezone: "UTC",
    quietStart: null,
    quietEnd: null,
    version: 1,
    source: "personal",
  },
  period: {
    localDate: "2026-10-20",
    startAt: "2026-10-20T00:00:00.000Z",
    endAt: "2026-10-21T00:00:00.000Z",
  },
  snapshot: {
    id: "digest-1",
    recipientSubject: "one-time-token",
    localDate: "2026-10-20",
    timezone: "UTC",
    periodStartAt: "2026-10-20T00:00:00.000Z",
    periodEndAt: "2026-10-21T00:00:00.000Z",
    generatedAt: "2026-10-20T12:00:00.000Z",
    contentDigest: `sha256:${"a".repeat(64)}`,
    supersedesId: null,
    viewedAt: null,
    items: [
      {
        spaceId: "space-1",
        itemId: "item-1",
        revisionId: null,
        itemVersion: 1,
        title: "Review this change",
        kind: "decision",
        status: "ready",
        updatedAt: "2026-10-20T12:00:00.000Z",
      },
    ],
  },
  totalCount: 1,
  truncated: false,
  notification: "available",
};

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (query: { readonly method?: string } | null) => ({
    data:
      query?.method === "digest"
        ? digest
        : query?.method === "bootstrap"
          ? { spaces: [{ id: "space-1", displayName: "Command Center" }] }
          : null,
    error: null,
    isPending: false,
    refresh: vi.fn(),
  }),
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => vi.fn(async () => ({ _tag: "Success", value: null })),
}));

const { DigestCard } = await import("./DigestCard");
let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  await act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

describe("DigestCard", () => {
  it("stays compact until expanded and never exposes the recipient implementation subject", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(() => {
      root?.render(<DigestCard environmentId={EnvironmentId.make("server")} />);
    });

    const disclosure = container.querySelector("details");
    const summary = container.querySelector("summary");
    expect(disclosure?.open).toBe(false);
    expect(summary?.textContent).toContain("Daily digest");
    expect(summary?.textContent).toContain("1 actionable");
    expect(container.textContent).not.toContain("one-time-token");

    await act(() => summary?.click());
    expect(disclosure?.open).toBe(true);
    expect(container.textContent).toContain("Preferences");
    expect(container.textContent).toContain("Mark viewed");
    expect(container.textContent).toContain("Review this change");
  });
});
