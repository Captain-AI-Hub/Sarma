/**
 * Build the standalone compiled binary (dist/sarma).
 *
 * Uses the programmatic Bun.build API so the @opentui/solid transform plugin
 * runs at build time — the CLI `bun build` does not load bunfig preloads, and
 * without the plugin every .tsx compiles to eager jsxDEV calls, freezing the
 * TUI after the first frame. The version is injected via `define`: compiled
 * binaries have no adjacent package.json for src/index.ts to read at runtime.
 * `autoloadBunfig: false` keeps the binary from reading a dev bunfig.toml
 * when run from inside the repo.
 */

import solidPlugin from "@opentui/solid/bun-plugin";

const version = ((await Bun.file("package.json").json()) as { version: string }).version;

const result = await Bun.build({
  entrypoints: ["src/index.ts"],
  target: "bun",
  plugins: [solidPlugin],
  define: { SARMA_VERSION: JSON.stringify(version) },
  compile: {
    outfile: "dist/sarma",
    autoloadBunfig: false,
  },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`dist/sarma (${version})`);
