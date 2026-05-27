#!/usr/bin/env node
/**
 * Bundles each hook entry under src/hook/ as a single-file .mjs into
 * plugin/scripts/, ready for Codex to invoke via ${CLAUDE_PLUGIN_ROOT}.
 *
 * Why single-file bundles: Codex plugins are content-addressed by file hash
 * for the trust system. Shipping a tree of imports would force the user to
 * re-trust every release across dozens of files. One file per hook keeps
 * the trust footprint minimal.
 *
 * Why esbuild not tsc: tsc emits a tree of files with relative imports; the
 * plugin would have to ship `dist/` plus its dependency tree. esbuild flattens
 * to one .mjs per entry with all internal deps inlined. node builtins are
 * left as-is (node:*) and zero runtime deps are bundled because the hook
 * scripts only talk to the daemon over HTTP — no native bindings required.
 */

import { build } from "esbuild";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const OUT_DIR = resolve(REPO_ROOT, "plugin/scripts");

const ENTRIES = [
  "src/hook/prompt-recall-hook.ts",
  "src/hook/stop-hook.ts",
];

mkdirSync(OUT_DIR, { recursive: true });

const results = await Promise.all(
  ENTRIES.map(async (entry) => {
    const entryPath = resolve(REPO_ROOT, entry);
    const outName = entry.split("/").pop().replace(/\.ts$/, ".mjs");
    const outFile = resolve(OUT_DIR, outName);
    const result = await build({
      entryPoints: [entryPath],
      outfile: outFile,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      minify: false,
      sourcemap: false,
      legalComments: "none",
      logLevel: "warning",
      banner: { js: "#!/usr/bin/env node" },
      tsconfig: resolve(REPO_ROOT, "tsconfig.json"),
    });
    return { entry, outFile, warnings: result.warnings.length };
  }),
);

for (const r of results) {
  process.stdout.write(`bundled ${r.entry} -> ${r.outFile.replace(REPO_ROOT + "/", "")}`);
  if (r.warnings > 0) process.stdout.write(` (${r.warnings} warnings)`);
  process.stdout.write("\n");
}
