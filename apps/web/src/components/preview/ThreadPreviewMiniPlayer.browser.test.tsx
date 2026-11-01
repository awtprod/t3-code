import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { ChatCanvasContext } from "../chat/ChatCanvasContext";
import { resolveChatCanvasLayout } from "../chat/chatCanvasLayout";
import { MiniPlayerShell } from "./ThreadPreviewMiniPlayer";
import { Button } from "~/components/ui/button";
import {
  browserMiniPlayerSource,
  previewMiniPlayerSourceKey,
  selectThreadPreviewMiniPlayer,
  usePreviewMiniPlayerStore,
} from "~/previewMiniPlayerStore";

// Exercise the real shell, UI primitives, store and geometry without rendering
// native surfaces or device streams.
vi.mock("~/browser/BrowserSurfaceSlot", () => ({ BrowserSurfaceSlot: () => null }));
vi.mock("~/browser/ServerBrowserSurface", () => ({ ServerBrowserSurface: () => null }));
vi.mock("../device/DeviceStreamView", () => ({ DeviceStreamView: () => null }));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));

const threadRef = scopeThreadRef("env-test" as EnvironmentId, ThreadId.make("thread-test"));
const source = browserMiniPlayerSource("tab-test");
const noop = () => undefined;

interface Size {
  readonly width: number;
  readonly height: number;
}

const DEFAULT_SIZES = {
  sourceSize: { width: 480, height: 320 },
  containerSize: { width: 800, height: 600 },
};

function playerState() {
  return selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, threadRef);
}

function Player(props: {
  readonly sourceSize: Size;
  readonly containerSize: Size;
  readonly onDock: () => void;
  readonly onPopOut: () => void;
}) {
  const miniPlayer = usePreviewMiniPlayerStore((state) =>
    selectThreadPreviewMiniPlayer(state.byThreadKey, threadRef),
  );
  if (!miniPlayer) return null;
  const key = previewMiniPlayerSourceKey(miniPlayer.source);
  return (
    <ChatCanvasContext
      value={{
        container: props.containerSize,
        lane: { padding: 48, minChatWidth: 640 },
        layout: resolveChatCanvasLayout({
          container: props.containerSize,
          preview: { ...miniPlayer, key, source: props.sourceSize },
        }),
        previewKey: key,
        registerTimeline: noop,
        measureDetailsCard: noop,
        detailsCardTopInset: 0,
        preferredDetailsCard: null,
        detailsCardPlacement: null,
      }}
    >
      <MiniPlayerShell
        threadRef={threadRef}
        miniPlayer={miniPlayer}
        sourceSize={props.sourceSize}
        label="Floating test preview"
        recording
        onOpenInPanel={() => {
          props.onDock();
          usePreviewMiniPlayerStore.getState().close(threadRef);
        }}
        actions={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Pop out preview"
            onClick={props.onPopOut}
          >
            Pop out
          </Button>
        }
      >
        {() => <div>Preview content</div>}
      </MiniPlayerShell>
    </ChatCanvasContext>
  );
}

function setup() {
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
  return {
    dock: vi.fn(),
    popOut: vi.fn(),
    releaseCapture: vi.fn<(pointerId: number) => void>(),
    captures: new Map<Element, number>(),
  };
}

type TestState = ReturnType<typeof setup>;

function player(state: TestState, sizes: typeof DEFAULT_SIZES = DEFAULT_SIZES) {
  return <Player {...sizes} onDock={state.dock} onPopOut={state.popOut} />;
}

async function open() {
  await act(() => {
    const store = usePreviewMiniPlayerStore.getState();
    store.open(threadRef, source);
    store.resize(threadRef, "browser:tab-test", 240, { x: 100, y: 100 });
  });
}

async function mount(state: TestState) {
  await using stack = new AsyncDisposableStack();
  // The shell reads only the canvas context and the store; nothing here links or navigates.
  const screen = stack.use(await render(player(state), { router: false }));
  await open();
  stack.move();
  return Object.assign(screen, {
    element(label: string) {
      const target = screen.container.querySelector<HTMLElement>(`[aria-label="${label}"]`);
      if (!target) throw new Error(`Missing ${label}`);
      return target;
    },
    // Synthetic pointer ids are not active pointers, so the browser rejects real capture.
    // Keep capture state on the dispatched element instead.
    async pointer(target: Element, type: string, options: PointerEventInit = {}) {
      Object.assign(target, {
        setPointerCapture: (pointerId: number) => state.captures.set(target, pointerId),
        hasPointerCapture: (pointerId: number) => state.captures.get(target) === pointerId,
        releasePointerCapture: (pointerId: number) => {
          state.releaseCapture(pointerId);
          state.captures.delete(target);
        },
      });
      const event = new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        pointerId: 1,
        pointerType: "mouse",
        ...options,
      });
      await act(() => target.dispatchEvent(event));
      return event;
    },
    resizeCanvas: (sizes: typeof DEFAULT_SIZES) => screen.rerender(player(state, sizes)),
  });
}

it("exposes move, recording and focusable actions without hover or a revealing tap", async () => {
  const state = setup();
  await using screen = await mount(state);
  const handle = screen.element("Drag to move preview");
  expect(handle.textContent).toContain("Move");
  // The control bar must be exposed before focus, hover or any pointer event.
  expect(handle.parentElement?.classList.contains("opacity-0")).toBe(false);
  expect(handle.parentElement?.classList.contains("pointer-events-none")).toBe(false);
  expect(screen.element("Recording preview").getAttribute("role")).toBe("status");
  for (const label of [
    "Open preview in right panel",
    "Pop out preview",
    "Close floating preview",
  ]) {
    const button = screen.element(label);
    expect(button.tagName).toBe("BUTTON");
    await act(() => button.focus());
    expect(document.activeElement).toBe(button);
    expect(button.closest('[aria-hidden="true"], [hidden], [inert]')).toBeNull();
  }
  await act(() => screen.element("Open preview in right panel").click());
  expect(state.dock).toHaveBeenCalledOnce();
  expect(playerState()).toBeNull();
});

it.each(["mouse", "touch", "pen"])(
  "moves the store using the visible %s handle",
  async (pointerType) => {
    const state = setup();
    await using screen = await mount(state);
    const handle = screen.element("Drag to move preview");
    const down = await screen.pointer(handle, "pointerdown", {
      pointerType,
      clientX: 120,
      clientY: 120,
    });
    expect(down.defaultPrevented).toBe(true);
    expect(state.captures.get(handle)).toBe(1);
    await screen.pointer(handle, "pointermove", { pointerType, clientX: 122, clientY: 122 });
    expect(playerState()?.position).toEqual({ x: 100, y: 100 });
    await screen.pointer(handle, "pointermove", { pointerType, clientX: 170, clientY: 160 });
    expect(playerState()?.position).toEqual({ x: 150, y: 140 });
    expect(playerState()?.lastInteraction).toBe("drag");
    await screen.pointer(handle, "pointerup", { pointerType });
    expect(state.captures.size).toBe(0);
    expect(state.releaseCapture).toHaveBeenCalledWith(1);
  },
);

it.each(["Open preview in right panel", "Pop out preview", "Close floating preview"])(
  "%s never captures a pointer or starts a drag",
  async (label) => {
    const state = setup();
    await using screen = await mount(state);
    const button = screen.element(label);
    await screen.pointer(button, "pointerdown", {
      pointerType: "touch",
      clientX: 120,
      clientY: 120,
    });
    await screen.pointer(button, "pointermove", {
      pointerType: "touch",
      clientX: 200,
      clientY: 200,
    });
    await screen.pointer(button, "pointerup", { pointerType: "touch" });
    expect(state.captures.size).toBe(0);
    expect(playerState()?.position).toEqual({ x: 100, y: 100 });
    await act(() => button.click());
    if (label === "Pop out preview") expect(state.popOut).toHaveBeenCalledOnce();
    else expect(playerState()).toBeNull();
  },
);

it.each(["pointercancel", "lostpointercapture"])(
  "cleans up on %s and accepts a fresh gesture",
  async (end) => {
    const state = setup();
    await using screen = await mount(state);
    const handle = screen.element("Drag to move preview");
    await screen.pointer(handle, "pointerdown", { pointerType: "touch", pointerId: 7 });
    await screen.pointer(handle, "pointercancel", { pointerId: 99 });
    expect(state.captures.get(handle)).toBe(7);
    await screen.pointer(handle, end, { pointerId: 7 });
    expect(state.captures.size).toBe(0);
    await screen.pointer(handle, "pointermove", { pointerId: 7, clientX: 90, clientY: 90 });
    expect(playerState()?.position).toEqual({ x: 100, y: 100 });
    await screen.pointer(handle, "pointerdown", { pointerId: 8 });
    await screen.pointer(handle, "pointermove", { pointerId: 8, clientX: 30, clientY: 20 });
    await screen.pointer(handle, "pointerup", { pointerId: 8 });
    expect(playerState()?.position).toEqual({ x: 130, y: 120 });
    expect(state.captures.size).toBe(0);
  },
);

it("can close, reopen and drag twice without retaining the previous gesture", async () => {
  const state = setup();
  await using screen = await mount(state);
  for (let pass = 0; pass < 2; pass++) {
    const handle = screen.element("Drag to move preview");
    await screen.pointer(handle, "pointerdown", { pointerType: "touch" });
    await screen.pointer(handle, "pointermove", { pointerType: "touch", clientX: 40, clientY: 30 });
    await screen.pointer(handle, "pointerup", { pointerType: "touch" });
    expect(playerState()?.position).toEqual({ x: 140, y: 130 });
    await act(() => screen.element("Close floating preview").click());
    expect(screen.container.querySelector("[data-preview-mini-player]")).toBeNull();
    await open();
  }
});

it.each([12, 1000])(
  "keeps controls inside a short canvas when a portrait frame is at x=%s",
  async (x) => {
    const state = setup();
    await using screen = await mount(state);
    const sizes = {
      sourceSize: { width: 300, height: 800 },
      containerSize: { width: 320, height: 184 },
    };
    await screen.resizeCanvas(sizes);
    await act(() => {
      usePreviewMiniPlayerStore.getState().move(threadRef, "browser:tab-test", { x, y: 12 });
    });
    const frame = screen.container.querySelector<HTMLElement>("[data-preview-mini-player]")!;
    expect(Number.parseFloat(frame.style.width)).toBeLessThan(100);
    const handle = screen.element("Drag to move preview");
    const bar = handle.parentElement!;
    const left = Number.parseFloat(frame.style.left) + Number.parseFloat(bar.style.left);
    const top = Number.parseFloat(frame.style.top) + Number.parseFloat(bar.style.top);
    expect(left).toBeGreaterThanOrEqual(12);
    expect(left + Number.parseFloat(bar.style.width)).toBeLessThanOrEqual(
      sizes.containerSize.width - 12,
    );
    expect(top).toBeGreaterThanOrEqual(12);
    expect(top + 48).toBeLessThanOrEqual(sizes.containerSize.height - 12);
    expect(bar.parentElement?.classList.contains("overflow-visible")).toBe(true);
    await screen.pointer(handle, "pointerdown", { pointerType: "touch" });
    await screen.pointer(handle, "pointermove", {
      pointerType: "touch",
      clientX: x === 12 ? 40 : -40,
    });
    await screen.pointer(handle, "pointerup", { pointerType: "touch" });
    expect(playerState()?.lastInteraction).toBe("drag");
    const movedX = playerState()?.position?.x;
    expect(movedX).toBe(x === 12 ? 52 : 208);
    await act(() => screen.element("Close floating preview").click());
    expect(playerState()).toBeNull();
    await open();
    await act(() => screen.element("Open preview in right panel").click());
    expect(state.dock).toHaveBeenCalledOnce();
    expect(playerState()).toBeNull();
  },
);
