/**
 * AgentSession - Core abstraction for agent lifecycle and session management.
 *
 * Reduced from packages/coding-agent/src/core/agent-session.ts (3625 lines). Kept: the
 * session event surface, subscribe/dispose, prompt (queue-if-streaming), steer/followUp/
 * abort/waitForIdle/clearQueue, state accessors, the tool API, model/thinking mutations,
 * getLastAssistantText, and the persistence core (message_end -> sessionManager) with the
 * SystemMessage sections-diff loadout. Dropped: extensions, compaction, retry, tree
 * navigation, bash `!`, skills, scoped models, and the pending custom/bash machinery.
 */

import type {
	Agent,
	AgentEvent,
	AgentMessage,
	AssistantMessage,
	AgentState,
	AgentTool,
	Model,
	SystemMessage,
	ThinkingLevel,
} from "../../../agent/src/index.ts";
import { SessionManager } from "./session-manager.ts";
import type { ToolDefinition } from "./tools/index.ts";
import { foldSystemSections } from "./messages.ts";
import {
	buildSystemPrompt,
	buildSystemPromptSections,
	diffSystemPromptSections,
	normalizeBuildSystemPromptOptions,
	type NormalizedBuildSystemPromptOptions,
} from "./system-prompt.ts";

/** Session-specific events that extend the core AgentEvent */
export type AgentSessionEvent = AgentEvent | { type: "agent_settled" };

/** Listener function for agent session events */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

/** Descriptor for a configured tool, as returned by {@link AgentSession.getAllTools}. */
export interface ToolInfo {
	name: string;
	description: string;
	parameters: ToolDefinition["parameters"];
	promptSnippet?: string;
	promptGuidelines?: readonly string[];
}

export interface AgentSessionConfig {
	agent: Agent;
	sessionManager: SessionManager;
	/**
	 * Tool definitions available to the session. Plain AgentTool instances are accepted:
	 * their promptSnippet/promptGuidelines are simply absent.
	 */
	tools: ToolDefinition[];
	/**
	 * Initial active tool names. When omitted, the loadout is restored from the session
	 * transcript (falling back to [read, bash, edit, write] when it declares none).
	 */
	initialActiveToolNames?: string[];
	/** Overrides agent.state.model when provided. */
	model?: Model;
	/** Overrides agent.state.thinkingLevel when provided. */
	thinkingLevel?: ThinkingLevel;
	/** Custom system prompt replacing the default preamble. */
	systemPrompt?: string;
	/** Text appended to the system prompt. */
	appendSystemPrompt?: string;
}

/** Options for AgentSession.prompt() */
export interface PromptOptions {
	/** When streaming, how to queue the message: "steer" (interrupt) or "followUp" (wait). Required if streaming. */
	streamingBehavior?: "steer" | "followUp";
}

/**
 * 1:1 field copy of a ToolDefinition into the AgentTool shape the agent runtime executes.
 * Prompt metadata (snippet/guidelines) is consumed by the system prompt builder, not the
 * runtime, so it is deliberately not carried over.
 */
function wrapToolDefinition(definition: ToolDefinition): AgentTool {
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		execute: definition.execute,
	};
}

/**
 * Parse the tool names declared by a replayed `tools` system prompt section. The section
 * renders one `- <name>: <snippet>` bullet per tool, followed by a trailing sentence that
 * never starts with `- `.
 */
function parseDeclaredToolNames(sections: Record<string, string | null>): string[] {
	const toolsSection = sections["tools"];
	if (!toolsSection) return [];
	return [...toolsSection.matchAll(/^- ([a-z][a-z0-9_-]*): /gm)].map((match) => match[1]);
}

// ============================================================================
// AgentSession Class
// ============================================================================

export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;

	// Event subscription state
	private _unsubscribeAgent?: () => void;
	private _eventListeners: AgentSessionEventListener[] = [];
	private _isAgentRunActive = false;
	private _idleWaitPromise: Promise<void> | undefined;
	private _resolveIdleWait: (() => void) | undefined;

	/** Tracks pending steering messages for UI display. Removed when delivered. */
	private _steeringMessages: string[] = [];
	/** Tracks pending follow-up messages for UI display. Removed when delivered. */
	private _followUpMessages: string[] = [];

	private _cwd: string;
	private _customPrompt: string | undefined;
	private _appendSystemPrompt: string;

	// Tool registry: the executable AgentTool per name, plus its prompt metadata.
	private _toolDefinitions: Map<string, ToolDefinition> = new Map();
	private _toolRegistry: Map<string, AgentTool> = new Map();
	private _toolPromptSnippets: Map<string, string> = new Map();
	private _toolPromptGuidelines: Map<string, string[]> = new Map();

	private _baseSystemPromptOptions!: NormalizedBuildSystemPromptOptions;

	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this.sessionManager = config.sessionManager;
		this._cwd = config.sessionManager.getCwd();
		this._customPrompt = config.systemPrompt;
		this._appendSystemPrompt = config.appendSystemPrompt ?? "";

		for (const definition of config.tools) {
			this._toolDefinitions.set(definition.name, definition);
			this._toolRegistry.set(definition.name, wrapToolDefinition(definition));
			if (definition.promptSnippet) {
				this._toolPromptSnippets.set(definition.name, definition.promptSnippet);
			}
			if (definition.promptGuidelines?.length) {
				this._toolPromptGuidelines.set(definition.name, [...definition.promptGuidelines]);
			}
		}

		if (config.model) this.agent.state.model = config.model;
		if (config.thinkingLevel) this.agent.state.thinkingLevel = config.thinkingLevel;

		// Always subscribe to agent events for internal handling (session persistence).
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);

		if (config.initialActiveToolNames !== undefined) {
			this.setActiveToolsByName(config.initialActiveToolNames);
		} else {
			this.setActiveToolsByName(["read", "bash", "edit", "write"]);
			this._restoreToolsFromTranscript();
		}
	}

	// =========================================================================
	// Events
	// =========================================================================

	/** Emit an event to all listeners */
	private _emit(event: AgentSessionEvent): void {
		for (const l of this._eventListeners) {
			l(event);
		}
	}

	private _getIdleWaitPromise(): Promise<void> {
		if (!this._idleWaitPromise) {
			const { promise, resolve } = Promise.withResolvers<void>();
			this._idleWaitPromise = promise;
			this._resolveIdleWait = resolve;
		}
		return this._idleWaitPromise;
	}

	private _resolveIdleWaitIfIdle(): void {
		if (!this.isIdle || !this._resolveIdleWait) {
			return;
		}
		const resolve = this._resolveIdleWait;
		this._idleWaitPromise = undefined;
		this._resolveIdleWait = undefined;
		resolve();
	}

	private async _emitAgentSettled(): Promise<void> {
		this._isAgentRunActive = false;
		try {
			this._emit({ type: "agent_settled" });
		} finally {
			this._resolveIdleWaitIfIdle();
		}
	}

	/** Internal handler for agent events - shared by subscribe and reconnect */
	private _handleAgentEvent = async (event: AgentEvent): Promise<void> => {
		// When a user message starts, check if it's from either queue and remove it BEFORE
		// emitting. This ensures listeners see the updated queue state.
		if (event.type === "message_start" && event.message.role === "user") {
			const message =
				typeof event.message.content === "string"
					? event.message.content
					: event.message.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n");
			if (message) {
				// Check steering queue first, then follow-up queue
				const steeringIndex = this._steeringMessages.indexOf(message);
				if (steeringIndex !== -1) {
					this._steeringMessages.splice(steeringIndex, 1);
				} else {
					const followUpIndex = this._followUpMessages.indexOf(message);
					if (followUpIndex !== -1) {
						this._followUpMessages.splice(followUpIndex, 1);
					}
				}
			}
		}

		// Notify all listeners
		this._emit(event);

		// Handle session persistence
		if (event.type === "message_end") {
			if (
				event.message.role === "system" ||
				event.message.role === "user" ||
				event.message.role === "assistant" ||
				event.message.role === "toolResult"
			) {
				// Regular LLM message - persist as a session message entry
				this.sessionManager.appendMessage(event.message);
			}
		}
	};

	/**
	 * Subscribe to agent session events.
	 * Session persistence is handled internally (saves messages on message_end).
	 * Multiple listeners can be added. Returns unsubscribe function for this listener.
	 */
	subscribe(listener: AgentSessionEventListener): () => void {
		this._eventListeners.push(listener);

		// Return unsubscribe function for this specific listener
		return () => {
			const index = this._eventListeners.indexOf(listener);
			if (index !== -1) {
				this._eventListeners.splice(index, 1);
			}
		};
	}

	/** Disconnect from agent events during disposal. */
	private _disconnectFromAgent(): void {
		if (this._unsubscribeAgent) {
			this._unsubscribeAgent();
			this._unsubscribeAgent = undefined;
		}
	}

	/**
	 * Remove all listeners and disconnect from agent.
	 * Call this when completely done with the session.
	 */
	dispose(): void {
		try {
			this.agent.abort();
		} catch {
			// Dispose must succeed even if an abort hook throws.
		}
		this._disconnectFromAgent();
		this._eventListeners = [];
	}

	// =========================================================================
	// Read-only State Access
	// =========================================================================

	/** Full agent state */
	get state(): AgentState {
		return this.agent.state;
	}

	/** Current model */
	get model(): Model {
		return this.agent.state.model;
	}

	/** Current thinking level */
	get thinkingLevel(): ThinkingLevel {
		return this.agent.state.thinkingLevel;
	}

	/** Whether the session is currently processing an agent run or post-run continuation. */
	get isStreaming(): boolean {
		return this._isAgentRunActive;
	}

	/** Whether the session has no active agent run or queued continuation. */
	get isIdle(): boolean {
		return !this._isAgentRunActive;
	}

	/** Current effective system prompt, rendered exactly as the transcript replays it. */
	get systemPrompt(): string {
		return buildSystemPrompt(this._baseSystemPromptOptions);
	}

	/** All messages */
	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	/** Current steering mode */
	get steeringMode(): "all" | "one-at-a-time" {
		return this.agent.steeringMode;
	}

	/** Current follow-up mode */
	get followUpMode(): "all" | "one-at-a-time" {
		return this.agent.followUpMode;
	}

	/** Current session file path, or undefined if sessions are disabled */
	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	/** Current session ID */
	get sessionId(): string {
		return this.sessionManager.getSessionId();
	}

	/**
	 * Get the names of currently active tools.
	 * Returns the names of tools currently set on the agent.
	 */
	getActiveToolNames(): string[] {
		return this.agent.state.tools.map((t) => t.name);
	}

	/**
	 * Get all configured tools with name, description, parameter schema, and prompt metadata.
	 */
	getAllTools(): ToolInfo[] {
		return Array.from(this._toolDefinitions.values()).map((definition) => ({
			name: definition.name,
			description: definition.description,
			parameters: definition.parameters,
			promptSnippet: definition.promptSnippet,
			promptGuidelines: definition.promptGuidelines,
		}));
	}

	getToolDefinition(name: string): ToolDefinition | undefined {
		return this._toolDefinitions.get(name);
	}

	/**
	 * Set active tools by name.
	 * Only tools in the registry can be enabled. Unknown tool names are ignored.
	 * Also rebuilds the system prompt to reflect the new tool set.
	 * Changes take effect on the next agent turn.
	 */
	setActiveToolsByName(toolNames: string[]): void {
		const tools: AgentTool[] = [];
		const validToolNames: string[] = [];
		for (const name of toolNames) {
			const tool = this._toolRegistry.get(name);
			if (tool) {
				tools.push(tool);
				validToolNames.push(name);
			}
		}
		this.agent.state.tools = tools;
		this._rebuildSystemPrompt(validToolNames);
	}

	// =========================================================================
	// System Prompt / Tool Loadout
	// =========================================================================

	private _rebuildSystemPrompt(toolNames: string[]): void {
		const validToolNames = toolNames.filter((name) => this._toolRegistry.has(name));
		this._baseSystemPromptOptions = normalizeBuildSystemPromptOptions({
			cwd: this._cwd,
			tools: validToolNames.map((name) => ({
				name,
				promptSnippet: this._toolPromptSnippets.get(name),
				promptGuidelines: this._toolPromptGuidelines.get(name),
			})),
			customPrompt: this._customPrompt,
			appendSystemPrompt: this._appendSystemPrompt,
		});
	}

	/**
	 * Apply a prompt and tool loadout for the next request. Sets the executable tools and
	 * returns a system message patching the prompt sections the model currently has (replayed
	 * from `messages`), or undefined when the prompt is unchanged. Tool changes are declared
	 * by the leading system message's sections; the runtime tools live on agent state.
	 */
	private _preparePromptAndToolLoadout(
		options: NormalizedBuildSystemPromptOptions,
		messages: AgentMessage[] = this.agent.state.messages,
	): SystemMessage | undefined {
		options.tools = options.tools.filter((tool) => this._toolRegistry.has(tool.name));
		this.agent.state.tools = options.tools.flatMap((tool) => {
			const registered = this._toolRegistry.get(tool.name);
			return registered ? [registered] : [];
		});
		const sections = diffSystemPromptSections(foldSystemSections(messages), buildSystemPromptSections(options));
		return sections ? { role: "system", content: "", sections, timestamp: Date.now() } : undefined;
	}

	/** Restore the active tool loadout declared by the session transcript, if it declares one. */
	private _restoreToolsFromTranscript(): void {
		const sections = foldSystemSections(this.sessionManager.buildSessionContext().messages);
		const toolNames = parseDeclaredToolNames(sections).filter((name) => this._toolRegistry.has(name));
		if (toolNames.length === 0) return;
		this.agent.state.tools = toolNames.flatMap((name) => {
			const registered = this._toolRegistry.get(name);
			return registered ? [registered] : [];
		});
		this._rebuildSystemPrompt(toolNames);
	}

	// =========================================================================
	// Prompting
	// =========================================================================

	private async _runAgentPrompt(messages: AgentMessage | AgentMessage[]): Promise<void> {
		this._isAgentRunActive = true;
		try {
			await this.agent.prompt(messages);
			while (await this._handlePostAgentRun()) {
				await this.agent.continue();
			}
		} finally {
			await this._emitAgentSettled();
		}
	}

	private async _handlePostAgentRun(): Promise<boolean> {
		// The agent loop drains both queues before emitting agent_end. Any messages here
		// were queued at the very end of the run and need a continuation.
		return this.agent.hasQueuedMessages();
	}

	/**
	 * Send a prompt to the agent.
	 * - During streaming, queues via steer() or followUp() based on the streamingBehavior option
	 * - Otherwise applies the prompt/tool loadout (sections diff prepended) and starts a run
	 * @throws Error if streaming and no streamingBehavior specified
	 */
	async prompt(text: string, options?: PromptOptions): Promise<void> {
		// If streaming, queue via steer() or followUp() based on option
		if (this.isStreaming) {
			if (!options?.streamingBehavior) {
				throw new Error(
					"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
				);
			}
			if (options.streamingBehavior === "followUp") {
				this._queueFollowUp(text);
			} else {
				this._queueSteer(text);
			}
			return;
		}

		const messages: AgentMessage[] = [];
		// Apply the prompt and tool loadout: prepend a system message patching the prompt
		// sections the model currently has (replayed from the transcript).
		const updateMessage = this._preparePromptAndToolLoadout(this._baseSystemPromptOptions);
		if (updateMessage) messages.push(updateMessage);

		// Add user message
		messages.push({
			role: "user",
			content: text,
			timestamp: Date.now(),
		});

		await this._runAgentPrompt(messages);
	}

	// =========================================================================
	// Message Queues
	// =========================================================================

	/**
	 * Queue a steering message while the agent is running.
	 * Delivered after the current assistant turn finishes executing its tool calls,
	 * before the next LLM call.
	 */
	steer(text: string): void {
		this._queueSteer(text);
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 * Delivered only when agent has no more tool calls or steering messages.
	 */
	followUp(text: string): void {
		this._queueFollowUp(text);
	}

	/** Internal: Queue a steering message. */
	private _queueSteer(text: string): void {
		this._steeringMessages.push(text);
		this.agent.steer({
			role: "user",
			content: text,
			timestamp: Date.now(),
		});
	}

	/** Internal: Queue a follow-up message. */
	private _queueFollowUp(text: string): void {
		this._followUpMessages.push(text);
		this.agent.followUp({
			role: "user",
			content: text,
			timestamp: Date.now(),
		});
	}

	/**
	 * Clear all queued messages and return them.
	 * Useful for restoring to editor when user aborts.
	 * @returns Object with steering and followUp arrays
	 */
	clearQueue(): { steering: string[]; followUp: string[] } {
		const steering = [...this._steeringMessages];
		const followUp = [...this._followUpMessages];
		this._steeringMessages = [];
		this._followUpMessages = [];
		this.agent.clearAllQueues();
		return { steering, followUp };
	}

	/** Number of pending messages (includes both steering and follow-up) */
	get pendingMessageCount(): number {
		return this._steeringMessages.length + this._followUpMessages.length;
	}

	/** Get pending steering messages (read-only) */
	getSteeringMessages(): readonly string[] {
		return this._steeringMessages;
	}

	/** Get pending follow-up messages (read-only) */
	getFollowUpMessages(): readonly string[] {
		return this._followUpMessages;
	}

	// =========================================================================
	// Lifecycle
	// =========================================================================

	/**
	 * Abort current operation and wait for agent to become idle.
	 */
	async abort(): Promise<void> {
		this.agent.abort();
		await this.waitForIdle();
	}

	async waitForIdle(): Promise<void> {
		if (this.isIdle) {
			return;
		}
		await this._getIdleWaitPromise();
	}

	// =========================================================================
	// Model Management
	// =========================================================================

	/**
	 * Set model directly and save it to the session transcript.
	 */
	setModel(model: Model): void {
		this.agent.state.model = model;
		this.sessionManager.appendModelChange(model.provider, model.id);
	}

	/**
	 * Set thinking level.
	 * Saves the level to the session transcript only if the level actually changes.
	 */
	setThinkingLevel(level: ThinkingLevel): void {
		const previousLevel = this.agent.state.thinkingLevel;
		this.agent.state.thinkingLevel = level;
		if (level !== previousLevel) {
			this.sessionManager.appendThinkingLevelChange(level);
		}
	}

	/**
	 * Check if current model supports thinking/reasoning.
	 */
	supportsThinking(): boolean {
		return this.model.reasoning;
	}

	// =========================================================================
	// Utilities
	// =========================================================================

	/**
	 * Get text content of last assistant message.
	 * @returns Text content, or undefined if no assistant message exists
	 */
	getLastAssistantText(): string | undefined {
		const lastAssistant = this.messages
			.slice()
			.reverse()
			.find((message): message is AssistantMessage => {
				if (message.role !== "assistant") return false;
				// Skip aborted messages with no content
				if (message.stopReason === "aborted" && message.content.length === 0) return false;
				return true;
			});

		if (!lastAssistant) return undefined;

		let text = "";
		for (const content of lastAssistant.content) {
			if (content.type === "text") {
				text += content.text;
			}
		}

		return text.trim() || undefined;
	}
}
