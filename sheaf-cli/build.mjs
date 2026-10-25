// esbuild bundle for the `sheaf` CLI.
//
// A single esbuild pass: node platform, first-party TypeScript bundled into one
// file. Specifics the CLI needs:
//   - `format: "esm"` + `target: "node20"` (CI runs Node 20; sources use
//     extensionless ESM imports, so `node --strip-types` is a non-starter).
//   - `banner` injects the shebang so `bin/sheaf.js` is directly executable.
//   - `define` inlines the package version, so the shipped binary carries its
//     version with zero runtime file reads (see src/version.ts).
//
// Externalization is deliberate and NOT `packages: "external"`. The workspace
// dep `sheaf-server` publishes extensionless *.ts from `src/` — Node cannot
// import that at runtime, so it MUST be bundled (esbuild follows the pnpm
// symlink and transpiles the TS). Everything else — sheaf-server's own runtime
// deps (@modelcontextprotocol/sdk, fastify, yaml) and zod — stays external
// and resolves from the install next to `bin/`. Those packages are declared in
// this package's `dependencies` precisely so they resolve there under pnpm's
// strict node_modules layout. Each dep is externalized as both the bare name
// and a `/*` wildcard so subpath imports (e.g.
// `@modelcontextprotocol/sdk/server/mcp.js`) are externalized too.
import { chmodSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import esbuild from "esbuild";

const root = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const outfile = join(root, "bin", "sheaf.js");

const external = Object.keys(pkg.dependencies ?? {})
  .filter((dep) => dep !== "sheaf-server")
  .flatMap((dep) => [dep, `${dep}/*`]);

await esbuild.build({
  entryPoints: [join(root, "src", "main.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external,
  banner: { js: "#!/usr/bin/env node" },
  // Replaced with a string literal at build time (see src/version.ts).
  define: { __SHEAF_VERSION__: JSON.stringify(pkg.version) },
  logLevel: "info",
});

// Make the bundle directly runnable (`./bin/sheaf.js`) and usable as the `bin`
// target — writeFile from esbuild does not set the executable bit.
chmodSync(outfile, 0o755);

console.log(`built ${outfile} (v${pkg.version})`);
