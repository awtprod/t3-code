// @effect-diagnostics nodeBuiltinImport:off - WebSocket proxying requires a captured duplex docker/podman exec process.
// @effect-diagnostics runEffectInsideEffect:off - Node stream callbacks bridge into the acquired downstream Socket writer.
// @effect-diagnostics outdatedApi:off - Socket.runRaw currently remains on the compatibility surface.
// @effect-diagnostics globalTimers:off - Captured bridge child owns a bounded handshake timer and exact process-group cleanup.
// @effect-diagnostics globalTimersInEffect:off - Node stream callback timer guards an external process handshake.
import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import { spawn } from "node:child_process";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/unstable/http";
import * as HttpIncomingMessage from "effect/unstable/http/HttpIncomingMessage";
import { authenticateRawRouteWithScope } from "../http.ts";
import { desktopGateway } from "./DesktopGatewayService.ts";
import { ServerConfig } from "../config.ts";
import { resolve } from "node:path";

const prefix = "/api/thread-desktop/";

export const desktopHttpRouteLayer = HttpRouter.add(
  "GET",
  `${prefix}*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
    const [threadId, action] = url.value.pathname.slice(prefix.length).split("/");
    if (!threadId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(threadId))
      return HttpServerResponse.text("Not Found", { status: 404 });
    const gateway = desktopGateway;
    if (action === "status") {
      yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
      return HttpServerResponse.jsonUnsafe(gateway.status(threadId));
    }
    if (action === "automation-target") {
      yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
      const target = gateway.automationTarget(threadId);
      return target === null
        ? HttpServerResponse.text("Desktop not ready", { status: 409 })
        : HttpServerResponse.jsonUnsafe(target);
    }
    if (action !== "view") return HttpServerResponse.text("Not Found", { status: 404 });
    const ticket = url.value.searchParams.get("ticket") ?? "";
    if (!gateway.consumeViewerTicket(threadId, ticket))
      return HttpServerResponse.text("Forbidden", { status: 403 });
    const credential = gateway.viewer(threadId);
    return HttpServerResponse.text(viewerHtml(threadId, credential.sessionId, credential.token), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; style-src 'unsafe-inline'",
        "referrer-policy": "no-referrer",
        "set-cookie": `${signalCookieName(threadId)}=${credential.token}; HttpOnly; SameSite=Strict; Path=${prefix}${threadId}/signal; Max-Age=3600`,
      },
    });
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

export const desktopSignalHttpRouteLayer = HttpRouter.add(
  "POST",
  `${prefix}*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
    const [threadId, action] = url.value.pathname.slice(prefix.length).split("/");
    if (!threadId) return HttpServerResponse.text("Not Found", { status: 404 });
    if (action === "viewer-ticket") {
      yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
      const issued = desktopGateway.issueViewerTicket(threadId);
      const viewerUrl = `${prefix}${threadId}/view?ticket=${encodeURIComponent(issued.ticket)}`;
      return HttpServerResponse.jsonUnsafe(
        { viewerUrl, expiresAt: issued.expiresAt },
        { headers: { "cache-control": "no-store" } },
      );
    }
    if (action !== "signal") return HttpServerResponse.text("Not Found", { status: 404 });
    const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
    const decodedBody = Schema.decodeUnknownOption(SignalBodySchema)(body);
    if (Option.isNone(decodedBody) || !isBoundedSignalBody(decodedBody.value))
      return HttpServerResponse.text("Bad Request", { status: 400 });
    const signalBody = decodedBody.value;
    const token =
      signalBody.role === "viewer"
        ? (request.cookies[signalCookieName(threadId)] ?? signalBody.token ?? "")
        : (signalBody.token ?? "");
    const gateway = desktopGateway;
    if (
      signalBody.type === "input" &&
      (signalBody.role !== "viewer" || !gateway.acceptsHumanInput(threadId))
    )
      return HttpServerResponse.text("Takeover lease required", { status: 423 });
    if (signalBody.type === "poll") {
      if (gateway.signaling.attach({ threadId, ...signalBody, token }) === null)
        return HttpServerResponse.text("Forbidden", { status: 403 });
      const relayed = yield* Effect.tryPromise({
        try: () => gateway.relaySignal(threadId, { ...signalBody, token }),
        catch: (cause) => new PreviewProxyHttpError({ cause }),
      }).pipe(Effect.orElseSucceed(() => null));
      return isSignalPollResponse(relayed)
        ? HttpServerResponse.jsonUnsafe(relayed)
        : HttpServerResponse.text("Signaling relay unavailable", { status: 503 });
    }
    const published = gateway.signaling.publish({
      threadId,
      sessionId: signalBody.sessionId,
      token,
      type: signalBody.type,
      payload: signalBody.payload,
    });
    if (published === null) return HttpServerResponse.text("Forbidden", { status: 403 });
    const relayed = yield* Effect.tryPromise({
      try: () => gateway.relaySignal(threadId, { ...signalBody, token }),
      catch: (cause) => new PreviewProxyHttpError({ cause }),
    }).pipe(Effect.orElseSucceed(() => null));
    return relayed === null
      ? HttpServerResponse.text("Signaling relay unavailable", { status: 503 })
      : HttpServerResponse.jsonUnsafe(published);
  }),
);

export const sandboxCredentialHttpRouteLayer = HttpRouter.add(
  "POST",
  "/api/thread-credentials/*",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    const [threadId, action] = Option.isSome(url)
      ? url.value.pathname.slice("/api/thread-credentials/".length).split("/")
      : [];
    const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
    const credential = Schema.decodeUnknownOption(CredentialBodySchema)(body);
    if (!threadId || action !== "redeem" || Option.isNone(credential))
      return HttpServerResponse.text("Bad Request", { status: 400 });
    const value = desktopGateway.credentials.redeem({ threadId, ...credential.value });
    return value === null
      ? HttpServerResponse.text("Forbidden", { status: 403 })
      : HttpServerResponse.jsonUnsafe({ value }, { headers: { "cache-control": "no-store" } });
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

export const sandboxArtifactHttpRouteLayer = HttpRouter.add(
  "GET",
  "/api/sandbox-artifacts/*",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    const [artifactId, kind] = Option.isSome(url)
      ? url.value.pathname.slice("/api/sandbox-artifacts/".length).split("/")
      : [];
    if (
      !artifactId ||
      !/^[a-f0-9]{64}$/.test(artifactId) ||
      (kind !== "bundle" && kind !== "manifest")
    )
      return HttpServerResponse.text("Not Found", { status: 404 });
    const config = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = resolve(
      config.stateDir,
      "sandbox-artifacts",
      `${artifactId}.${kind === "bundle" ? "bundle" : "json"}`,
    );
    const bytes = yield* fs.readFile(path).pipe(Effect.option);
    if (Option.isNone(bytes)) return HttpServerResponse.text("Not Found", { status: 404 });
    return HttpServerResponse.uint8Array(bytes.value, {
      headers: {
        "content-type": kind === "bundle" ? "application/octet-stream" : "application/json",
        "cache-control": "no-store",
      },
    });
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

export const sandboxPreviewResolveHttpRouteLayer = HttpRouter.add(
  "*",
  "/api/thread-preview/*",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
    const suffix = url.value.pathname.slice("/api/thread-preview/".length);
    const [routeId, ...pathParts] = suffix.split("/");
    const threadId = url.value.searchParams.get("threadId") ?? "";
    const token = request.headers["x-t3-preview-token"] ?? "";
    if (!routeId) return HttpServerResponse.text("Bad Request", { status: 400 });
    const proxy = desktopGateway.previewProxy();
    if (proxy === null)
      return HttpServerResponse.text("Preview proxy unavailable", { status: 503 });
    if (request.headers.upgrade?.toLowerCase() === "websocket") {
      const command = proxy.webSocketCommand({
        routeId,
        threadId,
        token,
        path: `/${pathParts.join("/")}${url.value.search}`,
        headers: Object.fromEntries(
          Object.entries(request.headers).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        ),
      });
      return command === null
        ? HttpServerResponse.text("Forbidden", { status: 403 })
        : yield* relayPreviewWebSocket(request, command);
    }
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : new Uint8Array(
            yield* request.arrayBuffer.pipe(
              Effect.provideService(HttpIncomingMessage.MaxBodySize, FileSystem.MiB(8)),
              Effect.mapError((cause) => new PreviewProxyHttpError({ cause })),
            ),
          );
    const response = yield* Effect.tryPromise({
      try: () =>
        proxy.request({
          routeId,
          threadId,
          token,
          method: request.method,
          path: `/${pathParts.join("/")}${url.value.search}`,
          headers: Object.fromEntries(
            Object.entries(request.headers).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          ),
          ...(body === undefined ? {} : { body }),
        }),
      catch: (cause) => new PreviewProxyHttpError({ cause }),
    }).pipe(Effect.orElseSucceed(() => null));
    if (response === null) return HttpServerResponse.text("Bad Gateway", { status: 502 });
    const headers = Object.fromEntries(
      Object.entries(response.headers).filter(
        ([name]) =>
          !["set-cookie", "connection", "transfer-encoding", "content-length"].includes(
            name.toLowerCase(),
          ),
      ),
    );
    return HttpServerResponse.uint8Array(response.body, { status: response.status, headers });
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
      PreviewProxyHttpError: () =>
        Effect.succeed(HttpServerResponse.text("Preview request rejected", { status: 413 })),
    }),
  ),
);

type SignalBody = {
  sessionId: string;
  token?: string | undefined;
  type: "offer" | "answer" | "ice" | "input" | "poll";
  payload: string;
  sequence: number;
  role: "viewer" | "bridge";
};
const SignalBodySchema = Schema.Struct({
  sessionId: Schema.String,
  token: Schema.optional(Schema.String),
  type: Schema.Literals(["offer", "answer", "ice", "input", "poll"]),
  payload: Schema.String,
  sequence: Schema.Number,
  role: Schema.Literals(["viewer", "bridge"]),
});
const isBoundedSignalBody = (body: SignalBody) =>
  body.sessionId.length > 0 &&
  body.sessionId.length <= 128 &&
  (body.token === undefined || (body.token.length >= 32 && body.token.length <= 128)) &&
  body.payload.length <= 256 * 1024 &&
  Number.isSafeInteger(body.sequence) &&
  body.sequence >= 0 &&
  body.sequence <= Number.MAX_SAFE_INTEGER;
const isSignalPollResponse = (value: unknown): value is { messages: ReadonlyArray<unknown> } =>
  typeof value === "object" &&
  value !== null &&
  "messages" in value &&
  Array.isArray(value.messages) &&
  value.messages.length <= 256;

type CredentialBody = { readonly id: string; readonly token: string; readonly scope: string };
const CredentialBodySchema = Schema.Struct({
  id: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  token: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  scope: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
});

class PreviewProxyHttpError extends Data.TaggedError("PreviewProxyHttpError")<{
  readonly cause: unknown;
}> {}

const relayPreviewWebSocket = Effect.fnUntraced(function* (
  request: HttpServerRequest.HttpServerRequest,
  command: { executable: string; args: ReadonlyArray<string>; handshake: string },
) {
  const downstream = yield* Effect.orDie(request.upgrade);
  const writeDownstream = yield* downstream.writer;
  const child = spawn(command.executable, [...command.args], {
    stdio: ["pipe", "pipe", "ignore"],
    shell: false,
    detached: process.platform !== "win32",
    env: { PATH: process.env.PATH },
  });
  const terminate = () => {
    if (child.pid === undefined || child.killed) return;
    try {
      process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL");
    } catch {
      /* already exited */
    }
  };
  child.stdin.on("error", terminate);
  child.stdin.write(`${command.handshake}\n`);
  let pending = Promise.resolve<void>(undefined);
  let buffer = Buffer.alloc(0);
  const receive = Effect.callback<void>((resume) => {
    const handshakeTimer = setTimeout(terminate, 10_000);
    let received = false;
    const onData = (chunk: Buffer) => {
      if (!received) {
        received = true;
        clearTimeout(handshakeTimer);
      }
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (length > 1024 * 1024) {
          terminate();
          break;
        }
        if (buffer.length < length + 4) break;
        const payload = new Uint8Array(buffer.subarray(4, length + 4));
        buffer = buffer.subarray(length + 4);
        pending = pending
          .then(() => Effect.runPromise(writeDownstream(payload)))
          .then(() => undefined);
      }
    };
    const done = () => {
      clearTimeout(handshakeTimer);
      resume(Effect.void);
    };
    child.stdout.on("data", onData);
    child.once("error", done);
    child.once("exit", done);
    return Effect.sync(() => {
      child.stdout.off("data", onData);
      clearTimeout(handshakeTimer);
      terminate();
    });
  });
  const send = downstream.runRaw((chunk) =>
    Effect.sync(() => {
      const payload =
        typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array);
      if (payload.length > 1024 * 1024) {
        terminate();
        return;
      }
      const header = Buffer.allocUnsafe(4);
      header.writeUInt32BE(payload.length);
      child.stdin.write(Buffer.concat([header, payload]));
    }),
  );
  yield* send.pipe(Effect.raceFirst(receive), Effect.ensuring(Effect.sync(terminate)));
  return HttpServerResponse.empty();
});

const signalCookieName = (threadId: string) =>
  `t3-desktop-${threadId.replace(/[^A-Za-z0-9]/g, "-")}`;

const viewerHtml = (threadId: string, sessionId: string, token: string) => `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body,video{width:100%;height:100%;margin:0;background:#111}video{object-fit:contain}</style>
<video id="desktop" autoplay playsinline></video><script>
const endpoint=${JSON.stringify(`${prefix}${threadId}/signal`)};
const auth=${JSON.stringify({ sessionId, token, role: "viewer" })}; let sequence=0;
const peer=new RTCPeerConnection(); peer.ontrack=e=>desktop.srcObject=e.streams[0];
peer.onicecandidate=e=>e.candidate&&send('ice',JSON.stringify(e.candidate));
async function send(type,payload=''){const r=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...auth,type,payload,sequence})});if(!r.ok)throw new Error('desktop signaling rejected');return r.json()}
let retry=250,stopped=false,timer;async function poll(){if(stopped)return;try{const r=await send('poll');for(const m of r.messages){sequence=Math.max(sequence,m.sequence);if(m.type==='offer'){await peer.setRemoteDescription({type:'offer',sdp:m.payload});const a=await peer.createAnswer();await peer.setLocalDescription(a);await send('answer',a.sdp)}else if(m.type==='ice')await peer.addIceCandidate(JSON.parse(m.payload))}retry=250}catch{retry=Math.min(retry*2,5000)}timer=setTimeout(poll,retry)}
poll(); addEventListener('online',()=>{retry=250});addEventListener('pagehide',()=>{stopped=true;clearTimeout(timer);peer.close()},{once:true});
desktop.tabIndex=0;desktop.addEventListener('pointerdown',e=>send('input',JSON.stringify({kind:'pointer',action:'down',x:e.offsetX,y:e.offsetY,button:e.button})).catch(()=>{}));desktop.addEventListener('pointermove',e=>{if(e.buttons)send('input',JSON.stringify({kind:'pointer',action:'move',x:e.offsetX,y:e.offsetY,buttons:e.buttons})).catch(()=>{})});desktop.addEventListener('pointerup',e=>send('input',JSON.stringify({kind:'pointer',action:'up',x:e.offsetX,y:e.offsetY,button:e.button})).catch(()=>{}));desktop.addEventListener('keydown',e=>{e.preventDefault();send('input',JSON.stringify({kind:'key',action:'down',key:e.key,code:e.code,alt:e.altKey,ctrl:e.ctrlKey,meta:e.metaKey,shift:e.shiftKey})).catch(()=>{})});desktop.addEventListener('keyup',e=>{e.preventDefault();send('input',JSON.stringify({kind:'key',action:'up',key:e.key,code:e.code})).catch(()=>{})});
</script>`;
