import { listDocsAndDrafts } from "sheaf-server";
import { backend, respond } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  return respond(() => listDocsAndDrafts(backend()));
}
