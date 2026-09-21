// Ported from packages/agent/test/agent.test.ts (987 lines), pruned to the reduced
// contract's main flows. Dropped: onPayload/onResponse/transport/thinkingBudgets
// option tests, image prompts, tool-loadout announcement tests (toolsAdded/
// toolsRemoved no longer exist), the tool-update-after-settle pair, the
// subscriber-abort-signal test, sessionId forwarding (the reduced Agent has no
// sessionId option), and the legacy prepareNextTurn signal-callback test.
// Timer-polling in the abort/while-streaming tests was replaced with abort-signal
// listeners and event-driven gates so the tests are deterministic. Kept tests
// preserve their original titles and semantics.

import { describe, expect, it } from "vitest";
import { Agent, type AgentMessage, type StreamFn } from "../src/index.ts";
import {
	MockAssistantStream,
	createAssistantMessage,
	createDeferred,
	createModel,
	createTextMessage,
	createUserMessage,
} from "./helpers/mock-stream.ts";

const unusedStreamFunction: StreamFn = () => {
	throw new Error("Unexpected stream call");
};

/**
 * Agent whose stream waits for the run's abort signal, then pushes the aborted
 * error event. The listener is attached with an `aborted` guard so aborting before
 * the microtask runs is still observed deterministically.
 */
function createAbortableAgent() {
	let abortSignal: AbortSignal | undefined;
	const agent = new Agent({
		streamFn: (_model, _context, options) => {
			abortSignal = options?.signal;
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: createTextMessage("") });
				const signal = options?.signal;
				const pushAbort = () => {
					stream.push({
					type: "error",
					reason: "aborted",
					error: createAssistantMessage([{ type: "text", text: "Aborted" }], "aborted"),
				});
				};
				if (signal?.aborted) pushAbort();
				else signal?.addEventListener("abort", pushAbort);
			});
			return stream;
		},
	});
	return { agent, getSignal: () => abortSignal };
}

describe("Agent", () => {
	it("should create an agent instance with default state", () => {
		const agent = new Agent({ streamFn: unusedStreamFunction });

		expect(agent.state).toBeDefined();
		expect(agent.state.model).toBeDefined();
		expect(agent.state.thinkingLevel).toBe("off");
		expect(agent.state.tools).toEqual([]);
		expect(agent.state.messages).toEqual([]);
		expect(agent.state.isStreaming).toBe(false);
		expect(agent.state.streamingMessage).toBe(undefined);
		expect(agent.state.pendingToolCalls).toEqual(new Set());
		expect(agent.state.errorMessage).toBeUndefined();
	});

	it("should create an agent instance with custom initial state", () => {
		const customModel = createModel();
		const agent = new Agent({
			streamFn: unusedStreamFunction,
			initialState: {
				systemPrompt: "You are a helpful assistant.",
				model: customModel,
				thinkingLevel: "low",
			},
		});

		expect(agent.state.messages).toEqual([{ role: "system", content: "You are a helpful assistant.", timestamp: 0 }]);
		expect(agent.state.model).toBe(customModel);
		expect(agent.state.thinkingLevel).toBe("low");
	});

	it("emits full lifecycle events for thrown run failures", async () => {
		const agent = new Agent({
			streamFn: () => {
				throw new Error("provider exploded");
			},
		});
		const events: string[] = [];
		agent.subscribe((event) => {
			events.push(event.type);
		});

		await agent.prompt("hello");

		expect(events).toEqual([
			"agent_start",
			"turn_start",
			"message_start",
			"message_end",
			"message_start",
			"message_end",
			"turn_end",
			"agent_end",
		]);
		const lastMessage = agent.state.messages[agent.state.messages.length - 1];
		expect(lastMessage?.role).toBe("assistant");
		if (lastMessage?.role !== "assistant") throw new Error("Expected assistant message");
		expect(lastMessage.stopReason).toBe("error");
		expect(lastMessage.errorMessage).toBe("provider exploded");
		expect(agent.state.errorMessage).toBe("provider exploded");
	});

	it("should await async subscribers before prompt resolves", async () => {
		const barrier = createDeferred();
		const agent = new Agent({
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createTextMessage("ok") });
				});
				return stream;
			},
		});

		const started = createDeferred();
		let listenerFinished = false;
		agent.subscribe((event) => {
			if (event.type === "agent_start") started.resolve();
		});
		agent.subscribe(async (event) => {
			if (event.type === "agent_end") {
				await barrier.promise;
				listenerFinished = true;
			}
		});

		let promptResolved = false;
		const promptPromise = agent.prompt("hello").then(() => {
			promptResolved = true;
		});

		// The run is active as soon as agent_start fires; the held barrier keeps it open.
		await started.promise;
		expect(promptResolved).toBe(false);
		expect(listenerFinished).toBe(false);
		expect(agent.state.isStreaming).toBe(true);

		barrier.resolve();
		await promptPromise;

		expect(listenerFinished).toBe(true);
		expect(promptResolved).toBe(true);
		expect(agent.state.isStreaming).toBe(false);

		// Prompt appended the user message and the assistant reply to the transcript.
		expect(agent.state.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
	});

	it("waitForIdle should wait for async subscribers", async () => {
		const barrier = createDeferred();
		const agent = new Agent({
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createTextMessage("ok") });
				});
				return stream;
			},
		});

		const started = createDeferred();
		agent.subscribe((event) => {
			if (event.type === "agent_start") started.resolve();
			if (event.type === "message_end" && event.message.role === "assistant") {
				return barrier.promise;
			}
		});

		const promptPromise = agent.prompt("hello");
		await started.promise;

		let idleResolved = false;
		const idlePromise = agent.waitForIdle().then(() => {
			idleResolved = true;
		});

		// Flush pending microtasks: the barrier is still held, so idle cannot resolve.
		await Promise.resolve();
		expect(idleResolved).toBe(false);
		expect(agent.state.isStreaming).toBe(true);

		barrier.resolve();
		await Promise.all([promptPromise, idlePromise]);

		expect(idleResolved).toBe(true);
		expect(agent.state.isStreaming).toBe(false);
	});

	it("should reject reset while processing without corrupting the transcript", async () => {
		const streamStarted = createDeferred();
		const releaseResponse = createDeferred();
		const agent = new Agent({
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(async () => {
					stream.push({ type: "start", partial: createTextMessage("") });
					streamStarted.resolve();
					await releaseResponse.promise;
					stream.push({ type: "done", reason: "stop", message: createTextMessage("Done") });
				});
				return stream;
			},
		});

		const promptPromise = agent.prompt("Hello");
		await streamStarted.promise;

		try {
			expect(agent.state.isStreaming).toBe(true);
			expect(agent.state.messages.map((message) => message.role)).toEqual(["user"]);
			expect(() => agent.reset()).toThrow("Agent is already processing. Wait for completion before resetting.");
			expect(agent.state.isStreaming).toBe(true);
			expect(agent.state.messages.map((message) => message.role)).toEqual(["user"]);
		} finally {
			releaseResponse.resolve();
			await promptPromise;
		}

		expect(agent.state.isStreaming).toBe(false);
		expect(agent.state.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
	});

	it("restores the transcript baseline when reset", () => {
		const agent = new Agent({
			initialState: { systemPrompt: "You are helpful." },
			streamFn: unusedStreamFunction,
		});

		agent.state.messages = [...agent.state.messages, createUserMessage("old"), createTextMessage("reply")];
		agent.reset();

		expect(agent.state.messages).toEqual([{ role: "system", content: "You are helpful.", timestamp: 0 }]);
	});

	it("should throw when prompt() called while streaming", async () => {
		const { agent } = createAbortableAgent();

		const started = createDeferred();
		agent.subscribe((event) => {
			if (event.type === "agent_start") started.resolve();
		});

		// Start first prompt (it blocks until abort because the stream waits for the signal)
		const firstPrompt = agent.prompt("First message");
		await started.promise;
		expect(agent.state.isStreaming).toBe(true);

		// Second prompt should reject
		await expect(agent.prompt("Second message")).rejects.toThrow(
			"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
		);

		// Cleanup - abort to stop the stream
		agent.abort();
		await firstPrompt.catch(() => {}); // Ignore abort error
	});

	it("continue() should process queued follow-up messages after an assistant turn", async () => {
		const agent = new Agent({
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createTextMessage("Processed") });
				});
				return stream;
			},
		});

		const initialUser: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "Initial" }],
			timestamp: Date.now() - 10,
		};
		agent.state.messages = [initialUser, createTextMessage("Initial response")];

		agent.followUp({
			role: "user",
			content: [{ type: "text", text: "Queued follow-up" }],
			timestamp: Date.now(),
		});

		await expect(agent.continue()).resolves.toBeUndefined();

		const hasQueuedFollowUp = agent.state.messages.some((message) => {
			if (message.role !== "user") return false;
			if (typeof message.content === "string") return message.content === "Queued follow-up";
			return message.content.some((part) => part.type === "text" && part.text === "Queued follow-up");
		});

		expect(hasQueuedFollowUp).toBe(true);
		expect(agent.state.messages[agent.state.messages.length - 1]?.role).toBe("assistant");
	});

	it("continue() should keep one-at-a-time steering semantics from assistant tail", async () => {
		let responseCount = 0;
		const agent = new Agent({
			streamFn: () => {
				const stream = new MockAssistantStream();
				responseCount++;
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createTextMessage(`Processed ${responseCount}`) });
				});
				return stream;
			},
		});

		const initialUser: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "Initial" }],
			timestamp: Date.now() - 10,
		};
		agent.state.messages = [initialUser, createTextMessage("Initial response")];

		agent.steer({
			role: "user",
			content: [{ type: "text", text: "Steering 1" }],
			timestamp: Date.now(),
		});
		agent.steer({
			role: "user",
			content: [{ type: "text", text: "Steering 2" }],
			timestamp: Date.now() + 1,
		});

		await expect(agent.continue()).resolves.toBeUndefined();

		const recentMessages = agent.state.messages.slice(-4);
		expect(recentMessages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
		expect(responseCount).toBe(2);
	});

	it("drains all queued steering messages in one turn when steeringMode is all", async () => {
		let responseCount = 0;
		const agent = new Agent({
			steeringMode: "all",
			streamFn: () => {
				const stream = new MockAssistantStream();
				responseCount++;
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createTextMessage(`Processed ${responseCount}`) });
				});
				return stream;
			},
		});

		const initialUser: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "Initial" }],
			timestamp: Date.now() - 10,
		};
		agent.state.messages = [initialUser, createTextMessage("Initial response")];

		agent.steer({
			role: "user",
			content: [{ type: "text", text: "Steering 1" }],
			timestamp: Date.now(),
		});
		agent.steer({
			role: "user",
			content: [{ type: "text", text: "Steering 2" }],
			timestamp: Date.now() + 1,
		});

		await expect(agent.continue()).resolves.toBeUndefined();

		// Both steering messages are injected together and answered by a single turn.
		expect(responseCount).toBe(1);
		const recentMessages = agent.state.messages.slice(-3);
		expect(recentMessages.map((m) => m.role)).toEqual(["user", "user", "assistant"]);
	});

	it("should abort a run and settle with an aborted assistant message", async () => {
		const { agent, getSignal } = createAbortableAgent();

		const started = createDeferred();
		agent.subscribe((event) => {
			if (event.type === "agent_start") started.resolve();
		});

		const promptPromise = agent.prompt("hello");
		await started.promise;

		agent.abort();
		await promptPromise;

		expect(agent.state.isStreaming).toBe(false);
		expect(getSignal()?.aborted).toBe(true);
		const lastMessage = agent.state.messages[agent.state.messages.length - 1];
		if (lastMessage?.role !== "assistant") throw new Error("Expected assistant message");
		expect(lastMessage.stopReason).toBe("aborted");
	});
});
