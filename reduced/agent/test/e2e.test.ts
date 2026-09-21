// Adapted from packages/agent/test/e2e.test.ts to run WITHOUT the faux provider
// (it lives in reduced/ai, out of reach for this standalone copy). Model responses
// are scripted through MockAssistantStream via an explicit streamFn, keeping the
// end-to-end shape: agent + calculate-style tool, model requests a tool call, the
// tool executes, and the model returns the final answer. Dropped: thinking-content
// preservation (no thinking blocks in the reduced message union) and the
// continue() validation matrix (covered by agentLoopContinue unit tests).

import { describe, expect, it } from "vitest";
import { Agent, type AgentEvent } from "../src/index.ts";
import type { AssistantMessage, TextContent, ToolCall, ToolResultMessage } from "../src/types.ts";
import { calculateTool } from "./utils/calculate.ts";
import {
	MockAssistantStream,
	createAssistantMessage,
	createModel,
	createTextMessage,
	createToolCall,
} from "./helpers/mock-stream.ts";

const model = createModel();

function getTextContent(message: AssistantMessage | ToolResultMessage): string {
	const blocks: readonly (TextContent | ToolCall)[] = message.content;
	return blocks
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

describe("Agent end to end with a scripted stream", () => {
	it("handles a basic text prompt", async () => {
		const agent = new Agent({
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createTextMessage("4") });
				});
				return stream;
			},
			initialState: {
				systemPrompt: "You are a helpful assistant. Keep your responses concise.",
				model,
				thinkingLevel: "off",
				tools: [],
			},
		});

		await agent.prompt("What is 2+2? Answer with just the number.");

		expect(agent.state.isStreaming).toBe(false);
		expect(agent.state.messages.length).toBe(3);
		expect(agent.state.messages[0]?.role).toBe("system");
		expect(agent.state.messages[1]?.role).toBe("user");
		expect(agent.state.messages[2]?.role).toBe("assistant");

		const assistantMessage = agent.state.messages[2];
		if (assistantMessage?.role !== "assistant") throw new Error("Expected assistant message");
		expect(getTextContent(assistantMessage)).toContain("4");
	});

	it("executes a tool call and returns the final answer", async () => {
		let requestCount = 0;
		const agent = new Agent({
			streamFn: () => {
				const stream = new MockAssistantStream();
				requestCount++;
				queueMicrotask(() => {
					if (requestCount === 1) {
						// First call: the model requests the calculator tool.
						stream.push({
							type: "done",
							reason: "toolUse",
							message: createAssistantMessage(
								[
									{ type: "text", text: "Let me calculate that." },
									createToolCall("calc-1", "calculate", { expression: "123 * 456" }),
								],
								"toolUse",
							),
						});
					} else {
						// Second call: the model answers from the tool result.
						stream.push({ type: "done", reason: "stop", message: createTextMessage("The result is 56088.") });
					}
				});
				return stream;
			},
			initialState: {
				systemPrompt: "You are a helpful assistant. Always use the calculator tool for math.",
				model,
				thinkingLevel: "off",
				tools: [calculateTool],
			},
		});

		const pendingToolCallsDuringEvents: Array<{ type: AgentEvent["type"]; ids: string[] }> = [];
		agent.subscribe((event) => {
			if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
				pendingToolCallsDuringEvents.push({
					type: event.type,
					ids: [...agent.state.pendingToolCalls],
				});
			}
		});

		await agent.prompt("Calculate 123 * 456 using the calculator tool.");

		expect(agent.state.isStreaming).toBe(false);
		expect(agent.state.messages.length).toBeGreaterThanOrEqual(4);
		const toolResultMsg = agent.state.messages.find((message) => message.role === "toolResult");
		if (toolResultMsg?.role !== "toolResult") throw new Error("Expected tool result message");
		expect(getTextContent(toolResultMsg)).toContain("123 * 456 = 56088");

		const finalMessage = agent.state.messages[agent.state.messages.length - 1];
		if (finalMessage?.role !== "assistant") throw new Error("Expected final assistant message");
		expect(getTextContent(finalMessage)).toContain("56088");
		expect(agent.state.pendingToolCalls.size).toBe(0);
		expect(pendingToolCallsDuringEvents).toEqual([
			{ type: "tool_execution_start", ids: ["calc-1"] },
			{ type: "tool_execution_end", ids: [] },
		]);
	});

	it("maintains context across multiple turns", async () => {
		let requestCount = 0;
		const agent = new Agent({
			streamFn: (_model, context) => {
				const stream = new MockAssistantStream();
				requestCount++;
				queueMicrotask(() => {
					// The scripted reply depends on the transcript the loop actually sent,
					// so a context regression fails the assertion instead of the mock.
					const hasAlice = context.messages.some((message) => {
						if (message.role !== "user") return false;
						if (typeof message.content === "string") return message.content.includes("Alice");
						return message.content.some((block) => block.type === "text" && block.text.includes("Alice"));
					});
					const reply =
						requestCount === 1 ? "Nice to meet you, Alice." : hasAlice ? "Your name is Alice." : "I do not know your name.";
					stream.push({ type: "done", reason: "stop", message: createTextMessage(reply) });
				});
				return stream;
			},
			initialState: {
				systemPrompt: "You are a helpful assistant.",
				model,
				thinkingLevel: "off",
				tools: [],
			},
		});

		await agent.prompt("My name is Alice.");
		expect(agent.state.messages.length).toBe(3);

		await agent.prompt("What is my name?");
		expect(agent.state.messages.length).toBe(5);

		const lastMessage = agent.state.messages[4];
		if (lastMessage?.role !== "assistant") throw new Error("Expected assistant message");
		expect(getTextContent(lastMessage).toLowerCase()).toContain("alice");
	});
});
