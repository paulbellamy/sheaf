/**
 * The CLI version string.
 *
 * The esbuild bundle replaces the `__SHEAF_VERSION__` token with a string
 * literal (via `define`, sourced from package.json "version") at build time, so
 * the shipped `bin/sheaf.js` carries its version with zero runtime file reads.
 *
 * Under `tsc` / `vitest` the token is never substituted, so we fall back to
 * reading package.json off disk. `typeof __SHEAF_VERSION__` is a safe probe:
 * referencing an undeclared identifier with `typeof` yields "undefined" rather
 * than throwing, and after the build the token is a string literal that esbuild
 * constant-folds — dropping the fallback branch (and its fs import) entirely.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

declare const __SHEAF_VERSION__: string;

function readPackageVersion(): string {
  try {
    // src/version.ts → the package root is one directory up.
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(join(here, "..", "package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION: string =
  typeof __SHEAF_VERSION__ !== "undefined"
    ? __SHEAF_VERSION__
    : readPackageVersion();
