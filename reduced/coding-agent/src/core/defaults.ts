// Reduced from packages/coding-agent/src/core/defaults.ts — kept verbatim
// except that THINKING_LEVEL_OPTIONS is trimmed to the levels the reduced
// agent contract (reduced/agent ThinkingLevel) actually supports.

import type { ThinkingLevel } from "../../../agent/src/index.ts";

export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";
export const THINKING_LEVEL_OPTIONS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
];
