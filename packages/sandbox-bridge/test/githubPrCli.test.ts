// @effect-diagnostics nodeBuiltinImport:off - The CLI is a standalone Node process in production.
import { afterAll, describe, expect, it } from "@effect/vitest";
import * as NodeHttp from "node:http";

import { runGitHubPrCli } from "../src/githubPrCli.ts";
import { closeServer, listen } from "./support.ts";

const servers: NodeHttp.Server[] = [];

afterAll(async () => {
  await Promise.all(servers.map(closeServer));
});

const startBroker = async () => {
  const seen: Array<{ readonly body: unknown; readonly url: string }> = [];
  const server = NodeHttp.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      seen.push({
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        url: request.url ?? "",
      });
      response.statusCode = 201;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ html_url: "https://github.com/acme/repository/pull/17" }));
    });
  });
  servers.push(server);
  const port = await listen(server);
  return { baseUrl: `${"http:"}//127.0.0.1:${port}/github-pr`, seen };
};

const io = () => {
  let stdout = "";
  let stderr = "";
  return {
    value: {
      stdout: { write: (value: string | Uint8Array) => ((stdout += String(value)), true) },
      stderr: { write: (value: string | Uint8Array) => ((stderr += String(value)), true) },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
};

const environment = (baseUrl: string) => ({
  T3_GITHUB_PR_BASE_URL: baseUrl,
  T3_GITHUB_PR_TOKEN: "opaque-thread-token",
  T3_GITHUB_REPOSITORY: "acme/repository",
});

describe("sandbox gh pull request shim", () => {
  it("creates a repository-scoped pull request, including one targeting main", async () => {
    const broker = await startBroker();
    const output = io();
    const exit = await runGitHubPrCli(
      [
        "pr",
        "create",
        "--repo",
        "acme/repository",
        "--base",
        "main",
        "--head",
        "dev",
        "--title",
        "Promote dev",
        "--body",
        "Human-gated deployment",
      ],
      environment(broker.baseUrl),
      output.value,
    );
    expect(exit).toBe(0);
    expect(output.stdout()).toBe("https://github.com/acme/repository/pull/17\n");
    expect(output.stderr()).toBe("");
    expect(broker.seen).toEqual([
      {
        body: {
          base: "main",
          head: "dev",
          title: "Promote dev",
          body: "Human-gated deployment",
          draft: false,
        },
        url: "/github-pr/create",
      },
    ]);
  });

  it("requests a merge by PR number without receiving a GitHub credential", async () => {
    const broker = await startBroker();
    const output = io();
    const exit = await runGitHubPrCli(
      ["pr", "merge", "17", "--merge"],
      environment(broker.baseUrl),
      output.value,
    );
    expect(exit).toBe(0);
    expect(output.stdout()).toBe("Merged pull request #17.\n");
    expect(broker.seen).toEqual([{ body: { number: 17 }, url: "/github-pr/merge" }]);
  });

  it("rejects another repository before contacting the broker", async () => {
    const broker = await startBroker();
    const output = io();
    const exit = await runGitHubPrCli(
      [
        "pr",
        "create",
        "--repo",
        "another/repository",
        "--base",
        "dev",
        "--head",
        "feature",
        "--title",
        "Wrong repository",
      ],
      environment(broker.baseUrl),
      output.value,
    );
    expect(exit).toBe(1);
    expect(output.stderr()).toContain("scoped to acme/repository");
    expect(broker.seen).toHaveLength(0);
  });

  it("fails closed when PR access was not provisioned", async () => {
    const output = io();
    const exit = await runGitHubPrCli(["pr", "merge", "17"], {}, output.value);
    expect(exit).toBe(1);
    expect(output.stderr()).toContain("not provisioned");
  });

  it("does not expose a generic authenticated GitHub API", async () => {
    const broker = await startBroker();
    const output = io();
    const exit = await runGitHubPrCli(
      ["api", "repos/acme/repository/git/refs/heads/main"],
      environment(broker.baseUrl),
      output.value,
    );
    expect(exit).toBe(2);
    expect(output.stderr()).toContain("only pr create and pr merge");
    expect(broker.seen).toHaveLength(0);
  });
});
