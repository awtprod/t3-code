import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as NodeEvents from "node:events";
import * as NodeOS from "node:os";

const require = NodeModule.createRequire(new URL("../../package.json", import.meta.url));
const { _electron } = require("playwright-core");
const asar = NodeModule.createRequire(require.resolve("electron-builder"))("@electron/asar");
const [executable, output, expectedCommit, expectedVersion, expectedSource] = process.argv.slice(2);
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone CI verifier measures the real host without an Effect runtime.
NodeAssert.equal(NodeOS.platform(), "win32", "This verification must execute on Windows");
NodeAssert.ok(executable && output && /^[a-f0-9]{40}$/.test(expectedCommit));
const root = NodePath.resolve(output);
NodeFS.mkdirSync(root, { recursive: true });
const resources = NodePath.join(NodePath.dirname(executable), "resources");
const appArchive = NodePath.join(resources, "app.asar");
const serverArchive = NodePath.join(resources, "server.asar");
const pkg = JSON.parse(asar.extractFile(appArchive, "package.json").toString());
NodeAssert.equal(pkg.version, expectedVersion);
NodeAssert.equal(pkg.buildVersion, expectedVersion);
NodeAssert.equal(pkg.t3codeCommitHash, expectedCommit.slice(0, 12));
const renderer = NodePath.join(root, "renderer");
const rendererFiles = [];
for (const entry of asar.listPackage(serverArchive)) {
  const normalized = entry.replaceAll("\\", "/");
  const prefix = "/apps/server/dist/client/";
  if (!normalized.startsWith(prefix)) continue;
  const archivePath = normalized.slice(1).split("/").join(NodePath.sep);
  const stat = asar.statFile(serverArchive, archivePath);
  if (stat.files) continue;
  NodeAssert.ok(!stat.link && !stat.unpacked);
  const relative = normalized.slice(prefix.length);
  NodeAssert.ok(relative && !relative.split("/").includes(".."));
  const target = NodePath.join(renderer, relative);
  NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
  NodeFS.writeFileSync(target, asar.extractFile(serverArchive, archivePath));
  rendererFiles.push(relative);
}
NodeAssert.ok(rendererFiles.includes("index.html"));
const normalize = (text) => text.replaceAll("\r\n", "\n");
const source = normalize(NodeFS.readFileSync(expectedSource, "utf8"));
let matchingMap;
for (const relative of rendererFiles.filter((file) => file.endsWith(".js.map"))) {
  const map = JSON.parse(NodeFS.readFileSync(NodePath.join(renderer, relative), "utf8"));
  for (const [index, name] of (map.sources ?? []).entries()) {
    if (!name.replaceAll("\\", "/").endsWith("/connection/registry.ts")) continue;
    NodeAssert.equal(normalize(map.sourcesContent[index]), source);
    matchingMap = relative;
  }
}
NodeAssert.ok(matchingMap, "Registry source must match the exact artifact commit");
process.env.FIXTURE_RENDERER_ROOT = renderer;
process.env.FIXTURE_ROOT = root;
process.env.FIXTURE_APP_VERSION = expectedVersion;
const { makeServer, syntheticToken, remoteId, pairingCode } = await import("./fixture-server.mjs");
const staleToken = "synthetic-pre-repair-bearer";
const records = [];
const control = { acceptedToken: staleToken };
const server = makeServer({ records, control });
await NodeEvents.once(server, "listening");
const endpoint = `http://127.0.0.1:${server.address().port}/`;
const profile = NodePath.join(root, "isolated-profile");
const state = NodePath.join(profile, "state", "userdata");
NodeFS.mkdirSync(state, { recursive: true });
NodeFS.writeFileSync(
  NodePath.join(state, "desktop-settings.json"),
  JSON.stringify({ primaryBackendMode: "remote", remoteBackendUrl: endpoint }),
);
const connectionId = `bearer:${remoteId}`;
const catalog = {
  schemaVersion: 1,
  targets: [
    {
      _tag: "BearerConnectionTarget",
      connectionId,
      environmentId: remoteId,
      label: "Fixture remote",
    },
  ],
  profiles: [
    {
      _tag: "BearerConnectionProfile",
      connectionId,
      environmentId: remoteId,
      label: "Fixture remote",
      httpBaseUrl: endpoint,
      wsBaseUrl: endpoint.replace("http:", "ws:"),
    },
  ],
  credentials: [
    { connectionId, credential: { _tag: "BearerConnectionCredential", token: staleToken } },
  ],
  remoteDpopTokens: [],
};
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      ["path", "pathext", "systemroot", "windir", "comspec", "temp", "tmp"].includes(
        key.toLowerCase(),
      ),
    ),
  ),
  USERPROFILE: NodePath.join(profile, "home"),
  APPDATA: NodePath.join(profile, "roaming"),
  LOCALAPPDATA: NodePath.join(profile, "local"),
  COMMAND_CENTER_HOME: NodePath.join(profile, "state"),
  T3CODE_DISABLE_AUTO_UPDATE: "true",
  VITE_DEV_SERVER_URL: "",
};
const evidence = {
  startedAt: new Date().toISOString(),
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Record the actual CI host platform.
  platform: NodeOS.platform(),
  executable,
  expectedCommit,
  expectedVersion,
  registrySourceSha256: NodeCrypto.createHash("sha256").update(source).digest("hex"),
  matchingMap,
  mainSha256: NodeCrypto.createHash("sha256")
    .update(
      asar.extractFile(appArchive, NodePath.join("apps", "desktop", "dist-electron", "main.cjs")),
    )
    .digest("hex"),
  launches: [],
  requests: records,
  productionAccess: false,
  syntheticProfile: true,
};
let electron;
let encryptedProbe;
const saveEvidence = () =>
  NodeFS.writeFileSync(
    NodePath.join(root, "windows-pairing-evidence.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
async function closeElectron(app) {
  let timer;
  let forced = false;
  const closing = app.close().catch((error) => {
    if (!forced) throw error;
  });
  try {
    await Promise.race([
      closing,
      new Promise((resolve) => {
        timer = setTimeout(() => {
          forced = true;
          app.process().kill("SIGKILL");
          resolve();
        }, 8000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  return forced;
}
try {
  for (const mode of ["seed", "repair-active-primary", "cold-reconnect", "cold-reopen"]) {
    if (mode === "cold-reconnect") control.rejectBearer = true;
    electron = await _electron.launch({
      executablePath: NodePath.resolve(executable),
      args: ["--disable-gpu"],
      env,
      timeout: 60000,
    });
    const page = await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Packaged application window did not open")),
        60000,
      );
      const check = (window) =>
        window
          .waitForURL("commandcenter://app/**", { timeout: 60000 })
          .then(() => {
            clearTimeout(timeout);
            resolve(window);
          })
          .catch(() => {});
      electron.on("window", check);
      electron.windows().forEach(check);
    });
    await page.waitForFunction(() => !!window.desktopBridge, { timeout: 60000 });
    page.setDefaultTimeout(30000);
    const launch = { mode, pid: electron.process().pid, startedAt: new Date().toISOString() };
    evidence.launches.push(launch);
    launch.storage = await electron.evaluate(({ app, safeStorage }) => ({
      // oxlint-disable-next-line t3code/no-global-process-runtime -- This callback executes inside the real packaged Electron process.
      platform: process.platform,
      isPackaged: app.isPackaged,
      version: app.getVersion(),
      userData: app.getPath("userData"),
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
    }));
    NodeAssert.equal(launch.storage.platform, "win32");
    NodeAssert.equal(launch.storage.isPackaged, true);
    NodeAssert.equal(launch.storage.encryptionAvailable, true);
    NodeAssert.ok(launch.storage.userData.startsWith(profile));
    if (mode === "seed") {
      encryptedProbe = await electron.evaluate(
        ({ safeStorage }, text) => safeStorage.encryptString(text).toString("base64"),
        "synthetic-dpapi-roundtrip",
      );
      NodeAssert.equal(
        await page.evaluate(
          (data) => window.desktopBridge.setConnectionCatalog(JSON.stringify(data)),
          catalog,
        ),
        true,
      );
    } else {
      launch.crossProcessSecureStorageRoundTrip = await electron.evaluate(
        ({ safeStorage }, cipher) =>
          safeStorage.decryptString(Buffer.from(cipher, "base64")) === "synthetic-dpapi-roundtrip",
        encryptedProbe,
      );
      NodeAssert.equal(launch.crossProcessSecureStorageRoundTrip, true);
      if (mode === "repair-active-primary") {
        await page.waitForFunction(() => document.body.innerText.includes("Loading Inbox"));
        await page.evaluate(() => {
          window.location.hash = "/settings/connections";
        });
        await page.getByRole("button", { name: "Add environment", exact: true }).first().click();
        const direct = page.getByRole("button", { name: "Direct connection", exact: false });
        if (await direct.count()) await direct.click();
        await page.getByLabel("Server address", { exact: true }).fill(endpoint);
        await page.getByLabel("Pairing code", { exact: true }).fill(pairingCode);
        await page.getByRole("button", { name: "Add environment", exact: true }).last().click();
        await page.getByLabel("Pairing code", { exact: true }).waitFor({ state: "hidden" });
        launch.actualUiPairingCompleted = true;
      }
      if (mode === "cold-reconnect") {
        await page
          .getByRole("button", { name: "Reconnect saved environment", exact: true })
          .waitFor();
        const start = records.length;
        control.rejectBearer = false;
        launch.buttonStartedAt = new Date().toISOString();
        await page
          .getByRole("button", { name: "Reconnect saved environment", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Reconnect saved environment", exact: true })
          .waitFor({ state: "hidden" });
        await page.waitForFunction(() => document.body.innerText.includes("Loading Inbox"));
        launch.buttonFinishedAt = new Date().toISOString();
        launch.buttonRequests = records.slice(start);
        NodeAssert.ok(
          launch.buttonRequests.some(
            (request) => request.path === "/api/auth/session" && request.syntheticBearerMatches,
          ),
        );
      }
      launch.newBearerRetained = await page.evaluate(
        async ({ token, connectionId }) => {
          const catalog = JSON.parse(await window.desktopBridge.getConnectionCatalog());
          return (
            catalog.credentials.find((entry) => entry.connectionId === connectionId)?.credential
              .token === token
          );
        },
        { token: syntheticToken, connectionId },
      );
      NodeAssert.equal(launch.newBearerRetained, true);
      if (mode !== "repair-active-primary") {
        launch.nativeBearerMatches = await page.evaluate(
          async (token) => (await window.desktopBridge.getLocalEnvironmentBearerToken()) === token,
          syntheticToken,
        );
        NodeAssert.equal(launch.nativeBearerMatches, true);
      }
      if (mode === "cold-reopen") {
        await page.waitForFunction(() => document.body.innerText.includes("Loading Inbox"));
        const recover = () =>
          page.evaluate(async (url) => {
            try {
              return await window.desktopBridge.recoverRemotePrimarySession(url);
            } catch (error) {
              return { error: String(error) };
            }
          }, endpoint);
        control.rejectBearer = true;
        NodeAssert.match((await recover()).error, /rejected the saved credential/);
        control.rejectBearer = false;
        control.descriptorId = "00000000-0000-4000-8000-000000000099";
        NodeAssert.match((await recover()).error, /does not match the saved environment/);
        control.descriptorId = null;
        control.forceCookieMethod = true;
        NodeAssert.match((await recover()).error, /rejected the saved credential/);
        control.forceCookieMethod = false;
        NodeAssert.equal((await recover()).authenticated, true);
        launch.negativeControlsPassed = true;
      }
    }
    const protectedCatalog = NodeFS.readFileSync(
      NodePath.join(state, "connection-catalog.json"),
      "utf8",
    );
    const document = JSON.parse(protectedCatalog);
    launch.catalogProtectedOnDisk =
      document.version === 1 &&
      typeof document.encryptedCatalog === "string" &&
      !protectedCatalog.includes(staleToken) &&
      !protectedCatalog.includes(syntheticToken);
    NodeAssert.equal(launch.catalogProtectedOnDisk, true);
    launch.body = (await page.locator("body").innerText()).slice(0, 2500);
    await page.screenshot({ path: NodePath.join(root, `${mode}.png`) });
    saveEvidence();
    launch.forcedShutdown = await closeElectron(electron);
    electron = null;
    launch.closedAt = new Date().toISOString();
    saveEvidence();
  }
  NodeAssert.ok(
    records.filter((request) => request.method === "UPGRADE" && request.validSyntheticTicket)
      .length >= 3,
  );
  NodeAssert.equal(
    records.some((request) => request.cookiePresent),
    false,
  );
  evidence.result = "passed";
} catch (error) {
  evidence.result = "failed";
  evidence.error = String(error);
  if (electron) {
    try {
      const page = electron.windows().at(-1);
      evidence.failureBody = await page.locator("body").innerText();
      await page.screenshot({ path: NodePath.join(root, "failure.png") });
    } catch {}
  }
  process.exitCode = 1;
} finally {
  saveEvidence();
  if (electron) {
    try {
      await closeElectron(electron);
    } catch {
      electron.process().kill();
    }
  }
  for (const socket of server.fixtureWebSockets.clients) socket.terminate();
  server.fixtureWebSockets.close();
  server.closeAllConnections();
  server.close();
  evidence.finishedAt = new Date().toISOString();
  saveEvidence();
  console.log(
    JSON.stringify({
      result: evidence.result,
      expectedCommit,
      expectedVersion,
      launches: evidence.launches.length,
      error: evidence.error,
    }),
  );
}
