/**
 * Build the standalone compiled binary (dist/sarma).
 *
 * The version is injected via --define: compiled binaries have no adjacent
 * package.json for src/index.ts to read at runtime.
 */

import { $ } from "bun";

const version = ((await Bun.file("package.json").json()) as { version: string }).version;
const define = `SARMA_VERSION=${JSON.stringify(version)}`;

await $`bun build src/index.ts --compile --outfile dist/sarma --no-compile-autoload-bunfig --define ${define}`;
console.log(`dist/sarma (${version})`);
