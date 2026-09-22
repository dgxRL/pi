// Port of packages/coding-agent/test/suite/agent-session-prompt.test.ts — the
// kept subset per the reduction spec: idle text response, tool-call turns,
// multi-tool continuation, and the missing-model error. Image, skill/template,
// extension, and input-handler tests are dropped with the features they pin.

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "../../agent/src/index.ts";
import { fauxAssistantMessage, fauxToolCall } from "../../ai/src/index.ts";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSession } from "../src/index.ts";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "./harness.ts";

/** Role sequence with the injected system message filtered out: the reduced
 * session prepends one only when a system prompt or tools are declared, so the
 * transcript shape under test is the user/assistant/toolResult spine. */
function getTurnRoles(harness: Harness): string[] {
	return harness.session.messages
		.filter((message) => message.role !== "system")
		.map((message) => message.role);
}

function stringParam(params: unknown, key: string): string {
	return typeof params === "object" && params !== null && key in params ? String((params as Record<string, unknown>)[key]) : "";
}

describe("AgentSession prompt", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("prompts while idle and records a single text response", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("hello")]);

		await harness.session.prompt("hi");

		expect(getTurnRoles(harness)).toEqual(["user", "assistant"]);
		expect(getUserTexts(harness)).toEqual(["hi"]);
		expect(getAssistantTexts(harness)).toEqual(["hello"]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("handles a tool call turn and waits for the follow-up LLM response", async () => {
		const toolRuns: string[] = [];
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = stringParam(params, "text");
				toolRuns.push(text);
				return {
					content: [{ type: "text", text: `echo:${text}` }],
					details: { text },
				};
			},
		};
		const harness = await createHarness({ tools: [echoTool], toolNames: ["echo"] });
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hello" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("start");

		expect(toolRuns).toEqual(["hello"]);
		expect(getTurnRoles(harness)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		// The tool-call assistant message carries no text; the follow-up says "done".
		expect(getAssistantTexts(harness).filter((text) => text.length > 0)).toEqual(["done"]);
	});

	it("executes multiple tool calls from one response and continues with a single follow-up response", async () => {
		const toolRuns: string[] = [];
		const makeTool = (name: string): AgentTool => ({
			name,
			label: name,
			description: `${name} tool`,
			parameters: Type.Object({ value: Type.String() }),
			execute: async (_toolCallId, params) => {
				const value = stringParam(params, "value");
				toolRuns.push(`${name}:${value}`);
				return {
					content: [{ type: "text", text: `${name}:${value}` }],
					details: { value },
				};
			},
		});
		const harness = await createHarness({ tools: [makeTool("slow"), makeTool("fast")], toolNames: ["slow", "fast"] });
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("slow", { value: "a" }), fauxToolCall("fast", { value: "b" })], {
				stopReason: "toolUse",
			}),
			(context) => {
				const toolResults = context.messages.filter((message) => message.role === "toolResult");
				return fauxAssistantMessage(`tool results: ${toolResults.length}`);
			},
		]);

		await harness.session.prompt("run tools");

		expect(toolRuns.sort()).toEqual(["fast:b", "slow:a"]);
		expect(harness.session.messages.filter((message) => message.role === "toolResult")).toHaveLength(2);
		expect(getAssistantTexts(harness).filter((text) => text.length > 0)).toEqual(["tool results: 2"]);
	});

	it("surfaces a missing streamFn as an error assistant message", async () => {
		const tempDir = join(tmpdir(), `pi-reduced-nomodel-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		// Reduced adaptation: the model is always resolved to a placeholder, so the
		// missing capability surfaces when the agent loop asks for a stream. The
		// StreamFn contract routes failures through the loop as error messages.
		const { session } = await createAgentSession({ cwd: tempDir });

		try {
			await session.prompt("hi");
			const errorAssistant = session.messages.find(
				(message) => message.role === "assistant" && message.stopReason === "error",
			);
			expect(errorAssistant).toBeDefined();
			expect(
				errorAssistant?.role === "assistant" && errorAssistant.errorMessage?.includes("No stream function"),
			).toBe(true);
		} finally {
			session.dispose();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
