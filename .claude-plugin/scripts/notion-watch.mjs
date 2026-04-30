#!/usr/bin/env node
// Polls a Notion page directly via the Notion REST API and emits one
// JSON line per event to stdout. Intended as the stdin of Claude Code's
// `Monitor` tool so an idle agent wakes on each event.
//
// Four event kinds, all shaped to match Notion's webhook envelope
// (https://developers.notion.com/reference/webhooks-events-delivery)
// with an `x_sheaf` extension carrying inline content snapshots:
//
//   - page.content_updated   one per debounced burst of block edits
//   - comment.created        one per new comment, no debounce
//   - comment.updated        one per edited comment, no debounce
//   - comment.deleted        one per removed/resolved comment, no debounce
//
// Note: Notion's list-comments endpoint returns only un-resolved comments,
// so `comment.deleted` also fires when a discussion is resolved.
//
// Usage:
//   node .claude-plugin/scripts/notion-watch.mjs <page_id_or_url>
//
// Auth: NOTION_TOKEN env var. Must be a Notion integration token (internal
// integration secret or a public integration's OAuth access_token issued
// directly by Notion) — these authenticate against api.notion.com. The
// OAuth bearer Claude Code holds for the hosted MCP at mcp.notion.com is
// scoped to that service only and will not work here.
//
// Optional: NOTION_WORKSPACE_ID populates the envelope's workspace_id.
// Tunables: SHEAF_POLL_MS, SHEAF_DEBOUNCE_QUIET_MS, SHEAF_DEBOUNCE_MAX_MS,
// SHEAF_MAX_BACKOFF_MS.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const rawArg = process.argv[2];
const pageId = rawArg ? parsePageId(rawArg) : null;
if (!pageId) {
  process.stderr.write("usage: notion-watch.mjs <page_id_or_url>\n");
  process.exit(2);
}

const POLL_MS           = num("SHEAF_POLL_MS",           10_000);
const DEBOUNCE_QUIET_MS = num("SHEAF_DEBOUNCE_QUIET_MS",  5_000);
const DEBOUNCE_MAX_MS   = num("SHEAF_DEBOUNCE_MAX_MS",   30_000);
const MAX_BACKOFF_MS    = num("SHEAF_MAX_BACKOFF_MS",    60_000);

if (!process.env.NOTION_TOKEN) {
  process.stderr.write(
    "NOTION_TOKEN is not set. Create a Notion internal integration\n" +
    "(Settings → Integrations → New internal integration), grant it page\n" +
    "access via the page's Connections menu, then export NOTION_TOKEN=ntn_...\n",
  );
  process.exit(2);
}

const NOTION = "https://api.notion.com/v1";
const HEADERS = {
  "Authorization": `Bearer ${process.env.NOTION_TOKEN}`,
  "Notion-Version": "2022-06-28",
  "Content-Type": "application/json",
};

const stateFile = `.context/notion-seen-${pageId}.json`;
mkdirSync(dirname(stateFile), { recursive: true });

const state = loadState();
const commentSnapshot = new Map(Object.entries(state.comments));
const blockSnapshot = new Map(Object.entries(state.blocks));

const buffer = {
  blocks: new Map(),
  authors: new Set(),
  firstChangeAt: 0,
  lastChangeAt: 0,
};

const workspaceId = await resolveWorkspaceId();

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

let backoffMs = POLL_MS;

while (true) {
  try {
    await pollOnce();
    backoffMs = POLL_MS;
  } catch (err) {
    process.stderr.write(
      `poll failed: ${err.message}; retry in ${backoffMs}ms\n`,
    );
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  }
  await sleep(backoffMs);
}

async function pollOnce() {
  const page = await notion(`/pages/${pageId}`);
  const pageEditedAt = page.last_edited_time;

  if (pageEditedAt !== state.page_last_edited_time) {
    const blocks = await walkBlocks(pageId);
    diffBlocksIntoBuffer(blocks);
    state.page_last_edited_time = pageEditedAt;
    rewriteBlockSnapshot(blocks);
  }

  maybeFlushPageBurst();
  await pollComments();

  if (!state.started) state.started = true;
  persistState();
}

async function walkBlocks(rootId) {
  const out = [];
  let cursor;
  do {
    const params = { page_size: 100 };
    if (cursor) params.start_cursor = cursor;
    const result = await notion(`/blocks/${rootId}/children`, params);
    for (const b of result.results ?? []) {
      out.push({
        id: b.id,
        type: b.type,
        last_edited_time: b.last_edited_time,
        last_edited_by_id: b.last_edited_by?.id ?? null,
        content: b.type ? b[b.type] ?? null : null,
      });
      if (b.has_children) {
        out.push(...await walkBlocks(b.id));
      }
    }
    cursor = result.has_more ? result.next_cursor : undefined;
  } while (cursor);
  return out;
}

function diffBlocksIntoBuffer(blocks) {
  const currentIds = new Set(blocks.map((b) => b.id));
  const deltas = [];

  for (const b of blocks) {
    const prev = blockSnapshot.get(b.id);
    if (!prev) {
      deltas.push({ ...b, action: "added" });
    } else if (prev !== b.last_edited_time) {
      deltas.push({ ...b, action: "updated" });
    }
  }
  for (const id of blockSnapshot.keys()) {
    if (!currentIds.has(id)) {
      deltas.push({
        id,
        type: null,
        last_edited_time: null,
        last_edited_by_id: null,
        content: null,
        action: "removed",
      });
    }
  }

  if (deltas.length === 0) return;
  if (!state.started) return;

  const now = Date.now();
  if (buffer.blocks.size === 0) buffer.firstChangeAt = now;
  buffer.lastChangeAt = now;

  for (const d of deltas) {
    buffer.blocks.set(d.id, {
      id: d.id,
      action: d.action,
      block_type: d.type,
      last_edited_time: d.last_edited_time,
      last_edited_by_id: d.last_edited_by_id,
      content: d.content,
    });
    if (d.last_edited_by_id) buffer.authors.add(d.last_edited_by_id);
  }
}

function rewriteBlockSnapshot(blocks) {
  blockSnapshot.clear();
  for (const b of blocks) blockSnapshot.set(b.id, b.last_edited_time);
}

function maybeFlushPageBurst() {
  if (buffer.blocks.size === 0) return;
  const now = Date.now();
  const quiet = now - buffer.lastChangeAt >= DEBOUNCE_QUIET_MS;
  const ceiling = now - buffer.firstChangeAt >= DEBOUNCE_MAX_MS;
  if (!quiet && !ceiling) return;

  emit({
    id: randomUUID(),
    timestamp: new Date(now).toISOString(),
    workspace_id: workspaceId,
    type: "page.content_updated",
    authors: [...buffer.authors].map((id) => ({ id, type: "person" })),
    attempt_number: 1,
    entity: { id: pageId, type: "page" },
    data: {
      updated_blocks: [...buffer.blocks.values()].map((b) => ({
        id: b.id,
        type: "block",
      })),
      parent: { id: pageId, type: "page" },
    },
    x_sheaf: {
      source: "polling",
      blocks: [...buffer.blocks.values()].map((b) => ({
        id: b.id,
        action: b.action,
        block_type: b.block_type,
        last_edited_time: b.last_edited_time,
        last_edited_by_id: b.last_edited_by_id,
        content: b.action === "removed" ? null : b.content,
      })),
    },
  });

  buffer.blocks.clear();
  buffer.authors.clear();
  buffer.firstChangeAt = 0;
  buffer.lastChangeAt = 0;
}

async function pollComments() {
  const fresh = new Map();
  let cursor;
  do {
    const params = { block_id: pageId, page_size: 100 };
    if (cursor) params.start_cursor = cursor;
    const result = await notion("/comments", params);
    for (const c of result.results ?? []) {
      if (!c.id) continue;
      fresh.set(c.id, c);
    }
    cursor = result.has_more ? result.next_cursor : undefined;
  } while (cursor);

  const events = [];
  for (const [id, c] of fresh) {
    const prev = commentSnapshot.get(id);
    const nextEditedAt = c.last_edited_time ?? null;
    if (!prev) {
      events.push({ kind: "live", type: "comment.created", comment: c });
    } else if ((prev.last_edited_time ?? null) !== nextEditedAt) {
      events.push({ kind: "live", type: "comment.updated", comment: c });
    }
  }
  for (const [id, prev] of commentSnapshot) {
    if (!fresh.has(id)) {
      events.push({ kind: "deleted", id, record: prev });
    }
  }

  commentSnapshot.clear();
  for (const [id, c] of fresh) commentSnapshot.set(id, snapshotRecord(c));

  if (!state.started) return;

  for (const e of events) {
    emit(
      e.kind === "deleted"
        ? buildCommentDeletedEnvelope(e.id, e.record)
        : buildCommentEnvelope(e.comment, e.type),
    );
  }
}

function snapshotRecord(c) {
  return {
    last_edited_time: c.last_edited_time ?? null,
    created_by_id: c.created_by?.id ?? null,
    created_by_type: c.created_by?.type ?? null,
    parent: commentParent(c),
    discussion_id: c.discussion_id ?? null,
    body: extractCommentBody(c),
  };
}

function commentParent(c) {
  if (c.parent?.block_id) return { id: c.parent.block_id, type: "block" };
  if (c.parent?.page_id) return { id: c.parent.page_id, type: "page" };
  return null;
}

function buildCommentEnvelope(c, type) {
  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    workspace_id: workspaceId,
    type,
    authors: c.created_by?.id
      ? [{ id: c.created_by.id, type: c.created_by.type ?? "person" }]
      : [],
    attempt_number: 1,
    entity: { id: c.id, type: "comment" },
    data: {
      page_id: pageId,
      parent: commentParent(c),
    },
    x_sheaf: {
      source: "polling",
      discussion_id: c.discussion_id ?? null,
      body: extractCommentBody(c),
    },
  };
}

function buildCommentDeletedEnvelope(id, record) {
  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    workspace_id: workspaceId,
    type: "comment.deleted",
    authors: record.created_by_id
      ? [{ id: record.created_by_id, type: record.created_by_type ?? "person" }]
      : [],
    attempt_number: 1,
    entity: { id, type: "comment" },
    data: {
      page_id: pageId,
      parent: record.parent,
    },
    x_sheaf: {
      source: "polling",
      discussion_id: record.discussion_id,
      body: record.body,
    },
  };
}

function extractCommentBody(c) {
  if (typeof c.body === "string") return c.body;
  if (Array.isArray(c.rich_text)) {
    return c.rich_text.map((rt) => rt.plain_text ?? "").join("");
  }
  return "";
}

function emit(event) {
  process.stdout.write(JSON.stringify(event) + "\n");
}

async function notion(path, params) {
  const url = new URL(`${NOTION}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`notion ${path}: ${res.status} ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function resolveWorkspaceId() {
  if (process.env.NOTION_WORKSPACE_ID) return process.env.NOTION_WORKSPACE_ID;
  let me;
  try {
    me = await notion("/users/me");
  } catch (err) {
    if (/\b401\b/.test(err.message)) {
      process.stderr.write(
        "NOTION_TOKEN was rejected by api.notion.com (401 unauthorized).\n" +
        "Note: the OAuth bearer Claude Code uses for the hosted Notion MCP\n" +
        "is scoped to mcp.notion.com and will not work here. Use a Notion\n" +
        "internal integration secret (ntn_...) instead.\n",
      );
      process.exit(2);
    }
    process.stderr.write(`workspace_id discovery failed: ${err.message}\n`);
    return null;
  }
  return me.bot?.workspace_id ?? null;
}

function loadState() {
  const defaults = {
    version: 2,
    started: false,
    page_last_edited_time: null,
    comments: {},
    blocks: {},
  };
  if (!existsSync(stateFile)) return defaults;
  let raw;
  try {
    raw = JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    return defaults;
  }
  // Legacy: top-level array of comment ids — rebaseline.
  if (Array.isArray(raw)) return defaults;
  // Legacy v1: comments stored as array of ids — rebaseline silently.
  if (Array.isArray(raw.comments)) {
    return {
      ...defaults,
      page_last_edited_time: raw.page_last_edited_time ?? null,
      blocks: raw.blocks && typeof raw.blocks === "object" ? raw.blocks : {},
    };
  }
  return {
    ...defaults,
    ...raw,
    version: 2,
    comments: raw.comments && typeof raw.comments === "object" ? raw.comments : {},
    blocks: raw.blocks && typeof raw.blocks === "object" ? raw.blocks : {},
  };
}

function persistState() {
  state.comments = Object.fromEntries(commentSnapshot);
  state.blocks = Object.fromEntries(blockSnapshot);
  writeFileSync(stateFile, JSON.stringify(state));
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

function num(envName, fallback) {
  const v = process.env[envName];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
