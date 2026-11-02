import { describe, expect, it } from "vite-plus/test";
import {
  OUTREACH,
  outreachCheckpointMatches,
  outreachProfileIssue,
} from "./OutreachExecutionProfile.ts";
import {
  buildVerifiedScopedShellBwrapArguments,
  buildVerifiedScopedShellPrlimitArguments,
  VERIFIED_SCOPED_SHELL_RESOURCE_LIMITS,
} from "./VerifiedScopedShell.ts";
const definitionJson = JSON.stringify({
  id: "outreach",
  spaceId: "viewhook",
  name: "Outreach",
  version: 1,
  enabled: true,
  trigger: { type: "schedule", expression: "0 10 * * 1-5", timezone: "America/New_York" },
  definitionDigest: `sha256:${"a".repeat(64)}`,
  configCommit: "1".repeat(40),
  createdAt: "2026-11-02T00:00:00.000Z",
  updatedAt: "2026-11-02T00:00:00.000Z",
  edges: [],
  nodes: [
    {
      id: "send",
      kind: "shell.scoped",
      config: { allowlistId: "outreach" },
      position: { x: 0, y: 0 },
    },
  ],
});
const profile = {
  name: OUTREACH.name,
  automationId: "outreach",
  nodeId: "send",
  definitionDigest: `sha256:${"a".repeat(64)}`,
  snapshotDigest: `sha256:${"b".repeat(64)}`,
  environmentId: OUTREACH.environmentId,
  uid: OUTREACH.uid,
  gid: OUTREACH.gid,
  inputPath: `${OUTREACH.journal}/approved.json`,
  credentialReferencePath: "/var/lib/example/existing-key.json",
} as const;
const entry = {
  spaceId: OUTREACH.spaceId,
  repositoryId: OUTREACH.repositoryId,
  executable: OUTREACH.executable,
  argv: ["-I", "-S", "-B", OUTREACH.controller, "--input", profile.inputPath],
  cwd: OUTREACH.journal,
  access: "write",
  retryable: false,
  allowedRoots: [{ canonicalPath: OUTREACH.journal, access: "write" }],
};
const row = {
  automationId: profile.automationId,
  definitionDigest: profile.definitionDigest,
  definitionJson,
  snapshotDigest: profile.snapshotDigest,
};
describe("protected outreach execution", () => {
  it("allows only canonical readiness or owner-configured execute command", () => {
    expect(outreachProfileIssue(profile, entry)).toBeUndefined();
    expect(
      outreachProfileIssue(profile, { ...entry, argv: [...entry.argv, "--execute"] }),
    ).toBeUndefined();
    for (const argv of [
      ["-c", "arbitrary"],
      [...entry.argv, "--initialize-state"],
      [...entry.argv, "--execute", "extra"],
    ])
      expect(outreachProfileIssue(profile, { ...entry, argv })).toBeDefined();
  });
  it("rejects path escapes, alternate roots, retries and legacy entrypoints", () => {
    for (const inputPath of [
      `${OUTREACH.journal}/../x.json`,
      `${OUTREACH.journal}//x.json`,
      `${OUTREACH.journal}/sub/x.json`,
      "/tmp/x.json",
    ])
      expect(outreachProfileIssue({ ...profile, inputPath }, entry)).toBeDefined();
    expect(
      outreachProfileIssue(profile, {
        ...entry,
        allowedRoots: [{ canonicalPath: "/", access: "write" }],
      }),
    ).toBeDefined();
    expect(outreachProfileIssue(profile, { ...entry, retryable: true })).toBeDefined();
    expect(outreachProfileIssue(profile, { ...entry, spaceId: "ccn" })).toBeDefined();
    expect(outreachProfileIssue(profile, { ...entry, repositoryId: "foreign" })).toBeDefined();
    expect(
      outreachProfileIssue(profile, { ...entry, executable: "/usr/bin/python3" }),
    ).toBeDefined();
  });
  it("binds protected digest, durable job, Space and node, surviving serialization", () => {
    const restored = JSON.parse(JSON.stringify(profile));
    expect(outreachCheckpointMatches(restored, row, "outreach", "viewhook")).toBe(true);
    const minimal = JSON.stringify({ id: "outreach", spaceId: "viewhook", nodes: [] });
    expect(
      outreachCheckpointMatches(
        profile,
        { ...row, definitionJson: minimal },
        "outreach",
        "viewhook",
      ),
    ).toBe(false);
    expect(
      outreachCheckpointMatches(
        profile,
        { ...row, definitionJson: definitionJson.replace('"enabled":true', '"enabled":false') },
        "outreach",
        "viewhook",
      ),
    ).toBe(false);

    for (const changed of [
      { ...row, automationId: "foreign" },
      { ...row, definitionJson: definitionJson + " ", snapshotDigest: "sha256:" + "0".repeat(64) },
      { ...row, definitionDigest: "sha256:" + "0".repeat(64) },
    ])
      expect(outreachCheckpointMatches(restored, changed, "outreach", "viewhook")).toBe(false);
    expect(outreachCheckpointMatches(profile, row, "foreign", "viewhook")).toBe(false);
    expect(outreachCheckpointMatches(profile, row, "outreach", "other-space")).toBe(false);
    expect(
      outreachCheckpointMatches({ ...profile, nodeId: "foreign" }, row, "outreach", "viewhook"),
    ).toBe(false);
  });
  it("keeps ordinary network and resource policy unchanged; mounts live hold parent readonly", () => {
    const base = { executableFd: 3, cwdFd: 4, access: "write" as const, argv: entry.argv };
    const ordinary = buildVerifiedScopedShellBwrapArguments(base);
    expect(ordinary).not.toContain("--share-net");
    expect(ordinary).not.toContain("NODE_OPTIONS");
    const mounts = [
      OUTREACH.project,
      OUTREACH.controller,
      OUTREACH.holdParent,
      profile.inputPath,
      profile.credentialReferencePath,
    ].map((destination, index) => ({ destination, fd: 7 + index }));
    const outreach = buildVerifiedScopedShellBwrapArguments({ ...base, outreachMounts: mounts });
    expect(outreach).toContain("--share-net");
    expect(outreach.join(" ")).toContain(`--ro-bind-fd 9 ${OUTREACH.holdParent}`);
    expect(outreach).not.toContain(`${OUTREACH.holdParent}/OUTREACH_LAUNCH_HOLD`);
    expect(outreach.join(" ")).toContain(`--bind-fd 4 ${OUTREACH.journal}`);
    expect(outreach).not.toContain("--bind");
    const limits = { bwrapFd: 5, bwrapArguments: ordinary, timeoutMs: 1000, maxProcesses: 16 };
    expect(buildVerifiedScopedShellPrlimitArguments(limits)).toContain(
      `--as=${VERIFIED_SCOPED_SHELL_RESOURCE_LIMITS.maxAddressSpaceBytes}:${VERIFIED_SCOPED_SHELL_RESOURCE_LIMITS.maxAddressSpaceBytes}`,
    );
    expect(
      buildVerifiedScopedShellPrlimitArguments({ ...limits, outreachProfile: OUTREACH.name }),
    ).toContain(`--as=${OUTREACH.maxAddressSpaceBytes}:${OUTREACH.maxAddressSpaceBytes}`);
  });
});
