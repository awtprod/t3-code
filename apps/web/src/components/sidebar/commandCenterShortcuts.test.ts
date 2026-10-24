import { describe, expect, it } from "vite-plus/test";

import {
  COMMAND_CENTER_SHORTCUTS,
  commandCenterLandingShortcut,
  isCommandCenterShortcutActive,
  toggleCommandCenterShortcut,
  visibleCommandCenterShortcuts,
} from "./commandCenterShortcuts";

const byKey = (key: string) => COMMAND_CENTER_SHORTCUTS.find((shortcut) => shortcut.key === key)!;

describe("visibleCommandCenterShortcuts", () => {
  it("lists every shortcut in the sidebar's canonical order", () => {
    expect(COMMAND_CENTER_SHORTCUTS.map((shortcut) => shortcut.label)).toEqual([
      "Needs You",
      "New thread",
      "Command",
      "Automations",
      "Responsibilities",
      "Prospects",
      "Sprint plan",
      "Observations",
      "Lessons",
      "Resources",
    ]);
  });

  it("keeps only the visible shortcuts, in canonical order whatever the stored order", () => {
    expect(
      visibleCommandCenterShortcuts(["resources", "lessons", "new"]).map(({ key }) => key),
    ).toEqual(["new", "lessons", "resources"]);
  });

  it("shows nothing for an empty list", () => {
    expect(visibleCommandCenterShortcuts([])).toEqual([]);
  });
});

describe("commandCenterLandingShortcut", () => {
  it("lands on New thread with the default shortcuts", () => {
    expect(commandCenterLandingShortcut(["new", "resources"]).to).toBe("/new");
  });

  it("lands on the inbox whenever it is visible, since it comes first", () => {
    expect(commandCenterLandingShortcut(["resources", "inbox", "new"]).to).toBe("/inbox");
  });

  it("lands on the first visible shortcut in canonical order, not stored order", () => {
    expect(commandCenterLandingShortcut(["resources", "automations"]).to).toBe("/automations");
  });

  it("falls back to the inbox when every shortcut is hidden", () => {
    expect(commandCenterLandingShortcut([]).to).toBe("/inbox");
  });
});

describe("isCommandCenterShortcutActive", () => {
  it("marks the inbox active on its own pages and on the landing path", () => {
    expect(isCommandCenterShortcutActive(byKey("inbox"), "/")).toBe(true);
    expect(isCommandCenterShortcutActive(byKey("inbox"), "/inbox")).toBe(true);
    expect(isCommandCenterShortcutActive(byKey("resources"), "/")).toBe(false);
  });

  it("matches New thread on its exact page only", () => {
    expect(isCommandCenterShortcutActive(byKey("new"), "/new")).toBe(true);
    expect(isCommandCenterShortcutActive(byKey("new"), "/new/later")).toBe(false);
  });

  it("matches the other shortcuts across their subtree", () => {
    expect(isCommandCenterShortcutActive(byKey("resources"), "/resources/disk")).toBe(true);
    expect(isCommandCenterShortcutActive(byKey("resources"), "/command")).toBe(false);
  });
});

describe("toggleCommandCenterShortcut", () => {
  it("adds a shortcut at its canonical position without duplicating it", () => {
    const next = toggleCommandCenterShortcut(["new", "resources"], "command", true);
    expect(next).toEqual(["new", "command", "resources"]);
    expect(toggleCommandCenterShortcut(next, "command", true)).toEqual(next);
  });

  it("removes a shortcut, down to an empty list", () => {
    expect(toggleCommandCenterShortcut(["new", "resources"], "new", false)).toEqual(["resources"]);
    expect(toggleCommandCenterShortcut(["resources"], "resources", false)).toEqual([]);
  });
});
