/**
 * SDK entry point: create a fully wired AgentSession in one call.
 *
 * Reduced from packages/coding-agent/src/core/sdk.ts (410 lines). Dropped: auth.json/
 * models.json resolution, settings, resource loading, extensions. Model resolution uses a
 * DEFAULT_MODEL placeholder plus an optional "provider/model" override and an apiKey that
 * rides along to the StreamFn.
 */

import {
	Agent,
	type AgentTool,
	type Model,
	type StreamFn,
	type ThinkingLevel,
} from "../../../agent/src/index.ts";
import { SessionManager } from "./session-manager.ts";
import { createAllTools, type ToolDefinition } from "./tools/index.ts";
import { AgentSession } from "./agent-session.ts";
import { convertToLlm } from "./messages.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";

export { setDefaultStreamFn } from "../../../agent/src/index.ts";

/**
 * Placeholder model used when no model is configured. Reduced copies have no
 * auth.json/models.json: real provider identity comes from the caller's StreamFn.
 */
export const DEFAULT_MODEL: Model = {
	id: "placeholder",
	name: "Placeholder",
	api: "unknown",
	provider: "reduced",
	reasoning: false,
	contextWindow: 128_000,
	maxTokens: 8192,
};

const DEFAULT_TOOL_NAMES: string[] = ["read", "bash", "edit", "write"];

export interface CreateAgentSessionOptions {
	/** Working directory. Default: process.cwd() */
	cwd?: string;
	/** API key forwarded to the StreamFn options on every LLM call. */
	apiKey?: string;
	/** Model as "provider/id". Default: the DEFAULT_MODEL placeholder. */
	model?: string;
	/** Thinking level. Default: DEFAULT_THINKING_LEVEL ("medium"). */
	thinkingLevel?: ThinkingLevel;
	/** Allowlist of tool names. When omitted, the default built-in tools are enabled. */
	tools?: string[];
	/** Denylist of tool names to disable. Applies after `tools` when both are provided. */
	excludeTools?: string[];
	/** When true, start with no tools enabled (unless `tools` says otherwise). */
	noTools?: boolean;
	/**
	 * Replacement tool list. When provided, it REPLACES the builtin createAllToolDefinitions
	 * list before the tools/excludeTools/noTools name filters apply.
	 */
	baseTools?: AgentTool[];
	/** Session manager. Default: SessionManager.create(cwd) */
	sessionManager?: SessionManager;
	/**
	 * Stream function used for every LLM call. When omitted, any attempt to run the agent
	 * throws "No stream function configured".
	 */
	streamFn?: StreamFn;
	/** Custom system prompt replacing the default preamble. */
	systemPrompt?: string;
	/** Text appended to the system prompt. */
	appendSystemPrompt?: string;
}

/** Result from createAgentSession */
export interface CreateAgentSessionResult {
	/** The created session */
	session: AgentSession;
	/** The session manager backing the session's transcript */
	sessionManager: SessionManager;
	/** The resolved model */
	model: Model;
}

/** Resolve a "provider/id" string (or bare id) against the DEFAULT_MODEL placeholder. */
function resolveModel(spec: string | undefined): Model {
	if (!spec) return DEFAULT_MODEL;
	const slashIndex = spec.indexOf("/");
	const provider = slashIndex === -1 ? DEFAULT_MODEL.provider : spec.slice(0, slashIndex);
	const id = slashIndex === -1 ? spec : spec.slice(slashIndex + 1);
	return { ...DEFAULT_MODEL, provider, id, name: id };
}

/**
 * Create an AgentSession with the specified options.
 *
 * @example
 * ```typescript
 * // Minimal - uses defaults; the agent throws until a streamFn is configured
 * const { session } = await createAgentSession({ apiKey: "..." });
 *
 * // With a stream function and an explicit model
 * const { session } = await createAgentSession({
 *   model: "anthropic/claude-opus-4-5",
 *   thinkingLevel: "high",
 *   streamFn: myStreamFn,
 * });
 *
 * // Continue a previous session
 * const { session } = await createAgentSession({
 *   sessionManager: await SessionManager.open(savedPath),
 *   streamFn: myStreamFn,
 * });
 * ```
 */
export async function createAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	const cwd = options.cwd ?? options.sessionManager?.getCwd() ?? process.cwd();
	const sessionManager = options.sessionManager ?? SessionManager.create(cwd);

	const model = resolveModel(options.model);
	const thinkingLevel = options.thinkingLevel ?? DEFAULT_THINKING_LEVEL;

	// Tool loadout: the builtin definitions, or a caller-provided replacement, filtered by name.
	const allTools: ToolDefinition[] = options.baseTools ?? (Object.values(createAllTools(cwd)) as ToolDefinition[]);
	const excludedToolNames = new Set(options.excludeTools ?? []);
	const allowedToolNames = options.tools ? new Set(options.tools) : undefined;
	const toolDefinitions = allTools.filter(
		(tool) => !excludedToolNames.has(tool.name) && (!allowedToolNames || allowedToolNames.has(tool.name)),
	);

	// Check if session has existing data to restore
	const existingSession = sessionManager.buildSessionContext();
	const hasExistingSession = existingSession.messages.length > 0;

	const agent = new Agent({
		initialState: {
			systemPrompt: "",
			model,
			thinkingLevel,
			tools: [],
		},
		convertToLlm,
		streamFn:
			options.streamFn ??
			(() => {
				throw new Error("No stream function configured. Pass a streamFn option or call setDefaultStreamFn().");
			}),
		getApiKey: options.apiKey !== undefined ? () => options.apiKey : undefined,
	});

	// Restore messages if session has existing data
	if (hasExistingSession) {
		agent.state.messages = existingSession.messages;
	} else {
		// Save initial model and thinking level for new sessions so they can be restored on resume
		sessionManager.appendModelChange(model.provider, model.id);
		sessionManager.appendThinkingLevelChange(thinkingLevel);
	}

	const initialActiveToolNames = (options.tools ?? (options.noTools ? [] : DEFAULT_TOOL_NAMES)).filter(
		(name) => !excludedToolNames.has(name),
	);

	const session = new AgentSession({
		agent,
		sessionManager,
		tools: toolDefinitions,
		initialActiveToolNames,
		model,
		thinkingLevel,
		systemPrompt: options.systemPrompt,
		appendSystemPrompt: options.appendSystemPrompt,
	});

	return { session, sessionManager, model };
}
