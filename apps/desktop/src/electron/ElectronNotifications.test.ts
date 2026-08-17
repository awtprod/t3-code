import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { beforeEach, vi } from "vite-plus/test";

const { isSupportedMock, notificationInstances, NotificationConstructorMock } = vi.hoisted(() => {
  const instances: Array<{
    readonly listeners: Record<string, Array<() => void>>;
    readonly show: ReturnType<typeof vi.fn>;
  }> = [];
  const constructorMock = vi.fn(function MockNotification(
    this: unknown,
    _options: { title: string; body: string; silent: boolean },
  ) {
    const listeners: Record<string, Array<() => void>> = {};
    const instance = {
      listeners,
      show: vi.fn(),
      on: (event: string, listener: () => void) => {
        listeners[event] = [...(listeners[event] ?? []), listener];
      },
    };
    instances.push(instance);
    return instance;
  });
  return {
    isSupportedMock: vi.fn(() => true),
    notificationInstances: instances,
    NotificationConstructorMock: constructorMock,
  };
});

vi.mock("electron", () => ({
  Notification: Object.assign(NotificationConstructorMock, { isSupported: isSupportedMock }),
}));

import * as ElectronNotifications from "./ElectronNotifications.ts";

describe("ElectronNotifications", () => {
  beforeEach(() => {
    isSupportedMock.mockReset().mockReturnValue(true);
    NotificationConstructorMock.mockClear();
    notificationInstances.length = 0;
  });

  it.effect("shows a notification with the given title, body, and silent flag", () =>
    Effect.gen(function* () {
      const notifications = yield* ElectronNotifications.ElectronNotifications;
      yield* notifications.show({
        title: "Thread finished",
        body: "Completed: My Project",
        silent: true,
        onActivate: () => {},
      });

      assert.equal(NotificationConstructorMock.mock.calls.length, 1);
      assert.deepEqual(NotificationConstructorMock.mock.calls[0]?.[0], {
        title: "Thread finished",
        body: "Completed: My Project",
        silent: true,
      });
      assert.equal(notificationInstances[0]?.show.mock.calls.length, 1);
    }).pipe(Effect.provide(ElectronNotifications.layer)),
  );

  it.effect("calls onActivate when the notification is clicked", () =>
    Effect.gen(function* () {
      const notifications = yield* ElectronNotifications.ElectronNotifications;
      let activated = false;
      yield* notifications.show({
        title: "t",
        body: "b",
        silent: false,
        onActivate: () => {
          activated = true;
        },
      });

      const [instance] = notificationInstances;
      instance?.listeners.click?.forEach((listener) => listener());

      assert.isTrue(activated);
    }).pipe(Effect.provide(ElectronNotifications.layer)),
  );

  it.effect("does nothing when the platform does not support notifications", () =>
    Effect.gen(function* () {
      isSupportedMock.mockReturnValue(false);
      const notifications = yield* ElectronNotifications.ElectronNotifications;
      yield* notifications.show({ title: "t", body: "b", silent: false, onActivate: () => {} });

      assert.equal(NotificationConstructorMock.mock.calls.length, 0);
    }).pipe(Effect.provide(ElectronNotifications.layer)),
  );

  it.effect("never fails, even when Notification construction throws", () =>
    Effect.gen(function* () {
      NotificationConstructorMock.mockImplementationOnce(() => {
        throw new Error("boom");
      });
      const notifications = yield* ElectronNotifications.ElectronNotifications;
      // Would throw/fail the test if `show` propagated the defect.
      yield* notifications.show({ title: "t", body: "b", silent: false, onActivate: () => {} });
    }).pipe(Effect.provide(ElectronNotifications.layer)),
  );
});
