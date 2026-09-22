// Reduced from packages/coding-agent/src/core/tools/ls.ts. Dropped: LsOperations hook.

import { readdir as fsReaddir, stat as fsStat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTool } from "../../../../agent/src/index.ts";
import { type Static, Type } from "typebox";
import { pathExists, resolveToCwd } from "./path-utils.ts";
import { constrainedSampling, wrapToolDefinition } from "./types.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

const lsSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Directory to list (default: current directory)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of entries to return (default: 500)" })),
});

export const lsToolSystemPromptContribution = {
	snippet: "List directory contents",
	guidelines: [],
} as const;

export type LsToolInput = Static<typeof lsSchema>;

const DEFAULT_LIMIT = 500;

export interface LsToolDetails {
	truncation?: TruncationResult;
	entryLimitReached?: number;
}

export function createLsTool(cwd: string): AgentTool<typeof lsSchema, LsToolDetails | undefined> {
	return wrapToolDefinition<typeof lsSchema, LsToolDetails | undefined>({
		name: "ls",
		label: "ls",
		description: `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${DEFAULT_LIMIT} entries or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
		promptSnippet: lsToolSystemPromptContribution.snippet,
		parameters: lsSchema,
		constrainedSampling,
		async execute(_toolCallId, { path, limit }: LsToolInput, signal?: AbortSignal) {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			const dirPath = resolveToCwd(path || ".", cwd);
			const effectiveLimit = limit ?? DEFAULT_LIMIT;

			// Check if path exists.
			if (!(await pathExists(dirPath))) {
				throw new Error(`Path not found: ${dirPath}`);
			}
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			// Check if path is a directory.
			const stat = await fsStat(dirPath);
			if (!stat.isDirectory()) {
				throw new Error(`Not a directory: ${dirPath}`);
			}
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			// Read directory entries.
			let entries: string[];
			try {
				entries = await fsReaddir(dirPath);
			} catch (error: unknown) {
				throw new Error(`Cannot read directory: ${error instanceof Error ? error.message : String(error)}`);
			}

			// Sort alphabetically, case-insensitive.
			entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

			// Format entries with directory indicators.
			const results: string[] = [];
			let entryLimitReached = false;
			for (const entry of entries) {
				if (results.length >= effectiveLimit) {
					entryLimitReached = true;
					break;
				}

				const fullPath = join(dirPath, entry);
				let suffix = "";
				try {
					const entryStat = await fsStat(fullPath);
					if (entryStat.isDirectory()) suffix = "/";
				} catch {
					// Skip entries we cannot stat.
					continue;
				}
				results.push(entry + suffix);
			}

			if (results.length === 0) {
				return { content: [{ type: "text", text: "(empty directory)" }], details: undefined };
			}

			const rawOutput = results.join("\n");
			// Apply byte truncation. There is no separate line limit because entry count is already capped.
			const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
			let output = truncation.content;
			const details: LsToolDetails = {};
			// Build actionable notices for truncation and entry limits.
			const notices: string[] = [];
			if (entryLimitReached) {
				notices.push(`${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`);
				details.entryLimitReached = effectiveLimit;
			}
			if (truncation.truncated) {
				notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
				details.truncation = truncation;
			}
			if (notices.length > 0) {
				output += `\n\n[${notices.join(". ")}]`;
			}

			return {
				content: [{ type: "text", text: output }],
				details: Object.keys(details).length > 0 ? details : undefined,
			};
		},
	});
}
