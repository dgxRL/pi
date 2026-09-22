/**
 * System prompt construction and project context loading
 *
 * Reduced from packages/coding-agent/src/core/system-prompt.ts (216 lines). The skills
 * section and the extension-mutation surface (custom `sections` input) are dropped; the
 * sections-diff protocol (diffSystemPromptSections) is kept verbatim — it is load-bearing
 * for transcript replay.
 */

import type { SystemMessage } from "../../../agent/src/index.ts";
import { getSystemMessageText } from "./messages.ts";

/** One entry of the reduced tool loadout: name plus its prompt metadata. */
export interface ToolPromptEntry {
	name: string;
	/** Optional one-line snippet rendered into the tools section. */
	promptSnippet?: string;
	/** Guideline bullets contributed by the tool, rendered into the rules section. */
	promptGuidelines?: string[];
}

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces the default preamble). */
	customPrompt?: string;
	/** Exact full prompt replacement; lives in `content` with no sections. */
	forceSystemPrompt?: string;
	/** Tools to include in the prompt, with their prompt metadata. */
	tools: ToolPromptEntry[];
	/** Additional guideline bullets appended to the default system prompt rules. */
	promptGuidelines?: string[];
	/** Text appended after the built-in sections. */
	appendSystemPrompt?: string;
	/** Working directory. */
	cwd?: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
}

export type NormalizedBuildSystemPromptOptions = {
	customPrompt: string | undefined;
	forceSystemPrompt: string | undefined;
	tools: ToolPromptEntry[];
	promptGuidelines: string[];
	appendSystemPrompt: string;
	cwd: string;
	contextFiles: Array<{ path: string; content: string }>;
};

/**
 * Ordered system prompt sections, keyed by name. `preamble` is untagged text; every other
 * section is wrapped in a tag of the same name so the model can match later updates to it.
 * These become `SystemMessage.sections` in the transcript.
 */
export type SystemPromptSections = Record<string, string>;

/** Normalize prompt input into the mutable, collection-complete shape used by the builders. */
export function normalizeBuildSystemPromptOptions(input: BuildSystemPromptOptions): NormalizedBuildSystemPromptOptions {
	return {
		customPrompt: input.customPrompt,
		forceSystemPrompt: input.forceSystemPrompt,
		tools: input.tools.map((tool) => ({ ...tool })),
		promptGuidelines: [...(input.promptGuidelines ?? [])],
		appendSystemPrompt: input.appendSystemPrompt ?? "",
		cwd: input.cwd ?? "",
		contextFiles: (input.contextFiles ?? []).map((file) => ({ ...file })),
	};
}

function renderProjectContext(contextFiles: Array<{ path: string; content: string }>): string {
	return [
		"Project-specific instructions and guidelines:",
		...contextFiles.map(
			({ path, content }) => `<project_instructions path="${path}">\n${content}\n</project_instructions>`,
		),
	].join("\n\n");
}

function buildRules(
	selectedTools: string[],
	toolGuidelines: Record<string, string[]>,
	promptGuidelines: string[],
): string {
	const rules: string[] = [];
	const seen = new Set<string>();
	const addRule = (rule: string): void => {
		const normalized = rule.trim();
		if (!normalized || seen.has(normalized)) return;
		seen.add(normalized);
		rules.push(normalized);
	};

	if (selectedTools.includes("bash") && !selectedTools.includes("grep") && !selectedTools.includes("find") && !selectedTools.includes("ls")) {
		addRule("Use bash for file operations like ls, rg, find");
	}

	for (const name of selectedTools) {
		for (const rule of toolGuidelines[name] ?? []) addRule(rule);
	}
	for (const rule of promptGuidelines) addRule(rule);
	addRule("Be concise in your responses");
	addRule("Show file paths clearly when working with files");
	return rules.map((rule) => `- ${rule}`).join("\n");
}

/** Build the ordered, independently replaceable sections of the structured system prompt. */
export function buildSystemPromptSections(input: BuildSystemPromptOptions): SystemPromptSections {
	const options = normalizeBuildSystemPromptOptions(input);
	const { customPrompt, appendSystemPrompt, cwd, contextFiles } = options;

	const promptSections: Record<string, string> = {};
	if (customPrompt) {
		promptSections.preamble = customPrompt;
	} else {
		promptSections.preamble =
			"You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";
		const selectedTools = options.tools.map((tool) => tool.name);
		const visibleTools = options.tools.filter((tool) => !!tool.promptSnippet);
		const tools =
			visibleTools.length > 0 ? visibleTools.map((tool) => `- ${tool.name}: ${tool.promptSnippet}`).join("\n") : "(none)";
		promptSections.tools = `${tools}\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.`;
		const toolGuidelines: Record<string, string[]> = Object.fromEntries(
			options.tools.map((tool) => [tool.name, tool.promptGuidelines ?? []]),
		);
		promptSections.rules = buildRules(selectedTools, toolGuidelines, options.promptGuidelines);
		promptSections.docs = `pi documentation (read only when the user asks about pi itself, its SDK, or its TUI):
- Main documentation: README.md in the pi repository
- Additional docs: docs/ in the pi repository
- Examples: examples/ in the pi repository`;
	}

	if (appendSystemPrompt) promptSections.addendum = appendSystemPrompt;
	if (contextFiles.length > 0) promptSections.project_context = renderProjectContext(contextFiles);
	if (cwd) promptSections.cwd = cwd.replace(/\\/g, "/");

	const sections: SystemPromptSections = { preamble: promptSections.preamble };
	for (const [name, content] of Object.entries(promptSections)) {
		if (name !== "preamble") sections[name] = `<${name}>\n${content}\n</${name}>`;
	}
	return sections;
}

/**
 * The complete prompt state for `input`. A forced prompt is opaque and lives in `content`
 * with no sections; otherwise `content` is empty and the structured sections carry the prompt.
 */
export function buildSystemPromptState(input: BuildSystemPromptOptions): {
	content: string;
	sections?: SystemPromptSections;
} {
	if (input.forceSystemPrompt !== undefined) return { content: input.forceSystemPrompt };
	return { content: "", sections: buildSystemPromptSections(input) };
}

/** Build the system prompt text, rendered exactly as the transcript's system message replays it. */
export function buildSystemPrompt(input: BuildSystemPromptOptions): string {
	return getSystemMessageText({ role: "system", ...buildSystemPromptState(input), timestamp: 0 } satisfies SystemMessage);
}

/**
 * Diff the sections the model currently has (replayed from the transcript, so never null)
 * against the desired ones. Returns a `SystemMessage.sections` patch, or undefined when
 * nothing changed.
 */
export function diffSystemPromptSections(
	previous: Record<string, string | null>,
	current: SystemPromptSections,
): Record<string, string | null> | undefined {
	const patch: Record<string, string | null> = {};
	for (const [name, text] of Object.entries(current)) {
		if (previous[name] !== text) patch[name] = text;
	}
	for (const name of Object.keys(previous)) {
		if (current[name] === undefined) patch[name] = null;
	}
	return Object.keys(patch).length > 0 ? patch : undefined;
}
