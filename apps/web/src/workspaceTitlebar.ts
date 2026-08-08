export const COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS =
  "[[data-sidebar-state=collapsed]_&]:pl-[var(--workspace-titlebar-content-left)]";

/** Keep standard topbar content outside Electron's native caption buttons. */
export const NATIVE_WINDOW_CONTROLS_TITLEBAR_INSET_CLASS =
  "pr-[max(var(--workspace-native-controls-inset),0.75rem)] sm:pr-[max(var(--workspace-native-controls-inset),1.25rem)]";

/** Reserve room for native caption buttons plus app-owned actions in a right panel. */
export const NATIVE_WINDOW_CONTROLS_WITH_ACTIONS_TITLEBAR_INSET_CLASS =
  "pr-[max(7rem,calc(var(--workspace-native-controls-inset)+6rem))]";
