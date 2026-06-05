import { reopenThread } from "sheaf-server";
import { backend, respond } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  return respond(() => reopenThread(backend(), { id }));
}
