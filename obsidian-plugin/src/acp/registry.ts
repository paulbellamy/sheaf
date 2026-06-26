/**
 * The curated set of ACP agents the plugin can spawn. Every adapter reduces to
 * "run a command over stdio", so an entry is just that command plus display
 * metadata — no per-agent config system. ACP has no native Claude Code or Codex
 * agent; these are the Zed-maintained adapters that wrap each CLI in ACP.
 *
 * Auth is the adapter's problem: each reuses its CLI's existing login, so the
 * plugin spawns the command and (if a session needs it) surfaces ACP
 * `authenticate` — it never handles API keys here.
 */

export interface AcpAgentSpec {
  /** Stable id used in settings. */
  id: string;
  /** Shown in the agent picker. */
  displayName: string;
  /** Executable to spawn (resolved on PATH, or an absolute path). */
  command: string;
  /** Arguments passed to the command. */
  args: string[];
  /** Extra environment for the child process. */
  env?: Record<string, string>;
  /** Shown when the command isn't found, so the user can install it. */
  installHint: string;
}

export const ACP_AGENTS: readonly AcpAgentSpec[] = [
  {
    id: "claude-code",
    displayName: "Claude Code",
    command: "npx",
    args: ["-y", "@zed-industries/claude-code-acp"],
    installHint: "npm install -g @zed-industries/claude-code-acp",
  },
  {
    id: "codex",
    displayName: "Codex",
    command: "npx",
    args: ["-y", "@zed-industries/codex-acp"],
    installHint: "npm install -g @zed-industries/codex-acp",
  },
];

export const DEFAULT_ACP_AGENT_ID = ACP_AGENTS[0].id;

/** Look up an agent spec by id, or undefined if unknown. */
export function getAcpAgent(id: string): AcpAgentSpec | undefined {
  return ACP_AGENTS.find((a) => a.id === id);
}
