/*
 * The preview iframe below is deliberately unsandboxed; see the comment at the
 * element for why a sandbox permissive enough to be useful here would also be
 * equivalent to none. This file contains exactly one iframe.
 */
/* oxlint-disable react/iframe-missing-sandbox */
"use client";

import type { PreviewNavStatus, ScopedThreadRef } from "@t3tools/contracts";
import { useRef } from "react";

import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";

import { resolveWebPreviewFrameState } from "./webPreviewFrameState";

/**
 * Preview surface for a plain browser (no Electron `<webview>`): an iframe onto
 * the gateway, which is mounted at its own origin root. URL tracking, history,
 * screenshots, element-pick and device viewport are unavailable because they
 * need to read the cross-origin guest document.
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

  const handleLoad = () => {
    if (!frame) return;
    // `load` is the only navigation signal a cross-origin frame gives, and it
    // refires on every reload, so dedupe on the last reported URL.
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
  };

  if (!frame) return null;

  return (
    <iframe
      key={frame.key}
      src={frame.src}
      onLoad={handleLoad}
      title="Preview"
      className={className}
      // Deliberately unsandboxed: a sandbox granting what the guest needs
      // (`allow-scripts allow-same-origin`) is equivalent to none and breaks
      // service-worker registration. The gateway is a different origin anyway.
      referrerPolicy="no-referrer"
      data-web-preview-frame={tabId}
    />
  );
}
