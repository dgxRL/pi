/**
 * Reduced from packages/coding-agent/src/core/settings-manager.ts — only the
 * settings the session startup actually consumes, backed by an optional JSON
 * file in the agent dir. Missing or malformed files fall back to defaults.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { ThinkingLevel } from "../../agent/src/index.ts";

export interface Settings {
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: ThinkingLevel;
	defaultTools?: string[];
}

export function getSettingsPath(agentDir: string): string {
	return join(agentDir, "settings.json");
}

export function loadSettings(agentDir: string): Settings {
	const path = getSettingsPath(agentDir);
	if (!existsSync(path)) {
		return {};
	}
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Settings;
		return {
			defaultProvider: parsed.defaultProvider,
			defaultModel: parsed.defaultModel,
			defaultThinkingLevel: parsed.defaultThinkingLevel,
			defaultTools: parsed.defaultTools,
		};
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`Warning: failed to parse ${path} (${message}); using default settings`);
		return {};
	}
}

export function saveSettings(agentDir: string, settings: Settings): void {
	writeFileSync(getSettingsPath(agentDir), `${JSON.stringify(settings, null, "\t")}\n`);
}
