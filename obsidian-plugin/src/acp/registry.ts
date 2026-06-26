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
  /**
   * Map a reasoning-effort level to the env vars that apply it for this agent
   * (both adapters take effort via env, not a flag). An agent clamps levels it
   * doesn't support. Absent → the agent ignores effort.
   */
  effortEnv?: (effort: AcpEffort) => Record<string, string>;
}

/**
 * Claude Code's real reasoning-effort modes — the unified scale the UI shows.
 * Other agents clamp levels they don't support (see each spec's `effortEnv`).
 */
export type AcpEffort = "low" | "medium" | "high" | "xhigh" | "max";

export const ACP_EFFORTS: readonly AcpEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Falls back here when no level is configured (Claude's own default). */
export const DEFAULT_ACP_EFFORT: AcpEffort = "high";

export const ACP_AGENTS: readonly AcpAgentSpec[] = [
  {
    id: "claude-code",
    displayName: "Claude Code",
    command: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp"],
    installHint: "npm install -g @agentclientprotocol/claude-agent-acp",
    // CLAUDE_CODE_EFFORT_LEVEL takes precedence over every other effort source
    // and is inherited by the Claude Code process the adapter spawns. It accepts
    // all five modes (max included — max works specifically via this env var).
    effortEnv: (effort): Record<string, string> => ({
      CLAUDE_CODE_EFFORT_LEVEL: effort,
    }),
  },
  {
    id: "codex",
    displayName: "Codex",
    command: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp"],
    installHint: "npm install -g @agentclientprotocol/codex-acp",
    // codex-acp merges CODEX_CONFIG (JSON) into the Codex session config. Codex's
    // model_reasoning_effort goes up to "xhigh" (model-dependent) but has no
    // "max", so clamp only max → xhigh; everything else passes through.
    effortEnv: (effort): Record<string, string> => {
      const codexEffort = effort === "max" ? "xhigh" : effort;
      return {
        CODEX_CONFIG: JSON.stringify({ model_reasoning_effort: codexEffort }),
      };
    },
  },
];

export const DEFAULT_ACP_AGENT_ID = ACP_AGENTS[0].id;

/** Look up an agent spec by id, or undefined if unknown. */
export function getAcpAgent(id: string): AcpAgentSpec | undefined {
  return ACP_AGENTS.find((a) => a.id === id);
}
