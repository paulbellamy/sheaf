import { attachPayload } from "sheaf-server";
import { backend, respond } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  return respond(() => attachPayload(backend(), { id, body: json }));
}
