// Port of packages/coding-agent/test/print-mode.test.ts, adapted to the
// reduced runPrintMode(session, {mode, messages}) driving a real harness
// session instead of the original's mock runtime host. The reduced contract:
// text mode prints the last assistant text on stdout; error/aborted stop
// reasons log to console.error and set process.exitCode = 1; json mode writes
// one JSON.stringify(toJsonEvent(event)) line per session event.

import { fauxAssistantMessage } from "../../ai/src/index.ts";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { runPrintMode } from "../src/index.ts";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";

describe("runPrintMode", () => {
	const harnesses: Harness[] = [];
	const savedExitCodes: Array<string | number | null | undefined> = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		vi.restoreAllMocks();
		while (savedExitCodes.length > 0) {
			process.exitCode = savedExitCodes.pop();
		}
	});

	function pinExitCode(): void {
		savedExitCodes.push(process.exitCode);
		process.exitCode = 0;
	}

	function stdoutText(spy: MockInstance): string {
		return spy.mock.calls.map((call) => String(call[0])).join("");
	}

	it("prints the last assistant text in text mode and leaves the exit code at 0", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		pinExitCode();

		await runPrintMode(harness.session, { mode: "text", messages: ["Say done"] });

		expect(process.exitCode).toBe(0);
		expect(stdoutText(stdoutSpy)).toContain("done");
		expect(getUserTexts(harness)).toEqual(["Say done"]);
	});

	it("logs the error message and sets exit code 1 on an error stop reason", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("failed", { stopReason: "error", errorMessage: "provider failure" }),
		]);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		pinExitCode();

		await runPrintMode(harness.session, { mode: "text", messages: ["go"] });

		expect(process.exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith("provider failure");
	});

	it("sets exit code 1 on an aborted stop reason", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("partial", { stopReason: "aborted", errorMessage: "aborted" })]);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		pinExitCode();

		await runPrintMode(harness.session, { mode: "text", messages: ["go"] });

		expect(process.exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith("aborted");
	});

	it("emits one JSON event line per session event in json mode", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("hello")]);
		const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		pinExitCode();

		await runPrintMode(harness.session, { mode: "json", messages: ["respond"] });

		expect(process.exitCode).toBe(0);
		const lines = stdoutText(stdoutSpy)
			.split("\n")
			.filter((line) => line.trim().length > 0);
		expect(lines.length).toBeGreaterThan(0);

		const events = lines.map((line) => JSON.parse(line));
		// Every line is a serialized session event, delta-only for message updates.
		const updates = events.filter((event) => event.type === "message_update");
		expect(updates.length).toBeGreaterThan(0);
		for (const update of updates) {
			expect(update).not.toHaveProperty("message");
		}
		// The final assistant text arrives on a message_end event.
		const endEvent = events.find(
			(event) => event.type === "message_end" && event.message.role === "assistant",
		);
		expect(endEvent).toBeDefined();
		expect(JSON.stringify(endEvent.message.content)).toContain("hello");
	});
});
