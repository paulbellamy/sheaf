import { z } from "zod";

import { getBackend } from "@/lib/mcp/backend/stub";
import { respondError } from "@/lib/mcp/errors";
import { assertThreadId } from "@/lib/mcp/paths";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

const draftBodySchema = z.object({
  new_md: z.string().max(1_000_000),
  name: z.string().min(1).max(256).optional(),
});

const draftOptionSchema = z.object({
  name: z.string().min(1).max(256),
  new_md: z.string().max(1_000_000),
});

const bodySchema = z.object({
  message: z.string().min(1).max(10_000).optional(),
  draft: draftBodySchema.optional(),
  draft_options: z.array(draftOptionSchema).min(2).max(8).optional(),
  author: z
    .string()
    .regex(/^[a-zA-Z0-9._@:\- ]{1,64}$/)
    .optional(),
});

/**
 * Phase F: attach an α-style payload (one or more proposed leaves) to an
 * existing thread. Mirrors the `AttachDraftPayload` MCP tool so the UI's
 * remix `add option` action (Phase J) and any client-side option attachment
 * can reach the same backend primitive without going through MCP.
 */
export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  try {
    assertThreadId(id);
  } catch (e) {
    return respondError(e);
  }
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return Response.json(
      {
        error: "invalid body",
        details: parsed.error.issues.map((i) => ({
          path: i.path,
          message: i.message,
        })),
      },
      { status: 400 },
    );
  }
  const body = parsed.data;
  // Reject "both missing" / "both set" early so the response shape is the
  // 400 a UI caller expects rather than an invalid_payload bubbling out of
  // the backend as a 500-ish in some routes. Backend re-validates anyway.
  const hasDraft = body.draft !== undefined;
  const hasOptions =
    body.draft_options !== undefined && body.draft_options.length > 0;
  if (!hasDraft && !hasOptions) {
    return Response.json(
      { error: "must provide `draft` or `draft_options`" },
      { status: 400 },
    );
  }
  if (hasDraft && hasOptions) {
    return Response.json(
      {
        error:
          "must provide either `draft` (1 leaf) or `draft_options` (>1); not both",
      },
      { status: 400 },
    );
  }
  try {
    await getBackend().attachDraftPayload(id, {
      message: body.message,
      draft: body.draft,
      draft_options: body.draft_options,
      author: body.author ?? "user",
    });
    return Response.json({ ok: true }, { status: 201 });
  } catch (e) {
    return respondError(e);
  }
}
