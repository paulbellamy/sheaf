import { getBackend } from "@/lib/mcp/backend/stub";
import { respondError } from "@/lib/mcp/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const backend = getBackend();
  try {
    const workspaces = await backend.listWorkspaces();
    const docs: {
      path: string;
      title: string;
      workspace: string;
      updated_at: number;
    }[] = [];
    for (const ws of workspaces) {
      const wsDocs = await backend.listDocs(ws.name);
      for (const d of wsDocs) {
        docs.push({
          path: d.path,
          title: d.title,
          workspace: ws.name,
          updated_at: d.updated_at,
        });
      }
    }
    docs.sort((a, b) => b.updated_at - a.updated_at);

    const allDrafts = await backend.listDrafts();
    const active = allDrafts.filter(
      (d) => d.state === "open" || d.state === "submitted",
    );
    const drafts = await Promise.all(
      active.map(async (d) => {
        const changes = await backend.draftChanges(d.draft_id);
        const changedPaths = changes.map((c) => c.path);
        const primaryPath = changedPaths.includes(d.base_path)
          ? d.base_path
          : (changedPaths[0] ?? d.base_path);
        return {
          draft_id: d.draft_id,
          base_path: d.base_path,
          primary_path: primaryPath,
          changed_paths: changedPaths,
          name: d.name,
          state: d.state,
          author: d.author,
          workspace: primaryPath.split("/")[1] ?? "",
          created_at: d.created_at,
        };
      }),
    );
    drafts.sort((a, b) => b.created_at - a.created_at);

    return Response.json({ docs, drafts });
  } catch (e) {
    return respondError(e);
  }
}
