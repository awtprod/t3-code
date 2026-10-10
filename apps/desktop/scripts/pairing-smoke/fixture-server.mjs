import * as NodeHttp from "node:http";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
const { WebSocketServer } = NodeModule.createRequire(
  NodeModule.createRequire(new URL("../../package.json", import.meta.url)).resolve(
    "@effect/platform-node/NodeSocket",
  ),
)("ws");
export const syntheticToken = "synthetic-fixture-bearer-not-production";
export const localToken = "synthetic-local-fixture-bearer-not-production";
export const pairingCode = "FIXTURE123";
export const remoteId = "00000000-0000-4000-8000-000000000001";
export const auth = {
  policy: "remote-reachable",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["bearer-access-token", "browser-session-cookie"],
  sessionCookieName: "t3_session",
};
const renderer = process.env.FIXTURE_RENDERER_ROOT;
if (!renderer) throw new Error("Fixture renderer path is required");
export function makeServer({
  port = 0,
  local = false,
  bootstrap = "",
  records = [],
  sameIdentity = false,
  control = {},
} = {}) {
  if (local) NodeFS.writeFileSync(process.env.FIXTURE_PID_FILE, String(process.pid));
  const environment = {
    environmentId: local && !sameIdentity ? "00000000-0000-4000-8000-000000000002" : remoteId,
    label: local ? "Fixture local" : "Fixture remote",
    platform: { os: "windows", arch: "x64" },
    serverVersion: process.env.FIXTURE_APP_VERSION,
    capabilities: { repositoryIdentity: true },
  };
  const config = {
    environment,
    auth,
    cwd: process.env.FIXTURE_ROOT,
    keybindingsConfigPath: NodePath.join(process.env.FIXTURE_ROOT, "keybindings.json"),
    keybindings: [],
    issues: [],
    providers: [],
    availableEditors: [],
    observability: {
      logsDirectoryPath: NodePath.join(process.env.FIXTURE_ROOT, "logs"),
      localTracingEnabled: false,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
    },
    settings: JSON.parse(NodeFS.readFileSync(new URL("./fixture-settings.json", import.meta.url))),
  };
  const tickets = new Set();
  const server = NodeHttp.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const body = await Array.fromAsync(req).then((a) => Buffer.concat(a).toString());
    const valid =
      req.headers.authorization ===
      `Bearer ${local ? localToken : control.acceptedToken || syntheticToken}`;
    const cookieValid = local && req.headers.cookie?.includes("t3_session=synthetic-browser");
    const record = {
      at: new Date().toISOString(),
      local,
      method: req.method,
      path: url.pathname,
      authorizationPresent: !!req.headers.authorization,
      syntheticBearerMatches: valid,
      cookiePresent: !!req.headers.cookie,
      origin: req.headers.origin || null,
      userAgent: req.headers["user-agent"] || null,
    };
    records.push(record);
    if (local)
      NodeFS.appendFileSync(process.env.FIXTURE_RECORDS_FILE, JSON.stringify(record) + "\n");
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader(
      "Access-Control-Allow-Headers",
      req.headers["access-control-request-headers"] || "authorization,content-type,dpop",
    );
    res.setHeader("Access-Control-Allow-Private-Network", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    const json = (v, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(v));
    };
    if (url.pathname === "/.well-known/t3/environment")
      return json({
        ...environment,
        ...(control.descriptorId ? { environmentId: control.descriptorId } : {}),
      });
    if (url.pathname === "/api/auth/session")
      return json({
        authenticated: (valid || cookieValid) && !control.rejectBearer,
        auth,
        ...(valid || cookieValid
          ? {
              sessionMethod:
                cookieValid || control.forceCookieMethod
                  ? "browser-session-cookie"
                  : "bearer-access-token",
              scopes: ["orchestration:read"],
              expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
            }
          : {}),
      });
    if (url.pathname === "/oauth/token") {
      const data = new URLSearchParams(body);
      const submitted = data.get("subject_token");
      record.pairingSecretMatches = submitted === (local ? bootstrap : pairingCode);
      if (!record.pairingSecretMatches)
        return json(
          {
            _tag: "EnvironmentAuthInvalidError",
            code: "invalid_grant",
            reason: "invalid_credential",
            traceId: "fixture",
          },
          401,
        );
      control.acceptedToken = syntheticToken;
      return json({
        access_token: local ? localToken : syntheticToken,
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "orchestration:read",
      });
    }
    if (url.pathname === "/api/auth/browser-session") {
      res.setHeader("Set-Cookie", "t3_session=synthetic-browser; Path=/; SameSite=Lax");
      return json({
        authenticated: true,
        sessionMethod: "browser-session-cookie",
        scopes: ["orchestration:read"],
        expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
      });
    }
    if (url.pathname === "/api/auth/websocket-ticket") {
      if ((!valid && !cookieValid) || control.rejectBearer)
        return json(
          {
            _tag: "EnvironmentAuthInvalidError",
            code: "unauthorized",
            reason: "invalid_credential",
            traceId: "fixture",
          },
          401,
        );
      const ticket = "synthetic-ticket-" + tickets.size;
      tickets.add(ticket);
      return json({ ticket, expiresAt: new Date(Date.now() + 30 * 86400000).toISOString() });
    }
    if (url.pathname === "/api/orchestration/shell") {
      if (!valid || control.rejectBearer) return json({ unauthorized: true }, 401);
      return json({
        snapshotSequence: 0,
        projects: [],
        threads: [],
        updatedAt: new Date().toISOString(),
      });
    }
    if (url.pathname.startsWith("/api/")) return json({ fixture: true }, 404);
    const file = NodePath.join(
      renderer,
      url.pathname === "/" || !NodePath.extname(url.pathname) ? "index.html" : url.pathname,
    );
    if (!file.startsWith(renderer + NodePath.sep) || !NodeFS.existsSync(file))
      return json({ missing: true }, 404);
    res.setHeader(
      "Content-Type",
      {
        ".html": "text/html",
        ".js": "application/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".woff2": "font/woff2",
      }[NodePath.extname(file)] || "application/octet-stream",
    );
    NodeFS.createReadStream(file).pipe(res);
  });
  const wsServer = new WebSocketServer({ noServer: true });
  server.fixtureWebSockets = wsServer;
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const ticket = url.searchParams.get("wsTicket");
    if (!tickets.delete(ticket)) {
      socket.destroy();
      return;
    }
    records.push({
      at: new Date().toISOString(),
      local,
      method: "UPGRADE",
      path: "/ws",
      validSyntheticTicket: true,
      cookiePresent: !!req.headers.cookie,
      origin: req.headers.origin || null,
    });
    wsServer.handleUpgrade(req, socket, head, (ws) => wsServer.emit("connection", ws, req));
  });
  wsServer.on("connection", (ws) =>
    ws.on("message", (buffer) => {
      const parsed = JSON.parse(buffer.toString());
      for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
        if (message._tag === "Ping") {
          ws.send(JSON.stringify({ _tag: "Pong" }));
          continue;
        }
        if (message._tag !== "Request") continue;
        records.push({ at: new Date().toISOString(), local, method: "RPC", tag: message.tag });
        if (message.tag === "subscribeServerConfig")
          ws.send(
            JSON.stringify({
              _tag: "Chunk",
              requestId: message.id,
              values: [{ version: 1, type: "snapshot", config }],
            }),
          );
        else if (message.tag === "cc.bootstrap")
          ws.send(
            JSON.stringify({
              _tag: "Exit",
              requestId: message.id,
              exit: {
                _tag: "Success",
                value: {
                  timezone: "Etc/UTC",
                  spaces: [],
                  items: [],
                  needsYou: [],
                  runs: [],
                  approvals: [],
                  automations: [],
                  connections: [],
                  memories: [],
                  configHealth: { status: "loaded", configDirectory: process.env.FIXTURE_ROOT },
                },
              },
            }),
          );
        else if (message.tag === "server.getConfig")
          ws.send(
            JSON.stringify({
              _tag: "Exit",
              requestId: message.id,
              exit: { _tag: "Success", value: config },
            }),
          );
        else if (message.tag === "server.probe")
          ws.send(
            JSON.stringify({
              _tag: "Exit",
              requestId: message.id,
              exit: { _tag: "Success", value: {} },
            }),
          );
      }
    }),
  );
  server.listen(port, "127.0.0.1");
  return server;
}
