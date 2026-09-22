// Reduced from packages/coding-agent/src/core/tools/render-utils.ts + renderers/*.
// There is no pi-tui layer here: one generic description of a call and its text output
// stands in for the per-tool renderers.

import type { TextContent } from "../../../../agent/src/index.ts";

/** One-line summary of a tool call: name plus a compact args summary. */
export function renderCall(name: string, args: Record<string, unknown> | undefined): string {
	if (!args) return name;
	const parts = Object.entries(args).map(([key, value]) => {
		const text = typeof value === "string" ? value : JSON.stringify(value);
		const preview = text !== undefined && text.length > 80 ? `${text.slice(0, 80)}…` : text;
		return `${key}: ${preview}`;
	});
	return `${name}(${parts.join(", ")})`;
}

/** Plain-text rendering of a tool result's text content. */
export function renderResult(content: TextContent[]): string {
	return content
		.map((block) => block.text)
		.filter((text) => text.length > 0)
		.join("\n");
}
