// Reduced from packages/ai/src/utils/transcript.ts and packages/ai/src/utils/validation.ts —
// the minimal pi-ai boundary helpers the agent loop needs.
//
// Ported faithfully:
// - createInitialSystemMessage: "undefined when both prompt and tools are empty" behavior.
// - getCurrentSystemMessage / getCurrentSystemPrompt: transcript replay helpers.
// - toToolDeclaration: strips executable/display fields, deep-copies the schema.
// - validateToolArguments: Compile + Value.Convert with a WeakMap validator cache and the
//   original error-message shape ("Validation failed for tool .../path: message/Received arguments").
//
// Dropped from the originals (intentionally not ported):
// - Tool-loadout delta machinery: toolsAdded/toolsRemoved transcript fields, getCurrentTools,
//   getToolStateChanges, collapseSystemMessages, resolveTranscript, sections patching. The
//   reduced copy declares tools once, inside the initial system message's content.
// - normalizeOptionalNulls and the JSON-Schema coercion fallback (coerceWithJsonSchema & co):
//   they only matter for plain JSON-Schema inputs; TypeBox schemas are handled by
//   Value.Convert + the compiled validator.

import { Compile } from "typebox/compile";
import type { Validator } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import type { AgentTool, JsonObject, SystemMessage } from "./types.ts";

/**
 * Any message list. The replay helpers only read entries whose role is `"system"`, so
 * agent transcripts that carry custom message roles can be passed without filtering.
 */
export type TranscriptMessages = readonly { role: string }[];

/** Wire shape of a tool as declared to the model: name, description, JSON schema. */
export interface ToolDeclaration {
	name: string;
	description: string;
	parameters: TSchema;
}

/**
 * Build the leading system message for a prompt and tool set. Returns undefined when
 * both are empty, so an empty transcript stays empty.
 *
 * Reduced adaptation: the original attached tool declarations as transcript-level
 * `toolsAdded` fields; the reduced SystemMessage has no tool fields, so declarations are
 * embedded in the message content instead.
 */
export function createInitialSystemMessage(
	systemPrompt: string | undefined,
	tools: readonly ToolDeclaration[] | undefined,
): SystemMessage | undefined {
	const hasSystemPrompt = systemPrompt !== undefined && systemPrompt.length > 0;
	const hasTools = tools !== undefined && tools.length > 0;
	if (!hasSystemPrompt && !hasTools) return undefined;
	const content = [systemPrompt ?? "", renderToolDeclarations(tools ?? [])]
		.filter((part) => part.length > 0)
		.join("\n\n");
	return { role: "system", content, timestamp: 0 };
}

function renderToolDeclarations(tools: readonly ToolDeclaration[]): string {
	if (tools.length === 0) return "";
	const blocks = tools.map(
		(declaration) =>
			`## ${declaration.name}\n${declaration.description}\nParameters JSON schema:\n${JSON.stringify(declaration.parameters)}`,
	);
	return ["# Tools", ...blocks].join("\n\n");
}

/**
 * Replay every system message into one system message holding the current prompt (and,
 * via the content embedding above, the current tools). Later content is appended to the
 * leading prompt. Returns undefined for a transcript with no system messages.
 */
export function getCurrentSystemMessage(messages: TranscriptMessages): SystemMessage | undefined {
	const content: string[] = [];
	let timestamp: number | undefined;
	for (const message of messages) {
		if (message.role !== "system") continue;
		const systemMessage = message as SystemMessage;
		timestamp ??= systemMessage.timestamp;
		if (systemMessage.content.length > 0) content.push(systemMessage.content);
	}
	if (timestamp === undefined && content.length === 0) return undefined;
	return {
		role: "system",
		content: content.join("\n\n"),
		timestamp: timestamp ?? 0,
	};
}

/** Render the current system prompt text after replaying every system message. */
export function getCurrentSystemPrompt(messages: TranscriptMessages): string {
	return getCurrentSystemMessage(messages)?.content ?? "";
}

/**
 * Strip executable and display-only fields from a tool before transcript comparison or
 * persistence; deep-copies the TypeBox schema, which is JSON-Schema-compatible.
 */
export function toToolDeclaration(tool: AgentTool): ToolDeclaration {
	return {
		name: tool.name,
		description: tool.description,
		parameters: JSON.parse(JSON.stringify(tool.parameters)) as TSchema,
	};
}

const validatorCache = new WeakMap<object, Validator>();

function getValidator(schema: TSchema): Validator {
	const key = schema as object;
	const cached = validatorCache.get(key);
	if (cached) {
		return cached;
	}
	const validator = Compile(schema);
	validatorCache.set(key, validator);
	return validator;
}

function formatValidationPath(error: TLocalizedValidationError): string {
	if (error.keyword === "required") {
		const requiredProperties = (error.params as { requiredProperties?: string[] }).requiredProperties;
		const requiredProperty = requiredProperties?.[0];
		if (requiredProperty) {
			const basePath = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
			return basePath ? `${basePath}.${requiredProperty}` : requiredProperty;
		}
	}
	const path = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
	return path || "root";
}

/**
 * Validates tool call arguments against the tool's TypeBox schema.
 * @param schema The tool's parameter schema
 * @param args The raw arguments from the LLM
 * @param toolName Optional tool name used only for the error message
 * @returns The validated (and potentially coerced) arguments
 * @throws Error with formatted message if validation fails
 */
export function validateToolArguments(schema: TSchema, args: unknown, toolName?: string): JsonObject {
	const label = toolName === undefined ? "arguments" : `"${toolName}"`;
	const received = JSON.stringify(args, null, 2);
	const candidate = structuredClone(args);
	Value.Convert(schema, candidate);

	const validator = getValidator(schema);
	if (!validator.Check(candidate)) {
		const errors =
			[...validator.Errors(candidate)]
				.map((error) => `  - ${formatValidationPath(error)}: ${error.message}`)
				.join("\n") || "Unknown validation error";
		throw new Error(`Validation failed for tool ${label}:\n${errors}\n\nReceived arguments:\n${received}`);
	}

	if (!isJsonObject(candidate)) {
		throw new Error(`Validation failed for tool ${label}: arguments must be a JSON object.\n\nReceived arguments:\n${received}`);
	}
	return candidate;
}

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
