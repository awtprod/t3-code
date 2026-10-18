// @effect-diagnostics nodeBuiltinImport:off - exercises the offline CLI against a temporary directory.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import { decodePhoneConnection, maskPhoneNumber } from "./PhoneConnection.ts";
import {
  argumentsFrom,
  phoneConnectionStatus,
  phoneSecretPath,
  setPhoneConnection,
} from "./provisionPhoneConnection.ts";

const connection = {
  apiKey: "xi_test_api_key_0123456789", // gitleaks:allow (test fixture)
  webhookSecret: "wsec_test_0123456789abcdef", // gitleaks:allow (test fixture)
  agentId: "agent_third_party",
  ownerAgentId: "agent_owner",
  phoneNumberId: "phnum_acme",
  ownerNumber: "+15550100000",
  ownerName: "Andrew",
};
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe("decodePhoneConnection", () => {
  it("accepts exactly the documented shape", () => {
    expect(decodePhoneConnection(bytes(connection))).toEqual(Option.some(connection));
  });

  it("rejects missing, extra, and malformed fields without throwing", () => {
    const { ownerName: _ownerName, ...missing } = connection;
    for (const value of [
      missing,
      { ...connection, extra: true },
      { ...connection, ownerNumber: "5550100000" },
      { ...connection, ownerNumber: "+0550100000" },
      { ...connection, apiKey: "short" },
      { ...connection, webhookSecret: "has spaces in it, 0123456789" },
      { ...connection, agentId: "../agent" },
      { ...connection, ownerName: " Andrew" },
      [],
      null,
    ]) {
      expect(decodePhoneConnection(bytes(value))).toEqual(Option.none());
    }
    expect(decodePhoneConnection(new TextEncoder().encode("{not json"))).toEqual(Option.none());
    expect(decodePhoneConnection(new Uint8Array(0))).toEqual(Option.none());
    expect(decodePhoneConnection(new Uint8Array(17 * 1024).fill(0x20))).toEqual(Option.none());
  });

  it("masks numbers to their last four digits", () => {
    expect(maskPhoneNumber("+15550100000")).toBe("…0000");
  });
});

describe("credentials:phone CLI", () => {
  const directories: Array<string> = [];
  const tempBase = () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cc-phone-"));
    directories.push(directory);
    return directory;
  };
  afterEach(() => {
    for (const directory of directories.splice(0)) {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("parses set and status and rejects anything else", () => {
    expect(argumentsFrom(["--", "status", "--base-dir", "/srv/runtime"])).toEqual({
      command: "status",
      baseDir: "/srv/runtime",
    });
    expect(
      argumentsFrom(["set", "--from-json", "/tmp/phone.json", "--base-dir", "/srv/runtime"]),
    ).toEqual({ command: "set", baseDir: "/srv/runtime", source: "/tmp/phone.json" });
    expect(argumentsFrom(["set", "--from-json", "-", "--base-dir", "/srv/runtime"]).command).toBe(
      "set",
    );
    for (const argv of [
      [],
      ["status"],
      ["status", "--base-dir", "relative"],
      ["set", "--base-dir", "/srv/runtime"],
      ["set", "--from-json", "relative.json", "--base-dir", "/srv/runtime"],
      ["status", "--from-json", "/tmp/phone.json", "--base-dir", "/srv/runtime"],
      ["remove", "--base-dir", "/srv/runtime"],
    ]) {
      expect(() => argumentsFrom(argv)).toThrow(/Usage/u);
    }
  });

  it("stores a valid connection 0600 and reports it without secrets or full numbers", () => {
    const base = tempBase();
    expect(phoneConnectionStatus(base)[0]).toMatch(/not configured/u);
    const first = setPhoneConnection({ baseDir: base, plaintext: bytes(connection) });
    expect(first).toEqual({ destination: phoneSecretPath(base), replaced: false });
    expect(NodeFS.statSync(first.destination).mode & 0o777).toBe(0o600);
    expect(NodeFS.statSync(NodePath.dirname(first.destination)).mode & 0o777).toBe(0o700);
    const status = phoneConnectionStatus(base).join("\n");
    expect(status).toContain("configured");
    expect(status).toContain("Andrew (…0000)");
    for (const secret of [connection.apiKey, connection.webhookSecret, connection.ownerNumber]) {
      expect(status).not.toContain(secret);
    }
    expect(setPhoneConnection({ baseDir: base, plaintext: bytes(connection) }).replaced).toBe(true);
    expect(NodeFS.readdirSync(NodePath.dirname(first.destination))).toEqual([
      "command-center-phone-connection.bin",
    ]);
  });

  it("refuses invalid JSON and leaves the stored entry untouched", () => {
    const base = tempBase();
    setPhoneConnection({ baseDir: base, plaintext: bytes(connection) });
    const before = NodeFS.readFileSync(phoneSecretPath(base));
    expect(() =>
      setPhoneConnection({ baseDir: base, plaintext: bytes({ ...connection, ownerNumber: "x" }) }),
    ).toThrow(/does not match/u);
    expect(NodeFS.readFileSync(phoneSecretPath(base))).toEqual(before);
    NodeFS.writeFileSync(phoneSecretPath(base), "{}");
    expect(phoneConnectionStatus(base)[0]).toMatch(/INVALID/u);
  });
});
