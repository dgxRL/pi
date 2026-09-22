/**
 * Reduced barrel: public exports of the standalone coding-agent extraction,
 * plus the CLI main() entry. Reduced from packages/coding-agent/src/main.ts
 * (980 lines) — everything but the print branch, argument plumbing, and the
 * persisted-vs-in-memory session choice is dropped (TUI, RPC, auth/package
 * subcommands, session fork/resume/continue, extensions, trust, resource loading).
 */

import { readFileSync } from "fs";

import { parseArgs, printHelp } from "./args.ts";
import { APP_NAME, VERSION, getAgentDir } from "./config.ts";
import { createAgentSession } from "./core/sdk.ts";
import { SessionManager } from "./core/session-manager.ts";
import { runPrintMode } from "./modes/print-mode.ts";
import { loadSettings } from "./settings.ts";

export { parseArgs, printHelp, type Args, type Mode } from "./args.ts";
export { APP_NAME, CONFIG_DIR_NAME, ENV_AGENT_DIR, VERSION, getAgentDir } from "./config.ts";
export { DEFAULT_THINKING_LEVEL, THINKING_LEVEL_OPTIONS } from "./core/defaults.ts";
export { getSettingsPath, loadSettings, saveSettings, type Settings } from "./settings.ts";
export * from "./core/agent-session.ts";
export { createAgentSession, type CreateAgentSessionOptions, type CreateAgentSessionResult } from "./core/sdk.ts";
export {
	SessionManager,
	buildSessionContext,
	getDefaultSessionDir,
	type FileEntry,
	type SessionContext,
} from "./core/session-manager.ts";
export { createAllTools, createCodingTools, createReadOnlyTools, wrapToolDefinition, type ToolDefinition } from "./core/tools/index.ts";
export { runPrintMode, type PrintModeOptions } from "./modes/print-mode.ts";
export { toJsonEvent, type JsonAgentSessionEvent } from "./modes/json-event.ts";

/**
 * CLI entry: parse args, build a session (persisted or in-memory), run print
 * mode, and reflect the exit code on the process.
 */
export async function main(argv: string[]): Promise<void> {
	try {
		const parsed = parseArgs(argv);
		if (parsed.help) {
			printHelp();
			return;
		}
		if (parsed.version) {
			console.log(`${APP_NAME} v${VERSION}`);
			return;
		}

		const settings = loadSettings(getAgentDir());
		const cwd = process.cwd();
		const sessionManager = parsed.noSession
			? SessionManager.inMemory(cwd)
			: SessionManager.create(cwd);

		// Recombine provider + model into the "provider/model" string the SDK resolves.
		const provider = parsed.provider ?? settings.defaultProvider;
		const model = parsed.model ?? settings.defaultModel;
		const modelArg = model && provider && !model.includes("/") ? `${provider}/${model}` : model;

		const { session } = await createAgentSession({
			cwd,
			sessionManager,
			apiKey: parsed.apiKey,
			model: modelArg,
			thinkingLevel: parsed.thinking ?? settings.defaultThinkingLevel,
			tools: parsed.tools ?? settings.defaultTools,
			excludeTools: parsed.excludeTools,
			noTools: parsed.noTools,
			systemPrompt: parsed.systemPrompt,
			appendSystemPrompt:
				parsed.appendSystemPrompt.length > 0 ? parsed.appendSystemPrompt.join("\n") : undefined,
		});

		const messages = [...parsed.messages];
		for (const fileArg of parsed.fileArgs) {
			messages.push(readFileSync(fileArg, "utf8"));
		}

		const exitCode = await runPrintMode(session, { mode: parsed.mode, messages });
		if (exitCode !== 0) {
			process.exitCode = exitCode;
		}
	} catch (error: unknown) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
