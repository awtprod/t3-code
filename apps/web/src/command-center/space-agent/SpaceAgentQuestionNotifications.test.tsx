import type { CommandCenterSpaceAgentQuestion } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  environmentId: "env-1" as string | null,
  questions: null as ReadonlyArray<unknown> | null,
  settings: {
    desktopNotificationsEnabled: true,
    desktopNotifyOnInput: true,
    notificationSoundEnabled: true,
  },
  showNotification: vi.fn((_input: unknown) => Promise.resolve()),
}));

vi.mock("../../hooks/useSettings", () => ({ getClientSettings: () => state.settings }));
vi.mock("../../state/environments", () => ({ usePrimaryEnvironmentId: () => state.environmentId }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: state.questions }) }));
vi.mock("../../state/commandCenter", () => ({
  commandCenterEnvironment: { spaceAgentQuestions: () => ({}) },
}));

import { SpaceAgentQuestionNotifications } from "./SpaceAgentQuestionNotifications";

const question = (itemId: string, title: string): CommandCenterSpaceAgentQuestion =>
  ({
    spaceId: "acme",
    itemId,
    threadId: "cc-space-agent-acme",
    title,
    occurredAt: "2026-10-21T09:00:00.000Z",
  }) as unknown as CommandCenterSpaceAgentQuestion;

let renderer: ReactTestRenderer | undefined;

async function render(questions: ReadonlyArray<CommandCenterSpaceAgentQuestion> | null) {
  state.questions = questions;
  await act(() => {
    if (renderer) renderer.update(<SpaceAgentQuestionNotifications />);
    else renderer = create(<SpaceAgentQuestionNotifications />);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(state, {
    environmentId: "env-1",
    questions: null,
    settings: {
      desktopNotificationsEnabled: true,
      desktopNotifyOnInput: true,
      notificationSoundEnabled: true,
    },
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { desktopBridge: { showNotification: state.showNotification } });
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("SpaceAgentQuestionNotifications", () => {
  it("rings once per question and opens the agent's thread", async () => {
    const first = question("item-1", "Which example vendor?");
    const second = question("item-2", "Ship Friday?");

    await render(null);
    expect(state.showNotification).not.toHaveBeenCalled();

    await render([first]);
    await render([first]);
    expect(state.showNotification).toHaveBeenCalledTimes(1);
    expect(state.showNotification).toHaveBeenLastCalledWith({
      kind: "input-needed",
      title: "Which example vendor?",
      body: "Needs you: your Space agent has a question",
      silent: false,
      threadRef: { environmentId: "env-1", threadId: "cc-space-agent-acme" },
    });

    await render([first, second]);
    expect(state.showNotification).toHaveBeenCalledTimes(2);
    expect(state.showNotification).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Ship Friday?" }),
    );
  });

  it.each(["desktopNotifyOnInput", "desktopNotificationsEnabled"] as const)(
    "stays quiet with %s off, and does not replay the question once it is back on",
    async (setting) => {
      const asked = question("item-1", "Which example vendor?");
      state.settings = { ...state.settings, [setting]: false };

      await render([asked]);
      state.settings = { ...state.settings, [setting]: true };
      await render([asked]);
      expect(state.showNotification).not.toHaveBeenCalled();

      await render([asked, question("item-2", "Ship Friday?")]);
      expect(state.showNotification).toHaveBeenCalledTimes(1);
      expect(state.showNotification).toHaveBeenLastCalledWith(
        expect.objectContaining({ title: "Ship Friday?" }),
      );
    },
  );
});
