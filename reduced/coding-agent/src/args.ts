/**
 * Reduced from packages/coding-agent/src/cli/args.ts (447 lines) — hand-rolled
 * parser for the single print-style CLI mode. Unknown flags are rejected with
 * a clear error instead of being collected for extensions.
 */

import type { ThinkingLevel } from "../../agent/src/index.ts";
import { APP_NAME } from "./config.ts";
import { THINKING_LEVEL_OPTIONS } from "./core/defaults.ts";

export type Mode = "text" | "json";

export interface Args {
	mode: Mode;
	print: boolean;
	help: boolean;
	version: boolean;
	noSession: boolean;
	noTools: boolean;
	provider?: string;
	model?: string;
	apiKey?: string;
	systemPrompt?: string;
	appendSystemPrompt: string[];
	thinking?: ThinkingLevel;
	tools?: string[];
	excludeTools?: string[];
	messages: string[];
	fileArgs: string[];
}

export function parseArgs(args: string[]): Args {
	const result: Args = {
		mode: "text",
		print: false,
		help: false,
		version: false,
		noSession: false,
		noTools: false,
		appendSystemPrompt: [],
		messages: [],
		fileArgs: [],
	};

	// Returns args[i + 1] and bumps i past the consumed value.
	const requireValue = (flag: string, index: number): string => {
		const value = args[index + 1];
		if (value === undefined) {
			throw new Error(`${flag} requires a value`);
		}
		return value;
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];

		if (arg === "--") {
			for (const positional of args.slice(i + 1)) {
				if (positional.startsWith("@")) {
					result.fileArgs.push(positional.slice(1));
				} else {
					result.messages.push(positional);
				}
			}
			break;
		} else if (arg === "--mode") {
			const mode = requireValue(arg, i);
			i++;
			if (mode !== "text" && mode !== "json") {
				throw new Error(`Invalid mode "${mode}". Valid values: text, json`);
			}
			result.mode = mode;
		} else if (arg === "--provider") {
			result.provider = requireValue(arg, i);
			i++;
		} else if (arg === "--model") {
			// Accept "provider/model" or a plain model id.
			const value = requireValue(arg, i);
			i++;
			const slashIndex = value.indexOf("/");
			if (slashIndex !== -1) {
				if (!result.provider) {
					result.provider = value.slice(0, slashIndex);
				}
				result.model = value.slice(slashIndex + 1);
			} else {
				result.model = value;
			}
		} else if (arg === "--api-key") {
			result.apiKey = requireValue(arg, i);
			i++;
		} else if (arg === "--system-prompt") {
			result.systemPrompt = requireValue(arg, i);
			i++;
		} else if (arg === "--append-system-prompt") {
			result.appendSystemPrompt.push(requireValue(arg, i));
			i++;
		} else if (arg === "--thinking") {
			const level = requireValue(arg, i);
			i++;
			if (!THINKING_LEVEL_OPTIONS.includes(level as ThinkingLevel)) {
				throw new Error(
					`Invalid thinking level "${level}". Valid values: ${THINKING_LEVEL_OPTIONS.join(", ")}`,
				);
			}
			result.thinking = level as ThinkingLevel;
		} else if (arg === "--tools" || arg === "-t") {
			result.tools = requireValue(arg, i)
				.split(",")
				.map((s) => s.trim())
				.filter((name) => name.length > 0);
			i++;
		} else if (arg === "--exclude-tools") {
			result.excludeTools = requireValue(arg, i)
				.split(",")
				.map((s) => s.trim())
				.filter((name) => name.length > 0);
			i++;
		} else if (arg === "--no-tools") {
			result.noTools = true;
		} else if (arg === "--print" || arg === "-p") {
			// Print is the only mode; the flag is accepted (and may carry the prompt).
			result.print = true;
			const next = args[i + 1];
			if (next !== undefined && !next.startsWith("-") && !next.startsWith("@")) {
				result.messages.push(next);
				i++;
			}
		} else if (arg === "--no-session") {
			result.noSession = true;
		} else if (arg === "--help" || arg === "-h") {
			result.help = true;
		} else if (arg === "--version" || arg === "-v") {
			result.version = true;
		} else if (arg.startsWith("@")) {
			result.fileArgs.push(arg.slice(1)); // Remove @ prefix
		} else if (arg.startsWith("-")) {
			throw new Error(`Unknown option: ${arg}`);
		} else {
			result.messages.push(arg);
		}
	}

	return result;
}

export function printHelp(): void {
	process.stdout.write(`Usage: ${APP_NAME} [options] [prompt]

Send a prompt to the agent and print the result.

Options:
  --mode <text|json>            Output mode (default: text)
  --provider <name>             Provider for the model
  --model <id>                  Model id ("provider/model" or plain id)
  --api-key <key>               API key override
  --system-prompt <text>        Replace the system prompt
  --append-system-prompt <text> Append to the system prompt (repeatable)
  --thinking <level>            Thinking level (${THINKING_LEVEL_OPTIONS.join(", ")})
  --tools, -t <list>            Comma-separated tool names to enable
  --exclude-tools <list>        Comma-separated tool names to exclude
  --no-tools                    Disable all tools
  -p, --print                   Print mode (the default; accepted for compatibility)
  --no-session                  Do not persist this conversation
  -h, --help                    Show this help
  -v, --version                 Show version

A positional argument starting with @ reads the prompt from a file.
`);
}
