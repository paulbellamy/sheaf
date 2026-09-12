// esbuild bundle for the `sheaf` CLI.
//
// Mirrors the obsidian-plugin build conventions: a single esbuild pass, node
// platform, first-party TypeScript bundled into one file. Differences that the
// CLI needs:
//   - `format: "esm"` + `target: "node20"` (CI runs Node 20; sources use
//     extensionless ESM imports, so `node --strip-types` is a non-starter).
//   - `banner` injects the shebang so `bin/sheaf.js` is directly executable.
//   - `packages: "external"` keeps node_modules deps (zod, sheaf-server, the
//     MCP SDK added in later steps) out of the bundle; they resolve at runtime
//     from the install. Only our own `src/*.ts` is bundled.
//   - `define` inlines the package version, so the shipped binary carries its
//     version with zero runtime file reads.
import { chmodSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import esbuild from "esbuild";

const root = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const outfile = join(root, "bin", "sheaf.js");

await esbuild.build({
  entryPoints: [join(root, "src", "main.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  // node_modules deps stay external; first-party `./` imports get bundled.
  packages: "external",
  banner: { js: "#!/usr/bin/env node" },
  // Replaced with a string literal at build time (see src/version.ts).
  define: { __SHEAF_VERSION__: JSON.stringify(pkg.version) },
  logLevel: "info",
});

// Make the bundle directly runnable (`./bin/sheaf.js`) and usable as the `bin`
// target — writeFile from esbuild does not set the executable bit.
chmodSync(outfile, 0o755);

console.log(`built ${outfile} (v${pkg.version})`);
