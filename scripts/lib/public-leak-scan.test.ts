import { describe, expect, it } from "vite-plus/test";

import {
  extractPublicBinaryMetadata,
  isReviewablePublicBinary,
  parseAddedLineNumbers,
  parsePrivateDenylist,
  scanPublicAddedText,
  scanPublicPath,
  scanPublicText,
} from "./public-leak-scan.ts";

const joinUrl = (...segments: readonly string[]) => segments.join("");

describe("public leak scan", () => {
  it("accepts a generic public-safe configuration", () => {
    const findings = scanPublicText({
      path: "examples/config.json",
      text: [
        "name: Example Studio",
        "remote: https://example.invalid/example-org/example-app.git",
        "accountLabel: Primary account",
      ].join("\n"),
    });

    expect(findings).toEqual([]);
  });

  it("detects account addresses and absolute home paths without printing their values", () => {
    const address = ["operator", "sample.invalid"].join("@");
    const homePath = ["", "home", "developer", "project"].join("/");
    const findings = scanPublicText({
      path: "config.json",
      text: `${address}\n${homePath}\n`,
    });

    expect(findings.map((finding) => finding.rule)).toEqual(["account-address", "posix-home-path"]);
    expect(JSON.stringify(findings)).not.toContain(address);
    expect(JSON.stringify(findings)).not.toContain(homePath);
  });

  it("detects root, Windows drive, and Windows network paths without matching URL routes", () => {
    const findings = scanPublicText({
      path: "config.json",
      text: [
        ["", "root", "private", "project"].join("/"),
        ["", "var", "root", "private", "project"].join("/"),
        ["D:", "repos", "private", "project"].join("\\"),
        ["", "", "fileserver", "private", "project"].join("\\"),
        "https://example.invalid/root/guide",
      ].join("\n"),
    });

    expect(findings.map((finding) => finding.rule)).toEqual([
      "root-home-path",
      "root-home-path",
      "windows-absolute-path",
      "windows-unc-path",
    ]);
  });

  it("allows reserved example addresses", () => {
    const address = ["operator", "example.test"].join("@");
    expect(scanPublicText({ path: "docs/example.md", text: address })).toEqual([]);
  });

  it("allows public Git SSH transport users", () => {
    expect(
      scanPublicText({
        path: "fixture.ts",
        text: "git@github.com:example/project.git",
      }),
    ).toEqual([]);
  });

  it("rejects SCP-style Git remotes that use private hosts", () => {
    const privateRemotes = [
      joinUrl("git", "@repo-host", ":team/repository.git"),
      joinUrl("git", "@", "10", ".24.1.8:team/repository.git"),
      joinUrl("git", "@[", "fd12", "::8]:team/repository.git"),
      joinUrl("git", "@private-tailnet", ".ts.net.:team/repository.git"),
    ];

    for (const privateRemote of privateRemotes) {
      const findings = scanPublicText({ path: "config.json", text: privateRemote });
      expect(
        findings.map((finding) => finding.rule),
        privateRemote,
      ).toContain("private-git-remote");
      expect(JSON.stringify(findings), privateRemote).not.toContain(privateRemote);
    }
  });

  it("allows SCP-style Git remotes that use public or placeholder hosts", () => {
    const publicRemotes = [
      "git@github.com:example/repository.git",
      "git@gitlab.com:example/repository.git",
      "git@bitbucket.org:example/repository.git",
      "git@code.example.com:example/repository.git",
      "git@example.invalid:example/repository.git",
      "git@example-tailnet.ts.net:example/repository.git",
    ];

    for (const publicRemote of publicRemotes) {
      expect(scanPublicText({ path: "docs/example.md", text: publicRemote }), publicRemote).toEqual(
        [],
      );
    }
  });

  it("rejects private IPv4, CGNAT, link-local, and IPv6 network URLs", () => {
    const privateUrls = [
      joinUrl("http", "://", "10", ".12.0.8:8080/status"),
      joinUrl("https", "://", "172", ".31.4.2/report"),
      joinUrl("ws", "://", "192", ".168.1.40:9000"),
      joinUrl("https", "://", "100", ".72.8.9/"),
      joinUrl("http", "://", "169", ".254.20.4/metadata"),
      joinUrl("https", "://[", "fc00", "::42]:8443/"),
      joinUrl("https", "://[", "fd12", ":3456::9]/"),
      joinUrl("http", "://[", "fe80", "::1]:3000/"),
      joinUrl("http", "://[::ffff:", "192", ".168.1.8]/"),
    ];

    for (const privateUrl of privateUrls) {
      const findings = scanPublicText({ path: "docs/config.md", text: privateUrl });
      expect(findings[0]?.rule, privateUrl).toBe("private-url");
      expect(JSON.stringify(findings), privateUrl).not.toContain(privateUrl);
    }
  });

  it("rejects private DNS and non-placeholder tailnet hosts with ports and trailing dots", () => {
    const privateUrls = [
      joinUrl("HTTPS", "://Service", ".INTERNAL.:443/status"),
      joinUrl("https", "://build", ".corp/"),
      joinUrl("wss", "://events", ".cluster.local:9443/"),
      joinUrl("https", "://private-tailnet", ".ts.net./"),
      joinUrl("ssh", "://repo-host", "/project"),
    ];

    for (const privateUrl of privateUrls) {
      expect(scanPublicText({ path: "config.json", text: privateUrl })[0]?.rule, privateUrl).toBe(
        "private-url",
      );
    }
  });

  it("rejects URL user information, including percent-encoded credentials", () => {
    const credentialUrls = [
      joinUrl("https", "://operator", ":secret@", "example.com/path"),
      joinUrl("postgresql", "://service%2Duser", ":p%40ss@", "example.invalid/database"),
      joinUrl("ssh", "://%67it", "@example.org/repository"),
    ];

    for (const credentialUrl of credentialUrls) {
      const findings = scanPublicText({ path: "config.json", text: credentialUrl });
      expect(
        findings.some((finding) => finding.rule === "private-url"),
        credentialUrl,
      ).toBe(true);
      expect(JSON.stringify(findings), credentialUrl).not.toContain(credentialUrl);
    }
  });

  it("allows loopback and reserved documentation URL hosts", () => {
    const publicSafeUrls = [
      "http://localhost:3000/",
      "http://worker.localhost:3000/",
      "http://127.0.0.1:8080/",
      "http://[::1]:8080/",
      "https://example.com/guide",
      "https://assets.example.net/",
      "https://example.invalid/repository.git",
      "https://service.example.test/",
      "https://example.ts.net/",
      "https://example-tailnet.ts.net/",
      "http://192.0.2.10/",
      "http://198.51.100.20/",
      "http://203.0.113.30/",
      "http://[2001:db8::10]/",
    ];

    for (const publicSafeUrl of publicSafeUrls) {
      expect(
        scanPublicText({ path: "docs/example.md", text: publicSafeUrl }),
        publicSafeUrl,
      ).toEqual([]);
    }
  });

  it("scans generated lockfile additions for private URLs while retaining narrow checks", () => {
    const privateUrl = joinUrl("https", "://registry.service", ".internal/package");
    const text = `resolution: ${privateUrl}`;
    const findings = scanPublicAddedText({
      path: "pnpm-lock.yaml",
      text,
      patch: ["@@ -0,0 +1 @@", `+${text}`].join("\n"),
      denylistOnly: true,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("private-url");
    expect(JSON.stringify(findings)).not.toContain(privateUrl);
  });

  it("scans generated lockfile additions for private SCP-style Git remotes", () => {
    const privateRemote = joinUrl("git", "@dependency-host", ":team/package.git");
    const text = `resolution: ${privateRemote}`;
    const findings = scanPublicAddedText({
      path: "pnpm-lock.yaml",
      text,
      patch: ["@@ -0,0 +1 @@", `+${text}`].join("\n"),
      denylistOnly: true,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("private-git-remote");
    expect(JSON.stringify(findings)).not.toContain(privateRemote);
  });

  it("does not treat template-expression asset suffixes as account addresses", () => {
    const source = ["asset_${size}", "2x.png"].join("@");
    expect(scanPublicText({ path: "scripts/assets.mjs", text: source })).toEqual([]);
  });

  it("detects private denylist terms case-insensitively", () => {
    const findings = scanPublicText({
      path: "spaces.json",
      text: "name: PRIVATE LABEL",
      denylist: parsePrivateDenylist("private label, another label\nthird label"),
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("private-denylist");
  });

  it("detects private denylist terms in normalized repository paths", () => {
    const privateLabel = "private label";
    const findings = scanPublicPath("docs/private-label/guide.md", [privateLabel]);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("private-denylist");
    expect(JSON.stringify(findings)).not.toContain(privateLabel);
  });

  it("allows only reviewable public binary formats and exposes printable metadata", () => {
    expect(isReviewablePublicBinary("apps/web/public/icon.png")).toBe(true);
    expect(isReviewablePublicBinary("runtime/archive.bin")).toBe(false);

    const metadata = extractPublicBinaryMetadata(
      new Uint8Array([0, ...new TextEncoder().encode("private label"), 0]),
    );
    expect(
      scanPublicText({ path: "icon.png", text: metadata, denylist: ["private label"] })[0]?.rule,
    ).toBe("private-denylist");
  });

  it("does not match a short private identifier inside an unrelated checksum token", () => {
    expect(
      scanPublicText({
        path: "lockfile.yaml",
        text: "integrity: abcPRIVATEdef",
        denylist: ["private"],
      }),
    ).toEqual([]);
  });

  it("rejects state and credential file types while allowing the environment example", () => {
    expect(scanPublicPath("runtime/state.sqlite")[0]?.rule).toBe("sensitive-file");
    expect(scanPublicPath("credentials/client.pem")[0]?.rule).toBe("sensitive-file");
    expect(scanPublicPath(".env.local")[0]?.rule).toBe("sensitive-file");
    expect(scanPublicPath(".env.example")).toEqual([]);
    expect(scanPublicPath("apps/example/.env.example")).toEqual([]);
  });

  it("rejects generic logs, line-delimited records, databases, and transcript data", () => {
    const forbidden = [
      "runtime/agent.log",
      "runtime/agent.log.1",
      "runtime/audit.jsonl",
      "runtime/events.ndjson.gz",
      "runtime/index.duckdb",
      "runtime/cache.realm",
      "transcripts/session.txt",
      "runtime/session.transcript.json",
    ];

    for (const path of forbidden) {
      expect(scanPublicPath(path)[0]?.rule, path).toBe("sensitive-file");
    }
    expect(scanPublicPath("src/logger.ts")).toEqual([]);
    expect(scanPublicPath("src/transcript-parser.ts")).toEqual([]);
  });

  it("limits modified-file content checks to lines added by the public diff", () => {
    const patch = [
      "diff --git a/example.ts b/example.ts",
      "@@ -8,2 +8,3 @@",
      " unchanged",
      "-removed",
      "+replacement",
      "+new line",
      "@@ -20 +21 @@",
      "-old",
      "+new ending",
    ].join("\n");

    expect([...parseAddedLineNumbers(patch)]).toEqual([9, 10, 21]);
  });

  it("scans each historical revision's added lines and retains its commit locator", () => {
    const privateLabel = "private historical label";
    const findings = scanPublicAddedText({
      path: "config.json",
      text: ["safe", privateLabel, "safe again"].join("\n"),
      patch: [
        "diff --git a/config.json b/config.json",
        "@@ -1 +1,2 @@",
        " safe",
        `+${privateLabel}`,
      ].join("\n"),
      denylist: [privateLabel],
      revision: "0123456789abcdef",
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      line: 2,
      revision: "0123456789abcdef",
      rule: "private-denylist",
    });
    expect(JSON.stringify(findings)).not.toContain(privateLabel);
  });
});
