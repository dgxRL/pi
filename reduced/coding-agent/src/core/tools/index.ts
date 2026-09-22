// Reduced from packages/coding-agent/src/core/tools/index.ts.
// One definition -> tool path (no powershell, no per-tool factory pairs).

import type { TSchema } from "typebox";
import type { AgentTool } from "../../../../agent/src/index.ts";
import { type BashToolDetails, type BashToolInput, type BashToolOptions, createBashTool } from "./bash.ts";
import { type EditToolDetails, type EditToolInput, createEditTool } from "./edit.ts";
import { type FindToolDetails, type FindToolInput, createFindTool } from "./find.ts";
import { type GrepToolDetails, type GrepToolInput, createGrepTool } from "./grep.ts";
import { type LsToolDetails, type LsToolInput, createLsTool } from "./ls.ts";
import { type ReadToolDetails, type ReadToolInput, createReadTool } from "./read.ts";
import { type WriteToolInput, createWriteTool } from "./write.ts";

export type { BashOperations, BashToolDetails, BashToolInput, BashToolOptions } from "./bash.ts";
export { createLocalBashOperations } from "./bash.ts";
export {
	applyEditsToNormalizedContent,
	type Edit,
	type FuzzyMatchResult,
	generateDiffString,
	normalizeForFuzzyMatch,
} from "./edit-diff.ts";
export type { EditToolDetails, EditToolInput } from "./edit.ts";
export { withFileMutationQueue } from "./file-mutation-queue.ts";
export type { FindToolDetails, FindToolInput } from "./find.ts";
export { relativizeFindResultPath } from "./find.ts";
export type { GrepToolDetails, GrepToolInput } from "./grep.ts";
export type { LsToolDetails, LsToolInput } from "./ls.ts";
export { type OutputSnapshot, OutputAccumulator } from "./output-accumulator.ts";
export { pathExists, resolveToCwd } from "./path-utils.ts";
export { renderCall, renderResult } from "./render.ts";
export type { ReadToolDetails, ReadToolInput } from "./read.ts";
export type { ToolDefinition } from "./types.ts";
export { wrapToolDefinition } from "./types.ts";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.ts";
export type { WriteToolInput } from "./write.ts";

export type ToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";
export const allToolNames: Set<ToolName> = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

export interface ToolsOptions {
	bash?: BashToolOptions;
}

export type Tool = AgentTool<TSchema, unknown>;

export type ToolInput =
	| ReadToolInput
	| BashToolInput
	| EditToolInput
	| WriteToolInput
	| GrepToolInput
	| FindToolInput
	| LsToolInput;

export type ToolDetails =
	| ReadToolDetails
	| BashToolDetails
	| EditToolDetails
	| GrepToolDetails
	| FindToolDetails
	| LsToolDetails
	| undefined;

export function createTool(toolName: ToolName, cwd: string, options?: ToolsOptions): Tool {
	switch (toolName) {
		case "read":
			return createReadTool(cwd);
		case "bash":
			return createBashTool(cwd, options?.bash);
		case "edit":
			return createEditTool(cwd);
		case "write":
			return createWriteTool(cwd);
		case "grep":
			return createGrepTool(cwd);
		case "find":
			return createFindTool(cwd);
		case "ls":
			return createLsTool(cwd);
		default:
			throw new Error(`Unknown tool name: ${String(toolName)}`);
	}
}

export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd),
		createBashTool(cwd, options?.bash),
		createEditTool(cwd),
		createWriteTool(cwd),
	];
}

export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [createReadTool(cwd), createGrepTool(cwd), createFindTool(cwd), createLsTool(cwd)];
}

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	return {
		read: createReadTool(cwd),
		bash: createBashTool(cwd, options?.bash),
		edit: createEditTool(cwd),
		write: createWriteTool(cwd),
		grep: createGrepTool(cwd),
		find: createFindTool(cwd),
		ls: createLsTool(cwd),
	};
}
