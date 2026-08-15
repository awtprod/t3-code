import { describe, it } from "@effect/vitest";
import * as NodeAssert from "node:assert/strict";

import {
  classifyCodexPermissionRequest,
  describeCodexPermissionRequest,
} from "./CodexPermissionEscalation.ts";

const params = (
  permissions: Parameters<typeof classifyCodexPermissionRequest>[0],
  reason?: string,
) =>
  ({
    cwd: "/workspace",
    itemId: "item-1",
    permissions,
    startedAtMs: 0,
    threadId: "thread-1",
    turnId: "turn-1",
    ...(reason === undefined ? {} : { reason }),
  }) as Parameters<typeof describeCodexPermissionRequest>[0];

describe("classifyCodexPermissionRequest", () => {
  it("treats an all-read profile as read-only", () => {
    const classification = classifyCodexPermissionRequest({
      fileSystem: {
        entries: [
          { access: "read", path: { type: "path", path: "/workspace/src" } },
          { access: "read", path: { type: "glob_pattern", pattern: "/workspace/**/*.ts" } },
        ],
      },
    });

    NodeAssert.equal(classification.readOnly, true);
    NodeAssert.equal(classification.network, false);
    NodeAssert.deepStrictEqual(classification.escalations, []);
  });

  it("treats a profile requesting nothing as read-only", () => {
    NodeAssert.equal(classifyCodexPermissionRequest({}).readOnly, true);
  });

  it("refuses a write entry", () => {
    const classification = classifyCodexPermissionRequest({
      fileSystem: {
        entries: [
          { access: "read", path: { type: "path", path: "/workspace/src" } },
          { access: "write", path: { type: "path", path: "/workspace/dist" } },
        ],
      },
    });

    NodeAssert.equal(classification.readOnly, false);
    NodeAssert.equal(classification.escalations.length, 1);
    NodeAssert.match(classification.escalations[0]!, /write access to \/workspace\/dist/u);
  });

  it("refuses the legacy write list even when entries are read-only", () => {
    const classification = classifyCodexPermissionRequest({
      fileSystem: {
        entries: [{ access: "read", path: { type: "path", path: "/workspace/src" } }],
        write: ["/workspace/out"],
      },
    });

    NodeAssert.equal(classification.readOnly, false);
    NodeAssert.match(classification.escalations.join(" "), /\/workspace\/out/u);
  });

  it("refuses a network enable", () => {
    const classification = classifyCodexPermissionRequest({ network: { enabled: true } });

    NodeAssert.equal(classification.readOnly, false);
    NodeAssert.equal(classification.network, true);
    NodeAssert.deepStrictEqual(classification.escalations, ["network access"]);
  });

  it("does not treat an explicitly disabled network as an escalation", () => {
    const classification = classifyCodexPermissionRequest({ network: { enabled: false } });

    NodeAssert.equal(classification.readOnly, true);
    NodeAssert.equal(classification.network, false);
  });

  it("refuses sandbox denials, which rewrite the profile rather than widen it", () => {
    const classification = classifyCodexPermissionRequest({
      fileSystem: {
        entries: [{ access: "deny", path: { type: "path", path: "/workspace/.env" } }],
      },
    });

    NodeAssert.equal(classification.readOnly, false);
    NodeAssert.match(classification.escalations.join(" "), /denials/u);
  });
});

describe("describeCodexPermissionRequest", () => {
  it("names read and write paths and the network request", () => {
    const detail = describeCodexPermissionRequest(
      params({
        fileSystem: {
          entries: [
            { access: "read", path: { type: "path", path: "/workspace/src" } },
            { access: "write", path: { type: "path", path: "/workspace/dist" } },
          ],
        },
        network: { enabled: true },
      }),
    );

    NodeAssert.match(detail, /write: \/workspace\/dist/u);
    NodeAssert.match(detail, /read: \/workspace\/src/u);
    NodeAssert.match(detail, /network access/u);
  });

  it("appends the reason Codex supplied", () => {
    const detail = describeCodexPermissionRequest(
      params(
        { fileSystem: { entries: [{ access: "read", path: { type: "path", path: "/a" } }] } },
        "inspect the workspace",
      ),
    );

    NodeAssert.equal(detail, "read: /a — inspect the workspace");
  });

  it("collapses long path lists instead of rendering an unreadable prompt", () => {
    const detail = describeCodexPermissionRequest(
      params({
        fileSystem: {
          read: ["/a", "/b", "/c", "/d", "/e", "/f"],
        },
      }),
    );

    NodeAssert.match(detail, /\(\+2 more\)/u);
  });

  it("still describes a profile that requests nothing", () => {
    NodeAssert.equal(describeCodexPermissionRequest(params({})), "no additional permissions");
  });
});
