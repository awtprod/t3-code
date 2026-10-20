// @effect-diagnostics nodeBuiltinImport:off - inspects the state file in a temporary directory.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { SpaceId } from "@command-center/core";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  type ConferenceCallRecord,
  ConferenceCallStateStore,
  layerAt,
  twilioCallbackUrl,
} from "./ConferenceCallState.ts";

const directories: Array<string> = [];
const tempDir = () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cc-conference-state-"));
  directories.push(directory);
  return NodePath.join(directory, "phone");
};
afterEach(() => {
  for (const directory of directories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

const record: ConferenceCallRecord = {
  version: 1,
  callId: "0f8fad5b-d9cb-469f-a165-70867728950e",
  spaceId: "acme",
  attemptId: "revision:phone-call-candidate:abc",
  plan: {
    spaceId: SpaceId.make("acme"),
    to: "+15555550101",
    calleeName: "Acme Dental",
    purpose: "Move Tuesday's cleaning",
    brief: "Thursday morning instead.",
    allowedOutcomes: ["Thursday before noon"],
  },
  phase: "dialing-agent",
  agent: { status: "dialing", answered: false, updatedAt: "2026-10-17T18:00:00.000Z" },
  bridgeCount: 0,
  createdAt: "2026-10-17T18:00:00.000Z",
  updatedAt: "2026-10-17T18:00:00.000Z",
};

const withStore = <A, E>(
  directory: string,
  use: (store: ConferenceCallStateStore["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.flatMap(ConferenceCallStateStore, use).pipe(
    Effect.provide(layerAt(directory).pipe(Layer.provide(NodeServices.layer))),
  );

describe("ConferenceCallStateStore", () => {
  it.effect("round-trips the record through a private file and leaves no temporary files", () => {
    const directory = tempDir();
    return withStore(directory, (store) =>
      Effect.gen(function* () {
        expect(yield* store.load).toEqual(Option.none());
        yield* store.save(record);
        yield* store.save({ ...record, phase: "in-progress" });
        expect(yield* store.load).toEqual(Option.some({ ...record, phase: "in-progress" }));
        const file = NodePath.join(directory, "active-call.json");
        expect(NodeFS.statSync(file).mode & 0o777).toBe(0o600);
        expect(NodeFS.statSync(directory).mode & 0o777).toBe(0o700);
        expect(NodeFS.readdirSync(directory)).toEqual(["active-call.json"]);
      }),
    );
  });

  it.effect("fails closed on a malformed or oversized file instead of forgetting the call", () => {
    const directory = tempDir();
    return withStore(directory, (store) =>
      Effect.gen(function* () {
        yield* store.save(record);
        const file = NodePath.join(directory, "active-call.json");
        for (const content of [
          "{not json",
          JSON.stringify({ ...record, phase: "unknown" }),
          JSON.stringify({ ...record, extra: true }),
          " ".repeat(65 * 1024),
        ]) {
          NodeFS.writeFileSync(file, content);
          const error = yield* Effect.flip(store.load);
          expect(error.reason).toBe("persistence");
          expect(error.message).toMatch(/unreadable/u);
        }
      }),
    );
  });
});

describe("twilioCallbackUrl", () => {
  it("builds the only URLs Twilio signatures are checked against", () => {
    const base = "https://cc.example.com/api/command-center/phone/webhook";
    expect(
      twilioCallbackUrl({ publicBaseUrl: base, route: "status", callId: "id", leg: "callee" }),
    ).toBe(`${base}/twilio/status?call=id&leg=callee`);
    expect(twilioCallbackUrl({ publicBaseUrl: base, route: "hold", callId: "id" })).toBe(
      `${base}/twilio/hold?call=id`,
    );
  });
});
