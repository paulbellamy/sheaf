import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only the pure modules are unit-tested here. The Obsidian-glue files
    // (main.ts, views/*, *-host) import `obsidian`, which has no node build,
    // so they're typecheck-only — keep tests off them by convention (test
    // files live next to the pure modules they cover, e.g. src/acp/*.test.ts).
    include: ["src/**/*.test.ts"],
  },
});
