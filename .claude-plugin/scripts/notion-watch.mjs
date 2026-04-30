#!/usr/bin/env node
// Polls Notion comments on a page and emits one JSON line per comment
// event to stdout. Intended as the stdin of Claude Code's `Monitor`
// tool so an idle agent wakes on each event.
//
// Three event kinds, all matching Notion's webhook envelope
// (https://developers.notion.com/reference/webhooks-events-delivery)
// with an `x_sheaf` extension carrying the (last-known) comment body:
//
//   - comment.created   new comment seen on the page
//   - comment.updated   body of a known comment changed
//   - comment.deleted   previously seen comment is gone (deleted or
//                       its discussion was resolved — Notion's API
//                       only lists un-resolved comments)
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
//
// Optional: NOTION_WORKSPACE_ID populates the envelope's workspace_id.

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
import { randomUUID } from "node:crypto";

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

const workspaceId = process.env.NOTION_WORKSPACE_ID ?? null;
const known = loadKnown();
let started = known.size > 0;

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
    const current = parseComments(result).filter((c) => c.id);
    const currentIds = new Set(current.map((c) => c.id));

    for (const c of current) {
      const prev = known.get(c.id);
      if (!prev) {
        known.set(c.id, snapshotOf(c));
        if (started) emit(commentEvent("comment.created", c));
        continue;
      }
      // prev.body === null means a legacy state file knew the id but
      // not its body — refresh the snapshot silently.
      if (prev.body === null) {
        known.set(c.id, snapshotOf(c));
        continue;
      }
      if (prev.body !== (c.body ?? "")) {
        known.set(c.id, snapshotOf(c));
        if (started) emit(commentEvent("comment.updated", c));
      }
    }

    for (const [id, prev] of known) {
      if (currentIds.has(id)) continue;
      known.delete(id);
      if (started) emit(commentEvent("comment.deleted", { id, ...prev }));
    }

    started = true;
    persistKnown();
    backoffMs = POLL_MS;
  } catch (err) {
    process.stderr.write(
      `poll failed: ${err.message}; retry in ${backoffMs}ms\n`,
    );
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  }
  await sleep(backoffMs);
}

function commentEvent(type, c) {
  const parentId = c.parent_block_id ?? null;
  const parentType = c.parent_block_id ? "block" : null;
  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    workspace_id: workspaceId,
    type,
    authors: c.author_id ? [{ id: c.author_id, type: "person" }] : [],
    attempt_number: 1,
    entity: { id: c.id, type: "comment" },
    data: {
      page_id: pageId,
      parent: parentId ? { id: parentId, type: parentType } : null,
    },
    x_sheaf: {
      source: "polling",
      discussion_id: c.discussion_id ?? null,
      body: c.body ?? "",
    },
  };
}

function snapshotOf(c) {
  return {
    body: c.body ?? "",
    discussion_id: c.discussion_id ?? null,
    parent_block_id: c.parent_block_id ?? null,
    author_id: c.author_id ?? null,
  };
}

function emit(event) {
  process.stdout.write(JSON.stringify(event) + "\n");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function loadKnown() {
  const map = new Map();
  if (!existsSync(stateFile)) return map;
  let raw;
  try {
    raw = JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    return map;
  }
  // v2 shape: { version: 2, comments: { id: snapshot } }
  if (raw && raw.version === 2 && raw.comments && typeof raw.comments === "object") {
    for (const [id, snap] of Object.entries(raw.comments)) {
      map.set(id, {
        body: snap.body ?? "",
        discussion_id: snap.discussion_id ?? null,
        parent_block_id: snap.parent_block_id ?? null,
        author_id: snap.author_id ?? null,
      });
    }
    return map;
  }
  // Legacy: bare array of ids (903b6a9), or { comments: [ids], ... } (b0fad5a).
  // body=null is a sentinel meaning "id known, snapshot unknown" — the first
  // poll fills it silently rather than firing a synthetic comment.updated.
  const ids = Array.isArray(raw)
    ? raw
    : raw && Array.isArray(raw.comments)
      ? raw.comments
      : [];
  for (const id of ids) {
    if (typeof id === "string") {
      map.set(id, { body: null, discussion_id: null, parent_block_id: null, author_id: null });
    }
  }
  return map;
}

function persistKnown() {
  const comments = {};
  for (const [id, snap] of known) comments[id] = snap;
  writeFileSync(stateFile, JSON.stringify({ version: 2, comments }));
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
