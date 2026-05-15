import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * CORS for /api/ui/* and /api/mcp/*.
 *
 * The Obsidian plugin renderer (origin `app://obsidian.md`) uses native
 * `fetch` for the SSE stream — `requestUrl` doesn't support streaming
 * responses, so the SSE path can't bypass CORS the way the other plugin
 * calls do. Prototype is localhost-only; `*` is fine here.
 */
export function middleware(req: NextRequest): NextResponse {
  if (req.method === "OPTIONS") {
    return new NextResponse(null, {
      status: 204,
      headers: corsHeaders(),
    });
  }
  const res = NextResponse.next();
  for (const [k, v] of Object.entries(corsHeaders())) {
    res.headers.set(k, v);
  }
  return res;
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, accept",
    "Access-Control-Max-Age": "86400",
  };
}

export const config = {
  matcher: ["/api/ui/:path*", "/api/mcp/:path*"],
};
