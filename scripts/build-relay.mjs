#!/usr/bin/env node
/**
 * Bundle the standalone relay into a single ESM file (out/relay/relay.mjs) so
 * the desktop app can host it as a managed child process — no repo checkout,
 * no server/node_modules required at runtime.
 */
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outFile = path.join(root, "out", "relay", "relay.mjs");

mkdirSync(path.dirname(outFile), { recursive: true });

await build({
  entryPoints: [path.join(root, "server", "src", "index.ts")],
  outfile: outFile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  logLevel: "warning",
  // ws optionally requires these native accelerators; keep them external so the
  // bundle stays portable — ws falls back to its JS implementation.
  external: ["bufferutil", "utf-8-validate"],
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
});

console.log(`[relay] bundled → ${path.relative(root, outFile)}`);
