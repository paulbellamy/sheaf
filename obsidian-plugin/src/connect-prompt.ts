/**
 * The prompt the user pastes into a fresh `claude` session to put a
 * manually-attached MCP agent to work. Shared verbatim by the threads sidebar's
 * connect panel and the settings tab so both stay in sync.
 *
 * Pure (no `obsidian` import) so it's unit-tested; the surfaces that render it
 * are typecheck-only glue.
 */

/** Whole-vault base: watch every doc's threads and keep going until stopped. */
const BASE_PROMPT =
  "use the sheaf MCP and watch for events; action and resolve each thread as it appears, and keep handling new ones until I stop you";

/**
 * The connect prompt, optionally pointed at the doc the user is currently in.
 *
 * With a `currentDoc`, it names that doc as the starting point — mirroring the
 * ACP prompt, which names the doc its session is bound to. But it stays **less
 * restrictive** than ACP: the manual agent isn't scoped to that one doc, so the
 * prompt only says *start here* while keeping the whole-vault watch ("keep
 * handling new ones"). With no open doc it falls back to the plain whole-vault
 * prompt.
 */
export function agentConnectPrompt(currentDoc?: string | null): string {
  if (!currentDoc) return BASE_PROMPT;
  return `${BASE_PROMPT}. I'm currently working on "${currentDoc}" — start with its open threads.`;
}
