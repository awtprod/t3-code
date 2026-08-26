// @effect-diagnostics nodeBuiltinImport:off - Standalone build script, not part of the app runtime.
// @effect-diagnostics globalConsole:off - Standalone build script output.
import * as esbuild from "esbuild";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

/**
 * Bundles each sandbox binary into a single self-contained `.mjs` so the
 * container image needs no node_modules. Output names match the binaries the
 * server invokes plus the constrained `gh` shim in the workspace image.
 */
const root = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const outDir = NodePath.join(root, "dist");

const BINARIES = [
  { entry: "src/bin/preview-bridge.ts", out: "t3-preview-bridge.mjs" },
  { entry: "src/bin/egress-proxy.ts", out: "t3-egress-proxy.mjs" },
  { entry: "src/bin/credential-proxy.ts", out: "t3-credential-proxy.mjs" },
  { entry: "src/bin/github-pr.ts", out: "gh.mjs" },
] as const;

await NodeFSP.rm(outDir, { recursive: true, force: true });
await NodeFSP.mkdir(outDir, { recursive: true });

for (const binary of BINARIES) {
  await esbuild.build({
    entryPoints: [NodePath.join(root, binary.entry)],
    outfile: NodePath.join(outDir, binary.out),
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    banner: { js: "#!/usr/bin/env node" },
    legalComments: "none",
  });
  await NodeFSP.chmod(NodePath.join(outDir, binary.out), 0o755);
  console.log(`built ${binary.out}`);
}
