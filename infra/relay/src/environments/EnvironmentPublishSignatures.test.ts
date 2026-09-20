import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type {
  RelayAgentActivityPublishProofPayload,
  RelayAgentActivityPublishRequest,
  RelayAgentActivityState,
  RelayProspectNotification,
  RelayProspectNotificationPublishProofPayload,
  RelayProspectNotificationPublishRequest,
} from "@t3tools/contracts/relay";
import {
  RELAY_ACTIVITY_PUBLISH_TYP,
  RELAY_PROSPECT_NOTIFICATION_PUBLISH_TYP,
} from "@t3tools/shared/relayJwt";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as DpopProofs from "../auth/DpopProofs.ts";
import * as RelayConfiguration from "../Config.ts";
import * as EnvironmentPublishSignatures from "./EnvironmentPublishSignatures.ts";

const keyPair = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});
const config = RelayConfiguration.RelayConfiguration.of({
  relayIssuer: "https://relay.example.test",
  apns: {
    environment: "sandbox",
    teamId: "team-id",
    keyId: "key-id",
    privateKey: Redacted.make("private-key"),
    bundleId: "com.t3tools.t3code.dev",
  },
  webPush: {
    privateKey: Redacted.make("web-push-private-key"),
    publicKey: "web-push-public-key",
    subject: "https://relay.example.test",
  },
  apnsDeliveryJobSigningSecret: Redacted.make("job-secret"),
  clerkSecretKey: Redacted.make("clerk-secret"),
  clerkPublishableKey: "pk_test_test",
  clerkJwtAudience: "t3-code-relay",
  cloudMintPrivateKey: Redacted.make(keyPair.privateKey),
  cloudMintPublicKey: keyPair.publicKey,
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
});
const state: RelayAgentActivityState = {
  environmentId: "env" as RelayAgentActivityState["environmentId"],
  threadId: "thread" as RelayAgentActivityState["threadId"],
  projectTitle: "Project",
  threadTitle: "Thread",
  modelTitle: "gpt-5.4",
  phase: "running",
  headline: "Running",
  updatedAt: "2026-05-25T00:00:00.000Z",
  deepLink: "/threads/env/thread",
};
const isEnvironmentPublishSignatureInvalid = Schema.is(
  EnvironmentPublishSignatures.EnvironmentPublishSignatureInvalid,
);

function signTestJwt(
  payload: object,
  privateKey: string,
  typ = RELAY_ACTIVITY_PUBLISH_TYP,
): string {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ })).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${header}.${encodedPayload}`;
  return `${signingInput}.${NodeCrypto.sign(null, Buffer.from(signingInput), privateKey).toString("base64url")}`;
}

const freshRequest = Effect.gen(function* () {
  const now = yield* DateTime.now;
  const payload = {
    iss: "t3-env:env",
    aud: "https://relay.example.test",
    sub: "env",
    jti: "publish-jti",
    iat: Math.floor(now.epochMilliseconds / 1_000),
    exp: Math.floor(DateTime.add(now, { minutes: 5 }).epochMilliseconds / 1_000),
    environmentId: state.environmentId,
    threadId: state.threadId,
    state,
  } satisfies RelayAgentActivityPublishProofPayload;
  return {
    state,
    proof: signTestJwt(payload, keyPair.privateKey),
  } satisfies RelayAgentActivityPublishRequest;
});

const prospectNotification = {
  type: "prospect",
  itemId: "prospect-review:lead/123",
  spaceId: "space-1",
  evaluationId: "evaluation-1",
  environmentId: state.environmentId,
  title: "New prospect",
  body: "Acme is ready for review.",
  deepLink: `/prospects/${encodeURIComponent("prospect-review:lead/123")}`,
} satisfies RelayProspectNotification;

const freshProspectRequest = (input?: {
  readonly payload?: Partial<RelayProspectNotificationPublishProofPayload>;
  readonly notification?: RelayProspectNotification;
  readonly privateKey?: string;
  readonly typ?: string;
}) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const notification = input?.notification ?? prospectNotification;
    const payload = {
      iss: "t3-env:env",
      aud: "https://relay.example.test",
      sub: "env",
      jti: "prospect-jti",
      iat: Math.floor(now.epochMilliseconds / 1_000),
      exp: Math.floor(DateTime.add(now, { minutes: 5 }).epochMilliseconds / 1_000),
      environmentId: state.environmentId,
      itemId: notification.itemId,
      notification,
      ...input?.payload,
    } satisfies RelayProspectNotificationPublishProofPayload;
    return {
      notification,
      proof: signTestJwt(
        payload,
        input?.privateKey ?? keyPair.privateKey,
        input?.typ ?? RELAY_PROSPECT_NOTIFICATION_PUBLISH_TYP,
      ),
    } satisfies RelayProspectNotificationPublishRequest;
  });

function layer(replay?: Partial<DpopProofs.DpopProofReplay["Service"]>) {
  return EnvironmentPublishSignatures.layer.pipe(
    Layer.provide(
      Layer.merge(
        RelayConfiguration.layer(config),
        Layer.succeed(DpopProofs.DpopProofReplay, {
          verifyAndConsume:
            replay?.verifyAndConsume ?? (() => Effect.die("unexpected DPoP proof verification")),
          consume: replay?.consume ?? (() => Effect.succeed(true)),
          pruneExpired: replay?.pruneExpired ?? Effect.void,
        }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
}

describe("EnvironmentPublishSignatures", () => {
  it.effect("verifies activity JWTs and scopes replay storage to the environment key", () => {
    let replayThumbprint: string | null = null;
    return Effect.gen(function* () {
      const request = yield* freshRequest;
      const signatures = yield* EnvironmentPublishSignatures.EnvironmentPublishSignatures;
      yield* signatures.verify({
        environmentId: state.environmentId,
        environmentPublicKey: keyPair.publicKey,
        threadId: state.threadId,
        request,
      });
      expect(replayThumbprint).toBe(
        `env-publish:${NodeCrypto.createHash("sha256")
          .update(
            stableStringify({
              environmentId: state.environmentId,
              environmentPublicKey: keyPair.publicKey,
            }),
          )
          .digest("base64url")}`,
      );
    }).pipe(
      Effect.provide(
        layer({
          consume: (input) =>
            Effect.sync(() => {
              replayThumbprint = input.thumbprint;
              return true;
            }),
        }),
      ),
    );
  });

  it.effect("rejects top-level state tampering", () =>
    Effect.gen(function* () {
      const request = yield* freshRequest;
      const signatures = yield* EnvironmentPublishSignatures.EnvironmentPublishSignatures;
      const result = yield* Effect.result(
        signatures.verify({
          environmentId: state.environmentId,
          environmentPublicKey: keyPair.publicKey,
          threadId: state.threadId,
          request: { ...request, state: { ...state, headline: "Tampered" } },
        }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(isEnvironmentPublishSignatureInvalid(result.failure)).toBe(true);
        if (isEnvironmentPublishSignatureInvalid(result.failure)) {
          expect(result.failure).toMatchObject({
            environmentId: state.environmentId,
            threadId: state.threadId,
            reason: "invalid_signature_or_payload",
            stage: "validate_claims",
          });
        }
      }
    }).pipe(Effect.provide(layer())),
  );

  it.effect("preserves the JWT verification failure", () =>
    Effect.gen(function* () {
      const request = yield* freshRequest;
      const segments = request.proof.split(".");
      const signature = segments[2]!;
      segments[2] = `${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;
      const signatures = yield* EnvironmentPublishSignatures.EnvironmentPublishSignatures;
      const result = yield* Effect.result(
        signatures.verify({
          environmentId: state.environmentId,
          environmentPublicKey: keyPair.publicKey,
          threadId: state.threadId,
          request: { ...request, proof: segments.join(".") },
        }),
      );

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(isEnvironmentPublishSignatureInvalid(result.failure)).toBe(true);
        if (isEnvironmentPublishSignatureInvalid(result.failure)) {
          expect(result.failure).toMatchObject({
            environmentId: state.environmentId,
            threadId: state.threadId,
            reason: "invalid_signature_or_payload",
            stage: "verify_proof",
            cause: { _tag: "RelayJwtError" },
          });
        }
      }
    }).pipe(Effect.provide(layer())),
  );

  it.effect("rejects replayed activity JWT ids", () =>
    Effect.gen(function* () {
      const request = yield* freshRequest;
      const signatures = yield* EnvironmentPublishSignatures.EnvironmentPublishSignatures;
      const result = yield* Effect.result(
        signatures.verify({
          environmentId: state.environmentId,
          environmentPublicKey: keyPair.publicKey,
          threadId: state.threadId,
          request,
        }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(isEnvironmentPublishSignatureInvalid(result.failure)).toBe(true);
        if (isEnvironmentPublishSignatureInvalid(result.failure)) {
          expect(result.failure).toMatchObject({
            environmentId: state.environmentId,
            threadId: state.threadId,
            reason: "replayed_nonce",
            stage: "consume_nonce",
          });
        }
      }
    }).pipe(Effect.provide(layer({ consume: () => Effect.succeed(false) }))),
  );

  it.effect("verifies prospect proofs and binds every signed notification field", () =>
    Effect.gen(function* () {
      const request = yield* freshProspectRequest();
      const signatures = yield* EnvironmentPublishSignatures.EnvironmentPublishSignatures;
      yield* signatures.verifyProspectNotification({
        environmentId: state.environmentId,
        environmentPublicKey: keyPair.publicKey,
        request,
      });
      const tampered = yield* Effect.result(
        signatures.verifyProspectNotification({
          environmentId: state.environmentId,
          environmentPublicKey: keyPair.publicKey,
          request: {
            ...request,
            notification: { ...request.notification, body: "Tampered" },
          },
        }),
      );
      expect(Result.isFailure(tampered)).toBe(true);
      if (Result.isFailure(tampered)) {
        expect(tampered.failure).toMatchObject({
          _tag: "EnvironmentProspectPublishSignatureInvalid",
          stage: "validate_claims",
        });
      }
    }).pipe(Effect.provide(layer())),
  );

  it.effect("rejects stale prospect proofs", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const request = yield* freshProspectRequest({
        payload: {
          iat: Math.floor(DateTime.subtract(now, { minutes: 10 }).epochMilliseconds / 1_000),
          exp: Math.floor(DateTime.subtract(now, { minutes: 5 }).epochMilliseconds / 1_000),
        },
      });
      const signatures = yield* EnvironmentPublishSignatures.EnvironmentPublishSignatures;
      const result = yield* Effect.result(
        signatures.verifyProspectNotification({
          environmentId: state.environmentId,
          environmentPublicKey: keyPair.publicKey,
          request,
        }),
      );
      expect(Result.isFailure(result) && result.failure._tag).toBe(
        "EnvironmentProspectPublishSignatureExpired",
      );
    }).pipe(Effect.provide(layer())),
  );

  it.effect("rejects future and overlong prospect proofs", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const nowSeconds = Math.floor(now.epochMilliseconds / 1_000);
      const signatures = yield* EnvironmentPublishSignatures.EnvironmentPublishSignatures;
      for (const payload of [
        { iat: nowSeconds + 1, exp: nowSeconds + 120 },
        { iat: nowSeconds, exp: nowSeconds + 301 },
      ]) {
        const request = yield* freshProspectRequest({ payload });
        const result = yield* Effect.result(
          signatures.verifyProspectNotification({
            environmentId: state.environmentId,
            environmentPublicKey: keyPair.publicKey,
            request,
          }),
        );
        expect(Result.isFailure(result)).toBe(true);
      }
    }).pipe(Effect.provide(layer())),
  );

  it.effect("rejects wrong typ and invalid public keys", () =>
    Effect.gen(function* () {
      const signatures = yield* EnvironmentPublishSignatures.EnvironmentPublishSignatures;
      const wrongTyp = yield* freshProspectRequest({ typ: RELAY_ACTIVITY_PUBLISH_TYP });
      const invalidTypResult = yield* Effect.result(
        signatures.verifyProspectNotification({
          environmentId: state.environmentId,
          environmentPublicKey: keyPair.publicKey,
          request: wrongTyp,
        }),
      );
      expect(Result.isFailure(invalidTypResult)).toBe(true);

      const request = yield* freshProspectRequest();
      const invalidKeyResult = yield* Effect.result(
        signatures.verifyProspectNotification({
          environmentId: state.environmentId,
          environmentPublicKey: "not-a-public-key",
          request,
        }),
      );
      expect(Result.isFailure(invalidKeyResult)).toBe(true);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("rejects replayed prospect nonces", () =>
    Effect.gen(function* () {
      const request = yield* freshProspectRequest();
      const signatures = yield* EnvironmentPublishSignatures.EnvironmentPublishSignatures;
      const result = yield* Effect.result(
        signatures.verifyProspectNotification({
          environmentId: state.environmentId,
          environmentPublicKey: keyPair.publicKey,
          request,
        }),
      );
      expect(Result.isFailure(result) && result.failure).toMatchObject({
        _tag: "EnvironmentProspectPublishSignatureInvalid",
        reason: "replayed_nonce",
        stage: "consume_nonce",
      });
    }).pipe(Effect.provide(layer({ consume: () => Effect.succeed(false) }))),
  );
});
