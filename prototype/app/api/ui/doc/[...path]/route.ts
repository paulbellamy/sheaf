import { getBackend } from "@/lib/mcp/backend/stub";
import { McpError } from "@/lib/mcp/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const { path } = await ctx.params;
  const p = path.join("/");
  const url = new URL(req.url);
  const ref = url.searchParams.get("ref") ?? "main";
  const backend = getBackend();
  try {
    const { md } = await backend.readDoc(p, ref);
    return Response.json({ path: p, ref, md });
  } catch (e) {
    if (e instanceof McpError && e.code === "doc_not_found") {
      return Response.json({ error: e.message }, { status: 404 });
    }
    if (e instanceof McpError && e.code === "invalid_path") {
      return Response.json({ error: e.message }, { status: 400 });
    }
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 500 });
  }
}
