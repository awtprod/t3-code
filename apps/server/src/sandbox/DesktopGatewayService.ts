import { AuthenticatedPreviewRouter } from "./AuthenticatedPreviewRouter.ts";
import { ThreadCredentialBroker } from "./CredentialBroker.ts";
import { ThreadDesktopSignaling } from "./DesktopSession.ts";
import type { ThreadPreviewProxy } from "./ThreadPreviewProxy.ts";
import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

type ViewerCredential = { readonly sessionId: string; readonly token: string };

const signaling = new ThreadDesktopSignaling();
const credentials = new ThreadCredentialBroker();
const previews = new AuthenticatedPreviewRouter();
const viewers = new Map<string, ViewerCredential>();
const targets = new Map<string, { endpoint: string; profilePath: string; token: string }>();
const failures = new Map<string, ReadonlyArray<string>>();
const services = new Map<string, ReadonlyArray<{ name: string; healthy: boolean }>>();
const humanControllers = new Set<string>();
const previewRoutes = new Map<
  string,
  ReadonlyArray<{ routeId: string; internalPort: number; token: string }>
>();
const serviceCredentialGrants = new Map<
  string,
  ReadonlyArray<{ id: string; token: string; scope: string; expiresAt: number }>
>();
let previewProxy: ThreadPreviewProxy | null = null;
const tickets = new Map<string, { threadId: string; hash: Buffer; expiresAt: number }>();

/** Server-lifetime singleton shared by HTTP routes and sandbox lifecycle. */
export const desktopGateway = {
  signaling,
  credentials,
  previews,
  viewer(threadId: string) {
    const current = viewers.get(threadId);
    if (current !== undefined && signaling.status(threadId) !== null) return current;
    const issued = signaling.issue(threadId);
    viewers.set(threadId, issued);
    return issued;
  },
  bridge(threadId: string) {
    return signaling.issue(threadId, "bridge");
  },
  issueViewerTicket(threadId: string) {
    const id = NodeCrypto.randomBytes(16).toString("hex");
    const secret = NodeCrypto.randomBytes(32).toString("base64url");
    const expiresAt = performance.timeOrigin + performance.now() + 60_000;
    tickets.set(id, {
      threadId,
      hash: NodeCrypto.createHash("sha256").update(secret).digest(),
      expiresAt,
    });
    return {
      ticket: `${id}.${secret}`,
      expiresAt: DateTime.formatIso(Option.getOrThrow(DateTime.make(expiresAt))),
    };
  },
  consumeViewerTicket(threadId: string, ticket: string) {
    this.purgeExpired();
    const separator = ticket.indexOf(".");
    if (separator < 1) return false;
    const id = ticket.slice(0, separator);
    const record = tickets.get(id);
    tickets.delete(id);
    if (
      record === undefined ||
      record.threadId !== threadId ||
      record.expiresAt <= performance.timeOrigin + performance.now()
    )
      return false;
    const supplied = NodeCrypto.createHash("sha256")
      .update(ticket.slice(separator + 1))
      .digest();
    return NodeCrypto.timingSafeEqual(record.hash, supplied);
  },
  purgeExpired() {
    const now = performance.timeOrigin + performance.now();
    let purged = 0;
    for (const [id, ticket] of tickets) {
      if (ticket.expiresAt > now) continue;
      tickets.delete(id);
      purged += 1;
    }
    signaling.purgeExpired();
    credentials.purgeExpired();
    for (const [threadId] of viewers)
      if (signaling.status(threadId) === null) viewers.delete(threadId);
    return purged;
  },
  setAutomationTarget(threadId: string, hostname: string, profilePath: string) {
    const routeId = NodeCrypto.createHash("sha256")
      .update(`${threadId}\0cdp`)
      .digest("hex")
      .slice(0, 24);
    const token = NodeCrypto.randomBytes(32).toString("base64url");
    previews.register({ routeId, threadId, hostname, internalPort: 9222, token });
    targets.set(threadId, {
      endpoint: `/api/thread-preview/${routeId}/`,
      profilePath,
      token,
    });
    failures.delete(threadId);
  },
  automationTarget(threadId: string) {
    return targets.get(threadId) ?? null;
  },
  async invokeAutomation(threadId: string, operation: string, input: unknown, timeoutMs: number) {
    const target = targets.get(threadId);
    if (target === undefined || previewProxy === null) return null;
    return previewProxy.automate({
      routeId: NodeCrypto.createHash("sha256")
        .update(`${threadId}\0cdp`)
        .digest("hex")
        .slice(0, 24),
      threadId,
      token: target.token,
      operation,
      payload: input,
      timeoutMs,
    });
  },
  async relaySignal(threadId: string, payload: unknown) {
    if (previewProxy === null) throw new Error("thread signaling sidecar is unavailable");
    return previewProxy.signal(threadId, payload);
  },
  setCapabilityFailure(threadId: string, missing: ReadonlyArray<string>) {
    failures.set(threadId, [...missing]);
    targets.delete(threadId);
  },
  setServiceStatus(threadId: string, status: ReadonlyArray<{ name: string; healthy: boolean }>) {
    services.set(
      threadId,
      status.map((item) => ({ ...item })),
    );
  },
  setServiceCredentialGrants(
    threadId: string,
    grants: ReadonlyArray<{ id: string; token: string; scope: string; expiresAt: number }>,
  ) {
    serviceCredentialGrants.set(
      threadId,
      grants.map((grant) => ({ ...grant })),
    );
  },
  setHumanControl(threadId: string, active: boolean) {
    if (active) humanControllers.add(threadId);
    else humanControllers.delete(threadId);
  },
  acceptsHumanInput(threadId: string) {
    return humanControllers.has(threadId);
  },
  setPreviewProxy(proxy: ThreadPreviewProxy) {
    previewProxy = proxy;
  },
  registerPreviewRoute(input: {
    routeId: string;
    threadId: string;
    hostname: string;
    internalPort: number;
    token: string;
  }) {
    previews.register(input);
    const routes = previewRoutes.get(input.threadId) ?? [];
    previewRoutes.set(input.threadId, [
      ...routes.filter((route) => route.routeId !== input.routeId),
      {
        routeId: input.routeId,
        internalPort: input.internalPort,
        token: input.token,
      },
    ]);
  },
  previewProxy() {
    return previewProxy;
  },
  status(threadId: string) {
    return {
      connected: signaling.status(threadId)?.connected ?? false,
      ready: targets.has(threadId) && !failures.has(threadId),
      capabilityFailure: failures.get(threadId) ?? [],
      services: services.get(threadId) ?? [],
      previewRoutes: previewRoutes.get(threadId) ?? [],
      serviceCredentialGrants: serviceCredentialGrants.get(threadId) ?? [],
    };
  },
  removeThread(threadId: string) {
    viewers.delete(threadId);
    targets.delete(threadId);
    failures.delete(threadId);
    services.delete(threadId);
    humanControllers.delete(threadId);
    previewRoutes.delete(threadId);
    serviceCredentialGrants.delete(threadId);
    previews.removeThread(threadId);
    credentials.revokeThread(threadId);
    signaling.disconnect(threadId);
    signaling.remove(threadId);
  },
};
