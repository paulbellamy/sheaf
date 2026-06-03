import { docVersions } from "sheaf-server";
import { backend, respond } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  const { path } = await ctx.params;
  return respond(() => docVersions(backend(), { path: path.join("/") }));
}
