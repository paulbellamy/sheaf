import { createDraft, listDrafts } from "sheaf-server";
import { backend, respond } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  return respond(() => listDrafts(backend()));
}

export async function POST(req: Request): Promise<Response> {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  return respond(() => createDraft(backend(), { body: json }));
}
