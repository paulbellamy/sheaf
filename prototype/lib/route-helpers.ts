import { type Backend, errorResult, getBackend, type HandlerResult } from "sheaf-server";

/** The shared filesystem backend (env-configured singleton). */
export function backend(): Backend {
  return getBackend();
}

/**
 * Run a shared UI handler and serialize its `{status, json}` result into a web
 * `Response`. Errors map through `errorResult` so status + shape stay
 * consistent with the Fastify routes (single source of truth in sheaf-server).
 */
export async function respond(
  run: () => Promise<HandlerResult>,
): Promise<Response> {
  try {
    const r = await run();
    return Response.json(r.json, { status: r.status });
  } catch (e) {
    const er = errorResult(e);
    return Response.json(er.json, { status: er.status });
  }
}
