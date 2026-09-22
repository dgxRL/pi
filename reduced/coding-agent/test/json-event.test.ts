// Merged regressions #7290 (JSON event streams stay linear), #7911 (usage
// retained), and #7925 (tool-call metadata at toolcall_start) pinning the
// toJsonEvent wire contract: message_update events lose the cumulative
// `message` snapshot and its live `partial`, keep cumulative usage, and
// toolcall_start carries the tool call id and name.

import { fauxAssistantMessage, fauxToolCall } from "../../ai/src/index.ts";
import { afterEach, describe, expect, it } from "vitest";
import { toJsonEvent } from "../src/index.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("toJsonEvent wire contract", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("#7290: emits delta-only message updates whose size scales linearly", async () => {
		async function measureUpdateBytes(text: string): Promise<number> {
			const harness = await createHarness();
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage(text)]);

			await harness.session.prompt("respond");

			const sessionUpdates = harness.eventsOfType("message_update");
			for (const update of sessionUpdates) {
				expect(update).toHaveProperty("message");
				expect(update.assistantMessageEvent).toHaveProperty("partial");
			}

			const updates = sessionUpdates.map((event) => toJsonEvent(event));
			expect(updates.length).toBeGreaterThan(0);
			for (const update of updates) {
				expect(update).not.toHaveProperty("message");
				expect(update.assistantMessageEvent).not.toHaveProperty("partial");
			}
			return updates.reduce((bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event)), 0);
		}

		const smallBytes = await measureUpdateBytes("x".repeat(2_000));
		const largeBytes = await measureUpdateBytes("x".repeat(4_000));

		expect(largeBytes).toBeGreaterThan(smallBytes);
		expect(largeBytes / smallBytes).toBeLessThan(2.2);
	});

	it("#7911: includes cumulative usage without cumulative message snapshots", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("hello")]);

		await harness.session.prompt("respond");

		// #7290's delta-only wire projection dropped this fixed-size metadata with the snapshots.
		const update = harness
			.eventsOfType("message_update")
			.find((event) => event.message.role === "assistant" && event.message.usage.totalTokens > 0);
		if (!update || update.message.role !== "assistant") {
			throw new Error("Expected an assistant update with populated usage");
		}

		const wireUpdate = toJsonEvent(update);
		expect(wireUpdate.usage).toEqual(update.message.usage);
		expect(wireUpdate).not.toHaveProperty("message");
		expect(wireUpdate.assistantMessageEvent).not.toHaveProperty("partial");
	});

	it("#7925: includes the tool call id and name without cumulative snapshots", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "output.txt" }, { id: "call_7925" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("read a file");

		const update = harness
			.eventsOfType("message_update")
			.find((event) => event.assistantMessageEvent.type === "toolcall_start");
		if (!update || update.message.role !== "assistant") {
			throw new Error("Expected toolcall_start assistant update");
		}

		expect(toJsonEvent(update)).toEqual({
			type: "message_update",
			usage: update.message.usage,
			assistantMessageEvent: {
				type: "toolcall_start",
				contentIndex: 0,
				id: "call_7925",
				toolName: "read",
			},
		});
	});
});
