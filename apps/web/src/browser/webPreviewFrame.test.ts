import { assert, describe, it } from "vite-plus/test";

import { resolveWebPreviewFrameState } from "./webPreviewFrameState";

describe("resolveWebPreviewFrameState", () => {
  it("frames the URL a loading session is navigating to", () => {
    const state = resolveWebPreviewFrameState({
      navStatus: { _tag: "Loading", url: "https://example-tailnet.ts.net:8445/", title: "" },
      reloadNonce: 0,
    });
    assert.equal(state?.src, "https://example-tailnet.ts.net:8445/");
  });

  it("frames a loaded session's URL", () => {
    const state = resolveWebPreviewFrameState({
      navStatus: { _tag: "Success", url: "http://127.0.0.1:5173/app", title: "App" },
      reloadNonce: 0,
    });
    assert.equal(state?.src, "http://127.0.0.1:5173/app");
  });

  it("frames nothing before a URL exists", () => {
    assert.equal(
      resolveWebPreviewFrameState({ navStatus: { _tag: "Idle" }, reloadNonce: 0 }),
      null,
    );
  });

  /**
   * The unreachable overlay already covers the panel for a failed load, so a
   * frame underneath it would re-request the failing URL for something nobody
   * can see.
   */
  it("frames nothing for a failed load", () => {
    assert.equal(
      resolveWebPreviewFrameState({
        navStatus: {
          _tag: "LoadFailed",
          url: "http://127.0.0.1:5173/",
          title: "",
          code: -102,
          description: "connection refused",
        },
        reloadNonce: 0,
      }),
      null,
    );
  });

  // A cross-origin frame cannot be told to reload itself, so the key is the
  // reload mechanism: React discards the element and mounts a fresh one, which
  // performs a new navigation. Same URL, same nonce must stay stable, or the
  // frame would remount on every unrelated re-render.
  it("changes the key on reload and keeps it stable otherwise", () => {
    const url = "http://127.0.0.1:5173/app";
    const navStatus = { _tag: "Success", url, title: "App" } as const;
    const first = resolveWebPreviewFrameState({ navStatus, reloadNonce: 0 });
    const same = resolveWebPreviewFrameState({ navStatus, reloadNonce: 0 });
    const reloaded = resolveWebPreviewFrameState({ navStatus, reloadNonce: 1 });
    assert.equal(first?.key, same?.key);
    assert.notEqual(first?.key, reloaded?.key);
  });

  // Navigating to a different URL must also produce a new element, otherwise
  // the browser records it in the frame's own history and the user's Back
  // button starts walking the preview instead of the app.
  it("changes the key when the URL changes", () => {
    const a = resolveWebPreviewFrameState({
      navStatus: { _tag: "Success", url: "http://127.0.0.1:5173/a", title: "" },
      reloadNonce: 0,
    });
    const b = resolveWebPreviewFrameState({
      navStatus: { _tag: "Success", url: "http://127.0.0.1:5173/b", title: "" },
      reloadNonce: 0,
    });
    assert.notEqual(a?.key, b?.key);
  });
});
