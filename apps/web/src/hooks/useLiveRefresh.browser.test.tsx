import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../test/render";
import {
  LIVE_REFRESH_IDLE_AFTER_MS,
  LIVE_REFRESH_MIN_INTERVAL_MS,
  useLiveRefresh,
} from "./useLiveRefresh";

function Probe(props: {
  readonly refresh: () => void;
  readonly viewKey: string;
  readonly enabled?: boolean;
  readonly intervalMs?: number | null;
  readonly refreshOnShow?: boolean;
}) {
  useLiveRefresh(props.refresh, {
    key: props.viewKey,
    enabled: props.enabled ?? true,
    ...(props.intervalMs !== undefined ? { intervalMs: props.intervalMs } : {}),
    ...(props.refreshOnShow !== undefined ? { refreshOnShow: props.refreshOnShow } : {}),
  });
  return null;
}

function PollingProbe(props: { readonly refresh: (() => void) | null; readonly enabled: boolean }) {
  useLiveRefresh(props.refresh, { intervalMs: 45_000, enabled: props.enabled });
  return null;
}

describe("useLiveRefresh", () => {
  it("with refreshOnShow, reads on every show unless it read within the floor", async () => {
    const refresh = vi.fn();
    // The first enable reads the clock.
    using _timers = fakeTimers({ now: 1_000_000 });
    const probe = (enabled: boolean) => (
      <Probe refresh={refresh} viewKey="show" enabled={enabled} refreshOnShow intervalMs={null} />
    );
    // A bare hook probe; nothing here navigates.
    await using screen = await render(probe(true), { router: false });
    expect(refresh).toHaveBeenCalledTimes(1);

    await screen.rerender(probe(false));
    await act(() => vi.advanceTimersByTime(LIVE_REFRESH_MIN_INTERVAL_MS - 1));
    await screen.rerender(probe(true));
    expect(refresh).toHaveBeenCalledTimes(1);

    await screen.rerender(probe(false));
    await act(() => vi.advanceTimersByTime(1));
    await screen.rerender(probe(true));
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("with intervalMs null, never refreshes on a timer", async () => {
    const periodic = vi.fn();
    const untimed = vi.fn();
    // The interaction clock starts when the first view mounts.
    using _timers = fakeTimers({ now: 1_000_000 });
    await using _screen = await render(
      <>
        <Probe refresh={periodic} viewKey="periodic" intervalMs={60_000} />
        <Probe refresh={untimed} viewKey="untimed" intervalMs={null} />
      </>,
      // A bare hook probe; nothing here navigates.
      { router: false },
    );

    // Past the default 5 minute interval, but inside the 6 minute idle cutoff.
    await act(() => vi.advanceTimersByTime(5.5 * 60_000));

    expect(periodic).toHaveBeenCalledTimes(5);
    expect(untimed).not.toHaveBeenCalled();
  });

  it("polls every 45 seconds, pauses while hidden or busy, respects disabling, and cleans up", async () => {
    const refresh = vi.fn();
    const probe = (pending = false, enabled = true) => (
      <PollingProbe refresh={pending ? null : refresh} enabled={enabled} />
    );
    // The first render reads the clock and the visibility.
    using _timers = fakeTimers({ now: 0 });
    using visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    // A bare hook probe; nothing here navigates.
    await using screen = await render(probe(), { router: false });

    await act(() => vi.advanceTimersByTime(44_999));
    expect(refresh).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTime(1));
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTime(45_000));
    expect(refresh).toHaveBeenCalledTimes(2);

    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await act(() => vi.advanceTimersByTime(90_000));
    expect(refresh).toHaveBeenCalledTimes(2);

    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    expect(refresh).toHaveBeenCalledTimes(3);

    await screen.rerender(probe(true));
    await act(() => vi.advanceTimersByTime(45_000));
    expect(refresh).toHaveBeenCalledTimes(3);

    await screen.rerender(probe());
    await act(() => vi.advanceTimersByTime(45_000));
    expect(refresh).toHaveBeenCalledTimes(4);

    await screen.rerender(probe(false, false));
    await act(() => vi.advanceTimersByTime(90_000));
    window.dispatchEvent(new Event("focus"));
    expect(refresh).toHaveBeenCalledTimes(4);

    await screen.unmount();
    await act(() => vi.advanceTimersByTime(45_000));
    expect(refresh).toHaveBeenCalledTimes(4);
  });

  it.each(["focus", "visibilitychange"])(
    "keeps an idle view paused after %s until input",
    async (event) => {
      const refresh = vi.fn();
      // The first render reads the clock and the visibility.
      using _timers = fakeTimers({ now: 1_000_000 });
      using _visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      await using _screen = await render(<PollingProbe refresh={refresh} enabled />, {
        // A bare hook probe; nothing here navigates.
        router: false,
      });

      await act(() => vi.advanceTimersByTime(LIVE_REFRESH_IDLE_AFTER_MS));
      refresh.mockClear();
      await act(() => (event === "focus" ? window : document).dispatchEvent(new Event(event)));
      expect(refresh).not.toHaveBeenCalled();
      await act(() => vi.advanceTimersByTime(90_000));
      expect(refresh).not.toHaveBeenCalled();
      await act(() => document.dispatchEvent(new PointerEvent("pointerdown")));
      expect(refresh).toHaveBeenCalledTimes(1);
      await act(() => vi.advanceTimersByTime(45_000));
      expect(refresh).toHaveBeenCalledTimes(2);
    },
  );
});
