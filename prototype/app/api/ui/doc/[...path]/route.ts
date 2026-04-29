import { getBackend } from "@/lib/mcp/backend/stub";
import { respondError } from "@/lib/mcp/errors";

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
    const { md, version_counter } = await backend.readDoc(p, ref);
    return Response.json({ path: p, ref, md, version_counter });
  } catch (e) {
    return respondError(e);
  }
}
