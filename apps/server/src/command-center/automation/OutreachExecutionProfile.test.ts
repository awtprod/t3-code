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
const binding = {
  project: "/srv/example/project",
  controller: "/srv/example/project/bin/guarded-campaign/guarded_outreach.py",
  journal: "/srv/example/state/journal",
  holdParent: "/srv/example/launch-state",
  environmentId: "00000000-0000-4000-8000-000000000001",
  spaceId: "example-space",
  repositoryId: "example-repository",
  uid: 1001,
  gid: 1002,
} as const;

const definitionJson = JSON.stringify({
  id: "outreach",
  spaceId: "example-space",
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
  binding,
  automationId: "outreach",
  nodeId: "send",
  definitionDigest: `sha256:${"a".repeat(64)}`,
  snapshotDigest: `sha256:${"b".repeat(64)}`,
  inputPath: `${binding.journal}/approved.json`,
  credentialReferencePath: "/srv/example/keys/authorized.json",
} as const;
const entry = {
  spaceId: binding.spaceId,
  repositoryId: binding.repositoryId,
  executable: OUTREACH.executable,
  argv: ["-I", "-S", "-B", binding.controller, "--input", profile.inputPath],
  cwd: binding.journal,
  access: "write",
  retryable: false,
  allowedRoots: [{ canonicalPath: binding.journal, access: "write" }],
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
      `${binding.journal}/../x.json`,
      `${binding.journal}//x.json`,
      `${binding.journal}/sub/x.json`,
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
    expect(outreachProfileIssue(profile, { ...entry, spaceId: "other-space" })).toBeDefined();
    expect(outreachProfileIssue(profile, { ...entry, repositoryId: "foreign" })).toBeDefined();
    expect(
      outreachProfileIssue(profile, { ...entry, executable: "/usr/bin/python3" }),
    ).toBeDefined();
  });
  it("rejects broad, overlapping, escaped and malformed owner bindings", () => {
    const variants = [
      { ...binding, project: "/", controller: "/bin/guarded-campaign/guarded_outreach.py" },
      { ...binding, journal: "/srv/example/project/state" },
      { ...binding, journal: "/srv/example" },
      { ...binding, holdParent: binding.journal },
      { ...binding, holdParent: `${binding.project}/hold` },
      {
        ...binding,
        project: "/usr/example/project",
        controller: "/usr/example/project/bin/guarded-campaign/guarded_outreach.py",
      },
      { ...binding, journal: "/srv/example/state/../journal" },
      { ...binding, journal: "/srv/example/state//journal" },
      { ...binding, journal: `${binding.journal}\n` },
      { ...binding, controller: `${binding.project}/legacy.py` },
      { ...binding, environmentId: `${binding.environmentId}\n` },
      { ...binding, spaceId: "example-space\n" },
      { ...binding, uid: 0 },
      { ...binding, gid: -1 },
      { ...binding, uid: 4_294_967_295 },
      { ...binding, network: true },
    ];
    for (const candidate of variants) {
      const inputPath = `${candidate.journal}/approved.json`;
      const candidateProfile = { ...profile, binding: candidate, inputPath };
      const candidateEntry = {
        ...entry,
        spaceId: candidate.spaceId,
        cwd: candidate.journal,
        allowedRoots: [{ canonicalPath: candidate.journal, access: "write" }],
        argv: ["-I", "-S", "-B", candidate.controller, "--input", inputPath],
      };
      expect(outreachProfileIssue(candidateProfile, candidateEntry)).toBeDefined();
    }
    for (const credentialReferencePath of [
      binding.project,
      `${binding.journal}/key.json`,
      binding.holdParent,
      "/proc/self/environ",
      "/srv/example",
      `${profile.credentialReferencePath}\n`,
    ])
      expect(outreachProfileIssue({ ...profile, credentialReferencePath }, entry)).toBeDefined();
  });

  it("binds protected digest, durable job, Space and node, surviving serialization", () => {
    const restored = JSON.parse(JSON.stringify(profile));
    expect(outreachCheckpointMatches(restored, row, "outreach", "example-space")).toBe(true);
    const minimal = JSON.stringify({ id: "outreach", spaceId: "example-space", nodes: [] });
    expect(
      outreachCheckpointMatches(
        profile,
        { ...row, definitionJson: minimal },
        "outreach",
        "example-space",
      ),
    ).toBe(false);
    expect(
      outreachCheckpointMatches(
        profile,
        { ...row, definitionJson: definitionJson.replace('"enabled":true', '"enabled":false') },
        "outreach",
        "example-space",
      ),
    ).toBe(false);

    for (const changed of [
      { ...row, automationId: "foreign" },
      { ...row, definitionJson: definitionJson + " ", snapshotDigest: "sha256:" + "0".repeat(64) },
      { ...row, definitionDigest: "sha256:" + "0".repeat(64) },
    ])
      expect(outreachCheckpointMatches(restored, changed, "outreach", "example-space")).toBe(false);
    expect(outreachCheckpointMatches(profile, row, "foreign", "example-space")).toBe(false);
    expect(outreachCheckpointMatches(profile, row, "outreach", "other-space")).toBe(false);
    expect(
      outreachCheckpointMatches(
        { ...profile, nodeId: "foreign" },
        row,
        "outreach",
        "example-space",
      ),
    ).toBe(false);
  });
  it("keeps ordinary network and resource policy unchanged; mounts live hold parent readonly", () => {
    const base = { executableFd: 3, cwdFd: 4, access: "write" as const, argv: entry.argv };
    const ordinary = buildVerifiedScopedShellBwrapArguments(base);
    expect(ordinary).not.toContain("--share-net");
    expect(ordinary).not.toContain("NODE_OPTIONS");
    const mounts = [
      binding.project,
      binding.controller,
      binding.holdParent,
      profile.inputPath,
      profile.credentialReferencePath,
    ].map((destination, index) => ({ destination, fd: 7 + index }));
    const outreach = buildVerifiedScopedShellBwrapArguments({
      ...base,
      outreach: { journal: binding.journal, mounts },
    });
    expect(outreach).toContain("--share-net");
    expect(outreach.join(" ")).toContain(`--ro-bind-fd 9 ${binding.holdParent}`);
    expect(outreach).not.toContain(`${binding.holdParent}/OUTREACH_LAUNCH_HOLD`);
    expect(outreach.join(" ")).toContain(`--bind-fd 4 ${binding.journal}`);
    expect(outreach).not.toContain("--bind");
    expect(outreach.filter((arg) => arg === "--bind-fd")).toHaveLength(1);
    expect(outreach.filter((arg) => arg === "--share-net")).toHaveLength(1);
    expect(outreach).not.toContain("--unshare-pid-try");
    const limits = { bwrapFd: 5, bwrapArguments: ordinary, timeoutMs: 1000, maxProcesses: 16 };
    expect(buildVerifiedScopedShellPrlimitArguments(limits)).toContain(
      `--as=${VERIFIED_SCOPED_SHELL_RESOURCE_LIMITS.maxAddressSpaceBytes}:${VERIFIED_SCOPED_SHELL_RESOURCE_LIMITS.maxAddressSpaceBytes}`,
    );
    expect(
      buildVerifiedScopedShellPrlimitArguments({ ...limits, outreachProfile: OUTREACH.name }),
    ).toContain(`--as=${OUTREACH.maxAddressSpaceBytes}:${OUTREACH.maxAddressSpaceBytes}`);
  });
});
