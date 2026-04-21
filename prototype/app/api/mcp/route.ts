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

async function handle(request: Request): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = buildServer();
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close().catch(() => {});
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
