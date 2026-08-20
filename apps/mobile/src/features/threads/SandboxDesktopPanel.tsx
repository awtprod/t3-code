import type { EnvironmentId, OrchestrationThreadShell } from "@t3tools/contracts";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Modal, Pressable, View } from "react-native";
import { WebView } from "react-native-webview";

import { AppText as Text } from "../../components/AppText";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

export function SandboxDesktopPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly thread: OrchestrationThreadShell;
}) {
  const sandbox = props.thread.sandbox;
  const [open, setOpen] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewerUrl, setViewerUrl] = useState<string | null>(null);
  const leaseSessionId = useRef(`mobile-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const provision = useAtomCommand(threadEnvironment.provisionSandbox, { reportFailure: false });
  const takeover = useAtomCommand(threadEnvironment.takeOverSandbox, { reportFailure: false });
  const resume = useAtomCommand(threadEnvironment.resumeSandbox, { reportFailure: false });
  const exportBranch = useAtomCommand(threadEnvironment.exportSandboxBranch, {
    reportFailure: false,
  });
  const stop = useAtomCommand(threadEnvironment.stopSandbox, { reportFailure: false });
  const viewerTicket = useAtomCommand(threadEnvironment.requestSandboxViewerTicket, {
    reportFailure: false,
  });

  const run = useCallback(
    async (action: () => Promise<{ readonly _tag: string }>) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        const result = await action();
        if (result._tag === "Failure")
          setError("The sandbox action failed. Refresh and try again.");
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );
  const target = { environmentId: props.environmentId } as const;
  const human = sandbox?.controller.kind === "human" ? sandbox.controller : null;
  // Headless deployments run the sandbox with no desktop, so there is nothing
  // to view or take control of -- but stopping and exporting still apply.
  const desktopUnavailable = sandbox != null && sandbox.desktop.status === "unavailable";
  const stoppable =
    sandbox != null && !["stopped", "expired", "deleted"].includes(sandbox.lifecycle);
  const openViewer = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await viewerTicket({ ...target, input: { threadId: props.thread.id } });
      if (result._tag === "Failure") {
        setError("The desktop viewer ticket was denied or expired.");
        return;
      }
      setViewerUrl(result.value.viewerUrl);
      setGeneration((value) => value + 1);
      setOpen(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View className="border-t border-border bg-card px-4 py-2">
      <View className="flex-row items-center gap-2">
        <View className="min-w-0 flex-1">
          <Text className="text-xs font-t3-bold text-foreground">
            {desktopUnavailable ? "Isolated sandbox" : "Isolated desktop"}
          </Text>
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            {sandbox
              ? `${sandbox.lifecycle.replaceAll("-", " ")} · ${sandbox.branch.branchName}`
              : "Starts on first use"}
          </Text>
        </View>
        {busy ? <ActivityIndicator size="small" /> : null}
        {!sandbox ? (
          <Pressable
            disabled={busy}
            onPress={() =>
              void run(() => provision({ ...target, input: { threadId: props.thread.id } }))
            }
          >
            <Text className="text-sm font-t3-bold text-accent">Start</Text>
          </Pressable>
        ) : null}
        {sandbox?.desktop.status === "ready" ? (
          <Pressable disabled={busy} onPress={() => void openViewer()}>
            <Text className="text-sm font-t3-bold text-accent">Open</Text>
          </Pressable>
        ) : null}
        {sandbox && human === null && sandbox.lifecycle === "ready" && !desktopUnavailable ? (
          <Pressable
            disabled={busy}
            onPress={() =>
              void run(() =>
                takeover({
                  ...target,
                  input: { threadId: props.thread.id, sessionId: leaseSessionId.current },
                }),
              )
            }
          >
            <Text className="text-sm font-t3-bold text-accent">Take control</Text>
          </Pressable>
        ) : null}
        {human ? (
          <Pressable
            disabled={busy}
            onPress={() =>
              void run(() =>
                resume({
                  ...target,
                  input: {
                    threadId: props.thread.id,
                    leaseId: human.leaseId,
                    takeoverSummary:
                      "Mobile desktop control ended; repository and browser state may have changed.",
                  },
                }),
              )
            }
          >
            <Text className="text-sm font-t3-bold text-accent">Resume agent</Text>
          </Pressable>
        ) : null}
        {sandbox ? (
          <Pressable
            disabled={busy}
            onPress={() =>
              void run(() => exportBranch({ ...target, input: { threadId: props.thread.id } }))
            }
          >
            <Text className="text-sm font-t3-bold text-accent">Export</Text>
          </Pressable>
        ) : null}
        {stoppable ? (
          <Pressable
            disabled={busy || human !== null}
            onPress={() =>
              void run(() => stop({ ...target, input: { threadId: props.thread.id } }))
            }
          >
            <Text className="text-sm font-t3-bold text-danger-foreground">Stop</Text>
          </Pressable>
        ) : null}
      </View>
      {sandbox ? (
        <Text className="mt-1 text-[11px] text-foreground-muted">
          Services {sandbox.services.filter((service) => service.status === "healthy").length}/
          {sandbox.services.length}
          {human ? " · human control active" : ""}
        </Text>
      ) : null}
      {error ? <Text className="mt-1 text-xs text-danger">{error}</Text> : null}

      <Modal
        visible={open}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setOpen(false)}
      >
        <View className="flex-1 bg-black">
          <View className="flex-row items-center justify-between bg-card px-4 py-3">
            <Text className="font-t3-bold text-foreground">Thread desktop</Text>
            <View className="flex-row gap-5">
              <Pressable onPress={() => void openViewer()}>
                <Text className="font-t3-bold text-accent">Reconnect</Text>
              </Pressable>
              <Pressable onPress={() => setOpen(false)}>
                <Text className="font-t3-bold text-accent">Close</Text>
              </Pressable>
            </View>
          </View>
          {viewerUrl ? (
            <WebView
              key={`${viewerUrl}:${generation}`}
              source={{ uri: viewerUrl }}
              originWhitelist={[new URL(viewerUrl).origin]}
              javaScriptEnabled
              domStorageEnabled={false}
              sharedCookiesEnabled
              thirdPartyCookiesEnabled={false}
              setSupportMultipleWindows={false}
              allowsFullscreenVideo
              mediaPlaybackRequiresUserAction={false}
              onError={() => setError("The desktop stream disconnected. Reconnect to try again.")}
              style={{ flex: 1, backgroundColor: "black" }}
            />
          ) : null}
        </View>
      </Modal>
    </View>
  );
}
