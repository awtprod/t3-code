// @effect-diagnostics nodeBuiltinImport:off - Tests drive the bundled binaries as real processes; there is no Effect runtime here.
import * as NodeChildProcess from "node:child_process";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import type * as NodeHttp from "node:http";

/**
 * Test helpers that drive the *bundled* binaries. Everything here waits on a
 * real event — a listening callback, a stdout frame, a process exit — because
 * a sandbox-bridge test that needs a sleep is testing nothing.
 */
const packageRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
);

export const binaryPath = (name: string) => NodePath.join(packageRoot, "dist", `${name}.mjs`);

export const spawnBinary = (
  name: string,
  args: ReadonlyArray<string>,
  environment?: Readonly<Record<string, string>>,
) =>
  NodeChildProcess.spawn(process.execPath, [binaryPath(name), ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    ...(environment === undefined ? {} : { env: { ...process.env, ...environment } }),
  });

/** Runs a one-shot binary with a single stdin document and collects stdout. */
export const runBinary = (name: string, args: ReadonlyArray<string>, stdin: string) =>
  new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawnBinary(name, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.once("error", reject);
    child.once("close", (code) => resolve({ stdout, stderr, code }));
    child.stdin.end(stdin);
  });

/**
 * Resolves once the binary announces its listening address on stderr, yielding
 * the port it actually bound. `--listen host:0` therefore needs no port probing.
 */
export const spawnListening = (
  name: string,
  args: ReadonlyArray<string>,
  environment?: Readonly<Record<string, string>>,
) =>
  new Promise<{ child: NodeChildProcess.ChildProcessWithoutNullStreams; port: number }>(
    (resolve, reject) => {
      const child = spawnBinary(name, args, environment);
      let stderr = "";
      const onData = (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
        const announced = /listening on \S+?:(\d+)/.exec(stderr);
        if (announced === null) return;
        child.stderr.off("data", onData);
        resolve({ child, port: Number(announced[1]) });
      };
      child.stderr.on("data", onData);
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`binary exited early (${code}): ${stderr}`)));
    },
  );

/**
 * Resolves when the child's accumulated stderr matches `pattern`. Used to wait
 * on a real lifecycle event (a config reload, say) instead of retrying blindly.
 */
export const waitForStderr = (
  child: NodeChildProcess.ChildProcessWithoutNullStreams,
  pattern: RegExp,
) =>
  new Promise<string>((resolve) => {
    let stderr = "";
    const onData = (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      const matched = pattern.exec(stderr);
      if (matched === null) return;
      child.stderr.off("data", onData);
      resolve(matched[0]);
    };
    child.stderr.on("data", onData);
  });

/** Kills a captured child by its own PID and waits for the exit event. */
export const stopChild = (child: NodeChildProcess.ChildProcess) =>
  new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
    child.kill("SIGKILL");
  });

/** Reads uint32-BE length-prefixed frames off a stream into an async queue. */
export class FrameReader {
  #buffer = Buffer.alloc(0);
  readonly #ready: Array<Buffer> = [];
  readonly #waiters: Array<(frame: Buffer) => void> = [];

  constructor(stream: NodeJS.ReadableStream) {
    stream.on("data", (chunk: Buffer) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      while (this.#buffer.length >= 4) {
        const length = this.#buffer.readUInt32BE(0);
        if (this.#buffer.length < length + 4) break;
        const frame = this.#buffer.subarray(4, length + 4);
        this.#buffer = this.#buffer.subarray(length + 4);
        const waiter = this.#waiters.shift();
        if (waiter === undefined) this.#ready.push(Buffer.from(frame));
        else waiter(Buffer.from(frame));
      }
    });
  }

  next() {
    const queued = this.#ready.shift();
    return queued === undefined
      ? new Promise<Buffer>((resolve) => this.#waiters.push(resolve))
      : Promise.resolve(queued);
  }
}

export const encodeFrame = (payload: Buffer) => {
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
};

/** Starts an HTTP server on an ephemeral port and resolves with its port. */
export const listen = (server: NodeHttp.Server | NodeNet.Server) =>
  new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as NodeNet.AddressInfo).port);
    });
  });

/** Closes a server, dropping upgraded sockets that would otherwise hold it open. */
export const closeServer = (server: NodeHttp.Server | NodeNet.Server) =>
  new Promise<void>((resolve) => {
    server.close(() => resolve());
    if ("closeAllConnections" in server) server.closeAllConnections();
  });
