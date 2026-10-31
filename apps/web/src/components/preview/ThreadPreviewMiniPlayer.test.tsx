// @vitest-environment jsdom

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

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

// Exercise the real shell, UI primitives, store and geometry without loading
// native surfaces, device streams or their environment connections in jsdom.
vi.mock("~/browser/BrowserSurfaceSlot", () => ({ BrowserSurfaceSlot: () => null }));
vi.mock("~/browser/ServerBrowserSurface", () => ({ ServerBrowserSurface: () => null }));
vi.mock("../device/DeviceStreamView", () => ({ DeviceStreamView: () => null }));
vi.mock("~/browser/browserRecording", () => ({}));
vi.mock("~/browser/previewRuntime", () => ({}));
vi.mock("~/browser/serverPictureInPicture", () => ({}));
vi.mock("~/previewStateStore", () => ({}));
vi.mock("~/state/device", () => ({}));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));

const threadRef = scopeThreadRef("env-test" as EnvironmentId, ThreadId.make("thread-test"));
const source = browserMiniPlayerSource("tab-test");
const dock = vi.fn();
const popOut = vi.fn();
const noop = () => undefined;
let sourceSize = { width: 480, height: 320 };
let containerSize = { width: 800, height: 600 };
let root: Root;
let host: HTMLDivElement;
let captures: Map<Element, number>;
const releaseCapture = vi.fn<(pointerId: number) => void>();

function playerState() {
  return selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, threadRef);
}

function Player() {
  const miniPlayer = usePreviewMiniPlayerStore((state) =>
    selectThreadPreviewMiniPlayer(state.byThreadKey, threadRef),
  );
  if (!miniPlayer) return null;
  const key = previewMiniPlayerSourceKey(miniPlayer.source);
  return (
    <ChatCanvasContext
      value={{
        container: containerSize,
        lane: { padding: 48, minChatWidth: 640 },
        layout: resolveChatCanvasLayout({
          container: containerSize,
          preview: { ...miniPlayer, key, source: sourceSize },
        }),
        previewKey: key,
        reportPreview: noop,
        clearPreview: noop,
        registerTimeline: noop,
        reportDetailsCard: noop,
        detailsCardTopInset: 0,
      }}
    >
      <MiniPlayerShell
        threadRef={threadRef}
        miniPlayer={miniPlayer}
        sourceSize={sourceSize}
        label="Floating test preview"
        recording
        onOpenInPanel={() => {
          dock();
          usePreviewMiniPlayerStore.getState().close(threadRef);
        }}
        actions={
          <Button variant="ghost" size="icon-xs" aria-label="Pop out preview" onClick={popOut}>
            Pop out
          </Button>
        }
      >
        {() => <div>Preview content</div>}
      </MiniPlayerShell>
    </ChatCanvasContext>
  );
}

function element(label: string) {
  const target = host.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  if (!target) throw new Error(`Missing ${label}`);
  return target;
}

// jsdom lacks pointer capture and PointerEvent. Keep capture state on the
// dispatched element, and supply the pointer fields React consumes.
async function pointer(
  target: Element,
  type: string,
  options: {
    pointerId?: number;
    pointerType?: string;
    clientX?: number;
    clientY?: number;
    button?: number;
  } = {},
) {
  if (!target.setPointerCapture) {
    Object.assign(target, {
      setPointerCapture: (pointerId: number) => captures.set(target, pointerId),
      hasPointerCapture: (pointerId: number) => captures.get(target) === pointerId,
      releasePointerCapture: (pointerId: number) => {
        releaseCapture(pointerId);
        captures.delete(target);
      },
    });
  }
  const { pointerId = 1, pointerType = "mouse", ...coordinates } = options;
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    ...coordinates,
  });
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    pointerType: { value: pointerType },
  });
  await act(() => target.dispatchEvent(event));
  return event;
}

async function open() {
  await act(() => {
    const store = usePreviewMiniPlayerStore.getState();
    store.open(threadRef, source);
    store.resize(threadRef, "browser:tab-test", 240, { x: 100, y: 100 });
  });
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
  sourceSize = { width: 480, height: 320 };
  containerSize = { width: 800, height: 600 };
  captures = new Map();
  releaseCapture.mockClear();
  dock.mockClear();
  popOut.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(() => root.render(<Player />));
  await open();
});

afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("exposes move, recording and focusable actions without hover or a revealing tap", async () => {
  const handle = element("Drag to move preview");
  expect(handle.textContent).toContain("Move");
  // The control bar must be exposed before focus, hover or any pointer event.
  expect(handle.parentElement?.classList.contains("opacity-0")).toBe(false);
  expect(handle.parentElement?.classList.contains("pointer-events-none")).toBe(false);
  expect(element("Recording preview").getAttribute("role")).toBe("status");
  for (const label of [
    "Open preview in right panel",
    "Pop out preview",
    "Close floating preview",
  ]) {
    const button = element(label);
    expect(button.tagName).toBe("BUTTON");
    await act(() => button.focus());
    expect(document.activeElement).toBe(button);
    expect(button.closest('[aria-hidden="true"], [hidden], [inert]')).toBeNull();
  }
  await act(() => element("Open preview in right panel").click());
  expect(dock).toHaveBeenCalledOnce();
  expect(playerState()).toBeNull();
});

it.each(["mouse", "touch", "pen"])(
  "moves the store using the visible %s handle",
  async (pointerType) => {
    const handle = element("Drag to move preview");
    const down = await pointer(handle, "pointerdown", { pointerType, clientX: 120, clientY: 120 });
    expect(down.defaultPrevented).toBe(true);
    expect(captures.get(handle)).toBe(1);
    await pointer(handle, "pointermove", { pointerType, clientX: 122, clientY: 122 });
    expect(playerState()?.position).toEqual({ x: 100, y: 100 });
    await pointer(handle, "pointermove", { pointerType, clientX: 170, clientY: 160 });
    expect(playerState()?.position).toEqual({ x: 150, y: 140 });
    expect(playerState()?.lastInteraction).toBe("drag");
    await pointer(handle, "pointerup", { pointerType });
    expect(captures.size).toBe(0);
    expect(releaseCapture).toHaveBeenCalledWith(1);
  },
);

it.each(["Open preview in right panel", "Pop out preview", "Close floating preview"])(
  "%s never captures a pointer or starts a drag",
  async (label) => {
    const button = element(label);
    await pointer(button, "pointerdown", { pointerType: "touch", clientX: 120, clientY: 120 });
    await pointer(button, "pointermove", { pointerType: "touch", clientX: 200, clientY: 200 });
    await pointer(button, "pointerup", { pointerType: "touch" });
    expect(captures.size).toBe(0);
    expect(playerState()?.position).toEqual({ x: 100, y: 100 });
    await act(() => button.click());
    if (label === "Pop out preview") expect(popOut).toHaveBeenCalledOnce();
    else expect(playerState()).toBeNull();
  },
);

it.each(["pointercancel", "lostpointercapture"])(
  "cleans up on %s and accepts a fresh gesture",
  async (end) => {
    const handle = element("Drag to move preview");
    await pointer(handle, "pointerdown", { pointerType: "touch", pointerId: 7 });
    await pointer(handle, "pointercancel", { pointerId: 99 });
    expect(captures.get(handle)).toBe(7);
    await pointer(handle, end, { pointerId: 7 });
    expect(captures.size).toBe(0);
    await pointer(handle, "pointermove", { pointerId: 7, clientX: 90, clientY: 90 });
    expect(playerState()?.position).toEqual({ x: 100, y: 100 });
    await pointer(handle, "pointerdown", { pointerId: 8 });
    await pointer(handle, "pointermove", { pointerId: 8, clientX: 30, clientY: 20 });
    await pointer(handle, "pointerup", { pointerId: 8 });
    expect(playerState()?.position).toEqual({ x: 130, y: 120 });
    expect(captures.size).toBe(0);
  },
);

it("can close, reopen and drag twice without retaining the previous gesture", async () => {
  for (let pass = 0; pass < 2; pass++) {
    const handle = element("Drag to move preview");
    await pointer(handle, "pointerdown", { pointerType: "touch" });
    await pointer(handle, "pointermove", { pointerType: "touch", clientX: 40, clientY: 30 });
    await pointer(handle, "pointerup", { pointerType: "touch" });
    expect(playerState()?.position).toEqual({ x: 140, y: 130 });
    await act(() => element("Close floating preview").click());
    expect(host.querySelector("[data-preview-mini-player]")).toBeNull();
    await open();
  }
});

it.each([12, 1000])(
  "keeps controls inside a short canvas when a portrait frame is at x=%s",
  async (x) => {
    sourceSize = { width: 300, height: 800 };
    containerSize = { width: 320, height: 184 };
    await act(() => {
      usePreviewMiniPlayerStore.getState().move(threadRef, "browser:tab-test", { x, y: 12 });
    });
    const frame = host.querySelector<HTMLElement>("[data-preview-mini-player]")!;
    expect(Number.parseFloat(frame.style.width)).toBeLessThan(100);
    const handle = element("Drag to move preview");
    const bar = handle.parentElement!;
    const left = Number.parseFloat(frame.style.left) + Number.parseFloat(bar.style.left);
    const top = Number.parseFloat(frame.style.top) + Number.parseFloat(bar.style.top);
    expect(left).toBeGreaterThanOrEqual(12);
    expect(left + Number.parseFloat(bar.style.width)).toBeLessThanOrEqual(containerSize.width - 12);
    expect(top).toBeGreaterThanOrEqual(12);
    expect(top + 48).toBeLessThanOrEqual(containerSize.height - 12);
    expect(bar.parentElement?.classList.contains("overflow-visible")).toBe(true);
    await pointer(handle, "pointerdown", { pointerType: "touch" });
    await pointer(handle, "pointermove", { pointerType: "touch", clientX: x === 12 ? 40 : -40 });
    await pointer(handle, "pointerup", { pointerType: "touch" });
    expect(playerState()?.lastInteraction).toBe("drag");
    const movedX = playerState()?.position?.x;
    expect(movedX).toBe(x === 12 ? 52 : 208);
    await act(() => element("Close floating preview").click());
    expect(playerState()).toBeNull();
    await open();
    await act(() => element("Open preview in right panel").click());
    expect(dock).toHaveBeenCalledOnce();
    expect(playerState()).toBeNull();
  },
);
