import { describe, expect, it } from "vite-plus/test";

import { isUnattendedThread } from "./threads.ts";

describe("isUnattendedThread", () => {
  it.each([
    ["a scheduled run", "thread-1", "system", true],
    ["a delegated task", "thread-2", "agent", true],
    ["the Space agent", "cc-space-agent-acme", "system", true],
    ["an automation Run", "cc:automation:run-1", "system", true],
    ["a user-started Run", "cc:interactive:run-1", "system", false],
    ["a thread the user opened", "thread-3", "user", false],
  ])("%s", (_label, id, createdBy, expected) => {
    expect(isUnattendedThread({ id, createdBy })).toBe(expected);
  });
});
