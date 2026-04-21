import { getBackend } from "@/lib/mcp/backend/stub";
import { McpError } from "@/lib/mcp/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type PostBody = {
  path: string;
  targets: { char_range: { from: number; to: number } }[];
  message: string;
  draft?: { new_md: string };
};

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const p = url.searchParams.get("path") ?? undefined;
  const ref = url.searchParams.get("ref") ?? "main";
  try {
    const threads = await getBackend().listThreads({ path: p, ref });
    return Response.json({ path: p, ref, threads });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const ref = url.searchParams.get("ref") ?? "main";
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  if (
    !body.path ||
    !body.message ||
    !Array.isArray(body.targets) ||
    body.targets.length === 0
  ) {
    return Response.json(
      { error: "body must include path, message, and at least one target" },
      { status: 400 },
    );
  }
  try {
    const id = await getBackend().addThread({
      ref,
      author: "user",
      message: body.message,
      draft: body.draft,
      targets: body.targets.map((t) => ({
        path: body.path,
        char_range: t.char_range,
      })),
    });
    return Response.json({ thread_id: id }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

function errorResponse(e: unknown): Response {
  if (e instanceof McpError) {
    const status =
      e.code === "doc_not_found" || e.code === "draft_not_found"
        ? 404
        : e.code === "invalid_path" || e.code === "invalid_ref"
          ? 400
          : 500;
    return Response.json({ error: e.message, code: e.code }, { status });
  }
  const msg = e instanceof Error ? e.message : String(e);
  return Response.json({ error: msg }, { status: 500 });
}
