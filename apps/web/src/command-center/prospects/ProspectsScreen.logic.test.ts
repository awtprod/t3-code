import { describe, expect, it } from "vite-plus/test";

import {
  PROSPECT_ITEM_PREFIX,
  prospectActionForStatus,
  prospectItemsForTab,
  prospectActionStatus,
  prospectUpdateFailureMessage,
  resolveProspectsSpace,
  visibleProspectItems,
} from "./ProspectsScreen.logic";

const item = (overrides: Record<string, unknown>) =>
  ({
    id: `${PROSPECT_ITEM_PREFIX}channel:v1`,
    kind: "decision",
    status: "review",
    updatedAt: "2026-09-19T10:00:00.000Z",
    ...overrides,
  }) as never;

describe("Prospects queue logic", () => {
  it("selects an explicit Space or defaults to the matching prospect Space", () => {
    const spaces = [
      { id: "other", displayName: "Other", slug: "other" },
      { id: "prospects", displayName: "Prospects Growth", slug: "growth" },
    ] as never;
    expect(resolveProspectsSpace(spaces, undefined)?.id).toBe("prospects");
    expect(resolveProspectsSpace(spaces, "other")?.id).toBe("other");
    expect(resolveProspectsSpace(spaces, "missing")?.id).toBe("prospects");
  });

  it("filters the queue into review, snoozed, and reviewed tabs", () => {
    const items = [
      item({ id: `${PROSPECT_ITEM_PREFIX}review:v1`, status: "review" }),
      item({ id: `${PROSPECT_ITEM_PREFIX}in-progress:v1`, status: "in_progress" }),
      item({ id: `${PROSPECT_ITEM_PREFIX}snoozed:v1`, status: "waiting" }),
      item({ id: `${PROSPECT_ITEM_PREFIX}shortlisted:v1`, status: "done" }),
      item({ id: `${PROSPECT_ITEM_PREFIX}passed:v1`, status: "canceled" }),
    ];
    expect(prospectItemsForTab(items, "review").map((candidate) => candidate.status)).toEqual([
      "review",
      "in_progress",
    ]);
    expect(prospectItemsForTab(items, "snoozed").map((candidate) => candidate.status)).toEqual([
      "waiting",
    ]);
    expect(prospectItemsForTab(items, "reviewed").map((candidate) => candidate.status)).toEqual([
      "done",
      "canceled",
    ]);
  });

  it("only shows prospect decisions, including resolved and active states", () => {
    const visible = visibleProspectItems([
      item({ id: `${PROSPECT_ITEM_PREFIX}older:v1`, updatedAt: "2026-09-18T10:00:00.000Z" }),
      item({
        id: `${PROSPECT_ITEM_PREFIX}done:v1`,
        status: "done",
        updatedAt: "2026-09-19T12:00:00.000Z",
      }),
      item({ id: "unrelated-decision", updatedAt: "2026-09-19T13:00:00.000Z" }),
      item({ id: `${PROSPECT_ITEM_PREFIX}task:v1`, kind: "task" }),
    ]);
    expect(visible.map((candidate) => candidate.id)).toEqual([
      `${PROSPECT_ITEM_PREFIX}done:v1`,
      `${PROSPECT_ITEM_PREFIX}older:v1`,
    ]);
  });

  it("maps decisions and all reverseable terminal states without inventing qualification", () => {
    expect(prospectActionStatus("shortlist")).toBe("done");
    expect(prospectActionStatus("pass")).toBe("canceled");
    expect(prospectActionStatus("snooze")).toBe("waiting");
    expect(prospectActionForStatus("done")).toBe("return-to-review");
    expect(prospectActionForStatus("canceled")).toBe("return-to-review");
    expect(prospectActionForStatus("waiting")).toBe("return-to-review");
    expect(prospectActionForStatus("review")).toBeUndefined();
  });

  it("gives an explicit reload recovery path for optimistic concurrency conflicts", () => {
    expect(prospectUpdateFailureMessage("reason: conflict")).toBe(
      "Changed elsewhere; reload and try again.",
    );
    expect(prospectUpdateFailureMessage("connection closed")).toContain("Could not record");
  });
});
