#!/usr/bin/env node
// Polls Notion comments on a page and emits one compact JSON line per
// *new* comment to stdout. Intended as the stdin of Claude Code's
// `Monitor` tool so an idle agent wakes on each comment.
//
// Usage:
//   node .claude-plugin/scripts/notion-watch.mjs <page_id_or_url>
//
// Auth (in order of preference):
//   1. NOTION_TOKEN env var — spawns @notionhq/notion-mcp-server over
//      stdio with that integration secret.
//   2. ~/.config/mcp/auth/notion.json — the OAuth bearer Claude Code
//      already holds for the hosted Notion MCP. Used when NOTION_TOKEN
//      is unset; talks to https://mcp.notion.com/mcp over HTTP.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const rawArg = process.argv[2];
const pageId = rawArg ? parsePageId(rawArg) : null;
if (!pageId) {
  process.stderr.write("usage: notion-watch.mjs <page_id_or_url>\n");
  process.exit(2);
}

const POLL_MS = 10_000;
const MAX_BACKOFF_MS = 60_000;
const stateFile = `.context/notion-seen-${pageId}.json`;
mkdirSync(dirname(stateFile), { recursive: true });

const seen = new Set(loadSeen());

const transport = selectTransport();

const client = new Client(
  { name: "sheaf-notion-watcher", version: "0.2.0" },
  { capabilities: {} },
);

try {
  await client.connect(transport);
} catch (err) {
  if (isUnauthorized(err)) {
    process.stderr.write(
      "Claude MCP Notion token rejected — run `claude mcp` to re-auth, or set NOTION_TOKEN.\n",
    );
    process.exit(2);
  }
  throw err;
}

const getCommentsTool = await findGetCommentsTool();
const idArgName = pickIdArg(getCommentsTool);
const extraArgs = {};
const commentsProps = getCommentsTool.inputSchema?.properties ?? {};
if ("include_all_blocks" in commentsProps) extraArgs.include_all_blocks = true;

const shutdown = async () => {
  try {
    await client.close();
  } catch {}
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

let backoffMs = POLL_MS;

while (true) {
  try {
    const result = await client.callTool({
      name: getCommentsTool.name,
      arguments: { [idArgName]: pageId, ...extraArgs },
    });
    if (result.isError) {
      throw new Error(`tool error: ${textOf(result)}`);
    }
    for (const comment of parseComments(result)) {
      if (!comment.id || seen.has(comment.id)) continue;
      seen.add(comment.id);
      process.stdout.write(
        JSON.stringify({
          kind: "comment_created",
          page_id: pageId,
          comment_id: comment.id,
          discussion_id: comment.discussion_id ?? null,
          parent_block_id: comment.parent_block_id ?? null,
          author_id: comment.author_id ?? null,
          body: comment.body ?? "",
        }) + "\n",
      );
    }
    persistSeen();
    backoffMs = POLL_MS;
  } catch (err) {
    process.stderr.write(
      `poll failed: ${err.message}; retry in ${backoffMs}ms\n`,
    );
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  }
  await sleep(backoffMs);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function loadSeen() {
  if (!existsSync(stateFile)) return [];
  try {
    return JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    return [];
  }
}

function persistSeen() {
  writeFileSync(stateFile, JSON.stringify([...seen]));
}

async function findGetCommentsTool() {
  const { tools } = await client.listTools();
  const candidates = ["notion-get-comments", "get-comments", "retrieve-comments"];
  for (const name of candidates) {
    const t = tools.find((tt) => tt.name === name);
    if (t) return t;
  }
  const fuzzy = tools.find((t) => /comments?/.test(t.name) && /get|list|retrieve/.test(t.name));
  if (fuzzy) return fuzzy;
  throw new Error(
    `notion-mcp-server exposes no comment-listing tool. Available: ${tools
      .map((t) => t.name)
      .join(", ")}`,
  );
}

function parsePageId(input) {
  const dashed = input.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  );
  if (dashed) return dashed[0].toLowerCase();
  const hex = input.match(/[0-9a-f]{32}/i);
  if (hex) {
    const h = hex[0].toLowerCase();
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  return null;
}

function pickIdArg(tool) {
  const props = tool.inputSchema?.properties ?? {};
  for (const candidate of ["page_id", "block_id", "id", "url"]) {
    if (props[candidate]) return candidate;
  }
  const keys = Object.keys(props);
  if (keys.length === 1) return keys[0];
  throw new Error(
    `cannot determine id arg for ${tool.name}; schema keys: ${keys.join(", ")}`,
  );
}

function textOf(result) {
  return (result.content ?? [])
    .map((c) => (c.type === "text" ? c.text : ""))
    .filter(Boolean)
    .join("\n");
}

function parseComments(result) {
  const text = textOf(result);
  if (!text) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  // Hosted Notion MCP wraps an XML <discussions> blob inside {"text": "..."}.
  if (parsed && typeof parsed.text === "string" && /<discussion\b/.test(parsed.text)) {
    return parseDiscussionsXml(parsed.text);
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.results)
      ? parsed.results
      : Array.isArray(parsed.comments)
        ? parsed.comments
        : [];
  return list.map((c) => ({
    id: c.id,
    discussion_id: c.discussion_id,
    parent_block_id:
      c.parent?.block_id ?? c.parent?.page_id ?? c.block_id ?? c.page_id,
    author_id: c.created_by?.id ?? c.author?.id,
    body: extractBody(c),
  }));
}

function parseDiscussionsXml(blob) {
  const out = [];
  const discussionRe = /<discussion\b([^>]*)>([\s\S]*?)<\/discussion>/g;
  let dm;
  while ((dm = discussionRe.exec(blob))) {
    const dAttrs = parseXmlAttrs(dm[1]);
    const parts = parseDiscussionUri(dAttrs.id);
    const inner = dm[2];
    const commentRe = /<comment\b([^>]*)>([\s\S]*?)<\/comment>/g;
    let cm;
    while ((cm = commentRe.exec(inner))) {
      const cAttrs = parseXmlAttrs(cm[1]);
      out.push({
        id: cAttrs.id,
        discussion_id: parts.discussionId,
        parent_block_id: parts.blockId,
        author_id: parseUserUri(cAttrs["user-url"]),
        body: decodeXmlEntities(cm[2]).trim(),
      });
    }
  }
  return out;
}

function parseXmlAttrs(s) {
  const out = {};
  const re = /([\w-]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = m[2];
  return out;
}

function parseDiscussionUri(s) {
  const m = String(s ?? "").match(/^discussion:\/\/([^/]+)\/([^/]+)\/(.+)$/);
  return m ? { pageId: m[1], blockId: m[2], discussionId: m[3] } : {};
}

function parseUserUri(s) {
  const m = String(s ?? "").match(/^user:\/\/(.+)$/);
  return m ? m[1] : null;
}

function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function extractBody(c) {
  if (typeof c.body === "string") return c.body;
  if (Array.isArray(c.rich_text)) {
    return c.rich_text.map((rt) => rt.plain_text ?? "").join("");
  }
  return "";
}

function selectTransport() {
  if (process.env.NOTION_TOKEN) {
    return new StdioClientTransport({
      command: "npx",
      args: ["-y", "@notionhq/notion-mcp-server"],
      env: { ...process.env },
    });
  }

  const authFile = join(homedir(), ".config", "mcp", "auth", "notion.json");
  if (!existsSync(authFile)) {
    process.stderr.write(
      `no NOTION_TOKEN set and no ${authFile} — set NOTION_TOKEN or run \`claude mcp\` to authorize Notion.\n`,
    );
    process.exit(2);
  }

  let auth;
  try {
    auth = JSON.parse(readFileSync(authFile, "utf8"));
  } catch (err) {
    process.stderr.write(`failed to read ${authFile}: ${err.message}\n`);
    process.exit(2);
  }

  if (!auth.access_token || !auth.resource) {
    process.stderr.write(
      `${authFile} missing access_token or resource — run \`claude mcp\` to re-auth.\n`,
    );
    process.exit(2);
  }

  if (typeof auth.expires_at === "number" && auth.expires_at * 1000 <= Date.now()) {
    process.stderr.write(
      "Claude MCP Notion token expired — run `claude mcp` to re-auth, or set NOTION_TOKEN.\n",
    );
    process.exit(2);
  }

  return new StreamableHTTPClientTransport(new URL(auth.resource), {
    requestInit: {
      headers: { Authorization: `Bearer ${auth.access_token}` },
    },
  });
}

function isUnauthorized(err) {
  if (!err) return false;
  if (err.name === "UnauthorizedError") return true;
  const msg = String(err.message ?? "");
  return /\b401\b|unauthorized/i.test(msg);
}
