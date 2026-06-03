import { readDoc } from "sheaf-server";
import { backend, respond } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const { path } = await ctx.params;
  const url = new URL(req.url);
  const ref = url.searchParams.get("ref") ?? "main";
  return respond(() => readDoc(backend(), { path: path.join("/"), ref }));
}
