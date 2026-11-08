import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { COMMAND_CENTER_WS_METHODS } from "./commandCenter.ts";
import { sessionGrantsScope } from "./auth.ts";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  CommandCenterKnowledgeCaptureInput,
  CommandCenterKnowledgeSearchInput,
} from "./commandCenterKnowledge.ts";

const doc = {
  sourceKind: "note",
  bindingId: "manual",
  accountId: "fixture",
  externalId: "one",
  title: "Fixture",
  url: "https://example.org/source",
  sourceUpdatedAt: "2026-11-08T00:00:00.000Z",
  text: "evidence",
};
const capture = { spaceId: "fixture", repositoryId: null, mutationId: "one", documents: [doc] };
describe("knowledge boundaries", () => {
  it("rejects malformed source shapes, dates, URLs and byte/count limits", () => {
    const valid = Schema.is(CommandCenterKnowledgeCaptureInput);
    const userInfoUrl = new URL(doc.url);
    userInfoUrl.username = "fixture";
    userInfoUrl.password = "fixture";
    expect(valid(capture)).toBe(true);
    for (const patch of [
      { text: " " },
      { text: "a".repeat(65537) },
      { text: "界".repeat(22000) },
      { sourceUpdatedAt: "2026-02-30T00:00:00.000Z" },
      { sourceUpdatedAt: "yesterday" },
      { url: "file:///private" },
      { url: userInfoUrl.toString() },
      { url: "invalid" },
      { title: "" },
      { externalId: "" },
      { bindingId: null },
    ])
      expect(
        valid({ ...capture, documents: [{ ...doc, ...patch }] }),
        JSON.stringify(Object.keys(patch)),
      ).toBe(false);
    expect(valid({ ...capture, documents: [] })).toBe(false);
    expect(valid({ ...capture, documents: Array.from({ length: 9 }, () => doc) })).toBe(false);
    expect(
      valid({
        ...capture,
        documents: Array.from({ length: 8 }, () => ({ ...doc, text: "a".repeat(40000) })),
      }),
    ).toBe(false);
  });
  it("keeps client knowledge writes unavailable to read-only and revoked owner grants", () => {
    const reader = { authenticated: true, permissions: ["command-center:read"] } as const;
    for (const method of [
      COMMAND_CENTER_WS_METHODS.knowledgeCapture,
      COMMAND_CENTER_WS_METHODS.knowledgeRetire,
    ]) {
      const required = clientRpcRequiredScopes(method, { scope: "command-center:read" });
      expect(required.length).toBeGreaterThan(0);
      expect(required.every((scope) => sessionGrantsScope(reader, scope))).toBe(false);
      expect(
        required.every((scope) =>
          sessionGrantsScope(
            { authenticated: true, permissions: ["command-center:operate"] },
            scope,
          ),
        ),
      ).toBe(true);
      expect(
        required.every((scope) =>
          sessionGrantsScope({ authenticated: true, permissions: [] }, scope),
        ),
      ).toBe(false);
    }
    for (const method of [
      COMMAND_CENTER_WS_METHODS.knowledgeSearch,
      COMMAND_CENTER_WS_METHODS.knowledgeGet,
    ]) {
      const required = clientRpcRequiredScopes(method, {});
      expect(required.length).toBeGreaterThan(0);
      expect(required.every((scope) => sessionGrantsScope(reader, scope))).toBe(true);
      expect(
        required.every((scope) =>
          sessionGrantsScope({ authenticated: false, permissions: ["command-center:read"] }, scope),
        ),
      ).toBe(false);
    }
  });
  it("bounds query syntax, terms and results without interpreting FTS operators", () => {
    const valid = Schema.is(CommandCenterKnowledgeSearchInput);
    const request = {
      spaceId: "fixture",
      repositoryId: null,
      query: "saffron OR turmeric",
      limit: 20,
    };
    expect(valid(request)).toBe(true);
    for (const query of [
      "e\u0301clair",
      Array.from({ length: 16 }, () => "e\u0301clair").join(" "),
    ])
      expect(valid({ ...request, query })).toBe(true);
    for (const query of [
      "",
      "   ",
      '"*()"',
      Array.from({ length: 17 }, () => "word").join(" "),
      Array.from({ length: 17 }, () => "e\u0301clair").join(" "),
      "\u0301",
      "a".repeat(513),
    ])
      expect(valid({ ...request, query })).toBe(false);
    for (const limit of [0, 21, 1.5, "20"]) expect(valid({ ...request, limit })).toBe(false);
  });
});
