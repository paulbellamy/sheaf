import { addThread, listThreadsForDoc } from "sheaf-server";
import { backend, respond } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.searchParams.get("path") ?? undefined;
  const ref = url.searchParams.get("ref") ?? "main";
  return respond(() => listThreadsForDoc(backend(), { path, ref }));
}

export async function POST(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const ref = url.searchParams.get("ref") ?? "main";
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  return respond(() => addThread(backend(), { ref, body: json }));
}
