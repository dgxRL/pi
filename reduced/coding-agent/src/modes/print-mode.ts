/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Reduced from packages/coding-agent/src/modes/print-mode.ts (169 lines):
 * no extension binding, no session rebinding, no signal handlers, no raw
 * stdout guard. Text output goes through process.stdout directly; JSON output
 * keeps backpressure handling via a serialized write chain.
 */

import type { AssistantMessage } from "../../../agent/src/index.ts";
import type { AgentSession, AgentSessionEvent } from "../core/agent-session.ts";
import { toJsonEvent } from "./json-event.ts";

/**
 * Options for print mode.
 */
export interface PrintModeOptions {
	/** Output mode: "text" for final response only (default), "json" for all events */
	mode?: "text" | "json";
	/** Array of additional prompts to send after initialMessage */
	messages?: string[];
	/** First message to send (may contain @file content) */
	initialMessage?: string;
}

/**
 * Run in print (single-shot) mode.
 * Sends prompts to the agent and outputs the result.
 */
export async function runPrintMode(session: AgentSession, options: PrintModeOptions = {}): Promise<number> {
	const { mode = "text", messages = [], initialMessage } = options;
	let exitCode = 0;
	let unsubscribe: (() => void) | undefined;
	let lastAssistantMessage: AssistantMessage | undefined;
	let writeChain: Promise<void> = Promise.resolve();

	// JSON mode: serialize event writes so that when process.stdout.write
	// reports backpressure (returns false) the next line waits for "drain".
	const enqueueWrite = (text: string): void => {
		writeChain = writeChain.then(async () => {
			if (!process.stdout.write(text)) {
				await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
			}
		});
	};

	unsubscribe = session.subscribe((event: AgentSessionEvent) => {
		if (event.type === "message_end" && event.message.role === "assistant") {
			lastAssistantMessage = event.message;
		}
		if (mode === "json") {
			enqueueWrite(`${JSON.stringify(toJsonEvent(event))}\n`);
		}
	});

	try {
		if (initialMessage) {
			await session.prompt(initialMessage);
		}

		for (const message of messages) {
			await session.prompt(message);
		}

		if (mode === "text") {
			const assistantMsg = lastAssistantMessage;

			if (assistantMsg?.stopReason === "error" || assistantMsg?.stopReason === "aborted") {
				console.error(assistantMsg.errorMessage || `Request ${assistantMsg.stopReason}`);
				exitCode = 1;
				process.exitCode = 1;
			} else if (assistantMsg) {
				for (const content of assistantMsg.content) {
					if (content.type === "text") {
						process.stdout.write(`${content.text}\n`);
					}
				}
			}
		}

		await writeChain;
		return exitCode;
	} catch (error: unknown) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
		return 1;
	} finally {
		unsubscribe?.();
		session.dispose();
	}
}
