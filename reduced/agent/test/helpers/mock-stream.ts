// Ported from packages/agent/test/agent-loop.test.ts (MockAssistantStream) and the
// shared factories used across packages/agent/test/{agent-loop,agent}.test.ts.
// Adapted to the reduced contract: no thinking events, no image content, and no
// tool-loadout fields (toolsAdded/toolsRemoved) on system messages.

import { AssistantMessageEventStream } from "../../src/event-stream.ts";
import type {
	AgentMessage,
	AssistantMessage,
	AssistantMessageEvent,
	JsonObject,
	Message,
	Model,
	ToolCall,
	Usage,
	UserMessage,
} from "../../src/types.ts";

/** Hand-built assistant stream: scripts `done`/`error` terminal events over EventStream. */
export class MockAssistantStream extends AssistantMessageEventStream {
	constructor() {
		super();
	}
}

export function createUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function createModel(): Model {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		reasoning: false,
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

export function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: createUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}

export function createTextMessage(text: string): AssistantMessage {
	return createAssistantMessage([{ type: "text", text }]);
}

export function createToolCall(id: string, name: string, args: JsonObject): ToolCall {
	return { type: "toolCall", id, name, arguments: args };
}

export function createToolUseMessage(calls: ToolCall[]): AssistantMessage {
	return createAssistantMessage(calls, "toolUse");
}

export function createUserMessage(text: string): UserMessage {
	return {
		role: "user",
		content: text,
		timestamp: Date.now(),
	};
}

/** Simple identity converter for tests — passes through the four standard message roles. */
export function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(message) =>
			message.role === "system" ||
			message.role === "user" ||
			message.role === "assistant" ||
			message.role === "toolResult",
	) as Message[];
}

export function createDeferred(): {
	promise: Promise<void>;
	resolve: () => void;
} {
	let resolve = () => {};
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}
