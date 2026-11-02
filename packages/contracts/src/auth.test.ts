import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  AuthEnvironmentScopes,
  AuthEnvironmentScope,
  authScopeRequiredResponse,
  AuthGrantScopes,
  AuthStandardClientScopes,
  authScopeResponse,
  AuthSessionState,
  sessionGrantsScope,
  sessionHasLegacyPermissions,
} from "./auth.ts";
import { ForwardCompatibleArray } from "./baseSchemas.ts";

describe("authorization grants", () => {
  it("decodes legacy review credentials without offering them in new grants", () => {
    expect(Schema.decodeUnknownSync(AuthEnvironmentScopes)(["review:write"])).toEqual([
      "review:write",
    ]);
    expect(() => Schema.decodeUnknownSync(AuthGrantScopes)(["review:write"])).toThrow();
    expect(AuthStandardClientScopes).not.toContain("review:write");
  });

  // Frozen vocabulary from the client before granular scopes shipped. Do not
  // derive it from the current enum: that would hide compatibility regressions.
  const oldScopes = Schema.Array(
    Schema.Literals([
      "orchestration:read",
      "orchestration:operate",
      "terminal:operate",
      "review:write",
      "access:read",
      "access:write",
      "relay:read",
      "relay:write",
      // Command Center clients before granular permissions (origin/main b02115a6f4).
      "command-center:read",
      "command-center:operate",
      "command-center:approve",
    ]),
  );

  const decodeOldScopes = Schema.decodeUnknownSync(oldScopes);

  it.each(AuthEnvironmentScope.literals)(
    "keeps %s permission errors decodable by old clients",
    (scope) => {
      const response = authScopeRequiredResponse(scope);
      expect(decodeOldScopes([response.requiredScope])).toEqual([response.requiredScope]);
      expect(response.requiredPermission).toBe(scope);
    },
  );

  it("keeps old clients able to decode grants with new permissions", () => {
    const response = authScopeResponse(AuthStandardClientScopes);
    expect(decodeOldScopes(response.scopes)).toEqual(response.scopes);
    expect(response.permissions).toEqual(AuthStandardClientScopes);
    expect(response.scopes).not.toContain("filesystem:read");
  });

  // Frozen stock T3 Code 2.2.0 vocabulary, independent of the CC enum/formatter.
  const stockScope = Schema.Literals([
    "orchestration:read",
    "orchestration:operate",
    "settings:write",
    "providers:manage",
    "environment:maintain",
    "preview:operate",
    "diagnostics:read",
    "terminal:read",
    "terminal:operate",
    "filesystem:read",
    "filesystem:write",
    "review:write",
    "source-control:write",
    "access:read",
    "access:write",
    "relay:read",
    "relay:write",
  ]);
  const stockScopes = Schema.Array(stockScope);
  const stockSession = Schema.Struct({
    ...AuthSessionState.fields,
    scopes: Schema.optionalKey(stockScopes),
    permissions: Schema.optionalKey(ForwardCompatibleArray(stockScope)),
  });
  const decodeStockScopes = Schema.decodeUnknownSync(stockScopes);
  const decodeStockSession = Schema.decodeUnknownSync(stockSession);
  const decodeCcSession = Schema.decodeUnknownSync(AuthSessionState);

  it("keeps stock send and answer enabled while CC clients retain custom permissions", () => {
    const grant = Object.freeze([
      "orchestration:read",
      "orchestration:operate",
      "filesystem:read",
      "command-center:read",
      "command-center:operate",
      "command-center:approve",
    ] as const);
    const originalGrant = [...grant];
    const response = {
      authenticated: true,
      auth: {
        policy: "remote-reachable",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["bearer-access-token"],
        sessionCookieName: "session",
      },
      sessionMethod: "bearer-access-token",
      draftScopeId: "paired-mobile-session",
      ...authScopeResponse(grant),
    };
    const stock = decodeStockSession(response);
    expect(stock.scopes).toEqual(["orchestration:read", "orchestration:operate"]);
    expect(stock.permissions).toEqual([
      "orchestration:read",
      "orchestration:operate",
      "filesystem:read",
    ]);
    // Mobile gates both sending messages and answering questions on this scope.
    expect(sessionGrantsScope(stock, "orchestration:operate")).toBe(true);
    const cc = decodeCcSession(response);
    expect(cc.permissions).toEqual(originalGrant);
    expect(response.permissions).toBe(grant);
    expect(grant).toEqual(originalGrant);
  });

  it.each([
    { label: "empty", scopes: [] },
    { label: "read-only", scopes: ["orchestration:read"] },
    {
      label: "CC-only",
      scopes: ["command-center:read", "command-center:operate", "command-center:approve"],
    },
  ] as const)("does not add orchestration access to $label grants", ({ scopes }) => {
    const grant = Object.freeze(scopes);
    const originalGrant = [...grant];
    const response = authScopeResponse(grant);
    expect(decodeStockScopes(response.scopes)).not.toContain("orchestration:operate");
    expect(sessionGrantsScope({ authenticated: true, ...response }, "orchestration:operate")).toBe(
      false,
    );
    expect(response.permissions).toBe(grant);
    expect(grant).toEqual(originalGrant);
  });

  it("ignores unknown response permissions without falling back to broader scopes", () => {
    const session = Schema.decodeUnknownSync(AuthSessionState)({
      authenticated: true,
      auth: {
        policy: "loopback-browser",
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "session",
      },
      scopes: ["orchestration:operate"],
      permissions: ["future:permission"],
    });
    expect(session.permissions).toEqual([]);
    expect(sessionGrantsScope(session, "orchestration:operate")).toBe(false);
    expect(sessionGrantsScope(session, "settings:write")).toBe(false);
  });

  it.each([
    {
      label: "exact permissions over the legacy presentation",
      session: {
        authenticated: true,
        scopes: ["orchestration:operate"],
        permissions: ["filesystem:read"],
      },
      scope: "settings:write",
      expected: false,
    },
    {
      label: "a permission absent from the legacy presentation",
      session: { authenticated: true, scopes: [], permissions: ["filesystem:read"] },
      scope: "filesystem:read",
      expected: true,
    },

    {
      label: "the parent on a server that predates the split",
      session: { authenticated: true, scopes: ["orchestration:operate"], auth: {} },
      scope: "settings:write",
      expected: true,
    },
    {
      label: "only the exact scope on a server that knows the split",
      session: {
        authenticated: true,
        scopes: ["orchestration:operate"],
        auth: { serverUpdateScope: "environment:maintain" },
      },
      scope: "settings:write",
      expected: false,
    },
    {
      label: "the exact scope regardless of server version",
      session: { authenticated: true, scopes: ["settings:write"], auth: {} },
      scope: "settings:write",
      expected: true,
    },
    {
      label: "nothing for an unauthenticated session",
      session: { authenticated: false, scopes: ["orchestration:operate"], auth: {} },
      scope: "settings:write",
      expected: false,
    },
    {
      label: "no parent for scopes that were never split",
      session: { authenticated: true, scopes: ["orchestration:operate"], auth: {} },
      scope: "access:write",
      expected: false,
    },
  ] as const)("sessionGrantsScope accepts $label", ({ session, scope, expected }) => {
    expect(sessionGrantsScope(session, scope)).toBe(expected);
  });
});

describe("legacy permission notice", () => {
  it.each(["orchestration:read", "orchestration:operate", "terminal:operate"] as const)(
    "recognizes an old %s grant on an upgraded server",
    (scope) =>
      expect(sessionHasLegacyPermissions({ authenticated: true, permissions: [scope] })).toBe(true),
  );
  it("waits for a new server and an authenticated session", () => {
    expect(
      sessionHasLegacyPermissions({ authenticated: true, scopes: ["orchestration:operate"] }),
    ).toBe(false);
    expect(
      sessionHasLegacyPermissions({ authenticated: false, permissions: ["orchestration:operate"] }),
    ).toBe(false);
  });
  it("recognizes old grants that also contain CC permissions", () => {
    expect(
      sessionHasLegacyPermissions({
        authenticated: true,
        permissions: [
          "orchestration:operate",
          "command-center:read",
          "command-center:operate",
          "command-center:approve",
        ],
      }),
    ).toBe(true);
  });
  it("skips new grants and old grants that lost no implied permissions", () => {
    for (const permissions of [
      AuthStandardClientScopes,
      ["orchestration:read", "filesystem:read"] as const,
      ["access:read"] as const,
      [],
    ]) {
      expect(sessionHasLegacyPermissions({ authenticated: true, permissions })).toBe(false);
    }
  });
});
