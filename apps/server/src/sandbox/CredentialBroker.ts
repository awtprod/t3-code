import * as NodeCrypto from "node:crypto";

type CredentialRecord = {
  readonly threadId: string;
  readonly scope: string;
  readonly value: string;
  readonly tokenHash: Buffer;
  readonly expiresAt: number;
  redeemed: boolean;
};

export class ThreadCredentialBroker {
  readonly #records = new Map<string, CredentialRecord>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  issue(input: { threadId: string; scope: string; value: string; ttlMs: number }) {
    if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs < 1 || input.ttlMs > 15 * 60_000)
      throw new Error("credential ttl must be between 1ms and 15 minutes");
    if (input.value.length === 0) throw new Error("credential value is required");
    const token = NodeCrypto.randomBytes(32).toString("base64url");
    const id = NodeCrypto.randomBytes(16).toString("hex");
    this.#records.set(id, {
      threadId: input.threadId,
      scope: input.scope,
      value: input.value,
      tokenHash: digest(token),
      expiresAt: this.#now() + input.ttlMs,
      redeemed: false,
    });
    return { id, token, expiresAt: this.#records.get(id)!.expiresAt };
  }

  redeem(input: { id: string; token: string; threadId: string; scope: string }): string | null {
    const record = this.#records.get(input.id);
    if (record === undefined) return null;
    if (record.expiresAt <= this.#now() || record.redeemed) {
      this.#records.delete(input.id);
      return null;
    }
    const candidate = digest(input.token);
    const authorized =
      record.threadId === input.threadId &&
      record.scope === input.scope &&
      NodeCrypto.timingSafeEqual(record.tokenHash, candidate);
    if (!authorized) return null;
    record.redeemed = true;
    this.#records.delete(input.id);
    return record.value;
  }

  revoke(id: string, threadId: string) {
    const record = this.#records.get(id);
    if (record === undefined || record.threadId !== threadId) return false;
    this.#records.delete(id);
    return true;
  }

  revokeThread(threadId: string) {
    let revoked = 0;
    for (const [id, record] of this.#records) {
      if (record.threadId !== threadId) continue;
      this.#records.delete(id);
      revoked += 1;
    }
    return revoked;
  }

  purgeExpired() {
    const now = this.#now();
    for (const [id, record] of this.#records) if (record.expiresAt <= now) this.#records.delete(id);
  }
}

const digest = (value: string) => NodeCrypto.createHash("sha256").update(value).digest();
