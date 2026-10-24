import { CommandCenterSidebarShortcutKey } from "@t3tools/contracts/settings";

/** Where each Command Center sidebar shortcut goes and what it is called. */
const SHORTCUT_DESTINATIONS = {
  inbox: { to: "/inbox", label: "Needs You" },
  new: { to: "/new", label: "New thread" },
  command: { to: "/command", label: "Command" },
  automations: { to: "/automations", label: "Automations" },
  responsibilities: { to: "/responsibilities", label: "Responsibilities" },
  prospects: { to: "/prospects", label: "Prospects" },
  "sprint-plan": { to: "/sprint-plan", label: "Sprint plan" },
  observations: { to: "/observations", label: "Observations" },
  lessons: { to: "/lessons", label: "Lessons" },
  resources: { to: "/resources", label: "Resources" },
} as const satisfies Record<CommandCenterSidebarShortcutKey, { to: string; label: string }>;

/** Every shortcut in canonical sidebar order, which is the order the contract lists the keys. */
export const COMMAND_CENTER_SHORTCUTS = CommandCenterSidebarShortcutKey.literals.map((key) => ({
  key,
  ...SHORTCUT_DESTINATIONS[key],
}));

export type CommandCenterShortcut = (typeof COMMAND_CENTER_SHORTCUTS)[number];

/** The shortcuts the user has switched on, in canonical order whatever order they were stored in. */
export function visibleCommandCenterShortcuts(
  visibleKeys: ReadonlyArray<CommandCenterSidebarShortcutKey>,
): ReadonlyArray<CommandCenterShortcut> {
  const visible = new Set(visibleKeys);
  return COMMAND_CENTER_SHORTCUTS.filter((shortcut) => visible.has(shortcut.key));
}

/**
 * Where `/` lands: the first visible shortcut. With none visible it falls back
 * to the inbox, which has always been the landing page.
 */
export function commandCenterLandingShortcut(
  visibleKeys: ReadonlyArray<CommandCenterSidebarShortcutKey>,
): CommandCenterShortcut {
  return visibleCommandCenterShortcuts(visibleKeys)[0] ?? COMMAND_CENTER_SHORTCUTS[0]!;
}

/** The inbox owns `/`, `/new` is a single page, and every other shortcut owns its subtree. */
export function isCommandCenterShortcutActive(
  shortcut: CommandCenterShortcut,
  pathname: string,
): boolean {
  if (shortcut.key === "inbox") return pathname === "/" || pathname.startsWith(shortcut.to);
  if (shortcut.key === "new") return pathname === shortcut.to;
  return pathname.startsWith(shortcut.to);
}

/** The visible keys after switching `key` on or off, still in canonical order and duplicate-free. */
export function toggleCommandCenterShortcut(
  visibleKeys: ReadonlyArray<CommandCenterSidebarShortcutKey>,
  key: CommandCenterSidebarShortcutKey,
  visible: boolean,
): ReadonlyArray<CommandCenterSidebarShortcutKey> {
  const next = new Set(visibleKeys);
  if (visible) next.add(key);
  else next.delete(key);
  return visibleCommandCenterShortcuts([...next]).map((shortcut) => shortcut.key);
}
