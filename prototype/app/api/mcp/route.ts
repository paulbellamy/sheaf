import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { buildServer } from "@/lib/mcp/server";

/**
 * MCP server route for sheaf.
 *
 * Transport is MCP Streamable HTTP, the current canonical HTTP transport.
 * Runs stateless (sessionIdGenerator=undefined) — every request reconstructs
 * a fresh server/transport pair. The Backend is module-scoped so on-disk
 * state carries across requests without needing MCP-level session context.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type JsonRpcEnvelope = {
  method?: unknown;
  id?: unknown;
  params?: { name?: unknown } | unknown;
};

function describeEnvelope(body: unknown): string {
  const entries = Array.isArray(body) ? body : [body];
  const parts: string[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const env = entry as JsonRpcEnvelope;
    const method = typeof env.method === "string" ? env.method : "?";
    const id =
      typeof env.id === "string" || typeof env.id === "number"
        ? String(env.id)
        : "-";
    let tool = "";
    if (
      method === "tools/call" &&
      env.params &&
      typeof env.params === "object"
    ) {
      const name = (env.params as { name?: unknown }).name;
      if (typeof name === "string") tool = ` tool=${name}`;
    }
    parts.push(`method=${method}${tool} id=${id}`);
  }
  return parts.length > 0 ? parts.join(", ") : "method=-";
}

async function handle(request: Request): Promise<Response> {
  const started = performance.now();
  const ua = request.headers.get("user-agent") ?? "-";
  const session = request.headers.get("mcp-session-id") ?? "-";
  let rpc = "method=-";
  try {
    const body = await request.clone().json();
    rpc = describeEnvelope(body);
  } catch {
    // GET/DELETE or non-JSON body — leave rpc as default.
  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = buildServer();
  await server.connect(transport);
  let status = 0;
  try {
    const response = await transport.handleRequest(request);
    status = response.status;
    return response;
  } finally {
    await server.close().catch(() => {});
    const ms = Math.round(performance.now() - started);
    console.info(
      `${request.method} /api/mcp ${status} in ${ms}ms — ${rpc} ua=${JSON.stringify(ua)} session=${session}`,
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}

export async function GET(request: Request): Promise<Response> {
  return handle(request);
}

export async function DELETE(request: Request): Promise<Response> {
  return handle(request);
}
