import { assert, describe, it } from "@effect/vitest";

import { decideWebSocketOrigin } from "./websocketOrigin.ts";

const decide = (input: {
  origin?: string | undefined;
  host?: string | undefined;
  allowedOrigins?: ReadonlyArray<string>;
}) =>
  decideWebSocketOrigin({
    origin: input.origin,
    host: input.host,
    allowedOrigins: input.allowedOrigins ?? [],
  });

describe("decideWebSocketOrigin", () => {
  describe("clients that send no Origin", () => {
    // Desktop and mobile both reach `/ws` through `Socket.layerWebSocket` in
    // @t3tools/client-runtime, which sends no Origin. Rejecting a missing
    // header would lock every non-browser client out of the server.
    it("allows an upgrade with no Origin header at all", () => {
      const decision = decide({ host: "127.0.0.1:13773" });
      assert.deepEqual(decision, { allowed: true, reason: "no-origin" });
    });

    it("treats an empty or whitespace Origin as absent", () => {
      for (const origin of ["", "   "]) {
        assert.deepEqual(decide({ origin, host: "127.0.0.1:13773" }), {
          allowed: true,
          reason: "no-origin",
        });
      }
    });
  });

  describe("same-origin browsers", () => {
    it("allows an Origin that matches the Host it was addressed to", () => {
      const decision = decide({
        origin: "http://127.0.0.1:13773",
        host: "127.0.0.1:13773",
      });
      assert.deepEqual(decision, { allowed: true, reason: "same-origin" });
    });

    // Tailscale Serve terminates TLS and forwards to loopback, but passes the
    // public authority through as Host. Measured against a live Serve mount:
    // a request to https://<node>.<tailnet>.ts.net:8446/ arrives with
    // `host: <node>.<tailnet>.ts.net:8446`. This is the primary remote path.
    it("allows the tailnet origin Tailscale Serve forwards", () => {
      const decision = decide({
        origin: "https://example-tailnet.ts.net:8446",
        host: "example-tailnet.ts.net:8446",
      });
      assert.deepEqual(decision, { allowed: true, reason: "same-origin" });
    });

    // Serve on :443 forwards `host` without a port while the browser elides
    // :443 from the Origin. Both sides mean the same authority.
    it("allows an https origin whose default port is elided on both sides", () => {
      const decision = decide({
        origin: "https://example-tailnet.ts.net",
        host: "example-tailnet.ts.net",
      });
      assert.deepEqual(decision, { allowed: true, reason: "same-origin" });
    });

    // The scheme is deliberately not compared: Serve presents https to the
    // browser while the backend listener speaks http.
    it("allows a scheme mismatch when the authority agrees", () => {
      const decision = decide({
        origin: "https://example-tailnet.ts.net",
        host: "example-tailnet.ts.net:443",
      });
      assert.deepEqual(decision, { allowed: true, reason: "same-origin" });
    });

    // Pins an accepted residual rather than asserting a fix: because the scheme
    // is not compared and `Host` elides a default port, an origin on one
    // scheme's default port matches a portless Host addressed over the other.
    // Exploiting it needs hostile content on the same *hostname* over the
    // opposite scheme — strictly harder than the preview-gateway threat this
    // module exists to stop, which lands on a different port and is refused.
    // Closing it would mean trusting `x-forwarded-proto`, which is
    // caller-supplied. If this test ever fails, the tradeoff changed: read the
    // "Known residual" note in websocketOrigin.ts before editing it green.
    it("accepts a default-port origin against a portless Host of the other scheme", () => {
      assert.deepEqual(decide({ origin: "http://app.example.com", host: "app.example.com" }), {
        allowed: true,
        reason: "same-origin",
      });
      // The port *is* compared whenever either side states one, which is what
      // keeps the same-host-different-port gateway attack refused.
      assert.deepEqual(decide({ origin: "http://app.example.com:8080", host: "app.example.com" }), {
        allowed: false,
        origin: "http://app.example.com:8080",
      });
    });

    it("is case-insensitive about the hostname", () => {
      const decision = decide({
        origin: "http://LocalHost:13773",
        host: "localhost:13773",
      });
      assert.deepEqual(decision, { allowed: true, reason: "same-origin" });
    });
  });

  describe("explicitly allowed origins", () => {
    // In dev the document is served by Vite on another port and proxied here,
    // so the browser's Origin is the Vite origin and Host is the backend's.
    it("allows the configured dev server origin against a different Host", () => {
      const decision = decide({
        origin: "http://localhost:5733",
        host: "127.0.0.1:13773",
        allowedOrigins: ["http://localhost:5733"],
      });
      assert.deepEqual(decision, { allowed: true, reason: "allow-listed" });
    });

    // The Electron renderer loads a custom scheme, which matches no Host by
    // construction and only ever compares equal as an exact string.
    it("allows the desktop renderer custom-scheme origins", () => {
      const allowedOrigins = [
        "commandcenter://app",
        "commandcenter-dev://app",
        "t3code://app",
        "t3code-dev://app",
      ];
      for (const origin of allowedOrigins) {
        assert.deepEqual(
          decide({
            origin,
            host: "127.0.0.1:13773",
            allowedOrigins,
          }),
          { allowed: true, reason: "allow-listed" },
        );
      }
    });

    it("does not allow a custom-scheme origin that is merely similar", () => {
      const decision = decide({
        origin: "t3code://app.evil.example.com",
        host: "127.0.0.1:13773",
        allowedOrigins: ["t3code://app"],
      });
      assert.deepEqual(decision, { allowed: false, origin: "t3code://app.evil.example.com" });
    });
  });

  describe("foreign origins", () => {
    // The finding this guards: a page served through the preview gateway shares
    // a host with the app (cookies are scoped by host, not port), so its
    // JavaScript can open /ws and the session cookie rides along. A different
    // port is a different origin and must be refused.
    it("refuses a same-host origin on a different port", () => {
      const decision = decide({
        origin: "http://127.0.0.1:3774",
        host: "127.0.0.1:13773",
      });
      assert.deepEqual(decision, { allowed: false, origin: "http://127.0.0.1:3774" });
    });

    it("refuses an unrelated site", () => {
      const decision = decide({
        origin: "https://evil.example.com",
        host: "example-tailnet.ts.net",
      });
      assert.deepEqual(decision, { allowed: false, origin: "https://evil.example.com" });
    });

    // Sandboxed iframes and data: documents report a literal "null" origin —
    // exactly the shape hostile embedded content takes.
    it("refuses the opaque null origin", () => {
      const decision = decide({ origin: "null", host: "127.0.0.1:13773" });
      assert.deepEqual(decision, { allowed: false, origin: "null" });
    });

    // `evil-app.example.com` ends with `app.example.com`, so a naive
    // `endsWith` check on the Host would admit an attacker-registered domain.
    it("refuses a hostname that merely has the Host as a suffix", () => {
      const decision = decide({
        origin: "https://evil-app.example.com",
        host: "app.example.com",
      });
      assert.deepEqual(decision, {
        allowed: false,
        origin: "https://evil-app.example.com",
      });
    });

    it("refuses an unparseable Origin", () => {
      const decision = decide({ origin: "not a url", host: "127.0.0.1:13773" });
      assert.deepEqual(decision, { allowed: false, origin: "not a url" });
    });

    // Without a Host there is nothing to compare against, so a present Origin
    // cannot be shown to be same-origin and must not be given the benefit of
    // the doubt.
    it("refuses a present Origin when the Host header is missing", () => {
      const decision = decide({ origin: "http://127.0.0.1:13773" });
      assert.deepEqual(decision, { allowed: false, origin: "http://127.0.0.1:13773" });
    });
  });
});
