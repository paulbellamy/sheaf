import { resolveThread } from "sheaf-server";
import { backend, respond } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  return respond(() =>
    resolveThread(backend(), {
      id,
      optionIndex: url.searchParams.get("option_index"),
      skipApply: url.searchParams.get("apply") === "false",
    }),
  );
}
