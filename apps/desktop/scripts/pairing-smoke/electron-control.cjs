const { app, BrowserWindow, safeStorage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.COMMAND_CENTER_HOME;
const receiptPath = process.env.CC_DIAGNOSTIC_RECEIPT;
const stage = process.env.CC_DIAGNOSTIC_STAGE;
if (!root || !receiptPath || !["write", "read"].includes(stage))
  throw new Error("Synthetic control setup required");
const userData = path.join(root, "electron-control-userdata");
const sessionData = path.join(root, "electron-control-sessiondata");
for (const directory of [userData, sessionData]) fs.mkdirSync(directory, { recursive: true });
app.setPath("userData", userData);
app.setPath("sessionData", sessionData);
const receipt = {
  stage,
  processId: process.pid,
  runtimeVersions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  startedAt: new Date().toISOString(),
  productionAccess: false,
  syntheticProfile: true,
  security: { sandbox: true, contextIsolation: true, nodeIntegration: false },
};
const save = () => fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
save();
app
  .whenReady()
  .then(async () => {
    receipt.readyAt = new Date().toISOString();
    const window = new BrowserWindow({
      width: 600,
      height: 400,
      show: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    await window.loadURL(
      "data:text/html,<html><body>Synthetic Windows runtime control</body></html>",
    );
    receipt.windowLoadedAt = new Date().toISOString();
    receipt.encryptionAvailable = safeStorage.isEncryptionAvailable();
    if (!receipt.encryptionAvailable) throw new Error("Windows safeStorage unavailable");
    const cipherPath = path.join(root, "electron-control-cipher.bin");
    const synthetic = "synthetic-windows-control-value-not-a-credential";
    if (stage === "write") {
      fs.writeFileSync(cipherPath, safeStorage.encryptString(synthetic));
      receipt.encryptedFixtureWritten = true;
    } else {
      receipt.crossProcessRoundTrip =
        safeStorage.decryptString(fs.readFileSync(cipherPath)) === synthetic;
      if (!receipt.crossProcessRoundTrip) throw new Error("Synthetic storage roundtrip failed");
    }
    receipt.result = "passed";
    receipt.finishedAt = new Date().toISOString();
    save();
    app.quit();
  })
  .catch((error) => {
    receipt.result = "failed";
    receipt.error = String(error);
    receipt.finishedAt = new Date().toISOString();
    save();
    app.exit(1);
  });
