#!/usr/bin/env node
// Hot-reload stress script: every 1s, rewrites the `_hot-reload test: ...`
// line in a sheaf draft to the current timestamp by calling the Edit MCP tool.
//
// Usage:
//   node scripts/hot-reload-bump.mjs \
//     --path workspaces/infra/docs/git-file-backend.md \
//     --draft draft_4967b032-225b-4ac2-a8bb-bd52269a9280
//
// Defaults target the git-file-backend draft used during hot-reload testing.
// Endpoint override: SHEAF_MCP_URL (default http://localhost:3000/api/mcp).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith("--")) acc.push([cur.slice(2), arr[i + 1]]);
    return acc;
  }, []),
);

const url = new URL(process.env.SHEAF_MCP_URL ?? "http://localhost:3000/api/mcp");
const path = args.path ?? "workspaces/infra/docs/git-file-backend.md";
const ref = args.draft ?? "draft_4967b032-225b-4ac2-a8bb-bd52269a9280";
const intervalMs = Number(args.interval ?? 1000);
const marker = /_hot-reload test: [^_\n]+_/;

const client = new Client({ name: "hot-reload-bump", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(url));

async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) throw new Error(JSON.stringify(res.content));
  const text = res.content?.[0]?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const read = await client.callTool({
  name: "Read",
  arguments: { file_path: path, ref },
});
const body = read.content?.[0]?.text ?? "";
const match = body.match(marker);
if (!match) {
  console.error(`No '_hot-reload test: ...' line in ${path}@${ref}`);
  process.exit(1);
}
let prev = match[0];
console.log(`starting from: ${prev}`);

let stopped = false;
process.on("SIGINT", () => {
  stopped = true;
  console.log("\nstopping...");
});

while (!stopped) {
  const next = `_hot-reload test: ${Date.now()}_`;
  try {
    const res = await call("Edit", {
      file_path: path,
      ref,
      old_string: prev,
      new_string: next,
    });
    console.log(`${next} -> commit=${res.commit ?? "?"}`);
    prev = next;
  } catch (err) {
    console.error(`edit failed: ${err.message}`);
  }
  await new Promise((r) => setTimeout(r, intervalMs));
}

await client.close();
