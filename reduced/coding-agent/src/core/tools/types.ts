// Reduced from packages/coding-agent/src/core/extensions/types.ts + tools/tool-definition-wrapper.ts.
// The ExtensionContext parameter is dropped: tools are bound to a cwd at creation time and
// receive no per-call session context.

import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "../../../../agent/src/index.ts";
import type { Static, TSchema } from "typebox";

/** Structured-output hint attached to every built-in tool definition. */
export const constrainedSampling = { type: "json_schema", strict: "prefer" } as const;

/**
 * Internal tool definition shape. Tool files build one of these and wrap it into an
 * `AgentTool` with `wrapToolDefinition`.
 */
export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown> {
	name: string;
	label: string;
	description: string;
	parameters: TParams;
	promptSnippet?: string;
	promptGuidelines?: readonly string[];
	/** Constrained-sampling hint forwarded on the wire schema; false opts out. */
	constrainedSampling?: typeof constrainedSampling | false;
	/** Repair model-authored arguments before validation (e.g. edit's JSON-string edits array). */
	prepareArguments?: (input: unknown) => unknown;
	execute: (
		toolCallId: string,
		params: Static<TParams>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails>,
	) => Promise<AgentToolResult<TDetails>>;
}

/** Adapter from the internal definition to the runtime tool surface. */
export function wrapToolDefinition<TParams extends TSchema, TDetails>(
	definition: ToolDefinition<TParams, TDetails>,
): AgentTool<TParams, TDetails> {
	const tool: AgentTool<TParams, TDetails> = {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		execute: definition.execute,
	};
	return Object.assign(tool, {
		promptSnippet: definition.promptSnippet,
		promptGuidelines: definition.promptGuidelines,
		prepareArguments: definition.prepareArguments,
	});
}
