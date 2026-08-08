import { isElectron } from "~/env";

/** Renderer-owned surface that keeps Electron's native titlebar visually empty and draggable. */
export function DesktopTitlebarClearance() {
  return isElectron ? <div aria-hidden data-slot="desktop-titlebar-clearance" /> : null;
}
