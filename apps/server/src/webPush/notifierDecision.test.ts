import type { WebPushPreferences } from "@t3tools/contracts";
import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import { describe, expect, it } from "vite-plus/test";

import { agentAwarenessPublishIdentity } from "../relay/AgentAwarenessRelay.ts";
import { buildThreadNotificationPayload } from "./notificationPayload.ts";
import {
  decidePublishAction,
  isNotificationFreshEnough,
  notificationAllowedForPreferences,
  isSpaceAgentQuestion,
  spaceAgentQuestionAllowedForPreferences,
} from "./notifierDecision.ts";

function makeState(
  overrides: Partial<RelayAgentActivityState> & {
    readonly phase: RelayAgentActivityState["phase"];
  },
): RelayAgentActivityState {
  return {
    environmentId: "env-1",
    threadId: "thread-1",
    projectTitle: "Command Center",
    threadTitle: "Fix the widget",
    headline: "Approval needed",
    modelTitle: "opus",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deepLink: "/threads/env-1/thread-1",
    ...overrides,
  } as RelayAgentActivityState;
}

const ALL_PREFERENCES: WebPushPreferences = {
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
};

describe("decidePublishAction", () => {
  it("is unchanged when the identity matches the previous one", () => {
    const state = makeState({ phase: "running" });
    const identity = agentAwarenessPublishIdentity(state);
    expect(
      decidePublishAction({
        state,
        publishIdentity: identity,
        previousIdentity: identity,
        hasPrevious: true,
        nowMs: 1000,
        existingDeadlineMs: undefined,
      }),
    ).toEqual({ kind: "unchanged" });
  });

  it("proceeds and notifies on a transition into an attention phase", () => {
    const state = makeState({ phase: "waiting_for_approval" });
    const action = decidePublishAction({
      state,
      publishIdentity: agentAwarenessPublishIdentity(state),
      previousIdentity: agentAwarenessPublishIdentity(makeState({ phase: "running" })),
      hasPrevious: true,
      nowMs: 1000,
      existingDeadlineMs: undefined,
    });
    expect(action).toEqual({ kind: "proceed", notify: true });
  });

  it("proceeds without notifying on a transition into a non-attention phase", () => {
    const state = makeState({ phase: "running" });
    const action = decidePublishAction({
      state,
      publishIdentity: agentAwarenessPublishIdentity(state),
      previousIdentity: agentAwarenessPublishIdentity(makeState({ phase: "starting" })),
      hasPrevious: true,
      nowMs: 1000,
      existingDeadlineMs: undefined,
    });
    expect(action).toEqual({ kind: "proceed", notify: false });
  });

  it("defers completed-as-first-state, then proceeds once the deadline passes", () => {
    const state = makeState({ phase: "completed" });
    const identity = agentAwarenessPublishIdentity(state);
    const deferred = decidePublishAction({
      state,
      publishIdentity: identity,
      previousIdentity: undefined,
      hasPrevious: false,
      nowMs: 1000,
      existingDeadlineMs: undefined,
    });
    expect(deferred).toEqual({ kind: "defer", deadlineMs: 6000 });

    expect(
      decidePublishAction({
        state,
        publishIdentity: identity,
        previousIdentity: undefined,
        hasPrevious: false,
        nowMs: 3000,
        existingDeadlineMs: 6000,
      }),
    ).toEqual({ kind: "await-deadline" });

    expect(
      decidePublishAction({
        state,
        publishIdentity: identity,
        previousIdentity: undefined,
        hasPrevious: false,
        nowMs: 6001,
        existingDeadlineMs: 6000,
      }),
    ).toEqual({ kind: "proceed", notify: true });
  });

  it("defers a tombstone that follows a live state", () => {
    const previous = agentAwarenessPublishIdentity(makeState({ phase: "running" }));
    const action = decidePublishAction({
      state: null,
      publishIdentity: agentAwarenessPublishIdentity(null),
      previousIdentity: previous,
      hasPrevious: true,
      nowMs: 1000,
      existingDeadlineMs: undefined,
    });
    expect(action).toEqual({ kind: "defer", deadlineMs: 6000 });
  });
});

describe("notificationAllowedForPreferences", () => {
  it("gates each attention phase on its matching switch", () => {
    expect(
      notificationAllowedForPreferences(
        { ...ALL_PREFERENCES, notifyOnApproval: false },
        "waiting_for_approval",
      ),
    ).toBe(false);
    expect(notificationAllowedForPreferences(ALL_PREFERENCES, "waiting_for_approval")).toBe(true);
    expect(notificationAllowedForPreferences(ALL_PREFERENCES, "completed")).toBe(true);
    expect(
      notificationAllowedForPreferences({ ...ALL_PREFERENCES, notifyOnFailure: false }, "failed"),
    ).toBe(false);
  });

  it("never notifies for non-attention phases", () => {
    expect(notificationAllowedForPreferences(ALL_PREFERENCES, "running")).toBe(false);
    expect(notificationAllowedForPreferences(ALL_PREFERENCES, "starting")).toBe(false);
  });
});

describe("isNotificationFreshEnough", () => {
  it("keeps non-terminal states always fresh", () => {
    const state = makeState({
      phase: "waiting_for_approval",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(isNotificationFreshEnough(state, Date.parse("2026-01-01T01:00:00.000Z"))).toBe(true);
  });

  it("drops terminal states older than the freshness window", () => {
    const state = makeState({ phase: "completed", updatedAt: "2026-01-01T00:00:00.000Z" });
    expect(isNotificationFreshEnough(state, Date.parse("2026-01-01T00:01:00.000Z"))).toBe(true);
    expect(isNotificationFreshEnough(state, Date.parse("2026-01-01T00:03:00.000Z"))).toBe(false);
  });
});

describe("buildThreadNotificationPayload", () => {
  it("uses the thread title and `${status}: ${project}` body, clipped to 120 chars", () => {
    const payload = buildThreadNotificationPayload(
      makeState({ phase: "completed", threadTitle: "A".repeat(200), projectTitle: "Proj" }),
    );
    expect(payload.title.length).toBe(120);
    expect(payload.body).toBe("Done: Proj");
    expect(payload.environmentId).toBe("env-1");
    expect(payload.threadId).toBe("thread-1");
    expect(payload.deepLink).toBe("/threads/env-1/thread-1");
    expect(Object.keys(payload).sort()).toEqual(
      ["body", "deepLink", "environmentId", "threadId", "title"].sort(),
    );
  });
});

describe("isSpaceAgentQuestion", () => {
  const question = {
    kind: "decision",
    status: "captured",
    priority: "normal",
    metadata: { spaceAgent: true },
  };

  it("is true only for the agent's Needs You Items", () => {
    expect(isSpaceAgentQuestion(question)).toBe(true);
    expect(isSpaceAgentQuestion({ ...question, kind: "approval" })).toBe(true);
    expect(isSpaceAgentQuestion({ ...question, kind: "task", status: "review" })).toBe(true);
    expect(isSpaceAgentQuestion({ ...question, kind: "task" })).toBe(false);
    expect(isSpaceAgentQuestion({ ...question, metadata: {} })).toBe(false);
    expect(isSpaceAgentQuestion({ ...question, metadata: { spaceAgent: "true" } })).toBe(false);
    expect(isSpaceAgentQuestion({ ...question, metadata: null })).toBe(false);
  });

  it("follows the input preference", () => {
    const preferences = {
      notifyOnApproval: true,
      notifyOnInput: false,
      notifyOnCompletion: true,
      notifyOnFailure: true,
    };
    expect(spaceAgentQuestionAllowedForPreferences(preferences)).toBe(false);
    expect(spaceAgentQuestionAllowedForPreferences({ ...preferences, notifyOnInput: true })).toBe(
      true,
    );
  });
});
