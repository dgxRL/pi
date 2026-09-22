// Reduced from packages/coding-agent/src/core/tools/read.ts.
// Dropped: the image branch entirely (text files only) and the ReadOperations hook.

import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile } from "fs/promises";
import type { AgentTool, TextContent } from "../../../../agent/src/index.ts";
import { type Static, Type } from "typebox";
import { resolveToCwd } from "./path-utils.ts";
import { constrainedSampling, wrapToolDefinition } from "./types.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

export const readToolSystemPromptContribution = {
	snippet: "Read file contents",
	guidelines: ["Use read to examine files instead of cat or sed."],
} as const;

export type ReadToolInput = Static<typeof readSchema>;

export interface ReadToolDetails {
	truncation?: TruncationResult;
}

export function createReadTool(cwd: string): AgentTool<typeof readSchema, ReadToolDetails | undefined> {
	return wrapToolDefinition<typeof readSchema, ReadToolDetails | undefined>({
		name: "read",
		label: "read",
		description: `Read the contents of a text file. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
		promptSnippet: readToolSystemPromptContribution.snippet,
		promptGuidelines: [...readToolSystemPromptContribution.guidelines],
		parameters: readSchema,
		constrainedSampling,
		async execute(_toolCallId, { path, offset, limit }: ReadToolInput, signal?: AbortSignal) {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			const absolutePath = resolveToCwd(path, cwd);
			// Check if file exists and is readable.
			await fsAccess(absolutePath, constants.R_OK);
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}
			const buffer = await fsReadFile(absolutePath);
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			const textContent = buffer.toString("utf-8");
			const allLines = textContent.split("\n");
			const totalFileLines = allLines.length;
			// Apply offset if specified. Convert from 1-indexed input to 0-indexed array access.
			const startLine = offset ? Math.max(0, offset - 1) : 0;
			const startLineDisplay = startLine + 1;
			// Check if offset is out of bounds.
			if (startLine >= allLines.length) {
				throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
			}
			let selectedContent: string;
			let userLimitedLines: number | undefined;
			// If limit is specified by the user, honor it first. Otherwise truncateHead decides.
			if (limit !== undefined) {
				const endLine = Math.min(startLine + limit, allLines.length);
				selectedContent = allLines.slice(startLine, endLine).join("\n");
				userLimitedLines = endLine - startLine;
			} else {
				selectedContent = allLines.slice(startLine).join("\n");
			}
			// Apply truncation, respecting both line and byte limits.
			const truncation = truncateHead(selectedContent);
			let outputText: string;
			let details: ReadToolDetails | undefined;
			if (truncation.firstLineExceedsLimit) {
				// First line alone exceeds the byte limit. Point the model at a bash fallback.
				const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], "utf-8"));
				outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
				details = { truncation };
			} else if (truncation.truncated) {
				// Truncation occurred. Build an actionable continuation notice.
				const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
				const nextOffset = endLineDisplay + 1;
				outputText = truncation.content;
				if (truncation.truncatedBy === "lines") {
					outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
				} else {
					outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
				}
				details = { truncation };
			} else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
				// User-specified limit stopped early, but the file still has more content.
				const remaining = allLines.length - (startLine + userLimitedLines);
				const nextOffset = startLine + userLimitedLines + 1;
				outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
			} else {
				// No truncation and no remaining user-limited content.
				outputText = truncation.content;
			}

			const content: TextContent[] = [{ type: "text", text: outputText }];
			return { content, details };
		},
	});
}
