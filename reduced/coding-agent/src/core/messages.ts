/**
 * Message types and transformers for the reduced coding agent.
 *
 * Reduced from packages/coding-agent/src/core/messages.ts (196 lines). The custom message
 * roles (bashExecution, custom, branchSummary, compactionSummary) are dropped: AgentMessage
 * in the reduced copy is exactly the four standard LLM roles from reduced/agent. What
 * remains is the LLM boundary transformer (kept for its teaching value: it is the seam
 * where app-level messages become provider messages) and the rendering/replay helpers the
 * SystemMessage.sections patch protocol needs.
 */

import type { AgentMessage, Message, SystemMessage } from "../../../agent/src/index.ts";

// The section patch protocol rides on SystemMessage via declaration merging — the same
// mechanism the original used for its custom message roles. The leading system message of
// a session carries the complete section map; later system messages carry diffs produced
// by diffSystemPromptSections (see system-prompt.ts).
declare module "../../../agent/src/types.ts" {
	interface SystemMessage {
		/**
		 * Section patch: sets or updates a section's rendered text, or null to remove it.
		 * Empty-string sections (a patch that changes nothing in `content`) are valid: the
		 * protocol is carried entirely by this field.
		 */
		sections?: Record<string, string | null>;
	}
}

/**
 * Render a system message as a complete prompt: its content followed by its sections.
 * Mirrors pi-ai's getSystemMessageText; the reduced copy has no provider layer, so the
 * rendering helper lives here next to the message types it renders.
 */
export function getSystemMessageText(message: SystemMessage): string {
	const parts = [message.content];
	for (const text of Object.values(message.sections ?? {})) {
		if (text !== null) parts.push(text);
	}
	return parts.filter((part) => part.length > 0).join("\n\n");
}

/**
 * Fold every system message's section patches in transcript order into the sections the
 * model currently has. Null values are kept: they mean "removed" and are what the diff
 * compares against after a section was dropped.
 */
export function foldSystemSections(messages: AgentMessage[]): Record<string, string | null> {
	const sections: Record<string, string | null> = {};
	for (const message of messages) {
		if (message.role !== "system") continue;
		for (const [name, value] of Object.entries(message.sections ?? {})) {
			sections[name] = value;
		}
	}
	return sections;
}

/**
 * Transform AgentMessages (including any app-declared custom types) to LLM-compatible
 * Messages.
 *
 * This is used by Agent's convertToLlm option (for prompt calls and queued messages).
 * In the reduced copy AgentMessage already is the standard Message union — no custom
 * roles are declared — so the transform is an identity filter over the four standard
 * roles.
 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(message) =>
			message.role === "system" ||
			message.role === "user" ||
			message.role === "assistant" ||
			message.role === "toolResult",
	);
}
