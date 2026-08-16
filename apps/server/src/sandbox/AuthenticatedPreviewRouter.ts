import * as NodeCrypto from "node:crypto";

type Route = {
  readonly threadId: string;
  readonly hostname: string;
  readonly internalPort: number;
  readonly tokenHash: Buffer;
};

export class AuthenticatedPreviewRouter {
  readonly #routes = new Map<string, Route>();

  register(input: {
    routeId: string;
    threadId: string;
    hostname: string;
    internalPort: number;
    token: string;
  }) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.routeId))
      throw new Error("invalid route id");
    if (
      !Number.isInteger(input.internalPort) ||
      input.internalPort < 1 ||
      input.internalPort > 65535
    )
      throw new Error("invalid preview port");
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(input.hostname))
      throw new Error("invalid preview hostname");
    this.#routes.set(input.routeId, {
      threadId: input.threadId,
      hostname: input.hostname,
      internalPort: input.internalPort,
      tokenHash: hash(input.token),
    });
  }

  resolve(input: { routeId: string; threadId: string; token: string }) {
    const route = this.#routes.get(input.routeId);
    if (route === undefined) return null;
    const tokenHash = hash(input.token);
    if (
      route.threadId !== input.threadId ||
      !NodeCrypto.timingSafeEqual(route.tokenHash, tokenHash)
    )
      return null;
    return { hostname: route.hostname, port: route.internalPort };
  }

  removeThread(threadId: string) {
    for (const [id, route] of this.#routes)
      if (route.threadId === threadId) this.#routes.delete(id);
  }
}

const hash = (value: string) => NodeCrypto.createHash("sha256").update(value).digest();
