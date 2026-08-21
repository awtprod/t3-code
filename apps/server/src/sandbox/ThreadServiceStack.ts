// @effect-diagnostics globalTimers:off - bounded container health polling at the runtime boundary.
import * as NodeCrypto from "node:crypto";
import type { SandboxCommandExecutor } from "./types.ts";

export type ThreadServiceDeclaration = {
  readonly name: string;
  readonly image: string;
  readonly internalPorts?: ReadonlyArray<number>;
  readonly environment?: Readonly<Record<string, string>>;
  readonly volumes?: ReadonlyArray<{ readonly name: string; readonly target: string }>;
  readonly healthCheck?: {
    readonly executable: string;
    readonly args?: ReadonlyArray<string>;
    readonly intervalSeconds?: number;
    readonly timeoutSeconds?: number;
    readonly retries?: number;
  };
  readonly generatedEnvironment?: ReadonlyArray<{
    readonly key: string;
    readonly kind: "database-name" | "username" | "password";
  }>;
};

export type ThreadServiceInstance = {
  readonly name: string;
  readonly hostname: string;
  readonly networkName: string;
  readonly image: string;
  readonly internalPorts: ReadonlyArray<number>;
  readonly hostPorts: ReadonlyArray<never>;
  readonly environment: Readonly<Record<string, string>>;
  readonly volumes: ReadonlyArray<{ readonly name: string; readonly target: string }>;
};

export const planThreadServiceStack = (
  threadId: string,
  declarations: ReadonlyArray<ThreadServiceDeclaration>,
): ReadonlyArray<ThreadServiceInstance> => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(threadId)) throw new Error("invalid thread id");
  const suffix = NodeCrypto.createHash("sha256").update(threadId).digest("hex").slice(0, 16);
  const networkName = `t3-net-${suffix}`;
  const names = new Set<string>();
  return declarations.map((service) => {
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(service.name) || names.has(service.name))
      throw new Error(`invalid or duplicate service name: ${service.name}`);
    names.add(service.name);
    if (!/^[a-z0-9][a-z0-9._/-]{0,200}@sha256:[a-f0-9]{64}$/i.test(service.image))
      throw new Error(`service image must be pinned by sha256 digest: ${service.name}`);
    const ports = service.internalPorts ?? [];
    if (ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535))
      throw new Error(`invalid internal port for ${service.name}`);
    return {
      name: `t3-svc-${suffix}-${service.name}`,
      hostname: service.name,
      networkName,
      image: service.image,
      internalPorts: [...ports],
      hostPorts: [],
      environment: { ...service.environment, T3_THREAD_ID: threadId },
      volumes: (service.volumes ?? []).map((volume) => ({
        name: `t3-vol-${suffix}-${volume.name}`,
        target: volume.target,
      })),
    };
  });
};

/**
 * Resource ceilings for thread service containers (databases and the like).
 * Roomier than the proxy sidecars but still bounded: a service without limits
 * shares the host with every other thread's sandbox.
 */
const SERVICE_MEMORY = "1g";
const SERVICE_CPUS = "1";

export class ThreadServiceStackRuntime {
  readonly #executor: SandboxCommandExecutor;
  readonly #runtime: "docker" | "podman";
  readonly #active = new Map<string, ReadonlyArray<ThreadServiceInstance>>();

  constructor(runtime: "docker" | "podman", executor: SandboxCommandExecutor) {
    this.#runtime = runtime;
    this.#executor = executor;
  }

  async start(
    threadId: string,
    declarations: ReadonlyArray<ThreadServiceDeclaration>,
    networkName: string,
  ) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(networkName))
      throw new Error("invalid sandbox network name");
    const materialized = declarations.map((service) => ({
      ...service,
      environment: {
        ...service.environment,
        ...Object.fromEntries(
          (service.generatedEnvironment ?? []).map((entry) => [
            entry.key,
            generatedServiceValue(threadId, service.name, entry),
          ]),
        ),
      },
    }));
    const services = planThreadServiceStack(threadId, materialized).map((service) => ({
      ...service,
      networkName,
    }));
    const started: Array<ThreadServiceInstance> = [];
    this.#active.set(threadId, started);
    for (const service of services) {
      const args = [
        this.#runtime,
        "run",
        "--detach",
        "--name",
        service.name,
        "--network",
        service.networkName,
        "--label",
        "com.t3tools.sandbox.managed=true",
        "--label",
        `com.t3tools.sandbox.thread=${threadId}`,
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "256",
        "--memory",
        SERVICE_MEMORY,
        "--memory-swap",
        SERVICE_MEMORY,
        "--cpus",
        SERVICE_CPUS,
        ...(declarations.find((item) => item.name === service.hostname)?.healthCheck
          ? healthCheckArgs(
              declarations.find((item) => item.name === service.hostname)!.healthCheck!,
            )
          : []),
        "--env-file",
        "/dev/stdin",
        ...service.volumes.flatMap((volume) => [
          "--mount",
          `type=volume,src=${volume.name},dst=${volume.target}`,
        ]),
        service.image,
      ];
      for (const volume of service.volumes) {
        const volumeResult = await this.#executor.run({
          executable: this.#runtime,
          args: [
            "volume",
            "create",
            "--label",
            "com.t3tools.sandbox.managed=true",
            "--label",
            `com.t3tools.sandbox.thread=${threadId}`,
            volume.name,
          ],
          timeoutMs: 30_000,
        });
        if (volumeResult.exitCode !== 0) {
          await this.stop(threadId);
          throw new Error(`failed to create service volume ${volume.name}: ${volumeResult.stderr}`);
        }
      }
      const result = await this.#executor.run({
        executable: this.#runtime,
        args: args.slice(1),
        stdin: Object.entries(service.environment)
          .map(([key, value]) => `${key}=${value}`)
          .join("\n"),
        timeoutMs: 60_000,
      });
      if (result.exitCode !== 0) {
        await this.stop(threadId);
        throw new Error(`failed to start service ${service.name}: ${result.stderr}`);
      }
      const health = declarations.find((item) => item.name === service.hostname)?.healthCheck;
      if (health !== undefined) {
        await this.#waitHealthy(service.name, health);
      }
      started.push(service);
    }
    this.#active.set(threadId, services);
    return services;
  }

  async stop(threadId: string) {
    const services = this.#active.get(threadId) ?? [];
    for (const service of [...services].toReversed())
      await this.#executor
        .run({
          executable: this.#runtime,
          args: ["rm", "--force", service.name],
          timeoutMs: 30_000,
        })
        .catch(() => undefined);
    for (const volume of new Set(
      services.flatMap((service) => service.volumes.map((item) => item.name)),
    ))
      await this.#executor
        .run({ executable: this.#runtime, args: ["volume", "rm", volume], timeoutMs: 30_000 })
        .catch(() => undefined);
    this.#active.delete(threadId);
  }

  async recover(threadId: string, services: ReadonlyArray<ThreadServiceInstance>) {
    const active: Array<ThreadServiceInstance> = [];
    for (const service of services) {
      const result = await this.#executor.run({
        executable: this.#runtime,
        args: ["inspect", service.name],
        timeoutMs: 10_000,
      });
      if (result.exitCode === 0) active.push(service);
    }
    this.#active.set(threadId, active);
    return active;
  }

  redactCredentials(threadId: string) {
    const services = this.#active.get(threadId);
    if (services !== undefined)
      this.#active.set(
        threadId,
        services.map((service) => ({ ...service, environment: {} })),
      );
  }

  async discover(threadId: string) {
    const listed = await this.#executor.run({
      executable: this.#runtime,
      args: [
        "ps",
        "--all",
        "--filter",
        `label=com.t3tools.sandbox.thread=${threadId}`,
        "--format",
        "{{.Names}}",
      ],
      timeoutMs: 10_000,
    });
    if (listed.exitCode !== 0)
      throw new Error(`failed to discover thread services: ${listed.stderr}`);
    const names = listed.stdout
      .split("\n")
      .map((item) => item.trim())
      .filter((name) => name.startsWith("t3-svc-"));
    return names;
  }

  async #waitHealthy(name: string, health: NonNullable<ThreadServiceDeclaration["healthCheck"]>) {
    const intervalMs = Math.min(Math.max(health.intervalSeconds ?? 10, 1), 300) * 1000;
    const deadline =
      performance.timeOrigin +
      performance.now() +
      Math.min(intervalMs * (health.retries ?? 5), 120_000);
    while (performance.timeOrigin + performance.now() < deadline) {
      const inspected = await this.#executor.run({
        executable: this.#runtime,
        args: [
          "inspect",
          "--format",
          "{{.State.Running}}\t{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}",
          name,
        ],
        timeoutMs: Math.min(health.timeoutSeconds ?? 3, 60) * 1000,
      });
      const status = inspected.stdout.trim();
      if (inspected.exitCode === 0 && status === "true\thealthy") return;
      if (
        inspected.exitCode !== 0 ||
        status.startsWith("false\t") ||
        status === "true\tunhealthy"
      ) {
        await this.#stopByName(name);
        throw new Error(`service ${name} failed its health check`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(intervalMs, 1_000)));
    }
    await this.#stopByName(name);
    throw new Error(`service ${name} health check timed out`);
  }

  async #stopByName(name: string) {
    await this.#executor
      .run({ executable: this.#runtime, args: ["rm", "--force", name], timeoutMs: 30_000 })
      .catch(() => undefined);
  }
}

const generatedServiceValue = (
  threadId: string,
  service: string,
  entry: { readonly key: string; readonly kind: "database-name" | "username" | "password" },
) =>
  entry.kind === "database-name"
    ? `db_${NodeCrypto.createHash("sha256").update(`${threadId}\0${service}`).digest("hex").slice(0, 16)}`
    : entry.kind === "username"
      ? `u_${NodeCrypto.randomBytes(12).toString("hex")}`
      : NodeCrypto.randomBytes(32).toString("base64url");

const healthCheckArgs = (health: NonNullable<ThreadServiceDeclaration["healthCheck"]>) => {
  if (
    !health.executable ||
    health.executable.includes("\0") ||
    health.args?.some((item) => item.includes("\0"))
  )
    throw new Error("invalid service health check");
  const interval = Math.min(Math.max(health.intervalSeconds ?? 10, 1), 300);
  const timeout = Math.min(Math.max(health.timeoutSeconds ?? 3, 1), 60);
  const retries = Math.min(Math.max(health.retries ?? 5, 1), 30);
  return [
    "--health-cmd",
    [health.executable, ...(health.args ?? [])].join(" "),
    "--health-interval",
    `${interval}s`,
    "--health-timeout",
    `${timeout}s`,
    "--health-retries",
    String(retries),
  ];
};
