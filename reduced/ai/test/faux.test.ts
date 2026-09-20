import { afterEach, describe, expect, it } from "vitest";
import { Type } from "typebox";
import { complete, stream } from "../src/registry.ts";
import {
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	registerFauxProvider,
} from "../src/faux.ts";
import type { AssistantMessageEvent, Context } from "../src/types.ts";
import type { AssistantMessageEventStream } from "../src/event-stream.ts";

async function collectEvents(streamResult: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of streamResult) {
		events.push(event);
	}
	return events;
}

const registrations: Array<{ unregister: () => void }> = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) {
		registration.unregister();
	}
});

describe("faux provider", () => {
	it("registers a custom provider and estimates usage", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([fauxAssistantMessage("hello world")]);

		const context: Context = {
			systemPrompt: "Be concise.",
			messages: [{ role: "user", content: "hi there", timestamp: Date.now() }],
		};

		const response = await complete(registration.getModel(), context);
		expect(response.content).toEqual([{ type: "text", text: "hello world" }]);
		expect(response.usage.input).toBeGreaterThan(0);
		expect(response.usage.output).toBeGreaterThan(0);
		expect(response.usage.totalTokens).toBe(response.usage.input + response.usage.output);
		expect(registration.state.callCount).toBe(1);

		const custom = registerFauxProvider({
			api: "faux",
			provider: "faux-provider",
			models: [{ id: "faux-model" }],
		});
		registrations.push(custom);
		custom.setResponses([fauxAssistantMessage("hello")]);

		const rewritten = await complete(custom.getModel(), {
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		});

		expect(rewritten.api).toBe("faux");
		expect(rewritten.provider).toBe("faux-provider");
		expect(rewritten.model).toBe("faux-model");
	});

	it("supports helper blocks for text, thinking, and tool calls", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([
			fauxAssistantMessage([fauxThinking("think"), fauxToolCall("echo", { text: "hi" }), fauxText("done")], {
				stopReason: "toolUse",
			}),
		]);

		const response = await complete(registration.getModel(), {
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		});

		expect(response.content).toEqual([
			{ type: "thinking", thinking: "think" },
			{ type: "toolCall", id: expect.any(String), name: "echo", arguments: { text: "hi" } },
			{ type: "text", text: "done" },
		]);
		expect(response.stopReason).toBe("toolUse");
	});

	it("consumes queued responses in order and errors when exhausted", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

		const context: Context = {
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		};

		const first = await complete(registration.getModel(), context);
		const second = await complete(registration.getModel(), context);
		const exhausted = await complete(registration.getModel(), context);

		expect(first.content).toEqual([{ type: "text", text: "first" }]);
		expect(second.content).toEqual([{ type: "text", text: "second" }]);
		expect(exhausted.stopReason).toBe("error");
		expect(exhausted.errorMessage).toBe("No more faux responses queued");
		expect(registration.getPendingResponseCount()).toBe(0);
		expect(registration.state.callCount).toBe(3);
	});

	it("emits an error when a response factory throws", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([
			() => {
				throw new Error("boom");
			},
		]);

		const events = await collectEvents(
			stream(registration.getModel(), { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }),
		);

		expect(events).toHaveLength(1);
		expect(events[0].type).toBe("error");
		if (events[0].type === "error") {
			expect(events[0].error.stopReason).toBe("error");
			expect(events[0].error.errorMessage).toBe("boom");
		}
	});

	it("rejects a queued response without a terminal stop reason", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([fauxAssistantMessage("partial", { stopReason: "pending" })]);

		const events = await collectEvents(
			stream(registration.getModel(), { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }),
		);

		expect(events.some((event) => event.type === "done")).toBe(false);
		const terminal = events.at(-1);
		expect(terminal?.type).toBe("error");
		if (terminal?.type === "error") {
			expect(terminal.error.stopReason).toBe("error");
			expect(terminal.error.errorMessage).toBe("Faux response ended without a stop reason");
		}
	});

	it("estimates prompt and output tokens from serialized context", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([fauxAssistantMessage("done")]);

		const tool = {
			name: "echo",
			description: "Echo back text",
			parameters: Type.Object({ text: Type.String() }),
		};
		const context: Context = {
			systemPrompt: "sys",
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "hello" }],
					timestamp: 1,
				},
				fauxAssistantMessage("prior"),
				{
					role: "toolResult",
					toolCallId: "tool-1",
					toolName: "echo",
					content: [{ type: "text", text: "tool out" }],
					isError: false,
					timestamp: 2,
				},
			],
			tools: [tool],
		};

		const response = await complete(registration.getModel(), context);
		const promptText = [
			"system:sys",
			"user:hello",
			"assistant:prior",
			"toolResult:echo\ntool out",
			`tools:${JSON.stringify([tool])}`,
		].join("\n\n");
		const expectedPromptTokens = Math.ceil(promptText.length / 4);
		const expectedOutputTokens = Math.ceil("done".length / 4);

		expect(response.usage.input).toBe(expectedPromptTokens);
		expect(response.usage.output).toBe(expectedOutputTokens);
		expect(response.usage.cacheRead).toBe(0);
		expect(response.usage.cacheWrite).toBe(0);
		expect(response.usage.totalTokens).toBe(expectedPromptTokens + expectedOutputTokens);
	});

	it("simulates prompt caching per sessionId", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

		const context: Context = {
			systemPrompt: "Be concise.",
			messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
		};

		const first = await complete(registration.getModel(), context, {
			sessionId: "session-1",
			cacheRetention: "short",
		});
		expect(first.usage.cacheRead).toBe(0);
		expect(first.usage.cacheWrite).toBeGreaterThan(0);

		context.messages.push(first);
		context.messages.push({ role: "user", content: "follow up", timestamp: Date.now() + 1 });

		const second = await complete(registration.getModel(), context, {
			sessionId: "session-1",
			cacheRetention: "short",
		});
		expect(second.usage.cacheRead).toBeGreaterThan(0);
		expect(second.usage.input + second.usage.cacheRead).toBeGreaterThan(second.usage.input);

		// A different sessionId and a request without sessionId never share cache.
		registration.setResponses([fauxAssistantMessage("third"), fauxAssistantMessage("fourth")]);
		const otherSession = await complete(registration.getModel(), context, {
			sessionId: "session-2",
			cacheRetention: "short",
		});
		expect(otherSession.usage.cacheRead).toBe(0);
		expect(otherSession.usage.cacheWrite).toBeGreaterThan(0);

		const untracked = await complete(registration.getModel(), context);
		expect(untracked.usage.cacheRead).toBe(0);
		expect(untracked.usage.cacheWrite).toBe(0);
	});

	it("streams thinking, text, and partial tool call deltas", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([
			fauxAssistantMessage(
				[
					fauxThinking("thinking text"),
					fauxText("answer text"),
					fauxToolCall("echo", { text: "hi", count: 12 }, { id: "tool-1" }),
				],
				{ stopReason: "toolUse" },
			),
		]);

		const events: string[] = [];
		const toolCallDeltas: string[] = [];
		const s = stream(registration.getModel(), { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] });
		for await (const event of s) {
			events.push(event.type);
			if (event.type === "toolcall_delta") {
				toolCallDeltas.push(event.delta);
			}
		}

		expect(events).toContain("thinking_start");
		expect(events).toContain("thinking_delta");
		expect(events).toContain("text_start");
		expect(events).toContain("text_delta");
		expect(events).toContain("toolcall_start");
		expect(events).toContain("toolcall_delta");
		expect(events).toContain("toolcall_end");
		expect(toolCallDeltas.length).toBeGreaterThan(1);
		expect(JSON.parse(toolCallDeltas.join(""))).toEqual({ text: "hi", count: 12 });
	});

	it("streams an exact event order for fixed-size chunks", async () => {
		const registration = registerFauxProvider({ tokenSize: { min: 1, max: 1 } });
		registrations.push(registration);
		registration.setResponses([
			fauxAssistantMessage([fauxThinking("go"), fauxText("ok"), fauxToolCall("echo", {}, { id: "tool-1" })], {
				stopReason: "toolUse",
			}),
		]);

		const events = await collectEvents(
			stream(registration.getModel(), { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }),
		);

		expect(events[0]).toMatchObject({ type: "start", partial: { stopReason: "pending" } });
		expect(events.map((event) => event.type)).toEqual([
			"start",
			"thinking_start",
			"thinking_delta",
			"thinking_end",
			"text_start",
			"text_delta",
			"text_end",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_end",
			"done",
		]);
	});

	it("streams multiple tool calls in one message", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("echo", { text: "one" }, { id: "tool-1" }),
					fauxToolCall("echo", { text: "two" }, { id: "tool-2" }),
				],
				{ stopReason: "toolUse" },
			),
		]);

		const events = await collectEvents(
			stream(registration.getModel(), { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }),
		);

		expect(events.filter((event) => event.type === "toolcall_start")).toHaveLength(2);
		expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(2);
	});

	it("streams an explicit assistant error message as a terminal error", async () => {
		const registration = registerFauxProvider({ tokenSize: { min: 2, max: 2 } });
		registrations.push(registration);
		registration.setResponses([
			{
				...fauxAssistantMessage("partial"),
				stopReason: "error",
				errorMessage: "upstream failed",
			},
		]);

		const events = await collectEvents(
			stream(registration.getModel(), { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }),
		);

		expect(events.map((event) => event.type)).toEqual(["start", "text_start", "text_delta", "text_end", "error"]);
		const terminal = events[events.length - 1];
		expect(terminal.type).toBe("error");
		if (terminal.type === "error") {
			expect(terminal.reason).toBe("error");
			expect(terminal.error.stopReason).toBe("error");
			expect(terminal.error.errorMessage).toBe("upstream failed");
		}
	});

	it("supports aborting before the first chunk", async () => {
		const registration = registerFauxProvider({ tokensPerSecond: 50, tokenSize: { min: 3, max: 3 } });
		registrations.push(registration);
		registration.setResponses([fauxAssistantMessage("abcdefghijklmnopqrstuvwxyz")]);

		const controller = new AbortController();
		controller.abort();
		const events = await collectEvents(
			stream(
				registration.getModel(),
				{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
				{ signal: controller.signal },
			),
		);

		expect(events).toHaveLength(1);
		expect(events[0].type).toBe("error");
		if (events[0].type === "error") {
			expect(events[0].reason).toBe("aborted");
			expect(events[0].error.stopReason).toBe("aborted");
		}
	});

	it("supports aborting mid-text stream when paced", async () => {
		const registration = registerFauxProvider({ tokensPerSecond: 100, tokenSize: { min: 3, max: 3 } });
		registrations.push(registration);
		registration.setResponses([fauxAssistantMessage("abcdefghijklmnopqrstuvwxyz")]);

		const controller = new AbortController();
		const events: string[] = [];
		let textDeltaCount = 0;
		const s = stream(
			registration.getModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ signal: controller.signal },
		);
		for await (const event of s) {
			events.push(event.type);
			if (event.type === "text_delta") {
				textDeltaCount++;
				controller.abort();
			}
		}

		expect(textDeltaCount).toBe(1);
		expect(events).toContain("text_start");
		expect(events).toContain("text_delta");
		expect(events).toContain("error");
		expect(events).not.toContain("text_end");
	});

	it("unregisters the provider", async () => {
		const registration = registerFauxProvider();
		registration.setResponses([fauxAssistantMessage("hello")]);
		registration.unregister();

		await expect(
			complete(registration.getModel(), { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }),
		).rejects.toThrow(/Unknown provider/);
	});
});
