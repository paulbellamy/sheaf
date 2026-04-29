import { getBackend } from "@/lib/mcp/backend/stub";
import { respondError } from "@/lib/mcp/errors";
import { assertThreadId } from "@/lib/mcp/paths";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Phase J: remix flow. Flips an accepted (or archived) thread back to `open`
 * and appends a `current` leaf — a snapshot of the current draft prose for
 * the thread's primary target — so reviewers can compare past options
 * against the current state. New counter-proposals attach via the existing
 * `/threads/<id>/payload` route (Phase F).
 */
export async function POST(_req: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  try {
    assertThreadId(id);
  } catch (e) {
    return respondError(e);
  }
  try {
    await getBackend().reopenThread(id);
    return Response.json({ ok: true });
  } catch (e) {
    return respondError(e);
  }
}
