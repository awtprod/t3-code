import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";
import type * as EffectCodexSchema from "effect-codex-app-server/schema";

import { describeMcpElicitation, toMcpElicitationResponse } from "./CodexMcpElicitation.ts";

describe("Codex MCP elicitation approvals", () => {
  const request = {
    mode: "form",
    message: "Allow ChatGPT to use Safari?",
    serverName: "computer-use",
    threadId: "provider-thread-1",
    turnId: "turn-1",
    _meta: {
      app_name: "Safari",
      persist: ["session", "always"],
    },
    requestedSchema: {
      type: "object",
      properties: {
        approval: {
          type: "string",
          oneOf: [
            { const: "once", title: "Allow once" },
            { const: "session", title: "Allow for this session" },
            { const: "always", title: "Always allow Safari" },
          ],
        },
      },
      required: ["approval"],
    },
  } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

  it("names the app by the trusted server name and keeps advertised persistence choices", () => {
    NodeAssert.deepStrictEqual(describeMcpElicitation(request), {
      appName: "computer-use",
      options: [
        { decision: "cancel", label: "Cancel" },
        { decision: "decline", label: "Decline" },
        { decision: "acceptForSession", label: "Allow for this session" },
        { decision: "acceptAlways", label: "Always allow Safari" },
        { decision: "accept", label: "Approve" },
      ],
    });
  });

  it("uses the trusted MCP server name instead of request-controlled app metadata", () => {
    const { _meta, ...requestWithoutMetadata } = request;

    NodeAssert.equal(describeMcpElicitation(requestWithoutMetadata).appName, "computer-use");
    // Neither `_meta` app names nor the message text can rename the app in the prompt.
    const spoofed = {
      ...request,
      message: "Allow ChatGPT to use Trusted Bank?",
      _meta: {
        app_name: "Trusted Bank",
        appName: "Trusted Bank",
        connector_name: "Trusted Bank",
        target: { app: "Trusted Bank", name: "Trusted Bank" },
        tool_params: { app_name: "Trusted Bank" },
        persist: ["session"],
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;
    NodeAssert.equal(describeMcpElicitation(spoofed).appName, "computer-use");
  });

  it("returns the accepted form option to Codex", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "accept"), {
      action: "accept",
      content: { approval: "once" },
    });
  });

  it("returns session-scoped approval in the MCP response", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "acceptForSession"), {
      action: "accept",
      _meta: { persist: "session" },
      content: { approval: "session" },
    });
  });

  it("returns persistent approval in the MCP response", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "acceptAlways"), {
      action: "accept",
      _meta: { persist: "always" },
      content: { approval: "always" },
    });
  });

  it("returns rejection without form content", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "decline"), {
      action: "decline",
    });
  });

  it("returns cancellation without form content", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "cancel"), {
      action: "cancel",
    });
  });

  it("supports boolean permanent-approval fields", () => {
    const booleanRequest = {
      ...request,
      _meta: { app_name: "Safari" },
      requestedSchema: {
        type: "object",
        properties: {
          always: { type: "boolean", title: "Always allow Safari" },
        },
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.ok(
      describeMcpElicitation(booleanRequest).options.some(
        (option) => option.decision === "acceptAlways",
      ),
    );
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(booleanRequest, "acceptAlways"), {
      action: "accept",
      _meta: { persist: "always" },
      content: { always: true },
    });
  });

  it("preserves valid nullable MCP form fields and persistence choices", () => {
    const nullableRequest = {
      ...request,
      _meta: {
        app_name: null,
        appName: "Safari",
        connector_name: null,
        persist: null,
        target: null,
        tool_params: null,
      },
      requestedSchema: {
        type: "object",
        properties: {
          approval: {
            type: "string",
            title: null,
            description: null,
            default: null,
            enum: ["once", "always"],
            enumNames: null,
          },
        },
        required: ["approval"],
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.equal(describeMcpElicitation(nullableRequest).appName, "computer-use");
    NodeAssert.ok(
      describeMcpElicitation(nullableRequest).options.some(
        (option) => option.decision === "acceptAlways",
      ),
    );
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(nullableRequest, "acceptAlways"), {
      action: "accept",
      _meta: { persist: "always" },
      content: { approval: "always" },
    });
  });

  it("declines required form fields that an approval prompt cannot collect", () => {
    const inputRequest = {
      ...request,
      requestedSchema: {
        type: "object",
        properties: {
          email: { type: "string", format: "email" },
        },
        required: ["email"],
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.deepStrictEqual(toMcpElicitationResponse(inputRequest, "accept"), {
      action: "decline",
    });
  });

  it("does not approve URL elicitations without opening their requested URL", () => {
    const urlRequest = {
      mode: "url",
      message: "Finish signing in to continue.",
      serverName: "computer-use",
      threadId: "provider-thread-1",
      turnId: "turn-1",
      elicitationId: "sign-in-1",
      url: "https://example.com/authorize",
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.deepStrictEqual(toMcpElicitationResponse(urlRequest, "accept"), {
      action: "decline",
    });
  });

  it("omits persistence choices that cannot satisfy required form fields", () => {
    const onceOnlyRequest = {
      ...request,
      _meta: { app_name: "Safari", persist: ["session", "always"] },
      requestedSchema: {
        type: "object",
        properties: {
          approval: {
            type: "string",
            enum: ["once"],
          },
        },
        required: ["approval"],
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.deepStrictEqual(describeMcpElicitation(onceOnlyRequest).options, [
      { decision: "cancel", label: "Cancel" },
      { decision: "decline", label: "Decline" },
      { decision: "accept", label: "Approve" },
    ]);
  });

  it("keeps boolean session consent session-scoped", () => {
    const { _meta: _requestMeta, ...requestWithoutMetadata } = request;
    const sessionRequest = {
      ...requestWithoutMetadata,
      requestedSchema: {
        type: "object",
        properties: {
          session: { type: "boolean", title: "Allow for this session" },
        },
        required: ["session"],
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.deepStrictEqual(describeMcpElicitation(sessionRequest).options, [
      { decision: "cancel", label: "Cancel" },
      { decision: "decline", label: "Decline" },
      { decision: "acceptForSession", label: "Allow for this session" },
      { decision: "accept", label: "Approve" },
    ]);
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(sessionRequest, "acceptForSession"), {
      action: "accept",
      _meta: { persist: "session" },
      content: { session: true },
    });
    // Choosing "always" must not tick a session-only checkbox as permanent consent.
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(sessionRequest, "acceptAlways"), {
      action: "accept",
      _meta: { persist: "always" },
      content: { session: false },
    });
  });

  it("declines required enum values that do not explicitly mean one-time approval", () => {
    const unsafeOptionRequest = {
      ...request,
      requestedSchema: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["disallow", "allow_admin"] },
        },
        required: ["scope"],
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.deepStrictEqual(toMcpElicitationResponse(unsafeOptionRequest, "accept"), {
      action: "decline",
    });
  });

  it("still picks an explicit one-time approval value", () => {
    for (const value of ["allow", "Allow_Once", "approve once", "accept-once", "once"]) {
      const onceRequest = {
        ...request,
        requestedSchema: {
          type: "object",
          properties: { scope: { type: "string", enum: ["allow_admin", value] } },
          required: ["scope"],
        },
      } satisfies EffectCodexSchema.McpServerElicitationRequestParams;
      NodeAssert.deepStrictEqual(toMcpElicitationResponse(onceRequest, "accept"), {
        action: "accept",
        content: { scope: value },
      });
    }
  });
});
