/**
 * Pure state for the preview surface used outside Electron.
 *
 * In the desktop app a preview is an out-of-process `<webview>` positioned over
 * the panel. A plain browser has no such element, so there the preview is an
 * iframe. That is only viable because the preview gateway is mounted at the
 * **root** of its own origin: the framed dev server sees itself at `/`, so its
 * absolute URLs and HMR socket resolve exactly as they would if the page had
 * been opened directly.
 */

import type { PreviewNavStatus } from "@t3tools/contracts";

export interface WebPreviewFrameState {
  /** URL to frame. */
  readonly src: string;
  /**
   * React key for the iframe element. Reload works by changing it: a
   * cross-origin frame cannot be told to reload itself (`contentWindow.location`
   * is blocked), so the only reload available is to discard the element and let
   * React mount a fresh one, which performs a new navigation.
   */
  readonly key: string;
}

export function resolveWebPreviewFrameState(input: {
  readonly navStatus: PreviewNavStatus;
  readonly reloadNonce: number;
}): WebPreviewFrameState | null {
  const { navStatus } = input;
  // `Idle` has no URL yet. `LoadFailed` is already covered by the unreachable
  // overlay, and framing the failing URL underneath it would load it a second
  // time for something the user cannot see.
  if (navStatus._tag === "Idle" || navStatus._tag === "LoadFailed") return null;
  return { src: navStatus.url, key: `${input.reloadNonce}:${navStatus.url}` };
}
