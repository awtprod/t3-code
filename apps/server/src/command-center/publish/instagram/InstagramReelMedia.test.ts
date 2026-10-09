// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { ThreadId, type InstagramReelBinding } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import {
  makeInstagramReelMedia,
  readPrivateMediaFile,
  type InstagramReelMediaOptions,
} from "./InstagramReelMedia.ts";
import { makeLiveReelHost } from "./InstagramPublishLive.ts";

// Synthetic bytes and signatures only; never load the owner's provider artifacts in tests.
const bytes = new Uint8Array(2048).fill(42);
const sha = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const host = "instagram-posts.678d26f30bb8cf1ca3b9e7a70c46cd41.r2.cloudflarestorage.com";
const endpoint = "https://678d26f30bb8cf1ca3b9e7a70c46cd41.r2.cloudflarestorage.com";
const key = `instagram/manual/april-riles/20261002/${sha}.mp4`;
const current = Date.parse("2026-10-02T22:00:00.000Z");
const binding: InstagramReelBinding = {
  version: 1,
  accountId: "17841463886554034",
  accountRevision: 1,
  threadId: ThreadId.make("synthetic-reel"),
  relativePath: "exports/synthetic.mp4",
  workspaceRoot: "/tmp/synthetic-reel",
  sha256: sha,
  sizeBytes: bytes.length,
  durationMs: 34600,
  caption: "Synthetic caption",
  dueUtc: "2026-10-02T22:00:00.000Z",
  lateWindowMs: 120000,
};
function fixture() {
  const receipt = {
    key,
    sha256: sha,
    bytes: bytes.length,
    duration_seconds: 34.6,
    verified: true,
    local_hash_verified: true,
    endpoint,
    bucket: "instagram-posts",
    stored_metadata: { contentLength: bytes.length, contentType: "video/mp4" },
    get_status: 200,
    content_type: "video/mp4",
    content_length: String(bytes.length),
    public_sha256: sha,
    public_bytes: bytes.length,
    range_status: 206,
    content_range: `bytes 0-1023/${bytes.length}`,
    verified_at: "2026-10-02T17:16:00.000Z",
    signed_at: "20261002T171550Z",
    expires_in_seconds: 604800,
    // Intentionally ignored: this must never become a server read path.
    url_artifact: "/client-controlled/forbidden",
  };
  const url = new URL(`https://${host}/${key}`);
  const params = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Content-Sha256": "UNSIGNED-PAYLOAD",
    "X-Amz-Credential": "syntheticaccesskey/20261002/auto/s3/aws4_request",
    "X-Amz-Date": receipt.signed_at,
    "X-Amz-Expires": "604800",
    "X-Amz-Signature": "a".repeat(64),
    "X-Amz-SignedHeaders": "host",
    "response-content-disposition": "inline",
    "response-content-type": "video/mp4",
    "x-id": "GetObject",
  };
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  const calls: RequestInit[] = [];
  const readPaths: string[] = [];
  const response = (
    range: boolean,
    body = range ? bytes.subarray(0, 1024) : bytes,
    overrides: Record<string, string> = {},
  ) =>
    new Response(body, {
      status: range ? 206 : 200,
      headers: {
        "content-type": "video/mp4",
        "content-length": String(range ? 1024 : bytes.length),
        ...(range ? { "content-range": `bytes 0-1023/${bytes.length}` } : {}),
        ...overrides,
      },
    });
  const options: {
    -readonly [K in keyof InstagramReelMediaOptions]: InstagramReelMediaOptions[K];
  } = {
    receiptPath: "/server/receipt.json",
    urlPath: "/server/private-url.txt",
    now: () => current,
    readFile: async (path, limit) => {
      readPaths.push(path);
      const value = path === "/server/receipt.json" ? JSON.stringify(receipt) : url.toString();
      if (Buffer.byteLength(value) > limit) throw new Error("synthetic bound");
      return value;
    },
    fetch: async (_url, init) => {
      calls.push(init!);
      return response(calls.length === 2);
    },
  };
  return { receipt, url, calls, readPaths, response, options };
}
const invoke = (f: ReturnType<typeof fixture>, b = binding) =>
  makeInstagramReelMedia(f.options)(b, new AbortController().signal);
async function reject(f: ReturnType<typeof fixture>, b = binding) {
  const result = await invoke(f, b).then(
    () => null,
    (error: unknown) => error,
  );
  expect(result).toMatchObject({ reason: "validation" });
  // Assertions never print the synthetic capability either.
  const serialized = JSON.stringify(result);
  expect(serialized.includes("X-Amz")).toBe(false);
  expect(serialized.includes("syntheticaccesskey")).toBe(false);
  expect(serialized.includes(host)).toBe(false);
}

describe("server-owned Reel provider artifact", () => {
  it("streams matching bytes, validates matching range and uses GET with no redirects", async () => {
    const f = fixture();
    expect((await invoke(f)) === f.url.toString()).toBe(true);
    expect(f.readPaths).toEqual(["/server/receipt.json", "/server/private-url.txt"]);
    expect(f.calls).toHaveLength(2);
    expect(f.calls.map((call) => call.method)).toEqual(["GET", "GET"]);
    expect(f.calls.every((call) => call.redirect === "error")).toBe(true);
    expect(f.calls[1]!.headers).toEqual({ Range: "bytes=0-1023" });
  });
  it.effect(
    "the actual live host port delegates to the adapter and sanitizes provider errors",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        const value = yield* makeLiveReelHost(f.options)(binding);
        expect(value === f.url.toString()).toBe(true);
        expect(f.calls).toHaveLength(2);
        const bad = fixture();
        bad.options.fetch = async () => {
          throw new Error(bad.url.toString());
        };
        const result = yield* Effect.result(makeLiveReelHost(bad.options)(binding));
        expect(result._tag).toBe("Failure");
        expect(JSON.stringify(result).includes("X-Amz")).toBe(false);
      }),
  );
  it.effect("missing configuration is lazy and fails closed only when hosting is requested", () =>
    Effect.gen(function* () {
      const port = makeLiveReelHost({});
      expect(typeof port).toBe("function");
      expect((yield* Effect.result(port(binding)))._tag).toBe("Failure");
    }),
  );
  for (const [name, modify] of [
    [
      "unverified",
      (r) => {
        r.verified = false;
      },
    ],
    [
      "local evidence",
      (r) => {
        r.local_hash_verified = false;
      },
    ],
    [
      "foreign bucket",
      (r) => {
        r.bucket = "foreign";
      },
    ],
    [
      "foreign endpoint",
      (r) => {
        r.endpoint = "https://foreign.invalid";
      },
    ],
    [
      "foreign key",
      (r) => {
        r.key = `other/${sha}.mp4`;
      },
    ],
    [
      "hash",
      (r) => {
        r.sha256 = "b".repeat(64);
      },
    ],
    [
      "public hash",
      (r) => {
        r.public_sha256 = "b".repeat(64);
      },
    ],
    [
      "size",
      (r) => {
        r.bytes++;
      },
    ],
    [
      "public size",
      (r) => {
        r.public_bytes++;
      },
    ],
    [
      "duration",
      (r) => {
        r.duration_seconds = 35;
      },
    ],
    [
      "stored type",
      (r) => {
        r.stored_metadata.contentType = "text/plain";
      },
    ],
    [
      "stored size",
      (r) => {
        r.stored_metadata.contentLength++;
      },
    ],
    [
      "full GET",
      (r) => {
        r.get_status = 403;
      },
    ],
    [
      "range evidence",
      (r) => {
        r.range_status = 200;
      },
    ],
    [
      "range total",
      (r) => {
        r.content_range = "bytes 0-1023/999";
      },
    ],
    [
      "verification time",
      (r) => {
        r.verified_at = "invalid";
      },
    ],
    [
      "lifetime over seven days",
      (r) => {
        r.expires_in_seconds = 604801;
      },
    ],
  ] satisfies Array<[string, (receipt: ReturnType<typeof fixture>["receipt"]) => void]>) {
    it(`rejects receipt ${name} before fetching`, async () => {
      const f = fixture();
      modify(f.receipt);
      await reject(f);
      expect(f.calls).toHaveLength(0);
    });
  }
  for (const [name, modify] of [
    [
      "foreign host",
      (u) => {
        u.hostname = "foreign.invalid";
      },
    ],
    [
      "http",
      (u) => {
        u.protocol = "http:";
      },
    ],
    [
      "userinfo",
      (u) => {
        u.username = "foreign";
      },
    ],
    [
      "port",
      (u) => {
        u.port = "8443";
      },
    ],
    [
      "fragment",
      (u) => {
        u.hash = "fragment";
      },
    ],
    [
      "wrong path",
      (u) => {
        u.pathname = "/other.mp4";
      },
    ],
    [
      "missing param",
      (u) => {
        u.searchParams.delete("X-Amz-Signature");
      },
    ],
    [
      "duplicate param",
      (u) => {
        u.searchParams.append("X-Amz-Date", "bad");
      },
    ],
    [
      "unknown param",
      (u) => {
        u.searchParams.set("foreign", "bad");
      },
    ],
    [
      "bad signature shape",
      (u) => {
        u.searchParams.set("X-Amz-Signature", "bad");
      },
    ],
    [
      "wrong date",
      (u) => {
        u.searchParams.set("X-Amz-Date", "20261003T171550Z");
      },
    ],
    [
      "wrong region",
      (u) => {
        u.searchParams.set(
          "X-Amz-Credential",
          "syntheticaccesskey/20261002/us-east-1/s3/aws4_request",
        );
      },
    ],
    [
      "wrong expiry",
      (u) => {
        u.searchParams.set("X-Amz-Expires", "3600");
      },
    ],
  ] satisfies Array<[string, (url: URL) => void]>) {
    it(`rejects signed URL ${name} before fetching`, async () => {
      const f = fixture();
      modify(f.url);
      await reject(f);
      expect(f.calls).toHaveLength(0);
    });
  }
  it("rejects explicit default port and invalid AWS calendar date", async () => {
    const f = fixture();
    const read = f.options.readFile!;
    f.options.readFile = (p, l, s) =>
      p === f.options.urlPath
        ? Promise.resolve(f.url.toString().replace(host, `${host}:443`))
        : read(p, l, s);
    await reject(f);
    const date = fixture();
    date.receipt.signed_at = "20260230T171550Z";
    date.url.searchParams.set("X-Amz-Date", date.receipt.signed_at);
    date.url.searchParams.set(
      "X-Amz-Credential",
      "syntheticaccesskey/20260230/auto/s3/aws4_request",
    );
    await reject(date);
  });
  it("rejects malformed/absent receipt and read failures without leaking causes", async () => {
    for (const data of ["{}", "null", "{bad", "[]"]) {
      const f = fixture();
      f.options.readFile = async () => data;
      await reject(f);
    }
    const f = fixture();
    f.options.readFile = async () => {
      throw new Error(f.url.toString());
    };
    await reject(f);
  });
  it("rejects a changed account or local binding", async () => {
    await reject(fixture(), { ...binding, accountId: "17841400000000000" });
    await reject(fixture(), { ...binding, sha256: "b".repeat(64) });
  });
  it("rejects expired, future-signed and insufficient due/cutoff/grace lifetime", async () => {
    const expiry = Date.parse("2026-10-09T17:15:50.000Z");
    const expired = fixture();
    expired.options.now = () => expiry;
    await reject(expired);
    const future = fixture();
    future.options.now = () => Date.parse("2026-10-02T17:00:00.000Z");
    future.receipt.verified_at = "2026-10-02T16:00:00.000Z";
    await reject(future);
    const due = fixture();
    await reject(due, { ...binding, dueUtc: "2026-10-09T16:14:00.000Z" });
    const clock = fixture();
    clock.options.now = () => expiry - 3600000;
    await reject(clock);
  });
  it("rechecks actual time after streaming", async () => {
    const f = fixture();
    let at = current;
    f.options.now = () => at;
    f.options.fetch = async () => {
      if (f.calls.length === 1) at = Date.parse("2026-10-09T17:15:50.000Z");
      f.calls.push({});
      return f.response(f.calls.length === 2);
    };
    await reject(f);
  });
  for (const [name, response] of [
    [
      "changed bytes",
      (f) => {
        const changed = bytes.slice();
        changed[1500] = 0;
        return f.response(false, changed);
      },
    ],
    ["oversize", (f) => f.response(false, new Uint8Array(bytes.length + 1))],
    ["short body", (f) => f.response(false, bytes.subarray(0, 100))],
    ["wrong type", (f) => f.response(false, bytes, { "content-type": "text/plain" })],
    ["wrong length", (f) => f.response(false, bytes, { "content-length": "999" })],
    ["encoded body", (f) => f.response(false, bytes, { "content-encoding": "gzip" })],
    ["redirect", () => new Response(null, { status: 302 })],
  ] satisfies Array<[string, (f: ReturnType<typeof fixture>) => Response]>) {
    it(`rejects remote ${name}`, async () => {
      const f = fixture();
      let count = 0;
      f.options.fetch = async () => (++count === 1 ? response(f) : f.response(true));
      await reject(f);
    });
  }
  for (const [name, response] of [
    ["status", (f) => f.response(false)],
    [
      "total",
      (f) => f.response(true, bytes.subarray(0, 1024), { "content-range": "bytes 0-1023/999" }),
    ],
    [
      "start",
      (f) =>
        f.response(true, bytes.subarray(0, 1024), {
          "content-range": `bytes 1-1024/${bytes.length}`,
        }),
    ],
    [
      "missing",
      (f) => {
        const r = f.response(true);
        r.headers.delete("content-range");
        return r;
      },
    ],
    ["changed bytes", (f) => f.response(true, new Uint8Array(1024))],
  ] satisfies Array<[string, (f: ReturnType<typeof fixture>) => Response]>) {
    it(`rejects range ${name}`, async () => {
      const f = fixture();
      let count = 0;
      f.options.fetch = async () => (++count === 1 ? f.response(false) : response(f));
      await reject(f);
    });
  }
  it("cancels oversize and bad-header streams without reading beyond the bound", async () => {
    for (const invalidHeader of [true, false]) {
      const f = fixture();
      let canceled = 0;
      let pulls = 0;
      const stream = new ReadableStream<Uint8Array>(
        {
          pull(c) {
            pulls++;
            c.enqueue(new Uint8Array(bytes.length + 1));
          },
          cancel() {
            canceled++;
          },
        },
        { highWaterMark: 0 },
      );
      f.options.fetch = async () =>
        new Response(stream, {
          headers: {
            "content-type": invalidHeader ? "bad" : "video/mp4",
            "content-length": String(bytes.length),
          },
        });
      await reject(f);
      expect(canceled).toBe(1);
      expect(pulls).toBe(invalidHeader ? 0 : 1);
      expect(stream.locked).toBe(false);
    }
  });
  it("cancels a malformed range body before consuming any bytes", async () => {
    const f = fixture();
    let count = 0;
    let canceled = 0;
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(c) {
          pulls++;
          c.enqueue(bytes.subarray(0, 1024));
        },
        cancel() {
          canceled++;
        },
      },
      { highWaterMark: 0 },
    );
    f.options.fetch = async () =>
      ++count === 1
        ? f.response(false)
        : new Response(stream, {
            status: 206,
            headers: { "content-type": "video/mp4", "content-length": "1024" },
          });
    await reject(f);
    expect(canceled).toBe(1);
    expect(pulls).toBe(0);
    expect(stream.locked).toBe(false);
  });
  it("deadline aborts a stalled fetch and stream, closes the reader and sanitizes errors", async () => {
    for (const stalledStream of [false, true]) {
      const f = fixture();
      f.options.timeoutMs = 10;
      let signal: AbortSignal | undefined;
      let canceled = 0;
      const stream = new ReadableStream<Uint8Array>({
        cancel() {
          canceled++;
        },
      });
      f.options.fetch = async (_u, init) => {
        signal = init!.signal!;
        return stalledStream
          ? new Response(stream, {
              headers: { "content-type": "video/mp4", "content-length": String(bytes.length) },
            })
          : new Promise<Response>(() => {});
      };
      await reject(f);
      expect(signal!.aborted).toBe(true);
      if (stalledStream) {
        expect(canceled).toBe(1);
        expect(stream.locked).toBe(false);
      }
    }
  });
  it("caller interruption settles stalled input and does not fetch", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.options.readFile = async () => {
      controller.abort();
      return new Promise<string>(() => {});
    };
    await expect(
      makeInstagramReelMedia(f.options)(binding, controller.signal),
    ).rejects.toMatchObject({ reason: "validation" });
    expect(f.calls).toHaveLength(0);
  });
});

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => NodeFSP.rm(path, { recursive: true, force: true })),
  );
});
async function privateDirectory() {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "reel-media-test-"));
  directories.push(dir);
  return dir;
}
describe("private server file reader", () => {
  it("reads bounded regular owner-only files", async () => {
    const dir = await privateDirectory();
    const path = NodePath.join(dir, "input");
    await NodeFSP.writeFile(path, "synthetic", { mode: 0o600 });
    expect(await readPrivateMediaFile(path, 10, new AbortController().signal)).toBe("synthetic");
  });
  it("rejects missing, oversized, empty, symlink, directory and public files", async () => {
    const dir = await privateDirectory();
    const file = NodePath.join(dir, "file");
    const read = (path: string, limit = 10) =>
      readPrivateMediaFile(path, limit, new AbortController().signal);
    await expect(read(NodePath.join(dir, "missing"))).rejects.toBeDefined();
    await NodeFSP.writeFile(file, "synthetic", { mode: 0o600 });
    await expect(read(file, 5)).rejects.toBeDefined();
    const link = NodePath.join(dir, "link");
    await NodeFSP.symlink(file, link);
    await expect(read(link)).rejects.toBeDefined();
    await expect(read(dir)).rejects.toBeDefined();
    await NodeFSP.chmod(file, 0o644);
    await expect(read(file)).rejects.toBeDefined();
    await NodeFSP.chmod(file, 0o600);
    await NodeFSP.writeFile(file, "");
    await expect(read(file)).rejects.toBeDefined();
    await expect(read("relative")).rejects.toBeDefined();
  });
  it("rejects writable parents and symlinked parent paths", async () => {
    const dir = await privateDirectory();
    const file = NodePath.join(dir, "file");
    await NodeFSP.writeFile(file, "synthetic", { mode: 0o600 });
    await NodeFSP.chmod(dir, 0o777);
    await expect(
      readPrivateMediaFile(file, 10, new AbortController().signal),
    ).rejects.toBeDefined();
    await NodeFSP.chmod(dir, 0o700);
    const outer = await privateDirectory();
    const link = NodePath.join(outer, "link");
    await NodeFSP.symlink(dir, link);
    await expect(
      readPrivateMediaFile(NodePath.join(link, "file"), 10, new AbortController().signal),
    ).rejects.toBeDefined();
  });
});
