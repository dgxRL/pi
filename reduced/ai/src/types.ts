// Reduced from packages/ai/src/types.ts (990 lines -> ~140).
// One in-process provider (faux), one content set (text + thinking + tool
// calls), no images/deferred/constrained-sampling/compat machinery, no HTTP
// transport options, and `details` typed as plain JsonValue (the
// IsJsonCompatible conditional-type block is gone). Event and message shapes
// are otherwise the real contract.

import type { TSchema } from "typebox";
import type { AssistantMessageEventStream } from "./event-stream.ts";

export type Api = "faux";
export type ProviderId = string;

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export interface JsonObject {
	[key: string]: JsonValue;
}

export interface TextContent {
	type: "text";
	text: string;
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string;
}

export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: JsonObject;
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted";

export interface SystemMessage {
	role: "system";
	content: string;
	timestamp: number;
}

export interface UserMessage {
	role: "user";
	content: string | TextContent[];
	timestamp: number;
}

export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | ToolCall)[];
	api: Api;
	provider: ProviderId;
	model: string;
	responseId?: string;
	usage: Usage;
	stopReason: StopReason;
	errorMessage?: string;
	timestamp: number;
}

export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: TextContent[];
	details?: JsonValue;
	isError: boolean;
	timestamp: number;
}

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

export interface Tool<TParameters extends TSchema = TSchema> {
	name: string;
	description: string;
	parameters: TParameters;
}

/** Request input: prompt + transcript + tools. */
export interface Context {
	systemPrompt?: string;
	messages: Message[];
	tools?: Tool[];
}

export interface ModelCostRates {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface ModelCost extends ModelCostRates {
	tiers?: (ModelCostRates & { inputTokensAbove: number })[];
}

export interface Model<TApi extends Api = Api> {
	id: string;
	name: string;
	api: TApi;
	provider: ProviderId;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
	cost: ModelCost;
}

/**
 * Per-request options. The reduced copy has no HTTP transport — providers are
 * in-process (the faux provider), so only abort and cache context remain.
 */
export interface StreamOptions {
	signal?: AbortSignal;
	sessionId?: string;
	cacheRetention?: "none" | "short" | "long";
}

/**
 * Event protocol for AssistantMessageEventStream. `partial` is the live
 * mutable accumulator, not a snapshot: consumers see it grow.
 */
export type AssistantMessageEvent =
	| { type: "start"; partial: AssistantMessage }
	| { type: "text_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
	| { type: "done"; reason: Extract<StopReason, "stop" | "length" | "toolUse">; message: AssistantMessage }
	| { type: "error"; reason: Extract<StopReason, "aborted" | "error">; error: AssistantMessage };

/**
 * A provider API implementation: consumes a model + context, returns the event
 * stream. Sync throws are reserved for missing auth; everything else must
 * terminate through the stream as an error/aborted AssistantMessage.
 */
export type StreamFunction<TApi extends Api = Api> = (
	model: Model<TApi>,
	context: Context,
	options?: StreamOptions,
) => AssistantMessageEventStream;
