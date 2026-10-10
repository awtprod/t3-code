import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as NodeChildProcess from "node:child_process";
import * as NodeHttp from "node:http";
import * as NodeEvents from "node:events";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";

// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone native Windows diagnostic, isolated from production.
NodeAssert.equal(NodeOS.platform(), "win32");
const require = NodeModule.createRequire(new URL("../../package.json", import.meta.url));
const { chromium } = require("playwright-core");
const asar = NodeModule.createRequire(require.resolve("electron-builder"))("@electron/asar");
const [metadataPath, output, debuggerPath, controlExecutable] = process.argv.slice(2);
const root = NodePath.resolve(output);
NodeFS.mkdirSync(root, { recursive: true });
const artifacts = JSON.parse(NodeFS.readFileSync(metadataPath, "utf8").replace(/^\uFEFF/, ""));
NodeAssert.equal(artifacts.length, 2);
NodeAssert.deepEqual(
  artifacts.map((item) => item.runId),
  [37999068380, 38004694929],
);
const sha256 = (bytes) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const evidence = {
  startedAt: new Date().toISOString(),
  platform: "win32",
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Record the actual isolated CI host kernel.
  hostKernel: NodeOS.release(),
  hostImage: {
    imageOS: process.env.ImageOS,
    imageVersion: process.env.ImageVersion,
    runnerOS: process.env.RUNNER_OS,
    runnerArchitecture: process.env.RUNNER_ARCH,
  },
  productionAccess: false,
  realCredentials: false,
  preparationOutcomes: {
    upstream: process.env.UPSTREAM_PREPARATION_OUTCOME,
    nativeDebugger: process.env.DEBUGGER_PREPARATION_OUTCOME,
  },
  securityFlagsChanged: false,
  artifacts,
  launches: [],
  requests: [],
};
const save = () =>
  NodeFS.writeFileSync(
    NodePath.join(root, "startup-comparison.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
function manifest(directory) {
  const files = [];
  const walk = (current) => {
    for (const item of NodeFS.readdirSync(current, { withFileTypes: true })) {
      const path = NodePath.join(current, item.name);
      NodeAssert.equal(item.isSymbolicLink(), false);
      if (item.isDirectory()) walk(path);
      else if (item.isFile())
        files.push({
          path: NodePath.relative(directory, path).replaceAll("\\", "/"),
          bytes: NodeFS.statSync(path).size,
          sha256: sha256(NodeFS.readFileSync(path)),
        });
    }
  };
  walk(directory);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
for (const artifact of artifacts) {
  const directory = NodePath.dirname(artifact.executable);
  const archive = NodePath.join(directory, "resources", "app.asar");
  const pkg = JSON.parse(asar.extractFile(archive, "package.json").toString());
  NodeAssert.equal(pkg.version, artifact.version);
  NodeAssert.equal(pkg.t3codeCommitHash, artifact.commit.slice(0, 12));
  artifact.executableSha256 = sha256(NodeFS.readFileSync(artifact.executable));
  artifact.mainSha256 = sha256(
    asar.extractFile(archive, NodePath.join("apps", "desktop", "dist-electron", "main.cjs")),
  );
  artifact.preloadSha256 = sha256(
    asar.extractFile(archive, NodePath.join("apps", "desktop", "dist-electron", "preload.cjs")),
  );
  artifact.payloadManifest = manifest(directory);
  for (const expected of [
    "icudtl.dat",
    "v8_context_snapshot.bin",
    "resources.pak",
    "ffmpeg.dll",
    "chrome_100_percent.pak",
    "locales/en-US.pak",
    "resources/app.asar",
    "resources/server.asar",
  ]) {
    NodeAssert.ok(
      artifact.payloadManifest.some((file) => file.path === expected),
      `Missing packaged runtime file: ${expected}`,
    );
  }
  const executable = NodeFS.readFileSync(artifact.executable);
  const pe = executable.readUInt32LE(0x3c);
  NodeAssert.equal(executable.readUInt32LE(pe), 0x4550);
  const sections = executable.readUInt16LE(pe + 6);
  const sectionTable = pe + 24 + executable.readUInt16LE(pe + 20);
  artifact.peSections = Array.from({ length: sections }, (_, index) => {
    const start = sectionTable + index * 40;
    const name = executable
      .subarray(start, start + 8)
      .toString("ascii")
      .replaceAll(String.fromCharCode(0), "");
    const bytes = executable.readUInt32LE(start + 16);
    const offset = executable.readUInt32LE(start + 20);
    NodeAssert.ok(offset + bytes <= executable.length);
    return { name, bytes, sha256: sha256(executable.subarray(offset, offset + bytes)) };
  });
}
NodeAssert.deepEqual(
  artifacts[0].payloadManifest.map((file) => file.path),
  artifacts[1].payloadManifest.map((file) => file.path),
);
evidence.payloadDifferences = artifacts[0].payloadManifest
  .filter((file, index) => file.sha256 !== artifacts[1].payloadManifest[index].sha256)
  .map(({ path }) => path);
evidence.nativeSectionDifferences = artifacts[0].peSections
  .filter((section, index) => section.sha256 !== artifacts[1].peSections[index].sha256)
  .map(({ name }) => name);
const server = NodeHttp.createServer((request, response) => {
  evidence.requests.push({
    at: new Date().toISOString(),
    path: new URL(request.url, "http://127.0.0.1").pathname,
    authorizationPresent: !!request.headers.authorization,
  });
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify(
      request.url.startsWith("/.well-known/t3/environment")
        ? {
            environmentId: "00000000-0000-4000-8000-000000000001",
            label: "Synthetic startup fixture",
            platform: { os: "windows", arch: "x64" },
            serverVersion: "0.0.29",
            capabilities: { repositoryIdentity: true },
          }
        : {
            authenticated: false,
            auth: {
              policy: "remote-reachable",
              bootstrapMethods: ["one-time-token"],
              sessionMethods: ["bearer-access-token", "browser-session-cookie"],
              sessionCookieName: "t3_session",
            },
          },
    ),
  );
  save();
});
server.listen(0, "127.0.0.1");
await NodeEvents.once(server, "listening");
const endpoint = `http://127.0.0.1:${server.address().port}/`;
const minimalKeys = [
  "path",
  "pathext",
  "systemroot",
  "systemdrive",
  "windir",
  "comspec",
  "temp",
  "tmp",
  "os",
  "number_of_processors",
  "processor_architecture",
];
const extraWindowsKeys = [
  "programdata",
  "programfiles",
  "programfiles(x86)",
  "programw6432",
  "commonprogramfiles",
  "commonprogramfiles(x86)",
  "commonprogramw6432",
  "allusersprofile",
  "public",
  "computername",
  "username",
  "userdomain",
  "userdomain_roamingprofile",
  "sessionname",
  "processor_identifier",
  "processor_level",
  "processor_revision",
];
const flags = ["--remote-debugging-port=0", "--disable-gpu", "--enable-logging=stderr", "--v=1"];
function profileEnvironment(extended, precreateBrowserProfile = false) {
  // Reuse the exact same physical profile path after each captured process exits.
  const profile = NodePath.join(root, "isolated-profile");
  NodeFS.rmSync(profile, { recursive: true, force: true });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      [...minimalKeys, ...(extended ? extraWindowsKeys : [])].includes(key.toLowerCase()),
    ),
  );
  Object.assign(env, {
    USERPROFILE: NodePath.join(profile, "home"),
    APPDATA: NodePath.join(profile, "roaming"),
    LOCALAPPDATA: NodePath.join(profile, "local"),
    COMMAND_CENTER_HOME: NodePath.join(profile, "state"),
    T3CODE_DISABLE_AUTO_UPDATE: "true",
    ELECTRON_ENABLE_LOGGING: "1",
    VITE_DEV_SERVER_URL: "",
  });
  if (extended) {
    env.HOMEDRIVE = NodePath.parse(env.USERPROFILE).root.replaceAll(NodePath.sep, "");
    env.HOMEPATH = env.USERPROFILE.slice(env.HOMEDRIVE.length);
  }
  for (const directory of [
    env.USERPROFILE,
    env.APPDATA,
    env.LOCALAPPDATA,
    NodePath.join(env.COMMAND_CENTER_HOME, "userdata"),
  ])
    NodeFS.mkdirSync(directory, { recursive: true });
  if (precreateBrowserProfile)
    for (const name of ["Command Center", "command-center"])
      NodeFS.mkdirSync(NodePath.join(env.APPDATA, name), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(env.COMMAND_CENTER_HOME, "userdata", "desktop-settings.json"),
    JSON.stringify({ primaryBackendMode: "remote", remoteBackendUrl: endpoint }),
  );
  return env;
}
async function run(
  artifact,
  mode,
  extended = false,
  debug = false,
  plain = false,
  applicationCwd = false,
  launchFlags,
  precreateBrowserProfile = false,
  explicitBrowserProfile = false,
) {
  const env = profileEnvironment(extended, precreateBrowserProfile);
  const actualFlags = [...(launchFlags ?? (plain ? [] : flags))];
  if (explicitBrowserProfile)
    actualFlags.unshift(`--user-data-dir=${NodePath.join(env.APPDATA, "command-center")}`);
  const cwd = applicationCwd ? NodePath.dirname(artifact.executable) : process.cwd();
  const record = {
    artifactRunId: artifact.runId,
    mode,
    startedAt: new Date().toISOString(),
    environmentKeys: Object.keys(env).sort(),
    flags: actualFlags,
    precreatedBrowserProfile: precreateBrowserProfile,
    explicitBrowserProfile,
    cwd,
    startupLog: "",
    windowOpened: false,
    requestsStart: evidence.requests.length,
  };
  evidence.launches.push(record);
  const symbolCache = NodePath.join(root, "symbols");
  const symbolPath = `srv*${symbolCache}*https://msdl.microsoft.com/download/symbols;srv*${symbolCache}*https://symbols.electronjs.org`;
  const capture =
    ".echo PAIRING_NATIVE_EXCEPTION_FIRST_CHANCE_ORIGIN; .lastevent; .exr -1; .ecxr; ln @rip; k 30; lm; q";
  const commands = `.printf "PAIRING_DEBUGGEE_PID=%d\\n", @$tpid; .lines -e; sxe -c "${capture}" bpe; sxe -c "${capture}" av; sx; g`;
  const child = NodeChildProcess.spawn(
    debug ? debuggerPath : artifact.executable,
    debug
      ? [
          "-G",
          "-noshell",
          "-nosqm",
          "-y",
          symbolPath,
          "-c",
          commands,
          artifact.executable,
          ...actualFlags,
        ]
      : actualFlags,
    { env, cwd, stdio: ["ignore", "pipe", "pipe"], shell: false },
  );
  record.processId = child.pid;
  let browser;
  let combined = "";
  const append = (data) => {
    combined += data.toString();
    record.startupLog = combined.slice(-120000);
    const pid = combined.match(/PAIRING_DEBUGGEE_PID=(\d+)/);
    if (pid) record.debuggeeProcessId = Number(pid[1]);
    save();
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  const exit = new Promise((resolve) => {
    child.once("error", (error) => {
      record.error = String(error);
      resolve();
    });
    child.once("exit", (code, signal) => {
      record.exitCode = code;
      record.exitSignal = signal;
      record.exitedAt = new Date().toISOString();
      resolve();
    });
  });
  let timer;
  const observe = (pid, milliseconds = 45000) =>
    new Promise((resolve, reject) => {
      NodeAssert.ok(Number.isSafeInteger(pid) && pid > 0);
      NodeChildProcess.execFile(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-File",
          NodePath.resolve(
            NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
            "observe-window.ps1",
          ),
          "-ApplicationPid",
          String(pid),
          "-TimeoutMilliseconds",
          String(milliseconds),
        ],
        { env, cwd, timeout: 60000, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          if (stderr) record.observerError = (record.observerError || "") + stderr;
          if (error) reject(error);
          else {
            try {
              resolve(JSON.parse(stdout.trim()));
            } catch (error) {
              reject(error);
            }
          }
        },
      );
    });
  try {
    if (plain) {
      record.nativeWindowObservation = await observe(child.pid);
      record.windowOpened = record.nativeWindowObservation.visibleWindows.length > 0;
    } else if (debug) {
      await Promise.race([
        exit,
        new Promise((resolve) => {
          timer = setTimeout(() => {
            record.timeout = true;
            child.kill();
            resolve();
          }, 240000);
        }),
      ]);
    } else {
      const debugEndpoint = await Promise.race([
        exit.then(() => null),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), 45000);
          const check = () => {
            const match = combined.match(/DevTools listening on (ws:\/\/[^\s]+)/);
            if (match) resolve(match[1]);
          };
          child.stdout.on("data", check);
          child.stderr.on("data", check);
        }),
      ]);
      clearTimeout(timer);
      if (debugEndpoint) {
        record.rendererDebuggerStartedAt = new Date().toISOString();
        browser = await chromium.connectOverCDP(debugEndpoint, { timeout: 20000 });
        const page = await new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), 30000);
          const check = (page) =>
            page
              .waitForURL("commandcenter://app/**", { timeout: 30000 })
              .then(() => resolve(page))
              .catch(() => {});
          browser.contexts()[0].on("page", check);
          browser.contexts()[0].pages().forEach(check);
        });
        clearTimeout(timer);
        if (page) {
          record.windowOpened = true;
          record.windowOpenedAt = new Date().toISOString();
          record.platform = await page.evaluate(() => window.desktopBridge.getClientPlatform());
          await page.screenshot({ path: NodePath.join(root, `${artifact.runId}-${mode}.png`) });
        }
      }
    }
  } catch (error) {
    record.error = String(error);
  } finally {
    clearTimeout(timer);
    if (browser) {
      browser
        .newBrowserCDPSession()
        .then((session) => session.send("Browser.close"))
        .catch(() => {});
    }
    const hasExited = () => child.exitCode !== null || child.signalCode !== null;
    if (!hasExited() && !record.error) {
      await Promise.race([
        exit,
        new Promise((resolve) => {
          timer = setTimeout(() => {
            record.forcedShutdown = true;
            child.kill();
            resolve();
          }, 5000);
        }),
      ]);
    } else if (!hasExited()) child.kill();
    clearTimeout(timer);
    if (!hasExited())
      await Promise.race([
        exit,
        new Promise((resolve) => {
          timer = setTimeout(resolve, 3000);
        }),
      ]);
    clearTimeout(timer);
    NodeAssert.ok(
      hasExited(),
      "Captured diagnostic process must exit before resetting its profile",
    );
    if (debug && record.debuggeeProcessId) {
      record.debuggeeExitObservation = await observe(record.debuggeeProcessId, 1000);
      NodeAssert.equal(
        record.debuggeeExitObservation.processExited,
        true,
        "Captured native debuggee must exit before profile reset",
      );
    }
    record.requests = evidence.requests.slice(record.requestsStart);
    record.finishedAt = new Date().toISOString();
    save();
  }
}
async function runControl(extended, launchFlags = []) {
  const env = profileEnvironment(extended);
  const directory = NodePath.join(root, "control-app");
  NodeFS.mkdirSync(directory, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(directory, "package.json"),
    JSON.stringify({ name: "synthetic-runtime-control", version: "1.0.0", main: "main.cjs" }),
  );
  NodeFS.copyFileSync(
    NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "electron-control.cjs"),
    NodePath.join(directory, "main.cjs"),
  );
  const record = {
    mode:
      (extended ? "standard-windows-environment" : "original-minimal-environment") +
      (launchFlags.length ? "-original-launch-flags" : ""),
    flags: launchFlags,
    executableSha256: sha256(NodeFS.readFileSync(controlExecutable)),
    environmentKeys: Object.keys(env).sort(),
    stages: [],
  };
  (evidence.upstreamControls ||= []).push(record);
  for (const stage of ["write", "read"]) {
    const receiptPath = NodePath.join(root, `upstream-control-${record.mode}-${stage}.json`);
    const result = { stage, startedAt: new Date().toISOString(), startupLog: "" };
    record.stages.push(result);
    const child = NodeChildProcess.spawn(controlExecutable, [directory, ...launchFlags], {
      env: { ...env, CC_DIAGNOSTIC_STAGE: stage, CC_DIAGNOSTIC_RECEIPT: receiptPath },
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    result.processId = child.pid;
    const append = (data) => {
      result.startupLog = (result.startupLog + data.toString()).slice(-20000);
      save();
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    let timer;
    const exited = new Promise((resolve) => {
      child.once("error", (error) => {
        result.error = String(error);
        resolve();
      });
      child.once("exit", (code, signal) => {
        result.exitCode = code;
        result.exitSignal = signal;
        resolve();
      });
    });
    await Promise.race([
      exited,
      new Promise((resolve) => {
        timer = setTimeout(() => {
          result.timeout = true;
          child.kill();
          resolve();
        }, 60000);
      }),
    ]);
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      await Promise.race([
        exited,
        new Promise((resolve) => {
          timer = setTimeout(resolve, 5000);
        }),
      ]);
      clearTimeout(timer);
    }
    result.finishedAt = new Date().toISOString();
    if (NodeFS.existsSync(receiptPath))
      result.receipt = JSON.parse(NodeFS.readFileSync(receiptPath, "utf8"));
    save();
    NodeAssert.ok(
      child.exitCode !== null || child.signalCode !== null,
      "Captured upstream control must exit before profile reset",
    );
    if (result.receipt?.result !== "passed" || result.exitCode !== 0) break;
  }
}
try {
  const focused = process.env.FOCUSED_NATIVE_DIAGNOSIS === "true";
  evidence.focusedNativeDiagnosis = focused;
  if (focused) {
    for (const artifact of artifacts) await run(artifact, "original-minimal-environment");
    for (const artifact of artifacts)
      await run(
        artifact,
        "explicit-isolated-browser-profile",
        false,
        false,
        false,
        false,
        flags,
        false,
        true,
      );
  } else {
    for (const artifact of artifacts)
      await run(artifact, "ordinary-launch-original-environment", false, false, true);
    for (const artifact of artifacts) await run(artifact, "original-minimal-environment");
    for (const artifact of artifacts) await run(artifact, "standard-windows-environment", true);
    for (const artifact of artifacts)
      await run(artifact, "application-working-directory", false, false, false, true);
    for (const artifact of artifacts.toReversed())
      await run(artifact, "ordinary-launch-reversed-order", false, false, true);
    for (const [mode, isolatedFlags, plain] of [
      ["renderer-debugger-only", ["--remote-debugging-port=0"], false],
      ["gpu-disabled-only", ["--disable-gpu"], true],
      ["verbose-logging-only", ["--enable-logging=stderr", "--v=1"], true],
    ])
      for (const artifact of artifacts)
        await run(artifact, mode, false, false, plain, false, isolatedFlags);
    for (const artifact of artifacts)
      await run(artifact, "precreated-browser-profile", false, false, false, false, flags, true);
  }
  if (controlExecutable && NodeFS.existsSync(controlExecutable)) {
    await runControl(false);
    await runControl(true);
    await runControl(false, flags);
  } else evidence.upstreamControlUnavailable = true;
  if (debuggerPath && NodeFS.existsSync(debuggerPath)) {
    for (const artifact of artifacts.filter((artifact) =>
      evidence.launches.some(
        (launch) =>
          launch.artifactRunId === artifact.runId &&
          launch.mode === "original-minimal-environment" &&
          !launch.windowOpened,
      ),
    ))
      await run(artifact, "native-debugger-original-environment", false, true);
  } else evidence.nativeDebuggerUnavailable = true;
  evidence.result = "comparison-completed";
} catch (error) {
  evidence.result = "diagnostic-failed";
  evidence.error = String(error);
  process.exitCode = 1;
} finally {
  server.closeAllConnections();
  server.close();
  evidence.finishedAt = new Date().toISOString();
  save();
  console.log(
    JSON.stringify({
      result: evidence.result,
      launches: evidence.launches.map(({ artifactRunId, mode, windowOpened, exitCode, error }) => ({
        artifactRunId,
        mode,
        windowOpened,
        exitCode,
        error,
      })),
    }),
  );
}
