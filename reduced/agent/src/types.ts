// Reduced from packages/agent/src/types.ts (463 lines) — the root Agent/agent-loop
// contract, which is the production hot path (the coding-agent builds on it).
// LLM message shapes are defined locally (mirroring reduced/ai) so the copy is
// standalone. Dropped: images, deferred handles, thinking budgets, transport
// plumbing, tool-loadout announcement machinery, prepareArguments shims.

import type { Static, TSchema } from "typebox";
import type { AssistantMessageEventStream } from "./event-stream.ts";

// --- Minimal LLM shapes (mirrors reduced/ai/src/types.ts) ---

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export interface JsonObject {
	[key: string]: JsonValue;
}

export interface TextContent {
	type: "text";
	text: string;
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
	content: (TextContent | ToolCall)[];
	api: string;
	provider: string;
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
	/** Usage from the tool execution itself, if available. Not part of main LLM context accounting. */
	usage?: Usage;
	isError: boolean;
	timestamp: number;
}

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

export interface Tool<TParameters extends TSchema = TSchema> {
	name: string;
	description: string;
	parameters: TParameters;
}

export interface Model {
	id: string;
	name: string;
	api: string;
	provider: string;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
}

/** Event protocol of the assistant stream the loop consumes. */
export type AssistantMessageEvent =
	| { type: "start"; partial: AssistantMessage }
	| { type: "text_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
	| { type: "done"; reason: Extract<StopReason, "stop" | "length" | "toolUse">; message: AssistantMessage }
	| { type: "error"; reason: Extract<StopReason, "aborted" | "error">; error: AssistantMessage };

// --- Agent contract ---

/**
 * Stream function used by the agent loop. Returns the assistant event stream
 * for one model request. Failures must arrive as normal assistant messages
 * with stopReason "error"/"aborted" through the stream, not as exceptions.
 */
export type StreamFn = (
	model: Model,
	context: { messages: Message[] },
	options?: { signal?: AbortSignal; apiKey?: string },
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

export type ToolExecutionMode = "sequential" | "parallel";

/** Controls how many queued user messages are injected at a queue drain point. */
export type QueueMode = "all" | "one-at-a-time";

/** A single tool call content block emitted by an assistant message. */
export type AgentToolCall = ToolCall;

/**
 * Result returned from `beforeToolCall`. `{ block: true }` prevents execution;
 * the loop emits an error tool result instead.
 */
export interface BeforeToolCallResult {
	block?: boolean;
	reason?: string;
	/** Hint to stop after the current tool batch (effective when every result in the batch sets it). */
	terminate?: boolean;
}

/**
 * Partial override returned from `afterToolCall`. Omitted fields keep the
 * executed values; no deep merge.
 */
export interface AfterToolCallResult {
	content?: TextContent[];
	details?: unknown;
	isError?: boolean;
	usage?: Usage;
	terminate?: boolean;
}

/** Context passed to `beforeToolCall`. */
export interface BeforeToolCallContext {
	assistantMessage: AssistantMessage;
	toolCall: AgentToolCall;
	args: unknown;
	context: AgentContext;
}

/** Context passed to `afterToolCall`. */
export interface AfterToolCallContext {
	assistantMessage: AssistantMessage;
	toolCall: AgentToolCall;
	args: unknown;
	result: AgentToolResult<unknown>;
	isError: boolean;
	context: AgentContext;
}

/** Context passed to `shouldStopAfterTurn`. */
export interface ShouldStopAfterTurnContext {
	message: AssistantMessage;
	toolResults: ToolResultMessage[];
	context: AgentContext;
	newMessages: AgentMessage[];
}

/** Replacement runtime state used by the loop before the next provider request. */
export interface AgentLoopTurnUpdate {
	context?: AgentContext;
	messages?: AgentMessage[];
	model?: Model;
	thinkingLevel?: ThinkingLevel;
}

export interface PrepareNextTurnContext extends ShouldStopAfterTurnContext {}

export interface AgentLoopConfig {
	model: Model;
	/** Converts AgentMessage[] to LLM Message[] before each call. Must not throw. */
	convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	/** Optional AgentMessage-level transform before convertToLlm (context pruning). Must not throw. */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	/** Resolves an API key per LLM call. Must not throw. */
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	/** Graceful stop after the current turn completes. Must not throw. */
	shouldStopAfterTurn?: (context: ShouldStopAfterTurnContext) => boolean | Promise<boolean>;
	/** Replacement context/model/messages for the next turn. */
	prepareNextTurn?: (
		context: PrepareNextTurnContext,
	) => AgentLoopTurnUpdate | undefined | Promise<AgentLoopTurnUpdate | undefined>;
	/** Steering messages injected mid-run. Return [] when none. */
	getSteeringMessages?: () => Promise<AgentMessage[]>;
	/** Follow-up messages processed when the agent would otherwise stop. Return [] when none. */
	getFollowUpMessages?: () => Promise<AgentMessage[]>;
	/** Default "parallel": preflight sequentially, execute allowed tools concurrently. */
	toolExecution?: ToolExecutionMode;
	/** Called before a tool executes, after argument validation. */
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
	/** Called after a tool finishes, before its events are emitted. */
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
	/** Per-request options forwarded to the StreamFn. */
	apiKey?: string;
	sessionId?: string;
	signal?: AbortSignal;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";

/**
 * AgentMessage: LLM messages + app-defined custom messages (declaration
 * merging on CustomAgentMessages).
 */
export interface CustomAgentMessages {}

export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

/** Public agent state. `tools`/`messages` setters copy the top-level array. */
export interface AgentState {
	readonly systemPrompt: string;
	model: Model;
	thinkingLevel: ThinkingLevel;
	set tools(tools: AgentTool[]);
	get tools(): AgentTool[];
	set messages(messages: AgentMessage[]);
	get messages(): AgentMessage[];
	readonly isStreaming: boolean;
	readonly streamingMessage?: AgentMessage;
	readonly pendingToolCalls: ReadonlySet<string>;
	readonly errorMessage?: string;
}

/** Final or partial result produced by a tool. */
export interface AgentToolResult<T = JsonValue | undefined> {
	content: TextContent[];
	details: T;
	usage?: Usage;
	/** Hint to stop after the current tool batch. */
	terminate?: boolean;
}

export type AgentToolUpdateCallback<T = unknown> = (partialResult: AgentToolResult<T>) => void;

/** Tool definition used by the agent runtime. */
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = unknown> extends Tool<TParameters> {
	/** Human-readable label for UI display. */
	label: string;
	/** Execute the tool call. Throw on failure instead of encoding errors in content. */
	execute: (
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails>,
	) => Promise<AgentToolResult<TDetails>>;
	/** Per-tool execution mode override. */
	executionMode?: ToolExecutionMode;
}

/** Context snapshot passed into the low-level agent loop. */
export interface AgentContext {
	messages: AgentMessage[];
	tools?: AgentTool[];
}

/** Events emitted by the Agent for UI updates. */
export type AgentEvent =
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[] }
	| { type: "turn_start" }
	| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
	| { type: "message_start"; message: AgentMessage }
	| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
	| { type: "message_end"; message: AgentMessage }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean };
