// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import { validateReleaseAssets } from "./validate-release-assets.ts";

function writeAsset(directory: string, fileName: string, contents = fileName): number {
  const path = NodePath.join(directory, fileName);
  NodeFS.writeFileSync(path, contents);
  return NodeFS.statSync(path).size;
}

function writeManifest(
  directory: string,
  fileName: string,
  version: string,
  assets: ReadonlyArray<{ readonly name: string; readonly size: number }>,
): void {
  NodeFS.writeFileSync(
    NodePath.join(directory, fileName),
    [
      `version: '${version}'`,
      "files:",
      ...assets.flatMap((asset) => [
        `  - url: ${asset.name}`,
        "    sha512: fixture",
        `    size: ${asset.size}`,
      ]),
      "releaseDate: '2026-07-31T00:00:00.000Z'",
      "",
    ].join("\n"),
  );
}

it("validates the complete stable desktop release matrix and manifest paths", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "command-center-assets-"));
  try {
    const version = "1.0.0";
    const assets = [
      `Command-Center-${version}-arm64.dmg`,
      `Command-Center-${version}-x64.dmg`,
      `Command-Center-${version}-arm64.zip`,
      `Command-Center-${version}-x64.zip`,
      `Command-Center-${version}-x64.AppImage`,
      `Command-Center-${version}-x64.exe`,
    ].map((name) => ({ name, size: writeAsset(directory, name) }));
    writeAsset(directory, `Command-Center-${version}-x64.exe.blockmap`);

    writeManifest(directory, "latest-mac.yml", version, assets.slice(0, 4));
    writeManifest(directory, "latest-linux.yml", version, [assets[4]!]);
    writeManifest(directory, "latest.yml", version, [assets[5]!]);

    assert.doesNotThrow(() => validateReleaseAssets({ directory, version }));
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

it("rejects an updater manifest that references a missing asset", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "command-center-assets-"));
  try {
    const version = "1.0.0";
    const assets = [
      `Command-Center-${version}-arm64.dmg`,
      `Command-Center-${version}-x64.dmg`,
      `Command-Center-${version}-arm64.zip`,
      `Command-Center-${version}-x64.zip`,
      `Command-Center-${version}-x64.AppImage`,
      `Command-Center-${version}-x64.exe`,
    ];
    for (const asset of assets) writeAsset(directory, asset);
    writeAsset(directory, `Command-Center-${version}-x64.exe.blockmap`);

    writeManifest(directory, "latest-mac.yml", version, []);
    writeManifest(directory, "latest-linux.yml", version, []);
    writeManifest(directory, "latest.yml", version, [{ name: "missing.exe", size: 1 }]);

    assert.throws(() => validateReleaseAssets({ directory, version }));
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});
