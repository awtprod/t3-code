// @effect-diagnostics nodeBuiltinImport:off - Standalone in-container CLI; bundled without Effect.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";

const MAX_BODY_BYTES = 65_536;
const MAX_RESPONSE_BYTES = 1024 * 1024;

type CliIo = {
  readonly stdout: Pick<NodeJS.WriteStream, "write">;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
};

const help = `usage:
  gh pr create --base <branch> [--head <branch>] --title <title> [--body <body>]
  gh pr create --base <branch> [--head <branch>] --fill
  gh pr merge <number-or-url> [--merge]

Sandbox GitHub access is repository-scoped. Directly pushing main or merging a
pull request whose base is main is denied by the credential broker.
`;

const requiredEnvironment = (environment: NodeJS.ProcessEnv) => {
  const baseUrl = environment.T3_GITHUB_PR_BASE_URL?.trim();
  const token = environment.T3_GITHUB_PR_TOKEN?.trim();
  const repository = environment.T3_GITHUB_REPOSITORY?.trim();
  if (!baseUrl || !token || !repository)
    throw new Error("GitHub pull request access is not provisioned for this sandbox");
  return { baseUrl, token, repository };
};

const git = (args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", [...args], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: MAX_BODY_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const readBodyFile = (path: string): string => {
  const value = NodeFS.readFileSync(path === "-" ? 0 : path, "utf8");
  if (Buffer.byteLength(value) > MAX_BODY_BYTES)
    throw new Error(`pull request body exceeds ${String(MAX_BODY_BYTES)} bytes`);
  return value;
};

const postJson = async (
  baseUrl: string,
  token: string,
  action: "create" | "merge",
  body: Record<string, unknown>,
) => {
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/${action}`);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("GitHub pull request broker URL is invalid");
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise<{ readonly status: number; readonly body: Buffer }>((resolve, reject) => {
    const transport = url.protocol === "https:" ? NodeHttps : NodeHttp;
    const request = transport.request(
      url,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "content-length": String(payload.length),
        },
        timeout: 30_000,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            response.destroy(new Error("GitHub broker response exceeded the CLI limit"));
            return;
          }
          chunks.push(chunk);
        });
        response.once("end", () =>
          resolve({ status: response.statusCode ?? 502, body: Buffer.concat(chunks, size) }),
        );
        response.once("error", reject);
      },
    );
    request.once("timeout", () => request.destroy(new Error("GitHub broker request timed out")));
    request.once("error", reject);
    request.end(payload);
  });
};

const parseArguments = (args: ReadonlyArray<string>) => {
  const options = new Map<string, string | true>();
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg : arg.slice(0, equals);
    if (["--draft", "--fill", "--fill-first", "--fill-verbose", "--merge"].includes(name)) {
      options.set(name, true);
      continue;
    }
    const value = equals === -1 ? args[index + 1] : arg.slice(equals + 1);
    if (value === undefined || (equals === -1 && value.startsWith("--")))
      throw new Error(`${name} requires a value`);
    options.set(name, value);
    if (equals === -1) index += 1;
  }
  return { options, positional };
};

const option = (options: ReadonlyMap<string, string | true>, name: string) => {
  const value = options.get(name);
  return typeof value === "string" ? value : undefined;
};

const assertRepository = (options: ReadonlyMap<string, string | true>, repository: string) => {
  const requested = option(options, "--repo");
  if (requested !== undefined && requested.toLowerCase() !== repository.toLowerCase())
    throw new Error(`sandbox GitHub access is scoped to ${repository}`);
};

const parsePullRequestNumber = (value: string | undefined): number => {
  const match = value?.match(/(?:^|\/pull\/)(\d+)(?:$|[/?#])/);
  const number = match === null || match === undefined ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(number) || number <= 0)
    throw new Error("gh pr merge requires a pull request number or GitHub pull request URL");
  return number;
};

const responseError = (status: number, body: Buffer) => {
  let message = body.toString("utf8").trim();
  try {
    const decoded = JSON.parse(message) as { readonly message?: unknown };
    if (typeof decoded.message === "string") message = decoded.message;
  } catch {
    // The broker's own denials are intentionally plain text.
  }
  return new Error(`GitHub pull request operation failed (${String(status)}): ${message}`);
};

export async function runGitHubPrCli(
  argv: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv = process.env,
  io: CliIo = process,
): Promise<number> {
  if (argv.length === 0 || argv.includes("--help") || argv[0] === "help") {
    io.stdout.write(help);
    return 0;
  }
  if (argv[0] === "--version" || argv[0] === "version") {
    io.stdout.write("gh version t3-sandbox-pr-broker\n");
    return 0;
  }
  if (argv[0] !== "pr" || (argv[1] !== "create" && argv[1] !== "merge")) {
    io.stderr.write("This sandboxed gh supports only pr create and pr merge.\n");
    return 2;
  }

  try {
    const provisioned = requiredEnvironment(environment);
    const { options, positional } = parseArguments(argv.slice(2));
    assertRepository(options, provisioned.repository);

    if (argv[1] === "create") {
      const allowed = new Set([
        "--base",
        "--head",
        "--title",
        "--body",
        "--body-file",
        "--draft",
        "--fill",
        "--fill-first",
        "--fill-verbose",
        "--repo",
      ]);
      const unsupported = [...options.keys()].find((name) => !allowed.has(name));
      if (unsupported !== undefined)
        throw new Error(`unsupported gh pr create option ${unsupported}`);
      if (positional.length > 0)
        throw new Error("gh pr create does not accept positional arguments");
      const base = option(options, "--base");
      if (!base) throw new Error("gh pr create requires an explicit --base branch");
      const head = option(options, "--head") ?? git(["branch", "--show-current"]);
      const fill = ["--fill", "--fill-first", "--fill-verbose"].some((name) => options.has(name));
      const title = option(options, "--title") ?? (fill ? git(["log", "-1", "--pretty=%s"]) : "");
      const bodyFile = option(options, "--body-file");
      const body =
        bodyFile !== undefined
          ? readBodyFile(bodyFile)
          : (option(options, "--body") ?? (fill ? git(["log", "-1", "--pretty=%b"]) : ""));
      if (!head) throw new Error("could not determine the pull request head branch");
      if (!title) throw new Error("gh pr create requires --title or --fill");
      const result = await postJson(provisioned.baseUrl, provisioned.token, "create", {
        base,
        head,
        title,
        body,
        draft: options.has("--draft"),
      });
      if (result.status < 200 || result.status >= 300)
        throw responseError(result.status, result.body);
      const decoded = JSON.parse(result.body.toString("utf8")) as { readonly html_url?: unknown };
      if (typeof decoded.html_url !== "string")
        throw new Error("GitHub returned a pull request without a URL");
      io.stdout.write(`${decoded.html_url}\n`);
      return 0;
    }

    const allowed = new Set(["--merge", "--repo"]);
    const unsupported = [...options.keys()].find((name) => !allowed.has(name));
    if (unsupported !== undefined) throw new Error(`unsupported gh pr merge option ${unsupported}`);
    if (positional.length !== 1)
      throw new Error("gh pr merge requires exactly one pull request number or URL");
    const number = parsePullRequestNumber(positional[0]);
    const result = await postJson(provisioned.baseUrl, provisioned.token, "merge", { number });
    if (result.status < 200 || result.status >= 300)
      throw responseError(result.status, result.body);
    io.stdout.write(`Merged pull request #${String(number)}.\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export const main = async (argv: ReadonlyArray<string>) => {
  process.exitCode = await runGitHubPrCli(argv);
};
