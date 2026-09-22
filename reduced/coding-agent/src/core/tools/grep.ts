// Reduced from packages/coding-agent/src/core/tools/grep.ts. Dropped: GrepOperations hook
// (no SSH remotes) and the win32 backslash path rewrite. Keeps rg --json streaming, the
// match limit with early kill, context lines, and byte/line truncation notices.

import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { basename, relative } from "node:path";
import { spawn } from "node:child_process";
import type { AgentTool, AgentToolResult } from "../../../../agent/src/index.ts";
import { type Static, Type } from "typebox";
import { resolveToCwd } from "./path-utils.ts";
import { ensureTool } from "./shell.ts";
import { constrainedSampling, wrapToolDefinition } from "./types.ts";
import {
	DEFAULT_MAX_BYTES,
	formatSize,
	GREP_MAX_LINE_LENGTH,
	type TruncationResult,
	truncateHead,
	truncateLine,
} from "./truncate.ts";

const grepSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
	glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
	literal: Type.Optional(
		Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" }),
	),
	context: Type.Optional(
		Type.Number({ description: "Number of lines to show before and after each match (default: 0)" }),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
});

export const grepToolSystemPromptContribution = {
	snippet: "Search file contents for patterns (respects .gitignore)",
	guidelines: [],
} as const;

export type GrepToolInput = Static<typeof grepSchema>;
const DEFAULT_LIMIT = 100;

export interface GrepToolDetails {
	truncation?: TruncationResult;
	matchLimitReached?: number;
	linesTruncated?: boolean;
}

/** Shape of the ripgrep --json events the tool consumes. */
interface RipgrepEvent {
	type?: string;
	data?: {
		path?: { text?: string };
		line_number?: number;
		lines?: { text?: string };
	};
}

export function createGrepTool(cwd: string): AgentTool<typeof grepSchema, GrepToolDetails | undefined> {
	return wrapToolDefinition<typeof grepSchema, GrepToolDetails | undefined>({
		name: "grep",
		label: "grep",
		description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
		promptSnippet: grepToolSystemPromptContribution.snippet,
		parameters: grepSchema,
		constrainedSampling,
		async execute(
			_toolCallId,
			{ pattern, path: searchDir, glob, ignoreCase, literal, context, limit }: GrepToolInput,
			signal?: AbortSignal,
		) {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			const rgPath = await ensureTool("rg");
			if (!rgPath) {
				throw new Error("ripgrep (rg) is not available");
			}

			const searchPath = resolveToCwd(searchDir || ".", cwd);
			let isDirectory: boolean;
			try {
				isDirectory = (await fsStat(searchPath)).isDirectory();
			} catch {
				throw new Error(`Path not found: ${searchPath}`);
			}

			const contextValue = context && context > 0 ? context : 0;
			const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);
			const formatPath = (filePath: string): string => {
				if (isDirectory) {
					const rel = relative(searchPath, filePath);
					if (rel && !rel.startsWith("..")) {
						return rel;
					}
				}
				return basename(filePath);
			};

			const fileCache = new Map<string, string[]>();
			const getFileLines = async (filePath: string): Promise<string[]> => {
				let lines = fileCache.get(filePath);
				if (!lines) {
					try {
						const content = await fsReadFile(filePath, "utf-8");
						lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
					} catch {
						lines = [];
					}
					fileCache.set(filePath, lines);
				}
				return lines;
			};

			const args: string[] = ["--json", "--line-number", "--color=never", "--hidden"];
			if (ignoreCase) args.push("--ignore-case");
			if (literal) args.push("--fixed-strings");
			if (glob) args.push("--glob", glob);
			args.push("--", pattern, searchPath);

			// Streaming child-process events settle the promise from the close handler.
			const { promise, resolve, reject } = Promise.withResolvers<AgentToolResult<GrepToolDetails | undefined>>();
			const child = spawn(rgPath, args, { stdio: ["ignore", "pipe", "pipe"] });
			const rl = createInterface({ input: child.stdout });
			let stderr = "";
			let matchCount = 0;
			let matchLimitReached = false;
			let linesTruncated = false;
			let aborted = false;
			let killedDueToLimit = false;
			const outputLines: string[] = [];

			const cleanup = () => {
				rl.close();
				signal?.removeEventListener("abort", onAbort);
			};
			const stopChild = (dueToLimit = false) => {
				if (!child.killed) {
					killedDueToLimit = dueToLimit;
					child.kill();
				}
			};
			const onAbort = () => {
				aborted = true;
				stopChild();
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			child.stderr?.on("data", (chunk) => {
				stderr += chunk.toString();
			});

			const formatBlock = async (filePath: string, lineNumber: number): Promise<string[]> => {
				const relativePath = formatPath(filePath);
				const lines = await getFileLines(filePath);
				if (!lines.length) return [`${relativePath}:${lineNumber}: (unable to read file)`];
				const block: string[] = [];
				const start = contextValue > 0 ? Math.max(1, lineNumber - contextValue) : lineNumber;
				const end = contextValue > 0 ? Math.min(lines.length, lineNumber + contextValue) : lineNumber;
				for (let current = start; current <= end; current++) {
					const lineText = lines[current - 1] ?? "";
					const sanitized = lineText.replace(/\r/g, "");
					const isMatchLine = current === lineNumber;
					// Truncate long lines so grep output stays compact.
					const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
					if (wasTruncated) linesTruncated = true;
					if (isMatchLine) block.push(`${relativePath}:${current}: ${truncatedText}`);
					else block.push(`${relativePath}-${current}- ${truncatedText}`);
				}
				return block;
			};

			// Collect matches during streaming, then format them after rg exits.
			const matches: Array<{ filePath: string; lineNumber: number; lineText?: string }> = [];
			rl.on("line", (line) => {
				if (!line.trim() || matchCount >= effectiveLimit) return;
				let event: RipgrepEvent;
				try {
					event = JSON.parse(line) as RipgrepEvent;
				} catch {
					return;
				}
				if (event.type === "match") {
					matchCount++;
					const filePath = event.data?.path?.text;
					const lineNumber = event.data?.line_number;
					const lineText = event.data?.lines?.text;
					if (filePath && typeof lineNumber === "number") matches.push({ filePath, lineNumber, lineText });
					if (matchCount >= effectiveLimit) {
						matchLimitReached = true;
						stopChild(true);
					}
				}
			});

			child.on("error", (error) => {
				cleanup();
				reject(new Error(`Failed to run ripgrep: ${error.message}`));
			});
			child.on("close", async (code) => {
				cleanup();
				if (aborted) {
					reject(new Error("Operation aborted"));
					return;
				}
				if (!killedDueToLimit && code !== 0 && code !== 1) {
					const errorMsg = stderr.trim() || `ripgrep exited with code ${code}`;
					reject(new Error(errorMsg));
					return;
				}
				if (matchCount === 0) {
					resolve({ content: [{ type: "text", text: "No matches found" }], details: undefined });
					return;
				}

				for (const match of matches) {
					if (contextValue === 0 && match.lineText !== undefined) {
						const relativePath = formatPath(match.filePath);
						const sanitized = match.lineText.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "");
						const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
						if (wasTruncated) linesTruncated = true;
						outputLines.push(`${relativePath}:${match.lineNumber}: ${truncatedText}`);
					} else {
						const block = await formatBlock(match.filePath, match.lineNumber);
						outputLines.push(...block);
					}
				}

				const rawOutput = outputLines.join("\n");
				// Apply byte truncation. There is no line limit here because the match limit already capped rows.
				const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
				let output = truncation.content;
				const details: GrepToolDetails = {};
				// Build actionable notices for truncation and match limits.
				const notices: string[] = [];
				if (matchLimitReached) {
					notices.push(
						`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
					);
					details.matchLimitReached = effectiveLimit;
				}
				if (truncation.truncated) {
					notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
					details.truncation = truncation;
				}
				if (linesTruncated) {
					notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
					details.linesTruncated = true;
				}
				if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
				resolve({
					content: [{ type: "text", text: output }],
					details: Object.keys(details).length > 0 ? details : undefined,
				});
			});

			return promise;
		},
	});
}
