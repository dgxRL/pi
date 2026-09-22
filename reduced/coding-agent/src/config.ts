/**
 * Reduced from packages/coding-agent/src/config.ts (579 lines) — the constants
 * and agent-dir resolution the CLI needs. Dropped: install-method detection,
 * self-update commands, package-asset paths, share URLs.
 */

import { homedir } from "os";
import { join } from "path";

export const APP_NAME: string = "pi";
export const VERSION: string = "0.0.0-reduced";
export const CONFIG_DIR_NAME: string = ".pi";

// e.g., PI_CODING_AGENT_DIR
export const ENV_AGENT_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`;

/** Get the agent config directory (e.g., ~/.pi/agent/). Env override may use ~. */
export function getAgentDir(): string {
	const envDir = process.env[ENV_AGENT_DIR];
	if (envDir) {
		if (envDir === "~") return homedir();
		if (envDir.startsWith("~/")) return join(homedir(), envDir.slice(2));
		return envDir;
	}
	return join(homedir(), CONFIG_DIR_NAME, "agent");
}
