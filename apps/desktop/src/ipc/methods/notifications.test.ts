import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type * as Electron from "electron";

import * as ElectronNotifications from "../../electron/ElectronNotifications.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import { showNotification } from "./notifications.ts";

const threadRef = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-1"),
};

function makeLayer(input: {
  readonly onShow?: (activate: () => void) => void;
  readonly sends: Array<{ readonly channel: string; readonly args: readonly unknown[] }>;
  readonly revealed: { count: number };
  readonly onSend?: () => void;
}) {
  return Layer.mergeAll(
    Layer.succeed(ElectronNotifications.ElectronNotifications, {
      show: (showInput) =>
        Effect.sync(() => {
          input.onShow?.(showInput.onActivate);
        }),
    }),
    Layer.succeed(ElectronWindow.ElectronWindow, {
      sendAll: (channel: string, ...args: readonly unknown[]) =>
        Effect.sync(() => {
          input.sends.push({ channel, args });
          input.onSend?.();
        }),
    } as unknown as ElectronWindow.ElectronWindow["Service"]),
    Layer.succeed(DesktopWindow.DesktopWindow, {
      revealOrCreateMain: Effect.sync(() => {
        input.revealed.count += 1;
        return {} as Electron.BrowserWindow;
      }),
    } as unknown as DesktopWindow.DesktopWindow["Service"]),
  );
}

describe("notifications.showNotification", () => {
  it.effect("shows a notification with the decoded title, body, and silent flag", () => {
    const shown: unknown[] = [];
    return Effect.gen(function* () {
      yield* showNotification.handler({
        kind: "completed",
        title: "Thread finished",
        body: "Completed: My Project",
        silent: false,
        threadRef,
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          onShow: () => shown.push("shown"),
          sends: [],
          revealed: { count: 0 },
        }),
      ),
      Effect.tap(() => Effect.sync(() => assert.equal(shown.length, 1))),
    );
  });

  it.effect("reveals the window and sends the activation on click", () =>
    Effect.gen(function* () {
      const sends: Array<{ readonly channel: string; readonly args: readonly unknown[] }> = [];
      const revealed = { count: 0 };
      let signalActivation!: () => void;
      const activationSent = new Promise<void>((resolve) => {
        signalActivation = resolve;
      });
      const activateRef: { current: (() => void) | null } = { current: null };

      yield* showNotification
        .handler({
          kind: "approval-needed",
          title: "t",
          body: "b",
          silent: false,
          threadRef,
        })
        .pipe(
          Effect.provide(
            makeLayer({
              onShow: (activate) => {
                activateRef.current = activate;
              },
              sends,
              revealed,
              onSend: signalActivation,
            }),
          ),
        );

      activateRef.current?.();
      // The activation runs on its own promise outside this fiber.
      yield* Effect.promise(() => activationSent);

      assert.equal(revealed.count, 1);
      assert.deepEqual(sends, [
        { channel: "desktop:notification-activated", args: [{ threadRef }] },
      ]);
    }),
  );
});
