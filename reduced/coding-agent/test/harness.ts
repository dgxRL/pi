// Slimmed from packages/coding-agent/test/suite/harness.ts: the reduced
// createAgentSession wires the agent, settings, auth, and tool plumbing
// internally, so the harness only owns a temp cwd, the faux provider, the
// streamFn bridge into the provider registry, and the event recorder.

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool, AssistantMessageEventStream } from "../../agent/src/index.ts";
import {
	registerFauxProvider,
	stream as streamFromRegistry,
	type FauxProviderRegistration,
	type FauxResponseStep,
	type Model,
} from "../../ai/src/index.ts";
import { createAgentSession, type AgentSession, type AgentSessionEvent, SessionManager } from "../src/index.ts";

type MessageTextPart = { type: "text"; text: string };

export function getMessageText(message: unknown): string {
	if (!message || typeof message !== "object" || !("content" in message)) {
		return "";
	}
	const content = (message as { content?: string | Array<{ type: string; text?: string }> }).content;
	if (content === undefined) {
		return "";
	}
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((part): part is MessageTextPart => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

export function getUserTexts(harness: Harness): string[] {
	return harness.session.messages
		.filter((message) => message.role === "user")
		.map((message) => getMessageText(message));
}

export function getAssistantTexts(harness: Harness): string[] {
	return harness.session.messages
		.filter((message) => message.role === "assistant")
		.map((message) => getMessageText(message));
}

export interface HarnessOptions {
	/** Custom tool implementations replacing the builtin tool list. */
	tools?: AgentTool[];
	/** Name allowlist forwarded to createAgentSession; activates custom tools. */
	toolNames?: string[];
	/** Skip the file-backed session manager (in-memory session). */
	noSession?: boolean;
	/** API key handed to the session (faux provider is offline; default "faux-key"). */
	apiKey?: string;
}

export interface Harness {
	session: AgentSession;
	sessionManager: SessionManager | undefined;
	faux: FauxProviderRegistration;
	getModel(): Model;
	setResponses: (responses: FauxResponseStep[]) => void;
	appendResponses: (responses: FauxResponseStep[]) => void;
	getPendingResponseCount: () => number;
	/** Every session event, in order. */
	events: AgentSessionEvent[];
	eventsOfType<T extends AgentSessionEvent["type"]>(type: T): Extract<AgentSessionEvent, { type: T }>[];
	tempDir: string;
	cleanup: () => void;
}

function createTempDir(): string {
	const tempDir = join(tmpdir(), `pi-reduced-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	return tempDir;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
	const tempDir = createTempDir();
	const faux = registerFauxProvider();
	faux.setResponses([]);
	const model = faux.getModel();
	const events: AgentSessionEvent[] = [];

	const sessionManager = options.noSession ? undefined : SessionManager.create(tempDir);
	const { session } = await createAgentSession({
		cwd: tempDir,
		apiKey: options.apiKey ?? "faux-key",
		model: `${model.provider}/${model.id}`,
		baseTools: options.tools,
		tools: options.toolNames,
		sessionManager,
		streamFn: (_streamModel, context, streamOptions) => {
			// The faux provider streams through reduced/ai's event-stream class;
			// the two copies are structurally identical but nominally distinct.
			// reduced/ai and reduced/agent define structurally identical but nominally
			// distinct Message/AssistantMessage types; the bridge cast is the seam.
			const stream = streamFromRegistry(model, context as never, streamOptions);
			return stream as unknown as AssistantMessageEventStream;
		},
	});

	session.subscribe((event) => {
		events.push(event);
	});

	return {
		session,
		sessionManager,
		faux,
		getModel: () => faux.getModel(),
		setResponses: (responses) => faux.setResponses(responses),
		appendResponses: (responses) => faux.appendResponses(responses),
		getPendingResponseCount: () => faux.getPendingResponseCount(),
		events,
		eventsOfType<T extends AgentSessionEvent["type"]>(type: T) {
			return events.filter((event): event is Extract<AgentSessionEvent, { type: T }> => event.type === type);
		},
		tempDir,
		cleanup() {
			session.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		},
	};
}
