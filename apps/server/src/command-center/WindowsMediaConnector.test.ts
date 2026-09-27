import { WINDOWS_MEDIA_MAX_ENTRIES } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ProcessRunner from "../processRunner.ts";
import {
  isPathAllowed,
  makeWindowsMediaSettings,
  normalizeWindowsPath,
  windowsFileAttachmentPathLine,
  windowsFileScpCommand,
  windowsParentPath,
} from "./WindowsMediaConfig.ts";
import * as WindowsMediaConnector from "./WindowsMediaConnector.ts";

const encodeOutput = (value: unknown) =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64");

const okResult = (stdout: string): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const makeHarness = (options: {
  readonly respond: (input: ProcessRunner.ProcessRunInput) => ProcessRunner.ProcessRunOutput;
  readonly roots?: string;
  readonly enabled?: boolean;
}) => {
  const invocations: ProcessRunner.ProcessRunInput[] = [];
  const settings = makeWindowsMediaSettings({
    ...(options.roots !== undefined ? { roots: options.roots } : {}),
    ...(options.enabled !== undefined ? { enabled: options.enabled } : {}),
  });
  const layer = WindowsMediaConnector.layerWithSettings(settings).pipe(
    Layer.provide(
      Layer.succeed(
        ProcessRunner.ProcessRunner,
        ProcessRunner.ProcessRunner.of({
          run: (input) => {
            invocations.push(input);
            return Effect.succeed(options.respond(input));
          },
        }),
      ),
    ),
  );
  return { invocations, layer };
};

describe("normalizeWindowsPath", () => {
  it("normalizes separators, drive case and trailing slashes", () => {
    assert.equal(normalizeWindowsPath("c:/Media//Clips Day 1/"), "C:\\Media\\Clips Day 1");
    assert.equal(normalizeWindowsPath("D:"), "D:\\");
    assert.equal(normalizeWindowsPath("D:\\"), "D:\\");
    assert.equal(normalizeWindowsPath("\\\\nas\\media\\clips"), "\\\\nas\\media\\clips");
  });

  it("rejects relative, traversal, device and wildcard paths", () => {
    for (const bad of [
      "Users\\x",
      "C:relative",
      "C:\\Clips\\..\\Windows",
      "C:\\a\\.\\b",
      "\\\\?\\C:\\x",
      "\\\\.\\PhysicalDrive0",
      "C:\\*.mov",
      'C:\\a"b',
      "C:\\a" + "\n" + "b",
      "C:\\a\\b:stream",
    ]) {
      assert.equal(normalizeWindowsPath(bad), null, bad);
    }
  });

  it("enforces the allowlist on segment boundaries, case-insensitively", () => {
    const roots = ["C:\\Clips"];
    assert.isTrue(isPathAllowed("c:\\clips\\day 1", roots));
    assert.isTrue(isPathAllowed("C:\\Clips", roots));
    assert.isFalse(isPathAllowed("C:\\Clips2", roots));
    assert.isFalse(isPathAllowed("C:\\", roots));
    assert.isTrue(isPathAllowed("Z:\\anything", null));
  });

  it("stops parent navigation at drive and allowlisted roots", () => {
    assert.equal(windowsParentPath("C:\\", null), null);
    assert.equal(windowsParentPath("C:\\Users", null), "C:\\");
    assert.equal(windowsParentPath("C:\\Users\\a b", null), "C:\\Users");
    assert.equal(windowsParentPath("C:\\Clips", ["C:\\Clips"]), null);
    assert.equal(windowsParentPath("C:\\Clips\\x", ["C:\\Clips"]), "C:\\Clips");
  });
});

describe("settings", () => {
  it("defaults to the explicit provider ssh config and jvl3rp2", () => {
    const settings = makeWindowsMediaSettings({});
    assert.equal(
      settings.sshConfigPath,
      "/var/lib/command-center/providers/claude/awtprod/.ssh/config",
    );
    assert.equal(settings.hostAlias, "jvl3rp2");
    assert.equal(settings.roots, null);
    assert.isTrue(settings.enabled);
  });

  it("rejects ~ config paths and unsafe aliases, parses | separated roots", () => {
    assert.throws(() => makeWindowsMediaSettings({ sshConfigPath: "~/.ssh/config" }));
    assert.throws(() => makeWindowsMediaSettings({ hostAlias: "-oProxyCommand=x" }));
    assert.deepEqual(makeWindowsMediaSettings({ roots: "c:/Clips| D:\\Footage\\ " }).roots, [
      "C:\\Clips",
      "D:\\Footage",
    ]);
  });
});

describe("windows-file path line", () => {
  it("carries the path, the host and a copy-pasteable scp command", () => {
    const line = windowsFileAttachmentPathLine({
      name: "Timeline 1.mov",
      host: "jvl3rp2",
      path: "C:\\Timeline 1.mov",
      sshConfigPath: "/var/lib/command-center/providers/claude/awtprod/.ssh/config",
    });
    assert.include(line, 'Referenced Windows file "Timeline 1.mov" lives on host jvl3rp2');
    assert.include(line, "at: C:\\Timeline 1.mov");
    assert.include(line, "davinci-resolve MCP");
    assert.include(
      line,
      "scp -F '/var/lib/command-center/providers/claude/awtprod/.ssh/config' 'jvl3rp2:C:/Timeline 1.mov' <dest>",
    );
  });

  it("single-quotes shell metacharacters in Windows file names", () => {
    assert.equal(
      windowsFileScpCommand({
        sshConfigPath: "/cfg",
        host: "jvl3rp2",
        path: "C:\\it's $(x) `y`.mov",
        destination: ".",
      }),
      "scp -F '/cfg' 'jvl3rp2:C:/it'\\''s $(x) `y`.mov' .",
    );
  });
});

describe("WindowsMediaConnector", () => {
  it.effect("lists a directory with the path on stdin, never in the command", () => {
    const harness = makeHarness({
      respond: () =>
        okResult(
          `#< CLIXML noise\r\n${encodeOutput({
            ok: true,
            t: false,
            e: [
              { n: "Timeline 1.mov", d: false, s: 372874603, m: "2026-09-20T10:00:00.0000000Z" },
              { n: "Résumé clips ñ", d: true, s: 0, m: "2026-09-21T10:00:00.0000000Z" },
              { n: "still.PNG", d: false, s: 10, m: null },
            ],
          })}\r\n`,
        ),
    });
    return Effect.gen(function* () {
      const connector = yield* WindowsMediaConnector.WindowsMediaConnector;
      const result = yield* connector.list("c:/Media//Clips Day 1/");
      assert.equal(result.path, "C:\\Media\\Clips Day 1");
      assert.equal(result.parent, "C:\\Media");
      assert.deepEqual(
        result.entries.map((entry) => [entry.name, entry.kind, entry.path]),
        [
          ["Résumé clips ñ", "dir", "C:\\Media\\Clips Day 1\\Résumé clips ñ"],
          ["still.PNG", "image", "C:\\Media\\Clips Day 1\\still.PNG"],
          ["Timeline 1.mov", "video", "C:\\Media\\Clips Day 1\\Timeline 1.mov"],
        ],
      );
      const invocation = harness.invocations[0]!;
      assert.equal(invocation.command, "ssh");
      assert.deepEqual(invocation.args.slice(0, 9), [
        "-F",
        "/var/lib/command-center/providers/claude/awtprod/.ssh/config",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        "-T",
        "--",
        "jvl3rp2",
      ]);
      assert.equal(
        Buffer.from(invocation.stdin ?? "", "base64").toString("utf8"),
        "C:\\Media\\Clips Day 1",
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("treats injection payloads as literal path data", () => {
    const harness = makeHarness({
      respond: () =>
        okResult(encodeOutput({ ok: false, code: "not_found", err: "Cannot find path" })),
    });
    return Effect.gen(function* () {
      const connector = yield* WindowsMediaConnector.WindowsMediaConnector;
      const payloads = [
        "C:\\x'; Remove-Item -Recurse -Force wm-canary; '",
        "C:\\x`; Remove-Item wm-canary",
        "C:\\$(Remove-Item wm-canary)",
        "C:\\x & del wm-canary",
      ];
      for (const payload of payloads) {
        const error = yield* Effect.flip(connector.list(payload));
        assert.equal(error.reason, "not_found");
      }
      // A double quote is not a legal Windows path character: rejected locally.
      const quoted = yield* Effect.flip(connector.list('C:\\x"; Remove-Item C:\\y; "'));
      assert.equal(quoted.reason, "invalid_path");

      assert.equal(harness.invocations.length, payloads.length);
      const [first, ...rest] = harness.invocations;
      for (const invocation of rest) {
        // Identical argv for every request: no request data reaches the command line.
        assert.deepEqual(invocation.args, first!.args);
      }
      for (const [index, invocation] of harness.invocations.entries()) {
        assert.equal(
          Buffer.from(invocation.stdin ?? "", "base64").toString("utf8"),
          normalizeWindowsPath(payloads[index]!),
        );
        for (const arg of invocation.args) {
          assert.notInclude(arg, "Remove-Item");
        }
      }
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("accepts ConvertTo-Json's single-object shape and caps entries", () => {
    let call = 0;
    const many = Array.from({ length: WINDOWS_MEDIA_MAX_ENTRIES + 5 }, (_, index) => ({
      n: `f${index}.mp4`,
      d: false,
      s: index,
      m: null,
    }));
    const harness = makeHarness({
      respond: () =>
        okResult(
          call++ === 0
            ? encodeOutput({ ok: true, t: false, e: { n: "only.mov", d: false, s: 1, m: null } })
            : encodeOutput({ ok: true, t: true, e: many }),
        ),
    });
    return Effect.gen(function* () {
      const connector = yield* WindowsMediaConnector.WindowsMediaConnector;
      const single = yield* connector.list("D:\\");
      assert.deepEqual(
        single.entries.map((entry) => entry.path),
        ["D:\\only.mov"],
      );
      assert.equal(single.parent, null);
      const capped = yield* connector.list("D:\\big");
      assert.equal(capped.entries.length, WINDOWS_MEDIA_MAX_ENTRIES);
      assert.isTrue(capped.truncated);
      assert.equal(
        harness.invocations[0]!.maxOutputBytes,
        WindowsMediaConnector.WINDOWS_MEDIA_MAX_OUTPUT_BYTES,
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("enforces the roots allowlist before touching ssh", () => {
    const harness = makeHarness({
      roots: "C:\\Clips",
      respond: () => okResult(encodeOutput({ ok: true, t: false, e: [] })),
    });
    return Effect.gen(function* () {
      const connector = yield* WindowsMediaConnector.WindowsMediaConnector;
      const roots = yield* connector.roots();
      assert.deepEqual(roots.roots, [{ label: "C:\\Clips", path: "C:\\Clips" }]);
      const forbidden = yield* Effect.flip(connector.list("C:\\Windows"));
      assert.equal(forbidden.reason, "forbidden");
      const traversal = yield* Effect.flip(connector.list("C:\\Clips\\..\\Windows"));
      assert.equal(traversal.reason, "invalid_path");
      const allowed = yield* connector.list("c:\\clips");
      assert.equal(allowed.parent, null);
      assert.equal(harness.invocations.length, 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("enumerates drives from Get-PSDrive output", () => {
    const harness = makeHarness({
      respond: () =>
        okResult(
          encodeOutput({
            ok: true,
            r: [
              { n: "F", root: "F:\\", l: "Media" },
              { n: "C", root: "C:\\", l: "" },
            ],
          }),
        ),
    });
    return Effect.gen(function* () {
      const connector = yield* WindowsMediaConnector.WindowsMediaConnector;
      const result = yield* connector.roots();
      assert.deepEqual(result, {
        host: "jvl3rp2",
        roots: [
          { label: "C:", path: "C:\\" },
          { label: "Media (F:)", path: "F:\\" },
        ],
      });
      assert.equal(harness.invocations[0]!.stdin, "");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("refuses when disabled and surfaces ssh failures", () => {
    const disabled = makeHarness({ enabled: false, respond: () => okResult("") });
    const failing = makeHarness({
      respond: () => ({
        ...okResult(""),
        code: ChildProcessSpawner.ExitCode(255),
        stderr: "Permission denied (publickey).",
      }),
    });
    return Effect.gen(function* () {
      const off = yield* Effect.flip(
        Effect.gen(function* () {
          const connector = yield* WindowsMediaConnector.WindowsMediaConnector;
          return yield* connector.roots();
        }).pipe(Effect.provide(disabled.layer)),
      );
      assert.equal(off.reason, "disabled");
      const failed = yield* Effect.flip(
        Effect.gen(function* () {
          const connector = yield* WindowsMediaConnector.WindowsMediaConnector;
          return yield* connector.list("C:\\");
        }).pipe(Effect.provide(failing.layer)),
      );
      assert.equal(failed.reason, "process");
      assert.include(failed.message, "Permission denied");
    });
  });
});
