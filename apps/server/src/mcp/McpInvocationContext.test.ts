import { expect, it } from "@effect/vitest";
import {
  CommandCenterMcpCapabilityUnavailableError,
  EnvironmentId,
  PreviewAutomationUnavailableError,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "./McpInvocationContext.ts";

it.effect("reports the scoped credential context when preview capability is unavailable", () => {
  const invocation: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
    capabilities: new Set(),
    issuedAt: 1,
  };

  return Effect.gen(function* () {
    const error = yield* McpInvocationContext.requirePreviewCapability().pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.flip,
    );

    expect(error).toBeInstanceOf(PreviewAutomationUnavailableError);
    expect(error).toMatchObject({
      capability: "preview",
      environmentId: invocation.environmentId,
      threadId: invocation.threadId,
      providerSessionId: invocation.providerSessionId,
      providerInstanceId: invocation.providerInstanceId,
    });
    expect(error.message).toBe("MCP credential does not grant the preview capability.");
  });
});

it.effect("denies automation runs without the exact scoped capability", () => {
  const invocation: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-automation"),
    providerSessionId: "provider-session-automation",
    providerInstanceId: ProviderInstanceId.make("codex"),
    capabilities: new Set(["cc.automations.read"]),
    issuedAt: 1,
  };

  return Effect.gen(function* () {
    const error = yield* McpInvocationContext.requireCommandCenterCapability(
      "cc.automations.run",
    ).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.flip,
    );
    expect(error).toBeInstanceOf(CommandCenterMcpCapabilityUnavailableError);
    expect(error).toMatchObject({
      capability: "cc.automations.run",
      threadId: invocation.threadId,
      providerSessionId: invocation.providerSessionId,
    });
  });
});

it.effect("lets a router credential read and start Runs but denies every direct write", () => {
  const invocation: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("cc:router:thread-1"),
    providerSessionId: "provider-session-router",
    providerInstanceId: ProviderInstanceId.make("codex"),
    capabilities: new Set(["cc.items.read", "cc.memory.read", "cc.runs.start"]),
    issuedAt: 1,
  };

  return Effect.gen(function* () {
    yield* McpInvocationContext.requireCommandCenterCapability("cc.items.read");
    yield* McpInvocationContext.requireCommandCenterCapability("cc.memory.read");
    yield* McpInvocationContext.requireCommandCenterCapability("cc.runs.start");
    for (const capability of [
      "cc.items.write",
      "cc.memory.propose",
      "cc.automations.write",
      "cc.automations.run",
      "cc.sales.write",
      "cc.connections.google.gmail.drafts.create",
    ] as const) {
      const error = yield* McpInvocationContext.requireCommandCenterCapability(capability).pipe(
        Effect.flip,
      );
      expect(error).toBeInstanceOf(CommandCenterMcpCapabilityUnavailableError);
      expect(error).toMatchObject({ capability });
    }
  }).pipe(Effect.provideService(McpInvocationContext.McpInvocationContext, invocation));
});

it.effect("does not let a Gmail-only credential cross into Calendar or Drive", () => {
  const invocation: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-google"),
    providerSessionId: "provider-session-google",
    providerInstanceId: ProviderInstanceId.make("codex"),
    capabilities: new Set(["cc.connections.google.gmail.read"]),
    issuedAt: 1,
  };

  return Effect.gen(function* () {
    yield* McpInvocationContext.requireCommandCenterCapability("cc.connections.google.gmail.read");
    for (const capability of [
      "cc.connections.google.calendar.read",
      "cc.connections.google.drive.read",
    ] as const) {
      const error = yield* McpInvocationContext.requireCommandCenterCapability(capability).pipe(
        Effect.flip,
      );
      expect(error).toBeInstanceOf(CommandCenterMcpCapabilityUnavailableError);
      expect(error).toMatchObject({ capability });
    }
  }).pipe(Effect.provideService(McpInvocationContext.McpInvocationContext, invocation));
});
