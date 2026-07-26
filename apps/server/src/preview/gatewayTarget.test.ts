import { assert, describe, it } from "@effect/vitest";

import {
  buildGatewayRequestHeaders,
  buildGatewayResponseHeaders,
  buildGatewayUpstreamUrl,
  buildGatewayUpstreamWebSocketUrl,
  describeGatewayPortRejection,
  isWebSocketUpgrade,
  resolveGatewayPort,
  resolveRequestedSubprotocols,
  stripCookie,
  GATEWAY_TARGET_HOST,
  MAX_GATEWAY_PORT,
  MIN_GATEWAY_PORT,
} from "./gatewayTarget.ts";

describe("resolveGatewayPort", () => {
  it("accepts an ordinary dev server port", () => {
    assert.deepStrictEqual(resolveGatewayPort("5173"), { ok: true, port: 5173 });
    assert.deepStrictEqual(resolveGatewayPort(3000), { ok: true, port: 3000 });
    assert.deepStrictEqual(resolveGatewayPort(MIN_GATEWAY_PORT), {
      ok: true,
      port: MIN_GATEWAY_PORT,
    });
    assert.deepStrictEqual(resolveGatewayPort(MAX_GATEWAY_PORT), {
      ok: true,
      port: MAX_GATEWAY_PORT,
    });
  });

  // Privileged ports are never dev servers, and forwarding to them is how a
  // proxy bug turns into "reach the SSH/SMTP daemon through the gateway".
  it("rejects privileged ports", () => {
    for (const port of [0, 22, 80, 443, MIN_GATEWAY_PORT - 1]) {
      assert.deepStrictEqual(
        resolveGatewayPort(port),
        { ok: false, reason: "reserved-privileged" },
        `port ${port} must be rejected`,
      );
    }
  });

  it("rejects ports outside the valid TCP range", () => {
    assert.deepStrictEqual(resolveGatewayPort(MAX_GATEWAY_PORT + 1), {
      ok: false,
      reason: "out-of-range",
    });
    assert.deepStrictEqual(resolveGatewayPort(-1), { ok: false, reason: "out-of-range" });
  });

  // `Number()` is far too permissive for this: it maps "", " 12 ", "0x1f",
  // "1e3", and "+8080" to numbers, several of which would smuggle a different
  // port than the string suggests.
  it("rejects anything that is not a plain run of digits", () => {
    for (const raw of ["", "  ", "0x1f", "1e3", "+8080", " 8080 ", "8080/../", "80.5", "eighty"]) {
      const result = resolveGatewayPort(raw);
      assert.equal(result.ok, false, `${JSON.stringify(raw)} must be rejected`);
    }
    assert.deepStrictEqual(resolveGatewayPort(undefined), { ok: false, reason: "not-a-number" });
    assert.deepStrictEqual(resolveGatewayPort(80.5), { ok: false, reason: "not-a-number" });
  });

  // A gateway pointed at itself proxies itself: every hop consumes another
  // connection until the server runs out.
  it("refuses to forward to the server's own ports", () => {
    assert.deepStrictEqual(resolveGatewayPort("13773", [13_773, 8445]), {
      ok: false,
      reason: "gateway-self",
    });
    assert.deepStrictEqual(resolveGatewayPort("8445", [13_773, 8445]), {
      ok: false,
      reason: "gateway-self",
    });
    assert.deepStrictEqual(resolveGatewayPort("5173", [13_773, 8445]), { ok: true, port: 5173 });
  });

  // Loopback is where processes put interfaces they assume nothing can reach.
  // The gateway makes loopback reachable from the tailnet, so an authenticated
  // caller must not be able to aim it at a debugger or a container daemon.
  it("refuses well-known control-plane service ports", () => {
    for (const port of [2375, 2376, 5432, 6379, 27_017, 8200, 6443, 11_211]) {
      assert.deepStrictEqual(
        resolveGatewayPort(port),
        { ok: false, reason: "blocked-service" },
        `port ${port} must not be reachable`,
      );
    }
  });

  // The inspector protocol evaluates arbitrary code in the target process, and
  // the port is routinely offset when several processes debug at once — so the
  // whole conventional range is refused, not just the two default ports.
  it("refuses the whole debugger port range", () => {
    for (const port of [9222, 9229, 9230, 9239]) {
      assert.deepStrictEqual(
        resolveGatewayPort(port),
        { ok: false, reason: "blocked-service" },
        `debugger port ${port} must not be reachable`,
      );
    }
    // The range is bounded: ordinary dev servers sit on either side of it.
    assert.deepStrictEqual(resolveGatewayPort(9221), { ok: true, port: 9221 });
    assert.deepStrictEqual(resolveGatewayPort(9240), { ok: true, port: 9240 });
  });

  it("still accepts the ports dev servers actually use", () => {
    for (const port of [3000, 4200, 5173, 5174, 8080, 8081, 4321]) {
      assert.deepStrictEqual(
        resolveGatewayPort(port),
        { ok: true, port },
        `port ${port} must stay reachable`,
      );
    }
  });

  it("explains every rejection", () => {
    for (const reason of [
      "not-a-number",
      "out-of-range",
      "reserved-privileged",
      "gateway-self",
      "blocked-service",
    ] as const) {
      assert.ok(describeGatewayPortRejection(reason).length > 0);
    }
  });
});

describe("buildGatewayUpstreamUrl", () => {
  // The host is a constant, never caller-supplied — this is the check that the
  // route cannot be turned into an open forward proxy.
  it("always targets loopback", () => {
    assert.equal(buildGatewayUpstreamUrl(5173, "/"), "http://127.0.0.1:5173/");
    assert.ok(buildGatewayUpstreamUrl(5173, "/x").startsWith(`http://${GATEWAY_TARGET_HOST}:`));
  });

  it("passes the path and query through untouched", () => {
    assert.equal(
      buildGatewayUpstreamUrl(5173, "/src/main.tsx?t=17849&x=a%2Fb"),
      "http://127.0.0.1:5173/src/main.tsx?t=17849&x=a%2Fb",
    );
  });

  it("normalizes a missing leading slash", () => {
    assert.equal(
      buildGatewayUpstreamUrl(5173, "assets/app.js"),
      "http://127.0.0.1:5173/assets/app.js",
    );
  });
});

describe("buildGatewayRequestHeaders", () => {
  it("rewrites host to the upstream authority", () => {
    const headers = buildGatewayRequestHeaders(
      { host: "example-tailnet.ts.net", accept: "text/html" },
      5173,
      "t3_session",
    );
    assert.equal(headers.host, "127.0.0.1:5173");
    assert.equal(headers.accept, "text/html");
  });

  // Hop-by-hop headers are connection-scoped; relaying them corrupts keep-alive
  // and upgrade negotiation on the upstream connection.
  it("drops hop-by-hop headers and accept-encoding", () => {
    const headers = buildGatewayRequestHeaders(
      {
        connection: "keep-alive",
        "keep-alive": "timeout=5",
        "transfer-encoding": "chunked",
        upgrade: "websocket",
        te: "trailers",
        "accept-encoding": "gzip, br",
        "x-real-header": "kept",
      },
      5173,
      "t3_session",
    );
    for (const dropped of [
      "connection",
      "keep-alive",
      "transfer-encoding",
      "upgrade",
      "te",
      "accept-encoding",
    ]) {
      assert.equal(headers[dropped], undefined, `${dropped} must not be forwarded`);
    }
    assert.equal(headers["x-real-header"], "kept");
  });

  // The dev server is arbitrary user code. Handing it the session credential
  // that authenticates against this server would be a needless way to lose it.
  it("strips the session cookie but keeps the dev server's own cookies", () => {
    const headers = buildGatewayRequestHeaders(
      { cookie: "t3_session=SECRET-TOKEN; vite_theme=dark; other=1" },
      5173,
      "t3_session",
    );
    assert.ok(!(headers.cookie ?? "").includes("SECRET-TOKEN"));
    assert.ok(!(headers.cookie ?? "").includes("t3_session"));
    assert.equal(headers.cookie, "vite_theme=dark; other=1");
  });

  it("omits the cookie header entirely when only the session cookie was present", () => {
    const headers = buildGatewayRequestHeaders({ cookie: "t3_session=SECRET" }, 5173, "t3_session");
    assert.equal(headers.cookie, undefined);
  });

  it("is case-insensitive about header names", () => {
    const headers = buildGatewayRequestHeaders(
      { Host: "example", "Accept-Encoding": "gzip", "X-Keep": "yes" },
      5173,
      "t3_session",
    );
    assert.equal(headers.host, "127.0.0.1:5173");
    assert.equal(headers["accept-encoding"], undefined);
    assert.equal(headers["x-keep"], "yes");
  });
});

describe("buildGatewayResponseHeaders", () => {
  it("keeps ordinary response headers", () => {
    const headers = buildGatewayResponseHeaders({
      "content-type": "text/html",
      etag: 'W/"abc"',
    });
    assert.equal(headers["content-type"], "text/html");
    assert.equal(headers.etag, 'W/"abc"');
  });

  // `set-cookie` travels in the response's cookie channel instead. This map is a
  // `Record` and holds only the last of several values, so keeping it here would
  // send that one cookie twice alongside the complete set.
  it("drops set-cookie, which is relayed through the cookie channel", () => {
    const headers = buildGatewayResponseHeaders({
      "content-type": "text/html",
      "set-cookie": "vite=1",
    });
    assert.isUndefined(headers["set-cookie"]);
    assert.equal(headers["content-type"], "text/html");
  });

  // The body is relayed as a stream, so the upstream's length no longer
  // describes what we send; leaving it in truncates or hangs the response.
  it("drops connection-scoped headers and content-length", () => {
    const headers = buildGatewayResponseHeaders({
      connection: "keep-alive",
      "keep-alive": "timeout=5",
      "transfer-encoding": "chunked",
      upgrade: "h2c",
      "content-length": "1234",
    });
    assert.deepStrictEqual(headers, {});
  });

  // The HTTP client decodes the body before we ever see it but leaves the
  // upstream's `content-encoding` on the headers. Relaying it tells the browser
  // to gunzip plaintext, and every response from a compressing dev server fails.
  it("drops content-encoding, because the relayed body is already decoded", () => {
    const headers = buildGatewayResponseHeaders({
      "content-type": "application/javascript",
      "content-encoding": "gzip",
    });
    assert.equal(headers["content-encoding"], undefined);
    assert.equal(headers["content-type"], "application/javascript");
  });
});

describe("isWebSocketUpgrade", () => {
  it("recognizes an upgrade request", () => {
    assert.equal(isWebSocketUpgrade({ upgrade: "websocket", connection: "Upgrade" }), true);
    // Browsers really do send "keep-alive, Upgrade".
    assert.equal(
      isWebSocketUpgrade({ Upgrade: "WebSocket", Connection: "keep-alive, Upgrade" }),
      true,
    );
  });

  it("does not mistake an ordinary request for one", () => {
    assert.equal(isWebSocketUpgrade({}), false);
    assert.equal(isWebSocketUpgrade({ connection: "keep-alive" }), false);
    assert.equal(isWebSocketUpgrade({ upgrade: "websocket" }), false);
    assert.equal(isWebSocketUpgrade({ upgrade: "h2c", connection: "Upgrade" }), false);
  });
});

describe("resolveRequestedSubprotocols", () => {
  // Vite's HMR client connects with `vite-hmr`; open the upstream socket without
  // it and the dev server answers on the wrong protocol, so HMR never connects.
  it("preserves the client's subprotocol list in order", () => {
    assert.deepStrictEqual(resolveRequestedSubprotocols({ "sec-websocket-protocol": "vite-hmr" }), [
      "vite-hmr",
    ]);
    assert.deepStrictEqual(
      resolveRequestedSubprotocols({ "Sec-WebSocket-Protocol": "vite-hmr, other" }),
      ["vite-hmr", "other"],
    );
  });

  it("is empty when the client asked for none", () => {
    assert.deepStrictEqual(resolveRequestedSubprotocols({}), []);
    assert.deepStrictEqual(resolveRequestedSubprotocols({ "sec-websocket-protocol": "  " }), []);
  });
});

describe("buildGatewayUpstreamWebSocketUrl", () => {
  it("targets loopback over ws://", () => {
    assert.equal(
      buildGatewayUpstreamWebSocketUrl(5173, "/?token=abc"),
      "ws://127.0.0.1:5173/?token=abc",
    );
    assert.equal(buildGatewayUpstreamWebSocketUrl(5173, "hmr"), "ws://127.0.0.1:5173/hmr");
  });
});

describe("stripCookie", () => {
  it("removes only the named cookie", () => {
    assert.equal(stripCookie("a=1; b=2; c=3", "b"), "a=1; c=3");
    assert.equal(stripCookie("a=1", "b"), "a=1");
    assert.equal(stripCookie("b=1", "b"), "");
  });

  // A cookie whose name merely *contains* the session name must survive, or
  // the dev server silently loses state.
  it("does not match on prefix", () => {
    assert.equal(
      stripCookie("t3_session_theme=dark; t3_session=X", "t3_session"),
      "t3_session_theme=dark",
    );
  });
});
