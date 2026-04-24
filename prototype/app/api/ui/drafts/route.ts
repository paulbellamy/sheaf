import { getBackend } from "@/lib/mcp/backend/stub";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const backend = getBackend();
  const drafts = await backend.listDrafts();
  return Response.json({ drafts });
}
