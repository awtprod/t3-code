// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { CommandCenterError, type InstagramReelBinding } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";

const ACCOUNT = "678d26f30bb8cf1ca3b9e7a70c46cd41";
const BUCKET = "instagram-posts";
const ENDPOINT = `https://${ACCOUNT}.r2.cloudflarestorage.com`;
const HOST = `${BUCKET}.${ACCOUNT}.r2.cloudflarestorage.com`;
const KEY_PREFIX = "instagram/manual/april-riles/20261002/";
const MAX_LIFETIME_SECONDS = 604800;
const FETCH_GRACE_MS = 3600000;
const Receipt = Schema.Struct({
  key: Schema.String,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  bytes: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1_000_000_000)),
  duration_seconds: Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(900)),
  verified: Schema.Literal(true),
  local_hash_verified: Schema.Literal(true),
  endpoint: Schema.Literal(ENDPOINT),
  bucket: Schema.Literal(BUCKET),
  stored_metadata: Schema.Struct({
    contentLength: Schema.Int,
    contentType: Schema.Literal("video/mp4"),
  }),
  get_status: Schema.Literal(200),
  content_type: Schema.Literal("video/mp4"),
  content_length: Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/)),
  public_sha256: Schema.String,
  public_bytes: Schema.Int,
  range_status: Schema.Literal(206),
  content_range: Schema.String,
  verified_at: Schema.String,
  signed_at: Schema.String,
  expires_in_seconds: Schema.Int.check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(MAX_LIFETIME_SECONDS),
  ),
});
const decodeReceipt = Schema.decodeUnknownSync(Schema.fromJsonString(Receipt));
const failure = () =>
  new CommandCenterError({
    reason: "validation",
    message:
      "Verified Instagram media unavailable or failed identity, lifetime or streaming validation.",
  });

const stable = (a: NodeFS.Stats, b: NodeFS.Stats) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs &&
  a.mode === b.mode &&
  a.uid === b.uid;

/** Server configuration only. Never follow receipt.url_artifact or a client path. */
export async function readPrivateMediaFile(
  path: string,
  limit: number,
  signal: AbortSignal,
): Promise<string> {
  if (!NodePath.isAbsolute(path)) throw failure();
  const parentPath = NodePath.dirname(path);
  if ((await NodeFSP.realpath(parentPath)) !== parentPath) throw failure();
  const parent = await NodeFSP.lstat(parentPath);
  const owner = process.getuid?.();
  if (!parent.isDirectory() || parent.uid !== owner || (parent.mode & 0o022) !== 0) throw failure();
  const handle = await NodeFSP.open(
    path,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.uid !== owner ||
      (before.mode & 0o077) !== 0 ||
      before.size < 1 ||
      before.size > limit
    )
      throw failure();
    const bytes = Buffer.alloc(before.size + 1);
    let total = 0;
    while (total < bytes.length) {
      signal.throwIfAborted();
      const next = await handle.read(bytes, total, bytes.length - total, total);
      if (next.bytesRead === 0) break;
      total += next.bytesRead;
    }
    const [after, named, parentAfter] = await Promise.all([
      handle.stat(),
      NodeFSP.lstat(path),
      NodeFSP.lstat(NodePath.dirname(path)),
    ]);
    if (
      total !== before.size ||
      !stable(before, after) ||
      !stable(before, named) ||
      !stable(parent, parentAfter)
    )
      throw failure();
    return bytes.subarray(0, total).toString("utf8");
  } finally {
    await handle.close();
  }
}

export interface InstagramReelMediaOptions {
  readonly receiptPath?: string | undefined;
  readonly urlPath?: string | undefined;
  readonly readFile?: typeof readPrivateMediaFile;
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

function awsDate(value: string): number {
  if (!/^\d{8}T\d{6}Z$/.test(value)) throw failure();
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}.000Z`;
  const time = Date.parse(iso);
  if (!Number.isFinite(time) || DateTime.formatIso(DateTime.makeUnsafe(time)) !== iso)
    throw failure();
  return time;
}

function rangeEnd(value: string | null, size: number): number {
  const match = /^bytes 0-([0-9]+)\/([0-9]+)$/.exec(value ?? "");
  if (
    !match ||
    Number(match[2]) !== size ||
    !Number.isSafeInteger(Number(match[1])) ||
    Number(match[1]) < 0 ||
    Number(match[1]) >= size
  )
    throw failure();
  return Number(match[1]);
}

// Every await that can be driven by a remote stream settles on interruption/deadline.
function abortable<A>(promise: Promise<A>, signal: AbortSignal): Promise<A> {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => {
      cleanup();
      reject(failure());
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      () => {
        cleanup();
        reject(failure());
      },
    );
  });
}

async function inspectResponse(
  response: Response,
  size: number,
  signal: AbortSignal,
  hash?: string,
  rangeTotal?: number,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw failure();
  try {
    if (
      response.status !== (rangeTotal === undefined ? 200 : 206) ||
      (rangeTotal !== undefined &&
        rangeEnd(response.headers.get("content-range"), rangeTotal) !== size - 1) ||
      response.redirected ||
      response.headers.get("content-type") !== "video/mp4" ||
      response.headers.get("content-length") !== String(size) ||
      (response.headers.has("content-encoding") &&
        response.headers.get("content-encoding") !== "identity")
    )
      throw failure();
    const digest = NodeCrypto.createHash("sha256");
    const prefix = NodeCrypto.createHash("sha256");
    let bytes = 0;
    while (true) {
      const next = await abortable(reader.read(), signal);
      if (next.done) break;
      if (bytes < 1024) prefix.update(next.value.subarray(0, 1024 - bytes));
      bytes += next.value.byteLength;
      if (bytes > size) throw failure();
      digest.update(next.value);
    }
    if (bytes !== size || (hash !== undefined && digest.digest("hex") !== hash)) throw failure();
    return prefix.digest("hex");
  } finally {
    // Cancellation is attempted even for header failures, oversize and interrupted reads.
    await abortable(
      reader.cancel().catch(() => undefined),
      signal,
    ).catch(() => undefined);
    reader.releaseLock();
  }
}

/** One configured provider artifact; the signed GET is returned only to the in-memory Graph call. */
export function makeInstagramReelMedia(options: InstagramReelMediaOptions) {
  const read = options.readFile ?? readPrivateMediaFile;
  const fetchMedia = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  return async (binding: InstagramReelBinding, signal: AbortSignal): Promise<string> => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(abort, options.timeoutMs ?? 20000);
    try {
      if (!options.receiptPath || !options.urlPath) throw failure();
      const receipt = decodeReceipt(
        await abortable(read(options.receiptPath, 16384, controller.signal), controller.signal),
      );
      const raw = (
        await abortable(read(options.urlPath, 8192, controller.signal), controller.signal)
      ).trim();
      const key = `${KEY_PREFIX}${binding.sha256}.mp4`;
      if (
        binding.accountId !== "17841463886554034" ||
        receipt.key !== key ||
        receipt.sha256 !== binding.sha256 ||
        receipt.bytes !== binding.sizeBytes ||
        receipt.duration_seconds !== binding.durationMs / 1000 ||
        receipt.public_sha256 !== binding.sha256 ||
        receipt.public_bytes !== binding.sizeBytes ||
        receipt.stored_metadata.contentLength !== binding.sizeBytes ||
        receipt.content_length !== String(binding.sizeBytes)
      )
        throw failure();
      rangeEnd(receipt.content_range, binding.sizeBytes);
      const verifiedAt = Date.parse(receipt.verified_at);
      if (!Number.isFinite(verifiedAt) || verifiedAt > now()) throw failure();
      const url = new URL(raw);
      if (
        raw.split("?")[0] !== `https://${HOST}/${key}` ||
        /[\s#]/.test(raw) ||
        url.protocol !== "https:" ||
        url.hostname !== HOST ||
        url.port ||
        url.username ||
        url.password ||
        url.hash ||
        url.pathname !== `/${key}`
      )
        throw failure();
      const names = [
        "X-Amz-Algorithm",
        "X-Amz-Content-Sha256",
        "X-Amz-Credential",
        "X-Amz-Date",
        "X-Amz-Expires",
        "X-Amz-Signature",
        "X-Amz-SignedHeaders",
        "response-content-disposition",
        "response-content-type",
        "x-id",
      ];
      if (
        Array.from(url.searchParams).length !== names.length ||
        names.some((name) => url.searchParams.getAll(name).length !== 1)
      )
        throw failure();
      const get = (name: string) => url.searchParams.get(name)!;
      const signed = get("X-Amz-Date");
      if (
        signed !== receipt.signed_at ||
        get("X-Amz-Algorithm") !== "AWS4-HMAC-SHA256" ||
        get("X-Amz-Content-Sha256") !== "UNSIGNED-PAYLOAD" ||
        get("X-Amz-SignedHeaders") !== "host" ||
        get("response-content-type") !== "video/mp4" ||
        get("x-id") !== "GetObject" ||
        !/^[a-f0-9]{64}$/.test(get("X-Amz-Signature")) ||
        !new RegExp(`^[A-Za-z0-9]{16,128}/${signed.slice(0, 8)}/auto/s3/aws4_request$`).test(
          get("X-Amz-Credential"),
        ) ||
        !/^[1-9][0-9]*$/.test(get("X-Amz-Expires")) ||
        Number(get("X-Amz-Expires")) !== receipt.expires_in_seconds ||
        !get("response-content-disposition") ||
        /[\r\n]/.test(get("response-content-disposition"))
      )
        throw failure();
      const signedAt = awsDate(signed);
      const expiresAt = signedAt + receipt.expires_in_seconds * 1000;
      const due = Date.parse(binding.dueUtc);
      const checkLifetime = () => {
        if (
          !Number.isFinite(due) ||
          !Number.isFinite(now()) ||
          signedAt > now() ||
          expiresAt <= now() + FETCH_GRACE_MS ||
          expiresAt <= due + binding.lateWindowMs + FETCH_GRACE_MS
        )
          throw failure();
      };
      checkLifetime();
      const full = await abortable(
        fetchMedia(raw, { method: "GET", redirect: "error", signal: controller.signal }),
        controller.signal,
      );
      const prefixHash = await inspectResponse(
        full,
        binding.sizeBytes,
        controller.signal,
        binding.sha256,
      );
      const end = Math.min(binding.sizeBytes - 1, 1023);
      const range = await abortable(
        fetchMedia(raw, {
          method: "GET",
          headers: { Range: `bytes=0-${end}` },
          redirect: "error",
          signal: controller.signal,
        }),
        controller.signal,
      );
      await inspectResponse(range, end + 1, controller.signal, prefixHash, binding.sizeBytes);
      checkLifetime();
      return raw;
    } catch {
      // No input, fetch error, URL, signature, parse error or cause crosses the adapter.
      throw failure();
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      controller.abort();
    }
  };
}
