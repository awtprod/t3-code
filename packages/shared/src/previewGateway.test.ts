import { assert, describe, it } from "vite-plus/test";

import { buildPreviewGatewaySelectUrl, PREVIEW_GATEWAY_SELECT_PATH } from "./previewGateway.ts";

describe("buildPreviewGatewaySelectUrl", () => {
  it("selects the port and lands on the requested path", () => {
    assert.equal(
      buildPreviewGatewaySelectUrl({
        gatewayOrigin: "https://example-tailnet.ts.net:8445/",
        port: 5173,
        to: "/dashboard",
      }),
      "https://example-tailnet.ts.net:8445/__t3-preview/select?port=5173&to=%2Fdashboard",
    );
  });

  // The gateway sees the query and fragment as part of the `to` value, so they
  // must survive encoding rather than being parsed as the select URL's own.
  it("keeps a query and fragment inside the redirect target", () => {
    const url = new URL(
      buildPreviewGatewaySelectUrl({
        gatewayOrigin: "https://example-tailnet.ts.net:8445/",
        port: 5173,
        to: "/app?mode=test#results",
      }),
    );
    assert.equal(url.pathname, PREVIEW_GATEWAY_SELECT_PATH);
    assert.equal(url.searchParams.get("port"), "5173");
    assert.equal(url.searchParams.get("to"), "/app?mode=test#results");
    assert.equal(url.hash, "");
  });

  it("defaults to the origin root when no path is given", () => {
    for (const to of [undefined, ""] as const) {
      const url = new URL(
        buildPreviewGatewaySelectUrl({
          gatewayOrigin: "http://127.0.0.1:3774/",
          port: 4173,
          ...(to === undefined ? {} : { to }),
        }),
      );
      assert.equal(url.searchParams.get("to"), "/");
    }
  });

  it("makes a relative target absolute", () => {
    const url = new URL(
      buildPreviewGatewaySelectUrl({
        gatewayOrigin: "http://127.0.0.1:3774/",
        port: 4173,
        to: "preview",
      }),
    );
    assert.equal(url.searchParams.get("to"), "/preview");
  });

  /**
   * `//evil.example.com/` is scheme-relative, not a path. The gateway drops it
   * and redirects to `/`, so passing it through unchanged would silently strand
   * the browser at the root; collapsing the slashes keeps the intended path.
   */
  it("collapses a scheme-relative target into a path", () => {
    const url = new URL(
      buildPreviewGatewaySelectUrl({
        gatewayOrigin: "http://127.0.0.1:3774/",
        port: 4173,
        to: "//evil.example.com/steal",
      }),
    );
    assert.equal(url.searchParams.get("to"), "/evil.example.com/steal");
  });

  // The origin may carry a path from however the client reached the server; the
  // select path is absolute, so it must replace it rather than nest under it.
  it("ignores a path on the gateway origin", () => {
    const url = new URL(
      buildPreviewGatewaySelectUrl({
        gatewayOrigin: "https://example-tailnet.ts.net:8445/some/base",
        port: 5173,
      }),
    );
    assert.equal(url.pathname, PREVIEW_GATEWAY_SELECT_PATH);
  });
});
