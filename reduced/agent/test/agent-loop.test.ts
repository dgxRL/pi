// Ported from packages/agent/test/agent-loop.test.ts (1635 lines), pruned to the
// reduced contract's main flows. Dropped: tool-loadout announcement coverage (the
// reduced loop no longer synthesizes loadout system messages, so expectations that
// counted one were adapted accordingly), length-truncation salvage tests,
// prepareArguments shims, the terminate-hint edge matrix (one blocked-call test
// kept), the transformContext/custom-message matrix, and the agentLoopContinue
// custom-last-message test. A multi-turn and an abort-path test were added to
// cover the pruned list's "loop until stop" and "error arrives as an assistant
// message" flows. Kept tests preserve their original titles and semantics.

import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { agentLoop, agentLoopContinue } from "../src/agent-loop.ts";
import { setDefaultStreamFn } from "../src/index.ts";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
} from "../src/types.ts";
import {
	MockAssistantStream,
	createAssistantMessage,
	createModel,
	createTextMessage,
	createToolCall,
	createToolUseMessage,
	createUserMessage,
	identityConverter,
} from "./helpers/mock-stream.ts";

describe("default stream function compatibility", () => {
	it("uses the configured default when a legacy caller omits streamFn", async () => {
		let calls = 0;
		setDefaultStreamFn(() => {
			calls++;
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "done", reason: "stop", message: createTextMessage("fallback") });
			});
			return stream;
		});

		try {
			const context: AgentContext = { messages: [], tools: [] };
			const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter };
			const stream = agentLoop([createUserMessage("Hello")], context, config, undefined);

			for await (const _event of stream) {
				// consume
			}
			await stream.result();
			expect(calls).toBe(1);
		} finally {
			setDefaultStreamFn(undefined);
		}
	});
});

describe("agentLoop with AgentMessage", () => {
	it("should emit events with AgentMessage types", async () => {
		const context: AgentContext = {
			messages: [],
			tools: [],
		};

		const userPrompt = createUserMessage("Hello");

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "done", reason: "stop", message: createTextMessage("Hi there!") });
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);

		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();

		// Should have user message and assistant message
		expect(messages.length).toBe(2);
		expect(messages[0]?.role).toBe("user");
		expect(messages[1]?.role).toBe("assistant");

		// Verify event sequence
		const eventTypes = events.map((e) => e.type);
		expect(eventTypes).toContain("agent_start");
		expect(eventTypes).toContain("turn_start");
		expect(eventTypes).toContain("message_start");
		expect(eventTypes).toContain("message_end");
		expect(eventTypes).toContain("turn_end");
		expect(eventTypes).toContain("agent_end");
	});

	it("should build provider context exclusively from transcript messages", async () => {
		const initialSystem: AgentMessage = {
			role: "system",
			content: "Transcript prompt",
			timestamp: 1,
		};
		const context: AgentContext = {
			messages: [],
			tools: [],
		};
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};
		const stream = agentLoop(
			[initialSystem, createUserMessage("Hello")],
			context,
			config,
			undefined,
			(_model, providerContext) => {
				// The provider receives a transcript: no top-level prompt or tool fields.
				expect(Object.keys(providerContext)).toEqual(["messages"]);
				expect(providerContext.messages[0]).toBe(initialSystem);
				const response = new MockAssistantStream();
				queueMicrotask(() => {
					response.push({ type: "done", reason: "stop", message: createTextMessage("done") });
				});
				return response;
			},
		);

		await stream.result();
	});

	it("should handle tool calls and results", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const executed: string[] = [];
		const toolUsage = {
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			totalTokens: 10,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
		};
		const patchedToolUsage = {
			input: 5,
			output: 6,
			cacheRead: 7,
			cacheWrite: 8,
			totalTokens: 26,
			cost: { input: 0.5, output: 0.6, cacheRead: 0.7, cacheWrite: 0.8, total: 2.6 },
		};
		let observedToolUsage: typeof toolUsage | undefined;
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.value);
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
					usage: toolUsage,
				};
			},
		};

		const context: AgentContext = {
			messages: [],
			tools: [tool],
		};

		const userPrompt = createUserMessage("echo something");

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			afterToolCall: async ({ result }) => {
				observedToolUsage = result.usage;
				return { usage: patchedToolUsage };
			},
		};

		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					// First call: return tool call
					stream.push({
						type: "done",
						reason: "toolUse",
						message: createToolUseMessage([createToolCall("tool-1", "echo", { value: "hello" })]),
					});
				} else {
					// Second call: return final response
					stream.push({ type: "done", reason: "stop", message: createTextMessage("done") });
				}
				callIndex++;
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);

		for await (const event of stream) {
			events.push(event);
		}

		// Tool should have been executed
		expect(executed).toEqual(["hello"]);

		// Should have tool execution events
		const toolStart = events.find((e) => e.type === "tool_execution_start");
		const toolEnd = events.find((e) => e.type === "tool_execution_end");
		expect(toolStart).toBeDefined();
		expect(toolEnd).toBeDefined();
		if (toolEnd?.type === "tool_execution_end") {
			expect(toolEnd.isError).toBe(false);
		}
		expect(observedToolUsage).toEqual(toolUsage);
		const messages = await stream.result();
		const toolResult = messages.find((message) => message.role === "toolResult");
		expect(toolResult?.role === "toolResult" ? toolResult.usage : undefined).toEqual(patchedToolUsage);
	});

	it("should loop turns until the model stops", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "tick",
			label: "Tick",
			description: "Tick tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: `ticked: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			messages: [],
			tools: [tool],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		let callIndex = 0;
		const stream = agentLoop([createUserMessage("run")], context, config, undefined, () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex < 2) {
					stream.push({
						type: "done",
						reason: "toolUse",
						message: createToolUseMessage([createToolCall(`tool-${callIndex}`, "tick", { value: String(callIndex) })]),
					});
				} else {
					stream.push({ type: "done", reason: "stop", message: createTextMessage("done") });
				}
				callIndex++;
			});
			return stream;
		});

		for await (const _event of stream) {
			// consume
		}

		const messages = await stream.result();
		expect(callIndex).toBe(3);
		expect(messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"assistant",
			"toolResult",
			"assistant",
		]);
	});

	it("should stop after a blocked tool call when beforeToolCall sets terminate=true", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		let executed = false;
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute() {
				executed = true;
				return {
					content: [{ type: "text", text: "should not execute" }],
					details: { value: "unexpected" },
				};
			},
		};
		const context: AgentContext = {
			messages: [],
			tools: [tool],
		};
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			beforeToolCall: async () => ({ block: true, reason: "Blocked by policy", terminate: true }),
		};

		let llmCalls = 0;
		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, () => {
			llmCalls++;
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				const message =
					llmCalls === 1
						? createToolUseMessage([createToolCall("tool-1", "echo", { value: "hello" })])
						: createTextMessage("should not run");
				mockStream.push({ type: "done", reason: llmCalls === 1 ? "toolUse" : "stop", message });
			});
			return mockStream;
		});

		for await (const _event of stream) {
			// consume
		}

		const messages = await stream.result();
		const toolResult = messages.find((message) => message.role === "toolResult");
		expect(executed).toBe(false);
		expect(llmCalls).toBe(1);
		expect(toolResult?.role === "toolResult" ? toolResult.isError : false).toBe(true);
		expect(toolResult?.role === "toolResult" ? toolResult.content : []).toContainEqual({
			type: "text",
			text: "Blocked by policy",
		});
	});

	it("should inject queued messages after all tool calls complete", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const executed: string[] = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.value);
				return {
					content: [{ type: "text", text: `ok:${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			messages: [],
			tools: [tool],
		};

		const userPrompt = createUserMessage("start");
		const queuedUserMessage = createUserMessage("interrupt");

		let queuedDelivered = false;
		let callIndex = 0;
		let sawInterruptInContext = false;

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			toolExecution: "sequential",
			getSteeringMessages: async () => {
				// Return steering message after tool execution has started.
				if (executed.length >= 1 && !queuedDelivered) {
					queuedDelivered = true;
					return [queuedUserMessage];
				}
				return [];
			},
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([userPrompt], context, config, undefined, (_model, ctx, _options) => {
			// Check if interrupt message is in context on second call
			if (callIndex === 1) {
				sawInterruptInContext = ctx.messages.some(
					(m) => m.role === "user" && typeof m.content === "string" && m.content === "interrupt",
				);
			}

			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					// First call: return two tool calls
					mockStream.push({
						type: "done",
						reason: "toolUse",
						message: createToolUseMessage([
							createToolCall("tool-1", "echo", { value: "first" }),
							createToolCall("tool-2", "echo", { value: "second" }),
						]),
					});
				} else {
					// Second call: return final response
					mockStream.push({ type: "done", reason: "stop", message: createTextMessage("done") });
				}
				callIndex++;
			});
			return mockStream;
		});

		for await (const event of stream) {
			events.push(event);
		}

		// Both tools should execute before steering is injected
		expect(executed).toEqual(["first", "second"]);

		const toolEnds = events.filter(
			(e): e is Extract<AgentEvent, { type: "tool_execution_end" }> => e.type === "tool_execution_end",
		);
		expect(toolEnds.length).toBe(2);
		expect(toolEnds[0]?.isError).toBe(false);
		expect(toolEnds[1]?.isError).toBe(false);

		// Queued message should appear in events after both tool result messages
		const eventSequence = events.flatMap((event) => {
			if (event.type !== "message_start") return [];
			if (event.message.role === "toolResult") return [`tool:${event.message.toolCallId}`];
			if (event.message.role === "user" && typeof event.message.content === "string") {
				return [event.message.content];
			}
			return [];
		});
		expect(eventSequence).toContain("interrupt");
		expect(eventSequence.indexOf("tool:tool-1")).toBeLessThan(eventSequence.indexOf("interrupt"));
		expect(eventSequence.indexOf("tool:tool-2")).toBeLessThan(eventSequence.indexOf("interrupt"));

		// Interrupt message should be in context when second LLM call is made
		expect(sawInterruptInContext).toBe(true);
	});

	it("should surface an aborted stream as an assistant message with stopReason aborted", async () => {
		const context: AgentContext = {
			messages: [],
			tools: [],
		};
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("Hello")], context, config, undefined, () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: createTextMessage("") });
				stream.push({
					type: "error",
					reason: "aborted",
					error: createAssistantMessage([{ type: "text", text: "Aborted" }], "aborted"),
				});
			});
			return stream;
		});

		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();
		expect(messages).toHaveLength(2);
		const assistant = messages[1];
		if (assistant?.role !== "assistant") throw new Error("Expected assistant message");
		expect(assistant.stopReason).toBe("aborted");
		expect(events[events.length - 1]?.type).toBe("agent_end");
	});

	it("should stop after the current turn when shouldStopAfterTurn returns true", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const executed: string[] = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.value);
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			messages: [],
			tools: [tool],
		};

		let steeringPolls = 0;
		let followUpPolls = 0;
		let callbackToolResultIds: string[] = [];
		let callbackContextRoles: string[] = [];
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			getSteeringMessages: async () => {
				steeringPolls++;
				return [];
			},
			getFollowUpMessages: async () => {
				followUpPolls++;
				return [createUserMessage("follow up should stay queued")];
			},
			shouldStopAfterTurn: async ({ message, toolResults, context }) => {
				expect(message.role).toBe("assistant");
				callbackToolResultIds = toolResults.map((toolResult) => toolResult.toolCallId);
				callbackContextRoles = context.messages.map((contextMessage) => contextMessage.role);
				return true;
			},
		};

		let llmCalls = 0;
		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, () => {
			llmCalls++;
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (llmCalls === 1) {
					mockStream.push({
						type: "done",
						reason: "toolUse",
						message: createToolUseMessage([createToolCall("tool-1", "echo", { value: "hello" })]),
					});
				} else {
					mockStream.push({ type: "done", reason: "stop", message: createTextMessage("should not run") });
				}
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();
		expect(llmCalls).toBe(1);
		expect(executed).toEqual(["hello"]);
		expect(steeringPolls).toBe(1);
		expect(followUpPolls).toBe(0);
		expect(callbackToolResultIds).toEqual(["tool-1"]);
		expect(callbackContextRoles).toEqual(["user", "assistant", "toolResult"]);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
		expect(events.map((event) => event.type)).toEqual([
			"agent_start",
			"turn_start",
			"message_start",
			"message_end",
			"message_start",
			"message_end",
			"tool_execution_start",
			"tool_execution_end",
			"message_start",
			"message_end",
			"turn_end",
			"agent_end",
		]);
	});

	it("should emit tool_execution_end in completion order but persist tool results in source order", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		let firstResolved = false;
		let parallelObserved = false;
		let releaseFirst: (() => void) | undefined;
		const firstDone = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				if (params.value === "first") {
					await firstDone;
					firstResolved = true;
				}
				if (params.value === "second") {
					// Second tool started while the first was still suspended: proof of
					// parallel execution. Release the first tool deterministically.
					parallelObserved = !firstResolved;
					releaseFirst?.();
				}
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			messages: [],
			tools: [tool],
		};

		const userPrompt = createUserMessage("echo both");
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			toolExecution: "parallel",
		};

		let callIndex = 0;
		const stream = agentLoop([userPrompt], context, config, undefined, () => {
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createToolUseMessage([
						createToolCall("tool-1", "echo", { value: "first" }),
						createToolCall("tool-2", "echo", { value: "second" }),
					]);
					mockStream.push({ type: "done", reason: "toolUse", message });
				} else {
					mockStream.push({ type: "done", reason: "stop", message: createTextMessage("done") });
				}
				callIndex++;
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		const toolExecutionEndIds = events.flatMap((event) => {
			if (event.type !== "tool_execution_end") {
				return [];
			}
			return [event.toolCallId];
		});
		const toolResultIds = events.flatMap((event) => {
			if (event.type !== "message_end" || event.message.role !== "toolResult") {
				return [];
			}
			return [event.message.toolCallId];
		});
		const turnToolResultIds = events.flatMap((event) => {
			if (event.type !== "turn_end") {
				return [];
			}
			return event.toolResults.map((toolResult) => toolResult.toolCallId);
		});

		expect(parallelObserved).toBe(true);
		expect(toolExecutionEndIds).toEqual(["tool-2", "tool-1"]);
		expect(toolResultIds).toEqual(["tool-1", "tool-2"]);
		expect(turnToolResultIds).toEqual(["tool-1", "tool-2"]);
	});

	it("should force sequential execution when a tool has executionMode=sequential even with default parallel config", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		let firstResolved = false;
		let parallelObserved = false;
		let releaseFirst: (() => void) | undefined;
		const firstDone = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const slowTool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "slow",
			label: "Slow",
			description: "Slow tool",
			parameters: toolSchema,
			executionMode: "sequential",
			async execute(_toolCallId, params) {
				if (params.value === "first") {
					await firstDone;
					firstResolved = true;
				}
				if (params.value === "second" && !firstResolved) {
					parallelObserved = true;
				}
				return {
					content: [{ type: "text", text: `slow: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			messages: [],
			tools: [slowTool],
		};

		const userPrompt = createUserMessage("run both");
		// config is parallel (default), but tool forces sequential
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		let callIndex = 0;
		const stream = agentLoop([userPrompt], context, config, undefined, () => {
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createToolUseMessage([
						createToolCall("tool-1", "slow", { value: "first" }),
						createToolCall("tool-2", "slow", { value: "second" }),
					]);
					mockStream.push({ type: "done", reason: "toolUse", message });
					// Real delay is required here: this test proves the second tool NEVER
					// started while the first was suspended. A tool that must not run has
					// no in-system trigger to release the gate, so a wall-clock window is
					// the only way to observe its absence.
					setTimeout(() => releaseFirst?.(), 20);
				} else {
					mockStream.push({ type: "done", reason: "stop", message: createTextMessage("done") });
				}
				callIndex++;
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		// With sequential execution, second tool should NOT start before first finishes
		expect(parallelObserved).toBe(false);

		const toolResultIds = events.flatMap((event) => {
			if (event.type !== "message_end" || event.message.role !== "toolResult") {
				return [];
			}
			return [event.message.toolCallId];
		});
		expect(toolResultIds).toEqual(["tool-1", "tool-2"]);
	});

	it("should use prepareNextTurn snapshot before continuing", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};
		const context: AgentContext = {
			messages: [],
			tools: [tool],
		};
		let convertedSecondTurnHasUpdate = false;
		let prepareCalls = 0;
		let prepared = false;
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			prepareNextTurn: async ({ context: currentContext }) => {
				prepareCalls++;
				if (prepared) return undefined;
				prepared = true;
				return {
					context: {
						messages: currentContext.messages.slice(),
						tools: currentContext.tools,
					},
					messages: [{ role: "system", content: "updated guidance", timestamp: 1 }],
				};
			},
		};

		let llmCalls = 0;
		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, (_model, ctx) => {
			llmCalls++;
			if (llmCalls === 2) {
				convertedSecondTurnHasUpdate = ctx.messages.some(
					(message) => message.role === "system" && message.content === "updated guidance",
				);
			}
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (llmCalls === 1) {
					mockStream.push({
						type: "done",
						reason: "toolUse",
						message: createToolUseMessage([createToolCall("tool-1", "echo", { value: "hello" })]),
					});
				} else {
					mockStream.push({ type: "done", reason: "stop", message: createTextMessage("done") });
				}
			});
			return mockStream;
		});

		for await (const _event of stream) {
			// consume
		}

		expect(llmCalls).toBe(2);
		expect(prepareCalls).toBe(1);
		expect(convertedSecondTurnHasUpdate).toBe(true);
	});
});

describe("agentLoopContinue with AgentMessage", () => {
	it("should throw when context has no messages", () => {
		const context: AgentContext = {
			messages: [],
			tools: [],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		expect(() =>
			agentLoopContinue(context, config, undefined, () => {
				throw new Error("Unexpected stream call");
			}),
		).toThrow("Cannot continue: no messages in context");
	});

	it("should continue from existing context without emitting user message events", async () => {
		const userMessage = createUserMessage("Hello");

		const context: AgentContext = {
			messages: [userMessage],
			tools: [],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "done", reason: "stop", message: createTextMessage("Response") });
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoopContinue(context, config, undefined, streamFn);

		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();

		// Should only return the new assistant message (not the existing user message)
		expect(messages.length).toBe(1);
		expect(messages[0]?.role).toBe("assistant");

		// Should NOT have user message events (that's the key difference from agentLoop)
		const messageEndEvents = events.filter((e) => e.type === "message_end");
		expect(messageEndEvents.length).toBe(1);
		const firstEnd = messageEndEvents[0];
		if (firstEnd?.type !== "message_end") throw new Error("Expected message_end event");
		expect(firstEnd.message.role).toBe("assistant");
	});
});
