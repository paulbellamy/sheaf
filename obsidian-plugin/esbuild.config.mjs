import esbuild from "esbuild";
import process from "node:process";

const prod = process.argv[2] === "production";

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  // Node platform: the plugin bundles the sheaf server (fastify + MCP SDK +
  // backend), and runs in Obsidian's Node-enabled renderer. This keeps node
  // builtins (fs, http, crypto, …) external — provided by Electron at runtime
  // — while everything else (fastify, zod, yaml, sheaf-server) is bundled into
  // the single main.js, so the plugin stays a zero-dependency drop-in.
  platform: "node",
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
  ],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  minify: prod,
  outfile: "main.js",
});

if (prod) {
  await ctx.rebuild();
  await ctx.dispose();
} else {
  await ctx.watch();
}
