/**
 * Runs the engine benchmark the way production runs the engine.
 *
 * `npm run bench` measures the engine through vitest's module evaluator, which
 * wraps module namespaces in a Proxy and defines named exports as accessors.
 * execute.ts reads the imported MONTHS as every inner loop's bound and the
 * imported SCRATCH_* as offsets inside them, so those loops pay a trapped
 * property load per iteration and the reported cost is ~10x the truth.
 *
 * The production renderer is rollup-bundled, where those imports collapse to
 * real constants. So: bundle the bench entry with vite exactly as production
 * bundles the engine, then run it on plain node.
 *
 * See src/shared/engine/__bench__/prodBench.ts for the measured numbers behind
 * that claim.
 */

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const entry = path.join(repoRoot, "src/shared/engine/__bench__/prodBench.ts");
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "kairos-bench-"));

(async () => {
  // vite is ESM-only from v5, so pull it in dynamically from this CJS script.
  const { build } = await import("vite");

  await build({
    root: repoRoot,
    logLevel: "error",
    configFile: false,
    build: {
      outDir,
      emptyOutDir: true,
      minify: false,
      target: "node20",
      // ssr mode bundles for node and skips the browser-only shims; the module
      // graph collapses to real bindings, which is the entire point.
      ssr: entry,
      rollupOptions: { output: { format: "es", entryFileNames: "prodBench.mjs" } },
    },
  });

  const bundled = path.join(outDir, "prodBench.mjs");
  console.log("\n  Engine benchmark — production bundling (not vitest)\n");
  const run = spawnSync(process.execPath, [bundled], { stdio: "inherit" });

  fs.rmSync(outDir, { recursive: true, force: true });
  process.exit(run.status ?? 1);
})().catch((err) => {
  fs.rmSync(outDir, { recursive: true, force: true });
  console.error(err);
  process.exit(1);
});
