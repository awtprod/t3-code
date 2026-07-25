/*
 * The preview iframe below is deliberately unsandboxed; see the comment at the
 * element for why a sandbox permissive enough to be useful here would also be
 * equivalent to none. This file contains exactly one iframe.
 */
/* oxlint-disable react/iframe-missing-sandbox */
"use client";

import type { PreviewNavStatus, ScopedThreadRef } from "@t3tools/contracts";
import { useCallback, useRef } from "react";

import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";

import { resolveWebPreviewFrameState } from "./webPreviewFrame";

/**
 * The preview surface for a plain browser, where there is no Electron
 * `<webview>` to position over the panel.
 *
 * This is an iframe rather than a popped-out tab because the preview panel is
 * the point: the user wants the running app beside the thread that is changing
 * it. Framing only works because the gateway is mounted at the root of its own
 * origin, so the dev server inside the frame sees itself at `/`.
 *
 * What the desktop surface has and this one does not, honestly: no in-frame URL
 * tracking, no history, no screenshot/element-pick, no device viewport. All of
 * those need to read or drive the guest document, which the same-origin policy
 * forbids for a cross-origin frame. The affordances that depend on them are
 * already gated on the desktop bridge at their call sites.
 */
export function WebPreviewFrame(props: {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly navStatus: PreviewNavStatus;
  readonly reloadNonce: number;
  readonly className?: string;
}) {
  const { threadRef, tabId, navStatus, reloadNonce, className } = props;
  const reportStatus = useAtomCommand(previewEnvironment.reportStatus, "preview status report");
  const frame = resolveWebPreviewFrameState({ navStatus, reloadNonce });
  const reportedRef = useRef<string | null>(null);

  const handleLoad = useCallback(() => {
    if (!frame) return;
    // `load` is the only navigation signal a cross-origin frame gives us, and
    // it fires again on every reload, so dedupe on the URL we last reported.
    // Without this the server's snapshot would stay `Loading` forever and the
    // chrome row would show a permanent progress bar.
    if (reportedRef.current === frame.key) return;
    reportedRef.current = frame.key;
    void reportStatus({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        tabId,
        // The title lives in the guest document, which is cross-origin. The
        // server keeps the previous title when this is empty.
        navStatus: { _tag: "Success", url: frame.src, title: "" },
        canGoBack: false,
        canGoForward: false,
      },
    });
  }, [frame, reportStatus, tabId, threadRef]);

  if (!frame) return null;

  return (
    <iframe
      key={frame.key}
      src={frame.src}
      onLoad={handleLoad}
      title="Preview"
      className={className}
      /*
       * Deliberately unsandboxed. The guest is the user's own app under test,
       * reached through their own authenticated gateway — it needs scripts,
       * storage, workers, and its own origin, and a sandbox that grants all of
       * those (`allow-scripts allow-same-origin`) is equivalent to none while
       * additionally breaking service-worker registration.
       *
       * It is not our origin either way: the gateway always answers on a
       * different port from the app, so the frame cannot reach this document.
       */
      referrerPolicy="no-referrer"
      data-web-preview-frame={tabId}
    />
  );
}
