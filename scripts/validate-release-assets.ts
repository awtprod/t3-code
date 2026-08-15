// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { parseUpdateManifest } from "./lib/update-manifest.ts";

export interface ValidateReleaseAssetsOptions {
  readonly directory: string;
  readonly version: string;
}

function requireAsset(files: ReadonlySet<string>, fileName: string): void {
  if (!files.has(fileName)) {
    throw new Error(`Release asset '${fileName}' is missing.`);
  }
}

function requireArchAsset(
  files: ReadonlyArray<string>,
  version: string,
  arch: "arm64" | "x64",
  extension: ".dmg" | ".zip" | ".AppImage" | ".exe",
): void {
  const expected = `Command-Center-${version}-${arch}${extension}`;
  if (!files.includes(expected)) {
    throw new Error(`Release asset '${expected}' is missing.`);
  }
}

export function validateReleaseAssets(options: ValidateReleaseAssetsOptions): void {
  const directory = NodePath.resolve(options.directory);
  const fileNames = NodeFS.readdirSync(directory).filter(
    (fileName) => !NodeFS.statSync(NodePath.join(directory, fileName)).isDirectory(),
  );
  const files = new Set(fileNames);

  requireArchAsset(fileNames, options.version, "arm64", ".dmg");
  requireArchAsset(fileNames, options.version, "x64", ".dmg");
  requireArchAsset(fileNames, options.version, "arm64", ".zip");
  requireArchAsset(fileNames, options.version, "x64", ".zip");
  requireArchAsset(fileNames, options.version, "x64", ".AppImage");
  requireArchAsset(fileNames, options.version, "x64", ".exe");

  const channel = options.version.includes("-nightly.") ? "nightly" : "latest";
  const manifests = [`${channel}-mac.yml`, `${channel}-linux.yml`, `${channel}.yml`];
  for (const manifestName of manifests) {
    requireAsset(files, manifestName);
    const manifestPath = NodePath.join(directory, manifestName);
    const manifest = parseUpdateManifest(
      NodeFS.readFileSync(manifestPath, "utf8"),
      manifestPath,
      manifestName,
    );
    if (manifest.version !== options.version) {
      throw new Error(
        `Update manifest '${manifestName}' has version '${manifest.version}', expected '${options.version}'.`,
      );
    }

    for (const entry of manifest.files) {
      const assetName = NodePath.basename(new URL(entry.url, "https://updates.invalid/").pathname);
      requireAsset(files, assetName);
      const actualSize = NodeFS.statSync(NodePath.join(directory, assetName)).size;
      if (entry.size !== actualSize) {
        throw new Error(
          `Update manifest '${manifestName}' reports ${entry.size} bytes for '${assetName}', but the asset is ${actualSize} bytes.`,
        );
      }
    }
  }

  if (!fileNames.some((fileName) => fileName.endsWith(".blockmap"))) {
    throw new Error("Release assets are missing updater blockmaps.");
  }
}

function readArgument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) {
    throw new Error(`Missing required argument ${name}.`);
  }
  return value;
}

if (process.argv[1]?.endsWith("validate-release-assets.ts")) {
  validateReleaseAssets({
    directory: readArgument("--directory"),
    version: readArgument("--version"),
  });
}
