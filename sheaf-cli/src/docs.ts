/**
 * `sheaf docs` — list the vault's documents.
 *
 * The smoke exemplar of the client core's REST path (docs/sheaf-cli-v0.1.md
 * "Wire protocol"): a read that the daemon already exposes over REST at
 * `GET /api/ui/docs`. Step 6 fills in the rest of the read/thread verbs (most
 * reads go over MCP, the `--as ui` mutations over REST) using the same
 * {@link connectDaemon} seam; this one lands early because it proves the whole
 * REST round-trip end to end.
 */
import { connectDaemon, requireDaemonAllowed } from "./client";
import type { RunContext } from "./commands";
import { EXIT, type ExitCode } from "./io";

/** One doc entry as returned by `GET /api/ui/docs`. */
interface DocEntry {
  path: string;
  title?: string;
  folder?: string;
  updated_at?: number;
}

interface DocsResponse {
  docs: DocEntry[];
}

/** `run` handler for `sheaf docs`. */
export async function docsCommand(ctx: RunContext): Promise<ExitCode> {
  requireDaemonAllowed(ctx.globals, "sheaf docs");

  const client = await connectDaemon(ctx.vault, ctx.io.env);
  try {
    const body = await client.rest<DocsResponse>("GET", "/api/ui/docs");
    const docs = Array.isArray(body.docs) ? body.docs : [];

    if (ctx.out.format === "json") {
      ctx.out.json({ docs });
      return EXIT.OK;
    }

    if (docs.length === 0) {
      ctx.out.text("(no documents)");
      return EXIT.OK;
    }
    for (const doc of docs) {
      ctx.out.text(doc.path);
    }
    return EXIT.OK;
  } finally {
    await client.close();
  }
}
