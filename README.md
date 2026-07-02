# sheaf

Comment on a doc, agent edits inline. pnpm monorepo with three packages:

- [`sheaf-server`](sheaf-server) — shared backend, MCP server, and HTTP API. No build step; consumed as TypeScript source by the other two.
- [`obsidian-plugin`](obsidian-plugin) — Obsidian plugin that embeds the server. See its [README](obsidian-plugin/README.md) for vault install and usage.
- [`prototype`](prototype) — Next.js web prototype.

## Build

```sh
pnpm install     # once, from the repo root
pnpm -r build    # builds the Obsidian plugin (main.js) and the Next app
```

Or per package:

```sh
pnpm --filter sheaf-obsidian build
pnpm --filter prototype build
```

## Checks

```sh
pnpm -r typecheck
pnpm -r test
```
