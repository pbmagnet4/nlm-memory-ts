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

// One bundle per (entry, outDir). Pi's extension is bundled to plugin-pi/scripts/
// because pi loads it as a TypeScript extension module (`pi -e <path>`), not as
// a Claude-style hooks.json command. Keeping it sibling to plugin/ mirrors the
// per-runtime layout.
const TARGETS = [
  { entry: "src/hook/prompt-recall-hook.ts", outDir: "plugin/scripts", outName: "prompt-recall-hook.mjs", banner: true },
  { entry: "src/hook/stop-hook.ts", outDir: "plugin/scripts", outName: "stop-hook.mjs", banner: true },
  { entry: "src/hook/pi-extension.ts", outDir: "nlm", outName: "index.js", banner: false },
];

const results = await Promise.all(
  TARGETS.map(async (t) => {
    const entryPath = resolve(REPO_ROOT, t.entry);
    const outFile = resolve(REPO_ROOT, t.outDir, t.outName);
    mkdirSync(dirname(outFile), { recursive: true });
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
      banner: t.banner ? { js: "#!/usr/bin/env node" } : undefined,
      tsconfig: resolve(REPO_ROOT, "tsconfig.json"),
    });
    return { entry: t.entry, outFile, warnings: result.warnings.length };
  }),
);

for (const r of results) {
  process.stdout.write(`bundled ${r.entry} -> ${r.outFile.replace(REPO_ROOT + "/", "")}`);
  if (r.warnings > 0) process.stdout.write(` (${r.warnings} warnings)`);
  process.stdout.write("\n");
}
